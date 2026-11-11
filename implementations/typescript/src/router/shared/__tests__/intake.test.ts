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
  test('counts a text frame by its UTF-8 bytes and a Blob by its size', () => {
    const { intake, paces } = recording({ maximumUntakenBytes: 4, maximumUntakenEnvelopes: 64 });

    // four bytes in two UTF-16 code units
    intake.handed('a', 'éé');
    intake.handed('b', new Blob(['abc']));

    expect(paces).toEqual(['pause a']);

    intake.handed('b', 'd');

    expect(paces).toEqual(['pause a', 'pause b']);
    intake.end();

    // as `TextEncoder` writes each: a surrogate pair in four bytes, a lone surrogate as U+FFFD
    const texts = ['a', 'é', '€', '\u{1f600}', '\ud800', '\udc00a', 'a\u{1f600}\ud800é'];

    for (const text of texts) {
      const bytes = new TextEncoder().encode(text).byteLength;
      const below = recording({ maximumUntakenBytes: bytes + 1, maximumUntakenEnvelopes: 64 });
      const at = recording({ maximumUntakenBytes: bytes, maximumUntakenEnvelopes: 64 });

      below.intake.handed('a', text);
      at.intake.handed('a', text);

      expect([text, below.paces, at.paces]).toEqual([text, [], ['pause a']]);
      below.intake.end();
      at.intake.end();
    }
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
