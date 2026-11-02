import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  canonicalProbe,
  codecsSeedsOf,
  corpusOf,
  CORPUS_SIZE,
  DIFFERENTIAL_SIDES,
  floorBreaches,
  googleProtobufOf,
  holdsUnwritten,
  integrityOf,
  LEN,
  lengthDelimited,
  parting,
  partingOfAll,
  pinDisagreement,
  readPin,
  recordsOf,
  releaseOf,
  requestOf,
  responseOf,
  RUST_SET_FILES,
  SGROUP,
  SIDES,
  summariesOf,
  tag,
  varint,
  verdictOf,
  VARINT,
} from '../protobuf-conformance.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const PIN = readPin(
  readFileSync(new URL('../protobuf-conformance/runner.json', import.meta.url), 'utf8')
);
const PACKAGES = readFileSync(
  new URL('../../implementations/dotnet/Directory.Packages.props', import.meta.url),
  'utf8'
);

// the runner's own lines, as it closes each of its two suites
const summaryLine = (state, counts) => {
  return `CONFORMANCE SUITE ${state}: ${String(counts[0])} successes, ${String(counts[1])} skipped, ${String(counts[2])} expected failures, ${String(counts[3])} unexpected failures.\n`;
};
const TEXT_FORMAT = summaryLine('PASSED', [0, 909, 0, 0]);
const PASSED_CSHARP = `CONFORMANCE TEST BEGIN ====================================\n\n${summaryLine('PASSED', [5594, 48, 7, 0])}${TEXT_FORMAT}`;
const PASSED_TYPESCRIPT = `${summaryLine('PASSED', [5598, 48, 3, 0])}${TEXT_FORMAT}`;
const FAILED = `${summaryLine('FAILED', [5598, 48, 2, 1])}${TEXT_FORMAT}`;

// two sides, as a parting names them
const TWO = Object.freeze(['TypeScript', 'C#']);

const bytesOf = (...parts) => {
  return Uint8Array.from(parts.flat());
};

// the SHA-256 of payloads' lowercase hexadecimal, a line each
const lineDigestOf = (payloads) => {
  const hash = createHash('sha256');

  for (const payload of payloads) {
    hash.update(`${Buffer.from(payload).toString('hex')}\n`);
  }

  return hash.digest('hex');
};

// ── Pin ───────────────────────────────────────────────────────────────────────

describe('the pin', () => {
  test("pins the runner by its tarball, its release and npm's sha512, and the floor", () => {
    assert.equal(PIN.package, 'protobuf-conformance');
    assert.match(PIN.tarball, /^https:\/\/registry\.npmjs\.org\/protobuf-conformance\/-\//u);
    assert.match(PIN.integrity, /^sha512-/u);
    assert.deepEqual(PIN.floor, [
      { suite: 'binary and JSON', tests: 5601, skipped: 48 },
      { suite: 'text format', tests: 0, skipped: 909 },
    ]);
    assert.throws(() => {
      return readPin(JSON.stringify({ ...PIN, integrity: 'sha1-abc' }));
    }, /npm's sha512/u);
    assert.throws(() => {
      return readPin(
        JSON.stringify({ ...PIN, floor: [{ suite: 'binary and JSON', tests: 5601 }] })
      );
    }, /floor/u);
  });

  test("reads an integrity as npm's dist.integrity writes it", () => {
    assert.equal(
      integrityOf(Buffer.from('bead')),
      `sha512-${createHash('sha512').update('bead').digest('base64')}`
    );
  });

  test("holds the runner's release to Google.Protobuf's, v36.2 to 3.36.2", () => {
    assert.equal(releaseOf('v36.2'), '36.2');
    assert.equal(releaseOf('3.36.2'), '36.2');
    assert.equal(releaseOf('3.37.0-rc1'), '37.0');
    assert.throws(() => {
      return releaseOf('36');
    }, /no protobuf release/u);
    assert.equal(pinDisagreement(PIN, googleProtobufOf(PACKAGES)), undefined);
    assert.match(pinDisagreement(PIN, '3.37.1') ?? '', /runs protobuf v36\.2.*3\.37\.1/u);
    assert.equal(
      googleProtobufOf('<PackageVersion Include="Google.Protobuf" Version="3.36.2" />'),
      '3.36.2'
    );
    assert.throws(() => {
      return googleProtobufOf('<Project />');
    }, /no Google\.Protobuf/u);
  });

  test("names each side's testee, its generated folder within it", () => {
    assert.deepEqual(Object.keys(SIDES), ['typescript', 'csharp', 'rust']);
    assert.equal(SIDES.typescript.folder, 'implementations/typescript/tools/protobuf-conformance');
    assert.equal(SIDES.csharp.folder, 'implementations/dotnet/tools/Bead.ProtobufConformance');
    assert.equal(SIDES.rust.folder, 'implementations/rust/tools/protobuf-conformance');
  });

  test("gives the Rust side's testee the set of the suite's protos and Probe, and reads the differential through every side", () => {
    assert.equal(SIDES.rust.generated, 'generated');
    assert.deepEqual(RUST_SET_FILES, [
      'protobuf_test_messages/test_messages_edition2023.proto',
      'protobuf_test_messages/test_messages_proto2.proto',
      'protobuf_test_messages/test_messages_proto2_editions.proto',
      'protobuf_test_messages/test_messages_proto3.proto',
      'protobuf_test_messages/test_messages_proto3_editions.proto',
      'conformance/conformance.proto',
      'codecs.proto',
    ]);

    // * its build script names the same files, in the same order
    const build = readFileSync(
      new URL('../../implementations/rust/tools/protobuf-conformance/build.rs', import.meta.url),
      'utf8'
    );

    assert.deepEqual(
      [...build.matchAll(/^\s+"([^"]+\.proto)",$/gmu)].map((line) => {
        return line[1];
      }),
      RUST_SET_FILES
    );
    assert.deepEqual(DIFFERENTIAL_SIDES, ['typescript', 'csharp', 'rust']);
  });
});

