import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../shared/errors';
import {
  assertHosts,
  assertListeningAddress,
  assertOrigins,
  hasVisibleFields,
  HOST_REFUSAL,
  isIPAddress,
  isIPv4Address,
  isListedOrigin,
  isTakenHost,
  isTakenOrigin,
  isVisibleField,
  isWellFormedHost,
  ORIGIN_REFUSAL,
  originOf,
  ownAuthorityOf,
  requestTargetOf,
} from '../hosts-and-origins';
import { LISTENING_ADDRESSES, LISTENING_NAMES, NO_LISTENING_ADDRESSES } from './addresses';

// constants

// the rows the C# side judges alike: what every server takes, by its host on any port
const EVERY_SERVERS = [
  'localhost',
  'LocalHost:8080',
  'bead.localhost',
  'a.b.LOCALHOST:80',
  '127.0.0.1',
  '127.0.0.1:8080',
  '192.0.2.1:80',
  '0.0.0.0',
  '255.255.255.255',
  '[::1]',
  '[::1]:8443',
  '[2001:db8::7]:80',
  'localhost:80',
  'Bead.LocalHost:8443',
  'a.b.localhost',
  '.localhost',
  '[2001:db8::7]',
  '[::ffff:127.0.0.1]:8080',
];
// and what a server takes only where it is listed: an empty host, none, a name that only looks
// like one of those, a final dot, and what a platform's parser reads as an IPv4 address
const NO_SERVERS = [
  undefined,
  '',
  ':8080',
  'elsewhere.test',
  'localhost.',
  'localhost.example',
  'localhost.example:8080',
  'notlocalhost',
  '127.1',
  '0177.0.0.1',
  '127.0.0.1.example',
  '256.0.0.1',
  'xn--a',
  'rebind.example:8080',
  'localhost.:8080',
  'bead-localhost',
  'localhost.localhost.example',
  '0x7f.0.0.1',
  '2130706433',
  '127.0.0.01',
  '1.2.3.4.5',
];

// the hosts given, and the rows they take and refuse, in any ASCII case, on any port
const HOSTS = ['bead.test', 'xn--bad-bma.test', 'Elsewhere.Example'];
const TAKEN_HOSTS = [
  'bead.test',
  'Bead.Test',
  'BEAD.TEST:8443',
  'bead.test:80',
  'XN--BAD-BMA.test',
  'elsewhere.example:1',
];
const OTHER_HOSTS = [
  undefined,
  '',
  ':80',
  'sub.bead.test',
  'bead.test.',
  'bead.testx',
  'béad.test',
  'xn--a.test',
];
const ORIGINS = ['https://bead.example'];

// a `Host` value HTTP takes, an authority of spec 15.12's grammar, and one it does not (RFC 9112
// §3.2): the rows the C# side judges alike
const WELL_FORMED_HOSTS = [
  'bead.test',
  'bead.test:8080',
  'BEAD.test:8080',
  'bead.test:0',
  'bead.test:080',
  'bead.test:65536',
  'BEAD.TEST',
  '',
  ':8080',
  '127.0.0.1',
  '127.0.0.1:8080',
  '127.1',
  '[::1]',
  '[::1]:8080',
  '[2001:db8::7]',
  '[::ffff:127.0.0.1]',
  '[::ffff:192.0.2.1]',
  'xn--a',
  'xn---bad-cpa.test',
  'bead_test~',
  "!$&'()",
  "a-._~!$&'()b",
  ' bead.test\t',
];
const MALFORMED_HOSTS = [
  'bead.test:',
  'localhost:',
  '[::1]:',
  'a%41.test',
  'bead%2Etest',
  'b%C3%A9ad.test',
  'a*b.test',
  'a+b.test',
  'a,b.test',
  'a;b=c',
  'a=b.test',
  "!$&'()*+,;=",
  '[v1.bead]',
  '[v1.fe80::a+en1]',
  'bad host',
  'user@bead.test',
  'bead/test',
  'bead.test/path',
  'bead.test?query',
  'bead.test#fragment',
  'bead.test:80x',
  'bead.test:80a',
  'bead.test:80:80',
  'bead.test:8080:1',
  'bead.test:-1',
  '[::1',
  '[::1]x',
  '[::1]:a',
  '[]',
  '[bead.test]',
  '[127.0.0.1]',
  '[::1%eth0]',
  '[::1%25eth0]',
  '[fe80::1%25eth0]',
  '[::1/64]',
  '[v.x]',
  '[v1.]',
  'bead%2test',
  '%zz.test',
  'bead.test%',
  'béad.test',
  '::1',
];

