import { createTestClock } from '../../../transport/shared/__tests__/fixtures';
import { CLIENT_FAILURES, CredentialScheme, EnvelopeKind, SERVER_FAILURES } from '../constants';
import { readEnvelope } from '../envelope';
import { FailureError } from '../errors';
import { toSessionToken } from '../identifiers';
import { createRouterCore } from '../router-core';
import type {
  Credential,
  Envelope,
  IProcedure,
  IRequestHeader,
  IRequestResolver,
  IRequestResolverProps,
  IRouterCore,
  IRouterCorePort,
  RouterLimitsOptions,
  SessionToken,
} from '../types';
import { envelopeOf } from './fixtures';

/**
 * What the router core's suites share: its procedure, its envelopes, its port, and what reads
 * what it sent and reported.
 */

// helpers

export type Handle = 'a' | 'b';

export const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
export const options = { timeout: 1_000 };

export const TOKEN = toSessionToken(new Uint8Array(16).fill(1));

// what an answer announces: the session, by its token
export const OPAQUE = Object.freeze({ scheme: CredentialScheme.OPAQUE, token: TOKEN });

/** The bytes a hexadecimal string spells, spaces aside. */
export const fromHexadecimal = (text: string): Uint8Array => {
  const digits = text.replaceAll(/\s/g, '');

  return Uint8Array.from({ length: digits.length / 2 }, (_, index) => {
    return Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  });
};

/**
 * A request's bytes for `procedure`, on `callId`, presenting `credential`, carrying `payload`, the
 * opening of `total`.
 */
export const requestOf = (
  callId: number,
  {
    credential,
    destinationId,
    opensSubscription,
    payload = new Uint8Array(0),
    procedure = echo,
    total,
  }: {
    credential?: Credential;
    destinationId?: number;
    opensSubscription?: true;
    payload?: Uint8Array;
    procedure?: IProcedure;
    total?: number;
  } = {}
): Uint8Array => {
  return envelopeOf({
    header: {
      callId,
      credential,
      destinationId,
      kind: EnvelopeKind.REQUEST,
      opensSubscription,
      procedureId: procedure.procedureId,
      serviceId: procedure.serviceId,
      total,
    },
    kind: EnvelopeKind.REQUEST,
    payload,
  });
};

/** A result's bytes on `callId` that open a transfer of `total`, carrying `payload`. */
export const resultOpeningOf = (
  callId: number,
  { payload, total }: { payload: Uint8Array; total: number }
): Uint8Array => {
  return envelopeOf({
    header: { callId, kind: EnvelopeKind.RESULT, total },
    kind: EnvelopeKind.RESULT,
    payload,
  });
};

/** A credit's bytes on `callId`, up to `creditEnd`. */
export const creditOf = (callId: number, creditEnd = 8): Uint8Array => {
  return envelopeOf({
    header: { callId, creditEnd, kind: EnvelopeKind.CREDIT },
    kind: EnvelopeKind.CREDIT,
  });
};

// envelopes of 64 bytes: a chunk carries 48 bytes at most; a request's opening 44 and a result's 32
export const limits = {
  bufferedBytesBudget: 1_024,
  chunkBytes: 64,
  maximumEnvelopeBytes: 64,
  maximumPayloadBytes: 1_024,
  windowBytes: 128,
};
// a budget two transfers share
export const narrow = { ...limits, bufferedBytesBudget: 200, maximumPayloadBytes: 200 };

/** A chunk's bytes on `callId`: `payload`, from `offset`, the last when it reaches `total`. */
export const chunkOf = (
  callId: number,
  { offset, payload, total }: { offset: number; payload: Uint8Array; total: number }
): Uint8Array => {
  return envelopeOf({
    header: { callId, isLast: offset + payload.length === total, kind: EnvelopeKind.CHUNK, offset },
    kind: EnvelopeKind.CHUNK,
    payload,
  });
};

/** A cancel's bytes on `callId`. */
export const cancelOf = (callId: number): Uint8Array => {
  return envelopeOf({
    header: { callId, kind: EnvelopeKind.CANCEL },
    kind: EnvelopeKind.CANCEL,
  });
};

/** A result's bytes on `callId`. */
export const resultOf = (callId: number, payload = new Uint8Array(0)): Uint8Array => {
  return envelopeOf({
    header: { callId, kind: EnvelopeKind.RESULT },
    kind: EnvelopeKind.RESULT,
    payload,
  });
};

/**
 * A server's port that records what the core does, reads what it sends as the client would, and
 * gives `a` the session `control.sessionTokenOf` says.
 */
export const createPort = (hooks: Partial<IRouterCorePort<Handle>> = {}) => {
  const activities: string[] = [];
  const reported: [error: Error, connectionHandle: Handle][] = [];
  const sent: { connectionHandle: Handle; envelope: Envelope | undefined }[] = [];
  // the bytes of each envelope sent
  const sizes: number[] = [];
  const traced: string[] = [];
  const control = {
    /** Sends held until settled by hand, when set. */
    held: undefined as { reject: (reason: Error) => void; resolve: () => void }[] | undefined,
    /** What a send to each connection rejects with, when set. */
    sendErrors: new Map<Handle, Error>(),
    sessionTokenOf: (_connectionHandle: Handle): SessionToken | undefined => {
      return undefined;
    },
  };

  const port: IRouterCorePort<Handle> = {
    failures: SERVER_FAILURES,

    activity: (activity, connectionHandle) => {
      activities.push(`${activity} ${connectionHandle}`);
    },
    isTracing: () => {
      return true;
    },
    report: (error, connectionHandle) => {
      reported.push([error, connectionHandle]);
    },
    send: ({ data: bytes }, connectionHandle) => {
      const sendError = control.sendErrors.get(connectionHandle);

      sizes.push(bytes.length);
      sent.push({
        connectionHandle,
        envelope: readEnvelope(bytes, {
          failures: CLIENT_FAILURES,
          maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
        }),
      });

      if (control.held !== undefined) {
        const { promise, reject, resolve } = Promise.withResolvers<void>();

        control.held.push({ reject, resolve });

        return promise;
      }

      return sendError === undefined ? Promise.resolve() : Promise.reject(sendError);
    },
    sessionTokenOf: (connectionHandle) => {
      return control.sessionTokenOf(connectionHandle);
    },
    trace: (direction, { connectionHandle, header }) => {
      traced.push(
        `${direction} ${header.kind.toString(16)} ${String(header.callId)} ${connectionHandle}`
      );
    },
    ...hooks,
  };

  return { activities, control, port, reported, sent, sizes, traced };
};

