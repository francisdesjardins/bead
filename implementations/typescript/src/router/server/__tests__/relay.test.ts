import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createHTTPTransportClient } from '../../../transport/client/http-transport-client';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { CancelError, ProgrammerError, TimeoutError } from '../../../transport/shared/errors';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  LIMIT_DEFAULTS,
  ProtocolCode,
  SERVER_FAILURES,
} from '../../shared/constants';
import { DisconnectError, FailureError } from '../../shared/errors';
import type {
  Credential,
  IFailure,
  IProcedure,
  IRequestHeader,
  IRequestResolverProps,
  IResolvedRequestOptions,
  IRouterLimits,
  IRouterResult,
  RouterAnswer,
} from '../../shared/types';
import { createRouterClient } from '../../client/router-client';
import { readEnvelope, writeEnvelope } from '../../shared/envelope';
import { createPipedTransports } from '../../shared/__tests__/fixtures';
import { createRelay } from '../relay';
import { createRouterServer, shareLegBSession } from '../router-server';
import type { IRelayOptions, RelayTarget } from '../types';

// helpers

type Handle = TransportServerConnectionHandle;

const first: Handle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';
const device: Handle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=1';

/** What a leg B request was asked with. */
interface IAsked {
  options: IResolvedRequestOptions;
  payload: Uint8Array;
  procedure: IProcedure;
}

/** How a leg B request settles: told whether its request was handed over, then its result or its reason. */
type Settle = (onSent: (isHanded: boolean) => void) => Promise<IRouterResult>;

/** How far a leg B request went before it failed: never handed over, handed, or handed then refused. */
type Reach = 'handed' | 'never' | 'refused';

const resultOf = (payload: Uint8Array): IRouterResult => {
  return { header: { callId: 2, kind: EnvelopeKind.RESULT }, payload };
};

/** Handed over, then answered with `payload`. */
const answering = (payload: Uint8Array): Settle => {
  return (onSent) => {
    onSent(true);

    return Promise.resolve(resultOf(payload));
  };
};

/** As far as `reach` says, then refused with `reason`. */
const refusing = (reason: unknown, reach: Reach): Settle => {
  return (onSent) => {
    if (reach !== 'never') {
      onSent(true);
    }

    if (reach === 'refused') {
      onSent(false);
    }

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a reason may be anything: a string, here
    return Promise.reject(reason);
  };
};

/** A request's header to `destinationId`, for procedure 1 of service 2, the very one dispatched. */
const headerOf = (
  callId: number,
  {
    destinationId = 7,
    opensSubscription,
  }: { destinationId?: number; opensSubscription?: true } = {}
): IRequestHeader => {
  return {
    callId,
    destinationId,
    kind: EnvelopeKind.REQUEST,
    procedureId: 1,
    serviceId: 2,
    ...(opensSubscription === undefined ? {} : { opensSubscription }),
  };
};

/** The props a router hands a handler: admitted, unless told, with a signal of their own. */
const propsOf = (
  header: IRequestHeader,
  {
    isAdmitted = true,
    payload = Uint8Array.of(1, 2, 3),
    signal = new AbortController().signal,
  }: { isAdmitted?: boolean; payload?: Uint8Array; signal?: AbortSignal } = {}
): IRequestResolverProps<Handle> => {
  return {
    connectionHandle: first,
    header,
    ...(isAdmitted ? { isAdmitted: true } : {}),
    payload,
    signal,
  };
};

/** A client router's part a destination names, which records what it is asked and settles as told. */
const createTarget = (limits: Partial<IRouterLimits> = {}) => {
  const asked: IAsked[] = [];
  const control = { settle: answering(Uint8Array.of(9)) };
  const target: RelayTarget = {
    limits: { ...LIMIT_DEFAULTS, ...limits },
    request: (payload, { onSent, options, procedure }) => {
      asked.push({ options, payload, procedure });

      return control.settle(
        onSent ??
          (() => {
            return undefined;
          })
      );
    },
  };

  return { asked, control, target };
};

/**
 * A relay under `options` — admitting every request unless they say otherwise — which records each
 * answer it writes, with the header it answers, each request of its own router's it makes, and
 * each error it reports, as its message and whether leg A's connection came with it.
 */
const createTestRelay = (
  options: IRelayOptions = {
    beforeRoute: () => {
      return true;
    },
  }
) => {
  const answers: [answer: RouterAnswer, header: IRequestHeader][] = [];
  const own: IAsked[] = [];
  const reports: [message: string, isLegA: boolean][] = [];
  const control = {
    /** What each answer throws, in turn, when there is one. */
    respondErrors: [] as Error[],
    settle: answering(Uint8Array.of(8)),
  };
  const relay = createRelay({
    failures: SERVER_FAILURES,
    limits: LIMIT_DEFAULTS,
    options,
    report: (error, connectionHandle) => {
      reports.push([error.message, connectionHandle === first]);
    },
    request: (payload, { onSent, options: requestOptions, procedure }) => {
      own.push({ options: requestOptions, payload, procedure });

      return control.settle(
        onSent ??
          (() => {
            return undefined;
          })
      );
    },
    respond: (answer, { header }) => {
      answers.push([answer, header]);

      const error = control.respondErrors.shift();

      return error === undefined ? Promise.resolve() : Promise.reject(error);
    },
  });

  return { answers, control, own, relay, reports };
};

