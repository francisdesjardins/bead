import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import { EnvelopeKind, ProtocolCode, SERVER_FAILURES } from '../constants';
import { headerBytesOf } from '../header';
import { createPayloadPlacement, isPayloadLimit } from '../payload-placement';
import { createRouterCore } from '../router-core';
import { limitsOf } from '../router-limits';
import type { IProcedure, IRequestResolverProps } from '../types';
import { patternOf } from './fixtures';
import {
  type Handle,
  answerOf,
  answersOf,
  createAnswering,
  createPort,
  echo,
  headerOf,
  limits,
  options,
  piecesOf,
  requestOf,
  resolverOf,
  resultOpeningOf,
  settledOf,
} from './router-core-fixtures';

// definition

test.describe('createRouterCore', () => {
  test.describe('its limits', () => {
    // spec 12.3.2
    test('hold a procedure’s payloads to its own limit, within the router’s, both ways, once admitted', async () => {
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port);
      const seen: IRequestResolverProps<Handle>[] = [];
      const small = { ...echo, maximumPayloadBytes: 8 };
      const refusing = { ...echo, maximumPayloadBytes: 8, procedureId: 7 };
      const ask = (length: number) => {
        return core.request(new Uint8Array(length), {
          connectionHandle: 'a',
          options,
          procedure: small,
        });
      };

      core.registerResolver(resolverOf(small, seen));
      core.registerResolver(
        Object.assign(resolverOf(refusing), {
          admit: () => {
            return SERVER_FAILURES.accessDenied;
          },
        })
      );

      // sent: past the procedure's limit, nothing goes
      await expect(ask(9)).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 8 bytes at most, not 9',
      });

      // received: whole, or as a transfer on its total; admitted first
      core.receive(requestOf(1, { payload: new Uint8Array(9), procedure: small }), 'a');
      core.receive(requestOf(3, { payload: Uint8Array.of(1), procedure: small, total: 9 }), 'a');
      core.receive(requestOf(5, { payload: new Uint8Array(9), procedure: refusing }), 'a');
      core.receive(requestOf(7, { payload: new Uint8Array(8), procedure: small }), 'a');
      await sleep(0);

      // answered: past the procedure's limit, nothing goes
      await expect(
        core.respond(
          { payload: new Uint8Array(9) },
          { connectionHandle: 'a', header: seen[0]?.header ?? headerOf(7) }
        )
      ).rejects.toMatchObject({ code: ProtocolCode.PAYLOAD_TOO_LARGE });

      // a result's transfer past the procedure's limit ends its call
      const asking = ask(8);

      await sleep(0);
      // its call id the next drawn: the call refused above drew one
      core.receive(resultOpeningOf(4, { payload: Uint8Array.of(1), total: 9 }), 'a');

      await expect(asking).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 8 bytes at most, not 9',
      });
      expect(
        seen.map(({ header: { callId } }) => {
          return callId;
        })
      ).toEqual([7]);
      expect(answersOf(sent)).toEqual([
        ['a', 'failure', 1, ProtocolCode.PAYLOAD_TOO_LARGE],
        ['a', 'failure', 3, ProtocolCode.PAYLOAD_TOO_LARGE],
        ['a', 'failure', 5, ProtocolCode.ACCESS_DENIED],
        ['a', EnvelopeKind.REQUEST, 4],
        ['a', EnvelopeKind.CANCEL, 4],
      ]);
      expect(reported).toEqual([]);
    });

    test('hold a procedure whose own limit is larger to the router’s, both ways', async () => {
      const wide: IProcedure = { ...echo, maximumPayloadBytes: 1_024 };
      const { port, reported, sent } = createPort();
      using core = createRouterCore(port, { limits: { ...limits, maximumPayloadBytes: 40 } });
      const seen: IRequestResolverProps<Handle>[] = [];

      core.registerResolver(resolverOf(wide, seen));
      // whole, within its envelope, past the router's limit
      core.receive(requestOf(1, { payload: new Uint8Array(45), procedure: wide }), 'a');

      // past an envelope: it would go as a transfer, whose envelopes each pass
      await expect(
        core.request(patternOf(200), { connectionHandle: 'a', options, procedure: wide })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload is 40 bytes at most, not 200',
      });
      await sleep(0);

      expect(seen).toEqual([]);
      expect(answersOf(sent)).toEqual([['a', 'failure', 1, ProtocolCode.PAYLOAD_TOO_LARGE]]);
      expect(reported).toEqual([]);
    });

    test('refuse a procedure’s limit that is not a whole number above 0, drawing nothing, and take its edge', async () => {
      const { port, sent } = createPort();
      using core = createRouterCore(port);
      const drawn: number[] = [];
      const ask = (procedure: IProcedure, payload = new Uint8Array(0)): Promise<unknown> => {
        return core
          .request(payload, {
            connectionHandle: 'a',
            onCallId: (callId) => {
              drawn.push(callId);
            },
            options,
            procedure,
          })
          .catch((reason: unknown) => {
            return reason;
          });
      };

      for (const maximumPayloadBytes of [0, 1.5, -1, Number.NaN]) {
        expect(() => {
          core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes }));
        }, String(maximumPayloadBytes)).toThrow(/echo's payload limit is a whole number above 0/);
        expect(await ask({ ...echo, maximumPayloadBytes }), String(maximumPayloadBytes)).toEqual(
          expect.objectContaining({
            message: `a payload's limit is a whole number above 0, not ${String(maximumPayloadBytes)}`,
          })
        );
      }

      expect(drawn).toEqual([]);
      expect(sent).toEqual([]);

      // at its edge, a limit of 1 is taken
      core.registerResolver(resolverOf({ ...echo, maximumPayloadBytes: 1 }));
      void ask({ ...echo, maximumPayloadBytes: 1 }, Uint8Array.of(1));

      expect(drawn).toEqual([2]);
    });
  });

  test.describe('the transfers it sends', () => {
    test('send a payload in one envelope to its limit, and one byte more as a transfer, or not at all where none is sent', async () => {
      const answering = createAnswering();
      const { core, sent } = answering;
      const ask = (length: number) => {
        return settledOf(
          core.request(new Uint8Array(length), { connectionHandle: 'a', options, procedure: echo })
        );
      };

      // a request's header takes 12 bytes; a result's 8, and 20 more for an announcement it may carry
      void ask(52);
      void ask(53);
      core.receive(requestOf(1), 'a');
      core.receive(requestOf(3), 'a');
      void settledOf(answerOf(answering, { payload: new Uint8Array(36) }));
      void settledOf(answerOf(answering, { index: 1, payload: new Uint8Array(37) }));
      await sleep(0);

      expect(piecesOf(sent)).toEqual([
        [EnvelopeKind.REQUEST, 2, undefined, 52],
        [EnvelopeKind.REQUEST, 4, 53, 44],
        [EnvelopeKind.RESULT, 1, undefined, 36],
        [EnvelopeKind.RESULT, 3, 37, 28],
      ]);

      const none = createAnswering({ maximumTransfers: 0 });

      none.core.receive(requestOf(1), 'a');

      await expect(
        none.core.request(new Uint8Array(53), { connectionHandle: 'a', options, procedure: echo })
      ).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
        detail: 'a payload of 53 bytes goes as a transfer, which this side sends none of',
      });
      await expect(answerOf(none, { payload: new Uint8Array(37) })).rejects.toMatchObject({
        code: ProtocolCode.PAYLOAD_TOO_LARGE,
      });
      expect(none.sent).toEqual([]);

      core[Symbol.dispose]();
      none.core[Symbol.dispose]();
    });
  });
});

