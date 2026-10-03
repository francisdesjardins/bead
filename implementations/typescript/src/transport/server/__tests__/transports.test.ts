// ── Transports ────────────────────────────────────────────────────────────────

// Bead's transports' cases, `spec/transports.json`, played against Bead's TypeScript server of the
// interop service over HTTP and WebSocket: a peer of the test's own writes octets, then frames, on a
// socket per exchange, and reads what the server sends and reports. The C# server plays the same
// file.

// dependencies

import { readFileSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { type InteropServer, offerInterop } from '../../../../interop/offer';
import {
  expectedOf,
  hexadecimalOf,
  type IExpected,
} from '../../../router/server/__tests__/expected-envelope';
import { FailureError } from '../../../router/server/router-server';
import { fromHexadecimal } from '../../../router/shared/__tests__/vectors';
import type { RouterLimitsOptions } from '../../../router/shared/types';
import { wholeEnvelopeLimitsOf } from '../../../router/shared/whole-envelope-limits';
import { CONNECTION_INACTIVITY_TIMEOUT } from '../../../server/http-server';
import { createServer } from '../../../server/server';
import { createWSServer } from '../../../server/ws-server';
import { createTestClock, duesOn, type TestClock } from '../../shared/__tests__/fixtures';
import { TRANSPORT_WS } from '../../shared/constants';
import {
  BODY_BYTES_BUDGET,
  createHTTPTransportServer,
  EXCHANGE_TIMEOUT,
  INACTIVITY_TIMEOUT,
  MAXIMUM_BODY_BYTES,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_CONNECTIONS_PER_ADDRESS,
  MAXIMUM_OUTBOX_BYTES,
  MAXIMUM_WAIT,
  MAXIMUM_WAITING_EXCHANGES,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../http-transport-server';
import { generateHandle } from '../transport-server';
import type { ITransportServer, TransportServerConnectionHandle } from '../types';
import { HEARTBEAT } from '../ws-transport-server';
import { createFakeWebSocketServer } from './fake-websocket-server';
import {
  closeFrameOf,
  createResponseReader,
  OPCODES,
  openExchange,
  type Heard,
  type IExchange,
  type IFrame,
  type IResponse,
  type IResponseHead,
} from './http-peer';

// interfaces

/** A value drawn at random, which a field is checked against, and kept under `capture` when named. */
interface IShaped {
  capture?: string;
  shape: keyof typeof SHAPES;
}

/** A response a case expects: its status, its fields, and its body, envelope or batch. */
interface IExpectation {
  batch?: (IExpected | string)[];
  body?: string;
  envelope?: IExpected | string;
  fields?: Record<string, IShaped | string | null>;
  /** The exchange may be lost instead: its socket ends, reset or not, before any status line. */
  orLost?: true;
  status: number;
}

/** What a case expects the server to send next on a WebSocket. */
interface IHeardExpectation {
  binary?: string;
  close?: number;
  end?: true;
  envelope?: IExpected | string;
  ping?: true;
}

/** A request of HTTP/1.1, an opening handshake among them. */
interface IRequest {
  body?: string;
  head: string;
}

/** What the peer writes on a WebSocket. */
interface IMessage {
  binary?: string;
  close?: number;
  frames?: { fin: boolean; opcode: number; payload: string }[];
  text?: string;
}

/** One step of a case: what the test does, or what the server does next, on the exchange it names. */
interface IStep {
  advance?: number;
  close?: true;
  expect?: IExpectation | IHeardExpectation;
  on?: string;
  report?: number | 'exception';
  send?: IMessage | IRequest;
  stop?: true;
  until?: { gauge: string; is: number } | { timer: number };
  wall?: number;
  within?: number;
}

interface ICase {
  answersPings?: false;
  differs?: { language: string; row: string }[];
  limits?: RouterLimitsOptions;
  name: string;
  options?: Omit<IHTTPTransportServerOptions, 'createServer'> & {
    heartbeat?: number;
    maximumMessageBytes?: number;
  };
  realTime?: true;
  steps: IStep[];
  transport: string;
}

/** A response cut across reads, as every side's reader reads it. */
interface IResponseCase {
  body: string;
  fields: Record<string, string>;
  name: string;
  pieces: string[];
  status: number;
}

/** What the server reported to its application, and the connection it came with. */
interface IReport {
  code: number | 'exception';
  connectionHandle: TransportServerConnectionHandle;
}

// types

/** A server of the interop service, whichever its transport, as a case plays it. */
type ServerUnderTest = AsyncDisposable &
  InteropServer & { transport: Pick<ITransportServer, 'gauges' | 'start'> };

// constants

const TRANSPORTS = JSON.parse(
  readFileSync(new URL('../../../../../../spec/transports.json', import.meta.url), 'utf8')
) as {
  cases: ICase[];
  defaults: Record<string, number>;
  responses: IResponseCase[];
  wallClock: string;
};

const HOST = '127.0.0.1';

// the transports this harness plays a case over
const PLAYED_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'websocket']);