/** The failures of the answers written, as their codes, relays crossed and details. */
const failuresOf = (answers: [RouterAnswer, IRequestHeader][]) => {
  return answers.map(([answer]) => {
    const { code, detail, relays } = answer.failure ?? ({} as Partial<IFailure>);

    return answer.failure === undefined ? [...answer.payload] : [code, relays, detail];
  });
};

// definition

/** A token whose claims set names `aud`, as a relay reads it without verifying it. */
const tokenNaming = (aud: unknown): string => {
  const part = (value: object): string => {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  };

  return `${part({ alg: 'HS256', typ: 'at+jwt' })}.${part({ aud, sub: 'carol' })}.AAAA`;
};

/** A request's header to `destinationId`, presenting `credential`. */
const presentingOf = (
  callId: number,
  { credential, destinationId = 7 }: { credential: Credential | undefined; destinationId?: number }
): IRequestHeader => {
  return {
    ...headerOf(callId, { destinationId }),
    ...(credential === undefined ? {} : { credential }),
  };
};

/**
 * A relay that admits all, whose connections of its own carry a credential securely unless
 * `carriage` says otherwise, recording each leg B request of its own router and each answer.
 */
const createCarryingRelay = (
  carriage: ReadonlyMap<Handle, { carriesCredential: boolean; isSecure: boolean }> = new Map(),
  limits: IRouterLimits = LIMIT_DEFAULTS
) => {
  const answers: RouterAnswer[] = [];
  const own: IAsked[] = [];
  const relay = createRelay({
    carriageOf: (connectionHandle) => {
      return carriage.get(connectionHandle) ?? { carriesCredential: true, isSecure: true };
    },
    failures: SERVER_FAILURES,
    limits,
    options: {
      beforeRoute: () => {
        return true;
      },
    },
    report: () => {},
    request: (payload, { onSent, options: requestOptions, procedure }) => {
      own.push({ options: requestOptions, payload, procedure });

      return answering(Uint8Array.of(8))(
        onSent ??
          (() => {
            return undefined;
          })
      );
    },
    respond: (answer) => {
      answers.push(answer);

      return Promise.resolve();
    },
  });

  return { answers, own, relay };
};

