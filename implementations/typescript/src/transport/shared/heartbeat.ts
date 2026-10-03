// ── Heartbeat ─────────────────────────────────────────────────────────────────

// dependencies

import { assertHeld } from './clock';

// interfaces

/** One connection's heartbeat: told of each answer, and stopped when the connection ends. */
export interface IHeartbeat {
  /** The peer answered a ping: the connection is alive. */
  answer(): void;
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
 * Throws a {@link ProgrammerError} unless `heartbeat` is a whole number of milliseconds from 1 to
 * 2³¹ − 1, or `Infinity` for none.
 */
export const assertHeartbeat = (heartbeat: number): void => {
  assertHeld('a heartbeat', heartbeat);
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
