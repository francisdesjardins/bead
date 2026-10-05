import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { createRouterClient } from '../../client/router-client';
import { areOneName, checkDeclaration, IdentityRefusal, isProcedureName } from '../identity';
import { createMetricsRegistry } from '../metrics-registry';
import type { IProcedure } from '../types';

// helpers

const echo: IProcedure = {
  procedureId: 1,
  procedureName: 'echo',
  serviceId: 2,
  serviceRevision: 3,
};

/** The reason `procedure` is refused for, by how the refusal ends; none when it is taken. */
const reasonOf = (procedure: IProcedure): string | undefined => {
  try {
    checkDeclaration(procedure);
  } catch (error) {
    expect(error).toBeInstanceOf(ProgrammerError);

    return Object.values(IdentityRefusal).find((reason) => {
      return (error as Error).message.endsWith(`: ${reason}`);
    });
  }

  return undefined;
};

// definition

test.describe('checkDeclaration', () => {
  test('takes ids from 1 to 65535 and a revision from 1 to 2³¹ − 1, under a procedure name', () => {
    for (const procedure of [
      echo,
      { ...echo, procedureId: 0xffff, serviceId: 0xffff, serviceRevision: 2 ** 31 - 1 },
      { ...echo, procedureName: 'a'.repeat(63) },
      { ...echo, procedureName: 'getHTTPStatus2' },
    ]) {
      expect(reasonOf(procedure), JSON.stringify(procedure)).toBeUndefined();
    }
  });

  test('refuses an id or a revision out of its range, service 0 and revision 0 among them', () => {
    for (const procedure of [
      { serviceId: 0 },
      { procedureId: 0 },
      { serviceRevision: 0 },
      { serviceRevision: -1 },
      { serviceId: 0x10000 },
      { serviceRevision: 2 ** 31 },
    ]) {
      expect(reasonOf({ ...echo, ...procedure }), JSON.stringify(procedure)).toBe(
        IdentityRefusal.OUT_OF_ITS_RANGE
      );
    }
  });

  // * the twin of the row "An id or a revision no C# type holds": inputs a C# id never is
  test('refuses an id or a revision no C# type holds, out of its range', () => {
    const inputs = {
      procedureId: [65_536, -1, 1.5, '1', true, null],
      serviceId: [65_536, -1, 1.5, '1', true, null],
      serviceRevision: [2 ** 31, 1.5, '1', true, null],
    };

    for (const [field, given] of Object.entries(inputs)) {
      for (const input of given) {
        expect(reasonOf({ ...echo, [field]: input }), `${field} ${String(input)}`).toBe(
          IdentityRefusal.OUT_OF_ITS_RANGE
        );
      }
    }
  });

  test('refuses a name off its form, and refuses out of its range first', () => {
    for (const procedureName of ['', 'Echo', '_OTHER', 'a'.repeat(64), 'get_thing']) {
      expect(reasonOf({ ...echo, procedureName }), procedureName).toBe(
        IdentityRefusal.OFF_ITS_FORM
      );
    }

    expect(reasonOf({ ...echo, procedureName: 1 as unknown as string })).toBe(
      IdentityRefusal.OFF_ITS_FORM
    );
    expect(reasonOf({ ...echo, procedureName: 'Echo', serviceId: 0 })).toBe(
      IdentityRefusal.OUT_OF_ITS_RANGE
    );
  });

  test('says which ids, revision and name it was given', () => {
    expect(() => {
      checkDeclaration({ ...echo, serviceId: 0 });
    }).toThrow(
      new ProgrammerError(
        'a procedure is declared at a service and a procedure from 1 to 65535, of a revision from 1 to 2147483647, not at 0/1 of revision 3: out of its range'
      )
    );
    expect(() => {
      checkDeclaration({ ...echo, procedureName: '_OTHER' });
    }).toThrow(
      new ProgrammerError(
        `a procedure's name is a lower-case ASCII letter, then 62 ASCII letters and digits at most, not "_OTHER": off its form`
      )
    );
  });

  test('a declaration refused declares nothing, before its registry is asked', async () => {
    const registry = createMetricsRegistry();
    using router = createRouterClient(
      {
        off: () => {
          return undefined;
        },
        on: () => {
          return undefined;
        },
        send: () => {
          return Promise.resolve();
        },
      },
      { metricsRegistry: registry }
    );
    const before = registry.exposition().text;

    expect(() => {
      router.declareRequester({ ...echo, serviceRevision: 0 });
    }).toThrow(/: out of its range$/);
    await expect(
      router.registerNotification({
        ...echo,
        procedureName: 'Echo',
        trigger: () => {
          return Promise.resolve([]);
        },
      })
    ).rejects.toThrow(/: off its form$/);
    expect(registry.exposition().text).toBe(before);

    // the address it was refused at is free, under its name
    router.declareRequester(echo);

    expect(registry.exposition().text).not.toBe(before);
  });
});

test.describe('isProcedureName', () => {
  test('reads a name whole, a character at a time, never as a case mapping or a regular expression would', () => {
    const lineFeed = String.fromCharCode(0x0a);

    for (const name of [
      `echo${lineFeed}`,
      `${String.fromCharCode(0x212a)}elvin`,
      `${String.fromCharCode(0x17f)}tatus`,
      `${String.fromCharCode(0x130)}d`,
      `caf${String.fromCharCode(0xe9)}`,
      `${String.fromCharCode(0xfeff)}echo`,
      `echo${String.fromCharCode(0)}`,
      `echo${String.fromCharCode(0xd800)}`,
    ]) {
      expect(isProcedureName(name), JSON.stringify(name)).toBe(false);
    }

    expect(isProcedureName('x9')).toBe(true);
  });
});

test.describe('areOneName', () => {
  test('folds ASCII letters alone, character by character', () => {
    expect(areOneName('getHTTPStatus', 'getHttpStatus')).toBe(true);
    expect(areOneName('key', `${String.fromCharCode(0x212a)}ey`)).toBe(false);
    expect(areOneName(`caf${String.fromCharCode(0xe9)}`, `caf${String.fromCharCode(0xc9)}`)).toBe(
      false
    );
    expect(areOneName('a@', 'a`')).toBe(false);
    expect(areOneName('ab', 'abc')).toBe(false);
  });
});
