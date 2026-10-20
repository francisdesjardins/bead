import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import {
  CLIENT_FAILURES,
  CredentialScheme,
  EnvelopeKind,
  FailureScope,
  ProtocolCode,
  SERVER_FAILURES,
} from '../constants';
import { DisconnectError, FailureError } from '../errors';
import { toSessionToken } from '../identifiers';
import { createPayloadPlacement } from '../payload-placement';
import { createRouterCore } from '../router-core';
import { limitsOf } from '../router-limits';
import { createRouterWriter, DISPOSED } from '../router-writer';
import type { OutgoingEnvelope, SessionToken } from '../types';
import { envelopeOf } from './fixtures';
import {
  OPAQUE,
  TOKEN,
  answersOf,
  createPort,
  echo,
  headerOf,
  limits,
  options,
  piecesOf,
  requestOf,
} from './router-core-fixtures';

// helpers

const OTHER_TOKEN = toSessionToken(new Uint8Array(16).fill(2));

// what an answer announces besides: another session, by its token; its end
const OTHER_OPAQUE = Object.freeze({ scheme: CredentialScheme.OPAQUE, token: OTHER_TOKEN });
const ENDED = Object.freeze({ scheme: CredentialScheme.NONE });

// definition

test.describe('createRouterCore', () => {
  test.describe('its answers', () => {
    test('announce the session when it changes, and only then', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      const tokens: (SessionToken | undefined)[] = [
        TOKEN,
        TOKEN,
        OTHER_TOKEN,
        undefined,
        undefined,
      ];

      for (const [index, token] of tokens.entries()) {
        control.sessionTokenOf = () => {
          return token;
        };
        await core.respond(
          index % 2 === 0
            ? { payload: new Uint8Array(0) }
            : { failure: SERVER_FAILURES.accessDenied },
          { connectionHandle: 'a', header: headerOf(index * 2 + 1) }
        );
      }

      // another connection, with no session yet, is told nothing
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'b', header: headerOf(1) }
      );

      expect(
        sent.map(({ envelope }) => {
          const header = envelope?.header as { credential?: unknown } | undefined;

          return header !== undefined && 'credential' in header ? header.credential : 'none';
        })
      ).toEqual([OPAQUE, 'none', OTHER_OPAQUE, ENDED, 'none', 'none']);
    });

    test('announce again what an answer that did not go out announced', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);

      control.sessionTokenOf = () => {
        return TOKEN;
      };
      control.sendErrors.set('a', new Error('gone'));

      await expect(
        core.respond({ payload: new Uint8Array(0) }, { connectionHandle: 'a', header: headerOf(1) })
      ).rejects.toThrow('gone');

      control.sendErrors.clear();
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, credential: OPAQUE, kind: EnvelopeKind.RESULT },
        { callId: 3, credential: OPAQUE, kind: EnvelopeKind.RESULT },
      ]);
    });

    test('keep the announcement in the order answers were written, whatever order they settle in', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      let token: SessionToken | undefined = TOKEN;

      control.sessionTokenOf = () => {
        return token;
      };
      control.held = [];

      const first = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      token = OTHER_TOKEN;

      const second = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );
      const [firstSend, secondSend] = control.held;

      // the second settles first, then the first fails: what the second wrote stands
      secondSend?.resolve();
      await second;
      firstSend?.reject(new Error('gone'));
      await expect(first).rejects.toThrow('gone');

      control.held = undefined;
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(5) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, credential: OPAQUE, kind: EnvelopeKind.RESULT },
        { callId: 3, credential: OTHER_OPAQUE, kind: EnvelopeKind.RESULT },
        { callId: 5, kind: EnvelopeKind.RESULT },
      ]);
    });

    test('forget the announcement with the connection, even with an answer in flight', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);

      control.sessionTokenOf = () => {
        return TOKEN;
      };
      control.held = [];

      const inFlight = core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      core.rejectPending('a closed', 'a');
      // it goes out after all, and undoes nothing
      control.held[0]?.resolve();
      await inFlight;

      // a connection of the same handle is told anew
      control.held = undefined;
      await core.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(3) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([
        { callId: 1, credential: OPAQUE, kind: EnvelopeKind.RESULT },
        { callId: 3, credential: OPAQUE, kind: EnvelopeKind.RESULT },
      ]);
    });

    test('fail the answer whose session cannot be told, and announce nothing without a way to', async () => {
      const { control, port, sent } = createPort();
      using core = createRouterCore(port);
      const sessionless = new Error('no session');

      control.sessionTokenOf = () => {
        throw sessionless;
      };

      await expect(
        core.respond({ payload: new Uint8Array(0) }, { connectionHandle: 'a', header: headerOf(1) })
      ).rejects.toBe(sessionless);
      expect(sent).toEqual([]);

      const { sessionTokenOf: _, ...withoutSessions } = port;
      using bare = createRouterCore(withoutSessions);

      await bare.respond(
        { payload: new Uint8Array(0) },
        { connectionHandle: 'a', header: headerOf(1) }
      );

      expect(
        sent.map(({ envelope }) => {
          return envelope?.header;
        })
      ).toEqual([{ callId: 1, kind: EnvelopeKind.RESULT }]);
    });
  });

  test.describe('its limits', () => {
    test('refuse a payload past its own limit, and an envelope past its own', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, {
        limits: {
          chunkBytes: 64,
          maximumEnvelopeBytes: 64,
          maximumPayloadBytes: 8,
          windowBytes: 128,
        },
      });

      // a request's, and a notification's, which goes as the side sends it
      for (const sending of [
        core.request(new Uint8Array(9), { connectionHandle: 'a', options, procedure: echo }),
        core.send(
          {
            header: { callId: 2, kind: EnvelopeKind.NOTIFICATION },
            kind: EnvelopeKind.NOTIFICATION,
            payload: new Uint8Array(9),
          },
          'a'
        ),
      ]) {
        await expect(sending).rejects.toMatchObject({
          code: ProtocolCode.PAYLOAD_TOO_LARGE,
          detail: 'a payload is 8 bytes at most, not 9',
        });
      }

      core.receive(requestOf(1, { payload: new Uint8Array(53) }), 'a');
      await sleep(0);

      expect(answersOf(sent)).toEqual([['a', 'failure', 1, ProtocolCode.ENVELOPE_TOO_LARGE]]);
    });

    test('cut a failure’s detail to what its envelope holds, and to its own limit, both ways', async () => {
      const detail = 'x'.repeat(100);
      const failure = { code: 1, detail, scope: FailureScope.APPLICATION };

      for (const [limits, length] of [
        [{ chunkBytes: 64, maximumEnvelopeBytes: 64, windowBytes: 128 }, 32],
        [{ maximumDetailBytes: 10 }, 10],
      ] as const) {
        const { port, sent } = createPort();
        using core = createRouterCore(port, { limits });

        await core.respond({ failure }, { connectionHandle: 'a', header: headerOf(1) });

        const [{ envelope } = { envelope: undefined }] = sent;

        expect(envelope?.kind === EnvelopeKind.FAILURE && envelope.failure.detail).toHaveLength(
          length
        );
      }

      const { port } = createPort();
      using core = createRouterCore(port, { limits: { maximumDetailBytes: 4 } });
      const asking = core.request(new Uint8Array(0), {
        connectionHandle: 'a',
        options,
        procedure: echo,
      });

      await sleep(0);
      core.receive(
        envelopeOf({
          failure: { code: 1, detail: 'abcdefgh', scope: FailureScope.APPLICATION },
          header: { callId: 2, kind: EnvelopeKind.FAILURE },
          kind: EnvelopeKind.FAILURE,
        }),
        'a'
      );

      await expect(asking).rejects.toMatchObject({ detail: 'abcd' });

      const client = createPort({ failures: CLIENT_FAILURES });
      using clientCore = createRouterCore(client.port, { limits: { maximumDetailBytes: 10 } });
      const asked = clientCore.request(Uint8Array.of(1), {
        connectionHandle: 'a',
        options: { timeout: 5_000 },
        procedure: echo,
      });
      clientCore.receive(
        envelopeOf({
          kind: EnvelopeKind.FAILURE,
          header: { kind: EnvelopeKind.FAILURE, callId: 1 },
          failure: { code: 7, detail, scope: FailureScope.APPLICATION },
        }),
        'a'
      );
      await expect(asked).rejects.toMatchObject({ detail: 'x'.repeat(10) });
    });
  });

  test.describe('the transfers it sends', () => {
    test('refuse a notification too large for one envelope, and send one that fits', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port, { limits });
      const notificationOf = (length: number): OutgoingEnvelope => {
        return {
          header: { callId: 2, kind: EnvelopeKind.NOTIFICATION },
          kind: EnvelopeKind.NOTIFICATION,
          payload: new Uint8Array(length),
        };
      };

      await expect(core.send(notificationOf(57), 'a')).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'an envelope is 64 bytes at most, not 65',
      });
      await core.send(notificationOf(56), 'a');

      expect(piecesOf(sent)).toEqual([[EnvelopeKind.NOTIFICATION, 2]]);
    });
  });
});

