// ── Metrics registry ──────────────────────────────────────────────────────────

// dependencies

import { ProgrammerError } from '../../transport/shared/errors';
import { FailureScope, ProtocolCode } from './constants';
import { areOneName } from './identity';
import type {
  IFailure,
  IProcedure,
  ProcedureId,
  RouterSide,
  ServiceId,
  ServiceRevision,
} from './types';

// interfaces

/**
 * A procedure's series in the call families of one role — the calls a side makes, or those it
 * answers — under one `type`: what a router counts a call into, as it starts and as it ends.
 */
export interface IProcedureSeries {
  /**
   * Counts a call ended, as `ending` says, after `microseconds`, whole: its handled count, and its
   * duration in every bucket whose bound is it or more, its sum and its count.
   */
  end(ending: CallEnding, microseconds: number): void;
  /** Counts a call started. */
  start(): void;
}

/** What a router counts of a procedure's notifications at the side that notifies. */
export interface INotifyingSeries {
  /** Counts a subscription ended, other than by its client's cancel, by its failure, or with none. */
  dropped(failure: Pick<IFailure, 'code' | 'scope'> | undefined): void;
  /** Counts a notification that could not be handed to its transport for one subscription. */
  failed(): void;
  /** Counts a notification handed to its transport for one subscription. */
  sent(): void;
}

/** What a router counts of a procedure's notifications at the side that hears. */
export interface IHearingSeries {
  /** Counts a subscription ended, other than by its client's cancel, by its failure, or with none. */
  dropped(failure: Pick<IFailure, 'code' | 'scope'> | undefined): void;
  /** Counts a notification paired with a subscription its router holds. */
  heard(): void;
}

/** What a resolver declared counts into: its calls, and its notifications when its procedure notifies. */
export interface IResolverSeries {
  readonly calls: IProcedureSeries;
  readonly notifying: INotifyingSeries | undefined;
}

/**
 * What a router given a registry counts through, as it is built: the declarations of its side, and
 * the `_OTHER` series of its call families, which a call it has no declaration for counts into.
 */
export interface IRouterMetrics {
  /** `_OTHER`'s series among the calls its side makes. */
  readonly otherClient: IProcedureSeries;
  /** `_OTHER`'s series among the calls its side answers. */
  readonly otherServer: IProcedureSeries;

  /** A notification registered, on the side that hears. */
  declareNotification(procedure: DeclaredProcedure): IHearingSeries;
  /** A requester made, its series in the families of the calls its side makes. */
  declareRequester(procedure: DeclaredProcedure): IProcedureSeries;
  /**
   * A resolver registered, its series in the families of the calls its side answers; and, when its
   * procedure `notifies`, in those of the side that notifies.
   */
  declareResolver(procedure: DeclaredProcedure, options: { notifies: boolean }): IResolverSeries;
}

/**
 * A registry of Bead's metrics: what the routers given it count, summed, and its exposition, in the
 * Prometheus text format 0.0.4, as `spec/debugging.md` states them (sections 7 to 12). A router
 * given none counts nothing.
 */
export interface IMetricsRegistry {
  /**
   * What a router of `side` given the registry counts through, its `_OTHER` series made at 0 as it
   * is given it; a router calls it as it is built, and an application never.
   */
  attach(side: RouterSide): IRouterMetrics;
  /** Every series it holds, written as Prometheus scrapes 0.0.4, with its media type. */
  exposition(): IMetricsExposition;
}

/** A registry's exposition: its media type, and its text. */
export interface IMetricsExposition {
  /** `text/plain; version=0.0.4; charset=utf-8`, which Prometheus 3 requires of a target. */
  readonly contentType: string;
  /** Every line ended by a line feed, the last too; `''` while it holds no series. */
  readonly text: string;
}

/** How a registry is built. */
export interface IMetricsRegistryOptions {
  /**
   * The procedures its client families name at most, its server families as many, and its
   * notification families as many: 1,000 when not given; a whole number above 0, or it is a
   * {@link ProgrammerError}. `_OTHER`'s series count against none.
   */
  maximumProcedures?: number | undefined;
}

/** One series of the call families: its counts, its buckets, its sum, under its layout. */
interface ICallData {
  readonly buckets: Float64Array;
  /** How many calls it observed: its `_count`, and its `+Inf` bucket. */
  count: number;
  readonly handled: Float64Array;
  readonly layout: ILayout;
  readonly series: IProcedureSeries;
  started: number;
  /** Its `_sum`, held exactly: whole microseconds under one second, and whole seconds. */
  sumMicroseconds: number;
  sumSeconds: number;
}

