// ── Broker parcel ─────────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from './errors';

// interfaces

/**
 * A parcel's first 28 bytes, which every layout keeps (spec 15.17): its layout, its kind, its
 * opener's half and its acceptor's, and its sequence.
 */
export interface IParcelPrefix {
  readonly acceptor: Uint8Array;
  readonly kind: number;
  readonly layout: number;
  readonly opener: Uint8Array;
  /** As its 8 bytes say; past 2⁵³ − 1 it reads as no number holds it, and the parcel does not read. */
  readonly sequence: number;
}

/**
 * A parcel by its fields (spec 15.17): its prefix, its flags, and its body's fields, those its kind
 * has alone. A parcel of a layout to come is read to its prefix — an OPEN's to its id as well, a
 * REFUSE whole — and an advisory one to its prefix: neither has its flags read.
 */
export interface IParcel extends IParcelPrefix {
  /** A PONG's: the sequence of the PING it answers. */
  readonly answers?: number | undefined;
  /** An OPEN's and an ACCEPT's: the largest parcel its sender's inbox takes whole. */
  readonly bound?: number | undefined;
  /** A DATA's: the envelope it carries, or the part of one. */
  readonly carried?: Uint8Array | undefined;
  /** A CLOSE's: a WebSocket's code (RFC 6455 §7.4.1). */
  readonly code?: number | undefined;
  /** A DATA's marked `CREDENTIAL`: the credential beside its request, a character a byte. */
  readonly credential?: string | undefined;
  readonly flags?: number | undefined;
  /** An OPEN's, an ACCEPT's and a GONE's: its participant's id, a character a byte. */
  readonly id?: string | undefined;
  /** An OPEN's, an ACCEPT's and a GONE's: its participant's incarnation, 16 bytes. */
  readonly incarnation?: Uint8Array | undefined;
  /** A REFUSE's of 426: the layouts its sender reads. */
  readonly layouts?: readonly number[] | undefined;
  /** A REFUSE's: 400, 426 or 503. */
  readonly status?: number | undefined;
}

// types

/**
 * What a message reads as: a parcel; no parcel, under 28 bytes or of a first byte outside
 * 0xB1–0xBF, which a side drops and reports; or a parcel that does not read, its prefix kept, which
 * closes its connection with 1002 (spec 15.17).
 */
export type ParcelRead =
  | { readonly parcel: IParcel }
  | { readonly reason: string; readonly refused: 'no-parcel' }
  | { readonly prefix: IParcelPrefix; readonly reason: string; readonly refused: 'does-not-read' };

/** A parcel to write: its layout this side's, `0xB1`, whether named or not. */
export type ParcelFields = Omit<IParcel, 'layout'> & { readonly layout?: number | undefined };

// constants

/** The layout of every parcel this side writes, `0xB1`; `0xB2` to `0xBF` are the layouts to come. */
export const PARCEL_LAYOUT = 0xb1;

/** The last layout to come a parcel's first byte may name. */
export const LAST_PARCEL_LAYOUT = 0xbf;

/** The bytes every layout keeps: a parcel's prefix, before its body. */
export const PARCEL_PREFIX_BYTES = 28;

/** A half's bytes: what each end of a connection draws. */
export const HALF_BYTES = 8;

/** An incarnation's bytes: what a participant draws each time its link connects. */
export const INCARNATION_BYTES = 16;

/** The least receive bound an OPEN or an ACCEPT may announce (spec 15.18). */
export const LEAST_RECEIVE_BOUND = 1_024;

/** The largest receive bound a parcel's field holds. */
export const LARGEST_RECEIVE_BOUND = 0xff_ff_ff_ff;

/** The parcels' kinds (spec 15.17): 0x0A to 0x7F are kinds to come, 0x80 to 0xFF advisory. */
export const ParcelKind = Object.freeze({
  OPEN: 0x01,
  ACCEPT: 0x02,
  REFUSE: 0x03,
  DATA: 0x04,
  PING: 0x05,
  PONG: 0x06,
  CLOSE: 0x07,
  RESET: 0x08,
  GONE: 0x09,
});

/** The first advisory kind: one is taken in its order and skipped. */
export const FIRST_ADVISORY_KIND = 0x80;

