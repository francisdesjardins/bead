// ── Intake ────────────────────────────────────────────────────────────────────

// dependencies

import { laterTask } from '../../transport/shared/later-task';
import type { Data } from '../../transport/shared/types';
import type { IIntakeLimits } from './types';

// interfaces

/** What an intake pauses and resumes: its router's transport, by connection. */
export interface IIntakePort<Handle extends string> {
  pause(connectionHandle: Handle): void;
  resume(connectionHandle: Handle): void;
}

/**
 * What one router's transport handed it that no turn took yet, per connection, and the connections
 * it paused for it (spec 15.12, decision 0046).
 */
export interface IIntake<Handle extends string> {
  /** The connections it holds paused, in the order each was first counted. */
  readonly paused: Handle[];

  /**
   * An envelope of `data` its transport handed on `connectionHandle`: counted, and the connection
   * paused once either count reaches its bound, the envelope that reached it taken all the same.
   * Nothing once it ended.
   */
  handed(connectionHandle: Handle, data: Data): void;
  /**
   * Ends, its router disposed: each connection it paused resumed, in the order each was first
   * counted, and nothing counted from now on, so no pause comes after.
   */
  end(): void;
}

// helpers

// the bytes of what a transport handed: an envelope's, or a text frame's characters
const sizeOf = (data: Data): number => {
  if (typeof data === 'string') {
    return data.length;
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }

  return data.size;
};

// definition

/**
 * The intake of a router that takes each envelope within the task that hands it: what a connection
 * handed within one task is counted, the envelope that reaches a bound taken and its connection
 * paused, and every count released in the next task, by {@link laterTask}, which resumes each
 * connection paused, whatever a turn threw. So the count is what a connection hands within one
 * task, and released no sooner than the side could take another connection's (spec 15.12).
 */
export const createIntake = <Handle extends string>(
  port: IIntakePort<Handle>,
  limits: IIntakeLimits
): IIntake<Handle> => {
  const { maximumUntakenBytes, maximumUntakenEnvelopes } = limits;
  // by connection, in the order each was first counted within the task
  const untaken = new Map<Handle, { bytes: number; envelopes: number; isPaused: boolean }>();
  let cancelRelease: (() => void) | undefined;
  let isEnded = false;

  // * the next task's: every count cleared, each connection paused resumed, its turns taken
  const release = (): void => {
    cancelRelease = undefined;

    const paused = [...untaken].flatMap(([connectionHandle, { isPaused }]) => {
      return isPaused ? [connectionHandle] : [];
    });

    untaken.clear();

    for (const connectionHandle of paused) {
      port.resume(connectionHandle);
    }
  };

  return {
    get paused() {
      return [...untaken].flatMap(([connectionHandle, { isPaused }]) => {
        return isPaused ? [connectionHandle] : [];
      });
    },

    handed: (connectionHandle, data) => {
      if (isEnded) {
        return;
      }

      const counted = untaken.get(connectionHandle) ?? { bytes: 0, envelopes: 0, isPaused: false };

      counted.bytes += sizeOf(data);
      counted.envelopes += 1;
      untaken.set(connectionHandle, counted);
      cancelRelease ??= laterTask(release);

      const isReached =
        counted.envelopes >= maximumUntakenEnvelopes || counted.bytes >= maximumUntakenBytes;

      if (isReached && !counted.isPaused) {
        counted.isPaused = true;
        port.pause(connectionHandle);
      }
    },
    end: () => {
      if (isEnded) {
        return;
      }

      isEnded = true;
      cancelRelease?.();
      release();
    },
  };
};
