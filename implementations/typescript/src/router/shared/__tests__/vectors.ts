// ── Conformance vectors ───────────────────────────────────────────────────────

// Bead's conformance vectors, read from `spec/vectors.json`: the bytes of envelopes and what
// they say, written once, and read by every implementation's tests — this package's, and the C#
// one's. A vector only one implementation reads is a vector nobody checks.

// dependencies

import { readFileSync } from 'node:fs';
import type { ProtocolCode } from '../constants';
import type { EnvelopeHeader, IReceivedFailure, RouterSide } from '../types';

// interfaces

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

// definition

/** The vectors, as the repository's one file holds them. */
export const VECTORS = JSON.parse(
  readFileSync(new URL('../../../../../../spec/vectors.json', import.meta.url), 'utf8')
) as IVectors;
