#!/usr/bin/env node
// Protobuf's conformance suite against each side's generated `proto` codec, and one corpus read by
// both sides alike (decision 0028). The runner is `protobuf-conformance`, the npm distribution of
// protobuf's `conformance_test_runner`, at the release both libraries pin: `protobuf-conformance/
// runner.json` gives its tarball, its upstream release and npm's integrity, a sha512, and the floor
// of tests a run holds. This fetches the tarball, checks its sha512 before it reads a byte of it,
// and unpacks it into `protobuf-conformance/.runner/`, which git ignores and CI caches by the pin,
// as builder/tools/fetch-protoc.mjs does protoc: the root's tools take no dependency (decision
// 0005), and no install of a side carries the runner.
//
//   node tools/protobuf-conformance.mjs typescript     the suite through the TypeScript side's codec
//   node tools/protobuf-conformance.mjs csharp         the suite through the C# side's codec
//   node tools/protobuf-conformance.mjs differential   one corpus of Probe through both
//
// For a side, it ejects the suite's test protos from the pinned package into
// `protobuf-conformance/.work/<side>/`, under `protobuf_test_messages/` rather than
// `google/protobuf/`, where beadc writes no message, and the suite's `conformance/conformance.proto`;
// puts spec/codecs.proto and `protobuf-conformance/service.proto` beside them; runs `beadc generate`
// there for the side's target, and copies what it writes into the side's testee:
//
// - TypeScript: `implementations/typescript/tools/protobuf-conformance/`, its `generated/` written
//   here, type-checked by its own tsconfig.json, its `testee.ts` run by Node on the side's own
//   install, its `failing.txt` the side's list;
// - C#: `implementations/dotnet/tools/Bead.ProtobufConformance/`, its `Generated/` written here,
//   built in Release and run by `dotnet`, its `failing.txt` the side's list.
//
// A testee is a conformance testee, as protobuf's runner drives one: on its standard input, each
// ConformanceRequest after its length, a 32-bit little-endian integer; on its standard output, each
// ConformanceResponse alike. It reads and writes each message through the codec of the procedure
// that binds it, by the message's full name, and its JSON by the side's own mapping of protobuf's
// JSON, the one its gateway answers by (decision 0037); it answers `skipped` for a text or JSPB
// payload or output, for a test of ignoring unknown JSON members, which Bead's mapping always
// refuses, and for `protobuf_test_messages.edition_unstable`'s message, which no stock generator
// compiles, alone, and `runtime_error` for a request of any other message it lacks, so a message
// gone fails rather than skips.
//
// The suite runs `--enforce_recommended --maximum_edition MAX` with the side's failure list, whose
// every line pins a test and the runner's message, its reason on the comment line above: the runner
// fails a listed test that passes, so the list holds both ways. Then the floor, suite by suite as
// the runner closes them, binary and JSON then text format: the side's successes and expected
// failures are the suite's `tests`, its skips its `skipped`, both moved with the pin alone.
// The tool fails before anything when the pin's release and Google.Protobuf's in
// implementations/dotnet/Directory.Packages.props differ, v36.2 against 3.36.2.
//
// The differential feeds both testees the same payloads of Probe, `CORPUS_SIZE` of them from
// `CORPUS_SEED`: Probe's own records, mutated by cuts, lengths, wire types, tags and nesting, its
// packed runs, its map's entries and its group among them. Each side reads or refuses each; where
// both read, what each writes back is compared as what it reads, the choices protobuf leaves to a
// writer aside, at every depth: the order of a message's unknown fields, which Google.Protobuf
// writes by number and wire type (a platform row of docs/support.md), the order of a map's entries,
// and an entry's key at its default, which protobuf-es writes and Google.Protobuf leaves out. Any
// other parting fails.
//
// The runner ships linux-x64 and darwin-x64 binaries alone: the suite runs in CI and, on Windows, in
// a Linux container; the differential runs wherever both testees do. From the repository's root,
// once implementations/typescript and builder/ are installed; protoc is `BEADC_PROTOC`, or the one
// builder/tools/fetch-protoc.mjs fetches. Exit 1 on a failure, with its reason.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Places ────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HERE = join(ROOT, 'tools', 'protobuf-conformance');
const PIN_FILE = join(HERE, 'runner.json');
const RUNNER = join(HERE, '.runner');
const WORK = join(HERE, '.work');
const PACKAGES = join(ROOT, 'implementations', 'dotnet', 'Directory.Packages.props');
const BEADC = join(ROOT, 'builder', 'src', 'cli.ts');
const FETCH_PROTOC = join(ROOT, 'builder', 'tools', 'fetch-protoc.mjs');
const TYPESCRIPT_COMPILER = join(
  ROOT,
  'implementations',
  'typescript',
  'node_modules',
  'typescript-7',
  'bin',
  'tsc'
);

