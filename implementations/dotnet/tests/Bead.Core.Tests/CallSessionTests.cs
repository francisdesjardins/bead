namespace Bead.Tests;

/// <summary>
/// <see cref="CallSession"/>'s functions, which both sides of a router share: what
/// CREDENTIAL_UNSUPPORTED names, the connection's session none and OPAQUE resolve to, the header a
/// procedure is handed, and the credential a call of a side's own presents.
/// </summary>
public sealed class CallSessionTests
{
    // constants

    private static readonly SessionToken Token = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw");

    private static readonly SessionToken Another = SessionToken.Parse("AQIDBAUGBwgJCgsMDQ4PEA");

    // definition

    [Fact]
    public void CredentialSchemesDetailOf_names_the_schemes_a_side_takes_in_the_order_of_their_numbers_a_comma_and_a_space_between()
    {
        Assert.Equal("OPAQUE", CallSession.CredentialSchemesDetailOf([CredentialScheme.Opaque]));
        Assert.Equal(
            "OPAQUE, JWT, ELSEWHERE",
            CallSession.CredentialSchemesDetailOf([CredentialScheme.Elsewhere, CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Opaque]));
        Assert.Equal("OPAQUE, ELSEWHERE", CallSession.CredentialSchemesDetailOf([CredentialScheme.Elsewhere, CredentialScheme.Opaque]));
    }

