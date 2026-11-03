import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  askedOf,
  carriersOf,
  inputsOf,
  membersOf,
  problemsOf,
  rowsOf,
  seedOf,
  surfaceOf,
} from '../check-durations.mjs';
import { differencesOf, publicLinesOf, readOf, ROOT } from '../surface-lists.mjs';

const TYPESCRIPT = [
  './broker-participant',
  '  IBrokerParticipantOptions\tsrc/transport/shared/broker-participant.ts',
  '  createBrokerParticipant\tsrc/transport/shared/broker-participant.ts',
  '',
  'src/transport/client/types.ts ITransportClientConnectOptions',
  '  interface ITransportClientConnectOptions',
  '    signal?: AbortSignal | undefined',
  '    timeout?: number | undefined',
  'src/transport/client/types.ts ITransportClientReconnectOptions',
  '  interface ITransportClientReconnectOptions',
  '    delay?: TransportClientReconnectDelay | undefined',
  '    maximumAttempts?: number | undefined',
  'src/transport/client/types.ts TransportClientReconnectDelay',
  '  type TransportClientReconnectDelay = number | TransportClientReconnectDelayResolver',
  'src/transport/client/types.ts TransportClientReconnectDelayResolver',
  '  type TransportClientReconnectDelayResolver = (previousDelay: number | undefined, attempt: number) => number',
  'src/transport/shared/broker-participant.ts IBrokerParticipantOptions',
  '  interface IBrokerParticipantOptions',
  '    closeOnTimeout?: boolean | undefined',
  '    heartbeat?: number | undefined',
  '    reconnect?: ITransportClientReconnectOptions | undefined',
  'src/transport/shared/broker-participant.ts createBrokerParticipant',
  '  const createBrokerParticipant(adapter: IBrokerAdapter, options?: IBrokerParticipantOptions): IBrokerParticipant',
  '',
].join('\n');

const CSHARP_SHIPPED = [
  '#nullable enable',
  'Bead.BrokerParticipant',
  'Bead.BrokerParticipant.BrokerParticipant(Bead.IBrokerAdapter! adapter, Bead.BrokerParticipantOptions? options = null) -> void',
  'Bead.BrokerParticipantOptions',
  'Bead.BrokerParticipantOptions.Equals(Bead.BrokerParticipantOptions? other) -> bool',
  'Bead.BrokerParticipantOptions.Heartbeat.get -> System.TimeSpan',
  'Bead.BrokerParticipantOptions.Heartbeat.init -> void',
  'Bead.BrokerParticipantOptions.Reconnect.get -> Bead.TransportReconnectOptions?',
  'Bead.TransportClientReconnectDelay',
  'Bead.TransportClientReconnectDelay.TransportClientReconnectDelay(System.TimeSpan delay) -> void',
  'Bead.TransportClientReconnectDelayResolver',
  'virtual Bead.TransportClientReconnectDelayResolver.Invoke(System.TimeSpan? previousDelay, int attempt) -> System.TimeSpan',
  'Bead.TransportClientReconnectOptions',
  'Bead.TransportClientReconnectOptions.Delay.get -> Bead.TransportClientReconnectDelay?',
  'Bead.TransportClientReconnectOptions.MaximumAttempts.get -> int?',
  'Bead.TransportReconnectOptions',
  'Bead.TransportReconnectOptions.Wait.get -> System.TimeSpan',
  '',
].join('\n');

const CSHARP_UNSHIPPED = [
  '#nullable enable',
  'Bead.BrokerParticipantOptions.Reconnect.get -> Bead.TransportClientReconnectOptions?',
  '*REMOVED*Bead.BrokerParticipantOptions.Reconnect.get -> Bead.TransportReconnectOptions?',
  '*REMOVED*Bead.TransportReconnectOptions',
  '*REMOVED*Bead.TransportReconnectOptions.Wait.get -> System.TimeSpan',
  '',
].join('\n');

