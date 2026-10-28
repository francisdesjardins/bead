import { once } from 'node:events';
import { type IncomingMessage, request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { InteropProcedures } from '../../../interop/generated/interop_bead';
import { offerInterop } from '../../../interop/handlers';
import { createRouterServer } from '../../router/server/router-server';
import { createSessionManager } from '../../router/server/session-manager';
import { CredentialScheme, EnvelopeKind } from '../../router/shared/constants';
import { bytesOf, readEnvelope } from '../../router/shared/envelope';
import { toSessionToken } from '../../router/shared/identifiers';
import { createServiceManager } from '../../router/shared/service-manager';
import type { IRouterServerOptions } from '../../router/server/types';
import type {
  Credential,
  Envelope,
  IProcedure,
  IServiceManagerOptions,
} from '../../router/shared/types';
import { callIdsOf, envelopeOf } from '../../router/shared/__tests__/fixtures';
import { LONGEST_TIMER } from '../../transport/shared/clock';
import { createTestClock, delaysOn, duesOn } from '../../transport/shared/__tests__/fixtures';
import type {
  ITransportServerRefusal,
  TransportServerConnectionHandle,
} from '../../transport/server/types';
import { createWSTransportServer } from '../../transport/server/ws-transport-server';
import { createEmitter } from '../../transport/shared/emitter';
import { ProgrammerError } from '../../transport/shared/errors';
import type { ITransportMessage } from '../../transport/shared/types';
import {
  CLIENT_FAILURES,
  createServer,
  DisconnectError,
  ProtocolCode,
  requireCredential,
  shareLegBSession,
  TimeoutError,
  type IServer,
  type IServerOptions,
  type IServerTransportLike,
} from '../server';

// helpers

type Handle = TransportServerConnectionHandle;

const first: Handle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = {
  decode: (bytes: Uint8Array) => {
    return decoder.decode(bytes);
  },
  encode: (value: string) => {
    return encoder.encode(value);
  },
};

const openSession: IProcedure = {
  procedureId: 1,
  procedureName: 'openSession',
  serviceId: 1,
  serviceRevision: 1,
};
const echo: IProcedure = {
  procedureId: 2,
  procedureName: 'echo',
  serviceId: 1,
  serviceRevision: 1,
};

/** A transport server that records what it sends and closes, and hands on what a test delivers. */
const createScriptedTransport = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: Handle];
    connection: [socket: unknown, request: unknown, connectionHandle: Handle];
    listen: [isHeld: boolean, connectionHandle: Handle];
    message: [message: ITransportMessage, connectionHandle: Handle];
  }>();
  const sent: { connectionHandle: Handle; envelope: Envelope | undefined }[] = [];
  // the client's call ids, odd, one after the other
  const nextCallId = callIdsOf('client');
  const closed: Handle[] = [];
  const control = {
    closeError: undefined as Error | undefined,
    /** What a close waits on before it settles, when set. */
    closeHold: undefined as Promise<void> | undefined,
    /** What a close resolves to: `false` for a connection the transport no longer holds. */
    closeResult: true,
    stops: 0,
  };

  const transport: IServerTransportLike = {
    off: emitter.off,
    on: emitter.on,
    close: async (connectionHandle) => {
      closed.push(connectionHandle);
      await control.closeHold;

      if (control.closeError !== undefined) {
        throw control.closeError;
      }

      return control.closeResult;
    },
    send: ({ data }, connectionHandle) => {
      sent.push({
        connectionHandle,
        envelope: readEnvelope(bytesOf(data), {
          failures: CLIENT_FAILURES,
          maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
        }),
      });

      return Promise.resolve();
    },
    stop: () => {
      control.stops += 1;

      return Promise.resolve();
    },
  };

  /**
   * A request for `procedure` from `connectionHandle`, on the next of the client's call ids,
   * presenting `credential`; one that opens a subscription when `opensSubscription` says so.
   */
  const ask = (
    connectionHandle: Handle,
    {
      credential,
      opensSubscription,
      procedure,
    }: { credential?: Credential; opensSubscription?: true; procedure: IProcedure }
  ) => {
    emitter.emit(
      'message',
      {
        data: envelopeOf({
          header: {
            callId: nextCallId(),
            credential,
            kind: EnvelopeKind.REQUEST,
            opensSubscription,
            procedureId: procedure.procedureId,
            serviceId: procedure.serviceId,
          },
          kind: EnvelopeKind.REQUEST,
          payload: text.encode('hi'),
        }),
      },
      connectionHandle
    );
  };

  const open = (connectionHandle: Handle) => {
    emitter.emit('connection', {}, {}, connectionHandle);
  };

  /** A listen held on `connectionHandle`, as an HTTP transport tells it, or its end. */
  const listen = (connectionHandle: Handle, isHeld: boolean) => {
    emitter.emit('listen', isHeld, connectionHandle);
  };

  return { ask, closed, control, emitter, listen, open, sent, transport };
};

/** A server whose `openSession` stores a session with `timeouts`, and whose `echo` needs one. */
const createSessionServer = (
  timeouts: { connectionInactivityTimeout: number; sessionInactivityTimeout: number },
  options?: IServerOptions
) => {
  const scripted = createScriptedTransport();
  const server = createServer({ transport: scripted.transport }, options);

  server.services.getRequestResolver(openSession, { serializer: text })((request, response) => {
    const session = server.sessions.set({
      ...server.sessions.create(request.connectionHandle),
      ...timeouts,
    });

    return response(session.sessionToken ?? '');
  });
  server.services.getRequestResolver(echo, {
    beforeRequest: server.requireSession,
    serializer: text,
  })((request, response) => {
    return response(request.payload);
  });

  return { ...scripted, server };
};