// a `hosts` that is built, and one that is refused as it is built
const BUILT_HOSTS = [
  undefined,
  [],
  ['*'],
  ['bead.test'],
  ['Bead.Test', '127.0.0.1', '[::1]', 'localhost', 'xn--a', 'bead.localhost'],
];
const REFUSED_HOSTS = [
  ['bead.test:8080'],
  ['bead.test', '127.0.0.1:8080'],
  ['[::1]:80'],
  ['localhost:'],
  [''],
  ['bead.test', ''],
  ['béad.test'],
  ['bad host'],
  ['a*b.test'],
  ['[v1.bead]'],
  ['bead.test/'],
  ['http://bead.test'],
  ['*', 'bead.test'],
  ['bead.test', '*'],
  ['*', '*'],
];

// an `origins` entry that is built, and one that is refused as it is built
const BUILT_ORIGINS = [
  'http://bead.test',
  'https://bead.test',
  'http://bead.test:8080',
  'https://bead.test:8443',
  'https://bead.test:80',
  'ws://bead.test:443',
  'http://127.0.0.1:8080',
  'http://[::1]:8080',
  'http://localhost:0',
  'https://xn--bad-bma.test',
  'chrome-extension://abcdefghijklmnop',
  'tauri://localhost',
  'app://Bead.Test',
];
const REFUSED_ORIGINS = [
  '*',
  'null',
  'http://*.bead.test',
  'https://bead.test/',
  'https://bead.test/path',
  'http://bead.test?query',
  'https://user@bead.test',
  'HTTPS://bead.test',
  'https://Bead.test',
  'https://bead.test:443',
  'http://bead.test:80',
  'ws://bead.test:80',
  'wss://bead.test:443',
  'https://bead.test:',
  'https://bead.test:0443',
  'http://bead.test:080',
  'https://bead.test:65536',
  'https://',
  'https://béad.test',
  'https://a*b.test',
  'https://[::1',
  'bead.test',
  '//bead.test',
  'http:bead.test',
  '1http://bead.test',
  ' http://bead.test',
  'Null',
  '',
  'http://bead.test/',
  'http://bead.test/path',
  'http://user@bead.test',
  'HTTP://bead.test',
  'http://Bead.Test',
  'http://bead.test:',
  'http://bead.test:65536',
  'http://',
  'http://béad.test',
  'http://a*b.test',
];

