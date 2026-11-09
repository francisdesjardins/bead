import { expect, test } from '@playwright/test';
import type { IProcedureAddress } from '../../../../router/shared/types';
import { ProgrammerError } from '../../../shared/errors';
import { proceduresTakenOf, takingOf } from '../procedures-taken';

// definition

test.describe('proceduresTakenOf', () => {
  // spec 9.11
  test('gives nothing for no list, and for a list what it names, each address once', () => {
    const taken = proceduresTakenOf(
      [
        { procedureId: 1, serviceId: 2 },
        { procedureId: 1, serviceId: 2 },
        { procedureId: 65_535, serviceId: 65_535 },
      ],
      'a transport'
    );

    expect(proceduresTakenOf(undefined, 'a transport')).toBeUndefined();
    expect(
      [
        { procedureId: 1, serviceId: 2 },
        { procedureId: 65_535, serviceId: 65_535 },
        { procedureId: 2, serviceId: 1 },
        { procedureId: 2, serviceId: 2 },
      ].map((address) => {
        return taken?.has(address);
      })
    ).toEqual([true, true, false, false]);
    expect(proceduresTakenOf([], 'a transport')?.has({ procedureId: 1, serviceId: 1 })).toBe(false);
  });

  // spec 9.12, 16.2, 16.3
  test('refuses an address out of its range, naming the transport and the address, and a list that is no array', () => {
    expect(() => {
      return proceduresTakenOf([{ procedureId: 7, serviceId: 0 }], 'a transport');
    }).toThrow(
      new ProgrammerError(
        "a transport takes 0/7, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3)"
      )
    );
    expect(() => {
      return proceduresTakenOf([null] as unknown as IProcedureAddress[], 'a transport');
    }).toThrow(
      new ProgrammerError(
        "a transport takes undefined/undefined, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3)"
      )
    );
    expect(() => {
      return proceduresTakenOf(
        { procedureId: 1, serviceId: 2 } as unknown as IProcedureAddress[],
        'a transport'
      );
    }).toThrow(new ProgrammerError('a transport takes its procedures as a list of addresses'));
  });
});

test.describe('takingOf', () => {
  test('gives a takesProcedure by its one list whatever the connection, and none for no list', () => {
    const { takesProcedure } = takingOf([{ procedureId: 1, serviceId: 2 }], 'a transport');

    expect(takingOf(undefined, 'a transport')).toEqual({});
    expect([
      takesProcedure?.('type=WS;ip=127.0.0.1;port=1;ordinal=1', { procedureId: 1, serviceId: 2 }),
      takesProcedure?.('type=HTTP;ip=127.0.0.1;ordinal=9', { procedureId: 1, serviceId: 2 }),
      takesProcedure?.('type=WS;ip=127.0.0.1;port=1;ordinal=1', { procedureId: 2, serviceId: 2 }),
    ]).toEqual([true, true, false]);
  });
});