/** The handled series a call family's series holds, in exposition order, and where each ending goes. */
interface ILayout {
  readonly slotOf: Int16Array;
  readonly slots: readonly { code?: string; outcome: string }[];
}

/** A procedure the registry holds: its address, its one name, and its series in each family. */
interface IEntry {
  readonly answered: Map<CallType, ICallData>;
  /** Its subscriptions dropped, none first, then under every code; `undefined` until declared. */
  dropped: Float64Array | undefined;
  heard: number | undefined;
  hearing: IHearingSeries | undefined;
  readonly made: Map<CallType, ICallData>;
  readonly name: string;
  notifying: INotifyingSeries | undefined;
  readonly procedureId: ProcedureId;
  sent: { failed: number; sent: number } | undefined;
  readonly serviceId: ServiceId;
}

/** A group of families, whose procedures the ceiling counts. */
interface IGroup {
  readonly keys: Set<number>;
  readonly what: string;
}

/** The three families of one role's calls: their duration, their handled and their started counts. */
interface ICallFamilies {
  readonly duration: IFamily;
  readonly handled: IFamily;
  readonly started: IFamily;
}

// types

/** A procedure as it is declared: its address, its name, and its service's revision. */
export type DeclaredProcedure = Pick<
  IProcedure,
  'procedureId' | 'procedureName' | 'serviceId' | 'serviceRevision'
>;

/** A family: its name, its help, and its type. */
type IFamily = readonly [name: string, help: string, type: string];

/**
 * How a call ended: a protocol failure by its code, as section 8 of `spec.md` names it, or one of
 * these, a failure of the procedure's own as `APPLICATION` and a code section 8 names none of as
 * `OTHER`.
 */
export type CallEnding = number;

/** A call's `type`, by its router's side. */
type CallType = 'command' | 'request';

// constants

/** What `exposition()` gives its text as. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** The endings of a call besides a protocol failure, which is its code. */
export const CallEnding = Object.freeze({
  APPLICATION: -6,
  CANCELLED: -3,
  CLOSED: -4,
  ERROR: -5,
  OTHER: -7,
  RESULT: -1,
  TIMEOUT: -2,
} as const);

/** What a registry holds at most when its options say nothing. */
export const METRICS_REGISTRY_DEFAULTS = Object.freeze({ maximumProcedures: 1_000 });

// an ending's place in a layout's table, the lowest ending at 0
const ENDING_OFFSET = 8;
const HIGHEST_CODE = 65;

// A66's bounds, in microseconds, and each one's `le`, OpenMetrics' canonical number for it, then
// +Inf's (spec/debugging.md 11.3): written from this table, never formatted
const BOUNDS: readonly number[] = Object.freeze([
  0, 10, 50, 100, 300, 600, 800, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 13_000,
  16_000, 20_000, 25_000, 30_000, 40_000, 50_000, 65_000, 80_000, 100_000, 130_000, 160_000,
  200_000, 250_000, 300_000, 400_000, 500_000, 650_000, 800_000, 1_000_000, 2_000_000, 5_000_000,
  10_000_000, 20_000_000, 50_000_000, 100_000_000,
]);
const LES: readonly string[] = Object.freeze([
  '0.0',
  '1e-05',
  '5e-05',
  '0.0001',
  '0.0003',
  '0.0006',
  '0.0008',
  '0.001',
  '0.002',
  '0.003',
  '0.004',
  '0.005',
  '0.006',
  '0.008',
  '0.01',
  '0.013',
  '0.016',
  '0.02',
  '0.025',
  '0.03',
  '0.04',
  '0.05',
  '0.065',
  '0.08',
  '0.1',
  '0.13',
  '0.16',
  '0.2',
  '0.25',
  '0.3',
  '0.4',
  '0.5',
  '0.65',
  '0.8',
  '1.0',
  '2.0',
  '5.0',
  '10.0',
  '20.0',
  '50.0',
  '100.0',
  '+Inf',
]);

const MICROSECONDS_PER_SECOND = 1_000_000;

