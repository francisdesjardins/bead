import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  argumentsOf,
  blueprintsOf,
  folderOf,
  handshakeSeedsOf,
  headSeedsOf,
  hexBytesOf,
  hexUnder,
  patchedOf,
  pinDisagreement,
  readPin,
  seedNameOf,
  seedsOf,
  sha256Of,
  sharpFuzzOf,
  SIDES,
  TARGETS,
  TWINS,
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
  blueprints: blueprintsOf(),
  codecs: specOf('codecs.json'),
  conversations: specOf('conversations.json'),
  debugFilters: specOf('debug-filters.json'),
  transports: specOf('transports.json'),
  vectors: specOf('vectors.json'),
});

const textOf = (bytes) => {
  return Buffer.from(bytes).toString('latin1');
};

// ── Targets ───────────────────────────────────────────────────────────────────

describe('the targets', () => {
  test("fuzz the twins on each side, and beadc's blueprint on the TypeScript side alone", () => {
    assert.deepEqual(TARGETS.csharp, TWINS);
    assert.deepEqual(TARGETS.typescript, [...TWINS, 'blueprint']);
    assert.ok(TWINS.includes('jwt') && TWINS.includes('ws-handshake'));
  });

  test('knows the Rust side’s targets, the twins its core holds', () => {
    assert.deepEqual(TARGETS.rust, ['envelope', 'payload-codecs', 'debug-filter', 'jwt']);
    assert.ok(
      TARGETS.rust.every((target) => {
        return TWINS.includes(target);
      })
    );
    assert.match(SIDES.rust, /implementations[\\/]rust[\\/]fuzz$/u);
    assert.deepEqual(argumentsOf(['run', 'rust', 'jwt']), {
      command: 'run',
      side: 'rust',
      target: 'jwt',
      inputs: [],
      flags: [],
    });
    assert.equal(argumentsOf(['run', 'rust', 'http-fields']), undefined);
  });

  test("keep each in its side's folder, and the blueprint's beside beadc", () => {
    for (const side of Object.keys(SIDES)) {
      for (const target of TWINS) {
        assert.equal(folderOf(side, target), SIDES[side]);
      }
    }

    assert.match(folderOf('typescript', 'blueprint'), /builder[\\/]tools[\\/]fuzz$/u);
  });
});

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

  test("read an upgrade's head as the WebSocket target's seeds: whole, its request line, then each field it carries", () => {
    const head =
      'GET / HTTP/1.1\r\nhost: {host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\norigin: https://a\r\nauthorization:  \tInterop sub=bob\t \r\nauthorization: Interop sub=ada\r\n\r\n';

    assert.deepEqual(
      handshakeSeedsOf(head).map((seed) => {
        return [seed[0], textOf(seed.subarray(1))];
      }),
      [
        [0, head.replace('{host}', '127.0.0.1:8080')],
        [1, 'GET / HTTP/1.1'],
        [2, '127.0.0.1:8080'],
        [3, 'websocket'],
        [4, 'Upgrade'],
        [5, 'dGhlIHNhbXBsZSBub25jZQ=='],
        [6, '13'],
        [8, 'https://a'],
        [9, 'Interop sub=bob\nInterop sub=ada'],
      ]
    );
  });

  test("apply a JSON Patch as beadc's tests apply a case to the interop's blueprint", () => {
    const value = { services: [{ a: 1 }, { b: 2 }], 'x/y': { '~': 0 } };

    assert.deepEqual(
      patchedOf(value, [
        { op: 'replace', path: '/services/0/a', value: 3 },
        { op: 'add', path: '/services/-', value: { c: 4 } },
        { op: 'remove', path: '/services/1' },
        { op: 'add', path: '/x~1y/~0', value: 5 },
      ]),
      { services: [{ a: 3 }, { c: 4 }], 'x/y': { '~': 5 } }
    );
    assert.deepEqual(value.services[0], { a: 1 });
    assert.throws(() => {
      return patchedOf(value, [{ op: 'add', path: '/none/a', value: 1 }]);
    }, /no place to add/u);
  });

  test('seed every target from the conformance files and the blueprints', () => {
    assert.deepEqual(Object.keys(SEEDS), [...TARGETS.typescript]);

    for (const target of TARGETS.typescript) {
      assert.ok(SEEDS[target].length > 20, `${target} has ${String(SEEDS[target].length)} seeds`);
    }

    // a filter of separators alone, as debug-filters.json writes it
    const separators = String.fromCharCode(0x20, 0x2c, 0x09, 0x0a, 0x0b, 0x0c, 0x0d);

    assert.ok(
      SEEDS['debug-filter'].some((seed) => {
        return seed.toString('utf8') === separators;
      })
    );

    // every JWT verdict's token, one octet a character, and the interop's blueprint as it is
    assert.deepEqual(
      SEEDS.jwt.map(textOf),
      specOf('vectors.json').jwtVerdicts.map((verdict) => {
        return verdict.token;
      })
    );
    assert.ok(
      SEEDS.blueprint.some((seed) => {
        return seed.equals(
          readFileSync(new URL('../../spec/interop-blueprint.json', import.meta.url))
        );
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

    for (const [side, target] of [
      ['typescript', 'jwt'],
      ['csharp', 'jwt'],
      ['typescript', 'ws-handshake'],
      ['csharp', 'ws-handshake'],
      ['typescript', 'blueprint'],
    ]) {
      assert.deepEqual(argumentsOf(['run', side, target]), {
        command: 'run',
        side,
        target,
        inputs: [],
        flags: [],
      });
    }
  });

  test('refuses what it does not read', () => {
    for (const argv of [
      [],
      ['seed', 'csharp'],
      ['build'],
      ['build', 'java'],
      ['run', 'csharp'],
      ['run', 'csharp', 'proto'],
      ['run', 'csharp', 'blueprint'],
      ['run', 'toString', 'envelope'],
      ['build', 'toString'],
      ['fuzz'],
    ]) {
      assert.equal(argumentsOf(argv), undefined, argv.join(' '));
    }
  });
});
