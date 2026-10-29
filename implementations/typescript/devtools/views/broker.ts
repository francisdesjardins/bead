// dependencies

import type { IParticipantInspection } from '../../src/transport/shared/participant-debug';
import type { IParticipantRecord, ISourceRecord } from '../messages';
import { bytesOf, clockOf } from '../model/words';
import { factsOf, make } from './dom';

// interfaces

/** The view's column filters, independent of the call filter. */
export interface IParcelFilters {
  kind: string;
  connection: string;
  verdict: string;
}

// helpers

/** DATA parts in capture order, before a column filter hides any part. */
const partsOf = (
  records: readonly IParticipantRecord[],
  hasGap: boolean
): Map<IParticipantRecord, string> => {
  const pending = new Map<string, { count: number; bytes: number; incomplete: boolean }>();
  const boundaries = new Set<string>();
  const labels = new Map<IParticipantRecord, string>();
  for (const record of records) {
    if (record.event === 'link' && record.state !== 'up') {
      for (const key of boundaries) {
        if (key.startsWith(`${String(record.source)}/`)) {
          boundaries.delete(key);
          pending.delete(key);
        }
      }
    }
    if (record.event !== 'parcel' || record.connection === undefined) {
      continue;
    }
    const key = `${String(record.source)}/${String(record.connection)}/${record.direction ?? ''}`;
    if (record.verdict === 'loss' || record.verdict === 'does-not-read') {
      pending.delete(key);
      boundaries.delete(key);
      continue;
    }
    if (record.sequence !== undefined && record.sequence <= 2 && !hasGap) {
      boundaries.add(key);
    }
    if (
      record.parcelKind !== 'DATA' ||
      (record.verdict !== undefined && record.verdict !== 'taken')
    ) {
      continue;
    }
    const group = pending.get(key) ?? {
      count: 0,
      bytes: 0,
      incomplete: hasGap || !boundaries.has(key),
    };
    group.count += 1;
    group.bytes += record.carriedBytes ?? 0;
    labels.set(
      record,
      `part ${String(group.count)} · ${bytesOf(group.bytes)} carried${group.incomplete ? ' · incomplete capture' : ''}`
    );
    if (record.more === true) {
      pending.set(key, group);
    } else {
      pending.delete(key);
      boundaries.add(key);
    }
  }
  return labels;
};

// definition

