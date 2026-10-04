// ── Conformance vectors ───────────────────────────────────────────────────────

// Bead's conformance vectors, read from `spec/vectors.json`: the bytes of envelopes and what
// they say, written once, and read by every implementation's tests — this package's, and the C#
// one's. A vector only one implementation reads is a vector nobody checks.

// dependencies

import { readFileSync } from 'node:fs';
import { CredentialScheme, type EnvelopeKind, type ProtocolCode } from '../constants';
import { toSessionToken } from '../identifiers';
import type { Credential, EnvelopeHeader, IReceivedFailure, RouterSide } from '../types';

// interfaces

/**
 * A credential as the vectors write it: its scheme by name, or by number for a scheme to come; a
 * `JWT`'s token as it is; the bytes of an `OPAQUE` and of a scheme to come in hexadecimal.
 */
interface IVectorCredential {
  bytes?: string;
  scheme: keyof typeof CredentialScheme | number;
  token?: string;
}

/** A header as the vectors write it: as this package's, but for its credential. */
interface IVectorHeader {
  [field: string]: unknown;
  callId: number;
  credential?: IVectorCredential;
  kind: EnvelopeKind;
}

/** A vector's name, and the bytes it is about. */
interface INamed {
  bytes: string;
  name: string;
}

/**
 * Bytes a reader refuses, and the protocol code it answers with; its detail, this implementation's own words; and
 * the bound on a whole envelope it reads them with, where the vector is about that bound.
 */
export interface IRefusalVector extends INamed {
  code: ProtocolCode;
  detail?: string;
  maximumEnvelopeBytes?: number;
}

/** A whole envelope as the vectors write it: its payload in hexadecimal, or its failure's record. */
export interface IEnvelopeVector {
  failure?: IReceivedFailure;
  header: EnvelopeHeader;
  kind: number;
  payload?: string;
}

export interface IVectors {
  envelopeRefusals: IRefusalVector[];
  envelopes: (INamed & { envelope: IEnvelopeVector })[];
  failureRefusals: { code: ProtocolCode; name: string; record: string }[];
  failures: {
    failure: IReceivedFailure;
    maximumDetailBytes?: number;
    name: string;
    record: string;
  }[];
  headerRefusals: IRefusalVector[];
  headers: (INamed & { header: EnvelopeHeader })[];
  prefixRefusals: IRefusalVector[];
  prefixes: (INamed & { prefix: { callId: number; kind: number; layout: number } })[];
  reads: (INamed & { header: EnvelopeHeader | null; side: RouterSide })[];
}

// helpers

/** The bytes a hexadecimal string spells, spaces and bars aside. */
export const fromHexadecimal = (text: string): Uint8Array => {
  const digits = text.replaceAll(/[\s|]/g, '');

  return Uint8Array.from({ length: digits.length / 2 }, (_, index) => {
    return Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  });
};

/** A credential the vectors write, as a header carries it. */
const credentialOf = ({ bytes = '', scheme, token = '' }: IVectorCredential): Credential => {
  switch (scheme) {
    case 'NONE':
      return { scheme: CredentialScheme.NONE };
    case 'OPAQUE':
      return { scheme: CredentialScheme.OPAQUE, token: toSessionToken(fromHexadecimal(bytes)) };
    case 'JWT':
      return { scheme: CredentialScheme.JWT, token };
    case 'ELSEWHERE':
      return { scheme: CredentialScheme.ELSEWHERE };
    default:
      return { bytes: fromHexadecimal(bytes), scheme };
  }
};

/** A header the vectors write, as this package reads it. */
const headerOf = (header: IVectorHeader): EnvelopeHeader => {
  const { credential, ...rest } = header;

  // the vectors' schema holds every other field to a header's
  return (
    credential === undefined ? rest : { ...rest, credential: credentialOf(credential) }
  ) as EnvelopeHeader;
};

// definition

/** The vectors, as the repository's one file holds them, each header as this package reads it. */
export const VECTORS = ((): IVectors => {
  const written = JSON.parse(
    readFileSync(new URL('../../../../../../spec/vectors.json', import.meta.url), 'utf8')
  ) as Omit<IVectors, 'envelopes' | 'headers' | 'reads'> & {
    envelopes: (INamed & {
      envelope: Omit<IEnvelopeVector, 'header'> & { header: IVectorHeader };
    })[];
    headers: (INamed & { header: IVectorHeader })[];
    reads: (INamed & { header: IVectorHeader | null; side: RouterSide })[];
  };

  return {
    ...written,
    envelopes: written.envelopes.map(({ envelope, ...vector }) => {
      return { ...vector, envelope: { ...envelope, header: headerOf(envelope.header) } };
    }),
    headers: written.headers.map(({ header, ...vector }) => {
      return { ...vector, header: headerOf(header) };
    }),
    reads: written.reads.map(({ header, ...vector }) => {
      return { ...vector, header: header === null ? null : headerOf(header) };
    }),
  };
})();
