import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createWSClient } from '../../../client/ws-client';
import { allClosed, host, IMPLEMENTATIONS } from '../../../transport/shared/__tests__/fixtures';
import { createWSTransportServer } from '../../../transport/server/ws-transport-server';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createEmitter } from '../../../transport/shared/emitter';
import type { Data } from '../../../transport/shared/types';
import { bytesOf, readEnvelope } from '../../shared/envelope';
import { toSessionToken } from '../../shared/identifiers';
import { createServiceManager } from '../../shared/service-manager';
import type {
  Envelope,
  IProcedure,
  OutgoingEnvelope,
  RouterLimitsOptions,
} from '../../shared/types';
import type { IRelayOptions, RelayTarget } from '../types';
import {
  createTestClock,
  type TestClock,
  timersUntil,
} from '../../../transport/shared/__tests__/fixtures';
import { callIdsOf, createPipedTransports, envelopeOf } from '../../shared/__tests__/fixtures';
import { createRouterClient } from '../../client/router-client';
import {
  CancelError,
  CLIENT_FAILURES,
  createRouterServer,
  DisconnectError,
  EnvelopeKind,
  FailureError,
  FailureScope,
  ProgrammerError,
  ProtocolCode,
  SERVER_FAILURES,
  TimeoutError,
  type IRouterServerTransportLike,
} from '../router-server';

// helpers

type Handle = TransportServerConnectionHandle;

interface ISentEnvelope {
  connectionHandle: Handle;
  envelope: Envelope | undefined;
}

const first: Handle = 'type=WS;ip=127.0.0.1;port=50001';
const second: Handle = 'type=WS;ip=127.0.0.1;port=50002';

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

/** What a side that answers reads and writes: text. */
const answering = { ...text, encodeNotification: text.encode };
/** What a side that asks writes and reads: text. */
const asking = { ...text, decodeNotification: text.decode };

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};
const news: IProcedure = {
  procedureId: 5,
  procedureName: 'news',
  serviceId: 2,
  serviceRevision: 3,
};
const unsubscribeProcedure: IProcedure = {
  procedureId: 6,
  procedureName: 'unsubscribe',
  serviceId: 2,
  serviceRevision: 3,
};
const options = { timeout: 1_000 };

const TOKEN = toSessionToken(new Uint8Array(16).fill(7));
const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(8));

/** A client's request for `procedure`, on `callId`, carrying `payload`. */
const requestOf = (
  callId: number,
  {
    destinationId,
    opensSubscription,
    payload = new Uint8Array(0),
    procedure = echo,
  }: {
    destinationId?: number;
    opensSubscription?: true;
    payload?: Uint8Array;
    procedure?: IProcedure;
  } = {}
): OutgoingEnvelope => {
  return {
    header: {
      callId,
      destinationId,
      kind: EnvelopeKind.REQUEST,
      opensSubscription,
      procedureId: procedure.procedureId,
      serviceId: procedure.serviceId,
    },
    kind: EnvelopeKind.REQUEST,
    payload,
  };
};

/** A client's request `callId` that opens a subscription to `procedure`, `news` when not given. */
const subscribingOf = (
  callId: number,
  { payload, procedure = news }: { payload?: Uint8Array; procedure?: IProcedure } = {}
): OutgoingEnvelope => {
  return requestOf(callId, {
    opensSubscription: true,
    procedure,
    ...(payload === undefined ? {} : { payload }),
  });
};

/** A client's request `callId` that opens a subscription to `news`, paced. */
const pacedOf = (callId: number, payload = new Uint8Array(0)): OutgoingEnvelope => {
  return {
    header: {
      callId,
      kind: EnvelopeKind.REQUEST,
      opensSubscription: true,
      paced: true,
      procedureId: news.procedureId,
      serviceId: news.serviceId,
    },
    kind: EnvelopeKind.REQUEST,
    payload,
  };
};

/** A client's credit of the notifications of its subscription `callId`, up to `creditEnd`. */
const pacedCreditOf = (callId: number, creditEnd: number): OutgoingEnvelope => {
  return {
    header: { callId, creditEnd, kind: EnvelopeKind.CREDIT, paced: true },
    kind: EnvelopeKind.CREDIT,
  };
};

/** A client's cancel of its call `callId`. */
const cancelOf = (callId: number): OutgoingEnvelope => {
  return { header: { callId, kind: EnvelopeKind.CANCEL }, kind: EnvelopeKind.CANCEL };
};

const resultOf = (callId: number, payload = new Uint8Array(0)): OutgoingEnvelope => {
  return { header: { callId, kind: EnvelopeKind.RESULT }, kind: EnvelopeKind.RESULT, payload };
};

/** A transport server that records what it sends, read as a client reads it, and delivers what a test gives. */
const createScriptedTransport = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: Handle];
    connection: [socket: unknown, request: unknown, connectionHandle: Handle];
    message: [data: Data, connectionHandle: Handle];
  }>();
  const sent: ISentEnvelope[] = [];
  const control = {
    /** Called with each envelope as it is handed over, before the send settles. */
    onSend: undefined as ((sentEnvelope: ISentEnvelope) => void) | undefined,
    /** What a send to each connection rejects with, when set. */
    sendErrors: new Map<Handle, Error>(),
  };

  const transport: IRouterServerTransportLike = {
    off: emitter.off,
    on: emitter.on,
    send: (data, connectionHandle) => {
      const sentEnvelope = {
        connectionHandle,
        envelope: readEnvelope(bytesOf(data), {
          failures: CLIENT_FAILURES,
          maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
        }),
      };
      const sendError = control.sendErrors.get(connectionHandle);

      sent.push(sentEnvelope);
      control.onSend?.(sentEnvelope);

      return sendError === undefined ? Promise.resolve() : Promise.reject(sendError);
    },
  };

  const open = (connectionHandle: Handle) => {
    emitter.emit('connection', {}, {}, connectionHandle);
  };

  const close = (connectionHandle: Handle) => {
    emitter.emit('close', false, connectionHandle);
  };

  const deliver = (connectionHandle: Handle, envelope: OutgoingEnvelope | Uint8Array) => {
    emitter.emit(
      'message',
      envelope instanceof Uint8Array ? envelope : envelopeOf(envelope),
      connectionHandle
    );
  };

  return { close, control, deliver, emitter, open, sent, transport };
};

const recordErrors = (router: ReturnType<typeof createRouterServer>) => {
  const errors: [Error, string][] = [];

  router.on('error', (error, connectionHandle) => {
    errors.push([error, connectionHandle]);
  });

  return errors;
};

/** Each error reported, as its failure's code or its message, and the connection named. */
const reportedOf = (errors: [Error, string][]) => {
  return errors.map(([error, connectionHandle]) => {
    return [error instanceof FailureError ? error.code : error.message, connectionHandle];
  });
};

/** What was sent: the connection, the kind, the call id, and a failure's code or a payload's text. */
const answersOf = (sent: ISentEnvelope[]) => {
  return sent.map(({ connectionHandle, envelope }) => {
    if (envelope?.kind === EnvelopeKind.FAILURE) {
      return [connectionHandle, 'failure', envelope.header.callId, envelope.failure.code];
    }

    return [
      connectionHandle,
      envelope?.kind === EnvelopeKind.RESULT ? 'result' : envelope?.kind,
      envelope?.header.callId,
      envelope === undefined ||
      envelope.kind === EnvelopeKind.CANCEL ||
      envelope.kind === EnvelopeKind.CREDIT
        ? undefined
        : text.decode(envelope.payload),
    ];
  });
};

const recordActivity = (router: ReturnType<typeof createRouterServer>) => {
  const activity: string[] = [];

  router.on('activity', (what, connectionHandle) => {
    activity.push(`${what} ${connectionHandle === first ? 'first' : 'second'}`);
  });

  return activity;
};

// definition

