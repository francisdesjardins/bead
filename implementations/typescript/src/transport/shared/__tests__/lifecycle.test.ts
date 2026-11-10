import { expect, test } from '@playwright/test';
import type { IReadyStateMethods } from '../types';
import { createEmitter } from '../emitter';
import { createEventMethods, createReadyStateMethods } from '../lifecycle';
import {
  setReadyStateClosed,
  setReadyStateClosing,
  setReadyStateConnecting,
  setReadyStateOpen,
  setReadyStateReconnecting,
  setReadyStateUninitialized,
} from '../ready-state';

test.describe('createEventMethods', () => {
  test('emits through the emitter and chains on whatever the getter returns', () => {
    const emitter = createEmitter<{ message: [data: string] }>();
    const end = { name: 'end' };
    const methods = createEventMethods(emitter, () => {
      return end;
    });
    const seen: string[] = [];
    const listener = (data: string) => {
      seen.push(data);
    };

    expect(methods.on('message', listener)).toBe(end);
    expect(methods.emit('message', 'a')).toBe(true);
    expect(methods.off('message', listener)).toBe(end);
    expect(methods.once('message', listener)).toBe(end);
    expect(methods.removeAllListeners()).toBe(end);
    expect(methods.emit('message', 'b')).toBe(false);
    expect(seen).toEqual(['a']);
  });

  // spec 15.1
  test('tells an "error" within a guard, dropping what a listener of it throws, and no other event', () => {
    const emitter = createEmitter<{ error: [error: Error]; message: [data: string] }>();
    const methods = createEventMethods(emitter, () => {
      return {};
    });
    const failure = new Error('an error listener that throws');
    const heard: Error[] = [];
    const told = new Error('told');

    methods.on('error', () => {
      throw failure;
    });
    methods.on('error', (error) => {
      heard.push(error);
    });
    methods.on('message', () => {
      throw failure;
    });

    expect(methods.emit('error', told)).toBe(true);
    expect(heard).toEqual([told]);
    // `message` guards none
    expect(() => {
      methods.emit('message', 'a');
    }).toThrow(failure);
  });
});

test.describe('createReadyStateMethods', () => {
  test("reads the state of the getter's object at each call, one predicate true at a time", () => {
    const methods: IReadyStateMethods = createReadyStateMethods(() => {
      return methods;
    });
    const end = methods;
    const predicates = () => {
      return [
        methods.isConnecting(),
        methods.isOpen(),
        methods.isClosing(),
        methods.isClosed(),
        methods.isUninitialized(),
        methods.isReconnecting(),
      ];
    };
    const setters = [
      setReadyStateConnecting,
      setReadyStateOpen,
      setReadyStateClosing,
      setReadyStateClosed,
      setReadyStateUninitialized,
      setReadyStateReconnecting,
    ];

    expect(methods.isUninitialized()).toBe(true);

    setters.forEach((set, index) => {
      set(end);
      expect(predicates()).toEqual(
        setters.map((_, position) => {
          return position === index;
        })
      );
    });
  });
});
