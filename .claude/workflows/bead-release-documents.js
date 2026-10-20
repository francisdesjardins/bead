export const meta = {
  name: 'bead-release-documents',
  description:
    'Bring every document that states what holds and where Bead goes to a release: the records, the spec and its companion, the READMEs, the matrix, CLAUDE.md; what landed in the present, the past out, what is ahead kept ahead; records regrouped or renamed where clearer, a number never given again, every citation moved',
  whenToUse:
    'On a release/* branch, after `tools/release.mjs prepare` and before the finish, which prepare lists among what it owes by hand',
  phases: [
    {
      title: 'Plan',
      detail: 'the documents against what the release carries: the plan and the numbers',
    },
    { title: 'Rewrite', detail: 'each batch of documents, rewritten as of the release' },
    { title: 'Verify', detail: 'each batch held to the code and to what it states' },
    { title: 'Integrate', detail: 'the files moved, the citations, the indexes, every gate' },
  ],
};

// args: { repo, scratch, venv, slug, version, since?, notes? }
// - version: the release the documents are brought to, `0.4.0`;
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
You work on Bead, at ${REPO}, on its release branch for ${VERSION}, checked out. **The documents** are every tracked file that states what holds and where Bead goes: the decision records (\`docs/decisions/*.md\`) and their index, \`spec/spec.md\` and \`spec/debugging.md\`, \`docs/support.md\`, the READMEs (the root's, \`builder/\`'s, each implementation's, each example's), \`CLAUDE.md\` and \`.claude/workflows/README.md\`. Not the CHANGELOG's released sections, nor what a generator writes. CLAUDE.md's rules are injected; these are the ones this work turns on:
- **A document is in the present, with its view on what is ahead.** At each release the present moves: what a document said was coming, and that ${VERSION} carries, is stated as what holds; what it said of how things were before, and what only the history of its making explains, leaves it — the CHANGELOG and the commits keep that; what is still ahead stays ahead, said as where Bead goes. A record says why, so that a reason outlives the person who held it: a reason, a cost, a constraint and a refused alternative stay.
- **The spec and its companion move in form alone.** Their tense, their cross-references, an open point or a "to hold" that ${VERSION} closed, a sentence that narrates. A requirement whose meaning would change — a MUST, a SHOULD, a value, an order, a unit's scope — is never changed here: it is a finding for the user, since it needs its own round of the Tenth Man and touches the conformance. A clause's number moves only where the ledgers follow it, by a bare \`--write-units\`, and every conformance file's \`cites\` move with it, by their generators. No unit's text is acknowledged here: a unit whose text moved, even in form, is a finding for the user, with what plays it.
- **Between two releases, records may be regrouped, moved in the index, normalized and renamed** where that makes them clearer: two records of one decision merged, a part that became a decision of its own split out under the next number never given (the index's "The next decision is" line), one theme's records brought together in the index, a name that misleads renamed. **A number, once given, names its decision for good and is never given again** (\`docs/decisions/README.md\`): no record is renumbered, and a record merged into another keeps its file, a short one whose Status says \`merged into\` its successor and links it. Gaps in the numbering stay. A record's round of the Tenth Man stays with its decision: every objection and its answer, its wording compacted where it narrates.
- **Do not stage, commit, branch or push.** Temporary files go under ${OUT}/ alone; builds and tests run with \`${TMP}\`; \`${VENV}\` runs \`spec/check.py\` and the generators.
- Run \`node .claude/local/check.mjs <file>\` over every file you write, and never write a protected word.
- The released sections of \`CHANGELOG.md\` stay as they shipped (\`tools/check-versions.mjs\` holds them): an old number there is never changed.
${args.notes ? `${args.notes}\n` : ''}`;

const PLAN = {
  type: 'object',
  properties: {
    plan: { type: 'string' },
    moves: {
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
          documents: { type: 'array', items: { type: 'string' } },
          task: { type: 'string' },
        },
        required: ['key', 'documents', 'task'],
      },
    },
  },
  required: ['plan', 'moves', 'batches'],
};

const VERDICT = {
  type: 'object',
  properties: {
    batch: { type: 'string' },
    holds: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    left: { type: 'array', items: { type: 'string' } },
    forTheUser: { type: 'array', items: { type: 'string' } },
  },
  required: ['batch', 'holds', 'fixed', 'left', 'forTheUser'],
};

phase('Plan');
const planned = await agent(
  `${COMMON}
# Your task: the plan (effort xhigh)
Start from what changed since ${SINCE}: the CHANGELOG's section for ${VERSION}, \`git log\` and \`git diff --stat\`, and the diff of each document. **The documents in scope** are those whose files changed since ${SINCE}; those that cite a record, a section of the spec or a file that changed; and those a grep finds stating as ahead what the CHANGELOG's section lists (\`ahead\`, \`yet\`, \`until\`, \`will\`, \`planned\`, \`to come\`, the names of what landed). Read those whole; leave the others, naming them in the plan as out of scope and why. For each document in scope, say what moves: the sentences that state as coming what ${VERSION} carries; what is past and leaves; what stays ahead; in the spec, what moves in form and what is a finding for the user; a record to merge, split, move in the index or rename, and why it is clearer so. No record changes its number, and no number is given twice.
Write ${OUT}/plan.md: the plan, document by document, and the records' \`Where Bead goes\` as it is to read. Return \`moves\`, every record whose file changes, \`from\` and \`to\` as four digits and \`file\` a file name: a merged record, \`to\` its successor and \`file\` the successor's file; a renamed one, \`to\` its own number and \`file\` its new name; a part split out, \`from\` the record it leaves, \`to\` the next number never given and \`file\` its file; and \`batches\`: the documents in scope in as many batches as their weight needs, one to six, of about equal weight, the spec and its companion a batch of their own when either is in scope, its key \`spec\`, each a list of the file paths as they are now, with the task for its rewriter: the moves this plan asks of those documents, a record's merges and splits whole within one batch.`,
  { label: 'plan', phase: 'Plan', effort: 'xhigh', schema: PLAN }
);

