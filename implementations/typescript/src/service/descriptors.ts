// ── Descriptors ───────────────────────────────────────────────────────────────

// A service's procedures as typed descriptors, one object each: its procedure, how it is called, who
// may call it, the failures it answers and its payloads' codecs. Generated code writes them; the
// service layer serves and calls them, and its types read each callback's from them.

// dependencies

import { ProcedureKind } from '../router/shared/constants';
import type { IPayloadCodec } from '../router/shared/payloads';
import type { ConnectionHandle, IAdmissionRequest, IProcedure } from '../router/shared/types';
import { ProgrammerError } from '../transport/shared/errors';

// interfaces

/**
 * A hook: whether a call may reach its resolver, on its header and its call's session, present or
 * not.
 */
export interface IAdmissionHook<Handle extends string = ConnectionHandle> {
  /**
   * Synchronous; only `true` admits. One that throws answers PROCEDURE_FAILED, and is reported.
   */
  readonly admits: (request: IAdmissionRequest<Handle>) => boolean;
  /** The detail of the ACCESS_DENIED a call it refuses is answered with; none says nothing. */
  readonly detail?: string | undefined;
}

/** What every descriptor holds. */
export interface IDescriptorInit {
  readonly admission: AdmissionRule;
  /** The names of its service's catalogue it answers, each with its code; none, `{}`. */
  readonly failures: Readonly<Record<string, number>>;
  readonly procedure: IProcedure;
  readonly request: IPayloadCodec<unknown, never>;
  readonly result: IPayloadCodec<unknown, never>;
  /**
   * What checks a request's value beyond its encoding, throwing on a violation: the side that
   * answers calls it once the request is decoded, before its resolver; a client, before it encodes
   * one, when its options say so. None validates nothing, and nothing gives one yet: its value is
   * the decoded request or the given one, and a violation's shape is the validator's to come.
   */
  readonly validate?: ((request: unknown) => void) | undefined;
}

/** A request's, `notification` given for a procedure that notifies. */
export interface IRequestInit extends IDescriptorInit {
  readonly notification?: IPayloadCodec<unknown, never> | undefined;
}

/** A descriptor of any kind, as the service layer takes one: its procedure's kind set. */
export interface IServiceDescriptor extends IRequestInit {
  readonly procedure: IProcedure & { readonly procedureKind: ProcedureKind };
}

// types

/**
 * Who may call a procedure: every call, a call with a session, or a hook the side that answers is
 * given by name.
 */
export type AdmissionRule<Hook extends string = string> =
  | 'none'
  | 'session'
  | { readonly hook: Hook };

/** A command's descriptor: its procedure's kind `command`, and never a notification. */
export type CommandDescriptor<Init extends IDescriptorInit = IDescriptorInit> = Init & {
  readonly notification?: undefined;
  readonly procedure: { readonly procedureKind: typeof ProcedureKind.COMMAND };
};

/** A request's descriptor: its procedure's kind `notifies` where a notification is given. */
export type RequestDescriptor<Init extends IRequestInit = IRequestInit> = Init & {
  readonly procedure: { readonly procedureKind: RequestKindOf<Init> };
};

/** A service's procedures, by name: what the service layer is made of. */
export type ServiceProcedures = Readonly<Record<string, IServiceDescriptor>>;

/** The kind a request's descriptor sets. */
type RequestKindOf<Init> = Init extends { readonly notification: IPayloadCodec<unknown, never> }
  ? typeof ProcedureKind.NOTIFIES
  : typeof ProcedureKind.REQUEST;

/** The kind a descriptor's procedure states. */
type ProcedureKindOf<Descriptor> = Descriptor extends {
  readonly procedure: { readonly procedureKind: infer Kind };
}
  ? Kind
  : never;

/** The names of a service's procedures whose kind is one of `Kind`. */
type NameOfKind<S extends ServiceProcedures, Kind extends ProcedureKind> = {
  [Name in keyof S]: [ProcedureKindOf<S[Name]>] extends [Kind] ? Name : never;
}[keyof S] &
  string;

/** The procedures a server answers and a client requests: its requests, never its commands. */
export type AnsweredName<S extends ServiceProcedures> = NameOfKind<
  S,
  typeof ProcedureKind.NOTIFIES | typeof ProcedureKind.REQUEST
>;

/** The procedures a server asks a client to run. */
export type CommandName<S extends ServiceProcedures> = NameOfKind<S, typeof ProcedureKind.COMMAND>;

/** The procedures that notify. */
export type NotifyingName<S extends ServiceProcedures> = NameOfKind<
  S,
  typeof ProcedureKind.NOTIFIES
>;

/** The hooks a service's procedures name. */
export type HookName<S extends ServiceProcedures> = {
  [Name in keyof S]: S[Name]['admission'] extends { readonly hook: infer Hook } ? Hook : never;
}[keyof S] &
  string;

