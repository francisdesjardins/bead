// ── HTTP caller ──────────────────────────────────────────────────────────────

// The client half of transcoding (decision 0037, design 3.17): default POST routes, Bead's own
// JSON mapping, problems as failures, and a fetch stream that carries its caller's authorization.

import { fromBinary } from '@bufbuild/protobuf';
import type { GivenOf, ValueOf } from '../service/descriptors';
import { FailureScope, LIMIT_DEFAULTS, ProtocolCode } from '../router/shared/constants';
import { FailureError } from '../router/shared/errors';
import { PAYLOAD_CODECS } from '../router/shared/payloads';
import { ProgrammerError } from '../transport/shared/errors';
import { isSecureUrl } from '../transport/shared/secure';
import { base64Of, readProtoJson, typeRegistryOf, writeProtoJson } from './json-form';
import type { HttpPayload, IHttpRouteInit } from './routes';

/** Its fetch and default Authorization field. */
export interface IHTTPCallerOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly authorization?: string | undefined;
  /** The largest unary body or event, in bytes; the gateway's body bound by default. */
  readonly maximumBodyBytes?: number | undefined;
}

/** A call's credential and abort; withoutAuthorization overrides the default and its own field. */
export interface IHTTPCallOptions {
  readonly authorization?: string | undefined;
  readonly withoutAuthorization?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The first event is the result; each following value is a notification. */
export type HTTPEvent<Result, Notification> =
  | { readonly kind: 'result'; readonly value: Result }
  | { readonly kind: 'notification'; readonly value: Notification };

/** A typed requester, inferred from the generated table's descriptor. */
export type IHTTPRequester<Route extends IHttpRouteInit> = (
  value: GivenOf<Route['procedure']['request']>,
  options?: IHTTPCallOptions
) => Promise<ValueOf<Route['procedure']['result']>>;

/** A typed subscription, inferred from a notifying procedure's generated descriptor. */
export type IHTTPSubscriber<Route extends IHttpRouteInit> = (
  value: GivenOf<Route['procedure']['request']>,
  options?: IHTTPCallOptions
) => AsyncIterable<
  HTTPEvent<ValueOf<Route['procedure']['result']>, ValueOf<Route['procedure']['notification']>>
>;

/** The shared fetch and mapping of the requesters of one generated client. */
export interface IHTTPCaller {
  readonly call: (
    route: IHttpRouteInit,
    value: unknown,
    options?: IHTTPCallOptions
  ) => Promise<unknown>;
  readonly subscribe: (
    route: IHttpRouteInit,
    value: unknown,
    options?: IHTTPCallOptions
  ) => AsyncIterable<HTTPEvent<unknown, unknown>>;
}

const ENCODER = new TextEncoder();
const MAXIMUM_BODY_BYTES = LIMIT_DEFAULTS.maximumEnvelopeBytes;

const invalid = (detail: string): FailureError => {
  return new FailureError({
    code: ProtocolCode.PAYLOAD_UNDECODABLE,
    detail,
    scope: FailureScope.PROTOCOL,
    side: 'client',
  });
};

// A refusal without a Bead code is an HTTP error, never a fabricated application failure.
const failureOf = (bytes: Uint8Array): FailureError => {
  const problem = PAYLOAD_CODECS.json.decode(bytes) as {
    code?: unknown;
    scope?: unknown;
    detail?: unknown;
  } | null;

  if (
    typeof problem?.code !== 'number' ||
    !Number.isInteger(problem.code) ||
    problem.code < 1 ||
    problem.code > 65535 ||
    (problem.scope !== 'application' && problem.scope !== 'protocol') ||
    (problem.detail !== undefined && typeof problem.detail !== 'string')
  ) {
    throw invalid('the HTTP problem holds no Bead failure');
  }

  return new FailureError({
    code: problem.code,
    detail: typeof problem.detail === 'string' ? problem.detail : '',
    origin: 'peer',
    scope: problem.scope === 'application' ? FailureScope.APPLICATION : FailureScope.PROTOCOL,
  });
};

const mediaTypeOf = (payload: HttpPayload): string => {
  return payload === 'raw'
    ? 'application/octet-stream'
    : payload === 'text'
      ? 'text/plain'
      : 'application/json';
};

/** A fetch caller shared by the typed requesters of a generated HTTP client. */
export const createHTTPCaller = (
  routes: readonly IHttpRouteInit[],
  origin: string,
  options: IHTTPCallerOptions = {}
): IHTTPCaller => {
  const url = new URL(origin);

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/'
  ) {
    throw new ProgrammerError(
      'an HTTP client URL is an HTTP or HTTPS origin without user information'
    );
  }

