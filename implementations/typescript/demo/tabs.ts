// ── Demo tabs ────────────────────────────────────────────────────────────────

// A tablist as the WAI-ARIA tabs pattern lays it out: one tab selected, the only one Tab reaches;
// the arrow keys move between them, Home and End to the ends, the selection following the focus.
// What a tab selected shows is its caller's: a panel of its own, or what one panel holds.

// types

export interface ITabsOptions {
  /** Shows what `tab`, just selected, stands for. */
  show: (tab: HTMLButtonElement) => void;
}

export interface ISelectOptions {
  /** Whether the focus goes with the selection, as it does from the keyboard. */
  isFocused?: boolean;
}

export interface ITabs {
  /** Selects `tab`, and shows what it stands for. */
  select: (tab: HTMLButtonElement, options?: ISelectOptions) => void;
  /** The list's tabs, in their order. */
  readonly tabs: readonly HTMLButtonElement[];
}

// definition

/** Mounts the tabs of `list`, none selected until its caller selects one. */
export const mountTabs = (list: HTMLElement, { show }: ITabsOptions): ITabs => {
  const tabs = Object.freeze([...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]);

  const select = (tab: HTMLButtonElement, { isFocused = false }: ISelectOptions = {}): void => {
    for (const each of tabs) {
      const isShown = each === tab;

      each.setAttribute('aria-selected', String(isShown));
      each.tabIndex = isShown ? 0 : -1;
    }

    if (isFocused) {
      tab.focus();
    }

    show(tab);
  };

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => {
      select(tab);
    });
    tab.addEventListener('keydown', (event) => {
      const to = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        End: tabs.length - 1,
        Home: 0,
      }[event.key];
      const next = to === undefined ? undefined : tabs[to];

      if (next !== undefined) {
        event.preventDefault();
        select(next, { isFocused: true });
      }
    });
  }

  return Object.freeze({ select, tabs });
};
