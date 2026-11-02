namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/>'s intake (spec 15.12, decision 0046): what each connection's
/// transport handed it that no turn took yet, counted as it is handed, its connection paused once
/// a bound is reached and resumed once both counts are at half; the router held behind by a job of
/// the test's own on its scheduler, which waits until the test lets it go.
/// </summary>
public sealed partial class RouterServerTests
{
    // a job on the router's scheduler that waits until the test sets what it gives: what its
    // transport hands meanwhile waits untaken behind it
    private ManualResetEventSlim HoldRouter()
    {
        var released = new ManualResetEventSlim(false);

        _scheduler.Post(() =>
        {
            released.Wait(Patience, Cancelled);
        });

        return released;
    }

    // each envelope the router takes, by its connection and its call id, and whether its transport
    // was paused on it as it took it
    private List<string> TakenBy()
    {
        var taken = new List<string>();

        Router.Debug += (direction, traced) =>
        {
            if (direction == DebugDirection.Rx)
            {
                var paused = _transport.IsPaused(traced.ConnectionHandle) ? " paused" : "";

                taken.Add($"{NameOf(traced.ConnectionHandle)} {traced.Header.CallId}{paused}");
            }
        };

        return taken;
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public async Task Pauses_a_connection_once_its_untaken_envelopes_reach_a_bound_and_resumes_it_once_they_are_at_half()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 4 } });

        var taken = TakenBy();

        _transport.Open(First);

        using (var held = HoldRouter())
        {
            foreach (var callId in new uint[] { 1, 3, 5 })
            {
                Deliver(First, CancelOf(callId));
            }

            // three untaken, under its bound of 4
            Assert.False(_transport.IsPaused(First));

            Deliver(First, CancelOf(7));

            Assert.True(_transport.IsPaused(First));

            Deliver(First, CancelOf(9));
            Deliver(First, CancelOf(11));

            // what came after it held by its transport, nothing taken yet
            Assert.Equal((2, 0), (_transport.HeldOf(First), taken.Count));

            held.Set();
            await Settle();
        }

        // * resumed once the turns took it down to half, what it held handed on behind the rest
        Assert.Equal(["first 1 paused", "first 3 paused", "first 5", "first 7", "first 9", "first 11"], taken);
        Assert.Equal(["pause first", "resume first"], _transport.Paces);
        Assert.Equal(0, _transport.HeldOf(First));
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public async Task Takes_the_envelope_that_reaches_a_bound()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 2, MaximumUntakenBytes = 100 } });

        var taken = TakenBy();

        _transport.Open(First);
        _transport.Open(Second);

        using (var held = HoldRouter())
        {
            foreach (var callId in new uint[] { 1, 3, 5 })
            {
                Deliver(First, CancelOf(callId));
            }

            // the second, which reached the bound, handed on; the third alone held
            Assert.Equal((true, 1), (_transport.IsPaused(First), _transport.HeldOf(First)));

            // * an envelope larger than the byte bound is taken whole, and released
            Deliver(Second, RequestOf(1, payload: new string('a', 1_000)));

            Assert.True(_transport.IsPaused(Second));

            Deliver(Second, CancelOf(9));

            Assert.Equal(1, _transport.HeldOf(Second));

            held.Set();
            await Settle();
        }

        Assert.Equal(["first 1 paused", "first 3", "second 1 paused", "first 5", "second 9"], taken);
        Assert.Equal(["pause first", "pause second", "resume first", "resume second"], _transport.Paces);
        Assert.Equal((0, 0), (_transport.HeldOf(First), _transport.HeldOf(Second)));
    }

    // spec 15.12.17
    [Fact]
    public async Task An_envelope_of_one_connection_waits_behind_no_more_than_the_bound_of_another_that_floods()
    {
        var pipe = new SerialScheduler();
        await using var memory = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = pipe });
        using var router = new RouterServer(memory, new RouterServerOptions
        {
            Intake = new IntakeLimits { MaximumUntakenEnvelopes = 4 },
            Scheduler = _scheduler,
            ResolverScheduler = _scheduler,
        });
        await using var flooding = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = pipe });
        await using var other = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = pipe });
        var taken = new List<string>();

        router.Debug += (direction, traced) =>
        {
            if (direction == DebugDirection.Rx)
            {
                var from = traced.ConnectionHandle.Contains("ip=flooding;", StringComparison.Ordinal) ? "flooding" : "other";

                taken.Add($"{from} {traced.Header.CallId}");
            }
        };
        await memory.Start();
        await flooding.Connect(new MemoryConnectOptions { Server = memory, Address = "flooding" }, Cancelled);
        await other.Connect(new MemoryConnectOptions { Server = memory, Address = "other" }, Cancelled);
        await Settle();

        using (var held = HoldRouter())
        {
            // * 40 of one connection, then one of the other, sent before any is taken
            for (uint callId = 1; callId <= 79; callId += 2)
            {
                await flooding.Send(new TransportMessage(EnvelopeCodec.WriteEnvelope(CancelOf(callId)), false));
            }

            await other.Send(new TransportMessage(EnvelopeCodec.WriteEnvelope(CancelOf(1_001)), false));
            await pipe.WhenIdle().WaitAsync(Patience, Cancelled);
            held.Set();
        }

        for (var round = 0; round < 100 && taken.Count < 41; round += 1)
        {
            await Settle();
            await pipe.WhenIdle().WaitAsync(Patience, Cancelled);
        }

        var ahead = taken.IndexOf("other 1001");

        // the other's waited behind no more than the flood's bound of 4
        Assert.InRange(ahead, 0, 4);

        // the flood taken whole, in order
        Assert.Equal(
            Enumerable.Range(0, 40).Select((index) =>
            {
                return $"flooding {(2 * index) + 1}";
            }),
            taken.Where((seen) =>
            {
                return seen.StartsWith("flooding", StringComparison.Ordinal);
            }));
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public async Task Counts_nothing_the_router_does_of_its_own_a_timer_a_resolution_a_dispose_a_deferred_call()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 1 } });
        _transport.Open(First);

        var isMade = false;
        var made = new List<Task<RouterResult>>();

        // a resolution: answered in a later turn
        EchoOf(async (request, response) =>
        {
            await Task.Yield();
            await response.Answer(request.Payload);
        });

        // a deferred call: one of its own, made from within the telling of the request it takes
        Router.Debug += (direction, _) =>
        {
            if (direction == DebugDirection.Rx && !isMade)
            {
                isMade = true;
                made.Add(Router.Request(BytesOf("deferred"), CommandOf(First, TimeSpan.FromMilliseconds(20))));
            }
        };

        // a timer: a call of its own, ended by its timeout
        var timed = Router.Request(BytesOf("timed"), CommandOf(First, TimeSpan.FromMilliseconds(20)));

        Deliver(First, RequestOf(1, payload: "hi"));
        await Settle();
        _time.Advance(TimeSpan.FromMilliseconds(20));
        await Settle();

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timed;
        });
        Assert.True(isMade);
        Assert.Contains("first result 1 hi", SentSince());

        // a dispose
        Router.Dispose();
        await Settle();

        // * the envelope its transport handed alone counted
        Assert.Equal(["pause first", "resume first"], _transport.Paces);
    }

    // spec 15.12.17; decision 0045
    [Fact]
    public async Task Counts_an_envelope_handed_within_a_telling_and_releases_it_by_its_deferred_turn()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 1 } });
        _transport.Open(First);
        _transport.Open(Second);

        var seen = new List<string>();

        Router.Debug += (direction, traced) =>
        {
            if (direction == DebugDirection.Rx && traced.Header.CallId == 1)
            {
                // * handed within the telling of this listener: counted as it is handed
                Deliver(Second, CancelOf(3));
                seen.Add($"the second paused within the telling: {_transport.IsPaused(Second)}");
            }
        };
        Deliver(First, CancelOf(1));
        await Settle();

        Assert.Equal(["the second paused within the telling: True"], seen);

        // released by its deferred turn, behind the telling's
        Assert.Equal(["pause first", "pause second", "resume first", "resume second"], _transport.Paces);
        Assert.False(_transport.IsPaused(Second));
    }

    // spec 15.12.17
    [Fact]
    public async Task Reports_what_its_transport_throws_as_it_pauses_or_resumes_a_connection_and_takes_the_envelope_all_the_same()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 1 } });

        var taken = TakenBy();

        _transport.Open(First);
        _transport.IsPacingBroken = true;

        Deliver(First, CancelOf(1));
        await Settle();

        Assert.Equal(["first 1 paused"], taken);
        Assert.Equal(["pause first", "resume first"], _transport.Paces);
        Assert.Equal(["no pause first", "no resume first"], Reported());
    }

    // spec 15.12.17
    [Fact]
    public async Task Resumes_a_connection_whose_envelope_a_throwing_listener_heard()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 1 } });
        _transport.Open(First);
        Router.Debug += (direction, _) =>
        {
            if (direction == DebugDirection.Rx)
            {
                throw new InvalidOperationException("this listener breaks, on purpose");
            }
        };

        Deliver(First, CancelOf(1));

        Assert.True(_transport.IsPaused(First));

        await Settle();

        Assert.Equal(["pause first", "resume first"], _transport.Paces);
        Assert.Equal(["this listener breaks, on purpose first"], Reported());

        // * a text message's report runs the application's handler in its job, whose throw the
        // scheduler goes on past: its count released in the job's finally all the same
        Router.Error += (reason, _) =>
        {
            if (reason is FailureException)
            {
                throw new InvalidOperationException("this handler breaks, on purpose");
            }
        };
        _transport.DeliverText(First, "not an envelope");

        Assert.True(_transport.IsPaused(First));

        await Settle();

        Assert.Equal(["pause first", "resume first", "pause first", "resume first"], _transport.Paces);
        Assert.False(_transport.IsPaused(First));
    }

    // spec 15.12.17
    [Fact]
    public async Task Resumes_every_connection_it_paused_as_it_is_disposed()
    {
        Start(new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 1 } });
        _transport.Open(First);
        _transport.Open(Second);

        using (var held = HoldRouter())
        {
            Deliver(First, CancelOf(1));
            Deliver(Second, CancelOf(3));

            Assert.Equal((true, true), (_transport.IsPaused(First), _transport.IsPaused(Second)));

            // * at once, before any turn took what they handed
            Router.Dispose();

            Assert.Equal(["pause first", "pause second", "resume first", "resume second"], _transport.Paces);

            // nothing paused after: what its transport hands from then on reaches no router
            foreach (var callId in new uint[] { 5, 7, 9 })
            {
                Deliver(First, CancelOf(callId));
            }

            held.Set();
            await Settle();
        }

        Assert.Equal((4, 0), (_transport.Paces.Count, _transport.HeldOf(First)));
    }
}