// section 8's codes, in the order of their numbers, and each one's name
const CODES: readonly [code: number, name: string][] = Object.freeze(
  Object.entries(ProtocolCode)
    .map(([name, code]): [number, string] => {
      return [code, name];
    })
    .toSorted(([first], [second]) => {
      return first - second;
    })
);
const CODE_NAMES: ReadonlyMap<number, string> = new Map(CODES);

// the codes a procedure's series in the server families can end with (7.6), in the order of their
// numbers, application last: a route refused, a header that does not read and a relayed call are
// _OTHER's
const ANSWERED_CODES: ReadonlySet<number> = new Set([
  ProtocolCode.SUBSCRIPTION_UNSUPPORTED,
  ProtocolCode.SESSION_REQUIRED,
  ProtocolCode.ACCESS_DENIED,
  ProtocolCode.PAYLOAD_TOO_LARGE,
  ProtocolCode.CAPACITY_EXCEEDED,
  ProtocolCode.CREDENTIAL_UNSUPPORTED,
  ProtocolCode.CHUNK_INVALID,
  ProtocolCode.CREDIT_EXCEEDED,
  ProtocolCode.PAYLOAD_UNDECODABLE,
  ProtocolCode.TRANSFER_STALLED,
  ProtocolCode.PROCEDURE_FAILED,
]);

// a subscription dropped's codes, none first, then section 8's, then application and _OTHER
const DROP_SLOTS = CODES.length + 3;
const DROP_APPLICATION = CODES.length + 1;
const DROP_OTHER = CODES.length + 2;

// each family's name and help (spec/debugging.md 8.1), in the order of their names
const FAMILIES = Object.freeze({
  clientDuration: [
    'bead_client_call_duration_seconds',
    'How long each call this side made took, from its start to its end, in seconds.',
    'histogram',
  ],
  clientHandled: [
    'bead_client_call_handled_total',
    'Each call this side made, as it ended, by its outcome.',
    'counter',
  ],
  clientStarted: [
    'bead_client_call_started_total',
    'Each call this side made, as its router took it.',
    'counter',
  ],
  heard: [
    'bead_notifications_heard_total',
    'Each notification heard under a subscription this side holds.',
    'counter',
  ],
  sent: [
    'bead_notifications_sent_total',
    'Each notification for one subscription, handed to its transport or not.',
    'counter',
  ],
  serverDuration: [
    'bead_server_call_duration_seconds',
    'How long each call this side answered took, from its arrival to its end, in seconds.',
    'histogram',
  ],
  serverHandled: [
    'bead_server_call_handled_total',
    'Each call this side answered, as it ended, by its outcome.',
    'counter',
  ],
  serverStarted: [
    'bead_server_call_started_total',
    'Each call this side answered, as its request opened it.',
    'counter',
  ],
  dropped: [
    'bead_subscriptions_dropped_total',
    "Each subscription ended other than by its client's cancel, at this end.",
    'counter',
  ],
} as const);

// helpers

/**
 * A duration on the monotonic reading, `milliseconds`, in whole microseconds, its fraction dropped
 * (spec/debugging.md 11.1): the difference times 1,000, rounded to the nanosecond first, so a
 * reading's binary fraction — 0.3 − 0.2 — loses no microsecond.
 */
export const microsecondsOf = (milliseconds: number): number => {
  return Math.trunc(Math.round(milliseconds * 1_000_000) / 1_000);
};

/** The ending of a call that failed with `failure`: its code, `APPLICATION` or `OTHER`. */
export const endingOf = (failure: Pick<IFailure, 'code' | 'scope'>): CallEnding => {
  if (failure.scope === FailureScope.APPLICATION) {
    return CallEnding.APPLICATION;
  }

  return CODE_NAMES.has(failure.code) ? failure.code : CallEnding.OTHER;
};

