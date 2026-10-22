// ── Demo sides ───────────────────────────────────────────────────────────────

// The same service on both sides: examples/hello's resolvers, server and client, its TypeScript
// file beside its C# one, as `samples.ts` holds them from the repository. One tab a role, as
// `tabs.ts` lays them out, the one panel showing the role selected.

// dependencies

import { SAMPLES } from './samples';
import { mountTabs } from './tabs';

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
  const panel = elementOf('sides-panel');
  const panes = {
    csharp: { file: elementOf('side-csharp-file'), text: elementOf('side-csharp') },
    typescript: { file: elementOf('side-typescript-file'), text: elementOf('side-typescript') },
  };
  const { select, tabs } = mountTabs(elementOf('sides-tabs'), {
    show: (tab) => {
      const { role } = tab.dataset;

      if (!isRole(role)) {
        return;
      }

      panel.setAttribute('aria-labelledby', tab.id);

      for (const side of ['typescript', 'csharp'] as const) {
        const { file, text } = SAMPLES[role][side];

        panes[side].file.textContent = file;
        panes[side].text.textContent = text;
        panes[side].text.scrollTop = 0;
      }
    },
  });
  const [first] = tabs;

  if (first !== undefined) {
    select(first);
  }
};
