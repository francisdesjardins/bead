using System.Globalization;
using System.Text;

namespace Bead;

/// <summary>
/// The identifier of a credential's session (spec 13.10): the record of its credential scheme and
/// its claim — a <see cref="CredentialScheme.Jwt"/>'s <see cref="Issuer"/> with its
/// <see cref="Sid"/>, else with its <see cref="Sub"/>; an
/// <see cref="CredentialScheme.Elsewhere"/>'s verifier's <see cref="Id"/>. Two are one when their
/// scheme, their claim's name and their values are equal, octet for octet, as a record compares
/// its strings, ordinally: one <c>sub</c> under two issuers names two sessions.
/// </summary>
public sealed record SessionIdentifier
{
    /// <summary>The credential scheme of the credential it was resolved from.</summary>
    public required CredentialScheme Scheme { get; init; }

    /// <summary>A <see cref="CredentialScheme.Jwt"/>'s <c>iss</c>, its key's issuer; none for another scheme.</summary>
    public string? Issuer { get; init; }

    /// <summary>A <see cref="CredentialScheme.Jwt"/>'s <c>sid</c>, when it carries one; none otherwise.</summary>
    public string? Sid { get; init; }

    /// <summary>A <see cref="CredentialScheme.Jwt"/>'s <c>sub</c>, when it carries no <c>sid</c>; none otherwise.</summary>
    public string? Sub { get; init; }

    /// <summary>The <c>id</c> an <see cref="CredentialScheme.Elsewhere"/>'s verifier gave; none for another scheme.</summary>
    public string? Id { get; init; }
}

/// <summary>
/// The session a call runs in, its call's session, as its credential resolved it (spec 13.1): a
/// request presenting none runs in its connection's session, and one presenting
/// <see cref="CredentialScheme.Opaque"/> in the connection's session whose token it carries; one
/// presenting <see cref="CredentialScheme.Jwt"/> or <see cref="CredentialScheme.Elsewhere"/>, in a
/// credential's session, with its own credential's data. Its admission reads it, and its resolver
/// receives it; a call in none has none.
/// </summary>
public sealed record CallSession
{
    /// <summary>
    /// What the session holds: a connection's session's data, as its server keeps it; a
    /// <see cref="CredentialScheme.Jwt"/>'s claims set, a <see cref="System.Text.Json.JsonElement"/>;
    /// what an <see cref="CredentialScheme.Elsewhere"/>'s verifier gave.
    /// </summary>
    public object? Data { get; init; }

    /// <summary>A credential's session's identifier; none for a connection's session.</summary>
    public SessionIdentifier? Identifier { get; init; }

    /// <summary>
    /// A credential's session's end, in whole milliseconds since the epoch (spec 13.10): the end
    /// its side keeps for its identifier on its connection, when it keeps one, the later of those
    /// resolved; its own otherwise. None for a connection's session, and for a session no timer
    /// ends.
    /// </summary>
    public long? End { get; init; }

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
    /// The credential a call of a side's own presents in its header, as its options ask, against
    /// the token of the connection's session the side knows, and what its transport carries beside
    /// it: none, unless asked — <see cref="CredentialScheme.None"/> presents none;
    /// <see cref="Credential.Opaque()"/> presents that token, and refuses SESSION_REQUIRED while the
    /// side knows none, before the call goes; an <see cref="CredentialScheme.Elsewhere"/>, its scheme
    /// in the header, its block holding nothing, and its value beside it; any other as it is asked.
    /// </summary>
    internal static (Credential? Presented, string? Carried, Failure? Refusal) PresentedCredentialOf(Credential? asked, SessionToken? known)
    {
        return asked switch
        {
            null or { Scheme: CredentialScheme.None } => (null, null, null),
            { Scheme: CredentialScheme.Opaque, SessionToken: null } => known is { } token
                ? (Credential.Opaque(token), null, null)
                : (null, null, Failure.OfProtocol(ProtocolCode.SessionRequired, "no session is known for OPAQUE to stand for")),
            { Scheme: CredentialScheme.Elsewhere } elsewhere => (Credential.Elsewhere(), elsewhere.Carried, null),
            { } credential => (credential, null, null),
        };
    }

