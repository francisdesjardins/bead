import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { DisconnectError } from '../../shared/errors';
import { isSessionToken, toSessionToken } from '../../shared/identifiers';
import {
  createSessionManager,
  createTimers,
  DEFAULTS,
  ProgrammerError,
  SESSION_TOKEN_BYTES,
  type ISessionManager,
  type SESSION_MANAGER_EVENTS,
  type SessionToken,
} from '../session-manager';

// helpers

interface IUser {
  roles: string[];
  username: string;
}

const first: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001';
const second: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50002';

/** The next `event` within `ms`, or `undefined` when none came. */
const nextEvent = async <K extends SESSION_MANAGER_EVENTS>(
  sessions: ISessionManager<IUser>,
  { event, ms }: { event: K; ms: number }
) => {
  const { value } = await sessions.events(event, { signal: AbortSignal.timeout(ms) }).next();

  return value;
};

/** The session tokens of `first` and `second`. */
const sessionTokenOfBoth = (sessions: ISessionManager<IUser>) => {
  return [sessions.sessionTokenOf(first), sessions.sessionTokenOf(second)];
};

/** A token of 16 bytes of `byte`. */
const tokenOf = (byte: number): SessionToken => {
  return toSessionToken(new Uint8Array(SESSION_TOKEN_BYTES).fill(byte));
};

/** Every `event` from now on, as it is emitted. */
const record = (sessions: ISessionManager<IUser>, event: SESSION_MANAGER_EVENTS) => {
  const seen: unknown[][] = [];

  sessions.on(event, (...params) => {
    seen.push(params);
  });

  return seen;
};

// definition

test.describe('createTimers', () => {
  test('setting a timer stops the one it replaces, and create starts a connection over', async () => {
    using timers = createTimers();
    const fired: string[] = [];

    timers.setConnectionInactivityTimeout(
      setTimeout(() => {
        fired.push('replaced');
      }, 20),
      first
    );
    timers.setConnectionInactivityTimeout(
      setTimeout(() => {
        fired.push('kept');
      }, 20),
      first
    );
    timers.setSessionInactivityTimeout(
      setTimeout(() => {
        fired.push('recreated');
      }, 20),
      second
    );
    timers.create(second);

    await sleep(60);

    expect(fired).toEqual(['kept']);
  });

  test('delete stops a connection and forgets it; an unknown one is false', async () => {
    using timers = createTimers();
    const fired: string[] = [];

    timers.setSessionInactivityTimeout(
      setTimeout(() => {
        fired.push('session');
      }, 20),
      first
    );

    expect(timers.delete(first)).toBe(true);
    expect(timers.delete(first)).toBe(false);

    await sleep(60);

    expect(fired).toEqual([]);
  });

  test('dispose stops every timer', async () => {
    const fired: string[] = [];

    {
      using timers = createTimers();

      timers.setConnectionInactivityTimeout(
        setTimeout(() => {
          fired.push('first');
        }, 20),
        first
      );
      timers.setSessionInactivityTimeout(
        setTimeout(() => {
          fired.push('second');
        }, 20),
        second
      );
    }

    await sleep(60);

    expect(fired).toEqual([]);
  });
});

