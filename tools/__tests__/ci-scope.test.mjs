import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  AREAS,
  areasOf,
  closureOf,
  dotnetProjectsOf,
  linesOf,
  LOCAL,
  modeOf,
  NEEDS,
  PARTS,
  patternOf,
  reachOf,
  ROOT,
  RULES,
  ruleOf,
  runSteps,
  stepsOf,
  verdictOf,
} from '../ci-scope.mjs';

// ── ci.yml ─────────────────────────────────────────────────────────────────────

// each job of ci.yml: its id, the jobs it needs and its `if:`, read from the file's own layout
const jobsOf = (text) => {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const jobs = new Map();
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)];
  headers.forEach((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : body.length;
    const block = body.slice(header.index, end);
    const needs = /^ {4}needs:\s*(\[[^\]]*\]|[^\n]+)/m.exec(block);
    const condition = /^ {4}if: (.+)$/m.exec(block);
    jobs.set(header[1], {
      needs: needs
        ? needs[1]
            .replace(/[[\]]/g, '')
            .split(',')
            .map((each) => {
              return each.trim();
            })
            .filter(Boolean)
        : [],
      if: condition ? condition[1].trim() : undefined,
    });
  });
  return jobs;
};

const CI = jobsOf(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));

describe('ci.yml', () => {
  test('its jobs are the areas, their parts, the scope and CI ok, each way', () => {
    assert.deepEqual(
      [...CI.keys()].sort(),
      [...AREAS, ...Object.keys(PARTS), 'scope', 'ci-ok'].sort()
    );
  });

  test('each scoped job needs the scope and runs when its area is in it, and commits runs always', () => {
    for (const area of AREAS) {
      const job = CI.get(area);
      if (area === 'commits') {
        assert.deepEqual(job.needs, [], area);
        assert.equal(job.if, undefined, area);
        continue;
      }
      assert.ok(job.needs.includes('scope'), area);
      assert.equal(job.if, `contains(fromJSON(needs.scope.outputs.areas), '${area}')`, area);
    }
  });

  test('the jobs an area needs are the jobs its job needs', () => {
    for (const area of AREAS) {
      const needed = CI.get(area).needs.filter((job) => {
        return job !== 'scope';
      });
      assert.deepEqual(needed.sort(), [...(NEEDS[area] || [])].sort(), area);
    }
  });

  test('each part runs when its area is in the scope, and needs what it is given, within its area', () => {
    for (const [job, part] of Object.entries(PARTS)) {
      assert.ok(AREAS.includes(part.area), job);
      assert.ok(CI.get(job).needs.includes('scope'), job);
      assert.equal(
        CI.get(job).if,
        `contains(fromJSON(needs.scope.outputs.areas), '${part.area}')`,
        job
      );
      const needed = CI.get(job).needs.filter((each) => {
        return each !== 'scope';
      });
      assert.deepEqual(needed.sort(), [...part.needs].sort(), job);
      for (const each of part.needs) {
        assert.ok(closureOf([part.area]).includes(each), `${job} needs ${each}`);
      }
    }
  });

  test('CI ok needs every job and runs always', () => {
    const ok = CI.get('ci-ok');
    assert.deepEqual(ok.needs.sort(), [...AREAS, ...Object.keys(PARTS), 'scope'].sort());
    assert.equal(ok.if, 'always()');
  });
});

