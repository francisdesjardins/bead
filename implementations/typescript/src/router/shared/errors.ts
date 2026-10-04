// dependencies

import { GenericError } from '../../transport/shared/errors';
import { FailureScope, ProtocolCode } from './constants';
import type {
  Credential,
  DestinationId,
  EnvelopeHeader,
  FailureOrigin,
  IFailure,
  IFailureHeader,
  IProcedureAddress,
  IReceivedFailure,
  IRouterFailures,
  RedactedHeader,
  RouterSide,
} from './types';

// interfaces

/** Where a failure belongs, besides what it says: the call it failed and the envelope that said it. */
interface IFailureErrorOptions extends ErrorOptions {
  destinationId?: DestinationId | undefined;
  /** Kept redacted: a copy, without its credential. */
  header?: EnvelopeHeader | undefined;
  procedureAddress?: IProcedureAddress | undefined;
}

// constants

// each protocol code's name, for a message
const CODE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(ProtocolCode).map(([name, code]) => {
    return [code, name];
  })
);

// helpers

/** What a failure says of itself, as its error's message. */
const messageOf = ({
  code,
  detail,
  origin,
  procedureAddress,
  relays,
  scope,
  side,
}: {
  code: number;
  detail: string;
  origin: FailureOrigin;
  procedureAddress: IProcedureAddress | undefined;
  relays: number;
  scope: FailureScope;
  side: RouterSide | undefined;
}): string => {
  const isProtocol = scope === FailureScope.PROTOCOL;
  const name = isProtocol ? CODE_NAMES.get(code) : undefined;

  return [
    origin === 'local' ? 'local ' : '',
    `${side ?? 'unknown side'} ${isProtocol ? 'protocol' : 'application'} failure ${String(code)}`,
    name === undefined ? '' : ` ${name}`,
    isProtocol || procedureAddress === undefined
      ? ''
      : ` (service ${String(procedureAddress.serviceId)}, procedure ${String(procedureAddress.procedureId)})`,
    relays > 0 ? `, through ${String(relays)} ${relays === 1 ? 'relay' : 'relays'}` : '',
    detail === '' ? '' : `: ${detail}`,
  ].join('');
};

/**
 * `header` fit to be traced or thrown: a copy without its credential, saying its scheme alone when it
 * had one.
 */
export const redactHeader = (header: EnvelopeHeader): RedactedHeader => {
  const { credential, ...rest } = header as EnvelopeHeader & { credential?: Credential };

  return {
    ...rest,
    ...(credential === undefined ? {} : { credentialScheme: credential.scheme }),
  };
};

// definition

/**
 * A call a bound of the side's own refuses as its credential resolves (spec 8.2): its router answers
 * it `CAPACITY_EXCEEDED`, its message for detail, and reports nothing, since nothing failed and its
 * requester withdraws nothing. Only the side's own resolver raises it: a key set's bound on the calls
 * that wait for an issuer's keys (spec 13.8).
 */
export class CapacityError extends GenericError {
  public override readonly name: string = 'CapacityError';
}

/** A request whose connection closed before its answer came. */
export class DisconnectError extends GenericError {
  public override readonly name: string = 'DisconnectError';
}

/**
 * A failure, thrown: whose code it is, the code, why, and — deduced, never sent — which side raised
 * it and where. Raised here, it is `local`, of this router's side; received through no relay, it is
 * the peer's; received through a relay, whose side raised it is not known.
 */
export class FailureError extends GenericError {
  public override readonly name: string = 'FailureError';

  public readonly code: number;
  /** What the call went to behind the peer, as the call named it: no answer names one. */
  public readonly destinationId: DestinationId | undefined;
  public readonly detail: string;
  /** The envelope that said it, redacted; none for a failure raised before any envelope. */
  public readonly header: RedactedHeader | undefined;
  public readonly origin: FailureOrigin;
  /** The procedure the call asked for, which a failure envelope does not repeat. */
  public readonly procedureAddress: IProcedureAddress | undefined;
  /** The relays it crossed: 0 when the peer raised it. */
  public readonly relays: number;
  public readonly scope: FailureScope;
  public readonly side: RouterSide | undefined;

  public constructor(
    failure: IFailure & {
      origin?: FailureOrigin | undefined;
      relays?: number | undefined;
      side?: RouterSide | undefined;
    },
    options?: IFailureErrorOptions
  ) {
    const { code, detail = '', origin = 'local', relays = 0, scope, side } = failure;
    const { destinationId, header, procedureAddress, ...errorOptions } = options ?? {};
    const address =
      procedureAddress === undefined
        ? undefined
        : { procedureId: procedureAddress.procedureId, serviceId: procedureAddress.serviceId };

    super(
      messageOf({ code, detail, origin, procedureAddress: address, relays, scope, side }),
      errorOptions
    );

    this.code = code;
    this.destinationId = destinationId;
    this.detail = detail;
    this.header = header === undefined ? undefined : redactHeader(header);
    this.origin = origin;
    this.procedureAddress = address;
    this.relays = relays;
    this.scope = scope;
    this.side = side;
  }

  /** Whether this is the procedure's own failure — one of `codes`, when given. */
  public isApplication(codes?: number | readonly number[]): boolean {
    return (
      this.scope === FailureScope.APPLICATION &&
      (codes === undefined || (typeof codes === 'number' ? [codes] : codes).includes(this.code))
    );
  }

  /**
   * Whether this is one of the protocol's `codes` — raised by the peer, here, or behind a relay —
   * and by `side`, when given. A failure through a relay has no side known, so it never passes
   * with one: its scope, which travels, is what tells the protocol's codes from a procedure's.
   */
  public isProtocol(codes: ProtocolCode | readonly ProtocolCode[], side?: RouterSide): boolean {
    return (
      this.scope === FailureScope.PROTOCOL &&
      (typeof codes === 'number' ? [codes] : codes).includes(this.code as ProtocolCode) &&
      (side === undefined || side === this.side)
    );
  }
}

/**
 * The error a failure received from the peer of a router with `failures` stands for: through no
 * relay, the peer's, of the other side; through a relay, of no known side. Where it came from is
 * where the call went.
 */
export const failureErrorOf = (
  received: IReceivedFailure,
  {
    destinationId,
    failures,
    header,
    procedureAddress,
  }: {
    destinationId?: DestinationId | undefined;
    failures: Pick<IRouterFailures, 'side'>;
    header: IFailureHeader;
    procedureAddress?: IProcedureAddress | undefined;
  }
): FailureError => {
  const isRelayed = received.relays > 0;

  return new FailureError(
    {
      ...received,
      origin: isRelayed ? 'relayed' : 'peer',
      side: isRelayed ? undefined : failures.side === 'client' ? 'server' : 'client',
    },
    { destinationId, header, procedureAddress }
  );
};