// an origin, and the Host of a request that comes from it: the server's own, `http://` or
// `https://` followed by its Host, in any ASCII case, as a browser writes both from one URL first
const OWN: [origin: string, host: string][] = [
  ['http://bead.test', 'bead.test'],
  ['https://bead.test', 'bead.test'],
  ['http://bead.test:8080', 'bead.test:8080'],
  ['https://bead.test:8443', 'bead.test:8443'],
  ['http://127.0.0.1:8080', '127.0.0.1:8080'],
  ['http://[::1]:8080', '[::1]:8080'],
  ['http://localhost:8080', 'localhost:8080'],
  ['http://xn--bad-bma.test', 'xn--bad-bma.test'],
  ['https://xn--bad-bma.test:8443', 'xn--bad-bma.test:8443'],
  ['http://bead.test', 'Bead.Test'],
  ['HTTPS://BEAD.test', 'bead.test'],
  ['http://XN--BAD-BMA.test', 'xn--bad-bma.test'],
  ['http://xn--a.test', 'xn--a.test'],
  ['http://bead.test:80', 'bead.test:80'],
  ['http://bead.test.', 'bead.test.'],
];
const NOT_OWN: [origin: string, host: string | undefined][] = [
  ['http://bead.test', 'bead.test:8080'],
  ['http://bead.test:8080', 'bead.test'],
  ['https://elsewhere.test', 'bead.test'],
  ['http://bead.test', undefined],
  ['http://', ''],
  ['null', 'bead.test'],
  ['not an origin', 'bead.test'],
  // the same origin written otherwise than the Host, which no browser sends: a default port on
  // one side alone, a host not in its canonical form, a path, a userinfo, a space
  ['http://bead.test:80', 'bead.test'],
  ['https://bead.test:443', 'bead.test'],
  ['http://bead.test', 'bead.test:80'],
  ['https://bead.test:80', 'bead.test'],
  ['http://127.1', '127.0.0.1'],
  ['http://[0:0::1]:8080', '[::1]:8080'],
  ['http://béad.test', 'xn--bad-bma.test'],
  ['http://bead%2Etest', 'bead.test'],
  ['http://bead.test.', 'bead.test'],
  ['http://bead.test:', 'bead.test'],
  ['http:bead.test', 'bead.test'],
  ['http://bead.test/', 'bead.test'],
  ['http://bead.test/path?query#fragment', 'bead.test'],
  ['http://user@bead.test', 'bead.test'],
  [' http://bead.test', 'bead.test'],
  ['http://bead.test:8080x', 'bead.test:8080'],
  ['http://[::1]x', '[::1]'],
  // any scheme but http and https, whatever host it names
  ['ws://bead.test', 'bead.test'],
  ['wss://bead.test', 'bead.test'],
  ['ftp://bead.test', 'bead.test'],
  ['file://bead.test', 'bead.test'],
  ['foo://bead.test', 'bead.test'],
  ['chrome-extension://bead.test', 'bead.test'],
  ['blob:http://bead.test', 'bead.test'],
];

// definition