describe('running the local commands', () => {
  test('prints each command before running it, in order, in its folder under the root', () => {
    const steps = [
      { area: 'commits', folder: '.', command: 'node tools/check-commits.mjs {base}..{head}' },
      {
        area: 'typescript',
        folder: 'implementations/typescript',
        command: 'yarn test --grep "a test"',
        note: 'the environment comes from the caller',
      },
      { area: 'builder', folder: 'builder', command: "tool --pattern '*.txt'" },
      { area: 'builder', folder: '.', command: 'node tools/check-links.mjs' },
    ];
    const lines = [];
    const calls = [];
    const code = runSteps(steps, {
      base: 'base',
      head: 'head',
      log: (line) => {
        lines.push(line);
      },
      spawn: (shell, args, options) => {
        assert.equal(lines.at(-1), args[1]);
        assert.equal(shell, process.platform === 'win32' ? 'bash' : '/bin/sh');
        assert.equal(args[0], '-c');
        assert.equal(options.env, process.env);
        assert.equal(options.stdio, 'inherit');
        calls.push({ command: args[1], cwd: options.cwd });
        return { status: 0 };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, linesOf(steps, 'base', 'head'));
    assert.deepEqual(calls, [
      { command: 'node tools/check-commits.mjs base..head', cwd: ROOT },
      {
        command: 'yarn test --grep "a test"',
        cwd: resolve(ROOT, 'implementations/typescript'),
      },
      { command: "tool --pattern '*.txt'", cwd: resolve(ROOT, 'builder') },
      { command: 'node tools/check-links.mjs', cwd: ROOT },
    ]);
  });

  test('stops at the first failed command, names it and returns its exit code', () => {
    const steps = ['first', 'second', 'third'].map((command) => {
      return { area: 'commits', folder: '.', command };
    });
    const lines = [];
    const errors = [];
    const commands = [];
    assert.equal(
      runSteps(steps, {
        log: (line) => {
          lines.push(line);
        },
        error: (line) => {
          errors.push(line);
        },
        spawn: (_shell, args) => {
          commands.push(args[1]);
          return { status: args[1] === 'second' ? 17 : 0 };
        },
      }),
      17
    );
    assert.deepEqual(commands, ['first', 'second']);
    assert.deepEqual(lines, ['# commits', 'first', 'second']);
    assert.deepEqual(errors, ['ci-scope: second failed (exit 17)']);
  });

  test('a command that cannot start or ends by a signal fails and names the reason', () => {
    for (const result of [
      { status: null, error: new Error('shell unavailable') },
      { status: null, signal: 'SIGTERM' },
    ]) {
      const errors = [];
      assert.equal(
        runSteps([{ area: 'commits', folder: '.', command: 'check' }], {
          log: () => {},
          error: (line) => {
            errors.push(line);
          },
          spawn: () => {
            return result;
          },
        }),
        1
      );
      assert.deepEqual(errors, [
        `ci-scope: check failed (${result.error?.message ?? result.signal})`,
      ]);
    }
  });

  test('runs the same selection as --local for --gates, --all and their combination', () => {
    const paths = ['implementations/dotnet/tests/Bead.Core.Tests/A.cs'];
    for (const options of [{}, { gates: true }, { all: true }, { all: true, gates: true }]) {
      const steps = stepsOf(options.all ? AREAS : areasOf(paths), paths, options);
      const commands = [];
      const lines = [];
      assert.equal(
        runSteps(steps, {
          log: (line) => {
            lines.push(line);
          },
          spawn: (_shell, args) => {
            commands.push(args[1]);
            return { status: 0 };
          },
        }),
        0
      );
      assert.deepEqual(lines, linesOf(steps, 'origin/develop'));
      assert.deepEqual(
        commands,
        steps.map(({ command }) => {
          return command.replace('{base}', 'origin/develop').replace('{head}', 'HEAD');
        })
      );
    }
  });
});

// ── The rules ──────────────────────────────────────────────────────────────────

// a path under each rule, and the areas its rule names
const CASES = [
  ['tools/ci-scope.mjs', AREAS],
  ['.gitattributes', AREAS],
  ['docs/decisions/0001-the-envelope-sits-at-fixed-offsets.md', ['commits']],
  ['README.md', ['commits', 'spec']],
  ['tools/twins.tsv', ['commits']],
  ['tools/check-versions.mjs', ['commits', 'spec']],
  ['tools/coverage-floors.json', ['commits', 'typescript', 'dotnet', 'rust']],
  ['tools/__tests__/check-a11y.test.mjs', ['commits', 'typescript']],
  ['tools/broker-fixture.mjs', ['commits', 'mqtt', 'amqp']],
  ['tools/amqp-broker.mjs', ['commits', 'amqp']],
  ['tools/check-transcoding.mjs', ['commits', 'builder']],
  ['tools/check-examples.mjs', ['commits', 'examples']],
  ['tools/protobuf-conformance/runner.json', ['commits', 'spec', 'protobuf-conformance']],
  ['tools/protovalidate-differential.mjs', ['commits', 'protovalidate-differential']],
  [
    'tools/fetch-pinned.mjs',
    [
      'commits',
      'spec',
      'builder',
      'typescript',
      'mqtt',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
      'rust',
    ],
  ],
  ['spec/vectors.json', AREAS],
  ['site/__tests__/deploy.test.mjs', ['commits']],
  ['site/src/content.fr.html', ['commits', 'typescript', 'site']],
  ['builder/test/golden/csharp/InteropBead.cs', ['builder', 'dotnet']],
  ['builder/test/golden/rust/lib.rs', ['builder', 'rust']],
  [
    'builder/protoc.json',
    [
      'spec',
      'builder',
      'typescript',
      'mqtt',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
      'rust',
    ],
  ],
  ['builder/protoc-gen-buffa.json', ['builder', 'examples', 'protovalidate-differential']],
  ['builder/wrappers/beadc.sh', ['builder', 'examples']],
  [
    'builder/src/cli.ts',
    [
      'spec',
      'builder',
      'typescript',
      'mqtt',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
    ],
  ],
  ['builder/Dockerfile', ['builder']],
  ['beadc.yaml', ['commits', 'builder']],
  ['examples/hello/rust/src/main.rs', ['examples', 'builder', 'rust']],
  ['examples/hello/pairs.mjs', ['examples', 'builder']],
  ['implementations/typescript/README.md', ['commits', 'typescript']],
  [
    'implementations/typescript/demo/proto/demo/v1/sign_up.proto',
    ['typescript', 'mqtt', 'builder'],
  ],
  ['implementations/typescript/skin/mascot.js', ['typescript', 'mqtt']],
  [
    'implementations/typescript/tools/protobuf-conformance/testee.ts',
    ['typescript', 'protobuf-conformance'],
  ],
  [
    'implementations/typescript/tools/protovalidate-differential/testee.ts',
    ['typescript', 'protovalidate-differential'],
  ],
  ['implementations/typescript/tsconfig.json', ['typescript']],
  ['implementations/typescript/.oxfmtrc.json', ['commits', 'typescript', 'examples']],
  [
    'implementations/typescript/src/router/router.ts',
    [
      'spec',
      'typescript',
      'dotnet',
      'interop-rust',
      'mqtt',
      'amqp',
      'builder',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
    ],
  ],
  ['implementations/dotnet/tools/Bead.ProtobufConformance/Program.cs', ['protobuf-conformance']],
  [
    'implementations/dotnet/tools/Bead.ProtovalidateDifferential/Program.cs',
    ['protovalidate-differential'],
  ],
  ['implementations/dotnet/tools/Bead.Benchmarks/Program.cs', ['dotnet']],
  [
    'implementations/dotnet/tests/Shared/Vectors.cs',
    ['spec', 'dotnet', 'interop-rust', 'mqtt', 'amqp'],
  ],
  [
    'implementations/dotnet/tests/Bead.Transport.Mqtt.Tests/MqttFixture.cs',
    ['spec', 'dotnet', 'mqtt'],
  ],
  [
    'implementations/dotnet/tests/Bead.Transport.Amqp.Tests/AmqpFixture.cs',
    ['spec', 'dotnet', 'amqp'],
  ],
  [
    'implementations/dotnet/tests/Bead.Protobuf.Tests/Generated/Probe.cs',
    ['spec', 'dotnet', 'builder'],
  ],
  ['implementations/dotnet/tests/Bead.Core.Tests/EnvelopeTests.cs', ['spec', 'dotnet']],
  [
    'implementations/dotnet/src/Bead.Core/Envelope.cs',
    [
      'spec',
      'dotnet',
      'interop-rust',
      'mqtt',
      'amqp',
      'builder',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
    ],
  ],
  ['implementations/rust/tools/protobuf-conformance/src/main.rs', ['rust', 'protobuf-conformance']],
  [
    'implementations/rust/tools/protovalidate-differential/src/main.rs',
    ['rust', 'protovalidate-differential'],
  ],
  ['implementations/rust/crates/bead-house/src/lib.rs', ['rust']],
  [
    'implementations/rust/crates/bead/src/envelope.rs',
    [
      'spec',
      'rust',
      'interop-rust',
      'mqtt',
      'builder',
      'examples',
      'protobuf-conformance',
      'protovalidate-differential',
    ],
  ],
];

describe('the rules', () => {
  test('each path reaches the areas of its rule', () => {
    for (const [path, areas] of CASES) {
      assert.deepEqual([...reachOf(path)].sort(), [...areas].sort(), path);
    }
  });

  test('each rule has a case', () => {
    const covered = new Set(
      CASES.map(([path]) => {
        return ruleOf(path);
      })
    );
    for (const rule of RULES) {
      assert.ok(
        [...covered].some((each) => {
          return each && each.why === rule.why;
        }),
        rule.why
      );
    }
  });

  test('each rule names areas of ci.yml alone', () => {
    for (const rule of RULES) {
      for (const area of rule.areas) {
        assert.ok(AREAS.includes(area), `${rule.why}: ${area}`);
      }
    }
  });

  test('every path git lists falls under a rule, so that a new folder is placed before it lands', () => {
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const unruled = paths.filter((path) => {
      return !ruleOf(path);
    });
    assert.deepEqual(unruled, []);
  });

  test('a shared path or one no rule names runs every job', () => {
    for (const path of [
      'spec/spec.md',
      'tools/ci-scope.mjs',
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      'tools/a-new-tool.mjs',
      'a-new-folder/file.txt',
      'package.json',
    ]) {
      assert.deepEqual(areasOf([path]), AREAS, path);
    }
  });

  test('a change of the documents alone runs the commits job alone', () => {
    assert.deepEqual(
      areasOf([
        'CHANGELOG.md',
        'CLAUDE.md',
        'docs/decisions/README.md',
        'docs/guides/getting-started.md',
        'docs/maintaining.md',
        'builder/README.md',
        'implementations/dotnet/README.md',
        'implementations/rust/README.md',
        'examples/hello/README.md',
      ]),
      ['commits']
    );
  });

  test('the documents another job reads run that job too', () => {
    assert.deepEqual(areasOf(['docs/support.md']), ['spec', 'commits']);
    assert.deepEqual(areasOf(['README.md']), ['spec', 'commits']);
    assert.deepEqual(areasOf(['implementations/typescript/README.md']), [
      'playwright',
      'typescript',
      'commits',
    ]);
  });

  test("the mascot's merge runs neither the Rust side, the builder, the examples nor the conformance jobs", () => {
    assert.deepEqual(
      areasOf([
        'CHANGELOG.md',
        'implementations/dotnet/tests/Bead.Transport.WebSockets.Tests/WebSocketTransportServerTests.cs',
        'implementations/typescript/demo/page.ts',
        'implementations/typescript/devtools/panel.ts',
        'implementations/typescript/playwright.devtools.config.ts',
        'implementations/typescript/skin/mascot.js',
        'implementations/typescript/tsconfig.json',
        'site/__tests__/build.test.mjs',
        'site/build.mjs',
        'site/dist/index.html',
        'tools/twins.tsv',
      ]),
      ['spec', 'playwright', 'typescript', 'dotnet', 'mqtt', 'commits', 'site']
    );
  });
});

// ── Patterns ───────────────────────────────────────────────────────────────────

describe('patternOf', () => {
  test('`**` crosses folders, `*` stays in one, `{a,b}` is either', () => {
    assert.ok(patternOf('spec/**').test('spec/schemas/a.json'));
    assert.ok(!patternOf('spec/**').test('specs/a.json'));
    assert.ok(patternOf('tools/*.tsv').test('tools/twins.tsv'));
    assert.ok(!patternOf('tools/*.tsv').test('tools/fuzz/twins.tsv'));
    assert.ok(
      patternOf('tools/{,__tests__/}fuzz.{mjs,test.mjs}').test('tools/__tests__/fuzz.test.mjs')
    );
    assert.ok(patternOf('tools/{,__tests__/}fuzz.{mjs,test.mjs}').test('tools/fuzz.mjs'));
    assert.ok(!patternOf('tools/{,__tests__/}fuzz.{mjs,test.mjs}').test('tools/fuzzy.mjs'));
    assert.ok(patternOf('a/**/b.txt').test('a/b.txt'));
    assert.ok(patternOf('a/**/b.txt').test('a/x/y/b.txt'));
    assert.ok(!patternOf('a.b').test('axb'));
  });
});

// ── Areas ──────────────────────────────────────────────────────────────────────

describe('closureOf', () => {
  test('an area brings the jobs it needs, and commits always', () => {
    assert.deepEqual(closureOf(['interop-rust']), [
      'playwright',
      'rust',
      'interop-rust',
      'commits',
    ]);
    assert.deepEqual(closureOf(['site']), ['playwright', 'commits', 'site']);
    assert.deepEqual(closureOf([]), ['commits']);
  });

  test('every area of a closure has what it needs in it', () => {
    for (const area of AREAS) {
      const closure = closureOf([area]);
      for (const needed of NEEDS[area] || []) {
        assert.ok(closure.includes(needed), `${area} needs ${needed}`);
      }
    }
  });
});

// ── CI ─────────────────────────────────────────────────────────────────────────

describe('modeOf', () => {
  test('a feature branch against develop, a pull request into develop against its base', () => {
    assert.deepEqual(
      modeOf({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature/test-scope' }),
      {
        base: 'origin/develop',
      }
    );
    assert.deepEqual(
      modeOf({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_HEAD_REF: 'dependabot/npm/x',
        GITHUB_BASE_REF: 'develop',
        BASE_SHA: 'abc',
      }),
      { base: 'abc' }
    );
  });

  test('develop, main, a release, a hotfix, a tag, a run by hand and any other branch run everything', () => {
    for (const env of [
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/develop' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/release/0.18.0' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/hotfix/0.17.1' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.17.0' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dependabot/npm/x' },
      { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature/x' },
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_HEAD_REF: 'release/0.18.0',
        GITHUB_BASE_REF: 'main',
        BASE_SHA: 'abc',
      },
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_HEAD_REF: 'hotfix/0.17.1',
        GITHUB_BASE_REF: 'develop',
        BASE_SHA: 'a',
      },
      {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_HEAD_REF: 'feature/x',
        GITHUB_BASE_REF: 'develop',
      },
    ]) {
      assert.ok(modeOf(env).all, JSON.stringify(env));
    }
  });
});

describe('verdictOf', () => {
  const ran = (result) => {
    return { result, outputs: {} };
  };

  test('passes where every job in scope succeeded and every other was skipped', () => {
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          typescript: ran('success'),
          rust: ran('skipped'),
        },
        ['typescript', 'commits']
      ),
      []
    );
  });

  test('fails on a job in scope skipped because the job it needs failed', () => {
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          rust: ran('failure'),
          'interop-rust': ran('skipped'),
        },
        ['rust', 'interop-rust', 'commits']
      ),
      ['rust: failure, in scope', 'interop-rust: skipped, in scope']
    );
  });

  test('fails on a job in scope cancelled, and on a job out of scope that ran', () => {
    assert.deepEqual(
      verdictOf({ scope: ran('success'), commits: ran('cancelled'), site: ran('success') }, [
        'commits',
      ]),
      ['commits: cancelled, in scope', 'site: success, out of scope, where it is skipped']
    );
  });

  test("reads a part's result against its area's scope", () => {
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          typescript: ran('success'),
          'typescript-apps': ran('success'),
          'typescript-coverage': ran('success'),
        },
        ['typescript', 'commits']
      ),
      []
    );
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          typescript: ran('skipped'),
          'typescript-apps': ran('skipped'),
          'typescript-coverage': ran('skipped'),
        },
        ['commits']
      ),
      []
    );
  });

  test('fails on a part in scope that failed or was skipped, and on one out of scope that ran', () => {
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          typescript: ran('failure'),
          'typescript-apps': ran('failure'),
          'typescript-coverage': ran('skipped'),
        },
        ['typescript', 'commits']
      ),
      [
        'typescript: failure, in scope',
        'typescript-apps: failure, in scope',
        'typescript-coverage: skipped, in scope',
      ]
    );
    assert.deepEqual(
      verdictOf(
        {
          scope: ran('success'),
          commits: ran('success'),
          typescript: ran('skipped'),
          'typescript-apps': ran('success'),
        },
        ['commits']
      ),
      ['typescript-apps: success, out of scope, where it is skipped']
    );
  });

  test('fails when the scope failed, whatever the jobs did', () => {
    assert.deepEqual(
      verdictOf({ scope: ran('failure'), commits: ran('success'), rust: ran('skipped') }, []),
      ["scope: failure, so no job's scope is known"]
    );
  });
});