const RUST = [
  'crate',
  '  use broker::participant::BrokerParticipantOptions',
  'crate::broker::participant',
  '  const HEARTBEAT: Duration',
  '  struct BrokerParticipantOptions #[non_exhaustive]',
  '    pub heartbeat: Option<Duration>',
  '    pub reconnect: Option<crate::transport::TransportClientReconnectOptions>',
  '    derives Clone, Debug, Default',
  '  struct BrokerParticipant',
  '    fn new(adapter: Arc<dyn BrokerAdapter>, options: &BrokerParticipantOptions) -> Result<Self, ProgrammerError>',
  'crate::errors',
  '  enum Refusal #[non_exhaustive]',
  '    Duration(DurationRefusal)',
  '  enum DurationRefusal #[non_exhaustive]',
  '    NotANumber',
  'crate::router::client',
  '  struct RouterClient',
  '    fn reserve(&self, call_id: u32, timeout: Option<Duration>) -> Result<BoxFuture<()>, ProgrammerError>',
  'crate::transport',
  '  struct TransportClientReconnectOptions #[non_exhaustive]',
  '    pub delay: Option<TransportClientReconnectDelay>',
  '    pub maximum_attempts: Option<u32>',
  '',
].join('\n');

const LISTS = Object.freeze({
  typescript: TYPESCRIPT,
  csharp: publicLinesOf(CSHARP_SHIPPED, CSHARP_UNSHIPPED),
  rust: [RUST],
});

const WORKER = 'The Web Worker transport';

const SUPPORT = [
  '## Differences',
  '',
  'A difference is of one of three kinds.',
  '',
  '| Difference               | Kind | TypeScript | C#     | Rust   |',
  '| ------------------------ | ---- | ---------- | ------ | ------ |',
  `| ${WORKER} | open | played     | ahead | ahead |`,
  '',
].join('\n');

const DURATIONS = Object.freeze({
  places: [
    { id: 'brokerParticipant.heartbeat', ways: [{ id: 'options' }] },
    { id: 'brokerParticipant.reconnectionDelay', ways: [{ id: 'number' }] },
    {
      id: 'transportClient.connectTimeout',
      ways: [
        {
          id: 'worker',
          differs: [
            { row: WORKER, language: 'C#' },
            { row: WORKER, language: 'Rust' },
          ],
        },
      ],
    },
    { id: 'router.reservation', ways: [{ id: 'reserve' }] },
  ],
});

// the rows the fixtures pass with, by their place and way, or `no place` and their reason
const ROWS = Object.freeze({
  'brokerParticipant.heartbeat\toptions': [
    'IBrokerParticipantOptions.heartbeat, createBrokerParticipant(options)',
    'Bead.BrokerParticipantOptions.Heartbeat, Bead.BrokerParticipant.BrokerParticipant(options)',
    'BrokerParticipantOptions::heartbeat, BrokerParticipant::new(options)',
  ],
  'brokerParticipant.reconnectionDelay\tnumber': [
    'IBrokerParticipantOptions.reconnect, ITransportClientReconnectOptions.delay, TransportClientReconnectDelay',
    'Bead.BrokerParticipantOptions.Reconnect, Bead.TransportClientReconnectOptions.Delay, Bead.TransportClientReconnectDelay.TransportClientReconnectDelay(delay)',
    'BrokerParticipantOptions::reconnect, TransportClientReconnectOptions::delay',
  ],
  'transportClient.connectTimeout\tworker': [
    'ITransportClientConnectOptions.timeout',
    `- differs: ${WORKER}`,
    `- differs: ${WORKER}`,
  ],
  'router.reservation\treserve': [
    "- inside: its router's core",
    "- inside: its router's core",
    'RouterClient::reserve(timeout)',
  ],
  'no place\ta resolver, which Bead calls': [
    'TransportClientReconnectDelayResolver(previousDelay)',
    'Bead.TransportClientReconnectDelayResolver.Invoke, Bead.TransportClientReconnectDelayResolver.Invoke(previousDelay)',
    '-',
  ],
  'no place\ta constant': ['-', '-', 'broker::participant::HEARTBEAT'],
});

