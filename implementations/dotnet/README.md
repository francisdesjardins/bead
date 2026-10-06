# Bead, on the C# side

Bead is a binary wire protocol: the envelopes of a request, its result or failure, the notifications
of a subscription and the commands a server sends back, written at fixed offsets. This solution is
its C# implementation, at parity with the TypeScript side: the same behaviour, played from the same
conformance files in [`spec/`](../../spec/), and proven against the other side in the interop. The
rules its code keeps — interfaces and composition, every body a block, two parameters then an
options record, every warning an error, one serial scheduler a router, and how the surface maps in
.NET's terms — are [decision
0007](../../docs/decisions/0007-csharp-interfaces-blocks-two-parameters-no-warning.md)'s.

## Build and test

The .NET 10 SDK, as `global.json` pins it, with the test runner, Microsoft.Testing.Platform. From
this folder:

```sh
dotnet format Bead.slnx --verify-no-changes
dotnet test --solution Bead.slnx
```

With `CI=true`, a restore that would change a `packages.lock.json` fails. The interop against the
TypeScript server needs that side installed; with `BEAD_INTEROP_REQUIRED=1`, an interop that would
skip fails instead.

## Layout

One solution, `Bead.slnx`:

```
src/
  Bead.Core/                    the codec, the router's core, both sides' routers, the service,
                                session and notification managers, the relay, the server over
                                them, and the service layer a service is served and called through
  Bead.Transport.WebSockets/    the server on Kestrel and the client on ClientWebSocket, one
                                connection class for both
  Bead.Transport.Http/          the server on Kestrel and the client on HttpClient
  BannedSymbols.txt             what the banned-API analyzer refuses: the clock is given
interop/
  Bead.Interop/                 the interop service, which both sides serve alike
  Bead.Interop.Server/          its server, which the TypeScript side's interop calls
tests/
  Bead.*.Tests/                 a project's tests, beside it by name
  Shared/                       what several test projects link: the test clock, the durations'
                                helper
```

A transport that needs a framework has a project of its own. Each transport server is a Kestrel
application of its own: one port for both comes from a proxy in front, never from a server they
share.

## Modules

- **Transfers** are `Transfer`, `ReceivingTransfers` and `SendingTransfers`, wired in the router's
  core.
- **The relay** is `Relay`, its registrations under a lock, since they are registered from any
  thread and read on the router's scheduler; a destination is a `ConnectionTarget` or an
  `IRouterTarget`, which a client's router meets.
- **HTTP's transport** sets the shared behaviour where Kestrel's defaults would differ: no body
  limit of Kestrel's, so a body past the limit is the marked 413 and one past the budget the marked
  503; a refusal of HTTP/1 whose body it does not read says `connection: close`; `x-forwarded-for`
  is read by one rule of its own. `BeadHttpClient` is its client, as .NET's own is `HttpClient`.
- **The transports** hold the same ready states on both sides, and the client reconnects alike, its
  delay, attempts, token and tap, its router rejecting what waited on the connection replaced.
- **The clock** is a `TimeProvider`, named `Clock`, which every layer takes and exposes ([decision
  0011](../../docs/decisions/0011-every-side-takes-its-time-from-a-clock-it-is-given.md)).

Where the platform makes the sides differ, or a difference is still open, the [support
matrix](../../docs/support.md) has the row and its test.
