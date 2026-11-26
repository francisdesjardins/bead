export const meta = {
  name: 'bead-implement-every-side',
  description:
    'Implement a settled design on every side: the spec and its conformance first, then TypeScript, C# and Rust side by side (or the stages a design names), then the integration with every gate and a commit plan or a series of commits',
  whenToUse:
    'Once a design is settled (a round of the Tenth Man answered, its decisions taken by the user), on its branch, checked out',
  phases: [
    { title: 'First', detail: 'the spec and its conformance, or what the others build on' },
    { title: 'Sides', detail: 'TypeScript · C#, or the stages the design names' },
    { title: 'Integrate', detail: 'every gate, the commits' },
  ],
};

// args: { slug, design, branch, parts?, stages?, first?, together?, repo?, scratch?, venv?, toolchain?,
//         specEffort?, series?, suites?, notes?, integrationNote? }
// - repo, scratch, venv, toolchain: the clone, a folder outside it, the Python of `spec/check.py`
//   and what goes first on PATH, this machine's by default;
// - design: the path of the settled design, its `design.md`: a part every stage shares under
//   `## Shared`, then a section a stage under `## Stage: <key>`, each stage reading the shared part
//   and its own; its `rationale.md` beside it, the reasons and the Tenth Man's table, read where a
//   stage needs a reason, and whole by the spec's, which writes the record; a design of one file,
//   without those sections, is read for what it holds;
// - parts: the stages to run, ['spec', 'typescript', 'csharp', 'rust'] by default, every side the
//   protocol has; a design that leaves one out names the others, and says why;
// - stages: { <key>: { task, effort? } }, a stage of the design's own (a folder the four do not
//   cover) or one of the four replaced; each task says which files are the stage's alone;
// - first: the stages that run before the others, in order, ['spec'] by default;
// - together: true runs every stage at once, when the design fixes every case they read;
// - specEffort: 'high' by default, 'xhigh' for the spec's identity rules (CLAUDE.md, the agents' effort);
// - series: true has the integration build the design's commits in a clone of its own, each one
//   held to the fast gates and its build there, in place of proposing whole-file commits; the
//   series' last tree is the working tree the integration ran every gate over, so no suite runs
//   twice;
// - suites: 'local' by default, the integration running every suite `tools/ci-scope.mjs --run`
//   runs for what the branch changes; 'ci' leaves the whole suites to GitHub's CI on the feature
//   branch, which the session pushes once the series lands (the user, 2026-10-14: a push of a
//   feature/* branch to save tokens and time), the integration running the gates `--run --gates`
//   runs and the tests of what changed;
// - notes: what the stages need beyond the design, in a few lines.
// - integrationNote: a word for the integration alone, so that a resumed run replays the stages
//   and runs the integration again (a stage finished apart from the run, say).
const required = (name) => {
  if (!args || !args[name]) {
    throw new Error(`args.${name} is required`);
  }
  return args[name];
};

const REPO = args.repo || 'D:/workspace/francisdesjardins/2025/bead';
const SCRATCH = args.scratch || 'D:/workspace/francisdesjardins/2025/_scratch';
const VENV = args.venv || `${SCRATCH}/venv/Scripts/python.exe`;
const TOOLCHAIN =
  args.toolchain ||
  `\`${SCRATCH}/venv/Scripts\` and \`${SCRATCH}/dotnet-10.0.404\` first on PATH, \`DOTNET_ROOT\` the latter, \`NO_COLOR\` unset for Node`;
const SLUG = required('slug');
const DESIGN = required('design');
const BRANCH = required('branch');
const STAGES = args.stages || {};
// ! every stage `stages` names runs, whether or not `parts` names it: a stage of the design's own
// left out of `parts` once ran nowhere, and the integration wrote it in its place
const PARTS = [
  ...new Set([...(args.parts || ['spec', 'typescript', 'csharp', 'rust']), ...Object.keys(STAGES)]),
];
const OUT = `${SCRATCH}/${SLUG}`;
const SUITES = args.suites || 'local';
const TMP = `TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp CARGO_INCREMENTAL=0`;
const RATIONALE = DESIGN.replace(/[^/\\]*$/u, 'rationale.md');

