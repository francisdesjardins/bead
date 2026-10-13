// ── The browser's extension API ───────────────────────────────────────────────

// The part of Chrome's extension API the extension uses, typed here rather than by a package of
// declarations, so the package's types hold no `chrome` global outside this folder.

// dependencies

import type { IHarEntry } from '../host';

// interfaces

/** An event of the API: listeners added and taken away. */
export interface IExtensionEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** A runtime port, between two of the extension's parts. */
export interface IPort {
  readonly name: string;
  readonly onDisconnect: IExtensionEvent<(port: IPort) => void>;
  readonly onMessage: IExtensionEvent<(message: unknown) => void>;
  readonly sender?: { frameId?: number; tab?: { id?: number }; url?: string } | undefined;
  disconnect(): void;
  postMessage(message: unknown): void;
}

// types

/** Opens a resource in Sources at a line, from 0. */
// oxlint-disable-next-line bead/options-last -- Chrome's own, `openResource(url, lineNumber, callback)`
type OpenResource = (...parts: [url: string, line: number, done?: () => void]) => void;

/** The part of `chrome` the extension reads. */
export interface IChrome {
  devtools?:
    | {
        inspectedWindow: { tabId: number; reload?: (() => void) | undefined };
        network: { onRequestFinished: IExtensionEvent<(entry: IHarEntry) => void> };
        panels: {
          // oxlint-disable-next-line bead/options-last -- Chrome's own, `create(title, iconPath, pagePath)`
          create: (...parts: [title: string, icon: string, page: string]) => void;
          openResource?: OpenResource | undefined;
          themeName?: string;
        };
      }
    | undefined;
  runtime: {
    id?: string | undefined;
    onConnect: IExtensionEvent<(port: IPort) => void>;
    connect(options: { name: string }): IPort;
    getURL(path: string): string;
  };
}

// definition

/** The extension API, where the extension's own scripts run. */
export const chromeOf = (): IChrome => {
  return (globalThis as unknown as { chrome: IChrome }).chrome;
};