test.describe('createRelay, credentials', () => {
  const ELSEWHERE = { scheme: CredentialScheme.ELSEWHERE } as const;
  const CARRIED = 'Bearer mF_9.B5f-4.1JqM';
  const jwtNaming = (aud: unknown) => {
    return { scheme: CredentialScheme.JWT, token: tokenNaming(aud) } as const;
  };

  test('answers a call leg B cannot carry DESTINATION_UNREACHABLE, nothing tried: a JWT whose aud names not its destination’s audience, or to one of none; an ELSEWHERE to one of none, or over a leg B that carries none; either in the clear', () => {
    const plain: Handle = 'type=WS;ip=192.0.2.1;port=50003;ordinal=1';
    const { relay } = createCarryingRelay(
      new Map([
        [device, { carriesCredential: false, isSecure: true }],
        [plain, { carriesCredential: true, isSecure: false }],
      ])
    );

    relay.register({ connectionHandle: first }, { audience: 'bead-interop', destinationId: 3 });
    relay.register({ connectionHandle: first }, { destinationId: 5 });
    relay.register({ connectionHandle: device }, { audience: 'bead-interop', destinationId: 7 });
    relay.register({ connectionHandle: plain }, { audience: 'bead-interop', destinationId: 9 });

    const codeOf = (credential: Credential | undefined, destinationId: number) => {
      return relay.handlerOf(destinationId)?.admit?.({
        connectionHandle: first,
        header: presentingOf(1, { credential, destinationId }),
      })?.code;
    };
    const unreachable = ProtocolCode.DESTINATION_UNREACHABLE;

    expect(
      [
        undefined,
        { scheme: CredentialScheme.OPAQUE, token: 'AQEBAQEBAQEBAQEBAQEBAQ' },
        jwtNaming('bead-interop'),
        jwtNaming(['bead-other', 'bead-interop']),
        jwtNaming('bead-other'),
        { scheme: CredentialScheme.JWT, token: 'a.b.c' },
        ELSEWHERE,
      ].map((credential) => {
        return [3, 5, 7, 9].map((destinationId) => {
          return codeOf(credential as Credential | undefined, destinationId);
        });
      })
    ).toEqual([
      [undefined, undefined, undefined, undefined],
      [undefined, undefined, undefined, undefined],
      [undefined, unreachable, undefined, unreachable],
      [undefined, unreachable, undefined, unreachable],
      [unreachable, unreachable, unreachable, unreachable],
      [unreachable, unreachable, unreachable, unreachable],
      [undefined, unreachable, unreachable, unreachable],
    ]);
  });

  test('presents on leg B what leg A does: a JWT’s same bytes, an ELSEWHERE with what leg A’s transport carried, none for none or OPAQUE', async () => {
    const { answers, own, relay } = createCarryingRelay();
    const jwt = jwtNaming('bead-interop');

    relay.register({ connectionHandle: device }, { audience: 'bead-interop', destinationId: 7 });

    for (const [callId, credential] of [
      [1, undefined],
      [3, { scheme: CredentialScheme.OPAQUE, token: 'AQEBAQEBAQEBAQEBAQEBAQ' }],
      [5, jwt],
      [7, ELSEWHERE],
    ] as const) {
      await relay.handlerOf(7)?.({
        ...propsOf(presentingOf(callId, { credential: credential as Credential | undefined })),
        transportCredential: CARRIED,
      });
    }

    expect(
      own.map(({ options: asked }) => {
        return asked.credential;
      })
    ).toEqual([
      { scheme: CredentialScheme.NONE },
      { scheme: CredentialScheme.NONE },
      { scheme: CredentialScheme.JWT, token: jwt.token },
      { carried: CARRIED, scheme: CredentialScheme.ELSEWHERE },
    ]);
    expect(answers).toHaveLength(4);
  });

  test('holds a payload to what one envelope holds behind leg B’s header with its credential, call by call, for a target that takes no transfer', async () => {
    const limits = { ...LIMIT_DEFAULTS, chunkBytes: 1_024, maximumTransfers: 0 };
    const { answers, own, relay } = createCarryingRelay(new Map(), limits);
    const jwt = jwtNaming('bead-interop');
    // its header: 12 bytes, then the block's head and its token padded to a word
    const behindJwt = 1_024 - 12 - 4 - Math.ceil(jwt.token.length / 4) * 4;

    relay.register({ connectionHandle: device }, { audience: 'bead-interop', destinationId: 7 });

    const handler = relay.handlerOf(7);

    expect(handler?.maximumPayloadBytes).toBe(1_012);

    for (const [callId, credential, length] of [
      [1, jwt, behindJwt],
      [3, jwt, behindJwt + 1],
      [5, undefined, behindJwt + 1],
    ] as const) {
      await handler?.(
        propsOf(presentingOf(callId, { credential }), { payload: new Uint8Array(length) })
      );
    }

    // a transfer's total, held as it is admitted, before any credit
    expect(
      handler?.admit?.({
        connectionHandle: first,
        header: { ...presentingOf(7, { credential: jwt }), total: behindJwt + 1 },
      })?.code
    ).toBe(ProtocolCode.PAYLOAD_TOO_LARGE);
    const answered = answers.map((answer): [RouterAnswer, IRequestHeader] => {
      return [answer, headerOf(1)];
    });

    expect(failuresOf(answered)).toEqual([
      [8],
      [
        ProtocolCode.PAYLOAD_TOO_LARGE,
        undefined,
        `a payload is ${String(behindJwt)} bytes at most, not ${String(behindJwt + 1)}`,
      ],
      [8],
    ]);
    expect(own).toHaveLength(2);
  });

  test('answers leg A PAYLOAD_TOO_LARGE, the relay’s own and not reported, for a JWT that came whole and leaves leg B’s opening no room', async () => {
    // leg B: a router whose envelopes hold 1,024 bytes, so 100 bytes behind a JWT of 1,000 go as a
    // transfer, whose opening's header of 1,024 bytes passes 1,020
    const pipe = createPipedTransports({ connectionHandle: device });
    using legB = createRouterClient(pipe.client, {
      limits: { chunkBytes: 1_024, maximumEnvelopeBytes: 1_024 },
    });
    const { answers, relay, reports } = createTestRelay();
    const named = tokenNaming('bead-interop');
    const jwt = { scheme: CredentialScheme.JWT, token: named.padEnd(1_000, 'A') } as const;

    pipe.open();
    relay.register(legB, { audience: 'bead-interop', destinationId: 7 });

    // whole on leg A: 1,020 bytes of header beside its destination, then its payload
    await relay.handlerOf(7)?.(
      propsOf(presentingOf(1, { credential: jwt }), { payload: new Uint8Array(100) })
    );

    expect(failuresOf(answers)).toEqual([
      [
        ProtocolCode.PAYLOAD_TOO_LARGE,
        undefined,
        "a payload of 100 bytes goes as a transfer, whose opening's header of 1024 bytes passes 1020",
      ],
    ]);
    expect(reports).toEqual([]);
    expect(pipe.sent.client).toEqual([]);
  });
});

