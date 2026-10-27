// ── Recording adapter ─────────────────────────────────────────────────────────

// An adapter the broker cases wrap around the side's, in memory or over MQTT 5, which notes the life
// the participant asks of each publication (spec 15.18, 15.22): what `expect lives` reads.

// dependencies

import { ParcelKind, readParcel } from '../../shared/broker-parcel';
import type { IBrokerAdapter, IBrokerPublication } from '../../shared/types';

// interfaces

/** What the participant asked of each publication's life, by what it carries, `null` for none. */
export interface ILives {
  credential: number | null | unknown[];
  open: number | null | unknown[];
  other: number | null | unknown[];
}

// helpers

// what a publication carries, as `expect lives` sorts it
const sortOf = (payload: Uint8Array): keyof ILives => {
  const read = readParcel(payload);

  if (!('parcel' in read)) {
    return 'other';
  }

  if (read.parcel.kind === ParcelKind.OPEN) {
    return 'open';
  }

  return read.parcel.kind === ParcelKind.DATA && read.parcel.credential !== undefined
    ? 'credential'
    : 'other';
};

// definition

/**
 * `inner`, each publication's life noted as it goes: `lives()` gives, for each sort, the one life
 * every publication of it was asked, or, where they differ or none went, what was seen, so that a
 * comparison with one life fails.
 */
export const createRecordingAdapter = <A extends IBrokerAdapter>(
  inner: A
): A & { lives(): ILives } => {
  const seen: Record<keyof ILives, (number | null)[]> = { credential: [], open: [], other: [] };
  const recording = Object.create(inner) as A & { lives(): ILives };
  const livesOf = (sort: keyof ILives): number | null | unknown[] => {
    const distinct = [...new Set(seen[sort])];

    return distinct.length === 1 ? (distinct[0] ?? null) : distinct;
  };

  return Object.assign(recording, {
    lives: (): ILives => {
      return { credential: livesOf('credential'), open: livesOf('open'), other: livesOf('other') };
    },
    publish: (publication: IBrokerPublication) => {
      seen[sortOf(publication.payload)].push(publication.expiresAfter ?? null);

      return inner.publish(publication);
    },
  });
};
