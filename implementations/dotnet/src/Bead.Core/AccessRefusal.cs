using System.Runtime.CompilerServices;

namespace Bead;

/// <summary>Where a server refused the access a call asked for (spec 13.12).</summary>
public enum AccessRefusalStage
{
    /// <summary>As its credential resolved: a scheme it takes none of, or a credential that does not hold (spec 9.2, step 6; 14.3, step 1).</summary>
    Credential,

    /// <summary>As it was admitted: its admission's refusal (spec 9.2, step 6; 14.3, step 1).</summary>
    Admission,
}

/// <summary>
/// An access a server refused, as it answered the refusal (spec 13.12): where, the code answered,
/// why, the credential's scheme, what was called, the connection, and the address and port of the
/// request as its transport handed them. Never the credential, any part of it, a claim of a token,
/// nor an admission's detail, as OWASP's ASVS 5.0 has authentication and authorization failures
/// logged without their secrets (§16.3.1, §16.3.2).
/// </summary>
public sealed record AccessRefusal
{
    /// <summary>Where it was refused: as its credential resolved, or as it was admitted.</summary>
    public required AccessRefusalStage Stage { get; init; }

    /// <summary>
    /// The failure answered: <see cref="ProtocolCode.CredentialUnsupported"/>,
    /// <see cref="ProtocolCode.SessionRequired"/>, or <see cref="ProtocolCode.AccessDenied"/>.
    /// </summary>
    public required ProtocolCode Code { get; init; }

    /// <summary>
    /// Why, in one word, as <c>spec/vectors.json</c> writes it: at the credential's stage, for a
    /// <see cref="CredentialScheme.Jwt"/> the step of section 13.8 that refused it, for an
    /// <see cref="CredentialScheme.Opaque"/> <c>session</c>, for an
    /// <see cref="CredentialScheme.Elsewhere"/> <c>nothing-carried</c>, <c>verifier</c> or
    /// <c>end</c>, and <c>scheme</c> for a scheme the server takes none of; at the admission's, the
    /// admission of Bead's own that refused — <c>requireSession</c>, <c>requireCredential</c>,
    /// <c>shareLegBSession</c>, or <c>no-before-route</c> for a relay with none — and none for the
    /// application's own.
    /// </summary>
    public string? Reason { get; init; }

    /// <summary>The scheme the request's header named, a number to come among them; none when it presented none.</summary>
    public CredentialScheme? CredentialScheme { get; init; }

    /// <summary>The service called.</summary>
    public required ushort ServiceId { get; init; }

    /// <summary>The procedure called.</summary>
    public required ushort ProcedureId { get; init; }

    /// <summary>The destination of a call relayed; none for a procedure's.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>The connection the request came on.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>
    /// The address of what brought the request, as its transport handed it (spec 15.1): over HTTP
    /// its exchange's, read as section 15.12 reads it; over a WebSocket its connection's; none where
    /// its transport names none.
    /// </summary>
    public string? Address { get; init; }

    /// <summary>The port of what brought the request, as <see cref="Address"/>; none where its transport names none.</summary>
    public int? Port { get; init; }
}

/// <summary>
/// What a request's credential resolved to: its session, or none, and then why it does not hold,
/// one word of section 13.12's.
/// </summary>
/// <param name="Session">Its session; none for a request presenting none, or a credential that does not hold.</param>
/// <param name="Reason">Why the credential does not hold; none when it holds.</param>
internal readonly record struct CredentialResolution(CallSession? Session, string? Reason)
{
    /// <summary>Why an OPAQUE does not hold, and any credential its side's own resolution does not hold.</summary>
    public const string SessionReason = "session";
}

/// <summary>
/// The refusals an admission made, each marked as one, with the name of Bead's own admission that
/// made it: what a router tells as an admission's refusal, and none of a route's (spec 13.12). A
/// refusal is a copy of its own, so two admissions that share a failure are told apart.
/// </summary>
internal static class AdmissionRefusals
{
    private static readonly ConditionalWeakTable<Failure, Mark> Marks = [];

    /// <summary>A copy of <paramref name="refusal"/>, marked as an admission's, by <paramref name="name"/> when Bead's own.</summary>
    public static Failure Marked(Failure refusal, string? name)
    {
        var copy = refusal with { };

        Marks.AddOrUpdate(copy, new Mark(name));

        return copy;
    }

    /// <summary>The mark of an admission's refusal; none for any other failure.</summary>
    public static Mark? MarkOf(Failure refusal)
    {
        return Marks.TryGetValue(refusal, out var mark) ? mark : null;
    }

    /// <summary>An admission's refusal: the name of Bead's admission that made it, none for the application's.</summary>
    internal sealed record Mark(string? Name);
}