// what a stage reads of the design: the shared part and its own section, the reasons where it
// needs one; the spec's stage writes the record, so it reads the reasons whole
const readsOf = (key) => {
  const reasons =
    key === 'spec'
      ? `${RATIONALE}, beside it, holds what the record keeps: today's state, the standards weighed, the alternatives refused and the Tenth Man's table; read it whole`
      : `${RATIONALE}, beside it, holds today's state, the standards weighed and the Tenth Man's table: open it only where you need a reason`;
  return `Read in ${DESIGN} the part every stage shares (\`## Shared\`) and your section (\`## Stage: ${key}\`), not the others'; ${reasons}. A design of one file, without those sections or that file, is read for what it holds for you.`;
};

const COMMON = `
You work on Bead, at ${REPO}, on the branch \`${BRANCH}\`, checked out. You implement ${DESIGN}, the settled design: where it is silent, keep to the spec and the records, and say what you chose. CLAUDE.md's rules are injected; these are the ones a stage most often misses:
- **Do not stage, commit, branch or push.**
- Temporary files go under ${OUT}/ and nowhere else; run builds and tests with \`${TMP}\`: cargo never empties \`target/*/incremental\`, and each feature set a Rust gate builds piles up there. \`${VENV}\` runs \`spec/check.py\` and the generators; the toolchain: ${TOOLCHAIN}.
- Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
- Run a gate in the foreground, with a timeout that fits it (up to ten minutes); a run in the background only beside another you run at once, then one Monitor until-loop that waits on both, never sleeping and reading their output again and again.
- Stop every process and watcher you started before you answer: a server, a broker's container, a browser, a Monitor; \`dotnet build-server shutdown\` after a C# build.
- Parity: a test on one side has its twin on the other, named by the same sentence (\`Underscored_sentence\` in C#, \`snake_case_sentence\` in Rust); a difference that remains is a row of \`docs/support.md\` with the test that shows it.
- A test that asserts something does not happen waits past the bound, the spec's window for its effect and every platform's granularity (Node's one-second check, Kestrel's heartbeat), so that it can fail on every side; a wait under one of them is a finding, raised in your report.
${args.notes ? `${args.notes}\n` : ''}`;

const GENERATE = `regenerate every conformance file with \`${VENV}\` and each script of \`spec/generators/\` the README lists (never edit a generated file by hand)`;
const FORMAT = "the root's format step (`node tools/check-format.mjs`)";
// ! a side's interop drives the other side, which another stage is editing at the same time: it
// runs once, in the integration, over the settled tree
const INTEROP =
  "The interop between the sides is the integration's, run once over the settled tree.";

const DEFAULT_TASKS = {
  spec: `# Your task: the spec, the conformance, the records (effort ${args.specEffort || 'high'})
Implement the design's text and conformance: \`spec/spec.md\` and \`spec/debugging.md\` as the design touches them, the generators and the conformance files (${GENERATE}), \`spec/units.txt\` and \`spec/debugging-units.txt\` (\`--write-units\` naming each unit whose text the design moves, and no other; a new unit given its status), the decision records (the round of the Tenth Man kept in its record), \`docs/support.md\`, \`CHANGELOG.md\` under \`[Unreleased]\`, the README's counts. These files are yours alone. Then: \`${VENV} spec/check.py\`, ${FORMAT} (fixing your files only), \`node tools/check-links.mjs\`, \`node tools/check-versions.mjs\`, the names check. Report the files, the cases and each gate's result.`,
  typescript: `# Your task: the TypeScript side (effort high)
Implement the design under \`implementations/typescript/\` only, with its tests, one test file per module in the \`__tests__/\` folder beside it. While you work, run the test files of what you change (\`yarn test <files>\`); at the end, \`yarn check\` and the whole suite once, from that folder, without the interop that drives the C# side, as CI's TypeScript job runs it: \`yarn test --grep-invert "the C# server of the interop service"\`. ${INTEROP} Report the files, the tests by name and the results.`,
  csharp: `# Your task: the C# side (effort high)
Implement the design under \`implementations/dotnet/\` only, with its tests named as the TypeScript twins; decision 0007 holds. While you work, run the test project of what you change (\`dotnet test --project tests/<project>\`, \`--filter-method\` to narrow); at the end, from that folder, \`dotnet format Bead.slnx --verify-no-changes\`, \`dotnet build Bead.slnx\`, and the whole suite once without the interop, which starts the TypeScript side: every test project of \`tests/\` but \`Bead.Interop.Tests\`, each by \`dotnet test --project tests/<project>\`, \`BEAD_INTEROP_REQUIRED\` unset. ${INTEROP} Report the files, the tests by name and the results.`,
  rust: `# Your task: the Rust side (effort high)
Implement the design under \`implementations/rust/\` only, with its tests: a module's beside it (\`src/envelope.rs\` → \`src/envelope/tests.rs\`), the conformance players in a crate's \`tests/\`, named as the TypeScript twins; decision 0044 holds. While you work, run the package of what you change alone, never the whole workspace: \`cargo test -p <package> --all-features --locked <filter>\` (\`--test <player>\` for a file of \`tests/\`) and \`cargo clippy -p <package> --all-targets --all-features --locked\`, a package by its name (\`francisdesjardins-bead\`, \`francisdesjardins-bead-protobuf\`, …). A public item added or removed moves its crate's list, which \`BEAD_HOUSE_WRITE=1 cargo test -p francisdesjardins-bead-house\` writes anew; a \`.proto\` of \`bead-protobuf\`'s tests moved, \`node tools/check-protobuf.mjs --write\` writes their set again. At the end, CLAUDE.md's Rust gates once, from that folder: \`cargo fmt --all -- --check\`, \`cargo clippy --workspace --all-targets --all-features --locked\`, \`cargo clippy -p francisdesjardins-bead --lib --features testing,transcoding --locked --target wasm32-unknown-unknown\`, \`cargo test --workspace --all-features --locked\`, \`cargo doc --workspace --no-deps --all-features --locked\`, \`cargo build --workspace --locked\` and \`cargo deny --locked check\`. The coverage and its floor are the integration's. Report the files, the tests by name and the results.`,
};