/** A layout's slots: `result`, `failure` under each code given, `timeout` for a call made, then the rest. */
const layoutOf = ({
  codes,
  isMade,
}: {
  codes: readonly [ending: number, code: string][];
  isMade: boolean;
}): ILayout => {
  const slots = [
    { outcome: 'result' },
    ...codes.map(([, code]) => {
      return { code, outcome: 'failure' };
    }),
    ...(isMade ? [{ outcome: 'timeout' }] : []),
    { outcome: 'cancelled' },
    { outcome: 'closed' },
    { outcome: 'error' },
  ];
  const slotOf = new Int16Array(ENDING_OFFSET + HIGHEST_CODE + 1);
  const failureAt = new Map(
    codes.map(([ending], index) => {
      return [ending, index + 1];
    })
  );
  const errorAt = slots.length - 1;
  // a failure a procedure's exits never end with, answered through `respond` by hand, counts as the
  // nearest the series holds: _OTHER, else PROCEDURE_FAILED (spec/debugging.md 9.8); a timeout on a
  // call answered, as an error
  const failureFallback =
    failureAt.get(CallEnding.OTHER) ?? failureAt.get(ProtocolCode.PROCEDURE_FAILED) ?? errorAt;

  for (let ending = -ENDING_OFFSET; ending <= HIGHEST_CODE; ending += 1) {
    slotOf[ending + ENDING_OFFSET] = failureAt.get(ending) ?? failureFallback;
  }

  slotOf[CallEnding.RESULT + ENDING_OFFSET] = 0;
  slotOf[CallEnding.TIMEOUT + ENDING_OFFSET] = isMade ? codes.length + 1 : errorAt;
  slotOf[CallEnding.CANCELLED + ENDING_OFFSET] = errorAt - 2;
  slotOf[CallEnding.CLOSED + ENDING_OFFSET] = errorAt - 1;
  slotOf[CallEnding.ERROR + ENDING_OFFSET] = errorAt;

  return { slotOf, slots: Object.freeze(slots) };
};

// every code, section 8's 22 by their numbers, then application and _OTHER
const EVERY_CODE: readonly [number, string][] = Object.freeze([
  ...CODES,
  [CallEnding.APPLICATION, 'application'],
  [CallEnding.OTHER, '_OTHER'],
]);

// the layouts of the call families' series (7.6)
const LAYOUTS = Object.freeze({
  // a procedure's in the server families: its 12 codes
  answered: layoutOf({
    codes: [
      ...CODES.filter(([code]) => {
        return ANSWERED_CODES.has(code);
      }),
      [CallEnding.APPLICATION, 'application'],
    ],
    isMade: false,
  }),
  // _OTHER's in the server families: every code
  answeredOther: layoutOf({ codes: EVERY_CODE, isMade: false }),
  // a procedure's, and _OTHER's, in the client families: every code, and timeout
  made: layoutOf({ codes: EVERY_CODE, isMade: true }),
});

/** The bucket a duration of `microseconds` falls in first: the first bound it is or under. */
const bucketOf = (microseconds: number): number => {
  for (const [index, bound] of BOUNDS.entries()) {
    if (microseconds <= bound) {
      return index;
    }
  }

  return BOUNDS.length;
};

/** A series of the call families, at 0, under `layout`. */
const createCallData = (layout: ILayout): ICallData => {
  const data: ICallData = {
    buckets: new Float64Array(LES.length),
    count: 0,
    handled: new Float64Array(layout.slots.length),
    layout,
    series: {
      end: (ending, microseconds) => {
        const slot = layout.slotOf[ending + ENDING_OFFSET] ?? layout.slots.length - 1;
        const whole = microseconds > 0 ? Math.trunc(microseconds) : 0;
        const under = whole % MICROSECONDS_PER_SECOND;
        const bucket = bucketOf(whole);

        data.handled[slot] = (data.handled[slot] ?? 0) + 1;
        data.buckets[bucket] = (data.buckets[bucket] ?? 0) + 1;
        data.count += 1;
        data.sumSeconds += (whole - under) / MICROSECONDS_PER_SECOND;
        data.sumMicroseconds += under;

        if (data.sumMicroseconds >= MICROSECONDS_PER_SECOND) {
          data.sumMicroseconds -= MICROSECONDS_PER_SECOND;
          data.sumSeconds += 1;
        }
      },
      start: () => {
        data.started += 1;
      },
    },
    started: 0,
    sumMicroseconds: 0,
    sumSeconds: 0,
  };

  return data;
};

/** The slot a subscription dropped by `failure` counts in: its code's, or none's. */
const dropSlotOf = (failure: Pick<IFailure, 'code' | 'scope'> | undefined): number => {
  if (failure === undefined) {
    return 0;
  }

  const ending = endingOf(failure);

  if (ending === CallEnding.APPLICATION) {
    return DROP_APPLICATION;
  }

  if (ending === CallEnding.OTHER) {
    return DROP_OTHER;
  }

  return (
    CODES.findIndex(([code]) => {
      return code === ending;
    }) + 1
  );
};

