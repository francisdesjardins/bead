// ── Fuzz target: the payload codecs ───────────────────────────────────────────

// Raw bytes, as a payload, read by the `json` and the `text` codecs (spec section 17): each read
// returns, or refuses with a `SyntaxError`. What a reader returns, its writer writes: a `text`
// payload as the bytes it came in, a `json` one in a canonical form that reads back as itself. The
// C# side's `PayloadCodecsTarget` is its twin.

// dependencies

import { type JsonValue, PAYLOAD_CODECS } from '../../src/router/shared/payloads';
import { hexadecimalOf, isRefused } from './refusal';

// helpers

const isSame = (left: Uint8Array, right: Uint8Array): boolean => {
  return (
    left.length === right.length &&
    left.every((byte, index) => {
      return byte === right[index];
    })
  );
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const { json, text } = PAYLOAD_CODECS;
  let value: JsonValue = null;
  let string = '';

  if (
    !isRefused(SyntaxError, () => {
      value = json.decode(data);
    })
  ) {
    const written = json.encode(value);

    // * the canonical form is a fixed point: read again and written again, it is the same bytes
    if (!isSame(json.encode(json.decode(written)), written)) {
      throw new Error(
        `a json payload's canonical form reads back otherwise: ${hexadecimalOf(data)}`
      );
    }
  }

  if (
    !isRefused(SyntaxError, () => {
      string = text.decode(data);
    })
  ) {
    if (!isSame(text.encode(string), data)) {
      throw new Error(`a text payload is written back otherwise: ${hexadecimalOf(data)}`);
    }
  }
};