    /// <summary>
    /// Throws an <see cref="ArgumentException"/> for a credential no call presents, its
    /// application's error, before the call starts and is counted (spec 13.4; spec/debugging.md
    /// 9.3): a <see cref="CredentialScheme.Jwt"/> with no token; an
    /// <see cref="CredentialScheme.Elsewhere"/> that gives nothing for its transport to carry, as a
    /// header's <see cref="Credential.Elsewhere()"/> holds nothing to present; and a scheme to come.
    /// A call presents none, <see cref="CredentialScheme.None"/>, <see cref="CredentialScheme.Opaque"/>,
    /// a JWT with its token, or an ELSEWHERE with its bytes.
    /// </summary>
    internal static void AssertPresentable(Credential? asked)
    {
        switch (asked)
        {
            case null or { Scheme: CredentialScheme.None or CredentialScheme.Opaque }:
                break;
            case { Scheme: CredentialScheme.Jwt, Token: null or "" }:
                throw new ArgumentException("a call that presents a JWT gives its token", nameof(asked));
            case { Scheme: CredentialScheme.Jwt }:
                break;
            case { Scheme: CredentialScheme.Elsewhere, Carried: null }:
                throw new ArgumentException(
                    "a call that presents ELSEWHERE gives what its transport carries: a header's ELSEWHERE holds nothing to present",
                    nameof(asked));
            case { Scheme: CredentialScheme.Elsewhere }:
                break;
            case { } toCome:
                throw new ArgumentException($"a call presents NONE, OPAQUE, JWT or ELSEWHERE, not scheme {(ushort)toCome.Scheme}", nameof(asked));
        }
    }

    /// <summary>
    /// The failure of a call presenting <paramref name="presented"/> that its transport cannot carry
    /// (spec 13.4): DESTINATION_UNREACHABLE, nothing tried, for an
    /// <see cref="CredentialScheme.Elsewhere"/> over a transport that does not carry the credential
    /// it presents beside an envelope — none, or, over a WebSocket, another than its upgrade's — and
    /// for a <see cref="CredentialScheme.Jwt"/> or an <see cref="CredentialScheme.Elsewhere"/> over
    /// one that is not secure; none for a call it carries, any presenting none or
    /// <see cref="CredentialScheme.Opaque"/> among them. Its detail names the scheme alone, never
    /// the credential (spec 15.1).
    /// </summary>
    internal static Failure? UncarriedOf(Credential? presented, (bool Carries, bool IsSecure) transport)
    {
        return presented?.Scheme switch
        {
            CredentialScheme.Elsewhere when !transport.Carries => Failure.OfProtocol(
                ProtocolCode.DestinationUnreachable,
                "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"),
            CredentialScheme.Jwt or CredentialScheme.Elsewhere when !transport.IsSecure => Failure.OfProtocol(
                ProtocolCode.DestinationUnreachable,
                "its transport leaves the machine in the clear, which a bearer credential never crosses"),
            _ => null,
        };
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
    /// stands for: over HTTP, its <c>Authorization</c> field; over a WebSocket, that of its
    /// connection's upgrade from no page; none when nothing was carried.
    /// </summary>
    public string? TransportCredential { get; init; }

    /// <summary>
    /// The audiences a <see cref="CredentialScheme.Jwt"/> is held to in place of the side's own: a
    /// relay's that verifies, those its destinations were registered with as the call came.
    /// </summary>
    internal IReadOnlyCollection<string>? Audiences { get; init; }

    // every public member as the compiler writes it, its header's credential its scheme alone, but
    // the transport's credential, of which whether one was carried
    private bool PrintMembers(StringBuilder builder)
    {
        // ! a credential's own string reaches no log, no exception's message and no debugger (spec
        // 15.1): whether there is one, alone
        builder.Append(CultureInfo.CurrentCulture, $"ConnectionHandle = {ConnectionHandle}, Header = {Header}, TransportCredential = ");
        builder.Append(TransportCredential is null ? "none" : "carried");

        return true;
    }
}
