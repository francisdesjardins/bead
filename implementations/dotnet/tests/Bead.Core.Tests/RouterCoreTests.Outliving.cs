using System.Text;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s resolvers that outlive their call: each keeps its call's place until it
/// settles, within twice the calls a connection has it answer (spec 9.2, step 3), one whose call ended
/// before its turn is handed nothing, and a connection refused past them, request after request, is
/// closed.
/// </summary>
public sealed partial class RouterCoreTests
{
    // helpers

    // a server's core whose resolver of echo holds each call it is handed until the test settles it,
    // deaf to its signal; one whose payload says answer answers first
    private static (Peer Server, Held Resolver, List<TaskCompletionSource> Held) HoldingOf(int maximumAnsweringCalls)
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumAnsweringCalls = maximumAnsweringCalls, MaximumEnvelopeBytes = 1_024 });
        var resolver = server.Resolve();
        var held = new List<TaskCompletionSource>();

        resolver.Handling = async (props) =>
        {
            var holding = new TaskCompletionSource();

            held.Add(holding);

            if (props.Payload.Span.SequenceEqual(AnswerBytes))
            {
                await server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(props.ConnectionHandle, props.Header));
            }

            await holding.Task;
        };

        return (server, resolver, held);
    }

    // the payload that has a holding resolver answer first
    private static byte[] AnswerBytes { get; } = Encoding.UTF8.GetBytes("answer");

    // the counts of the calls a connection has it answer and of the resolvers that outlive them
    private static async Task<(long AnsweringCalls, long LargestTrackedCalls, long OutlivingResolvers)> TrackedOf(Peer peer)
    {
        var counts = (await GaugesOf(peer)).Counts;

        return (counts["answeringCalls"], counts["largestTrackedCalls"], counts["outlivingResolvers"]);
    }

    // each failure a peer was sent: its call id, its code and its detail
    private static List<(uint CallId, ushort Code, string Detail)> FailuresOf(Peer peer)
    {
        return [.. peer.Sent.Where((envelope) =>
        {
            return envelope.Failure is not null;
        }).Select((envelope) =>
        {
            return (envelope.Header.CallId, envelope.Failure!.Code, envelope.Failure.Detail);
        })];
    }

    // the call ids a resolver was handed, in order
    private static List<uint> CallIdsOf(Held resolver)
    {
        return [.. resolver.Requests.Select((props) =>
        {
            return props.Header.CallId;
        })];
    }

    private static Envelope CancelOf(uint callId)
    {
        return new Envelope { Header = new CancelHeader { CallId = callId } };
    }

    // definition

    [Fact]
    public async Task Holds_a_call_whose_resolver_outlives_its_cancel_among_the_calls_it_counts_until_that_resolver_settles_and_answers_CAPACITY_EXCEEDED_a_request_that_comes_while_they_and_the_calls_it_answers_number_twice_maximumAnsweringCalls()
    {
        var (server, resolver, held) = HoldingOf(2);

        await server.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");

        // * both resolvers run on past their cancel: the calls leave, their places stay
        await server.Deliver(CancelOf(1), "a");
        await server.Deliver(CancelOf(3), "a");
        Assert.Equal((0L, 2L, 2L), await TrackedOf(server));

        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(7) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(9) }, "a");
        Assert.Equal([1u, 3u, 5u, 7u], CallIdsOf(resolver));
        Assert.Equal(
            [(9u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection answers and those its resolvers outlive are 4 at most")],
            FailuresOf(server));

        // one settles: its place goes back among both counts, while the calls answered stay at their
        // own bound
        held[0].SetResult();
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(11) }, "a");
        Assert.Equal((11u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection has answered at once are 2 at most"), FailuresOf(server)[^1]);

        // a call cancelled leaves room among the calls answered, and the next is taken
        await server.Deliver(CancelOf(5), "a");
        await server.Deliver(new Envelope { Header = RequestOf(13) }, "a");

        // another connection's counts are its own
        await server.Deliver(new Envelope { Header = RequestOf(1) }, "b");
        Assert.Equal([1u, 3u, 5u, 7u, 13u, 1u], CallIdsOf(resolver));
        Assert.Equal((3L, 4L, 2L), await TrackedOf(server));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Holds_a_call_whose_resolver_outlives_its_answer_among_the_calls_it_counts_until_that_resolver_settles()
    {
        var (server, resolver, held) = HoldingOf(1);

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = AnswerBytes }, "a");

        // answered, its resolver runs on: the call left, its place stays
        Assert.Equal([(EnvelopeKind.Result, 1u)], server.Sent.Select((envelope) =>
        {
            return (envelope.Kind, envelope.Header.CallId);
        }));
        Assert.Equal((0L, 1L, 1L), await TrackedOf(server));

        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        Assert.Equal([1u, 3u], CallIdsOf(resolver));
        Assert.Equal(
            [(5u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection answers and those its resolvers outlive are 2 at most")],
            FailuresOf(server));

        held[0].SetResult();
        await server.Settle();
        Assert.Equal((1L, 1L, 0L), await TrackedOf(server));

        // the calls answered at their own bound still refuse the next, by their own detail
        await server.Deliver(new Envelope { Header = RequestOf(7) }, "a");
        Assert.Equal((7u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection has answered at once are 1 at most"), FailuresOf(server)[^1]);
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Gives_a_place_back_as_the_resolver_that_outlives_its_call_settles_whether_it_resolves_rejects_or_throws()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumAnsweringCalls = 1, MaximumEnvelopeBytes = 1_024 });
        var resolver = server.Resolve();
        var settling = new Dictionary<uint, TaskCompletionSource>();

        resolver.Handling = (props) =>
        {
            // its answer gone, it throws before it returns
            if (Encoding.UTF8.GetString(props.Payload.Span) == "throws")
            {
                _ = server.Core.Respond(RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty), new AnswerTarget(props.ConnectionHandle, props.Header));

                throw new InvalidOperationException("thrown");
            }

            var holding = new TaskCompletionSource();

            settling[props.Header.CallId] = holding;

            return holding.Task;
        };

        async Task<long> Outliving()
        {
            return (await GaugesOf(server)).Counts["outlivingResolvers"];
        }

        // it resolves, past its cancel
        await server.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        await server.Deliver(CancelOf(1), "a");
        Assert.Equal(1, await Outliving());
        settling[1].SetResult();
        await server.Settle();
        Assert.Equal(0, await Outliving());

        // it rejects, past its cancel: reported by none, its call no one's to hear of
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");
        await server.Deliver(CancelOf(3), "a");
        Assert.Equal(1, await Outliving());
        settling[3].SetException(new InvalidOperationException("rejected"));
        await server.Settle();
        Assert.Equal(0, await Outliving());

        // it throws past its answer, in the turn it was handed: reported, its place back
        await server.Deliver(new Envelope { Header = RequestOf(5), Payload = Encoding.UTF8.GetBytes("throws") }, "a");
        Assert.Equal(0, await Outliving());

        // no place held: the next is taken, and the one after refused at the calls answered alone
        await server.Deliver(new Envelope { Header = RequestOf(7) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(9) }, "a");
        Assert.Equal([1u, 3u, 7u], settling.Keys);
        Assert.Equal(
            [(EnvelopeKind.Result, 5u, (ushort)0), (EnvelopeKind.Failure, 9u, (ushort)ProtocolCode.CapacityExceeded)],
            server.Sent.Select((envelope) =>
            {
                return (envelope.Kind, envelope.Header.CallId, envelope.Failure?.Code ?? 0);
            }));
        Assert.Equal("the calls a connection has answered at once are 1 at most", server.Sent[^1].Failure!.Detail);
        Assert.Equal(["thrown"], server.Reports.Select((reason) =>
        {
            return reason.Message;
        }));
        Assert.Equal(["a"], server.ReportedOn);
    }

    [Fact]
    public async Task Holds_a_peer_that_cancels_each_request_it_sends_to_twice_maximumAnsweringCalls_resolvers_at_once_however_many_it_sends()
    {
        var server = new Peer(RouterSide.Server, RouterLimits.Default with { MaximumAnsweringCalls = 2 });
        var resolver = server.Resolve();
        var (live, largest) = (0, 0);

        resolver.Handling = (_) =>
        {
            live += 1;
            largest = Math.Max(largest, live);

            // deaf to its signal, it never settles
            return new TaskCompletionSource().Task;
        };

        // * the review's probe: a request, its resolver handed it, then its cancel, 200 times
        for (var round = 0u; round < 200; round += 1)
        {
            var callId = (2 * round) + 1;

            await server.Deliver(new Envelope { Header = RequestOf(callId) }, "a");
            await server.Deliver(CancelOf(callId), "a");
        }

        Assert.Equal((4, 4), (live, largest));
        Assert.Equal(196, server.Sent.Count((envelope) =>
        {
            return envelope.Failure?.Code == (ushort)ProtocolCode.CapacityExceeded;
        }));
        Assert.Equal(196, server.Sent.Count);
        Assert.Equal((0L, 4L, 4L), await TrackedOf(server));
    }

    [Fact]
    public async Task Holds_a_call_cancelled_while_its_credential_resolves_among_the_calls_it_counts_until_its_verifier_settles()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumAnsweringCalls = 1, MaximumEnvelopeBytes = 1_024 })
        {
            Schemes = [CredentialScheme.Jwt],
        };
        var resolver = server.Resolve();
        var verifying = new List<TaskCompletionSource<CallSession?>>();

        server.Resolution = (request, _) =>
        {
            if (request.Header.Credential is null)
            {
                return ValueTask.FromResult<CallSession?>(null);
            }

            var resolution = new TaskCompletionSource<CallSession?>();

            verifying.Add(resolution);

            return new ValueTask<CallSession?>(resolution.Task);
        };
        resolver.Handling = (_) =>
        {
            return new TaskCompletionSource().Task;
        };
        await server.Deliver(new Envelope { Header = RequestOf(1) with { Credential = Credential.Jwt("a.b.c") } }, "a");
        await server.Deliver(CancelOf(1), "a");

        // * its verifier told, it runs on: the call left, its place stays
        Assert.True(server.Resolved[0].Signal.IsCancellationRequested);
        Assert.Equal((0L, 1L, 1L), await TrackedOf(server));

        // a call beside it, which its resolver leaves open, then one past both refused
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        Assert.Equal(
            [(5u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection answers and those its resolvers outlive are 2 at most")],
            FailuresOf(server));

        // its verifier settles, to a session dropped in silence: its place goes back
        verifying[0].SetResult(new CallSession { Data = "ada" });
        await server.Settle();
        Assert.Equal((1L, 1L, 0L), await TrackedOf(server));

        await server.Deliver(new Envelope { Header = RequestOf(7) }, "a");
        Assert.Equal((7u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection has answered at once are 1 at most"), FailuresOf(server)[^1]);
        Assert.Equal([3u], CallIdsOf(resolver));
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Hands_nothing_to_the_resolver_of_a_request_whose_cancel_came_in_the_same_read()
    {
        var resolvers = new DrivenScheduler();
        var server = new Peer(RouterSide.Server, new PeerOptions { Resolvers = resolvers });
        var resolver = server.Resolve();

        // ! each request and its cancel received in one turn of the router, before its resolver's
        // own: its call ended before that turn came
        for (var callId = 1u; callId < 200; callId += 2)
        {
            server.Core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(callId) }), "a");
            server.Core.Receive(EnvelopeCodec.WriteEnvelope(CancelOf(callId)), "a");
        }

        await server.Settle();
        resolvers.RunAll();
        await server.Settle();

        Assert.Empty(resolver.Requests);
        Assert.Empty(server.Sent);
        Assert.Empty(server.Reports);
        Assert.Equal((0L, 0L, 0L), await TrackedOf(server));
    }

    [Fact]
    public async Task Closes_a_connection_that_it_refused_twice_maximumAnsweringCalls_requests_in_a_row_past_the_resolvers_that_outlive_its_calls_nothing_settling_between_and_reports_it()
    {
        var (server, _, held) = HoldingOf(1);
        var sending = new List<TaskCompletionSource>();

        // what its close faults with is reported
        server.OnClose = (_) =>
        {
            return Task.FromException(new IOException("the transport would not close"));
        };
        const string CloseDetail = "the calls a connection answers and those its resolvers outlive stayed at 2 for 2 requests: the connection is closed";

        List<uint> RefusedOf()
        {
            return [.. FailuresOf(server).Select((failure) =>
            {
                return failure.CallId;
            })];
        }

        await server.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        await server.Deliver(CancelOf(1), "a");
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");

        // the first of a run past both counts
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");

        // a settle, then a request refused at the calls answered alone: the run starts over
        held[0].SetResult();
        await server.Settle();
        await server.Deliver(new Envelope { Header = RequestOf(7) }, "a");
        await server.Deliver(CancelOf(3), "a");
        await server.Deliver(new Envelope { Header = RequestOf(9) }, "a");

        // past both again: once
        await server.Deliver(new Envelope { Header = RequestOf(11) }, "a");
        Assert.Equal([5u, 7u, 11u], RefusedOf());
        Assert.Empty(server.Closed);
        Assert.Empty(server.Reports);

        // twice, in a row: reported at once, and closed once its transport settled that refusal
        server.OnSend = (_) =>
        {
            var send = new TaskCompletionSource();

            sending.Add(send);

            return send.Task;
        };
        await server.Deliver(new Envelope { Header = RequestOf(13) }, "a");
        Assert.Equal([((ushort)ProtocolCode.CapacityExceeded, CloseDetail)], server.Reports.Select((reason) =>
        {
            var failure = Assert.IsType<FailureException>(reason);

            return (failure.Code, failure.Detail);
        }));
        Assert.Equal(["a"], server.ReportedOn);

        // one more refused before the close lands closes nothing more
        await server.Deliver(new Envelope { Header = RequestOf(15) }, "a");
        Assert.Empty(server.Closed);

        foreach (var send in sending)
        {
            send.SetResult();
        }

        await server.Settle();
        Assert.Equal([5u, 7u, 11u, 13u, 15u], RefusedOf());
        Assert.Equal((13u, (ushort)ProtocolCode.CapacityExceeded, "the calls a connection answers and those its resolvers outlive are 2 at most"), FailuresOf(server)[^2]);
        Assert.Equal(["a"], server.Closed.Select((closed) =>
        {
            return closed.ConnectionHandle;
        }));
        Assert.Equal(2, server.Reports.Count);
        Assert.Equal("the transport would not close", Assert.IsType<IOException>(server.Reports[1]).Message);
        Assert.Equal(["a", "a"], server.ReportedOn);
    }

    [Fact]
    public async Task Tells_every_resolver_still_running_on_a_connection_as_it_closes_its_call_answered_or_not_and_counts_those_that_outlive_it_side_wide_until_they_settle()
    {
        var (server, resolver, held) = HoldingOf(2);

        List<bool> Told()
        {
            return [.. resolver.Requests.Select((props) =>
            {
                return props.Signal.IsCancellationRequested;
            })];
        }

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = AnswerBytes }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(5) }, "a");
        await server.Deliver(CancelOf(5), "a");
        Assert.Equal([false, false, true], Told());

        server.Core.RejectPending("a closed", "a");
        await server.Settle();

        // * each told: one answered and one open by the close, one cancelled by its cancel already
        Assert.Equal([true, true, true], Told());
        Assert.Empty((await GaugesOf(server)).ConnectionHandles);
        Assert.Equal((0L, 0L, 3L), await TrackedOf(server));

        // a connection opened again under its handle starts from none of them
        await server.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        await server.Deliver(new Envelope { Header = RequestOf(3) }, "a");
        Assert.Equal([1u, 3u, 5u, 1u, 3u], CallIdsOf(resolver));
        Assert.Equal((2L, 2L, 3L), await TrackedOf(server));

        // each settles, and its place goes back side-wide alone
        foreach (var holding in held.Take(3))
        {
            holding.SetResult();
        }

        await server.Settle();
        Assert.Equal((2L, 2L, 0L), await TrackedOf(server));
        Assert.Equal([(EnvelopeKind.Result, 1u)], server.Sent.Select((envelope) =>
        {
            return (envelope.Kind, envelope.Header.CallId);
        }));
        Assert.Empty(server.Reports);
    }
}
