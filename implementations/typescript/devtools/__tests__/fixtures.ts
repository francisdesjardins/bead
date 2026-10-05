import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// constants

/** The extension, as `yarn devtools:build` leaves it. */
export const EXTENSION = fileURLToPath(new URL('../dist/', import.meta.url));

/** The demo's static build, as `yarn playground:build:file` leaves it: a page whose server is its worker. */
export const PLAYGROUND = fileURLToPath(new URL('../../demo/dist/playground/', import.meta.url));

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
});

// helpers

/** Fails, saying which build to run, when what a test loads was not built. */
export const assertBuilt = async (): Promise<void> => {
  for (const [path, command] of [
    [join(EXTENSION, 'manifest.json'), 'yarn devtools:build'],
    [join(PLAYGROUND, 'index.html'), 'yarn playground:build:file'],
  ] as const) {
    try {
      await access(path);
    } catch {
      throw new Error(`${path} is not there: run ${command} first`);
    }
  }
};

/** A folder served on this machine, as a static host serves it; what closes it. */
export const serveFolder = async (
  root: string
): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer((request, reply) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = join(root, path === '/' ? 'index.html' : path);

    readFile(file).then(
      (content) => {
        reply.writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
        reply.end(content);
      },
      () => {
        reply.writeHead(404);
        reply.end();
      }
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    close: () => {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
  };
};

/** Chromium with the extension loaded, its background, and its id. */
export const launchExtension = async (): Promise<{
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
}> => {
  const context = await chromium.launchPersistentContext('', {
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    channel: 'chromium',
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  return { context, extensionId: new URL(worker.url()).host, worker };
};
