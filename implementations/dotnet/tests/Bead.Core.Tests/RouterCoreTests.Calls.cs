using System.Buffers;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s calls, one core facing the test as its peer: what it takes in, its own
/// requests, its answers and their sessions, its cancels and reservations, and its limits.
/// </summary>
public sealed partial class RouterCoreTests
{
    // helpers

    // a call of the core's own, to a connection, given its time
    private static CoreRequest CallOf(string connectionHandle, (Procedure Procedure, TimeSpan Timeout) call)
    {
        return new CoreRequest
        {
            ConnectionHandle = connectionHandle,
            Procedure = call.Procedure,
            Options = new ResolvedRequestOptions { Timeout = call.Timeout },
        };
    }

    private static ushort CodeOf(Exception reason)
    {
        return Assert.IsType<FailureException>(reason).Code;
    }

    // a server's port that says its side, reports, and sends nowhere: nothing more
    private sealed class Plain : IRouterCorePort
    {
        public SerialScheduler Loop { get; } = new();

        public List<Exception> Reports { get; } = [];

        public RouterSide Side
        {
            get
            {
                return RouterSide.Server;
            }
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }
    }

    private static Envelope ResultOf(uint callId)
    {
        return new Envelope { Header = new ResultHeader { CallId = callId }, Payload = new byte[] { 1 } };
    }

    // bytes that give their span as many times as told, then throw what is no refusal: as a codec
    // that breaks reading them would, at their prefix or past it
    private sealed class BreakingBytes(byte[] bytes, (Exception Thrown, int Spans) breaking) : MemoryManager<byte>
    {
        private int _given;

        // its memory, made without asking for its span, as Memory asks
        public ReadOnlyMemory<byte> Bytes
        {
            get
            {
                return CreateMemory(bytes.Length);
            }
        }

        public override Span<byte> GetSpan()
        {
            if (_given == breaking.Spans)
            {
                throw breaking.Thrown;
            }

            _given++;

            return bytes;
        }

        public override MemoryHandle Pin(int elementIndex = 0)
        {
            throw new NotSupportedException();
        }

        public override void Unpin()
        {
            throw new NotSupportedException();
        }

        protected override void Dispose(bool disposing)
        {
            // nothing held: its bytes are an array's
        }
    }

    // definition

    // debugging 5.2
    [Fact]
    public async Task Reads_traces_then_dispatches_what_comes_in_and_reports_what_does_not_read_untraced()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver("A1 10");
        Assert.Single(server.Reports);
        Assert.Empty(server.Traces);

        // what throws other than a refusal before its prefix reads is reported malformed, its cause
        // kept, with its connection: its TypeScript twin is handed text
        var thrown = new InvalidOperationException("no span");
        using var broken = new BreakingBytes(new byte[] { 0xA1 }, (thrown, 0));

        server.Core.Receive(broken.Bytes, Handle);
        await server.Settle();

        Assert.Equal(2, server.Reports.Count);

        var reported = Assert.IsType<FailureException>(server.Reports[^1]);

