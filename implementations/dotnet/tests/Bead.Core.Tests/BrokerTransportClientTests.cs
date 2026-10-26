using System.Collections.Concurrent;

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

    [Fact]
    public async Task Hands_on_an_envelope_its_server_sent_as_it_accepted_once_its_connect_opened()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Scheduler = scheduler });
        var (peer, heard) = await PeerOf(broker);
        await using var client = ada.Client();
        var told = new ConcurrentQueue<(ReadyState ReadyState, string Bytes)>();

        client.Message += (message) =>
        {
            told.Enqueue((client.ReadyState, Convert.ToHexString(message.Bytes.Span)));
        };

        var connecting = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        var opener = await OpenerOf(heard);

        // * its ACCEPT and an envelope after it, published in one turn: the envelope comes before its
        // connect returned, and is told once it opened
        await broker.Turn(() =>
        {
            _ = peer.Publish(new BrokerPublication { Topic = Inbox, Payload = AcceptOf(opener) });
            _ = peer.Publish(new BrokerPublication
            {
                Topic = Inbox,
                Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Data, Opener = opener, Acceptor = Half, Sequence = 2, Carried = (byte[])[0xA1, 0x16] }),
            });
        });
        await connecting.WaitAsync(BrokerPair.Patience, Cancelled);
        await BrokerPair.Until(
            () =>
            {
                return !told.IsEmpty;
            },
            "the envelope told");
        await scheduler.WhenIdle();
        Assert.Equal([(ReadyState.Open, "A116")], told);
    }

    [Fact]
    public async Task Fails_a_connect_its_server_refused_as_malformed_or_closed_as_it_opened_telling_no_close_and_tells_one_once_it_opened()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Scheduler = scheduler });
        var (peer, heard) = await PeerOf(broker);
        await using var client = ada.Client();
        var closes = new ConcurrentQueue<(bool IsClean, bool IsQuick)>();

        client.Close += (isClean, isQuick) =>
        {
            closes.Enqueue((isClean, isQuick));
        };

        // refused 400: its refusal the inner exception, named as section 15.6 names it
        var refusing = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        await peer.Publish(new BrokerPublication
        {
            Topic = Inbox,
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Refuse, Opener = await OpenerOf(heard), Sequence = 1, Status = 400 }),
        });

        var refused = Assert.IsType<BrokerRefusedException>((await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return refusing.WaitAsync(BrokerPair.Patience, Cancelled);
        })).InnerException);

        Assert.Equal(("the server refused the connection: 400 malformed", "malformed", (int?)400), (refused.Message, refused.Refusal.Reason, refused.Refusal.Status));

        // * accepted, then closed in the same turn, before its connect returned: the connect fails,
        // and no close is told
        heard.Clear();

        var closing = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        var opener = await OpenerOf(heard);

        await broker.Turn(() =>
        {
            _ = peer.Publish(new BrokerPublication { Topic = Inbox, Payload = AcceptOf(opener) });
            _ = peer.Publish(new BrokerPublication
            {
                Topic = Inbox,
                Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Close, Opener = opener, Acceptor = Half, Sequence = 2, Code = 1000 }),
            });
        });
        Assert.Equal("the server closed the connection as it opened", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return closing.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
        await scheduler.WhenIdle();
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(closes);

        // once it opened, its server's close is told, unclean but for 1000
        heard.Clear();

        var opening = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        var opened = await OpenerOf(heard);

        await peer.Publish(new BrokerPublication { Topic = Inbox, Payload = AcceptOf(opened) });
        await opening.WaitAsync(BrokerPair.Patience, Cancelled);
        await peer.Publish(new BrokerPublication
        {
            Topic = Inbox,
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Close, Opener = opened, Acceptor = Half, Sequence = 2, Code = 1001 }),
        });
        await BrokerPair.Until(
            () =>
            {
                return !closes.IsEmpty;
            },
            "its close told");
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Equal([(false, false)], closes);
    }

    [Fact]
    public async Task Refuses_to_send_a_credential_no_field_carries_or_what_is_no_envelope_keeping_its_connection_and_closes_it_by_a_RESET_where_its_disconnect_is_not_clean()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();

        Assert.Equal("a credential holds visible ASCII, spaces and tabs alone, none first or last (Parameter 'message')", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Send(new TransportMessage((byte[])[0xA1], false) { Credential = " padded" });
        })).Message);
        Assert.Equal("a broker connection carries envelopes, as bytes (Parameter 'message')", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Send(new TransportMessage("text"u8.ToArray(), true));
        })).Message);
        Assert.Equal(ReadyState.Open, client.ReadyState);

        // * not clean: a RESET, its server told unclean
        await client.CloseConnection(new TransportDisconnectOptions { IsClean = false });
        await BrokerPair.Until(
            () =>
            {
                return pair.Closed.Count == 1;
            },
            "the server tells the connection closed");
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Equal([(false, "type=BROKER;participant=client;ordinal=1")], pair.Closed);
    }

    [Fact]
    public async Task Fails_a_connect_under_way_once_disposed_its_link_up_or_not_yet()
    {
        var broker = new MemoryBroker();
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        var (_, heard) = await PeerOf(broker);
        const string Disposed = "the transport client was disposed as it connected";

        // * disposed before its link is up: no OPEN goes
        var early = ada.Client();
        var linking = early.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        await early.DisposeAsync();
        Assert.Equal(Disposed, (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return linking.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);

        // disposed as its OPEN awaits its answer, the one OPEN that went
        var client = ada.Client();
        var connecting = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        await OpenerOf(heard);
        Assert.Single(heard);
        await client.DisposeAsync();
        Assert.Equal(Disposed, (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return connecting.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
    }

    [Fact]
    public async Task Reports_what_a_listener_of_its_events_threw_and_tells_the_listeners_after_it()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();
        var told = new ConcurrentQueue<int>();
        var reported = new ConcurrentQueue<string>();

        client.Message += (_) =>
        {
            throw new InvalidOperationException("a message listener threw");
        };
        client.Message += (message) =>
        {
            told.Enqueue(message.Bytes.Length);
        };
        client.Error += (reason) =>
        {
            reported.Enqueue(reason.Message);
        };
        await pair.Server.Send(new TransportMessage((byte[])[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01], false), pair.Opened.Single());
        await BrokerPair.Until(
            () =>
            {
                return told.Count == 1 && reported.Count == 1;
            },
            "the envelope told, and the throw reported");
        Assert.Equal(["a message listener threw"], reported);
        Assert.Equal([8], told);
        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Refuses_a_connect_while_one_is_under_way_or_one_given_up_already()
    {
        var broker = new MemoryBroker();
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        var (_, heard) = await PeerOf(broker);
        var client = ada.Client();

        // none held: not secure
        Assert.Equal((false, null), (client.IsSecure, client.Pair));

        // given up already: refused, nothing sent
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Connect(new BrokerConnectOptions { Server = "interop" }, new CancellationToken(true));
        });
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);

        var connecting = client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        // * one under way: a second is refused, and the first goes on
        Assert.Equal("the transport client is already connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        })).Message);
        await OpenerOf(heard);
        await client.DisposeAsync();
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return connecting.WaitAsync(BrokerPair.Patience, Cancelled);
        });
    }

    [Fact]
    public async Task Refuses_a_reconnection_never_connected_under_way_while_it_connects_or_given_up_already_and_ends_closed_once_its_attempts_run_out()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = pair.ClientParticipant.Client();
        var silent = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "silent" });

        silent.Message += (message) =>
        {
            message.Settle();
        };
        await silent.Start();
        await silent.Subscribe(["bead", "s", "quiet"]);
        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);

        // a connect to a name nobody answers, given up once refused its reconnection
        using var giving = new CancellationTokenSource();
        var connecting = client.Connect(new BrokerConnectOptions { Server = "quiet" }, giving.Token);

        Assert.Equal("the transport client cannot reconnect while connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);
        await giving.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return connecting.WaitAsync(BrokerPair.Patience, Cancelled);
        });

        // given up already: the open connection left alone
        await client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportReconnectOptions { CancellationToken = new CancellationToken(true) });
        });
        Assert.Equal(ReadyState.Open, client.ReadyState);

        // * nothing serves the name any more: a reconnection under way refuses another, and ends
        // closed once its attempts run out
        await pair.Server.Stop();
        await BrokerPair.Until(
            () =>
            {
                return client.ReadyState == ReadyState.Closed;
            },
            "its server's stop closes its connection");

        var reconnecting = client.Reconnect(new TransportReconnectOptions { Delay = Briefly, MaximumAttempts = 2 });

        Assert.Equal("the transport client is already reconnecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);
        Assert.Equal("attempt 2 reached", (await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
    }

    private static TimeSpan Briefly(TimeSpan? previousDelay, int attempt)
    {
        return TimeSpan.FromMilliseconds(100);
    }

    private static readonly IReadOnlyList<string> Inbox = ["bead", "i", "ada"];

    // the half of the test's own server
    private const ulong Half = 0xA1_00_00_00_00_00_00_01;

    // a server of the test's own, acceptor, serving interop: what it read, in its order
    private static async Task<(MemoryBrokerAdapter Peer, ConcurrentQueue<BrokerParcel> Heard)> PeerOf(MemoryBroker broker)
    {
        var peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "acceptor" });
        var heard = new ConcurrentQueue<BrokerParcel>();

        peer.Message += (message) =>
        {
            if (BrokerParcels.Read(message.Payload).Parcel is { } parcel)
            {
                heard.Enqueue(parcel);
            }

            message.Settle();
        };
        await peer.Start();
        await peer.Subscribe(["bead", "i", "acceptor"]);
        await peer.Subscribe(["bead", "s", "interop"]);

        return (peer, heard);
    }

    // the half of the connect whose OPEN the test's own server read first
    private static async Task<ulong> OpenerOf(ConcurrentQueue<BrokerParcel> heard)
    {
        await BrokerPair.Until(
            () =>
            {
                return !heard.IsEmpty;
            },
            "its OPEN reaches the name");

        return heard.First().Opener;
    }

    // the ACCEPT its server answers the OPEN of opener with, its own half Half
    private static byte[] AcceptOf(ulong opener)
    {
        return BrokerParcels.Write(new BrokerParcel
        {
            Kind = BrokerParcelKinds.Accept,
            Flags = BrokerParcelFlags.Secure,
            Opener = opener,
            Acceptor = Half,
            Sequence = 1,
            Id = "acceptor",
            Incarnation = 0,
            Bound = 65_536,
        });
    }
}
