import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { InputError } from '../diagnostics.ts';
import { compile, OPTIONS_ROOT } from '../compile.ts';
import {
  assertRoots,
  displayOf,
  HTTP_FILES,
  httpPins,
  optionsCopiesOf,
  pathOnDisk,
} from '../roots.ts';

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

test("beadc's googleapis pair is the pin's bytes, at googleapis' commit", () => {
  const pins = JSON.parse(readFileSync(join(OPTIONS_ROOT, 'pins.json'), 'utf8')) as Record<
    string,
    { from: string; sha256: string }
  >;

  expect(Object.keys(pins).sort()).toEqual([...HTTP_FILES].sort());

  for (const file of HTTP_FILES) {
    expect(
      createHash('sha256')
        .update(readFileSync(join(OPTIONS_ROOT, file)))
        .digest('hex'),
      file
    ).toBe(httpPins().get(file));
    expect(pins[file]?.from).toContain('14a161a98ef045be80c12ab69d924504a756f109');
  }
});

test("a root's copy of googleapis' pair stands for beadc's where both are the pin's, CRLF read as LF; one off its pin, or one alone, is HTTP_COPY", () => {
  const rootOf = (name: string, files: Readonly<Record<string, Buffer>>): string => {
    const root = test.info().outputPath(name);

    for (const [file, bytes] of Object.entries(files)) {
      mkdirSync(join(root, 'google', 'api'), { recursive: true });
      writeFileSync(join(root, ...file.split('/')), bytes);
    }

    mkdirSync(join(root, 'x', 'v1'), { recursive: true });
    cpSync(
      join(PROTO, 'HTTP_GET_UNMARKED', 'x', 'v1', 'x.proto'),
      join(root, 'x', 'v1', 'x.proto')
    );

    return root;
  };
  const pinned = (file: string): Buffer => {
    return readFileSync(join(OPTIONS_ROOT, ...file.split('/')));
  };
  const [annotations = '', http = ''] = HTTP_FILES;
  const crlf = rootOf('crlf', {
    [annotations]: Buffer.from(
      pinned(annotations).toString('latin1').replaceAll('\n', '\r\n'),
      'latin1'
    ),
    [http]: pinned(http),
  });

  expect(optionsCopiesOf([crlf])).toEqual([]);
  // * buf builds the roots' pair in place of beadc's, which it would refuse in two modules
  expect(compile([crlf]).length).toBeGreaterThan(0);

  const alone = rootOf('alone', { [http]: pinned(http) });
  const off = rootOf('off', {
    [annotations]: pinned(annotations),
    [http]: Buffer.concat([pinned(http), Buffer.from('\n')]),
  });

  expect(
    [...optionsCopiesOf([alone]), ...optionsCopiesOf([off])].map((copy) => {
      return [copy.rule, copy.message.split(':')[0]];
    })
  ).toEqual([
    ['HTTP_COPY', 'a copy of google/api/http.proto among the roots without its pair'],
    [
      'HTTP_COPY',
      "a copy of google/api/http.proto among the roots that is not googleapis' own at the commit beadc vendors",
    ],
  ]);
});
