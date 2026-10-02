// ── Announcements ─────────────────────────────────────────────────────────────

// dependencies

import { gaugesOf } from '../../transport/shared/gauges';
import type { IGauges } from '../../transport/shared/types';
import { EnvelopeKind } from './constants';
import type { IRouterCorePort, OutgoingEnvelope, SessionToken } from './types';

// interfaces

/** The session each connection was last told of, and what an answer announces of it. */
export interface IAnnouncements<Handle extends string> {
  /**
   * `envelope` as it goes out to `connectionHandle`: an answer carries the connection's session when
   * it changed since the last one announced, recorded as the answer is written, so answers that go
   * out together announce in the order they were written. `restore` undoes it, should the answer not
   * go out.
   */
  announce(
    envelope: OutgoingEnvelope,
    connectionHandle: Handle
  ): { envelope: OutgoingEnvelope; restore: () => void };
  /** Forgets what `connectionHandle` — every connection, when none is given — was told. */
  forget(connectionHandle?: Handle): void;
  /** The connections told of a session, counted. */
  gauges(): IGauges<Handle>;
}

// definition

/**
 * What the side's answers announced of each connection's session, as `port.sessionTokenOf` gives
 * it: a token, `null` once the connection was told its session ended, and nothing at all for a
 * connection never told, which a session that never began leaves untold.
 */
export const createAnnouncements = <Handle extends string>(
  port: Pick<IRouterCorePort<Handle>, 'sessionTokenOf'>
): IAnnouncements<Handle> => {
  const announced = new Map<Handle, SessionToken | null>();

  return {
    announce: (envelope, connectionHandle) => {
      const unchanged = {
        envelope,
        restore: () => {
          return undefined;
        },
      };

      if (
        port.sessionTokenOf === undefined ||
        (envelope.kind !== EnvelopeKind.RESULT && envelope.kind !== EnvelopeKind.FAILURE)
      ) {
        return unchanged;
      }

      const current = port.sessionTokenOf(connectionHandle) ?? null;
      const hadPrevious = announced.has(connectionHandle);
      const previous = announced.get(connectionHandle) ?? null;

      if (current === previous) {
        return unchanged;
      }

      announced.set(connectionHandle, current);

      const header = { ...envelope.header, sessionToken: current };

      return {
        envelope:
          envelope.kind === EnvelopeKind.RESULT
            ? { ...envelope, header: { ...header, kind: EnvelopeKind.RESULT } }
            : { ...envelope, header: { ...header, kind: EnvelopeKind.FAILURE } },
        // an answer that did not go out announced nothing: what it recorded is undone, unless
        // something since recorded over it or forgot the connection
        restore: () => {
          if (announced.get(connectionHandle) === current) {
            if (hadPrevious) {
              announced.set(connectionHandle, previous);
            } else {
              announced.delete(connectionHandle);
            }
          }
        },
      };
    },
    forget: (connectionHandle) => {
      if (connectionHandle === undefined) {
        announced.clear();
      } else {
        announced.delete(connectionHandle);
      }
    },
    gauges: () => {
      return gaugesOf({
        connectionHandles: announced.keys(),
        counts: { announced: announced.size },
      });
    },
  };
};