// how long a step waits on the real clock for its bytes, a gauge, a timer or a report, unless it says
const PATIENCE = 3_000;
const POLL = 10;

/** The shapes of what a server draws, in ASCII classes, as the schema defines them. */
const SHAPES = Object.freeze({
  'delay-seconds': /^[0-9]+$/u,
  'http-date':
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u,
  token: /^[A-Za-z0-9_-]{21}[AQgw]$/u,
});

const encoder = new TextEncoder();

// helpers

/** Hexadecimal as `hexadecimalOf` writes it, whatever spaces and bars it came with. */
const canonicalOf = (text: string): string => {
  return hexadecimalOf(fromHexadecimal(text));
};

/** A body's one envelope, as a case expects it, or its bytes when they are none. */
const envelopeOf = (bytes: Uint8Array): IExpected | string => {
  try {
    return expectedOf(bytes) ?? hexadecimalOf(bytes);
  } catch {
    return hexadecimalOf(bytes);
  }
};

/** A batch's envelopes, each after its length on 4 bytes, big-endian. */
const batchOf = (bytes: Uint8Array): (IExpected | string)[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const envelopes: (IExpected | string)[] = [];
  let at = 0;

  while (at + 4 <= bytes.length) {
    const length = view.getUint32(at);

    envelopes.push(envelopeOf(bytes.subarray(at + 4, at + 4 + length)));
    at += 4 + length;
  }

  return at === bytes.length ? envelopes : [...envelopes, hexadecimalOf(bytes.subarray(at))];
};

/** The request `send` writes, its head's `{name}` each replaced by the value it names. */
const requestOf = (
  { body = '', head }: IRequest,
  values: ReadonlyMap<string, string>
): Uint8Array => {
  const filled = head.replaceAll(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = values.get(name);

    if (value === undefined) {
      throw new Error(`nothing captured under ${name}`);
    }

    return value;
  });

  return Buffer.concat([Buffer.from(filled, 'latin1'), fromHexadecimal(body)]);
};

/** The frames a message is written in: one, but those a case gives itself. */
const framesOf = ({ binary, close, frames = [], text }: IMessage): IFrame[] => {
  if (binary !== undefined) {
    return [{ fin: true, opcode: OPCODES.BINARY, payload: fromHexadecimal(binary) }];
  }

  if (text !== undefined) {
    return [{ fin: true, opcode: OPCODES.TEXT, payload: encoder.encode(text) }];
  }

  if (close !== undefined) {
    return [closeFrameOf(close)];
  }

  return frames.map(({ fin, opcode, payload }) => {
    return { fin, opcode, payload: fromHexadecimal(payload) };
  });
};

/**
 * What a response shows of what `expectation` names, in its terms: a field of the shape expected
 * shows as that shape, so a comparison tells a value drawn from a value wrong.
 */
