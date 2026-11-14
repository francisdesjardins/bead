// At the end of the body: the language swapped in, its head, the table of contents, the menu, the
// theme's toggle, and a folded block opened when a link lands in it.
(() => {
  // each language's title and description, which the build writes beside this script
  const HEADS = JSON.parse(document.getElementById('heads').textContent);
  const ADDRESS = 'https://beadproto.dev/';
  // the fixed bar, and a little air under it, above a section counted as the current one
  const READING_LINE = 96;

  const root = document.documentElement;
  const page = document.getElementById('page');

  const shown = () => {
    return page.getAttribute('data-lang');
  };

  // ── Language ────────────────────────────────────────────────────────────────

  const headFor = (language) => {
    root.lang = language === 'fr' ? 'fr-CA' : 'en-CA';
    root.setAttribute('data-language', language);
    document.title = HEADS[language].title;
    document
      .querySelector('meta[name="description"]')
      .setAttribute('content', HEADS[language].description);
    // the canonical is written here alone: the bare address is the English page and `?lng=fr` the
    // French one, so a static one in the head would contradict the French page's
    let canonical = document.querySelector('link[rel="canonical"]');
    if (canonical === null) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.setAttribute('href', language === 'fr' ? `${ADDRESS}?lng=fr` : ADDRESS);
  };

  // the page's content and the template's trade places: one language in the document at a time, so
  // each id is one element's
  const swap = (language) => {
    if (shown() === language) {
      return;
    }
    const other = document.getElementById('page-other');
    const stash = document.createElement('template');
    stash.id = 'page-other';
    stash.setAttribute('data-lang', shown());
    stash.content.append(...page.childNodes);
    page.append(other.content);
    other.replaceWith(stash);
    page.setAttribute('data-lang', language);
  };

  // ── Folded blocks ───────────────────────────────────────────────────────────

  const idOf = (hash) => {
    try {
      return decodeURIComponent(hash.slice(1));
    } catch {
      return '';
    }
  };

  // every <details> around the target opened, the target's own included
  const reveal = (id) => {
    const target = id === '' ? null : document.getElementById(id);
    for (let node = target; node !== null; node = node.parentElement) {
      if (node.tagName === 'DETAILS') {
        node.open = true;
      }
    }
    return target;
  };

  // ── Contents ────────────────────────────────────────────────────────────────

  const sections = () => {
    return [...page.querySelectorAll('main section[id]')];
  };

  const current = () => {
    let found = null;
    for (const section of sections()) {
      if (section.getBoundingClientRect().top - READING_LINE <= 0) {
        found = section;
      }
    }
    return found;
  };

  const mark = () => {
    const section = current();
    for (const link of page.querySelectorAll('.toc a')) {
      if (section !== null && link.getAttribute('href') === `#${section.id}`) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  };

  let marking = false;
  window.addEventListener(
    'scroll',
    () => {
      if (!marking) {
        marking = true;
        window.requestAnimationFrame(() => {
          marking = false;
          mark();
        });
      }
    },
    { passive: true }
  );

  // ── Menu and theme ──────────────────────────────────────────────────────────

  const menu = (open) => {
    const button = page.querySelector('[data-action="menu"]');
    root.toggleAttribute('data-menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', button.getAttribute(open ? 'data-close' : 'data-open'));
  };

  const themeLabel = () => {
    const button = page.querySelector('[data-action="theme"]');
    const isDark = root.getAttribute('data-color-scheme') === 'dark';
    button.setAttribute(
      'aria-label',
      button.getAttribute(isDark ? 'data-to-light' : 'data-to-dark')
    );
  };

  const settle = () => {
    menu(false);
    themeLabel();
    mark();
  };

  // ── Events ──────────────────────────────────────────────────────────────────

  document.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (control !== null) {
      const action = control.getAttribute('data-action');
      if (action === 'menu') {
        menu(!root.hasAttribute('data-menu-open'));
      } else if (action === 'theme') {
        const dark = root.getAttribute('data-color-scheme') !== 'dark';
        root.setAttribute('data-color-scheme', dark ? 'dark' : 'light');
        try {
          window.localStorage.setItem('theme-preference', JSON.stringify(dark));
        } catch {
          // a refused storage keeps the choice for this page alone
        }
        themeLabel();
      } else if (action === 'language') {
        event.preventDefault();
        const next = shown() === 'en' ? 'fr' : 'en';
        // the section being read stays where it was on the screen
        const reading = current();
        const before = reading === null ? 0 : reading.getBoundingClientRect().top;
        swap(next);
        try {
          window.localStorage.setItem('language', next);
        } catch {
          // a refused storage keeps the choice in the address alone
        }
        const address = new URL(window.location.href);
        address.searchParams.set('lng', next);
        window.history.replaceState(window.history.state, '', address);
        headFor(next);
        settle();
        if (reading !== null) {
          const again = document.getElementById(reading.id);
          window.scrollBy({ top: again.getBoundingClientRect().top - before, behavior: 'instant' });
        }
        page.querySelector('[data-action="language"]').focus();
      }
      return;
    }
    const link = event.target.closest('a[href^="#"]');
    if (link !== null) {
      reveal(idOf(link.getAttribute('href')));
      menu(false);
      return;
    }
    if (root.hasAttribute('data-menu-open') && event.target.closest('.toc') === null) {
      menu(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.hasAttribute('data-menu-open')) {
      menu(false);
      page.querySelector('[data-action="menu"]').focus();
    }
  });

  window.addEventListener('hashchange', () => {
    const target = reveal(idOf(window.location.hash));
    if (target !== null) {
      target.scrollIntoView({ behavior: 'instant' });
    }
  });

  // ── First paint ─────────────────────────────────────────────────────────────

  const language = root.getAttribute('data-language') === 'fr' ? 'fr' : 'en';
  try {
    swap(language);
    headFor(language);
  } finally {
    // ! the page is shown whatever the swap did: a throw above would otherwise leave it blank
    root.removeAttribute('data-swapping');
  }
  settle();
  const landed = reveal(idOf(window.location.hash));
  if (landed !== null) {
    landed.scrollIntoView({ behavior: 'instant' });
  }
})();
