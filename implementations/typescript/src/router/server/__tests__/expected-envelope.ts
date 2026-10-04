// ── Expected envelope ─────────────────────────────────────────────────────────

// An envelope the server sent, as `spec/conversations.json` writes what it expects, and as
// `spec/transports.json` expects the envelope of a response or of a batch.

// dependencies

import { readEnvelope } from '../../shared/envelope';
import type { Envelope } from '../../shared/types';
import { CLIENT_FAILURES, CredentialScheme, EnvelopeKind } from '../router-server';

// interfaces

/** The next envelope a conversation expects the server to send. */
export interface IExpected {
  callId: number;
  creditEnd?: number;
  isLast?: boolean;
  offset?: number;
  total?: number;
  credential?: 'NONE' | 'OPAQUE';
  failure?: { code: number; relays: number; scope: number };
  flags?: number | undefined;
  kind: number;
  payload?: string;
  procedureId?: number;
  serviceId?: number;
}

// helpers

/** Bytes as the conformance files write them: hexadecimal, a space between bytes. */
export const hexadecimalOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).toUpperCase().padStart(2, '0');
    })
    .join(' ');
};

/**
 * What an answer announced of its connection's session, by its scheme alone, since its token is
 * random: `OPAQUE`, a token; `NONE`, its end; nothing, no block.
 */
const announcementOf = (envelope: Envelope): Pick<IExpected, 'credential'> => {
  const { credential } = envelope.header as { credential?: { scheme: number } };

  if (credential === undefined) {
    return {};
  }

  return { credential: credential.scheme === CredentialScheme.NONE ? 'NONE' : 'OPAQUE' };
};

// definition

/** The bytes of an envelope sent, as a conversation writes what it expects. */
export const expectedOf = (bytes: Uint8Array): IExpected | undefined => {
  const envelope = readEnvelope(bytes, {
    failures: CLIENT_FAILURES,
    maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
  });

  if (envelope === undefined) {
    return undefined;
  }

  const { callId } = envelope.header;

  if (envelope.kind === EnvelopeKind.FAILURE) {
    const { code, relays, scope } = envelope.failure;

    return {
      callId,
      failure: { code, relays, scope },
      kind: envelope.kind,
      ...announcementOf(envelope),
    };
  }

  if (envelope.kind === EnvelopeKind.RESULT || envelope.kind === EnvelopeKind.NOTIFICATION) {
    const { total } = envelope.header as { total?: number };

    return {
      callId,
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      ...announcementOf(envelope),
      ...(total === undefined ? {} : { total }),
    };
  }

  if (envelope.kind === EnvelopeKind.CHUNK) {
    const { isLast, offset } = envelope.header;

    return {
      callId,
      isLast,
      kind: envelope.kind,
      offset,
      payload: hexadecimalOf(envelope.payload),
    };
  }

  if (envelope.kind === EnvelopeKind.CREDIT) {
    return { callId, creditEnd: envelope.header.creditEnd, kind: envelope.kind };
  }

  // a command the server sends its client, its flags the byte after its kind
  if (envelope.kind === EnvelopeKind.REQUEST) {
    const { procedureId, serviceId } = envelope.header;

    return {
      callId,
      flags: bytes[2],
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      procedureId,
      serviceId,
    };
  }

  return { callId, kind: envelope.kind };
};
