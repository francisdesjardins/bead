import { expect, test } from '@playwright/test';
import { refusalOfHandshake, WS_REFUSALS, type IHandshakeRequestLike } from '../ws-handshake';

// constants

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

// RFC 6455 §1.3's handshake, from a host and an origin the server takes
const HANDSHAKE: readonly (readonly [string, string])[] = [
  ['Host', 'bead.test'],
  ['Upgrade', 'websocket'],
  ['Connection', 'Upgrade'],
  ['Sec-WebSocket-Key', KEY],
  ['Sec-WebSocket-Version', '13'],
];

const TAKEN = { hosts: ['bead.test'], origins: ['https://bead.example'] };

// helpers

/**
 * A request: the handshake's fields but those `without` names, then `fields`, in a request of
 * `method` and `httpVersion`, `GET` and `1.1` unless they say.
 */
const requestOf = (
  fields: readonly (readonly [string, string])[] = [],
  {
    httpVersion = '1.1',
    method = 'GET',
    without = [],
  }: { httpVersion?: string; method?: string; without?: readonly string[] } = {}
): IHandshakeRequestLike => {
  const kept = HANDSHAKE.filter(([name]) => {
    return !without.includes(name.toLowerCase());
  });

  return {
    httpVersion,
    method,
    rawHeaders: [...kept, ...fields].flat(),
  };
};

// the status and the mark the judgement answers `request` with; none for an upgrade it takes
const answerOf = (request: IHandshakeRequestLike) => {
  const refusal = refusalOfHandshake(request, TAKEN);

  return refusal === undefined ? 'taken' : [refusal.status, refusal.refusal];
};

const HOST = [400, undefined];
const HOST_REFUSED = [403, WS_REFUSALS.HOST];
const METHOD = [405, WS_REFUSALS.METHOD];
const UPGRADE = [426, WS_REFUSALS.UPGRADE];
const VERSION = [426, WS_REFUSALS.VERSION];
const MALFORMED = [400, WS_REFUSALS.MALFORMED];
const ORIGIN = [403, WS_REFUSALS.ORIGIN];

// definition

