// ── HTTP gateway ──────────────────────────────────────────────────────────────

// A gateway (spec/transcoding.md, decision 0037): an HTTP server that answers a service's procedures
// as routes, each call made through one more Bead client of its application's own server, one
// connection an exchange; beside the wire, never in place of it.

// dependencies

import { createHash } from 'node:crypto';
import { type DescMessage, type Message, toBinary } from '@bufbuild/protobuf';
import { createClient } from '../client/client';
import { DisconnectError, FailureError } from '../router/client/router-client';
import { credentialBytesAt, MAXIMUM_HEADER_BYTES } from '../router/shared/header';
import {
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  ProtocolCode,
} from '../router/shared/constants';
import type {
  INotificationLike,
  IReceivedFailure,
  RequestCredential,
  RouterLimitsOptions,
} from '../router/shared/types';
import { createMemoryTransportClient } from '../transport/client/memory-transport-client';
import {
  assertHeld,
  assertHeldFinite,
  type IClock,
  PLATFORM_CLOCK,
  type TimeoutId,
} from '../transport/shared/clock';
import { REFUSAL_HEADER } from '../transport/shared/constants';
import { createEmitter } from '../transport/shared/emitter';
import { CancelError, ProgrammerError, TimeoutError, toError } from '../transport/shared/errors';
import { HEARTBEAT } from '../transport/shared/heartbeat';
import type { EmitterListener, IMemoryTransportServerLike } from '../transport/shared/types';
import {
  assertHosts,
  assertOrigins,
  credentialOf,
  hasVisibleFields,
  isListedOrigin,
  isTakenHost,
  isTakenOrigin,
  ownAuthorityOf,
  requestTargetOf,
} from '../transport/server/hosts-and-origins';
import {
  type IHTTPPolicyInit,
  type IHTTPPolicyOption,
  withPolicy,
} from '../transport/server/http-policy';
import {
  authorityNamedBy,
  closingOf,
  headerOf,
  linesOf,
  preflightOf,
  REFUSALS,
  refuseMalformed,
  RESPONSE_HEADERS,
} from '../transport/server/http-server-fields';
import {
  boundHeadOf,
  createSendPace,
  HEADERS_TIMEOUT,
  MAXIMUM_CONNECTIONS,
  MAXIMUM_CONNECTIONS_PER_ADDRESS,
  MINIMUM_SEND_BYTES_PER_SECOND,
  SEND_GRACE_PERIOD,
} from '../transport/server/server-bounds';
import { clientAddressOf, trustedProxiesOf } from '../transport/server/trusted-proxies';
import type {
  HTTPRequestListener,
  IHTTPRequestLike,
  IHTTPResponseLike,
  IHTTPServerLike,
} from '../transport/server/types';
import { MAXIMUM_UNSENT_BYTES } from '../transport/server/ws-transport-server';
import { bindRequest } from './binding';
import {
  createEventStream,
  EVENT_STREAM_MEDIA_TYPE,
  eventDataOf,
  type IEventStream,
} from './events';
import {
  JsonFormError,
  type ITypeRegistry,
  typeRegistryOf,
  writeFieldJson,
  writeProtoJson,
} from './json-form';
import {
  type Arose,
  type Encoding,
  type IProblem,
  problemOfFailure,
  problemOfOwn,
  problemOfRefusal,
  PROBLEM_MEDIA_TYPE,
} from './problems';
import type { HttpMethod, HttpPayload, IHttpRouteInit, IHttpRouteTemplate } from './routes';
import {
  type ITemplate,
  rawPathOf,
  routeIndexOf,
  templateOf,
  variablesOf,
  type IRawPath,
} from './templates';

// interfaces

/**
 * A gateway's options (transcoding 2.4, 7.6, 8.7, 8.8, 9.2, 10.3, 11.1): its route table, the
 * in-memory transport its connections cross, its document, and its gates and bounds, one by one or
 * as one policy, which the HTTP transport takes too.
 */
export interface IHTTPGatewayOptions extends IHTTPPolicyInit, IHTTPPolicyOption {
  /**
   * What a call presents of a request's `authorization` (2.4): `elsewhere`, the field whole, by
   * default; `bearer-jwt`, a `Bearer` token as a `JWT`.
   */
  readonly authorization?: 'bearer-jwt' | 'elsewhere' | undefined;
  /** The challenge a 401 carries, `Bearer` by default (7.6). */
  readonly challenge?: string | undefined;
  /** The clock it runs on, and its exchanges' clients; the platform's by default. */
  readonly clock?: IClock | undefined;
  /**
   * Builds its own listener, `node:http`'s `createServer` or `node:http2`'s, for `start`; none, and
   * it answers as a handler alone, `listener`, which an application mounts on a server of its own.
   */
  readonly createServer?:
    | ((listener: HTTPRequestListener, options: { address: string }) => IHTTPServerLike)
    | undefined;
  /** The document its builder wrote, served at `/openapi.json` (11.1); none, it serves none. */
  readonly document?: string | undefined;
  /** Milliseconds between a quiet stream's comments, 30 s by default; `Infinity`, none (8.7). */
  readonly heartbeat?: number | undefined;
  /** The router limits of each exchange's client; `LIMIT_DEFAULTS`' where they say nothing. */
  readonly limits?: RouterLimitsOptions | undefined;
  /** The calls under way at once, every caller's (10.3), 10,000 by default. */
  readonly maximumExchanges?: number | undefined;
  /** The calls under way at once of one caller's address (10.3), 256 by default. */
  readonly maximumExchangesPerAddress?: number | undefined;
  /** What a stream's response may hold unsent before it is dropped (10.2), a WebSocket's default. */
  readonly maximumUnsentBytes?: number | undefined;
  /** The base an application failure's name follows as its problem's type (7.3); none, `about:blank`. */
  readonly problemTypes?: string | undefined;
  /** Its route table: beadc's `HTTP_ROUTES`. */
  readonly routes: readonly IHttpRouteInit[];
  /** Milliseconds a call waits for its answer, 5 s by default; `Infinity`, without end (9.2). */
  readonly timeout?: number | undefined;
  /** The in-memory transport its connections cross, which its application's server joined (2.2). */
  readonly transport: IMemoryTransportServerLike;
  /** The notifications a stream lets come before its response took them (8.8), 16 by default. */
  readonly window?: number | undefined;
}

