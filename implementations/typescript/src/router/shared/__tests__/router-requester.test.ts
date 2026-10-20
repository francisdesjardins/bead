import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  createTestClock,
  hasRef,
  timersBy,
  timersUntil,
} from '../../../transport/shared/__tests__/fixtures';
import { CancelError, ProgrammerError, TimeoutError } from '../../../transport/shared/errors';
import { noop } from '../../../transport/shared/noop';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { readEnvelope } from '../envelope';
import { presentedCredentialOf, uncarriedOf } from '../call-session';
import { DisconnectError, FailureError } from '../errors';
import { createMetricsRegistry } from '../metrics-registry';
import { createPayloadPlacement } from '../payload-placement';
import { createReceivingTransfers } from '../receiving-transfers';
import { createRouterCore } from '../router-core';
import { limitsOf } from '../router-limits';
import { createRouterRequester } from '../router-requester';
import { createRouterWriter } from '../router-writer';
import { createSendingTransfers } from '../sending-transfers';
import type {
  IFailure,
  IRequestResolverProps,
  IRouterCore,
  RequestCredential,
  SessionToken,
} from '../types';
import { countedOf, envelopeOf, patternOf } from './fixtures';
import {
  type Handle,
  OPAQUE,
  TOKEN,
  answerOf,
  answersOf,
  cancelOf,
  chunkOf,
  codesOf,
  createPort,
  creditOf,
  echo,
  fromHexadecimal,
  headerOf,
  limits,
  lineOf,
  narrow,
  options,
  payloadOf,
  piecesOf,
  requestOf,
  resolverOf,
  resultOf,
  resultOpeningOf,
  settledOf,
} from './router-core-fixtures';

// definition

