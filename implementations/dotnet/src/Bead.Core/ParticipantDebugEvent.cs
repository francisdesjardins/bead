namespace Bead;

/// <summary>What a participant decides about an incoming message (debugging 13).</summary>
public enum ParcelVerdict
{
    /// <summary>Taken in its order.</summary>
    Taken,

    /// <summary>Below the sequence awaited.</summary>
    Copy,

    /// <summary>Past the sequence awaited.</summary>
    Loss,

    /// <summary>No connection holds its pair.</summary>
    PairNotHeld,

    /// <summary>A retained message, dropped before reading.</summary>
    Retained,

    /// <summary>A topic the participant does not hold.</summary>
    OffTopic,

    /// <summary>No parcel, dropped before reading a prefix.</summary>
    NoParcel,

    /// <summary>A parcel that does not read.</summary>
    DoesNotRead,

    /// <summary>An advisory kind, taken in its order and skipped.</summary>
    Advisory,

}

/// <summary>A participant's trace, without carried bytes, credentials or an acceptor's half (debugging 13).</summary>
public sealed record ParticipantDebugEvent
{
    /// <summary>The event: parcel, link, names or report.</summary>
    public string Event { get; init; } = "";

    /// <summary>A parcel's direction, rx or tx.</summary>
    public string? Direction { get; init; }

    /// <summary>The logical topic tokens.</summary>
    public IReadOnlyList<string>? Topic { get; init; }

    /// <summary>The payload length.</summary>
    public int? Bytes { get; init; }

    /// <summary>The prefix's layout.</summary>
    public byte? Layout { get; init; }

    /// <summary>The kind's name, or advisory and its byte.</summary>
    public string? Kind { get; init; }

    /// <summary>The prefix's flags.</summary>
    public byte? Flags { get; init; }

    /// <summary>The prefix's sequence.</summary>
    public ulong? Sequence { get; init; }

    /// <summary>The opener's half, hexadecimal.</summary>
    public string? Opener { get; init; }

    /// <summary>The participant's ordinal, never reused.</summary>
    public long? Connection { get; init; }

    /// <summary>The server's handle once drawn, or server on a client.</summary>
    public string? ConnectionHandle { get; init; }

    /// <summary>An OPEN, ACCEPT or GONE's id.</summary>
    public string? Id { get; init; }

    /// <summary>The incarnation, hexadecimal.</summary>
    public string? Incarnation { get; init; }

    /// <summary>An OPEN or ACCEPT's receive bound.</summary>
    public long? Bound { get; init; }

    /// <summary>Whether an OPEN or ACCEPT marks its leg secure.</summary>
    public bool? Secure { get; init; }

    /// <summary>A REFUSE's status.</summary>
    public int? Status { get; init; }

    /// <summary>A DATA's carried length, without a copy.</summary>
    public int? CarriedBytes { get; init; }

    /// <summary>Whether another DATA part follows.</summary>
    public bool? More { get; init; }

    /// <summary>Whether the DATA's flag marks a credential.</summary>
    public bool? HasCredential { get; init; }

    /// <summary>A PONG's answered sequence.</summary>
    public ulong? Answers { get; init; }

    /// <summary>A CLOSE's code.</summary>
    public int? Code { get; init; }

    /// <summary>The incoming message's verdict.</summary>
    public ParcelVerdict? Verdict { get; init; }

    /// <summary>The sequence awaited at a loss.</summary>
    public ulong? Awaited { get; init; }

    /// <summary>The sequence that came at a loss.</summary>
    public ulong? Came { get; init; }

    /// <summary>The link transition: up, down, taken-over or stopped.</summary>
    public string? State { get; init; }

    /// <summary>The ordinals a link transition ends.</summary>
    public IReadOnlyList<long>? Ended { get; init; }

    /// <summary>The name held or let go.</summary>
    public string? Name { get; init; }

    /// <summary>Whether the broker holds the name.</summary>
    public bool? IsHeld { get; init; }

    /// <summary>The name's group, when any.</summary>
    public string? Group { get; init; }

    /// <summary>The report's words.</summary>
    public string? Report { get; init; }

}
