// ── Heartbeat ─────────────────────────────────────────────────────────────────

// dependencies

import { assertHeld, type IClock, type TimeoutId } from './clock';

// interfaces

/**
 * One WebSocket connection's heartbeat: told of what is read of it and of each pong, and stopped as
 * the connection ends.
 */
export interface IHeartbeat {
  /** A pong came: it answers the ping out when it echoes that ping's data, and nothing otherwise. */
  answer(data: Uint8Array): void;
  /** Something of the connection was read: its silence starts again, a ping out left unanswered. */
  heard(): void;
  stop(): void;
}

/** One connection's heartbeat on silence alone: told of all it hears, and stopped as it ends. */
export interface ISilenceHeartbeat {
  /** Something of the connection came: its silence starts again, and a ping before is answered. */
  heard(): void;
  stop(): void;
}

// constants

/**
 * How long, in milliseconds by default, a connection is silent before it is pinged, and how long its
 * ping waits for its echo before the connection is dropped.
 */
export const HEARTBEAT = 30_000;

// helpers

/**
 * `heartbeat` held: a number of milliseconds from 1 to 2³¹ − 1, rounded to the nearest whole one,
 * or `Infinity` for none; any other, 0 among them, is a {@link ProgrammerError}.
 */
export const assertHeartbeat = (heartbeat: number): number => {
  return assertHeld('a heartbeat', heartbeat);
};

// definition

// the data of a connection's `count`th ping: 8 bytes, the count big-endian, as .NET's keep-alive
// writes its own
const pingDataOf = (count: bigint): Uint8Array => {
  const data = new Uint8Array(8);

  new DataView(data.buffer).setBigUint64(0, count);

  return data;
};

const isEcho = (data: Uint8Array, pinged: Uint8Array): boolean => {
  return (
    data.length === pinged.length &&
    data.every((byte, index) => {
      return byte === pinged[index];
    })
  );
};

/**
 * Pings a WebSocket connection once nothing of it has been read for `heartbeat` milliseconds, and
 * drops it once the pong that echoes that ping's data has not come within `heartbeat` of the ping
 * (spec 15.3, RFC 6455 §5.5.3): what is read restarts its silence, but no frame answers the ping
 * other than its echo, and no other ping goes before. Each ping carries 8 bytes of its own, a count
 * from 1, big-endian, as .NET's keep-alive writes its own. Nothing at all for `Infinity`. It lives
 * below the protocol: a WebSocket's own PING and PONG frames (RFC 6455 §5.5.2), which a browser
 * answers by itself. It runs on its stack's platform clock, never the clock given (decision 0011),
 * which a test may replace through `clock`, and keeps no process alive.
 *
 * @example
 * const heartbeat = createHeartbeat(
 *   30_000,
 *   { drop: () => socket.terminate(), ping: (data) => socket.ping(data) },
 *   { clock: platform }
 * );
 * rawSocket.on('data', () => heartbeat.heard());
 * socket.on('pong', (data) => heartbeat.answer(data));
 * socket.on('close', () => heartbeat.stop());
 */
export const createHeartbeat = (
  heartbeat: number,
  { drop, ping }: { drop: () => void; ping: (data: Uint8Array) => void },
  { clock }: { clock: IClock }
): IHeartbeat => {
  const now = (): number => {
    return clock.performance.now();
  };
  let lastHeard = now();
  // the ping out, its data and when it went
  let pinged: { at: number; data: Uint8Array } | undefined;
  let count = 0n;
  let timer: TimeoutId | undefined;
  let isStopped = heartbeat === Infinity;

  const stop = (): void => {
    isStopped = true;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  // * a ping out waits `heartbeat` for its echo; none out, the connection is pinged once silent for
  // `heartbeat`; either armed again for what is left
  const check = (): void => {
    if (isStopped) {
      return;
    }

    const at = now();

    if (pinged !== undefined) {
      const waited = at - pinged.at;

      if (waited < heartbeat) {
        return (arm(heartbeat - waited), undefined);
      }

      stop();
      drop();

      return undefined;
    }

    const silent = at - lastHeard;

    if (silent < heartbeat) {
      return (arm(heartbeat - silent), undefined);
    }

    count += 1n;
    pinged = { at, data: pingDataOf(count) };
    arm(heartbeat);
    ping(pinged.data);

    return undefined;
  };
  const arm = (delay: number): void => {
    if (isStopped) {
      return;
    }

    // ! a millisecond at least, counted whole: no timer is armed for less (decision 0011)
    timer = clock.setTimeout(check, Math.max(1, Math.ceil(delay)));
    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
  };

  if (!isStopped) {
    arm(heartbeat);
  }

  return {
    answer: (data) => {
      lastHeard = now();

      if (pinged !== undefined && isEcho(data, pinged.data)) {
        pinged = undefined;
      }
    },
    heard: () => {
      lastHeard = now();
    },
    stop,
  };
};

/**
 * Pings a connection once nothing of it has come for `heartbeat` milliseconds, and drops it once
 * nothing has come by `heartbeat` after that ping; anything heard answers, as TCP sends a keep-alive
 * only when nothing came within its interval (RFC 9293 §3.8.4): a broker's connection, whose
 * parcels each tell it alive (spec 15.21). Nothing at all for `Infinity`. It runs on its stack's
 * platform clock, never the clock given, as the WebSocket's does (decision 0011), which a test may
 * replace through `clock`, and keeps no process alive.
 *
 * @example
 * const heartbeat = createSilenceHeartbeat(
 *   30_000,
 *   { drop: () => connection.close(4001), ping: () => connection.ping() },
 *   { clock: platform }
 * );
 * connection.onParcel(() => heartbeat.heard());
 */
export const createSilenceHeartbeat = (
  heartbeat: number,
  { drop, ping }: { drop: () => void; ping: () => void },
  { clock }: { clock: IClock }
): ISilenceHeartbeat => {
  const now = (): number => {
    return clock.performance.now();
  };
  let lastHeard = now();
  let pingedAt: number | undefined;
  let timer: TimeoutId | undefined;
  let isStopped = heartbeat === Infinity;

  const stop = (): void => {
    isStopped = true;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  // * silent since what was heard last, or since its ping: due at `heartbeat` past it, or rearmed
  // for what is left of it
  const check = (): void => {
    const silent = now() - (pingedAt ?? lastHeard);

    if (isStopped) {
      return;
    }

    if (silent < heartbeat) {
      return (arm(heartbeat - silent), undefined);
    }

    if (pingedAt === undefined) {
      pingedAt = now();
      ping();
      arm(heartbeat);

      return undefined;
    }

    stop();
    drop();
  };
  const arm = (delay: number): void => {
    if (isStopped) {
      return;
    }

    // ! a millisecond at least, counted whole: no timer is armed for less (decision 0011)
    timer = clock.setTimeout(check, Math.max(1, Math.ceil(delay)));
    // a browser's timer has no `unref`
    (timer as { unref?: () => unknown }).unref?.();
  };

  if (!isStopped) {
    arm(heartbeat);
  }

  return {
    heard: () => {
      lastHeard = now();
      pingedAt = undefined;
    },
    stop,
  };
};