const taskOf = (key) => {
  if (STAGES[key]) {
    return STAGES[key].task;
  }
  if (DEFAULT_TASKS[key]) {
    return DEFAULT_TASKS[key];
  }
  throw new Error(`no task for the stage ${key}: give it in args.stages`);
};

const effortOf = (key) => {
  if (STAGES[key] && STAGES[key].effort) {
    return STAGES[key].effort;
  }
  return key === 'spec' ? args.specEffort || 'high' : 'high';
};

// * a stage's report on disk, its return a few lines: the integration reads the files
const REPORTS = `${OUT}/reports`;
const reportOf = (key) => {
  return `${REPORTS}/${key}.md`;
};
const returnOf = (key) => {
  return `Write your report whole to ${reportOf(key)}; return at most ten lines: what you did, each gate's verdict, and that path.`;
};

const run = (key, phaseTitle, beside) => {
  return agent(`${COMMON}${readsOf(key)}\n${beside}\n${taskOf(key)}\n${returnOf(key)}`, {
    label: `implement:${key}`,
    phase: phaseTitle,
    effort: effortOf(key),
  });
};

const FIRST = args.together
  ? []
  : (args.first || ['spec']).filter((key) => {
      return PARTS.includes(key);
    });
const BESIDE = 'Other agents edit other parts of the tree at the same time: touch only your files.';

if (FIRST.length > 0) {
  phase('First');
}
for (const key of FIRST) {
  await run(key, 'First', '');
}

phase('Sides');
const others = PARTS.filter((key) => {
  return !FIRST.includes(key);
});
await parallel(
  others.map((key) => {
    return () => {
      return run(key, 'Sides', others.length > 1 ? BESIDE : '');
    };
  })
);

