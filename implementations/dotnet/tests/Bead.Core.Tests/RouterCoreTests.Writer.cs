namespace Bead.Tests;

/// <summary>
/// What <see cref="RouterCore"/> hands its transport: the session it announces, an envelope
/// within its limits, and a failure's detail cut to its envelope.
/// </summary>
public sealed partial class RouterCoreTests
{
    // a server's port that says its side, and what it sends, and nothing of its sessions
    private sealed class Sessionless : IRouterCorePort
    {
        public List<Envelope> Sent { get; } = [];

        public RouterSide Side
        {
            get
            {
                return RouterSide.Server;
            }
        }

        public void Report(Exception reason, string? connectionHandle)
        {
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            Sent.Add(EnvelopeCodec.ReadEnvelope(message.Bytes.Span, new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!);

            return Task.CompletedTask;
        }
    }

    // an answer on a call of echo the connection's peer opened
    private static async Task Answered(Peer server, (uint CallId, RouterAnswer Answer) answered)
    {
        var target = await server.Open(answered.CallId);

        await server.Core.Respond(answered.Answer, target).WaitAsync(Patience, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Announce_the_session_when_it_changes_and_only_then()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var other = SessionToken.FromBytes(PatternOf(17).AsSpan(1));
        SessionToken? current = null;
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (connectionHandle) =>
            {
                return connectionHandle == Handle ? current : null;
            },
        };
        var tokens = new SessionToken?[] { token, token, other, null, null };

        for (var index = 0; index < tokens.Length; index += 1)
        {
            current = tokens[index];
            await Answered(server, (
                (uint)(index * 2) + 1,
                index % 2 == 0 ? RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty) : RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.AccessDenied))));
        }

        // another connection, with no session yet, is told nothing
        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), await server.Open(1, "b"))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(
            new IEnvelopeHeader[]
            {
                new ResultHeader { CallId = 1, Credential = Credential.Opaque(token) },
                new FailureHeader { CallId = 3 },
                new ResultHeader { CallId = 5, Credential = Credential.Opaque(other) },
                new FailureHeader { CallId = 7, Credential = Credential.None },
                new ResultHeader { CallId = 9 },
                new ResultHeader { CallId = 1 },
            },
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
    }

    [Fact]
    public async Task Announce_again_what_an_answer_that_did_not_go_out_announced()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var gone = new IOException("gone");
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                return token;
            },
        };

        server.OnSend = (_) =>
        {
            return Task.FromException(gone);
        };
        Assert.Same(gone, await Assert.ThrowsAsync<IOException>(() =>
        {
            return Answered(server, (1, RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty)));
        }));
        server.OnSend = null;
        await Answered(server, (3, RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty)));
        Assert.Equal(
            [
                new ResultHeader { CallId = 1, Credential = Credential.Opaque(token) },
                new ResultHeader { CallId = 3, Credential = Credential.Opaque(token) },
            ],
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
    }

    [Fact]
    public async Task Keep_the_announcement_in_the_order_answers_were_written_whatever_order_they_settle_in()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var other = SessionToken.FromBytes(PatternOf(17).AsSpan(1));
        var current = token;
        var held = new List<TaskCompletionSource>();
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                return current;
            },
        };

        var calls = new[] { await server.Open(1), await server.Open(3), await server.Open(5) };

        server.OnSend = (_) =>
        {
            var send = new TaskCompletionSource();

            held.Add(send);

            return send.Task;
        };

        var first = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), calls[0]);

        await server.Settle();
        current = other;

        var second = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), calls[1]);

        await server.Settle();

        // the second settles first, then the first fails: what the second wrote stands
        held[1].SetResult();
        await second.WaitAsync(Patience, TestContext.Current.CancellationToken);
        held[0].SetException(new IOException("gone"));
        await Assert.ThrowsAsync<IOException>(() =>
        {
            return first.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        server.OnSend = null;
        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), calls[2])
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(
            [
                new ResultHeader { CallId = 1, Credential = token },
                new ResultHeader { CallId = 3, Credential = other },
                new ResultHeader { CallId = 5 },
            ],
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
    }

    [Fact]
    public async Task Forget_the_announcement_with_the_connection_even_with_an_answer_in_flight()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var held = new TaskCompletionSource();
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                return token;
            },
        };

        var call = await server.Open(1);

        server.OnSend = (_) =>
        {
            return held.Task;
        };

        var inFlight = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), call);

        await server.Settle();
        server.Core.RejectPending("a closed", Handle);
        await server.Settle();

        // it goes out after all, and undoes nothing
        held.SetResult();
        await inFlight.WaitAsync(Patience, TestContext.Current.CancellationToken);

        // a connection of the same handle is told anew
        server.OnSend = null;
        await Answered(server, (3, RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty)));
        Assert.Equal(
            [
                new ResultHeader { CallId = 1, Credential = Credential.Opaque(token) },
                new ResultHeader { CallId = 3, Credential = Credential.Opaque(token) },
            ],
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
    }

    [Fact]
    public async Task Fail_the_answer_whose_session_cannot_be_told_and_announce_nothing_without_a_way_to()
    {
        var unknown = new InvalidOperationException("no session to tell");
        var server = new Peer(RouterSide.Server);
        var call = await server.Open(1);

        server.TokenOf = (_) =>
        {
            throw unknown;
        };
        Assert.Same(unknown, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), call)
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Empty(server.Sent);

        // a port that says nothing of its sessions has none to announce
        var bare = new Sessionless();
        using var bareCore = new RouterCore(bare, null);
        var dispatched = new TaskCompletionSource<RequestResolverProps>(TaskCreationOptions.RunContinuationsAsynchronously);

        bareCore.RegisterResolver(new Held(bareCore)
        {
            Handling = (props) =>
            {
                dispatched.TrySetResult(props);

                return Task.CompletedTask;
            },
        });
        bareCore.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(1) }), Handle);

        var props = await dispatched.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);

        await bareCore.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(props.ConnectionHandle, props.Header))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([new ResultHeader { CallId = 1 }], bare.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));
    }

    [Fact]
    public async Task Refuse_a_payload_past_its_own_limit_and_an_envelope_past_its_own()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 8, WindowBytes = 128 });

        // a request's, and a notification's, which goes as the side sends it
        foreach (var sending in new Task[]
        {
            server.Request(new byte[9], TimeSpan.FromSeconds(1)),
            server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = 2 }, Payload = new byte[9] }, Handle),
        })
        {
            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return sending.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"), (refused.Code, refused.Detail));
        }

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[53] });
        Assert.Equal([(1u, (ushort)ProtocolCode.EnvelopeTooLarge)], server.Sent.Select((envelope) =>
        {
            return (envelope.Header.CallId, envelope.Failure!.Code);
        }));
    }

    [Fact]
    public async Task Cuts_a_failure_s_detail_to_its_envelope_s_room_and_to_its_own_limit_both_ways()
    {
        foreach (var code in new ushort[] { 1, 7 })
        {
            var detail = new string('x', 100);

            async Task<string> AnsweredOf(RouterLimits limits)
            {
                var server = new Peer(RouterSide.Server, limits);
                var resolver = server.Resolve();

                await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
                await resolver.Fail(0, Failure.OfApplication(7, detail)).WaitAsync(Patience, TestContext.Current.CancellationToken);

                return server.Sent[^1].Failure!.Detail;
            }

            Assert.Equal(32, (await AnsweredOf(RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64 })).Length);
            Assert.Equal(10, (await AnsweredOf(RouterLimits.Default with { MaximumDetailBytes = 10 })).Length);

            // what comes in is cut to its own limit too
            var client = new Peer(RouterSide.Client, RouterLimits.Default with { MaximumDetailBytes = 10 });
            var asked = client.Request(new byte[code == 1 ? 1 : 0], TimeSpan.FromSeconds(5));

            await client.Settle();
            await client.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfApplication(7, detail) });
            Assert.Equal(10, (await Assert.ThrowsAsync<FailureException>(() =>
            {
                return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            })).Detail.Length);

            var server = new Peer(RouterSide.Server, RouterLimits.Default with { MaximumDetailBytes = 4 });
            using var serverCore = server.Core;
            var answering = server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1));
            await server.Deliver(new Envelope { Header = new FailureHeader { CallId = 2 }, Failure = Failure.OfApplication(code, "abcdefgh") });
            Assert.Equal("abcd", (await Assert.ThrowsAsync<FailureException>(() => { return answering.WaitAsync(Patience, TestContext.Current.CancellationToken); })).Detail);
        }
    }

    [Fact]
    public async Task Refuse_a_notification_too_large_for_one_envelope_and_send_one_that_fits()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64 });

        foreach (var callId in new[] { 1u, 2u })
        {
            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = new byte[57] }, Handle)
                    .WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, refused.Code);
            Assert.Equal("an envelope is 64 bytes at most, not 65", refused.Detail);
            await server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = new byte[56] }, Handle)
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        }
        Assert.Equal([(EnvelopeKind.Notification, 1u), (EnvelopeKind.Notification, 2u)], server.Sent.Select((sent) =>
        {
            return (sent.Kind, sent.Header.CallId);
        }));
    }

    [Fact]
    public async Task An_answer_carries_the_session_when_it_changed_a_result_or_a_failure_alike()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        SessionToken? current = token;
        var peer = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                return current;
            },
        };
        using var core = peer.Core;

        await core.Send(ResultOf(1), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(new Envelope { Header = new FailureHeader { CallId = 3 }, Failure = Failure.OfProtocol(ProtocolCode.AccessDenied) }, Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(ResultOf(5), "b").WaitAsync(Patience, TestContext.Current.CancellationToken);
        current = null;
        await core.Send(new Envelope { Header = new FailureHeader { CallId = 7 }, Failure = Failure.OfProtocol(ProtocolCode.AccessDenied) }, Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(ResultOf(9), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(
            new IEnvelopeHeader[]
            {
                new ResultHeader { CallId = 1, Credential = token },
                new FailureHeader { CallId = 3 },
                new ResultHeader { CallId = 5, Credential = token },
                new FailureHeader { CallId = 7, Credential = Credential.None },
                new ResultHeader { CallId = 9 },
            },
            peer.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Equal([Handle, Handle, "b", Handle, Handle], peer.SentOn);
        Assert.All(peer.Sent.Where((envelope) => { return envelope.Kind == EnvelopeKind.Failure; }), (envelope) =>
        {
            Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied), envelope.Failure);
        });
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task A_connection_never_told_of_a_session_hears_nothing_of_none_and_nothing_but_an_answer_says_one()
    {
        var peer = new Peer(RouterSide.Server);
        using var core = peer.Core;

        await core.Send(ResultOf(1), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        peer.TokenOf = (_) =>
        {
            throw new InvalidOperationException("a request never asks for a session announcement");
        };

        var request = new Envelope { Header = RequestOf(2) };

        await core.Send(request, Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);

        var token = SessionToken.FromBytes(PatternOf(16));

        peer.TokenOf = (_) => { return token; };
        await core.Send(ResultOf(3), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(new ResultHeader { CallId = 1 }, peer.Sent[0].Header);
        Assert.Equal(request.Header, peer.Sent[1].Header);
        Assert.Equal(new ResultHeader { CallId = 3, Credential = token }, peer.Sent[2].Header);
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Announce_nothing_without_a_session_to_ask_for()
    {
        var bare = new Sessionless();
        using var core = new RouterCore(bare, null);

        await core.Send(ResultOf(1), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(new ResultHeader { CallId = 1 }, Assert.Single(bare.Sent).Header);
        Assert.Equal(0, core.Gauges().Counts["announced"]);
    }

    [Fact]
    public async Task Restore_undoes_an_announcement_unless_another_was_recorded_since_or_the_connection_forgotten()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var other = SessionToken.Parse("DwAOAQ0CDAMLBAoFCQYIBw");
        var current = token;
        var peer = new Peer(RouterSide.Server)
        {
            TokenOf = (_) => { return current; },
        };
        using var core = peer.Core;
        var broken = new IOException("the answer did not go out");
        var firstSend = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        peer.OnSend = (_) => { return firstSend.Task; };

        var initial = core.Send(ResultOf(1), Handle);

        await peer.Settle();
        firstSend.SetException(broken);
        Assert.Same(broken, await Assert.ThrowsAsync<IOException>(() => { return initial.WaitAsync(Patience, TestContext.Current.CancellationToken); }));

        var firstPending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        peer.OnSend = (_) => { return firstPending.Task; };

        var first = core.Send(ResultOf(3), Handle);

        await peer.Settle();
        Assert.Equal(Credential.Opaque(token), ((ResultHeader)peer.Sent[^1].Header).Credential);
        current = other;

        var secondPending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        peer.OnSend = (_) => { return secondPending.Task; };

        var second = core.Send(ResultOf(5), Handle);

        await peer.Settle();
        firstPending.SetException(broken);
        await Assert.ThrowsAsync<IOException>(() => { return first.WaitAsync(Patience, TestContext.Current.CancellationToken); });
        secondPending.SetException(broken);
        await Assert.ThrowsAsync<IOException>(() => { return second.WaitAsync(Patience, TestContext.Current.CancellationToken); });
        current = token;
        peer.OnSend = null;
        await core.Send(ResultOf(7), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Null(((ResultHeader)peer.Sent[^1].Header).Credential);
        current = other;

        var forgottenPending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        peer.OnSend = (_) => { return forgottenPending.Task; };

        var forgotten = core.Send(ResultOf(9), Handle);

        await peer.Settle();
        core.RejectPending("the connection closed", Handle);
        await peer.Settle();
        forgottenPending.SetException(broken);
        await Assert.ThrowsAsync<IOException>(() => { return forgotten.WaitAsync(Patience, TestContext.Current.CancellationToken); });
        peer.OnSend = null;
        await core.Send(ResultOf(11), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(Credential.Opaque(other), ((ResultHeader)peer.Sent[^1].Header).Credential);
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Forget_what_a_connection_was_told_or_every_connection()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var peer = new Peer(RouterSide.Server)
        {
            TokenOf = (_) => { return token; },
        };
        using var core = peer.Core;

        await core.Send(ResultOf(1), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(ResultOf(1), "b").WaitAsync(Patience, TestContext.Current.CancellationToken);
        core.RejectPending("the connection closed", Handle);
        await peer.Settle();
        await core.Send(ResultOf(3), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(ResultOf(3), "b").WaitAsync(Patience, TestContext.Current.CancellationToken);
        core.RejectPending("every connection closed");
        await peer.Settle();
        await core.Send(ResultOf(5), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await core.Send(ResultOf(5), "b").WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(
            [Credential.Opaque(token), Credential.Opaque(token), Credential.Opaque(token), null, Credential.Opaque(token), Credential.Opaque(token)],
            peer.Sent.Select((envelope) => { return ((ResultHeader)envelope.Header).Credential; }));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Hands_an_envelope_within_its_limits_to_its_port_s_transport_traced_refuses_one_past_them_and_sends_nothing_once_its_router_is_disposed()
    {
        var peer = new Peer(RouterSide.Server, RouterLimits.Default with
        {
            BufferedBytesBudget = 1_024,
            MaximumPayloadBytes = 1_024,
            ChunkBytes = 64,
            MaximumEnvelopeBytes = 64,
            WindowBytes = 128,
        });
        using var core = peer.Core;

        static Envelope EnvelopeOf(int length)
        {
            return new Envelope { Header = RequestOf(1), Payload = new byte[length] };
        }

        await core.Send(EnvelopeOf(4), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);

        var sent = Assert.Single(peer.Sent);
        var trace = Assert.Single(peer.Traces);

        Assert.Equal(RequestOf(1), sent.Header);
        Assert.Equal(new byte[4], sent.Payload.ToArray());
        Assert.Equal([Handle], peer.SentOn);
        Assert.Equal((DebugDirection.Tx, Handle, RequestOf(1)), (trace.Direction, trace.Envelope.ConnectionHandle, trace.Envelope.Header));

        foreach (var length in new[] { 100, 2_000 })
        {
            var failure = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return core.Send(EnvelopeOf(length), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code);
        }

        core.Dispose();
        await peer.Settle();

        var closed = await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return core.Send(EnvelopeOf(4), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(RouterCore.Disposed, closed.Message);
        Assert.Single(peer.Sent);
        Assert.Single(peer.Traces);
        Assert.Empty(peer.Reports);
    }
}
