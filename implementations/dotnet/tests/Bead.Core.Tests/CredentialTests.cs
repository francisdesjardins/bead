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
        Assert.Equal(CredentialScheme.Elsewhere, Credential.Elsewhere.Scheme);
        Assert.True(Credential.Elsewhere.Bytes.IsEmpty);
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
