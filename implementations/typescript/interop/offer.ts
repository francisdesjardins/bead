// ── Interop service, offered ──────────────────────────────────────────────────

// The procedures of Bead's interop service, `spec/interop-service.json`, as Bead's TypeScript implementation offers them:
// what a client of any implementation calls, and what `spec/conversations.json` plays against.

// dependencies

import { existsSync, readFileSync } from 'node:fs';
import type {
  IBeforeRequest,
  IProcedure,
  IServiceManager,
  ServerConnectionHandle,
} from '../src/router/shared/types';
import type { IServer, IServerTransportLike } from '../src/server/types';
import type { TransportServerConnectionHandle } from '../src/transport/server/types';

// interfaces

/** The interop service, as its manifest names it. */
interface IInteropService {
  procedures: { offeredBy?: 'client'; procedureId: number; procedureName: string }[];
  serviceId: number;
  serviceRevision: number;
}

// constants

// the manifest, found up from this module, wherever a bundle put it
const MANIFEST = ((): URL => {
  for (let directory = new URL('./', import.meta.url); ; directory = new URL('../', directory)) {
    const candidate = new URL('spec/interop-service.json', directory);

    if (existsSync(candidate)) {
      return candidate;
    }

    if (new URL('../', directory).href === directory.href) {
      throw new Error('no spec/interop-service.json above this module');
    }
  }
})();

/** The manifest the interop servers of every implementation read. */
export const INTEROP_SERVICE = JSON.parse(readFileSync(MANIFEST, 'utf8')) as IInteropService;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What the interop service's payloads are: JSON, in UTF-8. What is not JSON throws. */
export const JSON_SERIALIZER = Object.freeze({
  decode: (bytes: Uint8Array): unknown => {
    return JSON.parse(decoder.decode(bytes));
  },
  encode: (value: unknown): Uint8Array => {
    return encoder.encode(JSON.stringify(value));
  },
});

// helpers

/** The procedure of the interop service named `procedureName`. */
export const procedureOf = (procedureName: string): IProcedure => {
  const found = INTEROP_SERVICE.procedures.find((procedure) => {
    return procedure.procedureName === procedureName;
  });

  if (found === undefined) {
    throw new Error(`the interop service has no procedure ${procedureName}`);
  }

  return {
    procedureId: found.procedureId,
    procedureName,
    serviceId: INTEROP_SERVICE.serviceId,
    serviceRevision: INTEROP_SERVICE.serviceRevision,
  };
};

// definition

/** A `ticks` answer held: the ticks it waits for still, and what lets it answer, then says it did. */
interface IHold {
  release: () => Promise<void>;
  remaining: number;
}

/** What `ticks` reads and writes, its notifications included: JSON, in UTF-8. */
export const JSON_NOTIFIED = Object.freeze({
  ...JSON_SERIALIZER,
  encodeNotification: JSON_SERIALIZER.encode,
});

/** The question `ask` puts to its client's `clock`, and how long it waits for the answer. */
const QUESTION = 'What time is it where you are?';
const CLOCK_MILLISECONDS = 10_000;

/** What the interop service needs of a server: its services, its failures, and its sessions. */
export type InteropServer = Pick<
  IServer<IServerTransportLike, string>,
  'requireSession' | 'router' | 'services' | 'sessions'
>;

/**
 * Registers the interop service's resolvers on `server`. The calls to `slow` each connection
 * cancelled are counted per connection, for `cancellations` to answer; a session holds the name its
 * `login` gave.
 */
