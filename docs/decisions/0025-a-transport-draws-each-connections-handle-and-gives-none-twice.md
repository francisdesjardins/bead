# 0025 — A transport draws each connection's handle, and gives none twice

- **Status**: accepted
- **Scope**: the protocol, and every implementation's server transports: the handle a transport
  names each connection by, in section 15.1 of [`spec/spec.md`](../../spec/spec.md), and what 14.4
  says of a destination's next connection; a client's address read from an IPv4-mapped one, in
  15.12; the forms both sides write. HTTP's token and its draw are
  [0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)'s, and a stop
  [0023](0023-a-transport-goes-on-through-its-listeners-throw-and-takes-nothing-new-as-it-stops.md)'s.

## Context

**A connection is named by both its ends.**
[RFC 9293 §3.4.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.4.1): "A connection is defined by
a pair of sockets." Two sockets from one address and port, to two of a server's addresses, are two
TCP connections that share the peer's half. A WebSocket handle written from the peer's address and
port alone, `type=WS;ip=…;port=…`, names them by that half, so the second takes the first's place
in the transport's registry: on Linux, two sockets from `127.0.0.1:47123` to `127.0.0.1` and
`127.0.0.2` of a server on `0.0.0.0`, the second asks `whoami` and is answered the first's user, the
first's `echo` times out, and at the stop the first is held by none, the TypeScript server's
process running on past it and the C# side aborting it at the host's shutdown timeout, no 1001 and
no close. Node on Linux and .NET with `ReuseAddress`, on Linux and Windows, open the pair; Node on
Windows refuses the second bind, `EADDRINUSE`, with no option to set `SO_REUSEADDR` on a client
socket; macOS answers on `127.0.0.1` alone by default.

**What names a connection elsewhere**: QUIC names it by an id its endpoint chooses, so that a change
of address delivers nothing to the wrong one
([RFC 9000 §5.1](https://www.rfc-editor.org/rfc/rfc9000#section-5.1)); HTTP/2 never reuses a stream
identifier ([RFC 9113 §5.1.1](https://www.rfc-editor.org/rfc/rfc9113#section-5.1.1)), so what comes
late for an ended stream reaches no new one; gRPC's peer and the logs of proxies and firewalls name a
connection by its address and port, which tie it to the network's own records. Bead's HTTP
transport draws a connection by its rank and a token
([0020](0020-http-draws-a-connection-by-a-token-and-a-listen-holds-it.md)), and its Web Worker
transport by its rank.

**A dual-stack listener reads a client over IPv4 as an IPv4-mapped address**, `::ffff:127.0.0.1`,
which the TypeScript side keeps and the C# side maps to `127.0.0.1`, measured; the handle, a
client's address and `maximumConnectionsPerAddress` read it.
[RFC 4291 §2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2): such an address
represents an IPv4 node's.

The options weighed:

- **A drawn handle**, `type=WS;ip=…;port=…;ordinal=n`: two sockets are two connections, each in
  its own session, its bounds, its gauges and the stop; a reconnect from the same port, its close not
  yet heard, is a new handle, and what comes late for the old one reaches no other.
- **The handle kept and the newcomer refused**, 1013 "Try Again Later"
  ([RFC 6455 §7.4.1](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)) after the 101, since
  `ws` and Kestrel upgrade before the registry sees the socket, or 503 before it: a connection TCP
  holds valid refused for a name the server chose, told something false, and a late answer may reach
  the next connection from that port.
- **The four-tuple**, the server's address added: two names for one fact, and a port given again
  after a close not yet heard still meets the old one.
- **A drawn handle without the port**, `type=WS;ip=…;ordinal=n`, one form across transports: the
  ordinal alone makes it unique, but the handle is the trace's only connection field
  (`debugging.md` 4.1, 5.1), and the C# `Connection` event carries the handle alone while `Clients`
  lists only the connections held, so once one closes a C# application holds its port nowhere else.

## Decision

**A server's transport draws each connection's handle as it takes it, and gives none twice** (spec
15.1): no two connections it holds are one, and its bounds, its gauges and its stop reach each. A
WebSocket server's handle is `type=WS;ip=…;port=…;ordinal=n`: the client's address, as 15.12 reads
it ([0030](0030-a-server-believes-x-forwarded-for-from-the-proxies-it-names-and-counts.md)), and its
socket's peer port, kept for a reader of a trace, and the rank the transport took the connection at,
counted per transport from 1 and never reset, a stop and a start included. It is drawn once the
connection is taken, after the check for a socket already gone and, on the C# side, after the
accept, so ranks run in the order connections were taken; the C# side's count of arrivals is its
rank. Every handle reads `type=…;ip=…;` and ends `ordinal=n`, a socket's carrying `port=…` between,
which also tells apart the handles two WebSocket transports of one process draw at the same rank.

**A handle's form is its implementation's**, written for a reader of a trace; the spec promises none,
and an application compares a handle whole. The TypeScript type states the two forms as template
literals, the author's style for a value whose form a type can state.

**14.4 follows**: a destination's next connection is always another handle, so once its connection
closed a destination is unreachable until it is registered anew.

**A client's address is read as IPv4 when an IPv6 socket carries it mapped** (spec 15.12), on both
sides, in the handle, a client's address and `maximumConnectionsPerAddress`, the socket's address
mapped before a trusted proxy's is read.

## Consequences

**The WebSocket handle carries its ordinal**: on the TypeScript side `generateHandle` takes
`{ ip, ordinal, port, type }` and writes every form, and the socket form of
`TransportServerConnectionHandle` ends in its ordinal. Both sides' test literals of a socket's
handle carry the ordinal, so twin tests read one form.

**No conformance case holds it.** No step of `spec/transports.json` names the address or the port a
socket opens from or connects to, and one that did would bind to a platform's socket options: Node
on Windows cannot open the second socket, macOS has no `127.0.0.2`. What the handle changes is not on
the wire; the crossing of sessions it caused is, and twin tests hold it, by the same sentence
([0004](0004-one-behaviour-in-every-language.md)), which `docs/support.md` names among what no entry
plays: each WebSocket transport server's
`names each connection by its peer's port and the rank it came at, two sockets from one address and port among them, and gives no handle twice`
and `closes each of two sockets from one address and port on its own, each its own close told`;
each WebSocket server's
`keeps two sockets from one address and port, to two of its addresses, as two connections, each in its own session, and closes both going away as it stops`,
on real sockets, skipped where the platform cannot open two sockets from one port, the TypeScript
one on Linux alone; and each transport server's
`names a client that comes over IPv4 to a dual-stack listener by its IPv4 address`.

## The Tenth Man

The decision met the Tenth Man ([0009](0009-conventional-commits-git-flow-and-the-tenth-man.md)) in
the round [0024](0024-a-server-takes-the-loopbacks-names-ip-literals-and-the-hosts-it-is-told.md)
keeps, On a server's hosts and a connection's handle, whose objection on the drawn form's port is
this record's.
