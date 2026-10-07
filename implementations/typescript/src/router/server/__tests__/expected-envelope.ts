// ── Expected envelope ─────────────────────────────────────────────────────────

// An envelope the server sent, as `spec/conversations.json` writes what it expects, and as
// `spec/transports.json` expects the envelope of a response or of a batch.

// dependencies

import { readEnvelope } from '../../shared/envelope';
import { toSessionTokenBytes } from '../../shared/identifiers';
import type { Credential, Envelope } from '../../shared/types';
import type { IVectorCredential } from '../../shared/__tests__/vectors';
import { CLIENT_FAILURES, CredentialScheme, EnvelopeKind } from '../router-server';

// interfaces

/** The next envelope a conversation expects the server to send. */
export interface IExpected {
  callId: number;
  creditEnd?: number;
  isLast?: boolean;
  offset?: number;
  total?: number;
  /**
   * An answer's, the scheme of what it announced; a request's, the credential it presents, as the
   * vectors write a header's.
   */
  credential?: 'NONE' | 'OPAQUE' | IVectorCredential;
  /** Its detail only where a conversation gives one: informative elsewhere. */
  failure?: { code: number; detail?: string | undefined; relays: number; scope: number };
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

/** The credential a request presents, as the vectors write a header's: a `JWT`'s token as it is. */
const presentedOf = (credential: Credential): IVectorCredential => {
  if (credential.scheme === CredentialScheme.JWT && 'token' in credential) {
    return { scheme: 'JWT', token: credential.token };
  }

  if (credential.scheme === CredentialScheme.ELSEWHERE) {
    return { scheme: 'ELSEWHERE' };
  }

  if (credential.scheme === CredentialScheme.OPAQUE && 'token' in credential) {
    return { bytes: hexadecimalOf(toSessionTokenBytes(credential.token)), scheme: 'OPAQUE' };
  }

  return {
    bytes: 'bytes' in credential ? hexadecimalOf(credential.bytes) : '',
    scheme: credential.scheme,
  };
};

/** An envelope sent, read as a client reads it. */
const envelopeOf = (bytes: Uint8Array): Envelope | undefined => {
  return readEnvelope(bytes, {
    failures: CLIENT_FAILURES,
    maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
  });
};

// definition

/** The detail of the failure an envelope sent carries; `undefined` for any other envelope. */
export const failureDetailOf = (bytes: Uint8Array): string | undefined => {
  const envelope = envelopeOf(bytes);

  return envelope?.kind === EnvelopeKind.FAILURE ? envelope.failure.detail : undefined;
};

/** The 16 bytes of the token an answer sent announced, `OPAQUE`; `undefined` for any other. */
export const announcedTokenOf = (bytes: Uint8Array): Uint8Array | undefined => {
  const envelope = envelopeOf(bytes);
  const credential =
    envelope?.kind === EnvelopeKind.RESULT || envelope?.kind === EnvelopeKind.FAILURE
      ? envelope.header.credential
      : undefined;

  return credential?.scheme === CredentialScheme.OPAQUE
    ? toSessionTokenBytes(credential.token)
    : undefined;
};

/** The bytes of an envelope sent, as a conversation writes what it expects. */
export const expectedOf = (bytes: Uint8Array): IExpected | undefined => {
  const envelope = envelopeOf(bytes);

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

  // a command the server sends its client, or a relay's leg B, its flags the byte after its kind
  if (envelope.kind === EnvelopeKind.REQUEST) {
    const { credential, procedureId, serviceId } = envelope.header;

    return {
      callId,
      flags: bytes[2],
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      procedureId,
      serviceId,
      ...(credential === undefined ? {} : { credential: presentedOf(credential) }),
    };
  }

  return { callId, kind: envelope.kind };
};
