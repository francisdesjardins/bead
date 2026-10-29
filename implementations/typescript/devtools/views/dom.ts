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

// constants

const SVG = 'http://www.w3.org/2000/svg';

/** What names an element among its siblings, first found first, before its tag and its rank. */
const KEYS: readonly string[] = Object.freeze([
  'id',
  'data-row',
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

const recordKeys = new WeakMap<object, string>();
let nextRecordKey = 0;

/** A captured object's stable row identity, including records with equal timestamps. */
export const keyOfRecord = (record: object): string => {
  let key = recordKeys.get(record);
  if (key === undefined) {
    key = String(nextRecordKey++);
    recordKeys.set(record, key);
  }
  return key;
};

/** Listeners follow the element that a redraw retains. */
const listeners = new WeakMap<Element, Map<string, EventListener>>();
const retained = new WeakMap<Element, Element>();

/** The element in the document that a view's freshly drawn element addresses. */
export const currentOf = <T extends Element>(element: T): T => {
  return (retained.get(element) ?? element) as T;
};

/** A view listener whose next drawing supplies its current callback. */
export const listen = <K extends keyof HTMLElementEventMap>(
  element: Element,
  options: { type: K; handle: (event: HTMLElementEventMap[K]) => void }
): void => {
  const held = listeners.get(element) ?? new Map<string, EventListener>();
  const callback = options.handle as EventListener;
  held.set(options.type, callback);
  listeners.set(element, held);
  element.addEventListener(options.type, callback);
};

const patch = (element: Element, fresh: Element): void => {
  retained.set(fresh, element);
  for (const name of element.getAttributeNames()) {
    if (!fresh.hasAttribute(name) && name !== 'open') {
      element.removeAttribute(name);
    }
  }
  for (const attribute of fresh.attributes) {
    if (attribute.name === 'open' && element instanceof HTMLDetailsElement) {
      continue;
    }
    if (element.getAttribute(attribute.name) !== attribute.value) {
      element.setAttribute(attribute.name, attribute.value);
    }
  }
  for (const [type, callback] of listeners.get(element) ?? []) {
    element.removeEventListener(type, callback);
  }
  const callbacks = listeners.get(fresh);
  for (const [type, callback] of callbacks ?? []) {
    element.addEventListener(type, callback);
  }
  if (callbacks !== undefined) {
    listeners.set(element, callbacks);
  } else {
    listeners.delete(element);
  }
  reconcile(element, [...fresh.childNodes]);
  if (element instanceof HTMLSelectElement && fresh instanceof HTMLSelectElement) {
    element.value = fresh.value;
  }
  if (
    element instanceof HTMLInputElement &&
    fresh instanceof HTMLInputElement &&
    element !== document.activeElement
  ) {
    element.value = fresh.value;
  }
};

const reconcile = (parent: Element, nodes: readonly Node[]): void => {
  const prior = [...parent.childNodes];
  const keyed = new Map(
    prior.flatMap((node) => {
      const key = node instanceof Element ? keyOf(node) : undefined;
      return key === undefined ? [] : [[key, node] as const];
    })
  );
  const used = new Set<Node>();
  let cursor = parent.firstChild;
  nodes.forEach((fresh, index) => {
    const key = fresh instanceof Element ? keyOf(fresh) : undefined;
    const candidate = key === undefined ? prior[index] : keyed.get(key);
    const node =
      candidate !== undefined &&
      !used.has(candidate) &&
      candidate.nodeType === fresh.nodeType &&
      candidate.nodeName === fresh.nodeName &&
      (key !== undefined || !(candidate instanceof Element) || keyOf(candidate) === undefined)
        ? candidate
        : fresh;
    used.add(node);
    if (node !== fresh) {
      if (node instanceof Element && fresh instanceof Element) {
        patch(node, fresh);
      } else if (node.nodeValue !== fresh.nodeValue) {
        node.nodeValue = fresh.nodeValue;
      }
    }
    if (node !== cursor) {
      parent.insertBefore(node, cursor);
    }
    cursor = node.nextSibling;
  });
  for (const node of prior) {
    if (!used.has(node)) {
      node.parentNode?.removeChild(node);
    }
  }
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

/** Reconciles keyed elements in place, keeping focus, disclosures and every pane's scroll. */
export const replaceKeeping = (parent: Element, nodes: readonly Node[]): void => {
  const places = [parent, ...parent.querySelectorAll('*')].map((element) => {
    return { element, top: element.scrollTop, left: element.scrollLeft };
  });
  const focus = document.activeElement;
  reconcile(parent, nodes);
  if (focus instanceof HTMLElement && focus.isConnected && document.activeElement !== focus) {
    focus.focus({ preventScroll: true });
  }
  for (const { element, top, left } of places) {
    if (element.isConnected) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }
};

/** A paragraph of a note. */
export const noteOf = (text: string): HTMLElement => {
  return make('p', { className: 'note', text });
};

/** The rows a view's filter leaves out, including an empty view's zero. */
export const filterCountOf = (hidden: number): HTMLElement => {
  return make('p', {
    className: 'note filter-count',
    attributes: { 'aria-live': 'polite' },
    text: `${String(hidden)} hidden by the filter`,
  });
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
