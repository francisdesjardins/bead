using System.Globalization;

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

        public void Report(Exception reason, string connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return Task.CompletedTask;
        }
    }

    private static Envelope ResultOf(uint callId)
    {
        return new Envelope { Header = new ResultHeader { CallId = callId }, Payload = new byte[] { 1 } };
    }

    // definition

    [Fact]
    public async Task Reads_traces_then_dispatches_what_comes_in_and_reports_what_does_not_read_untraced()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver("A1 10");
        Assert.Single(server.Reports);
        Assert.Empty(server.Traces);
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Equal(DebugDirection.Rx, Assert.Single(server.Traces).Direction);
        Assert.True(Assert.Single(resolver.Requests).IsAdmitted);
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
    public void Refuses_a_second_resolver_for_one_procedure_and_an_address_of_0()
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
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9 }, MaximumPayloadBytes = 0 });
        });
        server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ServiceId = ushort.MaxValue, ProcedureId = ushort.MaxValue } });
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
    public async Task Fails_the_answer_whose_session_cannot_be_told()
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
    }

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
                (DebugDirection.Rx, (IEnvelopeHeader)RequestOf(1), (CredentialScheme?)CredentialScheme.Jwt),
                (DebugDirection.Tx, new FailureHeader { CallId = 1 }, CredentialScheme.Opaque),
            ],
            server.Traces.Select((trace) =>
            {
                return (trace.Direction, trace.Envelope.Header, trace.Envelope.CredentialScheme);
            }));
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
    public async Task Holds_a_reservation_and_a_cancel_s_to_a_whole_number_of_milliseconds_rounded_refusing_zero_infinite_taking_the_default_time_doing_nothing_for_one_refused()
    {
        // reserved while what comes on it is dropped in silence; free once it is reported unknown
        async Task<bool> IsReserved(Peer peer, uint callId)
        {
            var reports = peer.Reports.Count;

            await peer.Deliver(ResultOf(callId));

            return peer.Reports.Count == reports;
        }

        foreach (var (given, outcome, held, refusal) in Durations.Of("a call id's reservation", (DurationOutcome.Refused, DurationOutcome.Never)))
        {
            var client = new Peer(RouterSide.Client);

            if (outcome == DurationOutcome.Refused)
            {
                foreach (var refused in new[]
                {
                    Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        client.Core.Reserve(new CallAddress(1, Handle), given);
                    }),
                    Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        client.Core.Cancel(new CallAddress(3, Handle), given);
                    }),
                })
                {
                    Assert.StartsWith(refusal!, refused.Message, StringComparison.Ordinal);
                    Assert.Equal("timeout", refused.ParamName);
                }

                await client.Settle();
                Assert.Empty(client.Sent);
                Assert.False(await IsReserved(client, 1));
                Assert.False(await IsReserved(client, 3));

                continue;
            }

            // reserved for the duration held, or for the default time for infinite
            var lasts = outcome == DurationOutcome.Taken ? held!.Value : TimeSpan.FromSeconds(5);

            client.Core.Reserve(new CallAddress(1, Handle), given);
            client.Core.Cancel(new CallAddress(3, Handle), given);
            await client.Settle();
            await client.Advance(lasts - TimeSpan.FromMilliseconds(1));
            Assert.True(await IsReserved(client, 1));
            Assert.True(await IsReserved(client, 3));
            await client.Advance(TimeSpan.FromMilliseconds(1));
            Assert.False(await IsReserved(client, 1));
            Assert.False(await IsReserved(client, 3));
        }
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
    public async Task Holds_a_call_s_timeout_to_a_whole_number_of_milliseconds_rounded_refusing_zero_infinite_waiting_on_drawing_nothing_for_one_refused()
    {
        foreach (var (given, outcome, held, refusal) in Durations.Of("a call's timeout", (DurationOutcome.Refused, DurationOutcome.Never)))
        {
            var client = new Peer(RouterSide.Client);
            var drawn = new List<uint>();
            var asking = client.Core.Request(new byte[] { 1 }, CallOf(Handle, (Echo, given)) with { OnCallId = drawn.Add });

            if (outcome == DurationOutcome.Refused)
            {
                var refused = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
                {
                    return asking;
                });

                Assert.StartsWith(refusal!, refused.Message, StringComparison.Ordinal);
                Assert.Equal("Timeout", refused.ParamName);
                await client.Settle();
                Assert.Empty(drawn);
                Assert.Empty(client.Sent);

                continue;
            }

            await client.Settle();
            Assert.Equal([1u], drawn);

            // a duration held ends the call once it passed, its TimeoutException telling it; infinite
            // waits on past the longest
            if (outcome == DurationOutcome.Taken)
            {
                await client.Advance(held!.Value - TimeSpan.FromMilliseconds(1));
                Assert.False(asking.IsCompleted);
                await client.Advance(TimeSpan.FromMilliseconds(1));

                var ended = await Assert.ThrowsAsync<TimeoutException>(() =>
                {
                    return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
                });

                Assert.Equal(string.Create(CultureInfo.InvariantCulture, $"no answer came in {held.Value.TotalMilliseconds} milliseconds"), ended.Message);
            }
            else
            {
                await client.Advance(Clocks.LongestTimer);
                Assert.False(asking.IsCompleted);
            }
        }
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

    [Fact]
    public async Task Refuses_a_notification_too_large_for_one_envelope_and_sends_one_that_fits()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { ChunkBytes = 64, MaximumEnvelopeBytes = 64 });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = 1 }, Payload = new byte[57] }, Handle)
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        await server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = 1 }, Payload = new byte[56] }, Handle)
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Single(server.Sent);
    }
}
