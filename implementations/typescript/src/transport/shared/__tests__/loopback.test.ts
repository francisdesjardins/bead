import { EventEmitter, once } from 'node:events';
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { expect, test } from '@playwright/test';
import { createClock } from '@sinonjs/fake-timers';
import * as undici from 'undici';
import {
  isConnectFailure,
  isLocalhostName,
  type IUndici,
  type IUndiciConnectOptions,
  LOOPBACK_ATTEMPT_DELAY,
  loopbackConnector,
  loopbackCreateConnection,
  loopbackFailureOf,
  raceLoopback,
  type UndiciConnector,
} from '../loopback';
import { TLS_FIXTURE } from '../../server/__tests__/tls-fixture';
import { closedPort, PROBE, replaceResolver } from './loopback-fixtures';

// interfaces

// a socket of the test's, which an attempt hands the race: it connects or fails as the test says,
// and notes whether the race destroyed it
interface IHeldSocket extends EventEmitter {
  readonly address: string;
  destroyed: boolean;
  destroy(): IHeldSocket;
}

// helpers

/** A listener on `address` and `port`, any when none, which notes each connection it accepts. */
const listenOn = async (address: string, port = 0) => {
  const accepted: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    accepted.push(socket.localAddress ?? '');
    socket.end();
  });

  server.listen(port, address);
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

/** A race of `port` on the loopback, as a localhost name connects: the address reached, or the error. */
const connectOf = async (port: number): Promise<{ address: string } | Error> => {
  try {
    const socket = await raceLoopback(port, { timeout: 5_000 });
    const address = socket.remoteAddress ?? '';

    socket.destroy();

    return { address };
  } catch (reason) {
    return reason as Error;
  }
};

/** A socket of the test's to `address`, which connects or fails as the test says. */
const heldSocketOf = (address: string): IHeldSocket => {
  const socket = Object.assign(new EventEmitter(), {
    address,
    destroy: () => {
      socket.destroyed = true;

      return socket;
    },
    destroyed: false,
  });

  return socket;
};

// a connect refused, as Node fails one
const refusedOf = (address: string): Error => {
  return Object.assign(new Error(`connect ECONNREFUSED ${address}:4242`), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
  });
};

/**
 * A race of the loopback on a clock of the test's, each attempt a socket of the test's it notes,
 * with the time it began, but an attempt to an address of `throwing`, which throws as it is made;
 * given up by `signal` or at `timeout`, never by default.
 */
const heldRaceOf = ({
  signal,
  throwing = [],
  timeout = Infinity,
}: {
  signal?: AbortSignal;
  throwing?: readonly string[];
  timeout?: number;
}) => {
  const clock = createClock();
  const attempts: { at: number; socket: IHeldSocket }[] = [];
  const outcome = raceLoopback(4_242, {
    attempt: (address) => {
      if (throwing.includes(address)) {
        throw refusedOf(address);
      }

      const socket = heldSocketOf(address);

      attempts.push({ at: clock.now, socket });

      return socket as unknown as Socket;
    },
    clock,
    signal,
    timeout,
  }).then(
    (socket) => {
      return { address: (socket as unknown as IHeldSocket).address };
    },
    (reason: unknown) => {
      return reason;
    }
  );
  // the attempt to `address`, once it began
  const attemptOf = (address: string): IHeldSocket => {
    const found = attempts.find(({ socket }) => {
      return socket.address === address;
    });

    if (found === undefined) {
      throw new Error(`no attempt to ${address}`);
    }

    return found.socket;
  };
  // each attempt's address and the time it began, then whether the race destroyed it
  const begunOf = () => {
    return attempts.map(({ at, socket }) => {
      return [socket.address, at];
    });
  };
  const destroyedOf = () => {
    return attempts.map(({ socket }) => {
      return [socket.address, socket.destroyed];
    });
  };

  return { attemptOf, begunOf, clock, destroyedOf, outcome };
};

// definition

