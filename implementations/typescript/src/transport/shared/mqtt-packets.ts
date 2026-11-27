// ── MQTT packets ──────────────────────────────────────────────────────────────

// A PUBLISH counted to its every byte (spec 15.30), a topic and a shared subscription written (spec
// 15.25), and an acknowledgement's code judged (spec 15.29): no library's, so that
// `mqttPublishBounds` and `mqttAcknowledgementCodes` hold every side to them with no broker.

// dependencies

import type { BrokerTopic } from './types';

// constants

/** MQTT 5.0 §2.1.2: the packet type's shift, the high four bits of a fixed header's first byte. */
export const PACKET_TYPE_SHIFT = 4;

/** MQTT 5.0 §1.5.5: a Variable Byte Integer's continuation bit, set on every byte but its last. */
export const CONTINUATION_BIT = 0x80;

/** MQTT 5.0 §1.5.5: a Variable Byte Integer's digit, the low seven bits of each byte. */
export const DIGIT_MASK = 0x7f;

/** MQTT 5.0 §1.5.5: a Variable Byte Integer's radix, each digit's place 128 times the last's. */
export const DIGIT_RADIX = 128;

/** MQTT 5.0 §1.5.5: the most bytes a Variable Byte Integer takes. */
export const LONGEST_VARIABLE_BYTE_INTEGER = 4;

/** MQTT 5.0 §2.4: the first Reason Code that tells a failure. */
export const FIRST_FAILURE = 0x80;

/** MQTT 5.0 Table 2-6: Unspecified error, the failure every acknowledgement's table names. */
export const UNSPECIFIED_ERROR = 0x80;

/** The Reason Codes of MQTT 5.0 Table 2-6 this side reads apart. */
export const REASON = Object.freeze({
  NO_MATCHING_SUBSCRIBERS: 0x10,
  NO_SUBSCRIPTION_EXISTED: 0x11,
  SESSION_TAKEN_OVER: 0x8e,
  SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: 0x9e,
  SUCCESS: 0x00,
});

/** The largest Remaining Length a Variable Byte Integer holds (MQTT 5.0 §1.5.5). */
export const LARGEST_REMAINING_LENGTH = 268_435_455;

/** The largest packet MQTT 5 writes, the bound of a CONNACK that names none: 268,435,460 bytes. */
export const LARGEST_PACKET_SIZE = 1 + LONGEST_VARIABLE_BYTE_INTEGER + LARGEST_REMAINING_LENGTH;

/** A participant's Maximum Packet Size, its CONNECT's, by default: 16 MiB (spec 15.30). */
export const MAXIMUM_PACKET_SIZE = 16_777_216;

/** The packet types an acknowledgement of a request is: PUBACK, SUBACK and UNSUBACK (MQTT 5.0 §2.1.2). */
export const ACKNOWLEDGEMENT_TYPES = Object.freeze({ PUBACK: 4, SUBACK: 9, UNSUBACK: 11 });

export type AcknowledgementType =
  (typeof ACKNOWLEDGEMENT_TYPES)[keyof typeof ACKNOWLEDGEMENT_TYPES];

/**
 * What a Reason Code of an acknowledgement says (spec 15.27 to 15.29): its table's meaning, a refusal
 * as any code of 0x80 or more is (MQTT 5.0 §2.4, §4.13.2), or a packet its client cannot read.
 */
export const ACKNOWLEDGEMENT_VERDICTS = Object.freeze({
  NAMED: 'named',
  REFUSAL: 'refusal',
  UNREADABLE: 'unreadable',
});

export type AcknowledgementVerdict =
  (typeof ACKNOWLEDGEMENT_VERDICTS)[keyof typeof ACKNOWLEDGEMENT_VERDICTS];

// the codes each acknowledgement's table names, MQTT 5.0's, code for code
const NAMED_CODES: Readonly<Record<AcknowledgementType, ReadonlySet<number>>> = Object.freeze({
  // §3.4.2.1
  [ACKNOWLEDGEMENT_TYPES.PUBACK]: new Set([0x00, 0x10, 0x80, 0x83, 0x87, 0x90, 0x91, 0x97, 0x99]),
  // §3.9.3, Table 3-8
  [ACKNOWLEDGEMENT_TYPES.SUBACK]: new Set([
    0x00, 0x01, 0x02, 0x80, 0x83, 0x87, 0x8f, 0x91, 0x97, 0x9e, 0xa1, 0xa2,
  ]),
  // §3.11.3, Table 3-9
  [ACKNOWLEDGEMENT_TYPES.UNSUBACK]: new Set([0x00, 0x11, 0x80, 0x83, 0x87, 0x8f, 0x91]),
});

