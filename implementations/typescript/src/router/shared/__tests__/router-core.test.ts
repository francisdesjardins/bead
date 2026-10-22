import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { createTestClock, hasRef, timersBy } from '../../../transport/shared/__tests__/fixtures';
import type { IClock } from '../../../transport/shared/clock';
import { CancelError, ProgrammerError, TimeoutError } from '../../../transport/shared/errors';
import { noop } from '../../../transport/shared/noop';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { CapacityError, DisconnectError, FailureError } from '../errors';
import { createMetricsRegistry } from '../metrics-registry';
import { toSessionToken } from '../identifiers';
import { connectionSessionOf } from '../call-session';
import * as routerClient from '../../client/router-client';
import * as routerServer from '../../server/router-server';
import { createRouterCore } from '../router-core';
import * as serviceManager from '../service-manager';
import type {
  Envelope,
  IAdmissionRequest,
  ICallSession,
  ICreditHeader,
  IFailure,
  INotificationHeader,
  IProcedure,
  IDestinationHandler,
  IRequestHandler,
  IRequestHeader,
  IRequestResolver,
  IRequestResolverProps,
  ISessionRequest,
  ITransportCarried,
  OutgoingEnvelope,
} from '../types';
import { callIdsOf, countedOf, createLoopback, digestOf, envelopeOf, patternOf } from './fixtures';
import {
  type Handle,
  OPAQUE,
  TOKEN,
  answerOf,
  answersOf,
  cancelOf,
  chunkOf,
  codesOf,
  createAnswering,
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

// constants

const PACKAGE = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as { exports: Record<string, string> };

// definition

test.describe('createRouterCore', () => {
  test.describe('takes what comes in', () => {
    // debugging 5.2
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

    // spec 9.0
    test('answers a request its codec throws on other than a refusal ENVELOPE_MALFORMED with no detail, and reports the error with its connection', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const callId = callIdsOf('client')();
      const bytes = requestOf(callId, {
        credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' },
      });
      const thrown = new Error('internal: 10.0.0.5:8443');
      const { fromCharCode } = String;

      // * the codec reads a JWT's bytes as text: there, and once, it throws what is not a refusal
      String.fromCharCode = () => {
        String.fromCharCode = fromCharCode;

        throw thrown;
      };

      try {
        core.receive(bytes, 'a');
      } finally {
        String.fromCharCode = fromCharCode;
      }

      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', callId, ProtocolCode.ENVELOPE_MALFORMED]]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: {
          code: ProtocolCode.ENVELOPE_MALFORMED,
          detail: '',
          scope: FailureScope.PROTOCOL,
        },
      });
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      expect(reported[0]?.[0]).toMatchObject({ cause: thrown, detail: thrown.message });
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
        [1, ['connectionHandle', 'header', 'session']],
        [3, ['connectionHandle', 'header', 'session']],
        [5, ['connectionHandle', 'header', 'session']],
        [7, ['connectionHandle', 'header', 'session']],
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
      for (const message of ['thrown', 'the admission broke']) {
        const { port, reported, sent } = createPort();
        using core = createRouterCore(port);
        const seen: IRequestResolverProps<Handle>[] = [];
        const thrown = new Error(message);

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
      }
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

    test('answers CAPACITY_EXCEEDED a request past the calls its peer has it answer on its connection, before its route, its credential or its transfer, and takes one once a call ends', async () => {
      let asked = 0;
      const { port, sent } = createPort({
        credentialSchemes: [CredentialScheme.JWT],
        sessionOf: ({ header }) => {
          if (header.credential === undefined) {
            return undefined;
          }

          asked += 1;

          return Promise.resolve(undefined);
        },
      });
      const seen: IRequestResolverProps<Handle>[] = [];
      using core = createRouterCore(port, {
        limits: { ...limits, maximumAnsweringCalls: 2, maximumEnvelopeBytes: 1_024 },
      });
      const jwt = { scheme: CredentialScheme.JWT, token: 'a.b.c' } as const;

      core.registerResolver(resolverOf(echo, seen));
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3), 'a');
      // another connection's calls are its own
      core.receive(requestOf(1), 'b');
      core.receive(requestOf(5, { procedure: { ...echo, serviceId: 8 } }), 'a');
      core.receive(requestOf(7, { destinationId: 4 }), 'a');
      core.receive(requestOf(9, { credential: jwt }), 'a');
      core.receive(requestOf(11, { payload: patternOf(8), total: 100 }), 'a');
      await sleep(0);

      expect(seen).toHaveLength(3);
      expect(asked).toBe(0);
      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 5, ProtocolCode.CAPACITY_EXCEEDED],
        ['a', 'failure', 7, ProtocolCode.CAPACITY_EXCEEDED],
        ['a', 'failure', 9, ProtocolCode.CAPACITY_EXCEEDED],
        ['a', 'failure', 11, ProtocolCode.CAPACITY_EXCEEDED],
      ]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: { detail: 'the calls a connection has answered at once are 2 at most' },
      });

      // a call answered gives its place back, and the next request is taken
      await answerOf({ core, seen }, { payload: new Uint8Array(0) });
      core.receive(requestOf(13), 'a');
      await sleep(0);

      expect(seen).toHaveLength(4);
      expect(seen[3]?.header.callId).toBe(13);
    });

    test('answers ENVELOPE_TOO_LARGE a request that came whole past chunkBytes, and holds nothing of it', async () => {
      const { port, sent } = createPort();
      const seen: IRequestResolverProps<Handle>[] = [];
      using core = createRouterCore(port, {
        limits: { ...limits, maximumEnvelopeBytes: 1_024 },
      });

      core.registerResolver(resolverOf(echo, seen));
      // 12 bytes of header, then 53 of payload: one past chunkBytes, within an envelope
      core.receive(requestOf(1, { payload: patternOf(53) }), 'a');
      // an opening past it too
      core.receive(requestOf(3, { payload: patternOf(49), total: 300 }), 'a');
      // a request of chunkBytes, taken
      core.receive(requestOf(5, { payload: patternOf(52) }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.ENVELOPE_TOO_LARGE],
        ['a', 'failure', 3, ProtocolCode.ENVELOPE_TOO_LARGE],
      ]);
      expect(sent[0]?.envelope).toMatchObject({
        failure: { detail: 'a request is 64 bytes at most, not 65' },
      });
      expect(
        seen.map(({ header }) => {
          return header.callId;
        })
      ).toEqual([5]);
      expect(core.gauges().counts).toMatchObject({ answeringCalls: 1, receivingTransfers: 0 });
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

    test('lets go of the call id of a refusal that cannot go out, so the same request is refused again', async () => {
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
      // the kept bit
      core.receive(fromHexadecimal('A1 10 01 03  00 00 00 05  00 02 00 01'), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 5, ProtocolCode.ENVELOPE_MALFORMED]]);
      expect(codesOf(reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
    });

    test('settles a call with an answer of this layout that does not read, and never with one of another', async () => {
      const { port, reported, sent } = createPort();
      const clock = createTestClock();
      using core = createRouterCore(port, { clock });
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
      clock.tick(50);
      await expect(second).rejects.toBeInstanceOf(TimeoutError);
      await expect(second).rejects.toMatchObject({
        message: 'no answer came in 50 milliseconds',
        timeout: 50,
      });
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

      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port);
      const asked = clientCore.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: echo,
      });
      let isSettled = false;

      void settledOf(asked).then(() => {
        isSettled = true;
      });

      clientCore.receive(fromHexadecimal('A2 11 00 02  00 00 00 01'), 'a');
      await sleep(0);
      expect(isSettled).toBe(false);
      expect(codesOf(client.reported)).toEqual([[ProtocolCode.LAYOUT_UNSUPPORTED, 'a']]);
      clientCore.receive(fromHexadecimal('A1 12 00 02  00 00 00 01  00'), 'a');
      await expect(asked).rejects.toMatchObject({
        code: ProtocolCode.ENVELOPE_MALFORMED,
        origin: 'local',
        procedureAddress: { procedureId: echo.procedureId, serviceId: echo.serviceId },
        side: 'client',
      });
      clientCore.receive(fromHexadecimal('A1 12 00 02  00 00 00 01  00'), 'b');
      expect(codesOf(client.reported)).toEqual([
        [ProtocolCode.LAYOUT_UNSUPPORTED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'b'],
      ]);
      expect(answersOf(client.sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 1],
        ['a', EnvelopeKind.CANCEL, 1],
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
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: number[] = [];
      const failing = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const requests: IRequestResolverProps<Handle>[] = [];

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          seen.push(props.header.callId);
          requests.push(props);

          return seen.length === 1
            ? failing.promise
            : seen.length === 2
              ? cancelled.promise
              : Promise.resolve();
        }, echo)
      );
      core.receive(requestOf(5), 'a');
      failing.reject(new Error('rejected'));
      await sleep(0);
      core.receive(requestOf(5), 'a');
      await sleep(0);

      expect(seen).toEqual([5, 5]);
      expect(codesOf(reported)).toEqual([['rejected', 'a']]);
      // the first answers PROCEDURE_FAILED; the second waits without answering
      expect(answersOf(sent)).toEqual([['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED]]);
      core.receive(cancelOf(5), 'a');
      core.receive(requestOf(5), 'a');
      cancelled.reject(new Error('rejected'));
      await sleep(0);
      expect(seen).toEqual([5, 5, 5]);
      expect(codesOf(reported)).toEqual([['rejected', 'a']]);
      await core.respond({ payload: Uint8Array.of(3) }, requests[2]!);
      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'result', 5, [3]],
      ]);
    });

    test('sends nothing for an answer whose call its connection took away, though the peer opens its call id again', async () => {
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
      const { port, reported, sent } = createPort();
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
      expect(answersOf(sent)).toEqual([['a', 'result', 5, []]]);
      holding.resolve();

      const before = createPort();
      using earlier = createRouterCore(before.port);
      const broken = new Error('the resolver broke after its answer');
      const requests: number[] = [];

      earlier.registerResolver(
        Object.assign(async (props: IRequestResolverProps<Handle>) => {
          requests.push(props.header.callId);
          if (props.payload[0] === 1) {
            await earlier.respond({ payload: Uint8Array.of(1) }, props);
            throw broken;
          }
        }, echo)
      );
      earlier.receive(requestOf(1, { payload: Uint8Array.of(1) }), 'a');
      await sleep(0);
      expect(before.reported).toEqual([[broken, 'a']]);
      expect(answersOf(before.sent)).toEqual([['a', 'result', 1, [1]]]);
      earlier.receive(requestOf(1, { payload: Uint8Array.of(2) }), 'a');
      earlier.receive(requestOf(1, { payload: Uint8Array.of(3) }), 'a');
      await sleep(0);
      expect(requests).toEqual([1, 1]);
      expect(codesOf(before.reported)).toEqual([
        [broken.message, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
    });

    // debugging 5.2
    test('reports the kinds to come, and skips the advisory ones in silence', async () => {
      const { port, reported, sent, traced } = createPort();
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
      // none traced: the advisory ones skipped before it, the others reported as they do not read
      expect(traced).toEqual([]);
    });

    test('routes a request that opens a transfer, then refuses it, its route first', async () => {
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
      core.receive(
        requestOf(7, { procedure: { ...echo, serviceId: 9 }, total: 300, payload: patternOf(44) }),
        'a'
      );
      core.receive(requestOf(9, { destinationId: 7, total: 300, payload: patternOf(40) }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.SERVICE_UNKNOWN],
        ['a', 'failure', 3, ProtocolCode.DESTINATION_UNKNOWN],
        ['a', 'failure', 5, ProtocolCode.PAYLOAD_TOO_LARGE],
        ['a', 'failure', 7, ProtocolCode.SERVICE_UNKNOWN],
        ['a', 'failure', 9, ProtocolCode.DESTINATION_UNKNOWN],
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

    test('refuses a second resolver for one procedure, and an address, a revision or a name outside section 16', () => {
      using core = createRouterCore(createPort().port);

      core.registerResolver(resolverOf(echo));

      expect(() => {
        core.registerResolver(resolverOf({ ...echo, procedureName: 'again' }));
      }).toThrow(ProgrammerError);

      for (const procedure of [
        { procedureId: 0, serviceId: 2 },
        { procedureId: 1, serviceId: 0 },
        { procedureId: 0x10000, serviceId: 2 },
        { procedureId: 1, serviceId: 1.5 },
        { serviceRevision: 0 },
        { serviceRevision: 2 ** 31 },
      ]) {
        expect(() => {
          core.registerResolver(resolverOf({ ...echo, procedureId: 2, ...procedure }));
        }, JSON.stringify(procedure)).toThrow(/ is out of its range: /);
      }

      for (const procedureName of ['Echo', '_OTHER', 'echo\n', 'get_thing', 'a'.repeat(64)]) {
        expect(() => {
          core.registerResolver(resolverOf({ ...echo, procedureId: 2, procedureName }));
        }, procedureName).toThrow(/ is off its form: /);
      }

      // its identity before any reason of the router's: a payload limit of 0, at service 0
      expect(() => {
        core.registerResolver(resolverOf({ ...echo, procedureId: 9, maximumPayloadBytes: 0 }));
      }).toThrow(ProgrammerError);
      expect(() => {
        core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes: 0, serviceId: 0 }));
      }).toThrow(/ is out of its range: /);

      core.registerResolver(
        resolverOf({
          ...echo,
          procedureId: 0xffff,
          serviceId: 0xffff,
          serviceRevision: 2 ** 31 - 1,
        })
      );
    });
  });

  test.describe("a request's credential", () => {
    const JWT = Object.freeze({ scheme: CredentialScheme.JWT, token: 'a.b.c' });
    const ELSEWHERE = Object.freeze({ scheme: CredentialScheme.ELSEWHERE });
    const SESSION: ICallSession = Object.freeze({ data: 'ada' });
    const unknown = { ...echo, procedureId: 99 };

    /** What sent says of each failure: its call id, its code and its detail. */
    const failuresOf = (sent: { envelope: Envelope | undefined }[]) => {
      return sent.flatMap(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [[envelope.header.callId, envelope.failure.code, envelope.failure.detail]]
          : [];
      });
    };

    test('of a scheme the side takes none of is refused CREDENTIAL_UNSUPPORTED, naming those it takes, past its route and before it resolves', () => {
      const asked: string[] = [];
      const sessionOf = ({ header }: ISessionRequest<Handle>) => {
        asked.push(`resolve ${String(header.callId)}`);

        return undefined;
      };
      const resolver = Object.assign(resolverOf(echo), {
        admit: ({ header }: IAdmissionRequest<Handle>) => {
          asked.push(`admit ${String(header.callId)}`);

          return undefined;
        },
      });
      const opaqueOnly = createPort({ sessionOf });
      const every = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE, CredentialScheme.JWT],
        sessionOf,
      });
      using first = createRouterCore(opaqueOnly.port);
      using second = createRouterCore(every.port);

      first.registerResolver(resolver);
      second.registerResolver(resolver);

      for (const [callId, credential] of [
        [1, JWT],
        [3, ELSEWHERE],
        [5, { bytes: Uint8Array.of(1, 2), scheme: 0xffff }],
      ] as const) {
        first.receive(requestOf(callId, { credential }), 'a');
      }

      // a scheme to come, to a procedure no route reaches: the route refuses it first
      first.receive(
        requestOf(7, { credential: { bytes: new Uint8Array(0), scheme: 7 }, procedure: unknown }),
        'a'
      );
      second.receive(requestOf(1, { credential: { bytes: new Uint8Array(0), scheme: 4 } }), 'a');
      first.receive(requestOf(11, { credential: { bytes: Uint8Array.of(1, 2), scheme: 7 } }), 'a');
      second.receive(
        requestOf(3, { credential: { bytes: new Uint8Array(0), scheme: 0xffff } }),
        'a'
      );
      first.receive(
        requestOf(9, {
          credential: { bytes: new Uint8Array(0), scheme: 7 },
          procedure: { ...echo, serviceId: 9 },
        }),
        'a'
      );

      expect(failuresOf(opaqueOnly.sent)).toEqual([
        [1, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE'],
        [3, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE'],
        [5, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE'],
        [7, ProtocolCode.PROCEDURE_UNKNOWN, 'no procedure 99 in service 2'],
        [11, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE'],
        [9, ProtocolCode.SERVICE_UNKNOWN, 'no service 9'],
      ]);
      expect(failuresOf(every.sent)).toEqual([
        [1, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE, JWT, ELSEWHERE'],
        [3, ProtocolCode.CREDENTIAL_UNSUPPORTED, 'OPAQUE, JWT, ELSEWHERE'],
      ]);
      expect(asked).toEqual([]);
    });

    test('of none or OPAQUE resolves in the turn it came, the call’s session handed to its admission, then to its resolver', async () => {
      const asked: unknown[] = [];
      const seen: IRequestResolverProps<Handle>[] = [];
      const { port, reported } = createPort({
        sessionOf: ({ connectionHandle, header }, signal) => {
          asked.push([connectionHandle, header.callId, header.credential, signal.aborted]);

          return header.credential === undefined ? undefined : SESSION;
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(resolverOf(echo, seen), {
          admit: ({ header, session }: IAdmissionRequest<Handle>) => {
            asked.push(['admit', header.callId, session]);

            return undefined;
          },
        })
      );
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3, { credential: OPAQUE }), 'b');

      // nothing awaited: each resolved, was admitted and dispatched as it came
      expect(asked).toEqual([
        ['a', 1, undefined, false],
        ['admit', 1, undefined],
        ['b', 3, OPAQUE, false],
        ['admit', 3, SESSION],
      ]);
      expect(
        seen.map(({ header, session }) => {
          return [header.callId, session];
        })
      ).toEqual([
        [1, undefined],
        [3, SESSION],
      ]);
      expect(reported).toEqual([]);

      const resolved: { header: IRequestHeader; connectionHandle: Handle; signal: AbortSignal }[] =
        [];
      const admitted: unknown[] = [];
      const dispatched: IRequestResolverProps<Handle>[] = [];
      const other = createPort({
        sessionOf: ({ header, connectionHandle }, signal) => {
          resolved.push({ header, connectionHandle, signal });
          return { data: header.credential === undefined ? 'none' : 'OPAQUE' };
        },
      });
      using otherCore = createRouterCore(other.port);
      otherCore.registerResolver(
        Object.assign(resolverOf(echo, dispatched), {
          admit: ({ session }: IAdmissionRequest<Handle>) => {
            admitted.push(session?.data);
            return undefined;
          },
        })
      );
      otherCore.receive(requestOf(1), 'a');
      otherCore.receive(requestOf(3, { credential: OPAQUE }), 'a');
      otherCore.receive(requestOf(1), 'a');
      otherCore.receive(requestOf(5, { procedure: { ...echo, serviceId: 9 } }), 'a');
      await sleep(0);
      expect(admitted).toEqual(['none', 'OPAQUE']);
      expect(
        dispatched.map(({ session }) => {
          return session?.data;
        })
      ).toEqual(['none', 'OPAQUE']);
      expect(resolved).toHaveLength(2);
      for (const [index, resolution] of resolved.entries()) {
        expect(resolution.header).toBe(dispatched[index]?.header);
        expect(resolution.connectionHandle).toBe('a');
        expect(resolution.signal).toBe(dispatched[index]?.signal);
      }
    });

    test('that does not resolve is refused SESSION_REQUIRED, whatever its procedure requires, never admitted, an ELSEWHERE as one that came without; none resolving to none runs in none', async () => {
      const admitted: unknown[] = [];
      const resolver = Object.assign(resolverOf(echo), {
        admit: ({ header, session }: IAdmissionRequest<Handle>) => {
          admitted.push([header.callId, session]);

          return undefined;
        },
      });
      const resolving = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE],
        sessionOf: () => {
          return undefined;
        },
      });
      // no sessionOf at all resolves nothing either
      const bare = createPort();
      using first = createRouterCore(resolving.port);
      using second = createRouterCore(bare.port);

      first.registerResolver(resolver);
      second.registerResolver(resolver);
      first.receive(requestOf(1, { credential: OPAQUE }), 'a');
      first.receive(requestOf(3), 'a');
      first.receive(requestOf(5, { credential: ELSEWHERE }), 'a');
      // one its transport carried a credential beside came, and did not hold
      first.receive(
        { credential: 'Interop sub=Ada', data: requestOf(7, { credential: ELSEWHERE }) },
        'a'
      );
      second.receive(requestOf(1, { credential: OPAQUE }), 'a');
      second.receive(requestOf(3), 'a');
      await sleep(0);

      expect(failuresOf(resolving.sent)).toEqual([
        [1, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
        [5, ProtocolCode.SESSION_REQUIRED, 'no credential came'],
        [7, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
      ]);
      expect(failuresOf(bare.sent)).toEqual([
        [1, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
      ]);
      expect(admitted).toEqual([
        [3, undefined],
        [3, undefined],
      ]);

      let heldToken: typeof TOKEN | undefined = TOKEN;
      const fallback = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE],
        sessionOf: ({ header }) => {
          return connectionSessionOf(header.credential, { token: heldToken });
        },
      });
      const fallbackSeen: IRequestResolverProps<Handle>[] = [];
      using fallbackCore = createRouterCore(fallback.port);
      fallbackCore.registerResolver(resolverOf(echo, fallbackSeen));
      fallback.control.sessionTokenOf = () => {
        return TOKEN;
      };
      fallbackCore.receive(
        requestOf(1, {
          credential: {
            scheme: CredentialScheme.OPAQUE,
            token: toSessionToken(
              Uint8Array.from({ length: 16 }, (_, index) => {
                return index;
              })
            ),
          },
        }),
        'a'
      );
      fallbackCore.receive(requestOf(3, { credential: ELSEWHERE }), 'a');
      await sleep(0);
      heldToken = undefined;
      fallback.control.sessionTokenOf = () => {
        return undefined;
      };
      fallbackCore.receive(requestOf(5, { credential: OPAQUE }), 'a');
      fallbackCore.receive(
        { credential: 'Interop sub=ada', data: requestOf(13, { credential: ELSEWHERE }) },
        'a'
      );
      await sleep(0);
      heldToken = TOKEN;
      fallback.control.sessionTokenOf = () => {
        return TOKEN;
      };
      fallbackCore.receive(requestOf(7, { credential: OPAQUE }), 'a');
      fallbackCore.receive(requestOf(9), 'a');
      heldToken = undefined;
      fallback.control.sessionTokenOf = () => {
        return undefined;
      };
      fallbackCore.receive(requestOf(11), 'a');
      expect(failuresOf(fallback.sent)).toEqual([
        [1, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
        [3, ProtocolCode.SESSION_REQUIRED, 'no credential came'],
        [5, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
        [13, ProtocolCode.SESSION_REQUIRED, 'the credential does not hold'],
      ]);
      expect(
        fallbackSeen.map(({ header, session }) => {
          return [header.callId, session !== undefined];
        })
      ).toEqual([
        [7, true],
        [9, true],
        [11, false],
      ]);
    });

    test('whose resolution throws or rejects, or promises for none or OPAQUE, is answered PROCEDURE_FAILED, and reported, a JWT’s in a later turn', async () => {
      const broken = new Error('no verifier answers');
      const admitted: number[] = [];
      const { port, reported, sent } = createPort({
        credentialSchemes: [CredentialScheme.JWT],
        sessionOf: ({ header }) => {
          switch (header.callId) {
            case 1:
            case 7:
              throw broken;
            case 3:
              return Promise.reject(broken);
            default:
              return Promise.resolve(SESSION);
          }
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: ({ header }: IAdmissionRequest<Handle>) => {
            admitted.push(header.callId);

            return undefined;
          },
        })
      );
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3, { credential: JWT }), 'a');
      // a JWT's that throws at once is answered after one presenting OPAQUE that came after it
      core.receive(requestOf(7, { credential: JWT }), 'a');
      core.receive(requestOf(5, { credential: OPAQUE }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 3, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 7, ProtocolCode.PROCEDURE_FAILED],
      ]);
      expect(
        reported.map(([error, connectionHandle]) => {
          return [error === broken ? 'broken' : error.constructor.name, connectionHandle];
        })
      ).toEqual([
        ['broken', 'a'],
        ['ProgrammerError', 'a'],
        ['broken', 'a'],
        ['broken', 'a'],
      ]);
      expect(admitted).toEqual([]);

      const thrown = new Error('the key set cannot be reached');
      const faulted = new Error('the verifier broke');
      const waiting = Promise.withResolvers<ICallSession>();
      const legacy = createPort({
        credentialSchemes: [CredentialScheme.OPAQUE, CredentialScheme.JWT],
        sessionOf: ({ header }) => {
          if (header.callId === 1) {
            throw thrown;
          }
          return header.callId === 3 ? Promise.reject(faulted) : waiting.promise;
        },
      });
      using legacyCore = createRouterCore(legacy.port);
      let admissions = 0;

      legacyCore.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: () => {
            admissions += 1;
            return undefined;
          },
        })
      );
      legacyCore.receive(requestOf(1, { credential: JWT, payload: Uint8Array.of(1) }), 'a');
      legacyCore.receive(requestOf(3, { credential: JWT, payload: Uint8Array.of(1) }), 'a');
      legacyCore.receive(requestOf(5, { credential: OPAQUE, payload: Uint8Array.of(1) }), 'a');
      await sleep(0);
      expect(answersOf(legacy.sent)).toEqual([
        ['a', 'failure', 5, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 1, ProtocolCode.PROCEDURE_FAILED],
        ['a', 'failure', 3, ProtocolCode.PROCEDURE_FAILED],
      ]);
      expect(legacy.reported[0]).toEqual([expect.any(ProgrammerError), 'a']);
      expect(legacy.reported.slice(1)).toEqual([
        [thrown, 'a'],
        [faulted, 'a'],
      ]);
      expect(
        [...sent, ...legacy.sent].map(({ envelope }) => {
          return envelope?.kind === EnvelopeKind.FAILURE ? envelope.failure.detail : undefined;
        })
      ).toEqual(['', '', '', '', '', '', '']);
      waiting.resolve(SESSION);
      await sleep(0);
      expect(legacy.sent).toHaveLength(3);
      expect(legacy.reported).toHaveLength(3);
      expect(admissions).toBe(0);

      // a NONE resolution that waits fails before its result is available too
      const unresolved = Promise.withResolvers<ICallSession>();
      const none = createPort({
        sessionOf: () => {
          return unresolved.promise;
        },
      });
      using noneCore = createRouterCore(none.port);
      let noneAdmissions = 0;

      noneCore.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: () => {
            noneAdmissions += 1;
            return undefined;
          },
        })
      );
      noneCore.receive(requestOf(1), 'a');
      await sleep(0);
      expect(answersOf(none.sent)).toEqual([['a', 'failure', 1, ProtocolCode.PROCEDURE_FAILED]]);
      expect(none.reported).toEqual([[expect.any(ProgrammerError), 'a']]);
      expect(none.sent[0]?.envelope).toMatchObject({ failure: { detail: '' } });
      expect(noneAdmissions).toBe(0);
      unresolved.resolve(SESSION);
      await sleep(0);
      expect(none.sent).toHaveLength(1);
      expect(none.reported).toHaveLength(1);
      expect(noneAdmissions).toBe(0);
    });

    test('whose resolution rejects with a CapacityError is answered CAPACITY_EXCEEDED, its message for detail, and reported nowhere; a FailureError of that code stays PROCEDURE_FAILED, reported', async () => {
      const bounded = new CapacityError('as many calls wait already');
      const thrown = new FailureError(SERVER_FAILURES.capacityExceeded);
      const { port, reported, sent } = createPort({
        credentialSchemes: [CredentialScheme.JWT],
        sessionOf: ({ header }) => {
          return Promise.reject(header.callId === 1 ? bounded : thrown);
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(resolverOf(echo));
      core.receive(requestOf(1, { credential: JWT }), 'a');
      core.receive(requestOf(3, { credential: JWT }), 'a');
      await sleep(0);

      expect(
        sent.map(({ envelope }) => {
          return envelope?.kind === EnvelopeKind.FAILURE
            ? [envelope.header.callId, envelope.failure.code, envelope.failure.detail]
            : envelope;
        })
      ).toEqual([
        [1, ProtocolCode.CAPACITY_EXCEEDED, 'as many calls wait already'],
        [3, ProtocolCode.PROCEDURE_FAILED, ''],
      ]);
      expect(reported).toEqual([[thrown, 'a']]);
    });

    test('answers an admission’s SESSION_REQUIRED to a request that presented a credential ACCESS_DENIED, its detail kept, and to one that presented none SESSION_REQUIRED, whatever its handler', async () => {
      const detailed: IProcedure = { ...echo, procedureId: 4, procedureName: 'detailed' };
      const own: IProcedure = { ...echo, procedureId: 5, procedureName: 'own' };
      const credentials = [undefined, OPAQUE, JWT, ELSEWHERE] as const;

      // a core on each side, its own table, its peer's call ids
      for (const [failures, firstCallId, noneSession] of [
        [SERVER_FAILURES, 1, undefined],
        [SERVER_FAILURES, 1, SESSION],
        [CLIENT_FAILURES, 2, undefined],
        [CLIENT_FAILURES, 2, SESSION],
      ] as const) {
        const { port, reported, sent } = createPort({
          credentialSchemes: [CredentialScheme.ELSEWHERE, CredentialScheme.JWT],
          failures,
          sessionOf: ({ header }) => {
            return header.credential === undefined ? noneSession : SESSION;
          },
        });
        const refusing = (procedure: IProcedure, refusal: IFailure) => {
          return Object.assign(resolverOf(procedure), {
            admit: () => {
              admissions += 1;
              return refusal;
            },
          });
        };
        using core = createRouterCore(port);
        let admissions = 0;
        const expected: unknown[] = [];
        let callId = firstCallId;

        // handlers registered raw, refusing every call: the table's SESSION_REQUIRED, one with a
        // detail of its own, and an application's failure whose code is 32, which is left alone
        core.registerResolver(refusing(echo, failures.sessionRequired));
        core.registerResolver(
          refusing(detailed, { ...failures.sessionRequired, detail: 'sign in first' })
        );
        core.registerResolver(
          refusing(own, { code: 32, detail: 'its own', scope: FailureScope.APPLICATION })
        );

        for (const [procedure, detail] of [
          [echo, ''],
          [detailed, 'sign in first'],
        ] as const) {
          for (const credential of credentials) {
            core.receive(
              {
                data: requestOf(callId, {
                  ...(credential === undefined ? {} : { credential }),
                  procedure,
                }),
                ...(credential === ELSEWHERE ? { credential: 'carried' } : {}),
              },
              'a'
            );
            expected.push([
              callId,
              credential === undefined ? ProtocolCode.SESSION_REQUIRED : ProtocolCode.ACCESS_DENIED,
              FailureScope.PROTOCOL,
              detail,
            ]);
            callId += 2;
          }
        }

        core.receive(requestOf(callId, { credential: JWT, procedure: own }), 'a');
        expected.push([callId, 32, FailureScope.APPLICATION, 'its own']);
        const short = { ...echo, procedureId: 6, procedureName: 'short' };
        const empty = { ...echo, procedureId: 7, procedureName: 'empty' };
        core.registerResolver(
          refusing(short, { ...failures.sessionRequired, detail: 'short of its scope' })
        );
        core.registerResolver(
          refusing(empty, { code: 32, detail: '', scope: FailureScope.APPLICATION })
        );
        for (const credential of credentials) {
          callId += 2;
          core.receive(
            {
              data: requestOf(callId, {
                ...(credential === undefined ? {} : { credential }),
                procedure: short,
              }),
              ...(credential === ELSEWHERE ? { credential: 'carried' } : {}),
            },
            'a'
          );
          expected.push([
            callId,
            credential === undefined ? ProtocolCode.SESSION_REQUIRED : ProtocolCode.ACCESS_DENIED,
            FailureScope.PROTOCOL,
            'short of its scope',
          ]);
        }
        callId += 2;
        core.receive(requestOf(callId, { credential: JWT, procedure: empty }), 'a');
        expected.push([callId, 32, FailureScope.APPLICATION, '']);
        await sleep(0);

        expect(
          sent
            .map(({ envelope }) => {
              return envelope?.kind === EnvelopeKind.FAILURE
                ? [
                    envelope.header.callId,
                    envelope.failure.code,
                    envelope.failure.scope,
                    envelope.failure.detail,
                  ]
                : envelope;
            })
            .toSorted((a, b) => {
              return Number((a as number[])[0]) - Number((b as number[])[0]);
            })
        ).toEqual(expected);
        expect(admissions).toBe(14);
        expect(reported).toEqual([]);
      }
    });

    test('of a JWT or an ELSEWHERE resolves in a later turn, whether its resolution waits or not, its call id held meanwhile', async () => {
      const order: string[] = [];
      const carried: unknown[] = [];
      const { port, reported, sent } = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE, CredentialScheme.JWT],
        // at once, never waiting
        sessionOf: ({ header, transportCredential }) => {
          order.push(`resolve ${String(header.callId)}`);
          carried.push([header.callId, transportCredential]);

          return SESSION;
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: ({ header, session }: IAdmissionRequest<Handle>) => {
            order.push(`admit ${String(header.callId)} ${String(session?.data)}`);

            return undefined;
          },
        })
      );
      core.receive(requestOf(1, { credential: JWT }), 'a');
      core.receive(
        { credential: 'Bearer mF_9.B5f-4.1JqM', data: requestOf(3, { credential: ELSEWHERE }) },
        'a'
      );
      // one presenting none, which came after, goes first
      core.receive(requestOf(5), 'a');
      // the call id of one resolving is open: a request on it is reported, never answered
      core.receive(requestOf(1), 'a');

      expect(order).toEqual(['resolve 1', 'resolve 3', 'resolve 5', 'admit 5 ada']);
      expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);

      await sleep(0);

      expect(order).toEqual([
        'resolve 1',
        'resolve 3',
        'resolve 5',
        'admit 5 ada',
        'admit 1 ada',
        'admit 3 ada',
      ]);
      // the credential an ELSEWHERE stands for is the one its transport carried
      expect(carried).toEqual([
        [1, undefined],
        [3, 'Bearer mF_9.B5f-4.1JqM'],
        [5, undefined],
      ]);
      expect(sent).toEqual([]);
      const gate = Promise.withResolvers<ICallSession | undefined>();
      const admitted: number[] = [];
      const recorded = createPort({
        credentialSchemes: [
          CredentialScheme.OPAQUE,
          CredentialScheme.JWT,
          CredentialScheme.ELSEWHERE,
        ],
        sessionOf: ({ header }) => {
          return header.callId === 9 ? gate.promise : SESSION;
        },
      });
      using held = createRouterCore(recorded.port);

      held.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: ({ header }: IAdmissionRequest<Handle>) => {
            admitted.push(header.callId);
            return undefined;
          },
        })
      );
      held.receive(requestOf(1, { credential: JWT }), 'a');
      held.receive(requestOf(3), 'a');
      held.receive(
        { credential: 'Bearer a.b.c', data: requestOf(5, { credential: ELSEWHERE }) },
        'a'
      );
      held.receive(
        requestOf(7, {
          credential: { scheme: CredentialScheme.OPAQUE, token: toSessionToken(patternOf(16)) },
        }),
        'a'
      );
      expect(admitted).toEqual([3, 7]);
      await sleep(0);
      expect(admitted).toEqual([3, 7, 1, 5]);
      held.receive(requestOf(9, { credential: JWT }), 'a');
      held.receive(requestOf(9, { credential: JWT }), 'a');
      expect(codesOf(recorded.reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      gate.resolve(SESSION);
      await sleep(0);
      expect(admitted).toEqual([3, 7, 1, 5, 9]);
      expect(recorded.sent).toEqual([]);
    });

    test('of a JWT or an ELSEWHERE its handler forwards resolves to none in a later turn all the same, a request presenting none delivered behind it taken first', async () => {
      for (const [destinationId, transported] of [
        [7, 'Bearer a.b.c'],
        [9, 'Bearer mF_9.B5f-4.1JqM'],
      ] as const) {
        const admitted: number[] = [];
        const asked: number[] = [];
        const { port, reported, sent } = createPort({
          credentialSchemes: [CredentialScheme.JWT],
          sessionOf: ({ header }) => {
            asked.push(header.callId);

            return undefined;
          },
        });
        const forwarding: IDestinationHandler<Handle> = Object.assign(
          () => {
            return Promise.resolve();
          },
          {
            admit: ({ header }: IAdmissionRequest<Handle>) => {
              admitted.push(header.callId);

              return undefined;
            },
            forwardsCredentials: true,
          }
        );

        port.handlerOfDestination = () => {
          return forwarding;
        };

        using core = createRouterCore(port);

        // one turn, to a destination: a JWT, none, an ELSEWHERE its transport carried, none
        core.receive(requestOf(1, { credential: JWT, destinationId }), 'a');
        core.receive(requestOf(3, { destinationId }), 'a');
        core.receive(
          {
            credential: transported,
            data: requestOf(5, { credential: ELSEWHERE, destinationId }),
          },
          'a'
        );
        core.receive(requestOf(7, { destinationId }), 'a');

        expect(admitted).toEqual([3, 7]);

        await sleep(0);

        // read from its scheme alone, a forwarded one is never asked of this side's sessionOf
        expect(admitted).toEqual([3, 7, 1, 5]);
        expect(asked).toEqual([3, 7]);
        expect(reported).toEqual([]);
        expect(sent).toEqual([]);
      }
    });

    // spec 13.1
    test('hands a destination’s handler the bearer credentials its call came with, and a resolver neither, its admission neither', async () => {
      const resolved: IRequestResolverProps<Handle>[] = [];
      const admitted: IAdmissionRequest<Handle>[] = [];
      const relayed: (IRequestResolverProps<Handle> & ITransportCarried)[] = [];
      const relayAdmitted: (IAdmissionRequest<Handle> & ITransportCarried)[] = [];
      const destination: IDestinationHandler<Handle> = Object.assign(
        (props: IRequestResolverProps<Handle> & ITransportCarried) => {
          relayed.push(props);

          return Promise.resolve();
        },
        {
          admit: (request: IAdmissionRequest<Handle> & ITransportCarried) => {
            relayAdmitted.push(request);

            return undefined;
          },
          forwardsCredentials: true,
        }
      );
      const { port, reported, sent } = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE, CredentialScheme.JWT],
        handlerOfDestination: () => {
          return destination;
        },
        sessionOf: () => {
          return SESSION;
        },
      });
      using core = createRouterCore(port);
      const resolver: IRequestResolver<Handle> = Object.assign(resolverOf(echo, resolved), {
        admit: (request: IAdmissionRequest<Handle>) => {
          admitted.push(request);

          return undefined;
        },
      });

      core.registerResolver(resolver);

      // each beside what its transport carried: none, a JWT and an ELSEWHERE to a resolver; a JWT
      // and an ELSEWHERE to a destination whose handler forwards them
      for (const data of [
        requestOf(1),
        requestOf(3, { credential: JWT }),
        requestOf(5, { credential: ELSEWHERE }),
        requestOf(7, { credential: JWT, destinationId: 9 }),
        requestOf(9, { credential: ELSEWHERE, destinationId: 9 }),
      ]) {
        core.receive({ credential: 'Bearer e', data }, 'a');
      }

      await sleep(0);

      /** What a handler was handed of its call's credentials, call by call. */
      const credentialsOf = (
        requests: (IAdmissionRequest<Handle> & { transportCredential?: string | undefined })[]
      ): unknown[] => {
        return requests
          .map(({ header: { callId, credential }, session, transportCredential }) => {
            return [callId, credential, transportCredential, session];
          })
          .toSorted(([a], [b]) => {
            return Number(a) - Number(b);
          });
      };
      // a resolver and its admission: no transport's credential, a JWT's scheme alone, its call in
      // the session its JWT resolved to
      const procedure = [
        [1, undefined, undefined, SESSION],
        [3, { scheme: CredentialScheme.JWT }, undefined, SESSION],
        [5, ELSEWHERE, undefined, SESSION],
      ];

      expect(credentialsOf(resolved)).toStrictEqual(procedure);
      expect(credentialsOf(admitted)).toStrictEqual(procedure);
      expect(
        [...resolved, ...admitted].some((request) => {
          return 'transportCredential' in request;
        })
      ).toBe(false);

      // a destination's handler and its admission: the JWT's token whole, what an ELSEWHERE's
      // transport carried, each forwarded unresolved
      const relaying = [
        [7, JWT, undefined, undefined],
        [9, ELSEWHERE, 'Bearer e', undefined],
      ];

      expect(credentialsOf(relayed)).toStrictEqual(relaying);
      expect(credentialsOf(relayAdmitted)).toStrictEqual(relaying);
      expect(reported).toEqual([]);
      expect(sent).toEqual([]);
    });

    // spec 13.1: the TypeScript side's surface, by its entry points and its types, which the C#
    // side's twin holds by reflection
    test('keeps the router core and the transport’s credential out of the public surface', () => {
      // no entry point is the core, nor exports it
      expect(Object.values(PACKAGE.exports)).not.toContain('./src/router/shared/router-core.ts');

      for (const entry of [routerClient, routerServer, serviceManager]) {
        expect(Object.keys(entry)).not.toContain('createRouterCore');
      }

      // ! none of the public types carries a bearer credential, nor a resolver the flag that would
      // forward one
      const resolver: IRequestResolver<Handle> = resolverOf(echo);
      const props: IRequestResolverProps<Handle> = {
        connectionHandle: 'a',
        header: headerOf(1),
        payload: new Uint8Array(),
        signal: new AbortController().signal,
      };
      const request: IAdmissionRequest<Handle> = { connectionHandle: 'a', header: headerOf(1) };
      const sessionRequest: ISessionRequest<Handle> = {
        connectionHandle: 'a',
        header: headerOf(1),
      };

      // @ts-expect-error a resolver is handed no transport's credential
      void props.transportCredential;
      // @ts-expect-error an admission is handed no transport's credential
      void request.transportCredential;
      // @ts-expect-error what sessionOf is asked carries no transport's credential, but the core's
      void sessionRequest.transportCredential;
      // @ts-expect-error a resolver forwards nothing: a destination's handler does
      void resolver.forwardsCredentials;
      expect(
        [props, request, sessionRequest].some((handed) => {
          return 'transportCredential' in handed;
        })
      ).toBe(false);
      expect('forwardsCredentials' in resolver).toBe(false);
    });

    test('hands sessionOf what its transport carried for an ELSEWHERE alone, what came beside any other staying here', async () => {
      const carried: unknown[] = [];
      const { port, reported } = createPort({
        credentialSchemes: [CredentialScheme.ELSEWHERE, CredentialScheme.JWT],
        sessionOf: ({ header, transportCredential }) => {
          carried.push([header.callId, transportCredential]);

          return SESSION;
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(resolverOf(echo));
      core.receive({ credential: 'Bearer a', data: requestOf(1) }, 'a');
      core.receive({ credential: 'Bearer b', data: requestOf(3, { credential: OPAQUE }) }, 'a');
      core.receive({ credential: 'Bearer c', data: requestOf(5, { credential: JWT }) }, 'a');
      core.receive({ credential: 'Bearer d', data: requestOf(7, { credential: ELSEWHERE }) }, 'a');

      await sleep(0);

      expect(carried).toEqual([
        [1, undefined],
        [3, undefined],
        [5, undefined],
        [7, 'Bearer d'],
      ]);
      expect(reported).toEqual([]);
    });

    test('resolving, its call’s cancel or its connection’s close tells sessionOf by the call’s signal, and what it settles to then is dropped', async () => {
      const pending = new Map<number, PromiseWithResolvers<ICallSession | undefined>>();
      const signals = new Map<number, AbortSignal>();
      const admitted: number[] = [];
      const { port, reported, sent } = createPort({
        credentialSchemes: [CredentialScheme.JWT],
        sessionOf: ({ header }, signal) => {
          const resolution = Promise.withResolvers<ICallSession | undefined>();

          pending.set(header.callId, resolution);
          signals.set(header.callId, signal);

          return resolution.promise;
        },
      });
      using core = createRouterCore(port);

      core.registerResolver(
        Object.assign(resolverOf(echo), {
          admit: ({ header }: IAdmissionRequest<Handle>) => {
            admitted.push(header.callId);

            return undefined;
          },
        })
      );
      core.receive(requestOf(1, { credential: JWT }), 'a');
      core.receive(requestOf(3, { credential: JWT }), 'a');
      core.receive(requestOf(5, { credential: JWT }), 'a');
      core.receive(cancelOf(1), 'a');
      core.rejectPending('a closed', 'a');

      expect(signals.get(1)?.reason).toBeInstanceOf(CancelError);
      expect(signals.get(3)?.reason).toBeInstanceOf(DisconnectError);
      expect(signals.get(5)?.reason).toBeInstanceOf(DisconnectError);

      pending.get(1)?.resolve(SESSION);
      pending.get(3)?.reject(new Error('stopped'));
      pending.get(5)?.resolve(undefined);
      await sleep(0);

      // the call id it held is free: a call on it is a new one
      core.receive(requestOf(1, { credential: JWT }), 'a');
      pending.get(1)?.resolve(SESSION);
      await sleep(0);

      expect(sent).toEqual([]);
      expect(reported).toEqual([]);
      expect(admitted).toEqual([1]);

      const waiting: PromiseWithResolvers<ICallSession | undefined>[] = [];
      const resolvingSignals: AbortSignal[] = [];
      const continued: IRequestResolverProps<Handle>[] = [];
      const other = createPort({
        credentialSchemes: [CredentialScheme.JWT],
        sessionOf: ({ header }, signal) => {
          resolvingSignals.push(signal);
          if (header.credential === undefined) {
            return SESSION;
          }
          const resolution = Promise.withResolvers<ICallSession | undefined>();
          waiting.push(resolution);
          return resolution.promise;
        },
      });
      using otherCore = createRouterCore(other.port);
      otherCore.registerResolver(resolverOf(echo, continued));
      otherCore.receive(requestOf(1, { credential: JWT }), 'a');
      expect(resolvingSignals[0]?.aborted).toBe(false);
      otherCore.receive(cancelOf(1), 'a');
      expect(resolvingSignals[0]?.aborted).toBe(true);
      otherCore.receive(requestOf(1), 'a');
      waiting[0]?.resolve(SESSION);
      await sleep(0);
      expect(
        continued.map(({ header }) => {
          return header.callId;
        })
      ).toEqual([1]);
      otherCore.receive(requestOf(3, { credential: JWT }), 'b');
      otherCore.receive(requestOf(5, { credential: JWT }), 'a');
      otherCore.rejectPending('the connection closed', 'b');
      expect(resolvingSignals[2]?.aborted).toBe(true);
      expect(resolvingSignals[3]?.aborted).toBe(false);
      waiting[1]?.reject(new CancelError());
      await sleep(0);
      expect(other.sent).toEqual([]);
      expect(other.reported).toEqual([]);
      expect(continued).toHaveLength(1);
      waiting[2]?.resolve(SESSION);
      await sleep(0);
      expect(
        continued.map(({ header }) => {
          return header.callId;
        })
      ).toEqual([1, 5]);
    });

    test('resolving, a transfer’s opening gets no credit until its resolution and its admission settle', async () => {
      for (const [total, opening] of [
        [100, 8],
        [300, 20],
      ] as const) {
        const resolution = Promise.withResolvers<ICallSession | undefined>();
        const clock = createTestClock();
        let admitted = 0;
        const { port, sent } = createPort({
          credentialSchemes: [CredentialScheme.JWT],
          sessionOf: () => {
            return resolution.promise;
          },
        });
        using core = createRouterCore(port, { clock, limits });

        core.registerResolver(
          Object.assign(resolverOf(echo), {
            admit: () => {
              admitted += 1;
              return undefined;
            },
          })
        );
        core.receive(requestOf(1, { credential: JWT, payload: patternOf(opening), total }), 'a');
        await sleep(0);

        clock.tick(1_000);
        expect(sent).toEqual([]);
        expect(admitted).toBe(0);

        resolution.resolve(SESSION);
        await sleep(0);

        expect(admitted).toBe(1);
        expect(answersOf(sent)).toEqual([['a', 'credit', 1, Math.min(total, opening + 128)]]);
      }
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

      const { anomalies, ceilings, connectionHandles, counts } = core.gauges();

      expect({ anomalies, ceilings, connectionHandles, counts }).toEqual({
        anomalies: [],
        ceilings: { bufferedBytes: LIMIT_DEFAULTS.bufferedBytesBudget, largestAnsweringCalls: 64 },
        connectionHandles: new Set(['a', 'b']),
        counts: {
          abandonedCalls: 0,
          announced: 0,
          answeringCalls: 1,
          bufferedBytes: 0,
          largestAnsweringCalls: 1,
          pendingCalls: 1,
          receivingTransfers: 0,
          reservedCallIds: 0,
          sendingTransfers: 0,
        },
      });

      core.rejectPending('all gone');
      await expect(waiting).rejects.toBeInstanceOf(DisconnectError);

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

      const boundedTold: string[] = [];
      const bounded = createPort({
        beforeAnswer: () => {
          boundedTold.push('before');
          return () => {
            boundedTold.push('undo');
          };
        },
      });
      using boundedCore = createRouterCore(bounded.port);
      const boundedSeen: IRequestResolverProps<Handle>[] = [];
      boundedCore.registerResolver(resolverOf({ ...echo, maximumPayloadBytes: 10 }, boundedSeen));
      bounded.control.sendErrors.set('a', new Error('the transport refused the result'));
      boundedCore.receive(requestOf(1, { payload: Uint8Array.of(1) }), 'a');
      await expect(
        boundedCore.respond({ payload: Uint8Array.of(1) }, boundedSeen[0]!)
      ).rejects.toThrow('the transport refused the result');
      expect(boundedTold).toEqual(['before', 'undo']);
      boundedCore.receive(requestOf(3, { payload: Uint8Array.of(1) }), 'a');
      await expect(
        boundedCore.respond({ payload: new Uint8Array(11) }, boundedSeen[1]!)
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });
      expect(boundedTold).toEqual(['before', 'undo']);
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

    test('trace what goes out and what comes in without its credential, its scheme alone', async () => {
      const headers: unknown[] = [];
      const { control, port, sent } = createPort({
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
          header: { ...headerOf(3), credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' } },
          kind: EnvelopeKind.REQUEST,
          payload: new Uint8Array(0),
        } satisfies OutgoingEnvelope),
        'a'
      );

      // the JWT is refused, a scheme this side takes none of
      expect(headers).toEqual([
        ['tx', { callId: 1, credentialScheme: CredentialScheme.OPAQUE, kind: EnvelopeKind.RESULT }],
        ['rx', { ...headerOf(3), credentialScheme: CredentialScheme.JWT }],
        ['tx', { callId: 3, kind: EnvelopeKind.FAILURE }],
      ]);
      expect(JSON.stringify(headers)).not.toContain(TOKEN);
      expect(JSON.stringify(headers)).not.toContain('a.b.c');
      expect(sent[0]?.envelope?.header).toEqual({
        callId: 1,
        credential: OPAQUE,
        kind: EnvelopeKind.RESULT,
      });

      const firstHeaders: unknown[] = [];
      const first = createPort({
        trace: (direction, { header }) => {
          firstHeaders.push([direction, header]);
        },
      });
      using firstCore = createRouterCore(first.port);
      first.control.sessionTokenOf = () => {
        return TOKEN;
      };
      firstCore.registerResolver(resolverOf(echo));
      firstCore.receive(
        requestOf(1, {
          credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' },
          payload: Uint8Array.of(1),
        }),
        'a'
      );
      expect(firstHeaders).toEqual([
        ['rx', { ...headerOf(1), credentialScheme: CredentialScheme.JWT }],
        [
          'tx',
          { callId: 1, kind: EnvelopeKind.FAILURE, credentialScheme: CredentialScheme.OPAQUE },
        ],
      ]);
      expect(first.sent[0]?.envelope?.header).toEqual({
        callId: 1,
        kind: EnvelopeKind.FAILURE,
        credential: OPAQUE,
      });
      expect(JSON.stringify(firstHeaders)).not.toContain(TOKEN);
      expect(JSON.stringify(firstHeaders)).not.toContain('a.b.c');
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

    test('abort the signal of each call a closing connection opened, and of no other, once nothing can answer it', async () => {
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

    // a connection that closes as each of its resolvers awaits an outgoing call, an answer of its
    // own held for credit: the gauges at each counted end, as the core reads its clock, and what
    // each resolver hears
    const closeAwaiting = async ({ forward, incoming }: { forward: boolean; incoming: number }) => {
      const registry = createMetricsRegistry();
      const metrics = registry.attach('server');
      const clock = createTestClock();
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { clock, limits, metrics });
      const entered = Promise.withResolvers<void>();
      const steps: string[] = [];
      const snapshots: ReturnType<typeof core.gauges>[] = [];
      const answers: Promise<void>[] = [];
      const finished: Promise<void>[] = [];
      // what each resolver's outgoing call rejected with, and whether its signal was aborted then
      const caught: { aborted: boolean; reason: unknown }[] = [];
      // the clock as the core reads it
      const read: Pick<IClock, 'performance'> = clock;
      const monotonicNow = read.performance.now.bind(read.performance);
      // records the state at a counted call's end, as the core reads its clock
      let reading: (() => void) | undefined;

      read.performance.now = () => {
        reading?.();

        return monotonicNow();
      };
      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          const resolved = (async () => {
            props.signal.addEventListener('abort', () => {
              steps.push('incoming-aborted');
            });

            const made = core.request(new Uint8Array(0), {
              connectionHandle: props.connectionHandle,
              options: forward
                ? { signal: props.signal, timeout: Infinity }
                : { timeout: Infinity },
              procedure: echo,
              series: metrics.declareRequester(echo),
            });

            // an incoming result held for credit, while the resolver still awaits its outgoing call
            answers.push(core.respond({ payload: patternOf(200) }, props));

            if (answers.length === incoming) {
              entered.resolve();
            }

            try {
              await made;
            } catch (reason) {
              caught.push({ aborted: props.signal.aborted, reason });
              steps.push('incoming-await-rejected');
            }
          })();

          finished.push(resolved);

          return resolved;
        }, echo)
      );

      // the peer's call ids, odd
      for (let index = 0; index < incoming; index += 1) {
        core.receive(requestOf(2 * index + 1), 'a');
      }

      await entered.promise;

      const before = core.gauges();
      const sentBefore = sent.length;

      reading = () => {
        snapshots.push(core.gauges());
        steps.push(snapshots.length <= incoming ? 'incoming-ended' : 'outgoing-ended');
      };
      core.rejectPending('the connection closed', 'a');
      reading = undefined;

      const atReturn = [...steps];

      await Promise.all(finished);

      const settled = await Promise.allSettled(answers);

      // neither the resolver unwinding nor another close ends its incoming metrics again
      core.rejectPending('closed again', 'a');
      await sleep(0);

      return {
        atReturn,
        before,
        caught,
        reported,
        sentAfter: sent.slice(sentBefore),
        settled,
        snapshots,
        steps,
        text: registry.exposition().text,
      };
    };

    // what a connection's close leaves of one call it answered and the call its resolver made
    const expectClosedOnce = (text: string) => {
      expect(text).toContain(
        'bead_server_call_handled_total{service="2",procedure="echo",type="request",outcome="closed"} 1\n'
      );
      expect(text).toContain(
        'bead_server_call_duration_seconds_count{service="2",procedure="echo",type="request"} 1\n'
      );
      expect(text).toContain(
        'bead_client_call_handled_total{service="2",procedure="echo",type="command",outcome="closed"} 1\n'
      );
      expect(text).not.toMatch(/outcome="cancelled"\} [1-9]/);
    };

    // every transfer went with the calls, before any end was counted
    const expectDetached = (snapshots: { counts: Record<string, number> }[]) => {
      for (const { counts } of snapshots) {
        expect(counts).toMatchObject({
          answeringCalls: 0,
          pendingCalls: 0,
          receivingTransfers: 0,
          sendingTransfers: 0,
        });
      }
    };

    test('detach calls before settling an incoming resolver awaiting an outgoing call, and count its incoming close once', async () => {
      const { atReturn, before, caught, reported, sentAfter, settled, snapshots, steps, text } =
        await closeAwaiting({ forward: false, incoming: 1 });

      expect(before.counts).toMatchObject({
        answeringCalls: 1,
        pendingCalls: 1,
        sendingTransfers: 1,
      });
      expect(snapshots).toHaveLength(2);
      expectDetached(snapshots);
      expect(atReturn).toEqual(['incoming-ended', 'outgoing-ended', 'incoming-aborted']);
      expect(steps).toEqual([
        'incoming-ended',
        'outgoing-ended',
        'incoming-aborted',
        'incoming-await-rejected',
      ]);
      // the resolver hears its signal before its call's rejection
      expect(caught).toEqual([{ aborted: true, reason: expect.any(DisconnectError) }]);
      expect(settled).toEqual([{ reason: expect.any(DisconnectError), status: 'rejected' }]);
      expectClosedOnce(text);
      expect(sentAfter).toEqual([]);
      expect(reported).toEqual([]);
    });

    // debugging 9.7
    test('detach calls before settling an incoming resolver awaiting an outgoing call given its signal, and fail that call as closed, never as a cancel', async () => {
      const { atReturn, before, caught, reported, sentAfter, settled, snapshots, steps, text } =
        await closeAwaiting({ forward: true, incoming: 1 });

      expect(before.counts).toMatchObject({
        answeringCalls: 1,
        pendingCalls: 1,
        sendingTransfers: 1,
      });
      expect(snapshots).toHaveLength(2);
      expectDetached(snapshots);
      expect(atReturn).toEqual(['incoming-ended', 'outgoing-ended', 'incoming-aborted']);
      expect(steps).toEqual([
        'incoming-ended',
        'outgoing-ended',
        'incoming-aborted',
        'incoming-await-rejected',
      ]);
      // ! the signal is aborted once the call it was given is rejected: aborted first, it would
      // fail that call as a cancel
      expect(caught).toEqual([{ aborted: true, reason: expect.any(DisconnectError) }]);
      expect(caught[0]?.reason).not.toBeInstanceOf(CancelError);
      expect(settled).toEqual([{ reason: expect.any(DisconnectError), status: 'rejected' }]);
      expectClosedOnce(text);
      expect(sentAfter).toEqual([]);
      expect(reported).toEqual([]);
    });

    test('detach every transfer of a closing connection before counting any of its calls, two incoming calls each answering as a transfer', async () => {
      const { before, reported, sentAfter, snapshots } = await closeAwaiting({
        forward: false,
        incoming: 2,
      });

      expect(before.counts).toMatchObject({
        answeringCalls: 2,
        pendingCalls: 2,
        sendingTransfers: 2,
      });
      // each call answered and each call made
      expect(snapshots).toHaveLength(4);
      expectDetached(snapshots);
      expect(sentAfter).toEqual([]);
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
    expect(piecesOf(sent)).toEqual([[EnvelopeKind.REQUEST, 2, undefined, 0]]);
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

    const client = createPort({ failures: CLIENT_FAILURES });
    const clientCore = createRouterCore(client.port);
    const asked = clientCore.request(Uint8Array.of(1), {
      connectionHandle: 'a',
      options: { timeout: 5_000 },
      procedure: echo,
    });

    expect(clientCore.isDisposed).toBe(false);
    clientCore[Symbol.dispose]();
    expect(clientCore.isDisposed).toBe(true);
    await expect(asked).rejects.toThrow(
      new DisconnectError('the router was disposed before the answer')
    );
    await expect(
      clientCore.respond(
        { payload: Uint8Array.of(1) },
        {
          connectionHandle: 'a',
          header: headerOf(2),
        }
      )
    ).rejects.toBeInstanceOf(DisconnectError);
    await expect(
      clientCore.send(
        {
          header: { callId: 2, kind: EnvelopeKind.RESULT },
          kind: EnvelopeKind.RESULT,
          payload: Uint8Array.of(1),
        },
        'a'
      )
    ).rejects.toBeInstanceOf(DisconnectError);
    clientCore.cancel({ callId: 3, connectionHandle: 'a' });
    await sleep(0);
    expect(answersOf(client.sent)).toEqual([['a', EnvelopeKind.REQUEST, 1]]);
    expect(client.reported).toEqual([]);
    expect(clientCore.gauges().counts['reservedCallIds']).toBe(0);
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

      const same = createPort();
      using sameCore = createRouterCore(same.port, { limits: { ...limits, maximumTransfers: 1 } });
      const sameSeen: IRequestResolverProps<Handle>[] = [];
      sameCore.registerResolver(resolverOf(echo, sameSeen));
      sameCore.receive(requestOf(1, { payload: payload.subarray(0, 44), total: 100 }), 'a');
      sameCore.receive(
        chunkOf(1, { offset: 44, payload: payload.subarray(44, 92), total: 100 }),
        'a'
      );
      sameCore.receive(chunkOf(1, { offset: 92, payload: payload.subarray(92), total: 100 }), 'a');
      sameCore.receive(requestOf(3, { payload: payload.subarray(0, 44), total: 100 }), 'a');
      await sameCore.respond({ payload: Uint8Array.of(1) }, sameSeen[0]!);
      sameCore.receive(requestOf(5, { payload: payload.subarray(0, 44), total: 100 }), 'a');
      expect(answersOf(same.sent)).toEqual([
        ['a', 'credit', 1, 100],
        ['a', 'failure', 3, ProtocolCode.CAPACITY_EXCEEDED],
        ['a', 'result', 1, [1]],
        ['a', 'credit', 5, 100],
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

      const same = createPort();
      using sameCore = createRouterCore(same.port, {
        limits: { ...limits, bufferedBytesBudget: 256, maximumPayloadBytes: 256 },
      });
      sameCore.registerResolver(resolverOf(echo));
      const whole = patternOf(200);
      sameCore.receive(requestOf(1, { payload: whole.subarray(0, 44), total: 200 }), 'a');
      sameCore.receive(requestOf(3, { payload: whole.subarray(0, 44), total: 200 }), 'a');
      expect(answersOf(same.sent)).toEqual([['a', 'credit', 1, 172]]);
      for (const offset of [44, 92]) {
        sameCore.receive(
          chunkOf(1, { offset, payload: whole.subarray(offset, offset + 48), total: 200 }),
          'a'
        );
      }
      expect(answersOf(same.sent)).toEqual([
        ['a', 'credit', 1, 172],
        ['a', 'credit', 1, 200],
      ]);
      for (const offset of [140, 188]) {
        sameCore.receive(
          chunkOf(1, { offset, payload: whole.subarray(offset, offset + 48), total: 200 }),
          'a'
        );
      }
      expect(answersOf(same.sent)).toEqual([
        ['a', 'credit', 1, 172],
        ['a', 'credit', 1, 200],
        ['a', 'credit', 3, 172],
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

    test('report a chunk no transfer takes, on a call open without one or on none, and drop one on a call id reserved and a credit in silence', async () => {
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
      core.reserve({ callId: 6, connectionHandle: 'a', timeout: 5_000 });

      // the peer's call open, and none; this side's, then none; then one on a call id reserved
      for (const callId of [1, 3, 2, 4, 6]) {
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
      expect(reported[0]?.[0].message).toContain('call 1 receives no transfer');
      expect(reported[2]?.[0].message).toContain('call 2 receives no transfer');
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
        origin: 'local',
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
      expect(
        seen.map(({ header, payload: bytes }) => {
          return [header.callId, header.total, bytes];
        })
      ).toEqual([[3, 60, payload.subarray(0, 60)]]);

      // a chunk whose offset is above the largest safe integer does not read either
      const unreadableOf = (callId: number) => {
        return fromHexadecimal(
          `A1 14 40 04  00 00 00 0${String(callId)}  00 20 00 00 00 00 00 00  01`
        );
      };
      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port, { limits });
      const asked = clientCore.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: echo,
      });

      await sleep(0);
      clientCore.receive(resultOpeningOf(1, { payload: patternOf(32), total: 300 }), 'a');
      clientCore.receive(unreadableOf(1), 'a');
      await expect(asked).rejects.toMatchObject({
        code: ProtocolCode.CHUNK_INVALID,
        origin: 'local',
        side: 'client',
      });
      expect(answersOf(client.sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 1],
        ['a', 'credit', 1, 160],
        ['a', EnvelopeKind.CANCEL, 1],
      ]);

      clientCore.receive(unreadableOf(1), 'a');
      expect(client.reported).toEqual([]);
      clientCore.receive(unreadableOf(5), 'a');
      expect(codesOf(client.reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);

      const server = createPort();
      using serverCore = createRouterCore(server.port, { limits });
      const received: IRequestResolverProps<Handle>[] = [];
      const whole = patternOf(100);

      serverCore.registerResolver(resolverOf(echo, received));
      serverCore.receive(requestOf(1, { payload: whole.subarray(0, 44), total: 100 }), 'a');
      serverCore.receive(
        chunkOf(1, { offset: 44, payload: whole.subarray(44, 92), total: 100 }),
        'a'
      );
      serverCore.receive(chunkOf(1, { offset: 92, payload: whole.subarray(92), total: 100 }), 'a');
      serverCore.receive(unreadableOf(1), 'a');
      expect(codesOf(server.reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      serverCore.receive(requestOf(3, { payload: whole.subarray(0, 44), total: 100 }), 'a');
      serverCore.receive(
        chunkOf(3, { offset: 44, payload: whole.subarray(44, 64), total: 100 }),
        'a'
      );
      serverCore.receive(unreadableOf(3), 'a');
      expect(codesOf(server.reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      serverCore.receive(unreadableOf(5), 'a');
      await sleep(0);

      expect(codesOf(server.reported)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
        [ProtocolCode.ENVELOPE_MALFORMED, 'a'],
      ]);
      expect(answersOf(server.sent)).toEqual([
        ['a', 'credit', 1, 100],
        ['a', 'credit', 3, 100],
        ['a', 'failure', 3, ProtocolCode.CHUNK_INVALID],
      ]);
      expect(
        received.map(({ header, payload: bytes }) => {
          return [header.callId, bytes];
        })
      ).toEqual([[1, whole]]);
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

      await expect(asking).rejects.toMatchObject({
        message: 'no answer came in 250 milliseconds',
        name: 'TimeoutError',
        timeout: 250,
      });
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
      const progressClock = createTestClock();
      const progressed = createPort();
      const received: IRequestResolverProps<Handle>[] = [];
      using progressing = createRouterCore(progressed.port, {
        clock: progressClock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      progressing.registerResolver(resolverOf(echo, received));
      const payload = patternOf(300);
      progressing.receive(requestOf(1, { payload: payload.subarray(0, 44), total: 300 }), 'a');
      progressClock.tick(1_500);
      progressing.receive(
        chunkOf(1, { offset: 44, payload: payload.subarray(44, 92), total: 300 }),
        'a'
      );
      progressClock.tick(1_500);
      expect(
        answersOf(progressed.sent).filter((row) => {
          return row[1] === 'failure';
        })
      ).toEqual([]);
      progressClock.tick(500);
      await sleep(0);
      expect(answersOf(progressed.sent)).toEqual([
        ['a', 'credit', 1, 172],
        ['a', 'failure', 1, ProtocolCode.TRANSFER_STALLED],
      ]);
      expect(received).toEqual([]);
      expect(progressed.reported).toEqual([]);

      const clientClock = createTestClock();
      const client = createPort({ failures: CLIENT_FAILURES });
      using requesting = createRouterCore(client.port, {
        clock: clientClock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const requested = requesting.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: Infinity },
        procedure: echo,
      });
      requesting.receive(resultOpeningOf(1, { payload: payload.subarray(0, 32), total: 300 }), 'a');
      clientClock.tick(2_000);
      await expect(requested).rejects.toMatchObject({
        message: 'no answer came in 2000 milliseconds',
        name: 'TimeoutError',
        timeout: 2_000,
      });
      await sleep(0);
      expect(answersOf(client.sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 1],
        ['a', 'credit', 1, 160],
        ['a', EnvelopeKind.CANCEL, 1],
      ]);
      expect(client.reported).toEqual([]);
    });

    // spec 12.10
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

      const same = createPort();
      const sameCore = createRouterCore(same.port, {
        limits: { ...limits, bufferedBytesBudget: 256, maximumPayloadBytes: 256 },
      });
      sameCore.registerResolver(resolverOf(echo));
      const payload = patternOf(200);
      sameCore.receive(requestOf(1, { payload: payload.subarray(0, 44), total: 200 }), 'a');
      sameCore.receive(requestOf(3, { payload: payload.subarray(0, 44), total: 200 }), 'a');
      sameCore.rejectPending('the connection closed', 'a');
      expect(answersOf(same.sent)).toEqual([['a', 'credit', 1, 172]]);
      sameCore[Symbol.dispose]();
      sameCore.receive(requestOf(5, { payload: payload.subarray(0, 44), total: 200 }), 'a');
      expect(answersOf(same.sent)).toEqual([['a', 'credit', 1, 172]]);
    });

    test('stall no request whose payload came whole, however long its resolver takes', async () => {
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

      const whole = createPort();
      const wholeClock = createTestClock();
      using wholeCore = createRouterCore(whole.port, {
        clock: wholeClock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const seen: IRequestResolverProps<Handle>[] = [];
      const payload = patternOf(100);
      wholeCore.registerResolver(resolverOf(echo, seen));
      wholeCore.receive(requestOf(1, { payload: payload.subarray(0, 44), total: 100 }), 'a');
      wholeCore.receive(
        chunkOf(1, { offset: 44, payload: payload.subarray(44, 92), total: 100 }),
        'a'
      );
      wholeCore.receive(chunkOf(1, { offset: 92, payload: payload.subarray(92), total: 100 }), 'a');
      expect(seen[0]?.payload).toEqual(payload);
      wholeClock.tick(10_000);
      wholeCore.receive(chunkOf(1, { offset: 100, payload: Uint8Array.of(1), total: 101 }), 'a');
      expect(codesOf(whole.reported)).toEqual([[ProtocolCode.CHUNK_INVALID, 'a']]);
      expect(answersOf(whole.sent)).toEqual([['a', 'credit', 1, 100]]);
      await wholeCore.respond({ payload: Uint8Array.of(1) }, seen[0]!);
      expect(answersOf(whole.sent)).toEqual([
        ['a', 'credit', 1, 100],
        ['a', 'result', 1, [1]],
      ]);
    });

    test('refuses the opening of a sender whose chunkBytes is larger than its own ENVELOPE_TOO_LARGE, and the chunks of one whose chunkBytes is smaller CHUNK_INVALID, both ends setting their limits alike', async () => {
      const payload = patternOf(300);

      for (const [requester, receiver, chunks, code, detail] of [
        // its opening of 128 bytes past the receiver's request of 64 at most, nothing credited
        [
          { chunkBytes: 128, windowBytes: 256 },
          { chunkBytes: 64, windowBytes: 128 },
          undefined,
          ProtocolCode.ENVELOPE_TOO_LARGE,
          'a request is 64 bytes at most, not 128',
        ],
        // its chunks of 48 under the receiver's full of 112, every one under the credit
        [
          { chunkBytes: 64, windowBytes: 128 },
          { chunkBytes: 128, windowBytes: 256 },
          [48, 48, 48, 48, 48, 16],
          ProtocolCode.CHUNK_INVALID,
          'a chunk before the last carries 112 bytes, not 48',
        ],
      ] as const) {
        const loop = createLoopback({ limits: requester, serverLimits: receiver });
        const heard: string[] = [];

        loop.server.registerResolver(
          Object.assign((props: IRequestResolverProps<'a'>) => {
            heard.push(digestOf(props.payload));

            return Promise.resolve();
          }, echo)
        );

        const failed = loop.client
          .request(payload, { connectionHandle: 'server', options, procedure: echo })
          .catch((error: unknown) => {
            return error;
          });

        await loop.flush();

        const label = `${String(requester.chunkBytes)} to ${String(receiver.chunkBytes)}`;

        expect(await failed, label).toMatchObject({ code, detail, origin: 'peer' });
        // the opening refused; or taken and credited, then the first chunk refused
        expect(
          loop.traffic.sent.map(({ bytes, to }) => {
            return [to, bytes[1], bytes.length];
          }),
          label
        ).toEqual([
          ['server', EnvelopeKind.REQUEST, requester.chunkBytes],
          ...(chunks === undefined
            ? []
            : [
                ['client', EnvelopeKind.CREDIT, 16],
                ...chunks.map((bytes) => {
                  return ['server', EnvelopeKind.CHUNK, 16 + bytes];
                }),
              ]),
          ['client', EnvelopeKind.FAILURE, expect.any(Number)],
        ]);
        expect(heard, label).toEqual([]);

        loop.client[Symbol.dispose]();
        loop.server[Symbol.dispose]();
      }
    });
  });

  test.describe('the transfers it sends', () => {
    test('send a result as a transfer, its call held open until its last chunk is handed off', async () => {
      for (const total of [100, 150]) {
        const answering = createAnswering();
        using core = answering.core;
        const { reported, seen, sent, sizes } = answering;
        const payload = patternOf(total);
        let isAnswered = false;

        core.receive(requestOf(1), 'a');

        const responding = answerOf(answering, { payload }).then(() => {
          isAnswered = true;
        });

        // its call is open still: the same call id is refused
        core.receive(requestOf(1), 'a');
        core.receive(creditOf(1, total === 100 ? 76 : 80), 'a');
        await sleep(0);

        expect(isAnswered).toBe(false);

        core.receive(creditOf(1, total), 'a');
        await responding;
        // answered: a request on its call id is dispatched
        core.receive(requestOf(1), 'a');

        expect(seen).toHaveLength(2);
        expect(piecesOf(sent)).toEqual(
          total === 100
            ? [
                [EnvelopeKind.RESULT, 1, 100, 28],
                [EnvelopeKind.CHUNK, 1, 28, 48],
                [EnvelopeKind.CHUNK, 1, 76, 24],
              ]
            : [
                [EnvelopeKind.RESULT, 1, 150, 28],
                [EnvelopeKind.CHUNK, 1, 28, 48],
                [EnvelopeKind.CHUNK, 1, 76, 48],
                [EnvelopeKind.CHUNK, 1, 124, 26],
              ]
        );
        expect(payloadOf(sent, 1)).toEqual(payload);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
        expect(sizes).toEqual(total === 100 ? [44, 64, 40] : [44, 64, 64, 42]);
        expect(
          sent.flatMap(({ envelope }) => {
            return envelope?.kind === EnvelopeKind.CHUNK ? [envelope.header.isLast] : [];
          })
        ).toEqual(total === 100 ? [false, true] : [false, false, true]);
        expect(codesOf(reported)).toEqual([[ProtocolCode.ENVELOPE_MALFORMED, 'a']]);
      }
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
        [EnvelopeKind.RESULT, 1, 200, 28],
        [EnvelopeKind.CHUNK, 1, 28, 48],
        [EnvelopeKind.CHUNK, 1, 76, 48],
        [EnvelopeKind.CHUNK, 1, 124, 48],
        [EnvelopeKind.CHUNK, 1, 172, 28],
      ]);
      expect([payloadOf(sent, 2), payloadOf(sent, 1)]).toEqual([payload, payload]);
      // the chunks go inside the opening's send, whose credit came back as it went, and one after the
      // other: a credit that comes as a chunk goes only raises the end, and no chunk goes inside another
      expect(deepest).toBe(2);
      expect(reported).toEqual([]);
    });

    test('stop a result the peer cancels, and send nothing more of it, whatever credit comes', async () => {
      for (const [total, initialCredit] of [
        [100, undefined],
        [150, 80],
      ] as const) {
        const answering = createAnswering();
        using core = answering.core;
        const { reported, seen, sent } = answering;

        core.receive(
          requestOf(1, { payload: total === 100 ? Uint8Array.of(1) : new Uint8Array(0) }),
          'a'
        );

        const responding = answerOf(answering, { payload: patternOf(total) });

        if (initialCredit !== undefined) {
          core.receive(creditOf(1, initialCredit), 'a');
        }
        core.receive(cancelOf(1), 'a');
        core.receive(creditOf(1, total), 'a');

        await expect(responding).rejects.toBeInstanceOf(CancelError);
        expect(seen[0]?.signal.aborted).toBe(true);
        expect(piecesOf(sent)).toEqual([
          [EnvelopeKind.RESULT, 1, total, 28],
          ...(initialCredit === undefined ? [] : [[EnvelopeKind.CHUNK, 1, 28, 48]]),
        ]);
        expect(payloadOf(sent, 1)).toEqual(
          new Uint8Array(total).map((_, index) => {
            return index < (initialCredit === undefined ? 28 : 76) ? (index * 7 + 3) % 256 : 0;
          })
        );
        expect(reported).toEqual([]);
      }
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
        [EnvelopeKind.RESULT, 1, 150, 28],
        [EnvelopeKind.CHUNK, 1, 28, 48],
      ]);
      expect(codesOf(reported)).toEqual([['failed behind its answer', 'a']]);
    });

    test('free the call of an answer that could not go out, so its call id opens again', async () => {
      for (const message of ['the transport is closing', 'the transport refused the result']) {
        const { port, reported } = createPort();
        const seen: IRequestResolverProps<Handle>[] = [];
        let isRefusing = true;
        const refused = new Error(message);
        using core = createRouterCore(
          {
            ...port,
            // a transport that throws as it is handed the first answer
            send: (message, connectionHandle) => {
              if (isRefusing && message.data[1] === EnvelopeKind.RESULT) {
                isRefusing = false;

                throw refused;
              }

              return port.send(message, connectionHandle);
            },
          },
          { limits }
        );

        core.registerResolver(resolverOf(echo, seen));
        core.receive(
          requestOf(1, {
            payload: message === 'the transport is closing' ? new Uint8Array(0) : Uint8Array.of(1),
          }),
          'a'
        );

        await expect(answerOf({ core, seen }, { payload: Uint8Array.of(1) })).rejects.toThrow(
          message
        );

        core.receive(
          requestOf(1, {
            payload: message === 'the transport is closing' ? new Uint8Array(0) : Uint8Array.of(2),
          }),
          'a'
        );

        expect(seen).toHaveLength(2);
        expect(reported).toEqual([]);
      }
    });

    test('end a result whose chunk cannot go out, forgetting its call', async () => {
      for (const [total, credit, message] of [
        [150, 80, 'gone'],
        [100, 100, 'the transport refused the chunk'],
      ] as const) {
        const answering = createAnswering();
        using core = answering.core;
        const { control, reported, seen } = answering;

        core.receive(
          requestOf(1, { payload: total === 150 ? new Uint8Array(0) : Uint8Array.of(1) }),
          'a'
        );

        const responding = answerOf(answering, { payload: patternOf(total) });

        const refused = new Error(message);

        control.sendErrors.set('a', refused);
        core.receive(creditOf(1, credit), 'a');

        await expect(responding).rejects.toBe(refused);

        // forgotten: a request on its call id is dispatched
        core.receive(
          requestOf(1, { payload: total === 150 ? new Uint8Array(0) : Uint8Array.of(2) }),
          'a'
        );

        expect(seen).toHaveLength(2);
        expect(reported).toEqual([]);
        await expect(responding).rejects.toThrow(message);
      }
    });

    test('end a result whose opening cannot go out, forgetting its call', async () => {
      const answering = createAnswering();
      using core = answering.core;
      const { control, reported, seen, sent } = answering;
      const refused = new Error('the transport refused the opening');

      core.receive(requestOf(1, { payload: Uint8Array.of(1) }), 'a');
      control.sendErrors.set('a', refused);

      await expect(answerOf(answering, { payload: patternOf(100) })).rejects.toBe(refused);
      expect(piecesOf(sent)).toEqual([[EnvelopeKind.RESULT, 1, 100, 28]]);

      // forgotten: a request on its call id is dispatched
      control.sendErrors.delete('a');
      core.receive(requestOf(1, { payload: Uint8Array.of(2) }), 'a');

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

      await expect(asking).rejects.toMatchObject({
        message: 'no answer came in 250 milliseconds',
        name: 'TimeoutError',
        timeout: 250,
      });
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
      const clientClock = createTestClock();
      const client = createPort({ failures: CLIENT_FAILURES });
      using requesting = createRouterCore(client.port, {
        clock: clientClock,
        limits: { ...limits, transferInactivityTimeout: 2_000 },
      });
      const request = requesting.request(patternOf(300), {
        connectionHandle: 'a',
        options: { timeout: Infinity },
        procedure: echo,
      });
      clientClock.tick(2_000);
      await expect(request).rejects.toMatchObject({
        message: 'no answer came in 2000 milliseconds',
        name: 'TimeoutError',
        timeout: 2_000,
      });
      await sleep(0);
      expect(answersOf(client.sent)).toEqual([
        ['a', EnvelopeKind.REQUEST, 1],
        ['a', EnvelopeKind.CANCEL, 1],
      ]);
      expect(client.reported).toEqual([]);

      const result = createAnswering({ transferInactivityTimeout: 2_000 });
      using answeringResult = result.core;
      answeringResult.receive(requestOf(1, { payload: Uint8Array.of(1) }), 'a');
      const answer = answerOf(result, { payload: patternOf(300) });
      result.clock.tick(2_000);
      await expect(answer).rejects.toMatchObject({ code: ProtocolCode.TRANSFER_STALLED });
      await sleep(0);
      expect(
        result.sent.map(({ envelope }) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.RESULT, 1],
        [EnvelopeKind.FAILURE, 1],
      ]);
      expect(answersOf(result.sent).at(-1)).toEqual([
        'a',
        'failure',
        1,
        ProtocolCode.TRANSFER_STALLED,
      ]);
      answeringResult.receive(requestOf(1, { payload: Uint8Array.of(2) }), 'a');
      expect(result.seen).toHaveLength(2);
      expect(result.reported).toEqual([]);
      expect(
        sent.map(({ envelope }) => {
          return [envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [EnvelopeKind.REQUEST, 2],
        [EnvelopeKind.RESULT, 1],
        [EnvelopeKind.CANCEL, 2],
        [EnvelopeKind.FAILURE, 1],
      ]);
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
        core.respond({ payload: new Uint8Array(37) }, subscribing)
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: "a subscription's result goes in one envelope, of 64 bytes at most",
      });
      await expect(
        core.respond(
          { payload: new Uint8Array(37) },
          { connectionHandle: 'a', header: headerOf(3) }
        )
      ).rejects.toBeInstanceOf(ProgrammerError);
      // in one envelope, it goes
      await core.respond({ payload: new Uint8Array(36) }, subscribing);

      expect(told).toEqual(['told']);
      expect(piecesOf(sent)).toEqual([[EnvelopeKind.RESULT, 1, undefined, 36]]);

      const rejected = createPort();
      using rejectedCore = createRouterCore(rejected.port, { limits });
      const rejectedSeen: IRequestResolverProps<Handle>[] = [];
      rejectedCore.registerResolver(resolverOf(echo, rejectedSeen));
      rejectedCore.receive(
        requestOf(1, { opensSubscription: true, payload: Uint8Array.of(1) }),
        'a'
      );
      await expect(
        rejectedCore.respond({ payload: patternOf(100) }, rejectedSeen[0]!)
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });
      await expect(
        rejectedCore.respond(
          { payload: patternOf(100) },
          { connectionHandle: 'a', header: headerOf(3) }
        )
      ).rejects.toBeInstanceOf(ProgrammerError);
      expect(rejected.sent).toEqual([]);
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

      expect(sizes).toEqual([64, 64, 40]);
      expect(sent[0]?.envelope?.kind === EnvelopeKind.RESULT && sent[0].envelope.header).toEqual({
        callId: 1,
        credential: OPAQUE,
        kind: EnvelopeKind.RESULT,
        total: 100,
      });
    });

    // spec 12.10
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
        [EnvelopeKind.RESULT, 1, 150, 28],
      ]);
      expect(reported).toEqual([]);

      for (const dispose of [false, true]) {
        const other = createPort({ failures: CLIENT_FAILURES });
        const otherCore = createRouterCore(other.port, { limits });
        const asked = settledOf(
          otherCore.request(patternOf(300), {
            connectionHandle: 'a',
            procedure: echo,
            options: { timeout: 5_000 },
          })
        );
        if (dispose) {
          otherCore[Symbol.dispose]();
        } else {
          otherCore.rejectPending('the connection closed', 'a');
        }
        expect(await asked).toBeInstanceOf(DisconnectError);
        otherCore.receive(creditOf(1, 300), 'a');
        expect(piecesOf(other.sent)).toEqual([[EnvelopeKind.REQUEST, 1, 300, 44]]);
        otherCore[Symbol.dispose]();
      }
    });
  });

  test.describe('its metrics', () => {
    const answered = lineOf('bead_server_call_', 'service="2",procedure="echo",type="request"');

    // debugging 9.2 and 9.4.21
    test('count a call answered whose answer its transport throws on as an error, and one its transport rejects once it has it as answered', async () => {
      const registry = createMetricsRegistry();
      const metrics = registry.attach('server');
      const refusal = { isThrown: true };
      const { port } = createPort({
        send: () => {
          if (refusal.isThrown) {
            throw new Error('this transport refuses, as it is handed it');
          }

          return Promise.reject(new Error('this transport refuses, once it has it'));
        },
      });
      using core = createRouterCore(port, { clock: createTestClock(), metrics });
      const answers: Promise<unknown>[] = [];

      core.registerResolver(
        Object.assign((props: IRequestResolverProps<Handle>) => {
          answers.push(core.respond({ payload: new Uint8Array(0) }, props).catch(noop));

          return Promise.resolve();
        }, echo)
      );

      core.receive(requestOf(1), 'a');
      await Promise.all(answers);

      refusal.isThrown = false;
      core.receive(requestOf(3), 'a');
      await Promise.all(answers);

      expect(countedOf(registry)).toEqual([
        answered('duration_seconds_count{} 2'),
        answered('handled_total{outcome="result"} 1'),
        answered('handled_total{outcome="error"} 1'),
        answered('started_total{} 2'),
      ]);
    });

    // debugging 3.3 and 3.4
    test('read the monotonic clock twice more for a counted call than for one counted nothing, once at each of its gates, and the wall clock never', async () => {
      // the readings of each kind a call answered, then a call made, take
      const readingsOf = async (isCounted: boolean): Promise<number[][]> => {
        const clock = createTestClock();
        const { port } = createPort();
        const metrics = isCounted ? createMetricsRegistry().attach('server') : undefined;
        using core = createRouterCore(port, { clock, metrics });
        const read = () => {
          return [clock.readings.monotonic, clock.readings.wall];
        };
        const since = (from: number[], to: number[]) => {
          return to.map((reading, index) => {
            return reading - (from[index] ?? 0);
          });
        };

        core.registerResolver(
          Object.assign((props: IRequestResolverProps<Handle>) => {
            return core.respond({ payload: new Uint8Array(0) }, props);
          }, echo)
        );

        // a call answered, then a call made
        const before = read();

        core.receive(requestOf(1), 'a');
        await sleep(0);

        const between = read();
        const asking = core.request(new Uint8Array(0), {
          connectionHandle: 'a',
          options,
          procedure: echo,
          series: metrics?.declareRequester(echo),
        });

        core.receive(resultOf(2), 'a');
        await asking;

        return [since(before, between), since(between, read())];
      };
      const uncounted = await readingsOf(false);
      expect(uncounted).toEqual([
        [0, 0],
        [0, 0],
      ]);

      // * two more of the monotonic clock, and not one more of the wall clock (spec/debugging.md 3.3)
      expect(await readingsOf(true)).toEqual(
        uncounted.map(([monotonic = 0, wall = 0]) => {
          return [monotonic + 2, wall];
        })
      );
    });

    test('count a call that carries no series under _OTHER, and a router given no registry counts nothing', async () => {
      const registry = createMetricsRegistry();
      const metrics = registry.attach('server');
      using counted = createRouterCore(createPort().port, { clock: createTestClock(), metrics });
      using uncounted = createRouterCore(createPort().port, { clock: createTestClock() });

      // a router given none declares nothing of what it registers
      expect(uncounted.registerResolver(resolverOf(echo))).toBeUndefined();

      // a call that carries none counts under _OTHER; a router given none counts nothing, not even
      // into the series another router's registry gave
      void counted
        .request(new Uint8Array(0), { connectionHandle: 'a', options, procedure: echo })
        .catch(noop);
      void uncounted
        .request(new Uint8Array(0), {
          connectionHandle: 'a',
          options,
          procedure: echo,
          series: metrics.declareRequester(echo),
        })
        .catch(noop);
      await sleep(0);

      expect(countedOf(registry)).toEqual([
        'bead_client_call_started_total{service="_OTHER",procedure="_OTHER",type="command"} 1',
      ]);
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
