// ── Router writer ─────────────────────────────────────────────────────────────

// dependencies

import { toError } from '../../transport/shared/errors';
import type { IGauges } from '../../transport/shared/types';
import { createAnnouncements } from './announcements';
import { EnvelopeKind } from './constants';
import { writeEnvelope } from './envelope';
import { DisconnectError, FailureError, redactHeader } from './errors';
import type { IPayloadPlacement } from './payload-placement';
import type { IRouterCorePort, IRouterLimits, OutgoingEnvelope } from './types';

// interfaces

/**
 * What goes to the transport: an envelope delivered, within the limits of its payload and of its
 * envelope, traced, with the session its answer announces; and the announcements of each connection.
 */
export interface IRouterWriter<Handle extends string> {
  /**
   * Sends an envelope, with the credential its transport carries beside it, when it carries one;
   * `onHandOff` runs once the transport has it, before it settles.
   */
  deliver: (
    outgoing: OutgoingEnvelope,
    options: {
      connectionHandle: Handle;
      credential?: string | undefined;
      onHandOff?: (() => void) | undefined;
    }
  ) => Promise<void>;
  /** Forgets what one connection was told of its session, or what every one was. */
  forget: (connectionHandle?: Handle) => void;
  /** The announcements' gauges. */
  gauges: () => IGauges<Handle>;
  /** Sends an envelope no call waits on: what keeps it from going out is reported. */
  sendReporting: (envelope: OutgoingEnvelope, connectionHandle: Handle) => void;
}

// constants

export const DISPOSED = 'the router was disposed';

// what a failure's envelope holds besides its detail: its prefix, an announcement, and its record
const FAILURE_OVERHEAD_BYTES = 32;

// definition

/**
 * The writer of one router core: what it sends goes through it, checked against its `limits`,
 * announced, traced and handed to its `port`'s transport; once its router is disposed, nothing goes.
 */
export const createRouterWriter = <Handle extends string>(
  port: Pick<
    IRouterCorePort<Handle>,
    'failures' | 'send' | 'sessionTokenOf' | 'isTracing' | 'trace' | 'report'
  >,
  {
    isDisposed,
    limits,
    tooLargeOf,
  }: {
    isDisposed: () => boolean;
    limits: IRouterLimits;
    tooLargeOf: IPayloadPlacement['tooLargeOf'];
  }
): IRouterWriter<Handle> => {
  const { failures } = port;
  const announcements = createAnnouncements(port);

  // a failure's detail fits in an envelope, whatever the limit of a detail says
  const detailBytes = Math.min(
    limits.maximumDetailBytes,
    limits.maximumEnvelopeBytes - FAILURE_OVERHEAD_BYTES
  );

  // sends an envelope, with the credential its transport carries beside it, when it carries one;
  // `onHandOff` runs once the transport has it, before it settles
  const deliver = async (
    outgoing: OutgoingEnvelope,
    {
      connectionHandle,
      credential,
      onHandOff,
    }: {
      connectionHandle: Handle;
      credential?: string | undefined;
      onHandOff?: (() => void) | undefined;
    }
  ): Promise<void> => {
    // a disposed router is done with its transport: nothing more goes out on it
    if (isDisposed()) {
      throw new DisconnectError(DISPOSED);
    }

    // a failure, a credit and a cancel carry no payload of their own
    if (
      outgoing.kind !== EnvelopeKind.CANCEL &&
      outgoing.kind !== EnvelopeKind.CREDIT &&
      outgoing.kind !== EnvelopeKind.FAILURE &&
      outgoing.payload.length > limits.maximumPayloadBytes
    ) {
      throw new FailureError(tooLargeOf(outgoing.payload.length, limits.maximumPayloadBytes), {
        header: outgoing.header,
      });
    }

    const { envelope, restore } = announcements.announce(outgoing, connectionHandle);
    let sending: Promise<unknown>;

    try {
      const bytes = writeEnvelope(envelope, detailBytes);

      // one past its limit, the peer would refuse: a notification too large for one envelope, say
      if (bytes.length > limits.maximumEnvelopeBytes) {
        throw new FailureError(
          {
            ...failures.payloadTooLarge,
            detail: `an envelope is ${String(limits.maximumEnvelopeBytes)} bytes at most, not ${String(bytes.length)}`,
          },
          { header: outgoing.header }
        );
      }

      // * one check an envelope while nobody listens: no redacted header is built
      if (port.isTracing()) {
        port.trace('tx', { connectionHandle, header: redactHeader(envelope.header) });
      }

      sending = port.send(
        credential === undefined ? { data: bytes } : { credential, data: bytes },
        connectionHandle
      );
    } catch (reason) {
      restore();

      throw reason;
    }

    onHandOff?.();

    try {
      await sending;
    } catch (reason) {
      restore();

      throw reason;
    }
  };

  // sends an envelope no call waits on: what keeps it from going out is reported
  const sendReporting = (envelope: OutgoingEnvelope, connectionHandle: Handle): void => {
    deliver(envelope, { connectionHandle }).catch((reason: unknown) => {
      port.report(toError(reason), connectionHandle);
    });
  };

  return {
    deliver,
    forget: (connectionHandle?: Handle) => {
      announcements.forget(connectionHandle);
    },
    gauges: () => {
      return announcements.gauges();
    },
    sendReporting,
  };
};
