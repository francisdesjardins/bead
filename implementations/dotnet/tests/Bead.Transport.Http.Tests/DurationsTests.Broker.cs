using System.Diagnostics;
using Bead.Tests;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The places of a broker's transports (spec 15.20, 15.21, 15.23): its participant's heartbeat,
/// taken or refused as it is built, on the real clock; its server's accept timeout and its parts'
/// grace, read from the timer each arms on the clock given, as a peer of the tests' own opens a
/// connection over the in-memory broker; and its client's connect timeout.
/// </summary>
public sealed partial class DurationsTests
{
    // a broker's server serving interop on a clock of the tests' own, and a peer of the same broker
    // whose inbox is subscribed; what reaches the peer, in order
    private sealed class BrokerDrive : IAsyncDisposable
    {
        private readonly SerialScheduler _scheduler = new();
        private readonly System.Threading.Channels.Channel<BrokerParcel> _heard = System.Threading.Channels.Channel.CreateUnbounded<BrokerParcel>();
        private readonly MemoryBrokerAdapter _peer;
        private readonly BrokerParticipant _participant;
        private readonly BrokerTransportServer _server;

        private BrokerDrive((BrokerParticipantOptions Participant, BrokerTransportServerOptions Server) options)
        {
            Clock = new SteppingClock(Epoch) { Settle = _scheduler.WhenIdle };

            var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = _scheduler });

            _participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" }), options.Participant with { Clock = Clock, Scheduler = _scheduler });
            _server = _participant.Server(options.Server);
            _peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });
            _peer.Message += (message) =>
            {
                message.Settle();
                _heard.Writer.TryWrite(BrokerParcels.Read(message.Payload).Parcel!);
            };
        }

        public SteppingClock Clock { get; }

        public static async Task<BrokerDrive> Of((BrokerParticipantOptions Participant, BrokerTransportServerOptions Server) options)
        {
            var drive = new BrokerDrive(options);

            await drive._server.Start();
            await drive._peer.Start();
            await drive._peer.Subscribe(["bead", "i", "peer"]);

            return drive;
        }

        // the peer's OPEN, and the acceptor's half its ACCEPT drew
        public async Task<ulong> Open()
        {
            await Publish((["bead", "s", "interop"], new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = 1, Sequence = 1, Id = "peer", Incarnation = 7, Bound = 65_536 }));

            return (await _heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled)).Acceptor;
        }

        public Task<BrokerPublished> Publish((IReadOnlyList<string> Topic, BrokerParcel Parcel) publication)
        {
            return _peer.Publish(new BrokerPublication { Topic = publication.Topic, Payload = BrokerParcels.Write(publication.Parcel) });
        }

        // the dues armed on its clock, once one is, within a patience
        public async Task<IReadOnlyList<TimeSpan>> Dues()
        {
            var watch = Stopwatch.StartNew();
            var dues = Clock.Dues();

            while (dues.Count == 0 && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
                dues = Clock.Dues();
            }

            return dues;
        }

        public async ValueTask DisposeAsync()
        {
            await _server.DisposeAsync();
            await _participant.DisposeAsync();
        }
    }

    // brokerParticipant.heartbeat

    // the participant's options, as it is built: taken or refused
    private static async Task<Observed> BrokerHeartbeatByOptions(TimeSpan? given)
    {
        BrokerParticipant participant;

        try
        {
            participant = new BrokerParticipant(new MemoryBroker().Adapter(new MemoryBrokerAdapterOptions { Id = "server" }), new BrokerParticipantOptions { Heartbeat = Assert.NotNull(given) });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await participant.DisposeAsync();

        return Taken();
    }

    // brokerTransportServer.acceptTimeout

    // the transport server's options, as it is built: the due of the timer an ACCEPT arms for its
    // third leg; refused, no server built
    private static async Task<Observed> AcceptTimeoutByOptions(TimeSpan? given)
    {
        var server = new BrokerTransportServerOptions { Names = ["interop"] };

        try
        {
            server = given is { } timeout ? server with { AcceptTimeout = timeout } : server;
            await using var drive = await BrokerDrive.Of((new BrokerParticipantOptions(), server));

            await drive.Open();

            return HeldAt(DueOf(await drive.Dues()));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }
    }

    // brokerParticipant.bodyGracePeriod

    // the participant's options, as it is built: the due of the timer an envelope's first part arms,
    // its connection proven; refused, no participant built
    private static async Task<Observed> BrokerBodyGracePeriodByOptions(TimeSpan? given)
    {
        var participant = given is { } grace ? new BrokerParticipantOptions { BodyGracePeriod = grace } : new BrokerParticipantOptions();

        try
        {
            await using var drive = await BrokerDrive.Of((participant, new BrokerTransportServerOptions { Names = ["interop"] }));
            var acceptor = await drive.Open();

            await drive.Publish((["bead", "i", "server"], new BrokerParcel { Kind = BrokerParcelKinds.Ping, Opener = 1, Acceptor = acceptor, Sequence = 2 }));
            await drive.Clock.Settle();

            // * its accept timeout cleared at the third leg: what is armed after is the parts' own
            Assert.Empty(drive.Clock.Dues());
            await drive.Publish((["bead", "i", "server"], new BrokerParcel { Kind = BrokerParcelKinds.Data, Flags = BrokerParcelFlags.More, Opener = 1, Acceptor = acceptor, Sequence = 3, Carried = (byte[])[0xA1, 0x10] }));

            return HeldAt(DueOf(await drive.Dues()));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }
    }

    // transportClient.connectTimeout, by a broker's client

    // a client of a participant over the in-memory broker, whose server's name a peer subscribes and
    // answers nothing: its timeout's due, the connect at it and not before
    private static async Task<Observed> ConnectTimeoutByBroker(TimeSpan? given)
    {
        var clock = new SteppingClock(Epoch);
        var broker = new MemoryBroker();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var peer = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "peer" });

        peer.Message += (message) =>
        {
            message.Settle();
            reached.TrySetResult();
        };
        await peer.Start();
        await peer.Subscribe(["bead", "s", "interop"]);

        await using var participant = new BrokerParticipant(broker.Adapter(new MemoryBrokerAdapterOptions { Id = "client" }), new BrokerParticipantOptions { Clock = clock });

        await participant.Start();

        await using var client = participant.Client();

        return await ConnectTimeoutOf(new Connecting(client, clock)
        {
            Connect = (token) =>
            {
                return client.Connect(new BrokerConnectOptions { Server = "interop", Timeout = Assert.NotNull(given) }, token);
            },
            StateOf = () =>
            {
                return client.ReadyState;
            },
            Reconnect = () =>
            {
                return client.Reconnect();
            },
            Reached = () =>
            {
                return reached.Task;
            },
            IsUntouched = () =>
            {
                return !reached.Task.IsCompleted;
            },
        });
    }
}
