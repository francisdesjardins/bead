// ── TLS front ─────────────────────────────────────────────────────────────────

// The peer of a client's TLS twins (spec 15.39): TLS under the test PKI, piped to a plain server.

// dependencies

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

// interfaces

/** How a front stands: whose certificate it serves, whether it asks for one, its highest version. */
export interface ITlsFrontOptions {
  /** Its highest TLS version; TLS 1.3 by default. */
  maxVersion?: 'TLSv1.2' | 'TLSv1.3' | undefined;
  /** Whether it requires a client certificate under the root, refusing the handshake without one. */
  requiresCertificate?: boolean | undefined;
  /** `stranger` serves a certificate under the stranger's root, which no test trusts. */
  serves?: 'server' | 'stranger' | undefined;
}

// helpers

/** A file of the spec's test PKI, read by path, as every side's tests read it. */
const pemOf = (file: string): string => {
  return readFileSync(new URL(`../../../../../../spec/pki/${file}`, import.meta.url), 'utf8');
};

// constants

/** The test PKI's files: published test keys, which guard nothing. */
export const PKI = Object.freeze({
  client: pemOf('client.pem'),
  clientChain: pemOf('client-chain.pem'),
  clientKey: pemOf('client.key'),
  root: pemOf('root.pem'),
  server: pemOf('server.pem'),
  serverKey: pemOf('server.key'),
  strangerClient: pemOf('stranger-client.pem'),
  strangerClientKey: pemOf('stranger-client.key'),
  strangerServer: pemOf('stranger-server.pem'),
  strangerServerKey: pemOf('stranger-server.key'),
});

/** The TLS twins' versions, each a run of its own. */
export const TLS_VERSIONS = ['TLSv1.2', 'TLSv1.3'] as const;

// definition

/**
 * A front on 127.0.0.1 that takes TLS under the test PKI, asks for a client certificate under its
 * root or for none, and pipes each connection it accepted to `port`, the plain server's; its dispose
 * closes it and every connection through it.
 */
export const createTlsFront = async (port: number, options?: ITlsFrontOptions) => {
  const { maxVersion = 'TLSv1.3', requiresCertificate = false, serves = 'server' } = options ?? {};
  const sockets = new Set<Socket>();
  const front = createTlsServer(
    {
      cert: serves === 'server' ? PKI.server : PKI.strangerServer,
      key: serves === 'server' ? PKI.serverKey : PKI.strangerServerKey,
      maxVersion,
      ...(requiresCertificate ? { ca: PKI.root, rejectUnauthorized: true, requestCert: true } : {}),
    },
    (accepted: TLSSocket) => {
      const plain = connectTcp(port, '127.0.0.1');

      sockets.add(accepted).add(plain);
      accepted.on('error', () => {
        plain.destroy();
      });
      plain.on('error', () => {
        accepted.destroy();
      });
      accepted.pipe(plain).pipe(accepted);
    }
  );

  // a handshake refused is the test's outcome, never the front's failure
  front.on('tlsClientError', () => {});
  front.listen(0, '127.0.0.1');
  await once(front, 'listening');

  return {
    port: (front.address() as AddressInfo).port,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        front.close(() => {
          resolve();
        });
      });
    },
  };
};
