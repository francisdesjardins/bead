// ── Conversations ─────────────────────────────────────────────────────────────

// Bead's conversations, `spec/conversations.json`, played against Bead's TypeScript server of the interop
// service: what its clients send, on one connection or on each a conversation opens, what the server
// sends back on each and reports. The C# server plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  INTEROP_API,
  INTEROP_SERVICE,
  interopCredentialsOf,
  interopVerifierOf,
  type InteropServer,
  issuerOf,
  JSON_SERIALIZER,
  offerInterop,
  offerInteropClient,
  procedureOf,
} from '../../../../interop/offer';
import { createTestClock, duesOn } from '../../../transport/shared/__tests__/fixtures';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createRouterClient } from '../../client/router-client';
import { createServiceManager } from '../../shared/service-manager';
import { ProcedureKind } from '../../shared/constants';
import { createPipedTransports } from '../../shared/__tests__/fixtures';
import type {
  IJwtSetKey,
  IProcedure,
  IServiceManager,
  ServerConnectionHandle,
} from '../../shared/types';
import { createRouterServer, SERVER_FAILURES } from '../router-server';
import { createSessionManager } from '../session-manager';
import { type IConversation, playConversation, WALL_CLOCK } from './conversation-player';

// constants

const { conversations: CONVERSATIONS } = JSON.parse(
  readFileSync(new URL('../../../../../../spec/conversations.json', import.meta.url), 'utf8')
) as { conversations: IConversation[] };

// helpers

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

