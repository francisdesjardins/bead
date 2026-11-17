// ── MQTT packet guard ─────────────────────────────────────────────────────────

// dependencies

import {
  ACKNOWLEDGEMENT_TYPES,
  ACKNOWLEDGEMENT_VERDICTS,
  type AcknowledgementType,
  acknowledgementVerdictOf,
} from './mqtt-packets';

// interfaces

/** A stream whose received bytes come through its own `push`, as a Node `Readable`'s do. */
export interface IGuardedStream {
  push(chunk: Uint8Array | null, encoding?: string): boolean;
}

/** An acknowledgement of a Reason Code of 0x80 or more that its table does not name. */
export interface IAcknowledgementRefusal {
  /** Its broker's own Reason Code, which the library reads as 0x80. */
  code: number;
  /** Its Packet Identifier. */
  identifier: number;
  /** Its packet type: 4, a PUBACK; 9, a SUBACK; 11, an UNSUBACK. */
  type: AcknowledgementType;
}

export interface IPacketGuardOptions {
  /** The largest packet it lets through, in bytes: its participant's own Maximum Packet Size. */
  maximumPacketSize: number;
  /** Told each refusal its table does not name, before its packet is handed on. */
  onRefusal?: ((refusal: IAcknowledgementRefusal) => void) | undefined;
  /**
   * Told once, with what its broker sent: `a packet of N bytes, past its Maximum Packet Size, M
   * bytes`, `a PUBACK of 0x01, a Reason Code its table does not name`, `a SUBACK of 2 Reason Codes
   * for one filter`, `an UNSUBACK of no Reason Code`.
   */
  onTripped: (reason: string) => void;
}

// an acknowledgement's body, followed byte by byte but for its properties
interface IAcknowledgementBody {
  readonly type: AcknowledgementType;
  /** Its Remaining Length. */
  readonly length: number;
  /** The bytes of its body read so far. */
  offset: number;
  identifier: number;
  /** What its next byte is. */
  phase: 'code' | 'identifier' | 'property-length';
  /** Its Property Length as read so far, and how many of its digits came. */
  propertyLength: number;
  propertyDigits: number;
  /** Its properties' bytes still to pass before its Reason Code. */
  skip: number;
}

// what a byte of an acknowledgement says: nothing yet, its judgment done, a length it cannot
// follow, or why it trips
type Said =
  | { readonly kind: 'judged' | 'more' | 'unjudged' }
  | { readonly kind: 'tripped'; readonly reason: string };

// constants

// a Variable Byte Integer's digits, seven bits each, low first, under a continuation bit (§1.5.5)
const CONTINUES = 0x80;
const DIGIT = 0x7f;
const RADIX = 128;
const LONGEST_LENGTH = 4;

// a packet's type, the high half of its first byte (MQTT 5.0 §2.1.2)
const TYPE_SHIFT = 4;

// a Packet Identifier, a Two Byte Integer
const IDENTIFIER_BYTES = 2;
const BYTE = 256;

// what a refusal its table does not name is handed on as: the code every table names (§2.4)
const UNSPECIFIED_ERROR = 0x80;

const MORE: Said = Object.freeze({ kind: 'more' });
const JUDGED: Said = Object.freeze({ kind: 'judged' });
const UNJUDGED: Said = Object.freeze({ kind: 'unjudged' });

const NAMES: Readonly<Record<AcknowledgementType, string>> = Object.freeze({
  4: 'a PUBACK',
  9: 'a SUBACK',
  11: 'an UNSUBACK',
});

// helpers

const isAcknowledgement = (type: number): type is AcknowledgementType => {
  return (
    type === ACKNOWLEDGEMENT_TYPES.PUBACK ||
    type === ACKNOWLEDGEMENT_TYPES.SUBACK ||
    type === ACKNOWLEDGEMENT_TYPES.UNSUBACK
  );
};

const trippedBy = (reason: string): Said => {
  return { kind: 'tripped', reason };
};

const countOf = (type: AcknowledgementType, count: number): string => {
  return `${NAMES[type]} of ${count === 0 ? 'no Reason Code' : `${String(count)} Reason Codes for one filter`}`;
};

const bodyOf = (type: AcknowledgementType, length: number): IAcknowledgementBody => {
  return {
    identifier: 0,
    length,
    offset: 0,
    phase: 'identifier',
    propertyDigits: 0,
    propertyLength: 0,
    skip: 0,
    type,
  };
};

// a SUBACK's or an UNSUBACK's Property Length, digit by digit: its count of codes judged as it ends
const propertyDigitOf = (judged: IAcknowledgementBody, digit: number): Said => {
  judged.propertyLength += (digit & DIGIT) * RADIX ** judged.propertyDigits;
  judged.propertyDigits += 1;

  if ((digit & CONTINUES) !== 0) {
    // ! one still continuing at its body's last byte leaves no room for a code, and mqtt-packet,
    // given no byte after it, reads it as granting nothing; a fifth digit is the library's to refuse
    if (judged.offset === judged.length) {
      return trippedBy(countOf(judged.type, 0));
    }

    return judged.propertyDigits === LONGEST_LENGTH ? UNJUDGED : MORE;
  }

  const count = judged.length - judged.offset - judged.propertyLength;

  if (count < 0) {
    return UNJUDGED;
  }

  if (count !== 1) {
    return trippedBy(countOf(judged.type, count));
  }

  judged.phase = 'code';
  judged.skip = judged.propertyLength;

  return MORE;
};

