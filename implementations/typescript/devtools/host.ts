// ── The panel's host ──────────────────────────────────────────────────────────

// What the panel asks of the browser it runs in, and nothing more, so one panel serves every
// browser's extension: a port to the extension's background, the tab it inspects, DevTools' theme,
// and, where the browser gives them, the Network panel's exchanges, a script opened at a line in
// Sources, and the inspected page reloaded. Each browser's glue makes one from its own API.

// interfaces

/** A port to the extension's background, as the panel uses one. */
export interface IHostPort {
  onDisconnect(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  postMessage(message: unknown): void;
}

/** An exchange the Network panel saw, as DevTools hands it to an extension: a HAR 1.2 entry. */
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

/** What the panel asks of the browser it runs in. */
export interface IPanelHost {
  /** The tab the panel inspects. */
  readonly tabId: number;
  /** DevTools' theme, which the panel follows rather than the system's. */
  readonly theme: 'dark' | 'light';
  /** Opens a port to the extension's background. */
  connect(): IHostPort;
  /** Listens to the Network panel's exchanges as each ends; none where the browser gives none. */
  onExchange?: ((listener: (entry: IHarEntry) => void) => void) | undefined;
  /** Opens a script in Sources at a line, from 1; none where the browser cannot. */
  openResource?: ((url: string, line: number) => void) | undefined;
  /** Reloads the page the panel inspects; none where the browser cannot. */
  reload?: (() => void) | undefined;
}
