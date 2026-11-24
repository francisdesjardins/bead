using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s own calls: their request, their call id and its cancel, their
/// answer and its result in a transfer, their timers, and what they count.
/// </summary>
public sealed partial class RouterCoreTests
{
    [Fact]
    public async Task Sends_a_call_on_a_call_id_of_its_side_settles_it_with_the_answer_paired_to_it_and_hands_its_port_an_answer_no_call_waits_on()
    {
        var peer = new Peer(RouterSide.Server);
        using var core = peer.Core;
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));
        var id = await peer.CallIdOf(asked);
        var unpaired = new Envelope { Header = new FailureHeader { CallId = id + 2 }, Failure = Failure.OfProtocol(ProtocolCode.ProcedureFailed) };

        Assert.Equal(0u, id % 2);
        Assert.Equal(1, core.Gauges().Counts["pendingCalls"]);
        Assert.Equal([Handle], peer.SentOn);
        await peer.Deliver(unpaired);
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(peer.Reports)));
        Assert.Equal(1, core.Gauges().Counts["pendingCalls"]);
        core.Reserve(new CallAddress(id + 2, Handle), TimeSpan.FromMilliseconds(30));
        await peer.Deliver(unpaired);
        Assert.Single(peer.Reports);
        Assert.Equal(1, core.Gauges().Counts["reservedCallIds"]);
        await peer.Advance(TimeSpan.FromMilliseconds(30));
        Assert.Equal(0, core.Gauges().Counts["reservedCallIds"]);
        await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = id }, Payload = new byte[] { 7 } });
        Assert.Equal(new byte[] { 7 }, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
        await peer.Deliver(ResultOf(id));
        Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], peer.Reports.Select(CodeOf));
        Assert.Equal([Handle, Handle], peer.ReportedOn);
        Assert.Equal(0, core.Gauges().Counts["pendingCalls"]);
    }

    // a requester's clock keeps every timer and its disposal, as the TypeScript clock does
    internal sealed class RequesterClock : FakeTimeProvider
    {
        public List<RequesterTimer> Armed { get; } = [];

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new RequesterTimer(base.CreateTimer(callback, state, dueTime, period), dueTime);

            Armed.Add(timer);

            return timer;
        }
    }

    internal sealed class RequesterTimer(ITimer timer, TimeSpan delay) : ITimer
    {
        public TimeSpan Delay { get; } = delay;

        public bool IsCleared { get; private set; }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            return timer.Change(dueTime, period);
        }

        public void Dispose()
        {
            IsCleared = true;
            timer.Dispose();
        }

        public ValueTask DisposeAsync()
        {
            IsCleared = true;

            return timer.DisposeAsync();
        }
    }

    // a server's outgoing calls, with recorded timers and a peer the test drives
    private sealed class RequesterPeer : IRouterCorePort
    {
        public RequesterPeer(RouterLimits limits, RouterSide side = RouterSide.Server)
        {
            Side = side;
            Core = new RouterCore(this, new RouterCoreOptions
            {
                Clock = Clock,
                Limits = limits,
                ResolverScheduler = Loop,
                Scheduler = Loop,
            });
        }

        public RouterSide Side { get; }

        public RequesterClock Clock { get; } = new();

        public SerialScheduler Loop { get; } = new();

        public RouterCore Core { get; }

        public List<Envelope> Sent { get; } = [];

        public List<Exception> Reports { get; } = [];

        public Func<Envelope, Task>? OnSend { get; set; }

        public void Report(Exception reason, string? connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var envelope = EnvelopeCodec.ReadEnvelope(message.Bytes.Span,
                new EnvelopeReadOptions { Side = CallIds.PeerOf(Side), MaximumEnvelopeBytes = int.MaxValue })!;

            Sent.Add(envelope);

            return OnSend?.Invoke(envelope) ?? Task.CompletedTask;
        }

        public Task<RouterResult> Request(byte[] payload, ResolvedRequestOptions options)
        {
            return Core.Request(payload, new CoreRequest
            {
                ConnectionHandle = Handle,
                Options = options,
                Procedure = Echo,
            });
        }

        // a resolver of echo that holds each request it is handed, for the test to answer
        public Held Resolve()
        {
            var resolver = new Held(Core);

            Core.RegisterResolver(resolver);

            return resolver;
        }

        public async Task Deliver(Envelope envelope)
        {
            Core.Receive(EnvelopeCodec.WriteEnvelope(envelope), Handle);
            await Settle();
        }

        public async Task Advance(TimeSpan elapsed)
        {
            Clock.Advance(elapsed);
            await Settle();
        }

        public async Task Settle()
        {
            for (var round = 0; round < 3; round += 1)
            {
                await Loop.WhenIdle();
            }
        }
    }

    // a requester's limits: envelopes of 64 bytes, a payload and a budget of 1,024 bytes
    private static RouterLimits RequesterLimits
    {
        get
        {
            return Chunked with { BufferedBytesBudget = 1_024, MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024 };
        }
    }

    private static byte[] RequesterBytesOf(int length)
    {
        return [.. Enumerable.Range(0, length).Select((index) =>
        {
            return (byte)(((index * 7) + 3) % 256);
        })];
    }

    [Fact]
    public async Task Sends_its_requests_on_a_call_id_of_its_side_naming_their_procedure_and_nothing_of_a_session()
    {
        foreach (var side in new[] { RouterSide.Client, RouterSide.Server })
        {
            var callId = side == RouterSide.Client ? 1u : 2u;
            var payload = side == RouterSide.Client ? new byte[] { 1 } : new byte[] { 1, 2, 3 };
            var client = new Peer(side)
            {
                TokenOf = (_) =>
                {
                    throw new InvalidOperationException("a request asks no session");
                },
            };
            var heard = new List<string>();

            client.OnSend = (envelope) =>
            {
                heard.Add($"sent {envelope.Header.CallId}");

                return Task.CompletedTask;
            };

            var asked = client.Core.Request(payload, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
            {
                OnCallId = (callId) =>
                {
                    heard.Add($"call id {callId}");
                    Assert.Empty(client.Sent);
                },
            });

            await client.Settle();
            Assert.Equal([$"call id {callId}", $"sent {callId}"], heard);
            Assert.Equal(RequestOf(callId), Assert.Single(client.Sent).Header);
            Assert.Equal(payload, client.Sent[0].Payload.ToArray());
            Assert.Equal((DebugDirection.Tx, RequestOf(callId)), (Assert.Single(client.Traces).Direction, client.Traces[0].Envelope.Header));
            Assert.Equal([RouterActivity.Request], client.Activities);
            var result = side == RouterSide.Client ? new byte[] { 1 } : new byte[] { 9 };
            await client.Deliver(new Envelope { Header = new ResultHeader { CallId = callId }, Payload = result });
            var answered = await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            Assert.Equal(new ResultHeader { CallId = callId }, answered.Header);
            Assert.Equal(result, answered.Payload.ToArray());
            Assert.Equal([RouterActivity.Request, RouterActivity.Response], client.Activities);
            Assert.Empty(client.Reports);
        }
    }

    [Fact]
    public async Task Fails_before_it_goes_a_call_past_the_calls_its_peer_answers_at_once_and_sends_one_once_a_call_is_answered()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { MaximumAnsweringCalls = 2 });
        var drawn = new List<uint>();

        Task<RouterResult> Request(string connectionHandle)
        {
            return server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf(connectionHandle, (Echo, TimeSpan.FromSeconds(5))) with { OnCallId = drawn.Add });
        }

        var first = Request("a");
        var second = Request("a");

        // another connection's calls are its own
        var other = Request("b");

        await server.Settle();

        // past them, it fails at once, drawing no call id and sending nothing
        var failed = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Request("a").WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.CapacityExceeded, "the calls waiting on a are 2 at most", FailureOrigin.Local, RouterSide.Server),
            (failed.Code, failed.Detail, failed.Origin, failed.Side));
        Assert.Equal([2u, 4u, 6u], drawn);
        Assert.Equal(3, server.Sent.Count);

        // answered, a call gives its place back in the turn its answer came: the call made right
        // behind it, before anything settles, goes
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(ResultOf(2)), "a");

        var third = Request("a");

        await first.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Settle();
        Assert.Equal([2u, 4u, 6u, 8u], drawn);
        Assert.Equal(
            [("a", 2u), ("a", 4u), ("b", 6u), ("a", 8u)],
            server.SentOn.Zip(server.Sent, (connectionHandle, envelope) =>
            {
                return (connectionHandle, envelope.Header.CallId);
            }));
        server.Core.RejectPending("all gone");
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Task.WhenAll(second, other, third).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Write_the_destination_they_name_and_none_left_out()
    {
        var client = new Peer(RouterSide.Client);

        _ = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
        {
            Options = new ResolvedRequestOptions { DestinationId = 7, Timeout = TimeSpan.FromSeconds(5) },
        });
        _ = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));
        await client.Settle();
        Assert.Equal([7u, null], client.Sent.Select((envelope) =>
        {
            return ((RequestHeader)envelope.Header).DestinationId;
        }));
    }

    [Fact]
    public async Task Pairs_its_requests_by_call_id_alone_on_their_own_connection_once()
    {
        var server = new Peer(RouterSide.Server);
        var command = server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf("a", (Echo, TimeSpan.FromSeconds(5))) with { Options = new ResolvedRequestOptions { DestinationId = 3, Timeout = TimeSpan.FromSeconds(1) } });

        await server.Settle();
        await server.Deliver(ResultOf(2), "b");
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(server.Reports)));
        Assert.False(command.IsCompleted);
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = 2 }, Payload = new byte[] { 9 } }), "a");

        // the same response again, in the same read, before anything waiting on the first has run
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(ResultOf(2)), "a");
        await server.Settle();
        Assert.Equal(new byte[] { 9 }, (await command.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
        Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], server.Reports.Select(CodeOf));
        Assert.Equal(["b", "a"], server.ReportedOn);
        Assert.Equal([RouterActivity.Request, RouterActivity.Response], server.Activities);
        Assert.Equal([(2u, "b"), (2u, "a"), (2u, "a")], server.AnswersReceived);
    }

    [Fact]
    public async Task Offers_the_side_a_failure_that_answers_no_call_waiting_and_never_a_result()
    {
        foreach (var clientCallId in new[] { 3u, 7u })
        {
            var offered = new List<uint>();
            var client = new Peer(RouterSide.Client)
            {
                Unpaired = (envelope) =>
                {
                    offered.Add(envelope.Header.CallId);

                    return true;
                },
            };

            await client.Deliver(new Envelope { Header = new FailureHeader { CallId = clientCallId }, Failure = Failure.OfApplication(9) });
            Assert.Empty(client.Reports);
            await client.Deliver(ResultOf(7));
            Assert.Equal([clientCallId], offered);
            Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));

            var takes = true;
            var received = new List<(uint, ushort)>();
            var server = new Peer(RouterSide.Server) { Unpaired = (envelope) => { received.Add((envelope.Header.CallId, envelope.Failure!.Code)); return takes; } };
            await server.Deliver(new Envelope { Header = new FailureHeader { CallId = 3 }, Failure = Failure.OfProtocol(ProtocolCode.SessionRequired) }, "a");
            takes = false;
            await server.Deliver(new Envelope { Header = new FailureHeader { CallId = 5 }, Failure = Failure.OfProtocol(ProtocolCode.SessionRequired) }, "a");
            await server.Deliver(ResultOf(7), "a");
            Assert.Equal([(3u, (ushort)32), (5u, (ushort)32)], received);
            Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], server.Reports.Select(CodeOf));
            Assert.Equal(["a", "a"], server.ReportedOn);
            var bare = new Peer(RouterSide.Server);
            await bare.Deliver(new Envelope { Header = new FailureHeader { CallId = 3 }, Failure = Failure.OfProtocol(ProtocolCode.SessionRequired) }, "a");
            Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(bare.Reports)));
            Assert.Equal(["a"], bare.ReportedOn);
        }
    }

    // spec 12.3.2
    [Fact]
    public async Task Rejects_a_result_whose_transfer_is_past_the_payload_s_limit_and_cancels_its_call()
    {
        foreach (var requestLength in new[] { 0, 1 })
        {
            var client = new Peer(RouterSide.Client);
            var asked = client.Core.Request(new byte[requestLength], CallOf(Handle, (Echo with { MaximumPayloadBytes = 100 }, TimeSpan.FromSeconds(5))));

            await client.Settle();
            await client.Deliver(ResultOpeningOf(1, (PatternOf(300), 32)));

            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Local), (refused.Code, refused.Origin));
            Assert.IsType<CancelHeader>(client.Sent[^1].Header);
            Assert.Empty(CreditsOf(client.Sent));
            Assert.Equal("a payload is 100 bytes at most, not 300", refused.Detail);
            Assert.Equal(RouterSide.Client, refused.Side);
            Assert.Equal(new IEnvelopeHeader[] { RequestOf(1), new CancelHeader { CallId = 1 } }, client.Sent.Select((envelope) => { return envelope.Header; }));

            var server = new Peer(RouterSide.Server);
            using var serverCore = server.Core;
            var answering = server.Request(new byte[requestLength], TimeSpan.FromSeconds(1));
            await server.Deliver(new Envelope { Header = new ResultHeader { CallId = 2, Total = 16_777_217 } });
            var global = await Assert.ThrowsAsync<FailureException>(() => { return answering.WaitAsync(Patience, TestContext.Current.CancellationToken); });
            Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Local, RouterSide.Server, "a payload is 16777216 bytes at most, not 16777217"), (global.Code, global.Origin, global.Side, global.Detail));
            Assert.Equal(new IEnvelopeHeader[] { RequestOf(2), new CancelHeader { CallId = 2 } }, server.Sent.Select((envelope) => { return envelope.Header; }));
        }
    }

    // spec 12.3, 12.7
    [Fact]
    public async Task Reject_a_result_whose_opening_carries_other_than_its_sender_places_in_it_chunk_invalid_and_cancel_its_call()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (PatternOf(300), 27)));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.ChunkInvalid, FailureOrigin.Local, (RouterSide?)RouterSide.Client, "an opening carries 28 bytes of its payload, not 27"),
            (refused.Code, refused.Origin, refused.Side, refused.Detail));
        Assert.Equal(EnvelopeKind.Result, refused.Header?.Kind);
        Assert.Empty(CreditsOf(client.Sent));
        Assert.Equal(new IEnvelopeHeader[] { RequestOf(1), new CancelHeader { CallId = 1 } }, client.Sent.Select((envelope) => { return envelope.Header; }));
    }

    // spec 8.2, 12.4
    [Fact]
    public async Task End_a_call_whose_result_s_transfer_waits_for_the_budget_past_half_its_inactivity_capacity_exceeded_and_cancel_it()
    {
        var client = new Peer(RouterSide.Client, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256, TransferInactivityTimeout = TimeSpan.FromSeconds(20) });
        var holding = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(60));

        // the first result's total holds the budget but 56 bytes
        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (PatternOf(200), 28)));

        // the second's waits for it, its call held by its wait alone: its own 5 s end nothing
        var waiting = client.Request(new byte[] { 2 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(3, (PatternOf(100), 28)));
        await client.Advance(TimeSpan.FromMilliseconds(9_999));
        Assert.False(waiting.IsCompleted);
        await client.Advance(TimeSpan.FromMilliseconds(1));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.CapacityExceeded, FailureOrigin.Local, (RouterSide?)RouterSide.Client, "a total of 100 bytes waited 10000 milliseconds for the budget"),
            (refused.Code, refused.Origin, refused.Side, refused.Detail));
        Assert.Equal(EnvelopeKind.Result, refused.Header?.Kind);
        Assert.Equal([156L], CreditsOf(client.Sent));
        Assert.Equal(new CancelHeader { CallId = 3 }, client.Sent[^1].Header);
        Assert.False(holding.IsCompleted);
    }

    // spec 12.4, 12.8
    [Fact]
    public async Task Credit_a_result_s_transfer_once_the_budget_admits_it_setting_its_call_s_inactivity_going_again()
    {
        var client = new Peer(RouterSide.Client, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256, TransferInactivityTimeout = TimeSpan.FromSeconds(20) });
        using var cancelling = new CancellationTokenSource();
        var holding = client.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(60), cancelling.Token));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (PatternOf(200), 28)));

        var waiting = client.Request(new byte[] { 2 }, TimeSpan.FromSeconds(60));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(3, (PatternOf(100), 28)));
        await client.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal([156L], CreditsOf(client.Sent));

        // the first call cancelled, its budget admits the second's transfer, credited as it is
        await cancelling.CancelAsync();
        await client.Settle();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return holding.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal([156L, 100L], CreditsOf(client.Sent));
        Assert.Contains(client.Sent, (envelope) => { return new CreditHeader { CallId = 3, CreditEnd = 100 }.Equals(envelope.Header); });

        // its inactivity counted from that credit, past the 20 s from its opening
        await client.Advance(TimeSpan.FromMilliseconds(19_999));
        Assert.False(waiting.IsCompleted);
        await client.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal("no answer came in 20000 milliseconds", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);
    }

    [Fact]
    public async Task Are_rejected_with_a_disconnect_error_those_of_one_connection_or_all()
    {
        var client = new Peer(RouterSide.Client);
        var gone = client.Core.Request(new byte[] { 1 }, CallOf("a", (Echo, TimeSpan.FromSeconds(5))));
        var kept = client.Core.Request(new byte[] { 1 }, CallOf("b", (Echo, TimeSpan.FromSeconds(5))));
        var keptAgain = client.Core.Request(new byte[] { 1 }, CallOf("b", (Echo, TimeSpan.FromSeconds(5))));

        await client.Settle();
        client.Core.RejectPending("a closed", "a");
        Assert.Equal("a closed", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return gone.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);
        await client.Deliver(ResultOf(3), "b");
        await kept.WaitAsync(Patience, TestContext.Current.CancellationToken);

        // then those of every connection
        client.Core.RejectPending("all gone");
        Assert.Equal("all gone", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return keptAgain.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);
    }

    [Fact]
    public async Task This_side_presents_is_the_one_its_side_resolved_and_one_that_leaves_a_transfers_opening_no_byte_fails_it_before_it_goes_payload_too_large()
    {
        var client = new Peer(RouterSide.Client);
        var known = SessionToken.FromBytes(PatternOf(16));

        // OPAQUE while its side knows no session fails before it goes, and draws nothing
        var unknown = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Opaque())).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        await client.Settle();
        Assert.Equal(
            ((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local, (RouterSide?)RouterSide.Client),
            (unknown.Code, unknown.Origin, unknown.Side));
        Assert.Empty(client.Sent);

        client.Session = known;
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Opaque()));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.None));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(null));
        _ = client.Core.Request(new byte[] { 1 }, PresentingCallOf(Credential.Jwt("a.b.c")));
        await client.Settle();
        Assert.Equal(
            [(1u, Credential.Opaque(known)), (3u, null), (5u, null), (7u, Credential.Jwt("a.b.c"))],
            client.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, ((RequestHeader)envelope.Header).Credential);
            }));

        // a JWT of 40 characters: a header of 56 bytes, and 64 with a transfer's total — 8 bytes go
        // whole, and 9 would leave the opening none
        var long40 = Credential.Jwt(new string('a', 40));

        _ = client.Core.Request(PatternOf(8), PresentingCallOf(long40));

        var tooLarge = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Core.Request(PatternOf(9), PresentingCallOf(long40)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        await client.Settle();
        Assert.Equal(
            (
                (ushort)ProtocolCode.PayloadTooLarge,
                "a payload of 9 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64",
                FailureOrigin.Local,
                (RouterSide?)RouterSide.Client),
            (tooLarge.Code, tooLarge.Detail, tooLarge.Origin, tooLarge.Side));
        // the header thrown keeps its credential's scheme alone, never its token
        Assert.Equal(Credential.SchemeOf(CredentialScheme.Jwt), Assert.IsType<RequestHeader>(tooLarge.Header).Credential);
        Assert.Null(((RequestHeader)tooLarge.Header!).Credential!.Value.Token);
        Assert.Equal(5, client.Sent.Count);
        Assert.Equal(long40, ((RequestHeader)client.Sent[4].Header).Credential);

        var server = new Peer(RouterSide.Server, Chunked with { MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024, BufferedBytesBudget = 1_024 });
        using var serverCore = server.Core;
        server.Session = SessionToken.FromBytes(Enumerable.Repeat((byte)1, 16).ToArray());
        var first = serverCore.Request(RequesterBytesOf(100), PresentingCallOf(Credential.Jwt(new string('x', 36))) with { Options = new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1), Credential = Credential.Jwt(new string('x', 36)) } });
        var noRoom = await Assert.ThrowsAsync<FailureException>(() => { return serverCore.Request(RequesterBytesOf(100), PresentingCallOf(Credential.Jwt(new string('x', 40)))).WaitAsync(Patience, TestContext.Current.CancellationToken); });
        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload of 100 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64", FailureOrigin.Local, Echo.Address), (noRoom.Code, noRoom.Detail, noRoom.Origin, noRoom.ProcedureAddress));
        var whole = serverCore.Request(new byte[] { 1 }, PresentingCallOf(Credential.Opaque()));
        await server.Settle();
        Assert.Equal([(2u, Credential.Jwt(new string('x', 36)), 4), (6u, Credential.Opaque(server.Session!.Value), 1)], server.Sent.Select((envelope) => { return (envelope.Header.CallId, ((RequestHeader)envelope.Header).Credential, envelope.Payload.Length); }));
        serverCore.RejectPending("done", Handle);
        await Assert.ThrowsAsync<DisconnectException>(() => { return Task.WhenAll(first, whole).WaitAsync(Patience, TestContext.Current.CancellationToken); });
    }

    [Fact]
    public async Task A_jwt_its_header_holds_whole_fails_its_call_before_it_goes_payload_too_large_once_a_transfers_header_would_pass_1_020_bytes_and_goes_as_a_transfer_a_word_shorter()
    {
        // the default limits: a payload of 1 MiB passes an envelope of chunkBytes whole
        var client = new Peer(RouterSide.Client, RouterLimits.Default);
        var payload = PatternOf(1_048_576);

        Task<RouterResult> Ask(int length, (uint? DestinationId, byte[] Payload) asked)
        {
            var call = PresentingCallOf(Credential.Jwt(new string('x', length)));

            return client.Core.Request(asked.Payload, call with { Options = call.Options with { DestinationId = asked.DestinationId } });
        }

        // 12 bytes of header, 4 of destination, 8 of total, 4 of the credential's head, its token
        // padded to 4: an opening's header holds 996 bytes of token, 992 beside a destination
        foreach (var (length, destinationId, opening) in new (int, uint?, int)[] { (1_004, null, 1_028), (997, null, 1_024), (1_000, 7, 1_028), (993, 7, 1_024) })
        {
            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return Ask(length, (destinationId, payload)).WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal(
                (
                    (ushort)ProtocolCode.PayloadTooLarge,
                    $"a payload of 1048576 bytes goes as a transfer, whose opening's header of {opening} bytes passes 1020",
                    FailureOrigin.Local,
                    (RouterSide?)RouterSide.Client),
                (refused.Code, refused.Detail, refused.Origin, refused.Side));
        }

        await client.Settle();
        Assert.Empty(client.Sent);

        _ = Ask(996, (null, payload));
        _ = Ask(992, (7, payload));

        // a payload its header leaves room for goes whole
        _ = Ask(1_004, (null, new byte[] { 1 }));
        await client.Settle();
        Assert.Equal(
            [(996, null, 1_048_576L, 1_047_556), (992, 7u, 1_048_576L, 1_047_556), (1_004, null, null, 1)],
            client.Sent.Select((envelope) =>
            {
                var header = (RequestHeader)envelope.Header;

                return (header.Credential!.Value.Token!.Length, header.DestinationId, header.Total, envelope.Payload.Length);
            }));
        client.Core.RejectPending("done", Handle);
    }

    [Fact]
    public async Task Hear_their_request_handed_to_the_transport_whole_or_its_transfers_opening_then_refused_by_it_and_nothing_of_one_never_handed()
    {
        var client = new Peer(RouterSide.Client, Chunked with { MaximumPayloadBytes = 1_024 });
        var closed = new IOException("the socket is closed");
        var closing = new IOException("the transport is closing");
        var heard = new List<string>();
        var held = new List<TaskCompletionSource>();

        Task<RouterResult> Ask(int length, string connectionHandle)
        {
            return client.Core.Request(PatternOf(length), CallOf(connectionHandle, (Echo, TimeSpan.FromSeconds(5))) with
            {
                OnSent = (isHanded) =>
                {
                    heard.Add($"{length} {connectionHandle} {isHanded}");
                },
            });
        }

        // a transport that rejects what it is handed for a, later on
        client.OnSend = (_) =>
        {
            var send = new TaskCompletionSource();

            held.Add(send);

            return send.Task;
        };

        List<Task<RouterResult>> refused = [Ask(8, "a"), Ask(200, "a")];

        // heard as it is handed over, before its send settles
        await client.Settle();
        Assert.Equal(["8 a True", "200 a True"], heard);
        foreach (var send in held)
        {
            send.SetException(closed);
        }

        foreach (var asked in refused)
        {
            Assert.Same(closed, await Assert.ThrowsAsync<IOException>(() =>
            {
                return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            }));
        }

        Assert.Equal(["8 a True", "200 a True", "8 a False", "200 a False"], heard);

        // a transport that takes what it is handed for a, and throws as it is handed one for b
        heard.Clear();
        client.OnSend = (_) =>
        {
            if (client.SentOn[^1] == "b")
            {
                throw closing;
            }

            return Task.CompletedTask;
        };

        List<Task<RouterResult>> asking = [Ask(8, "a"), Ask(200, "a"), Ask(2_000, "a"), Ask(8, "b")];

        await client.Settle();
        Assert.Equal(["8 a True", "200 a True"], heard);
        client.Core.Dispose();
        foreach (var asked in asking[..2])
        {
            await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
        }

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asking[2].WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        Assert.Same(closing, await Assert.ThrowsAsync<IOException>(() =>
        {
            return asking[3].WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));

        // one the transport took is not taken back by its call's end
        Assert.Equal(["8 a True", "200 a True"], heard);
    }

    // spec 10.4
    [Fact]
    public async Task Cancel_a_request_that_times_out_before_its_caller_hears_of_it_so_a_call_made_again_goes_out_behind()
    {
        foreach (var side in new[] { RouterSide.Client, RouterSide.Server })
        {
            foreach (var milliseconds in new[] { 20, 1_000 })
            {
                var client = new Peer(side);
                var firstId = side == RouterSide.Client ? 1u : 2u;
                var timeout = TimeSpan.FromMilliseconds(milliseconds);
                var payload = side == RouterSide.Client ? new byte[] { 1 } : Array.Empty<byte>();
                var asked = client.Request(payload, timeout);

                await client.Settle();
                await client.Advance(timeout);
                var first = await Assert.ThrowsAsync<TimeoutException>(() =>
                {
                    return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
                Assert.Equal($"no answer came in {milliseconds} milliseconds", first.Message);
                var retried = client.Request(payload, timeout);
                await client.Settle();
                Assert.Equal([(EnvelopeKind.Request, firstId), (EnvelopeKind.Cancel, firstId), (EnvelopeKind.Request, firstId + 2)], client.Sent.Select((envelope) =>
                {
                    return (envelope.Kind, envelope.Header.CallId);
                }));
                await client.Advance(timeout);
                var second = await Assert.ThrowsAsync<TimeoutException>(() =>
                {
                    return retried.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
                Assert.Equal($"no answer came in {milliseconds} milliseconds", second.Message);
                Assert.Equal([(EnvelopeKind.Request, firstId), (EnvelopeKind.Cancel, firstId), (EnvelopeKind.Request, firstId + 2), (EnvelopeKind.Cancel, firstId + 2)], client.Sent.Select((envelope) =>
                {
                    return (envelope.Kind, envelope.Header.CallId);
                }));
            }
        }
    }

    [Fact]
    public async Task Take_an_answer_too_late_in_silence_while_its_call_id_is_reserved_then_report_it()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(1));

        await client.Settle();
        await client.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await client.Deliver(ResultOf(1));
        Assert.Empty(client.Reports);
        await client.Advance(TimeSpan.FromSeconds(1));
        await client.Deliver(ResultOf(1));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Cancel_a_request_its_signal_gives_up_once_sent_rejecting_with_its_own_reason_though_the_cancel_fails()
    {
        var client = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the cancel");

        using var source = new CancellationTokenSource();

        client.OnSend = (envelope) =>
        {
            return envelope.Header is CancelHeader ? Task.FromException(refused) : Task.CompletedTask;
        };

        var asked = client.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(5), source.Token));

        await client.Settle();
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await client.Settle();
        Assert.Equal(new IEnvelopeHeader[] { RequestOf(1), new CancelHeader { CallId = 1 } }, client.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));
        Assert.Same(refused, Assert.Single(client.Reports));
        Assert.Equal([Handle], client.ReportedOn);
    }

    [Fact]
    public async Task Send_no_cancel_for_a_call_answered_in_the_turn_its_signal_gives_it_up_nor_reserve_its_call_id()
    {
        var client = new Peer(RouterSide.Client);

        using var source = new CancellationTokenSource();
        using var gate = new ManualResetEventSlim();

        var asked = client.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(5), source.Token));

        await client.Settle();

        // the scheduler held, its token is cancelled, then its result comes
        client.Loop.Post(() =>
        {
            gate.Wait(TestContext.Current.CancellationToken);
        });
        await source.CancelAsync();
        client.Core.Receive(EnvelopeCodec.WriteEnvelope(ResultOf(1)), Handle);
        gate.Set();
        await client.Settle();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal([RequestOf(1)], client.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));

        // nothing reserved its call id: the same result again answers no call
        await client.Deliver(ResultOf(1));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Send_no_cancel_for_a_request_the_transport_never_had_though_given_up_at_once_and_reserve_nothing()
    {
        var client = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the request");

        // a transport that refuses what it is given outright: nothing is handed over
        client.OnSend = (_) =>
        {
            throw refused;
        };

        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));

        // ! given up at once, as its call id is drawn, before the transport refuses it: a refusal
        // the transport throws is heard on the core's scheduler in the same step, so this is the
        // one place a call is given up before it — the TypeScript side hears it a microtask later,
        // and gives it up by its signal too
        var cancelled = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
        {
            OnCallId = (callId) =>
            {
                client.Core.Cancel(new CallAddress(callId, Handle));
            },
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return cancelled.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await client.Settle();
        Assert.Equal([RequestOf(1), RequestOf(3)], client.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));

        // neither call id was reserved
        await client.Deliver(ResultOf(1));
        await client.Deliver(ResultOf(3));
        Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], client.Reports.Select(CodeOf));
    }

    // spec 10.4
    [Fact]
    public async Task Cancels_a_call_waiting_once_throwing_and_reserving_its_call_id_on_its_connection_alone()
    {
        foreach (var side in new[] { RouterSide.Server, RouterSide.Client })
        {
            foreach (var requestLength in new[] { 0, 1 })
            {
                var client = new Peer(side);
                var callId = side == RouterSide.Client ? 1u : 2u;
                using var core = client.Core;
                var asked = client.Request(new byte[requestLength], TimeSpan.FromSeconds(5));

                await client.Settle();
                client.Core.Cancel(new CallAddress(callId, Handle));
                client.Core.Cancel(new CallAddress(callId, Handle));
                await client.Settle();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                {
                    return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
                Assert.Single(client.Sent, (envelope) =>
                {
                    return envelope.Header is CancelHeader;
                });
                await client.Deliver(ResultOf(callId));
                Assert.Empty(client.Reports);
                await client.Deliver(ResultOf(callId), "other");
                Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
            }
        }
    }

    [Fact]
    public async Task Reserve_a_call_id_as_long_as_its_call_was_given_or_5s_when_it_was_given_no_time_or_waited_without_end_on_its_clock()
    {
        var recorded = new RequesterPeer(RequesterLimits);
        using var core = recorded.Core;

        foreach (var (callId, timeout) in new (uint, TimeSpan?)[] { (2, null), (4, TimeSpan.FromMilliseconds(250)), (6, Timeout.InfiniteTimeSpan), (8, null) })
        {
            core.Reserve(new CallAddress(callId, Handle), timeout);
        }

        await recorded.Settle();
        Assert.Equal(
            [TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5)],
            recorded.Clock.Armed.Select((timer) =>
            {
                return timer.Delay;
            }));
        await recorded.Advance(TimeSpan.FromMilliseconds(250));

        // 2 reserved still, 4 no more
        await recorded.Deliver(ResultOf(2));
        Assert.Empty(recorded.Reports);
        await recorded.Deliver(ResultOf(4));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(recorded.Reports)));
    }

    [Fact]
    public async Task Reserve_by_connection_and_forget_the_reservations_of_a_connection_or_of_every_one_as_they_go()
    {
        var client = new Peer(RouterSide.Client);

        client.Core.Reserve(new CallAddress(1, "a"), TimeSpan.FromSeconds(5));
        await client.Deliver(ResultOf(1), "b");
        client.Core.Reserve(new CallAddress(1, "b"), TimeSpan.FromSeconds(5));
        client.Core.RejectPending("b closed", "b");
        await client.Settle();
        await client.Deliver(ResultOf(1), "a");
        await client.Deliver(ResultOf(1), "b");
        client.Core.RejectPending("all closed");
        await client.Settle();
        await client.Deliver(ResultOf(1), "a");
        Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], client.Reports.Select(CodeOf));
        Assert.Equal(["b", "b", "a"], client.ReportedOn);
    }

    [Fact]
    public async Task Take_an_answer_of_this_layout_that_does_not_read_on_a_call_id_reserved_in_silence_and_report_one_of_a_layout_to_come()
    {
        var client = new Peer(RouterSide.Client);

        client.Core.Reserve(new CallAddress(1, Handle), TimeSpan.FromSeconds(5));
        await client.Deliver("A1 12 00 02  00 00 00 01 | 00");
        Assert.Empty(client.Reports);
        await client.Deliver("A2 11 00 02  00 00 00 01");
        Assert.Equal((ushort)ProtocolCode.LayoutUnsupported, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Receive_a_result_in_a_transfer_credited_as_it_comes_and_settle_its_call_once_whole()
    {
        foreach (var side in new[] { RouterSide.Client, RouterSide.Server })
        {
            var peer = new Peer(side);
            var callId = side == RouterSide.Client ? 1u : 2u;
            var payload = RequesterBytesOf(300);
            var asked = peer.Request(side == RouterSide.Client ? new byte[] { 1 } : ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(5));

            await peer.Settle();
            await peer.Deliver(ResultOpeningOf(callId, (payload, 28)));
            Assert.Equal([156L], CreditsOf(peer.Sent));

            // in any order; a credit once half a window can go
            foreach (var offset in new[] { 76, 28, 124, 172, 220 })
            {
                await peer.Deliver(ChunkOf(callId, (payload, offset, 48)));
                if (offset == 76) { await peer.Deliver(ChunkOf(callId, (payload, offset, 48))); }
            }

            Assert.Equal([156L, 252L, 300L], CreditsOf(peer.Sent));
            Assert.False(asked.IsCompleted);
            await peer.Deliver(ChunkOf(callId, (payload, 268, 32)));
            await peer.Deliver(ChunkOf(callId, (payload, 268, 32)));

            var result = await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);

            Assert.Equal(payload, result.Payload.ToArray());
            Assert.Equal(300, ((ResultHeader)result.Header).Total);
            Assert.Equal([RouterActivity.Request, RouterActivity.Response], peer.Activities);

            // what its credit let come, a copy, is late, and dropped in silence
            await peer.Deliver(ChunkOf(callId, (payload, 220, 48)));
            Assert.Empty(peer.Reports);
            Assert.Equal(1, peer.Core.Gauges().Counts["reservedCallIds"]);
            Assert.Equal(new IEnvelopeHeader[] { RequestOf(callId), new CreditHeader { CallId = callId, CreditEnd = 156 }, new CreditHeader { CallId = callId, CreditEnd = 252 }, new CreditHeader { CallId = callId, CreditEnd = 300 } }, peer.Sent.Select((envelope) => { return envelope.Header; }));
        }
    }

    [Fact]
    public async Task Rejects_a_result_whose_chunk_breaks_its_transfer_cancels_its_call_and_drops_what_comes_after()
    {
        foreach (var requestLength in new[] { 0, 1 })
        {
            foreach (var total in new[] { 150, 300 })
            {
                var side = total == 150 ? RouterSide.Server : RouterSide.Client;
                var callId = total == 150 ? 2u : 1u;
                var peer = new Peer(side);
                var payload = total == 150 ? new byte[150] : RequesterBytesOf(300);
                var asked = peer.Request(new byte[requestLength], TimeSpan.FromSeconds(total == 150 ? 1 : 5));

                await peer.Settle();
                await peer.Deliver(ResultOpeningOf(callId, (payload, 28)));
                await peer.Deliver(new Envelope { Header = new ChunkHeader { CallId = callId, Offset = 28, IsLast = total == 150 }, Payload = payload.AsMemory(28, total == 150 ? 48 : 20) });

                var invalid = await Assert.ThrowsAsync<FailureException>(() =>
                {
                    return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });

                Assert.Equal((ushort)ProtocolCode.ChunkInvalid, invalid.Code);
                Assert.Equal(FailureOrigin.Local, invalid.Origin);
                Assert.Equal(Echo.Address, invalid.ProcedureAddress);
                Assert.Equal(side, invalid.Side);
                Assert.IsType<CancelHeader>(peer.Sent[^1].Header);
                await peer.Deliver(ChunkOf(callId, (payload, total == 150 ? 76 : 28, 48)));
                Assert.Empty(peer.Reports);
                Assert.Equal(new IEnvelopeHeader[] { RequestOf(callId), new CreditHeader { CallId = callId, CreditEnd = total == 150 ? 150 : 156 }, new CancelHeader { CallId = callId } }, peer.Sent.Select((envelope) => { return envelope.Header; }));
            }
        }
    }

    [Fact]
    public async Task End_a_results_transfer_the_peer_fails_giving_the_budget_back_and_drop_what_comes_after()
    {
        // a budget two transfers share
        var peer = new Peer(RouterSide.Client, Chunked with { BufferedBytesBudget = 200, MaximumPayloadBytes = 200 });
        var payload = PatternOf(200);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 28)));
        await peer.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfProtocol(ProtocolCode.TransferStalled) });

        var stalled = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.TransferStalled, FailureOrigin.Peer), (stalled.Code, stalled.Origin));

        // the peer ended it: no cancel, and what its credit let come is dropped in silence
        await peer.Deliver(ChunkOf(1, (payload, 28, 48)));

        // what the first held of the budget, the second is granted
        var second = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(3, (payload, 28)));
        Assert.Equal(
            new IEnvelopeHeader[]
            {
                RequestOf(1),
                new CreditHeader { CallId = 1, CreditEnd = 156 },
                RequestOf(3),
                new CreditHeader { CallId = 3, CreditEnd = 156 },
            },
            peer.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
        Assert.Empty(peer.Reports);
        peer.Core.Cancel(new CallAddress(3, Handle));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return second.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Reports_a_second_result_on_a_call_whose_result_comes_in_a_transfer_and_goes_on_receiving_it()
    {
        foreach (var requestLength in new[] { 0, 1 })
        {
            foreach (var side in new[] { RouterSide.Client, RouterSide.Server })
            {
                foreach (var total in new[] { 80, 100 })
                {
                    var peer = new Peer(side);
                    var callId = side == RouterSide.Client ? 1u : 2u;
                    var payload = PatternOf(total);
                    var asked = peer.Request(new byte[requestLength], TimeSpan.FromSeconds(side == RouterSide.Client ? 5 : 1));

                    await peer.Settle();
                    await peer.Deliver(ResultOpeningOf(callId, (payload, 28)));
                    await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = callId }, Payload = new byte[] { 9 } });
                    var reported = Assert.IsType<FailureException>(Assert.Single(peer.Reports));
                    Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, reported.Code);
                    Assert.Contains($"call {callId} is answered already, by a transfer", reported.Message, StringComparison.Ordinal);
                    Assert.Equal([Handle], peer.ReportedOn);
                    for (var offset = 28; offset < total; offset += 48)
                    {
                        await peer.Deliver(ChunkOf(callId, (payload, offset, Math.Min(48, total - offset))));
                    }
                    Assert.Equal(payload, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
                }
            }
        }
    }

    [Fact]
    public async Task Reserve_the_call_id_of_a_result_it_received_in_part_as_long_as_the_peer_keeps_its_call_abandoned_or_its_timeout_when_longer()
    {
        foreach (var (ending, timeout, reservation) in new (string, int?, int)[]
        {
            ("whole", 1_000, 4_000),
            ("failure", 1_000, 4_000),
            ("invalid", 1_000, 4_000),
            ("cancel", 1_000, 4_000),
            ("cancel given time", 1_000, 9_000),
            ("signal", 1_000, 4_000),
            ("whole", 9_000, 9_000),
            ("whole", null, 5_000),
        })
        {
            var recorded = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromSeconds(4) });
            using var core = recorded.Core;
            using var cancellation = new CancellationTokenSource();
            var asking = recorded.Request([1], new ResolvedRequestOptions
            {
                CancellationToken = cancellation.Token,
                Timeout = timeout is { } milliseconds ? TimeSpan.FromMilliseconds(milliseconds) : Timeout.InfiniteTimeSpan,
            });

            await recorded.Deliver(ResultOpeningOf(2, (RequesterBytesOf(40), 28)));

            var before = recorded.Clock.Armed.Count;

            if (ending == "whole")
            {
                await recorded.Deliver(new Envelope
                {
                    Header = new ChunkHeader { CallId = 2, IsLast = true, Offset = 28 },
                    Payload = RequesterBytesOf(12),
                });
            }
            else if (ending == "failure")
            {
                await recorded.Deliver(new Envelope { Header = new FailureHeader { CallId = 2 }, Failure = Failure.OfApplication(21) });
            }
            else if (ending == "invalid")
            {
                await recorded.Deliver(new Envelope
                {
                    Header = new ChunkHeader { CallId = 2, IsLast = true, Offset = 28 },
                    Payload = RequesterBytesOf(13),
                });
            }
            else if (ending == "signal")
            {
                await cancellation.CancelAsync();
            }
            else
            {
                core.Cancel(new CallAddress(2, Handle), ending == "cancel given time" ? TimeSpan.FromSeconds(9) : null);
            }
            await recorded.Settle();
            Assert.True(asking.IsCompleted);
            if (ending == "whole")
            {
                var result = await asking.WaitAsync(Patience, TestContext.Current.CancellationToken);

                Assert.Equal(RequesterBytesOf(28).Concat(RequesterBytesOf(12)), result.Payload.ToArray());
            }
            else if (ending is "failure" or "invalid")
            {
                var failure = await Assert.ThrowsAsync<FailureException>(() =>
                {
                    return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });

                Assert.Equal(
                    ending == "failure" ? ((ushort)21, FailureOrigin.Peer) : ((ushort)ProtocolCode.ChunkInvalid, FailureOrigin.Local),
                    (failure.Code, failure.Origin));
            }
            else
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                {
                    return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
            }
            Assert.Equal([TimeSpan.FromMilliseconds(reservation)], recorded.Clock.Armed.Skip(before).Select((timer) =>
            {
                return timer.Delay;
            }));
        }

        // the reserved id stays unavailable until the abandonment interval ends
        var peer = new Peer(RouterSide.Client, Chunked, lastCallId: 3);
        using var peerCore = peer.Core;
        var payload = RequesterBytesOf(300);

        using var source = new CancellationTokenSource();

        var asked = peer.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(1), source.Token));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 28)));
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        // its timeout of 1 s is shorter than the 2 s the peer keeps its call abandoned
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 28, 48)));
        Assert.Empty(peer.Reports);
        Assert.Equal(3u, await peer.CallIdOf(peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5))));
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        await peer.Deliver(ChunkOf(1, (payload, 28, 48)));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, Assert.IsType<FailureException>(Assert.Single(peer.Reports)).Code);
    }

    [Fact]
    public async Task Send_a_request_as_a_transfer_its_opening_the_chunks_each_credit_lets_go_then_wait_on_its_answer()
    {
        foreach (var total in new[] { 200, 300 })
        {
            var side = total == 200 ? RouterSide.Server : RouterSide.Client;
            var callId = total == 200 ? 2u : 1u;
            var peer = new Peer(side);
            var payload = RequesterBytesOf(total);
            var asked = peer.Request(payload, TimeSpan.FromSeconds(5));

            await peer.Settle();

            var opening = Assert.Single(peer.Sent);

            Assert.Equal(new RequestHeader { CallId = callId, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId, Total = total }, opening.Header);
            Assert.Equal(payload[..44], opening.Payload.ToArray());

            // a credit of 172 lets two full chunks go; the third would pass it
            await peer.Deliver(CreditOf(callId, total == 200 ? 140 : 172));
            Assert.Equal([(44L, false), (92L, false)], ChunksOf(peer.Sent));
            Assert.Empty(peer.Activities);
            await peer.Deliver(CreditOf(callId, total));
            List<(long, bool)> expected = total == 200 ? [(44L, false), (92L, false), (140L, false), (188L, true)] : [(44L, false), (92L, false), (140L, false), (188L, false), (236L, false), (284L, true)];
            Assert.Equal(expected, ChunksOf(peer.Sent));
            Assert.Equal(payload[(total == 200 ? 188 : 284)..], peer.Sent[^1].Payload.ToArray());
            Assert.Equal(payload, peer.Sent.SelectMany((envelope) => { return envelope.Payload.ToArray(); }).ToArray());
            Assert.All(peer.Sent, (envelope) => { Assert.True(EnvelopeCodec.WriteEnvelope(envelope).Length <= 64); });
            Assert.Equal([RouterActivity.Request], peer.Activities);

            // whole, it waits on its answer
            var result = total == 200 ? new byte[] { 9 } : new byte[] { 1 };
            await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = callId }, Payload = result });
            Assert.Equal(result, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
            Assert.Empty(peer.Reports);
        }
    }

    [Fact]
    public async Task Stop_a_request_the_peer_answers_or_its_caller_gives_up_and_send_nothing_more_of_it()
    {
        foreach (var (ending, total, timeout, initialCredit, code, side) in new (string, int, int, int?, ushort, RouterSide)[]
        {
            ("failure", 200, 1_000, 92, 21, RouterSide.Server),
            ("cancel", 200, 1_000, 92, 0, RouterSide.Server),
            ("signal", 200, 1_000, 92, 0, RouterSide.Server),
            ("failure", 300, 5_000, 100, 7, RouterSide.Client),
            ("signal", 300, 5_000, null, 0, RouterSide.Client),
        })
        {
            var peer = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromSeconds(30) }, side);
            using var core = peer.Core;
            using var source = new CancellationTokenSource();
            var callId = side == RouterSide.Client ? 1u : 2u;
            var payload = RequesterBytesOf(total);
            var asked = peer.Request(payload, new ResolvedRequestOptions { Timeout = TimeSpan.FromMilliseconds(timeout), CancellationToken = source.Token });

            await peer.Settle();
            if (initialCredit is { } credit)
            {
                await peer.Deliver(CreditOf(callId, credit));
            }
            if (ending == "failure")
            {
                await peer.Deliver(new Envelope { Header = new FailureHeader { CallId = callId }, Failure = Failure.OfApplication(code) });

                var failure = await Assert.ThrowsAsync<FailureException>(() =>
                {
                    return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });

                Assert.Equal((code, FailureOrigin.Peer), (failure.Code, failure.Origin));
            }
            else
            {
                if (ending == "cancel")
                {
                    core.Cancel(new CallAddress(callId, Handle));
                }
                else
                {
                    await source.CancelAsync();
                }
                await peer.Settle();
                Assert.True(asked.IsCompleted);
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                {
                    return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
                Assert.False(TestContext.Current.CancellationToken.IsCancellationRequested);
            }
            await peer.Deliver(CreditOf(callId, total));
            Assert.Equal(total, Assert.IsType<RequestHeader>(peer.Sent[0].Header).Total);
            Assert.Equal(payload[..44], peer.Sent[0].Payload.ToArray());
            Assert.Equal(initialCredit is null ? [] : new[] { (44L, false) }, ChunksOf(peer.Sent));
            Assert.Equal((initialCredit is null ? 1 : 2) + (ending == "failure" ? 0 : 1), peer.Sent.Count);
            if (ending != "failure")
            {
                Assert.Equal(callId, Assert.IsType<CancelHeader>(peer.Sent[^1].Header).CallId);
            }
            Assert.Empty(peer.Reports);
        }
    }

    [Fact]
    public async Task End_a_request_whose_chunk_cannot_go_out_telling_the_peer_to_cancel_it()
    {
        var peer = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the chunk");

        peer.OnSend = (envelope) =>
        {
            return envelope.Header is ChunkHeader ? Task.FromException(refused) : Task.CompletedTask;
        };

        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(CreditOf(1, 300));
        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Single(peer.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });

        // its call id reserved with the cancel: its answer, late, is dropped in silence
        await peer.Deliver(ResultOf(1));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Ends_nothing_more_by_a_chunk_whose_send_failed_behind_its_answer()
    {
        foreach (var serverCredit in new[] { 92, 100 })
        {
            foreach (var side in new[] { RouterSide.Server, RouterSide.Client })
            {
                var peer = new Peer(side);
                using var core = peer.Core;
                var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var callId = side == RouterSide.Client ? 1u : 2u;
                var total = side == RouterSide.Client ? 300 : 200;

                peer.OnSend = (envelope) =>
                {
                    return envelope.Header is ChunkHeader ? held.Task : Task.CompletedTask;
                };

                var asked = peer.Request(PatternOf(total), TimeSpan.FromSeconds(5));

                await peer.Settle();
                await peer.Deliver(CreditOf(callId, side == RouterSide.Client ? 100 : serverCredit));
                Assert.Equal([EnvelopeKind.Request, EnvelopeKind.Chunk], peer.Sent.Select((envelope) => { return envelope.Kind; }));

                if (side == RouterSide.Server)
                {
                    await peer.Deliver(new Envelope { Header = new FailureHeader { CallId = callId }, Failure = Failure.OfApplication(21) });
                    var failure = await Assert.ThrowsAsync<FailureException>(() => { return asked.WaitAsync(Patience, TestContext.Current.CancellationToken); });

                    Assert.Equal(21, failure.Code);
                }
                else
                {
                    await peer.Deliver(ResultOf(callId));
                    Assert.Equal(callId, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Header.CallId);
                }

                held.SetException(new IOException("the transport lost the chunk"));
                await peer.Settle();
                Assert.Equal([EnvelopeKind.Request, EnvelopeKind.Chunk], peer.Sent.Select((envelope) => { return envelope.Kind; }));
                Assert.Equal(new RequestHeader { CallId = callId, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId, Total = total }, peer.Sent[0].Header);
                Assert.Equal(new ChunkHeader { CallId = callId, Offset = 44, IsLast = false }, peer.Sent[1].Header);
                Assert.Equal([44, 48], peer.Sent.Select((envelope) => { return envelope.Payload.Length; }));
                Assert.Empty(peer.Reports);
            }
        }
    }

    [Fact]
    public async Task Wait_on_a_requests_own_timer_the_inactivity_while_it_goes_as_a_transfer_then_its_timeout_for_its_answer()
    {
        var peer = new Peer(RouterSide.Client);
        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(1));

        // past its timeout, short of the transfer's inactivity, which a credit sets going again — one
        // that lets no full chunk go too
        await peer.Settle();
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(CreditOf(1, 80));
        Assert.Empty(ChunksOf(peer.Sent));
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        Assert.False(asked.IsCompleted);

        // its last chunk handed off, its timeout counts afresh
        await peer.Deliver(CreditOf(1, 300));
        await peer.Advance(TimeSpan.FromSeconds(0.9));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.1));
        Assert.True(asked.IsCompleted);
        var timed = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal("no answer came in 1000 milliseconds", timed.Message);
        Assert.IsType<CancelHeader>(peer.Sent[^1].Header);

        var recorded = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        using var recordedCore = recorded.Core;
        var small = recorded.Request([], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        var transfer = recorded.Request(new byte[200], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        await recorded.Deliver(CreditOf(4, 140));
        await recorded.Deliver(CreditOf(4, 200));
        Assert.Equal("1000,250,250,250,250,250,250,1000", string.Join(",", recorded.Clock.Armed.Select((timer) => { return timer.Delay.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture); })));
        await recorded.Advance(TimeSpan.FromSeconds(1));
        Assert.True(small.IsCompleted);
        Assert.True(transfer.IsCompleted);
        foreach (var pending in new[] { small, transfer })
        {
            Assert.Equal("no answer came in 1000 milliseconds", (await Assert.ThrowsAsync<TimeoutException>(() => { return pending.WaitAsync(Patience, TestContext.Current.CancellationToken); })).Message);
        }
        Assert.Equal(new IEnvelopeHeader[] { new CancelHeader { CallId = 2 }, new CancelHeader { CallId = 4 } }, recorded.Sent.TakeLast(2).Select((envelope) => { return envelope.Header; }));
    }

    [Fact]
    public async Task Set_a_calls_timer_going_again_as_the_bytes_of_its_result_come_and_not_for_bytes_it_has()
    {
        var recorded = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        using var recordedCore = recorded.Core;
        var waiting = recorded.Request([], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        var bytes = new byte[150];

        await recorded.Deliver(ResultOpeningOf(2, (bytes, 28)));
        await recorded.Deliver(ChunkOf(2, (bytes, 28, 48)));
        await recorded.Deliver(ChunkOf(2, (bytes, 28, 48)));
        Assert.Equal(
            [TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250)],
            recorded.Clock.Armed.Select((timer) =>
            {
                return timer.Delay;
            }));
        await recorded.Advance(TimeSpan.FromMilliseconds(249));
        Assert.False(waiting.IsCompleted);
        await recorded.Advance(TimeSpan.FromMilliseconds(1));
        Assert.True(waiting.IsCompleted);

        var stalled = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal("no answer came in 250 milliseconds", stalled.Message);
        Assert.Equal(2u, Assert.IsType<CancelHeader>(recorded.Sent[^1].Header).CallId);
        Assert.Empty(recorded.Reports);

        var peer = new Peer(RouterSide.Client);
        using var peerCore = peer.Core;
        var payload = RequesterBytesOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 28)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 28, 48)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));

        // a copy is no progress
        await peer.Deliver(ChunkOf(1, (payload, 28, 48)));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        Assert.True(asked.IsCompleted);

        var timedOut = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal("no answer came in 2000 milliseconds", timedOut.Message);
        Assert.Equal(1u, Assert.IsType<CancelHeader>(peer.Sent[^1].Header).CallId);
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Keep_the_inactivity_of_a_result_that_opens_as_the_last_chunk_of_its_request_goes()
    {
        foreach (var holdLastSend in new[] { false, true })
        {
            var reentrant = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromSeconds(30) });
            using var core = reentrant.Core;
            var handed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var opened = 0;

            reentrant.OnSend = (envelope) =>
            {
                if (envelope.Header is ChunkHeader { IsLast: true })
                {
                    opened += 1;
                    core.Receive(EnvelopeCodec.WriteEnvelope(ResultOpeningOf(2, (RequesterBytesOf(100), 28))), Handle);

                    return holdLastSend ? handed.Task : Task.CompletedTask;
                }

                return Task.CompletedTask;
            };

            var asking = reentrant.Request(RequesterBytesOf(200), new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });

            await reentrant.Deliver(CreditOf(2, 200));
            Assert.Equal(1, opened);
            Assert.Equal([TimeSpan.FromSeconds(30)], reentrant.Clock.Armed.Where((timer) =>
            {
                return !timer.IsCleared;
            }).Select((timer) =>
            {
                return timer.Delay;
            }));
            handed.TrySetResult();
            await reentrant.Settle();
            Assert.Equal([TimeSpan.FromSeconds(30)], reentrant.Clock.Armed.Where((timer) =>
            {
                return !timer.IsCleared;
            }).Select((timer) =>
            {
                return timer.Delay;
            }));
            core.Dispose();
            await reentrant.Settle();
            Assert.True(asking.IsCompleted);
            await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
        }

        // a result that opens before the final credit keeps its inactivity too
        var peer = new Peer(RouterSide.Client);
        using var peerCore = peer.Core;
        var asked = peer.Request(RequesterBytesOf(300), TimeSpan.FromSeconds(1));

        await peer.Settle();
        await peer.Deliver(CreditOf(1, 172));
        await peer.Deliver(ResultOpeningOf(1, (RequesterBytesOf(300), 28)));
        await peer.Deliver(CreditOf(1, 300));
        Assert.True(ChunksOf(peer.Sent)[^1].IsLast);

        // the result's inactivity governs, not the request's timeout
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        Assert.True(asked.IsCompleted);

        var timedOut = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal("no answer came in 2000 milliseconds", timedOut.Message);
        Assert.Equal(1u, Assert.IsType<CancelHeader>(peer.Sent[^1].Header).CallId);
    }

    // debugging 9.3, 9.6.3 and 9.6.4
    [Fact]
    public async Task Counts_a_call_made_refused_before_it_goes_no_call_id_free_or_PAYLOAD_TOO_LARGE_as_started_and_ended_in_the_turn_it_started_and_a_programmer_s_error_or_an_aborted_signal_as_nothing()
    {
        var registry = new MetricsRegistry();
        var port = new CountedPort((RouterSide.Client, registry)) { IsCarrying = false, IsSecureConnection = false, LastCallId = 3 };
        var core = port.Core;
        var series = port.DeclareRequester(Echo);
        var call = CountedCallOf((series, Timeout.InfiniteTimeSpan));

        async Task<Exception> Refused(CoreRequest request, int bytes = 1)
        {
            return await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return core.Request(new byte[bytes], request).WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
        }

        // OPAQUE while its side knows no session; ELSEWHERE over a transport that carries none
        Assert.Equal((ushort)ProtocolCode.SessionRequired, CodeOf(await Refused(call with { Options = call.Options with { Credential = Credential.Opaque() } })));
        Assert.Equal((ushort)ProtocolCode.DestinationUnreachable, CodeOf(await Refused(call with { Options = call.Options with { Credential = Credential.Elsewhere("x") } })));

        // past its procedure's limit; a JWT whose header leaves a transfer's opening no byte
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, CodeOf(await Refused(call with { Procedure = Echo with { MaximumPayloadBytes = 4 } }, 8)));
        port.IsSecureConnection = true;
        Assert.Equal(
            (ushort)ProtocolCode.PayloadTooLarge,
            CodeOf(await Refused(call with { Options = call.Options with { Credential = Credential.Jwt(new string('a', 40)) } }, 9)));

        // a connection not open fails as one that closes
        port.IsConnected = false;
        Assert.IsType<DisconnectException>(await Refused(call));
        port.IsConnected = true;

        // two calls under way hold the two call ids this side draws: a third finds none free
        _ = core.Request(new byte[1], call);
        _ = core.Request(new byte[1], call);
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, CodeOf(await Refused(call)));
        await port.Loop.WhenIdle();

        // each refusal ended in the turn it started, the clock unmoved: in the bucket of 0
        Assert.Equal(
            [
                "bead_client_call_duration_seconds_bucket{le=\"0.0\"} 6",
                "bead_client_call_duration_seconds_count{} 6",
                "bead_client_call_handled_total{outcome=\"failure\",code=\"DESTINATION_UNREACHABLE\"} 1",
                "bead_client_call_handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 1",
                "bead_client_call_handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 2",
                "bead_client_call_handled_total{outcome=\"failure\",code=\"CAPACITY_EXCEEDED\"} 1",
                "bead_client_call_handled_total{outcome=\"closed\"} 1",
                "bead_client_call_started_total{} 8",
            ],
            MadeOf(registry));
        Assert.EndsWith("} 0", SumOf(registry), StringComparison.Ordinal);

        using var aborted = new CancellationTokenSource();

        await aborted.CancelAsync();

        // a programmer's error, and a signal aborted already, each refused before the call starts,
        // ahead of a connection not open: neither is a call
        port.IsConnected = false;
        Assert.IsType<ArgumentOutOfRangeException>(await Refused(call with { Options = call.Options with { Timeout = TimeSpan.Zero } }));
        Assert.IsType<ArgumentException>(await Refused(call with { Procedure = Echo with { MaximumPayloadBytes = 0 } }));

        // a credential no header of its request holds, whatever its payload
        Assert.IsType<ArgumentException>(await Refused(call with { Options = call.Options with { Credential = Credential.Jwt(new string('a', 1_005)) } }));
        Assert.IsType<OperationCanceledException>(await Refused(call with { Options = call.Options with { CancellationToken = aborted.Token } }));
        Assert.Contains("bead_client_call_started_total{} 8", MadeOf(registry));

        var serverRegistry = new MetricsRegistry();
        var server = new CountedPort((RouterSide.Server, serverRegistry)) { LastCallId = 2 };
        var serverCore = server.Core;
        using var cleanup = serverCore;
        var serverCall = CountedCallOf((server.DeclareRequester(Echo), TimeSpan.FromSeconds(1)));
        async Task<Exception> RefusedByServer(CoreRequest request, int bytes = 0)
        {
            return await Assert.ThrowsAnyAsync<Exception>(() => { return serverCore.Request(new byte[bytes], request).WaitAsync(Patience, TestContext.Current.CancellationToken); });
        }
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, CodeOf(await RefusedByServer(serverCall with { Procedure = Echo with { MaximumPayloadBytes = 8 } }, 9)));
        Assert.Equal([
            "bead_client_call_duration_seconds_bucket{le=\"0.0\"} 1",
            "bead_client_call_duration_seconds_count{} 1",
            "bead_client_call_handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 1",
            "bead_client_call_started_total{} 1",
        ], MadeOf(serverRegistry, "command"));
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, CodeOf(await RefusedByServer(serverCall with { Options = serverCall.Options with { Credential = Credential.Jwt(new string('x', 40)) } }, 100)));
        var waiting = serverCore.Request(ReadOnlyMemory<byte>.Empty, serverCall);
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, CodeOf(await RefusedByServer(serverCall)));
        Assert.Equal([
            "bead_client_call_duration_seconds_bucket{le=\"0.0\"} 3",
            "bead_client_call_duration_seconds_count{} 3",
            "bead_client_call_handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 2",
            "bead_client_call_handled_total{outcome=\"failure\",code=\"CAPACITY_EXCEEDED\"} 1",
            "bead_client_call_started_total{} 4",
        ], MadeOf(serverRegistry, "command"));
        Assert.EndsWith("} 0", SumOf(serverRegistry), StringComparison.Ordinal);
        Assert.IsType<ArgumentOutOfRangeException>(await RefusedByServer(serverCall with { Options = serverCall.Options with { Timeout = TimeSpan.Zero } }));
        Assert.IsType<ArgumentException>(await RefusedByServer(serverCall with { Procedure = Echo with { MaximumPayloadBytes = 0 } }));
        Assert.IsType<ArgumentException>(await RefusedByServer(serverCall with { Options = serverCall.Options with { Credential = Credential.Jwt(new string('x', 1_005)) } }));
        Assert.IsType<OperationCanceledException>(await RefusedByServer(serverCall with { Options = serverCall.Options with { CancellationToken = aborted.Token } }));
        Assert.Contains("bead_client_call_started_total{} 4", MadeOf(serverRegistry, "command"));
        server.Deliver(new Envelope { Header = new ResultHeader { CallId = 2 } });
        await waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Count_a_call_it_makes_as_its_router_settles_it_timed_to_that_instant()
    {
        var registry = new MetricsRegistry();
        var port = new CountedPort((RouterSide.Client, registry));
        var core = port.Core;
        var series = port.DeclareRequester(Echo);

        using var source = new CancellationTokenSource();

        // a result, an application's failure, then its time passed 10 ms after it went
        var result = core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan)));
        var failed = core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan)));
        var timed = core.Request(new byte[1], CountedCallOf((series, TimeSpan.FromMilliseconds(10))));

        await port.Loop.WhenIdle();
        port.Deliver(ResultOf(1));
        port.Deliver(new Envelope { Header = new FailureHeader { CallId = 3 }, Failure = Failure.OfApplication(9) });
        await port.Clock.Advance(TimeSpan.FromMilliseconds(10));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timed.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        // its caller's cancel once it went, its connection gone, and a transport that refuses it
        var cancelling = CountedCallOf((series, Timeout.InfiniteTimeSpan));
        var cancelled = core.Request(new byte[1], cancelling with { Options = cancelling.Options with { CancellationToken = source.Token } });

        await port.Loop.WhenIdle();
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return cancelled.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        var closed = core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan)));

        await port.Loop.WhenIdle();
        core.RejectPending("the connection closed before the answer");
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return closed.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        port.Refusal = new IOException("refused");
        var refused = await Assert.ThrowsAsync<IOException>(() =>
        {
            return core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal("refused", refused.Message);
        await result.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return failed.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            [
                "bead_client_call_duration_seconds_bucket{le=\"0.0\"} 5",
                "bead_client_call_duration_seconds_count{} 6",
                "bead_client_call_handled_total{outcome=\"result\"} 1",
                "bead_client_call_handled_total{outcome=\"failure\",code=\"application\"} 1",
                "bead_client_call_handled_total{outcome=\"timeout\"} 1",
                "bead_client_call_handled_total{outcome=\"cancelled\"} 1",
                "bead_client_call_handled_total{outcome=\"closed\"} 1",
                "bead_client_call_handled_total{outcome=\"error\"} 1",
                "bead_client_call_started_total{} 6",
            ],
            MadeOf(registry));
        Assert.EndsWith("} 0.01", SumOf(registry), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Say_whether_they_open_a_subscription_and_whether_it_is_paced()
    {
        var server = new Peer(RouterSide.Server);

        foreach (var (opensSubscription, paced) in new[] { (true, false), (false, false), (true, true) })
        {
            _ = server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
            {
                OpensSubscription = opensSubscription,
                Paced = paced,
            });
        }

        await server.Settle();
        Assert.Equal(
            new IEnvelopeHeader[]
            {
                RequestOf(2) with { OpensSubscription = true },
                RequestOf(4),
                RequestOf(6) with { OpensSubscription = true, Paced = true },
            },
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
        server.Core.RejectPending("done");
    }

    [Fact]
    public async Task Reject_with_the_failure_the_peer_answers_as_its_side_or_through_a_relay_of_no_side_where_the_call_went()
    {
        var server = new Peer(RouterSide.Server);

        Task<RouterResult> Request()
        {
            return server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
            {
                Options = new ResolvedRequestOptions { DestinationId = 4, Timeout = TimeSpan.FromSeconds(5) },
            });
        }

        var fromPeer = Request();
        var relayed = Request();
        var application = Request();

        await server.Settle();
        await server.Deliver("A1 12 00 02  00 00 00 02  00 13 00 00  77 68 79");
        await server.Deliver("A1 12 00 02  00 00 00 04  00 12 01 00");
        await server.Deliver("A1 12 00 02  00 00 00 06  00 15 00 01");

        var peer = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return fromPeer.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)19, "why", FailureOrigin.Peer, (byte)0), (peer.Code, peer.Detail, peer.Origin, peer.Relays));
        Assert.Equal(4u, peer.DestinationId);
        Assert.Equal(Echo.Address, peer.ProcedureAddress);
        Assert.Equal(RouterSide.Client, peer.Side);

        var through = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return relayed.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)18, FailureOrigin.Relayed, (byte)1), (through.Code, through.Origin, through.Relays));
        Assert.Equal(4u, through.DestinationId);
        Assert.Null(through.Side);

        var applications = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return application.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)21, FailureScope.Application), (applications.Code, applications.Scope));
    }

    [Fact]
    public async Task Time_out_and_reject_never_throw_what_their_payload_or_the_transport_fails_with()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default);
        var timing = server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromMilliseconds(10));

        await server.Settle();
        await server.Advance(TimeSpan.FromMilliseconds(10));
        Assert.Equal("no answer came in 10 milliseconds", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timing.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);

        var gone = new IOException("gone");

        server.OnSend = (_) =>
        {
            if (server.SentOn[^1] == "b")
            {
                return Task.FromException(gone);
            }

            return Task.CompletedTask;
        };
        Assert.Same(gone, await Assert.ThrowsAsync<IOException>(() =>
        {
            return server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf("b", (Echo, TimeSpan.FromSeconds(1)))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        server.Sent.Clear();

        // past its limit, the call fails: never thrown, nothing sent
        Task<RouterResult>? tooLarge = null;

        Assert.Null(Record.Exception(() =>
        {
            tooLarge = server.Request(new byte[0x1000001], TimeSpan.FromSeconds(1));
        }));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return tooLarge!.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Local), (refused.Code, refused.Origin));
        await server.Settle();
        Assert.Empty(server.Sent);

        // at its limit, it goes: its opening first, which waits for its credit
        _ = server.Request(new byte[0x1000000], TimeSpan.FromSeconds(1));
        await server.Settle();
        Assert.Equal(0x1000000L, Assert.IsType<RequestHeader>(Assert.Single(server.Sent).Header).Total);
        server.Core.RejectPending("done");
    }

    [Fact]
    public async Task Draws_its_call_ids_round_their_range_skips_the_ones_held_and_fails_once_every_one_is()
    {
        foreach (var requestLength in new[] { 0, 1 })
        {
            var server = new Peer(RouterSide.Server, lastCallId: 8);
            var drawn = new List<uint>();

            Task<RouterResult> Request()
            {
                return server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with { OnCallId = drawn.Add });
            }

            server.InUse.Add(4);

            var two = Request();
            var six = Request();

            await server.Settle();
            await server.Deliver(ResultOf(2));
            await two.WaitAsync(Patience, TestContext.Current.CancellationToken);

            var eight = Request();
            var twoAgain = Request();

            // 2 answered is free again; 4 held, 6, 8 and 2 waiting: none left
            var exceeded = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return Request().WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, (RouterSide?)RouterSide.Server), (exceeded.Code, exceeded.Side));
            Assert.Equal([2u, 6u, 8u, 2u], drawn);
            server.Core.Dispose();
            await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return Task.WhenAll(six, eight, twoAgain).WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            // each side draws its own parity by default, and a last of the other is a programmer's error
            var client = new Peer(RouterSide.Client);
            using var clientCore = client.Core;
            var first = clientCore.Request(new byte[requestLength], CallOf(Handle, (Echo, TimeSpan.FromMilliseconds(1))) with { OnCallId = drawn.Add });

            await client.Settle();
            await client.Advance(TimeSpan.FromMilliseconds(1));
            await Assert.ThrowsAsync<TimeoutException>(() =>
            {
                return first.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.Equal(1u, drawn[^1]);
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                _ = new Peer(RouterSide.Server, lastCallId: 7);
            });
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                _ = new Peer(RouterSide.Client, lastCallId: 8);
            });
        }
    }

    [Fact]
    public async Task Are_cancelled_by_their_signal_at_once_drawing_nothing_or_once_sent_telling_the_peer()
    {
        var server = new Peer(RouterSide.Server);
        var drawn = new List<uint>();

        using var source = new CancellationTokenSource();

        CoreRequest Cancellable()
        {
            return CallOf(Handle, (Echo, TimeSpan.FromSeconds(1))) with
            {
                OnCallId = drawn.Add,
                Options = new ResolvedRequestOptions { CancellationToken = source.Token, Timeout = TimeSpan.FromSeconds(1) },
            };
        }

        var cancelled = server.Core.Request(ReadOnlyMemory<byte>.Empty, Cancellable());

        await server.Settle();
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return cancelled.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        // the peer told before the caller heard
        Assert.Equal(new IEnvelopeHeader[] { RequestOf(2), new CancelHeader { CallId = 2 } }, server.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));

        // the answer that comes after, on a call id reserved, says nothing
        await server.Deliver(ResultOf(2));
        Assert.Empty(server.Reports);
        server.Sent.Clear();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return server.Core.Request(ReadOnlyMemory<byte>.Empty, Cancellable()).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await server.Settle();
        Assert.Empty(server.Sent);
        Assert.Equal([2u], drawn);
    }

    [Fact]
    public async Task Send_no_cancel_for_a_request_whose_send_failed_whole_or_its_transfers_opening()
    {
        var server = new Peer(RouterSide.Server);
        var gone = new IOException("gone");

        server.OnSend = (_) =>
        {
            return Task.FromException(gone);
        };

        foreach (var length in new[] { 0, 200 })
        {
            Assert.Same(gone, await Assert.ThrowsAsync<IOException>(() =>
            {
                return server.Request(new byte[length], TimeSpan.FromSeconds(1)).WaitAsync(Patience, TestContext.Current.CancellationToken);
            }));
        }

        // neither call id reserved: an answer on the first answers no call
        await server.Deliver(ResultOf(2));
        Assert.Equal(new IEnvelopeHeader[] { RequestOf(2), RequestOf(4) with { Total = 200 } }, server.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(server.Reports)));
        Assert.Equal([Handle], server.ReportedOn);
    }

    [Fact]
    public async Task Keeps_the_later_end_of_a_call_id_reserved_twice_clearing_the_timer_it_replaces()
    {
        foreach (var firstId in new[] { 1u, 2u })
        {
            var recorded = new RequesterPeer(RequesterLimits, firstId == 1 ? RouterSide.Client : RouterSide.Server);
            using var core = recorded.Core;

            core.Reserve(new CallAddress(firstId, Handle), TimeSpan.FromMilliseconds(20));
            core.Reserve(new CallAddress(firstId, Handle), TimeSpan.FromMilliseconds(200));
            core.Reserve(new CallAddress(firstId + 2, Handle), TimeSpan.FromMilliseconds(200));
            core.Reserve(new CallAddress(firstId + 2, Handle), TimeSpan.FromMilliseconds(20));
            await recorded.Settle();
            Assert.Equal(
                [(TimeSpan.FromMilliseconds(20), true), (TimeSpan.FromMilliseconds(200), false), (TimeSpan.FromMilliseconds(200), false)],
                recorded.Clock.Armed.Select((timer) =>
                {
                    return (timer.Delay, timer.IsCleared);
                }));
            await recorded.Advance(TimeSpan.FromMilliseconds(100));
            await recorded.Deliver(ResultOf(firstId));
            await recorded.Deliver(ResultOf(firstId + 2));
            Assert.Empty(recorded.Reports);
            await recorded.Advance(TimeSpan.FromMilliseconds(100));
            await recorded.Deliver(ResultOf(firstId));
            await recorded.Deliver(ResultOf(firstId + 2));
            Assert.Equal([(ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.CallUnknown], recorded.Reports.Select(CodeOf));
        }
    }

    [Fact]
    public async Task Draw_no_call_id_reserved_and_none_at_all_when_every_one_is()
    {
        var drawn = new List<uint>();

        Task<RouterResult> RequestOn(Peer server, CancellationToken token)
        {
            return server.Core.Request(ReadOnlyMemory<byte>.Empty, CallOf(Handle, (Echo, TimeSpan.FromSeconds(1))) with
            {
                OnCallId = drawn.Add,
                Options = new ResolvedRequestOptions { CancellationToken = token, Timeout = TimeSpan.FromSeconds(1) },
            });
        }

        // a server whose first call, cancelled once sent, keeps its call id reserved
        async Task<Peer> CancelledOnce(uint lastCallId)
        {
            var server = new Peer(RouterSide.Server, lastCallId: lastCallId);

            using var source = new CancellationTokenSource();

            var given = RequestOn(server, source.Token);

            await server.Settle();
            await source.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return given.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            return server;
        }

        var drawing = await CancelledOnce(4);

        using (drawing.Core)
        {
            for (var answered = 0; answered < 2; answered += 1)
            {
                var answering = RequestOn(drawing, CancellationToken.None);

                await drawing.Settle();
                await drawing.Deliver(ResultOf(4));
                await answering.WaitAsync(Patience, TestContext.Current.CancellationToken);
            }
        }

        Assert.Equal([2u, 4u, 4u], drawn);

        var full = await CancelledOnce(2);
        using var fullCore = full.Core;

        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, CodeOf(await Assert.ThrowsAsync<FailureException>(() =>
        {
            return RequestOn(full, CancellationToken.None).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })));
    }

    [Fact]
    public async Task Arm_no_timer_for_a_call_its_own_send_ended_by_a_failure_or_a_cancel_handed_back_as_a_chunk_went()
    {
        var recorded = new RequesterPeer(RequesterLimits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        using var core = recorded.Core;
        var resolver = recorded.Resolve();
        var handedBack = new HashSet<uint>();

        // a transport that hands back, as the first chunk of each call goes, what ends that call
        recorded.OnSend = (envelope) =>
        {
            if (envelope.Header is ChunkHeader chunk && handedBack.Add(chunk.CallId))
            {
                var ending = chunk.CallId == 2
                    ? new Envelope { Header = new FailureHeader { CallId = 2 }, Failure = Failure.OfApplication(21) }
                    : new Envelope { Header = new CancelHeader { CallId = chunk.CallId } };

                core.Receive(EnvelopeCodec.WriteEnvelope(ending), Handle);
            }

            return Task.CompletedTask;
        };
        await recorded.Deliver(new Envelope { Header = RequestOf(1) });

        var request = recorded.Request(RequesterBytesOf(200), new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        var answer = resolver.Answer(0, RequesterBytesOf(150));

        await recorded.Settle();
        core.Receive(EnvelopeCodec.WriteEnvelope(CreditOf(2, 92)), Handle);
        core.Receive(EnvelopeCodec.WriteEnvelope(CreditOf(1, 80)), Handle);
        await recorded.Settle();

        // every timer stopped: none sends a stall for a call ended
        Assert.All(recorded.Clock.Armed, (timer) =>
        {
            Assert.True(timer.IsCleared);
        });
        Assert.Equal((ushort)21, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return request.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return answer.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal(
            [(EnvelopeKind.Request, 2u, 200L, 44), (EnvelopeKind.Result, 1u, 150L, 28), (EnvelopeKind.Chunk, 2u, 44L, 48), (EnvelopeKind.Chunk, 1u, 28L, 48)],
            recorded.Sent.Select((envelope) =>
            {
                return (envelope.Kind, envelope.Header.CallId, PlaceOf(envelope.Header), envelope.Payload.Length);
            }));
        Assert.Empty(recorded.Reports);
    }

    [Fact]
    public async Task Stop_a_calls_timer_as_the_call_leaves_whichever_way_so_none_keeps_the_process_waiting()
    {
        var recorded = new RequesterPeer(RequesterLimits);
        using var core = recorded.Core;

        for (var index = 0; index < 3; index += 1)
        {
            _ = recorded.Request([], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        }

        await recorded.Settle();

        // answered, cancelled, failed
        await recorded.Deliver(ResultOf(2));
        core.Cancel(new CallAddress(4, Handle));
        await recorded.Deliver(new Envelope { Header = new FailureHeader { CallId = 6 }, Failure = Failure.OfApplication(21) });
        Assert.Equal([true, true, true], recorded.Clock.Armed.Take(3).Select((timer) =>
        {
            return timer.IsCleared;
        }));
    }

    [Fact]
    public async Task End_a_result_it_receives_as_its_caller_ends_the_call_its_budget_and_place_given_back_the_peer_told_its_call_id_reserved()
    {
        foreach (var ending in new[] { "cancel", "token", "timer" })
        {
            var recorded = new RequesterPeer(RequesterLimits with
            {
                BufferedBytesBudget = 200,
                MaximumPayloadBytes = 200,
                MaximumTransfers = 1,
                TransferInactivityTimeout = TimeSpan.FromMilliseconds(250),
            });
            using var core = recorded.Core;
            using var source = new CancellationTokenSource();
            var asking = recorded.Request([], new ResolvedRequestOptions { CancellationToken = source.Token, Timeout = TimeSpan.FromSeconds(1) });

            await recorded.Deliver(ResultOpeningOf(2, (new byte[200], 28)));
            if (ending == "cancel")
            {
                core.Cancel(new CallAddress(2, Handle));
            }
            else if (ending == "token")
            {
                await source.CancelAsync();
            }
            else
            {
                // the call's own timer, its result's inactivity, the last armed
                Assert.Equal(TimeSpan.FromMilliseconds(250), recorded.Clock.Armed[^1].Delay);
                await recorded.Advance(TimeSpan.FromMilliseconds(250));
            }

            await recorded.Settle();
            if (ending == "timer")
            {
                await Assert.ThrowsAsync<TimeoutException>(() =>
                {
                    return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
            }
            else
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                {
                    return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });
            }

            // its call id reserved: its answer, late, is dropped in silence
            await recorded.Deliver(ResultOf(2));
            Assert.Empty(recorded.Reports);

            // its budget and its place back: another result is granted a whole window
            var next = recorded.Request([], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });

            await recorded.Deliver(ResultOpeningOf(4, (new byte[200], 28)));
            core.Cancel(new CallAddress(4, Handle));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return next.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.Equal(
                new IEnvelopeHeader[]
                {
                    RequestOf(2),
                    new CreditHeader { CallId = 2, CreditEnd = 156 },
                    new CancelHeader { CallId = 2 },
                    RequestOf(4),
                    new CreditHeader { CallId = 4, CreditEnd = 156 },
                    new CancelHeader { CallId = 4 },
                },
                recorded.Sent.Select((envelope) =>
                {
                    return envelope.Header;
                }));
        }
    }

    // where an envelope sent sits in its transfer: an opening's total, a chunk's offset
    private static long PlaceOf(IEnvelopeHeader header)
    {
        if (header is RequestHeader request)
        {
            return request.Total ?? 0;
        }

        if (header is ResultHeader result)
        {
            return result.Total ?? 0;
        }

        return header is ChunkHeader chunk ? chunk.Offset : -1;
    }
}