    [Fact]
    public void ConnectionSessionOf_runs_none_in_the_connection_s_session_whenever_it_has_one_and_OPAQUE_when_it_is_its_token_nothing_else()
    {
        var held = (Token, (object?)"ada");

        Assert.Equal(new CallSession { Data = "ada" }, CallSession.ConnectionSessionOf(null, held));
        Assert.Equal(new CallSession { Data = "ada" }, CallSession.ConnectionSessionOf(Credential.Opaque(Token), held));
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Opaque(Another), held));
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Jwt("a.b.c"), held));
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Elsewhere(), held));

        // a connection with no session runs none in none, and nothing holds
        Assert.Null(CallSession.ConnectionSessionOf(null, (null, null)));
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Opaque(Token), (null, null)));
    }

    [Fact]
    public void HandedHeaderOf_keeps_of_a_JWT_its_scheme_alone_in_a_copy_and_hands_any_other_header_as_it_came()
    {
        var header = new RequestHeader { CallId = 1, ProcedureId = 1, ServiceId = 2 };
        var jwt = header with { Credential = Credential.Jwt("a.b.c") };
        var handed = CallSession.HandedHeaderOf(jwt);

        Assert.Equal(header with { Credential = Credential.SchemeOf(CredentialScheme.Jwt) }, handed);
        Assert.Null(handed.Credential?.Token);

        // the header as it came keeps its token, for its verifier; one made already is made to itself
        Assert.Equal("a.b.c", jwt.Credential?.Token);
        Assert.Same(handed, CallSession.HandedHeaderOf(handed));

        foreach (var credential in new Credential?[] { null, Credential.Opaque(Token), Credential.Elsewhere() })
        {
            var other = header with { Credential = credential };

            Assert.Same(other, CallSession.HandedHeaderOf(other));
        }
    }

    [Fact]
    public void PresentedCredentialOf_presents_none_unless_asked_OPAQUE_with_the_token_learned_and_fails_a_call_that_asks_before_any_session_SESSION_REQUIRED()
    {
        Assert.Equal((null, null, null), CallSession.PresentedCredentialOf(null, Token));
        Assert.Equal((null, null, null), CallSession.PresentedCredentialOf(Credential.None, Token));
        Assert.Equal((Credential.Opaque(Token), null, null), CallSession.PresentedCredentialOf(Credential.Opaque(), Token));

        var (presented, carried, refusal) = CallSession.PresentedCredentialOf(Credential.Opaque(), null);

        Assert.Null(presented);
        Assert.Null(carried);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, refusal!.Code);
        Assert.Equal(FailureScope.Protocol, refusal.Scope);
    }

    [Fact]
    public void Presents_NONE_as_none_a_JWT_as_given_and_an_ELSEWHERE_as_its_scheme_its_value_beside_it_for_its_transport()
    {
        Assert.Equal((null, null, null), CallSession.PresentedCredentialOf(Credential.None, null));
        Assert.Equal((Credential.Jwt("a.b.c"), null, null), CallSession.PresentedCredentialOf(Credential.Jwt("a.b.c"), null));
        Assert.Equal(
            (Credential.Elsewhere(), "Interop sub=ada", null),
            CallSession.PresentedCredentialOf(Credential.Elsewhere("Interop sub=ada"), null));

        foreach (var refused in new[] { Credential.Jwt(""), Credential.Elsewhere(), Credential.Of((CredentialScheme)4, [1]) })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                CallSession.AssertPresentable(refused);
            });
        }
    }

    [Fact]
    public void Fails_an_ELSEWHERE_over_a_transport_that_carries_none_and_a_JWT_or_an_ELSEWHERE_over_one_not_secure_DESTINATION_UNREACHABLE_none_or_OPAQUE_goes_over_any()
    {
        var uncarried = (Credential? presented, (bool, bool) transport) =>
        {
            return CallSession.UncarriedOf(presented, transport)?.Code;
        };
        const ushort Unreachable = (ushort)ProtocolCode.DestinationUnreachable;

        var transports = new[] { (true, true), (false, true), (true, false), (false, false) };
        var credentials = new Credential?[] { null, Credential.Opaque(Token), Credential.Jwt("a.b.c"), Credential.Elsewhere() };
        ushort?[][] expected =
        [
            [null, null, null, null],
            [null, null, null, null],
            [null, null, Unreachable, Unreachable],
            [null, Unreachable, Unreachable, Unreachable],
        ];

        for (var index = 0; index < credentials.Length; index += 1)
        {
            Assert.Equal(expected[index], transports.Select((transport) =>
            {
                return uncarried(credentials[index], transport);
            }));
        }

        Assert.Equal(
            "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another",
            CallSession.UncarriedOf(Credential.Elsewhere(), (false, true))?.Detail);
        foreach (var credential in new[] { Credential.Jwt("a.b.c"), Credential.Elsewhere() })
        {
            Assert.Equal(
                "its transport leaves the machine in the clear, which a bearer credential never crosses",
                CallSession.UncarriedOf(credential, (true, false))?.Detail);
        }
    }

    [Fact]
    public void Keys_a_session_by_its_scheme_its_claim_and_its_values_one_sub_under_two_issuers_sid_and_sub_and_the_connection_s_session_apart()
    {
        var grace = new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sub = "grace" };

        Assert.Equal(grace, new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sub = "grace" });
        Assert.NotEqual(grace, grace with { Issuer = "https://b.example" });
        Assert.NotEqual(grace, new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sid = "grace" });
        Assert.NotEqual(grace, new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "grace" });

        var keys = new SessionIdentifier?[]
        {
            null, grace, grace with { Issuer = "https://b.example" },
            new() { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sid = "grace" },
            new() { Scheme = CredentialScheme.Elsewhere, Id = "grace" },
            grace with { Sub = "Grace" },
            new() { Scheme = CredentialScheme.Elsewhere, Id = "é" },
            new() { Scheme = CredentialScheme.Elsewhere, Id = "é" },
        };

        Assert.Equal(keys.Length, keys.ToHashSet().Count);

        // octet for octet: a case or a normal form of its own is another
        Assert.NotEqual(grace, grace with { Sub = "Grace" });
        Assert.NotEqual(
            new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "é" },
            new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "é" });

        // where a subscription is held: the connection's session apart from every credential's
        Assert.NotEqual(new Subscriber { ConnectionHandle = "first" }, new Subscriber { ConnectionHandle = "first", Identifier = grace });
        Assert.Equal(new Subscriber { ConnectionHandle = "first", Identifier = grace }, new Subscriber { ConnectionHandle = "first", Identifier = grace with { } });
        Assert.NotEqual(new Subscriber { ConnectionHandle = "first", Identifier = grace }, new Subscriber { ConnectionHandle = "second", Identifier = grace });
    }
}
