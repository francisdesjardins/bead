// ── The panel's calls ─────────────────────────────────────────────────────────

// What the panel makes of the records the hook sends: one entry a call, its steps and its envelopes
// together, and the notifications a subscription heard. A step and its envelopes name their call by
// its call id on its connection (debugging 4.1, 5.1), which the call holds while it is open and its
// router may draw again once it ended (spec 9.1): the record that opens a call — its REQUEST, or
// its first step, whichever comes first — starts an entry, and every record after it under that id
// joins it until another opens. A call refused before its id was drawn names none, and its answer
// meets it by its procedure and its start. A notification's step names no call: it meets the
// NOTIFICATION envelope heard just before it, on its procedure.

// dependencies

import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ActivityRecord, ICallRecord, IEnvelopeRecord } from '../messages';

// interfaces

/** A notification a subscription heard: its envelope, its step, or both, and when. */
export interface INotificationHeard {
  /** When it was heard: its envelope's time, else its step's. */
  at: number;
  envelope?: IEnvelopeRecord | undefined;
  step?: ICallRecord | undefined;
}

/** A call, as the panel holds it: what opened it, what answered it, and what crossed between. */
export interface ICall {
  /** The step that answered it: a call made's `rx`, a command's `tx`. */
  answer?: ICallRecord | undefined;
  /** The RESULT or the FAILURE that answered it, the first that came. */
  answerEnvelope?: IEnvelopeRecord | undefined;
  callId?: number | undefined;
  /** The CANCEL that ended it. */
  cancel?: IEnvelopeRecord | undefined;
  connectionHandle?: string | undefined;
  /** A subscription's FAILURE, once its answer came. */
  endEnvelope?: IEnvelopeRecord | undefined;
  /** Its envelopes, in the order the hook heard them: its last {@link ENVELOPES_KEPT} at most. */
  envelopes: IEnvelopeRecord[];
  /** The envelopes left out of {@link ICall.envelopes}, its first ones. */
  envelopesLetGo: number;
  /** Whether the page's client answered it, a command its server made. */
  isIncoming: boolean;
  /** Whether it is a notification heard with no subscription the panel holds, alone. */
  isNotification: boolean;
  /** Its place among the calls the panel took, in the order they opened: unlike its id, unique. */
  key: number;
  /** Its notifications, its last {@link NOTIFICATIONS_KEPT} at most. */
  notifications: INotificationHeard[];
  /** The notifications left out of {@link ICall.notifications}, its first ones. */
  notificationsLetGo: number;
  /** The step that opened it: a call made's `tx`, a command's `rx`. */
  opening?: ICallRecord | undefined;
  procedureId?: number | undefined;
  procedureName?: string | undefined;
  /** Its REQUEST envelope. */
  request?: IEnvelopeRecord | undefined;
  serviceId?: number | undefined;
  serviceRevision?: number | undefined;
  source: number;
}

/** A line between the calls: a burst the hook let go, or the page that came back. */
export interface IMarker {
  at: number;
  /** The records a gap let go. */
  count?: number | undefined;
  key: number;
  kind: 'gap' | 'reload';
}

/** The calls the panel holds, and what feeds them. */
export interface ICallBook {
  /** The calls it holds, in the order they opened: its last {@link ICallBookOptions.kept}. */
  readonly calls: readonly ICall[];
  /** The calls it let go, its first ones, past {@link ICallBookOptions.kept}. */
  readonly callsLetGo: number;
  /** Its markers, in their order among the calls. */
  readonly markers: readonly IMarker[];
  /** Marks a place between two calls: a gap of `count` records let go, or the page reloaded. */
  mark(marker: Omit<IMarker, 'key'>): void;
  /** A procedure's name, as a step of `source`'s told it, or of any client's. */
  nameOf(address: {
    procedureId: number;
    serviceId: number;
    source?: number | undefined;
  }): string | undefined;
  /** The records it holds, in the order it took them. */
  recordsOf(): ActivityRecord[];
  /** Takes one record, after those it took. */
  take(record: ActivityRecord): void;
}

export interface ICallBookOptions {
  /** The calls kept, past which the first are let go; 1,000 by default. */
  kept?: number | undefined;
  /** The side each source is, `client` unless it says otherwise. */
  sideOf?: ((source: number) => string | undefined) | undefined;
}

// constants

/** The calls a book keeps by default. */
export const CALLS_KEPT = 1_000;

/** The envelopes a call keeps, its last ones: a transfer may cross in thousands of chunks. */
export const ENVELOPES_KEPT = 200;

/** The notifications a subscription keeps, its last ones; the others are counted. */
export const NOTIFICATIONS_KEPT = 50;

