// ── DevTools hook, the extension's ────────────────────────────────────────────

// The hook a page's clients announce themselves to (decision 0015), defined in the page's own world
// before its scripts run. It keeps each source, watches them while a panel is open, and posts what
// it hears to the bridge on the window, as plain records, in batches.

// dependencies

import {
  DEVTOOLS_HOOK_KEY,
  type IDevtoolsHook,
  type IDevtoolsSource,
} from '../src/client/devtools-hook';
import {
  type ActivityRecord,
  CHANNEL,
  isWindowMessage,
  type IWindowMessage,
  type PageMessage,
  type PanelMessage,
  PROTOCOLS,
} from './messages';
import { callRecordOf, envelopeRecordOf } from './records';

// interfaces

/** A source the page announced, and what stops its watch while one is under way. */
interface IHeld {
  source: IDevtoolsSource;
  stop?: (() => void) | undefined;
}

// constants

/** How long records wait to go together, in milliseconds. */
const BATCH_MILLISECONDS = 100;

/** The records held at most between two batches; past them, a batch says how many it let go. */
const MAXIMUM_HELD = 5_000;

// definition

const sources = new Map<number, IHeld>();
let nextId = 1;
let isWatching = false;
let held: ActivityRecord[] = [];
let dropped = 0;
let batch: ReturnType<typeof setTimeout> | undefined;

const post = (message: PageMessage): void => {
  const data: IWindowMessage = { channel: CHANNEL, from: 'hook', message };

  window.postMessage(data, '*');
};

const postSources = (): void => {
  post({
    sources: [...sources].map(([id, { source }]) => {
      return { id, protocol: source.protocol, side: source.side };
    }),
    type: 'sources',
  });
};

const flush = (): void => {
  const records = held;
  const left = dropped;

  batch = undefined;
  held = [];
  dropped = 0;
  post({ dropped: left, records, type: 'records' });
};

// a record that cannot be made — a payload whose getter throws, say — is let go, never thrown into
// the client that told it
const hold = (record: () => ActivityRecord): void => {
  if (held.length >= MAXIMUM_HELD) {
    dropped += 1;

    return;
  }

  try {
    held.push(record());
  } catch {
    dropped += 1;
  }

  batch ??= setTimeout(flush, BATCH_MILLISECONDS);
};

const watch = (id: number, entry: IHeld): void => {
  // a protocol the extension does not know is named in the panel, and never watched
  if (entry.stop !== undefined || !PROTOCOLS.includes(entry.source.protocol)) {
    return;
  }

  try {
    entry.stop = entry.source.watch({
      call: (error, event) => {
        hold(() => {
          return callRecordOf(id, [error, event]);
        });
      },
      envelope: (info) => {
        hold(() => {
          return envelopeRecordOf({ at: Date.now(), source: id }, info);
        });
      },
    });
  } catch {
    entry.stop = undefined;
  }
};

const unwatch = (entry: IHeld): void => {
  const { stop } = entry;

  entry.stop = undefined;

  try {
    stop?.();
  } catch {
    // a source that throws as its watch stops is stopped all the same
  }
};

const postExpositions = (): void => {
  post({
    expositions: [...sources].map(([id, { source }]) => {
      try {
        return { source: id, text: source.exposition()?.text ?? null };
      } catch {
        return { source: id, text: null };
      }
    }),
    type: 'expositions',
  });
};

const hook: IDevtoolsHook = Object.freeze({
  register: (source: IDevtoolsSource) => {
    const id = nextId;
    const entry: IHeld = { source };

    nextId += 1;
    sources.set(id, entry);

    if (isWatching) {
      watch(id, entry);
    }

    postSources();

    return () => {
      if (sources.get(id) === entry) {
        unwatch(entry);
        sources.delete(id);
        postSources();
      }
    };
  },
});

// one hook a page: one already there, another extension's or the page's own, is left as it is
if (!(DEVTOOLS_HOOK_KEY in globalThis)) {
  Object.defineProperty(globalThis, DEVTOOLS_HOOK_KEY, {
    configurable: true,
    enumerable: false,
    value: hook,
    writable: false,
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !isWindowMessage(event.data, 'bridge')) {
      return;
    }

    // the bridge says what the panel asks, and nothing else
    const message = (event.data as IWindowMessage).message as PanelMessage;

    switch (message.type) {
      case 'hello':
        postSources();
        break;
      case 'read-expositions':
        postExpositions();
        break;
      case 'unwatch':
        isWatching = false;
        sources.forEach(unwatch);
        held = [];
        dropped = 0;
        break;
      case 'watch':
        isWatching = true;
        sources.forEach((entry, id) => {
          watch(id, entry);
        });
        break;
    }
  });
}
