import { expect, test } from '@playwright/test';
import {
  blend,
  ECLIPSE_MS,
  eclipseAt,
  FACE_NAMES,
  FACES,
  keyframesOf,
  readingAt,
  type IEclipse,
  type IFace,
} from '../mascot';

// helpers

/** Each bead's opacity, then the flare's and the corona's, to three places. */
const lightsOf = ({ beads, flare, corona }: IEclipse): number[] => {
  return [
    ...beads.map(({ opacity }) => {
      return opacity;
    }),
    flare,
    corona,
  ].map((value) => {
    return Math.round(value * 1000) / 1000;
  });
};

// definition

test.describe('the mascot', () => {
  test('draws six faces on one skeleton, each part of each as long as the listening face’s', () => {
    expect(FACE_NAMES).toEqual([
      'listening',
      'focused',
      'surprised',
      'happy',
      'mischief',
      'serene',
    ]);
    const parts = Object.keys(FACES.listening) as (keyof IFace)[];

    for (const name of FACE_NAMES) {
      for (const part of parts) {
        expect(FACES[name][part].length, `${name}.${part}`).toBe(FACES.listening[part].length);
      }
    }
  });

  test('blends two faces point by point, halfway at the midpoint between their keyframes', () => {
    const halfway = blend(FACES.listening, FACES.focused, { by: 0.5 });

    [10.2, 18.05, 1.35, 1.8, 1.8].forEach((value, index) => {
      expect(halfway.eL[index]).toBeCloseTo(value, 9);
    });
    expect(halfway.g[0]).toBe(0.5);
    expect(halfway.bR[6]).toBe(0.5);

    const keyframes = keyframesOf([
      { top: 0, height: 400, face: 'listening' },
      { top: 400, height: 600, face: 'focused' },
      { top: 1000, height: 200, face: null },
    ]);

    expect(keyframes).toEqual([
      { at: 200, face: 'listening' },
      { at: 700, face: 'focused' },
      { at: 1100, face: 'listening' },
    ]);
    expect(readingAt(keyframes, 450)).toEqual({ from: 'listening', to: 'focused', t: 0.5 });
    expect(readingAt(keyframes, 100)).toEqual({ from: 'listening', to: 'listening', t: 0 });
    expect(readingAt(keyframes, 1500)).toEqual({ from: 'listening', to: 'listening', t: 0 });
  });

  test('changes the face at once at mid-way when motion is reduced', () => {
    const keyframes = keyframesOf([
      { top: 0, height: 400, face: 'surprised' },
      { top: 400, height: 600, face: 'happy' },
    ]);

    expect(readingAt(keyframes, 440, { reduced: true }).t).toBe(0);
    expect(readingAt(keyframes, 460, { reduced: true }).t).toBe(1);
  });

  test('goes out bead by bead, the smallest first, flares the largest alone, and brings the three back without the flare', () => {
    // before, and after: the mark as it stands
    expect(lightsOf(eclipseAt(-1))).toEqual([1, 1, 1, 0, 0]);
    expect(lightsOf(eclipseAt(ECLIPSE_MS))).toEqual([1, 1, 1, 0, 0]);
    // the smallest out first, the middle one next, the largest still there
    expect(lightsOf(eclipseAt(1250))).toEqual([1, 1, 0, 0, 0]);
    expect(lightsOf(eclipseAt(1500)).slice(0, 3)).toEqual([0, 1, 0]);
    // the diamond ring: the largest alone flares, and goes out under it
    expect(lightsOf(eclipseAt(1950))).toEqual([0, 0, 0, 1, expect.any(Number)]);
    // totality: no bead, no flare, the corona open, the face serene
    const totality = eclipseAt(3000);

    expect(lightsOf(totality)).toEqual([0, 0, 0, 0, 1]);
    expect(totality.serene).toBe(1);
    // the return: one after another where they were, and no flare with them
    for (let at = 4500; at < ECLIPSE_MS; at += 50) {
      expect(eclipseAt(at).flare, `${String(at)} ms`).toBe(0);
    }
    expect(lightsOf(eclipseAt(5850))).toEqual([1, 0.486, 0, 0, 0]);
    expect(lightsOf(eclipseAt(ECLIPSE_MS - 1)).slice(0, 3)).toEqual([1, 1, 0.997]);
  });

  test('plays the corona alone when motion is reduced', () => {
    for (const at of [0, 1500, 1950, 2999]) {
      expect(lightsOf(eclipseAt(at, { reduced: true })), `${String(at)} ms`).toEqual([
        1, 1, 1, 0, 1,
      ]);
    }
    expect(lightsOf(eclipseAt(3000, { reduced: true }))).toEqual([1, 1, 1, 0, 0]);
  });
});
