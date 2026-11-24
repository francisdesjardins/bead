import { expect, test } from '@playwright/test';
import * as ws from 'ws';
import { closeFrameOf, frameOf, type IFrame, OPCODES } from '../../server/__tests__/http-peer';
import { createFrameMeter, HEAD_CHARGE, rateDueOf } from '../websocket-frame-meter';
import { createMessageBudget } from '../websocket-message-budget';

// the part of `ws`'s `Receiver` the test reads: the reader `ws` hands a socket's reads to
interface IReceiverLike {
  on(event: 'conclude', listener: (code: number) => void): unknown;
  on(event: 'message' | 'ping' | 'pong', listener: (data: Uint8Array) => void): unknown;
  write(chunk: Uint8Array): boolean;
}

type ReceiverConstructor = new (options: {
  isServer: boolean;
  maxPayload: number;
}) => IReceiverLike;

// `ws`'s own frame reader, which its types leave out
const { Receiver } = ws as unknown as { Receiver: ReceiverConstructor };

// the largest message a side takes by default, an envelope's (spec 15.3)
const MAXIMUM_MESSAGE_BYTES = 16_778_240;

// what a head of `frame` takes, masked, by the length it announces (RFC 6455 §5.2)
const headBytesOf = ({ payload }: IFrame): number => {
  return 6 + (payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8);
};

// what frames charge a message partway, once they all came (spec 15.12)
const chargeOf = (frames: readonly IFrame[]): number => {
  return frames.reduce((sum, frame) => {
    return sum + headBytesOf(frame) + frame.payload.length + HEAD_CHARGE;
  }, 0);
};

// a text message whole, a binary one in three fragments — 200 bytes, an empty one, 70,000 bytes, a
// ping and a pong between them — an empty binary message, then the peer's close
const TEXT = [{ fin: true, opcode: OPCODES.TEXT, payload: new TextEncoder().encode('hi') }];
const FRAGMENTED = [
  { fin: false, opcode: OPCODES.BINARY, payload: new Uint8Array(200).fill(7) },
  { fin: true, opcode: OPCODES.PING, payload: Uint8Array.of(1, 2, 3, 4) },
  { fin: false, opcode: OPCODES.CONTINUATION, payload: new Uint8Array(0) },
  { fin: true, opcode: OPCODES.PONG, payload: Uint8Array.of(5, 6, 7, 8) },
  { fin: true, opcode: OPCODES.CONTINUATION, payload: new Uint8Array(70_000).fill(9) },
];
const EMPTY = [{ fin: true, opcode: OPCODES.BINARY, payload: new Uint8Array(0) }];
const STREAM = Buffer.concat([...TEXT, ...FRAGMENTED, ...EMPTY, closeFrameOf(1000)].map(frameOf));

// the reads `STREAM` comes in, cut at each of `cuts`
const readsOf = (cuts: readonly number[]): Uint8Array[] => {
  const ends = [
    ...cuts.filter((cut) => {
      return cut > 0 && cut < STREAM.length;
    }),
    STREAM.length,
  ];

  return ends.map((end, index) => {
    return STREAM.subarray(index === 0 ? 0 : (ends[index - 1] ?? 0), end);
  });
};

/**
 * What the meter and `ws`'s reader each make of `reads`, the reader handed what the meter hands:
 * each message whole, by the read it ended in, its payload and what it charged; what the reader
 * emitted, by the read it came in; and the reads handed short.
 */
