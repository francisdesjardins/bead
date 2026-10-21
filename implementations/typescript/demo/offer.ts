// ── Demo procedures, offered ──────────────────────────────────────────────────

// What the demo's servers answer, the same in Node and in a Web Worker: nothing here reads a file,
// a socket or `node:crypto`, so the worker's server offers what Node's does.

// dependencies

import type { IMetricsRegistry } from '../src/router/shared/metrics-registry';
import type { IAdmissionRequest, IBeforeRequest } from '../src/router/shared/types';
import type { IServer, IServerTransportLike } from '../src/server/types';
import type { TransportServerConnectionHandle } from '../src/transport/server/types';
import { SignUpServer } from './gen/typescript/demo/v1/sign_up_bead';
import { answererOf, askerOf, BURST_CHANGES, CALLS, NOTIFICATIONS, type Role } from './procedures';
import { drawGlyph } from './glyph';
import { issueToken } from './token';

// constants

/** How long the slow procedure takes, unless its call is cancelled first. */
const SLOW_MILLISECONDS = 5_000;

/**
 * How long a connection may stay silent before it is closed, whatever its calls present: a page that
 * stays reads the server's statistics, so only a page gone without a word — a tab closed before it
 * could say so — falls silent this long.
 */
export const SILENCE_MILLISECONDS = 120_000;

/** The code of the failures the demo's procedures answer with themselves: a role unknown, say. */
const REFUSED = 1;

// helpers

