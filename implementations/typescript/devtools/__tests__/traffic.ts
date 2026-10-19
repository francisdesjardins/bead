import {
  CredentialScheme,
  FailureScope,
  ProtocolCode,
} from '../../src/router/client/router-client';
import { EnvelopeKind } from '../../src/router/shared/constants';
import type { ActivityRecord, ICallRecord, IEnvelopeRecord } from '../messages';

// Traffic as a client of the demo's procedures makes it, in the order the hook hears it: a REQUEST
// before the `tx` step that names its call, an answer's envelope before its `rx` step, a
// notification's envelope before its step.

// constants

/** When the traffic starts, in milliseconds since the epoch. */
export const T0 = 1_760_000_000_000;

/** The calls' ids, by what each shows. */
export const IDS = Object.freeze({
  command: 2,
  counter: 5,
  download: 11,
  fail: 7,
  relayed: 13,
  slow: 9,
  slowRelay: 17,
  stats: 15,
  token: 1,
  whoami: 3,
});

// helpers

const step = (
  fields: Partial<ICallRecord> & Pick<ICallRecord, 'direction' | 'procedureName' | 'startedAt'>
): ICallRecord => {
  return {
    connectionHandle: 'server',
    kind: 'call',
    procedureId: 1,
    serviceId: 1,
    serviceRevision: 1,
    source: 1,
    type: 'request',
    ...fields,
  };
};

const envelope = (
  at: number,
  { direction, header }: { direction: 'rx' | 'tx'; header: IEnvelopeRecord['header'] }
): IEnvelopeRecord => {
  return {
    at: T0 + at,
    connectionHandle: 'server',
    direction,
    header,
    kind: 'envelope',
    source: 1,
  };
};

/** A call made and answered: its REQUEST, its `tx` step, its answer's envelope, its `rx` step. */
const answered = ({
  at,
  callId,
  duration,
  name,
  procedureId,
  rx,
  tx,
}: {
  at: number;
  callId: number;
  duration: number;
  name: string;
  procedureId: number;
  rx: string;
  tx: string;
}): ActivityRecord[] => {
  const started = { callId, procedureId, procedureName: name, startedAt: T0 + at };

  return [
    envelope(at + 0.4, {
      direction: 'tx',
      header: { callId, kind: EnvelopeKind.REQUEST, procedureId, serviceId: 1 },
    }),
    step({ ...started, direction: 'tx', timeout: 5_000, tx }),
    envelope(at + duration, { direction: 'rx', header: { callId, kind: EnvelopeKind.RESULT } }),
    step({ ...started, direction: 'rx', duration, rx, timeout: 5_000, tx }),
  ];
};

// definition

