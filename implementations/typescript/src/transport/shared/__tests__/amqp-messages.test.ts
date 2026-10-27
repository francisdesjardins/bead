// ── AMQP messages ─────────────────────────────────────────────────────────────

// spec/vectors.json's amqpMessages and amqpPublishBounds, played by the profile's writer and the
// count of spec 15.37 with no broker. The C# side's `AmqpMessagesTests` play the same vectors, its
// bytes AMQPNetLite's.

// dependencies

import { expect, test } from '@playwright/test';
import { fromHexadecimal, VECTORS } from '../../../router/shared/__tests__/vectors';
import {
  encodeMessage,
  exchangeAddressOf,
  LARGEST_UINT,
  largestPayload,
  MAXIMUM_MESSAGE_SIZE,
  messageBytes,
  queueAddressOf,
  topicOf,
} from '../amqp-messages';

// constants

const encoder = new TextEncoder();

// definition

test.describe('amqp messages', () => {
  test('plays amqpMessages: a message of the profile written to its every byte', () => {
    expect(VECTORS.amqpMessages.length).toBeGreaterThan(0);

    for (const { bytes, name, payloadByte, payloadLength, to, ttl } of VECTORS.amqpMessages) {
      const payload = new Uint8Array(payloadLength).fill(payloadByte);
      const written = encodeMessage(to, payload, ttl === undefined ? undefined : { ttl });

      expect(Buffer.from(written).toString('hex'), name).toBe(
        Buffer.from(fromHexadecimal(bytes)).toString('hex')
      );
      // * its count is its length where no life is asked, and bounds it where one is
      expect(
        messageBytes(encoder.encode(to).length, payloadLength, { hasLife: ttl !== undefined }),
        `${name}: its count`
      ).toBeGreaterThanOrEqual(written.length);

      if (ttl === undefined || ttl > 0xff) {
        expect(
          messageBytes(encoder.encode(to).length, payloadLength, { hasLife: ttl !== undefined }),
          `${name}: its count, to the byte`
        ).toBe(written.length);
      }
    }

    // * a ttl of 0 in uint0, and what no message of the profile holds refused before a byte is written
    expect(
      Buffer.from(encodeMessage('/queues/q', new Uint8Array(0), { ttl: 0 }).subarray(0, 9))
    ).toEqual(Buffer.from([0x00, 0x53, 0x70, 0xc0, 0x04, 0x03, 0x40, 0x40, 0x43]));
    expect(() => {
      return encodeMessage('/'.repeat(208), new Uint8Array(0));
    }).toThrow('an address of 208 bytes, past 207');

    for (const ttl of [-1, 0.5, LARGEST_UINT + 1]) {
      expect(() => {
        return encodeMessage('/queues/q', new Uint8Array(0), { ttl });
      }).toThrow(`a ttl is a uint of milliseconds, not ${String(ttl)}`);
    }
  });

  test('plays amqpPublishBounds: the largest payload within a bound found exactly', () => {
    expect(VECTORS.amqpPublishBounds.length).toBeGreaterThan(0);

    for (const vector of VECTORS.amqpPublishBounds) {
      const {
        address,
        largestPayload: largest,
        maximumMessageSize,
        messageBytes: bytes,
        name,
      } = vector;
      const addressBytes = encoder.encode(address).length;
      const found = largestPayload(address, maximumMessageSize) ?? null;

      expect(found, `${name}: its largest payload`).toBe(largest);

      if (found === null) {
        expect(
          messageBytes(addressBytes, 0, { hasLife: true }),
          `${name}: an empty one`
        ).toBeGreaterThan(maximumMessageSize);
        expect(bytes, `${name}: its message`).toBeNull();

        continue;
      }

      expect(messageBytes(addressBytes, found, { hasLife: true }), `${name}: its message`).toBe(
        bytes
      );

      // * exactly: one byte more passes the bound, unless the payload is the largest a vbin32 holds
      if (found < LARGEST_UINT) {
        expect(
          messageBytes(addressBytes, found + 1, { hasLife: true }),
          `${name}: one byte more`
        ).toBeGreaterThan(maximumMessageSize);
      }
    }

    // a topic's tokens joined by `.`, read from its queue and written through its root's exchange
    expect(topicOf(['bead', 'i', 'peer.1'])).toBe('bead.i.peer.1');
    expect(queueAddressOf(['bead', 's', 'interop'])).toBe('/queues/bead.s.interop');
    expect(exchangeAddressOf(['bead', 'i', 'server'])).toBe('/exchanges/bead/bead.i.server');
    expect(largestPayload('/exchanges/bead/bead.i.server', MAXIMUM_MESSAGE_SIZE)).toBe(16_777_156);
    expect(largestPayload('/exchanges/bead/bead.i.peer', 4_096)).toBe(4_038);
  });
});