test.describe('hosts and origins', () => {
  test('takes a Host HTTP takes: one line, none in a request that needs none, its value uri-host and an optional port without the whitespace around it, and none of a percent-encoded octet, *+,;= in a name, an IPvFuture literal or a colon with no port', () => {
    expect(
      WELL_FORMED_HOSTS.filter((host) => {
        return isWellFormedHost([host], { isRequired: true });
      })
    ).toEqual(WELL_FORMED_HOSTS);
    expect(
      MALFORMED_HOSTS.filter((host) => {
        return isWellFormedHost([host], { isRequired: false });
      })
    ).toEqual([]);

    // none, where HTTP/1.1 asks one and HTTP/1.0 does not; two, whatever they name
    expect([
      isWellFormedHost([], { isRequired: true }),
      isWellFormedHost([], { isRequired: false }),
      isWellFormedHost(['bead.test', 'bead.test'], { isRequired: true }),
      isWellFormedHost(['bead.test', 'elsewhere.test'], { isRequired: false }),
    ]).toEqual([false, true, false, false]);
  });

  test('takes whatever its hosts localhost, the names under .localhost and IP literals, each by its host on any port, and no other host, nor an empty one, nor none, but under *', () => {
    for (const hosts of [undefined, [], ['bead.test'], ['xn--bad-bma.test', 'elsewhere.example']]) {
      expect(
        EVERY_SERVERS.filter((host) => {
          return isTakenHost(host, hosts);
        }),
        String(hosts)
      ).toEqual(EVERY_SERVERS);
      expect(
        NO_SERVERS.filter((host) => {
          return isTakenHost(host, hosts);
        }),
        String(hosts)
      ).toEqual([]);
    }

    expect(
      [...EVERY_SERVERS, ...NO_SERVERS].filter((host) => {
        return isTakenHost(host, ['*']);
      })
    ).toEqual([...EVERY_SERVERS, ...NO_SERVERS]);
    expect([HOST_REFUSAL, ORIGIN_REFUSAL]).toEqual(['host-refused', 'origin-refused']);
  });

  test('takes the hosts given besides, each by its host on any port in any ASCII case, and every host and none under *', () => {
    expect(
      TAKEN_HOSTS.filter((host) => {
        return isTakenHost(host, HOSTS);
      })
    ).toEqual(TAKEN_HOSTS);
    expect(
      OTHER_HOSTS.filter((host) => {
        return isTakenHost(host, HOSTS);
      })
    ).toEqual([]);
    expect(
      OTHER_HOSTS.filter((host) => {
        return isTakenHost(host, ['*']);
      })
    ).toEqual(OTHER_HOSTS);
  });

  test('refuses a hosts entry with a port, an empty one, one that is no host, and * beside another', () => {
    for (const hosts of BUILT_HOSTS) {
      expect(() => {
        assertHosts(hosts);
      }, String(hosts)).not.toThrow();
    }

    for (const hosts of REFUSED_HOSTS) {
      expect(() => {
        assertHosts(hosts);
      }, String(hosts)).toThrow(ProgrammerError);
    }

    // the message names what to write instead
    expect(() => {
      assertHosts(['bead.test:8080']);
    }).toThrow(/bead\.test, not bead\.test:8080/u);
  });

  // spec 15.12
  test('refuses an origins entry that is * or null, or not an origin as RFC 6454 serializes it', () => {
    expect(() => {
      assertOrigins(undefined);
      assertOrigins([]);
      assertOrigins(BUILT_ORIGINS);
    }).not.toThrow();

    for (const origin of REFUSED_ORIGINS) {
      for (const origins of [[origin], ['https://bead.example', origin]]) {
        expect(() => {
          assertOrigins(origins);
        }, origin).toThrow(ProgrammerError);
        expect(() => {
          assertOrigins(origins);
        }).toThrow('origins');
        expect.soft(() => {
          assertOrigins(origins);
        }).toThrow(origin);
      }
    }

    expect(() => {
      assertOrigins(['*']);
    }).toThrow(/no wildcard/u);
    // null names every page with no origin of its own, and the message the better path
    expect(() => {
      assertOrigins(['https://bead.example', 'null']);
    }).toThrow(/does not take null: .* serve the page from an origin, and name that one$/u);
  });

  test('reads an IPv4 address by RFC 3986’s grammar, never as the platform’s parser reads one', () => {
    const addresses = ['0.0.0.0', '127.0.0.1', '10.0.0.10', '192.0.2.1', '255.255.255.255'];
    // a short form, octal, hexadecimal, one number, an octet past 255, a leading zero, a final
    // dot, a fifth octet, a space, a port
    const others = [
      '127.1',
      '0177.0.0.1',
      '0x7f.0.0.1',
      '2130706433',
      '256.0.0.1',
      '127.0.0.01',
      '127.0.0.1.',
      '1.2.3.4.5',
      ' 127.0.0.1',
      '127.0.0.1:80',
    ];

    expect(addresses.filter(isIPv4Address)).toEqual(addresses);
    expect(others.filter(isIPv4Address)).toEqual([]);
    // and so what every server takes: none of the others but the one with a port, by its host
    expect(
      [...addresses, ...others].filter((host) => {
        return isTakenHost(host, []);
      })
    ).toEqual([...addresses, '127.0.0.1:80']);
  });

  test('takes a request with no Origin, one among those given, and the server’s own: http:// or https:// followed by its Host, in any ASCII case, nothing parsed', () => {
    // no page, or one among those given, exactly
    expect(
      [undefined, 'https://bead.example', 'null', 'https://Bead.Example'].map((origin) => {
        return isTakenOrigin(origin, { host: 'bead.test', origins: ORIGINS });
      })
    ).toEqual([true, true, false, false]);

    expect(
      OWN.filter(([origin, host]) => {
        return isTakenOrigin(origin, { host, origins: [] });
      })
    ).toEqual(OWN);
    expect(
      NOT_OWN.filter(([origin, host]) => {
        return isTakenOrigin(origin, { host, origins: [] });
      })
    ).toEqual([]);
  });

  // spec 15.12
  test('ownAuthorityOf gives the authority of a host taken by name, every server’s or one listed, and none of one only * takes', () => {
    const authorities = [
      'localhost:8080',
      '127.0.0.1:8080',
      '[::1]:8080',
      'Bead.Test:8443',
      'rebind.example:8080',
      '',
      undefined,
    ];

    // by name, every server's or one listed, whether * is there or not
    expect(
      authorities.map((authority) => {
        return ownAuthorityOf(authority, ['bead.test']);
      })
    ).toEqual([
      'localhost:8080',
      '127.0.0.1:8080',
      '[::1]:8080',
      'Bead.Test:8443',
      undefined,
      undefined,
      undefined,
    ]);
    // * takes every host, and vouches for none of them: the rebound page names its own Host
    expect(
      authorities.map((authority) => {
        return ownAuthorityOf(authority, ['*']);
      })
    ).toEqual([
      'localhost:8080',
      '127.0.0.1:8080',
      '[::1]:8080',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(ownAuthorityOf('bead.test', undefined)).toBeUndefined();
    // and so the rebound page is none of the server's own under *, though * took its host
    expect(isTakenHost('rebind.example:8080', ['*'])).toBe(true);
    expect(
      isTakenOrigin('http://rebind.example:8080', {
        host: ownAuthorityOf('rebind.example:8080', ['*']),
        origins: [],
      })
    ).toBe(false);
  });

  // spec 15.12
  test('isListedOrigin takes an Origin that origins names exactly, the server’s own only when named, and never none', () => {
    // ORIGINS names a page; the server's own is bead.test's
    expect(
      [
        'https://bead.example',
        'null',
        'https://Bead.Example',
        'https://bead.example:443',
        'http://bead.example',
        'https://bead.test',
        undefined,
      ].map((origin) => {
        return isListedOrigin(origin, ORIGINS);
      })
    ).toEqual([true, false, false, false, false, false, false]);
    // the server's own, named
    expect(isListedOrigin('https://bead.test', ['https://bead.test'])).toBe(true);
    // none, whatever is named
    expect([isListedOrigin(undefined, []), isListedOrigin('null', [])]).toEqual([false, false]);
  });

  test('isIPAddress takes a bare IP address by RFC 3986’s grammar, and refuses a name, every other form, brackets, a zone and an IPv4-mapped address', () => {
    expect(LISTENING_ADDRESSES.filter(isIPAddress)).toEqual(LISTENING_ADDRESSES);
    expect(NO_LISTENING_ADDRESSES.filter(isIPAddress)).toEqual([]);
    // the long forms of an IPv6 address are its own, and a mapped one is refused in any of them
    expect(
      ['0:0:0:0:0:0:0:1', 'FE80::A', '::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::1:'].map(
        isIPAddress
      )
    ).toEqual([true, true, false, false, false]);
  });

  test('refuses to listen on an address that is no bare IP address nor localhost, naming it, and tells a bracketed one how to write itself', () => {
    // localhost, exactly, both loopbacks
    for (const address of [...LISTENING_ADDRESSES, ...LISTENING_NAMES]) {
      expect(() => {
        assertListeningAddress(address);
      }).not.toThrow();
    }

    for (const address of NO_LISTENING_ADDRESSES) {
      expect(() => {
        assertListeningAddress(address);
      }, address).toThrow(ProgrammerError);
    }

    expect(() => {
      assertListeningAddress('LOCALHOST');
    }).toThrow(
      new ProgrammerError(
        'a server listens on an IP address, or on localhost, both loopbacks, not "LOCALHOST"'
      )
    );
    expect(() => {
      assertListeningAddress('[::1]');
    }).toThrow(
      new ProgrammerError(
        'a server listens on an IP address, or on localhost, both loopbacks, not "[::1]": write ::1, not [::1]'
      )
    );
  });

  test('isVisibleField takes HTAB, SP and visible ASCII, and refuses each other control character, DEL and 0x80 to 0xFF, none at either end', () => {
    const visible = Array.from({ length: 0x7f - 0x20 }, (_, index) => {
      return String.fromCodePoint(0x20 + index);
    });
    const others = [
      ...Array.from({ length: 0x20 }, (_, code) => {
        return String.fromCodePoint(code);
      }).filter((character) => {
        return character !== '\t';
      }),
      ...Array.from({ length: 0x100 - 0x7f }, (_, index) => {
        return String.fromCodePoint(0x7f + index);
      }),
    ];

    expect(isVisibleField(`a\t${visible.join('')}`)).toBe(true);
    expect(isVisibleField('')).toBe(true);
    expect(isVisibleField('x \ty')).toBe(true);
    // a space or a tab at either end, which HTTP/2 calls malformed (RFC 9113 §8.2.1)
    expect(
      [' x', 'x ', '\tx', 'x\t', ' ', '\t', ' \t '].filter((value) => {
        return isVisibleField(value);
      })
    ).toEqual([]);
    expect(
      others.filter((character) => {
        return isVisibleField(`a${character}b`);
      })
    ).toEqual([]);
    expect(others).toHaveLength(31 + 129);
    // a request's fields as they came, each name before its value: the values alone are read
    expect(hasVisibleFields(['Host', 'bead.test', 'Origin', 'http://a.example\tb'])).toBe(true);
    expect(hasVisibleFields(['Host', 'bead.test', 'x-other', 'café'])).toBe(false);
    expect(hasVisibleFields(['Host', 'bead.test', 'x-other', 'a\u0007b'])).toBe(false);
    expect(hasVisibleFields(['Host', 'bead.test', 'bead-after', '0 '])).toBe(false);
  });

  test('tells a request’s Origin as it came, its field lines joined by a comma and a space, and none when it sends none', () => {
    expect([originOf([]), originOf(['null']), originOf(['https://a.test', 'null'])]).toEqual([
      undefined,
      'null',
      'https://a.test, null',
    ]);
  });

  test('folds ASCII alone: a host that differs past ASCII is another', () => {
    // the Kelvin sign and a dotted capital I, which a fold past ASCII would take for a k and an i;
    // an i without its dot and an É, which it would take for an I and an é
    expect(isTakenHost('Key.test', ['key.test'])).toBe(false);
    expect(isTakenHost('İtem.test', ['item.test'])).toBe(false);
    expect(isTakenHost('bead.ıo', ['bead.io'])).toBe(false);
    expect(isTakenHost('bÉad.test', ['béad.test'])).toBe(false);
    expect(isTakenHost('BéAD.test', ['béad.test'])).toBe(true);
    expect(isTakenHost('LOCALHOST', [])).toBe(true);
    expect(isTakenOrigin('http://key.test', { host: 'Key.test', origins: [] })).toBe(false);
    expect(isTakenOrigin('http://item.test', { host: 'İtem.test', origins: [] })).toBe(false);
    expect(isTakenOrigin('http://bead.io', { host: 'BEAD.ıO', origins: [] })).toBe(false);
  });

  test('refuses an absolute-form target without an authority or with an uppercase scheme', () => {
    for (const target of ['http:///', 'HTTP://127.0.0.1/']) {
      expect(requestTargetOf(target), target).toBeUndefined();
    }
  });
});
