export const meta = {
  name: 'bead-release-records',
  description:
    'Bring the decision records to a release: what landed stated in the present, what is past taken out, what is ahead kept ahead; records regrouped, moved, renamed or renumbered where it serves, every citation moved with them',
  whenToUse:
    'On a release/* branch, after `tools/release.mjs prepare` and before the finish, which prepare lists among what it owes by hand',
  phases: [
    {
      title: 'Plan',
      detail: 'the records against what the release carries: the plan and the numbers',
    },
    { title: 'Rewrite', detail: 'each batch of records, rewritten as of the release' },
    { title: 'Verify', detail: 'each batch held to the code and to what it decided' },
    { title: 'Integrate', detail: 'the files moved, the citations, the index, every gate' },
  ],
};

// args: { repo, scratch, venv, slug, version, since?, notes? }
// - version: the release the records are brought to, `0.4.0`;
// - since: the last release's tag (`v0.3.0`), the newest `v*` by default;
// - notes: what the stages need beyond this, in a few lines.
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
const VERSION = required('version');
const SINCE = args.since || 'the newest `v*` tag (`git tag --list "v*" --sort=-v:refname`)';
const OUT = `${SCRATCH}/${SLUG}`;
const TMP = `TMP=${SCRATCH}/tmp TEMP=${SCRATCH}/tmp`;

const COMMON = `
You work on Bead, at ${REPO}, on its release branch for ${VERSION}, checked out. The records are \`docs/decisions/*.md\` and their index \`docs/decisions/README.md\`. CLAUDE.md's rules are injected; these are the ones this work turns on:
- **A record is in the present, with its view on what is ahead.** At each release the present moves: what a record said was coming, and that ${VERSION} carries, is stated as what holds; what it said of how things were before, and what only the history of its making explains, leaves it — the CHANGELOG and the commits keep that; what is still ahead stays ahead, said as where Bead goes. A record says why, so that a reason outlives the person who held it: a reason, a cost, a constraint and a refused alternative stay.
- **Between two releases, records may be regrouped, moved, normalized, renamed and renumbered** where that makes them clearer: two records of one decision merged, a part that became a decision of its own split out, one theme's records brought together, a name that misleads renamed. Within a release, a number names one decision. A record's round of the Tenth Man stays with its decision: every objection and its answer, its wording compacted where it narrates.
- **Do not stage, commit, branch or push.** Temporary files go under ${OUT}/ alone; builds and tests run with \`${TMP}\`; \`${VENV}\` runs \`spec/check.py\`.
- Run \`node .claude/local/check.mjs <file>\` over every file you write, and never write a protected word.
- The released sections of \`CHANGELOG.md\` stay as they shipped (\`tools/check-versions.mjs\` holds them): an old number there is never changed.
${args.notes ? `${args.notes}\n` : ''}`;

const PLAN = {
  type: 'object',
  properties: {
    plan: { type: 'string' },
    renumber: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          file: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['from', 'to', 'file', 'why'],
      },
    },
    batches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          records: { type: 'array', items: { type: 'string' } },
          task: { type: 'string' },
        },
        required: ['key', 'records', 'task'],
      },
    },
  },
  required: ['plan', 'renumber', 'batches'],
};

const VERDICT = {
  type: 'object',
  properties: {
    batch: { type: 'string' },
    holds: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    left: { type: 'array', items: { type: 'string' } },
  },
  required: ['batch', 'holds', 'fixed', 'left'],
};

phase('Plan');
const planned = await agent(
  `${COMMON}
# Your task: the plan (effort xhigh)
Read every record whole, the index, CLAUDE.md, the CHANGELOG's section for ${VERSION}, and what changed since ${SINCE} (\`git log\`, \`git diff --stat\`, and the diff of each record and of what it cites). For each record, say what moves: the sentences that state as coming what ${VERSION} carries; what is past and leaves; what stays ahead; a record to merge, split, move, rename or renumber, and why it is clearer so. Keep a number where nothing gains by moving it: a renumbering costs every reader's memory, and is taken for a regrouping or an order that reads better, never for its own sake. Numbers stay dense from 0001, in the index's order of themes where they move.
Write ${OUT}/plan.md: the plan, record by record, and \`Where Bead goes\` as it is to read. Return \`renumber\`, every record whose number or file name changes (\`from\` and \`to\` as four digits, \`file\` its new name), and \`batches\`: the records in four or five batches of about equal weight, each a list of the file names as they are now, with the task for its rewriter: the moves this plan asks of those records, the merges and splits whole within one batch.`,
  { label: 'plan', phase: 'Plan', effort: 'xhigh', schema: PLAN }
);

