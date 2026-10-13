// ── The panel's filter ────────────────────────────────────────────────────────

// The package's own filter, as `bead:debug` reads one (debugging section 6), applied to what the
// panel holds: a step on its direction, its type and its procedure's name, an envelope on its
// direction and its kind. A call passes when one of its steps does, so `t(notification)` keeps the
// subscriptions that heard one. The quick buttons write their selectors into the filter's words, so
// what they do reads in its grammar.

// dependencies

import type { EnvelopeKind } from '../../src/router/shared/constants';
import {
  filterDebug,
  filterEnvelopeDebug,
  parseDebugFilter,
} from '../../src/router/shared/debug-filter';
import type { IDebugEvent } from '../../src/router/shared/types';
import type { ICallRecord, IEnvelopeRecord } from '../messages';
import type { ICall } from './calls';

// interfaces

/** A filter, read: what it keeps of a step and of an envelope. */
export interface IKeeper {
  keepsEnvelope(record: IEnvelopeRecord): boolean;
  keepsStep(record: ICallRecord): boolean;
}

// constants

/** What a filter's words are parted by, as debugging 6.2 has them. */
const SEPARATORS = /[,\t\n\v\f\r ]+/;

/** A keeper that keeps everything, as an empty filter does. */
export const KEEP_ALL: IKeeper = Object.freeze({
  keepsEnvelope: () => {
    return true;
  },
  keepsStep: () => {
    return true;
  },
});

// definition

/**
 * The keeper `spec` makes, read by the package's own filter; a spec that does not hold throws, with
 * the package's reason.
 */
export const keeperOf = (spec: string): IKeeper => {
  let isKept = false;
  const keep = (): void => {
    isKept = true;
  };

  // * read first, so a refusal throws here, with its reason, rather than in a listener
  parseDebugFilter(spec);

  const steps = filterDebug(keep, spec);
  const envelopes = filterEnvelopeDebug(keep, spec);

  return {
    keepsEnvelope: (record) => {
      isKept = false;
      envelopes({
        direction: record.direction === 'tx' ? 'tx' : 'rx',
        header: { kind: Number(record.header['kind']) as EnvelopeKind },
      });

      return isKept;
    },
    keepsStep: (record) => {
      isKept = false;
      steps(null, record as unknown as IDebugEvent);

      return isKept;
    },
  };
};

/** Whether `keeper` keeps a call: one of its steps, or, for one the panel heard no step of, its request. */
export const keepsCall = (call: ICall, keeper: IKeeper): boolean => {
  const steps = [
    ...(call.opening === undefined ? [] : [call.opening]),
    ...(call.answer === undefined ? [] : [call.answer]),
    ...call.notifications.flatMap(({ step }) => {
      return step === undefined ? [] : [step];
    }),
  ];

  if (steps.length > 0) {
    return steps.some((step) => {
      return keeper.keepsStep(step);
    });
  }

  return keeper.keepsStep({
    direction: call.isIncoming ? 'rx' : 'tx',
    kind: 'call',
    procedureId: call.procedureId ?? 0,
    procedureName: call.procedureName ?? '',
    serviceId: call.serviceId ?? 0,
    serviceRevision: call.serviceRevision ?? 0,
    source: call.source,
    startedAt: 0,
    type: call.isIncoming ? 'command' : 'request',
  });
};

/** The words of a filter, as debugging 6.2 parts them. */
export const wordsOf = (spec: string): string[] => {
  return spec.split(SEPARATORS).filter((word) => {
    return word !== '';
  });
};

/** Whether a filter holds `word`, in ASCII case. */
export const hasWord = (spec: string, word: string): boolean => {
  return wordsOf(spec).some((held) => {
    return held.toLowerCase() === word.toLowerCase();
  });
};

/** A filter with `word` added at its end, or taken out of it where it stood. */
export const toggleWord = (spec: string, word: string): string => {
  const words = wordsOf(spec);
  const kept = words.filter((held) => {
    return held.toLowerCase() !== word.toLowerCase();
  });

  return (kept.length === words.length ? [...words, word] : kept).join(', ');
};
