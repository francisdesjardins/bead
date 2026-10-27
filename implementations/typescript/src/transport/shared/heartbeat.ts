// ── Heartbeat ─────────────────────────────────────────────────────────────────

// dependencies

import { assertHeld, PLATFORM_CLOCK, type TimeoutId } from './clock';

// interfaces

/** One connection's heartbeat: told of each answer, and stopped when the connection ends. */
export interface IHeartbeat {
  /** The peer answered a ping: the connection is alive. */
  answer(): void;
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
 * How often, in milliseconds, a connection is pinged by default. A connection that has not answered
 * one ping by the next is dropped, so a dead one goes within two of these.
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

/**
 * Pings a connection every `heartbeat` milliseconds, and drops it when the ping before went
 * unanswered; nothing at all for `Infinity`. It lives below the protocol: a WebSocket's own PING and
 * PONG frames (RFC 6455 §5.5.2), which a browser answers by itself. The timer keeps no process
 * alive: the connection does that.
 *
 * @example
 * const heartbeat = createHeartbeat(30_000, {
 *   drop: () => socket.terminate(),
 *   ping: () => socket.ping(),
 * });
 * socket.on('pong', () => heartbeat.answer());
 * socket.on('close', () => heartbeat.stop());
 */
export const createHeartbeat = (
  heartbeat: number,
  { drop, ping }: { drop: () => void; ping: () => void }
): IHeartbeat => {
  let isAnswered = true;

  // the platform's own timers, never a clock given: a ping plays in real time on every side, as the
  // platform under the other side's pings it (decision 0011)
  const stop = (): void => {
    // oxlint-disable-next-line no-restricted-properties -- a WebSocket's ping is the platform's
    globalThis.clearInterval(timer);
  };
  const beat = (): void => {
    if (!isAnswered) {
      stop();
      drop();

      return;
    }

    isAnswered = false;
    ping();
  };
  // oxlint-disable-next-line no-restricted-properties -- a WebSocket's ping is the platform's
  const timer = heartbeat === Infinity ? undefined : globalThis.setInterval(beat, heartbeat);

  // a browser's timer has no `unref`
  (timer as { unref?: () => unknown } | undefined)?.unref?.();

  return {
    answer: () => {
      isAnswered = true;
    },
    stop,
  };
};

/**
 * Pings a connection once nothing of it has come for `heartbeat` milliseconds, and drops it once
 * nothing has come by `heartbeat` after that ping; anything heard answers, as TCP sends a keep-alive
 * only when nothing came within its interval (RFC 9293 §3.8.4): a broker's connection, whose
 * parcels each tell it alive (spec 15.21). Nothing at all for `Infinity`. It runs on the platform's
 * timer, never a clock given, as the WebSocket's does (decision 0011), and keeps no process alive.
 *
 * @example
 * const heartbeat = createSilenceHeartbeat(30_000, {
 *   drop: () => connection.close(4001),
 *   ping: () => connection.ping(),
 * });
 * connection.onParcel(() => heartbeat.heard());
 */
export const createSilenceHeartbeat = (
  heartbeat: number,
  { drop, ping }: { drop: () => void; ping: () => void }
): ISilenceHeartbeat => {
  const now = (): number => {
    return PLATFORM_CLOCK.performance.now();
  };
  let lastHeard = now();
  let pingedAt: number | undefined;
  let timer: TimeoutId | undefined;
  let isStopped = heartbeat === Infinity;

  const stop = (): void => {
    isStopped = true;
    PLATFORM_CLOCK.clearTimeout(timer);
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
    timer = PLATFORM_CLOCK.setTimeout(check, Math.max(1, Math.ceil(delay)));
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
