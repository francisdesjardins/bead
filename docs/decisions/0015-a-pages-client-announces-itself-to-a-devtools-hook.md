# 0015 — A page's client and its broker participant each announce themselves to a DevTools hook, which watches them only while a panel is open

- **Status**: accepted
- **Scope**: the TypeScript side's client, `src/client/devtools-hook.ts` and the client's option
  `devtools`; the DevTools extension, `implementations/typescript/devtools/`, its build and its
  tests; CI; the support matrix; the participant and `createBrokerParticipant`'s `devtools` option;
  debugging 13

## Context

A page's Bead traffic is hard to see. The Network panel shows each `POST /bead` of the HTTP
transport as bytes, a WebSocket's frames as bytes, and a Web Worker's messages not at all: a server
in a worker of the page, as the demo's playground runs one, has no traffic a browser's tools show.
What each call was, how long it took and how it ended is in the client already, in its `debug`
events and its metrics registry ([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)),
reachable from the page's own code alone: a developer types listeners into the console, or the
application ships a panel of its own, as the demo does.

Browser extensions reach a page's code by a hook it agrees on with the library. React DevTools
defines `__REACT_DEVTOOLS_GLOBAL_HOOK__` before the page runs, and React announces each renderer to
it, unasked; Apollo and Vue do the same, on by default in development. Redux DevTools waits for the
application to wire it in. Three ways were weighed:

- **The extension decodes the wire alone**: no library change, and it sees bytes without their
  procedures' names, nothing of a Web Worker, and little of a WebSocket, whose frames the DevTools
  API hands an extension poorly.
- **The application wires the extension in**, an option it sets, as Redux does: a production page
  shows nothing unless it chose to, and the demo, every example and every developer's first page set
  it before the extension shows anything.
- **The client announces itself to a hook the extension defines, unless told not to.** Chosen,
  against what the two above cost.

## Decision

**The hook is the value of `Symbol.for('@francisdesjardins/bead/devtools-hook')` on `globalThis`**,
a key qualified by the package that owns it, as
[0008](0008-three-version-axes-and-names-qualified-by-their-owner.md) qualifies a name: no other
library's global meets it. The extension defines it before the page's scripts run, from a content
script in the page's own world at `document_start`. A page loaded before the extension was installed
has no hook until it reloads.

**`createClient` announces the client to it as it builds the client**, unless its options say
`devtools: false`; `createWSClient`, `createHTTPClient` and `createWorkerClient` go through
`createClient`, and a router built alone announces nothing. The client hands the hook a source and
nothing more, never itself, its router or its credential. The hook's contract is a `register` that
takes a source and returns its withdrawal. A source names its `protocol`, 1, and its `side`, and
offers `exposition` and `watch`, the latter given `IDevtoolsListeners`, `call` and `envelope`;
`src/client/devtools-hook.ts` states it. A participant announces itself once through
`createBrokerParticipant`, unless its own option says `devtools: false`, with side `participant`.
It exposes no exposition; optional `inspect` reads its levels, and the optional `participant`
listener carries debugging 13's events. A client imports no broker capability and no transport is
mutated. An extension passing only call and envelope listeners attaches nothing to a participant.
Stopping the participant withdraws its source.

**Announcing costs one read of the key, and attaches nothing.** A source listens only between a
`watch` and its stop, and the extension watches only while its panel is open: until then the router
and the services build no `debug` event, and `isDebugging` stays false, as 0013's zero cost
requires. A hook that is not an object with a `register`, or whose `register` throws, is ignored:
the client is built all the same. Disposing the client withdraws its source.

**What the source hands over is what a `debug` listener receives**, the envelope's header with its
credential reduced to its scheme, the call's event as its service manager builds it. The extension
turns each into a plain record before it leaves the page: a call's per-request credential reduced to
its scheme, its payloads to a preview of bounded size, as text and as a tree, the stack that made a
call to its frames, no signal and no function.

