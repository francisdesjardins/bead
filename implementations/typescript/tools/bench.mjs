#!/usr/bin/env node
// node --expose-gc implementations/typescript/tools/bench.mjs [--runs 3] [--seconds 3] [--json] [--transcoding] [--filter id-or-name]
// The README defines bead-bench/1 and the scope of each measurement.

import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, platform, release, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GCProfiler, getHeapStatistics } from 'node:v8';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SIZES = [0, 1_024, 65_536];
const CONCURRENCY = 32;
const MEMORY_CALLS = 2_000;
const TRANSFER_SIZE = 20 * 1_048_576;
const args = process.argv.slice(2);
const options = { runs: 3, seconds: 3, json: false, transcoding: false };

for (let at = 0; at < args.length; at++) {
  const flag = args[at];
  if (flag === '--json') {
    options.json = true;
  } else if (flag === '--transcoding') {
    options.transcoding = true;
  } else if (flag === '--filter') {
    const value = args[++at];
    if (!value || value.startsWith('--') || options.filter !== undefined) {
      throw new Error('--filter requires one id or name');
    }
    options.filter = value;
  } else if (flag === '--runs' || flag === '--seconds') {
    const value = Number(args[++at]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${flag} requires a positive integer`);
    }
    options[flag.slice(2)] = value;
  } else {
    throw new Error(`unknown argument: ${flag}`);
  }
}

const entry = `
  export { WebSocket, WebSocketServer } from 'ws';
  export { createWSClient } from './src/client/ws-client.ts';
  export { createWSServer } from './src/server/ws-server.ts';
  export { createHTTPClient } from './src/client/http-client.ts';
  export { createHTTPServer } from './src/server/http-server.ts';
  export { createClient } from './src/client/client.ts';
  export { createServer } from './src/server/server.ts';
  export { createMemoryTransportClient } from './src/transport/client/memory-transport-client.ts';
  export { createMemoryTransportServer } from './src/transport/server/memory-transport-server.ts';
  export { EnvelopeKind, SERVER_FAILURES } from './src/router/shared/constants.ts';
  export { readEnvelope, writeEnvelope } from './src/router/shared/envelope.ts';
  export { PAYLOAD_CODECS } from './src/router/shared/payloads.ts';
  export { InteropClient } from './interop/generated/interop_bead.ts';
  export { offerInterop } from './interop/handlers.ts';
  export { fromBinary, fromJsonString, toBinary, toJsonString } from '@bufbuild/protobuf';
  export { readProtoJson, typeRegistryOf, writeProtoJson } from './src/transcoding/json-form.ts';
  export { EverythingSchema } from './src/transcoding/__tests__/generated/transcoding_pb.ts';
`;

const percentile = (sorted, share) => {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};

const selected = (name, { scenario = 'local', transport = 'none', sizeBytes = 0 } = {}) => {
  return (
    options.filter === undefined ||
    options.filter === name ||
    options.filter === `${scenario}.${transport}.${sizeBytes}.${name}`
  );
};
const wanted = (names, dimensions = {}) => {
  return names.some((name) => {
    return selected(name, dimensions);
  });
};
const callNames = (measure = 'call') => {
  return ['p50', 'p95', 'p99', 'memory', 'throughput'].map((suffix) => {
    return `${measure}.${suffix}`;
  });
};
const wantsCalls = (dimensions, measure = 'call') => {
  return SIZES.some((sizeBytes) => {
    return wanted(callNames(measure), { ...dimensions, sizeBytes });
  });
};
const wantsNotifications = (transport) => {
  return wanted(
    ['notification.p50', 'notification.p95', 'notification.p99', 'notification.throughput'],
    { transport }
  );
};
const wantsTransfer = (transport) => {
  return wanted(['transfer.echo', 'transfer.throughput'], { transport, sizeBytes: TRANSFER_SIZE });
};

const measures = new Map();
const record = (name, value, dimensions = {}) => {
  if (!selected(name, dimensions)) {
    return;
  }
  const { scenario = 'local', transport = 'none', sizeBytes = 0, unit = 'us' } = dimensions;
  const id = `${scenario}.${transport}.${sizeBytes}.${name}`;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`non-finite or negative measurement: ${id}`);
  }
  if (!measures.has(id)) {
    measures.set(id, {
      id,
      name,
      scenario,
      transport,
      sizeBytes,
      unit,
      direction: unit.endsWith('/s') ? 'higher' : 'lower',
      samples: [],
    });
  }
  measures.get(id).samples.push(value);
};

const codec = (once, batch) => {
  for (let index = 0; index < 5_000; index++) {
    once();
  }
  let rounds = 0;
  const started = performance.now();
  while (performance.now() - started < options.seconds * 1_000) {
    for (let index = 0; index < batch; index++) {
      once();
    }
    rounds += batch;
  }
  return ((performance.now() - started) * 1_000_000) / rounds;
};

// Bead's mapping of protobuf's JSON against protobuf-es's, fromJsonString and toJsonString, on
// transcoding.json's message of every kind of field, as a gateway reads a request and writes a
// result: a body read to its message's bytes, and bytes written to a body (decision 0037)
const transcoding = (reader) => {
  const file = JSON.parse(readFileSync(join(REPO, 'spec', 'transcoding.json'), 'utf8'));
  const every = file.writings.find((entry) => {
    return entry.message === 'bead.transcoding.v1.Everything' && entry.body !== undefined;
  });
  const payload = Uint8Array.from(every.payload.split(' ').filter(Boolean), (pair) => {
    return Number.parseInt(pair, 16);
  });
  const schema = reader.EverythingSchema;
  const registry = reader.typeRegistryOf([schema]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const body = encoder.encode(
    reader.writeProtoJson(schema, { message: reader.fromBinary(schema, payload), registry })
  );
  const row = { sizeBytes: body.length, unit: 'ns' };

  if (selected('transcoding.read.bead', row)) {
    record(
      'transcoding.read.bead',
      codec(() => {
        return reader.toBinary(schema, reader.readProtoJson(schema, { bytes: body, registry }));
      }, 100),
      row
    );
  }
  if (selected('transcoding.read.stock', row)) {
    record(
      'transcoding.read.stock',
      codec(() => {
        return reader.toBinary(schema, reader.fromJsonString(schema, decoder.decode(body)));
      }, 100),
      row
    );
  }
  if (selected('transcoding.write.bead', row)) {
    record(
      'transcoding.write.bead',
      codec(() => {
        return encoder.encode(
          reader.writeProtoJson(schema, { message: reader.fromBinary(schema, payload), registry })
        );
      }, 100),
      row
    );
  }
  if (selected('transcoding.write.stock', row)) {
    record(
      'transcoding.write.stock',
      codec(() => {
        return encoder.encode(reader.toJsonString(schema, reader.fromBinary(schema, payload)));
      }, 100),
      row
    );
  }
};

// The normal interop launcher reports both ports and serves until stdin closes.
const startInterop = async () => {
  const child = spawn(
    'dotnet',
    ['run', '-c', 'Release', '--no-build', '--project', 'interop/Bead.Interop.Server'],
    { cwd: join(REPO, 'implementations/dotnet'), stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const exited = once(child, 'exit');
  exited.catch(() => {});
  child.stderr.pipe(process.stderr);
  const timeout = setTimeout(() => {
    child.kill();
  }, 180_000);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let ports;
      try {
        ports = JSON.parse(line);
      } catch {
        continue;
      }
      if (Number.isInteger(ports.port) && Number.isInteger(ports.httpPort)) {
        return {
          ports,
          close: async () => {
            child.stdin.end();
            const timer = setTimeout(() => {
              child.kill();
            }, 10_000);
            try {
              await exited;
            } finally {
              clearTimeout(timer);
            }
          },
        };
      }
    }
    throw new Error('the C# interop server ends before it reports its ports');
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// A client of the in-memory transport to `server`'s, announced to no DevTools, as a gateway's is.
const memoryClientOf = (reader, { limits, server }) => {
  return reader.createClient(
    { transport: reader.createMemoryTransportClient({ server: server.transport }) },
    { devtools: false, limits }
  );
};

const connect = async (reader, transport, settings = {}) => {
  const limits = settings.large
    ? {
        maximumPayloadBytes: 32 * 1_048_576,
        ...(transport === 'http' ? { maximumEnvelopeBytes: 32 * 1_048_576 } : {}),
      }
    : undefined;
  let server;
  let client;
  try {
    let port = settings.port;
    if (port === undefined) {
      server =
        transport === 'http'
          ? reader.createHTTPServer({ limits, transport: { createServer } })
          : transport === 'memory'
            ? reader.createServer({ transport: reader.createMemoryTransportServer() }, { limits })
            : reader.createWSServer({
                limits,
                transport: { WebSocketServer: reader.WebSocketServer },
              });
      reader.offerInterop(server);
      ({ port } = await server.transport.start({ address: '127.0.0.1', findOpenPort: true }));
    }
    client =
      transport === 'http'
        ? reader.createHTTPClient({ limits })
        : transport === 'memory'
          ? memoryClientOf(reader, { limits, server })
          : reader.createWSClient({ limits, transport: { WebSocket: reader.WebSocket } });
    await client.connect(transport === 'memory' ? {} : { host: '127.0.0.1', port });
    return {
      client,
      server,
      interop: new reader.InteropClient(client),
      close: async () => {
        try {
          await client[Symbol.asyncDispose]();
        } finally {
          await server?.[Symbol.asyncDispose]();
        }
      },
    };
  } catch (error) {
    await client?.[Symbol.asyncDispose]();
    await server?.[Symbol.asyncDispose]();
    throw error;
  }
};

// * `callOf` gives what one measured call does: a call on a connection kept, or, as `exchange`, a
// connection drawn, called once and closed, as a gateway does for each HTTP exchange.
const calls = async (callOf, dimensions, { measure = 'call' } = {}) => {
  for (const sizeBytes of SIZES) {
    const row = { ...dimensions, sizeBytes };
    if (!wanted(callNames(measure), row)) {
      continue;
    }
    const call = callOf('x'.repeat(sizeBytes));
    for (let index = 0; index < 500; index++) {
      await call();
    }
    console.error(`calls ${row.scenario}/${row.transport}/${sizeBytes}`);
    if (wanted([`${measure}.p50`, `${measure}.p95`, `${measure}.p99`], row)) {
      const durations = [];
      const started = performance.now();
      while (performance.now() - started < options.seconds * 1_000) {
        const before = performance.now();
        await call();
        durations.push((performance.now() - before) * 1_000);
      }
      durations.sort((a, b) => {
        return a - b;
      });
      for (const share of [0.5, 0.95, 0.99]) {
        record(`${measure}.p${share * 100}`, percentile(durations, share), row);
      }
    }

    if (selected(`${measure}.memory`, row)) {
      // * Account for reclaimed bytes as well as live heap growth, including transient objects.
      globalThis.gc?.();
      const profiler = new GCProfiler();
      let heapBefore;
      let heapAfter;
      let statistics;

      profiler.start();
      try {
        heapBefore = getHeapStatistics().used_heap_size;
        for (let index = 0; index < MEMORY_CALLS; index++) {
          await call();
        }
        heapAfter = getHeapStatistics().used_heap_size;
      } finally {
        ({ statistics } = profiler.stop());
      }

      let allocated = heapAfter - heapBefore;
      for (const collection of statistics) {
        const before = collection.beforeGC?.heapStatistics?.usedHeapSize;
        const after = collection.afterGC?.heapStatistics?.usedHeapSize;
        if (!Number.isFinite(before) || !Number.isFinite(after)) {
          throw new Error('GCProfiler requires beforeGC/afterGC.heapStatistics.usedHeapSize');
        }
        allocated += before - after;
      }
      record(`${measure}.memory`, allocated / MEMORY_CALLS, {
        ...row,
        unit: `B/${measure}`,
      });
    }

    if (selected(`${measure}.throughput`, row)) {
      let done = 0;
      const started = performance.now();
      while (performance.now() - started < options.seconds * 1_000) {
        await Promise.all(Array.from({ length: CONCURRENCY }, call));
        done += CONCURRENCY;
      }
      record(`${measure}.throughput`, (done * 1_000) / (performance.now() - started), {
        ...row,
        unit: `${measure}s/s`,
      });
    }
  }
};

const notifications = async (connection, reader, { transport }) => {
  const procedure = { serviceId: 2, serviceRevision: 1, procedureId: 1, procedureName: 'cadence' };
  const codec = reader.PAYLOAD_CODECS.json;
  const serializer = {
    ...codec,
    encodeNotification: codec.encode,
    decodeNotification: codec.decode,
  };
  const resolver = connection.server.services.getNotificationResolver(procedure, { serializer })(
    (_request, response) => {
      return response(null);
    }
  );
  const durations = [];
  let sent = 0;
  const drained = Promise.withResolvers();
  let room = Promise.withResolvers();
  let sending = true;
  const patience = new AbortController();
  const expired = delay(options.seconds * 1_000 + 30_000, undefined, {
    signal: patience.signal,
    ref: false,
  }).then(() => {
    throw new Error('notifications exceed their cadence and 30 second drain');
  });
  expired.catch(() => {});
  const registration = await connection.client.services.getNotification(procedure, {
    serializer,
    window: CONCURRENCY,
  })(null, (timestamp) => {
    durations.push((performance.now() - timestamp) * 1_000);
    room.resolve();
    room = Promise.withResolvers();
    if (!sending && durations.length === sent) {
      drained.resolve();
    }
  })();
  try {
    const started = performance.now();
    const end = started + options.seconds * 1_000;
    let due = started;
    // * A late wake-up catches up to every due value; at most 32 await their handlers.
    while (due < end) {
      while (due < end && due <= performance.now()) {
        while (sent - durations.length >= CONCURRENCY) {
          await Promise.race([room.promise, expired]);
        }
        sent++;
        await resolver.notify(performance.now());
        due += 1;
      }
      const pause = due - performance.now();
      if (due < end && pause > 0) {
        await delay(pause, undefined, { signal: patience.signal });
      }
    }
    sending = false;
    if (durations.length === sent) {
      drained.resolve();
    }
    await Promise.race([drained.promise, expired]);
    const elapsed = performance.now() - started;
    durations.sort((a, b) => {
      return a - b;
    });
    const row = { transport };
    for (const share of [0.5, 0.95, 0.99]) {
      record(`notification.p${share * 100}`, percentile(durations, share), row);
    }
    record('notification.throughput', (durations.length * 1_000) / elapsed, {
      ...row,
      unit: 'notifications/s',
    });
  } finally {
    patience.abort();
    await registration.unregister();
  }
};

const transfer = async (connection, transport) => {
  const body = 'x'.repeat(TRANSFER_SIZE);
  const call = () => {
    return connection.interop.echo(body)({ timeout: 30_000 });
  };
  if ((await call()) !== body) {
    throw new Error('large echo differs from its payload');
  }
  const started = performance.now();
  let done = 0;
  do {
    await call();
    done++;
  } while (performance.now() - started < options.seconds * 1_000);
  const milliseconds = (performance.now() - started) / done;
  const row = { transport, sizeBytes: TRANSFER_SIZE };
  record('transfer.echo', milliseconds, { ...row, unit: 'ms' });
  record('transfer.throughput', (40 * 1_000) / milliseconds, { ...row, unit: 'MiB/s' });
};

const folder = mkdtempSync(join(process.env.BEAD_SCRATCH ?? tmpdir(), 'bench-'));
const outfile = join(folder, 'bench.mjs');
let remote;
try {
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'error',
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    nodePaths: [join(ROOT, 'node_modules')],
  });
  const reader = await import(pathToFileURL(outfile).href);
  const needsInterop =
    !options.transcoding &&
    ['http', 'websocket'].some((transport) => {
      return wantsCalls({ scenario: 'interop', transport });
    });
  if (needsInterop) {
    if (process.env.BEAD_BENCH_INTEROP_BUILT !== '1') {
      execFileSync('dotnet', ['build', '-c', 'Release', 'interop/Bead.Interop.Server'], {
        cwd: join(REPO, 'implementations/dotnet'),
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    remote = await startInterop();
  }
  for (let run = 0; run < options.runs; run++) {
    console.error(`run ${run + 1}/${options.runs}`);
    transcoding(reader);
    if (options.transcoding) {
      continue;
    }
    for (const sizeBytes of SIZES) {
      const envelope = {
        header: {
          callId: 1,
          kind: reader.EnvelopeKind.REQUEST,
          serviceId: 1,
          procedureId: 1,
          destinationId: 1,
          opensSubscription: false,
          paced: false,
        },
        kind: reader.EnvelopeKind.REQUEST,
        payload: new Uint8Array(sizeBytes),
      };
      const limits = { failures: reader.SERVER_FAILURES, maximumEnvelopeBytes: 16_778_240 };
      const value = 'x'.repeat(sizeBytes);
      const row = { sizeBytes, unit: 'ns' };
      if (selected('codec.roundTrip', row)) {
        record(
          'codec.roundTrip',
          codec(() => {
            return reader.readEnvelope(reader.writeEnvelope(envelope, 1_024), limits);
          }, 1_000),
          row
        );
      }
      if (selected('json.roundTrip', row)) {
        record(
          'json.roundTrip',
          codec(() => {
            return reader.PAYLOAD_CODECS.json.decode(reader.PAYLOAD_CODECS.json.encode(value));
          }, 100),
          row
        );
      }
    }
    for (const transport of ['websocket', 'http']) {
      for (const scenario of ['local', 'interop']) {
        if (
          !wantsCalls({ scenario, transport }) &&
          !(scenario === 'local' && wantsNotifications(transport))
        ) {
          continue;
        }
        const connection = await connect(reader, transport, {
          port:
            scenario === 'interop'
              ? remote.ports[transport === 'http' ? 'httpPort' : 'port']
              : undefined,
        });
        try {
          await calls(
            (body) => {
              return () => {
                return connection.interop.echo(body)();
              };
            },
            { scenario, transport }
          );
          if (scenario === 'local' && wantsNotifications(transport)) {
            await notifications(connection, reader, { transport });
          }
        } finally {
          await connection.close();
        }
      }
      if (wantsTransfer(transport)) {
        const connection = await connect(reader, transport, { large: true });
        try {
          await transfer(connection, transport);
        } finally {
          await connection.close();
        }
      }
    }
    // in memory: calls on one connection kept, against a connection drawn for each call
    if (wantsCalls({ transport: 'memory' }) || wantsCalls({ transport: 'memory' }, 'exchange')) {
      const connection = await connect(reader, 'memory');
      try {
        const dimensions = { scenario: 'local', transport: 'memory' };
        await calls((body) => {
          return () => {
            return connection.interop.echo(body)();
          };
        }, dimensions);
        await calls(
          (body) => {
            return async () => {
              const client = memoryClientOf(reader, { server: connection.server });
              try {
                await client.connect({});
                return await new reader.InteropClient(client).echo(body)();
              } finally {
                await client[Symbol.asyncDispose]();
              }
            };
          },
          dimensions,
          { measure: 'exchange' }
        );
      } finally {
        await connection.close();
      }
    }
  }
  if (measures.size === 0) {
    throw new Error(`filter matches no measurement: ${options.filter}`);
  }
  const result = {
    schema: 'bead-bench/1',
    side: 'typescript',
    environment: {
      cpu: { model: cpus()[0]?.model.trim(), count: cpus().length },
      os: { platform: platform(), release: release(), architecture: arch() },
      runtimes: {
        node: process.versions.node,
        v8: process.versions.v8,
        dotnet: execFileSync('dotnet', ['--list-runtimes'], { encoding: 'utf8' }).trim(),
        dotnetSdk: execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim(),
      },
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    },
    method: {
      runs: options.runs,
      filter: options.filter ?? null,
      seconds: options.seconds,
      concurrency: CONCURRENCY,
      notificationIntervalMs: 1,
      notificationWindow: CONCURRENCY,
      memoryCalls: MEMORY_CALLS,
      memory: {
        method: 'v8-gc-accounted-allocations',
        scope: 'local: client and server; interop: client process only',
        limitations:
          'Process-wide V8 heap bytes allocated per call: used_heap_size growth plus bytes reclaimed in GCProfiler collections. Includes transient allocations and background work. Excludes external ArrayBuffer backing stores, native allocations and the remote server.',
      },
      transfer:
        '20 MiB JSON echo; websocket: chunks; http: whole envelope, 32 MiB limit; MiB/s counts both directions',
      interop: 'calls only; normal interop server launcher, Release configuration',
      memoryTransport:
        'local only: calls on one in-memory connection kept, and exchanges, each a client and its connection drawn, called once and closed',
    },
    measures: [...measures.values()].map((row) => {
      const sorted = row.samples.toSorted((a, b) => {
        return a - b;
      });
      const middle = Math.floor(sorted.length / 2);
      return {
        ...row,
        median:
          sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
        min: sorted[0],
        max: sorted.at(-1),
      };
    }),
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify({ ...result, measures: undefined }, null, 2));
    console.log('\n| measure | unit | median | min | max |\n| --- | --- | --- | --- | --- |');
    for (const row of result.measures) {
      console.log(
        `| ${row.id} | ${row.unit} | ${row.median.toFixed(3)} | ${row.min.toFixed(3)} | ${row.max.toFixed(3)} |`
      );
    }
  }
} finally {
  try {
    await remote?.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
