import { expect, test } from '@playwright/test';
import { EnvelopeKind } from '../../../src/router/shared/constants';
import { IDS, T0, TRAFFIC } from '../../__tests__/traffic';
import type { ActivityRecord, ICallRecord, IEnvelopeRecord } from '../../messages';
import { createCallBook, type ICallBook, NOTIFICATIONS_KEPT } from '../calls';

// helpers

const bookOf = (records: readonly ActivityRecord[], options?: { kept?: number }): ICallBook => {
  const book = createCallBook(options);

  for (const record of records) {
    book.take(record);
  }

  return book;
};

const callOf = (
  book: ICallBook,
  { callId, name }: { callId: number | undefined; name?: string | undefined }
) => {
  return book.calls.find((call) => {
    return call.callId === callId && (name === undefined || call.procedureName === name);
  });
};

const request = (callId: number, at: number): IEnvelopeRecord => {
  return {
    at,
    connectionHandle: 'server',
    direction: 'tx',
    header: { callId, kind: EnvelopeKind.REQUEST, procedureId: 3, serviceId: 1 },
    kind: 'envelope',
    source: 1,
  };
};

const made = (fields: Partial<ICallRecord>): ICallRecord => {
  return {
    callId: 21,
    connectionHandle: 'server',
    direction: 'tx',
    kind: 'call',
    procedureId: 3,
    procedureName: 'read',
    serviceId: 1,
    serviceRevision: 1,
    source: 1,
    startedAt: T0,
    type: 'request',
    ...fields,
  };
};

// definition

test.describe('createCallBook', () => {
  test('makes one call of its steps and its envelopes, by its call id on its connection, whichever comes first', () => {
    const book = bookOf(TRAFFIC);
    const whoami = callOf(book, { callId: IDS.whoami });

    expect(book.calls).toHaveLength(10);
    expect(whoami?.opening?.direction).toBe('tx');
    expect(whoami?.answer?.direction).toBe('rx');
    expect(whoami?.request?.header['kind']).toBe(EnvelopeKind.REQUEST);
    expect(whoami?.answerEnvelope?.header['kind']).toBe(EnvelopeKind.RESULT);
    expect(callOf(book, { callId: IDS.download })?.envelopes).toHaveLength(5);
    expect(callOf(book, { callId: IDS.slow })?.cancel?.header['kind']).toBe(EnvelopeKind.CANCEL);
  });

  test('reads a command the server made the other way round: its `rx` step opens it, its `tx` step answers', () => {
    const command = callOf(bookOf(TRAFFIC), { callId: IDS.command });

    expect(command).toMatchObject({ isIncoming: true, procedureName: 'clock' });
    expect(command?.opening?.direction).toBe('rx');
    expect(command?.answer?.direction).toBe('tx');
  });

  test('meets a notification’s step with the envelope heard before it, and a subscription’s end by its failure', () => {
    const counter = callOf(bookOf(TRAFFIC), { callId: IDS.counter });

    expect(
      counter?.notifications.map(({ step }) => {
        return step?.rx;
      })
    ).toEqual(['{"value": 42}', '{"value": 47}']);
    expect(counter?.endEnvelope?.header['kind']).toBe(EnvelopeKind.FAILURE);
  });

  test('meets the answer of a call refused before its id was drawn by its procedure and its start', () => {
    const read = callOf(bookOf(TRAFFIC), { callId: undefined, name: 'read' });

    expect(read?.opening?.direction).toBe('tx');
    expect(read?.answer?.error?.name).toBe('FailureError');
  });

  test('starts a new call when an id its router drew again opens another, never joining the ended one', () => {
    const book = bookOf([
      request(21, T0),
      made({}),
      made({ direction: 'rx', duration: 1 }),
      request(21, T0 + 10),
      made({ startedAt: T0 + 10 }),
    ]);

    expect(book.calls).toHaveLength(2);
    expect(book.calls[1]?.answer).toBeUndefined();
    expect(book.calls[1]?.request?.at).toBe(T0 + 10);
  });

  test('opens a call from its step alone, for one whose envelope never went', () => {
    const book = bookOf([
      made({}),
      made({ direction: 'rx', duration: 0, error: { message: 'too large', name: 'FailureError' } }),
    ]);

    expect(book.calls).toHaveLength(1);
    expect(book.calls[0]?.request).toBeUndefined();
  });

  test('keeps a subscription’s last notifications and counts the others, and its last calls past what it keeps', () => {
    const notifications = Array.from(
      { length: NOTIFICATIONS_KEPT + 3 },
      (_, index): IEnvelopeRecord => {
        return {
          at: T0 + index,
          connectionHandle: 'server',
          direction: 'rx',
          header: { callId: 21, kind: EnvelopeKind.NOTIFICATION },
          kind: 'envelope',
          source: 1,
        };
      }
    );
    const subscription = bookOf([request(21, T0), ...notifications]).calls[0];

    expect(subscription?.notifications).toHaveLength(NOTIFICATIONS_KEPT);
    expect(subscription?.notificationsLetGo).toBe(3);

    const book = bookOf(
      [1, 3, 5].map((callId) => {
        return request(callId, T0);
      }),
      { kept: 2 }
    );

    expect(
      book.calls.map(({ callId }) => {
        return callId;
      })
    ).toEqual([3, 5]);
    expect(book.callsLetGo).toBe(1);
  });

  test('gives back the records it holds in the order it took them, and names a procedure as a step told it', () => {
    const book = bookOf(TRAFFIC);

    expect(book.recordsOf()).toEqual(TRAFFIC);
    expect(book.nameOf({ procedureId: 20, serviceId: 1, source: 1 })).toBe('clock');
    expect(book.nameOf({ procedureId: 99, serviceId: 1 })).toBeUndefined();
  });

  test('marks a gap among the calls, in its place', () => {
    const book = bookOf(TRAFFIC.slice(0, 4));

    book.mark({ at: T0, count: 12, kind: 'gap' });
    book.take(request(31, T0 + 1));

    expect(book.markers).toEqual([{ at: T0, count: 12, key: 2, kind: 'gap' }]);
    expect(book.calls.at(-1)?.key).toBe(3);
  });
});
