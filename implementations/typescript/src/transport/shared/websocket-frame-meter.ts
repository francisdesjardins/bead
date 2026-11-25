// ── WebSocket frame meter ─────────────────────────────────────────────────────

// interfaces

/** A verdict a frame's head draws, and the close code it fails its connection with (spec 15.3). */
export interface IFrameVerdict {
  /**
   * 1002, a head RFC 6455 forbids; 1008, a message past `maximumMessageFrames`; 1009, a message
   * past `maximumMessageBytes`.
   */
  readonly code: 1002 | 1008 | 1009;
  /** What the head broke, in the spec's words. */
  readonly reason: string;
}

/** What one read brought of one message partway (spec 15.12). */
export interface IMessageShare {
  /**
   * What it charges: each payload byte of the message it brought, a control frame's between its
   * frames among them, and each head made whole in it, a control frame's included, its bytes and
   * 128 more at its last byte. A head not yet whole charges nothing, and nothing of what it
   * announces is charged.
   */
  readonly charge: number;
  /** Where in the read it begins. */
  readonly from: number;
  /** Whether the message began in it, at its first frame's first byte. */
  readonly isFirst: boolean;
  /** Whether the message ended in it, at its last frame's last byte. */
  readonly isWhole: boolean;
  /** The payload of its data frames it brought: what the rate counts. */
  readonly payload: number;
}

/** What the meter made of one read. */
export interface IMeteredRead {
  /**
   * The bytes of the read, from its start, the platform's reader is handed: before the frame that
   * drew a verdict, through the peer's close, or all of them.
   */
  readonly handed: number;
  /**
   * The messages partway it brought, in their order: once it drew a verdict, those it brought
   * before the frame that drew it, none of that frame's, whose head is never whole.
   */
  readonly shares: readonly IMessageShare[];
  /** The verdict it drew, at `handed`. */
  readonly verdict: IFrameVerdict | undefined;
}

/** One connection's reader of frame heads, fed every read of its socket before its platform's. */
export interface IFrameMeter {
  /** Whether it reads between two frames: no head and no payload under way. */
  readonly isBetweenFrames: boolean;
  /** Whether it reads no more: it drew a verdict, or read the peer's close. */
  readonly isEnded: boolean;
  /** Whether a message is under way: its first byte read, and its last not yet. */
  readonly isPartway: boolean;
  /** Reads `chunk`: past a verdict, or past the peer's close, it hands nothing more. */
  read(chunk: Uint8Array): IMeteredRead;
}

/** What one meter holds its frames to. */
export interface IFrameMeterOptions {
  /** The sum of a message's announced lengths past which its head fails it with 1009. */
  maximumMessageBytes: number;
  /** The frames of one message past which a head fails it with 1008, a whole number above 0. */
  maximumMessageFrames: number;
  /** Who reads: a server takes masked frames alone, a client unmasked ones alone (RFC 6455 §5.1). */
  side: 'client' | 'server';
}

// types

// a share as a read builds it
type Share = { -readonly [K in keyof IMessageShare]: IMessageShare[K] };

// constants

/**
 * What each frame's head of a message partway charges beside its bytes, at its last byte once whole
 * (spec 15.12): what a side keeps of each frame it holds.
 */
export const HEAD_CHARGE = 128;

// the opcodes RFC 6455 §5.2 defines that a head reads apart
const CONTINUATION = 0x0;
const CLOSE = 0x8;
// a control frame's opcode is 8 or more, a data frame's under it
const CONTROL = 0x8;
// the longest payload of a control frame (RFC 6455 §5.5)
const LONGEST_CONTROL = 125;

// what a read past the meter's end brings: nothing
const NOTHING: IMeteredRead = Object.freeze({
  handed: 0,
  shares: Object.freeze([]),
  verdict: undefined,
});

// helpers

// whether an opcode is one RFC 6455 §5.2 defines: a continuation, text, binary, close, ping, pong
const isDefined = (opcode: number): boolean => {
  return opcode <= 0x2 || (opcode >= CLOSE && opcode <= 0xa);
};

/**
 * When a message is due, on the clock its first byte was read on: from that byte, the longer of
 * `bodyGracePeriod` and what its `payload` takes at `minimumBodyBytesPerSecond` (spec 15.12).
 */