  const maximum = options.maximumBodyBytes ?? MAXIMUM_BODY_BYTES;

  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new ProgrammerError('maximumBodyBytes is a whole number above 0');
  }

  const schemas = routes.flatMap((route) => {
    return [route.request, route.result, route.notification].filter((payload) => {
      return typeof payload === 'object';
    });
  });
  const registry = typeRegistryOf(schemas);
  const fetcher = options.fetch ?? globalThis.fetch;
  const read = (payload: HttpPayload, bytes: Uint8Array): unknown => {
    return typeof payload === 'string'
      ? PAYLOAD_CODECS[payload].decode(bytes)
      : readProtoJson(payload, { bytes, registry });
  };
  const eventValue = (payload: HttpPayload, data: string): unknown => {
    const bytes = ENCODER.encode(data);

    if (payload === 'text' || payload === 'raw') {
      const value = PAYLOAD_CODECS.json.decode(bytes);

      if (typeof value !== 'string') {
        throw invalid('an HTTP text or raw event holds a JSON string');
      }

      if (payload === 'text') {
        return value;
      }

      const raw = Uint8Array.from(atob(value), (character) => {
        return character.charCodeAt(0);
      });

      if (base64Of(raw) !== value) {
        throw invalid('an HTTP raw event holds standard padded base64');
      }

      return raw;
    }

    return read(payload, bytes);
  };
  const whole = async (response: Response): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let size = 0;

    if (response.body !== null) {
      const reader = response.body.getReader();

      try {
        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          size += chunk.value.length;

          if (size > maximum) {
            throw invalid('the HTTP body passes maximumBodyBytes');
          }

          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  };
  const send = async (
    route: IHttpRouteInit,
    value: unknown,
    given: IHTTPCallOptions & { stream?: boolean } = {}
  ): Promise<Response> => {
    const template = route.routes[0];

    if (
      template?.method !== 'POST' ||
      template.body !== '*' ||
      template.responseBody !== undefined ||
      template.template.includes('{')
    ) {
      throw new ProgrammerError(
        'an HTTP client calls a default POST route with a whole body and result'
      );
    }

    const target = new URL(template.template, url);
    const authorization =
      given.withoutAuthorization === true
        ? undefined
        : (given.authorization ?? options.authorization);

    if (target.origin !== url.origin) {
      throw new ProgrammerError('an HTTP route stays on its gateway origin');
    }

    if (authorization !== undefined && !isSecureUrl(target.href)) {
      throw new FailureError({
        code: ProtocolCode.DESTINATION_UNREACHABLE,
        scope: FailureScope.PROTOCOL,
        side: 'client',
      });
    }

    if (authorization !== undefined && /[^\t\x20-\x7e]/u.test(authorization)) {
      throw new ProgrammerError('Authorization is an HTTP field value');
    }

    const bytes = route.procedure.request.encode(value as never);
    const body =
      typeof route.request === 'string'
        ? bytes
        : ENCODER.encode(
            writeProtoJson(route.request, { message: fromBinary(route.request, bytes), registry })
          );
    const response = await fetcher(target.href, {
      method: 'POST',
      body: body as Uint8Array<ArrayBuffer>,
      headers: {
        'content-type': mediaTypeOf(route.request),
        accept: given.stream === true ? 'text/event-stream' : mediaTypeOf(route.result),
        ...(authorization === undefined ? {} : { authorization }),
      },
      redirect: 'manual',
      credentials: 'omit',
      ...(given.signal === undefined ? {} : { signal: given.signal }),
    });

    if (
      response.redirected ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw invalid('the HTTP client follows no redirect');
    }

    if (response.status !== 200) {
      const bytes_ = await whole(response);

      if (
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
        'application/problem+json'
      ) {
        throw failureOf(bytes_);
      }

      throw invalid(`the HTTP call answers ${String(response.status)} without a Bead problem`);
    }

    return response;
  };

  const call: IHTTPCaller['call'] = async (route, value, given?: IHTTPCallOptions) => {
    const response = await send(route, value, given);

    if (
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      mediaTypeOf(route.result)
    ) {
      await response.body?.cancel();
      throw invalid('the HTTP result has another media type');
    }

    return read(route.result, await whole(response));
  };
  const subscribe: IHTTPCaller['subscribe'] = async function* (
    route,
    value,
    given?: IHTTPCallOptions
  ) {
    if (route.notification === undefined) {
      throw new ProgrammerError('only a notifying HTTP procedure opens a stream');
    }

    const response = await send(route, value, { ...given, stream: true });

    if (
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'text/event-stream' ||
      response.body === null
    ) {
      await response.body?.cancel();
      throw invalid('the HTTP subscription answers no event stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let name = '';
    let data: string[] = [];
    let size = 0;
    let hasResult = false;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          throw invalid('the HTTP event stream ends without a failure');
        }

        buffered += decoder.decode(chunk.value, { stream: true });

        for (;;) {
          const end = buffered.search(/[\r\n]/u);

          if (end === -1 || (buffered[end] === '\r' && end === buffered.length - 1)) {
            break;
          }

          const line = buffered.slice(0, end);
          const width = buffered[end] === '\r' && buffered[end + 1] === '\n' ? 2 : 1;

          buffered = buffered.slice(end + width);
          size += ENCODER.encode(line).length;

          if (size > maximum) {
            throw invalid('the HTTP event passes maximumBodyBytes');
          }

          if (line === '') {
            if (data.length > 0) {
              const text = data.join('\n');

              if (name === 'failure') {
                throw failureOf(ENCODER.encode(text));
              }

              if (
                (!hasResult && name !== 'result') ||
                (hasResult && name !== '' && name !== 'message')
              ) {
                throw invalid('the HTTP event stream holds one result then notifications');
              }

              yield hasResult
                ? { kind: 'notification', value: eventValue(route.notification, text) }
                : { kind: 'result', value: eventValue(route.result, text) };
              hasResult = true;
            }

            data = [];
            name = '';
            size = 0;
          } else if (line.startsWith('event:')) {
            name = line.slice(6).replace(/^ /u, '');
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /u, ''));
          } else if (line.startsWith(':')) {
            size -= ENCODER.encode(line).length;
          }
        }

        if (size + ENCODER.encode(buffered).length > maximum) {
          throw invalid('the HTTP event passes maximumBodyBytes');
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };

  return Object.freeze({ call, subscribe });
};

/** A typed call of one route. */
export const httpRequesterOf = <Route extends IHttpRouteInit>(
  route: Route,
  caller: IHTTPCaller
): IHTTPRequester<Route> => {
  return (value, options) => {
    return caller.call(route, value, options) as Promise<ValueOf<Route['procedure']['result']>>;
  };
};

/** A typed subscription to one notifying route. */
export const httpSubscriberOf = <Route extends IHttpRouteInit>(
  route: Route,
  caller: IHTTPCaller
): IHTTPSubscriber<Route> => {
  return (value, options) => {
    return caller.subscribe(route, value, options) as ReturnType<IHTTPSubscriber<Route>>;
  };
};