test.describe('createRouterCore', () => {
  test.describe("a request's credential", () => {
    test('this side presents is the one its side resolved, and one that leaves a transfer’s opening no byte fails it before it goes, PAYLOAD_TOO_LARGE', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits });
      // 8 bytes of prefix, 4 of service and procedure, 8 of total, 4 of the block's head: 36 of
      // token leave 4 bytes of a 64-byte opening, and 40 none
      const tokenOf = (length: number) => {
        return { scheme: CredentialScheme.JWT, token: 'x'.repeat(length) };
      };

      const answering = core.request(patternOf(100), {
        connectionHandle: 'a',
        credential: tokenOf(36),
        options,
        procedure: echo,
      });

      await expect(
        core.request(patternOf(100), {
          connectionHandle: 'a',
          credential: tokenOf(40),
          options,
          procedure: echo,
        })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail:
          "a payload of 100 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64",
        origin: 'local',
        procedureAddress: { procedureId: 1, serviceId: 2 },
      });
      // a header that leaves the payload room goes whole, whatever its credential
      const whole = core.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        credential: OPAQUE,
        options,
        procedure: echo,
      });

      expect(
        sent.map(({ envelope }) => {
          return envelope?.kind === EnvelopeKind.REQUEST
            ? [envelope.header.callId, envelope.header.credential, envelope.payload.length]
            : envelope?.kind;
        })
      ).toEqual([
        [2, tokenOf(36), 4],
        [6, OPAQUE, 1],
      ]);

      core.rejectPending('done', 'a');
      await Promise.allSettled([answering, whole]);

      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port, { limits });
      let known: SessionToken | undefined = undefined;
      const ask = (payload: Uint8Array, requested?: RequestCredential) => {
        try {
          const presented = presentedCredentialOf(requested, {
            failures: CLIENT_FAILURES,
            token: known,
          });
          return clientCore.request(payload, {
            connectionHandle: 'a',
            options: { timeout: 5_000 },
            procedure: echo,
            credential: presented.credential,
            transportCredential: presented.carried,
          });
        } catch (reason) {
          return clientCore.request(payload, {
            connectionHandle: 'a',
            options: { timeout: 5_000 },
            procedure: echo,
            refusal: reason as Error,
          });
        }
      };
      await expect(
        ask(Uint8Array.of(1), { scheme: CredentialScheme.OPAQUE })
      ).rejects.toMatchObject({
        code: ProtocolCode.SESSION_REQUIRED,
        origin: 'local',
        side: 'client',
      });
      expect(client.sent).toEqual([]);
      known = TOKEN;
      const calls = [
        settledOf(ask(Uint8Array.of(1), { scheme: CredentialScheme.OPAQUE })),
        settledOf(ask(Uint8Array.of(1), { scheme: CredentialScheme.NONE })),
        settledOf(ask(Uint8Array.of(1))),
        settledOf(ask(Uint8Array.of(1), { scheme: CredentialScheme.JWT, token: 'a.b.c' })),
        settledOf(ask(patternOf(8), { scheme: CredentialScheme.JWT, token: 'a'.repeat(40) })),
      ];
      await expect(
        ask(patternOf(9), { scheme: CredentialScheme.JWT, token: 'a'.repeat(40) })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail:
          "a payload of 9 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64",
        origin: 'local',
        side: 'client',
        header: { credentialScheme: CredentialScheme.JWT },
      });
      expect(
        client.sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { ...headerOf(1), credential: OPAQUE },
        headerOf(3),
        headerOf(5),
        { ...headerOf(7), credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' } },
        { ...headerOf(9), credential: { scheme: CredentialScheme.JWT, token: 'a'.repeat(40) } },
      ]);
      clientCore.rejectPending('done', 'a');
      await Promise.all(calls);
    });

    test('a JWT its header holds whole fails its call before it goes, PAYLOAD_TOO_LARGE, once a transfer’s header would pass 1,020 bytes, and goes as a transfer a word shorter', async () => {
      const { port, sent } = createPort({ failures: CLIENT_FAILURES });
      // the default limits: a payload of 1 MiB passes an envelope of chunkBytes whole
      using core = createRouterCore(port);
      const payload = patternOf(1_048_576);
      const ask = (
        length: number,
        {
          destinationId,
          given = payload,
        }: {
          destinationId?: number | undefined;
          given?: Uint8Array;
        } = {}
      ) => {
        return core.request(given, {
          connectionHandle: 'a',
          credential: { scheme: CredentialScheme.JWT, token: 'x'.repeat(length) },
          options: { ...options, destinationId },
          procedure: echo,
        });
      };
      const going: Promise<unknown>[] = [];

      // 12 bytes of header, 4 of destination, 8 of total, 4 of the credential's head, its token
      // padded to 4: an opening's header holds 996 bytes of token, 992 beside a destination
      for (const [length, destinationId, opening] of [
        [1_004, undefined, 1_028],
        [997, undefined, 1_024],
        [1_000, 7, 1_028],
        [993, 7, 1_024],
      ] as const) {
        await expect(ask(length, { destinationId }), String(length)).rejects.toMatchObject({
          code: ProtocolCode.PAYLOAD_TOO_LARGE,
          detail: `a payload of 1048576 bytes goes as a transfer, whose opening's header of ${String(opening)} bytes passes 1020`,
          origin: 'local',
          side: 'client',
        });
      }

      expect(sent).toEqual([]);

      going.push(ask(996), ask(992, { destinationId: 7 }), ask(1_004, { given: Uint8Array.of(1) }));

      expect(
        sent.map(({ envelope }) => {
          const credential =
            envelope?.kind === EnvelopeKind.REQUEST ? envelope.header.credential : undefined;

          return envelope?.kind === EnvelopeKind.REQUEST
            ? [
                credential !== undefined && 'token' in credential
                  ? credential.token.length
                  : undefined,
                envelope.header.destinationId,
                envelope.header.total,
                envelope.payload.length,
              ]
            : envelope?.kind;
        })
      ).toEqual([
        [996, undefined, 1_048_576, 1_047_556],
        [992, 7, 1_048_576, 1_047_556],
        // a payload its header leaves room for goes whole
        [1_004, undefined, undefined, 1],
      ]);

      core.rejectPending('done', 'a');
      await Promise.allSettled(going);
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

      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port);
      client.control.sessionTokenOf = () => {
        throw new Error('a request asks no session');
      };
      const heard: string[] = [];
      const asked = clientCore.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: echo,
        onCallId: (callId) => {
          heard.push(`call id ${String(callId)}`);
          expect(client.sent).toEqual([]);
        },
      });
      expect(heard).toEqual(['call id 1']);
      expect(client.sent).toEqual([
        {
          connectionHandle: 'a',
          envelope: { kind: EnvelopeKind.REQUEST, header: headerOf(1), payload: Uint8Array.of(1) },
        },
      ]);
      expect(client.traced).toEqual(['tx 10 1 a']);
      await sleep(0);
      expect(client.activities).toEqual(['request a']);
      clientCore.receive(resultOf(1, Uint8Array.of(1)), 'a');
      expect(await asked).toEqual({
        header: { callId: 1, kind: EnvelopeKind.RESULT },
        payload: Uint8Array.of(1),
      });
      expect(client.activities).toEqual(['request a', 'response a']);
      expect(client.reported).toEqual([]);
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
      let isSettled = false;
      void answering.then(() => {
        isSettled = true;
      });
      await sleep(0);
      expect(isSettled).toBe(false);
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

      const clientOffered: number[] = [];
      const client = createPort({
        failures: CLIENT_FAILURES,
        onUnpairedFailure: ({ failure, header }) => {
          clientOffered.push(header.callId, failure.code);
          return true;
        },
      });
      using clientCore = createRouterCore(client.port);
      clientCore.receive(
        envelopeOf({
          kind: EnvelopeKind.FAILURE,
          header: { kind: EnvelopeKind.FAILURE, callId: 7 },
          failure: { code: 9, scope: FailureScope.APPLICATION },
        }),
        'a'
      );
      expect(client.reported).toEqual([]);
      clientCore.receive(resultOf(7, Uint8Array.of(1)), 'a');
      expect(clientOffered).toEqual([7, 9]);
      expect(codesOf(client.reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
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

      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port);
      const asked = clientCore.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: { ...echo, maximumPayloadBytes: 100 },
      });
      clientCore.receive(resultOpeningOf(1, { payload: patternOf(32), total: 300 }), 'a');
      await expect(asked).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 100 bytes at most, not 300',
        origin: 'local',
        side: 'client',
      });
      expect(answersOf(client.sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 1],
        ['a', EnvelopeKind.CANCEL, 1],
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

    test('fails before it goes a call past the calls its peer answers at once, and sends one once a call is answered', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits: { maximumAnsweringCalls: 2 } });
      const drawn: number[] = [];
      const request = (connectionHandle: Handle) => {
        return core.request(new Uint8Array(0), {
          connectionHandle,
          onCallId: (callId) => {
            drawn.push(callId);
          },
          options,
          procedure: echo,
        });
      };

      const first = request('a');
      const second = request('a');
      // another connection's calls are its own
      const other = request('b');

      // past them, it fails at once, drawing no call id and sending nothing
      await expect(request('a')).rejects.toMatchObject({
        code: ProtocolCode.CAPACITY_EXCEEDED,
        detail: 'the calls waiting on a are 2 at most',
        side: 'server',
      });
      expect(drawn).toEqual([2, 4, 6]);
      expect(sent).toHaveLength(3);

      // answered, a call gives its place back in the turn its answer came
      core.receive(resultOf(2), 'a');

      const third = request('a');

      expect(drawn).toEqual([2, 4, 6, 8]);
      await first;
      await sleep(0);

      expect(
        sent.map(({ connectionHandle, envelope }) => {
          return [connectionHandle, envelope?.header.callId];
        })
      ).toEqual([
        ['a', 2],
        ['a', 4],
        ['b', 6],
        ['a', 8],
      ]);

      core.rejectPending('all gone');
      await Promise.allSettled([second, other, third]);
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

  test.describe('its answers', () => {
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
  });

  test.describe('cancels', () => {
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

    // spec 10.4
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

    test('reserve a call id as long as its call was given, or 5 s when it was given no time or waited without end, on its clock', () => {
      const { port } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });

      for (const [callId, timeout] of [
        [2, undefined],
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
  });

  test.describe('the transfers it receives', () => {
    test('receive a result in a transfer, credited as it comes, and settle its call once whole', async () => {
      for (const failures of [CLIENT_FAILURES, SERVER_FAILURES]) {
        const callId = failures === CLIENT_FAILURES ? 1 : 2;
        const { activities, port, reported, sent } = createPort({ failures });
        using core = createRouterCore(port, { limits });
        const payload = patternOf(300);
        const answering = core.request(
          failures === CLIENT_FAILURES ? Uint8Array.of(1) : new Uint8Array(0),
          {
            connectionHandle: 'a',
            options,
            procedure: echo,
          }
        );
        const chunk = (start: number, end?: number) => {
          return chunkOf(callId, {
            offset: start,
            payload: payload.subarray(start, end),
            total: 300,
          });
        };

        await sleep(0);
        core.receive(
          resultOpeningOf(callId, { payload: payload.subarray(0, 32), total: 300 }),
          'a'
        );
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

        core.receive(chunk(224, 272), 'a');
        await expect(answering).resolves.toEqual({
          header: { callId, kind: EnvelopeKind.RESULT, total: 300 },
          payload,
        });
        expect(activities).toEqual(['request a', 'response a']);
        // a window past the opening, then more as the chunks come: 128 received, then 176
        expect(answersOf(sent)).toEqual([
          ['a', EnvelopeKind.REQUEST, callId],
          ['a', 'credit', callId, 160],
          ['a', 'credit', callId, 256],
          ['a', 'credit', callId, 300],
        ]);
        expect(reported).toEqual([]);
        expect(core.isReserved(callId, 'a')).toBe(true);
      }
    });

    test('reject a result whose chunk breaks its transfer, cancel its call, and drop what comes after', async () => {
      for (const total of [150, 300]) {
        const failures = total === 150 ? SERVER_FAILURES : CLIENT_FAILURES;
        const callId = total === 150 ? 2 : 1;
        const { port, reported, sent } = createPort({ failures });
        using core = createRouterCore(port, { limits });
        const answering = core.request(total === 150 ? new Uint8Array(0) : Uint8Array.of(1), {
          connectionHandle: 'a',
          options: { timeout: total === 150 ? 1_000 : 5_000 },
          procedure: echo,
        });

        await sleep(0);
        core.receive(
          resultOpeningOf(callId, {
            payload: total === 150 ? new Uint8Array(32) : patternOf(32),
            total,
          }),
          'a'
        );
        // the last, it says, yet it ends before the total
        core.receive(
          envelopeOf({
            header: { callId, isLast: total === 150, kind: EnvelopeKind.CHUNK, offset: 32 },
            kind: EnvelopeKind.CHUNK,
            payload: total === 150 ? new Uint8Array(48) : patternOf(300).subarray(32, 52),
          }),
          'a'
        );
        core.receive(
          chunkOf(callId, {
            offset: total === 150 ? 80 : 32,
            payload: total === 150 ? new Uint8Array(48) : patternOf(300).subarray(32, 80),
            total,
          }),
          'a'
        );

        await expect(answering).rejects.toMatchObject({
          code: ProtocolCode.CHUNK_INVALID,
          procedureAddress: { procedureId: 1, serviceId: 2 },
          side: total === 150 ? 'server' : 'client',
          origin: 'local',
        });
        expect(answersOf(sent)).toEqual([
          ['a', EnvelopeKind.REQUEST, callId],
          ['a', 'credit', callId, total === 150 ? 150 : 160],
          ['a', EnvelopeKind.CANCEL, callId],
        ]);
        expect(reported).toEqual([]);
      }
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
        const settled = await asking;

        if (ending === 'whole') {
          expect(settled).toMatchObject({
            payload: Uint8Array.from([...patternOf(32), ...patternOf(8)]),
          });
        } else if (ending === 'failure' || ending === 'invalid') {
          expect(settled).toMatchObject(
            ending === 'failure'
              ? { code: 21, origin: 'peer' }
              : { code: ProtocolCode.CHUNK_INVALID, origin: 'local' }
          );
        } else {
          expect(settled).toBeInstanceOf(CancelError);
        }
      }

      // the reserved id stays unavailable until the abandonment interval ends
      const { port, reported, sent } = createPort({ failures: CLIENT_FAILURES });
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        lastCallId: 3,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const controller = new AbortController();
      const asking = core.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { signal: controller.signal, timeout: 1_000 },
        procedure: echo,
      });

      core.receive(resultOpeningOf(1, { payload: patternOf(32), total: 300 }), 'a');
      controller.abort();
      await expect(asking).rejects.toBeInstanceOf(CancelError);
      clock.tick(1_500);
      core.receive(
        chunkOf(1, { offset: 32, payload: patternOf(300).subarray(32, 80), total: 300 }),
        'a'
      );
      expect(reported).toEqual([]);
      void settledOf(
        core.request(Uint8Array.of(1), {
          connectionHandle: 'a',
          options: { timeout: 5_000 },
          procedure: echo,
        })
      );
      expect(sent.at(-1)?.envelope?.header.callId).toBe(3);
      clock.tick(500);
      core.receive(
        chunkOf(1, { offset: 32, payload: patternOf(300).subarray(32, 80), total: 300 }),
        'a'
      );
      expect(codesOf(reported)).toEqual([[ProtocolCode.CALL_UNKNOWN, 'a']]);
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

    test('send a request as a transfer: its opening, the chunks each credit lets go, then wait on its answer', async () => {
      for (const total of [200, 300]) {
        const callId = total === 200 ? 2 : 1;
        const { activities, port, reported, sent, sizes } = createPort({
          failures: total === 200 ? SERVER_FAILURES : CLIENT_FAILURES,
        });
        using core = createRouterCore(port, { limits });
        const payload = patternOf(total);
        const answering = core.request(payload, {
          connectionHandle: 'a',
          options,
          procedure: echo,
        });

        await sleep(0);

        expect(piecesOf(sent)).toEqual([[EnvelopeKind.REQUEST, callId, total, 44]]);

        core.receive(creditOf(callId, total === 200 ? 140 : 172), 'a');
        await sleep(0);

        // full chunks alone, the next waiting for its credit
        expect(piecesOf(sent).slice(1)).toEqual([
          [EnvelopeKind.CHUNK, callId, 44, 48],
          [EnvelopeKind.CHUNK, callId, 92, 48],
        ]);
        expect(activities).toEqual([]);

        core.receive(creditOf(callId, total), 'a');
        await sleep(0);

        expect(activities).toEqual(['request a']);

        core.receive(resultOf(callId, Uint8Array.of(total === 200 ? 9 : 1)), 'a');

        await expect(answering).resolves.toMatchObject({
          payload: Uint8Array.of(total === 200 ? 9 : 1),
        });
        expect(piecesOf(sent).slice(3)).toEqual(
          total === 200
            ? [
                [EnvelopeKind.CHUNK, callId, 140, 48],
                [EnvelopeKind.CHUNK, callId, 188, 12],
              ]
            : [
                [EnvelopeKind.CHUNK, callId, 140, 48],
                [EnvelopeKind.CHUNK, callId, 188, 48],
                [EnvelopeKind.CHUNK, callId, 236, 48],
                [EnvelopeKind.CHUNK, callId, 284, 16],
              ]
        );
        expect(payloadOf(sent, callId)).toEqual(payload);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
        expect(reported).toEqual([]);
        expect(
          sent.flatMap(({ envelope }) => {
            return envelope?.kind === EnvelopeKind.CHUNK ? [envelope.header.isLast] : [];
          })
        ).toEqual(
          total === 200 ? [false, false, false, true] : [false, false, false, false, false, true]
        );
      }
    });

    test('stop a request the peer answers, or its caller gives up, and send nothing more of it', async () => {
      for (const [ending, total, timeout, initialCredit, code, side] of [
        ['failure', 200, 1_000, 92, 21, 'server'],
        ['cancel', 200, 1_000, 92, 0, 'server'],
        ['signal', 200, 1_000, 92, 0, 'server'],
        ['failure', 300, 5_000, 100, 7, 'client'],
        ['signal', 300, 5_000, undefined, 0, 'client'],
      ] as const) {
        const { port, reported, sent } = createPort({
          failures: side === 'client' ? CLIENT_FAILURES : SERVER_FAILURES,
        });
        const callId = side === 'client' ? 1 : 2;
        using core = createRouterCore(port, { limits });
        const controller = new AbortController();
        const asking = core.request(patternOf(total), {
          connectionHandle: 'a',
          options: { signal: controller.signal, timeout },
          procedure: echo,
        });

        if (initialCredit !== undefined) {
          core.receive(creditOf(callId, initialCredit), 'a');
        }

        if (ending === 'failure') {
          core.receive(
            envelopeOf({
              failure: { code, scope: FailureScope.APPLICATION },
              header: { callId, kind: EnvelopeKind.FAILURE },
              kind: EnvelopeKind.FAILURE,
            }),
            'a'
          );
        } else if (ending === 'cancel') {
          core.cancel({ callId, connectionHandle: 'a' });
        } else {
          controller.abort();
        }

        await expect(asking, ending).rejects.toBeInstanceOf(
          ending === 'failure' ? FailureError : CancelError
        );
        if (ending === 'failure') {
          await expect(asking).rejects.toMatchObject({ code, origin: 'peer' });
        }
        core.receive(creditOf(callId, total), 'a');
        await sleep(0);

        // the peer ended its call itself; given up, it is told to
        expect(piecesOf(sent), ending).toEqual([
          [EnvelopeKind.REQUEST, callId, total, 44],
          ...(initialCredit === undefined ? [] : [[EnvelopeKind.CHUNK, callId, 44, 48]]),
          ...(ending === 'failure' ? [] : [[EnvelopeKind.CANCEL, callId]]),
        ]);
        expect(sent[0]?.envelope).toMatchObject({ payload: patternOf(total).subarray(0, 44) });
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

      const client = createPort({ failures: CLIENT_FAILURES });
      const otherClock = createTestClock();
      using clientCore = createRouterCore(client.port, {
        clock: otherClock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const asking = settledOf(
        clientCore.request(patternOf(300), { connectionHandle: 'a', options, procedure: echo })
      );
      let isCompleted = false;
      void asking.then(() => {
        isCompleted = true;
      });
      await otherClock.tickAsync(1_500);
      clientCore.receive(creditOf(1, 80), 'a');
      await sleep(0);
      expect(piecesOf(client.sent)).toEqual([[EnvelopeKind.REQUEST, 1, 300, 44]]);
      await otherClock.tickAsync(1_500);
      expect(isCompleted).toBe(false);
      clientCore.receive(creditOf(1, 300), 'a');
      await sleep(0);
      await otherClock.tickAsync(900);
      expect(isCompleted).toBe(false);
      await otherClock.tickAsync(100);
      expect(await asking).toMatchObject({ timeout: 1_000 });
      expect(answersOf(client.sent).at(-1)).toEqual(['a', EnvelopeKind.CANCEL, 1]);
    });

    test('set a call’s timer going again as the bytes of its result come, and not for bytes it has', async () => {
      const { port, reported, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 250 },
      });
      const chunk = chunkOf(2, { offset: 32, payload: new Uint8Array(48), total: 150 });
      let waiting: Promise<unknown> = Promise.resolve();
      const { armed } = timersBy(clock, () => {
        waiting = core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options,
          procedure: echo,
        });
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
      let isEnded = false;

      void settledOf(waiting).then(() => {
        isEnded = true;
      });
      clock.tick(249);
      await sleep(0);
      expect(isEnded).toBe(false);
      clock.tick(1);
      await expect(waiting).rejects.toMatchObject({ name: 'TimeoutError', timeout: 250 });
      expect(answersOf(sent).at(-1)).toEqual(['a', EnvelopeKind.CANCEL, 2]);
      expect(reported).toEqual([]);

      const timed = createPort({ failures: CLIENT_FAILURES });
      const advanced = createTestClock();
      using peer = createRouterCore(timed.port, {
        clock: advanced,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const asked = peer.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: echo,
      });
      let isSettled = false;

      void settledOf(asked).then(() => {
        isSettled = true;
      });
      peer.receive(resultOpeningOf(1, { payload: patternOf(32), total: 300 }), 'a');
      advanced.tick(1_500);
      peer.receive(
        chunkOf(1, { offset: 32, payload: patternOf(300).subarray(32, 80), total: 300 }),
        'a'
      );
      advanced.tick(1_500);
      peer.receive(
        chunkOf(1, { offset: 32, payload: patternOf(300).subarray(32, 80), total: 300 }),
        'a'
      );
      await sleep(0);
      expect(isSettled).toBe(false);
      advanced.tick(500);
      await expect(asked).rejects.toMatchObject({ name: 'TimeoutError', timeout: 2_000 });
      expect(answersOf(timed.sent).at(-1)).toEqual(['a', EnvelopeKind.CANCEL, 1]);
      expect(timed.reported).toEqual([]);
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
        [EnvelopeKind.RESULT, 1, 150, 28],
        [EnvelopeKind.CHUNK, 2, 44, 48],
        [EnvelopeKind.CHUNK, 1, 28, 48],
      ]);
      expect(reported).toEqual([]);
    });

    test('keep the inactivity of a result that opens as the last chunk of its request goes', async () => {
      for (const holdLastSend of [false, true]) {
        const { port, sent } = createPort();
        const clock = createTestClock();
        const handed = Promise.withResolvers<void>();
        let opened = 0;
        const core: IRouterCore<Handle> = createRouterCore(
          {
            ...port,
            // the peer, the request whole, answers with a transfer before the last chunk's send returns
            send: (bytes, connectionHandle) => {
              const sending = port.send(bytes, connectionHandle);
              const envelope = sent.at(-1)?.envelope;

              if (envelope?.kind === EnvelopeKind.CHUNK && envelope.header.isLast) {
                opened += 1;
                core.receive(resultOpeningOf(2, { payload: patternOf(32), total: 100 }), 'a');
                return holdLastSend ? handed.promise : sending;
              }

              return sending;
            },
          },
          { clock, limits }
        );
        let asking: Promise<unknown> = Promise.resolve();
        const { armed, cleared } = timersBy(clock, () => {
          asking = core.request(patternOf(200), {
            connectionHandle: 'a',
            options,
            procedure: echo,
          });
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
        expect(opened).toBe(1);
        handed.resolve();
        await sleep(0);
        expect(
          clock.armed
            .filter(({ handle }) => {
              return !clock.cleared.includes(handle);
            })
            .map(({ delay }) => {
              return delay;
            })
        ).toEqual([30_000]);

        core[Symbol.dispose]();
        await expect(asking).rejects.toBeInstanceOf(DisconnectError);
      }

      // a result that opens before the final credit keeps its inactivity too
      const { port, sent } = createPort({ failures: CLIENT_FAILURES });
      const clock = createTestClock();
      using core = createRouterCore(port, {
        clock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const asking = core.request(patternOf(300), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });
      let isEnded = false;

      void settledOf(asking).then(() => {
        isEnded = true;
      });
      core.receive(creditOf(1, 172), 'a');
      core.receive(resultOpeningOf(1, { payload: patternOf(32), total: 300 }), 'a');
      core.receive(creditOf(1, 300), 'a');
      expect(sent.at(-1)?.envelope).toMatchObject({
        header: { isLast: true },
        kind: EnvelopeKind.CHUNK,
      });
      clock.tick(1_500);
      await sleep(0);
      expect(isEnded).toBe(false);
      clock.tick(500);
      await expect(asking).rejects.toMatchObject({ name: 'TimeoutError', timeout: 2_000 });
      expect(answersOf(sent).at(-1)).toEqual(['a', EnvelopeKind.CANCEL, 1]);
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
  });

  test.describe('its metrics', () => {
    const made = lineOf('bead_client_call_', 'service="2",procedure="echo",type="command"');

    // debugging 9.3, 9.6.3 and 9.6.4
    test('count a call made refused before it goes, no call id free or PAYLOAD_TOO_LARGE, as started and ended in the turn it started, and a programmer’s error or an aborted signal as nothing', async () => {
      const registry = createMetricsRegistry();
      const metrics = registry.attach('server');
      const { port } = createPort();
      // one call id alone, 2, and chunks of 64 bytes
      using core = createRouterCore(port, {
        clock: createTestClock(),
        lastCallId: 2,
        limits,
        metrics,
      });
      const series = metrics.declareRequester(echo);
      const ask = (
        payload: Uint8Array,
        asked: Partial<Parameters<typeof core.request>[1]> = {}
      ) => {
        return core
          .request(payload, { connectionHandle: 'a', options, procedure: echo, series, ...asked })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      // refused as it starts, before any turn passes
      const tooLarge = ask(new Uint8Array(9), { procedure: { ...echo, maximumPayloadBytes: 8 } });

      expect(countedOf(registry)).toEqual([
        made('duration_seconds_count{} 1'),
        made('handled_total{outcome="failure",code="PAYLOAD_TOO_LARGE"} 1'),
        made('started_total{} 1'),
      ]);
      expect(registry.exposition().text).toContain(
        'bead_client_call_duration_seconds_bucket{service="2",procedure="echo",type="command",le="0.0"} 1\n'
      );

      // 40 bytes of token leave a 64-byte opening no byte
      const noOpening = ask(patternOf(100), {
        credential: { scheme: CredentialScheme.JWT, token: 'x'.repeat(40) },
      });
      const waiting = ask(new Uint8Array(0));
      const noCallId = ask(new Uint8Array(0));

      expect(countedOf(registry)).toEqual([
        made('duration_seconds_count{} 3'),
        made('handled_total{outcome="failure",code="PAYLOAD_TOO_LARGE"} 2'),
        made('handled_total{outcome="failure",code="CAPACITY_EXCEEDED"} 1'),
        made('started_total{} 4'),
      ]);
      expect(registry.exposition().text).toContain(
        'bead_client_call_duration_seconds_bucket{service="2",procedure="echo",type="command",le="0.0"} 3\n'
      );
      expect(registry.exposition().text).toContain(made('duration_seconds_sum{} 0'));

      // a programmer's error, a credential no header of its request holds among them, and a signal
      // aborted already: none is a call
      const refused = await Promise.all([
        ask(new Uint8Array(0), { options: { timeout: 0 } }),
        ask(new Uint8Array(0), { procedure: { ...echo, maximumPayloadBytes: 0 } }),
        ask(new Uint8Array(0), {
          credential: { scheme: CredentialScheme.JWT, token: 'x'.repeat(1_005) },
        }),
        ask(new Uint8Array(0), { options: { ...options, signal: AbortSignal.abort() } }),
      ]);

      expect(
        refused.map((reason) => {
          return (reason as Error).name;
        })
      ).toEqual(['ProgrammerError', 'ProgrammerError', 'ProgrammerError', 'CancelError']);
      expect(countedOf(registry)).toContain(made('started_total{} 4'));

      core.receive(resultOf(2), 'a');
      await Promise.all([tooLarge, noOpening, waiting, noCallId]);

      const clientRegistry = createMetricsRegistry();
      const clientMetrics = clientRegistry.attach('client');
      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port, {
        clock: createTestClock(),
        lastCallId: 3,
        limits,
        metrics: clientMetrics,
      });
      const clientSeries = clientMetrics.declareRequester(echo);
      let isConnected = true;
      let isSecure = false;
      const clientAsk = (
        payload = Uint8Array.of(0),
        asked: {
          requested?: RequestCredential;
          options?: Parameters<typeof clientCore.request>[1]['options'];
          procedure?: Parameters<typeof clientCore.request>[1]['procedure'];
        } = {}
      ) => {
        let credential: Parameters<typeof clientCore.request>[1]['credential'];
        let carried: string | undefined;
        let refusal: Error | undefined;
        try {
          const presented = presentedCredentialOf(asked.requested, {
            failures: CLIENT_FAILURES,
            token: undefined,
          });
          credential = presented.credential;
          carried = presented.carried;
          const uncarried = uncarriedOf(credential, {
            carried,
            carries: () => {
              return false;
            },
            failures: CLIENT_FAILURES,
            isSecure,
          });
          refusal =
            uncarried === undefined
              ? isConnected
                ? undefined
                : new DisconnectError('the connection is closed')
              : new FailureError(uncarried);
        } catch (reason) {
          refusal = reason as Error;
        }
        return clientCore
          .request(payload, {
            connectionHandle: 'a',
            options: asked.options ?? { timeout: Infinity },
            procedure: asked.procedure ?? echo,
            series: clientSeries,
            credential,
            transportCredential: carried,
            refusal,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };
      expect(
        await clientAsk(Uint8Array.of(0), { requested: { scheme: CredentialScheme.OPAQUE } })
      ).toMatchObject({ code: ProtocolCode.SESSION_REQUIRED });
      expect(
        await clientAsk(Uint8Array.of(0), {
          requested: { scheme: CredentialScheme.ELSEWHERE, carried: 'x' },
        })
      ).toMatchObject({ code: ProtocolCode.DESTINATION_UNREACHABLE });
      expect(
        await clientAsk(new Uint8Array(8), { procedure: { ...echo, maximumPayloadBytes: 4 } })
      ).toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });
      isSecure = true;
      expect(
        await clientAsk(new Uint8Array(9), {
          requested: { scheme: CredentialScheme.JWT, token: 'a'.repeat(40) },
        })
      ).toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });
      isConnected = false;
      expect(await clientAsk()).toBeInstanceOf(DisconnectError);
      isConnected = true;
      const pending = [clientAsk(), clientAsk()];
      expect(await clientAsk()).toMatchObject({ code: ProtocolCode.CAPACITY_EXCEEDED });
      const clientMade = lineOf('bead_client_call_', 'service="2",procedure="echo",type="request"');
      expect(countedOf(clientRegistry)).toEqual([
        clientMade('duration_seconds_count{} 6'),
        clientMade('handled_total{outcome="failure",code="DESTINATION_UNREACHABLE"} 1'),
        clientMade('handled_total{outcome="failure",code="SESSION_REQUIRED"} 1'),
        clientMade('handled_total{outcome="failure",code="PAYLOAD_TOO_LARGE"} 2'),
        clientMade('handled_total{outcome="failure",code="CAPACITY_EXCEEDED"} 1'),
        clientMade('handled_total{outcome="closed"} 1'),
        clientMade('started_total{} 8'),
      ]);
      expect(clientRegistry.exposition().text).toContain(
        'bead_client_call_duration_seconds_bucket{service="2",procedure="echo",type="request",le="0.0"} 6\n'
      );
      expect(clientRegistry.exposition().text).toContain(clientMade('duration_seconds_sum{} 0'));
      isConnected = false;
      const notCalls = await Promise.all([
        clientAsk(new Uint8Array(0), { options: { timeout: 0 } }),
        clientAsk(new Uint8Array(0), { procedure: { ...echo, maximumPayloadBytes: 0 } }),
        clientAsk(new Uint8Array(0), {
          requested: { scheme: CredentialScheme.JWT, token: 'a'.repeat(1_005) },
        }),
        clientAsk(new Uint8Array(0), {
          options: { timeout: Infinity, signal: AbortSignal.abort() },
        }),
      ]);
      expect(
        notCalls.map((reason) => {
          return (reason as Error).name;
        })
      ).toEqual(['ProgrammerError', 'ProgrammerError', 'ProgrammerError', 'CancelError']);
      expect(countedOf(clientRegistry)).toContain(clientMade('started_total{} 8'));
      clientCore[Symbol.dispose]();
      await Promise.all(pending);
    });

    test('count a call it makes as its router settles it, timed to that instant', async () => {
      const registry = createMetricsRegistry();
      const metrics = registry.attach('server');
      const clock = createTestClock();
      const { control, port } = createPort();
      using core = createRouterCore(port, { clock, metrics });
      const series = metrics.declareRequester(echo);
      const ask = (asked: Partial<Parameters<typeof core.request>[1]> = {}) => {
        return core
          .request(new Uint8Array(0), {
            connectionHandle: 'a',
            options: { timeout: Infinity },
            procedure: echo,
            series,
            ...asked,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      // a result, an application's failure, then its time passed 10 ms after it went
      const result = ask();
      const failed = ask();
      const timed = ask({ options: { timeout: 10 } });

      await sleep(0);
      core.receive(resultOf(2), 'a');
      core.receive(
        envelopeOf({
          failure: { code: 9, scope: FailureScope.APPLICATION },
          header: { callId: 4, kind: EnvelopeKind.FAILURE },
          kind: EnvelopeKind.FAILURE,
        }),
        'a'
      );
      await clock.tickAsync(10);

      expect(await timed).toBeInstanceOf(TimeoutError);

      // its caller's cancel once it went, its connection gone, and a transport that refuses it
      const controller = new AbortController();
      const cancelled = ask({ options: { signal: controller.signal, timeout: Infinity } });

      await sleep(0);
      controller.abort();

      expect(await cancelled).toBeInstanceOf(CancelError);

      const closed = ask();

      await sleep(0);
      core.rejectPending('the connection closed before the answer', 'a');

      expect(await closed).toBeInstanceOf(DisconnectError);

      control.sendErrors.set('a', new Error('refused'));

      expect(await ask()).toMatchObject({ message: 'refused' });
      expect(await result).not.toBeInstanceOf(Error);
      expect(await failed).toBeInstanceOf(FailureError);

      // the timeout alone took its 10 ms; the five others ended on a clock unmoved, in the bucket of 0
      expect(registry.exposition().text).toContain(
        'bead_client_call_duration_seconds_bucket{service="2",procedure="echo",type="command",le="0.0"} 5\n'
      );
      expect(countedOf(registry)).toEqual([
        made('duration_seconds_sum{} 0.01'),
        made('duration_seconds_count{} 6'),
        made('handled_total{outcome="result"} 1'),
        made('handled_total{outcome="failure",code="application"} 1'),
        made('handled_total{outcome="timeout"} 1'),
        made('handled_total{outcome="cancelled"} 1'),
        made('handled_total{outcome="closed"} 1'),
        made('handled_total{outcome="error"} 1'),
        made('started_total{} 6'),
      ]);
    });
  });
});

test.describe('createRouterRequester', () => {
  test('sends a call on a call id of its side, settles it with the answer paired to it, and hands its port an answer no call waits on', async () => {
    const { port, reported, sent } = createPort();
    const clock = createTestClock();
    const routerLimits = limitsOf(limits);
    const placement = createPayloadPlacement(SERVER_FAILURES, routerLimits);
    const writer = createRouterWriter(port, {
      isDisposed: () => {
        return false;
      },
      limits: routerLimits,
      tooLargeOf: placement.tooLargeOf,
    });
    const raised: IFailure[] = [];
    const requester = createRouterRequester<Handle>(
      {
        activity: port.activity,
        failures: SERVER_FAILURES,
        isCallIdInUse: () => {
          return false;
        },
        isDisposed: () => {
          return false;
        },
        onAnswerReceived: noop,
        onUnpairedFailure: () => {
          return false;
        },
        receiveUnplaced: noop,
        report: port.report,
        reportFailure: (failure) => {
          raised.push(failure);
        },
      },
      {
        clock,
        limits: routerLimits,
        placement,
        receivings: createReceivingTransfers<Handle>({
          clock,
          failures: SERVER_FAILURES,
          limits: routerLimits,
          payloadBytesPerChunk: placement.payloadBytesPerChunk,
          sendCredit: noop,
        }),
        sendings: createSendingTransfers<Handle>(),
        writer,
      }
    );
    const answerFor = (callId: number) => {
      const envelope = readEnvelope(resultOf(callId, new Uint8Array([7])), {
        failures: SERVER_FAILURES,
        maximumEnvelopeBytes: routerLimits.maximumEnvelopeBytes,
      });

      if (envelope?.kind !== EnvelopeKind.RESULT) {
        throw new Error('a result reads as one');
      }

      return envelope;
    };

    const called = requester.request(new Uint8Array([1]), {
      connectionHandle: 'a',
      options,
      procedure: echo,
    });
    await sleep(0);

    const callId = sent[0]?.envelope?.header.callId ?? 0;

    expect(
      sent.map(({ connectionHandle, envelope }) => {
        return [connectionHandle, envelope?.kind];
      })
    ).toEqual([['a', EnvelopeKind.REQUEST]]);
    expect(callId % 2).toBe(0);
    expect(requester.gauges().counts).toEqual(expect.objectContaining({ pendingCalls: 1 }));

    requester.receiveAnswer(answerFor(callId), { connectionHandle: 'a', mayOvertake: false });
    expect((await called).payload).toEqual(new Uint8Array([7]));

    requester.receiveAnswer(answerFor(callId), { connectionHandle: 'a', mayOvertake: false });
    expect(raised).toEqual([SERVER_FAILURES.callUnknown]);
    expect(reported).toEqual([]);
  });
});