const playOf = (reads: readonly Uint8Array[]) => {
  const meter = createFrameMeter({
    maximumMessageBytes: MAXIMUM_MESSAGE_BYTES,
    maximumMessageFrames: 16_384,
    side: 'server',
  });
  const receiver = new Receiver({ isServer: true, maxPayload: MAXIMUM_MESSAGE_BYTES });
  const metered: string[] = [];
  const platform: string[] = [];
  const short: number[] = [];
  let at = 0;
  let payload = 0;
  let charged = 0;

  receiver.on('message', (data) => {
    platform.push(`${String(at)}: message of ${String(data.length)}`);
  });
  receiver.on('ping', (data) => {
    platform.push(`${String(at)}: ping of ${String(data.length)}`);
  });
  receiver.on('pong', (data) => {
    platform.push(`${String(at)}: pong of ${String(data.length)}`);
  });
  receiver.on('conclude', (code) => {
    platform.push(`${String(at)}: close ${String(code)}`);
  });

  for (const [index, chunk] of reads.entries()) {
    const { handed, shares, verdict } = meter.read(chunk);

    at = index;
    expect(verdict, `read ${String(index)}`).toBeUndefined();

    for (const share of shares) {
      payload = share.isFirst ? share.payload : payload + share.payload;
      charged = share.isFirst ? share.charge : charged + share.charge;

      if (share.isWhole) {
        metered.push(`${String(index)}: message of ${String(payload)}, ${String(charged)} charged`);
      }
    }

    if (handed < chunk.length) {
      short.push(index);
    }

    // ! a copy, since `ws` unmasks a payload where it lies; nothing past the peer's close, which
    // `ws` reads no more after, and refuses as a write after its end
    if (handed > 0) {
      receiver.write(Buffer.from(chunk.subarray(0, handed)));
    }
  }

  return { isEnded: meter.isEnded, isPartway: meter.isPartway, metered, platform, short };
};

