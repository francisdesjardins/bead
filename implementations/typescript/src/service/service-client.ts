// ── Service client ────────────────────────────────────────────────────────────

// The client side of one service, over one Bead client: a requester of each procedure its server
// answers and a notification of each that notifies, made as it is built, and the resolvers of the
// commands it answers. A generated client is a thin shell over it.

// dependencies

import type { IClient } from '../client/types';
import type { RouterClientConnectionHandle } from '../router/client/types';
import { ProcedureCall } from '../router/shared/constants';
import type {
  IBeforeRequest,
  IAdmissionRequest,
  INotification,
  INotificationResponse,
  IRequest,
  IRequestProps,
  ResolverFailure,
} from '../router/shared/types';
import { ProgrammerError } from '../transport/shared/errors';
import type {
  AnsweredName,
  CommandName,
  GivenOf,
  IServiceDescriptor,
  NotifyingName,
  ServiceProcedures,
  ValueOf,
} from './descriptors';
import { listedResponseOf, type ServiceResolverCallback, validated } from './service-server';

// interfaces

/** The client side of a service, over one Bead client. */
export interface IServiceClient<S extends ServiceProcedures> {
  /** The notification of each procedure that notifies, at the window its caller gave, or none. */
  readonly notifications: {
    readonly [Name in NotifyingName<S>]: INotification<
      GivenOf<S[Name]['request']>,
      ValueOf<NonNullable<S[Name]['notification']>>
    >;
  };
  /**
   * A requester of each procedure its server answers, made as the client side is built: one of a
   * procedure that notifies opens no subscription (spec 11.2).
   */
  readonly request: {
    readonly [Name in AnsweredName<S>]: IRequest<
      GivenOf<S[Name]['request']>,
      ValueOf<S[Name]['result']>,
      RouterClientConnectionHandle
    >;
  };

  /**
   * Registers the resolver of a command it answers; twice for one command, a name that is no
   * command, or a command admitted by a hook, which a client side is given none of, is a
   * {@link ProgrammerError}.
   */
  on: <Name extends CommandName<S>>(
    name: Name,
    callback: ServiceResolverCallback<S[Name], RouterClientConnectionHandle>
  ) => void;
}

// types

/** A command's resolver registered. */
type AnyCallback = (
  request: IRequestProps<unknown, RouterClientConnectionHandle>,
  response: INotificationResponse<unknown, ResolverFailure>
) => Promise<void>;

// definition

/**
 * The client side of a service, over `options.client`: a requester of each procedure its server
 * answers and a notification of each that notifies, each made once as it is built, at the window
 * `options.windows` gives it — unpaced when none — and `on`, for the commands it answers. A window
 * for a procedure that does not notify, or one that is not a whole number above 0, is a
 * {@link ProgrammerError}, and so is a second client side over one Bead client at another window.
 * With `validates`, each requester runs its descriptor's `validate` before it encodes a request.
 *
 * @example
 * import { createServiceClient, PAYLOAD_CODECS, requestOf } from '@francisdesjardins/bead/service';
 *
 * const GreeterProcedures = Object.freeze({
 *   sayHello: requestOf({
 *     admission: 'none',
 *     failures: {},
 *     procedure: { procedureId: 1, procedureName: 'sayHello', serviceId: 1, serviceRevision: 1 },
 *     request: PAYLOAD_CODECS.text,
 *     result: PAYLOAD_CODECS.text,
 *   }),
 * });
 * const greeter = createServiceClient(GreeterProcedures, { client });
 *
 * const greeting = greeter.request.sayHello('Bead')({ timeout: 2_000 });
 */
export const createServiceClient = <const S extends ServiceProcedures>(
  procedures: S,
  options: {
    client: IClient;
    /** Whether each requester runs its descriptor's `validate` before it encodes; not when none. */
    validates?: boolean | undefined;
    windows?: { readonly [Name in NotifyingName<S>]?: number | undefined } | undefined;
  }
): IServiceClient<S> => {
  const { client, validates = false } = options;
  const windows: Readonly<Record<string, number | undefined>> = options.windows ?? {};
  const services = client.services;
  const callbacks = new Set<string>();
  const notifying = (name: string): boolean => {
    return (
      Object.hasOwn(procedures, name) && procedures[name]?.procedure.call === ProcedureCall.NOTIFIES
    );
  };

  for (const name of Object.keys(windows)) {
    if (!notifying(name)) {
      throw new ProgrammerError(`${name} does not notify, and takes no window`);
    }
  }

  // how each procedure's request is written: validated first, when the options say so
  const encoderOf = (descriptor: IServiceDescriptor): ((value: unknown) => Uint8Array) => {
    const encode = descriptor.request.encode as (value: unknown) => Uint8Array;
    const { validate } = descriptor;

    return validates && validate !== undefined
      ? (value) => {
          validate(value);

          return encode(value);
        }
      : encode;
  };

  const request: Record<string, unknown> = {};
  const notifications: Record<string, unknown> = {};

  for (const [name, descriptor] of Object.entries(procedures)) {
    const { notification, procedure, result } = descriptor;

    if (procedure.call === ProcedureCall.COMMAND) {
      continue;
    }

    const serializer = {
      decode: result.decode,
      encode: encoderOf(descriptor),
    };

    request[name] = services.getRequest(procedure, { serializer });

    if (procedure.call === ProcedureCall.NOTIFIES) {
      const window = windows[name];

      notifications[name] = services.getNotification(procedure, {
        serializer: {
          ...serializer,
          decodeNotification: notification?.decode as (bytes: Uint8Array) => unknown,
        },
        ...(window === undefined ? {} : { window }),
      });
    }
  }

  return Object.freeze({
    notifications: Object.freeze(notifications),
    request: Object.freeze(request),

    on: (name: string, callback: AnyCallback) => {
      const descriptor = Object.hasOwn(procedures, name) ? procedures[name] : undefined;

      if (descriptor?.procedure.call !== ProcedureCall.COMMAND) {
        throw new ProgrammerError(`${name} is no command this service's client answers`);
      }

      const { admission, procedure, request: requestCodec, result } = descriptor;

      if (typeof admission === 'object') {
        throw new ProgrammerError(
          `${procedure.procedureName} is admitted by the hook ${admission.hook}, and a client side is given no hook`
        );
      }

      if (callbacks.has(name)) {
        throw new ProgrammerError(`${name} has a resolver already`);
      }

      // * a command's session, as a server's requireSession, with the client router's own refusal
      const beforeRequest: IBeforeRequest<RouterClientConnectionHandle> | undefined =
        admission === 'session'
          ? Object.assign(
              ({ session }: IAdmissionRequest<RouterClientConnectionHandle>) => {
                return session !== undefined;
              },
              { refusal: client.router.failures.sessionRequired }
            )
          : undefined;

      services.getCommandResolver(procedure, {
        ...(beforeRequest === undefined ? {} : { beforeRequest }),
        serializer: {
          decode: requestCodec.decode,
          encode: result.encode as (value: unknown) => Uint8Array,
        },
      })(async (props, response) => {
        validated(descriptor, props);

        await callback(
          props,
          listedResponseOf(response as INotificationResponse<unknown, ResolverFailure>, {
            descriptor,
            report: (error) => {
              client.router.report(error);
            },
          })
        );
      });
      callbacks.add(name);
    },
  }) as unknown as IServiceClient<S>;
};