test.describe('loopback', () => {
  // spec 13.4.2
  test('connects a localhost name to the loopback, asking its resolver nothing', async () => {
    await using listener = await listenOn('127.0.0.1');
    using resolver = replaceResolver();

    for (const host of [PROBE, 'localhost', 'A.LocalHost']) {
      expect([host, isLocalhostName(host), await connectOf(listener.port)]).toEqual([
        host,
        true,
        { address: '127.0.0.1' },
      ]);
    }

    expect([resolver.asked, listener.accepted.length]).toEqual([[], 3]);
  });

  // spec 13.4.2, RFC 8305 §5, RFC 6724 §2.1
  test('tries the IPv4 loopback first for a localhost name, then the IPv6 one an attempt delay after', async () => {
    // * a listener on each, on one port: the IPv4 one is reached, and the IPv6 one never is
    await using ipv4 = await listenOn('127.0.0.1');
    let ipv6: Awaited<ReturnType<typeof listenOn>> | undefined;

    try {
      ipv6 = await listenOn('::1', ipv4.port);
    } catch {
      // a machine without the IPv6 loopback
    }

    try {
      expect(await connectOf(ipv4.port)).toEqual({ address: '127.0.0.1' });
      await new Promise((resolve) => {
        setTimeout(resolve, LOOPBACK_ATTEMPT_DELAY + 50);
      });
      expect([ipv4.accepted.length, ipv6?.accepted.length ?? 0]).toEqual([1, 0]);
    } finally {
      await ipv6?.[Symbol.asyncDispose]();
    }

    // the IPv6 attempt begins 250 ms after the IPv4 one, which has not connected
    const race = heldRaceOf({});

    await race.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY);
    expect([race.begunOf(), LOOPBACK_ATTEMPT_DELAY]).toEqual([
      [
        ['127.0.0.1', 0],
        ['::1', 250],
      ],
      250,
    ]);
    race.attemptOf('127.0.0.1').emit('connect');
    expect(await race.outcome).toEqual({ address: '127.0.0.1' });
  });

  // spec 13.4.2, RFC 8305 §5
  test('connects by the next family 250 ms after an attempt that has not connected', async () => {
    const race = heldRaceOf({});

    await race.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY - 1);
    expect(race.begunOf()).toEqual([['127.0.0.1', 0]]);

    await race.clock.tickAsync(1);
    race.attemptOf('::1').emit('connect');

    expect(await race.outcome).toEqual({ address: '::1' });
    expect(race.destroyedOf()).toEqual([
      ['127.0.0.1', true],
      ['::1', false],
    ]);

    // * an attempt that fails starts the next at once, the delay not waited
    const failing = heldRaceOf({});

    failing.attemptOf('127.0.0.1').emit('error', refusedOf('127.0.0.1'));
    failing.attemptOf('::1').emit('connect');
    expect([await failing.outcome, failing.begunOf()]).toEqual([
      { address: '::1' },
      [
        ['127.0.0.1', 0],
        ['::1', 0],
      ],
    ]);

    // and so does an attempt that throws as it is made, which fails as one refused
    const thrown = heldRaceOf({ throwing: ['127.0.0.1'] });

    thrown.attemptOf('::1').emit('connect');
    expect([await thrown.outcome, thrown.begunOf(), thrown.clock.countTimers()]).toEqual([
      { address: '::1' },
      [['::1', 0]],
      0,
    ]);
  });

  // spec 13.4.2, RFC 8305 §5
  test('cancels the attempts left once one connects', async () => {
    // both begun: the one that connects wins, the other pending is destroyed
    const both = heldRaceOf({});

    await both.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY);
    both.attemptOf('::1').emit('connect');
    expect([await both.outcome, both.destroyedOf()]).toEqual([
      { address: '::1' },
      [
        ['127.0.0.1', true],
        ['::1', false],
      ],
    ]);

    // the first connected within its delay: the next never begins
    const first = heldRaceOf({});

    first.attemptOf('127.0.0.1').emit('connect');
    await first.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY * 4);
    expect([await first.outcome, first.begunOf(), first.clock.countTimers()]).toEqual([
      { address: '127.0.0.1' },
      [['127.0.0.1', 0]],
      0,
    ]);
  });

  // spec 13.4.2, RFC 8305 §5
  test('keeps an attempt that has not connected by its delay while the next one starts, the first to connect winning and the other closed', async () => {
    const race = heldRaceOf({});

    // * the IPv4 attempt held past its delay: kept as the IPv6 one begins
    await race.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY);
    expect(race.destroyedOf()).toEqual([
      ['127.0.0.1', false],
      ['::1', false],
    ]);

    race.attemptOf('127.0.0.1').emit('connect');
    expect(await race.outcome).toEqual({ address: '127.0.0.1' });
    expect(race.destroyedOf()).toEqual([
      ['127.0.0.1', false],
      ['::1', true],
    ]);

    // the other connecting after it is closed, and its error after throws nothing
    race.attemptOf('::1').emit('connect');
    race.attemptOf('::1').emit('error', refusedOf('::1'));
    expect(race.attemptOf('::1').destroyed).toBe(true);
  });

  // spec 13.4.2, RFC 8305 §5
  test('ends every attempt, leaving no socket, once its connect is given up', async () => {
    // at its timeout: each attempt still open ended, and counted as a connect that timed out
    const timed = heldRaceOf({ timeout: 1_000 });

    await timed.clock.tickAsync(1_000);

    const failure = (await timed.outcome) as AggregateError;

    expect([
      failure instanceof AggregateError,
      isConnectFailure(failure),
      failure.errors.map(({ code, message }: Error & { code?: string }) => {
        return [code, message];
      }),
      timed.destroyedOf(),
      timed.clock.countTimers(),
    ]).toEqual([
      true,
      true,
      [
        ['ETIMEDOUT', 'connect ETIMEDOUT 127.0.0.1:4242'],
        ['ETIMEDOUT', 'connect ETIMEDOUT ::1:4242'],
      ],
      [
        ['127.0.0.1', true],
        ['::1', true],
      ],
      0,
    ]);

    // at its signal: each attempt ended, the signal's reason its own, and a late connect closed
    const controller = new AbortController();
    const reason = new Error('given up');
    const aborted = heldRaceOf({ signal: controller.signal });

    controller.abort(reason);
    expect([await aborted.outcome, aborted.destroyedOf(), aborted.clock.countTimers()]).toEqual([
      reason,
      [['127.0.0.1', true]],
      0,
    ]);
    await aborted.clock.tickAsync(LOOPBACK_ATTEMPT_DELAY);
    aborted.attemptOf('127.0.0.1').emit('connect');
    expect(aborted.begunOf()).toEqual([['127.0.0.1', 0]]);

    // given up before it began: no attempt made, the signal's reason its own
    const before = heldRaceOf({ signal: AbortSignal.abort(reason) });

    expect([await before.outcome, before.begunOf(), before.clock.countTimers()]).toEqual([
      reason,
      [],
      0,
    ]);

    // every attempt failed: their errors in one, a connect failure
    const refused = heldRaceOf({});

    refused.attemptOf('127.0.0.1').emit('error', refusedOf('127.0.0.1'));
    refused.attemptOf('::1').emit('error', refusedOf('::1'));

    const both = (await refused.outcome) as AggregateError;

    expect([isConnectFailure(both), both.message, refused.clock.countTimers()]).toEqual([
      true,
      'connect ECONNREFUSED 127.0.0.1:4242; connect ECONNREFUSED ::1:4242',
      0,
    ]);

    // and so does every attempt that threw as it was made
    const thrown = heldRaceOf({ throwing: ['127.0.0.1', '::1'] });
    const neither = (await thrown.outcome) as AggregateError;

    expect([isConnectFailure(neither), neither.message, thrown.clock.countTimers()]).toEqual([
      true,
      'connect ECONNREFUSED 127.0.0.1:4242; connect ECONNREFUSED ::1:4242',
      0,
    ]);
  });

  // spec 13.4.2: Node's event loop held past the attempt delay as the race begins
  test('connects to a server on 127.0.0.1 alone with its event loop held past the attempt delay', async () => {
    await using listener = await listenOn('127.0.0.1');
    const pending = connectOf(listener.port);
    const until = performance.now() + LOOPBACK_ATTEMPT_DELAY + 100;

    // * the loop held at once, so the IPv6 attempt's timer is due before the IPv4 one is read
    while (performance.now() < until) {
      // held
    }

    expect(await pending).toEqual({ address: '127.0.0.1' });
  });

  // spec 13.4.1 and 13.4.2
  test('asks its resolver for any other name, localhost with a trailing dot among them', async () => {
    // * the replaced resolver answers the loopback, where the test listens
    using resolver = replaceResolver('127.0.0.1');
    await using listener = await listenOn('127.0.0.1');
    const connector = loopbackConnector(undici as unknown as IUndici, {});
    const connectedOf = (hostname: string) => {
      return new Promise<Error | Socket | null>((resolve) => {
        connector({ hostname, port: String(listener.port), protocol: 'http:' }, (error, socket) => {
          resolve(error ?? socket);
        });
      });
    };

    for (const host of ['localhost.', 'a.localhost.', 'localhost.example', '127.0.0.1', '::1']) {
      expect([host, isLocalhostName(host)]).toEqual([host, false]);
    }

    // * handed on to undici's own connector, which asks Node's resolver
    for (const hostname of ['localhost.', 'a.localhost.']) {
      const socket = (await connectedOf(hostname)) as Socket;

      expect([hostname, socket.remoteAddress]).toEqual([hostname, '127.0.0.1']);
      socket.destroy();
    }

    expect(resolver.asked).toEqual(['localhost.', 'a.localhost.']);
  });

  // spec 13.4.2
  test('says that a localhost name it could not connect went to the loopback, no resolver asked', async () => {
    await using closed = await closedPort();
    using resolver = replaceResolver();
    const failure = await connectOf(closed.port);
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

  // spec 13.4.2
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

  // spec 13.4.2; RFC 6066 §3
  test('lays TLS over the winner under wss with the server name ws would set, and lets the winner go where TLS throws as it is laid', async () => {
    // * the name each handshake sent, false for none, and each connection's close
    const named: (string | false | null)[] = [];
    const closes: Promise<unknown>[] = [];
    const server = createTlsServer({ cert: TLS_FIXTURE.cert, key: TLS_FIXTURE.key }, (socket) => {
      named.push(socket.servername);
      socket.end();
    });

    server.on('connection', (socket: Socket) => {
      closes.push(once(socket, 'close'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const { port } = server.address() as AddressInfo;
    // what `ws` hands `createConnection` for a `wss` URL to a localhost name, and what it creates
    const createdOf = (options: Record<string, unknown>) => {
      return new Promise<Error | Socket>((resolve) => {
        loopbackCreateConnection('localhost', { timeout: 5_000 })(
          // * the test reads the name each handshake sends, names no certificate holds among them,
          // and trusts nothing it reads
          // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
          { defaultPort: 443, host: 'localhost', port, rejectUnauthorized: false, ...options },
          (error, socket) => {
            resolve(error ?? (socket as Socket));
          }
        );
      });
    };

    try {
      // the URL's name, a name given over it, and none for an IP literal
      for (const options of [{}, { servername: 'bead.localhost' }, { host: '127.0.0.1' }]) {
        const secured = (await createdOf(options)) as Socket;

        // * ended by the server once its handshake read the name
        secured.resume();
        await once(secured, 'end');
        secured.destroy();
      }

      // * a TLS option it cannot take: the connect failed, and the raced socket closed
      const failure = await createdOf({ ciphers: 'none of them' });

      await expect
        .poll(() => {
          return closes.length;
        })
        .toBe(4);
      await Promise.all(closes);
      expect([named, failure instanceof Error]).toEqual([
        ['localhost', 'bead.localhost', false],
        true,
      ]);
    } finally {
      server.close();
    }
  });

  // spec 13.4.2
  test('hands the winner to undici’s own connector under https, and lets the winner go where that connector throws', async () => {
    await using listener = await listenOn('127.0.0.1');
    // * undici's connector, which notes what it is handed, and throws once told to
    const handed: IUndiciConnectOptions[] = [];
    let isThrowing = false;
    const undici = {
      buildConnector: (): UndiciConnector => {
        return (options, callback) => {
          handed.push(options);

          if (isThrowing) {
            throw new Error('no connector');
          }

          callback(null, options.httpSocket ?? null);
        };
      },
    } as unknown as IUndici;
    const connector = loopbackConnector(undici, {});
    const connectedOf = (options: IUndiciConnectOptions) => {
      return new Promise<Error | Socket | null>((resolve) => {
        connector(options, (error, socket) => {
          resolve(error ?? socket);
        });
      });
    };
    const port = String(listener.port);

    // a host but a localhost name goes to undici's connector unchanged
    const away = { hostname: 'example.test', port: '443', protocol: 'https:' };

    expect([await connectedOf(away), handed]).toEqual([null, [away]]);

    // * under https, the winner is the connector's socket to lay TLS over
    const secured = (await connectedOf({ hostname: PROBE, port, protocol: 'https:' })) as Socket;

    expect([secured.remoteAddress, handed[1]?.httpSocket === secured]).toEqual(['127.0.0.1', true]);
    secured.destroy();

    // in the clear, the winner is the connect's own, the connector asked nothing
    const clear = (await connectedOf({ hostname: PROBE, port, protocol: 'http:' })) as Socket;

    expect([clear.remoteAddress, handed.length]).toEqual(['127.0.0.1', 2]);
    clear.destroy();

    isThrowing = true;

    const failure = await connectedOf({ hostname: PROBE, port, protocol: 'https:' });

    expect([failure, handed[2]?.httpSocket?.destroyed]).toEqual([new Error('no connector'), true]);
  });
});
