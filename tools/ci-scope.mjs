#!/usr/bin/env node
// The tests run by what changes: one table of rules, written once, that CI on a feature branch, the
// maintainer before a push and the workflows' integration all apply. A rule names path patterns
// and the areas a path it matches reaches. An area is a job of `.github/workflows/ci.yml`, by its
// id, with the jobs `PARTS` names its own, and the commands that play them from a clone. The first
// rule a path matches is its rule, so a narrow rule stands before a broad one; a path no rule
// matches reaches every area.
//
// The rules follow what each job reads, not the folders' names: `spec` reads every side's tests,
// the builder's, `docs/support.md` and the README; `typescript` reads the builder's sources, which
// the demo imports, and `site/`, which its accessibility sweep serves; `dotnet` and `rust` compile
// the builder's goldens; `builder` checks the code it generates into each side; `examples` and both
// conformance jobs build every side's runtime. A side's runtime reaches the jobs that make the sides
// talk, `dotnet`'s interop, `interop-rust`, `mqtt` and `amqp`; its demo, its DevTools extension and
// one side's own tests reach fewer. `commits` runs always. An area pulls in the jobs it needs:
// `interop-rust` takes the binaries `rust` builds, and five areas' jobs run in the image `playwright`
// names.
//
//   node tools/ci-scope.mjs [<base> [<head>]]         the areas, one a line
//   node tools/ci-scope.mjs --local [<base> [<head>]] the commands of those areas, from the root,
//                                                     the steps of `commits` first
//   node tools/ci-scope.mjs --local --gates [<base>]  the same without the whole suites, which CI
//                                                     runs on the pushed branch
//   node tools/ci-scope.mjs --local --all             every area's commands
//   node tools/ci-scope.mjs --run [--gates] [--all | <base> [<head>]]
//                                                     print and run those commands in order,
//                                                     stopping at the first failure
//   node tools/ci-scope.mjs --paths [<base> [<head>]] each changed path and the areas it reaches
//   node tools/ci-scope.mjs --github                  in CI: the areas of the event, to
//                                                     $GITHUB_OUTPUT as `areas`, a JSON array
//   node tools/ci-scope.mjs --verdict                 in CI's `ci-ok`: each job's result against
//                                                     its scope, from NEEDS and AREAS
//
// What changed is what HEAD and the working tree hold apart from the merge base of HEAD and <base>,
// `origin/develop` by default, untracked files included; with <head>, what <head> holds apart from
// its merge base with <base>, the working tree aside. A merge into develop and a release run
// everything: `--all` locally, and CI on a push to develop, main, a release or a hotfix branch, by
// hand, or where the merge base cannot be read.
//
// Exit 1 on a job off its scope (--verdict), or on an argument it does not know; --run exits with
// the first failed command's code, or 0 when every command passes. It inherits the environment.

import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

// ── The areas ──────────────────────────────────────────────────────────────────

// ! one a job of ci.yml, by its id, `scope`, `ci-ok` and the parts aside: the test holds both lists
// to each other
export const AREAS = Object.freeze([
  'spec',
  'playwright',
  'typescript',
  'dotnet',
  'rust',
  'interop-rust',
  'mqtt',
  'amqp',
  'builder',
  'examples',
  'protobuf-conformance',
  'protovalidate-differential',
  'commits',
  'site',
]);

// what every change runs
const ALWAYS = Object.freeze(['commits']);

// an area and the areas whose jobs it `needs`, as ci.yml writes them
export const NEEDS = Object.freeze({
  typescript: ['playwright'],
  dotnet: ['playwright'],
  'interop-rust': ['playwright', 'rust'],
  mqtt: ['playwright'],
  site: ['playwright'],
});

// a job that does part of an area's work, apart so it runs beside the area's job or after it: the
// area whose scope it runs in, and the jobs it `needs` beside `scope`, as ci.yml writes them
export const PARTS = Object.freeze({
  // the demo, the DevTools extension and the page, beside the tests
  'typescript-apps': Object.freeze({ area: 'typescript', needs: ['playwright'] }),
  // the coverage of the tests' shards, merged and held to the floor
  'typescript-coverage': Object.freeze({ area: 'typescript', needs: ['playwright', 'typescript'] }),
  // the lints by feature set, the WebAssembly one among them, and the documentation
  'rust-lints': Object.freeze({ area: 'rust', needs: [] }),
  // the tests under instrumentation, held to the floor
  'rust-coverage': Object.freeze({ area: 'rust', needs: [] }),
  // the fuzz targets, built on the nightly
  'rust-fuzz': Object.freeze({ area: 'rust', needs: [] }),
  // the tests on Windows
  'rust-windows': Object.freeze({ area: 'rust', needs: [] }),
  // beadc's tests on its image, on each architecture
  'builder-image': Object.freeze({ area: 'builder', needs: [] }),
  // the Rust side over MQTT 5, against a broker of its own
  'mqtt-rust': Object.freeze({ area: 'mqtt', needs: [] }),
});

// ── The rules ──────────────────────────────────────────────────────────────────

// what a side's runtime reaches: its own jobs, the interop, the brokers, the builder that generates
// into it, the examples and both conformance jobs that build it, and spec/check.py, which reads its
// tests
const TYPESCRIPT_RUNTIME = [
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
];
const CSHARP_RUNTIME = [
  'spec',
  'dotnet',
  'interop-rust',
  'mqtt',
  'amqp',
  'builder',
  'examples',
  'protobuf-conformance',
  'protovalidate-differential',
];
// no `amqp`: the Rust side has no AMQP 1.0 binding
const RUST_RUNTIME = [
  'spec',
  'rust',
  'interop-rust',
  'mqtt',
  'builder',
  'examples',
  'protobuf-conformance',
  'protovalidate-differential',
];
// beadc's sources: the demo imports them, so `typescript` and `mqtt` read them; the examples and both
// conformance jobs generate with them; spec/check.py reads their tests
const BUILDER_SOURCE = [
  'spec',
  'builder',
  'typescript',
  'mqtt',
  'examples',
  'protobuf-conformance',
  'protovalidate-differential',
];

