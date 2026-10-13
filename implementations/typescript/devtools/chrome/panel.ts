// ── DevTools panel, Chrome's ──────────────────────────────────────────────────

// The Bead panel, as Chrome's DevTools loads it: the panel's host made of Chrome's API — its runtime
// port, the inspected tab, DevTools' theme, the Network panel's exchanges, Sources and a reload.
// Opened outside DevTools, as its tests open it, it reads its tab from `?tabId=` and has no Network
// panel to read.

// dependencies

import type { IPanelHost } from '../host';
import { PORTS } from '../messages';
import { startPanel } from '../panel';
import { chromeOf } from './api';

// definition

const chrome = chromeOf();
const devtools = chrome.devtools;

const host: IPanelHost = {
  connect: () => {
    const port = chrome.runtime.connect({ name: PORTS.panel });

    return {
      onDisconnect: (listener) => {
        port.onDisconnect.addListener(() => {
          listener();
        });
      },
      onMessage: (listener) => {
        port.onMessage.addListener(listener);
      },
      postMessage: (message) => {
        port.postMessage(message);
      },
    };
  },
  onExchange:
    devtools === undefined
      ? undefined
      : (listener) => {
          devtools.network.onRequestFinished.addListener(listener);
        },
  // Chrome counts a resource's lines from 0
  openResource:
    devtools?.panels.openResource === undefined
      ? undefined
      : (url, line) => {
          devtools.panels.openResource?.(url, line - 1);
        },
  reload:
    devtools?.inspectedWindow.reload === undefined
      ? undefined
      : () => {
          devtools.inspectedWindow.reload?.();
        },
  tabId:
    devtools?.inspectedWindow.tabId ?? Number(new URLSearchParams(location.search).get('tabId')),
  theme: devtools?.panels.themeName === 'dark' ? 'dark' : 'light',
};

startPanel(host);
