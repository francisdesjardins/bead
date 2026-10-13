import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { InputError } from '../diagnostics.ts';
import { assertRoots, displayOf, optionsCopiesOf, pathOnDisk } from '../roots.ts';

const PROTO = fileURLToPath(new URL('../../test/proto/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

test('a copy of bead/options.proto among the roots is OPTIONS_COPY, before buf compiles', () => {
  const copies = optionsCopiesOf([FIXTURES, join(PROTO, 'OPTIONS_COPY')]);

  expect(
    copies.map((copy) => {
      return [
        copy.rule,
        copy.line,
        copy.file.endsWith('test/proto/OPTIONS_COPY/bead/options.proto'),
      ];
    })
  ).toEqual([['OPTIONS_COPY', 1, true]]);
});

test('a file of the set found among the roots, and a root that is no folder refused', () => {
  expect(pathOnDisk('bead/interop/v1/interop.proto', [PROTO, FIXTURES])).toBe(
    join(FIXTURES, 'bead', 'interop', 'v1', 'interop.proto')
  );
  expect(pathOnDisk('bead/options.proto', [FIXTURES])).toBeUndefined();
  expect(() => {
    assertRoots([join(PROTO, 'no-such-root')]);
  }).toThrow(InputError);
  expect(displayOf(join(process.cwd(), 'a', 'b.proto'))).toBe('a/b.proto');
});

test("an earlier's root that holds no .proto, as git archive writes a submodule, is named from its folder with the cause", () => {
  const folder = test.info().outputPath('earlier');

  mkdirSync(join(folder, 'proto', 'empty'), { recursive: true });

  for (const root of ['proto', 'missing']) {
    expect(() => {
      assertRoots([join(folder, root)], { from: folder });
    }).toThrow(
      `${root}: no folder of .proto files; git archive writes a submodule as an empty folder, and leaves a link and what export-ignore names out`
    );
  }

  // the current's roots, as the call named them: an empty one is buf's to refuse
  expect(() => {
    assertRoots([join(folder, 'proto')]);
  }).not.toThrow();
});
