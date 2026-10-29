import { expect, test } from '@playwright/test';
import { DEVTOOLS_HOOK_KEY, type IDevtoolsSource } from '../../../client/devtools-hook';
import { createBrokerParticipant } from '../broker-participant';
import { createMemoryBroker } from '../memory-broker';
import type { IParticipantDebugEvent } from '../participant-debug';

test('announces the participant once at protocol 1, watches independently, and withdraws when stopped', async () => {
  const sources: IDevtoolsSource[] = [];
  let withdrawals = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, DEVTOOLS_HOOK_KEY);
  Object.defineProperty(globalThis, DEVTOOLS_HOOK_KEY, {
    configurable: true,
    value: {
      register: (source: IDevtoolsSource) => {
        sources.push(source);
        return () => {
          withdrawals += 1;
        };
      },
    },
  });
  try {
    const participant = createBrokerParticipant({
      adapter: createMemoryBroker().adapter({ id: 'ada' }),
    });
    participant.transportClient();
    participant.transportClient();
    expect(sources).toHaveLength(1);
    expect(participant.isDebugging).toBe(false);
    const source = sources[0];
    expect(source).toMatchObject({ protocol: 1, side: 'participant' });
    if (source === undefined) {
      throw new Error('the participant announces itself');
    }
    const old = { call: () => {}, envelope: () => {} };
    const stopOld = source.watch(old);
    expect(participant.isDebugging).toBe(false);
    const first: IParticipantDebugEvent[] = [];
    const second: IParticipantDebugEvent[] = [];
    const stopFirst = source.watch({
      ...old,
      participant: (event) => {
        first.push(event);
      },
    });
    const stopSecond = source.watch({
      ...old,
      participant: (event) => {
        second.push(event);
      },
    });
    expect(first).toEqual([]);
    expect(source.inspect?.()).toMatchObject({
      id: 'ada',
      inbox: ['bead', 'i', 'ada'],
      isLinked: false,
      names: [],
    });
    expect(source.exposition()).toBeUndefined();
    await participant.start();
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(source.inspect?.()).toMatchObject({
      isLinked: true,
      incarnation: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
    stopFirst();
    stopFirst();
    stopOld();
    await participant.stop();
    await participant.stop();
    expect(withdrawals).toBe(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    stopSecond();
    expect(participant.isDebugging).toBe(false);
    const hidden = createBrokerParticipant({
      adapter: createMemoryBroker().adapter({ id: 'bob' }),
      devtools: false,
    });
    expect(sources).toHaveLength(1);
    await hidden.stop();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, DEVTOOLS_HOOK_KEY);
    } else {
      Object.defineProperty(globalThis, DEVTOOLS_HOOK_KEY, previous);
    }
  }
});