// ── The floor ─────────────────────────────────────────────────────────────────

describe('the floor', () => {
  test("reads each suite's summary, in the runner's order", () => {
    assert.deepEqual(summariesOf(PASSED_CSHARP), [
      { passed: true, successes: 5594, skipped: 48, expected: 7, unexpected: 0 },
      { passed: true, successes: 0, skipped: 909, expected: 0, unexpected: 0 },
    ]);
    assert.deepEqual(summariesOf('no summary'), []);
  });

  test("holds each suite's successes and expected failures to its floor, and its skips alike", () => {
    assert.deepEqual(floorBreaches(summariesOf(PASSED_CSHARP), PIN.floor), []);
    assert.deepEqual(floorBreaches(summariesOf(PASSED_TYPESCRIPT), PIN.floor), []);
    assert.deepEqual(floorBreaches(summariesOf(FAILED), PIN.floor), [
      'the binary and JSON suite: failed: 1 unexpected failures',
      'the binary and JSON suite: 5598 successes and 2 expected failures, where the floor is 5601 tests',
    ]);
    // * a testee that lacks the messages passes the runner, and fails the floor
    assert.deepEqual(
      floorBreaches(
        summariesOf(`${summaryLine('PASSED', [0, 909, 0, 0])}${TEXT_FORMAT}`),
        PIN.floor
      ),
      [
        'the binary and JSON suite: 0 successes and 0 expected failures, where the floor is 5601 tests',
        'the binary and JSON suite: 909 tests skipped, where the floor is 48',
      ]
    );
    assert.deepEqual(floorBreaches([], PIN.floor), [
      'the runner closed 0 suites, where the floor names 2',
    ]);
  });
});

// ── Wire ──────────────────────────────────────────────────────────────────────

describe('the wire', () => {
  test('writes varints and tags as protobuf does', () => {
    assert.deepEqual(varint(0), [0]);
    assert.deepEqual(varint(300), [0xac, 0x02]);
    assert.deepEqual(varint(2n ** 64n - 1n), [...Array.from({ length: 9 }, () => 0xff), 0x01]);
    assert.deepEqual(tag(1, LEN), [0x0a]);
    assert.deepEqual(tag(13, SGROUP), [0x6b]);
  });

  test('reads records, a group whole, and refuses what does not read', () => {
    const records = recordsOf(bytesOf([0x08, 0x96, 0x01], [0x6b, 0x0a, 0x01, 0x61, 0x6c]));

    assert.deepEqual(
      records?.map((record) => {
        return [record.field, record.wireType, Buffer.from(record.payload ?? []).toString('hex')];
      }),
      [
        [1, VARINT, ''],
        [13, SGROUP, '0a0161'],
      ]
    );
    assert.equal(recordsOf(bytesOf([0x0a, 0x05, 0x61])), undefined);
    assert.equal(recordsOf(bytesOf([0x6b, 0x0a, 0x01, 0x61, 0x74])), undefined);
    assert.equal(recordsOf(bytesOf([0x0e])), undefined);
    assert.equal(
      recordsOf(
        bytesOf(
          [0x08],
          Array.from({ length: 10 }, () => 0x81),
          [0]
        )
      ),
      undefined
    );
  });
});

