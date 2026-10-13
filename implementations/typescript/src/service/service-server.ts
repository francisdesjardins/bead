// ── Service server ────────────────────────────────────────────────────────────

// The server side of one service: its resolvers registered by name, offered on one Bead server, its
// commands made and its notifications sent there. A generated server is a thin shell over it.

// dependencies

import type { IServer, IServerTransportLike } from '../server/types';
import { FailureScope, ProcedureKind } from '../router/shared/constants';
import type {
  AdmissionFailure,
  CallId,
  IBeforeRequest,
  INotificationResolver,
  INotificationResponse,
  INotifyOptions,
  IProcedure,
  IRequest,
  IRequestProps,
  IResponse,
  ResolverFailure,
} from '../router/shared/types';
import type { TransportServerConnectionHandle } from '../transport/server/types';
import { ProgrammerError } from '../transport/shared/errors';
import type {
  AnsweredName,
  CommandName,
  FailureNameOf,
  GivenOf,
  HookName,
  IAdmissionHook,
  IServiceDescriptor,
  NotifyingName,
  ServiceProcedures,
  ValueOf,
} from './descriptors';
import type { IListedFailure } from './failures';

// interfaces

/** The server side of a service, offered on one Bead server. */
export interface IServiceServer<S extends ServiceProcedures, Data = unknown> {
  /**
   * A requester of each command, made as the service is offered; one called before is a
   * {@link ProgrammerError}.
   */
  readonly command: {
    // ! keyof S, filtered: a computed key drops the link to the descriptor, and its
    // @deprecated with it
    readonly [Name in keyof S as Name extends CommandName<S> ? Name : never]: IRequest<
      GivenOf<S[Name]['request']>,
      ValueOf<S[Name]['result']>,
      TransportServerConnectionHandle
    >;
  };
  /**
   * Notifies each procedure's subscribers, as a resolver's `notify` does; before the service is
   * offered, or with no resolver registered, it sends nothing and resolves.
   */
  readonly notify: {
    // ! keyof S, filtered: a computed key drops the link to the descriptor, and its
    // @deprecated with it
    readonly [Name in keyof S as Name extends NotifyingName<S> ? Name : never]: (
      notification: GivenOf<NonNullable<S[Name]['notification']>>,
      options?: INotifyOptions<TransportServerConnectionHandle>
    ) => Promise<void>;
  };

  /**
   * Offers every resolver, now and later, on `server`, its commands made there; a second offer is a
   * {@link ProgrammerError}.
   */
  offer: (server: IServer<IServerTransportLike, Data>) => void;
  /**
   * Registers a procedure's resolver, before or after `offer`; twice for one procedure, or a name
   * the service does not answer, is a {@link ProgrammerError}.
   */
  on: <Name extends AnsweredName<S>>(
    name: Name,
    callback: ServiceResolverCallback<S[Name]>
  ) => void;
  /** The procedures a client calls that no `on` answers: the router answers them PROCEDURE_UNKNOWN. */
  proceduresWithoutResolver: () => readonly IProcedure[];
}

// types

/**
 * How a resolver of the service layer answers: a result, a failure its procedure lists, or a
 * refusal of admission — the runtime's response, narrowed; one that notifies may subscribe first.
 */
export type IServiceResponse<Descriptor extends IServiceDescriptor> = Descriptor extends {
  readonly procedure: { readonly procedureKind: typeof ProcedureKind.NOTIFIES };
}
  ? INotificationResponse<GivenOf<Descriptor['result']>, ServiceFailureOf<Descriptor>>
  : IResponse<GivenOf<Descriptor['result']>, ServiceFailureOf<Descriptor>>;

/** A resolver of the service layer: its request decoded, and its narrowed response. */
export type ServiceResolverCallback<
  Descriptor extends IServiceDescriptor,
  Handle extends string = TransportServerConnectionHandle,
> = (
  request: IRequestProps<ValueOf<Descriptor['request']>, Handle>,
  response: IServiceResponse<Descriptor>
) => Promise<void>;

