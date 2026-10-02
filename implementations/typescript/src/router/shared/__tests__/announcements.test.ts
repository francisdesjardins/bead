import { expect, test } from '@playwright/test';
import { createAnnouncements } from '../announcements';
import { EnvelopeKind } from '../constants';
import type { OutgoingEnvelope, SessionToken } from '../types';

// helpers

const TOKEN = 'AAECAwQFBgcICQoLDA0ODw' as SessionToken;
const OTHER_TOKEN = 'DwAOAQ0CDAMLBAoFCQYIBw' as SessionToken;

const resultOf = (callId: number): OutgoingEnvelope => {
  return {
    header: { callId, kind: EnvelopeKind.RESULT },
    kind: EnvelopeKind.RESULT,
    payload: new Uint8Array(0),
  };
};

const failureOf = (callId: number): OutgoingEnvelope => {
  return {
    failure: { code: 1, scope: 1 },
    header: { callId, kind: EnvelopeKind.FAILURE },
    kind: EnvelopeKind.FAILURE,
  };
};

/** Announcements of a session `current` says, and what each answer carries of it. */
const createAnnouncing = () => {
  const session = { current: TOKEN as SessionToken | undefined };
  const announcements = createAnnouncements<string>({
    sessionTokenOf: () => {
      return session.current;
    },
  });

  // the session an answer carries: the token, `null` for its end, `undefined` for nothing said
  const told = (envelope: OutgoingEnvelope, connectionHandle = 'a') => {
    const announced = announcements.announce(envelope, connectionHandle);

    return {
      restore: announced.restore,
      sessionToken: (announced.envelope.header as { sessionToken?: SessionToken | null })
        .sessionToken,
    };
  };

  return { announcements, session, told };
};

// definition

test.describe('createAnnouncements', () => {
  test('an answer carries the session when it changed, a result or a failure alike', () => {
    const { session, told } = createAnnouncing();

    expect(told(resultOf(1)).sessionToken).toBe(TOKEN);
    expect(told(failureOf(3)).sessionToken).toBeUndefined();
    expect(told(resultOf(5), 'b').sessionToken).toBe(TOKEN);

    session.current = undefined;

    expect(told(failureOf(7)).sessionToken).toBeNull();
    expect(told(resultOf(9)).sessionToken).toBeUndefined();
  });

  test('a connection never told of a session hears nothing of none, and nothing but an answer says one', () => {
    const { announcements, session, told } = createAnnouncing();
    const request: OutgoingEnvelope = {
      header: { callId: 1, kind: EnvelopeKind.REQUEST, procedureId: 1, serviceId: 2 },
      kind: EnvelopeKind.REQUEST,
      payload: new Uint8Array(0),
    };

    session.current = undefined;

    expect(told(resultOf(1)).sessionToken).toBeUndefined();

    session.current = TOKEN;

    expect(announcements.announce(request, 'a').envelope).toBe(request);
    expect(told(resultOf(3)).sessionToken).toBe(TOKEN);
  });

  test('announce nothing without a session to ask for', () => {
    const announcements = createAnnouncements<string>({});
    const result = resultOf(1);

    expect(announcements.announce(result, 'a').envelope).toBe(result);
  });

  test('restore undoes an announcement, unless another was recorded since, or the connection forgotten', () => {
    const { announcements, session, told } = createAnnouncing();

    // never told: undone, the next answer tells again
    told(resultOf(1)).restore();

    const first = told(resultOf(3));

    expect(first.sessionToken).toBe(TOKEN);

    session.current = OTHER_TOKEN;

    const second = told(resultOf(5));

    // recorded over: the first undoes nothing
    first.restore();
    second.restore();
    session.current = TOKEN;

    expect(told(resultOf(7)).sessionToken).toBeUndefined();

    session.current = OTHER_TOKEN;

    const forgotten = told(resultOf(9));

    announcements.forget('a');
    forgotten.restore();

    expect(told(resultOf(11)).sessionToken).toBe(OTHER_TOKEN);
  });

  test('forget what a connection was told, or every connection', () => {
    const { announcements, told } = createAnnouncing();

    told(resultOf(1), 'a');
    told(resultOf(1), 'b');
    announcements.forget('a');

    expect([told(resultOf(3), 'a').sessionToken, told(resultOf(3), 'b').sessionToken]).toEqual([
      TOKEN,
      undefined,
    ]);

    announcements.forget();

    expect([told(resultOf(5), 'a').sessionToken, told(resultOf(5), 'b').sessionToken]).toEqual([
      TOKEN,
      TOKEN,
    ]);
  });

  test('counts the connections told of a session, until each is forgotten', () => {
    const { announcements, told } = createAnnouncing();

    told(resultOf(1), 'a');
    told(resultOf(3), 'b');

    expect(announcements.gauges()).toMatchObject({
      connectionHandles: new Set(['a', 'b']),
      counts: { announced: 2 },
    });

    announcements.forget('a');

    expect(announcements.gauges().counts).toEqual({ announced: 1 });
  });
});
