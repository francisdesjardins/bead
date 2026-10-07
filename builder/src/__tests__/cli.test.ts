import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const BUILDER = fileURLToPath(new URL('../../', import.meta.url));
const INTEROP = fileURLToPath(new URL('../../../spec/interop-blueprint.json', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

// beadc as a user runs it: Node, src/cli.ts as written, from builder/
const beadc = (
  args: readonly string[]
): { status: number | null; stdout: string; stderr: string } => {
  const run = spawnSync(process.execPath, ['src/cli.ts', ...args], {
    cwd: BUILDER,
    encoding: 'utf8',
  });

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

test('node runs src/cli.ts version as written, as a child process', () => {
  const run = beadc(['version']);

  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(
    /^beadc \d+\.\d+\.\d+\nbuf 1\.73\.0\nprotobuf-es \d+\.\d+\.\d+\nformat bead-blueprint\/1\nspec \d+\.\d+\.\d+\noptions 58500\n$/u
  );
});

test("blueprint --check exits 1 on a blueprint off its form and 0 on the interop's", () => {
  const off = test.info().outputPath('off-form.json');

  writeFileSync(off, readFileSync(INTEROP, 'utf8').replace('"requires": []', '"requires":  []'));

  expect(beadc(['blueprint', '--check', INTEROP]).status).toBe(0);
  expect(beadc(['check', INTEROP]).status).toBe(0);

  const run = beadc(['blueprint', '--check', off]);

  expect(run.status).toBe(1);
  expect(run.stdout).toContain(':3: line 3 is off its form');
});

test('blueprint -o writes nothing for a blueprint check refuses', () => {
  const refused = test.info().outputPath('refused.json');
  const out = test.info().outputPath('out.json');

  writeFileSync(refused, readFileSync(INTEROP, 'utf8').replace('"serviceId": 1', '"serviceId": 0'));

  const run = beadc(['blueprint', refused, '-o', out]);

  expect(run.status).toBe(1);
  expect(run.stdout).toContain('error SERVICE_ID_RANGE');
  expect(existsSync(out)).toBe(false);
});

test(".proto's blueprint written in its form, and its set beside it", () => {
  const out = test.info().outputPath('fixtures.blueprint.json');
  const set = test.info().outputPath('fixtures.binpb');
  const run = beadc(['blueprint', FIXTURES, '-o', out, '--descriptor-set-out', set]);

  expect(run.stdout + run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(beadc(['blueprint', '--check', out]).status).toBe(0);
  expect(beadc(['blueprint', '--check', FIXTURES, '-o', out]).status).toBe(0);
  expect(existsSync(set)).toBe(true);
});

test('a call beadc cannot take exits 2', () => {
  expect(beadc([]).status).toBe(2);
  expect(beadc(['generate']).status).toBe(2);
  expect(beadc(['check', '--no-such-flag', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--except', 'NAME_FORM', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--except', 'NO_SUCH_RULE', INTEROP]).status).toBe(2);
  expect(beadc(['check', '--error-format', 'xml', INTEROP]).status).toBe(2);
  expect(beadc(['check', 'no-such-file.json']).status).toBe(2);
  expect(beadc(['blueprint', INTEROP]).status).toBe(2);
});

test('a warning fails under --fail-on-warning, and --except leaves it out', () => {
  const newer = test.info().outputPath('newer.json');

  writeFileSync(
    newer,
    readFileSync(INTEROP, 'utf8').replace(/"specVersion": "[^"]*"/u, '"specVersion": "99.0.0"')
  );

  expect(beadc(['check', newer]).status).toBe(0);
  expect(beadc(['check', '--fail-on-warning', newer]).status).toBe(1);
  expect(
    beadc(['check', '--fail-on-warning', '--except', 'SPEC_VERSION_NEWER', newer]).status
  ).toBe(0);
  expect(beadc(['check', '--error-format', 'github', newer]).stdout).toMatch(
    /^::warning file=.*title=SPEC_VERSION_NEWER::/u
  );
});