// the suite's test protos, as the package's `include/` holds them, and the folder they go to
const TEST_MESSAGES = [
  'test_messages_edition2023.proto',
  'test_messages_proto2.proto',
  'test_messages_proto2_editions.proto',
  'test_messages_proto3.proto',
  'test_messages_proto3_editions.proto',
];
const TEST_FOLDER = 'protobuf_test_messages';

// * each side's testee: where beadc's output goes, its failure list, and how it is built and run
export const SIDES = Object.freeze({
  typescript: Object.freeze({
    language: 'typescript',
    folder: 'implementations/typescript/tools/protobuf-conformance',
    generated: 'generated',
  }),
  csharp: Object.freeze({
    language: 'csharp',
    folder: 'implementations/dotnet/tools/Bead.ProtobufConformance',
    generated: 'Generated',
  }),
});

// ── Pin ───────────────────────────────────────────────────────────────────────

/** The pin, `runner.json`, read. */
export const readPin = (text) => {
  const pin = JSON.parse(text);

  for (const key of ['package', 'version', 'upstreamVersion', 'tarball', 'integrity']) {
    if (typeof pin[key] !== 'string' || pin[key] === '') {
      throw new Error(`runner.json: ${key} is missing`);
    }
  }

  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(pin.integrity)) {
    throw new Error(`runner.json: integrity is npm's sha512, sha512-<base64>`);
  }

  if (
    !Array.isArray(pin.floor) ||
    pin.floor.length === 0 ||
    !pin.floor.every((suite) => {
      return (
        typeof suite?.suite === 'string' &&
        Number.isInteger(suite.tests) &&
        Number.isInteger(suite.skipped)
      );
    })
  ) {
    throw new Error("runner.json: floor is each suite's name, its tests and its skips, in order");
  }

  return pin;
};

/** `bytes`' integrity, as npm's `dist.integrity` gives it: `sha512-<base64>`. */
export const integrityOf = (bytes) => {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
};

/** The protobuf release a version names, `36.2`: the runner's `v36.2`, Google.Protobuf's `3.36.2`. */
export const releaseOf = (version) => {
  const upstream = /^v(\d+)\.(\d+)(?:\.\d+)?$/u.exec(version);

  if (upstream !== null) {
    return `${upstream[1]}.${upstream[2]}`;
  }

  // ! Google.Protobuf keeps protobuf's old major, 3, before the release's own numbers
  const csharp = /^3\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);

  if (csharp !== null) {
    return `${csharp[1]}.${csharp[2]}`;
  }

  throw new Error(`${version}: no protobuf release`);
};

/** Google.Protobuf's version, as `Directory.Packages.props` pins it. */
export const googleProtobufOf = (text) => {
  const pinned = /<PackageVersion\s+Include="Google\.Protobuf"\s+Version="([^"]+)"/u.exec(text);

  if (pinned === null) {
    throw new Error('Directory.Packages.props pins no Google.Protobuf');
  }

  return pinned[1];
};

/** Why the runner's release and Google.Protobuf's are not one, or nothing. */
export const pinDisagreement = (pin, googleProtobuf) => {
  const runner = releaseOf(pin.upstreamVersion);
  const library = releaseOf(googleProtobuf);

  return runner === library
    ? undefined
    : `runner.json runs protobuf ${pin.upstreamVersion}, and Google.Protobuf is pinned at ${googleProtobuf}: the runner follows the older library, and both move in one commit (decision 0028)`;
};

// ── The runner's summary ──────────────────────────────────────────────────────

const SUMMARY =
  /^CONFORMANCE SUITE (PASSED|FAILED): (\d+) successes, (\d+) skipped, (\d+) expected failures, (\d+) unexpected failures\.$/mu;

/** Each summary line the runner printed in `output`, a suite's, in their order, read. */
export const summariesOf = (output) => {
  return [...output.matchAll(new RegExp(SUMMARY.source, 'gmu'))].map((line) => {
    return {
      passed: line[1] === 'PASSED',
      successes: Number(line[2]),
      skipped: Number(line[3]),
      expected: Number(line[4]),
      unexpected: Number(line[5]),
    };
  });
};