/** Where a gateway's own listener listens. */
export interface IHTTPGatewayStartOptions {
  /** An IP literal or a name, `127.0.0.1` by default. */
  readonly address?: string | undefined;
  /** Its port; 0, any free one. */
  readonly port?: number | undefined;
}

/** The events a gateway emits, named by the table that types them. */
export type HTTPGatewayEventMap = {
  /**
   * What went wrong that no caller can mend, reported, its words never in a problem (spec 9.0): a
   * result Bead's proto JSON form holds none of, a scheme its server takes none of (transcoding
   * 7.6), an answer its stock library refuses, a connection it could not draw, what no gate foresaw.
   */
  error: [error: Error];
};

/** A gateway: its handler, its own listener's start and stop, and what it reports. */
export interface IHTTPGateway extends AsyncDisposable {
  /**
   * Answers an exchange whose path one of its routes or its document matches, and gives `true`;
   * gives `false` for any other, written nothing, for the server it is mounted on to answer.
   */
  readonly listener: (request: IHTTPRequestLike, response: IHTTPResponseLike) => boolean;

  /** Takes a listener off `event`. */
  off: <K extends keyof HTTPGatewayEventMap>(
    event: K,
    listener: EmitterListener<HTTPGatewayEventMap[K]>
  ) => void;
  /** Calls `listener` on each `event`; what it throws goes no further, and the exchange answers on. */
  on: <K extends keyof HTTPGatewayEventMap>(
    event: K,
    listener: EmitterListener<HTTPGatewayEventMap[K]>
  ) => void;
  /** Listens on its own listener, built by `createServer`, and gives its port. */
  start: (options?: IHTTPGatewayStartOptions) => Promise<{ port: number }>;
  /** Closes its listener, and ends every exchange under way, each connection closed. */
  stop: () => Promise<void>;
}

/** A route of the table, its template parsed. */
interface IServedRoute {
  readonly init: IHttpRouteInit;
  /** Whether a navigation from another site may reach it (10.1, step 5). */
  readonly isNavigable: boolean;
  readonly method: HttpMethod;
  readonly route: IHttpRouteTemplate;
  readonly template: ITemplate;
}

/** A response as the gateway writes it: Node's, its write's backpressure and its drain. */
interface IResponseLike extends IHTTPResponseLike {
  on(event: 'close' | 'drain' | 'finish', listener: () => void): unknown;
}

/** An exchange under way: its request, its response, and what it holds. */
interface IExchange {
  readonly address: string;
  readonly port: number | undefined;
  readonly request: IHTTPRequestLike;
  readonly response: IResponseLike;
  /** Whether its body was read whole, so an answer leaves no rest of it to drop. */
  isBodyRead: boolean;
}

// constants

/** Where a gateway serves its document (transcoding 11.1). */
export const DOCUMENT_PATH = '/openapi.json';

/** A call's timeout where its options give none, 9.9's (transcoding 9.2). */
export const TIMEOUT = 5_000;

/** A stream's window where its options give none, 11.11's (transcoding 8.8). */
export const WINDOW = 16;

/** The calls under way at once, every caller's and one address's (transcoding 10.3). */
export const MAXIMUM_EXCHANGES = 10_000;
export const MAXIMUM_EXCHANGES_PER_ADDRESS = 256;

/** The bounds of what comes, 15.12's, each its default there. */
const BODY_BYTES_BUDGET = 268_435_456;
const BODY_GRACE_PERIOD = 5_000;
const MAXIMUM_BODY_BYTES = 16_778_240;
const MINIMUM_BODY_BYTES_PER_SECOND = 240;

// a `JWT` the request's header holds at most, past its fixed part and its block's head (spec 4.4)
const JWT_BYTES = MAXIMUM_HEADER_BYTES - credentialBytesAt(EnvelopeKind.REQUEST, 0);

// the methods in the order an `allow` names them (transcoding 3.10)
const METHOD_ORDER: readonly string[] = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

const MEDIA_TYPES: Readonly<Record<Encoding, string>> = Object.freeze({
  json: 'application/json',
  proto: 'application/json',
  raw: 'application/octet-stream',
  text: 'text/plain',
});

const RESULT_MEDIA_TYPES: Readonly<Record<Encoding, string>> = Object.freeze({
  json: 'application/json',
  proto: 'application/json',
  raw: 'application/octet-stream',
  text: 'text/plain;charset=utf-8',
});

const BEARER = /^bearer[ \t]+([^ \t].*)$/iu;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// helpers

const encodingOf = (payload: HttpPayload): Encoding => {
  return typeof payload === 'string' ? payload : 'proto';
};

/** The weight `accept` gives a media type, by its most specific range; 0 where none names it. */
const weightOf = (
  accept: string,
  { exactly, type }: { exactly: boolean; type: string }
): number => {
  const [major] = type.split('/');
  let best: { rank: number; weight: number } | undefined;

  for (const range of accept.split(',')) {
    const [name = '', ...parameters] = range.split(';').map((part) => {
      return part.trim().toLowerCase();
    });
    const rank = name === type ? 3 : name === `${major ?? ''}/*` ? 2 : name === '*/*' ? 1 : 0;

    if (rank === 0 || (exactly && rank !== 3)) {
      continue;
    }

    const q = parameters.find((parameter) => {
      return parameter.startsWith('q=');
    });
    const weight = q === undefined ? 1 : Number(q.slice(2));

    if (best === undefined || rank > best.rank) {
      best = { rank, weight: Number.isFinite(weight) ? weight : 0 };
    }
  }

  return best?.weight ?? 0;
};

