using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="AnsweringCalls"/>: the calls the peer opened that a side still owes an answer, found
/// again by the very header dispatched, what each receives of its payload, and the calls abandoned
/// once their transfer ended.
/// </summary>
public sealed class AnsweringCallsTests
{
    // helpers

    private static RequestHeader HeaderOf(uint callId)
    {
        return new RequestHeader { CallId = callId, ServiceId = 2, ProcedureId = 1 };
    }

    private static AnsweringCalls CallsOf(AnsweringCallsOptions? options = null)
    {
        return new AnsweringCalls(options ?? OptionsOf(new FakeTimeProvider()));
    }

    private static AnsweringCallsOptions OptionsOf(TimeProvider time)
    {
        return new AnsweringCallsOptions
        {
            Limits = RouterLimits.Default,
            Post = (action) =>
            {
                action();
            },
            Clock = time,
        };
    }

    // what a call receives, its credit granted as far as `creditEnd`
    private static RequestReceiving ReceivingOf(AnsweringCall answering, (uint CallId, string ConnectionHandle, int CreditEnd) receiving)
    {
        var (incoming, _) = IncomingTransfer.Open(new byte[receiving.CreditEnd], (RouterLimits.Default, 1, receiving.CreditEnd + 1L));

        return new RequestReceiving(
            new AnswerTarget(receiving.ConnectionHandle, HeaderOf(receiving.CallId)),
            answering,
            new Nobody(),
            new Receiving(new CallAddress(receiving.CallId, receiving.ConnectionHandle), incoming!));
    }

    // definition

    [Fact]
    public void Opens_a_call_as_its_request_is_dispatched_and_finds_it_again_by_that_very_header_alone()
    {
        var calls = CallsOf();
        var header = HeaderOf(3);
        var answering = calls.Open(new AnswerTarget("a", header));

        Assert.True(calls.Has(new CallAddress(3, "a")));
        Assert.False(calls.Has(new CallAddress(3, "b")));
        Assert.Same(answering, calls.CallOf(header));
        Assert.True(calls.IsAnswering(new AnswerTarget("a", header)));

        // a copy was never dispatched: it finds no call, and is taken as one to answer
        Assert.Null(calls.CallOf(header with { }));
        Assert.True(calls.IsAnswering(new AnswerTarget("a", header with { })));
    }

    [Fact]
    public void Answers_a_call_no_more_once_its_answer_goes_out_while_the_call_stays_until_closed_a_copy_of_its_header_marking_nothing()
    {
        var calls = CallsOf();
        var header = HeaderOf(3);
        var answering = calls.Open(new AnswerTarget("a", header));

        calls.Answer(new AnswerTarget("a", header with { }));
        calls.Answer(new AnswerTarget("b", header));
        Assert.True(calls.IsAnswering(new AnswerTarget("a", header)));
        calls.Answer(new AnswerTarget("a", header));
        Assert.False(calls.IsAnswering(new AnswerTarget("a", header)));
        Assert.True(calls.Has(new CallAddress(3, "a")));
        calls.Close(new CallAddress(3, "a"), answering);
        Assert.False(calls.Has(new CallAddress(3, "a")));
    }

    [Fact]
    public void Answers_a_call_no_more_once_closed_by_its_own_call_taken_or_opened_again()
    {
        var calls = CallsOf();
        var call = new CallAddress(3, "a");
        var first = HeaderOf(3);
        var answering = calls.Open(new AnswerTarget("a", first));

        calls.Close(call, new AnsweringCall { Source = new CancellationTokenSource() });
        Assert.True(calls.IsAnswering(new AnswerTarget("a", first)));
        calls.Close(call, answering);
        Assert.False(calls.Has(call));
        Assert.False(calls.IsAnswering(new AnswerTarget("a", first)));

        var second = HeaderOf(3);
        var again = calls.Open(new AnswerTarget("a", second));

        // the call id is open again, for another request
        Assert.False(calls.IsAnswering(new AnswerTarget("a", first)));
        Assert.Same(again, calls.Take(call));
        Assert.Null(calls.Take(call));
        Assert.False(calls.IsAnswering(new AnswerTarget("a", second)));
    }

    [Fact]
    public void Takes_out_every_call_of_a_connection_or_of_every_one_giving_them()
    {
        var calls = CallsOf();
        var first = calls.Open(new AnswerTarget("a", HeaderOf(3)));
        var second = calls.Open(new AnswerTarget("b", HeaderOf(3)));

        Assert.Equal([first], calls.TakeAll("a"));
        Assert.True(calls.Has(new CallAddress(3, "b")));
        Assert.Equal([second], calls.TakeAll(null));
        Assert.Empty(calls.TakeAll(null));

        // nothing is cancelled: the caller ends what it took
        Assert.False(first.Source.IsCancellationRequested || second.Source.IsCancellationRequested);
    }

