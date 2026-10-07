export const meta = {
  name: 'bead-tenth-man-round',
  description:
    'A round of the Tenth Man on one change: drafted, met by one xhigh dissenter, revised with each objection answered; it stops there, for the user',
  whenToUse:
    "Every change that reaches across the languages or changes what every language's tests answer to (CLAUDE.md, the Tenth Man Rule), before it is implemented",
  phases: [
    { title: 'Draft', detail: 'what holds today, what the standards ask, the change' },
    { title: 'Tenth Man', detail: 'one xhigh dissenter' },
    { title: 'Revise', detail: 'each objection answered; the decisions for the user, if any' },
  ],
};

// args: { repo, scratch, venv, slug, subject, branch?, record?, draft?, draftEffort? }
// - subject: the change in full: what differs or what changes, the files and sections it touches,
//   the standards in play;
// - record: the decision record whose `## The Tenth Man` keeps the round, when it is known;
// - draft: the path of a draft written elsewhere, which skips the Draft stage;
// - draftEffort: 'high' by default, 'xhigh' for what is hard to undo (CLAUDE.md, the agents' effort).
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
const SUBJECT = required('subject');
const OUT = `${SCRATCH}/${SLUG}`;
const WHERE = args.branch ? `, on the branch \`${args.branch}\`` : '';
const RECORD = args.record
  ? `the decision record ${args.record}`
  : 'the decision record whose Scope holds the change (name it)';

const COMMON = `
You work on Bead, at ${REPO}${WHERE}. CLAUDE.md's rules are injected; these are the ones a stage most often misses:
- **Do not stage, commit, branch or push.** Change nothing in the repository: write only under ${OUT}/.
- Temporary files go under ${OUT}/ and nowhere else; run builds and tests with \`TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp\`. \`${VENV}\` runs \`spec/check.py\` and the generators.
- Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
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
    accepted: { type: 'number' },
    partly: { type: 'number' },
    refused: { type: 'number' },
    summary_fr: { type: 'string' },
    decisions_for_the_user: { type: 'array', items: { type: 'string' } },
  },
  required: ['design', 'accepted', 'partly', 'refused', 'summary_fr', 'decisions_for_the_user'],
};

let draft = args.draft;
let drafted = `The draft is ${draft}.`;
if (!draft) {
  phase('Draft');
  drafted = await agent(
    `${COMMON}
# Your task: draft (effort ${args.draftEffort || 'high'})
Read what the change names, on both sides and in the spec; probe what can be probed with the real code, scripts under ${OUT}/probes/. Then draft the change: what each side does today (file and line) and where they differ; what the standards say (name each: the RFC and its section, the well-known protocol); the change itself: the spec's text, the conformance cases to add or change (by file, name and units, generated, never written by hand), each side's change by file and line, the twin tests by name, the records, the rows of \`docs/support.md\`, and the CHANGELOG line it touches. Write ${OUT}/draft.md; return its path and a summary of ten lines.`,
    { label: `draft:${SLUG}`, phase: 'Draft', effort: args.draftEffort || 'high' }
  );
  draft = `${OUT}/draft.md`;
}

phase('Tenth Man');
const dissent = await agent(
  `${COMMON}
# You are the Tenth Man (effort xhigh)
The others agree with the draft at ${draft}. You are bound to disagree: argue that the consensus is wrong, wherever it is — the reading of a standard, a peer or a deployment the change breaks, what each platform lets a side control at all, where the two sides would still differ, a name, an order, a cost the draft leaves out, a simpler design it passed over. Rerun any probe you doubt, under ${OUT}/tenth/. Every objection with its evidence; as many as it deserves, no padding. Write them also to ${OUT}/objections.md.
The draft's summary:
${drafted}`,
  { label: `tenth-man:${SLUG}`, phase: 'Tenth Man', effort: 'xhigh', schema: OBJECTIONS }
);

phase('Revise');
const revised = await agent(
  `${COMMON}
# Revise (effort high)
Read ${draft} and the objections (also below). Answer each: accepted (and change the design), in part, or refused with its reason; verify each claim first. Write ${OUT}/design.md: the revised design whole, and its Tenth Man table (Objection | Answer) as it lands in ${RECORD}'s \`## The Tenth Man\`, under a heading of its own. List in \`decisions_for_the_user\` only a choice that no standard and no decision already taken settles, each with its options and your recommendation; an empty list when there is none. \`design\`: the path you wrote. \`summary_fr\`: the design in six lines, and the objections accepted, in part and refused, in French.
The objections:
${JSON.stringify(dissent ? dissent.objections : [], null, 1)}`,
  { label: `revise:${SLUG}`, phase: 'Revise', effort: 'high', schema: REVISED }
);

return { draft, objections: dissent ? dissent.objections : null, revised };
