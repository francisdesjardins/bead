import { createPrivateKey } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../errors';
import { assertTls, isNode, nodeTlsOf, tlsOf } from '../tls';
import { PKI } from './tls-front';

// constants

const NOT_PAIRED = 'a TLS client certificate is given with its key, and a key with its certificate';

// the client's key, encrypted under a passphrase: in PKCS #8, and in OpenSSL's legacy SEC1
const ENCRYPTED = [
  createPrivateKey(PKI.clientKey).export({
    cipher: 'aes-256-cbc',
    format: 'pem',
    passphrase: 'passphrase',
    type: 'pkcs8',
  }) as string,
  createPrivateKey(PKI.clientKey).export({
    cipher: 'aes-256-cbc',
    format: 'pem',
    passphrase: 'passphrase',
    type: 'sec1',
  }) as string,
];

// helpers

/** The refusal `assertTls` throws for `tls`, which must be a {@link ProgrammerError}. */
const refusalOf = (tls: Parameters<typeof assertTls>[0]): string => {
  try {
    assertTls(tls);
  } catch (error) {
    expect(error).toBeInstanceOf(ProgrammerError);

    return (error as Error).message;
  }

  return 'taken';
};

// definition

test.describe('assertTls', () => {
  // spec 15.39
  test('refuses as it is built a certificate without its key or a key without its certificate, a key of another, an encrypted one, and a certificate or authorities that read as no certificate', () => {
    expect(refusalOf({ certificate: PKI.clientChain })).toBe(NOT_PAIRED);
    expect(refusalOf({ authorities: PKI.root, key: PKI.clientKey })).toBe(NOT_PAIRED);
    expect(refusalOf({ certificate: PKI.clientChain, key: PKI.serverKey })).toBe(
      "the key is not the certificate's"
    );

    for (const key of ENCRYPTED) {
      expect(refusalOf({ certificate: PKI.clientChain, key })).toBe('key reads as no key');
    }

    expect(refusalOf({ certificate: PKI.clientChain, key: 'nope' })).toBe('key reads as no key');
    expect(refusalOf({ certificate: PKI.clientChain, key: PKI.client })).toBe(
      'key reads as no key'
    );

    for (const pem of [
      'nope',
      PKI.clientKey,
      '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----',
    ]) {
      expect(refusalOf({ authorities: pem })).toBe('authorities reads as no certificate');
      expect(refusalOf({ certificate: pem, key: PKI.clientKey })).toBe(
        'certificate reads as no certificate'
      );
    }

    // what reads: the chain under its key, in PKCS #8 and in SEC1, beside the authorities
    const sec1 = createPrivateKey(PKI.clientKey).export({ format: 'pem', type: 'sec1' }) as string;

    for (const key of [PKI.clientKey, sec1]) {
      expect(refusalOf({ authorities: PKI.root, certificate: PKI.clientChain, key })).toBe('taken');
    }
  });

  test('gives Node’s TLS each member given alone, and takes a tls of no member as none', () => {
    expect(isNode()).toBe(true);
    expect(tlsOf(undefined)).toBeUndefined();
    expect(tlsOf({})).toBeUndefined();
    expect(
      tlsOf({ authorities: undefined, certificate: undefined, key: undefined })
    ).toBeUndefined();
    expect(nodeTlsOf({ authorities: PKI.root })).toEqual({ ca: PKI.root });
    expect(nodeTlsOf({ certificate: PKI.clientChain, key: PKI.clientKey })).toEqual({
      cert: PKI.clientChain,
      key: PKI.clientKey,
    });
    expect(nodeTlsOf(undefined)).toEqual({});
  });
});
