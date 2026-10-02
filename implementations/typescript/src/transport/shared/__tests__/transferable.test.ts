import { expect, test } from '@playwright/test';
import { transferableOf } from '../transferable';

// definition

test.describe('transferableOf', () => {
  test('copies bytes into a buffer of their own, a view’s alone, and gives none for what is no bytes', () => {
    const buffer = Uint8Array.of(1, 2, 3).buffer;
    const copied = transferableOf(buffer);
    const pooled = Uint8Array.of(9, 8, 7, 6);
    const view = transferableOf(pooled.subarray(1, 3));

    expect([copied === buffer, [...new Uint8Array(copied ?? new ArrayBuffer(0))]]).toEqual([
      false,
      [1, 2, 3],
    ]);
    expect([...new Uint8Array(view ?? new ArrayBuffer(0))]).toEqual([8, 7]);
    expect(view?.byteLength).toBe(2);
    expect(transferableOf('text')).toBeUndefined();
  });
});