/** A parcel's flags: `MORE` and `CREDENTIAL` on a DATA, `SECURE` on an OPEN and an ACCEPT. */
export const ParcelFlag = Object.freeze({
  MORE: 0x01,
  CREDENTIAL: 0x02,
  SECURE: 0x04,
});

/** A REFUSE's statuses, each with the reason it is told by (spec 15.18). */
export const REFUSE_REASONS: Readonly<Record<number, string>> = Object.freeze({
  400: 'malformed',
  426: 'layout-refused',
  503: 'busy',
});

/** A CLOSE's codes, a WebSocket's (RFC 6455 §7.4.1), 4000 and 4001 of its private range. */
export const CloseCode = Object.freeze({
  NORMAL: 1_000,
  GOING_AWAY: 1_001,
  PROTOCOL_ERROR: 1_002,
  TOO_BIG: 1_009,
  LOST: 4_000,
  UNANSWERED: 4_001,
});

const CLOSE_CODES: ReadonlySet<number> = new Set(Object.values(CloseCode));

/** Each kind's name, as a report writes it. */
export const KIND_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [ParcelKind.OPEN]: 'OPEN',
  [ParcelKind.ACCEPT]: 'ACCEPT',
  [ParcelKind.REFUSE]: 'REFUSE',
  [ParcelKind.DATA]: 'DATA',
  [ParcelKind.PING]: 'PING',
  [ParcelKind.PONG]: 'PONG',
  [ParcelKind.CLOSE]: 'CLOSE',
  [ParcelKind.RESET]: 'RESET',
  [ParcelKind.GONE]: 'GONE',
});

// the flags each kind takes
const FLAGS_TAKEN: Readonly<Record<number, number>> = Object.freeze({
  [ParcelKind.OPEN]: ParcelFlag.SECURE,
  [ParcelKind.ACCEPT]: ParcelFlag.SECURE,
  [ParcelKind.DATA]: ParcelFlag.MORE | ParcelFlag.CREDENTIAL,
});

// a topic's token (spec 15.16): 1 to 64 characters of base64url's alphabet (RFC 4648 §5)
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/u;

const TWO_32 = 2 ** 32;

// helpers

/** Whether `id` is a token, as a participant's id and a server's name are (spec 15.16). */
export const isToken = (id: string): boolean => {
  return TOKEN.test(id);
};

/** Whether `bytes` are all zero: a half or an incarnation that names none. */
export const isZero = (bytes: Uint8Array): boolean => {
  return bytes.every((byte) => {
    return byte === 0;
  });
};

/** Whether `kind` is one to come: a parcel of one, taken in its order, closes its connection. */
export const isKindToCome = (kind: number): boolean => {
  return kind > ParcelKind.GONE && kind < FIRST_ADVISORY_KIND;
};

/** A string a character a byte, as an id and a credential are written. */
const latin1Of = (bytes: Uint8Array): string => {
  return String.fromCharCode(...bytes);
};

/** The bytes of a string a character a byte; a character past U+00FF is a {@link ProgrammerError}. */
const bytesOfLatin1 = (text: string, what: string): Uint8Array => {
  return Uint8Array.from(text, (character) => {
    const code = character.charCodeAt(0);

    if (code > 0xff) {
      throw new ProgrammerError(
        `${what} is written a character a byte, not ${JSON.stringify(text)}`
      );
    }

    return code;
  });
};

// reads a parcel's body, each field in its order, refusing what runs past its bytes
const createBodyReader = (body: Uint8Array) => {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 0;

  const take = (length: number): Uint8Array | undefined => {
    if (at + length > body.length) {
      return undefined;
    }

    const taken = body.slice(at, at + length);

    at += length;

    return taken;
  };

  return {
    get isDone() {
      return at === body.length;
    },
    get left() {
      return body.length - at;
    },
    rest: (): Uint8Array => {
      return take(body.length - at) ?? new Uint8Array();
    },
    take,
    u8: (): number | undefined => {
      return at + 1 > body.length ? undefined : view.getUint8((at += 1) - 1);
    },
    u16: (): number | undefined => {
      return at + 2 > body.length ? undefined : view.getUint16((at += 2) - 2);
    },
    u32: (): number | undefined => {
      return at + 4 > body.length ? undefined : view.getUint32((at += 4) - 4);
    },
    u64: (): number | undefined => {
      if (at + 8 > body.length) {
        return undefined;
      }

      const high = view.getUint32(at);
      const low = view.getUint32(at + 4);

      at += 8;

      return high * TWO_32 + low;
    },
  };
};

