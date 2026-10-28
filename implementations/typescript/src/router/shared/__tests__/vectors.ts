// ── Conformance vectors ───────────────────────────────────────────────────────

// Bead's conformance vectors, read from `spec/vectors.json`: the bytes of envelopes and what
// they say, written once, and read by every implementation's tests — this package's, and the C#
// one's. A vector only one implementation reads is a vector nobody checks.

// dependencies

import { readFileSync } from 'node:fs';
import { CredentialScheme, type EnvelopeKind, type ProtocolCode } from '../constants';
import { toSessionToken } from '../identifiers';
import type { IJwtKey, JwtVerdict } from '../jwt-verifier';
import type { Credential, EnvelopeHeader, IReceivedFailure, RouterSide } from '../types';

// interfaces

/**
 * A credential as the vectors write it: its scheme by name, or by number for a scheme to come; a
 * `JWT`'s token as it is; the bytes of an `OPAQUE` and of a scheme to come in hexadecimal.
 */
export interface IVectorCredential {
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

/**
 * A `JWT`, the keys, the audience or a set of them and the wall clock's reading, an RFC 3339 instant, it is verified
 * against, and the verdict every side gives.
 */
export interface IJwtVerdictVector {
  audience: string | string[];
  keys: IJwtKey[];
  name: string;
  now: string;
  token: string;
  verdict: JwtVerdict;
}

/**
 * A credential a server refuses as it resolves, but a `JWT`'s verdicts: the scheme it presents, by
 * its name or a number to come, the situation a test sets up, the code it is answered, and the one
 * word the access refused is told with (spec 13.12).
 */
export interface ICredentialRefusalVector {
  clauses: string[];
  code: number;
  name: string;
  reason: string;
  scheme: 'ELSEWHERE' | 'JWT' | 'OPAQUE' | number;
  situation:
    | 'another-connections-session'
    | 'end-come'
    | 'no-keys'
    | 'no-session'
    | 'no-verifier'
    | 'nothing-carried'
    | 'scheme-to-come'
    | 'verifier-makes-none';
}

/**
 * A parcel as the vectors write it (spec 15.17): its prefix, its flags but where it is read without
 * them, and its body's fields, its halves, its incarnation and what a DATA carries in hexadecimal.
 */
export interface IParcelVectorFields {
  acceptor: string;
  answers?: number;
  bound?: number;
  carried?: string;
  code?: number;
  credential?: string;
  flags?: number;
  id?: string;
  incarnation?: string;
  kind: number;
  layout: number;
  layouts?: number[];
  opener: string;
  sequence: number;
  status?: number;
}

/** A parcel's bytes and what they say; `written` false where no writer writes it. */
export interface IParcelVector extends INamed {
  clauses: string[];
  parcel: IParcelVectorFields;
  written?: false;
}

/** An MQTT 5 PUBLISH under a Maximum Packet Size: its largest payload and the packet it makes. */
/** A message of AMQP 1.0's profile written to its every byte (spec 15.35). */
export interface IAmqpMessageVector {
  bytes: string;
  clauses: string[];
  name: string;
  payloadByte: number;
  payloadLength: number;
  to: string;
  ttl?: number;
}

/** The largest payload of a message to an address within a bound, and that message's bytes (spec 15.37). */
export interface IAmqpPublishBoundVector {
  address: string;
  clauses: string[];
  largestPayload: number | null;
  maximumMessageSize: number;
  messageBytes: number | null;
  name: string;
}

export interface IMqttPublishBoundVector {
  clauses: string[];
  expiry: boolean;
  largestPayload: number | null;
  maximumPacketSize: number;
  name: string;
  packetBytes: number | null;
  qos: 0 | 1;
  topic: string;
}

/** Bytes that read as no parcel, or as a parcel that does not read. */
export interface IParcelRefusalVector extends INamed {
  clauses: string[];
  refused: 'does-not-read' | 'no-parcel';
}

export interface IVectors {
  amqpMessages: IAmqpMessageVector[];
  amqpPublishBounds: IAmqpPublishBoundVector[];
  credentialRefusals: ICredentialRefusalVector[];
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
  jwtVerdicts: IJwtVerdictVector[];
  mqttPublishBounds: IMqttPublishBoundVector[];
  parcelRefusals: IParcelRefusalVector[];
  parcels: IParcelVector[];
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
