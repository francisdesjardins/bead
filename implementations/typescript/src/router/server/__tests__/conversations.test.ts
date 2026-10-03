// ── Conversations ─────────────────────────────────────────────────────────────

// Bead's conversations, `spec/conversations.json`, played against Bead's TypeScript server of the interop
// service: what its clients send, on one connection or on each a conversation opens, what the server
// sends back on each and reports. The C# server plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  INTEROP_SERVICE,
  type InteropServer,
  offerInterop,
  offerInteropClient,
} from '../../../../interop/offer';
import { createServer } from '../../../server/server';
import type { IServerTransportLike } from '../../../server/types';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createEmitter } from '../../../transport/shared/emitter';
import type { Data } from '../../../transport/shared/types';
import { bytesOf, readEnvelope } from '../../shared/envelope';
import type {
  Envelope,
  IProcedure,
  IServiceManager,
  RouterLimitsOptions,
  ServerConnectionHandle,
} from '../../shared/types';
import { fromHexadecimal } from '../../shared/__tests__/vectors';
import {
  CLIENT_FAILURES,
  EnvelopeKind,
  FailureError,
  SERVER_FAILURES,
  type PacingLimitsOptions,
} from '../router-server';

// interfaces

/** The next envelope a conversation expects the server to send. */
interface IExpected {
  callId: number;
  creditEnd?: number;
  isLast?: boolean;
  offset?: number;
  total?: number;
  session?: 'announced' | 'ended';
  failure?: { code: number; relays: number; scope: number };
  flags?: number | undefined;
  kind: number;
  payload?: string;
  procedureId?: number;
  serviceId?: number;
}

/** One step of a conversation: what the test does, or what the server does next, on its connection. */
interface IStep {
  close?: true;
  expect?: IExpected;
  on?: string;
  open?: string;
  report?: number | 'exception';
  send?: string;
  twoWay?: false;
}

/** What the server reported to its application, and the connection it came with. */
interface IReport {
  code: number | 'exception';
  connectionHandle: TransportServerConnectionHandle;
}

interface IConversation {
  limits?: RouterLimitsOptions;
  pacing?: PacingLimitsOptions;
  name: string;
  steps: IStep[];
}

// constants

const CONVERSATIONS = (
  JSON.parse(
    readFileSync(new URL('../../../../../../spec/conversations.json', import.meta.url), 'utf8')
  ) as { conversations: IConversation[] }
).conversations;

// the connection a conversation that opens none plays, opened before its first step
const ONLY_CONNECTION = 'client';

// helpers

/** Bytes as the conversations write them: hexadecimal, a space between bytes. */
const hexadecimalOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).toUpperCase().padStart(2, '0');
    })
    .join(' ');
};

/** What an answer announced of its connection's session: a token, its end, or nothing. */
const sessionOf = (envelope: Envelope): Pick<IExpected, 'session'> => {
  const { sessionToken } = envelope.header as { sessionToken?: string | null };

  if (sessionToken === undefined) {
    return {};
  }

  return { session: sessionToken === null ? 'ended' : 'announced' };
};

