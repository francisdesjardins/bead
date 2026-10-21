import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../shared/errors';
import {
  addressOfEntry,
  assertTrustedProxies,
  clientAddressOf,
  heldAddressOf,
  MAXIMUM_UNNAMED_PROXIES,
  trustedProxiesOf,
} from '../trusted-proxies';

// constants

// the entries a server is built with, and those it is refused
const TAKEN = [
  '127.0.0.1',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.1.178',
  '192.0.2.0/24',
  '192.0.2.7/32',
  '192.0.2.1/32',
  '0.0.0.0/1',
  'fd00::/8',
  '2001:DB8::/32',
  '2001:db8::1/128',
  '::/1',
];
const REFUSED = [
  'nginx',
  'localhost',
  '',
  '*',
  '[::1]',
  '[2001:db8::]/32',
  'fe80::1%eth0',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.0/104',
  '127.1',
  '10.0.0.0/',
  '10.0.0.0/08',
  '10.0.0.0/-8',
  '10.0.0.0/a',
  '10.0.0.0/8/8',
  '0.0.0.0/0',
  '::/0',
  '10.0.0.0/0',
  '10.0.0.0/33',
  '2001:db8::/129',
  '10.1.2.3/8',
  '192.0.2.1/24',
  'fd00::1/8',
  '2001:db8::1/32',
  '2001:db8::1/127',
];

// definition

