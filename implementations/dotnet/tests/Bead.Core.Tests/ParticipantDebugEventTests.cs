using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

public sealed class ParticipantDebugEventTests
{
    // debugging 13.2, 13.4
    [Fact]
    public async Task Traces_each_incoming_verdict_once_after_judgment_and_names_a_loss_by_its_awaited_and_received_sequences()
    {
        await using var pair = await TracePair.Of();
        pair.Events.Clear();
        var parcel = pair.Accept with { Kind = BrokerParcelKinds.Pong, Answers = 2, Sequence = 3, Flags = 0 };
        await pair.Send(BrokerParcels.Write(parcel));
        await pair.Send(BrokerParcels.Write(parcel));
        await pair.Send(BrokerParcels.Encode(parcel with { Kind = 0x80, Flags = 0xFF, Sequence = 4 }));
        await pair.Send(BrokerParcels.Write(parcel with { Sequence = 6 }));
        Assert.Equal([ParcelVerdict.Taken, ParcelVerdict.Copy, ParcelVerdict.Advisory, ParcelVerdict.Loss], pair.Events.Where(IsIncoming).Select((item) => { return item.Verdict; }));
        Assert.Equal((byte)0xFF, Assert.Single(pair.Events, (item) => { return item.Verdict == ParcelVerdict.Advisory; }).Flags);
        var loss = Assert.Single(pair.Events, (item) => { return item.Verdict == ParcelVerdict.Loss; });
        Assert.Equal((5UL, 6UL, 1L, "server"), (loss.Awaited, loss.Came, loss.Connection, loss.ConnectionHandle));
        Assert.Contains("a parcel lost: 5 was awaited, and 6 came", Assert.Single(pair.Events, (item) => { return item.Event == "report"; }).Report, StringComparison.Ordinal);
        await pair.Send(BrokerParcels.Write(parcel with { Sequence = 6 }));
        await pair.Send(new byte[] { 0 });
        await pair.Send(BrokerParcels.Encode(parcel with { Kind = 0x0A, Sequence = 7 }));
        await pair.ServerAdapter.PublishRetained(new BrokerPublication { Topic = ["bead", "i", "client"], Payload = BrokerParcels.Write(parcel) });
        await pair.ClientAdapter.Subscribe(["other", "i", "client"]);
        await pair.ServerAdapter.Publish(new BrokerPublication { Topic = ["other", "i", "client"], Payload = BrokerParcels.Write(parcel) });
        await pair.Scheduler.WhenIdle();
        var received = pair.Events.Where(IsIncoming).ToArray();
        Assert.Equal([ParcelVerdict.Taken, ParcelVerdict.Copy, ParcelVerdict.Advisory, ParcelVerdict.Loss, ParcelVerdict.PairNotHeld, ParcelVerdict.NoParcel, ParcelVerdict.DoesNotRead, ParcelVerdict.Retained, ParcelVerdict.OffTopic], received.Select((item) => { return item.Verdict; }));
        foreach (var item in received.Where((item) => { return item.Verdict is ParcelVerdict.Retained or ParcelVerdict.OffTopic or ParcelVerdict.NoParcel; }))
        {
            Assert.Null(item.Layout);
            Assert.Null(item.Opener);
        }
    }

