import { expect, test } from '@playwright/test';
import { createHold, type IHold } from '../hold';

test.describe('createHold', () => {
  // spec 15.12.17
  test('hands at once until paused, then holds in order, and hands it on from a microtask once resumed', async () => {
    const handed: number[] = [];
    let releases = 0;
    const hold = createHold(
      (message: number) => {
        handed.push(message);
      },
      {
        onReleased: () => {
          releases += 1;
        },
      }
    );

    hold.offer(1);
    hold.pause();
    hold.pause();
    hold.offer(2);
    hold.offer(3);

    expect([handed, hold.size, hold.isPaused]).toEqual([[1], 2, true]);

    hold.resume();
    hold.resume();
    // * what comes before its release waits behind what it holds
    hold.offer(4);

    expect(handed).toEqual([1]);

    await Promise.resolve();

    expect([handed, hold.size, releases]).toEqual([[1, 2, 3, 4], 0, 1]);

    hold.offer(5);

    expect(handed).toEqual([1, 2, 3, 4, 5]);
  });

  // spec 15.12.17
  test('stops its release once a hand pauses it again, and gives what it holds as it drops it', async () => {
    const handed: number[] = [];
    let releases = 0;
    // the hand pauses the hold it hands from, as a router does at its bound
    const pausing: { hold?: IHold<number> } = {};
    const hold = createHold(
      (message: number) => {
        handed.push(message);

        if (message === 2) {
          pausing.hold?.pause();
        }
      },
      {
        onReleased: () => {
          releases += 1;
        },
      }
    );

    pausing.hold = hold;
    hold.pause();

    for (const message of [1, 2, 3, 4]) {
      hold.offer(message);
    }

    hold.resume();
    await Promise.resolve();

    expect([handed, hold.size, hold.isPaused, releases]).toEqual([[1, 2], 2, true, 0]);
    expect(hold.drop()).toEqual([3, 4]);

    // its pause outlasts what it held
    hold.offer(5);

    expect([hold.size, hold.isPaused]).toEqual([1, true]);

    hold.resume();
    await Promise.resolve();

    expect([handed, releases]).toEqual([[1, 2, 5], 1]);
  });
});