test.describe('createSessionManager', () => {
  test.describe('sessions', () => {
    test('create makes a session without storing it: no token, no timeout, no data', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.create(first);

      expect(session).toMatchObject({
        connectionHandle: first,
        connectionInactivityTimeout: Infinity,
        data: undefined,
        sessionInactivityTimeout: Infinity,
        sessionToken: undefined,
      });
      expect(session.lastActivityTimestamp.ms).toBeGreaterThan(0);
      expect(sessions.has(first)).toBe(false);
    });

    test('set draws a token, emits "created", and leaves the session it was given alone', () => {
      using sessions = createSessionManager<IUser>();
      const created = record(sessions, 'created');
      const draft = sessions.create(first);

      const stored = sessions.set(draft);

      expect(isSessionToken(stored.sessionToken)).toBe(true);
      expect(draft.sessionToken).toBeUndefined();
      expect(created).toEqual([[stored]]);
      expect(sessions.has(first)).toBe(true);
    });

    test('set emits "updated" when it replaces a different session, and nothing for the same', () => {
      using sessions = createSessionManager<IUser>();
      const updated = record(sessions, 'updated');
      const stored = sessions.set(sessions.create(first));

      sessions.set(stored);

      expect(updated).toEqual([]);

      const changed = sessions.set({ ...stored, data: { roles: [], username: 'guest' } });

      expect(updated).toEqual([[changed]]);
      expect(changed.sessionToken).toBe(stored.sessionToken);
    });

    test('a new session on a connection gets a token of its own', () => {
      using sessions = createSessionManager<IUser>();
      const before = sessions.set(sessions.create(first));
      const after = sessions.set(sessions.create(first));

      expect(after.sessionToken).not.toBe(before.sessionToken);
      expect(sessionTokenOfBoth(sessions)).toEqual([after.sessionToken, undefined]);
      expect(sessions.connectionHandles()).toEqual([first]);
    });

    test('hands out copies: changing one, however deep, changes nothing stored', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.getOrElseSet(first);

      session.data = { roles: ['admin'], username: 'guest' };
      sessions.updateData(session);
      session.data.roles.push('owner');

      const got = sessions.get(first);

      got?.data?.roles.push('intruder');
      sessions.getAll()[0]?.data?.roles.push('intruder');

      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'guest' });
      expect(sessions.get(first)).not.toBe(sessions.get(first));
    });

    test('nothing set or emitted is shared with the store: not the session set, not a listener’s', async () => {
      using sessions = createSessionManager<IUser>();
      const draft = sessions.create(first);

      draft.data = { roles: ['admin'], username: 'guest' };

      const tamper = (session: { data: IUser | undefined }) => {
        session.data?.roles.push('intruder');
      };

      sessions.on('created', tamper);
      sessions.on('updated', tamper);
      sessions.on('dataChanged', (session, newValue) => {
        tamper(session);
        newValue?.roles.push('intruder');
      });
      sessions.on('lastActivityTimestampChanged', (session, newValue) => {
        tamper(session);
        newValue.ms = -1;
      });

      const stored = sessions.set(draft);

      // neither the session set nor the `created` listener reached the store
      draft.data.roles.push('owner');
      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'guest' });

      // nor the `updated` listener
      sessions.set({ ...stored, connectionInactivityTimeout: 1 });
      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'guest' });

      sessions.updateData({ ...stored, data: { roles: ['admin'], username: 'other' } });

      // a later millisecond, so the activity is a change
      await sleep(5);
      sessions.updateLastActivityTimestamp({ ...stored });

      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'other' });
      expect(sessions.get(first)?.lastActivityTimestamp.ms).toBeGreaterThan(0);
    });

    test('draws tokens the wire can carry, each its own', () => {
      using sessions = createSessionManager<IUser>();
      const drawn = new Set<SessionToken | undefined>();

      for (let connection = 0; connection < 200; connection += 1) {
        drawn.add(
          sessions.set(
            sessions.create(
              `type=WS;ip=127.0.0.1;port=${String(connection)}` as TransportServerConnectionHandle
            )
          ).sessionToken
        );
      }

      expect(drawn.size).toBe(200);
      expect(
        [...drawn].every((token) => {
          return isSessionToken(token);
        })
      ).toBe(true);
    });

    test('a token given to set must be one, and belong to no other connection, or nothing is stored', () => {
      using sessions = createSessionManager<IUser>();
      const firstSession = sessions.getOrElseSet(first);

      for (const sessionToken of [
        '',
        'AQEBAQEBAQEBAQEBAQEBA',
        'AQEBAQEBAQEBAQEBAQEBAQA',
        'AQEBAQEBAQEBAQEBAQEB+Q',
        'AQEBAQEBAQEBAQEBAQEB/Q',
        'AQEBAQEBAQEBAQEBAQEB=Q',
        'AQEBAQEBAQEBAQEBAQEBAB',
        'AAAAAAAAAAAAAAAAAAAAAA',
      ]) {
        expect(() => {
          return sessions.set({
            ...sessions.create(second),
            sessionToken: sessionToken as SessionToken,
          });
        }, sessionToken).toThrow(ProgrammerError);
      }

      expect(() => {
        return sessions.set({
          ...sessions.create(second),
          sessionToken: firstSession.sessionToken,
        });
      }).toThrow(ProgrammerError);
      expect(sessions.has(second)).toBe(false);
      expect(sessionTokenOfBoth(sessions)).toEqual([firstSession.sessionToken, undefined]);

      // its own token, stored again, is still its own
      expect(
        sessions.set({ ...firstSession, data: { roles: [], username: 'x' } }).sessionToken
      ).toBe(firstSession.sessionToken);
      expect(
        sessions.set({ ...sessions.create(second), sessionToken: tokenOf(3) }).sessionToken
      ).toBe(tokenOf(3));
    });

    test('a token is free again once its session is deleted or replaced', () => {
      using sessions = createSessionManager<IUser>();
      const deleted = sessions.getOrElseSet(first);

      sessions.delete(first);

      expect(
        sessions.set({ ...sessions.create(second), sessionToken: deleted.sessionToken })
          .sessionToken
      ).toBe(deleted.sessionToken);

      const replaced = sessions.getOrElseSet(first);

      sessions.set(sessions.create(first));
      sessions.delete(second);

      expect(
        sessions.set({ ...sessions.create(second), sessionToken: replaced.sessionToken })
          .sessionToken
      ).toBe(replaced.sessionToken);
    });

    test('keeps each connection to its token through every change, and no update changes it', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.set({ ...sessions.create(first), sessionToken: tokenOf(1) });

      sessions.updateData({ ...session, data: { roles: [], username: 'guest' } });
      sessions.updateConnectionInactivityTimeout({
        ...session,
        connectionInactivityTimeout: 5_000,
      });
      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 5_000 });
      sessions.updateLastActivityTimestamp({ ...session });
      sessions.touch(first);

      expect(sessionTokenOfBoth(sessions)).toEqual([tokenOf(1), undefined]);
      expect(sessions.get(first)?.sessionToken).toBe(tokenOf(1));

      // what an update is handed says nothing of the token
      sessions.updateData({ ...session, sessionToken: tokenOf(2) });

      expect(sessions.get(first)?.sessionToken).toBe(tokenOf(1));

      sessions.set({ ...sessions.get(first)!, sessionToken: tokenOf(2) });

      expect(sessionTokenOfBoth(sessions)).toEqual([tokenOf(2), undefined]);

      // the token it let go of is free for another
      sessions.set({ ...sessions.create(second), sessionToken: tokenOf(1) });

      expect(sessionTokenOfBoth(sessions)).toEqual([tokenOf(2), tokenOf(1)]);
    });

    test('getOrElseSet stores a session once, then returns it', () => {
      using sessions = createSessionManager<IUser>();
      const created = record(sessions, 'created');

      const session = sessions.getOrElseSet(first);

      expect(sessions.getOrElseSet(first).sessionToken).toBe(session.sessionToken);
      expect(created).toHaveLength(1);
    });

    test('getAll, connectionHandles and has list what is stored', () => {
      using sessions = createSessionManager<IUser>();

      sessions.getOrElseSet(first);
      sessions.getOrElseSet(second);

      expect(sessions.connectionHandles()).toEqual([first, second]);
      expect(
        sessions.getAll().map(({ connectionHandle }) => {
          return connectionHandle;
        })
      ).toEqual([first, second]);
      expect(sessions.has(second)).toBe(true);
      expect(sessions.get('type=WS;ip=127.0.0.1;port=1')).toBeUndefined();
    });

    test('delete emits "deleted" and stops the timers; an unknown connection is false', async () => {
      using sessions = createSessionManager<IUser>();
      const deleted = record(sessions, 'deleted');
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      expect(sessions.delete(first)).toBe(true);
      expect(sessions.delete(first)).toBe(false);
      expect(deleted).toEqual([[{ ...session, connectionInactivityTimeout: 20 }]]);
      // the timer itself is gone, not only the session it would have reached
      expect(sessions.timers.delete(first)).toBe(false);

      await sleep(60);

      expect(reached).toEqual([]);
    });

    test('every update of a connection with no session is undefined', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.create(first);

      expect(sessions.updateConnectionInactivityTimeout(session)).toBeUndefined();
      expect(sessions.updateData(session)).toBeUndefined();
      expect(sessions.updateLastActivityTimestamp(session)).toBeUndefined();
      expect(sessions.updateSessionInactivityTimeout(session)).toBeUndefined();
    });
  });

  test.describe('data', () => {
    test('updateData stores a copy and emits "dataChanged" with the new and old values', () => {
      using sessions = createSessionManager<IUser>();
      const changed = record(sessions, 'dataChanged');
      const session = sessions.getOrElseSet(first);
      const data = { roles: ['admin'], username: 'guest' };

      const stored = sessions.updateData({ ...session, data });

      data.username = 'changed after';
      data.roles.push('owner');

      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'guest' });
      expect(stored?.data).toEqual({ roles: ['admin'], username: 'guest' });
      expect(changed).toEqual([[stored, { roles: ['admin'], username: 'guest' }, undefined]]);
    });

    test('updateData emits nothing for similar data', () => {
      using sessions = createSessionManager<IUser>();
      const changed = record(sessions, 'dataChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateData({ ...session, data: { roles: ['admin'], username: 'guest' } });
      sessions.updateData({ ...session, data: { roles: ['admin'], username: 'guest' } });

      expect(changed).toHaveLength(1);
    });
  });

  test.describe('timers', () => {
    test('updateConnectionInactivityTimeout stores the timeout, emits its change, and arms the timer', async () => {
      using sessions = createSessionManager<IUser>();
      const changed = record(sessions, 'connectionInactivityTimeoutChanged');
      const session = sessions.getOrElseSet(first);

      const stored = sessions.updateConnectionInactivityTimeout({
        ...session,
        connectionInactivityTimeout: 30,
      });

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 30 });

      expect(changed).toEqual([[stored, 30, Infinity]]);
      expect(stored?.sessionInactivityTimeout).toBe(Infinity);

      const reached = await nextEvent(sessions, {
        event: 'connectionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached?.[0].sessionToken).toBe(session.sessionToken);
    });

    test('updateSessionInactivityTimeout stores the timeout, emits its change, and arms the timer', async () => {
      using sessions = createSessionManager<IUser>();
      const changed = record(sessions, 'sessionInactivityTimeoutChanged');
      const session = sessions.getOrElseSet(first);

      const stored = sessions.updateSessionInactivityTimeout({
        ...session,
        sessionInactivityTimeout: 30,
      });

      expect(changed).toEqual([[stored, 30, Infinity]]);
      expect(stored?.connectionInactivityTimeout).toBe(Infinity);

      const reached = await nextEvent(sessions, {
        event: 'sessionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached?.[0].sessionToken).toBe(session.sessionToken);
    });

    test('a timeout of 0 takes the default, the manager’s own or its options’', () => {
      using sessions = createSessionManager<IUser>();
      using tuned = createSessionManager<IUser>({
        connectionInactivityTimeout: 1_000,
        sessionInactivityTimeout: 2_000,
      });
      const session = sessions.getOrElseSet(first);
      const tunedSession = tuned.getOrElseSet(first);

      expect(
        sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 0 })
          ?.connectionInactivityTimeout
      ).toBe(DEFAULTS.connectionInactivityTimeout);
      expect(
        sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 0 })
          ?.sessionInactivityTimeout
      ).toBe(DEFAULTS.sessionInactivityTimeout);
      expect(
        tuned.updateConnectionInactivityTimeout({ ...tunedSession, connectionInactivityTimeout: 0 })
          ?.connectionInactivityTimeout
      ).toBe(1_000);
      expect(
        tuned.updateSessionInactivityTimeout({ ...tunedSession, sessionInactivityTimeout: 0 })
          ?.sessionInactivityTimeout
      ).toBe(2_000);
    });

    test('set takes the default for a timeout of 0, rather than firing at once', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'connectionInactivityTimeoutReached');

      const stored = sessions.set({ ...sessions.create(first), connectionInactivityTimeout: 0 });

      await sleep(40);

      expect(stored.connectionInactivityTimeout).toBe(DEFAULTS.connectionInactivityTimeout);
      expect(reached).toEqual([]);
    });

    test('a default that is not a timeout is a programmer error', () => {
      for (const timeout of [0, -1, Number.NaN]) {
        expect(() => {
          return createSessionManager({ connectionInactivityTimeout: timeout });
        }).toThrow(ProgrammerError);
        expect(() => {
          return createSessionManager({ sessionInactivityTimeout: timeout });
        }).toThrow(ProgrammerError);
      }

      using never = createSessionManager<IUser>({ connectionInactivityTimeout: Infinity });
      const session = never.getOrElseSet(first);

      expect(
        never.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 0 })
          ?.connectionInactivityTimeout
      ).toBe(Infinity);
    });

    test('a negative timeout is a programmer error, and nothing is stored', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.getOrElseSet(first);

      expect(() => {
        return sessions.set({ ...sessions.create(second), sessionInactivityTimeout: -1 });
      }).toThrow(ProgrammerError);
      expect(() => {
        return sessions.updateConnectionInactivityTimeout({
          ...session,
          connectionInactivityTimeout: -5,
        });
      }).toThrow(ProgrammerError);
      expect(() => {
        return sessions.updateSessionInactivityTimeout({
          ...session,
          sessionInactivityTimeout: -5,
        });
      }).toThrow(ProgrammerError);
      expect(sessions.has(second)).toBe(false);
      expect(sessions.get(first)).toMatchObject({
        connectionInactivityTimeout: Infinity,
        sessionInactivityTimeout: Infinity,
      });
    });

    test('the session a timer reaches is the one stored when it fires', async () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.getOrElseSet(first);

      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 30 });
      sessions.updateData({ ...session, data: { roles: [], username: 'later' } });

      const reached = await nextEvent(sessions, {
        event: 'sessionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached?.[0].data?.username).toBe('later');
    });

    test('Infinity stops a running timer', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });
      sessions.updateConnectionInactivityTimeout({
        ...session,
        connectionInactivityTimeout: Infinity,
      });

      await sleep(60);

      expect(reached).toEqual([]);
    });

    test('a timeout longer than setTimeout can wait never fires, rather than at once', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'sessionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 2 ** 31 });

      await sleep(40);

      expect(reached).toEqual([]);
    });

    test('removing every listener does not unhook the timers', async () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.getOrElseSet(first);

      sessions.removeAllListeners();
      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      const reached = await nextEvent(sessions, {
        event: 'connectionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached).toBeDefined();
    });

    test('activity restarts both timers and emits "lastActivityTimestampChanged"', async () => {
      using sessions = createSessionManager<IUser>();
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const sessionReached = record(sessions, 'sessionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityTimestampChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });
      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 200 });

      await sleep(120);

      const stored = sessions.updateLastActivityTimestamp(session);

      expect(changed).toEqual([
        [stored, stored?.lastActivityTimestamp, session.lastActivityTimestamp],
      ]);

      // past the first deadline, short of the restarted one
      await sleep(130);

      expect(connectionReached).toEqual([]);
      expect(sessionReached).toEqual([]);

      await sleep(200);

      expect(connectionReached).toHaveLength(1);
      expect(sessionReached).toHaveLength(1);
    });

    test('touch stamps activity and restarts the timers, as updateLastActivityTimestamp does, without a copy', async () => {
      using sessions = createSessionManager<IUser>();
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityTimestampChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });

      await sleep(120);

      expect(sessions.touch(first)).toBe(true);
      expect(sessions.touch(second)).toBe(false);
      expect(changed).toHaveLength(1);
      expect(sessions.get(first)?.lastActivityTimestamp.ms).toBeGreaterThan(
        session.lastActivityTimestamp.ms
      );

      // past the first deadline, short of the restarted one
      await sleep(130);

      expect(connectionReached).toEqual([]);

      await sleep(120);

      expect(connectionReached).toHaveLength(1);
    });

    test('activity within the same millisecond restarts both timers, and emits nothing', async () => {
      using sessions = createSessionManager<IUser>();
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityTimestampChanged');
      const session = sessions.getOrElseSet(first);
      const { now } = Date;
      const frozen = now() + 1;

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });

      // the clock held on one millisecond while the timers run on
      try {
        Date.now = () => {
          return frozen;
        };
        sessions.touch(first);
        await sleep(120);
        sessions.touch(first);
      } finally {
        Date.now = now;
      }

      expect(changed).toHaveLength(1);

      // past the first touch's deadline, short of the second's
      await sleep(130);

      expect(connectionReached).toEqual([]);

      await sleep(120);

      expect(connectionReached).toHaveLength(1);
    });

    test('a set once disposed is a DisconnectError, and stores nothing', () => {
      const sessions = createSessionManager<IUser>();

      sessions[Symbol.dispose]();

      expect(() => {
        return sessions.set(sessions.create(first));
      }).toThrow(DisconnectError);
      expect(sessions.getAll()).toEqual([]);
    });

    test('sessionTokenOf gives the token the router announces to a connection, none without a session', () => {
      using sessions = createSessionManager<IUser>();
      const stored = sessions.set({ ...sessions.create(first), sessionToken: tokenOf(42) });

      expect(sessionTokenOfBoth(sessions)).toEqual([tokenOf(42), undefined]);

      sessions.delete(stored.connectionHandle);

      expect(sessionTokenOfBoth(sessions)).toEqual([undefined, undefined]);
    });

    test('a session stored with a token of its own gets its timers all the same', async () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.set({ ...sessions.create(second), sessionToken: tokenOf(7) });

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      const reached = await nextEvent(sessions, {
        event: 'connectionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached?.[0].sessionToken).toBe(tokenOf(7));
    });

    test('a new session set on a connection stops the timers of the one it replaces', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });
      sessions.set(sessions.create(first));

      await sleep(60);

      expect(reached).toEqual([]);
    });

    test('set keeps the timers in step with the timeouts it stores', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const running = sessions.getOrElseSet(first);

      // a timeout set to Infinity stops the timer that was running
      sessions.updateConnectionInactivityTimeout({ ...running, connectionInactivityTimeout: 20 });
      sessions.set({ ...sessions.get(first)!, connectionInactivityTimeout: Infinity });

      // a new session with a timeout of its own is armed with it
      const armed = sessions.set({
        ...sessions.create(second),
        connectionInactivityTimeout: 20,
      });

      await sleep(80);

      expect(reached).toEqual([[armed]]);
    });

    test('a new session with the timeout of the one it replaces is armed anew', async () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 30 });

      const replacing = sessions.set({
        ...sessions.create(first),
        connectionInactivityTimeout: 30,
      });
      const reached = await nextEvent(sessions, {
        event: 'connectionInactivityTimeoutReached',
        ms: 1_000,
      });

      expect(reached?.[0].sessionToken).toBe(replacing.sessionToken);
    });

    test('a reset for a connection with no session arms nothing', async () => {
      using sessions = createSessionManager<IUser>();
      const reached = record(sessions, 'connectionInactivityTimeoutReached');

      sessions.resetConnectionInactivityTimeout(sessions.create(first), 10);
      sessions.resetSessionInactivityTimeout(sessions.create(first), 10);

      await sleep(40);

      expect(reached).toEqual([]);
      expect(sessions.timers.delete(first)).toBe(false);
    });

    test('dispose stops every timer and forgets every session, without events', async () => {
      const deleted: unknown[] = [];
      const reached: unknown[] = [];

      {
        using sessions = createSessionManager<IUser>();
        const session = sessions.getOrElseSet(first);

        sessions.on('deleted', (...params) => {
          deleted.push(params);
        });
        sessions.on('sessionInactivityTimeoutReached', (...params) => {
          reached.push(params);
        });
        sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 20 });
        sessions[Symbol.dispose]();

        expect(sessions.connectionHandles()).toEqual([]);
        expect(sessions.timers.delete(first)).toBe(false);
      }

      await sleep(60);

      expect(deleted).toEqual([]);
      expect(reached).toEqual([]);
    });
  });

  test.describe('gauges', () => {
    test('count the sessions and the connections timed, and tell timers kept with no session', () => {
      using sessions = createSessionManager<IUser>();

      sessions.set({ ...sessions.create(first), sessionInactivityTimeout: 1_000 });

      expect(sessions.gauges()).toEqual({
        anomalies: [],
        ceilings: {},
        connectionHandles: new Set([first]),
        counts: { sessions: 1, timedConnections: 1 },
      });

      // a timer set by hand for a connection with no session
      sessions.timers.setConnectionInactivityTimeout(
        setTimeout(() => {}, 1_000),
        second
      );

      expect(sessions.gauges()).toMatchObject({
        anomalies: ['1 connections keep timers with no session'],
        connectionHandles: new Set([first, second]),
        counts: { sessions: 1, timedConnections: 2 },
      });

      sessions.timers.delete(second);
      sessions.delete(first);

      expect(sessions.gauges()).toMatchObject({
        anomalies: [],
        connectionHandles: new Set(),
        counts: { sessions: 0, timedConnections: 0 },
      });
    });
  });
});