    // debugging 13.3, 13.7
    [Fact]
    public async Task Traces_parcel_attempts_and_third_leg_handles_without_carried_bytes_credentials_or_an_acceptor_s_half()
    {
        await using var pair = await TracePair.Of();
        await pair.Client.Send(new TransportMessage(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF }, false) { Credential = "trace-secret" });
        await pair.Scheduler.WhenIdle();
        var tx = Assert.Single(pair.Events, (item) => { return item.Direction == "tx" && item.Kind == "DATA"; });
        Assert.Equal((4, 1L, "server", true, false), (tx.CarriedBytes, tx.Connection, tx.ConnectionHandle, tx.HasCredential, tx.More));
        var rx = Assert.Single(pair.ServerEvents, (item) => { return item.Direction == "rx" && item.Kind == "DATA"; });
        Assert.Equal((4, 1L, pair.Handle, true, ParcelVerdict.Taken), (rx.CarriedBytes, rx.Connection, rx.ConnectionHandle, rx.HasCredential, rx.Verdict));
        Assert.Null(Assert.Single(pair.ServerEvents, (item) => { return item.Direction == "tx" && item.Kind == "ACCEPT"; }).ConnectionHandle);
        Assert.Equal(pair.Handle, Assert.Single(pair.ServerEvents, (item) => { return item.Direction == "rx" && item.Kind == "PING"; }).ConnectionHandle);
        var json = JsonSerializer.Serialize(pair.Events.Concat(pair.ServerEvents));
        Assert.DoesNotContain(pair.Accept.Acceptor.ToString("x16", CultureInfo.InvariantCulture), json, StringComparison.Ordinal);
        Assert.DoesNotContain("trace-secret", json, StringComparison.Ordinal);
        Assert.DoesNotContain("deadbeef", json, StringComparison.Ordinal);
        Assert.DoesNotContain("Acceptor", json, StringComparison.Ordinal);
        pair.ClientParticipant.TraceParcel(pair.Accept with { Kind = BrokerParcelKinds.Data, Flags = BrokerParcelFlags.Credential | BrokerParcelFlags.More, Carried = new byte[4], Credential = "trace-secret" }, new ParticipantDebugEvent { Event = "parcel" });
        Assert.Equal((4, true, true), (pair.Events.Last().CarriedBytes, pair.Events.Last().HasCredential, pair.Events.Last().More));
    }

    // debugging 13.1, 13.5, 13.8
    [Fact]
    public async Task Tells_completed_link_transitions_and_held_names_by_push_and_keeps_levels_available_by_pull()
    {
        await using var pair = await TracePair.Of();
        Assert.Equal(["interop"], pair.ServerParticipant.Names);
        Assert.Contains(pair.ServerEvents, (item) => { return item.Event == "names" && item.Name == "interop" && item.IsHeld == true && item.Group is null; });
        var before = pair.ClientParticipant.Incarnation;
        pair.ClientAdapter.Lose();
        await BrokerPair.Until(() => { return pair.Events.Count((item) => { return item.State == "up"; }) == 2; }, "its link connects again");
        var links = pair.Events.Where((item) => { return item.Event == "link"; }).ToArray();
        Assert.Equal(["up", "down", "up"], links.Select((item) => { return item.State; }));
        Assert.Equal([1L], links[1].Ended);
        Assert.NotEqual(before, pair.ClientParticipant.Incarnation);
        Assert.Equal(0, pair.ClientParticipant.Gauges().Counts["connections"]);
        await pair.Client.Connect(new BrokerConnectOptions { Server = "interop" }, TestContext.Current.CancellationToken);
        await pair.Scheduler.WhenIdle();
        Assert.Equal(2L, pair.Events.Last((item) => { return item.Kind == "PING" && item.Direction == "tx"; }).Connection);
        await pair.ClientParticipant.Stop();
        await pair.Server.Stop();
        Assert.Empty(pair.ServerParticipant.Names);
        Assert.False(pair.ServerEvents.Last((item) => { return item.Event == "names"; }).IsHeld);
        var stopped = pair.Events.Last((item) => { return item.Event == "link"; });
        Assert.Equal("stopped", stopped.State);
        Assert.Equal([2L], stopped.Ended);
    }

    [Fact]
    public async Task Tells_a_takeover_once_after_clearing_names_and_connections_and_tells_no_later_link_transition()
    {
        await using var pair = await TracePair.Of();
        var completed = false;
        pair.ServerParticipant.Debug += (item) =>
        {
            if (item.State == "taken-over")
            {
                completed = pair.ServerParticipant.Names.Count == 0 && pair.ServerParticipant.Gauges().Counts["connections"] == 0;
            }
        };
        pair.ServerAdapter.TakeOver();
        await pair.Scheduler.WhenIdle();
        await pair.ServerParticipant.Stop();
        Assert.True(completed);
        Assert.Equal(["up", "taken-over"], pair.ServerEvents.Where((item) => { return item.Event == "link"; }).Select((item) => { return item.State; }));
    }

    // debugging 13.6, 13.9
    [Fact]
    public async Task Reports_a_debug_listener_s_throw_and_calls_later_listeners_while_the_participant_carries_on()
    {
        var broker = new MemoryBroker();
        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "client" }));
        var errors = new ConcurrentQueue<string>();
        var events = new ConcurrentQueue<ParticipantDebugEvent>();
        static void Throwing(ParticipantDebugEvent item)
        {
            throw new InvalidOperationException("debug listener");
        }
        participant.Error += (reason) => { errors.Enqueue(reason.Message); };
        Assert.False(participant.IsDebugging);
        participant.Debug += Throwing;
        participant.Debug += events.Enqueue;
        Assert.True(participant.IsDebugging);
        await participant.Start();
        Assert.True(participant.IsLinked);
        Assert.Equal(["link"], events.Select((item) => { return item.Event; }));
        Assert.Equal(["debug listener"], errors);
        participant.Debug -= Throwing;
        await participant.Stop();
        Assert.Equal(["up", "stopped"], events.Select((item) => { return item.State; }));
    }

    // debugging 13.10
    [Fact]
    public async Task Reads_no_clock_and_builds_no_trace_while_nobody_watches_a_parcel_taken_or_sent()
    {
        await using var pair = await TracePair.Of();
        pair.ClientParticipant.Debug -= pair.Events.Enqueue;
        Assert.False(pair.ClientParticipant.IsDebugging);
        var before = pair.Clock.Readings;
        var held = pair.Events.Count;
        await pair.Send(BrokerParcels.Write(pair.Accept with { Kind = BrokerParcelKinds.Pong, Flags = 0, Answers = 2, Sequence = 3 }));
        await pair.Client.Send(new TransportMessage(new byte[] { 1 }, false));
        await pair.Scheduler.WhenIdle();
        Assert.Equal(held, pair.Events.Count);
        Assert.Equal(before, pair.Clock.Readings);
        pair.ClientParticipant.Debug += pair.Events.Enqueue;
        await pair.Send(BrokerParcels.Write(pair.Accept with { Kind = BrokerParcelKinds.Pong, Flags = 0, Answers = 2, Sequence = 4 }));
        await pair.Client.Send(new TransportMessage(new byte[] { 2 }, false));
        await pair.Scheduler.WhenIdle();
        Assert.Equal(["rx", "tx"], pair.Events.Skip(held).Select((item) => { return item.Direction; }));
    }

    [Fact]
    public async Task Traces_malformed_held_parcels_copies_and_gaps_of_a_kind_to_come_and_a_layout_to_come_before_their_connection_ends()
    {
        foreach (var scenario in new[] { "malformed", "next-kind", "gap-kind", "next-layout" })
        {
            await using var pair = await TracePair.Of();
            pair.Events.Clear();
            var parcel = pair.Accept with { Kind = BrokerParcelKinds.Ping, Flags = 0, Sequence = 3 };
            if (scenario == "next-kind")
            {
                await pair.Send(BrokerParcels.Encode(parcel with { Kind = 0x0A, Sequence = 1 }));
            }
            var payload = BrokerParcels.Encode(parcel with
            {
                Kind = scenario is "next-kind" or "gap-kind" ? (byte)0x0A : BrokerParcelKinds.Ping,
                Sequence = scenario == "gap-kind" ? 5UL : 3UL,
                Layout = scenario == "next-layout" ? (byte)0xB2 : (byte)0xB1,
                Flags = scenario == "next-layout" ? (byte)0xFF : (byte)0,
            });
            if (scenario == "malformed")
            {
                payload[3] = 1;
            }
            await pair.Send(payload);
            var rx = pair.Events.Where(IsIncoming).ToArray();
            ParcelVerdict?[] expected = scenario == "next-kind" ? [ParcelVerdict.Copy, ParcelVerdict.DoesNotRead] : [scenario == "gap-kind" ? ParcelVerdict.Loss : scenario == "next-layout" ? ParcelVerdict.Taken : ParcelVerdict.DoesNotRead];
            Assert.Equal(expected, rx.Select((item) => { return item.Verdict; }));
            Assert.Equal(scenario == "next-layout" ? (byte)0xFF : (byte)0, rx[^1].Flags);
            Assert.Equal(1L, rx[^1].Connection);
            var close = Assert.Single(pair.Events, (item) => { return item.Direction == "tx" && item.Kind == "CLOSE"; });
            Assert.Equal(scenario == "gap-kind" ? 4000 : 1002, close.Code);
            Assert.Single(pair.Events, (item) => { return item.Event == "report"; });
            Assert.Equal(ReadyState.Closed, pair.Client.ReadyState);
        }
    }

    [Fact]
    public async Task Traces_held_names_and_departures_by_their_verdict_without_inventing_a_connection()
    {
        await using var pair = await TracePair.Of();
        pair.ServerEvents.Clear();
        async Task Publish(ReadOnlyMemory<byte> payload, string place)
        {
            await pair.ClientAdapter.Publish(new BrokerPublication { Payload = payload, Topic = ["bead", place, place == "s" ? "interop" : "client"] });
            await pair.Scheduler.WhenIdle();
        }
        await Publish(new byte[] { 0 }, "s");
        var open = new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = pair.Accept.Opener, Sequence = 1, Id = "client", Incarnation = pair.ClientParticipant.Incarnation, Bound = 1024 };
        var malformed = BrokerParcels.Encode(open);
        malformed[3] = 1;
        await Publish(malformed, "s");
        await Publish(BrokerParcels.Encode(open with { Kind = 0x80, Flags = 0xFF }), "s");
        await Publish(BrokerParcels.Encode(open with { Layout = 0xB2, Flags = 0xFF }), "s");
        await Publish(new byte[] { 0 }, "d");
        await Publish(BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Gone, Id = "client", Incarnation = ((UInt128)0x0101010101010101 << 64) | 0x0101010101010101 }), "d");
        var rx = pair.ServerEvents.Where(IsIncoming).ToArray();
        Assert.Equal([ParcelVerdict.NoParcel, ParcelVerdict.DoesNotRead, ParcelVerdict.Advisory, ParcelVerdict.Taken, ParcelVerdict.NoParcel, ParcelVerdict.Taken], rx.Select((item) => { return item.Verdict; }));
        Assert.Equal((byte)0xFF, rx[2].Flags);
        Assert.Equal((byte)0xFF, rx[3].Flags);
        Assert.All(rx, (item) => { Assert.Null(item.Connection); });
        Assert.Equal(2, pair.ServerEvents.Count((item) => { return item.Event == "report"; }));
        Assert.Equal(426, Assert.Single(pair.ServerEvents, (item) => { return item.Kind == "REFUSE"; }).Status);
        Assert.Equal(1, pair.Server.Gauges().Counts["connections"]);
    }

    [Fact]
    public async Task Keeps_only_each_parcel_kind_s_body_fields_and_the_prefix_when_no_body_reads()
    {
        await using var pair = await TracePair.Of();
        var sample = new BrokerParcel
        {
            Layout = 0xB1,
            Kind = BrokerParcelKinds.Open,
            Flags = 7,
            Opener = 0x0102030405060708,
            Acceptor = 0x0807060504030201,
            Sequence = 3,
            Id = "ada",
            Incarnation = ((UInt128)0x0101010101010101 << 64) | 0x0101010101010101,
            Bound = 1024,
            Status = 503,
            Carried = new byte[] { 1, 2 },
            Credential = "trace-secret",
            Answers = 2,
            Code = 1000,
        };
        foreach (var kind in new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0A, 0x80 })
        {
            await pair.Scheduler.Run(() =>
            {
                pair.ClientParticipant.TraceParcel(sample with { Kind = kind }, new ParticipantDebugEvent { Event = "parcel" });
                return Task.CompletedTask;
            });
            var item = pair.Events.Last();
            Assert.Equal("0102030405060708", item.Opener);
            Assert.Equal(3UL, item.Sequence);
            Assert.Equal((byte)7, item.Flags);
            Assert.Equal(kind == 0x80 ? "advisory 128" : BrokerParcels.NameOf(kind), item.Kind);
            Assert.Equal(kind is 1 or 2 or 9 ? "ada" : null, item.Id);
            Assert.Equal(kind is 1 or 2 or 9 ? string.Concat(Enumerable.Repeat("01", 16)) : null, item.Incarnation);
            Assert.Equal(kind is 1 or 2 ? 1024 : (long?)null, item.Bound);
            Assert.Equal(kind is 1 or 2 ? true : (bool?)null, item.Secure);
            Assert.Equal(kind == 3 ? 503 : (int?)null, item.Status);
            Assert.Equal(kind == 4 ? 2 : (int?)null, item.CarriedBytes);
            Assert.Equal(kind == 4 ? true : (bool?)null, item.More);
            Assert.Equal(kind == 4 ? true : (bool?)null, item.HasCredential);
            Assert.Equal(kind == 6 ? 2UL : (ulong?)null, item.Answers);
            Assert.Equal(kind == 7 ? 1000 : (int?)null, item.Code);
        }
        await pair.Scheduler.Run(() =>
        {
            pair.ClientParticipant.TraceParcel(sample with { Kind = BrokerParcelKinds.Open }, new ParticipantDebugEvent { Event = "parcel", Verdict = ParcelVerdict.DoesNotRead });
            return Task.CompletedTask;
        });
        Assert.Null(pair.Events.Last().Id);
        Assert.Null(pair.Events.Last().Secure);
    }

    [Fact]
    public async Task Pins_what_a_parcel_taken_and_sent_allocate_while_nobody_watches()
    {
        await using var pair = await TracePair.Of();
        pair.ClientParticipant.Debug -= pair.Events.Enqueue;
        var connection = new BrokerConnection(pair.ClientParticipant, new BrokerConnectionSetup
        {
            Owner = pair.Client,
            Opener = 1,
            Acceptor = 2,
            PeerId = "server",
            PeerIncarnation = 1,
            PeerBound = 65_536,
            IsPeerSecure = true,
            Sent = 1,
            Awaited = 1,
            MaximumUnsentBytes = long.MaxValue,
            IsHalfOpen = false,
        });
        var parcel = new BrokerParcel { Kind = BrokerParcelKinds.Pong, Answers = 2, Sequence = 1 };
        long[] Allocated()
        {
            var taken = long.MaxValue;
            var sent = long.MaxValue;
            for (var round = 0; round < 16; round += 1)
            {
                var next = parcel with { Sequence = parcel.Sequence + (ulong)round };
                var before = GC.GetAllocatedBytesForCurrentThread();
                connection.Take(next, (36, null));
                taken = Math.Min(taken, GC.GetAllocatedBytesForCurrentThread() - before);
                before = GC.GetAllocatedBytesForCurrentThread();
                connection.Publish(parcel);
                sent = Math.Min(sent, GC.GetAllocatedBytesForCurrentThread() - before);
            }
            parcel = parcel with { Sequence = parcel.Sequence + 16 };
            return [taken, sent];
        }
        await pair.Scheduler.Run(() =>
        {
            var unheard = Allocated();
            Assert.Equal(new long[] { 0, 2608 }, unheard);
            pair.ClientParticipant.Debug += pair.Events.Enqueue;
            var heard = Allocated();
            Assert.True(heard[0] > unheard[0]);
            Assert.True(heard[1] > unheard[1]);
            pair.ClientParticipant.Debug -= pair.Events.Enqueue;
            Assert.Equal(unheard, Allocated());
            return Task.CompletedTask;
        });
    }

    private static bool IsIncoming(ParticipantDebugEvent item)
    {
        return item.Direction == "rx";
    }

    private sealed class TracePair : IAsyncDisposable
    {
        private TracePair()
        {
            Broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = Scheduler });
            ClientAdapter = Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "client" });
            ServerAdapter = Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" });
            ClientParticipant = new BrokerParticipant(ClientAdapter, new BrokerParticipantOptions
            {
                Scheduler = Scheduler,
                Clock = Clock,
                Heartbeat = Timeout.InfiniteTimeSpan,
                Reconnect = new TransportReconnectOptions { Delay = (_, _) => { return TimeSpan.Zero; } },
            });
            ServerParticipant = new BrokerParticipant(ServerAdapter, new BrokerParticipantOptions { Scheduler = Scheduler, Heartbeat = Timeout.InfiniteTimeSpan });
            ClientParticipant.Debug += Events.Enqueue;
            ServerParticipant.Debug += ServerEvents.Enqueue;
            ClientAdapter.Message += (message) =>
            {
                if (BrokerParcels.Read(message.Payload).Parcel is { Kind: BrokerParcelKinds.Accept } accept)
                {
                    Accept = accept;
                }
            };
            Server = ServerParticipant.Server(new BrokerTransportServerOptions { Names = ["interop"] });
            Server.Connection += (handle) => { Handle = handle; };
            Client = ClientParticipant.Client();
        }

        public SerialScheduler Scheduler { get; } = new();
        public ReadingClock Clock { get; } = new();
        public MemoryBroker Broker { get; }
        public MemoryBrokerAdapter ClientAdapter { get; }
        public MemoryBrokerAdapter ServerAdapter { get; }
        public BrokerParticipant ClientParticipant { get; }
        public BrokerParticipant ServerParticipant { get; }
        public BrokerTransportClient Client { get; }
        public BrokerTransportServer Server { get; }
        public BrokerParcel Accept { get; private set; } = null!;
        public string Handle { get; private set; } = "";
        public ConcurrentQueue<ParticipantDebugEvent> Events { get; } = new();
        public ConcurrentQueue<ParticipantDebugEvent> ServerEvents { get; } = new();

        public static async Task<TracePair> Of()
        {
            var pair = new TracePair();
            await pair.Server.Start();
            await pair.Client.Connect(new BrokerConnectOptions { Server = "interop" }, TestContext.Current.CancellationToken);
            await pair.Scheduler.WhenIdle();
            Assert.NotNull(pair.Accept);
            Assert.NotEmpty(pair.Handle);
            return pair;
        }

        public async Task Send(ReadOnlyMemory<byte> payload)
        {
            await ServerAdapter.Publish(new BrokerPublication { Topic = ["bead", "i", "client"], Payload = payload });
            await Scheduler.WhenIdle();
        }

        public async ValueTask DisposeAsync()
        {
            await ClientParticipant.DisposeAsync();
            await ServerParticipant.DisposeAsync();
        }
    }

    private sealed class ReadingClock : TimeProvider
    {
        public int Readings { get; private set; }

        public override DateTimeOffset GetUtcNow()
        {
            Readings += 1;
            return DateTimeOffset.UnixEpoch;
        }

        public override long GetTimestamp()
        {
            Readings += 1;
            return 0;
        }
    }
}
