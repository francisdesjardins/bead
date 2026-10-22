// ── HTTP ──────────────────────────────────────────────────────────────────────

// What a client of the earlier's HTTP routes meets in the current (decision 0037), `beadc breaking`'s
// category `HTTP`, held under either `--category` wherever the earlier blueprint states an HTTP member
// or the project writes a document: each route of the earlier still reaches its procedure, by its
// procedure's ids, and still answers its paths. A rule of a procedure both hold gone, or its
// template, its method, its body or its response body changed (HTTP_ROUTE_NO_DELETE); a procedure
// that had a default `GET` and has none (HTTP_GET_NO_DELETE); a route the current adds that, by 3.5's
// precedence, takes a path one of the earlier's answered (HTTP_ROUTE_SHADOWED), a new procedure's
// default route, literal whole, over a rule's `**` among them. Every route under the current's
// prefix, since an earlier's `beadc.yaml` is read for its source alone. buf's `WIRE_JSON` rules hold
// the names the JSON reads (`buf.ts`); a service or a procedure renamed moves its default route,
// which `SERVICE_SAME_NAME` and `PROCEDURE_SAME_NAME` hold under `API`.

// dependencies

import type { IBlueprint, IProcedureEntry, IServiceEntry } from '../model/blueprint.ts';
import {
  comparePrecedence,
  hasDefaultGet,
  matchesSegments,
  messagesOf,
  type IServedRoute,
  servedRoutesOf,
  sharedPathsOf,
  templateOf,
} from '../model/routes.ts';
import type { RuleName } from '../rules.ts';

// types

/** A finding of the HTTP category, before its place: its rule, its pointer, its subject. */
export interface IHttpBreakingFinding {
  readonly rule: RuleName;
  readonly pointer: string;
  readonly message: string;
  readonly subject: string;
}

// helpers

const keyOf = (route: IServedRoute): string => {
  return [
    route.service.serviceId,
    route.procedure.procedureId,
    route.method,
    route.template,
    route.body ?? '',
    route.responseBody ?? '',
  ].join(' ');
};

const ruleText = (rule: {
  readonly method: string;
  readonly template: string;
  readonly body?: string;
  readonly responseBody?: string;
}): string => {
  return [
    `${rule.method} ${rule.template}`,
    ...(rule.body === undefined ? [] : [`body ${rule.body}`]),
    ...(rule.responseBody === undefined ? [] : [`response_body ${rule.responseBody}`]),
  ].join(', ');
};

// the route that answers `path` among `routes` of its method, by 3.5's precedence; none where none does
const winnerOf = (
  routes: readonly IServedRoute[],
  path: { readonly segments: readonly string[]; readonly verb?: string; readonly method: string }
): IServedRoute | undefined => {
  let best: IServedRoute | undefined;

  for (const route of routes) {
    const template = templateOf(route.template);

    if (route.method !== path.method || !matchesSegments(template, path)) {
      continue;
    }

    if (
      best === undefined ||
      comparePrecedence(template, {
        other: templateOf(best.template),
        count: path.segments.length,
      }) < 0
    ) {
      best = route;
    }
  }

  return best;
};

// definition

/** Whether `blueprint` states an HTTP member: a rule, or an idempotency level, of any procedure. */
export const holdsHttp = (blueprint: IBlueprint): boolean => {
  return blueprint.services.some((service) => {
    return service.procedures.some((procedure) => {
      return procedure.http !== undefined;
    });
  });
};

