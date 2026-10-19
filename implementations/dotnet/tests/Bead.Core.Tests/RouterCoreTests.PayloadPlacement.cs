namespace Bead.Tests;

/// <summary>
/// How <see cref="RouterCore"/> places a payload: whole or as a transfer, within a procedure's
/// limit and the router's.
/// </summary>
public sealed partial class RouterCoreTests
{
    // spec 12.3.2
    [Fact]
    public async Task Holds_a_procedure_s_limit_both_ways_once_admitted()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve(maximumPayloadBytes: 10);

        resolver.Admission = (request) =>
        {
            return request.Header.CallId == 5 ? Failure.OfProtocol(ProtocolCode.AccessDenied) : null;
        };

        // past it, whole or by the total a transfer declares, before any credit; its admission first
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[11] });
        await server.Deliver(RequestOpeningOf(3, (PatternOf(300), 44)));
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[11] });
        Assert.Equal(
            [(ushort)ProtocolCode.PayloadTooLarge, (ushort)ProtocolCode.PayloadTooLarge, (ushort)ProtocolCode.AccessDenied],
            server.Sent.Select((envelope) =>
            {
                return envelope.Failure!.Code;
            }));

        // its answer, past it, is refused here
        await server.Deliver(new Envelope { Header = RequestOf(7), Payload = new byte[10] });
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return resolver.Answer(0, new byte[11]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
    }

    [Fact]
    public async Task Holds_the_router_s_limit_where_a_procedure_s_is_larger()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumPayloadBytes = 10 });

        server.Resolve(maximumPayloadBytes: 100);
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[11] });
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, server.Sent[^1].Failure!.Code);
        Assert.Equal("a payload is 10 bytes at most, not 11", server.Sent[^1].Failure!.Detail);
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = 1 }, Payload = new byte[11] }, Handle)
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
    }

    [Fact]
    public async Task Refuses_a_limit_below_1_drawing_nothing_and_takes_its_edge()
    {
        var client = new Peer(RouterSide.Client);
        var drawn = new List<uint>();

        CoreRequest Drawing(CoreRequest request)
        {
            return request with { OnCallId = drawn.Add };
        }

        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Core.Request(new byte[] { 1 }, Drawing(CallOf(Handle, (Echo with { MaximumPayloadBytes = 0 }, TimeSpan.FromSeconds(5)))));
        });
        Assert.Empty(drawn);
        _ = client.Core.Request(new byte[] { 1 }, Drawing(CallOf(Handle, (Echo with { MaximumPayloadBytes = 1 }, TimeSpan.FromSeconds(5)))));
        await client.Settle();
        Assert.Equal([1u], drawn);
    }

    [Fact]
    public async Task Sends_a_payload_in_one_envelope_to_its_limit_and_one_byte_more_as_a_transfer()
    {
        var small = RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64 };
        var client = new Peer(RouterSide.Client, small);

        _ = client.Request(new byte[52], TimeSpan.FromSeconds(5));
        _ = client.Request(new byte[53], TimeSpan.FromSeconds(5));
        await client.Settle();
        Assert.Equal([null, 53L], client.Sent.Select((envelope) =>
        {
            return ((RequestHeader)envelope.Header).Total;
        }));

        // a result's room counts the 20 bytes of the announcement it may carry
        var server = new Peer(RouterSide.Server, small);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = RequestOf(3), Payload = new byte[] { 1 } });
        await resolver.Answer(0, new byte[36]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        _ = resolver.Answer(1, new byte[37]);
        await server.Settle();
        Assert.Equal([null, 37L], server.Sent.Select((envelope) =>
        {
            return ((ResultHeader)envelope.Header).Total;
        }));
    }
}