/** Each procedure's resolver a server answers, by name, for resolvers written in a module apart. */
export type ServiceResolvers<S extends ServiceProcedures> = {
  // ! keyof S, filtered: a computed key drops the link to the descriptor, and its
  // @deprecated with it
  readonly [
    Name in keyof S as Name extends AnsweredName<S> ? Name : never
  ]: ServiceResolverCallback<S[Name]>;
};

/**
 * What a server side is given after its procedures: the hooks they name, by name, required when one
 * names any.
 */
export type ServiceServerOptions<S extends ServiceProcedures> = [HookName<S>] extends [never]
  ? [options?: { readonly admissions?: Readonly<Record<string, never>> | undefined }]
  : [
      options: {
        readonly admissions: Readonly<
          Record<HookName<S>, IAdmissionHook<TransportServerConnectionHandle>>
        >;
      },
    ];

/** What a resolver of `Descriptor` answers a failure with. */
type ServiceFailureOf<Descriptor extends IServiceDescriptor> =
  | AdmissionFailure
  | IListedFailure<FailureNameOf<Descriptor>>;

/** A server side's resolver registered, by its procedure's name. */
type AnyCallback = (
  request: IRequestProps<unknown, TransportServerConnectionHandle>,
  response: INotificationResponse<unknown, ResolverFailure>
) => Promise<void>;

// helpers

/**
 * The hooks `procedures` name, each checked against `admissions`: one named that is not given, one
 * given that none names, or one that is no hook, is a {@link ProgrammerError}.
 */
export const hooksOf = <Handle extends string>(
  procedures: ServiceProcedures,
  admissions: Readonly<Record<string, IAdmissionHook<Handle>>> | undefined
): ReadonlyMap<string, IAdmissionHook<Handle>> => {
  const given = new Map(Object.entries(admissions ?? {}));
  const named = new Set<string>();

  for (const { admission, procedure } of Object.values(procedures)) {
    if (typeof admission === 'object') {
      if (!given.has(admission.hook)) {
        throw new ProgrammerError(
          `${procedure.procedureName} is admitted by the hook ${admission.hook}, which the options do not give`
        );
      }

      named.add(admission.hook);
    }
  }

  for (const [name, hook] of given) {
    if (!named.has(name)) {
      throw new ProgrammerError(`the hook ${name} is given, and no procedure names it`);
    }

    if (typeof (hook as Partial<IAdmissionHook<Handle>> | undefined)?.admits !== 'function') {
      throw new ProgrammerError(`the hook ${name} admits by a function, admits`);
    }
  }

  return given;
};

/**
 * The `beforeRequest` `hook` makes, built once: only its `true` admits, and its refusal is
 * `accessDenied`, the router's own, with the hook's detail.
 */
export const beforeRequestOf = <Handle extends string>(
  hook: IAdmissionHook<Handle>,
  accessDenied: AdmissionFailure
): IBeforeRequest<Handle> => {
  const { admits, detail } = hook;

  return Object.assign(
    (request: Parameters<IBeforeRequest<Handle>>[0]) => {
      return admits(request);
    },
    { refusal: detail === undefined ? accessDenied : { ...accessDenied, detail } }
  );
};

/**
 * `response`, as a resolver of `descriptor` answers through it: an application failure whose code
 * its procedure does not list, which only a cast reaches, goes as written, and `report` hears of it.
 */
export const listedResponseOf = (
  response: INotificationResponse<unknown, ResolverFailure>,
  {
    descriptor,
    report,
  }: { descriptor: IServiceDescriptor; report: (error: ProgrammerError) => void }
): INotificationResponse<unknown, ResolverFailure> => {
  const listed = new Set(Object.values(descriptor.failures));
  const { procedureName } = descriptor.procedure;

  const answer = (result: unknown, failure?: ResolverFailure): Promise<void> => {
    if (failure === undefined) {
      return response(result);
    }

    if (failure.scope !== FailureScope.PROTOCOL && !listed.has(failure.code)) {
      report(
        new ProgrammerError(
          `${procedureName} answers failure ${String(failure.code)}, which it does not list`
        )
      );
    }

    return response(null, failure);
  };

  return Object.assign(answer as INotificationResponse<unknown, ResolverFailure>, {
    registerNotification: (): CallId => {
      return response.registerNotification();
    },
  });
};

