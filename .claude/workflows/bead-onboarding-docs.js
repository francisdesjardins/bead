export const meta = {
  name: 'bead-onboarding-docs',
  description:
    'Write or refresh the task-oriented guides under docs/guides/ for teams adopting Bead outside its repository (a C# server, a TypeScript client): the facts gathered with their sources, a project built and run from them outside the repository, the guides written from that project alone, every claim and snippet verified',
  whenToUse:
    'When the guides are first written, and at each release after bead-release-documents, since a guide states what holds',
  phases: [
    { title: 'Facts', detail: 'what the sources say, each with its file and line' },
    { title: 'Prove', detail: 'a project built and run outside the repository from the facts' },
    { title: 'Write', detail: 'the guides and the README link, from the proven project alone' },
    { title: 'Verify', detail: 'each claim and snippet held to the facts and the project' },
  ],
};

// args: { scenario?, notes?, slug?, repo?, scratch?, toolchain? }
// - scenario: the example the guides build, in a few lines (its service, its procedures); a
//   station's status, an operator's prompt and a telemetry watch by default;
// - notes: what the stages need beyond this, in a few lines;
// - slug: the folder under `scratch`, `onboarding-docs` by default;
// - repo, scratch, toolchain: the clone (on the branch the guides land on), a folder outside it,
//   and what goes first on PATH, this machine's by default.
const ARGS = args || {};
const REPO = ARGS.repo || 'D:/workspace/francisdesjardins/2025/bead';
const SCRATCH = ARGS.scratch || 'D:/workspace/francisdesjardins/2025/_scratch';
const OUT = `${SCRATCH}/${ARGS.slug || 'onboarding-docs'}`;
const TOOLCHAIN =
  ARGS.toolchain ||
  `\`${SCRATCH}/dotnet-10.0.404\` first on PATH and \`DOTNET_ROOT\` it, \`NO_COLOR\` unset for Node`;
const SCENARIO =
  ARGS.scenario ||
  'One service, StationService: a unary call GetStationStatus whose request carries protovalidate rules; a server-to-client command PromptOperator the server sends its client mid-call before it answers; and a client-paced notification WatchTelemetry, the client crediting it by a window. A C# (.NET 10) server over WebSocket, a TypeScript client in a browser page and in Node.';

const COMMON = `
You work on Bead's guides for teams that adopt it outside its repository, at ${REPO}. The guides live under docs/guides/ and are read by senior and mid-level application developers (C# and TypeScript) who build real-time systems and dashboards: they know protobuf's basics, not RFC 2119 or framing. The guides are organized by what a developer wants to do, never by protocol layer.
Rules every stage holds:
- **Never invent a name.** Every command, option, \`beadc.yaml\` key, generated type, method and package name comes from the repository as it is (builder/README.md, examples/hello/, builder/test/golden/, the implementations' READMEs and sources), cited by file and line in the stage's report.
- **Say plainly what is ahead.** Nothing is published to npm, NuGet, crates.io or a registry: a team builds beadc's image locally and takes the runtimes from a pinned commit or a local build, as the root README says; docs/support.md says what each side plays and what is ahead. The repository's documents speak of the future plainly, with no date or condition.
- A snippet's comments follow CLAUDE.md's comment tags (\`!\`, \`?\`, \`TODO\`, \`*\`, or plain).
- Temporary files and the proving project live under ${OUT}/, never in the repository; the toolchain: ${TOOLCHAIN}. Run \`node .claude/local/check.mjs <file>\` from ${REPO} over every file you write, and never write a protected word.
- Do not stage, commit, branch or push.
The scenario the guides build: ${SCENARIO}
${ARGS.notes ? `${ARGS.notes}\n` : ''}`;

phase('Facts');
const facts = await agent(
  `${COMMON}
# Your task: the facts (effort high)
Read builder/README.md (beadc init, generate, check, breaking, wrapper, beadc.yaml's keys, bead/options.proto's options), examples/hello/ whole (its README, proto, beadc.yaml, dotnet/ and typescript/ halves, pairs.mjs), builder/test/golden/ where a target's generated names show, implementations/typescript/README.md and implementations/dotnet/README.md (clients, servers, transports, admission hooks and JWTs, reconnection, metrics and their exposition, debugging, the DevTools extension), docs/support.md (what each side plays, what is ahead), and the root README's distribution note. Write ${OUT}/facts.md: for each thing the guides will say, the fact as the sources state it and its file:line; the exact option syntax for a command and a notification in a .proto; beadc.yaml's real shape for an output of a C# server and an output of a TypeScript client; the generated C# and TypeScript names for a service's server, client, command, notification and window as hello shows them; how a .NET host mounts the WebSocket transport and exposes metrics for Prometheus; how a page's client is inspected in DevTools; how a team takes the runtimes and beadc today. Then list what the scenario needs that the sources do not settle. Return at most ten lines and that path.`,
  { label: 'facts', phase: 'Facts', effort: 'high' }
);

