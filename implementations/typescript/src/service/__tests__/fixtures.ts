// ── Fixtures ──────────────────────────────────────────────────────────────────

// A service of every kind of call, and a server in a worker's scope with a client to it, which the
// service layer's tests serve and call; a service with deprecated procedures, and the lint that
// finds their uses.

// dependencies

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

/** The package's folder, where oxlint finds the `tsconfig.json` that types the uses. */
const PACKAGE = fileURLToPath(new URL('../../../', import.meta.url));

/** oxlint's entry, run through Node: the `.bin` entry is a shell shim. */
const OXLINT = fileURLToPath(new URL('../../../node_modules/oxlint/bin/oxlint', import.meta.url));

/** `typescript/no-deprecated` alone, type-aware. */
const NO_DEPRECATED = fileURLToPath(new URL('no-deprecated.oxlintrc.json', import.meta.url));

/** The directive a use the lint must flag carries. */
const DIRECTIVE = '// oxlint-disable-next-line typescript/no-deprecated --';

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

// ! the archive's literal stands apart from its freeze: one written inside `Object.freeze` is a use
// of each of its members to the lint, @deprecated or not
const archive = {
  fetch: requestOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 1, procedureName: 'fetch', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  /** @deprecated Use fetch. */
  fetchAll: requestOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 2, procedureName: 'fetchAll', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  follow: requestOf({
    admission: 'none',
    failures: {},
    notification: text,
    procedure: { procedureId: 3, procedureName: 'follow', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  /** @deprecated Use follow. */
  watch: requestOf({
    admission: 'none',
    failures: {},
    notification: text,
    procedure: { procedureId: 4, procedureName: 'watch', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  ping: commandOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 5, procedureName: 'ping', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
  /** @deprecated */
  poke: commandOf({
    admission: 'none',
    failures: {},
    procedure: { procedureId: 6, procedureName: 'poke', serviceId: 8, serviceRevision: 1 },
    request: text,
    result: text,
  }),
};

/**
 * The archive: a request, one that notifies and a command, each beside its deprecated twin, which
 * names its replacement or none. Only the lint reads it: `deprecated-client-uses.ts` and
 * `deprecated-server-uses.ts` use it through the service layer.
 */
export const ArchiveProcedures = Object.freeze(archive);

// definition

/**
 * What `typescript/no-deprecated`, alone and type-aware, reports in `fixture`, a file of this
 * folder, every disable directive bound to be used: none, when the uses its directives mark are
 * the deprecated ones, each and no other. With the directives the file holds and the files linted,
 * so that a lint of nothing never reads as clean.
 */
export const deprecationsIn = async (
  fixture: string
): Promise<{ directives: number; files: number; reports: readonly string[] }> => {
  const file = fileURLToPath(new URL(fixture, import.meta.url));
  const args = [
    OXLINT,
    '--type-aware',
    '-c',
    NO_DEPRECATED,
    '--disable-nested-config',
    '--report-unused-disable-directives-severity=error',
    '-f',
    'json',
    file,
  ];
  // ! oxlint exits 1 on what it reports, so a failed run is read too; one that never started throws
  const output = await promisify(execFile)(process.execPath, args, { cwd: PACKAGE }).then(
    ({ stdout }) => {
      return stdout;
    },
    (error: unknown) => {
      const { code, stdout } = error as { code?: unknown; stdout?: string };

      if (typeof code !== 'number' || stdout === undefined) {
        throw error as Error;
      }

      return stdout;
    }
  );
  const report = JSON.parse(output.slice(output.indexOf('{'))) as {
    diagnostics: readonly {
      labels?: readonly { span: { line: number } }[];
      message: string;
    }[];
    number_of_files: number;
  };

  return {
    directives: readFileSync(file, 'utf8').split(DIRECTIVE).length - 1,
    files: report.number_of_files,
    reports: report.diagnostics.map(({ labels, message }) => {
      return `${String(labels?.[0]?.span.line)}: ${message}`;
    }),
  };
};

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
