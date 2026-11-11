import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  cSharpNamesOf,
  differencesOf,
  keyOf,
  kindsRender,
  problemsOf,
  publicLinesOf,
  rowsOf,
  RULES,
  rustNamesOf,
  seedOf,
  typeScriptNamesOf,
} from '../check-names.mjs';

const TYPESCRIPT = [
  './transport-client',
  '  IMemoryTransportClientOptions\tsrc/transport/client/types.ts',
  '  MemoryTransportClient\tsrc/transport/client/types.ts',
  '  TransportClientReconnectDelay\tsrc/transport/client/types.ts',
  '  TransportClientReconnectDelayResolver\tsrc/transport/client/types.ts',
  '  BROKER_PUBLISHED\tsrc/transport/shared/constants.ts',
  '  BrokerPublished\tsrc/transport/shared/types.ts',
  '  ProtocolCode\tsrc/router/shared/constants.ts',
  '  SessionToken\tsrc/router/shared/types.ts',
  '  CallId\tsrc/router/shared/types.ts',
  '  IBoundCall\tsrc/router/shared/types.ts',
  '  IRegistrar\tsrc/router/shared/types.ts',
  '  createMemoryTransportClient\tsrc/transport/client/memory-transport-client.ts',
  '  requireSession\tsrc/router/server/admissions.ts',
  '',
  'src/router/server/admissions.ts requireSession',
  "  const requireSession: (({session}: Pick<IAdmissionRequest, 'session'>) => boolean) & {refusal: IProtocolFailure<32>}",
  'src/router/shared/constants.ts ProtocolCode',
  '  const ProtocolCode: Readonly<{readonly ENVELOPE_MALFORMED: 1}>',
  'src/router/shared/types.ts CallId',
  '  type CallId = number',
  'src/router/shared/types.ts IBoundCall',
  '  interface IBoundCall<Result, Options extends unknown[] = []>',
  '    (...options: Options): Promise<Result>',
  'src/router/shared/types.ts IRegistrar',
  '  type IRegistrar = IBoundCall<INotificationRegistration, [options?: IRequestOptions]>',
  'src/router/shared/types.ts SessionToken',
  "  type SessionToken = string & {readonly [sessionTokenBrand]: 'SessionToken'}",
  'src/transport/client/memory-transport-client.ts createMemoryTransportClient',
  '  const createMemoryTransportClient(options?: IMemoryTransportClientOptions): MemoryTransportClient',
  'src/transport/client/types.ts IMemoryTransportClientOptions',
  '  interface IMemoryTransportClientOptions',
  '    clock?: IClock | undefined',
  'src/transport/client/types.ts MemoryTransportClient',
  '  type MemoryTransportClient = ITransportClient<IMemoryEndLike, IMemoryTransportClientConnectOptions>',
  'src/transport/client/types.ts TransportClientReconnectDelay',
  '  type TransportClientReconnectDelay = number | TransportClientReconnectDelayResolver',
  'src/transport/client/types.ts TransportClientReconnectDelayResolver',
  '  type TransportClientReconnectDelayResolver = (previousDelay: number | undefined, attempt: number) => number',
  'src/transport/shared/constants.ts BROKER_PUBLISHED',
  '  const BROKER_PUBLISHED: Readonly<{NO_SUBSCRIBER: "no-subscriber"; TAKEN: "taken"}>',
  'src/transport/shared/types.ts BrokerPublished',
  '  type BrokerPublished = (typeof BROKER_PUBLISHED)[keyof typeof BROKER_PUBLISHED]',
  '',
].join('\n');

const CSHARP_SHIPPED = [
  '#nullable enable',
  'Bead.Credential',
  'Bead.Credential.Credential() -> void',
  'Bead.Credential.Scheme.get -> Bead.CredentialScheme',
  'Bead.EnvelopeFlags',
  'Bead.EnvelopeFlags.Credential = 8 -> Bead.EnvelopeFlags',
  'Bead.FailureException',
  'Bead.FailureException.Raised',
  'Bead.FailureException.Raised.Origin.get -> Bead.FailureOrigin',
  'Bead.HttpEvent<TResult, TNotification>',
  'Bead.HttpEvent<TResult, TNotification>.IsResult.get -> bool',
  'Bead.LimitDefaults',
  'const Bead.LimitDefaults.ChunkBytes = 1048576 -> int',
  'Bead.MemoryTransportClient',
  'Bead.MemoryTransportClient.Pause() -> void',
  'Bead.TransportReconnectDelay',
  'virtual Bead.TransportReconnectDelay.Invoke(System.TimeSpan? previousDelay, int attempt) -> System.TimeSpan',
  'Bead.Violations',
  'const Bead.Violations.ClosingBytes = 26 -> int',
  'static Bead.Violations.Of(Bead.Judged! judged) -> string!',
  'static Bead.Violations.WordsOf(string! text) -> string!',
  'Bead.Transport.Http.HttpTransportClient',
  'Bead.Transport.Http.HttpTransportClient.Pause() -> void',
  '',
].join('\n');

