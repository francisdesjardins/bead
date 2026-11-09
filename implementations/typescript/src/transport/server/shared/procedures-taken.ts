// ── Procedures taken ──────────────────────────────────────────────────────────

// What a server's transport takes (spec 9.11): the addresses its application names, held to section
// 16.2's ranges as the transport is built (9.12), and asked of each request that names no
// destination.

// dependencies

import type { IProcedureAddress } from '../../../router/shared/types';
import { ProgrammerError } from '../../shared/errors';
import type { ITransportServerImplementation } from '../types';

// interfaces

/** The procedures a transport takes, an address named twice being one. */
export interface IProceduresTaken {
  has(address: IProcedureAddress): boolean;
}

// constants

// the largest id of 16.2, on its 2 bytes; 0 is the protocol's (16.3)
const LARGEST_ID = 0xffff;
// one key for an address: its service above its procedure
const SERVICE_SPAN = LARGEST_ID + 1;

// helpers

// a whole number from 1 to 65535: no fraction, no string, no boolean, no null
const isId = (value: unknown): value is number => {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= LARGEST_ID;
};

// definition

/**
 * The procedures `transport` takes, as its option `procedures` gives them (spec 9.11): none when
 * none is given, every procedure then taken. An address whose service id or procedure id is not a
 * whole number from 1 to 65535, service 0 among them, is a {@link ProgrammerError}, as a declaration
 * is refused (9.12, 16.10); so is a list that is no array.
 */
export const proceduresTakenOf = (
  procedures: readonly IProcedureAddress[] | undefined,
  transport: string
): IProceduresTaken | undefined => {
  if (procedures === undefined) {
    return undefined;
  }

  if (!Array.isArray(procedures)) {
    throw new ProgrammerError(`${transport} takes its procedures as a list of addresses`);
  }

  const keys = new Set<number>();

  for (const address of procedures as readonly unknown[]) {
    const { procedureId, serviceId } = (address ?? {}) as Record<keyof IProcedureAddress, unknown>;

    if (!isId(serviceId) || !isId(procedureId)) {
      throw new ProgrammerError(
        `${transport} takes ${String(serviceId)}/${String(procedureId)}, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3)`
      );
    }

    keys.add(serviceId * SERVICE_SPAN + procedureId);
  }

  return Object.freeze({
    has: ({ procedureId, serviceId }: IProcedureAddress): boolean => {
      return keys.has(serviceId * SERVICE_SPAN + procedureId);
    },
  });
};

/**
 * What a transport whose connections all take one list hands `createTransportServer`: its
 * `takesProcedure`, by `procedures` alone, whatever the connection; nothing when none is given, so
 * its server never has one. Checked as {@link proceduresTakenOf} checks them, as the transport is
 * built.
 */
export const takingOf = (
  procedures: readonly IProcedureAddress[] | undefined,
  transport: string
): Pick<ITransportServerImplementation, 'takesProcedure'> => {
  const taken = proceduresTakenOf(procedures, transport);

  return taken === undefined
    ? {}
    : {
        takesProcedure: (_connectionHandle, address) => {
          return taken.has(address);
        },
      };
};