test("every procedure of the interop service's API is offered, on the side its kind names", () => {
  const server = createRegistrations<TransportServerConnectionHandle>();
  const client = createRegistrations<ServerConnectionHandle>();
  const namesOf = (isCommand: boolean): string[] => {
    return INTEROP_API.procedures
      .filter(({ procedureKind }) => {
        return (procedureKind === ProcedureKind.COMMAND) === isCommand;
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

test("slow waits on its server's clock, which its router runs on, and answers once it has passed", async () => {
  const clock = createTestClock();
  const pipe = createPipedTransports({ connectionHandle: 'type=WS;ip=127.0.0.1;port=50001' });
  using router = createRouterServer(pipe.server, { clock });
  using sessions = createSessionManager<string>({ clock });
  using caller = createRouterClient(pipe.client);
  let answered: unknown;

  offerInterop({
    requireSession: Object.assign(
      () => {
        return true;
      },
      { refusal: SERVER_FAILURES.sessionRequired }
    ),
    router,
    services: createServiceManager(router),
    sessions,
  } as unknown as InteropServer);
  pipe.open();

  const slow = createServiceManager(caller)
    .getRequest(procedureOf('slow'), { serializer: JSON_SERIALIZER })({ milliseconds: 1_000 })()
    .then((payload) => {
      answered = payload;
    });

  await clock.tickAsync(999);

  expect(answered).toBeUndefined();

  await clock.tickAsync(1);
  await slow;

  expect(answered).toBe(1_000);
});

test('the interop service’s ELSEWHERE verifier holds, refuses and fails each value as its words say, at its time on its server’s clock', async () => {
  const clock = createTestClock(Date.parse(WALL_CLOCK));
  const verify = interopVerifierOf(clock);
  const letters = 'abcdefghijklmnopqrstuvwxyzabcdef';
  // a value, and what it settles with: its sub and its end, none, or a rejection; and after how long
  const rows: [string, unknown, number?][] = [
    ['Interop sub=ada', ['ada', undefined]],
    ['interop sub=ada', ['ada', undefined]],
    ['INTEROP sub=ada', ['ada', undefined]],
    ['Interop sub=a', ['a', undefined]],
    [`Interop sub=${letters}`, [letters, undefined]],
    [`Interop sub=${letters}a`, 'none'],
    ['Interop sub=Ada', 'none'],
    ['Interop  sub=ada', 'none'],
    ['Interop sub=ada,after=1', 'none'],
    ['Interop sub=ada, after=0', 'none'],
    ['Interop sub=ada, after=2147483647', ['ada', undefined], 2_147_483_647],
    ['Interop sub=ada, after=2147483648', 'none'],
    ['Interop sub=ada, end=9007199254740991', ['ada', 9_007_199_254_740_991]],
    ['Interop sub=ada, end=9007199254740992', 'none'],
    ['Interop sub=ada, end=1, after=1', 'none'],
    ['Interop sub=ada, SUB=x', 'none'],
    ['Interop fail=true', 'rejects'],
    ['Interop fail=true, after=5', 'rejects', 5],
    ['Interop fail=TRUE', 'none'],
    ['Interop sub=ada, fail=true', 'none'],
    ['Interop', 'none'],
    ['Interop ', 'none'],
    ['Bearer mF_9.B5f-4.1JqM', 'none'],
    ['Basic YWRh', 'none'],
  ];

  for (const [carried, expected, after] of rows) {
    let outcome: unknown = 'pending';

    void verify(carried).then(
      (session) => {
        outcome =
          session === undefined
            ? 'none'
            : [
                (session.data as { sub: string }).sub === session.id ? session.id : 'data?',
                session.end,
              ];
      },
      (reason: unknown) => {
        outcome =
          (reason as Error).message === 'this verifier fails, on purpose' ? 'rejects' : reason;
      }
    );

    if (after !== undefined) {
      await clock.tickAsync(after - 1);

      expect(outcome, `${carried}, a millisecond short`).toBe('pending');

      await clock.tickAsync(1);
    }

    await sleep(0);

    expect(outcome, carried).toEqual(expected);
  }
});

test("the interop service's key set answers each issuer it names as its words say, on its server's clock, whatever its signal, and fails at once for any other", async () => {
  const keysIssuer = 'https://keys.interop.bead.example';
  const rotatedIssuer = 'https://rotated.interop.bead.example';
  const stalledIssuer = 'https://stalled.interop.bead.example';
  const kidlessIssuer = 'https://kidless.interop.bead.example';
  const kid = '018c0ae5-4d9b-471b-bfd6-eef314bc7037';
  const second = 1_000;
  const clock = createTestClock();
  const keySet = interopCredentialsOf(clock).keySet!;
  // the signal of every ask, aborted before it goes
  const signal = AbortSignal.abort();
  // what each ask came to, in the order they went: its keys, or nothing yet
  const answers: (readonly IJwtSetKey[] | 'pending')[] = [];
  const ask = (issuer: string): Promise<readonly IJwtSetKey[]> => {
    const index = answers.push('pending') - 1;

    return Promise.resolve(keySet.ask(issuer, signal)).then((keys) => {
      answers[index] = keys;

      return keys;
    });
  };

  expect(keySet.issuers).toEqual([keysIssuer, rotatedIssuer, stalledIssuer, kidlessIssuer]);
  expect(keySet.maximumWaitingCalls).toBe(
    INTEROP_SERVICE.credentials.jwt.keySet.maximumWaitingCalls
  );
  expect(keySet.maximumWaitingCalls).toBe(2);

  // the rotated issuer's keys at its first ask alone; the stalled one's never, no timer armed; the
  // kid-less one's at every ask, its one key naming no kid
  const asked = [
    ask(keysIssuer),
    ask(rotatedIssuer),
    ask(rotatedIssuer),
    ask(kidlessIssuer),
    ask(kidlessIssuer),
  ];

  void ask(stalledIssuer);

  expect(duesOn(clock)).toEqual([second, second, second, second, second]);

  await clock.tickAsync(second - 1);

  expect(answers).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);

  await clock.tickAsync(1);

  const answered = await Promise.all(asked);

  expect(
    answered.map((keys) => {
      return keys.length;
    })
  ).toEqual([1, 1, 0, 1, 1]);
  expect([answered[0]?.[0]?.jwk.kid, answered[1]?.[0]?.jwk.kid]).toEqual([kid, kid]);
  expect(answered[0]?.[0]?.jwk.k).not.toBe(answered[1]?.[0]?.jwk.k);
  expect([answered[3]?.[0]?.jwk.kid, answered[3]?.[0]?.jwk.k]).toEqual([
    undefined,
    answered[0]?.[0]?.jwk.k,
  ]);
  expect(answers[5]).toBe('pending');
  expect(duesOn(clock)).toEqual([]);

  // its asks counted per key set built: another server's answers its first anew
  const another = interopCredentialsOf(clock).keySet!.ask(rotatedIssuer, signal);

  await clock.tickAsync(second);

  expect(await another).toHaveLength(1);

  // asked for an issuer it does not name, it fails at once, its clock unmoved and no timer armed
  let failure: unknown = 'pending';

  void Promise.resolve(keySet.ask('https://unnamed.interop.bead.example', signal)).catch(
    (reason: unknown) => {
      failure = (reason as Error).message;
    }
  );
  await sleep(0);

  expect(duesOn(clock)).toEqual([]);
  expect(failure).toBe(
    'the interop key set answers for no issuer https://unnamed.interop.bead.example'
  );
});

test('the interop service’s endSessionsOf takes an issuer alone, a string, and throws for anything else', () => {
  expect(issuerOf({ issuer: 'https://hs256.interop.bead.example' })).toBe(
    'https://hs256.interop.bead.example'
  );
  expect(issuerOf({ issuer: '' })).toBe('');

  for (const request of [
    null,
    undefined,
    7,
    'https://hs256.interop.bead.example',
    ['https://hs256.interop.bead.example'],
    {},
    { issuer: 7 },
    { issuer: null },
    { issuer: 'https://hs256.interop.bead.example', sub: 'grace' },
    { iss: 'https://hs256.interop.bead.example' },
  ]) {
    expect(() => {
      return issuerOf(request);
    }, JSON.stringify(request)).toThrow(
      'endSessionsOf names an issuer by {"issuer"} alone, a string'
    );
  }
});

test.describe('the conversations', () => {
  // played once, as the C# side plays them: a retry would hide what fails there
  test.describe.configure({ retries: 0 });

  for (const conversation of CONVERSATIONS) {
    test(conversation.name, async () => {
      await playConversation(conversation, {});
    });
  }
});