/**
 * What was sent, as a transfer shows it: each envelope's kind and call id; for an opening, its total
 * and the bytes it carries; for a chunk, its offset and its bytes.
 */
export const piecesOf = (sent: { envelope: Envelope | undefined }[]) => {
  return sent.map(({ envelope }) => {
    if (envelope?.kind === EnvelopeKind.REQUEST || envelope?.kind === EnvelopeKind.RESULT) {
      return [
        envelope.kind,
        envelope.header.callId,
        envelope.header.total,
        envelope.payload.length,
      ];
    }

    if (envelope?.kind === EnvelopeKind.CHUNK) {
      return [
        envelope.kind,
        envelope.header.callId,
        envelope.header.offset,
        envelope.payload.length,
      ];
    }

    return [envelope?.kind, envelope?.header.callId];
  });
};

/** The payload a transfer sent on `callId` carried, put together from its opening and its chunks. */
export const payloadOf = (
  sent: { envelope: Envelope | undefined }[],
  callId: number
): Uint8Array => {
  const pieces = sent.flatMap(({ envelope }) => {
    if (envelope === undefined || envelope.header.callId !== callId) {
      return [];
    }

    if (envelope.kind === EnvelopeKind.CHUNK) {
      return [{ bytes: envelope.payload, offset: envelope.header.offset, total: 0 }];
    }

    return envelope.kind === EnvelopeKind.REQUEST || envelope.kind === EnvelopeKind.RESULT
      ? [{ bytes: envelope.payload, offset: 0, total: envelope.header.total ?? 0 }]
      : [];
  });
  const whole = new Uint8Array(
    Math.max(
      ...pieces.map(({ total }) => {
        return total;
      })
    )
  );

  for (const { bytes, offset } of pieces) {
    whole.set(bytes, offset);
  }

  return whole;
};

/** What was reported: a failure's code, or an error's message, and its connection. */
export const codesOf = (reported: [Error, Handle][]) => {
  return reported.map(([error, connectionHandle]) => {
    return [error instanceof FailureError ? error.code : error.message, connectionHandle];
  });
};

/** What was sent: each envelope's kind, call id, and a failure's code or a result's payload. */
export const answersOf = (sent: { connectionHandle: Handle; envelope: Envelope | undefined }[]) => {
  return sent.map(({ connectionHandle, envelope }) => {
    if (envelope?.kind === EnvelopeKind.FAILURE) {
      return [connectionHandle, 'failure', envelope.header.callId, envelope.failure.code];
    }

    if (envelope?.kind === EnvelopeKind.RESULT) {
      return [connectionHandle, 'result', envelope.header.callId, [...envelope.payload]];
    }

    if (envelope?.kind === EnvelopeKind.CREDIT) {
      return [connectionHandle, 'credit', envelope.header.callId, envelope.header.creditEnd];
    }

    return [connectionHandle, envelope?.kind, envelope?.header.callId];
  });
};

/** A resolver for `procedure` that records what it is handed, and resolves. */
export const resolverOf = (procedure: IProcedure, seen: IRequestResolverProps<Handle>[] = []) => {
  return Object.assign((props: IRequestResolverProps<Handle>) => {
    seen.push(props);

    return Promise.resolve();
  }, procedure) as IRequestResolver<Handle>;
};

/** A request header as the core hands one to a resolver. */
export const headerOf = (callId: number): IRequestHeader => {
  return { callId, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 };
};

/** A core with small envelopes that takes the peer's requests on call 1 and on, and hands them over. */
export const createAnswering = (given: RouterLimitsOptions = {}) => {
  const recorded = createPort();
  const seen: IRequestResolverProps<Handle>[] = [];
  const clock = createTestClock();
  const core = createRouterCore(recorded.port, { clock, limits: { ...limits, ...given } });

  core.registerResolver(resolverOf(echo, seen));

  return { ...recorded, clock, core, seen };
};

/** An answer on the call the peer's `index`th request opened. */
export const answerOf = (
  { core, seen }: { core: IRouterCore<Handle>; seen: IRequestResolverProps<Handle>[] },
  { index = 0, payload }: { index?: number; payload: Uint8Array }
) => {
  return core.respond(
    { payload },
    { connectionHandle: 'a', header: seen[index]?.header ?? headerOf(99) }
  );
};

/** What a promise settled with, or `undefined` while it has not. */
export const settledOf = (promise: Promise<unknown>) => {
  return promise.then(
    (value: unknown) => {
      return value;
    },
    (reason: unknown) => {
      return reason;
    }
  );
};

// a line of echo's series in one role's families, by the rest of its name, its labels and its
// value: among the calls a server makes, commands; among those it answers, requests
export const lineOf = (family: string, labels: string) => {
  return (rest: string): string => {
    return `${family}${rest.replace('{}', `{${labels}}`).replace('{outcome', `{${labels},outcome`)}`;
  };
};
