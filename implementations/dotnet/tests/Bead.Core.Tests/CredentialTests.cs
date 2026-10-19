namespace Bead.Tests;

/// <summary><see cref="Credential"/>.</summary>
public sealed class CredentialTests
{
    // constants

    private static readonly SessionToken Token = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw");

    // definition

    [Fact]
    public void Announces_a_token_or_the_end_of_its_session()
    {
        Credential announced = Token;

        Assert.Equal(CredentialScheme.Opaque, announced.Scheme);
        Assert.Equal(Token, announced.SessionToken);
        Assert.Equal(Credential.Opaque(Token), announced);
        Assert.Equal(CredentialScheme.None, Credential.None.Scheme);
        Assert.Null(Credential.None.SessionToken);
        Assert.Equal(default, Credential.None);
    }

    [Fact]
    public void Holds_a_JWT_by_its_token_and_ELSEWHERE_by_its_scheme_alone()
    {
        var jwt = Credential.Jwt("a.b.c");

        Assert.Equal((CredentialScheme.Jwt, "a.b.c"), (jwt.Scheme, jwt.Token));
        Assert.Null(jwt.SessionToken);
        Assert.Equal(Credential.Jwt("a.b.c"), jwt);
        Assert.NotEqual(Credential.Jwt("a.b.d"), jwt);
        Assert.Equal(CredentialScheme.Elsewhere, Credential.Elsewhere().Scheme);
        Assert.True(Credential.Elsewhere().Bytes.IsEmpty);
    }

    [Fact]
    public void Holds_a_scheme_to_come_by_its_number_its_bytes_copied_and_compared_byte_for_byte()
    {
        byte[] bytes = [1, 2, 3];
        var credential = Credential.Of((CredentialScheme)65_535, bytes);

        bytes[0] = 9;

        Assert.Equal((CredentialScheme)65_535, credential.Scheme);
        Assert.Equal(new byte[] { 1, 2, 3 }, credential.Bytes.ToArray());
        Assert.Equal(Credential.Of((CredentialScheme)65_535, [1, 2, 3]), credential);
        Assert.Equal(Credential.Of((CredentialScheme)65_535, [1, 2, 3]).GetHashCode(), credential.GetHashCode());
        Assert.NotEqual(Credential.Of((CredentialScheme)4, [1, 2, 3]), credential);
        Assert.NotEqual(Credential.Of((CredentialScheme)65_535, [1, 2]), credential);
    }

    [Fact]
    public void Writes_its_scheme_alone_in_a_string_never_its_bytes_nor_what_its_transport_carries()
    {
        Assert.Equal("Credential { Scheme = Jwt }", Credential.Jwt("a.b.c").ToString());
        Assert.Equal("Credential { Scheme = Elsewhere }", Credential.Elsewhere("Interop sub=ada").ToString());
        Assert.Equal("Credential { Scheme = Opaque }", Credential.Opaque(Token).ToString());
        Assert.DoesNotContain("a.b.c", new RequestOptions { Credential = Credential.Jwt("a.b.c") }.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_transport_message_writes_whether_its_transport_carried_a_credential_never_the_credential()
    {
        var carrying = new TransportMessage(new byte[] { 1, 2, 3 }, false) { Credential = "Bearer SECRET", MayOvertake = true };

        Assert.Equal(
            "TransportMessage { Bytes = System.ReadOnlyMemory<Byte>[3], IsText = False, MayOvertake = True, Credential = carried }",
            carrying.ToString());
        Assert.DoesNotContain("SECRET", carrying.ToString(), StringComparison.Ordinal);
        Assert.EndsWith("MayOvertake = False, Credential = none }", new TransportMessage(new byte[] { 1 }, true).ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_session_request_writes_no_transport_credential_nor_whether_one_was_carried()
    {
        var request = new SessionRequest
        {
            ConnectionHandle = "first",
            Header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = Credential.Elsewhere() },
            TransportCredential = "Bearer SECRET",
        };

        // its public members alone, as the compiler writes them: the credential is the side's own
        Assert.StartsWith("SessionRequest { ConnectionHandle = first, Header = ", request.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("TransportCredential", request.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("SECRET", request.ToString(), StringComparison.Ordinal);
        Assert.Equal(request.ToString(), (request with { TransportCredential = null }).ToString());
    }

    [Fact]
    public void A_session_writes_whether_it_holds_a_token_never_the_token()
    {
        var session = new Session<string> { ConnectionHandle = "first", Data = "ada", SessionToken = Token };

        Assert.StartsWith("Session { ConnectionHandle = first, ConnectionInactivityTimeout = , Data = ada, LastActivity = ", session.ToString(), StringComparison.Ordinal);
        Assert.EndsWith(", SessionInactivityTimeout = , SessionToken = drawn }", session.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(Token.ToString(), session.ToString(), StringComparison.Ordinal);
        Assert.EndsWith(", SessionToken = none }", (session with { SessionToken = null }).ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(CredentialScheme.None)]
    [InlineData(CredentialScheme.Opaque)]
    [InlineData(CredentialScheme.Jwt)]
    [InlineData(CredentialScheme.Elsewhere)]
    public void Refuses_a_scheme_it_names_as_one_to_come(CredentialScheme scheme)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            Credential.Of(scheme, []);
        });
    }
}
