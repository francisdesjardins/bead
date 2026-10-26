// ── Demo scenes ──────────────────────────────────────────────────────────────

// The page's scenes, one a tab: its calls, its payload rules, its OpenAPI document, its server and
// its code. The scene shown is the address's fragment, `#rules`, so a link opens it and Back
// returns to the one before; with none named, the calls. Beside them the logs, which a visitor
// folds away, remembered in this browser alone.

// dependencies

import { mountTabs } from './tabs';

// constants

/** The scene a page with no fragment of a scene shows. */
const FIRST_SCENE = 'calls';

/** Where this browser remembers the logs folded. */
const FOLDED_KEY = 'bead:logs-folded';

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

// the remembering is a convenience: a browser that keeps nothing, or refuses, folds nothing
const isRemembered = (): boolean => {
  try {
    return localStorage.getItem(FOLDED_KEY) === 'true';
  } catch {
    return false;
  }
};

const remember = (isFolded: boolean): void => {
  try {
    if (isFolded) {
      localStorage.setItem(FOLDED_KEY, 'true');
    } else {
      localStorage.removeItem(FOLDED_KEY);
    }
  } catch {
    // nothing kept: the next visit shows them
  }
};

// definition

/** Mounts the page's scenes on `#scene-tabs`, the one its fragment names shown, and its logs. */
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

  const logs = elementOf('logs');
  const toggle = elementOf('logs-toggle');

  const fold = (isFolded: boolean): void => {
    logs.toggleAttribute('data-folded', isFolded);
    toggle.setAttribute('aria-expanded', String(!isFolded));
    toggle.textContent = isFolded ? 'Show the logs' : 'Hide the logs';
  };

  toggle.addEventListener('click', () => {
    const isFolded = !logs.hasAttribute('data-folded');

    fold(isFolded);
    remember(isFolded);
  });
  fold(isRemembered());
};