type BodyReader = ReturnType<typeof createBodyReader>;

// an OPEN's or an ACCEPT's id, incarnation and bound; a GONE's incarnation and id
const idOf = (reader: BodyReader): string | undefined => {
  const length = reader.u8();
  const id = length === undefined ? undefined : reader.take(length);

  return id === undefined ? undefined : latin1Of(id);
};

// what a body holds, by kind, or why it does not read as its kind's
const bodyOf = (
  kind: number,
  { body, flags }: { body: Uint8Array; flags: number }
): Partial<IParcel> | string => {
  const reader = createBodyReader(body);
  const exact = (fields: Partial<IParcel>): Partial<IParcel> | string => {
    return reader.isDone ? fields : 'a body longer than its kind’s';
  };

  switch (kind) {
    case ParcelKind.OPEN:
    case ParcelKind.ACCEPT: {
      const id = idOf(reader);
      const incarnation = reader.take(INCARNATION_BYTES);
      const bound = reader.u32();

      if (id === undefined || incarnation === undefined || bound === undefined) {
        return 'a body shorter than its kind’s';
      }

      // an OPEN's id that is no token, or its bound under 1,024, is its acceptor's to refuse, 400
      // (spec 15.18); an ACCEPT's does not read
      if (kind === ParcelKind.ACCEPT && !isToken(id)) {
        return 'an id that is no token';
      }

      if (kind === ParcelKind.ACCEPT && bound < LEAST_RECEIVE_BOUND) {
        return 'a receive bound under 1,024 bytes';
      }

      return exact({ bound, id, incarnation });
    }
    case ParcelKind.REFUSE: {
      const status = reader.u16();

      if (status === undefined || REFUSE_REASONS[status] === undefined) {
        return 'a status a REFUSE does not name';
      }

      if (status !== 426) {
        return exact({ status });
      }

      const layouts = [...reader.rest()];
      const isLayout = layouts.every((layout) => {
        return layout >= PARCEL_LAYOUT && layout <= LAST_PARCEL_LAYOUT;
      });

      return layouts.length > 0 && isLayout
        ? { layouts, status }
        : 'a 426 that names no layout it reads';
    }
    case ParcelKind.DATA: {
      let credential: string | undefined;

      if ((flags & ParcelFlag.CREDENTIAL) !== 0) {
        const length = reader.u16();
        const bytes = length === undefined || length === 0 ? undefined : reader.take(length);

        if (bytes === undefined) {
          return 'a credential that runs past its bytes, or is empty';
        }

        credential = latin1Of(bytes);
      }

      if (reader.left === 0) {
        return 'a DATA that carries nothing';
      }

      const carried = reader.rest();

      return credential === undefined ? { carried } : { carried, credential };
    }
    case ParcelKind.PONG: {
      const answers = reader.u64();

      return answers === undefined || answers > Number.MAX_SAFE_INTEGER
        ? 'a PONG that answers no sequence'
        : exact({ answers });
    }
    case ParcelKind.CLOSE: {
      const code = reader.u16();

      return code === undefined || !CLOSE_CODES.has(code)
        ? 'a code a CLOSE does not name'
        : exact({ code });
    }
    case ParcelKind.GONE: {
      const incarnation = reader.take(INCARNATION_BYTES);
      const id = idOf(reader);

      if (incarnation === undefined || id === undefined) {
        return 'a body shorter than its kind’s';
      }

      return isToken(id) ? exact({ id, incarnation }) : 'an id that is no token';
    }
    default:
      // a PING and a RESET carry none
      return exact({});
  }
};

// why a prefix of layout 0xB1 does not read as its kind's, or nothing
const prefixFaultOf = ({ kind, opener, acceptor, sequence }: IParcelPrefix): string | undefined => {
  if (sequence > Number.MAX_SAFE_INTEGER) {
    return 'a sequence past 2⁵³ − 1';
  }

  const isUnsequenced = kind === ParcelKind.RESET || kind === ParcelKind.GONE;

  if (isUnsequenced !== (sequence === 0)) {
    return isUnsequenced ? `a ${KIND_NAMES[kind]} with a sequence` : 'a sequence of 0';
  }

  if (kind === ParcelKind.GONE) {
    return isZero(opener) && isZero(acceptor) ? undefined : 'a GONE naming a half';
  }

  if (isZero(opener)) {
    return "an opener's half all zero";
  }

  const namesNoAcceptor = kind === ParcelKind.OPEN || kind === ParcelKind.REFUSE;

  if (namesNoAcceptor !== isZero(acceptor)) {
    return namesNoAcceptor
      ? "an acceptor's half where it names none"
      : "an acceptor's half all zero";
  }

  return undefined;
};

