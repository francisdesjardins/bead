using System.Collections.Concurrent;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>The core's detach and settlement order when an incoming resolver awaits an outgoing call.</summary>
public sealed partial class RouterCoreTests
{
    // constants

    // echo's address, of no kind, under the service the TypeScript twins have it in
    private static readonly Procedure ClosingEcho = InteropProcedures.Echo.Procedure with { ProcedureKind = null, ServiceId = 2 };

    // helpers

    // records the state at a counted call's end, on the core's scheduler
    // ! its time stands still: no timer of the core's fires, and an answer held for credit never
    // stalls past its inactivity timeout before the close, however slow the machine
    private sealed class TeardownClock : FakeTimeProvider
    {
        public Action? Reading { get; set; }

        public override long GetTimestamp()
        {
            Reading?.Invoke();

            return base.GetTimestamp();
        }
    }

    // a server's port that says its side, reports, and keeps what it sends: nothing more
    private sealed class Closing : IRouterCorePort
    {
        public SerialScheduler Loop { get; } = new();

        public List<Exception> Reports { get; } = [];

        public ConcurrentQueue<TransportMessage> Sent { get; } = [];

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
            Sent.Enqueue(message);

            return Task.CompletedTask;
        }
    }

    // what a connection's close left: the gauges before it and at each counted end, the steps at the
    // close's end and once everything settled, what each resolver's outgoing call rejected with and
    // whether its signal was cancelled then, how each answer settled, what was sent after the close,
    // what was reported, and the counts
    private sealed record Closed
    {
        public required Gauges Before { get; init; }

        public required List<Gauges> Snapshots { get; init; }

        public required (string[] AtReturn, string[] Settled) Steps { get; init; }

        public required List<(bool Aborted, Exception Reason)> Caught { get; init; }

        public required List<Exception?> Answers { get; init; }

        public required int SentAfter { get; init; }

        public required List<Exception> Reports { get; init; }

        public required List<string> Counts { get; init; }
    }

    // a connection that closes as each of its resolvers awaits an outgoing call, given its signal
    // when told, an answer of its own held for credit: the gauges at each counted end, as the core
    // reads its clock, and what each resolver hears. The resolvers run on a scheduler held through
    // the close, so the steps at its end are those of the core and of each signal's callbacks
    private static async Task<Closed> CloseAwaiting((bool Forward, int Incoming) closing)
    {
        var port = new Closing();
        var resolvers = new SerialScheduler();
        var clock = new TeardownClock();
        var registry = new MetricsRegistry();
        var metrics = registry.Give(RouterSide.Server);
        using var core = new RouterCore(port, new RouterCoreOptions
        {
            Clock = clock,
            Limits = Chunked,
            Metrics = metrics,
            ResolverScheduler = resolvers,
            Scheduler = port.Loop,
        });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var steps = new ConcurrentQueue<string>();
        var snapshots = new List<Gauges>();
        var answers = new ConcurrentQueue<Task>();
        var finished = new ConcurrentQueue<Task>();
        var caught = new ConcurrentQueue<(bool Aborted, Exception Reason)>();

        async Task Resolve(RequestResolverProps request)
        {
            using var registration = request.Signal.Register(() =>
            {
                steps.Enqueue("incoming-aborted");
            });
            var outgoing = core.Request(ReadOnlyMemory<byte>.Empty, new CoreRequest
            {
                ConnectionHandle = Handle,
                Options = new ResolvedRequestOptions
                {
                    CancellationToken = closing.Forward ? request.Signal : CancellationToken.None,
                    Timeout = Timeout.InfiniteTimeSpan,
                },
                Procedure = ClosingEcho,
                Series = new ProcedureSeries(metrics.DeclareRequester(ClosingEcho)),
            });

            // an incoming result held for credit, while the resolver still awaits its outgoing call
            answers.Enqueue(core.Respond(RouterAnswer.OfPayload(PatternOf(200)), new AnswerTarget(Handle, request.Header)));

            if (answers.Count == closing.Incoming)
            {
                entered.SetResult();
            }

            try
            {
                await outgoing;
            }
            catch (Exception reason)
            {
                caught.Enqueue((request.Signal.IsCancellationRequested, reason));
                steps.Enqueue("incoming-await-rejected");
            }
        }

        core.RegisterResolver(new Held(core)
        {
            Procedure = ClosingEcho,
            Handling = (request) =>
            {
                var resolved = Resolve(request);

                finished.Enqueue(resolved);

                return resolved;
            },
        });

        // the peer's call ids, odd
        for (var index = 0; index < closing.Incoming; index += 1)
        {
            var header = new RequestHeader { CallId = (uint)((2 * index) + 1), ServiceId = ClosingEcho.ServiceId, ProcedureId = ClosingEcho.ProcedureId };

            core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = header }), Handle);
        }

        await entered.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await port.Loop.WhenIdle();
        resolvers.Post(() =>
        {
            held.SetResult();
            release.Wait(TestContext.Current.CancellationToken);
        });
        await held.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);

        Gauges before;
        int sentBefore;
        string[] atReturn;

        try
        {
            before = await port.Loop.Run(() =>
            {
                return Task.FromResult(core.Gauges());
            });
            sentBefore = port.Sent.Count;
            clock.Reading = () =>
            {
                snapshots.Add(core.Gauges());
                steps.Enqueue(snapshots.Count <= closing.Incoming ? "incoming-ended" : "outgoing-ended");
            };
            core.RejectPending("the connection closed", Handle);
            await port.Loop.WhenIdle();
            clock.Reading = null;
            atReturn = [.. steps];
        }
        finally
        {
            clock.Reading = null;
            release.Set();
        }

        await Task.WhenAll(finished).WaitAsync(Patience, TestContext.Current.CancellationToken);

        var settled = new List<Exception?>();

        foreach (var answer in answers)
        {
            settled.Add(await Record.ExceptionAsync(() =>
            {
                return answer.WaitAsync(Patience, TestContext.Current.CancellationToken);
            }));
        }

        // neither the resolver unwinding nor another close ends its incoming metrics again
        core.RejectPending("closed again", Handle);
        await port.Loop.WhenIdle();

        return new Closed
        {
            Before = before,
            Snapshots = snapshots,
            Steps = (atReturn, [.. steps]),
            Caught = [.. caught],
            Answers = settled,
            SentAfter = port.Sent.Count - sentBefore,
            Reports = port.Reports,
            Counts = MetricsTests.CountsOf(registry),
        };
    }

    // what a connection's close leaves of one call it answered and the call its resolver made
    private static void AssertClosedOnce(List<string> counts)
    {
        Assert.Contains("bead_server_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"closed\"} 1", counts);
        Assert.Contains("bead_server_call_duration_seconds_count{service=\"2\",procedure=\"echo\",type=\"request\"} 1", counts);
        Assert.Contains("bead_client_call_handled_total{service=\"2\",procedure=\"echo\",type=\"command\",outcome=\"closed\"} 1", counts);
        Assert.DoesNotContain(counts, (line) =>
        {
            return line.Contains("outcome=\"cancelled\"", StringComparison.Ordinal);
        });
    }

    // every transfer went with the calls, before any end was counted
    private static void AssertDetached(List<Gauges> snapshots)
    {
        Assert.All(snapshots, (snapshot) =>
        {
            Assert.Equal(0, snapshot.Counts["answeringCalls"]);
            Assert.Equal(0, snapshot.Counts["pendingCalls"]);
            Assert.Equal(0, snapshot.Counts["receivingTransfers"]);
            Assert.Equal(0, snapshot.Counts["sendingTransfers"]);
        });
    }

    // definition

    [Fact]
    public async Task Detaches_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_and_counts_its_incoming_close_once()
    {
        var closed = await CloseAwaiting((false, 1));

        Assert.Equal(1, closed.Before.Counts["answeringCalls"]);
        Assert.Equal(1, closed.Before.Counts["pendingCalls"]);
        Assert.Equal(1, closed.Before.Counts["sendingTransfers"]);
        Assert.Equal(2, closed.Snapshots.Count);
        AssertDetached(closed.Snapshots);
        Assert.Equal(["incoming-ended", "outgoing-ended", "incoming-aborted"], closed.Steps.AtReturn);
        Assert.Equal(["incoming-ended", "outgoing-ended", "incoming-aborted", "incoming-await-rejected"], closed.Steps.Settled);

        // the resolver hears its signal before its call's rejection
        var (aborted, reason) = Assert.Single(closed.Caught);

        Assert.True(aborted);
        Assert.IsType<DisconnectException>(reason);
        Assert.IsType<DisconnectException>(Assert.Single(closed.Answers));
        AssertClosedOnce(closed.Counts);
        Assert.Equal(0, closed.SentAfter);
        Assert.Empty(closed.Reports);
    }

    // debugging 9.7
    [Fact]
    public async Task Detaches_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_given_its_signal_and_fails_that_call_as_closed_never_as_a_cancel()
    {
        var closed = await CloseAwaiting((true, 1));

        Assert.Equal(1, closed.Before.Counts["answeringCalls"]);
        Assert.Equal(1, closed.Before.Counts["pendingCalls"]);
        Assert.Equal(1, closed.Before.Counts["sendingTransfers"]);
        Assert.Equal(2, closed.Snapshots.Count);
        AssertDetached(closed.Snapshots);
        Assert.Equal(["incoming-ended", "outgoing-ended", "incoming-aborted"], closed.Steps.AtReturn);
        Assert.Equal(["incoming-ended", "outgoing-ended", "incoming-aborted", "incoming-await-rejected"], closed.Steps.Settled);

        // ! the signal is cancelled once the call it was given is rejected: cancelled first, it would
        // fail that call as a cancel
        var (aborted, reason) = Assert.Single(closed.Caught);

        Assert.True(aborted);
        Assert.IsType<DisconnectException>(reason);
        Assert.IsType<DisconnectException>(Assert.Single(closed.Answers));
        AssertClosedOnce(closed.Counts);
        Assert.Equal(0, closed.SentAfter);
        Assert.Empty(closed.Reports);
    }

    [Fact]
    public async Task Detaches_every_transfer_of_a_closing_connection_before_counting_any_of_its_calls_two_incoming_calls_each_answering_as_a_transfer()
    {
        var closed = await CloseAwaiting((false, 2));

        Assert.Equal(2, closed.Before.Counts["answeringCalls"]);
        Assert.Equal(2, closed.Before.Counts["pendingCalls"]);
        Assert.Equal(2, closed.Before.Counts["sendingTransfers"]);

        // each call answered and each call made
        Assert.Equal(4, closed.Snapshots.Count);
        AssertDetached(closed.Snapshots);
        Assert.Equal(0, closed.SentAfter);
        Assert.Empty(closed.Reports);
    }
}