// the commits: whole files proposed, or the design's series built and proven in a clone
const PLAN = `propose the commits, whole files each, with Conventional Commit subjects and bodies of one or two lines (no attribution), in ${SCRATCH}/msgs/${SLUG}-<n>.txt, with the files in ${SCRATCH}/msgs/${SLUG}-files.txt as "<n> <path>" lines covering every changed file once; run \`node tools/check-commits.mjs --message\` and the names check over each.`;
const SERIES = `build the design's commits, in its order, with its subjects, bodies of one or two lines and no attribution, in a clone of your own, never in the repository: \`git clone --no-hardlinks ${REPO} ${OUT}/series\`, a branch \`${BRANCH}\` there at the repository's HEAD, \`user.name\` and \`user.email\` copied from the repository's config. The repository keeps the end state in its working tree, unstaged, and its own git is never written. Each commit passes \`node tools/check-commits.mjs --message\` and the names check (\`node ${REPO}/.claude/local/check.mjs\` over the commit's files and its message, from the clone's root), then the fast gates its files touch and its build: \`spec/check.py\` when \`spec/\` or a cited test moved, ${FORMAT}, \`node tools/check-links.mjs\`, \`node tools/check-versions.mjs\`, \`yarn check\` when the TypeScript side moved, \`dotnet build Bead.slnx\` when the C# side moved, \`cargo build --workspace --all-targets --all-features --locked\` from \`implementations/rust\` when the Rust side moved. ! No test suite runs at a commit: the series' last tree equals the repository's working tree, blob for blob, which the gates above already ran over whole; an earlier commit is held to building and to its fast gates. A commit that is not green is fixed within its slice, or joined to the next, and the report says which and why.`;
// * the gates and suites are what tools/ci-scope.mjs maps the branch's changes to, as CI on the
// feature branch runs them: one table, never a list written out here
const SCOPE =
  SUITES === 'ci' ? '`node tools/ci-scope.mjs --run --gates`' : '`node tools/ci-scope.mjs --run`';
const SUITE_GATES =
  SUITES === 'ci'
    ? "the tests of what changed, by file (`yarn test <files>`), by project (`dotnet test --project tests/<project>`) and by Rust package (`cargo test -p <package> --all-features --locked`); the interop both ways when a transport or the interop moved (`dotnet test --project tests/Bead.Interop.Tests` with `BEAD_INTEROP_REQUIRED=1`, then `yarn test:interop`): the whole suites are GitHub's CI's, on the feature branch the session pushes once the series lands; say so in the report"
    : 'the interop both ways over the settled tree, where the commands above do not already run it: `dotnet test --project tests/Bead.Interop.Tests` and `yarn test:interop` with `BEAD_INTEROP_REQUIRED=1`, and the Rust trials (`cargo test -p francisdesjardins-bead-interop-server --test interop --locked`) with `BEAD_INTEROP_RUST=1`';

phase('Integrate');
const integration = await agent(
  `${COMMON}
# Your task: integrate (effort high)
Read ${DESIGN} whole, every stage's section; ${RATIONALE}, beside it where the round wrote one, where you need a reason. Check that every side does what the design says, alike, as the conformance files and the twin tests prove, and that the records, the matrix and the CHANGELOG say what landed. Fix what is broken. The stages ran their suites without the interop between the sides: it runs here, once, over the settled tree, both ways, in the suites below. Before the suites, \`node tools/caches.mjs --min 1G\` and the free space of the repository's drive (\`df -h .\`): under 25 GB, delete \`implementations/rust/target/llvm-cov-target\` and every \`implementations/rust/target/*/incremental\` first; still under, stop and say so. Run every gate with \`${TMP}\`: ${GENERATE}, and check that nothing more moves; \`${VENV} spec/check.py\`; then, with the toolchain first on PATH so that its \`python\` is \`${VENV}\`, ${SCOPE}, which runs in order, each from its folder, the commands of the CI jobs that what the branch changes against develop reaches, the working tree included, the Commits job's first, and stops at the first that fails (! \`check-citations\` and \`check-details\` read the files git lists: \`git add -N\` the files the stages added before the run); ${SUITE_GATES}; the gates of every stage the design names; the names check over every file \`git status --porcelain\` lists. Then ${args.series ? SERIES : PLAN} At the end, delete \`implementations/rust/target/llvm-cov-target\` and every \`implementations/rust/target/*/incremental\`, and the series clone's \`target/\` where it has one. Write your report whole to ${reportOf('integrate')}: what you fixed, each gate's result, the test counts, the commits and the space freed. Return at most ten lines: what you fixed, each gate's verdict, the test counts, the commits, and that path.
${
  args.integrationNote
    ? `${args.integrationNote}
`
    : ''
}The stages' reports, read first: ${PARTS.map((key) => {
    return reportOf(key);
  }).join(', ')}.`,
  { label: `integrate:${SLUG}`, phase: 'Integrate', effort: 'high' }
);

return {
  reports: PARTS.map((key) => {
    return reportOf(key);
  }),
  integration: reportOf('integrate'),
  summary: integration,
};
