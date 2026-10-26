import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { createTestClock, delaysOn } from '../../../transport/shared/__tests__/fixtures';
import { LONGEST_TIMER } from '../../../transport/shared/clock';
import { CredentialScheme } from '../../shared/constants';
import { createMetricsRegistry } from '../../shared/metrics-registry';
import type { ICallSession, SessionIdentifier } from '../../shared/types';
import { createCredentialSessions } from '../credential-sessions';
import { createNotificationManager } from '../notification-manager';
import type { ISubscriber } from '../../shared/types';

// constants

const NOW = Date.parse('2026-01-01T00:00:00Z');
const first: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';
const second: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=1';
const news = { procedureId: 5, serviceId: 2 };
const other = { procedureId: 6, serviceId: 2 };

const GRACE: SessionIdentifier = Object.freeze({
  issuer: 'https://issuer.example',
  scheme: CredentialScheme.JWT,
  sub: 'grace',
});

// helpers

/** Credential sessions over a manager of their own, on a test clock, each end they told recorded. */
const createSessions = () => {
  const clock = createTestClock(NOW);
  const ended: Required<ISubscriber<TransportServerConnectionHandle>>[] = [];
  const sessions = createCredentialSessions({
    clock,
    notifications: createNotificationManager(),
    onEnd: (subscriber) => {
      ended.push(subscriber);

      return Promise.resolve();
    },
  });

  return { clock, ended, sessions };
};

/** A call of GRACE's session, run with `end`, its identifier given. */
const sessionOf = (end: number | undefined): ICallSession => {
  return Object.freeze({ data: 'grace', end, identifier: GRACE });
};

// definition

