// ── The panel's elements ──────────────────────────────────────────────────────

// How the panel's views make what they show: an element of HTML or of SVG, its attributes and its
// text set as text, never as markup, since every word the page sent is the page's own; and the
// icons that tell a call's status by a shape as well as a colour.

// dependencies

import type { CallStatus } from '../model/facts';

// interfaces

/** What an element is made with: its class, its text, its attributes, and what it holds. */
export interface IMade {
  attributes?: Readonly<Record<string, string | undefined>> | undefined;
  children?: readonly (Node | string)[] | undefined;
  className?: string | undefined;
  text?: string | undefined;
}

// constants

const SVG = 'http://www.w3.org/2000/svg';

// definition

/** An element of `tag`. */
export const make = (tag: string, made: IMade = {}): HTMLElement => {
  const element = document.createElement(tag);

  if (made.className !== undefined) {
    element.className = made.className;
  }

  if (made.text !== undefined) {
    element.textContent = made.text;
  }

  for (const [name, value] of Object.entries(made.attributes ?? {})) {
    if (value !== undefined) {
      element.setAttribute(name, value);
    }
  }

  element.append(...(made.children ?? []));

  return element;
};

/** An element of SVG, `tag`, its attributes numbers or text. */
export const svgOf = (
  tag: string,
  made: {
    attributes?: Readonly<Record<string, number | string | undefined>> | undefined;
    children?: readonly Node[] | undefined;
    text?: string | undefined;
  } = {}
): SVGElement => {
  const element = document.createElementNS(SVG, tag);

  for (const [name, value] of Object.entries(made.attributes ?? {})) {
    if (value !== undefined) {
      element.setAttribute(
        name,
        typeof value === 'number' ? String(Math.round(value * 10) / 10) : value
      );
    }
  }

  if (made.text !== undefined) {
    element.textContent = made.text;
  }

  element.append(...(made.children ?? []));

  return element;
};

/** A paragraph of a note. */
export const noteOf = (text: string): HTMLElement => {
  return make('p', { className: 'note', text });
};

/** A list of facts, each a name and its value, those without a value left out. */
export const factsOf = (facts: readonly [string, Node | string | undefined][]): HTMLElement => {
  return make('dl', {
    children: facts.flatMap(([name, value]) => {
      return value === undefined
        ? []
        : [make('dt', { text: name }), make('dd', { children: [value] })];
    }),
    className: 'facts',
  });
};

/** The icon of a status: a shape and a colour, and its name for whoever does not see either. */
export const statusIconOf = (status: CallStatus): SVGElement => {
  const icon = (children: SVGElement[]): SVGElement => {
    return svgOf('svg', {
      attributes: { 'aria-label': status, class: 'status', role: 'img', viewBox: '0 0 12 12' },
      children: [svgOf('title', { text: STATUS_NAMES[status] }), ...children],
    });
  };
  const wave = (dash?: string): SVGElement[] => {
    return ['M1.5 4.5q1.5-2 3 0t3 0 3 0', 'M1.5 8q1.5-2 3 0t3 0 3 0'].map((d) => {
      return svgOf('path', {
        attributes: {
          d,
          fill: 'none',
          stroke: dash === undefined ? 'var(--answered)' : 'var(--ended)',
          'stroke-dasharray': dash,
          'stroke-width': 1.4,
        },
      });
    });
  };

  switch (status) {
    case 'answered':
    case 'heard':
      return icon([
        svgOf('circle', { attributes: { cx: 6, cy: 6, fill: 'var(--answered)', r: 5 } }),
        svgOf('path', {
          attributes: {
            d: 'M3.4 6.2l1.8 1.8 3.4-3.6',
            fill: 'none',
            stroke: 'var(--paper)',
            'stroke-width': 1.4,
          },
        }),
      ]);
    case 'failed':
      return icon([
        svgOf('circle', { attributes: { cx: 6, cy: 6, fill: 'var(--bad)', r: 5 } }),
        svgOf('path', {
          attributes: { d: 'M4 4l4 4M8 4l-4 4', stroke: 'var(--paper)', 'stroke-width': 1.4 },
        }),
      ]);
    case 'ended':
      return icon([
        svgOf('circle', {
          attributes: {
            cx: 6,
            cy: 6,
            fill: 'none',
            r: 4.6,
            stroke: 'var(--ended)',
            'stroke-dasharray': '2 1.6',
            'stroke-width': 1.3,
          },
        }),
        svgOf('path', {
          attributes: { d: 'M3.6 8.4l4.8-4.8', stroke: 'var(--ended)', 'stroke-width': 1.3 },
        }),
      ]);
    case 'open':
      return icon(wave());
    case 'closed':
      return icon(wave('2 1.5'));
    case 'flight':
      return icon([
        svgOf('circle', {
          attributes: {
            cx: 6,
            cy: 6,
            fill: 'none',
            r: 4.6,
            stroke: 'var(--line)',
            'stroke-width': 1.6,
          },
        }),
        svgOf('path', {
          attributes: {
            class: 'spin',
            d: 'M6 1.4a4.6 4.6 0 0 1 4.6 4.6',
            fill: 'none',
            stroke: 'var(--answered)',
            'stroke-width': 1.6,
          },
        }),
      ]);
  }
};

/** Each status, as the panel names it. */
export const STATUS_NAMES: Readonly<Record<CallStatus, string>> = Object.freeze({
  answered: 'answered',
  closed: 'subscription ended',
  ended: 'ended without an answer',
  failed: 'failed',
  flight: 'in flight',
  heard: 'a notification heard',
  open: 'subscription open',
});