/** The findings of the HTTP category over `current` against `options.earlier`, under `options.prefix`. */
export const httpBreakingOf = (
  current: IBlueprint,
  options: { readonly earlier: IBlueprint; readonly prefix: string }
): IHttpBreakingFinding[] => {
  const { earlier, prefix } = options;
  const findings: IHttpBreakingFinding[] = [];
  const earlierMessages = messagesOf(earlier);
  const currentMessages = messagesOf(current);
  const placeOf = (
    service: IServiceEntry,
    procedure: IProcedureEntry
  ): { readonly at: string; readonly subject: string } | undefined => {
    const serviceAt = current.services.findIndex((each) => {
      return each.serviceId === service.serviceId;
    });
    const procedureAt =
      current.services[serviceAt]?.procedures.findIndex((each) => {
        return each.procedureId === procedure.procedureId;
      }) ?? -1;

    return procedureAt === -1
      ? undefined
      : {
          at: `/services/${String(serviceAt)}/procedures/${String(procedureAt)}`,
          subject: `service:${String(service.serviceId)}/procedure:${String(procedure.procedureId)}`,
        };
  };

  // * a rule of a procedure both hold, and a default GET, gone
  for (const was of earlier.services) {
    for (const before of was.procedures) {
      const now = current.services.find((service) => {
        return service.serviceId === was.serviceId;
      });
      const after = now?.procedures.find((procedure) => {
        return procedure.procedureId === before.procedureId;
      });
      const place = now === undefined || after === undefined ? undefined : placeOf(now, after);

      if (now === undefined || after === undefined || place === undefined) {
        continue;
      }

      const named = `${was.serviceName}.${before.procedureName}`;
      const kept = new Set(
        (after.http?.rules ?? []).map((rule) => {
          return ruleText(rule);
        })
      );

      for (const rule of before.http?.rules ?? []) {
        if (!kept.has(ruleText(rule))) {
          findings.push({
            rule: 'HTTP_ROUTE_NO_DELETE',
            pointer: `${place.at}/http`,
            message: `${named}'s rule ${ruleText(rule)} is gone, or moved: a client of it reaches nothing, or another field; keep it beside the new one`,
            subject: place.subject,
          });
        }
      }

      if (hasDefaultGet(before, earlierMessages) && !hasDefaultGet(after, currentMessages)) {
        findings.push({
          rule: 'HTTP_GET_NO_DELETE',
          pointer: `${place.at}/http`,
          message: `${named} had a default GET, NO_SIDE_EFFECTS and its request carried by the query, and has none now: a client of GET ${prefix}/${now.serviceName}/${after.procedureName} is answered 405`,
          subject: place.subject,
        });
      }
    }
  }

  // * a route the current adds that answers a path one of the earlier's answered
  const before = servedRoutesOf(earlier, { prefix });
  const after = servedRoutesOf(current, { prefix });
  const earlierKeys = new Set(before.map(keyOf));

  for (const added of after.filter((route) => {
    return !earlierKeys.has(keyOf(route));
  })) {
    const template = templateOf(added.template);

    for (const was of before) {
      if (was.method !== added.method) {
        continue;
      }

      const shadowed = sharedPathsOf(template, templateOf(was.template)).some((path) => {
        const at = { ...path, method: added.method };
        const earlierWinner = winnerOf(before, at);
        const currentWinner = winnerOf(after, at);

        return (
          earlierWinner !== undefined &&
          keyOf(earlierWinner) === keyOf(was) &&
          currentWinner !== undefined &&
          keyOf(currentWinner) === keyOf(added)
        );
      });
      const place = placeOf(added.service, added.procedure);

      if (shadowed && place !== undefined) {
        findings.push({
          rule: 'HTTP_ROUTE_SHADOWED',
          pointer:
            added.origin.kind === 'rule'
              ? `${place.at}/http/rules/${String(added.origin.index)}`
              : `${place.at}/procedureName`,
          message: `${added.service.serviceName}.${added.procedure.procedureName}'s ${added.method} ${added.template} takes, by 3.5's precedence, a path ${was.service.serviceName}.${was.procedure.procedureName}'s ${was.method} ${was.template} answered: a client of the earlier's is answered by another procedure`,
          subject: place.subject,
        });
        break;
      }
    }
  }

  return findings;
};
