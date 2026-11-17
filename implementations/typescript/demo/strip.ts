// ── Demo strip ────────────────────────────────────────────────────────────────

// The demo's own row under Bead's bar: the transport in use among the others, how the connection
// stands and who the calls are made as, and the wire. What it opens is one panel at a time under
// it, a disclosure as WAI-ARIA's pattern has it: its button says whether it is open, Escape closes
// it and gives the focus back, and a click outside it closes it too.

// constants

/** Each button of the strip that opens a panel, by its id. */
const TOGGLES = Object.freeze(['transport-toggle', 'status-toggle']);

// helpers

const elementOf = (id: string): HTMLElement => {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`the page has no #${id}`);
  }

  return element;
};

// definition

/** Mounts the strip: `transport`, the one in use, marked and named, and its two panels. */
export const mountStrip = (transport: string): void => {
  // ! by the address's own query: a scene chosen writes its fragment into each link, whole
  const current = [...document.querySelectorAll<HTMLAnchorElement>('.transports a')].find(
    (link) => {
      return new URL(link.href).searchParams.get('transport') === transport;
    }
  );

  current?.setAttribute('aria-current', 'page');
  elementOf('transport-name').textContent =
    current?.querySelector('.name')?.textContent ?? transport;

  const toggles = TOGGLES.map((id) => {
    const toggle = elementOf(id);

    return { panel: elementOf(toggle.getAttribute('aria-controls') ?? ''), toggle };
  });

  // * one open at most: opening one closes the other
  const open = (shown: HTMLElement | undefined): void => {
    for (const { panel, toggle } of toggles) {
      const isOpen = toggle === shown;

      panel.toggleAttribute('data-open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
    }
  };

  const opened = (): HTMLElement | undefined => {
    return toggles.find(({ toggle }) => {
      return toggle.getAttribute('aria-expanded') === 'true';
    })?.toggle;
  };

  for (const { toggle } of toggles) {
    toggle.addEventListener('click', () => {
      open(opened() === toggle ? undefined : toggle);
    });
  }

  document.addEventListener('keydown', (event) => {
    const toggle = opened();

    if (event.key === 'Escape' && toggle !== undefined) {
      open(undefined);
      toggle.focus();
    }
  });

  // a click on neither a panel nor its button closes what is open
  document.addEventListener('click', (event) => {
    const isInside =
      event.target instanceof Node &&
      toggles.some(({ panel, toggle }) => {
        return panel.contains(event.target as Node) || toggle.contains(event.target as Node);
      });

    if (!isInside) {
      open(undefined);
    }
  });
};
