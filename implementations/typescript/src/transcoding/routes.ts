// ── Routes ────────────────────────────────────────────────────────────────────

// A gateway's route table, as beadc writes it into an output with `http: true` (decision 0037,
// spec/transcoding.md 3): data alone, each procedure's descriptor, messages and routes, its default
// ones first, then its rules.

// dependencies

import type { DescMessage } from '@bufbuild/protobuf';
import type { IServiceDescriptor } from '../service/descriptors';
import { ProgrammerError } from '../transport/shared/errors';

// types

/** A payload as a route reads and writes its JSON: a message's schema, or an encoding of Bead's. */
export type HttpPayload = DescMessage | 'json' | 'raw' | 'text';

/** The methods a rule's pattern names (transcoding 3.4), `custom` refused by the builder. */
export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

// interfaces

/** One route of a procedure: its method, its template, its body and its response body. */
export interface IHttpRouteTemplate {
  /** `*`, its request whole less what its variables bind, or a top-level field's name; none, no body. */
  readonly body?: string | undefined;
  readonly method: HttpMethod;
  /** A top-level field of its result, whose JSON is the body it answers (transcoding 5.8). */
  readonly responseBody?: string | undefined;
  /** `http.proto`'s path template, its verb after a `:` where it has one. */
  readonly template: string;
}

/** A procedure a client calls, as its route table holds it. */
export interface IHttpRouteInit {
  /** Its service's catalogue, each failure's name and code. */
  readonly failures: Readonly<Record<string, number>>;
  /** Whether its method is marked `NO_SIDE_EFFECTS`. */
  readonly noSideEffects?: true | undefined;
  /** Its notification's payload, for a procedure that notifies. */
  readonly notification?: HttpPayload | undefined;
  /** Its descriptor, its service's `<Service>Procedures` member. */
  readonly procedure: IServiceDescriptor;
  readonly request: HttpPayload;
  readonly result: HttpPayload;
  /** Its routes, its default ones first, then its rules in their order. */
  readonly routes: readonly IHttpRouteTemplate[];
}

// constants

/**
 * The contract 5 (decision 0037): a route table's, `routeOf` and the transcoding layer that reads it,
 * beside the contract 6 of `./service`, which a project that generates no route table keeps; a
 * route table holds descriptors and calls no codec, so it stays at 5.
 *
 * @example
 * import { GENERATED_CODE_SUPPORTS_VERSION_5 } from '@francisdesjardins/bead/transcoding';
 *
 * void GENERATED_CODE_SUPPORTS_VERSION_5;
 */
export const GENERATED_CODE_SUPPORTS_VERSION_5 = true;

const METHODS: ReadonlySet<string> = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);

const ENCODINGS: ReadonlySet<unknown> = new Set(['json', 'raw', 'text']);

// helpers

// whether a payload is a message's schema or one of Bead's encodings
const isPayload = (payload: unknown): boolean => {
  return (
    ENCODINGS.has(payload) ||
    (typeof payload === 'object' &&
      payload !== null &&
      (payload as { kind?: unknown }).kind === 'message')
  );
};

// definition

/**
 * A route of the table, frozen, as beadc writes it: a payload that is neither a message's schema
 * nor `json`, `text` or `raw`, a procedure that notifies without its notification's, or a route of
 * no method or no template, is a {@link ProgrammerError}. What a template means is the gateway's to
 * judge, as it reads the table.
 *
 * @example
 * import { routeOf } from '@francisdesjardins/bead/transcoding';
 *
 * const sayHello = routeOf({
 *   failures: { NAMELESS: 1 },
 *   procedure: HelloProcedures.sayHello,
 *   request: SayHelloRequestSchema,
 *   result: SayHelloResponseSchema,
 *   routes: [{ body: '*', method: 'POST', template: '/api/Hello/sayHello' }],
 * });
 */
export const routeOf = <const Init extends IHttpRouteInit>(init: Init): Init => {
  const { notification, procedure, request, result, routes } = init;
  const name = procedure.procedure.procedureName;

  if (!isPayload(request) || !isPayload(result)) {
    throw new ProgrammerError(
      `${name}'s request and result are a message's schema, json, text or raw`
    );
  }

  if ((procedure.notification === undefined) !== (notification === undefined)) {
    throw new ProgrammerError(`${name}'s notification is its route's exactly where it notifies`);
  }

  if (notification !== undefined && !isPayload(notification)) {
    throw new ProgrammerError(`${name}'s notification is a message's schema, json, text or raw`);
  }

  for (const route of routes) {
    if (!METHODS.has(route.method) || typeof route.template !== 'string') {
      throw new ProgrammerError(`${name}'s route is a method of http.proto's and a template`);
    }
  }

  return Object.freeze({
    ...init,
    routes: Object.freeze(
      routes.map((route) => {
        return Object.freeze({ ...route });
      })
    ),
  });
};
