import { expect, test } from '@playwright/test';
import {
  HOST_REFUSAL,
  isTakenHost,
  isTakenOrigin,
  isWellFormedHost,
  ORIGIN_REFUSAL,
} from '../hosts-and-origins';

// constants

// the rows the C# side judges alike
const HOSTS = ['bead.test', '127.0.0.1:8080', 'xn--bad-bma.test'];
const TAKEN_HOSTS = ['bead.test', 'Bead.Test', 'BEAD.TEST', '127.0.0.1:8080', 'XN--BAD-BMA.test'];
const OTHER_HOSTS = [
  undefined,
  '',
  'elsewhere.test',
  'bead.test:8080',
  '127.0.0.1',
  'béad.test',
  'xn--a.test',
];
const ORIGINS = ['https://bead.example', 'null'];

// a `Host` value HTTP takes, `uri-host` and an optional port, and one it does not (RFC 9112 §3.2):
// the rows the C# side judges alike
const WELL_FORMED_HOSTS = [
  'bead.test',
  'bead.test:8080',
  'BEAD.test:8080',
  'bead.test:',
  'BEAD.TEST',
  '',
  ':8080',
  '127.0.0.1',
  '127.0.0.1:8080',
  '[::1]',
  '[::1]:8080',
  '[2001:db8::7]',
  '[::ffff:127.0.0.1]',
  '[::ffff:192.0.2.1]',
  '[v1.fe80::a+en1]',
  'xn--a',
  'xn---bad-cpa.test',
  'bead%2Etest',
  'b%C3%A9ad.test',
  'bead_test~',
  "!$&'()*+,;=",
  "a-._~!$&'()*+,;=b",
  ' bead.test\t',
];
const MALFORMED_HOSTS = [
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
  test('takes a Host HTTP takes: one line, none in a request that needs none, its value uri-host and an optional port without the whitespace around it', () => {
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

  test('takes every host when given none, and among those given in any ASCII case', () => {
    expect(
      ['elsewhere.test', 'xn--a', undefined].map((host) => {
        return isTakenHost(host, undefined);
      })
    ).toEqual([true, true, true]);
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
    expect([HOST_REFUSAL, ORIGIN_REFUSAL]).toEqual(['host-refused', 'origin-refused']);
  });

  test('takes a request with no Origin, one among those given, and the server’s own: http:// or https:// followed by its Host, in any ASCII case, nothing parsed', () => {
    // no page, or one among those given, exactly
    expect(
      [undefined, 'https://bead.example', 'null', 'https://Bead.Example'].map((origin) => {
        return isTakenOrigin(origin, { host: 'bead.test', origins: ORIGINS });
      })
    ).toEqual([true, true, true, false]);

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

  test('folds ASCII alone: a host that differs past ASCII is another', () => {
    // the Kelvin sign and a dotted capital I, which a fold past ASCII would take for a k and an i;
    // an i without its dot and an É, which it would take for an I and an é
    expect(isTakenHost('Key.test', ['key.test'])).toBe(false);
    expect(isTakenHost('İtem.test', ['item.test'])).toBe(false);
    expect(isTakenHost('bead.ıo', ['bead.io'])).toBe(false);
    expect(isTakenHost('bÉad.test', ['béad.test'])).toBe(false);
    expect(isTakenHost('BéAD.test', ['béad.test'])).toBe(true);
    expect(isTakenOrigin('http://key.test', { host: 'Key.test', origins: [] })).toBe(false);
    expect(isTakenOrigin('http://item.test', { host: 'İtem.test', origins: [] })).toBe(false);
    expect(isTakenOrigin('http://bead.io', { host: 'BEAD.ıO', origins: [] })).toBe(false);
  });
});
