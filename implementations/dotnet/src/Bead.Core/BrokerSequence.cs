using System.Globalization;

namespace Bead;

/// <summary>What a parcel taken in one direction is to its sequence (spec 15.19).</summary>
internal enum BrokerTaking
{
    /// <summary>The next one awaited: handed on.</summary>
    Next,

    /// <summary>Below the next one awaited: a copy, dropped in silence.</summary>
    Copy,

    /// <summary>Past the next one awaited: a loss, and the connection with it.</summary>
    Gap,
}

/// <summary>
/// One direction of a connection, as its receiver numbers it (spec 15.19): the next sequence
/// awaited, the one number its duplicate window keeps. A parcel below it is a copy — a broker's
/// redelivery, a test's copy — and one past it a loss, since a broker keeps one publisher's order on
/// one topic (MQTT 5 §4.6) and resends nothing into a link that kept no session.
/// </summary>
internal sealed class BrokerSequence(ulong awaited)
{
    /// <summary>The next sequence awaited.</summary>
    public ulong Awaited { get; private set; } = awaited;

    /// <summary>Takes a parcel of <paramref name="sequence"/>: the next, moving the window by one; a copy; or a gap.</summary>
    public BrokerTaking Take(ulong sequence)
    {
        if (sequence < Awaited)
        {
            return BrokerTaking.Copy;
        }

        if (sequence > Awaited)
        {
            return BrokerTaking.Gap;
        }

        Awaited += 1;

        return BrokerTaking.Next;
    }

    /// <summary>A gap, as its side reports it: the sequence awaited and the one that came (spec 15.19).</summary>
    public string GapOf(ulong came)
    {
        return string.Create(CultureInfo.InvariantCulture, $"a parcel lost: {Awaited} was awaited, and {came} came");
    }
}

/// <summary>
/// What a participant holds in parts across its connections (spec 15.20), bounded by its
/// <c>heldBytesBudget</c>: a part that would pass it loses its own connection.
/// </summary>
internal sealed class BrokerBudget(long budget)
{
    /// <summary>The budget, in bytes.</summary>
    public long Budget { get; } = budget;

    /// <summary>What is held in parts right now.</summary>
    public long Held { get; private set; }

    /// <summary>Charges <paramref name="bytes"/>; false, nothing charged, when they would pass the budget.</summary>
    public bool TryCharge(long bytes)
    {
        if (Held + bytes > Budget)
        {
            return false;
        }

        Held += bytes;

        return true;
    }

    /// <summary>Lets <paramref name="bytes"/> go, held no more.</summary>
    public void Release(long bytes)
    {
        Held -= bytes;
    }
}

/// <summary>What an envelope's parts are held to (spec 15.20, 15.12).</summary>
internal sealed record BrokerPartsBounds
{
    /// <summary>One envelope's parts together: past it, the connection closes with 1009.</summary>
    public required long MaximumEnvelopePartsBytes { get; init; }

    /// <summary>The slowest parts may come once the grace passed since an envelope's first, in bytes a second.</summary>
    public required int MinimumBodyBytesPerSecond { get; init; }

    /// <summary>How long an envelope's parts come before their rate is held.</summary>
    public required TimeSpan BodyGracePeriod { get; init; }

    /// <summary>What the participant holds in parts, across its connections.</summary>
    public required BrokerBudget Budget { get; init; }

    /// <summary>What the rate is held on: the clock the side is given (0011).</summary>
    public required TimeProvider Clock { get; init; }
}

/// <summary>A part taken: the envelope whole once its last part came, or held, or the connection lost, with its code and why.</summary>
internal readonly record struct BrokerPartTaking(byte[]? Envelope, string? Credential, (int Code, string Why)? Lost);