const CSHARP_UNSHIPPED = [
  '#nullable enable',
  '*REMOVED*Bead.TransportReconnectDelay',
  '*REMOVED*virtual Bead.TransportReconnectDelay.Invoke(System.TimeSpan? previousDelay, int attempt) -> System.TimeSpan',
  'Bead.HttpEvent',
  'Bead.HttpEvent.Id.get -> long',
  'Bead.TransportClientReconnectDelay',
  'Bead.TransportClientReconnectDelay.<Clone>$() -> Bead.TransportClientReconnectDelay!',
  'Bead.TransportClientReconnectDelayResolver',
  'virtual Bead.TransportClientReconnectDelayResolver.Invoke(System.TimeSpan? previousDelay, int attempt) -> System.TimeSpan',
  '',
].join('\n');

const RUST = [
  'crate',
  '  mod json',
  '  use broker::client::MemoryTransportClient',
  '  use constants::ProtocolCode',
  '  use errors::CallError',
  '  use transport::TransportClientReconnectDelay',
  '  use transport::TransportClientReconnectDelayResolver',
  '  use transport::ConnectionHandle',
  '  use violations::CLOSING_BYTES',
  '  use violations::violations_of',
  '  use buffa_build::Config',
  '  mod internal #[doc(hidden)]',
  'crate::broker::client',
  '  struct MemoryTransportClient',
  '    fn new() -> Self',
  'crate::constants',
  '  struct ProtocolCode(NonZeroU16);',
  '    const ENVELOPE_MALFORMED: Self',
  'crate::errors',
  '  enum CallError #[non_exhaustive]',
  '    Failure(Failure)',
  '    Disconnected',
  '    fn failure(&self) -> Option<&Failure>',
  'crate::json',
  '  enum JsonRefusal #[non_exhaustive]',
  '    NotUtf8',
  '  fn read(bytes: &[u8]) -> Result<Value, JsonRefusal>',
  'crate::transport',
  '  type ConnectionHandle = Arc<str>',
  '  enum TransportClientReconnectDelay #[non_exhaustive]',
  '    Fixed(Duration)',
  '    Resolver(TransportClientReconnectDelayResolver)',
  '  type TransportClientReconnectDelayResolver = Arc<dyn Fn(Option<Duration>, u32) -> Duration + Send + Sync>',
  'crate::violations',
  '  const CLOSING_BYTES: usize',
  '  fn violations_of(judged: &Judged) -> String',
  '',
].join('\n');

const SUPPORT = [
  '## Differences',
  '',
  'A difference is of one of three kinds.',
  '',
  '| Difference                     | Kind | TypeScript | C#  | Rust |',
  '| ------------------------------ | ---- | ---------- | --- | ---- |',
  "| The WebSocket transport's name | open | `WS`       | `WebSocket` | none |",
  '',
  '## Leveled down',
  '',
  '| Leveling | The standard |',
  '| -------- | ------------ |',
  '| A host   | RFC 3986     |',
  '',
].join('\n');

const surfaces = () => {
  return {
    typescript: typeScriptNamesOf(TYPESCRIPT),
    csharp: cSharpNamesOf(publicLinesOf(CSHARP_SHIPPED, CSHARP_UNSHIPPED)),
    rust: rustNamesOf([RUST]),
  };
};

const kindsOf = (names) => {
  return Object.fromEntries(
    [...names].map(([name, { kinds }]) => {
      return [name, kinds.join('|')];
    })
  );
};

