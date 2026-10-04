using System.Text.Json;

namespace Bead;

/// <summary>
/// A key a key set answers for the issuer it was asked for (RFC 7517 §5): a JWK, and its one
/// algorithm, which the application names (RFC 8725 §3.1).
/// </summary>
public sealed record JwtSetKey
{
    /// <summary>The key's one algorithm.</summary>
    public required JwtAlgorithm Algorithm { get; init; }

    /// <summary>The key, a JWK, as a key set writes it.</summary>
    public required JsonElement Jwk { get; init; }

    /// <summary>Its algorithm alone: an HS256 key's secret is written in no string.</summary>
    public override string ToString()
    {
        return $"JwtSetKey {{ Algorithm = {Algorithm} }}";
    }
}

/// <summary>
/// A key set (RFC 7517 §5), the application's to fetch: the issuers it answers for, how it is asked
/// for the keys of one of them, and the most calls that wait for one issuer's keys at once. The
/// side asks it for no other issuer.
/// </summary>
public sealed record JwtKeySet
{
    /// <summary>
    /// The issuers it answers for, one at least, each compared to a token's <c>iss</c> octet for
    /// octet; none, or one that is no string, is an <see cref="ArgumentException"/> as the side is
    /// built. A token of any other issuer is judged at once by the keys there are.
    /// </summary>
    public required IReadOnlyList<string> Issuers { get; init; }

    /// <summary>
    /// Asks it for one of <see cref="Issuers"/>, with a signal cancelled as the ask's deadline is
    /// reached, a minute past the reading at which it went on the side's monotonic reading, should
    /// it still be unsettled then: it answers that issuer's keys, and may wait. One that throws or
    /// faults, answers what is not keys shaped for their algorithms, or is still unsettled as its
    /// deadline is reached fails the calls that wait on it, PROCEDURE_FAILED; what it settles to at
    /// or past its deadline is dropped.
    /// </summary>
    public required Func<string, CancellationToken, ValueTask<IReadOnlyList<JwtSetKey>>> Ask { get; init; }

    /// <summary>
    /// The most calls that wait for one issuer's keys at once, on its ask under way and for its
    /// deadline counted together, each issuer's apart: 64 by default, from 1 to 2³¹ − 1, or an
    /// <see cref="ArgumentOutOfRangeException"/> as the side is built. A call that would wait past
    /// them is refused CAPACITY_EXCEEDED, and not reported: it withdraws nothing (spec 8.2, 13.8).
    /// </summary>
    public int MaximumWaitingCalls { get; init; } = 64;
}

/// <summary>
/// The credential's session an <see cref="CredentialScheme.Elsewhere"/>'s verifier makes of what a
/// request's transport carried (spec 13.10): its identifier's <see cref="Id"/>, its data, which the
/// call carries, and its end.
/// </summary>
public sealed record ElsewhereSession
{
    /// <summary>
    /// What names the session, its identifier being the record of
    /// <see cref="CredentialScheme.Elsewhere"/> and this id, compared octet for octet. None is the
    /// verifier's fault: the call fails, PROCEDURE_FAILED.
    /// </summary>
    public required string Id { get; init; }

    /// <summary>What the session holds, which the call carries: its admission and its resolver read it.</summary>
    public object? Data { get; init; }

    /// <summary>
    /// When the session ends, in milliseconds since the epoch, held rounded up to a whole one; none
    /// for a session no timer ends. One the wall clock has reached as the verifier settles does not
    /// hold: SESSION_REQUIRED. One that is not a number from −(2⁵³ − 1) to 2⁵³ − 1 is the
    /// verifier's fault: the call fails, PROCEDURE_FAILED.
    /// </summary>
    public double? End { get; init; }
}

/// <summary>
/// What a side resolves a request's credential with, by its scheme (spec 9.2, step 5): a
/// <see cref="CredentialScheme.Jwt"/>'s keys, its audience and its key set, and an
/// <see cref="CredentialScheme.Elsewhere"/>'s verifier. The side builds its JWT verifier from them,
/// as data, on the clock it runs on, and takes the schemes they give: <see cref="CredentialScheme.Jwt"/>
/// with keys or a key set, <see cref="CredentialScheme.Elsewhere"/> with a verifier.
/// </summary>
public sealed record Credentials
{
    /// <summary>
    /// The keys a <see cref="CredentialScheme.Jwt"/> is verified with, each with its issuer and its
    /// one algorithm (spec 13.8). A side given one sets its limits' <c>chunkBytes</c> and
    /// <c>maximumEnvelopeBytes</c> to 1,024 bytes at least (spec 12.2).
    /// </summary>
    public IReadOnlyList<JwtKey> Keys { get; init; } = [];

    /// <summary>
    /// The audience a <see cref="CredentialScheme.Jwt"/>'s <c>aud</c> names, the receiver's: given
    /// with keys or a key set, or they are an <see cref="ArgumentException"/> as the side is built,
    /// whatever its relay does; a relay that verifies holds a token it forwards to its destinations'
    /// audiences instead (spec 13.8, 14.3).
    /// </summary>
    public string? Audience { get; init; }

    /// <summary>
    /// The key set, asked for an issuer it names once a minute at most: for a token of that issuer
    /// whose <c>kid</c> names none of that issuer's keys that serve, or that names no <c>kid</c>
    /// while none of that issuer's keys serve — none given, none answered yet, or all past their
    /// ten minutes. What an answer gave is held for its issuer, beside <see cref="Keys"/>, in
    /// place of what the last gave, and serves ten minutes from that answer; an ask that fails
    /// replaces nothing, and fails the calls that wait on it, PROCEDURE_FAILED (spec 13.8). The
    /// application fetches; the side fetches nothing.
    /// </summary>
    public JwtKeySet? KeySet { get; init; }

    /// <summary>
    /// The <see cref="CredentialScheme.Elsewhere"/>'s verifier, asked once per request presenting it
    /// whose transport carried a credential, with what that transport carried, whole, and the
    /// call's signal, cancelled once its call ends while it resolves: it settles with a credential's
    /// session, or with none when the credential does not hold. One that throws or faults fails the
    /// call, PROCEDURE_FAILED, and is reported.
    /// </summary>
    public Func<string, CancellationToken, ValueTask<ElsewhereSession?>>? Verify { get; init; }

    /// <summary>Whether they take a <see cref="CredentialScheme.Jwt"/>: keys, or a key set.</summary>
    internal bool TakesJwt
    {
        get
        {
            return Keys.Count > 0 || KeySet is not null;
        }
    }
}
