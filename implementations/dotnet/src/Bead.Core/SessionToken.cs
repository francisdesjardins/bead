using System.Buffers.Binary;
using System.Buffers.Text;

namespace Bead;

/// <summary>
/// A session's token: 16 bytes, never all zero, which say a session ended. Written as unpadded
/// base64url, as the vectors write it.
/// </summary>
public readonly record struct SessionToken
{
    /// <summary>A session token's length, in bytes.</summary>
    public const int Bytes = 16;

    private readonly UInt128 _value;

    private SessionToken(UInt128 value)
    {
        _value = value;
    }

    /// <summary>
    /// The token 16 bytes spell. Throws an <see cref="ArgumentException"/> for any other length, or
    /// for 16 zero bytes, which say a session ended.
    /// </summary>
    public static SessionToken FromBytes(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != Bytes)
        {
            throw new ArgumentException(
                $"a session token is {Bytes} bytes, not all zero; got {bytes.Length}",
                nameof(bytes));
        }

        var value = BinaryPrimitives.ReadUInt128BigEndian(bytes);

        if (value == UInt128.Zero)
        {
            throw new ArgumentException(
                $"a session token is {Bytes} bytes, not all zero; got {bytes.Length}",
                nameof(bytes));
        }

        return new SessionToken(value);
    }

    /// <summary>
    /// Whether <paramref name="text"/> is a session token: 16 bytes, not all zero, in unpadded
    /// base64url.
    /// </summary>
    public static bool IsSessionToken(string? text)
    {
        return TryParse(text, out _);
    }

    /// <summary>
    /// The token <paramref name="text"/> spells. Throws an <see cref="ArgumentException"/> for text
    /// that is not one.
    /// </summary>
    public static SessionToken Parse(string text)
    {
        if (!TryParse(text, out var token))
        {
            throw new ArgumentException($"\"{text}\" is not a session token", nameof(text));
        }

        return token;
    }

    /// <summary>The token <paramref name="text"/> spells, when it is one.</summary>
    public static bool TryParse(string? text, out SessionToken token)
    {
        Span<byte> bytes = stackalloc byte[Bytes];

        token = default;

        // 22 characters spell 16 bytes, unpadded; `IsValid` refuses a last one whose 4 low bits are
        // not zero, so a token has one spelling, and decoding, which throws on what is not
        // base64url, is asked only of valid text
        if (text is null
            || text.Length != Base64Url.GetEncodedLength(Bytes)
            || !Base64Url.IsValid(text, out var length)
            || length != Bytes
            || !Base64Url.TryDecodeFromChars(text, bytes, out var written)
            || written != Bytes)
        {
            return false;
        }

        var value = BinaryPrimitives.ReadUInt128BigEndian(bytes);

        if (value == UInt128.Zero)
        {
            return false;
        }

        token = new SessionToken(value);

        return true;
    }

    /// <summary>
    /// Writes the token's 16 bytes at the start of <paramref name="bytes"/>. Throws an
    /// <see cref="InvalidOperationException"/> for the default value, which is no token.
    /// </summary>
    public void CopyTo(Span<byte> bytes)
    {
        AssertToken();
        BinaryPrimitives.WriteUInt128BigEndian(bytes, _value);
    }

    /// <summary>The token in unpadded base64url.</summary>
    public override string ToString()
    {
        Span<byte> bytes = stackalloc byte[Bytes];

        if (_value == UInt128.Zero)
        {
            return "";
        }

        BinaryPrimitives.WriteUInt128BigEndian(bytes, _value);

        return Base64Url.EncodeToString(bytes);
    }

    /// <summary>Whether this is the default value, which is no token.</summary>
    internal bool IsDefault
    {
        get
        {
            return _value == UInt128.Zero;
        }
    }

    private void AssertToken()
    {
        if (_value == UInt128.Zero)
        {
            throw new InvalidOperationException("the default session token is no token");
        }
    }
}

/// <summary>
/// What an answer says of its connection's session, when it changed: the token it changed to, or
/// that it ended — the TypeScript side's <c>sessionToken</c>, <c>null</c> once ended.
/// </summary>
public readonly record struct SessionAnnouncement
{
    private SessionAnnouncement(SessionToken token)
    {
        Token = token;
    }

    /// <summary>The announcement that the session ended: 16 zero bytes.</summary>
    public static SessionAnnouncement Ended { get; }

    /// <summary>The token the session changed to; none once it ended.</summary>
    public SessionToken? Token { get; }

    /// <summary>Whether the session ended.</summary>
    public bool IsEnded
    {
        get
        {
            return Token is null;
        }
    }

    /// <summary>The announcement of <paramref name="token"/>.</summary>
    public static SessionAnnouncement Of(SessionToken token)
    {
        return new SessionAnnouncement(token);
    }

    /// <summary>The announcement of <paramref name="token"/>.</summary>
    public static implicit operator SessionAnnouncement(SessionToken token)
    {
        return Of(token);
    }
}