test.describe('createRouterWriter', () => {
  test('hands an envelope within its limits to its port’s transport, traced, refuses one past them, and sends nothing once its router is disposed', async () => {
    const { port, sent, traced } = createPort();
    const routerLimits = limitsOf(limits);
    let isDisposed = false;
    const writer = createRouterWriter(port, {
      isDisposed: () => {
        return isDisposed;
      },
      limits: routerLimits,
      tooLargeOf: createPayloadPlacement(SERVER_FAILURES, routerLimits).tooLargeOf,
    });
    const requestWith = (length: number): OutgoingEnvelope => {
      return { header: headerOf(1), kind: EnvelopeKind.REQUEST, payload: new Uint8Array(length) };
    };

    await writer.deliver(requestWith(4), { connectionHandle: 'a' });
    expect(piecesOf(sent)).toEqual([[EnvelopeKind.REQUEST, 1, undefined, 4]]);
    expect(traced).toEqual(['tx 10 1 a']);

    for (const length of [100, 2_000]) {
      const refused: unknown = await writer
        .deliver(requestWith(length), { connectionHandle: 'a' })
        .catch((reason: unknown) => {
          return reason;
        });

      expect(refused).toBeInstanceOf(FailureError);
      expect(refused).toEqual(expect.objectContaining({ code: ProtocolCode.PAYLOAD_TOO_LARGE }));
    }

    isDisposed = true;
    await expect(writer.deliver(requestWith(4), { connectionHandle: 'a' })).rejects.toEqual(
      new DisconnectError(DISPOSED)
    );
    expect(sent).toHaveLength(1);
  });
});
