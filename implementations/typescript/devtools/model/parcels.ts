// dependencies

import type { IEnvelopeRecord, IParticipantRecord } from '../messages';
import type { ICall } from './calls';
import { keepsCall, type IKeeper } from './filter';

// interfaces

/** The call and envelope proved to travel in a DATA parcel. */
export interface IParcelCall {
  call: ICall;
  envelope: IEnvelopeRecord;
}

// definition

/**
 * Joins complete DATA groups and router envelopes in capture order on one connection and direction.
 * Capture boundaries or the trace times anchor the order. A loss or ambiguity leaves parcels shown.
 */
export const parcelCallsOf = (
  records: readonly IParticipantRecord[],
  options: { calls: readonly ICall[]; hasGap: boolean }
): ReadonlyMap<IParticipantRecord, IParcelCall> => {
  const joined = new Map<IParticipantRecord, IParcelCall>();
  if (options.hasGap) {
    return joined;
  }
  const streams = new Map<string, IParticipantRecord[]>();
  for (const record of records) {
    if (record.connectionHandle === undefined || record.connection === undefined) {
      continue;
    }
    const key = `${String(record.source)}/${String(record.connection)}/${record.direction ?? ''}`;
    const stream = streams.get(key) ?? [];
    stream.push(record);
    streams.set(key, stream);
  }
  for (const stream of streams.values()) {
    const first = stream[0];
    if (first === undefined) {
      continue;
    }
    // ! `server` is local to a router, not a page-wide identity. Several owners cannot be joined.
    const calls = options.calls.filter((call) => {
      return call.connectionHandle === first.connectionHandle;
    });
    const owners = new Set(
      calls.map((call) => {
        return call.source;
      })
    );
    const participants = new Set(
      records
        .filter((record) => {
          return record.connectionHandle === first.connectionHandle;
        })
        .map((record) => {
          return `${String(record.source)}/${String(record.connection)}`;
        })
    );
    if (
      owners.size !== 1 ||
      participants.size !== 1 ||
      calls.some((call) => {
        return call.envelopesLetGo > 0;
      })
    ) {
      continue;
    }
    const envelopes = calls
      .flatMap((call) => {
        return call.envelopes
          .filter((envelope) => {
            return envelope.direction === first.direction;
          })
          .map((envelope) => {
            return { call, envelope };
          });
      })
      .sort((one, other) => {
        return one.envelope.at - other.envelope.at;
      });
    let boundary = false;
    let sequence: number | undefined;
    let parts: IParticipantRecord[] = [];
    const groups: IParticipantRecord[][] = [];
    let certain = true;
    for (const record of stream) {
      if (record.event !== 'parcel') {
        continue;
      }
      if (record.verdict !== undefined && record.verdict !== 'taken') {
        if (record.verdict === 'loss' || record.verdict === 'does-not-read') {
          certain = false;
        }
        continue;
      }
      if (
        record.sequence === undefined ||
        (sequence !== undefined && record.sequence !== sequence + 1)
      ) {
        certain = false;
      }
      sequence = record.sequence;
      if (record.parcelKind === 'OPEN' || record.parcelKind === 'ACCEPT') {
        boundary = record.sequence !== undefined && record.sequence <= 2;
      }
      if (record.parcelKind !== 'DATA') {
        continue;
      }
      parts.push(record);
      if (record.more === false) {
        groups.push(parts);
        parts = [];
      }
    }
    // A suffix not yet complete waits for another draw. A count mismatch never shifts the join.
    if (!certain || groups.length !== envelopes.length || parts.length > 0) {
      continue;
    }
    if (
      !boundary &&
      groups.some((group, index) => {
        const envelope = envelopes[index]?.envelope;
        const start = group[0];
        const end = group.at(-1);
        const next = groups[index + 1]?.[0];
        return (
          envelope === undefined ||
          start === undefined ||
          end === undefined ||
          (first.direction === 'tx'
            ? envelope.at > start.at
            : envelope.at < end.at || (next !== undefined && envelope.at >= next.at))
        );
      })
    ) {
      continue;
    }
    groups.forEach((group, index) => {
      const carried = envelopes[index];
      if (carried !== undefined) {
        for (const part of group) {
          joined.set(part, carried);
        }
      }
    });
  }
  return joined;
};

/** Unjoined parcels and connection traffic stay; a joined DATA follows its name and envelope. */
export const keepsParcel = (
  record: IParticipantRecord,
  options: { joined: ReadonlyMap<IParticipantRecord, IParcelCall>; keeper: IKeeper }
): boolean => {
  const carried = options.joined.get(record);
  return (
    carried === undefined ||
    ((carried.call.procedureName === undefined || keepsCall(carried.call, options.keeper)) &&
      options.keeper.keepsEnvelope(carried.envelope))
  );
};
