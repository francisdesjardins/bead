export const meta = {
  name: 'bead-adversarial-review',
  description:
    'An adversarial review of Bead through several lenses, each finding put back to the code by a verifier, then one synthesis by severity; nothing in the repository changes',
  whenToUse:
    'Before a freeze: a version of the spec or its companion, a release, the .proto options v1 (max); a layer or a branch (xhigh)',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens' },
    { title: 'Verify', detail: 'each finding rerun, confirmed, partly or refuted' },
    { title: 'Synthesize', detail: 'duplicates merged, a verdict, the work by severity' },
  ],
};

// args: { scope, slug?, lenses?, effort?, model?, serial?, repo?, scratch?, venv?, toolchain? }
// - scope: what is reviewed, in full: the ref and its commit, the versions, what is out of scope;
// - slug: the folder under `scratch`, `review` by default;
// - lenses: [{ key, focus, effort? }], the five below by default, each at `effort` but where it
//   names its own: a lens on the wording asks less than one on the concurrent core;
// - effort: the reviewers', 'max' by default, as before a freeze (CLAUDE.md, the agents' effort);
// - model: the model of the stages at xhigh or max, when it is not the session's ('fable', say),
//   none by default: the user asks for it, or a session proposes it with its reason;
// - serial: one agent at a time, each lens reviewed then verified before the next, where the quota
//   asks it; the lenses run side by side otherwise;
// - repo, scratch, venv, toolchain: the clone, a folder outside it, the Python of `spec/check.py`
//   and what goes first on PATH, this machine's by default.
if (!args || !args.scope) {
  throw new Error('args.scope is required');
}
const REPO = args.repo || 'D:/workspace/francisdesjardins/2025/bead';
const SCRATCH = args.scratch || 'D:/workspace/francisdesjardins/2025/_scratch';
const VENV = args.venv || `${SCRATCH}/venv/Scripts/python.exe`;
const TOOLCHAIN =
  args.toolchain ||
  `\`${SCRATCH}/venv/Scripts\` and \`${SCRATCH}/dotnet-10.0.404\` first on PATH, \`DOTNET_ROOT\` the latter, \`NO_COLOR\` unset for Node`;
const SCOPE = args.scope;
const SLUG = args.slug || 'review';
const EFFORT = args.effort || 'max';
const OUT = `${SCRATCH}/${SLUG}`;
// * the session's model but where `model` names another, and then only at xhigh or max
const modelOf = (effort) => {
  return args.model && (effort === 'xhigh' || effort === 'max') ? { model: args.model } : {};
};

const LENSES = args.lenses || [
  {
    key: 'text',
    focus:
      'the spec and its companion read as a standard: every unit normative and testable, its requirement words as RFC 2119 and RFC 8174 use them, its grammar as RFC 5234 writes it, every "section n.n" resolving, every sum and bound computing, every unit a conformance file cites or `spec/units.txt` gives its reason for, held as `spec/check.py` holds it, and what the README, the CHANGELOG and the records count against what holds',
  },
  {
    key: 'wire-and-calls',
    focus:
      'the envelope, the codecs, the calls, the errors, the transfers and the timeouts: each side against the text and against the other, by differential probes over both codecs and both routers, the order of each check, what a peer sees on the wire',
  },
  {
    key: 'sessions-relays-transports',
    focus:
      'sessions and credentials (JWT, ELSEWHERE), admission, relays, and the transports (HTTP, WebSocket, a Web Worker), origins and hosts: what a deployment relies on for its security, what an attacker on the wire or in a page can reach, the refusals and their order',
  },
  {
    key: 'conformance',
    focus:
      'the conformance files, their generators and the tests that play them on each side: a unit no case tests, a case that passes for the wrong reason, a twin missing on one side, a row of `docs/support.md` without the test that shows it, a generator that does not reproduce its file byte for byte',
  },
  {
    key: 'companion',
    focus:
      "`spec/debugging.md` and its conformance files: the trace's steps, the debug filters, the metrics and their exposition, on both sides, against the text and against each other",
  },
];

