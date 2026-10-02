import { expect, test } from '@playwright/test';
import { createReadyStateMethods } from '../lifecycle';
import type { IReadyStateMethods } from '../types';
import {
  getReadyState,
  isReadyStateClosed,
  isReadyStateClosing,
  isReadyStateConnecting,
  isReadyStateOpen,
  isReadyStateReconnecting,
  isReadyStateUninitialized,
  READY_STATE_NAMES,
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  ReadyState,
  setReadyStateOpen,
  setReadyStateReconnecting,
  setReadyStateUninitialized,
} from '../ready-state';

// helpers

/** A transport end with nothing but its ready state, as every end is built. */
const createEnd = (): IReadyStateMethods => {
  const end: IReadyStateMethods = createReadyStateMethods(() => {
    return end;
  });

  return end;
};

test.describe('ReadyState', () => {
  test('keeps the WebSocket numbering for CONNECTING to CLOSED', () => {
    expect(ReadyState).toEqual({
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
      UNINITIALIZED: 4,
      RECONNECTING: 5,
    });
  });

  test('READY_STATE_NAMES reverses it', () => {
    for (const [name, value] of Object.entries(ReadyState)) {
      expect(READY_STATE_NAMES[value]).toBe(name);
    }
  });
});

test.describe('ready state', () => {
  test('an object never given a state is UNINITIALIZED', () => {
    expect(getReadyState(createEnd())).toBe(ReadyState.UNINITIALIZED);
  });

  test('CONNECTING (0) is a state like any other', () => {
    const end = createEnd();
    setReadyStateConnecting(end);
    expect(getReadyState(end)).toBe(ReadyState.CONNECTING);
  });

  test('each setter makes exactly its own predicate true', () => {
    const end = createEnd();
    const predicates = [
      isReadyStateConnecting,
      isReadyStateOpen,
      isReadyStateClosing,
      isReadyStateClosed,
      isReadyStateUninitialized,
      isReadyStateReconnecting,
    ];
    const setters = [
      setReadyStateConnecting,
      setReadyStateOpen,
      setReadyStateClosing,
      setReadyStateClosed,
      setReadyStateUninitialized,
      setReadyStateReconnecting,
    ];

    setters.forEach((set, index) => {
      set(end);
      expect(
        predicates.map((predicate) => {
          return predicate(end);
        })
      ).toEqual(
        predicates.map((_, position) => {
          return position === index;
        })
      );
    });
  });

  test('is kept per object', () => {
    const opened = createEnd();
    const untouched = createEnd();
    setReadyStateOpen(opened);
    expect(isReadyStateOpen(untouched)).toBe(false);
  });
});
