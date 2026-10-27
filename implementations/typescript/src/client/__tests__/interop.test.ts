// ── Interop ───────────────────────────────────────────────────────────────────

// Bead's TypeScript client against the C# server of the interop service, over WebSocket, HTTP and
// MQTT 5: the same procedures, failures and cancel. Without .NET, or without a broker
// (`BEAD_MQTT_URL`), it is skipped, saying so, or fails where `BEAD_INTEROP_REQUIRED=1` or
// `BEAD_MQTT_REQUIRED=1`.

// dependencies

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { WebSocket as WsWebSocket } from 'ws';
import { INTEROP_SERVICE } from '../../../interop/credentials';
import { InteropClient, InteropProcedures } from '../../../interop/generated/interop_bead';
import { offerInteropClient } from '../../../interop/handlers';
import { PAYLOAD_CODECS } from '../../router/shared/payloads';
import type { BrokerTransportClient, FetchLike } from '../../transport/client/types';
import { createLinkRelay, type ILinkRelay } from '../../transport/server/__tests__/link-relay';
import { ParcelKind, readParcel } from '../../transport/shared/broker-parcel';
import {
  createBrokerParticipant,
  type IBrokerParticipant,
} from '../../transport/shared/broker-participant';
import { createMqttBrokerAdapter } from '../../transport/shared/mqtt-broker-adapter';
import { noop } from '../../transport/shared/noop';
import type { IBrokerAdapter } from '../../transport/shared/types';
import { createClient } from '../client';
import type { IClient } from '../types';
import { TranscodingHttpClient } from '../../transcoding/__tests__/generated/bead_http';
import { startTranscoding } from '../../transcoding/__tests__/transcoding-service';
import { createHTTPClient, type HTTPClient } from '../http-client';
import {
  CancelError,
  createWSClient,
  CredentialScheme,
  FailureScope,
  ProtocolCode,
  TimeoutError,
  type WSClient,
} from '../ws-client';

// interfaces

/** Where the C# server listens: over WebSocket, HTTP and the HTTP/JSON gateway. */
interface IPorts {
  gatewayPort: number;
  httpPort: number;
  port: number;
}

/**
 * The participant the TypeScript client links over MQTT 5 by, through a relay of the test's own
 * that a cut ends, its adapter wrapped so that a test has it publish each parcel twice, and the
 * ACCEPTs it read for an opener's half it had read one for already.
 */
interface IMqttLink {
  acceptedTwice: number;
  isCopying: boolean;
  readonly participant: IBrokerParticipant;
  readonly relay: ILinkRelay;
}

// types

/** A client the interop's cases call through, whichever its transport. */
type InteropTransportClient = HTTPClient | IClient<BrokerTransportClient> | WSClient;

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

/**
 * An access token of the interop service's HS256 issuer for `sub`, holding an hour on the platform's
 * clock, signed with its published test key: the server verifies it with the same.
 */
const interopTokenOf = (sub: string): string => {
  const key = INTEROP_SERVICE.credentials.jwt.keys.find(({ algorithm }) => {
    return algorithm === 'HS256';
  });
  const part = (value: object): string => {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  };
  const now = Math.floor(Date.now() / 1_000);
  const signingInput = `${part({ alg: 'HS256', typ: 'at+jwt' })}.${part({
    aud: INTEROP_SERVICE.credentials.jwt.audience,
    client_id: 'bead-interop-client',
    exp: now + 3_600,
    iat: now,
    iss: key?.issuer,
    jti: 'at-interop-0001',
    sub,
  })}`;
  const signature = createHmac('sha256', Buffer.from(key?.jwk.k ?? '', 'base64url'))
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
};

/** Whether the interop must run: a path to the other side gone wrong then fails, not skips. */
/** How long a stream waits for its place, in milliseconds: the gateway keeps one stream an address. */
const PATIENCE = 10_000;

const REQUIRED = process.env['BEAD_INTEROP_REQUIRED'] === '1';

