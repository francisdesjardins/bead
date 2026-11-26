import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  blend,
  CORONA,
  CORONA_LIGHT,
  ECLIPSE_MS,
  eclipseAt,
  FACE_NAMES,
  FACE_SCALE,
  FACES,
  keyframesOf,
  MONOCLE,
  readingAt,
  STROKES,
  type IEclipse,
  type IFace,
} from '../mascot';

// helpers

/** Each bead's light, then the flare's and the corona's, to three places. */
const lightsOf = ({ beads, flare, corona }: IEclipse): number[] => {
  return [
    ...beads.map(({ light }) => {
      return light;
    }),
    flare,
    corona,
  ].map((value) => {
    return Math.round(value * 1000) / 1000;
  });
};

interface IPoint {
  readonly x: number;
  readonly y: number;
}

/** Points along an eye's two cubics, as the drawing traces them from its skeleton. */
const eyePointsOf = ([
  cx = 0,
  cy = 0,
  rx = 0,
  top = 0,
  bottom = 0,
]: readonly number[]): IPoint[] => {
  const points: IPoint[] = [];
  for (const [rise, side] of [
    [-top, 1],
    [bottom, -1],
  ] as const) {
    for (let step = 0; step <= 200; step += 1) {
      const t = step / 200;
      const along = (1 - t) ** 3 * -1 + 3 * (1 - t) ** 2 * t * -1 + 3 * (1 - t) * t ** 2 + t ** 3;
      points.push({
        x: cx + side * rx * along,
        y: cy + rise * 3 * (1 - t) * t,
      });
    }
  }
  return points;
};

/**
 * The clear gap between a pupil and its eye's ring, in the skeleton's units: from the pupil's edge
 * to the ring's inner edge; negative where they overlap.
 */
const pupilGapOf = (eye: readonly number[], [x = 0, y = 0, r = 0]: readonly number[]): number => {
  const nearest = Math.min(
    ...eyePointsOf(eye).map((point) => {
      return Math.hypot(point.x - x, point.y - y);
    })
  );
  return nearest - STROKES.eye / 2 - r;
};