/**
 * Whether a request asks for a stream (8.1): its `accept` names `text/event-stream` itself, of a
 * weight above 0 and at least the weight it gives `application/json`; never through a wildcard.
 */
const asksStream = (request: IHTTPRequestLike): boolean => {
  const accept = linesOf(request, 'accept').join(', ');
  const stream = weightOf(accept, { exactly: true, type: EVENT_STREAM_MEDIA_TYPE });

  return stream > 0 && stream >= weightOf(accept, { exactly: false, type: 'application/json' });
};

/**
 * Whether a body's `content-type` is its route's (5.1): its type, compared case-insensitively, and
 * no parameter but `charset=utf-8`, in any case; its `content-encoding` none or `identity`.
 */
const isTakenType = (request: IHTTPRequestLike, encoding: Encoding): boolean => {
  const encoded = headerOf(request, 'content-encoding')?.trim().toLowerCase();

  if (encoded !== undefined && encoded !== 'identity') {
    return false;
  }

  const [type = '', ...parameters] = (headerOf(request, 'content-type') ?? '').split(';');

  if (type.trim().toLowerCase() !== MEDIA_TYPES[encoding]) {
    return false;
  }

  return parameters.every((parameter) => {
    const [name = '', value = ''] = parameter.split('=').map((part) => {
      return part.trim().toLowerCase();
    });

    return name === 'charset' && value.replaceAll('"', '') === 'utf-8';
  });
};

/** Whether a request carries content: a length past 0, or a transfer coding (4.4, 10.1 step 8). */
const carriesContent = (request: IHTTPRequestLike): boolean => {
  return (
    Number(headerOf(request, 'content-length') ?? '0') > 0 ||
    headerOf(request, 'transfer-encoding') !== undefined
  );
};

