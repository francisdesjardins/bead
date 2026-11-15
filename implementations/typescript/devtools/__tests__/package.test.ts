import { expect, test } from '@playwright/test';
import { crc32 } from 'node:zlib';
import {
  contentRefusals,
  FILES,
  filesOf,
  type IZipEntry,
  treeRefusals,
  zipNameOf,
  zipOf,
} from '../package';

// interfaces

/** An entry as a reader finds it, through the central directory. */
interface IRead {
  name: string;
  bytes: Buffer;
  method: number;
  time: number;
  date: number;
  attributes: number;
}

// helpers

const encoder = new TextEncoder();

const entryOf = (name: string, text: string): IZipEntry => {
  return { name, bytes: encoder.encode(text) };
};

/** A zip read as a reader reads it: its end, then its directory, then each entry's local header. */
const readZip = (zip: Uint8Array): IRead[] => {
  const bytes = Buffer.from(zip);
  const end = bytes.length - 22;

  expect(bytes.readUInt32LE(end)).toBe(0x06_05_4b_50);

  const count = bytes.readUInt16LE(end + 10);
  const read: IRead[] = [];
  let at = bytes.readUInt32LE(end + 16);

  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(at)).toBe(0x02_01_4b_50);

    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(start, start + size);

    expect(bytes.readUInt32LE(local)).toBe(0x04_03_4b_50);
    expect(crc32(content)).toBe(bytes.readUInt32LE(at + 16));
    read.push({
      attributes: bytes.readUInt32LE(at + 38),
      bytes: content,
      date: bytes.readUInt16LE(at + 14),
      method: bytes.readUInt16LE(at + 10),
      name,
      time: bytes.readUInt16LE(at + 12),
    });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }

  return read;
};

// definition

test.describe('the DevTools zip', () => {
  test('holds the list’s files, sorted, and refuses one the list does not know, a source map or a test among them', () => {
    expect(filesOf([...FILES].reverse())).toEqual([...FILES].sort());
    expect(() => {
      return filesOf([...FILES, 'panel.js.map']);
    }).toThrow(/does not know: panel\.js\.map/u);
    expect(() => {
      return filesOf([...FILES, '__tests__/panel.test.ts']);
    }).toThrow(/does not know: __tests__\/panel\.test\.ts/u);
  });

  test('refuses a build that lacks one of the list’s files', () => {
    expect(() => {
      return filesOf(
        FILES.filter((name) => {
          return name !== 'hook.js';
        })
      );
    }).toThrow(/lacks hook\.js/u);
  });

  test('is the same bytes for the same files in any order, each stored at one fixed time', () => {
    const entries = [
      entryOf('panel.html', '<!doctype html>\n'),
      entryOf('icons/icon-16.png', 'a mark'),
      entryOf('manifest.json', '{"version":"1.2.3"}\n'),
    ];
    const zip = zipOf(entries);

    expect(Buffer.from(zipOf([...entries].reverse())).equals(Buffer.from(zip))).toBe(true);

    const read = readZip(zip);

    expect(
      read.map(({ name }) => {
        return name;
      })
    ).toEqual(['icons/icon-16.png', 'manifest.json', 'panel.html']);
    for (const entry of read) {
      expect(entry).toMatchObject({ attributes: 0, date: (1 << 5) | 1, method: 0, time: 0 });
      expect(entry.bytes.toString('utf8')).toBe(
        new TextDecoder().decode(
          entries.find(({ name }) => {
            return name === entry.name;
          })?.bytes
        )
      );
    }
  });

  test('refuses a manifest of another version than the package’s, and a text file with a CR', () => {
    expect(contentRefusals([entryOf('manifest.json', '{"version":"0.13.0"}\n')], '0.13.0')).toEqual(
      []
    );
    expect(
      contentRefusals([entryOf('manifest.json', '{"version":"%VERSION%"}\n')], '0.13.0')[0]
    ).toMatch(/version %VERSION%, not 0\.13\.0/u);
    expect(contentRefusals([entryOf('panel.html', '<p>\r\n')], '0.13.0')[0]).toMatch(
      /panel\.html holds a CR/u
    );
    expect(
      contentRefusals([{ name: 'icons/icon-16.png', bytes: new Uint8Array([0x0d]) }], '1')
    ).toEqual([]);
  });

  test('refuses a tree with changes, and is named by the package’s version', () => {
    expect(
      treeRefusals(() => {
        return '';
      })
    ).toEqual([]);
    expect(
      treeRefusals(() => {
        return ' M devtools/panel.ts\n';
      })[0]
    ).toMatch(/not committed/u);
    expect(zipNameOf('0.13.0')).toBe('bead-devtools-0.13.0.zip');
  });
});
