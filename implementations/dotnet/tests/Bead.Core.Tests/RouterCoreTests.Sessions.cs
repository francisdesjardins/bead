namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s call's session, as step 5 of section 9.2 of the spec has it: a scheme
/// the side takes none of refused, the credential resolved by the port's session, waiting or not,
/// then the admission, on the call's session; and the credential a call of its own presents.
/// </summary>
public sealed partial class RouterCoreTests
{
    // helpers

    // a request of echo on a call id, presenting a credential, with a payload of one byte
    private static Envelope PresentingOf(uint callId, Credential? credential)
    {
        return new Envelope { Header = RequestOf(callId) with { Credential = credential }, Payload = new byte[] { 1 } };
    }

    // a call of echo, presenting what its options give
    private static CoreRequest PresentingCallOf(Credential? credential)
    {
        return new CoreRequest
        {
            ConnectionHandle = Handle,
            Procedure = Echo,
            Options = new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5), Credential = credential },
        };
    }

    // each failure sent: its call id, its code, its detail
    private static List<(uint CallId, ProtocolCode Code, string Detail)> RefusalsOf(IEnumerable<Envelope> sent)
    {
        return [.. sent.Where((envelope) =>
        {
            return envelope.Failure is not null;
        }).Select((envelope) =>
        {
            return (envelope.Header.CallId, (ProtocolCode)envelope.Failure!.Code, envelope.Failure.Detail);
        })];
    }

    // a resolution that waits until the test settles it
    private static (Func<SessionRequest, CancellationToken, ValueTask<CallSession?>> Resolution, List<TaskCompletionSource<CallSession?>> Pending) Waiting()
    {
        var pending = new List<TaskCompletionSource<CallSession?>>();

        return (
            (_, _) =>
            {
                var resolution = new TaskCompletionSource<CallSession?>(TaskCreationOptions.RunContinuationsAsynchronously);

                pending.Add(resolution);

                return new ValueTask<CallSession?>(resolution.Task);
            },
            pending);
    }

    // definition

    [Fact]
    public async Task A_credential_of_a_scheme_the_side_takes_none_of_is_refused_CREDENTIAL_UNSUPPORTED_naming_those_it_takes_past_its_route_and_before_it_resolves()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(PresentingOf(1, Credential.Jwt("a.b.c")));
        await server.Deliver(PresentingOf(3, Credential.Elsewhere));
        await server.Deliver(PresentingOf(5, Credential.Of((CredentialScheme)7, [1, 2])));

        // one that takes them all names them, in the order of their numbers
        server.Schemes = [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere];
        await server.Deliver(PresentingOf(7, Credential.Of((CredentialScheme)0xffff, [])));

        // one that nothing routes is refused as such first
        await server.Deliver(new Envelope { Header = RequestOf(9) with { ServiceId = 9, Credential = Credential.Of((CredentialScheme)7, []) }, Payload = new byte[] { 1 } });

        Assert.Equal(
            [
                (1u, ProtocolCode.CredentialUnsupported, "OPAQUE"),
                (3u, ProtocolCode.CredentialUnsupported, "OPAQUE"),
                (5u, ProtocolCode.CredentialUnsupported, "OPAQUE"),
                (7u, ProtocolCode.CredentialUnsupported, "OPAQUE, JWT, ELSEWHERE"),
                (9u, ProtocolCode.ServiceUnknown, "no service 9"),
            ],
            RefusalsOf(server.Sent));
        Assert.Equal(0, resolver.Admitted);
        Assert.Empty(server.Resolved);
    }

    [Fact]
    public async Task A_credential_of_none_or_OPAQUE_resolves_in_the_turn_it_came_the_call_s_session_handed_to_its_admission_then_to_its_resolver()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var server = new Peer(RouterSide.Server) { Session = token };
        var resolver = server.Resolve();
        var admitted = new List<object?>();

        server.Resolution = (request, _) =>
        {
            return ValueTask.FromResult<CallSession?>(new CallSession { Data = request.Header.Credential is null ? "none" : "OPAQUE" });
        };
        resolver.Admission = (request) =>
        {
            admitted.Add(request.Session?.Data);

            return null;
        };

        await server.Deliver(PresentingOf(1, null));
        await server.Deliver(PresentingOf(3, token));

        // one on a call id open, or that nothing routes, is asked nothing
        await server.Deliver(PresentingOf(1, null));
        await server.Deliver(new Envelope { Header = RequestOf(5) with { ServiceId = 9 }, Payload = new byte[] { 1 } });

        Assert.Equal(["none", "OPAQUE"], admitted);
        Assert.Equal(
            ["none", "OPAQUE"],
            resolver.Requests.Select((request) =>
            {
                return request.Session?.Data;
            }));
        Assert.Equal(2, server.Resolved.Count);
        Assert.All(server.Resolved.Zip(resolver.Requests), (asked) =>
        {
            // the very header dispatched, its connection, and the call's signal
            Assert.Same(asked.Second.Header, asked.First.Request.Header);
            Assert.Equal(Handle, asked.First.Request.ConnectionHandle);
            Assert.Equal(asked.Second.Signal, asked.First.Signal);
        });
    }

    [Fact]
    public async Task A_credential_that_does_not_resolve_is_refused_SESSION_REQUIRED_whatever_its_procedure_requires_never_admitted_an_ELSEWHERE_as_one_that_came_without_none_resolving_to_none_runs_in_none()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var server = new Peer(RouterSide.Server) { Session = token, Schemes = [CredentialScheme.Opaque, CredentialScheme.Elsewhere] };
        var resolver = server.Resolve();

        // another's token, an ELSEWHERE that carried nothing — asked nothing — and the token of a
        // session ended
        await server.Deliver(PresentingOf(1, SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw")));
        await server.Deliver(PresentingOf(3, Credential.Elsewhere));
        server.Session = null;
        await server.Deliver(PresentingOf(5, token));

        Assert.Equal(
            [
                (1u, ProtocolCode.SessionRequired, "the credential does not hold"),
                (3u, ProtocolCode.SessionRequired, "no credential came"),
                (5u, ProtocolCode.SessionRequired, "the credential does not hold"),
            ],
            RefusalsOf(server.Sent));
        Assert.Equal(
            [1u, 5u],
            server.Resolved.Select((resolved) =>
            {
                return resolved.Request.Header.CallId;
            }));
        Assert.Equal(0, resolver.Admitted);

        // its connection's token runs in its session, and so does none, which runs in none once
        // the connection has no session
        server.Session = token;
        await server.Deliver(PresentingOf(7, token));
        await server.Deliver(PresentingOf(9, null));
        server.Session = null;
        await server.Deliver(PresentingOf(11, null));
        Assert.Equal(
            [(7u, true), (9u, true), (11u, false)],
            resolver.Requests.Select((request) =>
            {
                return (request.Header.CallId, request.Session is not null);
            }));
    }

    [Fact]
    public async Task A_credential_whose_resolution_throws_or_rejects_or_promises_for_none_or_OPAQUE_is_answered_PROCEDURE_FAILED_and_reported_a_JWT_s_in_a_later_turn()
    {
        var server = new Peer(RouterSide.Server) { Schemes = [CredentialScheme.Opaque, CredentialScheme.Jwt] };
        var resolver = server.Resolve();
        var thrown = new InvalidOperationException("the key set cannot be reached");
        var faulted = new InvalidOperationException("the verifier broke");
        var waiting = new TaskCompletionSource<CallSession?>(TaskCreationOptions.RunContinuationsAsynchronously);

        server.Resolution = (request, _) =>
        {
            if (request.Header.CallId == 1)
            {
                throw thrown;
            }

            if (request.Header.CallId == 3)
            {
                return ValueTask.FromException<CallSession?>(faulted);
            }

            // ! none and OPAQUE resolve in the turn they came: this one waits
            return new ValueTask<CallSession?>(waiting.Task);
        };

        // a JWT's in a later turn, even one that throws at once: what came after it is answered first
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(1, Credential.Jwt("a.b.c"))), Handle);
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(3, Credential.Jwt("a.b.c"))), Handle);
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(5, Credential.Opaque(SessionToken.FromBytes(PatternOf(16))))), Handle);
        await server.Settle();

        Assert.Equal(
            [(5u, ProtocolCode.ProcedureFailed, ""), (1u, ProtocolCode.ProcedureFailed, ""), (3u, ProtocolCode.ProcedureFailed, "")],
            RefusalsOf(server.Sent));
        Assert.IsType<InvalidOperationException>(server.Reports[0]);
        Assert.Equal([thrown, faulted], server.Reports[1..]);

        // what the one that waited settles with is dropped
        waiting.SetResult(new CallSession());
        await server.Settle();
        Assert.Equal(3, server.Sent.Count);
        Assert.Equal(0, resolver.Admitted);
    }

    [Fact]
    public async Task A_credential_of_a_JWT_or_an_ELSEWHERE_resolves_in_a_later_turn_whether_its_resolution_waits_or_not_its_call_id_held_meanwhile()
    {
        var server = new Peer(RouterSide.Server) { Schemes = [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere] };
        var resolver = server.Resolve();
        var admitted = new List<uint>();
        var (waiting, pending) = Waiting();

        server.Resolution = (request, signal) =>
        {
            return request.Header.CallId == 9 ? waiting(request, signal) : ValueTask.FromResult<CallSession?>(new CallSession());
        };
        resolver.Admission = (request) =>
        {
            admitted.Add(request.Header.CallId);

            return null;
        };

        // each settles at once, and what came after a JWT or an ELSEWHERE is taken first
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(1, Credential.Jwt("a.b.c"))), Handle);
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(3, null)), Handle);
        server.Core.Receive(new TransportMessage(EnvelopeCodec.WriteEnvelope(PresentingOf(5, Credential.Elsewhere)), false) { Credential = "Bearer a.b.c" }, Handle);
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(PresentingOf(7, Credential.Opaque(SessionToken.FromBytes(PatternOf(16))))), Handle);
        await server.Settle();

        Assert.Equal([3u, 7u, 1u, 5u], admitted);

        // the credential an ELSEWHERE stands for is the one its transport carried
        Assert.Equal(
            [(1u, null), (3u, null), (5u, "Bearer a.b.c"), (7u, null)],
            server.Resolved.Select((resolved) =>
            {
                return (resolved.Request.Header.CallId, resolved.Request.TransportCredential);
            }));

        // while one waits, its call id is held: a request on it is refused, and asks nothing
        await server.Deliver(PresentingOf(9, Credential.Jwt("a.b.c")));
        await server.Deliver(PresentingOf(9, Credential.Jwt("a.b.c")));
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(Assert.Single(server.Reports)));
        Assert.Equal(5, server.Resolved.Count);
        pending[0].SetResult(new CallSession());
        await server.Settle();
        Assert.Equal([3u, 7u, 1u, 5u, 9u], admitted);
    }

    [Fact]
    public async Task A_credential_resolving_its_call_s_cancel_or_its_connection_s_close_tells_sessionOf_by_the_call_s_signal_and_what_it_settles_to_then_is_dropped()
    {
        var server = new Peer(RouterSide.Server) { Schemes = [CredentialScheme.Opaque, CredentialScheme.Jwt] };
        var resolver = server.Resolve();
        var (resolution, pending) = Waiting();

        // a JWT waits; none resolves at once
        server.Resolution = (request, signal) =>
        {
            return request.Header.Credential is null ? ValueTask.FromResult<CallSession?>(new CallSession()) : resolution(request, signal);
        };

        await server.Deliver(PresentingOf(1, Credential.Jwt("a.b.c")));
        Assert.False(Assert.Single(server.Resolved).Signal.IsCancellationRequested);

        // a cancel ends it, answered by nothing, and tells it; its call id opens again, and what it
        // settles with then is dropped
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 1 } });
        Assert.True(server.Resolved[0].Signal.IsCancellationRequested);
        await server.Deliver(PresentingOf(1, null));
        pending[0].SetResult(new CallSession());
        await server.Settle();
        Assert.Equal(1u, Assert.Single(resolver.Requests).Header.CallId);

        // its connection closing does too, on its own connection alone
        await server.Deliver(PresentingOf(3, Credential.Jwt("a.b.c")), "other");
        await server.Deliver(PresentingOf(5, Credential.Jwt("a.b.c")));
        server.Core.RejectPending("the connection closed", "other");
        await server.Settle();
        Assert.True(server.Resolved[2].Signal.IsCancellationRequested);
        Assert.False(server.Resolved[3].Signal.IsCancellationRequested);
        pending[1].SetException(new OperationCanceledException(server.Resolved[2].Signal));
        await server.Settle();

        // nothing answered what ended, nor reported it
        Assert.Empty(server.Sent);
        Assert.Empty(server.Reports);
        Assert.Equal(1, resolver.Admitted);

        // the one still resolving goes on
        pending[2].SetResult(new CallSession());
        await server.Settle();
        Assert.Equal(
            [1u, 5u],
            resolver.Requests.Select((request) =>
            {
                return request.Header.CallId;
            }));
    }

    [Fact]
    public async Task A_credential_resolving_a_transfer_s_opening_gets_no_credit_until_its_resolution_and_its_admission_settle()
    {
        var server = new Peer(RouterSide.Server) { Schemes = [CredentialScheme.Opaque, CredentialScheme.Jwt] };
        var resolver = server.Resolve();
        var (resolution, pending) = Waiting();
        var opening = RequestOpeningOf(1, (PatternOf(300), 20));

        server.Resolution = resolution;
        await server.Deliver(new Envelope { Header = (RequestHeader)opening.Header with { Credential = Credential.Jwt("a.b.c") }, Payload = opening.Payload });
        await server.Advance(TimeSpan.FromSeconds(1));
        Assert.Empty(server.Sent);
        Assert.Equal(0, resolver.Admitted);

        pending[0].SetResult(new CallSession());
        await server.Settle();
        Assert.Equal(1, resolver.Admitted);
        Assert.Equal([148L], CreditsOf(server.Sent));
    }

    [Fact]
    public async Task The_credential_this_side_presents_is_the_one_its_side_resolved_and_one_that_leaves_a_transfer_s_opening_no_byte_fails_it_before_it_goes_ENVELOPE_TOO_LARGE()
    {
        var client = new Peer(RouterSide.Client);
        var known = SessionToken.FromBytes(PatternOf(16));

        // OPAQUE while its side knows no session fails before it goes, and draws nothing
        var unknown = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Opaque())).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        await client.Settle();
        Assert.Equal(
            ((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local, (RouterSide?)RouterSide.Client),
            (unknown.Code, unknown.Origin, unknown.Side));
        Assert.Empty(client.Sent);

        client.Session = known;
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Opaque()));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.None));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(null));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Jwt("a.b.c")));
        await client.Settle();
        Assert.Equal(
            [(1u, Credential.Opaque(known)), (3u, null), (5u, null), (7u, Credential.Jwt("a.b.c"))],
            client.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, ((RequestHeader)envelope.Header).Credential);
            }));

        // a JWT of 40 characters: a header of 56 bytes, and 64 with a transfer's total — 8 bytes go
        // whole, and 9 would leave the opening none
        var long40 = Credential.Jwt(new string('a', 40));

        _ = client.Core.Request(PatternOf(8), PresentingCallOf(long40));

        var tooLarge = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Core.Request(PatternOf(9), PresentingCallOf(long40)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        await client.Settle();
        Assert.Equal(
            ((ushort)ProtocolCode.EnvelopeTooLarge, FailureOrigin.Local, (RouterSide?)RouterSide.Client),
            (tooLarge.Code, tooLarge.Origin, tooLarge.Side));
        Assert.Null(Assert.IsType<RequestHeader>(tooLarge.Header).Credential);
        Assert.Equal(5, client.Sent.Count);
        Assert.Equal(long40, ((RequestHeader)client.Sent[4].Header).Credential);
    }
}