test.describe('createPayloadPlacement', () => {
  test('places a payload whole up to its envelope, as a transfer past it, and refuses one past its limit, a procedure’s held within the router’s', () => {
    const placement = createPayloadPlacement(SERVER_FAILURES, limitsOf(limits));
    const header = headerOf(1);
    const whole = placement.wholeBytes - headerBytesOf(header);

    expect(placement.wholeBytes).toBe(64);
    expect(
      placement.transferOf(new Uint8Array(whole), { header, maximumPayloadBytes: 1_024 })
    ).toBeUndefined();
    expect(
      placement.transferOf(new Uint8Array(whole + 1), { header, maximumPayloadBytes: 1_024 })
    ).toEqual(expect.objectContaining({ total: whole + 1 }));
    expect(placement.transferOf(new Uint8Array(9), { header, maximumPayloadBytes: 8 })).toEqual({
      ...SERVER_FAILURES.payloadTooLarge,
      detail: 'a payload is 8 bytes at most, not 9',
    });
    expect(
      [{ maximumPayloadBytes: 8 }, { maximumPayloadBytes: 4_096 }, undefined].map(
        placement.payloadLimitOf
      )
    ).toEqual([8, 1_024, 1_024]);
    expect([undefined, 1, 8].map(isPayloadLimit)).toEqual([true, true, true]);
    expect([0, -1, 1.5, '8', null].map(isPayloadLimit)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
