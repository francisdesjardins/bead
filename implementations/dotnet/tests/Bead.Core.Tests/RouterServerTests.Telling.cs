namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/> within a telling: what its application does with it from within one —
/// a call, an answer, a dispose — taken in a later turn, behind what that turn sends (spec 9.0,
/// 9.1; decision 0045), and a dispose in two steps, its mark at once and what it holds let go in its
/// own job.
/// </summary>
public sealed partial class RouterServerTests
{
    // spec 9.0; decision 0045
    [Fact]
    public async Task A_call_its_report_listener_makes_goes_behind_what_that_turn_answers()
    {
        var failure = new InvalidOperationException("the resolver failed");
        var made = new List<Task<RouterResult>>();

        // what was handed over when the turn's answer went
        var before = new List<int>();

        Start();
        _transport.Open(First);
        Router.RegisterResolver(new RawResolver(Echo, (_) =>
        {
            throw failure;
        }));
        Router.Error += (reason, connectionHandle) =>
        {
            if (ReferenceEquals(reason, failure))
            {
                // within the reporting turn, a call on the connection it reports
                made.Add(Router.Request(BytesOf("what time?"), CommandOf(First)));
            }
        };
        _transport.OnSend = (_, envelope) =>
        {
            if (envelope.Failure is not null)
            {
                before.Add(_transport.Sent.Count - 1);
            }
        };

        Deliver(First, RequestOf(5));
        await Settle();

        // * nothing of the call within the turn: its answer first
        Assert.Equal([0], before);
        Assert.Equal(["first failure 5 ProcedureFailed", "first request 2 what time?"], SentSince());
        _ = Assert.Single(made);
    }

    // spec 9.0, 9.1; decision 0045: the call goes behind the turn's answer, and the dispose's job
    // lets go of it behind them both
    [Fact]
    public async Task A_call_then_a_dispose_its_report_listener_makes_go_behind_that_turn_s_answer_the_call_before_the_dispose()
    {
        var failure = new InvalidOperationException("the resolver failed");
        Task<RouterResult>? before = null;

        Start();
        _transport.Open(First);
        Router.RegisterResolver(new RawResolver(Echo, (_) =>
        {
            throw failure;
        }));
        Router.Error += (reason, _) =>
        {
            if (ReferenceEquals(reason, failure))
            {
                before = Router.Request(BytesOf("before"), CommandOf(First));
                Router.Dispose();
            }
        };

        Deliver(First, RequestOf(5));
        await Settle();

        Assert.Equal(["first failure 5 ProcedureFailed", "first request 2 before"], SentSince());

        // the failure reported, and nothing refused as disposed
        Assert.Equal(["the resolver failed first"], Reported());

        // it went, and the dispose's job rejected it as it waited
        Assert.Equal(
            "the router was disposed before the answer",
            (await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return before!;
            })).Message);
    }

    // spec 9.1; decision 0045: its handle's mark at once, its state's by its own job; each failure
    // says which side of the dispose its call was
    [Fact]
    public async Task A_call_made_before_its_router_s_dispose_goes_and_one_made_after_it_fails_unsent()
    {
        Start();
        _transport.Open(First);

        var before = Router.Request(BytesOf("before"), CommandOf(First));

        Router.Dispose();

        var after = Router.Request(BytesOf("after"), CommandOf(First));

        await Settle();

        Assert.Equal(
            "the router was disposed before the answer",
            (await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return before;
            })).Message);
        Assert.Equal(
            "the router was disposed",
            (await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return after;
            })).Message);
        Assert.Equal(["first request 2 before"], SentSince());
    }

    // decision 0045: the skip of an answer to a call no longer answering and the send gate read one
    // mark, the state's, so an answer taken ahead of a dispose's job, on a call its requester
    // cancelled, goes nowhere, though the handle's mark is set
    [Fact]
    public async Task An_answer_its_resolver_gives_after_a_dispose_queued_behind_it_sends_nothing_on_a_cancelled_call()
    {
        var requests = new List<RequestResolverProps>();
        var isTold = false;
        Task? answering = null;

        Start();
        _transport.Open(First);
        Router.RegisterResolver(new RawResolver(Echo, (props) =>
        {
            requests.Add(props);

            return new TaskCompletionSource().Task;
        }));
        Deliver(First, RequestOf(5));

        // its resolver handed it in a later turn, before its cancel comes
        await Settle();
        Deliver(First, CancelOf(5));
        await Settle();
        _transport.Sent.Clear();

        // * within a telling: the answer, then the dispose behind it, its handle's mark set at once
        Router.Error += (_, _) =>
        {
            if (isTold)
            {
                return;
            }

            isTold = true;
            answering = Router.Respond(RouterAnswer.OfPayload(BytesOf("late")), new AnswerTarget(requests[0].ConnectionHandle, requests[0].Header));
            Router.Dispose();
        };
        _transport.DeliverText(First, "text");
        await Settle();

        Assert.Empty(SentSince());

        // its answer skipped, as a cancelled call's is, never refused as disposed
        await answering!.WaitAsync(Patience, Cancelled);
        Assert.Equal(["EnvelopeMalformed first"], Reported());
    }
}
