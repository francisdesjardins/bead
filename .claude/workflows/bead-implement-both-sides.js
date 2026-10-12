export const meta = {
  name: 'bead-implement-both-sides',
  description:
    'Implement a settled design on both sides: the spec and its conformance first, then TypeScript and C# together (or the stages a design names), then the integration with every gate and a commit plan or a series of commits',
  whenToUse:
    'Once a design is settled (a round of the Tenth Man answered, its decisions taken by the user), on its branch, checked out',
  phases: [
    { title: 'First', detail: 'the spec and its conformance, or what the others build on' },
    { title: 'Sides', detail: 'TypeScript · C#, or the stages the design names' },
    { title: 'Integrate', detail: 'every gate, the commits' },
  ],
};

// args: { repo, scratch, venv, slug, design, branch, parts?, stages?, first?, together?,
//         specEffort?, series?, notes? }
// - design: the path of the settled design, the one source every stage reads;
// - parts: the stages to run, ['spec', 'typescript', 'csharp'] by default;
// - stages: { <key>: { task, effort? } }, a stage of the design's own (a folder the three do not
//   cover) or one of the three replaced; each task says which files are the stage's alone;
// - first: the stages that run before the others, in order, ['spec'] by default;
// - together: true runs every stage at once, when the design fixes every case they read;
// - specEffort: 'high' by default, 'xhigh' for the spec's identity rules (CLAUDE.md, the agents' effort);
// - series: true has the integration build the design's commits in a clone of its own, each one's
//   gates run there, in place of proposing whole-file commits;
// - notes: what the stages need beyond the design, in a few lines.
const required = (name) => {
  if (!args || !args[name]) {
    throw new Error(`args.${name} is required`);
  }
  return args[name];
};

const REPO = required('repo');
const SCRATCH = required('scratch');
const VENV = required('venv');
const SLUG = required('slug');
const DESIGN = required('design');
const BRANCH = required('branch');
const PARTS = args.parts || ['spec', 'typescript', 'csharp'];
const STAGES = args.stages || {};
const OUT = `${SCRATCH}/${SLUG}`;
const TMP = `TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp`;

const COMMON = `
You work on Bead, at ${REPO}, on the branch \`${BRANCH}\`, checked out. You implement ${DESIGN}, the settled design: where it is silent, keep to the spec and the records, and say what you chose. CLAUDE.md's rules are injected; these are the ones a stage most often misses:
- **Do not stage, commit, branch or push.**
- Temporary files go under ${OUT}/ and nowhere else; run builds and tests with \`${TMP}\`. \`${VENV}\` runs \`spec/check.py\` and the generators.
- Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
- Parity: a test on one side has its twin on the other, named by the same sentence (\`Underscored_sentence\` in C#); a difference that remains is a row of \`docs/support.md\` with the test that shows it.
${args.notes ? `${args.notes}\n` : ''}`;

const GENERATE = `regenerate every conformance file with \`${VENV}\` and each script of \`spec/generators/\` the README lists (never edit a generated file by hand)`;
const FORMAT = "the root's format step (`node tools/check-format.mjs`)";

const DEFAULT_TASKS = {
  spec: `# Your task: the spec, the conformance, the records (effort ${args.specEffort || 'high'})
Implement the design's text and conformance: \`spec/spec.md\` and \`spec/debugging.md\` as the design touches them, the generators and the conformance files (${GENERATE}), \`spec/uncited.txt\` if units move, the decision records (the round of the Tenth Man kept in its record), \`docs/support.md\`, \`CHANGELOG.md\` under \`[Unreleased]\`, the README's counts. These files are yours alone. Then: \`${VENV} spec/check.py\`, ${FORMAT} (fixing your files only), \`node tools/check-links.mjs\`, \`node tools/check-versions.mjs\`, the names check. Report the files, the cases and each gate's result.`,
  typescript: `# Your task: the TypeScript side (effort high)
Implement the design under \`implementations/typescript/\` only, with its tests, one test file per module in the \`__tests__/\` folder beside it; then \`yarn check\` and \`yarn test\` from that folder (rerun at the end). Report the files, the tests by name and the results.`,
  csharp: `# Your task: the C# side (effort high)
Implement the design under \`implementations/dotnet/\` only, with its tests named as the TypeScript twins; decision 0007 holds. Then \`dotnet format Bead.slnx --verify-no-changes\` and \`dotnet test --solution Bead.slnx\` with \`BEAD_INTEROP_REQUIRED=1\`, from that folder (rerun at the end). Report the files, the tests by name and the results.`,
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

const run = (key, phaseTitle, beside) => {
  return agent(`${COMMON}${beside}\n${taskOf(key)}`, {
    label: `implement:${key}`,
    phase: phaseTitle,
    effort: effortOf(key),
  });
};

const reports = {};
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
  reports[key] = await run(key, 'First', '');
}

phase('Sides');
const others = PARTS.filter((key) => {
  return !FIRST.includes(key);
});
const results = await parallel(
  others.map((key) => {
    return () => {
      return run(key, 'Sides', others.length > 1 ? BESIDE : '');
    };
  })
);
others.forEach((key, index) => {
  reports[key] = results[index];
});

// the commits: whole files proposed, or the design's series built and proven in a clone
const PLAN = `propose the commits, whole files each, with Conventional Commit subjects and bodies of one or two lines (no attribution), in ${SCRATCH}/msgs/${SLUG}-<n>.txt, with the files in ${SCRATCH}/msgs/${SLUG}-files.txt as "<n> <path>" lines covering every changed file once; run \`node tools/check-commits.mjs --message\` and the names check over each.`;
const SERIES = `build the design's commits, in its order, with its subjects, bodies of one or two lines and no attribution, in a clone of your own, never in the repository: \`git clone --no-hardlinks ${REPO} ${OUT}/series\`, a branch \`${BRANCH}\` there at the repository's HEAD, \`user.name\` and \`user.email\` copied from the repository's config. The repository keeps the end state in its working tree, unstaged, and its own git is never written. Each commit passes \`node tools/check-commits.mjs --message\` and the names check (\`node ${REPO}/.claude/local/check.mjs\` over the commit's files and its message, from the clone's root), and the gates its files touch; a commit that is not green is fixed within its slice, or joined to the next, and the report says which and why. The series' last tree equals the repository's working tree, blob for blob.`;

phase('Integrate');
const integration = await agent(
  `${COMMON}
# Your task: integrate (effort high)
Check that both sides do what the design says, alike, as the conformance files and the twin tests prove, and that the records, the matrix and the CHANGELOG say what landed. Fix what is broken. Run every gate with \`${TMP}\`: ${GENERATE}, and check that nothing more moves; \`${VENV} spec/check.py\`; ${FORMAT}; \`node tools/check-links.mjs\`; \`node tools/check-versions.mjs\`; \`node --test "tools/__tests__/*.test.mjs"\` when \`tools/\` changed; \`yarn check\` and \`yarn test\`, with \`yarn devtools:build\` and \`yarn test:devtools\` when the DevTools panel changed; \`dotnet format Bead.slnx --verify-no-changes\` and \`dotnet test --solution Bead.slnx\` with \`BEAD_INTEROP_REQUIRED=1\`; the gates of every stage the design names; the names check over every file \`git status --porcelain\` lists. Then ${args.series ? SERIES : PLAN} Return what you fixed, each gate's result, the test counts and the commits.
The reports:
${PARTS.map((key) => {
  return `## ${key}\n${reports[key] || '(no report)'}`;
}).join('\n\n')}`,
  { label: `integrate:${SLUG}`, phase: 'Integrate', effort: 'high' }
);

return { reports, integration };