/** The participant's pulled levels beside its recorded parcels, transitions and reports. */
export const brokerViewOf = (options: {
  records: readonly IParticipantRecord[];
  sources: readonly ISourceRecord[];
  inspections: ReadonlyMap<number, IParticipantInspection>;
  letGo: number;
  filters: IParcelFilters;
  selected: IParticipantRecord | undefined;
  onFilter: (filters: IParcelFilters) => void;
  onSelect: (record: IParticipantRecord) => void;
  onState: () => void;
}): HTMLElement[] => {
  const { records, sources, inspections, letGo, filters, selected, onFilter, onSelect, onState } =
    options;
  const headers = sources
    .filter(({ side }) => {
      return side === 'participant';
    })
    .map((source) => {
      const reading = inspections.get(source.id) ?? source.inspection;
      const title = make('h2', {
        text: `Participant ${String(source.id)}${reading === undefined ? '' : ` · ${reading.id} · ${reading.isLinked ? 'up' : 'down'}`}`,
      });
      if (reading === undefined) {
        return make('div', {
          className: 'sect',
          children: [title, make('p', { text: 'No reading at the start of this watch.' })],
        });
      }
      const gauges = Object.entries(reading.gauges.counts).map(([name, count]) => {
        const bound = reading.gauges.ceilings[name];
        const label = `${name}: ${String(count)}${bound === undefined ? '' : ` / ${String(bound)}`}`;
        return make('div', {
          className: 'participant-gauge',
          children: [
            make('span', { text: label }),
            ...(bound !== undefined && Number.isFinite(bound) && bound > 0
              ? [
                  make('meter', {
                    attributes: {
                      min: '0',
                      max: String(bound),
                      value: String(count),
                      'aria-label': name,
                    },
                  }),
                ]
              : []),
          ],
        });
      });
      return make('div', {
        className: 'sect participant-header',
        attributes: { 'data-source': String(source.id) },
        children: [
          title,
          factsOf([
            ['Inbox', reading.inbox.join('/')],
            ['Incarnation', reading.incarnation ?? 'not linked'],
            ['Names held', reading.names.join(', ') || 'none'],
          ]),
          make('div', { className: 'participant-gauges', children: gauges }),
        ],
      });
    });
  const kinds = [
    ...new Set(
      records.flatMap(({ parcelKind }) => {
        return parcelKind === undefined ? [] : [parcelKind];
      })
    ),
  ].sort();
  const connections = [
    ...new Set(
      records.flatMap(({ connection }) => {
        return connection === undefined ? [] : [String(connection)];
      })
    ),
  ].sort();
  const verdicts = [
    ...new Set(
      records.flatMap(({ verdict }) => {
        return verdict === undefined ? [] : [verdict];
      })
    ),
  ].sort();
  const controls = (['kind', 'connection', 'verdict'] as const).map((field) => {
    const values = field === 'kind' ? kinds : field === 'connection' ? connections : verdicts;
    const select = make('select', {
      attributes: { 'aria-label': `Parcel ${field}` },
      children: [
        make('option', {
          attributes: { value: '' },
          text: `All ${field === 'kind' ? 'kinds' : field === 'connection' ? 'connections' : 'verdicts'}`,
        }),
        ...values.map((value) => {
          return make('option', { attributes: { value }, text: value });
        }),
      ],
    }) as HTMLSelectElement;
    select.value = filters[field];
    select.addEventListener('change', () => {
      onFilter({ ...filters, [field]: select.value });
    });
    return make('label', { children: [field, select] });
  });
  const state = make('button', { text: 'Envelope credit → State' });
  state.addEventListener('click', onState);
  const parts = partsOf(records, letGo > 0);
  const heads = [
    'Time',
    'Participant',
    'Direction',
    'Kind',
    'Connection',
    'Sequence',
    'Topic',
    'Bytes',
    'Carried / parts',
    'Verdict',
  ];
  const rows = records
    .filter((record) => {
      return (
        record.event !== 'parcel' ||
        ((filters.kind === '' || record.parcelKind === filters.kind) &&
          (filters.connection === '' || String(record.connection) === filters.connection) &&
          (filters.verdict === '' || record.verdict === filters.verdict))
      );
    })
    .map((record) => {
      const fields =
        record.event === 'parcel'
          ? [
              clockOf(record.at),
              String(record.source),
              record.direction ?? '·',
              record.parcelKind ?? 'no prefix',
              record.connection === undefined
                ? '·'
                : `${String(record.connection)}${record.connectionHandle === undefined ? '' : ` · ${record.connectionHandle}`}`,
              record.sequence === undefined ? '·' : String(record.sequence),
              record.topic?.join('/') ?? '·',
              bytesOf(record.bytes ?? 0),
              record.parcelKind === 'DATA'
                ? `${parts.get(record) ?? `${String(record.carriedBytes ?? 0)} carried`} · ${record.more === true ? 'MORE' : 'final'}`
                : '·',
              record.verdict ?? 'attempt',
            ]
          : undefined;
      const row = make('tr', {
        className:
          record.event === 'report'
            ? 'participant-report'
            : record.event === 'parcel'
              ? ''
              : 'participant-transition',
        attributes: {
          tabindex: '0',
          'aria-selected': String(record === selected),
          'data-event': record.event,
        },
        children:
          fields === undefined
            ? [
                make('td', {
                  attributes: { colspan: String(heads.length) },
                  text: `${clockOf(record.at)} · Participant ${String(record.source)} · ${record.event === 'report' ? `Error: ${record.report ?? ''}` : record.event === 'link' ? `Link ${record.state ?? ''}${record.ended === undefined ? '' : ` · ended ${record.ended.join(', ') || 'none'}`}` : `${record.name ?? ''} ${record.isHeld === true ? 'held' : 'let go'}`}`,
                }),
              ]
            : fields.map((text) => {
                return make('td', { text });
              }),
      });
      row.addEventListener('click', () => {
        onSelect(record);
      });
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(record);
        }
      });
      return row;
    });
  return [
    ...headers,
    make('div', { className: 'participant-controls', children: [...controls, state] }),
    make('p', {
      className: 'note',
      text: `Last 1,000 participant records · ${String(letGo)} let go. A publication is an attempt. Payloads, credentials and the acceptor’s half are omitted.`,
    }),
    ...(records.length === 0
      ? [
          make('p', {
            className: 'note',
            text: 'No parcels recorded. Open a connection while recording to see its traffic.',
          }),
        ]
      : []),
    make('div', {
      className: 'participant-split',
      children: [
        make('div', {
          className: 'participant-table',
          children: [
            make('table', {
              className: 'plain',
              children: [
                make('thead', {
                  children: [
                    make('tr', {
                      children: heads.map((text) => {
                        return make('th', { attributes: { scope: 'col' }, text });
                      }),
                    }),
                  ],
                }),
                make('tbody', { children: rows }),
              ],
            }),
          ],
        }),
        make('aside', {
          className: 'participant-detail',
          attributes: { 'aria-label': 'Parcel detail' },
          children: [
            make('h2', { text: 'Recorded fields' }),
            selected === undefined
              ? make('p', { text: 'Select a row to inspect its recorded fields.' })
              : make('pre', { text: JSON.stringify(selected, null, 2) }),
          ],
        }),
      ],
    }),
  ];
};