// ── The exchange ──────────────────────────────────────────────────────────────

describe('the exchange', () => {
  test('asks for a binary reading of a message by its full name', () => {
    const records = recordsOf(requestOf(Uint8Array.from([0x0a, 0x00]), 'bead.codecs.v1.Probe'));

    assert.deepEqual(
      records?.map((record) => {
        return [record.field, Buffer.from(record.whole).toString('hex')];
      }),
      [
        [1, '0a020a00'],
        [3, '1801'],
        [4, `2214${Buffer.from('bead.codecs.v1.Probe').toString('hex')}`],
        [5, '2801'],
      ]
    );
  });

  test("reads a response's result, and fails on any but a reading or a refusal", () => {
    const read = responseOf(Uint8Array.from(lengthDelimited(3, [0x10, 0x01])));
    const refused = responseOf(Uint8Array.from(lengthDelimited(1, [...Buffer.from('cut')])));

    assert.equal(read.case, 'protobuf_payload');
    assert.deepEqual(verdictOf(read), { read: true, written: Uint8Array.from([0x10, 0x01]) });
    assert.deepEqual(verdictOf(refused), { read: false });
    assert.throws(() => {
      return verdictOf(responseOf(Uint8Array.from(lengthDelimited(2, [...Buffer.from('no')]))));
    }, /runtime_error: no/u);
    assert.throws(() => {
      return verdictOf(responseOf(Uint8Array.from(lengthDelimited(5, [...Buffer.from('json')]))));
    }, /skipped/u);
  });

  test("reads a writer's refusal of what its reader took as a reading, nothing written back", () => {
    const unwritten = responseOf(
      Uint8Array.from(lengthDelimited(6, [...Buffer.from('nested past 100')]))
    );

    assert.equal(unwritten.case, 'serialize_error');
    assert.deepEqual(verdictOf(unwritten), { read: true, written: undefined });
  });
});

// ── The comparison ────────────────────────────────────────────────────────────

