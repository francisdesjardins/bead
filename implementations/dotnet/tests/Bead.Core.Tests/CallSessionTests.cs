namespace Bead.Tests;

/// <summary>
/// <see cref="CallSession"/>'s functions, which both sides of a router share: what
/// CREDENTIAL_UNSUPPORTED names, the connection's session none and OPAQUE resolve to, and the
/// credential a call of a side's own presents.
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
            CallSession.CredentialSchemesDetailOf([CredentialScheme.Elsewhere, CredentialScheme.Opaque, CredentialScheme.Jwt]));
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

        Assert.Equal(Unreachable, uncarried(Credential.Elsewhere(), (false, true)));
        Assert.Equal(Unreachable, uncarried(Credential.Elsewhere(), (true, false)));
        Assert.Equal(Unreachable, uncarried(Credential.Jwt("a.b.c"), (true, false)));
        Assert.Null(uncarried(Credential.Jwt("a.b.c"), (false, true)));
        Assert.Null(uncarried(Credential.Elsewhere(), (true, true)));

        foreach (var any in new[] { (false, false), (true, true) })
        {
            Assert.Null(uncarried(null, any));
            Assert.Null(uncarried(Credential.Opaque(Token), any));
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
