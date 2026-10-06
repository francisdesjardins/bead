// ── DevTools messages ─────────────────────────────────────────────────────────

// What the extension's parts say to each other (decision 0015): the hook, in the page's world; the
// bridge, in the extension's isolated world beside it; the background, which pairs a page with its
// panel by tab; and the panel. Every message is JSON, as a runtime port carries it: no bigint, no
// bytes, no function.

// interfaces

/** A client the page announced, as the panel names it. */
export interface ISourceRecord {
  /** Its number in the page, from 1, in the order it was announced. */
  id: number;
  /** The hook's protocol it speaks; the extension watches the ones it knows alone. */
  protocol: number;
  side: string;
}

/** One step of a call, as a source's `debug` told it, made plain. */
export interface ICallRecord {
  /**
   * Its call's id, as its envelopes carry it; none for a call refused before it went, and for a
   * notification.
   */
  callId?: number | undefined;
  /** The connection its call is on, as its envelopes name it, `server` on a client; none without. */
  connectionHandle?: string | undefined;
  /** How long the call took once it answered, in milliseconds; none before. */
  duration?: number | undefined;
  /** Its credential, by its scheme's number alone; none when it gave none of its own. */
  credentialScheme?: number | undefined;
  direction: string;
  /** What it failed with: its name, its message, and a failure's code, scope and detail. */
  error?: IErrorRecord | undefined;
  kind: 'call';
  procedureId: number;
  procedureName: string;
  /** What came in, decoded, as a preview of bounded length. */
  rx?: string | undefined;
  serviceId: number;
  serviceRevision: number;
  source: number;
  /** When the call started, in milliseconds since the epoch. */
  startedAt: number;
  /** Its timeout in milliseconds, or `never`. */
  timeout?: number | 'never' | undefined;
  /** What went out, decoded, as a preview of bounded length. */
  tx?: string | undefined;
  type: string;
}

/** What a call failed with, made plain. */
export interface IErrorRecord {
  code?: number | undefined;
  detail?: string | undefined;
  message: string;
  name: string;
  scope?: number | undefined;
}

/** One envelope, as a source's router told it: its header, its credential by its scheme alone. */
export interface IEnvelopeRecord {
  /** When the hook heard it, in milliseconds since the epoch. */
  at: number;
  connectionHandle: string;
  direction: string;
  /** Its header's fields, each a number, a string or a boolean. */
  header: Record<string, boolean | number | string>;
  kind: 'envelope';
  source: number;
}

export type ActivityRecord = ICallRecord | IEnvelopeRecord;

/** What the hook says, through the bridge and the background, to the panel. */
export type PageMessage =
  | { sources: ISourceRecord[]; type: 'sources' }
  | {
      /** The records the hook let go since its last batch, past what it holds. */
      dropped: number;
      records: ActivityRecord[];
      type: 'records';
    }
  | { expositions: { source: number; text: string | null }[]; type: 'expositions' };

/** What the panel asks of the hook, through the background and the bridge. */
export type PanelMessage =
  | { type: 'hello' }
  | { type: 'read-expositions' }
  | { type: 'unwatch' }
  | { type: 'watch' };

/** What the background says to a panel of its own: a page's message, or the page came or went. */
export type BackgroundMessage = PageMessage | { type: 'page-connected' } | { type: 'page-gone' };

/** What a panel says first, so the background pairs it with its tab's page. */
export interface IPanelGreeting {
  tabId: number;
  type: 'panel';
}

/** A message on the page's window, between the hook and the bridge. */
export interface IWindowMessage {
  channel: typeof CHANNEL;
  from: 'bridge' | 'hook';
  message: PageMessage | PanelMessage;
}

// constants

/** What marks the extension's messages on a page's window among the page's own. */
export const CHANNEL = 'bead-devtools';

/** The names of the runtime ports: a page's bridge, and a panel. */
export const PORTS = Object.freeze({ page: 'bead-page', panel: 'bead-panel' });

/** The hook's protocols the extension knows. */
export const PROTOCOLS: readonly number[] = Object.freeze([1]);

// helpers

/** Whether `data` is a window message of the extension's, from `from`. */
export const isWindowMessage = (data: unknown, from: IWindowMessage['from']): boolean => {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Partial<IWindowMessage>).channel === CHANNEL &&
    (data as Partial<IWindowMessage>).from === from &&
    typeof (data as Partial<IWindowMessage>).message === 'object'
  );
};