/**
 * What a run's summaries break of the floor, one reason a line, none when it holds: each suite
 * passed, its successes and expected failures its floor's tests, and its skips its floor's.
 */
export const floorBreaches = (summaries, floor) => {
  if (summaries.length !== floor.length) {
    return [
      `the runner closed ${String(summaries.length)} suites, where the floor names ${String(floor.length)}`,
    ];
  }

  return floor.flatMap((expected, index) => {
    const summary = summaries[index];
    const breaches = [];

    if (!summary.passed || summary.unexpected !== 0) {
      breaches.push(`failed: ${String(summary.unexpected)} unexpected failures`);
    }

    if (summary.successes + summary.expected !== expected.tests) {
      breaches.push(
        `${String(summary.successes)} successes and ${String(summary.expected)} expected failures, where the floor is ${String(expected.tests)} tests`
      );
    }

    if (summary.skipped !== expected.skipped) {
      breaches.push(
        `${String(summary.skipped)} tests skipped, where the floor is ${String(expected.skipped)}`
      );
    }

    return breaches.map((breach) => {
      return `the ${expected.suite} suite: ${breach}`;
    });
  });
};

// ── Wire ──────────────────────────────────────────────────────────────────────

// the wire types (protobuf's Encoding guide)
export const VARINT = 0;
export const I64 = 1;
export const LEN = 2;
export const SGROUP = 3;
export const EGROUP = 4;
export const I32 = 5;

/** A varint of `value`, a number below 2⁵³ or a bigint below 2⁶⁴. */
export const varint = (value) => {
  let rest = BigInt(value);
  const bytes = [];

  do {
    const low = Number(rest & 0x7fn);

    rest >>= 7n;
    bytes.push(rest === 0n ? low : low | 0x80);
  } while (rest !== 0n);

  return bytes;
};

/** A tag: `field`, then `wireType`. */
export const tag = (field, wireType) => {
  return varint((BigInt(field) << 3n) | BigInt(wireType));
};

/** A length-delimited record of `field`. */
export const lengthDelimited = (field, payload) => {
  return [...tag(field, LEN), ...varint(payload.length), ...payload];
};

// a varint at `at` in `bytes`, as protobuf reads one, ten bytes at most; or nothing
const readVarint = (bytes, at) => {
  let value = 0n;

  for (let index = 0; index < 10 && at + index < bytes.length; index += 1) {
    const byte = bytes[at + index];

    value |= BigInt(byte & 0x7f) << BigInt(7 * index);

    if ((byte & 0x80) === 0) {
      return { value, end: at + index + 1 };
    }
  }

  return undefined;
};

/**
 * The records of a message's bytes, each its field, its wire type, and its bytes whole, its payload
 * besides for a length-delimited record and a group; or nothing when they do not read.
 */
export const recordsOf = (bytes) => {
  const records = [];
  let at = 0;

  while (at < bytes.length) {
    const start = at;
    const key = readVarint(bytes, at);

    if (key === undefined) {
      return undefined;
    }

    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);

    at = key.end;

    if (wireType === VARINT) {
      const value = readVarint(bytes, at);

      if (value === undefined) {
        return undefined;
      }

      at = value.end;
      records.push({ field, wireType, whole: bytes.subarray(start, at) });
    } else if (wireType === I64 || wireType === I32) {
      at += wireType === I64 ? 8 : 4;

      if (at > bytes.length) {
        return undefined;
      }

      records.push({ field, wireType, whole: bytes.subarray(start, at) });
    } else if (wireType === LEN) {
      const length = readVarint(bytes, at);

      if (length === undefined || length.value > BigInt(bytes.length - length.end)) {
        return undefined;
      }

      at = length.end + Number(length.value);
      records.push({
        field,
        wireType,
        whole: bytes.subarray(start, at),
        payload: bytes.subarray(length.end, at),
      });
    } else if (wireType === SGROUP) {
      const inner = groupEnd(bytes, { at, field });

      if (inner === undefined) {
        return undefined;
      }

      records.push({
        field,
        wireType,
        whole: bytes.subarray(start, inner.end),
        payload: bytes.subarray(at, inner.close),
      });
      at = inner.end;
    } else {
      return undefined;
    }
  }

  return records;
};

// where the group of `field` that opens before `at` closes: its end group's start and end
const groupEnd = (bytes, { at, field }) => {
  let index = at;

  while (index < bytes.length) {
    const key = readVarint(bytes, index);

    if (key === undefined) {
      return undefined;
    }

    const inner = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);

    if (wireType === EGROUP) {
      return inner === field ? { close: index, end: key.end } : undefined;
    }

    index = skipOne(bytes, index);
  }

  return undefined;
};

