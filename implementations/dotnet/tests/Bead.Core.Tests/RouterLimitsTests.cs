namespace Bead.Tests;

/// <summary><see cref="RouterLimits"/>: its defaults, and the rules its limits hold together by.</summary>
public sealed class RouterLimitsTests
{
    // constants

    // limits that break one rule each, by the words that refuse them: a limit out of its range by its
    // name, and limits that do not hold together by the rule they break
    public static TheoryData<string, RouterLimits> Broken { get; } = new()
    {
        { "WindowBytes is a whole number above 0, not 0", RouterLimits.Default with { WindowBytes = 0 } },
        { "MaximumTransfers is a whole number, not -1", RouterLimits.Default with { MaximumTransfers = -1 } },
        { "MaximumDetailBytes is a whole number, not -1", RouterLimits.Default with { MaximumDetailBytes = -1 } },
        { "the router's limits do not hold together: an envelope is 64 bytes at least", RouterLimits.Default with { MaximumEnvelopeBytes = 63, ChunkBytes = 63 } },
        { "the router's limits do not hold together: a chunk's envelope is 64 bytes at least, and an envelope at most", RouterLimits.Default with { ChunkBytes = 63 } },
        { "the router's limits do not hold together: a chunk's envelope is 64 bytes at least, and an envelope at most", RouterLimits.Default with { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_023 } },
        { "the router's limits do not hold together: a chunk's envelope is 64 bytes at least, and an envelope at most", RouterLimits.Default with { ChunkBytes = 2_049, MaximumEnvelopeBytes = 2_048 } },
        { "the router's limits do not hold together: a window holds two chunks at least, so a sender waits for no credit it is owed", RouterLimits.Default with { WindowBytes = (2 * LimitDefaults.ChunkBytes) - 1 } },
        { "the router's limits do not hold together: a payload fits in the budget of the transfers received", RouterLimits.Default with { BufferedBytesBudget = LimitDefaults.MaximumPayloadBytes - 1 } },
        { "the router's limits do not hold together: a payload fits in the budget of the transfers received", RouterLimits.Default with { MaximumPayloadBytes = 268_435_457 } },
    };

    // definition

    // spec 12.2.2, 12.2.3, 12.2.4, 12.2.5, 12.2.7 and 12.2.9
    [Fact]
    public void Holds_by_the_defaults_both_ends_set_alike()
    {
        var limits = RouterLimits.Default;

        Assert.Equal(
            (16_778_240, 1_048_576, 4_194_304, 16_777_216, 268_435_456, 4, 1_024, TimeSpan.FromSeconds(30), 1_024, 64),
            (limits.MaximumEnvelopeBytes, limits.ChunkBytes, limits.WindowBytes, limits.MaximumPayloadBytes, limits.BufferedBytesBudget,
                limits.MaximumTransfers, limits.MaximumChunkRuns, limits.TransferInactivityTimeout, limits.MaximumDetailBytes, limits.MaximumAnsweringCalls));
        Assert.Same(limits, limits.Validate());

        // a peer that splits nothing sends a whole payload in one envelope, the longest header before it
        Assert.True(limits.MaximumEnvelopeBytes - limits.MaximumPayloadBytes >= 1_020);
    }

    [Theory]
    [MemberData(nameof(Broken))]
    public void Refuses_limits_that_do_not_hold_together_each_by_its_own_rule(string words, RouterLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        var failure = Assert.Throws<ArgumentException>(() =>
        {
            return limits.Validate();
        });
        Assert.Equal(words, failure.Message);

        // the edges hold, a transfer's inactivity of a millisecond among them
        var edges = RouterLimits.Default with
        {
            ChunkBytes = 64,
            MaximumEnvelopeBytes = 64,
            MaximumPayloadBytes = 268_435_456,
            TransferInactivityTimeout = TimeSpan.FromMilliseconds(int.MaxValue),
            WindowBytes = 128,
        };
        var withoutTransfers = edges with
        {
            BufferedBytesBudget = LimitDefaults.MaximumPayloadBytes,
            MaximumDetailBytes = 0,
            MaximumPayloadBytes = LimitDefaults.MaximumPayloadBytes,
            MaximumTransfers = 0,
        };
        var shortest = RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(1) };

        Assert.Same(edges, edges.Validate());
        Assert.Same(withoutTransfers, withoutTransfers.Validate());
        Assert.Same(shortest, shortest.Validate());
    }

    [Fact]
    public void Refuses_a_MaximumAnsweringCalls_that_is_not_a_whole_number_above_0()
    {
        foreach (var maximumAnsweringCalls in new[] { 0, -1, int.MinValue })
        {
            Assert.Equal($"MaximumAnsweringCalls is a whole number above 0, not {maximumAnsweringCalls}", Assert.Throws<ArgumentException>(() =>
            {
                return (RouterLimits.Default with { MaximumAnsweringCalls = maximumAnsweringCalls }).Validate();
            }).Message);
        }

        // a call at once holds, and the default is 64
        var one = RouterLimits.Default with { MaximumAnsweringCalls = 1 };

        Assert.Same(one, one.Validate());
        Assert.Equal((64, 64), (RouterLimits.Default.MaximumAnsweringCalls, LimitDefaults.MaximumAnsweringCalls));
    }

    [Fact]
    public void Takes_the_edges_of_each_rule_and_0_where_0_means_none()
    {
        var edges = RouterLimits.Default with
        {
            BufferedBytesBudget = LimitDefaults.MaximumPayloadBytes,
            ChunkBytes = 64,
            MaximumDetailBytes = 0,
            MaximumEnvelopeBytes = 64,
            MaximumTransfers = 0,
            TransferInactivityTimeout = TimeSpan.FromMilliseconds(int.MaxValue),
            WindowBytes = 128,
        };
        var shortest = RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(1) };

        Assert.Same(edges, edges.Validate());
        Assert.Same(shortest, shortest.Validate());
    }

    [Fact]
    public void Whole_envelope_limits_take_no_transfer_and_size_the_chunk_and_the_window_on_the_envelope_the_rest_as_given()
    {
        Assert.Equal(
            RouterLimits.Default with
            {
                ChunkBytes = LimitDefaults.MaximumEnvelopeBytes,
                MaximumTransfers = 0,
                WindowBytes = 2 * LimitDefaults.MaximumEnvelopeBytes,
            },
            RouterLimits.WholeEnvelopeOf(null));
        Assert.Equal(
            RouterLimits.Default with { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, MaximumPayloadBytes = 512, MaximumTransfers = 0, WindowBytes = 2_048 },
            RouterLimits.WholeEnvelopeOf(RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 1_024, MaximumPayloadBytes = 512, MaximumTransfers = 0 }));
    }

    // the TypeScript side refuses a transfer asked for; a record's default cannot tell given from not,
    // so this side takes none whatever is given
    [Fact]
    public void Whole_envelope_limits_hold_together_and_take_no_transfer_whatever_is_given()
    {
        RouterLimits.WholeEnvelopeOf(RouterLimits.Default with { MaximumEnvelopeBytes = 4_096 }).Validate();
        Assert.Equal(0, RouterLimits.WholeEnvelopeOf(RouterLimits.Default with { MaximumTransfers = 4 }).MaximumTransfers);
    }
}
