namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s gates (spec/debugging.md, section 9): where a call it makes and a call
/// it answers start and end, what each counts, and what counting costs — two readings of its clock
/// a call, and not a byte more — on a core given what its router attached to a registry, the test
/// its peer.
/// </summary>
public sealed partial class RouterCoreTests
{
    // helpers

    // a call of the core's own: the procedure echo, its time and its series
    private static CoreRequest CountedCallOf((ProcedureSeries? Series, TimeSpan Timeout) counted)
    {
        return new CoreRequest
        {
            ConnectionHandle = Handle,
            Options = new ResolvedRequestOptions { Timeout = counted.Timeout },
            Procedure = Echo,
            Series = counted.Series,
        };
    }

    // the lines of the client families a series of echo's counted, by their labels' tail and value
    private static List<string> MadeOf(MetricsRegistry registry, string type = "request")
    {
        var labels = $"{{service=\"1\",procedure=\"echo\",type=\"{type}\"";

        return [.. MetricsTests.CountsOf(registry).Where((line) =>
        {
            return line.StartsWith("bead_client_", StringComparison.Ordinal) && line.Contains(labels, StringComparison.Ordinal);
        }).Select((line) =>
        {
            return line.Replace(labels, "{", StringComparison.Ordinal).Replace("{,", "{", StringComparison.Ordinal);
        })];
    }

    // the time a call of the core's own takes, in whole microseconds, as its _sum writes it
    private static string SumOf(MetricsRegistry registry)
    {
        return registry.Exposition().Text.Split('\n').Single((line) =>
        {
            return line.StartsWith("bead_client_call_duration_seconds_sum{service=\"1\"", StringComparison.Ordinal);
        });
    }

    // definition

    // debugging 9.2 and 9.4.20
    [Fact]
    public async Task Count_a_call_answered_whose_answer_its_transport_throws_on_as_an_error_and_one_its_transport_rejects_once_it_has_it_as_answered()
    {
        var registry = new MetricsRegistry();
        var port = new CountedPort((RouterSide.Server, registry));
        var core = port.Core;

        core.RegisterResolver(new Answering(core));

        // thrown as it is handed the answer: nothing went; rejected once it had it: it went
        port.Thrown = new IOException("this transport throws");
        port.Deliver(new Envelope { Header = new RequestHeader { CallId = 1, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId }, Payload = new byte[] { 1 } });
        await port.Loop.WhenIdle();
        port.Thrown = null;
        port.Refusal = new IOException("this transport rejects");
        port.Deliver(new Envelope { Header = new RequestHeader { CallId = 3, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId }, Payload = new byte[] { 1 } });
        await port.Loop.WhenIdle();

        Assert.Equal(
            [
                "bead_server_call_duration_seconds_count{service=\"1\",procedure=\"echo\",type=\"request\"} 2",
                "bead_server_call_handled_total{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"result\"} 1",
                "bead_server_call_handled_total{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"error\"} 1",
                "bead_server_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 2",
            ],
            MetricsTests.CountsOf(registry).Where((line) =>
            {
                return !line.Contains("_bucket{", StringComparison.Ordinal);
            }));
    }

