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
}
