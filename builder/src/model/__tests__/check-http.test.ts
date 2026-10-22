import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint, IHttpEntry } from '../blueprint.ts';
import { httpFindingsOf } from '../check-http.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

// the interop's blueprint, its procedure `at` given `http`
const withHttp = (at: number, http: IHttpEntry): IBlueprint => {
  const blueprint = JSON.parse(readFileSync(INTEROP, 'utf8')) as {
    services: { procedures: Record<string, unknown>[] }[];
  };
  const procedure = blueprint.services[0]?.procedures[at];

  if (procedure !== undefined) {
    procedure['http'] = http;
  }

  return blueprint as unknown as IBlueprint;
};

const rulesOf = (blueprint: IBlueprint): [string, string][] => {
  return httpFindingsOf(blueprint).map((finding) => {
    return [finding.rule, finding.pointer];
  });
};

test('a blueprint written by hand with no HTTP member gives no HTTP finding', () => {
  expect(rulesOf(JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint)).toEqual([]);
});

test("a template off http.proto's grammar, a rule on a command, and what a json request has none of, each by its rule at its place", () => {
  expect(
    rulesOf(
      withHttp(0, {
        rules: [
          { method: 'POST', template: '/v1/{a={b}}', body: '*' },
          { method: 'POST', template: '/v1/{name}', body: '*' },
          { method: 'DELETE', template: '/v1/echo' },
          { method: 'POST', template: '/v1/echo', body: '*', responseBody: 'x' },
        ],
      })
    )
  ).toEqual([
    ['HTTP_RULE_TEMPLATE', '/services/0/procedures/0/http/rules/0/template'],
    ['HTTP_BINDING_NATIVE', '/services/0/procedures/0/http/rules/1'],
    ['HTTP_BINDING_NATIVE', '/services/0/procedures/0/http/rules/2'],
    ['HTTP_BINDING_NATIVE', '/services/0/procedures/0/http/rules/3/responseBody'],
  ]);
  expect(
    rulesOf(withHttp(8, { rules: [{ method: 'POST', template: '/v1/clock', body: '*' }] }))
  ).toEqual([['HTTP_RULE_COMMAND', '/services/0/procedures/8/http/rules/0']]);
});

test('a procedure marked NO_SIDE_EFFECTS whose request no query carries has no default GET, a warning; a command marked is no route of any kind', () => {
  const findings = httpFindingsOf(withHttp(0, { idempotencyLevel: 'NO_SIDE_EFFECTS', rules: [] }));

  expect(
    findings.map((finding) => {
      return [finding.rule, finding.message];
    })
  ).toEqual([
    [
      'HTTP_GET_UNBINDABLE',
      'Interop.echo is NO_SIDE_EFFECTS and its request is json, which no query carries: it has no default GET',
    ],
  ]);
  expect(rulesOf(withHttp(8, { idempotencyLevel: 'NO_SIDE_EFFECTS', rules: [] }))).toEqual([]);
});
