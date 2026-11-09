// ── Procedure map ─────────────────────────────────────────────────────────────

// dependencies

import type { IProcedureAddress, ProcedureId, ServiceId } from './types';

// interfaces

/** What is kept for each procedure, by its service, then by its own number in that service. */
export interface IProcedureMap<Value> {
  clear(): void;
  /** Takes out what is kept for `address`; whether anything was. */
  delete(address: IProcedureAddress): boolean;
  get(address: IProcedureAddress): Value | undefined;
  has(address: IProcedureAddress): boolean;
  /** Whether anything is kept for a procedure of `serviceId`. */
  hasService(serviceId: ServiceId): boolean;
  /**
   * Whether anything is kept for a procedure of `serviceId` whose address `isTaken` takes: its
   * procedures scanned, until one is.
   */
  hasServiceTaken(serviceId: ServiceId, isTaken: (address: IProcedureAddress) => boolean): boolean;
  set(address: IProcedureAddress, value: Value): void;
  /** What is kept, every procedure's, by service. */
  values(): Value[];
}

// definition

/**
 * What is kept for each procedure, one map per service holding one entry per procedure: a service
 * leaves with its last procedure, so `hasService` says whether any of its procedures is kept.
 */
export const createProcedureMap = <Value>(): IProcedureMap<Value> => {
  const services = new Map<ServiceId, Map<ProcedureId, Value>>();

  return {
    clear: () => {
      services.clear();
    },
    delete: ({ procedureId, serviceId }) => {
      const procedures = services.get(serviceId);
      const isKept = procedures?.delete(procedureId) === true;

      if (procedures?.size === 0) {
        services.delete(serviceId);
      }

      return isKept;
    },
    get: ({ procedureId, serviceId }) => {
      return services.get(serviceId)?.get(procedureId);
    },
    has: ({ procedureId, serviceId }) => {
      return services.get(serviceId)?.has(procedureId) === true;
    },
    hasService: (serviceId) => {
      return services.has(serviceId);
    },
    hasServiceTaken: (serviceId, isTaken) => {
      return (
        services
          .get(serviceId)
          ?.keys()
          .some((procedureId) => {
            return isTaken({ procedureId, serviceId });
          }) === true
      );
    },
    set: ({ procedureId, serviceId }, value) => {
      const procedures = services.get(serviceId) ?? new Map<ProcedureId, Value>();

      procedures.set(procedureId, value);
      services.set(serviceId, procedures);
    },
    values: () => {
      return [...services.values()].flatMap((procedures) => {
        return [...procedures.values()];
      });
    },
  };
};
