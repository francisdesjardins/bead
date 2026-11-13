// ── MQTT packet guard ─────────────────────────────────────────────────────────

// The guard over a stream's `push`, played on a stub that records what it is handed and on a
// `net.Socket` of the loopback. The C# side's guard and the Rust side's reader, `mqtt::packets`,
// play the same sentences.

// dependencies

import { once } from 'node:events';
import { type AddressInfo, connect, createServer, type Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { VECTORS } from '../../../router/shared/__tests__/vectors';
import {
  guardPackets,
  type IAcknowledgementRefusal,
  type IGuardedStream,
} from '../mqtt-packet-guard';

// constants

const PINGRESP = Object.freeze([0xd0, 0x00]);
// a PUBLISH's fixed header announcing 997 bytes: 1,000 in all
const ANNOUNCING_1000 = Object.freeze([0x32, 0xe5, 0x07]);

// helpers

/** What its guard tells of a packet of `size` bytes past a bound of `bound`. */
const pastOf = (size: number, bound: number): string => {
  return `a packet of ${String(size)} bytes, past its Maximum Packet Size, ${String(bound)} bytes`;
};

/** A stream whose `push` records each chunk as it is handed, and what its guard told: why it tripped, and each refusal. */
const guardedOf = (
  maximumPacketSize: number
): IGuardedStream & {
  pushed: (Uint8Array | null)[];
  refusals: IAcknowledgementRefusal[];
  tripped: string[];
} => {
  const pushed: (Uint8Array | null)[] = [];
  const refusals: IAcknowledgementRefusal[] = [];
  const tripped: string[] = [];
  const stream = {
    pushed,
    refusals,
    tripped,
    push: (chunk: Uint8Array | null) => {
      pushed.push(chunk);

      return true;
    },
  };

  guardPackets(stream, {
    maximumPacketSize,
    onRefusal: (refusal) => {
      refusals.push(refusal);
    },
    onTripped: (reason) => {
      tripped.push(reason);
    },
  });

  return stream;
};

/** The bytes `chunks` hand on, joined. */
const joinedOf = (chunks: (Uint8Array | null)[]): number[] => {
  return chunks.flatMap((chunk) => {
    return chunk === null ? [] : [...chunk];
  });
};

/** A Reason Code as the guard names it. */
const hexOf = (code: number): string => {
  return `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
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

test.describe('guardPackets', () => {
  test('refuses a packet past its bound as its Remaining Length is read', async () => {
    // past 999, refused at its length; nothing of it handed on
    const past = guardedOf(999);

    expect(past.push(Uint8Array.from(ANNOUNCING_1000))).toBe(false);
    expect(past.pushed).toEqual([]);
    expect(past.tripped).toEqual([pastOf(1_000, 999)]);

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
    expect(within.tripped).toEqual([]);

    // * one byte a read: what came before its length is whole handed on as it came, its last
    // byte and every one after it withheld
    const split = guardedOf(999);

    for (const byte of [...ANNOUNCING_1000, 0x00, 0x00]) {
      split.push(Uint8Array.of(byte));
    }

    split.push(null);
    expect(bytesOf(split.pushed)).toEqual([[0x32], [0xe5], null]);
    expect(split.tripped).toEqual([pastOf(1_000, 999)]);

    // a packet within its bound then that header, in one read: the first handed on whole
    const joined = guardedOf(999);

    joined.push(Uint8Array.from([...PINGRESP, ...ANNOUNCING_1000, 0x00]));
    expect(bytesOf(joined.pushed)).toEqual([[...PINGRESP]]);
    expect(joined.tripped).toEqual([pastOf(1_000, 999)]);

    // over a socket of the loopback, the stream MQTT.js reads over TCP
    const server = createServer();

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const accepted = once(server, 'connection') as Promise<[Socket]>;
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
      const received: number[] = [];
      const sizes: string[] = [];

      guardPackets(socket, {
        maximumPacketSize: 999,
        onTripped: (reason) => {
          sizes.push(reason);
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
      expect(sizes).toEqual([pastOf(1_000, 999)]);
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
    expect(reserved.tripped).toEqual([pastOf(16_777_221, 1_100)]);

    // and so is a CONNACK, a PINGRESP or an AUTH, the length alone judged
    for (const first of [0x20, 0xd0, 0xf0]) {
      const guarded = guardedOf(1_100);

      guarded.push(packetOf(first, 1_098));
      expect(guarded.pushed).toEqual([]);
      expect(guarded.tripped).toEqual([pastOf(1_101, 1_100)]);
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
    expect(guarded.tripped).toEqual([]);

    // * a Remaining Length still continuing at its fourth byte, malformed: handed on, and nothing
    // more judged, left to its library
    const malformed = guardedOf(1_100);
    const five = Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01);
    const after = Uint8Array.from(ANNOUNCING_1000);

    malformed.push(five);
    malformed.push(after);
    expect(malformed.pushed).toEqual([five, after]);
    expect(malformed.tripped).toEqual([]);
  });

  test('hands on a code of 0x80 or more its table does not name as 0x80, telling its own, whole or a byte a read', () => {
    // * a PUBACK of 0x95, as Mosquitto 2.1.2 sends one past its message_size_limit; a SUBACK of
    // 0x95 whose properties are passed over; an UNSUBACK of 0xFF
    const cases = [
      { bytes: [0x40, 0x03, 0x00, 0x07, 0x95], code: 0x95, identifier: 7, type: 4 },
      {
        bytes: [0x90, 0x09, 0x01, 0x02, 0x05, 0x1f, 0x00, 0x02, 0x6e, 0x6f, 0x95],
        code: 0x95,
        identifier: 258,
        type: 9,
      },
      { bytes: [0xb0, 0x04, 0x00, 0x03, 0x00, 0xff], code: 0xff, identifier: 3, type: 11 },
    ] as const;

    for (const { bytes, code, identifier, type } of cases) {
      const expected = [...bytes.slice(0, -1), 0x80];
      // whole, in one read, the next packet judged after it
      const whole = guardedOf(1_100);
      const read = Uint8Array.from([...bytes, ...PINGRESP]);

      whole.push(read);
      expect(whole.pushed).toEqual([read]);
      expect(joinedOf(whole.pushed)).toEqual([...expected, ...PINGRESP]);
      expect(whole.refusals).toEqual([{ code, identifier, type }]);
      expect(whole.tripped).toEqual([]);

      // a byte a read: told as its code comes, that byte handed on as 0x80
      const split = guardedOf(1_100);

      for (const byte of bytes) {
        split.push(Uint8Array.of(byte));
      }

      expect(joinedOf(split.pushed)).toEqual(expected);
      expect(split.refusals).toEqual([{ code, identifier, type }]);
      expect(split.tripped).toEqual([]);
    }

    // a code its table names passes untouched, 0x80 or more among it, and nothing is told
    const named = guardedOf(1_100);
    const read = Uint8Array.of(0x40, 0x03, 0x00, 0x01, 0x87, 0x90, 0x04, 0x00, 0x02, 0x00, 0x01);

    named.push(read);
    expect(named.pushed).toEqual([read]);
    expect(joinedOf(named.pushed)).toEqual([
      0x40, 0x03, 0x00, 0x01, 0x87, 0x90, 0x04, 0x00, 0x02, 0x00, 0x01,
    ]);
    expect(named.refusals).toEqual([]);
    expect(named.tripped).toEqual([]);
  });

  test('trips on an acknowledgement of a code under 0x80 its table does not name, or of a count of codes other than one, handing on what came before it', () => {
    const unnamed = 'a Reason Code its table does not name';
    const cases = [
      { bytes: [0x40, 0x03, 0x00, 0x01, 0x01], reason: `a PUBACK of 0x01, ${unnamed}` },
      // its reserved flags set: judged by its type alone
      { bytes: [0x42, 0x03, 0x00, 0x01, 0x01], reason: `a PUBACK of 0x01, ${unnamed}` },
      { bytes: [0x90, 0x04, 0x00, 0x01, 0x00, 0x03], reason: `a SUBACK of 0x03, ${unnamed}` },
      // a property MQTT 5 does not define passed over, its code judged all the same
      {
        bytes: [0x90, 0x06, 0x00, 0x01, 0x02, 0x7f, 0x00, 0x03],
        reason: `a SUBACK of 0x03, ${unnamed}`,
      },
      { bytes: [0xb0, 0x04, 0x00, 0x01, 0x00, 0x01], reason: `an UNSUBACK of 0x01, ${unnamed}` },
      // * a count other than one, whatever its codes
      {
        bytes: [0x90, 0x05, 0x00, 0x01, 0x00, 0x01, 0x01],
        reason: 'a SUBACK of 2 Reason Codes for one filter',
      },
      {
        bytes: [0x90, 0x05, 0x00, 0x01, 0x00, 0x01, 0x87],
        reason: 'a SUBACK of 2 Reason Codes for one filter',
      },
      {
        bytes: [0xb0, 0x05, 0x00, 0x01, 0x00, 0x00, 0x11],
        reason: 'an UNSUBACK of 2 Reason Codes for one filter',
      },
      { bytes: [0x90, 0x03, 0x00, 0x01, 0x00], reason: 'a SUBACK of no Reason Code' },
      { bytes: [0xb0, 0x03, 0x00, 0x01, 0x00], reason: 'an UNSUBACK of no Reason Code' },
      // ! no Property Length at all, which mqtt-packet reads as granting nothing
      { bytes: [0xb0, 0x02, 0x00, 0x01], reason: 'an UNSUBACK of no Reason Code' },
      // ! a Property Length still continuing at its body's last byte, which mqtt-packet, given no
      // byte after it, reads as granting nothing
      { bytes: [0x90, 0x03, 0x00, 0x01, 0x80], reason: 'a SUBACK of no Reason Code' },
      { bytes: [0xb0, 0x03, 0x00, 0x01, 0x80], reason: 'an UNSUBACK of no Reason Code' },
    ];

    for (const { bytes, reason } of cases) {
      // behind a PINGRESP and ahead of a PUBLISH in one read: the PINGRESP alone handed on, and
      // nothing after
      const whole = guardedOf(1_100);

      expect(whole.push(Uint8Array.from([...PINGRESP, ...bytes, 0x30, 0x00]))).toBe(false);
      expect(bytesOf(whole.pushed), reason).toEqual([[...PINGRESP]]);
      expect(whole.tripped).toEqual([reason]);
      whole.push(Uint8Array.from(PINGRESP));
      expect(whole.pushed).toHaveLength(1);
      expect(whole.refusals).toEqual([]);

      // a byte a read: the bytes before the one that trips handed on, none from it
      const split = guardedOf(1_100);

      for (const byte of bytes) {
        split.push(Uint8Array.of(byte));
      }

      const handed = joinedOf(split.pushed);

      expect(split.tripped, reason).toEqual([reason]);
      expect(handed.length, reason).toBeLessThan(bytes.length);
      expect(handed).toEqual(bytes.slice(0, handed.length));
    }
  });

  test('leaves to the library an acknowledgement whose Property Length it cannot follow, judging nothing more', () => {
    // a Property Length past its body, and one still continuing at its fourth byte
    for (const bytes of [
      [0x90, 0x03, 0x00, 0x01, 0x05],
      [0x90, 0x07, 0x00, 0x01, 0x80, 0x80, 0x80, 0x80, 0x01],
    ]) {
      const guarded = guardedOf(1_100);
      const read = Uint8Array.from(bytes);
      const after = Uint8Array.of(0xb0, 0x04, 0x00, 0x02, 0x00, 0x01);

      guarded.push(read);
      guarded.push(after);
      expect(guarded.pushed).toEqual([read, after]);
      expect(guarded.tripped).toEqual([]);
    }
  });

  test('plays mqttAcknowledgementCodes: each code of a PUBACK, a SUBACK and an UNSUBACK named, refused or unreadable, as its packet’s table says', () => {
    expect(VECTORS.mqttAcknowledgementCodes).toHaveLength(3);

    for (const { name, named, packet, type } of VECTORS.mqttAcknowledgementCodes) {
      for (let code = 0x00; code <= 0xff; code += 1) {
        const guarded = guardedOf(1_100);
        // its identifier 0x0102, and a Property Length of 0 before a SUBACK's or an UNSUBACK's code
        const bytes =
          type === 4
            ? [type << 4, 0x03, 0x01, 0x02, code]
            : [type << 4, 0x04, 0x01, 0x02, 0x00, code];
        const label = `${name}: ${hexOf(code)}`;

        guarded.push(Uint8Array.from(bytes));

        if (named.includes(code)) {
          expect(joinedOf(guarded.pushed), label).toEqual(bytes);
          expect(guarded.refusals, label).toEqual([]);
          expect(guarded.tripped, label).toEqual([]);
        } else if (code >= 0x80) {
          expect(joinedOf(guarded.pushed), label).toEqual([...bytes.slice(0, -1), 0x80]);
          expect(guarded.refusals, label).toEqual([{ code, identifier: 0x0102, type }]);
          expect(guarded.tripped, label).toEqual([]);
        } else {
          expect(guarded.pushed, label).toEqual([]);
          expect(guarded.tripped, label).toEqual([
            `${packet === 'UNSUBACK' ? 'an' : 'a'} ${packet} of ${hexOf(code)}, a Reason Code its table does not name`,
          ]);
        }
      }
    }
  });
});
