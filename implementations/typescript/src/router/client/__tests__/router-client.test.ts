import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { createWSTransportClient } from '../../../transport/client/ws-transport-client';
import { createEmitter } from '../../../transport/shared/emitter';
import type { ITransportMessage } from '../../../transport/shared/types';
import { bytesOf, readEnvelope } from '../../shared/envelope';
import { toSessionToken } from '../../shared/identifiers';
import { createServiceManager } from '../../shared/service-manager';
import type {
  Announcement,
  CallId,
  DefaultCredential,
  Envelope,
  INotificationLike,
  IProcedure,
  IRequestHeader,
  IRequestResolverProps,
  OutgoingEnvelope,
} from '../../shared/types';
import {
  createTestClock,
  delaysOn,
  timersUntil,
} from '../../../transport/shared/__tests__/fixtures';
import { countedOf, envelopeOf } from '../../shared/__tests__/fixtures';
import {
  CancelError,
  CLIENT_FAILURES,
  createMetricsRegistry,
  createRouterClient,
  CredentialScheme,
  DisconnectError,
  EnvelopeKind,
  FailureError,
  FailureScope,
  LIMIT_DEFAULTS,
  PLATFORM_CLOCK,
  ProgrammerError,
  ProtocolCode,
  SERVER_FAILURES,
  TimeoutError,
  type IClock,
  type IRouterClient,
  type IRouterClientTransportLike,
} from '../router-client';

// helpers

const service: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
const options = { timeout: 1_000 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Text both ways, a notification's too, for a service manager over the router. */
const text = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  decodeNotification: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
};

const TOKEN = toSessionToken(new Uint8Array(16).fill(1));
const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(2));

// what an answer announces: the session, by its token; another; its end
const OPAQUE = Object.freeze({ scheme: CredentialScheme.OPAQUE, token: TOKEN });
const OTHER_OPAQUE = Object.freeze({ scheme: CredentialScheme.OPAQUE, token: OTHER_TOKEN });
const ENDED = Object.freeze({ scheme: CredentialScheme.NONE });

/** A request header of the server's, for procedure 1 of service 2. */
const requestHeaderOf = (callId: number): IRequestHeader => {
  return { callId, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 };
};

const resultOf = (
  callId: number,
  {
    credential,
    payload = new Uint8Array(0),
  }: { credential?: Announcement; payload?: Uint8Array } = {}
): OutgoingEnvelope => {
  return {
    header: {
      callId,
      kind: EnvelopeKind.RESULT,
      ...(credential === undefined ? {} : { credential }),
    },
    kind: EnvelopeKind.RESULT,
    payload,
  };
};

const notificationEnvelopeOf = (callId: number, payload = Uint8Array.of(5)): OutgoingEnvelope => {
  return {
    header: { callId, kind: EnvelopeKind.NOTIFICATION },
    kind: EnvelopeKind.NOTIFICATION,
    payload,
  };
};

/**
 * A transport that records what is sent, read as the server reads it, and the credential carried
 * beside it, delivers what a test gives, and carries a credential, securely, unless told otherwise.
 */
const createScriptedTransport = ({
  carriesCredential = true,
  isSecure = true,
}: { carriesCredential?: boolean; isSecure?: boolean } = {}) => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, wasQuick: boolean];
    message: [message: ITransportMessage];
    reconnect: [];
  }>();
  const sent: (Envelope | undefined)[] = [];
  const carried: (string | undefined)[] = [];
  const control = { sendError: undefined as Error | undefined };

  const transport: IRouterClientTransportLike = {
    carriesCredential,
    isSecure,
    off: emitter.off,
    on: emitter.on,
    send: ({ credential, data }) => {
      carried.push(credential);
      sent.push(
        readEnvelope(bytesOf(data), {
          failures: SERVER_FAILURES,
          maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
        })
      );

      return control.sendError === undefined
        ? Promise.resolve()
        : Promise.reject(control.sendError);
    },
  };

  const deliver = (envelope: OutgoingEnvelope, credential?: string) => {
    emitter.emit('message', { credential, data: envelopeOf(envelope) });
  };

  const close = () => {
    emitter.emit('close', false, false);
  };

  return { carried, close, control, deliver, emitter, sent, transport };
};

// a JWT, which a client presents as it is given, and an ELSEWHERE, with what its transport carries
const JWT = Object.freeze({ scheme: CredentialScheme.JWT, token: 'a.b.c' });
const RENEWED_JWT = Object.freeze({ scheme: CredentialScheme.JWT, token: 'd.e.f' });
const ELSEWHERE = Object.freeze({
  carried: 'Bearer mF_9.B5f-4.1JqM',
  scheme: CredentialScheme.ELSEWHERE,
});

/** The failure the server answers a call with: SESSION_REQUIRED, crossing `relays` relays. */
const sessionRequiredOf = (callId: number, relays = 0): OutgoingEnvelope => {
  return {
    failure: { ...SERVER_FAILURES.sessionRequired, relays },
    header: { callId, kind: EnvelopeKind.FAILURE },
    kind: EnvelopeKind.FAILURE,
  };
};

/** What each request sent presented: its call id, its header's credential, what its transport carried. */
const presentedOf = ({
  carried,
  sent,
}: {
  carried: (string | undefined)[];
  sent: (Envelope | undefined)[];
}) => {
  return sent.map((envelope, index) => {
    return envelope?.kind === EnvelopeKind.REQUEST
      ? [envelope.header.callId, envelope.header.credential, carried[index]]
      : envelope?.kind;
  });
};

const recordErrors = (router: IRouterClient) => {
  const errors: Error[] = [];

  router.on('error', (error) => {
    errors.push(error);
  });

  return errors;
};

const codesOf = (errors: Error[]) => {
  return errors.map((error) => {
    return error instanceof FailureError ? error.code : error.message;
  });
};

const notificationOf = (
  triggered: Uint8Array[],
  procedure: IProcedure = service
): INotificationLike => {
  return {
    ...procedure,
    trigger: (payload) => {
      triggered.push(payload);

      return Promise.resolve([]);
    },
  };
};

// definition

