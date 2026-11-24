// ── Fuzz target: the WebSocket frame meter ────────────────────────────────────

// Raw bytes as a WebSocket's frames, read by the frame meter (spec 15.3, 15.12) and by `ws`'s own
// reader, its `Receiver`, which is handed what the meter hands on. The first byte picks the side
// that reads, a server by its low bit clear, and the size of the reads the meter is fed, by its
// next three bits; the rest is the stream. The two agree on the bounds of each frame and the end of
// each message at the end of each read, and on whether the stream fails, and at which frame: where
// the meter draws a verdict, the reader, fed the rest of the stream, fails before that frame ends,
// or the stream ends first. A failure the reader alone finds in a close's payload — a body of one
// byte, a code RFC 6455 §7.4 does not allow — is not the meter's to judge, which reads no payload,
// and ends the comparison. Text is not checked as UTF-8. Anything else is a finding. The C# side's
// `WebSocketFramesTarget` and the Rust side's `websocket_frames` target are its twins.

// dependencies

import * as ws from 'ws';
import { createFrameMeter } from '../../src/transport/shared/websocket-frame-meter';
import { hexadecimalOf } from './refusal';

// interfaces

// the part of `ws`'s `Receiver` the target reads, its state among it, which its types leave out
interface IReceiverLike {
  // the opcode of the frame under way, the state it reads in, and what it buffers of a frame
  readonly _bufferedBytes: number;
  readonly _errored: boolean;
  readonly _opcode: number;
  readonly _state: number;
  on(event: string, listener: () => void): unknown;
  // the parse itself, below the stream's queue: a chunk, its encoding, and what its end is handed
  readonly _write: (...write: never[]) => void;
}

type ReceiverConstructor = new (options: {
  isServer: boolean;
  maxFragments: number;
  maxPayload: number;
  skipUTF8Validation: boolean;
}) => IReceiverLike;

// constants

const { Receiver } = ws as unknown as { Receiver: ReceiverConstructor };

// the bounds both read to: a message's bytes and its frames, small enough to be reached
const MAXIMUM_MESSAGE_BYTES = 1_024;
const MAXIMUM_MESSAGE_FRAMES = 8;

// the sizes of the reads the meter is fed, by the first byte's three bits after its lowest
const READ_SIZES = Object.freeze([1, 2, 3, 5, 8, 13, 64, Infinity]);

// `ws`'s reader between two frames: reading a head's first bytes, none of it buffered
const GET_INFO = 0;
const CLOSE = 0x8;

// helpers

// whether the reader reads between two frames
const isBetweenFrames = (receiver: IReceiverLike): boolean => {
  return receiver._state === GET_INFO && receiver._bufferedBytes === 0;
};

// what a write's end is handed, its failure read from the reader's state instead
const ignore = (): void => {};

// hands `bytes` to the reader, a copy, since it unmasks a payload where it lies
// ! straight to its parse: a stream's `write` settles each write by `process.nextTick`, which
// `--sync` never runs, so each input would leave its reader held until the heap runs out
const hand = (receiver: IReceiverLike, bytes: Uint8Array): void => {
  if (bytes.length > 0) {
    Reflect.apply(receiver._write, receiver, [Buffer.from(bytes), 'buffer', ignore]);
  }
};

// ! the reader, fed the rest of the stream a byte at a time, fails before the frame the meter drew
// its verdict at ends, or the stream ends first
const expectFailsWithin = (receiver: IReceiverLike, rest: Uint8Array): void => {
  for (let at = 0; at < rest.length; at += 1) {
    hand(receiver, rest.subarray(at, at + 1));

    if (receiver._errored) {
      return;
    }

    if (isBetweenFrames(receiver)) {
      throw new Error(
        `the reader read whole a frame the meter drew a verdict at, ${String(at)} bytes on`
      );
    }
  }
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const first = data[0] ?? 0;
  const side = (first & 1) === 0 ? 'server' : 'client';
  const size = READ_SIZES[(first >> 1) & 7] ?? 1;
  const stream = data.subarray(1);
  const meter = createFrameMeter({
    maximumMessageBytes: MAXIMUM_MESSAGE_BYTES,
    maximumMessageFrames: MAXIMUM_MESSAGE_FRAMES,
    side,
  });
  const receiver = new Receiver({
    isServer: side === 'server',
    maxFragments: MAXIMUM_MESSAGE_FRAMES,
    maxPayload: MAXIMUM_MESSAGE_BYTES,
    skipUTF8Validation: true,
  });
  // what the reader read: the messages it ended, and whether it read the peer's close
  const reader = { isConcluded: false, read: 0 };
  let ended = 0;

  receiver.on('message', () => {
    reader.read += 1;
  });
  receiver.on('conclude', () => {
    reader.isConcluded = true;
  });

  for (const event of ['error', 'ping', 'pong']) {
    receiver.on(event, () => {});
  }

  for (let at = 0; at < stream.length; at += size) {
    const chunk = stream.subarray(at, at + size);
    const { handed, shares, verdict } = meter.read(chunk);
    const where = `a ${side}'s read at ${String(at)} of ${hexadecimalOf(data)}`;

    hand(receiver, chunk.subarray(0, handed));

    // a close's payload the reader refuses, which the meter does not read
    if (receiver._errored) {
      if (receiver._opcode === CLOSE) {
        return;
      }

      throw new Error(`the reader failed where the meter read on: ${where}`);
    }

    if (verdict !== undefined) {
      expectFailsWithin(receiver, stream.subarray(at + handed));

      return;
    }

    for (const share of shares) {
      ended += share.isWhole ? 1 : 0;
    }

    if (ended !== reader.read) {
      throw new Error(
        `${String(ended)} messages ended, the reader read ${String(reader.read)}: ${where}`
      );
    }

    if (meter.isBetweenFrames !== isBetweenFrames(receiver)) {
      throw new Error(`the bounds of a frame differ: ${where}`);
    }

    // the peer's close, read by both at once: the reader reads nothing past it
    if (meter.isEnded !== reader.isConcluded) {
      throw new Error(`a close read by one alone: ${where}`);
    }

    if (meter.isEnded) {
      return;
    }
  }
};
