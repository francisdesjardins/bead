// Bead's mascot: the mark, `site/src/favicon.svg`, the Moon's disc and three of Baily's beads on
// its rim, with a face engraved in light strokes in the beads' colour. One source for the page, the
// demo and the DevTools panel: the page's build inlines it as a module, the demo and the panel
// bundle it. Its geometry and its timing are pure and exported, so a test reads them in Node; what
// draws and moves it touches the document only when it is called.

// ── The faces ─────────────────────────────────────────────────────────────────

// every face on one skeleton, so that any two interpolate point by point: an eye `[cx, cy, rx, top,
// bottom]`, its two halves a cubic each (a circle of r: top = bottom = 4r/3; an arc: top =
// -bottom); a pupil `[x, y, r]`; a brow `[x1, y1, cx, cy, x2, y2, opacity]`, a quadratic; the
// mouth `[lx, ly, rx, ry, ux, uy, dx, dy]`, two quadratics from corner to corner; the monocle
// `[opacity]`, on the right eye as seen
const faceOf = (parts) => {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(parts).map(([part, values]) => {
        return [part, Object.freeze(values)];
      })
    )
  );
};

export const FACES = Object.freeze({
  // the default, and the transports: the eyes raised to the beads, waiting for what comes
  listening: faceOf({
    eL: [10.2, 18, 1.45, 1.93, 1.93],
    eR: [16.6, 18, 1.45, 1.93, 1.93],
    pL: [10.8, 17.4, 0.55],
    pR: [17.2, 17.4, 0.55],
    bL: [8.9, 15.4, 10.2, 14.9, 11.5, 15.4, 0],
    bR: [15.3, 15.4, 16.6, 14.9, 17.9, 15.4, 0],
    m: [12.2, 22.4, 14.6, 22.4, 13.4, 23.1, 13.4, 23.1],
    g: [0],
  }),
  // the spec and its conformance: the monocle, the brows flat, the eyes on the line
  focused: faceOf({
    eL: [10.2, 18.1, 1.25, 1.67, 1.67],
    eR: [16.6, 18.1, 1.25, 1.67, 1.67],
    pL: [9.85, 18.55, 0.52],
    pR: [16.25, 18.55, 0.52],
    bL: [8.7, 15.1, 10.2, 14.7, 11.7, 15.1, 1],
    bR: [15.1, 15.1, 16.6, 14.7, 18.1, 15.1, 1],
    m: [12.4, 22.5, 14.7, 22.1, 13.5, 22.7, 13.5, 22.7],
    g: [1],
  }),
  // refusals, errors, security: round eyes, the brows high, the mouth an o
  surprised: faceOf({
    eL: [10.2, 18, 1.75, 2.33, 2.33],
    eR: [16.6, 18, 1.75, 2.33, 2.33],
    pL: [10.2, 18, 0.45],
    pR: [16.6, 18, 0.45],
    bL: [8.7, 15.0, 10.2, 14.0, 11.7, 15.0, 1],
    bR: [15.1, 15.0, 16.6, 14.0, 18.1, 15.0, 1],
    m: [12.5, 22.6, 14.3, 22.6, 13.4, 21.2, 13.4, 24.0],
    g: [0],
  }),
  // a call that succeeded: the eyes two arcs, a wide smile
  happy: faceOf({
    eL: [10.2, 18.4, 1.3, 1.0, -1.0],
    eR: [16.6, 18.4, 1.3, 1.0, -1.0],
    pL: [10.2, 18.0, 0],
    pR: [16.6, 18.0, 0],
    bL: [8.9, 15.4, 10.2, 14.9, 11.5, 15.4, 0],
    bR: [15.3, 15.4, 16.6, 14.9, 17.9, 15.4, 0],
    m: [11.0, 21.5, 15.8, 21.5, 13.4, 22.6, 13.4, 24.3],
    g: [0],
  }),
  // the click: a wink, a brow raised, a smile at one corner
  mischief: faceOf({
    eL: [10.2, 18.3, 1.3, 0.8, -0.8],
    eR: [16.6, 18, 1.45, 1.93, 1.93],
    pL: [10.2, 18.0, 0],
    pR: [17.1, 17.6, 0.55],
    bL: [8.9, 15.4, 10.2, 14.9, 11.5, 15.4, 0],
    bR: [15.2, 15.4, 16.7, 14.5, 18.2, 15.1, 1],
    m: [11.6, 22.1, 16.2, 21.5, 13.6, 23.6, 13.6, 23.6],
    g: [0],
  }),
  // the end of the page, what is ahead, and totality: the eyes closed, a small smile
  serene: faceOf({
    eL: [10.2, 17.8, 1.3, -1.0, 1.0],
    eR: [16.6, 17.8, 1.3, -1.0, 1.0],
    pL: [10.2, 18.0, 0],
    pR: [16.6, 18.0, 0],
    bL: [8.9, 15.4, 10.2, 14.9, 11.5, 15.4, 0],
    bR: [15.3, 15.4, 16.6, 14.9, 17.9, 15.4, 0],
    m: [11.9, 21.9, 14.9, 21.9, 13.4, 23.2, 13.4, 23.2],
    g: [0],
  }),
});

