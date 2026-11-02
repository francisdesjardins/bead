// ── Hold ──────────────────────────────────────────────────────────────────────

// interfaces

/**
 * What a transport holds of one connection its router paused (spec 15.12, decision 0046): what it
 * received meanwhile, in order, handed on once resumed.
 */
export interface IHold<Message> {
  /** Whether its router paused it. */
  readonly isPaused: boolean;
  /** The messages it holds. */
  readonly size: number;

  /**
   * Lets go of what it holds, its connection gone, and gives it, in order: a release under way
   * hands nothing of it. A pause outlasts it, until a resume.
   */
  drop(): Message[];
  /**
   * A message received: handed on at once, or, while paused or holding anything, held behind what
   * it holds, so nothing overtakes what is held.
   */
  offer(message: Message): void;
  /** Holds what comes from now on. Idempotent, it hands nothing within it. */
  pause(): void;
  /**
   * Hands on what it holds, in order, from a microtask, never within this call, asking before each
   * whether it was paused again. Idempotent.
   */
  resume(): void;
}

/** What a hold calls beside handing each message on. */
export interface IHoldOptions {
  /**
   * Its release ended with nothing held and no pause: a transport that paused its socket resumes
   * it then, so what the socket still brings comes behind what was held.
   */
  onReleased?: (() => void) | undefined;
}

// definition

/**
 * A hold of one connection's messages, each handed on by `hand` (spec 15.12): at once while it is
 * neither paused nor holding anything; held, in order, otherwise, and handed on once resumed, from
 * a microtask, each after asking whether `hand` paused it again, which its router does within it at
 * a bound. What a transport whose peer is its application's own code holds is bounded by nothing:
 * that code is its sender.
 */
export const createHold = <Message>(
  hand: (message: Message) => void,
  options?: IHoldOptions
): IHold<Message> => {
  const held: Message[] = [];
  let isPaused = false;
  // a release queued, which what comes meanwhile waits for, behind what is held
  let isReleasing = false;

  const release = (): void => {
    isReleasing = false;

    while (!isPaused && held.length > 0) {
      // ! taken before it is handed, so a hand that drops the hold leaves nothing behind it
      hand(held.shift() as Message);
    }

    if (!isPaused && held.length === 0) {
      options?.onReleased?.();
    }
  };

  return {
    get isPaused() {
      return isPaused;
    },
    get size() {
      return held.length;
    },

    drop: () => {
      return held.splice(0);
    },
    offer: (message) => {
      if (isPaused || held.length > 0 || isReleasing) {
        return (held.push(message), undefined);
      }

      hand(message);
    },
    pause: () => {
      isPaused = true;
    },
    resume: () => {
      isPaused = false;

      if (isReleasing) {
        return;
      }

      isReleasing = true;
      queueMicrotask(release);
    },
  };
};
