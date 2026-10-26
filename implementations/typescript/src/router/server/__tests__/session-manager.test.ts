import { expect, test } from '@playwright/test';
import type { TransportServerConnectionHandle } from '../../../transport/server/types';
import { DisconnectError } from '../../shared/errors';
import { isSessionToken, toSessionToken } from '../../shared/identifiers';
import { createTestClock, delaysOn } from '../../../transport/shared/__tests__/fixtures';
import {
  createSessionManager,
  createTimers,
  DEFAULTS,
  PLATFORM_CLOCK,
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

const first: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50001;ordinal=1';
const second: TransportServerConnectionHandle = 'type=WS;ip=127.0.0.1;port=50002;ordinal=1';

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
  test('setting a timer stops the one it replaces, and create starts a connection over', () => {
    const clock = createTestClock();
    using timers = createTimers(clock);
    const fired: string[] = [];

    timers.setConnectionInactivityTimeout(
      clock.setTimeout(() => {
        fired.push('replaced');
      }, 20),
      first
    );
    timers.setConnectionInactivityTimeout(
      clock.setTimeout(() => {
        fired.push('kept');
      }, 20),
      first
    );
    timers.setSessionInactivityTimeout(
      clock.setTimeout(() => {
        fired.push('recreated');
      }, 20),
      second
    );
    timers.create(second);
    clock.runAll();

    expect(fired).toEqual(['kept']);
  });

  test('delete stops a connection and forgets it; an unknown one is false', () => {
    const clock = createTestClock();
    using timers = createTimers(clock);
    const fired: string[] = [];

    timers.setSessionInactivityTimeout(
      clock.setTimeout(() => {
        fired.push('session');
      }, 20),
      first
    );

    expect(timers.delete(first)).toBe(true);
    expect(timers.delete(first)).toBe(false);

    clock.runAll();

    expect(fired).toEqual([]);
  });

  test('dispose stops every timer', () => {
    const clock = createTestClock();
    const fired: string[] = [];

    {
      using timers = createTimers(clock);

      timers.setConnectionInactivityTimeout(
        clock.setTimeout(() => {
          fired.push('first');
        }, 20),
        first
      );
      timers.setSessionInactivityTimeout(
        clock.setTimeout(() => {
          fired.push('second');
        }, 20),
        second
      );
    }

    clock.runAll();

    expect(fired).toEqual([]);
  });
});

