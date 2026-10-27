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
    /// side for parity. Every duration Bead is given is held as a whole number of milliseconds from 1
    /// to it, a fraction rounded to the nearest; never is <see cref="Timeout.InfiniteTimeSpan"/>,
    /// which arms nothing.
    /// </summary>
    public static readonly TimeSpan LongestTimer = TimeSpan.FromMilliseconds(int.MaxValue);

    // the shortest a timer of Bead's waits
    private static readonly TimeSpan ShortestTimer = TimeSpan.FromMilliseconds(1);

    /// <summary>
    /// <paramref name="duration"/> held as every platform's timers hold it alike: a number of
    /// milliseconds from 1 to <see cref="LongestTimer"/>, rounded to the nearest whole one, a half
    /// away from zero — under a millisecond, Node waits one and .NET none; past the ceiling,
    /// JavaScript's timer fires at once — or <see cref="Timeout.InfiniteTimeSpan"/>, never, which
    /// arms nothing. Any other, zero among them, is an <see cref="ArgumentOutOfRangeException"/>
    /// naming the duration <c>What</c>, its parameter the option <c>Option</c>. A timeout or a bound
    /// where never has no meaning holds to <see cref="AssertHeldFinite"/>; a delay, which takes
    /// zero, to <see cref="AssertHeldDelay"/>.
    /// </summary>
    internal static TimeSpan AssertHeld((string What, string Option) names, TimeSpan duration)
    {
        if (duration == Timeout.InfiniteTimeSpan)
        {
            return duration;
        }

        if (!IsHeld(duration))
        {
            throw new ArgumentOutOfRangeException(names.Option, RefusalOf((names.What, duration), (false, true, LongestTimer)));
        }

        return Rounded(duration);
    }

    /// <summary>
    /// As <see cref="AssertHeld"/>, where never has no meaning: <see cref="Timeout.InfiniteTimeSpan"/>
    /// is refused too.
    /// </summary>
    internal static TimeSpan AssertHeldFinite((string What, string Option) names, TimeSpan duration)
    {
        return AssertHeldWithin(names, (duration, LongestTimer));
    }

    /// <summary>
    /// As <see cref="AssertHeldFinite"/>, under a ceiling of
    /// the place's own below <see cref="LongestTimer"/>, a whole number of milliseconds: what a
    /// protocol's field holds, as MQTT 5's Keep Alive holds 65,535 seconds.
    /// </summary>
    internal static TimeSpan AssertHeldWithin((string What, string Option) names, (TimeSpan Duration, TimeSpan Ceiling) held)
    {
        var (duration, ceiling) = held;

        if (duration < ShortestTimer || duration > ceiling)
        {
            throw new ArgumentOutOfRangeException(names.Option, RefusalOf((names.What, duration), (false, false, ceiling)));
        }

        return Rounded(duration);
    }

    /// <summary>
    /// As <see cref="AssertHeldFinite"/>, for a delay: zero is at once, held as zero, for which no
    /// timer is armed; <see cref="Timeout.InfiniteTimeSpan"/> is refused, since a delay of never
    /// would never end.
    /// </summary>
    internal static TimeSpan AssertHeldDelay((string What, string Option) names, TimeSpan duration)
    {
        if (duration == TimeSpan.Zero)
        {
            return duration;
        }

        if (!IsHeld(duration))
        {
            throw new ArgumentOutOfRangeException(names.Option, RefusalOf((names.What, duration), (true, false, LongestTimer)));
        }

        return Rounded(duration);
    }

    // whether every platform's timers hold `duration` alike once rounded: from 1 to the ceiling,
    // read before rounding, so that neither 0.5 nor the ceiling and a half rounds into it
    private static bool IsHeld(TimeSpan duration)
    {
        return duration >= ShortestTimer && duration <= LongestTimer;
    }

    // a duration held in whole milliseconds, a half away from zero, as JavaScript's Math.round holds
    // a positive one, where .NET's own rounding takes a half to the even
    private static TimeSpan Rounded(TimeSpan duration)
    {
        return TimeSpan.FromMilliseconds((long)Math.Round(duration.TotalMilliseconds, MidpointRounding.AwayFromZero));
    }

    // a refusal, in the same words on every machine and on every side: a fraction written with a dot
    // whatever the culture, never written "infinite" rather than -1, and what the place takes besides
    // offered: zero, a delay's, and never where it is taken; and its ceiling
    private static string RefusalOf((string What, TimeSpan Duration) refused, (bool Zero, bool Never, TimeSpan Ceiling) offered)
    {
        var written = refused.Duration == Timeout.InfiniteTimeSpan
            ? "infinite"
            : refused.Duration.TotalMilliseconds.ToString(CultureInfo.InvariantCulture);
        var zero = offered.Zero ? "0 for at once, or " : "";
        var never = offered.Never ? ", or infinite for never" : "";

        return string.Create(CultureInfo.InvariantCulture, $"{refused.What} is {zero}a number of milliseconds from 1 to {(long)offered.Ceiling.TotalMilliseconds}{never}, not {written}");
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
