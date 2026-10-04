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
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Elsewhere, held));

        // a connection with no session runs none in none, and nothing holds
        Assert.Null(CallSession.ConnectionSessionOf(null, (null, null)));
        Assert.Null(CallSession.ConnectionSessionOf(Credential.Opaque(Token), (null, null)));
    }

    [Fact]
    public void PresentedCredentialOf_presents_none_unless_asked_OPAQUE_with_the_token_learned_and_fails_a_call_that_asks_before_any_session_SESSION_REQUIRED()
    {
        Assert.Equal((null, null), CallSession.PresentedCredentialOf(null, Token));
        Assert.Equal((null, null), CallSession.PresentedCredentialOf(Credential.None, Token));
        Assert.Equal((Credential.Opaque(Token), null), CallSession.PresentedCredentialOf(Credential.Opaque(), Token));

        var (presented, refusal) = CallSession.PresentedCredentialOf(Credential.Opaque(), null);

        Assert.Null(presented);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, refusal!.Code);
        Assert.Equal(FailureScope.Protocol, refusal.Scope);
    }
}
