export const meta = {
  name: 'bead-page-audit',
  description:
    'Hold every claim of the Bead page beadproto.dev serves to the repository, in English and in French: each batch of sections audited, each finding verified, one synthesis; with `apply`, the fixes written into site/ and the page rebuilt',
  whenToUse:
    'At each release, from bead-release-documents; and whenever what the page states may have drifted from the code, the matrix or the records',
  phases: [
    { title: 'Audit', detail: 'each batch of sections, both languages, against the repository' },
    { title: 'Verify', detail: 'each finding put back to the page and the repository' },
    { title: 'Synthesize', detail: 'the findings kept, every section accounted for' },
    { title: 'Apply', detail: 'with `apply`: the fixes in both languages, the page rebuilt' },
  ],
};

// args: { slug?, batches?, apply?, serial?, effort?, notes?, repo?, scratch? }
// - slug: the folder under `scratch`, `page-audit` by default;
// - batches: [{ key, sections, extra? }], the page's sections by their ids, the four below by
//   default; the synthesis names any section of the page no batch held;
// - apply: true writes the fixes the synthesis keeps into site/, both languages alike, renders the
//   diagrams that moved and rebuilds the page, leaving it unstaged; read-only otherwise;
// - serial: one batch at a time, audited then verified, where the quota asks it;
// - effort: the auditors' and verifiers', 'high' by default;
// - notes: what the stages need beyond this, in a few lines;
// - repo, scratch: the clone and a folder outside it, this machine's by default.
const ARGS = args || {};
const REPO = ARGS.repo || 'D:/workspace/francisdesjardins/2025/bead';
const SCRATCH = ARGS.scratch || 'D:/workspace/francisdesjardins/2025/_scratch';
const OUT = `${SCRATCH}/${ARGS.slug || 'page-audit'}`;
const EFFORT = ARGS.effort || 'high';

const BATCHES = ARGS.batches || [
  {
    key: 'a',
    sections:
      'the eyebrow and title above the first section, essentiel, pourquoi, enveloppe, callid, echecs, porte',
    extra:
      'src/data.mjs where these sections draw their byte examples and tables, and their diagrams',
  },
  {
    key: 'b',
    sections: 'regles, annulation, abonnements, sessions, transferts, relais',
    extra: 'their diagrams, and src/data.mjs where they draw from it',
  },
  {
    key: 'c',
    sections: 'http, memoire, courtier, transcodage, securite, debogage',
    extra: 'their diagrams, and src/data.mjs where they draw from it',
  },
  {
    key: 'd',
    sections: 'versions, implantations, methode, suite, code',
    extra:
      'src/snippets/, each excerpt against the source file it shows; their diagrams; and the words around the facts build.mjs reads (versions, conformance counts)',
  },
];

const COMMON = `
You hold to the repository the page beadproto.dev serves, built from ${REPO}/site/: its content is site/src/content.en.html and site/src/content.fr.html (its sections by \`<section id="…">\`, the same ids in both), its tables and byte examples site/src/data.mjs, its snippets site/src/snippets/, its diagrams' Mermaid sources site/diagrams/en and site/diagrams/fr. A \`{{fact of="…"}}\` is filled by site/build.mjs from the repository and holds by construction; the words around it do not.
The page is written for a hiring reader. It must hold in every point, today: what each side (TypeScript, C#, Rust) does, what is ahead and in what order, numbers, names, codes, byte values, the standards it cites, and the French saying what the English says.
- The truth is the repository, read at its HEAD: spec/spec.md and its companions, the conformance files, docs/support.md (what each side plays, what is ahead), docs/decisions/ and their index's "Where Bead goes", the READMEs, CHANGELOG.md, and the code of implementations/typescript, implementations/dotnet, implementations/rust and builder/. Cite file:line for each truth.
- What is ahead is said plainly, with no date or condition. A claim the page leaves out is a finding only where its absence makes what it says false or misleading, as a table of what a side does that omits what it does.
- Temporary files go under ${OUT}/ alone. Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
${ARGS.notes ? `${ARGS.notes}\n` : ''}`;

const READ_ONLY =
  '- Change nothing in the repository; do not stage, commit or branch. Write only under the folder above.';