/** The bytes of an envelope sent, as a conversation writes what it expects. */
const expectedOf = (bytes: Uint8Array): IExpected | undefined => {
  const envelope = readEnvelope(bytes, {
    failures: CLIENT_FAILURES,
    maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
  });

  if (envelope === undefined) {
    return undefined;
  }

  const { callId } = envelope.header;

  if (envelope.kind === EnvelopeKind.FAILURE) {
    const { code, relays, scope } = envelope.failure;

    return {
      callId,
      failure: { code, relays, scope },
      kind: envelope.kind,
      ...sessionOf(envelope),
    };
  }

  if (envelope.kind === EnvelopeKind.RESULT || envelope.kind === EnvelopeKind.NOTIFICATION) {
    const { total } = envelope.header as { total?: number };

    return {
      callId,
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      ...sessionOf(envelope),
      ...(total === undefined ? {} : { total }),
    };
  }

  if (envelope.kind === EnvelopeKind.CHUNK) {
    const { isLast, offset } = envelope.header;

    return {
      callId,
      isLast,
      kind: envelope.kind,
      offset,
      payload: hexadecimalOf(envelope.payload),
    };
  }

  if (envelope.kind === EnvelopeKind.CREDIT) {
    return { callId, creditEnd: envelope.header.creditEnd, kind: envelope.kind };
  }

  // a command the server sends its client, its flags the byte after its kind
  if (envelope.kind === EnvelopeKind.REQUEST) {
    const { procedureId, serviceId } = envelope.header;

    return {
      callId,
      flags: bytes[2],
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      procedureId,
      serviceId,
    };
  }

  return { callId, kind: envelope.kind };
};

/**
 * A transport server of the connections a conversation names, each under a handle of its own that a
 * connection opened again under the same name takes: it records what it sends on each, and delivers
 * what it is given.
 */
const createConnections = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: TransportServerConnectionHandle];
    connection: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ];
    message: [data: Data, connectionHandle: TransportServerConnectionHandle];
  }>();
  const handles = new Map<string, TransportServerConnectionHandle>();
  const opened = new Set<TransportServerConnectionHandle>();
  const oneWay = new Set<TransportServerConnectionHandle>();
  const sent = new Map<TransportServerConnectionHandle, (IExpected | undefined)[]>();
  const handleOf = (name: string): TransportServerConnectionHandle => {
    const port = 50_001 + handles.size;
    const handle = handles.get(name) ?? (`type=WS;ip=127.0.0.1;port=${port}` as const);

    handles.set(name, handle);

    return handle;
  };
  const queueOf = (connectionHandle: TransportServerConnectionHandle) => {
    const queue = sent.get(connectionHandle) ?? [];

    sent.set(connectionHandle, queue);

    return queue;
  };
  const transport: IServerTransportLike = {
    close: () => {
      return Promise.resolve(false);
    },
    isTwoWay: (connectionHandle) => {
      return !oneWay.has(connectionHandle);
    },
    off: emitter.off,
    on: emitter.on,
    stop: () => {
      return Promise.resolve();
    },
    send: (data, connectionHandle) => {
      queueOf(connectionHandle).push(expectedOf(bytesOf(data)));

      return Promise.resolve();
    },
  };

  return {
    close: (name: string): void => {
      opened.delete(handleOf(name));
      emitter.emit('close', false, handleOf(name));
    },
    /** Closes every connection still open. */
    closeAll: (): void => {
      for (const handle of opened) {
        emitter.emit('close', false, handle);
      }

      opened.clear();
    },
    /** How many envelopes were sent and are not taken yet, on every connection. */
    count: (): number => {
      return [...sent.values()].reduce((total, queue) => {
        return total + queue.length;
      }, 0);
    },
    handleOf,
    message: (name: string, data: Data): void => {
      emitter.emit('message', data, handleOf(name));
    },
    /** The next envelope sent on the connection `name`. */
    next: (name: string): IExpected | undefined => {
      return queueOf(handleOf(name)).shift();
    },
    open: (name: string, { isTwoWay }: { isTwoWay: boolean }): void => {
      const handle = handleOf(name);

      if (isTwoWay) {
        oneWay.delete(handle);
      } else {
        oneWay.add(handle);
      }

      opened.add(handle);
      emitter.emit('connection', {}, {}, handle);
    },
    transport,
    /** What was sent and not taken yet, by the name of its connection. */
    untaken: (): Record<string, (IExpected | undefined)[]> => {
      const untaken: Record<string, (IExpected | undefined)[]> = {};

      for (const [name, handle] of handles) {
        const queue = sent.get(handle) ?? [];

        if (queue.length > 0) {
          untaken[name] = queue;
        }
      }

      return untaken;
    },
  };
};

