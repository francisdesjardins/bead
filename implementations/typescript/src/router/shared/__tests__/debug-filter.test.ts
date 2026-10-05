import { expect, test } from '@playwright/test';
import { ProgrammerError } from '../../../transport/shared/errors';
import { EnvelopeKind } from '../constants';
import { filterDebug, filterEnvelopeDebug, parseDebugFilter } from '../debug-filter';
import type { DebugDirection, DebugFilterSource, DebugType, IDebugEvent } from '../types';

// helpers

/** A debug event of `procedureName`'s, going `direction`, of `type`. */
const eventOf = (
  procedureName: string,
  { direction = 'tx', type = 'request' }: { direction?: DebugDirection; type?: DebugType } = {}
): IDebugEvent => {
  return {
    direction,
    duration: undefined,
    options: undefined,
    procedureId: 1,
    procedureName,
    rx: undefined,
    serviceId: 2,
    serviceRevision: 1,
    startedAt: 0,
    tx: undefined,
    type,
  };
};

/** The names of the events a listener filtered by `source` hears, of those given. */
const heardOf = (source: DebugFilterSource, events: IDebugEvent[]): string[] => {
  const heard: string[] = [];
  const listener = filterDebug((_error, event) => {
    heard.push(`${event.procedureName} ${event.direction} ${event.type}`);
  }, source);

  for (const event of events) {
    listener(null, event);
  }

  return heard;
};

// definition

test.describe('parseDebugFilter', () => {
  test('reads words parted by commas or white space: selectors, names to keep, names to leave out', () => {
    expect(parseDebugFilter(' d(rx),t(r|C)  get*, -getStatus\tping ')).toEqual({
      directions: ['rx'],
      exclude: ['getStatus'],
      include: ['get*', 'ping'],
      kinds: [],
      types: ['request', 'command'],
    });
    expect(parseDebugFilter('')).toEqual({
      directions: [],
      exclude: [],
      include: [],
      kinds: [],
      types: [],
    });
  });

  test('names a kind as its constant does, however it is written', () => {
    expect(parseDebugFilter('e(request|FAILURE), E(cancel)').kinds).toEqual([
      EnvelopeKind.REQUEST,
      EnvelopeKind.FAILURE,
      EnvelopeKind.CANCEL,
    ]);

    for (const spec of ['e(r)', 'e(chunks)', 'e(constructor)', 'e()']) {
      expect(() => {
        return parseDebugFilter(spec);
      }, spec).toThrow(ProgrammerError);
    }
  });

  test('keeps every direction and every type its selectors name, however many there are', () => {
    expect(parseDebugFilter('d(rx), D(tx), t(n), t(c)')).toMatchObject({
      directions: ['rx', 'tx'],
      types: ['notification', 'command'],
    });
  });

  test('refuses a direction or a type that is not one, and a selector that names none', () => {
    for (const spec of ['d(up)', 't(p)', 't(n|r|x)', 't(constructor)', 'd()', 't()']) {
      expect(() => {
        return parseDebugFilter(spec);
      }, spec).toThrow(ProgrammerError);
    }
  });

  test('refuses a filter in sentences that name the word, or the value, as it was written, quoted as JSON', () => {
    const refusals: [spec: string, sentence: string][] = [
      ['d(UP)', 'a debug filter takes a direction among rx, tx, not "UP"'],
      [
        't(x)',
        'a debug filter takes a type among request, command, notification, r, c, n, not "x"',
      ],
      [
        'e(chunks)',
        'a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not "chunks"',
      ],
      ['d("rx")', 'a debug filter takes a direction among rx, tx, not "\\"rx\\""'],
      ['d()', `a debug filter's selector names a value, not "d()"`],
      ['d(rx|)', `a debug filter's selector leaves no value empty, not "d(rx|)"`],
      [
        'd(rx,tx)',
        'a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not "d(rx"',
      ],
    ];

    for (const [spec, sentence] of refusals) {
      expect(() => {
        return parseDebugFilter(spec);
      }, spec).toThrow(new ProgrammerError(sentence));
    }
  });
});

