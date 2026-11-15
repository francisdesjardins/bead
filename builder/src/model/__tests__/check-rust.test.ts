import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { IBlueprint } from '../blueprint.ts';
import { rustGatewayRefusalsOf } from '../check-rust.ts';
import { applyPatch } from './patch.ts';

const INTEROP = new URL('../../../../spec/interop-blueprint.json', import.meta.url);

// the interop's blueprint, its procedure `at` renamed `name`
const renamed = (at: number, name: string): IBlueprint => {
  return applyPatch(JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint, [
    { op: 'replace', path: `/services/0/procedures/${String(at)}/procedureName`, value: name },
  ]) as IBlueprint;
};

test('a gateway whose procedures take no method its HTTP client holds gives no refusal', () => {
  expect(rustGatewayRefusalsOf(JSON.parse(readFileSync(INTEROP, 'utf8')) as IBlueprint)).toEqual(
    []
  );
});

test('refuses a procedure a client calls whose method its HTTP client holds, in the words of the Rust target', () => {
  for (const name of ['new', 'clone', 'fmt']) {
    expect(rustGatewayRefusalsOf(renamed(0, name))).toEqual([
      {
        procedure: `Interop/${name}`,
        message: `the procedure Interop/${name} is the method ${name} of InteropHttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway`,
      },
    ]);
  }
});

test('judges the method a name renders as, a procedure that notifies among them', () => {
  expect(rustGatewayRefusalsOf(renamed(9, 'Clone'))).toEqual([
    {
      procedure: 'Interop/Clone',
      message: `the procedure Interop/Clone is the method clone of InteropHttpClient in Rust, which the client holds already: rename the procedure, or take it out of the output's gateway`,
    },
  ]);
});

test('lets a command take the name, since no HTTP client calls it', () => {
  expect(rustGatewayRefusalsOf(renamed(8, 'new'))).toEqual([]);
});

test('gives every refusal, in the order the gateway is written', () => {
  const both = applyPatch(renamed(7, 'fmt'), [
    { op: 'replace', path: '/services/0/procedures/1/procedureName', value: 'new' },
  ]) as IBlueprint;

  expect(
    rustGatewayRefusalsOf(both).map((refusal) => {
      return refusal.procedure;
    })
  ).toEqual(['Interop/new', 'Interop/fmt']);
});