/** The traffic, record by record. */
export const TRAFFIC: readonly ActivityRecord[] = Object.freeze([
  ...answered({
    at: 0,
    callId: IDS.token,
    duration: 4,
    name: 'token',
    procedureId: 12,
    rx: '"eyJ.made.up"',
    tx: '"writer"',
  }),
  // whoami presents a JWT and its answer announces a session
  envelope(6, {
    direction: 'tx',
    header: {
      callId: IDS.whoami,
      credentialScheme: CredentialScheme.JWT,
      kind: EnvelopeKind.REQUEST,
      procedureId: 1,
      serviceId: 1,
    },
  }),
  step({
    callId: IDS.whoami,
    credentialScheme: CredentialScheme.JWT,
    direction: 'tx',
    procedureName: 'whoami',
    stack: [
      {
        column: 12,
        functionName: 'callOf',
        line: 410,
        url: 'http://localhost:5173/node_modules/@francisdesjardins/bead/service-manager.js',
      },
      { column: 7, functionName: 'onWhoami', line: 42, url: 'http://localhost:5173/src/page.ts' },
      {
        column: 3,
        functionName: 'HTMLButtonElement.<anonymous>',
        line: 88,
        url: 'http://localhost:5173/src/page.ts',
      },
    ],
    startedAt: T0 + 6,
    tx: 'null',
  }),
  envelope(12, {
    direction: 'rx',
    header: {
      callId: IDS.whoami,
      credentialScheme: CredentialScheme.OPAQUE,
      kind: EnvelopeKind.RESULT,
    },
  }),
  step({
    callId: IDS.whoami,
    direction: 'rx',
    duration: 6,
    procedureName: 'whoami',
    rx: '{"role": "writer", "sub": "a"}',
    rxTree: {
      entries: [
        ['role', 'writer'],
        ['sub', 'a'],
      ],
      type: 'object',
    },
    startedAt: T0 + 6,
    tx: 'null',
  }),
  // the counter, paced: its answer, two notifications, its credits, and the server's failure that ends it
  envelope(15, {
    direction: 'tx',
    header: {
      callId: IDS.counter,
      kind: EnvelopeKind.REQUEST,
      opensSubscription: true,
      paced: true,
      procedureId: 5,
      serviceId: 1,
    },
  }),
  step({
    callId: IDS.counter,
    direction: 'tx',
    procedureId: 5,
    procedureName: 'counter',
    startedAt: T0 + 15,
    tx: 'null',
  }),
  envelope(19, { direction: 'rx', header: { callId: IDS.counter, kind: EnvelopeKind.RESULT } }),
  step({
    callId: IDS.counter,
    direction: 'rx',
    duration: 4,
    procedureId: 5,
    procedureName: 'counter',
    rx: '{"value": 41}',
    startedAt: T0 + 15,
  }),
  envelope(33, {
    direction: 'rx',
    header: { callId: IDS.counter, kind: EnvelopeKind.NOTIFICATION },
  }),
  step({
    direction: 'rx',
    procedureId: 5,
    procedureName: 'counter',
    rx: '{"value": 42}',
    startedAt: T0 + 33,
    type: 'notification',
  }),
  envelope(34, {
    direction: 'tx',
    header: { callId: IDS.counter, creditEnd: 2, kind: EnvelopeKind.CREDIT, paced: true },
  }),
  envelope(63, {
    direction: 'rx',
    header: { callId: IDS.counter, kind: EnvelopeKind.NOTIFICATION },
  }),
  step({
    direction: 'rx',
    procedureId: 5,
    procedureName: 'counter',
    rx: '{"value": 47}',
    startedAt: T0 + 63,
    type: 'notification',
  }),
  envelope(65, {
    direction: 'tx',
    header: { callId: IDS.counter, creditEnd: 3, kind: EnvelopeKind.CREDIT, paced: true },
  }),
  // fail answers with the procedure's own code
  envelope(90, {
    direction: 'tx',
    header: { callId: IDS.fail, kind: EnvelopeKind.REQUEST, procedureId: 7, serviceId: 1 },
  }),
  step({
    callId: IDS.fail,
    direction: 'tx',
    procedureId: 7,
    procedureName: 'fail',
    startedAt: T0 + 90,
    tx: 'null',
  }),
  envelope(93, { direction: 'rx', header: { callId: IDS.fail, kind: EnvelopeKind.FAILURE } }),
  step({
    callId: IDS.fail,
    direction: 'rx',
    duration: 3,
    error: {
      callId: IDS.fail,
      code: 7,
      detail: 'on purpose',
      message: 'failed',
      name: 'FailureError',
      origin: 'peer',
      relays: 0,
      scope: FailureScope.APPLICATION,
    },
    procedureId: 7,
    procedureName: 'fail',
    startedAt: T0 + 90,
    tx: 'null',
  }),
  // slow, cancelled
  envelope(100, {
    direction: 'tx',
    header: { callId: IDS.slow, kind: EnvelopeKind.REQUEST, procedureId: 9, serviceId: 1 },
  }),
  step({
    callId: IDS.slow,
    direction: 'tx',
    procedureId: 9,
    procedureName: 'slow',
    startedAt: T0 + 100,
    tx: '1250',
  }),
  // a download of 2.5 MiB, its answer a transfer
  envelope(1_400, {
    direction: 'tx',
    header: { callId: IDS.download, kind: EnvelopeKind.REQUEST, procedureId: 11, serviceId: 1 },
  }),
  step({
    callId: IDS.download,
    direction: 'tx',
    procedureId: 11,
    procedureName: 'download',
    startedAt: T0 + 1_400,
    tx: '2621440',
  }),
  envelope(1_420, {
    direction: 'rx',
    header: { callId: IDS.download, kind: EnvelopeKind.RESULT, total: 2_621_440 },
  }),
  envelope(1_421, {
    direction: 'tx',
    header: { callId: IDS.download, creditEnd: 2_621_440, kind: EnvelopeKind.CREDIT },
  }),
  envelope(1_432, {
    direction: 'rx',
    header: { callId: IDS.download, isLast: false, kind: EnvelopeKind.CHUNK, offset: 1_048_560 },
  }),
  envelope(1_350, { direction: 'tx', header: { callId: IDS.slow, kind: EnvelopeKind.CANCEL } }),
  step({
    callId: IDS.slow,
    direction: 'rx',
    duration: 1_250,
    error: { message: 'cancelled', name: 'CancelError' },
    procedureId: 9,
    procedureName: 'slow',
    startedAt: T0 + 100,
    tx: '1250',
  }),
  envelope(1_445, {
    direction: 'rx',
    header: { callId: IDS.download, isLast: true, kind: EnvelopeKind.CHUNK, offset: 2_097_120 },
  }),
  step({
    callId: IDS.download,
    direction: 'rx',
    duration: 46,
    procedureId: 11,
    procedureName: 'download',
    rx: '<2621440 bytes: 89 50 4e 47 …>',
    rxTree: { hex: '89 50 4e 47', length: 2_621_440, type: 'bytes' },
    startedAt: T0 + 1_400,
    tx: '2621440',
  }),
  // a command of the server's, answered by the page
  envelope(1_500, {
    direction: 'rx',
    header: { callId: IDS.command, kind: EnvelopeKind.REQUEST, procedureId: 20, serviceId: 1 },
  }),
  step({
    callId: IDS.command,
    direction: 'rx',
    procedureId: 20,
    procedureName: 'clock',
    rx: '"what time is it?"',
    startedAt: T0 + 1_500,
    type: 'command',
  }),
  envelope(1_501, { direction: 'tx', header: { callId: IDS.command, kind: EnvelopeKind.RESULT } }),
  step({
    callId: IDS.command,
    direction: 'tx',
    duration: 1,
    procedureId: 20,
    procedureName: 'clock',
    rx: '"what time is it?"',
    startedAt: T0 + 1_500,
    tx: '"14:03:13"',
    type: 'command',
  }),
  // a call to destination 7, refused beyond the server's relay
  envelope(1_600, {
    direction: 'tx',
    header: {
      callId: IDS.relayed,
      destinationId: 7,
      kind: EnvelopeKind.REQUEST,
      procedureId: 3,
      serviceId: 1,
    },
  }),
  step({
    callId: IDS.relayed,
    destinationId: 7,
    direction: 'tx',
    procedureId: 3,
    procedureName: 'increment',
    startedAt: T0 + 1_600,
    tx: '1',
  }),
  envelope(1_611, { direction: 'rx', header: { callId: IDS.relayed, kind: EnvelopeKind.FAILURE } }),
  step({
    callId: IDS.relayed,
    destinationId: 7,
    direction: 'rx',
    duration: 11,
    error: {
      callId: IDS.relayed,
      code: ProtocolCode.ACCESS_DENIED,
      destinationId: 7,
      detail: 'writers alone',
      message: 'denied',
      name: 'FailureError',
      origin: 'relayed',
      relays: 1,
      scope: FailureScope.PROTOCOL,
    },
    procedureId: 3,
    procedureName: 'increment',
    startedAt: T0 + 1_600,
    tx: '1',
  }),
  // read, refused before its call id was drawn
  step({
    direction: 'tx',
    procedureId: 3,
    procedureName: 'read',
    startedAt: T0 + 1_700,
    tx: 'null',
  }),
  step({
    direction: 'rx',
    duration: 0,
    error: {
      code: ProtocolCode.SESSION_REQUIRED,
      message: 'no session',
      name: 'FailureError',
      origin: 'local',
      relays: 0,
      scope: FailureScope.PROTOCOL,
    },
    procedureId: 3,
    procedureName: 'read',
    startedAt: T0 + 1_700,
    tx: 'null',
  }),
  // the server's failure ends the counter
  envelope(1_800, { direction: 'rx', header: { callId: IDS.counter, kind: EnvelopeKind.FAILURE } }),
  // stats waits on
  envelope(1_900, {
    direction: 'tx',
    header: { callId: IDS.stats, kind: EnvelopeKind.REQUEST, procedureId: 14, serviceId: 1 },
  }),
  step({
    callId: IDS.stats,
    direction: 'tx',
    procedureId: 14,
    procedureName: 'stats',
    startedAt: T0 + 1_900,
    timeout: 600_000,
    tx: 'null',
  }),
]);

