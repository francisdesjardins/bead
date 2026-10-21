namespace Bead;

/// <summary>
/// How much a router reads, writes and holds. What a router's options leave out is
/// <see cref="Default"/>'s. They must hold together, or the router is an
/// <see cref="ArgumentException"/>: <see cref="Validate"/> says how.
/// </summary>
public sealed record RouterLimits
{
    // constants

    // what a failure's envelope holds besides its detail: its prefix, the announcement it may carry,
    // and its record
    private const int FailureOverheadBytes = 8 + Credential.AnnouncementBytes + 4;

    /// <summary>The limits a router holds by when its options say nothing.</summary>
    public static RouterLimits Default { get; } = new();

    /// <summary>
    /// A router's limits over a transport that carries each envelope whole and no transfer — HTTP's,
    /// whose body is the envelope: no transfer either way, a payload up to what one envelope holds,
    /// and a window the rules want and nothing reads. Its transfers are none whatever
    /// <paramref name="limits"/> say, where the TypeScript side refuses others given: a record's
    /// default cannot tell given from not.
    /// </summary>
    public static RouterLimits WholeEnvelopeOf(RouterLimits? limits)
    {
        var given = limits ?? Default;

        return given with
        {
            ChunkBytes = given.MaximumEnvelopeBytes,
            MaximumTransfers = 0,
            WindowBytes = 2 * given.MaximumEnvelopeBytes,
        };
    }

    /// <summary>
    /// The bytes every transfer the router receives holds together, reserved as its credit grants
    /// them.
    /// </summary>
    public int BufferedBytesBudget { get; init; } = 268_435_456;

    /// <summary>
    /// A chunk's envelope, its header included, in bytes: a payload whose envelope would be larger
    /// goes as a transfer, in chunks of this size. Both ends are set alike.
    /// </summary>
    public int ChunkBytes { get; init; } = LimitDefaults.ChunkBytes;

    /// <summary>The runs of bytes apart one transfer received may hold before it is whole.</summary>
    public int MaximumChunkRuns { get; init; } = 1_024;

    /// <summary>A failure's detail, in bytes, cut at a character's boundary, written and read.</summary>
    public int MaximumDetailBytes { get; init; } = LimitDefaults.MaximumDetailBytes;

    /// <summary>
    /// The calls a connection's peer has this side answer at once, each from its request until its
    /// answer is wholly sent, its cancel or its connection's close; and the calls this side has wait
    /// on a connection, each failed before it goes past them. Both ends are set alike.
    /// </summary>
    public int MaximumAnsweringCalls { get; init; } = LimitDefaults.MaximumAnsweringCalls;

    /// <summary>A whole envelope, its header included, in bytes, as it comes in and goes out.</summary>
    public int MaximumEnvelopeBytes { get; init; } = LimitDefaults.MaximumEnvelopeBytes;

    /// <summary>A whole payload, in bytes, sent in one envelope or as a transfer.</summary>
    public int MaximumPayloadBytes { get; init; } = LimitDefaults.MaximumPayloadBytes;

    /// <summary>The transfers a connection receives at once; 0 sends and takes none.</summary>
    public int MaximumTransfers { get; init; } = 4;

    /// <summary>
    /// How long a transfer waits for its next chunk or credit before it stalls: from 1 to 2³¹ − 1
    /// milliseconds, rounded to the nearest whole one, never zero nor infinite.
    /// </summary>
    public TimeSpan TransferInactivityTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>How far past the bytes it received, contiguous, a receiver lets its sender send.</summary>
    public int WindowBytes { get; init; } = 4_194_304;

    /// <summary>
    /// The bound of a failure's detail it writes: <see cref="MaximumDetailBytes"/>, within what an
    /// envelope of <see cref="MaximumEnvelopeBytes"/> holds of one besides its header (spec 7.4).
    /// </summary>
    internal int DetailBytes
    {
        get
        {
            return Math.Min(MaximumDetailBytes, MaximumEnvelopeBytes - FailureOverheadBytes);
        }
    }

    /// <summary>
    /// These limits, checked, a transfer's inactivity held: whole numbers, positive but for the
    /// transfers and the detail, a number of calls of 1 at least among them; an envelope of 64 bytes
    /// at least; a chunk from 64 bytes to an envelope; a window of two chunks at least; a payload
    /// within the budget; a transfer's inactivity from 1 to 2³¹ − 1 milliseconds, rounded to the
    /// nearest whole one. Throws an
    /// <see cref="ArgumentException"/> for the first that does not hold, an
    /// <see cref="ArgumentOutOfRangeException"/> for the inactivity.
    /// </summary>
    public RouterLimits Validate()
    {
        (string Rule, bool Holds)[] rules =
        [
            ("every limit is above 0, but for the transfers and the detail",
                BufferedBytesBudget > 0 && ChunkBytes > 0 && MaximumChunkRuns > 0
                && MaximumEnvelopeBytes > 0 && MaximumPayloadBytes > 0 && WindowBytes > 0
                && MaximumAnsweringCalls > 0 && MaximumDetailBytes >= 0 && MaximumTransfers >= 0),
            ("an envelope is 64 bytes at least", MaximumEnvelopeBytes >= 64),
            ("a chunk's envelope is 64 bytes at least, and an envelope at most",
                ChunkBytes >= 64 && ChunkBytes <= MaximumEnvelopeBytes),
            ("a window holds two chunks at least, so a sender waits for no credit it is owed",
                (long)WindowBytes >= 2L * ChunkBytes),
            ("a payload fits in the budget of the transfers received", MaximumPayloadBytes <= BufferedBytesBudget),
        ];

        foreach (var (rule, holds) in rules)
        {
            if (!holds)
            {
                throw new ArgumentException($"the router's limits do not hold together: {rule}");
            }
        }

        // never, refused: a silent transfer stalls in time, and the call id it keeps reserved goes free;
        // held, as its failures' details say it on the wire
        var held = Clocks.AssertHeldFinite(("a transfer's inactivity", nameof(TransferInactivityTimeout)), TransferInactivityTimeout);

        return held == TransferInactivityTimeout ? this : this with { TransferInactivityTimeout = held };
    }
}
