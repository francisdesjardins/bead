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

    // each answer a peer was sent, in order: its kind, its call id, and its failure's code or its
    // payload's first byte
    private static List<(EnvelopeKind Kind, uint CallId, ushort Value)> AnswersOf(Peer peer)
    {
        return [.. peer.Sent.Select((envelope) =>
        {
            return (envelope.Kind, envelope.Header.CallId, envelope.Failure is { } failure ? failure.Code : envelope.Payload.Span[0]);
        })];
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
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 7 } });

        var (direction, traced) = Assert.Single(server.Traces);

        Assert.Equal((DebugDirection.Rx, Handle, (IEnvelopeHeader)RequestOf(1)), (direction, traced.ConnectionHandle, traced.Header));

        // admitted already: its resolver asks nothing again
        var dispatched = Assert.Single(resolver.Requests);

        Assert.Equal((Handle, RequestOf(1), true), (dispatched.ConnectionHandle, dispatched.Header, dispatched.IsAdmitted));
        Assert.Equal(new byte[] { 7 }, dispatched.Payload.ToArray());
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
    public async Task Asks_a_request_s_admission_on_its_header_once_past_its_route_and_before_its_payload_a_refusal_answers_it_before_any_credit()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var asked = new List<(uint CallId, string ConnectionHandle, bool IsWhole)>();
        var payload = PatternOf(100);

        resolver.Admission = (request) =>
        {
            // its header alone: a transfer's opening is asked before its payload comes whole
            asked.Add((request.Header.CallId, request.ConnectionHandle, request.Header.Total is null));

            return request.Header.CallId is 3 or 7 ? Failure.OfProtocol(ProtocolCode.AccessDenied) : null;
        };

        // whole, then as a transfer: admitted, then refused
        await server.Deliver(new Envelope { Header = RequestOf(1) });
        await server.Deliver(new Envelope { Header = RequestOf(3) });
        await server.Deliver(RequestOpeningOf(5, (payload, 40)));
        await server.Deliver(ChunkOf(5, (payload, 40, 48)));
        await server.Deliver(ChunkOf(5, (payload, 88, 12)));
        await server.Deliver(RequestOpeningOf(7, (payload, 40)));

        // no route: never asked
        await server.Deliver(new Envelope { Header = RequestOf(9) with { ServiceId = 8 } });

        Assert.Equal([(1u, Handle, true), (3u, Handle, true), (5u, Handle, false), (7u, Handle, false)], asked);
        Assert.Equal(4, resolver.Admitted);
        Assert.Equal(
            [(1u, true, 0), (5u, true, 100)],
            resolver.Requests.Select((props) =>
            {
                return (props.Header.CallId, props.IsAdmitted, props.Payload.Length);
            }));
        Assert.Equal(
            [
                (EnvelopeKind.Failure, 3u, (long)ProtocolCode.AccessDenied),
                (EnvelopeKind.Credit, 5u, 100L),
                (EnvelopeKind.Failure, 7u, (long)ProtocolCode.AccessDenied),
                (EnvelopeKind.Failure, 9u, (long)ProtocolCode.ServiceUnknown),
            ],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Kind, envelope.Header.CallId, envelope.Header is CreditHeader credit ? credit.CreditEnd : (long)envelope.Failure!.Code);
            }));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Reports_a_refusal_of_admission_that_cannot_be_written_and_leaves_no_call_open_behind_it()
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
        foreach (var message in new[] { "thrown", "the admission broke" })
        {
            var server = new Peer(RouterSide.Server);
            var resolver = server.Resolve();
            var broken = new InvalidOperationException(message);

            resolver.Admission = (_) =>
            {
                throw broken;
            };
            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
            Assert.Equal((ushort)ProtocolCode.ProcedureFailed, server.Sent[^1].Failure!.Code);
            Assert.Same(broken, Assert.Single(server.Reports));
            Assert.Empty(resolver.Requests);
            Assert.Equal([Handle], server.ReportedOn);
            Assert.Equal([Handle], server.SentOn);
            Assert.Equal((EnvelopeKind.Failure, 1u), (Assert.Single(server.Sent).Kind, server.Sent[0].Header.CallId));
        }
    }

    [Fact]
    public async Task Refuses_a_request_for_a_destination_a_service_or_a_procedure_it_does_not_know_on_its_call_id_alone()
    {
        var server = new Peer(RouterSide.Server);

        server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9 } });
        await server.Deliver(new Envelope { Header = RequestOf(1) with { ServiceId = 8 } });
        await server.Deliver(new Envelope { Header = RequestOf(3) });
        await server.Deliver(new Envelope { Header = RequestOf(5) with { DestinationId = 4 } }, "b");

        Assert.Equal(
            [(ushort)ProtocolCode.ServiceUnknown, (ushort)ProtocolCode.ProcedureUnknown, (ushort)ProtocolCode.DestinationUnknown],
            server.Sent.Select((envelope) =>
            {
                return envelope.Failure!.Code;
            }));
        Assert.Equal([Handle, Handle, "b"], server.SentOn);

        // the answer names the call alone: no destination, no procedure
        Assert.Equal(
            new IEnvelopeHeader[] { new FailureHeader { CallId = 1 }, new FailureHeader { CallId = 3 }, new FailureHeader { CallId = 5 } },
            server.Sent.Select((envelope) =>
            {
                return envelope.Header;
            }));
        Assert.Equal(
            ("no service 8", (byte)0, FailureScope.Protocol),
            (server.Sent[0].Failure!.Detail, server.Sent[0].Failure!.Relays, server.Sent[0].Failure!.Scope));
    }

    [Fact]
    public async Task Takes_a_request_for_a_destination_to_the_handler_its_port_gives_and_answers_it_by_that_handler_never_a_resolver_at_the_same_address()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default);
        var told = new List<object?>();
        var handler = new Held(server.Core);
        var refusing = new Held(server.Core)
        {
            Admission = (_) =>
            {
                return Failure.OfProtocol(ProtocolCode.AccessDenied);
            },
        };

        // a resolver of this side's at the same address, whose limit is 8 bytes
        var local = server.Resolve(maximumPayloadBytes: 8);

        server.OnBeforeAnswer = (answer) =>
        {
            told.Add(answer.Resolver);

            return null;
        };
        server.Destination = (header) =>
        {
            return header.DestinationId switch
            {
                5 => handler,
                7 => refusing,
                _ => null,
            };
        };
        await server.Deliver(new Envelope { Header = RequestOf(1) with { DestinationId = 5 }, Payload = PatternOf(4) });
        await server.Deliver(new Envelope { Header = RequestOf(3) with { DestinationId = 6 } });
        await server.Deliver(new Envelope { Header = RequestOf(5) with { DestinationId = 7 } });
        await server.Deliver(new Envelope { Header = RequestOf(7) with { DestinationId = 5 } });

        Assert.Equal(
            [(5u, PatternOf(4)), (5u, [])],
            handler.Requests.Select((props) =>
            {
                return (props.Header.DestinationId!.Value, props.Payload.ToArray());
            }));
        Assert.Empty(local.Requests);
        Assert.Empty(refusing.Requests);
        await handler.Answer(0, PatternOf(64)).WaitAsync(Patience, TestContext.Current.CancellationToken);

        // a copy of its header, which names a destination, finds the handler no more, nor a resolver
        await server.Core.Respond(RouterAnswer.OfPayload(PatternOf(64)), new AnswerTarget(Handle, handler.Requests[1].Header with { }))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(
            [(EnvelopeKind.Failure, 3u), (EnvelopeKind.Failure, 5u), (EnvelopeKind.Result, 1u), (EnvelopeKind.Result, 7u)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Kind, envelope.Header.CallId);
            }));
        Assert.Equal(
            [(ushort)ProtocolCode.DestinationUnknown, (ushort)ProtocolCode.AccessDenied],
            server.Sent.Take(2).Select((envelope) =>
            {
                return envelope.Failure!.Code;
            }));
        Assert.Equal("this peer relays nothing, to 6 or elsewhere", server.Sent[0].Failure!.Detail);
        Assert.All(server.Sent.Skip(2), (envelope) =>
        {
            Assert.Equal(PatternOf(64), envelope.Payload.ToArray());
        });

        // a request for a destination is written by the handler it was routed to, never by a resolver
        // of this side's; one routed to none, by none
        Assert.Equal([null, refusing, handler, null], told);
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Refuses_a_request_that_opens_a_subscription_on_a_connection_that_carries_one_way_once_admitted_and_asks_nothing_of_another()
    {
        var server = new Peer(RouterSide.Server)
        {
            TwoWayOf = (connectionHandle) =>
            {
                return connectionHandle != Handle;
            },
        };
        var resolver = server.Resolve();
        var guarded = new Held(server.Core)
        {
            Procedure = Echo with { ProcedureId = 2, ProcedureName = "guarded" },
            Admission = (_) =>
            {
                return Failure.OfProtocol(ProtocolCode.AccessDenied);
            },
        };

        // admitted by nobody: its refusal comes first, and nothing is asked of the connection
        server.Core.RegisterResolver(guarded);
        await server.Deliver(new Envelope { Header = RequestOf(1) with { OpensSubscription = true } });
        await server.Deliver(new Envelope { Header = RequestOf(3) with { OpensSubscription = true, ProcedureId = 2 } });
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        await server.Deliver(new Envelope { Header = RequestOf(7) with { OpensSubscription = true } }, "b");

        // a transfer's opening too, before any credit
        await server.Deliver(new Envelope { Header = RequestOf(9) with { OpensSubscription = true, Total = 400 }, Payload = new byte[4] });

        Assert.Equal(
            [(1u, (ushort)ProtocolCode.SubscriptionUnsupported), (3u, (ushort)ProtocolCode.AccessDenied), (9u, (ushort)ProtocolCode.SubscriptionUnsupported)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, envelope.Failure!.Code);
            }));
        Assert.Equal("this connection carries no notification back", server.Sent[0].Failure!.Detail);
        Assert.Equal(
            [5u, 7u],
            resolver.Requests.Select((props) =>
            {
                return props.Header.CallId;
            }));
        Assert.Equal([Handle, "b", Handle], server.TwoWayAskedOn);
    }

    [Fact]
    public async Task Answers_a_request_of_a_layout_to_come_with_the_layouts_it_reads_under_one_rule()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var never = new TaskCompletionSource();

        // call 7 open, and waiting on its resolver; call 9 one the side holds, a subscription's
        resolver.Handling = (_) =>
        {
            return never.Task;
        };
        server.InUse.Add(9);
        await server.Deliver(new Envelope { Header = RequestOf(7) });

        foreach (var layout in new[] { "A2", "AF" })
        {
            // a free call id of the peer's parity: answered
            await server.Deliver($"{layout} 10 00 03  00 00 00 03  00 02 00 01");

            // this side's parity, an open call, a call the side holds, a result, 7 bytes: reported
            await server.Deliver($"{layout} 10 00 03  00 00 00 04  00 02 00 01");
            await server.Deliver($"{layout} 10 00 03  00 00 00 07  00 02 00 01");
            await server.Deliver($"{layout} 10 00 03  00 00 00 09  00 02 00 01");
            await server.Deliver($"{layout} 11 00 02  00 00 00 0B");
            await server.Deliver($"{layout} 10 00 03  00 00 00");
        }

        Assert.Equal(
            [(3u, (ushort)ProtocolCode.LayoutUnsupported), (3u, (ushort)ProtocolCode.LayoutUnsupported)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, envelope.Failure!.Code);
            }));
        Assert.Equal("0xA1", server.Sent[0].Failure!.Detail);

        // for each layout: this side's parity, an open call, a call held, a result, then 7 bytes
        ushort[] perLayout =
        [
            (ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.LayoutUnsupported,
            (ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.EnvelopeMalformed,
        ];

        Assert.Equal([.. perLayout, .. perLayout], server.Reports.Select(CodeOf));
        Assert.All(server.ReportedOn, (connectionHandle) =>
        {
            Assert.Equal(Handle, connectionHandle);
        });
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
    public async Task Never_answers_what_is_not_an_envelope_and_answers_a_request_of_this_layout_that_does_not_read()
    {
        var server = new Peer(RouterSide.Server);

        await server.Deliver("0A 10 00 03  00 00 00 03  00 02 00 01");
        await server.Deliver("00 10 00 03  00 00 00 03  00 02 00 01");

        // the kept bit
        await server.Deliver("A1 10 01 03  00 00 00 05  00 02 00 01");

        Assert.Equal((5u, (ushort)ProtocolCode.EnvelopeMalformed), (Assert.Single(server.Sent).Header.CallId, server.Sent[0].Failure!.Code));
        Assert.Equal([(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.EnvelopeMalformed], server.Reports.Select(CodeOf));
        Assert.Equal([Handle, Handle], server.ReportedOn);
    }

    [Fact]
    public async Task Answers_an_envelope_larger_than_it_reads_on_its_call_id()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default);
        var large = new byte[16_778_241];

        Vectors.FromHexadecimal("A1 10 00 03  00 00 00 03  00 02 00 01").CopyTo(large, 0);
        server.Core.Receive(large, Handle);
        await server.Settle();

        Assert.Equal((3u, (ushort)ProtocolCode.EnvelopeTooLarge), (Assert.Single(server.Sent).Header.CallId, server.Sent[0].Failure!.Code));
    }

    [Fact]
    public async Task Settles_a_call_with_an_answer_of_this_layout_that_does_not_read_and_never_with_one_of_another()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default);
        using var serverCore = server.Core;
        var first = serverCore.Request(ReadOnlyMemory<byte>.Empty, CallOf("a", (Echo, TimeSpan.FromSeconds(1))));
        var second = serverCore.Request(ReadOnlyMemory<byte>.Empty, CallOf("a", (Echo, TimeSpan.FromMilliseconds(50))));
        var tooLarge = new byte[16_778_241];

        Vectors.FromHexadecimal("A2 11 00 02  00 00 00 04").CopyTo(tooLarge, 0);
        serverCore.Receive(tooLarge, "a");
        await server.Settle();
        await server.Deliver("A2 11 00 02  00 00 00 04", "a");
        await server.Deliver("A2 12 00 02  00 00 00 04  00 13 00 00", "a");
        await server.Deliver("A1 12 00 02  00 00 00 02  00 13 00", "b");
        await server.Deliver("A1 12 00 02  00 00 00 02  00 13 00", "a");

        var malformed = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return first.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.EnvelopeMalformed, FailureOrigin.Local, RouterSide.Server, Echo.Address),
            (malformed.Code, malformed.Origin, malformed.Side, malformed.ProcedureAddress));
        await server.Advance(TimeSpan.FromMilliseconds(50));
        Assert.True(second.IsCompleted);

        var timedOut = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return second.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal("no answer came in 50 milliseconds", timedOut.Message);
        Assert.Equal(
            [(EnvelopeKind.Request, 2u), (EnvelopeKind.Request, 4u), (EnvelopeKind.Cancel, 2u), (EnvelopeKind.Cancel, 4u)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.Kind, envelope.Header.CallId);
            }));
        Assert.Equal(
            [(ushort)ProtocolCode.EnvelopeTooLarge, (ushort)ProtocolCode.LayoutUnsupported,
                (ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.EnvelopeMalformed],
            server.Reports.Select(CodeOf));
        Assert.Equal(["a", "a", "a", "b"], server.ReportedOn);

        var client = new Peer(RouterSide.Client);
        using var clientCore = client.Core;
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
        Assert.Equal(((ushort)ProtocolCode.EnvelopeMalformed, RouterSide.Client), (ended.Code, ended.Side));
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);

        // on another connection, it answers no call
        await client.Deliver("A1 12 00 02  00 00 00 01 | 00", "other");
        Assert.Equal(2, client.Reports.Count);
        Assert.Equal([(ushort)ProtocolCode.LayoutUnsupported, (ushort)ProtocolCode.EnvelopeMalformed], client.Reports.Select(CodeOf));
        Assert.Equal([Handle, "other"], client.ReportedOn);
        Assert.Equal(
            [(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u)],
            client.Sent.Select((envelope) =>
            {
                return (envelope.Header.Kind, envelope.Header.CallId);
            }));
    }

    [Fact]
    public async Task Reports_a_request_of_its_own_parity_or_on_a_call_open_and_answers_the_open_one_once()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var answering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        resolver.Handling = async (props) =>
        {
            await answering.Task;
            await server.Core.Respond(RouterAnswer.OfPayload(new byte[] { (byte)resolver.Requests.Count }), new AnswerTarget(props.ConnectionHandle, props.Header));
        };
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(4) }, "a");

        // the same call id on another connection is another call
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "b");
        answering.SetResult();
        await server.Settle();

        Assert.Equal([(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.EnvelopeMalformed], server.Reports.Select(CodeOf));
        Assert.Equal(["a", "a"], server.ReportedOn);
        Assert.Equal(
            [("a", EnvelopeKind.Result, 5u, 2), ("b", EnvelopeKind.Result, 5u, 2)],
            server.Sent.Zip(server.SentOn).Select((sent) =>
            {
                return (sent.Second, sent.First.Kind, sent.First.Header.CallId, (int)sent.First.Payload.Span[0]);
            }));
        Assert.Equal(2, resolver.Requests.Count);

        // answered, the call id is the peer's again
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        Assert.Equal(3, resolver.Requests.Count);
    }

    // spec 9.0
    [Fact]
    public async Task Answers_a_failed_resolver_s_call_PROCEDURE_FAILED_before_what_its_report_listener_hands_its_router_whose_cancel_crosses_that_answer_and_whose_replacement_opens_the_call_id_again()
    {
        var server = new Peer(RouterSide.Server);
        using var core = server.Core;
        var resolver = server.Resolve();
        var failure = new InvalidOperationException("the resolver failed");

        resolver.Handling = (_) =>
        {
            if (resolver.Requests.Count == 1)
            {
                throw failure;
            }

            return Task.CompletedTask;
        };
        server.OnReport = (_, _) =>
        {
            core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new CancelHeader { CallId = 5 } }), "a");
            core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(5) }), "a");
        };

        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");

        Assert.Equal([failure], server.Reports);
        Assert.Equal(["a"], server.ReportedOn);
        Assert.Equal([(EnvelopeKind.Failure, 5u, (ushort)ProtocolCode.ProcedureFailed)], AnswersOf(server));
        Assert.Equal(2, resolver.Requests.Count);

        // the cancel crossed that answer: it found no call, and cancelled nothing
        Assert.Equal(
            [false, false],
            resolver.Requests.Select((props) =>
            {
                return props.Signal.IsCancellationRequested;
            }));
        Assert.Equal([(5u, "a")], server.Cancels);
        Assert.Equal(1, (await GaugesOf(server)).Counts["answeringCalls"]);

        await resolver.Answer(0, new byte[] { 1 });
        Assert.Single(server.Sent);
        await resolver.Answer(1, new byte[] { 2 });

        Assert.Equal(
            [(EnvelopeKind.Failure, 5u, (ushort)ProtocolCode.ProcedureFailed), (EnvelopeKind.Result, 5u, (ushort)2)],
            AnswersOf(server));
        Assert.Equal(["a", "a"], server.SentOn);
        Assert.Equal(0, (await GaugesOf(server)).Counts["answeringCalls"]);
        Assert.Equal([failure], server.Reports);
    }

    // spec 9.0
    [Fact]
    public async Task Answers_a_failed_admission_s_call_PROCEDURE_FAILED_before_what_its_report_listener_hands_its_router_and_the_replacement_opens_the_call_id_again()
    {
        var server = new Peer(RouterSide.Server);
        using var core = server.Core;
        var resolver = server.Resolve();
        var failure = new InvalidOperationException("the admission failed");

        resolver.Admission = (_) =>
        {
            if (resolver.Admitted == 1)
            {
                throw failure;
            }

            return null;
        };
        server.OnReport = (_, _) =>
        {
            core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new CancelHeader { CallId = 5 } }), "a");
            core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(5) }), "a");
        };

        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");

        Assert.Equal([failure], server.Reports);
        Assert.Equal(["a"], server.ReportedOn);
        Assert.Equal([(EnvelopeKind.Failure, 5u, (ushort)ProtocolCode.ProcedureFailed)], AnswersOf(server));
        Assert.Equal(2, resolver.Admitted);
        Assert.Single(resolver.Requests);
        Assert.Equal(1, (await GaugesOf(server)).Counts["answeringCalls"]);

        await resolver.Answer(0, new byte[] { 2 });

        Assert.Equal(
            [(EnvelopeKind.Failure, 5u, (ushort)ProtocolCode.ProcedureFailed), (EnvelopeKind.Result, 5u, (ushort)2)],
            AnswersOf(server));
        Assert.Equal(0, (await GaugesOf(server)).Counts["answeringCalls"]);
        Assert.Equal([failure], server.Reports);
    }

    // spec 9.0
    [Fact]
    public async Task Lets_its_connections_go_after_the_turn_its_report_listener_disposes_it_in_the_failed_resolver_s_answer_refused_as_disposed_and_reported()
    {
        var server = new Peer(RouterSide.Server);
        var core = server.Core;
        var resolver = server.Resolve();
        var failure = new InvalidOperationException("the resolver failed");

        // what the core holds as its report listener disposes it
        var disposed = new List<(long Answering, bool IsDisposed)>();

        resolver.Handling = (_) =>
        {
            throw failure;
        };
        server.OnReport = (reason, _) =>
        {
            if (ReferenceEquals(reason, failure))
            {
                core.Dispose();
                disposed.Add((core.Gauges().Counts["answeringCalls"], core.IsDisposed));
            }
        };

        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");

        // disposed at once, what it holds let go in a later turn
        Assert.Equal([(1L, true)], disposed);
        Assert.Empty(server.Sent);
        Assert.Equal(2, server.Reports.Count);
        Assert.Same(failure, server.Reports[0]);
        Assert.Equal("the router was disposed", Assert.IsType<DisconnectException>(server.Reports[1]).Message);
        Assert.Equal(["a", "a"], server.ReportedOn);
        Assert.Equal(0, (await GaugesOf(server)).Counts["answeringCalls"]);

        // its call closed as its answer failed, before what the dispose lets go: nothing cancelled
        Assert.False(Assert.Single(resolver.Requests).Signal.IsCancellationRequested);
    }

    [Fact]
    public async Task Lets_go_of_the_call_id_of_a_resolver_that_fails_without_answering_and_of_that_one_alone()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var broken = new InvalidOperationException("rejected");
        var failing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var refusalSent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource();

        server.OnSend = (_) => { refusalSent.TrySetResult(); return Task.CompletedTask; };
        resolver.Handling = (props) =>
        {
            return props.Payload.Span[0] switch
            {
                1 => failing.Task,
                2 => held.Task,
                _ => Task.CompletedTask,
            };
        };
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 1 } });
        failing.SetException(broken);
        await refusalSent.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Settle();
        Assert.Same(broken, Assert.Single(server.Reports));

        // answered PROCEDURE_FAILED, so its requester does not wait out its timeout
        var answered = Assert.Single(server.Sent);

        Assert.Equal((5u, (ushort)ProtocolCode.ProcedureFailed), (answered.Header.CallId, answered.Failure!.Code));

        // free again: a request on it is dispatched, then cancelled, and its call id opened anew
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 2 } });
        Assert.Equal([5u, 5u], resolver.Requests.Select((request) => { return request.Header.CallId; }));
        Assert.Single(server.Sent);
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 5 } });
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 3 } });
        held.SetException(broken);
        await server.Settle();

        // the cancelled one failing is not reported, and closes nothing of the call after it
        Assert.Single(server.Reports);
        await resolver.Answer(2, new byte[] { 3 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.IsType<ResultHeader>(server.Sent[^1].Header);
        Assert.Equal(5u, server.Sent[^1].Header.CallId);
        Assert.Equal(new byte[] { 3 }, server.Sent[^1].Payload.ToArray());
        Assert.Equal([Handle], server.ReportedOn);
        Assert.Equal(3, resolver.Requests.Count);
    }

    [Fact]
    public async Task Sends_nothing_for_an_answer_whose_call_its_connection_took_away_though_the_peer_opens_its_call_id_again()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 1 } });
        server.Core.RejectPending("the connection closed", Handle);
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 2 } });
        await resolver.Answer(0, new byte[] { 0 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Empty(server.Sent);
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = new byte[] { 3 } });
        await resolver.Answer(1, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(new byte[] { 1 }, Assert.Single(server.Sent).Payload.ToArray());
        Assert.Equal(5u, server.Sent[0].Header.CallId);
        Assert.Equal([5u, 5u], resolver.Requests.Select((request) => { return request.Header.CallId; }));
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(Assert.Single(server.Reports)));
        Assert.Equal([Handle], server.ReportedOn);
    }

    [Fact]
    public async Task Lets_a_resolver_that_fails_after_it_answered_take_nothing_from_the_call_holding_its_call_id_now()
    {
        var crossing = new Peer(RouterSide.Server);
        using var crossingCore = crossing.Core;
        var heldResolver = crossing.Resolve();
        var failing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var holding = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var late = new InvalidOperationException("late");

        heldResolver.Handling = async (props) =>
        {
            if (heldResolver.Requests.Count == 1)
            {
                await crossingCore.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(props.ConnectionHandle, props.Header));
                await failing.Task;
            }
            else
            {
                await holding.Task;
            }
        };
        await crossing.Deliver(new Envelope { Header = RequestOf(5) });
        await crossing.Deliver(new Envelope { Header = RequestOf(5) });
        Assert.Equal(2, heldResolver.Requests.Count);
        failing.SetException(late);
        await crossing.Settle();
        await crossing.Deliver(new Envelope { Header = RequestOf(5) });
        Assert.Equal([5u, 5u], heldResolver.Requests.Select((props) =>
        {
            return props.Header.CallId;
        }));
        Assert.Same(late, crossing.Reports[0]);
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(crossing.Reports[1]));
        Assert.Equal(2, crossing.Reports.Count);
        Assert.Equal([Handle, Handle], crossing.ReportedOn);
        Assert.Equal(5u, Assert.IsType<ResultHeader>(Assert.Single(crossing.Sent).Header).CallId);
        Assert.Empty(crossing.Sent[0].Payload.ToArray());
        holding.SetResult();
        await crossing.Settle();

        var server = new Peer(RouterSide.Server);
        using var serverCore = server.Core;
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
        Assert.Equal(new byte[] { 1 }, server.Sent[0].Payload.ToArray());

        // the call after it on its call id stays open: the same call id again is refused
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 3 } });
        Assert.Equal(2, resolver.Requests.Count);
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(server.Reports[^1]));
        Assert.Equal(2, server.Reports.Count);
        Assert.Equal([Handle, Handle], server.ReportedOn);
    }

    [Fact]
    public async Task Routes_a_request_that_opens_a_transfer_then_refuses_it_its_route_first()
    {
        var server = new Peer(RouterSide.Server);
        var payload = PatternOf(300);

        var resolver = server.Resolve();
        await server.Deliver(new Envelope { Header = RequestOf(1) with { ServiceId = 8, Total = 0x2800000 } });
        await server.Deliver(new Envelope { Header = RequestOf(3) with { DestinationId = 4, Total = 0x2800000 } });
        await server.Deliver(new Envelope { Header = RequestOf(5) with { Total = 0x2800000 }, Payload = new byte[] { 1 } });
        await server.Deliver(new Envelope { Header = new RequestHeader { CallId = 7, ServiceId = 9, ProcedureId = 1, Total = 300 }, Payload = payload.AsMemory(0, 44) });
        await server.Deliver(new Envelope { Header = RequestOf(9) with { DestinationId = 7, Total = 300 }, Payload = payload.AsMemory(0, 40) });
        Assert.Equal(
            [(ushort)ProtocolCode.ServiceUnknown, (ushort)ProtocolCode.DestinationUnknown, (ushort)ProtocolCode.PayloadTooLarge, (ushort)ProtocolCode.ServiceUnknown, (ushort)ProtocolCode.DestinationUnknown],
            server.Sent.Select((envelope) =>
            {
                return envelope.Failure!.Code;
            }));
        Assert.Equal([1u, 3u, 5u, 7u, 9u], server.Sent.Select((envelope) => { return envelope.Header.CallId; }));
        Assert.Empty(resolver.Requests);
    }

    [Fact]
    public async Task Hands_a_notification_to_the_side_that_takes_them_and_reports_it_where_none_does()
    {
        var taking = new Peer(RouterSide.Client) { TakesNotifications = true };
        var refusing = new Peer(RouterSide.Client);
        var notification = new Envelope { Header = new NotificationHeader { CallId = 41 }, Payload = new byte[] { 1 } };

        await taking.Deliver(notification, "b");
        await refusing.Deliver(notification, "b");

        var (header, connectionHandle, payload) = Assert.Single(taking.Notifications);

        Assert.Equal((new NotificationHeader { CallId = 41 }, "b"), (header, connectionHandle));
        Assert.Equal(new byte[] { 1 }, payload);
        Assert.Empty(taking.Reports);
        Assert.Equal((ushort)ProtocolCode.KindUnsupported, CodeOf(Assert.Single(refusing.Reports)));
        Assert.Equal(["b"], refusing.ReportedOn);
        Assert.Empty(refusing.Sent);
    }

    [Fact]
    public async Task Hands_a_credit_of_notifications_to_the_side_that_paces_them_a_transfer_s_to_its_transfer_and_reports_it_where_none_does()
    {
        var pacing = new Peer(RouterSide.Server) { SendsNotifications = true };
        var refusing = new Peer(RouterSide.Server);
        var credit = new Envelope { Header = new CreditHeader { CallId = 41, CreditEnd = 3, Paced = true } };

        await pacing.Deliver(credit, "b");

        // a transfer's, on the same call id, sends no transfer and reaches no pacing
        await pacing.Deliver(CreditOf(41, 5), "b");
        await refusing.Deliver(credit, "b");

        Assert.Equal([(new CreditHeader { CallId = 41, CreditEnd = 3, Paced = true }, "b")], pacing.SubscriptionCredits);
        Assert.Empty(pacing.Reports);
        Assert.Empty(pacing.Sent);

        var reported = Assert.IsType<FailureException>(Assert.Single(refusing.Reports));

        Assert.Equal((ushort)ProtocolCode.KindUnsupported, reported.Code);
        Assert.Contains("this side sends no notification", reported.Message, StringComparison.Ordinal);
        Assert.Equal(["b"], refusing.ReportedOn);
        Assert.Empty(refusing.Sent);
    }

    [Fact]
    public async Task Reports_a_resolver_that_throws_or_rejects_with_its_connection()
    {
        var server = new Peer(RouterSide.Server);
        var thrown = new InvalidOperationException("thrown");
        var rejected = new InvalidOperationException("rejected");

        server.Core.RegisterResolver(new Held(server.Core)
        {
            Handling = (_) =>
            {
                throw thrown;
            },
        });
        server.Core.RegisterResolver(new Held(server.Core)
        {
            Procedure = Echo with { ProcedureId = 2, ProcedureName = "rejecting" },
            Handling = (_) =>
            {
                return Task.FromException(rejected);
            },
        });
        await server.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(3) with { ProcedureId = 2 } }, "b");

        Assert.Equal([thrown, rejected], server.Reports);
        Assert.Equal(["a", "b"], server.ReportedOn);
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

        // its reason in its words, past the procedure it names
        void Refuses(Held resolver, string reason)
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                server.Core.RegisterResolver(resolver);
            });

            Assert.Contains($" is {reason}: ", refused.Message, StringComparison.Ordinal);
        }

        server.Resolve();
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureName = "again" } });
        });

        // * a ushort holds no id past 65535, and an int no revision past 2³¹ − 1: what remains is 0
        foreach (var procedure in new[] { Echo with { ProcedureId = 0 }, Echo with { ServiceId = 0 }, Echo with { ProcedureId = 2, ServiceRevision = 0 } })
        {
            Refuses(new Held(server.Core) { Procedure = procedure }, "out of its range");
        }

        foreach (var name in new[] { "Echo", "_OTHER", "echo\n", "get_thing", new string('a', 64) })
        {
            Refuses(new Held(server.Core) { Procedure = Echo with { ProcedureId = 2, ProcedureName = name } }, "off its form");
        }

        // its identity before any reason of the router's: a payload limit of 0, at service 0
        Assert.Throws<ArgumentException>(() =>
        {
            server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ProcedureId = 9 }, MaximumPayloadBytes = 0 });
        });
        Refuses(new Held(server.Core) { Procedure = Echo with { ServiceId = 0 }, MaximumPayloadBytes = 0 }, "out of its range");
        server.Core.RegisterResolver(new Held(server.Core) { Procedure = Echo with { ServiceId = ushort.MaxValue, ProcedureId = ushort.MaxValue, ServiceRevision = int.MaxValue } });
    }

    [Fact]
    public async Task Its_answers_name_their_call_alone_a_result_with_its_payload_a_failure_with_its_record()
    {
        var server = new Peer(RouterSide.Server);

        await server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 4 }), new AnswerTarget("b", RequestOf(77)))
            .WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Core.Respond(
            RouterAnswer.OfFailure(Failure.OfApplication(12, "why")),
            new AnswerTarget("a", RequestOf(77) with { DestinationId = 3 })).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(["b", "a"], server.SentOn);
        Assert.Equal(new ResultHeader { CallId = 77 }, server.Sent[0].Header);
        Assert.Equal(new byte[] { 4 }, server.Sent[0].Payload.ToArray());
        Assert.Equal(new FailureHeader { CallId = 77 }, server.Sent[1].Header);
        Assert.Equal(
            new Failure { Code = 12, Detail = "why", Relays = 0, Scope = FailureScope.Application },
            server.Sent[1].Failure);
    }

    [Fact]
    public async Task Keeps_a_call_open_when_its_answer_cannot_go_out_so_a_fallback_answers_it()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default);
        var resolver = server.Resolve();
        var retrying = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var answers = new List<Task>();

        resolver.Handling = async (props) =>
        {
            var target = new AnswerTarget(props.ConnectionHandle, props.Header);

            try
            {
                await server.Core.Respond(RouterAnswer.OfPayload(new byte[0x1000001]), target);
            }
            catch (FailureException)
            {
                await retrying.Task;
                answers.Add(server.Core.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.ProcedureFailed)), target));
            }
        };
        await server.Deliver(new Envelope { Header = RequestOf(5) });

        // its answer did not go out: the call is open still, and the same call id is refused
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        retrying.SetResult();
        await server.Settle();
        await Task.WhenAll(answers).WaitAsync(Patience, TestContext.Current.CancellationToken);

        // answered at last: a request on the same call id is dispatched
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        await Task.WhenAll(answers).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(
            [(5u, (ushort)ProtocolCode.ProcedureFailed), (5u, (ushort)ProtocolCode.ProcedureFailed)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, envelope.Failure!.Code);
            }));
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(Assert.Single(server.Reports)));
        Assert.Equal(2, resolver.Requests.Count);
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
        var ordered = new Peer(RouterSide.Server);
        using var orderedCore = ordered.Core;
        var told = new List<string>();

        ordered.Resolve();
        ordered.OnBeforeAnswer = (answer) =>
        {
            var kind = answer.IsFailure ? "failure" : "result";
            var name = (answer.Resolver as IRequestResolver)?.Procedure.ProcedureName ?? "undefined";
            told.Add($"{kind} {answer.Target.ConnectionHandle} {name} after {ordered.Sent.Count} sent");
            return () => { told.Add($"undo {answer.Target.ConnectionHandle}"); };
        };
        ordered.OnSend = (envelope) =>
        {
            return envelope.Header.CallId == 5 ? Task.FromException(new IOException("gone")) : Task.CompletedTask;
        };
        await orderedCore.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget("a", RequestOf(1)));
        await orderedCore.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.AccessDenied)), new AnswerTarget("a", RequestOf(3)));
        var rejected = await Assert.ThrowsAsync<IOException>(() =>
        {
            return orderedCore.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget("b", RequestOf(5))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal("gone", rejected.Message);
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return orderedCore.Respond(RouterAnswer.OfPayload(new byte[0x1000001]), new AnswerTarget("a", RequestOf(7))).WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);
        Assert.Equal(["result a echo after 0 sent", "failure a echo after 1 sent", "result b echo after 2 sent", "undo b"], told);
        Assert.Equal((3, 1), (ordered.BeforeAnswers, ordered.Undone));

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
        var token = SessionToken.FromBytes(Enumerable.Repeat((byte)1, 16).ToArray());
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

        var announced = new Peer(RouterSide.Server) { Session = token };
        using var announcedCore = announced.Core;
        announced.Resolve();
        await announcedCore.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(1)));
        await announced.Deliver(new Envelope { Header = RequestOf(3) with { Credential = Credential.Jwt("a.b.c") } });
        Assert.Equal(
            new (DebugDirection, IEnvelopeHeader)[] {
                (DebugDirection.Tx, new ResultHeader { CallId = 1, Credential = Credential.Opaque() }),
                (DebugDirection.Rx, RequestOf(3) with { Credential = Credential.SchemeOf(CredentialScheme.Jwt) }),
                (DebugDirection.Tx, new FailureHeader { CallId = 3 }),
            }, announced.Traces.Select((trace) => { return (trace.Direction, trace.Envelope.Header); }));
        Assert.Equal(token, ((ResultHeader)announced.Sent[0].Header).Credential!.Value.SessionToken);
        foreach (var peer in new[] { server, announced })
        {
            var serialized = System.Text.Json.JsonSerializer.Serialize(peer.Traces.Select((trace) =>
            {
                return new { trace.Direction, trace.Envelope.ConnectionHandle, Header = System.Text.Json.JsonSerializer.SerializeToElement(trace.Envelope.Header, trace.Envelope.Header.GetType()) };
            }));
            Assert.DoesNotContain(token.ToString(), serialized, StringComparison.Ordinal);
            Assert.DoesNotContain("a.b.c", serialized, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Forgets_a_call_its_requester_cancels_then_cancels_its_signal_nothing_answers_it_and_its_call_id_is_free()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var answers = new List<Task>();

        // an answer from what hears the signal finds no call to answer
        resolver.Handling = (props) =>
        {
            props.Signal.Register(() =>
            {
                answers.Add(server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header)));
            });

            return Task.Delay(Timeout.InfiniteTimeSpan, props.Signal);
        };
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 5 } });
        Assert.True(resolver.Requests[0].Signal.IsCancellationRequested);
        await Task.WhenAll(answers).WaitAsync(Patience, TestContext.Current.CancellationToken);

        // free again: a request on it is dispatched
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        Assert.Equal([5u, 5u], resolver.Requests.Select((props) =>
        {
            return props.Header.CallId;
        }));
        _ = Assert.Single(answers);
        Assert.Equal([(5u, Handle)], server.Cancels);

        // nor is the resolver that stopped reported: its call is no one's to hear of
        Assert.Empty(server.Reports);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Takes_a_cancel_of_no_call_in_silence_offered_to_the_side_and_reports_one_of_its_own_parity()
    {
        var server = new Peer(RouterSide.Server);

        // crossed its answer, say
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 7 } });

        // a call this side opened is not the peer's to cancel
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 2 } });

        Assert.Equal([(7u, Handle)], server.Cancels);
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, CodeOf(Assert.Single(server.Reports)));
        Assert.Equal([Handle], server.ReportedOn);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Cancels_the_signal_of_each_call_a_closing_connection_opened_and_of_no_other_once_nothing_can_answer_it()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var answers = new List<Task>();

        // what closed may answer nothing
        resolver.Handling = (props) =>
        {
            props.Signal.Register(() =>
            {
                answers.Add(server.Core.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header)));
            });

            return Task.Delay(Timeout.InfiniteTimeSpan, props.Signal);
        };
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "b");
        server.Core.RejectPending("a closed", "a");
        await server.Settle();
        Assert.Equal([true, false], resolver.Requests.Select((props) =>
        {
            return props.Signal.IsCancellationRequested;
        }));
        await Task.WhenAll(answers).WaitAsync(Patience, TestContext.Current.CancellationToken);
        _ = Assert.Single(answers);
        Assert.Empty(server.Sent);
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Says_whether_the_call_of_a_request_is_open_still()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var never = new TaskCompletionSource();

        resolver.Handling = (_) =>
        {
            return never.Task;
        };
        await server.Deliver(new Envelope { Header = RequestOf(5) });
        await server.Deliver(new Envelope { Header = RequestOf(7) });

        var cancelled = new AnswerTarget(Handle, resolver.Requests[0].Header);
        var answered = new AnswerTarget(Handle, resolver.Requests[1].Header);

        // asked on the core's scheduler, as its router asks
        Task<bool[]> IsAnswering(params AnswerTarget[] targets)
        {
            return server.Loop.Run(() =>
            {
                return Task.FromResult(targets.Select(server.Core.IsAnswering).ToArray());
            });
        }

        var open = await IsAnswering(cancelled, answered);

        Assert.Equal([true, true], open);
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 5 } });
        await resolver.Answer(1, ReadOnlyMemory<byte>.Empty).WaitAsync(Patience, TestContext.Current.CancellationToken);
        var ended = await IsAnswering(cancelled, answered);

        Assert.Equal([false, false], ended);

        // a request never dispatched says nothing against it
        var undispatched = await IsAnswering(new AnswerTarget(Handle, RequestOf(9)));

        Assert.Equal([true], undispatched);
    }

    [Fact]
    public async Task Once_disposed_rejects_what_waits_and_sends_nothing_more()
    {
        var server = new Peer(RouterSide.Server);
        var incoming = server.Resolve();
        var answering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? lateAnswer = null;

        incoming.Handling = async (props) =>
        {
            await answering.Task;
            lateAnswer = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(props.ConnectionHandle, props.Header));
        };

        var waiting = server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1));

        await server.Deliver(new Envelope { Header = RequestOf(5) });
        Assert.False(server.Core.IsDisposed);
        server.Core.Dispose();
        await server.Settle();
        Assert.True(server.Core.IsDisposed);
        Assert.Equal(2u, Assert.IsType<RequestHeader>(Assert.Single(server.Sent).Header).CallId);
        server.Sent.Clear();
        Assert.Equal("the router was disposed before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Message);
        answering.SetResult();
        await server.Settle();
        Assert.NotNull(lateAnswer);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return lateAnswer.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        server.Core.Cancel(new CallAddress(2, Handle));
        await server.Settle();
        Assert.Empty(server.Reports);
        Assert.Equal(0, server.Core.Gauges().Counts["reservedCallIds"]);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(Handle, RequestOf(1)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return server.Core.Send(new Envelope { Header = new NotificationHeader { CallId = 1 } }, Handle)
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Empty(server.Sent);

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
        Assert.Empty(client.Reports);
        Assert.Equal(0, client.Core.Gauges().Counts["reservedCallIds"]);
    }

    [Fact]
    public async Task Reports_a_chunk_no_transfer_takes_on_a_call_open_without_one_or_on_none_and_drops_one_on_a_call_id_reserved_and_a_credit_in_silence()
    {
        var server = new Peer(RouterSide.Server);
        var asking = server.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1));

        server.Resolve();
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(1) });
        server.Core.Reserve(new CallAddress(6, Handle), TimeSpan.FromSeconds(5));

        // the peer's call open, and none; this side's, then none; then one on a call id reserved
        foreach (var callId in new uint[] { 1, 3, 2, 4, 6 })
        {
            await server.Deliver(new Envelope { Header = new ChunkHeader { CallId = callId, IsLast = false, Offset = 0 }, Payload = new byte[] { 1 } });
        }

        foreach (var callId in new uint[] { 1, 2, 9 })
        {
            await server.Deliver(CreditOf(callId, 8));
        }

        Assert.Equal([(EnvelopeKind.Request, 2u)], server.Sent.Select((envelope) =>
        {
            return (envelope.Kind, envelope.Header.CallId);
        }));
        Assert.Equal(
            [(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.CallUnknown, (ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.CallUnknown],
            server.Reports.Select(CodeOf));
        Assert.Contains("call 1 receives no transfer", server.Reports[0].Message, StringComparison.Ordinal);
        Assert.Contains("call 2 receives no transfer", server.Reports[2].Message, StringComparison.Ordinal);
        Assert.Equal([Handle, Handle, Handle, Handle], server.ReportedOn);
        server.Core.Cancel(new CallAddress(2, Handle));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Frees_the_call_of_an_answer_that_could_not_go_out_so_its_call_id_opens_again()
    {
        foreach (var message in new[] { "the transport is closing", "the transport refused the result" })
        {
            var server = new Peer(RouterSide.Server);
            var resolver = server.Resolve();

            // a transport that throws as it is handed the first answer
            server.OnSend = (envelope) =>
            {
                return envelope.Header is ResultHeader && server.Sent.Count == 1 ? throw new IOException(message) : Task.CompletedTask;
            };
            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = message == "the transport is closing" ? Array.Empty<byte>() : new byte[] { 1 } });
            var refused = await Assert.ThrowsAsync<IOException>(() =>
            {
                return resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.Equal(message, refused.Message);
            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = message == "the transport is closing" ? Array.Empty<byte>() : new byte[] { 2 } });
            Assert.Equal(2, resolver.Requests.Count);
            Assert.Empty(server.Reports);
        }
    }

    [Fact]
    public async Task Answers_CAPACITY_EXCEEDED_a_request_past_the_calls_its_peer_has_it_answer_on_its_connection_before_its_route_its_credential_or_its_transfer_and_takes_one_once_a_call_ends()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { MaximumAnsweringCalls = 2, MaximumEnvelopeBytes = 1_024, ChunkBytes = 64, WindowBytes = 128 })
        {
            Schemes = [CredentialScheme.Jwt],
        };
        var resolver = server.Resolve();
        var payload = PatternOf(100);

        await server.Deliver(new Envelope { Header = RequestOf(1) });
        await server.Deliver(new Envelope { Header = RequestOf(3) });

        // another connection's calls are its own
        await server.Deliver(new Envelope { Header = RequestOf(1) }, "b");
        await server.Deliver(new Envelope { Header = RequestOf(5) with { ServiceId = 8 } });
        await server.Deliver(new Envelope { Header = RequestOf(7) with { DestinationId = 4 } });
        await server.Deliver(new Envelope { Header = RequestOf(9) with { Credential = Credential.Jwt("a.b.c") } });
        await server.Deliver(new Envelope { Header = RequestOf(11) with { Total = 100 }, Payload = payload.AsMemory(0, 8) });

        Assert.Equal(3, resolver.Requests.Count);
        Assert.DoesNotContain(server.Resolved, (resolved) =>
        {
            return resolved.Request.Header.Credential is not null;
        });
        Assert.Equal(
            [(5u, (ushort)ProtocolCode.CapacityExceeded), (7u, (ushort)ProtocolCode.CapacityExceeded), (9u, (ushort)ProtocolCode.CapacityExceeded), (11u, (ushort)ProtocolCode.CapacityExceeded)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, envelope.Failure!.Code);
            }));
        Assert.Equal("the calls a connection has answered at once are 2 at most", server.Sent[0].Failure!.Detail);

        // a call answered gives its place back, and the next request is taken
        await resolver.Answer(0, ReadOnlyMemory<byte>.Empty);
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(13) });

        Assert.Equal(4, resolver.Requests.Count);
        Assert.Equal(13u, resolver.Requests[3].Header.CallId);
    }

    [Fact]
    public async Task Answers_ENVELOPE_TOO_LARGE_a_request_that_came_whole_past_chunkBytes_and_holds_nothing_of_it()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumEnvelopeBytes = 1_024 });
        var resolver = server.Resolve();

        // 12 bytes of header, then 53 of payload: one past chunkBytes, within an envelope
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = PatternOf(53) });

        // an opening past it too
        await server.Deliver(new Envelope { Header = RequestOf(3) with { Total = 300 }, Payload = PatternOf(49) });

        // a request of chunkBytes, taken
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = PatternOf(52) });

        Assert.Equal(
            [(1u, (ushort)ProtocolCode.EnvelopeTooLarge), (3u, (ushort)ProtocolCode.EnvelopeTooLarge)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Header.CallId, envelope.Failure!.Code);
            }));
        Assert.Equal("a request is 64 bytes at most, not 65", server.Sent[0].Failure!.Detail);
        Assert.Equal(
            [5u],
            resolver.Requests.Select((request) =>
            {
                return request.Header.CallId;
            }));

        var counts = (await GaugesOf(server)).Counts;

        Assert.Equal((1L, 0L), (counts["answeringCalls"], counts["receivingTransfers"]));
    }
}