const COMMON = `
You review Bead, at ${REPO}. What is reviewed:
${SCOPE}
CLAUDE.md's rules are injected; these are the ones a stage most often misses:
- **Change nothing in the repository**, and do not stage, commit, branch or push: write only under ${OUT}/.
- Temporary files and probes go under ${OUT}/ and nowhere else; run builds and tests with \`TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp\`. \`${VENV}\` runs \`spec/check.py\` and the generators.
- The toolchain: ${TOOLCHAIN}.
- Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
- Run a gate in the foreground, with a timeout that fits it (up to ten minutes); a run in the background only beside another you run at once, then one Monitor until-loop that waits on both, never sleeping and reading their output again and again.
- Before 1.0.0, a decision record or a released behaviour yields to a standard, an industry practice, a cleaner split, stability or clarity: name it and recommend the revision outright.
Cite file and line for every claim, and prove what can be proved by running it.`;

const review = (lens) => {
  const effort = lens.effort || EFFORT;
  return agent(
    `${COMMON}
# Your task: review through one lens (effort ${effort})
The lens: ${lens.focus}.
Be adversarial: look for what is wrong, missing or inconsistent, and what a reader, a peer or an attacker would trip on; say what you looked at and found sound as well, so that the silence means something. For each finding: an id (\`${lens.key}-<n>\`), what is wrong, the evidence (file and line, the probe and its output, under ${OUT}/probes-${lens.key}/), the severity you propose (blocker: the version cannot ship with it; major: it ships only fixed or declared, a row of the matrix or an open point; minor), and the remedy. Write ${OUT}/${lens.key}.md, your report whole, and return at most ten lines: what you looked at, the findings' count by severity, and that path.`,
    { label: `review:${lens.key}`, phase: 'Review', effort, ...modelOf(effort) }
  );
};
const verify = (summary, lens) => {
  return agent(
    `${COMMON}
# Your task: verify one lens's findings (effort xhigh)
Read ${OUT}/${lens.key}.md. Put each finding to the code and the text it cites, and rerun its proof under ${OUT}/verify-${lens.key}/: give it a verdict, confirmed, partly or refuted, and a severity, blocker, major or minor, which may differ from the reviewer's. Refute what does not hold; default to refuted when the evidence does not reproduce. Write ${OUT}/${lens.key}-verdicts.md (a table, Id | Verdict | Severity | In short, then a section per finding) and return at most ten lines: the counts by verdict and by severity, and that path.
The reviewer's summary:
${summary || '(no summary)'}`,
    { label: `verify:${lens.key}`, phase: 'Verify', effort: 'xhigh', ...modelOf('xhigh') }
  );
};

const serially = async () => {
  const tables = [];
  for (const lens of LENSES) {
    tables.push(await verify(await review(lens), lens));
  }
  return tables;
};

// * each lens's findings and verdicts on disk, which the synthesis reads
await (args.serial ? serially() : pipeline(LENSES, review, verify));

phase('Synthesize');
const synthesis = await agent(
  `${COMMON}
# Your task: synthesize the review (effort xhigh)
Read each lens's file and its verdicts in ${OUT}/ (${LENSES.map((lens) => {
    return lens.key;
  }).join(
    ', '
  )}). Write ${OUT}/review.md: the verdict first (can it ship, and under what conditions); what was looked at and found sound; then the findings kept, confirmed or partly, at the verifier's severity, duplicates across lenses merged under one id (B, M, m by severity, numbered), each with its evidence in short, its remedy and the lens files that hold the rest; the refuted ones listed at the end, each with why. Return, in French, the verdict in five lines, the counts by severity, and each blocker and major in one line.`,
  { label: `synthesize:${SLUG}`, phase: 'Synthesize', effort: 'xhigh', ...modelOf('xhigh') }
);

return { review: `${OUT}/review.md`, synthesis };