    [Fact]
    public async Task Holds_a_duration_in_whole_microseconds_its_fraction_dropped_a_TimeSpan_s_ticks_over_10()
    {
        var registry = new MetricsRegistry();
        var port = new CountedPort((RouterSide.Client, registry));
        var core = port.Core;
        var series = port.DeclareRequester(Echo);

        // 1.9 µs, then 30.6 ms: 1 and 30,600 whole microseconds, 0.030601 s together
        foreach (var (callId, ticks) in new[] { (1u, 19L), (3u, 306_000L) })
        {
            var call = core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan)));

            await port.Loop.WhenIdle();
            await port.Clock.Advance(TimeSpan.FromTicks(ticks));
            port.Deliver(ResultOf(callId));
            await call.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }

        Assert.EndsWith("} 0.030601", SumOf(registry), StringComparison.Ordinal);
        Assert.Contains(
            "bead_client_call_duration_seconds_bucket{service=\"1\",procedure=\"echo\",type=\"request\",le=\"1e-05\"} 1",
            registry.Exposition().Text.Split('\n'));
    }

    [Fact]
    public async Task Counts_a_call_that_carries_no_series_under_OTHER_and_a_router_given_no_registry_counts_nothing()
    {
        var registry = new MetricsRegistry();
        var counted = new CountedPort((RouterSide.Server, registry));
        var uncounted = new CountedPort((RouterSide.Server, null));

        // a series another registry gave counts there alone; one given by none, nowhere
        _ = counted.Core.Request(new byte[1], CountedCallOf((null, Timeout.InfiniteTimeSpan)));
        _ = uncounted.Core.Request(new byte[1], CountedCallOf((counted.DeclareRequester(Echo), Timeout.InfiniteTimeSpan)));
        await counted.Loop.WhenIdle();
        await uncounted.Loop.WhenIdle();

        Assert.Equal(["bead_client_call_started_total{service=\"_OTHER\",procedure=\"_OTHER\",type=\"command\"} 1"], MetricsTests.CountsOf(registry));
    }

    // debugging 3.3 and 3.4
    [Fact]
    public async Task Reads_the_monotonic_clock_twice_more_for_a_counted_call_than_for_one_counted_nothing_once_at_each_of_its_gates_and_the_wall_clock_never()
    {
        var registry = new MetricsRegistry();

        // a call made and a call answered, each on a core given a registry and on one given none
        async Task<(int Wall, int Monotonic)[]> ReadingsOf(MetricsRegistry? given)
        {
            var client = new CountedPort((RouterSide.Client, given));
            var server = new CountedPort((RouterSide.Server, given));
            var made = client.Core.Request(new byte[1], CountedCallOf((client.DeclareRequester(Echo), Timeout.InfiniteTimeSpan)));

            server.Core.RegisterResolver(new Answering(server.Core));
            await client.Loop.WhenIdle();
            client.Deliver(ResultOf(1));
            server.Deliver(new Envelope { Header = new RequestHeader { CallId = 1, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId }, Payload = new byte[] { 1 } });
            await made.WaitAsync(Patience, TestContext.Current.CancellationToken);
            await server.Loop.WhenIdle();
            Assert.Single(server.Sent);

            return [(client.Clock.Readings.Wall, client.Clock.Readings.Monotonic), (server.Clock.Readings.Wall, server.Clock.Readings.Monotonic)];
        }

        // the monotonic clock alone, twice a call, and never the wall clock (spec/debugging.md 3.3)
        var uncounted = await ReadingsOf(null);
        var counted = await ReadingsOf(registry);
        Assert.Equal([(0, 0), (0, 0)], uncounted);
        Assert.Equal([(0, 2), (0, 2)], counted);
        Assert.Equal(0, uncounted.Sum((reading) => { return reading.Monotonic; }));
        Assert.Equal(4, counted.Sum((reading) => { return reading.Monotonic; }));
    }

    // debugging 3.3 and 3.4
    [Fact]
    public async Task Allocates_not_a_byte_more_for_a_call_it_counts_than_for_one_it_does_not()
    {
        // what a call made and a call answered allocate on the router's thread, from the request
        // taken to the answer settled: the least of eight rounds, since what else runs on the thread
        // only ever adds bytes, and the first rounds allocate what is allocated once and for all
        async Task<(long Made, long Answered)> AllocatedOf(MetricsRegistry? given)
        {
            var client = new CountedPort((RouterSide.Client, given));
            var server = new CountedPort((RouterSide.Server, given));
            var series = client.DeclareRequester(Echo);
            var request = EnvelopeCodec.WriteEnvelope(new Envelope
            {
                Header = new RequestHeader { CallId = 1, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId },
                Payload = new byte[] { 1 },
            });
            var (made, answered) = (long.MaxValue, long.MaxValue);

            server.Core.RegisterResolver(new Answering(server.Core));

            for (var round = 0; round < 8; round += 1)
            {
                // the result of the call this round draws: the next odd call id
                var result = EnvelopeCodec.WriteEnvelope(ResultOf((uint)((2 * round) + 1)));
                var before = 0L;

                await client.Core.Loop.Run(() =>
                {
                    before = GC.GetAllocatedBytesForCurrentThread();

                    var call = client.Core.Request(new byte[1], CountedCallOf((series, Timeout.InfiniteTimeSpan)));

                    // its result read in the turn after, on the same thread, then the bytes counted
                    client.Core.Receive(result, Handle);
                    client.Core.Post(() =>
                    {
                        made = Math.Min(made, GC.GetAllocatedBytesForCurrentThread() - before);
                    });

                    return call;
                }).WaitAsync(Patience, TestContext.Current.CancellationToken);

                await client.Loop.WhenIdle();
                await server.Core.Loop.Run(() =>
                {
                    before = GC.GetAllocatedBytesForCurrentThread();
                    server.Core.Receive(request, Handle);

                    // counted once its resolver answered, which its request queued behind this
                    server.Core.Post(() =>
                    {
                        server.Core.Post(() =>
                        {
                            answered = Math.Min(answered, GC.GetAllocatedBytesForCurrentThread() - before);
                        });
                    });

                    return Task.FromResult(0);
                }).WaitAsync(Patience, TestContext.Current.CancellationToken);
                await server.Loop.WhenIdle();
            }

            Assert.Equal(8, server.Sent.Count);

            return (made, answered);
        }

        var uncounted = await AllocatedOf(null);

        Assert.True(uncounted is { Made: > 0, Answered: > 0 });
        Assert.Equal(uncounted, await AllocatedOf(new MetricsRegistry()));
    }

    // a resolver of echo that answers each request at once, through its core, on the core's scheduler
    private sealed class Answering(RouterCore core) : IRequestResolver
    {
        public Procedure Procedure
        {
            get
            {
                return Echo;
            }
        }

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
            return core.Respond(RouterAnswer.OfPayload(props.Payload), new AnswerTarget(props.ConnectionHandle, props.Header));
        }
    }

    // a core of a side, counting through a registry attached to its side as its router attaches it,
    // or through none, whose peer is the test: what it sends is kept, a send refused once a refusal
    // is set; its connection open, carrying a credential and secure until the test says otherwise;
    // on a clock that counts its readings, and on one scheduler, its resolvers' too
    private sealed class CountedPort : IRouterCorePort
    {
        private RouterCore? _core;

        public CountedPort((RouterSide Side, MetricsRegistry? Registry) built)
        {
            Side = built.Side;
            Metrics = built.Registry?.Give(built.Side);
            Clock = new SteppingClock(DateTimeOffset.UnixEpoch) { Settle = Loop.WhenIdle };
        }

        public RouterSide Side { get; }

        // what its core counts through, as a router given the registry hands it to its core
        public RouterSeries? Metrics { get; }

        // settled once its core is idle, before and after each timer it fires
        public SteppingClock Clock { get; }

        public SerialScheduler Loop { get; } = new();

        // the last call id its core draws: its side's last when none
        public uint? LastCallId { get; init; }

        public RouterCore Core
        {
            get
            {
                return _core ??= new RouterCore(
                    this,
                    new RouterCoreOptions
                    {
                        Clock = Clock,
                        LastCallId = LastCallId,
                        Limits = Chunked,
                        Metrics = Metrics,
                        ResolverScheduler = Loop,
                        Scheduler = Loop,
                    });
            }
        }

        // a requester of a procedure declared as its router declares one, and its series; none
        // counting through none
        public ProcedureSeries? DeclareRequester(Procedure procedure)
        {
            return Metrics is { } metrics ? new ProcedureSeries(metrics.DeclareRequester(procedure)) : null;
        }

        public List<ReadOnlyMemory<byte>> Sent { get; } = [];

        public List<Exception> Reports { get; } = [];

        // what a send rejects with once it was handed the envelope, and what it throws as it is
        // handed it, while set
        public Exception? Refusal { get; set; }

        public Exception? Thrown { get; set; }

        public bool IsConnected { get; set; } = true;

        public bool IsCarrying { get; set; } = true;

        public bool IsSecureConnection { get; set; } = true;

        public void Deliver(Envelope envelope)
        {
            Core.Receive(EnvelopeCodec.WriteEnvelope(envelope), Handle);
        }

        public bool IsOpen(string connectionHandle)
        {
            return IsConnected;
        }

        public bool Carries(string credential, string connectionHandle)
        {
            return IsCarrying;
        }

        public bool IsSecure(string connectionHandle)
        {
            return IsSecureConnection;
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            if (Thrown is { } thrown)
            {
                throw thrown;
            }

            Sent.Add(message.Bytes.ToArray());

            return Refusal is { } refusal ? Task.FromException(refusal) : Task.CompletedTask;
        }
    }
}
