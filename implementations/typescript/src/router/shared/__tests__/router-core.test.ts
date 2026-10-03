import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  createTestClock,
  hasRef,
  timersBy,
  timersUntil,
} from '../../../transport/shared/__tests__/fixtures';
import { CancelError, ProgrammerError, TimeoutError } from '../../../transport/shared/errors';
import {
  CLIENT_FAILURES,
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { readEnvelope } from '../envelope';
import { DisconnectError, FailureError } from '../errors';
import { toSessionToken } from '../identifiers';
import { createRouterCore } from '../router-core';
import type {
  Envelope,
  ICreditHeader,
  INotificationHeader,
  IProcedure,
  IRequestHandler,
  IRequestHeader,
  IRequestResolver,
  IRequestResolverProps,
  IRouterCore,
  IRouterCorePort,
  OutgoingEnvelope,
  RouterLimitsOptions,
  SessionToken,
} from '../types';
import { callIdsOf, createLoopback, digestOf, envelopeOf, patternOf } from './fixtures';

// helpers

type Handle = 'a' | 'b';

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
const options = { timeout: 1_000 };

const TOKEN = toSessionToken(new Uint8Array(16).fill(1));
const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(2));

/** The bytes a hexadecimal string spells, spaces aside. */
const fromHexadecimal = (text: string): Uint8Array => {
  const digits = text.replaceAll(/\s/g, '');

  return Uint8Array.from({ length: digits.length / 2 }, (_, index) => {
    return Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  });
};

