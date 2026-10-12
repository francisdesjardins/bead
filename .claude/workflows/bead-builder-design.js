export const meta = {
  name: 'bead-builder-design',
  description:
    "Design Bead's API builder: .proto in, a typed server per language where only handlers are written, and a matching client",
  whenToUse: 'Phase 5a of the plan, .claude/local/plan.md: the design of the API builder',
  phases: [
    { title: 'Design', detail: 'three angles' },
    { title: 'Synthesize', detail: 'one design' },
    { title: 'Tenth man', detail: 'one agent bound to disagree' },
    { title: 'Answer', detail: 'every objection answered; the design document written' },
  ],
};

// args: { repo, out }
const REPO = (args && args.repo) || 'D:/workspace/francisdesjardins/2025/bead';
const OUT = (args && args.out) || `${REPO}/.claude/local/builder/design.md`;

const CONTEXT = `
You are designing the API builder of Bead, a binary wire protocol with a normative spec (spec/spec.md), conformance files (spec/vectors.json, spec/conversations.json, spec/transports.json, spec/clocks.json, spec/durations.json, spec/interop-service.json; and, beside the wire's spec, spec/debugging.md with spec/debug-filters.json and spec/metrics.json), and two implementations at behavioural parity: implementations/typescript and implementations/dotnet. The repository is ${REPO}.
Read first:
- ${REPO}/.claude/local/plan.md (phase 5) and the builder's inputs in ${REPO}/.claude/local/builder/: api-builder.md (with the synthesis on the builder at its end) and inspiration.md;
- the runtimes: how a service, its procedures and its notifications are declared and offered today on both sides (the interop service: offer.ts, InteropService.cs).

THE USER'S DIRECTION, which is not up for debate in this design:
- Input: .proto files, services and messages.
- Output, per language: a server class that already knows its API, where the developer only writes the handlers, and a client that matches it and is ready to use. For example:
    const server = new BeadServerWithAPIv3();
    server.on('getSomeList', (req, res) => { /* only this is written */ });
- Distributed as a CLI in a Docker image that only generates.

Constraints:
- Bead's wire carries numeric service and procedure ids, never names.
- Payloads are opaque to Bead; today they are JSON, text, or raw bytes (an 8 MiB glyph must stay RAW).
- Notifications are paced subscriptions, not streams.
- A request runs in its call's session (decision 0010), which a synchronous admission reads; the builder's admission vocabulary (NONE, SESSION, HOOK(name)) binds to that session once resolved, as 0010 says. Credentials (a JWT's keys and key set, an ELSEWHERE verifier) are the runtime's configuration, never generated.
- A procedure a side calls is declared once to its router (decision 0013: declareRequester / DeclareRequester, a resolver at registration), which makes its metrics series; generated code declares each requester and resolver once.
- The identity rules of names and ids (the plan's xhigh item) are not decided yet: the design says what it needs of them, and does not settle them.
- The C# side has no base classes to inherit (decision 0007: interfaces and composition).
- Settled by the Tenth Man on names (plan.md): the CLI is \`beadc\`, as \`bead\` is taken on npm, PyPI and crates.io; generated C# qualifies every Bead type as \`global::Bead.…\`, since \`HealthStatus\` collides with ASP.NET's (CS0104); package ids are owner-qualified when published, \`@francisdesjardins/bead\` on npm and \`FrancisDesjardins.Bead.*\` on NuGet; the proto package and extension numbers are reserved in protobuf's global registry when the v1 options freeze.
- Follow CLAUDE.md and the rules it imports, the names rule first.
- This is a design: do not modify the repository, except the one document the last stage writes.`;

