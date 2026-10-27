using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Bead.Tests;

/// <summary>A broker's server transport (spec 15.18, 15.22): its handles, drawn at the third leg, and the credential it never carries.</summary>
public sealed class BrokerTransportServerTests
{
    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    [Fact]
    public async Task Draws_a_handle_of_its_adapter_type_for_each_connection_at_its_third_leg_and_gives_none_twice()
    {
        await using var pair = await BrokerPair.Of();
        var peer = pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });
        var heard = Channel.CreateUnbounded<BrokerParcel>();

        peer.Message += (message) =>
        {
            message.Settle();
            heard.Writer.TryWrite(BrokerParcels.Read(message.Payload).Parcel!);
        };
        await peer.Start();
        await peer.Subscribe(["bead", "i", "peer"]);

        async Task<ulong> Accepted(ulong opener)
        {
            await peer.Publish(new BrokerPublication
            {
                Topic = ["bead", "s", "interop"],
                Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = opener, Sequence = 1, Id = "peer", Incarnation = 7, Bound = 65_536 }),
            });

            var accept = await heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(BrokerPair.Patience, Cancelled);

            Assert.Equal((BrokerParcelKinds.Accept, opener), (accept.Kind, accept.Opener));

            return accept.Acceptor;
        }

        async Task Proven((ulong Opener, ulong Acceptor) pairOf)
        {
            await peer.Publish(new BrokerPublication
            {
                Topic = ["bead", "i", "server"],
                Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = pairOf.Opener, Acceptor = pairOf.Acceptor, Sequence = 2 }),
            });
            await heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(BrokerPair.Patience, Cancelled);
        }

        // * accepted, half-open: nothing told, no handle drawn, until its third leg
        var first = await Accepted(1);

        await pair.Scheduler.WhenIdle();
        Assert.Empty(pair.Opened);
        Assert.Equal((0L, 1L), (pair.Server.Gauges().Counts["connections"], pair.Server.Gauges().Counts["halfOpen"]));

        await Proven((1, first));
        Assert.Equal(["type=BROKER;participant=peer;ordinal=1"], pair.Opened);

        // each its own, by its adapter's type, the peer's id and its rank, never given again
        var second = await Accepted(2);

        await Proven((2, second));
        Assert.True(await pair.Server.CloseConnection("type=BROKER;participant=peer;ordinal=1"));
        Assert.Equal((BrokerParcelKinds.Close, 1000), ((await heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(BrokerPair.Patience, Cancelled)) is { } close ? (close.Kind, close.Code) : default));

        var third = await Accepted(3);

        await Proven((3, third));
        Assert.Equal(["type=BROKER;participant=peer;ordinal=1", "type=BROKER;participant=peer;ordinal=2", "type=BROKER;participant=peer;ordinal=3"], pair.Opened);
        Assert.Equal(TransportTypes.Broker, pair.Server.Type);
        Assert.False(pair.Server.IsSecure("type=BROKER;participant=nobody;ordinal=1"));
        Assert.False(await pair.Server.CloseConnection("type=BROKER;participant=peer;ordinal=1"));
        Assert.Equal(
            ["type=BROKER;participant=peer;ordinal=2", "type=BROKER;participant=peer;ordinal=3"],
            pair.Server.Clients.Select((client) =>
            {
                return client.ConnectionHandle;
            }));
        Assert.All(pair.Server.Clients, (client) =>
        {
            Assert.Equal(("peer", 0, TransportTypes.Broker), (client.Address, client.Port, client.Type));
        });

        // its bounds held as it is built
        foreach (var options in new[]
        {
            new BrokerTransportServerOptions { Names = [] },
            new BrokerTransportServerOptions { Names = ["a.b"] },
            new BrokerTransportServerOptions { Names = ["other"], AcceptTimeout = Timeout.InfiniteTimeSpan },
            new BrokerTransportServerOptions { Names = ["other"], MaximumConnections = 0 },
        })
        {
            Assert.ThrowsAny<ArgumentException>(() =>
            {
                return pair.ServerParticipant.Server(options);
            });
        }

        var plain = new BrokerParticipant(pair.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "plain", Capabilities = BrokerCapabilities.Will }));

        Assert.Equal("a name served in a group needs an adapter that offers groups, and the adapter of plain does not (Parameter 'options')", Assert.Throws<ArgumentException>(() =>
        {
            return plain.Server(new BrokerTransportServerOptions { Names = ["interop"], IsInGroup = true });
        }).Message);
    }

    [Fact]
    public async Task Refuses_400_malformed_an_OPEN_whose_id_is_empty_or_no_token_and_tells_it()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"] });
        var peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });
        var heard = new ConcurrentQueue<(string Topic, byte Kind, int? Status)>();
        var refusals = new ConcurrentQueue<(string? Address, int Status, string Reason)>();

        server.Refusal += (refusal) =>
        {
            refusals.Enqueue((refusal.Address, refusal.Status, refusal.Reason));
        };
        peer.Message += (message) =>
        {
            var parcel = BrokerParcels.Read(message.Payload).Parcel!;

            heard.Enqueue((string.Join('/', message.Topic), parcel.Kind, parcel.Status));
            message.Settle();
        };
        await peer.Start();
        await peer.Subscribe(["bead", "i", ""]);
        await peer.Subscribe(["bead", "i", "a.b"]);
        await server.Start();

        // * each answered at the inbox it names, as its id
        foreach (var id in new[] { "", "a.b" })
        {
            await peer.Publish(new BrokerPublication
            {
                Topic = ["bead", "s", "interop"],
                Payload = BrokerParcels.Encode(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = 0x01_00_00_00_00_00_00_01, Sequence = 1, Id = id, Incarnation = 0, Bound = 65_536 }),
            });
        }

        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 2 && refusals.Count == 2;
            },
            "both refused, and told");
        Assert.Equal([("", 400, "malformed"), ("a.b", 400, "malformed")], refusals);
        Assert.Equal([("bead/i/", BrokerParcelKinds.Refuse, (int?)400), ("bead/i/a.b", BrokerParcelKinds.Refuse, 400)], heard);
    }

    [Fact]
    public async Task Reports_a_half_open_connection_it_lost_of_its_own_by_its_opener_s_id_with_no_handle_telling_no_connection()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"], MaximumUnsentBytes = 1 });
        var peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });
        var heard = new ConcurrentQueue<(byte Kind, ulong Sequence, int? Code)>();
        var told = new ConcurrentQueue<(string Message, string ConnectionHandle)>();

        server.Error += (reason, connectionHandle) =>
        {
            told.Enqueue((reason.Message, connectionHandle));
        };
        server.Connection += (connectionHandle) =>
        {
            told.Enqueue(("connection", connectionHandle));
        };
        peer.Message += (message) =>
        {
            var parcel = BrokerParcels.Read(message.Payload).Parcel!;

            heard.Enqueue((parcel.Kind, parcel.Sequence, parcel.Code));
            message.Settle();
        };
        await peer.Start();
        await peer.Subscribe(["bead", "i", "peer"]);
        await server.Start();

        // * its ACCEPT would pass maximumUnsentBytes: the CLOSE that loses it goes alone
        await peer.Publish(new BrokerPublication
        {
            Topic = ["bead", "s", "interop"],
            Payload = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = 0x01_00_00_00_00_00_00_01, Sequence = 1, Id = "peer", Incarnation = 0, Bound = 65_536 }),
        });
        await BrokerPair.Until(
            () =>
            {
                return heard.Count == 1 && told.Count == 1;
            },
            "its CLOSE, reported");
        Assert.Equal([(BrokerParcelKinds.Close, 1UL, (int?)4000)], heard);
        Assert.Equal([("a half-open connection of peer is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 1 bytes", "")], told);
        Assert.Equal((0L, 0L), (server.Gauges().Counts["connections"], server.Gauges().Counts["halfOpen"]));
    }

    [Fact]
    public async Task Reports_what_a_listener_of_its_events_threw_with_its_connection_s_handle_or_none_for_a_refusal()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"], MaximumConnections = 1 });
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        await using var first = ada.Client();
        await using var second = ada.Client();
        var told = new ConcurrentQueue<(string Message, string ConnectionHandle)>();

        server.Connection += (_) =>
        {
            throw new InvalidOperationException("a connection listener threw");
        };
        server.Refusal += (_) =>
        {
            throw new InvalidOperationException("a refusal listener threw");
        };
        server.Error += (reason, connectionHandle) =>
        {
            told.Enqueue((reason.Message, connectionHandle));
        };
        await server.Start();
        await first.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        await BrokerPair.Until(
            () =>
            {
                return told.Count == 1;
            },
            "the connection listener's throw reported");

        // * past maximumConnections: refused 503, its listener's throw reported with no handle
        var refused = Assert.IsType<BrokerRefusedException>((await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return second.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        })).InnerException);

        Assert.Equal(("busy", (int?)503), (refused.Refusal.Reason, refused.Refusal.Status));
        await BrokerPair.Until(
            () =>
            {
                return told.Count == 2;
            },
            "the refusal listener's throw reported");
        Assert.Equal([("a connection listener threw", "type=BROKER;participant=ada;ordinal=1"), ("a refusal listener threw", "")], told);
        Assert.Equal(ReadyState.Open, first.ReadyState);
    }

    [Fact]
    public async Task Refuses_to_send_what_is_no_envelope_keeping_the_connection_and_holds_a_connection_secure_as_its_application_says_where_it_says()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"], Secure = false });
        await using var ada = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" }));
        await using var client = ada.Client();
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

        var handle = handles.Single();

        Assert.Equal("a broker connection carries envelopes, as bytes (Parameter 'message')", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Send(new TransportMessage("text"u8.ToArray(), true), handle);
        })).Message);

        // * both its legs in memory, secure; its application says its own is not, and its ACCEPT so
        Assert.Equal((ReadyState.Open, false, false), (client.ReadyState, server.IsSecure(handle), client.IsSecure));
    }

    [Fact]
    public async Task Carries_no_credential_toward_its_client_and_its_command_presenting_ELSEWHERE_fails_before_it_goes()
    {
        await using var pair = await BrokerPair.Of();
        await using var client = await pair.Connect();
        var handle = Assert.Single(pair.Opened);

        // ! secure, both legs in memory; yet nothing is carried toward a client (spec 15.22)
        Assert.Equal((false, true), (pair.Server.CarriesCredential(handle), pair.Server.IsSecure(handle)));

        var uncarried = CallSession.UncarriedOf(Credential.Elsewhere(), (pair.Server.CarriesCredential(handle), pair.Server.IsSecure(handle)));

        Assert.Equal((ushort)ProtocolCode.DestinationUnreachable, uncarried?.Code);

        // while a client carries any field value toward its server
        Assert.True(client.Carries("Bearer token"));
        Assert.False(client.Carries(" Bearer"));
    }

    [Fact]
    public async Task Starts_once_its_broker_holds_each_name_it_serves_fails_its_start_on_a_name_refused_and_stops_once_it_let_each_go()
    {
        var broker = new MemoryBroker();
        var holding = new HoldingAdapter(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }));
        await using var participant = new BrokerParticipant(holding);
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop", "echo"] });

        var reported = new ConcurrentQueue<string>();

        server.Error += (reason, connectionHandle) =>
        {
            reported.Enqueue(reason.Message);
        };

        // * its start asks each name at once and waits on each one's SUBACK, the gauge counting none
        // until its broker holds it
        var starting = server.Start();

        await BrokerPair.Until(
            () =>
            {
                return holding.Subscribing.Count == 2;
            },
            "each name asked of its broker");
        Assert.False(starting.IsCompleted);
        Assert.Equal(0, server.Gauges().Counts["names"]);
        holding.Subscribing.Dequeue().SetResult();
        await BrokerPair.Until(
            () =>
            {
                return server.Gauges().Counts["names"] == 1;
            },
            "the first name held");
        Assert.False(starting.IsCompleted);
        holding.Subscribing.Dequeue().SetResult();
        await starting.WaitAsync(BrokerPair.Patience, Cancelled);
        Assert.Equal(2, server.Gauges().Counts["names"]);

        // * its stop lets each go at once and waits on each one's UNSUBACK, the gauge counting it
        // until its broker let it go
        var stopping = server.Stop();

        await BrokerPair.Until(
            () =>
            {
                return holding.Unsubscribing.Count == 2;
            },
            "each name let go of");
        Assert.False(stopping.IsCompleted);
        Assert.Equal(2, server.Gauges().Counts["names"]);
        holding.Unsubscribing.Dequeue().SetResult();
        await BrokerPair.Until(
            () =>
            {
                return server.Gauges().Counts["names"] == 1;
            },
            "the first name let go");
        Assert.False(stopping.IsCompleted);

        // * one its broker refuses to let go is reported, and its stop settles all the same
        holding.Unsubscribing.Dequeue().SetException(new IOException("its broker refused to let bead/s/echo go: 0x80"));
        await stopping.WaitAsync(BrokerPair.Patience, Cancelled);
        Assert.Equal((ReadyState.Closed, 0L), (server.ReadyState, server.Gauges().Counts["names"]));
        Assert.Equal(["its broker refused to let bead/s/echo go: 0x80"], reported);

        // * a name its broker refuses fails its start as it is refused, and is counted none
        var refusing = server.Start();

        await BrokerPair.Until(
            () =>
            {
                return holding.Subscribing.Count == 2;
            },
            "each name asked anew");
        holding.Subscribing.Dequeue().SetException(new InvalidOperationException("its broker refused bead/s/interop"));
        Assert.Equal("its broker refused bead/s/interop", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return refusing.WaitAsync(BrokerPair.Patience, Cancelled);
        })).Message);
        holding.Subscribing.Dequeue().SetException(new InvalidOperationException("its broker refused bead/s/echo"));
        await participant.Scheduler.WhenIdle();
        Assert.Equal(0, server.Gauges().Counts["names"]);
        Assert.Single(reported);
    }

    // an adapter that holds each subscription and unsubscription of a server's name until the test
    // settles it, and passes every other call on
    private sealed class HoldingAdapter(MemoryBrokerAdapter inner) : IBrokerAdapter
    {
        public Queue<TaskCompletionSource> Subscribing { get; } = new();

        public Queue<TaskCompletionSource> Unsubscribing { get; } = new();

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

        public event Action<BrokerDown>? Down
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

        public long ReceiveBound(IReadOnlyList<string> topic)
        {
            return inner.ReceiveBound(topic);
        }

        public Task Start(BrokerStart? start = null)
        {
            return inner.Start(start);
        }

        public async Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
        {
            if (topic is [_, "s", _])
            {
                var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

                lock (Subscribing)
                {
                    Subscribing.Enqueue(held);
                }

                await held.Task;
            }

            await inner.Subscribe(topic, subscription);
        }

        public async Task Unsubscribe(IReadOnlyList<string> topic)
        {
            if (topic is [_, "s", _])
            {
                var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

                lock (Unsubscribing)
                {
                    Unsubscribing.Enqueue(held);
                }

                await held.Task;
            }

            await inner.Unsubscribe(topic);
        }

        public Task<BrokerPublished> Publish(BrokerPublication publication)
        {
            return inner.Publish(publication);
        }

        public long MaximumPayloadBytes(IReadOnlyList<string> topic)
        {
            return inner.MaximumPayloadBytes(topic);
        }

        public Task Stop()
        {
            return inner.Stop();
        }
    }
}
