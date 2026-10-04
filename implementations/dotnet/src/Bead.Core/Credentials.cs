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
    /// unless its relay verifies, holding its destinations' audiences instead (spec 13.8, 14.3).
    /// </summary>
    public string? Audience { get; init; }

    /// <summary>
    /// The key set, asked for an issuer when a token's <c>kid</c> names none of the keys held, once a
    /// minute at most for that issuer; it answers that issuer's keys, and may wait. What it answered
    /// is held for that issuer, beside <see cref="Keys"/>, until its next answer for it. One that
    /// throws or faults fails the calls that wait on it, and those of that issuer until its minute
    /// passed: PROCEDURE_FAILED. The application fetches; the side fetches nothing.
    /// </summary>
    public Func<string, ValueTask<IReadOnlyList<JwtSetKey>>>? KeySet { get; init; }

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