// the end of the one record at `at`, or past the bytes when it does not read
const skipOne = (bytes, at) => {
  const key = readVarint(bytes, at);

  if (key === undefined) {
    return bytes.length + 1;
  }

  const field = Number(key.value >> 3n);
  const wireType = Number(key.value & 7n);

  if (wireType === VARINT) {
    return readVarint(bytes, key.end)?.end ?? bytes.length + 1;
  }

  if (wireType === I64 || wireType === I32) {
    return key.end + (wireType === I64 ? 8 : 4);
  }

  if (wireType === LEN) {
    const length = readVarint(bytes, key.end);

    return length === undefined ? bytes.length + 1 : length.end + Number(length.value);
  }

  if (wireType === SGROUP) {
    return groupEnd(bytes, { at: key.end, field })?.end ?? bytes.length + 1;
  }

  return bytes.length + 1;
};

// ── Probe, compared ───────────────────────────────────────────────────────────

// Probe's fields (spec/codecs.proto): its messages, its map, and every number it declares
const PROBE_MESSAGES = new Set([3, 13]);
const PROBE_MAP = 12;
const PROBE_FIELDS = new Set([1, 2, 3, 10, 11, 12, 13]);

const hexOf = (bytes) => {
  return Buffer.from(bytes).toString('hex');
};

/**
 * A Probe's bytes in a form two writers that differ only where protobuf leaves the order to a
 * writer give alike: its declared records in their order, each message among them in this form;
 * its map's entries, then its unknown fields, each set sorted. Bytes that do not read as records
 * keep their own form.
 */
export const canonicalProbe = (bytes) => {
  const records = recordsOf(bytes);

  if (records === undefined) {
    return `raw:${hexOf(bytes)}`;
  }

  const declared = [];
  const entries = [];
  const unknown = [];

  for (const record of records) {
    if (!PROBE_FIELDS.has(record.field)) {
      unknown.push(hexOf(record.whole));
    } else if (record.field === PROBE_MAP && record.wireType === LEN) {
      entries.push(canonicalEntry(record.payload));
    } else if (PROBE_MESSAGES.has(record.field) && record.payload !== undefined) {
      declared.push(
        `${String(record.field)}:${String(record.wireType)}{${canonicalProbe(record.payload)}}`
      );
    } else {
      declared.push(hexOf(record.whole));
    }
  }

  return `${declared.join(',')}|${entries.sort().join(',')}|${unknown.sort().join(',')}`;
};

// a map entry's bytes in that form: what it reads as, its key and its value, each its last record
// or its default where the entry leaves it out, as a writer may: protobuf-es writes an empty key,
// Google.Protobuf leaves it out
const canonicalEntry = (bytes) => {
  const records = recordsOf(bytes);

  if (records === undefined) {
    return `raw:${hexOf(bytes)}`;
  }

  const key = records.findLast((record) => {
    return record.field === 1 && record.wireType === LEN;
  });
  const value = records.findLast((record) => {
    return record.field === 2 && record.wireType === LEN;
  });
  const others = records.filter((record) => {
    return record.field !== 1 && record.field !== 2;
  });

  return `${hexOf(key?.payload ?? [])}:{${canonicalProbe(value?.payload ?? new Uint8Array())}}${others
    .map((record) => {
      return `,${hexOf(record.whole)}`;
    })
    .join('')}`;
};

// ── The corpus ────────────────────────────────────────────────────────────────

/** The corpus's seed, and its size: a change of either is a change of the gate. */
export const CORPUS_SEED = 0x0bead028;
export const CORPUS_SIZE = 10_000;

// Probe's nesting the corpus reaches around: 17.9.3's bound, 100 below the top
const DEPTH_BOUND = 100;

/** mulberry32: a generator of numbers in [0, 1) from a 32-bit seed, the same on every platform. */
export const randomOf = (seed) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let mixed = state;

    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// what a corpus is written with: its numbers, and the faults it puts in a record now and then
