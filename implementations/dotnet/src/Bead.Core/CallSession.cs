namespace Bead;

/// <summary>
/// The session a call runs in, its call's session, as its credential resolved it (spec 13.1): a
/// request presenting none runs in its connection's session, and one presenting
/// <see cref="CredentialScheme.Opaque"/> in the connection's session whose token it carries. Its
/// admission reads it, and its resolver receives it; a call in none has none.
/// </summary>
public sealed record CallSession
{
    /// <summary>What the side keeps about the session: a connection's session's data.</summary>
    public object? Data { get; init; }

    /// <summary>
    /// What CREDENTIAL_UNSUPPORTED's detail says (spec 9.2, step 5): the names of the credential
    /// schemes a side takes, in the order of their numbers, a comma and a space between —
    /// <c>OPAQUE, JWT, ELSEWHERE</c> from a side that takes them all.
    /// </summary>
    internal static string CredentialSchemesDetailOf(IEnumerable<CredentialScheme> schemes)
    {
        return string.Join(", ", schemes.Distinct().Order().Select(EnvelopeCodec.SchemeNameOf));
    }

    /// <summary>
    /// The connection's session a credential of none or <see cref="CredentialScheme.Opaque"/>
    /// resolves to, against the token and the data a side holds for the connection: none presented,
    /// its session, or none when it has none; an <see cref="CredentialScheme.Opaque"/>, that session
    /// when it carries its token, compared in constant time, and none otherwise, which does not
    /// hold. Any other scheme resolves to none.
    /// </summary>
    internal static CallSession? ConnectionSessionOf(Credential? presented, (SessionToken? Token, object? Data) held)
    {
        if (held.Token is not { } token)
        {
            return null;
        }

        return presented switch
        {
            null => new CallSession { Data = held.Data },
            { Scheme: CredentialScheme.Opaque, SessionToken: { } carried } when token.FixedTimeEquals(carried) => new CallSession { Data = held.Data },
            _ => null,
        };
    }

    /// <summary>
    /// The credential a call of a side's own presents, as its options ask, against the token of the
    /// connection's session the side knows: none, unless asked — <see cref="CredentialScheme.None"/>
    /// presents none; <see cref="Credential.Opaque()"/> presents that token, and refuses
    /// SESSION_REQUIRED while the side knows none, before the call goes; any other as it is asked.
    /// </summary>
    internal static (Credential? Presented, Failure? Refusal) PresentedCredentialOf(Credential? asked, SessionToken? known)
    {
        if (asked is not { Scheme: not CredentialScheme.None } credential)
        {
            return (null, null);
        }

        // TODO a JWT or an ELSEWHERE in the clear off the machine, or an ELSEWHERE over a transport
        // that carries none, fails before it goes, DESTINATION_UNREACHABLE (decision 0010): until
        // then it goes as it is asked
        if (credential is not { Scheme: CredentialScheme.Opaque, SessionToken: null })
        {
            return (credential, null);
        }

        return known is { } token
            ? (Credential.Opaque(token), null)
            : (null, Failure.OfProtocol(ProtocolCode.SessionRequired, "no session is known for OPAQUE to stand for"));
    }
}

/// <summary>
/// A request as the router asks its session of it: where it came from, its header — the credential
/// it presents among it — and the credential its transport carried beside it.
/// </summary>
public sealed record SessionRequest
{
    /// <summary>The connection it came from.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>Its header, its credential among it.</summary>
    public required RequestHeader Header { get; init; }

    /// <summary>
    /// The credential its transport carried beside it, which an <see cref="CredentialScheme.Elsewhere"/>
    /// stands for: over HTTP, its <c>Authorization</c> field; none when nothing was carried.
    /// </summary>
    public string? TransportCredential { get; init; }
}