describe('the comparison', () => {
  // text "a", then two unknown fields, then a map's two entries
  const entry = (key) => {
    return lengthDelimited(12, [...lengthDelimited(1, [key]), ...lengthDelimited(2, [0x10, 0x01])]);
  };
  const unknownA = [0x20, 0x01];
  const unknownB = lengthDelimited(9, [0x61]);

  test("ignores the order of a message's unknown fields and of its map's entries, at every depth", () => {
    const one = bytesOf(lengthDelimited(1, [0x61]), entry(0x61), entry(0x62), unknownA, unknownB);
    const other = bytesOf(lengthDelimited(1, [0x61]), entry(0x62), entry(0x61), unknownB, unknownA);

    assert.equal(canonicalProbe(one), canonicalProbe(other));
    assert.equal(
      canonicalProbe(bytesOf(lengthDelimited(3, one))),
      canonicalProbe(bytesOf(lengthDelimited(3, other)))
    );
    assert.equal(
      parting(
        [
          { read: true, written: one },
          { read: true, written: other },
        ],
        { names: TWO }
      ),
      undefined
    );
  });

  test("reads a map's entry as its key and its value, an empty key written or left out", () => {
    // * protobuf-es writes the entry 0a 00 12 00, Google.Protobuf 12 00: both read "" to an empty Probe
    assert.equal(
      canonicalProbe(bytesOf(lengthDelimited(12, [0x0a, 0x00, 0x12, 0x00]))),
      canonicalProbe(bytesOf(lengthDelimited(12, [0x12, 0x00])))
    );
    assert.notEqual(
      canonicalProbe(bytesOf(lengthDelimited(12, [0x0a, 0x01, 0x61, 0x12, 0x00]))),
      canonicalProbe(bytesOf(lengthDelimited(12, [0x12, 0x00])))
    );
  });

  test('reads an unknown varint by its value, an overlong form kept or made minimal, and its tag by its number', () => {
    // * protobuf-es writes back an unknown varint of 10 bytes as it read it, Google.Protobuf and
    // Buffa its value in one
    const overlong = bytesOf([0x48, ...Array.from({ length: 9 }, () => 0x80), 0x00]);

    assert.equal(canonicalProbe(overlong), canonicalProbe(bytesOf([0x48, 0x00])));
    assert.equal(
      canonicalProbe(bytesOf([0xc8, 0x80, 0x00, 0x05])),
      canonicalProbe(bytesOf([0x48, 0x05]))
    );
    assert.notEqual(canonicalProbe(overlong), canonicalProbe(bytesOf([0x48, 0x01])));
    assert.notEqual(canonicalProbe(bytesOf([0x48, 0x01])), canonicalProbe(bytesOf([0x50, 0x01])));
    assert.notEqual(
      canonicalProbe(bytesOf(lengthDelimited(9, [0x61]))),
      canonicalProbe(bytesOf(lengthDelimited(9, [0x62])))
    );
  });

  test('keeps every other difference: a declared value, the order of declared records, a verdict', () => {
    const one = bytesOf(lengthDelimited(1, [0x61]), [0x10, 0x01]);

    assert.notEqual(
      canonicalProbe(one),
      canonicalProbe(bytesOf(lengthDelimited(1, [0x62]), [0x10, 0x01]))
    );
    assert.notEqual(
      canonicalProbe(one),
      canonicalProbe(bytesOf([0x10, 0x01], lengthDelimited(1, [0x61])))
    );
    assert.match(
      parting(
        [
          { read: true, written: one },
          { read: true, written: bytesOf([0x10, 0x02]) },
        ],
        { names: TWO }
      ) ?? '',
      /write back apart/u
    );
    assert.equal(
      parting([{ read: true, written: one }, { read: false }], { names: TWO }),
      'TypeScript reads it, C# refuses it'
    );
    assert.equal(parting([{ read: false }, { read: false }], { names: TWO }), undefined);
  });

  test('names the two sides that part, whichever pair it is', () => {
    const read = { read: true, written: bytesOf([0x10, 0x01]) };
    const apart = { read: true, written: bytesOf([0x10, 0x02]) };
    const refused = { read: false };
    const names = DIFFERENTIAL_SIDES.map((language) => {
      return SIDES[language].name;
    });

    assert.deepEqual(names, ['TypeScript', 'C#', 'Rust']);
    assert.equal(
      parting([refused, read], { names: ['Rust', 'C#'] }),
      'Rust refuses it, C# reads it'
    );
    assert.equal(
      parting([read, apart], { names: ['C#', 'Rust'] }),
      'both read it and write back apart: C# 1001, Rust 1002'
    );
    assert.equal(partingOfAll([read, read, read], { names }), undefined);
    assert.equal(partingOfAll([refused, refused, refused], { names }), undefined);
    assert.equal(
      partingOfAll([read, read, refused], { names }),
      'TypeScript reads it, writing back 1001; C# reads it, writing back 1001; Rust refuses it'
    );
    assert.equal(
      partingOfAll([read, apart, read], { names }),
      'TypeScript reads it, writing back 1001; C# reads it, writing back 1002; Rust reads it, writing back 1001'
    );
  });

  test('parts a side that writes back what another refuses to write, and none where both refuse', () => {
    const read = { read: true, written: bytesOf([0x10, 0x01]) };
    const unwritten = { read: true, written: undefined };
    const names = ['TypeScript', 'C#', 'Rust'];

    assert.equal(parting([unwritten, unwritten], { names: TWO }), undefined);
    assert.equal(
      parting([unwritten, read], { names: TWO }),
      'both read it, TypeScript refuses to write it back, C# writes 1001'
    );
    assert.equal(
      parting([read, unwritten], { names: TWO }),
      'both read it, TypeScript writes 1001, C# refuses to write it back'
    );
    assert.equal(
      parting([unwritten, { read: false }], { names: TWO }),
      'TypeScript reads it, C# refuses it'
    );
    assert.equal(
      partingOfAll([unwritten, { read: false }, { read: false }], { names }),
      'TypeScript reads it, refusing to write it back; C# refuses it; Rust refuses it'
    );
  });
});

// ── The corpus ────────────────────────────────────────────────────────────────