export const FACE_NAMES = Object.freeze(Object.keys(FACES));

export const DEFAULT_FACE = 'listening';

const PARTS = Object.freeze(['eL', 'eR', 'pL', 'pR', 'bL', 'bR', 'm', 'g']);

const clamp = (t) => {
  return Math.max(0, Math.min(1, t));
};

const smooth = (t) => {
  return t * t * (3 - 2 * t);
};

/** The face `by` of the way from `from` to `to`, each value of each part interpolated alone. */
export const blend = (from, to, { by }) => {
  return Object.fromEntries(
    PARTS.map((part) => {
      return [
        part,
        from[part].map((value, index) => {
          return value + ((to[part][index] ?? value) - value) * by;
        }),
      ];
    })
  );
};

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * The keyframes on the page's axis, from its sections in their order: each section's centre holds
 * its face, and a section with none the default.
 */
export const keyframesOf = (sections) => {
  return sections.map(({ top, height, face }) => {
    return { at: top + height / 2, face: face ?? DEFAULT_FACE };
  });
};

/**
 * The face at the reading line: the two keyframes nearest it and how far it is from the first to
 * the second, smoothstepped; with reduced motion, the face changes at once at mid-way.
 */
export const readingAt = (keyframes, line, options = {}) => {
  const first = keyframes[0];
  if (first === undefined) {
    return { from: DEFAULT_FACE, to: DEFAULT_FACE, t: 0 };
  }
  let from = first;
  let to = first;
  keyframes.forEach((keyframe, index) => {
    if (keyframe.at <= line) {
      from = keyframe;
      to = keyframes[index + 1] ?? keyframe;
    }
  });
  const t = to.at > from.at ? smooth(clamp((line - from.at) / (to.at - from.at))) : 0;
  if (options.reduced === true) {
    return { from: from.face, to: to.face, t: t < 0.5 ? 0 : 1 };
  }
  return { from: from.face, to: to.face, t };
};

// ── The eclipse ───────────────────────────────────────────────────────────────

// the mark's three beads, where they stand, and when each has gone out: the smallest first
const BEADS = Object.freeze([
  Object.freeze({ x: 15.94, y: 6.97, r: 1.8, out: 1500 }),
  Object.freeze({ x: 21.64, y: 9.81, r: 2.5, out: 1950 }),
  Object.freeze({ x: 24.87, y: 15.29, r: 1.5, out: 1250 }),
]);
// the largest, which alone flares
const LARGEST = 1;
const FADE_MS = 250;
const TWINKLE_MS = 1250;
const RETURN_AT = 5500;
const RETURN_STEP = 180;
const RETURN_MS = 350;
const REDUCED_TOTALITY_MS = 3000;

/** The eclipse's length: until the last bead is back where it was. */
export const ECLIPSE_MS = RETURN_AT + (BEADS.length - 1) * RETURN_STEP + RETURN_MS;

const AT_REST = Object.freeze({
  beads: Object.freeze(
    BEADS.map(({ r }) => {
      return Object.freeze({ opacity: 1, radius: r });
    })
  ),
  flare: 0,
  corona: 0,
  mischief: 0,
  serene: 0,
});

/**
 * The eclipse `elapsed` ms after its click. The beads twinkle, then go out one by one, the
 * smallest first, until the largest alone flares, the diamond ring; at totality the corona opens
 * and the face goes serene; then the three beads come back one after another where they were. It
 * adds no bead of its own, and the flare never comes back with them. With reduced motion, it is the
 * corona alone.
 */