test.describe('trusted proxies', () => {
  // spec 15.12
  test('refuses a trustedProxies entry that is a name, a bracketed or zoned address, an IPv4-mapped one, a prefix of 0 or past its family’s bits, or a network whose bits past its prefix are set', () => {
    expect(() => {
      assertTrustedProxies(undefined);
      assertTrustedProxies([]);
      assertTrustedProxies(TAKEN);
    }).not.toThrow();

    for (const entry of REFUSED) {
      for (const entries of [[entry], ['127.0.0.1', entry]]) {
        expect(() => {
          assertTrustedProxies(entries);
        }, entry).toThrow(ProgrammerError);
        expect(() => {
          assertTrustedProxies(entries);
        }).toThrow('trustedProxies');
        expect(() => {
          assertTrustedProxies(entries);
        }).toThrow(entry.endsWith('/0') ? 'prefix 0' : entry);
      }
    }

    // the messages name what to write instead, and why prefix 0 is refused
    expect(() => {
      assertTrustedProxies(['10.1.2.3/8']);
    }).toThrow(/write 10\.0\.0\.0\/8, not 10\.1\.2\.3\/8$/u);
    expect(() => {
      assertTrustedProxies(['fd00::1/8']);
    }).toThrow(/write fd00::\/8, not fd00::1\/8$/u);
    expect(() => {
      assertTrustedProxies(['127.0.0.1', '::/0']);
    }).toThrow(
      'trustedProxies does not take a network of prefix 0: it would trust what every client writes'
    );
    // and the building refuses alike
    expect(() => {
      return trustedProxiesOf(['nginx']);
    }).toThrow(ProgrammerError);
    expect(() => {
      assertTrustedProxies(['[::1]']);
    }).toThrow('write ::1, not [::1]');
  });

  // spec 15.12
  test('walks X-Forwarded-For from the right past each proxy it names, and stops at the first address none holds or at an entry that is no address', () => {
    const trustedProxies = trustedProxiesOf(['127.0.0.0/8', '10.0.0.0/8']);
    const walked = (remoteAddress: string, forwarded?: string) => {
      return clientAddressOf(remoteAddress, { forwarded, trustedProxies });
    };

    expect([
      // one proxy, then two: the rightmost entry none of them holds
      walked('127.0.0.1', '198.51.100.7'),
      walked('127.0.0.1', '198.51.100.7, 10.0.0.5'),
      // what a client wrote left of it is never read
      walked('127.0.0.1', '203.0.113.9, 198.51.100.7, 10.0.0.6'),
      // every entry a proxy: the leftmost
      walked('127.0.0.2', '10.0.0.7, 10.0.0.6'),
      // an entry that is no address ends the walk at the proxy that wrote it
      walked('127.0.0.1', 'evil, 10.0.0.5'),
      walked('127.0.0.1', '198.51.100.7, unknown'),
      walked('127.0.0.1', '198.51.100.7, , 10.0.0.5'),
      walked('127.0.0.1', '198.51.100.7, '),
      walked('127.0.0.1', ''),
      // its lines joined by commas, the spaces and tabs around each entry dropped
      walked('127.0.0.1', '203.0.113.9,\t198.51.100.7 ,10.0.0.5'),
      // no field: the socket's
      walked('127.0.0.1'),
      // a socket no entry holds: its field is never read
      walked('192.0.2.1', '198.51.100.7'),
    ]).toEqual([
      '198.51.100.7',
      '198.51.100.7',
      '198.51.100.7',
      '10.0.0.7',
      '10.0.0.5',
      '127.0.0.1',
      '10.0.0.5',
      '127.0.0.1',
      '127.0.0.1',
      '198.51.100.7',
      '127.0.0.1',
      '192.0.2.1',
    ]);
    // none named, none trusted, the loopback among them
    expect([
      clientAddressOf('127.0.0.1', { forwarded: '198.51.100.7' }),
      clientAddressOf('127.0.0.1', {
        forwarded: '198.51.100.7',
        trustedProxies: trustedProxiesOf([]),
      }),
    ]).toEqual(['127.0.0.1', '127.0.0.1']);
  });

  // spec 15.12
  test('refuses an unnamedProxies that is not a whole number from 0 to 8, Infinity among it, as the server is built', () => {
    const built = (unnamedProxies: number | undefined) => {
      return () => {
        return trustedProxiesOf([], { unnamedProxies });
      };
    };

    for (const count of [-1, 9, 1.5, Number.NaN, -Infinity, 2 ** 31 - 1]) {
      expect(built(count), String(count)).toThrow(ProgrammerError);
      expect(built(count), String(count)).toThrow(
        `unnamedProxies is a whole number of proxies from 0 to 8, those trustedProxies does not name: not ${String(count)}`
      );
    }

    // the count of every hop, refused as a network of prefix 0 is
    expect(built(Infinity)).toThrow('it would trust what every client writes');
    expect(MAXIMUM_UNNAMED_PROXIES).toBe(8);

    for (const count of [undefined, 0, 1, 8]) {
      expect(built(count), String(count)).not.toThrow();
    }

    expect([
      trustedProxiesOf(undefined).unnamed,
      trustedProxiesOf([], { unnamedProxies: 3 }).unnamed,
    ]).toEqual([0, 3]);
  });

  // spec 15.12
  test('spends unnamedProxies on each address trustedProxies does not hold, none on one it holds, and stops at the first past the count', () => {
    const walked = (
      { named = [], unnamed }: { named?: readonly string[]; unnamed: number },
      { forwarded, remoteAddress = '127.0.0.1' }: { forwarded?: string; remoteAddress?: string }
    ) => {
      return clientAddressOf(remoteAddress, {
        forwarded,
        trustedProxies: trustedProxiesOf(named, { unnamedProxies: unnamed }),
      });
    };

    expect([
      // a count alone: that many hops from the socket, whatever their address
      walked({ unnamed: 1 }, { forwarded: '198.51.100.7, 192.0.2.1' }),
      walked({ unnamed: 2 }, { forwarded: '203.0.113.9, 198.51.100.7, 192.0.2.1' }),
      // a named hop passes free, wherever it stands: before the unnamed one or after it
      walked({ named: ['10.0.0.0/8'], unnamed: 1 }, { forwarded: '198.51.100.7, 10.0.0.5' }),
      walked(
        { named: ['10.0.0.0/8'], unnamed: 1 },
        { forwarded: '198.51.100.8, 10.0.0.6, 10.0.0.5' }
      ),
      walked(
        { named: ['10.0.0.0/8'], unnamed: 1 },
        { forwarded: '203.0.113.9, 10.0.0.5, 198.51.100.7', remoteAddress: '10.0.0.1' }
      ),
      // past the count, the first address none holds is the client: what it wrote left is not read
      walked({ named: ['10.0.0.0/8'], unnamed: 1 }, { forwarded: '203.0.113.9, 198.51.100.7' }),
      // a proxy both named and counted gives the client an entry it wrote
      walked(
        { named: ['127.0.0.1/32'], unnamed: 2 },
        { forwarded: '192.0.2.66, 203.0.113.1, 198.51.100.7' }
      ),
      // an entry that is no address ends the walk within the count, and so does the field's end
      walked({ unnamed: 3 }, { forwarded: 'unknown, 192.0.2.1' }),
      walked({ unnamed: 3 }, { forwarded: '192.0.2.1' }),
      // 0 counts none: an unnamed socket's field is not read
      walked({ unnamed: 0 }, { forwarded: '192.0.2.1' }),
    ]).toEqual([
      '192.0.2.1',
      '198.51.100.7',
      '198.51.100.7',
      '198.51.100.8',
      '203.0.113.9',
      '198.51.100.7',
      '192.0.2.66',
      '192.0.2.1',
      '192.0.2.1',
      '127.0.0.1',
    ]);
  });

  // spec 15.12
  test('reads an entry in RFC 7239’s node forms, its port dropped, and holds it in one form: an IPv4-mapped one as IPv4, IPv6 as RFC 5952 writes it, hexadecimal throughout; a zone ends the walk', () => {
    const forms: [entry: string, address: string | undefined][] = [
      ['192.0.2.7', '192.0.2.7'],
      [' \t192.0.2.7 ', '192.0.2.7'],
      ['192.0.2.7:51234', '192.0.2.7'],
      [' 192.0.2.7:51234 ', '192.0.2.7'],
      ['::ffff:192.0.2.7', '192.0.2.7'],
      ['::FFFF:c000:207', '192.0.2.7'],
      ['[::ffff:192.0.2.7]:80', '192.0.2.7'],
      ['2001:db8:0:0:0:0:0:1', '2001:db8::1'],
      ['2001:DB8::1', '2001:db8::1'],
      ['[2001:DB8::1]:443', '2001:db8::1'],
      ['[2001:db8::1]', '2001:db8::1'],
      ['[2001:db8::3]', '2001:db8::3'],
      ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
      ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
      ['0:0:0:0:0:0:0:0', '::'],
      ['::1', '::1'],
      ['::192.0.2.1', '::c000:201'],
      ['[::192.0.2.1]:1', '::c000:201'],
      ['fe80::5efe:192.0.2.1', 'fe80::5efe:c000:201'],
      ['::ffff:0:192.0.2.1', '::ffff:0:c000:201'],
      // a zone, a name, unknown, an obfuscated node, a quoted one, brackets around IPv4, a port
      // past five digits, an empty entry
      ['2001:db8::2%eth0', undefined],
      ['[fe80::1%25eth0]:80', undefined],
      ['[fe80::1%25eth0]', undefined],
      ['proxy.example', undefined],
      ['bead.test', undefined],
      ['unknown', undefined],
      ['_hidden', undefined],
      ['"[2001:db8::1]:443"', undefined],
      ['"192.0.2.7"', undefined],
      ['[192.0.2.7]', undefined],
      ['[2001:db8::1]:', undefined],
      ['[2001:db8::1]:123456', undefined],
      ['192.0.2.7:123456', undefined],
      ['192.0.2.7:', undefined],
      ['127.1', undefined],
      ['010.0.0.1', undefined],
      ['', undefined],
    ];

    expect(
      forms.map(([entry]) => {
        return [entry, addressOfEntry(entry)];
      })
    ).toEqual(forms);
    // a socket's address alike, its zone left out
    expect(
      [
        '::ffff:127.0.0.1',
        '::1',
        '0:0:0:0:0:0:0:1',
        '::192.0.2.1',
        '127.0.0.1',
        '2001:DB8::1%3',
        'fe80::1%3',
        '::ffff:192.0.2.7',
      ].map(heldAddressOf)
    ).toEqual([
      '127.0.0.1',
      '::1',
      '::1',
      '::c000:201',
      '127.0.0.1',
      '2001:db8::1',
      'fe80::1',
      '192.0.2.7',
    ]);

    // a zone ends the walk at the proxy that wrote it
    const trustedProxies = trustedProxiesOf(['127.0.0.1']);

    expect(
      [
        '2001:db8::2%eth0',
        '[2001:DB8::1]:443',
        '::ffff:192.0.2.7',
        '192.0.2.7:51234',
        '2001:db8:0:0:0:0:0:1',
        '[2001:db8::3]',
        'unknown',
      ].map((forwarded) => {
        return clientAddressOf('127.0.0.1', { forwarded, trustedProxies });
      })
    ).toEqual([
      '127.0.0.1',
      '2001:db8::1',
      '192.0.2.7',
      '192.0.2.7',
      '2001:db8::1',
      '2001:db8::3',
      '127.0.0.1',
    ]);
  });

  // spec 15.12
  test('holds an IPv4 client of a dual-stack socket by its IPv4 address against an IPv4 network', () => {
    const trustedProxies = trustedProxiesOf(['127.0.0.0/8', '10.0.0.0/8']);

    expect([
      // the proxy's socket, IPv4 mapped into IPv6, held by the IPv4 network that names it
      clientAddressOf('::ffff:127.0.0.1', { forwarded: '198.51.100.7', trustedProxies }),
      clientAddressOf('::ffff:10.0.0.5', { forwarded: '198.51.100.8', trustedProxies }),
      // a client's, direct, held as the IPv4 address it is, which no network holds
      clientAddressOf('::ffff:192.0.2.1', { forwarded: '198.51.100.9', trustedProxies }),
    ]).toEqual(['198.51.100.7', '198.51.100.8', '192.0.2.1']);
    expect([
      clientAddressOf('::ffff:10.0.0.5', {
        forwarded: '203.0.113.9',
        trustedProxies: trustedProxiesOf(['10.0.0.0/8']),
      }),
      clientAddressOf('::ffff:10.0.0.5', {
        forwarded: '203.0.113.9',
        trustedProxies: trustedProxiesOf(['192.168.0.0/16']),
      }),
      clientAddressOf('::ffff:10.0.0.5', {
        trustedProxies: trustedProxiesOf(['10.0.0.0/8']),
      }),
    ]).toEqual(['203.0.113.9', '10.0.0.5', '10.0.0.5']);
    // an IPv6 network holds no IPv4 address, nor an IPv4 network an IPv6 one
    expect([
      clientAddressOf('::ffff:10.0.0.5', {
        forwarded: '203.0.113.9',
        trustedProxies: trustedProxiesOf(['::/1']),
      }),
      clientAddressOf('2001:db8::5', {
        forwarded: '203.0.113.9',
        trustedProxies: trustedProxiesOf(['0.0.0.0/1', '128.0.0.0/1']),
      }),
    ]).toEqual(['10.0.0.5', '2001:db8::5']);
  });
});
