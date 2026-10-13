// ── The Metrics view ──────────────────────────────────────────────────────────

// What each client's registry counts, read by the package's own reader each second the view is
// shown: a row a procedure — the calls made or answered, those that failed, those in flight, the
// median and the p95 estimated within their bucket, its calls a second over the last minute, how
// the others ended — and its exposition, as a scrape reads it. A procedure's name shows its calls
// alone in the Calls view.

// dependencies

import { type IProcedureMetrics, metricsOf, quantileOf } from '../exposition';
import { type IReading, lineKeyOf, ratesOf } from '../model/history';
import { numberOf, spanOf } from '../model/words';
import { make, svgOf } from './dom';

// interfaces

/** What the Metrics view draws. */
export interface IMetricsView {
  /** Each client's last exposition: `null` for a client given no registry, none while unread. */
  expositions: ReadonlyMap<number, string | null>;
  /** Each client's readings, kept. */
  history: ReadonlyMap<number, readonly IReading[]>;
  /** Shows a procedure's calls alone, in the Calls view. */
  onProcedure: (procedure: string) => void;
  sources: readonly number[];
}

// constants

const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 18;

// helpers

const sparkOf = (points: readonly number[]): SVGElement => {
  const top = Math.max(...points, 1);
  const d = points
    .map((point, index) => {
      const x = points.length < 2 ? 0 : (index / (points.length - 1)) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - 2 - (point / top) * (SPARK_HEIGHT - 4);

      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return svgOf('svg', {
    attributes: {
      'aria-label': `calls a second over the last minute, ${numberOf(points.at(-1) ?? 0)} at the last reading`,
      class: 'spark',
      height: SPARK_HEIGHT,
      role: 'img',
      viewBox: `0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`,
      width: SPARK_WIDTH,
    },
    children: d === '' ? [] : [svgOf('path', { attributes: { d } })],
  });
};

const rowOf = (
  row: IProcedureMetrics,
  {
    onProcedure,
    readings,
  }: { onProcedure: (procedure: string) => void; readings: readonly IReading[] }
): HTMLElement | undefined => {
  const { buckets, count, notifications, outcomes, procedure, role, started, type } = row;
  const failed = [...outcomes].filter(([outcome]) => {
    return outcome !== 'result';
  });
  const failedCount = failed.reduce((sum, [, value]) => {
    return sum + value;
  }, 0);
  const endings = [...failed, ...notifications].filter(([, value]) => {
    return value > 0;
  });

  if (started === 0 && endings.length === 0) {
    return undefined;
  }

  const quantile = (value: number): string => {
    return count === 0 ? '' : spanOf((quantileOf(buckets, value) ?? 0) * 1_000);
  };
  const name = make('button', {
    attributes: { title: `Show the calls of ${procedure} alone`, type: 'button' },
    className: 'link',
    text: procedure,
  });

  name.addEventListener('click', () => {
    onProcedure(procedure);
  });

  return make('tr', {
    attributes: { 'data-procedure': procedure },
    children: [
      make('td', { children: [name] }),
      make('td', { text: `${role}${type === 'request' ? '' : `, ${type}`}` }),
      make('td', { className: 'num', text: numberOf(count) }),
      make('td', { className: 'num', text: failedCount === 0 ? '' : numberOf(failedCount) }),
      make('td', { className: 'num', text: started > count ? numberOf(started - count) : '' }),
      make('td', { className: 'num', text: quantile(0.5) }),
      make('td', { className: 'num', text: quantile(0.95) }),
      make('td', { children: [sparkOf(ratesOf(readings, lineKeyOf(row)))] }),
      make('td', {
        children: endings.map(([outcome, value]) => {
          const isFailure =
            outcomes.has(outcome) || outcome === 'not sent' || outcome.startsWith('dropped');

          return make('span', {
            className: isFailure ? 'chip failure' : 'chip',
            text: `${numberOf(value)} ${outcome}`,
          });
        }),
      }),
    ],
  });
};

// definition

/** The Metrics view, a section a client. */
export const metricsViewOf = (view: IMetricsView): Node[] => {
  if (view.sources.length === 0) {
    return [make('p', { className: 'note', text: 'No client announced itself yet.' })];
  }

  return view.sources.map((source) => {
    const text = view.expositions.get(source);
    const section = make('section', {
      attributes: { 'data-source': String(source) },
      children: [
        make('h2', {
          children: [
            `Client ${String(source)}`,
            make('span', { className: 'count', text: 'read each second while shown' }),
          ],
        }),
      ],
      className: 'sect registry',
    });

    if (text === undefined) {
      section.append(make('p', { className: 'note', text: 'Reading…' }));

      return section;
    }

    if (text === null) {
      section.append(
        make('p', {
          className: 'note',
          text: 'This client was given no metrics registry: give it one, as its metricsRegistry, to see what it counts.',
        })
      );

      return section;
    }

    const readings = view.history.get(source) ?? [];
    const rows = metricsOf(text, []).flatMap((row) => {
      const drawn = rowOf(row, { onProcedure: view.onProcedure, readings });

      return drawn === undefined ? [] : [drawn];
    });

    section.append(
      rows.length === 0
        ? make('p', { className: 'note', text: 'Nothing counted yet.' })
        : make('table', {
            children: [
              make('thead', {
                children: [
                  make('tr', {
                    children: [
                      'Procedure',
                      'Role',
                      'Ended',
                      'Failed',
                      'In flight',
                      'Median ≈',
                      'p95 ≈',
                      'Last minute',
                      'Endings',
                    ].map((head) => {
                      return make('th', { attributes: { scope: 'col' }, text: head });
                    }),
                  }),
                ],
              }),
              make('tbody', { children: rows }),
            ],
            className: 'plain',
          }),
      make('p', {
        className: 'note',
        text: 'A median and a p95 are estimated within their bucket, as Prometheus’s histogram_quantile does.',
      }),
      make('details', {
        children: [
          make('summary', { text: 'Its exposition, as a scrape reads it' }),
          make('pre', { text }),
        ],
        className: 'raw',
      })
    );

    return section;
  });
};
