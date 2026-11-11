// ── Demo scenes ──────────────────────────────────────────────────────────────

// The page's scenes, one a tab: what to try, its payload rules, its OpenAPI document, its server
// and its code. The scene shown is the address's fragment, `#rules`, so a link opens it and Back
// returns to the one before; with none named, what to try. Beside them the wire, its calls or its
// envelopes, folded until a visitor opens it, which this browser alone remembers.

// dependencies

import { mountTabs } from './tabs';

// constants

/** The scene a page with no fragment of a scene shows. */
const FIRST_SCENE = 'calls';

/** Where this browser remembers the wire opened. */
const OPEN_KEY = 'bead:wire-open';

/** The widths at which the wire is a sheet over the page, as the page's style lays it out. */
const SHEET_WIDTHS = '(max-width: 899px)';

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

// the remembering is a convenience: a browser that keeps nothing, or refuses, opens nothing
const isRemembered = (): boolean => {
  try {
    return localStorage.getItem(OPEN_KEY) === 'true';
  } catch {
    return false;
  }
};

const remember = (isOpen: boolean): void => {
  try {
    if (isOpen) {
      localStorage.setItem(OPEN_KEY, 'true');
    } else {
      localStorage.removeItem(OPEN_KEY);
    }
  } catch {
    // nothing kept: the next visit shows it folded
  }
};

/** Mounts the wire: folded, or open as this browser remembers it, one log shown at a time. */
const mountWire = (): void => {
  const wire = elementOf('wire');
  // the bar's, on a desktop, and the sheet's own, on a phone
  const toggles = ['wire-toggle', 'wire-sheet'].map((id) => {
    return elementOf(id);
  });

  const fold = (isFolded: boolean): void => {
    wire.toggleAttribute('data-folded', isFolded);

    for (const toggle of toggles) {
      toggle.setAttribute('aria-expanded', String(!isFolded));
    }
  };

  const turn = (isFolded: boolean): void => {
    fold(isFolded);
    remember(!isFolded);
  };

  for (const toggle of toggles) {
    toggle.addEventListener('click', () => {
      turn(!wire.hasAttribute('data-folded'));
    });
  }

  elementOf('wire-fold').addEventListener('click', () => {
    turn(true);
  });

  // a link out of the wire on a phone folds its sheet, which would cover where it goes
  wire.addEventListener('click', (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('a') !== null &&
      matchMedia(SHEET_WIDTHS).matches
    ) {
      fold(true);
    }
  });

  const logs = elementOf('wire-tabs');
  const { select, tabs } = mountTabs(logs, {
    show: (tab) => {
      for (const each of logs.querySelectorAll('[role="tab"]')) {
        elementOf(each.getAttribute('aria-controls') ?? '').hidden = each !== tab;
      }
    },
  });

  if (tabs[0] !== undefined) {
    select(tabs[0]);
  }

  fold(!isRemembered());
};

// definition

/** Mounts the page's scenes on `#scene-tabs`, the one its fragment names shown, and its wire. */
export const mountScenes = (): void => {
  const panels = new Map<HTMLButtonElement, HTMLElement>();

  const sceneOf = (tab: HTMLButtonElement): string => {
    return tab.dataset['scene'] ?? FIRST_SCENE;
  };

  // the tab of the scene the fragment names, the first with none
  const named = (): HTMLButtonElement | undefined => {
    const scene = location.hash.slice(1) || FIRST_SCENE;

    return [...panels.keys()].find((tab) => {
      return sceneOf(tab) === scene;
    });
  };

  const { select, tabs } = mountTabs(elementOf('scene-tabs'), {
    show: (tab) => {
      for (const [each, panel] of panels) {
        panel.hidden = each !== tab;
      }

      // * a scene chosen is a step in the history; the one the address already names is not, and a
      // fragment of no scene, `#/` say, is corrected in its place
      if (named() === undefined) {
        history.replaceState(null, '', `#${sceneOf(tab)}`);
      } else if (named() !== tab) {
        history.pushState(null, '', `#${sceneOf(tab)}`);
      }

      // a change of transport keeps the scene
      for (const link of document.querySelectorAll<HTMLAnchorElement>('.transports a')) {
        link.hash = sceneOf(tab);
      }
    },
  });

  const showNamed = (): void => {
    const tab = named() ?? tabs[0];

    if (tab !== undefined) {
      select(tab);
    }
  };

  for (const tab of tabs) {
    panels.set(tab, elementOf(tab.getAttribute('aria-controls') ?? ''));
  }

  addEventListener('hashchange', showNamed);
  addEventListener('popstate', showNamed);
  showNamed();
  mountWire();
};