/**
 * `request` as its descriptor's `validate` holds it, before its resolver: one that throws fails the
 * call as a resolver that throws does, PROCEDURE_FAILED, reported.
 */
export const validated = (
  descriptor: IServiceDescriptor,
  request: IRequestProps<unknown>
): void => {
  descriptor.validate?.(request.payload);
};

// definition

/**
 * The server side of a service, over its procedures' descriptors: `on` registers a resolver, before
 * or after `offer`; `offer` binds every resolver, now and later, to one Bead server, and makes each
 * command's requester there; `notify` notifies a procedure's subscribers. Each requester and
 * resolver is declared once, as it is made, and the router checks each against its kind (spec
 * 16.10). A hook a procedure names that the options lack, or one they give that no procedure names,
 * is a {@link ProgrammerError}. `Data` is the server's sessions'.
 *
 * @example
 * import {
 *   createServiceServer,
 *   failuresOf,
 *   PAYLOAD_CODECS,
 *   requestOf,
 * } from '@francisdesjardins/bead/service';
 *
 * const GreeterFailures = failuresOf({ codes: { NOBODY_TO_GREET: 1 }, serviceId: 1 });
 * const GreeterProcedures = Object.freeze({
 *   sayHello: requestOf({
 *     admission: 'none',
 *     failures: { NOBODY_TO_GREET: 1 },
 *     procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 1, serviceRevision: 1 },
 *     request: PAYLOAD_CODECS.text,
 *     result: PAYLOAD_CODECS.text,
 *   }),
 * });
 * const greeter = createServiceServer(GreeterProcedures);
 *
 * greeter.on('sayHello', (request, response) => {
 *   return request.payload === ''
 *     ? response(null, GreeterFailures.of('NOBODY_TO_GREET', 'a name is needed'))
 *     : response(`Hello, ${request.payload}!`);
 * });
 * greeter.offer(server);
 */
