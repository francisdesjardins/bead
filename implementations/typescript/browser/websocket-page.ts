// ── WebSocket page ────────────────────────────────────────────────────────────

// The script of a page a browser loads from an origin of its own: the WebSocket client, bundled
// for the browser and given no subprotocol, connects to a server at another port, which selects
// none, so the page's own WebSocket must offer none (spec 15.2).

// dependencies

import { createWebSocketClient } from '../src/client/websocket-client';

// interfaces

/** What a page came to against a server: that it connected, or why its connect failed. */
export interface IWebSocketReport {
  /** Why the connect failed, when it did. */
  connectFailure?: string;
  /** The client's connect resolved, and its disconnect after it. */
  disconnected?: boolean;
}

/** Where the page connects: the server's host and its port. */
export interface IWebSocketTarget {
  host: string;
  port: number;
}

// definition

/** Connects to the server at `target`, given no subprotocol, and disconnects. */
const connectOfferingNone = async (target: IWebSocketTarget): Promise<IWebSocketReport> => {
  const client = createWebSocketClient();

  try {
    await client.connect(target);
  } catch (error) {
    return { connectFailure: String(error) };
  }

  await client.transport.disconnect();

  return { disconnected: true };
};

Object.assign(globalThis, { connectOfferingNone });