// a parcel of a layout to come, read as every layout keeps it: its prefix, an OPEN's id, a
// REFUSE whole
const readOfLayoutToCome = (prefix: IParcelPrefix, bytes: Uint8Array): ParcelRead => {
  const body = bytes.subarray(PARCEL_PREFIX_BYTES);

  if (prefix.kind === ParcelKind.OPEN) {
    const id = idOf(createBodyReader(body));

    return id === undefined
      ? { prefix, reason: 'an OPEN whose id runs past its bytes', refused: 'does-not-read' }
      : { parcel: { ...prefix, id } };
  }

  if (prefix.kind !== ParcelKind.REFUSE) {
    return { parcel: prefix };
  }

  const read = readOfLayout(
    { ...prefix, layout: PARCEL_LAYOUT },
    { body, flags: bytes[2] ?? 0, kept: bytes[3] ?? 0 }
  );

  return 'parcel' in read ? { parcel: { ...read.parcel, layout: prefix.layout } } : read;
};

// a parcel of layout 0xB1, read whole
const readOfLayout = (
  prefix: IParcelPrefix,
  { body, flags, kept }: { body: Uint8Array; flags: number; kept: number }
): ParcelRead => {
  const { kind } = prefix;
  const refused = (reason: string): ParcelRead => {
    return { prefix, reason, refused: 'does-not-read' };
  };

  if (kind >= FIRST_ADVISORY_KIND) {
    // * whatever its flags, its kept byte and its body: taken in its order, and skipped
    return prefix.sequence === 0 || prefix.sequence > Number.MAX_SAFE_INTEGER
      ? refused('an advisory parcel with no sequence')
      : { parcel: prefix };
  }

  if (kind === 0 || isKindToCome(kind)) {
    return refused(
      kind === 0 ? 'a kind of 0x00, never one' : `a kind to come, 0x${kind.toString(16)}`
    );
  }

  if ((flags & ~(FLAGS_TAKEN[kind] ?? 0)) !== 0) {
    return refused(`a flag a ${KIND_NAMES[kind] ?? 'parcel'} does not take`);
  }

  if (kept !== 0) {
    return refused('a kept byte that is not 0');
  }

  const fault = prefixFaultOf(prefix);

  if (fault !== undefined) {
    return refused(fault);
  }

  const fields = bodyOf(kind, { body, flags });

  return typeof fields === 'string' ? refused(fields) : { parcel: { ...prefix, flags, ...fields } };
};

/**
 * Reads a message as a parcel (spec 15.17): no parcel, under 28 bytes or of a first byte outside
 * 0xB1–0xBF; a parcel of a layout to come, to what every layout keeps of it; or a parcel of layout
 * 0xB1, whole, or why it does not read, its prefix kept.
 */
export const readParcel = (bytes: Uint8Array): ParcelRead => {
  const layout = bytes[0];

  if (bytes.length < PARCEL_PREFIX_BYTES) {
    return { reason: `${String(bytes.length)} bytes, under a parcel's 28`, refused: 'no-parcel' };
  }

  if (layout === undefined || layout < PARCEL_LAYOUT || layout > LAST_PARCEL_LAYOUT) {
    return {
      reason: `a first byte of 0x${(layout ?? 0).toString(16)}, outside 0xb1 to 0xbf`,
      refused: 'no-parcel',
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix: IParcelPrefix = {
    acceptor: bytes.slice(12, 20),
    kind: view.getUint8(1),
    layout,
    opener: bytes.slice(4, 12),
    sequence: view.getUint32(20) * TWO_32 + view.getUint32(24),
  };

  if (layout !== PARCEL_LAYOUT) {
    return readOfLayoutToCome(prefix, bytes);
  }

  return readOfLayout(prefix, {
    body: bytes.subarray(PARCEL_PREFIX_BYTES),
    flags: view.getUint8(2),
    kept: view.getUint8(3),
  });
};

// a u64 in network order, as a sequence is written
const u64Of = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, Math.floor(value / TWO_32));
  view.setUint32(4, value % TWO_32);

  return bytes;
};

