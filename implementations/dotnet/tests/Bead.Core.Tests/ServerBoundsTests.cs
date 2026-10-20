using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ServerBounds"/> and <see cref="SendPace"/>: what every server's transport bounds alike
/// (spec 15.12), the counts it holds as it is built, and the pace it holds what waits for a socket
/// to, on a clock the test moves.
/// </summary>
public sealed class ServerBoundsTests
{
    // helpers

    // what hears a pace that should never be late: nothing waited, or no pace was held
    private static void Never()
    {
        throw new InvalidOperationException("nothing waited, or no pace was held");
    }

    // nothing waits
    private static long None()
    {
        return 0;
    }

    // a byte waits
    private static long One()
    {
        return 1;
    }

    // a pace on a clock the test moves, of 1,000 bytes a second past the grace given, its lates heard
    private static (SendPace Pace, FakeTimeProvider Clock) PaceOf((TimeSpan Grace, Action Late, Func<long> Unsent) given)
    {
        var clock = new FakeTimeProvider();

        return (new SendPace((given.Late, given.Unsent), new SendPaceOptions { MinimumSendBytesPerSecond = 1_000, SendGracePeriod = given.Grace, Clock = clock }), clock);
    }

    // definition

    [Fact]
    public void Holds_what_waits_to_its_pace_a_deadline_the_longer_of_its_grace_and_its_bytes_at_its_rate_judged_each_second_late_once_past_it()
    {
        long unsent = 0;
        var lates = new List<long>();

        void Late()
        {
            lates.Add(unsent);
        }

        long Unsent()
        {
            return unsent;
        }

        var (pace, clock) = PaceOf((TimeSpan.FromMilliseconds(1_500), Late, Unsent));

        // 10 bytes take 10 ms at its rate: its grace stands, judged a second on
        unsent = 10;
        pace.Hand(10);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Empty(lates);

        // past its grace at the next second's judgement: late once, and judged no more
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal([10], lates);
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal([10], lates);
    }

    [Fact]
    public void Moves_its_deadline_by_the_time_each_envelope_takes_the_later_of_now_and_the_deadline_before_and_runs_none_while_nothing_waits()
    {
        long unsent = 0;
        var isLate = false;

        void Late()
        {
            isLate = true;
        }

        long Unsent()
        {
            return unsent;
        }

        var (pace, clock) = PaceOf((TimeSpan.FromMilliseconds(200), Late, Unsent));

        // two envelopes of 600 bytes: 600 ms each, the second after the first, 1.2 s in all
        unsent = 1_200;
        pace.Hand(600);
        pace.Hand(600);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.False(isLate);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.True(isLate);

        // nothing waiting, its check stops, and the next envelope starts from now
        var (next, nextClock) = PaceOf((TimeSpan.FromMilliseconds(200), Never, None));

        next.Hand(10);
        nextClock.Advance(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void Holds_none_at_a_rate_of_0_and_its_defaults_are_Kestrel_s_240_bytes_a_second_past_5_s()
    {
        var clock = new FakeTimeProvider();
        var pace = new SendPace((Never, One), new SendPaceOptions { MinimumSendBytesPerSecond = 0, SendGracePeriod = TimeSpan.FromMilliseconds(1), Clock = clock });

        pace.Hand(1_000_000);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(
            (240, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(30), 240, TimeSpan.FromSeconds(5)),
            (ServerBounds.MinimumSendBytesPerSecond, ServerBounds.SendGracePeriod, ServerBounds.HeadersTimeout, ServerBounds.MinimumBodyBytesPerSecond, ServerBounds.BodyGracePeriod));
    }

    [Fact]
    public void Holds_a_whole_number_above_0_or_from_0_where_0_holds_none_and_refuses_any_other_naming_its_option()
    {
        Assert.Equal((1L, 0L), (ServerBounds.AssertCount(("n", 1)), ServerBounds.AssertCountOrNone(("n", 0))));

        foreach (var (value, mayBeNone, refusal) in new (long, bool, string)[]
        {
            (0, false, "n is a whole number above 0, not 0"),
            (long.MinValue, false, $"n is a whole number above 0, not {long.MinValue}"),
            (-1, true, "n is a whole number, not -1"),
        })
        {
            var refused = Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return mayBeNone ? ServerBounds.AssertCountOrNone(("n", value)) : ServerBounds.AssertCount(("n", value));
            });

            Assert.Equal(("n", refusal), (refused.ParamName, refused.Message[..refusal.Length]));
        }
    }

    // spec 15.1, 15.12
    [Fact]
    public void Reports_a_connection_dropped_behind_its_pace_by_its_handle_naming_minimumSendBytesPerSecond_and_sendGracePeriod_with_their_values()
    {
        var dropped = ServerBounds.DroppedOf("type=HTTP;ip=192.0.2.9;ordinal=1", ServerBounds.LateOf((240, TimeSpan.FromSeconds(5))));

        Assert.IsType<IOException>(dropped);
        Assert.Equal(
            "type=HTTP;ip=192.0.2.9;ordinal=1 is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 240 past sendGracePeriod 5000 ms",
            dropped.Message);
    }
}
