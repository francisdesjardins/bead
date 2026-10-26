// ── Fuzz target: beadc's blueprint reader ─────────────────────────────────────

// Raw bytes as a blueprint's file, read as `beadc check` reads one: UTF-8, its JSON and I-JSON,
// its format, its features, the format's schema, then the rules that span entries; and up to its
// schema alone, as `beadc breaking` reads an earlier release's. A reading gives its findings, or
// refuses a text that is no JSON with an `InputError`. What it reads whole, it holds to its form
// as `beadc blueprint --check` does, and writes in its form as `beadc blueprint -o` does: the form
// reads back as itself, with no difference to name. beadc has no other side, so this target has
// no twin.

// dependencies

import { InputError } from '../../src/diagnostics.ts';
import { type IReading, readBlueprint } from '../../src/model/blueprint.ts';
import { formDifferencesOf, formOf } from '../../src/model/form.ts';

// constants

const FILE = 'blueprint.json';
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const ENCODER = new TextEncoder();

// helpers

// the reading of `bytes`; none for a text that is no JSON, the refusal it is designed to give
const readingOf = (bytes: Uint8Array, rules: boolean): IReading | undefined => {
  try {
    return readBlueprint(bytes, { file: FILE, rules });
  } catch (reason) {
    if (reason instanceof InputError) {
      return undefined;
    }

    throw reason;
  }
};

const hexadecimalOf = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString('hex');
};

// definition

export const fuzz = (data: Uint8Array): void => {
  readingOf(data, false);

  const blueprint = readingOf(data, true)?.blueprint;

  if (blueprint === undefined) {
    return;
  }

  formDifferencesOf(DECODER.decode(data), blueprint);

  // * the form is a fixed point: read again and written again, it is the same text
  const written = formOf(blueprint);
  const again = readingOf(ENCODER.encode(written), true)?.blueprint;

  if (
    again === undefined ||
    formOf(again) !== written ||
    formDifferencesOf(written, again).length > 0
  ) {
    throw new Error(`a blueprint's form reads back otherwise: ${hexadecimalOf(data)}`);
  }
};