/** The contrast ratio of two sRGB colours, as WCAG 2 defines it. */
const contrastOf = (first: readonly number[], second: readonly number[]): number => {
  const luminance = (rgb: readonly number[]): number => {
    const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => {
    return b - a;
  });
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

const rgbOf = (hex: string): number[] => {
  return [1, 3, 5].map((at) => {
    return Number.parseInt(hex.slice(at, at + 2), 16);
  });
};

/** `colour` at `alpha` over `ground`, as the page composites it. */
const overOf = (
  colour: readonly number[],
  { alpha, ground }: { readonly alpha: number; readonly ground: readonly number[] }
): number[] => {
  return colour.map((channel, index) => {
    return channel * alpha + (ground[index] ?? 0) * (1 - alpha);
  });
};

/** The light theme's grounds, from the skin's root: the page's and its bar's. */
const lightGroundsOf = (): Record<string, string> => {
  const sheet = readFileSync(new URL('../tokens.skin.css', import.meta.url), 'utf8');
  const root = sheet.slice(sheet.indexOf(':root {'), sheet.indexOf('}', sheet.indexOf(':root {')));
  return Object.fromEntries(
    ['--app-bg', '--app-paper'].map((token) => {
      const value = new RegExp(`${token}: (#[0-9a-f]{6});`, 'u').exec(root)?.[1];
      return [token, value ?? ''];
    })
  );
};

// each eye and its pupil, the left and the right
const SIDES = [
  [
    (face: IFace): readonly number[] => {
      return face.eL;
    },
    (face: IFace): readonly number[] => {
      return face.pL;
    },
  ],
  [
    (face: IFace): readonly number[] => {
      return face.eR;
    },
    (face: IFace): readonly number[] => {
      return face.pR;
    },
  ],
] as const;
// the least clear gap between a pupil and its ring, in the skeleton's units
const PUPIL_GAP = 0.2;
// the bar's mark: its 25 units at 36 px, each of its strokes 1.2 px whatever its scale
const BAR_PX = (36 / 25) * FACE_SCALE;
const BAR_STROKE_PX = 1.2;

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

    [10.2, 18.05, 1.3, 1.73, 1.73].forEach((value, index) => {
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

  test('lights every bead and the rim without a jump, sampled every 2 ms from rest to rest', () => {
    // the fastest change is a bead going out, its whole light in 250 ms: 0.008 in 2 ms
    const bound = 0.01;
    let last = eclipseAt(-2);

    for (let at = 0; at <= ECLIPSE_MS + 2; at += 2) {
      const now = eclipseAt(at);
      const steps = [
        ...now.beads.map(({ light }, index) => {
          return Math.abs(light - (last.beads[index]?.light ?? 1));
        }),
        Math.abs(now.rim.from - last.rim.from),
        Math.abs(now.rim.to - last.rim.to),
      ];

      expect(Math.max(...steps), `${String(at)} ms`).toBeLessThanOrEqual(bound);
      last = now;
    }
  });

  test('draws the rim back to the largest bead as the end beads go out, and grows it back as the corona closes', () => {
    expect(eclipseAt(-1).rim).toEqual({ from: 0, to: 1 });
    // the last bead out, the rim ends at the largest
    expect(eclipseAt(1250).rim).toEqual({ from: 0, to: 0.5 });
    // the first out too: the rim drawn back to nothing, before the corona opens
    expect(eclipseAt(1500).rim).toEqual({ from: 0.5, to: 0.5 });
    expect(eclipseAt(3000).rim).toEqual({ from: 0.5, to: 0.5 });
    // the corona shut, the rim whole again, the beads not yet back
    expect(eclipseAt(4500).rim).toEqual({ from: 0, to: 1 });
    expect(lightsOf(eclipseAt(4500)).slice(0, 3)).toEqual([0, 0, 0]);
    // with reduced motion, gone while the corona is open
    expect(eclipseAt(1000, { reduced: true }).rim).toEqual({ from: 0.5, to: 0.5 });
    expect(eclipseAt(3000, { reduced: true }).rim).toEqual({ from: 0, to: 1 });
  });

  test('keeps every pupil inside its eye and clear of its ring, on every face and between them', () => {
    for (const [eyeOf, pupilOf] of SIDES) {
      // the faces with a pupil in this eye: a wink's has none
      const open = FACE_NAMES.filter((name) => {
        return (pupilOf(FACES[name])[2] ?? 0) > 0;
      });

      expect(open.length).toBeGreaterThanOrEqual(3);
      for (const [name, face] of open.flatMap((from) => {
        return open.flatMap((to) => {
          return [0, 0.25, 0.5, 0.75].map((by) => {
            return [
              `${from} to ${to} by ${String(by)}`,
              blend(FACES[from], FACES[to], { by }),
            ] as const;
          });
        });
      })) {
        const eye = eyeOf(face);
        const pupil = pupilOf(face);
        // inside: nearer its eye's centre than the eye is wide
        expect(
          Math.hypot((pupil[0] ?? 0) - (eye[0] ?? 0), (pupil[1] ?? 0) - (eye[1] ?? 0)),
          name
        ).toBeLessThan(eye[2] ?? 0);
        expect(pupilGapOf(eye, pupil), name).toBeGreaterThanOrEqual(PUPIL_GAP);
      }
    }
  });

  test('keeps the monocle’s ring apart from its eye’s, a gap open in the bar’s 36 px', () => {
    const [cx = 0, cy = 0] = FACES.focused.eR;

    expect([MONOCLE.x, MONOCLE.y]).toEqual([cx, cy]);
    const widest = Math.max(
      ...eyePointsOf(FACES.focused.eR).map((point) => {
        return Math.hypot(point.x - cx, point.y - cy);
      })
    );
    // in the bar, a pixel or more between the two strokes
    expect((MONOCLE.r - widest) * BAR_PX - BAR_STROKE_PX).toBeGreaterThanOrEqual(1);
  });

  test('paints the corona and the flare at 3:1 or more on the light theme’s page and bar', () => {
    const grounds = lightGroundsOf();

    for (const [token, hex] of Object.entries(grounds)) {
      expect(hex, token).toMatch(/^#[0-9a-f]{6}$/u);
      const ground = rgbOf(hex);

      expect(
        contrastOf(rgbOf(CORONA_LIGHT.ray), ground),
        `rays on ${token}`
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastOf(rgbOf(CORONA_LIGHT.flare), ground),
        `flare on ${token}`
      ).toBeGreaterThanOrEqual(3);
      const halo = overOf(rgbOf(CORONA_LIGHT.halo), {
        alpha: CORONA_LIGHT.haloOpacity,
        ground,
      });

      expect(contrastOf(halo, ground), `halo on ${token}`).toBeGreaterThanOrEqual(3);
    }
  });

  test('centres the corona’s box on the disc, every ray and the halo inside it', () => {
    const { box, centre, halo, rays, rayWidth } = CORONA;

    expect(box.x + box.width / 2).toBeCloseTo(centre.x, 9);
    expect(box.y + box.height / 2).toBeCloseTo(centre.y, 9);
    // each ray's tip, its round cap included, and the halo's outer edge
    const reaches = [
      ...rays.map(({ x2, y2 }) => {
        return { x: x2, y: y2, r: rayWidth / 2 };
      }),
      { x: centre.x, y: centre.y, r: halo.r + halo.width / 2 },
    ];

    for (const { x, y, r } of reaches) {
      expect(x - r).toBeGreaterThanOrEqual(box.x);
      expect(x + r).toBeLessThanOrEqual(box.x + box.width);
      expect(y - r).toBeGreaterThanOrEqual(box.y);
      expect(y + r).toBeLessThanOrEqual(box.y + box.height);
    }
  });
});