    [Fact]
    public void Gives_a_call_what_it_receives_and_hears_it_leave_once_whichever_way_the_call_leaves()
    {
        var removed = new List<RequestReceiving>();
        var calls = CallsOf(OptionsOf(new FakeTimeProvider()) with { OnRemove = removed.Add });
        var call = new CallAddress(3, "a");
        var answering = calls.Open(new AnswerTarget("a", HeaderOf(3)));

        // a call not open receives nothing, on a connection with calls open or none
        calls.Attach(new CallAddress(5, "a"), ReceivingOf(answering, (5, "a", 0)));
        calls.Attach(new CallAddress(5, "b"), ReceivingOf(answering, (5, "b", 0)));

        var closed = ReceivingOf(answering, (3, "a", 0));

        calls.Attach(call, closed);
        Assert.Null(calls.ReceivingOf(new CallAddress(5, "a")));
        Assert.Same(closed, calls.ReceivingOf(call));

        // another request's call takes nothing out
        calls.Close(call, new AnsweringCall { Source = new CancellationTokenSource() });
        calls.Close(call, answering);
        calls.Close(call, answering);
        Assert.Null(calls.ReceivingOf(call));

        var reopened = calls.Open(new AnswerTarget("a", HeaderOf(3)));
        var taken = ReceivingOf(reopened, (3, "a", 0));

        calls.Attach(call, taken);
        calls.Take(call);
        calls.Take(call);
        calls.Open(new AnswerTarget("a", HeaderOf(3)));

        var other = calls.Open(new AnswerTarget("b", HeaderOf(3)));
        var gone = ReceivingOf(other, (3, "b", 0));

        calls.Attach(new CallAddress(3, "b"), gone);
        calls.TakeAll(null);

        // a call that received nothing leaves unheard
        Assert.Equal([closed, taken, gone], removed);
    }

    [Fact]
    public void Keeps_a_call_that_received_a_transfer_abandoned_once_it_ends_the_oldest_of_a_connection_yielding()
    {
        var calls = CallsOf(OptionsOf(new FakeTimeProvider()) with { Limits = RouterLimits.Default with { MaximumTransfers = 2 } });

        void End((uint CallId, string ConnectionHandle) ended, (int? CreditEnd, bool IsTaken) how)
        {
            var call = new CallAddress(ended.CallId, ended.ConnectionHandle);
            var answering = calls.Open(new AnswerTarget(ended.ConnectionHandle, HeaderOf(ended.CallId)));

            if (how.CreditEnd is { } creditEnd)
            {
                calls.Attach(call, ReceivingOf(answering, (ended.CallId, ended.ConnectionHandle, creditEnd)));
            }

            if (how.IsTaken)
            {
                calls.Take(call);
            }
            else
            {
                calls.Close(call, answering);
            }
        }

        List<long?> EndsOf(string connectionHandle, uint[] callIds)
        {
            return [.. callIds.Select((callId) =>
            {
                return calls.AbandonedEndOf(new CallAddress(callId, connectionHandle));
            })];
        }

        End((1, "a"), (10, false));
        End((3, "a"), (20, true));
        End((1, "b"), (40, false));

        // a call that received none ends abandoned by none
        End((7, "a"), (null, false));
        Assert.Equal([10, 20, null], EndsOf("a", [1, 3, 7]));

        // a call abandoned is not one to answer
        Assert.False(calls.Has(new CallAddress(1, "a")));

        // a request on its call id takes its place; ended again, the call is the newest
        calls.Open(new AnswerTarget("a", HeaderOf(1)));
        Assert.Equal([null], EndsOf("a", [1]));
        calls.Take(new CallAddress(1, "a"));
        End((1, "a"), (15, true));
        End((5, "a"), (30, false));
        Assert.Equal([15, null, 30], EndsOf("a", [1, 3, 5]));
        Assert.Equal([40], EndsOf("b", [1]));

        // a call that goes with its connection is abandoned by none
        var going = calls.Open(new AnswerTarget("a", HeaderOf(9)));

        calls.Attach(new CallAddress(9, "a"), ReceivingOf(going, (9, "a", 50)));
        calls.TakeAll("a");
        Assert.Equal([null, null, null], EndsOf("a", [1, 5, 9]));
        Assert.Equal([40], EndsOf("b", [1]));
        calls.TakeAll(null);
        Assert.Equal([null], EndsOf("b", [1]));
    }

    [Fact]
    public void Count_the_calls_answered_and_those_abandoned_and_the_connections_they_belong_to()
    {
        var calls = CallsOf();
        var call = new CallAddress(1, "a");
        var answering = calls.Open(new AnswerTarget("a", HeaderOf(1)));

        calls.Open(new AnswerTarget("b", HeaderOf(3)));
        calls.Attach(call, ReceivingOf(answering, (1, "a", 4)));
        calls.Close(call, answering);
        Assert.Equal(["a", "b"], calls.Gauges().ConnectionHandles.Order());
        Assert.Equal(new Dictionary<string, long> { ["abandonedCalls"] = 1, ["answeringCalls"] = 1 }, calls.Gauges().Counts);
        calls.TakeAll(null);
        Assert.Empty(calls.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["abandonedCalls"] = 0, ["answeringCalls"] = 0 }, calls.Gauges().Counts);
    }

    [Fact]
    public void Forgets_a_call_abandoned_once_its_transfer_s_inactivity_is_over()
    {
        var time = new FakeTimeProvider();
        var calls = CallsOf(OptionsOf(time) with { Limits = RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) } });

        foreach (var callId in new uint[] { 1, 3 })
        {
            var answering = calls.Open(new AnswerTarget("a", HeaderOf(callId)));

            calls.Attach(new CallAddress(callId, "a"), ReceivingOf(answering, (callId, "a", 10)));
            calls.Take(new CallAddress(callId, "a"));
        }

        // the call a request took stops its timer: abandoned again later, it waits its own time
        calls.Open(new AnswerTarget("a", HeaderOf(3)));
        time.Advance(TimeSpan.FromMilliseconds(249));
        Assert.Equal(10, calls.AbandonedEndOf(new CallAddress(1, "a")));
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Null(calls.AbandonedEndOf(new CallAddress(1, "a")));
        Assert.Null(calls.AbandonedEndOf(new CallAddress(3, "a")));
    }

    // a handler no request reaches: what a call receives names one
    private sealed class Nobody : IRequestHandler
    {
        public int? MaximumPayloadBytes
        {
            get
            {
                return null;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return null;
        }

        public Task Handle(RequestResolverProps props)
        {
            return Task.CompletedTask;
        }
    }
}
