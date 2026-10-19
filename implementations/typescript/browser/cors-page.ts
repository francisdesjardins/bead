// ── CORS page ─────────────────────────────────────────────────────────────────

// The script of a page a browser loads from an origin of its own: the HTTP client, bundled for the
// browser, calls the interop service's HTTP server at another origin, whose answers the browser
// hands it only as CORS lets it (spec 15.12; decision 0027), and whose preflight it caches by the
// connection's one URL (spec 15.9; decision 0029); and the page's own server, whose redirect a
// page's fetch hands back with no status (spec 15.6).

// dependencies

import { InteropClient } from '../interop/generated/interop_bead';
import { createHTTPClient, CredentialScheme } from '../src/client/http-client';

// interfaces

/** What a page came to against a server: each step's outcome, or why its connect failed. */
export interface ICrossOriginReport {
  /** Why the connect failed, when it did: nothing after it is tried. */
  connectFailure?: string;
  /** The client's disconnect, its `DELETE`, resolved. */
  disconnected?: boolean;
  /** What `echo` answered. */
  echoed?: unknown;
  /** What the subscription to `ticks` heard, brought back by a listen. */
  heard?: unknown;
  /** A `POST` on a connection gone, refused: its status and its mark, as the page reads them. */
  refusal?: [number, string | null];
  /** What `whoami` answered to an `ELSEWHERE` carried in `Authorization`. */
  whoami?: unknown;
}

/** Where the page calls: the server's host and its HTTP port. */
export interface ICrossOriginTarget {
  host: string;
  port: number;
}

// constants

/** The credential the interop service's verifier reads from `Authorization`. */
const CARRIED = 'Interop sub=ada';

// definition

/**
 * Connects to the server at `target`, calls `echo`, presents an `ELSEWHERE`, hears a tick it
 * subscribed to, reads a refusal of the transport's own, `connection-unknown`, and disconnects; a
 * connect that fails ends it, saying why.
 */
const callAcrossOrigins = async (target: ICrossOriginTarget): Promise<ICrossOriginReport> => {
  const client = createHTTPClient();

  try {
    await client.connect(target);
  } catch (error) {
    return { connectFailure: String(error) };
  }

  const interop = new InteropClient(client);
  const echoed = await interop.echo({ across: 'origins' })();
  const whoami = await interop.whoami(null)({
    credential: { carried: CARRIED, scheme: CredentialScheme.ELSEWHERE },
  });
  const ticked = Promise.withResolvers<unknown>();
  const registration = await interop.notifications.ticks(null, (value) => {
    ticked.resolve(value);
  })();

  await interop.tick({ value: 1 })();

  const heard = await ticked.promise;

  await registration.unregister();

  // a token no connection holds, which the client never writes: preflighted, its refusal read
  const refused = await fetch(`http://${target.host}:${String(target.port)}/bead`, {
    headers: { 'bead-connection-token': 'A'.repeat(22), 'content-type': 'application/prs.bead' },
    method: 'POST',
  });

  await client.transport.disconnect();

  return {
    disconnected: true,
    echoed,
    heard,
    refusal: [refused.status, refused.headers.get('bead-refusal')],
    whoami,
  };
};

/**
 * Connects to the server at `target`, subscribes to `ticks`, and ticks `count` times, each tick
 * heard before the next goes, so each comes back in a batch of its own; then disconnects. What it
 * heard, in order, or why its connect failed.
 */
const listenAcrossOrigins = async (
  target: ICrossOriginTarget,
  { count }: { count: number }
): Promise<{ connectFailure?: string; heard?: unknown[] }> => {
  const client = createHTTPClient();

  try {
    await client.connect(target);
  } catch (error) {
    return { connectFailure: String(error) };
  }

  const interop = new InteropClient(client);
  const heard: unknown[] = [];
  let ticked = Promise.withResolvers<void>();
  const registration = await interop.notifications.ticks(null, (value) => {
    heard.push(value);
    ticked.resolve();
  })();

  for (let value = 1; value <= count; value += 1) {
    await interop.tick({ value })();
    await ticked.promise;
    ticked = Promise.withResolvers<void>();
  }

  await registration.unregister();
  await client.transport.disconnect();

  return { heard };
};

/**
 * Connects to the server of the page's own origin, at the page's host and port, and disconnects:
 * why its connect failed, or that it disconnected.
 */
const connectToOwnOrigin = async (): Promise<ICrossOriginReport> => {
  const client = createHTTPClient();

  try {
    await client.connect({ host: location.hostname, port: Number(location.port) });
  } catch (error) {
    return { connectFailure: String(error) };
  }

  await client.transport.disconnect();

  return { disconnected: true };
};

Object.assign(globalThis, { callAcrossOrigins, connectToOwnOrigin, listenAcrossOrigins });
