using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's clock cases, <c>spec/clocks.json</c>, played on the clock the conformance files'
/// harnesses give the side under test: the timers a case arms, which fire as it advances the clock,
/// each with the reading its callback read, and the clock's readings. The TypeScript side's test
/// clock plays the same file.
/// </summary>
public sealed class ClocksTests
{
    // constants

    private static readonly JsonElement Root = Load();

    // where every case's wall clock starts
    private static readonly DateTimeOffset WallClock = DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "clocks.json")));

        return document.RootElement.Clone();
    }

    private static JsonElement CaseOf(string name)
    {
        foreach (var entry in Root.GetProperty("cases").EnumerateArray())
        {
            if (entry.GetProperty("name").GetString() == name)
            {
                return entry;
            }
        }

        throw new KeyNotFoundException($"no clock case \"{name}\"");
    }

    private static TimeSpan TimeOf(JsonElement milliseconds)
    {
        return TimeSpan.FromMilliseconds(milliseconds.GetInt64());
    }

    // definition

    /// <summary>The names of every clock case.</summary>
    public static TheoryData<string> Names { get; } = new(
        Root.GetProperty("cases").EnumerateArray().Select((entry) =>
        {
            return entry.GetProperty("name").GetString()!;
        }));

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        var clock = new SteppingClock(WallClock);
        var started = clock.GetTimestamp();

        // the timers that fired since the case began or since the last fired, each with the
        // monotonic reading its callback read
        var fired = new List<string>();

        // the monotonic reading, in milliseconds since the case began
        long Monotonic()
        {
            return (long)clock.GetElapsedTime(started).TotalMilliseconds;
        }

        // a timer armed now, whose callback notes its firing, then arms the one it chains, counted
        // from the reading it read
        void Arm(JsonElement arm)
        {
            var timer = arm.GetProperty("timer").GetString();

            clock.CreateTimer(
                (_) =>
                {
                    fired.Add($"{timer} at {Monotonic()}");

                    if (arm.TryGetProperty("then", out var then))
                    {
                        Arm(then);
                    }
                },
                null,
                TimeOf(arm.GetProperty("due")),
                arm.TryGetProperty("period", out var period) ? TimeOf(period) : Timeout.InfiniteTimeSpan);
        }

        foreach (var step in CaseOf(name).GetProperty("steps").EnumerateArray())
        {
            if (step.TryGetProperty("arm", out var arm))
            {
                Arm(arm);
            }

            if (step.TryGetProperty("advance", out var advance))
            {
                await clock.Advance(TimeOf(advance));
            }

            if (step.TryGetProperty("wall", out var wall))
            {
                clock.Wall(TimeOf(wall));
            }

            if (step.TryGetProperty("fired", out var expected))
            {
                Assert.Equal(
                    expected.EnumerateArray().Select((timer) =>
                    {
                        return $"{timer.GetProperty("timer").GetString()} at {timer.GetProperty("at").GetInt64()}";
                    }),
                    fired);
                fired.Clear();
            }

            // the readings the case names, each written alike as expected and as read
            if (step.TryGetProperty("readings", out var readings))
            {
                var wanted = new List<string>();
                var read = new List<string>();

                if (readings.TryGetProperty("monotonic", out var monotonic))
                {
                    wanted.Add($"monotonic {monotonic.GetInt64()}");
                    read.Add($"monotonic {Monotonic()}");
                }

                if (readings.TryGetProperty("wall", out var instant))
                {
                    wanted.Add($"wall {instant.GetString()}");
                    read.Add($"wall {clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)}");
                }

                Assert.Equal(wanted, read);
            }
        }
    }
}