/// <summary>
/// One direction's envelope in parts (spec 15.20): DATA parcels one after the other, <c>MORE</c> on
/// each but the last, a credential on the first alone, handed on once the last came, whole, as a
/// WebSocket's message in fragments is one (RFC 6455 §5.4). Past
/// <c>maximumEnvelopePartsBytes</c> the connection closes with 1009; a part that would pass the
/// participant's <c>heldBytesBudget</c>, or parts that come slower than
/// <c>minimumBodyBytesPerSecond</c> once <c>bodyGracePeriod</c> passed since the first, on the
/// clock given, lose it, a CLOSE of 4000: each naming the bound and its value. The rate is held by
/// one timer, armed at the grace by the first part, and, while the parts are on time, armed again at
/// the deadline the parts so far give: the time their bytes are owed by at the rate.
/// </summary>
internal sealed class BrokerParts(BrokerPartsBounds bounds, Action late)
{
    private readonly List<byte> _held = [];
    private string? _credential;
    private long? _firstAt;
    private ITimer? _timer;

    /// <summary>
    /// An envelope cut in DATA parcels toward a peer, unsequenced yet: whole where it fits
    /// <c>Limit</c>, the largest parcel toward that peer, in parts otherwise, each as large as that
    /// bound lets it but the last, which takes what is left, of one byte at least, <c>MORE</c> on
    /// each but the last, the credential on the first alone (spec 15.20). None where the limit
    /// leaves no byte of the envelope beside the credential.
    /// </summary>
    public static IReadOnlyList<BrokerParcel> Cut(ReadOnlyMemory<byte> envelope, (long Limit, string? Credential) toward)
    {
        var (limit, credential) = toward;
        var credentialBytes = credential is null ? 0 : 2 + credential.Length;
        var room = limit - BrokerParcels.PrefixBytes;
        var parts = new List<BrokerParcel>();

        if (room - credentialBytes < 1)
        {
            return parts;
        }

        for (var at = 0; at < envelope.Length;)
        {
            var isFirst = at == 0;
            var take = (int)Math.Min(envelope.Length - at, room - (isFirst ? credentialBytes : 0));
            var isMore = at + take < envelope.Length;

            parts.Add(new BrokerParcel
            {
                Kind = BrokerParcelKinds.Data,
                Flags = (byte)((isMore ? BrokerParcelFlags.More : 0) | (isFirst && credential is not null ? BrokerParcelFlags.Credential : 0)),
                Credential = isFirst ? credential : null,
                Carried = envelope.Slice(at, take),
            });
            at += take;
        }

        return parts;
    }

    /// <summary>
    /// Whether a parcel of <c>Limit</c> bytes leaves an envelope one byte at least beside
    /// <c>Credential</c>: a send it does not is refused before it goes, its connection kept.
    /// </summary>
    public static bool Fits((long Limit, string? Credential) toward)
    {
        var (limit, credential) = toward;

        return limit - BrokerParcels.PrefixBytes - (credential is null ? 0 : 2 + credential.Length) >= 1;
    }

    /// <summary>What it holds in parts right now.</summary>
    public long HeldBytes
    {
        get
        {
            return _held.Count;
        }
    }

    /// <summary>Why parts that came too slowly lost their connection.</summary>
    public string LateOf()
    {
        return string.Create(CultureInfo.InvariantCulture, $"an envelope's parts came slower than minimumBodyBytesPerSecond, {bounds.MinimumBodyBytesPerSecond} bytes a second, past bodyGracePeriod, {(long)bounds.BodyGracePeriod.TotalMilliseconds} ms");
    }