/** A label's value as 0.0.4 writes one: a lone surrogate as U+FFFD, `\`, `"` and line feed escaped. */
const labelValueOf = (value: string): string => {
  return value
    .toWellFormed()
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
};

/** A `_sum` of whole seconds and microseconds, written exactly: never an exponent (12.5). */
const sumOf = ({ sumMicroseconds, sumSeconds }: ICallData): string => {
  if (sumMicroseconds === 0) {
    return String(sumSeconds);
  }

  return `${String(sumSeconds)}.${String(sumMicroseconds).padStart(6, '0').replace(/0+$/, '')}`;
};

/** The ceiling a registry is given, held: a whole number above 0, its default when not given. */
const maximumOf = (given: number | undefined): number => {
  const maximum = given ?? METRICS_REGISTRY_DEFAULTS.maximumProcedures;

  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new ProgrammerError(
      `maximumProcedures is a whole number above 0, not ${String(maximum)}`
    );
  }

  return maximum;
};

// definition

/**
 * A registry of Bead's metrics, which a router counts into once given it as its `metricsRegistry`,
 * and the servers and clients that build a router pass on: one given to two routers sums them. It
 * counts what its side declares — each resolver registered, each requester made, each notification
 * registered — each procedure keyed by its address under one name, and each service at one
 * revision, its series made at 0 as it is declared, and refuses, with a {@link ProgrammerError}, a
 * declaration of an address it holds under another name, of a name its service holds at another
 * address — two names one when their ASCII letters are read in one case (spec 16.6) — of a service
 * at another revision than it holds, or past `maximumProcedures`. Its
 * exposition is the Prometheus text format 0.0.4, at `/metrics` or appended to a scrape of that
 * format, each series written from one reading of its counts: Bead opens no port.
 *
 * @example
 * import { createMetricsRegistry, createServer } from '@francisdesjardins/bead/server';
 * import { createWSTransportServer } from '@francisdesjardins/bead/ws-transport-server';
 *
 * const metricsRegistry = createMetricsRegistry();
 * const server = createServer(
 *   { transport: createWSTransportServer({ WebSocketServer }) },
 *   { metricsRegistry }
 * );
 * const { contentType, text } = metricsRegistry.exposition();
 */
