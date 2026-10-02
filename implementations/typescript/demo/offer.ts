// ── Demo procedures, offered ──────────────────────────────────────────────────

// What the demo's servers answer, the same in Node and in a Web Worker: nothing here reads a file,
// a socket or `node:crypto`, so the worker's server offers what Node's does.

// dependencies

import { createDebugStatistics, filterDebug } from '../src/router/shared/service-manager';
import type { IBeforeRequest } from '../src/router/shared/types';
import type { IServer, IServerTransportLike } from '../src/server/types';
import type { TransportServerConnectionHandle } from '../src/transport/server/types';
import {
  answererOf,
  askerOf,
  BURST_CHANGES,
  CALLS,
  type IClaims,
  NOTIFICATIONS,
  type Role,
} from './procedures';
import { drawGlyph } from './glyph';
import { issueToken, verifyToken } from './token';

// constants

/** How long the slow procedure takes, unless its call is cancelled first. */
const SLOW_MILLISECONDS = 5_000;

/**
 * How long a connection may stay silent before it is closed, with a session or without: a page that
 * stays reads the server's statistics, so only a page gone without a word — a tab closed before it
 * could say so — falls silent this long.
 */
export const SILENCE_MILLISECONDS = 120_000;

/** The code of the failures the demo's procedures answer with themselves: a login refused, say. */
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
 * The demo's procedures, on one server: each transport's server has its own router and sessions, so
 * a login over HTTP opens no session over WebSocket, and the procedures are offered on each.
 */
export const offer = <Transport extends IServerTransportLike>(
  server: IServer<Transport, IClaims>,
  key: Promise<CryptoKey>
): void => {
  const { services, sessions } = server;
  // how long this server took to answer its last calls, those that read the statistics aside
  const statistics = createDebugStatistics();

  services.on('debug', filterDebug(statistics.listener, 'd(tx), -stats'));

  // a write needs a session that holds the write permission: without a session, it is refused alike
  const requireWrite: IBeforeRequest<TransportServerConnectionHandle> = Object.assign(
    ({ connectionHandle }: { connectionHandle: TransportServerConnectionHandle }) => {
      return sessions.get(connectionHandle)?.data?.permissions.includes('write') === true;
    },
    {
      refusal: {
        ...server.router.failures.accessDenied,
        detail: 'a write needs a session that holds the write permission',
      },
    }
  );

  // the token checked, its claims kept in a session of the connection: the session has no timeout,
  // so the demo waits for its reader, and its connection is closed only once gone silent
  services.getRequestResolver(CALLS.login.procedure, { serializer: answererOf(CALLS.login) })(
    async (request, response) => {
      const verified = await verifyToken(request.payload, await key);

      if ('refusal' in verified) {
        return response(null, { code: REFUSED, detail: verified.refusal });
      }

      sessions.set({
        ...sessions.create(request.connectionHandle),
        connectionInactivityTimeout: SILENCE_MILLISECONDS,
        data: verified,
        sessionInactivityTimeout: Infinity,
      });

      return response(JSON.stringify(verified));
    }
  );

  // deleted before the answer, so the answer announces the session's end
  services.getRequestResolver(CALLS.logout.procedure, {
    beforeRequest: server.requireSession,
    serializer: answererOf(CALLS.logout),
  })((request, response) => {
    sessions.delete(request.connectionHandle);

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

  // what a diagnosis reads, over the protocol itself, so a server in a worker answers it too
  services.getRequestResolver(CALLS.stats.procedure, {
    serializer: answererOf(CALLS.stats),
  })((_request, response) => {
    return response(
      JSON.stringify({
        durations: statistics.durations(),
        gauges: server.gauges(),
        health: server.health(),
      })
    );
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
};

/**
 * The identity provider, as a procedure of its own for a server with no HTTP beside it — the one in
 * a worker: a role in, a token out, no session needed.
 */
export const offerIdentity = <Transport extends IServerTransportLike>(
  server: IServer<Transport, IClaims>,
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