const writerOf = (random) => {
  const below = (count) => {
    return Math.floor(random() * count);
  };
  const chance = (odds) => {
    return random() < odds;
  };
  const pick = (choices) => {
    return choices[below(choices.length)];
  };
  // a tag, its wire type or its encoding now and then not its own
  const faultyTag = (field, wireType, faults) => {
    if (!chance(faults)) {
      return tag(field, wireType);
    }

    return pick([
      () => {
        return tag(field, pick([0, 1, 2, 3, 4, 5, 6, 7].filter((each) => each !== wireType)));
      },
      () => {
        // a tag of six bytes, its value its own
        const bytes = tag(field, wireType);

        while (bytes.length < 6) {
          bytes[bytes.length - 1] |= 0x80;
          bytes.push(0);
        }

        return bytes;
      },
      () => {
        return tag(0, wireType);
      },
      () => {
        return varint((1n << 35n) | (BigInt(field) << 3n) | BigInt(wireType));
      },
    ])();
  };
  // a length, now and then off its payload, overlong, or past 32 bits
  const faultyLength = (length, faults) => {
    if (!chance(faults)) {
      return varint(length);
    }

    return pick([
      () => {
        return varint(length + 1 + below(3));
      },
      () => {
        return varint(Math.max(0, length - 1 - below(3)));
      },
      () => {
        return varint((1n << 32n) + BigInt(length));
      },
      () => {
        return [...Array.from({ length: 10 }, () => 0x80), 0];
      },
    ])();
  };
  const text = () => {
    return [...Buffer.from(pick(['', 'a', 'abc', 'é', '😀', 'zzzzzzzz', '\u0000']), 'utf8')];
  };
  const record = (field, wireType, payload, faults) => {
    if (wireType === LEN) {
      return [
        ...faultyTag(field, LEN, faults),
        ...faultyLength(payload.length, faults),
        ...payload,
      ];
    }

    if (wireType === SGROUP) {
      const close = chance(faults)
        ? pick([[], tag(field + 1, EGROUP), tag(field, SGROUP)])
        : tag(field, EGROUP);

      return [...faultyTag(field, SGROUP, faults), ...payload, ...close];
    }

    return [...faultyTag(field, wireType, faults), ...payload];
  };
  const unknownField = (faults) => {
    const field = pick([4, 5, 6, 9, 15, 20, 1000, 536_870_911]);

    return pick([
      () => {
        return record(field, VARINT, varint(below(1 << 20)), faults);
      },
      () => {
        return record(
          field,
          I64,
          Array.from({ length: 8 }, () => below(256)),
          faults
        );
      },
      () => {
        return record(
          field,
          I32,
          Array.from({ length: 4 }, () => below(256)),
          faults
        );
      },
      () => {
        return record(field, LEN, text(), faults);
      },
      () => {
        return record(field, SGROUP, record(1, VARINT, varint(below(100)), 0), faults);
      },
      () => {
        // a varint of eleven bytes
        return [...tag(field, VARINT), ...Array.from({ length: 10 }, () => 0x81), 0];
      },
    ])();
  };
  // a Probe `depth` below the top, its records in any order, some repeated
  const probe = (depth, faults) => {
    const parts = [];
    const count = below(depth === 0 ? 7 : 4);

    for (let index = 0; index < count; index += 1) {
      const nested = depth < 6 && chance(0.5 / (depth + 1));

      parts.push(
        pick([
          () => {
            return record(1, LEN, text(), faults);
          },
          () => {
            return record(2, VARINT, varint(below(2 ** 32)), faults);
          },
          () => {
            return nested ? record(3, LEN, probe(depth + 1, faults), faults) : [];
          },
          () => {
            const values = Array.from({ length: below(4) }, () => below(2 ** 32));

            return chance(0.5)
              ? record(10, LEN, values.flatMap(varint), faults)
              : values.flatMap((value) => record(10, VARINT, varint(value), faults));
          },
          () => {
            const values = Array.from({ length: below(4) }, () => {
              return Array.from({ length: 4 }, () => below(256));
            });

            return chance(0.5)
              ? record(11, LEN, values.flat(), faults)
              : values.flatMap((value) => record(11, I32, value, faults));
          },
          () => {
            const key = record(1, LEN, text(), faults);
            const value = nested ? record(2, LEN, probe(depth + 1, faults), faults) : [];
            const entry = chance(0.3) ? [...value, ...key] : [...key, ...value];

            return record(12, LEN, chance(0.1) ? [...entry, ...unknownField(0)] : entry, faults);
          },
          () => {
            return nested ? record(13, SGROUP, probe(depth + 1, faults), faults) : [];
          },
          () => {
            return unknownField(faults);
          },
        ])()
      );
    }

    return parts.flat();
  };
  // a Probe nested `levels` deep, each level a child, a map's value or a group
  const deep = (levels) => {
    let inner = probe(DEPTH_BOUND, 0);

    for (let level = 0; level < levels; level += 1) {
      inner = pick([
        () => {
          return record(3, LEN, inner, 0);
        },
        () => {
          // * an entry and its value, two messages below the one that holds the map
          return record(12, LEN, [...record(1, LEN, text(), 0), ...record(2, LEN, inner, 0)], 0);
        },
        () => {
          return record(13, SGROUP, inner, 0);
        },
      ])();
    }

    return inner;
  };

  return { below, chance, pick, probe, deep };
};

