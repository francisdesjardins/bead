import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { CancelError, TimeoutError } from '../../../transport/shared/errors';
import { CredentialScheme } from '../constants';
import {
  CLIENT_FAILURES,
  createServiceManager,
  DisconnectError,
  FailureError,
  FailureScope,
  ProgrammerError,
  type ICommandOptions,
  type IProcedure,
  type IProcedureSeries,
  type IRequestOptions,
  type IRouterLike,
} from '../service-manager';
import { REQUEST_DEFAULTS, resolveRequestOptions } from '../service-requester';
import {
  connectionHandle,
  createFakeRouter,
  echo,
  recordDebug,
  serializer,
} from './service-manager-fixtures';

// definition

test.describe('resolveRequestOptions', () => {
  test('fills what the options leave out, and passes a destination as it is', () => {
    const options = { connectionHandle, destinationId: undefined };

    expect(REQUEST_DEFAULTS).toEqual({ timeout: 5_000 });
    expect(resolveRequestOptions(REQUEST_DEFAULTS)).toEqual({ ...REQUEST_DEFAULTS });
    // a destination is the call's alone, passed on as it is, left undefined included
    expect(resolveRequestOptions(REQUEST_DEFAULTS, options)).toEqual({
      ...REQUEST_DEFAULTS,
      connectionHandle,
      destinationId: undefined,
    });
    expect(resolveRequestOptions(REQUEST_DEFAULTS, { destinationId: 4, timeout: 10 })).toEqual({
      destinationId: 4,
      timeout: 10,
    });
    // a close on timeout a command's alone, and only where the call or the defaults have one: a
    // request names no connection to close
    expect(resolveRequestOptions({ ...REQUEST_DEFAULTS, closeOnTimeout: true })).toEqual({
      ...REQUEST_DEFAULTS,
    });
    expect(
      resolveRequestOptions({ ...REQUEST_DEFAULTS, closeOnTimeout: true }, { connectionHandle })
    ).toEqual({ ...REQUEST_DEFAULTS, closeOnTimeout: true, connectionHandle });
    expect(
      resolveRequestOptions(
        { ...REQUEST_DEFAULTS, closeOnTimeout: true },
        { closeOnTimeout: false, connectionHandle }
      )
    ).toEqual({ ...REQUEST_DEFAULTS, closeOnTimeout: false, connectionHandle });
    // * and the options it is given are left as they are
    expect(options).toEqual({ connectionHandle, destinationId: undefined });
  });
});