/** Each `entity-tag` an `if-none-match` holds, weakly compared, or whether it is `*` (RFC 9110 §13.1.2). */
const matchesTag = (request: IHTTPRequestLike, etag: string): boolean => {
  const given = linesOf(request, 'if-none-match').join(',');

  if (given.trim() === '*') {
    return true;
  }

  return given.split(',').some((tag) => {
    return tag.trim().replace(/^W\//u, '') === etag;
  });
};

/** A protocol failure's scope, as a problem names it. */
const scopeOf = (scope: number): 'application' | 'protocol' => {
  return scope === FailureScope.APPLICATION ? 'application' : 'protocol';
};

// definition

/**
 * A gateway of `options.routes`, beadc's route table (transcoding 1.1): each request judged in 10.1's
 * order — HTTP's own, its host, its path, its origin, Fetch Metadata, a preflight, its method, its
 * type, its fields and bounds, its body as it comes — then bound, read by Bead's mapping and called
 * through one Bead connection drawn for its exchange across `options.transport`, closed as its
 * response ends. Its result answers 200 in Bead's proto JSON form, its failure a problem by where it
 * arose, a stream Server-Sent Events. Options that do not hold are a {@link ProgrammerError}.
 *
 * @example
 * import { createHTTPGateway } from '@francisdesjardins/bead/http-gateway';
 * import { joinTransports } from '@francisdesjardins/bead/joined-transport-server';
 * import { createMemoryTransportServer } from '@francisdesjardins/bead/memory-transport-server';
 * import { createServer } from '@francisdesjardins/bead/server';
 *
 * const memory = createMemoryTransportServer();
 * const server = createServer({ transport: joinTransports([memory, webSocket]) });
 * const gateway = createHTTPGateway({
 *   createServer: createNodeServer,
 *   document: OPENAPI_DOCUMENT,
 *   routes: HTTP_ROUTES,
 *   transport: memory,
 * });
 *
 * void memory.start().then(() => {
 *   return gateway.start({ port: 8080 });
 * });
 */
export const createHTTPGateway = (given: IHTTPGatewayOptions): IHTTPGateway => {
  const options = withPolicy(given);
  const {
    authorization = 'elsewhere',
    bodyBytesBudget = BODY_BYTES_BUDGET,
    bodyGracePeriod: givenBodyGracePeriod = BODY_GRACE_PERIOD,
    challenge,
    clock = PLATFORM_CLOCK,
    createServer,
    document,
    headersTimeout: givenHeadersTimeout = HEADERS_TIMEOUT,
    heartbeat: givenHeartbeat = HEARTBEAT,
    hosts,
    limits,
    maximumBodyBytes = MAXIMUM_BODY_BYTES,
    maximumConnections = MAXIMUM_CONNECTIONS,
    maximumConnectionsPerAddress = MAXIMUM_CONNECTIONS_PER_ADDRESS,
    maximumExchanges = MAXIMUM_EXCHANGES,
    maximumExchangesPerAddress = MAXIMUM_EXCHANGES_PER_ADDRESS,
    maximumUnsentBytes = MAXIMUM_UNSENT_BYTES,
    minimumBodyBytesPerSecond = MINIMUM_BODY_BYTES_PER_SECOND,
    minimumSendBytesPerSecond = MINIMUM_SEND_BYTES_PER_SECOND,
    origins = [],
    problemTypes,
    routes,
    sendGracePeriod: givenSendGracePeriod = SEND_GRACE_PERIOD,
    timeout: givenTimeout = TIMEOUT,
    transport,
    trustedProxies,
    unnamedProxies,
    window = WINDOW,
  } = options;

  // a caller without types may give anything
  const scheme: unknown = authorization;

  if (scheme !== 'elsewhere' && scheme !== 'bearer-jwt') {
    throw new ProgrammerError("a gateway's authorization is elsewhere or bearer-jwt");
  }

  for (const [name, value] of Object.entries({
    bodyBytesBudget,
    maximumBodyBytes,
    maximumConnections,
    maximumConnectionsPerAddress,
    maximumExchanges,
    maximumExchangesPerAddress,
    maximumUnsentBytes,
    window,
  })) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new ProgrammerError(`${name} is a whole number above 0, not ${String(value)}`);
    }
  }

  const timeout = assertHeld('timeout', givenTimeout);
  const heartbeat = assertHeld('heartbeat', givenHeartbeat);
  const headersTimeout = assertHeldFinite('headersTimeout', givenHeadersTimeout);
  const bodyGracePeriod = assertHeldFinite('bodyGracePeriod', givenBodyGracePeriod);
  const pace = {
    minimumSendBytesPerSecond,
    sendGracePeriod: assertHeldFinite('sendGracePeriod', givenSendGracePeriod),
  };

  assertHosts(hosts);
  assertOrigins(origins);

  const proxies = trustedProxiesOf(trustedProxies, { unnamedProxies });

  // ── The table ──────────────────────────────────────────────────────────────

  const served: IServedRoute[] = routes.flatMap((init) => {
    return init.routes.map((route) => {
      return {
        init,
        isNavigable: route.method === 'GET' && init.noSideEffects === true,
        method: route.method,
        route,
        template: templateOf(route.template),
      };
    });
  });
  const registry: ITypeRegistry = typeRegistryOf(
    routes.flatMap(({ notification, request, result }) => {
      return [request, result, notification].filter((payload): payload is DescMessage => {
        return typeof payload === 'object';
      });
    })
  );
  const documentBytes = document === undefined ? undefined : ENCODER.encode(document);
  const etag =
    documentBytes === undefined
      ? undefined
      : `"${createHash('sha256').update(documentBytes).digest('hex')}"`;

  // ── Bounds ─────────────────────────────────────────────────────────────────

  // the calls and the streams under way, every caller's and by address, and the body bytes held
  const calls = { all: 0, byAddress: new Map<string, number>() };
  const streams = { all: 0, byAddress: new Map<string, number>() };
  let bodyBytes = 0;
  // every exchange under way, ended by a stop
  const live = new Set<() => void>();
  const emitter = createEmitter<HTTPGatewayEventMap>();

  // ! a listener's throw goes no further: the exchange answers on
  const report = (reason: unknown): void => {
    emitter.emitEach('error', { onError: () => {}, params: [toError(reason)] });
  };

  const admit = (
    counts: typeof calls,
    { address, most, mostPerAddress }: { address: string; most: number; mostPerAddress: number }
  ): (() => void) | undefined => {
    const held = counts.byAddress.get(address) ?? 0;

    if (counts.all >= most || held >= mostPerAddress) {
      return undefined;
    }

    counts.all += 1;
    counts.byAddress.set(address, held + 1);

    let isReleased = false;

    return () => {
      if (isReleased) {
        return;
      }

      isReleased = true;
      counts.all -= 1;

      const left = (counts.byAddress.get(address) ?? 1) - 1;

      if (left === 0) {
        counts.byAddress.delete(address);
      } else {
        counts.byAddress.set(address, left);
      }
    };
  };

  // ── Writing ────────────────────────────────────────────────────────────────

  /** Writes an exchange's whole response: its fields, and its body unless it answers a `HEAD`. */
  const answer = (
    exchange: IExchange,
    {
      body,
      fields = {},
      isPlain = false,
      reason,
      status,
    }: {
      body?: Uint8Array | undefined;
      fields?: Readonly<Record<string, string>> | undefined;
      /** Whether it writes none of a call's fields: the document's. */
      isPlain?: boolean;
      reason?: string | undefined;
      status: number;
    }
  ): void => {
    const { request, response } = exchange;

    if (response.headersSent) {
      response.end();

      return;
    }

    const closing = exchange.isBodyRead ? {} : closingOf(exchange);

    response.writeHead(status, {
      ...(isPlain
        ? { vary: RESPONSE_HEADERS.vary, 'x-content-type-options': 'nosniff' }
        : RESPONSE_HEADERS),
      ...fields,
      ...(body === undefined ? {} : { 'content-length': String(body.length) }),
      ...(reason === undefined ? {} : { [REFUSAL_HEADER]: reason }),
      ...closing,
    });

    if (body === undefined || request.method === 'HEAD') {
      response.end();
    } else {
      response.end(body);
    }
  };

  /** Answers a problem: a call's failure, or a refusal of the gateway's own, marked by its reason. */
  const answerProblem = (
    exchange: IExchange,
    { problem, reason }: { problem: IProblem; reason?: string | undefined }
  ): void => {
    answer(exchange, {
      body: ENCODER.encode(problem.body),
      fields: { ...problem.fields, 'content-type': PROBLEM_MEDIA_TYPE },
      reason,
      status: problem.status,
    });
  };

  /** Refuses an exchange as one of the gateway's own (7.7), `about:blank`, its words its detail. */
  const refuse = (
    exchange: IExchange,
    {
      detail,
      fields = {},
      reason,
      status,
    }: { detail: string; fields?: Record<string, string>; reason: string; status: number }
  ): void => {
    const problem = problemOfRefusal(status, detail);

    answerProblem(exchange, { problem: { ...problem, fields }, reason });
  };

  // ── The body ───────────────────────────────────────────────────────────────

  /**
   * An exchange's body as it comes (10.1, step 10): past `maximumBodyBytes`, 413; past the budget,
   * 503; slower than its rate once its grace passed, 408; each answered here, and `undefined` given.
   */
  const readBody = (exchange: IExchange): Promise<Uint8Array | undefined> => {
    const { request } = exchange;

    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let received = 0;
      let isSettled = false;
      const headAt = clock.performance.now();
      let slow: TimeoutId | undefined;

      const settle = (body: Uint8Array | undefined): void => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        clock.clearTimeout(slow);
        bodyBytes -= received;
        resolve(body);
      };

      const fail = (end: {
        detail: string;
        fields?: Record<string, string>;
        reason: string;
        status: number;
      }) => {
        settle(undefined);
        refuse(exchange, end);
      };

      const paceBody = (): void => {
        clock.clearTimeout(slow);

        if (minimumBodyBytesPerSecond === 0) {
          return;
        }

        const due =
          headAt +
          Math.max(bodyGracePeriod, Math.ceil((received * 1_000) / minimumBodyBytesPerSecond));

        slow = clock.setTimeout(
          () => {
            fail({
              detail: 'the body came slower than its rate',
              reason: REFUSALS.TOO_SLOW,
              status: 408,
            });
          },
          Math.max(1, Math.ceil(due - clock.performance.now()))
        );
        (slow as { unref?: () => unknown }).unref?.();
      };

      request.on('data', (chunk) => {
        if (isSettled) {
          return;
        }

        received += chunk.length;
        bodyBytes += chunk.length;

        if (received > maximumBodyBytes) {
          return (
            fail({
              detail: `a body past ${String(maximumBodyBytes)} bytes`,
              reason: REFUSALS.TOO_LARGE,
              status: 413,
            }),
            undefined
          );
        }

        if (bodyBytes > bodyBytesBudget) {
          return (
            fail({
              detail: 'the bodies under way hold their budget',
              fields: { 'retry-after': '1' },
              reason: REFUSALS.BUSY,
              status: 503,
            }),
            undefined
          );
        }

        chunks.push(chunk);
        paceBody();

        return undefined;
      });
      request.on('end', () => {
        exchange.isBodyRead = true;
        settle(Buffer.concat(chunks));
      });
      request.on('close', () => {
        settle(undefined);
      });
      request.on('error', () => {
        settle(undefined);
      });
      paceBody();
    });
  };

  // ── The call ───────────────────────────────────────────────────────────────

  /** The credential a call presents of a request's `authorization` (2.4), or the refusal it is. */
  const credentialFrom = (
    request: IHTTPRequestLike
  ): { credential?: RequestCredential | undefined; problem?: IProblem | undefined } => {
    const value = credentialOf(linesOf(request, 'authorization'));

    if (value === undefined) {
      return {};
    }

    if (authorization === 'elsewhere') {
      return { credential: { carried: value, scheme: CredentialScheme.ELSEWHERE } };
    }

    const token = BEARER.exec(value)?.[1]?.trim();

    if (token === undefined) {
      return {
        problem: problemOfOwn('scheme', { challenge, detail: 'an auth-scheme but Bearer' }),
      };
    }

    if (ENCODER.encode(token).length > JWT_BYTES) {
      return {
        problem: problemOfOwn('jwt', { detail: `a token past ${String(JWT_BYTES)} bytes` }),
      };
    }

    return { credential: { scheme: CredentialScheme.JWT, token } };
  };

  /** A payload's JSON, or its bytes, as a result's body (5.1, 5.6, 5.8). */
  const resultBodyOf = (
    chosen: IServedRoute,
    { bytes, isNotification }: { bytes: Uint8Array; isNotification: boolean }
  ): { body: string } | { bytes: Uint8Array } => {
    const { init, route } = chosen;
    const payload = isNotification ? init.notification : init.result;
    const codec = isNotification ? init.procedure.notification : init.procedure.result;

    if (payload === undefined || codec === undefined || typeof payload === 'string') {
      return { bytes };
    }

    // * the stock library's own read, its records checked: what it refuses is the server's answer
    const message = codec.decode(bytes) as Message;

    return {
      body:
        route.responseBody === undefined || isNotification
          ? writeProtoJson(payload, { message, registry })
          : writeFieldJson(payload, { message, name: route.responseBody, registry }),
    };
  };

  /** A failure the call came to, as its problem: by its code and where it arose, or the gateway's own. */
  const problemOfCall = (
    reason: unknown,
    {
      chosen,
      credential,
      encoding,
      isHanded,
      variables,
    }: {
      chosen: IServedRoute;
      credential: boolean;
      encoding: Encoding;
      isHanded: boolean;
      variables: readonly string[];
    }
  ): IProblem | undefined => {
    if (reason instanceof FailureError) {
      const arose: Arose = reason.origin === 'local' ? (isHanded ? 'answer' : 'client') : 'server';
      const request = chosen.init.request;

      if (
        reason.code === ProtocolCode.CREDENTIAL_UNSUPPORTED &&
        reason.scope === FailureScope.PROTOCOL
      ) {
        report(
          new Error(`the server takes none of the scheme this gateway presents: ${reason.detail}`, {
            cause: reason,
          })
        );
      }

      return problemOfFailure(
        {
          arose,
          code: reason.code,
          credential,
          detail: reason.detail,
          encoding,
          scope: scopeOf(reason.scope),
        },
        {
          catalogue: chosen.init.failures,
          challenge,
          problemTypes,
          ...(typeof request === 'object'
            ? { route: { body: chosen.route.body, request, variables } }
            : {}),
        }
      );
    }

    if (reason instanceof TimeoutError) {
      return problemOfOwn('timeout', { detail: `no answer within ${String(timeout)} ms` });
    }

    // * the mapping's own words of the result it holds no form of, fixed in transcoding.json
    if (reason instanceof JsonFormError) {
      report(reason);

      return problemOfOwn('unwritable', { detail: reason.message });
    }

    if (reason instanceof CancelError) {
      return undefined;
    }

    if (reason instanceof DisconnectError) {
      return problemOfOwn('closed', { detail: 'the connection closed' });
    }

    // the stock library's refusal of a result, or a notification, the server answered, or what else
    // the call threw: its words are never the gateway's, reported, and its code alone answers (9.0)
    report(reason);

    return problemOfFailure(
      { arose: 'answer', code: ProtocolCode.PAYLOAD_UNDECODABLE, scope: 'protocol' },
      { challenge }
    );
  };

  /** Serves an exchange its routes take, past the gates of 10.1's steps 8 to 11. */
  const serve = async (
    exchange: IExchange,
    { chosen, path, query }: { chosen: IServedRoute; path: IRawPath; query: string }
  ): Promise<void> => {
    const { request, response } = exchange;
    const { init, route, template } = chosen;
    // * heard first: nothing is written once its response closed, whatever ends after
    let isGone = false;

    response.on('close', () => {
      isGone = true;
    });
    const encoding = encodingOf(init.request);
    const takesBody = route.body !== undefined;

    // 8: its type, or content where its route takes none
    if (takesBody && !isTakenType(request, encoding)) {
      return (
        refuse(exchange, {
          detail: `a body of ${MEDIA_TYPES[encoding]} alone, unencoded`,
          reason: REFUSALS.TYPE,
          status: 415,
        }),
        undefined
      );
    }

    if (!takesBody && carriesContent(request)) {
      return (
        refuse(exchange, {
          detail: 'content to a route that takes none',
          reason: REFUSALS.MALFORMED,
          status: 400,
        }),
        undefined
      );
    }

    // 9: its fields and its bounds
    if (linesOf(request, 'authorization').length > 1) {
      return (
        refuse(exchange, {
          detail: 'two authorization fields',
          reason: REFUSALS.MALFORMED,
          status: 400,
        }),
        undefined
      );
    }

    const declared = Number(headerOf(request, 'content-length') ?? Number.NaN);

    if (Number.isFinite(declared) && declared > maximumBodyBytes) {
      return (
        refuse(exchange, {
          detail: `a body declared past ${String(maximumBodyBytes)} bytes`,
          reason: REFUSALS.TOO_LARGE,
          status: 413,
        }),
        undefined
      );
    }

    const isStream = init.notification !== undefined && asksStream(request);
    const release = isStream
      ? admit(streams, {
          address: exchange.address,
          most: maximumConnections,
          mostPerAddress: maximumConnectionsPerAddress,
        })
      : admit(calls, {
          address: exchange.address,
          most: maximumExchanges,
          mostPerAddress: maximumExchangesPerAddress,
        });

    if (release === undefined) {
      return (
        refuse(exchange, {
          detail: isStream
            ? 'the streams of its address are at their bound'
            : 'the calls of its address are at their bound',
          fields: { 'retry-after': '1' },
          reason: REFUSALS.BUSY,
          status: 503,
        }),
        undefined
      );
    }

    response.on('close', release);

    if (isStream && headerOf(request, 'last-event-id') !== undefined) {
      release();

      return (answer(exchange, { status: 204 }), undefined);
    }

    // 10: its body as it comes
    const body = takesBody ? await readBody(exchange) : undefined;

    if (takesBody && body === undefined) {
      return undefined;
    }

    exchange.isBodyRead ||= !takesBody;

    const { credential, problem: refused } = credentialFrom(request);

    if (refused !== undefined) {
      return (answerProblem(exchange, { problem: refused }), undefined);
    }

    // 11: its binding and its reading
    const decoded = variablesOf(template, path);
    const variables = template.variables.map(({ fieldPath }) => {
      return fieldPath;
    });
    let payload: Uint8Array;

    try {
      if (decoded.variables === undefined) {
        throw new JsonFormError(decoded.reason);
      }

      if (typeof init.request === 'object') {
        const message = bindRequest(init.request, {
          body,
          isPatch: route.method === 'PATCH',
          query,
          registry,
          routeBody: route.body,
          variables: decoded.variables,
        });

        payload = toBinary(init.request, message);
      } else if (query !== '') {
        throw new JsonFormError('a query beside a body of the whole request');
      } else {
        payload = body ?? new Uint8Array();
      }
    } catch (error) {
      if (!(error instanceof JsonFormError)) {
        throw error;
      }

      // * the mapping's own words of the client's own request, fixed in transcoding.json
      return (
        answerProblem(exchange, {
          problem: problemOfFailure(
            {
              arose: 'gateway',
              code: ProtocolCode.PAYLOAD_UNDECODABLE,
              detail: error.message,
              scope: 'protocol',
            },
            { challenge }
          ),
        }),
        undefined
      );
    }

    // * one Bead connection for this exchange, closed as its response ends (2.1); its client
    // declares no resolver: a command its server sends is answered SERVICE_UNKNOWN (2.6)
    const client = createClient(
      { transport: createMemoryTransportClient({ clock, server: transport }) },
      { devtools: false, limits }
    );
    const abort = new AbortController();
    let isClosed = false;
    const close = (): void => {
      if (!isClosed) {
        isClosed = true;
        abort.abort(new CancelError('the exchange ended'));
        void client[Symbol.asyncDispose]();
      }
    };

    live.add(close);
    response.on('close', () => {
      live.delete(close);
      close();
    });

    try {
      await client.connect({
        address: exchange.address,
        ...(exchange.port === undefined ? {} : { port: exchange.port }),
      });
    } catch (error) {
      if (abort.signal.aborted) {
        return undefined;
      }

      // ! the in-memory transport's words tell of the gateway's inside, never its client's request
      report(error);

      return (
        answerProblem(exchange, {
          problem: problemOfFailure(
            {
              arose: 'client',
              code: ProtocolCode.DESTINATION_UNREACHABLE,
              detail: 'the connection is gone',
              scope: 'protocol',
            },
            { challenge }
          ),
        }),
        undefined
      );
    }

    let isHanded = false;
    let stream: IEventStream | undefined;
    const procedure = init.procedure.procedure;
    let notification: INotificationLike | undefined;

    if (isStream) {
      const sendPace = createSendPace(
        {
          late: () => {
            response.destroy();
          },
          unsent: () => {
            return response.writableLength ?? 0;
          },
        },
        pace
      );
      const opened = createEventStream(
        {
          answer: (problem) => {
            answerProblem(exchange, { problem });
            close();
          },
          end: () => {
            response.end();
            close();
          },
          open: () => {
            response.writeHead(200, {
              ...RESPONSE_HEADERS,
              'content-type': EVENT_STREAM_MEDIA_TYPE,
            });
            response.flushHeaders?.();
          },
          write: (text) => {
            if (isGone) {
              return Promise.resolve();
            }

            const chunk = ENCODER.encode(text);
            const isTaken = response.write(chunk) !== false;

            sendPace.hand(chunk.length);

            // ! a reader past what it may hold unsent is dropped, as a WebSocket's is (10.2)
            if ((response.writableLength ?? 0) > maximumUnsentBytes) {
              response.destroy();

              return Promise.resolve();
            }

            return isTaken
              ? Promise.resolve()
              : new Promise((resolve) => {
                  response.on('drain', resolve);
                  response.on('close', resolve);
                });
          },
        },
        { clock, heartbeat }
      );

      response.on('close', () => {
        sendPace.stop();
        opened.close();
      });
      stream = opened;
      notification = {
        ...procedure,
        drop: (failure?: IReceivedFailure) => {
          opened.failure(
            failure === undefined
              ? problemOfOwn('closed', { detail: 'the connection closed' })
              : problemOfFailure(
                  {
                    arose: 'server',
                    code: failure.code,
                    detail: failure.detail,
                    scope: scopeOf(failure.scope),
                  },
                  { catalogue: init.failures, challenge, problemTypes }
                )
          );
        },
        trigger: async (bytes: Uint8Array) => {
          let data: string;

          try {
            const read = resultBodyOf(chosen, { bytes, isNotification: true });

            data = 'body' in read ? read.body : dataOfNative(init.notification, read.bytes);
          } catch (error) {
            opened.failure(
              problemOfCall(error, {
                chosen,
                credential: credential !== undefined,
                encoding,
                isHanded: true,
                variables,
              }) ?? problemOfOwn('closed', { detail: 'the connection closed' })
            );

            return [];
          }

          await opened.notification(data);

          return [];
        },
        window,
      };
      await client.router.registerNotification(notification);
    }

    let result: Uint8Array;

    try {
      ({ payload: result } = await client.router.request(payload, {
        onSent: (handed) => {
          isHanded = handed;
        },
        options: {
          ...(credential === undefined ? {} : { credential }),
          signal: abort.signal,
          timeout,
        },
        procedure,
        ...(notification === undefined ? {} : { subscribes: notification }),
      }));
    } catch (error) {
      const problem = problemOfCall(error, {
        chosen,
        credential: credential !== undefined,
        encoding,
        isHanded,
        variables,
      });

      if (problem !== undefined) {
        if (stream === undefined) {
          answerProblem(exchange, { problem });
        } else {
          stream.failure(problem);
        }
      }

      return (close(), undefined);
    }

    let written: { body: string } | { bytes: Uint8Array };

    try {
      written = resultBodyOf(chosen, { bytes: result, isNotification: false });
    } catch (error) {
      const problem =
        problemOfCall(error, {
          chosen,
          credential: credential !== undefined,
          encoding,
          isHanded: true,
          variables,
        }) ?? problemOfOwn('closed', { detail: 'the connection closed' });

      if (stream === undefined) {
        answerProblem(exchange, { problem });
      } else {
        stream.failure(problem);
      }

      return (close(), undefined);
    }

    if (stream !== undefined) {
      return (
        stream.result('body' in written ? written.body : dataOfNative(init.result, written.bytes)),
        undefined
      );
    }

    const resultEncoding = encodingOf(init.result);

    answer(exchange, {
      body: 'body' in written ? ENCODER.encode(written.body) : written.bytes,
      fields: { 'content-type': RESULT_MEDIA_TYPES[resultEncoding] },
      status: 200,
    });

    return (close(), undefined);
  };

  /** A `json`, `text` or `raw` payload as an event's data (8.4). */
  const dataOfNative = (payload: HttpPayload | undefined, bytes: Uint8Array): string => {
    if (payload === 'text') {
      return eventDataOf({ encoding: 'text', text: DECODER.decode(bytes) });
    }

    if (payload === 'raw') {
      return eventDataOf({ bytes, encoding: 'raw' });
    }

    return DECODER.decode(bytes);
  };

  // ── The gates ──────────────────────────────────────────────────────────────

  /** The routes of every method whose templates match `path`, and the methods they take, in order. */
  const routesOf = (
    path: IRawPath | undefined
  ): { matching: IServedRoute[]; methods: string[] } => {
    if (path === undefined) {
      return { matching: [], methods: [] };
    }

    const matching = served.filter(({ template }) => {
      return routeIndexOf([template], path) !== undefined;
    });
    const taken = new Set(
      matching.flatMap(({ method }) => {
        return method === 'GET' ? ['GET', 'HEAD'] : [method];
      })
    );

    return {
      matching,
      methods: METHOD_ORDER.filter((method) => {
        return taken.has(method);
      }),
    };
  };

  /** The route of `method` that answers `path` by 3.5's precedence, `HEAD` as its `GET`. */
  const chosenOf = (path: IRawPath, method: string): IServedRoute | undefined => {
    const asked = method === 'HEAD' ? 'GET' : method;
    const ofMethod = served.filter((candidate) => {
      return candidate.method === asked;
    });
    const index = routeIndexOf(
      ofMethod.map(({ template }) => {
        return template;
      }),
      path
    );

    return index === undefined ? undefined : ofMethod[index];
  };

  const listener = (request: IHTTPRequestLike, response: IHTTPResponseLike): boolean => {
    const target = requestTargetOf(request.url);
    const isDocument = documentBytes !== undefined && target?.path === DOCUMENT_PATH;
    const path = target === undefined ? undefined : rawPathOf(target.path);
    const { matching, methods } = isDocument
      ? { matching: [], methods: ['GET', 'HEAD'] }
      : routesOf(path);

    // a handler mounted on another server leaves it every path it serves none of
    if (createServer === undefined && !isDocument && matching.length === 0) {
      return false;
    }

    const { remoteAddress } = request.socket;
    const forwarded = linesOf(request, 'x-forwarded-for');
    const address =
      remoteAddress === undefined
        ? 'local'
        : clientAddressOf(remoteAddress, {
            forwarded: forwarded.length === 0 ? undefined : forwarded.join(', '),
            trustedProxies: proxies,
          });
    const exchange: IExchange = {
      address,
      isBodyRead: false,
      port: request.socket.remotePort,
      request,
      response,
    };

    // 1: what HTTP refuses of its own, unmarked
    const named = hasVisibleFields(request.rawHeaders) ? authorityNamedBy(request) : undefined;

    if (named === undefined || target === undefined) {
      refuseMalformed({ request, response });

      return true;
    }

    // 2: its host
    if (!isTakenHost(named.authority, hosts)) {
      refuse(exchange, { detail: 'a host it does not take', reason: REFUSALS.HOST, status: 403 });

      return true;
    }

    // 3: its path
    if (!isDocument && matching.length === 0) {
      refuse(exchange, { detail: 'a path no route matches', reason: REFUSALS.PATH, status: 404 });

      return true;
    }

    // 4: its origin
    const origin = headerOf(request, 'origin');

    if (!isTakenOrigin(origin, { host: ownAuthorityOf(named.authority, hosts), origins })) {
      refuse(exchange, {
        detail: 'an origin neither its own nor listed',
        reason: REFUSALS.ORIGIN,
        status: 403,
      });

      return true;
    }

    if (isListedOrigin(origin, origins) && origin !== undefined) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-expose-headers', '*');
    }

    // 5: a request of no origin from another site, but a navigation to what reads alone
    const site = headerOf(request, 'sec-fetch-site');

    if (origin === undefined && (site === 'same-site' || site === 'cross-site')) {
      const isNavigation = headerOf(request, 'sec-fetch-mode') === 'navigate';
      const navigated =
        path === undefined || request.method !== 'GET' ? undefined : chosenOf(path, 'GET');

      if (!isNavigation || !(isDocument || navigated?.isNavigable === true)) {
        refuse(exchange, {
          detail: 'a request of another site that shows no origin',
          reason: REFUSALS.ORIGIN,
          status: 403,
        });

        return true;
      }
    }

    // 6: a preflight from an origin `origins` names
    if (
      request.method === 'OPTIONS' &&
      headerOf(request, 'access-control-request-method') !== undefined &&
      isListedOrigin(origin, origins)
    ) {
      const { headers = {}, status } = preflightOf(request, { methods });

      answer(exchange, { fields: headers, status });

      return true;
    }

    // 7: its method
    const method = request.method ?? 'GET';

    if (isDocument) {
      serveDocument(exchange, method);

      return true;
    }

    const chosen = path === undefined ? undefined : chosenOf(path, method);

    if (chosen === undefined || path === undefined) {
      refuse(exchange, {
        detail: `a method no route of its path takes, ${method}`,
        fields: { allow: methods.join(', ') },
        reason: REFUSALS.METHOD,
        status: 405,
      });

      return true;
    }

    serve(exchange, { chosen, path, query: target.query }).catch((error: unknown) => {
      // ! what no gate foresaw: its exchange ends, never the gateway, and its words are reported
      report(error);
      answerProblem(exchange, {
        problem: problemOfOwn('unwritable', { detail: 'the gateway failed' }),
      });
    });

    return true;
  };

  /** Serves the document (11.1): `GET` and `HEAD`, its tag, and a 304 to a request that holds it. */
  const serveDocument = (exchange: IExchange, method: string): void => {
    if (method !== 'GET' && method !== 'HEAD') {
      refuse(exchange, {
        detail: `a method the document takes none of, ${method}`,
        fields: { allow: 'GET, HEAD' },
        reason: REFUSALS.METHOD,
        status: 405,
      });

      return;
    }

    if (carriesContent(exchange.request)) {
      refuse(exchange, {
        detail: 'content to the document',
        reason: REFUSALS.MALFORMED,
        status: 400,
      });

      return;
    }

    exchange.isBodyRead = true;

    const fields = { 'cache-control': 'no-cache', etag: etag ?? '' };

    if (matchesTag(exchange.request, etag ?? '')) {
      answer(exchange, { fields, isPlain: true, status: 304 });

      return;
    }

    answer(exchange, {
      body: documentBytes,
      fields: { ...fields, 'content-type': 'application/json' },
      isPlain: true,
      status: 200,
    });
  };

  // ── Its own listener ───────────────────────────────────────────────────────

  const listening = new Set<IHTTPServerLike>();

  return {
    listener,

    off: (event, handler) => {
      emitter.off(event, handler);
    },

    on: (event, handler) => {
      emitter.on(event, handler);
    },

    start: ({ address = '127.0.0.1', port = 0 } = {}) => {
      if (createServer === undefined) {
        return Promise.reject(
          new ProgrammerError('a gateway built with no createServer listens on none of its own')
        );
      }

      const instance = createServer(
        (request, response) => {
          listener(request, response);
        },
        { address }
      );

      boundHeadOf(instance, headersTimeout);
      listening.add(instance);

      return new Promise((resolve, reject) => {
        instance.on('error', reject);
        instance.listen(port, address, () => {
          const bound = instance.address();

          resolve({ port: typeof bound === 'object' && bound !== null ? bound.port : port });
        });
      });
    },

    stop: async () => {
      for (const end of live) {
        end();
      }

      await Promise.all(
        [...listening].map((instance) => {
          listening.delete(instance);

          return new Promise<void>((resolve) => {
            instance.close(() => {
              resolve();
            });
            instance.closeAllConnections?.();
          });
        })
      );
    },

    [Symbol.asyncDispose]() {
      return this.stop();
    },
  };
};
