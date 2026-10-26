using System.Collections.Concurrent;
using System.Globalization;

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

        // each told dropped, unclean and not quick, as a dropped socket's
        await BrokerPair.Until(
            () =>
            {
                return closes.Count == 2;
            },
            "each connection closes as its link goes down");
        Assert.Equal([(false, false), (false, false)], closes);
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
    public void Is_refused_as_built_with_a_minimumBodyBytesPerSecond_of_0_as_an_HTTP_server_is()
    {
        var adapter = new MemoryBroker().Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });

        Assert.Equal("MinimumBodyBytesPerSecond is a whole number above 0, not 0 (Parameter 'MinimumBodyBytesPerSecond')", Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new BrokerParticipant(adapter, new BrokerParticipantOptions { MinimumBodyBytesPerSecond = 0 });
        }).Message);
        Assert.Equal("ada", new BrokerParticipant(adapter, new BrokerParticipantOptions { MinimumBodyBytesPerSecond = 1 }).Id);
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

    [Fact]
    public async Task Holds_a_connection_secure_only_while_both_its_legs_are()
    {
        foreach (var insecure in new[] { "ada", "server" })
        {
            var broker = new MemoryBroker();

            RecordingAdapter AdapterOf(string id)
            {
                return new RecordingAdapter(broker.Adapter(new MemoryBrokerAdapterOptions { Id = id })) { Secure = id == insecure ? false : null };
            }

            await using var serving = new BrokerParticipant(AdapterOf("server"));
            // its application saying its own leg secure changes nothing of its peer's
            await using var server = serving.Server(new BrokerTransportServerOptions { Names = ["interop"], Secure = insecure == "ada" ? true : null });
            await using var connecting = new BrokerParticipant(AdapterOf("ada"));
            await using var client = connecting.Client();
            var handles = new ConcurrentQueue<string>();

            server.Connection += handles.Enqueue;
            await server.Start();
            await client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
            await BrokerPair.Until(
                () =>
                {
                    return handles.Count == 1;
                },
                "the server tells the connection open");

            // * one leg not secure, as its OPEN or its ACCEPT says: neither end holds it secure
            Assert.Equal((ReadyState.Open, false, false), (client.ReadyState, client.IsSecure, server.IsSecure(handles.Single())));
        }
    }

    [Fact]
    public async Task Starts_anew_once_a_start_failed()
    {
        var broker = new MemoryBroker();
        var adapter = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
        await using var participant = new BrokerParticipant(adapter);

        // its broker holds a link of its id already: its first start is refused
        await adapter.Start();
        Assert.Equal("the link of ada is up already", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return participant.Start();
        })).Message);
        await adapter.Stop();

        // * the next starts another
        await participant.Start();
        Assert.True(participant.IsLinked);
    }

    [Fact]
    public async Task Counts_its_connections_half_open_among_them_what_they_hold_in_parts_and_what_waits_for_its_broker_by_the_same_keys_on_its_own_face_and_its_server_transport_s()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }), new BrokerParticipantOptions
        {
            HeldBytesBudget = 4_096,
            MaximumEnvelopePartsBytes = 2_048,
            Scheduler = scheduler,
        });
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"], MaximumConnections = 8, MaximumUnsentBytes = 65_536 });
        var peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });
        var heard = new ConcurrentQueue<BrokerParcel>();
        IReadOnlyList<string> inbox = ["bead", "i", "server"];

        peer.Message += (message) =>
        {
            heard.Enqueue(BrokerParcels.Read(message.Payload).Parcel!);
            message.Settle();
        };
        await peer.Start();
        await peer.Subscribe(["bead", "i", "peer"]);
        await server.Start();
        await peer.Publish(new BrokerPublication
        {
            Topic = ["bead", "s", "interop"],
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = AcceptorHalf, Sequence = 1, Id = "peer", Incarnation = 0xC0, Bound = 65_536 }),
        });
        await scheduler.WhenIdle();

        var acceptor = heard.Single().Acceptor;
        var none = new Dictionary<string, long>
        {
            ["connections"] = 0,
            ["departures"] = 0,
            ["halfOpen"] = 0,
            ["largestPartsBytes"] = 0,
            ["largestUnsentBytes"] = 0,
            ["partsBytes"] = 0,
            ["unsentBytes"] = 0,
        };

        // half-open, its third leg awaited
        Assert.Equal(new Dictionary<string, long>(none) { ["halfOpen"] = 1 }, participant.Gauges().Counts);

        // * open, and 100 bytes of an envelope held in parts
        await peer.Publish(new BrokerPublication { Topic = inbox, Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = AcceptorHalf, Acceptor = acceptor, Sequence = 2 }) });
        await peer.Publish(new BrokerPublication
        {
            Topic = inbox,
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Data, Flags = BrokerParcelFlags.More, Opener = AcceptorHalf, Acceptor = acceptor, Sequence = 3, Carried = new byte[100] }),
        });
        await scheduler.WhenIdle();

        var held = new Dictionary<string, long>(none)
        {
            ["connections"] = 1,
            ["departures"] = 1,
            ["largestPartsBytes"] = 100,
            ["partsBytes"] = 100,
        };

        Assert.Equal(held, participant.Gauges().Counts);
        Assert.Equal(new Dictionary<string, long>(held) { ["names"] = 1 }, server.Gauges().Counts);
        Assert.Equal(new Dictionary<string, long> { ["largestPartsBytes"] = 2_048, ["partsBytes"] = 4_096 }, participant.Gauges().Ceilings);
        Assert.Equal(new Dictionary<string, long> { ["connections"] = 8, ["halfOpen"] = 8, ["largestPartsBytes"] = 2_048, ["largestUnsentBytes"] = 65_536, ["partsBytes"] = 4_096 }, server.Gauges().Ceilings);
    }

    [Fact]
    public async Task Is_refused_as_built_with_a_root_that_is_no_token_and_names_each_topic_by_the_root_it_is_given()
    {
        var broker = new MemoryBroker();

        Assert.Equal("a participant's root is a token of base64url's alphabet, 1 to 64 characters, not \"a.b\" (Parameter 'options')", Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Root = "a.b" });
        }).Message);

        var recording = new RecordingAdapter(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" }));
        await using var participant = new BrokerParticipant(recording, new BrokerParticipantOptions { Root = "deploy" });

        await participant.Start();
        Assert.Equal("deploy", participant.Root);
        Assert.Equal(["start", "subscribe deploy/i/bob"], recording.Calls);
    }

    [Fact]
    public async Task Lets_a_listener_go_fails_a_connect_awaiting_its_answer_as_it_stops_refuses_a_start_once_stopped_and_stops_once()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Scheduler = scheduler });
        var silent = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "silent" });
        var heard = new ConcurrentQueue<byte>();
        var reported = new ConcurrentQueue<string>();
        IReadOnlyList<string> inbox = ["bead", "i", "ada"];

        void Listener(Exception reason)
        {
            reported.Enqueue(reason.Message);
        }

        silent.Message += (message) =>
        {
            heard.Enqueue(BrokerParcels.Read(message.Payload).Parcel!.Kind);
            message.Settle();
        };
        await silent.Start();
        await silent.Subscribe(["bead", "s", "interop"]);
        participant.Error += Listener;

        // a connect whose OPEN reached a name nobody answers
        var pending = participant.Client().Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);

        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 1;
            },
            "its OPEN reaches the name");

        // a listener let go of hears no more
        await silent.Publish(new BrokerPublication { Topic = inbox, Payload = (byte[])[0xB1] });
        await scheduler.WhenIdle();
        participant.Error -= Listener;
        await silent.Publish(new BrokerPublication { Topic = inbox, Payload = (byte[])[0xB1] });
        await scheduler.WhenIdle();
        Assert.Equal([BrokerParcelKinds.Open], heard);
        Assert.Equal((0L, 0L), (participant.Gauges().Counts["connections"], participant.Gauges().Counts["departures"]));

        await participant.Stop();

        // * the connect fails as its participant stops; a start since is refused, a second stop does nothing
        Assert.Equal("the participant ada stopped as it connected", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return pending.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
        Assert.Equal("the participant ada is stopped", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return participant.Start();
        })).Message);
        Assert.Equal("the participant ada is stopped", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return participant.Client().Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        })).Message);
        await participant.DisposeAsync();
        Assert.False(participant.IsLinked);
        Assert.Equal(["a message to the inbox of ada is no parcel: 1 bytes, under a parcel's 28"], reported);
    }

    [Fact]
    public async Task Closes_a_connection_with_1002_for_a_parcel_of_a_layout_to_come_an_ACCEPT_on_it_open_or_another_kind_between_an_envelope_s_parts_and_with_4000_at_a_gap_a_kind_to_come_leaves()
    {
        var part = new BrokerParcel { Kind = BrokerParcelKinds.Data, Flags = BrokerParcelFlags.More, Acceptor = AcceptorHalf, Sequence = 2, Carried = (byte[])[0xA1] };
        var cases = new (int Code, Func<ulong, byte[][]> Parcels, string Why)[]
        {
            (1002, (opener) =>
            {
                return [BrokerParcels.Encode(new BrokerParcel { Layout = 0xB2, Kind = BrokerParcelKinds.Ping, Opener = opener, Acceptor = AcceptorHalf, Sequence = 2 })];
            }, "a parcel of a layout to come, 0xB2"),
            (1002, (opener) =>
            {
                return [BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Accept, Opener = opener, Acceptor = AcceptorHalf, Sequence = 2, Id = "acceptor", Incarnation = 0xC0, Bound = 65_536 })];
            }, "an ACCEPT on a connection open"),
            (1002, (opener) =>
            {
                return [BrokerParcels.Write(part with { Opener = opener }), BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Pong, Opener = opener, Acceptor = AcceptorHalf, Sequence = 3, Answers = 2 })];
            }, "a PONG between an envelope's parts"),
            (1002, (opener) =>
            {
                return [BrokerParcels.Write(part with { Opener = opener }), BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Close, Opener = opener, Acceptor = AcceptorHalf, Sequence = 3, Code = 1000 })];
            }, "a CLOSE between an envelope's parts"),
            (4000, (opener) =>
            {
                return [BrokerParcels.Encode(new BrokerParcel { Kind = 0x0A, Opener = opener, Acceptor = AcceptorHalf, Sequence = 5 })];
            }, "a parcel lost: 2 was awaited, and 5 came"),
        };

        foreach (var (code, parcels, why) in cases)
        {
            var broker = new MemoryBroker();
            await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
            await using var client = participant.Client();
            var reported = new ConcurrentQueue<string>();
            var closes = new ConcurrentQueue<bool>();

            client.Error += (reason) =>
            {
                reported.Enqueue(reason.Message);
            };
            client.Close += (isClean, _) =>
            {
                closes.Enqueue(isClean);
            };

            var (acceptor, heard, opener) = await AcceptedOf((broker, client), 65_536);

            foreach (var payload in parcels(opener))
            {
                await acceptor.Publish(new BrokerPublication { Topic = ["bead", "i", "ada"], Payload = payload });
            }

            // * its CLOSE the next of its sequence, after its OPEN and its third leg; reported, unclean
            await BrokerPair.Until(
                () =>
                {
                    return heard.Count == 1 && reported.Count == 1 && closes.Count == 1;
                },
                $"its CLOSE, reported: {why}");
            Assert.Equal([(BrokerParcelKinds.Close, 3UL, (int?)code)], heard.Select((parcel) =>
            {
                return (parcel.Kind, parcel.Sequence, parcel.Code);
            }));
            Assert.Equal([string.Create(CultureInfo.InvariantCulture, $"the connection to acceptor is closed with {code}: {why}")], reported);
            Assert.Equal([false], closes);
        }
    }

    [Fact]
    public async Task Ends_a_connection_unclean_reporting_nothing_once_its_broker_refuses_a_parcel_to_its_peer_s_inbox_or_says_no_subscriber_takes_it()
    {
        foreach (var isRefused in new[] { false, true })
        {
            var broker = new MemoryBroker();
            var adapter = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
            await using var participant = new BrokerParticipant(adapter);
            await using var client = participant.Client();
            var reported = new ConcurrentQueue<string>();
            var closes = new ConcurrentQueue<bool>();

            client.Error += (reason) =>
            {
                reported.Enqueue(reason.Message);
            };
            client.Close += (isClean, _) =>
            {
                closes.Enqueue(isClean);
            };

            var (acceptor, _, _) = await AcceptedOf((broker, client), 65_536);

            // * its own link refused by its broker under it, or its peer's inbox gone, as a dropped
            // socket's peer
            await (isRefused ? adapter.Stop() : acceptor.Stop());
            await client.Send(new TransportMessage((byte[])[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01], false));
            // ! its close is told once its state is Closed: awaited by the close, never the state
            await BrokerPair.Until(
                () =>
                {
                    return !closes.IsEmpty;
                },
                $"its connection ends: {isRefused}");
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Equal([false], closes);
            Assert.Empty(reported);
        }
    }

    [Fact]
    public async Task Keeps_a_connection_whose_parts_come_at_their_rate_past_the_grace_and_hands_their_envelope_on_whole()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        var broker = new MemoryBroker(new MemoryBrokerOptions { Clock = clock });
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }), new BrokerParticipantOptions { Clock = clock });
        await using var client = participant.Client();
        var told = new ConcurrentQueue<int>();
        var closes = new ConcurrentQueue<bool>();

        client.Message += (message) =>
        {
            told.Enqueue(message.Bytes.Length);
        };
        client.Close += (isClean, _) =>
        {
            closes.Enqueue(isClean);
        };

        var (acceptor, _, opener) = await AcceptedOf((broker, client), 65_536);

        Task<BrokerPublished> PartOf((ulong Sequence, int Length, bool IsLast) part)
        {
            return acceptor.Publish(new BrokerPublication
            {
                Topic = ["bead", "i", "ada"],
                Payload = BrokerParcels.Write(new BrokerParcel
                {
                    Kind = BrokerParcelKinds.Data,
                    Flags = part.IsLast ? (byte)0 : BrokerParcelFlags.More,
                    Opener = opener,
                    Acceptor = AcceptorHalf,
                    Sequence = part.Sequence,
                    Carried = new byte[part.Length],
                }),
            });
        }

        // * 2,600 bytes by the grace's end, owed by 10,833 ms at 240 bytes a second: not late, held on
        await PartOf((2, 1_300, false));
        await clock.UntilArmed(TimeSpan.FromSeconds(5), BrokerPair.Patience);
        await clock.Advance(TimeSpan.FromSeconds(4));
        await PartOf((3, 1_300, false));
        await BrokerPair.Until(
            () =>
            {
                return participant.Gauges().Counts["partsBytes"] == 2_600;
            },
            "its second part held");
        await clock.Advance(TimeSpan.FromSeconds(1));
        await clock.UntilArmed(TimeSpan.FromMilliseconds(5_833), BrokerPair.Patience);
        await PartOf((4, 1, true));
        await BrokerPair.Until(
            () =>
            {
                return !told.IsEmpty;
            },
            "its envelope told");
        Assert.Equal([2_601], told);
        Assert.Empty(closes);
        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Reports_its_link_given_up_on_once_its_reconnection_s_attempts_run_out()
    {
        var broker = new MemoryBroker();
        var adapter = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
        await using var participant = new BrokerParticipant(adapter, new BrokerParticipantOptions
        {
            Reconnect = new TransportReconnectOptions { Delay = Immediately, MaximumAttempts = 2 },
        });
        var reported = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);

        participant.Error += (reason) =>
        {
            reported.TrySetResult(reason);
        };
        await participant.Start();
        adapter.Lose();

        // * its broker holds its id's link of another start already: each attempt is refused
        await adapter.Start();
        Assert.Equal("the link of ada went down, and 2 attempts did not bring it back", (await reported.Task.WaitAsync(BrokerPair.Patience, Cancelled)).Message);
        Assert.False(participant.IsLinked);
    }

    [Fact]
    public async Task Reports_its_reconnection_ended_once_its_signal_is_aborted()
    {
        var broker = new MemoryBroker();
        var adapter = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
        using var cancelling = new CancellationTokenSource();
        await using var participant = new BrokerParticipant(adapter, new BrokerParticipantOptions
        {
            Reconnect = new TransportReconnectOptions
            {
                Delay = (_, _) =>
                {
                    return TimeSpan.FromMinutes(1);
                },
                CancellationToken = cancelling.Token,
            },
        });
        var reported = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);

        participant.Error += (reason) =>
        {
            reported.TrySetResult(reason);
        };
        await participant.Start();
        adapter.Lose();

        // * each attempt is refused, and the wait before the next one is cut short
        await adapter.Start();
        await cancelling.CancelAsync();
        Assert.Equal("the link of ada went down, and its reconnection ended: the reconnection was cancelled", (await reported.Task.WaitAsync(BrokerPair.Patience, Cancelled)).Message);
        Assert.False(participant.IsLinked);
    }

    [Fact]
    public async Task Serves_its_names_again_once_its_link_connects_anew_its_former_peers_reset()
    {
        await using var pair = await BrokerPair.Of();
        await using var first = await pair.Connect();
        var former = pair.ServerParticipant.Incarnation;

        pair.ServerAdapter.Lose();

        // * its connection closed, unclean; its name held again, by another incarnation
        await BrokerPair.Until(
            () =>
            {
                return first.ReadyState == ReadyState.Closed && pair.ServerParticipant.IsLinked && pair.Server.Gauges().Counts["names"] == 1;
            },
            "its connection closed, and its name held again");
        Assert.NotEqual(former, pair.ServerParticipant.Incarnation);

        await using var second = await pair.Connect();

        Assert.Equal(["type=BROKER;participant=client;ordinal=2"], pair.Server.Clients.Select((client) =>
        {
            return client.ConnectionHandle;
        }));
    }

    [Fact]
    public async Task Reports_what_reaches_a_name_but_a_parcel_and_an_OPEN_that_does_not_read_and_drops_in_silence_any_other_parcel_there_a_parcel_at_its_inbox_that_names_no_connection_and_anything_but_a_GONE_at_a_departure()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();
        var tester = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "tester" });
        var heard = new ConcurrentQueue<byte[]>();
        var reported = new ConcurrentQueue<string>();
        var told = new ConcurrentQueue<(string Message, string ConnectionHandle)>();
        const ulong Half = 0xA1_00_00_00_00_00_00_01;

        tester.Message += (message) =>
        {
            heard.Enqueue(message.Payload.ToArray());
            message.Settle();
        };
        pair.ServerParticipant.Error += (reason) =>
        {
            reported.Enqueue(reason.Message);
        };
        pair.Server.Error += (reason, connectionHandle) =>
        {
            told.Enqueue((reason.Message, connectionHandle));
        };
        await tester.Start();
        await tester.Subscribe(["bead", "i", "tester"]);

        // an OPEN of a layout to come whose id runs past its bytes, and one whose kept byte is not 0
        var cut = BrokerParcels.Encode(new BrokerParcel { Layout = 0xB2, Kind = BrokerParcelKinds.Open, Opener = Half, Sequence = 1, Id = "tester", Bound = 65_536 })[..31];
        var kept = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = Half, Sequence = 1, Id = "tester", Incarnation = 0xC0, Bound = 65_536 });
        var ping = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = Half, Acceptor = Half, Sequence = 2 });
        var unread = ping.ToArray();

        kept[3] = 1;
        unread[3] = 1;

        foreach (var payload in new[] { (byte[])[0xB1], cut, kept, ping, unread })
        {
            await tester.Publish(new BrokerPublication { Topic = ["bead", "s", "interop"], Payload = payload });
        }

        // at its inbox, an ACCEPT of a layout to come and a parcel that does not read, naming no pair
        foreach (var payload in new[] { BrokerParcels.Encode(new BrokerParcel { Layout = 0xB2, Kind = BrokerParcelKinds.Accept, Opener = Half, Acceptor = Half, Sequence = 1 }), unread })
        {
            await tester.Publish(new BrokerPublication { Topic = ["bead", "i", "server"], Payload = payload });
        }

        // at a departure it subscribes, no parcel and a parcel but a GONE
        foreach (var payload in new[] { (byte[])[0xB1], ping })
        {
            await tester.Publish(new BrokerPublication { Topic = ["bead", "d", "client"], Payload = payload });
        }

        await pair.Scheduler.WhenIdle();

        string[] reports =
        [
            "a message to the name interop is no parcel: 1 bytes, under a parcel's 28",
            "an OPEN to the name interop does not read, dropped: an OPEN whose id runs past its bytes",
            "an OPEN to the name interop does not read, dropped: a kept byte that is not 0",
        ];

        // * each reported by its participant, and by its server transport with no handle
        Assert.Equal(reports, reported);
        Assert.Equal(reports.Select((message) =>
        {
            return (message, "");
        }), told);
        Assert.Equal((0, ReadyState.Open, 1), (heard.Count, client.ReadyState, pair.Server.Clients.Count));
    }

    private static TimeSpan Immediately(TimeSpan? previousDelay, int attempt)
    {
        return TimeSpan.Zero;
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
    // what it publishes to a topic bounded by Room when given, its leg secure as Secure says when given
    private sealed class RecordingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
    {
        public long? Room { get; init; }

        public bool? Secure { get; init; }

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
                return Secure ?? inner.IsSecure;
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
