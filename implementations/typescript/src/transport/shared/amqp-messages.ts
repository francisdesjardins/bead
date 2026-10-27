// ── AMQP messages ─────────────────────────────────────────────────────────────

// The profile of an AMQP 1.0 message that carries a parcel, to its every byte (spec 15.35; AMQP
// 1.0 Types §1.6, Messaging §3.2), its count (spec 15.37) and a topic's addresses (spec 15.32): no
// library's, so that `amqpMessages` and `amqpPublishBounds` hold both sides to them.

// dependencies

import type { BrokerTopic } from './types';

// constants

/** The largest uint, the largest payload a vbin32 holds, and a bound that names none (spec 15.37). */
export const LARGEST_UINT = 4_294_967_295;

/** A participant's `maximumMessageSize`, the largest message whose payload it takes, by default: 16 MiB (spec 15.37). */
export const MAXIMUM_MESSAGE_SIZE = 16_777_216;

// a life's header, counted whatever the message: its descriptor 3, a list8's 3, its two nulls 2
// and a uint of 5 (spec 15.37)
const LIFE_BYTES = 13;

// the longest address the profile's count holds: its str8 and its properties' list8 always fit
const LONGEST_ADDRESS = 207;

// the described types of the sections the profile writes (AMQP 1.0 Messaging §3.2.1, §3.2.4, §3.2.6)
const SECTION = Object.freeze({ DATA: 0x75, HEADER: 0x70, PROPERTIES: 0x73 });

// the encodings it writes (AMQP 1.0 Types §1.6)
const CODE = Object.freeze({
  LIST8: 0xc0,
  NULL: 0x40,
  SMALL_UINT: 0x52,
  STR8: 0xa1,
  UINT: 0x70,
  UINT0: 0x43,
  VBIN32: 0xb0,
  VBIN8: 0xa0,
});

const encoder = new TextEncoder();

// helpers

// a described type of a small-ulong descriptor: 0x00, 0x53 and its code (AMQP 1.0 Types §1.2)
const descriptorOf = (code: number): number[] => {
  return [0x00, 0x53, code];
};

// a uint in the smallest of its encodings: uint0, smalluint or uint
const uintOf = (value: number): number[] => {
  if (value === 0) {
    return [CODE.UINT0];
  }

  if (value <= 0xff) {
    return [CODE.SMALL_UINT, value];
  }

  return [
    CODE.UINT,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
};

// a list8 of three fields, two nulls then the last set, as each section of the profile is
const listOf = (last: readonly number[]): number[] => {
  return [CODE.LIST8, 3 + last.length, 3, CODE.NULL, CODE.NULL, ...last];
};

// definition

/**
 * A topic's tokens joined by `.`, a queue's and a routing key's form (spec 15.32): `['bead', 'i',
 * 'ada']`, `bead.i.ada`.
 */
export const topicOf = (topic: BrokerTopic): string => {
  return topic.join('.');
};

/** The address a topic is written to: its root's topic exchange, `/exchanges/bead/bead.i.ada`. */
export const exchangeAddressOf = (topic: BrokerTopic): string => {
  return `/exchanges/${topic[0] ?? ''}/${topicOf(topic)}`;
};

/** The address a topic is read from: the queue of its name, `/queues/bead.i.ada`. */
export const queueAddressOf = (topic: BrokerTopic): string => {
  return `/queues/${topicOf(topic)}`;
};

/**
 * w(N): the bytes a Data section's binary takes before its payload, vbin8 under 256 and vbin32
 * otherwise.
 */
export const widthOf = (payload: number): number => {
  return payload < 256 ? 2 : 5;
};

/**
 * S, the bytes of a message of `payload` bytes to an address of `addressBytes` bytes in UTF-8: a
 * life's header where `hasLife`, its properties, and its Data section (spec 15.37).
 */
export const messageBytes = (
  addressBytes: number,
  payload: number,
  { hasLife }: { hasLife: boolean }
): number => {
  return (hasLife ? LIFE_BYTES : 0) + 10 + addressBytes + 3 + widthOf(payload) + payload;
};

/**
 * The message of the profile (spec 15.35): a header only where a life is asked, its ttl alone, in
 * milliseconds; properties whose `to` alone is set, the fields before it null; one Data section,
 * the payload; each value in the smallest of its encodings.
 */
export const encodeMessage = (
  to: string,
  payload: Uint8Array,
  options?: { ttl?: number | undefined }
): Uint8Array => {
  const ttl = options?.ttl;
  const address = encoder.encode(to);

  if (address.length > LONGEST_ADDRESS) {
    throw new RangeError(
      `an address of ${String(address.length)} bytes, past ${String(LONGEST_ADDRESS)}`
    );
  }

  if (ttl !== undefined && !(Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= LARGEST_UINT)) {
    throw new RangeError(`a ttl is a uint of milliseconds, not ${String(ttl)}`);
  }

  const header = ttl === undefined ? [] : [...descriptorOf(SECTION.HEADER), ...listOf(uintOf(ttl))];
  const properties = [
    ...descriptorOf(SECTION.PROPERTIES),
    ...listOf([CODE.STR8, address.length, ...address]),
  ];
  const length = payload.length;
  const data = [
    ...descriptorOf(SECTION.DATA),
    ...(length < 256
      ? [CODE.VBIN8, length]
      : [
          CODE.VBIN32,
          (length >>> 24) & 0xff,
          (length >>> 16) & 0xff,
          (length >>> 8) & 0xff,
          length & 0xff,
        ]),
  ];
  const bytes = new Uint8Array(header.length + properties.length + data.length + length);

  bytes.set(header, 0);
  bytes.set(properties, header.length);
  bytes.set(data, header.length + properties.length);
  bytes.set(payload, header.length + properties.length + data.length);

  return bytes;
};

/**
 * The largest payload of a message to `address` within `maximum` bytes, a life counted whatever the
 * message, at most {@link LARGEST_UINT} (spec 15.37); `undefined` where an empty one does not fit.
 * Found by a search: w grows with N, so no overhead is fixed.
 */
export const largestPayload = (address: string, maximum: number): number | undefined => {
  const addressBytes = encoder.encode(address).length;
  const fits = (payload: number): boolean => {
    return messageBytes(addressBytes, payload, { hasLife: true }) <= maximum;
  };

  if (!fits(0)) {
    return undefined;
  }

  let low = 0;
  let high = LARGEST_UINT;

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
