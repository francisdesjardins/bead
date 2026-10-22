// ── Identities ────────────────────────────────────────────────────────────────

// Bead's identities, `spec/identities.json`, played against the TypeScript side: each name, id and
// kind declared by each way the file lists, a refused one declaring nothing, and each fold through
// `areOneName`, both ways. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { createRouterClient } from '../../client/router-client';
import type { IRouterClientTransportLike } from '../../client/types';
import { createRouterServer } from '../../server/router-server';
import type { IRouterServerTransportLike } from '../../server/types';
import { areOneName, IdentityRefusal } from '../identity';
import type { ProcedureKind } from '../constants';
import type { IProcedure, IRequestResolver } from '../types';

// interfaces

/** A row of `docs/support.md` an entry crosses, and the language it excuses. */
interface IDiffers {
  language: string;
  row: string;
}

/** What every entry holds: its name, the units it checks, and the reason it is refused for. */
interface IEntry {
  clauses: string[];
  differs?: IDiffers[];
  name: string;
  refused?: string;
}

/** A client's router and a server's, each of its own, which a way declares on. */
interface IRouters {
  client: ReturnType<typeof createRouterClient>;
  server: ReturnType<typeof createRouterServer>;
}

/** A procedure's name, declared at 1/1, revision 1. */
interface INameEntry extends IEntry {
  procedureName: string;
}

/** An address and a revision, each any JSON value, declared under `echo` or its own name. */
interface IIdEntry extends IEntry {
  procedureId: unknown;
  procedureName?: string;
  serviceId: unknown;
  serviceRevision: unknown;
}

/**
 * A procedure stating its kind, or none, declared at 1/1, revision 1, under `echo` unless the entry
 * gives its service or its name; refused at the ways `refusedAt` lists, or at every way without it.
 */
interface IProcedureKindEntry extends IEntry {
  procedureKind?: ProcedureKind;
  procedureName?: string;
  refusedAt?: string[];
  serviceId?: number;
}

/** Two names, and whether they are one. */
interface IFoldEntry extends IEntry {
  names: [string, string];
  one: boolean;
}

// types

/** Declares `procedure` one way, on `routers`, and settles as the declaration does. */
type Way = (routers: IRouters, procedure: IProcedure) => Promise<unknown>;

// constants

const IDENTITIES = JSON.parse(
  readFileSync(new URL('../../../../../../spec/identities.json', import.meta.url), 'utf8')
) as {
  folds: IFoldEntry[];
  ids: IIdEntry[];
  names: INameEntry[];
  procedureKinds: IProcedureKindEntry[];
  ways: string[];
};

const LANGUAGE = 'TypeScript';

// what a refused declaration leaves the router able to take: the procedure every ids entry is named
// under, at the address every names entry is declared at
const ECHO: IProcedure = Object.freeze({
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 1,
  serviceRevision: 1,
});

// each reason of the file, by how this side's refusal ends
const REASONS: readonly string[] = Object.values(IdentityRefusal);

// helpers

/** A client's transport that sends nothing anywhere: a declaration never sends. */
const clientTransport = (): IRouterClientTransportLike => {
  return {
    off: () => {
      return undefined;
    },
    on: () => {
      return undefined;
    },
    send: () => {
      return Promise.resolve();
    },
  };
};

/** A server's transport, likewise. */
const serverTransport = (): IRouterServerTransportLike => {
  return {
    off: () => {
      return undefined;
    },
    on: () => {
      return undefined;
    },
    send: () => {
      return Promise.resolve();
    },
  };
};

/** A resolver of `procedure` that answers nothing: a declaration never calls it. */
const resolverOf = <Handle extends string>(procedure: IProcedure): IRequestResolver<Handle> => {
  return Object.assign(() => {
    return Promise.resolve();
  }, procedure);
};

/** Whether a row of the matrix excuses this side from `entry`. */
const isExcused = (entry: IEntry): boolean => {
  return (entry.differs ?? []).some(({ language }) => {
    return language === LANGUAGE;
  });
};

/** The reason `thrown` refuses for, read back from this side's sentence; none for no refusal. */
const reasonOf = (thrown: unknown): string | undefined => {
  if (thrown === undefined) {
    return undefined;
  }

  expect(thrown).toBeInstanceOf(ProgrammerError);

  return REASONS.find((reason) => {
    return (thrown as Error).message.endsWith(`: ${reason}`);
  });
};