// a file of `rows`, its pin `alone` counted, every name of the fixture's lists held by one row
const HELD = [
  'MemoryTransportClient\tMemoryTransportClient [record], createMemoryTransportClient [function]\tMemoryTransportClient [record]\tMemoryTransportClient [record]\tsame',
  'TransportClientReconnectDelay\tTransportClientReconnectDelay [choice]\tTransportClientReconnectDelay [record]\tTransportClientReconnectDelay [choice]\tsame',
  'TransportClientReconnectDelayResolver\tTransportClientReconnectDelayResolver [function type]\tTransportClientReconnectDelayResolver [function type]\tTransportClientReconnectDelayResolver [function type]\tsame',
  'ProtocolCode\tProtocolCode [choice]\t-\tProtocolCode [choice]\tsame',
  'FailureError\t-\tFailureException [record]\tCallError::Failure [variant]\trendered: error (0007, 0044)',
  'CLOSING_BYTES\t-\tViolations.ClosingBytes [constant]\tCLOSING_BYTES [constant]\trendered: constant (0007)',
  'violationsOf\t-\tViolations.Of [function]\tviolations_of [function]\trendered: of (0007, 0044)',
  'BoundCall\tIBoundCall [function type]\t-\t-\talone',
  'Registrar\tIRegistrar [function type]\t-\t-\talone',
  'HttpEvent\t-\tHttpEvent [record], HttpEvent<,> [record]\t-\town: an event and the events of a call (0007)',
  "HttpTransportClient\t-\tHttpTransportClient [record]\t-\tdiffers: The WebSocket transport's name",
  'ConnectionHandle\t-\t-\tConnectionHandle [scalar]\talone',
  "CallError\t-\t-\tCallError [choice]\town: a Result's error, where the other sides throw (0044)",
];
const LEFT = [
  'BrokerPublished\tBrokerPublished [choice]\t-\t-\talone',
  'BROKER_PUBLISHED\tBROKER_PUBLISHED [constant]\t-\t-\talone',
  'SessionToken\tSessionToken [record]\t-\t-\talone',
  'CallId\tCallId [scalar]\t-\t-\talone',
  'requireSession\trequireSession [function]\t-\t-\talone',
  'IMemoryTransportClientOptions\tIMemoryTransportClientOptions [record]\t-\t-\talone',
  'Credential\t-\tCredential [record]\t-\talone',
  'EnvelopeFlags\t-\tEnvelopeFlags [choice]\t-\talone',
  'FailureException.Raised\t-\tFailureException.Raised [record]\t-\talone',
  'LimitDefaults\t-\tLimitDefaults [constant]\t-\talone',
  'Violations.WordsOf\t-\tViolations.WordsOf [function]\t-\talone',
  'json::JsonRefusal\t-\t-\tjson::JsonRefusal [choice]\talone',
  'json::read\t-\t-\tjson::read [function]\talone',
];

const fileOf = (rows, pins) => {
  const alone = { typescript: 0, csharp: 0, rust: 0 };

  for (const row of rows) {
    const fields = row.split('\t');

    if (fields[4] === 'alone') {
      alone[
        ['typescript', 'csharp', 'rust'][[1, 2, 3].find((index) => fields[index] !== '-') - 1]
      ]++;
    }
  }

  const pin = { ...alone, ...pins };

  return [
    `# alone: typescript ${pin.typescript}, csharp ${pin.csharp}, rust ${pin.rust}`,
    '# concept\ttypescript\tcsharp\trust\tclass',
    ...rows,
    '',
  ].join('\n');
};

const check = (rows, pins) => {
  return problemsOf(fileOf(rows, pins), surfaces(), differencesOf(SUPPORT));
};

