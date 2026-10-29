// ── DevTools hook, the extension's ────────────────────────────────────────────

// The hook a page's clients announce themselves to (decision 0015), defined in the page's own world
// before its scripts run. It keeps each source, watches them while a panel is open, and posts what
// it hears to the bridge on the window, as plain records, in batches. It is the browser's alike:
// what reaches the extension's own world is the bridge's to carry.

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
  type ISourceRecord,
  type PanelMessage,
  PROTOCOLS,
} from './messages';
import { callRecordOf, envelopeRecordOf, participantRecordOf } from './records';
import { framesOf, type IStackFrame } from './stack';

// interfaces

/** A source the page announced, and what stops its watch while one is under way. */
interface IHeld {
  source: IDevtoolsSource;
  inspection?: ISourceRecord['inspection'];
  stop?: (() => void) | undefined;
}

// constants

/** How long records wait to go together, in milliseconds. */
const BATCH_MILLISECONDS = 100;

/** The records held at most between two batches; past them, a batch says how many it let go. */
const MAXIMUM_HELD = 5_000;

/** The frames a stack is read to, the hook's own among them, past the engine's default of 10. */
const STACK_FRAMES = 40;

// definition

const sources = new Map<number, IHeld>();
let nextId = 1;
let isWatching = false;
let held: ActivityRecord[] = [];
let dropped = 0;
let heldParticipants = 0;
let droppedParticipants = 0;
let batch: ReturnType<typeof setTimeout> | undefined;

const post = (message: PageMessage): void => {
  const data: IWindowMessage = { channel: CHANNEL, from: 'hook', message };

  // the page's own window, at its own origin: '/' names it, an opaque one included, where '*'
  // would reach a document the window navigated to
  window.postMessage(data, '/');
};

const postSources = (): void => {
  post({
    sources: [...sources].map(([id, { source, inspection }]) => {
      return { id, protocol: source.protocol, side: source.side, inspection };
    }),
    type: 'sources',
  });
};

const flush = (): void => {
  const records = held;
  const left = dropped;
  const participantsLeft = droppedParticipants;

  batch = undefined;
  held = [];
  dropped = 0;
  heldParticipants = 0;
  droppedParticipants = 0;
  post({ dropped: left, droppedParticipants: participantsLeft, records, type: 'records' });
};

// a record that cannot be made — a payload whose getter throws, say — is let go, never thrown into
// the client that told it
const hold = (record: () => ActivityRecord, options?: { isParticipant?: boolean }): void => {
  const isParticipant = options?.isParticipant === true;
  const lose = (): void => {
    if (isParticipant) {
      droppedParticipants += 1;
    } else {
      dropped += 1;
    }
  };
  if ((isParticipant ? heldParticipants : held.length - heldParticipants) >= MAXIMUM_HELD) {
    lose();
    return;
  }
  try {
    held.push(record());
    if (isParticipant) {
      heldParticipants += 1;
    }
  } catch {
    lose();
  }
  batch ??= setTimeout(flush, BATCH_MILLISECONDS);
};

/**
 * The stack of the turn it is taken in, read to {@link STACK_FRAMES} frames, the hook's own left
 * out. It runs in the listener a call's `tx` step reaches, in the turn that made the call.
 */
const callerStackOf = (): IStackFrame[] => {
  const { stackTraceLimit } = Error;

  try {
    Error.stackTraceLimit = STACK_FRAMES;

    const frames = framesOf(new Error().stack);
    // * its first frame is this one: where the hook's own script is, read only as a stack is taken
    const own = frames[0]?.url;

    return frames.filter(({ url }) => {
      return url !== own;
    });
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
};

/**
 * When the hook hears something, in milliseconds since the epoch, to a fraction: the page's time
 * origin and its monotonic reading since.
 */
const nowOf = (): number => {
  return performance.timeOrigin + performance.now();
};

const watch = (id: number, entry: IHeld): void => {
  // a protocol the extension does not know is named in the panel, and never watched
  if (entry.stop !== undefined || !PROTOCOLS.includes(entry.source.protocol)) {
    return;
  }

  try {
    entry.inspection = entry.source.inspect?.();
    entry.stop = entry.source.watch({
      participant: (event) => {
        hold(
          () => {
            return participantRecordOf({ at: nowOf(), source: id }, event);
          },
          { isParticipant: true }
        );
      },
      call: (error, event) => {
        hold(() => {
          const record = callRecordOf(id, [error, event]);

          // * a call made, as it goes: its stack is still the caller's, a capture a call while a
          // panel watches, and none while none does
          if (event.direction === 'tx' && event.type === 'request') {
            record.stack = callerStackOf();
          }

          return record;
        });
      },
      envelope: (info) => {
        hold(() => {
          return envelopeRecordOf({ at: nowOf(), source: id }, info);
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

const postParticipants = (): void => {
  const inspections: Extract<PageMessage, { type: 'participants' }>['inspections'] = [];
  for (const [source, entry] of sources) {
    try {
      const inspection = entry.source.inspect?.();
      if (inspection !== undefined) {
        inspections.push({ source, inspection });
      }
    } catch {
      // an unreadable source contributes no reading
    }
  }
  post({ type: 'participants', inspections });
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
      case 'read-participants':
        postParticipants();
        break;
      case 'unwatch':
        isWatching = false;
        sources.forEach(unwatch);
        held = [];
        dropped = 0;
        heldParticipants = 0;
        droppedParticipants = 0;
        if (batch !== undefined) {
          clearTimeout(batch);
          batch = undefined;
        }
        break;
      case 'watch':
        isWatching = true;
        sources.forEach((entry, id) => {
          watch(id, entry);
        });
        postSources();
        break;
    }
  });
}