test.describe('createRouterClient', () => {
  test('takes any transport of this package', () => {
    const transport = createWSTransportClient();
    using router = createRouterClient(transport);

    expect(router.transport).toBe(transport);
    expect(router.sessionToken).toBeUndefined();
    expect(router.failures.side).toBe('client');
  });

  test("runs on its transport's clock, or on the one it is given when its transport has none, and refuses one that differs", () => {
    const clock = createTestClock();
    const { transport } = createScriptedTransport();
    using onItsTransport = createRouterClient(createWSTransportClient({ clock }));
    using onItsOwn = createRouterClient(transport, { clock });
    using alone = createRouterClient(transport);

    expect([onItsTransport.clock, onItsOwn.clock, alone.clock]).toEqual([
      clock,
      clock,
      PLATFORM_CLOCK,
    ]);
    expect(() => {
      createRouterClient(createWSTransportClient({ clock }), { clock: PLATFORM_CLOCK });
    }).toThrow(
      new ProgrammerError(
        "a client's router runs on the clock of its transport, one of its own, and was given another, the platform's"
      )
    );
  });

  test.describe('requests', () => {
    test('sends a request on an odd call id and resolves with its result', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const activity: string[] = [];

      router.on('activity', (what) => {
        activity.push(what);
      });

      const answering = router.request(Uint8Array.of(1, 2), { options, procedure: service });

      // the request has been handed over once its send settles
      await sleep(0);

      expect(sent).toEqual([
        { header: requestHeaderOf(1), kind: EnvelopeKind.REQUEST, payload: Uint8Array.of(1, 2) },
      ]);

      deliver(resultOf(1, { payload: Uint8Array.of(9) }));

      const answer = await answering;

      expect(answer).toEqual({
        header: { callId: 1, kind: EnvelopeKind.RESULT },
        payload: Uint8Array.of(9),
      });
      expect(activity).toEqual(['request', 'response']);
    });

    test('numbers its requests 1, 3, …, and pairs each result with its own', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);

      const first = router.request(Uint8Array.of(1), { options, procedure: service });
      const second = router.request(Uint8Array.of(2), { options, procedure: service });

      await Promise.resolve();

      expect(
        sent.map((envelope) => {
          return envelope?.header.callId;
        })
      ).toEqual([1, 3]);

      deliver(resultOf(3, { payload: Uint8Array.of(20) }));
      deliver(resultOf(1, { payload: Uint8Array.of(10) }));

      expect((await first).payload).toEqual(Uint8Array.of(10));
      expect((await second).payload).toEqual(Uint8Array.of(20));
    });

    test('rejects with the failure the server answers, as the server’s', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const refused = router.request(new Uint8Array(0), { options, procedure: service });
      const failed = router.request(new Uint8Array(0), { options, procedure: service });

      deliver({
        failure: { ...SERVER_FAILURES.procedureUnknown, detail: 'no procedure 1 in service 2' },
        header: { callId: 1, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      deliver({
        failure: { code: 21, detail: 'out of range', scope: FailureScope.APPLICATION },
        header: { callId: 3, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });

      await expect(refused).rejects.toBeInstanceOf(FailureError);
      await expect(refused).rejects.toMatchObject({
        code: ProtocolCode.PROCEDURE_UNKNOWN,
        detail: 'no procedure 1 in service 2',
        origin: 'peer',
        side: 'server',
      });
      await expect(failed).rejects.toMatchObject({
        code: 21,
        procedureAddress: { procedureId: 1, serviceId: 2 },
        scope: FailureScope.APPLICATION,
      });
    });

    test('times out and cancels its call; a result too late says nothing while its call id is reserved', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      const clock = createTestClock();
      using router = createRouterClient(transport, { clock });
      const errors = recordErrors(router);
      const failing = router
        .request(new Uint8Array(0), { options: { timeout: 10 }, procedure: service })
        .catch((reason: unknown) => {
          return reason;
        });

      await sleep(0);

      // the call's own, past which it times out
      expect(delaysOn(clock)).toEqual([10]);

      clock.runToLast();

      expect(await failing).toBeInstanceOf(TimeoutError);
      expect(
        sent.map((envelope) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 1],
        [EnvelopeKind.CANCEL, 1],
      ]);

      deliver(resultOf(1));

      expect(errors).toEqual([]);

      // reserved as long as the call was given, then free
      expect(delaysOn(clock)).toEqual([10]);

      clock.runToLast();
      deliver(resultOf(1));

      expect(codesOf(errors)).toEqual([ProtocolCode.CALL_UNKNOWN]);
    });

    test('learns the session from a result’s opening, before the rest of its transfer comes', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const asking = router.request(new Uint8Array(0), { options, procedure: service });

      deliver({
        header: { callId: 1, credential: OPAQUE, kind: EnvelopeKind.RESULT, total: 100 },
        kind: EnvelopeKind.RESULT,
        payload: new Uint8Array(16),
      });

      expect(router.sessionToken).toBe(TOKEN);

      deliver({
        header: { callId: 1, isLast: true, kind: EnvelopeKind.CHUNK, offset: 16 },
        kind: EnvelopeKind.CHUNK,
        payload: new Uint8Array(84),
      });

      await expect(asking).resolves.toMatchObject({ payload: new Uint8Array(100) });
    });

    test('learns the session from every answer, paired or not, keeps it, loses it, and presents it on no call that does not ask for it', async () => {
      const { close, deliver, emitter, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);

      // an answer to nothing still announces
      deliver(resultOf(99, { credential: OPAQUE }));

      expect(router.sessionToken).toBe(TOKEN);
      expect(codesOf(errors)).toEqual([ProtocolCode.CALL_UNKNOWN]);

      const first = router.request(new Uint8Array(0), { options, procedure: service });

      // an answer that says nothing keeps it
      deliver(resultOf(1));
      await first;

      expect(router.sessionToken).toBe(TOKEN);
      expect(sent[0]?.header).toEqual(requestHeaderOf(1));

      const second = router.request(new Uint8Array(0), { options, procedure: service });

      // the end announced loses it
      deliver({
        failure: SERVER_FAILURES.sessionRequired,
        header: { callId: 3, credential: ENDED, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      await expect(second).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });

      expect(router.sessionToken).toBeUndefined();

      deliver(resultOf(98, { credential: OPAQUE }));
      close();

      expect(router.sessionToken).toBeUndefined();

      deliver(resultOf(97, { credential: OPAQUE }));
      emitter.emit('reconnect');

      expect(router.sessionToken).toBeUndefined();
      expect(
        sent.every((envelope) => {
          return envelope !== undefined && !('credential' in envelope.header);
        })
      ).toBe(true);
    });

    test('presents OPAQUE, the session it learned, on a call that asks and on no other; one that asks before any session fails before it goes, SESSION_REQUIRED', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const asking = { ...options, credential: { scheme: CredentialScheme.OPAQUE } } as const;

      await expect(
        router.request(new Uint8Array(0), { options: asking, procedure: service })
      ).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        origin: 'local',
        side: 'client',
      });

      expect(sent).toEqual([]);

      deliver(resultOf(99, { credential: OPAQUE }));

      const calls = [
        router.request(new Uint8Array(0), { options: asking, procedure: service }),
        router.request(new Uint8Array(0), { options, procedure: service }),
      ];

      // a session opened anew is the one presented next
      deliver(resultOf(97, { credential: OTHER_OPAQUE }));
      calls.push(router.request(new Uint8Array(0), { options: asking, procedure: service }));

      for (const callId of [1, 3, 5]) {
        deliver(resultOf(callId));
      }

      await Promise.all(calls);

      expect(
        sent.map((envelope) => {
          return envelope?.kind === EnvelopeKind.REQUEST
            ? [envelope.header.callId, envelope.header.credential]
            : envelope;
        })
      ).toEqual([
        [1, OPAQUE],
        [3, undefined],
        [5, OTHER_OPAQUE],
      ]);
    });

    test('writes the destination a request names, refuses a destination of 0, and writes none left undefined', async () => {
      const { sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);

      void router
        .request(new Uint8Array(0), {
          options: { ...options, destinationId: 7 },
          procedure: service,
        })
        .catch(() => {
          return undefined;
        });
      void router
        .request(new Uint8Array(0), {
          options: { ...options, destinationId: undefined },
          procedure: service,
        })
        .catch(() => {
          return undefined;
        });
      await expect(
        router.request(new Uint8Array(0), {
          options: { ...options, destinationId: 0 },
          procedure: service,
        })
      ).rejects.toBeInstanceOf(ProgrammerError);

      expect(
        sent.map((envelope) => {
          return envelope?.header;
        })
      ).toEqual([{ ...requestHeaderOf(1), destinationId: 7 }, requestHeaderOf(3)]);
    });

    test('rejects every request still waiting, and forgets the session, when a reconnection starts', async () => {
      const { deliver, emitter, transport } = createScriptedTransport();
      using router = createRouterClient(transport);

      const first = router.request(new Uint8Array(0), { options, procedure: service });

      deliver(resultOf(1, { credential: OPAQUE }));
      await first;

      const waiting = router.request(new Uint8Array(0), { options, procedure: service });

      emitter.emit('reconnect');

      await expect(waiting).rejects.toThrow('the connection was replaced before the answer');
      expect(router.sessionToken).toBeUndefined();
    });

    test('rejects every request still waiting when the connection closes', async () => {
      const { close, transport } = createScriptedTransport();
      using router = createRouterClient(transport);

      const waiting = router.request(new Uint8Array(0), { options, procedure: service });

      await Promise.resolve();
      close();

      await expect(waiting).rejects.toBeInstanceOf(DisconnectError);
    });

    test('rejects when the transport cannot send, and when the payload is too large', async () => {
      const { control, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const refused = new Error('not open');

      control.sendError = refused;

      await expect(router.request(new Uint8Array(0), { options, procedure: service })).rejects.toBe(
        refused
      );

      control.sendError = undefined;

      const tooLarge = router.request(new Uint8Array(0x1000001), { options, procedure: service });

      await expect(tooLarge).rejects.toBeInstanceOf(FailureError);
      await expect(tooLarge).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        origin: 'local',
        side: 'client',
      });
      expect(sent).toHaveLength(1);
    });

    test('are held to the limits the router is built with, which must hold together, and show them', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport, { limits: { maximumPayloadBytes: 8 } });
      const heard: string[] = [];

      expect(router.limits).toEqual({ ...LIMIT_DEFAULTS, maximumPayloadBytes: 8 });
      await expect(
        router.request(new Uint8Array(9), {
          onSent: (isHanded) => {
            heard.push(`9 ${String(isHanded)}`);
          },
          options,
          procedure: service,
        })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 8 bytes at most, not 9',
      });
      expect(sent).toEqual([]);

      // what hears the request handed to the transport hears it as it goes, before any answer
      const asking = router.request(new Uint8Array(1), {
        onSent: (isHanded) => {
          heard.push(`1 ${String(isHanded)}`);
        },
        options,
        procedure: service,
      });

      expect(heard).toEqual(['1 true']);
      deliver(resultOf(sent[0]?.header.callId ?? 0));
      await asking;
      expect(() => {
        return createRouterClient(transport, { limits: { chunkBytes: 63 } });
      }).toThrow(ProgrammerError);
    });
  });

  test.describe('credentials', () => {
    test('presents a default JWT on every call that gives none of its own, and hands a default ELSEWHERE’s carried value to its transport with scheme 3 in the block', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const calls = [
        router.request(new Uint8Array(0), { options, procedure: service }),
        router.request(new Uint8Array(0), { options, procedure: service }),
      ];

      router.credential = ELSEWHERE;
      calls.push(router.request(new Uint8Array(0), { options, procedure: service }));

      for (const callId of [1, 3, 5]) {
        scripted.deliver(resultOf(callId));
      }

      await Promise.all(calls);

      expect(presentedOf(scripted)).toEqual([
        [1, JWT, undefined],
        [3, JWT, undefined],
        [5, { scheme: CredentialScheme.ELSEWHERE }, ELSEWHERE.carried],
      ]);
      expect(router.credential).toEqual(ELSEWHERE);
    });

    test('a call’s own credential wins over the default, NONE presents none whatever the default, and OPAQUE presents the session learned', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });

      scripted.deliver(resultOf(99, { credential: OPAQUE }));

      const calls = [
        { scheme: CredentialScheme.NONE },
        { scheme: CredentialScheme.OPAQUE },
        RENEWED_JWT,
        ELSEWHERE,
      ].map((credential) => {
        return router.request(new Uint8Array(0), {
          options: { ...options, credential },
          procedure: service,
        });
      });

      for (const callId of [1, 3, 5, 7]) {
        scripted.deliver(resultOf(callId));
      }

      await Promise.all(calls);

      expect(presentedOf(scripted)).toEqual([
        [1, undefined, undefined],
        [3, OPAQUE, undefined],
        [5, RENEWED_JWT, undefined],
        [7, { scheme: CredentialScheme.ELSEWHERE }, ELSEWHERE.carried],
      ]);
    });

    test('refuses OPAQUE as its default credential, and a JWT under limits that hold no header of 1020 bytes', () => {
      const { transport } = createScriptedTransport();
      const opaque = { scheme: CredentialScheme.OPAQUE } as unknown as typeof JWT;

      expect(() => {
        return createRouterClient(transport, { credential: opaque });
      }).toThrow(ProgrammerError);

      using router = createRouterClient(transport, { credential: JWT });

      for (const refused of [opaque, { scheme: CredentialScheme.NONE }, { scheme: 4 }]) {
        expect(() => {
          router.credential = refused as unknown as typeof JWT;
        }).toThrow(ProgrammerError);
      }

      expect(router.credential).toEqual(JWT);

      // a JWT, presented or verified, needs limits that hold its header
      const limits = { chunkBytes: 1_000, maximumEnvelopeBytes: 1_000, windowBytes: 2_000 };
      const key = {
        algorithm: 'HS256',
        issuer: 'https://issuer.example',
        jwk: { k: 'A'.repeat(43), kty: 'oct' },
      } as const;

      expect(() => {
        return createRouterClient(transport, { credential: JWT, limits });
      }).toThrow(/limits do not hold together/);
      expect(() => {
        return createRouterClient(transport, {
          credentials: { audience: 'https://bead.example', keys: [key] },
          limits,
        });
      }).toThrow(/limits do not hold together/);

      using small = createRouterClient(transport, { credential: ELSEWHERE, limits });

      expect(() => {
        small.credential = JWT;
      }).toThrow(ProgrammerError);
      expect(small.credential).toEqual(ELSEWHERE);
    });

    test('refuses as it is built keys or a key set without an audience', () => {
      const { transport } = createScriptedTransport();
      const key = {
        algorithm: 'HS256',
        issuer: 'https://issuer.example',
        jwk: { k: 'A'.repeat(43), kty: 'oct' },
      } as const;
      const keySet = {
        ask: () => {
          return Promise.resolve([]);
        },
        issuers: ['https://keys.example'],
      };

      for (const credentials of [{ keys: [key] }, { keySet }]) {
        expect(() => {
          return createRouterClient(transport, { credentials });
        }).toThrow(ProgrammerError);

        using router = createRouterClient(transport, {
          credentials: { ...credentials, audience: 'https://bead.example' },
        });

        expect(router.credential).toBeUndefined();
      }
    });

    // spec 13.4
    test('withdraws its default once a call that presented it is refused SESSION_REQUIRED: the next call that would present it fails before it goes, SESSION_REQUIRED, nothing sent, and credentialWithdrawn fires once, its scheme alone', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const withdrawn: unknown[][] = [];

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      const refused = router.request(new Uint8Array(0), { options, procedure: service });
      const alike = router.request(new Uint8Array(0), { options, procedure: service });

      scripted.deliver(sessionRequiredOf(1));
      scripted.deliver(sessionRequiredOf(3));
      await expect(refused).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        mayOvertake: false,
      });
      await expect(alike).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });

      // never to its connection's session, nor to none, in silence: it fails, and withdraws nothing
      await expect(
        router.request(new Uint8Array(0), { options, procedure: service })
      ).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        detail: 'the default credential was withdrawn',
        origin: 'local',
        side: 'client',
      });

      expect(withdrawn).toEqual([[CredentialScheme.JWT]]);
      expect([router.credential, router.isCredentialWithdrawn]).toEqual([undefined, true]);
      expect(presentedOf(scripted)).toEqual([
        [1, JWT, undefined],
        [3, JWT, undefined],
      ]);
    });

    // spec 13.4
    test('after a withdrawal, a call that gives its own credential or NONE goes, and a default given again, or none given, ends the withdrawal', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const withdrawn: unknown[][] = [];

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      expect(router.isCredentialWithdrawn).toBe(false);

      const refused = router.request(new Uint8Array(0), { options, procedure: service });

      scripted.deliver(sessionRequiredOf(1));
      await expect(refused).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
      expect(router.isCredentialWithdrawn).toBe(true);

      // its own credential, or none, given: the renewal goes, and the withdrawal stays
      const calls = [RENEWED_JWT, { scheme: CredentialScheme.NONE }].map((credential) => {
        return router.request(new Uint8Array(0), {
          options: { ...options, credential },
          procedure: service,
        });
      });

      scripted.deliver(resultOf(3));
      scripted.deliver(resultOf(5));
      await Promise.all(calls);
      expect(router.isCredentialWithdrawn).toBe(true);

      // a default given again ends it
      router.credential = RENEWED_JWT;
      expect(router.isCredentialWithdrawn).toBe(false);

      const renewed = router.request(new Uint8Array(0), { options, procedure: service });

      scripted.deliver(resultOf(7));
      await renewed;

      // withdrawn again, then none given, in writing: calls present none, and go
      const refusedAgain = router.request(new Uint8Array(0), { options, procedure: service });

      scripted.deliver(sessionRequiredOf(9));
      await expect(refusedAgain).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
      expect(router.isCredentialWithdrawn).toBe(true);
      router.credential = undefined;
      expect(router.isCredentialWithdrawn).toBe(false);

      const anonymous = router.request(new Uint8Array(0), { options, procedure: service });

      scripted.deliver(resultOf(11));
      await anonymous;

      expect(withdrawn).toEqual([[CredentialScheme.JWT], [CredentialScheme.JWT]]);
      expect(presentedOf(scripted)).toEqual([
        [1, JWT, undefined],
        [3, RENEWED_JWT, undefined],
        [5, undefined, undefined],
        [7, RENEWED_JWT, undefined],
        [9, RENEWED_JWT, undefined],
        [11, undefined, undefined],
      ]);
    });

    test('withdraws its default alike when the refusal crossed a relay', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: ELSEWHERE });
      const withdrawn: unknown[][] = [];

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      const refused = router.request(new Uint8Array(0), {
        options: { ...options, destinationId: 7 },
        procedure: service,
      });

      scripted.deliver(sessionRequiredOf(1, 1));
      await expect(refused).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        origin: 'relayed',
      });

      expect(withdrawn).toEqual([[CredentialScheme.ELSEWHERE]]);
      expect(router.credential).toBeUndefined();
      // the next call that would present it fails alike, before it goes
      await expect(
        router.request(new Uint8Array(0), {
          options: { ...options, destinationId: 7 },
          procedure: service,
        })
      ).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        destinationId: 7,
        origin: 'local',
      });
      expect(scripted.sent).toHaveLength(1);
    });

    test('withdraws nothing, and fires nothing, on the refusal of a call that presented a default since given anew', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const withdrawn: unknown[][] = [];

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      const refused = router.request(new Uint8Array(0), { options, procedure: service });

      // renewed while the call was on its way
      router.credential = RENEWED_JWT;
      scripted.deliver(sessionRequiredOf(1));
      await expect(refused).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });

      expect(withdrawn).toEqual([]);
      expect(router.credential).toEqual(RENEWED_JWT);
    });

    test('withdraws a default set again to the same bytes by a late refusal, and keeps one given other bytes', async () => {
      const cases: [given: DefaultCredential, isKept: boolean][] = [
        [{ scheme: CredentialScheme.JWT, token: JWT.token }, false],
        [RENEWED_JWT, true],
        [{ carried: ELSEWHERE.carried, scheme: CredentialScheme.ELSEWHERE }, false],
        [{ carried: `${ELSEWHERE.carried}, renewed`, scheme: CredentialScheme.ELSEWHERE }, true],
      ];

      for (const [given, isKept] of cases) {
        const scripted = createScriptedTransport();
        const presented = given.scheme === CredentialScheme.JWT ? JWT : ELSEWHERE;
        using router = createRouterClient(scripted.transport, { credential: presented });
        const withdrawn: unknown[][] = [];

        router.on('credentialWithdrawn', (...told) => {
          withdrawn.push(told);
        });

        const refused = router.request(new Uint8Array(0), { options, procedure: service });

        // set again while the call was on its way: a copy, never the object the call presented
        router.credential = given;
        scripted.deliver(sessionRequiredOf(1));
        await expect(refused).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });

        expect(router.credential).toEqual(isKept ? given : undefined);
        expect(withdrawn).toEqual(isKept ? [] : [[given.scheme]]);
      }
    });

    test('withdraws nothing when a call that presented its own credential is refused SESSION_REQUIRED', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const withdrawn: unknown[][] = [];

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      const calls = [RENEWED_JWT, { scheme: CredentialScheme.NONE }].map((credential) => {
        return router.request(new Uint8Array(0), {
          options: { ...options, credential },
          procedure: service,
        });
      });

      scripted.deliver(sessionRequiredOf(1));
      scripted.deliver(sessionRequiredOf(3));

      for (const call of calls) {
        await expect(call).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
      }

      expect(withdrawn).toEqual([]);
      expect(router.credential).toEqual(JWT);
    });

    test('withdraws nothing when SESSION_REQUIRED ends an answered subscription', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const withdrawn: unknown[][] = [];
      const notification = notificationOf([]);

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });
      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      scripted.deliver(resultOf(1));
      await subscribing;
      // the server ended the credential's session, which the application may have ended
      scripted.deliver(sessionRequiredOf(1));

      expect(withdrawn).toEqual([]);
      expect(router.credential).toEqual(JWT);
      expect(router.hasNotification(notification)).toBe(false);
    });

    test('withdraws nothing when SESSION_REQUIRED that ends a subscription overtakes its result, the call failing with it marked', async () => {
      const scripted = createScriptedTransport();
      using router = createRouterClient(scripted.transport, { credential: JWT });
      const errors = recordErrors(router);
      const withdrawn: unknown[][] = [];
      const notification = notificationOf([]);

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });
      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      // the server answered, then ended the subscription; a listen's batch brought the end first
      scripted.emitter.emit('message', {
        data: envelopeOf(sessionRequiredOf(1)),
        mayOvertake: true,
      });
      await expect(subscribing).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        mayOvertake: true,
      });
      scripted.deliver(resultOf(1));

      expect(withdrawn).toEqual([]);
      expect(router.credential).toEqual(JWT);
      expect(codesOf(errors)).toEqual([ProtocolCode.CALL_UNKNOWN]);
    });

    test('fails an ELSEWHERE over a transport that carries none before it goes, DESTINATION_UNREACHABLE: nothing sent, the default kept, no event', async () => {
      const scripted = createScriptedTransport({ carriesCredential: false });
      using router = createRouterClient(scripted.transport, { credential: ELSEWHERE });
      const withdrawn: unknown[][] = [];
      const errors = recordErrors(router);

      router.on('credentialWithdrawn', (...told) => {
        withdrawn.push(told);
      });

      await expect(
        router.request(new Uint8Array(0), { options, procedure: service })
      ).rejects.toMatchObject({
        code: ProtocolCode.DESTINATION_UNREACHABLE,
        origin: 'local',
        side: 'client',
      });

      // a JWT is carried in its block, whatever the transport carries beside it
      const jwt = router.request(new Uint8Array(0), {
        options: { ...options, credential: JWT },
        procedure: service,
      });

      scripted.deliver(resultOf(1));
      await jwt;

      expect(presentedOf(scripted)).toEqual([[1, JWT, undefined]]);
      expect(router.credential).toEqual(ELSEWHERE);
      expect(withdrawn).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('fails a JWT or an ELSEWHERE over a transport not secure before it goes, DESTINATION_UNREACHABLE, where a call presenting none or OPAQUE goes', async () => {
      const scripted = createScriptedTransport({ isSecure: false });
      using router = createRouterClient(scripted.transport, { credential: JWT });

      for (const credential of [undefined, ELSEWHERE]) {
        await expect(
          router.request(new Uint8Array(0), {
            options: { ...options, credential },
            procedure: service,
          })
        ).rejects.toMatchObject({ code: ProtocolCode.DESTINATION_UNREACHABLE, origin: 'local' });
      }

      scripted.deliver(resultOf(99, { credential: OPAQUE }));

      const calls = [{ scheme: CredentialScheme.NONE }, { scheme: CredentialScheme.OPAQUE }].map(
        (credential) => {
          return router.request(new Uint8Array(0), {
            options: { ...options, credential },
            procedure: service,
          });
        }
      );

      scripted.deliver(resultOf(1));
      scripted.deliver(resultOf(3));
      await Promise.all(calls);

      expect(presentedOf(scripted)).toEqual([
        [1, undefined, undefined],
        [3, OPAQUE, undefined],
      ]);
      expect(router.credential).toEqual(JWT);
    });
  });

  test.describe('notifications', () => {
    test('triggers the notification whose subscription opened their call, one ahead of its result included', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const triggered: Uint8Array[] = [];
      const activity: string[] = [];
      const notification = notificationOf(triggered);

      router.on('activity', (what) => {
        activity.push(what);
      });

      await router.registerNotification(notification);

      expect(router.hasNotification(notification)).toBe(true);
      // another of the same procedure is not it
      expect(router.hasNotification(notificationOf([]))).toBe(false);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      await sleep(0);
      // the notification that doubles its result, in the same read: the call is bound already
      deliver(notificationEnvelopeOf(1, Uint8Array.of(5)));
      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1, Uint8Array.of(6)));

      expect(triggered).toEqual([Uint8Array.of(5), Uint8Array.of(6)]);
      expect(activity).toEqual(['request', 'notification', 'response', 'notification']);

      await router.unregisterNotification(notification);

      expect(router.hasNotification(notification)).toBe(false);
    });

    test('a request that subscribes says it opens a subscription, and an ordinary one does not', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const notification = notificationOf([]);

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });
      const ordinary = router.request(new Uint8Array(0), { options, procedure: service });

      await sleep(0);
      deliver(resultOf(1));
      deliver(resultOf(3));
      await Promise.all([subscribing, ordinary]);

      expect(
        sent.map((envelope) => {
          return envelope?.kind === EnvelopeKind.REQUEST
            ? envelope.header.opensSubscription
            : envelope?.kind;
        })
      ).toEqual([true, undefined]);
    });

    test('an ordinary request to the procedure never moves the subscription', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const triggered: Uint8Array[] = [];
      const notification = notificationOf(triggered);

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1));
      await subscribing;

      const ordinary = router.request(new Uint8Array(0), { options, procedure: service });

      deliver(resultOf(3));
      await ordinary;
      deliver(notificationEnvelopeOf(1));

      expect(triggered).toEqual([Uint8Array.of(5)]);
    });

    test('a subscription refused lets go of its call id; one that times out is cancelled, its call id reserved a while', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      const clock = createTestClock();
      using router = createRouterClient(transport, { clock });
      const errors = recordErrors(router);
      const triggered: Uint8Array[] = [];
      const notification = notificationOf(triggered);

      await router.registerNotification(notification);

      const refused = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      deliver({
        failure: SERVER_FAILURES.accessDenied,
        header: { callId: 1, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      await expect(refused).rejects.toMatchObject({ code: ProtocolCode.ACCESS_DENIED });

      const failing = router
        .request(new Uint8Array(0), {
          options: { timeout: 10 },
          procedure: service,
          subscribes: notification,
        })
        .catch((reason: unknown) => {
          return reason;
        });

      await sleep(0);

      // the call's own, past which it times out
      expect(delaysOn(clock)).toEqual([10]);

      clock.runToLast();

      expect(await failing).toBeInstanceOf(TimeoutError);

      deliver(notificationEnvelopeOf(1));
      deliver(notificationEnvelopeOf(3));

      expect(triggered).toEqual([]);
      expect(codesOf(errors)).toEqual([ProtocolCode.SUBSCRIPTION_UNKNOWN]);
      expect(
        sent.map((envelope) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 1],
        [EnvelopeKind.REQUEST, 3],
        [EnvelopeKind.CANCEL, 3],
      ]);
      // reserved as long as the call was given, then free
      expect(delaysOn(clock)).toEqual([10]);

      clock.runToLast();
      deliver(notificationEnvelopeOf(3));

      expect(codesOf(errors)).toEqual([
        ProtocolCode.SUBSCRIPTION_UNKNOWN,
        ProtocolCode.SUBSCRIPTION_UNKNOWN,
      ]);
    });

    test('binds no notification the router does not hold for the procedure', async () => {
      const { sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const held = notificationOf([]);

      await expect(
        router.request(new Uint8Array(0), { options, procedure: service, subscribes: held })
      ).rejects.toBeInstanceOf(ProgrammerError);

      await router.registerNotification(held);

      await expect(
        router.request(new Uint8Array(0), {
          options,
          procedure: service,
          subscribes: notificationOf([]),
        })
      ).rejects.toBeInstanceOf(ProgrammerError);
      await expect(
        router.request(new Uint8Array(0), {
          options,
          procedure: { ...service, procedureId: 9 },
          subscribes: held,
        })
      ).rejects.toBeInstanceOf(ProgrammerError);
      expect(sent).toEqual([]);
    });

    // spec 11.7, 12.9.2 and 12.9.3
    test('keeps the call id of a subscription let go of a while, silent on what comes under it, then reports it', async () => {
      const { deliver, transport } = createScriptedTransport();
      const clock = createTestClock();
      using router = createRouterClient(transport, { clock });
      const errors = recordErrors(router);
      const notification = notificationOf([]);
      const ending: OutgoingEnvelope = {
        failure: SERVER_FAILURES.sessionRequired,
        header: { callId: 1, credential: ENDED, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      };

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options: { timeout: 20 },
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1, { credential: OPAQUE }));
      await subscribing;
      await router.unregisterNotification(notification);

      // on its way when it was let go of: dropped in silence, and so is the failure that ends it,
      // whose end of session is learned all the same
      deliver(notificationEnvelopeOf(1));
      deliver(ending);

      expect(errors).toEqual([]);
      expect(router.sessionToken).toBeUndefined();
      // kept as long as the subscription's call was given
      expect(delaysOn(clock)).toEqual([20]);

      clock.runToLast();
      deliver(notificationEnvelopeOf(1));
      deliver(ending);

      expect(codesOf(errors)).toEqual([
        ProtocolCode.SUBSCRIPTION_UNKNOWN,
        ProtocolCode.CALL_UNKNOWN,
      ]);
    });

    test('a subscription that waits without end, let go of, is cancelled and its call id reserved 5 s, or until the connection closes', async () => {
      const { close, deliver, sent, transport } = createScriptedTransport();
      const clock = createTestClock();
      using router = createRouterClient(transport, { clock });
      const errors = recordErrors(router);
      const notification = notificationOf([]);

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options: { timeout: Infinity },
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1));
      await subscribing;

      const { armed } = await timersUntil(clock, () => {
        return router.unregisterNotification(notification);
      });

      deliver(notificationEnvelopeOf(1));

      expect(
        armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([5_000]);
      expect(errors).toEqual([]);

      close();
      deliver(notificationEnvelopeOf(1));

      expect(codesOf(errors)).toEqual([ProtocolCode.SUBSCRIPTION_UNKNOWN]);
      expect(
        sent.map((envelope) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 1],
        [EnvelopeKind.CANCEL, 1],
      ]);
    });

    test('a notification let go of is cancelled, unless its subscription was taken away already, and only when bound', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const notification = notificationOf([]);
      const subscribe = async (callId: number) => {
        await router.registerNotification(notification);

        const subscribing = router.request(new Uint8Array(0), {
          options,
          procedure: service,
          subscribes: notification,
        });

        deliver(resultOf(callId));
        await subscribing;
      };

      await subscribe(1);
      await router.unregisterNotification(notification);
      await subscribe(3);
      await router.unregisterNotification(notification, { cancel: false });
      // registered but bound to no call, and another's of the same procedure
      await router.registerNotification(notification);
      await router.unregisterNotification(notification);
      await router.unregisterNotification(notificationOf([]));
      // what was on its way to either call id says nothing
      deliver(notificationEnvelopeOf(1));
      deliver(notificationEnvelopeOf(3));

      expect(
        sent.map((envelope) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 1],
        [EnvelopeKind.CANCEL, 1],
        [EnvelopeKind.REQUEST, 3],
      ]);
      expect(errors).toEqual([]);
    });

    test('a second subscription of the same notification cancels the call of the first', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const triggered: Uint8Array[] = [];
      const notification = notificationOf(triggered);

      await router.registerNotification(notification);

      for (const callId of [1, 3]) {
        const subscribing = router.request(new Uint8Array(0), {
          options,
          procedure: service,
          subscribes: notification,
        });

        deliver(resultOf(callId));
        await subscribing;
      }

      deliver(notificationEnvelopeOf(1));
      deliver(notificationEnvelopeOf(3));

      expect(triggered).toEqual([Uint8Array.of(5)]);
      expect(errors).toEqual([]);
      // the server is told before the second goes out, so the second is the one it keeps
      expect(
        sent.map((envelope) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 1],
        [EnvelopeKind.CANCEL, 1],
        [EnvelopeKind.REQUEST, 3],
      ]);
    });

    test('takes away only the notification that asks, not another of its procedure', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const triggered: Uint8Array[] = [];
      const held = notificationOf(triggered);

      await router.registerNotification(held);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: held,
      });

      deliver(resultOf(1));
      await subscribing;
      await router.unregisterNotification(notificationOf([]));
      deliver(notificationEnvelopeOf(1));

      expect(router.hasNotification(held)).toBe(true);
      expect(triggered).toEqual([Uint8Array.of(5)]);
    });

    // spec 11.7 and 12.9.3
    test('reports a notification under no subscription, and one whose callback throws', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const activity: string[] = [];
      const failure = new Error('callback failed');
      const throwing: INotificationLike = {
        ...service,
        trigger: () => {
          throw failure;
        },
      };

      router.on('activity', (what) => {
        activity.push(what);
      });
      deliver(notificationEnvelopeOf(1));
      await router.registerNotification(throwing);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: throwing,
      });

      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1));

      expect(codesOf(errors)).toEqual([ProtocolCode.SUBSCRIPTION_UNKNOWN, 'callback failed']);
      expect((errors[0] as FailureError).detail).toBe('no subscription under call 1');
      // neither is told as activity: the first has no subscription, the second's trigger threw
      expect(activity).not.toContain('notification');
    });

    // spec 12.9.2
    test('a failure after its result ends the subscription: no call unknown, the notification told, the next registration asks anew', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const triggered: Uint8Array[] = [];
      const dropped: (number | undefined)[] = [];
      const notification: INotificationLike = {
        ...notificationOf(triggered),
        drop: (failure) => {
          dropped.push(failure?.code);
        },
      };

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1, { credential: OPAQUE }));
      await subscribing;
      // the session ended: the server ends the subscription, and announces the end
      deliver({
        failure: SERVER_FAILURES.sessionRequired,
        header: { callId: 1, credential: ENDED, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      // one on its way behind it is dropped in silence
      deliver(notificationEnvelopeOf(1));

      expect(errors).toEqual([]);
      // told what ended it
      expect(dropped).toEqual([ProtocolCode.SESSION_REQUIRED]);
      expect(triggered).toEqual([]);
      expect(router.sessionToken).toBeUndefined();
      expect(router.hasNotification(notification)).toBe(false);

      // registered again, it subscribes with a request of its own
      await router.registerNotification(notification);

      const again = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(3));
      await again;
      deliver(notificationEnvelopeOf(3));

      expect(triggered).toEqual([Uint8Array.of(5)]);
      expect(
        sent.map((envelope) => {
          return envelope?.header.callId;
        })
      ).toEqual([1, 3]);

      // a failure on no subscription answers nothing
      deliver({
        failure: SERVER_FAILURES.sessionRequired,
        header: { callId: 9, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });

      expect(codesOf(errors)).toEqual([ProtocolCode.CALL_UNKNOWN]);
    });

    test('a drop that throws when a failure ends its subscription is reported', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const failure = new Error('drop bug');
      const notification: INotificationLike = {
        ...notificationOf([]),
        drop: () => {
          throw failure;
        },
      };

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1));
      await subscribing;
      deliver({
        failure: SERVER_FAILURES.sessionRequired,
        header: { callId: 1, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });

      expect(errors).toEqual([failure]);
    });

    test('refuses a second notification for one procedure', async () => {
      using router = createRouterClient(createScriptedTransport().transport);

      await router.registerNotification(notificationOf([]));

      await expect(router.registerNotification(notificationOf([]))).rejects.toBeInstanceOf(
        ProgrammerError
      );
    });

    test('cannot notify, nor subscribe a connection: only a server does', async () => {
      using router = createRouterClient(createScriptedTransport().transport);

      await expect(router.notify(new Uint8Array(0), { procedure: service })).rejects.toBeInstanceOf(
        ProgrammerError
      );
      expect(() => {
        return router.subscribe({ connectionHandle: 'server', header: requestHeaderOf(2) });
      }).toThrow(ProgrammerError);
    });

    // spec 11.7.3
    test('forgets each notification when its connection closes, is replaced, or it is disposed, and tells it', async () => {
      const { close, deliver, emitter, transport } = createScriptedTransport();
      const router = createRouterClient(transport);
      const errors = recordErrors(router);
      const dropped: string[] = [];
      const named = (procedureName: string): INotificationLike => {
        return {
          ...service,
          drop: () => {
            dropped.push(procedureName);
          },
          procedureName,
          trigger: () => {
            return Promise.resolve([]);
          },
        };
      };

      const closed = named('closed');
      const disposed = named('disposed');

      await router.registerNotification(closed);

      const subscribing = router.request(new Uint8Array(0), {
        options,
        procedure: service,
        subscribes: closed,
      });

      deliver(resultOf(1));
      await subscribing;
      close();

      expect(dropped).toEqual(['closed']);
      expect(router.hasNotification(closed)).toBe(false);

      // nothing is bound any more: what comes under the old call id is reported
      deliver(notificationEnvelopeOf(1));

      expect(codesOf(errors)).toEqual([ProtocolCode.SUBSCRIPTION_UNKNOWN]);

      await router.registerNotification(named('replaced'));
      emitter.emit('reconnect');
      await router.registerNotification(disposed);
      router[Symbol.dispose]();

      expect(dropped).toEqual(['closed', 'replaced', 'disposed']);
      expect(router.hasNotification(disposed)).toBe(false);
    });

    test('clears the timers of its reservations with the connection', async () => {
      const { close, deliver, transport } = createScriptedTransport();
      const clock = createTestClock();
      using router = createRouterClient(transport, { clock });
      const notification = notificationOf([]);

      await router.registerNotification(notification);

      const subscribing = router.request(new Uint8Array(0), {
        options: { timeout: 20 },
        procedure: service,
        subscribes: notification,
      });

      deliver(resultOf(1));
      await subscribing;

      const { armed, cleared } = await timersUntil(clock, async () => {
        await router.unregisterNotification(notification);
        close();
      });

      expect(armed).toHaveLength(1);
      expect(cleared).toContain(armed[0]?.handle);
      expect(clock.countTimers()).toBe(0);
    });

    test('drops every notification though one of them throws, and keeps what a drop registers again', async () => {
      const { close, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const failure = new Error('drop bug');
      const again: INotificationLike = notificationOf([]);

      await router.registerNotification({
        ...service,
        drop: () => {
          throw failure;
        },
        trigger: () => {
          return Promise.resolve([]);
        },
      });
      const reregistering: INotificationLike = {
        ...service,
        drop: () => {
          void router.registerNotification(again);
        },
        procedureId: 7,
        trigger: () => {
          return Promise.resolve([]);
        },
      };

      await router.registerNotification(reregistering);

      close();

      expect(errors).toEqual([failure]);
      expect(router.hasNotification(again)).toBe(true);
      expect(router.hasNotification(reregistering)).toBe(false);
    });
  });

  test.describe('paced subscriptions', () => {
    /**
     * A notification with `window`, whose callbacks settle when the test says: each trigger waits
     * on the next entry of `settle`, and settles as what it is given.
     */
    const createPaced = (window: number | undefined) => {
      const scripted = createScriptedTransport();
      const router = createRouterClient(scripted.transport);
      const errors = recordErrors(router);
      const triggered: number[] = [];
      const settle: ((settled: PromiseSettledResult<unknown>[]) => void)[] = [];
      const notification: INotificationLike = {
        ...service,
        trigger: (payload) => {
          const { promise, resolve } = Promise.withResolvers<PromiseSettledResult<unknown>[]>();

          triggered.push(payload[0] ?? 0);
          settle.push(resolve);

          return promise;
        },
        window,
      };

      const subscribe = async () => {
        await router.registerNotification(notification);

        const subscribing = router.request(new Uint8Array(0), {
          options,
          procedure: service,
          subscribes: notification,
        });

        await sleep(0);

        // wrapped, so awaiting the request waits for its result
        return { subscribing };
      };

      /** The credits sent, as their ends, each saying it counts notifications. */
      const creditsOf = () => {
        return scripted.sent.flatMap((envelope) => {
          if (envelope?.kind !== EnvelopeKind.CREDIT) {
            return [];
          }

          return [envelope.header.paced === true ? envelope.header.creditEnd : undefined];
        });
      };

      /** Settles the callbacks of the notification triggered `index`th, as fulfilled. */
      const done = async (index: number) => {
        settle[index]?.([{ status: 'fulfilled', value: undefined }]);
        await sleep(0);
      };

      return {
        ...scripted,
        creditsOf,
        done,
        errors,
        notification,
        router,
        settle,
        subscribe,
        triggered,
      };
    };

    // spec 11.11
    test('asks for its subscription paced, and credits each notification once its callbacks settled', async () => {
      const { creditsOf, deliver, done, errors, router, sent, subscribe, triggered } =
        createPaced(1);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;

      expect(sent[0]?.header).toMatchObject({ opensSubscription: true, paced: true });
      // the first is credited by asking
      expect(creditsOf()).toEqual([]);

      deliver(notificationEnvelopeOf(1, Uint8Array.of(1)));
      await sleep(0);

      expect(creditsOf()).toEqual([]);

      await done(0);

      expect(creditsOf()).toEqual([2]);

      deliver(notificationEnvelopeOf(1, Uint8Array.of(2)));
      await done(1);

      expect(triggered).toEqual([1, 2]);
      expect(creditsOf()).toEqual([2, 3]);
      expect(errors).toEqual([]);
    });

    // spec 11.11
    test('opens its window once subscribed, and renews it once half a window settled', async () => {
      const { creditsOf, deliver, done, router, subscribe } = createPaced(4);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;

      expect(creditsOf()).toEqual([4]);

      for (const index of [1, 2, 3, 4]) {
        deliver(notificationEnvelopeOf(1, Uint8Array.of(index)));
      }

      await done(0);

      expect(creditsOf()).toEqual([4]);

      await done(1);

      expect(creditsOf()).toEqual([4, 6]);

      // settled out of order, counted all the same
      await done(3);
      await done(2);

      expect(creditsOf()).toEqual([4, 6, 8]);
    });

    // spec 11.11
    test('credits a notification ahead of its result, and its window after, no further than it reaches', async () => {
      const { creditsOf, deliver, done, router, subscribe } = createPaced(2);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(notificationEnvelopeOf(1));
      await done(0);

      expect(creditsOf()).toEqual([3]);

      deliver(resultOf(1));
      await subscribing;

      expect(creditsOf()).toEqual([3]);
    });

    test('counts done a notification whose callback threw or rejected, and reports why', async () => {
      const { creditsOf, deliver, errors, notification, router, settle, subscribe } =
        createPaced(1);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1));
      settle[0]?.([
        { status: 'rejected', reason: new Error('callback failed') },
        { status: 'fulfilled', value: undefined },
        { status: 'rejected', reason: 'no error' },
      ]);
      await sleep(0);

      expect(codesOf(errors)).toEqual(['callback failed', 'no error']);
      expect(creditsOf()).toEqual([2]);

      notification.trigger = () => {
        throw new Error('decoded nothing');
      };
      deliver(notificationEnvelopeOf(1));
      await sleep(0);

      expect(codesOf(errors)).toEqual(['callback failed', 'no error', 'decoded nothing']);
      expect(creditsOf()).toEqual([2, 3]);
    });

    test('credits nothing for a subscription let go of while its callbacks ran', async () => {
      const { creditsOf, deliver, done, notification, router, sent, subscribe } = createPaced(1);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1));
      await router.unregisterNotification(notification);
      await done(0);

      expect(creditsOf()).toEqual([]);
      expect(sent.at(-1)?.kind).toBe(EnvelopeKind.CANCEL);
    });

    test('opens no window for a subscription the server ended in the read of its result', async () => {
      const { creditsOf, deliver, errors, router, subscribe } = createPaced(4);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      deliver({
        failure: SERVER_FAILURES.capacityExceeded,
        header: { callId: 1, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      await subscribing;

      expect(creditsOf()).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('reports a credit that cannot go out', async () => {
      const { control, creditsOf, deliver, done, errors, router, subscribe } = createPaced(1);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1));
      control.sendError = new Error('gone');
      await done(0);

      expect(creditsOf()).toEqual([2]);
      expect(codesOf(errors)).toEqual(['gone']);
    });

    test('credits nothing for a subscription that did not ask, and reports its callbacks’ rejections all the same', async () => {
      const { creditsOf, deliver, errors, router, sent, settle, subscribe } =
        createPaced(undefined);

      using _router = router;

      const { subscribing } = await subscribe();

      deliver(resultOf(1));
      await subscribing;
      deliver(notificationEnvelopeOf(1));
      settle[0]?.([{ status: 'rejected', reason: new Error('callback failed') }]);
      await sleep(0);

      expect(sent[0]?.header).not.toHaveProperty('paced');
      expect(creditsOf()).toEqual([]);
      expect(codesOf(errors)).toEqual(['callback failed']);
    });
  });

  test.describe('the server’s requests', () => {
    test('go to the resolver registered for their procedure, on even call ids, which answers', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const seen: unknown[] = [];

      router.registerResolver(
        Object.assign(async (props: IRequestResolverProps<'server'>) => {
          seen.push({ connectionHandle: props.connectionHandle, payload: props.payload });

          await router.respond({ payload: Uint8Array.of(7) }, props);
        }, service)
      );

      deliver({
        header: requestHeaderOf(30),
        kind: EnvelopeKind.REQUEST,
        payload: Uint8Array.of(3),
      });
      await sleep(0);

      expect(seen).toEqual([{ connectionHandle: 'server', payload: Uint8Array.of(3) }]);
      expect(sent).toEqual([
        {
          header: { callId: 30, kind: EnvelopeKind.RESULT },
          kind: EnvelopeKind.RESULT,
          payload: Uint8Array.of(7),
        },
      ]);
    });

    test('cancelled by the server, abort their resolver’s signal, and are answered by nothing', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const reasons: unknown[] = [];

      router.registerResolver(
        Object.assign((props: IRequestResolverProps<'server'>) => {
          return new Promise<void>((_resolve, reject) => {
            props.signal.addEventListener('abort', () => {
              reasons.push(props.signal.reason);
              // an answer from what hears the signal finds no call to answer
              void router.respond({ payload: Uint8Array.of(1) }, props);
              reject(new Error('stopped'));
            });
          });
        }, service)
      );

      deliver({
        header: requestHeaderOf(30),
        kind: EnvelopeKind.REQUEST,
        payload: Uint8Array.of(3),
      });
      deliver({ header: { callId: 30, kind: EnvelopeKind.CANCEL }, kind: EnvelopeKind.CANCEL });
      await sleep(0);

      expect(reasons).toEqual([expect.any(CancelError)]);
      expect(sent).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('of the client’s own parity are reported, and never answered', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);

      router.registerResolver(
        Object.assign(() => {
          return Promise.resolve();
        }, service)
      );
      deliver({
        header: requestHeaderOf(31),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await sleep(0);

      expect(sent).toEqual([]);
      expect(codesOf(errors)).toEqual([ProtocolCode.ENVELOPE_MALFORMED]);
    });

    test('for a service, a procedure or a destination it does not know are refused with the client’s failures', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);

      deliver({
        header: requestHeaderOf(2),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      router.registerResolver(
        Object.assign(
          () => {
            return Promise.resolve();
          },
          { ...service, procedureId: 9 }
        )
      );
      deliver({
        header: requestHeaderOf(4),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      deliver({
        header: { ...requestHeaderOf(6), destinationId: 5 },
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await sleep(0);

      expect(
        sent.map((envelope) => {
          return envelope?.kind === EnvelopeKind.FAILURE
            ? [envelope.header.callId, envelope.failure.code]
            : envelope;
        })
      ).toEqual([
        [2, ProtocolCode.SERVICE_UNKNOWN],
        [4, ProtocolCode.PROCEDURE_UNKNOWN],
        [6, ProtocolCode.DESTINATION_UNKNOWN],
      ]);
    });

    test('resolve their credential as a server does: none and the session it learned run in it, another token is refused SESSION_REQUIRED, a JWT CREDENTIAL_UNSUPPORTED', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const sessions: unknown[] = [];
      const command = (callId: number, credential?: IRequestHeader['credential']) => {
        deliver({
          header: {
            ...requestHeaderOf(callId),
            ...(credential === undefined ? {} : { credential }),
          },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        });
      };

      router.registerResolver(
        Object.assign(async (props: IRequestResolverProps<'server'>) => {
          sessions.push([props.header.callId, props.session]);

          await router.respond({ payload: new Uint8Array(0) }, props);
        }, service)
      );
      // no session learned: none runs in none, and OPAQUE holds nothing
      command(2);
      command(4, OPAQUE);
      deliver(resultOf(99, { credential: OPAQUE }));
      command(6);
      command(8, OPAQUE);
      command(10, OTHER_OPAQUE);
      command(12, { scheme: CredentialScheme.JWT, token: 'a.b.c' });
      await sleep(0);

      expect(sessions).toEqual([
        [2, undefined],
        [6, { data: undefined }],
        [8, { data: undefined }],
      ]);
      expect(
        sent.flatMap((envelope) => {
          return envelope?.kind === EnvelopeKind.FAILURE
            ? [[envelope.header.callId, envelope.failure.code, envelope.failure.detail]]
            : [];
        })
      ).toEqual([
        [4, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
        [10, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
        [12, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE'],
      ]);
    });

    test('answers a command presenting ELSEWHERE whose transport carried nothing SESSION_REQUIRED, no credential came, and resolves one that carried a value by its verifier', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport, {
        credentials: {
          verify: (carried) => {
            return Promise.resolve({ data: { sub: carried }, id: carried });
          },
        },
      });
      const sessions: unknown[] = [];

      router.registerResolver(
        Object.assign(async (props: IRequestResolverProps<'server'>) => {
          sessions.push([props.header.callId, props.session]);

          await router.respond({ payload: new Uint8Array(0) }, props);
        }, service)
      );

      const elsewhere = {
        ...requestHeaderOf(2),
        credential: { scheme: CredentialScheme.ELSEWHERE },
      };

      deliver({ header: elsewhere, kind: EnvelopeKind.REQUEST, payload: new Uint8Array(0) });
      deliver(
        {
          header: { ...elsewhere, callId: 4 },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        },
        'ada'
      );
      await sleep(0);

      expect(sessions).toEqual([
        [
          4,
          {
            data: { sub: 'ada' },
            end: undefined,
            identifier: { id: 'ada', scheme: CredentialScheme.ELSEWHERE },
          },
        ],
      ]);
      expect(
        sent.flatMap((envelope) => {
          return envelope?.kind === EnvelopeKind.FAILURE
            ? [[envelope.header.callId, envelope.failure.code, envelope.failure.detail]]
            : [];
        })
      ).toEqual([[2, ProtocolCode.SESSION_REQUIRED, 'no credential came']]);
    });

    test('answers a command that presented a credential, whose admission refuses SESSION_REQUIRED, ACCESS_DENIED, as a server does', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport, {
        credentials: {
          verify: (carried) => {
            return Promise.resolve({ data: { sub: carried }, id: carried });
          },
        },
      });
      const errors = recordErrors(router);

      // registered raw, its admission refusing every command, the credential held or none
      router.registerResolver(
        Object.assign(
          () => {
            return Promise.resolve();
          },
          service,
          {
            admit: () => {
              return { ...CLIENT_FAILURES.sessionRequired, detail: 'sign in first' };
            },
          }
        )
      );
      deliver(
        {
          header: { ...requestHeaderOf(2), credential: { scheme: CredentialScheme.ELSEWHERE } },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        },
        'ada'
      );
      deliver({
        header: requestHeaderOf(4),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await expect
        .poll(() => {
          return sent.length;
        })
        .toBe(2);

      expect(
        sent
          .flatMap((envelope) => {
            return envelope?.kind === EnvelopeKind.FAILURE
              ? [[envelope.header.callId, envelope.failure.code, envelope.failure.detail]]
              : [];
          })
          .toSorted(([a], [b]) => {
            return Number(a) - Number(b);
          })
      ).toEqual([
        [2, ProtocolCode.ACCESS_DENIED, 'sign in first'],
        [4, ProtocolCode.SESSION_REQUIRED, 'sign in first'],
      ]);
      expect(errors).toEqual([]);
    });

    test('reports a resolver that rejects, and an answer the transport cannot send', async () => {
      const { control, deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const failure = new Error('resolver failed');

      router.registerResolver(
        Object.assign(() => {
          return Promise.reject(failure);
        }, service)
      );
      deliver({
        header: requestHeaderOf(2),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await sleep(0);

      control.sendError = new Error('not open');
      deliver({
        header: requestHeaderOf(4),
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await sleep(0);
      deliver({
        header: { ...requestHeaderOf(6), serviceId: 99 },
        kind: EnvelopeKind.REQUEST,
        payload: new Uint8Array(0),
      });
      await sleep(0);

      // call 2 reported and answered; call 4 reported, its answer refused by the transport and
      // reported; call 6's refusal refused and reported
      expect(errors).toEqual([failure, failure, control.sendError, control.sendError]);
      expect(
        sent.map((envelope) => {
          return envelope?.kind === EnvelopeKind.FAILURE
            ? [envelope.header.callId, envelope.failure.code]
            : envelope?.kind;
        })
      ).toEqual([
        [2, ProtocolCode.PROCEDURE_FAILED],
        [4, ProtocolCode.PROCEDURE_FAILED],
        [6, ProtocolCode.SERVICE_UNKNOWN],
      ]);
    });

    test('reports a resolver that throws before it returns, and keeps taking envelopes', () => {
      const { deliver, emitter, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const failure = new Error('thrown at once');

      router.registerResolver(
        Object.assign(() => {
          throw failure;
        }, service)
      );

      expect(() => {
        deliver({
          header: requestHeaderOf(2),
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        });
      }).not.toThrow();
      emitter.emit('message', { data: Uint8Array.of(0xa1, 0x17, 0, 2, 0, 0, 0, 2) });

      expect(errors[0]).toBe(failure);
      expect(codesOf(errors)).toEqual(['thrown at once', ProtocolCode.KIND_UNSUPPORTED]);
    });

    test('refuses a second resolver for one procedure', () => {
      using router = createRouterClient(createScriptedTransport().transport);

      router.registerResolver(
        Object.assign(() => {
          return Promise.resolve();
        }, service)
      );

      expect(() => {
        router.registerResolver(
          Object.assign(() => {
            return Promise.resolve();
          }, service)
        );
      }).toThrow(ProgrammerError);
    });
  });

  test.describe('what it cannot handle', () => {
    test('reports bytes that are not an envelope, and an envelope of a kind it does not take', () => {
      const { emitter, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);

      emitter.emit('message', { data: 'text' });
      emitter.emit('message', { data: Uint8Array.of(0x0a, 0x14) });
      emitter.emit('message', { data: Uint8Array.of(0xa1, 0x17, 0, 2, 0, 0, 0, 2) });

      expect(codesOf(errors)).toEqual([
        ProtocolCode.ENVELOPE_MALFORMED,
        ProtocolCode.ENVELOPE_MALFORMED,
        ProtocolCode.KIND_UNSUPPORTED,
      ]);
      expect((errors[0] as FailureError).detail).toContain('not a string');
    });
  });

  test.describe('debug', () => {
    // debugging 5.1
    test('tells each envelope out and in, with its connection, server, a copy of its header, and never its session token', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const seen: unknown[] = [];

      router.on('debug', ({ connectionHandle, direction, header }) => {
        seen.push([connectionHandle, direction, { ...header }]);
        header.callId = 99;
      });

      const answering = router.request(new Uint8Array(0), { options, procedure: service });

      deliver(resultOf(1, { credential: OPAQUE }));

      expect((await answering).header.callId).toBe(1);
      expect(seen).toEqual([
        ['server', 'tx', requestHeaderOf(1)],
        [
          'server',
          'rx',
          { callId: 1, credentialScheme: CredentialScheme.OPAQUE, kind: EnvelopeKind.RESULT },
        ],
      ]);
      expect(JSON.stringify(seen)).not.toContain(TOKEN);
    });

    // debugging 2.2 and 2.3
    test('a debug listener that throws on an envelope is reported, and the envelope and its call go on, every listener told', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const failure = new Error('listener bug');
      const heard: string[] = [];

      router.on('debug', () => {
        throw failure;
      });
      router.on('debug', ({ direction }) => {
        heard.push(direction);
      });

      const answering = router.request(new Uint8Array(0), { options, procedure: service });

      deliver(resultOf(1));

      await expect(answering).resolves.toMatchObject({ header: { callId: 1 } });
      expect(sent).toHaveLength(1);
      expect(heard).toEqual(['tx', 'rx']);
      expect(errors).toEqual([failure, failure]);
    });

    // debugging 4.4
    test('tells a call’s steps with the call id its REQUEST carries', async () => {
      const { deliver, transport } = createScriptedTransport();
      // a payload past 1,000 bytes goes as a transfer
      using router = createRouterClient(transport, {
        limits: { chunkBytes: 1_000, maximumEnvelopeBytes: 1_000, windowBytes: 2_000 },
      });
      const services = createServiceManager(router);
      const asking = services.getRequest(service, { serializer: text });
      const envelopes: unknown[] = [];
      const steps: unknown[] = [];

      router.on('debug', ({ direction, header }) => {
        envelopes.push([direction, header.kind, header.callId, 'total' in header]);
      });
      services.on('debug', (_error, { callId, direction }) => {
        steps.push([direction, callId]);
      });

      const whole = asking('a')(options);

      deliver(resultOf(1, { payload: text.encode('b') }));
      await expect(whole).resolves.toBe('b');

      // its opening carries its call id as a whole request does; the server refuses it there
      const opening = asking('x'.repeat(3_000))(options);

      deliver(sessionRequiredOf(3));
      await expect(opening).rejects.toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });

      // * each trace in its own order: no order between a step and its envelope
      expect(envelopes).toEqual([
        ['tx', EnvelopeKind.REQUEST, 1, false],
        ['rx', EnvelopeKind.RESULT, 1, false],
        ['tx', EnvelopeKind.REQUEST, 3, true],
        ['rx', EnvelopeKind.FAILURE, 3, false],
      ]);
      expect(steps).toEqual([
        ['tx', 1],
        ['rx', 1],
        ['tx', 3],
        ['rx', 3],
      ]);
    });

    // debugging 4.4
    test('two calls to one procedure started in one millisecond and answered in one batch name each its own call id', async () => {
      const start = Date.UTC(2026, 0, 1);
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport, { clock: createTestClock(start) });
      const services = createServiceManager(router);
      const asking = services.getRequest(service, { serializer: text });
      const steps: [
        direction: string,
        callId: CallId | undefined,
        startedAt: number,
        seen: unknown,
      ][] = [];

      services.on('debug', (_error, { callId, direction, rx, startedAt, tx }) => {
        steps.push([direction, callId, startedAt, direction === 'tx' ? tx : rx]);
      });

      const first = asking('a')(options);
      const second = asking('b')(options);

      // one batch, in one turn, the second call's answer first
      deliver(resultOf(3, { payload: text.encode('answers b') }));
      deliver(resultOf(1, { payload: text.encode('answers a') }));

      await expect(Promise.all([first, second])).resolves.toEqual(['answers a', 'answers b']);
      expect(
        steps.filter(([direction]) => {
          return direction === 'tx';
        })
      ).toEqual([
        ['tx', 1, start, 'a'],
        ['tx', 3, start, 'b'],
      ]);
      expect(
        steps
          .filter(([direction]) => {
            return direction === 'rx';
          })
          .toSorted(([, one = 0], [, other = 0]) => {
            return one - other;
          })
      ).toEqual([
        ['rx', 1, start, 'answers a'],
        ['rx', 3, start, 'answers b'],
      ]);
    });

    // debugging 4.4
    test('a subscribing call binds its subscription before debug hears its tx step', async () => {
      const { deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport);
      const errors = recordErrors(router);
      const services = createServiceManager(router);
      const notification = services.getNotification(service, { serializer: text });
      const heard: string[] = [];

      // a notification right behind its result, delivered as the tx step is told
      services.on('debug', (_error, { callId, direction, type }) => {
        if (direction === 'tx' && type === 'request' && callId !== undefined) {
          deliver(notificationEnvelopeOf(callId, text.encode('first news')));
        }
      });

      const registering = notification('subscribe', (news) => {
        heard.push(news);
      })(options);

      await sleep(0);
      deliver(resultOf(1));
      await registering;

      expect(heard).toEqual(['first news']);
      expect(errors).toEqual([]);
    });
  });

  test.describe('metrics', () => {
    // a line of echo's series among the calls a client makes, requests, by the rest of its name, its
    // labels and its value
    const made = (rest: string): string => {
      const labels = 'service="2",procedure="echo",type="request"';

      return `bead_client_call_${rest.replace('{}', `{${labels}}`).replace('{outcome', `{${labels},outcome`)}`;
    };

    // debugging 9.3, 9.6.1 and 9.6.2
    test('counts a call refused before it goes, SESSION_REQUIRED or DESTINATION_UNREACHABLE, as started and ended in the turn it started, and a programmer’s error or an aborted signal as nothing', async () => {
      const metricsRegistry = createMetricsRegistry();
      const { transport } = createScriptedTransport({ carriesCredential: false });
      using router = createRouterClient(transport, { clock: createTestClock(), metricsRegistry });
      const series = router.declareRequester(service);
      const ask = (
        asked: {
          options?: Parameters<typeof router.request>[1]['options'];
          subscribes?: INotificationLike;
        } = {}
      ) => {
        return router
          .request(new Uint8Array(0), { options, procedure: service, series, ...asked })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      // OPAQUE with no session known, and an ELSEWHERE its transport cannot carry
      const noSession = ask({
        options: { ...options, credential: { scheme: CredentialScheme.OPAQUE } },
      });
      const uncarried = ask({ options: { ...options, credential: ELSEWHERE } });

      expect(countedOf(metricsRegistry)).toEqual([
        made('duration_seconds_count{} 2'),
        made('handled_total{outcome="failure",code="DESTINATION_UNREACHABLE"} 1'),
        made('handled_total{outcome="failure",code="SESSION_REQUIRED"} 1'),
        made('started_total{} 2'),
      ]);

      // a programmer's error, and a signal aborted already: neither is a call
      const refused = await Promise.all([
        ask({ subscribes: notificationOf([]) }),
        ask({ options: { ...options, credential: { scheme: CredentialScheme.JWT, token: '' } } }),
        ask({ options: { ...options, timeout: 0 } }),
        ask({ options: { ...options, signal: AbortSignal.abort() } }),
      ]);

      expect(
        refused.map((reason) => {
          return (reason as Error).name;
        })
      ).toEqual(['ProgrammerError', 'ProgrammerError', 'ProgrammerError', 'CancelError']);
      expect(countedOf(metricsRegistry)).toContain(made('started_total{} 2'));
      expect(
        (await Promise.all([noSession, uncarried])).map((reason) => {
          return (reason as FailureError).code;
        })
      ).toEqual([ProtocolCode.SESSION_REQUIRED, ProtocolCode.DESTINATION_UNREACHABLE]);
    });

    // debugging 9.6.11
    test('counts a call its caller cancels as cancelled, and one its transport refuses as an error', async () => {
      const metricsRegistry = createMetricsRegistry();
      const { control, transport } = createScriptedTransport();
      using router = createRouterClient(transport, { clock: createTestClock(), metricsRegistry });
      const series = router.declareRequester(service);
      const controller = new AbortController();
      const cancelled = router.request(new Uint8Array(0), {
        options: { ...options, signal: controller.signal },
        procedure: service,
        series,
      });

      controller.abort();

      await expect(cancelled).rejects.toBeInstanceOf(CancelError);

      control.sendError = new Error('this transport refuses');

      await expect(
        router.request(new Uint8Array(0), { options, procedure: service, series })
      ).rejects.toThrow('this transport refuses');
      expect(countedOf(metricsRegistry)).toEqual([
        made('duration_seconds_count{} 2'),
        made('handled_total{outcome="cancelled"} 1'),
        made('handled_total{outcome="error"} 1'),
        made('started_total{} 2'),
      ]);
    });

    // debugging 9.1.6, 10.2 and 10.3.3
    test('counts a notification heard under a subscription it holds, and a subscription dropped at this end by the failure that ends it or with its connection, never by its own cancel', async () => {
      const metricsRegistry = createMetricsRegistry();
      const { close, deliver, transport } = createScriptedTransport();
      using router = createRouterClient(transport, { clock: createTestClock(), metricsRegistry });
      const errors = recordErrors(router);
      const news = notificationOf([]);
      // subscribed under `callId`, once its answer came
      const subscribe = async (callId: number): Promise<void> => {
        await router.registerNotification(news);

        const subscribing = router.request(new Uint8Array(0), {
          options,
          procedure: service,
          subscribes: news,
        });

        deliver(resultOf(callId));
        await subscribing;
      };

      await subscribe(1);
      deliver(notificationEnvelopeOf(1));
      // under no subscription: reported, and not heard
      deliver(notificationEnvelopeOf(9));
      deliver({
        failure: { code: ProtocolCode.SESSION_REQUIRED, scope: FailureScope.PROTOCOL },
        header: { callId: 1, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });
      await subscribe(3);
      await router.unregisterNotification(news);
      await subscribe(5);
      close();

      expect(codesOf(errors)).toEqual([ProtocolCode.SUBSCRIPTION_UNKNOWN]);
      expect(
        countedOf(metricsRegistry).filter((line) => {
          return line.startsWith('bead_notifications') || line.startsWith('bead_subscriptions');
        })
      ).toEqual([
        'bead_notifications_heard_total{service="2",procedure="echo"} 1',
        'bead_subscriptions_dropped_total{service="2",procedure="echo"} 1',
        'bead_subscriptions_dropped_total{service="2",procedure="echo",code="SESSION_REQUIRED"} 1',
      ]);
    });

    test('observes a call on a clock whose monotonic reading moves by 100 µs, as a browser’s does, as 0 or 100 µs', async () => {
      const metricsRegistry = createMetricsRegistry();
      const clock = createTestClock();
      const read: Pick<IClock, 'performance'> = clock;
      const fine = read.performance.now.bind(read.performance);
      const { deliver, transport } = createScriptedTransport();

      // coarsened as W3C High Resolution Time coarsens a browser's reading
      read.performance.now = () => {
        return Math.floor(fine() * 10) / 10;
      };

      using router = createRouterClient(transport, { clock, metricsRegistry });
      const series = router.declareRequester(service);
      // a call of 30 µs, from where the clock is now
      const callOf30 = async (callId: number): Promise<void> => {
        const answering = router.request(new Uint8Array(0), {
          options,
          procedure: service,
          series,
        });

        await clock.tickAsync(0.03);
        deliver(resultOf(callId));
        await answering;
      };

      // within one step of the reading, then across one
      await callOf30(1);
      await clock.tickAsync(0.05);
      await callOf30(3);

      expect(countedOf(metricsRegistry)).toEqual([
        made('duration_seconds_sum{} 0.0001'),
        made('duration_seconds_count{} 2'),
        made('handled_total{outcome="result"} 2'),
        made('started_total{} 2'),
      ]);
      // the bucket of 0 holds the first, and the bucket of 100 µs, 0.0001, both
      const bucketOf = (le: string, count: number): string => {
        return `bead_client_call_duration_seconds_bucket{service="2",procedure="echo",type="request",le="${le}"} ${String(count)}`;
      };

      expect(
        metricsRegistry
          .exposition()
          .text.split('\n')
          .filter((line) => {
            return line.startsWith('bead_client_call_duration_seconds_bucket{service="2"');
          })
          .slice(0, 5)
      ).toEqual([
        bucketOf('0.0', 1),
        bucketOf('1e-05', 1),
        bucketOf('5e-05', 1),
        bucketOf('0.0001', 2),
        bucketOf('0.0003', 2),
      ]);
    });
  });

  test('dispose lets go of the transport, rejects what still waits, and sends nothing more', async () => {
    const { deliver, emitter, sent, transport } = createScriptedTransport();
    const router = createRouterClient(transport);
    const errors = recordErrors(router);

    const waiting = router.request(new Uint8Array(0), { options, procedure: service });

    await sleep(0);
    router[Symbol.dispose]();
    sent.length = 0;
    deliver(resultOf(1));

    await expect(waiting).rejects.toBeInstanceOf(DisconnectError);
    await expect(
      router.request(new Uint8Array(0), { options, procedure: service })
    ).rejects.toBeInstanceOf(DisconnectError);
    await expect(
      router.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'server', header: requestHeaderOf(2) }
      )
    ).rejects.toBeInstanceOf(DisconnectError);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
    expect(
      (['close', 'message', 'reconnect'] as const).map((event) => {
        return emitter.listenerCount(event);
      })
    ).toEqual([0, 0, 0]);
  });
});