/** Lets what the server does settle: turns of the event loop, until three in a row add nothing. */
const settle = async (count: () => number): Promise<void> => {
  let quiet = 0;
  let last = count();

  while (quiet < 3) {
    await new Promise(setImmediate);

    const now = count();

    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
};

/** A service manager that records the procedures given resolvers, and makes nothing else. */
const createRegistrations = <Handle extends string>() => {
  const names: string[] = [];
  const record = (procedure: IProcedure) => {
    names.push(procedure.procedureName);

    return () => {
      return undefined;
    };
  };
  const services = {
    getCommand: () => {
      return () => {
        return () => {
          return Promise.resolve();
        };
      };
    },
    getCommandResolver: record,
    getNotificationResolver: record,
    getRequestResolver: record,
  } as unknown as IServiceManager<Handle>;

  return { names, services };
};

// definition

test('every procedure of the interop manifest is offered, on the side it names', () => {
  const server = createRegistrations<TransportServerConnectionHandle>();
  const client = createRegistrations<ServerConnectionHandle>();
  const namesOf = (isOfferedByClient: boolean): string[] => {
    return INTEROP_SERVICE.procedures
      .filter(({ offeredBy }) => {
        return (offeredBy === 'client') === isOfferedByClient;
      })
      .map(({ procedureName }) => {
        return procedureName;
      })
      .toSorted();
  };

  offerInterop({
    requireSession: Object.assign(
      () => {
        return true;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    ),
    router: { failures: SERVER_FAILURES },
    services: server.services,
    sessions: {},
  } as unknown as InteropServer);
  offerInteropClient(client.services);

  expect(server.names.toSorted()).toEqual(namesOf(false));
  expect(client.names.toSorted()).toEqual(namesOf(true));
});

test.describe('the conversations', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  for (const { limits, name, pacing, steps } of CONVERSATIONS) {
    test(name, async () => {
      const connections = createConnections();
      const server = createServer<IServerTransportLike, string>(
        { transport: connections.transport },
        { limits, pacing }
      );
      const { router } = server;
      const reports: IReport[] = [];
      const count = (): number => {
        return connections.count() + reports.length;
      };
      // what the server did that its conversation did not expect: nothing, between steps
      const expectNothingMore = (when: string): void => {
        expect({ reports, sent: connections.untaken() }, when).toEqual({ reports: [], sent: {} });
      };

      router.on('error', (error, connectionHandle) => {
        reports.push({
          code: error instanceof FailureError ? error.code : 'exception',
          connectionHandle,
        });
      });
      offerInterop(server);

      if (
        steps.every((step) => {
          return step.open === undefined;
        })
      ) {
        connections.open(ONLY_CONNECTION, { isTwoWay: true });
      }

      try {
        for (const [index, step] of steps.entries()) {
          const at = `step ${String(index + 1)}`;
          const on = step.on ?? ONLY_CONNECTION;

          if (step.open !== undefined || step.send !== undefined || step.close === true) {
            expectNothingMore(`before ${at}`);
          }

          if (step.open !== undefined) {
            connections.open(step.open, { isTwoWay: step.twoWay !== false });
            await settle(count);
          }

          if (step.send !== undefined) {
            connections.message(on, fromHexadecimal(step.send));
            await settle(count);
          }

          if (step.close === true) {
            connections.close(on);
            await settle(count);
          }

          if (step.expect !== undefined) {
            expect(connections.next(on), at).toEqual(step.expect);
          }

          if (step.report !== undefined) {
            const report = reports.shift();

            expect(report?.code, at).toBe(step.report);

            if (step.on !== undefined) {
              expect(report?.connectionHandle, at).toBe(connections.handleOf(step.on));
            }
          }
        }

        expectNothingMore('at the end');
      } finally {
        connections.closeAll();
        await server[Symbol.asyncDispose]();
      }
    });
  }
});
