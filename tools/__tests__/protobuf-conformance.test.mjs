import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  canonicalProbe,
  corpusOf,
  CORPUS_SIZE,
  floorBreaches,
  googleProtobufOf,
  integrityOf,
  LEN,
  lengthDelimited,
  parting,
  pinDisagreement,
  readPin,
  recordsOf,
  releaseOf,
  requestOf,
  responseOf,
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
const PASSED_CSHARP = `CONFORMANCE TEST BEGIN ====================================\n\n${summaryLine('PASSED', [2828, 2816, 5, 0])}${TEXT_FORMAT}`;
const PASSED_TYPESCRIPT = `${summaryLine('PASSED', [2832, 2816, 1, 0])}${TEXT_FORMAT}`;
const FAILED = `${summaryLine('FAILED', [2832, 2816, 0, 1])}${TEXT_FORMAT}`;

const bytesOf = (...parts) => {
  return Uint8Array.from(parts.flat());
};

// ── Pin ───────────────────────────────────────────────────────────────────────

describe('the pin', () => {
  test("pins the runner by its tarball, its release and npm's sha512, and the floor", () => {
    assert.equal(PIN.package, 'protobuf-conformance');
    assert.match(PIN.tarball, /^https:\/\/registry\.npmjs\.org\/protobuf-conformance\/-\//u);
    assert.match(PIN.integrity, /^sha512-/u);
    assert.deepEqual(PIN.floor, [
      { suite: 'binary and JSON', tests: 2833, skipped: 2816 },
      { suite: 'text format', tests: 0, skipped: 909 },
    ]);
    assert.throws(() => {
      return readPin(JSON.stringify({ ...PIN, integrity: 'sha1-abc' }));
    }, /npm's sha512/u);
    assert.throws(() => {
      return readPin(
        JSON.stringify({ ...PIN, floor: [{ suite: 'binary and JSON', tests: 2833 }] })
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
    assert.deepEqual(Object.keys(SIDES), ['typescript', 'csharp']);
    assert.equal(SIDES.typescript.folder, 'implementations/typescript/tools/protobuf-conformance');
    assert.equal(SIDES.csharp.folder, 'implementations/dotnet/tools/Bead.ProtobufConformance');
  });
});

// ── The floor ─────────────────────────────────────────────────────────────────

describe('the floor', () => {
  test("reads each suite's summary, in the runner's order", () => {
    assert.deepEqual(summariesOf(PASSED_CSHARP), [
      { passed: true, successes: 2828, skipped: 2816, expected: 5, unexpected: 0 },
      { passed: true, successes: 0, skipped: 909, expected: 0, unexpected: 0 },
    ]);
    assert.deepEqual(summariesOf('no summary'), []);
  });

  test("holds each suite's successes and expected failures to its floor, and its skips alike", () => {
    assert.deepEqual(floorBreaches(summariesOf(PASSED_CSHARP), PIN.floor), []);
    assert.deepEqual(floorBreaches(summariesOf(PASSED_TYPESCRIPT), PIN.floor), []);
    assert.deepEqual(floorBreaches(summariesOf(FAILED), PIN.floor), [
      'the binary and JSON suite: failed: 1 unexpected failures',
      'the binary and JSON suite: 2832 successes and 0 expected failures, where the floor is 2833 tests',
    ]);
    // * a testee that lacks the messages passes the runner, and fails the floor
    assert.deepEqual(
      floorBreaches(
        summariesOf(`${summaryLine('PASSED', [0, 909, 0, 0])}${TEXT_FORMAT}`),
        PIN.floor
      ),
      [
        'the binary and JSON suite: 0 successes and 0 expected failures, where the floor is 2833 tests',
        'the binary and JSON suite: 909 tests skipped, where the floor is 2816',
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
    assert.equal(parting({ read: true, written: one }, { read: true, written: other }), undefined);
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
      parting({ read: true, written: one }, { read: true, written: bytesOf([0x10, 0x02]) }) ?? '',
      /write back apart/u
    );
    assert.equal(
      parting({ read: true, written: one }, { read: false }),
      'TypeScript reads it, C# refuses it'
    );
    assert.equal(parting({ read: false }, { read: false }), undefined);
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
});
