#!/usr/bin/env node
// A measurement of the TypeScript side, with no dependency but esbuild, which the package has:
//
//   node tools/bench.mjs [--seconds 3] [--json]
//
// Two layers. The envelope codec, a request written and read back, at payloads of 0 B, 1 KiB and
// 64 KiB: nanoseconds a round trip. A call, a request answered by a resolver that echoes its JSON, over a
// WebSocket on the loopback of the machine it runs on: its latency one call at a time (p50, p95,
// p99, in microseconds) and its throughput 32 calls at a time. The C# side's
// `implementations/dotnet/tools/Bead.Benchmarks` measures the same, in the same units, so the two
// are read side by side. A number is the machine's, the run's and the runtime's: it says nothing
// across machines, only how one side compares with the other and with its own earlier runs.

import { build } from 'esbuild';
import { cpus, platform, release } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const seconds = args.includes('--seconds') ? Number(args[args.indexOf('--seconds') + 1]) : 3;
const SIZES = [0, 1_024, 65_536];
const CONCURRENCY = 32;

const entry = `
  import { WebSocket, WebSocketServer } from 'ws';
  import { createWSClient } from './src/client/ws-client.ts';
  import { createWSServer } from './src/server/ws-server.ts';
  import { EnvelopeKind, SERVER_FAILURES } from './src/router/shared/constants.ts';
  import { bytesOf, readEnvelope, writeEnvelope } from './src/router/shared/envelope.ts';
  export { WebSocket, WebSocketServer, createWSClient, createWSServer, EnvelopeKind, SERVER_FAILURES, bytesOf, readEnvelope, writeEnvelope };
`;

const folder = mkdtempSync(join(process.env.BEAD_SCRATCH ?? tmpdir(), 'bench-'));
const outfile = join(folder, 'bench.mjs');

// ── Statistics ─────────────────────────────────────────────────────────────────

const percentile = (sorted, share) => {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};

// calls `run` for `milliseconds`, batch by batch so the clock is read rarely; every duration kept
const timed = async (run, milliseconds) => {
  const durations = [];
  const end = performance.now() + milliseconds;

  while (performance.now() < end) {
    const started = performance.now();

    await run();
    durations.push(performance.now() - started);
  }

  return durations;
};

// ── Layers ─────────────────────────────────────────────────────────────────────

const codec = (reader, size) => {
  const payload = new Uint8Array(size).fill(7);
  const envelope = {
    header: {
      callId: 1,
      kind: reader.EnvelopeKind.REQUEST,
      serviceId: 1,
      procedureId: 2,
      destinationId: 1,
      opensSubscription: false,
      paced: false,
    },
    kind: reader.EnvelopeKind.REQUEST,
    payload,
  };
  const limits = { failures: reader.SERVER_FAILURES, maximumEnvelopeBytes: 16_778_240 };
  const once = () => {
    return reader.readEnvelope(reader.writeEnvelope(envelope, 1_024), limits);
  };

  for (let index = 0; index < 5_000; index++) {
    once();
  }

  let rounds = 0;
  const started = performance.now();

  while (performance.now() - started < seconds * 1_000) {
    for (let index = 0; index < 1_000; index++) {
      once();
    }
    rounds += 1_000;
  }

  return ((performance.now() - started) * 1_000_000) / rounds;
};

const calls = async (reader) => {
  // JSON, as the C# side's echo carries it
  const text = {
    decode: (bytes) => {
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    encode: (value) => {
      return new TextEncoder().encode(JSON.stringify(value));
    },
  };
  const echo = { procedureId: 2, procedureName: 'echo', serviceId: 1, serviceRevision: 1 };
  const server = reader.createWSServer({ transport: { WebSocketServer: reader.WebSocketServer } });
  const { port } = await server.transport.start({ address: '127.0.0.1', findOpenPort: true });
  const client = reader.createWSClient({ transport: { WebSocket: reader.WebSocket } });
  const rows = [];

  try {
    server.services.getRequestResolver(echo, { serializer: text })((request, response) => {
      return response(request.payload);
    });
    await client.connect({ host: '127.0.0.1', port });

    const request = client.services.getRequest(echo, { serializer: text });

    for (const size of SIZES) {
      const body = 'x'.repeat(size);
      const call = () => {
        return request(body)();
      };

      for (let index = 0; index < 500; index++) {
        await call();
      }

      const durations = (await timed(call, seconds * 1_000)).sort((a, b) => {
        return a - b;
      });
      const started = performance.now();
      let done = 0;

      while (performance.now() - started < seconds * 1_000) {
        await Promise.all(
          Array.from({ length: CONCURRENCY }, () => {
            return call();
          })
        );
        done += CONCURRENCY;
      }

      rows.push({
        size,
        p50: percentile(durations, 0.5) * 1_000,
        p95: percentile(durations, 0.95) * 1_000,
        p99: percentile(durations, 0.99) * 1_000,
        perSecond: (done * 1_000) / (performance.now() - started),
      });
    }
  } finally {
    await client[Symbol.asyncDispose]();
    await server[Symbol.asyncDispose]();
  }

  return rows;
};

// ── Run ────────────────────────────────────────────────────────────────────────

try {
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
    external: ['bufferutil', 'utf-8-validate'],
    // ws is CommonJS: its requires of Node's own modules need one in an ES module
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    nodePaths: [join(ROOT, 'node_modules')],
  });

  const reader = await import(pathToFileURL(outfile).href);
  const result = {
    side: 'typescript',
    machine: `${cpus()[0]?.model.trim()} x${String(cpus().length)}, ${platform()} ${release()}`,
    runtime: `node ${process.versions.node}, v8 ${process.versions.v8}`,
    codec: SIZES.map((size) => {
      return { size, nanosecondsPerRoundTrip: codec(reader, size) };
    }),
    calls: await calls(reader),
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.side}: ${result.machine}; ${result.runtime}\n`);
    console.log(
      'codec, a request written and read back\n\n| payload | ns per round trip |\n| --- | --- |'
    );
    for (const row of result.codec) {
      console.log(`| ${String(row.size)} B | ${row.nanosecondsPerRoundTrip.toFixed(0)} |`);
    }
    console.log(
      `\ncall, an echo over a WebSocket on the loopback\n\n| payload | p50 us | p95 us | p99 us | calls/s at ${String(CONCURRENCY)} |\n| --- | --- | --- | --- | --- |`
    );
    for (const row of result.calls) {
      console.log(
        `| ${String(row.size)} B | ${row.p50.toFixed(0)} | ${row.p95.toFixed(0)} | ${row.p99.toFixed(0)} | ${row.perSecond.toFixed(0)} |`
      );
    }
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
