// ── MQTT packets ──────────────────────────────────────────────────────────────

// spec/vectors.json's mqttPublishBounds, played by the count of spec 15.30 with no broker, and that
// count held to the bytes `mqtt-packet` encodes a PUBLISH in. The C# side's `MqttPacketsTests` play
// the same vectors.

// dependencies

import { expect, test } from '@playwright/test';
import { generate } from 'mqtt-packet';
import { VECTORS } from '../../../router/shared/__tests__/vectors';
import { LARGEST_PACKET_SIZE, largestPayload, publishBytes } from '../mqtt-packets';

// constants

// the largest packet encoded to check the count against, so that no vector's 268 MB is allocated
const ENCODED_UP_TO = 17_000_000;

const encoder = new TextEncoder();

// helpers

// the bytes `mqtt-packet` writes a PUBLISH of `payload` bytes to `topic` in, as MQTT.js sends one
const encodedOf = (
  topic: string,
  payload: number,
  { hasLife, qos }: { hasLife: boolean; qos: 0 | 1 }
): number => {
  return generate(
    {
      cmd: 'publish',
      dup: false,
      ...(qos === 1 ? { messageId: 1 } : {}),
      payload: Buffer.alloc(payload),
      properties: hasLife ? { messageExpiryInterval: 60 } : {},
      qos,
      retain: false,
      topic,
    },
    { protocolVersion: 5 }
  ).length;
};

// definition

test.describe('mqtt packets', () => {
  test('plays mqttPublishBounds: a PUBLISH counted to its every byte, and the largest payload within a bound found exactly', () => {
    expect(VECTORS.mqttPublishBounds.length).toBeGreaterThan(0);

    for (const vector of VECTORS.mqttPublishBounds) {
      const {
        expiry,
        largestPayload: largest,
        maximumPacketSize,
        name,
        packetBytes,
        qos,
        topic,
      } = vector;
      const counted = { hasLife: expiry, qos };
      const topicBytes = encoder.encode(topic).length;
      const found = largestPayload(topic, maximumPacketSize, counted) ?? null;

      expect(found, `${name}: its largest payload`).toBe(largest);

      if (found === null) {
        expect(publishBytes(topicBytes, 0, counted), `${name}: an empty one`).toBeGreaterThan(
          maximumPacketSize
        );
        expect(packetBytes, `${name}: its packet`).toBeNull();

        continue;
      }

      expect(publishBytes(topicBytes, found, counted), `${name}: its packet`).toBe(packetBytes);
      // * exactly: one byte more passes the bound
      expect(
        publishBytes(topicBytes, found + 1, counted),
        `${name}: one byte more`
      ).toBeGreaterThan(maximumPacketSize);

      if (packetBytes !== null && packetBytes <= ENCODED_UP_TO) {
        expect(encodedOf(topic, found, counted), `${name}: as mqtt-packet encodes it`).toBe(
          packetBytes
        );
      }
    }

    expect(LARGEST_PACKET_SIZE).toBe(268_435_460);
  });
});