/** The notification envelopes a source holds while their steps have yet to come. */
const PENDING_KEPT = 100;

/** The calls refused before their id was drawn, held while their answer may yet come. */
const UNNUMBERED_KEPT = 50;

// helpers

const kindOf = (envelope: IEnvelopeRecord): number => {
  return Number(envelope.header['kind']);
};

const isSameProcedure = (call: ICall, step: ICallRecord): boolean => {
  return (
    call.serviceId === undefined ||
    (call.serviceId === step.serviceId && call.procedureId === step.procedureId)
  );
};

const pushKept = <Item>(list: Item[], { item, kept }: { item: Item; kept: number }): number => {
  list.push(item);

  if (list.length <= kept) {
    return 0;
  }

  list.splice(0, list.length - kept);

  return 1;
};

// definition

/** A book of calls, empty, to feed record by record. */
export const createCallBook = (options?: ICallBookOptions): ICallBook => {
  const kept = options?.kept ?? CALLS_KEPT;
  const sideOf = options?.sideOf;
  const calls: ICall[] = [];
  const markers: IMarker[] = [];
  // the call open under each address: a source, its connection, a call id
  const open = new Map<string, ICall>();
  // each source's notification envelopes, waiting for their step
  const pending = new Map<number, { call: ICall; heard: INotificationHeard }[]>();
  const unnumbered: ICall[] = [];
  const names = new Map<string, string>();
  const order = new WeakMap<ActivityRecord, number>();
  let nextKey = 1;
  let callsLetGo = 0;
  let taken = 0;

  const addressOf = ({
    callId,
    connectionHandle,
    source,
  }: {
    callId: number;
    connectionHandle: string | undefined;
    source: number;
  }): string => {
    return `${String(source)}/${connectionHandle ?? ''}/${String(callId)}`;
  };

  const startCall = (fields: Partial<ICall> & { source: number }): ICall => {
    const call: ICall = {
      envelopes: [],
      envelopesLetGo: 0,
      isIncoming: false,
      isNotification: false,
      key: nextKey,
      notifications: [],
      notificationsLetGo: 0,
      ...fields,
    };

    nextKey += 1;
    calls.push(call);

    // the first calls go past what the book keeps, and what pointed at them with them
    while (calls.length > kept) {
      const [gone] = calls.splice(0, 1);

      callsLetGo += 1;

      for (const [address, held] of open) {
        if (held === gone) {
          open.delete(address);
        }
      }
    }

    while (
      markers.length > 0 &&
      calls.length > 0 &&
      (markers[0]?.key ?? 0) < (calls[0]?.key ?? 0)
    ) {
      markers.shift();
    }

    return call;
  };

  const procedureOf = (step: ICallRecord): Partial<ICall> => {
    return {
      procedureId: step.procedureId,
      procedureName: step.procedureName,
      serviceId: step.serviceId,
      serviceRevision: step.serviceRevision,
    };
  };

  // * a call made is a request on a client and a command on a server; one answered, the other way
  const isMadeStep = (step: ICallRecord): boolean => {
    return ((sideOf?.(step.source) ?? 'client') === 'client') === (step.type === 'request');
  };

  const takeNotification = (step: ICallRecord): void => {
    const waiting = pending.get(step.source) ?? [];
    const index = waiting.findIndex(({ call }) => {
      return call.serviceId === step.serviceId && call.procedureId === step.procedureId;
    });
    const met = index === -1 ? undefined : waiting.splice(index, 1)[0];

    if (met !== undefined) {
      met.heard.step = step;

      return;
    }

    // a notification whose envelope the panel did not hear stands alone
    startCall({ ...procedureOf(step), isNotification: true, opening: step, source: step.source });
  };

  const takeStep = (step: ICallRecord): void => {
    names.set(
      `${String(step.source)}/${String(step.serviceId)}/${String(step.procedureId)}`,
      step.procedureName
    );

    if (step.type === 'notification') {
      takeNotification(step);

      return;
    }

    const isMade = isMadeStep(step);
    const isOpening = step.direction === (isMade ? 'tx' : 'rx');
    const { callId, connectionHandle, source } = step;

    if (callId === undefined) {
      if (isOpening) {
        unnumbered.push(
          startCall({ ...procedureOf(step), isIncoming: !isMade, opening: step, source })
        );
        unnumbered.splice(0, Math.max(0, unnumbered.length - UNNUMBERED_KEPT));

        return;
      }

      const index = unnumbered.findIndex((call) => {
        return (
          call.source === source &&
          call.opening?.startedAt === step.startedAt &&
          isSameProcedure(call, step)
        );
      });
      const [met] = index === -1 ? [] : unnumbered.splice(index, 1);

      if (met === undefined) {
        startCall({ ...procedureOf(step), answer: step, isIncoming: !isMade, source });
      } else {
        met.answer = step;
      }

      return;
    }

    const address = addressOf({ callId, connectionHandle, source });
    let call = open.get(address);

    if (isOpening) {
      // its REQUEST, heard first, opened it; any other record under its id was an earlier call's
      if (
        call === undefined ||
        call.opening !== undefined ||
        call.answer !== undefined ||
        !isSameProcedure(call, step)
      ) {
        call = startCall({ callId, connectionHandle, isIncoming: !isMade, source });
        open.set(address, call);
      }

      Object.assign(call, procedureOf(step));
      call.opening = step;

      return;
    }

    if (call === undefined || call.answer !== undefined) {
      call = startCall({ callId, connectionHandle, isIncoming: !isMade, source });
      open.set(address, call);
    }

    Object.assign(call, procedureOf(step));
    call.answer = step;
  };

  const takeEnvelope = (envelope: IEnvelopeRecord): void => {
    const callId = Number(envelope.header['callId']);
    const { connectionHandle, direction, source } = envelope;
    const kind = kindOf(envelope);
    const address = addressOf({ callId, connectionHandle, source });
    let call = open.get(address);

    if (kind === EnvelopeKind.REQUEST) {
      const isIncoming = direction === 'rx';

      if (
        call === undefined ||
        call.request !== undefined ||
        call.answer !== undefined ||
        call.isIncoming !== isIncoming
      ) {
        call = startCall({ callId, connectionHandle, isIncoming, source });
        open.set(address, call);
      }

      call.request = envelope;
      call.serviceId ??= Number(envelope.header['serviceId']);
      call.procedureId ??= Number(envelope.header['procedureId']);
    } else if (call === undefined) {
      // * an envelope of a call the panel did not see open: a server opens even call ids (spec 3.5)
      call = startCall({ callId, connectionHandle, isIncoming: callId % 2 === 0, source });
      open.set(address, call);
    }

    call.envelopesLetGo += pushKept(call.envelopes, { item: envelope, kept: ENVELOPES_KEPT });

    if (kind === EnvelopeKind.RESULT || kind === EnvelopeKind.FAILURE) {
      if (call.answerEnvelope === undefined) {
        call.answerEnvelope = envelope;
      } else if (kind === EnvelopeKind.FAILURE) {
        call.endEnvelope ??= envelope;
      }
    } else if (kind === EnvelopeKind.CANCEL) {
      call.cancel ??= envelope;
    } else if (kind === EnvelopeKind.NOTIFICATION) {
      const heard: INotificationHeard = { at: envelope.at, envelope };
      const waiting = pending.get(source) ?? [];

      call.notificationsLetGo += pushKept(call.notifications, {
        item: heard,
        kept: NOTIFICATIONS_KEPT,
      });

      if (direction === 'rx') {
        waiting.push({ call, heard });
        waiting.splice(0, Math.max(0, waiting.length - PENDING_KEPT));
        pending.set(source, waiting);
      }
    }
  };

  return {
    get calls() {
      return calls;
    },
    get callsLetGo() {
      return callsLetGo;
    },
    mark: (marker) => {
      markers.push({ ...marker, key: nextKey });
      nextKey += 1;
    },
    markers,
    nameOf: ({ procedureId, serviceId, source }) => {
      const suffix = `/${String(serviceId)}/${String(procedureId)}`;

      if (source !== undefined) {
        const named = names.get(`${String(source)}${suffix}`);

        if (named !== undefined) {
          return named;
        }
      }

      for (const [address, name] of names) {
        if (address.endsWith(suffix)) {
          return name;
        }
      }

      return undefined;
    },
    recordsOf: () => {
      const records = calls.flatMap((call) => {
        return [
          ...(call.opening === undefined ? [] : [call.opening]),
          ...(call.answer === undefined ? [] : [call.answer]),
          ...call.envelopes,
          ...call.notifications.flatMap(({ step }) => {
            return step === undefined ? [] : [step];
          }),
        ];
      });

      return [...new Set(records)].sort((one, other) => {
        return (order.get(one) ?? 0) - (order.get(other) ?? 0);
      });
    },
    take: (record) => {
      if (record.kind === 'participant') {
        return;
      }
      taken += 1;
      order.set(record, taken);

      if (record.kind === 'call') {
        takeStep(record);
      } else {
        takeEnvelope(record);
      }
    },
  };
};