export const rateDueOf = (
  began: number,
  {
    bodyGracePeriod,
    minimumBodyBytesPerSecond,
    payload,
  }: { bodyGracePeriod: number; minimumBodyBytesPerSecond: number; payload: number }
): number => {
  return (
    began + Math.max(bodyGracePeriod, Math.ceil((payload * 1_000) / minimumBodyBytesPerSecond))
  );
};

// definition

/**
 * A reader of one connection's frame heads (RFC 6455 §5.2), each 2 to 14 bytes, split across reads
 * or not, which never unmasks a payload. It judges each head at the byte that draws its verdict
 * (spec 15.3), and tells, of each read, what to hand the platform's reader and what it brought of
 * each message partway (spec 15.12). A length not in its minimal form is taken, as `ws` takes it.
 */
export const createFrameMeter = ({
  maximumMessageBytes,
  maximumMessageFrames,
  side,
}: IFrameMeterOptions): IFrameMeter => {
  const head = new Uint8Array(14);
  const view = new DataView(head.buffer);
  // the head under way: its bytes read, those its length ends at and those it needs, known from its
  // second
  let headLength = 0;
  let lengthEnd = 2;
  let headNeeded = 2;
  let length = 0;
  // the frame under way, once its head is whole: its opcode, its FIN, and its payload still to come
  let opcode = 0;
  let isFinal = false;
  let isInPayload = false;
  let remaining = 0;
  // the message under way: its frames so far, and the sum of their announced lengths
  let isPartway = false;
  let frames = 0;
  let announced = 0;
  // a verdict drawn, or the peer's close read: nothing more is read
  let isDone = false;

  // the verdict of a head's first byte, which tells its kind
  const judgeFirst = (byte: number): IFrameVerdict | undefined => {
    const code = byte & 0x0f;
    const isControl = code >= CONTROL;

    if ((byte & 0x70) !== 0) {
      return { code: 1002, reason: 'a reserved bit set' };
    }

    if (!isDefined(code)) {
      return { code: 1002, reason: `a reserved opcode, ${String(code)}` };
    }

    if (isControl && (byte & 0x80) === 0) {
      return { code: 1002, reason: 'a control frame not final' };
    }

    if (code === CONTINUATION && !isPartway) {
      return { code: 1002, reason: 'a continuation with no message under way' };
    }

    if (!isControl && code !== CONTINUATION && isPartway) {
      return {
        code: 1002,
        reason: 'a data frame that is not a continuation while a message is under way',
      };
    }

    // * every data frame counts, an empty one among them, the first one included
    if (!isControl && (code === CONTINUATION ? frames : 0) + 1 > maximumMessageFrames) {
      return { code: 1008, reason: 'a message past its maximumMessageFrames' };
    }

    return undefined;
  };

  // the verdict of a head's second byte, which tells its mask and its length's form
  const judgeSecond = (byte: number): IFrameVerdict | undefined => {
    const isMasked = (byte & 0x80) !== 0;
    const short = byte & 0x7f;

    if (isMasked !== (side === 'server')) {
      return { code: 1002, reason: side === 'server' ? 'an unmasked frame' : 'a masked frame' };
    }

    if (opcode >= CONTROL && short > LONGEST_CONTROL) {
      return { code: 1002, reason: 'a control frame longer than 125 bytes' };
    }

    lengthEnd = 2 + (short === 126 ? 2 : short === 127 ? 8 : 0);
    headNeeded = lengthEnd + (isMasked ? 4 : 0);

    return undefined;
  };

  // the length a head announces, once its last byte came, its top bit judged already: a 64-bit one
  // read as two halves, since a number holds 53 bits
  const lengthOf = (): number => {
    const short = (head[1] ?? 0) & 0x7f;

    if (short === 126) {
      return view.getUint16(2);
    }

    if (short === 127) {
      return view.getUint32(2) * 0x1_0000_0000 + view.getUint32(6);
    }

    return short;
  };

  const read = (chunk: Uint8Array): IMeteredRead => {
    if (isDone) {
      return NOTHING;
    }

    const shares: Share[] = [];
    let share: Share | undefined;
    let at = 0;
    // ! where the frame under way began in this read: one begun in an earlier read was handed its
    // first bytes already, which its platform's reader acts on no sooner than the meter, which
    // judges each byte of a head before it hands it on
    let frameAt = headLength > 0 || isInPayload ? 0 : -1;
    // the shares this read built before the frame under way: a verdict keeps those alone
    let sharesBefore = 0;

    // the share of the message partway this read brought, from `from`
    const shareAt = (from: number): Share => {
      if (share === undefined) {
        share = { charge: 0, from, isFirst: false, isWhole: false, payload: 0 };
        shares.push(share);
      }

      return share;
    };

    const fail = (verdict: IFrameVerdict): IMeteredRead => {
      isDone = true;

      return { handed: Math.max(frameAt, 0), shares: shares.slice(0, sharesBefore), verdict };
    };

    // the frame's payload came whole: the peer's close ends the read, a final data frame its message
    const endFrame = (): IMeteredRead | undefined => {
      isInPayload = false;

      if (opcode === CLOSE) {
        isDone = true;

        return { handed: at, shares, verdict: undefined };
      }

      if (opcode < CONTROL && isFinal) {
        shareAt(at).isWhole = true;
        isPartway = false;
        share = undefined;
      }

      return undefined;
    };

    while (at < chunk.length) {
      if (isInPayload) {
        const taken = Math.min(remaining, chunk.length - at);

        if (isPartway) {
          const charged = shareAt(at);

          charged.charge += taken;
          charged.payload += opcode < CONTROL ? taken : 0;
        }

        remaining -= taken;
        at += taken;

        const ended = remaining === 0 ? endFrame() : undefined;

        if (ended !== undefined) {
          return ended;
        }

        continue;
      }

      const byte = chunk[at] ?? 0;

      if (headLength === 0) {
        frameAt = at;
        sharesBefore = shares.length;
      }

      head[headLength] = byte;
      headLength += 1;
      at += 1;

      if (headLength === 1) {
        const verdict = judgeFirst(byte);

        if (verdict !== undefined) {
          return fail(verdict);
        }

        opcode = byte & 0x0f;
        isFinal = (byte & 0x80) !== 0;

        if (opcode < CONTROL) {
          // * a message begins at its first frame's first byte
          if (opcode !== CONTINUATION) {
            isPartway = true;
            frames = 0;
            announced = 0;
            share = undefined;
            shareAt(frameAt).isFirst = true;
          }

          frames += 1;
        }
      } else if (headLength === 2) {
        const verdict = judgeSecond(byte);

        if (verdict !== undefined) {
          return fail(verdict);
        }
      }

      // ! a 64-bit length's top bit is judged at that length's first byte, the head's third, which
      // breaks its head (RFC 6455 §5.2)
      if (headLength === 3 && lengthEnd === 10 && (byte & 0x80) !== 0) {
        return fail({ code: 1002, reason: 'a 64-bit length with its top bit set' });
      }

      // * judged at its length's last byte, before its mask, as `ws` reads it: a continuation's among
      // them, without waiting for its payload
      if (headLength === lengthEnd) {
        length = lengthOf();
        announced += opcode < CONTROL ? length : 0;

        if (announced > maximumMessageBytes) {
          return fail({ code: 1009, reason: 'a message past its maximumMessageBytes' });
        }
      }

      // * a head of a message partway is its share's from its first byte here, and charges once
      // whole, its bytes, those an earlier read brought among them, and 128 at its last byte
      if (isPartway) {
        shareAt(at - 1);
      }

      if (headLength === headNeeded) {
        if (isPartway) {
          shareAt(at).charge += headNeeded + HEAD_CHARGE;
        }

        headLength = 0;
        lengthEnd = 2;
        headNeeded = 2;
        isInPayload = true;
        remaining = length;

        const ended = remaining === 0 ? endFrame() : undefined;

        if (ended !== undefined) {
          return ended;
        }
      }
    }

    return { handed: chunk.length, shares, verdict: undefined };
  };

  return {
    get isBetweenFrames() {
      return headLength === 0 && !isInPayload;
    },
    get isEnded() {
      return isDone;
    },
    get isPartway() {
      return isPartway;
    },
    read,
  };
};
