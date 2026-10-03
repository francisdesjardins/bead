using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's clock cases, <c>spec/clocks.json</c>, played on the clock the conformance files'
/// harnesses give the side under test: the timers a case arms, which fire as it advances the clock,
/// each with the reading its callback read, and the clock's readings. The TypeScript side's test
/// clock plays the same file. Then what a timer of Bead's holds, from a millisecond to the ceiling,
/// and the test clock's refusals of what Bead never arms.
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

    // the clock

    // -1 ms is .NET's infinite, so -2 ms stands for a negative; a TimeSpan holds no NaN
    [Fact]
    public void Its_ceiling_is_2_31_minus_1_milliseconds_and_its_floor_a_millisecond_beyond_which_a_timeout_is_refused_and_never_is_infinite()
    {
        Assert.Equal(TimeSpan.FromMilliseconds(2_147_483_647), Clocks.LongestTimer);

        foreach (var timeout in new[] { TimeSpan.FromMilliseconds(1), TimeSpan.FromMilliseconds(1.5), Clocks.LongestTimer, Timeout.InfiniteTimeSpan })
        {
            Clocks.AssertHeld("a timeout", timeout);
        }

        Assert.StartsWith("a timeout is 2147483647 milliseconds at most, or infinite for never, not 2147483648", Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            Clocks.AssertHeld("a timeout", Clocks.LongestTimer + TimeSpan.FromMilliseconds(1));
        }).Message, StringComparison.Ordinal);

        foreach (var (timeout, written) in new[] { (TimeSpan.FromMilliseconds(0.5), "0.5"), (TimeSpan.Zero, "0"), (TimeSpan.FromMilliseconds(-2), "-2") })
        {
            Assert.StartsWith($"a timeout is a millisecond at least, not {written}", Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                Clocks.AssertHeld("a timeout", timeout);
            }).Message, StringComparison.Ordinal);
        }
    }

    // the test clock: what Bead never arms fails a test, on the TypeScript side's test clock as on
    // this one

    // -1 ms is a timer disarmed, and a period of 0 one that fires once, as .NET's timers read them;
    // a TimeSpan holds no NaN
    [Fact]
    public void Refuses_a_timer_or_a_period_Bead_never_arms_under_a_millisecond_or_past_the_ceiling_naming_it()
    {
        var clock = new SteppingClock(WallClock);
        var millisecond = TimeSpan.FromMilliseconds(1);

        foreach (var time in new[] { TimeSpan.Zero, TimeSpan.FromMilliseconds(0.5), TimeSpan.FromMilliseconds(-2), Clocks.LongestTimer + millisecond })
        {
            var arms = time == TimeSpan.Zero
                ? new[] { (time, Timeout.InfiniteTimeSpan) }
                : new[] { (time, Timeout.InfiniteTimeSpan), (millisecond, time) };

            foreach (var (due, period) in arms)
            {
                Assert.StartsWith(
                    string.Create(CultureInfo.InvariantCulture, $"a test clock arms a timer for 1 to 2147483647 milliseconds, as Bead does, not {time.TotalMilliseconds}"),
                    Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        return clock.CreateTimer(
                            (_) =>
                            {
                            },
                            null,
                            due,
                            period);
                    }).Message,
                    StringComparison.Ordinal);
            }
        }

        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Counts_a_due_in_whole_milliseconds_a_fraction_dropped_from_1_to_the_ceiling()
    {
        var clock = new SteppingClock(WallClock);
        var started = clock.GetTimestamp();
        var fired = new List<TimeSpan>();

        foreach (var due in new[] { TimeSpan.FromMilliseconds(1.9), Clocks.LongestTimer })
        {
            clock.CreateTimer(
                (_) =>
                {
                    fired.Add(clock.GetElapsedTime(started));
                },
                null,
                due,
                Timeout.InfiniteTimeSpan);
        }

        await clock.Advance(TimeSpan.FromMilliseconds(1));
        await clock.Advance(Clocks.LongestTimer - TimeSpan.FromMilliseconds(1));

        Assert.Equal([TimeSpan.FromMilliseconds(1), Clocks.LongestTimer], fired);
    }

    [Fact]
    public async Task Refuses_an_advance_within_another_and_takes_one_once_it_ends()
    {
        // the first advance stays under way until its side is let settle
        var settling = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var clock = new SteppingClock(WallClock)
        {
            Settle = () =>
            {
                return settling.Task;
            },
        };
        var started = clock.GetTimestamp();
        var advancing = clock.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal("a test clock advances once at a time: an advance within another would move it back", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return clock.Advance(TimeSpan.FromMilliseconds(1));
        })).Message);
        settling.SetResult();
        await advancing;
        await clock.Advance(TimeSpan.FromMilliseconds(1));

        Assert.Equal(TimeSpan.FromMilliseconds(1_001), clock.GetElapsedTime(started));
    }
}
