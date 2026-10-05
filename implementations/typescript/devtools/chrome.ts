// ── The browser's extension API ───────────────────────────────────────────────

// The part of Chrome's extension API the extension uses, typed here rather than by a package of
// declarations, so the package's types hold no `chrome` global outside this folder.

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

/** An exchange the Network panel saw, as DevTools hands it to an extension: a HAR entry. */
export interface IHarEntry {
  readonly request: {
    method: string;
    postData?: { encoding?: string; mimeType?: string; text?: string } | undefined;
    url: string;
  };
  readonly response: { content: { mimeType?: string }; status: number };
  readonly startedDateTime: string;
  getContent(callback: (content: string | null, encoding: string) => void): void;
}

/** The part of `chrome` the extension reads. */
export interface IChrome {
  devtools?:
    | {
        inspectedWindow: { tabId: number };
        network: { onRequestFinished: IExtensionEvent<(entry: IHarEntry) => void> };
        panels: {
          create: (...parts: [title: string, icon: string, page: string]) => void;
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
