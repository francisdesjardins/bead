namespace Bead;

/// <summary>
/// An envelope: its header, then its payload — a failure's record, read, for a failure; nothing, for
/// a credit or a cancel. The same type is read and written.
/// </summary>
public sealed class Envelope
{
    /// <summary>The envelope's header, whose kind is the envelope's.</summary>
    public required IEnvelopeHeader Header { get; init; }

    /// <summary>What the envelope is: its header's kind.</summary>
    public EnvelopeKind Kind
    {
        get
        {
            return Header.Kind;
        }
    }

    /// <summary>
    /// What follows the header, for a request, a result, a notification or a chunk; empty
    /// otherwise.
    /// </summary>
    public ReadOnlyMemory<byte> Payload { get; init; }

    /// <summary>The failure a failure envelope carries; none for any other kind.</summary>
    public Failure? Failure { get; init; }
}

/// <summary>
/// What went wrong, as a failure envelope carries it once: the code, whose code it is, why, and the
/// relays it crossed.
/// </summary>
public sealed record Failure
{
    /// <summary>
    /// The code, from 1 to 65535: one of <see cref="ProtocolCode"/>, or the procedure's own.
    /// </summary>
    public required ushort Code { get; init; }

    /// <summary>Why, readable: empty when it says nothing.</summary>
    public string Detail { get; init; } = "";

    /// <summary>
    /// The relays it crossed, 0 when not given: a relay that passes on a failure its target sent
    /// writes one more than it received.
    /// </summary>
    public byte Relays { get; init; }

    /// <summary>Whose code it is.</summary>
    public required FailureScope Scope { get; init; }

    /// <summary>A procedure's own failure: <paramref name="code"/> of its own numbering, and why.</summary>
    public static Failure OfApplication(ushort code, string detail = "")
    {
        return new Failure { Code = code, Detail = detail, Scope = FailureScope.Application };
    }

    /// <summary>One of the protocol's failures, and why.</summary>
    public static Failure OfProtocol(ProtocolCode code, string detail = "")
    {
        return new Failure { Code = (ushort)code, Detail = detail, Scope = FailureScope.Protocol };
    }
}