const forever = { connectionInactivityTimeout: Infinity, sessionInactivityTimeout: Infinity };

/** A procedure nobody answers: a request for it passes no `beforeRequest`. */
const unknown: IProcedure = { ...echo, procedureId: 99, procedureName: 'unknown' };

/** The delays of the timers armed on `clock`, in the order they were armed. */
const delaysArmed = (clock: ReturnType<typeof createTestClock>) => {
  return clock.armed.map(({ delay }) => {
    return delay;
  });
};

// definition

test.describe('createServer', () => {
  test('takes a supplied manager’s token and data in separate expiry-aware reads', async () => {
    const { ask, open, sent, transport } = createScriptedTransport();
    const inner = createSessionManager();
    const reads: [string, number][] = [];
    let nextRead = 999;
    let expires = false;
    const expireOnRead = (member: string, connectionHandle: Handle) => {
      if (expires) {
        const now = nextRead++;

        reads.push([member, now]);

        if (now >= 1000) {
          inner.delete(connectionHandle);
        }
      }
    };
    const sessions: typeof inner = {
      ...inner,
      get: (connectionHandle) => {
        expireOnRead('get', connectionHandle);

        return inner.get(connectionHandle);
      },
      sessionTokenOf: (connectionHandle) => {
        expireOnRead('sessionTokenOf', connectionHandle);

        return inner.sessionTokenOf(connectionHandle);
      },
    };
    await using server = createServer({
      sessions: () => {
        return sessions;
      },
      transport,
    });
    const seen: unknown[] = [];
    const answered = Promise.withResolvers<void>();

    server.services.getRequestResolver(echo, {
      beforeRequest: server.requireSession,
      serializer: text,
    })((request, response) => {
      seen.push(request.session);
      answered.resolve();

      return response(request.payload);
    });
    open(first);
    inner.set({ ...inner.create(first), data: { role: 'member' } });
    expires = true;
    ask(first, { procedure: echo });
    await answered.promise;
    await expect
      .poll(() => {
        return sent.length;
      })
      .toBe(1);

    expect(reads.slice(0, 2)).toEqual([
      ['sessionTokenOf', 999],
      ['get', 1000],
    ]);
    expect(seen).toEqual([{ data: undefined }]);
    expect(inner.get(first)).toBeUndefined();
    expect(sent[0]?.envelope?.kind).toBe(EnvelopeKind.RESULT);
    ask(first, { procedure: echo });
    await expect
      .poll(() => {
        return sent.length;
      })
      .toBe(2);
    expect(seen).toHaveLength(1);
    expect(sent[1]?.envelope).toMatchObject({
      kind: EnvelopeKind.FAILURE,
      failure: { code: ProtocolCode.SESSION_REQUIRED },
    });
  });

  test('builds each layer on the one under it, the router with the sessions’ tokens', async () => {
    const { open, transport } = createScriptedTransport();
    const built: unknown[] = [];
    const sessions = createSessionManager();
    let builtRouter: unknown;
    let routerOptions: IRouterServerOptions | undefined;
    let servicesOptions: IServiceManagerOptions<Handle> | undefined;

    await using server = createServer(
      {
        router: (below, options) => {
          const router = createRouterServer(below, options);

          built.push(['router', below === transport]);
          builtRouter = router;
          routerOptions = options;

          return router;
        },
        services: (below, options) => {
          built.push(['services', below === builtRouter]);
          servicesOptions = options;

          return createServiceManager(below, options);
        },
        sessions: () => {
          built.push(['sessions']);

          return sessions;
        },
        transport,
      },
      { closeOnCommandTimeout: true, limits: { maximumPayloadBytes: 8 } }
    );

    expect(built).toEqual([['sessions'], ['router', true], ['services', true]]);
    // the router is built with the server's limits, and relays a credential it forwards alone
    // unless told; the admissions a relay is given are the server's members
    expect(routerOptions?.limits).toEqual({ maximumPayloadBytes: 8 });
    expect(routerOptions?.relay).toEqual({ beforeRoute: server.requireCredential });
    expect([server.requireCredential, server.shareLegBSession]).toEqual([
      requireCredential,
      shareLegBSession,
    ]);
    expect(server.router).toBe(builtRouter);
    expect(server.sessions).toBe(sessions);
    expect(server.transport).toBe(transport);

    // the router reads each connection's token from the sessions; the services close through the server
    open(first);
    sessions.set({
      ...sessions.create(first),
      sessionToken: toSessionToken(new Uint8Array(16).fill(4)),
    });

    expect(routerOptions?.sessionTokenOf?.(first)).toBe(toSessionToken(new Uint8Array(16).fill(4)));
    expect(servicesOptions?.closeConnection).toBeInstanceOf(Function);
    expect(servicesOptions?.defaults).toEqual({ closeOnTimeout: true });
  });

  test('a session is made by a request, and its connection learns the token once', async () => {
    const { ask, sent, server: sessionServer } = createSessionServer(forever);

    await using server = sessionServer;

    // without a session, only the procedure that opens one answers
    ask(first, { procedure: echo });
    ask(first, { procedure: openSession });
    await sleep(0);
    ask(first, { procedure: echo });
    await sleep(0);

    const sessionToken = server.sessions.sessionTokenOf(first);

    expect(sessionToken).toBeDefined();
    expect(
      sent.map(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [envelope.header, envelope.failure.code]
          : [
              envelope?.header,
              text.decode(
                envelope !== undefined && 'payload' in envelope
                  ? envelope.payload
                  : new Uint8Array(0)
              ),
            ];
      })
    ).toEqual([
      [{ callId: 1, kind: EnvelopeKind.FAILURE }, ProtocolCode.SESSION_REQUIRED],
      [
        {
          callId: 3,
          credential: { scheme: CredentialScheme.OPAQUE, token: sessionToken },
          kind: EnvelopeKind.RESULT,
        },
        sessionToken,
      ],
      [{ callId: 5, kind: EnvelopeKind.RESULT }, 'hi'],
    ]);
  });

  test('the end of a session is announced on the next answer, and a session replaced is announced', async () => {
    const { ask, sent, server: sessionServer } = createSessionServer(forever);
    const closeSession: IProcedure = { ...echo, procedureId: 3, procedureName: 'closeSession' };

    await using server = sessionServer;

    server.services.getRequestResolver(closeSession, { serializer: text })((request, response) => {
      // deleted before it answers, so its answer announces the end
      server.sessions.delete(request.connectionHandle);

      return response('bye');
    });

    ask(first, { procedure: openSession });
    await sleep(0);

    const opened = server.sessions.sessionTokenOf(first);

    ask(first, { procedure: openSession });
    await sleep(0);

    const replaced = server.sessions.sessionTokenOf(first);

    ask(first, { procedure: closeSession });
    ask(first, { procedure: echo });
    await sleep(0);

    expect(replaced).not.toBe(opened);
    expect(
      sent.map(({ envelope }) => {
        const header = envelope?.header as { credential?: unknown } | undefined;

        return header !== undefined && 'credential' in header ? header.credential : 'none';
      })
    ).toEqual([
      { scheme: CredentialScheme.OPAQUE, token: opened },
      { scheme: CredentialScheme.OPAQUE, token: replaced },
      { scheme: CredentialScheme.NONE },
      'none',
    ]);
  });

  test("requireSession refuses a call in none with SESSION_REQUIRED, testing the call's session, never its connection's", async () => {
    const { open, transport } = createScriptedTransport();

    await using server = createServer({ transport });

    open(first);

    expect(server.requireSession({})).toBe(false);
    expect(server.requireSession.refusal).toBe(server.router.failures.sessionRequired);

    server.sessions.set({ ...server.sessions.create(first), ...forever });

    // the connection's session is no call's until the call resolves to it
    expect(server.requireSession({ session: undefined })).toBe(false);
    expect(server.requireSession({ session: Object.freeze({ data: undefined }) })).toBe(true);
  });

  test('each message is activity: a connection that speaks keeps going, a silent one is closed', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      emitter,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: 80, sessionInactivityTimeout: Infinity },
      { clock }
    );

    await using server = sessionServer;

    ask(first, { procedure: openSession });
    await sleep(0);

    // requests for a procedure nobody answers, and a message that is not an envelope: activity all
    // the same, each stopping the connection's timer and setting another going
    for (let count = 0; count < 3; count += 1) {
      if (count === 1) {
        emitter.emit('message', { data: Uint8Array.of(0x0a, 0x02) }, first);
      } else {
        ask(first, { procedure: unknown });
      }

      await sleep(0);
    }

    expect(delaysArmed(clock)).toEqual([80, 80, 80, 80]);
    expect(delaysOn(clock)).toEqual([80]);
    expect(closed).toEqual([]);
    expect(server.sessions.has(first)).toBe(true);

    // silent past the last
    clock.tick(80);

    expect(closed).toEqual([first]);
  });

  test('a session unused past its timeout ends, and its connection stays', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: Infinity, sessionInactivityTimeout: 40 },
      { clock }
    );

    await using server = sessionServer;

    ask(first, { procedure: openSession });
    await sleep(0);

    expect(server.sessions.has(first)).toBe(true);
    expect(delaysOn(clock)).toEqual([40]);

    clock.tick(40);
    await sleep(0);

    // no timer left to close the connection
    expect(server.sessions.has(first)).toBe(false);
    expect(delaysOn(clock)).toEqual([]);
    expect(closed).toEqual([]);
  });

  test('a session that ended leaves its connection the server’s own timeout, counted from its end', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: 100, sessionInactivityTimeout: 30 },
      { clock, connectionInactivityTimeout: 60 }
    );

    await using server = sessionServer;

    ask(first, { procedure: openSession });
    await sleep(0);

    expect(delaysOn(clock)).toEqual([30, 100]);

    // the session's own: it ends, and the connection waits the server's timeout from there, not
    // the session's
    clock.tick(30);
    await sleep(0);

    expect(server.sessions.has(first)).toBe(false);
    expect(closed).toEqual([]);
    expect(delaysOn(clock)).toEqual([60]);

    clock.tick(59);

    expect(closed).toEqual([]);

    clock.tick(1);

    expect(closed).toEqual([first]);
  });

  test("a request runs in its connection's session, presenting none or its token as OPAQUE, the session's data a copy the call keeps; another token is refused SESSION_REQUIRED, whatever its procedure requires", async () => {
    const { ask, sent, server: sessionServer } = createSessionServer(forever);
    const whoami: IProcedure = { ...echo, procedureId: 4, procedureName: 'whoami' };
    const held: unknown[] = [];

    await using server = sessionServer;

    // a procedure that requires nothing: the session it runs in, or none
    server.services.getRequestResolver(whoami, { serializer: text })((request, response) => {
      held.push(request.session);

      return response('');
    });
    ask(first, { procedure: whoami });
    ask(first, { procedure: openSession });
    await sleep(0);

    const token = server.sessions.sessionTokenOf(first);
    const stored = server.sessions.get(first);

    if (token === undefined || stored === undefined) {
      throw new Error('no session opened');
    }

    server.sessions.updateData({ ...stored, data: { name: 'ada' } });
    ask(first, { procedure: whoami });
    ask(first, { credential: { scheme: CredentialScheme.OPAQUE, token }, procedure: whoami });
    ask(first, {
      credential: {
        scheme: CredentialScheme.OPAQUE,
        token: toSessionToken(new Uint8Array(16).fill(9)),
      },
      procedure: whoami,
    });
    await sleep(0);
    // what the call keeps is its own copy
    server.sessions.updateData({ ...stored, data: { name: 'bob' } });

    expect(held).toEqual([undefined, { data: { name: 'ada' } }, { data: { name: 'ada' } }]);
    expect(Object.isFrozen(held[1])).toBe(true);
    expect(
      sent.flatMap(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [[envelope.header.callId, envelope.failure.code]]
          : [];
      })
    ).toEqual([[9, ProtocolCode.SESSION_REQUIRED]]);
  });

  test("a call presenting its connection's OPAQUE and one presenting none hold one subscription to a procedure, the connection's session's", async () => {
    const { ask, sent, server: sessionServer } = createSessionServer(forever);
    const news: IProcedure = { ...echo, procedureId: 5, procedureName: 'news' };

    await using server = sessionServer;

    server.services.getNotificationResolver(news, {
      beforeRequest: server.requireSession,
      serializer: { ...text, encodeNotification: text.encode },
    })((_request, response) => {
      return response('');
    });
    ask(first, { procedure: openSession });
    await sleep(0);

    const token = server.sessions.sessionTokenOf(first);

    if (token === undefined) {
      throw new Error('no session opened');
    }

    ask(first, { opensSubscription: true, procedure: news });
    ask(first, {
      credential: { scheme: CredentialScheme.OPAQUE, token },
      opensSubscription: true,
      procedure: news,
    });
    await sleep(0);

    // both answered; the first holds the place
    expect(
      sent.map(({ envelope }) => {
        return [envelope?.kind, envelope?.header.callId];
      })
    ).toEqual([
      [EnvelopeKind.RESULT, 1],
      [EnvelopeKind.RESULT, 3],
      [EnvelopeKind.RESULT, 5],
    ]);
    expect(server.router.notifications.subscriptions()).toEqual([
      { callId: 3, connectionHandle: first, procedureId: 5, serviceId: 1 },
    ]);
  });

  test('a session that ended takes its connection’s subscriptions: nothing more reaches it', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      sent,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: Infinity, sessionInactivityTimeout: 30 },
      { clock }
    );
    const news: IProcedure = { ...echo, procedureId: 5, procedureName: 'news' };

    await using server = sessionServer;

    const resolver = server.services.getNotificationResolver(news, {
      beforeRequest: server.requireSession,
      serializer: { ...text, encodeNotification: text.encode },
    })((_request, response) => {
      return response('');
    });

    ask(first, { procedure: openSession });
    ask(first, { opensSubscription: true, procedure: news });
    await sleep(0);

    expect(
      server.router.notifications.candidates(news).map(({ connectionHandle }) => {
        return connectionHandle;
      })
    ).toEqual([first]);
    expect(delaysOn(clock)).toEqual([30]);

    clock.tick(30);
    await sleep(0);

    // the session's end ended the subscription, with a failure that announced it
    expect(
      sent.slice(-1).map(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [envelope.header, envelope.failure.code]
          : envelope;
      })
    ).toEqual([
      [
        { callId: 3, credential: { scheme: CredentialScheme.NONE }, kind: EnvelopeKind.FAILURE },
        ProtocolCode.SESSION_REQUIRED,
      ],
    ]);

    sent.length = 0;
    await resolver.notify('flash');

    expect(server.sessions.has(first)).toBe(false);
    expect(server.router.notifications.subscriptions()).toEqual([]);
    expect(sent).toEqual([]);
    expect(closed).toEqual([]);
  });

  test('a connection that never opens a session is closed once silent, when the server says how long', async () => {
    const clock = createTestClock();
    const quiet = createScriptedTransport();
    const told = createScriptedTransport();

    await using server = createServer(
      { transport: told.transport },
      { clock, connectionInactivityTimeout: 60 }
    );
    await using untold = createServer({ transport: quiet.transport }, { clock });

    for (const { open } of [told, quiet]) {
      open(first);
    }

    // the server told how long arms a timer, the other none
    expect(delaysArmed(clock)).toEqual([60]);

    // a message is activity, with a session or without one
    told.ask(first, { procedure: unknown });
    await sleep(0);

    expect(delaysArmed(clock)).toEqual([60, 60]);
    expect(delaysOn(clock)).toEqual([60]);
    expect(told.closed).toEqual([]);

    clock.tick(60);

    expect(told.closed).toEqual([first]);
    expect(quiet.closed).toEqual([]);
    expect([server.sessions.getAll(), untold.sessions.getAll()]).toEqual([[], []]);
  });

  test('answers slow once its server’s clock passed its wait, never before', async () => {
    const clock = createTestClock();
    const scripted = createScriptedTransport();
    const { procedure } = InteropProcedures.slow;

    await using server = createServer<IServerTransportLike, string>(
      { transport: scripted.transport },
      { clock }
    );

    offerInterop(server);
    scripted.open(first);
    scripted.emitter.emit(
      'message',
      {
        data: envelopeOf({
          header: {
            callId: 1,
            kind: EnvelopeKind.REQUEST,
            procedureId: procedure.procedureId,
            serviceId: procedure.serviceId,
          },
          kind: EnvelopeKind.REQUEST,
          payload: text.encode('{"milliseconds":50}'),
        }),
      },
      first
    );
    await sleep(0);
    await clock.tickAsync(49);

    expect(scripted.sent).toEqual([]);

    await clock.tickAsync(1);
    await expect
      .poll(() => {
        return scripted.sent.map(({ envelope }) => {
          return envelope?.header;
        });
      })
      .toEqual([{ callId: 1, kind: EnvelopeKind.RESULT }]);
  });

  test('closes a connection silent for a millisecond or the longest timer at its due', async () => {
    for (const timeout of [1, LONGEST_TIMER]) {
      const clock = createTestClock();
      const scripted = createScriptedTransport();

      await using server = createServer(
        { transport: scripted.transport },
        { clock, connectionInactivityTimeout: timeout }
      );

      scripted.open(first);
      clock.tick(timeout - 1);

      expect([timeout, scripted.closed]).toEqual([timeout, []]);

      clock.tick(1);

      expect([timeout, scripted.closed, server.sessions.getAll()]).toEqual([timeout, [first], []]);
    }
  });

  test('ignores listens outside a connection and unmatched endings without changing its inactivity deadline', async () => {
    const clock = createTestClock();
    const second: Handle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=2';
    const { closed, emitter, listen, open, transport } = createScriptedTransport();

    await using server = createServer({ transport }, { clock, connectionInactivityTimeout: 60 });

    listen(first, true);
    listen(first, false);
    await clock.tickAsync(100);

    expect(server.gauges().server.counts).toMatchObject({ connections: 0, listening: 0 });
    expect(closed).toEqual([]);
    expect(delaysOn(clock)).toEqual([]);

    open(first);
    await clock.tickAsync(40);
    listen(first, false);

    expect(server.gauges().server.counts).toMatchObject({ connections: 1, idle: 1, listening: 0 });

    await clock.tickAsync(19);

    expect(closed).toEqual([]);

    await clock.tickAsync(1);

    expect(closed).toEqual([first]);

    emitter.emit('close', true, first);
    listen(first, true);
    listen(first, false);

    expect(server.gauges().server.counts).toMatchObject({ connections: 0, listening: 0 });
    expect(delaysOn(clock)).toEqual([]);

    open(second);
    listen(second, true);
    await clock.tickAsync(1_000);

    expect(closed).toEqual([first]);
    expect(server.gauges().server.counts).toMatchObject({ connections: 1, listening: 1 });

    listen(second, false);
    await clock.tickAsync(59);

    expect(closed).toEqual([first]);

    await clock.tickAsync(1);

    expect(closed).toEqual([first, second]);
    expect(server.gauges().server.counts['listening']).toBe(0);
  });

  test('a listen held is no silence: a connection with no session is not closed while one is, and is closed the server’s own timeout after the last ends', async () => {
    const clock = createTestClock();
    const { ask, closed, listen, open, transport } = createScriptedTransport();

    await using server = createServer({ transport }, { clock, connectionInactivityTimeout: 60 });

    open(first);
    clock.tick(40);
    listen(first, true);

    // held: no timer runs, a message meanwhile arms none, and a second listen said before the
    // first ends keeps the connection held
    expect(delaysOn(clock)).toEqual([]);
    ask(first, { procedure: unknown });
    await sleep(0);
    clock.tick(1_000);
    listen(first, true);
    listen(first, false);
    clock.tick(1_000);

    expect([closed, delaysOn(clock), server.gauges().server.counts['listening']]).toEqual([
      [],
      [],
      1,
    ]);

    // the last ends: the silence counts anew from it
    listen(first, false);

    expect(delaysOn(clock)).toEqual([60]);

    clock.tick(59);

    expect(closed).toEqual([]);

    clock.tick(1);

    expect([closed, server.gauges().server.counts['listening']]).toEqual([[first], 0]);
  });

  test('a listen held is no silence for a session’s connection timeout either: a message meanwhile restarts its session timer alone, and the listen’s end counts anew', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      listen,
      open,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: 100, sessionInactivityTimeout: 1_000 },
      { clock }
    );

    await using server = sessionServer;

    // a session opened while a listen is held, as a client over HTTP logs in: its session timer alone
    open(first);
    listen(first, true);
    ask(first, { procedure: openSession });
    await sleep(0);

    expect(delaysOn(clock)).toEqual([1_000]);

    // a message, and a session opened anew, each restart the session timer alone
    clock.tick(200);
    ask(first, { procedure: unknown });
    ask(first, { procedure: openSession });
    await sleep(0);

    const { lastActivity } = server.sessions.get(first) ?? {};

    clock.tick(400);

    expect([delaysOn(clock), closed]).toEqual([[1_000], []]);

    // the listen's end starts the connection timer from it, and leaves the session timer and the
    // session's activity to the messages: a listen is no message
    listen(first, false);

    expect(duesOn(clock)).toEqual([100, 600]);
    expect(server.sessions.get(first)?.lastActivity).toBe(lastActivity);

    clock.tick(99);

    expect(closed).toEqual([]);

    clock.tick(1);

    expect(closed).toEqual([first]);

    clock.tick(499);

    expect(server.sessions.has(first)).toBe(true);

    clock.tick(1);

    expect(server.sessions.has(first)).toBe(false);
  });

  test('a session’s session timeout ends its session while a listen is held: its subscription’s failure goes out, and the connection stays held', async () => {
    const clock = createTestClock();
    const {
      ask,
      closed,
      listen,
      sent,
      server: sessionServer,
    } = createSessionServer(
      { connectionInactivityTimeout: 100, sessionInactivityTimeout: 30 },
      { clock, connectionInactivityTimeout: 60 }
    );
    const news: IProcedure = { ...echo, procedureId: 5, procedureName: 'news' };

    await using server = sessionServer;

    server.services.getNotificationResolver(news, {
      beforeRequest: server.requireSession,
      serializer: { ...text, encodeNotification: text.encode },
    })((_request, response) => {
      return response('');
    });
    ask(first, { procedure: openSession });
    ask(first, { opensSubscription: true, procedure: news });
    await sleep(0);
    listen(first, true);

    expect(delaysOn(clock)).toEqual([30]);

    clock.tick(30);
    await sleep(0);

    // over HTTP, the failure is what the listen held brings back
    expect(
      sent.slice(-1).map(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [envelope.header, envelope.failure.code]
          : envelope;
      })
    ).toEqual([
      [
        { callId: 3, credential: { scheme: CredentialScheme.NONE }, kind: EnvelopeKind.FAILURE },
        ProtocolCode.SESSION_REQUIRED,
      ],
    ]);
    expect([server.sessions.has(first), delaysOn(clock), closed]).toEqual([false, [], []]);

    // the listen's end: the server's own timeout, the session gone
    listen(first, false);

    expect(delaysOn(clock)).toEqual([60]);
  });

  test('a session stored once its connection closed goes at once, and a new connection of that handle has none', async () => {
    const { ask, emitter, open, transport } = createScriptedTransport();
    const gate = Promise.withResolvers<undefined>();

    await using server = createServer({ transport });

    server.services.getRequestResolver(openSession, { serializer: text })(
      async (request, response) => {
        // a credential check, say, while the client leaves
        await gate.promise;
        server.sessions.set({ ...server.sessions.create(request.connectionHandle), ...forever });

        return response('');
      }
    );

    ask(first, { procedure: openSession });
    emitter.emit('close', false, first);
    gate.resolve(undefined);
    await sleep(0);

    expect(server.sessions.getAll()).toEqual([]);

    open(first);

    expect(server.sessions.has(first)).toBe(false);
  });

  test('a close that finds the connection gone already takes its session all the same', async () => {
    const {
      ask,
      closed,
      control,
      server: sessionServer,
    } = createSessionServer({
      connectionInactivityTimeout: 20,
      sessionInactivityTimeout: Infinity,
    });

    await using server = sessionServer;

    control.closeResult = false;
    ask(first, { procedure: openSession });

    await expect
      .poll(() => {
        return [closed, server.sessions.has(first)];
      })
      .toEqual([[first], false]);
  });

  test('a command whose timeout passes is cancelled before its connection is closed', async () => {
    const { ask, transport } = createScriptedTransport();
    const order: string[] = [];
    const close = transport.close.bind(transport);
    const send = transport.send.bind(transport);
    const ping = { ...echo, procedureId: 3, procedureName: 'ping' };

    transport.close = (connectionHandle) => {
      order.push('close');

      return close(connectionHandle);
    };
    transport.send = (message, connectionHandle) => {
      const envelope = readEnvelope(bytesOf(message.data), {
        failures: CLIENT_FAILURES,
        maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
      });

      order.push(envelope?.kind === EnvelopeKind.CANCEL ? 'cancel' : 'other');

      return send(message, connectionHandle);
    };

    await using server = createServer({ transport }, { closeOnCommandTimeout: true });

    ask(first, { procedure: openSession });

    await expect(
      server.services.getCommand(ping, { serializer: text })('ping')({
        connectionHandle: first,
        timeout: 10,
      })
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(
      order.filter((step) => {
        return step !== 'other';
      })
    ).toEqual(['cancel', 'close']);
  });

  test('a connection is asked to close once, however many times it earns it', async () => {
    const { ask, closed, control, transport } = createScriptedTransport();
    const release = Promise.withResolvers<undefined>();
    const ping = { ...echo, procedureId: 3, procedureName: 'ping' };

    await using server = createServer({ transport }, { closeOnCommandTimeout: true });

    control.closeHold = release.promise.then(() => {
      return undefined;
    });
    ask(first, { procedure: openSession });

    const command = server.services.getCommand(ping, { serializer: text })('ping');

    await Promise.all(
      [
        command({ connectionHandle: first, timeout: 10 }),
        command({ connectionHandle: first, timeout: 10 }),
      ].map((answering) => {
        return answering.catch(() => {
          return undefined;
        });
      })
    );

    expect(closed).toEqual([first]);

    release.resolve(undefined);
  });

  test('a connection that closes takes its session, and a close that fails is reported', async () => {
    const {
      ask,
      control,
      emitter,
      server: sessionServer,
    } = createSessionServer({
      connectionInactivityTimeout: 30,
      sessionInactivityTimeout: Infinity,
    });
    const errors: [Error, string | undefined][] = [];

    await using server = sessionServer;

    server.router.on('error', (error, connectionHandle) => {
      errors.push([error, connectionHandle]);
    });

    ask(first, { procedure: openSession });
    await sleep(0);
    emitter.emit('close', true, first);

    expect(server.sessions.has(first)).toBe(false);

    ask(first, { procedure: openSession });
    control.closeError = new Error('refused');

    await expect
      .poll(() => {
        return errors;
      })
      .toEqual([[control.closeError, first]]);
  });

  test('a command unanswered in time closes its connection, as the server’s default or the command says', async () => {
    const { ask, closed, transport } = createScriptedTransport();
    const ping = { ...echo, procedureId: 3, procedureName: 'ping' };
    const command = (server: ReturnType<typeof createServer>, closeOnTimeout?: boolean) => {
      return server.services
        .getCommand(ping, { serializer: text })('ping')({
          closeOnTimeout,
          connectionHandle: first,
          timeout: 10,
        })
        .catch((reason: unknown) => {
          return reason;
        });
    };

    {
      await using server = createServer({ transport }, { closeOnCommandTimeout: true });

      // a connection the router knows, which never answers
      ask(first, { procedure: openSession });

      expect(await command(server)).toBeInstanceOf(TimeoutError);
      expect(await command(server, false)).toBeInstanceOf(TimeoutError);
      expect(closed).toEqual([first]);
    }

    closed.length = 0;

    {
      await using server = createServer({ transport });

      ask(first, { procedure: openSession });

      await command(server);

      expect(closed).toEqual([]);

      await command(server, true);

      expect(closed).toEqual([first]);
    }
  });

  test('dispose lets go of the sessions’ events too, and a resolver that finishes after it stores nothing', async () => {
    const { ask, transport } = createScriptedTransport();
    const inner = createSessionManager();
    const offs: string[] = [];
    const sessions: typeof inner = {
      ...inner,
      off: (event, listener) => {
        offs.push(event);
        inner.off(event, listener);

        return sessions;
      },
    };
    const gate = Promise.withResolvers<undefined>();
    const server = createServer({
      sessions: () => {
        return sessions;
      },
      transport,
    });

    server.services.getRequestResolver(openSession, { serializer: text })(
      async (request, response) => {
        await gate.promise;
        server.sessions.set({ ...server.sessions.create(request.connectionHandle), ...forever });

        return response('');
      }
    );

    ask(first, { procedure: openSession });
    await server[Symbol.asyncDispose]();
    gate.resolve(undefined);
    await sleep(0);

    expect(offs.toSorted()).toEqual([
      'connectionInactivityTimeoutReached',
      'created',
      'deleted',
      'sessionInactivityTimeoutReached',
      'updated',
    ]);
    expect(inner.getAll()).toEqual([]);
  });

  // spec 14.3.1
  test('relays as its options say, its own admission and timeout kept, requireCredential where it gives none', async () => {
    const beforeRoute = () => {
      return true;
    };
    const relays: unknown[] = [];
    const serverOf = (relay: IServerOptions['relay']) => {
      return createServer(
        {
          router: (below, options) => {
            relays.push(options.relay);

            return createRouterServer(below, options);
          },
          transport: createScriptedTransport().transport,
        },
        { relay }
      );
    };

    await using server = serverOf({ beforeRoute, timeout: 250 });
    await using timed = serverOf({ timeout: 250 });

    expect(relays).toEqual([
      { beforeRoute, timeout: 250 },
      { beforeRoute: timed.requireCredential, timeout: 250 },
    ]);
    expect(server.router.destinations()).toEqual([]);
  });

  test('limits that do not hold together refuse the server, which leaves nothing on its transport', () => {
    const { emitter, transport } = createScriptedTransport();

    expect(() => {
      return createServer({ transport }, { limits: { chunkBytes: 63 } });
    }).toThrow(ProgrammerError);
    expect(
      (['close', 'connection', 'listen', 'message'] as const).map((event) => {
        return emitter.listenerCount(event);
      })
    ).toEqual([0, 0, 0, 0]);
  });

  test("runs every layer on its transport's clock: the sessions are built with it, and a layer on another is refused, leaving nothing on its transport", async () => {
    const clock = createTestClock();
    const { emitter, transport } = createScriptedTransport();
    const clocked = { ...transport, clock };
    const given: unknown[] = [];

    await using server = createServer({
      sessions: (options) => {
        given.push(options.clock);

        return createSessionManager(options);
      },
      transport: clocked,
    });

    expect([given, server.router.clock, server.sessions.clock]).toEqual([[clock], clock, clock]);

    for (const [refused, message] of [
      [
        () => {
          return createServer({ transport: clocked }, { clock: createTestClock() });
        },
        'a server runs on the clock of its transport, one of its own, and was given another, one of its own',
      ],
      [
        () => {
          return createServer({
            sessions: () => {
              return createSessionManager();
            },
            transport: clocked,
          });
        },
        "a server's session manager runs on the clock of its server, one of its own, and was given another, the platform's",
      ],
      [
        () => {
          return createServer(
            {
              router: (below, options) => {
                return createRouterServer(below, { ...options, clock: undefined });
              },
              transport: { ...transport },
            },
            { clock }
          );
        },
        "a server's router runs on the clock of its server, one of its own, and was given another, the platform's",
      ],
    ] as const) {
      expect(refused).toThrow(new ProgrammerError(message));
    }

    // the server built on it is the one listening: the refused ones let go
    expect(emitter.listenerCount('message')).toBe(2);
  });

  test('dispose stops the timer of a connection with no session: nothing is closed after it', async () => {
    const { closed, open, transport } = createScriptedTransport();
    const server = createServer({ transport }, { connectionInactivityTimeout: 20 });

    open(first);
    await server[Symbol.asyncDispose]();
    await sleep(80);

    expect(closed).toEqual([]);
  });

  test('counts no close under way once disposed', async () => {
    const { closed, control, open, transport } = createScriptedTransport();
    const release = Promise.withResolvers<void>();
    const server = createServer({ transport }, { connectionInactivityTimeout: 20 });

    // its timeout closes the connection, a close the transport holds under way
    control.closeHold = release.promise;
    open(first);
    await expect
      .poll(() => {
        return closed;
      })
      .toEqual([first]);

    expect(server.gauges().server.counts['closing']).toBe(1);

    await server[Symbol.asyncDispose]();

    expect(server.gauges().server.counts['closing']).toBe(0);

    release.resolve();
  });

  test('dispose lets go of the transport, rejects what waits, forgets the sessions, and stops', async () => {
    const { ask, control, emitter, server } = createSessionServer(forever);

    ask(first, { procedure: openSession });
    await sleep(0);

    const waiting = server.services.getCommand(echo, { serializer: text })('ping')({
      connectionHandle: first,
    });

    await server[Symbol.asyncDispose]();

    await expect(waiting).rejects.toBeInstanceOf(DisconnectError);
    expect(server.sessions.has(first)).toBe(false);
    expect(control.stops).toBe(1);
    expect(
      (['close', 'connection', 'listen', 'message'] as const).map((event) => {
        return emitter.listenerCount(event);
      })
    ).toEqual([0, 0, 0, 0]);
  });

  test("hears its transport's error and refusal through the server's transport", async () => {
    const transport = createWSTransportServer({ WebSocketServer });
    // typed by what a server asks of its transport alone, as code over any transport sees it
    await using server: IServer = createServer({ transport });
    const refusals: [status: number, reason: string][] = [];
    const errors: [message: string, connectionHandle: string][] = [];
    const onRefusal = ({ reason, status }: ITransportServerRefusal) => {
      refusals.push([status, reason]);

      throw new Error('a refusal listener that throws');
    };

    server.transport.on('refusal', onRefusal);
    server.transport.on('error', (error, connectionHandle) => {
      errors.push([error.message, connectionHandle]);
    });

    const { port } = await transport.start({ address: '127.0.0.1', findOpenPort: true });
    const post = async () => {
      const posted = request({ agent: false, host: '127.0.0.1', method: 'POST', port });

      posted.end();

      const [answer] = (await once(posted, 'response')) as [IncomingMessage];

      answer.resume();
      await once(answer, 'end');

      return [answer.statusCode, answer.headers['bead-refusal']];
    };

    expect(await post()).toEqual([405, 'method-refused']);
    expect(refusals).toEqual([[405, 'method-refused']]);
    expect(errors).toEqual([['a refusal listener that throws', '']]);

    // let go of, it hears nothing more
    server.transport.off('refusal', onRefusal);

    expect(await post()).toEqual([405, 'method-refused']);
    expect(refusals).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test.describe('gauges and health', () => {
    test('count each layer, set against the connections it holds when its transport counts none, back to nothing as each closes', async () => {
      const { ask, emitter, open, server } = createSessionServer(forever);

      open(first);

      // no session yet: idle, until its timeout closes it
      expect(server.gauges().server.counts).toEqual({
        closing: 0,
        connections: 1,
        idle: 1,
        listening: 0,
      });

      ask(first, { procedure: openSession });
      await expect
        .poll(() => {
          return server.sessions.has(first);
        })
        .toBe(true);

      const gauges = server.gauges();

      expect([gauges.server, gauges.sessions, gauges.transport]).toEqual([
        {
          anomalies: [],
          ceilings: {},
          counts: { closing: 0, connections: 1, idle: 0, listening: 0 },
          orphans: 0,
        },
        { anomalies: [], ceilings: {}, counts: { sessions: 1, timedConnections: 1 }, orphans: 0 },
        { anomalies: [], ceilings: {}, counts: {}, orphans: 0 },
      ]);
      expect(gauges.router.counts).toMatchObject({ connections: 1, pendingCalls: 0 });
      expect(server.health().status).toBe('pass');

      emitter.emit('close', true, first);

      expect(server.gauges().server.counts).toEqual({
        closing: 0,
        connections: 0,
        idle: 0,
        listening: 0,
      });
      expect(server.gauges().sessions.counts).toEqual({ sessions: 0, timedConnections: 0 });
      expect(server.health().status).toBe('pass');
      await server[Symbol.asyncDispose]();
    });

    test('fail what a layer keeps for a connection the transport does not hold, and say why', async () => {
      const { server } = createSessionServer(forever);
      const gone: Handle = 'type=WS;ip=127.0.0.1;port=50009;ordinal=1';

      // a timer set by hand for a connection that is not there
      server.sessions.timers.setConnectionInactivityTimeout(
        setTimeout(() => {}, 1_000),
        gone
      );

      const { checks, status } = server.health();

      expect([status, checks['sessions:orphans'], checks['sessions:anomalies']]).toEqual([
        'fail',
        [
          {
            observedValue: 1,
            output: '1 connections kept that the transport no longer holds',
            status: 'fail',
          },
        ],
        [{ observedValue: 1, output: '1 connections keep timers with no session', status: 'fail' }],
      ]);

      server.sessions.timers.delete(gone);

      expect(server.health().status).toBe('pass');
      await server[Symbol.asyncDispose]();
    });
  });
});
