// ── Debug filters ─────────────────────────────────────────────────────────────

// Bead's debug filters, `spec/debug-filters.json`, played against the TypeScript side's filter: what
// each filter reads as, which calls and envelopes it keeps, or why it is refused, and what a filter
// given as a function does from event to event. The C# side plays the same file.

// dependencies

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { EnvelopeKind } from '../constants';
import { filterDebug, filterEnvelopeDebug, parseDebugFilter } from '../debug-filter';
import type { DebugDirection, DebugType, IDebugEvent } from '../types';

// interfaces

/** A trace's event, as the file writes one: its direction, its type, its procedure's name. */
interface ICallFixture {
  direction: DebugDirection;
  procedureName: string;
  type: DebugType;
}

/** A router's event, as the file writes one: its direction, and its kind by its name. */
interface IEnvelopeFixture {
  direction: DebugDirection;
  kind: string;
}

/** What a filter reads as, its kinds by their names. */
interface IParsed {
  directions: string[];
  exclude: string[];
  include: string[];
  kinds: string[];
  types: string[];
}

interface IFilterEntry {
  filter: string;
  keeps?: { calls: number[]; envelopes: number[] };
  name: string;
  parsed?: IParsed;
  refused?: { reason: string; written: string };
}

/** One step of a filter given as a function. */
interface ISourceStep {
  event?: number;
  gives?: string;
  heard?: boolean;
  made?: boolean;
  throws?: true;
}

interface ISourceEntry {
  listener: 'call' | 'envelope';
  name: string;
  steps: ISourceStep[];
}

// constants

const {
  calls: CALLS,
  envelopes: ENVELOPES,
  filters: FILTERS,
  sources: SOURCES,
} = JSON.parse(
  readFileSync(new URL('../../../../../../spec/debug-filters.json', import.meta.url), 'utf8')
) as {
  calls: ICallFixture[];
  envelopes: IEnvelopeFixture[];
  filters: IFilterEntry[];
  sources: ISourceEntry[];
};

// each kind by its name in section 3.1, in lower case, and back
const KINDS = new Map(
  Object.entries(EnvelopeKind).map(([name, kind]) => {
    return [name.toLowerCase(), kind];
  })
);
const KIND_NAMES = new Map(
  [...KINDS].map(([name, kind]) => {
    return [kind, name];
  })
);

// each reason of the file, by how the TypeScript side's refusal opens
const REASONS: readonly [opening: string, reason: string][] = [
  ["a debug filter's selector names a value, not ", 'selector empty'],
  ["a debug filter's selector leaves no value empty, not ", 'value empty'],
  ['a debug filter holds a parenthesis', 'holds a parenthesis'],
  ['a debug filter takes a ', 'names nothing'],
];

// what a refusal names, as JSON quotes it, at its end
const WRITTEN = /, not ("(?:[^"\\]|\\.)*")$/;

// helpers

/** The event a call's fixture stands for. */
const callEventOf = ({ direction, procedureName, type }: ICallFixture): IDebugEvent => {
  return {
    callId: undefined,
    connectionHandle: undefined,
    direction,
    duration: undefined,
    options: undefined,
    procedureId: 1,
    procedureName,
    rx: undefined,
    serviceId: 1,
    serviceRevision: 1,
    startedAt: 0,
    tx: undefined,
    type,
  };
};

/** The event an envelope's fixture stands for. */
const envelopeEventOf = ({ direction, kind }: IEnvelopeFixture) => {
  return { direction, header: { kind: KINDS.get(kind) as EnvelopeKind } };
};

/** What the TypeScript side's refusal says, as the file writes it: its reason and what it names. */
const refusalOf = (error: unknown): { reason: string; written: string } | undefined => {
  if (!(error instanceof ProgrammerError)) {
    return undefined;
  }

  const reason = REASONS.find(([opening]) => {
    return error.message.startsWith(opening);
  })?.[1];
  const written = WRITTEN.exec(error.message)?.[1];

  return reason === undefined || written === undefined
    ? undefined
    : { reason, written: JSON.parse(written) as string };
};

/** The indices of the fixtures a listener filtered by `filter` hears, of each kind. */
const keptOf = (filter: string): { calls: number[]; envelopes: number[] } => {
  const calls: number[] = [];
  const envelopes: number[] = [];
  const hearsCall = filterDebug((_error, event) => {
    calls.push(event.procedureId);
  }, filter);
  const hearsEnvelope = filterEnvelopeDebug<{
    callIndex: number;
    direction: DebugDirection;
    header: { kind: EnvelopeKind };
  }>(({ callIndex }) => {
    envelopes.push(callIndex);
  }, filter);

  for (const [index, call] of CALLS.entries()) {
    hearsCall(null, { ...callEventOf(call), procedureId: index });
  }

  for (const [index, envelope] of ENVELOPES.entries()) {
    hearsEnvelope({ ...envelopeEventOf(envelope), callIndex: index });
  }

  return { calls, envelopes };
};

// definition

test.describe('the debug filters', () => {
  test.describe.configure({ retries: 0 });

  for (const { filter, keeps, name, parsed, refused } of FILTERS) {
    test(name, () => {
      if (refused !== undefined) {
        let thrown: unknown;

        try {
          parseDebugFilter(filter);
        } catch (error) {
          thrown = error;
        }

        expect(refusalOf(thrown), String(thrown)).toEqual(refused);

        // refused as a listener's filter too, as it is made
        expect(() => {
          return filterDebug(() => {
            return undefined;
          }, filter);
        }).toThrow(ProgrammerError);

        return;
      }

      const read = parseDebugFilter(filter);

      expect({
        ...read,
        kinds: (read.kinds ?? []).map((kind) => {
          return KIND_NAMES.get(kind);
        }),
      }).toEqual(parsed);
      expect(keptOf(filter)).toEqual(keeps);
    });
  }
});

test.describe('the debug filters given as functions', () => {
  test.describe.configure({ retries: 0 });

  for (const { listener: whose, name, steps } of SOURCES) {
    test(name, () => {
      // what the function does now: gives a filter, or throws
      let current: { gives?: string; throws?: true } = {};
      let heard = false;
      const source = (): string | undefined => {
        if (current.throws === true) {
          throw new Error('this filter fails, on purpose');
        }

        return current.gives;
      };
      let listener: ((index: number) => void) | undefined;

      for (const [index, step] of steps.entries()) {
        const at = `step ${String(index + 1)}`;

        if (step.gives !== undefined) {
          current = { gives: step.gives };
        }

        if (step.throws === true) {
          current = { throws: true };
        }

        if (step.made !== undefined) {
          let made: ((index: number) => void) | undefined;

          try {
            if (whose === 'call') {
              const hears = filterDebug(() => {
                heard = true;
              }, source);

              made = (event) => {
                hears(null, callEventOf(CALLS[event] as ICallFixture));
              };
            } else {
              const hears = filterEnvelopeDebug(() => {
                heard = true;
              }, source);

              made = (event) => {
                hears(envelopeEventOf(ENVELOPES[event] as IEnvelopeFixture));
              };
            }
          } catch {
            made = undefined;
          }

          expect(made !== undefined, at).toBe(step.made);
          listener = made;
        }

        if (step.event !== undefined) {
          heard = false;
          listener?.(step.event);

          expect(heard, at).toBe(step.heard);
        }
      }
    });
  }
});
