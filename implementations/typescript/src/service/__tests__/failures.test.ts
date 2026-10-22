import { expect, test } from '@playwright/test';
import { FailureScope } from '../../router/shared/constants';
import { FailureError } from '../../router/shared/errors';
import { ProgrammerError } from '../../transport/shared/errors';
import { failuresOf } from '../failures';
import type { IListedFailureError } from '../failures';

// helpers

/** An application failure received from procedure 1 of `serviceId`, of `code`. */
const receivedOf = (code: number, serviceId: number): FailureError => {
  return new FailureError(
    { code, scope: FailureScope.APPLICATION },
    { procedureAddress: { procedureId: 1, serviceId } }
  );
};

// definition

test.describe('failuresOf', () => {
  test('makes a failure of a name, its code and its detail', () => {
    const catalogue = failuresOf({ codes: { NOBODY_TO_GREET: 1, TOO_LOUD: 2 }, serviceId: 7 });

    expect(catalogue.of('TOO_LOUD', 'quieter')).toEqual({
      code: 2,
      detail: 'quieter',
      failureName: 'TOO_LOUD',
    });
    expect(catalogue.of('NOBODY_TO_GREET')).toEqual({
      code: 1,
      detail: '',
      failureName: 'NOBODY_TO_GREET',
    });
    expect(Object.isFrozen(catalogue.of('TOO_LOUD'))).toBe(true);
    expect(catalogue.codes).toEqual({ NOBODY_TO_GREET: 1, TOO_LOUD: 2 });
    // past the types, a name the catalogue lacks
    expect(() => {
      return catalogue.of('TOSTRING' as never);
    }).toThrow(ProgrammerError);
    expect(() => {
      return catalogue.of('toString' as never);
    }).toThrow(ProgrammerError);
  });

  test('refuses a code outside 1 to 65535, and two names of one code', () => {
    for (const code of [0, 65_536, -1, 1.5, Number.NaN]) {
      expect(() => {
        return failuresOf({ codes: { WRONG: code }, serviceId: 7 });
      }, String(code)).toThrow(ProgrammerError);
    }

    expect(() => {
      return failuresOf({ codes: { FIRST: 3, SECOND: 3 }, serviceId: 7 });
    }).toThrow(ProgrammerError);
    expect(failuresOf({ codes: { LAST: 65_535 }, serviceId: 7 }).codes.LAST).toBe(65_535);
  });

  test('refuses a service outside 1 to 65535', () => {
    for (const serviceId of [0, 65_536, -1, 1.5, Number.NaN]) {
      expect(() => {
        return failuresOf({ codes: { WRONG: 1 }, serviceId });
      }, String(serviceId)).toThrow(ProgrammerError);
    }

    expect(failuresOf({ codes: { LAST: 1 }, serviceId: 65_535 }).serviceId).toBe(65_535);
  });

  test('tells a failure of its service by its name, and none of another service', () => {
    const catalogue = failuresOf({ codes: { NOBODY_TO_GREET: 1, TOO_LOUD: 2 }, serviceId: 7 });

    expect(catalogue.is(receivedOf(1, 7), 'NOBODY_TO_GREET')).toBe(true);
    expect(catalogue.is(receivedOf(1, 7), 'TOO_LOUD')).toBe(false);
    expect(catalogue.is(receivedOf(1, 8), 'NOBODY_TO_GREET')).toBe(false);
    // the protocol's code 1, ENVELOPE_MALFORMED, is no failure of a catalogue
    expect(
      catalogue.is(
        new FailureError(
          { code: 1, scope: FailureScope.PROTOCOL },
          { procedureAddress: { procedureId: 1, serviceId: 7 } }
        ),
        'NOBODY_TO_GREET'
      )
    ).toBe(false);
    expect(catalogue.is(new Error('code 1'), 'NOBODY_TO_GREET')).toBe(false);
    // a failure that names no procedure tells no service
    expect(
      catalogue.is(
        new FailureError({ code: 1, scope: FailureScope.APPLICATION }),
        'NOBODY_TO_GREET'
      )
    ).toBe(false);
  });

  test('narrows to the failure of its name, and leaves a FailureError it is not one', () => {
    const catalogue = failuresOf({ codes: { NOBODY_TO_GREET: 1, TOO_LOUD: 2 }, serviceId: 7 });
    // a FailureError asked of one name, then of another, and read on each branch
    const told = (error: FailureError): string => {
      if (catalogue.is(error, 'NOBODY_TO_GREET')) {
        const named: IListedFailureError<'NOBODY_TO_GREET'> = error;
        // @ts-expect-error a failure of one name is none of another
        const other: IListedFailureError<'TOO_LOUD'> = error;

        return `NOBODY_TO_GREET of ${String(named.procedureAddress.serviceId)}, ${String(other.code)}`;
      }

      if (catalogue.is(error, 'TOO_LOUD')) {
        return `TOO_LOUD, ${error.scope}`;
      }

      return `${String(error.code)}, ${error.scope}`;
    };

    expect(told(receivedOf(1, 7))).toBe('NOBODY_TO_GREET of 7, 1');
    expect(told(receivedOf(2, 7))).toBe(`TOO_LOUD, ${FailureScope.APPLICATION}`);
    expect(told(receivedOf(2, 8))).toBe(`2, ${FailureScope.APPLICATION}`);
  });
});
