// ── Interop ───────────────────────────────────────────────────────────────────

// Bead's TypeScript client against the C# server of the interop service, over WebSocket and over
// HTTP: the same procedures, the same failures, the same cancel. It builds and starts a .NET program:
// where .NET is not installed, it is skipped, saying so, or fails where `BEAD_INTEROP_REQUIRED=1`.

// dependencies

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { JSON_SERIALIZER, offerInteropClient, procedureOf } from '../../../interop/offer';
import type { FetchLike } from '../../transport/client/types';
import { noop } from '../../transport/shared/noop';
import { createHTTPClient, type HTTPClient } from '../http-client';
import {
  CancelError,
  createWSClient,
  FailureScope,
  ProtocolCode,
  TimeoutError,
  type WSClient,
} from '../ws-client';

// interfaces

/** Where the C# server listens: over WebSocket, and over HTTP. */
interface IPorts {
  httpPort: number;
  port: number;
}

// constants

// the C# side, found from the repository's root, the directory up from this test that holds
// spec/spec.md, as the C# side finds this one
const DOTNET = ((): string => {
  for (let directory = new URL('./', import.meta.url); ; directory = new URL('../', directory)) {
    if (existsSync(new URL('spec/spec.md', directory))) {
      return fileURLToPath(new URL('implementations/dotnet/', directory));
    }

    if (new URL('../', directory).href === directory.href) {
      throw new Error('no spec/spec.md above this test');
    }
  }
})();

const HOST = '127.0.0.1';

/** Whether .NET answers, to build and start the C# server. */
const HAS_DOTNET = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;

/** Whether the interop must run: a path to the other side gone wrong then fails, not skips. */
const REQUIRED = process.env['BEAD_INTEROP_REQUIRED'] === '1';

const SLOW = { milliseconds: 3_600_000 };

/** Each transport the C# server is called over: its client, its port, and whether it carries transfers. */
const TRANSPORTS = [
  {
    carriesTransfers: true,
    create: (): HTTPClient | WSClient => {
      return createWSClient();
    },
    label: 'WebSocket',
    portOf: ({ port }: IPorts) => {
      return port;
    },
  },
  {
    carriesTransfers: false,
    create: (): HTTPClient | WSClient => {
      return createHTTPClient({ transport: { fetch: fetchInOrder() } });
    },
    label: 'HTTP',
    portOf: ({ httpPort }: IPorts) => {
      return httpPort;
    },
  },
] as const;

// helpers

/**
 * A fetch that sends an envelope only once the server said it had the one before — its head came
 * back (section 15.7) — as a socket keeps them in order: a cancel never overtakes its request, which
 * the server would bury unseen.
 */
const fetchInOrder = (): FetchLike => {
  let before: Promise<unknown> = Promise.resolve();

  return (url, init) => {
    if (init.body === undefined) {
      return (globalThis.fetch as FetchLike)(url, init);
    }

    const sent = before.then(() => {
      return (globalThis.fetch as FetchLike)(url, init);
    });

    before = sent.catch(noop);

    return sent;
  };
};

