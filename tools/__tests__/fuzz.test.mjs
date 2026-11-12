import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  argumentsOf,
  blueprintsOf,
  EVERY_TARGET,
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

// `seeds` ordered by their SHA-1, its hexadecimal ascending, as every side's mutation tests order
// theirs, and as libFuzzer's corpus names them
const inSeedOrder = (seeds) => {
  return seeds.toSorted((one, other) => {
    const [oneName, otherName] = [seedNameOf(one), seedNameOf(other)];

    return oneName < otherName ? -1 : oneName > otherName ? 1 : 0;
  });
};

// the SHA-256 of `inputs`' lowercase hexadecimal, a line each, as every side's mutation tests
// digest their seeds
const digestOf = (inputs) => {
  const hash = createHash('sha256');

  for (const input of inputs) {
    hash.update(`${Buffer.from(input).toString('hex')}\n`);
  }

  return hash.digest('hex');
};

// ── Targets ───────────────────────────────────────────────────────────────────

describe('the targets', () => {
  test("fuzz the twins on each side, and beadc's blueprint on the TypeScript side alone", () => {
    assert.deepEqual(TWINS, [
      'envelope',
      'payload-codecs',
      'http-fields',
      'debug-filter',
      'jwt',
      'ws-handshake',
      'broker-parcel',
      'proto-codecs',
    ]);
    assert.deepEqual(TARGETS.csharp, TWINS);
    assert.deepEqual(TARGETS.typescript, [...TWINS, 'blueprint']);
  });

  test('knows the Rust side’s targets, every twin and its MQTT 5 client’s packet reader', () => {
    assert.deepEqual(TARGETS.rust, [...TWINS, 'mqtt-packets']);
    assert.deepEqual(EVERY_TARGET, [...TWINS, 'blueprint', 'mqtt-packets']);
    assert.match(SIDES.rust, /implementations[\\/]rust[\\/]fuzz$/u);
    assert.deepEqual(argumentsOf(['run', 'rust', 'jwt']), {
      command: 'run',
      side: 'rust',
      target: 'jwt',
      inputs: [],
      flags: [],
    });
    assert.equal(argumentsOf(['run', 'rust', 'blueprint']), undefined);
    assert.equal(argumentsOf(['run', 'typescript', 'mqtt-packets']), undefined);
    assert.equal(argumentsOf(['run', 'csharp', 'mqtt-packets']), undefined);
    assert.equal(folderOf('rust', 'mqtt-packets'), SIDES.rust);
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
    assert.deepEqual(Object.keys(SEEDS), [...EVERY_TARGET]);

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

  test("seed the parcel target with every side's parcel mutation seeds, in their order and digest", () => {
    // * the count and the digest every side's broker parcel fuzz test asserts of its seeds
    assert.equal(SEEDS['broker-parcel'].length, 72);
    assert.equal(
      digestOf(inSeedOrder(SEEDS['broker-parcel'])),
      '654a2c65cf1911a21e201cd09d3f1cb59af1688e318e7ddf1f2f0d3c73984d45'
    );
    assert.ok(
      SEEDS['broker-parcel'].some((seed) => {
        return seed.length === 0;
      }),
      'no byte at all is a seed'
    );
  });

  test("seed the packet target with the Rust side's packet mutation seeds, each a whole packet, in their order and digest", () => {
    // * the 14 packets of the Rust side's tests/mqtt_packets_fuzz.rs, a broker's to a client
    assert.equal(SEEDS['mqtt-packets'].length, 14);
    assert.equal(
      digestOf(inSeedOrder(SEEDS['mqtt-packets'])),
      'db5f9db1a9c692c6b1a72b50243647428c3e1593eb55442d2e72536525dbbae9'
    );

    // each one whole: its fixed header's Remaining Length, one byte below 128, counts the rest
    for (const seed of SEEDS['mqtt-packets']) {
      assert.ok(seed[1] < 0x80 && seed.length === 2 + seed[1], seed.toString('hex'));
    }
  });

  test("seed the envelope target with every side's envelope mutation seeds, in their order and digest", () => {
    const vectors = hexUnder(specOf('vectors.json'), ['bytes', 'record']);

    // * the count and the digest every side's envelope fuzz test asserts of its seeds
    assert.equal(vectors.length, 264);
    assert.equal(
      digestOf(inSeedOrder(vectors)),
      '4d0885103f89b5753c2204b02affcb89106c9e8d2300b8262c6d6b8a577e1c48'
    );
    assert.deepEqual(SEEDS.envelope.slice(0, vectors.length), vectors);
  });

  test("seed the proto target with codecs.json's proto payloads and written values, on the plain path", () => {
    const codecs = specOf('codecs.json');
    const isProto = (entry) => {
      return entry.encoding === 'proto';
    };
    const written = codecs.values.filter((entry) => {
      return isProto(entry) && entry.written !== undefined;
    });
    // the payload `100 messages below the top`, as `written` holds its bytes again
    const deepest = codecs.payloads.find((entry) => {
      return entry.name === '100 messages below the top';
    });

    assert.equal(
      SEEDS['proto-codecs'].length,
      codecs.payloads.filter(isProto).length + written.length
    );
    assert.ok(
      SEEDS['proto-codecs'].every((seed) => {
        return seed.subarray(0, 3).equals(Buffer.of(0, 0, 0));
      })
    );
    assert.ok(
      SEEDS['proto-codecs'].some((seed) => {
        return seed.length === 3;
      }),
      'the empty payload is a seed'
    );
    assert.ok(
      SEEDS['proto-codecs'].some((seed) => {
        return seed.subarray(3).equals(hexBytesOf(deepest.bytes));
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
      ['typescript', 'broker-parcel'],
      ['csharp', 'proto-codecs'],
      ['rust', 'broker-parcel'],
      ['rust', 'proto-codecs'],
      ['rust', 'mqtt-packets'],
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

  test("reads a campaign's side and the flags each of its targets runs with", () => {
    assert.deepEqual(argumentsOf(['campaign', 'rust', '--', '-max_total_time=600']), {
      command: 'campaign',
      side: 'rust',
      flags: ['-max_total_time=600'],
    });
    assert.deepEqual(argumentsOf(['campaign', 'typescript']), {
      command: 'campaign',
      side: 'typescript',
      flags: [],
    });
  });

  test('refuses what it does not read', () => {
    for (const argv of [
      [],
      ['campaign'],
      ['campaign', 'java'],
      ['campaign', 'csharp', 'envelope'],
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