test.describe('createFrameMeter', () => {
  // RFC 6455 §5.2, §5.4, §5.5; spec 15.3, 15.12
  test('reads frame heads split across reads, lengths of 7, 16 and 64 bits, control frames between fragments and an empty frame as its platform reads them', () => {
    const textEnd = frameOf(TEXT[0] as IFrame).length;
    const fragmentedEnd =
      textEnd +
      FRAGMENTED.map(frameOf).reduce((sum, { length }) => {
        return sum + length;
      }, 0);
    const lastHead = fragmentedEnd - 70_000 - 14;
    const splits = [
      // whole, in one read
      [],
      // every cut in two through the text frame, the first fragment's head and the ping after it
      ...Array.from({ length: textEnd + 230 }, (_, cut) => {
        return [cut];
      }),
      // every cut through the 64-bit head of the last fragment, and through the empty message
      ...Array.from({ length: 16 }, (_, offset) => {
        return [lastHead - 1 + offset];
      }),
      ...Array.from({ length: 10 }, (_, offset) => {
        return [fragmentedEnd - 1 + offset];
      }),
      // a byte a read through every head, the payloads in reads of 4 KiB
      Array.from({ length: STREAM.length }, (_, cut) => {
        return cut;
      }).filter((cut) => {
        return cut < lastHead + 20 || cut > fragmentedEnd - 2 || cut % 4_096 === 0;
      }),
    ];
    const expected = {
      isEnded: true,
      isPartway: false,
      metered: [
        `message of 2, ${String(chargeOf(TEXT))} charged`,
        `message of 70200, ${String(chargeOf(FRAGMENTED))} charged`,
        `message of 0, ${String(chargeOf(EMPTY))} charged`,
      ],
      platform: [
        'message of 2',
        'ping of 4',
        'pong of 4',
        'message of 70200',
        'message of 0',
        'close 1000',
      ],
      short: [],
    };

    for (const cuts of splits) {
      const played = playOf(readsOf(cuts));
      const textRead = (line: string): string => {
        return line.slice(line.indexOf(': ') + 2);
      };

      expect(
        {
          ...played,
          metered: played.metered.map(textRead),
          platform: played.platform.map(textRead),
        },
        `cut at ${cuts.length > 3 ? 'many' : String(cuts)}`
      ).toEqual(expected);
      // * each message ends in the read its platform reads it whole in
      expect(
        played.metered.map((line) => {
          return line.slice(0, line.indexOf(' of '));
        }),
        `cut at ${cuts.length > 3 ? 'many' : String(cuts)}`
      ).toEqual(
        played.platform
          .filter((line) => {
            return line.includes('message');
          })
          .map((line) => {
            return line.slice(0, line.indexOf(' of '));
          })
      );
    }

    // ! nothing past the peer's close: a read after it hands nothing
    const after = playOf([STREAM, frameOf(TEXT[0] as IFrame)]);

    expect([after.short, after.platform.at(-1)]).toEqual([[1], '0: close 1000']);
    expect(
      rateDueOf(1_000, { bodyGracePeriod: 5_000, minimumBodyBytesPerSecond: 240, payload: 1_440 })
    ).toBe(7_000);
  });

  // RFC 6455 §5.5, §7.1.7; spec 15.3, 15.12
  test('charges a frame’s head once whole, so a head that draws a verdict charges nothing and a cast-off at an earlier byte wins over it', () => {
    const meterOf = () => {
      return createFrameMeter({
        maximumMessageBytes: MAXIMUM_MESSAGE_BYTES,
        maximumMessageFrames: 16_384,
        side: 'server',
      });
    };
    const chargesOf = (shares: readonly { charge: number; isFirst: boolean }[]) => {
      return shares.map(({ charge, isFirst }) => {
        return { charge, isFirst };
      });
    };
    const first = frameOf({ fin: false, opcode: OPCODES.BINARY, payload: new Uint8Array(600) });
    // a ping whose 7 bits say 126: past a control frame's 125, judged at its second byte
    const longPing = frameOf({
      fin: true,
      length: 126,
      opcode: OPCODES.PING,
      payload: new Uint8Array(0),
    });

    // * a head split across reads: its message begins at its first byte, charging nothing, and the
    // read that makes it whole charges its 8 bytes and 128
    const split = meterOf();
    const begun = split.read(first.subarray(0, 3));
    const whole = split.read(first.subarray(3, 8));

    expect([chargesOf(begun.shares), chargesOf(whole.shares)]).toEqual([
      [{ charge: 0, isFirst: true }],
      [{ charge: 8 + HEAD_CHARGE, isFirst: false }],
    ]);

    // a head that draws its verdict at its second byte, behind 600 bytes of its message: the
    // message's charge stands, the ping's first byte charging nothing
    const behind = meterOf().read(Buffer.concat([first, longPing]));

    expect([behind.handed, behind.verdict?.code, chargesOf(behind.shares)]).toEqual([
      first.length,
      1002,
      [{ charge: 8 + 600 + HEAD_CHARGE, isFirst: true }],
    ]);

    // a message's first head that draws its verdict at its second byte, unmasked: none of its frame
    // is charged, its message never begun
    const unmasked = Uint8Array.of(0x82, 0x05);
    const alone = meterOf().read(unmasked);

    expect([alone.handed, alone.verdict?.code, alone.shares]).toEqual([0, 1002, []]);

    // * a budget of 500 the shares before the verdict are charged to: the cast-off, at the 501st
    // byte, wins over the verdict that comes after it
    const budget = createMessageBudget(500);
    const holder = budget.holderOf({
      castOff: () => {
        // the asking holder's cast-off is its caller's
      },
    });
    const outcomes = behind.shares.map(({ charge, isFirst }) => {
      if (isFirst) {
        holder.begin();
      }

      return holder.charge(charge);
    });

    expect([outcomes, budget.held]).toEqual([[false], 0]);

    // * exactly the budget, then that ping: it fits, and the verdict stands
    const fits = meterOf().read(
      Buffer.concat([
        frameOf({
          fin: false,
          opcode: OPCODES.BINARY,
          payload: new Uint8Array(500 - 8 - HEAD_CHARGE),
        }),
        longPing,
      ])
    );
    const edge = createMessageBudget(500).holderOf({
      castOff: () => {
        // never cast off
      },
    });

    edge.begin();
    expect([
      fits.verdict?.code,
      fits.shares.map(({ charge }) => {
        return edge.charge(charge);
      }),
    ]).toEqual([1002, [true]]);
  });
});
