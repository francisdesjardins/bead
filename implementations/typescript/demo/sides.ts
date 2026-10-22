// ── Demo sides ───────────────────────────────────────────────────────────────

// The same service on both sides: examples/hello's resolvers, server and client, its TypeScript
// file beside its C# one, as `samples.ts` holds them from the repository. One tab a role, as the
// WAI-ARIA tabs pattern lays them out: the arrow keys move between them, Home and End to the ends.

// dependencies

import { SAMPLES } from './samples';

// types

/** A role the panel offers, as `samples.ts` names it. */
type Role = keyof typeof SAMPLES;

// constants

const ROLES = Object.freeze(Object.keys(SAMPLES) as Role[]);

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

const isRole = (value: string | undefined): value is Role => {
  return value !== undefined && (ROLES as readonly string[]).includes(value);
};

// definition

/** Mounts the panel of the two sides on the page's `#sides`, its first role shown. */
export const mountSides = (): void => {
  const tabs = [...elementOf('sides-tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panel = elementOf('sides-panel');
  const panes = {
    csharp: { file: elementOf('side-csharp-file'), text: elementOf('side-csharp') },
    typescript: { file: elementOf('side-typescript-file'), text: elementOf('side-typescript') },
  };

  const show = (role: Role, { isFocused }: { isFocused: boolean }): void => {
    for (const tab of tabs) {
      const isShown = tab.dataset['role'] === role;

      tab.setAttribute('aria-selected', String(isShown));
      tab.tabIndex = isShown ? 0 : -1;

      if (isShown) {
        panel.setAttribute('aria-labelledby', tab.id);

        if (isFocused) {
          tab.focus();
        }
      }
    }

    for (const side of ['typescript', 'csharp'] as const) {
      const { file, text } = SAMPLES[role][side];

      panes[side].file.textContent = file;
      panes[side].text.textContent = text;
      panes[side].text.scrollTop = 0;
    }
  };

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => {
      const { role } = tab.dataset;

      if (isRole(role)) {
        show(role, { isFocused: false });
      }
    });
    tab.addEventListener('keydown', (event) => {
      const to = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        End: tabs.length - 1,
        Home: 0,
      }[event.key];
      const role = to === undefined ? undefined : tabs[to]?.dataset['role'];

      if (isRole(role)) {
        event.preventDefault();
        show(role, { isFocused: true });
      }
    });
  }

  const [first] = ROLES;

  if (first !== undefined) {
    show(first, { isFocused: false });
  }
};
