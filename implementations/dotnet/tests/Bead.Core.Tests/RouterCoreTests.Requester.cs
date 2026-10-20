using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s own calls: their request, their call id and its cancel, their
/// answer and its result in a transfer, their timers, and what they count.
/// </summary>
public sealed partial class RouterCoreTests
{
    // a requester's clock keeps every timer and its disposal, as the TypeScript clock does
    private sealed class RequesterClock : FakeTimeProvider
    {
        public List<RequesterTimer> Armed { get; } = [];

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new RequesterTimer(base.CreateTimer(callback, state, dueTime, period), dueTime);

            Armed.Add(timer);

            return timer;
        }
    }

    private sealed class RequesterTimer(ITimer timer, TimeSpan delay) : ITimer
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
                Limits = limits with { BufferedBytesBudget = 1_024, MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024 },
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
        var client = new Peer(RouterSide.Client)
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

        var asked = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with
        {
            OnCallId = (callId) =>
            {
                heard.Add($"call id {callId}");
            },
        });

        await client.Settle();
        Assert.Equal(["call id 1", "sent 1"], heard);
        Assert.Equal(RequestOf(1), client.Sent[0].Header);
        Assert.Equal([RouterActivity.Request], client.Activities);
        await client.Deliver(ResultOf(1));
        await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([RouterActivity.Request, RouterActivity.Response], client.Activities);
        Assert.Empty(client.Reports);
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

        // answered, a call gives its place back in the turn its answer came
        await server.Deliver(ResultOf(2), "a");

        var third = Request("a");

        await first.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Settle();
        Assert.Equal([2u, 4u, 6u, 8u], drawn);
        Assert.Equal(
            [2u, 4u, 6u, 8u],
            server.Sent.Select((envelope) =>
            {
                return envelope.Header.CallId;
            }));
        server.Core.RejectPending("all gone");
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Task.WhenAll(second, other, third).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Writes_the_destination_a_request_names_and_none_left_out()
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
        var command = server.Core.Request(new byte[] { 1 }, CallOf("a", (Echo, TimeSpan.FromSeconds(5))));

        await server.Settle();
        await server.Deliver(ResultOf(2), "b");
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(server.Reports)));
        Assert.False(command.IsCompleted);
        await server.Deliver(ResultOf(2), "a");
        await command.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Deliver(ResultOf(2), "a");
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(server.Reports[^1]));
    }

    [Fact]
    public async Task Offers_the_side_a_failure_that_answers_no_call_waiting_and_never_a_result()
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

        await client.Deliver(new Envelope { Header = new FailureHeader { CallId = 7 }, Failure = Failure.OfApplication(9) });
        Assert.Empty(client.Reports);
        await client.Deliver(ResultOf(7));
        Assert.Equal([7u], offered);
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    // spec 12.3.2
    [Fact]
    public async Task Rejects_a_result_whose_transfer_is_past_the_payload_s_limit_and_cancels_its_call()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo with { MaximumPayloadBytes = 100 }, TimeSpan.FromSeconds(5))));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (PatternOf(300), 32)));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Local), (refused.Code, refused.Origin));
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);
        Assert.Empty(CreditsOf(client.Sent));
    }

    [Fact]
    public async Task Rejects_with_a_DisconnectException_what_waits_on_one_connection_or_on_every_one()
    {
        var client = new Peer(RouterSide.Client);
        var gone = client.Core.Request(new byte[] { 1 }, CallOf("a", (Echo, TimeSpan.FromSeconds(5))));
        var kept = client.Core.Request(new byte[] { 1 }, CallOf("b", (Echo, TimeSpan.FromSeconds(5))));

        await client.Settle();
        client.Core.RejectPending("the connection closed", "a");
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return gone.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await client.Deliver(ResultOf(3), "b");
        await kept.WaitAsync(Patience, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task The_credential_this_side_presents_is_the_one_its_side_resolved_and_one_that_leaves_a_transfer_s_opening_no_byte_fails_it_before_it_goes_PAYLOAD_TOO_LARGE()
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
    }

    [Fact]
    public async Task A_JWT_its_header_holds_whole_fails_its_call_before_it_goes_PAYLOAD_TOO_LARGE_once_a_transfer_s_header_would_pass_1020_bytes_and_goes_as_a_transfer_a_word_shorter()
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
    public async Task Hears_its_request_handed_to_the_transport_then_refused_by_it_and_nothing_of_one_never_handed()
    {
        var client = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the request");
        var heard = new List<bool>();

        client.OnSend = (_) =>
        {
            return Task.FromException(refused);
        };

        var faulted = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with { OnSent = heard.Add });

        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return faulted.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Equal([true, false], heard);

        // a transport that throws as it is handed the request never had it
        heard.Clear();
        client.OnSend = (_) =>
        {
            throw refused;
        };

        var thrown = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, TimeSpan.FromSeconds(5))) with { OnSent = heard.Add });

        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return thrown.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Empty(heard);
    }

    // spec 10.4
    [Fact]
    public async Task Cancels_a_request_that_timed_out_before_its_caller_hears_so_one_made_again_goes_out_behind()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(1));

        await client.Settle();
        await client.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        _ = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(1));
        await client.Settle();
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u), (EnvelopeKind.Request, 3u)], client.Sent.Select((envelope) =>
        {
            return (envelope.Kind, envelope.Header.CallId);
        }));
    }

    [Fact]
    public async Task Drops_a_late_answer_while_its_call_id_is_reserved_then_reports_it()
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
    public async Task Cancels_on_its_token_once_sent_throwing_its_own_reason_though_the_cancel_cannot_go_out()
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
        Assert.Same(refused, Assert.Single(client.Reports));
    }

    [Fact]
    public async Task Sends_no_cancel_for_a_call_answered_in_the_turn_its_token_is_cancelled()
    {
        var client = new Peer(RouterSide.Client);

        using var source = new CancellationTokenSource();
        using var gate = new ManualResetEventSlim();

        var asked = client.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(5), source.Token));

        await client.Settle();

        // the scheduler held, its result comes, then its token is cancelled
        client.Loop.Post(() =>
        {
            gate.Wait(TestContext.Current.CancellationToken);
        });
        client.Core.Receive(EnvelopeCodec.WriteEnvelope(ResultOf(1)), Handle);
        await source.CancelAsync();
        gate.Set();
        await client.Settle();
        await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.DoesNotContain(client.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });

        // nothing reserved its call id: the same result again answers no call
        await client.Deliver(ResultOf(1));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Sends_no_cancel_for_a_request_the_transport_never_had_and_reserves_nothing()
    {
        var client = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the request");

        client.OnSend = (_) =>
        {
            throw refused;
        };

        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        await client.Settle();
        Assert.Single(client.Sent);

        // its call id was never reserved
        await client.Deliver(ResultOf(1));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    // spec 10.4
    [Fact]
    public async Task Cancels_a_call_waiting_once_throwing_and_reserving_its_call_id_on_its_connection_alone()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        client.Core.Cancel(new CallAddress(1, Handle));
        client.Core.Cancel(new CallAddress(1, Handle));
        await client.Settle();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Single(client.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
        await client.Deliver(ResultOf(1));
        Assert.Empty(client.Reports);
        await client.Deliver(ResultOf(1), "other");
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Reserves_a_call_id_5_s_when_given_no_time()
    {
        var client = new Peer(RouterSide.Client);

        client.Core.Reserve(new CallAddress(1, Handle));
        await client.Settle();
        await client.Advance(TimeSpan.FromSeconds(4.9));
        await client.Deliver(ResultOf(1));
        Assert.Empty(client.Reports);
        await client.Advance(TimeSpan.FromSeconds(0.1));
        await client.Deliver(ResultOf(1));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Reserves_by_connection_and_forgets_the_reservations_of_a_connection_or_of_every_one_as_they_go()
    {
        var client = new Peer(RouterSide.Client);

        client.Core.Reserve(new CallAddress(1, "a"), TimeSpan.FromSeconds(5));
        client.Core.Reserve(new CallAddress(1, "b"), TimeSpan.FromSeconds(5));
        client.Core.RejectPending("the connection closed", "a");
        await client.Settle();
        await client.Deliver(ResultOf(1), "a");
        await client.Deliver(ResultOf(1), "b");
        Assert.Single(client.Reports);
        client.Core.RejectPending("the router closed");
        await client.Settle();
        await client.Deliver(ResultOf(1), "b");
        Assert.Equal(2, client.Reports.Count);
    }

    [Fact]
    public async Task Drops_an_answer_that_does_not_read_on_a_call_id_reserved_and_reports_one_of_a_layout_to_come()
    {
        var client = new Peer(RouterSide.Client);

        client.Core.Reserve(new CallAddress(1, Handle), TimeSpan.FromSeconds(5));
        await client.Deliver("A1 12 00 02  00 00 00 01 | 00");
        Assert.Empty(client.Reports);
        await client.Deliver("A2 11 00 02  00 00 00 01");
        Assert.Equal((ushort)ProtocolCode.LayoutUnsupported, CodeOf(Assert.Single(client.Reports)));
    }

    [Fact]
    public async Task Receives_a_result_in_a_transfer_credited_as_it_comes_and_settles_its_call_once_whole()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        Assert.Equal([160L], CreditsOf(peer.Sent));

        // in any order; a credit once half a window can go
        foreach (var offset in new[] { 80, 32, 128, 176, 224 })
        {
            await peer.Deliver(ChunkOf(1, (payload, offset, 48)));
        }

        Assert.Equal([160L, 256L, 300L], CreditsOf(peer.Sent));
        Assert.False(asked.IsCompleted);
        await peer.Deliver(ChunkOf(1, (payload, 272, 28)));

        var result = await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(payload, result.Payload.ToArray());
        Assert.Equal(300, ((ResultHeader)result.Header).Total);
        Assert.Equal([RouterActivity.Request, RouterActivity.Response], peer.Activities);

        // what its credit let come, a copy, is late, and dropped in silence
        await peer.Deliver(ChunkOf(1, (payload, 224, 48)));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Rejects_a_result_whose_chunk_breaks_its_transfer_cancels_its_call_and_drops_what_comes_after()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(ChunkOf(1, (payload, 32, 20)));

        var invalid = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.ChunkInvalid, invalid.Code);
        Assert.Equal(FailureOrigin.Local, invalid.Origin);
        Assert.Equal(Echo.Address, invalid.ProcedureAddress);
        Assert.IsType<CancelHeader>(peer.Sent[^1].Header);
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Ends_a_result_s_transfer_the_peer_fails_and_drops_what_comes_after()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfProtocol(ProtocolCode.TransferStalled) });
        Assert.Equal((ushort)ProtocolCode.TransferStalled, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);

        // the peer ended it: no cancel, and what its credit let come is dropped in silence
        Assert.DoesNotContain(peer.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Reports_a_second_result_on_a_call_whose_result_comes_in_a_transfer_and_goes_on_receiving_it()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(100);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = new byte[] { 9 } });
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, Assert.IsType<FailureException>(Assert.Single(peer.Reports)).Code);
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        await peer.Deliver(ChunkOf(1, (payload, 80, 20)));
        Assert.Equal(payload, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
    }

    [Fact]
    public async Task Reserves_the_call_id_of_a_result_it_received_in_part_as_long_as_the_peer_keeps_its_call_abandoned_or_its_timeout_when_longer()
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
            var recorded = new RequesterPeer(Chunked with { TransferInactivityTimeout = TimeSpan.FromSeconds(4) });
            using var core = recorded.Core;
            using var cancellation = new CancellationTokenSource();
            var asking = recorded.Request([1], new ResolvedRequestOptions
            {
                CancellationToken = cancellation.Token,
                Timeout = timeout is { } milliseconds ? TimeSpan.FromMilliseconds(milliseconds) : Timeout.InfiniteTimeSpan,
            });

            await recorded.Deliver(ResultOpeningOf(2, (RequesterBytesOf(40), 32)));

            var before = recorded.Clock.Armed.Count;

            if (ending == "whole")
            {
                await recorded.Deliver(new Envelope
                {
                    Header = new ChunkHeader { CallId = 2, IsLast = true, Offset = 32 },
                    Payload = RequesterBytesOf(8),
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
                    Header = new ChunkHeader { CallId = 2, IsLast = true, Offset = 32 },
                    Payload = RequesterBytesOf(9),
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

                Assert.Equal(RequesterBytesOf(32).Concat(RequesterBytesOf(8)), result.Payload.ToArray());
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
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        // its timeout of 1 s is shorter than the 2 s the peer keeps its call abandoned
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
        Assert.Equal(3u, await peer.CallIdOf(peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5))));
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, Assert.IsType<FailureException>(Assert.Single(peer.Reports)).Code);
    }

    [Fact]
    public async Task Sends_a_request_as_a_transfer_its_opening_the_chunks_each_credit_lets_go_then_waits_on_its_answer()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(payload, TimeSpan.FromSeconds(5));

        await peer.Settle();

        var opening = Assert.Single(peer.Sent);

        Assert.Equal(new RequestHeader { CallId = 1, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId, Total = 300 }, opening.Header);
        Assert.Equal(payload[..44], opening.Payload.ToArray());

        // a credit of 172 lets two full chunks go; the third would pass it
        await peer.Deliver(CreditOf(1, 172));
        Assert.Equal([(44L, false), (92L, false)], ChunksOf(peer.Sent));
        Assert.Empty(peer.Activities);
        await peer.Deliver(CreditOf(1, 300));
        Assert.Equal([(44L, false), (92L, false), (140L, false), (188L, false), (236L, false), (284L, true)], ChunksOf(peer.Sent));
        Assert.Equal(payload[284..], peer.Sent[^1].Payload.ToArray());
        Assert.Equal([RouterActivity.Request], peer.Activities);

        // whole, it waits on its answer
        await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = new byte[] { 1 } });
        Assert.Equal(new byte[] { 1 }, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
    }

    [Fact]
    public async Task Stops_a_request_the_peer_answers_or_its_caller_gives_up_and_sends_nothing_more_of_it()
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
            var peer = new RequesterPeer(Chunked with { TransferInactivityTimeout = TimeSpan.FromSeconds(30) }, side);
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
    public async Task Ends_a_request_whose_chunk_cannot_go_out_telling_the_peer_to_cancel_it()
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
    }

    [Fact]
    public async Task Ends_nothing_more_by_a_chunk_whose_send_failed_behind_its_answer()
    {
        var client = new Peer(RouterSide.Client);
        var held = new TaskCompletionSource();

        client.OnSend = (envelope) =>
        {
            return envelope.Header is ChunkHeader ? held.Task : Task.CompletedTask;
        };

        var asked = client.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(CreditOf(1, 100));
        await client.Deliver(ResultOf(1));
        await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        held.SetException(new IOException("the transport lost the chunk"));
        await client.Settle();
        Assert.DoesNotContain(client.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
        Assert.Empty(client.Reports);
    }

    [Fact]
    public async Task Waits_on_a_request_s_own_timer_the_inactivity_while_it_goes_as_a_transfer_then_its_timeout_for_its_answer()
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

        var recorded = new RequesterPeer(Chunked with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
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
    public async Task Sets_a_call_s_timer_going_again_as_the_bytes_of_its_result_come_and_not_for_bytes_it_has()
    {
        var recorded = new RequesterPeer(Chunked with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        using var recordedCore = recorded.Core;
        var waiting = recorded.Request([], new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        var bytes = new byte[150];

        await recorded.Deliver(ResultOpeningOf(2, (bytes, 32)));
        await recorded.Deliver(ChunkOf(2, (bytes, 32, 48)));
        await recorded.Deliver(ChunkOf(2, (bytes, 32, 48)));
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
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));

        // a copy is no progress
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
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
    public async Task Keeps_the_inactivity_of_a_result_that_opens_before_the_last_chunk_of_its_request_goes()
    {
        foreach (var holdLastSend in new[] { false, true })
        {
            var reentrant = new RequesterPeer(Chunked with { TransferInactivityTimeout = TimeSpan.FromSeconds(30) });
            using var core = reentrant.Core;
            var handed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var opened = 0;

            reentrant.OnSend = (envelope) =>
            {
                if (envelope.Header is ChunkHeader { IsLast: true })
                {
                    opened += 1;
                    core.Receive(EnvelopeCodec.WriteEnvelope(ResultOpeningOf(2, (RequesterBytesOf(100), 32))), Handle);

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
        await peer.Deliver(ResultOpeningOf(1, (RequesterBytesOf(300), 32)));
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
    }

    [Fact]
    public async Task Counts_a_call_it_makes_as_its_router_settles_it_timed_to_that_instant()
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
        await Assert.ThrowsAsync<IOException>(() =>
        {
            return core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
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
}