/**
 * A call to destination 7 answered past a second, a notification and a cancel on its way, apart from
 * the traffic: a thread's widest labels.
 */
export const SLOW_RELAY: readonly ActivityRecord[] = Object.freeze([
  envelope(3_000, {
    direction: 'tx',
    header: {
      callId: IDS.slowRelay,
      destinationId: 7,
      kind: EnvelopeKind.REQUEST,
      procedureId: 4,
      serviceId: 1,
    },
  }),
  step({
    callId: IDS.slowRelay,
    destinationId: 7,
    direction: 'tx',
    procedureId: 4,
    procedureName: 'tally',
    startedAt: T0 + 3_000,
    tx: '1',
  }),
  envelope(3_500, {
    direction: 'rx',
    header: { callId: IDS.slowRelay, kind: EnvelopeKind.NOTIFICATION },
  }),
  envelope(3_600, {
    direction: 'tx',
    header: { callId: IDS.slowRelay, kind: EnvelopeKind.CANCEL },
  }),
  envelope(4_234, {
    direction: 'rx',
    header: { callId: IDS.slowRelay, kind: EnvelopeKind.RESULT },
  }),
  step({
    callId: IDS.slowRelay,
    destinationId: 7,
    direction: 'rx',
    duration: 1_234,
    procedureId: 4,
    procedureName: 'tally',
    rx: '"an answer longer than the room its lanes leave"',
    startedAt: T0 + 3_000,
    tx: '1',
  }),
]);