test.describe('createRelay, over HTTP', () => {
  test('writes the Authorization of a relayed request to leg B as it came, over HTTP', async () => {
    // a listener of the test's own on the loopback, as a server of Bead's over HTTP answers: it
    // draws a connection, then answers each request with its payload, recording what each POST
    // carried in its Authorization and presented in its block
    const heard: { authorization: string | undefined; credential: unknown }[] = [];
    const bodyOf = async (request: IncomingMessage): Promise<Uint8Array> => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }

      return new Uint8Array(Buffer.concat(chunks));
    };
    const listener = createServer((request, response) => {
      void bodyOf(request).then((body) => {
        const token = request.headers['bead-connection-token'];

        if (request.method === 'POST' && token === undefined) {
          response.writeHead(201, { 'bead-connection-token': 'AQIDBAUGBwgJCgsMDQ4PEA' });

          return (response.end(), undefined);
        }

        const envelope =
          body.length === 0
            ? undefined
            : readEnvelope(body, {
                failures: CLIENT_FAILURES,
                maximumEnvelopeBytes: LIMIT_DEFAULTS.maximumEnvelopeBytes,
              });

        if (request.method !== 'POST' || envelope?.kind !== EnvelopeKind.REQUEST) {
          response.writeHead(204);

          return (response.end(), undefined);
        }

        heard.push({
          authorization: request.headers.authorization,
          credential: envelope.header.credential,
        });
        response.writeHead(200, { 'content-type': 'application/prs.bead' });
        response.end(
          writeEnvelope({
            header: { callId: envelope.header.callId, kind: EnvelopeKind.RESULT },
            kind: EnvelopeKind.RESULT,
            payload: envelope.payload,
          })
        );

        return undefined;
      });
    });

    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');

    const { port } = listener.address() as AddressInfo;
    // leg B: a router the relay calls through, over HTTP, to the listener
    using legB = createRouterClient(createHTTPTransportClient({ isListening: false }));
    // leg A: a client of the relay's, in process
    const pipe = createPipedTransports({ connectionHandle: first });
    using relaying = createRouterServer(pipe.server, {
      relay: { beforeRoute: shareLegBSession },
    });
    using legA = createRouterClient(pipe.client);
    const procedure = { procedureId: 1, procedureName: 'echo', serviceId: 2, serviceRevision: 1 };
    const jwt = { scheme: CredentialScheme.JWT, token: tokenNaming('bead-interop') } as const;

    try {
      await legB.transport.connect({ host: '127.0.0.1', port });
      relaying.registerDestination(legB, { audience: 'bead-interop', destinationId: 7 });
      pipe.open();

      // two spaces inside, as it came: the value whole, never rewritten
      for (const credential of [
        { carried: 'Interop  sub=ada', scheme: CredentialScheme.ELSEWHERE } as const,
        jwt,
      ]) {
        const { payload } = await legA.request(Uint8Array.of(1, 2, 3), {
          options: { credential, destinationId: 7, timeout: 5_000 },
          procedure,
        });

        expect([...payload]).toEqual([1, 2, 3]);
      }

      expect(heard).toEqual([
        { authorization: 'Interop  sub=ada', credential: { scheme: CredentialScheme.ELSEWHERE } },
        { authorization: undefined, credential: jwt },
      ]);
    } finally {
      await legB.transport.disconnect().catch(() => {});
      listener.closeAllConnections();
      listener.close();
    }
  });
});