// the broker the MQTT 5 cases call through, where one is given, and the run's password
const MQTT_URL = process.env['BEAD_MQTT_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';

const SLOW = { milliseconds: 3_600_000 };

// the link of the TypeScript client over MQTT 5, while its cases run
let mqttLink: IMqttLink | undefined;

/**
 * Each transport the C# server is called over: its client, how it connects to the C# server,
 * whether it carries transfers, and whether it plays here.
 */
const TRANSPORTS = [
  {
    carriesTransfers: true,
    connect: (client: InteropTransportClient, ports: IPorts): Promise<void> => {
      return (client as WSClient).connect({ host: HOST, port: ports.port });
    },
    create: (): InteropTransportClient => {
      return createWSClient();
    },
    label: 'WebSocket',
    skipped: undefined,
  },
  {
    carriesTransfers: false,
    connect: (client: InteropTransportClient, ports: IPorts): Promise<void> => {
      return (client as HTTPClient).connect({ host: HOST, port: ports.httpPort });
    },
    create: (): InteropTransportClient => {
      return createHTTPClient({ transport: { fetch: fetchInOrder() } });
    },
    label: 'HTTP',
    skipped: undefined,
  },
  {
    carriesTransfers: true,
    connect: (client: InteropTransportClient): Promise<void> => {
      return (client as IClient<BrokerTransportClient>).connect({ server: 'interop-cs' });
    },
    create: (): InteropTransportClient => {
      if (mqttLink === undefined) {
        throw new Error('no link over MQTT 5');
      }

      return createClient({ transport: mqttLink.participant.transportClient() });
    },
    label: 'MQTT 5',
    skipped: MQTT_URL === undefined && !IS_MQTT_REQUIRED ? NO_BROKER : undefined,
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
    const { gatewayPort, httpPort, port } = JSON.parse(line) as {
      gatewayPort?: unknown;
      httpPort?: unknown;
      port?: unknown;
    };

    return typeof port === 'number' &&
      typeof httpPort === 'number' &&
      typeof gatewayPort === 'number'
      ? { gatewayPort, httpPort, port }
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

/**
 * The TypeScript client's link over MQTT 5: its participant `ts-client`, started through a relay of
 * the test's own, its adapter wrapped to publish each parcel twice while `isCopying`, and every
 * ACCEPT it reads for a half it read one for already counted.
 */
const startMqttLink = async (url: string): Promise<IMqttLink> => {
  const broker = new URL(url);
  const relay = await createLinkRelay({ host: broker.hostname, port: Number(broker.port) });
  const adapter = createMqttBrokerAdapter({
    id: 'ts-client',
    password: MQTT_PASSWORD,
    url: `${broker.protocol}//${HOST}:${String(relay.port)}`,
  });
  const answered = new Set<string>();
  const copying = Object.assign(Object.create(adapter) as IBrokerAdapter, {
    publish: (publication: Parameters<IBrokerAdapter['publish']>[0]) => {
      if (link.isCopying) {
        void adapter.publish(publication).catch(noop);
      }

      return adapter.publish(publication);
    },
  });
  const participant = createBrokerParticipant({ adapter: copying, reconnect: { delay: 100 } });
  const link: IMqttLink = { acceptedTwice: 0, isCopying: false, participant, relay };

  // * an ACCEPT for an opener's half it read one for already: a second member of a group, or a
  // second group, handed the OPEN
  adapter.on('message', ({ payload, topic }) => {
    const read = readParcel(payload);

    if (topic[1] !== 'i' || !('parcel' in read) || read.parcel.kind !== ParcelKind.ACCEPT) {
      return;
    }

    const half = Buffer.from(read.parcel.opener).toString('hex');

    link.acceptedTwice += answered.has(half) ? 1 : 0;
    answered.add(half);
  });
  await participant.start();

  return link;
};

/** The TypeScript interop server, started over MQTT 5 beside the C# one, its first line read. */
const startTypeScriptServer = async (): Promise<ChildProcessWithoutNullStreams> => {
  const server = spawn(process.execPath, ['interop/serve.ts'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.pipe(process.stderr);

  for await (const line of createInterface({ input: server.stdout })) {
    if (portsOfLine(line) !== undefined) {
      return server;
    }
  }

  throw new Error('the TypeScript interop server ended before it said its port');
};

const isCapacityExceeded = (reason: unknown): boolean => {
  return (reason as { code?: unknown } | undefined)?.code === ProtocolCode.CAPACITY_EXCEEDED;
};

const pause = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

// * a stream's end, once the gateway frees the place the test before held: busy before any entry, it goes again
const failureOnceAdmitted = async (stream: () => Promise<void>): Promise<unknown> => {
  const since = performance.now();

  for (;;) {
    const failure = await stream().then(
      () => {
        return new Error('the stream ended with no failure');
      },
      (reason: unknown) => {
        return reason;
      }
    );

    if (!isCapacityExceeded(failure) || performance.now() - since > PATIENCE) {
      return failure;
    }

    await pause(50);
  }
};

// a stream's first entry, once the gateway has its place, as failureOnceAdmitted waits for it
const openedOnceAdmitted = async <T>(
  open: () => AsyncIterator<T>
): Promise<{ first: IteratorResult<T>; iterator: AsyncIterator<T> }> => {
  const since = performance.now();

  for (;;) {
    const iterator = open();

    try {
      return { first: await iterator.next(), iterator };
    } catch (reason) {
      if (!isCapacityExceeded(reason) || performance.now() - since > PATIENCE) {
        throw reason;
      }

      await iterator.return?.();
      await pause(50);
    }
  }
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

  test('calls the other gateway with protobuf JSON and every native encoding', async () => {
    const client = new TranscodingHttpClient(`http://${HOST}:${String(ports.gatewayPort)}`);

    expect(await client.getBook({ name: 'shelves/a/books/b', revision: 7n })).toMatchObject({
      name: 'shelves/a/books/b',
      pages: 7n,
      title: 'A tale',
    });
    expect(await client.text('Ada\r\nJosé')).toBe('Ada\r\nJosé');
    expect(await client.raw(Uint8Array.of(0, 127, 255))).toEqual(Uint8Array.of(0, 127, 255));
    expect(await client.json({ z: [true, null], a: 'José' })).toEqual({
      a: 'José',
      z: [true, null],
    });
  });

  test('reads the other gateway problems and presents its authorization', async () => {
    const client = new TranscodingHttpClient(`http://${HOST}:${String(ports.gatewayPort)}`);

    await expect(client.fail({ detail: 'by choice' })).rejects.toMatchObject({
      code: 1,
      scope: FailureScope.APPLICATION,
      detail: 'by choice',
    });
    await expect(client.whoAmI({})).rejects.toMatchObject({
      code: ProtocolCode.SESSION_REQUIRED,
      scope: FailureScope.PROTOCOL,
    });
    expect(await client.whoAmI({}, { authorization: 'Bearer good' })).toMatchObject({
      session: 'ada',
    });
  });

  test('reads the other gateway result notifications and ending failure', async () => {
    const client = new TranscodingHttpClient(`http://${HOST}:${String(ports.gatewayPort)}`);
    const received: { kind: string; value: number }[] = [];

    const failure = await failureOnceAdmitted(async () => {
      received.length = 0;

      for await (const entry of client.subscribeTicks({ from: 2 })) {
        received.push({
          kind: entry.kind,
          value: entry.kind === 'result' ? entry.value.ticks : entry.value.remaining,
        });
      }
    });

    expect(failure).toMatchObject({ code: 2, scope: FailureScope.APPLICATION });
    expect(received).toEqual([
      { kind: 'result', value: 2 },
      { kind: 'notification', value: 1 },
      { kind: 'notification', value: 0 },
    ]);
  });

  test('reads the other gateway own route size and busy refusals', async () => {
    const url = `http://${HOST}:${String(ports.gatewayPort)}`;
    const missing = new TranscodingHttpClient(`${url}/missing`);
    await expect(missing.json(null)).rejects.toMatchObject({
      code: ProtocolCode.DESTINATION_UNREACHABLE,
      origin: 'peer',
      detail: 'the HTTP call answers 404; a path no route matches',
    });
    const client = new TranscodingHttpClient(url);
    await expect(client.text('x'.repeat(1025))).rejects.toMatchObject({
      code: ProtocolCode.PAYLOAD_TOO_LARGE,
      origin: 'peer',
    });
    const { first, iterator } = await openedOnceAdmitted(() => {
      return client.subscribeWatch({})[Symbol.asyncIterator]();
    });
    try {
      expect(first).toMatchObject({ done: false, value: { kind: 'result' } });
      await expect(async () => {
        for await (const event of client.subscribeWatch({})) {
          void event;
        }
      }).rejects.toMatchObject({
        code: ProtocolCode.CAPACITY_EXCEEDED,
        origin: 'peer',
        detail: expect.stringContaining('the HTTP call answers 503; Retry-After: 1;'),
      });
    } finally {
      await iterator.return?.();
    }
  });

  test('compares the gateways OpenAPI documents byte for byte', async () => {
    await using local = await startTranscoding();
    const remote = await fetch(`http://${HOST}:${String(ports.gatewayPort)}/openapi.json`);
    const own = await fetch(`http://${HOST}:${String(local.port)}/openapi.json`);

    expect(remote.status).toBe(200);
    expect(own.status).toBe(200);
    expect(Buffer.from(await remote.arrayBuffer())).toEqual(Buffer.from(await own.arrayBuffer()));
  });

  for (const { carriesTransfers, connect, create, label, skipped } of TRANSPORTS) {
    test.describe(`over ${label}`, () => {
      // the TypeScript server, beside the C# one, of the name both serve in a group
      let typeScriptServer: ChildProcessWithoutNullStreams | undefined;

      test.skip(skipped !== undefined, skipped);

      if (label === 'MQTT 5') {
        test.beforeAll(async () => {
          test.setTimeout(60_000);
          expect(MQTT_URL, NO_BROKER).toBeDefined();
          mqttLink = await startMqttLink(MQTT_URL ?? '');
          typeScriptServer = await startTypeScriptServer();
        });

        test.afterAll(async () => {
          await mqttLink?.participant.stop();
          await mqttLink?.relay[Symbol.asyncDispose]();
          mqttLink = undefined;

          if (typeScriptServer !== undefined) {
            const exited = once(typeScriptServer, 'exit');

            typeScriptServer.stdin.end();
            await exited;
          }
        });
      }

      let client: InteropTransportClient;
      // the interop service's client side, made once a test, unpaced unless the test made it first
      let made: InteropClient | undefined;

      /** The interop service's client side over the client's connection. */
      const interop = (): InteropClient => {
        made ??= new InteropClient(client);

        return made;
      };

      /** The calls to slow the connection cancelled, once the server counted `count` of them. */
      const cancellationsReaching = async (count: number): Promise<unknown> => {
        for (let tries = 0; tries < 40; tries += 1) {
          const counted = await interop().cancellations(null)();

          if (counted === count) {
            return counted;
          }

          await sleep(50);
        }

        return interop().cancellations(null)();
      };

      test.beforeEach(async () => {
        client = create();
        made = undefined;
        await connect(client, ports);
      });

      test.afterEach(async () => {
        await client[Symbol.asyncDispose]();
      });

      test("echo answers with its request's payload", async () => {
        await expect(interop().echo({ a: [1, 'two', null] })()).resolves.toEqual({
          a: [1, 'two', null],
        });

        // and its bytes as the other side wrote them, its canonical form
        const echoed = await client.services.getRequest(InteropProcedures.echo.procedure, {
          serializer: PAYLOAD_CODECS.raw,
        })(new TextEncoder().encode('{"a":[1,"two",null]}'))();

        expect(new TextDecoder().decode(echoed)).toBe('{"a":[1,"two",null]}');
      });

      // the two codecs read each other's bytes: each side writes its members sorted, in UTF-8
      test('a value outside ASCII, its members in another order, echoed equal', async () => {
        const value = { z: `José ${String.fromCodePoint(0x1f600)}`, a: [1e21, 0.000001] };

        await expect(interop().echo(value)()).resolves.toStrictEqual(value);
      });

      test('bytes answers a string of the length asked', async () => {
        await expect(interop().bytes({ length: 1_000 })()).resolves.toBe('x'.repeat(1_000));
      });

      test('fail answers with its own failure, raised by the server', async () => {
        await expect(interop().fail(null)()).rejects.toMatchObject({
          code: 7,
          detail: 'this procedure fails, on purpose',
          origin: 'peer',
          scope: FailureScope.APPLICATION,
          side: 'server',
        });
      });

      test('a procedure unknown, and a service unknown, are refused as the protocol says', async () => {
        const unknown = { ...InteropProcedures.echo.procedure, procedureId: 99 };
        const elsewhere = { ...InteropProcedures.echo.procedure, serviceId: 9 };

        await expect(
          client.services.getRequest(unknown, { serializer: PAYLOAD_CODECS.json })(null)()
        ).rejects.toMatchObject({
          code: ProtocolCode.PROCEDURE_UNKNOWN,
          scope: FailureScope.PROTOCOL,
        });
        await expect(
          client.services.getRequest(elsewhere, { serializer: PAYLOAD_CODECS.json })(null)()
        ).rejects.toMatchObject({
          code: ProtocolCode.SERVICE_UNKNOWN,
          scope: FailureScope.PROTOCOL,
        });
      });

      test('an admission that refuses, a resolver that throws, and a payload that is not JSON', async () => {
        const notJson = {
          ...PAYLOAD_CODECS.json,
          encode: () => {
            return new Uint8Array([0xff]);
          },
        };

        await expect(interop().denied(null)()).rejects.toMatchObject({
          code: ProtocolCode.ACCESS_DENIED,
          detail: 'this procedure admits nobody',
        });
        await expect(interop().broken(null)()).rejects.toMatchObject({
          code: ProtocolCode.PROCEDURE_FAILED,
        });
        await expect(
          client.services.getRequest(InteropProcedures.echo.procedure, { serializer: notJson })(
            null
          )()
        ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_UNDECODABLE });
      });

      test('a request its rules refuse is answered PAYLOAD_INVALID, its violations in its detail', async () => {
        // * the detail as the server writes it, lines of canonical JSON, byte for byte
        await expect(interop().checked({ names: ['ab', '', 'abcd'] })()).rejects.toMatchObject({
          code: ProtocolCode.PAYLOAD_INVALID,
          detail: [
            '{"bounds":{"min_len":"1"},"fieldPath":"names[1]","message":"must be at least 1 characters","ruleId":"string.min_len"}',
            '{"bounds":{"max_len":"3"},"fieldPath":"names[2]","message":"must be at most 3 characters","ruleId":"string.max_len"}',
            '{"more":0}',
          ].join('\n'),
          scope: FailureScope.PROTOCOL,
        });
      });

      test('checked answers the count of the names its rules take', async () => {
        await expect(interop().checked({ names: ['a', 'bc'] })()).resolves.toBe(2);
      });

      test('a call cancelled by its signal is cancelled at the server too', async () => {
        const controller = new AbortController();
        const slow = interop().slow(SLOW)({ signal: controller.signal });

        // a call after it answered: the server has it, where its cancel must find it — by the
        // socket's order, or by the fetch's
        await interop().echo(null)();
        controller.abort();
        await expect(slow).rejects.toBeInstanceOf(CancelError);
        await expect(cancellationsReaching(1)).resolves.toBe(1);
      });

      test('a call past its timeout is cancelled at the server too', async () => {
        await expect(interop().slow(SLOW)({ timeout: 200 })).rejects.toBeInstanceOf(TimeoutError);
        await expect(cancellationsReaching(1)).resolves.toBe(1);
      });

      test('answers the command the server asks', async () => {
        offerInteropClient(interop());

        await expect(interop().ask(null)()).resolves.toBe('noon');
      });

      test('an unpaced subscription hears each tick', async () => {
        const heard: unknown[] = [];
        const ticks = interop().notifications.ticks;
        const registration = await ticks(null, (value) => {
          heard.push(value);
        })();

        await interop().tick({ value: 1 })();
        await interop().tick({ value: 2 })();
        await expect
          .poll(() => {
            return heard;
          })
          .toEqual([1, 2]);
        await registration.unregister();
      });

      test('a paced subscription waits for its callback to settle before the next comes', async () => {
        const heard: unknown[] = [];
        const holding = Promise.withResolvers<void>();

        made = new InteropClient(client, { windows: { ticks: 1 } });

        const ticks = interop().notifications.ticks;
        const registration = await ticks(null, (value) => {
          heard.push(value);

          return heard.length === 1 ? holding.promise : undefined;
        })();

        await interop().tick({ value: 1 })();
        await interop().tick({ value: 2 })();
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

      test('learns a session opened from its answer, and its end too', async () => {
        await expect(interop().whoami(null)()).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
        });
        await expect(interop().login({ name: 'ada' })()).resolves.toBe('ada');
        expect(client.router.sessionToken).toMatch(/^[\w-]{22}$/);
        await expect(interop().whoami(null)()).resolves.toBe('ada');
        await expect(interop().logout(null)()).resolves.toBeNull();
        expect(client.router.sessionToken).toBeUndefined();
      });

      test('a call presenting the session it learned runs in it, the session opened anew presented anew, and none presented once it ended', async () => {
        const presenting = { credential: { scheme: CredentialScheme.OPAQUE } } as const;

        await expect(interop().login({ name: 'ada' })(presenting)).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
          origin: 'local',
        });
        await expect(interop().login({ name: 'ada' })()).resolves.toBe('ada');
        await expect(interop().whoami(null)(presenting)).resolves.toBe('ada');
        await expect(interop().login({ name: 'bob' })(presenting)).resolves.toBe('bob');
        await expect(interop().whoami(null)(presenting)).resolves.toBe('bob');
        await expect(interop().logout(null)(presenting)).resolves.toBeNull();
        await expect(interop().whoami(null)(presenting)).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
          origin: 'local',
        });
      });

      test('a JWT presented by default runs in its credential’s session: whoami answers its sub, and logout is refused ACCESS_DENIED', async () => {
        const credential = { scheme: CredentialScheme.JWT, token: interopTokenOf('grace') };

        client.router.credential = credential;

        // a login opens the connection's session, whatever the call presents
        await expect(interop().login({ name: 'ada' })()).resolves.toBe('ada');
        await expect(interop().whoami(null)()).resolves.toBe('grace');
        await expect(interop().logout(null)()).rejects.toMatchObject({
          code: ProtocolCode.ACCESS_DENIED,
          detail: "a call in a credential's session ends no connection's session",
          origin: 'peer',
        });
        expect(client.router.credential).toEqual(credential);
        // the connection's session stays, a call presenting none running in it
        await expect(
          interop().whoami(null)({ credential: { scheme: CredentialScheme.NONE } })
        ).resolves.toBe('ada');
      });

      test('an ELSEWHERE goes in each POST’s Authorization over HTTP and in its upgrade’s over a WebSocket: whoami answers the sub it names', async () => {
        const elsewhere = { carried: 'Interop sub=ada', scheme: CredentialScheme.ELSEWHERE };

        if (label === 'WebSocket') {
          // its upgrade carries none yet: a call presenting one fails before it goes
          await expect(interop().whoami(null)({ credential: elsewhere })).rejects.toMatchObject({
            code: ProtocolCode.DESTINATION_UNREACHABLE,
            origin: 'local',
          });

          // given the credential at its connect, over ws, which writes it on the upgrade
          await client[Symbol.asyncDispose]();
          const webSocketClient = createWSClient({ transport: { WebSocket: WsWebSocket } });

          client = webSocketClient;
          made = undefined;
          await webSocketClient.connect({
            credential: elsewhere.carried,
            host: HOST,
            port: ports.port,
          });
        }

        await expect(interop().whoami(null)({ credential: elsewhere })).resolves.toBe('ada');

        if (label === 'WebSocket') {
          // over a WebSocket, those bytes alone: another credential fails before it goes
          await expect(
            interop().whoami(null)({
              credential: { carried: 'Interop sub=bob', scheme: CredentialScheme.ELSEWHERE },
            })
          ).rejects.toMatchObject({ code: ProtocolCode.DESTINATION_UNREACHABLE, origin: 'local' });
        }
      });

      test('login and register hold a duration as section 1.4 does: a fraction rounded, one under a millisecond or past 2³¹ − 1 refused with PROCEDURE_FAILED, nothing opened or registered', async () => {
        const failed = { code: ProtocolCode.PROCEDURE_FAILED };

        for (const refused of [
          { name: 'ada', sessionTimeout: 0.4 },
          { connectionTimeout: 2 ** 31, name: 'ada' },
          { name: 'ada', sessionTimeout: -1 },
        ]) {
          await expect(interop().login(refused)()).rejects.toMatchObject(failed);
        }

        await expect(interop().whoami(null)()).rejects.toMatchObject({
          code: ProtocolCode.SESSION_REQUIRED,
        });
        await expect(interop().register({ destination: 41, timeout: 0 })()).rejects.toMatchObject(
          failed
        );
        await expect(interop().register({ destination: 41, timeout: 1.5 })()).resolves.toBe(41);
        await expect(interop().unregister(null)()).resolves.toBe(true);

        // a session timeout given ends its session once past, rounded; silence counts it alone
        await expect(
          interop().login({
            connectionTimeout: 2 ** 31 - 1,
            name: 'ada',
            sessionTimeout: 99.6,
          })()
        ).resolves.toBe('ada');

        // ! the other side's timer may not have fired on a loaded runner, and an ask that finds the
        // session still there counts afresh: ask again after each silence, until one ends it
        let code: unknown;

        for (let tries = 0; tries < 10 && code !== ProtocolCode.SESSION_REQUIRED; tries += 1) {
          await sleep(400);
          code = await interop()
            .whoami(null)()
            .then(
              () => {
                return undefined;
              },
              (reason: unknown) => {
                return (reason as { code?: unknown }).code;
              }
            );
        }

        expect(code).toBe(ProtocolCode.SESSION_REQUIRED);
      });

      // HTTP carries no transfer: a payload is what one envelope holds
      if (carriesTransfers) {
        test('a payload that goes as a transfer comes back as one, and so does a result too large for one envelope', async () => {
          const long = 'x'.repeat(3 * 1_048_576);
          const echoed = await interop().echo(long)();
          const sent = await interop().bytes({ length: 3 * 1_048_576 })();

          // compared, not diffed: three mebibytes would bury a failure
          expect(echoed === long).toBe(true);
          expect(sent === long).toBe(true);
        });
      }

      // * what a broker alone has (spec 15.18 to 15.21, 15.25 to 15.31)
      if (label === 'MQTT 5') {
        test('a name served by two in one group answers each of sixteen connections, and no OPEN reaches both', async () => {
          const link = mqttLink as IMqttLink;
          const before = link.acceptedTwice;

          for (let index = 0; index < 16; index += 1) {
            const each = createClient({ transport: link.participant.transportClient() });

            try {
              await each.connect({ server: 'interop-both' });
              await expect(new InteropClient(each).echo({ index })()).resolves.toEqual({ index });
            } finally {
              await each[Symbol.asyncDispose]();
            }
          }

          // ! the count proves one group of a member of each side: two would hand each OPEN to both
          expect(link.acceptedTwice - before).toBe(0);
        });

        test('a parcel its broker delivers twice is answered once', async () => {
          const link = mqttLink as IMqttLink;

          link.isCopying = true;

          try {
            await expect(interop().echo({ copied: true })()).resolves.toEqual({ copied: true });
            await expect(interop().bytes({ length: 10 })()).resolves.toBe('x'.repeat(10));
          } finally {
            link.isCopying = false;
          }
        });

        test('a string of 100,000 characters goes in parts both ways, under its broker’s Maximum Packet Size', async () => {
          const long = 'y'.repeat(100_000);

          expect((await interop().echo(long)()) === long).toBe(true);
        });

        test('a link cut at its relay closes its connection unclean, as a dropped socket does', async () => {
          const link = mqttLink as IMqttLink;
          const closes: boolean[] = [];

          (client as IClient<BrokerTransportClient>).router.transport.on('close', (wasClean) => {
            closes.push(wasClean);
          });
          await expect(interop().echo('before')()).resolves.toBe('before');
          link.relay.cut();
          await expect
            .poll(() => {
              return closes;
            })
            .toEqual([false]);
          await expect
            .poll(() => {
              return link.participant.isLinked;
            })
            .toBe(true);
        });

        test('a link lost connects anew, and the next connection through the name is answered', async () => {
          const link = mqttLink as IMqttLink;
          const former = link.participant.incarnation;

          link.relay.cut();
          await expect
            .poll(() => {
              return link.participant.isLinked && link.participant.incarnation !== former;
            })
            .toBe(true);

          const next = createClient({ transport: link.participant.transportClient() });

          try {
            await next.connect({ server: 'interop-cs' });
            await expect(new InteropClient(next).echo('after')()).resolves.toBe('after');
          } finally {
            await next[Symbol.asyncDispose]();
          }
        });
      }
    });
  }
});
