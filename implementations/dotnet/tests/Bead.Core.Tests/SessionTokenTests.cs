namespace Bead.Tests;

/// <summary><see cref="SessionToken"/>.</summary>
public sealed class SessionTokenTests
{
    // constants

    private const string Text = "AAECAwQFBgcICQoLDA0ODw";

    private static readonly byte[] Bytes = Vectors.FromHexadecimal("00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F");

    // definition

    [Fact]
    public void Spells_its_16_bytes_in_unpadded_base64url_and_reads_them_back()
    {
        var token = SessionToken.FromBytes(Bytes);
        var written = new byte[SessionToken.Bytes];

        token.CopyTo(written);

        Assert.Equal(Text, token.ToString());
        Assert.Equal(token, SessionToken.Parse(Text));
        Assert.Equal(Bytes, written);
    }

    [Fact]
    public void Is_one_token_only_when_every_byte_is_one_byte_apart_at_either_end_is_another()
    {
        var token = SessionToken.FromBytes(Bytes);

        SessionToken Apart(int index)
        {
            var bytes = (byte[])Bytes.Clone();

            bytes[index] ^= 0x01;

            return SessionToken.FromBytes(bytes);
        }

        Assert.True(token.FixedTimeEquals(SessionToken.Parse(Text)));
        Assert.False(token.FixedTimeEquals(Apart(0)));
        Assert.False(token.FixedTimeEquals(Apart(SessionToken.Bytes - 1)));
    }

    [Theory]
    [InlineData(15)]
    [InlineData(17)]
    public void Refuses_bytes_of_another_length(int length)
    {
        Assert.Throws<ArgumentException>(() =>
        {
            SessionToken.FromBytes(new byte[length]);
        });
    }

    [Fact]
    public void Refuses_16_zero_bytes_which_are_no_token()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            SessionToken.FromBytes(new byte[SessionToken.Bytes]);
        });
        Assert.False(SessionToken.IsSessionToken(new string('A', 22)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("AAECAwQFBgcICQoLDA0OD")]
    [InlineData("AAECAwQFBgcICQoLDA0ODw==")]
    [InlineData("AAECAwQFBgcICQoLDA0ODx")]
    [InlineData("AAECAwQFBgcICQoLDA0O+w")]
    [InlineData("AAECAwQFBgcICQoLDA0O/w")]
    [InlineData("AAECAwQFBgcICQoLDA0O w")]
    public void Refuses_text_that_spells_no_token(string? text)
    {
        Assert.False(SessionToken.IsSessionToken(text));
    }

    [Fact]
    public void Throws_parsing_text_that_spells_no_token()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            SessionToken.Parse("AAECAwQFBgcICQoLDA0ODx");
        });
    }

    [Fact]
    public void Refuses_to_write_the_default_value_which_is_no_token()
    {
        Assert.Throws<InvalidOperationException>(() =>
        {
            default(SessionToken).CopyTo(new byte[SessionToken.Bytes]);
        });
        Assert.Equal("", default(SessionToken).ToString());
    }
}
