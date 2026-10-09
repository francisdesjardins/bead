import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { InputError } from '../../diagnostics.ts';
import { extractArchive } from '../archive.ts';

// a tar git archive wrote of a folder: a beadc.yaml, the interop's blueprint, a file whose name is
// past the 100 bytes a ustar header holds, and a symbolic link
const ARCHIVE = new URL('../../../test/breaking/archive/archive.tar', import.meta.url);
const LONG_NAME =
  'a-file-whose-one-name-is-past-the-hundred-bytes-a-ustar-name-holds-so-that-git-archive-writes-a-pax-header.txt';
const BLOCK = 512;
// the header of beadc.yaml, the archive's first entry after its global header, and the end's first
// zero block
const FIRST_FILE = 1024;
const END = 13_824;

const archive = (): Uint8Array => {
  return new Uint8Array(readFileSync(ARCHIVE));
};

// `bytes` with the header at `at` naming `name`, its checksum written again as ustar writes it
const renamed = (
  bytes: Uint8Array,
  details: { readonly at: number; readonly name: string }
): Uint8Array => {
  const copy = bytes.slice();
  const header = copy.subarray(details.at, details.at + BLOCK);

  header.fill(0, 0, 100);
  header.set(new TextEncoder().encode(details.name), 0);
  header.fill(0x20, 148, 156);

  const sum = header.reduce((total, byte) => {
    return total + byte;
  }, 0);

  header.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return copy;
};

test("git archive's tar of a folder gives its files, a long path through its pax header", () => {
  const into = test.info().outputPath('archive');
  const written = extractArchive(archive(), { into });

  expect(written).toEqual(['beadc.yaml', 'interop-blueprint.json', `long/${LONG_NAME}`]);
  expect(readFileSync(join(into, 'long', LONG_NAME), 'utf8')).toBe(
    'A file whose name is past 100 bytes, which a pax header gives.\n'
  );
  expect(readFileSync(join(into, 'beadc.yaml'), 'utf8')).toContain(
    'blueprint: interop-blueprint.json'
  );
});

test('a link is not written', () => {
  const into = test.info().outputPath('archive');

  extractArchive(archive(), { into });

  expect(existsSync(join(into, 'link-to-the-blueprint'))).toBe(false);
});

test('an absolute path, a .. and a truncated archive are refused', () => {
  const into = test.info().outputPath('refused');
  const bytes = archive();

  // the fixture as it is, first, renamed to itself: the checksum is written as ustar writes it
  expect(
    extractArchive(renamed(bytes, { at: FIRST_FILE, name: 'beadc.yaml' }), { into })
  ).toHaveLength(3);

  for (const name of ['/etc/beadc.yaml', '../beadc.yaml', 'a/../../beadc.yaml', 'C:/beadc.yaml']) {
    expect(() => {
      return extractArchive(renamed(bytes, { at: FIRST_FILE, name }), { into });
    }, name).toThrow(/a path outside its folder/u);
  }

  // cut within an entry, after an entry, before the end, and before the end's second zero block
  for (const length of [FIRST_FILE + BLOCK + 20, 2 * FIRST_FILE, END, END + BLOCK, 0]) {
    expect(() => {
      return extractArchive(bytes.subarray(0, length), { into });
    }, String(length)).toThrow(InputError);
  }

  const off = bytes.slice();

  off[FIRST_FILE] = 0x41;
  expect(() => {
    return extractArchive(off, { into });
  }).toThrow(/checksum/u);
});