test.describe('createServiceManager', () => {
  test.describe('getRequest', () => {
    test('is named after its procedure and carries it', () => {
      const manager = createServiceManager(createFakeRouter('client').router);
      const request = manager.getRequest(echo, { serializer });

      expect(request.name).toBe('echo');
      expect({ ...request }).toEqual(echo);
      // * its kind too, when the procedure states one
      expect({
        ...manager.getRequest(
          { ...echo, procedureId: 72, procedureKind: 'request' },
          { serializer }
        ),
      }).toEqual({ ...echo, procedureId: 72, procedureKind: 'request' });
    });

    test('gives a bound call no promise is, so awaiting it with its options forgotten does not compile', async () => {
      const manager = createServiceManager(createFakeRouter('client').router);
      const request = manager.getRequest(echo, { serializer });
      const forgotten = async (): Promise<unknown> => {
        // the very mistake the type refuses, which the lint's await-thenable sees too
        // @ts-expect-error TS1320: the bound call awaited, its options' call forgotten, sends nothing
        return await request({ text: 'hello' }); // oxlint-disable-line typescript/await-thenable, typescript/return-await
      };

      await expect(request({ text: 'hello' })()).resolves.toEqual({ text: 'hello' });
      await expect(forgotten()).resolves.toBeInstanceOf(Function);
    });

    test('sends the encoded payload with the resolved options, and decodes the answer', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const request = manager.getRequest(echo, { serializer });

      await expect(request({ text: 'hello' })({ timeout: 100 })).resolves.toEqual({
        text: 'hello',
      });
      expect(calls.request).toEqual([
        {
          payload: { text: 'hello' },
          request: {
            options: { timeout: 100 },
            procedure: echo,
            subscribes: undefined,
          },
        },
      ]);
    });

    test('takes the manager’s defaults where the call says nothing, and its signal as given', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router, { defaults: { timeout: 50 } });
      const request = manager.getRequest(echo, { serializer });
      const { signal } = new AbortController();

      await request({ text: 'a' })();
      await request({ text: 'b' })({ destinationId: 2, signal, timeout: 9 });
      await createServiceManager(router, {
        // @ts-expect-error: a destination is a call's own, never a default
        defaults: { destinationId: 4 },
      }).getRequest(echo, { serializer })({ text: 'c' })();

      expect(
        calls.request.map(({ request: { options } }) => {
          return options;
        })
      ).toEqual([
        { timeout: 50 },
        { destinationId: 2, signal, timeout: 9 },
        { timeout: REQUEST_DEFAULTS.timeout },
      ]);
    });

    // debugging 4.1.7
    test('hands its router the credential a call presents and leaves it out of its trace', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const jwt = { scheme: CredentialScheme.JWT, token: 'a.secret.token' } as const;
      const elsewhere = { carried: 'Bearer secret', scheme: CredentialScheme.ELSEWHERE } as const;

      for (const credential of [{ scheme: CredentialScheme.OPAQUE } as const, jwt, elsewhere]) {
        await manager.getRequest(echo, { serializer })({ text: 'a' })({ credential });
      }

      await manager.getRequest(echo, { serializer })({ text: 'b' })();

      expect(seen).toHaveLength(8);
      await manager.getRequest(echo, { serializer })({ text: 'c' })({
        credential: { scheme: CredentialScheme.JWT, token: 'a.b.c' },
      });
      await manager.getRequest(echo, { serializer })({ text: 'd' })({
        credential: { carried: 'Interop sub=ada', scheme: CredentialScheme.ELSEWHERE },
      });

      expect(
        calls.request.map(({ request }) => {
          return request.options.credential;
        })
      ).toEqual([
        { scheme: CredentialScheme.OPAQUE },
        jwt,
        elsewhere,
        undefined,
        { scheme: CredentialScheme.JWT, token: 'a.b.c' },
        { carried: 'Interop sub=ada', scheme: CredentialScheme.ELSEWHERE },
      ]);
      expect(seen).toHaveLength(12);
      expect(
        seen.every(({ info }) => {
          return info.options !== undefined && !('credential' in info.options);
        })
      ).toBe(true);
      for (const secret of [
        'secret',
        'a.secret.token',
        'Bearer secret',
        'a.b.c',
        'Interop sub=ada',
      ]) {
        expect(JSON.stringify(seen)).not.toContain(secret);
      }
    });

    // debugging 4.1.9
    test('rethrows what the router rejects with, and tells debug its failure, and only a failure’s', async () => {
      const { control, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const failure = new FailureError({
        ...CLIENT_FAILURES.accessDenied,
        detail: 'no',
        origin: 'peer',
        relays: 2,
      });
      // what merely looks like a failure is not one
      const lookalike = Object.assign(new Error('reset'), { code: 'ECONNRESET', scope: 0 });

      control.answer = () => {
        return Promise.reject(failure);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(failure);
      expect(
        seen.map(({ error }) => {
          return error;
        })
      ).toEqual([null, failure]);
      expect(seen[1]?.info.rx).toEqual({ code: 33, detail: 'no', scope: FailureScope.PROTOCOL });

      control.answer = () => {
        return Promise.reject(lookalike);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(
        lookalike
      );
      expect(seen[3]?.info.rx).toBeUndefined();
      expect(seen[3]?.error).toBe(lookalike);

      const reset = new Error('reset');

      control.answer = () => {
        return Promise.reject(reset);
      };

      await expect(manager.getRequest(echo, { serializer })({ text: 'x' })()).rejects.toBe(reset);
      expect(seen[5]?.info.rx).toBeUndefined();
      expect(
        seen.map(({ error }) => {
          return error;
        })
      ).toEqual([null, failure, null, lookalike, null, reset]);
    });

    // spec 17.2.4; debugging 4.3
    test('a call whose value does not write fails before anything goes: nothing requested, traced or deprecated', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router);
      const seen = recordDebug(manager);
      const deprecated: IProcedure[] = [];
      const refusal = new TypeError('this value does not write');

      manager.on('deprecated', (procedure) => {
        deprecated.push(procedure);
      });

      const request = manager.getRequest(
        { ...echo, deprecation: { message: 'use another' } },
        {
          serializer: {
            ...serializer,
            encode: () => {
              throw refusal;
            },
          },
        }
      );

      await expect(request({ text: 'x' })()).rejects.toBe(refusal);
      expect(calls.request).toEqual([]);
      expect(seen).toEqual([]);
      expect(deprecated).toEqual([]);
    });

    test('declares its requester to its router as it is made, and hands each of its calls the series it gave', async () => {
      const { calls, control, router } = createFakeRouter('client');
      const series: IProcedureSeries = {
        end: () => {
          return undefined;
        },
        start: () => {
          return undefined;
        },
      };

      control.series = series;

      const manager = createServiceManager(router);
      const asking = manager.getRequest(echo, { serializer });

      expect(calls.declareRequester).toEqual(['echo']);

      await asking({ text: 'x' })();
      await asking({ text: 'y' })();

      expect(calls.declareRequester).toEqual(['echo']);
      expect(
        calls.request.map(({ request }) => {
          return request.series === series;
        })
      ).toEqual([true, true]);
    });

    test('a deprecated procedure raises "deprecated" at each call, and only a deprecated one', async () => {
      const manager = createServiceManager(createFakeRouter('client').router);
      const seen: unknown[][] = [];

      manager.on('deprecated', (...params) => {
        seen.push(params);
      });

      const old = manager.getRequest(
        { ...echo, deprecation: { message: 'use echo2' } },
        { serializer }
      );

      await old({ text: 'a' })();
      await old({ text: 'b' })();
      await manager.getRequest(echo, { serializer })({ text: 'c' })();
      // present, even empty, is deprecated
      await manager.getRequest({ ...echo, deprecation: {} }, { serializer })({ text: 'd' })();

      expect(seen).toEqual([
        [{ ...echo, deprecation: { message: 'use echo2' } }],
        [{ ...echo, deprecation: { message: 'use echo2' } }],
        [{ ...echo, deprecation: {} }],
      ]);
    });
  });

  test.describe('commands', () => {
    test('one unanswered in time closes its connection, as the call or else the manager says; nothing else does', async () => {
      const { control, router } = createFakeRouter();
      const closed: string[] = [];
      const closeConnection = (handle: string) => {
        closed.push(handle);
      };
      const byDefault = createServiceManager(
        router as IRouterLike<TransportServerConnectionHandle>,
        {
          closeConnection,
          defaults: { closeOnTimeout: true },
        }
      );
      const unlessAsked = createServiceManager(
        router as IRouterLike<TransportServerConnectionHandle>,
        {
          closeConnection,
        }
      );
      const unable = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>, {
        defaults: { closeOnTimeout: true },
      });
      const late = new TimeoutError(10, 'no answer came in 10 milliseconds');
      const refused = new FailureError({ ...CLIENT_FAILURES.procedureFailed, origin: 'peer' });
      let failure: Error = late;

      control.answer = () => {
        return Promise.reject(failure);
      };

      const call = async (
        manager: typeof byDefault,
        closeOnTimeout?: boolean
      ): Promise<unknown> => {
        return manager
          .getCommand(echo, { serializer })({ text: 'run' })({
            closeOnTimeout,
            connectionHandle,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      // the call rejects with what went wrong either way
      expect(await call(byDefault)).toBe(late);
      expect(closed).toEqual([connectionHandle]);

      expect(await call(byDefault, false)).toBe(late);
      expect(await call(unlessAsked)).toBe(late);
      expect(await call(unable)).toBe(late);
      expect(closed).toEqual([connectionHandle]);

      expect(await call(unlessAsked, true)).toBe(late);
      expect(closed).toEqual([connectionHandle, connectionHandle]);

      // an answer, even a refusal, is not silence; nor is a connection gone, or a caller that gave up
      for (const other of [refused, new DisconnectError('gone'), new CancelError()]) {
        failure = other;

        expect(await call(byDefault)).toBe(other);
      }

      expect(closed).toHaveLength(2);
    });

    test('getCommand asks one connection, as a server’s request does, and tells debug it is a command', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
      const seen = recordDebug(manager);
      const command = manager.getCommand(echo, { serializer });

      await expect(command({ text: 'run' })({ connectionHandle })).resolves.toEqual({
        text: 'run',
      });

      // @ts-expect-error: a command names the connection it goes to
      await command({ text: 'run' })().catch(() => {
        return undefined;
      });

      expect(command.name).toBe('echo');
      expect(calls.request[0]?.request.options.connectionHandle).toBe(connectionHandle);
      expect(
        seen.slice(0, 2).map(({ info }) => {
          return [info.direction, info.type];
        })
      ).toEqual([
        ['tx', 'command'],
        ['rx', 'command'],
      ]);
    });

    test('tells debug the close on timeout that applies, the call’s or else the manager’s', async () => {
      const { router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>, {
        closeConnection: () => {
          return undefined;
        },
        defaults: { closeOnTimeout: true },
      });
      const seen = recordDebug(manager);
      const command = manager.getCommand(echo, { serializer })({ text: 'run' });

      await command({ connectionHandle });
      await command({ closeOnTimeout: false, connectionHandle });

      expect(
        seen
          .filter(({ info }) => {
            return info.direction === 'tx';
          })
          .map(({ info }) => {
            return info.options?.closeOnTimeout;
          })
      ).toEqual([true, false]);
    });

    test('a client’s calls, and a notification’s, take no close on timeout: they name no connection', async () => {
      const { router } = createFakeRouter('client');
      const manager = createServiceManager(router as IRouterLike<'server'>);

      await manager
        .getRequest(echo, { serializer })({ text: 'a' })(
          // @ts-expect-error: a client's call names no connection to close
          { closeOnTimeout: true }
        )
        .catch(() => {
          return undefined;
        });
      await manager
        .getNotification(echo, { serializer })({ text: 'a' }, () => {
          return undefined;
        })(
          // @ts-expect-error: a notification's registration names no connection to close
          { closeOnTimeout: true }
        )
        .catch(() => {
          return undefined;
        });
      await manager
        .getRequest(echo, { serializer })({ text: 'a' })(
          // @ts-expect-error: a client's call names no connection
          { connectionHandle: 'server' }
        )
        .catch(() => {
          return undefined;
        });
      await manager
        .getNotification(echo, { serializer })({ text: 'a' }, () => {
          return undefined;
        })(
          // @ts-expect-error: a registration presents no credential: its subscription is the
          // connection's
          { credential: { scheme: CredentialScheme.OPAQUE } }
        )
        .catch(() => {
          return undefined;
        });
    });

    test('a client request resolves no close on timeout', async () => {
      const { calls, router } = createFakeRouter('client');
      const manager = createServiceManager(router as IRouterLike<'server'>, {
        closeConnection: () => {
          return undefined;
        },
        defaults: { closeOnTimeout: true },
      });
      const seen = recordDebug(manager);

      await expect(manager.getRequest(echo, { serializer })({ text: 'run' })()).resolves.toEqual({
        text: 'run',
      });

      // * a request names no connection, so it has none to close, whatever the defaults say
      expect(calls.request[0]?.request.options).toEqual({ timeout: REQUEST_DEFAULTS.timeout });
      expect(
        seen
          .filter(({ info }) => {
            return info.direction === 'tx';
          })
          .map(({ info }) => {
            return info.options;
          })
      ).toEqual([{ timeout: REQUEST_DEFAULTS.timeout }]);
    });

    test('a command names the connection it goes to, as the types require', async () => {
      const { calls, router } = createFakeRouter();
      const manager = createServiceManager(router as IRouterLike<TransportServerConnectionHandle>);
      const command = manager.getCommand(echo, { serializer })({ text: 'a' });
      // a router whose handle is any string requires it all the same
      const anyHandle = createServiceManager(router).getCommand(echo, { serializer })({
        text: 'b',
      });

      await command({ connectionHandle });
      await anyHandle({ connectionHandle, timeout: 10 });
      // past the types, a router refuses it at the call; this one echoes it
      // @ts-expect-error: a command names the connection it goes to
      await command();
      // @ts-expect-error: its options name it
      await command({ timeout: 10 });
      // @ts-expect-error: on a router whose handle is any string too
      await anyHandle({ destinationId: 4 });

      expect(
        calls.request.map(({ request }) => {
          return request.options.connectionHandle;
        })
      ).toEqual([connectionHandle, connectionHandle, undefined, undefined, undefined]);
    });

    // decision 0004: a command's options are a request's and its own, its connection and its close
    test('a command’s options carry every option of a request’s', () => {
      const { signal } = new AbortController();
      const credential = { scheme: CredentialScheme.OPAQUE } as const;
      // * every member of a request's options, named: one a request's options gain fails this build
      // until it is listed, and one a command's options lack fails it as well
      const carried: {
        [Key in keyof Required<IRequestOptions>]: IRequestOptions[Key] extends ICommandOptions[Key]
          ? Key
          : never;
      } = {
        credential: 'credential',
        destinationId: 'destinationId',
        signal: 'signal',
        timeout: 'timeout',
      };
      const command: ICommandOptions = {
        connectionHandle,
        credential,
        destinationId: 4,
        signal,
        timeout: 7,
      };
      // a command's options are a request's, and more
      const request: IRequestOptions = command;

      expect(Object.keys(carried).sort()).toEqual(
        Object.keys(command)
          .filter((key) => {
            return key !== 'connectionHandle';
          })
          .sort()
      );
      expect(request).toBe(command);
    });

    // spec 16.10, 16.11
    test('makes requests and notifications on a client’s router alone and commands on a server’s alone, refusing the other as it is made', () => {
      const COMMANDS = "a server's router makes commands: getCommand";
      const REQUESTS = "a client's router makes requests: getRequest";
      const NOTIFIES = 'only a client hears notifications; a server notifies them';
      const ofKind = (procedureKind?: IProcedure['procedureKind']): IProcedure => {
        return procedureKind === undefined ? echo : { ...echo, procedureKind };
      };
      const refusalOf = (make: () => unknown): string => {
        try {
          make();
        } catch (reason) {
          expect(reason).toBeInstanceOf(ProgrammerError);

          return (reason as Error).message;
        }

        throw new Error('made');
      };

      // on a server's router
      const server = createFakeRouter();
      const onServer = createServiceManager(
        server.router as IRouterLike<TransportServerConnectionHandle>
      );
      const request = (procedure: IProcedure): string => {
        return refusalOf(() => {
          return onServer.getRequest(procedure, { serializer });
        });
      };
      const notification = (procedure: IProcedure): string => {
        return refusalOf(() => {
          return onServer.getNotification(procedure, { serializer });
        });
      };

      for (const kind of [undefined, 'command'] as const) {
        expect(request(ofKind(kind))).toBe(COMMANDS);
        expect(notification(ofKind(kind))).toBe(NOTIFIES);
      }

      expect(request(ofKind('request'))).toContain('is against its kind');

      for (const kind of ['request', 'notifies'] as const) {
        expect(notification(ofKind(kind))).toContain('is against its kind');
      }

      // * out of its range before the side, as before its kind
      for (const refused of [request, notification]) {
        expect(refused({ ...echo, serviceId: 0 })).toContain('is out of its range');
      }

      expect(server.calls.declareRequester).toEqual([]);
      expect(server.calls.registerNotification).toEqual([]);
      expect(onServer.getCommand(echo, { serializer }).name).toBe('echo');
      expect(server.calls.declareRequester).toEqual(['echo']);

      // on a client's router
      const client = createFakeRouter('client');
      const onClient = createServiceManager(client.router as IRouterLike<'server'>);
      const command = (procedure: IProcedure): string => {
        return refusalOf(() => {
          return onClient.getCommand(procedure, { serializer });
        });
      };

      for (const kind of [undefined, 'request', 'notifies'] as const) {
        expect(command(ofKind(kind))).toBe(REQUESTS);
      }

      expect(command(ofKind('command'))).toContain('is against its kind');
      expect(command({ ...echo, serviceId: 0 })).toContain('is out of its range');
      expect(client.calls.declareRequester).toEqual([]);
      expect(onClient.getRequest(echo, { serializer }).name).toBe('echo');
      expect(
        onClient.getNotification(
          { ...echo, procedureId: 2, procedureKind: 'notifies' },
          { serializer }
        ).name
      ).toBe('echo');
      expect(client.calls.declareRequester).toEqual(['echo', 'echo']);
    });
  });
});