describe('the lists', () => {
  test('reads each TypeScript export’s kind from its declaration', () => {
    assert.deepEqual(kindsOf(typeScriptNamesOf(TYPESCRIPT)), {
      IMemoryTransportClientOptions: 'record',
      MemoryTransportClient: 'record',
      TransportClientReconnectDelay: 'choice',
      TransportClientReconnectDelayResolver: 'function type',
      BROKER_PUBLISHED: 'constant',
      BrokerPublished: 'choice',
      ProtocolCode: 'choice',
      SessionToken: 'record',
      CallId: 'scalar',
      IBoundCall: 'function type|record',
      IRegistrar: 'function type|record',
      createMemoryTransportClient: 'function',
      requireSession: 'function',
    });
  });

  test('reads a TypeScript function type whose return is a union as a function type, never a choice', () => {
    const surface = [
      './router',
      '  SessionOf\tsrc/router/shared/types.ts',
      '',
      'src/router/shared/types.ts SessionOf',
      '  type SessionOf = (request: ISessionRequest, signal: AbortSignal) => | ICallSession | undefined | PromiseLike<ICallSession | undefined>',
    ].join('\n');

    assert.deepEqual(kindsOf(typeScriptNamesOf(surface)), { SessionOf: 'function type' });
  });

  test('reads each C# type, a static class’s members and every constant, the Unshipped applied', () => {
    assert.deepEqual(kindsOf(cSharpNamesOf(publicLinesOf(CSHARP_SHIPPED, CSHARP_UNSHIPPED))), {
      Credential: 'record',
      EnvelopeFlags: 'choice',
      FailureException: 'record',
      'FailureException.Raised': 'record',
      'HttpEvent<,>': 'record',
      HttpEvent: 'record',
      LimitDefaults: 'constant',
      MemoryTransportClient: 'record',
      'Violations.ClosingBytes': 'constant',
      'Violations.Of': 'function',
      'Violations.WordsOf': 'function',
      HttpTransportClient: 'record',
      TransportClientReconnectDelay: 'record',
      TransportClientReconnectDelayResolver: 'function type',
    });
  });

  test('reads each Rust name a root exports where it is defined, and a public module’s items', () => {
    const names = rustNamesOf([RUST]);

    assert.deepEqual(kindsOf(names), {
      MemoryTransportClient: 'record',
      ProtocolCode: 'choice',
      CallError: 'choice',
      TransportClientReconnectDelay: 'choice',
      TransportClientReconnectDelayResolver: 'function type',
      ConnectionHandle: 'scalar',
      CLOSING_BYTES: 'constant',
      violations_of: 'function',
      'json::JsonRefusal': 'choice',
      'json::read': 'function',
    });
    assert.deepEqual([...names.get('CallError').variants], ['Failure', 'Disconnected']);
  });

  test('reads a Rust name a feature holds as any other, its mark aside', () => {
    const names = rustNamesOf([
      [
        'crate',
        '  use websocket::server::TRANSPORT_WEBSOCKET #[cfg(feature = "websocket")]',
        '  use websocket::server::WebSocketTransportServer #[cfg(feature = "websocket")]',
        'crate::websocket::server',
        '  const TRANSPORT_WEBSOCKET: &str #[cfg(feature = "websocket")]',
        '  struct WebSocketTransportServer #[cfg(feature = "websocket")]',
        '',
      ].join('\n'),
    ]);

    assert.deepEqual(kindsOf(names), {
      TRANSPORT_WEBSOCKET: 'constant',
      WebSocketTransportServer: 'record',
    });
  });

  test('reads the titles of the Differences alone', () => {
    assert.deepEqual([...differencesOf(SUPPORT)], ["The WebSocket transport's name"]);
  });
});

describe('the kind table', () => {
  test('refuses one word for a number, a delegate and an enum', () => {
    assert.equal(
      kindsRender({ typescript: 'scalar', csharp: 'function type', rust: 'choice' }),
      false
    );
  });

  test('accepts a union rendered as a C# struct', () => {
    assert.equal(kindsRender({ typescript: 'choice', csharp: 'record', rust: 'choice' }), true);
  });

  test('holds a delegate to a function’s type, and a variant to a record', () => {
    assert.equal(kindsRender({ typescript: 'record', csharp: 'function type' }), false);
    assert.equal(kindsRender({ csharp: 'record', rust: 'variant' }), true);
    assert.equal(kindsRender({ typescript: 'scalar', csharp: 'record' }), false);
  });
});