// the body a parcel's fields write, by kind
const bodyBytesOf = (fields: ParcelFields): Uint8Array[] => {
  const { kind } = fields;
  const u16 = (value: number): Uint8Array => {
    return Uint8Array.of(value >>> 8, value & 0xff);
  };
  const u32 = (value: number): Uint8Array => {
    const bytes = new Uint8Array(4);

    new DataView(bytes.buffer).setUint32(0, value);

    return bytes;
  };
  const idBytes = (): Uint8Array[] => {
    const id = bytesOfLatin1(fields.id ?? '', 'an id');

    return [Uint8Array.of(id.length), id];
  };

  switch (kind) {
    case ParcelKind.OPEN:
    case ParcelKind.ACCEPT:
      return [...idBytes(), fields.incarnation ?? new Uint8Array(), u32(fields.bound ?? 0)];
    case ParcelKind.REFUSE:
      return [u16(fields.status ?? 0), Uint8Array.from(fields.layouts ?? [])];
    case ParcelKind.DATA: {
      const carried = fields.carried ?? new Uint8Array();

      if (fields.credential === undefined) {
        return [carried];
      }

      const credential = bytesOfLatin1(fields.credential, 'a credential');

      return [u16(credential.length), credential, carried];
    }
    case ParcelKind.PONG:
      return [u64Of(fields.answers ?? 0)];
    case ParcelKind.CLOSE:
      return [u16(fields.code ?? 0)];
    case ParcelKind.GONE:
      return [fields.incarnation ?? new Uint8Array(), ...idBytes()];
    default:
      return [];
  }
};

/**
 * A parcel's bytes, by its fields, held to nothing but its halves' length: what a test's own peer
 * writes, a parcel a side refuses among them; {@link writeParcel} holds what a side sends.
 * @internal
 */
export const encodeParcel = (fields: ParcelFields): Uint8Array => {
  const { acceptor, kind, layout = PARCEL_LAYOUT, opener, sequence } = fields;

  if (opener.length !== HALF_BYTES || acceptor.length !== HALF_BYTES) {
    throw new ProgrammerError('a half is 8 bytes');
  }

  const flags =
    (fields.flags ?? 0) |
    (kind === ParcelKind.DATA && fields.credential !== undefined ? ParcelFlag.CREDENTIAL : 0);
  const body = bodyBytesOf(fields);
  const length = body.reduce((total, part) => {
    return total + part.length;
  }, PARCEL_PREFIX_BYTES);
  const bytes = new Uint8Array(length);

  bytes.set([layout, kind, flags, 0], 0);
  bytes.set(opener, 4);
  bytes.set(acceptor, 12);
  bytes.set(u64Of(sequence), 20);

  let at = PARCEL_PREFIX_BYTES;

  for (const part of body) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

/**
 * Writes a parcel of layout 0xB1 from its fields (spec 15.17): its flags those given, `MORE` and
 * `CREDENTIAL` on a DATA, a credential beside its `carried` when one is given. No parcel is written
 * that a side refuses: one that would not read back, an advisory kind, a kind to come, a layout
 * other than 0xB1, or an OPEN its acceptor refuses 400 (spec 15.18) is a {@link ProgrammerError}.
 */
export const writeParcel = (fields: ParcelFields): Uint8Array => {
  const { bound = 0, id = '', kind, layout = PARCEL_LAYOUT } = fields;

  if (layout !== PARCEL_LAYOUT || KIND_NAMES[kind] === undefined) {
    throw new ProgrammerError(
      `a parcel written is of layout 0xb1 and of a kind from 1 to 9, not ${String(layout)} and ${String(kind)}`
    );
  }

  if (
    (kind === ParcelKind.OPEN || kind === ParcelKind.ACCEPT) &&
    (!isToken(id) || bound < LEAST_RECEIVE_BOUND)
  ) {
    throw new ProgrammerError(
      `an ${KIND_NAMES[kind]} names a token and a receive bound of 1,024 bytes at least`
    );
  }

  const bytes = encodeParcel(fields);
  const read = readParcel(bytes);

  if (!('parcel' in read)) {
    throw new ProgrammerError(`a parcel that would not read: ${read.reason}`);
  }

  return bytes;
};
