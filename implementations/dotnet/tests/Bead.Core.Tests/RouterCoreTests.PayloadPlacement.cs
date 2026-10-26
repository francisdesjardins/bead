namespace Bead.Tests;

/// <summary>
/// How <see cref="RouterCore"/> places a payload: whole or as a transfer, within a procedure's
/// limit and the router's.
/// </summary>
public sealed partial class RouterCoreTests
{
    // spec 12.3.2
    [Fact]
    public async Task Holds_a_procedure_s_payloads_to_its_own_limit_within_the_router_s_both_ways_once_admitted()
    {
        var server = new Peer(RouterSide.Server);
        var small = Echo with { MaximumPayloadBytes = 8 };
        var resolver = server.Resolve(maximumPayloadBytes: 8);

        Task<RouterResult> Ask(int length)
        {
            return server.Core.Request(new byte[length], CallOf(Handle, (small, TimeSpan.FromSeconds(1))));
        }

        server.Core.RegisterResolver(new Held(server.Core)
        {
            Procedure = Echo with { ProcedureId = 7, ProcedureName = "refusing" },
            MaximumPayloadBytes = 8,
            Admission = (_) =>
            {
                return Failure.OfProtocol(ProtocolCode.AccessDenied);
            },
        });

        // sent: past the procedure's limit, nothing goes
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Ask(9).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"), (refused.Code, refused.Detail));

        // received: whole, or as a transfer on its total; admitted first
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[9] });
        await server.Deliver(new Envelope { Header = RequestOf(3) with { Total = 9 }, Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = RequestOf(5) with { ProcedureId = 7 }, Payload = new byte[9] });
        await server.Deliver(new Envelope { Header = RequestOf(7), Payload = new byte[8] });

        // answered: past the procedure's limit, nothing goes
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return resolver.Answer(0, new byte[9]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);

        // a result's transfer past the procedure's limit ends its call
        var asking = Ask(8);

        await server.Settle();

        // its call id the next drawn: the call refused above drew one
        await server.Deliver(ResultOpeningOf(4, (new byte[9], 1)));

        var ended = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"), (ended.Code, ended.Detail));
        Assert.Equal(
            [7u],
            resolver.Requests.Select((props) =>
            {
                return props.Header.CallId;
            }));
        Assert.Equal(
            [
                (EnvelopeKind.Failure, 1u, (ushort?)ProtocolCode.PayloadTooLarge), (EnvelopeKind.Failure, 3u, (ushort?)ProtocolCode.PayloadTooLarge),
                (EnvelopeKind.Failure, 5u, (ushort?)ProtocolCode.AccessDenied), (EnvelopeKind.Request, 4u, null), (EnvelopeKind.Cancel, 4u, null),
            ],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Kind, envelope.Header.CallId, envelope.Failure?.Code);
            }));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Holds_a_procedure_whose_own_limit_is_larger_to_the_router_s_both_ways()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumPayloadBytes = 40 });
        var wide = Echo with { MaximumPayloadBytes = 1_024 };
        var resolver = server.Resolve(maximumPayloadBytes: 1_024);

        // whole, within its envelope, past the router's limit
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[45] });

        // past an envelope: it would go as a transfer, whose envelopes each pass
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return server.Core.Request(PatternOf(200), CallOf(Handle, (wide, TimeSpan.FromSeconds(1)))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 40 bytes at most, not 200"), (refused.Code, refused.Detail));
        Assert.Empty(resolver.Requests);
        Assert.Equal(
            (1u, (ushort)ProtocolCode.PayloadTooLarge, "a payload is 40 bytes at most, not 45"),
            (Assert.Single(server.Sent).Header.CallId, server.Sent[0].Failure!.Code, server.Sent[0].Failure!.Detail));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Refuses_a_procedure_s_limit_that_is_not_a_whole_number_above_0_drawing_nothing_and_takes_its_edge()
    {
        var server = new Peer(RouterSide.Server);
        var drawn = new List<uint>();

        CoreRequest Drawing(CoreRequest request)
        {
            return request with { OnCallId = drawn.Add };
        }

        // * an int holds no fraction, nor a NaN: what remains is 0 and below
        foreach (var maximumPayloadBytes in new[] { 0, -1 })
        {
            var registering = Assert.Throws<ArgumentException>(() =>
            {
                server.Core.RegisterResolver(new Held(server.Core) { MaximumPayloadBytes = maximumPayloadBytes });
            });

            Assert.Contains("echo's payload limit is a whole number above 0", registering.Message, StringComparison.Ordinal);

            var asking = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return server.Core.Request(new byte[] { 1 }, Drawing(CallOf(Handle, (Echo with { MaximumPayloadBytes = maximumPayloadBytes }, TimeSpan.FromSeconds(1)))));
            });

            Assert.StartsWith($"a payload's limit is a whole number above 0, not {maximumPayloadBytes}", asking.Message, StringComparison.Ordinal);
        }

        Assert.Empty(drawn);
        Assert.Empty(server.Sent);

        // at its edge, a limit of 1 is taken
        server.Core.RegisterResolver(new Held(server.Core) { MaximumPayloadBytes = 1 });
        _ = server.Core.Request(new byte[] { 1 }, Drawing(CallOf(Handle, (Echo with { MaximumPayloadBytes = 1 }, TimeSpan.FromSeconds(1)))));
        await server.Settle();
        Assert.Equal([2u], drawn);
    }

    [Fact]
    public async Task Sends_a_payload_in_one_envelope_to_its_limit_and_one_byte_more_as_a_transfer_or_not_at_all_where_none_is_sent()
    {
        // a request's header takes 12 bytes; a result's 8, and 20 more for an announcement it may carry
        var small = RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64 };
        var server = new Peer(RouterSide.Server, small);
        var resolver = server.Resolve();

        _ = server.Request(new byte[52], TimeSpan.FromSeconds(5));
        _ = server.Request(new byte[53], TimeSpan.FromSeconds(5));
        await server.Deliver(new Envelope { Header = RequestOf(1) });
        await server.Deliver(new Envelope { Header = RequestOf(3) });
        _ = resolver.Answer(0, new byte[36]);
        _ = resolver.Answer(1, new byte[37]);
        await server.Settle();
        Assert.Equal(
            [(EnvelopeKind.Request, 2u, null, 52), (EnvelopeKind.Request, 4u, 53L, 44), (EnvelopeKind.Result, 1u, null, 36), (EnvelopeKind.Result, 3u, 37L, 28)],
            server.Sent.Select((envelope) =>
            {
                var total = envelope.Header is RequestHeader request ? request.Total : ((ResultHeader)envelope.Header).Total;

                return (envelope.Kind, envelope.Header.CallId, total, envelope.Payload.Length);
            }));

        var none = new Peer(RouterSide.Server, small with { MaximumTransfers = 0 });
        var noneResolver = none.Resolve();

        await none.Deliver(new Envelope { Header = RequestOf(1) });

        var asked = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return none.Request(new byte[53], TimeSpan.FromSeconds(5)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.PayloadTooLarge, "a payload of 53 bytes goes as a transfer, which this side sends none of"),
            (asked.Code, asked.Detail));
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return noneResolver.Answer(0, new byte[37]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        Assert.Empty(none.Sent);
    }
}
