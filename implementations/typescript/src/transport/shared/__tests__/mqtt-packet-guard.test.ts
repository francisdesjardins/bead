// ── MQTT packet guard ─────────────────────────────────────────────────────────

// The guard over a stream's `push`, played on a stub that records what it is handed and on a
// `net.Socket` of the loopback. The C# side's guard and the Rust side's reader, `mqtt::packets`,
// play the same sentences.

// dependencies

import { once } from 'node:events';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { guardPacketSize, type IGuardedStream } from '../mqtt-packet-guard';

// constants

const PINGRESP = Object.freeze([0xd0, 0x00]);
// a PUBLISH's fixed header announcing 997 bytes: 1,000 in all
const ANNOUNCING_1000 = Object.freeze([0x32, 0xe5, 0x07]);

// helpers

/** A stream whose `push` records each chunk, as it is handed, and the sizes its guard told. */
const guardedOf = (
  maximumPacketSize: number
): IGuardedStream & { pushed: (Uint8Array | null)[]; sizes: number[] } => {
  const pushed: (Uint8Array | null)[] = [];
  const sizes: number[] = [];
  const stream = {
    pushed,
    sizes,
    push: (chunk: Uint8Array | null) => {
      pushed.push(chunk);

      return true;
    },
  };

  guardPacketSize(stream, {
    maximumPacketSize,
    onPastMaximum: (size) => {
      sizes.push(size);
    },
  });

  return stream;
};

/** A packet of `first` as its first byte and a body of `remaining` bytes, its length encoded. */
const packetOf = (first: number, remaining: number): Uint8Array => {
  const header = [first];
  let left = remaining;

  do {
    const digit = left % 128;

    left = Math.floor(left / 128);
    header.push(left > 0 ? digit | 0x80 : digit);
  } while (left > 0);

  const packet = new Uint8Array(header.length + remaining);

  packet.set(header);

  return packet;
};

/** Each chunk as an array of its bytes, `null` as itself. */
const bytesOf = (chunks: (Uint8Array | null)[]): (number[] | null)[] => {
  return chunks.map((chunk) => {
    return chunk === null ? null : [...chunk];
  });
};

// definition

test.describe('guardPacketSize', () => {
  test('refuses a packet past its bound as its Remaining Length is read', async () => {
    // past 999, refused at its length; nothing of it handed on
    const past = guardedOf(999);

    expect(past.push(Uint8Array.from(ANNOUNCING_1000))).toBe(false);
    expect(past.pushed).toEqual([]);
    expect(past.sizes).toEqual([1_000]);

    // within 1,000, its body awaited, then the next packet judged
    const within = guardedOf(1_000);
    const header = Uint8Array.from(ANNOUNCING_1000);
    const body = new Uint8Array(997);
    const next = Uint8Array.from(PINGRESP);

    within.push(header);
    within.push(body);
    within.push(next);
    expect(within.pushed).toEqual([header, body, next]);
    expect(within.pushed[1]).toBe(body);
    expect(within.sizes).toEqual([]);

    // * one byte a read: what came before its length is whole handed on as it came, its last
    // byte and every one after it withheld
    const split = guardedOf(999);

    for (const byte of [...ANNOUNCING_1000, 0x00, 0x00]) {
      split.push(Uint8Array.of(byte));
    }

    split.push(null);
    expect(bytesOf(split.pushed)).toEqual([[0x32], [0xe5], null]);
    expect(split.sizes).toEqual([1_000]);

    // a packet within its bound then that header, in one read: the first handed on whole
    const joined = guardedOf(999);

    joined.push(Uint8Array.from([...PINGRESP, ...ANNOUNCING_1000, 0x00]));
    expect(bytesOf(joined.pushed)).toEqual([[...PINGRESP]]);
    expect(joined.sizes).toEqual([1_000]);

    // over a socket of the loopback, the stream MQTT.js reads over TCP
    const server = createServer();

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const accepted = once(server, 'connection') as Promise<[Socket]>;
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
      const received: number[] = [];
      const sizes: number[] = [];

      guardPacketSize(socket, {
        maximumPacketSize: 999,
        onPastMaximum: (size) => {
          sizes.push(size);
          socket.destroy();
        },
      });
      socket.on('data', (chunk: Uint8Array) => {
        received.push(...chunk);
      });

      const [peer] = await accepted;

      peer.on('error', () => {
        // the guarded end destroyed it
      });
      peer.write(Uint8Array.from([...PINGRESP, ...ANNOUNCING_1000]));
      peer.write(new Uint8Array(997));
      await once(socket, 'close');
      expect(received).toEqual([...PINGRESP]);
      expect(sizes).toEqual([1_000]);
      peer.destroy();
    } finally {
      server.close();
    }
  });

  test('refuses a packet past its bound whatever its kind', () => {
    // a first byte of type 0, which MQTT 5 reserves, refused as past its bound, never as malformed
    const reserved = guardedOf(1_100);

    reserved.push(Uint8Array.of(0x00, 0x80, 0x80, 0x80, 0x08));
    expect(reserved.pushed).toEqual([]);
    expect(reserved.sizes).toEqual([16_777_221]);

    // and so is a CONNACK, a PINGRESP or an AUTH, the length alone judged
    for (const first of [0x20, 0xd0, 0xf0]) {
      const guarded = guardedOf(1_100);

      guarded.push(packetOf(first, 1_098));
      expect(guarded.pushed).toEqual([]);
      expect(guarded.sizes).toEqual([1_101]);
    }
  });

  test('reads a packet at its bound, and the next in the same read, as they came', () => {
    // 1,100 bytes in all, then a PINGRESP, in one read: the same chunk, the same bytes
    const guarded = guardedOf(1_100);
    const atBound = packetOf(0x30, 1_097);
    const read = new Uint8Array(atBound.length + PINGRESP.length);

    read.set(atBound);
    read.set(PINGRESP, atBound.length);
    expect(atBound.length).toBe(1_100);
    guarded.push(read);
    guarded.push(null);
    expect(guarded.pushed).toEqual([read, null]);
    expect(guarded.pushed[0]).toBe(read);
    expect(guarded.sizes).toEqual([]);

    // * a Remaining Length still continuing at its fourth byte, malformed: handed on, and nothing
    // more judged, left to its library
    const malformed = guardedOf(1_100);
    const five = Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01);
    const after = Uint8Array.from(ANNOUNCING_1000);

    malformed.push(five);
    malformed.push(after);
    expect(malformed.pushed).toEqual([five, after]);
    expect(malformed.sizes).toEqual([]);
  });
});
