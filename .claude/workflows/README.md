# Workflows

The workflows of Claude sessions on Bead, each launched by its name with its arguments
(`Workflow({ name, args })`). A workflow writes only under `<scratch>/<slug>/`, outside the clone;
staging and committing stay with the session, and the decisions with the user.

A change that reaches across the languages runs a round of the Tenth Man, then the user decides,
then the design is implemented on both sides. A freeze runs an adversarial review first, and a release brings the records to itself.

| Workflow                    | What it does                                                                                                                                                                                                                                             | Its own arguments                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bead-tenth-man-round`      | a draft, its Tenth Man at xhigh, the revision with each objection answered; it stops there, with the decisions for the user                                                                                                                              | `subject`; `branch`, `record`, `draft`, `draftEffort`                                       |
| `bead-implement-both-sides` | the spec and its conformance first, then TypeScript and C# together (or the stages a design names), then the integration with every gate, and a commit plan or the design's series built in a clone                                                      | `design`, `branch`; `parts`, `stages`, `first`, `together`, `specEffort`, `series`, `notes` |
| `bead-adversarial-review`   | one reviewer per lens (max by default), each finding rerun by a verifier at xhigh, one synthesis by severity; the repository untouched                                                                                                                   | `scope`; `lenses`, `effort`                                                                 |
| `bead-release-records`      | on a release branch, before the finish: a plan of the records against what the release carries, each batch rewritten as of the release and verified at xhigh against the code, then the files moved, every citation renumbered, the index and every gate | `version`; `since`, `notes`                                                                 |
| `bead-builder-design`       | the API builder's design: three angles, a synthesis, the Tenth Man, the design document                                                                                                                                                                  | `repo`, `out`                                                                               |

The first three and `bead-release-records` also take `repo` (the clone), `scratch` (a folder outside it, with room for builds:
`TMP` and `TEMP` point there), `venv` (the Python that runs `spec/check.py` and the generators) and
`slug` (the folder under `scratch`). Each script's head states its arguments in full.

```js
Workflow({
  name: 'bead-tenth-man-round',
  args: {
    repo: 'D:/workspace/francisdesjardins/2025/bead',
    scratch: 'D:/workspace/francisdesjardins/2025/_scratch/session',
    venv: 'D:/workspace/francisdesjardins/2025/_scratch/venv/Scripts/python.exe',
    slug: 'handshake',
    branch: 'feature/websocket-handshake-refusals',
    record: '0020',
    subject:
      'What each WebSocket server answers to a malformed handshake, aligned on RFC 6455 §4.2.1 …',
  },
});
```
