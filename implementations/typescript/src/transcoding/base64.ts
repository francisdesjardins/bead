// ── Base64 ────────────────────────────────────────────────────────────────────

// The base64 of a `bytes` field's JSON (transcoding 5.3.6, 5.6.6; RFC 4648 §4, §5): arithmetic over
// its alphabets, apart from the modules that name a wire format's numbers (decision 0057).

// constants

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// each character's six bits, the URL-safe alphabet's `-` and `_` beside the standard's `+` and `/`
const SEXTETS: ReadonlyMap<string, number> = new Map([
  ...BASE64.split('').map((character, index) => {
    return [character, index] as const;
  }),
  ['-', 62],
  ['_', 63],
]);

/** Why a text is no base64 of a `bytes` field (5.3.6), as a refusal of its JSON says. */
export const BASE64_REFUSALS = Object.freeze({
  alphabet: 'bytes of no one alphabet of base64',
  padding: 'bytes padded wrongly',
});

export type Base64Refusal = (typeof BASE64_REFUSALS)[keyof typeof BASE64_REFUSALS];

// definition

/**
 * The bytes of `text`, base64 of one alphabet, the standard's or the URL-safe one, padded correctly
 * or not at all, the bits its last character holds past its bytes whatever they are (5.3.6); or why
 * it is none.
 */
export const bytesOfBase64 = (text: string): Uint8Array | Base64Refusal => {
  const padding = /=*$/u.exec(text)?.[0].length ?? 0;
  const body = text.slice(0, text.length - padding);

  if (/[^A-Za-z0-9+/_-]/u.test(body) || (/[+/]/u.test(body) && /[-_]/u.test(body))) {
    return BASE64_REFUSALS.alphabet;
  }

  const rest = body.length % 4;

  if (rest === 1 || (padding > 0 && (padding > 2 || rest + padding !== 4))) {
    return BASE64_REFUSALS.padding;
  }

  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let count = 0;
  let index = 0;

  for (const character of body) {
    bits = (bits << 6) | (SEXTETS.get(character) ?? 0);
    count += 6;

    if (count >= 8) {
      count -= 8;
      bytes[index] = (bits >> count) & 0xff;
      index += 1;
    }
  }

  return bytes;
};

/** `bytes` in standard base64, padded (5.6.6). */
export const base64Of = (bytes: Uint8Array): string => {
  let text = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[index], bytes[index + 1], bytes[index + 2]];
    const triple = (a << 16) | (b << 8) | c;

    text += BASE64[(triple >> 18) & 63] ?? '';
    text += BASE64[(triple >> 12) & 63] ?? '';
    text += index + 1 < bytes.length ? (BASE64[(triple >> 6) & 63] ?? '') : '=';
    text += index + 2 < bytes.length ? (BASE64[triple & 63] ?? '') : '=';
  }

  return text;
};
