// ── Demo glyph ────────────────────────────────────────────────────────────────

// A glyph drawn at random, as the raw pixels a canvas takes: 1448 × 1448, four bytes each — some
// eight mebibytes, which cross as a transfer of eight chunks or so, credited as they come.
// Symmetric, as an identicon is, so the eye reads one figure rather than noise; drawn with Web
// Crypto's randomness alone, so the page, a worker and Node draw it alike.

// constants

/** A glyph's side, in pixels: eight cells of 181. */
export const GLYPH_SIDE = 1448;

/** A glyph's bytes: four a pixel, red, green, blue and alpha. */
export const GLYPH_BYTES = GLYPH_SIDE * GLYPH_SIDE * 4;

/** The cells a side holds; the left half is drawn, and the right half mirrors it. */
const CELLS = 8;

const CELL = GLYPH_SIDE / CELLS;

/** How far a cell's figure stands in from its edges, and how round its corners are, in pixels. */
const INSET = CELL * 0.08;
const RADIUS = CELL * 0.3;

/** The most `getRandomValues` fills at once. */
const RANDOM_BYTES = 65_536;

// helpers

const randomOf = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);

  for (let start = 0; start < length; start += RANDOM_BYTES) {
    crypto.getRandomValues(bytes.subarray(start, start + RANDOM_BYTES));
  }

  return bytes;
};

/** A colour of `hue` in degrees, and of `saturation` and `lightness` from 0 to 1, as red, green, blue. */
const rgbOf = (
  hue: number,
  { lightness, saturation }: { lightness: number; saturation: number }
): [number, number, number] => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channelOf = (offset: number): number => {
    const turn = (offset + hue / 30) % 12;

    return Math.round(
      255 * (lightness - chroma / 2 + (chroma / 2) * Math.max(-1, Math.min(turn - 3, 9 - turn, 1)))
    );
  };

  return [channelOf(0), channelOf(8), channelOf(4)];
};

/** Whether a point of a cell, from its corner, falls in the rounded square that fills it. */
const isInside = (x: number, y: number): boolean => {
  const low = INSET + RADIUS;
  const high = CELL - INSET - RADIUS;

  if (x < INSET || y < INSET || x > CELL - INSET || y > CELL - INSET) {
    return false;
  }

  // in a corner's square, only what its quarter circle holds
  const dx = x < low ? low - x : x > high ? x - high : 0;
  const dy = y < low ? low - y : y > high ? y - high : 0;

  return dx * dx + dy * dy <= RADIUS * RADIUS;
};

// definition

/** A glyph drawn at random: {@link GLYPH_BYTES} of pixels, row after row. */
export const drawGlyph = (): Uint8Array<ArrayBuffer> => {
  const seed = randomOf(2 + (CELLS * CELLS) / 2);
  const noise = randomOf(GLYPH_SIDE * GLYPH_SIDE);
  const hue = ((seed[0] ?? 0) / 256) * 360;
  // the figure and its ground, of one hue, and a second hue for some of its cells
  const figure = rgbOf(hue, { lightness: 0.62, saturation: 0.7 });
  const accent = rgbOf((hue + 150) % 360, { lightness: 0.68, saturation: 0.75 });
  const ground = rgbOf(hue, { lightness: 0.1, saturation: 0.35 });
  const half = CELLS / 2;
  // each cell of the left half, from the seed: empty, the figure's, or the accent's
  const cells = Array.from({ length: CELLS * half }, (_, index) => {
    const draw = (seed[2 + index] ?? 0) % 5;

    return draw < 2 ? undefined : draw === 4 ? accent : figure;
  });
  const pixels = new Uint8Array(GLYPH_BYTES);

  for (let y = 0; y < GLYPH_SIDE; y += 1) {
    const row = Math.floor(y / CELL);

    for (let x = 0; x < GLYPH_SIDE; x += 1) {
      const column = Math.floor(x / CELL);
      // the right half mirrors the left
      const drawn = cells[row * half + (column < half ? column : CELLS - 1 - column)];
      const within = drawn !== undefined && isInside(x % CELL, y % CELL);
      // lit from above, and grained, so it reads as a thing and never as flat fields
      const light = within ? 1.12 - 0.24 * ((y % CELL) / CELL) : 1;
      const grain = ((noise[y * GLYPH_SIDE + x] ?? 128) - 128) / 16;
      const [red, green, blue] = within ? drawn : ground;
      const at = (y * GLYPH_SIDE + x) * 4;

      pixels[at] = Math.max(0, Math.min(255, red * light + grain));
      pixels[at + 1] = Math.max(0, Math.min(255, green * light + grain));
      pixels[at + 2] = Math.max(0, Math.min(255, blue * light + grain));
      pixels[at + 3] = 255;
    }
  }

  return pixels;
};
