import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILDER,
  MODES,
  PACKAGE,
  PROPS,
  checkVersions,
  documentOf,
  judge,
  modeOf,
  readChangelog,
  readText,
  successorsOf,
  unversioned,
} from '../check-versions.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const REPOSITORY = 'https://github.com/o/r';
const FIRST = ['0.1.0', '2026-10-02', ['The first.']];

const json = (value) => {
  return `${JSON.stringify(value, null, 2)}\n`;
};

// a CHANGELOG: the entries of [Unreleased], then each version with its date and its entries,
// newest first, and their links as Keep a Changelog writes them
const changelog = ({ unreleased = [], versions = [FIRST] } = {}) => {
  const section = (heading, entries) => {
    const added = entries.map((entry) => `- ${entry}\n`).join('');
    return `## ${heading}\n\n${entries.length > 0 ? `### Added\n\n${added}\n` : ''}`;
  };
  const links = versions.map(([version], index) => {
    const before = versions[index + 1]?.[0];
    return before === undefined
      ? `[${version}]: ${REPOSITORY}/releases/tag/v${version}\n`
      : `[${version}]: ${REPOSITORY}/compare/v${before}...v${version}\n`;
  });
  return [
    '# Changelog\n\n',
    section('[Unreleased]', unreleased),
    ...versions.map(([version, date, entries]) => section(`[${version}] - ${date}`, entries)),
    `[Unreleased]: ${REPOSITORY}/compare/v${versions[0][0]}...develop\n`,
    ...links,
  ].join('');
};

// the CHANGELOG of the release 0.2.0, dated and linked
const RELEASED = changelog({ versions: [['0.2.0', '2026-10-07', ['A rule.']], FIRST] });

// a lock file of the C# side: two projects that take a third, each at a range
const lock = (range) => {
  const project = { type: 'Project', dependencies: { 'Bead.Core': `[${range}, )` } };
  return json({
    version: 2,
    dependencies: {
      'net10.0': {
        'bead.core': { type: 'Project' },
        'bead.http': project,
        'bead.sockets': project,
        xunit: { type: 'Direct', requested: '[2.0.0, )', resolved: '2.0.0' },
      },
    },
  });
};

// the files the gate reads, each axis at its version
//   product     the package's, the props' and the lock file's ranges
//   spec        spec.md's line, and vectors.json's specVersion
//   debugging   debugging.md's line, and metrics.json's debuggingVersion
//   rule        a line spec.md gains
//   groups      the top-level keys of vectors.json, besides its version
//   properties  the properties of vectors.json's schema, besides its version
//   changes     the CHANGELOG
const files = (options = {}) => {
  const {
    product = '0.1.0',
    spec = '0.1.0',
    debugging = '0.1.0',
    rule = '',
    groups = ['headers'],
    properties = ['headers'],
    changes = changelog(),
  } = options;
  const entries = (names) => {
    return Object.fromEntries(names.map((name) => [name, name === 'specVersion' ? {} : []]));
  };
  return {
    [PACKAGE]: json({ name: 'x', version: product }),
    [PROPS]: `<Project>\n  <PropertyGroup>\n    <Version>${product}</Version>\n  </PropertyGroup>\n</Project>\n`,
    'implementations/dotnet/src/Http/packages.lock.json': lock(product),
    'spec/spec.md': `# Spec\n\n**Version: ${spec}**, of layout 0xA1.\n${rule}`,
    'spec/vectors.json': json({ specVersion: spec, ...entries(groups) }),
    'spec/schemas/vectors.schema.json': json({
      type: 'object',
      properties: entries(['specVersion', ...properties]),
    }),
    'spec/debugging.md': `# Companion\n\n**Version: ${debugging}**.\n`,
    'spec/metrics.json': json({ debuggingVersion: debugging, expositions: [] }),
    'spec/schemas/metrics.schema.json': json({
      type: 'object',
      properties: { debuggingVersion: {}, expositions: {} },
    }),
    'spec/schemas/common.schema.json': json({ $defs: { name: { type: 'string' } } }),
    'spec/generators/make_vectors.py': '# writes vectors.json\n',
    'CHANGELOG.md': changes,
  };
};

