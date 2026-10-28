// ── Transports ────────────────────────────────────────────────────────────────

// Bead's transports' cases, `spec/transports.json`, played against this side's server of the
// interop service, or a broker client's transport: by a peer writing octets, then frames, per
// exchange, or by participants of the in-memory broker, `BEAD_MQTT_URL`'s or `BEAD_AMQP_URL`'s.
// The C# side plays the same file.

// dependencies

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer as createNodeServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import rhea from 'rhea';
import { WebSocketServer } from 'ws';
import { interopCredentialsOf } from '../../../../interop/credentials';
import { offerInterop } from '../../../../interop/handlers';
import {
  expectedOf,
  failureDetailOf,
  hexadecimalOf,
  type IExpected,
} from '../../../router/server/__tests__/expected-envelope';
import { FailureError } from '../../../router/server/router-server';
import { writeEnvelope } from '../../../router/shared/envelope';
import { EnvelopeKind, FailureScope } from '../../../router/shared/constants';
import { fromHexadecimal } from '../../../router/shared/__tests__/vectors';
import type { RouterLimitsOptions } from '../../../router/shared/types';
import { wholeEnvelopeLimitsOf } from '../../../router/shared/whole-envelope-limits';
import { CONNECTION_INACTIVITY_TIMEOUT } from '../../../server/http-server';
import { createServer } from '../../../server/server';
import type { IServer, IServerTransportLike } from '../../../server/types';
import { createWSServer } from '../../../server/ws-server';
import { BrokerRefusedError } from '../../client/broker-transport-client';
import { createAmqpBrokerAdapter, type IAmqpBrokerAdapter } from '../../shared/amqp-broker-adapter';
import {
  declareInbox,
  queuePathOf,
  requestOf as managementRequestOf,
} from '../../shared/amqp-management';
import type { BrokerTransportClient } from '../../client/types';
import {
  createBrokerParticipant,
  MAXIMUM_ENVELOPE_PARTS_BYTES,
} from '../../shared/broker-participant';
import { ParcelKind, readParcel } from '../../shared/broker-parcel';
import { HELD_BYTES_BUDGET } from '../../shared/broker-sequence';
import { ConnectError } from '../../shared/errors';
import type { BrokerTopic, IBrokerMessage, IBrokerSubscription } from '../../shared/types';
import { BROKER_PUBLISHED, createMemoryBroker } from '../../shared/memory-broker';
import { createMqttBrokerAdapter, type IMqttBrokerAdapter } from '../../shared/mqtt-broker-adapter';
import { createTestClock, duesOn, type TestClock } from '../../shared/__tests__/fixtures';
import {
  BODY_BYTES_BUDGET,
  BODY_GRACE_PERIOD,
  createHTTPTransportServer,
  EXCHANGE_TIMEOUT,
  HEADERS_TIMEOUT,
  INACTIVITY_TIMEOUT,
  MAXIMUM_BODY_BYTES,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_CONNECTIONS_PER_ADDRESS,
  MAXIMUM_OUTBOX_BYTES,
  MAXIMUM_WAIT,
  MAXIMUM_WAITING_EXCHANGES,
  MINIMUM_BODY_BYTES_PER_SECOND,
  MINIMUM_SEND_BYTES_PER_SECOND,
  SEND_GRACE_PERIOD,
  type HTTPTransportServer,
  type IHTTPTransportServerOptions,
} from '../http-transport-server';
import type {
  BrokerTransportServer,
  ITransportServer,
  ITransportServerRefusal,
  TransportServerConnectionHandle,
} from '../types';
import { ACCEPT_TIMEOUT } from '../broker-transport-server';
import { createWSTransportServer, HEARTBEAT, MAXIMUM_UNSENT_BYTES } from '../ws-transport-server';
import {
  createBrokerPeers,
  expectedSeenOf,
  filledOf as parcelFilledOf,
  type IBrokerPeers,
  type IHeardMessage,
  type IParcelFields,
  type IPublication,
  type PeerAdapter,
  seenOf as parcelSeenOf,
} from './broker-peer';
import { createLinkRelay, type ILinkRelay } from './link-relay';
import { createRecordingAdapter, type ILives } from './recording-adapter';
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

/**
 * What the server's transport tells of a refusal (spec 15.1), as a case writes it: `null` for what
 * the request names none of, and `{port}` for the port of the socket the exchange was sent on.
 */
