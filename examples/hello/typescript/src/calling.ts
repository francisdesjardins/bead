// ── Calling ──────────────────────────────────────────────────────────────────

// HelloService's TypeScript client: it calls the server on 127.0.0.1, and writes what each call
// answered, a line each, which the C# client writes alike.

// dependencies

import { setTimeout } from 'node:timers/promises';
import { FailureError, FailureScope, ProtocolCode } from '@francisdesjardins/bead/client';
import { createWSClient } from '@francisdesjardins/bead/ws-client';
import { HelloClient, HelloFailures } from '#hello';

// constants

/** The name it answers `askName` with, the first time it is asked; an empty one after. */
const NAME = 'Ada';

/** How long each `countDown` callback holds itself, so ticks the window did not pace overlap. */
const HOLD_MS = 10;

// helpers

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// what a refused or failed call answered: a failure of HelloService's catalogue by its name, an
// admission refused by its detail; anything else is thrown again, as a catch has no type to filter by
const failureOf = (error: unknown): string => {
  if (HelloFailures.is(error, 'NAMELESS')) {
    return `NAMELESS, ${error.detail}`;
  }

  if (HelloFailures.is(error, 'TOO_FAR')) {
    return `TOO_FAR, ${error.detail}`;
  }

  if (
    error instanceof FailureError &&
    error.scope === FailureScope.PROTOCOL &&
    error.code === ProtocolCode.ACCESS_DENIED
  ) {
    return `ACCESS_DENIED, ${error.detail}`;
  }

  throw error;
};

// definition

/** Calls HelloService on `port`, and writes what it answered. */
export const call = async (port: number): Promise<number> => {
  await using client = createWSClient();
  // at a window of 1: each tick comes once the callback before it settled
  const hello = new HelloClient(client, { windows: { countDown: 1 } });
  let asked = 0;

  hello.on('askName', (_request, response) => {
    asked += 1;

    return response({ name: asked === 1 ? NAME : '' });
  });

  await client.connect({ host: '127.0.0.1', port });

  try {
    await hello.countDown({ from: 3 })();
  } catch (error) {
    say(`countDown before sayHello: ${failureOf(error)}`);
  }

  say(`sayHello Bead: ${(await hello.sayHello({ name: 'Bead' })()).greeting}`);
  say(`sayHello, nameless: ${(await hello.sayHello({ name: '' })()).greeting}`);

  try {
    await hello.countDown({ from: 11 })();
  } catch (error) {
    say(`countDown from 11: ${failureOf(error)}`);
  }

  // * the callbacks counted while they run: at a window of 1, one at a time, by construction
  const ticks: number[] = [];
  let inFlight = 0;
  let most = 0;
  const counted = Promise.withResolvers<void>();
  const registration = await hello.notifications.countDown({ from: 3 }, async ({ remaining }) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    ticks.push(remaining);
    // a callback that takes its time: the window holds the next tick until it settles
    await setTimeout(HOLD_MS);
    inFlight -= 1;

    if (remaining === 0) {
      counted.resolve();
    }
  })();

  await counted.promise;
  await registration.unregister();
  say(`countDown from 3: ${ticks.join(' ')}, ${most === 1 ? 'one' : String(most)} at a time`);

  try {
    await hello.sayHello({ name: '' })();
  } catch (error) {
    say(`sayHello, nameless again: ${failureOf(error)}`);
  }

  await client.disconnect();

  return 0;
};
