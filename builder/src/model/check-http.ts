// ── Check HTTP ────────────────────────────────────────────────────────────────

// The rules of a blueprint's HTTP members that any blueprint can judge, one written by hand among
// them (decision 0037, spec/transcoding.md 3.9): a template off `http.proto`'s grammar
// (HTTP_RULE_TEMPLATE); a rule on a command, which no HTTP client calls (HTTP_RULE_COMMAND); a rule
// that binds what a `raw`, `text` or `json` payload has none of, no field, or a response body of a
// result that is no message (HTTP_BINDING_NATIVE); a `get` rule on a method not marked
// `NO_SIDE_EFFECTS`, served as written and held by the gateway's Fetch Metadata gate
// (HTTP_GET_UNMARKED); and a `NO_SIDE_EFFECTS` procedure whose request the query cannot carry whole,
// which has no default `GET` (HTTP_GET_UNBINDABLE). What needs the `.proto`'s fields is
// `front-end/http.ts`'s; what needs `beadc.yaml`'s prefix, `generate.ts`'s.

// dependencies

import type { RuleName } from '../rules.ts';
import type { IBlueprint } from './blueprint.ts';
import { messagesOf, parseTemplate, queryCarries } from './routes.ts';

// types

/** A finding of an HTTP rule, before its place: its rule, its pointer, its message. */
export interface IHttpFinding {
  readonly rule: RuleName;
  readonly pointer: string;
  readonly message: string;
}

// definition

/** The findings of the HTTP rules any blueprint can judge, in the order the blueprint is written. */
export const httpFindingsOf = (blueprint: IBlueprint): IHttpFinding[] => {
  const findings: IHttpFinding[] = [];
  const messages = messagesOf(blueprint);

  blueprint.services.forEach((service, serviceAt) => {
    service.procedures.forEach((procedure, procedureAt) => {
      const place = `/services/${String(serviceAt)}/procedures/${String(procedureAt)}`;
      const name = `${service.serviceName}.${procedure.procedureName}`;
      const { http } = procedure;

      if (http === undefined) {
        return;
      }

      const native = procedure.request.encoding !== 'proto';
      const marked = http.idempotencyLevel === 'NO_SIDE_EFFECTS';

      if (procedure.procedureKind === 'command' && http.rules.length > 0) {
        findings.push({
          rule: 'HTTP_RULE_COMMAND',
          pointer: `${place}/http/rules/0`,
          message: `${name} is a command, which a server sends and no HTTP client calls: its rules are never served`,
        });
      }

      http.rules.forEach((rule, at) => {
        const rulePlace = `${place}/http/rules/${String(at)}`;
        const reading = parseTemplate(rule.template);

        if (reading.kind === 'refused') {
          findings.push({
            rule: 'HTTP_RULE_TEMPLATE',
            pointer: `${rulePlace}/template`,
            message: `${JSON.stringify(rule.template)} is off http.proto's grammar: ${reading.reason}`,
          });
        }

        if (native) {
          const bound = [
            ...(reading.kind === 'template' && reading.template.variables.length > 0
              ? ['a variable']
              : []),
            ...(rule.body === '*' ? [] : ['a body other than *']),
            ...(rule.method === 'GET' || rule.method === 'DELETE'
              ? [`a ${rule.method.toLowerCase()}`]
              : []),
          ];

          if (bound.length > 0) {
            findings.push({
              rule: 'HTTP_BINDING_NATIVE',
              pointer: rulePlace,
              message: `${name}'s request is ${procedure.request.encoding}, which has no field, and its rule states ${bound.join(', ')}: its body is the payload whole, *, and no variable or query binds it`,
            });
          }
        }

        if (rule.responseBody !== undefined && procedure.result.encoding !== 'proto') {
          findings.push({
            rule: 'HTTP_BINDING_NATIVE',
            pointer: `${rulePlace}/responseBody`,
            message: `${name}'s result is ${procedure.result.encoding}, which has no field a response_body names`,
          });
        }

        if (rule.method === 'GET' && !marked && !native) {
          findings.push({
            rule: 'HTTP_GET_UNMARKED',
            pointer: `${rulePlace}/method`,
            message: `${name} states a get rule and no idempotency_level = NO_SIDE_EFFECTS: served as written, its author's word that it reads, and a navigation from another site to it refused by the gateway's Fetch Metadata gate (transcoding 10.1, step 5)`,
          });
        }
      });

      if (marked && procedure.procedureKind !== 'command') {
        const message = procedure.request.message;
        const carried = !native && message !== undefined && queryCarries(message, { messages });

        if (!carried) {
          findings.push({
            rule: 'HTTP_GET_UNBINDABLE',
            pointer: `${place}/http/idempotencyLevel`,
            message: native
              ? `${name} is NO_SIDE_EFFECTS and its request is ${procedure.request.encoding}, which no query carries: it has no default GET`
              : `${name} is NO_SIDE_EFFECTS and its request holds a field the query cannot carry, a map, a repeated message or a well-known type but a Timestamp, a Duration, a FieldMask and a wrapper: it has no default GET`,
          });
        }
      }
    });
  });

  return findings;
};
