namespace Bead;

/// <summary>
/// A credential of a scheme, as a header's CREDENTIAL block carries it: on a request, the
/// credential it presents; on a result or a failure, what it announces of its connection's session —
/// <see cref="CredentialScheme.Opaque"/>, its token, once it opened or was drawn anew, or
/// <see cref="CredentialScheme.None"/>, once it ended. The default value is <see cref="None"/>.
/// </summary>
public readonly record struct Credential
{
    // constants

    /// <summary>The block's own head: its scheme on 2 bytes, then its length on 2.</summary>
    internal const int HeadBytes = 4;

    /// <summary>
    /// The most an announcement takes, its block with <see cref="CredentialScheme.Opaque"/>'s token,
    /// which a side counts where it sizes an answer before knowing whether one rides on it.
    /// </summary>
    internal const int AnnouncementBytes = HeadBytes + Bead.SessionToken.Bytes;

    // definition

    /// <summary>No credential: on an answer, the announcement that its session ended.</summary>
    public static Credential None
    {
        get
        {
            return default;
        }
    }

    /// <summary>The credential its transport carried beside the envelope: none in the block.</summary>
    public static Credential Elsewhere { get; } = new() { Scheme = CredentialScheme.Elsewhere };

    /// <summary>What the credential is: the format of its bytes.</summary>
    public CredentialScheme Scheme { get; private init; }

    /// <summary>
    /// The token of a connection's session, for <see cref="CredentialScheme.Opaque"/>; none for any
    /// other scheme.
    /// </summary>
    public SessionToken? SessionToken { get; private init; }

    /// <summary>
    /// A JWT's token, for <see cref="CredentialScheme.Jwt"/>, a character a byte; none for any other
    /// scheme.
    /// </summary>
    public string? Token { get; private init; }

    /// <summary>A scheme to come's bytes, read whole; none for a scheme this side names.</summary>
    public ReadOnlyMemory<byte> Bytes { get; private init; }

    /// <summary>The token of a connection's session, presented or announced.</summary>
    public static Credential Opaque(SessionToken token)
    {
        return new Credential { Scheme = CredentialScheme.Opaque, SessionToken = token };
    }

    /// <summary>A JWT, its token in JWS Compact Serialization (RFC 7515).</summary>
    public static Credential Jwt(string token)
    {
        ArgumentNullException.ThrowIfNull(token);

        return new Credential { Scheme = CredentialScheme.Jwt, Token = token };
    }

    /// <summary>
    /// A credential of a scheme to come, from 4 to 65535, its bytes copied. Throws an
    /// <see cref="ArgumentOutOfRangeException"/> for a scheme this side names, which has its own.
    /// </summary>
    public static Credential Of(CredentialScheme scheme, ReadOnlySpan<byte> bytes)
    {
        if (scheme <= CredentialScheme.Elsewhere)
        {
            throw new ArgumentOutOfRangeException(
                nameof(scheme),
                $"a scheme to come is from 4 to 65535, got {(ushort)scheme}");
        }

        return new Credential { Scheme = scheme, Bytes = bytes.ToArray() };
    }

    /// <summary>The credential of <paramref name="token"/>: <see cref="CredentialScheme.Opaque"/>.</summary>
    public static implicit operator Credential(SessionToken token)
    {
        return Opaque(token);
    }

    /// <summary>Whether both are of one scheme, with the same credential, byte for byte.</summary>
    public bool Equals(Credential other)
    {
        return Scheme == other.Scheme
            && SessionToken == other.SessionToken
            && string.Equals(Token, other.Token, StringComparison.Ordinal)
            && Bytes.Span.SequenceEqual(other.Bytes.Span);
    }

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        var hash = new HashCode();

        hash.Add(Scheme);
        hash.Add(SessionToken);
        hash.Add(Token, StringComparer.Ordinal);
        hash.AddBytes(Bytes.Span);

        return hash.ToHashCode();
    }
}