// a root tool and its own test, by the tool's name
const tool = (...names) => {
  return names.map((name) => {
    return `tools/{,__tests__/}${name}.{mjs,d.mts,test.mjs}`;
  });
};

// ! the first rule a path matches is its rule: a narrow pattern stands before the broad one it
// would fall under
export const RULES = Object.freeze([
  {
    why: 'the scope itself, and the CI it drives',
    patterns: [...tool('ci-scope'), '.github/workflows/ci.yml'],
    areas: AREAS,
  },
  {
    why: 'what git reads of every file',
    patterns: ['.gitattributes', '.gitignore'],
    areas: AREAS,
  },
  {
    why: 'documents no job but commits reads: its links, its format, its names',
    patterns: [
      'CHANGELOG.md',
      'SECURITY.md',
      'CLAUDE.md',
      'buf.yaml',
      'osv-scanner.toml',
      '.claude/**',
      '.githooks/**',
      '.github/dependabot.yml',
      '.github/workflows/{bench,drift,fuzz,guides,image}.yml',
      'docs/decisions/**',
      'docs/guides/**',
      'docs/maintaining.md',
      'builder/README.md',
      'implementations/dotnet/README.md',
      'implementations/rust/README.md',
      'examples/hello/README.md',
    ],
    areas: ['commits'],
  },
  {
    why: 'the counts spec/check.py holds to the files they count',
    patterns: ['README.md', 'docs/support.md'],
    areas: ['commits', 'spec'],
  },
  {
    why: "the root's checks the commits job alone runs, and their ledgers",
    patterns: [
      ...tool(
        'check-commits',
        'check-links',
        'check-citations',
        'check-details',
        'check-byte-counts',
        'check-wire-names',
        'check-names',
        'check-durations',
        'check-twins',
        'check-format',
        'surface-lists',
        'release',
        'flow',
        'git-floor',
        'caches',
        'bench-compare',
        'bench-release',
        'fuzz',
        'verify-image'
      ),
      'tools/{twins,names,durations}.tsv',
      'tools/fuzz/**',
    ],
    areas: ['commits'],
  },
  {
    why: "the wire formats' names, whose modules each side's lint reads",
    patterns: ['tools/wire-names.tsv'],
    areas: ['commits', 'typescript', 'dotnet', 'rust'],
  },
  {
    why: 'the versions, which spec/check.py reads too',
    patterns: tool('check-versions'),
    areas: ['commits', 'spec'],
  },
  {
    why: "each side's coverage, held to its floor",
    patterns: [...tool('coverage-report'), 'tools/coverage-floors.json'],
    areas: ['commits', 'typescript', 'dotnet', 'rust'],
  },
  {
    why: "the accessibility sweep, typescript-apps's, a part of typescript",
    patterns: [...tool('check-a11y'), 'tools/a11y-exceptions.json'],
    areas: ['commits', 'typescript'],
  },
  {
    why: "the brokers' fixtures, which every side's broker tests start",
    patterns: tool('mqtt-broker', 'broker-fixture'),
    areas: ['commits', 'mqtt', 'amqp'],
  },
  {
    why: "the AMQP 1.0 broker's fixture",
    patterns: tool('amqp-broker'),
    areas: ['commits', 'amqp'],
  },
  {
    why: 'what beadc generates for the spec, held in the builder job',
    patterns: tool('check-validations', 'check-transcoding'),
    areas: ['commits', 'builder'],
  },
  {
    why: 'what the examples copy',
    patterns: tool('check-examples'),
    areas: ['commits', 'examples'],
  },
  {
    why: "protobuf's conformance suite, whose floor spec/check.py reads",
    patterns: [...tool('protobuf-conformance'), 'tools/protobuf-conformance/**'],
    areas: ['commits', 'spec', 'protobuf-conformance'],
  },
  {
    why: 'the protovalidate differential',
    patterns: [...tool('protovalidate-differential'), 'tools/protovalidate-differential/**'],
    areas: ['commits', 'protovalidate-differential'],
  },
  {
    why: 'the pinned download, which reaches the jobs of each Node tool that makes one',
    patterns: tool('fetch-pinned'),
    areas: ['commits', ...BUILDER_SOURCE, 'rust'],
  },
  {
    why: 'the spec and its conformance files, which every side reads',
    patterns: ['spec/**'],
    areas: AREAS,
  },
  {
    why: "the page's deploy tests, the commits job's",
    patterns: ['site/__tests__/**'],
    areas: ['commits'],
  },
  {
    why: 'the page: its layout, and its accessibility in typescript-apps, which serves it',
    patterns: ['site/**'],
    areas: ['commits', 'typescript', 'site'],
  },
  {
    why: "the builder's C# goldens, which the .NET job compiles",
    patterns: ['builder/test/golden/csharp/**'],
    areas: ['builder', 'dotnet'],
  },
  {
    why: "the builder's Rust goldens, which the Rust job compiles",
    patterns: ['builder/test/golden/rust/**'],
    areas: ['builder', 'rust'],
  },
  {
    why: "protoc's pin and the options' .proto, which the Rust job's descriptor set reads too",
    patterns: ['builder/proto/**', 'builder/protoc.json', 'builder/tools/fetch-protoc.mjs'],
    areas: [...BUILDER_SOURCE, 'rust'],
  },
  {
    why: "protoc-gen-buffa's pin, for the Rust messages beadc generates",
    patterns: ['builder/protoc-gen-buffa.json', 'builder/tools/fetch-protoc-gen-buffa.mjs'],
    areas: ['builder', 'examples', 'protovalidate-differential'],
  },
  {
    why: "the wrappers' templates, which beadc init writes into the examples",
    patterns: ['builder/wrappers/**'],
    areas: ['builder', 'examples'],
  },
  {
    why: "beadc's sources and its packages",
    patterns: [
      'builder/src/**',
      'builder/package.json',
      'builder/yarn.lock',
      'builder/.yarnrc.yml',
      'builder/.yarn/**',
    ],
    areas: BUILDER_SOURCE,
  },
  {
    why: "the rest of the builder: its image, its tests' fixtures, its tools",
    patterns: ['builder/**', 'LICENSE'],
    areas: ['builder'],
  },
  {
    why: "the root's beadc.yaml, the interop's generation",
    patterns: ['beadc.yaml'],
    areas: ['commits', 'builder'],
  },
  {
    why: "hello's Rust half, whose dependencies the Rust job holds",
    patterns: ['examples/hello/rust/**'],
    areas: ['examples', 'builder', 'rust'],
  },
  {
    why: 'the examples, which the builder job runs beadc breaking and the wrappers over',
    patterns: ['examples/**'],
    areas: ['examples', 'builder'],
  },
  {
    why: "the TypeScript side's README, whose examples yarn check holds",
    patterns: ['implementations/typescript/README.md'],
    areas: ['commits', 'typescript'],
  },
  {
    why: "the demo's service, which beadc generates",
    patterns: [
      'implementations/typescript/demo/beadc.yaml',
      'implementations/typescript/demo/proto/**',
      'implementations/typescript/demo/gen/**',
    ],
    areas: ['typescript', 'mqtt', 'builder'],
  },
  {
    why: 'the demo, the DevTools extension and their skin, which the MQTT 5 job plays over a broker',
    patterns: [
      'implementations/typescript/{demo,devtools,skin}/**',
      'implementations/typescript/playwright.{demo,devtools}.config.ts',
    ],
    areas: ['typescript', 'mqtt'],
  },
  {
    why: "the TypeScript testee of protobuf's conformance suite",
    patterns: ['implementations/typescript/tools/protobuf-conformance/**'],
    areas: ['typescript', 'protobuf-conformance'],
  },
  {
    why: 'the TypeScript testee of the protovalidate differential',
    patterns: ['implementations/typescript/tools/protovalidate-differential/**'],
    areas: ['typescript', 'protovalidate-differential'],
  },
  {
    why: "the TypeScript side's own configuration, which no other job reads",
    patterns: [
      'implementations/typescript/{tsconfig.json,tsconfig.validations.json,.oxlintrc.json,.c8rc.json,comment-budget.json}',
    ],
    areas: ['typescript'],
  },
  {
    why: "the formatter's configuration, which the root's format and the examples' copies read",
    patterns: ['implementations/typescript/.oxfmtrc.json'],
    areas: ['commits', 'typescript', 'examples'],
  },
  {
    why: "the TypeScript side's runtime",
    patterns: ['implementations/typescript/**'],
    areas: TYPESCRIPT_RUNTIME,
  },
  {
    why: "the C# testee of protobuf's conformance suite",
    patterns: ['implementations/dotnet/tools/Bead.ProtobufConformance/**'],
    areas: ['protobuf-conformance'],
  },
  {
    why: 'the C# testee of the protovalidate differential',
    patterns: ['implementations/dotnet/tools/Bead.ProtovalidateDifferential/**'],
    areas: ['protovalidate-differential'],
  },
  {
    why: "the C# side's bench and fuzz harness, which the .NET job builds",
    patterns: ['implementations/dotnet/tools/**'],
    areas: ['dotnet'],
  },
  {
    why: "the C# interop's tests and their shared helpers, which every interop job runs",
    patterns: ['implementations/dotnet/tests/{Bead.Interop.Tests,Shared}/**'],
    areas: ['spec', 'dotnet', 'interop-rust', 'mqtt', 'amqp'],
  },
  {
    why: "the C# MQTT 5 adapter's tests",
    patterns: ['implementations/dotnet/tests/Bead.Transport.Mqtt.Tests/**'],
    areas: ['spec', 'dotnet', 'mqtt'],
  },
  {
    why: "the C# AMQP 1.0 adapter's tests",
    patterns: ['implementations/dotnet/tests/Bead.Transport.Amqp.Tests/**'],
    areas: ['spec', 'dotnet', 'amqp'],
  },
  {
    why: 'the C# code beadc generates for the spec',
    patterns: [
      'implementations/dotnet/tests/{Bead.Protobuf.Tests,Bead.Transcoding.Tests}/Generated/**',
    ],
    areas: ['spec', 'dotnet', 'builder'],
  },
  {
    why: "the C# side's other tests",
    patterns: ['implementations/dotnet/tests/**'],
    areas: ['spec', 'dotnet'],
  },
  {
    why: "the C# side's runtime",
    patterns: ['implementations/dotnet/**'],
    areas: CSHARP_RUNTIME,
  },
  {
    why: "the Rust testee of protobuf's conformance suite, whose dependencies the Rust job holds",
    patterns: ['implementations/rust/tools/protobuf-conformance/**'],
    areas: ['rust', 'protobuf-conformance'],
  },
  {
    why: 'the Rust testee of the protovalidate differential, whose dependencies the Rust job holds',
    patterns: ['implementations/rust/tools/protovalidate-differential/**'],
    areas: ['rust', 'protovalidate-differential'],
  },
  {
    why: "the Rust side's own: its fuzz targets, its benches, its goldens' crate, its house rules",
    patterns: [
      'implementations/rust/{fuzz,benches}/**',
      'implementations/rust/crates/{bead-goldens,bead-house}/**',
      'implementations/rust/tools/check-protobuf.mjs',
    ],
    areas: ['rust'],
  },
  {
    why: "the Rust side's runtime",
    patterns: ['implementations/rust/**'],
    areas: RUST_RUNTIME,
  },
]);