export const offerInterop = (server: InteropServer): void => {
  const { requireSession, services, sessions } = server;
  const { failures } = server.router;
  const cancellations = new Map<TransportServerConnectionHandle, number>();
  // by connection, the ticks answers held, in the order they came
  const holds = new Map<TransportServerConnectionHandle, IHold[]>();
  const clock = services.getCommand(procedureOf('clock'), { serializer: JSON_SERIALIZER });
  const nobody: IBeforeRequest<TransportServerConnectionHandle> = Object.assign(
    () => {
      return false;
    },
    { refusal: { ...failures.accessDenied, detail: 'this procedure admits nobody' } }
  );

  services.getRequestResolver(procedureOf('echo'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      return response(request.payload);
    }
  );

  services.getRequestResolver(procedureOf('fail'), { serializer: JSON_SERIALIZER })(
    (_request, response) => {
      return response(null, { code: 7, detail: 'this procedure fails, on purpose' });
    }
  );

  // cancelled first, it answers all the same, an answer its router must not send
  services.getRequestResolver(procedureOf('slow'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const { milliseconds } = request.payload as { milliseconds: number };

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);

        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            cancellations.set(
              request.connectionHandle,
              (cancellations.get(request.connectionHandle) ?? 0) + 1
            );
            resolve(undefined);
          },
          { once: true }
        );
      });

      return response(milliseconds);
    }
  );

  services.getRequestResolver(procedureOf('cancellations'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      return response(cancellations.get(request.connectionHandle) ?? 0);
    }
  );

  services.getRequestResolver(procedureOf('denied'), {
    beforeRequest: nobody,
    serializer: JSON_SERIALIZER,
  })((_request, response) => {
    return response(null);
  });

  services.getRequestResolver(procedureOf('broken'), { serializer: JSON_SERIALIZER })(() => {
    throw new Error('this procedure breaks, on purpose');
  });

  services.getRequestResolver(procedureOf('bytes'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const { length } = request.payload as { length: number };

      return response('x'.repeat(length));
    }
  );

  // held, it subscribes its requester first, then answers once its ticks notified
  const ticks = services.getNotificationResolver(procedureOf('ticks'), {
    serializer: JSON_NOTIFIED,
  })(async (request, response) => {
    const { fail, hold } = (request.payload as { fail?: unknown; hold?: unknown } | null) ?? {};

    if (typeof hold !== 'number' || hold < 1) {
      return response(null);
    }

    response.registerNotification();

    const released = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<void>();
    const connectionHolds = holds.get(request.connectionHandle) ?? [];

    connectionHolds.push({
      release: () => {
        released.resolve();

        return answered.promise;
      },
      remaining: hold,
    });
    holds.set(request.connectionHandle, connectionHolds);
    await released.promise;

    try {
      await (fail === true
        ? response(null, { code: 7, detail: 'this procedure fails, on purpose' })
        : response(null));
    } finally {
      answered.resolve();
    }
  });

  // notifies its own connection, then lets the ticks it was the last for answer, before it does
  services.getRequestResolver(procedureOf('tick'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const { key, value } = request.payload as { key?: string; value: unknown };
      const { connectionHandle } = request;

      await ticks.notify(value, {
        filter: (handle) => {
          return handle === connectionHandle;
        },
        ...(key === undefined ? {} : { key }),
      });

      const due: IHold[] = [];
      const still: IHold[] = [];

      for (const held of holds.get(connectionHandle) ?? []) {
        held.remaining -= 1;
        (held.remaining === 0 ? due : still).push(held);
      }

      holds.set(connectionHandle, still);
      await Promise.all(
        due.map((held) => {
          return held.release();
        })
      );

      return response(null);
    }
  );

  // a new session each time, as the one it replaces ends: its token is drawn anew
  services.getRequestResolver(procedureOf('login'), { serializer: JSON_SERIALIZER })(
    (request, response) => {
      const { name } = request.payload as { name: string };

      sessions.set({ ...sessions.create(request.connectionHandle), data: name });

      return response(name);
    }
  );

  // ended before it answers, so its answer — or the failure ending a subscription — announces it
  services.getRequestResolver(procedureOf('logout'), {
    beforeRequest: requireSession,
    serializer: JSON_SERIALIZER,
  })((request, response) => {
    sessions.delete(request.connectionHandle);

    return response(null);
  });

  services.getRequestResolver(procedureOf('whoami'), {
    beforeRequest: requireSession,
    serializer: JSON_SERIALIZER,
  })((request, response) => {
    return response(sessions.get(request.connectionHandle)?.data ?? null);
  });

  // the server asks its client back, by a command, before it answers
  services.getRequestResolver(procedureOf('ask'), { serializer: JSON_SERIALIZER })(
    async (request, response) => {
      const time = await clock(QUESTION)({
        connectionHandle: request.connectionHandle,
        timeout: CLOCK_MILLISECONDS,
      });

      return response(time);
    }
  );
};

/** Registers what a client of the interop service offers its server: the `clock` command. */
export const offerInteropClient = (services: IServiceManager<ServerConnectionHandle>): void => {
  services.getCommandResolver(procedureOf('clock'), { serializer: JSON_SERIALIZER })(
    (_request, response) => {
      return response('noon');
    }
  );
};
