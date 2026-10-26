// ── Relay ─────────────────────────────────────────────────────────────────────

// dependencies

import type { TransportServerConnectionHandle } from '../../transport/server/types';
import { assertHeld } from '../../transport/shared/clock';
import { ProgrammerError, toError } from '../../transport/shared/errors';
import { gaugesOf } from '../../transport/shared/gauges';
import { noop } from '../../transport/shared/noop';
import type { IGauges } from '../../transport/shared/types';
import { admissionOf, isAdmissionFailure, refusedBy } from '../shared/admission';
import { CredentialScheme, EnvelopeKind, FailureScope, ProtocolCode } from '../shared/constants';
import { FailureError } from '../shared/errors';
import { headerBytesOf } from '../shared/header';
import { drawDestinationId } from '../shared/identifiers';
import { audiencesOf, readJwt } from '../shared/jwt-verifier';
import type {
  AdmissionFailure,
  Credential,
  DestinationId,
  IAdmissionRequest,
  IDestinationHandler,
  IFailure,
  IProcedure,
  IRequestHeader,
  IRequestResolverProps,
  IRouterFailures,
  IRouterLimits,
  ITransportCarried,
  RequestCredential,
  RouterAnswer,
} from '../shared/types';
import type {
  IConnectionTarget,
  IDestination,
  IDestinationOptions,
  IDestinationRegistration,
  IRelayOptions,
  IRouterServer,
  RelayTarget,
} from './types';

// interfaces

/**
 * A destination registered: its target, the audience it verifies, how long leg B waits, whether its
 * connection closed, and the registration its application holds.
 */
interface IRegistration {
  /** The audience a `JWT` names for it (RFC 8707); none takes no `JWT` and no `ELSEWHERE`. */
  audience: string | undefined;
  destinationId: DestinationId;
  /** What the application holds of it, which a registration that `replaces` it names. */
  handed: IDestinationRegistration | undefined;
  /**
   * For a connection of the relay's own: set once it closed, or as it is registered on one its
   * router no longer holds; never unset, since no connection takes its handle again.
   */
  isClosed: boolean;
  label: string | undefined;
  target: RelayTarget;
  timeout: number;
}

/** What a leg B's transport carries beside a request: which credential, and whether in the clear. */
interface ICarriage {
  carries(credential: string): boolean;
  isSecure: boolean;
}

/** What a server router relays by: its destinations, and the handler of each request to one. */
export interface IRelay {
  /**
   * The audiences its destinations were registered with, each once: those a `JWT` is verified
   * against by a relay that verifies.
   */
  audiences(): string[];
  /**
   * Marks the destinations on a connection of the relay's own that closed: each is unreachable
   * until the application registers it anew, on another connection, since no connection takes its
   * handle again.
   */
  closeConnection(connectionHandle: TransportServerConnectionHandle): void;
  /** The destinations registered, each as its registration names it, and whether its connection closed. */
  destinations(): IDestination[];
  /**
   * Its destinations, counted, those whose connection closed among them: kept until the application
   * unregisters them, so none counts for a connection.
   */
  gauges(): IGauges<TransportServerConnectionHandle>;
  /**
   * The handler of a request to `destinationId`, bound to the destination as it is now, handed what
   * the request came with; `undefined` while none is registered at all: this router relays nothing.
   */
  handlerOf(
    destinationId: DestinationId
  ): IDestinationHandler<TransportServerConnectionHandle> | undefined;
  register(target: RelayTarget, options?: IDestinationOptions): IDestinationRegistration;
}

// types

type Handle = TransportServerConnectionHandle;

/** A request as a destination's handler admits it: with what it came with. */
type CarriedAdmission = IAdmissionRequest<Handle> & ITransportCarried;

/** A request as a destination's handler is handed it: with what it came with. */
type CarriedRequest = IRequestResolverProps<Handle> & ITransportCarried;

// helpers

const isConnectionTarget = (target: RelayTarget): target is IConnectionTarget => {
  return 'connectionHandle' in target;
};

// what a transport that says nothing carries: no credential
const carriesNone = (): boolean => {
  return false;
};

/**
 * What leg B presents of what leg A does (spec 14.2): a `JWT`, its same bytes; an `ELSEWHERE`, its
 * scheme, its credential beside it; none for none or `OPAQUE`, which run in leg B's session.
 */
const forwardedOf = (credential: Credential | undefined): Credential | undefined => {
  return credential?.scheme === CredentialScheme.JWT ||
    credential?.scheme === CredentialScheme.ELSEWHERE
    ? credential
    : undefined;
};