/** What `way` throws or rejects with as it declares `procedure` on `routers`; none when it is taken. */
const thrownBy = async (
  way: Way,
  { procedure, routers }: { procedure: IProcedure; routers: IRouters }
): Promise<unknown> => {
  try {
    await way(routers, procedure);
  } catch (error) {
    return error;
  }

  return undefined;
};

// the ways a side declares, by the file's ids
const WAYS: Readonly<Record<string, Way>> = Object.freeze({
  'client-notification': async ({ client }: IRouters, procedure: IProcedure) => {
    await client.registerNotification({
      ...procedure,
      trigger: () => {
        return Promise.resolve([]);
      },
    });
  },
  'client-requester': ({ client }: IRouters, procedure: IProcedure) => {
    return Promise.resolve(client.declareRequester(procedure));
  },
  'client-resolver': ({ client }: IRouters, procedure: IProcedure) => {
    client.registerResolver(resolverOf(procedure));

    return Promise.resolve();
  },
  'server-requester': ({ server }: IRouters, procedure: IProcedure) => {
    return Promise.resolve(server.declareRequester(procedure));
  },
  'server-notification-resolver': ({ server }: IRouters, procedure: IProcedure) => {
    // a resolver that notifies, as a router tells one: its `notify` a function
    server.registerResolver(
      Object.assign(resolverOf(procedure), {
        notify: () => {
          return Promise.resolve();
        },
      })
    );

    return Promise.resolve();
  },
  'server-resolver': ({ server }: IRouters, procedure: IProcedure) => {
    server.registerResolver(resolverOf(procedure));

    return Promise.resolve();
  },
});

/**
 * Declares `procedure` each way the file lists, each on routers of its own, and holds each to
 * `entry`'s outcome: refused at the ways its `refusedAt` lists, or at every way without one, and
 * then declaring nothing, the same way taking {@link ECHO}; taken at every other.
 */
const expectEachWay = async (
  entry: IEntry & Pick<IProcedureKindEntry, 'refusedAt'>,
  procedure: IProcedure
): Promise<void> => {
  for (const id of IDENTITIES.ways) {
    const way = WAYS[id] as Way;

    using client = createRouterClient(clientTransport());
    using server = createRouterServer(serverTransport());

    const routers = { client, server };
    const thrown = await thrownBy(way, { procedure, routers });
    const isRefused =
      entry.refused !== undefined &&
      (entry.refusedAt === undefined || entry.refusedAt.includes(id));

    expect(reasonOf(thrown), `${id}: ${String(thrown)}`).toBe(
      isRefused ? entry.refused : undefined
    );

    if (isRefused) {
      expect(
        await thrownBy(way, { procedure: ECHO, routers }),
        `${id}: ${ECHO.procedureName}`
      ).toBeUndefined();
    }
  }
};

// definition

test.describe('the identities', () => {
  test.describe.configure({ retries: 0 });

  test('its table declares every way the file names, and no other', () => {
    expect(Object.keys(WAYS).toSorted()).toEqual(IDENTITIES.ways.toSorted());
  });

  for (const entry of IDENTITIES.names) {
    test(`declares each name each way, taken or refused off its form, declaring nothing: ${entry.name}`, async () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      await expectEachWay(entry, {
        procedureId: 1,
        procedureName: entry.procedureName,
        serviceId: 1,
        serviceRevision: 1,
      });
    });
  }

  for (const entry of IDENTITIES.ids) {
    test(`declares each address and revision each way, taken or refused out of its range before off its form: ${entry.name}`, async () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      // as a value read from JSON may be: any, typed as the numbers a procedure's are
      await expectEachWay(entry, {
        procedureId: entry.procedureId as number,
        procedureName: entry.procedureName ?? 'echo',
        serviceId: entry.serviceId as number,
        serviceRevision: entry.serviceRevision as number,
      });
    });
  }

  for (const entry of IDENTITIES.procedureKinds) {
    test(`declares each procedure kind each way, taken or refused against its kind at the ways that do not take it, after its range and its form: ${entry.name}`, async () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      await expectEachWay(entry, {
        procedureId: 1,
        procedureName: entry.procedureName ?? 'echo',
        serviceId: entry.serviceId ?? 1,
        serviceRevision: 1,
        ...(entry.procedureKind === undefined ? {} : { procedureKind: entry.procedureKind }),
      });
    });
  }

  for (const entry of IDENTITIES.folds) {
    test(`reads two names as one when they are equal but for the case of their ASCII letters: ${entry.name}`, () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      const [one, other] = entry.names;

      expect(areOneName(one, other)).toBe(entry.one);
      expect(areOneName(other, one)).toBe(entry.one);
    });
  }
});