export const eclipseAt = (elapsed, options = {}) => {
  if (!(elapsed >= 0 && elapsed < ECLIPSE_MS)) {
    return AT_REST;
  }
  if (options.reduced === true) {
    const corona = elapsed < REDUCED_TOTALITY_MS ? 1 : 0;
    return { ...AT_REST, corona, serene: corona };
  }
  const flare = clamp((elapsed - 1500) / 300) * (1 - clamp((elapsed - 1950) / 250));
  const total = clamp((elapsed - 1900) / 500) * (1 - clamp((elapsed - 4100) / 400));
  const beads = BEADS.map(({ r, out }, index) => {
    const twinkle = elapsed < TWINKLE_MS ? 0.75 + 0.25 * Math.cos(elapsed / 160 + index * 2.1) : 1;
    const goes = clamp((elapsed - out + FADE_MS) / FADE_MS);
    const back = clamp((elapsed - (RETURN_AT + index * RETURN_STEP)) / RETURN_MS);
    return {
      opacity: clamp(twinkle * (1 - goes) + back * goes),
      radius: r * (1 - 0.35 * goes * (1 - back)),
    };
  });
  // the click's wink, gone before totality
  const mischief = smooth(clamp(elapsed / FADE_MS)) * (1 - smooth(clamp((elapsed - 1250) / 650)));
  return { beads, flare, corona: total, mischief, serene: smooth(total) };
};

// ── Drawing ───────────────────────────────────────────────────────────────────

const SVG = 'http://www.w3.org/2000/svg';
// the mark's box, and a wider one that holds the corona
const MARK_BOX = '2.6 4.7 25 25';
const CORONA_BOX = '-1 1 30 31';
const CENTRE = Object.freeze({ x: 14, y: 18 });
const RIM = 'M 15.82 7.66 A 10.5 10.5 0 0 1 24.19 15.46';
const MONOCLE =
  'M 18.75 18.1 A 2.15 2.15 0 1 1 14.45 18.1 A 2.15 2.15 0 1 1 18.75 18.1 Z M 18.55 19.05 Q 20.5 19.9 21.3 21.9';
const STYLE_ID = 'bead-mascot-style';

// the mark's colours in either theme, as `favicon.svg` has them, and the face in the beads'
const LIGHT = Object.freeze([
  ['.moon', 'fill: #17111d;'],
  ['.rim', 'fill: none; stroke: #c13584; stroke-width: 0.9;'],
  ['.bead', 'fill: #c13584;'],
  ['.flare', 'fill: #fde7f2;'],
  ['.halo', 'fill: none; stroke: #f3a6cd; stroke-width: 2.4; stroke-opacity: 0.35;'],
  ['.ray', 'fill: none; stroke: #f3a6cd; stroke-width: 0.35; stroke-linecap: round;'],
  ['.line', 'fill: none; stroke: #f3a6cd; stroke-linecap: round; stroke-linejoin: round;'],
  ['.pupil', 'fill: #f3a6cd;'],
]);
const DARK = Object.freeze([
  ['.moon', 'fill: #15111c; stroke: #6d6278; stroke-width: 0.9;'],
  ['.rim', 'stroke: #ff8bc4;'],
  ['.bead', 'fill: #ff8bc4;'],
  ['.flare', 'fill: #ffe3f1;'],
  ['.halo, .bead-moon .ray, .bead-moon .line', 'stroke: #ff8bc4;'],
  ['.pupil', 'fill: #ff8bc4;'],
]);

// each rule of `rules` on the drawing, under `scope`: the dark scheme as a script chose it, or as the
// system gives it where no script chose
const rulesOf = (rules, scope) => {
  return rules
    .map(([part, declarations]) => {
      return `${scope}.bead-moon ${part} { ${declarations} }`;
    })
    .join('\n');
};

