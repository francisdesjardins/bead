namespace Bead;

/// <summary>
/// What every clock of Bead's holds to. A stack runs on one clock, a <see cref="TimeProvider"/>,
/// set where it starts — its transport, or a layer built alone — and read upward: a layer built on
/// another runs on that one's clock, and refuses one that differs.
/// </summary>
public static class Clocks
{
    /// <summary>
    /// The longest a timer of Bead's waits: 2³¹ − 1 ms, as JavaScript's timers hold, kept on this
    /// side for parity. A timeout longer than it is refused; never is
    /// <see cref="Timeout.InfiniteTimeSpan"/>, which arms nothing.
    /// </summary>
    public static readonly TimeSpan LongestTimer = TimeSpan.FromMilliseconds(int.MaxValue);

    /// <summary>
    /// The clock of a layer built on another: the one beneath it, unless it was given one; one given
    /// that differs is an <see cref="ArgumentException"/> naming both.
    /// </summary>
    internal static TimeProvider Of((TimeProvider? Given, TimeProvider Beneath) clocks, (string Layer, string Below) names)
    {
        var (given, beneath) = clocks;

        if (given is null || ReferenceEquals(given, beneath))
        {
            return beneath;
        }

        throw new ArgumentException(
            $"{names.Layer} runs on the clock of {names.Below}, {NameOf(beneath)}, and was given another, {NameOf(given)}");
    }

    // a clock as a refusal names it: its type, since a test's clock tells its reading instead
    private static string NameOf(TimeProvider clock)
    {
        return ReferenceEquals(clock, TimeProvider.System) ? "the system's" : $"a {clock.GetType().Name}";
    }
}
