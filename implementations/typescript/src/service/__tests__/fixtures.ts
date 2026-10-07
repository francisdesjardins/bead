// ── Fixtures ──────────────────────────────────────────────────────────────────

// A service of every kind of call, and a server in a worker's scope with a client to it, which the
// service layer's tests serve and call.

// dependencies

import { createWorkerClient } from '../../client/worker-client';
import type { IMetricsRegistry } from '../../router/shared/metrics-registry';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import { expectAtRest } from '../../server/__tests__/fixtures';
import { createWorkerServer } from '../../server/worker-server';
import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { commandOf, requestOf } from '../descriptors';
import { failuresOf } from '../failures';

// constants

/** The worker's one connection, as its server names it. */
export const CONNECTION: TransportServerConnectionHandle = 'type=WORKER;ip=local;ordinal=1';

const { text } = PAYLOAD_CODECS;

/** The greeter's failures: service 7's catalogue. */
export const GreeterFailures = failuresOf({
  codes: { NOBODY_TO_GREET: 1, TOO_LOUD: 2 },
  serviceId: 7,
});

/**
 * The greeter: a request, one that notifies, one in a session, one behind a hook, one that opens a
 * session, and two commands, one in a session.
 */
export const GreeterProcedures = Object.freeze({
  clock: commandOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 9, procedureName: 'clock', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  guarded: commandOf({
    admission: 'session',
    failures: {},
    procedure: { procedureId: 10, procedureName: 'guarded', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  login: requestOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 5, procedureName: 'login', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  news: requestOf({
    admission: 'none',
    failures: {},
    notification: text,
    procedure: { procedureId: 2, procedureName: 'news', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  sayHello: requestOf({
    admission: 'none',
    failures: { NOBODY_TO_GREET: 1 },
    procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  shout: requestOf({
    admission: { hook: 'loud' },
    failures: {},
    procedure: { procedureId: 4, procedureName: 'shout', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  whoami: requestOf({
    admission: 'session',
    failures: {},
    procedure: { procedureId: 3, procedureName: 'whoami', serviceId: 7, serviceRevision: 1 },
    request: text,
    result: text,
  }),
});

// definition

/**
 * A server in a worker's scope — a port of a `MessageChannel` — of `string` sessions, and a client
 * to it through the other end, both started; `await using` takes them apart once the server keeps
 * nothing.
 */
export const connectWorker = async (options: { metricsRegistry?: IMetricsRegistry } = {}) => {
  const scope = new MessageChannel();
  const server = createWorkerServer<string>({
    metricsRegistry: options.metricsRegistry,
    transport: { scope: scope.port1 },
  });
  const client = createWorkerClient({
    transport: {
      worker: {
        postMessage: (message, transfer) => {
          scope.port2.postMessage(message, transfer as Transferable[]);
        },
      },
    },
  });

  scope.port1.start();
  await server.transport.start();
  await client.connect({});

  return {
    client,
    server,
    [Symbol.asyncDispose]: async () => {
      await client[Symbol.asyncDispose]();
      await expectAtRest(server);
      await server[Symbol.asyncDispose]();
      scope.port1.close();
      scope.port2.close();
    },
  };
};