    /// <summary>
    /// Takes a DATA's envelope or part, <c>IsMore</c> when more come after it: the
    /// envelope whole, with the credential its first part carried; held; or its connection lost.
    /// </summary>
    public BrokerPartTaking Take((ReadOnlyMemory<byte> Carried, bool IsMore, string? Credential) part)
    {
        var (carried, isMore, credential) = part;

        // a DATA that is no part is handed on as it came, held nowhere
        if (_firstAt is null && !isMore)
        {
            return new BrokerPartTaking(carried.ToArray(), credential, null);
        }

        // ! a credential on the first part alone (spec 15.20)
        if (_firstAt is not null && credential is not null)
        {
            Stop();

            return new BrokerPartTaking(null, null, (1002, "a part past the first of an envelope carries a credential"));
        }

        if (_held.Count + carried.Length > bounds.MaximumEnvelopePartsBytes)
        {
            Stop();

            return new BrokerPartTaking(null, null, (1009, string.Create(CultureInfo.InvariantCulture, $"an envelope's parts would pass maximumEnvelopePartsBytes, {bounds.MaximumEnvelopePartsBytes} bytes")));
        }

        // * each part charged, the last among them, until its envelope is whole
        if (!bounds.Budget.TryCharge(carried.Length))
        {
            Stop();

            return new BrokerPartTaking(null, null, (4000, string.Create(CultureInfo.InvariantCulture, $"a part would pass its participant's heldBytesBudget, {bounds.Budget.Budget} bytes")));
        }

        if (_firstAt is null)
        {
            _firstAt = bounds.Clock.GetTimestamp();
            _credential = credential;
        }

        _held.AddRange(carried.Span);

        if (isMore)
        {
            // * armed at the grace by the first part; judged then, and armed again while on time
            if (_timer is null)
            {
                Rearm();
            }

            return new BrokerPartTaking(null, null, null);
        }

        var whole = _held.ToArray();
        var carriedCredential = _credential;

        Stop();

        return new BrokerPartTaking(whole, carriedCredential, null);
    }

    /// <summary>Whether its parts are owed more than came, now: they came too slowly; never where no rate holds.</summary>
    public bool IsLate()
    {
        if (_firstAt is not { } first)
        {
            return false;
        }

        var deadline = DeadlineOf();

        // ! no deadline is the infinite span, which is negative: no elapsed time is held to it
        return deadline != Timeout.InfiniteTimeSpan && bounds.Clock.GetElapsedTime(first) >= deadline;
    }

    /// <summary>Lets go of what it holds, its budget freed and its timer disarmed.</summary>
    public void Stop()
    {
        bounds.Budget.Release(_held.Count);
        _held.Clear();
        _credential = null;
        _firstAt = null;
        _timer?.Dispose();
        _timer = null;
    }

    // when, from the first part, the parts so far are owed by: the grace, or their bytes at the rate
    private TimeSpan DeadlineOf()
    {
        if (bounds.MinimumBodyBytesPerSecond == 0)
        {
            return Timeout.InfiniteTimeSpan;
        }

        var owed = TimeSpan.FromMilliseconds(Math.Round(_held.Count * 1_000d / bounds.MinimumBodyBytesPerSecond, MidpointRounding.AwayFromZero));

        return owed > bounds.BodyGracePeriod ? owed : bounds.BodyGracePeriod;
    }

    /// <summary>The one timer, armed at the grace first, then at the deadline the parts so far give, from now; none where no rate holds.</summary>
    public void Rearm()
    {
        // the first at the grace itself, as a body's rate is held from its grace (spec 15.12)
        var deadline = _timer is null && bounds.MinimumBodyBytesPerSecond > 0 ? bounds.BodyGracePeriod : DeadlineOf();

        if (deadline == Timeout.InfiniteTimeSpan)
        {
            return;
        }

        var due = deadline - bounds.Clock.GetElapsedTime(_firstAt!.Value);

        due = due < TimeSpan.FromMilliseconds(1) ? TimeSpan.FromMilliseconds(1) : due;

        if (_timer is null)
        {
            _timer = bounds.Clock.CreateTimer(
                (_) =>
                {
                    late();
                },
                null,
                due,
                Timeout.InfiniteTimeSpan);
        }
        else
        {
            _timer.Change(due, Timeout.InfiniteTimeSpan);
        }
    }
}
