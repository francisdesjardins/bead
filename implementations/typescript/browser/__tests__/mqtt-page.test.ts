// ── MQTT page ─────────────────────────────────────────────────────────────────

// A broker's client transport in Chromium, over MQTT.js's browser build, its link a WebSocket of
// subprotocol `mqtt` to the Mosquitto `BEAD_MQTT_WS_URL` names, calling each side's interop server
// through its name (spec 15.25 to 15.31); where none is given, skipped, saying so, or failed where
// `BEAD_MQTT_REQUIRED=1`. The C# server is built and started by .NET: where .NET is not installed,
// its half is skipped, saying so, or fails where `BEAD_INTEROP_REQUIRED=1`. Its adapter alone,
// through a relay that records its frames, sending each message as one. And what no page does: a TLS
// client certificate, which its browser chooses, refused as the adapter is built.

// dependencies

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { createFrameRelay, unwholeOf } from '../../src/transport/shared/__tests__/frame-relay';
import type { IMqttPageReport, IMqttPageTarget } from '../mqtt-page';

// constants

const HOST = '127.0.0.1';

/** The package, where the TypeScript interop server runs from. */
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

/** The C# side, beside the package, where its interop server runs from. */
const DOTNET = fileURLToPath(new URL('../../../dotnet/', import.meta.url));

/** Whether .NET answers, to build and start the C# server. */
const HAS_DOTNET = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;

/** Whether the C# half must run: a path to the other side gone wrong then fails, not skips. */
const REQUIRED = process.env['BEAD_INTEROP_REQUIRED'] === '1';

// the broker's WebSocket the page links over, where one is given, and the run's password
const MQTT_WS_URL = process.env['BEAD_MQTT_WS_URL'];
const MQTT_PASSWORD = process.env['BEAD_MQTT_PASSWORD'] ?? '';
const IS_MQTT_REQUIRED = process.env['BEAD_MQTT_REQUIRED'] === '1';
const NO_BROKER = 'no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)';

/** Each side's interop server: how it starts, the name it serves alone, and whether it can here. */
const SERVERS = [
  {
    args: ['interop/serve.ts'],
    command: process.execPath,
    cwd: PACKAGE,
    isRunnable: true,
    label: 'TypeScript',
    name: 'interop-ts',
  },
  {
    args: ['run', '--project', 'interop/Bead.Interop.Server'],
    command: 'dotnet',
    cwd: DOTNET,
    isRunnable: HAS_DOTNET,
    label: 'C#',
    name: 'interop-cs',
  },
] as const;

// helpers

/** The page, its script bundled for the browser, MQTT.js's browser build among it; what closes it. */
const servePage = async () => {
  const { outputFiles } = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL('../mqtt-page.ts', import.meta.url))],
    format: 'esm',
    logLevel: 'silent',
    platform: 'browser',
    write: false,
  });
  const script = outputFiles[0]?.contents ?? new Uint8Array();
  const server = createServer((request, reply) => {
    if (request.url === '/mqtt-page.js') {
      reply.writeHead(200, { 'content-type': 'text/javascript' });
      reply.end(script);

      return;
    }

    reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    reply.end('<!doctype html><script type="module" src="/mqtt-page.js"></script>');
  });

  server.listen(0, HOST);
  await once(server, 'listening');

  return {
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    port: (server.address() as AddressInfo).port,
  };
};

/** An interop server, started over MQTT 5 with the run's broker, once it said its ports. */
const startServer = async ({
  args,
  command,
  cwd,
}: (typeof SERVERS)[number]): Promise<ChildProcessWithoutNullStreams> => {
  const server = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  server.stderr.pipe(process.stderr);

  for await (const line of createInterface({ input: server.stdout })) {
    try {
      const { httpPort } = JSON.parse(line) as { httpPort?: unknown };

      if (typeof httpPort === 'number') {
        return server;
      }
    } catch {
      // a line of the build's, before the server's
    }
  }

  throw new Error(`the ${command} interop server ended before it said its port`);
};

