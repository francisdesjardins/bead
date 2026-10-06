// ── Demo relay ────────────────────────────────────────────────────────────────

// The small local proxy that puts the page and the Bead servers on one public port. It stays out of
// the protocol and out of the transports: the WebSocket server and the HTTP one each listen on a
// local port of their own, and this passes each upgrade's bytes on to the first, as they came, both
// ways, and each exchange on to the second.

// dependencies

import { request as requestOf, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { pipeline, type Duplex } from 'node:stream';

// interfaces

/** Where the upgrades or the exchanges go: the address and the port a transport's `start` gave. */
export interface IRelayTarget {
  address: string;
  port: number;
}

// types

/** What Node hands an `upgrade` listener: the request, its socket, and what came past its head. */
// oxlint-disable-next-line bead/options-last -- Node's own, an `upgrade` listener's
type Upgrade = [request: IncomingMessage, socket: Duplex, head: Buffer];

// constants

// what an exchange takes on to the Bead server: what it reads, and the host and origin it checks a
// browser's against — nothing else, so no header of the way in reaches it
const FORWARDED = Object.freeze([
  'bead-connection-token',
  'bead-listen',
  'content-encoding',
  'content-length',
  'content-type',
  'host',
  'origin',
]);

// what a hop says of itself, which the next one never repeats
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// helpers

/** The path of a request's target, its query aside: a target no URL parses throws nothing here. */
export const pathOf = (request: IncomingMessage): string => {
  return (request.url ?? '/').split('?', 1)[0] ?? '/';
};

// the upgrade's request line and headers, as they came, which the target reads first
const headOf = (request: IncomingMessage): string => {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index] ?? ''}: ${request.rawHeaders[index + 1] ?? ''}`);
  }

  return `${lines.join('\r\n')}\r\n\r\n`;
};

// definition

/**
 * What an HTTP server's `upgrade` listener calls: an upgrade to `pathname` goes on to `target`,
 * its handshake and every frame after, and any other is closed. Either end gone takes the other
 * with it.
 */
export const relayUpgrades = ({
  pathname,
  target,
}: {
  pathname: string;
  target: IRelayTarget;
}): ((...upgrade: Upgrade) => void) => {
  return (...[request, socket, head]: Upgrade) => {
    if (pathOf(request) !== pathname) {
      return (socket.destroy(), undefined);
    }

    // written before the socket connects, which keeps them first, and in order
    const upstream = connect(target.port, target.address);

    upstream.write(headOf(request));
    upstream.write(head);
    pipeline(socket, upstream, socket, () => {
      socket.destroy();
      upstream.destroy();
    });
  };
};

/**
 * What an HTTP server's request listener calls for the Bead path: a `GET`, a `POST` or a `DELETE`
 * goes on to `target` — a listen with its query — its body as it comes, and the answer comes back,
 * its head passed on at once, as the Bead
 * server sends it when it hands a request on; any other method is 405. An answer that comes before
 * the whole body — a 413 — stops the upload and closes the socket behind it. A client gone cuts the
 * exchange on the way in, and an answer cut on its way cuts the one on the way out: a loss reaches
 * each end as a loss. The address it came from goes as `x-forwarded-for`, written anew.
 */
export const relayExchanges = (
  target: IRelayTarget
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
      response.writeHead(405, { allow: 'GET, POST, DELETE' });

      return (response.end(), undefined);
    }

    const headers: Record<string, string> = {
      'x-forwarded-for': request.socket.remoteAddress ?? '',
    };

    for (const name of FORWARDED) {
      const value = request.headers[name];

      if (typeof value === 'string') {
        headers[name] = value;
      }
    }

    const upstream = requestOf(
      {
        headers,
        host: target.address,
        method: request.method,
        // the Bead path and a listen's query: the pages server sends nothing else here, so an
        // absolute target, which would name another host, never comes
        path: request.url,
        port: target.port,
      },
      (answer) => {
        const answerHeaders = Object.fromEntries(
          Object.entries(answer.headers).filter(([name]) => {
            return !HOP_BY_HOP.has(name);
          })
        ) as Record<string, string>;

        // the rest of an upload the answer came before goes nowhere, and its socket closes after
        if (!request.complete) {
          request.unpipe(upstream);
          request.resume();
          answerHeaders['connection'] = 'close';
        }

        response.writeHead(answer.statusCode ?? 502, answerHeaders);
        response.flushHeaders();
        // an answer cut on its way leaves its client nothing whole to read
        pipeline(answer, response, (error) => {
          if (error instanceof Error) {
            response.destroy();
          }
        });
      }
    );

    // the Bead server gone: a 502 and nothing of why, or, the head out, the answer cut
    upstream.on('error', () => {
      if (response.writableFinished) {
        return;
      }

      if (response.headersSent) {
        return (response.destroy(), undefined);
      }

      response.writeHead(502);
      response.end();
    });

    // the client gone before its answer went whole: the Bead server learns its exchange was lost
    response.on('close', () => {
      if (!response.writableFinished) {
        upstream.destroy();
      }
    });

    request.pipe(upstream);
  };
};