// * an acknowledgement's Reason Code, judged by its table: a refusal its table does not name
// written over in place, and told
const codeOf = (
  judged: IAcknowledgementBody,
  {
    at,
    chunk,
    onRefusal,
  }: { at: number; chunk: Uint8Array; onRefusal: IPacketGuardOptions['onRefusal'] }
): Said => {
  const code = chunk[at] ?? 0;
  const verdict = acknowledgementVerdictOf(judged.type, code);

  if (verdict === ACKNOWLEDGEMENT_VERDICTS.UNREADABLE) {
    return trippedBy(
      `${NAMES[judged.type]} of 0x${code.toString(16).padStart(2, '0').toUpperCase()}, a Reason Code its table does not name`
    );
  }

  if (verdict === ACKNOWLEDGEMENT_VERDICTS.REFUSAL) {
    // ! mqtt-packet refuses a code outside its tables, and the link with it: the library reads
    // 0x80, which every table names, and `onRefusal` hears the broker's own
    chunk[at] = UNSPECIFIED_ERROR;
    onRefusal?.({ code, identifier: judged.identifier, type: judged.type });
  }

  return JUDGED;
};

// one byte of an acknowledgement's body, its identifier, Property Length or Reason Code
const stepOf = (
  judged: IAcknowledgementBody,
  context: { at: number; chunk: Uint8Array; onRefusal: IPacketGuardOptions['onRefusal'] }
): Said => {
  const byte = context.chunk[context.at] ?? 0;

  judged.offset += 1;

  switch (judged.phase) {
    case 'identifier':
      judged.identifier = judged.identifier * BYTE + byte;

      // * a PUBACK's code follows its identifier; a SUBACK's and an UNSUBACK's, their properties
      if (judged.offset === IDENTIFIER_BYTES) {
        judged.phase = judged.type === ACKNOWLEDGEMENT_TYPES.PUBACK ? 'code' : 'property-length';
      }

      return MORE;
    case 'property-length':
      return propertyDigitOf(judged, byte);
    case 'code':
      return codeOf(judged, context);
  }
};

// definition

/**
 * `stream`, each packet it receives judged as it comes (spec 15.29), holding no byte and splitting
 * no chunk:
 *
 * - at its fixed header's Remaining Length, before any byte of its body, its size counted
 *   `1 + v(R) + R` as spec 15.30 counts one: one past `maximumPacketSize`, of whatever kind, trips;
 * - a PUBACK, a SUBACK or an UNSUBACK at its Reason Code, by its packet's table
 *   (`mqttAcknowledgementCodes`): a code of 0x80 or more its table does not name is handed on as
 *   0x80 and told to `onRefusal`; one under 0x80 its table does not name trips, and so does a
 *   SUBACK or an UNSUBACK whose count of codes is not one, as its Property Length ends.
 *
 * A packet that trips hands on only what came before its first byte in that read, tells
 * `onTripped` why, and every later chunk is dropped, so that nothing of it reaches the library. A
 * length it cannot follow — a Remaining Length or a Property Length still continuing at its fourth
 * byte, or a Property Length past its body — is left to the library, which refuses it, its link then
 * lost: nothing more is judged on that stream. It arms no timer and writes nothing; its end,
 * `push(null)`, always passes.
 */
export const guardPackets = (stream: IGuardedStream, options: IPacketGuardOptions): void => {
  const { maximumPacketSize, onRefusal, onTripped } = options;
  const push = stream.push.bind(stream);
  // * MQTT 5.0 §2.1.4: a first byte, then a Remaining Length of one to four bytes (§1.5.5), then
  // that many bytes
  let header = 0;
  let first = 0;
  let length = 0;
  // the bytes of a body still to pass, and the acknowledgement it is, while one is judged
  let body = 0;
  let judged: IAcknowledgementBody | undefined;
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
    const trip = (reason: string): boolean => {
      isTripped = true;

      if (start > 0) {
        push(chunk.subarray(0, start), encoding);
      }

      onTripped(reason);

      return false;
    };

    while (at < chunk.length) {
      if (body > 0) {
        if (judged === undefined || judged.skip > 0) {
          // a body no judgment needs, or an acknowledgement's properties, passed whole
          const passed = Math.min(body, chunk.length - at, judged?.skip ?? body);

          at += passed;
          body -= passed;

          if (judged !== undefined) {
            judged.skip -= passed;
            judged.offset += passed;
          }
        } else {
          const said = stepOf(judged, { at, chunk, onRefusal });

          at += 1;
          body -= 1;

          if (said.kind === 'tripped') {
            return trip(said.reason);
          }

          if (said.kind === 'unjudged') {
            isJudging = false;

            return push(chunk, encoding);
          }

          if (said.kind === 'judged') {
            judged = undefined;
          }
        }

        if (body === 0) {
          judged = undefined;
        }
      } else if (header === 0) {
        start = at;
        first = chunk[at] ?? 0;
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
          const type = first >> TYPE_SHIFT;

          header = 0;

          if (size > maximumPacketSize) {
            return trip(
              `a packet of ${String(size)} bytes, past its Maximum Packet Size, ${String(maximumPacketSize)} bytes`
            );
          }

          body = length;
          judged = undefined;

          if (isAcknowledgement(type)) {
            if (type === ACKNOWLEDGEMENT_TYPES.PUBACK) {
              // * a PUBACK of no Reason Code is 0x00; one too short for its identifier, the
              // library's, which reads it as answering nothing
              if (length > IDENTIFIER_BYTES) {
                judged = bodyOf(type, length);
              }
            } else if (length <= IDENTIFIER_BYTES) {
              // * no Property Length, so no code: mqtt-packet reads it as granting nothing
              return trip(countOf(type, 0));
            } else {
              judged = bodyOf(type, length);
            }
          }
        }
      }
    }

    return push(chunk, encoding);
  };
};
