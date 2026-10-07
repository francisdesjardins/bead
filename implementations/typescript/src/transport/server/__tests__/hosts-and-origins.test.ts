import { expect, test } from '@playwright/test';
import { HOST_REFUSAL, isTakenHost, isTakenOrigin, ORIGIN_REFUSAL } from '../hosts-and-origins';

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
