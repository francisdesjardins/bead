// ── Demo sides ───────────────────────────────────────────────────────────────

// The same service in TypeScript, C# and Rust: examples/hello's resolvers, server and client, as
// `samples.ts` holds them from the repository, one file shown at a time. The role is a tablist, as
// `tabs.ts` lays it out; the language a radio group beside it, as the WAI-ARIA radio group pattern
// lays it out. Each choice keeps the other, and this browser remembers the language. The file is
// coloured as the page colours code, its tokens written as spans of text, never as HTML.

// dependencies

import { type CodeLanguage, tokensOf } from './highlight';
import { SAMPLES } from './samples';
import { mountTabs } from './tabs';

// types

/** A role the panel offers, as `samples.ts` names it. */
type Role = keyof typeof SAMPLES;

/** A language the panel offers, as `samples.ts` names it. */
type Language = keyof (typeof SAMPLES)[Role];

// constants

const ROLES = Object.freeze(Object.keys(SAMPLES) as Role[]);

const LANGUAGES = Object.freeze(Object.keys(SAMPLES.resolvers) as Language[]);

/** Where this browser remembers the language a visitor chose. */
const LANGUAGE_KEY = 'bead:code-language';

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

const isLanguage = (value: string | null | undefined): value is Language => {
  return value !== null && value !== undefined && (LANGUAGES as readonly string[]).includes(value);
};

// the remembering is a convenience: a browser that keeps nothing, or refuses, shows TypeScript
const rememberedLanguage = (): Language | undefined => {
  try {
    const kept = localStorage.getItem(LANGUAGE_KEY);

    return isLanguage(kept) ? kept : undefined;
  } catch {
    return undefined;
  }
};

const remember = (language: Language): void => {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // nothing kept: the next visit shows TypeScript
  }
};

/** `text` in `language`, a span a coloured token, the rest text. */
const codeOf = (text: string, language: CodeLanguage): DocumentFragment => {
  const fragment = document.createDocumentFragment();

  for (const { kind, text: run } of tokensOf(text, language)) {
    if (kind === 'text') {
      fragment.append(run);
    } else {
      const span = document.createElement('span');

      span.className = `tok-${kind}`;
      span.textContent = run;
      fragment.append(span);
    }
  }

  return fragment;
};

// definition

/** Mounts the panel of the three languages on the page's `#sides`, its first role shown. */
export const mountSides = (): void => {
  const panel = elementOf('sides-panel');
  const file = elementOf('side-file');
  const radios = Object.freeze([
    ...elementOf('sides-languages').querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ]);
  let role: Role = 'resolvers';
  let language: Language = rememberedLanguage() ?? 'typescript';

  const show = (): void => {
    const sample = SAMPLES[role][language];

    file.textContent = sample.file;
    panel.replaceChildren(codeOf(sample.text, language));
    panel.scrollTop = 0;
    panel.scrollLeft = 0;
  };

  const check = (chosen: Language): void => {
    for (const radio of radios) {
      const isChecked = radio.dataset['language'] === chosen;

      radio.setAttribute('aria-checked', String(isChecked));
      radio.tabIndex = isChecked ? 0 : -1;
    }
  };

  const choose = (chosen: Language): void => {
    language = chosen;
    check(chosen);
    remember(chosen);
    show();
  };

  for (const [index, radio] of radios.entries()) {
    radio.addEventListener('click', () => {
      const chosen = radio.dataset['language'];

      if (isLanguage(chosen)) {
        choose(chosen);
      }
    });
    radio.addEventListener('keydown', (event) => {
      const to = {
        ArrowDown: index + 1,
        ArrowLeft: index - 1,
        ArrowRight: index + 1,
        ArrowUp: index - 1,
      }[event.key];
      const next = to === undefined ? undefined : radios[(to + radios.length) % radios.length];
      const chosen = next?.dataset['language'];

      if (next !== undefined && isLanguage(chosen)) {
        event.preventDefault();
        choose(chosen);
        next.focus();
      }
    });
  }

  const { select, tabs } = mountTabs(elementOf('sides-tabs'), {
    show: (tab) => {
      const chosen = tab.dataset['role'];

      if (!isRole(chosen)) {
        return;
      }

      role = chosen;
      panel.setAttribute('aria-labelledby', `${tab.id} side-file`);
      show();
    },
  });
  const [first] = tabs;

  check(language);

  if (first !== undefined) {
    select(first);
  }
};
