namespace Bead.Tests;

/// <summary>The core's detach and settlement order when an incoming resolver awaits an outgoing call.</summary>
public sealed partial class RouterCoreTests
{
    // records the state at a counted call's end, on the core's scheduler
    private sealed class TeardownClock : TimeProvider
    {
        public Action? Reading { get; set; }

        public override long GetTimestamp()
        {
            Reading?.Invoke();

            return base.GetTimestamp();
        }
    }

    [Fact]
    public async Task Detaches_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_and_counts_its_incoming_close_once()
    {
        var port = new Plain();
        var resolvers = new SerialScheduler();
        var clock = new TeardownClock();
        var registry = new MetricsRegistry();
        using var core = new RouterCore(port, new RouterCoreOptions
        {
            Clock = clock,
            Limits = Chunked,
            Metrics = registry.Give(RouterSide.Server),
            ResolverScheduler = resolvers,
            Scheduler = port.Loop,
        });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var steps = new List<string>();
        var snapshots = new List<Gauges>();
        CancellationToken signal = default;
        Task? answer = null;
        Task? marker = null;
        var cancelledAtMarker = false;
        var resolver = new Held(core)
        {
            Handling = async (request) =>
            {
                signal = request.Signal;
                using var registration = signal.Register(() =>
                {
                    steps.Add("incoming-aborted");
                });
                var outgoing = core.Request(ReadOnlyMemory<byte>.Empty, CallOf(Handle, (Echo, Timeout.InfiniteTimeSpan)));

                // an incoming result held for credit gives Abort its synchronous OnAbort work,
                // while the resolver still awaits its outgoing call
                answer = core.Respond(RouterAnswer.OfPayload(PatternOf(200)), new AnswerTarget(Handle, request.Header));
                entered.SetResult();

                try
                {
                    await outgoing;
                }
                catch (DisconnectException)
                {
                    steps.Add("incoming-await-rejected");
                }
                finally
                {
                    finished.SetResult();
                }
            },
        };
        core.RegisterResolver(resolver);
        core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = RequestOf(1) }), Handle);
        await entered.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await port.Loop.WhenIdle();
        resolvers.Post(() =>
        {
            held.SetResult();
            release.Wait(TestContext.Current.CancellationToken);
        });
        await held.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);

        try
        {
            var before = await port.Loop.Run(() =>
            {
                return Task.FromResult(core.Gauges());
            });
            Assert.Equal(1, before.Counts["pendingCalls"]);
            Assert.Equal(1, before.Counts["answeringCalls"]);
            Assert.Equal(1, before.Counts["sendingTransfers"]);

            clock.Reading = () =>
            {
                snapshots.Add(core.Gauges());
                steps.Add(snapshots.Count == 1 ? "incoming-ended" : "outgoing-ended");

                if (snapshots.Count == 2)
                {
                    // queued at the outgoing call's rejection, behind the cancel its incoming
                    // call's abort queued on the same held resolver scheduler
                    marker = Task.Factory.StartNew(() =>
                    {
                        cancelledAtMarker = signal.IsCancellationRequested;
                    }, TestContext.Current.CancellationToken, TaskCreationOptions.DenyChildAttach, resolvers);
                }
            };
            core.RejectPending("the connection closed", Handle);
            await port.Loop.WhenIdle();
            clock.Reading = null;

            Assert.Equal(2, snapshots.Count);
            Assert.All(snapshots, (snapshot) =>
            {
                Assert.Equal(0, snapshot.Counts["pendingCalls"]);
                Assert.Equal(0, snapshot.Counts["answeringCalls"]);
                Assert.Equal(0, snapshot.Counts["receivingTransfers"]);
            });
            Assert.Equal(1, snapshots[0].Counts["sendingTransfers"]);
            // ? the answer's transfer closes with its call's abort, before the outgoing call ends: an
            // open difference of docs/support.md
            Assert.Equal(0, snapshots[1].Counts["sendingTransfers"]);
            Assert.False(signal.IsCancellationRequested);
            Assert.Equal(["incoming-ended", "outgoing-ended"], steps);
        }
        finally
        {
            clock.Reading = null;
            release.Set();
        }

        await finished.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await Assert.IsAssignableFrom<Task>(marker).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Assert.IsAssignableFrom<Task>(answer).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await port.Loop.WhenIdle();
        Assert.True(cancelledAtMarker);
        Assert.Equal(["incoming-ended", "outgoing-ended", "incoming-aborted", "incoming-await-rejected"], steps);

        // neither the resolver unwinding nor another close ends its incoming metrics again
        core.RejectPending("closed again", Handle);
        await port.Loop.WhenIdle();
        var counts = MetricsTests.CountsOf(registry);
        Assert.Contains("bead_server_call_handled_total{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"closed\"} 1", counts);
        Assert.Contains("bead_server_call_duration_seconds_count{service=\"1\",procedure=\"echo\",type=\"request\"} 1", counts);
        Assert.Empty(port.Reports);
    }
}
