// ── CORS page ─────────────────────────────────────────────────────────────────

// The script of a page a browser loads from an origin of its own: the HTTP client, bundled for the
// browser, calls the interop service's HTTP server at another origin, whose answers the browser
// hands it only as CORS lets it (spec 15.12; decision 0027).

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

(globalThis as { callAcrossOrigins?: typeof callAcrossOrigins }).callAcrossOrigins =
  callAcrossOrigins;
