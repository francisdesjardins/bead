// ── Fuzz target: the debug filter's parser ────────────────────────────────────

// Raw bytes as a `debug` filter's spec (spec/debugging.md, section 6) and a procedure's name, parted
// by the first NUL, each read as UTF-8, a byte no sequence takes as U+FFFD and a leading U+FEFF
// kept; without a NUL, the name is `getStatus`. The parse returns, or refuses with a
// `ProgrammerError`; a filter it returns makes both listeners, and the call's one is asked of the
// name at each direction and type, its patterns matched whole. The C# side's `DebugFilterTarget` is
// its twin.

// dependencies

import {
  filterDebug,
  filterEnvelopeDebug,
  parseDebugFilter,
} from '../../src/router/shared/debug-filter';
import type {
  DebugDirection,
  DebugType,
  IDebugEvent,
  IDebugFilter,
} from '../../src/router/shared/types';
import { ProgrammerError } from '../../src/transport/shared/errors';
import { isRefused } from './refusal';

// constants

const DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const NAME = 'getStatus';
const DIRECTIONS: readonly DebugDirection[] = Object.freeze(['rx', 'tx']);
const TYPES: readonly DebugType[] = Object.freeze(['request', 'command', 'notification']);

// helpers

const unheard = (): void => {
  // a listener the fuzzer asks nothing of
};

const eventOf = (
  procedureName: string,
  { direction, type }: { direction: DebugDirection; type: DebugType }
): IDebugEvent => {
  return {
    callId: undefined,
    connectionHandle: undefined,
    direction,
    duration: undefined,
    options: undefined,
    procedureId: 1,
    procedureName,
    rx: undefined,
    serviceId: 2,
    serviceRevision: 1,
    startedAt: 0,
    tx: undefined,
    type,
  };
};

// definition

export const fuzz = (data: Uint8Array): void => {
  const at = data.indexOf(0);
  const spec = DECODER.decode(at === -1 ? data : data.subarray(0, at));
  const name = at === -1 ? NAME : DECODER.decode(data.subarray(at + 1));
  let filter: IDebugFilter = {};

  if (
    isRefused(ProgrammerError, () => {
      filter = parseDebugFilter(spec);
    })
  ) {
    return;
  }

  const listener = filterDebug(unheard, filter);

  filterEnvelopeDebug(unheard, filter);

  for (const direction of DIRECTIONS) {
    for (const type of TYPES) {
      listener(null, eventOf(name, { direction, type }));
    }
  }
};
