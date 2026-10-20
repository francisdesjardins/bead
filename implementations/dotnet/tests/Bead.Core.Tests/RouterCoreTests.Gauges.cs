namespace Bead.Tests;

/// <summary><see cref="RouterCore"/>'s gauges: what its parts hold, together, read on its scheduler.</summary>
public sealed partial class RouterCoreTests
{
    // helpers

    // what the core holds, read on its scheduler as its router reads it
    private static Task<Gauges> GaugesOf(Peer peer)
    {
        return peer.Loop.Run(() =>
        {
            return Task.FromResult(peer.Core.Gauges());
        });
    }

    // definition

    [Fact]
    public async Task Count_what_its_pieces_hold_together_and_nothing_once_its_connections_went()
    {
        var server = new Peer(RouterSide.Server);
        var waiting = server.Core.Request(
            ReadOnlyMemory<byte>.Empty,
            new CoreRequest { ConnectionHandle = "a", Procedure = Echo, Options = new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5) } });

        // a request the resolver has not answered yet
        server.Resolve();
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "b");

        var gauges = await GaugesOf(server);

        Assert.Empty(gauges.Anomalies);
        Assert.Equal(
            new Dictionary<string, long> { ["bufferedBytes"] = RouterLimits.Default.BufferedBytesBudget, ["largestAnsweringCalls"] = 64 },
            gauges.Ceilings);
        Assert.Equal(["a", "b"], gauges.ConnectionHandles.Order());
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["abandonedCalls"] = 0,
                ["announced"] = 0,
                ["answeringCalls"] = 1,
                ["bufferedBytes"] = 0,
                ["largestAnsweringCalls"] = 1,
                ["pendingCalls"] = 1,
                ["receivingTransfers"] = 0,
                ["reservedCallIds"] = 0,
                ["sendingTransfers"] = 0,
            },
            gauges.Counts);
        server.Core.RejectPending("all gone");
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Empty((await GaugesOf(server)).ConnectionHandles);
    }

    [Fact]
    public async Task Counts_the_connections_told_of_a_session_until_each_is_forgotten()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                return token;
            },
        };

        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget("a", RequestOf(1)))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget("b", RequestOf(3)))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(["a", "b"], (await GaugesOf(server)).ConnectionHandles.Order());
        Assert.Equal(2, (await GaugesOf(server)).Counts["announced"]);
        server.Core.RejectPending("gone", "a");
        Assert.Equal(1, (await GaugesOf(server)).Counts["announced"]);
    }
}