/**
 * A request's header on leg B, counted with its credential, call by call (spec 14.3, step 6): no
 * destination, and the credential leg A presents, when leg B presents it.
 */
const legHeaderBytesOf = (credential: Credential | undefined): number => {
  const forwarded = forwardedOf(credential);

  return headerBytesOf({
    callId: 1,
    kind: EnvelopeKind.REQUEST,
    procedureId: 1,
    serviceId: 1,
    ...(forwarded === undefined ? {} : { credential: forwarded }),
  });
};

// the relay's timeout, or a destination's, held: never 0, and `Infinity` without end
const heldTimeoutOf = (timeout: number): number => {
  return assertHeld("a relay's timeout", timeout);
};

// definition

/**
 * The relay of a server router: the requests that name a destination registered in it go on to
 * that destination's target, and their answers come back, as the router's own. The relay
 * terminates each leg — leg A, from the requester, and leg B, to the target, each with its own call
 * id, limits and session — and passes on the payload's bytes, undecoded, and the answer: a failure
 * of the target's counted one relay more; one of its own with none.
 *
 * A request is asked `beforeRoute` on its header first, its credential resolved before — a `JWT`,
 * and an `ELSEWHERE` its transport carried, forwarded unresolved unless the relay `verifies` them —
 * then its destination is looked up, then its credential is held to what leg B carries, then it is
 * held to the smaller of the two legs' limits, leg B's header counted with its credential: every
 * refusal falls on the opening, before any of its payload crosses, and a requester presenting none
 * or `OPAQUE`, not admitted, learns only whether any destination is registered. Leg B presents what
 * leg A does (spec 14.2): none for none or `OPAQUE`, a `JWT`'s same bytes, an `ELSEWHERE` with what
 * leg A's transport carried. When leg B fails, leg A hears how far the request went: `DESTINATION_UNREACHABLE`
 * while the relay's transport never had it, or refused it, so nothing was tried, and
 * `DESTINATION_LOST` once it was handed to that transport, the procedure run or not. What leg B
 * failed with is reported, not passed on: leg A hears no address behind the relay. A cancel on
 * leg A — or its connection gone — cancels leg B.
 */
