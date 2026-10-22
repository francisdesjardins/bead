import { expect, test } from '@playwright/test';
import { createTestClock } from '../../transport/shared/__tests__/fixtures';
import { ProgrammerError } from '../../transport/shared/errors';
import {
  createEventStream,
  eventDataOf,
  eventOf,
  HEARTBEAT,
  HEARTBEAT_COMMENT,
  type IEventSink,
} from '../events';

// helpers

/** A sink the test reads: what was written, and each write's taking, which the test settles. */
const createSink = () => {
  const written: string[] = [];
  const pending: (() => void)[] = [];
  const told: string[] = [];
  const sink: IEventSink = {
    answer: ({ body, status }) => {
      told.push(`answer ${String(status)} ${body}`);
    },
    end: () => {
      told.push('end');
    },
    open: () => {
      told.push('open');
    },
    write: (text) => {
      written.push(text);

      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
  };

  return { pending, sink, told, written };
};

/** Whether `promise` settled within a turn. */
const isSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;

  void promise.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);

  return settled;
};

// tests

test('writes the result, then each notification as a message, then the failure that ends them, each event an id', async () => {
  const clock = createTestClock();
  const { sink, told, written } = createSink();
  const stream = createEventStream(sink, { clock, heartbeat: HEARTBEAT });

  // * one before the result is held, then written after it, in its order
  void stream.notification('{"remaining":2}');
  expect(written).toEqual([]);
  stream.result('{"ticks":3}');
  void stream.notification('{}');
  await clock.tickAsync(HEARTBEAT);
  stream.failure({ body: '{"status":429}', fields: {}, status: 429 });

  expect(told).toEqual(['open', 'end']);
  expect(written.join('')).toBe(
    'event: result\nid: 1\ndata: {"ticks":3}\n\nid: 2\ndata: {"remaining":2}\n\nid: 3\ndata: {}\n\n:\nevent: failure\nid: 4\ndata: {"status":429}\n\n'
  );
  expect(stream.isEnded).toBe(true);
  expect(eventOf({ data: '1', id: 9 })).toBe('id: 9\ndata: 1\n\n');
  expect(eventDataOf({ encoding: 'text', text: 'h\n\r' })).toBe('"h\\n\\r"');
  expect(eventDataOf({ bytes: Uint8Array.of(0, 0xff, 0xfe), encoding: 'raw' })).toBe('"AP/+"');

  // a failure before the result is a problem, the notifications it held dropped
  const early = createSink();
  const refused = createEventStream(early.sink, { clock, heartbeat: HEARTBEAT });
  const dropped = refused.notification('{}');

  refused.failure({ body: '{"status":401}', fields: {}, status: 401 });
  expect(early.told).toEqual(['answer 401 {"status":401}']);
  expect(early.written).toEqual([]);
  expect(await isSettled(dropped)).toBe(true);

  // a quiet stream's comment, and none once it closed
  const quiet = createSink();
  const open = createEventStream(quiet.sink, { clock, heartbeat: HEARTBEAT });

  open.result('{}');
  await clock.tickAsync(HEARTBEAT);
  expect(quiet.written.at(-1)).toBe(HEARTBEAT_COMMENT);
  open.close();
  await clock.tickAsync(HEARTBEAT * 2);
  expect(quiet.written.length).toBe(2);
});

test('credits each notification once the event before it was taken', async () => {
  const clock = createTestClock();
  const { pending, sink } = createSink();
  const stream = createEventStream(sink, { clock, heartbeat: Number.POSITIVE_INFINITY });
  const held = stream.notification('{"remaining":2}');

  stream.result('{}');

  // the result's write and the held notification's, neither taken yet
  expect(pending.length).toBe(2);
  expect(await isSettled(held)).toBe(false);
  pending[0]?.();
  expect(await isSettled(held)).toBe(false);
  pending[1]?.();
  expect(await isSettled(held)).toBe(true);

  const next = stream.notification('{"remaining":1}');

  expect(await isSettled(next)).toBe(false);
  pending[2]?.();
  expect(await isSettled(next)).toBe(true);

  // one after the end is dropped, and settles at once
  stream.close();
  expect(await isSettled(stream.notification('{}'))).toBe(true);
  expect(pending.length).toBe(3);
});

test('refuses a second result, and a result or a notification once its failure ended it, as its caller’s bug', async () => {
  const clock = createTestClock();
  const { sink, told, written } = createSink();
  const stream = createEventStream(sink, { clock, heartbeat: Number.POSITIVE_INFINITY });

  stream.result('{"ticks":1}');
  expect(() => {
    stream.result('{"ticks":2}');
  }).toThrow(new ProgrammerError('a stream has one result, before its end'));
  expect(told).toEqual(['open']);
  expect(written).toEqual(['event: result\nid: 1\ndata: {"ticks":1}\n\n']);

  // * its failure ends it: a result or a notification after it is its caller's bug, a failure nothing
  stream.failure({ body: '{"code":2}', fields: {}, status: 429 });
  stream.failure({ body: '{"code":3}', fields: {}, status: 429 });
  expect(() => {
    stream.result('{}');
  }).toThrow(ProgrammerError);
  await expect(stream.notification('{}')).rejects.toThrow(
    new ProgrammerError('a notification after the stream ended')
  );
  expect(told).toEqual(['open', 'end']);
  expect(written.length).toBe(2);

  // closed, its client gone: what comes after is dropped, written and told nothing
  const closed = createSink();
  const early = createEventStream(closed.sink, { clock, heartbeat: Number.POSITIVE_INFINITY });

  early.close();
  early.result('{}');
  early.failure({ body: '{"status":500}', fields: {}, status: 500 });
  expect(await isSettled(early.notification('{}'))).toBe(true);
  expect(closed.told).toEqual([]);
  expect(closed.written).toEqual([]);
});

test('settles a held notification whose event its response could not take, its credit moot', async () => {
  const clock = createTestClock();
  let writes = 0;
  const stream = createEventStream(
    {
      answer: () => {},
      end: () => {},
      open: () => {},
      // * the result taken, the notification after it refused, as a socket that closed
      write: () => {
        writes += 1;

        return writes === 1 ? Promise.resolve() : Promise.reject(new Error('the socket closed'));
      },
    },
    { clock, heartbeat: Number.POSITIVE_INFINITY }
  );
  const held = stream.notification('{"remaining":1}');

  stream.result('{}');
  await expect(held).resolves.toBeUndefined();
  await expect(stream.notification('{"remaining":0}')).resolves.toBeUndefined();
});
