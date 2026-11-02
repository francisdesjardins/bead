import { expect, test } from '@playwright/test';
import { nextTask } from '../../../transport/shared/later-task';
import { createIntake } from '../intake';

// an intake of `limits` whose port records each pause and resume
const recording = (limits: { maximumUntakenBytes: number; maximumUntakenEnvelopes: number }) => {
  const paces: string[] = [];
  const intake = createIntake<'a' | 'b'>(
    {
      pause: (connectionHandle) => {
        paces.push(`pause ${connectionHandle}`);
      },
      resume: (connectionHandle) => {
        paces.push(`resume ${connectionHandle}`);
      },
    },
    limits
  );

  return { intake, paces };
};

test.describe('createIntake', () => {
  // spec 15.12.17, 15.12.18
  test('pauses a connection once what it handed within one task reaches either bound, once', () => {
    const { intake, paces } = recording({ maximumUntakenBytes: 100, maximumUntakenEnvelopes: 3 });

    intake.handed('a', new Uint8Array(10));
    intake.handed('a', new Uint8Array(10));
    intake.handed('b', new Uint8Array(100));

    expect([paces, intake.paused]).toEqual([['pause b'], ['b']]);

    intake.handed('a', new ArrayBuffer(10));
    intake.handed('a', 'text');
    intake.handed('b', new Uint8Array(1));

    expect([paces, intake.paused]).toEqual([
      ['pause b', 'pause a'],
      ['a', 'b'],
    ]);
    intake.end();
  });

  // spec 15.12.18
  test('counts a text frame by its characters and a Blob by its size', () => {
    const { intake, paces } = recording({ maximumUntakenBytes: 4, maximumUntakenEnvelopes: 64 });

    intake.handed('a', 'abc');
    intake.handed('b', new Blob(['abcd']));

    expect(paces).toEqual(['pause b']);

    intake.handed('a', 'd');

    expect(paces).toEqual(['pause b', 'pause a']);
    intake.end();
  });

  // spec 15.12.17
  test('releases every count in the next task, never sooner, resuming each connection it paused', async () => {
    const { intake, paces } = recording({
      maximumUntakenBytes: 1_048_576,
      maximumUntakenEnvelopes: 1,
    });

    intake.handed('a', new Uint8Array(1));
    intake.handed('b', new Uint8Array(1));
    await Promise.resolve();

    // a microtask is no task
    expect(paces).toEqual(['pause a', 'pause b']);

    await nextTask();

    expect([paces, intake.paused]).toEqual([['pause a', 'pause b', 'resume a', 'resume b'], []]);

    // counted anew in the task after
    intake.handed('a', new Uint8Array(1));

    expect(paces.at(-1)).toBe('pause a');
    intake.end();
  });

  // spec 15.12.17
  test('resumes what it paused as it ends, and counts nothing after', async () => {
    const { intake, paces } = recording({
      maximumUntakenBytes: 1_048_576,
      maximumUntakenEnvelopes: 1,
    });

    intake.handed('a', new Uint8Array(1));
    intake.end();
    intake.end();
    intake.handed('b', new Uint8Array(1));
    await nextTask();

    expect([paces, intake.paused]).toEqual([['pause a', 'resume a'], []]);
  });
});
