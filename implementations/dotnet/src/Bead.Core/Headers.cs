namespace Bead;

/// <summary>
/// The header of any envelope, as flat as its bytes: the call it belongs to, and its kind. One
/// sealed record per kind implements it.
/// </summary>
public interface IEnvelopeHeader
{
    /// <summary>
    /// The call the envelope belongs to, from 1: odd when a client opened it, even when a server
    /// did.
    /// </summary>
    uint CallId { get; }

    /// <summary>What the envelope is.</summary>
    EnvelopeKind Kind { get; }
}

/// <summary>
/// A request's header: its call, the procedure it asks for, and its blocks — where it goes behind
/// the peer, the session it presents, and the total of a payload it opens a transfer for: its own
/// payload is then the transfer's first bytes. <see cref="OpensSubscription"/> says the call
/// subscribes to the procedure's notifications; <see cref="Paced"/> asks for them as the requester
/// credits them, the first credited already.
/// </summary>
public sealed record RequestHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Request;
        }
    }

    /// <summary>The service the procedure is in, from 1.</summary>
    public required ushort ServiceId { get; init; }

    /// <summary>The procedure's own number in its service, from 1.</summary>
    public required ushort ProcedureId { get; init; }

    /// <summary>What the request is for behind the peer that takes it, from 1; none, the peer.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>Whether the call subscribes to the procedure's notifications.</summary>
    public bool OpensSubscription { get; init; }

    /// <summary>Whether the subscription it opens goes at its client's pace.</summary>
    public bool Paced { get; init; }

    /// <summary>The session the request presents, which a router that holds connections ignores.</summary>
    public SessionToken? SessionToken { get; init; }

    /// <summary>The total of the payload it opens a transfer for, from 0 to 2⁵³ − 1.</summary>
    public long? Total { get; init; }
}

/// <summary>
/// A result's header: its call, the session it announces when it changed, and the total of a
/// payload it opens a transfer for.
/// </summary>
public sealed record ResultHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Result;
        }
    }

    /// <summary>The session announced, when it changed: its token, or that it ended.</summary>
    public SessionAnnouncement? Session { get; init; }

    /// <summary>The total of the payload it opens a transfer for, from 0 to 2⁵³ − 1.</summary>
    public long? Total { get; init; }
}

/// <summary>
/// A failure's header: its call, and the session it announces when it changed. An answer names its
/// call alone: never a destination.
/// </summary>
public sealed record FailureHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Failure;
        }
    }

    /// <summary>The session announced, when it changed: its token, or that it ended.</summary>
    public SessionAnnouncement? Session { get; init; }
}

/// <summary>A notification's header: the call id of the subscription it belongs to.</summary>
public sealed record NotificationHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Notification;
        }
    }
}

/// <summary>
/// A chunk's header: its call, where its bytes start in the whole payload, from 0, and whether they
/// are the last — whether they reach the total the transfer's opening declared.
/// </summary>
public sealed record ChunkHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Chunk;
        }
    }

    /// <summary>Where the chunk's bytes start in the whole payload, from 0 to 2⁵³ − 1.</summary>
    public required long Offset { get; init; }

    /// <summary>Whether the chunk is the transfer's last.</summary>
    public required bool IsLast { get; init; }
}

/// <summary>
/// A credit's header: its call, and the end below which the other end may send — the transfer's
/// bytes, by their offset; or, <see cref="Paced"/>, the subscription's notifications, by their
/// count. The highest end received stands.
/// </summary>
public sealed record CreditHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Credit;
        }
    }

    /// <summary>The end below which the other end may send, from 0 to 2⁵³ − 1.</summary>
    public required long CreditEnd { get; init; }

    /// <summary>Whether the credit counts a subscription's notifications, not a transfer's bytes.</summary>
    public bool Paced { get; init; }
}

/// <summary>A cancel's header: the call its requester cancels, and nothing more.</summary>
public sealed record CancelHeader : IEnvelopeHeader
{
    /// <inheritdoc/>
    public required uint CallId { get; init; }

    /// <inheritdoc/>
    public EnvelopeKind Kind
    {
        get
        {
            return EnvelopeKind.Cancel;
        }
    }
}

/// <summary>
/// An envelope's first 8 bytes, which every layout keeps where they are: its layout, its kind, and
/// the call it belongs to. Read even when the rest cannot be, to say whether a refusal is answered.
/// </summary>
/// <param name="CallId">The call id, bytes 4 to 7.</param>
/// <param name="Kind">The kind, as it came: any byte.</param>
/// <param name="Layout">The layout, from 0xA1 to 0xAF.</param>
public readonly record struct EnvelopePrefix(uint CallId, byte Kind, byte Layout);
