// ── Transports ────────────────────────────────────────────────────────────────

// Bead's transports' cases, `spec/transports.json`, played against Bead's TypeScript server of the
// interop service over HTTP: a peer of the test's own writes each exchange's octets on a socket of
// its own, and reads what the server answers and reports. The C# server plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { offerInterop } from '../../../../interop/offer';
import {
  expectedOf,
  hexadecimalOf,
  type IExpected,
} from '../../../router/server/__tests__/expected-envelope';
import { FailureError } from '../../../router/server/router-server';
import { fromHexadecimal } from '../../../router/shared/__tests__/vectors';
import { wholeEnvelopeLimitsOf } from '../../../router/shared/whole-envelope-limits';
import { CONNECTION_INACTIVITY_TIMEOUT } from '../../../server/http-server';
import { createServer } from '../../../server/server';
import { createWSServer } from '../../../server/ws-server';
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
import { HEARTBEAT } from '../ws-transport-server';
import { createFakeWebSocketServer } from './fake-websocket-server';
import {
  createResponseReader,
  openExchange,
  type IExchange,
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
  status: number;
}

/** One step of a case: what the test does, or what the server does next, on the exchange it names. */
interface IStep {
  close?: true;
  expect?: IExpectation;
  on?: string;
  report?: number | 'exception';
  send?: { body?: string; head: string };
  stop?: true;
  until?: { gauge: string; is: number };
}

interface ICase {
  differs?: { language: string; row: string }[];
  name: string;
  options?: Omit<IHTTPTransportServerOptions, 'createServer'>;
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

// constants

const TRANSPORTS = JSON.parse(
  readFileSync(new URL('../../../../../../spec/transports.json', import.meta.url), 'utf8')
) as {
  cases: ICase[];
  defaults: Record<string, number>;
  responses: IResponseCase[];
};

const HOST = '127.0.0.1';

// how long a step waits on the real clock for its bytes, a gauge or a report
const PATIENCE = 3_000;
const POLL = 10;

/** The shapes of what a server draws, in ASCII classes, as the schema defines them. */
const SHAPES = Object.freeze({
  'delay-seconds': /^[0-9]+$/u,
  'http-date':
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u,
  token: /^[A-Za-z0-9_-]{21}[AQgw]$/u,
});

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
  { body = '', head }: NonNullable<IStep['send']>,
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

/** Settles as `promise` does, or rejects once the patience is over. */
const withinPatience = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`${what} did not come within ${String(PATIENCE)} ms`));
  }, PATIENCE);

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
 * A server of the interop service over HTTP on a free port, as `createHTTPServer` builds one, its
 * transport given the case's options as they are, `maximumBodyBytes` among them, and what it
 * reports, as the conversations record it.
 */
const startServer = async (options: ICase['options']) => {
  const server = createServer<HTTPTransportServer, string>(
    {
      transport: createHTTPTransportServer({
        ...options,
        createServer: (listener) => {
          return createNodeServer(listener);
        },
      }),
    },
    {
      connectionInactivityTimeout: CONNECTION_INACTIVITY_TIMEOUT,
      limits: wholeEnvelopeLimitsOf(undefined),
    }
  );
  const reports: (number | 'exception')[] = [];

  server.router.on('error', (error) => {
    reports.push(error instanceof FailureError ? error.code : 'exception');
  });
  offerInterop(server);

  const { port } = await server.transport.start({ address: HOST, findOpenPort: true });

  return { port, reports, server };
};

/** Checks the response of `exchange` against `expectation`, and keeps what its fields capture. */
const expectResponse = async (
  { at, exchange }: { at: string; exchange: IExchange },
  { expectation, values }: { expectation: IExpectation; values: Map<string, string> }
): Promise<void> => {
  const hasBody =
    expectation.body !== undefined ||
    expectation.envelope !== undefined ||
    expectation.batch !== undefined;
  const response = hasBody
    ? await withinPatience(exchange.reader.response, `${at}: the response`)
    : await withinPatience(exchange.reader.head, `${at}: the response's head`);

  expect(seenOf(response, expectation), at).toEqual({
    ...expectation,
    ...(expectation.body === undefined ? {} : { body: canonicalOf(expectation.body) }),
  });

  for (const [name, expected] of Object.entries(expectation.fields ?? {})) {
    const value = response.fields.get(name.toLowerCase());

    if (typeof expected === 'object' && expected?.capture !== undefined && value !== undefined) {
      values.set(expected.capture, value);
    }
  }
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

      const response = await withinPatience(reader.response, 'the response');

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
    const { name, options, steps, transport } = testCase;

    if (transport !== 'http' || isExcused(testCase)) {
      continue;
    }

    played.push(name);

    test(name, async () => {
      const { port, reports, server } = await startServer(options);
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
      // what the server reported that its case did not expect: nothing, between steps
      const expectNothingReported = (when: string): void => {
        expect(reports, when).toEqual([]);
      };

      try {
        for (const [index, step] of steps.entries()) {
          const at = `step ${String(index + 1)}`;

          if (step.send !== undefined || step.close === true) {
            expectNothingReported(`before ${at}`);
          }

          if (step.send !== undefined) {
            exchanges.get(step.on ?? '')?.destroy();
            exchanges.set(
              step.on ?? '',
              openExchange({ host: HOST, port }, requestOf(step.send, values))
            );
          }

          if (step.close === true) {
            exchangeOf(step.on, at).destroy();
          }

          if (step.expect !== undefined) {
            await expectResponse(
              { at, exchange: exchangeOf(step.on, at) },
              { expectation: step.expect, values }
            );
          }

          if (step.until !== undefined) {
            const { gauge, is } = step.until;
            const valueOf = (): number | undefined => {
              return server.transport.gauges().counts[gauge];
            };

            await pollWithinPatience(() => {
              return valueOf() === is;
            });
            expect(valueOf(), `${at}: ${gauge}`).toBe(is);
          }

          if (step.report !== undefined) {
            await pollWithinPatience(() => {
              return reports.length > 0;
            });
            expect(reports.shift(), `${at}: the report`).toBe(step.report);
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
