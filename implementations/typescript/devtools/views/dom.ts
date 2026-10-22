// ── The panel's elements ──────────────────────────────────────────────────────

// How the panel's views make what they show: an element of HTML or of SVG, its attributes and its
// text set as text, never as markup, since every word the page sent is the page's own; the icons
// that tell a call's status by a shape as well as a colour; and a redraw that keeps where its reader
// left what it redraws.

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

/** Where a reader left an element: how far it scrolled, and whether it was opened, a details. */
interface IPlace {
  left: number;
  open: boolean | undefined;
  path: readonly string[];
  top: number;
}

// constants

const SVG = 'http://www.w3.org/2000/svg';

/** What names an element among its siblings, first found first, before its tag and its rank. */
const KEYS: readonly string[] = Object.freeze([
  'id',
  'data-key',
  'data-source',
  'data-procedure',
  'data-room',
]);

// helpers

const keyOf = (element: Element): string | undefined => {
  for (const name of KEYS) {
    const value = element.getAttribute(name);

    if (value !== null) {
      return `${element.tagName}[${name}=${value}]`;
    }
  }

  return undefined;
};

// an element's step from its parent: its key where it has one, else its tag and its rank among the
// siblings of its tag that have none
const stepOf = (element: Element): string => {
  const key = keyOf(element);

  if (key !== undefined) {
    return key;
  }

  let rank = 0;

  for (
    let sibling = element.previousElementSibling;
    sibling !== null;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName && keyOf(sibling) === undefined) {
      rank += 1;
    }
  }

  return `${element.tagName}:${String(rank)}`;
};

const pathOf = (element: Element, root: Element): string[] => {
  const path: string[] = [];

  for (let at: Element | null = element; at !== null && at !== root; at = at.parentElement) {
    path.unshift(stepOf(at));
  }

  return path;
};

const elementAt = (root: Element, path: readonly string[]): Element | undefined => {
  let at = root;

  for (const step of path) {
    const next = [...at.children].find((child) => {
      return stepOf(child) === step;
    });

    if (next === undefined) {
      return undefined;
    }

    at = next;
  }

  return at;
};

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

/**
 * Replaces what `parent` holds with `nodes`, each element that scrolled scrolled as far and each
 * details opened or closed as its reader left it, where the redraw holds the same element: one of
 * the same key, or of the same tag and rank, on the same path. A redraw of what a second's reading
 * changes leaves alone what its reader did.
 */
export const replaceKeeping = (parent: Element, nodes: readonly Node[]): void => {
  const places: IPlace[] = [];

  for (const element of parent.querySelectorAll('*')) {
    const open = element instanceof HTMLDetailsElement ? element.open : undefined;

    if (element.scrollTop !== 0 || element.scrollLeft !== 0 || open !== undefined) {
      places.push({
        left: element.scrollLeft,
        open,
        path: pathOf(element, parent),
        top: element.scrollTop,
      });
    }
  }

  const { scrollLeft, scrollTop } = parent;

  parent.replaceChildren(...nodes);

  const found = places.flatMap((place) => {
    const element = elementAt(parent, place.path);

    return element === undefined ? [] : [{ element, place }];
  });

  // * a details opens first: what it holds scrolls only once it is laid out
  for (const { element, place } of found) {
    if (element instanceof HTMLDetailsElement && place.open !== undefined) {
      element.open = place.open;
    }
  }

  parent.scrollTop = scrollTop;
  parent.scrollLeft = scrollLeft;

  for (const { element, place } of found) {
    element.scrollTop = place.top;
    element.scrollLeft = place.left;
  }
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
          stroke: dash === undefined ? 'var(--app-info)' : 'var(--ended)',
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
        svgOf('circle', { attributes: { cx: 6, cy: 6, fill: 'var(--app-info)', r: 5 } }),
        svgOf('path', {
          attributes: {
            d: 'M3.4 6.2l1.8 1.8 3.4-3.6',
            fill: 'none',
            stroke: 'var(--app-paper)',
            'stroke-width': 1.4,
          },
        }),
      ]);
    case 'failed':
      return icon([
        svgOf('circle', { attributes: { cx: 6, cy: 6, fill: 'var(--app-error)', r: 5 } }),
        svgOf('path', {
          attributes: { d: 'M4 4l4 4M8 4l-4 4', stroke: 'var(--app-paper)', 'stroke-width': 1.4 },
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
            stroke: 'var(--app-divider)',
            'stroke-width': 1.6,
          },
        }),
        svgOf('path', {
          attributes: {
            class: 'spin',
            d: 'M6 1.4a4.6 4.6 0 0 1 4.6 4.6',
            fill: 'none',
            stroke: 'var(--app-info)',
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