phase('Prove');
const proved = await agent(
  `${COMMON}
# Your task: prove the scenario (effort high)
From ${OUT}/facts.md alone, build the scenario as a team would, outside the repository, under ${OUT}/project/: \`beadc init\` (by the local image or the builder run from the repository, as the facts say a team does today), the .proto with its rules and options, beadc.yaml with a C# server output and a TypeScript client output, \`beadc generate\`, a .NET 10 server over WebSocket that answers GetStationStatus after sending PromptOperator to its caller, and notifies WatchTelemetry; a TypeScript client in Node that answers the command, calls, and follows the subscription with a window of 1; the runtimes referenced from the repository by path or a local build, as the facts say. Run it: the unary call with a valid and an invalid request (its PAYLOAD_INVALID), the command round trip, and the paced subscription, each with its output kept in ${OUT}/project/run.log. Where a fact is wrong, correct ${OUT}/facts.md and say so. Write ${OUT}/proved.md: what you built, every file's path, the exact commands, the outputs, and each place the facts or the scenario had to change. Return at most ten lines and that path.
The facts stage said: ${facts || '(none)'}`,
  { label: 'prove', phase: 'Prove', effort: 'high' }
);

phase('Write');
const written = await agent(
  `${COMMON}
# Your task: write the guides (effort high)
From ${OUT}/facts.md and the proven project ${OUT}/project/ (its files copied, never retyped from memory), write into ${REPO}:
1. docs/guides/getting-started.md: an end-to-end walkthrough from an empty folder (beadc init) to a running C# server and TypeScript client with a unary call (its rules), a paced subscription and a server-to-client command, each snippet the proven project's; the distribution note first, plainly.
2. docs/guides/cookbook-realtime.md: recipes for JWT authentication through admission hooks, a connection's lifecycle and reconnection, Prometheus metrics in .NET, and inspecting a page's client in Chrome's DevTools, each from the facts, a snippet only where the facts or the project hold it.
3. docs/guides/architecture-overview.md: the mental model, .proto to blueprint to beadc.yaml to targets, as a diagram (Mermaid, which GitHub renders), and a decision matrix of Bead against gRPC-Web, Connect and SignalR, each cell a fact of Bead's sources or of the other's own public documentation, with its link; no claim about another project that its documentation does not make.
4. The root README.md: a prominent "Getting started for teams" link to docs/guides/getting-started.md, right after its "At a glance".
5. A line under the CHANGELOG's [Unreleased] ### Added.
Then: \`node tools/check-links.mjs\`, \`node tools/check-format.mjs\`, \`node tools/check-citations.mjs\` if a guide cites a test, and the names check over each file. Write ${OUT}/written.md: each file, what it holds, the gates. Return at most ten lines.
The proving stage said: ${proved || '(none)'}`,
  { label: 'write', phase: 'Write', effort: 'high' }
);

phase('Verify');
const verified = await agent(
  `${COMMON}
# Your task: verify the guides (effort high)
Read docs/guides/*.md and the README's new link in ${REPO}. Hold each claim to ${OUT}/facts.md and the repository's sources, and each snippet to ${OUT}/project/ (byte for byte where it is a file of it, by its names otherwise): a name the sources do not have, a step the project did not run, a feature said to hold that docs/support.md says is ahead, a comparison with gRPC-Web, Connect or SignalR their documentation does not support. Fix what fails in place, and rerun the gates (\`node tools/check-links.mjs\`, \`node tools/check-format.mjs\`, the names check). Write ${OUT}/verified.md: each finding, what you fixed, what you left and why. Return, in French, at most twelve lines: the guides written, the findings fixed, any left, the gates.
The writing stage said: ${written || '(none)'}`,
  { label: 'verify', phase: 'Verify', effort: 'high' }
);

return { facts: `${OUT}/facts.md`, proved: `${OUT}/proved.md`, summary: verified };