/** The corpus: `size` payloads of Probe from `seed`, each a byte array. */
export const corpusOf = ({ seed = CORPUS_SEED, size = CORPUS_SIZE } = {}) => {
  const random = randomOf(seed);
  const writer = writerOf(random);
  const payloads = [];

  for (let index = 0; index < size; index += 1) {
    const kind = writer.below(10);
    let bytes;

    if (kind < 3) {
      // a Probe as a writer writes one
      bytes = writer.probe(0, 0);
    } else if (kind < 7) {
      // a fault in a record now and then: a wire type, a tag, a length, a group's end
      bytes = writer.probe(0, 0.08);
    } else if (kind < 8) {
      // cut short anywhere
      const whole = writer.probe(0, 0);

      bytes = whole.slice(0, writer.below(whole.length + 1));
    } else if (kind < 9) {
      // a byte changed anywhere
      bytes = writer.probe(0, 0);

      if (bytes.length > 0) {
        bytes[writer.below(bytes.length)] = writer.below(256);
      }
    } else {
      // around the depth bound, through children, maps' entries and groups
      bytes = writer.deep(DEPTH_BOUND / 2 - 5 + writer.below(DEPTH_BOUND / 2 + 10));
    }

    payloads.push(Uint8Array.from(bytes));
  }

  return payloads;
};

// ── The exchange ──────────────────────────────────────────────────────────────

// ConformanceRequest's and ConformanceResponse's fields (the suite's conformance.proto)
const PROTOBUF_FORMAT = 1;
const BINARY_TEST = 1;
const RESPONSE_CASES = Object.freeze({
  1: 'parse_error',
  2: 'runtime_error',
  3: 'protobuf_payload',
  4: 'json_payload',
  5: 'skipped',
  6: 'serialize_error',
  7: 'jspb_payload',
  8: 'text_payload',
  9: 'timeout_error',
});

/** A ConformanceRequest of `payload`, for `messageType`, its output binary. */
export const requestOf = (payload, messageType) => {
  return Uint8Array.from([
    ...lengthDelimited(1, [...payload]),
    ...tag(3, VARINT),
    ...varint(PROTOBUF_FORMAT),
    ...lengthDelimited(4, [...Buffer.from(messageType, 'utf8')]),
    ...tag(5, VARINT),
    ...varint(BINARY_TEST),
  ]);
};

/** A ConformanceResponse's result: its case, and its bytes. */
export const responseOf = (bytes) => {
  const records = recordsOf(bytes);
  const result = records?.findLast((record) => {
    return record.field in RESPONSE_CASES && record.wireType === LEN;
  });

  if (result === undefined) {
    return { case: 'none', value: new Uint8Array() };
  }

  return { case: RESPONSE_CASES[result.field], value: result.payload };
};

// a testee spoken to as the runner speaks to one: a request after its length, a response alike
const testeeOf = ({ command, args, cwd }) => {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffered = Buffer.alloc(0);
  let waiting;
  let ended;

  const settle = () => {
    if (waiting === undefined) {
      return;
    }

    if (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
      const length = buffered.readUInt32LE(0);
      const response = buffered.subarray(4, 4 + length);
      const { resolve: done } = waiting;

      buffered = buffered.subarray(4 + length);
      waiting = undefined;
      done(response);
    } else if (ended !== undefined) {
      const { reject } = waiting;

      waiting = undefined;
      reject(new Error(`${command} ${args.join(' ')} ended: ${ended}`));
    }
  };

  child.stdout.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    settle();
  });
  child.on('close', (code, signal) => {
    ended = signal ?? `exit ${String(code)}`;
    settle();
  });
  child.on('error', (error) => {
    ended = error.message;
    settle();
  });
  // ! a testee that ended closes its input: the write fails, and the exchange with it
  child.stdin.on('error', (error) => {
    ended ??= error.message;
    settle();
  });

  return {
    exchange: (request) => {
      return new Promise((done, reject) => {
        const head = Buffer.alloc(4);

        head.writeUInt32LE(request.length, 0);
        waiting = { resolve: done, reject };
        child.stdin.write(Buffer.concat([head, request]));
        settle();
      });
    },
    close: () => {
      child.stdin.end();
    },
  };
};