test.describe('createRouterServer', () => {
  test('takes this package’s transport server', () => {
    const transport = createWSTransportServer({ WebSocketServer });
    using router = createRouterServer(transport);

    expect(router.transport).toBe(transport);
    expect(router.failures).toBe(SERVER_FAILURES);
    expect(router.notifications.subscriptions()).toEqual([]);
  });

  test("runs on its transport's clock, or on the one it is given when its transport has none, and refuses one that differs", () => {
    const clock = createTestClock();
    const { transport } = createScriptedTransport();
    using onItsTransport = createRouterServer(createWSTransportServer({ clock, WebSocketServer }));
    using onItsOwn = createRouterServer(transport, { clock });

    expect([onItsTransport.clock, onItsOwn.clock]).toEqual([clock, clock]);
    expect(() => {
      createRouterServer(createWSTransportServer({ WebSocketServer }), { clock });
    }).toThrow(
      new ProgrammerError(
        "a server's router runs on the clock of its transport, the platform's, and was given another, one of its own"
      )
    );
  });

  test.describe('a connection’s requests', () => {
    test('go to the resolver registered, which answers on their call id, announcing the session once', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport, {
        sessionTokenOf: (connectionHandle) => {
          return connectionHandle === first ? TOKEN : undefined;
        },
      });
      const services = createServiceManager(router);

      services.getRequestResolver(echo, { serializer: answering })((request, response) => {
        return response(`${request.payload}!`);
      });

      deliver(first, requestOf(31, { payload: text.encode('hi') }));
      deliver(first, requestOf(33, { payload: text.encode('ho') }));
      deliver(second, requestOf(31, { payload: text.encode('hu') }));
      await sleep(0);

      expect(
        sent.map(({ connectionHandle, envelope }) => {
          return [connectionHandle, envelope];
        })
      ).toEqual([
        [
          first,
          {
            header: { callId: 31, kind: EnvelopeKind.RESULT, sessionToken: TOKEN },
            kind: EnvelopeKind.RESULT,
            payload: text.encode('hi!'),
          },
        ],
        [
          first,
          {
            header: { callId: 33, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: text.encode('ho!'),
          },
        ],
        [
          second,
          {
            header: { callId: 31, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: text.encode('hu!'),
          },
        ],
      ]);
    });

    test('are asked their admission once, on their header, before their payload is read', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const asked: number[] = [];

      services.getRequestResolver(echo, {
        beforeRequest: ({ header: { callId } }) => {
          asked.push(callId);

          return callId === 31;
        },
        serializer: {
          ...answering,
          decode: (bytes: Uint8Array) => {
            if (bytes.length === 0) {
              throw new TypeError('no text');
            }

            return text.decode(bytes);
          },
        },
      })((request, response) => {
        return response(`${request.payload}!`);
      });

      deliver(first, requestOf(31, { payload: text.encode('hi') }));
      // refused before it is read: undecodable, it is refused all the same
      deliver(first, requestOf(33));
      await sleep(0);

      expect(asked).toEqual([31, 33]);
      expect(answersOf(sent)).toEqual([
        [first, 'result', 31, 'hi!'],
        [first, 'failure', 33, ProtocolCode.ACCESS_DENIED],
      ]);
    });

    test('refused their admission never reach a callback, which would subscribe a plain request', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      const reached: string[] = [];

      services.getNotificationResolver(news, {
        beforeRequest: () => {
          return false;
        },
        serializer: answering,
      })((request, response) => {
        reached.push(request.payload);
        response.registerNotification();

        return response('ok');
      });

      deliver(first, requestOf(31, { payload: text.encode('hi'), procedure: news }));
      await sleep(0);

      expect(reached).toEqual([]);
      expect(answersOf(sent)).toEqual([[first, 'failure', 31, ProtocolCode.ACCESS_DENIED]]);
      expect(errors).toEqual([]);
    });

    test('answered after their connection closed send nothing, so the handle is told its session anew', async () => {
      const { close, deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport, {
        sessionTokenOf: () => {
          return TOKEN;
        },
      });
      const services = createServiceManager(router);
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();

      services.getRequestResolver(echo, { serializer: answering })(async (request, response) => {
        if (request.payload === 'late') {
          await closed;
        }

        return response(`${request.payload}!`);
      });

      deliver(first, requestOf(1, { payload: text.encode('late') }));
      await sleep(0);
      close(first);
      onClosed();
      await sleep(0);
      deliver(first, requestOf(3, { payload: text.encode('again') }));
      await sleep(0);

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([{ callId: 3, kind: EnvelopeKind.RESULT, sessionToken: TOKEN }]);
    });

    test('are refused when nobody answers them, or they name a destination: this router relays nothing', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const nextCallId = callIdsOf('client');

      router.registerResolver(
        Object.assign(
          () => {
            return Promise.resolve();
          },
          { ...echo, procedureId: 9 }
        )
      );

      deliver(first, requestOf(nextCallId(), { procedure: { ...echo, serviceId: 99 } }));
      deliver(first, requestOf(nextCallId()));
      deliver(first, requestOf(nextCallId(), { destinationId: 4 }));
      deliver(first, Uint8Array.of(0xa2, 0x10, 0, 3, 0, 0, 0, 7, 0, 2, 0, 1));
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        [first, 'failure', 1, ProtocolCode.SERVICE_UNKNOWN],
        [first, 'failure', 3, ProtocolCode.PROCEDURE_UNKNOWN],
        [first, 'failure', 5, ProtocolCode.DESTINATION_UNKNOWN],
        [first, 'failure', 7, ProtocolCode.LAYOUT_UNSUPPORTED],
      ]);
      expect(sent[2]?.envelope?.header).toEqual({ callId: 5, kind: EnvelopeKind.FAILURE });
    });

    test('are the only envelopes answered: any other is reported', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const errors = recordErrors(router);

      deliver(first, {
        header: { callId: 1, kind: EnvelopeKind.NOTIFICATION },
        kind: EnvelopeKind.NOTIFICATION,
        payload: new Uint8Array(0),
      });
      deliver(first, resultOf(2));
      deliver(second, Uint8Array.of(0xa2, 0x11, 0, 2, 0, 0, 0, 3));
      await sleep(0);

      expect(sent).toEqual([]);
      expect(reportedOf(errors)).toEqual([
        [ProtocolCode.KIND_UNSUPPORTED, first],
        [ProtocolCode.CALL_UNKNOWN, first],
        [ProtocolCode.LAYOUT_UNSUPPORTED, second],
      ]);
    });

    test('that fail in their resolver, or do not read, are reported with their connection', async () => {
      const { control, deliver, emitter, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const errors = recordErrors(router);

      router.registerResolver(
        Object.assign(() => {
          return Promise.reject(new Error('rejected'));
        }, echo)
      );
      router.registerResolver(
        Object.assign(() => {
          throw new Error('thrown');
        }, news)
      );

      deliver(first, requestOf(1));
      deliver(second, subscribingOf(1));
      emitter.emit('message', 'text', first);

      // a refusal that cannot go out
      control.sendErrors.set(second, new Error('gone'));
      deliver(second, requestOf(3, { procedure: { ...echo, serviceId: 99 } }));
      await sleep(0);

      expect(reportedOf(errors)).toEqual([
        ['thrown', second],
        [ProtocolCode.ENVELOPE_MALFORMED, first],
        ['rejected', first],
        ['gone', second],
      ]);
    });

    test('of the server’s own parity, or on a subscription’s call id, are reported on their connection, and taken on another', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      open(first);
      open(second);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      deliver(first, subscribingOf(13));
      await sleep(0);
      sent.length = 0;

      deliver(first, subscribingOf(13));
      deliver(first, subscribingOf(14));
      deliver(second, subscribingOf(13));
      await sleep(0);

      expect(reportedOf(errors)).toEqual([
        [ProtocolCode.ENVELOPE_MALFORMED, first],
        [ProtocolCode.ENVELOPE_MALFORMED, first],
      ]);
      expect(answersOf(sent)).toEqual([[second, 'result', 13, 'ok']]);
      expect(router.notifications.subscriptions()).toEqual([
        { callId: 13, connectionHandle: first, procedureId: 5, serviceId: 2 },
        { callId: 13, connectionHandle: second, procedureId: 5, serviceId: 2 },
      ]);
    });

    test('whose answer’s session cannot be told are answered by nothing, and reported', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      const failure = new Error('no session');
      using router = createRouterServer(transport, {
        sessionTokenOf: () => {
          throw failure;
        },
      });
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      services.getRequestResolver(echo, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      deliver(first, requestOf(1));
      await sleep(0);

      expect(sent).toEqual([]);
      expect(reportedOf(errors)).toEqual([['no session', first]]);
    });

    test('refuse a second resolver for one procedure', () => {
      using router = createRouterServer(createScriptedTransport().transport);
      const resolver = Object.assign(() => {
        return Promise.resolve();
      }, echo);

      router.registerResolver(resolver);

      expect(() => {
        router.registerResolver(resolver);
      }).toThrow(ProgrammerError);
    });
  });

  test.describe('its own requests', () => {
    test('go to the connection their options name, on even call ids, and resolve with that connection’s result alone', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport, {
        sessionTokenOf: () => {
          return TOKEN;
        },
      });
      const errors = recordErrors(router);
      const activity = recordActivity(router);

      open(first);
      open(second);

      const answering = router.request(text.encode('ping'), {
        options: { ...options, connectionHandle: first },
        procedure: echo,
      });

      await sleep(0);

      // a request presents no session
      expect(sent).toEqual([
        {
          connectionHandle: first,
          envelope: {
            header: { callId: 2, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 },
            kind: EnvelopeKind.REQUEST,
            payload: text.encode('ping'),
          },
        },
      ]);

      // the same call id, from another connection, answers nothing
      deliver(second, resultOf(2));
      deliver(first, resultOf(2, text.encode('pong')));

      expect(text.decode((await answering).payload)).toBe('pong');
      expect(reportedOf(errors)).toEqual([[ProtocolCode.CALL_UNKNOWN, second]]);
      expect(activity).toEqual(['request first', 'response first']);
    });

    test('name their connection, and it must be open; a server holds no subscription', async () => {
      const { close, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);

      await expect(
        router.request(new Uint8Array(0), { options, procedure: echo })
      ).rejects.toBeInstanceOf(ProgrammerError);
      await expect(
        router.request(new Uint8Array(0), {
          options: { ...options, connectionHandle: first },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(DisconnectError);

      open(first);

      await expect(
        router.request(new Uint8Array(0), {
          options: { ...options, connectionHandle: first },
          procedure: news,
          subscribes: {
            ...news,
            trigger: () => {
              return Promise.resolve([]);
            },
          },
        })
      ).rejects.toBeInstanceOf(ProgrammerError);

      close(first);

      await expect(
        router.request(new Uint8Array(0), {
          options: { ...options, connectionHandle: first },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(DisconnectError);
    });

    test('reach a connection that spoke before the router saw it open', async () => {
      const { deliver, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);

      deliver(first, Uint8Array.of(0xa1, 0x80, 0, 2, 0, 0, 0, 1));

      const answering = router.request(new Uint8Array(0), {
        options: { ...options, connectionHandle: first },
        procedure: echo,
      });

      await sleep(0);
      deliver(first, resultOf(sent.at(-1)?.envelope?.header.callId ?? 0));

      await expect(answering).resolves.toBeDefined();
    });

    test('reject with the failure answered, time out, and are rejected when their connection closes', async () => {
      const { close, deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const request = (connectionHandle: Handle, timeout = 1_000) => {
        return router.request(new Uint8Array(0), {
          options: { connectionHandle, timeout },
          procedure: echo,
        });
      };

      open(first);
      open(second);

      const failed = request(first);

      deliver(first, {
        failure: { ...CLIENT_FAILURES.procedureUnknown, detail: 'why' },
        header: { callId: 2, kind: EnvelopeKind.FAILURE },
        kind: EnvelopeKind.FAILURE,
      });

      await expect(failed).rejects.toMatchObject({
        code: ProtocolCode.PROCEDURE_UNKNOWN,
        detail: 'why',
        origin: 'peer',
        side: 'client',
      });
      await expect(request(first, 10)).rejects.toBeInstanceOf(TimeoutError);

      const closing = request(first);
      const staying = request(second);

      await sleep(0);
      close(first);

      await expect(closing).rejects.toBeInstanceOf(DisconnectError);

      deliver(second, resultOf(8));

      await expect(staying).resolves.toBeDefined();
    });

    test('refuse a payload too large, here', async () => {
      const { open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);

      open(first);

      await expect(
        router.request(new Uint8Array(0x1000001), {
          options: { ...options, connectionHandle: first },
          procedure: echo,
        })
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE, side: 'server' });
    });
  });

  test.describe('notifications', () => {
    test('a notification’s successful answer subscribes the connection under its call id, once, before the answer goes out; a plain request’s does not', async () => {
      const { control, deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const subscribedWhenSent: string[][] = [];

      control.onSend = ({ connectionHandle }) => {
        subscribedWhenSent.push(
          [...router.notifications.candidates(news).keys()].map((subscriber) => {
            return subscriber === connectionHandle ? 'itself' : 'another';
          })
        );
      };

      open(first);
      open(second);

      services.getRequestResolver(echo, { serializer: answering })((_request, response) => {
        return response('plain');
      });
      services.getNotificationResolver(news, { serializer: answering })((request, response) => {
        return request.payload === 'refuse' ? response(null, { code: 1 }) : response('ok');
      });

      deliver(first, requestOf(1));
      deliver(first, subscribingOf(3, { payload: text.encode('in') }));
      deliver(first, subscribingOf(5, { payload: text.encode('in') }));
      deliver(second, subscribingOf(1, { payload: text.encode('refuse') }));
      await sleep(0);

      // the plain answer subscribed nobody; the first answer went out with its connection subscribed
      expect(subscribedWhenSent).toEqual([[], ['itself'], ['itself'], ['another']]);
      // the first subscription is kept: a later successful request moves nothing
      expect(router.notifications.subscriptions()).toEqual([
        { callId: 3, connectionHandle: first, procedureId: 5, serviceId: 2 },
      ]);
      expect(answersOf(sent)[3]).toEqual([second, 'failure', 1, 1]);
    });

    test('an ordinary request answered before any subscription takes no place: the subscription after it is kept', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);

      open(first);

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      deliver(first, requestOf(1, { procedure: news }));
      await sleep(0);
      deliver(first, subscribingOf(3));
      await sleep(0);
      sent.length = 0;
      await resolver.notify('flash');

      expect(router.notifications.subscriptions()).toEqual([
        { callId: 3, connectionHandle: first, procedureId: 5, serviceId: 2 },
      ]);
      expect(answersOf(sent)).toEqual([[first, EnvelopeKind.NOTIFICATION, 3, 'flash']]);
    });

    test('a callback that subscribes an ordinary request fails, is reported, and subscribes nothing', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      open(first);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        response.registerNotification();

        return response('ok');
      });

      deliver(first, requestOf(1, { procedure: news }));
      await sleep(0);

      expect(answersOf(sent)).toEqual([[first, 'failure', 1, ProtocolCode.PROCEDURE_FAILED]]);
      expect(
        errors.map(([error]) => {
          return error;
        })
      ).toEqual([expect.any(ProgrammerError)]);
      expect(router.notifications.subscriptions()).toEqual([]);
    });

    test('notify reaches each subscriber under the call id it subscribed with, and announces no session', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport, {
        sessionTokenOf: (connectionHandle) => {
          return connectionHandle === first ? TOKEN : OTHER_TOKEN;
        },
      });
      const services = createServiceManager(router);
      const activity = recordActivity(router);

      open(first);
      open(second);

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      deliver(first, subscribingOf(13));
      deliver(second, subscribingOf(21));
      await sleep(0);
      sent.length = 0;
      await resolver.notify('flash');

      expect(
        sent.map(({ connectionHandle, envelope }) => {
          return [connectionHandle, envelope];
        })
      ).toEqual([
        [
          first,
          {
            header: { callId: 13, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload: text.encode('flash'),
          },
        ],
        [
          second,
          {
            header: { callId: 21, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload: text.encode('flash'),
          },
        ],
      ]);
      expect(activity).toEqual(['notification first', 'notification second']);
    });

    test('notify reaches only those its options keep', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const third: Handle = 'type=WS;ip=127.0.0.1;port=50003';

      open(first);
      open(second);
      open(third);

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      for (const connectionHandle of [first, second, third]) {
        deliver(connectionHandle, subscribingOf(1));
      }

      await sleep(0);

      const reached = async (notifyOptions?: Parameters<typeof resolver.notify>[1]) => {
        sent.length = 0;
        await resolver.notify('flash', notifyOptions);

        return sent.map(({ connectionHandle }) => {
          return connectionHandle;
        });
      };

      expect(await reached()).toEqual([first, second, third]);
      expect(await reached({ exclude: second })).toEqual([first, third]);
      expect(
        await reached({
          filter: (connectionHandle) => {
            return connectionHandle !== first;
          },
        })
      ).toEqual([second, third]);
      expect(
        await reached({
          exclude: third,
          filter: (connectionHandle) => {
            return connectionHandle !== first;
          },
        })
      ).toEqual([second]);
    });

    test('notify sends to none when its filter throws on any', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const failure = new Error('no such user');
      const seen: unknown[] = [];

      open(first);
      open(second);
      services.on('debug', (error) => {
        seen.push(error);
      });

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      deliver(first, subscribingOf(1));
      deliver(second, subscribingOf(1));
      await sleep(0);
      sent.length = 0;

      await resolver.notify('flash', {
        filter: (connectionHandle) => {
          if (connectionHandle === second) {
            throw failure;
          }

          return true;
        },
      });

      expect(sent).toEqual([]);
      expect(seen).toContain(failure);
    });

    test('a connection that closes is no longer notified, and one that cannot take it keeps none from the others', async () => {
      const { close, control, deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      const activity = recordActivity(router);

      open(first);
      open(second);

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      deliver(first, subscribingOf(1));
      deliver(second, subscribingOf(1));
      await sleep(0);

      control.sendErrors.set(first, new Error('full'));
      sent.length = 0;
      await resolver.notify('flash');

      expect(reportedOf(errors)).toEqual([['full', first]]);
      expect(
        sent.map(({ connectionHandle }) => {
          return connectionHandle;
        })
      ).toEqual([first, second]);
      expect(activity).toEqual(['notification second']);

      close(first);
      sent.length = 0;
      await resolver.notify('flash');

      expect(
        sent.map(({ connectionHandle }) => {
          return connectionHandle;
        })
      ).toEqual([second]);
    });

    test('notify refuses a payload too large for each connection, and reports it with that connection', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      open(first);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      deliver(first, subscribingOf(1));
      await sleep(0);
      sent.length = 0;

      await router.notify(new Uint8Array(0x1000001), { procedure: news });

      expect(sent).toEqual([]);
      expect(reportedOf(errors)).toEqual([[ProtocolCode.PAYLOAD_TOO_LARGE, first]]);
    });

    test('notify sends a notification in one envelope, of the router’s limits, or refuses it for each connection', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport, {
        limits: { chunkBytes: 64, maximumEnvelopeBytes: 64, windowBytes: 128 },
      });
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      open(first);
      open(second);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      deliver(first, subscribingOf(1));
      deliver(second, subscribingOf(1));
      await sleep(0);
      sent.length = 0;

      // its header takes 8 bytes of the 64
      await router.notify(new Uint8Array(57), { procedure: news });
      await router.notify(new Uint8Array(56), { procedure: news });

      expect(reportedOf(errors)).toEqual([
        [ProtocolCode.PAYLOAD_TOO_LARGE, first],
        [ProtocolCode.PAYLOAD_TOO_LARGE, second],
      ]);
      expect(answersOf(sent)).toHaveLength(2);
      expect(() => {
        return createRouterServer(transport, { limits: { windowBytes: 1 } });
      }).toThrow(ProgrammerError);
      // it shows them, and passes on what hears its own request handed to the transport
      expect(router.limits).toMatchObject({ chunkBytes: 64, maximumEnvelopeBytes: 64 });

      const heard: string[] = [];
      const asking = router
        .request(Uint8Array.of(1), {
          onSent: (isHanded) => {
            heard.push(String(isHanded));
          },
          options: { ...options, connectionHandle: first },
          procedure: news,
        })
        .catch((reason: unknown) => {
          return reason;
        });

      expect(heard).toEqual(['true']);
      router[Symbol.dispose]();
      expect(await asking).toBeInstanceOf(DisconnectError);
    });

    test('a connection that closes before its answer goes out is not subscribed', async () => {
      const { close, deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
      const { promise: answered, resolve: onAnswered } = Promise.withResolvers<void>();

      open(first);
      services.getNotificationResolver(news, { serializer: answering })(
        async (_request, response) => {
          await closed;
          await response('ok');
          onAnswered();
        }
      );

      deliver(first, subscribingOf(1));
      close(first);
      onClosed();
      await answered;

      expect(router.notifications.subscriptions()).toEqual([]);
    });

    test('a callback that subscribes before it answers gets its request’s call id, and the one held each time after', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);

      open(first);

      const resolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response(String(response.registerNotification()));
      });

      deliver(first, subscribingOf(7));
      deliver(first, subscribingOf(9));
      await sleep(0);

      expect(answersOf(sent)).toEqual([
        [first, 'result', 7, '7'],
        [first, 'result', 9, '7'],
      ]);
      expect(router.notifications.subscriptions()).toEqual([
        { callId: 7, connectionHandle: first, procedureId: 5, serviceId: 2 },
      ]);

      sent.length = 0;
      await resolver.notify('flash');

      expect(sent[0]?.envelope?.header).toEqual({ callId: 7, kind: EnvelopeKind.NOTIFICATION });
    });

    test('keeps apart the subscribing calls in flight on one connection, each settled by its own answer', async () => {
      const { deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const other: IProcedure = { ...news, procedureId: 7, procedureName: 'other' };
      const gates = new Map([
        [news.procedureId, Promise.withResolvers<void>()],
        [other.procedureId, Promise.withResolvers<void>()],
      ]);

      open(first);

      for (const procedure of [news, other]) {
        services.getNotificationResolver(procedure, { serializer: answering })(
          async (request, response) => {
            response.registerNotification();
            await gates.get(request.header.procedureId)?.promise;

            return request.payload === 'refuse' ? response(null, { code: 1 }) : response('ok');
          }
        );
      }

      deliver(first, subscribingOf(1, { payload: text.encode('refuse') }));
      deliver(first, subscribingOf(3, { payload: text.encode('in'), procedure: other }));
      await sleep(0);

      expect(router.notifications.subscriptions(first)).toHaveLength(2);

      gates.get(news.procedureId)?.resolve();
      gates.get(other.procedureId)?.resolve();
      await sleep(0);

      expect(router.notifications.subscriptions(first)).toEqual([
        { callId: 3, connectionHandle: first, procedureId: 7, serviceId: 2 },
      ]);
    });

    test('what an answer subscribed goes with it when it is a failure, or does not go out', async () => {
      const { control, deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);

      open(first);
      open(second);

      services.getNotificationResolver(news, { serializer: answering })((request, response) => {
        if (request.payload !== 'implicit') {
          response.registerNotification();
        }

        return request.payload === 'refuse' ? response(null, { code: 1 }) : response('ok');
      });

      // a failure answered, after its callback subscribed
      deliver(first, subscribingOf(1, { payload: text.encode('refuse') }));
      await sleep(0);

      expect(router.notifications.subscriptions()).toEqual([]);

      // answers that cannot go out, whoever subscribed
      control.sendErrors.set(second, new Error('gone'));
      deliver(second, subscribingOf(1, { payload: text.encode('explicit') }));
      // undone before the next answers, so that one subscribes the connection itself
      await sleep(0);
      deliver(second, subscribingOf(3, { payload: text.encode('implicit') }));
      await sleep(0);

      expect(router.notifications.subscriptions()).toEqual([]);
      expect(reportedOf(errors)).toEqual([
        ['gone', second],
        ['gone', second],
      ]);
    });

    test('a subscription’s result too large for one envelope is refused, answered as failed, and subscribes nothing', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      // one byte past what a result's envelope holds whole, its session counted
      const large = 'x'.repeat(1_048_553);

      open(first);
      services.getNotificationResolver(news, { serializer: answering })((request, response) => {
        if (request.payload === 'explicit') {
          response.registerNotification();
        }

        return response(large);
      });

      // whether its callback subscribed, or its answer would have
      deliver(first, subscribingOf(1, { payload: text.encode('explicit') }));
      deliver(first, subscribingOf(3, { payload: text.encode('implicit') }));
      await sleep(0);

      expect(router.notifications.subscriptions()).toEqual([]);
      expect(answersOf(sent)).toEqual([
        [first, 'failure', 1, ProtocolCode.PROCEDURE_FAILED],
        [first, 'failure', 3, ProtocolCode.PROCEDURE_FAILED],
      ]);
      expect(reportedOf(errors)).toEqual([
        [ProtocolCode.PAYLOAD_TOO_LARGE, first],
        [ProtocolCode.PAYLOAD_TOO_LARGE, first],
      ]);
    });

    test('a callback subscribes only an open connection, and fails otherwise', async () => {
      const { close, deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
      const thrown: unknown[] = [];

      open(first);
      services.getNotificationResolver(news, { serializer: answering })(
        async (_request, response) => {
          await closed;

          try {
            await response(String(response.registerNotification()));
          } catch (reason) {
            thrown.push(reason);

            throw reason;
          }
        }
      );

      deliver(first, subscribingOf(1));
      close(first);
      onClosed();
      await sleep(0);

      expect(router.notifications.subscriptions()).toEqual([]);
      expect(thrown).toEqual([expect.any(DisconnectError)]);
      // nor answered, nor reported: its connection took the call away, and its call id may be
      // another's now
      expect(sent).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('a cancel takes away what its call subscribed in flight, and nothing answers it', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      const { promise: held, resolve: release } = Promise.withResolvers<void>();

      open(first);
      services.getNotificationResolver(news, { serializer: answering })(
        async (_request, response) => {
          response.registerNotification();
          await held;

          return response('ok');
        }
      );

      deliver(first, subscribingOf(1));
      await sleep(0);

      expect(router.notifications.subscriptions(first)).toHaveLength(1);

      deliver(first, cancelOf(1));
      release();
      await sleep(0);

      expect(router.notifications.subscriptions()).toEqual([]);
      expect(sent).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('a callback that subscribes once its call was cancelled subscribes nothing, and the next one is kept', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);
      const thrown: unknown[] = [];
      const { promise: cancelled, resolve: onCancelled } = Promise.withResolvers<void>();
      let calls = 0;

      open(first);

      const newsResolver = services.getNotificationResolver(news, { serializer: answering })(async (
        _request,
        response
      ) => {
        calls += 1;

        // the first one is slow, and its requester gives up meanwhile
        if (calls === 1) {
          await cancelled;
        }

        try {
          await response(String(response.registerNotification()));
        } catch (reason) {
          thrown.push(reason);

          throw reason;
        }
      });

      deliver(first, subscribingOf(1));
      deliver(first, cancelOf(1));
      onCancelled();
      await sleep(0);

      expect(thrown).toEqual([expect.any(CancelError)]);
      expect(router.notifications.subscriptions()).toEqual([]);

      // subscribed again, it hears what comes
      deliver(first, subscribingOf(3));
      await sleep(0);
      await newsResolver.notify('flash');

      expect(answersOf(sent)).toEqual([
        [first, 'result', 3, '3'],
        [first, EnvelopeKind.NOTIFICATION, 3, 'flash'],
      ]);
    });

    test('a cancel takes an established subscription away, on its own connection alone', async () => {
      const { deliver, open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);

      open(first);
      open(second);

      const newsResolver = services.getNotificationResolver(news, { serializer: answering })((
        _request,
        response
      ) => {
        return response('ok');
      });

      deliver(first, subscribingOf(1));
      deliver(second, subscribingOf(1));
      await sleep(0);
      sent.length = 0;
      // another connection's cancel touches nothing of this one
      deliver(second, cancelOf(1));
      await newsResolver.notify('flash');

      expect(answersOf(sent)).toEqual([[first, EnvelopeKind.NOTIFICATION, 1, 'flash']]);
      expect(router.notifications.subscriptions()).toEqual([
        {
          callId: 1,
          connectionHandle: first,
          procedureId: news.procedureId,
          serviceId: news.serviceId,
        },
      ]);
    });

    test.describe('a subscription answered while another call, still in flight, holds its place', () => {
      /**
       * A server where a request of `hold` subscribes and waits, then fails or waits for its cancel
       * as `outcome` says, and any other subscribes at once and answers.
       */
      const createHolding = (outcome: 'answer' | 'cancel' | 'fail') => {
        const scripted = createScriptedTransport();
        const router = createRouterServer(scripted.transport);
        const services = createServiceManager(router);
        const { promise: released, resolve: release } = Promise.withResolvers<void>();

        scripted.open(first);

        const newsResolver = services.getNotificationResolver(news, { serializer: answering })(
          async (request, response) => {
            response.registerNotification();

            if (request.payload !== 'hold') {
              return response('ok');
            }

            if (outcome === 'cancel') {
              await new Promise<void>((_resolve, reject) => {
                request.signal.addEventListener('abort', () => {
                  reject(new Error('stopped'));
                });
              });
            }

            await released;

            return outcome === 'fail' ? response(null, { code: 1 }) : response('held');
          }
        );

        // the call that holds the place, then the one answered meanwhile
        scripted.deliver(first, subscribingOf(1, { payload: text.encode('hold') }));
        scripted.deliver(first, subscribingOf(3, { payload: text.encode('subscribe') }));

        return { ...scripted, newsResolver, release, router };
      };

      const held = () => {
        return [
          {
            callId: 1,
            connectionHandle: first,
            procedureId: news.procedureId,
            serviceId: news.serviceId,
          },
        ];
      };

      test('takes the place when that call fails, and hears what comes', async () => {
        const { newsResolver, release, router, sent } = createHolding('fail');

        await sleep(0);

        expect(router.notifications.subscriptions()).toEqual(held());

        release();
        await sleep(0);
        sent.length = 0;
        await newsResolver.notify('flash');

        expect(answersOf(sent)).toEqual([[first, EnvelopeKind.NOTIFICATION, 3, 'flash']]);
        router[Symbol.dispose]();
      });

      test('takes the place when that call is cancelled', async () => {
        const { deliver, router } = createHolding('cancel');

        await sleep(0);
        deliver(first, cancelOf(1));
        await sleep(0);

        expect(router.notifications.subscriptions()).toMatchObject([{ callId: 3 }]);
        router[Symbol.dispose]();
      });

      test('takes the place when the answer of that call cannot go out', async () => {
        const { control, release, router } = createHolding('answer');

        await sleep(0);
        control.sendErrors.set(first, new Error('gone'));
        release();
        await sleep(0);

        expect(router.notifications.subscriptions()).toMatchObject([{ callId: 3 }]);
        router[Symbol.dispose]();
      });

      test('stays out once that call is answered, and does not take a place it leaves later', async () => {
        const { deliver, release, router } = createHolding('answer');

        await sleep(0);
        release();
        await sleep(0);

        expect(router.notifications.subscriptions()).toEqual(held());

        // the requester of the call that holds it lets go of it: the place is no one's
        deliver(first, cancelOf(1));

        expect(router.notifications.subscriptions()).toEqual([]);
        router[Symbol.dispose]();
      });

      test('takes nothing once cancelled, or unsubscribed, itself', async () => {
        for (const leave of ['cancel', 'unsubscribe'] as const) {
          const { deliver, release, router } = createHolding('fail');

          await sleep(0);

          if (leave === 'cancel') {
            deliver(first, cancelOf(3));
          } else {
            router.unsubscribe({ callId: 3, connectionHandle: first });
          }

          release();
          await sleep(0);

          expect(router.notifications.subscriptions(), leave).toEqual([]);
          router[Symbol.dispose]();
        }
      });

      test('waits by procedure: two held on one connection each hand their own place over', async () => {
        const { deliver, open, transport } = createScriptedTransport();
        using router = createRouterServer(transport);
        const services = createServiceManager(router);
        const other: IProcedure = { ...news, procedureId: 7, procedureName: 'other' };
        const { promise: released, resolve: release } = Promise.withResolvers<void>();

        open(first);

        for (const procedure of [news, other]) {
          services.getNotificationResolver(procedure, { serializer: answering })(
            async (request, response) => {
              response.registerNotification();

              if (request.payload === 'hold') {
                await released;

                return response(null, { code: 1 });
              }

              return response('ok');
            }
          );
        }

        deliver(first, subscribingOf(1, { payload: text.encode('hold') }));
        deliver(first, subscribingOf(3, { payload: text.encode('hold'), procedure: other }));
        deliver(first, subscribingOf(5, { payload: text.encode('subscribe') }));
        deliver(first, subscribingOf(7, { payload: text.encode('subscribe'), procedure: other }));
        await sleep(0);
        release();
        await sleep(0);

        expect(
          router.notifications.subscriptions().map(({ callId, procedureId }) => {
            return [callId, procedureId];
          })
        ).toEqual([
          [5, news.procedureId],
          [7, other.procedureId],
        ]);
      });

      test('is the first answered: one answered after it waits for nothing', async () => {
        const { deliver, release, router } = createHolding('fail');

        deliver(first, subscribingOf(5, { payload: text.encode('subscribe') }));
        await sleep(0);
        release();
        await sleep(0);

        expect(router.notifications.subscriptions()).toMatchObject([{ callId: 3 }]);
        router[Symbol.dispose]();
      });

      test('takes no place on a connection that closed as the answer of that call failed to go out', async () => {
        const { close, control, release, router } = createHolding('answer');

        await sleep(0);
        control.sendErrors.set(first, new Error('gone'));
        control.onSend = ({ envelope }) => {
          if (envelope?.header.callId === 1) {
            close(first);
          }
        };
        release();
        await sleep(0);

        expect(router.notifications.subscriptions()).toEqual([]);
        router[Symbol.dispose]();
      });

      test('is ended as an established one when the session ends, and takes nothing after', async () => {
        const { release, router, sent } = createHolding('fail');

        await sleep(0);
        sent.length = 0;
        await router.dropSubscriptions({
          connectionHandle: first,
          failure: SERVER_FAILURES.sessionRequired,
        });
        release();
        await sleep(0);

        expect(answersOf(sent)).toEqual([
          [first, 'failure', 3, ProtocolCode.SESSION_REQUIRED],
          [first, 'failure', 1, 1],
        ]);
        expect(router.notifications.subscriptions()).toEqual([]);
        router[Symbol.dispose]();
      });
    });

    test('a subscription answered once another holds its place, answered already, waits for nothing', async () => {
      const { deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);

      open(first);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response(String(response.registerNotification()));
      });
      deliver(first, subscribingOf(1));
      await sleep(0);
      deliver(first, subscribingOf(3));
      await sleep(0);
      // the place is left, and no one takes it
      deliver(first, cancelOf(1));

      expect(router.notifications.subscriptions()).toEqual([]);
    });

    test('a callback that subscribes as the router is disposed hears a DisconnectError', async () => {
      const { deliver, open, transport } = createScriptedTransport();
      const router = createRouterServer(transport);
      const services = createServiceManager(router);
      const thrown: unknown[] = [];

      open(first);
      services.getNotificationResolver(news, { serializer: answering })((request, response) => {
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            try {
              response.registerNotification();
            } catch (reason) {
              thrown.push(reason);
            }

            reject(new Error('stopped'));
          });
        });
      });

      deliver(first, subscribingOf(1));
      await sleep(0);
      router[Symbol.dispose]();
      await sleep(0);

      expect(thrown).toEqual([expect.any(DisconnectError)]);
      expect(router.notifications.subscriptions()).toEqual([]);
    });

    test('a command that times out is cancelled, on its even call id', async () => {
      const { open, sent, transport } = createScriptedTransport();
      using router = createRouterServer(transport);

      open(first);

      await expect(
        router.request(text.encode('ping'), {
          options: { connectionHandle: first, timeout: 20 },
          procedure: echo,
        })
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(
        sent.map(({ connectionHandle, envelope }) => {
          return [connectionHandle, envelope?.kind, envelope?.header.callId];
        })
      ).toEqual([
        [first, EnvelopeKind.REQUEST, 2],
        [first, EnvelopeKind.CANCEL, 2],
      ]);
    });

    test('unsubscribe takes a connection’s own subscription away by its call id, and no other’s', async () => {
      const { deliver, open, transport } = createScriptedTransport();
      using router = createRouterServer(transport);
      const services = createServiceManager(router);

      open(first);
      open(second);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      deliver(first, subscribingOf(11));
      await sleep(0);

      expect(router.unsubscribe({ callId: 11, connectionHandle: second })).toBe(false);
      expect(router.unsubscribe({ callId: 13, connectionHandle: first })).toBe(false);
      expect(router.unsubscribe({ callId: 11, connectionHandle: first })).toBe(true);
      expect(router.unsubscribe({ callId: 11, connectionHandle: first })).toBe(false);
      expect(router.notifications.subscriptions()).toEqual([]);
    });

    test('dropSubscriptions ends each established subscription with a failure, the first announcing, and skips a call in flight', async () => {
      const { control, deliver, open, sent, transport } = createScriptedTransport();
      let token: typeof TOKEN | undefined = TOKEN;
      using router = createRouterServer(transport, {
        sessionTokenOf: () => {
          return token;
        },
      });
      const services = createServiceManager(router);
      const errors = recordErrors(router);
      const other: IProcedure = { ...news, procedureId: 7, procedureName: 'other' };
      const inFlight = Promise.withResolvers<void>();

      open(first);
      open(second);
      services.getNotificationResolver(news, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      services.getNotificationResolver(other, { serializer: answering })((_request, response) => {
        return response('ok');
      });
      services.getNotificationResolver(echo, { serializer: answering })(
        async (_request, response) => {
          response.registerNotification();
          await inFlight.promise;

          return response('late');
        }
      );

      deliver(first, subscribingOf(1));
      deliver(first, subscribingOf(3, { procedure: other }));
      deliver(second, subscribingOf(1));
      await sleep(0);
      deliver(first, subscribingOf(5, { procedure: echo }));
      await sleep(0);
      sent.length = 0;
      token = undefined;

      await router.dropSubscriptions({
        connectionHandle: first,
        failure: SERVER_FAILURES.sessionRequired,
      });

      expect(
        sent.map(({ connectionHandle, envelope }) => {
          return [
            connectionHandle,
            envelope?.kind === EnvelopeKind.FAILURE && envelope.failure.code,
            envelope?.header,
          ];
        })
      ).toEqual([
        [
          first,
          ProtocolCode.SESSION_REQUIRED,
          { callId: 1, kind: EnvelopeKind.FAILURE, sessionToken: null },
        ],
        [first, ProtocolCode.SESSION_REQUIRED, { callId: 3, kind: EnvelopeKind.FAILURE }],
      ]);
      // the call in flight keeps its subscription, and gets its own answer alone
      expect(router.notifications.subscriptions()).toEqual([
        { callId: 5, connectionHandle: first, procedureId: 1, serviceId: 2 },
        { callId: 1, connectionHandle: second, procedureId: 5, serviceId: 2 },
      ]);

      inFlight.resolve();
      await sleep(0);

      expect(answersOf(sent).slice(2)).toEqual([[first, 'result', 5, 'late']]);

      // a failure that cannot go out is reported, and the subscription goes all the same
      control.sendErrors.set(second, new Error('gone'));
      await router.dropSubscriptions({
        connectionHandle: second,
        failure: SERVER_FAILURES.sessionRequired,
      });

      expect(reportedOf(errors)).toEqual([['gone', second]]);
      expect(router.notifications.subscriptions(second)).toEqual([]);
    });

    test('a server does not subscribe: it notifies', async () => {
      using router = createRouterServer(createScriptedTransport().transport);
      const notification = {
        ...news,
        trigger: () => {
          return Promise.resolve([]);
        },
      };

      expect(router.hasNotification(notification)).toBe(false);
      await expect(router.registerNotification(notification)).rejects.toBeInstanceOf(
        ProgrammerError
      );
      await expect(router.unregisterNotification(notification)).rejects.toBeInstanceOf(
        ProgrammerError
      );
    });
  });

  test('dispose lets go of the transport, rejects what waits, forgets every connection, and sends nothing more', async () => {
    const { deliver, emitter, open, sent, transport } = createScriptedTransport();
    const router = createRouterServer(transport);
    const services = createServiceManager(router);
    const errors = recordErrors(router);

    open(first);

    const resolver = services.getNotificationResolver(news, { serializer: answering })((
      _request,
      response
    ) => {
      return response('ok');
    });

    deliver(first, subscribingOf(1));
    await sleep(0);

    const waiting = router.request(new Uint8Array(0), {
      options: { ...options, connectionHandle: first },
      procedure: echo,
    });

    await sleep(0);
    router[Symbol.dispose]();
    sent.length = 0;

    await expect(waiting).rejects.toBeInstanceOf(DisconnectError);
    expect(router.notifications.subscriptions()).toEqual([]);
    expect(
      (['close', 'connection', 'message'] as const).map((event) => {
        return emitter.listenerCount(event);
      })
    ).toEqual([0, 0, 0]);

    // an envelope now reaches nothing, and nothing goes out
    deliver(first, subscribingOf(3));
    await resolver.notify('flash');
    await expect(
      router.request(new Uint8Array(0), {
        options: { ...options, connectionHandle: first },
        procedure: echo,
      })
    ).rejects.toBeInstanceOf(DisconnectError);

    // nor does a resolver still at work subscribe a connection nothing would clean
    expect(() => {
      return router.subscribe({
        connectionHandle: first,
        header: {
          callId: 5,
          kind: EnvelopeKind.REQUEST,
          opensSubscription: true,
          procedureId: 5,
          serviceId: 2,
        },
      });
    }).toThrow(DisconnectError);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('tells debug each envelope, with its connection and a copy of its header without its token', async () => {
    const { deliver, sent, transport } = createScriptedTransport();
    using router = createRouterServer(transport, {
      sessionTokenOf: () => {
        return TOKEN;
      },
    });
    const services = createServiceManager(router);
    const seen: unknown[] = [];

    services.getRequestResolver(echo, { serializer: answering })((_request, response) => {
      return response('ok');
    });
    router.on('debug', ({ connectionHandle, direction, header }) => {
      seen.push([direction, connectionHandle === first ? 'first' : '?', { ...header }]);
      // what a listener does to its copy changes nothing of the envelope
      header.callId = 0;
    });

    deliver(first, requestOf(9));
    await sleep(0);

    expect(seen).toEqual([
      [
        'rx',
        'first',
        {
          callId: 9,
          hasSessionToken: false,
          kind: EnvelopeKind.REQUEST,
          procedureId: 1,
          serviceId: 2,
        },
      ],
      ['tx', 'first', { callId: 9, hasSessionToken: true, kind: EnvelopeKind.RESULT }],
    ]);
    expect(sent[0]?.envelope?.header).toEqual({
      callId: 9,
      kind: EnvelopeKind.RESULT,
      sessionToken: TOKEN,
    });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
});

for (const [label, TrackedWebSocket] of IMPLEMENTATIONS) {
  test.describe(`a WebSocket client and server, the client on ${label}`, () => {
    test('ask, answer, subscribe, notify, unsubscribe and command each other over the wire', async () => {
      const serverRouter = createRouterServer(createWSTransportServer({ WebSocketServer }), {
        sessionTokenOf: () => {
          return TOKEN;
        },
      });
      const serverServices = createServiceManager(serverRouter);
      const { port } = await serverRouter.transport.start({ address: host, findOpenPort: true });
      const client = createWSClient({ transport: { WebSocket: TrackedWebSocket } });
      const told: unknown[] = [];

      client.router.on('debug', ({ direction, header }) => {
        told.push([direction, header.kind, header.callId, header.hasSessionToken]);
      });

      try {
        const asked = Promise.withResolvers<Handle>();

        serverServices.getRequestResolver(echo, { serializer: answering })((request, response) => {
          asked.resolve(request.connectionHandle);

          return response(request.payload.toUpperCase());
        });
        const newsResolver = serverServices.getNotificationResolver(news, {
          serializer: answering,
        })(async (_request, response) => {
          await response(String(response.registerNotification()));
          // the state as it is now, right behind the answer
          await newsResolver.notify('first');
        });

        serverServices.getRequestResolver(unsubscribeProcedure, { serializer: answering })(
          (request, response) => {
            return response(
              String(
                serverRouter.unsubscribe({
                  callId: Number(request.payload),
                  connectionHandle: request.connectionHandle,
                })
              )
            );
          }
        );

        const ping = { ...echo, procedureId: 40, procedureName: 'ping' };

        client.services.getRequestResolver(ping, { serializer: answering })(
          (_request, response) => {
            return response('pong');
          }
        );

        await client.connect({ host, port });

        // the client asks, the server answers, announcing the session it gives
        await expect(
          client.services.getRequest(echo, { serializer: asking })('hi')()
        ).resolves.toBe('HI');
        expect(client.router.sessionToken).toBe(TOKEN);

        // the client subscribes, the server notifies it: right behind the answer, and after
        const heard: string[] = [];
        const unsubscribe = client.services.getRequest(unsubscribeProcedure, {
          serializer: asking,
        });
        const unsubscribed: string[] = [];
        const notification = client.services.getNotification(news, {
          serializer: asking,
          unsubscribe: async (callId, response) => {
            unsubscribed.push(`${String(callId)} ${response}`);

            return unsubscribe(String(callId))();
          },
        });
        const registration = await notification('subscribe', (payload) => {
          heard.push(payload);
        })();

        await newsResolver.notify('flash');
        await expect
          .poll(() => {
            return heard;
          })
          .toEqual(['first', 'flash']);

        // the server asks the client, naming its connection, on an even call id
        await expect(
          serverServices.getRequest(ping, { serializer: asking })('ping')({
            connectionHandle: await asked.promise,
          })
        ).resolves.toBe('pong');

        // unsubscribed at the server, by the call id that subscribed, by the time it is taken away
        await registration.unregister();

        expect(unsubscribed).toEqual(['3 3']);
        expect(serverRouter.notifications.subscriptions()).toEqual([]);
        expect(told).toContainEqual(['rx', EnvelopeKind.REQUEST, 2, false]);
        // announced once, on the first answer
        expect(
          told.filter((entry) => {
            return (entry as unknown[])[3] === true;
          })
        ).toEqual([['rx', EnvelopeKind.RESULT, 1, true]]);

        // a subscription again, which the connection takes away with it
        const dropped: unknown[] = [];

        client.services.on('dropped', (procedure) => {
          dropped.push(procedure);
        });
        await notification('subscribe', () => {
          return undefined;
        })();
        await client.disconnect();

        expect(dropped).toEqual([news]);
        await expect
          .poll(() => {
            return serverRouter.notifications.subscriptions();
          })
          .toEqual([]);
      } finally {
        await client[Symbol.asyncDispose]();
        serverRouter[Symbol.dispose]();
        await serverRouter.transport.stop();
        await allClosed();
      }
    });
  });
}

test('a server’s failures are its own, whatever table a client uses', () => {
  expect(new FailureError(SERVER_FAILURES.accessDenied).side).toBe('server');
  expect(FailureScope.PROTOCOL).toBe(0);
});

test.describe('createRouterServer, relaying', () => {
  const device: Handle = 'type=WS;ip=127.0.0.1;port=50100';
  const failing: IProcedure = { ...echo, procedureId: 2, procedureName: 'failing' };
  const held: IProcedure = { ...echo, procedureId: 3, procedureName: 'held' };
  const admitting: IRelayOptions = {
    beforeRoute: () => {
      return true;
    },
  };

  /**
   * A device's router on a pipe, and the relay's client router to it — leg B — under `limits`,
   * which answers `echo` in upper case, fails `failing` with its code 21, and holds `held` until its
   * signal aborts; `isDeferred` hands each message a turn later.
   */
  const createDevice = ({
    clock,
    isDeferred,
    limits,
  }: {
    clock?: TestClock | undefined;
    isDeferred?: boolean | undefined;
    limits?: RouterLimitsOptions | undefined;
  } = {}) => {
    const pipe = createPipedTransports({ connectionHandle: device, isDeferred });
    const toDevice = createRouterClient(pipe.client, { clock, limits });
    const deviceRouter = createRouterServer(pipe.server, { clock, limits });
    const services = createServiceManager(deviceRouter);
    const aborted: unknown[] = [];

    services.getRequestResolver(echo, { serializer: answering })((request, response) => {
      return response(request.payload.toUpperCase());
    });
    services.getRequestResolver(failing, { serializer: answering })((_request, response) => {
      return response(null, { code: 21, detail: 'nothing to echo' });
    });
    services.getRequestResolver(held, { serializer: answering })((request) => {
      return new Promise((resolve) => {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted.push(request.signal.reason);
            resolve(undefined);
          },
          { once: true }
        );
      });
    });
    pipe.open();

    return {
      aborted,
      deviceRouter,
      pipe,
      toDevice,
      [Symbol.dispose]: () => {
        toDevice[Symbol.dispose]();
        deviceRouter[Symbol.dispose]();
      },
    };
  };

  /**
   * A relay on the scripted transport — leg A, `first` open — relaying as `relay` says, every request
   * by default, with the device behind it at destination 7; what the relay reports is recorded.
   */
  const createRelayed = ({
    clock,
    deviceLimits,
    isDeferred,
    relay = admitting,
  }: {
    clock?: TestClock;
    deviceLimits?: RouterLimitsOptions;
    isDeferred?: boolean;
    relay?: IRelayOptions;
  } = {}) => {
    const legA = createScriptedTransport();
    const router = createRouterServer(legA.transport, { clock, relay });
    const { [Symbol.dispose]: disposeDevice, ...behind } = createDevice({
      clock,
      isDeferred,
      limits: deviceLimits,
    });

    legA.open(first);
    router.registerDestination(behind.toDevice, { destinationId: 7, label: 'the device' });

    return {
      ...legA,
      ...behind,
      errors: recordErrors(router),
      router,
      [Symbol.dispose]: () => {
        router[Symbol.dispose]();
        disposeDevice();
      },
    };
  };

  test('relays a request to the destination it names, admitted once, and brings the answer back under its call id — a failure of the target’s one relay more', async () => {
    let admissions = 0;
    using relayed = createRelayed({
      relay: {
        beforeRoute: () => {
          admissions += 1;

          return true;
        },
      },
    });
    const { deliver, errors, router, sent } = relayed;

    deliver(first, requestOf(1, { destinationId: 7, payload: text.encode('hi') }));
    deliver(first, requestOf(3, { destinationId: 7, procedure: failing }));
    deliver(first, requestOf(5, { destinationId: 7, procedure: { ...echo, procedureId: 9 } }));
    await sleep(0);

    expect(answersOf(sent)).toEqual([
      [first, 'result', 1, 'HI'],
      [first, 'failure', 3, 21],
      [first, 'failure', 5, ProtocolCode.PROCEDURE_UNKNOWN],
    ]);
    expect(
      sent.map(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE ? envelope.failure : envelope?.header;
      })
    ).toEqual([
      // an answer names its call alone
      { callId: 1, kind: EnvelopeKind.RESULT },
      { code: 21, detail: 'nothing to echo', relays: 1, scope: FailureScope.APPLICATION },
      {
        code: ProtocolCode.PROCEDURE_UNKNOWN,
        detail: 'no procedure 9 in service 2',
        relays: 1,
        scope: FailureScope.PROTOCOL,
      },
    ]);
    expect(admissions).toBe(3);
    // the target's own failures are answered, not reported
    expect(errors).toEqual([]);
    expect(router.destinations()).toEqual([{ destinationId: 7, label: 'the device' }]);
  });

  test('refuses before leg B — the routing not admitted, the destination unknown, a subscription, a payload past the target’s limit — and sends the target nothing', async () => {
    using relayed = createRelayed({
      deviceLimits: { maximumPayloadBytes: 4 },
      relay: {
        beforeRoute: ({ header }) => {
          return header.callId !== 1;
        },
      },
    });
    const { deliver, pipe, sent } = relayed;

    deliver(first, requestOf(1, { destinationId: 7 }));
    deliver(first, requestOf(3, { destinationId: 8 }));
    deliver(first, requestOf(5, { destinationId: 7, opensSubscription: true }));
    deliver(first, requestOf(7, { destinationId: 7, payload: text.encode('too long') }));
    await sleep(0);

    expect(answersOf(sent)).toEqual([
      [first, 'failure', 1, ProtocolCode.ACCESS_DENIED],
      [first, 'failure', 3, ProtocolCode.DESTINATION_UNKNOWN],
      [first, 'failure', 5, ProtocolCode.SUBSCRIPTION_UNSUPPORTED],
      [first, 'failure', 7, ProtocolCode.PAYLOAD_TOO_LARGE],
    ]);
    expect(pipe.sent.client).toEqual([]);
  });

  test('cancels leg B when leg A cancels its call, when its connection goes, and when the relay is disposed, freeing the call id each time', async () => {
    using relayed = createRelayed();
    const { aborted, close, deliver, open, router, sent } = relayed;

    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);
    deliver(first, cancelOf(1));
    await sleep(0);

    expect(aborted).toHaveLength(1);

    // the same call id, free again, relayed anew
    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);
    close(first);
    await sleep(0);

    expect(aborted).toHaveLength(2);

    open(first);
    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);
    router[Symbol.dispose]();
    await sleep(0);

    expect(aborted).toEqual([
      expect.any(CancelError),
      expect.any(CancelError),
      expect.any(CancelError),
    ]);
    // leg A heard nothing: each answer went nowhere
    expect(sent).toEqual([]);
  });

  test('cancels leg B when leg A cancels its call as leg B’s request is handed over', async () => {
    using relayed = createRelayed();
    const { aborted, deliver, deviceRouter, sent } = relayed;
    const taken: number[] = [];

    // leg A's cancel comes as the device takes the request, within the relay's send on leg B
    deviceRouter.on('debug', ({ direction, header }) => {
      if (direction === 'rx') {
        taken.push(header.kind);

        if (taken.length === 1) {
          deliver(first, cancelOf(1));
        }
      }
    });
    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);

    expect(taken).toEqual([EnvelopeKind.REQUEST, EnvelopeKind.CANCEL]);
    expect(aborted).toEqual([expect.any(CancelError)]);
    expect(sent).toEqual([]);
  });

  test('relays over a pipe that hands each message a turn later, and cancels over it', async () => {
    using relayed = createRelayed({ isDeferred: true });
    const { aborted, deliver, sent } = relayed;

    deliver(first, requestOf(1, { destinationId: 7, payload: text.encode('hi') }));
    deliver(first, requestOf(3, { destinationId: 7, procedure: held }));
    await expect
      .poll(() => {
        return answersOf(sent);
      })
      .toEqual([[first, 'result', 1, 'HI']]);
    deliver(first, cancelOf(3));
    await expect
      .poll(() => {
        return aborted;
      })
      .toEqual([expect.any(CancelError)]);
    expect(answersOf(sent)).toEqual([[first, 'result', 1, 'HI']]);
  });

  test('answers unreachable when the target never had the request, and lost when it went after it had it, reporting why', async () => {
    using relayed = createRelayed();
    const { deliver, errors, pipe, sent } = relayed;

    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);
    pipe.close();
    await sleep(0);
    deliver(first, requestOf(3, { destinationId: 7 }));
    await sleep(0);

    expect(answersOf(sent)).toEqual([
      [first, 'failure', 1, ProtocolCode.DESTINATION_LOST],
      [first, 'failure', 3, ProtocolCode.DESTINATION_UNREACHABLE],
    ]);
    // the relay's own, with no address behind it: why is reported, with leg A's connection
    expect(
      sent.map(({ envelope }) => {
        return envelope?.kind === EnvelopeKind.FAILURE
          ? [envelope.failure.relays, envelope.failure.detail]
          : undefined;
      })
    ).toEqual([
      [0, 'destination 7 was lost once handed the request: the procedure may have run'],
      [0, 'destination 7 is unreachable: nothing was tried'],
    ]);
    expect(reportedOf(errors)).toEqual([
      ['the connection closed before the answer', first],
      [`${device} is not open`, first],
    ]);
  });

  test('ends leg B past the relay’s timeout, cancelling it at the target, and answers lost; no timer without one', async () => {
    const clock = createTestClock();
    using relayed = createRelayed({ clock, relay: { ...admitting, timeout: 250 } });
    const { aborted, deliver, errors, sent } = relayed;
    const delaysArmed = () => {
      return clock.armed.map(({ delay }) => {
        return delay;
      });
    };

    deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
    await sleep(0);

    expect(delaysArmed()).toEqual([250]);

    await clock.tickAsync(250);
    await sleep(0);

    // its call id on leg B stays reserved as long as its timeout, against a late answer
    expect(delaysArmed()).toEqual([250, 250]);

    expect(aborted).toEqual([expect.any(CancelError)]);
    expect(answersOf(sent)).toEqual([[first, 'failure', 1, ProtocolCode.DESTINATION_LOST]]);
    expect(sent[0]?.envelope).toMatchObject({ failure: { relays: 0 } });
    expect(reportedOf(errors)).toEqual([[expect.stringContaining('250'), first]]);

    const unboundedClock = createTestClock();
    using unbounded = createRelayed({ clock: unboundedClock });
    const { armed: none } = await timersUntil(unboundedClock, async () => {
      unbounded.deliver(first, requestOf(1, { destinationId: 7, procedure: held }));
      await sleep(0);
    });

    expect(none).toEqual([]);
  });

  test('holds a transfer to the target’s limit at its opening, and relays one to the destination it opened on', async () => {
    const limits = { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024, windowBytes: 4_096 };
    const legA = createPipedTransports({ connectionHandle: first });
    let admissions = 0;
    using router = createRouterServer(legA.server, {
      limits,
      relay: {
        beforeRoute: () => {
          admissions += 1;

          return true;
        },
      },
    });
    using requester = createRouterClient(legA.client, { limits });
    using behind = createDevice({ limits: { ...limits, maximumPayloadBytes: 4_096 } });
    const registration = router.registerDestination(behind.toDevice, { destinationId: 7 });
    // registered in its place as the transfer comes, and never asked
    const later: RelayTarget = {
      limits: behind.toDevice.limits,
      request: () => {
        return Promise.reject(new Error('asked a call it did not open'));
      },
    };
    const credits: number[] = [];

    router.on('debug', ({ direction, header }) => {
      if (direction === 'tx' && header.kind === EnvelopeKind.CREDIT) {
        credits.push(header.callId);
      }

      if (direction === 'rx' && header.kind === EnvelopeKind.CHUNK && registration.unregister()) {
        router.registerDestination(later, { destinationId: 7 });
      }
    });
    legA.open();

    const ask = (length: number) => {
      return requester
        .request(text.encode('x'.repeat(length)), {
          options: { destinationId: 7, timeout: 5_000 },
          procedure: echo,
        })
        .then(
          ({ payload }) => {
            return text.decode(payload);
          },
          (reason: unknown) => {
            return reason;
          }
        );
    };

    // past the device's 4 KiB: refused at its opening, before any credit
    expect(await ask(5_000)).toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE, relays: 0 });
    expect(credits).toEqual([]);
    expect(behind.pipe.sent.client).toEqual([]);
    // within it: credited, and relayed to the device it opened on
    expect(await ask(3_000)).toBe('X'.repeat(3_000));
    expect(credits.length).toBeGreaterThan(0);
    expect(admissions).toBe(2);
  });

  test('asks a connection of its own by a command, cancels it with leg A, answers lost when it goes, and unreachable after, whoever takes its handle', async () => {
    const legA = createScriptedTransport();
    using relay = createRouterServer(legA.transport, { relay: admitting });
    const { close, deliver, open, sent } = legA;
    const errors = recordErrors(relay);

    open(first);
    open(second);

    const registration = relay.registerDestination(
      { connectionHandle: second },
      { destinationId: 9 }
    );

    deliver(first, requestOf(1, { destinationId: 9, payload: text.encode('hi') }));
    await sleep(0);
    deliver(second, resultOf(2, text.encode('HI')));
    await sleep(0);
    // leg A's cancel goes on to the connection
    deliver(first, requestOf(3, { destinationId: 9 }));
    await sleep(0);
    deliver(first, cancelOf(3));
    await sleep(0);
    deliver(first, requestOf(5, { destinationId: 9 }));
    await sleep(0);
    close(second);
    await sleep(0);
    // a newcomer under the same handle is not the destination
    open(second);
    deliver(first, requestOf(7, { destinationId: 9 }));
    await sleep(0);

    expect(answersOf(sent)).toEqual([
      [second, EnvelopeKind.REQUEST, 2, 'hi'],
      [first, 'result', 1, 'HI'],
      [second, EnvelopeKind.REQUEST, 4, ''],
      [second, EnvelopeKind.CANCEL, 4, undefined],
      [second, EnvelopeKind.REQUEST, 6, ''],
      [first, 'failure', 5, ProtocolCode.DESTINATION_LOST],
      [first, 'failure', 7, ProtocolCode.DESTINATION_UNREACHABLE],
    ]);
    // the command names no destination: the connection is what is behind the relay
    expect(sent[0]?.envelope?.header).toEqual({
      callId: 2,
      kind: EnvelopeKind.REQUEST,
      procedureId: 1,
      serviceId: 2,
    });
    expect(relay.destinations()).toEqual([{ destinationId: 9, label: undefined }]);

    // registered anew, the newcomer is asked; the relay disposed, neither leg hears more
    expect(registration.unregister()).toBe(true);
    relay.registerDestination({ connectionHandle: second }, { destinationId: 9 });
    deliver(first, requestOf(9, { destinationId: 9, payload: text.encode('again') }));
    await sleep(0);
    relay[Symbol.dispose]();
    await sleep(0);

    expect(answersOf(sent.slice(7))).toEqual([[second, EnvelopeKind.REQUEST, 8, 'again']]);
    expect(reportedOf(errors)).toEqual([['the connection closed before the answer', first]]);
  });
});

