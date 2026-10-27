using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// An input of <c>spec/durations.json</c>, as this side is given it: a <see cref="TimeSpan"/>, or
/// none where a <see cref="TimeSpan"/> cannot hold it at all; and whether a row of the support
/// matrix excuses this side from it.
/// </summary>
internal sealed record DurationInput(string Name, TimeSpan? Given, bool IsExcused);

/// <summary>A way a place takes its duration: its id, stable in the place, whether its duration cannot be left out, and whether this side lacks it.</summary>
internal sealed record DurationWay(string Id, bool IsRequired, bool IsExcused);

/// <summary>
/// The default a clause states for a place: what it holds, <see cref="Timeout.InfiniteTimeSpan"/>
/// for never, and the ways built with nothing given to read it.
/// </summary>
internal sealed record DurationDefault(TimeSpan Held, IReadOnlyList<string> Ways);

/// <summary>
/// What a place makes of an input: held, at once, never, default, taken or refused; what it
/// holds, where it holds one; and whether this side reaches another, which a row of the support
/// matrix says.
/// </summary>
internal sealed record PlaceOutcome(string Input, string Outcome, TimeSpan? Held, bool IsExcused);

/// <summary>
/// A place that takes a duration an application gives a side: its id, its kind, a delay or a
/// timeout; what it makes of never, taken, refused or its default; its ways, its default, what of
/// it is observed, held or its refusal alone, and its outcome for each input, in the inputs' order.
/// </summary>
internal sealed record DurationPlace(string Id, (string Kind, string Never) Policy, IReadOnlyList<DurationWay> Ways, DurationDefault? Default, string Observed, IReadOnlyList<PlaceOutcome> Outcomes);

/// <summary>
/// Bead's durations, <c>spec/durations.json</c>, read whole (decision 0014): its inputs, each as a
/// <see cref="TimeSpan"/> is given it, and its places, typed; what this side is excused from; and
/// the words of a refusal, this side's own, which the file leaves to each side. The harness and the
/// twins of <see cref="Clocks"/>' assertions read the file through it alone.
/// </summary>
internal static class Durations
{
    // constants

    // the language a differs names to excuse this side
    private const string Language = "C#";

    // the ceilings of a place's own below 1.4's, in milliseconds, which the file's generator holds
    // its outcomes to: MQTT 5's Keep Alive, a Two Byte Integer of seconds (spec 15.30)
    private static readonly Dictionary<string, long> Ceilings = new(StringComparer.Ordinal)
    {
        ["mqttBrokerAdapter.keepAlive"] = 65_535_000,
    };