/** A side's verdict on one payload: `read` and the bytes written back, or `refused`. */
export const verdictOf = (response) => {
  if (response.case === 'protobuf_payload') {
    return { read: true, written: response.value };
  }

  if (response.case === 'parse_error') {
    return { read: false };
  }

  throw new Error(
    `the testee answered ${response.case}: ${Buffer.from(response.value).toString('utf8')}`
  );
};

/** How two verdicts on one payload part, or nothing when they agree. */
export const parting = (typescript, csharp) => {
  if (typescript.read !== csharp.read) {
    return typescript.read
      ? 'TypeScript reads it, C# refuses it'
      : 'C# reads it, TypeScript refuses it';
  }

  if (!typescript.read) {
    return undefined;
  }

  return canonicalProbe(typescript.written) === canonicalProbe(csharp.written)
    ? undefined
    : `both read it and write back apart: TypeScript ${hexOf(typescript.written)}, C# ${hexOf(csharp.written)}`;
};

// ── Steps ─────────────────────────────────────────────────────────────────────

const run = (command, args, options = {}) => {
  const done = spawnSync(command, args, { stdio: 'inherit', ...options });

  if (done.error !== undefined) {
    throw done.error;
  }

  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}: exit ${String(done.status ?? done.signal)}`);
  }
};

// the runner's package, fetched by its pin and unpacked, or as it is when its integrity is the pin's
const fetchRunner = async (pin) => {
  const target = join(RUNNER, pin.version);
  const mark = join(target, '.integrity');

  if (existsSync(mark) && readFileSync(mark, 'utf8') === pin.integrity) {
    return join(target, 'package');
  }

  const response = await fetch(pin.tarball);

  if (!response.ok) {
    throw new Error(`${pin.tarball}: ${String(response.status)} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = integrityOf(bytes);

  // ! nothing of the tarball is read before its integrity is the pin's
  if (actual !== pin.integrity) {
    throw new Error(`${pin.tarball}: ${actual}, where the pin says ${pin.integrity}`);
  }

  rmSync(target, { force: true, recursive: true });
  mkdirSync(target, { recursive: true });

  const tarball = join(target, 'package.tgz');

  writeFileSync(tarball, bytes);
  run('tar', ['-xzf', 'package.tgz'], { cwd: target });
  rmSync(tarball);
  writeFileSync(mark, pin.integrity);

  return join(target, 'package');
};

// protoc for beadc's C# messages: the environment's, or the pinned one fetched
const protocOf = () => {
  return (
    process.env.BEADC_PROTOC ??
    execFileSync(process.execPath, [FETCH_PROTOC], { encoding: 'utf8' }).trim()
  );
};

// beadc's output for `side`, generated over the suite's protos and copied into its testee
const generate = ({ side, runner, protoc }) => {
  const work = join(WORK, side.language);
  const proto = join(work, 'proto');

  rmSync(work, { force: true, recursive: true });
  mkdirSync(join(proto, TEST_FOLDER), { recursive: true });
  mkdirSync(join(proto, 'conformance'), { recursive: true });

  const include = join(runner, 'include');

  // * out of google/protobuf/, where beadc writes no message: nothing imports them by path, and
  // the runner names each message by its full name
  for (const file of TEST_MESSAGES) {
    cpSync(join(include, 'google', 'protobuf', file), join(proto, TEST_FOLDER, file));
  }

  cpSync(
    join(include, 'conformance', 'conformance.proto'),
    join(proto, 'conformance', 'conformance.proto')
  );
  cpSync(join(ROOT, 'spec', 'codecs.proto'), join(proto, 'codecs.proto'));
  cpSync(join(HERE, 'service.proto'), join(proto, 'service.proto'));
  writeFileSync(
    join(work, 'beadc.yaml'),
    `version: 1\nsource:\n  proto: [proto]\noutputs:\n  - language: ${side.language}\n    out: gen\n`
  );
  run(process.execPath, [BEADC, 'generate'], {
    cwd: work,
    env: { ...process.env, BEADC_PROTOC: protoc },
  });

  const generated = join(ROOT, side.folder, side.generated);

  rmSync(generated, { force: true, recursive: true });
  cpSync(join(work, 'gen'), generated, { recursive: true });

  return work;
};