// a Message Expiry Interval: its identifier and its Four Byte Integer (MQTT 5.0 §3.3.2.3.3)
const EXPIRY_BYTES = 5;

const encoder = new TextEncoder();

// helpers

/**
 * The bytes of a Variable Byte Integer of `value` (MQTT 5.0 §1.5.5), each width's bound as Table
 * 1-1 prints it.
 */
export const widthOf = (value: number): number => {
  if (value < 128) {
    return 1;
  }

  if (value < 16_384) {
    return 2;
  }

  return value < 2_097_152 ? 3 : 4;
};

// R: the topic's length and bytes, the packet identifier at QoS 1, the properties' length and a
// Message Expiry Interval where there is one, then the payload
const remainingOf = (
  topicBytes: number,
  payload: number,
  { hasLife, qos }: { hasLife: boolean; qos: 0 | 1 }
): number => {
  const properties = hasLife ? EXPIRY_BYTES : 0;

  return 2 + topicBytes + (qos === 1 ? 2 : 0) + widthOf(properties) + properties + payload;
};

// definition

/**
 * The verdict of `code` in an acknowledgement of `type`: named where its table names it, a refusal
 * where it is 0x80 or more, and otherwise a packet its client cannot read (spec 15.29;
 * [MQTT-3.4.2-1], [MQTT-3.9.3-2], [MQTT-3.11.3-2]).
 */
export const acknowledgementVerdictOf = (
  type: AcknowledgementType,
  code: number
): AcknowledgementVerdict => {
  if (NAMED_CODES[type].has(code)) {
    return ACKNOWLEDGEMENT_VERDICTS.NAMED;
  }

  return code >= FIRST_FAILURE
    ? ACKNOWLEDGEMENT_VERDICTS.REFUSAL
    : ACKNOWLEDGEMENT_VERDICTS.UNREADABLE;
};

/** A topic's tokens joined by `/`, as MQTT names it (spec 15.25): `['bead', 'i', 'ada']`, `bead/i/ada`. */
export const topicOf = (topic: BrokerTopic): string => {
  return topic.join('/');
};

/**
 * The shared subscription a name served in a group is (spec 15.25; MQTT 5.0 §4.8.2): its share name
 * the group, then the name's topic, `$share/interop/bead/s/interop`.
 */
export const groupFilterOf = (group: string, topic: BrokerTopic): string => {
  return `$share/${group}/${topicOf(topic)}`;
};

/**
 * S, the bytes of a PUBLISH of `payload` bytes to a topic of `topicBytes` bytes in UTF-8, at `qos`,
 * with a Message Expiry Interval where `hasLife`: its fixed header's byte, its Remaining Length's
 * own bytes, and R (spec 15.30).
 */
export const publishBytes = (
  topicBytes: number,
  payload: number,
  { hasLife, qos }: { hasLife: boolean; qos: 0 | 1 }
): number => {
  const remaining = remainingOf(topicBytes, payload, { hasLife, qos });

  return 1 + widthOf(remaining) + remaining;
};

/**
 * The largest payload of a PUBLISH to `topic` within `maximum` bytes, at QoS 1 unless told, a life
 * counted unless told otherwise, whatever the message (spec 15.30); `undefined` where an empty one
 * does not fit. Found by a search: S grows with N, and v(R) with it, so no overhead is fixed.
 */
export const largestPayload = (
  topic: string,
  maximum: number,
  options?: { hasLife?: boolean | undefined; qos?: 0 | 1 | undefined }
): number | undefined => {
  const { hasLife = true, qos = 1 } = options ?? {};
  const topicBytes = encoder.encode(topic).length;
  const fits = (payload: number): boolean => {
    return (
      publishBytes(topicBytes, payload, { hasLife, qos }) <= maximum &&
      remainingOf(topicBytes, payload, { hasLife, qos }) <= LARGEST_REMAINING_LENGTH
    );
  };

  if (!fits(0)) {
    return undefined;
  }

  let low = 0;
  let high = LARGEST_REMAINING_LENGTH;

  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);

    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};
