import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { checkRoots } from '../../check.ts';
import { formOf } from '../../model/form.ts';
import { specVersion } from '../../version.ts';
import { descriptionOf } from '../comments.ts';
import { COMMENTS_PROTO, deriveRoot, toCrlf } from './derive.ts';

const GOLDEN = new URL('../../../test/golden/comments.blueprint.json', import.meta.url);

test('the comments fixture gives its golden blueprint, in LF, in CRLF and after a byte order mark', () => {
  // a golden holds what the code writes, and a release moves the spec's version: today's, then
  const golden = readFileSync(GOLDEN, 'utf8').replace(
    /"specVersion": "[^"]*"/u,
    `"specVersion": "${specVersion()}"`
  );
  const variants = [
    [
      'lf',
      (text: string): string => {
        return text;
      },
    ],
    ['crlf', toCrlf],
    [
      'byte-order-mark',
      (text: string): string => {
        return `\uFEFF${text}`;
      },
    ],
  ] as const;

  for (const [root, change] of variants) {
    const checked = checkRoots([deriveRoot(COMMENTS_PROTO, { root, change })], {
      files: [COMMENTS_PROTO],
    });

    expect(checked.diagnostics, root).toEqual([]);
    expect(formOf(checked.blueprint), root).toBe(golden);
  }
});

test('a leading comment to a description, by its one rule', () => {
  expect(descriptionOf(' One line.\n')).toBe('One line.');
  expect(descriptionOf(' First,\n second.\n\n Another.\n')).toBe('First, second.\n\nAnother.');
  expect(descriptionOf(' Trimmed.   \r\n')).toBe('Trimmed.');
  expect(descriptionOf('   Two spaces kept.\n')).toBe('  Two spaces kept.');
  expect(descriptionOf('\n')).toBeUndefined();
  expect(descriptionOf('')).toBeUndefined();
});
