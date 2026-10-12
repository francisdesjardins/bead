// ── Failures ──────────────────────────────────────────────────────────────────

// A service's failures, as a catalogue of names and their codes: what its resolvers answer, each
// narrowed to the names its procedure lists, and what its callers tell apart. A peer hears codes
// alone, as it does of any application failure (spec 9.5).

// dependencies

import type { FailureScope } from '../router/shared/constants';
import { FailureError } from '../router/shared/errors';
import type { IApplicationFailure, IProcedureAddress, ServiceId } from '../router/shared/types';
import { ProgrammerError } from '../transport/shared/errors';

// declarations

declare const failureNameBrand: unique symbol;

// interfaces

/** A failure of a catalogue, by its name: its code, and why. */
export interface IListedFailure<Name extends string = string> extends IApplicationFailure {
  readonly detail: string;
  readonly failureName: Name;
}

/**
 * A failure of a catalogue, received and told by its name: a {@link FailureError} of the
 * application, from a procedure of the catalogue's service, its name a type's alone.
 */
export interface IListedFailureError<Name extends string = string> extends FailureError {
  readonly procedureAddress: IProcedureAddress;
  readonly scope: typeof FailureScope.APPLICATION;
  readonly [failureNameBrand]: Name;
}

/**
 * A service's failures, by name: their codes, a failure made of one, and a failure received told as
 * one.
 */
export interface IFailureCatalogue<Name extends string> {
  readonly codes: Readonly<Record<Name, number>>;
  readonly serviceId: ServiceId;

  /**
   * Whether `error` is the application failure `name`, received from a procedure of its service: a
   * {@link FailureError} of its code, whose procedure's service is the catalogue's. A false answer
   * leaves a FailureError one, to be asked of another name.
   */
  is: <Given extends Name>(error: unknown, name: Given) => error is IListedFailureError<Given>;
  /** The failure `name`, with `detail`, '' when not given; a name it lacks is a ProgrammerError. */
  of: <Given extends Name>(name: Given, detail?: string) => IListedFailure<Given>;
}

// constants

// the codes of an application failure, as spec 9.5 numbers them
const LARGEST_CODE = 0xffff;

// definition

/**
 * A service's catalogue, frozen: its names, each with its code, and its service's id. A code that is
 * not a whole number from 1 to 65535, or two names of one code, is a {@link ProgrammerError}.
 *
 * @example
 * import { failuresOf } from '@francisdesjardins/bead/service';
 *
 * const GreeterFailures = failuresOf({ codes: { NOBODY_TO_GREET: 1, TOO_LOUD: 2 }, serviceId: 1 });
 *
 * const failure = GreeterFailures.of('NOBODY_TO_GREET', 'a name is needed');
 */
export const failuresOf = <const Name extends string>(catalogue: {
  codes: Readonly<Record<Name, number>>;
  serviceId: ServiceId;
}): IFailureCatalogue<Name> => {
  const codes = Object.freeze({ ...catalogue.codes });
  const { serviceId } = catalogue;
  // each code's name, so a code is listed once
  const named = new Map<number, string>();

  for (const [name, code] of Object.entries<number>(codes)) {
    if (!Number.isInteger(code) || code < 1 || code > LARGEST_CODE) {
      throw new ProgrammerError(
        `a failure's code is a whole number from 1 to 65535, not ${String(code)} for ${name}`
      );
    }

    const other = named.get(code);

    if (other !== undefined) {
      throw new ProgrammerError(`${name} and ${other} are both failure ${String(code)}`);
    }

    named.set(code, name);
  }

  const codeOf = (name: string): number => {
    const code = (codes as Readonly<Record<string, number>>)[name];

    if (code === undefined || !Object.hasOwn(codes, name)) {
      throw new ProgrammerError(`${name} is no failure of service ${String(serviceId)}`);
    }

    return code;
  };

  return Object.freeze({
    codes,
    serviceId,

    is: <Given extends Name>(error: unknown, name: Given): error is IListedFailureError<Given> => {
      return (
        error instanceof FailureError &&
        error.isApplication(codeOf(name)) &&
        error.procedureAddress?.serviceId === serviceId
      );
    },
    of: <Given extends Name>(name: Given, detail = ''): IListedFailure<Given> => {
      return Object.freeze({ code: codeOf(name), detail, failureName: name });
    },
  });
};