test.describe('filterDebug', () => {
  const events = [
    eventOf('getStatus'),
    eventOf('getStatus', { direction: 'rx' }),
    eventOf('GetTime', { direction: 'rx' }),
    eventOf('ping', { type: 'command' }),
    eventOf('news', { direction: 'rx', type: 'notification' }),
  ];

  test('keeps every event without a filter, or with an empty one', () => {
    const none = () => {
      return undefined;
    };

    for (const source of ['', {}, none] as const) {
      expect(heardOf(source, events)).toHaveLength(events.length);
    }
  });

  test('keeps a direction, a type, and the names that match, without regard to case', () => {
    expect(heardOf('d(rx)', events)).toEqual([
      'getStatus rx request',
      'GetTime rx request',
      'news rx notification',
    ]);
    expect(heardOf('t(c|n)', events)).toEqual(['ping tx command', 'news rx notification']);
    expect(heardOf('get*', events)).toEqual([
      'getStatus tx request',
      'getStatus rx request',
      'GetTime rx request',
    ]);
    expect(heardOf('d(rx), get*', events)).toEqual(['getStatus rx request', 'GetTime rx request']);
  });

  test('leaves out what an exclusion names, which wins over what is kept', () => {
    expect(heardOf('-getStatus', events)).toEqual([
      'GetTime rx request',
      'ping tx command',
      'news rx notification',
    ]);
    expect(heardOf('get*, -getstatus', events)).toEqual(['GetTime rx request']);
  });

  test('matches a whole name, and takes every other character literally', () => {
    const names = [eventOf('get+status'), eventOf('a.b'), eventOf('axb'), eventOf('getStatusNow')];

    expect(heardOf('get+status', names)).toEqual(['get+status tx request']);
    expect(heardOf('a.b', names)).toEqual(['a.b tx request']);
    expect(heardOf('getStatus, a+b, [x], ^a', names)).toEqual([]);
    // neither its start nor its end alone
    expect(heardOf('status, getStatu', [eventOf('getStatus')])).toEqual([]);
  });

  test('refuses a filter given whole in the grammar’s names, as it is made', () => {
    const none = () => {
      return undefined;
    };

    expect(() => {
      return filterDebug(none, { types: ['publisher' as DebugType] });
    }).toThrow(
      new ProgrammerError(
        'a debug filter takes a type among request, command, notification, not "publisher"'
      )
    );
    expect(() => {
      return filterDebug(none, { directions: ['Rx' as DebugDirection] });
    }).toThrow(new ProgrammerError('a debug filter takes a direction among rx, tx, not "Rx"'));
    expect(() => {
      return filterEnvelopeDebug(none, { kinds: [0x99 as EnvelopeKind] });
    }).toThrow(
      new ProgrammerError(
        'a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not 153'
      )
    );
  });

  test('takes a filter as an object, its values checked once, as it is given', () => {
    expect(heardOf({ directions: ['tx'], exclude: ['p*'] }, events)).toEqual([
      'getStatus tx request',
    ]);
    expect(() => {
      return filterDebug(
        () => {
          return undefined;
        },
        { types: ['publisher' as DebugType] }
      );
    }).toThrow(ProgrammerError);
  });

  test('refuses, as it is made, a first filter that does not hold', () => {
    expect(() => {
      return filterDebug(() => {
        return undefined;
      }, 'd(up)');
    }).toThrow(ProgrammerError);
    expect(() => {
      return filterDebug(
        () => {
          return undefined;
        },
        () => {
          return 't(x)';
        }
      );
    }).toThrow(ProgrammerError);
  });

  test('asks a function at each event, and keeps the last filter that held when one does not', () => {
    const specs = ['d(rx)', 'd(rx)', 'd(up)', 'd(tx)'];
    let asked = 0;
    const source = () => {
      const spec = specs[Math.min(asked, specs.length - 1)];

      asked += 1;

      if (asked === 4) {
        throw new Error('no spec');
      }

      return spec;
    };
    const heard: string[] = [];
    const listener = filterDebug((_error, event) => {
      heard.push(event.direction);
    }, source);

    // asked once as it is made, then at each event
    for (const direction of ['rx', 'tx', 'rx', 'tx', 'tx'] as const) {
      listener(null, eventOf('echo', { direction }));
    }

    expect(asked).toBe(6);
    // d(rx); d(rx) kept though d(up) does not hold; d(rx) kept though the function threw; d(tx)
    expect(heard).toEqual(['rx', 'rx', 'tx', 'tx']);
  });

  test('reads again only what a function gives anew: the same filter given again is not', () => {
    let reads = 0;
    const filter = {
      get directions(): readonly DebugDirection[] {
        reads += 1;

        return ['rx'];
      },
    };

    expect(
      heardOf(() => {
        return filter;
      }, [
        eventOf('echo', { direction: 'rx' }),
        eventOf('echo'),
        eventOf('echo', { direction: 'rx' }),
      ])
    ).toEqual(['echo rx request', 'echo rx request']);
    // read as it is made, once to key it and once to compile it, and never at an event
    expect(reads).toBe(2);
  });

  test('reads a filter given anew once, however often it is given again after', () => {
    let reads = 0;
    let asked = 0;
    const first = { directions: ['rx'] as const };
    const next = {
      get directions(): readonly DebugDirection[] {
        reads += 1;

        return ['rx'];
      },
    };
    const source = () => {
      asked += 1;

      return asked === 1 ? first : next;
    };

    heardOf(source, [
      eventOf('echo', { direction: 'rx' }),
      eventOf('echo', { direction: 'rx' }),
      eventOf('echo', { direction: 'rx' }),
    ]);

    // read once, to find it is the filter compiled already
    expect(reads).toBe(1);
  });

  test('passes the error and the event on as they came', () => {
    const failure = new Error('failed');
    const event = eventOf('echo');
    const heard: unknown[] = [];

    filterDebug((error, info) => {
      heard.push(error, info);
    }, 'echo')(failure, event);

    expect(heard).toEqual([failure, event]);
  });
});