**The extension is Chrome's first, in `implementations/typescript/devtools/`**, built by the
package's toolchain into `devtools/dist/`, an unpacked Manifest V3 extension: the hook, in the
page's world; a bridge, in the extension's isolated world, between the page and the background; the
background, pairing each page with its panel by tab; and a Bead panel showing each client the page
announced, its calls and its envelopes, and what its registry counts, read by the extension's own
reader, `devtools/exposition.ts`, which the demo's page uses too, and, in its Broker view, each
participant the page announced, its parcels, its link's transitions and its reports; every view is
filtered by the package's own filter, and counts what it hides. Its words are English. For a page
with no hook, its Wire view reads the HTTP transport's exchanges from the Network panel's entries,
decoding what their bodies carry with the package's codec. What every browser shares — the hook, the
panel with its model and its views, the readers, the messages — asks of the browser only what the
panel's host names; Chrome's glue is in `devtools/chrome/`, its manifest, its bridge, its
background, its DevTools page and the host made of its API, and another browser's extension brings
its own glue beside it. The hook and the bridge post to the page's own window at its own origin,
`postMessage(…, '/')`, an opaque one included, and never to `'*'`, which would reach a document the
window navigated to: HTML's `postMessage` delivers a message only to a window whose origin is its
target origin
([HTML §9.3.3](https://html.spec.whatwg.org/multipage/web-messaging.html#posting-messages)).

**A participant's records are kept apart from the calls'**: they have a held budget and a dropped
count of their own. The extension maps each event through `participantRecordOf`, an allowlist, into
the companion's vocabulary. The log is version 1 while it holds no participant record, version 2
once it holds one; a reader of version 2 skips and counts a record kind it does not know. A source's
initial `inspect` reading is saved in `sources`, apart from events. The participant records the
panel lets go, past the last 1,000 it keeps or while it is paused, are saved with those the hook let
go, beside the hook's dropped count of the others.

**The Broker view shows a header per participant**, its levels and bounds read while shown; a table
of parcels, link separators and error reports; a selected row's recorded fields, built on demand;
kind, connection and verdict filters in the view; and DATA parts grouped per connection and
direction, an incomplete capture named. Envelope credit is the State view's, linked from Broker. The
table follows Chrome's WebSocket messages, its lifecycle apart; the detail follows Redux DevTools'
log monitor. Neither rows nor exports carry an acceptor's half.

**It is tested apart from the package, in two projects of its own**: its pure modules in Node, the
panel's model among them; and, in Chromium, the extension loaded against the demo's static build,
the page's events followed through the hook, the bridge and the background to the panel, and the
panel as a page on a fake DevTools API, for what only DevTools gives it. Over MQTT 5, the extension
follows the demo's client over a broker of the run's own, in CI's job `mqtt` (`hook.test.ts`,
`follows the page’s calls, each service debug step and its envelopes to the panel over MQTT 5`).
The package's unit project keeps its claim that nothing under test needs a page.

**The hook, the extension and the panel change nothing the languages share**: what they carry of a
participant is debugging 13's trace, which every side tells
([0013](0013-every-language-debugs-alike-at-no-cost-when-off.md)) and which met the Tenth Man below.
The hook's contract is the TypeScript module's, the one side whose clients run in a page; the core
in a page brings the C# and Rust sides' clients there, and the contract to a document every side
reads ([0044](0044-rust-one-owner-per-router-traits-no-unsafe-two-parameters-no-warning.md)).

## Consequences

- An extension the user installed sees every Bead call of every page that did not refuse it, its
  payloads included. It sees nothing a script in the page cannot, and the user owns the browser; an
  application that must not show its payloads, even to its own user's tools, sets `devtools: false`.
- The hook's shape is a contract with code Bead does not ship with the page. An incompatible change,
  a member removed, renamed or given another meaning, is a new `protocol`; an optional member added
  keeps it, as SemVer 2.0.0 §7 and CDP's stable 1.3 do. The extension reads the protocol before it
  watches; the extension answers the protocols it knows and names the others.
- `world: "MAIN"` needs Chrome 111 and Firefox 128. Firefox's extension, its glue beside the
  shared core, is where Bead goes; Safari's asks Xcode.
- A DevTools panel cannot be driven by Playwright: what the panel does with DevTools' own APIs is
  tested on a fake of them, and the rest end to end.
- The support matrix holds a row, "A page's DevTools hook", open: the C# and Rust sides' clients
  come into a page with their core, announced to the hook there.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
one round, on the trace of a participant's parcels and the Broker view, which
[0013](0013-every-language-debugs-alike-at-no-cost-when-off.md#the-trace-of-parcels) points to, and
whose answer on the acceptor's half
[0038](0038-over-a-broker-a-connection-is-placed-once-at-its-open-named-by-both-its-ends.md)'s
Consequences state too. Its objections, each with the answer that holds:

### The trace of a participant's parcels and the Broker view

| Objection                                                                                                                                                                                                                                                                                                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The redaction rule leaves out the payload and the credential and exports the one secret this change adds, the acceptor's half: with both halves and the last sequence, any participant holding the log injects a DATA, a request in the victim's session, or a RESET into a live connection                           | Accepted: verified by a probe on the prototype's memory broker, where a third participant's DATA was handed on as the client's and its RESET ended the connection. Spec 15.22 guards who subscribes an inbox, not who publishes to one, so the pair is the connection's capability (0038). No event carries the acceptor's half; the opener's half, which every member serving the name reads, stays. A connection is named by the participant's ordinal, never reused, and, from the third leg on, by the handle its server's transport drew, `server` on a client, so a parcel joins the envelope trace by `connectionHandle` (debugging 5.1). The redaction rule names the half beside the credential; a test asserts it absent from the export; 0038's Consequences say the trace never hands it on.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Moving every client's source to protocol 2 blinds every extension built before the change, calls and envelopes included, for an optional listener that needs no bump; the log's version moves on every export too                                                                                                     | Accepted: verified: an extension of the former shape watches protocol 1 alone and refuses any other log version. The hook stays at protocol 1, the participant's listener an optional member that an old extension never passes. 0015's rule: a change an extension of the former shape would misread is a new protocol, an optional member added is not, as SemVer 2.0.0 §7 moves the minor for a compatible addition and CDP adds events under its stable 1.3. A log is version 1 while it holds no participant record, version 2 once it does, and from 2 on its reader skips a kind it does not know, counting it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The parcels' vocabulary is the participant's on every side and is decided now: the draft persists one side's shape as a file format, a page hook reaches no server participant, C# is kept out of a page by its transports' dialing and not its platform, Rust is not mentioned, and the C# timing cannot be the same | Accepted in part. Accepted: section 13 of the companion, the trace of parcels, with `participant.on('debug')` and `participant.Debug +=`, `isDebugging` and `IsDebugging`, 15.17's kinds, `rx` and `tx`, the connection named as in the first objection, twin tests and 0013's C# allocation gate; the companion's minor at 0.5.0; the extension maps each event into a record of its own, so the log stores the companion's words and not one side's types; the page hook only carries it; the Rust core tells it too; the matrix's C# cell holds the hook ahead, with the C# side's core in a page, verified by the platform analyzer, which flags only the transports' sockets, redirects and JWT verification. Refused: delivery off the participant's scheduler. The C# envelope trace, the closest kin of a parcel's, is told within its router's turn (`ReceiveOnLoop`); 0013's "never on a router's scheduler" is the call trace's rule. Posting each event elsewhere would allocate on every traced parcel and reorder parcels against the envelopes they carry. Each side tells an event at its site, ordered per participant, a listener synchronous and its cost the application's (debugging 2.2, 0013). |
| "Its losses" has no record: a loss shows only as a CLOSE code, when one goes, and every reason the participant already words alike on both sides stays out of the panel                                                                                                                                               | Accepted: while watched, what the participant and its transports report through `error` becomes a `report` event, in the words both sides share, with the connection's ordinal and handle when it has one; an `rx` loss carries `awaited` and `came`; a link going down, taken over or stopped names the connections it ended. A debug listener's own error is reported through `error` and never told back as a `report`, so a throwing listener cannot feed itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Observe where the participant decides, not before: the watched path copies every payload, decodes the credential, repeats the participant's read, cannot tell a copy from a retained message from a pair not held, and shares the hook's budget and drop count with calls                                             | Accepted in part. Accepted: verified by the copy probe, a full copy of the carried bytes per record, and by the credential decoded before the allowlist drops it. The sites that write and read a parcel tell the fields they already hold, `carriedBytes` from lengths, the credential never decoded for the trace; an `rx` event is told after the participant's verdict, one of `taken`, `copy`, `loss`, `pair-not-held`, `retained`, `off-topic`, `no-parcel`, `does-not-read` and `advisory`, a public `ParcelVerdict` on the C# side; participant records get their own held budget and drop count in the extension. Refused: a watch naming the kinds it wants. 0013 puts the filter in the listener ("turning the trace on is a cost an application chooses"), and the granularity of enabling is the source, as CDP's is the domain, `Network.enable` delivering every event of its domain.                                                                                                                                                                                                                                                                                                                  |
| A participant's events go through a client's source: duplicated by two clients over one participant, wider than the source, and the client layer learning a broker's private symbol                                                                                                                                   | Accepted: verified by the scope probe, where a client that never connected saw the other's four parcels and the participant's name. The participant announces itself once, as its own source, `side: 'participant'`, with a `devtools` option of its own, as React DevTools registers each renderer once; a client's source is as it was, the client layer imports no participant symbol and no transport is mutated. An application that sets `devtools: false` on its clients sets it on its participant too, and the README says so; an extension built before the change lists such a source with no calls and loses nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The state vocabulary misleads: each watch starts with a "link up" no link made, a takeover ends in a plain "down", a "down" lists names as served, and the link event is told mid-transition                                                                                                                          | Accepted: verified by the scope probe and the prototype's order of telling. The state at a watch's start is read by pull and is never an event, as Redux DevTools' `@@INIT` is never an action; a `link` transition's states are `up`, `down`, `taken-over` and `stopped`; each is told once its transition is complete, its names cleared and its connections dropped first. A message that is no parcel shows its verdict, never a state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| "Credit" in the Broker view is the wrong credit: it repeats the State view's envelope credit, and shows none of the participant's own gauges, which both sides already hold and which pace or lose a connection                                                                                                       | Accepted in part. Accepted: the view reads the participant's gauges against their bounds, its incarnation, link, inbox and names by pull while it is shown, as the panel reads an exposition; envelope credit stays in the State view, linked from Broker; an adapter's own gauges in the Broker view are ahead, MQTT 5's Receive Maximum and its PUBACKs to settle among them. Refused: pulling the link and the names alone. A pull samples and misses a down and an up, or a name let go at `maximumConnections` and taken again, between two reads, as 0013 keeps counters rather than a gauge that would miss what started and ended between two; transitions are pushed, levels pulled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A debug listener's throw is swallowed, not reported, against the rule 0013 and 0023 set for every listener                                                                                                                                                                                                            | Accepted: a listener's error is reported through the participant's `error` / `Error`, the listeners after it called all the same, at every emission, with twin tests of a throwing listener reported while the participant goes on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The names say "broker" for what spec 15.16 calls the participant and its parcels; a broker is the MQTT or AMQP server                                                                                                                                                                                                 | Accepted: the vocabulary is the participant's and its parcels', `IParticipantDebugEvent` and `ParticipantDebugEvent`, a `parcel` event among its four, and the record's kind `participant`, since a record also holds a link's transitions and reports (0003); the tab keeps the label "Broker", the transport family's, as Chrome's panel is "Network".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
