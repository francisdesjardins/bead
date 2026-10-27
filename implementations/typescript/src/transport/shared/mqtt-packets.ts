// ── MQTT packets ──────────────────────────────────────────────────────────────

// The count of an MQTT 5 PUBLISH to its every byte (spec 15.30; MQTT 5.0 §2.1.4, §3.3.2), and how a
// topic and a group's shared subscription are written (spec 15.25): no library's, so that
// `spec/vectors.json`'s `mqttPublishBounds` holds both sides to it with no broker.

// dependencies

import type { BrokerTopic } from './types';

// constants

/** The largest Remaining Length a Variable Byte Integer holds (MQTT 5.0 §1.5.5). */
export const LARGEST_REMAINING_LENGTH = 268_435_455;

/** The largest packet MQTT 5 writes, the bound of a CONNACK that names none: 268,435,460 bytes. */
export const LARGEST_PACKET_SIZE = 1 + 4 + LARGEST_REMAINING_LENGTH;

/** A participant's Maximum Packet Size, its CONNECT's, by default: 16 MiB (spec 15.30). */
export const MAXIMUM_PACKET_SIZE = 16_777_216;

// a Message Expiry Interval: its identifier and its Four Byte Integer (MQTT 5.0 §3.3.2.3.3)
const EXPIRY_BYTES = 5;

const encoder = new TextEncoder();

// helpers

/** The bytes of a Variable Byte Integer of `value` (MQTT 5.0 §1.5.5). */
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