describe('the corpus', () => {
  test('is the same from its seed on every run, and reaches what the check refuses and what it reads', () => {
    const corpus = corpusOf();
    const digest = (payloads) => {
      const hash = createHash('sha256');

      for (const payload of payloads) {
        hash.update(payload);
      }

      return hash.digest('hex');
    };

    assert.equal(corpus.length, CORPUS_SIZE);
    assert.equal(digest(corpusOf()), digest(corpus));
    assert.notEqual(digest(corpusOf({ seed: 1 })), digest(corpus));

    const readable = corpus.filter((payload) => {
      return recordsOf(payload) !== undefined;
    });
    const fieldsOf = (payload) => {
      return new Set(recordsOf(payload)?.map((record) => record.field) ?? []);
    };

    // * both outcomes, and each of Probe's records among those that read
    assert.ok(readable.length > CORPUS_SIZE / 4, `${String(readable.length)} read as records`);
    assert.ok(readable.length < CORPUS_SIZE, 'some do not read');

    for (const field of [1, 2, 3, 10, 11, 12, 13]) {
      assert.ok(
        readable.some((payload) => fieldsOf(payload).has(field)),
        `field ${String(field)} is reached`
      );
    }
  });

  test('keeps its seed and its size: the same payloads, a line of hexadecimal each, digested', () => {
    // * a change of this digest is a change of the gate
    assert.equal(
      lineDigestOf(corpusOf()),
      '7b1e5a69e6e423f8869c98047f5b7116e22e6dfbb6ba472126e5c32f18719ca4'
    );
  });

  test("seeds itself from codecs.json's proto payloads, but those that hold needs, needs_items or shade and those a differs excuses", () => {
    const codecs = JSON.parse(
      readFileSync(new URL('../../spec/codecs.json', import.meta.url), 'utf8')
    );
    const seeds = codecsSeedsOf(codecs);
    const named = (name) => {
      const entry = codecs.payloads.find((each) => {
        return each.name === name;
      });

      return Uint8Array.from(Buffer.from(entry.bytes.replaceAll(/[\s|]/gu, ''), 'hex'));
    };
    const has = (bytes) => {
      return seeds.some((seed) => {
        return Buffer.from(seed).equals(Buffer.from(bytes));
      });
    };

    assert.equal(seeds.length, 67);
    assert.ok(has(named('an empty payload')));
    assert.ok(has(named('100 groups below the top')));
    assert.ok(has(named('a varint of 10 bytes')));
    assert.ok(!has(named('a required field unset, one below the top')));
    assert.ok(!has(named("a map's value whose message leaves a required field unset")));
    assert.ok(!has(named("a string's leading U+FEFF")));
  });

  test('draws its seeds after its own payloads, each as it is and mutated, none holding a field it writes none of', () => {
    const seeds = [
      bytesOf(lengthDelimited(1, [0x61]), [0x10, 0x07]),
      bytesOf(lengthDelimited(3, [0x10, 0x01])),
    ];
    const corpus = corpusOf({ size: 50, seeds });

    assert.deepEqual(corpus.slice(0, 50), corpusOf({ size: 50 }));
    assert.equal(corpus.length, 50 + 5 * seeds.length);
    assert.deepEqual(corpus[50], seeds[0]);
    assert.deepEqual(corpus[55], seeds[1]);
    assert.deepEqual(corpusOf({ size: 50, seeds }), corpus);
    assert.ok(
      corpus.every((payload) => {
        return !holdsUnwritten(payload);
      })
    );
  });

  test('finds needs, needs_items and shade through a child, a group and a map’s value, and in nothing else', () => {
    const needs = lengthDelimited(7, [0x08, 0x01]);

    assert.ok(holdsUnwritten(bytesOf(needs)));
    assert.ok(holdsUnwritten(bytesOf([0x70, 0x01])));
    assert.ok(holdsUnwritten(bytesOf(lengthDelimited(3, needs))));
    assert.ok(holdsUnwritten(bytesOf(tag(13, SGROUP), needs, tag(13, 4))));
    assert.ok(
      holdsUnwritten(
        bytesOf(lengthDelimited(12, [...lengthDelimited(1, [0x61]), ...lengthDelimited(2, needs)]))
      )
    );
    assert.ok(!holdsUnwritten(bytesOf(lengthDelimited(9, needs))));
    assert.ok(!holdsUnwritten(bytesOf(lengthDelimited(1, [0x61]))));
    assert.ok(!holdsUnwritten(bytesOf([0x0a, 0x05, 0x61])));
  });
});