test.describe('createSessionManager', () => {
  test.describe('sessions', () => {
    test('create makes a session without storing it: no token, no timeout, no data', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using sessions = createSessionManager<IUser>({ clock });
      const session = sessions.create(first);

      expect(session).toEqual({
        connectionHandle: first,
        connectionInactivityTimeout: Infinity,
        data: undefined,
        lastActivity: clock.Date.now(),
        sessionInactivityTimeout: Infinity,
        sessionToken: undefined,
      });
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
      const created = record(sessions, 'created');
      const updated = record(sessions, 'updated');
      const before = sessions.set(sessions.create(first));
      const after = sessions.set(sessions.create(first));

      // the one over it told as an update, not a session created
      expect([created, updated]).toEqual([[[before]], [[after]]]);
      expect(after.sessionToken).not.toBe(before.sessionToken);
      expect(sessionTokenOfBoth(sessions)).toEqual([after.sessionToken, undefined]);
      expect(sessions.connectionHandles()).toEqual([first]);
      expect(sessions.getAll()).toEqual([after]);
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

    test('nothing set or emitted is shared with the store: not the session set, not a listener’s', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
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
      sessions.on('lastActivityChanged', (session) => {
        tamper(session);
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
      clock.tick(5);
      sessions.updateLastActivity({ ...stored });

      expect(sessions.get(first)?.data).toEqual({ roles: ['admin'], username: 'other' });
      expect(sessions.get(first)?.lastActivity).toBe(5);
    });

    test('draws tokens the wire can carry, each its own', () => {
      using sessions = createSessionManager<IUser>();
      const drawn = new Set<SessionToken | undefined>();

      for (let connection = 0; connection < 200; connection += 1) {
        drawn.add(
          sessions.set(
            sessions.create(
              `type=WS;ip=127.0.0.1;port=${String(connection)};ordinal=1` as TransportServerConnectionHandle
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
      sessions.updateLastActivity({ ...session });
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
      expect(sessions.get('type=WS;ip=127.0.0.1;port=1;ordinal=1')).toBeUndefined();
    });

    test('delete emits "deleted" and stops the timers; an unknown connection is false', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const deleted = record(sessions, 'deleted');
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      expect(sessions.delete(first)).toBe(true);
      expect(sessions.delete(first)).toBe(false);
      expect(deleted).toEqual([[{ ...session, connectionInactivityTimeout: 20 }]]);
      // the timer itself is gone, not only the session it would have reached
      expect(sessions.timers.delete(first)).toBe(false);
      expect(delaysOn(clock)).toEqual([]);

      clock.tick(20);

      expect(reached).toEqual([]);
    });

    test('every update of a connection with no session is undefined', () => {
      using sessions = createSessionManager<IUser>();
      const session = sessions.create(first);

      expect(sessions.updateConnectionInactivityTimeout(session)).toBeUndefined();
      expect(sessions.updateData(session)).toBeUndefined();
      expect(sessions.updateLastActivity(session)).toBeUndefined();
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
    test('updateConnectionInactivityTimeout stores the timeout, emits its change, and arms the timer', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const changed = record(sessions, 'connectionInactivityTimeoutChanged');
      const session = sessions.getOrElseSet(first);

      const stored = sessions.updateConnectionInactivityTimeout({
        ...session,
        connectionInactivityTimeout: 30,
      });

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 30 });

      expect(changed).toEqual([[stored, 30, Infinity]]);
      expect(stored?.sessionInactivityTimeout).toBe(Infinity);

      const reached = record(sessions, 'connectionInactivityTimeoutReached');

      clock.tick(29);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toHaveLength(1);

      expect(reached[0]?.[0]).toMatchObject({ sessionToken: session.sessionToken });
    });

    test('updateSessionInactivityTimeout stores the timeout, emits its change, and arms the timer', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const changed = record(sessions, 'sessionInactivityTimeoutChanged');
      const session = sessions.getOrElseSet(first);

      const stored = sessions.updateSessionInactivityTimeout({
        ...session,
        sessionInactivityTimeout: 30,
      });

      expect(changed).toEqual([[stored, 30, Infinity]]);
      expect(stored?.connectionInactivityTimeout).toBe(Infinity);

      const reached = record(sessions, 'sessionInactivityTimeoutReached');

      clock.tick(29);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toHaveLength(1);

      expect(reached[0]?.[0]).toMatchObject({ sessionToken: session.sessionToken });
    });

    test('gives a timeout left out the default', () => {
      using sessions = createSessionManager<IUser>({ sessionInactivityTimeout: 7_000 });
      const session = sessions.set({
        ...sessions.create(first),
        sessionInactivityTimeout: undefined,
      });

      expect([session.sessionInactivityTimeout, session.connectionInactivityTimeout]).toEqual([
        7_000,
        Infinity,
      ]);
    });

    test('says nothing of a session timeout given the one it has', () => {
      using sessions = createSessionManager<IUser>();
      const changed = record(sessions, 'sessionInactivityTimeoutChanged');
      const session = sessions.set({ ...sessions.create(first), sessionInactivityTimeout: 2_000 });

      expect(sessions.updateSessionInactivityTimeout(session)).toEqual(session);
      expect(changed).toEqual([]);
    });

    test('runs on the clock its options give, the system’s when none', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using given = createSessionManager<IUser>({ clock });
      using none = createSessionManager<IUser>();

      expect(given.clock).toBe(clock);
      expect(none.clock).toBe(PLATFORM_CLOCK);
      expect(given.create(first).lastActivity).toBe(Date.UTC(2026, 0, 1));
    });

    test('a timeout left out takes the default, the manager’s own or its options’', () => {
      using sessions = createSessionManager<IUser>();
      using tuned = createSessionManager<IUser>({
        connectionInactivityTimeout: 1_000,
        sessionInactivityTimeout: 2_000,
      });
      const session = sessions.getOrElseSet(first);
      const tunedSession = tuned.getOrElseSet(first);

      expect(
        sessions.updateConnectionInactivityTimeout({
          ...session,
          connectionInactivityTimeout: undefined,
        })?.connectionInactivityTimeout
      ).toBe(DEFAULTS.connectionInactivityTimeout);
      expect(
        sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: undefined })
          ?.sessionInactivityTimeout
      ).toBe(DEFAULTS.sessionInactivityTimeout);
      expect(
        tuned.updateConnectionInactivityTimeout({
          ...tunedSession,
          connectionInactivityTimeout: undefined,
        })?.connectionInactivityTimeout
      ).toBe(1_000);
      expect(
        tuned.updateSessionInactivityTimeout({
          ...tunedSession,
          sessionInactivityTimeout: undefined,
        })?.sessionInactivityTimeout
      ).toBe(2_000);
    });

    test('set takes the default for a timeout left out: never, which arms no timer', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });

      const stored = sessions.set({
        ...sessions.create(first),
        connectionInactivityTimeout: undefined,
      });

      expect([stored.connectionInactivityTimeout, DEFAULTS.connectionInactivityTimeout]).toEqual([
        Infinity,
        Infinity,
      ]);
      expect(delaysOn(clock)).toEqual([]);
    });

    test('a session built without naming its timeouts holds both without end, as one made by create does', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });

      const built = sessions.set({
        connectionHandle: first,
        data: undefined,
        lastActivity: clock.Date.now(),
        sessionToken: undefined,
      });
      const created = sessions.set(sessions.create(second));

      expect([built.connectionInactivityTimeout, built.sessionInactivityTimeout]).toEqual([
        Infinity,
        Infinity,
      ]);
      expect([created.connectionInactivityTimeout, created.sessionInactivityTimeout]).toEqual([
        Infinity,
        Infinity,
      ]);
      expect(DEFAULTS).toEqual({
        connectionInactivityTimeout: Infinity,
        sessionInactivityTimeout: Infinity,
      });
    });

    test('a default that is not a timeout is a programmer error', () => {
      for (const timeout of [0, -1, 0.5, Number.NaN]) {
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
        never.updateConnectionInactivityTimeout({
          ...session,
          connectionInactivityTimeout: undefined,
        })?.connectionInactivityTimeout
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
      expect(sessions.get(first)).toEqual(session);
    });

    test('the session a timer reaches is the one stored when it fires', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const session = sessions.getOrElseSet(first);

      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 30 });
      sessions.updateData({ ...session, data: { roles: [], username: 'later' } });

      const reached = record(sessions, 'sessionInactivityTimeoutReached');

      clock.tick(29);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toHaveLength(1);

      expect(reached[0]?.[0]).toMatchObject({ data: { username: 'later' } });
    });

    test('Infinity stops a running timer', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });
      sessions.updateConnectionInactivityTimeout({
        ...session,
        connectionInactivityTimeout: Infinity,
      });

      expect(delaysOn(clock)).toEqual([]);

      clock.tick(20);

      expect(reached).toEqual([]);
    });

    test('a timeout past the longest a timer waits is refused, by a reset, a store, an update and a default, and nothing changes', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.set({ ...sessions.create(first), sessionInactivityTimeout: 1_000 });
      const past = 2 ** 31;

      for (const refused of [
        () => {
          sessions.resetConnectionInactivityTimeout(session, past);
        },
        () => {
          sessions.resetSessionInactivityTimeout(session, past);
        },
        () => {
          sessions.set({ ...sessions.create(second), connectionInactivityTimeout: past });
        },
        () => {
          sessions.updateConnectionInactivityTimeout({
            ...session,
            connectionInactivityTimeout: past,
          });
        },
        () => {
          sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: past });
        },
        () => {
          createSessionManager({ connectionInactivityTimeout: past });
        },
        () => {
          createSessionManager({ sessionInactivityTimeout: past });
        },
      ]) {
        expect(refused).toThrow(ProgrammerError);
      }

      expect(() => {
        sessions.resetSessionInactivityTimeout(session, past);
      }).toThrow(
        'a session inactivity timeout is a number of milliseconds from 1 to 2147483647, or Infinity for never, not 2147483648'
      );
      // the timer running is left as it was, and nothing was stored
      expect(delaysOn(clock)).toEqual([1_000]);
      expect(sessions.has(second)).toBe(false);
      expect(sessions.get(first)).toMatchObject({
        connectionInactivityTimeout: Infinity,
        sessionInactivityTimeout: 1_000,
      });

      // the longest a timer waits is armed, and never is no timer at all
      sessions.resetConnectionInactivityTimeout(session, 2 ** 31 - 1);
      sessions.resetSessionInactivityTimeout(session, Infinity);

      expect(delaysOn(clock)).toEqual([2 ** 31 - 1]);
      clock.tick(2 ** 31 - 2);
      expect(reached).toEqual([]);
      clock.tick(1);
      expect(reached).toHaveLength(1);
    });

    test('removing every listener does not unhook the timers', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const session = sessions.getOrElseSet(first);

      sessions.removeAllListeners();
      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      const reached = record(sessions, 'connectionInactivityTimeoutReached');

      clock.tick(19);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toHaveLength(1);

      expect(reached).toBeDefined();
    });

    test('activity restarts both timers, on its clock, and emits "lastActivityChanged"', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using sessions = createSessionManager<IUser>({ clock });
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const sessionReached = record(sessions, 'sessionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });
      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 200 });
      // a later millisecond, so the activity is a change
      clock.tick(5);

      const stored = sessions.updateLastActivity(session);

      expect(changed).toEqual([[stored, Date.UTC(2026, 0, 1) + 5, Date.UTC(2026, 0, 1)]]);
      expect(stored?.lastActivity).toBe(Date.UTC(2026, 0, 1) + 5);
      // the first two stopped, two more of the same delay going
      expect(
        clock.armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([200, 200, 200, 200]);
      expect(delaysOn(clock)).toEqual([200, 200]);

      clock.tick(199);

      expect([connectionReached, sessionReached]).toEqual([[], []]);

      clock.tick(1);

      expect(connectionReached).toHaveLength(1);
      expect(sessionReached).toHaveLength(1);
    });

    test('touch stamps activity and restarts the timers, as updateLastActivity does, without a copy', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using sessions = createSessionManager<IUser>({ clock });
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });
      // a later millisecond, so the activity is a change
      clock.tick(5);

      expect(sessions.touch(first)).toBe(true);
      expect(sessions.touch(second)).toBe(false);
      expect(changed).toHaveLength(1);
      expect(sessions.get(first)?.lastActivity).toBe(session.lastActivity + 5);
      // the first stopped, another of the same delay going
      expect(
        clock.armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([200, 200]);

      clock.runAll();

      expect(connectionReached).toHaveLength(1);
    });

    test('activity within the same millisecond restarts both timers, and emits nothing', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using sessions = createSessionManager<IUser>({ clock });
      const connectionReached = record(sessions, 'connectionInactivityTimeoutReached');
      const changed = record(sessions, 'lastActivityChanged');
      const sessionReached = record(sessions, 'sessionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 200 });
      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 200 });
      clock.tick(1);
      // the clock held on one millisecond
      sessions.touch(first);
      sessions.touch(first);

      // each touch stopped the timer before it and set another going
      expect(
        clock.armed.map(({ delay }) => {
          return delay;
        })
      ).toEqual([200, 200, 200, 200, 200, 200]);

      clock.tick(199);
      expect(connectionReached).toEqual([]);
      expect(sessionReached).toEqual([]);
      clock.tick(1);

      expect(changed).toHaveLength(1);
      expect(connectionReached).toHaveLength(1);
      expect(sessionReached).toHaveLength(1);
    });

    test('the activity it reports reads the wall clock, which a clock set by hand moves alone', () => {
      const clock = createTestClock(Date.UTC(2026, 0, 1));
      using sessions = createSessionManager<IUser>({ clock });
      const changed = record(sessions, 'lastActivityChanged');
      const session = sessions.getOrElseSet(first);

      sessions.updateSessionInactivityTimeout({ ...session, sessionInactivityTimeout: 200 });
      clock.setSystemTime(Date.UTC(2025, 11, 31));
      sessions.touch(first);

      // back a day, the instant reported with it; the timer counts its 200 ms all the same
      expect(changed).toEqual([[expect.anything(), Date.UTC(2025, 11, 31), Date.UTC(2026, 0, 1)]]);
      expect(delaysOn(clock)).toEqual([200]);
      expect(sessions.clock).toBe(clock);
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

    test('a session stored with a token of its own gets its timers all the same', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const session = sessions.set({ ...sessions.create(second), sessionToken: tokenOf(7) });

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });

      const reached = record(sessions, 'connectionInactivityTimeoutReached');

      clock.tick(19);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toHaveLength(1);

      expect(reached[0]?.[0]).toMatchObject({ sessionToken: tokenOf(7) });
    });

    test('a new session set on a connection stops the timers of the one it replaces', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 20 });
      sessions.set(sessions.create(first));

      expect(delaysOn(clock)).toEqual([]);

      clock.tick(20);

      expect(reached).toEqual([]);
    });

    test('set keeps the timers in step with the timeouts it stores', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
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

      // the timer stopped is gone: the one armed alone runs
      expect(delaysOn(clock)).toEqual([20]);

      clock.tick(19);

      expect(reached).toEqual([]);

      clock.tick(1);

      expect(reached).toEqual([[armed]]);
    });

    test('a new session with the timeout of the one it replaces is armed anew', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });
      const reached = record(sessions, 'connectionInactivityTimeoutReached');
      const session = sessions.getOrElseSet(first);

      sessions.updateConnectionInactivityTimeout({ ...session, connectionInactivityTimeout: 30 });
      clock.tick(20);

      const replacing = sessions.set({
        ...sessions.create(first),
        connectionInactivityTimeout: 30,
      });

      // nothing at the first one's due: its timer went with it
      clock.tick(10);

      expect(reached).toEqual([]);

      clock.tick(20);

      expect(reached).toEqual([[replacing]]);
    });

    test('a reset for a connection with no session arms nothing', () => {
      const clock = createTestClock();
      using sessions = createSessionManager<IUser>({ clock });

      sessions.resetConnectionInactivityTimeout(sessions.create(first), 10);
      sessions.resetSessionInactivityTimeout(sessions.create(first), 10);

      expect(delaysOn(clock)).toEqual([]);
      expect(sessions.gauges().counts).toEqual({ sessions: 0, timedConnections: 0 });
      expect(sessions.timers.delete(first)).toBe(false);
    });

    test('dispose stops every timer and forgets every session, without events', () => {
      const clock = createTestClock();
      const deleted: unknown[] = [];
      const reached: unknown[] = [];

      {
        using sessions = createSessionManager<IUser>({ clock });
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

      expect(delaysOn(clock)).toEqual([]);

      clock.tick(20);

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
        sessions.clock.setTimeout(() => {}, 1_000),
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

      // one stored with a token of its own, and no timeout, is timed as one drawn is
      sessions.set({ ...sessions.create(second), sessionToken: tokenOf(7) });

      expect(sessions.gauges()).toMatchObject({
        counts: { sessions: 1, timedConnections: 1 },
      });
    });
  });
});