export const createRelay = ({
  carriageOf,
  failures,
  fill,
  isOpen,
  isTwoWay,
  limits,
  options,
  report,
  request,
  respond,
}: {
  /**
   * What a connection of the relay's own carries beside a request of the relay's: a credential, and
   * whether off the machine in the clear; neither, without it.
   */
  carriageOf?: ((connectionHandle: Handle) => ICarriage) | undefined;
  failures: IRouterFailures;
  /** What fills the bytes a destination is drawn from: the system's random source, without it. */
  fill?: ((bytes: Uint8Array<ArrayBuffer>) => unknown) | undefined;
  /**
   * Whether the relay's router holds a connection of its own, open: a destination registered on
   * one it does not is closed from its registration. Every one, without it.
   */
  isOpen?: ((connectionHandle: Handle) => boolean) | undefined;
  /** Whether a connection of the relay's own takes a request of the relay's: HTTP's does not. */
  isTwoWay?: ((connectionHandle: Handle) => boolean) | undefined;
  /** The relay router's own. */
  limits: IRouterLimits;
  options: IRelayOptions | undefined;
  /** What hears why leg B failed, with leg A's connection. */
  report: (error: Error, connectionHandle: Handle) => void;
  /** The relay router's own request, to a connection of its own. */
  request: IRouterServer['request'];
  /** The relay router's own answer, to a request it was handed. */
  respond: (
    answer: RouterAnswer,
    target: { connectionHandle: Handle; header: IRequestHeader }
  ) => Promise<void>;
}): IRelay => {
  const { beforeRoute, timeout: givenTimeout = Infinity, verifies = false } = options ?? {};
  const registrations = new Map<DestinationId, IRegistration>();

  if (beforeRoute?.refusal !== undefined && !isAdmissionFailure(beforeRoute.refusal, failures)) {
    throw new ProgrammerError(
      `a relay refuses with a failure that is not an admission's of the ${failures.side}'s table`
    );
  }

  const relayTimeout = heldTimeoutOf(givenTimeout);

  // without a `beforeRoute`, the relay admits nobody: it is a door to what is behind it, which an
  // access refused tells by its name
  const admission =
    beforeRoute === undefined
      ? ({ header }: CarriedAdmission): AdmissionFailure => {
          refusedBy(header, 'no-before-route');

          return {
            ...failures.accessDenied,
            detail: 'this relay admits nobody: it has no beforeRoute',
          };
        }
      : admissionOf(beforeRoute, failures);

  // the largest payload a target takes, and answers: its router's limit, or what one of its
  // envelopes holds behind leg B's header, with the credential it presents, when it takes no
  // transfer; the relay's own where that one is smaller
  const payloadLimitOf = (target: RelayTarget, credential?: Credential): number => {
    const { chunkBytes, maximumEnvelopeBytes, maximumPayloadBytes, maximumTransfers } =
      isConnectionTarget(target) ? limits : target.limits;
    const limit =
      maximumTransfers === 0
        ? Math.min(
            maximumPayloadBytes,
            Math.min(chunkBytes, maximumEnvelopeBytes) - legHeaderBytesOf(credential)
          )
        : maximumPayloadBytes;

    return Math.min(limit, limits.maximumPayloadBytes);
  };

  const unreachableOf = (destinationId: DestinationId, why: string): IFailure => {
    return {
      ...failures.destinationUnreachable,
      detail: `destination ${String(destinationId)} is unreachable: ${why}`,
    };
  };

  // what leg B's transport carries: a connection's, as the relay's transport says; a router's, as
  // the transport it calls through says
  const carriageOfTarget = (target: RelayTarget): ICarriage => {
    if (isConnectionTarget(target)) {
      return carriageOf?.(target.connectionHandle) ?? { carries: carriesNone, isSecure: false };
    }

    const { transport } = target;

    return {
      carries: (credential) => {
        return transport?.carries?.(credential) === true;
      },
      isSecure: transport?.isSecure === true,
    };
  };

  // a call leg B cannot carry, its credential holding or not, as section 14.3's step 5 lists them:
  // ! an ELSEWHERE goes only where leg B carries the very bytes leg A's transport carried — never
  // over a WebSocket whose upgrade carried the relay's own, which it would present for leg A's
  const uncarriedOf = (
    { header: { credential }, transportCredential }: CarriedAdmission,
    { audience, destinationId, target }: IRegistration
  ): IFailure | undefined => {
    if (credential?.scheme === CredentialScheme.JWT && 'token' in credential) {
      // read as a token's aud is read, verified or not: a token that does not read names none
      const claims = readJwt(credential.token)?.claims;

      if (audience === undefined || !audiencesOf(claims?.['aud']).includes(audience)) {
        return unreachableOf(
          destinationId,
          'it verifies another audience than the one the token names, or none'
        );
      }
    } else if (credential?.scheme === CredentialScheme.ELSEWHERE) {
      if (audience === undefined) {
        return unreachableOf(destinationId, 'it was registered with no audience');
      }

      if (
        transportCredential === undefined ||
        !carriageOfTarget(target).carries(transportCredential)
      ) {
        return unreachableOf(
          destinationId,
          'its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another'
        );
      }
    } else {
      return undefined;
    }

    return carriageOfTarget(target).isSecure
      ? undefined
      : unreachableOf(
          destinationId,
          'its transport leaves the machine in the clear, which a bearer credential never crosses'
        );
  };

  // what leg B presents: a JWT, as leg A does; an ELSEWHERE, with what leg A's transport carried;
  // none, said so, for none or OPAQUE, whatever a router it calls through presents by default
  const legCredentialOf = ({ header, transportCredential }: CarriedRequest): RequestCredential => {
    const { credential } = header;

    if (credential?.scheme === CredentialScheme.JWT && 'token' in credential) {
      return { scheme: CredentialScheme.JWT, token: credential.token };
    }

    return credential?.scheme === CredentialScheme.ELSEWHERE && transportCredential !== undefined
      ? { carried: transportCredential, scheme: CredentialScheme.ELSEWHERE }
      : { scheme: CredentialScheme.NONE };
  };

  // what leg A answers when leg B fails: the target's failure, one relay more; before the relay's
  // transport had the request, a limit of leg B's as the relay's own, or unreachable; lost after.
  // The relay's own name no address behind it: why leg B failed is reported instead
  const failureOf = (
    reason: unknown,
    {
      connectionHandle,
      destinationId,
      isSent,
    }: { connectionHandle: Handle; destinationId: DestinationId; isSent: boolean }
  ): IFailure => {
    if (reason instanceof FailureError && reason.origin !== 'local') {
      const { code, detail, relays, scope } = reason;

      return { code, detail, relays: Math.min(relays + 1, 0xff), scope };
    }

    if (!isSent && reason instanceof FailureError && reason.scope === FailureScope.PROTOCOL) {
      if (reason.code === ProtocolCode.PAYLOAD_TOO_LARGE) {
        const { code, detail, scope } = reason;

        return { code, detail, scope };
      }

      if (reason.code === ProtocolCode.CAPACITY_EXCEEDED) {
        return {
          ...failures.capacityExceeded,
          detail: `destination ${String(destinationId)} takes no more calls at once`,
        };
      }
    }

    report(toError(reason), connectionHandle);

    return isSent
      ? {
          ...failures.destinationLost,
          detail: `destination ${String(destinationId)} was lost once handed the request: the procedure may have run`,
        }
      : unreachableOf(destinationId, 'nothing was tried');
  };

  // leg B: the same service and procedure, the payload's bytes, leg A's signal; its answer, or
  // `undefined` once leg A ended
  const answerOf = async (
    { destinationId, target, timeout }: IRegistration,
    props: CarriedRequest
  ): Promise<RouterAnswer | undefined> => {
    const { connectionHandle, header, payload, signal } = props;
    const { procedureId, serviceId } = header;
    const credential = legCredentialOf(props);
    const procedure: IProcedure = {
      maximumPayloadBytes: payloadLimitOf(target, header.credential),
      procedureId,
      procedureName: `${String(serviceId)}/${String(procedureId)} to ${String(destinationId)}`,
      serviceId,
      serviceRevision: 0,
    };
    let isSent = false;

    try {
      const leg = {
        // true as the relay's transport is handed the request, false should it refuse it
        onSent: (isHanded: boolean) => {
          isSent = isHanded;
        },
        procedure,
      };
      const asked = { credential, signal, timeout };
      const { payload: result } = await (isConnectionTarget(target)
        ? request(payload, {
            ...leg,
            options: { ...asked, connectionHandle: target.connectionHandle },
          })
        : target.request(payload, { ...leg, options: asked }));

      return { payload: result };
    } catch (reason) {
      // leg A ended — cancelled, or gone with its connection: its answer would go nowhere, and leg
      // B was cancelled with it
      if (signal.aborted) {
        return undefined;
      }

      return { failure: failureOf(reason, { connectionHandle, destinationId, isSent }) };
    }
  };

  // a payload past what leg B takes behind its header, with the credential it presents
  const tooLargeOf = (
    length: number,
    { header, registration }: { header: IRequestHeader; registration: IRegistration }
  ): IFailure | undefined => {
    const limit = payloadLimitOf(registration.target, header.credential);

    return length > limit
      ? {
          ...failures.payloadTooLarge,
          detail: `a payload is ${String(limit)} bytes at most, not ${String(length)}`,
        }
      : undefined;
  };

  // leg B, then leg A's answer; a connection that closed while the payload came takes nothing, and
  // a payload that came whole past what leg B takes behind its header goes nowhere
  const forward = async (registration: IRegistration, props: CarriedRequest): Promise<void> => {
    const tooLarge = tooLargeOf(props.payload.length, { header: props.header, registration });
    const answer = registration.isClosed
      ? { failure: unreachableOf(registration.destinationId, 'its connection closed') }
      : tooLarge === undefined
        ? await answerOf(registration, props)
        : { failure: tooLarge };

    if (answer === undefined) {
      return;
    }

    try {
      await respond(answer, props);
    } catch (reason) {
      // ! an answer leg A cannot carry is answered PROCEDURE_FAILED, no detail, whatever refused it;
      // one it did not take goes nowhere again; why is reported (spec 9.0, 14.5)
      await respond({ failure: failures.procedureFailed }, props).catch(noop);

      throw reason;
    }
  };

  const register = (
    target: RelayTarget,
    options?: IDestinationOptions
  ): IDestinationRegistration => {
    const { audience, label, replaces } = options ?? {};
    const given = options?.destinationId ?? replaces?.destinationId;
    const timeout = heldTimeoutOf(options?.timeout ?? Infinity);

    if (audience !== undefined && (typeof audience !== 'string' || !audience.isWellFormed())) {
      throw new ProgrammerError('an audience is a string of well-formed Unicode');
    }

    if (given !== undefined && (!Number.isInteger(given) || given < 1 || given > 0xffffffff)) {
      throw new ProgrammerError(
        `a destination is an integer from 1 to 4294967295, not ${String(given)}`
      );
    }

    if (replaces !== undefined && replaces.destinationId !== given) {
      throw new ProgrammerError(
        `a registration replaces the one of its own destination, ${String(given)}, not ${String(replaces.destinationId)}`
      );
    }

    // ! the registration replaced is the one that holds its id now: a caller holding one taken out,
    // or replaced already, would take a destination it does not hold
    if (
      replaces !== undefined &&
      (given === undefined || registrations.get(given)?.handed !== replaces)
    ) {
      throw new ProgrammerError(
        `destination ${String(given)} is not registered by the registration it replaces`
      );
    }

    if (replaces === undefined && given !== undefined && registrations.has(given)) {
      throw new ProgrammerError(`destination ${String(given)} is registered already`);
    }

    const destinationId =
      given ??
      drawDestinationId((candidate) => {
        return registrations.has(candidate);
      }, fill);
    // the relay's timeout is the longest any leg B waits: a destination's own stays under it
    // a connection its router no longer holds closed before it was registered: it is unreachable
    // from now on, and nothing is forwarded to it (spec 14.4)
    const registration: IRegistration = {
      audience,
      destinationId,
      handed: undefined,
      isClosed: isConnectionTarget(target) && isOpen?.(target.connectionHandle) === false,
      label,
      target,
      timeout: Math.min(timeout, relayTimeout),
    };
    const handed: IDestinationRegistration = {
      destinationId,
      get isClosed() {
        return registration.isClosed;
      },
      label,
      // its own registration alone: one that took its id since stays
      unregister: () => {
        return (
          registrations.get(destinationId) === registration && registrations.delete(destinationId)
        );
      },
    };

    registration.handed = handed;
    // * one replaced gives its place at once: a request in between finds the destination, never
    // DESTINATION_UNKNOWN, and a call bound to the one replaced finishes with it
    registrations.set(destinationId, registration);

    return handed;
  };

  return {
    audiences: () => {
      return [
        ...new Set(
          registrations
            .values()
            .map(({ audience }) => {
              return audience;
            })
            .filter((audience) => {
              return audience !== undefined;
            })
        ),
      ];
    },
    closeConnection: (connectionHandle) => {
      for (const registration of registrations.values()) {
        if (
          isConnectionTarget(registration.target) &&
          registration.target.connectionHandle === connectionHandle
        ) {
          registration.isClosed = true;
        }
      }
    },
    destinations: () => {
      return [...registrations.values()].map(({ destinationId, isClosed, label }) => {
        return { destinationId, isClosed, label };
      });
    },
    gauges: () => {
      let closed = 0;

      for (const { isClosed } of registrations.values()) {
        closed += isClosed ? 1 : 0;
      }

      return gaugesOf({
        counts: { closedDestinations: closed, destinations: registrations.size },
      });
    },
    handlerOf: (destinationId) => {
      if (registrations.size === 0) {
        return undefined;
      }

      // bound now: a destination registered again later takes nothing of this call
      const registration = registrations.get(destinationId);

      // a router that asks no admission leaves it to the handler, as to a resolver
      if (registration === undefined) {
        const refusalOf = (admissionRequest: CarriedAdmission): IFailure => {
          return (
            admission(admissionRequest) ?? {
              ...failures.destinationUnknown,
              detail: `no destination ${String(destinationId)} behind this relay`,
            }
          );
        };

        return Object.assign(
          (props: CarriedRequest) => {
            return respond({ failure: refusalOf(props) }, props);
          },
          { admit: refusalOf, forwardsCredentials: !verifies }
        );
      }

      // what refuses an admitted request to this destination: nothing, for one that goes on
      const refusalOfRoute = (request: CarriedAdmission): IFailure | undefined => {
        const { header } = request;
        const { opensSubscription, total } = header;
        const { target } = registration;

        if (opensSubscription === true) {
          return {
            ...failures.subscriptionUnsupported,
            detail: 'this relay carries no subscription',
          };
        }

        if (registration.isClosed) {
          return unreachableOf(destinationId, 'its connection closed');
        }

        if (isConnectionTarget(target) && isTwoWay?.(target.connectionHandle) === false) {
          return unreachableOf(destinationId, 'its connection carries no request');
        }

        // a transfer's total is held before any credit; a payload that came whole, as it comes
        return (
          uncarriedOf(request, registration) ??
          (total === undefined ? undefined : tooLargeOf(total, { header, registration }))
        );
      };

      const admit = (admissionRequest: CarriedAdmission): IFailure | undefined => {
        return admission(admissionRequest) ?? refusalOfRoute(admissionRequest);
      };

      return Object.assign(
        (props: CarriedRequest) => {
          const refusal = props.isAdmitted === true ? undefined : admit(props);

          return refusal === undefined
            ? forward(registration, props)
            : respond({ failure: refusal }, props);
        },
        {
          admit,
          forwardsCredentials: !verifies,
          maximumPayloadBytes: payloadLimitOf(registration.target),
        }
      );
    },
    register,
  };
};