// ── Patterns ───────────────────────────────────────────────────────────────────

// a glob as git's pathspecs and ci.yml's `paths` read one: `**` any run of folders, `*` any run of
// characters within one, `{a,b}` either
export const patternOf = (glob) => {
  let source = '';
  let index = 0;
  let depth = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 2;
    } else if (char === '*') {
      source += '[^/]*';
      index += 1;
    } else if (char === '{') {
      source += '(?:';
      depth += 1;
      index += 1;
    } else if (char === '}' && depth > 0) {
      source += ')';
      depth -= 1;
      index += 1;
    } else if (char === ',' && depth > 0) {
      source += '|';
      index += 1;
    } else {
      source += char.replace(/[.+?^$()[\]\\|]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
};

const COMPILED = RULES.map((rule) => {
  return { ...rule, matchers: rule.patterns.map(patternOf) };
});

// the rule a path falls under, or undefined where none names it
export const ruleOf = (path) => {
  return COMPILED.find((rule) => {
    return rule.matchers.some((matcher) => {
      return matcher.test(path);
    });
  });
};

// ── Areas ──────────────────────────────────────────────────────────────────────

// the areas given, with what they need and what always runs, in ci.yml's order
export const closureOf = (areas) => {
  const held = new Set([...ALWAYS, ...areas]);
  for (const area of [...held]) {
    for (const needed of NEEDS[area] || []) {
      held.add(needed);
    }
  }
  return AREAS.filter((area) => {
    return held.has(area);
  });
};

// the areas a path reaches: its rule's, or every area where no rule names it
export const reachOf = (path) => {
  const rule = ruleOf(path);
  return rule ? rule.areas : AREAS;
};

// the areas a set of changed paths reaches
export const areasOf = (paths) => {
  return closureOf(paths.flatMap(reachOf));
};

// ── CI ─────────────────────────────────────────────────────────────────────────

const WHOLE_BRANCHES = /^refs\/heads\/(develop|main|release\/.+|hotfix\/.+)$/;

// what an event of CI compares against: `{ all: reason }`, or `{ base }`, a revision whose merge base
// with HEAD is the start of what changed
export const modeOf = (env) => {
  const event = env.GITHUB_EVENT_NAME || '';
  const ref = env.GITHUB_REF || '';
  if (event === 'pull_request') {
    const head = env.GITHUB_HEAD_REF || '';
    const into = env.GITHUB_BASE_REF || '';
    if (into === 'main' || /^(release|hotfix)\//.test(head)) {
      return { all: `a pull request from ${head} into ${into}` };
    }
    if (!env.BASE_SHA) {
      return { all: 'a pull request whose base is not given' };
    }
    return { base: env.BASE_SHA };
  }
  if (event === 'push') {
    if (ref.startsWith('refs/tags/')) {
      return { all: `the tag ${ref.slice('refs/tags/'.length)}` };
    }
    if (WHOLE_BRANCHES.test(ref)) {
      return { all: `a push to ${ref.slice('refs/heads/'.length)}` };
    }
    if (ref.startsWith('refs/heads/feature/')) {
      return { base: 'origin/develop' };
    }
    return { all: `a push to ${ref}, which is no feature branch` };
  }
  return { all: `a run of ${event || 'no event'}` };
};

// each job's result against its scope, a part's its area's: one in scope succeeded, one out of it
// was skipped, and the scope itself succeeded; a job skipped because one it needs failed is in scope,
// so it fails here
export const verdictOf = (needs, areas) => {
  const problems = [];
  const scope = needs.scope ? needs.scope.result : 'absent';
  if (scope !== 'success') {
    problems.push(`scope: ${scope}, so no job's scope is known`);
  }
  for (const [job, { result }] of Object.entries(needs)) {
    if (job === 'scope') {
      continue;
    }
    const area = PARTS[job] ? PARTS[job].area : job;
    if (ALWAYS.includes(area) || areas.includes(area)) {
      if (result !== 'success') {
        problems.push(`${job}: ${result}, in scope`);
      }
    } else if (result !== 'skipped') {
      problems.push(`${job}: ${result}, out of scope, where it is skipped`);
    }
  }
  return problems;
};

// ── Git ────────────────────────────────────────────────────────────────────────

const git = (args) => {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const zeroSplit = (text) => {
  return text.split('\0').filter((entry) => {
    return entry !== '';
  });
};

// what changed: from the merge base of <base> and <head> to <head>, or, with no head, to the working
// tree, untracked files included; a moved file at both its paths
export const changedOf = (base, head) => {
  const start = git(['merge-base', base, head || 'HEAD']).trim();
  const paths = head
    ? zeroSplit(git(['diff', '--name-only', '--no-renames', '-z', start, head]))
    : [
        ...zeroSplit(git(['diff', '--name-only', '--no-renames', '-z', start])),
        ...zeroSplit(git(['ls-files', '--others', '--exclude-standard', '-z'])),
      ];
  return [...new Set(paths)].sort();
};

// ── Local ──────────────────────────────────────────────────────────────────────

// what the demo and the DevTools extension alone read: their own cases over a broker owed, the
// broker's other cases not
const APPS_ALONE =
  /^(implementations\/typescript\/((demo|devtools|skin)\/|playwright\.(demo|devtools)\.config\.ts$)|builder\/)/;
// what the unit suite does not run: the demo's, the page's, the checks' and the side's own
// configuration of its checks
const TYPESCRIPT_SUITE_ALONE =
  /^(implementations\/typescript\/((demo|devtools|skin)\/|playwright\.(demo|devtools)\.config\.ts$|tsconfig\.json$|tsconfig\.validations\.json$|\.oxlintrc\.json$|comment-budget\.json$|README\.md$)|site\/|builder\/|tools\/(__tests__\/)?check-a11y|tools\/a11y-exceptions)/;
const A11Y = [
  '/',
  '"/?lng=fr"',
  '/privacy/',
  '"/privacy/?lng=fr"',
  '/nowhere',
  '/playground/',
  '"/playground/#calls"',
  '"/playground/#rules"',
  '"/playground/#openapi"',
  '"/playground/#server"',
  '"/playground/#code"',
  '"/playground/#packages"',
].join(' ');
const GENERATORS = [
  'vectors',
  'conversations',
  'transports',
  'clocks',
  'durations',
  'debug_filters',
  'metrics',
  'codecs',
  'identities',
  'validations',
  'transcoding',
];
const RUST_CLIPPY_FEATURES = ['', 'websocket', 'http', 'mqtt', 'transcoding', 'gateway'];
const DOTNET = 'implementations/dotnet';
const TYPESCRIPT = 'implementations/typescript';
const RUST = 'implementations/rust';
// the folders the C# side's format leaves to their generator
const DOTNET_EXCLUDED =
  '--exclude ../../builder/test/golden/csharp interop/Bead.Interop/Generated tests/Bead.Protobuf.Tests/Generated';

// a command: its folder from the root, `suite` when it runs a whole suite, `unless` a pattern every
// path that reaches its area matches where it is not owed, `note` a line before it
const step = (folder, command, options = {}) => {
  return { folder, command, ...options };
};

// each area's commands, as its job runs them
export const LOCAL = Object.freeze({
  commits: [
    step('.', 'node tools/check-commits.mjs {base}..{head}'),
    step('.', 'node tools/check-links.mjs'),
    step('.', 'node tools/check-citations.mjs', {
      note: 'check-citations and check-details read the files git lists: `git add -N` a new one',
    }),
    step('.', 'node tools/check-details.mjs'),
    step('.', 'node tools/check-byte-counts.mjs'),
    step('.', 'node tools/check-wire-names.mjs'),
    step('.', 'node site/check.mjs'),
    step('.', 'node --test "site/__tests__/*.test.mjs"'),
    step('.', 'node tools/check-names.mjs'),
    step('.', 'node tools/check-durations.mjs'),
    step('.', 'node tools/check-twins.mjs'),
    step('.', 'node tools/check-versions.mjs'),
    step('.', 'node --test "tools/__tests__/*.test.mjs"'),
    step('.', 'node tools/check-format.mjs', {
      note: "the supply chain's steps, the actions' pins, OSV-Scanner and Semgrep, are ci.yml's commits job's",
    }),
  ],
  spec: [
    ...GENERATORS.map((name, index) => {
      return step('.', `python spec/generators/make_${name}.py`, {
        note: index === 0 ? 'python: the virtual environment of spec/requirements.txt' : undefined,
      });
    }),
    step('.', 'git diff --exit-code -- spec'),
    step('.', 'python spec/check.py'),
  ],
  playwright: [],
  typescript: [
    step(TYPESCRIPT, 'yarn check'),
    step(
      TYPESCRIPT,
      'yarn test:coverage --grep-invert "the (C#|Rust) server of the interop service"',
      {
        suite: true,
        unless: TYPESCRIPT_SUITE_ALONE,
      }
    ),
    step(
      '.',
      'node tools/coverage-report.mjs implementations/typescript/coverage/coverage-final.json --under implementations/typescript/src --floor typescript',
      { suite: true, unless: TYPESCRIPT_SUITE_ALONE }
    ),
    step(TYPESCRIPT, 'yarn playground:build:file'),
    step(TYPESCRIPT, 'yarn devtools:build'),
    step(TYPESCRIPT, 'yarn test:devtools', { suite: true }),
    step(TYPESCRIPT, 'yarn test:demo', { suite: true }),
    step('.', 'node site/deploy.mjs --assemble', { suite: true }),
    step('.', `node tools/check-a11y.mjs --serve site/out ${A11Y}`, { suite: true }),
  ],
  dotnet: [
    step(DOTNET, `dotnet format Bead.slnx --verify-no-changes ${DOTNET_EXCLUDED}`),
    step(DOTNET, 'dotnet build Bead.slnx'),
    step(DOTNET, 'dotnet build -c Release tools/Bead.Benchmarks'),
    step(
      DOTNET,
      'dotnet test --solution Bead.slnx --coverage --coverage-output-format cobertura --results-directory TestResults/coverage --filter-not-trait "server=Rust"',
      { suite: true, note: 'BEAD_INTEROP_REQUIRED=1 in the environment, as CI sets it' }
    ),
    step(
      DOTNET,
      'node ../../tools/coverage-report.mjs TestResults/coverage/*.cobertura.xml --under implementations/dotnet/src --floor csharp',
      { suite: true }
    ),
    step(TYPESCRIPT, 'yarn test:interop --grep-invert "the Rust server"', { suite: true }),
    step(TYPESCRIPT, 'yarn test:browser', { suite: true }),
  ],
  rust: [
    step(RUST, 'cargo fmt --all -- --check'),
    step(RUST, 'cargo clippy --workspace --all-targets --all-features --locked'),
    step(RUST, 'cargo clippy --workspace --all-targets --locked'),
    ...RUST_CLIPPY_FEATURES.map((feature) => {
      return step(
        RUST,
        `cargo clippy -p francisdesjardins-bead --lib${feature ? ` --features ${feature}` : ''} --locked`
      );
    }),
    step(
      RUST,
      'cargo clippy -p francisdesjardins-bead-protobuf --lib --features transcoding --locked'
    ),
    step(
      RUST,
      'cargo clippy -p francisdesjardins-bead --lib --features testing,transcoding --locked --target wasm32-unknown-unknown'
    ),
    step(RUST, 'cargo doc --workspace --no-deps --all-features --locked'),
    step(RUST, 'cargo build --workspace --locked'),
    step(RUST, 'cargo deny --locked check'),
    ...[
      'fuzz/Cargo.toml',
      'tools/protobuf-conformance/Cargo.toml',
      'tools/protovalidate-differential/Cargo.toml',
      '../../examples/hello/rust/Cargo.toml',
    ].map((manifest) => {
      return step(RUST, `cargo deny --manifest-path ${manifest} --locked check`);
    }),
    step(RUST, 'node tools/check-protobuf.mjs'),
    step(RUST, 'cargo test --workspace --all-features --locked', { suite: true }),
    step(
      RUST,
      String.raw`cargo llvm-cov --workspace --all-features --locked --json --summary-only --ignore-filename-regex '([/\\]tests\.rs|[/\\]tests[/\\].*|[/\\]testing\.rs|[/\\]testing[/\\].*|[/\\]generated[/\\].*|[/\\]crates[/\\]bead-goldens[/\\].*)$' --output-path coverage/rust.json`,
      {
        suite: true,
        note: "the coverage rust-coverage measures, then its floor; the fuzz targets, built on the nightly, are rust-fuzz's alone",
      }
    ),
    step(
      RUST,
      'node ../../tools/coverage-report.mjs coverage/rust.json --under implementations/rust/crates/bead/src --under implementations/rust/crates/bead-protobuf/src --floor rust',
      { suite: true }
    ),
  ],
  'interop-rust': [
    step(RUST, 'cargo build -p francisdesjardins-bead-interop-server --locked'),
    step(RUST, 'cargo test -p francisdesjardins-bead-interop-server --test interop --locked', {
      suite: true,
      note: 'BEAD_INTEROP_RUST=1, and BEAD_INTEROP_RUST_SERVER the binary built above, in the environment',
    }),
    step(TYPESCRIPT, 'yarn test:interop --grep "the Rust server"', { suite: true }),
    step(DOTNET, 'dotnet test --project tests/Bead.Interop.Tests --filter-trait "server=Rust"', {
      suite: true,
    }),
  ],
  mqtt: [
    step(TYPESCRIPT, 'node ../../tools/mqtt-broker.mjs run -- yarn test:mqtt', {
      suite: true,
      unless: APPS_ALONE,
    }),
    step(
      TYPESCRIPT,
      'node ../../tools/mqtt-broker.mjs run -- yarn test:demo --project unit --grep "over MQTT 5"',
      { suite: true }
    ),
    step(
      DOTNET,
      'node ../../tools/mqtt-broker.mjs run -- dotnet test --project tests/Bead.Transport.Mqtt.Tests',
      { suite: true, unless: APPS_ALONE }
    ),
    step(
      DOTNET,
      'node ../../tools/mqtt-broker.mjs run -- dotnet test --project tests/Bead.Interop.Tests --filter-trait "transport=MQTT"',
      { suite: true, unless: APPS_ALONE }
    ),
    step(TYPESCRIPT, 'node ../../tools/mqtt-broker.mjs run -- yarn test:browser --grep "MQTT 5"', {
      suite: true,
      unless: APPS_ALONE,
    }),
    step(
      TYPESCRIPT,
      'node ../../tools/mqtt-broker.mjs run -- yarn test:devtools --grep "over MQTT 5"',
      {
        suite: true,
      }
    ),
    step(
      TYPESCRIPT,
      'node ../../tools/mqtt-broker.mjs run -- yarn test:demo --project page --grep "over MQTT 5"',
      {
        suite: true,
      }
    ),
    step(
      RUST,
      'node ../../tools/mqtt-broker.mjs run -- cargo test -p francisdesjardins-bead --features testing,mqtt --locked --test transports --test vectors',
      { suite: true, unless: APPS_ALONE }
    ),
    step(
      RUST,
      'node ../../tools/mqtt-broker.mjs run -- cargo test -p francisdesjardins-bead --features testing,mqtt --locked --lib mqtt::',
      { suite: true, unless: APPS_ALONE }
    ),
    step(
      RUST,
      'node ../../tools/mqtt-broker.mjs run -- cargo test -p francisdesjardins-bead-interop-server --locked --test interop -- ::mqtt::',
      { suite: true, unless: APPS_ALONE, note: 'BEAD_INTEROP_RUST=1 in the environment' }
    ),
    step(
      TYPESCRIPT,
      'node ../../tools/mqtt-broker.mjs run -- yarn test:interop --grep "the Rust server.*over MQTT 5"',
      {
        suite: true,
        unless: APPS_ALONE,
        note: 'BEAD_INTEROP_RUST_SERVER the Rust interop server, as cargo builds it, in the environment',
      }
    ),
    step(
      DOTNET,
      'node ../../tools/mqtt-broker.mjs run -- dotnet test --project tests/Bead.Interop.Tests --filter-query "/[(server=Rust)&(transport=MQTT)]"',
      { suite: true, unless: APPS_ALONE }
    ),
  ],
  amqp: [
    step(TYPESCRIPT, 'node ../../tools/amqp-broker.mjs run -- yarn test:amqp', { suite: true }),
    step(
      DOTNET,
      'node ../../tools/amqp-broker.mjs run -- dotnet test --project tests/Bead.Transport.Amqp.Tests',
      {
        suite: true,
      }
    ),
    step(
      DOTNET,
      'node ../../tools/amqp-broker.mjs run -- dotnet test --project tests/Bead.Interop.Tests --filter-trait "transport=AMQP"',
      { suite: true }
    ),
  ],
  builder: [
    step('builder', 'yarn check', {
      note: "BEADC_PROTOC and BEADC_PROTOC_GEN_BUFFA in the environment, as builder/README.md's tools fetch them",
    }),
    step('builder', 'yarn test', { suite: true }),
    step('builder', 'node src/cli.ts check ../spec/interop-blueprint.json'),
    step('builder', 'node src/cli.ts blueprint --check ../spec/interop-blueprint.json'),
    step('.', 'node builder/src/cli.ts generate --check'),
    step(`${TYPESCRIPT}/demo`, 'node ../../../builder/src/cli.ts generate --check'),
    step('.', 'node tools/check-validations.mjs'),
    step('.', 'node tools/check-transcoding.mjs'),
  ],
  examples: [
    step('.', 'node tools/check-examples.mjs'),
    step('examples/hello', 'node ../../builder/src/cli.ts generate --check'),
    step('examples/hello/typescript', 'yarn install --immutable'),
    step('examples/hello/typescript', 'yarn check'),
    step('examples/hello/typescript', 'yarn build'),
    step('examples/hello/dotnet', 'dotnet format Hello.csproj --verify-no-changes --exclude gen'),
    step('examples/hello/dotnet', 'dotnet build'),
    step('examples/hello/rust', 'cargo fmt --check'),
    step('examples/hello/rust', 'cargo clippy --all-targets --locked'),
    step('examples/hello/rust', 'cargo build --locked'),
    step('.', 'node examples/hello/pairs.mjs', {
      suite: true,
      note: "the external builds, beside protoc's own generators, are the examples job's",
    }),
  ],
  'protobuf-conformance': [
    ...['typescript', 'csharp', 'rust', 'differential'].map((side, index) => {
      return step('.', `node tools/protobuf-conformance.mjs ${side}`, {
        suite: true,
        note: index === 0 ? 'on Linux or macOS, where the runner runs' : undefined,
      });
    }),
    step(
      `${DOTNET}/tools/Bead.ProtobufConformance`,
      'dotnet format Bead.ProtobufConformance.csproj --verify-no-changes --exclude Generated'
    ),
    step(`${RUST}/tools/protobuf-conformance`, 'cargo fmt --check'),
  ],
  'protovalidate-differential': [
    ...['oracle', 'typescript', 'csharp', 'rust'].map((side) => {
      return step('.', `node tools/protovalidate-differential.mjs ${side}`, { suite: true });
    }),
    step(
      `${DOTNET}/tools/Bead.ProtovalidateDifferential`,
      'dotnet format Bead.ProtovalidateDifferential.csproj --verify-no-changes --exclude Generated'
    ),
    step(`${RUST}/tools/protovalidate-differential`, 'cargo fmt --check'),
  ],
  site: [
    step('site', 'yarn install --immutable'),
    step('site', 'node layout.mjs', { suite: true }),
  ],
});

// the C# test projects a change touches, where those alone reach the .NET job; undefined where the
// solution is owed whole
const DOTNET_PROJECT = /^implementations\/dotnet\/tests\/([^/]+)\//;
export const dotnetProjectsOf = (paths) => {
  const reaching = paths.filter((path) => {
    return reachOf(path).includes('dotnet');
  });
  const projects = new Set();
  for (const path of reaching) {
    const match = DOTNET_PROJECT.exec(path);
    if (!match || match[1] === 'Shared') {
      return undefined;
    }
    projects.add(match[1]);
  }
  return projects.size > 0 ? [...projects].sort() : undefined;
};

const dotnetNarrowed = (projects) => {
  const steps = projects.flatMap((project) => {
    return [
      step(
        DOTNET,
        `dotnet format tests/${project}/${project}.csproj --verify-no-changes ${DOTNET_EXCLUDED}`
      ),
      step(DOTNET, `dotnet test --project tests/${project}`, { suite: true }),
    ];
  });
  if (projects.includes('Bead.Interop.Tests')) {
    steps.push(
      step(TYPESCRIPT, 'yarn test:interop --grep-invert "the Rust server"', { suite: true })
    );
  }
  return steps;
};

// the commands of the areas, the commits job's first, then in ci.yml's order: `all` gives each whole; otherwise a command whose
// `unless` every path reaching its area matches is left out, and the C# side narrows to the test
// projects that changed
export const stepsOf = (areas, paths, options = {}) => {
  const steps = [];
  const first = areas.filter((area) => {
    return ALWAYS.includes(area);
  });
  const rest = areas.filter((area) => {
    return !ALWAYS.includes(area);
  });
  for (const area of [...first, ...rest]) {
    const reaching = paths.filter((path) => {
      return reachOf(path).includes(area);
    });
    const projects = options.all ? undefined : dotnetProjectsOf(paths);
    const own = area === 'dotnet' && projects ? dotnetNarrowed(projects) : LOCAL[area];
    for (const each of own) {
      if (
        !options.all &&
        each.unless &&
        reaching.length > 0 &&
        reaching.every((path) => {
          return each.unless.test(path);
        })
      ) {
        continue;
      }
      if (options.gates && each.suite) {
        continue;
      }
      steps.push({ ...each, area });
    }
  }
  return steps;
};

// the steps as lines both bash and PowerShell run from the root, each area under its heading
const scriptOf = (steps, base, head = 'HEAD') => {
  const lines = [];
  let area;
  let folder = '.';
  const back = () => {
    if (folder !== '.') {
      lines.push({
        line: `cd ${folder
          .split('/')
          .map(() => {
            return '..';
          })
          .join('/')}`,
      });
      folder = '.';
    }
  };
  for (const each of steps) {
    if (each.area !== area) {
      back();
      lines.push({ line: `# ${each.area}` });
      area = each.area;
    }
    if (each.folder !== folder) {
      back();
      if (each.folder !== '.') {
        lines.push({ line: `cd ${each.folder}` });
        folder = each.folder;
      }
    }
    if (each.note) {
      lines.push({ line: `# ${each.note}` });
    }
    lines.push({
      line: each.command.replace('{base}', base).replace('{head}', head),
      folder: each.folder,
    });
  }
  back();
  return lines;
};

export const linesOf = (steps, base, head = 'HEAD') => {
  return scriptOf(steps, base, head).map(({ line }) => {
    return line;
  });
};

// * bash on Windows and sh on Linux read the commands' quotes and globs alike; cmd.exe does not.
// Every command starts in its own folder under the root and inherits the caller's environment.
// The spawn function is replaceable in tests, as flow.mjs replaces gh.
export const runSteps = (steps, options = {}) => {
  const {
    base = 'origin/develop',
    head = 'HEAD',
    spawn = spawnSync,
    log = console.log,
    error = console.error,
  } = options;
  for (const { line, folder } of scriptOf(steps, base, head)) {
    log(line);
    if (folder === undefined) {
      continue;
    }
    const result = spawn(process.platform === 'win32' ? 'bash' : '/bin/sh', ['-c', line], {
      cwd: resolve(ROOT, folder),
      env: process.env,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      const code = result.status ?? 1;
      const reason = result.error?.message ?? result.signal ?? `exit ${code}`;
      error(`ci-scope: ${line} failed (${reason})`);
      return code;
    }
  }
  return 0;
};

// ── Main ───────────────────────────────────────────────────────────────────────

const USAGE = `usage: node tools/ci-scope.mjs [--local | --run | --paths] [--gates] [--all | <base> [<head>]]
       node tools/ci-scope.mjs --github | --verdict
--local prints the commands; --run prints and runs them, stopping with the first failure's exit code.
Run everything (--all) for a release and a merge into develop.`;

const github = () => {
  const mode = modeOf(process.env);
  let areas = AREAS;
  let paths = [];
  if (mode.base) {
    try {
      paths = changedOf(mode.base, 'HEAD');
      areas = areasOf(paths);
      console.log(`against the merge base with ${mode.base}: ${paths.length} paths changed`);
    } catch (error) {
      console.log(
        `every area: the merge base with ${mode.base} cannot be read (${error.message.trim()})`
      );
    }
  } else {
    console.log(`every area: ${mode.all}`);
  }
  for (const path of paths) {
    console.log(`  ${path}: ${reachOf(path).join(' ')}`);
  }
  console.log(`areas: ${areas.join(' ')}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `areas=${JSON.stringify(areas)}\n`);
  }
};

const verdict = () => {
  const needs = JSON.parse(process.env.NEEDS || '{}');
  const areas = JSON.parse(process.env.AREAS || '[]');
  console.log(`areas: ${areas.join(' ')}`);
  for (const [job, { result }] of Object.entries(needs)) {
    console.log(`  ${job}: ${result}`);
  }
  const problems = verdictOf(needs, areas);
  for (const problem of problems) {
    console.error(`::error title=CI ok::${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
};

if (import.meta.main) {
  const given = process.argv.slice(2);
  const flags = new Set(
    given.filter((arg) => {
      return arg.startsWith('--');
    })
  );
  const positional = given.filter((arg) => {
    return !arg.startsWith('--');
  });
  const known = new Set([
    '--local',
    '--run',
    '--gates',
    '--all',
    '--paths',
    '--github',
    '--verdict',
    '--help',
  ]);
  const unknown = [...flags].filter((flag) => {
    return !known.has(flag);
  });
  if (unknown.length > 0 || positional.length > 2 || flags.has('--help')) {
    console.error(USAGE);
    process.exit(flags.has('--help') && unknown.length === 0 ? 0 : 1);
  }
  if (flags.has('--github')) {
    github();
  } else if (flags.has('--verdict')) {
    verdict();
  } else {
    const [base = 'origin/develop', head] = positional;
    const all = flags.has('--all');
    const paths = all ? [] : changedOf(base, head);
    const areas = all ? AREAS : areasOf(paths);
    if (flags.has('--paths')) {
      for (const path of paths) {
        console.log(`${path}\t${reachOf(path).join(' ')}`);
      }
    } else if (flags.has('--local') || flags.has('--run')) {
      const steps = stepsOf(areas, paths, { all, gates: flags.has('--gates') });
      if (flags.has('--run')) {
        process.exitCode = runSteps(steps, { base, head });
      } else {
        console.log(linesOf(steps, base, head).join('\n'));
      }
    } else {
      console.log(areas.join('\n'));
    }
  }
}