/** The ports a line of the server says it listens on: `{"port":n,"httpPort":m}`; none for any other line. */
const portsOfLine = (line: string): IPorts | undefined => {
  try {
    const { httpPort, port } = JSON.parse(line) as { httpPort?: unknown; port?: unknown };

    return typeof port === 'number' && typeof httpPort === 'number'
      ? { httpPort, port }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The C# interop server, started, and the ports it says it listens on: what `dotnet run` writes
 * first, as it builds, comes before.
 */
const startServer = async (): Promise<{
  ports: IPorts;
  server: ChildProcessWithoutNullStreams;
}> => {
  const server = spawn('dotnet', ['run', '--project', 'interop/Bead.Interop.Server'], {
    cwd: DOTNET,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.pipe(process.stderr);

  for await (const line of createInterface({ input: server.stdout })) {
    const ports = portsOfLine(line);

    if (ports !== undefined) {
      return { ports, server };
    }
  }

  throw new Error('the C# interop server ended before it said its port');
};

// definition

test.describe('the C# server of the interop service', () => {
  test.skip(
    !HAS_DOTNET && !REQUIRED,
    'it builds and starts a .NET program, and .NET is not installed'
  );
  test.describe.configure({ mode: 'serial' });

  let ports: IPorts;
  let server: ChildProcessWithoutNullStreams | undefined;

  test.beforeAll(async () => {
    // the first run builds the server
    test.setTimeout(180_000);

    if (!HAS_DOTNET) {
      throw new Error('BEAD_INTEROP_REQUIRED=1 asks for the interop, and .NET is not installed');
    }

    ({ ports, server } = await startServer());
  });

  test.afterAll(async () => {
    // a server that never started has nothing to stop
    if (server === undefined) {
      return;
    }

    const exited = once(server, 'exit');

    server.stdin.end();
    await exited;
  });

  for (const { carriesTransfers, create, label, portOf } of TRANSPORTS) {
    test.describe(`over ${label}`, () => {
      let client: HTTPClient | WSClient;

      /** The requester of `procedureName`, on the client's connection, its payloads JSON. */
      const requesterOf = (procedureName: string) => {
        return client.services.getRequest(procedureOf(procedureName), {
          serializer: JSON_SERIALIZER,
        });
      };

      /** The calls to slow the connection cancelled, once the server counted `count` of them. */
      const cancellationsReaching = async (count: number): Promise<unknown> => {
        for (let tries = 0; tries < 40; tries += 1) {
          const counted = await requesterOf('cancellations')(null)();

          if (counted === count) {
            return counted;
          }

          await sleep(50);
        }

        return requesterOf('cancellations')(null)();
      };

      test.beforeEach(async () => {
        client = create();
        await client.connect({ host: HOST, port: portOf(ports) });
      });

      test.afterEach(async () => {
        await client[Symbol.asyncDispose]();
      });

      test("echo answers with its request's payload", async () => {
        await expect(requesterOf('echo')({ a: [1, 'two', null] })()).resolves.toEqual({
          a: [1, 'two', null],
        });
      });

      test('bytes answers a string of the length asked', async () => {
        await expect(requesterOf('bytes')({ length: 1_000 })()).resolves.toBe('x'.repeat(1_000));
      });

      test('fail answers with its own failure, raised by the server', async () => {
        await expect(requesterOf('fail')(null)()).rejects.toMatchObject({
          code: 7,
          detail: 'this procedure fails, on purpose',
          origin: 'peer',
          scope: FailureScope.APPLICATION,
          side: 'server',
        });
      });

      test('a procedure unknown, and a service unknown, are refused as the protocol says', async () => {
        const unknown = { ...procedureOf('echo'), procedureId: 99 };
        const elsewhere = { ...procedureOf('echo'), serviceId: 9 };

        await expect(
          client.services.getRequest(unknown, { serializer: JSON_SERIALIZER })(null)()
        ).rejects.toMatchObject({
          code: ProtocolCode.PROCEDURE_UNKNOWN,
          scope: FailureScope.PROTOCOL,
        });
        await expect(
          client.services.getRequest(elsewhere, { serializer: JSON_SERIALIZER })(null)()
        ).rejects.toMatchObject({
          code: ProtocolCode.SERVICE_UNKNOWN,
          scope: FailureScope.PROTOCOL,
        });
      });

      test('an admission that refuses, a resolver that throws, and a payload that is not JSON', async () => {
        const notJson = {
          ...JSON_SERIALIZER,
          encode: () => {
            return new Uint8Array([0xff]);
          },
        };

        await expect(requesterOf('denied')(null)()).rejects.toMatchObject({
          code: ProtocolCode.ACCESS_DENIED,
          detail: 'this procedure admits nobody',
        });
        await expect(requesterOf('broken')(null)()).rejects.toMatchObject({
          code: ProtocolCode.PROCEDURE_FAILED,
        });
        await expect(
          client.services.getRequest(procedureOf('echo'), { serializer: notJson })(null)()
        ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
      });

      test('a call cancelled by its signal is cancelled at the server too', async () => {
        const controller = new AbortController();
        const slow = requesterOf('slow')(SLOW)({ signal: controller.signal });

        // a call after it answered: the server has it, where its cancel must find it — by the
        // socket's order, or by the fetch's
        await requesterOf('echo')(null)();
        controller.abort();
        await expect(slow).rejects.toBeInstanceOf(CancelError);
        await expect(cancellationsReaching(1)).resolves.toBe(1);
      });

      test('a call past its timeout is cancelled at the server too', async () => {
        await expect(requesterOf('slow')(SLOW)({ timeout: 200 })).rejects.toBeInstanceOf(
          TimeoutError
        );
        await expect(cancellationsReaching(1)).resolves.toBe(1);
      });

      test('the server asks the command its client offers, and answers with what it answered', async () => {
        offerInteropClient(client.services);

        await expect(requesterOf('ask')(null)()).resolves.toBe('noon');
      });

      test('a subscription hears each tick, then a paced one each tick its callbacks settled', async () => {
        const serializer = { ...JSON_SERIALIZER, decodeNotification: JSON_SERIALIZER.decode };
        const heard: unknown[] = [];
        const ticks = client.services.getNotification(procedureOf('ticks'), { serializer });
        const registration = await ticks(null, (value) => {
          heard.push(value);
        })();

        await requesterOf('tick')({ value: 1 })();
        await requesterOf('tick')({ value: 2 })();
        await expect
          .poll(() => {
            return heard;
          })
          .toEqual([1, 2]);
        await registration.unregister();
      });

      test('a paced subscription waits for its callback to settle before the next comes', async () => {
        const serializer = { ...JSON_SERIALIZER, decodeNotification: JSON_SERIALIZER.decode };
        const heard: unknown[] = [];
        const holding = Promise.withResolvers<void>();
        const ticks = client.services.getNotification(procedureOf('ticks'), {
          serializer,
          window: 1,
        });
        const registration = await ticks(null, (value) => {
          heard.push(value);

          return heard.length === 1 ? holding.promise : undefined;
        })();

        await requesterOf('tick')({ value: 1 })();
        await requesterOf('tick')({ value: 2 })();
        await expect
          .poll(() => {
            return heard;
          })
          .toEqual([1]);
        await sleep(100);
        expect(heard).toEqual([1]);
        holding.resolve();
        await expect
          .poll(() => {
            return heard;
          })
          .toEqual([1, 2]);
        await registration.unregister();
      });

      test('a session opened is learned from its answer, and its end too', async () => {
        await expect(requesterOf('whoami')(null)()).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
        });
        await expect(requesterOf('login')({ name: 'ada' })()).resolves.toBe('ada');
        expect(client.router.sessionToken).toMatch(/^[\w-]{22}$/);
        await expect(requesterOf('whoami')(null)()).resolves.toBe('ada');
        await expect(requesterOf('logout')(null)()).resolves.toBeNull();
        expect(client.router.sessionToken).toBeUndefined();
      });

      // HTTP carries no transfer: a payload is what one envelope holds
      if (carriesTransfers) {
        test('a payload that goes as a transfer comes back as one, and so does a result too large for one envelope', async () => {
          const long = 'x'.repeat(3 * 1_048_576);
          const echoed = await requesterOf('echo')(long)();
          const sent = await requesterOf('bytes')({ length: 3 * 1_048_576 })();

          // compared, not diffed: three mebibytes would bury a failure
          expect(echoed === long).toBe(true);
          expect(sent === long).toBe(true);
        });
      }
    });
  }
});
