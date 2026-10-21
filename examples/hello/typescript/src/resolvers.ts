// ── Resolvers ────────────────────────────────────────────────────────────────

// HelloService's resolvers and its hook, as the TypeScript side answers them: the only code its
// server writes, beside the generated `HelloServer`.

// dependencies

import type { IServer, IServerTransportLike } from '@francisdesjardins/bead/server';
import { HelloFailures, HelloServer } from '#hello';

// constants

/** What `sayHello` asks a caller that gave no name. */
const QUESTION = 'What is your name?';

// definition

/**
 * HelloService, offered on `server`: `sayHello` greets a name, asking its caller's by `askName`
 * when it is given none; `countDown` answers the ticks it will notify, then notifies them to its
 * caller's connection alone, and admits a connection that `sayHello` greeted. A count past 10 never
 * reaches it: its request's rule refuses it first.
 */
export const offerHello = <Data>(
  server: IServer<IServerTransportLike, Data>
): HelloServer<Data> => {
  // the connections sayHello greeted, each until it closes
  const greeted = new Set<string>();
  const hello = new HelloServer<Data>({
    admissions: {
      greeted: {
        admits: ({ connectionHandle }) => {
          return greeted.has(connectionHandle);
        },
        detail: 'say hello first',
      },
    },
  });

  server.transport.on('close', (_wasClean, connectionHandle) => {
    greeted.delete(connectionHandle);
  });

  hello.on('sayHello', async (request, response) => {
    const { connectionHandle, payload } = request;
    const name =
      payload.name === ''
        ? (await hello.command.askName({ question: QUESTION })({ connectionHandle })).name
        : payload.name;

    if (name === '') {
      return response(null, HelloFailures.of('NAMELESS', 'nobody to greet'));
    }

    greeted.add(connectionHandle);

    return response({ greeting: `Hello, ${name}!` });
  });

  hello.on('countDown', async (request, response) => {
    const { connectionHandle, payload } = request;

    await response({ ticks: payload.from + 1 });

    for (let remaining = payload.from; remaining >= 0; remaining -= 1) {
      await hello.notify.countDown(
        { remaining },
        {
          filter: (subscriber) => {
            return subscriber.connectionHandle === connectionHandle;
          },
        }
      );
    }
  });

  hello.offer(server);

  return hello;
};
