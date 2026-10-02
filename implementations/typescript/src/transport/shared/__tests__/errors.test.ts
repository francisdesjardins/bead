import { expect, test } from '@playwright/test';
import {
  CancelError,
  ConnectError,
  GenericError,
  ProgrammerError,
  ReadyStateError,
  ReconnectError,
  TimeoutError,
  reasonMessage,
  toError,
  wrapReason,
} from '../errors';
import { ReadyState } from '../ready-state';

test.describe('errors', () => {
  test('every transport error is a GenericError with its own name', () => {
    const errors = [
      new CancelError(),
      new ConnectError(),
      new ProgrammerError(),
      new ReadyStateError(ReadyState.CLOSED, ReadyState.OPEN),
      new ReconnectError(),
      new TimeoutError(10),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(GenericError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
    }
  });

  test('carries no message unless given one', () => {
    for (const error of [
      new CancelError(),
      new ConnectError(),
      new GenericError(),
      new ProgrammerError(),
      new ReconnectError(),
    ]) {
      expect(error.message).toBe('');
      expect(error.stack).toBeDefined();
    }
    expect(new GenericError()).not.toBeInstanceOf(TypeError);
    expect(new CancelError('x').message).toBe('x');
    expect(new GenericError('i_am_a_test').message).toBe('i_am_a_test');
  });

  test('ReadyStateError names both states', () => {
    const error = new ReadyStateError(ReadyState.CLOSED, ReadyState.OPEN);
    expect(error.message).toBe('ReadyState Error: got CLOSED expected OPEN');
    expect(error.got).toBe(ReadyState.CLOSED);
    expect(error.expected).toBe(ReadyState.OPEN);
  });

  test('TimeoutError keeps the milliseconds waited, and says them', () => {
    const error = new TimeoutError(5_000);
    expect(error.timeout).toBe(5_000);
    expect(error.message).toContain('5000');
  });

  test('keeps the original reason as cause', () => {
    const reason = new Error('root');
    expect(new ConnectError('wrapped', { cause: reason }).cause).toBe(reason);
  });
});

test.describe('reasonMessage', () => {
  test('is an Error message, or what the non-Error throw rule calls the value', () => {
    expect(reasonMessage(new Error('e'))).toBe('e');
    expect(reasonMessage('s')).toBe('s');
    expect(reasonMessage(3)).toBe('3');
    expect(reasonMessage({})).toBe('Non-error thrown');
  });
});

test.describe('wrapReason', () => {
  test('words an error class after the reason and keeps it as cause', () => {
    const reason = new Error('refused');
    const error = wrapReason(ConnectError, reason);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error.message).toBe('refused');
    expect(error.cause).toBe(reason);
  });
});

test.describe('toError', () => {
  test('passes an Error through and wraps anything else', () => {
    const error = new Error('e');
    expect(toError(error)).toBe(error);
    expect(toError('s')).toBeInstanceOf(GenericError);
    expect(toError('s').cause).toBe('s');
  });
});
