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

    // an answer on a call of echo, to the connection
    private static Task Answered(Peer server, (uint CallId, RouterAnswer Answer) answered)
    {
        return server.Core.Respond(answered.Answer, new AnswerTarget(Handle, RequestOf(answered.CallId))).WaitAsync(Patience, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Announces_the_session_when_it_changes_and_only_then()
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
        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget("b", RequestOf(1)))
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
    public async Task Announces_again_what_an_answer_that_did_not_go_out_announced()
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
    public async Task Keeps_the_announcement_in_the_order_answers_were_written_whatever_order_they_settle_in()
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

        server.OnSend = (_) =>
        {
            var send = new TaskCompletionSource();

            held.Add(send);

            return send.Task;
        };

        var first = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(1)));

        await server.Settle();
        current = other;

        var second = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(3)));

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
        await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(5)))
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
    public async Task Forgets_the_announcement_with_the_connection_even_with_an_answer_in_flight()
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

        server.OnSend = (_) =>
        {
            return held.Task;
        };

        var inFlight = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(1)));

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
    public async Task Fails_the_answer_whose_session_cannot_be_told_and_announces_nothing_without_a_way_to()
    {
        var unknown = new InvalidOperationException("no session to tell");
        var server = new Peer(RouterSide.Server)
        {
            TokenOf = (_) =>
            {
                throw unknown;
            },
        };

        Assert.Same(unknown, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(Handle, RequestOf(1)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Empty(server.Sent);

        // a port that says nothing of its sessions has none to announce
        var bare = new Sessionless();
        using var bareCore = new RouterCore(bare, null);

        await bareCore.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(1)))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([new ResultHeader { CallId = 1 }], bare.Sent.Select((envelope) =>
        {
            return envelope.Header;
        }));
    }

    [Fact]
    public async Task Refuses_a_payload_past_its_own_limit_and_an_envelope_past_its_own()
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
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfApplication(7, detail) });
        Assert.Equal(10, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Detail.Length);

        var server = new Peer(RouterSide.Server, RouterLimits.Default with { MaximumDetailBytes = 4 });
        using var serverCore = server.Core;
        var answering = server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1));
        await server.Deliver(new Envelope { Header = new FailureHeader { CallId = 2 }, Failure = Failure.OfApplication(1, "abcdefgh") });
        Assert.Equal("abcd", (await Assert.ThrowsAsync<FailureException>(() => { return answering.WaitAsync(Patience, TestContext.Current.CancellationToken); })).Detail);
    }

    [Fact]
    public async Task Refuses_a_notification_too_large_for_one_envelope_and_sends_one_that_fits()
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
}
