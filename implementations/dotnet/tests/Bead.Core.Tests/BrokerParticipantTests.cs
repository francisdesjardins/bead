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

        Assert.Equal("its application requires delivery at least once, and its adapter gives it at most once (Parameter 'options')", refused.Message);

        // what it requires, or less where nothing is required, is taken
        _ = new BrokerParticipant(atMostOnce);
        _ = new BrokerParticipant(atMostOnce, new BrokerParticipantOptions { RequireDelivery = BrokerDelivery.AtMostOnce });
        _ = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" }), new BrokerParticipantOptions { RequireDelivery = BrokerDelivery.AtLeastOnce });
    }

    // an adapter that writes down each call its participant makes of it, in order, and passes it on
    private sealed class RecordingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
    {
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
            return inner.MaximumPayloadBytes(topic);
        }

        public Task Stop()
        {
            Calls.Enqueue("stop");

            return inner.Stop();
        }
    }
}
