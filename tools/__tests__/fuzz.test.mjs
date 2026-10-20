import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  argumentsOf,
  headSeedsOf,
  hexBytesOf,
  hexUnder,
  pinDisagreement,
  readPin,
  seedNameOf,
  seedsOf,
  sha256Of,
  sharpFuzzOf,
  TARGETS,
} from '../fuzz.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const PIN = readPin(readFileSync(new URL('../fuzz/fuzzer.json', import.meta.url), 'utf8'));
const PACKAGES = readFileSync(
  new URL('../../implementations/dotnet/Directory.Packages.props', import.meta.url),
  'utf8'
);

const specOf = (name) => {
  return JSON.parse(readFileSync(new URL(`../../spec/${name}`, import.meta.url), 'utf8'));
};

const SEEDS = seedsOf({
  codecs: specOf('codecs.json'),
  conversations: specOf('conversations.json'),
  debugFilters: specOf('debug-filters.json'),
  transports: specOf('transports.json'),
  vectors: specOf('vectors.json'),
});

const textOf = (bytes) => {
  return Buffer.from(bytes).toString('latin1');
};

// ── Pin ───────────────────────────────────────────────────────────────────────

describe('the pin', () => {
  test("pins libfuzzer-dotnet's Windows build by its release and SHA-256, and SharpFuzz's instrumenter", () => {
    assert.equal(PIN.libfuzzerDotnet.asset, 'libfuzzer-dotnet-windows.exe');
    assert.ok(
      PIN.libfuzzerDotnet.url.startsWith(
        `https://github.com/${PIN.libfuzzerDotnet.repository}/releases/download/${PIN.libfuzzerDotnet.release}/`
      )
    );
    assert.equal(PIN.sharpfuzz.package, 'SharpFuzz.CommandLine');
    assert.throws(() => {
      return readPin(
        JSON.stringify({ ...PIN, libfuzzerDotnet: { ...PIN.libfuzzerDotnet, sha256: 'ABC' } })
      );
    }, /64 lower-case hexadecimal digits/u);
    assert.throws(() => {
      return readPin(JSON.stringify({ libfuzzerDotnet: PIN.libfuzzerDotnet }));
    }, /sharpfuzz/u);
  });

  test("holds the instrumenter's version to the SharpFuzz library's", () => {
    assert.equal(pinDisagreement(PIN, sharpFuzzOf(PACKAGES)), undefined);
    assert.match(
      pinDisagreement(PIN, '2.4.0') ?? '',
      /instrumenter at 2\.3\.0.*library at 2\.4\.0/u
    );
    assert.match(pinDisagreement(PIN, undefined) ?? '', /library at undefined/u);
  });

  test('reads a SHA-256 in lower-case hexadecimal', () => {
    assert.equal(sha256Of(Buffer.from('bead')), createHash('sha256').update('bead').digest('hex'));
  });
});

// ── Seeds ─────────────────────────────────────────────────────────────────────

describe('the seeds', () => {
  test("read a conformance file's hexadecimal, its spaces and bars aside, and nothing else", () => {
    assert.deepEqual(hexBytesOf('A1 10  00 03 | 7B 7D'), Buffer.from('a11000037b7d', 'hex'));
    assert.equal(hexBytesOf('A1 1'), undefined);
    assert.equal(hexBytesOf(''), undefined);
    assert.equal(hexBytesOf({ head: 'A1' }), undefined);
    assert.deepEqual(
      hexUnder([{ send: 'A1 16', other: '00' }, { send: { head: 'GET' } }], ['send']),
      [Buffer.from('a116', 'hex')]
    );
  });

  test("read a head as the HTTP target's fields, each after its slot's byte", () => {
    const seeds = headSeedsOf(
      'POST /bead HTTP/1.1\r\nhost: {host}\r\nbead-after: 3\r\nAuthorization: Bearer a\r\nx-forwarded-for: 192.0.2.1\r\nx-forwarded-for: 10.0.0.2\r\norigin: http://a\r\n\r\n'
    );

    assert.deepEqual(
      seeds.map((seed) => {
        return [seed[0], textOf(seed.subarray(1))];
      }),
      [
        [0, '3'],
        [1, 'Bearer a'],
        [2, '192.0.2.1,10.0.0.2'],
        [3, '/bead\n127.0.0.1:8080'],
        [4, 'http://a'],
      ]
    );
  });

  test('seed every target from the conformance files', () => {
    assert.deepEqual(Object.keys(SEEDS), [...TARGETS]);

    for (const target of TARGETS) {
      assert.ok(SEEDS[target].length > 20, `${target} has ${String(SEEDS[target].length)} seeds`);
    }

    // a filter of separators alone, as debug-filters.json writes it
    const separators = String.fromCharCode(0x20, 0x2c, 0x09, 0x0a, 0x0b, 0x0c, 0x0d);

    assert.ok(
      SEEDS['debug-filter'].some((seed) => {
        return seed.toString('utf8') === separators;
      })
    );
  });

  test('name a seed by its SHA-1, as libFuzzer names an input it keeps', () => {
    assert.equal(seedNameOf(Buffer.from('bead')), createHash('sha1').update('bead').digest('hex'));
  });
});

// ── Arguments ─────────────────────────────────────────────────────────────────

describe('the command line', () => {
  test("reads a run's side, target, inputs and libFuzzer's flags", () => {
    assert.deepEqual(argumentsOf(['seed']), { command: 'seed' });
    assert.deepEqual(argumentsOf(['fetch']), { command: 'fetch' });
    assert.deepEqual(argumentsOf(['build', 'csharp']), { command: 'build', side: 'csharp' });
    assert.deepEqual(argumentsOf(['run', 'typescript', 'envelope', '--', '-max_total_time=600']), {
      command: 'run',
      side: 'typescript',
      target: 'envelope',
      inputs: [],
      flags: ['-max_total_time=600'],
    });
    assert.deepEqual(argumentsOf(['run', 'csharp', 'http-fields', 'crash-1', 'crash-2']), {
      command: 'run',
      side: 'csharp',
      target: 'http-fields',
      inputs: ['crash-1', 'crash-2'],
      flags: [],
    });
  });

  test('refuses what it does not read', () => {
    for (const argv of [
      [],
      ['seed', 'csharp'],
      ['build'],
      ['build', 'java'],
      ['run', 'csharp'],
      ['run', 'csharp', 'proto'],
      ['fuzz'],
    ]) {
      assert.equal(argumentsOf(argv), undefined, argv.join(' '));
    }
  });
});
