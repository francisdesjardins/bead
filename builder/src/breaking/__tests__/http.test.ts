import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint, IHttpEntry } from '../../model/blueprint.ts';
import { Category } from '../../rules.ts';
import { bufConfigOf } from '../buf.ts';
import { holdsHttp, httpBreakingOf } from '../http.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

// the interop's blueprint, its procedure `at` given `http`
const withHttp = (entries: readonly (readonly [number, IHttpEntry])[]): IBlueprint => {
  const blueprint = JSON.parse(readFileSync(INTEROP, 'utf8')) as {
    services: { procedures: Record<string, unknown>[] }[];
  };

  for (const [at, http] of entries) {
    const procedure = blueprint.services[0]?.procedures[at];

    if (procedure !== undefined) {
      procedure['http'] = http;
    }
  }

  return blueprint as unknown as IBlueprint;
};

const STARS: IHttpEntry = { rules: [{ method: 'POST', template: '/api/**', body: '*' }] };

test("holds the category HTTP where the earlier states an HTTP member, and buf's WIRE_JSON under WIRE with it", () => {
  expect(holdsHttp(withHttp([]))).toBe(false);
  expect(holdsHttp(withHttp([[0, { idempotencyLevel: 'IDEMPOTENT', rules: [] }]]))).toBe(true);
  expect(bufConfigOf(Category.WIRE, { json: true })).toMatchObject({
    breaking: { use: ['WIRE_JSON'] },
  });
  expect(bufConfigOf(Category.API, { json: true })).toMatchObject({ breaking: { use: ['FILE'] } });
  expect(bufConfigOf(Category.WIRE)).toMatchObject({ breaking: { use: ['WIRE'] } });
});

test("a rule gone or moved, a default GET gone, and a route that takes a path an earlier one answered, each at the current's procedure", () => {
  const earlier = withHttp([
    [0, STARS],
    [1, { rules: [{ method: 'POST', template: '/v1/fail', body: '*' }] }],
  ]);
  const current = withHttp([
    [0, STARS],
    [1, { rules: [{ method: 'POST', template: '/v2/fail', body: '*' }] }],
    [2, { rules: [{ method: 'POST', template: '/api/Interop/new', body: '*' }] }],
  ]);
  const findings = httpBreakingOf(current, { earlier, prefix: '/api' });

  expect(
    findings.map((finding) => {
      return [finding.rule, finding.pointer, finding.subject];
    })
  ).toEqual([
    ['HTTP_ROUTE_NO_DELETE', '/services/0/procedures/1/http', 'service:1/procedure:2'],
    ['HTTP_ROUTE_SHADOWED', '/services/0/procedures/2/http/rules/0', 'service:1/procedure:3'],
  ]);
  expect(findings[1]?.message).toBe(
    "Interop.slow's POST /api/Interop/new takes, by 3.5's precedence, a path Interop.echo's POST /api/** answered: a client of the earlier's is answered by another procedure"
  );
  // * against itself, nothing
  expect(httpBreakingOf(earlier, { earlier, prefix: '/api' })).toEqual([]);
});