const fileOf = (rows = ROWS) => {
  return [
    '# place\tway\ttypescript\tcsharp\trust',
    ...Object.entries(rows).map(([key, cells]) => {
      return [key, ...cells].join('\t');
    }),
    '',
  ].join('\n');
};

const inputsWith = (lists = LISTS) => {
  return {
    durations: DURATIONS,
    surface: surfaceOf(lists),
    differences: differencesOf(SUPPORT),
  };
};

const problemsWith = (rows, lists) => {
  return problemsOf(fileOf(rows), inputsWith(lists));
};

// the rows with one replaced, or taken out where `cells` is undefined
const with_ = (key, cells) => {
  const rows = { ...ROWS };

  if (cells === undefined) {
    delete rows[key];
  } else {
    rows[key] = cells;
  }

  return rows;
};

describe('membersOf', () => {
  test('reads a C# line naming TimeSpan, a property, a constructor, a parameter and a delegate', () => {
    assert.deepEqual(membersOf(LISTS).csharp, [
      'Bead.BrokerParticipantOptions.Heartbeat',
      'Bead.TransportClientReconnectDelay.TransportClientReconnectDelay(delay)',
      'Bead.TransportClientReconnectDelayResolver.Invoke',
      'Bead.TransportClientReconnectDelayResolver.Invoke(previousDelay)',
    ]);
  });

  test('reads a Rust field, parameter and constant whose type names Duration, never a name that holds the word', () => {
    assert.deepEqual(membersOf(LISTS).rust, [
      'BrokerParticipantOptions::heartbeat',
      'RouterClient::reserve(timeout)',
      'broker::participant::HEARTBEAT',
    ]);
  });

  test('reads a TypeScript member or parameter typed number whose name is a duration’s, never a boolean', () => {
    assert.deepEqual(membersOf(LISTS).typescript, [
      'IBrokerParticipantOptions.heartbeat',
      'ITransportClientConnectOptions.timeout',
      'ITransportClientReconnectOptions.delay',
      'TransportClientReconnectDelay',
      'TransportClientReconnectDelayResolver(previousDelay)',
    ]);
  });

  test('applies a C# Unshipped list’s removals', () => {
    const shipped = membersOf({ ...LISTS, csharp: publicLinesOf(CSHARP_SHIPPED) }).csharp;

    assert.ok(shipped.includes('Bead.TransportReconnectOptions.Wait'));
    assert.ok(!membersOf(LISTS).csharp.includes('Bead.TransportReconnectOptions.Wait'));
    assert.equal(
      surfaceOf(LISTS).csharp.get('Bead.BrokerParticipantOptions.Reconnect').type,
      'Bead.TransportClientReconnectOptions?'
    );
  });
});

