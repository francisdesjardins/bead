# 0002 — A client may pace its subscription, and what waits, waits by key

- **Status**: accepted
- **Scope**: the protocol, and every implementation. What waits for a socket, and its pace, is
  [0033](0033-a-side-bounds-what-a-peer-holds-of-it.md)'s.

## Context

A subscription pushes each notification as it comes. A client that does something with each one, a
fetch or a render, falls behind a burst: changes that come in a few seconds are as many
notifications and as many fetches, where two would have done, and large notifications fill what
holds them on the way, a socket's buffer or an HTTP connection's outbox, which then closes.

What a server sends is not all alike, and a complex system sends every kind at once: a state, of
which only the latest counts; an event, each of which counts; one procedure notifying either, for
many entities. A delay on the server paces every client alike, the fast and the slow. Dropping what
a client cannot take loses an event, and loses it in silence. Only the client knows its own pace.

## Decision

**A client may ask for a subscription at its own pace.** The request that opens it carries PACED
beside SUBSCRIPTION; the server then sends a notification only while the client has credited one.
The opening credits the first. Each CREDIT after it carries PACED and, on the subscription's call
id, the absolute count of notifications the server may have sent on it, never taken back, as a
transfer's credit is an absolute end ([0001](0001-the-envelope-sits-at-fixed-offsets.md)); RSocket's
`REQUEST_N` is the same demand, counted. PACED names what is counted: a CREDIT without it is a
transfer's, in bytes, even on that call id, whose request may go as one.

**What waits, waits by key.** Past its credit, a notification waits in its subscription's queue,
bounded: 64 notifications and 1 MiB by default. The code that notifies may give it a key, which is
the server's own and never travels: one of the same key replaces the one waiting, in its place in
the queue; one with none is added last. A state keyed by its entity keeps its latest, as a compacted
log keeps a key's last value; an event, keyed by nothing, keeps every one, in order; one procedure
mixes both, notification by notification. A queue past its bound ends the subscription with
`CAPACITY_EXCEEDED`: nothing is ever dropped in silence, and the client subscribes again and reads
the state anew.

**The client credits as it is done.** It credits the next notification once the callbacks of the one
before have settled, promises included: a callback that fetches receives nothing else meanwhile,
then the latest. A window lets that many be under way, renewed at half, as a transfer's credit is.

**A client that does not ask is pushed each notification as it comes.** PACED is allowed on a
request that opens a subscription, and on a CREDIT; on anything else, the envelope is malformed.

## Consequences

- For a paced subscription, `notify` resolves once its notification is sent or waiting: the
  transport may not have it yet.
- A callback that never settles holds its subscription. That is why pacing is asked for, not given.
- A window of one costs a CREDIT per notification; over HTTP, a `POST` each. A wider window
  amortizes it, and lets that many arrive during one fetch.
- Timing, at most one every half second or a batch every second, is a policy, and stays the
  application's, around `notify`. So is choosing the key: it is what the notification means.
- A signal with no data, "it changed", needs no pacing to be cheap: the client merges it around its
  own handler, one fetch at a time and one more if something came meanwhile.
- A relay carries no subscription, paced or not
  ([0019](0019-a-relay-terminates-each-leg-and-routes-nothing-past-it.md)), which is open work, and
  neither does an HTTP connection whose client does not listen
  ([0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)).
- The rule is section 11 of [`spec/spec.md`](../../spec/spec.md), and `spec/conversations.json`
  plays it step by step against every implementation's server.
