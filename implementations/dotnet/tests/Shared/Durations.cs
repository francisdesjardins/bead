using System.Globalization;

namespace Bead.Tests;

/// <summary>
/// What a place makes of a duration it is given: holds it as a number of milliseconds, takes it as
/// at once — a delay's zero — or as never, or refuses it.
/// </summary>
internal enum DurationOutcome
{
    /// <summary>The place holds it, in whole milliseconds.</summary>
    Taken,

    /// <summary>The place takes it as at once, a delay's zero.</summary>
    AtOnce,

    /// <summary>The place takes it as never.</summary>
    Never,

    /// <summary>The place refuses it.</summary>
    Refused,
}

/// <summary>
/// The durations every place is held to (spec 1.4), the TypeScript side's <c>durationsOf</c> as
/// TimeSpans: NaN aside, which a TimeSpan cannot hold, and -1 ms aside, which is
/// <see cref="Timeout.InfiniteTimeSpan"/> here and a negative there; 0.41 s and 2.01 s as a user
/// writes them, the TypeScript side's <c>0.41 * 1000</c> and <c>2.01 * 1000</c> twins.
/// </summary>
internal static class Durations
{
    // each row's outcome and what it holds, but zero's and infinite's outcomes, which the place says
    private static readonly (TimeSpan Given, DurationOutcome? Outcome, TimeSpan? Held)[] Table =
    [
        (TimeSpan.Zero, null, TimeSpan.Zero),
        (TimeSpan.FromMilliseconds(0.5), DurationOutcome.Refused, null),
        (TimeSpan.FromMilliseconds(1), DurationOutcome.Taken, TimeSpan.FromMilliseconds(1)),
        (TimeSpan.FromMilliseconds(1.4), DurationOutcome.Taken, TimeSpan.FromMilliseconds(1)),
        (TimeSpan.FromMilliseconds(1.5), DurationOutcome.Taken, TimeSpan.FromMilliseconds(2)),
        (TimeSpan.FromSeconds(0.41), DurationOutcome.Taken, TimeSpan.FromMilliseconds(410)),
        (TimeSpan.FromSeconds(2.01), DurationOutcome.Taken, TimeSpan.FromMilliseconds(2010)),
        (Clocks.LongestTimer, DurationOutcome.Taken, Clocks.LongestTimer),
        (Clocks.LongestTimer + TimeSpan.FromMilliseconds(0.5), DurationOutcome.Refused, null),
        (Timeout.InfiniteTimeSpan, null, Timeout.InfiniteTimeSpan),
        (TimeSpan.FromMilliseconds(-2), DurationOutcome.Refused, null),
    ];

    /// <summary>
    /// The durations as the place that names its duration <c>What</c> meets them: from 1 ms to the
    /// ceiling held, rounded to the nearest whole millisecond, a half away from zero; under a
    /// millisecond, a negative and past the ceiling refused; zero and infinite as <c>Zero</c> and
    /// <c>Never</c> say. Each refusal is the one message every place words alike, which offers 0
    /// for at once where zero is, and infinite for never where never is.
    /// </summary>
    public static IReadOnlyList<(TimeSpan Given, DurationOutcome Outcome, TimeSpan? Held, string? Refusal)> Of(string what, (DurationOutcome Zero, DurationOutcome Never) outcomes)
    {
        var zero = outcomes.Zero == DurationOutcome.Refused ? "" : "0 for at once, or ";
        var never = outcomes.Never == DurationOutcome.Refused ? "" : ", or infinite for never";

        return Table.Select((row) =>
        {
            var outcome = row.Outcome ?? (row.Given == TimeSpan.Zero ? outcomes.Zero : outcomes.Never);
            var written = row.Given == Timeout.InfiniteTimeSpan ? "infinite" : row.Given.TotalMilliseconds.ToString(CultureInfo.InvariantCulture);
            var refusal = outcome == DurationOutcome.Refused
                ? $"{what} is {zero}a number of milliseconds from 1 to 2147483647{never}, not {written}"
                : null;

            return (row.Given, outcome, outcome == DurationOutcome.Refused ? null : row.Held, refusal);
        }).ToList();
    }
}
