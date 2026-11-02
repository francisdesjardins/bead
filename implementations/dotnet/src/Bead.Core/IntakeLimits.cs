namespace Bead;

/// <summary>
/// What a router holds of each connection that no turn of it took yet, past which it pauses that
/// connection's transport (spec 15.12, decision 0046): a side's own, announced to no one, so no
/// limit of <see cref="RouterLimits"/>, which both ends set alike. Given to a server's router and a
/// client's alike, beside <see cref="PacingLimits"/>.
/// </summary>
public sealed record IntakeLimits
{
    /// <summary>
    /// The limits a router holds by when its options say nothing: 64 envelopes, 1 MiB, fixed, as a
    /// pipe's thresholds are.
    /// </summary>
    public static IntakeLimits Default { get; } = new();

    /// <summary>
    /// The envelopes one connection's transport handed its router that no turn of it took yet, at
    /// most, above 0: the one that reaches it is taken, and what comes after waits.
    /// </summary>
    public int MaximumUntakenEnvelopes { get; init; } = 64;

    /// <summary>Their bytes, at most, above 0.</summary>
    public long MaximumUntakenBytes { get; init; } = 1_048_576;

    /// <summary>These limits, checked: an <see cref="ArgumentException"/> naming the first not above 0.</summary>
    public IntakeLimits Validate()
    {
        (string Name, long Value)[] limits =
        [
            (nameof(MaximumUntakenEnvelopes), MaximumUntakenEnvelopes),
            (nameof(MaximumUntakenBytes), MaximumUntakenBytes),
        ];

        foreach (var (name, value) in limits)
        {
            if (value < 1)
            {
                throw new ArgumentException($"{name} is a whole number above 0, not {value}");
            }
        }

        return this;
    }
}