// ! no custom property of its own: the page's build holds every one its page draws with to a sheet
// that defines it, and this sheet is a script's
const STYLE = `
.bead-moon { display: block; overflow: visible; }
${rulesOf(LIGHT, '')}
${rulesOf(DARK, ":root[data-color-scheme='dark'] ")}
@media (prefers-color-scheme: dark) {
${rulesOf(DARK, ':root:not([data-color-scheme]) ')}
}
.bead-mascot {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--app-z-mascot, 10);
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1),
    left 450ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 450ms ease;
}
.bead-mascot:focus-visible {
  outline: 2px solid var(--focus, var(--app-accent, #c13584));
  outline-offset: 2px;
  border-radius: 50%;
}
.bead-mascot[data-state='hidden'],
.bead-mascot[data-state='leaving'] {
  left: 48px;
  opacity: 0;
  pointer-events: none;
}
.bead-mascot[data-dock='bar'] {
  left: 0;
  z-index: calc(var(--app-z-topbar, 40) + 1);
}
/* ! away, it stays in the tab order, as a skip link does, and comes as it is focused: a control
   that came and went with the scroll would be one the Tab key misses */
.bead-mascot[data-dock='none'] {
  visibility: hidden;
}
.bead-mascot > .bead-moon {
  width: 100%;
  height: 100%;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .bead-mascot,
  .bead-mascot[data-state='hidden'],
  .bead-mascot[data-state='leaving'] {
    left: 0;
    transition: none;
  }
}
`;

