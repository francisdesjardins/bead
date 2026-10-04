using System.Buffers.Binary;
using System.Buffers.Text;

namespace Bead;

/// <summary>
/// A session's token, the credential of scheme <see cref="CredentialScheme.Opaque"/>: 16 bytes, never
/// all zero. Written as unpadded base64url.
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
    /// for 16 zero bytes, which are no token.
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

    /// <summary>
    /// Whether <paramref name="other"/> is this token, compared in a time that does not depend on
    /// where they differ (spec 9.2, step 5): what a request presents tells nothing of the token it
    /// was held to.
    /// </summary>
    internal bool FixedTimeEquals(SessionToken other)
    {
        Span<byte> bytes = stackalloc byte[Bytes];
        Span<byte> others = stackalloc byte[Bytes];

        BinaryPrimitives.WriteUInt128BigEndian(bytes, _value);
        BinaryPrimitives.WriteUInt128BigEndian(others, other._value);

        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(bytes, others);
    }

    private void AssertToken()
    {
        if (_value == UInt128.Zero)
        {
            throw new InvalidOperationException("the default session token is no token");
        }
    }
}