// ── Local ──────────────────────────────────────────────────────────────────────

describe('the local commands', () => {
  test('each area has its commands, playwright none', () => {
    for (const area of AREAS) {
      assert.ok(Array.isArray(LOCAL[area]), area);
      assert.equal(LOCAL[area].length === 0, area === 'playwright', area);
    }
  });

  test("a change of the documents alone asks the commits job's steps alone", () => {
    const paths = ['docs/maintaining.md'];
    const steps = stepsOf(areasOf(paths), paths);
    assert.deepEqual(
      [
        ...new Set(
          steps.map((each) => {
            return each.area;
          })
        ),
      ],
      ['commits']
    );
    assert.ok(
      steps.some((each) => {
        return each.command === 'node tools/check-format.mjs';
      })
    );
  });

  test('the demo alone leaves out the unit suite, which the runtime asks', () => {
    const has = (paths) => {
      return stepsOf(areasOf(paths), paths).some((each) => {
        return each.command.startsWith('yarn test:coverage');
      });
    };
    assert.equal(has(['implementations/typescript/demo/page.ts']), false);
    assert.equal(has(['implementations/typescript/src/router/router.ts']), true);
  });

  test('the C# side narrows to the test projects that changed, and is whole otherwise', () => {
    assert.deepEqual(
      dotnetProjectsOf(['implementations/dotnet/tests/Bead.Core.Tests/A.cs', 'site/build.mjs']),
      ['Bead.Core.Tests']
    );
    assert.equal(dotnetProjectsOf(['implementations/dotnet/tests/Shared/Vectors.cs']), undefined);
    assert.equal(dotnetProjectsOf(['implementations/dotnet/src/Bead.Core/Envelope.cs']), undefined);
    assert.equal(dotnetProjectsOf(['implementations/typescript/src/router/router.ts']), undefined);
    const paths = ['implementations/dotnet/tests/Bead.Core.Tests/A.cs'];
    const commands = stepsOf(['dotnet'], paths).map((each) => {
      return each.command;
    });
    assert.ok(commands.includes('dotnet test --project tests/Bead.Core.Tests'));
    assert.ok(
      !commands.some((each) => {
        return each.includes('Bead.slnx');
      })
    );
  });

  test('--gates leaves out the whole suites, --all keeps every command', () => {
    const paths = ['implementations/rust/crates/bead/src/envelope.rs'];
    const gates = stepsOf(areasOf(paths), paths, { gates: true });
    assert.ok(
      gates.every((each) => {
        return !each.suite;
      })
    );
    const all = stepsOf(AREAS, [], { all: true });
    assert.equal(
      all.length,
      AREAS.reduce((count, area) => {
        return count + LOCAL[area].length;
      }, 0)
    );
  });

  test('the lines run from the root in bash and PowerShell alike: a folder entered and left, no variable before a command', () => {
    const lines = linesOf(
      [
        { area: 'commits', folder: '.', command: 'node tools/check-commits.mjs {base}..{head}' },
        {
          area: 'typescript',
          folder: 'implementations/typescript',
          command: 'yarn check',
          note: 'a note',
        },
        { area: 'builder', folder: 'builder', command: 'yarn check' },
      ],
      'origin/develop'
    );
    assert.deepEqual(lines, [
      '# commits',
      'node tools/check-commits.mjs origin/develop..HEAD',
      '# typescript',
      'cd implementations/typescript',
      '# a note',
      'yarn check',
      'cd ../..',
      '# builder',
      'cd builder',
      'yarn check',
      'cd ..',
    ]);
    const every = linesOf(stepsOf(AREAS, [], { all: true }), 'origin/develop');
    assert.ok(
      every.every((line) => {
        return !/^[A-Z_]+=/.test(line);
      })
    );
  });
});