test.describe('createRouterServer, its gauges', () => {
  test('counts what it and its parts hold, for the connections it follows, which it forgets as each closes', () => {
    const scripted = createScriptedTransport();
    using router = createRouterServer(scripted.transport, {
      relay: {
        beforeRoute: () => {
          return true;
        },
      },
    });
    const { close, deliver, open } = scripted;

    // a request its resolver never answers
    router.registerResolver(
      Object.assign(() => {
        return new Promise<void>(() => {});
      }, echo)
    );
    open(first);
    open(second);

    // followed, and kept by nothing else
    expect(router.gauges().connectionHandles).toEqual(new Set([first, second]));

    deliver(first, requestOf(1));
    router.registerDestination({ connectionHandle: second }, { destinationId: 5 });
    close(second);

    expect(router.gauges()).toMatchObject({
      anomalies: [],
      connectionHandles: new Set([first]),
      counts: {
        answeringCalls: 1,
        closedDestinations: 1,
        connections: 1,
        destinations: 1,
        notifiedSubscriptions: 0,
        pendingCalls: 0,
        subscriptionsInFlight: 0,
        subscriptionsWaiting: 0,
      },
    });

    close(first);

    // the destination stays, on purpose, for no connection
    expect(router.gauges()).toMatchObject({
      connectionHandles: new Set(),
      counts: { answeringCalls: 0, closedDestinations: 1, connections: 0, destinations: 1 },
    });
  });
});