const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// a repository under the system's temporary folder, a copy of a template when one is given
const repository = (template) => {
  const root = mkdtempSync(join(tmpdir(), 'bead-versions-'));
  roots.push(root);
  const git = (...args) => {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  };
  const write = (tree) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  const commit = (tree, message) => {
    write(tree);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  if (template === undefined) {
    git('init', '-q', '-b', 'main');
    for (const [key, value] of Object.entries({
      'user.name': 'Test',
      'user.email': 'test@example.com',
      'commit.gpgsign': 'false',
      'tag.gpgsign': 'false',
      'core.autocrlf': 'false',
    })) {
      git('config', key, value);
    }
  } else {
    cpSync(template, root, { recursive: true });
  }
  const problems = (ref) => {
    return checkVersions(root, { ref }).problems;
  };
  // git flow's finish, as AVH does it: the branch into main, its tag, then the tag back into
  // develop by default, or the branch, as Driessen's text and `finish -b` do
  const finish = (branch, { backMerge = 'tag' } = {}) => {
    const version = branch.slice(branch.indexOf('/') + 1);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', `Merge branch '${branch}'`, branch);
    git('tag', '-a', `v${version}`, '-m', `v${version}`);
    git('checkout', '-q', 'develop');
    const merged = backMerge === 'tag' ? `v${version}` : branch;
    git('merge', '-q', '--no-ff', '-m', `Merge ${merged} into develop`, merged);
  };
  // a document's tag, at a commit
  const tagAt = (name, commit) => {
    git('tag', '-a', name, '-m', name, commit);
  };
  return { root, git, write, commit, problems, finish, tagAt };
};

// a template made once, and copied for each test
const once = (make) => {
  let root;
  return () => {
    root ??= make();
    return root;
  };
};

// v0.1.0 released, each document stating its version and tagged at it; develop checked out
const released = once(() => {
  const { root, git, commit, tagAt } = repository();
  commit(files(), 'feat: one');
  git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  tagAt('spec-v0.1.0', 'v0.1.0^{commit}');
  tagAt('debugging-v0.1.0', 'v0.1.0^{commit}');
  git('checkout', '-q', '-b', 'develop');
  return root;
});

// v0.1.0 as this repository's: its spec states no version, its file none, and the companion is in
// no release; develop checked out, where the spec states 0.1.0 and has the companion beside it
const unstated = once(() => {
  const { root, git, commit } = repository();
  commit(
    {
      ...files(),
      'spec/spec.md': '# Spec\n\nOf layout 0xA1.\n',
      'spec/vectors.json': json({ headers: [] }),
    },
    'feat: one'
  );
  for (const path of [
    'spec/debugging.md',
    'spec/metrics.json',
    'spec/schemas/metrics.schema.json',
    'spec/schemas/vectors.schema.json',
    'spec/schemas/common.schema.json',
  ]) {
    git('rm', '-q', path);
  }
  git('commit', '-q', '--amend', '--no-edit');
  git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  git('checkout', '-q', '-b', 'develop');
  commit(files({ rule: 'A rule the wire changed.\n' }), 'feat: two');
  return root;
});

// a release branch from develop, its tree as given
const releasing = (template, { branch = 'release/0.2.0', ...options } = {}) => {
  const fixture = repository(template);
  fixture.git('checkout', '-q', '-b', branch, 'develop');
  fixture.write(files(options));
  return fixture;
};

// ── Pure ──────────────────────────────────────────────────────────────────────

describe('versions, texts and modes', () => {
  test('a version is followed by its next patch, minor or major', () => {
    assert.deepEqual(successorsOf('0.1.9'), ['0.1.10', '0.2.0', '1.0.0']);
  });

  test('each kind of ref has its mode', () => {
    for (const ref of ['release/0.2.0', 'hotfix/0.2.1', 'refs/heads/release/0.2.0']) {
      assert.equal(modeOf({ ref }), MODES.release, ref);
    }
    for (const ref of ['main', 'refs/heads/main', 'refs/tags/v0.2.0']) {
      assert.equal(modeOf({ ref }), MODES.released, ref);
    }
    for (const ref of ['develop', 'feature/x', 'refs/heads/develop', 'refs/pull/3/merge']) {
      assert.equal(modeOf({ ref }), MODES.develop, ref);
    }
    assert.equal(modeOf({ ref: 'release/0.2.0', base: 'main' }), MODES.release);
    assert.equal(modeOf({ ref: 'feature/x', base: 'develop' }), MODES.develop);
  });

  test("each file of spec/ is its document's, the companion's found by debuggingVersion", () => {
    const read = (path) => {
      return { 'spec/metrics.json': '{ "debuggingVersion": "0.1.0" }' }[path] ?? '{}';
    };
    const cases = {
      'spec/spec.md': ['spec'],
      'spec/vectors.json': ['spec'],
      'spec/codecs.proto': ['spec'],
      'spec/schemas/vectors.schema.json': ['spec'],
      'spec/metrics.json': ['debugging'],
      'spec/schemas/metrics.schema.json': ['debugging'],
      'spec/debugging.md': ['debugging'],
      'spec/debugging-uncited.txt': ['debugging'],
      'spec/schemas/common.schema.json': ['spec', 'debugging'],
      'spec/generators/make_vectors.py': [],
      'spec/check.py': [],
      'spec/requirements.txt': [],
      'README.md': [],
    };
    for (const [path, documents] of Object.entries(cases)) {
      assert.deepEqual(documentOf(path, read), documents, path);
    }
  });

  test("a version's own move is masked", () => {
    const text = (version) => {
      return `**Version: ${version}**, of\n{ "specVersion": "${version}", "debuggingVersion": "${version}" }`;
    };
    assert.equal(unversioned(text('0.2.0')), unversioned(text('0.1.0')));
    assert.notEqual(unversioned(`${text('0.1.0')}x`), unversioned(text('0.1.0')));
  });

  test('a text in CRLF is read with LF', () => {
    const { root } = repository();
    writeFileSync(join(root, 'crlf.md'), '# A\r\n\r\nb\r\n');
    assert.equal(readText(join(root, 'crlf.md')), '# A\n\nb\n');
    assert.equal(readText(join(root, 'none.md')), null);
  });

  test('a section of the CHANGELOG runs to the next heading, or to the links', () => {
    const { sections, links } = readChangelog(RELEASED);
    assert.deepEqual(
      sections.map(({ label, date, entries }) => [label, date, entries]),
      [
        ['Unreleased', null, 0],
        ['0.2.0', '2026-10-07', 1],
        ['0.1.0', '2026-10-02', 1],
      ]
    );
    assert.equal(sections[1].text, '## [0.2.0] - 2026-10-07\n\n### Added\n\n- A rule.');
    assert.equal(sections[2].text, '## [0.1.0] - 2026-10-02\n\n### Added\n\n- The first.');
    assert.equal(links['0.2.0'], `${REPOSITORY}/compare/v0.1.0...v0.2.0`);
  });

  test('a document none of whose files repeats its version fails: a walk that reads nothing', () => {
    const versions = {
      package: '0.1.0',
      props: '0.1.0',
      locks: {},
      documents: {
        spec: { present: true, stated: '0.1.0', files: {} },
        debugging: { present: false, stated: null, files: {} },
      },
    };
    const problems = judge(versions, {
      mode: MODES.develop,
      releases: { tags: [], documentTags: [], documents: null },
      changelog: readChangelog(''),
    });
    assert.deepEqual(problems, ['spec/spec.md: no conformance file repeats it as its specVersion']);
  });
});

// ── Every ref ─────────────────────────────────────────────────────────────────

describe('every ref: each version agrees with itself, and a released section stays', () => {
  test('agreeing axes pass on a feature branch', () => {
    const { git, problems } = repository(released());
    git('checkout', '-q', '-b', 'feature/x');
    assert.deepEqual(problems(), []);
  });

  test("the builder's package apart from the TypeScript package fails", () => {
    const { write, problems } = repository(released());
    write({ [BUILDER]: json({ name: 'beadc', version: '0.2.0', private: true }) });
    assert.match(problems().join('\n'), /builder\/package\.json: version 0\.2\.0, where/);
  });

  test("the builder's package at the product's version passes", () => {
    const { write, problems } = repository(released());
    write({ [BUILDER]: json({ name: 'beadc', version: '0.1.0', private: true }) });
    assert.deepEqual(problems(), []);
  });

  test('the props apart from the package fail', () => {
    const { write, problems } = repository(released());
    write({ [PROPS]: '<Project><Version>0.2.0</Version></Project>\n' });
    assert.match(problems().join('\n'), /Directory\.Build\.props: <Version> 0\.2\.0, where/);
  });

  test("a lock file's project range apart from <Version> fails", () => {
    const { write, problems } = repository(released());
    write({ 'implementations/dotnet/src/Http/packages.lock.json': lock('1.0.0') });
    const found = problems();
    assert.equal(found.length, 2);
    assert.match(found[0], /bead\.http takes Bead\.Core at \[1\.0\.0, \), where <Version> 0\.1\.0/);
  });

  test("a conformance file's specVersion apart from spec.md's fails", () => {
    const { write, problems } = repository(released());
    write({ 'spec/vectors.json': json({ specVersion: '0.2.0', headers: [] }) });
    assert.deepEqual(problems(), [
      'spec/vectors.json: specVersion 0.2.0, where spec/spec.md states 0.1.0',
    ]);
  });

  test('on develop, a changed document need not move', () => {
    const { commit, problems } = repository(released());
    commit(files({ rule: 'A rule.\n', groups: ['headers', 'jwtVerdicts'] }), 'feat: two');
    assert.deepEqual(problems('develop'), []);
  });

  test('a released section edited fails, and so does an entry a back-merge files under it', () => {
    const fixture = repository(released());
    fixture.commit(
      files({ rule: 'A rule.\n', changes: changelog({ unreleased: ['A rule.'] }) }),
      'feat: two'
    );
    fixture.git('checkout', '-q', '-b', 'release/0.2.0');
    fixture.commit(
      files({ product: '0.2.0', spec: '0.2.0', rule: 'A rule.\n', changes: RELEASED }),
      'chore(release): 0.2.0'
    );
    // meanwhile, a feature lands on develop, its line under [Unreleased]
    fixture.git('checkout', '-q', 'develop');
    fixture.commit(
      { 'CHANGELOG.md': changelog({ unreleased: ['A rule.', 'A feature 0.2.0 does not ship.'] }) },
      'feat: three'
    );
    fixture.finish('release/0.2.0');
    assert.match(
      fixture.problems().join('\n'),
      /\[0\.2\.0\] is not the section v0\.2\.0 shipped, from "- A feature 0\.2\.0 does not ship\."/
    );
    // a typo fixed in a released section is a change of it too
    fixture.write({ 'CHANGELOG.md': RELEASED.replace('The first.', 'The first one.') });
    assert.match(fixture.problems().join('\n'), /\[0\.1\.0\] is not the section v0\.1\.0 shipped/);
    fixture.write({ 'CHANGELOG.md': RELEASED });
    assert.deepEqual(fixture.problems(), []);
  });

  test('a clone without its tags fails at the first released section', () => {
    const { git, problems } = repository(released());
    git('tag', '-d', 'v0.1.0');
    assert.deepEqual(problems(), [
      'CHANGELOG.md: [0.1.0] names no v0.1.0 reached from HEAD: fetch the history and its tags',
    ]);
  });
});

// ── Strict modes ──────────────────────────────────────────────────────────────

describe('a release: each version moves as its changes owe', () => {
  test('no v* reached fails: a clone without its tags proves nothing', () => {
    const { commit, git, problems } = repository();
    commit({ ...files(), 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n' }, 'feat: one');
    git('checkout', '-q', '-b', 'release/0.1.0');
    assert.deepEqual(problems(), [
      'tags: no v* is reached from HEAD: fetch the history and its tags',
    ]);
  });

  test('the product kept fails, a skip fails, its next minor passes', () => {
    const { write, problems } = releasing(released());
    assert.match(
      problems().join('\n'),
      /package\.json: 0\.1\.0, where the product's last release, v0\.1\.0, owes one of 0\.1\.1, 0\.2\.0, 1\.0\.0/
    );
    write(files({ product: '0.3.0' }));
    assert.match(problems().join('\n'), /package\.json: 0\.3\.0, where/);
    write(files({ product: '0.2.0', changes: RELEASED }));
    assert.deepEqual(problems(), []);
  });

  test('a document changed and kept fails, changed by its schema alone fails, changed and moved passes', () => {
    const { write, problems } = releasing(released(), {
      product: '0.2.0',
      rule: 'A rule.\n',
      changes: RELEASED,
    });
    assert.deepEqual(problems(), [
      'spec/spec.md: 0.1.0, where its changes since v0.1.0 (spec/spec.md) owe one of 0.1.1, 0.2.0, 1.0.0',
    ]);
    write({
      ...files({ product: '0.2.0', changes: RELEASED }),
      'spec/schemas/vectors.schema.json': json({ type: 'object', title: 'Vectors' }),
    });
    assert.match(
      problems().join('\n'),
      /spec\/spec\.md: 0\.1\.0, where its changes since v0\.1\.0 \(spec\/schemas\/vectors\.schema\.json\)/
    );
    write(files({ product: '0.2.0', spec: '0.2.0', rule: 'A rule.\n', changes: RELEASED }));
    assert.deepEqual(problems(), []);
  });

  test('a document moved though only its own line changed fails', () => {
    const { problems } = releasing(released(), {
      product: '0.2.0',
      debugging: '0.1.1',
      changes: RELEASED,
    });
    assert.deepEqual(problems(), [
      'spec/debugging.md: 0.1.1, though none of its files changed since v0.1.0, which gives it 0.1.0',
    ]);
  });

  test('a generator changed moves no document', () => {
    const { write, problems } = releasing(released(), { product: '0.2.0', changes: RELEASED });
    write({ 'spec/generators/make_vectors.py': '# writes vectors.json, in another order\n' });
    assert.deepEqual(problems(), []);
  });

  test('a conformance file, a key or a schema property added holds the move to the minor', () => {
    const cases = {
      'a file': { 'spec/codecs.json': json({ specVersion: '0.1.1', payloads: [] }) },
      'a key': { 'spec/vectors.json': json({ specVersion: '0.1.1', headers: [], jwt: [] }) },
      'a property': {
        'spec/schemas/vectors.schema.json': json({
          type: 'object',
          properties: { specVersion: {}, headers: { items: { properties: { name: {} } } } },
        }),
      },
    };
    const added = {
      'a file':
        /where the file spec\/codecs\.json, added since v0\.1\.0, owes at least its minor, 0\.2\.0/,
      'a key': /where spec\/vectors\.json's key "jwt", added since v0\.1\.0/,
      'a property':
        /where spec\/schemas\/vectors\.schema\.json's property \/properties\/headers\/items\/properties\/name, added/,
    };
    for (const [name, tree] of Object.entries(cases)) {
      const { write, problems } = releasing(released(), {
        product: '0.2.0',
        spec: '0.1.1',
        changes: RELEASED,
      });
      write(tree);
      assert.match(problems().join('\n'), added[name], name);
      const minor = Object.fromEntries(
        Object.entries(tree).map(([path, text]) => [path, text.replace('0.1.1', '0.2.0')])
      );
      write({ ...files({ product: '0.2.0', spec: '0.2.0', changes: RELEASED }), ...minor });
      assert.deepEqual(problems(), [], name);
    }
  });

  test('a document in no release passes at any version', () => {
    const { problems } = releasing(unstated(), {
      product: '0.2.0',
      spec: '0.2.0',
      debugging: '0.4.0',
      rule: 'A rule the wire changed.\n',
      changes: RELEASED,
    });
    assert.deepEqual(problems(), []);
  });

  test('a branch cut from a tagged commit counts that tag as before it', () => {
    const { git, write, problems } = repository(released());
    git('checkout', '-q', '-b', 'hotfix/0.1.1', 'main');
    write(
      files({
        product: '0.1.1',
        changes: changelog({ versions: [['0.1.1', '2026-10-08', ['A fix.']], FIRST] }),
      })
    );
    assert.deepEqual(problems(), []);
  });
});

// ── The probes ────────────────────────────────────────────────────────────────

describe("the Tenth Man's probes", () => {
  // the release 0.2.0 from unstated(), the spec at a version, finished, its documents tagged as
  // `release.mjs tag` tags them
  const finished = (spec) => {
    const fixture = releasing(unstated(), {
      product: '0.2.0',
      spec,
      rule: 'A rule the wire changed.\n',
      changes: RELEASED,
    });
    fixture.git('commit', '-qam', 'chore(release): 0.2.0');
    fixture.finish('release/0.2.0');
    fixture.tagAt(`spec-v${spec}`, 'v0.2.0^{commit}');
    fixture.tagAt('debugging-v0.1.0', 'v0.2.0^{commit}');
    fixture.git('checkout', '-q', 'main');
    return fixture;
  };

  test('P1: on main, a spec the release left at 0.1.0 fails, and one moved to 0.7.0 fails', () => {
    const kept = finished('0.1.0').problems('main').join('\n');
    assert.match(kept, /spec\/spec\.md: 0\.1\.0, where its changes since v0\.1\.0/);
    assert.match(
      kept,
      /spec-v0\.1\.0: at \w+, where v0\.1\.0, the first v\* that gives spec\/spec\.md 0\.1\.0/
    );
    assert.match(
      finished('0.7.0').problems('main').join('\n'),
      /spec\/spec\.md: 0\.7\.0, where its changes since v0\.1\.0/
    );
    assert.deepEqual(finished('0.2.0').problems('main'), []);
  });

  test('P2: the next release passes after a back-merge of the tag, and of the release branch', () => {
    for (const backMerge of ['tag', 'branch']) {
      const fixture = releasing(released(), {
        product: '0.2.0',
        spec: '0.2.0',
        rule: 'A rule.\n',
        changes: RELEASED,
      });
      fixture.git('commit', '-qam', 'chore(release): 0.2.0');
      fixture.finish('release/0.2.0', { backMerge });
      fixture.tagAt('spec-v0.2.0', 'v0.2.0^{commit}');
      assert.deepEqual(fixture.problems(), [], backMerge);
      fixture.git('checkout', '-q', '-b', 'release/0.3.0');
      fixture.write(
        files({
          product: '0.3.0',
          spec: '0.2.0',
          rule: 'A rule.\n',
          changes: changelog({
            versions: [
              ['0.3.0', '2026-11-02', ['More.']],
              ['0.2.0', '2026-10-07', ['A rule.']],
              FIRST,
            ],
          }),
        })
      );
      assert.deepEqual(fixture.problems(), [], backMerge);
    }
  });

  test('P3: a spec-v0.1.0 moved by hand fails by its place, and excuses no change of the spec', () => {
    const fixture = repository(released());
    fixture.commit(files({ rule: 'A rule.\n' }), 'feat: two');
    fixture.git('tag', '-f', '-a', 'spec-v0.1.0', '-m', 'spec-v0.1.0');
    fixture.git('checkout', '-q', '-b', 'release/0.2.0');
    fixture.write(files({ product: '0.2.0', rule: 'A rule.\n', changes: RELEASED }));
    const found = fixture.problems().join('\n');
    assert.match(found, /spec\/spec\.md: 0\.1\.0, where its changes since v0\.1\.0/);
    assert.match(found, /spec-v0\.1\.0: at \w+, where v0\.1\.0, the first v\* that gives/);
  });

  test("P4: spec-v0.1.0 at v0.1.0's commit passes, and anywhere else fails", () => {
    const at = repository(unstated());
    at.tagAt('spec-v0.1.0', 'v0.1.0^{commit}');
    at.git('checkout', '-q', '-b', 'release/0.2.0');
    at.write(
      files({
        product: '0.2.0',
        spec: '0.2.0',
        rule: 'A rule the wire changed.\n',
        changes: RELEASED,
      })
    );
    assert.deepEqual(at.problems(), []);
    const elsewhere = repository(unstated());
    elsewhere.tagAt('spec-v0.1.0', 'develop');
    elsewhere.git('checkout', '-q', '-b', 'release/0.2.0');
    elsewhere.write(
      files({
        product: '0.2.0',
        spec: '0.2.0',
        rule: 'A rule the wire changed.\n',
        changes: RELEASED,
      })
    );
    assert.match(elsewhere.problems().join('\n'), /spec-v0\.1\.0: at \w+, where v0\.1\.0/);
  });
});

// ── Tags and the CHANGELOG of a release ───────────────────────────────────────

describe("a release's tags and its CHANGELOG", () => {
  // the release 0.2.0 from released(), committed on its branch
  const committed = () => {
    const fixture = releasing(released(), {
      product: '0.2.0',
      spec: '0.2.0',
      rule: 'A rule.\n',
      changes: RELEASED,
    });
    fixture.git('commit', '-qam', 'chore(release): 0.2.0');
    return fixture;
  };

  test('main with no v* at its commit fails', () => {
    const fixture = committed();
    fixture.git('checkout', '-q', 'main');
    fixture.git('merge', '-q', '--no-ff', '-m', "Merge branch 'release/0.2.0'", 'release/0.2.0');
    assert.deepEqual(fixture.problems(), [
      'tags: no v* tags HEAD: a release pushes main and its tags at once, git push --atomic',
    ]);
  });

  test("a v* whose tree states the spec's version owes its spec-v, and passes once tagged", () => {
    const fixture = committed();
    fixture.finish('release/0.2.0');
    fixture.git('checkout', '-q', 'main');
    assert.deepEqual(fixture.problems(), [
      'v0.2.0: its tree states spec/spec.md 0.2.0, which no spec-v0.2.0 tags: node tools/release.mjs tag',
    ]);
    // ! a tag of the tag nests it: the gate peels it to its commit
    fixture.git('tag', '-a', 'spec-v0.2.0', '-m', 'spec-v0.2.0', 'v0.2.0');
    assert.deepEqual(fixture.problems(), []);
  });

  test('a document tag at a v* that gives another version fails', () => {
    const fixture = committed();
    fixture.finish('release/0.2.0');
    fixture.tagAt('spec-v0.2.0', 'v0.2.0^{commit}');
    fixture.tagAt('debugging-v0.2.0', 'v0.2.0^{commit}');
    fixture.git('checkout', '-q', 'main');
    assert.deepEqual(fixture.problems(), [
      'debugging-v0.2.0: at v0.2.0, whose tree gives spec/debugging.md 0.1.0',
    ]);
  });

  test('[Unreleased] holding an entry on a release fails', () => {
    const { write, problems } = committed();
    write({
      'CHANGELOG.md': RELEASED.replace('## [Unreleased]\n', '## [Unreleased]\n\n- A fix.\n'),
    });
    assert.deepEqual(problems(), [
      'CHANGELOG.md: [Unreleased] holds 1 entry, which a release ships under [0.2.0]',
    ]);
  });

  test("the release's heading missing, undated, misdated or empty fails", () => {
    const { write, problems } = committed();
    const cases = {
      missing: [
        RELEASED.replace('## [0.2.0] - 2026-10-07\n\n### Added\n\n- A rule.\n\n', ''),
        /no ## \[0\.2\.0\] - YYYY-MM-DD right below/,
      ],
      undated: [
        RELEASED.replace('## [0.2.0] - 2026-10-07', '## [0.2.0]'),
        /\[0\.2\.0\] dated nowhere/,
      ],
      misdated: [
        RELEASED.replace('2026-10-07', '2026-02-30'),
        /\[0\.2\.0\] dated 2026-02-30, where a day/,
      ],
      empty: [RELEASED.replace('### Added\n\n- A rule.\n\n', ''), /\[0\.2\.0\] holds no entry/],
    };
    for (const [name, [text, problem]] of Object.entries(cases)) {
      write({ 'CHANGELOG.md': text });
      assert.match(problems().join('\n'), problem, name);
    }
  });

  test("the release's links missing, or comparing from another tag, fail", () => {
    const { write, problems } = committed();
    write({ 'CHANGELOG.md': RELEASED.replace(/^\[0\.2\.0\]: .*\n/m, '') });
    assert.deepEqual(problems(), [
      `CHANGELOG.md: [0.2.0]: none, where ${REPOSITORY}/compare/v0.1.0...v0.2.0 is due`,
    ]);
    write({
      'CHANGELOG.md': RELEASED.replace(
        'compare/v0.2.0...develop',
        'compare/v0.1.0...develop'
      ).replace('v0.1.0...v0.2.0', 'v0.0.9...v0.2.0'),
    });
    assert.deepEqual(problems(), [
      `CHANGELOG.md: [Unreleased]: ${REPOSITORY}/compare/v0.1.0...develop, where ${REPOSITORY}/compare/v0.2.0...develop is due`,
      `CHANGELOG.md: [0.2.0]: ${REPOSITORY}/compare/v0.0.9...v0.2.0, where ${REPOSITORY}/compare/v0.1.0...v0.2.0 is due`,
    ]);
  });
});

// ── The command line ──────────────────────────────────────────────────────────

describe('the command line', () => {
  const script = fileURLToPath(new URL('../check-versions.mjs', import.meta.url));

  test('--ref and --base set the mode; it exits 0, 1 on a problem and 2 on a usage error', () => {
    const { root } = releasing(released(), { product: '0.2.0', changes: RELEASED });
    const run = (...args) => {
      return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    };
    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, 'versions (release): product 0.2.0, spec 0.1.0, debugging 0.1.0\n');
    const failed = run('--ref', 'refs/heads/main');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^versions: v0\.1\.0: tags HEAD, where .+ states 0\.2\.0$/m);
    assert.match(failed.stdout, /^versions \(released\)/);
    assert.match(run('--ref', 'feature/x', '--base', 'main').stdout, /^versions \(release\)/);
    assert.match(run('--ref', 'develop', '--base', '').stdout, /^versions \(develop\)/);
    assert.equal(run('--bogus').status, 2);
  });
});