    private static readonly JsonElement Root = Load();

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "durations.json")));

        return document.RootElement.Clone();
    }

    // whether an entry's differs names this side
    private static bool IsExcused(JsonElement entry)
    {
        return entry.TryGetProperty("differs", out var differs) && differs.EnumerateArray().Any((difference) =>
        {
            return difference.GetProperty("language").GetString() == Language;
        });
    }

    // an input as a TimeSpan is given it: the double overloads, each platform's arithmetic, never as
    // .NET spells it; NaN and a value that is no number, none
    private static TimeSpan? GivenOf(JsonElement input)
    {
        if (input.TryGetProperty("milliseconds", out var milliseconds))
        {
            return TimeSpan.FromMilliseconds(milliseconds.GetDouble());
        }

        if (input.TryGetProperty("seconds", out var seconds))
        {
            return TimeSpan.FromSeconds(seconds.GetDouble());
        }

        if (input.TryGetProperty("never", out _))
        {
            return Timeout.InfiniteTimeSpan;
        }

        return null;
    }

    private static TimeSpan? HeldOf(JsonElement entry)
    {
        if (entry.TryGetProperty("held", out var held))
        {
            return TimeSpan.FromMilliseconds(held.GetInt64());
        }

        return null;
    }

    private static DurationPlace ReadPlace(JsonElement place)
    {
        DurationDefault? byDefault = null;

        if (place.TryGetProperty("default", out var stated))
        {
            byDefault = new DurationDefault(
                stated.TryGetProperty("milliseconds", out var milliseconds) ? TimeSpan.FromMilliseconds(milliseconds.GetInt64()) : Timeout.InfiniteTimeSpan,
                [.. stated.GetProperty("ways").EnumerateArray().Select((way) =>
                {
                    return way.GetString()!;
                })]);
        }

        return new DurationPlace(
            place.GetProperty("id").GetString()!,
            (place.GetProperty("kind").GetString()!, place.GetProperty("never").GetString()!),
            [.. place.GetProperty("ways").EnumerateArray().Select((way) =>
            {
                return new DurationWay(way.GetProperty("id").GetString()!, way.TryGetProperty("required", out _), IsExcused(way));
            })],
            byDefault,
            place.GetProperty("observed").GetString()!,
            [.. place.GetProperty("outcomes").EnumerateArray().Select((outcome) =>
            {
                return new PlaceOutcome(outcome.GetProperty("input").GetString()!, outcome.GetProperty("outcome").GetString()!, HeldOf(outcome), IsExcused(outcome));
            })]);
    }

    // definition

    /// <summary>The file's inputs, in its order.</summary>
    public static IReadOnlyList<DurationInput> Inputs { get; } = [.. Root.GetProperty("inputs").EnumerateArray().Select((input) =>
    {
        return new DurationInput(input.GetProperty("name").GetString()!, GivenOf(input), IsExcused(input));
    })];

    /// <summary>The file's places, in its order.</summary>
    public static IReadOnlyList<DurationPlace> Places { get; } = [.. Root.GetProperty("places").EnumerateArray().Select(ReadPlace)];

    /// <summary>The input of that name.</summary>
    public static DurationInput InputOf(string name)
    {
        return Inputs.Single((input) =>
        {
            return input.Name == name;
        });
    }

    /// <summary>The place of that id.</summary>
    public static DurationPlace PlaceOf(string id)
    {
        return Places.Single((place) =>
        {
            return place.Id == id;
        });
    }

    /// <summary>
    /// What this side plays of a place, by each way it has: each input it is given, with the place's
    /// outcome for it, but those a row of the support matrix excuses it from, on the input or on the
    /// place's outcome for it. A way it lacks says so itself.
    /// </summary>
    public static IReadOnlyList<(DurationInput Input, PlaceOutcome Outcome)> Played(DurationPlace place)
    {
        ArgumentNullException.ThrowIfNull(place);

        return [.. Inputs.Zip(place.Outcomes).Where((played) =>
        {
            return !played.First.IsExcused && !played.Second.IsExcused;
        })];
    }

    /// <summary>
    /// What this side plays of a place by one of its ways, which the place has: none where a row of
    /// the support matrix excuses this side from that way, else what <see cref="Played(DurationPlace)"/>
    /// plays.
    /// </summary>
    public static IReadOnlyList<(DurationInput Input, PlaceOutcome Outcome)> Played(DurationPlace place, string way)
    {
        ArgumentNullException.ThrowIfNull(place);

        var played = place.Ways.Single((each) =>
        {
            return each.Id == way;
        });

        return played.IsExcused ? [] : Played(place);
    }

    /// <summary>
    /// The words of this side's refusal of a duration at a place, the one sentence for every
    /// reason: the place's phrase, then what it takes — 0 for at once at a delay, from 1 to its
    /// ceiling, and infinite for never where never is not refused — then the duration as given, a
    /// fraction written with a dot whatever the culture, never written <c>infinite</c> rather than -1.
    /// </summary>
    public static string RefusalOf((string Phrase, DurationPlace Place) of, TimeSpan given)
    {
        ArgumentNullException.ThrowIfNull(of.Place);

        var zero = of.Place.Policy.Kind == "delay" ? "0 for at once, or " : "";
        var never = of.Place.Policy.Never == "refused" ? "" : ", or infinite for never";
        var written = given == Timeout.InfiniteTimeSpan ? "infinite" : given.TotalMilliseconds.ToString(CultureInfo.InvariantCulture);
        var ceiling = Ceilings.GetValueOrDefault(of.Place.Id, int.MaxValue);

        return string.Create(CultureInfo.InvariantCulture, $"{of.Phrase} is {zero}a number of milliseconds from 1 to {ceiling}{never}, not {written}");
    }
}