test.describe('createRouterServer, its paced subscriptions', () => {
  /** A server whose `news` resolver answers at once, but for `hold`, which it holds until released. */
  const createPaced = (routerOptions?: Parameters<typeof createRouterServer>[1]) => {
    const scripted = createScriptedTransport();
    const router = createRouterServer(scripted.transport, routerOptions);
    const services = createServiceManager(router);
    const errors = recordErrors(router);
    const { promise: released, resolve: release } = Promise.withResolvers<void>();

    scripted.open(first);
    scripted.open(second);

    const resolver = services.getNotificationResolver(news, { serializer: answering })(async (
      request,
      response
    ) => {
      response.registerNotification();

      if (request.payload === 'hold') {
        await released;
      }

      return response('ok');
    });

    /** What the connections were sent since the last call, as `answersOf` reads it. */
    const sentSince = () => {
      return answersOf(scripted.sent.splice(0));
    };

    return { ...scripted, errors, release, resolver, router, sentSince };
  };

  /** The queued counts of `router`'s gauges. */
  const queuedOf = (router: ReturnType<typeof createRouterServer>) => {
    const { pausedSubscriptions, queuedNotifications } = router.gauges().counts;

    return { pausedSubscriptions, queuedNotifications };
  };

  test('sends one notification per credit, and queues the others, the latest of a key in its place', async () => {
    const { deliver, resolver, router, sentSince } = createPaced();

    using _router = router;

    deliver(first, pacedOf(3));
    await sleep(0);

    expect(sentSince()).toEqual([[first, 'result', 3, 'ok']]);

    await resolver.notify('7 a', { key: 7 });
    // each resolves once queued, the transport having nothing of it
    await resolver.notify('7 b', { key: 7 });
    await resolver.notify('9 a', { key: 9 });
    await resolver.notify('event');
    await resolver.notify('7 c', { key: 7 });

    expect(sentSince()).toEqual([[first, EnvelopeKind.NOTIFICATION, 3, '7 a']]);
    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 1, queuedNotifications: 3 });

    deliver(first, pacedCreditOf(3, 3));
    await sleep(0);

    expect(sentSince()).toEqual([
      [first, EnvelopeKind.NOTIFICATION, 3, '7 c'],
      [first, EnvelopeKind.NOTIFICATION, 3, '9 a'],
    ]);

    // a credit that came late, and a transfer's on the same call id, let nothing go
    deliver(first, pacedCreditOf(3, 2));
    deliver(first, {
      header: { callId: 3, creditEnd: 100, kind: EnvelopeKind.CREDIT },
      kind: EnvelopeKind.CREDIT,
    });
    await sleep(0);

    expect(sentSince()).toEqual([]);

    deliver(first, pacedCreditOf(3, 5));
    await sleep(0);
    await resolver.notify('after');
    await resolver.notify('past');

    expect(sentSince()).toEqual([
      [first, EnvelopeKind.NOTIFICATION, 3, 'event'],
      [first, EnvelopeKind.NOTIFICATION, 3, 'after'],
    ]);
    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 1, queuedNotifications: 1 });
  });

  test('paces no subscription that did not ask, beside one that did', async () => {
    const { activity, deliver, resolver, router, sentSince } = (() => {
      const paced = createPaced();

      return { ...paced, activity: recordActivity(paced.router) };
    })();

    using _router = router;

    deliver(first, pacedOf(3));
    deliver(second, subscribingOf(3));
    await sleep(0);
    sentSince();

    for (const word of ['a', 'b', 'c']) {
      await resolver.notify(word);
    }

    expect(sentSince()).toEqual([
      [first, EnvelopeKind.NOTIFICATION, 3, 'a'],
      [second, EnvelopeKind.NOTIFICATION, 3, 'a'],
      [second, EnvelopeKind.NOTIFICATION, 3, 'b'],
      [second, EnvelopeKind.NOTIFICATION, 3, 'c'],
    ]);

    activity.length = 0;
    deliver(first, pacedCreditOf(3, 2));
    await sleep(0);

    // a notification the credit let go is one sent, as any
    expect(activity).toEqual(['notification first']);
  });

  test('drops in silence a credit for no subscription paced, which may have crossed its end', async () => {
    const { deliver, errors, router, sentSince } = createPaced();

    using _router = router;

    deliver(second, subscribingOf(3));
    await sleep(0);
    sentSince();
    deliver(first, pacedCreditOf(9, 4));
    deliver(second, pacedCreditOf(3, 4));
    await sleep(0);

    expect(sentSince()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('ends an established subscription whose queue goes past its bounds, and sends it nothing after', async () => {
    const { deliver, errors, resolver, router, sent, sentSince } = createPaced({
      pacing: { maximumQueuedNotifications: 2 },
    });

    using _router = router;

    deliver(first, pacedOf(3));
    deliver(second, pacedOf(5));
    await sleep(0);
    sentSince();

    for (const word of ['a', 'b', 'c', 'd']) {
      await resolver.notify(word, {
        filter: (connectionHandle) => {
          return connectionHandle === first;
        },
      });
    }

    expect(sent.at(-1)?.envelope).toMatchObject({
      failure: { detail: 'the notifications queued for call 3 went past their bounds' },
    });
    expect(sentSince()).toEqual([
      [first, EnvelopeKind.NOTIFICATION, 3, 'a'],
      [first, 'failure', 3, ProtocolCode.CAPACITY_EXCEEDED],
    ]);
    expect(router.notifications.subscriptions()).toEqual([
      { callId: 5, connectionHandle: second, procedureId: 5, serviceId: 2 },
    ]);
    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 0, queuedNotifications: 0 });

    await resolver.notify('e');
    deliver(first, pacedCreditOf(3, 10));
    await sleep(0);

    expect(sentSince()).toEqual([[second, EnvelopeKind.NOTIFICATION, 5, 'e']]);
    expect(errors).toEqual([]);
  });

  test('answers with the failure a call in flight whose queue goes past its bounds, and hands its place over', async () => {
    const { deliver, errors, release, resolver, router, sentSince } = createPaced({
      pacing: { maximumQueuedNotifications: 1 },
    });

    using _router = router;

    // the holder, in flight; then one answered meanwhile, which waits for its place
    deliver(first, pacedOf(3, text.encode('hold')));
    deliver(first, pacedOf(5));
    await sleep(0);

    expect(sentSince()).toEqual([[first, 'result', 5, 'ok']]);

    for (const word of ['a', 'b', 'c']) {
      await resolver.notify(word);
    }

    expect(sentSince()).toEqual([
      [first, EnvelopeKind.NOTIFICATION, 3, 'a'],
      [first, 'failure', 3, ProtocolCode.CAPACITY_EXCEEDED],
    ]);

    // the one that waited took the place, paced as it asked
    await resolver.notify('d');
    await resolver.notify('e');
    release();
    await sleep(0);

    // the holder's own answer goes nowhere: its call was answered
    expect(sentSince()).toEqual([[first, EnvelopeKind.NOTIFICATION, 5, 'd']]);
    expect(router.notifications.subscriptions()).toEqual([
      { callId: 5, connectionHandle: first, procedureId: 5, serviceId: 2 },
    ]);
    expect(errors).toEqual([]);
  });

  test('reports the failure it could not send a call in flight whose queue went past its bounds', async () => {
    const { control, deliver, errors, release, resolver, router, sentSince } = createPaced({
      pacing: { maximumQueuedNotifications: 1 },
    });

    using _router = router;

    deliver(first, pacedOf(3, text.encode('hold')));
    await sleep(0);
    await resolver.notify('a');
    await resolver.notify('b');
    control.sendErrors.set(first, new Error('gone'));
    await resolver.notify('c');
    release();
    await sleep(0);

    expect(sentSince().at(-1)).toEqual([first, 'failure', 3, ProtocolCode.CAPACITY_EXCEEDED]);
    expect(reportedOf(errors)).toContainEqual(['gone', first]);
    expect(router.notifications.subscriptions()).toEqual([]);
  });

  test('lets a queue go with its subscription: unsubscribed, cancelled, its session ended, its connection closed', async () => {
    const { close, deliver, resolver, router } = createPaced();
    const third = 'type=WS;ip=127.0.0.1;port=50003';

    using _router = router;

    deliver(first, pacedOf(3));
    deliver(first, pacedOf(5, text.encode('other')));
    deliver(second, pacedOf(3));
    deliver(third, pacedOf(3));
    await sleep(0);

    // the first connection holds its place under 3, so 5, answered after it, subscribes nothing
    for (const word of ['a', 'b', 'c']) {
      await resolver.notify(word);
    }

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 3, queuedNotifications: 6 });

    router.unsubscribe({ callId: 3, connectionHandle: first });

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 2, queuedNotifications: 4 });

    deliver(second, cancelOf(3));

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 1, queuedNotifications: 2 });

    await router.dropSubscriptions({
      connectionHandle: third,
      failure: SERVER_FAILURES.sessionRequired,
    });

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 0, queuedNotifications: 0 });

    deliver(third, pacedOf(7));
    await sleep(0);
    await resolver.notify('d');
    await resolver.notify('e');

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 1, queuedNotifications: 1 });

    close(third);

    expect(queuedOf(router)).toEqual({ pausedSubscriptions: 0, queuedNotifications: 0 });
  });

  test('tells in its gauges what its fullest queue holds, at the bounds its options give', async () => {
    const { deliver, resolver, router } = createPaced({
      pacing: { maximumQueuedNotificationBytes: 10, maximumQueuedNotifications: 4 },
    });

    using _router = router;
    using defaults = createRouterServer(createScriptedTransport().transport);

    deliver(first, pacedOf(3));
    await sleep(0);

    for (const word of ['a', 'bb', 'ccc']) {
      await resolver.notify(word);
    }

    expect(router.gauges()).toMatchObject({
      ceilings: { largestQueuedNotificationBytes: 10, largestQueuedNotifications: 4 },
      counts: {
        largestQueuedNotificationBytes: 5,
        largestQueuedNotifications: 2,
        queuedNotificationBytes: 5,
      },
    });
    expect(defaults.gauges().ceilings).toMatchObject({
      largestQueuedNotificationBytes: 1_048_576,
      largestQueuedNotifications: 64,
    });
  });
});