const styled = () => {
  if (document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
};

const element = (name, attributes) => {
  const made = document.createElementNS(SVG, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    made.setAttribute(attribute, String(value));
  }
  return made;
};

const fixed = (value) => {
  return value.toFixed(3);
};

const eyeOf = ([cx, cy, rx, top, bottom]) => {
  const left = fixed(cx - rx);
  const right = fixed(cx + rx);
  const y = fixed(cy);
  const up = fixed(cy - top);
  const down = fixed(cy + bottom);
  return `M ${left} ${y} C ${left} ${up} ${right} ${up} ${right} ${y} C ${right} ${down} ${left} ${down} ${left} ${y} Z`;
};

const browOf = ([x1, y1, cx, cy, x2, y2]) => {
  return `M ${fixed(x1)} ${fixed(y1)} Q ${fixed(cx)} ${fixed(cy)} ${fixed(x2)} ${fixed(y2)}`;
};

const mouthOf = ([lx, ly, rx, ry, ux, uy, dx, dy]) => {
  return `M ${fixed(lx)} ${fixed(ly)} Q ${fixed(ux)} ${fixed(uy)} ${fixed(rx)} ${fixed(ry)} Q ${fixed(dx)} ${fixed(dy)} ${fixed(lx)} ${fixed(ly)} Z`;
};

// the diamond ring's flare, an eight-pointed star of `size` at the largest bead
const flareOf = (size) => {
  const { x, y } = BEADS[LARGEST] ?? CENTRE;
  const points = Array.from({ length: 8 }, (_, index) => {
    const angle = (index * Math.PI) / 4;
    const length = index % 2 === 0 ? 4.2 * size : 1.1 * size;
    return `${fixed(x + length * Math.cos(angle))} ${fixed(y + length * Math.sin(angle))}`;
  });
  return `M ${points.join(' L ')} Z`;
};

const onRim = (degrees, radius) => {
  const angle = (degrees * Math.PI) / 180;
  return { x: CENTRE.x + radius * Math.cos(angle), y: CENTRE.y + radius * Math.sin(angle) };
};

// the drawing, its parts by name, and the corona's when it has one
const drawingOf = (hasCorona) => {
  styled();
  const svg = element('svg', {
    class: 'bead-moon',
    viewBox: hasCorona ? CORONA_BOX : MARK_BOX,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const corona = element('g', { opacity: 0 });
  if (hasCorona) {
    corona.append(element('circle', { class: 'halo', cx: CENTRE.x, cy: CENTRE.y, r: 12.6 }));
    for (let index = 0; index < 16; index += 1) {
      const inner = onRim(index * 22.5, 11.3);
      const outer = onRim(index * 22.5, index % 2 === 0 ? 14.6 : 13.2);
      corona.append(
        element('path', {
          class: 'ray',
          d: `M ${fixed(inner.x)} ${fixed(inner.y)} L ${fixed(outer.x)} ${fixed(outer.y)}`,
        })
      );
    }
    svg.append(corona);
  }
  const rim = element('path', { class: 'rim', d: RIM, 'stroke-opacity': 0.6 });
  const beads = BEADS.map(({ x, y, r }) => {
    return element('circle', { class: 'bead', cx: x, cy: y, r });
  });
  const flare = element('path', { class: 'flare', d: flareOf(0.6), opacity: 0 });
  const parts = {
    eL: element('path', { class: 'line', 'stroke-width': 0.62 }),
    eR: element('path', { class: 'line', 'stroke-width': 0.62 }),
    pL: element('circle', { class: 'pupil' }),
    pR: element('circle', { class: 'pupil' }),
    bL: element('path', { class: 'line', 'stroke-width': 0.55 }),
    bR: element('path', { class: 'line', 'stroke-width': 0.55 }),
    g: element('path', { class: 'line', d: MONOCLE, 'stroke-width': 0.5 }),
    m: element('path', { class: 'line', 'stroke-width': 0.6 }),
  };
  svg.append(
    element('circle', { class: 'moon', cx: CENTRE.x, cy: CENTRE.y, r: 10.5 }),
    rim,
    ...beads,
    flare,
    ...Object.values(parts)
  );
  return { svg, corona, rim, beads, flare, parts };
};

// the face and the eclipse written into the drawing
const paint = (drawing, { face, eclipse }) => {
  const { parts } = drawing;
  parts.eL.setAttribute('d', eyeOf(face.eL));
  parts.eR.setAttribute('d', eyeOf(face.eR));
  for (const [part, [x, y, r]] of [
    [parts.pL, face.pL],
    [parts.pR, face.pR],
  ]) {
    part.setAttribute('cx', fixed(x));
    part.setAttribute('cy', fixed(y));
    part.setAttribute('r', fixed(Math.max(0, r)));
  }
  parts.bL.setAttribute('d', browOf(face.bL));
  parts.bL.setAttribute('opacity', fixed(face.bL[6]));
  parts.bR.setAttribute('d', browOf(face.bR));
  parts.bR.setAttribute('opacity', fixed(face.bR[6]));
  parts.g.setAttribute('opacity', fixed(face.g[0]));
  parts.m.setAttribute('d', mouthOf(face.m));
  drawing.beads.forEach((bead, index) => {
    const { opacity, radius } = eclipse.beads[index] ?? { opacity: 1, radius: 1 };
    bead.setAttribute('opacity', fixed(opacity));
    bead.setAttribute('r', fixed(radius));
  });
  drawing.flare.setAttribute('opacity', fixed(eclipse.flare));
  drawing.flare.setAttribute('d', flareOf(0.6 + 0.6 * eclipse.flare));
  drawing.corona.setAttribute('opacity', fixed(eclipse.corona));
  drawing.rim.setAttribute('stroke-opacity', fixed(0.6 * (1 - eclipse.corona)));
};

/** The mark with face `name`, still, for a page to place: an empty state's, say. */
export const drawFace = (name) => {
  const drawing = drawingOf(false);
  paint(drawing, { face: FACES[name] ?? FACES[DEFAULT_FACE], eclipse: AT_REST });
  drawing.svg.setAttribute('data-face', name);
  return drawing.svg;
};

// ── On a page ─────────────────────────────────────────────────────────────────

const LABELS = Object.freeze({
  en: 'Bead’s moon: click for an eclipse',
  fr: 'La lune de Bead : cliquer pour une éclipse',
});
// what the page leaves free around it, and the least room beside the text that holds it
const GAP = 16;
const LEAST = 96;
const MOST = 168;
// a finger's target, in the bar
const TOUCH = 44;
const ARRIVE_MS = 500;
const LEAVE_MS = 450;
// how long it stays outside every marked section before it leaves
const LINGER_MS = 6000;
const SHY_MS = 1400;
// once back, how long before a pointer sends it away again, so a click can reach it
const SHY_REST_MS = 4000;
// how far above and below it a wide block sends it away: a fast wheel's step in one frame
const REACH = 128;
// how fast it comes back once clear of a wide block, in px a millisecond
const DODGE_BACK = 0.6;
const REACT_IN_MS = 300;
const REACT_HOLD_MS = 2200;
const REACT_OUT_MS = 600;

/**
 * The mascot on the page: a button at the end of the body, hidden until the reading line, the
 * middle of the viewport, first enters a section with a face (`data-bead-face`) after a scroll.
 * Beside the text where the page leaves room, in the bar's free stretch otherwise. Its face follows
 * the scroll from section to section, `react` gives it one for a moment, and a click starts an
 * eclipse.
 */
export const mountMascot = (options = {}) => {
  const sectionsSelector = options.sections ?? 'main section[id]';
  const contentSelector = options.content ?? 'main';
  const avoidSelector =
    options.avoid ?? 'main pre, main details, main .excerpt, main table, main figure';
  const dockSelector = options.dock ?? '.topbar';

  styled();
  const root = document.documentElement;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const drawing = drawingOf(true);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bead-mascot';
  button.dataset['state'] = 'hidden';
  button.dataset['face'] = DEFAULT_FACE;
  button.append(drawing.svg);
  document.body.append(button);

  let state = 'hidden';
  let hasScrolled = false;
  let keyframes = [];
  let obstacles = [];
  let marked = new Set();
  let place = { dock: 'none', size: 0, left: 0, top: 0, room: 0, band: { top: 0, bottom: 0 } };
  let scrollMax = 1;
  let eclipseStart = null;
  let reaction = null;
  let restUntil = 0;
  let frame = null;
  let lastFace = '';
  // how far it stands clear of a wide block, and when it was last drawn
  let dodged = 0;
  let drawn = 0;
  const timers = new Map();

  // each timer by its name, and how long it waits
  const DELAYS = Object.freeze({
    arrive: ARRIVE_MS,
    leave: LINGER_MS,
    hide: LEAVE_MS,
    shy: SHY_MS,
  });

  const later = (name, run) => {
    window.clearTimeout(timers.get(name));
    timers.set(
      name,
      window.setTimeout(() => {
        timers.delete(name);
        run();
      }, DELAYS[name])
    );
  };

  const cancel = (name) => {
    window.clearTimeout(timers.get(name));
    timers.delete(name);
  };

  const isReduced = () => {
    return motion.matches;
  };

  const set = (next) => {
    state = next;
    button.dataset['state'] = next;
  };

  const label = () => {
    const language = (root.getAttribute('lang') ?? 'en').toLowerCase().startsWith('fr')
      ? 'fr'
      : 'en';
    button.setAttribute('aria-label', LABELS[language]);
  };

  // ── Its states ──

  const isShown = () => {
    return state !== 'hidden' && state !== 'leaving';
  };

  const arrive = () => {
    if (place.dock === 'none') {
      return;
    }
    cancel('leave');
    if (isShown()) {
      return;
    }
    set('arriving');
    schedule();
    later('arrive', () => {
      if (state === 'arriving') {
        set('reading');
      }
    });
  };

  const leave = () => {
    if (!isShown()) {
      return;
    }
    if (state === 'eclipse' || document.activeElement === button) {
      later('leave', leave);
      return;
    }
    set('leaving');
    later('hide', () => {
      if (state === 'leaving') {
        set('hidden');
      }
    });
  };

  // in a marked section, it comes after the first scroll and stays; outside every one, it leaves
  // after a while
  const settle = () => {
    if (marked.size > 0 && hasScrolled) {
      arrive();
    } else if (marked.size === 0 && reaction === null) {
      if (isShown() && !timers.has('leave')) {
        later('leave', leave);
      }
    }
  };

  // ── Where it is ──

  const visible = (element) => {
    return element.getClientRects().length > 0;
  };

  // the widest stretch the bar's children leave free, its brand, a label and its tools, the mascot
  // at its far end
  const barPlaceOf = (bar) => {
    const none = { dock: 'none', size: TOUCH, left: 0, top: 0 };
    if (bar === null) {
      return none;
    }
    const box = bar.getBoundingClientRect();
    const style = window.getComputedStyle(bar);
    const edges = [...bar.children]
      .filter(visible)
      .map((control) => {
        const at = control.getBoundingClientRect();
        return { left: at.left, right: at.right };
      })
      .sort((one, other) => {
        return one.left - other.left;
      });
    let from = box.left + Number.parseFloat(style.paddingLeft);
    let best = { from: 0, to: 0 };
    for (const edge of [
      ...edges,
      { left: box.right - Number.parseFloat(style.paddingRight), right: 0 },
    ]) {
      if (edge.left - from > best.to - best.from) {
        best = { from, to: edge.left };
      }
      from = Math.max(from, edge.right);
    }
    const free = best.to - best.from;
    if (free < TOUCH + 2) {
      return none;
    }
    return {
      dock: 'bar',
      size: TOUCH,
      left: best.to - TOUCH - Math.min(8, (free - TOUCH) / 2),
      top: box.top + (box.height - TOUCH) / 2,
    };
  };

  // * read once per change of the layout, never per frame: the sections' centres, what is wider
  // than the text, and where the mascot stands
  const measure = () => {
    const scrollY = window.scrollY;
    const sections = [...document.querySelectorAll(sectionsSelector)].filter(visible);
    keyframes = keyframesOf(
      sections.map((section) => {
        const box = section.getBoundingClientRect();
        const face = section.getAttribute('data-bead-face');
        return {
          top: box.top + scrollY,
          height: box.height,
          face: face !== null && face in FACES ? face : null,
        };
      })
    );
    scrollMax = Math.max(1, root.scrollHeight - window.innerHeight);
    const content = document.querySelector(contentSelector);
    const right = content === null ? window.innerWidth : content.getBoundingClientRect().right;
    obstacles = [...document.querySelectorAll(avoidSelector)]
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top + scrollY, bottom: box.bottom + scrollY, right: box.right };
      })
      .filter((box) => {
        return box.right > right + 1;
      });
    const bar = document.querySelector(dockSelector);
    const barBottom = bar === null ? 0 : bar.getBoundingClientRect().bottom;
    const room = root.clientWidth - right;
    if (room >= LEAST + 2 * GAP) {
      const size = Math.min(MOST, room - 2 * GAP);
      place = {
        dock: 'margin',
        size,
        left: right,
        top: 0,
        room,
        band: { top: barBottom + GAP, bottom: window.innerHeight - GAP },
      };
    } else {
      place = { ...barPlaceOf(bar), room, band: { top: 0, bottom: 0 } };
    }
    button.dataset['dock'] = place.dock;
    button.style.width = `${String(place.size)}px`;
    button.style.height = `${String(place.size)}px`;
    if (place.dock === 'none' && isShown()) {
      set('hidden');
    }
    lastFace = '';
    schedule();
  };

  const positionOf = () => {
    if (place.dock !== 'margin') {
      return { x: place.left, y: place.top, dodge: 0, shove: 0 };
    }
    const { size, room, band } = place;
    const travel = isReduced() ? 0 : clamp(window.scrollY / scrollMax);
    const swayX = Math.min(26, Math.max(0, (room - size) / 2 - GAP));
    const swayY = 0.56 * Math.max(0, (band.bottom - band.top - size) / 2);
    const x = place.left + (room - size) / 2 + swayX * Math.sin(travel * Math.PI * 3);
    const y = (band.top + band.bottom - size) / 2 + swayY * Math.sin(travel * Math.PI * 2);
    // ! whatever is wider than the text, a block of code, it moves clear of in the same frame, a
    // scroll faster than any transition; it comes back at DODGE_BACK px a millisecond
    let dodge = 0;
    for (const obstacle of obstacles) {
      const top = obstacle.top - window.scrollY;
      const bottom = obstacle.bottom - window.scrollY;
      if (top < y + size + REACH && bottom > y - REACH && obstacle.right + GAP > x) {
        dodge = Math.max(dodge, obstacle.right + GAP - x);
      }
    }
    const shy = state === 'shy' ? size * 0.7 : 0;
    return { x, y, dodge, shove: shy };
  };

  // ── Each frame ──

  const draw = (now) => {
    frame = null;
    const reduced = isReduced();
    const reading = readingAt(keyframes, window.scrollY + window.innerHeight / 2, { reduced });
    let face = blend(FACES[reading.from], FACES[reading.to], { by: reading.t });
    let named = reading.t < 0.5 ? reading.from : reading.to;
    let isMoving = false;
    if (reaction !== null) {
      const since = now - reaction.at;
      const weight = reduced
        ? Number(since < REACT_IN_MS + REACT_HOLD_MS)
        : smooth(clamp(since / REACT_IN_MS)) *
          (1 - smooth(clamp((since - REACT_IN_MS - REACT_HOLD_MS) / REACT_OUT_MS)));
      face = blend(face, FACES[reaction.face], { by: weight });
      if (weight >= 0.5) {
        named = reaction.face;
      }
      if (since < REACT_IN_MS + REACT_HOLD_MS + REACT_OUT_MS) {
        isMoving = true;
      } else {
        reaction = null;
        settle();
      }
    }
    let eclipse = AT_REST;
    if (eclipseStart !== null) {
      const since = now - eclipseStart;
      eclipse = eclipseAt(since, { reduced });
      face = blend(blend(face, FACES.mischief, { by: eclipse.mischief }), FACES.serene, {
        by: eclipse.serene,
      });
      if (eclipse.serene >= 0.5) {
        named = 'serene';
      } else if (eclipse.mischief >= 0.5) {
        named = 'mischief';
      }
      if (since < ECLIPSE_MS) {
        isMoving = true;
      } else {
        eclipseStart = null;
        set('reading');
        settle();
      }
    }
    const key = PARTS.map((part) => {
      return face[part].map(fixed).join(',');
    })
      .concat(
        eclipse.beads.map(({ opacity, radius }) => {
          return `${fixed(opacity)}:${fixed(radius)}`;
        }),
        [fixed(eclipse.flare), fixed(eclipse.corona)]
      )
      .join(';');
    if (key !== lastFace) {
      lastFace = key;
      paint(drawing, { face, eclipse });
    }
    if (button.dataset['face'] !== named) {
      button.dataset['face'] = named;
    }
    const { x, y, dodge, shove } = positionOf();
    dodged =
      dodge >= dodged ? dodge : Math.max(dodge, dodged - DODGE_BACK * Math.max(0, now - drawn));
    drawn = now;
    if (dodged > dodge) {
      isMoving = true;
    }
    button.style.translate = `${fixed(x + dodged)}px ${fixed(y)}px`;
    button.style.transform = `translateX(${fixed(shove)}px)`;
    if (isMoving) {
      schedule();
    }
  };

  const schedule = () => {
    if (frame === null) {
      frame = window.requestAnimationFrame(draw);
    }
  };

  // ── What it hears ──

  // the sections that cross the reading line
  let crossing = null;
  const observeSections = () => {
    crossing?.disconnect();
    marked = new Set();
    crossing = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.hasAttribute('data-bead-face')) {
            marked.add(entry.target);
          } else {
            marked.delete(entry.target);
          }
        }
        settle();
      },
      { rootMargin: '-50% 0px -50% 0px' }
    );
    for (const section of document.querySelectorAll(sectionsSelector)) {
      crossing.observe(section);
    }
  };

  const sized = new ResizeObserver(() => {
    measure();
  });
  const observeContent = () => {
    sized.disconnect();
    sized.observe(root);
    const content = document.querySelector(contentSelector);
    if (content !== null) {
      sized.observe(content);
    }
  };

  // a page that swaps its language swaps its sections with it
  const languages = new MutationObserver(() => {
    label();
    observeSections();
    observeContent();
    measure();
  });
  languages.observe(root, { attributes: true, attributeFilter: ['lang'] });

  // * a scroll schedules a frame, and nothing else
  const onScroll = () => {
    if (!hasScrolled) {
      hasScrolled = true;
      settle();
    }
    schedule();
  };

  const onEnter = (event) => {
    if (
      event.pointerType !== 'mouse' ||
      state !== 'reading' ||
      place.dock !== 'margin' ||
      isReduced() ||
      performance.now() < restUntil
    ) {
      return;
    }
    set('shy');
    schedule();
    later('shy', () => {
      if (state === 'shy') {
        set('reading');
        restUntil = performance.now() + SHY_REST_MS;
        schedule();
      }
    });
  };

  // the keyboard brings it, and it stays while it holds the focus
  const onFocus = () => {
    cancel('leave');
    arrive();
  };

  const onBlur = () => {
    settle();
  };

  const onClick = () => {
    if (state === 'eclipse' || !isShown()) {
      return;
    }
    cancel('shy');
    set('eclipse');
    eclipseStart = performance.now();
    schedule();
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', measure);
  button.addEventListener('pointerenter', onEnter);
  button.addEventListener('click', onClick);
  button.addEventListener('focus', onFocus);
  button.addEventListener('blur', onBlur);
  label();
  observeSections();
  observeContent();
  measure();

  return {
    react: (face) => {
      if (!(face in FACES)) {
        return;
      }
      reaction = { face, at: performance.now() };
      cancel('leave');
      arrive();
      schedule();
    },
    destroy: () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      crossing?.disconnect();
      sized.disconnect();
      languages.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      button.remove();
    },
  };
};