const seenOf = (
  response: IResponseHead & Partial<Pick<IResponse, 'body'>>,
  expectation: IExpectation
): IExpectation => {
  const body = response.body ?? new Uint8Array();
  const fields = Object.entries(expectation.fields ?? {}).map(
    ([name, expected]): [string, IShaped | string | null] => {
      const value = response.fields.get(name.toLowerCase()) ?? null;
      const isShaped =
        value !== null &&
        typeof expected === 'object' &&
        expected !== null &&
        SHAPES[expected.shape].test(value);

      return [name, isShaped ? expected : value];
    }
  );

  return {
    status: response.status,
    ...(expectation.fields === undefined ? {} : { fields: Object.fromEntries(fields) }),
    ...(expectation.body === undefined ? {} : { body: hexadecimalOf(body) }),
    ...(expectation.envelope === undefined ? {} : { envelope: envelopeOf(body) }),
    ...(expectation.batch === undefined ? {} : { batch: batchOf(body) }),
  };
};

/** What the server sent on a WebSocket, in the terms `expectation` names it by. */
const heardOf = (
  heard: Heard,
  expectation: IHeardExpectation
): IHeardExpectation | { text: string } => {
  if ('binary' in heard) {
    return expectation.envelope === undefined
      ? { binary: hexadecimalOf(heard.binary) }
      : { envelope: envelopeOf(heard.binary) };
  }

  return 'ping' in heard ? { ping: true } : heard;
};

/** Settles as `promise` does, or rejects once `milliseconds` are over. */
const within = async <T>(
  promise: Promise<T>,
  { milliseconds, what }: { milliseconds: number; what: string }
): Promise<T> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`${what} did not come within ${String(milliseconds)} ms`));
  }, milliseconds);

  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** Polls `isDone` on the real clock until it holds or the patience is over; the caller checks. */
const pollWithinPatience = async (isDone: () => boolean): Promise<void> => {
  const deadline = Date.now() + PATIENCE;

  while (!isDone() && Date.now() < deadline) {
    await sleep(POLL);
  }
};

/**
 * A server of the interop service as each side's interop server builds one for its transport, the
 * case's options on the transport and its limits on the router, every layer on the transport's
 * `clock`. Over HTTP, its transport is given them as they are, `maximumBodyBytes` among them, which
 * `createHTTPServer` sets itself.
 */
const serverOf = (
  { limits, options = {}, transport }: ICase,
  clock: TestClock
): ServerUnderTest => {
  const { heartbeat, maximumMessageBytes, ...bounds } = options;

  if (transport === 'websocket') {
    return createWSServer<string>({
      limits,
      transport: { clock, heartbeat, maxPayload: maximumMessageBytes, WebSocketServer },
    });
  }

  return createServer<HTTPTransportServer, string>(
    {
      transport: createHTTPTransportServer({
        ...bounds,
        clock,
        createServer: (listener) => {
          return createNodeServer(listener);
        },
      }),
    },
    {
      connectionInactivityTimeout: CONNECTION_INACTIVITY_TIMEOUT,
      limits: wholeEnvelopeLimitsOf(limits),
    }
  );
};

/** Offers the interop service on `server`, starts it on a free port, and records what it reports. */
const serve = async (server: ServerUnderTest) => {
  const reports: IReport[] = [];

  server.router.on('error', (error, connectionHandle) => {
    reports.push({
      code: error instanceof FailureError ? error.code : 'exception',
      connectionHandle,
    });
  });
  offerInterop(server);

  const { port } = await server.transport.start({ address: HOST, findOpenPort: true });

  return { port, reports };
};

/** Checks the response of `exchange` against `expectation`, and keeps what its fields capture. */
const expectResponse = async (
  { at, exchange, milliseconds }: { at: string; exchange: IExchange; milliseconds: number },
  { expectation, values }: { expectation: IExpectation; values: Map<string, string> }
): Promise<void> => {
  const { orLost, ...expected } = expectation;
  const hasBody =
    expected.body !== undefined || expected.envelope !== undefined || expected.batch !== undefined;

  // a cut that overtook the head, where the case allows it; a head that did not come in time, or
  // came unreadable, is no loss
  if (orLost === true) {
    const isLost = await within(exchange.reader.head, {
      milliseconds,
      what: `${at}: the response's head`,
    }).then(
      () => {
        return false;
      },
      (reason: unknown) => {
        if (exchange.reader.isLost) {
          return true;
        }

        throw reason;
      }
    );

    if (isLost) {
      return;
    }
  }

  const response = hasBody
    ? await within(exchange.reader.response, { milliseconds, what: `${at}: the response` })
    : await within(exchange.reader.head, { milliseconds, what: `${at}: the response's head` });

  expect(seenOf(response, expected), at).toEqual({
    ...expected,
    ...(expected.body === undefined ? {} : { body: canonicalOf(expected.body) }),
  });

  for (const [name, expected] of Object.entries(expectation.fields ?? {})) {
    const value = response.fields.get(name.toLowerCase());

    if (typeof expected === 'object' && expected?.capture !== undefined && value !== undefined) {
      values.set(expected.capture, value);
    }
  }
};

