using System.Globalization;

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
    /// side for parity. Every duration Bead is given is a whole number of milliseconds from 1 to it;
    /// never is <see cref="Timeout.InfiniteTimeSpan"/>, which arms nothing.
    /// </summary>
    public static readonly TimeSpan LongestTimer = TimeSpan.FromMilliseconds(int.MaxValue);

    // the shortest a timer of Bead's waits
    private static readonly TimeSpan ShortestTimer = TimeSpan.FromMilliseconds(1);

    /// <summary>
    /// Throws an <see cref="ArgumentOutOfRangeException"/>, naming the duration <c>What</c>, its
    /// parameter the option <c>Option</c>, unless every platform's timers hold it alike: a whole
    /// number of milliseconds from 1 to <see cref="LongestTimer"/> — past it, JavaScript's timer
    /// fires at once; under a millisecond, Node waits one and .NET none — or
    /// <see cref="Timeout.InfiniteTimeSpan"/>, never, which arms nothing. A place where zero has a
    /// meaning of its own takes it before; one where never has none holds to
    /// <see cref="AssertHeldFinite"/>.
    /// </summary>
    internal static void AssertHeld((string What, string Option) names, TimeSpan duration)
    {
        if (duration != Timeout.InfiniteTimeSpan && !IsHeld(duration))
        {
            throw new ArgumentOutOfRangeException(names.Option, RefusalOf(names.What, (duration, ", or infinite for never")));
        }
    }

    /// <summary>
    /// As <see cref="AssertHeld"/>, where never has no meaning: <see cref="Timeout.InfiniteTimeSpan"/>
    /// is refused too.
    /// </summary>
    internal static void AssertHeldFinite((string What, string Option) names, TimeSpan duration)
    {
        if (!IsHeld(duration))
        {
            throw new ArgumentOutOfRangeException(names.Option, RefusalOf(names.What, (duration, "")));
        }
    }

    // whether every platform's timers hold `duration` alike: whole milliseconds, from 1 to the ceiling
    private static bool IsHeld(TimeSpan duration)
    {
        return duration >= ShortestTimer && duration <= LongestTimer && duration.Ticks % TimeSpan.TicksPerMillisecond == 0;
    }

    // a refusal, in the same words on every machine: a fraction written with a dot whatever the
    // culture, and never written "infinite" rather than -1
    private static string RefusalOf(string what, (TimeSpan Duration, string Never) refused)
    {
        var written = refused.Duration == Timeout.InfiniteTimeSpan
            ? "infinite"
            : refused.Duration.TotalMilliseconds.ToString(CultureInfo.InvariantCulture);

        return string.Create(CultureInfo.InvariantCulture, $"{what} is a whole number of milliseconds from 1 to {int.MaxValue}{refused.Never}, not {written}");
    }

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