test.describe('createRelay', () => {
  test('relays nothing while no destination is registered, and every destination once one is', () => {
    const { relay } = createTestRelay();
    const { target } = createTarget();

    expect(relay.handlerOf(7)).toBeUndefined();

    const registration = relay.register(target, { destinationId: 7 });

    // one it does not know is refused, not left to the router: it is asked who may learn so
    expect(relay.handlerOf(7)).toBeDefined();
    expect(relay.handlerOf(8)).toBeDefined();
    expect(registration.unregister()).toBe(true);
    expect(relay.handlerOf(7)).toBeUndefined();
  });

  test('asks beforeRoute first, then whether the destination is known, then refuses a subscription', () => {
    const asked: string[] = [];
    const { relay } = createTestRelay({
      beforeRoute: Object.assign(
        ({ connectionHandle, header }: { connectionHandle: Handle; header: IRequestHeader }) => {
          asked.push(
            `${connectionHandle === first ? 'first' : 'device'} ${String(header.destinationId)}`
          );

          return connectionHandle === first;
        },
        { refusal: SERVER_FAILURES.sessionRequired }
      ),
    });

    relay.register(createTarget().target, { destinationId: 7 });

    const admitOf = (destinationId: number) => {
      return relay.handlerOf(destinationId)?.admit;
    };

    // not admitted: the same refusal whether the destination exists or not
    expect(admitOf(7)?.({ connectionHandle: device, header: headerOf(1) })).toBe(
      SERVER_FAILURES.sessionRequired
    );
    expect(
      admitOf(8)?.({ connectionHandle: device, header: headerOf(1, { destinationId: 8 }) })
    ).toBe(SERVER_FAILURES.sessionRequired);
    // admitted
    expect(
      admitOf(8)?.({ connectionHandle: first, header: headerOf(3, { destinationId: 8 }) })
    ).toEqual({
      ...SERVER_FAILURES.destinationUnknown,
      detail: 'no destination 8 behind this relay',
    });
    expect(
      admitOf(7)?.({ connectionHandle: first, header: headerOf(5, { opensSubscription: true }) })
    ).toEqual({
      ...SERVER_FAILURES.subscriptionUnsupported,
      detail: 'this relay carries no subscription yet',
    });
    expect(admitOf(7)?.({ connectionHandle: first, header: headerOf(7) })).toBeUndefined();
    expect(asked).toEqual(['device 7', 'device 8', 'first 8', 'first 7', 'first 7']);
  });

  test('admits nobody without beforeRoute, throws what beforeRoute throws, and takes an admission’s refusal alone', () => {
    const { relay } = createTestRelay({});

    relay.register(createTarget().target, { destinationId: 7 });

    expect(relay.handlerOf(7)?.admit?.({ connectionHandle: first, header: headerOf(1) })).toEqual({
      ...SERVER_FAILURES.accessDenied,
      detail: 'this relay admits nobody: it has no beforeRoute',
    });

    const thrown = new Error('no routing today');
    const throwing = createTestRelay({
      beforeRoute: () => {
        throw thrown;
      },
    });

    throwing.relay.register(createTarget().target, { destinationId: 7 });

    expect(() => {
      return throwing.relay.handlerOf(7)?.admit?.({ connectionHandle: first, header: headerOf(1) });
    }).toThrow(thrown);

    for (const refusal of [SERVER_FAILURES.payloadTooLarge, CLIENT_FAILURES.accessDenied]) {
      expect(() => {
        return createTestRelay({
          beforeRoute: Object.assign(
            () => {
              return false;
            },
            { refusal: refusal as typeof SERVER_FAILURES.accessDenied }
          ),
        });
      }).toThrow(ProgrammerError);
    }
  });

  test('answers by itself a call a router hands it unasked, as a resolver does', async () => {
    const { answers, relay } = createTestRelay({
      beforeRoute: ({ header }) => {
        return header.callId !== 1;
      },
    });
    const { asked, target } = createTarget();

    relay.register(target, { destinationId: 7 });
    await relay.handlerOf(7)?.(propsOf(headerOf(1), { isAdmitted: false }));
    await relay.handlerOf(8)?.(propsOf(headerOf(3, { destinationId: 8 }), { isAdmitted: false }));
    await relay.handlerOf(7)?.(propsOf(headerOf(5), { isAdmitted: false }));

    expect(failuresOf(answers)).toEqual([
      [ProtocolCode.ACCESS_DENIED, undefined, undefined],
      [ProtocolCode.DESTINATION_UNKNOWN, undefined, 'no destination 8 behind this relay'],
      [9],
    ]);
    expect(asked).toHaveLength(1);
  });

  test('holds a payload to the smaller of the two legs’ limits, and to one envelope of a target that takes no transfer', () => {
    const { relay } = createTestRelay();
    const limitOf = (target: RelayTarget) => {
      const { destinationId } = relay.register(target);

      return relay.handlerOf(destinationId)?.maximumPayloadBytes;
    };

    expect(limitOf(createTarget({ maximumPayloadBytes: 1_000 }).target)).toBe(1_000);
    // one envelope holds more than its limit: the limit
    expect(limitOf(createTarget({ maximumPayloadBytes: 500, maximumTransfers: 0 }).target)).toBe(
      500
    );
    expect(limitOf(createTarget({ maximumPayloadBytes: 2 ** 30 }).target)).toBe(
      LIMIT_DEFAULTS.maximumPayloadBytes
    );
    // a request's header, 12 bytes, and the rest of an envelope of 1 024
    expect(
      limitOf(
        createTarget({ chunkBytes: 1_024, maximumEnvelopeBytes: 4_096, maximumTransfers: 0 }).target
      )
    ).toBe(1_012);
    // a connection of the relay's own: its own limits
    expect(limitOf({ connectionHandle: device })).toBe(LIMIT_DEFAULTS.maximumPayloadBytes);
  });

  test('asks leg B the same service and procedure, with the payload’s bytes, leg A’s signal and no destination', async () => {
    const { answers, relay } = createTestRelay();
    const { asked, target } = createTarget({ maximumPayloadBytes: 1_000 });
    const header = headerOf(1);
    const props = propsOf(header, { payload: Uint8Array.of(4, 5) });

    relay.register(target, { destinationId: 7 });
    await relay.handlerOf(7)?.(props);

    expect(asked).toEqual([
      {
        // leg B presents none, said so, whatever the router it calls through presents by default
        options: {
          credential: { scheme: CredentialScheme.NONE },
          signal: props.signal,
          timeout: Infinity,
        },
        payload: Uint8Array.of(4, 5),
        procedure: {
          maximumPayloadBytes: 1_000,
          procedureId: 1,
          procedureName: '2/1 to 7',
          serviceId: 2,
          serviceRevision: 0,
        },
      },
    ]);
    expect(asked[0]?.options.signal).toBe(props.signal);
    // answered with the very header dispatched, which pairs the answer with its call
    expect(answers).toEqual([[{ payload: Uint8Array.of(9) }, header]]);
    expect(answers[0]?.[1]).toBe(header);
  });

  test('asks a connection of its own by its own router’s request, naming that connection', async () => {
    const { answers, own, relay } = createTestRelay();

    const props = propsOf(headerOf(1));

    relay.register({ connectionHandle: device }, { destinationId: 7 });
    await relay.handlerOf(7)?.(props);

    expect(own).toMatchObject([{ options: { connectionHandle: device, timeout: Infinity } }]);
    expect(own[0]?.options.signal).toBe(props.signal);
    // a relay told nothing of what its connections take passes a request on to any
    expect(
      relay.handlerOf(7)?.admit?.({ connectionHandle: first, header: headerOf(3) })
    ).toBeUndefined();
    expect(failuresOf(answers)).toEqual([[8]]);
  });

  test('passes on a failure of the target’s one relay more, saturated at 255, as it came', async () => {
    const { answers, relay } = createTestRelay();
    const { control, target } = createTarget();

    relay.register(target, { destinationId: 7 });

    for (const [relays, origin, scope] of [
      [0, 'peer', FailureScope.APPLICATION],
      [0, 'peer', FailureScope.PROTOCOL],
      [3, 'relayed', FailureScope.PROTOCOL],
      [254, 'relayed', FailureScope.PROTOCOL],
      [255, 'relayed', FailureScope.PROTOCOL],
    ] as const) {
      control.settle = refusing(
        new FailureError({ code: 19, detail: 'its own detail', origin, relays, scope }),
        'handed'
      );
      await relay.handlerOf(7)?.(propsOf(headerOf(1)));
    }

    expect(
      answers.map(([answer]) => {
        return answer.failure;
      })
    ).toEqual([
      { code: 19, detail: 'its own detail', relays: 1, scope: FailureScope.APPLICATION },
      { code: 19, detail: 'its own detail', relays: 1, scope: FailureScope.PROTOCOL },
      { code: 19, detail: 'its own detail', relays: 4, scope: FailureScope.PROTOCOL },
      { code: 19, detail: 'its own detail', relays: 255, scope: FailureScope.PROTOCOL },
      { code: 19, detail: 'its own detail', relays: 255, scope: FailureScope.PROTOCOL },
    ]);
  });

  test('passes on a limit of leg B’s before the hand-off as its own, and tells a request never tried from one lost after', async () => {
    const { answers, relay, reports } = createTestRelay();
    const { control, target } = createTarget();
    const tooLarge = new FailureError({
      ...CLIENT_FAILURES.payloadTooLarge,
      detail: 'a payload is 8 bytes at most, not 9',
    });

    relay.register(target, { destinationId: 7 });

    for (const [reason, reach] of [
      [tooLarge, 'never'],
      // its result, past leg B's limit: the procedure ran
      [tooLarge, 'handed'],
      [
        new FailureError({
          ...CLIENT_FAILURES.capacityExceeded,
          detail: `every call id of ${device} is in use`,
        }),
        'never',
      ],
      [new Error('the socket is closed'), 'never'],
      [new Error('the socket refused it'), 'refused'],
      [new DisconnectError('the relay’s router was disposed'), 'never'],
      [new DisconnectError('the connection closed before the answer'), 'handed'],
      [new TimeoutError(250), 'handed'],
      [new FailureError({ ...CLIENT_FAILURES.transferStalled, detail: 'nothing came' }), 'handed'],
      ['a reason that is no error', 'never'],
      // any other refusal of leg B's own before the hand-off: nothing was tried
      [new FailureError({ ...CLIENT_FAILURES.transferStalled, detail: 'nothing came' }), 'never'],
    ] as const) {
      control.settle = refusing(reason, reach);
      await relay.handlerOf(7)?.(propsOf(headerOf(1)));
    }

    const unreachable = [
      ProtocolCode.DESTINATION_UNREACHABLE,
      undefined,
      'destination 7 is unreachable: nothing was tried',
    ];
    const lost = [
      ProtocolCode.DESTINATION_LOST,
      undefined,
      'destination 7 was lost once handed the request: the procedure may have run',
    ];

    // no address behind the relay reaches leg A: what leg B failed with is reported instead
    expect(failuresOf(answers)).toEqual([
      [ProtocolCode.PAYLOAD_TOO_LARGE, undefined, 'a payload is 8 bytes at most, not 9'],
      lost,
      [ProtocolCode.CAPACITY_EXCEEDED, undefined, 'destination 7 takes no more calls at once'],
      unreachable,
      unreachable,
      unreachable,
      lost,
      lost,
      lost,
      unreachable,
      unreachable,
    ]);
    expect(reports).toEqual([
      [tooLarge.message, true],
      ['the socket is closed', true],
      ['the socket refused it', true],
      ['the relay’s router was disposed', true],
      ['the connection closed before the answer', true],
      ['timed out after 250ms', true],
      ['local client protocol failure 51 TRANSFER_STALLED: nothing came', true],
      ['a reason that is no error', true],
      ['local client protocol failure 51 TRANSFER_STALLED: nothing came', true],
    ]);

    // a limit of leg B's own crossed no relay, whatever relays it says it crossed
    control.settle = refusing(
      new FailureError({
        ...CLIENT_FAILURES.payloadTooLarge,
        detail: 'a payload is 8 bytes at most, not 9',
        relays: 3,
      }),
      'never'
    );
    await relay.handlerOf(7)?.(propsOf(headerOf(3)));

    expect(failuresOf(answers).at(-1)).toEqual([
      ProtocolCode.PAYLOAD_TOO_LARGE,
      undefined,
      'a payload is 8 bytes at most, not 9',
    ]);
  });

  test('answers nothing once leg A ended: leg B, cancelled by the same signal, rejects', async () => {
    const { answers, relay } = createTestRelay();
    const { control, target } = createTarget();
    const controller = new AbortController();

    relay.register(target, { destinationId: 7 });
    control.settle = (onSent) => {
      onSent(true);
      controller.abort(new CancelError('call 1 was cancelled'));

      return Promise.reject(new CancelError('call 2 was cancelled'));
    };
    await relay.handlerOf(7)?.(propsOf(headerOf(1), { signal: controller.signal }));

    expect(answers).toEqual([]);
  });

  // spec 14.5
  test('answers as failed, once, what leg A cannot carry, and lets why be reported', async () => {
    const { answers, control, relay } = createTestRelay();
    const tooLarge = new FailureError({
      ...SERVER_FAILURES.payloadTooLarge,
      detail: 'a payload is 8 bytes at most, not 9',
    });
    const gone = new Error('the socket is closed');

    relay.register(createTarget().target, { destinationId: 7 });
    control.respondErrors.push(tooLarge);

    await expect(relay.handlerOf(7)?.(propsOf(headerOf(1)))).rejects.toBe(tooLarge);

    // the second cannot go out either: it goes nowhere, and the first reason is the one reported
    control.respondErrors.push(gone, new Error('still closed'));

    await expect(relay.handlerOf(7)?.(propsOf(headerOf(3)))).rejects.toBe(gone);
    expect(failuresOf(answers)).toEqual([
      [9],
      [ProtocolCode.PAYLOAD_TOO_LARGE, undefined, 'a payload is 8 bytes at most, not 9'],
      [9],
      [ProtocolCode.PROCEDURE_FAILED, undefined, 'the socket is closed'],
    ]);
  });

  test('registers a destination given or drawn — never 0, nor one taken — lists them, and takes out its own alone', () => {
    const { relay } = createTestRelay();
    const { target } = createTarget();
    const seven = relay.register(target, { destinationId: 7, label: 'north' });
    const drawn = relay.register(target);

    expect(seven).toMatchObject({ destinationId: 7, label: 'north' });
    expect(drawn.destinationId).toBeGreaterThanOrEqual(1);
    expect(drawn.destinationId).toBeLessThanOrEqual(0xffffffff);
    expect(drawn.destinationId).not.toBe(7);

    for (const destinationId of [7, 0, -1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => {
        return relay.register(target, { destinationId });
      }, String(destinationId)).toThrow(ProgrammerError);
    }

    expect(relay.destinations()).toEqual([
      { destinationId: 7, label: 'north' },
      { destinationId: drawn.destinationId, label: undefined },
    ]);

    // taken out, then registered again: the first registration's own no longer takes it out
    expect(seven.unregister()).toBe(true);

    const again = relay.register(target, { destinationId: 7 });

    expect(seven.unregister()).toBe(false);
    expect(relay.destinations()).toEqual([
      { destinationId: drawn.destinationId, label: undefined },
      { destinationId: 7, label: undefined },
    ]);
    expect(again.unregister()).toBe(true);
  });

  test('binds a call to its destination as it opens: one registered in its place later takes nothing of it', async () => {
    const { relay } = createTestRelay();
    const before = createTarget();
    const after = createTarget();
    const registration = relay.register(before.target, { destinationId: 7 });
    const handler = relay.handlerOf(7);

    registration.unregister();
    relay.register(after.target, { destinationId: 7 });
    await handler?.(propsOf(headerOf(1)));

    expect([before.asked.length, after.asked.length]).toEqual([1, 0]);
  });

  test('waits on leg B as long as the destination says, the relay’s timeout at most, or on', async () => {
    const { relay } = createTestRelay({
      beforeRoute: () => {
        return true;
      },
      timeout: 5_000,
    });
    const unbounded = createTestRelay();
    const { asked, target } = createTarget();

    relay.register(target, { destinationId: 7 });
    relay.register(target, { destinationId: 8, timeout: 250 });
    relay.register(target, { destinationId: 9, timeout: 60_000 });
    unbounded.relay.register(target, { destinationId: 7 });
    unbounded.relay.register(target, { destinationId: 8, timeout: 250 });

    for (const each of [relay, unbounded.relay]) {
      await each.handlerOf(7)?.(propsOf(headerOf(1)));
      await each.handlerOf(8)?.(propsOf(headerOf(3, { destinationId: 8 })));
    }

    await relay.handlerOf(9)?.(propsOf(headerOf(5, { destinationId: 9 })));

    expect(
      asked.map(({ options }) => {
        return options.timeout;
      })
    ).toEqual([5_000, 250, Infinity, 250, 5_000]);
  });

  test('passes nothing on to a connection of its own that takes no request of the relay’s', async () => {
    const answers: RouterAnswer[] = [];
    const own: unknown[] = [];
    const relay = createRelay({
      failures: SERVER_FAILURES,
      isTwoWay: (connectionHandle) => {
        return connectionHandle !== device;
      },
      limits: LIMIT_DEFAULTS,
      options: {
        beforeRoute: () => {
          return true;
        },
      },
      report: () => {},
      request: (payload) => {
        own.push(payload);

        return answering(Uint8Array.of(8))(() => {});
      },
      respond: (answer) => {
        answers.push(answer);

        return Promise.resolve();
      },
    });

    relay.register({ connectionHandle: device }, { destinationId: 7 });
    relay.register({ connectionHandle: first }, { destinationId: 8 });

    expect(relay.handlerOf(7)?.admit?.({ connectionHandle: first, header: headerOf(1) })).toEqual({
      ...SERVER_FAILURES.destinationUnreachable,
      detail: 'destination 7 is unreachable: its connection carries no request',
    });

    await relay.handlerOf(8)?.(propsOf(headerOf(3, { destinationId: 8 })));

    expect(answers).toEqual([{ payload: Uint8Array.of(8) }]);
    expect(own).toHaveLength(1);
  });

  test('leaves a connection of its own unreachable once it closed, whoever takes its handle next, until registered anew', async () => {
    const { answers, own, relay } = createTestRelay();
    const { asked, target } = createTarget();
    const closed = relay.register({ connectionHandle: device }, { destinationId: 7 });

    relay.register({ connectionHandle: first }, { destinationId: 8 });
    relay.register(target, { destinationId: 9 });

    // admitted as its payload came, then its connection closed: nothing is handed over
    const admitted = relay.handlerOf(7);

    relay.closeConnection(device);

    const unreachable = {
      ...SERVER_FAILURES.destinationUnreachable,
      detail: 'destination 7 is unreachable: its connection closed',
    };

    expect(relay.handlerOf(7)?.admit?.({ connectionHandle: first, header: headerOf(1) })).toEqual(
      unreachable
    );
    await admitted?.(propsOf(headerOf(3)));
    // the others are reached still
    await relay.handlerOf(8)?.(propsOf(headerOf(5, { destinationId: 8 })));
    await relay.handlerOf(9)?.(propsOf(headerOf(7, { destinationId: 9 })));

    expect(failuresOf(answers)).toEqual([
      [unreachable.code, undefined, unreachable.detail],
      [8],
      [9],
    ]);
    expect(own).toMatchObject([{ options: { connectionHandle: first } }]);
    expect(asked).toHaveLength(1);
    // it stays registered, and listed, until the application takes it out: its id is not free
    expect(relay.destinations()).toContainEqual({ destinationId: 7, label: undefined });
    expect(() => {
      return relay.register({ connectionHandle: device }, { destinationId: 7 });
    }).toThrow(ProgrammerError);
    expect(closed.unregister()).toBe(true);

    relay.register({ connectionHandle: device }, { destinationId: 7 });
    await relay.handlerOf(7)?.(propsOf(headerOf(9)));

    expect(own).toMatchObject([
      { options: { connectionHandle: first } },
      { options: { connectionHandle: device } },
    ]);
  });

  test('takes the audience each destination verifies, gives the set of them, and refuses one not of well-formed Unicode', () => {
    const { relay } = createTestRelay();

    relay.register({ connectionHandle: device }, { audience: 'bead-interop', destinationId: 3 });
    relay.register({ connectionHandle: first }, { audience: 'bead-interop', destinationId: 5 });
    relay.register(createTarget().target, { audience: 'bead-other', destinationId: 7 });
    relay.register(createTarget().target, { destinationId: 9 });

    expect(relay.audiences()).toEqual(['bead-interop', 'bead-other']);
    expect(() => {
      return relay.register(createTarget().target, { audience: '\ud800' });
    }).toThrow(ProgrammerError);
  });

  test('forwards a credential unresolved unless it verifies, as each of its handlers says, to a destination registered or not', () => {
    const forwarding = createTestRelay();
    const verifying = createTestRelay({
      beforeRoute: () => {
        return true;
      },
      verifies: true,
    });

    for (const { relay } of [forwarding, verifying]) {
      relay.register(createTarget().target, { destinationId: 7 });
    }

    expect(
      [forwarding, verifying].flatMap(({ relay }) => {
        return [relay.handlerOf(7)?.forwardsCredentials, relay.handlerOf(8)?.forwardsCredentials];
      })
    ).toEqual([true, true, false, false]);
  });

  test('counts its destinations, those whose connection closed among them, and keeps none for a connection', () => {
    const { relay } = createTestRelay();
    const { target } = createTarget();

    relay.register(target, { destinationId: 3 });
    relay.register({ connectionHandle: device }, { destinationId: 5 });
    relay.register({ connectionHandle: first }, { destinationId: 7 });
    relay.closeConnection(device);

    expect(relay.gauges()).toEqual({
      anomalies: [],
      ceilings: {},
      connectionHandles: new Set(),
      counts: { closedDestinations: 1, destinations: 3 },
    });
  });
});
