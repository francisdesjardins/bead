import { expect, test } from '@playwright/test';

import { NAMESPACE } from '../options.ts';

test("a namespace in beadc.yaml's words", () => {
  for (const namespace of ['Bead.Interop', 'Acme', '_Private.V1', 'A1.B_2']) {
    expect(NAMESPACE.test(namespace), namespace).toBe(true);
  }

  for (const namespace of [
    '',
    'Bead.',
    '.Bead',
    'Bead..Interop',
    '1Bead',
    'Bead.2x',
    'Bead Interop',
    'global::Bead',
  ]) {
    expect(NAMESPACE.test(namespace), namespace).toBe(false);
  }
});
