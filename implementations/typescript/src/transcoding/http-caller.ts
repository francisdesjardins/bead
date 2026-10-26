// ── HTTP caller ──────────────────────────────────────────────────────────────

// The client half of transcoding (decision 0037, design 3.17): default POST routes, Bead's own
// JSON mapping, problems as failures, and a fetch stream that carries its caller's authorization.

import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { GivenOf, ValueOf } from '../service/descriptors';
import { FailureScope, LIMIT_DEFAULTS, ProtocolCode } from '../router/shared/constants';
import { FailureError } from '../router/shared/errors';
import { PAYLOAD_CODECS } from '../router/shared/payloads';
import { ProgrammerError } from '../transport/shared/errors';
import { isFieldValue } from '../transport/client/transport-client';
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

const localFailure = (
  code: ProtocolCode,
  detail: string,
  options: { cause?: unknown } = {}
): FailureError => {
  return new FailureError(
    {
      code,
      detail,
      scope: FailureScope.PROTOCOL,
      side: 'client',
    },
    options
  );
};

const invalid = (detail: string, cause?: unknown): FailureError => {
  return localFailure(ProtocolCode.PAYLOAD_UNDECODABLE, detail, { cause });
};

// A gateway problem reads its own table backwards; an intermediary leaves the outcome unknown.
const statusCodeOf = (status: number, problem: boolean): ProtocolCode => {
  if (problem) {
    switch (status) {
      case 400:
      case 415:
        return ProtocolCode.PAYLOAD_UNDECODABLE;
      case 405:
      case 408:
        return ProtocolCode.DESTINATION_UNREACHABLE;
      case 422:
        return ProtocolCode.PAYLOAD_INVALID;
      case 431:
        return ProtocolCode.PAYLOAD_TOO_LARGE;
      case 501:
        return ProtocolCode.PROCEDURE_UNKNOWN;
    }
  }
  switch (status) {
    case 401:
      return ProtocolCode.SESSION_REQUIRED;
    case 403:
      return ProtocolCode.ACCESS_DENIED;
    case 404:
    case 503:
      return ProtocolCode.DESTINATION_UNREACHABLE;
    case 413:
      return ProtocolCode.PAYLOAD_TOO_LARGE;
    case 429:
      return ProtocolCode.CAPACITY_EXCEEDED;
    default:
      return ProtocolCode.DESTINATION_LOST;
  }
};

const statusFailure = (
  status: number,
  options: {
    refusal?: string | null | undefined;
    retry?: string | null | undefined;
    detail?: string | undefined;
    problem?: boolean;
  } = {}
): FailureError => {
  let code = statusCodeOf(status, options.problem === true);

  switch (options.refusal) {
    case undefined:
    case null:
      break;
    case 'busy':
      code = ProtocolCode.CAPACITY_EXCEEDED;
      break;
    case 'host-refused':
    case 'origin-refused':
      code = ProtocolCode.ACCESS_DENIED;
      break;
    case 'path-unknown':
    case 'method-refused':
      code = ProtocolCode.DESTINATION_UNREACHABLE;
      break;
    case 'too-large':
      code = ProtocolCode.PAYLOAD_TOO_LARGE;
      break;
    case 'malformed':
    case 'type-refused':
      code = ProtocolCode.PAYLOAD_UNDECODABLE;
      break;
    default:
      break;
  }

  const detail = `the HTTP call answers ${String(status)}${options.retry === undefined || options.retry === null ? '' : `; Retry-After: ${options.retry}`}${options.detail === undefined || options.detail === '' ? '' : `; ${options.detail}`}`;

  return new FailureError({ code, detail, origin: 'peer', scope: FailureScope.PROTOCOL });
};

