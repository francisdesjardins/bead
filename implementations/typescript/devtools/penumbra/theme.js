// Before the first paint, on Bead's page and its demo alike: the theme, as the page keeps it, and
// its toggle, each button `data-action="theme"`, its label its `data-to-dark` or `data-to-light`.
// A classic script in the head: the page's build inlines it and hashes it, the demo loads it from
// its own origin.
(() => {
  const root = document.documentElement;
  const KEY = 'theme-preference';

  // `theme-preference`, a JSON boolean, true for dark; else the system's preference
  let dark = null;
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved !== null) {
      dark = Boolean(JSON.parse(saved));
    }
  } catch {
    dark = null;
  }
  if (dark === null) {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  root.setAttribute('data-color-scheme', dark ? 'dark' : 'light');

  // ! every toggle, a template's included: a page that swaps its content in from a template, as
  // the page does its language, shows each one labelled for the scheme it is in
  const label = () => {
    const isDark = root.getAttribute('data-color-scheme') === 'dark';
    const toggles = [
      ...document.querySelectorAll('[data-action="theme"]'),
      ...[...document.querySelectorAll('template')].flatMap((template) => {
        return [...template.content.querySelectorAll('[data-action="theme"]')];
      }),
    ];
    for (const toggle of toggles) {
      toggle.setAttribute(
        'aria-label',
        toggle.getAttribute(isDark ? 'data-to-light' : 'data-to-dark') ?? ''
      );
    }
  };

  document.addEventListener('click', (event) => {
    const toggle =
      event.target instanceof Element ? event.target.closest('[data-action="theme"]') : null;
    if (toggle === null) {
      return;
    }
    const next = root.getAttribute('data-color-scheme') !== 'dark';
    root.setAttribute('data-color-scheme', next ? 'dark' : 'light');
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // a refused storage keeps the choice for this page alone
    }
    label();
  });

  document.addEventListener('DOMContentLoaded', label);
})();