test.describe('createCredentialSessions', () => {
  test('forwards a subscription’s metrics series until it is removed', () => {
    const { sessions: created } = createSessions();
    using sessions = created;
    const { notifications } = sessions;
    const registry = createMetricsRegistry();
    const series = registry
      .attach('server')
      .declareResolver(
        { ...news, procedureName: 'news', serviceRevision: 1 },
        { notifies: true }
      ).notifying;

    expect(series).toBeDefined();
    notifications.register(news, { callId: 1, connectionHandle: first, series });
    expect(
      notifications.notifications.get(news.serviceId)?.get(news.procedureId)?.get(first)?.get('')
    ).toBe(1);
    expect(notifications.seriesOf(1, first)).toBe(series);
    expect(notifications.seriesOf(3, first)).toBeUndefined();
    expect(notifications.seriesOf(1, second)).toBeUndefined();
    expect(notifications.unregister(1, first)).toBe(1);
    expect(notifications.seriesOf(1, first)).toBeUndefined();
    expect(notifications.subscriptions()).toEqual([]);
    expect(notifications.notifications.size).toBe(0);
  });

  test('keeps the latest credential end across subscriptions and clears its timers when the connection closes', async () => {
    const { clock, ended, sessions: created } = createSessions();
    using sessions = created;
    const { notifications } = sessions;
    const identifier: SessionIdentifier = { id: 'ada', scheme: CredentialScheme.ELSEWHERE };

    notifications.register(news, {
      callId: 1,
      connectionHandle: first,
      end: NOW + 1_000,
      identifier,
    });
    notifications.register(other, {
      callId: 3,
      connectionHandle: first,
      end: NOW + 2_000,
      identifier,
    });
    notifications.register(news, {
      callId: 1,
      connectionHandle: second,
      end: NOW + 3_000,
      identifier,
    });

    expect(delaysOn(clock)).toEqual([2_000, 3_000]);
    await clock.tickAsync(1_000);

    expect(ended).toEqual([]);
    notifications.unregister(1, first);
    notifications.register(news, { callId: 5, connectionHandle: first, identifier });

    expect(sessions.gauges().counts).toEqual({ credentialSessions: 2, timedCredentialSessions: 1 });
    expect(delaysOn(clock)).toEqual([3_000]);
    expect(
      sessions.resolved({ data: 'ada', end: NOW + 1_500, identifier }, first).end
    ).toBeUndefined();

    sessions.clear(first);
    sessions.clear(first);

    expect(sessions.gauges().counts).toEqual({ credentialSessions: 1, timedCredentialSessions: 1 });
    expect([...sessions.gauges().connectionHandles]).toEqual([second]);
    await clock.tickAsync(2_000);

    expect(ended).toEqual([{ connectionHandle: second, identifier }]);
    expect(delaysOn(clock)).toEqual([]);
    expect(sessions.gauges().counts).toEqual({ credentialSessions: 0, timedCredentialSessions: 0 });
  });

  test('keeps a credential’s session from its first subscription on a connection to its last, timing its end meanwhile; its connection’s session it never keeps', () => {
    const { clock, sessions } = createSessions();
    const { notifications } = sessions;
    const end = NOW + 3_660_000;

    // the connection's session is no credential's: nothing is timed
    notifications.register(news, { callId: 1, connectionHandle: first });

    expect(delaysOn(clock)).toEqual([]);

    notifications.register(news, { callId: 3, connectionHandle: first, end, identifier: GRACE });
    notifications.register(other, { callId: 5, connectionHandle: first, end, identifier: GRACE });

    expect(delaysOn(clock)).toEqual([3_660_000]);
    expect(sessions.gauges().counts).toEqual({ credentialSessions: 1, timedCredentialSessions: 1 });

    notifications.unregister(3, first);

    expect(delaysOn(clock)).toEqual([3_660_000]);

    notifications.unregister(5, first);

    expect(delaysOn(clock)).toEqual([]);
    expect(sessions.gauges().counts).toEqual({ credentialSessions: 0, timedCredentialSessions: 0 });
    // a call resolving to a session not kept runs with its own end
    expect(sessions.resolved(sessionOf(NOW + 1_000), first)).toEqual(sessionOf(NOW + 1_000));
  });

  test('times an end past a timer’s ceiling in steps, the wall clock read again at each due, and ends it at once once reached, no timer armed', async () => {
    const { clock, ended, sessions } = createSessions();
    const end = NOW + 30 * 86_400_000 + 60_000;

    sessions.notifications.register(news, {
      callId: 1,
      connectionHandle: first,
      end,
      identifier: GRACE,
    });

    expect(delaysOn(clock)).toEqual([LONGEST_TIMER]);

    await clock.tickAsync(LONGEST_TIMER);

    expect(delaysOn(clock)).toEqual([end - NOW - LONGEST_TIMER]);

    // a wall clock set back by hand takes effect at the next due: read again, never counted down
    clock.setSystemTime(clock.Date.now() - 1_000);
    await clock.tickAsync(end - NOW - LONGEST_TIMER);

    expect(ended).toEqual([]);
    expect(delaysOn(clock)).toEqual([1_000]);

    await clock.tickAsync(1_000);

    expect(ended).toEqual([{ connectionHandle: first, identifier: GRACE }]);
    expect(delaysOn(clock)).toEqual([]);

    // one whose end passed as it comes to be kept ends then, with no timer, in a turn of its own:
    // past the answer of the call that kept it
    sessions.notifications.register(news, {
      callId: 3,
      connectionHandle: second,
      end: clock.Date.now(),
      identifier: GRACE,
    });

    expect(ended).toHaveLength(1);
    expect(delaysOn(clock)).toEqual([]);

    await sleep(0);

    expect(ended).toHaveLength(2);

    // a call in flight as its session ended, answered, keeps it anew: ended at once, its end reached
    sessions.held({ callId: 3, connectionHandle: second, end: NOW, identifier: GRACE });
    await sleep(0);

    expect(ended).toEqual([
      { connectionHandle: first, identifier: GRACE },
      { connectionHandle: second, identifier: GRACE },
      { connectionHandle: second, identifier: GRACE },
    ]);

    // one whose answer did not go out, its subscription gone, keeps nothing
    sessions.held({ callId: 9, connectionHandle: second, end: undefined, identifier: GRACE });

    expect(sessions.gauges().counts).toEqual({ credentialSessions: 0, timedCredentialSessions: 0 });
  });

  test('ends nothing in the turn after its end was reached for a session forgotten or renewed meanwhile', async () => {
    const { clock, ended, sessions } = createSessions();
    const { notifications } = sessions;

    // reached as it comes to be kept, then let go in the same turn
    notifications.register(news, {
      callId: 1,
      connectionHandle: first,
      end: NOW,
      identifier: GRACE,
    });
    notifications.unregister(1, first);
    await sleep(0);

    expect(ended).toEqual([]);

    // reached, then renewed in the same turn by a call resolving to a later end
    notifications.register(news, {
      callId: 3,
      connectionHandle: first,
      end: NOW,
      identifier: GRACE,
    });
    sessions.resolved(sessionOf(NOW + 60_000), first);
    await sleep(0);

    expect(ended).toEqual([]);
    expect(delaysOn(clock)).toEqual([60_000]);
  });

  test('moves a kept session’s end to the later of the two, in whatever order calls resolve, its timer armed anew; a call runs with the end kept', () => {
    const { clock, sessions } = createSessions();

    sessions.notifications.register(news, {
      callId: 1,
      connectionHandle: first,
      end: NOW + 3_660_000,
      identifier: GRACE,
    });

    expect(sessions.resolved(sessionOf(NOW + 7_260_000), first)).toEqual(
      sessionOf(NOW + 7_260_000)
    );
    expect(delaysOn(clock)).toEqual([7_260_000]);
    // an older token resolving after the renewal moves nothing back, and runs with the later end
    expect(sessions.resolved(sessionOf(NOW + 3_660_000), first)).toEqual(
      sessionOf(NOW + 7_260_000)
    );
    expect(delaysOn(clock)).toEqual([7_260_000]);
    // another connection keeps nothing of it
    expect(sessions.resolved(sessionOf(NOW + 60_000), second)).toEqual(sessionOf(NOW + 60_000));
  });

  test('ends a session by its identifier on every connection that keeps it, and forgets those of a connection that closes', async () => {
    const { clock, ended, sessions } = createSessions();
    const { notifications } = sessions;
    const end = NOW + 3_660_000;
    const bob: SessionIdentifier = { id: 'bob', scheme: CredentialScheme.ELSEWHERE };

    notifications.register(news, { callId: 1, connectionHandle: first, end, identifier: GRACE });
    notifications.register(news, { callId: 1, connectionHandle: second, end, identifier: GRACE });
    notifications.register(other, { callId: 3, connectionHandle: second, identifier: bob });

    await sessions.end({ ...GRACE });

    expect(ended).toEqual([
      { connectionHandle: first, identifier: GRACE },
      { connectionHandle: second, identifier: GRACE },
    ]);
    expect(delaysOn(clock)).toEqual([]);

    // one no connection keeps ends nothing
    await sessions.end(GRACE);

    expect(ended).toHaveLength(2);

    notifications.clean(second);
    await sessions.end(bob);

    expect(ended).toHaveLength(2);
    expect(sessions.gauges().counts).toEqual({ credentialSessions: 0, timedCredentialSessions: 0 });
  });

  test('ends every session of an issuer by that issuer on every connection, sid and sub alike, and never an ELSEWHERE’s', async () => {
    const { clock, ended, sessions } = createSessions();
    const { notifications } = sessions;
    const end = NOW + 3_660_000;
    const { issuer } = GRACE as { issuer: string };
    const one: SessionIdentifier = { issuer, scheme: CredentialScheme.JWT, sid: 'one' };
    const another: SessionIdentifier = { ...GRACE, issuer: 'https://other.example' };
    const named: SessionIdentifier = { id: issuer, scheme: CredentialScheme.ELSEWHERE };

    notifications.register(news, { callId: 1, connectionHandle: first, end, identifier: GRACE });
    notifications.register(other, { callId: 3, connectionHandle: first, end, identifier: one });
    notifications.register(news, { callId: 1, connectionHandle: second, end, identifier: one });
    notifications.register(other, {
      callId: 3,
      connectionHandle: second,
      end,
      identifier: another,
    });
    notifications.register(news, { callId: 5, connectionHandle: second, identifier: named });

    await sessions.endSessionsOf(issuer);

    expect(ended).toEqual([
      { connectionHandle: first, identifier: GRACE },
      { connectionHandle: first, identifier: one },
      { connectionHandle: second, identifier: one },
    ]);
    expect(delaysOn(clock)).toEqual([end - NOW]);

    // none of it kept now, and no session of an issuer none names: each ends nothing
    await sessions.endSessionsOf(issuer);
    await sessions.endSessionsOf('https://unnamed.example');

    expect(ended).toHaveLength(3);
    expect(sessions.gauges().counts).toEqual({ credentialSessions: 2, timedCredentialSessions: 1 });
  });
});
