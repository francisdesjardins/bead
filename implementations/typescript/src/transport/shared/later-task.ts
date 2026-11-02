// ── Later task ────────────────────────────────────────────────────────────────

// definition

/**
 * Runs `task` in a later task of the event loop, once the loop turned: by `setImmediate` where the
 * platform has it, Node's, after the I/O of its poll; by a `MessageChannel`'s message in a page.
 * Never a microtask, which runs before the loop turns, and never a timer, which Node holds to 1 ms
 * at least: what one task handed is released no sooner than the side could take another
 * connection's (spec 15.12, decision 0046). Returns what cancels it, which does nothing once it ran.
 *
 * @example
 * const cancel = laterTask(() => {
 *   counts.clear();
 * });
 */
export const laterTask = (task: () => void): (() => void) => {
  if (typeof globalThis.setImmediate === 'function') {
    const immediate = globalThis.setImmediate(task);

    return () => {
      globalThis.clearImmediate(immediate);
    };
  }

  const channel = new MessageChannel();
  let isCancelled = false;

  // ! each port closed once it ran or was cancelled: an open port keeps its page's channel alive
  const close = (): void => {
    channel.port1.close();
    channel.port2.close();
  };

  channel.port1.onmessage = () => {
    close();

    if (!isCancelled) {
      task();
    }
  };
  channel.port2.postMessage(undefined);

  return () => {
    if (!isCancelled) {
      isCancelled = true;
      close();
    }
  };
};

/** Resolves in a later task, as {@link laterTask} runs one: what a test awaits to see a task end. */
export const nextTask = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();

  laterTask(() => {
    resolve();
  });

  return promise;
};