interface ITold {
  address: string | null;
  authority: string | null;
  origin: string | null;
  port: string;
  reason: string;
  status: number;
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
  /** What the server tells of the refusal; `null` where it tells none. */
  told?: ITold | null;
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
  after?: number;
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

/**
 * How an expect is timed, in milliseconds from its step's start, on the real clock: `within`, its
 * wait, a patience where it names none, and `after`, the soonest what it reads may come.
 */
interface ITiming {
  after?: number | undefined;
  startedAt: number;
  within?: number | undefined;
}

interface ICase {
  answersPings?: false;
  differs?: { language: string; row: string }[];
  limits?: RouterLimitsOptions;
  name: string;
  options?: Omit<IHTTPTransportServerOptions, 'createServer'> & {
    acceptTimeout?: number;
    connectionInactivityTimeout?: number;
    group?: true;
    heartbeat?: number;
    heldBytesBudget?: number;
    maximumEnvelopePartsBytes?: number;
    maximumMessageBytes?: number;
    maximumQueuedMessages?: number;
    maximumUnsentBytes?: number;
    names?: string[];
    timeout?: number;
    twin?: string;
    wills?: true;
  };
  peers?: string[];
  realTime?: true;
  role?: 'client';
  steps: IStep[];
  transport: string;
}

/**
 * What a broker case expects next: a parcel a peer reads, or what the transport under test does,
 * where its OPENs were placed, or the lives it asked.
 */
interface IBrokerExpectation {
  closed?: { clean: boolean };
  failed?: { layouts?: number[]; reason: string; status?: number };
  lives?: ILives;
  opened?: true;
  parcel?: IParcelFields;
  placed?: { openers: string[]; with: string };
  received?: IExpected;
  secure?: boolean;
  told?: { address: string; reason: string; status: number };
}

/** One step of a broker case. */
interface IBrokerStep extends Partial<IPublication> {
  advance?: number;
  at?: 'departure';
  connect?: string;
  expect?: IBrokerExpectation;
  leave?: string;
  lose?: string;
  on?: string;
  reported?: string[];
  stop?: true | { crossing: IPublication };
  takeover?: 'client' | 'server';
  transportSend?: { credential?: string; envelope: string };
  until?: { gauge: string; is: number } | { timer: number };
  wait?: number;
  within?: number;
}

/**
 * The broker a case plays over, in memory, a Mosquitto over MQTT 5 or a RabbitMQ over AMQP 1.0: an
 * adapter of each of its participants, a link lost or taken over as a step asks, and every link it
 * holds let go.
 */
interface IBrokerWorld {
  adapterOf(id: string): Promise<PeerAdapter & { readonly unsettled: number }>;
  lose(id: string): Promise<void>;
  takeover(id: string): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
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
  connectionHandle: TransportServerConnectionHandle | undefined;
}

// types

/** A server of the interop service, whichever its transport, as a case plays it. */
type ServerUnderTest = AsyncDisposable &
  IServer<IServerTransportLike, string> & {
    transport: Pick<ITransportServer, 'clients' | 'gauges' | 'start'>;
  };

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
const PLAYED_TRANSPORTS: ReadonlySet<string> = new Set([
  'amqp',
  'broker',
  'http',
  'mqtt',
  'websocket',
]);

// the Mosquitto the cases over MQTT 5 play against, where one is given, and the run's password
const MQTT_URL = process.env['BEAD_MQTT_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
// ! where a broker must be given, its absence fails a case rather than skip it
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';

// the RabbitMQ the cases over AMQP 1.0 play against, where one is given, and the run's password
const AMQP_URL = process.env['BEAD_AMQP_URL'];
const AMQP_PASSWORD = process.env['BEAD_AMQP_PASSWORD'] ?? '';
// ! where a broker must be given, its absence fails a case rather than skip it
const IS_AMQP_REQUIRED = process.env['BEAD_AMQP_REQUIRED'] === '1';
const NO_AMQP_BROKER = 'no broker: BEAD_AMQP_URL is not set (node tools/amqp-broker.mjs start)';
// the fixture's user that reads its queues and purges them, granted nothing a participant is
const AMQP_FIXTURE_USER = 'fixture';

// how long `expect placed` waits, once each OPEN was placed, for one placed twice
const PLACED_GRACE = 250;

// ! every key of a step this harness reads: one it does not know fails the step, rather than pass it
// unplayed
// the keys of a case, as the schema defines them: one this harness does not know fails its case
const CASE_KEYS: ReadonlySet<string> = new Set([
  'answersPings',
  'clauses',
  'differs',
  'limits',
  'name',
  'options',
  'peers',
  'realTime',
  'role',
  'steps',
  'transport',
]);
// a broker step's keys, and those that modify its act rather than make one
const BROKER_STEP_KEYS: ReadonlySet<string> = new Set([
  'advance',
  'at',
  'connect',
  'expect',
  'from',
  'leave',
  'lose',
  'on',
  'publish',
  'refused',
  'reported',
  'retained',
  'stop',
  'takeover',
  'to',
  'transportSend',
  'until',
  'wait',
  'within',
]);
const BROKER_MODIFIERS: ReadonlySet<string> = new Set([
  'at',
  'from',
  'on',
  'refused',
  'retained',
  'to',
  'within',
]);
const STEP_KEYS: ReadonlySet<string> = new Set([
  'advance',
  'after',
  'close',
  'expect',
  'on',
  'report',
  'send',
  'stop',
  'until',
  'wall',
  'within',
]);

// how long a step waits on the real clock for its bytes, a gauge, a timer or a report, unless it says
const PATIENCE = 10_000;

// ! every option and limit this harness reads, by transport, as the C# side's: one it does not read
// fails its case, where it would play on the default unseen
const OPTION_KEYS: Readonly<
  Record<'amqp' | 'broker' | 'http' | 'mqtt' | 'websocket', ReadonlySet<string>>
> = Object.freeze({
  // RabbitMQ's queues are the deployment's, as Mosquitto's are, and it leaves no will
  amqp: new Set([
    'maximumConnections',
    'maximumConnectionsPerAddress',
    'maximumUnsentBytes',
    'minimumBodyBytesPerSecond',
    'bodyGracePeriod',
    'heartbeat',
    'acceptTimeout',
    'maximumEnvelopePartsBytes',
    'heldBytesBudget',
    'names',
    'group',
    'timeout',
    'twin',
  ]),
  broker: new Set([
    'maximumConnections',
    'maximumConnectionsPerAddress',
    'maximumUnsentBytes',
    'minimumBodyBytesPerSecond',
    'bodyGracePeriod',
    'heartbeat',
    'acceptTimeout',
    'maximumEnvelopePartsBytes',
    'heldBytesBudget',
    'names',
    'group',
    'maximumQueuedMessages',
    'timeout',
    'twin',
    'wills',
  ]),
  // the in-memory broker's queue is its own: Mosquitto's is every client's
  mqtt: new Set([
    'maximumConnections',
    'maximumConnectionsPerAddress',
    'maximumUnsentBytes',
    'minimumBodyBytesPerSecond',
    'bodyGracePeriod',
    'heartbeat',
    'acceptTimeout',
    'maximumEnvelopePartsBytes',
    'heldBytesBudget',
    'names',
    'group',
    'timeout',
    'twin',
    'wills',
  ]),
  http: new Set([
    'maximumConnections',
    'maximumConnectionsPerAddress',
    'maximumWaitingExchanges',
    'bodyBytesBudget',
    'maximumBodyBytes',
    'maximumOutboxBytes',
    'maximumWait',
    'exchangeTimeout',
    'inactivityTimeout',
    'hosts',
    'origins',
    'trustedProxies',
    'unnamedProxies',
    'minimumSendBytesPerSecond',
    'sendGracePeriod',
    'headersTimeout',
    'minimumBodyBytesPerSecond',
    'bodyGracePeriod',
    'connectionInactivityTimeout',
  ]),
  websocket: new Set([
    'maximumMessageBytes',
    'heartbeat',
    'hosts',
    'origins',
    'trustedProxies',
    'unnamedProxies',
    'maximumConnections',
    'maximumConnectionsPerAddress',
    'minimumSendBytesPerSecond',
    'sendGracePeriod',
    'maximumUnsentBytes',
    'headersTimeout',
  ]),
});
const LIMIT_KEYS: ReadonlySet<string> = new Set([
  'maximumEnvelopeBytes',
  'chunkBytes',
  'windowBytes',
  'maximumTransfers',
  'maximumPayloadBytes',
  'bufferedBytesBudget',
  'maximumChunkRuns',
  'maximumDetailBytes',
  'maximumAnsweringCalls',
  'transferInactivityTimeout',
]);
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

/**
 * A body's one envelope, as a case expects it — a failure's detail where `expected` gives one,
 * informative elsewhere — or its bytes when they are none.
 */
const envelopeOf = (bytes: Uint8Array, expected?: IExpected | string): IExpected | string => {
  let actual: IExpected | string;

  try {
    actual = expectedOf(bytes) ?? hexadecimalOf(bytes);
  } catch {
    return hexadecimalOf(bytes);
  }

  return typeof actual === 'object' &&
    actual.failure !== undefined &&
    typeof expected === 'object' &&
    expected.failure?.detail !== undefined
    ? { ...actual, failure: { ...actual.failure, detail: failureDetailOf(bytes) } }
    : actual;
};

/** A batch's envelopes, each after its length on 4 bytes, big-endian, as `expected` writes them. */
const batchOf = (bytes: Uint8Array, expected?: (IExpected | string)[]): (IExpected | string)[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const envelopes: (IExpected | string)[] = [];
  let at = 0;

  while (at + 4 <= bytes.length) {
    const length = view.getUint32(at);

    envelopes.push(
      envelopeOf(bytes.subarray(at + 4, at + 4 + length), expected?.[envelopes.length])
    );
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
    ...(expectation.envelope === undefined
      ? {}
      : { envelope: envelopeOf(body, expectation.envelope) }),
    ...(expectation.batch === undefined ? {} : { batch: batchOf(body, expectation.batch) }),
  };
};

/**
 * What the server sent on a WebSocket, in the terms `expectation` names it by: a pong, which no
 * case expects, as itself, so that it fails the step it comes in.
 */
const heardOf = (
  heard: Heard,
  expectation: IHeardExpectation
): IHeardExpectation | { pong: true } | { text: string } => {
  if ('binary' in heard) {
    return expectation.envelope === undefined
      ? { binary: hexadecimalOf(heard.binary) }
      : { envelope: envelopeOf(heard.binary, expectation.envelope) };
  }

  if ('ping' in heard) {
    return { ping: true };
  }

  return 'pong' in heard ? { pong: true } : heard;
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

/** Milliseconds on the real clock since `startedAt`, whole. */
const sinceOf = (startedAt: number): number => {
  return Math.round(performance.now() - startedAt);
};

/** What `promise` gives, or `undefined` once `milliseconds` are over; it rejects as `promise` does. */
const settledWithin = async <T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<{ value: T } | undefined> => {
  const over = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    over.resolve(undefined);
  }, milliseconds);

  try {
    return await Promise.race([
      promise.then((value) => {
        return { value };
      }),
      over.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** What befell `promise` in the patience past a wait it missed, as a failure tells it. */
const lateOf = async (promise: Promise<unknown>, startedAt: number): Promise<string> => {
  try {
    const late = await settledWithin(promise, PATIENCE);

    return late === undefined
      ? `, nor in the ${String(PATIENCE)} ms past it`
      : `: it came at ${String(sinceOf(startedAt))} ms`;
  } catch (error) {
    return `, and failed at ${String(sinceOf(startedAt))} ms: ${String(error)}`;
  }
};

/**
 * What `promise` gives within its step's wait, once it came no sooner than the step's `after`; past
 * a `within` missed, it waits up to a patience more, so the failure tells when it came, or that it
 * never did.
 */
const cameOf = async <T>(
  promise: Promise<T>,
  { timing, what }: { timing: ITiming; what: string }
): Promise<T> => {
  const { after, startedAt, within: bound } = timing;
  const wait = bound ?? PATIENCE;
  const came = await settledWithin(promise, wait);

  if (came === undefined) {
    const late = bound === undefined ? '' : await lateOf(promise, startedAt);

    throw new Error(`${what} did not come within ${String(wait)} ms${late}`);
  }

  const cameAt = sinceOf(startedAt);

  if (after !== undefined && cameAt < after) {
    throw new Error(`${what} came at ${String(cameAt)} ms, before its ${String(after)} ms`);
  }

  return came.value;
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
 * `clock`, given the interop service's credentials. Over HTTP, its transport is given them as they
 * are, `maximumBodyBytes` among them, which `createHTTPServer` sets itself; its server layer, its own
 * connection timeout. Over WebSocket, its transport takes the `hosts`, `origins`, `trustedProxies`
 * and `unnamedProxies` alike.
 */
const serverOf = (
  { limits, options = {}, transport }: ICase,
  clock: TestClock
): ServerUnderTest => {
  for (const name of Object.keys(options)) {
    if (!OPTION_KEYS[transport === 'websocket' ? 'websocket' : 'http'].has(name)) {
      throw new Error(`a case sets an option no test reads: ${name}`);
    }
  }

  for (const name of Object.keys(limits ?? {})) {
    if (!LIMIT_KEYS.has(name)) {
      throw new Error(`a case sets a limit no test reads: ${name}`);
    }
  }

  const {
    connectionInactivityTimeout,
    heartbeat,
    maximumMessageBytes,
    maximumUnsentBytes,
    ...bounds
  } = options;

  if (transport === 'websocket') {
    return createWSServer<string>({
      credentials: interopCredentialsOf(clock, limits),
      limits,
      transport: {
        clock,
        headersTimeout: bounds.headersTimeout,
        heartbeat,
        hosts: bounds.hosts,
        maxPayload: maximumMessageBytes,
        maximumConnections: bounds.maximumConnections,
        maximumConnectionsPerAddress: bounds.maximumConnectionsPerAddress,
        maximumUnsentBytes,
        minimumSendBytesPerSecond: bounds.minimumSendBytesPerSecond,
        origins: bounds.origins,
        sendGracePeriod: bounds.sendGracePeriod,
        trustedProxies: bounds.trustedProxies,
        unnamedProxies: bounds.unnamedProxies,
        WebSocketServer,
      },
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
      connectionInactivityTimeout: connectionInactivityTimeout ?? CONNECTION_INACTIVITY_TIMEOUT,
      credentials: interopCredentialsOf(clock, wholeEnvelopeLimitsOf(limits)),
      limits: wholeEnvelopeLimitsOf(limits),
    }
  );
};

/**
 * Offers the interop service on `server`, starts it on a free port, and records what it reports
 * and each refusal its transport tells.
 */
const serve = async (server: ServerUnderTest) => {
  const refusals: ITransportServerRefusal[] = [];
  const reports: IReport[] = [];

  server.router.on('error', (error, connectionHandle) => {
    reports.push({
      code: error instanceof FailureError ? error.code : 'exception',
      connectionHandle,
    });
  });
  server.transport.on('refusal', (refusal) => {
    refusals.push(refusal);
  });
  offerInterop(server);

  const { port } = await server.transport.start({ address: HOST, findOpenPort: true });

  return { port, refusals, reports };
};

/** A refusal told, in a case's terms: `null` for none, and its port as the socket's it came from. */
const toldOf = (
  { address, authority, origin, port, reason, status }: ITransportServerRefusal,
  localPort: number | undefined
): ITold => {
  return {
    address: address ?? null,
    authority: authority ?? null,
    origin: origin ?? null,
    port: port === localPort ? '{port}' : String(port),
    reason,
    status,
  };
};

/** `told` with each `{name}` its strings hold replaced by the value it names, as in a head. */
const filledOf = (told: ITold, values: ReadonlyMap<string, string>): ITold => {
  const fill = (text: string | null): string | null => {
    return (
      text?.replaceAll(/\{(\w+)\}/gu, (match, name: string) => {
        return name === 'port' ? match : (values.get(name) ?? match);
      }) ?? null
    );
  };

  return {
    ...told,
    address: fill(told.address),
    authority: fill(told.authority),
    origin: fill(told.origin),
  };
};

/**
 * Checks the response of `exchange` against `expectation`, its head timed as its step says and its
 * body within what is left of the step's wait, and keeps what its fields capture; then what the
 * server told of it, when the case says.
 */
const expectResponse = async (
  { at, exchange, timing }: { at: string; exchange: IExchange; timing: ITiming },
  {
    expectation,
    refusals,
    values,
  }: { expectation: IExpectation; refusals: ITransportServerRefusal[]; values: Map<string, string> }
): Promise<void> => {
  const { orLost, told, ...expected } = expectation;
  const hasBody =
    expected.body !== undefined || expected.envelope !== undefined || expected.batch !== undefined;
  const head = await cameOf(exchange.reader.head, {
    timing,
    what: `${at}: the response's head`,
  }).catch((reason: unknown) => {
    // a cut that overtook the head, where the case allows it; a head that did not come in time, or
    // came unreadable, is no loss
    if (orLost === true && exchange.reader.isLost) {
      return undefined;
    }

    throw reason;
  });

  if (head === undefined) {
    return;
  }

  const response = hasBody
    ? await within(exchange.reader.response, {
        milliseconds: Math.max(0, (timing.within ?? PATIENCE) - sinceOf(timing.startedAt)),
        what: `${at}: the response`,
      })
    : head;

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

  // ! a refusal is told once written, so none told by now is none at all
  if (told === null) {
    expect(refusals, `${at}: the refusals told`).toEqual([]);
  } else if (told !== undefined) {
    await pollWithinPatience(() => {
      return refusals.length > 0;
    });

    const refusal = refusals.shift();

    expect(
      refusal === undefined ? 'none told' : toldOf(refusal, exchange.localPort),
      `${at}: the refusal told`
    ).toEqual(filledOf(told, values));
  }
};

/**
 * What the server sends next on the WebSocket of `exchange`, in the terms `expectation` names it by,
 * or what came instead: nothing within the step's wait, or something sooner than its `after`; past a
 * `within` missed, it waits up to a patience more, so the failure tells when it came, or that
 * nothing did.
 */
const heardWithin = async (
  { exchange, timing }: { exchange: IExchange; timing: ITiming },
  expectation: IHeardExpectation
): Promise<ReturnType<typeof heardOf> | string> => {
  const { after, startedAt, within: bound } = timing;
  const wait = bound ?? PATIENCE;
  const heard = await exchange.next(wait);
  const cameAt = sinceOf(startedAt);

  if (heard === undefined && bound === undefined) {
    return `nothing within ${String(wait)} ms`;
  }

  if (heard === undefined) {
    const late = await exchange.next(PATIENCE);

    return late === undefined
      ? `nothing within ${String(wait)} ms, nor in the ${String(PATIENCE)} ms past it`
      : `nothing within ${String(wait)} ms: ${JSON.stringify(heardOf(late, expectation))} came at ${String(sinceOf(startedAt))} ms`;
  }

  return after !== undefined && cameAt < after
    ? `${JSON.stringify(heardOf(heard, expectation))} came at ${String(cameAt)} ms, before its ${String(after)} ms`
    : heardOf(heard, expectation);
};

/** Checks the next thing the server sends on the WebSocket of `exchange` against `expectation`. */
const expectHeard = async (
  { at, exchange, timing }: { at: string; exchange: IExchange; timing: ITiming },
  expectation: IHeardExpectation
): Promise<void> => {
  expect(await heardWithin({ exchange, timing }, expectation), at).toEqual({
    ...expectation,
    ...(expectation.binary === undefined ? {} : { binary: canonicalOf(expectation.binary) }),
  });
};

/** What a promise came to, once it settles: its value, or what it rejected with. */
const settlingOf = <T>(promise: Promise<T>): Promise<{ error: unknown } | { value: T }> => {
  return promise.then(
    (value) => {
      return { value };
    },
    (error: unknown) => {
      return { error };
    }
  );
};

/** The next of `queue` within `within` milliseconds on the real clock, taken from it, or none. */
const nextOf = async <T>(queue: T[], within: number): Promise<T | undefined> => {
  const deadline = Date.now() + within;

  while (queue.length === 0 && Date.now() < deadline) {
    await sleep(POLL);
  }

  return queue.shift();
};

/** The in-memory broker a case plays over, on `clock`, its links lost and taken over by its adapters. */
const memoryWorldOf = (
  clock: TestClock,
  { maximumQueuedMessages }: { maximumQueuedMessages?: number | undefined }
): IBrokerWorld => {
  const broker = createMemoryBroker({ clock, maximumQueuedMessages });
  const adapters = new Map<string, ReturnType<typeof broker.adapter>>();
  const adapterNamed = (id: string) => {
    const adapter = adapters.get(id);

    if (adapter === undefined) {
      throw new Error(`no participant ${id} in the case`);
    }

    return adapter;
  };

  return {
    adapterOf: (id) => {
      const adapter = broker.adapter({ id });

      adapters.set(id, adapter);

      return Promise.resolve(adapter);
    },
    lose: (id) => {
      adapterNamed(id).lose();

      return Promise.resolve();
    },
    takeover: (id) => {
      adapterNamed(id).takeOver();

      return Promise.resolve();
    },
    [Symbol.asyncDispose]: () => {
      return Promise.resolve();
    },
  };
};

/**
 * The Mosquitto at `url` a case plays over: each participant a link of this side's MQTT adapter,
 * through a relay of its own that a `lose` cuts; a `takeover` a link of the player's own under the
 * id, straight to the broker, which subscribes nothing; every relay and every such link let go.
 */
const mqttWorldOf = (url: string, password: string): IBrokerWorld => {
  const broker = new URL(url);
  const relays = new Map<string, ILinkRelay>();
  const takeovers: IMqttBrokerAdapter[] = [];

  return {
    adapterOf: async (id) => {
      const relay = await createLinkRelay({
        host: broker.hostname,
        port: Number(broker.port),
      });

      relays.set(id, relay);

      return createMqttBrokerAdapter({
        id,
        password,
        url: `${broker.protocol}//${HOST}:${String(relay.port)}`,
      });
    },
    lose: (id) => {
      relays.get(id)?.cut();

      return Promise.resolve();
    },
    takeover: async (id) => {
      const link = createMqttBrokerAdapter({ id, password, url });

      takeovers.push(link);
      await link.start();
    },
    [Symbol.asyncDispose]: async () => {
      for (const link of takeovers) {
        await link.stop();
      }

      for (const relay of relays.values()) {
        await relay[Symbol.asyncDispose]();
      }
    },
  };
};

/**
 * The RabbitMQ at `url` a case plays over: each participant a link of this side's AMQP 1.0 adapter,
 * through a relay of its own that a `lose` cuts; no `takeover`, which no case over AMQP 1.0 asks. In
 * the client role each peer reads the name it plays the server of through a queue of its own,
 * `bead.p.<id>`, bound by that name, so that each is handed every OPEN, as over MQTT 5. A name's
 * queue is purged as a case begins, and each inbox awaited gone as it ends, so that the next case's
 * links of the same ids declare theirs anew.
 */
const amqpWorldOf = async (
  url: string,
  {
    isClient,
    names,
    password,
    under,
  }: { isClient: boolean; names: readonly string[]; password: string; under: string }
): Promise<IBrokerWorld> => {
  const broker = new URL(url);
  const relays = new Map<string, ILinkRelay>();
  const container = rhea.create_container({ id: 'transports-fixture' });
  const sides: ReturnType<typeof container.connect>[] = [];

  container.on('error', () => {
    // its connection's end is read where it is held
  });

  // a connection of its own to the broker as `user`, its OPEN answered
  const connectionOf = async (user: string): Promise<ReturnType<typeof container.connect>> => {
    const connection = container.connect({
      host: broker.hostname,
      password,
      port: Number(broker.port),
      reconnect: false,
      username: user,
    });

    connection.on('disconnected', () => {
      // closed with the case
    });
    await new Promise<void>((resolve, reject) => {
      connection.once('connection_open', () => {
        resolve();
      });
      connection.once('connection_close', () => {
        reject(new Error(`${user} could not link to its broker`));
      });
    });

    return connection;
  };

  // * a peer of the client role: its inbox and what it publishes its adapter's, the names it
  // subscribes read on a connection of its own through its own queue, bound by each name
  const asServer = (adapter: IAmqpBrokerAdapter, id: string): IAmqpBrokerAdapter => {
    const listeners = new Set<(message: IBrokerMessage) => void>();
    const queue = `bead.p.${id}`;
    let side: ReturnType<typeof container.connect> | undefined;

    return Object.assign(Object.create(adapter) as IAmqpBrokerAdapter, {
      off: (event: 'down' | 'message', listener: never) => {
        listeners.delete(listener);
        adapter.off(event as 'message', listener);
      },
      on: (event: 'down' | 'message', listener: never) => {
        if (event === 'message') {
          listeners.add(listener);
        }

        adapter.on(event as 'message', listener);
      },
      stop: async () => {
        side?.close();
        side = undefined;
        await adapter.stop();
      },
      subscribe: async (topic: BrokerTopic, subscription?: IBrokerSubscription) => {
        if (topic[1] !== 's') {
          return adapter.subscribe(topic, subscription);
        }

        if (side === undefined) {
          side = await connectionOf(id);
          sides.push(side);
          await declareInbox(side, { queue });

          const receiver = side.open_receiver({ source: { address: `/queues/${queue}` } });

          receiver.on('message', (context: { message?: { body?: unknown } }) => {
            const content = (context.message?.body as { content?: unknown } | undefined)?.content;

            for (const listener of listeners) {
              listener({
                payload: new Uint8Array(content instanceof Uint8Array ? content : []),
                settle: () => {
                  // accepted as it came
                },
                topic,
              });
            }
          });
          await once(receiver, 'receiver_open');
        }

        const { status } = await managementRequestOf(side, {
          body: rhea.types.wrap_map({
            arguments: rhea.types.wrap_map({}),
            binding_key: topic.join('.'),
            destination_queue: queue,
            source: 'bead',
          }),
          method: 'POST',
          path: '/bindings',
        });

        expect(status, `${queue} bound by ${topic.join('.')}`).toBe(204);

        return undefined;
      },
    });
  };

  // * the fixture's own connection, each request of its management on it
  const managed = async <T>(
    manage: (connection: ReturnType<typeof container.connect>) => Promise<T>
  ): Promise<T> => {
    const connection = container.connect({
      host: broker.hostname,
      password,
      port: Number(broker.port),
      reconnect: false,
      username: AMQP_FIXTURE_USER,
    });

    connection.on('disconnected', () => {
      // closed below
    });

    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('connection_open', () => {
          resolve();
        });
        connection.once('connection_close', () => {
          reject(new Error('the fixture user could not link to its broker'));
        });
      });

      return await manage(connection);
    } finally {
      connection.close();
    }
  };

  await managed(async (connection) => {
    for (const name of names) {
      await managementRequestOf(connection, {
        method: 'DELETE',
        path: `${queuePathOf(`bead.s.${name}`)}/messages`,
      });
    }
  });

  return {
    adapterOf: async (id) => {
      const relay = await createLinkRelay({
        host: broker.hostname,
        port: Number(broker.port),
      });

      relays.set(id, relay);

      const adapter = createAmqpBrokerAdapter({
        id,
        password,
        url: `${broker.protocol}//${HOST}:${String(relay.port)}`,
      });

      return isClient && id !== under ? asServer(adapter, id) : adapter;
    },
    lose: (id) => {
      relays.get(id)?.cut();

      return Promise.resolve();
    },
    takeover: () => {
      return Promise.reject(
        new Error('no link of an id takes another over over AMQP 1.0, and no case asks it')
      );
    },
    [Symbol.asyncDispose]: async () => {
      for (const side of sides) {
        side.close();
      }

      for (const relay of relays.values()) {
        await relay[Symbol.asyncDispose]();
      }

      // * each inbox gone with its connection, which its broker deletes a few milliseconds after
      await managed(async (connection) => {
        const deadline = Date.now() + PATIENCE;

        for (const queue of [...relays.keys()].flatMap((id) => {
          return [`bead.i.${id}`, `bead.p.${id}`];
        })) {
          while (Date.now() < deadline) {
            const { status } = await managementRequestOf(connection, {
              method: 'GET',
              path: queuePathOf(queue),
            });

            if (status === 404) {
              break;
            }

            await sleep(POLL);
          }
        }
      });
    },
  };
};

/** The incarnation each peer's OPENs name in `steps`, which its will names where a case asks one. */
const willsOf = (steps: readonly IBrokerStep[]): Map<string, string> => {
  const wills = new Map<string, string>();

  for (const { from, publish = [] } of steps) {
    for (const item of publish) {
      const incarnation = 'parcel' in item ? item.parcel.incarnation : undefined;

      if (from !== undefined && typeof incarnation === 'string' && !wills.has(from)) {
        wills.set(from, incarnation);
      }
    }
  }

  return wills;
};

/**
 * Where each OPEN of `openers` went, read on the peer `on`'s inbox, the server's ACCEPT naming it,
 * and on the twin's, the OPEN itself: once each was placed, a grace for one placed twice.
 */
const placedOf = async (
  { openers, within }: { openers: readonly string[]; within: number },
  readers: Readonly<Record<'server' | 'twin', (wait: number) => Promise<IHeardMessage | undefined>>>
): Promise<Record<string, string[]>> => {
  const placed = new Map<string, string[]>(
    openers.map((opener) => {
      return [canonicalOf(opener), []];
    })
  );
  const isPlaced = (): boolean => {
    return [...placed.values()].every((places) => {
      return places.length > 0;
    });
  };
  // the server's ACCEPT, or the twin's OPEN, naming an opener's half
  const take = async (where: 'server' | 'twin'): Promise<boolean> => {
    const message = await readers[where](POLL);
    const read = message === undefined ? undefined : readParcel(message.payload);
    const kind = where === 'server' ? ParcelKind.ACCEPT : ParcelKind.OPEN;

    if (read !== undefined && 'parcel' in read && read.parcel.kind === kind) {
      placed.get(hexadecimalOf(read.parcel.opener))?.push(where);
    }

    return message !== undefined;
  };
  const deadline = Date.now() + within;

  while (!isPlaced() && Date.now() < deadline) {
    const tookEither = (await Promise.all([take('server'), take('twin')])).includes(true);

    if (!tookEither) {
      await sleep(POLL);
    }
  }

  const graceEnds = Date.now() + PLACED_GRACE;

  while (Date.now() < graceEnds) {
    await Promise.all([take('server'), take('twin')]);
  }

  return Object.fromEntries(placed);
};

/**
 * Plays a broker case (spec 15.16 to 15.38) in memory, over the Mosquitto `BEAD_MQTT_URL` names or
 * over the RabbitMQ `BEAD_AMQP_URL` names:
 * in the server role, the interop service's server on a broker server transport over the
 * participant `server`, its link connecting anew once lost; in the client role, a broker client
 * transport alone over the participant `client`, with no reconnection; its adapter wrapped to note
 * the lives it asks; the test's peers and twin publishing parcels and reading their inboxes. Its
 * `maximumEnvelopePartsBytes` is its router's `maximumEnvelopeBytes` unless the case sets it. Every
 * participant is stopped before the next case, whose own a link left up would take over.
 */
const playBrokerCase = async (
  testCase: ICase,
  { transport }: { transport: 'amqp' | 'broker' | 'mqtt' }
): Promise<void> => {
  const { limits, options = {}, peers: ids = ['peer'], role, steps } = testCase;
  const isClient = role === 'client';
  const brokerSteps = steps as IBrokerStep[];

  expect(
    Object.keys(testCase).filter((key) => {
      return !CASE_KEYS.has(key);
    }),
    'the keys of the case this harness does not read'
  ).toEqual([]);

  for (const name of Object.keys(options)) {
    if (!OPTION_KEYS[transport].has(name)) {
      throw new Error(`a case sets an option no test reads: ${name}`);
    }
  }

  for (const name of Object.keys(limits ?? {})) {
    if (!LIMIT_KEYS.has(name)) {
      throw new Error(`a case sets a limit no test reads: ${name}`);
    }
  }

  const clock = createTestClock(Date.parse(TRANSPORTS.wallClock));
  const under = isClient ? 'client' : 'server';
  const world =
    transport === 'broker'
      ? memoryWorldOf(clock, { maximumQueuedMessages: options.maximumQueuedMessages })
      : transport === 'mqtt'
        ? mqttWorldOf(MQTT_URL ?? '', MQTT_PASSWORD)
        : await amqpWorldOf(AMQP_URL ?? '', {
            isClient,
            names: options.names ?? ['interop'],
            password: AMQP_PASSWORD,
            under,
          });
  const values = new Map<string, string>();
  const reports: IReport[] = [];
  const refusals: ITransportServerRefusal[] = [];
  const errors: { connectionHandle: string; error: Error }[] = [];
  const closes: { address: string | undefined; wasClean: boolean }[] = [];
  const received: Uint8Array[] = [];
  // the peer each connection the server told was opened by, by its handle
  const addresses = new Map<string, string>();
  let participant: ReturnType<typeof createBrokerParticipant> | undefined;
  let server: (AsyncDisposable & IServer<BrokerTransportServer, string>) | undefined;
  let client: BrokerTransportClient | undefined;
  let connecting: Promise<{ error: unknown } | { value: void }> | undefined;
  let peers: (IBrokerPeers & AsyncDisposable) | undefined;
  let twin: (IBrokerPeers & AsyncDisposable) | undefined;

  const expectNothingReported = (when: string): void => {
    expect(reports, when).toEqual([]);
    expect(refusals, `${when}: the refusals told`).toEqual([]);
    expect(
      errors.map(({ error }) => {
        return error.message;
      }),
      `${when}: what the transport reported`
    ).toEqual([]);
  };

  try {
    const adapter = createRecordingAdapter(await world.adapterOf(under));

    participant = createBrokerParticipant({
      adapter,
      bodyGracePeriod: options.bodyGracePeriod,
      clock,
      heartbeat: options.heartbeat,
      heldBytesBudget: options.heldBytesBudget,
      maximumEnvelopePartsBytes: options.maximumEnvelopePartsBytes ?? limits?.maximumEnvelopeBytes,
      minimumBodyBytesPerSecond: options.minimumBodyBytesPerSecond,
      reconnect: isClient ? false : {},
    });

    if (isClient) {
      client = participant.transportClient();
      client.on('message', ({ data }) => {
        received.push(new Uint8Array(data as ArrayBuffer | Uint8Array));
      });
      client.on('close', (wasClean) => {
        closes.push({ address: undefined, wasClean });
      });
      client.on('error', (error) => {
        errors.push({ connectionHandle: '', error });
      });
    } else {
      const names = options.names ?? ['interop'];
      const transportServer = participant.transportServer({
        acceptTimeout: options.acceptTimeout,
        group: options.group,
        maximumConnections: options.maximumConnections,
        maximumConnectionsPerAddress: options.maximumConnectionsPerAddress,
        maximumUnsentBytes: options.maximumUnsentBytes,
        names,
      });

      server = createServer<BrokerTransportServer, string>(
        { transport: transportServer },
        { credentials: interopCredentialsOf(clock, limits), limits }
      );
      server.router.on('error', (error, connectionHandle) => {
        reports.push({
          code: error instanceof FailureError ? error.code : 'exception',
          connectionHandle,
        });
      });
      transportServer.on('refusal', (refusal) => {
        refusals.push(refusal);
      });
      transportServer.on('error', (error, connectionHandle) => {
        errors.push({ connectionHandle, error });
      });
      transportServer.on('connection', (...[peer, , connectionHandle]) => {
        addresses.set(connectionHandle, peer.id);
      });
      transportServer.on('close', (wasClean, connectionHandle) => {
        closes.push({ address: addresses.get(connectionHandle), wasClean });
      });
      offerInterop(server);

      // * a twin serves the names in their group beside the server, reading each OPEN it is handed
      if (options.twin !== undefined) {
        const twinAdapter = await world.adapterOf(options.twin);

        twin = await createBrokerPeers(
          () => {
            return Promise.resolve(twinAdapter);
          },
          { ids: [options.twin], isClient: false, under }
        );

        for (const name of names) {
          await twinAdapter.subscribe(['bead', 's', name], { group: name });
        }
      }

      await transportServer.start();
    }

    peers = await createBrokerPeers(
      (id) => {
        return world.adapterOf(id);
      },
      {
        ids,
        isClient,
        under,
        wills: options.wills === true ? willsOf(brokerSteps) : undefined,
      }
    );

    for (const [index, step] of brokerSteps.entries()) {
      const at = `step ${String(index + 1)}`;
      const within = step.within ?? PATIENCE;

      expect(
        Object.keys(step).filter((key) => {
          return !BROKER_STEP_KEYS.has(key);
        }),
        `${at}: the keys this harness does not read`
      ).toEqual([]);
      expect(
        Object.keys(step).filter((key) => {
          return !BROKER_MODIFIERS.has(key);
        }),
        `${at}: the acts it holds`
      ).toHaveLength(1);

      if (step.publish !== undefined || step.stop !== undefined) {
        expectNothingReported(`before ${at}`);
      }

      if (step.publish !== undefined) {
        const published = await peers.publish(step as IPublication, values);

        expect(published, `${at}: what the broker said of it`).toEqual(
          published.map(() => {
            return step.refused ?? BROKER_PUBLISHED.TAKEN;
          })
        );
      }

      if (step.stop !== undefined) {
        // * what crosses the stop is published in the turn it begins, before it
        const crossing =
          step.stop === true ? Promise.resolve([]) : peers.publish(step.stop.crossing, values);

        await Promise.all([crossing, server?.transport.stop()]);
      }

      if (step.wait !== undefined) {
        await sleep(step.wait);
      }

      if (step.lose !== undefined) {
        await world.lose(step.lose);
      }

      if (step.takeover !== undefined) {
        await world.takeover(step.takeover);
      }

      if (step.leave !== undefined) {
        await peers.leave(step.leave);
      }

      if (step.connect !== undefined && client !== undefined) {
        connecting = settlingOf(
          client.connect({
            server: step.connect,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          })
        );
      }

      if (step.transportSend !== undefined) {
        const { credential, envelope } = step.transportSend;

        await client?.send({ credential, data: fromHexadecimal(envelope) });
      }

      const expectation = step.expect;

      if (expectation?.parcel !== undefined) {
        const message = await peers.next(step.on ?? 'peer', { at: step.at, within });

        expect(
          message === undefined
            ? `nothing within ${String(within)} ms`
            : parcelSeenOf(message.payload, { expected: expectation.parcel, values }),
          `${at}: the parcel ${step.on ?? 'peer'} reads${step.at === undefined ? '' : ` at the ${step.at}`}`
        ).toEqual(expectedSeenOf(expectation.parcel));

        if (expectation.told !== undefined) {
          const refusal = await nextOf(refusals, PATIENCE);

          expect(
            refusal === undefined
              ? 'none told'
              : { address: refusal.address, reason: refusal.reason, status: refusal.status },
            `${at}: the refusal told`
          ).toEqual({
            ...expectation.told,
            address: parcelFilledOf(expectation.told.address, values),
          });
          expect(
            { authority: refusal?.authority, origin: refusal?.origin },
            `${at}: what the refusal tells besides`
          ).toEqual({ authority: undefined, origin: undefined });
        }
      }

      if (expectation?.placed !== undefined) {
        const { openers, with: other } = expectation.placed;

        expect(other, `${at}: the twin the OPENs were placed with`).toBe(options.twin);

        const { next } = peers;
        const twinNext = twin?.next;
        const placed = await placedOf(
          { openers, within },
          {
            server: (wait) => {
              return next(step.on ?? 'peer', { within: wait });
            },
            twin: (wait) => {
              return twinNext?.(other, { within: wait }) ?? Promise.resolve(undefined);
            },
          }
        );

        expect(
          Object.values(placed).map((places) => {
            return places.length === 1 ? 'one of them' : places;
          }),
          `${at}: where each OPEN was placed, ${JSON.stringify(placed)}`
        ).toEqual(
          openers.map(() => {
            return 'one of them';
          })
        );
      }

      if (expectation?.lives !== undefined) {
        expect(adapter.lives(), `${at}: the lives its adapter was asked`).toEqual(
          expectation.lives
        );
      }

      if (expectation?.closed !== undefined) {
        const deadline = Date.now() + within;
        const isTheirs = ({ address }: { address: string | undefined }): boolean => {
          return isClient || address === step.on;
        };

        while (!closes.some(isTheirs) && Date.now() < deadline) {
          await sleep(POLL);
        }

        const found = closes.findIndex(isTheirs);
        const [close] = found === -1 ? [] : closes.splice(found, 1);

        expect(
          close === undefined ? 'no close told' : { clean: close.wasClean },
          `${at}: the close told`
        ).toEqual(expectation.closed);
      }

      if (expectation?.opened !== undefined || expectation?.failed !== undefined) {
        const settled =
          connecting === undefined ? undefined : await settledWithin(connecting, within);
        const outcome = settled?.value;
        let seen: unknown = 'the connect did not settle';

        if (outcome !== undefined && 'value' in outcome) {
          seen = { opened: true };
        } else if (
          outcome !== undefined &&
          outcome.error instanceof ConnectError &&
          outcome.error.cause instanceof BrokerRefusedError
        ) {
          const { layouts, reason, status } = outcome.error.cause;

          seen = {
            failed: {
              ...(layouts === undefined ? {} : { layouts: [...layouts] }),
              reason,
              ...(status === undefined ? {} : { status }),
            },
          };
        } else if (outcome !== undefined) {
          seen = { error: String(outcome.error) };
        }

        expect(seen, `${at}: the connect`).toEqual(
          expectation.opened === undefined ? { failed: expectation.failed } : { opened: true }
        );
      }

      if (expectation?.received !== undefined) {
        const bytes = await nextOf(received, within);

        expect(
          bytes === undefined ? 'nothing received' : envelopeOf(bytes, expectation.received),
          `${at}: the envelope received`
        ).toEqual(expectation.received);
      }

      if (expectation?.secure !== undefined) {
        expect(client?.isSecure, `${at}: whether it is secure`).toBe(expectation.secure);
      }

      if (step.reported !== undefined) {
        const reported = await nextOf(errors, PATIENCE);
        const handle = reported?.connectionHandle ?? '';
        const isNamed = !isClient && step.on !== undefined;

        expect(reported, `${at}: a report`).toBeDefined();
        expect(isNamed ? addresses.get(handle) : handle, `${at}: the connection reported`).toBe(
          isNamed ? step.on : ''
        );

        for (const word of step.reported) {
          expect(reported?.error.message, `${at}: the report`).toContain(word);
        }
      }

      if (step.until !== undefined && 'timer' in step.until) {
        const { timer } = step.until;
        const isEarliest = (): boolean => {
          const [first, second] = duesOn(clock);

          return first === timer && second !== timer;
        };

        await pollWithinPatience(isEarliest);
        expect(
          isEarliest(),
          `${at}: the earliest timer armed, alone so due, among ${String(duesOn(clock))}`
        ).toBe(true);
      } else if (step.until !== undefined) {
        const { gauge, is } = step.until;
        const valueOf = (): number | undefined => {
          return gauge === 'unsettled'
            ? adapter.unsettled
            : server?.transport.gauges().counts[gauge];
        };

        await pollWithinPatience(() => {
          return valueOf() === is;
        });
        expect(valueOf(), `${at}: ${gauge}`).toBe(is);
      }

      if (step.advance !== undefined) {
        await clock.tickAsync(step.advance);
      }
    }

    expectNothingReported('at the end');
  } finally {
    await peers?.[Symbol.asyncDispose]();
    await twin?.[Symbol.asyncDispose]();
    await server?.[Symbol.asyncDispose]();
    await client?.[Symbol.asyncDispose]();
    await participant?.stop();
    await world[Symbol.asyncDispose]();
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

  test('reads each batch failure detail only where the case gives one', () => {
    const expected: IExpected[] = [
      { callId: 3, kind: 18, failure: { code: 1, scope: 0, relays: 0 } },
      { callId: 5, kind: 18, failure: { code: 1, scope: 0, relays: 0, detail: 'second' } },
    ];
    const entries: [number, string][] = [
      [3, 'first'],
      [5, 'second'],
    ];
    const pieces = entries.map(([callId, detail]) => {
      const bytes = writeEnvelope({
        header: { callId, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
        failure: { code: 1, scope: FailureScope.PROTOCOL, detail },
      });
      const length = Buffer.alloc(4);

      length.writeUInt32BE(bytes.length);

      return Buffer.concat([length, bytes]);
    });
    const batch = Buffer.concat(pieces);

    expect(batchOf(batch, expected)).toEqual(expected);

    // ! the second item's detail comes from its own bytes, not its expectation or its neighbour
    batch[batch.length - 1] = '!'.charCodeAt(0);
    expect(batchOf(batch, expected)).toEqual([
      expected[0],
      { ...expected[1], failure: { code: 1, scope: 0, relays: 0, detail: 'secon!' } },
    ]);
  });

  test('bounds default to what the file states', async () => {
    // the bound the WebSocket transport server takes when built alone and told none
    const fake = createFakeWebSocketServer();
    const wsTransport = createWSTransportServer({ WebSocketServer: fake.FakeWebSocketServer });
    const starting = wsTransport.start({ address: HOST, port: 4_321 });

    fake.instances[0]?.emit('listening');
    await starting;

    const built = fake.instances[0]?.options as { maxPayload?: number } | undefined;
    // and the unsent bytes it holds a socket to, read from its ceiling
    const { ceilings } = wsTransport.gauges();

    await wsTransport.stop();

    expect({
      bodyBytesBudget: BODY_BYTES_BUDGET,
      bodyGracePeriod: BODY_GRACE_PERIOD,
      connectionInactivityTimeout: CONNECTION_INACTIVITY_TIMEOUT,
      exchangeTimeout: EXCHANGE_TIMEOUT,
      headersTimeout: HEADERS_TIMEOUT,
      heartbeat: HEARTBEAT,
      inactivityTimeout: INACTIVITY_TIMEOUT,
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
      maximumConnections: MAXIMUM_CONNECTIONS,
      maximumConnectionsPerAddress: MAXIMUM_CONNECTIONS_PER_ADDRESS,
      maximumMessageBytes: built?.maxPayload,
      maximumOutboxBytes: MAXIMUM_OUTBOX_BYTES,
      maximumUnsentBytes: ceilings['largestUnsentBytes'],
      maximumWait: MAXIMUM_WAIT,
      maximumWaitingExchanges: MAXIMUM_WAITING_EXCHANGES,
      minimumBodyBytesPerSecond: MINIMUM_BODY_BYTES_PER_SECOND,
      minimumSendBytesPerSecond: MINIMUM_SEND_BYTES_PER_SECOND,
      sendGracePeriod: SEND_GRACE_PERIOD,
      acceptTimeout: ACCEPT_TIMEOUT,
      maximumEnvelopePartsBytes: MAXIMUM_ENVELOPE_PARTS_BYTES,
      heldBytesBudget: HELD_BYTES_BUDGET,
    }).toEqual(TRANSPORTS.defaults);
    expect(MAXIMUM_UNSENT_BYTES).toBe(TRANSPORTS.defaults['maximumUnsentBytes']);
  });

  for (const { body, fields, name, pieces, status } of TRANSPORTS.responses) {
    test(`reads ${name}, by its length or de-chunked, whatever reads it comes in`, async () => {
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

    if (transport === 'broker') {
      test(name, async () => {
        await playBrokerCase(testCase, { transport });
      });

      continue;
    }

    // played apart, one at a time, against a broker of the run's own
    if (transport === 'mqtt' || transport === 'amqp') {
      continue;
    }

    test(name, async () => {
      expect(
        Object.keys(testCase).filter((key) => {
          return !CASE_KEYS.has(key);
        }),
        'the keys of the case this harness does not read'
      ).toEqual([]);

      // the clock every layer runs on: only a step that moves time moves it; a platform's own timers,
      // a ping's among them, stay on the real clock
      const clock = createTestClock(Date.parse(TRANSPORTS.wallClock));
      const server = serverOf(testCase, clock);
      const { port, refusals, reports } = await serve(server);
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
      // the handle an exchange's connection has on the server: the one it holds from the port the
      // exchange's socket came from, as the C# side finds it
      const handleOf = (on: string, at: string): TransportServerConnectionHandle => {
        const { localPort } = exchangeOf(on, at);
        const held = server.transport.clients.find(({ port: peerPort }) => {
          return peerPort === localPort;
        });

        if (localPort === undefined || held === undefined) {
          throw new Error(`${at}: the exchange ${on} names no connection the server holds`);
        }

        return held.connectionHandle;
      };
      // what the server reported, or told of a refusal, that its case did not expect: nothing,
      // between steps
      const expectNothingReported = (when: string): void => {
        expect(reports, when).toEqual([]);
        expect(refusals, `${when}: the refusals told`).toEqual([]);
      };

      try {
        for (const [index, step] of steps.entries()) {
          const at = `step ${String(index + 1)}`;
          const timing: ITiming = {
            after: step.after,
            startedAt: performance.now(),
            within: step.within,
          };

          expect(
            Object.keys(step).filter((key) => {
              return !STEP_KEYS.has(key);
            }),
            `${at}: the keys this harness does not read`
          ).toEqual([]);
          // a step is one act, on the exchange and within the times it may name: one that holds a
          // second act fails, never passes with it left unplayed
          expect(
            Object.keys(step).filter((key) => {
              return key !== 'on' && key !== 'within' && key !== 'after';
            }),
            `${at}: the acts it holds`
          ).toHaveLength(1);

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
              { at, exchange: exchangeOf(step.on, at), timing },
              { expectation: step.expect, refusals, values }
            );
          } else if (step.expect !== undefined) {
            await expectHeard({ at, exchange: exchangeOf(step.on, at), timing }, step.expect);
          }

          if (step.until !== undefined && 'timer' in step.until) {
            const { timer } = step.until;
            // ! the earliest timer live, and the only one so due: one armed before it and not yet
            // cleared, on the server's threads, would fire first as the clock advances
            const isEarliest = (): boolean => {
              const [first, second] = duesOn(clock);

              return first === timer && second !== timer;
            };

            await pollWithinPatience(isEarliest);
            expect(
              isEarliest(),
              `${at}: the earliest timer armed, alone so due, among ${String(duesOn(clock))}`
            ).toBe(true);
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

  test('plays every case but those a row of the support matrix excuses this side from', () => {
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

test.describe('the transports, over MQTT 5', () => {
  // * one case at a time: each case's participant under test has the same id, and two links of one
  // id take each other over (spec 15.21)
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 30_000 });

  for (const testCase of TRANSPORTS.cases) {
    if (testCase.transport !== 'mqtt' || isExcused(testCase)) {
      continue;
    }

    test(testCase.name, async () => {
      test.skip(MQTT_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
      expect(MQTT_URL, NO_BROKER).toBeDefined();
      await playBrokerCase(testCase, { transport: 'mqtt' });
    });
  }
});

test.describe('the transports, over AMQP 1.0', () => {
  // * one case at a time: each case's participant under test has the same id, and a second link of
  // one id is refused its inbox while the first holds it (spec 15.33)
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 30_000 });

  for (const testCase of TRANSPORTS.cases) {
    if (testCase.transport !== 'amqp' || isExcused(testCase)) {
      continue;
    }

    test(testCase.name, async () => {
      test.skip(AMQP_URL === undefined && !IS_AMQP_REQUIRED, NO_AMQP_BROKER);
      expect(AMQP_URL, NO_AMQP_BROKER).toBeDefined();
      await playBrokerCase(testCase, { transport: 'amqp' });
    });
  }
});
