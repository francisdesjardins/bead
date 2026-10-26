using System.Collections.Concurrent;

namespace Bead.Tests;

/// <summary>
/// A broker's participant (spec 15.16, 15.19, 15.21): its link, its inbox, its incarnation, its
/// halves; its connections closed as its link goes down and its peers reset as it connects anew; a
/// GONE's; its acknowledgements; and the delivery it requires of its adapter.
/// </summary>
public sealed class BrokerParticipantTests
{
    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    [Fact]
    public async Task Subscribes_its_inbox_before_anything_goes_takes_its_id_from_its_adapter_and_draws_its_incarnation_and_each_half_from_a_cryptographic_source_spec_15_24()
    {
        await using var pair = await BrokerPair.Of();
        var recording = new RecordingAdapter(pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        await using var participant = new BrokerParticipant(recording, new BrokerParticipantOptions());
        await using var client = participant.Client();

        await client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        // * its link started, its inbox subscribed, before its first publication
        Assert.Equal(["start", "subscribe bead/i/ada", "publish bead/s/interop"], recording.Calls.Take(3));

        // its id its adapter's, and none that is no token
        Assert.Equal("ada", participant.Id);
        Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "a/b" }));
        });

        // an incarnation and halves of 16 and 8 bytes, never zero, none drawn twice
        var other = new BrokerParticipant(pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" }));

        await other.Start();
        Assert.NotEqual(UInt128.Zero, participant.Incarnation);
        Assert.NotEqual(participant.Incarnation, other.Incarnation);

        var halves = Enumerable.Range(0, 1_000).Select((_) =>
        {
            return participant.DrawHalf();
        }).ToList();

        Assert.DoesNotContain(0UL, halves);
        Assert.Equal(halves.Count, halves.Distinct().Count());
        await other.DisposeAsync();
    }

    [Fact]
    public async Task Closes_each_connection_as_its_link_goes_down_and_connects_anew_as_another_incarnation_resetting_its_peers()
    {
        // ! no will: what closes the server's end is the RESET its participant sends once linked again
        await using var pair = await BrokerPair.Of(new BrokerPairOptions { ClientCapabilities = BrokerCapabilities.Groups | BrokerCapabilities.NoSubscriber });
        await using var first = await pair.Connect();
        await using var second = await pair.Connect();
        var before = pair.ClientParticipant.Incarnation;
        var closes = new ConcurrentQueue<(bool IsClean, bool IsQuick)>();

        first.Close += (isClean, isQuick) =>
        {
            closes.Enqueue((isClean, isQuick));
        };
        second.Close += (isClean, isQuick) =>
        {
            closes.Enqueue((isClean, isQuick));
        };

        // a connect its link goes down under, its OPEN to a name no one answers
        var silent = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "silent" });
        var heard = 0;

        silent.Message += (message) =>
        {
            message.Settle();
            Interlocked.Increment(ref heard);
        };
        await silent.Start();
        await silent.Subscribe(["bead", "s", "quiet"]);

        var pending = pair.ClientParticipant.Client().Connect(new BrokerConnectOptions { Server = "quiet" }, Cancelled);

        await BrokerPair.Until(
            () =>
            {
                return Volatile.Read(ref heard) == 1;
            },
            "the connect's OPEN reaches the name, unanswered");
        pair.ClientAdapter.Lose();

        var failed = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return pending.WaitAsync(BrokerPair.Patience, Cancelled);
        });

        Assert.Equal("the link of client went down as it connected", failed.Message);

        // each told dropped, unclean
        await BrokerPair.Until(
            () =>
            {
                return closes.Count == 2;
            },
            "each connection closes as its link goes down");
        Assert.Equal([(false, true), (false, true)], closes);
        Assert.Equal((ReadyState.Closed, ReadyState.Closed), (first.ReadyState, second.ReadyState));

        // linked again as another incarnation, its peer reset of each connection it held
        await BrokerPair.Until(
            () =>
            {
                return pair.ClientParticipant.IsLinked && pair.Closed.Count == 2;
            },
            "linked again, and the server's ends reset");
        Assert.NotEqual(before, pair.ClientParticipant.Incarnation);
        Assert.Equal([false, false], pair.Closed.Select((close) =>
        {
            return close.IsClean;
        }));
        Assert.Equal(0, pair.Server.Gauges().Counts["connections"]);

        // and it connects through its new incarnation
        await using var third = await pair.Connect();

        Assert.Equal(ReadyState.Open, third.ReadyState);

        // without a reconnection, a link lost stays down, and says so
        var lone = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" });
        await using var alone = new BrokerParticipant(lone, new BrokerParticipantOptions { IsReconnecting = false });
        var reported = new ConcurrentQueue<string>();

        alone.Error += (reason) =>
        {
            reported.Enqueue(reason.Message);
        };
        await alone.Start();
        lone.Lose();
        await BrokerPair.Until(
            () =>
            {
                return !reported.IsEmpty;
            },
            "its link lost, and said so");
        Assert.False(alone.IsLinked);
        Assert.Equal(["the link of bob went down"], reported);
    }

    [Fact]
    public async Task A_parcel_that_would_pass_maximumUnsentBytes_loses_its_connection_with_a_CLOSE_of_4000_whose_sequence_is_the_next_reported_naming_the_bound()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        await using var client = participant.Client(new BrokerTransportClientOptions { MaximumUnsentBytes = 2_048 });
        var reported = new ConcurrentQueue<string>();

        client.Error += (reason) =>
        {
            reported.Enqueue(reason.Message);
        };

        var (_, heard, _) = await AcceptedOf((broker, client), 1_024);

        // * an envelope in three parts of 1,024, 1,024 and 536 bytes, sent at once: each part held
        // to the bound, the third would pass it and goes not, and the CLOSE that loses the
        // connection takes its sequence, the next
        await client.Send(new TransportMessage(new byte[2_500], false));
        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 3 && reported.Count == 1;
            },
            "its two parts and its CLOSE, reported");
        Assert.Equal([(BrokerParcelKinds.Data, 3UL, (int?)null), (BrokerParcelKinds.Data, 4UL, null), (BrokerParcelKinds.Close, 5UL, 4000)], heard.Select((parcel) =>
        {
            return (parcel.Kind, parcel.Sequence, parcel.Code);
        }));
        Assert.Equal(["the connection to acceptor is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 2048 bytes"], reported);
    }

    [Fact]
    public async Task A_parcel_that_does_not_read_closes_its_connection_with_1002_at_once_but_a_kind_to_come_which_is_taken_in_its_order()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        await using var client = participant.Client();
        var reported = new ConcurrentQueue<string>();

        client.Error += (reason) =>
        {
            reported.Enqueue(reason.Message);
        };

        var (acceptor, heard, opener) = await AcceptedOf((broker, client), 65_536);

        // * a kind to come below the next awaited is a copy, dropped in silence
        await acceptor.Publish(new BrokerPublication
        {
            Topic = ["bead", "i", "ada"],
            Payload = BrokerParcels.Encode(new BrokerParcel { Kind = 0x0A, Opener = opener, Acceptor = AcceptorHalf, Sequence = 1 }),
        });

        // any other that does not read closes at once, whatever its sequence, a copy's among them
        var kept = BrokerParcels.Encode(new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = opener, Acceptor = AcceptorHalf, Sequence = 1 });

        kept[3] = 1;
        await acceptor.Publish(new BrokerPublication { Topic = ["bead", "i", "ada"], Payload = kept });
        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 1 && reported.Count == 1;
            },
            "its CLOSE, reported");
        Assert.Equal([(BrokerParcelKinds.Close, 3UL, (int?)1002)], heard.Select((parcel) =>
        {
            return (parcel.Kind, parcel.Sequence, parcel.Code);
        }));
        Assert.Equal(["the connection to acceptor is closed with 1002: a parcel that does not read: a kept byte that is not 0"], reported);
    }

    [Fact]
    public async Task Refuses_a_send_whose_room_fits_no_part_and_keeps_the_connection_on_the_client_and_the_server_alike()
    {
        var broker = new MemoryBroker();

        // adapters whose broker publishes 28 bytes at most to a peer's inbox: a prefix, and no more
        await using var serving = new BrokerParticipant(new RecordingAdapter(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" })) { Room = 28 });
        await using var connecting = new BrokerParticipant(new RecordingAdapter(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" })) { Room = 28 });
        await using var server = serving.Server(new BrokerTransportServerOptions { Names = ["interop"] });
        await using var client = connecting.Client();
        var handles = new ConcurrentQueue<string>();
        const string Refusal = "a parcel of 28 bytes leaves no byte of an envelope beside its credential (Parameter 'message')";

        server.Connection += handles.Enqueue;
        await server.Start();
        await client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        await BrokerPair.Until(
            () =>
            {
                return handles.Count == 1;
            },
            "the server tells the connection open");

        Assert.Equal(Refusal, (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Send(new TransportMessage(new byte[1], false));
        })).Message);
        Assert.Equal(Refusal, (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Send(new TransportMessage(new byte[1], false), handles.Single());
        })).Message);
        Assert.Equal((ReadyState.Open, 1L), (client.ReadyState, server.Gauges().Counts["connections"]));
    }

    [Fact]
    public void Is_refused_as_built_over_an_adapter_whose_inbox_takes_a_parcel_under_1_024_bytes()
    {
        var narrow = new MemoryBroker(new MemoryBrokerOptions { MaximumMessageBytes = 1_023 }).Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });

        Assert.Equal("a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of ada takes 1023 (Parameter 'adapter')", Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(narrow);
        }).Message);
        Assert.Equal("ada", new BrokerParticipant(new MemoryBroker(new MemoryBrokerOptions { MaximumMessageBytes = 1_024 }).Adapter(new MemoryBrokerAdapterOptions { Id = "ada" })).Id);
    }

    [Fact]
    public void Refuses_a_server_transport_a_name_another_of_its_server_transports_serves()
    {
        var participant = new BrokerParticipant(new MemoryBroker().Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));

        _ = participant.Server(new BrokerTransportServerOptions { Names = ["interop", "echo"] });
        Assert.Equal("the name echo is served already by a server transport of this participant (Parameter 'options')", Assert.Throws<ArgumentException>(() =>
        {
            return participant.Server(new BrokerTransportServerOptions { Names = ["other", "echo"] });
        }).Message);

        // the one refused holds none of its names
        Assert.NotNull(participant.Server(new BrokerTransportServerOptions { Names = ["other"] }));
    }

    [Fact]
    public async Task Closes_each_connection_bound_to_the_incarnation_a_GONE_names_and_none_bound_to_another()
    {
        await using var pair = await BrokerPair.Of();
        await using var first = await pair.Connect();
        await using var second = await pair.Connect();
        var bob = new BrokerParticipant(pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" }), new BrokerParticipantOptions { Scheduler = pair.Scheduler });
        await using var third = bob.Client();
        var publisher = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "will" });

        await third.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        await publisher.Start();
        await BrokerPair.Until(
            () =>
            {
                return pair.Server.Gauges().Counts["departures"] == 2;
            },
            "the server subscribes each peer's departure");

        // a GONE of another incarnation of the client's closes none
        IReadOnlyList<string> departure = ["bead", "d", "client"];
        var other = pair.ClientParticipant.Incarnation + 1;

        await publisher.Publish(new BrokerPublication { Topic = departure, Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Gone, Incarnation = other, Id = "client" }) });
        await pair.Scheduler.WhenIdle();
        Assert.Equal(3, pair.Server.Gauges().Counts["connections"]);

        // * one of its incarnation closes each connection bound to it, unclean, and none of bob's
        await publisher.Publish(new BrokerPublication { Topic = departure, Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Gone, Incarnation = pair.ClientParticipant.Incarnation, Id = "client" }) });
        await BrokerPair.Until(
            () =>
            {
                return pair.Closed.Count == 2;
            },
            "the client's two connections close");
        Assert.Equal([(false, "type=BROKER;participant=client;ordinal=1"), (false, "type=BROKER;participant=client;ordinal=2")], pair.Closed.OrderBy((close) =>
        {
            return close.ConnectionHandle;
        }, StringComparer.Ordinal));
        Assert.Equal((1L, 1L), (pair.Server.Gauges().Counts["connections"], pair.Server.Gauges().Counts["departures"]));
        await bob.DisposeAsync();
    }

    [Fact]
    public async Task Acknowledges_a_message_once_taken_or_dropped_as_a_copy_never_after_its_router_is_done_with_it()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();
        var unsettledAsTold = new ConcurrentQueue<int>();
        var routerDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // a router that takes its time: told, and done much later
        pair.Server.Message += (_, _) =>
        {
            unsettledAsTold.Enqueue(pair.ServerAdapter.Unsettled);
            _ = routerDone.Task;
        };
        await pair.Scheduler.WhenIdle();

        await client.Send(new TransportMessage((byte[])[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01], false));
        await BrokerPair.Until(
            () =>
            {
                return unsettledAsTold.Count == 1 && pair.ServerAdapter.Unsettled == 0;
            },
            "the envelope told, and its message acknowledged");

        // * taken before it was acknowledged, and acknowledged with the router not done
        Assert.Equal([1], unsettledAsTold);
        Assert.False(routerDone.Task.IsCompleted);

        // a copy, dropped as one, told nothing and acknowledged all the same
        pair.Broker.Fault(MemoryBrokerFault.Copy, new MemoryBrokerFaultOptions { Topic = ["bead", "i", "server"] });
        await client.Send(new TransportMessage((byte[])[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03], false));
        await BrokerPair.Until(
            () =>
            {
                return unsettledAsTold.Count == 2 && pair.ServerAdapter.Unsettled == 0;
            },
            "the envelope told once, and both its messages acknowledged");
        await pair.Scheduler.WhenIdle();
        Assert.Equal(2, unsettledAsTold.Count);
        Assert.Equal(0, pair.ServerAdapter.Unsettled);
        Assert.False(routerDone.Task.IsCompleted);
        routerDone.SetResult();
    }

    [Fact]
    public void Is_refused_as_built_when_its_application_requires_delivery_at_least_once_of_an_adapter_that_gives_it_at_most_once()
    {
        var broker = new MemoryBroker();
        var atMostOnce = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada", Delivery = BrokerDelivery.AtMostOnce });

        var refused = Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(atMostOnce, new BrokerParticipantOptions { RequireDelivery = BrokerDelivery.AtLeastOnce });
        });

        Assert.Equal("its application requires delivery at least once, and the adapter of ada gives it at most once (Parameter 'options')", refused.Message);

        // what it requires, or less where nothing is required, is taken
        _ = new BrokerParticipant(atMostOnce);
        _ = new BrokerParticipant(atMostOnce, new BrokerParticipantOptions { RequireDelivery = BrokerDelivery.AtMostOnce });
        _ = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" }), new BrokerParticipantOptions { RequireDelivery = BrokerDelivery.AtLeastOnce });
    }

    // the acceptor's half, a test's own peer's
    private const ulong AcceptorHalf = 0xA1_00_00_00_00_00_00_01;

    // a peer of the test's own, serving interop, that accepts the client's connect, its bound given;
    // what it hears from then on, and the client's half
    private static async Task<(MemoryBrokerAdapter Acceptor, ConcurrentQueue<BrokerParcel> Heard, ulong Opener)> AcceptedOf((MemoryBroker Broker, BrokerTransportClient Client) connect, long bound)
    {
        var acceptor = connect.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "acceptor" });
        var heard = new ConcurrentQueue<BrokerParcel>();

        acceptor.Message += (message) =>
        {
            if (BrokerParcels.Read(message.Payload).Parcel is { } parcel)
            {
                heard.Enqueue(parcel);
            }

            message.Settle();
        };
        await acceptor.Start();
        await acceptor.Subscribe(["bead", "i", "acceptor"]);
        await acceptor.Subscribe(["bead", "s", "interop"]);

        var connecting = connect.Client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 1;
            },
            "its OPEN reaches the name");
        Assert.True(heard.TryDequeue(out var open));
        await acceptor.Publish(new BrokerPublication
        {
            Topic = ["bead", "i", "ada"],
            Payload = BrokerParcels.Write(new BrokerParcel
            {
                Kind = BrokerParcelKinds.Accept,
                Flags = BrokerParcelFlags.Secure,
                Opener = open.Opener,
                Acceptor = AcceptorHalf,
                Sequence = 1,
                Id = "acceptor",
                Incarnation = 0xC0,
                Bound = bound,
            }),
        });
        await connecting.WaitAsync(BrokerPair.Patience, Cancelled);
        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 1;
            },
            "its third leg's PING, the second of its sequence");
        Assert.Equal((BrokerParcelKinds.Ping, 2UL), (heard.Single().Kind, heard.Single().Sequence));
        heard.Clear();

        return (acceptor, heard, open.Opener);
    }

    // an adapter that writes down each call its participant makes of it, in order, and passes it on,
    // what it publishes to a topic bounded by Room when given
    private sealed class RecordingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
    {
        public long? Room { get; init; }

        public event Action<BrokerMessage>? Message
        {
            add
            {
                inner.Message += value;
            }

            remove
            {
                inner.Message -= value;
            }
        }

        public event Action? Down
        {
            add
            {
                inner.Down += value;
            }

            remove
            {
                inner.Down -= value;
            }
        }

        public ConcurrentQueue<string> Calls { get; } = new();

        public string Type
        {
            get
            {
                return inner.Type;
            }
        }

        public string Id
        {
            get
            {
                return inner.Id;
            }
        }

        public BrokerCapabilities Capabilities
        {
            get
            {
                return inner.Capabilities;
            }
        }

        public BrokerDelivery Delivery
        {
            get
            {
                return inner.Delivery;
            }
        }

        public bool IsSecure
        {
            get
            {
                return inner.IsSecure;
            }
        }

        public long ReceiveBound
        {
            get
            {
                return inner.ReceiveBound;
            }
        }

        public Task Start(BrokerStart? start = null)
        {
            Calls.Enqueue("start");

            return inner.Start(start);
        }

        public Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
        {
            Calls.Enqueue($"subscribe {string.Join('/', topic)}");

            return inner.Subscribe(topic, subscription);
        }

        public Task Unsubscribe(IReadOnlyList<string> topic)
        {
            Calls.Enqueue($"unsubscribe {string.Join('/', topic)}");

            return inner.Unsubscribe(topic);
        }

        public Task<BrokerPublished> Publish(BrokerPublication publication)
        {
            Calls.Enqueue($"publish {string.Join('/', publication.Topic)}");

            return inner.Publish(publication);
        }

        public long MaximumPayloadBytes(IReadOnlyList<string> topic)
        {
            return Room ?? inner.MaximumPayloadBytes(topic);
        }

        public Task Stop()
        {
            Calls.Enqueue("stop");

            return inner.Stop();
        }
    }
}
