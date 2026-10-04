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
