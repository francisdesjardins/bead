// ── TLS ───────────────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError, toError } from './errors';
import type { ITlsOptions } from './types';

// interfaces

/** What a client hands Node's TLS of its own: `ws`, undici, MQTT.js and rhea take it alike. */
export interface INodeTlsOptions {
  ca?: string;
  cert?: string;
  key?: string;
}

// the part of `node:crypto` the rules read
interface ICryptoLike {
  createPrivateKey(key: string): unknown;
  X509Certificate: new (certificate: string) => { checkPrivateKey(key: unknown): boolean };
}

// the part of `node:tls` the rules read
interface ITlsLike {
  createSecureContext(options: INodeTlsOptions): unknown;
}

// the part of Node a page has none of
interface IProcessLike {
  getBuiltinModule?: ((id: string) => unknown) | undefined;
  versions?: { node?: unknown } | undefined;
}

// constants

/** The words of a client's refusal in a page, which ends where an adapter goes on. */
export const NO_TLS_IN_A_PAGE = 'a page chooses no TLS client certificate, its browser does';

// each PEM block, its label and its text whole (RFC 7468 §2)
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/gu;

// the labels of an unencrypted private key: PKCS #8, SEC1 and PKCS #1
const KEY_LABELS: ReadonlySet<string> = new Set([
  'PRIVATE KEY',
  'EC PRIVATE KEY',
  'RSA PRIVATE KEY',
]);

// a PKCS #8 key encrypted (RFC 5958 §3)
const ENCRYPTED_LABEL = 'ENCRYPTED PRIVATE KEY';

// an OpenSSL key encrypted in its legacy PEM, under a label of an unencrypted one (RFC 1421 §4.6.1.1)
const LEGACY_ENCRYPTION = /^Proc-Type:\s*4,\s*ENCRYPTED/mu;

// the code OpenSSL fails a certificate's context by when its key is another's
const KEY_MISMATCH = 'ERR_OSSL_X509_KEY_VALUES_MISMATCH';

const NOT_PAIRED = 'a TLS client certificate is given with its key, and a key with its certificate';

const NOT_ITS_KEY = "the key is not the certificate's";

// helpers

/** Each block of `pem` under `label`, its text whole. */
const blocksOf = (pem: string, label: string): string[] => {
  return [...pem.matchAll(PEM_BLOCK)]
    .filter((match) => {
      return match[1] === label;
    })
    .map((match) => {
      return match[0];
    });
};

// ! read as it is called, never as the module loads: a test swaps `globalThis.process`
const processOf = (): IProcessLike | undefined => {
  return (globalThis as { process?: IProcessLike }).process;
};

/** The first certificate of `pem` read, each of them read, or the refusal naming `member`. */
const certificateOf = (
  pem: string,
  { crypto, member }: { crypto: ICryptoLike; member: string }
): InstanceType<ICryptoLike['X509Certificate']> => {
  const refusal = `${member} reads as no certificate`;
  const read = blocksOf(pem, 'CERTIFICATE').map((block) => {
    try {
      return new crypto.X509Certificate(block);
    } catch (reason) {
      throw new ProgrammerError(refusal, { cause: toError(reason) });
    }
  });
  const [first] = read;

  if (first === undefined) {
    throw new ProgrammerError(refusal);
  }

  return first;
};

/**
 * `key` read: one block under a label of an unencrypted key, beside none encrypted, the others
 * left, as OpenSSL's `EC PARAMETERS` before its key; or `key reads as no key`.
 */
const keyOf = (pem: string, crypto: ICryptoLike): unknown => {
  const blocks = [...pem.matchAll(PEM_BLOCK)];
  const keys = blocks.filter(([, label]) => {
    return label !== undefined && KEY_LABELS.has(label);
  });
  const [block] = keys;

  // * an encrypted key is refused before Node reads it, whose reading would ask its passphrase
  if (
    block === undefined ||
    keys.length !== 1 ||
    LEGACY_ENCRYPTION.test(block[0]) ||
    blocks.some(([, label]) => {
      return label === ENCRYPTED_LABEL;
    })
  ) {
    throw new ProgrammerError('key reads as no key');
  }

  try {
    return crypto.createPrivateKey(block[0]);
  } catch (reason) {
    throw new ProgrammerError('key reads as no key', { cause: toError(reason) });
  }
};

// definition

/** A module of Node's, through `process.getBuiltinModule`, so that no page's bundle imports it. */
export const builtinOf = (id: string): unknown => {
  const getBuiltinModule = processOf()?.getBuiltinModule;

  if (getBuiltinModule === undefined) {
    throw new ProgrammerError(`${NO_TLS_IN_A_PAGE}: ${id} is Node's`);
  }

  return getBuiltinModule(id);
};

/** Whether the code runs in Node, rather than a page: what a TLS of its application's needs. */
export const isNode = (): boolean => {
  return typeof processOf()?.versions?.node === 'string';
};

/**
 * `tls` as a client takes it: none when no member is given (spec 15.39).
 */
export const tlsOf = (tls: ITlsOptions | undefined): ITlsOptions | undefined => {
  if (
    tls === undefined ||
    (tls.authorities === undefined && tls.certificate === undefined && tls.key === undefined)
  ) {
    return undefined;
  }

  return tls;
};

/**
 * Holds `tls` as a client is built, in Node (spec 15.39), with a {@link ProgrammerError}: a
 * certificate without its key or a key without its certificate; then authorities or a certificate
 * holding no `CERTIFICATE` block, or one that does not read; a key that does not read, or that is
 * encrypted; and a key of another certificate than the first of `certificate`. Node's own context is
 * built last, from what passed, so that what it alone refuses is refused here, never at a connect.
 */
export const assertTls = (tls: ITlsOptions): void => {
  const { authorities, certificate, key } = tls;

  if ((certificate === undefined) !== (key === undefined)) {
    throw new ProgrammerError(NOT_PAIRED);
  }

  const crypto = builtinOf('node:crypto') as ICryptoLike;
  const nodeTls = builtinOf('node:tls') as ITlsLike;

  // ! Node's context takes a `ca` that holds no certificate in silence, and a `cert` without its
  // `key`: each is read here, block by block
  if (authorities !== undefined) {
    certificateOf(authorities, { crypto, member: 'authorities' });

    try {
      nodeTls.createSecureContext({ ca: authorities });
    } catch (reason) {
      throw new ProgrammerError('authorities reads as no certificate', {
        cause: toError(reason),
      });
    }
  }

  if (certificate === undefined || key === undefined) {
    return;
  }

  const leaf = certificateOf(certificate, { crypto, member: 'certificate' });

  if (!leaf.checkPrivateKey(keyOf(key, crypto))) {
    throw new ProgrammerError(NOT_ITS_KEY);
  }

  try {
    nodeTls.createSecureContext({ cert: certificate, key });
  } catch (reason) {
    const error = toError(reason);
    const isMismatch = (error as { code?: unknown }).code === KEY_MISMATCH;

    throw new ProgrammerError(isMismatch ? NOT_ITS_KEY : 'key reads as no key', { cause: error });
  }
};

/** What Node's TLS of a client's library takes for `tls`: `ca`, `cert` and `key`, each given alone. */
export const nodeTlsOf = (tls: ITlsOptions | undefined): INodeTlsOptions => {
  const { authorities, certificate, key } = tls ?? {};

  return {
    ...(authorities === undefined ? {} : { ca: authorities }),
    ...(certificate === undefined ? {} : { cert: certificate }),
    ...(key === undefined ? {} : { key }),
  };
};