/** Checks the next thing the server sends on the WebSocket of `exchange` against `expectation`. */
const expectHeard = async (
  { at, exchange, milliseconds }: { at: string; exchange: IExchange; milliseconds: number },
  expectation: IHeardExpectation
): Promise<void> => {
  const heard = await exchange.next(milliseconds);

  expect(
    heard === undefined ? `nothing within ${String(milliseconds)} ms` : heardOf(heard, expectation),
    at
  ).toEqual({
    ...expectation,
    ...(expectation.binary === undefined ? {} : { binary: canonicalOf(expectation.binary) }),
  });
};

// a case a row of the support matrix excuses this side from, which it does not play
const isExcused = ({ differs }: ICase): boolean => {
  return (
    differs?.some(({ language }) => {
      return language === 'TypeScript';
    }) === true
  );
};

// definition

test.describe('the transports', () => {
  // played once, as the C# side plays them: a retry would hide what fails there; a step waits up
  // to its patience on the real clock, several of them past the unit test's timeout
  test.describe.configure({ retries: 0, timeout: 30_000 });

  const played: string[] = [];

  test('the defaults are those of sections 15.3 and 15.12', async () => {
    const fake = createFakeWebSocketServer();
    const wsServer = createWSServer({ transport: { WebSocketServer: fake.FakeWebSocketServer } });
    const starting = wsServer.transport.start({ port: 4_321 });

    fake.instances[0]?.emit('listening');
    await starting;

    const built = fake.instances[0]?.options as { maxPayload?: number } | undefined;

    await wsServer[Symbol.asyncDispose]();

    expect({
      bodyBytesBudget: BODY_BYTES_BUDGET,
      exchangeTimeout: EXCHANGE_TIMEOUT,
      heartbeat: HEARTBEAT,
      inactivityTimeout: INACTIVITY_TIMEOUT,
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
      maximumConnections: MAXIMUM_CONNECTIONS,
      maximumConnectionsPerAddress: MAXIMUM_CONNECTIONS_PER_ADDRESS,
      maximumMessageBytes: built?.maxPayload,
      maximumOutboxBytes: MAXIMUM_OUTBOX_BYTES,
      maximumWait: MAXIMUM_WAIT,
      maximumWaitingExchanges: MAXIMUM_WAITING_EXCHANGES,
    }).toEqual(TRANSPORTS.defaults);
  });

  for (const { body, fields, name, pieces, status } of TRANSPORTS.responses) {
    test(`the reader reads ${name}`, async () => {
      const reader = createResponseReader();

      for (const piece of pieces) {
        reader.feed(fromHexadecimal(piece));
      }

      const response = await within(reader.response, {
        milliseconds: PATIENCE,
        what: 'the response',
      });

      expect({
        body: hexadecimalOf(response.body),
        fields: Object.fromEntries(
          Object.keys(fields).map((field) => {
            return [field, response.fields.get(field) ?? null];
          })
        ),
        status: response.status,
      }).toEqual({ body: canonicalOf(body), fields, status });
    });
  }

  for (const testCase of TRANSPORTS.cases) {
    const { answersPings, name, steps, transport } = testCase;

    if (!PLAYED_TRANSPORTS.has(transport) || isExcused(testCase)) {
      continue;
    }

    played.push(name);

    test(name, async () => {
      // the clock every layer runs on: only a step that moves time moves it; a platform's own timers,
      // a ping's among them, stay on the real clock
      const clock = createTestClock(Date.parse(TRANSPORTS.wallClock));
      const server = serverOf(testCase, clock);
      const { port, reports } = await serve(server);
      const exchanges = new Map<string, IExchange>();
      const values = new Map([['host', `${HOST}:${String(port)}`]]);
      let isStopped = false;
      const exchangeOf = (on: string | undefined, at: string): IExchange => {
        const exchange = exchanges.get(on ?? '');

        if (exchange === undefined) {
          throw new Error(`${at}: no exchange ${String(on)} was sent`);
        }

        return exchange;
      };
      // the handle a WebSocket's connection has on the server: the address and port it came from
      const handleOf = (on: string, at: string): TransportServerConnectionHandle => {
        const { localPort } = exchangeOf(on, at);

        if (transport !== 'websocket' || localPort === undefined) {
          throw new Error(`${at}: the exchange ${on} names no connection of its own`);
        }

        return generateHandle({ ip: HOST, port: localPort, type: TRANSPORT_WS });
      };
      // what the server reported that its case did not expect: nothing, between steps
      const expectNothingReported = (when: string): void => {
        expect(reports, when).toEqual([]);
      };

      try {
        for (const [index, step] of steps.entries()) {
          const at = `step ${String(index + 1)}`;
          const milliseconds = step.within ?? PATIENCE;

          if (step.send !== undefined || step.close === true) {
            expectNothingReported(`before ${at}`);
          }

          if (step.send !== undefined && 'head' in step.send) {
            exchanges.get(step.on ?? '')?.destroy();
            exchanges.set(
              step.on ?? '',
              openExchange({ answersPings, host: HOST, port }, requestOf(step.send, values))
            );
          } else if (step.send !== undefined) {
            exchangeOf(step.on, at).send(framesOf(step.send));
          }

          if (step.close === true) {
            exchangeOf(step.on, at).destroy();
          }

          if (step.expect !== undefined && 'status' in step.expect) {
            await expectResponse(
              { at, exchange: exchangeOf(step.on, at), milliseconds },
              { expectation: step.expect, values }
            );
          } else if (step.expect !== undefined) {
            await expectHeard({ at, exchange: exchangeOf(step.on, at), milliseconds }, step.expect);
          }

          if (step.until !== undefined && 'timer' in step.until) {
            const { timer } = step.until;

            await pollWithinPatience(() => {
              return duesOn(clock).includes(timer);
            });
            expect(duesOn(clock), `${at}: the timers armed`).toContain(timer);
          } else if (step.until !== undefined) {
            const { gauge, is } = step.until;
            const valueOf = (): number | undefined => {
              return server.transport.gauges().counts[gauge];
            };

            await pollWithinPatience(() => {
              return valueOf() === is;
            });
            expect(valueOf(), `${at}: ${gauge}`).toBe(is);
          }

          if (step.advance !== undefined) {
            await clock.tickAsync(step.advance);
          }

          if (step.wall !== undefined) {
            clock.setSystemTime(clock.Date.now() + step.wall);
          }

          if (step.report !== undefined) {
            await pollWithinPatience(() => {
              return reports.length > 0;
            });

            const report = reports.shift();

            expect(report?.code, `${at}: the report`).toBe(step.report);

            if (step.on !== undefined) {
              expect(report?.connectionHandle, `${at}: the report's connection`).toBe(
                handleOf(step.on, at)
              );
            }
          }

          if (step.stop === true) {
            isStopped = true;
            await server[Symbol.asyncDispose]();
          }
        }

        expectNothingReported('at the end');
      } finally {
        for (const exchange of exchanges.values()) {
          exchange.destroy();
        }

        if (!isStopped) {
          await server[Symbol.asyncDispose]();
        }
      }
    });
  }

  test('every case is played, but one whose differs excuses TypeScript', () => {
    expect(played).toEqual(
      TRANSPORTS.cases
        .filter((testCase) => {
          return !isExcused(testCase);
        })
        .map(({ name }) => {
          return name;
        })
    );
  });
});