test.describe('refusalOfHandshake', () => {
  test('names each refusal of its own as spec 15.6 marks it', () => {
    expect(WS_REFUSALS).toEqual({
      BUSY: 'busy',
      HOST: 'host-refused',
      MALFORMED: 'malformed',
      METHOD: 'method-refused',
      ORIGIN: 'origin-refused',
      UPGRADE: 'upgrade-required',
      VERSION: 'version-refused',
    });
    expect(Object.isFrozen(WS_REFUSALS)).toBe(true);
  });

  test('writes each answer whole: marked, never stored nor sniffed, empty, its connection closed, and HTTP’s own unmarked', () => {
    const marked = (refusal: string, fields: Record<string, string> = {}) => {
      return {
        'bead-refusal': refusal,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...fields,
        'content-length': '0',
        connection: 'upgrade' in fields ? 'upgrade, close' : 'close',
      };
    };
    const whole = (request: IHandshakeRequestLike) => {
      const refusal = refusalOfHandshake(request, TAKEN);

      return refusal === undefined
        ? undefined
        : { fields: { ...refusal.fields }, refusal: refusal.refusal, status: refusal.status };
    };

    expect([
      whole(requestOf([], { without: ['host'] })),
      whole(requestOf([['Host', 'elsewhere.test']], { without: ['host'] })),
      whole(requestOf([], { method: 'POST' })),
      whole(requestOf([], { without: ['upgrade'] })),
      whole(requestOf([['Sec-WebSocket-Version', '8']], { without: ['sec-websocket-version'] })),
      whole(requestOf([], { without: ['sec-websocket-key'] })),
      whole(requestOf([['Origin', 'https://elsewhere.test']])),
    ]).toEqual([
      {
        fields: { 'content-length': '0', connection: 'close' },
        refusal: undefined,
        status: 400,
      },
      { fields: marked('host-refused'), refusal: 'host-refused', status: 403 },
      {
        fields: marked('method-refused', { allow: 'GET, HEAD' }),
        refusal: 'method-refused',
        status: 405,
      },
      {
        fields: marked('upgrade-required', { upgrade: 'websocket' }),
        refusal: 'upgrade-required',
        status: 426,
      },
      {
        fields: marked('version-refused', {
          upgrade: 'websocket',
          'sec-websocket-version': '13',
        }),
        refusal: 'version-refused',
        status: 426,
      },
      { fields: marked('malformed'), refusal: 'malformed', status: 400 },
      { fields: marked('origin-refused'), refusal: 'origin-refused', status: 403 },
    ]);
  });

  test('takes a handshake well formed, its fields read as lists in any ASCII case, without the whitespace around them', () => {
    expect(
      [
        requestOf(),
        requestOf([['Upgrade', 'WebSocket']], { without: ['upgrade'] }),
        requestOf([['Upgrade', 'h2c, websocket']], { without: ['upgrade'] }),
        requestOf(
          [
            ['Upgrade', 'h2c'],
            ['Upgrade', 'websocket'],
          ],
          { without: ['upgrade'] }
        ),
        requestOf([['Connection', 'keep-alive, UPGRADE']], { without: ['connection'] }),
        requestOf(
          [
            ['Connection', 'keep-alive'],
            ['Connection', 'upgrade'],
          ],
          { without: ['connection'] }
        ),
        requestOf([['Content-Length', '0']]),
        requestOf([['Content-Length', '00']]),
        requestOf([['Sec-WebSocket-Key', 'AAAAAAAAAAAAAAAAAAAAAA==']], {
          without: ['sec-websocket-key'],
        }),
        requestOf([['Sec-WebSocket-Key', `  ${KEY}\t`]], { without: ['sec-websocket-key'] }),
        requestOf([['Sec-WebSocket-Key', 'abcdefghijklmnopqrstuw==']], {
          without: ['sec-websocket-key'],
        }),
        requestOf([['Sec-WebSocket-Version', ' 13 ']], { without: ['sec-websocket-version'] }),
        requestOf([['Sec-WebSocket-Protocol', 'bead, chat']]),
        requestOf([
          ['Sec-WebSocket-Protocol', 'bead'],
          ['Sec-WebSocket-Protocol', 'chat'],
        ]),
        requestOf([['Sec-WebSocket-Extensions', ';;;']]),
        requestOf([['Origin', 'http://bead.test']]),
        requestOf([['Origin', 'https://bead.example']]),
        requestOf([['host', 'BEAD.test']], { without: ['host'] }),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 18 }, () => {
        return 'taken';
      })
    );
  });

  test('refuses what HTTP refuses of its own first, a Host missing, repeated or no host, unmarked', () => {
    expect(
      [
        requestOf([], { without: ['host'] }),
        requestOf([['Host', 'bead.test']]),
        requestOf([['Host', 'bead.test']], { method: 'POST' }),
        requestOf([['Host', 'bad host']], { method: 'POST', without: ['host'] }),
        requestOf([['Host', 'bead.test:80x']], { without: ['host'] }),
        requestOf([['Host', '[::1%25eth0]']], { without: ['host'] }),
        requestOf([['Host', 'bead.test']], { httpVersion: '1.0' }),
      ].map(answerOf)
    ).toEqual([HOST, HOST, HOST, HOST, HOST, HOST, HOST]);

    // an HTTP/1.0 request may name none, and asks no WebSocket
    expect(answerOf(requestOf([], { httpVersion: '1.0', without: ['host'] }))).toEqual(
      HOST_REFUSED
    );
    expect(
      refusalOfHandshake(requestOf([], { httpVersion: '1.0', without: ['host'] }), {
        hosts: undefined,
        origins: [],
      })?.refusal
    ).toBe(WS_REFUSALS.UPGRADE);
  });

  test('refuses a host it does not take before anything else of the request is read', () => {
    const elsewhere = [['Host', 'elsewhere.test']] as const;

    expect(
      [
        requestOf(elsewhere, { without: ['host'] }),
        requestOf(elsewhere, { method: 'POST', without: ['host'] }),
        requestOf(elsewhere, { method: 'CONNECT', without: ['host'] }),
        requestOf(elsewhere, { method: 'HEAD', without: ['host'] }),
        requestOf(elsewhere, { without: ['host', 'upgrade', 'connection'] }),
        requestOf(elsewhere, { httpVersion: '1.0', without: ['host'] }),
        requestOf([...elsewhere, ['Sec-WebSocket-Version', '8']], {
          without: ['host', 'sec-websocket-version'],
        }),
        requestOf([...elsewhere, ['Sec-WebSocket-Key', 'dGVzdA==']], {
          without: ['host', 'sec-websocket-key'],
        }),
        requestOf([...elsewhere, ['Origin', 'https://elsewhere.test']], { without: ['host'] }),
        requestOf([['Host', '']], { without: ['host'] }),
        requestOf([['Host', 'bead.test:8080']], { without: ['host'] }),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 11 }, () => {
        return HOST_REFUSED;
      })
    );
  });

  test('refuses a method but GET or HEAD 405, before its upgrade is read', () => {
    expect(
      [
        requestOf([], { method: 'POST' }),
        requestOf([], { method: 'PUT' }),
        requestOf([], { method: 'OPTIONS' }),
        requestOf([], { method: 'CONNECT' }),
        requestOf([], { method: 'DELETE', without: ['upgrade', 'connection'] }),
        requestOf([['Sec-WebSocket-Version', '8']], {
          method: 'POST',
          without: ['sec-websocket-version'],
        }),
        requestOf([], { httpVersion: '1.0', method: 'POST' }),
        requestOf([], { method: 'get' }),
        requestOf([], { method: 'TRACE' }),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 9 }, () => {
        return METHOD;
      })
    );
  });

  test('answers a request that asks no WebSocket 426, whatever its version or its form', () => {
    expect(
      [
        requestOf([], { without: ['upgrade', 'connection'] }),
        requestOf([], { without: ['upgrade'] }),
        requestOf([['Upgrade', 'h2c']], { without: ['upgrade'] }),
        requestOf([['Upgrade', 'websocket/13']], { without: ['upgrade'] }),
        requestOf([['Upgrade', 'web socket']], { without: ['upgrade'] }),
        requestOf([], { without: ['connection'] }),
        requestOf([['Connection', 'keep-alive']], { without: ['connection'] }),
        requestOf([['Connection', 'upgraded']], { without: ['connection'] }),
        requestOf(
          [
            ['Upgrade', 'h2c'],
            ['Sec-WebSocket-Version', '8'],
          ],
          {
            without: ['upgrade', 'sec-websocket-version'],
          }
        ),
        requestOf([], { method: 'HEAD' }),
        requestOf([['Sec-WebSocket-Version', '8']], {
          method: 'HEAD',
          without: ['sec-websocket-version'],
        }),
        requestOf([], { method: 'HEAD', without: ['upgrade', 'connection'] }),
        requestOf([], { httpVersion: '1.0' }),
        requestOf([['Upgrade', 'websocket, h2c']], { httpVersion: '1.0', without: ['upgrade'] }),
        requestOf([], { httpVersion: '1.0', without: ['upgrade', 'connection'] }),
        requestOf([['Sec-WebSocket-Key', 'dGVzdA==']], {
          without: ['upgrade', 'sec-websocket-key'],
        }),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 16 }, () => {
        return UPGRADE;
      })
    );
  });

  test('refuses a version in two field lines as malformed, and answers any other but 13, or none, 426 before its key and its origin', () => {
    const versioned = (version: string, fields: readonly (readonly [string, string])[] = []) => {
      return requestOf([['Sec-WebSocket-Version', version], ...fields], {
        without: ['sec-websocket-version', 'sec-websocket-key'],
      });
    };

    expect(
      [
        requestOf([['Sec-WebSocket-Version', '13']]),
        requestOf([['Sec-WebSocket-Version', '8']]),
      ].map(answerOf)
    ).toEqual([MALFORMED, MALFORMED]);
    expect(
      [
        versioned('8', [['Sec-WebSocket-Key', KEY]]),
        versioned('7', [['Sec-WebSocket-Key', KEY]]),
        versioned('14', [['Sec-WebSocket-Key', KEY]]),
        versioned('013', [['Sec-WebSocket-Key', KEY]]),
        versioned('13, 8', [['Sec-WebSocket-Key', KEY]]),
        versioned('8, 13', [['Sec-WebSocket-Key', KEY]]),
        versioned(''),
        versioned('8', [['Sec-WebSocket-Key', 'dGVzdA==']]),
        versioned('8', [
          ['Sec-WebSocket-Key', KEY],
          ['Origin', 'https://elsewhere.test'],
        ]),
        versioned('8', [
          ['Sec-WebSocket-Key', KEY],
          ['Content-Length', '5'],
        ]),
        requestOf([], { without: ['sec-websocket-version'] }),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 11 }, () => {
        return VERSION;
      })
    );
  });

  test('refuses an upgrade of version 13 malformed 400 by its key, its subprotocols or its content, before its origin', () => {
    const keyed = (keys: readonly string[]) => {
      return requestOf(
        keys.map((key) => {
          return ['Sec-WebSocket-Key', key] as const;
        }),
        { without: ['sec-websocket-key'] }
      );
    };

    expect(
      [
        keyed([]),
        keyed(['not a key at all!!!!!==']),
        keyed(['dGVzdA==']),
        keyed(['dGhlIHNhbXBsZSBub25jZQ']),
        keyed(['dGhlIHNhbXBsZSBub25jZSE=']),
        keyed(['AAAAAAAAAAAAAAAAAAAAAAA=']),
        keyed([KEY, KEY]),
        keyed(['']),
        keyed(['dGhlIHNhbXBs ZSBub25jZQ==']),
        requestOf([['Sec-WebSocket-Protocol', 'a b']]),
        requestOf([['Sec-WebSocket-Protocol', 'bead, bead']]),
        requestOf([
          ['Sec-WebSocket-Protocol', 'bead'],
          ['Sec-WebSocket-Protocol', 'bead'],
        ]),
        requestOf([['Sec-WebSocket-Protocol', 'bead,,chat']]),
        requestOf([['Sec-WebSocket-Protocol', 'bead,']]),
        requestOf([['Sec-WebSocket-Protocol', '']]),
        requestOf([['Sec-WebSocket-Protocol', 'bead/1']]),
        requestOf([['Content-Length', '5']]),
        requestOf([['Transfer-Encoding', 'chunked']]),
        requestOf(
          [
            ['Sec-WebSocket-Key', 'dGVzdA=='],
            ['Origin', 'https://elsewhere.test'],
          ],
          { without: ['sec-websocket-key'] }
        ),
      ].map(answerOf)
    ).toEqual(
      Array.from({ length: 19 }, () => {
        return MALFORMED;
      })
    );
  });

  test('refuses an Origin neither its own nor among those it takes last, 403', () => {
    expect(
      [
        requestOf([['Origin', 'https://elsewhere.test']]),
        requestOf([['Origin', 'http://bead.test:80']]),
        requestOf([['Origin', 'null']]),
        requestOf([
          ['Origin', 'http://bead.test'],
          ['Origin', 'http://bead.test'],
        ]),
      ].map(answerOf)
    ).toEqual([ORIGIN, ORIGIN, ORIGIN, ORIGIN]);
  });

  test('takes every host, and any origin’s page of its own, when given no hosts, but never a Host HTTP refuses', () => {
    const answerUntold = (request: IHandshakeRequestLike) => {
      const refusal = refusalOfHandshake(request, { hosts: undefined, origins: [] });

      return refusal === undefined ? 'taken' : [refusal.status, refusal.refusal];
    };

    expect(
      [
        requestOf([['Host', 'elsewhere.test']], { without: ['host'] }),
        requestOf(
          [
            ['Host', 'xn---bad-cpa.test'],
            ['Origin', 'http://xn---bad-cpa.test'],
          ],
          { without: ['host'] }
        ),
        requestOf(
          [
            ['Host', 'elsewhere.test'],
            ['Origin', 'https://bead.example'],
          ],
          { without: ['host'] }
        ),
        requestOf([], { without: ['host'] }),
        requestOf([], { httpVersion: '1.0', without: ['host'] }),
        requestOf([['Host', '[::1']], { without: ['host'] }),
        // HTTP/2's authority is its server's
        requestOf([], { httpVersion: '2.0', method: 'POST', without: ['host'] }),
      ].map(answerUntold)
    ).toEqual(['taken', 'taken', ORIGIN, HOST, UPGRADE, HOST, METHOD]);
  });
});
