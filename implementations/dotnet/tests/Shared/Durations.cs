namespace Bead.Tests;

/// <summary>
/// What a place makes of a duration it is given: takes it, refuses it, or reads it as its own —
/// zero's meaning, or infinite's.
/// </summary>
internal enum DurationOutcome
{
    /// <summary>The place takes it.</summary>
    Taken,

    /// <summary>The place refuses it.</summary>
    Refused,

    /// <summary>The place reads it as a meaning of its own.</summary>
    Own,
}

/// <summary>
/// The durations every place is held to (spec 1.4), the TypeScript side's <c>durationsOf</c> as
/// TimeSpans: NaN aside, which a TimeSpan cannot hold, and -1 ms aside, which is
/// <see cref="Timeout.InfiniteTimeSpan"/> here and a negative there.
/// </summary>
internal static class Durations
{
    // each row's outcome, but zero's and infinite's, which the place says
    private static readonly (TimeSpan Given, DurationOutcome? Outcome, string Written)[] Table =
    [
        (TimeSpan.Zero, null, "0"),
        (TimeSpan.FromMilliseconds(0.5), DurationOutcome.Refused, "0.5"),
        (TimeSpan.FromMilliseconds(1), DurationOutcome.Taken, "1"),
        (TimeSpan.FromMilliseconds(1.5), DurationOutcome.Refused, "1.5"),
        (Clocks.LongestTimer, DurationOutcome.Taken, "2147483647"),
        (Clocks.LongestTimer + TimeSpan.FromMilliseconds(0.5), DurationOutcome.Refused, "2147483647.5"),
        (Clocks.LongestTimer + TimeSpan.FromMilliseconds(1), DurationOutcome.Refused, "2147483648"),
        (Timeout.InfiniteTimeSpan, null, "infinite"),
        (TimeSpan.FromMilliseconds(-2), DurationOutcome.Refused, "-2"),
    ];

    /// <summary>
    /// The durations as the place that names its duration <c>What</c> meets them: 1 ms and the
    /// ceiling taken; a fraction, a negative and past the ceiling refused; zero and infinite as
    /// <c>Zero</c> and <c>Never</c> say. Each refusal is the one message every place words alike,
    /// which offers infinite for never only where never is not refused.
    /// </summary>
    public static IReadOnlyList<(TimeSpan Given, DurationOutcome Outcome, string? Refusal)> Of(string what, (DurationOutcome Zero, DurationOutcome Never) outcomes)
    {
        var offered = outcomes.Never == DurationOutcome.Refused ? "" : ", or infinite for never";

        return Table.Select((row) =>
        {
            var outcome = row.Outcome ?? (row.Given == TimeSpan.Zero ? outcomes.Zero : outcomes.Never);
            var refusal = outcome == DurationOutcome.Refused
                ? $"{what} is a whole number of milliseconds from 1 to 2147483647{offered}, not {row.Written}"
                : null;

            return (row.Given, outcome, refusal);
        }).ToList();
    }
}
