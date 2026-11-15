import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

// interfaces

/** A port the fake runtime opened or was handed, as a test reads it back. */
export interface IFakePort {
  name: string;
  isDisconnected: boolean;
  posted: unknown[];
}

/** What the fake runtime has seen, as plain data. */
export interface IRuntimeState {
  ports: IFakePort[];
  // how many times a listener read `runtime.lastError`
  lastErrorReads: number;
}

/** What the fake runtime keeps, on the page's window. */
interface IFakeRuntime extends IRuntimeState {
  // a port's other end gone, its disconnect told with `lastError` set while its listeners run
  drop: (index: number, error?: string) => void;
  // a port opened from elsewhere, handed to `runtime.onConnect`'s listeners
  offer: (port: { name: string; sender?: object }) => void;
}

// helpers

/** A script of the extension's, bundled for the page as Chrome loads it. */
export const scriptOf = async (name: 'background' | 'bridge'): Promise<string> => {
  const bundle = await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL(`../${name}.ts`, import.meta.url))],
    format: 'iife',
    platform: 'browser',
    write: false,
  });

  return bundle.outputFiles[0]?.text ?? '';
};

/**
 * A fake of Chrome's runtime on the page, before any script of its own: each port it opens or is
 * handed is kept, and its `lastError` counts its reads, set only while a disconnect is told, as
 * Chrome sets it.
 */
export const installRuntime = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    type Listener = (value: unknown) => void;

    const eventOf = (list: Listener[]) => {
      return {
        addListener: (listener: Listener) => {
          list.push(listener);
        },
        removeListener: () => {},
      };
    };
    const ports: (IFakePort & { disconnects: Listener[]; port: object })[] = [];
    const connects: Listener[] = [];
    let lastError: { message: string } | undefined;
    const fake = {
      ports,
      lastErrorReads: 0,
      drop: (index: number, error?: string) => {
        const held = ports[index];

        if (held === undefined) {
          return;
        }

        held.isDisconnected = true;
        lastError = error === undefined ? undefined : { message: error };
        for (const listener of held.disconnects) {
          listener(held.port);
        }
        lastError = undefined;
      },
      offer: ({ name, sender }: { name: string; sender?: object }) => {
        const port = portOf(name, sender);

        for (const listener of connects) {
          listener(port);
        }
      },
    };
    const portOf = (name: string, sender?: object): object => {
      const disconnects: Listener[] = [];
      const held = { name, isDisconnected: false, posted: [] as unknown[], disconnects, port: {} };

      held.port = {
        name,
        sender,
        disconnect: () => {
          held.isDisconnected = true;
        },
        onDisconnect: eventOf(disconnects),
        onMessage: eventOf([]),
        postMessage: (message: unknown) => {
          held.posted.push(message);
        },
      };
      ports.push(held);

      return held.port;
    };

    Object.assign(globalThis, {
      chrome: {
        runtime: {
          id: 'fake',
          get lastError() {
            fake.lastErrorReads += 1;

            return lastError;
          },
          connect: ({ name }: { name: string }) => {
            return portOf(name);
          },
          getURL: (path: string) => {
            return `chrome-extension://fake/${path}`;
          },
          onConnect: eventOf(connects),
        },
      },
      fake,
    });
  });
};

/** The fake runtime's state, as plain data. */
export const runtimeOf = (page: Page): Promise<IRuntimeState> => {
  return page.evaluate(() => {
    const { fake } = globalThis as unknown as { fake: IFakeRuntime };

    return {
      lastErrorReads: fake.lastErrorReads,
      ports: fake.ports.map(({ name, isDisconnected, posted }) => {
        return { name, isDisconnected, posted };
      }),
    };
  });
};