/** A request's bytes for `procedure`, on `callId`, carrying `payload`, the opening of `total`. */
const requestOf = (
  callId: number,
  {
    destinationId,
    opensSubscription,
    payload = new Uint8Array(0),
    procedure = echo,
    total,
  }: {
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
const resultOpeningOf = (
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
const creditOf = (callId: number, creditEnd = 8): Uint8Array => {
  return envelopeOf({
    header: { callId, creditEnd, kind: EnvelopeKind.CREDIT },
    kind: EnvelopeKind.CREDIT,
  });
};

// envelopes of 64 bytes: a chunk carries 48 bytes at most; a request's opening 44 and a result's 32
const limits = {
  bufferedBytesBudget: 1_024,
  chunkBytes: 64,
  maximumEnvelopeBytes: 64,
  maximumPayloadBytes: 1_024,
  windowBytes: 128,
};
// a budget two transfers share
const narrow = { ...limits, bufferedBytesBudget: 200, maximumPayloadBytes: 200 };

/** A chunk's bytes on `callId`: `payload`, from `offset`, the last when it reaches `total`. */
const chunkOf = (
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
const cancelOf = (callId: number): Uint8Array => {
  return envelopeOf({
    header: { callId, kind: EnvelopeKind.CANCEL },
    kind: EnvelopeKind.CANCEL,
  });
};

/** A result's bytes on `callId`. */
const resultOf = (callId: number, payload = new Uint8Array(0)): Uint8Array => {
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
const createPort = (hooks: Partial<IRouterCorePort<Handle>> = {}) => {
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
    report: (error, connectionHandle) => {
      reported.push([error, connectionHandle]);
    },
    send: (bytes, connectionHandle) => {
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
const piecesOf = (sent: { envelope: Envelope | undefined }[]) => {
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
const payloadOf = (sent: { envelope: Envelope | undefined }[], callId: number): Uint8Array => {
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
const codesOf = (reported: [Error, Handle][]) => {
  return reported.map(([error, connectionHandle]) => {
    return [error instanceof FailureError ? error.code : error.message, connectionHandle];
  });
};

/** What was sent: each envelope's kind, call id, and a failure's code or a result's payload. */
const answersOf = (sent: { connectionHandle: Handle; envelope: Envelope | undefined }[]) => {
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
const resolverOf = (procedure: IProcedure, seen: IRequestResolverProps<Handle>[] = []) => {
  return Object.assign((props: IRequestResolverProps<Handle>) => {
    seen.push(props);

    return Promise.resolve();
  }, procedure) as IRequestResolver<Handle>;
};

/** A request header as the core hands one to a resolver. */
const headerOf = (callId: number): IRequestHeader => {
  return { callId, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 };
};

// definition

test.describe('createRouterCore', () => {
  test.describe('takes what comes in', () => {
    test('read, traced, then dispatched; what does not read is reported, not traced', () => {
      const { port, reported, traced } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const nextCallId = callIdsOf('client');
      const callId = nextCallId();

      core.registerResolver(resolverOf(echo, seen));
      core.receive('text', 'a');
      core.receive(Uint8Array.of(0x0a, 0xff), 'b');
      core.receive(requestOf(callId, { payload: Uint8Array.of(7) }), 'a');

      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'b'],
      ]);
      expect(reported[0]?.[0].cause).toBeInstanceOf(TypeError);
      expect(traced).toEqual([`rx 10 ${String(callId)} a`]);
      // admitted already: its resolver asks nothing again
      expect(seen).toEqual([
        {
          connectionHandle: 'a',
          header: headerOf(callId),
          isAdmitted: true,
          payload: Uint8Array.of(7),
          signal: expect.any(AbortSignal),
        },
      ]);
    });

    test('asks a request’s admission on its header, once, past its route and before its payload: a refusal answers it before any credit', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const seen: IRequestResolverProps<Handle>[] = [];
      const asked: [callId: number, keys: string[]][] = [];
      const payload = patternOf(100);

      core.registerResolver(
        Object.assign(resolverOf(echo, seen), {
          admit: (request: { header: IRequestHeader }) => {
            asked.push([request.header.callId, Object.keys(request)]);

            return request.header.callId === 3 || request.header.callId === 7
              ? SERVER_FAILURES.accessDenied
              : undefined;
          },
        })
      );
      // whole, then as a transfer: admitted, then refused
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3), 'a');
      core.receive(requestOf(5, { payload: payload.subarray(0, 40), total: 100 }), 'a');
      core.receive(chunkOf(5, { offset: 40, payload: payload.subarray(40, 88), total: 100 }), 'a');
      core.receive(chunkOf(5, { offset: 88, payload: payload.subarray(88), total: 100 }), 'a');
      core.receive(requestOf(7, { payload: payload.subarray(0, 40), total: 100 }), 'a');
      // no route: never asked
      core.receive(requestOf(9, { procedure: { ...echo, serviceId: 8 } }), 'a');
      await sleep(0);

      expect(asked).toEqual([
        [1, ['connectionHandle', 'header']],
        [3, ['connectionHandle', 'header']],
        [5, ['connectionHandle', 'header']],
        [7, ['connectionHandle', 'header']],
      ]);
      expect(
        seen.map(({ header: { callId }, isAdmitted, payload: whole }) => {
          return [callId, isAdmitted, whole.length];
        })
      ).toEqual([
        [1, true, 0],
        [5, true, 100],
      ]);
      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 3, ProtocolCode.ACCESS_DENIED],
        ['a', 'credit', 5, 100],
        ['a', 'failure', 7, ProtocolCode.ACCESS_DENIED],
        ['a', 'failure', 9, ProtocolCode.SERVICE_UNKNOWN],
      ]);
      expect(reported).toEqual([]);
    });

    test('reports a refusal of admission that cannot be written, and leaves no call open behind it', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      let isAsked = false;

      core.registerResolver(
        Object.assign(resolverOf(echo, seen), {
          // a hand-written admission: its first refusal has no code a failure takes
          admit: () => {
            const refusal = isAsked ? undefined : { code: 0, scope: FailureScope.PROTOCOL };

            isAsked = true;

            return refusal;
          },
        })
      );
      core.receive(requestOf(1), 'a');
      await sleep(0);
      // the call closed: a request on its call id is dispatched
      core.receive(requestOf(1), 'a');

      expect(sent).toEqual([]);
      expect(
        reported.map(([error]) => {
          return error;
        })
      ).toEqual([expect.any(ProgrammerError)]);
      expect(seen).toHaveLength(1);
    });

    test('answers as failed a request whose admission throws, and reports why', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const thrown = new Error('thrown');

      core.registerResolver(
        Object.assign(resolverOf(echo, seen), {
          admit: () => {
            throw thrown;
          },
        })
      );
      core.receive(requestOf(1), 'a');
      await sleep(0);

      expect(seen).toEqual([]);
      expect(answersOf(sent)).toEqual([['a', 'failure', 1, ProtocolCode.PROCEDURE_FAILED]]);
      expect(reported).toEqual([[thrown, 'a']]);
    });

    test('refuses a request for a destination, a service or a procedure it does not know, on its call id alone', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const nextCallId = callIdsOf('client');

      core.registerResolver(resolverOf({ ...echo, procedureId: 9 }));
      core.receive(requestOf(nextCallId(), { procedure: { ...echo, serviceId: 8 } }), 'a');
      core.receive(requestOf(nextCallId()), 'a');
      core.receive(requestOf(nextCallId(), { destinationId: 4 }), 'b');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.SERVICE_UNKNOWN],
        ['a', 'failure', 3, ProtocolCode.PROCEDURE_UNKNOWN],
        ['b', 'failure', 5, ProtocolCode.DESTINATION_UNKNOWN],
      ]);
      // the answer names the call alone: no destination, no procedure
      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, kind: EnvelopeKind.FAILURE },
        { callId: 3, kind: EnvelopeKind.FAILURE },
        { callId: 5, kind: EnvelopeKind.FAILURE },
      ]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: { detail: 'no service 8', relays: 0, scope: FailureScope.PROTOCOL },
      });
    });

    test('takes a request for a destination to the handler its port gives, and answers it by that handler, never a resolver at the same address', async () => {
      const told: unknown[] = [];
      const handled: IRequestResolverProps<Handle>[] = [];
      const handler: IRequestHandler<Handle> = (props) => {
        handled.push(props);

        return Promise.resolve();
      };
      const refusing: IRequestHandler<Handle> = Object.assign(
        () => {
          return Promise.reject(new Error('never called'));
        },
        {
          admit: () => {
            return SERVER_FAILURES.accessDenied;
          },
        }
      );
      const { port, sent } = createPort({
        beforeAnswer: ({ resolver }) => {
          told.push(resolver);

          return undefined;
        },
        handlerOfDestination: (destinationId) => {
          return destinationId === 5 ? handler : destinationId === 7 ? refusing : undefined;
        },
      });
      using core = createRouterCore(port);
      const local: IRequestResolverProps<Handle>[] = [];

      // a resolver of this side's at the same address, whose limit is 8 bytes
      core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes: 8 }, local));
      core.receive(requestOf(1, { destinationId: 5, payload: patternOf(4) }), 'a');
      core.receive(requestOf(3, { destinationId: 6 }), 'a');
      core.receive(requestOf(5, { destinationId: 7 }), 'a');
      core.receive(requestOf(7, { destinationId: 5 }), 'a');
      await sleep(0);

      expect(
        handled.map(({ header, payload }) => {
          return [header.destinationId, [...payload]];
        })
      ).toEqual([
        [5, [...patternOf(4)]],
        [5, []],
      ]);
      expect(local).toEqual([]);

      await core.respond(
        { payload: patternOf(64) },
        { connectionHandle: 'a', header: handled[0]?.header ?? headerOf(1) }
      );
      // a copy of its header, which names a destination, finds the handler no more, nor a resolver
      await core.respond(
        { payload: patternOf(64) },
        { connectionHandle: 'a', header: { ...(handled[1]?.header ?? headerOf(7)) } }
      );

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 3, ProtocolCode.DESTINATION_UNKNOWN],
        ['a', 'failure', 5, ProtocolCode.ACCESS_DENIED],
        ['a', 'result', 1, [...patternOf(64)]],
        ['a', 'result', 7, [...patternOf(64)]],
      ]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: { detail: 'this peer relays nothing, to 6 or elsewhere' },
      });
      // a request for a destination is written by the handler it was routed to, never by a resolver
      // of this side's; one routed to none, by none
      expect(told).toEqual([undefined, refusing, handler, undefined]);
    });

    test('refuses a request that opens a subscription on a connection that carries one way, once admitted, and asks nothing of another', async () => {
      const asked: string[] = [];
      const { port, sent } = createPort({
        isTwoWay: (connectionHandle) => {
          asked.push(connectionHandle);

          return connectionHandle !== 'a';
        },
      });
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const guarded = { ...echo, procedureId: 2, procedureName: 'guarded' };

      core.registerResolver(resolverOf(echo, seen));
      // admitted by nobody: its refusal comes first, and nothing is asked of the connection
      core.registerResolver(
        Object.assign(resolverOf(guarded, seen), {
          admit: () => {
            return SERVER_FAILURES.accessDenied;
          },
        })
      );
      core.receive(requestOf(1, { opensSubscription: true }), 'a');
      core.receive(requestOf(3, { opensSubscription: true, procedure: guarded }), 'a');
      core.receive(requestOf(5), 'a');
      core.receive(requestOf(7, { opensSubscription: true }), 'b');
      // a transfer's opening too, before any credit
      core.receive(
        requestOf(9, { opensSubscription: true, payload: new Uint8Array(4), total: 400 }),
        'a'
      );
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.SUBSCRIPTION_UNSUPPORTED],
        ['a', 'failure', 3, ProtocolCode.ACCESS_DENIED],
        ['a', 'failure', 9, ProtocolCode.SUBSCRIPTION_UNSUPPORTED],
      ]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: { detail: 'this connection carries no notification back' },
      });
      expect(
        seen.map(({ header }) => {
          return header.callId;
        })
      ).toEqual([5, 7]);
      expect(asked).toEqual(['a', 'b', 'a']);
    });

    test('answers a request of a layout to come with the layouts it reads, under one rule', async () => {
      const { port, reported, sent } = createPort({
        isCallIdInUse: (callId) => {
          return callId === 9;
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(() => {
          return new Promise<void>(() => {
            return undefined;
          });
        }, echo)
      );
      // call 7 open, and waiting on its resolver
      core.receive(requestOf(7), 'a');

      for (const layout of ['A2', 'AF']) {
        // a free call id of the peer's parity: answered
        core.receive(fromHexadecimal(`${layout} 10 00 03  00 00 00 03  00 02 00 01`), 'a');
        // this side's parity, an open call, a call the side holds, a result, 7 bytes: reported
        core.receive(fromHexadecimal(`${layout} 10 00 03  00 00 00 04  00 02 00 01`), 'a');
        core.receive(fromHexadecimal(`${layout} 10 00 03  00 00 00 07  00 02 00 01`), 'a');
        core.receive(fromHexadecimal(`${layout} 10 00 03  00 00 00 09  00 02 00 01`), 'a');
        core.receive(fromHexadecimal(`${layout} 11 00 02  00 00 00 0B`), 'a');
        core.receive(fromHexadecimal(`${layout} 10 00 03  00 00 00`), 'a');
      }

      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 3, ProtocolCode.LAYOUT_UNSUPPORTED],
        ['a', 'failure', 3, ProtocolCode.LAYOUT_UNSUPPORTED],
      ]);
      expect(sent[0]?.envelope).toMatchObject({ failure: { detail: '0xA1' } });
      // for each layout: this side's parity, an open call, a call held, a result, then 7 bytes
      const perLayout = [
        ProtocolCode.LAYOUT_UNSUPPORTED,
        ProtocolCode.LAYOUT_UNSUPPORTED,
        ProtocolCode.LAYOUT_UNSUPPORTED,
        ProtocolCode.LAYOUT_UNSUPPORTED,
        ProtocolCode.ENVELOPE_MALFORMED,
      ];

      expect(codesOf(reported)).toEqual(
        [...perLayout, ...perLayout].map((code) => {
          return [code, 'a'];
        })
      );
    });

    test('answers under the same rule on a client’s core, whose peer opens even call ids', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore({ ...port, failures: CLIENT_FAILURES });

      core.receive(fromHexadecimal('A2 10 00 03  00 00 00 04  00 02 00 01'), 'a');
      core.receive(fromHexadecimal('A2 10 00 03  00 00 00 03  00 02 00 01'), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 4, ProtocolCode.LAYOUT_UNSUPPORTED]]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.LAYOUT_UNSUPPORTED, 'a']]);
      expect(reported[0]?.[0]).toMatchObject({ side: 'client' });
    });

    test('lets go of the call id of a refusal that cannot go out, so the call id may be refused again', async () => {
      const { control, port, reported } = createPort();
      using core = createRouterCore(port);

      control.sessionTokenOf = () => {
        throw new Error('no session');
      };
      core.receive(requestOf(5, { procedure: { ...echo, serviceId: 8 } }), 'a');
      await sleep(0);
      core.receive(requestOf(5, { procedure: { ...echo, serviceId: 8 } }), 'a');
      await sleep(0);

      expect(codesOf(reported)).toEqual([
        ['no session', 'a'],
        ['no session', 'a'],
      ]);
    });

    test('reports a refusal of the gate that cannot go out', async () => {
      const { control, port, reported } = createPort();
      using core = createRouterCore(port);

      control.sendErrors.set('a', new Error('gone'));
      core.receive(fromHexadecimal('A2 10 00 03  00 00 00 03  00 02 00 01'), 'a');
      await sleep(0);

      expect(codesOf(reported)).toEqual([['gone', 'a']]);
    });

    test('never answers what is not an envelope, and answers a request of this layout that does not read', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);

      core.receive(fromHexadecimal('0A 10 00 03  00 00 00 03  00 02 00 01'), 'a');
      core.receive(fromHexadecimal('00 10 00 03  00 00 00 03  00 02 00 01'), 'a');
      // a reserved bit
      core.receive(fromHexadecimal('A1 10 08 03  00 00 00 05  00 02 00 01'), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 5, ProtocolCode.ENVELOPE_MALFORMED]]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
    });

    test('settles a call with an answer of this layout that does not read, and never with one of another', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const first = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });
      const second = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options: { timeout: 50 },
        procedure: echo,
      });
      const tooLarge = new Uint8Array(16_778_241);

      tooLarge.set(fromHexadecimal('A2 11 00 02  00 00 00 04'));

      // a result of a layout to come, even too large, names no call this side can trust
      core.receive(tooLarge, 'a');
      core.receive(fromHexadecimal('A2 11 00 02  00 00 00 04'), 'a');
      core.receive(fromHexadecimal('A2 12 00 02  00 00 00 04  00 13 00 00'), 'a');
      // one on a connection that waits on nothing
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 02  00 13 00'), 'b');
      // a failure whose record is 3 bytes
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 02  00 13 00'), 'a');

      await expect(first).rejects.toMatchObject({
        code: ProtocolCode.ENVELOPE_MALFORMED,
        origin: 'local',
        procedureAddress: { procedureId: echo.procedureId, serviceId: echo.serviceId },
        side: 'server',
      });
      await expect(second).rejects.toBeInstanceOf(TimeoutError);
      // the peer, which may hold either call still, is told of each
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.REQUEST, 4],
        ['a', EnvelopeKind.CANCEL, 2],
        ['a', EnvelopeKind.CANCEL, 4],
      ]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_TOO_LARGE, 'a'],
        [ProtocolCode.LAYOUT_UNSUPPORTED, 'a'],
        [ProtocolCode.LAYOUT_UNSUPPORTED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'b'],
      ]);
    });

    test('reports a request of its own parity or on a call open, and answers the open one once', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const answering = Promise.withResolvers<void>();
      let calls = 0;

      core.registerResolver(
        Object.assign(async (props: IRequestResolverProps<Handle>) => {
          calls += 1;
          await answering.promise;
          await core.respond({ payload: Uint8Array.of(calls) }, props);
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      core.receive(requestOf(5), 'a');
      core.receive(requestOf(4), 'a');
      // the same call id on another connection is another call
      core.receive(requestOf(5), 'b');
      answering.resolve();
      await sleep(0);

      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
      expect(answersOf(sent)).toEqual([
        ['a', 'result', 5, [2]],
        ['b', 'result', 5, [2]],
      ]);
      expect(calls).toBe(2);

      // answered, the call id is the peer's again
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(calls).toBe(3);
    });

    test('lets go of the call id of a resolver that fails without answering, and of that one alone', async () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);
      const seen: number[] = [];
      const failing = Promise.withResolvers<void>();

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          seen.push(props.header.callId);

          return seen.length === 1 ? failing.promise : Promise.resolve();
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      failing.reject(new Error('rejected'));
      await sleep(0);
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(seen).toEqual([5, 5]);
      expect(codesOf(reported)).toEqual([['rejected', 'a']]);
    });

    test('send nothing for an answer whose call its connection took away, though the peer opens its call id again', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: number[] = [];
      const answers = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];

      core.registerResolver(
        Object.assign(async (props: IRequestResolverProps<Handle>) => {
          const index = seen.push(props.header.callId) - 1;

          await answers[index]?.promise;
          await core.respond({ payload: new Uint8Array([index]) }, props);
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      // the connection is replaced, and the peer opens call 5 again before the first one answers
      core.rejectPending('a replaced', 'a');
      core.receive(requestOf(5), 'a');
      answers[0]?.resolve();
      await sleep(0);
      // still open, for the call that holds it now
      core.receive(requestOf(5), 'a');
      answers[1]?.resolve();
      await sleep(0);

      expect(seen).toEqual([5, 5]);
      expect(answersOf(sent)).toEqual([['a', 'result', 5, [1]]]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
    });

    test('lets a resolver that fails after it answered take nothing from the call holding its call id now', async () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);
      const seen: number[] = [];
      const failing = Promise.withResolvers<void>();
      const holding = Promise.withResolvers<void>();

      core.registerResolver(
        Object.assign(async (props: IRequestResolverProps<Handle>) => {
          seen.push(props.header.callId);

          if (seen.length === 1) {
            await core.respond({ payload: new Uint8Array(0) }, props);
            await failing.promise;
          } else {
            await holding.promise;
          }
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      await sleep(0);
      // answered, so the peer opens call 5 again; then the first resolver fails
      core.receive(requestOf(5), 'a');
      failing.reject(new Error('late'));
      await sleep(0);
      // still open, for the call that holds it
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(seen).toEqual([5, 5]);
      expect(codesOf(reported)).toEqual([
        ['late', 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
    });

    test('reports the kinds to come, and skips the advisory ones in silence', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);

      for (const kind of ['17', '7F', '80', 'FF']) {
        core.receive(fromHexadecimal(`A1 ${kind} 00 02  00 00 00 03`), 'a');
      }

      await sleep(0);

      expect(sent).toEqual([]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.KIND_UNSUPPORTED, 'a'],
        [ProtocolCode.KIND_UNSUPPORTED, 'a'],
      ]);
    });

    test('routes a request that opens a transfer, then refuses it before its resolver', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const transfer = '00 00 00 00 02 80 00 00';

      core.registerResolver(resolverOf(echo, seen));
      core.receive(fromHexadecimal(`A1 10 04 05  00 00 00 01  00 08 00 01  ${transfer}`), 'a');
      core.receive(
        fromHexadecimal(`A1 10 06 06  00 00 00 03  00 02 00 01  00 00 00 04  ${transfer}`),
        'a'
      );
      core.receive(fromHexadecimal(`A1 10 04 05  00 00 00 05  00 02 00 01  ${transfer}  01`), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.SERVICE_UNKNOWN],
        ['a', 'failure', 3, ProtocolCode.DESTINATION_UNKNOWN],
        ['a', 'failure', 5, ProtocolCode.PAYLOAD_TOO_LARGE],
      ]);
      expect(seen).toEqual([]);
    });

    test('answers an envelope larger than it reads, on its call id', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const large = new Uint8Array(16_778_241);

      large.set(fromHexadecimal('A1 10 00 03  00 00 00 03  00 02 00 01'));
      core.receive(large, 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 3, ProtocolCode.ENVELOPE_TOO_LARGE]]);
    });

    test('hands a notification to the side that takes them, and reports it where none does', () => {
      const taken: [INotificationHeader, Handle, Uint8Array][] = [];
      const taking = createPort({
        onNotification: (header, { connectionHandle, payload }) => {
          taken.push([header, connectionHandle, payload]);
        },
      });
      const refusing = createPort();
      using core = createRouterCore(taking.port);
      using other = createRouterCore(refusing.port);
      const notification = envelopeOf({
        header: { callId: 41, kind: EnvelopeKind.NOTIFICATION },
        kind: EnvelopeKind.NOTIFICATION,
        payload: Uint8Array.of(1),
      });

      core.receive(notification, 'b');
      other.receive(notification, 'b');

      expect(taken).toEqual([
        [{ callId: 41, kind: EnvelopeKind.NOTIFICATION }, 'b', Uint8Array.of(1)],
      ]);
      expect(codesOf(refusing.reported)).toEqual([[ProtocolCode.KIND_UNSUPPORTED, 'b']]);
      expect(refusing.sent).toEqual([]);
    });

    test('hands a credit of notifications to the side that paces them, a transfer’s to its transfer, and reports it where none does', () => {
      const credited: [ICreditHeader, Handle][] = [];
      const pacing = createPort({
        onSubscriptionCredit: (header, connectionHandle) => {
          credited.push([header, connectionHandle]);
        },
      });
      const refusing = createPort();
      using core = createRouterCore(pacing.port);
      using other = createRouterCore(refusing.port);
      const credit = envelopeOf({
        header: { callId: 41, creditEnd: 3, kind: EnvelopeKind.CREDIT, paced: true },
        kind: EnvelopeKind.CREDIT,
      });

      core.receive(credit, 'b');
      // a transfer's, on the same call id, sends no transfer and reaches no pacing
      core.receive(creditOf(41, 5), 'b');
      other.receive(credit, 'b');

      expect(credited).toEqual([
        [{ callId: 41, creditEnd: 3, kind: EnvelopeKind.CREDIT, paced: true }, 'b'],
      ]);
      expect(pacing.reported).toEqual([]);
      expect(pacing.sent).toEqual([]);
      expect(codesOf(refusing.reported)).toEqual([[ProtocolCode.KIND_UNSUPPORTED, 'b']]);
      expect(refusing.reported[0]?.[0].message).toContain('this side sends no notification');
      expect(refusing.sent).toEqual([]);
    });

    test('reports a resolver that throws or rejects, with its connection', async () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(() => {
          throw new Error('thrown');
        }, echo)
      );
      core.registerResolver(
        Object.assign(
          () => {
            return Promise.reject(new Error('rejected'));
          },
          { ...echo, procedureId: 2 }
        )
      );

      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3, { procedure: { ...echo, procedureId: 2 } }), 'b');
      await sleep(0);

      expect(codesOf(reported)).toEqual([
        ['thrown', 'a'],
        ['rejected', 'b'],
      ]);
    });

    test('refuses a second resolver for one procedure, and an address outside 1 to 65535', () => {
      using core = createRouterCore(createPort().port);

      core.registerResolver(resolverOf(echo));

      expect(() => {
        core.registerResolver(resolverOf({ ...echo, procedureName: 'again' }));
      }).toThrow(ProgrammerError);

      for (const address of [
        { procedureId: 0, serviceId: 2 },
        { procedureId: 1, serviceId: 0 },
        { procedureId: 0x10000, serviceId: 2 },
        { procedureId: 1, serviceId: 1.5 },
      ]) {
        expect(() => {
          core.registerResolver(resolverOf({ ...echo, ...address }));
        }, JSON.stringify(address)).toThrow(ProgrammerError);
      }

      core.registerResolver(resolverOf({ ...echo, procedureId: 0xffff, serviceId: 0xffff }));
    });
  });

  test.describe('its own requests', () => {
    test('go out on a call id of its side, naming their procedure, and nothing of a session', async () => {
      const { activities, control, port, sent, traced } = createPort();
      using core = createRouterCore(port);
      const told: number[] = [];

      control.sessionTokenOf = () => {
        throw new Error('never asked for a request');
      };

      const answering = core.request(Uint8Array.of(1, 2, 3), {
        connectionHandle: 'a',
        onCallId: (callId) => {
          told.push(callId, sent.length);
        },
        options,
        procedure: echo,
      });

      await sleep(0);

      expect(told).toEqual([2, 0]);
      expect(sent).toEqual([
        {
          connectionHandle: 'a',
          envelope: {
            header: headerOf(2),
            kind: EnvelopeKind.REQUEST,
            payload: Uint8Array.of(1, 2, 3),
          },
        },
      ]);
      expect(traced).toEqual(['tx 10 2 a']);
      expect(activities).toEqual(['request a']);

      core.receive(resultOf(2, Uint8Array.of(9)), 'a');

      expect(await answering).toEqual({
        header: { callId: 2, kind: EnvelopeKind.RESULT },
        payload: Uint8Array.of(9),
      });
      expect(activities).toEqual(['request a', 'response a']);
    });

    test('write the destination they name', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);

      void core
        .request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { ...options, destinationId: 7 },
          procedure: echo,
        })
        .catch(() => {
          return undefined;
        });
      void core
        .request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { ...options, destinationId: undefined },
          procedure: echo,
        })
        .catch(() => {
          return undefined;
        });
      await sleep(0);

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([{ ...headerOf(2), destinationId: 7 }, headerOf(4)]);
    });

    test('say whether they open a subscription, and whether it is paced', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);

      for (const flags of [
        { opensSubscription: true },
        { opensSubscription: false },
        { opensSubscription: undefined },
        { opensSubscription: true, paced: true },
        { opensSubscription: true, paced: false },
      ]) {
        void core
          .request(new Uint8Array(0), {
            ...flags,
            connectionHandle: 'a',
            options,
            procedure: echo,
          })
          .catch(() => {
            return undefined;
          });
      }

      await sleep(0);

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { ...headerOf(2), opensSubscription: true },
        headerOf(4),
        headerOf(6),
        { ...headerOf(8), opensSubscription: true, paced: true },
        { ...headerOf(10), opensSubscription: true },
      ]);
    });

    test('pair by call id alone, on their own connection, once', async () => {
      const seenResponses: number[] = [];
      const { activities, port, reported } = createPort({
        onAnswerReceived: (header, connectionHandle) => {
          seenResponses.push(header.callId);
          expect(connectionHandle).toMatch(/^[ab]$/);
        },
      });
      using core = createRouterCore(port);
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options: { ...options, destinationId: 3 },
        procedure: echo,
      });

      await sleep(0);
      core.receive(resultOf(2), 'b');
      core.receive(resultOf(2, Uint8Array.of(9)), 'a');
      // the same response again, in the same read, before anything waiting on the first has run
      core.receive(resultOf(2), 'a');

      expect((await answering).payload).toEqual(Uint8Array.of(9));
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.CALL_UNKNOWN, 'b'],
        [ProtocolCode.CALL_UNKNOWN, 'a'],
      ]);
      expect(activities).toEqual(['request a', 'response a']);
      // the side hears of every response, paired or not
      expect(seenResponses).toEqual([2, 2, 2]);
    });

    test('offer the side a failure that answers no call waiting, and never a result', () => {
      const offered: number[] = [];
      let takes = true;
      const { port, reported } = createPort({
        onUnpairedFailure: ({ failure, header }, connectionHandle) => {
          offered.push(header.callId, failure.code);
          expect(connectionHandle).toBe('a');

          return takes;
        },
      });
      using core = createRouterCore(port);
      const failureOn = (callId: number) => {
        return fromHexadecimal(
          `A1 12 00 02  00 00 00 ${callId.toString(16).padStart(2, '0')}  00 20 00 00`
        );
      };

      core.receive(failureOn(3), 'a');
      takes = false;
      core.receive(failureOn(5), 'a');
      core.receive(resultOf(7), 'a');

      expect(offered).toEqual([3, 32, 5, 32]);

      // a side that takes none reports it
      const { port: bare, reported: bareReported } = createPort();
      using other = createRouterCore(bare);

      other.receive(failureOn(3), 'a');

      expect(codesOf(bareReported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.CALL_UNKNOWN, 'a'],
        [ProtocolCode.CALL_UNKNOWN, 'a'],
      ]);
    });

    test('reject with the failure the peer answers, as its side, or through a relay, of no side, where the call went', async () => {
      const { port } = createPort();
      using core = createRouterCore(port);
      const request = () => {
        return core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { ...options, destinationId: 4 },
          procedure: echo,
        });
      };
      const fromPeer = request();
      const relayed = request();
      const application = request();

      await sleep(0);
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 02  00 13 00 00  77 68 79'), 'a');
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 04  00 12 01 00'), 'a');
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 06  00 15 00 01'), 'a');

      await expect(fromPeer).rejects.toMatchObject({
        code: 19,
        destinationId: 4,
        detail: 'why',
        origin: 'peer',
        procedureAddress: { procedureId: 1, serviceId: 2 },
        relays: 0,
        side: 'client',
      });
      await expect(relayed).rejects.toMatchObject({
        code: 18,
        destinationId: 4,
        origin: 'relayed',
        relays: 1,
        side: undefined,
      });
      await expect(application).rejects.toMatchObject({
        code: 21,
        scope: FailureScope.APPLICATION,
      });
      await expect(application).rejects.toBeInstanceOf(FailureError);
    });

    test('reject a result whose transfer is past the payload’s limit, here, and cancel its call', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.receive(fromHexadecimal('A1 11 04 04  00 00 00 02  00 00 00 00 01 00 00 01'), 'a');

      await expect(answering).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 16777216 bytes at most, not 16777217',
        origin: 'local',
        side: 'server',
      });
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);
    });

    test('time out, and reject — never throw — what their payload or the transport fails with', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);

      await expect(
        core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { timeout: 10 },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(TimeoutError);

      control.sendErrors.set('b', new Error('gone'));

      await expect(
        core.request(new Uint8Array(0), { connectionHandle: 'b', options, procedure: echo })
      ).rejects.toThrow('gone');

      sent.length = 0;

      await expect(
        core.request(new Uint8Array(0x1000001), { connectionHandle: 'a', options, procedure: echo })
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE, origin: 'local' });
      expect(sent).toEqual([]);

      void core
        .request(new Uint8Array(0x1000000), { connectionHandle: 'a', options, procedure: echo })
        .catch(() => {
          return undefined;
        });
      await sleep(0);

      // at its limit, it goes: its opening first, which waits for its credit
      expect(
        sent.map(({ envelope }) => {
          return [envelope?.kind, envelope?.kind === EnvelopeKind.REQUEST && envelope.header.total];
        })
      ).toEqual([[EnvelopeKind.REQUEST, 0x1000000]]);
    });

    test('draw their call ids round their range, skip the ones held, and fail once every one is', async () => {
      const held = new Set<number>([4]);
      const { port } = createPort({
        isCallIdInUse: (callId) => {
          return held.has(callId);
        },
      });
      const core = createRouterCore(port, { lastCallId: 8 });
      const drawn: number[] = [];
      const request = () => {
        return core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          onCallId: (callId) => {
            drawn.push(callId);
          },
          options,
          procedure: echo,
        });
      };

      const two = request();
      const six = request();

      core.receive(resultOf(2), 'a');
      await two;

      const eight = request();
      const twoAgain = request();

      // 2 answered is free again; 4 held, 6, 8 and 2 waiting: none left
      await expect(request()).rejects.toMatchObject({
        code: ProtocolCode.CAPACITY_EXCEEDED,
        side: 'server',
      });
      expect(drawn).toEqual([2, 6, 8, 2]);

      core[Symbol.dispose]();
      await Promise.allSettled([six, eight, twoAgain]);

      // each side draws its own parity by default, and a last of the other is a programmer error
      using client = createRouterCore({ ...port, failures: CLIENT_FAILURES });
      const first = client.request(new Uint8Array(0), {
        connectionHandle: 'a',
        onCallId: (callId) => {
          drawn.push(callId);
        },
        options: { timeout: 1 },
        procedure: echo,
      });

      await expect(first).rejects.toBeInstanceOf(TimeoutError);
      expect(drawn.at(-1)).toBe(1);
      expect(() => {
        return createRouterCore(port, { lastCallId: 7 });
      }).toThrow(ProgrammerError);
      expect(() => {
        return createRouterCore({ ...port, failures: CLIENT_FAILURES }, { lastCallId: 8 });
      }).toThrow(ProgrammerError);
    });

    test('are cancelled by their signal: at once, drawing nothing, or once sent, telling the peer', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const controller = new AbortController();
      const drawn: number[] = [];
      const cancelled = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        onCallId: (callId) => {
          drawn.push(callId);
        },
        options: { ...options, signal: controller.signal },
        procedure: echo,
      });

      await sleep(0);
      controller.abort(new Error('not needed'));

      await expect(cancelled).rejects.toBeInstanceOf(CancelError);
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);

      // the answer that comes after, on a call id reserved, says nothing
      core.receive(resultOf(2), 'a');

      expect(reported).toEqual([]);

      sent.length = 0;

      await expect(
        core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          onCallId: (callId) => {
            drawn.push(callId);
          },
          options: { ...options, signal: controller.signal },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(CancelError);
      expect(sent).toEqual([]);
      expect(drawn).toEqual([2]);
    });

    test('are rejected with a DisconnectError, those of one connection or all', async () => {
      const { port } = createPort();
      using core = createRouterCore(port);
      const request = (connectionHandle: Handle) => {
        return core.request(new Uint8Array(0), { connectionHandle, options, procedure: echo });
      };
      const fromA = request('a');
      const fromB = request('b');
      const fromBAgain = request('b');

      core.rejectPending('a closed', 'a');

      await expect(fromA).rejects.toThrow(new DisconnectError('a closed'));

      core.receive(resultOf(4), 'b');

      await expect(fromB).resolves.toBeDefined();

      core.rejectPending('all gone');

      await expect(fromBAgain).rejects.toThrow(new DisconnectError('all gone'));
    });
  });

  test.describe('its gauges', () => {
    test('count what its pieces hold, together, and nothing once its connections went', async () => {
      const { port } = createPort();
      using core = createRouterCore(port);
      const waiting = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      // a request the resolver has not answered yet
      core.registerResolver(resolverOf(echo));
      core.receive(requestOf(3), 'b');

      expect(core.gauges()).toMatchObject({
        anomalies: [],
        ceilings: { bufferedBytes: LIMIT_DEFAULTS.bufferedBytesBudget },
        connectionHandles: new Set(['a', 'b']),
        counts: {
          abandonedCalls: 0,
          announced: 0,
          answeringCalls: 1,
          bufferedBytes: 0,
          pendingCalls: 1,
          receivingTransfers: 0,
          reservedCallIds: 0,
          sendingTransfers: 0,
        },
      });

      core.rejectPending('all gone');
      await waiting.catch(() => {});

      expect(core.gauges().connectionHandles).toEqual(new Set());
    });
  });

  test.describe('its answers', () => {
    test('name their call alone: a result with its payload, a failure with its record', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);

      await core.respond(
        { payload: Uint8Array.of(4) },
        { connectionHandle: 'b', header: headerOf(77) }
      );
      await core.respond(
        { failure: { code: 12, detail: 'why', scope: FailureScope.APPLICATION } },
        { connectionHandle: 'a', header: { ...headerOf(77), destinationId: 3 } }
      );

      expect(sent).toEqual([
        {
          connectionHandle: 'b',
          envelope: {
            header: { callId: 77, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: Uint8Array.of(4),
          },
        },
        {
          connectionHandle: 'a',
          envelope: {
            failure: { code: 12, detail: 'why', relays: 0, scope: FailureScope.APPLICATION },
            header: { callId: 77, kind: EnvelopeKind.FAILURE },
            kind: EnvelopeKind.FAILURE,
          },
        },
      ]);
    });

    test('refuse a failure whose code is not one, sending nothing and telling nothing', async () => {
      const answered: number[] = [];
      const { port, sent } = createPort({
        beforeAnswer: () => {
          answered.push(1);

          return undefined;
        },
      });
      using core = createRouterCore(port);

      for (const code of [0, 0x10000, 1.5, -1]) {
        await expect(
          core.respond(
            { failure: { code, scope: FailureScope.APPLICATION } },
            { connectionHandle: 'a', header: headerOf(1) }
          )
        ).rejects.toBeInstanceOf(ProgrammerError);
      }

      expect(sent).toEqual([]);
      expect(answered).toEqual([]);
    });

    test('hear their request handed to the transport — whole, or its transfer’s opening — then refused by it, and none it never had', async () => {
      const heard: string[] = [];
      const { control, port } = createPort();
      using core = createRouterCore(
        {
          ...port,
          // a transport that throws as it is handed a request for 'b'
          send: (bytes, connectionHandle) => {
            if (connectionHandle === 'b') {
              throw new Error('the transport is closing');
            }

            return port.send(bytes, connectionHandle);
          },
        },
        { limits }
      );

      // one that rejects what it is handed for 'a', later on
      control.sendErrors.set('a', new Error('the socket is closed'));
      const ask = (payload: Uint8Array, connectionHandle: Handle) => {
        return core
          .request(payload, {
            connectionHandle,
            onSent: (isHanded) => {
              heard.push(`${String(payload.length)} ${connectionHandle} ${String(isHanded)}`);
            },
            options,
            procedure: echo,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };
      const refused = [ask(patternOf(8), 'a'), ask(patternOf(200), 'a')];

      // heard as it is handed over, before its send settles
      expect(heard).toEqual(['8 a true', '200 a true']);
      expect(await Promise.all(refused)).toEqual([
        expect.objectContaining({ message: 'the socket is closed' }),
        expect.objectContaining({ message: 'the socket is closed' }),
      ]);
      expect(heard).toEqual(['8 a true', '200 a true', '8 a false', '200 a false']);

      control.sendErrors.clear();
      heard.length = 0;

      const asking = [
        ask(patternOf(8), 'a'),
        ask(patternOf(200), 'a'),
        ask(patternOf(2_000), 'a'),
        ask(patternOf(8), 'b'),
      ];

      expect(heard).toEqual(['8 a true', '200 a true']);
      // the transport's refusals settle before the router goes
      await sleep(0);
      core[Symbol.dispose]();

      expect(await Promise.all(asking)).toEqual([
        expect.any(DisconnectError),
        expect.any(DisconnectError),
        expect.objectContaining({ code: ProtocolCode.PAYLOAD_TOO_LARGE }),
        expect.objectContaining({ message: 'the transport is closing' }),
      ]);
      // one the transport took is not taken back by its call's end
      expect(heard).toEqual(['8 a true', '200 a true']);
      expect(core.limits).toMatchObject({ ...limits, maximumTransfers: 4 });
    });

    test('tell the side of each answer before it goes out, and undo it when it does not go out', async () => {
      const told: string[] = [];
      const { control, port, sent } = createPort({
        beforeAnswer: ({ connectionHandle, isFailure, resolver }) => {
          told.push(
            `${isFailure ? 'failure' : 'result'} ${connectionHandle} ${resolver !== undefined && 'procedureName' in resolver ? String(resolver.procedureName) : 'undefined'} after ${String(sent.length)} sent`
          );

          return () => {
            told.push(`undo ${connectionHandle}`);
          };
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(resolverOf(echo));
      control.sendErrors.set('b', new Error('gone'));

      await core.respond(
        { payload: Uint8Array.of(1) },
        { connectionHandle: 'a', header: headerOf(1) }
      );
      await core.respond(
        { failure: SERVER_FAILURES.accessDenied },
        { connectionHandle: 'a', header: headerOf(3) }
      );
      await expect(
        core.respond({ payload: Uint8Array.of(1) }, { connectionHandle: 'b', header: headerOf(5) })
      ).rejects.toThrow('gone');
      // past its limit, a result is refused before the side hears of it
      await expect(
        core.respond(
          { payload: new Uint8Array(0x1000001) },
          { connectionHandle: 'a', header: headerOf(7) }
        )
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });

      expect(told).toEqual([
        'result a echo after 0 sent',
        'failure a echo after 1 sent',
        'result b echo after 2 sent',
        'undo b',
      ]);
    });

    test('keep a call open when its answer cannot go out, so a fallback answers it', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      let answering: Promise<void> | undefined;

      const retrying = Promise.withResolvers<void>();

      core.registerResolver(
        Object.assign(async (props: IRequestResolverProps<Handle>) => {
          await core.respond({ payload: new Uint8Array(0x1000001) }, props).catch(async () => {
            await retrying.promise;
            answering = core.respond({ failure: SERVER_FAILURES.procedureFailed }, props);
          });
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      await sleep(0);
      // its answer did not go out: the call is open still, and the same call id is refused
      core.receive(requestOf(5), 'a');
      retrying.resolve();
      await sleep(0);
      await answering;
      // answered at last: a request on the same call id is dispatched
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED],
      ]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
    });

    test('announce the session when it changes, and only then', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      const tokens: (SessionToken | undefined)[] = [
        TOKEN,
        TOKEN,
        OTHER_TOKEN,
        undefined,
        undefined,
      ];

      for (const [index, token] of tokens.entries()) {
        control.sessionTokenOf = () => {
          return token;
        };
        await core.respond(
          index % 2 === 0
            ? { payload: new Uint8Array(0) }
            : { failure: SERVER_FAILURES.accessDenied },
          { connectionHandle: 'a', header: headerOf(index * 2 + 1) }
        );
      }

      // another connection, with no session yet, is told nothing
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'b', header: headerOf(1) }
      );

      expect(
        sent.map(({ envelope }) => {
          const header = envelope?.header as { sessionToken?: unknown } | undefined;

          return header !== undefined && 'sessionToken' in header ? header.sessionToken : 'none';
        })
      ).toEqual([TOKEN, 'none', OTHER_TOKEN, null, 'none', 'none']);
    });

    test('announce again what an answer that did not go out announced', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);

      control.sessionTokenOf = () => {
        return TOKEN;
      };
      control.sendErrors.set('a', new Error('gone'));

      await expect(
        core.respond({ payload: new Uint8Array(0) }, { connectionHandle: 'a', header: headerOf(1) })
      ).rejects.toThrow('gone');

      control.sendErrors.clear();
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
        { callId: 3, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
      ]);
    });

    test('keep the announcement in the order answers were written, whatever order they settle in', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      let token: SessionToken | undefined = TOKEN;

      control.sessionTokenOf = () => {
        return token;
      };
      control.held = [];

      const first = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      token = OTHER_TOKEN;

      const second = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );
      const [firstSend, secondSend] = control.held;

      // the second settles first, then the first fails: what the second wrote stands
      secondSend?.resolve();
      await second;
      firstSend?.reject(new Error('gone'));
      await expect(first).rejects.toThrow('gone');

      control.held = undefined;
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(5) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
        { callId: 3, kind: EnvelopeKind.RESULT, sessionToken: OTHER_TOKEN },
        { callId: 5, kind: EnvelopeKind.RESULT },
      ]);
    });

    test('forget the announcement with the connection, even with an answer in flight', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);

      control.sessionTokenOf = () => {
        return TOKEN;
      };
      control.held = [];

      const inFlight = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      core.rejectPending('a closed', 'a');
      // it goes out after all, and undoes nothing
      control.held[0]?.resolve();
      await inFlight;

      // a connection of the same handle is told anew
      control.held = undefined;
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
        { callId: 3, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
      ]);
    });

    test('fail the answer whose session cannot be told, and announce nothing without a way to', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      const sessionless = new Error('no session');

      control.sessionTokenOf = () => {
        throw sessionless;
      };

      await expect(
        core.respond({ payload: new Uint8Array(0) }, { connectionHandle: 'a', header: headerOf(1) })
      ).rejects.toBe(sessionless);
      expect(sent).toEqual([]);

      const { sessionTokenOf: _, ...withoutSessions } = port;
      using bare = createRouterCore(withoutSessions);

      await bare.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([{ callId: 1, kind: EnvelopeKind.RESULT }]);
    });

    test('trace what goes out and what comes in without its session token', async () => {
      const headers: unknown[] = [];
      const { control, port } = createPort({
        trace: (direction, { header }) => {
          headers.push([direction, header]);
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(resolverOf(echo));
      control.sessionTokenOf = () => {
        return TOKEN;
      };
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );
      core.receive(
        envelopeOf({
          header: { ...headerOf(3), sessionToken: TOKEN },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        } satisfies OutgoingEnvelope),
        'a'
      );

      expect(headers).toEqual([
        ['tx', { callId: 1, hasSessionToken: true, kind: EnvelopeKind.RESULT }],
        ['rx', { ...headerOf(3), hasSessionToken: true }],
      ]);
      expect(JSON.stringify(headers)).not.toContain(TOKEN);
    });
  });

  test.describe('cancels', () => {
    test('forget a call its requester cancels, then abort its signal: nothing answers it, and its call id is free', async () => {
      const offered: string[] = [];
      const { port, reported, sent } = createPort({
        onCancel: (callId, connectionHandle) => {
          offered.push(`${String(callId)} ${connectionHandle}`);
        },
      });
      using core = createRouterCore(port);
      const seen: number[] = [];
      const reasons: unknown[] = [];

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          seen.push(props.header.callId);

          return new Promise<void>((_resolve, reject) => {
            props.signal.addEventListener('abort', () => {
              reasons.push(props.signal.reason);

              // an answer from what hears the signal finds no call to answer
              if (props.signal.reason instanceof CancelError) {
                void core.respond({ payload: Uint8Array.of(1) }, props);
              }

              reject(new Error('stopped'));
            });
          });
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      core.receive(cancelOf(5), 'a');
      await sleep(0);
      // free again: a request on it is dispatched
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(seen).toEqual([5, 5]);
      expect(reasons).toEqual([expect.any(CancelError)]);
      expect(offered).toEqual(['5 a']);
      // nor is the resolver that stopped reported: its call is no one's to hear of
      expect(sent).toEqual([]);
      expect(reported).toEqual([]);
    });

    test('take a cancel of no call in silence, offered to the side, and report one of its own parity', () => {
      const offered: string[] = [];
      const { port, reported, sent } = createPort({
        onCancel: (callId, connectionHandle) => {
          offered.push(`${String(callId)} ${connectionHandle}`);
        },
      });
      using core = createRouterCore(port);

      // crossed its answer, say
      core.receive(cancelOf(7), 'a');
      // a call this side opened is not the peer's to cancel
      core.receive(cancelOf(2), 'a');

      expect(offered).toEqual(['7 a']);
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      expect(sent).toEqual([]);
    });

    test('cancel a request that times out before its caller hears of it, so a call made again goes out behind', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const call = () => {
        return core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { timeout: 20 },
          procedure: echo,
        });
      };

      await expect(
        call().catch(() => {
          return call();
        })
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.CANCEL, 2],
        ['a', EnvelopeKind.REQUEST, 4],
        ['a', EnvelopeKind.CANCEL, 4],
      ]);
    });

    test('take an answer too late in silence while its call id is reserved, then report it', async () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);

      await expect(
        core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options: { timeout: 20 },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(TimeoutError);

      core.receive(resultOf(2), 'a');

      expect(reported).toEqual([]);

      await expect
        .poll(() => {
          return core.isReserved(2, 'a');
        })
        .toBe(false);
      core.receive(resultOf(2), 'a');

      expect(codesOf(reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
    });

    test('cancel a request its signal gives up once sent, rejecting with its own reason though the cancel fails', async () => {
      const { control, port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const controller = new AbortController();
      const cancelled = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options: { ...options, signal: controller.signal },
        procedure: echo,
      });

      await sleep(0);
      control.sendErrors.set('a', new Error('gone'));
      controller.abort();

      await expect(cancelled).rejects.toBeInstanceOf(CancelError);
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);
      expect(codesOf(reported)).toEqual([['gone', 'a']]);
    });

    test('send no cancel for a call answered in the turn its signal gives it up, nor reserve its call id', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const controller = new AbortController();
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options: { ...options, signal: controller.signal },
        procedure: echo,
      });

      await sleep(0);
      controller.abort();
      core.receive(resultOf(2), 'a');

      await expect(answering).rejects.toBeInstanceOf(CancelError);

      core.receive(resultOf(2), 'a');

      expect(answersOf(sent)).toEqual([['a', EnvelopeKind.REQUEST, 2]]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
    });

    test('send no cancel for a request that never reached the transport, though given up at once', async () => {
      const { port, sent } = createPort();
      // a transport that refuses what it is given outright: nothing is handed over
      using core = createRouterCore({
        ...port,
        send: () => {
          throw new Error('refused');
        },
      });
      const controller = new AbortController();
      // given up before its refusal is heard
      const aborted = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options: { ...options, signal: controller.signal },
        procedure: echo,
      });

      controller.abort();

      await expect(aborted).rejects.toBeInstanceOf(CancelError);

      const cancelled = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      core.cancel({ callId: 4, connectionHandle: 'a' });

      await expect(cancelled).rejects.toBeInstanceOf(CancelError);
      expect(sent).toEqual([]);
      expect([core.isReserved(2, 'a'), core.isReserved(4, 'a')]).toEqual([false, false]);
    });

    test('send no cancel for a request whose send failed, whole or its transfer’s opening', async () => {
      const { control, port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });

      control.sendErrors.set('a', new Error('gone'));

      for (const length of [0, 200]) {
        await expect(
          core.request(new Uint8Array(length), { connectionHandle: 'a', options, procedure: echo })
        ).rejects.toThrow('gone');
      }

      core.receive(resultOf(2), 'a');

      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.REQUEST, 4],
      ]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
    });

    test('cancel a call still waiting once: rejected, told, and its call id reserved', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const waiting = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.cancel({ callId: 2, connectionHandle: 'a' });
      core.cancel({ callId: 2, connectionHandle: 'a' });

      await expect(waiting).rejects.toBeInstanceOf(CancelError);
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);
      expect(core.isReserved(2, 'a')).toBe(true);
      expect(core.isReserved(2, 'b')).toBe(false);
    });

    test('reserve a call id as long as its call was given, or 5 s when it was given no time, on its clock', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });

      for (const [callId, timeout] of [
        [2, 0],
        [4, 250],
        [6, Number.POSITIVE_INFINITY],
        [8, undefined],
      ] as const) {
        core.reserve({ callId, connectionHandle: 'a', timeout });
      }

      expect(
        clock.armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([5_000, 250, 5_000, 5_000]);

      clock.tick(250);

      expect([core.isReserved(2, 'a'), core.isReserved(4, 'a')]).toEqual([true, false]);
    });

    test('refuse to reserve a call id, or to cancel a call, for longer than a timer holds, before anything is done', async () => {
      const { port, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });
      const waiting = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });
      const refusal = new ProgrammerError(
        'a call id is reserved 2147483647 milliseconds at most, as a timer holds, not 2147483648'
      );

      await sleep(0);

      expect(() => {
        core.reserve({ callId: 4, connectionHandle: 'a', timeout: 2 ** 31 });
      }).toThrow(refusal);
      expect(() => {
        core.cancel({ callId: 2, connectionHandle: 'a', timeout: 2 ** 31 });
      }).toThrow(refusal);
      // the call still waits, and nothing went out but its request
      expect([core.isReserved(2, 'a'), core.isReserved(4, 'a')]).toEqual([false, false]);
      expect(answersOf(sent)).toEqual([['a', EnvelopeKind.REQUEST, 2]]);

      core.cancel({ callId: 2, connectionHandle: 'a' });

      await expect(waiting).rejects.toBeInstanceOf(CancelError);
    });

    test('reserve a call id with a timer that keeps no process alive: nothing waits on it', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });

      core.reserve({ callId: 2, connectionHandle: 'a' });

      expect(
        clock.armed.map(({ handle }) => {
          return hasRef(handle);
        })
      ).toEqual([false]);
    });

    test('keep the later end of a call id reserved twice, clearing the timer it replaces', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });

      core.reserve({ callId: 2, connectionHandle: 'a', timeout: 20 });
      core.reserve({ callId: 2, connectionHandle: 'a', timeout: 200 });
      core.reserve({ callId: 4, connectionHandle: 'a', timeout: 200 });
      core.reserve({ callId: 4, connectionHandle: 'a', timeout: 20 });

      expect(clock.armed).toHaveLength(3);
      expect(clock.cleared).toEqual([clock.armed[0]?.handle]);

      clock.tick(100);

      expect([core.isReserved(2, 'a'), core.isReserved(4, 'a')]).toEqual([true, true]);

      clock.tick(100);

      expect([core.isReserved(2, 'a'), core.isReserved(4, 'a')]).toEqual([false, false]);
    });

    test('draw no call id reserved, and none at all when every one is', async () => {
      const drawn: number[] = [];
      const cancelledOnce = async (lastCallId: number) => {
        const { port } = createPort();
        const core = createRouterCore(port, { lastCallId });
        const request = (signal?: AbortSignal) => {
          return core.request(new Uint8Array(0), {
            connectionHandle: 'a',
            onCallId: (callId) => {
              drawn.push(callId);
            },
            options: { ...options, signal },
            procedure: echo,
          });
        };
        const controller = new AbortController();
        const given = request(controller.signal);

        await sleep(0);
        controller.abort();
        await expect(given).rejects.toBeInstanceOf(CancelError);

        return { core, request };
      };

      {
        const { core, request } = await cancelledOnce(4);

        for (let answered = 0; answered < 2; answered += 1) {
          const answering = request();

          await sleep(0);
          core.receive(resultOf(4), 'a');
          await answering;
        }

        core[Symbol.dispose]();
      }

      expect(drawn).toEqual([2, 4, 4]);

      const { core, request } = await cancelledOnce(2);

      await expect(request()).rejects.toMatchObject({ code: ProtocolCode.CAPACITY_EXCEEDED });
      core[Symbol.dispose]();
    });

    test('reserve by connection, and forget the reservations of one connection or of all', () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);

      core.reserve({ callId: 2, connectionHandle: 'a' });
      core.receive(resultOf(2), 'b');
      core.reserve({ callId: 2, connectionHandle: 'b' });
      core.rejectPending('b closed', 'b');
      core.receive(resultOf(2), 'a');
      core.receive(resultOf(2), 'b');
      core.rejectPending('all closed');
      core.receive(resultOf(2), 'a');

      expect(codesOf(reported)).toEqual([
        [ProtocolCode.CALL_UNKNOWN, 'b'],
        [ProtocolCode.CALL_UNKNOWN, 'b'],
        [ProtocolCode.CALL_UNKNOWN, 'a'],
      ]);
    });

    test('take an answer of this layout that does not read, on a call id reserved, in silence', () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port);

      core.reserve({ callId: 2, connectionHandle: 'a' });
      // a failure whose record is 3 bytes
      core.receive(fromHexadecimal('A1 12 00 02  00 00 00 02  00 13 00'), 'a');
      // one of a layout to come names no call this side can trust
      core.receive(fromHexadecimal('A2 12 00 02  00 00 00 02  00 13 00 00'), 'a');

      expect(codesOf(reported)).toEqual([[ProtocolCode.LAYOUT_UNSUPPORTED, 'a']]);
    });

    test('abort the signal of each call a closing connection opened, once nothing can answer it', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const reasons: unknown[] = [];

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          return new Promise<void>((_resolve, reject) => {
            props.signal.addEventListener('abort', () => {
              reasons.push(props.signal.reason);

              // what closed may answer nothing, and a disposed router refuses to
              if (!core.isDisposed) {
                void core.respond({ payload: Uint8Array.of(1) }, props);
              }

              reject(new Error('stopped'));
            });
          });
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      core.receive(requestOf(5), 'b');
      core.rejectPending('a closed', 'a');
      await sleep(0);

      expect(reasons).toEqual([expect.any(DisconnectError)]);
      expect((reasons[0] as Error).message).toBe('a closed');
      expect(sent).toEqual([]);
      expect(reported).toEqual([]);
    });

    test('say whether the call of a request is open still', async () => {
      const { port } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          seen.push(props);

          return new Promise<void>(() => {
            // answers nothing
          });
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      core.receive(requestOf(7), 'a');
      await sleep(0);

      const [cancelled, answered] = seen;

      if (cancelled === undefined || answered === undefined) {
        throw new Error('both requests reach the resolver');
      }

      expect([core.isAnswering(cancelled), core.isAnswering(answered)]).toEqual([true, true]);

      core.receive(cancelOf(5), 'a');
      await core.respond({ payload: new Uint8Array(0) }, answered);

      expect([core.isAnswering(cancelled), core.isAnswering(answered)]).toEqual([false, false]);
      // a request never dispatched says nothing against it
      expect(core.isAnswering({ connectionHandle: 'a', header: headerOf(9) })).toBe(true);
    });
  });

  test('once disposed, rejects what waits, and sends nothing more', async () => {
    const { port, reported, sent } = createPort();
    const core = createRouterCore(port);
    const waiting = core.request(new Uint8Array(0), {
      connectionHandle: 'a',
      options,
      procedure: echo,
    });
    const answering = Promise.withResolvers<void>();
    let answered: Promise<unknown> | undefined;

    core.registerResolver(
      Object.assign(async (props: IRequestResolverProps<Handle>) => {
        await answering.promise;
        answered = core.respond({ payload: new Uint8Array(0) }, props).catch((reason: unknown) => {
          return reason;
        });
      }, echo)
    );
    core.receive(requestOf(5), 'a');
    await sleep(0);
    expect(core.isDisposed).toBe(false);

    core[Symbol.dispose]();
    sent.length = 0;

    expect(core.isDisposed).toBe(true);
    await expect(waiting).rejects.toThrow(
      new DisconnectError('the router was disposed before the answer')
    );

    // a call dispatched before, answered after
    answering.resolve();
    await sleep(0);

    expect(await answered).toBeInstanceOf(DisconnectError);

    // nor a cancel, which fails nowhere
    core.cancel({ callId: 2, connectionHandle: 'a' });
    await sleep(0);

    expect(reported).toEqual([]);
    expect(core.isReserved(2, 'a')).toBe(false);
    await expect(
      core.request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
    ).rejects.toBeInstanceOf(DisconnectError);
    await expect(
      core.respond({ payload: new Uint8Array(0) }, { connectionHandle: 'a', header: headerOf(1) })
    ).rejects.toBeInstanceOf(DisconnectError);
    await expect(
      core.send(
        {
          header: { callId: 1, kind: EnvelopeKind.NOTIFICATION },
          kind: EnvelopeKind.NOTIFICATION,
          payload: new Uint8Array(0),
        },
        'a'
      )
    ).rejects.toBeInstanceOf(DisconnectError);
    expect(sent).toEqual([]);
  });

  test.describe('its limits', () => {
    test('hold a procedure’s payloads to its own limit, within the router’s, both ways, once admitted', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const small = { ...echo, maximumPayloadBytes: 8 };
      const refusing = { ...echo, maximumPayloadBytes: 8, procedureId: 7 };
      const ask = (length: number) => {
        return core.request(new Uint8Array(length), {
          connectionHandle: 'a',
          options,
          procedure: small,
        });
      };

      core.registerResolver(resolverOf(small, seen));
      core.registerResolver(
        Object.assign(resolverOf(refusing), {
          admit: () => {
            return SERVER_FAILURES.accessDenied;
          },
        })
      );

      // sent: past the procedure's limit, nothing goes
      await expect(ask(9)).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 8 bytes at most, not 9',
      });

      // received: whole, or as a transfer on its total; admitted first
      core.receive(requestOf(1, { payload: new Uint8Array(9), procedure: small }), 'a');
      core.receive(requestOf(3, { payload: Uint8Array.of(1), procedure: small, total: 9 }), 'a');
      core.receive(requestOf(5, { payload: new Uint8Array(9), procedure: refusing }), 'a');
      core.receive(requestOf(7, { payload: new Uint8Array(8), procedure: small }), 'a');
      await sleep(0);

      // answered: past the procedure's limit, nothing goes
      await expect(
        core.respond(
          { payload: new Uint8Array(9) },
          { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(7) }
        )
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });

      // a result's transfer past the procedure's limit ends its call
      const asking = ask(8);

      await sleep(0);
      // its call id the next drawn: the call refused above drew one
      core.receive(resultOpeningOf(4, { payload: Uint8Array.of(1), total: 9 }), 'a');

      await expect(asking).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 8 bytes at most, not 9',
      });
      expect(
        seen.map(({ header: { callId } }) => {
          return callId;
        })
      ).toEqual([7]);
      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.PAYLOAD_TOO_LARGE],
        ['a', 'failure', 3, ProtocolCode.PAYLOAD_TOO_LARGE],
        ['a', 'failure', 5, ProtocolCode.ACCESS_DENIED],
        ['a', EnvelopeKind.REQUEST, 4],
        ['a', EnvelopeKind.CANCEL, 4],
      ]);
      expect(reported).toEqual([]);
    });

    test('hold a procedure whose own limit is larger to the router’s, both ways', async () => {
      const wide: IProcedure = { ...echo, maximumPayloadBytes: 1_024 };
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits: { ...limits, maximumPayloadBytes: 40 } });
      const seen: IRequestResolverProps<Handle>[] = [];

      core.registerResolver(resolverOf(wide, seen));
      // whole, within its envelope, past the router's limit
      core.receive(requestOf(1, { payload: new Uint8Array(45), procedure: wide }), 'a');

      // past an envelope: it would go as a transfer, whose envelopes each pass
      await expect(
        core.request(patternOf(200), { connectionHandle: 'a', options, procedure: wide })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 40 bytes at most, not 200',
      });
      await sleep(0);

      expect(seen).toEqual([]);
      expect(answersOf(sent)).toEqual([['a', 'failure', 1, ProtocolCode.PAYLOAD_TOO_LARGE]]);
      expect(reported).toEqual([]);
    });

    test('refuse a procedure’s limit that is not a whole number above 0, and a timeout no timer holds, drawing nothing', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const drawn: number[] = [];
      const ask = (procedure: IProcedure, timeout: number = options.timeout): Promise<unknown> => {
        return core
          .request(new Uint8Array(0), {
            connectionHandle: 'a',
            onCallId: (callId) => {
              drawn.push(callId);
            },
            options: { timeout },
            procedure,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      for (const maximumPayloadBytes of [0, 1.5, -1, Number.NaN]) {
        expect(() => {
          core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes }));
        }, String(maximumPayloadBytes)).toThrow(/echo's payload limit is a whole number above 0/);
        expect(await ask({ ...echo, maximumPayloadBytes }), String(maximumPayloadBytes)).toEqual(
          expect.objectContaining({
            message: `a payload's limit is a whole number above 0, not ${String(maximumPayloadBytes)}`,
          })
        );
      }

      expect(await ask(echo, 2 ** 31)).toBeInstanceOf(ProgrammerError);
      expect(drawn).toEqual([]);
      expect(sent).toEqual([]);

      // at their edges, they are taken: a limit of 1, the longest timeout, and none at all
      core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes: 1 }));

      for (const timeout of [2 ** 31 - 1, Number.POSITIVE_INFINITY]) {
        void ask(echo, timeout);
      }

      expect(drawn).toEqual([2, 4]);
    });

    test('take the defaults where they say nothing, and let the transfers and the detail be none', () => {
      const { port } = createPort();

      expect(() => {
        using _core = createRouterCore(port, {
          limits: { chunkBytes: undefined, maximumDetailBytes: 0, maximumTransfers: 0 },
        });
      }).not.toThrow();
    });

    test('refuse a limit that is not a whole number, or not above 0 where 0 means nothing', () => {
      const { port } = createPort();

      for (const [limits, named] of [
        [{ chunkBytes: 1_024.5 }, /^chunkBytes is a whole number above 0/],
        [{ windowBytes: 0 }, /^windowBytes is a whole number above 0/],
        [{ maximumPayloadBytes: Number.NaN }, /^maximumPayloadBytes is a whole number above 0/],
        [{ maximumTransfers: -1 }, /^maximumTransfers is a whole number, not -1/],
        [{ maximumDetailBytes: 2 ** 53 }, /^maximumDetailBytes is a whole number, not/],
      ] as const) {
        expect(() => {
          return createRouterCore(port, { limits });
        }, JSON.stringify(limits)).toThrow(named);
      }
    });

    test('refuse limits that do not hold together, each rule by its own failure', () => {
      const { port } = createPort();

      for (const [limits, rule] of [
        [{ chunkBytes: 63, maximumEnvelopeBytes: 63 }, /an envelope is 64 bytes at least/],
        [{ chunkBytes: 63 }, /a chunk's envelope is 64 bytes at least/],
        [{ chunkBytes: 2_049, maximumEnvelopeBytes: 2_048 }, /and an envelope at most/],
        [{ windowBytes: 2 * 1_048_576 - 1 }, /a window holds two chunks at least/],
        [{ maximumPayloadBytes: 268_435_457 }, /a payload fits in the budget/],
        [{ transferInactivityTimeout: 2 ** 31 }, /2147483647 milliseconds at most/],
      ] as const) {
        expect(() => {
          return createRouterCore(port, { limits });
        }, JSON.stringify(limits)).toThrow(rule);
      }

      // the edges hold
      expect(() => {
        using _core = createRouterCore(port, {
          limits: {
            chunkBytes: 64,
            maximumEnvelopeBytes: 64,
            maximumPayloadBytes: 268_435_456,
            transferInactivityTimeout: 2 ** 31 - 1,
            windowBytes: 128,
          },
        });
      }).not.toThrow();
    });

    test('refuse a payload past its own limit, and an envelope past its own', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, {
        limits: {
          chunkBytes: 64,
          maximumEnvelopeBytes: 64,
          maximumPayloadBytes: 8,
          windowBytes: 128,
        },
      });

      // a request's, and a notification's, which goes as the side sends it
      for (const sending of [
        core.request(new Uint8Array(9), { connectionHandle: 'a', options, procedure: echo }),
        core.send(
          {
            header: { callId: 2, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload: new Uint8Array(9),
          },
          'a'
        ),
      ]) {
        await expect(sending).rejects.toMatchObject({
          code: ProtocolCode.PAYLOAD_TOO_LARGE,
          detail: 'a payload is 8 bytes at most, not 9',
        });
      }

      core.receive(requestOf(1, { payload: new Uint8Array(53) }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 1, ProtocolCode.ENVELOPE_TOO_LARGE]]);
    });

    test('cut a failure’s detail to what its envelope holds, and to its own limit, both ways', async () => {
      const detail = 'x'.repeat(100);
      const failure = { code: 1, detail, scope: FailureScope.APPLICATION };

      for (const [limits, length] of [
        [{ chunkBytes: 64, maximumEnvelopeBytes: 64, windowBytes: 128 }, 36],
        [{ maximumDetailBytes: 10 }, 10],
      ] as const) {
        const { port, sent } = createPort();
        using core = createRouterCore(port, { limits });

        await core.respond({ failure }, { connectionHandle: 'a', header: headerOf(1) });

        const [{ envelope } = { envelope: undefined }] = sent;

        expect(envelope?.kind === EnvelopeKind.FAILURE && envelope.failure.detail).toHaveLength(
          length
        );
      }

      const { port } = createPort();
      using core = createRouterCore(port, { limits: { maximumDetailBytes: 4 } });
      const asking = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.receive(
        envelopeOf({
          failure: { code: 1, detail: 'abcdefgh', scope: FailureScope.APPLICATION },
          header: { callId: 2, kind: EnvelopeKind.FAILURE },
          kind: EnvelopeKind.FAILURE,
        }),
        'a'
      );

      await expect(asking).rejects.toMatchObject({ detail: 'abcd' });
    });
  });

  test.describe('the transfers it receives', () => {
    test('refuse an opening before any credit goes, each by its own failure, and keep nothing of it', async () => {
      const opening = requestOf(1, { payload: new Uint8Array(40), total: 128 });

      for (const [given, openings, answers] of [
        [
          {},
          [requestOf(3, { payload: Uint8Array.of(1), total: 0 })],
          [[3, ProtocolCode.PAYLOAD_TOO_LARGE, 'a transfer declares its total, not 0']],
        ],
        [
          {},
          [requestOf(3, { payload: Uint8Array.of(1), total: 1_025 })],
          [[3, ProtocolCode.PAYLOAD_TOO_LARGE, 'a payload is 1024 bytes at most, not 1025']],
        ],
        [
          { maximumTransfers: 0 },
          [requestOf(3, { payload: Uint8Array.of(1), total: 8 })],
          [[3, ProtocolCode.PAYLOAD_TOO_LARGE, 'this peer takes no transfer']],
        ],
        [
          {},
          [requestOf(3, { payload: new Uint8Array(4), total: 4 })],
          [[3, ProtocolCode.CHUNK_INVALID, 'an opening of 4 bytes holds its whole total of 4']],
        ],
        [
          { maximumTransfers: 1 },
          [opening, requestOf(3, { payload: Uint8Array.of(1), total: 8 })],
          [
            [1, EnvelopeKind.CREDIT],
            [
              3,
              ProtocolCode.CAPACITY_EXCEEDED,
              'the transfers a connection receives at once are 1 at most',
            ],
          ],
        ],
        [
          { bufferedBytesBudget: 128, maximumPayloadBytes: 128 },
          [opening, requestOf(3, { payload: Uint8Array.of(1), total: 8 })],
          [
            [1, EnvelopeKind.CREDIT],
            [
              3,
              ProtocolCode.CAPACITY_EXCEEDED,
              'the transfers received hold the budget but 0 bytes',
            ],
          ],
        ],
      ] as const) {
        const { port, reported, sent } = createPort();
        // envelopes as large as by default, for a refusal's detail to go whole
        using core = createRouterCore(port, { limits: { maximumPayloadBytes: 1_024, ...given } });
        const seen: IRequestResolverProps<Handle>[] = [];

        core.registerResolver(resolverOf(echo, seen));

        for (const bytes of openings) {
          core.receive(bytes, 'a');
        }

        // no credit went: what comes after a refusal belongs to no call
        core.receive(chunkOf(3, { offset: 4, payload: Uint8Array.of(1), total: 8 }), 'a');
        await sleep(0);

        expect(
          sent.map(({ envelope }) => {
            return envelope?.kind === EnvelopeKind.FAILURE
              ? [envelope.header.callId, envelope.failure.code, envelope.failure.detail]
              : [envelope?.header.callId, envelope?.kind];
          }),
          JSON.stringify(given)
        ).toEqual(answers);
        expect(codesOf(reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
        expect(seen).toEqual([]);
      }
    });

    test('find a transfer that a chunk comes for at once, as its first credit goes out', async () => {
      const { port, reported, sent } = createPort();
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(80);
      // the chunk each call's first credit brings
      const chunks = new Map([
        [1, chunkOf(1, { offset: 40, payload: payload.subarray(40), total: 80 })],
        [2, chunkOf(2, { offset: 32, payload: payload.subarray(32), total: 80 })],
      ]);
      using core = createRouterCore(
        {
          ...port,
          // a transport that hands a credit's answer back before its send returns
          send: (bytes, connectionHandle) => {
            const sending = port.send(bytes, connectionHandle);
            const envelope = sent.at(-1)?.envelope;
            const chunk =
              envelope?.kind === EnvelopeKind.CREDIT
                ? chunks.get(envelope.header.callId)
                : undefined;

            if (chunk !== undefined) {
              core.receive(chunk, connectionHandle);
            }

            return sending;
          },
        },
        { limits }
      );
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 80 }), 'a');
      await sleep(0);
      core.receive(resultOpeningOf(2, { payload: payload.subarray(0, 32), total: 80 }), 'a');

      await expect(answering).resolves.toMatchObject({ payload });
      expect(
        seen.map(({ payload: whole }) => {
          return whole;
        })
      ).toEqual([payload]);
      expect(reported).toEqual([]);
    });

    test('assemble a request’s payload from full chunks in any order, credited half a window at least at a time, then dispatch it', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(300);
      const chunk = (start: number, end: number) => {
        return chunkOf(1, { offset: start, payload: payload.subarray(start, end), total: 300 });
      };

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 300 }), 'a');

      // out of order, and again: each byte placed once; the last may come before the chunk ahead
      for (const [start, end] of [
        [88, 136],
        [40, 88],
        [184, 232],
        [136, 184],
        [40, 88],
        [280, 300],
      ] as const) {
        core.receive(chunk(start, end), 'a');
      }

      expect(seen).toEqual([]);

      core.receive(chunk(232, 280), 'a');

      expect(
        seen.map(({ header, payload: whole }) => {
          return [header.total, whole];
        })
      ).toEqual([[300, payload]]);

      await core.respond(
        { payload: Uint8Array.of(9) },
        { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(1) }
      );
      // once answered, a chunk under the credit granted is late, and one past it never granted
      core.receive(chunk(232, 280), 'a');
      core.receive(chunkOf(1, { offset: 290, payload: new Uint8Array(48), total: 1_024 }), 'a');
      await sleep(0);

      // the window past the opening; 96 more once 136 came, half a window at least; then the rest
      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['a', 'credit', 1, 264],
        ['a', 'credit', 1, 300],
        ['a', 'result', 1, [9]],
      ]);
      expect(codesOf(reported)).toEqual([[ProtocolCode.CREDIT_EXCEEDED, 'a']]);
    });

    test('hold a connection’s place for a transfer until its call ends, not once its payload is whole', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits: { ...limits, maximumTransfers: 1 } });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(100);

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 100 }), 'a');
      core.receive(chunkOf(1, { offset: 40, payload: payload.subarray(40, 88), total: 100 }), 'a');
      core.receive(chunkOf(1, { offset: 88, payload: payload.subarray(88), total: 100 }), 'a');
      // whole and dispatched, its call not answered yet
      core.receive(requestOf(3, { payload: Uint8Array.of(1), total: 8 }), 'a');
      await core.respond(
        { payload: Uint8Array.of(9) },
        { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(1) }
      );
      core.receive(requestOf(5, { payload: Uint8Array.of(1), total: 8 }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 100],
        ['a', 'failure', 3, ProtocolCode.CAPACITY_EXCEEDED],
        ['a', 'result', 1, [9]],
        ['a', 'credit', 5, 8],
      ]);
    });

    test('give the budget back once a payload is whole, and grant the transfer it starved', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits: narrow });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(168);

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 168 }), 'a');
      // the budget holds its opening, and grants it nothing
      core.receive(requestOf(3, { payload: new Uint8Array(32), total: 100 }), 'b');
      // the budget holds no more
      core.receive(requestOf(5, { payload: Uint8Array.of(1), total: 8 }), 'a');

      for (const offset of [40, 88, 136]) {
        core.receive(
          chunkOf(1, { offset, payload: payload.subarray(offset, offset + 48), total: 168 }),
          'a'
        );
      }

      await sleep(0);

      // whole, its call not answered yet
      expect(seen).toHaveLength(1);
      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['a', 'failure', 5, ProtocolCode.CAPACITY_EXCEEDED],
        ['b', 'credit', 3, 100],
      ]);
    });

    test('end a request’s transfer with the failure a chunk breaks, and drop what its credit let come after', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(200);

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 200 }), 'a');
      // the last, it says, yet it ends before the total
      core.receive(
        envelopeOf({
          header: { callId: 1, isLast: true, kind: EnvelopeKind.CHUNK, offset: 40 },
          kind: EnvelopeKind.CHUNK,
          payload: payload.subarray(40, 80),
        }),
        'a'
      );
      // under the credit granted, then past it
      core.receive(chunkOf(1, { offset: 80, payload: payload.subarray(80, 120), total: 200 }), 'a');
      core.receive(chunkOf(1, { offset: 160, payload: payload.subarray(160), total: 200 }), 'a');
      core.receive(requestOf(3, { payload: payload.subarray(0, 40), total: 200 }), 'a');
      core.receive(chunkOf(3, { offset: 168, payload: payload.subarray(168), total: 200 }), 'a');
      // a request opens the call id abandoned again, without a transfer
      core.receive(requestOf(1), 'a');
      core.receive(chunkOf(1, { offset: 80, payload: payload.subarray(80, 120), total: 200 }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['a', 'failure', 1, ProtocolCode.CHUNK_INVALID],
        ['a', 'credit', 3, 168],
        ['a', 'failure', 3, ProtocolCode.CREDIT_EXCEEDED],
      ]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.CREDIT_EXCEEDED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
      expect(reported[1]?.[0].message).toContain('call 1 receives no transfer');
      expect(
        seen.map(({ header }) => {
          return [header.callId, header.total];
        })
      ).toEqual([[1, undefined]]);
    });

    test('end a request’s transfer its requester cancels, giving the budget back', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits: narrow });

      core.registerResolver(resolverOf(echo));
      core.receive(requestOf(1, { payload: new Uint8Array(40), total: 200 }), 'a');
      core.receive(cancelOf(1), 'a');
      // under the credit granted: late
      core.receive(chunkOf(1, { offset: 40, payload: new Uint8Array(48), total: 200 }), 'a');
      core.receive(requestOf(3, { payload: new Uint8Array(40), total: 200 }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['a', 'credit', 3, 168],
      ]);
      expect(reported).toEqual([]);
    });

    test('receive a result in a transfer, credited as it comes, and settle its call once whole', async () => {
      const { activities, port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const payload = patternOf(300);
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });
      const chunk = (start: number, end?: number) => {
        return chunkOf(2, { offset: start, payload: payload.subarray(start, end), total: 300 });
      };

      await sleep(0);
      core.receive(resultOpeningOf(2, { payload: payload.subarray(0, 32), total: 300 }), 'a');
      core.receive(chunk(80, 128), 'a');
      // again: nothing new, dropped in silence
      core.receive(chunk(80, 128), 'a');
      core.receive(chunk(32, 80), 'a');
      core.receive(chunk(128, 176), 'a');
      core.receive(chunk(176, 224), 'a');
      core.receive(chunk(224, 272), 'a');

      expect(activities).toEqual(['request a']);

      core.receive(chunk(272), 'a');
      // late, its call id reserved
      core.receive(chunk(272), 'a');

      await expect(answering).resolves.toEqual({
        header: { callId: 2, kind: EnvelopeKind.RESULT, total: 300 },
        payload,
      });
      expect(activities).toEqual(['request a', 'response a']);
      // a window past the opening, then more as the chunks come: 128 received, then 176
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', 'credit', 2, 160],
        ['a', 'credit', 2, 256],
        ['a', 'credit', 2, 300],
      ]);
      expect(reported).toEqual([]);
      expect(core.isReserved(2, 'a')).toBe(true);
    });

    test('reject a result whose chunk breaks its transfer, cancel its call, and drop what comes after', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.receive(resultOpeningOf(2, { payload: new Uint8Array(32), total: 150 }), 'a');
      // the last, it says, yet it ends before the total
      core.receive(
        envelopeOf({
          header: { callId: 2, isLast: true, kind: EnvelopeKind.CHUNK, offset: 32 },
          kind: EnvelopeKind.CHUNK,
          payload: new Uint8Array(48),
        }),
        'a'
      );
      core.receive(chunkOf(2, { offset: 80, payload: new Uint8Array(48), total: 150 }), 'a');

      await expect(answering).rejects.toMatchObject({
        code: ProtocolCode.CHUNK_INVALID,
        procedureAddress: { procedureId: 1, serviceId: 2 },
        side: 'server',
      });
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', 'credit', 2, 150],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);
      expect(reported).toEqual([]);
    });

    test('end a result’s transfer the peer fails, giving the budget back, and drop what comes after', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits: narrow });
      const ask = () => {
        return core.request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo });
      };
      const first = ask();

      await sleep(0);
      core.receive(resultOpeningOf(2, { payload: new Uint8Array(32), total: 200 }), 'a');
      core.receive(
        envelopeOf({
          failure: { code: ProtocolCode.TRANSFER_STALLED, scope: FailureScope.PROTOCOL },
          header: { callId: 2, kind: EnvelopeKind.FAILURE },
          kind: EnvelopeKind.FAILURE,
        }),
        'a'
      );
      core.receive(chunkOf(2, { offset: 32, payload: new Uint8Array(48), total: 200 }), 'a');

      await expect(first).rejects.toMatchObject({
        code: ProtocolCode.TRANSFER_STALLED,
        origin: 'peer',
      });

      // what the first held of the budget, the second is granted
      const second = ask().catch((reason: unknown) => {
        return reason;
      });

      await sleep(0);
      core.receive(resultOpeningOf(4, { payload: new Uint8Array(32), total: 200 }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', 'credit', 2, 160],
        ['a', EnvelopeKind.REQUEST, 4],
        ['a', 'credit', 4, 160],
      ]);
      expect(reported).toEqual([]);
      core.cancel({ callId: 4, connectionHandle: 'a' });
      await expect(second).resolves.toBeInstanceOf(CancelError);
    });

    test('report a second result on a call whose result comes in a transfer, and go on receiving it', async () => {
      const { port, reported } = createPort();
      using core = createRouterCore(port, { limits });
      const payload = patternOf(80);
      const answering = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.receive(resultOpeningOf(2, { payload: payload.subarray(0, 32), total: 80 }), 'a');
      core.receive(resultOf(2, Uint8Array.of(9)), 'a');
      core.receive(chunkOf(2, { offset: 32, payload: payload.subarray(32), total: 80 }), 'a');

      await expect(answering).resolves.toMatchObject({ payload });
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      expect(reported[0]?.[0].message).toContain('call 2 is answered already, by a transfer');
    });

    test('report a chunk no transfer takes, on a call open without one or on none; drop a credit in silence', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const asking = core
        .request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
        .catch((reason: unknown) => {
          return reason;
        });

      core.registerResolver(resolverOf(echo));
      await sleep(0);
      core.receive(requestOf(1), 'a');

      // the peer's call open, and none; this side's, then none
      for (const callId of [1, 3, 2, 4]) {
        core.receive(chunkOf(callId, { offset: 0, payload: Uint8Array.of(1), total: 8 }), 'a');
      }

      for (const callId of [1, 2, 9]) {
        core.receive(creditOf(callId), 'a');
      }

      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', EnvelopeKind.REQUEST, 2]]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.CALL_UNKNOWN, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.CALL_UNKNOWN, 'a'],
      ]);
      core.cancel({ callId: 2, connectionHandle: 'a' });
      await expect(asking).resolves.toBeInstanceOf(CancelError);
    });

    test('end the transfer a chunk that does not read was for, but where it is late, or its payload whole', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(200);
      // a chunk with no byte does not read
      const emptyChunkOf = (callId: number) => {
        return fromHexadecimal(`A1 14 00 04  00 00 00 0${String(callId)}  00 00 00 00 00 00 00 00`);
      };
      const asking = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      core.registerResolver(resolverOf(echo, seen));
      await sleep(0);
      core.receive(requestOf(1, { payload: payload.subarray(0, 40), total: 200 }), 'a');
      core.receive(resultOpeningOf(2, { payload: payload.subarray(0, 32), total: 200 }), 'a');
      // a request's payload whole: its call is its resolver's
      core.receive(requestOf(3, { payload: payload.subarray(0, 40), total: 60 }), 'a');
      core.receive(chunkOf(3, { offset: 40, payload: payload.subarray(40, 60), total: 60 }), 'a');

      for (const callId of [1, 1, 2, 2, 3, 5]) {
        core.receive(emptyChunkOf(callId), 'a');
      }

      // a credit with a byte does not read either
      core.receive(fromHexadecimal('A1 15 00 04  00 00 00 01  00 00 00 00 00 00 00 08  01'), 'a');
      // a chunk past the total of a payload whole ends nothing
      core.receive(chunkOf(3, { offset: 50, payload: new Uint8Array(20), total: 1_024 }), 'a');
      await core.respond(
        { payload: Uint8Array.of(9) },
        { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(3) }
      );

      await expect(asking).rejects.toMatchObject({
        code: ProtocolCode.CHUNK_INVALID,
        side: 'server',
      });
      expect(answersOf(sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', 'credit', 1, 168],
        ['a', 'credit', 2, 160],
        ['a', 'credit', 3, 60],
        ['a', 'failure', 1, ProtocolCode.CHUNK_INVALID],
        ['a', EnvelopeKind.CANCEL, 2],
        ['a', 'result', 3, [9]],
      ]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.CHUNK_INVALID, 'a'],
      ]);
    });

    test('end a transfer nothing comes for: a request’s with a failure, a result’s with a timeout', async () => {
      const { port, reported, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 250 },
      });
      let asking: Promise<unknown> = Promise.resolve();

      core.registerResolver(resolverOf(echo));

      const { armed } = timersBy(clock, () => {
        core.receive(requestOf(1, { payload: new Uint8Array(40), total: 200 }), 'a');
        asking = core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options,
          procedure: echo,
        });
        core.receive(resultOpeningOf(2, { payload: new Uint8Array(32), total: 200 }), 'a');
      });
      const stalls = armed.filter(({ delay }) => {
        return delay === 250;
      });

      // nothing waits on the timer of a request's transfer: it keeps no process alive; the caller
      // waits on its call's, which does
      expect(
        stalls.map(({ handle }) => {
          return hasRef(handle);
        })
      ).toEqual([false, true]);

      clock.tick(250);

      await expect(asking).rejects.toMatchObject({ name: 'TimeoutError', timeout: 250 });
      // late, and dropped in silence
      core.receive(chunkOf(1, { offset: 40, payload: new Uint8Array(48), total: 200 }), 'a');
      core.receive(chunkOf(2, { offset: 32, payload: new Uint8Array(48), total: 200 }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['a', EnvelopeKind.REQUEST, 2],
        ['a', 'credit', 2, 160],
        ['a', 'failure', 1, ProtocolCode.TRANSFER_STALLED],
        ['a', EnvelopeKind.CANCEL, 2],
      ]);
      expect(reported).toEqual([]);
    });

    test('end the transfers of a connection that goes before their budget grants any credit, and send nothing once disposed', async () => {
      const { port, reported, sent } = createPort();
      const core = createRouterCore(port, { limits: narrow });

      core.registerResolver(resolverOf(echo));
      core.receive(requestOf(1, { payload: new Uint8Array(40), total: 168 }), 'a');
      // starved, each: nothing is left of the budget
      core.receive(requestOf(3, { payload: new Uint8Array(16), total: 100 }), 'a');
      core.receive(requestOf(1, { payload: new Uint8Array(16), total: 100 }), 'b');
      core.rejectPending('gone', 'a');
      core.receive(requestOf(3, { payload: new Uint8Array(44), total: 200 }), 'b');
      core[Symbol.dispose]();
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'credit', 1, 168],
        ['b', 'credit', 1, 100],
      ]);
      expect(reported).toEqual([]);
    });

    test('stall no request whose payload came whole, however long its resolver takes', () => {
      const { port, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 250 },
      });

      // a resolver that never answers
      core.registerResolver(
        Object.assign(() => {
          return new Promise<void>(() => {
            return undefined;
          });
        }, echo)
      );

      core.receive(requestOf(1, { payload: patternOf(40), total: 60 }), 'a');
      core.receive(chunkOf(1, { offset: 40, payload: patternOf(20), total: 60 }), 'a');
      // every timer still armed fires
      clock.runAll();

      expect(answersOf(sent)).toEqual([['a', 'credit', 1, 60]]);
    });

    test('reserve the call id of a result it received in part as long as the peer keeps its call abandoned, or its timeout when longer', async () => {
      const failed = envelopeOf({
        failure: { code: 21, scope: FailureScope.APPLICATION },
        header: { callId: 2, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });

      for (const [ending, timeout, reservation] of [
        ['whole', 1_000, 4_000],
        ['failure', 1_000, 4_000],
        ['invalid', 1_000, 4_000],
        ['cancel', 1_000, 4_000],
        ['cancel given time', 1_000, 9_000],
        ['signal', 1_000, 4_000],
        ['whole', 9_000, 9_000],
        ['whole', undefined, 5_000],
      ] as const) {
        const { port } = createPort();
        const clock = createTestClock();
        using core = createRouterCore(port, {
          clock,
          limits: { ...limits, transferInactivityTimeout: 4_000 },
        });
        const controller = new AbortController();
        const asking = core
          .request(Uint8Array.of(1), {
            connectionHandle: 'a',
            options: { signal: controller.signal, timeout: timeout ?? Number.POSITIVE_INFINITY },
            procedure: echo,
          })
          .catch((reason: unknown) => {
            return reason;
          });

        core.receive(resultOpeningOf(2, { payload: patternOf(32), total: 40 }), 'a');

        const { armed } = await timersUntil(clock, () => {
          if (ending === 'whole') {
            core.receive(chunkOf(2, { offset: 32, payload: patternOf(8), total: 40 }), 'a');
          } else if (ending === 'failure') {
            core.receive(failed, 'a');
          } else if (ending === 'invalid') {
            core.receive(chunkOf(2, { offset: 32, payload: patternOf(9), total: 41 }), 'a');
          } else if (ending === 'cancel') {
            core.cancel({ callId: 2, connectionHandle: 'a' });
          } else if (ending === 'cancel given time') {
            core.cancel({ callId: 2, connectionHandle: 'a', timeout: 9_000 });
          } else {
            controller.abort();
          }

          return asking;
        });

        // the reservation, the one timer an ending arms
        expect(
          armed.map(({ delay }) => {
            return delay;
          }),
          `${ending}, ${String(timeout)}`
        ).toEqual([reservation]);
      }
    });
  });

  test.describe('the transfers it sends', () => {
    /** A failure's bytes on `callId`, the application's. */
    const failedOf = (callId: number): Uint8Array => {
      return envelopeOf({
        failure: { code: 21, scope: FailureScope.APPLICATION },
        header: { callId, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
    };

    /** A core with small envelopes that takes the peer's requests on call 1 and on, and hands them over. */
    const createAnswering = (given: RouterLimitsOptions = {}) => {
      const recorded = createPort();
      const seen: IRequestResolverProps<Handle>[] = [];
      const clock = createTestClock();
      const core = createRouterCore(recorded.port, { clock, limits: { ...limits, ...given } });

      core.registerResolver(resolverOf(echo, seen));

      return { ...recorded, clock, core, seen };
    };

    /** An answer on the call the peer's `index`th request opened. */
    const answerOf = (
      { core, seen }: { core: IRouterCore<Handle>; seen: IRequestResolverProps<Handle>[] },
      { index = 0, payload }: { index?: number; payload: Uint8Array }
    ) => {
      return core.respond(
        { payload },
        { connectionHandle: 'a', header: seen[index]?.header ?? headerOf(99) }
      );
    };

    /** What a promise settled with, or `undefined` while it has not. */
    const settledOf = (promise: Promise<unknown>) => {
      return promise.then(
        (value: unknown) => {
          return value;
        },
        (reason: unknown) => {
          return reason;
        }
      );
    };

    test('send a payload in one envelope to its limit, and one byte more as a transfer, or not at all where none is sent', async () => {
      const answering = createAnswering();
      const { core, sent } = answering;
      const ask = (length: number) => {
        return settledOf(
          core.request(new Uint8Array(length), { connectionHandle: 'a', options, procedure: echo })
        );
      };

      // a request's header takes 12 bytes; a result's 8, and 16 more for a session it may announce
      void ask(52);
      void ask(53);
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3), 'a');
      void settledOf(answerOf(answering, { payload: new Uint8Array(40) }));
      void settledOf(answerOf(answering, { index: 1, payload: new Uint8Array(41) }));
      await sleep(0);

      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, undefined, 52],
        [EnvelopeKind.REQUEST, 4, 53, 44],
        [EnvelopeKind.RESULT, 1, undefined, 40],
        [EnvelopeKind.RESULT, 3, 41, 32],
      ]);

      const none = createAnswering({ maximumTransfers: 0 });

      none.core.receive(requestOf(1), 'a');

      await expect(
        none.core.request(new Uint8Array(53), { connectionHandle: 'a', options, procedure: echo })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload of 53 bytes goes as a transfer, which this side sends none of',
      });
      await expect(answerOf(none, { payload: new Uint8Array(41) })).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
      });
      expect(none.sent).toEqual([]);

      core[Symbol.dispose]();
      none.core[Symbol.dispose]();
    });

    test('send a request as a transfer: its opening, the chunks each credit lets go, then wait on its answer', async () => {
      const { activities, port, reported, sent, sizes } = createPort();
      using core = createRouterCore(port, { limits });
      const payload = patternOf(200);
      const answering = core.request(payload, { connectionHandle: 'a', options, procedure: echo });

      await sleep(0);

      expect(piecesOf(sent)).toEqual([[EnvelopeKind.REQUEST, 2, 200, 44]]);

      core.receive(creditOf(2, 140), 'a');
      await sleep(0);

      // full chunks alone, the next waiting for its credit
      expect(piecesOf(sent).slice(1)).toEqual([
        [EnvelopeKind.CHUNK, 2, 44, 48],
        [EnvelopeKind.CHUNK, 2, 92, 48],
      ]);
      expect(activities).toEqual([]);

      core.receive(creditOf(2, 200), 'a');
      await sleep(0);

      expect(activities).toEqual(['request a']);

      core.receive(resultOf(2, Uint8Array.of(9)), 'a');

      await expect(answering).resolves.toMatchObject({ payload: Uint8Array.of(9) });
      expect(piecesOf(sent).slice(3)).toEqual([
        [EnvelopeKind.CHUNK, 2, 140, 48],
        [EnvelopeKind.CHUNK, 2, 188, 12],
      ]);
      expect(payloadOf(sent, 2)).toEqual(payload);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
      expect(reported).toEqual([]);
    });

    test('send a result as a transfer, its call held open until its last chunk is handed off', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { reported, seen, sent, sizes } = answering;
      const payload = patternOf(150);
      let isAnswered = false;

      core.receive(requestOf(1), 'a');

      const responding = answerOf(answering, { payload }).then(() => {
        isAnswered = true;
      });

      // its call is open still: the same call id is refused
      core.receive(requestOf(1), 'a');
      core.receive(creditOf(1, 80), 'a');
      await sleep(0);

      expect(isAnswered).toBe(false);

      core.receive(creditOf(1, 150), 'a');
      await responding;
      // answered: a request on its call id is dispatched
      core.receive(requestOf(1), 'a');

      expect(seen).toHaveLength(2);
      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.RESULT, 1, 150, 32],
        [EnvelopeKind.CHUNK, 1, 32, 48],
        [EnvelopeKind.CHUNK, 1, 80, 48],
        [EnvelopeKind.CHUNK, 1, 128, 22],
      ]);
      expect(payloadOf(sent, 1)).toEqual(payload);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
    });

    test('find a transfer it sends at once, for a credit that comes back as its opening goes, and never send inside a send', async () => {
      const { port, reported, sent } = createPort();
      const seen: IRequestResolverProps<Handle>[] = [];
      let depth = 0;
      let deepest = 0;
      using core = createRouterCore(
        {
          ...port,
          // a transport that credits one chunk more of what it is handed, before its send returns
          send: (bytes, connectionHandle) => {
            depth += 1;
            deepest = Math.max(deepest, depth);

            const sending = port.send(bytes, connectionHandle);
            const envelope = sent.at(-1)?.envelope;
            const end =
              envelope?.kind === EnvelopeKind.CHUNK
                ? envelope.header.offset + envelope.payload.length
                : (envelope?.kind === EnvelopeKind.REQUEST ||
                      envelope?.kind === EnvelopeKind.RESULT) &&
                    envelope.header.total !== undefined
                  ? envelope.payload.length
                  : undefined;

            if (envelope !== undefined && end !== undefined) {
              core.receive(creditOf(envelope.header.callId, end + 48), connectionHandle);
            }

            depth -= 1;

            return sending;
          },
        },
        { limits }
      );
      const payload = patternOf(200);
      const asking = core.request(payload, { connectionHandle: 'a', options, procedure: echo });

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1), 'a');
      await core.respond(
        { payload },
        { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(1) }
      );
      core.receive(resultOf(2), 'a');
      await asking;

      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, 200, 44],
        [EnvelopeKind.CHUNK, 2, 44, 48],
        [EnvelopeKind.CHUNK, 2, 92, 48],
        [EnvelopeKind.CHUNK, 2, 140, 48],
        [EnvelopeKind.CHUNK, 2, 188, 12],
        [EnvelopeKind.RESULT, 1, 200, 32],
        [EnvelopeKind.CHUNK, 1, 32, 48],
        [EnvelopeKind.CHUNK, 1, 80, 48],
        [EnvelopeKind.CHUNK, 1, 128, 48],
        [EnvelopeKind.CHUNK, 1, 176, 24],
      ]);
      expect([payloadOf(sent, 2), payloadOf(sent, 1)]).toEqual([payload, payload]);
      // the chunks go inside the opening's send, whose credit came back as it went, and one after the
      // other: a credit that comes as a chunk goes only raises the end, and no chunk goes inside another
      expect(deepest).toBe(2);
      expect(reported).toEqual([]);
    });

    test('stop a result the peer cancels, and send nothing more of it, whatever credit comes', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { reported, seen, sent } = answering;

      core.receive(requestOf(1), 'a');

      const responding = answerOf(answering, { payload: patternOf(150) });

      core.receive(creditOf(1, 80), 'a');
      core.receive(cancelOf(1), 'a');
      core.receive(creditOf(1, 150), 'a');

      await expect(responding).rejects.toBeInstanceOf(CancelError);
      expect(seen[0]?.signal.aborted).toBe(true);
      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.RESULT, 1, 150, 32],
        [EnvelopeKind.CHUNK, 1, 32, 48],
      ]);
      expect(reported).toEqual([]);
    });

    test('keep a result going that its resolver failed behind, a second answer going nowhere, until the peer cancels it', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const answers: Promise<unknown>[] = [];

      // a resolver that answers with a transfer, answers again, then fails
      core.registerResolver(
        Object.assign(({ connectionHandle, header }: IRequestResolverProps<Handle>) => {
          answers.push(
            settledOf(core.respond({ payload: patternOf(150) }, { connectionHandle, header })),
            settledOf(core.respond({ payload: Uint8Array.of(1) }, { connectionHandle, header }))
          );

          return Promise.reject(new Error('failed behind its answer'));
        }, echo)
      );
      core.receive(requestOf(1), 'a');
      await sleep(0);
      core.receive(creditOf(1, 80), 'a');
      core.receive(cancelOf(1), 'a');
      core.receive(creditOf(1, 150), 'a');

      await expect(Promise.all(answers)).resolves.toEqual([expect.any(CancelError), undefined]);
      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.RESULT, 1, 150, 32],
        [EnvelopeKind.CHUNK, 1, 32, 48],
      ]);
      expect(codesOf(reported)).toEqual([['failed behind its answer', 'a']]);
    });

    test('free the call of an answer that could not go out, so its call id opens again', async () => {
      const { port } = createPort();
      const seen: IRequestResolverProps<Handle>[] = [];
      let isRefusing = true;
      using core = createRouterCore(
        {
          ...port,
          // a transport that throws as it is handed the first answer
          send: (bytes, connectionHandle) => {
            if (isRefusing && bytes[1] === EnvelopeKind.RESULT) {
              isRefusing = false;

              throw new Error('the transport is closing');
            }

            return port.send(bytes, connectionHandle);
          },
        },
        { limits }
      );

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1), 'a');

      await expect(answerOf({ core, seen }, { payload: Uint8Array.of(1) })).rejects.toThrow(
        'the transport is closing'
      );

      core.receive(requestOf(1), 'a');

      expect(seen).toHaveLength(2);
    });

    test('stop a request the peer answers, or its caller gives up, and send nothing more of it', async () => {
      for (const [ending, reason] of [
        ['failure', FailureError],
        ['cancel', CancelError],
        ['signal', CancelError],
      ] as const) {
        const { port, reported, sent } = createPort();
        using core = createRouterCore(port, { limits });
        const controller = new AbortController();
        const asking = core.request(patternOf(200), {
          connectionHandle: 'a',
          options: { ...options, signal: controller.signal },
          procedure: echo,
        });

        core.receive(creditOf(2, 92), 'a');

        if (ending === 'failure') {
          core.receive(failedOf(2), 'a');
        } else if (ending === 'cancel') {
          core.cancel({ callId: 2, connectionHandle: 'a' });
        } else {
          controller.abort();
        }

        await expect(asking, ending).rejects.toBeInstanceOf(reason);
        core.receive(creditOf(2, 200), 'a');
        await sleep(0);

        // the peer ended its call itself; given up, it is told to
        expect(piecesOf(sent), ending).toEqual([
          [EnvelopeKind.REQUEST, 2, 200, 44],
          [EnvelopeKind.CHUNK, 2, 44, 48],
          ...(ending === 'failure' ? [] : [[EnvelopeKind.CANCEL, 2]]),
        ]);
        expect(reported).toEqual([]);
      }
    });

    test('end a request whose chunk cannot go out, telling the peer to cancel it; a send failed behind its answer ends nothing more', async () => {
      const failing = createPort();
      using core = createRouterCore(failing.port, { limits });
      const asking = core.request(patternOf(200), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      failing.control.sendErrors.set('a', new Error('gone'));
      core.receive(creditOf(2, 92), 'a');

      await expect(asking).rejects.toThrow('gone');
      expect(piecesOf(failing.sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, 200, 44],
        [EnvelopeKind.CHUNK, 2, 44, 48],
        [EnvelopeKind.CANCEL, 2],
      ]);
      expect(core.isReserved(2, 'a')).toBe(true);

      const answered = createPort();
      using answeredCore = createRouterCore(answered.port, { limits });
      const answering = answeredCore.request(patternOf(200), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      // the chunk's send fails once its call was answered
      answered.control.sendErrors.set('a', new Error('gone'));
      answeredCore.receive(creditOf(2, 92), 'a');
      answeredCore.receive(failedOf(2), 'a');

      await expect(answering).rejects.toMatchObject({ code: 21 });
      await sleep(0);
      expect(piecesOf(answered.sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, 200, 44],
        [EnvelopeKind.CHUNK, 2, 44, 48],
      ]);
      expect(answered.reported).toEqual([]);
    });

    test('end a result whose chunk cannot go out, forgetting its call', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { control, reported, seen } = answering;

      core.receive(requestOf(1), 'a');

      const responding = answerOf(answering, { payload: patternOf(150) });

      control.sendErrors.set('a', new Error('gone'));
      core.receive(creditOf(1, 80), 'a');

      await expect(responding).rejects.toThrow('gone');

      // forgotten: a request on its call id is dispatched
      core.receive(requestOf(1), 'a');

      expect(seen).toHaveLength(2);
      expect(reported).toEqual([]);
    });

    test('end a transfer it sends that no credit comes for: a request with a timeout, a result with a failure', async () => {
      const answering = createAnswering({ transferInactivityTimeout: 250 });
      using core = answering.core;
      const { clock, reported, seen, sent } = answering;
      let asking: Promise<unknown> = Promise.resolve();
      let responding: Promise<unknown> = Promise.resolve();

      core.receive(requestOf(1), 'a');

      const { armed } = timersBy(clock, () => {
        asking = core.request(patternOf(200), { connectionHandle: 'a', options, procedure: echo });
        responding = answerOf(answering, { payload: patternOf(150) });
      });

      // the caller waits on its call's timer; nothing waits on the answer's
      expect(
        armed.map(({ delay, handle }) => {
          return [delay, hasRef(handle)];
        })
      ).toEqual([
        [250, true],
        [250, false],
      ]);

      clock.tick(250);

      await expect(asking).rejects.toMatchObject({ name: 'TimeoutError', timeout: 250 });
      await expect(responding).rejects.toMatchObject({ code: ProtocolCode.TRANSFER_STALLED });
      await sleep(0);
      // its call forgotten, a request on its call id is dispatched
      core.receive(requestOf(1), 'a');

      expect(seen).toHaveLength(2);
      expect(answersOf(sent).slice(2)).toEqual([
        ['a', EnvelopeKind.CANCEL, 2],
        ['a', 'failure', 1, ProtocolCode.TRANSFER_STALLED],
      ]);
      expect(reported).toEqual([]);
    });

    test('wait on a request’s own timer: the inactivity while it goes as a transfer, then its timeout for its answer', async () => {
      const { port, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 250 },
      });
      const asked: Promise<unknown>[] = [];
      const { armed } = timersBy(clock, () => {
        for (const length of [0, 200]) {
          asked.push(
            settledOf(
              core.request(new Uint8Array(length), {
                connectionHandle: 'a',
                options,
                procedure: echo,
              })
            )
          );
        }

        // a credit, and each chunk but the last, set it going again; the last, on its timeout
        core.receive(creditOf(4, 140), 'a');
        core.receive(creditOf(4, 200), 'a');
      });

      expect(
        armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([1_000, 250, 250, 250, 250, 250, 250, 1_000]);
      expect(
        armed.every(({ handle }) => {
          return hasRef(handle);
        })
      ).toBe(true);

      // the first's timeout and the second's, armed as its last chunk went: the rest replaced
      clock.tick(1_000);

      expect(await Promise.all(asked)).toEqual([
        expect.objectContaining({ timeout: 1_000 }),
        expect.objectContaining({ timeout: 1_000 }),
      ]);
      expect(answersOf(sent).slice(-2)).toEqual([
        ['a', EnvelopeKind.CANCEL, 2],
        ['a', EnvelopeKind.CANCEL, 4],
      ]);
    });

    test('set a call’s timer going again as the bytes of its result come, and not for bytes it has', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 250 },
      });
      const chunk = chunkOf(2, { offset: 32, payload: new Uint8Array(48), total: 150 });
      const { armed } = timersBy(clock, () => {
        void settledOf(
          core.request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
        );
        core.receive(resultOpeningOf(2, { payload: new Uint8Array(32), total: 150 }), 'a');
        core.receive(chunk, 'a');
        // again: nothing new
        core.receive(chunk, 'a');
      });

      expect(
        armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([1_000, 250, 250]);
    });

    test('arm no timer for a call its own send ended, by a failure or a cancel handed back as a chunk went', async () => {
      const { port, reported, sent } = createPort();
      const clock = createTestClock();
      const seen: IRequestResolverProps<Handle>[] = [];
      using core = createRouterCore(
        {
          ...port,
          // a transport that hands back, as the first chunk of each call goes, what ends that call
          send: (bytes, connectionHandle) => {
            const sending = port.send(bytes, connectionHandle);
            const envelope = sent.at(-1)?.envelope;

            if (envelope?.kind === EnvelopeKind.CHUNK) {
              core.receive(
                envelope.header.callId === 2 ? failedOf(2) : cancelOf(envelope.header.callId),
                connectionHandle
              );
            }

            return sending;
          },
        },
        { clock, limits: { ...limits, transferInactivityTimeout: 250 } }
      );

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1), 'a');

      const ended: Promise<unknown>[] = [];
      const { armed, cleared } = timersBy(clock, () => {
        ended.push(
          settledOf(
            core.request(patternOf(200), { connectionHandle: 'a', options, procedure: echo })
          ),
          settledOf(answerOf({ core, seen }, { payload: patternOf(150) }))
        );
        core.receive(creditOf(2, 92), 'a');
        core.receive(creditOf(1, 80), 'a');
      });

      // every timer stopped: none keeps the process waiting, none sends a stall for a call cancelled
      expect(
        armed.filter(({ handle }) => {
          return !cleared.includes(handle);
        })
      ).toEqual([]);
      expect(clock.countTimers()).toBe(0);
      expect(await Promise.all(ended)).toEqual([
        expect.objectContaining({ code: 21 }),
        expect.any(CancelError),
      ]);
      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, 200, 44],
        [EnvelopeKind.RESULT, 1, 150, 32],
        [EnvelopeKind.CHUNK, 2, 44, 48],
        [EnvelopeKind.CHUNK, 1, 32, 48],
      ]);
      expect(reported).toEqual([]);
    });

    test('keep the inactivity of a result that opens as the last chunk of its request goes', async () => {
      const { port, sent } = createPort();
      const clock = createTestClock();
      const core: IRouterCore<Handle> = createRouterCore(
        {
          ...port,
          // the peer, the request whole, answers with a transfer before the last chunk's send returns
          send: (bytes, connectionHandle) => {
            const sending = port.send(bytes, connectionHandle);
            const envelope = sent.at(-1)?.envelope;

            if (envelope?.kind === EnvelopeKind.CHUNK && envelope.header.isLast) {
              core.receive(resultOpeningOf(2, { payload: patternOf(32), total: 100 }), 'a');
            }

            return sending;
          },
        },
        { clock, limits }
      );
      let asking: Promise<unknown> = Promise.resolve();
      const { armed, cleared } = timersBy(clock, () => {
        asking = core.request(patternOf(200), { connectionHandle: 'a', options, procedure: echo });
        core.receive(creditOf(2, 200), 'a');
      });
      const live = armed.filter(({ handle }) => {
        return !cleared.includes(handle);
      });

      // the result's inactivity, not the call's timeout, which counts no transfer
      expect(
        live.map(({ delay }) => {
          return delay;
        })
      ).toEqual([30_000]);

      core[Symbol.dispose]();
      await expect(asking).rejects.toBeInstanceOf(DisconnectError);
    });

    test('stop a call’s timer as the call leaves, whichever way, so none keeps the process waiting', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock, limits });
      const { armed, cleared } = timersBy(clock, () => {
        for (let index = 0; index < 3; index += 1) {
          void settledOf(
            core.request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
          );
        }

        // answered, cancelled, failed
        core.receive(resultOf(2), 'a');
        core.cancel({ callId: 4, connectionHandle: 'a' });
        core.receive(failedOf(6), 'a');
      });

      expect(
        armed.slice(0, 3).map(({ handle }) => {
          return cleared.includes(handle);
        })
      ).toEqual([true, true, true]);
    });

    test('end a result it receives as its caller ends the call: its budget and place given back, the peer told, its call id reserved', async () => {
      for (const ending of ['cancel', 'signal', 'timer'] as const) {
        const { port, sent } = createPort();
        const clock = createTestClock();
        using core = createRouterCore(port, {
          clock,
          limits: { ...narrow, maximumTransfers: 1, transferInactivityTimeout: 250 },
        });
        const controller = new AbortController();
        let asking: Promise<unknown> = Promise.resolve();
        const { armed } = timersBy(clock, () => {
          asking = settledOf(
            core.request(new Uint8Array(0), {
              connectionHandle: 'a',
              options: { ...options, signal: controller.signal },
              procedure: echo,
            })
          );
          core.receive(resultOpeningOf(2, { payload: new Uint8Array(32), total: 200 }), 'a');
        });

        if (ending === 'cancel') {
          core.cancel({ callId: 2, connectionHandle: 'a' });
        } else if (ending === 'signal') {
          controller.abort();
        } else {
          // the call's own timer, its result's inactivity, the last armed
          expect(armed.at(-1)?.delay).toBe(250);
          clock.tick(250);
        }

        expect(await asking, ending).toBeInstanceOf(
          ending === 'timer' ? TimeoutError : CancelError
        );
        expect(core.isReserved(2, 'a'), ending).toBe(true);

        // its budget and its place back: another result is granted a whole window
        const next = settledOf(
          core.request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
        );

        core.receive(resultOpeningOf(4, { payload: new Uint8Array(32), total: 200 }), 'a');
        core.cancel({ callId: 4, connectionHandle: 'a' });
        await next;

        expect(answersOf(sent), ending).toEqual([
          ['a', EnvelopeKind.REQUEST, 2],
          ['a', 'credit', 2, 160],
          ['a', EnvelopeKind.CANCEL, 2],
          ['a', EnvelopeKind.REQUEST, 4],
          ['a', 'credit', 4, 160],
          ['a', EnvelopeKind.CANCEL, 4],
        ]);
      }
    });

    test('refuse a transfer for a subscription’s result, or on a call it never dispatched, before the side hears of it', async () => {
      const told: string[] = [];
      const { port, sent } = createPort({
        beforeAnswer: () => {
          told.push('told');

          return undefined;
        },
      });
      using core = createRouterCore(port, { limits });
      const seen: IRequestResolverProps<Handle>[] = [];

      core.registerResolver(resolverOf(echo, seen));
      core.receive(
        envelopeOf({
          header: {
            callId: 1,
            kind: EnvelopeKind.REQUEST,
            opensSubscription: true,
            procedureId: 1,
            serviceId: 2,
          },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        }),
        'a'
      );

      const subscribing = {
        connectionHandle: 'a',
        header: seen[0]?.header ?? headerOf(1),
      } as const;

      await expect(
        core.respond({ payload: new Uint8Array(41) }, subscribing)
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: "a subscription's result goes in one envelope, of 64 bytes at most",
      });
      await expect(
        core.respond(
          { payload: new Uint8Array(41) },
          { connectionHandle: 'a', header: headerOf(3) }
        )
      ).rejects.toBeInstanceOf(ProgrammerError);
      // in one envelope, it goes
      await core.respond({ payload: new Uint8Array(40) }, subscribing);

      expect(told).toEqual(['told']);
      expect(piecesOf(sent)).toEqual([[EnvelopeKind.RESULT, 1, undefined, 40]]);
    });

    test('announce a session on a result’s opening, which leaves room for it within its envelope', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { control, sent, sizes } = answering;

      control.sessionTokenOf = () => {
        return TOKEN;
      };
      core.receive(requestOf(1), 'a');

      const responding = answerOf(answering, { payload: patternOf(100) });

      core.receive(creditOf(1, 100), 'a');
      await responding;

      expect(sizes).toEqual([64, 64, 36]);
      expect(sent[0]?.envelope?.kind === EnvelopeKind.RESULT && sent[0].envelope.header).toEqual({
        callId: 1,
        kind: EnvelopeKind.RESULT,
        sessionToken: TOKEN,
        total: 100,
      });
    });

    test('refuse a notification too large for one envelope, and send one that fits', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const notificationOf = (length: number): OutgoingEnvelope => {
        return {
          header: { callId: 2, kind: EnvelopeKind.NOTIFICATION },
          kind: EnvelopeKind.NOTIFICATION,
          payload: new Uint8Array(length),
        };
      };

      await expect(core.send(notificationOf(57), 'a')).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'an envelope is 64 bytes at most, not 65',
      });
      await core.send(notificationOf(56), 'a');

      expect(piecesOf(sent)).toEqual([[EnvelopeKind.NOTIFICATION, 2]]);
    });

    test('end the transfers it sends on a connection that goes, and on a router disposed, sending nothing more', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { reported, sent } = answering;
      const asking = settledOf(
        core.request(patternOf(200), { connectionHandle: 'b', options, procedure: echo })
      );

      core.receive(requestOf(1), 'a');

      const responding = settledOf(answerOf(answering, { payload: patternOf(150) }));

      core.rejectPending('gone', 'a');
      core.receive(creditOf(1, 150), 'a');

      expect(await responding).toBeInstanceOf(DisconnectError);

      core[Symbol.dispose]();
      core.receive(creditOf(2, 200), 'b');

      expect(await asking).toBeInstanceOf(DisconnectError);
      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, 200, 44],
        [EnvelopeKind.RESULT, 1, 150, 32],
      ]);
      expect(reported).toEqual([]);
    });
  });

  test.describe('between two cores', () => {
    test('carry a request, its result and a command as transfers, their chunks and credits shuffled and doubled', async () => {
      const small = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 8_192 };
      const ping: IProcedure = { ...echo, procedureId: 2, procedureName: 'ping' };
      const [request, result, command] = [1, 2, 3].map((index) => {
        return patternOf(102_400 + index);
      }) as [Uint8Array, Uint8Array, Uint8Array];
      // one envelope: the command's call ends as soon as it is answered, with copies of its chunks
      // still on their way
      const answer = patternOf(64);

      for (const seed of [undefined, 1, 2, 3, 4, 5]) {
        const loop = createLoopback({ limits: small, seed });
        const heard: string[] = [];

        // each side answers what it is asked with a payload of its own
        loop.server.registerResolver(
          Object.assign((props: IRequestResolverProps<'a'>) => {
            heard.push(`server ${digestOf(props.payload)}`);

            return loop.server.respond({ payload: result }, props);
          }, echo)
        );
        loop.client.registerResolver(
          Object.assign((props: IRequestResolverProps<'server'>) => {
            heard.push(`client ${digestOf(props.payload)}`);

            return loop.client.respond({ payload: answer }, props);
          }, ping)
        );

        const asking = loop.client.request(request, {
          connectionHandle: 'server',
          options,
          procedure: echo,
        });

        await loop.flush();

        const commanding = loop.server.request(command, {
          connectionHandle: 'a',
          options,
          procedure: ping,
        });

        await loop.flush();

        const label = `seed ${String(seed)}`;
        const credits = (sent: number[]) => {
          return sent.filter((kind) => {
            return kind === EnvelopeKind.CREDIT;
          }).length;
        };

        expect(digestOf((await asking).payload), label).toBe(digestOf(result));
        expect(digestOf((await commanding).payload), label).toBe(digestOf(answer));
        // each resolver called once, with every byte
        expect(heard, label).toEqual([
          `server ${digestOf(request)}`,
          `client ${digestOf(command)}`,
        ]);
        expect(Math.max(...loop.sizes), label).toBeLessThanOrEqual(1_024);
        expect(credits(loop.recorded.client.sent), label).toBeGreaterThan(1);
        expect(credits(loop.recorded.server.sent), label).toBeGreaterThan(1);
        // late copies of the chunks and credits are dropped in silence
        expect([loop.recorded.client.reported, loop.recorded.server.reported], label).toEqual([
          [],
          [],
        ]);

        const { delivered, sent } = loop.traffic;
        const orderly = (queued: typeof sent) => {
          return queued.flatMap(({ bytes, isLoose }) => {
            return isLoose ? [] : [bytes];
          });
        };
        // a chunk handed over after one further on in the same call, one way
        const isShuffled = delivered.some(({ bytes, to }, index) => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

          return (
            bytes[1] === EnvelopeKind.CHUNK &&
            delivered.slice(0, index).some((earlier) => {
              const before = new DataView(
                earlier.bytes.buffer,
                earlier.bytes.byteOffset,
                earlier.bytes.byteLength
              );

              return (
                earlier.to === to &&
                earlier.bytes[1] === EnvelopeKind.CHUNK &&
                before.getUint32(4) === view.getUint32(4) &&
                before.getUint32(12) > view.getUint32(12)
              );
            })
          );
        });

        // every other kind in order, and once, whatever the seed
        expect(orderly(delivered), label).toEqual(orderly(sent));
        expect([delivered.length > sent.length, isShuffled], label).toEqual(
          seed === undefined ? [false, false] : [true, true]
        );

        loop.client[Symbol.dispose]();
        loop.server[Symbol.dispose]();
      }
    });
  });
});