describe('the case rules and the renderings', () => {
  test('drop the case, the underscores and an interface’s I, and keep a value apart from a type', () => {
    assert.equal(keyOf('IRouterRequest', 'record'), keyOf('RouterRequest', 'record'));
    assert.equal(keyOf('violations_of', 'function'), keyOf('violationsOf', 'function'));
    assert.equal(keyOf('HttpEvent<,>', 'record'), 'httpevent');
    assert.notEqual(keyOf('IDLE_TIMEOUT', 'constant'), keyOf('DLE_TIMEOUT', 'constant'));
  });

  test('give an error, an interface met by its shape, a flags enum, a held constant and a function', () => {
    const cells = (typescript, csharp, rust) => {
      return { typescript, csharp, rust };
    };

    assert.equal(
      RULES.error(
        cells(
          [{ name: 'FailureError', kind: 'record' }],
          [{ name: 'FailureException', kind: 'record' }],
          [{ name: 'CallError::Failure', kind: 'variant' }]
        )
      ),
      true
    );
    assert.equal(
      RULES.like(
        cells(
          [{ name: 'IServerTransportLike', kind: 'record' }],
          [{ name: 'IServerTransport', kind: 'record' }],
          [{ name: 'ServerTransport', kind: 'record' }]
        )
      ),
      true
    );
    assert.equal(
      RULES.like(
        cells(
          [{ name: 'IWebSocketServerLike', kind: 'record' }],
          [{ name: 'WebSocketServer', kind: 'record' }],
          []
        )
      ),
      false
    );
    assert.equal(
      RULES.flags(
        cells(
          [],
          [{ name: 'EnvelopeFlags', kind: 'choice' }],
          [{ name: 'EnvelopeFlag', kind: 'choice' }]
        )
      ),
      true
    );
    assert.equal(
      RULES.constant(
        cells(
          [{ name: 'CLOSING_BYTES', kind: 'constant' }],
          [{ name: 'Violations.ClosingBytes', kind: 'constant' }],
          []
        )
      ),
      true
    );
    assert.equal(
      RULES.of(
        cells(
          [{ name: 'wordsOf', kind: 'function' }],
          [{ name: 'Violations.WordsOf', kind: 'function' }],
          [{ name: 'words_of', kind: 'function' }]
        )
      ),
      true
    );
    assert.equal(
      RULES.of(
        cells(
          [{ name: 'detailOf', kind: 'function' }],
          [{ name: 'Violations.WordsOf', kind: 'function' }],
          []
        )
      ),
      false
    );
  });

  test('renders a set of flags an implementer declares as a TypeScript object of booleans, and no other kind', () => {
    const cells = (typescript, csharp, rust) => {
      return { typescript, csharp, rust };
    };
    const capabilities = (kind) => {
      return cells(
        [{ name: 'IBrokerCapabilities', kind }],
        [{ name: 'BrokerCapabilities', kind: 'choice' }],
        [{ name: 'BrokerCapabilities', kind: 'choice' }]
      );
    };

    assert.equal(RULES.flags(capabilities('record')), true);
    assert.equal(RULES.flags(capabilities('choice')), true);
    assert.equal(RULES.flags(capabilities('function type')), false);
    assert.equal(
      RULES.flags(
        cells(
          [{ name: 'IBrokerCapabilities', kind: 'record' }],
          [{ name: 'BrokerCapability', kind: 'choice' }],
          []
        )
      ),
      false
    );
  });

  test('renders a callable as a Rust struct where the others type a function, and no other kind', () => {
    const cells = (typescript, csharp, rust) => {
      return { typescript, csharp, rust };
    };
    const notifier = (rust) => {
      return cells(
        [{ name: 'INotifier', kind: 'function type' }],
        [{ name: 'Notifier', kind: 'function type' }],
        rust
      );
    };

    assert.equal(RULES.callable(notifier([{ name: 'Notifier', kind: 'record' }])), true);
    assert.equal(RULES.callable(notifier([{ name: 'Notifier', kind: 'function type' }])), false);
    assert.equal(RULES.callable(notifier([])), false);
    assert.equal(
      RULES.callable(
        cells(
          [{ name: 'INotifier', kind: 'record' }],
          [{ name: 'Notifier', kind: 'function type' }],
          [{ name: 'Notifier', kind: 'record' }]
        )
      ),
      false
    );
  });

  test('renders an error enum’s variant named as a participle, and no other', () => {
    const cells = (typescript, csharp, rust) => {
      return {
        typescript: [{ name: typescript, kind: 'record' }],
        csharp: csharp === null ? [] : [{ name: csharp, kind: 'record' }],
        rust: [{ name: rust, kind: 'variant' }],
      };
    };

    assert.equal(
      RULES.error(cells('DisconnectError', 'DisconnectException', 'CallError::Disconnected')),
      true
    );
    assert.equal(RULES.error(cells('CancelError', null, 'CallError::Cancelled')), true);
    assert.equal(RULES.error(cells('TimeoutError', null, 'CallError::TimedOut')), true);
    assert.equal(RULES.error(cells('TimeError', null, 'CallError::TimedOut')), false);
    assert.equal(RULES.error(cells('CancError', null, 'CallError::Cancelled')), false);
    assert.equal(
      RULES.error(cells('FailureError', 'FailureException', 'CallError::Failure')),
      true
    );
  });
});

