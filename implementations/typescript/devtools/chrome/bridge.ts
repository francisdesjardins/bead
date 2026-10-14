// ── DevTools bridge ───────────────────────────────────────────────────────────

// Between the hook, in the page's world, and the background, in the extension's: what the hook
// posts on the window goes to the background's port, and what the background sends comes back on
// the window. It runs in the extension's isolated world, which alone may open a runtime port.

// dependencies

import { chromeOf, type IPort } from './api';
import {
  CHANNEL,
  isWindowMessage,
  type IWindowMessage,
  type PanelMessage,
  PORTS,
} from '../messages';

// constants

/** How long a bridge whose port closed waits before it opens another, in milliseconds. */
const RECONNECT_MILLISECONDS = 1_000;

// definition

let port: IPort | undefined;

const connect = (): void => {
  const { runtime } = chromeOf();

  // an extension reloaded or removed leaves this bridge behind, with nothing to reach
  if (runtime.id === undefined) {
    return;
  }

  const opened = runtime.connect({ name: PORTS.page });

  opened.onMessage.addListener((message) => {
    const data: IWindowMessage = {
      channel: CHANNEL,
      from: 'bridge',
      message: message as PanelMessage,
    };

    // the page's own window, at its own origin: '/' names it, an opaque one included, where '*'
    // would reach a document the window navigated to
    window.postMessage(data, '/');
  });
  // a background that stopped, as a service worker does, is reached again
  opened.onDisconnect.addListener(() => {
    port = undefined;
    setTimeout(connect, RECONNECT_MILLISECONDS);
  });
  port = opened;
};

window.addEventListener('message', (event) => {
  if (event.source !== window || !isWindowMessage(event.data, 'hook')) {
    return;
  }

  port?.postMessage((event.data as IWindowMessage).message);
});

connect();