export const createServiceServer = <const S extends ServiceProcedures, Data = unknown>(
  procedures: S,
  ...options: ServiceServerOptions<S>
): IServiceServer<S, Data> => {
  const [given] = options;
  const hooks = hooksOf(procedures, given?.admissions);
  const callbacks = new Map<string, AnyCallback>();
  // what the offer made: the requester of each command, and the resolver of each procedure that
  // notifies, once registered
  const commands = new Map<string, IRequest<unknown, unknown, TransportServerConnectionHandle>>();
  const notifiers = new Map<
    string,
    INotificationResolver<unknown, TransportServerConnectionHandle>
  >();
  let offered: IServer<IServerTransportLike, Data> | undefined;

  const descriptorOf = (name: string): IServiceDescriptor | undefined => {
    return Object.hasOwn(procedures, name) ? procedures[name] : undefined;
  };

  // a resolver registered on the server offered: its admission built once, its failures held to
  // its list, its request validated
  const bind = (name: string, callback: AnyCallback): void => {
    const server = offered as IServer<IServerTransportLike, Data>;
    const descriptor = procedures[name] as IServiceDescriptor;
    const { admission, procedure, request, result } = descriptor;
    const hook = typeof admission === 'object' ? hooks.get(admission.hook) : undefined;
    const beforeRequest =
      admission === 'session'
        ? server.requireSession
        : hook === undefined
          ? undefined
          : beforeRequestOf(hook, server.router.failures.accessDenied);
    const serializer = {
      decode: request.decode,
      encode: result.encode as (value: unknown) => Uint8Array,
    };
    const resolved = async (
      props: IRequestProps<unknown, TransportServerConnectionHandle>,
      response: INotificationResponse<unknown, ResolverFailure>
    ): Promise<void> => {
      validated(descriptor, props);

      await callback(
        props,
        listedResponseOf(response, {
          descriptor,
          report: (error) => {
            server.router.report(error, props.connectionHandle);
          },
        })
      );
    };
    const dependencies = beforeRequest === undefined ? {} : { beforeRequest };

    if (procedure.procedureKind === ProcedureKind.NOTIFIES) {
      const { notification } = descriptor;

      notifiers.set(
        name,
        server.services.getNotificationResolver(procedure, {
          ...dependencies,
          serializer: {
            ...serializer,
            encodeNotification: notification?.encode as (value: unknown) => Uint8Array,
          },
        })(resolved)
      );

      return;
    }

    server.services.getRequestResolver(procedure, { ...dependencies, serializer })(
      resolved as Parameters<ReturnType<typeof server.services.getRequestResolver>>[0]
    );
  };

  // each command's requester stands from the start, and calls the one the offer made
  const command = Object.fromEntries(
    Object.entries(procedures)
      .filter(([, { procedure }]) => {
        return procedure.procedureKind === ProcedureKind.COMMAND;
      })
      .map(([name, { procedure }]) => {
        const requester = (payload: unknown) => {
          const made = commands.get(name);

          if (made === undefined) {
            throw new ProgrammerError(
              `${procedure.procedureName} is a command made as its service is offered, not before`
            );
          }

          return made(payload);
        };

        return [
          name,
          Object.freeze(
            Object.defineProperty(Object.assign(requester, procedure), 'name', {
              value: procedure.procedureName,
            })
          ),
        ];
      })
  );

  const notify = Object.fromEntries(
    Object.entries(procedures)
      .filter(([, { procedure }]) => {
        return procedure.procedureKind === ProcedureKind.NOTIFIES;
      })
      .map(([name]) => {
        return [
          name,
          (
            notification: unknown,
            notifyOptions?: INotifyOptions<TransportServerConnectionHandle>
          ): Promise<void> => {
            // * nothing offered, or nothing registered, holds no subscription to send to
            return notifiers.get(name)?.notify(notification, notifyOptions) ?? Promise.resolve();
          },
        ];
      })
  );

  return Object.freeze({
    command: Object.freeze(command),
    notify: Object.freeze(notify),

    offer: (server: IServer<IServerTransportLike, Data>) => {
      if (offered !== undefined) {
        throw new ProgrammerError('a service is offered on one server, once');
      }

      offered = server;

      for (const [name, { procedure, request, result }] of Object.entries(procedures)) {
        if (procedure.procedureKind === ProcedureKind.COMMAND) {
          commands.set(
            name,
            server.services.getCommand(procedure, {
              serializer: {
                decode: result.decode,
                encode: request.encode as (value: unknown) => Uint8Array,
              },
            })
          );
        }
      }

      for (const [name, callback] of callbacks) {
        bind(name, callback);
      }
    },
    on: (name: string, callback: AnyCallback) => {
      const procedureKind = descriptorOf(name)?.procedure.procedureKind;

      if (procedureKind !== ProcedureKind.REQUEST && procedureKind !== ProcedureKind.NOTIFIES) {
        throw new ProgrammerError(`${name} is no procedure this service's server answers`);
      }

      if (callbacks.has(name)) {
        throw new ProgrammerError(`${name} has a resolver already`);
      }

      callbacks.set(name, callback);

      if (offered !== undefined) {
        bind(name, callback);
      }
    },
    proceduresWithoutResolver: () => {
      return Object.freeze(
        Object.entries(procedures)
          .filter(([name, { procedure }]) => {
            return procedure.procedureKind !== ProcedureKind.COMMAND && !callbacks.has(name);
          })
          .map(([, { procedure }]) => {
            return procedure;
          })
      );
    },
  }) as unknown as IServiceServer<S, Data>;
};