export const createMetricsRegistry = (options?: IMetricsRegistryOptions): IMetricsRegistry => {
  const maximum = maximumOf(options?.maximumProcedures);
  // every procedure declared, by its address
  const entries = new Map<number, IEntry>();
  // each service's names, and the procedure each names
  const names = new Map<ServiceId, Map<string, ProcedureId>>();
  // each service's one revision
  const revisions = new Map<ServiceId, ServiceRevision>();
  const groups = Object.freeze({
    answered: { keys: new Set<number>(), what: 'server families' },
    made: { keys: new Set<number>(), what: 'client families' },
    notifications: { keys: new Set<number>(), what: 'notification families' },
  });
  // _OTHER's series, in each role, by type
  const otherMade = new Map<CallType, ICallData>();
  const otherAnswered = new Map<CallType, ICallData>();

  // the name its service holds at another address that is one with `procedureName` by spec 16.6,
  // and that address; none when the service holds none
  const elsewhereOf = ({
    procedureName,
    serviceId,
  }: DeclaredProcedure): [name: string, procedureId: ProcedureId] | undefined => {
    for (const named of names.get(serviceId) ?? []) {
      if (areOneName(named[0], procedureName)) {
        return named;
      }
    }

    return undefined;
  };

  // the entry `procedure` is declared as, to `declared`, refused as `spec/debugging.md` 7.3 says
  const admit = (procedure: DeclaredProcedure, declared: readonly IGroup[]): IEntry => {
    const { procedureId, procedureName, serviceId, serviceRevision } = procedure;
    const key = serviceId * 0x1_00_00 + procedureId;
    const held = entries.get(key);
    const at = `${String(serviceId)}/${String(procedureId)}`;

    // * a name held at its address is taken as it is, exactly, with no fold
    if (held !== undefined && held.name !== procedureName) {
      throw new ProgrammerError(
        `the metrics registry holds ${at} as ${JSON.stringify(held.name)}, and is given ${JSON.stringify(procedureName)}: another name at its address`
      );
    }

    const elsewhere = held === undefined ? elsewhereOf(procedure) : undefined;

    if (elsewhere !== undefined) {
      throw new ProgrammerError(
        `the metrics registry holds ${JSON.stringify(elsewhere[0])} at ${String(serviceId)}/${String(elsewhere[1])}, and is given ${JSON.stringify(procedureName)} at ${at}: its name at another address`
      );
    }

    const revision = revisions.get(serviceId);

    if (revision !== undefined && revision !== serviceRevision) {
      throw new ProgrammerError(
        `the metrics registry holds service ${String(serviceId)} at revision ${String(revision)}, and is given ${at} at revision ${String(serviceRevision)}: another revision of its service`
      );
    }

    for (const { keys, what } of declared) {
      if (!keys.has(key) && keys.size >= maximum) {
        throw new ProgrammerError(
          `the metrics registry's ${what} name ${String(maximum)} procedures at most, and ${at} is one more: past the ceiling`
        );
      }
    }

    for (const { keys } of declared) {
      keys.add(key);
    }

    if (held !== undefined) {
      return held;
    }

    const entry: IEntry = {
      answered: new Map(),
      dropped: undefined,
      heard: undefined,
      hearing: undefined,
      made: new Map(),
      name: procedureName,
      notifying: undefined,
      procedureId,
      sent: undefined,
      serviceId,
    };
    const named = names.get(serviceId) ?? new Map<string, ProcedureId>();

    named.set(procedureName, procedureId);
    names.set(serviceId, named);
    revisions.set(serviceId, serviceRevision);
    entries.set(key, entry);

    return entry;
  };

  // the series of `type` in `byType`, made at 0 when it is not yet
  const callDataOf = (
    byType: Map<CallType, ICallData>,
    { layout, type }: { layout: ILayout; type: CallType }
  ): ICallData => {
    const known = byType.get(type);

    if (known !== undefined) {
      return known;
    }

    const made = createCallData(layout);

    byType.set(type, made);

    return made;
  };

  // an entry's subscriptions dropped, made at 0 under none and every code (7.6), once, whichever
  // end declares it first
  const dropsOf = (entry: IEntry): void => {
    entry.dropped ??= new Float64Array(DROP_SLOTS);
  };

  // counts a subscription of `entry` dropped by `failure`, under its code: every code has its series
  const drop = (entry: IEntry, failure: Pick<IFailure, 'code' | 'scope'> | undefined): void => {
    const { dropped } = entry;

    if (dropped !== undefined) {
      const slot = dropSlotOf(failure);

      dropped[slot] = (dropped[slot] ?? 0) + 1;
    }
  };

  const notifyingOf = (entry: IEntry): INotifyingSeries => {
    if (entry.notifying !== undefined) {
      return entry.notifying;
    }

    const counts = { failed: 0, sent: 0 };

    entry.sent = counts;
    dropsOf(entry);
    entry.notifying = {
      dropped: (failure) => {
        drop(entry, failure);
      },
      failed: () => {
        counts.failed += 1;
      },
      sent: () => {
        counts.sent += 1;
      },
    };

    return entry.notifying;
  };

  const hearingOf = (entry: IEntry): IHearingSeries => {
    if (entry.hearing !== undefined) {
      return entry.hearing;
    }

    entry.heard = 0;
    dropsOf(entry);
    entry.hearing = {
      dropped: (failure) => {
        drop(entry, failure);
      },
      heard: () => {
        entry.heard = (entry.heard ?? 0) + 1;
      },
    };

    return entry.hearing;
  };

  const attach = (side: RouterSide): IRouterMetrics => {
    // a client's router makes requests and answers commands, a server's the reverse (8.2)
    const madeType: CallType = side === 'client' ? 'request' : 'command';
    const answeredType: CallType = side === 'client' ? 'command' : 'request';
    const otherClient = callDataOf(otherMade, { layout: LAYOUTS.made, type: madeType });
    const otherServer = callDataOf(otherAnswered, {
      layout: LAYOUTS.answeredOther,
      type: answeredType,
    });

    return {
      otherClient: otherClient.series,
      otherServer: otherServer.series,

      declareNotification: (procedure) => {
        return hearingOf(admit(procedure, [groups.notifications]));
      },
      declareRequester: (procedure) => {
        const entry = admit(procedure, [groups.made]);

        return callDataOf(entry.made, { layout: LAYOUTS.made, type: madeType }).series;
      },
      declareResolver: (procedure, { notifies }) => {
        const entry = admit(
          procedure,
          notifies ? [groups.answered, groups.notifications] : [groups.answered]
        );

        return {
          calls: callDataOf(entry.answered, { layout: LAYOUTS.answered, type: answeredType })
            .series,
          notifying: notifies ? notifyingOf(entry) : undefined,
        };
      },
    };
  };

  const exposition = (): IMetricsExposition => {
    const lines: string[] = [];
    const ordered = [...entries.values()].toSorted((first, second) => {
      return first.serviceId - second.serviceId || first.procedureId - second.procedureId;
    });
    // a family's series, each by its labels: none written for a family that holds none (12.2)
    const writeFamily = ([name, help, type]: IFamily, samples: string[]): void => {
      if (samples.length > 0) {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
      }
    };
    const labelsOf = (entry: IEntry | undefined): string => {
      return entry === undefined
        ? 'service="_OTHER",procedure="_OTHER"'
        : `service="${String(entry.serviceId)}",procedure="${labelValueOf(entry.name)}"`;
    };
    // the call series of one role, procedures first, by their address, then _OTHER's; request first
    const callSeriesOf = (role: 'answered' | 'made'): [labels: string, data: ICallData][] => {
      const series: [string, ICallData][] = [];
      const others = role === 'made' ? otherMade : otherAnswered;

      for (const entry of [...ordered, undefined]) {
        const byType = entry === undefined ? others : entry[role];

        for (const type of ['request', 'command'] as const) {
          const data = byType.get(type);

          if (data !== undefined) {
            series.push([`${labelsOf(entry)},type="${type}"`, data]);
          }
        }
      }

      return series;
    };
    const writeCalls = (
      role: 'answered' | 'made',
      { duration, handled, started }: ICallFamilies
    ): void => {
      const series = callSeriesOf(role);

      writeFamily(
        duration,
        series.flatMap(([labels, data]) => {
          let running = 0;

          return [
            ...LES.map((le, index) => {
              running += data.buckets[index] ?? 0;

              return `${duration[0]}_bucket{${labels},le="${le}"} ${String(running)}`;
            }),
            `${duration[0]}_sum{${labels}} ${sumOf(data)}`,
            `${duration[0]}_count{${labels}} ${String(data.count)}`,
          ];
        })
      );
      writeFamily(
        handled,
        series.flatMap(([labels, data]) => {
          return data.layout.slots.map(({ code, outcome }, slot) => {
            const coded = code === undefined ? '' : `,code="${code}"`;

            return `${handled[0]}{${labels},outcome="${outcome}"${coded}} ${String(data.handled[slot] ?? 0)}`;
          });
        })
      );
      writeFamily(
        started,
        series.map(([labels, data]) => {
          return `${started[0]}{${labels}} ${String(data.started)}`;
        })
      );
    };

    writeCalls('made', {
      duration: FAMILIES.clientDuration,
      handled: FAMILIES.clientHandled,
      started: FAMILIES.clientStarted,
    });
    writeFamily(
      FAMILIES.heard,
      ordered.flatMap((entry) => {
        return entry.heard === undefined
          ? []
          : [`${FAMILIES.heard[0]}{${labelsOf(entry)}} ${String(entry.heard)}`];
      })
    );
    writeFamily(
      FAMILIES.sent,
      ordered.flatMap((entry) => {
        return entry.sent === undefined
          ? []
          : [
              `${FAMILIES.sent[0]}{${labelsOf(entry)},outcome="sent"} ${String(entry.sent.sent)}`,
              `${FAMILIES.sent[0]}{${labelsOf(entry)},outcome="failed"} ${String(entry.sent.failed)}`,
            ];
      })
    );
    writeCalls('answered', {
      duration: FAMILIES.serverDuration,
      handled: FAMILIES.serverHandled,
      started: FAMILIES.serverStarted,
    });
    writeFamily(
      FAMILIES.dropped,
      ordered.flatMap((entry) => {
        const { dropped } = entry;

        if (dropped === undefined) {
          return [];
        }

        return [...dropped].map((count, slot) => {
          const code =
            slot === 0
              ? ''
              : `,code="${slot === DROP_APPLICATION ? 'application' : slot === DROP_OTHER ? '_OTHER' : (CODES[slot - 1]?.[1] ?? '')}"`;

          return `${FAMILIES.dropped[0]}{${labelsOf(entry)}${code}} ${String(count)}`;
        });
      })
    );

    return Object.freeze({
      contentType: METRICS_CONTENT_TYPE,
      text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    });
  };

  return { attach, exposition };
};