phase('Design');
const ANGLES = [
  {
    key: 'front-end',
    angle: `THE FRONT END ON DESCRIPTORS:
- protoc plugin, buf, or descriptor set? Which library in which language?
- Bead's custom options in a bead/options.proto: service id, procedure id, notification message, pacing, encoding RAW/TEXT/JSON/PROTO, deprecation, admission.
- What \`beadc check\` validates: ids unique, non-zero and in range; reserved ids; notifications well paired; names unique per case-folding.
- What \`beadc breaking\` refuses, borrowing from buf breaking.
- How .proto constructs map onto Bead: unary rpc, a notification, a server-to-client command; \`stream\` reserved.`,
  },
  {
    key: 'model-conformance',
    angle: `THE INTERMEDIATE MODEL AND CONFORMANCE:
- bead-blueprint/1 as the neutral model the front end produces and every template reads, descending from interop-service.json.
- Its schema, and its identity rules in the spec.
- How the interop service is written in .proto and regenerated, accepted only if all of these hold: the conversations (142 today) and the interop, both ways, pass unchanged; make_conversations.py reproduces conversations.json byte for byte; offer.ts and InteropService.cs are replaced by generated code.
- How a third language plugs in its templates.`,
  },
  {
    key: 'developer-experience',
    angle: `THE DEVELOPER EXPERIENCE, in TypeScript and C#:
- What the generated server looks like (\`server.on('getSomeList', (req, res) => …)\`, typed request and response, the API's name in the class), and what an unregistered rpc answers: a typed "unimplemented", never silence.
- How a handler fails, how a notification is published (typed notify), and how admission and sessions show up.
- What the generated client looks like (typed calls, options, notifications with pacing, cancel), and how it binds to the runtime's transports (WebSocket, HTTP).
- The Docker UX on Windows and Linux: bead.ps1 and bead.sh wrappers, volumes, line endings.
- The quickstart a newcomer runs.`,
  },
];
const designs = await parallel(
  ANGLES.map(
    (item) => () =>
      agent(
        `${CONTEXT}\n\nYOUR ANGLE: ${item.angle}\n\nProduce a concrete design for your angle: decisions with reasons, shapes in code, the MVP's part, what is out of scope, and the risks. Markdown, in English.`,
        { label: `design:${item.key}`, phase: 'Design', effort: 'xhigh' }
      )
  )
);
const designText = ANGLES.map(
  (item, index) => `## ${item.key}\n\n${designs[index] || '(nothing returned)'}`
).join('\n\n---\n\n');

phase('Synthesize');
const synthesis = await agent(
  `${CONTEXT}\n\nMerge these three designs into ONE design of the builder: the front end, the model, the generated API per language, the CLI and its image, \`beadc check\` and \`beadc breaking\`, the MVP and its acceptance tests, the order of work, and what is out of scope. Resolve every contradiction explicitly. Markdown, in English.\n\n${designText}`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'xhigh' }
);

phase('Tenth man');
const tenthMan = await agent(
  `${CONTEXT}\n\nYOU ARE THE TENTH MAN. Everyone agreed on the design below. Your duty is to disagree: argue, as strongly as the facts allow, that it is wrong.
Look at:
- the choice of front end;
- the options;
- the model;
- the generated API's shape;
- the encodings;
- id stability and evolution;
- the Docker distribution;
- what it will cost to add a third language;
- what it changes on the wire, which must be nothing.
For each objection give its evidence, what it would cost to change now versus later, and your proposal. Then say, honestly, which objections you would drop yourself. Markdown, in English.\n\nTHE DESIGN:\n${synthesis}`,
  { label: 'tenth-man', phase: 'Tenth man', effort: 'xhigh' }
);

phase('Answer');
const written = await agent(
  `${CONTEXT}\n\nWrite the final design document to ${OUT}, creating its folder. It is the only file you may create.
1. Take the design below.
2. Answer EVERY objection of the tenth man: accepted, and the design changes accordingly; or refused, with the reason.
3. End the document with three sections:
   - "Objections and answers": each objection, the answer, and its status;
   - "Decisions for the user": what only the user can decide, each with a recommendation;
   - "Out of scope for v0.1".
   Its "Objections and answers" enter the repository with the builder's record, under its "## The Tenth Man" (decision 0009).
Write the document in English. Then return a short summary in French for the user: the design in ten lines, the objections accepted and refused, and the decisions awaiting them.

THE DESIGN:\n${synthesis}\n\nTHE TENTH MAN:\n${tenthMan}`,
  { label: 'answer', phase: 'Answer', effort: 'xhigh' }
);

return { out: OUT, summary: written };