const RENUMBER = JSON.stringify(planned ? planned.renumber : [], null, 1);

const results = await pipeline(
  planned ? planned.batches : [],
  (batch) => {
    return agent(
      `${COMMON}
# Your task: rewrite batch ${batch.key} (effort high)
The plan is ${OUT}/plan.md; its numbers, old to new:
${RENUMBER}
Your records: ${batch.records.join(', ')}. ${batch.task}
Write each record as it is to read at ${VERSION}, under ${OUT}/records/<its new file name>, and leave \`docs/decisions/\` as it is: the integration moves the files. A citation of a record, in yours, takes its new number and file name. Hold each sentence you state in the present to the code and the spec at the release branch's HEAD, reading the code; a claim that does not hold is fixed, never kept. Run \`node .claude/local/check.mjs\` over each file. Report, record by record, what moved, what you took out and why, and every claim you checked.`,
      { label: `rewrite:${batch.key}`, phase: 'Rewrite', effort: 'high' }
    );
  },
  (report, batch) => {
    return agent(
      `${COMMON}
# Your task: verify batch ${batch.key} (effort xhigh)
The plan is ${OUT}/plan.md; the numbers, old to new:
${RENUMBER}
The batch's records as they are, \`docs/decisions/\` (${batch.records.join(', ')}), and as rewritten, under ${OUT}/records/. Its rewriter's report:
${report}
Hold the rewrite to this, and fix in ${OUT}/records/ what fails:
- each decision, consequence, reason, cost, refused alternative and Tenth Man answer of the old records is in the new ones, or its leaving is a past the plan names;
- each sentence in the present holds at HEAD, read in the code and the spec, not in the report;
- nothing that ${VERSION} carries is still said as coming, and nothing still ahead is said as done;
- no sentence narrates how things were, or how the record came to be;
- every citation of a record is its new number and file name, and every link resolves once the files move.
Return \`holds\`, what you \`fixed\`, and what you \`left\` for the integration, each with its file and line.`,
      { label: `verify:${batch.key}`, phase: 'Verify', effort: 'xhigh', schema: VERDICT }
    );
  }
);

phase('Integrate');
const integration = await agent(
  `${COMMON}
# Your task: integrate (effort high)
The plan is ${OUT}/plan.md; the numbers, old to new:
${RENUMBER}
The verified records are under ${OUT}/records/. The verdicts:
${JSON.stringify(results.filter(Boolean), null, 1)}
1. Move the records into \`docs/decisions/\`: \`git mv\` a renamed or renumbered file, so its history follows, then write its content; remove a merged record's file.
2. Move every citation of a moved record across the repository, outside the released sections of the CHANGELOG: a link's target and text, a bare number (\`0017\`, \`[0017]\`, \`decision 0017\`, \`decisions 0017 and 0022\`) in prose, code comments, tests, the spec, the workflows, the READMEs, \`CLAUDE.md\` and \`docs/support.md\`. Do it by the map at once, never one number after another, so that a number that moves onto another's old one is never taken twice. Then grep every old number that moved and read each hit left: a released CHANGELOG section's, or no record's.
3. The index, \`docs/decisions/README.md\`: its tables and their themes, \`Where Bead goes\` as the plan writes it, and "The next decision is …".
4. The CHANGELOG's section for ${VERSION}, under Changed: one line that the records are brought to ${VERSION}, and, where numbers moved, the map from the old to the new, so that a reader of an earlier release finds each one.
5. The gates: \`node tools/check-format.mjs\`, \`node tools/check-links.mjs\`, \`node tools/check-versions.mjs\`, \`${VENV} spec/check.py\`, \`yarn check\` in \`implementations/typescript\` and in \`builder\` when a comment moved there, \`dotnet format Bead.slnx --verify-no-changes\` in \`implementations/dotnet\` when one moved there, and the names check over every file \`git status --porcelain\` lists.
Propose one commit, \`docs(decisions): the records as of ${VERSION}\`, its body one or two lines and no attribution, in ${OUT}/commit.txt, run \`node tools/check-commits.mjs --message\` and the names check over it. Return what moved, the map, each gate's result and what you could not settle.`,
  { label: 'integrate', phase: 'Integrate', effort: 'high' }
);

return { plan: planned, verdicts: results, integration };
