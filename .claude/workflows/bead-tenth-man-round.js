export const meta = {
  name: 'bead-tenth-man-round',
  description:
    'A round of the Tenth Man on one change: drafted, met by one xhigh dissenter, revised with each objection answered; it stops there, for the user',
  whenToUse:
    "Every change that reaches across the languages or changes what every language's tests answer to (CLAUDE.md, the Tenth Man Rule), before it is implemented",
  phases: [
    {
      title: 'Draft',
      detail: 'what holds today, what the standards ask, the change; none in a small round',
    },
    { title: 'Tenth Man', detail: 'one xhigh dissenter' },
    {
      title: 'Revise',
      detail:
        'each objection answered: the design and its rationale; the decisions for the user, if any',
    },
  ],
};

// args: { slug, subject, branch?, record?, draft?, draftEffort?, small?, repo?, scratch?, venv?, toolchain?,
//   dissentModel? }
// - repo, scratch, venv, toolchain: the clone, a folder outside it, the Python of `spec/check.py`
//   and what goes first on PATH, this machine's by default;
// - dissentModel: the model the Tenth Man runs on, when it is not the session's ('fable', say);
// - subject: the change in full: what differs or what changes, the files and sections it touches,
//   the standards in play;
// - record: the decision record whose `## The Tenth Man` keeps the round, when it is known;
// - draft: the path of a draft written elsewhere, which skips the Draft stage;
// - draftEffort: 'high' by default, 'xhigh' for what is hard to undo (CLAUDE.md, the agents' effort);
// - small: true for CLAUDE.md's small round (one behaviour, a few files a side, no new record): no
//   Draft stage, the Tenth Man meets the subject as written, which is then the proposal whole
//   (today's state by file and line, the standards, the change on each side, the twin tests), and
//   Revise writes the design; not with `draft`.
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
const SUBJECT = required('subject');
const OUT = `${SCRATCH}/${SLUG}`;
const SMALL = Boolean(args.small);
if (SMALL && args.draft) {
  throw new Error('args.small and args.draft exclude each other: a small round has no draft');
}
const WHERE = args.branch ? `, on the branch \`${args.branch}\`` : '';
const RECORD = args.record
  ? `the decision record ${args.record}`
  : 'the decision record whose Scope holds the change (name it)';

const COMMON = `
You work on Bead, at ${REPO}${WHERE}. CLAUDE.md's rules are injected; these are the ones a stage most often misses:
- **Do not stage, commit, branch or push.** Change nothing in the repository: write only under ${OUT}/.
- Temporary files go under ${OUT}/ and nowhere else; run builds and tests with \`TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp\`. \`${VENV}\` runs \`spec/check.py\` and the generators; the toolchain: ${TOOLCHAIN}.
- Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
- Run a gate in the foreground, with a timeout that fits it (up to ten minutes); a run in the background only beside another you run at once, then one Monitor until-loop that waits on both, never sleeping and reading their output again and again.
- Before 1.0.0, a decision record or a released behaviour yields to a standard, an industry practice, a cleaner split, stability or clarity: name it and recommend the revision outright.
The change:
${SUBJECT}
`;

const OBJECTIONS = {
  type: 'object',
  properties: {
    objections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          remedy: { type: 'string' },
        },
        required: ['id', 'claim', 'evidence', 'remedy'],
      },
    },
  },
  required: ['objections'],
};

const REVISED = {
  type: 'object',
  properties: {
    design: { type: 'string' },
    rationale: { type: 'string' },
    accepted: { type: 'number' },
    partly: { type: 'number' },
    refused: { type: 'number' },
    summary_fr: { type: 'string' },
    decisions_for_the_user: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'design',
    'rationale',
    'accepted',
    'partly',
    'refused',
    'summary_fr',
    'decisions_for_the_user',
  ],
};

// * a small round has no draft: the subject, as written, is the proposal
let draft = args.draft;
let drafted = `The draft is ${draft}.`;
if (!draft && !SMALL) {
  phase('Draft');
  drafted = await agent(
    `${COMMON}
# Your task: draft (effort ${args.draftEffort || 'high'})
Read what the change names, on both sides and in the spec; probe what can be probed with the real code, scripts under ${OUT}/probes/. Then draft the change: what each side does today (file and line) and where they differ; what the standards say (name each: the RFC and its section, the well-known protocol); the change itself: the spec's text, the conformance cases to add or change (by file, name and units, generated, never written by hand), each side's change by file and line, the twin tests by name, the records, the rows of \`docs/support.md\`, and the CHANGELOG line it touches. Write ${OUT}/draft.md; return its path and a summary of ten lines.`,
    { label: `draft:${SLUG}`, phase: 'Draft', effort: args.draftEffort || 'high' }
  );
  draft = `${OUT}/draft.md`;
}
const PROPOSAL = SMALL ? 'the change as written above' : `the draft at ${draft}`;
const SUMMARY = SMALL ? '' : `\nThe draft's summary:\n${drafted}`;

phase('Tenth Man');
const dissent = await agent(
  `${COMMON}
# You are the Tenth Man (effort xhigh)
The others agree with ${PROPOSAL}. You are bound to disagree: argue that the consensus is wrong, wherever it is — the reading of a standard, a peer or a deployment the change breaks, what each platform lets a side control at all, where the two sides would still differ, a name, an order, a cost the proposal leaves out, a simpler design it passed over. Rerun any probe you doubt, under ${OUT}/tenth/. Every objection with its evidence; as many as it deserves, no padding. Write them also to ${OUT}/objections.md.${SUMMARY}`,
  {
    label: `tenth-man:${SLUG}`,
    phase: 'Tenth Man',
    effort: 'xhigh',
    schema: OBJECTIONS,
    ...(args.dissentModel ? { model: args.dissentModel } : {}),
  }
);

phase('Revise');
const revised = await agent(
  `${COMMON}
# Revise (effort high)
Read ${PROPOSAL} and the objections (also below). Answer each: accepted (and change the design), in part, or refused with its reason; verify each claim first. Write the revised design in two files, each stage of its implementation reading only what it needs:
- ${OUT}/design.md, the change itself and nothing else: first what every stage shares, under \`## Shared\` (the spec's text, the behaviour, the names, the order of the commits); then one section for each stage that implements it, headed \`## Stage: <key>\` with the key \`bead-implement-both-sides\` runs it under: \`spec\` (the spec, the conformance cases by file, name and units, the records, the rows of \`docs/support.md\`, the CHANGELOG line), \`typescript\`, \`csharp\`, \`rust\`, or a stage of the design's own; each section its files and lines, its twin tests by name, and what it must not touch;
- ${OUT}/rationale.md, the reasons beside it: what each side does today (file and line) and where they differ, the standards weighed (each named, the RFC and its section), the alternatives refused and why, and the Tenth Man table (Objection | Answer) as it lands in ${RECORD}'s \`## The Tenth Man\`, under a heading of its own.
List in \`decisions_for_the_user\` only a choice that no standard and no decision already taken settles, each with its options and your recommendation; an empty list when there is none. \`design\` and \`rationale\`: the paths you wrote. \`summary_fr\`: the design in six lines, and the objections accepted, in part and refused, in French.
The objections:
${JSON.stringify(dissent ? dissent.objections : [], null, 1)}`,
  { label: `revise:${SLUG}`, phase: 'Revise', effort: 'high', schema: REVISED }
);

// * the paths, the counts, the summary and the decisions: the objections stay in their file
return {
  draft: SMALL ? null : draft,
  objections: `${OUT}/objections.md`,
  raised: dissent ? dissent.objections.length : null,
  ...revised,
};
