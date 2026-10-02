// ── Demo worker ───────────────────────────────────────────────────────────────

// The demo's server, in a Web Worker: the page's own, with no backend — its procedures, and the
// identity provider as one of them. It listens first, as its script runs, so the connect the page
// posted as it built the worker is not lost.
//
// Shared, it is one server for every tab of the site, each tab a client of its own: a shared worker
// hears each tab on a port, and each connect a tab posts on it reaches the server as a dedicated
// worker's would. The counter, the key and the subscriptions are then the tabs' together.

// dependencies

import { createWorkerServer } from '../src/server/worker-server';
import type {
  IWorkerMessageEventLike,
  IWorkerScopeLike,
} from '../src/transport/server/worker-transport-server';
import { offer, offerIdentity, SILENCE_MILLISECONDS } from './offer';
import type { IClaims } from './procedures';
import { keyOf } from './token';

// helpers

/** The scope a shared worker's tabs make together: what any of them posts, heard as one. */
const sharedScopeOf = (worker: EventTarget): IWorkerScopeLike => {
  const listeners = new Set<(event: IWorkerMessageEventLike) => void>();

  worker.addEventListener('connect', (event) => {
    const [tab] = (event as MessageEvent).ports;

    tab?.addEventListener('message', (message) => {
      for (const listener of listeners) {
        listener(message);
      }
    });
    tab?.start();
  });

  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
};

// definition

// a shared worker hears its tabs by `connect`, a dedicated one on its own scope
const scope = 'onconnect' in self ? sharedScopeOf(self) : self;
// a tab closed before it said so leaves a port that never tells: its silence closes it
const server = createWorkerServer<IClaims>({
  connectionInactivityTimeout: SILENCE_MILLISECONDS,
  transport: { scope },
});

void server.transport.start();

// the secret drawn here, and gone with the worker
const key = keyOf(crypto.getRandomValues(new Uint8Array(32)));

offer(server, key);
offerIdentity(server, key);