test.describe('filterEnvelopeDebug', () => {
  const envelopeOf = (kind: EnvelopeKind, direction: DebugDirection = 'tx') => {
    return { connectionHandle: 'a', direction, header: { callId: 3, kind } };
  };
  const envelopes = [
    envelopeOf(EnvelopeKind.REQUEST),
    envelopeOf(EnvelopeKind.RESULT, 'rx'),
    envelopeOf(EnvelopeKind.FAILURE, 'rx'),
    envelopeOf(EnvelopeKind.CANCEL),
  ];

  /** The kinds and directions of the envelopes a listener filtered by `source` hears. */
  const heardOf = (source: DebugFilterSource): string[] => {
    const heard: string[] = [];
    const listener = filterEnvelopeDebug(({ direction, header }) => {
      heard.push(`${String(header.kind)} ${direction}`);
    }, source);

    for (const envelope of envelopes) {
      listener(envelope);
    }

    return heard;
  };

  test('keeps a direction and the kinds named, and every envelope without a filter', () => {
    expect(heardOf('')).toHaveLength(envelopes.length);
    expect(heardOf('d(rx)')).toEqual(['17 rx', '18 rx']);
    expect(heardOf('e(request|cancel)')).toEqual(['16 tx', '22 tx']);
    expect(heardOf({ directions: ['rx'], kinds: [EnvelopeKind.FAILURE] })).toEqual(['18 rx']);
    expect(heardOf({ directions: ['tx'] })).toEqual(['16 tx', '22 tx']);
  });

  test('serves the same spec as the calls: the names and the types of calls are not asked', () => {
    const events: string[] = [];
    const spec = 'd(rx), t(r), e(failure), getStatus';

    filterDebug((_error, event) => {
      events.push(event.procedureName);
    }, spec)(null, eventOf('getStatus', { direction: 'rx' }));

    expect(events).toEqual(['getStatus']);
    expect(heardOf(spec)).toEqual(['18 rx']);
    expect(heardOf('-*, t(c)')).toHaveLength(envelopes.length);
  });

  test('refuses a first filter that does not hold, and keeps the last that held after', () => {
    const specs = ['e(result)', 'e(result)', 'e(nothing)', 'e(cancel)'];
    let asked = 0;
    const heard: string[] = [];

    expect(() => {
      return filterEnvelopeDebug(() => {
        return undefined;
      }, 'e(nothing)');
    }).toThrow(ProgrammerError);
    expect(() => {
      return filterEnvelopeDebug(
        () => {
          return undefined;
        },
        { kinds: [0x99 as EnvelopeKind] }
      );
    }).toThrow(ProgrammerError);

    const listener = filterEnvelopeDebug(
      ({ header }) => {
        heard.push(String(header.kind));
      },
      () => {
        const spec = specs[Math.min(asked, specs.length - 1)];

        asked += 1;

        return spec;
      }
    );

    // e(result) twice; e(nothing) does not hold, so e(result) stays for the result; then e(cancel)
    for (const envelope of [...envelopes, ...envelopes]) {
      listener(envelope);
    }

    expect(heard).toEqual(['17', '22', '22']);
  });
});
