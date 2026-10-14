using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterClient"/>'s credentials (spec 13.4): the one it presents by default, and each
/// call's own; the default withdrawn once a call that presented it is refused SESSION_REQUIRED; a
/// call failed before it goes when its transport cannot carry its credential; and a command's
/// credential resolved as a server resolves a request's.
/// </summary>
public sealed partial class RouterClientTests
{
    // constants

    private static readonly Credential DefaultJwt = Credential.Jwt("a.b.c");

    // helpers

    // each request sent, by its call id, the credential its header presents, and what its transport
    // carried beside it
    private static List<(uint CallId, Credential? Credential, string? Carried)> PresentedOf(ScriptedTransport transport)
    {
        return [.. transport.Envelopes.Zip(transport.Carried).Select((sent) =>
        {
            return (sent.First.Header.CallId, Assert.IsType<RequestHeader>(sent.First.Header).Credential, sent.Second);
        })];
    }

    // a call of the router's, whatever it settles to, on its credential as its options say
    private static Task<RouterResult> CallOf(RouterClient router, Credential? credential = null)
    {
        return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { Credential = credential }));
    }

    // definition

    [Fact]
    public async Task Presents_a_default_JWT_on_every_call_that_gives_none_of_its_own_and_hands_a_default_ELSEWHERE_s_carried_value_to_its_transport_with_scheme_3_in_the_block()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);

        _ = CallOf(router);
        _ = CallOf(router);
        await scripted.Settle();

        // given anew, under the same name
        router.Credential = Credential.Elsewhere("Interop sub=ada");
        _ = CallOf(router);
        await scripted.Settle();

        Assert.Equal(Credential.Elsewhere("Interop sub=ada"), router.Credential);
        Assert.Equal(
            [(1u, DefaultJwt, null), (3u, DefaultJwt, null), (5u, Credential.Elsewhere(), "Interop sub=ada")],
            PresentedOf(transport));
        Assert.Equal([0x08, 0x08, 0x08], transport.Sent.Select((bytes) =>
        {
            return (int)bytes.Span[2];
        }));
    }

    [Fact]
    public async Task A_call_s_own_credential_wins_over_the_default_NONE_presents_none_whatever_the_default_and_OPAQUE_presents_the_session_learned()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);

        transport.Deliver(ResultOf(99, Token));
        await scripted.Settle();
        _ = CallOf(router, Credential.Jwt("d.e.f"));
        _ = CallOf(router, Credential.None);
        _ = CallOf(router, Credential.Opaque());
        _ = CallOf(router, Credential.Elsewhere("Bearer mF_9.B5f-4.1JqM"));
        await scripted.Settle();

        Assert.Equal(
            [
                (1u, Credential.Jwt("d.e.f"), null),
                (3u, null, null),
                (5u, Credential.Opaque(Token), null),
                (7u, Credential.Elsewhere(), "Bearer mF_9.B5f-4.1JqM"),
            ],
            PresentedOf(transport));
        Assert.Equal(DefaultJwt, router.Credential);
    }

    [Fact]
    public void Refuses_OPAQUE_as_its_default_credential_and_a_JWT_under_limits_that_hold_no_header_of_1020_bytes()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            return new ScriptedRouter(new RouterClientOptions { Credential = Credential.Opaque() });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new ScriptedRouter(new RouterClientOptions { Credential = Credential.Opaque(Token) });
        });

        using var scripted = new ScriptedRouter(RouterLimits.Default with { ChunkBytes = 512, MaximumEnvelopeBytes = 512, WindowBytes = 1_024 });

        Assert.Throws<ArgumentException>(() =>
        {
            scripted.Router.Credential = DefaultJwt;
        });
        scripted.Router.Credential = Credential.Elsewhere("Interop sub=ada");
        Assert.Equal(Credential.Elsewhere("Interop sub=ada"), scripted.Router.Credential);
    }

    [Fact]
    public void Refuses_as_it_is_built_keys_or_a_key_set_without_an_audience()
    {
        var key = new JwtKey
        {
            Algorithm = JwtAlgorithm.Hs256,
            Issuer = "https://hs256.example",
            Jwk = JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["k"] = new('A', 43), ["kty"] = "oct" }),
        };

        var keySet = new Credentials
        {
            KeySet = new JwtKeySet
            {
                Issuers = ["https://keys.example"],
                Ask = (_, _) =>
                {
                    return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
                },
            },
        };

        foreach (var credentials in new[] { new Credentials { Keys = [key] }, keySet })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return new ScriptedRouter(new RouterClientOptions { Credentials = credentials });
            });

            // a client relays nothing: given its audience, it is built
            using var scripted = new ScriptedRouter(new RouterClientOptions { Credentials = credentials with { Audience = "bead-interop" } });

            Assert.Null(scripted.Router.Credential);
        }
    }

    // spec 13.4
    [Fact]
    public async Task Withdraws_its_default_once_a_call_that_presented_it_is_refused_SESSION_REQUIRED_the_next_call_that_would_present_it_fails_before_it_goes_SESSION_REQUIRED_nothing_sent_and_CredentialWithdrawn_fires_once_its_scheme_alone()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var first = CallOf(router);
        var second = CallOf(router);

        await scripted.Settle();
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        transport.Deliver(FailureOf(3, ProtocolCode.SessionRequired));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return first.WaitAsync(Patience, Cancelled);
        });

        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return second.WaitAsync(Patience, Cancelled);
        });
        Assert.False(refused.MayOvertake);

        // ! fails closed: never in the connection's session, nor in none, in silence
        var next = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return CallOf(router).WaitAsync(Patience, Cancelled);
        });

        await scripted.Settle();

        Assert.Equal(
            (FailureOrigin.Local, FailureScope.Protocol, (ushort)ProtocolCode.SessionRequired, "the default credential was withdrawn"),
            (next.Origin, next.Scope, next.Code, next.Failure.Detail));
        Assert.Equal([CredentialScheme.Jwt], withdrawn);
        Assert.Null(router.Credential);
        Assert.True(router.IsCredentialWithdrawn);
        Assert.Equal(2, PresentedOf(transport).Count);
    }

    // spec 13.4
    [Fact]
    public async Task After_a_withdrawal_a_call_that_gives_its_own_credential_or_NONE_goes_and_a_default_given_again_or_none_given_ends_the_withdrawal()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;
        Assert.False(router.IsCredentialWithdrawn);

        var first = CallOf(router);

        await scripted.Settle();
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return first.WaitAsync(Patience, Cancelled);
        });
        Assert.True(router.IsCredentialWithdrawn);

        // a call's own credential, NONE among them, goes: the call that renews it presents none
        _ = CallOf(router, Credential.None);
        _ = CallOf(router, Credential.Jwt("d.e.f"));
        await scripted.Settle();
        Assert.True(router.IsCredentialWithdrawn);

        // a default given again ends it, and so does none given: going on without one is written
        router.Credential = Credential.Jwt("g.h.i");
        Assert.False(router.IsCredentialWithdrawn);
        _ = CallOf(router);
        await scripted.Settle();

        var again = CallOf(router);

        await scripted.Settle();
        transport.Deliver(FailureOf(9, ProtocolCode.SessionRequired));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return again.WaitAsync(Patience, Cancelled);
        });
        Assert.True(router.IsCredentialWithdrawn);
        router.Credential = null;
        Assert.False(router.IsCredentialWithdrawn);
        _ = CallOf(router);
        await scripted.Settle();

        // NONE written as the header's absence of one
        List<(uint CallId, Credential? Credential, string? Carried)> presented =
        [
            (1, DefaultJwt, null),
            (3, null, null),
            (5, Credential.Jwt("d.e.f"), null),
            (7, Credential.Jwt("g.h.i"), null),
            (9, Credential.Jwt("g.h.i"), null),
            (11, null, null),
        ];

        Assert.Equal([CredentialScheme.Jwt, CredentialScheme.Jwt], withdrawn);
        Assert.Equal(presented, PresentedOf(transport));
    }

    [Fact]
    public async Task Withdraws_its_default_alike_when_the_refusal_crossed_a_relay()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = Credential.Elsewhere("Interop sub=ada") });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var relayed = CallOf(router);

        await scripted.Settle();
        transport.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfProtocol(ProtocolCode.SessionRequired) with { Relays = 1 } });

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return relayed.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(FailureOrigin.Relayed, refused.Origin);
        Assert.Equal([CredentialScheme.Elsewhere], withdrawn);
        Assert.Null(router.Credential);

        // the next call that would present it fails alike, before it goes
        var next = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return CallOf(router).WaitAsync(Patience, Cancelled);
        });

        await scripted.Settle();
        Assert.Equal((FailureOrigin.Local, (ushort)ProtocolCode.SessionRequired), (next.Origin, next.Code));
        Assert.Single(transport.Envelopes);
    }

    [Fact]
    public async Task Withdraws_nothing_and_fires_nothing_on_the_refusal_of_a_call_that_presented_a_default_since_given_anew()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var older = CallOf(router);

        await scripted.Settle();
        router.Credential = Credential.Jwt("d.e.f");
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return older.WaitAsync(Patience, Cancelled);
        });

        Assert.Empty(withdrawn);
        Assert.Equal(Credential.Jwt("d.e.f"), router.Credential);
    }

    [Fact]
    public async Task Withdraws_a_default_set_again_to_the_same_bytes_by_a_late_refusal_and_keeps_one_given_other_bytes()
    {
        var elsewhere = Credential.Elsewhere("Interop sub=ada");
        (Credential Given, bool IsKept)[] cases =
        [
            (Credential.Jwt(string.Concat("a.b", ".c")), false),
            (Credential.Jwt("d.e.f"), true),
            (Credential.Elsewhere(string.Concat("Interop ", "sub=ada")), false),
            (Credential.Elsewhere("Interop sub=ada, renewed"), true),
        ];

        foreach (var (given, isKept) in cases)
        {
            using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = given.Scheme == CredentialScheme.Jwt ? DefaultJwt : elsewhere });
            var (router, transport) = (scripted.Router, scripted.Transport);
            var withdrawn = new List<CredentialScheme>();

            router.CredentialWithdrawn += withdrawn.Add;

            var refused = CallOf(router);

            await scripted.Settle();

            // set again while the call was on its way: by value, what it presented, or other bytes
            router.Credential = given;
            transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
            await Assert.ThrowsAsync<FailureException>(() =>
            {
                return refused.WaitAsync(Patience, Cancelled);
            });

            List<CredentialScheme> told = isKept ? [] : [given.Scheme];

            Assert.Equal(isKept ? given : (Credential?)null, router.Credential);
            Assert.Equal(told, withdrawn);
        }
    }

    [Fact]
    public async Task Withdraws_nothing_when_a_call_that_presented_its_own_credential_is_refused_SESSION_REQUIRED()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var own = CallOf(router, Credential.Jwt("d.e.f"));
        var none = CallOf(router, Credential.None);

        await scripted.Settle();
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        transport.Deliver(FailureOf(3, ProtocolCode.SessionRequired));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return own.WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return none.WaitAsync(Patience, Cancelled);
        });

        Assert.Empty(withdrawn);
        Assert.Equal(DefaultJwt, router.Credential);
    }

    [Fact]
    public async Task Withdraws_nothing_when_SESSION_REQUIRED_ends_an_answered_subscription()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        await scripted.Settle();

        Assert.Equal([Failure.OfProtocol(ProtocolCode.SessionRequired)], notification.Dropped);
        Assert.Empty(withdrawn);
        Assert.Equal(DefaultJwt, router.Credential);
    }

    [Fact]
    public async Task Withdraws_nothing_when_SESSION_REQUIRED_that_ends_a_subscription_overtakes_its_result_the_call_failing_with_it_marked()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;

        var subscribing = await scripted.Subscribe(notification);

        // over HTTP, a listen's batch brings the failure before the POST's body brings the result
        transport.Overtaking(FailureOf(1, ProtocolCode.SessionRequired));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return subscribing.WaitAsync(Patience, Cancelled);
        });

        transport.Deliver(ResultOf(1));
        await scripted.Settle();

        Assert.True(refused.IsProtocol(ProtocolCode.SessionRequired));
        Assert.True(refused.MayOvertake);
        Assert.Empty(withdrawn);
        Assert.Equal(DefaultJwt, router.Credential);
        Assert.Equal([nameof(ProtocolCode.CallUnknown)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Fails_an_ELSEWHERE_over_a_transport_that_carries_none_before_it_goes_or_over_a_WebSocket_whose_upgrade_carried_other_bytes_DESTINATION_UNREACHABLE_nothing_sent_the_default_kept_no_event()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = Credential.Elsewhere("Interop sub=ada") });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var withdrawn = new List<CredentialScheme>();

        router.CredentialWithdrawn += withdrawn.Add;
        transport.CarriesCredential = false;

        var byDefault = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return CallOf(router).WaitAsync(Patience, Cancelled);
        });
        var own = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return CallOf(router, Credential.Elsewhere("Bearer mF_9.B5f-4.1JqM")).WaitAsync(Patience, Cancelled);
        });

        // a JWT, which travels in the block, goes over it
        _ = CallOf(router, DefaultJwt);
        await scripted.Settle();

        Assert.All([byDefault, own], (refused) =>
        {
            Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local), (refused.Code, refused.Origin));
        });
        Assert.Equal([(1u, (Credential?)DefaultJwt, (string?)null)], PresentedOf(transport));
        Assert.Empty(withdrawn);
        Assert.Empty(scripted.Errors);
        Assert.Equal(Credential.Elsewhere("Interop sub=ada"), router.Credential);

        // a WebSocket whose upgrade carried the default's bytes: another credential fails before it
        // goes, the very bytes go
        using var upgraded = new ScriptedRouter(new RouterClientOptions { Credential = Credential.Elsewhere("Interop sub=ada") });

        upgraded.Transport.CarriedByUpgrade = "Interop sub=ada";

        var other = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return CallOf(upgraded.Router, Credential.Elsewhere("Interop sub=bob")).WaitAsync(Patience, Cancelled);
        });

        _ = CallOf(upgraded.Router);
        await upgraded.Settle();

        Assert.Equal(
            ((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local, "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"),
            (other.Code, other.Origin, other.Failure.Detail));
        Assert.Equal([(1u, (Credential?)Credential.Elsewhere(), (string?)"Interop sub=ada")], PresentedOf(upgraded.Transport));
        Assert.Empty(upgraded.Errors);
    }

    [Fact]
    public async Task Fails_a_JWT_or_an_ELSEWHERE_over_a_transport_not_secure_before_it_goes_DESTINATION_UNREACHABLE_where_a_call_presenting_none_or_OPAQUE_goes()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = DefaultJwt });
        var (router, transport) = (scripted.Router, scripted.Transport);

        transport.IsSecure = false;
        transport.Deliver(ResultOf(99, Token));
        await scripted.Settle();

        foreach (var credential in new Credential?[] { null, Credential.Elsewhere("Interop sub=ada") })
        {
            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return CallOf(router, credential).WaitAsync(Patience, Cancelled);
            });

            Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local), (refused.Code, refused.Origin));
        }

        _ = CallOf(router, Credential.None);
        _ = CallOf(router, Credential.Opaque());
        await scripted.Settle();

        Assert.Equal([(1u, (Credential?)null, (string?)null), (3u, Credential.Opaque(Token), null)], PresentedOf(transport));
        Assert.Equal(DefaultJwt, router.Credential);
    }

    [Fact]
    public async Task Answers_a_command_presenting_ELSEWHERE_whose_transport_carried_nothing_SESSION_REQUIRED_no_credential_came_and_resolves_one_that_carried_a_value_by_its_verifier()
    {
        var verified = new List<string>();

        using var scripted = new ScriptedRouter(new RouterClientOptions
        {
            Credentials = new Credentials
            {
                Verify = (carried, _) =>
                {
                    verified.Add(carried);

                    return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = "server" });
                },
            },
        });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var sessions = new List<SessionIdentifier?>();

        router.RegisterResolver(new ScriptedResolver(Service, (props) =>
        {
            sessions.Add(props.Session?.Identifier);

            return router.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header));
        }));

        transport.Deliver(new Envelope { Header = RequestHeaderOf(2) with { Credential = Credential.Elsewhere() }, Payload = new byte[] { 1 } });
        transport.Carrying(new Envelope { Header = RequestHeaderOf(4) with { Credential = Credential.Elsewhere() }, Payload = new byte[] { 1 } }, "Interop sub=server");
        await scripted.Settle();

        Assert.Equal([(2u, ProtocolCode.SessionRequired)], transport.Failures);
        Assert.Equal("no credential came", transport.Envelopes[0].Failure!.Detail);
        Assert.Equal(["Interop sub=server"], verified);
        Assert.Equal([new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "server" }], sessions);
    }

    [Fact]
    public async Task Answers_a_command_that_presented_a_credential_whose_admission_refuses_SESSION_REQUIRED_ACCESS_DENIED_as_a_server_does()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions
        {
            Credentials = new Credentials
            {
                Verify = (_, _) =>
                {
                    return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = "server" });
                },
            },
        });
        var (router, transport) = (scripted.Router, scripted.Transport);

        // ! no service manager between: the router asks the resolver's admission itself
        router.RegisterResolver(
            new ScriptedResolver(Service, (_) =>
            {
                return Task.CompletedTask;
            })
            {
                Refusal = Failure.OfProtocol(ProtocolCode.SessionRequired, "short of its scope"),
            });
        transport.Carrying(new Envelope { Header = RequestHeaderOf(2) with { Credential = Credential.Elsewhere() }, Payload = new byte[] { 1 } }, "Interop sub=server");
        transport.Deliver(new Envelope { Header = RequestHeaderOf(4), Payload = new byte[] { 1 } });
        await scripted.Settle();

        // the command in none first: it resolves in the turn it came
        Assert.Equal([(4u, ProtocolCode.SessionRequired), (2u, ProtocolCode.AccessDenied)], transport.Failures);
        Assert.Equal("short of its scope", transport.Envelopes[1].Failure!.Detail);
        Assert.Empty(scripted.Errors);
    }
}