const audit = (batch) => {
  return agent(
    `${COMMON}${READ_ONLY}
# Your task: audit batch ${batch.key} (effort ${EFFORT})
In both languages, the sections ${batch.sections}${batch.extra ? `; and ${batch.extra}` : ''}. Check every factual claim, one by one, against the repository, and say what you checked and found true, so that silence means something. For each finding: an id (\`${batch.key}-<n>\`), its section and lines (content.en.html:N, content.fr.html:N), what the page says, what holds with its evidence (file:line), its kind (false, stale, misleading, missing, the French apart from the English, a typo), and its fix in both languages, in the page's own voice.
Write ${OUT}/audit-${batch.key}.md and return at most eight lines: what you covered, the findings by kind, that path.`,
    { label: `audit:${batch.key}`, phase: 'Audit', effort: EFFORT }
  );
};

const verify = (summary, batch) => {
  return agent(
    `${COMMON}${READ_ONLY}
# Your task: verify batch ${batch.key} (effort ${EFFORT})
Read ${OUT}/audit-${batch.key}.md. Put each finding back to the page and to the repository: confirmed, partly or refuted, refuted where the evidence does not hold. Hold each fix: it is itself true, and its French says what its English says. Write ${OUT}/verify-${batch.key}.md (a table Id | Verdict | In short, then each kept finding's fix, corrected, in both languages) and return at most eight lines: the counts by verdict, that path.
The auditor's summary: ${summary || '(none)'}`,
    { label: `verify:${batch.key}`, phase: 'Verify', effort: EFFORT }
  );
};

const serially = async () => {
  for (const batch of BATCHES) {
    await verify(await audit(batch), batch);
  }
};

// * each batch's findings and verdicts on disk, which the synthesis reads
await (ARGS.serial ? serially() : pipeline(BATCHES, audit, verify));

phase('Synthesize');
const files = BATCHES.map((batch) => {
  return `audit-${batch.key}.md, verify-${batch.key}.md`;
}).join('; ');
const synthesis = await agent(
  `${COMMON}${READ_ONLY}
# Your task: synthesize (effort ${EFFORT})
Read, in ${OUT}/, ${files}. List every \`<section id>\` of content.en.html and name any no batch held, with the eyebrow and the title, and audit those yourself. Write ${OUT}/report.md: the findings kept (confirmed or partly), duplicates merged, in the page's order, each with its lines, its evidence, and its fix in English and in French exactly as it is to be written into content.en.html, content.fr.html, data.mjs, a snippet or a diagram's source; then the refuted ones, a line each with why, the fixes' HTML as the files hold it, never escaped. Return, in French, at most twelve lines: the counts, each kept finding in one line, any section no batch held. Where the harness refuses you the file, return those lines, then a line \`===== report.md =====\`, then the report whole: the next stage reads it from there.`,
  { label: 'synthesize', phase: 'Synthesize', effort: EFFORT }
);

if (!ARGS.apply) {
  return { report: `${OUT}/report.md`, synthesis };
}

phase('Apply');
const applied = await agent(
  `${COMMON}
# Your task: apply (effort ${EFFORT})
Write each fix ${OUT}/report.md keeps into site/ (where that file is missing, the report is the text after \`===== report.md =====\` below): content.en.html and content.fr.html alike, data.mjs, a snippet, a diagram's source in both languages. Then, from site/, \`node render.mjs\` for a diagram whose source moved (it needs the Yarn project's Mermaid, a Chromium and the site's faces: README.md's "The page" says how; where it cannot run, say so and leave the diagram's fix for the session), \`node build.mjs\` and \`node check.mjs\`. Look at each section you changed, in both languages, in both themes, on a desktop and a phone width (Playwright from implementations/typescript, its screenshots under ${OUT}/shots/), and fix what breaks. Run the names check over every file \`git status --porcelain\` lists. Do not stage, commit, branch or push. Write ${OUT}/applied.md: each fix written, each left and why, the gates. Return at most ten lines.
The synthesis's return:
${synthesis || '(none)'}`,
  { label: 'apply', phase: 'Apply', effort: EFFORT }
);

return { report: `${OUT}/report.md`, applied: `${OUT}/applied.md`, synthesis, summary: applied };
