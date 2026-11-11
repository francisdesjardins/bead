// ── MQTT packet guard ─────────────────────────────────────────────────────────

// interfaces

/** A stream whose received bytes come through its own `push`, as a Node `Readable`'s do. */
export interface IGuardedStream {
  push(chunk: Uint8Array | null, encoding?: string): boolean;
}

export interface IPacketGuardOptions {
  /** The largest packet it lets through, in bytes: its participant's own Maximum Packet Size. */
  maximumPacketSize: number;
  /** Told once, with the size of the first packet past `maximumPacketSize`. */
  onPastMaximum: (size: number) => void;
}

// constants

// a Remaining Length's digits, seven bits each, low first, under a continuation bit
const CONTINUES = 0x80;
const DIGIT = 0x7f;
const RADIX = 128;
const LONGEST_LENGTH = 4;

// definition

/**
 * `stream`, each packet it receives judged at its fixed header's Remaining Length, before any byte
 * of its body, its size counted `1 + v(R) + R` as spec 15.30 counts one: one past
 * `maximumPacketSize`, of whatever kind, hands on only what came before its first byte in that
 * read, tells `onPastMaximum` its size, and drops every later chunk, so that nothing of it reaches
 * the library, which never awaits the body it announced (spec 15.29). One within it passes
 * untouched, in the chunks it came in. A Remaining Length still continuing at its fourth byte is
 * malformed, and left to the library, which refuses it: nothing more is judged on that stream.
 * It holds no byte, arms no timer and writes nothing; its end, `push(null)`, always passes.
 */
export const guardPacketSize = (stream: IGuardedStream, options: IPacketGuardOptions): void => {
  const { maximumPacketSize, onPastMaximum } = options;
  const push = stream.push.bind(stream);
  // * MQTT 5.0 §2.1.4: a first byte, then a Remaining Length of one to four bytes (§1.5.5), then
  // that many bytes
  let header = 0;
  let length = 0;
  // the bytes of a body still to pass
  let body = 0;
  let isTripped = false;
  let isJudging = true;

  // ! every stream MQTT.js builds feeds what it receives through its own `push` (`net.Socket`,
  // `TLSSocket`, `ws`'s duplex, the browser's `BufferedDuplex` or its proxy): a bump of MQTT.js
  // re-reads its stream builders
  stream.push = (chunk, encoding) => {
    if (chunk === null) {
      return push(null);
    }

    if (isTripped) {
      return false;
    }

    if (!isJudging) {
      return push(chunk, encoding);
    }

    // where, in this chunk, the packet whose fixed header is read began
    let start = 0;
    let at = 0;

    while (at < chunk.length) {
      if (body > 0) {
        const passed = Math.min(body, chunk.length - at);

        at += passed;
        body -= passed;
      } else if (header === 0) {
        start = at;
        header = 1;
        length = 0;
        at += 1;
      } else {
        const digit = chunk[at] ?? 0;

        at += 1;
        length += (digit & DIGIT) * RADIX ** (header - 1);
        header += 1;

        if ((digit & CONTINUES) !== 0) {
          // its first byte, then its digits
          if (header - 1 === LONGEST_LENGTH) {
            isJudging = false;

            return push(chunk, encoding);
          }
        } else {
          const size = header + length;

          header = 0;

          if (size > maximumPacketSize) {
            isTripped = true;

            if (start > 0) {
              push(chunk.subarray(0, start), encoding);
            }

            onPastMaximum(size);

            return false;
          }

          body = length;
        }
      }
    }

    return push(chunk, encoding);
  };
};
