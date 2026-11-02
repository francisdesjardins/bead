// ── Fuzz target: a broker's parcel reader ─────────────────────────────────────

// Raw bytes, as a broker delivers a message, read by the parcel reader (spec 15.17), which gives a
// parcel, no parcel or a parcel that does not read, and never throws. A parcel that reads is written
// again: its writer refuses exactly those it refuses by design, a layout other than `0xB1`, an
// advisory kind or one not assigned, an OPEN or an ACCEPT that names no token or a receive bound out
// of range (15.18), and never with its read-back refusal; what it writes reads as the same parcel
// and writes again to the same bytes, as `broker-parcel-fuzz.test.ts` holds of the vectors'
// mutations. The C# side's `BrokerParcelTarget` and the Rust side's `broker-parcel` are its twins.

// dependencies

import { parcelBreakOf } from '../../src/transport/shared/__tests__/parcel-properties';
import { hexadecimalOf } from './refusal';

// definition

export const fuzz = (data: Uint8Array): void => {
  // ! Jazzer.js gives a Buffer, whose slices the reader would hand back as Buffers: a plain
  // Uint8Array, as a transport gives one, so a parcel compares with what its writer's bytes read as
  const broken = parcelBreakOf(Uint8Array.from(data));

  if (broken !== undefined) {
    throw new Error(`${broken}; input ${hexadecimalOf(data)}`);
  }
};
