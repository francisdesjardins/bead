// dependencies

import type { IReadyStateMethods } from './types';

// constants

/** Where a transport end is in its life. A plain object rather than an `enum`, read the same way. */
export const ReadyState = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
  UNINITIALIZED: 4,
  RECONNECTING: 5,
} as const);

export type ReadyState = (typeof ReadyState)[keyof typeof ReadyState];

/** The reverse of {@link ReadyState}: `READY_STATE_NAMES[1]` is `'OPEN'`. */
export const READY_STATE_NAMES = Object.freeze({
  0: 'CONNECTING',
  1: 'OPEN',
  2: 'CLOSING',
  3: 'CLOSED',
  4: 'UNINITIALIZED',
  5: 'RECONNECTING',
} as const satisfies Record<ReadyState, keyof typeof ReadyState>);

// privates

// Keyed by the transport end itself, so its shared half and its transport's half hold one state
// without a writable field on it; an unset key reads as UNINITIALIZED.
const readyStates = new WeakMap<IReadyStateMethods, ReadyState>();

// helpers

const setReadyState = (end: IReadyStateMethods, rs: ReadyState): void => {
  readyStates.set(end, rs);
};

// definition

/** The state of `end`, or UNINITIALIZED for an object that was never given one. */
export const getReadyState = (end: IReadyStateMethods): ReadyState => {
  return readyStates.get(end) ?? ReadyState.UNINITIALIZED;
};

/** The state of `end` in lower case, for a message: `'open'`, `'closing'`… */
export const getReadyStateName = (end: IReadyStateMethods): string => {
  return READY_STATE_NAMES[getReadyState(end)].toLowerCase();
};

export const isReadyStateConnecting = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.CONNECTING;
};

export const isReadyStateOpen = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.OPEN;
};

export const isReadyStateClosing = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.CLOSING;
};

export const isReadyStateClosed = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.CLOSED;
};

export const isReadyStateUninitialized = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.UNINITIALIZED;
};

export const isReadyStateReconnecting = (end: IReadyStateMethods): boolean => {
  return getReadyState(end) === ReadyState.RECONNECTING;
};

// The setters are how a shared half, or a client transport's `define`, moves an end through the
// states; a consumer reads them through the end's own `is*()` instead.

export const setReadyStateConnecting = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.CONNECTING);
};

export const setReadyStateOpen = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.OPEN);
};

export const setReadyStateClosing = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.CLOSING);
};

export const setReadyStateClosed = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.CLOSED);
};

export const setReadyStateUninitialized = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.UNINITIALIZED);
};

export const setReadyStateReconnecting = (end: IReadyStateMethods): void => {
  setReadyState(end, ReadyState.RECONNECTING);
};
