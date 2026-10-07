import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  localDay,
  prepare,
  resolveMove,
  tag,
  versionOf,
  withChangelogRelease,
  withLockRanges,
  withPackageVersion,
  withPropsVersion,
  withRepeatedVersion,
  withStatedVersion,
} from '../release.mjs';

const SCRIPT = fileURLToPath(new URL('../release.mjs', import.meta.url));
const REPOSITORY = 'https://github.com/o/r';

const json = (value) => {
  return `${JSON.stringify(value, null, 2)}\n`;
};

const changelog = (unreleased) => {
  return [
    '# Changelog\n\n## [Unreleased]\n\n',
    unreleased.length > 0
      ? `### Added\n\n${unreleased.map((entry) => `- ${entry}\n`).join('')}\n`
      : '',
    '## [0.1.0] - 2026-10-02\n\n### Added\n\n- The first.\n\n',
    `[Unreleased]: ${REPOSITORY}/compare/v0.1.0...develop\n`,
    `[0.1.0]: ${REPOSITORY}/releases/tag/v0.1.0\n`,
  ].join('');
};

// ── Texts ─────────────────────────────────────────────────────────────────────

describe('texts', () => {
  test("the package's own version moves, and a nested one as well is refused", () => {
    const plain =
      '{\n  "name": "x",\n  "version": "0.1.0",\n  "devDependencies": {\n    "y": "0.1.0"\n  }\n}\n';
    assert.equal(
      withPackageVersion(plain, '0.2.0'),
      plain.replace('"version": "0.1.0"', '"version": "0.2.0"')
    );
    const nested = '{\n  "version": "0.1.0",\n  "y": {\n  "version": "0.1.0" }\n}\n';
    assert.throws(() => withPackageVersion(nested, '0.2.0'), /2 matches/);
  });

  test("the props, a document's line and interop-service.json's key each move alone", () => {
    assert.equal(
      withPropsVersion('<LangVersion>latest</LangVersion><Version>0.1.0</Version>', '0.2.0'),
      '<LangVersion>latest</LangVersion><Version>0.2.0</Version>'
    );
    assert.equal(
      withStatedVersion('x\n**Version: 0.1.0**, of layout\nsee **Version: 0.1.0**\n', '0.2.0'),
      'x\n**Version: 0.2.0**, of layout\nsee **Version: 0.1.0**\n'
    );
    assert.equal(
      withRepeatedVersion('{ "specVersion": "0.1.0", "id": "0.1.0" }', {
        key: 'specVersion',
        version: '0.2.0',
      }),
      '{ "specVersion": "0.2.0", "id": "0.1.0" }'
    );
    assert.throws(() => withStatedVersion('no line\n', '0.2.0'), /0 matches/);
  });

  test("the lock files' project ranges move, all of them: 12 in 5 files", () => {
    const lock = (count) => {
      const ranges = Array.from({ length: count }, (_, index) => {
        return `    "Bead.P${index}": "[0.1.0, )"`;
      });
      return `{\n${ranges.join(',\n')},\n    "Other": "[0.1.0, )"\n}\n`;
    };
    const moved = [3, 1, 3, 3, 2].map((count) => withLockRanges(lock(count), '0.2.0'));
    assert.equal(
      moved.reduce((sum, { count }) => sum + count, 0),
      12
    );
    assert.equal(
      moved[0].text,
      lock(3)
        .replaceAll('"[0.1.0, )"', '"[0.2.0, )"')
        .replace('"Other": "[0.2.0, )"', '"Other": "[0.1.0, )"')
    );
  });

  test('[Unreleased] is dated under a new empty one, its links moved and [0.1.0] kept', () => {
    const { text, first } = withChangelogRelease(changelog(['A rule.']), {
      version: '0.2.0',
      last: '0.1.0',
      date: '2026-10-07',
      branch: 'release/0.2.0',
    });
    assert.equal(first, true);
    assert.equal(
      text,
      [
        '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-07\n\n### Added\n\n- A rule.\n\n',
        '## [0.1.0] - 2026-10-02\n\n### Added\n\n- The first.\n\n',
        `[Unreleased]: ${REPOSITORY}/compare/v0.2.0...develop\n`,
        `[0.2.0]: ${REPOSITORY}/compare/v0.1.0...v0.2.0\n`,
        `[0.1.0]: ${REPOSITORY}/releases/tag/v0.1.0\n`,
      ].join('')
    );
    // run again, its own section is re-dated and nothing else moves
    const again = withChangelogRelease(text, {
      version: '0.2.0',
      last: '0.1.0',
      date: '2026-10-09',
      branch: 'release/0.2.0',
    });
    assert.deepEqual(again, { text: text.replace('2026-10-07', '2026-10-09'), first: false });
    assert.throws(() => {
      withChangelogRelease(text, {
        version: '0.1.0',
        last: null,
        date: '2026-10-07',
        branch: 'hotfix/0.1.0',
      });
    }, /\[0\.1\.0\] stands elsewhere than right below \[Unreleased\]/);
  });
});