const failureOf = (bytes: Uint8Array, response?: Response): FailureError => {
  let problem: {
    code?: unknown;
    scope?: unknown;
    detail?: unknown;
    status?: unknown;
  } | null;

  try {
    problem = PAYLOAD_CODECS.json.decode(bytes) as typeof problem;
  } catch (cause) {
    throw invalid('the HTTP payload cannot be decoded', cause);
  }

  if (
    problem !== null &&
    typeof problem === 'object' &&
    !Array.isArray(problem) &&
    problem.code === undefined &&
    problem.scope === undefined &&
    (problem.detail === undefined || typeof problem.detail === 'string')
  ) {
    const status = response?.status ?? problem.status;

    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return statusFailure(status, {
        refusal: response?.headers.get('bead-refusal'),
        retry: response?.headers.get('retry-after'),
        detail: problem.detail,
        problem: true,
      });
    }
  }

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
    url.hash !== ''
  ) {
    throw new ProgrammerError(
      'an HTTP client URL uses HTTP or HTTPS without user information, query or fragment'
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
  const bounded = (payload: HttpPayload, value: unknown): unknown => {
    const bytes =
      typeof payload === 'string'
        ? PAYLOAD_CODECS[payload].encode(value as never)
        : toBinary(payload, value as never);
    if (bytes.length > LIMIT_DEFAULTS.maximumEnvelopeBytes) {
      throw localFailure(
        ProtocolCode.PAYLOAD_TOO_LARGE,
        'the HTTP payload passes maximumEnvelopeBytes'
      );
    }
    return value;
  };
  const read = (payload: HttpPayload, bytes: Uint8Array): unknown => {
    try {
      return bounded(
        payload,
        typeof payload === 'string'
          ? PAYLOAD_CODECS[payload].decode(bytes)
          : readProtoJson(payload, { bytes, registry })
      );
    } catch (cause) {
      if (cause instanceof FailureError) {
        throw cause;
      }
      throw invalid('the HTTP payload cannot be decoded', cause);
    }
  };
  const eventValue = (payload: HttpPayload, data: string): unknown => {
    const bytes = ENCODER.encode(data);

    if (payload === 'text' || payload === 'raw') {
      let value: unknown;

      try {
        value = PAYLOAD_CODECS.json.decode(bytes);
      } catch (cause) {
        throw invalid('the HTTP payload cannot be decoded', cause);
      }

      if (typeof value !== 'string') {
        throw invalid('an HTTP text or raw event holds a JSON string');
      }

      if (payload === 'text') {
        return bounded(payload, value);
      }

      let raw: Uint8Array;

      try {
        raw = Uint8Array.from(atob(value), (character) => {
          return character.charCodeAt(0);
        });
      } catch (cause) {
        throw invalid('the HTTP payload cannot be decoded', cause);
      }

      if (base64Of(raw) !== value) {
        throw invalid('an HTTP raw event holds standard padded base64');
      }

      return bounded(payload, raw);
    }

    return read(payload, bytes);
  };
  const whole = async (response: Response, signal?: AbortSignal): Promise<Uint8Array> => {
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
            throw localFailure(
              ProtocolCode.PAYLOAD_TOO_LARGE,
              'the HTTP body passes maximumBodyBytes'
            );
          }

          chunks.push(chunk.value);
        }
      } catch (cause) {
        if (cause instanceof FailureError || signal?.aborted === true) {
          throw cause;
        }
        throw localFailure(ProtocolCode.DESTINATION_LOST, 'the HTTP body ends before its answer', {
          cause,
        });
      } finally {
        await reader.cancel().catch(() => {});
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

    const base = new URL(url);
    base.pathname = `${base.pathname.replace(/\/$/u, '')}/`;
    const target = new URL(template.template.replace(/^\//u, ''), base);
    const credential =
      given.withoutAuthorization === true
        ? undefined
        : (given.authorization ?? options.authorization);

    if (target.origin !== url.origin) {
      throw new ProgrammerError('an HTTP route stays on its gateway origin');
    }

    if (credential !== undefined && !isFieldValue(credential)) {
      throw new ProgrammerError(
        'a credential holds visible ASCII, spaces and tabs alone, none first or last'
      );
    }

    const authorization = credential === '' ? undefined : credential;

    if (authorization !== undefined && !isSecureUrl(target.href)) {
      throw new FailureError({
        code: ProtocolCode.DESTINATION_UNREACHABLE,
        scope: FailureScope.PROTOCOL,
        side: 'client',
      });
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
      credentials: 'same-origin',
      ...(given.signal === undefined ? {} : { signal: given.signal }),
    });

    if (
      response.redirected ||
      response.status === 0 ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw statusFailure(response.status, { retry: response.headers.get('retry-after') });
    }

    if (response.status !== 200) {
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ===
        'application/problem+json'
      ) {
        throw failureOf(await whole(response, given.signal), response);
      }

      await response.body?.cancel();
      throw statusFailure(response.status, { retry: response.headers.get('retry-after') });
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

    return read(route.result, await whole(response, given?.signal));
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
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let fragments: Uint8Array[] = [];
    let lineSize = 0;
    let firstLine = true;
    let skipLF = false;
    let name = '';
    let data: string[] = [];
    let size = 0;
    let hasResult = false;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          if (lineSize > 0) {
            const pending = new Uint8Array(lineSize);
            let offset = 0;
            for (const fragment of fragments) {
              pending.set(fragment, offset);
              offset += fragment.length;
            }
            try {
              decoder.decode(pending);
            } catch (cause) {
              throw invalid('the HTTP payload cannot be decoded', cause);
            }
          }
          throw localFailure(
            ProtocolCode.DESTINATION_LOST,
            'the HTTP event stream ends without a failure'
          );
        }

        let start = 0;

        for (let index = 0; index <= chunk.value.length; index += 1) {
          const octet = chunk.value[index];

          if (skipLF && index !== chunk.value.length) {
            skipLF = false;
            if (octet === 10) {
              start = index + 1;
              continue;
            }
          }

          if (index !== chunk.value.length && octet !== 10 && octet !== 13) {
            continue;
          }

          const fragment = chunk.value.subarray(start, index);
          if (fragment.length > 0) {
            fragments.push(fragment);
          }
          lineSize += fragment.length;
          size += fragment.length;

          if (size > maximum) {
            throw localFailure(
              ProtocolCode.PAYLOAD_TOO_LARGE,
              'the HTTP event passes maximumBodyBytes'
            );
          }
          if (index === chunk.value.length) {
            break;
          }

          const bytes = new Uint8Array(lineSize);
          let offset = 0;
          for (const part of fragments) {
            bytes.set(part, offset);
            offset += part.length;
          }
          let line: string;
          try {
            line = decoder.decode(bytes);
          } catch (cause) {
            throw invalid('the HTTP payload cannot be decoded', cause);
          }
          if (firstLine) {
            line = line.replace(/^\uFEFF/u, '');
            firstLine = false;
          }
          const length = lineSize;
          lineSize = 0;
          fragments = [];
          skipLF = octet === 13;
          start = index + 1;

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

              const payload = eventValue(hasResult ? route.notification : route.result, text);
              yield hasResult
                ? { kind: 'notification', value: payload }
                : { kind: 'result', value: payload };
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
            size -= length;
          }
        }
      }
    } catch (cause) {
      if (cause instanceof FailureError || given?.signal?.aborted === true) {
        throw cause;
      }
      throw localFailure(ProtocolCode.DESTINATION_LOST, 'the HTTP body ends before its answer', {
        cause,
      });
    } finally {
      await reader.cancel().catch(() => {});
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