/** The page loaded, its script's functions on it. */
const loaded = async (browserPage: Page, port: number): Promise<void> => {
  await browserPage.goto(`http://${HOST}:${String(port)}/`);
  await browserPage.waitForFunction(() => {
    return 'callOverMqtt' in globalThis;
  });
};

// definition

for (const each of SERVERS) {
  test.describe(`a page over MQTT 5, against the ${each.label} server`, () => {
    test.skip(MQTT_WS_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    test.skip(
      !each.isRunnable && !REQUIRED,
      'it builds and starts a .NET program, and .NET is not installed'
    );
    test.describe.configure({ mode: 'serial' });

    let served: Awaited<ReturnType<typeof servePage>> | undefined;
    let server: ChildProcessWithoutNullStreams | undefined;

    test.beforeAll(async () => {
      // the first run builds the C# server
      test.setTimeout(180_000);
      expect(MQTT_WS_URL, NO_BROKER).toBeDefined();

      if (!each.isRunnable) {
        throw new Error(
          'BEAD_INTEROP_REQUIRED=1 asks for the C# server, and .NET is not installed'
        );
      }

      served = await servePage();
      server = await startServer(each);
    });

    test.afterAll(async () => {
      served?.close();

      if (server !== undefined) {
        const exited = once(server, 'exit');

        server.stdin.end();
        await exited;
      }
    });

    test('a page links over a WebSocket of subprotocol mqtt, connects through the server’s name and calls it, its credential in its DATA', async ({
      page,
    }) => {
      await loaded(page, served?.port ?? 0);

      const target: IMqttPageTarget = {
        id: 'ts-client',
        password: MQTT_PASSWORD,
        server: each.name,
        url: MQTT_WS_URL ?? '',
      };
      const report = await page.evaluate((given) => {
        const { callOverMqtt } = globalThis as unknown as {
          callOverMqtt: (on: IMqttPageTarget) => Promise<IMqttPageReport>;
        };

        return callOverMqtt(given);
      }, target);

      expect(report).toEqual({ echoed: { over: 'MQTT 5' }, isSecure: true, whoami: 'ada' });
    });
  });
}

test.describe('a page over MQTT 5, its own', () => {
  test('sends each WebSocket message to its broker as one binary frame, a burst past 64 KiB among them (spec 15.25)', async ({
    page,
  }) => {
    test.skip(MQTT_WS_URL === undefined && !IS_MQTT_REQUIRED, NO_BROKER);
    expect(MQTT_WS_URL, NO_BROKER).toBeDefined();

    await using relay = await createFrameRelay(MQTT_WS_URL ?? '');
    const served = await servePage();

    try {
      await loaded(page, served.port);

      const target = { id: 'fixture', password: MQTT_PASSWORD, url: relay.url };
      const report = await page.evaluate((given) => {
        const { burstOverMqtt } = globalThis as unknown as {
          burstOverMqtt: (on: typeof given) => Promise<Record<string, unknown>>;
        };

        return burstOverMqtt(given);
      }, target);
      const count = (report['heard'] as unknown[] | undefined)?.length ?? 0;

      // * what the page sent, each message one frame: none ends no message, none continues one
      expect(unwholeOf(relay.frames)).toEqual([]);
      expect(relay.frames.length).toBeGreaterThan(count);
      expect(report).toEqual({
        heard: Array.from({ length: count }, (_, index) => {
          return index;
        }),
        isLinked: true,
        taken: count,
      });
      expect(count).toBeGreaterThan(1);
    } finally {
      served.close();
    }
  });

  test('refuses a client certificate in a page, naming why', async ({ page }) => {
    const served = await servePage();

    try {
      await loaded(page, served.port);

      const refusal = await page.evaluate(() => {
        const { refuseCertificate } = globalThis as unknown as { refuseCertificate: () => string };

        return refuseCertificate();
      });

      expect(refusal).toBe(
        'a page chooses no TLS client certificate, its browser does: authenticate it by a password'
      );
    } finally {
      served.close();
    }
  });
});
