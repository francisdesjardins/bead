// ── A time axis ───────────────────────────────────────────────────────────────

// Where the Timeline and the waterfall put a moment: a span of time across a width, and the ticks
// that mark it, each a round step of 1, 2 or 5 times a power of ten milliseconds, as many as the
// width reads.

// interfaces

/** A span of time, in milliseconds since the epoch. */
export interface ISpan {
  from: number;
  to: number;
}

/** A span across a width: where a moment sits, and where a place falls back to in time. */
export interface IScale {
  /** The moment a place stands for, within the span. */
  timeOf(x: number): number;
  /** Where a moment sits, held within the width. */
  xOf(at: number): number;
}

// constants

/** The ticks an axis aims at. */
const TICKS = 8;

// definition

/** A scale of `span` from `left` to `right`, a span of nothing widened to a millisecond. */
export const scaleOf = (span: ISpan, { left, right }: { left: number; right: number }): IScale => {
  const width = Math.max(span.to - span.from, 1);

  return {
    timeOf: (x) => {
      return span.from + ((Math.min(Math.max(x, left), right) - left) / (right - left)) * width;
    },
    xOf: (at) => {
      return (
        left +
        ((Math.min(Math.max(at, span.from), span.from + width) - span.from) / width) *
          (right - left)
      );
    },
  };
};

/** The round step between two ticks across `span`: 1, 2 or 5 times a power of ten milliseconds. */
export const tickStepOf = (span: ISpan): number => {
  const rough = Math.max(span.to - span.from, 1) / TICKS;
  const power = 10 ** Math.floor(Math.log10(rough));

  return (
    [1, 2, 5, 10]
      .map((factor) => {
        return factor * power;
      })
      .find((step) => {
        return step >= rough;
      }) ?? 10 * power
  );
};

/** The ticks across `span`, each a multiple of its step, in milliseconds after its start. */
export const ticksOf = (span: ISpan): number[] => {
  const step = tickStepOf(span);
  const ticks: number[] = [];

  for (let tick = 0; tick <= span.to - span.from; tick += step) {
    ticks.push(tick);
  }

  return ticks;
};