        Assert.Equal(Failure.OfProtocol(ProtocolCode.EnvelopeMalformed, thrown.Message), reported.Failure);
        Assert.Same(thrown, reported.InnerException);
        Assert.Equal(Handle, server.ReportedOn[^1]);
        Assert.Empty(server.Traces);
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Equal(DebugDirection.Rx, Assert.Single(server.Traces).Direction);
        Assert.True(Assert.Single(resolver.Requests).IsAdmitted);
    }

    // spec 9.0
    [Fact]
    public async Task Answers_a_request_its_codec_throws_on_other_than_a_refusal_ENVELOPE_MALFORMED_with_no_detail_and_reports_the_error_with_its_connection()
    {
        var server = new Peer(RouterSide.Server);
        var thrown = new InvalidOperationException("internal: 10.0.0.5:8443");

        // its TypeScript twin breaks its codec where it reads a JWT as text; this side's codec throws
        // its refusals alone, so the bytes it reads break past their prefix instead
        using var bytes = new BreakingBytes(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } }), (thrown, 1));

        server.Core.Receive(bytes.Bytes, Handle);
        await server.Settle();

        var answer = Assert.Single(server.Sent);

        Assert.Equal(1u, answer.Header.CallId);
        Assert.Equal(Failure.OfProtocol(ProtocolCode.EnvelopeMalformed), answer.Failure);

        // the error's words reach the side's report alone, with its connection
        var reported = Assert.IsType<FailureException>(Assert.Single(server.Reports));

        Assert.Equal(Failure.OfProtocol(ProtocolCode.EnvelopeMalformed, thrown.Message), reported.Failure);
        Assert.Same(thrown, reported.InnerException);
        Assert.Equal([Handle], server.ReportedOn);
    }

    // debugging 5.2
    [Fact]
    public async Task Reports_the_kinds_to_come_and_skips_the_advisory_ones_in_silence()
    {
        var server = new Peer(RouterSide.Server);

        foreach (var kind in new[] { "17", "7F", "80", "FF" })
        {
            await server.Deliver($"A1 {kind} 00 02  00 00 00 03");
        }

        Assert.Empty(server.Sent);
        Assert.Equal(
            [(ushort)ProtocolCode.KindUnsupported, (ushort)ProtocolCode.KindUnsupported],
            server.Reports.Select(CodeOf));

        // none traced: the advisory ones skipped before it, the others reported as they do not read
        Assert.Empty(server.Traces);
    }

    [Fact]
    public async Task Asks_a_request_s_admission_on_its_header_once_past_its_route_and_answers_its_refusal()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        resolver.Admission = (request) =>
        {
            return request.Header.CallId == 5 ? Failure.OfProtocol(ProtocolCode.AccessDenied) : null;
        };

        // one it cannot route is asked nothing
        await server.Deliver(new Envelope { Header = RequestOf(1) with { ServiceId = 9 }, Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.ServiceUnknown, server.Sent[^1].Failure!.Code);
        Assert.Equal(0, resolver.Admitted);
        await server.Deliver(new Envelope { Header = RequestOf(3), Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.AccessDenied, server.Sent[^1].Failure!.Code);
        Assert.Equal(2, resolver.Admitted);
        Assert.Equal(3u, Assert.Single(resolver.Requests).Header.CallId);
    }

    [Fact]
    public async Task Reports_a_refusal_of_admission_that_cannot_be_written_and_leaves_no_call_open()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        resolver.Admission = (_) =>
        {
            return new Failure { Code = 0, Scope = FailureScope.Protocol };
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.IsType<ArgumentException>(Assert.Single(server.Reports));
        Assert.Empty(server.Sent);

        // its call id is free again
        resolver.Admission = null;
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Single(resolver.Requests);
    }

    [Fact]
    public async Task Answers_as_failed_a_request_whose_admission_throws_and_reports_why()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var broken = new InvalidOperationException("the admission broke");

        resolver.Admission = (_) =>
        {
            throw broken;
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, server.Sent[^1].Failure!.Code);
        Assert.Same(broken, Assert.Single(server.Reports));
        Assert.Empty(resolver.Requests);
    }

    [Fact]
    public async Task Refuses_a_request_that_opens_a_subscription_on_a_connection_that_carries_nothing_back_once_admitted()
    {
        var server = new Peer(RouterSide.Server) { IsTwoWayConnection = false };
        var resolver = server.Resolve();

        resolver.Admission = (request) =>
        {
            return request.Header.CallId == 5 ? Failure.OfProtocol(ProtocolCode.AccessDenied) : null;
        };

        // one that opens none is never asked
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Equal(0, server.TwoWayAsked);
        await server.Deliver(new Envelope { Header = RequestOf(3) with { OpensSubscription = true }, Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.SubscriptionUnsupported, server.Sent[^1].Failure!.Code);

        // its admission is asked first
        await server.Deliver(new Envelope { Header = RequestOf(5) with { OpensSubscription = true }, Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.AccessDenied, server.Sent[^1].Failure!.Code);
        Assert.Equal(1, server.TwoWayAsked);
    }

    [Fact]
    public async Task Answers_a_request_of_a_layout_to_come_on_a_call_id_free_and_reports_one_on_a_call_id_held_or_an_answer()
    {
        var server = new Peer(RouterSide.Server);

        await server.Deliver("A2 10 00 03  00 00 00 01  00 01 00 01");
        Assert.Equal((ushort)ProtocolCode.LayoutUnsupported, Assert.Single(server.Sent).Failure!.Code);

        // a call id the side holds, a subscription's, is not free
        server.InUse.Add(3);
        await server.Deliver("A2 10 00 03  00 00 00 03  00 01 00 01");
        await server.Deliver("A2 11 00 02  00 00 00 05");
        Assert.Single(server.Sent);
        Assert.Equal([(ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.LayoutUnsupported], server.Reports.Select(CodeOf));
    }

    [Fact]
    public async Task Answers_under_the_same_rule_on_a_client_s_core_whose_peer_opens_even_call_ids()
    {
        var client = new Peer(RouterSide.Client);

        await client.Deliver("A2 10 00 03  00 00 00 04  00 01 00 01");
        Assert.Equal(new FailureHeader { CallId = 4 }, Assert.Single(client.Sent).Header);
        Assert.Equal((ushort)ProtocolCode.LayoutUnsupported, client.Sent[0].Failure!.Code);
        await client.Deliver("A2 10 00 03  00 00 00 03  00 01 00 01");

        var reported = Assert.IsType<FailureException>(Assert.Single(client.Reports));

        Assert.Equal(((ushort)ProtocolCode.LayoutUnsupported, RouterSide.Client), (reported.Code, reported.Side));
    }

    [Fact]
    public async Task Lets_go_of_the_call_id_of_a_refusal_that_cannot_go_out_so_the_same_request_is_refused_again()
    {
        var server = new Peer(RouterSide.Server);
        var refused = new IOException("the transport refused the failure");

        server.Resolve();
        server.OnSend = (envelope) =>
        {
            return envelope.Header is FailureHeader ? Task.FromException(refused) : Task.CompletedTask;
        };
        await server.Deliver(new Envelope { Header = RequestOf(1) with { ServiceId = 9 }, Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = RequestOf(1) with { ServiceId = 9 }, Payload = new byte[] { 1 } });
        Assert.Equal([refused, refused], server.Reports);
    }

    [Fact]
    public async Task Reports_a_refusal_of_the_gate_that_cannot_go_out()
    {
        var server = new Peer(RouterSide.Server);
        var refused = new IOException("the transport refused the failure");

        server.OnSend = (_) =>
        {
            return Task.FromException(refused);
        };
        await server.Deliver("A2 10 00 03  00 00 00 01  00 01 00 01");
        Assert.Same(refused, Assert.Single(server.Reports));
    }

    [Fact]
    public async Task Settles_a_call_with_an_answer_of_this_layout_that_does_not_read_and_never_with_one_of_another()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver("A2 11 00 02  00 00 00 01");
        Assert.Equal((ushort)ProtocolCode.LayoutUnsupported, CodeOf(Assert.Single(client.Reports)));
        Assert.False(asked.IsCompleted);

        // a failure whose record is cut short
        await client.Deliver("A1 12 00 02  00 00 00 01 | 00");

        var ended = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((FailureOrigin.Local, Echo.Address), (ended.Origin, ended.ProcedureAddress));
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);

        // on another connection, it answers no call
        await client.Deliver("A1 12 00 02  00 00 00 01 | 00", "other");
        Assert.Equal(2, client.Reports.Count);
    }

    [Fact]
    public async Task Answers_the_same_call_id_open_on_two_connections_as_two_calls()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } }, "b");
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await resolver.Answer(1, new byte[] { 2 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(["a", "b"], resolver.Requests.Select((props) =>
        {
            return props.ConnectionHandle;
        }));
        Assert.Equal(2, server.Sent.Count((envelope) =>
        {
            return envelope.Header is ResultHeader { CallId: 1 };
        }));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Lets_go_of_the_call_id_of_a_resolver_that_fails_without_answering_and_of_that_one_alone()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var broken = new InvalidOperationException("the resolver broke");
        var held = new TaskCompletionSource();

        resolver.Handling = (props) =>
        {
            return props.Payload.Span[0] switch
            {
                1 => Task.FromException(broken),
                2 => held.Task,
                _ => Task.CompletedTask,
            };
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Same(broken, Assert.Single(server.Reports));

        // answered PROCEDURE_FAILED, so its requester does not wait out its timeout
        var answered = Assert.Single(server.Sent);

        Assert.Equal((1u, (ushort)ProtocolCode.ProcedureFailed), (answered.Header.CallId, answered.Failure!.Code));

        // free again: a request on it is dispatched, then cancelled, and its call id opened anew
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 1 } });
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 3 } });
        held.SetException(broken);
        await server.Settle();

        // the cancelled one failing is not reported, and closes nothing of the call after it
        Assert.Single(server.Reports);
        await resolver.Answer(2, new byte[] { 3 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.IsType<ResultHeader>(server.Sent[^1].Header);
    }

    [Fact]
    public async Task Sends_nothing_for_an_answer_whose_call_its_connection_took_away_though_the_peer_opens_its_call_id_again()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        server.Core.RejectPending("the connection closed", Handle);
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Empty(server.Sent);
        await resolver.Answer(1, new byte[] { 2 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(new byte[] { 2 }, Assert.Single(server.Sent).Payload.ToArray());
    }

    [Fact]
    public async Task Lets_a_resolver_that_fails_after_it_answered_take_nothing_from_the_call_holding_its_call_id_now()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var broken = new InvalidOperationException("the resolver broke after its answer");

        resolver.Handling = async (props) =>
        {
            if (props.Payload.Span[0] == 1)
            {
                await server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header));

                throw broken;
            }
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Same(broken, Assert.Single(server.Reports));
        Assert.IsType<ResultHeader>(Assert.Single(server.Sent).Header);

        // the call after it on its call id stays open: the same call id again is refused
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 3 } });
        Assert.Equal(2, resolver.Requests.Count);
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(server.Reports[^1]));
    }

    [Fact]
    public async Task Routes_a_request_that_opens_a_transfer_then_refuses_it_its_route_first()
    {
        var server = new Peer(RouterSide.Server);
        var payload = PatternOf(300);

        server.Resolve();
        await server.Deliver(new Envelope { Header = new RequestHeader { CallId = 1, ServiceId = 9, ProcedureId = 1, Total = 300 }, Payload = payload.AsMemory(0, 44) });
        await server.Deliver(new Envelope { Header = RequestOf(3) with { DestinationId = 7, Total = 300 }, Payload = payload.AsMemory(0, 40) });
        Assert.Equal(
            [(ushort)ProtocolCode.ServiceUnknown, (ushort)ProtocolCode.DestinationUnknown],
            server.Sent.Select((envelope) =>
            {
                return envelope.Failure!.Code;
            }));
    }

    [Fact]
    public async Task Reports_a_credit_of_notifications_where_no_side_paces_them()
    {
        var client = new Peer(RouterSide.Client);

        await client.Deliver("A1 15 20 04  00 00 00 01  00 00 00 00 00 00 00 01");
        Assert.Equal((ushort)ProtocolCode.KindUnsupported, CodeOf(Assert.Single(client.Reports)));
        Assert.Empty(client.Sent);
    }

    [Fact]
    public async Task Keeps_every_default_of_a_port_that_says_nothing_but_its_side_and_how_it_sends()
    {
        // C# only: a port's members the TypeScript side leaves out are defaults here, which one
        // that says nothing keeps: a connection carries both ways, and no notification is taken
        var plain = new Plain();
        var core = new RouterCore(plain, new RouterCoreOptions { Scheduler = plain.Loop, ResolverScheduler = plain.Loop });
        var resolver = new Held(core);

        core.RegisterResolver(resolver);
        core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(1) with { OpensSubscription = true }, Payload = new byte[] { 1 } }), Handle);
        core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new NotificationHeader { CallId = 3 }, Payload = new byte[] { 1 } }), Handle);

        for (var round = 0; round < 3; round += 1)
        {
            await plain.Loop.WhenIdle();
        }

        Assert.Single(resolver.Requests);
        Assert.Equal((ushort)ProtocolCode.KindUnsupported, CodeOf(Assert.Single(plain.Reports)));
    }

    [Fact]
    public async Task Reports_what_throws_on_its_scheduler_with_no_connection()
    {
        // C# only: what the core posts runs on its scheduler, where nothing else would hear it throw
        var peer = new Peer(RouterSide.Client);
        var broken = new InvalidOperationException("what the core ran broke");

        peer.Loop.Post(() =>
        {
            throw broken;
        });
        await peer.Settle();
        Assert.Same(broken, Assert.Single(peer.Reports));
    }

    [Fact]
    public void Refuses_a_second_resolver_for_one_procedure_and_an_address_a_revision_or_a_name_outside_section_16()
    {
        var server = new Peer(RouterSide.Server);

        server.Resolve();
        Assert.Throws<ArgumentException>(() =>
        {
            server.Resolve();
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ServiceId = 0 } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 0 } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9, ServiceRevision = 0 } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9, ProcedureName = "Echo" } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9 }, MaximumPayloadBytes = 0 });
        });
        server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ServiceId = ushort.MaxValue, ProcedureId = ushort.MaxValue, ServiceRevision = int.MaxValue } });
    }

    [Fact]
    public async Task Refuses_a_failure_whose_code_is_not_one_sending_nothing_and_telling_nothing()
    {
        var server = new Peer(RouterSide.Server);

        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfFailure(new Failure { Code = 0, Scope = FailureScope.Application }), new AnswerTarget(Handle, RequestOf(1)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal(0, server.BeforeAnswers);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Tells_the_side_of_each_answer_before_it_goes_out_and_undoes_it_when_it_does_not_go_out()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve(maximumPayloadBytes: 10);

        server.OnSend = (_) =>
        {
            return Task.FromException(new IOException("the transport refused the result"));
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        await Assert.ThrowsAsync<IOException>(() =>
        {
            return resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal((1, 1), (server.BeforeAnswers, server.Undone));

        // a result past its limit is refused before the side hears of it
        await server.Deliver(new Envelope { Header = RequestOf(3), Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return resolver.Answer(1, new byte[11]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        Assert.Equal(1, server.BeforeAnswers);
    }

    // debugging 5.1
    [Fact]
    public async Task Traces_what_goes_out_and_what_comes_in_without_its_credential_its_scheme_alone()
    {
        var token = SessionToken.FromBytes(PatternOf(16));
        var server = new Peer(RouterSide.Server) { Session = token };
        var resolver = server.Resolve();

        // a JWT, which this side takes none of, is refused, its refusal announcing the session
        await server.Deliver(new Envelope { Header = RequestOf(1) with { Credential = Credential.Jwt("a.b.c") }, Payload = new byte[] { 1 } });
        Assert.Empty(resolver.Requests);
        Assert.Equal(
            [
                (DebugDirection.Rx, (IEnvelopeHeader)(RequestOf(1) with { Credential = Credential.SchemeOf(CredentialScheme.Jwt) })),
                (DebugDirection.Tx, new FailureHeader { CallId = 1, Credential = Credential.Opaque() }),
            ],
            server.Traces.Select((trace) =>
            {
                return (trace.Direction, trace.Envelope.Header);
            }));
        Assert.Null(((RequestHeader)server.Traces[0].Envelope.Header).Credential!.Value.Token);
        Assert.Equal(token, ((FailureHeader)server.Sent[0].Header).Credential!.Value.SessionToken);
    }

    [Fact]
    public async Task Forgets_a_call_its_requester_cancels_cancelling_its_signal_and_frees_its_call_id()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        resolver.Handling = (props) =>
        {
            return Task.Delay(Timeout.InfiniteTimeSpan, props.Signal);
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 1 } });
        Assert.True(resolver.Requests[0].Signal.IsCancellationRequested);
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal(2, resolver.Requests.Count);
        Assert.Empty(server.Reports);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Cancels_the_signal_of_each_call_a_closing_connection_opened_and_of_no_other()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        resolver.Handling = (props) =>
        {
            return Task.Delay(Timeout.InfiniteTimeSpan, props.Signal);
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } }, "b");
        server.Core.RejectPending("the connection closed", "a");
        await server.Settle();
        Assert.Equal([true, false], resolver.Requests.Select((props) =>
        {
            return props.Signal.IsCancellationRequested;
        }));
        Assert.Empty(server.Reports);

        // its answer goes nowhere
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Once_disposed_rejects_what_waits_and_sends_nothing_more()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        Assert.Equal((RouterSide.Client, false), (client.Core.Side, client.Core.IsDisposed));
        client.Core.Dispose();
        Assert.True(client.Core.IsDisposed);
        Assert.Equal("the router was disposed before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(Handle, RequestOf(2)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Core.Send(ResultOf(2), Handle).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        client.Core.Cancel(new CallAddress(3, Handle));
        await client.Settle();
        Assert.Single(client.Sent);
    }

    [Fact]
    public async Task Reports_a_chunk_on_its_own_call_id_that_no_transfer_takes_and_drops_one_on_a_call_id_reserved()
    {
        var client = new Peer(RouterSide.Client);

        _ = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));
        await client.Settle();
        client.Core.Reserve(new CallAddress(7, Handle), TimeSpan.FromSeconds(5));
        await client.Deliver(new Envelope { Header = new ChunkHeader { CallId = 1, IsLast = true, Offset = 0 }, Payload = new byte[] { 1 } });
        await client.Deliver(new Envelope { Header = new ChunkHeader { CallId = 5, IsLast = true, Offset = 0 }, Payload = new byte[] { 1 } });
        await client.Deliver(new Envelope { Header = new ChunkHeader { CallId = 7, IsLast = true, Offset = 0 }, Payload = new byte[] { 1 } });
        Assert.Equal([(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.CallUnknown], client.Reports.Select(CodeOf));
        Assert.Contains("call 1 receives no transfer", client.Reports[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Frees_the_call_of_an_answer_that_could_not_go_out_so_its_call_id_opens_again()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        server.OnSend = (_) =>
        {
            return Task.FromException(new IOException("the transport refused the result"));
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        await Assert.ThrowsAsync<IOException>(() =>
        {
            return resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal(2, resolver.Requests.Count);
        Assert.Empty(server.Reports);
    }
}