const MOVES = JSON.stringify(planned ? planned.moves : [], null, 1);

const results = await pipeline(
  planned ? planned.batches : [],
  (batch) => {
    return agent(
      `${COMMON}
# Your task: rewrite batch ${batch.key} (effort high)
The plan is ${OUT}/plan.md; the records' moves (merged, renamed, split out):
${MOVES}
Your documents: ${batch.documents.join(', ')}. ${batch.task}
Write each as it is to read at ${VERSION} under ${OUT}/documents/, at its path from the repository's root (a renamed record at its new file name, a merged one as its short file naming its successor, a part split out at its new file), and leave the repository as it is: the integration moves the files. A citation of a merged record, in yours, names its successor; of a renamed one, its new file name. Hold each sentence you state in the present to the code and the spec at the release branch's HEAD, reading the code; a claim that does not hold is fixed, never kept. Run \`node .claude/local/check.mjs\` over each file. Report, document by document, what moved, what you took out and why, every claim you checked, and, for the spec, each requirement you left for the user.`,
      { label: `rewrite:${batch.key}`, phase: 'Rewrite', effort: 'high' }
    );
  },
  (report, batch) => {
    return agent(
      `${COMMON}
# Your task: verify batch ${batch.key} (effort ${batch.key === 'spec' ? 'xhigh' : 'high'})
The plan is ${OUT}/plan.md; the records' moves (merged, renamed, split out):
${MOVES}
The batch's documents as they are in the repository (${batch.documents.join(', ')}), and as rewritten, under ${OUT}/documents/. Its rewriter's report:
${report}
Hold the rewrite to this, and fix under ${OUT}/documents/ what fails:
- each decision, consequence, reason, cost, refused alternative and Tenth Man answer of the old records is in the new ones, or its leaving is a past the plan names;
- in the spec and its companion, no requirement changed its meaning: \`git diff --word-diff\` of old against new, each changed MUST, SHOULD, MAY, value, order or scope put back and named in \`forTheUser\`;
- each sentence in the present holds at HEAD, read in the code and the spec, not in the report;
- nothing that ${VERSION} carries is still said as coming, and nothing still ahead is said as done;
- no sentence narrates how things were, or how the document came to be;
- every citation of a merged record names its successor, of a renamed one its new file name, and every link resolves once the files move; no number is given twice.
Return \`holds\`, what you \`fixed\`, what you \`left\` for the integration, each with its file and line, and \`forTheUser\`.`,
      // * xhigh where a requirement's meaning could move unseen, the spec and its companion; high
      // for the records and the READMEs, whose claims the verifier holds to the code
      {
        label: `verify:${batch.key}`,
        phase: 'Verify',
        effort: batch.key === 'spec' ? 'xhigh' : 'high',
        schema: VERDICT,
      }
    );
  }
);

phase('Integrate');
const integration = await agent(
  `${COMMON}
# Your task: integrate (effort high)
The plan is ${OUT}/plan.md; the records' moves (merged, renamed, split out):
${MOVES}
The verified documents are under ${OUT}/documents/. The verdicts:
${JSON.stringify(results.filter(Boolean), null, 1)}
1. Move the documents into the repository: \`git mv\` a renamed record, so its history follows, then write its content; write a merged record's file as its short note naming its successor, never removing it; write each other document over its path.
2. Move every citation of a moved record across the repository, outside the released sections of the CHANGELOG: a link's target and text, a bare number (\`0017\`, \`[0017]\`, \`decision 0017\`, \`decisions 0017 and 0022\`) in prose, code comments, tests, the spec, the workflows, the READMEs, \`CLAUDE.md\` and \`docs/support.md\`. A merged record's citation names its successor where it means the decision as it holds; a renamed one's link takes its new file. Then grep every merged number and read each hit left: a released CHANGELOG section's, the merged record's own short file, or a citation that rightly names the decision as it was.
3. The records' index, \`docs/decisions/README.md\`: its tables and their themes, \`Where Bead goes\` as the plan writes it, and "The next decision is …".
4. The CHANGELOG's section for ${VERSION}, under Changed: one line that the documents are brought to ${VERSION}, and, where records merged, each merged number and its successor, so that a reader of an earlier release finds each one.
5. The gates: every generator of \`spec/generators/\` the README lists and \`${VENV} spec/check.py --write-units\`, which follows a renumbered key and acknowledges no text, then \`${VENV} spec/check.py\`, nothing moving but what a clause's move asks, each unit whose text moved a finding for the user; \`node tools/check-format.mjs\`, \`node tools/check-links.mjs\`, \`node tools/check-versions.mjs\` (a spec or companion that changed and whose version prepare did not move is a finding for the user: \`node tools/release.mjs prepare\` is run again with its move, never here); \`yarn check\` in \`implementations/typescript\` and in \`builder\` when a comment moved there; \`dotnet format Bead.slnx --verify-no-changes\` in \`implementations/dotnet\` when one moved there; the names check over every file \`git status --porcelain\` lists.
Propose one commit, \`docs: the documents as of ${VERSION}\`, its body one or two lines and no attribution, in ${OUT}/commit.txt; run \`node tools/check-commits.mjs --message\` and the names check over it. Return what moved, the map, each gate's result, and every finding for the user, the verifiers' among them.`,
  { label: 'integrate', phase: 'Integrate', effort: 'high' }
);

return { plan: planned, verdicts: results, integration };
