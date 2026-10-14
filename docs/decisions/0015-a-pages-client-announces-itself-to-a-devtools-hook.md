# 0015 — A page's client announces itself to a DevTools hook, which watches it only while a panel is open

- **Status**: accepted
- **Scope**: the TypeScript side's client, `src/client/devtools-hook.ts` and the client's option
  `devtools`; the DevTools extension, `implementations/typescript/devtools/`, its build and its
  tests; CI; the support matrix

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
`src/client/devtools-hook.ts` states it.

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
announced, its calls and its envelopes, filtered by the package's own filter, and what its registry
counts, read by the extension's own reader, `devtools/exposition.ts`, which the demo's page uses
too. Its words are English. For a page with no hook, its Wire view reads the HTTP transport's
exchanges from the Network panel's entries, decoding what their bodies carry with the package's
codec. What every browser shares — the hook, the panel with its model and its views, the readers,
the messages — asks of the browser only what the panel's host names; Chrome's glue is in
`devtools/chrome/`, its manifest, its bridge, its background, its DevTools page and the host made of
its API, and another browser's extension brings its own glue beside it. The hook and the bridge
post to the page's own window at its own origin, `postMessage(…, '/')`, an opaque one included, and
never to `'*'`, which would reach a document the window navigated to: HTML's `postMessage` delivers
a message only to a window whose origin is its target origin
([HTML §9.3.3](https://html.spec.whatwg.org/multipage/web-messaging.html#posting-messages)).

**It is tested apart from the package, in two projects of its own**: its pure modules in Node, the
panel's model among them; and, in Chromium, the extension loaded against the demo's static build,
the page's events followed through the hook, the bridge and the background to the panel, and the
panel as a page on a fake DevTools API, for what only DevTools gives it. The package's unit project
keeps its claim that nothing under test needs a page.

**It changes nothing the languages share**: no wire, no conformance file, no behaviour a peer sees.
A browser page is the TypeScript side's platform, and the support matrix says so; no Tenth Man
([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)).

## Consequences

- An extension the user installed sees every Bead call of every page that did not refuse it, its
  payloads included. It sees nothing a script in the page cannot, and the user owns the browser; an
  application that must not show its payloads, even to its own user's tools, sets `devtools: false`.
- The hook's shape is a contract with code Bead does not ship with the page. A change to it is a new
  `protocol`, which the extension reads before it watches; the extension answers the protocols it
  knows and names the others.
- `world: "MAIN"` needs Chrome 111 and Firefox 128. Firefox's extension, its glue beside the
  shared core, is where Bead goes; Safari's asks Xcode.
- A DevTools panel cannot be driven by Playwright: what the panel does with DevTools' own APIs is
  tested on a fake of them, and the rest end to end.
- The support matrix holds a row, "A page's DevTools hook", platform: a .NET client runs in no page
  an extension reaches, until one runs under WebAssembly.
