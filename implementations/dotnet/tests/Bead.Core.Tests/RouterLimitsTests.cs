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
    public void Refuse_limits_that_do_not_hold_together_each_rule_by_its_own_failure(string words, RouterLimits limits)
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
    public void Takes_no_transfer_and_sizes_the_chunk_and_the_window_on_the_envelope_the_rest_as_given()
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

    // spec 15.11
    [Fact]
    public async Task Gives_limits_a_router_holds_together_and_refuses_a_transfer_asked_for()
    {
        await using var transport = new MemoryTransportServer();
        using var router = new RouterServer(transport, new RouterServerOptions
        {
            Limits = RouterLimits.WholeEnvelopeOf(RouterLimits.Default with { MaximumEnvelopeBytes = 4_096 }),
        });

        Assert.Equal(0, router.Limits.MaximumTransfers);
        Assert.Throws<ArgumentException>(() =>
        {
            return RouterLimits.WholeEnvelopeOf(RouterLimits.Default with { MaximumTransfers = 4 });
        });
    }
    [Fact]
    public void Holds_the_limits_given_over_the_defaults_frozen_and_refuses_limits_that_do_not_hold_together()
    {
        var given = RouterLimits.Default with { BufferedBytesBudget = 1_024, ChunkBytes = 64, MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024, WindowBytes = 128 };
        var held = given.Validate();

        Assert.Same(RouterLimits.Default, RouterLimits.Default.Validate());
        Assert.Equal(given, held);
        Assert.Equal(RouterLimits.Default with { BufferedBytesBudget = 1_024, ChunkBytes = 64, MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024, WindowBytes = 128 }, held);
        var changed = held with { WindowBytes = 64 };
        Assert.Equal(128, held.WindowBytes);
        Assert.Equal("the router's limits do not hold together: a window holds two chunks at least, so a sender waits for no credit it is owed", Assert.Throws<ArgumentException>(() =>
        {
            return changed.Validate();
        }).Message);
    }

    [Fact]
    public async Task Take_the_defaults_where_they_say_nothing_and_let_the_transfers_and_the_detail_be_none()
    {
        var given = new RouterLimits { MaximumDetailBytes = 0, MaximumTransfers = 0 };
        var held = given.Validate();

        Assert.Equal(LimitDefaults.ChunkBytes, held.ChunkBytes);
        Assert.Equal(0, held.MaximumDetailBytes);
        Assert.Equal(0, held.MaximumTransfers);
        await using var transport = new MemoryTransportServer();
        using var router = new RouterServer(transport, new RouterServerOptions { Limits = given });

        Assert.Equal(LimitDefaults.ChunkBytes, router.Limits.ChunkBytes);
        Assert.Equal(0, router.Limits.MaximumTransfers);
        Assert.Equal(0, router.Limits.MaximumDetailBytes);
    }

    [Fact]
    public void Refuse_a_limit_that_is_not_a_whole_number_or_not_above_0_where_0_means_nothing()
    {
        (RouterLimits Limits, string Name)[] refused =
        [
            (RouterLimits.Default with { WindowBytes = 0 }, "WindowBytes"),
            (RouterLimits.Default with { ChunkBytes = 0 }, "ChunkBytes"),
            (RouterLimits.Default with { MaximumPayloadBytes = 0 }, "MaximumPayloadBytes"),
        ];

        foreach (var (limits, name) in refused)
        {
            Assert.Equal($"{name} is a whole number above 0, not 0", Assert.Throws<ArgumentException>(() =>
            {
                return limits.Validate();
            }).Message);
        }

        var absent = RouterLimits.Default with { MaximumDetailBytes = 0, MaximumTransfers = 0 };
        Assert.Same(absent, absent.Validate());
    }

}
