# Workflows

The workflows of Claude sessions on Bead, each launched by its script's path with its arguments
(`Workflow({ scriptPath, args })`), which runs the script as the clone holds it. Every workflow but
`bead-builder-design` writes its drafts and reports under `<scratch>/<slug>/`, outside the clone.
`bead-builder-design` writes its design to `out`, under the clone's `.claude/local/` by default.
Four leave their end state in the clone's working tree, unstaged: `bead-implement-both-sides`,
`bead-release-documents`, `bead-page-audit` with `apply` (its fixes in `site/`) and
`bead-onboarding-docs` (its guides under `docs/guides/`, their link in the root README and a line of
the CHANGELOG). Staging and committing stay with the session, and the decisions with the user.

Each stage writes its report whole to disk, `<scratch>/<slug>/reports/<key>.md` or the file it is
there to write (a draft, the objections, a design, a lens's findings), and returns ten lines at
most: what it did, the gates' verdicts, where its report is. A later stage reads the files. A
workflow returns the paths, the counts, its French summary where it has one and the decisions for
the user, never a whole plan, a stage's report or the objections themselves.

A change that reaches across the languages runs a round of the Tenth Man, then the user decides,
then the design is implemented. A freeze runs an adversarial review first, and a release brings its documents to itself.

A small change, CLAUDE.md's small round (one behaviour, a few files on each side, no new record),
runs `bead-tenth-man-round` with `small: true`: no Draft stage, the Tenth Man meets `subject` as it
is written, so the subject is then the proposal whole (what each side does, by file and line,
the standards, the change on each side, the twin tests), and Revise writes the design. Every other
change, and one whose subject is still a question, has its draft.

| Workflow                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Its own arguments                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `bead-tenth-man-round`      | a draft, its Tenth Man at xhigh, the revision with each objection answered, written as `design.md` (a shared part, then a section a stage) and `rationale.md` (the reasons, the Tenth Man's table); it stops there, with the decisions for the user                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `slug`, `subject`; `branch`, `record`, `draft`, `draftEffort`, `small`, `dissentModel`                                           |
| `bead-implement-both-sides` | the spec and its conformance first, then TypeScript and C# together, Rust beside them where the design reaches it (or the stages a design names), each without the interop between the sides, then the integration with every gate, the interop run once there, its suites run locally or left to CI on the pushed feature branch, and a commit plan or the design's series built in a clone, each commit held to the fast gates and its build, the last one's tree the one every gate ran over                                                                                                                                                                                                                                                        | `slug`, `design`, `branch`; `parts`, `stages`, `first`, `together`, `specEffort`, `series`, `suites`, `notes`, `integrationNote` |
| `bead-adversarial-review`   | one reviewer per lens (max on the spec and its companion, xhigh on the code), each finding put to the code by a verifier at xhigh, a blocker's and a major's proof rerun, one synthesis by severity; the repository untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `scope`; `lenses` (each its own `effort`), `effort`, `model`, `serial`, `slug`                                                   |
| `bead-release-documents`    | on a release branch, before the finish: a plan of the documents that state where Bead goes (the records, the spec and its companion, the READMEs, the matrix, `CLAUDE.md`), those in scope by what changed since the last release, against what the release carries, at xhigh where `regroup` merges, splits or renames records, each batch rewritten as of the release and its diff verified against the code, nothing lost, the spec's at xhigh, a requirement's meaning never moved but put to the user, then the files moved, every citation of a moved record pointed where it now lives (a merged record's to its successor, a renamed one's to its new file, a split part's to its new record), no number given twice, the index and every gate | `version`; `since`, `regroup`, `notes`, `serial`, `page`, `planOnly`, `model`, `slug`                                            |
| `bead-page-audit`           | the page beadproto.dev serves, held to the repository in both languages: each batch of sections audited, each finding verified, one synthesis that accounts for every section; with `apply`, the fixes written into `site/`, the diagrams that moved rendered, the page rebuilt and looked at, left unstaged                                                                                                                                                                                                                                                                                                                                                                                                                                           | `slug`, `batches`, `apply`, `serial`, `effort`, `notes`                                                                          |
| `bead-onboarding-docs`      | the guides under `docs/guides/` for teams that adopt Bead outside its repository: the facts gathered with their sources, a project built and run from them outside the repository, the guides written from that project alone, each claim and snippet verified; it runs at each release after `bead-release-documents`                                                                                                                                                                                                                                                                                                                                                                                                                                 | `scenario`, `notes`, `slug`                                                                                                      |
| `bead-builder-design`       | the API builder's design: three angles, a synthesis, the Tenth Man, the design document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `repo`, `out`                                                                                                                    |

Every script but `bead-builder-design` also takes `repo` (the clone), `scratch` (a folder outside
it) and `slug` (the folder under `scratch`). Four take `venv` (the Python that runs `spec/check.py`
and the generators) and `toolchain` (what goes first on PATH) as well: `bead-tenth-man-round`,
`bead-implement-both-sides`, `bead-adversarial-review` and `bead-release-documents`. Their builds
run with `TMP` and `TEMP` at `<scratch>/tmp`. `bead-onboarding-docs` takes `toolchain` and no
`venv`, and `bead-page-audit` takes neither. `bead-builder-design` takes `repo` and `out` alone.
`repo`, `scratch`, `venv` and `toolchain` are this machine's by default. A `model` names the model
of the stages at xhigh or max where it is not the session's, none by default: the user asks for it,
or a session proposes it with its reason. Each script's head states its arguments in full.

`bead-release-documents` runs `bead-page-audit` with `apply` once the documents are written, so that
the page states the release as they do; its plan gives a batch only to a document with a sentence
that moves, and its integration settles what the code, a standard or the plain reading settles,
leaving the user the real choices.

```js
Workflow({
  scriptPath: 'D:/workspace/francisdesjardins/2025/bead/.claude/workflows/bead-tenth-man-round.js',
  args: {
    repo: 'D:/workspace/francisdesjardins/2025/bead',
    scratch: 'D:/workspace/francisdesjardins/2025/_scratch/session',
    venv: 'D:/workspace/francisdesjardins/2025/_scratch/venv/Scripts/python.exe',
    slug: 'handshake',
    branch: 'feature/websocket-handshake-refusals',
    record: '0010',
    subject:
      'What each WebSocket server answers to a malformed handshake, aligned on RFC 6455 §4.2.1 …',
  },
});
```