export const isRole = (value: string | null): value is Role => {
  return value === 'reader' || value === 'writer';
};

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  // what the router puts together stands on an ArrayBuffer of its own
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );

  return [...digest]
    .map((byte) => {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
};

// definition

let counter = 0;
// what tells each server's subscribers the counter changed, over whichever transport
const changes: ((value: string) => Promise<void>)[] = [];

// the counter one more, told at once to every subscriber of every server; what each telling
// resolves on
const increment = (): Promise<void>[] => {
  counter += 1;

  return changes.map((change) => {
    return change(String(counter));
  });
};

/**
 * The demo's procedures, and its sign-up service, on one server: each transport's server has its
 * own router, which verifies the token each call presents with the credentials it was given, so the
 * procedures are offered on each. `metricsRegistry` is the registry the server counts into, which `metrics` reads.
 */
export const offer = <Transport extends IServerTransportLike>(
  server: IServer<Transport>,
  metricsRegistry: IMetricsRegistry
): void => {
  const { router, services } = server;

  // a write needs a call whose session's scope holds `write`, its token's claims as the server
  // verified them, never its payload: in none, it is refused alike
  const requireWrite: IBeforeRequest<TransportServerConnectionHandle> = Object.assign(
    ({ session }: Pick<IAdmissionRequest<TransportServerConnectionHandle>, 'session'>) => {
      const scope = (session?.data as { scope?: unknown } | undefined)?.scope;

      return typeof scope === 'string' && scope.split(' ').includes('write');
    },
    {
      refusal: {
        ...router.failures.accessDenied,
        detail: 'a write needs a token whose scope holds write',
      },
    }
  );

  services.getRequestResolver(CALLS.whoami.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.whoami),
  })((request, response) => {
    return response(JSON.stringify({ claims: request.session?.data, end: request.session?.end }));
  });

  // ended by its identifier before the answer, so the subscriptions it bounds end first, each with
  // a failure; the token still holds, and a call that presents it again opens the session anew
  services.getRequestResolver(CALLS.logout.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.logout),
  })(async (request, response) => {
    const identifier = request.session?.identifier;

    if (identifier !== undefined) {
      await router.endSession(identifier);
    }

    return response('');
  });

  services.getRequestResolver(CALLS.read.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.read),
  })((_request, response) => {
    return response(String(counter));
  });

  const counterChanges = services.getNotificationResolver(CALLS.counter.procedure, {
    beforeRequest: server.requireSession,
    serializer: { ...answererOf(CALLS.counter), encodeNotification: NOTIFICATIONS.encode },
  })((_request, response) => {
    response.registerNotification();

    return response(String(counter));
  });

  // a signal carries nothing: its subscriber reads what changed
  const changedSignals = services.getNotificationResolver(CALLS.changed.procedure, {
    beforeRequest: server.requireSession,
    serializer: { ...answererOf(CALLS.changed), encodeNotification: NOTIFICATIONS.encode },
  })((_request, response) => {
    response.registerNotification();

    return response('');
  });

  changes.push(
    (value) => {
      // one key for the counter: queued for a paced subscriber, the latest replaces the others
      return counterChanges.notify(value, { key: 'counter' });
    },
    () => {
      return changedSignals.notify('');
    }
  );

  services.getRequestResolver(CALLS.increment.procedure, {
    beforeRequest: requireWrite,
    serializer: answererOf(CALLS.increment),
  })(async (_request, response) => {
    await Promise.all(increment());

    return response(String(counter));
  });

  // the changes made one after the other, before any is awaited, as a burst of a real system comes
  services.getRequestResolver(CALLS.burst.procedure, {
    beforeRequest: requireWrite,
    serializer: answererOf(CALLS.burst),
  })(async (_request, response) => {
    await Promise.all(
      Array.from({ length: BURST_CHANGES }, () => {
        return increment();
      }).flat()
    );

    return response(String(counter));
  });

  // refused at its opening when the session cannot write: over WebSocket, its bulk never crosses
  services.getRequestResolver(CALLS.upload.procedure, {
    beforeRequest: requireWrite,
    serializer: answererOf(CALLS.upload),
  })(async (request, response) => {
    return response(await digestOf(request.payload));
  });

  services.getRequestResolver(CALLS.download.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.download),
  })((_request, response) => {
    return response(drawGlyph());
  });

  // its call cancelled, it stops waiting, and its answer would go nowhere
  services.getRequestResolver(CALLS.slow.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.slow),
  })(async (request, response) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, SLOW_MILLISECONDS);

      request.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
        { once: true }
      );
    });

    return response(String(SLOW_MILLISECONDS));
  });

  // what a diagnosis reads, over the protocol itself, so a server in a worker answers it too: its
  // health, and what each layer holds
  services.getRequestResolver(CALLS.stats.procedure, {
    serializer: answererOf(CALLS.stats),
  })((_request, response) => {
    return response(JSON.stringify({ gauges: server.gauges(), health: server.health() }));
  });

  // what the registry holds, as a scrape reads it, over the protocol too: a server in a worker,
  // which no scraper reaches, answers it as Node's does
  services.getRequestResolver(CALLS.metrics.procedure, {
    serializer: answererOf(CALLS.metrics),
  })((_request, response) => {
    return response(metricsRegistry.exposition().text);
  });

  services.getRequestResolver(CALLS.fail.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.fail),
  })((_request, response) => {
    return response(null, { code: 7, detail: 'this procedure fails, on purpose' });
  });

  // the server asks the client back, by a command, before it answers
  const clock = services.getCommand(CALLS.clock.procedure, { serializer: askerOf(CALLS.clock) });

  services.getRequestResolver(CALLS.ask.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.ask),
  })(async (request, response) => {
    const time = await clock('What time is it where you are?')({
      connectionHandle: request.connectionHandle,
      timeout: 10_000,
    });

    return response(time);
  });

  // * the sign-up, a service beadc generated from proto/demo/v1/sign_up.proto: its request is held
  // to the rules of its .proto before its resolver, and one they refuse is answered PAYLOAD_INVALID,
  // its violations in its detail, without reaching it (spec 18)
  const signUp = new SignUpServer();

  signUp.on('signUp', (request, response) => {
    const { email, name, phone, seats } = request.payload;
    const held = `${String(seats)} seat${seats === 1 ? '' : 's'}`;

    return response({
      welcome: `welcome, ${name}: ${held} held, confirmed by ${email === '' ? `text to ${phone}` : `email to ${email}`}`,
    });
  });
  signUp.offer(server);
};

/**
 * The identity provider, as a procedure of its own for a server with no HTTP beside it — the one in
 * a worker: a role in, a token out, no session needed.
 */
export const offerIdentity = <Transport extends IServerTransportLike>(
  server: IServer<Transport>,
  key: Promise<CryptoKey>
): void => {
  server.services.getRequestResolver(CALLS.token.procedure, {
    serializer: answererOf(CALLS.token),
  })(async (request, response) => {
    return isRole(request.payload)
      ? response(await issueToken(request.payload, await key))
      : response(null, { code: REFUSED, detail: 'a role is reader or writer' });
  });
};