// ── Moves ─────────────────────────────────────────────────────────────────────

describe('moves', () => {
  const SPEC = { id: 'spec', path: 'spec/spec.md' };
  const facts = (options = {}) => {
    return {
      last: { name: 'v0.4.0', version: '0.1.3' },
      changed: ['spec/spec.md'],
      added: [],
      ...options,
    };
  };

  test('a level from the last release, same, or a version whole', () => {
    const label = 'spec/spec.md';
    assert.equal(resolveMove('patch', { last: '0.1.3', label }), '0.1.4');
    assert.equal(resolveMove('minor', { last: '0.1.3', label }), '0.2.0');
    assert.equal(resolveMove('major', { last: '0.1.3', label }), '1.0.0');
    assert.equal(resolveMove('same', { last: '0.1.3', label }), '0.1.3');
    assert.equal(resolveMove('0.4.0', { last: '0.1.3', label }), '0.4.0');
  });

  test('a level for a document never released is refused, and so is a word that is no move', () => {
    assert.throws(() => {
      versionOf(SPEC, { stated: '0.1.0', move: 'minor', facts: facts({ last: null }) });
    }, /never released, so minor has nothing to move from: give x\.y\.z/);
    assert.equal(
      versionOf(SPEC, { stated: '0.1.0', move: undefined, facts: facts({ last: null }) }),
      '0.1.0'
    );
    assert.throws(
      () => resolveMove('sideways', { last: '0.1.3', label: 's' }),
      /sideways is no move/
    );
  });

  test('a changed document with no move is refused, and a patch under the floor too', () => {
    assert.throws(() => {
      versionOf(SPEC, { stated: '0.1.3', move: undefined, facts: facts() });
    }, /changed since v0\.4\.0 \(spec\/spec\.md\): give --spec minor when an implementation must change/);
    const added = facts({ added: [{ path: 'spec/vectors.json', what: 'key "jwt"' }] });
    assert.throws(() => {
      versionOf(SPEC, { stated: '0.1.3', move: 'patch', facts: added });
    }, /0\.1\.4, a patch, where spec\/vectors\.json's key "jwt" was added since v0\.4\.0: --spec minor at least/);
    assert.equal(versionOf(SPEC, { stated: '0.1.3', move: 'minor', facts: added }), '0.2.0');
  });

  test('a successor already stated is kept with no flag; an unchanged document keeps its version', () => {
    assert.equal(versionOf(SPEC, { stated: '0.2.0', move: undefined, facts: facts() }), '0.2.0');
    const unchanged = facts({ changed: [] });
    assert.equal(versionOf(SPEC, { stated: '0.1.3', move: undefined, facts: unchanged }), '0.1.3');
    assert.throws(() => {
      versionOf(SPEC, { stated: '0.1.3', move: 'patch', facts: unchanged });
    }, /none of its files changed since v0\.4\.0, so it keeps 0\.1\.3, and --spec patch is refused/);
  });
});

// ── Fixture ───────────────────────────────────────────────────────────────────

const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PROPS =
  '<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n';

// a lock file whose two projects take a third
const LOCK = json({
  version: 2,
  dependencies: {
    'net10.0': {
      'bead.core': { type: 'Project' },
      'bead.http': { type: 'Project', dependencies: { 'Bead.Core': '[0.1.0, )' } },
      'bead.sockets': { type: 'Project', dependencies: { 'Bead.Core': '[0.1.0, )' } },
    },
  },
});

const TREE = {
  'implementations/typescript/package.json': json({ name: 'x', version: '0.1.0', private: true }),
  'implementations/dotnet/Directory.Build.props': PROPS,
  'implementations/dotnet/src/Http/packages.lock.json': LOCK,
  'implementations/dotnet/src/Core/packages.lock.json': json({ version: 2, dependencies: {} }),
  'spec/spec.md': '# Spec\n\n**Version: 0.1.0**, of layout 0xA1.\n',
  'spec/vectors.json': json({ specVersion: '0.1.0', headers: [] }),
  'spec/interop-service.json': json({ specVersion: '0.1.0', id: 'interop' }),
  'spec/interop-blueprint.json':
    '{\n  "format": "bead-blueprint/1",\n  "requires": [],\n  "specVersion": "0.1.0"\n}\n',
  'spec/debugging.md': '# Companion\n\n**Version: 0.1.0**.\n',
  'spec/metrics.json': json({ debuggingVersion: '0.1.0', expositions: [] }),
  'spec/generators/make_vectors.py': '',
  'spec/generators/make_metrics.py': '',
  'spec/generators/spec_version.py': '',
  'CHANGELOG.md': changelog([]),
  '.gitignore': 'node_modules/\n',
};

const git = (root, ...args) => {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
};

const write = (root, tree) => {
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

const read = (root, path) => {
  return readFileSync(join(root, path), 'utf8');
};

// v0.1.0 released and its documents tagged; on develop, a rule the spec gains; then the branch
// release/0.2.0, checked out
let template;
const releasing = () => {
  if (template === undefined) {
    template = mkdtempSync(join(tmpdir(), 'bead-release-'));
    roots.push(template);
    git(template, 'init', '-q', '-b', 'main');
    for (const [key, value] of Object.entries({
      'user.name': 'Test',
      'user.email': 'test@example.com',
      'commit.gpgsign': 'false',
      'tag.gpgsign': 'false',
      'core.autocrlf': 'false',
    })) {
      git(template, 'config', key, value);
    }
    write(template, TREE);
    git(template, 'add', '-A');
    git(template, 'commit', '-qm', 'feat: one');
    for (const name of ['v0.1.0', 'spec-v0.1.0', 'debugging-v0.1.0']) {
      git(template, 'tag', '-a', name, '-m', name);
    }
    git(template, 'checkout', '-q', '-b', 'develop');
    write(template, {
      'spec/spec.md': `${TREE['spec/spec.md']}A rule.\n`,
      'CHANGELOG.md': changelog(['A rule.']),
    });
    git(template, 'commit', '-qam', 'feat: two');
    git(template, 'checkout', '-q', '-b', 'release/0.2.0');
  }
  const root = mkdtempSync(join(tmpdir(), 'bead-release-'));
  roots.push(root);
  cpSync(template, root, { recursive: true });
  return root;
};

// the commands prepare runs, recorded; each generator writes its file's version from its
// document's line, as spec/generators' do; a command whose line holds one of `absent` fails
const standIn = (root, { absent = [] } = {}) => {
  const ran = [];
  const run = (command, args) => {
    const line = [command === process.execPath ? 'node' : command, ...args].join(' ');
    ran.push(line);
    if (absent.some((what) => line.includes(what))) {
      throw new Error(`${line}: exit 1`);
    }
    const generator = /^spec\/generators\/make_(\w+)\.py$/.exec(args[0] ?? '');
    if (generator !== null) {
      const path = `spec/${generator[1]}.json`;
      const file = JSON.parse(read(root, path));
      for (const [key, document] of [
        ['specVersion', 'spec/spec.md'],
        ['debuggingVersion', 'spec/debugging.md'],
      ]) {
        if (key in file) {
          file[key] = /^\*\*Version: (\S+)\*\*/m.exec(read(root, document))[1];
        }
      }
      writeFileSync(join(root, path), json(file));
    }
  };
  return { ran, run };
};

// prepare, with a stand-in for its commands and its lines recorded
const prepared = (root, options = {}) => {
  const { ran, run } = standIn(root, options);
  const logged = [];
  const plan = prepare(root, {
    date: '2026-10-07',
    python: 'py',
    run,
    log: (line) => {
      logged.push(line);
    },
    ...options,
  });
  return { plan, ran, logged };
};

// git flow's finish, as AVH does it: the branch into main, its tag, the tag back into develop
const finish = (root) => {
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', "Merge branch 'release/0.2.0'", 'release/0.2.0');
  git(root, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
  git(root, 'checkout', '-q', 'develop');
  git(root, 'merge', '-q', '--no-ff', '-m', "Merge tag 'v0.2.0' into develop", 'v0.2.0');
};

// ── Prepare ───────────────────────────────────────────────────────────────────

describe('prepare', () => {
  test('refused off a release branch, and for a changed document with no move', () => {
    const root = releasing();
    assert.throws(
      () => prepared(root),
      /spec\/spec\.md changed since v0\.1\.0 \(spec\/spec\.md\): give --spec minor/
    );
    assert.throws(
      () => prepared(root, { version: '0.3.0' }),
      /0\.3\.0: the branch release\/0\.2\.0 names 0\.2\.0/
    );
    git(root, 'checkout', '-q', 'develop');
    assert.throws(
      () => prepared(root),
      /develop: a release is prepared on a release\/\* or hotfix\/\* branch/
    );
  });

  test('it writes every version, runs each generator, the gate, then the checks it has tools for', () => {
    const root = releasing();
    // ! a Windows tool writes CRLF in the working tree: the texts are read with LF
    write(root, {
      'CHANGELOG.md': read(root, 'CHANGELOG.md').replaceAll('\n', '\r\n'),
      'implementations/dotnet/src/Http/packages.lock.json': LOCK.replaceAll('\n', '\r\n'),
      'implementations/typescript/node_modules/oxfmt/bin/oxfmt': '',
    });
    const { plan, ran, logged } = prepared(root, { moves: { spec: 'minor' } });
    assert.deepEqual(plan.documents, { spec: '0.2.0', debugging: '0.1.0' });
    assert.deepEqual(plan.written, [
      'implementations/typescript/package.json',
      'implementations/dotnet/Directory.Build.props',
      'spec/spec.md',
      'spec/interop-blueprint.json',
      'spec/interop-service.json',
      'spec/vectors.json',
      'implementations/dotnet/src/Http/packages.lock.json',
      'CHANGELOG.md',
    ]);
    assert.deepEqual(ran, [
      'py --version',
      'py spec/generators/make_metrics.py',
      'py spec/generators/make_vectors.py',
      'py -c import jsonschema',
      'py spec/check.py',
      'node implementations/typescript/node_modules/oxfmt/bin/oxfmt -c implementations/typescript/.oxfmtrc.json --check CHANGELOG.md spec/spec.md spec/debugging.md spec/interop-service.json',
    ]);
    assert.equal(
      read(root, 'implementations/dotnet/src/Http/packages.lock.json'),
      LOCK.replaceAll('[0.1.0, )', '[0.2.0, )')
    );
    assert.match(
      read(root, 'CHANGELOG.md'),
      /^## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-07\n\n### Added\n\n- A rule\.\n/m
    );
    assert.match(read(root, 'spec/vectors.json'), /"specVersion": "0\.2\.0"/);
    // the blueprint's form is its own, which the move keeps: its key alone changes
    assert.equal(
      read(root, 'spec/interop-blueprint.json'),
      TREE['spec/interop-blueprint.json'].replace('"0.1.0"', '"0.2.0"')
    );
    assert.deepEqual(logged, [
      'release 0.2.0: spec 0.2.0, debugging 0.1.0 (2 project ranges in 1 lock files)',
      "owed by hand: the [0.2.0] line on the spec's 0.2.0 (spec-v0.2.0)",
      'next: git add -A && git commit -m "chore(release): 0.2.0"',
      '      git flow release publish 0.2.0, and wait for ci-ok',
      '      node tools/release.mjs prepare, again right before the finish',
    ]);
  });

  test('a check whose tool is absent is named, with the CI job that holds it', () => {
    const root = releasing();
    const { ran, logged } = prepared(root, {
      moves: { spec: 'minor' },
      absent: ['import jsonschema'],
    });
    assert.ok(!ran.includes('py spec/check.py'));
    assert.deepEqual(logged.slice(0, 2), [
      "skipped: spec/check.py (no jsonschema for py); CI's spec job holds it",
      "skipped: the root's format check (no implementations/typescript/node_modules/oxfmt/bin/oxfmt); CI's typescript job holds it",
    ]);
    assert.throws(
      () => prepared(releasing(), { moves: { spec: 'minor' }, absent: ['--version'] }),
      /py: no Python to run the generators/
    );
  });

  test('run again, it writes nothing but the date, and refuses a line under [Unreleased]', () => {
    const root = releasing();
    prepared(root, { moves: { spec: 'minor' } });
    git(root, 'commit', '-qam', 'chore(release): 0.2.0');
    assert.deepEqual(prepared(root).plan.written, []);
    const again = prepared(root, { date: '2026-10-09' });
    assert.deepEqual(again.plan.written, ['CHANGELOG.md']);
    assert.match(again.logged.at(-2), /wait for ci-ok on release\/0\.2\.0/);
    write(root, {
      'CHANGELOG.md': read(root, 'CHANGELOG.md').replace(
        '## [Unreleased]\n',
        '## [Unreleased]\n\n- A fix.\n'
      ),
    });
    assert.throws(
      () => prepared(root),
      /CHANGELOG\.md: \[Unreleased\] holds 1 entry: on release\/0\.2\.0, a line goes under \[0\.2\.0\]/
    );
  });

  test('no project range in any lock file is refused, before anything is written', () => {
    const root = releasing();
    write(root, { 'implementations/dotnet/src/Http/packages.lock.json': json({ version: 2 }) });
    assert.throws(
      () => prepared(root, { moves: { spec: 'minor' } }),
      /no project range, "Bead\.<Name>": "\[x\.y\.z, \)", in the 2 lock files/
    );
    assert.match(read(root, 'implementations/typescript/package.json'), /"version": "0\.1\.0"/);
  });

  test("its default date is the local day, not UTC's", () => {
    const day = (timeZone) => {
      const script = `import { localDay } from ${JSON.stringify(new URL('../release.mjs', import.meta.url).href)};
console.log(localDay(new Date('2026-10-08T01:30:00Z')));`;
      return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TZ: timeZone },
      }).trim();
    };
    // 21:30 in Toronto on the 7th is 01:30 UTC on the 8th
    assert.equal(day('America/Toronto'), '2026-10-07');
    assert.equal(day('UTC'), '2026-10-08');
    assert.match(localDay(new Date()), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('--dry-run prints the plan and writes nothing', () => {
    const root = releasing();
    const { plan, ran, logged } = prepared(root, { moves: { spec: 'minor' }, dryRun: true });
    assert.deepEqual(plan.written, []);
    assert.deepEqual(ran, []);
    assert.deepEqual(logged, ['release 0.2.0: spec 0.2.0, debugging 0.1.0']);
    assert.equal(git(root, 'status', '--porcelain'), '');
  });
});

// ── Tag ───────────────────────────────────────────────────────────────────────

describe('tag', () => {
  // the release 0.2.0 prepared, committed and finished: develop checked out
  const finished = () => {
    const root = releasing();
    prepared(root, { moves: { spec: 'minor' } });
    git(root, 'commit', '-qam', 'chore(release): 0.2.0');
    finish(root);
    return root;
  };

  test('its push deletes the release branch origin still holds, kept through the finish', () => {
    const root = finished();
    const logged = [];
    git(root, 'update-ref', 'refs/remotes/origin/release/0.2.0', 'v0.2.0^{commit}');
    tag(root, {
      log: (line) => {
        logged.push(line);
      },
    });
    assert.equal(
      logged.at(-1),
      'push: git push --atomic origin main develop v0.2.0 spec-v0.2.0 :release/0.2.0'
    );
  });

  test("it sets spec-v0.2.0 at v0.2.0's commit, peeled, then nothing a second time", () => {
    const root = finished();
    const logged = [];
    const log = (line) => {
      logged.push(line);
    };
    assert.deepEqual(tag(root, { log }).made, ['spec-v0.2.0']);
    assert.equal(
      git(root, 'for-each-ref', '--format=%(*objecttype) %(*objectname)', 'refs/tags/spec-v0.2.0'),
      `commit ${git(root, 'rev-parse', 'v0.2.0^{commit}')}`
    );
    assert.deepEqual(tag(root, { version: '0.2.0', log }).made, []);
    assert.deepEqual(logged, [
      'tagged spec-v0.2.0 at v0.2.0',
      'push: git push --atomic origin main develop v0.2.0 spec-v0.2.0',
      "no document's tag to set at v0.2.0",
      'push: git push --atomic origin main develop v0.2.0 spec-v0.2.0',
    ]);
  });

  test('it takes the newest v*, refused when main does not reach it, or its tree states another product', () => {
    const root = finished();
    git(root, 'tag', '-a', 'v0.3.0', '-m', 'v0.3.0', 'develop');
    assert.throws(
      () => tag(root, { log: () => {} }),
      /v0\.3\.0 is not on main: finish the release first/
    );
    git(root, 'tag', '-d', 'v0.3.0');
    git(root, 'tag', '-a', 'v0.2.5', '-m', 'v0.2.5', 'main');
    assert.throws(
      () => tag(root, { log: () => {} }),
      /v0\.2\.5: its tree states the product 0\.2\.0, where 0\.2\.5 is due/
    );
    assert.equal(git(root, 'tag', '--list', 'spec-v*'), 'spec-v0.1.0');
  });

  test('its gate on develop reports a line filed under the released version', () => {
    const root = finished();
    write(root, {
      'CHANGELOG.md': read(root, 'CHANGELOG.md').replace(
        '- A rule.\n',
        '- A rule.\n- A feature 0.2.0 does not ship.\n'
      ),
    });
    git(root, 'commit', '-qam', 'feat: three');
    assert.throws(
      () => tag(root, { log: () => {} }),
      /develop: CHANGELOG\.md: \[0\.2\.0\] is not the section v0\.2\.0 shipped, from "- A feature 0\.2\.0 does not ship\."/
    );
  });
});

// ── The command line ──────────────────────────────────────────────────────────

describe('the command line', () => {
  test('it exits 0, 1 on a refusal, and 2 on a usage error', () => {
    const root = releasing();
    const run = (...args) => {
      return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
    };
    const planned = run('prepare', '--spec', 'minor', '--dry-run');
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.stdout, 'release 0.2.0: spec 0.2.0, debugging 0.1.0\n');
    const refused = run('prepare', '--dry-run');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^release: spec\/spec\.md changed since v0\.1\.0/);
    for (const args of [
      [],
      ['publish'],
      ['prepare', '--bogus'],
      ['tag', '--spec', 'minor'],
      ['tag', '0.2.0', 'x'],
    ]) {
      assert.equal(run(...args).status, 2, args.join(' '));
    }
  });
});
