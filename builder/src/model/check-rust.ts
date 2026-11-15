// ── Check Rust ────────────────────────────────────────────────────────────────

// What the Rust target refuses of an output's gateway, judged here so a page that plans the output
// refuses it as beadc does: a procedure a client calls whose method, its name in snake case, is one
// the service's HTTP client holds already, its constructor's or a trait's it implements. A command
// takes any name, since no HTTP client calls it. The refusal is no rule of `check`: only an output
// with a gateway in Rust meets it.

// dependencies

import { toSnakeCase } from '../targets/rust/names.ts';
import type { IBlueprint } from './blueprint.ts';

// types

/** A refusal of a Rust output's gateway: the procedure, as a selection names it, and its words. */
export interface IRustGatewayRefusal {
  readonly procedure: string;
  readonly message: string;
}

// constants

/**
 * The methods a service's HTTP client holds besides its procedures': its constructor, and those of
 * the traits it implements, `Clone` and `Debug`.
 */
export const HTTP_CLIENT_METHODS: ReadonlySet<string> = new Set(['new', 'clone', 'fmt']);

// definition

/**
 * The refusals of `gateway`, the view of a blueprint an output's gateway selects, written in Rust:
 * each procedure a client calls whose method its HTTP client holds already, in the order the
 * gateway is written.
 */
export const rustGatewayRefusalsOf = (gateway: IBlueprint): IRustGatewayRefusal[] => {
  return gateway.services.flatMap((service) => {
    return service.procedures.flatMap((procedure) => {
      const method = toSnakeCase(procedure.procedureName);

      if (procedure.procedureKind === 'command' || !HTTP_CLIENT_METHODS.has(method)) {
        return [];
      }

      const name = `${service.serviceName}/${procedure.procedureName}`;

      return [
        {
          procedure: name,
          message: `the procedure ${name} is the method ${method} of ${service.serviceName}HttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway`,
        },
      ];
    });
  });
};
