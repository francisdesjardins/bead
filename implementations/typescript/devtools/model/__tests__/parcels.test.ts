import { expect, test } from '@playwright/test';
import type { IParticipantRecord } from '../../messages';
import { keeperOf } from '../filter';
import { keepsParcel, parcelCallsOf } from '../parcels';
import { trafficCall } from './book';

const capture = () => {
  const call = trafficCall('whoami');
  const envelopes = call.envelopes;
  const records: IParticipantRecord[] = envelopes.flatMap((envelope) => {
    const base = {
      at: envelope.at + (envelope.direction === 'tx' ? 0.1 : -0.1),
      source: 10,
      kind: 'participant' as const,
      event: 'parcel' as const,
      connectionHandle: call.connectionHandle,
      connection: 1,
      direction: envelope.direction as 'rx' | 'tx',
      parcelKind: 'DATA',
      sequence: 3,
      more: false,
      verdict: envelope.direction === 'tx' ? undefined : ('taken' as const),
    };
    return [base];
  });
  return { call, records };
};

test('joins DATA in order on its connection and direction and applies names, directions and envelope kinds', () => {
  const { call, records } = capture();
  const joined = parcelCallsOf(records, { calls: [call], hasGap: false });
  expect(joined.size).toBe(2);
  for (const [spec, expected] of [
    ['-whoami', 0],
    ['whoami', 2],
    ['d(rx)', 1],
    ['e(result)', 1],
    ['t(command)', 0],
  ] as const) {
    expect(
      records.filter((record) => {
        return keepsParcel(record, { joined, keeper: keeperOf(spec) });
      })
    ).toHaveLength(expected);
  }
  const ping = { ...records[0], parcelKind: 'PING' } as IParticipantRecord;
  expect(keepsParcel(ping, { joined, keeper: keeperOf('-whoami') })).toBe(true);
});

test('joins several MORE parts to one envelope and leaves copies outside the join', () => {
  const { call, records } = capture();
  const first = records[0] as IParticipantRecord;
  const parts = [
    { ...first, more: true },
    { ...first, more: true, verdict: 'copy' as const },
    { ...first, at: first.at + 0.1, sequence: 4 },
    ...records.slice(1),
  ];
  const joined = parcelCallsOf(parts, { calls: [call], hasGap: false });
  expect(joined.size).toBe(3);
  expect(joined.get(parts[0] as IParticipantRecord)?.envelope).toBe(call.envelopes[0]);
  expect(joined.get(parts[2] as IParticipantRecord)?.envelope).toBe(call.envelopes[0]);
});

test('keeps parcels when capture has a gap, a drop, an eviction, a partial group or an import without envelopes', () => {
  const { call, records } = capture();
  const cases = [
    parcelCallsOf(records, { calls: [call], hasGap: true }),
    parcelCallsOf(records, { calls: [], hasGap: false }),
    parcelCallsOf(records, { calls: [{ ...call, envelopesLetGo: 1 }], hasGap: false }),
    parcelCallsOf(
      records.map((record) => {
        return { ...record, more: true };
      }),
      { calls: [call], hasGap: false }
    ),
    parcelCallsOf([...records, { ...records[0], sequence: 7 } as IParticipantRecord], {
      calls: [call],
      hasGap: false,
    }),
    parcelCallsOf(
      records.map((record) => {
        return { ...record, verdict: 'loss' as const };
      }),
      { calls: [call], hasGap: false }
    ),
  ];
  for (const [index, joined] of cases.entries()) {
    expect(joined.size).toBe(index === 4 ? 1 : 0);
    expect(
      records
        .filter((record) => {
          return record.direction === 'tx';
        })
        .every((record) => {
          return keepsParcel(record, { joined, keeper: keeperOf('-whoami') });
        })
    ).toBe(true);
  }
});

test('keeps ambiguous router handles and participant connections and reads a complete imported capture', () => {
  const { call, records } = capture();
  expect(
    parcelCallsOf(records, { calls: [call, { ...call, source: call.source + 1 }], hasGap: false })
      .size
  ).toBe(0);
  expect(
    parcelCallsOf(
      [
        ...records,
        ...records.map((record) => {
          return { ...record, connection: 2 };
        }),
      ],
      { calls: [call], hasGap: false }
    ).size
  ).toBe(0);
  const imported = JSON.parse(JSON.stringify({ call, records })) as ReturnType<typeof capture>;
  expect(parcelCallsOf(imported.records, { calls: [imported.call], hasGap: false }).size).toBe(2);
});
