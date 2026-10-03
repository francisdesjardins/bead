namespace Bead.Tests;

/// <summary><see cref="RouterLimits"/>: its defaults, and the rules its limits hold together by.</summary>
public sealed class RouterLimitsTests
{
    // constants

    // limits that break one rule each, by the rule they break
    public static TheoryData<string, RouterLimits> Broken { get; } = new()
    {
        { "a window of 0", RouterLimits.Default with { WindowBytes = 0 } },
        { "transfers below 0", RouterLimits.Default with { MaximumTransfers = -1 } },
        { "a detail below 0", RouterLimits.Default with { MaximumDetailBytes = -1 } },
        { "no inactivity", RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.Zero } },
        { "an envelope of 63 bytes", RouterLimits.Default with { MaximumEnvelopeBytes = 63, ChunkBytes = 63 } },
        { "a chunk of 63 bytes", RouterLimits.Default with { ChunkBytes = 63 } },
        { "a chunk past an envelope", RouterLimits.Default with { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_023 } },
        { "a window of less than two chunks", RouterLimits.Default with { WindowBytes = (2 * LimitDefaults.ChunkBytes) - 1 } },
        { "a payload past the budget", RouterLimits.Default with { BufferedBytesBudget = LimitDefaults.MaximumPayloadBytes - 1 } },
        { "an inactivity under a millisecond", RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(0.5) } },
        { "an inactivity no timer holds", RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(int.MaxValue + 1L) } },
    };

    // definition

    [Fact]
    public void Holds_by_the_defaults_both_ends_set_alike()
    {
        var limits = RouterLimits.Default;

        Assert.Equal(
            (16_778_240, 1_048_576, 4_194_304, 16_777_216, 268_435_456, 4, 1_024, TimeSpan.FromSeconds(30), 1_024),
            (limits.MaximumEnvelopeBytes, limits.ChunkBytes, limits.WindowBytes, limits.MaximumPayloadBytes, limits.BufferedBytesBudget,
                limits.MaximumTransfers, limits.MaximumChunkRuns, limits.TransferInactivityTimeout, limits.MaximumDetailBytes));
        Assert.Same(limits, limits.Validate());

        // room for the longest request header between an envelope and its payload
        Assert.True(limits.MaximumEnvelopeBytes - limits.MaximumPayloadBytes >= 40);
    }

    [Theory]
    [MemberData(nameof(Broken))]
    public void Refuses_limits_that_do_not_hold_together_each_by_its_own_rule(string rule, RouterLimits limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        Assert.Throws<ArgumentException>(() =>
        {
            return limits.Validate();
        });
        Assert.NotEmpty(rule);
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
