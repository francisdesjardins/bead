import { expect, test } from '@playwright/test';
import { isLoopbackHost, isSecureUrl } from '../secure';

// constants

// the rows both sides judge alike (spec 13.4): under TLS, or on the loopback by the host given
const SECURE = [
  'wss://bead.example',
  'https://bead.example',
  'ws://localhost:8080',
  'ws://LOCALHOST',
  'http://a.localhost',
  'ws://127.0.0.1',
  'ws://127.255.255.254',
  'ws://[::1]:8080',
  'ws://[0:0:0:0:0:0:0:1]',
];
const IN_THE_CLEAR = [
  'ws://bead.example',
  'http://192.0.2.1',
  'ws://128.0.0.1',
  'ws://localhost.example',
  'ws://127.0.0.1.example',
  'ws://[::2]',
  'ws://[::ffff:127.0.0.1]',
];

// a host, and what the parser reads it as: none where it fails; the C# side's port reads the rows
// alike, this side through `URL`. An `xn--` label that does not decode is left out: its answer moves
// with the IDNA version a parser follows
const PARSED_HOSTS: [host: string, parsed: string | undefined][] = [
  ['127.0.0.1.', '127.0.0.1'],
  ['127.1', '127.0.0.1'],
  ['0x7f.1', '127.0.0.1'],
  ['0X7F.0.0.1', '127.0.0.1'],
  ['2130706433', '127.0.0.1'],
  ['0177.0.0.1', '127.0.0.1'],
  ['127.0.0.0x1', '127.0.0.1'],
  ['127.65535', '127.0.255.255'],
  ['127.0.0.1..', '127.0.0.1..'],
  ['127.0.0.256', undefined],
  ['127.0.0.1.1', undefined],
  ['1.2.3.4.5', undefined],
  ['127.0.0.09', undefined],
  ['4294967296', undefined],
  ['0x', '0.0.0.0'],
  ['0x.0x.0x.1', '0.0.0.1'],
  ['127.0.0.1 ', undefined],
  ['LOCALHOST', 'localhost'],
  ['localhost.', 'localhost.'],
  ['A.LocalHost', 'a.localhost'],
  ['loc%61lhost', 'localhost'],
  ['%6c%6f%63%61%6c%68%6f%73%74', 'localhost'],
  ['%zz', undefined],
  ['a%', undefined],
  ['a%2520', undefined],
  ['\uFF11\uFF12\uFF17\uFF0E\uFF10\uFF0E\uFF10\uFF0E\uFF11', '127.0.0.1'],
  ['\uFF4C\uFF4F\uFF43\uFF41\uFF4C\uFF48\uFF4F\uFF53\uFF54', 'localhost'],
  ['b\u00FCcher.example', 'xn--bcher-kva.example'],
  ['a..b', 'a..b'],
  ['[::1]', '[::1]'],
  ['[0:0:0:0:0:0:0:1]', '[::1]'],
  ['[0:0::1]', '[::1]'],
  ['[::0.0.0.1]', '[::1]'],
  ['[::1%1]', undefined],
  ['[::1:]', undefined],
  ['[::01.0.0.1]', undefined],
  ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]'],
  ['[1:0:0:2:0:0:0:3]', '[1:0:0:2::3]'],
  ['[1::]', '[1::]'],
  ['[::]', '[::]'],
  ['[1:2:3:4:5:6:7:8]', '[1:2:3:4:5:6:7:8]'],
  ['[1:2:3:4:5:6:7:8:9]', undefined],
  ['[::1', undefined],
  ['[FE80::A]', '[fe80::a]'],
  ['bead.test^', undefined],
  ['a|b', undefined],
  ['a<b', undefined],
  ['a b', undefined],
  ['1..2', undefined],
  ['1a.2.3.4', undefined],
  ['0x1g.0.0.1', undefined],
  ['256.0.0.1', undefined],
  ['1.0x', '1.0.0.0'],
  ['a.0xg', 'a.0xg'],
  ['%41.example', 'a.example'],
  ['�.example', undefined],
  ['a­b.example', 'ab.example'],
  ['[]', undefined],
  ['[:1]', undefined],
  ['[1::2::3]', undefined],
  ['[1:2:3]', undefined],
  ['[::12345]', undefined],
  ['[::1:2:3:4:5:6:7]', '[0:1:2:3:4:5:6:7]'],
  ['[1:2:3:4:5:6:7::]', '[1:2:3:4:5:6:7:0]'],
  ['[1:2:3:4:5:6:7:8::]', undefined],
  ['[1::2:3:4:5:6:7:8]', undefined],
  ['[1:2:3:4:5:6:1.2.3.4]', '[1:2:3:4:5:6:102:304]'],
  ['[1:2:3:4:5:6:7:1.2.3.4]', undefined],
  ['[::.1.2.3]', undefined],
  ['[::1.2.3]', undefined],
  ['[::1.2.3.]', undefined],
  ['[::1.a.3.4]', undefined],
  ['[::1.02.3.4]', undefined],
  ['[::1.2.3.256]', undefined],
  ['[::1.2.3.4.5]', undefined],
];

// definition

test.describe('isSecureUrl', () => {
  test('judges a URL secure under TLS or on the loopback, by the host it is given, and any other in the clear', () => {
    expect(SECURE.filter(isSecureUrl)).toEqual(SECURE);
    expect(IN_THE_CLEAR.filter(isSecureUrl)).toEqual([]);
    expect(isSecureUrl('not a URL')).toBe(false);
  });
});

test.describe('isLoopbackHost', () => {
  test('judges the host a server listens on as a URL’s, an IPv6 one bare or bracketed', () => {
    expect(
      ['127.0.0.1', 'localhost', 'a.LOCALHOST', '::1', '[::1]', '0:0:0:0:0:0:0:1'].map(
        isLoopbackHost
      )
    ).toEqual([true, true, true, true, true, true]);
    expect(
      ['0.0.0.0', '::', '192.0.2.1', 'bead.example', '::ffff:127.0.0.1'].map(isLoopbackHost)
    ).toEqual([false, false, false, false, false]);
  });
});

test.describe('the loopback host', () => {
  test('judges a host as the URL Standard’s host parser reads it: 127.0.0.1., 127.1, the IPv6 loopback and localhost on the loopback, a host followed by a space and localhost. not, alike for a server and its client', () => {
    const hosts: [host: string, isLoopback: boolean][] = [
      ['127.0.0.1.', true],
      ['127.1', true],
      ['[::1]', true],
      ['localhost', true],
      ['localhost.', false],
      ['127.0.0.1 ', false],
      ['localhost ', false],
      ['[::1] ', false],
    ];

    expect(
      hosts.map(([host]) => {
        return [host, isLoopbackHost(host)];
      })
    ).toEqual(hosts);
    expect(
      hosts.map(([host]) => {
        return [host, isSecureUrl(`ws://${host}:8080/`)];
      })
    ).toEqual(hosts);
  });
});

test.describe('the URL Standard’s host parser', () => {
  test('reads a host as the URL Standard’s host parser does and serializes it alike', () => {
    expect(
      PARSED_HOSTS.map(([host]) => {
        // ! a path after it, so that the URL parser trims nothing off the host's end
        return [host, URL.parse(`http://${host}/`)?.hostname];
      })
    ).toEqual(PARSED_HOSTS);
  });
});
