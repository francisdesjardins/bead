namespace Bead.Tests;

/// <summary>
/// A broker's client transport (spec 15.15, 15.18): its connect's ends, refused, timed out or
/// cancelled, and its reconnection, a new connection through the same name.
/// </summary>
public sealed class BrokerTransportClientTests
{
    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    [Fact]
    public async Task Fails_a_connect_refused_or_past_its_time_or_cancelled_and_refuses_what_it_cannot_take()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        var broker = new MemoryBroker(new MemoryBrokerOptions { Clock = clock });
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Clock = clock });
        var silent = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "silent" });
        var opens = 0;
        await using var client = ada.Client();

        silent.Message += (message) =>
        {
            message.Settle();
            Interlocked.Increment(ref opens);
        };

        // nothing serves the name: its broker says so, and the connect fails at once, its refusal
        // the inner exception
        var failed = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new BrokerConnectOptions { Server = "nobody" }, Cancelled);
        });
        var refused = Assert.IsType<BrokerRefusedException>(failed.InnerException);

        Assert.Equal((BrokerRefusal.NoSubscriber, (int?)null), (refused.Refusal.Reason, refused.Refusal.Status));
        Assert.Equal("no participant serves the name: no-subscriber", refused.Message);

        // one that serves it and never answers: past its time, on the clock given
        await silent.Start();
        await silent.Subscribe(["bead", "s", "interop"]);

        var timing = client.Connect(new BrokerConnectOptions { Server = "interop", Timeout = TimeSpan.FromSeconds(1) }, Cancelled);

        Assert.True(SteppingClock.IsEarliest(await clock.UntilEarliest(TimeSpan.FromSeconds(1), BrokerPair.Patience), TimeSpan.FromSeconds(1)));
        await BrokerPair.Until(
            () =>
            {
                return Volatile.Read(ref opens) == 1;
            },
            "its OPEN reaches the name");
        await clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal("timed out after 1000ms", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timing.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
        Assert.Equal(TimeSpan.FromSeconds(10), new BrokerConnectOptions { Server = "interop" }.Timeout);

        // then given up by its token
        using var cancelling = new CancellationTokenSource();
        var cancelled = client.Connect(new BrokerConnectOptions { Server = "interop" }, cancelling.Token);

        await BrokerPair.Until(
            () =>
            {
                return Volatile.Read(ref opens) == 2;
            },
            "its OPEN reaches the name");
        await cancelling.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return cancelled.WaitAsync(BrokerPair.Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, client.ReadyState);

        // what it cannot take, refused before anything moves
        foreach (var server in new[] { "", "a.b", new string('x', 65) })
        {
            await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return client.Connect(new BrokerConnectOptions { Server = server }, Cancelled);
            });
        }

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Send(new TransportMessage((byte[])[1], false));
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.CloseConnection();
        });
        Assert.Equal((true, false), (client.Carries("Bearer token"), client.Carries(" padded")));
        Assert.Equal(2, opens);
    }

    [Fact]
    public async Task Reconnects_through_the_name_it_serves_a_pair_drawn_anew()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();
        var before = Assert.NotNull(client.Pair);
        var reconnecting = 0;

        ((IRouterClientTransport)client).Reconnect += () =>
        {
            Interlocked.Increment(ref reconnecting);
        };

        await client.Reconnect();
        await BrokerPair.Until(
            () =>
            {
                return pair.Opened.Count == 2 && pair.Closed.Count == 1;
            },
            "the server tells the new connection open, and the one it replaced closed");

        var after = Assert.NotNull(client.Pair);

        // * a new connection through the same name, both its halves drawn anew
        Assert.Equal((ReadyState.Open, 1), (client.ReadyState, reconnecting));
        Assert.NotEqual(before.Opener, after.Opener);
        Assert.NotEqual(before.Acceptor, after.Acceptor);
        Assert.Equal(["type=BROKER;participant=client;ordinal=1", "type=BROKER;participant=client;ordinal=2"], pair.Opened);
        Assert.Equal([(false, "type=BROKER;participant=client;ordinal=1")], pair.Closed);
        Assert.Equal(1, pair.Server.Gauges().Counts["connections"]);
    }
}
