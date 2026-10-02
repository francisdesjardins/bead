// ── Conversations ─────────────────────────────────────────────────────────────

// Bead's conversations, `spec/conversations.json`, played against Bead's TypeScript server of the interop
// service: what one client sends, what the server sends back and reports. The C# server plays the
// same file.

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
interface IExpectedOut {
  callId: number;
  creditEnd?: number;
  isLast?: boolean;
  offset?: number;
  total?: number;
  session?: 'announced' | 'ended';
  failure?: { code: number; scope: number };
  kind: number;
  payload?: string;
  procedureId?: number;
  serviceId?: number;
}

/** One step of a conversation. */
interface IStep {
  close?: true;
  in?: string;
  out?: IExpectedOut;
  report?: number | 'exception';
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

const HANDLE: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001';

// helpers

/** A transport server of one connection, which records what it sends and delivers what it is given. */
const createConnection = () => {
  const emitter = createEmitter<{
    close: [wasClean: boolean, connectionHandle: TransportServerConnectionHandle];
    connection: [
      socket: unknown,
      request: unknown,
      connectionHandle: TransportServerConnectionHandle,
    ];
    message: [data: Data, connectionHandle: TransportServerConnectionHandle];
  }>();
  const sent: (Envelope | undefined)[] = [];
  const transport: IServerTransportLike = {
    close: () => {
      return Promise.resolve(false);
    },
    off: emitter.off,
    on: emitter.on,
    stop: () => {
      return Promise.resolve();
    },
    send: (data) => {
      sent.push(
        readEnvelope(bytesOf(data), {
          failures: CLIENT_FAILURES,
          maximumEnvelopeBytes: Number.MAX_SAFE_INTEGER,
        })
      );

      return Promise.resolve();
    },
  };

  return { emitter, sent, transport };
};

/** Bytes as the conversations write them: hexadecimal, a space between bytes. */
const hexadecimalOf = (bytes: Uint8Array): string => {
  return [...bytes]
    .map((byte) => {
      return byte.toString(16).toUpperCase().padStart(2, '0');
    })
    .join(' ');
};

/** What an answer announced of its connection's session: a token, its end, or nothing. */
const sessionOf = (envelope: Envelope): Pick<IExpectedOut, 'session'> => {
  const { sessionToken } = envelope.header as { sessionToken?: string | null };

  if (sessionToken === undefined) {
    return {};
  }

  return { session: sessionToken === null ? 'ended' : 'announced' };
};

/** An envelope sent, as a conversation writes what it expects. */
const outOf = (envelope: Envelope | undefined): IExpectedOut | undefined => {
  if (envelope === undefined) {
    return undefined;
  }

  const { callId } = envelope.header;

  if (envelope.kind === EnvelopeKind.FAILURE) {
    const { code, scope } = envelope.failure;

    return { callId, failure: { code, scope }, kind: envelope.kind, ...sessionOf(envelope) };
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

  // a command the server sends its client
  if (envelope.kind === EnvelopeKind.REQUEST) {
    const { procedureId, serviceId } = envelope.header;

    return {
      callId,
      kind: envelope.kind,
      payload: hexadecimalOf(envelope.payload),
      procedureId,
      serviceId,
    };
  }

  return { callId, kind: envelope.kind };
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
  for (const { limits, name, pacing, steps } of CONVERSATIONS) {
    test(name, async () => {
      const { emitter, sent, transport } = createConnection();
      const server = createServer<IServerTransportLike, string>({ transport }, { limits, pacing });
      const { router } = server;
      const reports: (number | 'exception')[] = [];
      const count = (): number => {
        return sent.length + reports.length;
      };
      let isOpen = true;

      router.on('error', (error) => {
        reports.push(error instanceof FailureError ? error.code : 'exception');
      });
      offerInterop(server);
      emitter.emit('connection', {}, {}, HANDLE);

      try {
        for (const step of steps) {
          if (step.in !== undefined || step.close === true) {
            expect({ reports, sent: sent.map(outOf) }).toEqual({ reports: [], sent: [] });
          }

          if (step.in !== undefined) {
            emitter.emit('message', fromHexadecimal(step.in), HANDLE);
            await settle(count);
          }

          if (step.close === true) {
            isOpen = false;
            emitter.emit('close', false, HANDLE);
            await settle(count);
          }

          if (step.out !== undefined) {
            expect(outOf(sent.shift())).toEqual(step.out);
          }

          if (step.report !== undefined) {
            expect(reports.shift()).toBe(step.report);
          }
        }

        expect({ reports, sent: sent.map(outOf) }).toEqual({ reports: [], sent: [] });
      } finally {
        if (isOpen) {
          emitter.emit('close', false, HANDLE);
        }

        await server[Symbol.asyncDispose]();
      }
    });
  }
});