// the command that runs `side`'s testee, built first where it builds
const testeeCommandOf = ({ side, work }) => {
  const folder = join(ROOT, side.folder);

  if (side.language === 'typescript') {
    // * its own tsconfig.json, which reads the code generated into it: the side's type-check and
    // lint leave the testee out, since neither can read it without that code
    run(process.execPath, [TYPESCRIPT_COMPILER, '--noEmit', '-p', folder]);

    return { command: process.execPath, args: [join(folder, 'testee.ts')], cwd: folder };
  }

  const out = join(work, 'out');

  run('dotnet', [
    'build',
    join(folder, 'Bead.ProtobufConformance.csproj'),
    '-c',
    'Release',
    '-o',
    out,
    '-nologo',
  ]);

  return { command: 'dotnet', args: [join(out, 'Bead.ProtobufConformance.dll')], cwd: folder };
};

// `side`'s testee under the runner, then the floor
const suite = ({ side, runner, pin, protoc }) => {
  const work = generate({ side, runner, protoc });
  const testee = testeeCommandOf({ side, work });
  const wrapper = join(work, 'testee.sh');
  const quoted = (each) => {
    return `'${each.replaceAll("'", "'\\''")}'`;
  };

  // * the runner takes an executable and no argument
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncd ${quoted(testee.cwd)} && exec ${[testee.command, ...testee.args].map(quoted).join(' ')}\n`
  );
  chmodSync(wrapper, 0o755);

  const done = spawnSync(
    process.execPath,
    [
      join(runner, 'conformance_test_runner.cjs'),
      '--enforce_recommended',
      '--maximum_edition',
      'MAX',
      '--failure_list',
      join(ROOT, side.folder, 'failing.txt'),
      '--output_dir',
      work,
      wrapper,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 }
  );
  const output = `${done.stdout ?? ''}${done.stderr ?? ''}`;

  process.stdout.write(output);

  const breaches = [
    ...(done.status === 0 ? [] : [`the runner exited ${String(done.status ?? done.signal)}`]),
    ...floorBreaches(summariesOf(output), pin.floor),
  ];

  if (breaches.length > 0) {
    throw new Error(`${side.language}: ${breaches.join('; ')}`);
  }

  process.stdout.write(
    `protobuf-conformance: ${side.language} holds the floor, ${pin.floor
      .map((suite) => {
        return `${String(suite.tests)} tests and ${String(suite.skipped)} skipped of the ${suite.suite} suite`;
      })
      .join(', ')}\n`
  );
};

// the corpus through both testees, each payload's verdicts compared
const differential = async ({ runner, protoc }) => {
  const testees = {};

  for (const side of Object.values(SIDES)) {
    testees[side.language] = testeeOf(
      testeeCommandOf({ side, work: generate({ side, runner, protoc }) })
    );
  }

  const partings = [];
  const corpus = corpusOf();

  try {
    for (const [index, payload] of corpus.entries()) {
      const request = requestOf(payload, 'bead.codecs.v1.Probe');
      const typescript = verdictOf(responseOf(await testees.typescript.exchange(request)));
      const csharp = verdictOf(responseOf(await testees.csharp.exchange(request)));
      const parted = parting(typescript, csharp);

      if (parted !== undefined) {
        partings.push(`payload ${String(index)}, ${hexOf(payload)}: ${parted}`);
      }
    }
  } finally {
    testees.typescript.close();
    testees.csharp.close();
  }

  if (partings.length > 0) {
    throw new Error(
      `the sides part on ${String(partings.length)} payloads:\n${partings.join('\n')}`
    );
  }

  process.stdout.write(
    `protobuf-conformance: both sides read ${String(corpus.length)} payloads alike\n`
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

const main = async (command) => {
  if (command !== 'differential' && !(command in SIDES)) {
    throw new Error('usage: node tools/protobuf-conformance.mjs typescript|csharp|differential');
  }

  const pin = readPin(readFileSync(PIN_FILE, 'utf8'));
  const disagreement = pinDisagreement(pin, googleProtobufOf(readFileSync(PACKAGES, 'utf8')));

  if (disagreement !== undefined) {
    throw new Error(disagreement);
  }

  const runner = await fetchRunner(pin);
  const protoc = protocOf();

  if (command === 'differential') {
    await differential({ runner, protoc });
  } else {
    suite({ side: SIDES[command], runner, pin, protoc });
  }
};

if (import.meta.main) {
  try {
    await main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`protobuf-conformance: ${error.message}\n`);
    process.exit(1);
  }
}
