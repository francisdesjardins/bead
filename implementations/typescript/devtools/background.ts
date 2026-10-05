// ── DevTools background ───────────────────────────────────────────────────────

// The extension's service worker: it pairs each page's bridge with the panel open on its tab, by
// the tab's id, and relays between them. A panel that opens asks the page's hook for its sources and
// watches them; one that closes stops the watch, so a page nobody inspects builds no `debug` event.

// dependencies

import { chromeOf, type IPort } from './chrome';
import type { BackgroundMessage, IPanelGreeting, PanelMessage } from './messages';
import { PORTS } from './messages';

// helpers

const isGreeting = (message: unknown): message is IPanelGreeting => {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Partial<IPanelGreeting>).type === 'panel' &&
    Number.isInteger((message as Partial<IPanelGreeting>).tabId)
  );
};

const tell = (port: IPort | undefined, message: BackgroundMessage | PanelMessage): void => {
  try {
    port?.postMessage(message);
  } catch {
    // a port that closed meanwhile: its disconnect tells the rest
  }
};

// definition

const { runtime } = chromeOf();
// the top frame's bridge of each tab, and the panel open on each
const pages = new Map<number, IPort>();
const panels = new Map<number, IPort>();

/** A page and its panel, met: the panel told, the page's hook asked for its sources and watched. */
const meet = (page: IPort, panel: IPort): void => {
  tell(panel, { type: 'page-connected' });
  tell(page, { type: 'hello' });
  tell(page, { type: 'watch' });
};

const takePage = (port: IPort): void => {
  const tabId = port.sender?.tab?.id;

  if (tabId === undefined || port.sender?.frameId !== 0) {
    port.disconnect();

    return;
  }

  pages.set(tabId, port);
  port.onMessage.addListener((message) => {
    tell(panels.get(tabId), message as BackgroundMessage);
  });
  port.onDisconnect.addListener(() => {
    if (pages.get(tabId) === port) {
      pages.delete(tabId);
      tell(panels.get(tabId), { type: 'page-gone' });
    }
  });

  const panel = panels.get(tabId);

  if (panel !== undefined) {
    meet(port, panel);
  }
};

const takePanel = (port: IPort): void => {
  let tabId: number | undefined;

  // a panel is a page of the extension's own, never a content script's
  if (port.sender?.url?.startsWith(runtime.getURL('')) !== true) {
    port.disconnect();

    return;
  }

  port.onMessage.addListener((message) => {
    if (tabId !== undefined) {
      tell(pages.get(tabId), message as PanelMessage);

      return;
    }

    if (isGreeting(message)) {
      tabId = message.tabId;
      panels.set(tabId, port);

      const page = pages.get(tabId);

      if (page !== undefined) {
        meet(page, port);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabId !== undefined && panels.get(tabId) === port) {
      panels.delete(tabId);
      tell(pages.get(tabId), { type: 'unwatch' });
    }
  });
};

runtime.onConnect.addListener((port) => {
  if (port.name === PORTS.page) {
    takePage(port);
  } else if (port.name === PORTS.panel) {
    takePanel(port);
  } else {
    port.disconnect();
  }
});
