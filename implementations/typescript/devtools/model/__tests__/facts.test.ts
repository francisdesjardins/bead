import { expect, test } from '@playwright/test';
import { T0 } from '../../__tests__/traffic';
import {
  announcedOf,
  answerPayloadOf,
  destinationOf,
  outcomeOf,
  presentedOf,
  progressOf,
  requestPayloadOf,
  statusOf,
  subscriptionOf,
  transferOf,
} from '../facts';
import { trafficCall } from './book';

// definition

test.describe('statusOf', () => {
  test('tells answered, failed, ended without an answer, in flight, and a subscription open or closed, at a moment', () => {
    expect(statusOf(trafficCall('whoami'))).toBe('answered');
    expect(statusOf(trafficCall('fail'))).toBe('failed');
    expect(statusOf(trafficCall('slow'))).toBe('ended');
    expect(statusOf(trafficCall('stats'))).toBe('flight');
    expect(statusOf(trafficCall('counter'))).toBe('closed');
    expect(statusOf(trafficCall('counter'), T0 + 40)).toBe('open');
    expect(statusOf(trafficCall('whoami'), T0 + 8)).toBe('flight');
  });
});

test.describe('outcomeOf', () => {
  test('says how a call ended in words: its answer, its code, cancelled, a subscription’s notifications and who ended it', () => {
    expect(outcomeOf(trafficCall('whoami'))).toBe('{"role": "writer", "sub": "a"}');
    expect(outcomeOf(trafficCall('fail'))).toBe('procedure code 7');
    expect(outcomeOf(trafficCall('relayed'))).toBe('ACCESS_DENIED, beyond 1 relay');
    expect(outcomeOf(trafficCall('read'))).toBe('SESSION_REQUIRED');
    expect(outcomeOf(trafficCall('slow'))).toBe('cancelled');
    expect(outcomeOf(trafficCall('counter'))).toBe('2 heard · ended by the server');
    expect(outcomeOf(trafficCall('command'))).toBe('"14:03:13"');
  });
});

test.describe('requestPayloadOf and answerPayloadOf', () => {
  test('read a command the other way round: the server’s request came in, the page’s answer went out', () => {
    expect(requestPayloadOf(trafficCall('command'))?.text).toBe('"what time is it?"');
    expect(answerPayloadOf(trafficCall('command'))?.text).toBe('"14:03:13"');
    expect(requestPayloadOf(trafficCall('whoami'))?.text).toBe('null');
    expect(answerPayloadOf(trafficCall('fail'))).toBeUndefined();
  });
});

test.describe('subscriptionOf, transferOf and progressOf', () => {
  test('read a paced subscription’s credit and what it heard, at a moment', () => {
    expect(subscriptionOf(trafficCall('counter'), T0 + 40)).toEqual({
      credited: 2,
      endedBy: undefined,
      heard: 1,
      isAnswered: true,
      isOpen: true,
      isPaced: true,
    });
    expect(subscriptionOf(trafficCall('whoami'))).toBeUndefined();
  });

  test('read a transfer’s way, its total, and how far its chunks and its credit reached', () => {
    const download = trafficCall('download');

    expect(transferOf(download)).toEqual({ direction: 'rx', of: 'answer', total: 2_621_440 });
    expect(progressOf(download, T0 + 1_440)).toEqual({
      credited: 2_621_440,
      isWhole: false,
      passed: 1_048_560,
    });
    expect(progressOf(download)).toMatchObject({ isWhole: true, passed: 2_621_440 });
  });
});

test.describe('presentedOf, announcedOf and destinationOf', () => {
  test('read what a call presented, what its answer announced, and where it went', () => {
    expect(presentedOf(trafficCall('whoami'))).toBe(2);
    expect(announcedOf(trafficCall('whoami'))).toBe('opened');
    expect(announcedOf(trafficCall('token'))).toBeUndefined();
    expect(destinationOf(trafficCall('relayed'))).toBe(7);
  });
});