describe('problemsOf', () => {
  test('holds the rows that place every name, their pin met', () => {
    assert.deepEqual(check([...HELD, ...LEFT]), []);
  });

  test('fails a public name that no row holds', () => {
    const problems = check([...HELD, ...LEFT.filter((row) => !row.startsWith('CallId\t'))]);

    assert.deepEqual(problems, [
      "tools/names.tsv: typescript's public scalar CallId is in no row; give it one, never `alone`",
    ]);
  });

  test('fails a row whose name a list no longer holds, or holds as another kind', () => {
    const problems = check([
      ...HELD,
      ...LEFT,
      'TransportReconnectDelay\t-\tTransportReconnectDelay [function type]\t-\town: the old delegate (0007)',
      'Gone\t-\t-\tCallError::Gone [variant]\town: a variant gone (0044)',
    ]).filter((problem) => !problem.includes(':1:'));

    assert.deepEqual(problems, [
      "tools/names.tsv:29: csharp's list no longer holds TransportReconnectDelay",
      "tools/names.tsv:30: rust's list no longer holds CallError::Gone",
    ]);
    assert.match(
      check(
        [...HELD, ...LEFT].map((row) => {
          return row.replace('CallId [scalar]', 'CallId [record]');
        })
      )[0],
      /typescript's list holds CallId as a scalar, not a record/
    );
  });

  test('fails a same row whose names differ under the case rules', () => {
    const rows = [...HELD, ...LEFT].map((row) => {
      return row.startsWith('violationsOf\t') ? row.replace(/rendered: .*$/, 'same') : row;
    });

    assert.deepEqual(check(rows), [
      'tools/names.tsv:9: its names differ under the case rules: a rendering, a difference, or two rows',
    ]);
  });

  test('fails a same row whose kinds do not render each other: one word for a number, a delegate and an enum', () => {
    const delay = {
      typescript: typeScriptNamesOf(
        TYPESCRIPT.replace(
          'type TransportClientReconnectDelay = number | TransportClientReconnectDelayResolver',
          'type TransportClientReconnectDelay = number'
        )
      ),
      csharp: cSharpNamesOf(
        publicLinesOf(CSHARP_SHIPPED, CSHARP_UNSHIPPED)
          .filter((line) => !line.startsWith('Bead.TransportClientReconnectDelay'))
          .concat([
            'Bead.TransportClientReconnectDelay',
            'virtual Bead.TransportClientReconnectDelay.Invoke(int attempt) -> System.TimeSpan',
          ])
      ),
      rust: rustNamesOf([RUST]),
    };
    const rows = [...HELD, ...LEFT].map((row) => {
      return row.startsWith('TransportClientReconnectDelay\t')
        ? 'TransportClientReconnectDelay\tTransportClientReconnectDelay [scalar]\tTransportClientReconnectDelay [function type]\tTransportClientReconnectDelay [choice]\tsame'
        : row;
    });
    const problems = problemsOf(fileOf(rows), delay, differencesOf(SUPPORT)).filter((problem) => {
      return !problem.includes('TransportClientReconnectDelayResolver');
    });

    assert.deepEqual(problems, [
      'tools/names.tsv:4: its kinds do not render each other (scalar, function type, choice): no row of the kind table admits them',
    ]);
  });

  test('fails a rendering whose rule does not give its names, or that names no rule or no record', () => {
    const rows = [...HELD, ...LEFT].map((row) => {
      if (row.startsWith('violationsOf\t')) {
        return row.replace('rendered: of (0007, 0044)', 'rendered: error (0007, 0044)');
      }
      if (row.startsWith('CLOSING_BYTES\t')) {
        return row.replace('rendered: constant (0007)', 'rendered: constant');
      }
      if (row.startsWith('FailureError\t')) {
        return row.replace('rendered: error', 'rendered: exception');
      }

      return row;
    });

    assert.deepEqual(check(rows), [
      'tools/names.tsv:7: no rendering named "exception": error, like, flags, constant, of, listener, keyword, callable, platform',
      'tools/names.tsv:8: the rendering constant names the records that state it, "rendered: constant (<record>)"',
      'tools/names.tsv:9: the rendering error does not give its names',
    ]);
  });

  test('fails an own row without its reason or its record, and one of two sides', () => {
    const rows = [...HELD, ...LEFT].map((row) => {
      return row.startsWith('HttpEvent\t')
        ? row.replace(/own: .*$/, 'own: an event and the events of a call')
        : row;
    });

    assert.deepEqual(check(rows), [
      'tools/names.tsv:12: an `own` row gives its reason and the record that allows it, "own: <reason> (<record>)"',
    ]);
    assert.deepEqual(
      check(
        [...HELD, ...LEFT].map((row) => {
          return row.startsWith('ProtocolCode\t')
            ? row.replace('same', 'own: an open code space (0044)')
            : row;
        })
      ),
      ['tools/names.tsv:6: an `own` row names one side alone']
    );
  });

  test('fails a differs row whose title is no row of the Differences', () => {
    const rows = [...HELD, ...LEFT].map((row) => {
      return row.replace(
        "differs: The WebSocket transport's name",
        'differs: The WebSocket transport’s name'
      );
    });

    assert.deepEqual(check(rows), [
      'tools/names.tsv:13: "The WebSocket transport’s name" is no row of docs/support.md\'s Differences; a difference is a row there, with its test',
    ]);
  });

  test('fails an alone count past its pin: a new name takes another class', () => {
    assert.deepEqual(check([...HELD, ...LEFT], { csharp: 4 }), [
      'tools/names.tsv:1: 5 `alone` row(s) on the csharp side, past its pin of 4; a new name takes same, rendered, own or differs',
    ]);
  });

  test('fails an alone count under its pin, until the pin is lowered', () => {
    assert.deepEqual(check([...HELD, ...LEFT], { rust: 5 }), [
      'tools/names.tsv:1: 3 `alone` row(s) on the rust side, under its pin of 5; lower the pin',
    ]);
  });

  test('fails a file without its pin, a name in two rows, a concept twice and a cell with no kind', () => {
    const text = fileOf([...HELD, ...LEFT]).replace(/^# alone: .*\n/, '');

    assert.deepEqual(problemsOf(text, surfaces(), differencesOf(SUPPORT)), [
      'tools/names.tsv:1: the first line pins the names each side alone holds, "# alone: typescript <n>, csharp <n>, rust <n>"',
    ]);
    assert.deepEqual(
      check([
        ...HELD,
        ...LEFT,
        'CallId\tCallId\t-\t-\talone',
        'CLOSING_BYTES\t-\t-\tCLOSING_BYTES [constant]\talone',
      ]).filter((problem) => !problem.includes(':1:')),
      [
        "tools/names.tsv:29: the concept CallId is also line 19's",
        'tools/names.tsv:29: typescript\'s CallId has no kind of the table, "<name> [<kind>]": record, choice, function type, function, constant, scalar, variant',
        "tools/names.tsv:30: the concept CLOSING_BYTES is also line 8's",
        "tools/names.tsv:30: rust's CLOSING_BYTES is also line 8's",
      ]
    );
  });
});

describe('seedOf', () => {
  test('writes the shared keys, the renderings and every other name alone, its pins counted', () => {
    const seed = seedOf(surfaces());
    const lines = seed.split('\n');

    assert.equal(lines[0], '# alone: typescript 8, csharp 9, rust 4');
    for (const row of [
      'MemoryTransportClient\tMemoryTransportClient [record], createMemoryTransportClient [function]\tMemoryTransportClient [record]\tMemoryTransportClient [record]\tsame',
      'TransportClientReconnectDelay\tTransportClientReconnectDelay [choice]\tTransportClientReconnectDelay [record]\tTransportClientReconnectDelay [choice]\tsame',
      'CLOSING_BYTES\t-\tViolations.ClosingBytes [constant]\tCLOSING_BYTES [constant]\trendered: constant (0007)',
      'violations_of\t-\tViolations.Of [function]\tviolations_of [function]\trendered: of (0007, 0044)',
      'HttpEvent\t-\tHttpEvent [record]\t-\talone',
      'HttpEvent<,>\t-\tHttpEvent<,> [record]\t-\talone',
    ]) {
      assert.ok(lines.includes(row), row);
    }
    assert.deepEqual(problemsOf(seed, surfaces(), differencesOf(SUPPORT)), []);
  });

  test('reads its own rows back, each a row of five fields', () => {
    const { pins, rows } = rowsOf(seedOf(surfaces()));

    assert.deepEqual(pins, { typescript: 8, csharp: 9, rust: 4 });
    assert.deepEqual(
      rows.filter((row) => row.fields !== 5),
      []
    );
  });
});
