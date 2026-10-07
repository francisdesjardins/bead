import { expect, test } from '@playwright/test';
import { PREVIEW_CHARACTERS, previewOf } from '../preview';

// definition

test.describe('previewOf', () => {
  test('reads a text as itself, and the rest in JSON’s form where it has one', () => {
    expect(previewOf('hello\n"you"')).toBe('hello\n"you"');
    expect(previewOf('')).toBe('""');
    expect(previewOf(undefined)).toBeUndefined();
    expect(previewOf(null)).toBe('null');
    expect(previewOf(42)).toBe('42');
    expect(previewOf(12n)).toBe('12n');
    expect(previewOf({ a: [1, 'b', true], c: null })).toBe('{"a": [1, "b", true], "c": null}');
    expect(previewOf(new Map([['k', 1]]))).toBe('Map {"k" => 1}');
    expect(previewOf(new Set([1]))).toBe('Set {1}');
    expect(previewOf(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(previewOf(new TypeError('no'))).toBe('TypeError: no');
    expect(previewOf(() => {})).toBe('[function]');
  });

  test('shows bytes by their length and their first 32 in hexadecimal', () => {
    expect(previewOf(new Uint8Array([0, 15, 255]))).toBe('<3 bytes: 00 0f ff>');
    expect(previewOf(new Uint8Array(0))).toBe('<0 bytes>');
    expect(previewOf(new Uint8Array(40).fill(1))).toBe(
      `<40 bytes: ${Array.from({ length: 32 }, () => {
        return '01';
      }).join(' ')} …>`
    );
    expect(previewOf(new Uint8Array([1, 2]).buffer)).toBe('<2 bytes: 01 02>');
  });

  test('cuts short what nests past four levels and fifty entries, and names a cycle', () => {
    const cycle: Record<string, unknown> = {};

    cycle['self'] = cycle;

    expect(previewOf({ a: { b: { c: { d: { e: 1 } } } } })).toBe('{"a": {"b": {"c": {"d": {…}}}}}');
    expect(
      previewOf(
        Array.from({ length: 52 }, (_, index) => {
          return index;
        })
      )
    ).toMatch(/, 49, … 2 more\]$/);
    expect(previewOf(cycle)).toBe('{"self": [cycle]}');
  });

  test('holds PREVIEW_CHARACTERS at most, walking no further than its budget into a large payload', () => {
    const large = Array.from({ length: 50 }, () => {
      return Array.from({ length: 50 }, () => {
        return Array.from({ length: 50 }, () => {
          return 'x'.repeat(100);
        });
      });
    });

    for (const value of [large, 'y'.repeat(PREVIEW_CHARACTERS * 10)]) {
      const preview = previewOf(value) ?? '';

      expect(preview.length).toBeLessThanOrEqual(PREVIEW_CHARACTERS + 1);
      expect(preview.endsWith('…')).toBe(true);
    }
  });
});
