// ── Identities ────────────────────────────────────────────────────────────────

// Bead's identities, `spec/identities.json`, played against the TypeScript side: each name, each id
// and each procedure's kind declared by each of the ways the file lists, on a router of its own
// given no registry, and each fold through `areOneName`. The C# side plays the same file.

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

/** Declares a procedure one way and settles as the declaration does. */
type Declare = (procedure: IProcedure) => Promise<unknown>;

/** A router of its own, and a way of declaring on it. */
type Way = () => Disposable & { declare: Declare };

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

// what every way takes, declared after a refusal to show the refusal declared nothing
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

/**
 * The reason `thrown` refuses for, read back from this side's sentence; none for no refusal, and
 * its whole message for a sentence that gives none, so it never reads as taken.
 */
const reasonOf = (thrown: unknown): string | undefined => {
  if (thrown === undefined) {
    return undefined;
  }

  expect(thrown).toBeInstanceOf(ProgrammerError);

  const { message } = thrown as Error;

  return (
    REASONS.find((reason) => {
      // * the procedure named, then its reason after `is`, as the C# side words it
      return message.includes(` is ${reason}: `);
    }) ?? message
  );
};

/** A way of declaring on `router`, disposed with it. */
const wayOn = (router: Disposable, declare: Declare): Disposable & { declare: Declare } => {
  return {
    [Symbol.dispose]: () => {
      router[Symbol.dispose]();
    },
    declare,
  };
};

/** What `declare` throws or rejects with as it declares `procedure`; none when it is taken. */
const thrownBy = async (declare: Declare, procedure: IProcedure): Promise<unknown> => {
  try {
    await declare(procedure);
  } catch (error) {
    return error;
  }

  return undefined;
};

// the ways a side declares, by the file's ids
const WAYS: Readonly<Record<string, Way>> = Object.freeze({
  'client-notification': () => {
    const router = createRouterClient(clientTransport());

    return wayOn(router, async (procedure) => {
      await router.registerNotification({
        ...procedure,
        trigger: () => {
          return Promise.resolve([]);
        },
      });
    });
  },
  'client-requester': () => {
    const router = createRouterClient(clientTransport());

    return wayOn(router, (procedure) => {
      return Promise.resolve(router.declareRequester(procedure));
    });
  },
  'client-resolver': () => {
    const router = createRouterClient(clientTransport());

    return wayOn(router, (procedure) => {
      router.registerResolver(resolverOf(procedure));

      return Promise.resolve();
    });
  },
  'server-requester': () => {
    const router = createRouterServer(serverTransport());

    return wayOn(router, (procedure) => {
      return Promise.resolve(router.declareRequester(procedure));
    });
  },
  'server-notification-resolver': () => {
    const router = createRouterServer(serverTransport());

    return wayOn(router, (procedure) => {
      // a resolver that notifies, as a router tells one: its `notify` a function
      router.registerResolver(
        Object.assign(resolverOf(procedure), {
          notify: () => {
            return Promise.resolve();
          },
        })
      );

      return Promise.resolve();
    });
  },
  'server-resolver': () => {
    const router = createRouterServer(serverTransport());

    return wayOn(router, (procedure) => {
      router.registerResolver(resolverOf(procedure));

      return Promise.resolve();
    });
  },
});

/**
 * Declares `procedure` each way the file lists, each on a router of its own, and holds each to
 * `entry`'s outcome: refused at the ways its `refusedAt` lists, or at every way without one, and
 * taken at every other; a refused one declaring nothing, as `ECHO` taken after it shows.
 */
const expectEachWay = async (
  entry: IEntry & Pick<IProcedureKindEntry, 'refusedAt'>,
  procedure: IProcedure
): Promise<void> => {
  for (const id of IDENTITIES.ways) {
    using way = (WAYS[id] as Way)();
    const thrown = await thrownBy(way.declare, procedure);
    const isRefused = entry.refusedAt === undefined || entry.refusedAt.includes(id);

    expect(reasonOf(thrown), `${id}: ${String(thrown)}`).toBe(
      isRefused ? entry.refused : undefined
    );

    if (thrown !== undefined) {
      expect(await thrownBy(way.declare, ECHO), `${id}: echo, after its refusal`).toBeUndefined();
    }
  }
};

// definition

test.describe('the identities', () => {
  test.describe.configure({ retries: 0 });

  test('its table plays the ways the file lists, and no other', () => {
    expect(Object.keys(WAYS).toSorted()).toEqual(IDENTITIES.ways.toSorted());
  });

  test('plays every entry, none excused by a row of the matrix', () => {
    expect(
      [
        ...IDENTITIES.names,
        ...IDENTITIES.ids,
        ...IDENTITIES.procedureKinds,
        ...IDENTITIES.folds,
      ].filter(isExcused)
    ).toEqual([]);
  });

  for (const entry of IDENTITIES.names) {
    test(`names: ${entry.name}`, async () => {
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
    test(`ids: ${entry.name}`, async () => {
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
    test(`procedureKinds: ${entry.name}`, async () => {
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
    test(`folds: ${entry.name}`, () => {
      test.skip(isExcused(entry), 'a row of the matrix excuses this side');

      const [one, other] = entry.names;

      expect(areOneName(one, other)).toBe(entry.one);
      expect(areOneName(other, one)).toBe(entry.one);
    });
  }
});