describe('carriersOf', () => {
  test('makes a type a carrier when a member of it stands on a place row', () => {
    const carriers = carriersOf(rowsOf(fileOf()), surfaceOf(LISTS));

    assert.deepEqual(
      Object.fromEntries(
        Object.entries(carriers).map(([side, types]) => {
          return [side, [...types].sort()];
        })
      ),
      {
        typescript: [
          'IBrokerParticipantOptions',
          'ITransportClientConnectOptions',
          'ITransportClientReconnectOptions',
        ],
        csharp: ['Bead.BrokerParticipantOptions', 'Bead.TransportClientReconnectOptions'],
        rust: ['BrokerParticipantOptions', 'TransportClientReconnectOptions'],
      }
    );

    // a `no place` row's member makes none, nor a place row's parameter
    const none = carriersOf(
      rowsOf(fileOf({ 'no place\tread back': ['IBrokerParticipantOptions.heartbeat', '-', '-'] })),
      surfaceOf(LISTS)
    );

    assert.deepEqual([...none.typescript], []);
  });

  test('asks a row of a member typed by a carrier, a parameter’s too', () => {
    const surface = surfaceOf(LISTS);
    const asked = askedOf(surface, carriersOf(rowsOf(fileOf()), surface));

    assert.ok(asked.typescript.has('createBrokerParticipant(options)'));
    assert.ok(asked.typescript.has('IBrokerParticipantOptions.reconnect'));
    assert.ok(asked.csharp.has('Bead.BrokerParticipant.BrokerParticipant(options)'));
    assert.ok(asked.rust.has('BrokerParticipant::new(options)'));
    // a path names its type
    assert.ok(asked.rust.has('BrokerParticipantOptions::reconnect'));
    // a carrier's own members, its equality among them, are its own
    assert.ok(!asked.csharp.has('Bead.BrokerParticipantOptions.Equals(other)'));
    // what names no carrier is asked nothing
    assert.ok(!asked.csharp.has('Bead.TransportClientReconnectOptions.MaximumAttempts'));
  });

  test('finds R9’s miss: a new owner’s member typed by the reconnection’s options, on no row', () => {
    const rows = with_('brokerParticipant.reconnectionDelay\tnumber', [
      'ITransportClientReconnectOptions.delay, TransportClientReconnectDelay',
      'Bead.TransportClientReconnectOptions.Delay, Bead.TransportClientReconnectDelay.TransportClientReconnectDelay(delay)',
      'TransportClientReconnectOptions::delay',
    ]);
    const problems = problemsWith(rows).filter((problem) => {
      return /on no row/.test(problem);
    });

    assert.deepEqual(
      problems.map((problem) => {
        return problem.match(/^tools\/durations\.tsv: (\w+)'s (\S+) is typed by (\S+),/).slice(1);
      }),
      [
        ['typescript', 'IBrokerParticipantOptions.reconnect', 'ITransportClientReconnectOptions'],
        [
          'csharp',
          'Bead.BrokerParticipantOptions.Reconnect',
          'Bead.TransportClientReconnectOptions',
        ],
        ['rust', 'BrokerParticipantOptions::reconnect', 'TransportClientReconnectOptions'],
      ]
    );
  });
});

describe('problemsOf', () => {
  test('fails on a place or a way with no row, or two', () => {
    assert.deepEqual(problemsWith(ROWS), []);

    const missing = problemsWith(with_('router.reservation\treserve'));

    assert.ok(
      missing.includes(
        'tools/durations.tsv: router.reservation by reserve has no row; give it one, a cell a side'
      )
    );

    const twice = problemsOf(
      `${fileOf()}router.reservation\treserve\t- inside: x\t- inside: x\tRouterClient::reserve(timeout)\n`,
      inputsWith()
    );

    assert.ok(
      twice.some((problem) => {
        return /router\.reservation by reserve is also line \d+'s/.test(problem);
      })
    );
  });

  test('fails on a row the file does not hold', () => {
    const problems = problemsWith({
      ...ROWS,
      'router.reservation\tcancel': [
        '- inside: x',
        '- inside: x',
        'RouterClient::reserve(timeout)',
      ],
    });

    assert.ok(
      problems.some((problem) => {
        return problem.endsWith(
          'spec/durations.json holds no place router.reservation taken by a way cancel'
        );
      })
    );

    const unread = problemsWith({ ...ROWS, '?\t?': ['?', '-', '-'] });

    assert.ok(
      unread.some((problem) => {
        return /a reading places this row/.test(problem);
      })
    );
  });

  test('fails on a member its list does not hold', () => {
    const problems = problemsWith(
      with_('router.reservation\treserve', [
        '- inside: x',
        '- inside: x',
        'RouterClient::hold(timeout)',
      ])
    );

    assert.ok(
      problems.some((problem) => {
        return problem.endsWith("rust's list holds no member RouterClient::hold(timeout)");
      })
    );
  });

  test('fails on a differs cell no differs of the file excuses, and on a member where one does', () => {
    const unexcused = problemsWith(
      with_('router.reservation\treserve', [
        `- differs: ${WORKER}`,
        '- inside: x',
        'RouterClient::reserve(timeout)',
      ])
    );

    assert.ok(
      unexcused.some((problem) => {
        return problem.endsWith(
          'no `differs` of spec/durations.json excuses TypeScript from router.reservation by reserve'
        );
      })
    );

    const excused = problemsWith(
      with_('transportClient.connectTimeout\tworker', [
        'ITransportClientConnectOptions.timeout',
        'Bead.BrokerParticipantOptions.Heartbeat',
        `- differs: ${WORKER}`,
      ])
    );

    assert.ok(
      excused.some((problem) => {
        return /excuses C# from transportClient\.connectTimeout by worker/.test(problem);
      })
    );
  });

  test('fails on a title that is no row of the matrix', () => {
    const problems = problemsWith(
      with_('router.reservation\treserve', ['- inside: x', '- inside: x', "- ahead: Rust's router"])
    );

    assert.ok(
      problems.some((problem) => {
        return problem.includes(`"Rust's router" is no row of docs/support.md's Differences`);
      })
    );
  });

  test('fails on a member that carries a duration on no row', () => {
    const problems = problemsWith(with_('no place\ta constant'));

    assert.deepEqual(
      problems.filter((problem) => {
        return /on no row/.test(problem);
      }),
      [
        "tools/durations.tsv: rust's broker::participant::HEARTBEAT carries a duration, on no row; name it on its place's row, or on a `no place` row with its reason",
      ]
    );
  });

  test('fails on a member on a place row and a no-place row', () => {
    const problems = problemsWith({
      ...ROWS,
      'no place\tread back': ['IBrokerParticipantOptions.heartbeat', '-', '-'],
    });

    assert.ok(
      problems.some((problem) => {
        return problem.includes(
          "typescript's IBrokerParticipantOptions.heartbeat stands on a place row and a `no place` row"
        );
      })
    );
  });

  test('fails on a no-place row with no reason', () => {
    const problems = problemsWith({
      ...with_('no place\ta constant'),
      'no place\t': ['-', '-', 'broker::participant::HEARTBEAT'],
    });

    assert.ok(
      problems.some((problem) => {
        return problem.endsWith('a `no place` row gives its reason');
      })
    );

    // nor one with a reason and no member
    const empty = problemsWith({ ...ROWS, 'no place\tnothing': ['-', '-', '-'] });

    assert.ok(
      empty.some((problem) => {
        return problem.endsWith('a `no place` row names a member on one side at least');
      })
    );
  });

  test('fails on a side whose list yields no duration', () => {
    const problems = problemsWith(ROWS, { ...LISTS, rust: [''] });

    assert.ok(
      problems.includes(
        "tools/durations.tsv: rust's list yields no member that carries a duration; its reader no longer reads it"
      )
    );
  });

  test('passes the repository as it is', () => {
    assert.deepEqual(problemsOf(readOf(ROOT)('tools/durations.tsv'), inputsOf()), []);
  });
});

describe('seed', () => {
  test('places a member by its C# twin’s name in each case, and leaves the rest for a reading', () => {
    const lines = seedOf(inputsWith()).split('\n');

    assert.ok(
      lines.includes(
        'brokerParticipant.heartbeat\toptions\tIBrokerParticipantOptions.heartbeat\tBead.BrokerParticipantOptions.Heartbeat\tBrokerParticipantOptions::heartbeat'
      )
    );
    assert.ok(
      lines.includes(
        `transportClient.connectTimeout\tworker\t?\t- differs: ${WORKER}\t- differs: ${WORKER}`
      )
    );
    assert.ok(lines.includes('router.reservation\treserve\t?\t?\t?'));
    assert.ok(lines.includes('?\t?\t-\t-\tRouterClient::reserve(timeout)'));
    assert.ok(lines.includes('?\t?\tcreateBrokerParticipant(options)\t-\t-'));

    // a seed is a table the check refuses until a reading places every `?`
    assert.ok(
      problemsOf(lines.join('\n'), inputsWith()).some((problem) => {
        return /a reading places this row/.test(problem);
      })
    );
  });
});
