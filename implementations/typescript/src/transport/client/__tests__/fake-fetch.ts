import type { FetchLike, IFetchInit, IFetchResponseLike } from '../http-transport-client';

/**
 * A `fetch` a test scripts by hand, for what a real server does not do on demand: a network that
 * fails, a 404 from something on the way, an answer of the wrong type or too large, a page's opaque
 * redirect, a fetch that followed one, a fetch that settles synchronously. Each call waits on the
 * answer its test gives, or on its signal.
 */

export interface IFakeCall {
  readonly init: IFetchInit;
  readonly url: string;
  /** Settles the call with a response of `status`, its headers and its body. */
  answer(response: {
    body?: Uint8Array;
    headers?: Record<string, string>;
    /** None at all, as a 204's. */
    isBodiless?: boolean;
    /** Its body never comes whole: reading it fails. */
    isBodyLost?: boolean;
    /** Its body, once this settles: the head comes first. */
    later?: Promise<Uint8Array>;
    /** Called when the response body is read. */
    onRead?: () => void;
    /** Its body as a stream reads it, piece by piece; an error cuts it there. */
    pieces?: readonly (Error | Uint8Array)[];
    /** It says its fetch followed a redirect, as one given may all the same. */
    redirected?: boolean;
    status: number;
  }): void;
  /** Settles the call as a network that failed. */
  fail(reason?: unknown): void;
}

export const responseOf = ({
  body = new Uint8Array(0),
  headers = {},
  isBodiless = false,
  isBodyLost = false,
  later,
  onRead,
  pieces,
  redirected,
  status,
}: {
  body?: Uint8Array;
  headers?: Record<string, string>;
  isBodiless?: boolean;
  isBodyLost?: boolean;
  later?: Promise<Uint8Array>;
  onRead?: () => void;
  pieces?: readonly (Error | Uint8Array)[];
  redirected?: boolean;
  status: number;
}): IFetchResponseLike => {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => {
      return [name.toLowerCase(), value];
    })
  );

  // what a listen reads, a piece each time it reads — the pieces, or the whole body once it comes —
  // so an error cuts the body after what was read, not before
  let queue: (Error | Uint8Array)[] | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        onRead?.();
        if (isBodyLost) {
          return (controller.error(new TypeError('terminated')), undefined);
        }

        queue ??= [...(pieces ?? [await (later ?? Promise.resolve(body))])];

        const piece = queue.shift();

        if (piece === undefined) {
          return (controller.close(), undefined);
        }

        if (piece instanceof Error) {
          return (controller.error(piece), undefined);
        }

        return (controller.enqueue(piece.slice()), undefined);
      },
    },
    { highWaterMark: 0 }
  );

  return {
    arrayBuffer: () => {
      onRead?.();
      if (isBodyLost) {
        return Promise.reject(new TypeError('terminated'));
      }

      return (later ?? Promise.resolve(body)).then((bytes) => {
        return bytes.slice().buffer;
      });
    },
    headers: {
      get: (name) => {
        return lower.get(name.toLowerCase()) ?? null;
      },
    },
    body: isBodiless || status === 204 ? null : stream,
    ok: status >= 200 && status < 300,
    redirected,
    status,
  };
};

/** `respond` answers every call at once, as a fetch that settles synchronously would. */
export const createFakeFetch = (respond?: (init: IFetchInit) => IFetchResponseLike) => {
  const calls: IFakeCall[] = [];

  const fetch: FetchLike = (url, init) => {
    if (respond !== undefined) {
      calls.push({ answer: () => {}, fail: () => {}, init, url });

      return Promise.resolve(respond(init));
    }

    const { promise, reject, resolve } = Promise.withResolvers<IFetchResponseLike>();

    init.signal?.addEventListener(
      'abort',
      () => {
        reject(new Error('aborted'));
      },
      { once: true }
    );
    calls.push({
      answer: (response) => {
        resolve(responseOf(response));
      },
      fail: (reason = new TypeError('fetch failed')) => {
        reject(reason);
      },
      init,
      url,
    });

    return promise;
  };

  return { calls, fetch };
};