/** The names a descriptor's procedure answers of its catalogue. */
export type FailureNameOf<Descriptor extends IDescriptorInit> = keyof Descriptor['failures'] &
  string;

/** What a codec's writer takes. */
export type GivenOf<Codec> = Codec extends IPayloadCodec<unknown, infer Given> ? Given : never;

/** What a codec's reader gives. */
export type ValueOf<Codec> = Codec extends IPayloadCodec<infer Value, never> ? Value : never;

// helpers

/** Whether `codec` reads and writes: its two members, functions. */
const isCodec = (codec: unknown): boolean => {
  const { decode, encode } = (typeof codec === 'object' && codec !== null ? codec : {}) as Partial<
    Record<'decode' | 'encode', unknown>
  >;

  return typeof decode === 'function' && typeof encode === 'function';
};

/** Whether `admission` is a rule: `none`, `session`, or a hook by a name. */
const isAdmissionRule = (admission: unknown): boolean => {
  if (admission === 'none' || admission === 'session') {
    return true;
  }

  const hook: unknown = (admission as { hook?: unknown } | null | undefined)?.hook;

  return typeof hook === 'string' && hook !== '';
};

/**
 * `init`, frozen, its procedure's kind set to `procedureKind`: a procedure that states another, a
 * codec missing, a rule no rule, or a `validate` that is no function, is a {@link ProgrammerError}.
 */
const describe = <Init extends IRequestInit>(init: Init, procedureKind: ProcedureKind): Init => {
  const { admission, procedure, validate } = init;

  // a caller without types may give anything
  if (typeof procedure !== 'object' || (procedure as IProcedure | null) === null) {
    throw new ProgrammerError('a descriptor holds its procedure');
  }

  const name = procedure.procedureName;
  const stated = procedure.procedureKind;
  const members =
    procedureKind === ProcedureKind.NOTIFIES
      ? (['request', 'result', 'notification'] as const)
      : (['request', 'result'] as const);

  if (stated !== undefined && stated !== procedureKind) {
    throw new ProgrammerError(`${name} is of kind ${stated}, not ${procedureKind}`);
  }

  for (const member of members) {
    if (!isCodec(init[member])) {
      throw new ProgrammerError(`${name} has no ${member} codec, decode and encode`);
    }
  }

  if (procedureKind === ProcedureKind.COMMAND && init.notification !== undefined) {
    throw new ProgrammerError(`${name} is a command, and a command never notifies`);
  }

  if (!isAdmissionRule(admission)) {
    throw new ProgrammerError(`${name}'s admission is none, session or a hook by name`);
  }

  if (validate !== undefined && typeof validate !== 'function') {
    throw new ProgrammerError(`${name}'s validate is a function`);
  }

  return Object.freeze({ ...init, procedure: Object.freeze({ ...procedure, procedureKind }) });
};

// definition

/**
 * A request's descriptor, frozen, its procedure's kind set: `notifies` when `notification` is
 * given, `request` otherwise. A procedure that states another kind, or a codec missing, is a
 * {@link ProgrammerError}. A descriptor declares nothing: its identity and its kind are checked as
 * the service layer declares it (spec 16.10).
 *
 * @example
 * import { PAYLOAD_CODECS, requestOf } from '@francisdesjardins/bead/service';
 *
 * const sayHello = requestOf({
 *   admission: 'none',
 *   failures: { NOBODY_TO_GREET: 1 },
 *   procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 1, serviceRevision: 1 },
 *   request: PAYLOAD_CODECS.text,
 *   result: PAYLOAD_CODECS.text,
 * });
 */
export const requestOf = <const Init extends IRequestInit>(init: Init): RequestDescriptor<Init> => {
  const procedureKind =
    (init as IRequestInit).notification === undefined
      ? ProcedureKind.REQUEST
      : ProcedureKind.NOTIFIES;

  return describe(init, procedureKind) as RequestDescriptor<Init>;
};

/**
 * A command's descriptor, frozen, its procedure's kind set to `command`: a procedure that states
 * another kind, a codec missing, or a notification given, is a {@link ProgrammerError}.
 *
 * @example
 * import { commandOf, PAYLOAD_CODECS } from '@francisdesjardins/bead/service';
 *
 * const clock = commandOf({
 *   admission: 'none',
 *   failures: {},
 *   procedure: { procedureId: 9, procedureName: 'clock', serviceId: 1, serviceRevision: 1 },
 *   request: PAYLOAD_CODECS.json,
 *   result: PAYLOAD_CODECS.json,
 * });
 */
export const commandOf = <const Init extends IDescriptorInit>(
  init: Init
): CommandDescriptor<Init> => {
  return describe(init, ProcedureKind.COMMAND) as CommandDescriptor<Init>;
};
