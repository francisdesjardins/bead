import { once } from 'node:events';
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import {
  isLocalhostName,
  LOOPBACK_ATTEMPT_DELAY,
  loopbackConnectOptions,
  loopbackFailureOf,
  loopbackLookup,
} from '../loopback';
import { closedPort, PROBE, replaceResolver } from './loopback-fixtures';

// helpers

/** A listener on `address` and a free port, which notes each connection it accepts. */
const listenOn = async (address: string) => {
  const accepted: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    accepted.push(socket.localAddress ?? '');
    socket.end();
  });

  server.listen(0, address);
  await once(server, 'listening');

  return {
    accepted,
    port: (server.address() as AddressInfo).port,
    [Symbol.asyncDispose]: () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

/** `net.connect` to `host` and `port` with what `loopbackConnectOptions` gives: the address reached, or the error. */
const connectOf = (host: string, port: number): Promise<{ address: string } | Error> => {
  return new Promise((resolve) => {
    const socket = connect({ host, port, ...loopbackConnectOptions(host) }, () => {
      resolve({ address: socket.remoteAddress ?? '' });
      socket.destroy();
    });

    socket.on('error', (error) => {
      resolve(error);
    });
  });
};

/** What `loopbackLookup` answers `hostname` with, asked with `options`. */
const lookedUp = (hostname: string, options: { all?: boolean; family?: number | string }) => {
  return promisify((callback: (error: Error | null, answer: unknown) => void) => {
    // oxlint-disable-next-line max-params, bead/options-last -- dns.lookup's own callback
    loopbackLookup(hostname, options, (error, address, family) => {
      callback(error, options.all === true ? address : { address, family });
    });
  })();
};

// definition

test.describe('loopbackLookup', () => {
  // spec 13.4
  test('connects a localhost name to the loopback, asking its resolver nothing', async () => {
    await using listener = await listenOn('127.0.0.1');
    using resolver = replaceResolver();

    for (const host of [PROBE, 'localhost', 'A.LocalHost']) {
      expect(await connectOf(host, listener.port)).toEqual({ address: '127.0.0.1' });
    }

    expect([resolver.asked, listener.accepted.length]).toEqual([[], 3]);
  });

  // spec 13.4, RFC 8305
  test('tries the IPv4 loopback first for a localhost name, then the IPv6 one an attempt delay after', async () => {
    expect(await lookedUp(PROBE, { all: true })).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    expect(await lookedUp(PROBE, {})).toEqual({ address: '127.0.0.1', family: 4 });
    expect(loopbackConnectOptions(PROBE)).toEqual({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: LOOPBACK_ATTEMPT_DELAY,
      lookup: loopbackLookup,
    });
    expect(LOOPBACK_ATTEMPT_DELAY).toBe(250);
  });

  // spec 13.4
  test('asks its resolver for any other name, localhost with a trailing dot among them', async () => {
    using resolver = replaceResolver();

    for (const host of ['localhost.', 'a.localhost.', 'localhost.example', '127.0.0.1', '::1']) {
      expect([host, isLocalhostName(host), loopbackConnectOptions(host)]).toEqual([
        host,
        false,
        {},
      ]);
    }

    // * handed on to Node's own lookup, which the replaced resolver answers
    expect(await lookedUp('a.localhost.', { all: true })).toEqual([
      { address: '192.0.2.7', family: 4 },
    ]);
    expect(resolver.asked).toEqual(['a.localhost.']);
  });

  test('answers a lookup of one family with that family’s loopback alone', async () => {
    expect([
      await lookedUp(PROBE, { family: 4 }),
      await lookedUp(PROBE, { family: 6 }),
      await lookedUp(PROBE, { all: true, family: 'IPv6' }),
      await lookedUp(PROBE, { all: true, family: 4 }),
    ]).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
      [{ address: '::1', family: 6 }],
      [{ address: '127.0.0.1', family: 4 }],
    ]);
  });

  // spec 13.4
  test('says that a localhost name it could not connect went to the loopback, no resolver asked', async () => {
    await using closed = await closedPort();
    using resolver = replaceResolver();
    const failure = await connectOf(PROBE, closed.port);
    // * as a fetch fails on it: a TypeError, the socket's error its cause
    const fetchFailure = new TypeError('fetch failed', { cause: failure });
    const said = loopbackFailureOf(fetchFailure, { host: PROBE }) as TypeError;

    expect([failure instanceof Error, resolver.asked]).toEqual([true, []]);
    expect([said instanceof TypeError, said.cause]).toEqual([true, fetchFailure]);
    expect(said.message).toBe(
      `fetch failed; ${PROBE} names the loopback: connected to 127.0.0.1 and ::1, no resolver asked`
    );

    // another host, a reason of another type, and the reason of a signal that aborted are kept
    const controller = new AbortController();
    const reason = new TypeError('given up');

    controller.abort(reason);
    expect([
      loopbackFailureOf(fetchFailure, { host: '127.0.0.1' }),
      loopbackFailureOf(failure, { host: PROBE }),
      loopbackFailureOf(reason, { host: PROBE, signal: controller.signal }),
    ]).toEqual([fetchFailure, failure, reason]);
  });

  // spec 13.4
  test('says nothing of the loopback once a localhost name’s connect opened a socket', () => {
    // * as a fetch fails once its socket opened: reset as it read, closed unanswered, or no cause
    for (const cause of [
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
      Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      undefined,
    ]) {
      const fetchFailure = new TypeError('fetch failed', { cause });

      expect(loopbackFailureOf(fetchFailure, { host: PROBE })).toBe(fetchFailure);
    }
  });
});
