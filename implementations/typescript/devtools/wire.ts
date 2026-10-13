// ── The wire, read ────────────────────────────────────────────────────────────

// What the panel reads of the HTTP transport's exchanges, for a page whose clients announce
// nothing: a `POST`'s body is one envelope, and an answer's or a listen's a batch of them, each after
// its length on 4 bytes, big-endian, read with the package's own codec.

// dependencies

import { CLIENT_FAILURES, LIMIT_DEFAULTS } from '../src/router/client/router-client';
import { readEnvelope } from '../src/router/shared/envelope';
import { readHeader } from '../src/router/shared/header';
import { BEAD_MEDIA_TYPE } from '../src/transport/shared/constants';
import { plainHeaderOf } from './records';

// interfaces

/** An envelope read off the wire: its header made plain, what follows it, and its bytes. */
export interface IWireEnvelope {
  /** Its bytes, its header's and what follows. */
  bytes: Uint8Array;
  /** A failure's code, scope, detail, and the relays it crossed. */
  failure?: { code: number; detail: string; relays: number; scope: number } | undefined;
  header: Record<string, boolean | number | string>;
  /** The bytes its header takes, before its payload or its failure's record. */
  headerBytes: number;
  /** The bytes of its payload, or of its chunk. */
  payloadBytes?: number | undefined;
}

/** What a body held: its envelopes, and why the rest did not read. */
export interface IWireReading {
  envelopes: IWireEnvelope[];
  problem?: string | undefined;
}

// constants

/** The bytes a batch's length takes before each envelope. */
const LENGTH_BYTES = 4;

// helpers

/** An envelope's bytes, read; a refusal of the codec's is thrown. */
const envelopeOf = (bytes: Uint8Array): IWireEnvelope => {
  const envelope = readEnvelope(bytes, {
    failures: CLIENT_FAILURES,
    maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
  });

  if (envelope === undefined) {
    return { bytes, header: { advisory: true }, headerBytes: bytes.length };
  }

  return {
    bytes,
    failure:
      'failure' in envelope
        ? {
            code: envelope.failure.code,
            detail: envelope.failure.detail,
            relays: envelope.failure.relays,
            scope: envelope.failure.scope,
          }
        : undefined,
    header: plainHeaderOf(envelope.header),
    headerBytes: readHeader(bytes, CLIENT_FAILURES)?.headerBytes ?? bytes.length,
    payloadBytes: 'payload' in envelope ? envelope.payload.length : undefined,
  };
};

// definition

/** Whether a content type, its parameters aside, is Bead's own, `application/prs.bead`. */
export const isBeadType = (type: string | undefined): boolean => {
  return type?.split(';')[0]?.trim().toLowerCase() === BEAD_MEDIA_TYPE;
};

/** A body's bytes from what DevTools gives: base64, or text whose every character is a byte. */
export const bytesOfContent = (content: {
  encoding?: string | undefined;
  text: string;
}): Uint8Array | undefined => {
  if (content.encoding === 'base64') {
    return Uint8Array.from(atob(content.text), (character) => {
      return character.charCodeAt(0);
    });
  }

  const codes = Array.from(content.text, (character) => {
    return character.charCodeAt(0);
  });

  return codes.every((code) => {
    return code < 256;
  })
    ? Uint8Array.from(codes)
    : undefined;
};

/** What a body holds: one envelope, or a batch of them, each after its length. */
export const readBody = (bytes: Uint8Array, shape: 'batch' | 'envelope'): IWireReading => {
  const envelopes: IWireEnvelope[] = [];

  try {
    if (shape === 'envelope') {
      return { envelopes: [envelopeOf(bytes)] };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    while (offset < bytes.length) {
      if (bytes.length - offset < LENGTH_BYTES) {
        return {
          envelopes,
          problem: `${String(bytes.length - offset)} bytes left, short of a length`,
        };
      }

      const length = view.getUint32(offset);

      offset += LENGTH_BYTES;

      if (length === 0 || length > bytes.length - offset) {
        return {
          envelopes,
          problem: `a length of ${String(length)}, with ${String(bytes.length - offset)} bytes left`,
        };
      }

      envelopes.push(envelopeOf(bytes.subarray(offset, offset + length)));
      offset += length;
    }

    return { envelopes };
  } catch (reason) {
    return { envelopes, problem: reason instanceof Error ? reason.message : String(reason) };
  }
};
