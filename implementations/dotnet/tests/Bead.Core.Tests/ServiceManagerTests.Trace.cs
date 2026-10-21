using System.Text.Json;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceManager"/>'s debug: whether it is on, the steps a call tells, their call
/// id, their clock and their duration, and a listener that throws.
/// </summary>
public sealed partial class ServiceManagerTests
{
    [Fact]
    public void Is_debugging_only_while_someone_listens()
    {
        var manager = new ServiceManager(new RecordingRouter());
        Action<Exception?, DebugEvent> listener = (_, _) =>
        {
        };

        Assert.False(manager.IsDebugging);
        manager.Debug += listener;
        Assert.True(manager.IsDebugging);
        manager.Debug -= listener;
        Assert.False(manager.IsDebugging);
    }

    // debugging 4.1, 4.1.1, 4.1.2, 4.1.3, 4.1.4, 4.1.5, 4.1.6, 4.1.7 and 4.1.8
    [Fact]
    public async Task Tells_each_step_of_a_request_and_once_answered_its_duration()
    {
        var time = new FakeTimeProvider(Started);
        var router = new RecordingRouter { Clock = time };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);

        router.Answer = (payload) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(30));

            return EchoOf(payload);
        };
        await manager.GetRequest(Echo, Asked)(new Text("hello"))().WaitAsync(Patience, Cancelled);

        var sent = new DebugEvent
        {
            CallId = 7,
            Direction = DebugDirection.Tx,
            Options = new ResolvedRequestOptions { Timeout = TimeoutDefault },
            ProcedureId = 1,
            ProcedureName = "echo",
            ServiceId = 2,
            ServiceRevision = 3,
            StartedAt = Started,
            Tx = new Text("hello"),
            Type = DebugType.Request,
        };

        Assert.Equal(
            [sent, sent with { Direction = DebugDirection.Rx, Duration = TimeSpan.FromMilliseconds(30), Rx = new Text("hello") }],
            seen.Select((told) =>
            {
                return told.Event;
            }));
        Assert.Equal<Exception?>(
            [null, null],
            seen.Select((told) =>
            {
                return told.Error;
            }));

        var mutableManager = new ServiceManager(new RecordingRouter());
        var mutableSeen = RecordDebug(mutableManager);
        var payload = new Dictionary<string, string> { ["Value"] = "hello" };
        var asked = new RequestDependencies<Dictionary<string, string>, Dictionary<string, string>>
        {
            Serializer = new JsonPayloads<Dictionary<string, string>>(),
        };
        var answer = await mutableManager.GetRequest(Echo, asked)(payload)().WaitAsync(Patience, Cancelled);

        Assert.Equal("hello", answer["Value"]);
        Assert.Equal(2, mutableSeen.Count);
        Assert.Null(mutableSeen[0].Event.Duration);
        Assert.InRange(mutableSeen[1].Event.Duration!.Value, TimeSpan.Zero, TimeSpan.FromMilliseconds(999));
        payload["Value"] = "changed after";

        Assert.All(mutableSeen, (step) =>
        {
            Assert.Equal("hello", JsonSerializer.SerializeToElement(step.Event.Tx, JsonOptions).GetProperty("Value").GetString());
        });
        Assert.Equal("hello", JsonSerializer.SerializeToElement(mutableSeen[1].Event.Rx, JsonOptions).GetProperty("Value").GetString());
    }

    // debugging 4.1 and 4.1.8
    [Fact]
    public async Task Tells_each_step_with_its_payloads_as_they_are_the_call_s_own_and_no_copy()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var seen = RecordDebug(manager);
        var asked = new Text("hello");
        var answer = new Text("hi!");
        Text? received = null;
        var resolver = manager.GetRequestResolver(Echo, Answered())((request, response) =>
        {
            received = request.Payload;

            return response.Answer(answer);
        });

        await manager.GetRequest(Echo, Asked)(asked)().WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        // the call made's value, the request its resolver received and the answer it gave: the
        // same objects, which a listener that changed one would change for its call too
        Assert.Equal(4, seen.Count);
        Assert.Same(asked, seen[0].Event.Tx);
        Assert.Same(asked, seen[1].Event.Tx);
        Assert.NotNull(received);
        Assert.Same(received, seen[2].Event.Rx);
        Assert.Same(received, seen[3].Event.Rx);
        Assert.Same(answer, seen[3].Event.Tx);
    }

    // debugging 4.1.10, 4.2.1 and 4.2.2
    [Fact]
    public async Task Tells_a_call_made_and_its_answer_with_the_call_id_its_router_drew_and_their_connection()
    {
        var client = new RecordingRouter(RouterSide.Client);
        var server = new RecordingRouter();
        var asking = new ServiceManager(client);
        var commanding = new ServiceManager(server);
        var seen = RecordDebug(asking);
        var commanded = RecordDebug(commanding);

        // how many calls the router took as each step is told
        var taken = new List<int>();

        asking.Debug += (_, _) =>
        {
            taken.Add(client.Requests.Count);
        };

        await asking.GetRequest(Echo, Asked)(new Text("a"))().WaitAsync(Patience, Cancelled);
        await commanding.GetCommand(Echo, Asked)(new Text("b"))(new RequestOptions { ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled);

        Assert.Equal<(DebugDirection, uint?, string?)>(
            [
                (DebugDirection.Tx, 7, RouterClient.ServerConnectionHandle),
                (DebugDirection.Rx, 7, RouterClient.ServerConnectionHandle),
                (DebugDirection.Tx, 7, Handle),
                (DebugDirection.Rx, 7, Handle),
            ],
            seen.Concat(commanded).Select((told) =>
            {
                return (told.Event.Direction, told.Event.CallId, told.Event.ConnectionHandle);
            }));

        // * the tx step comes once the router took the call, which drew its id
        Assert.Equal([1, 1], taken);
    }

    // debugging 4.2.1 and 4.4
    [Fact]
    public async Task Tells_a_call_its_router_refuses_before_drawing_an_id_with_none_its_tx_step_then_its_rx_step()
    {
        var router = new RecordingRouter(RouterSide.Client) { CallId = null };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var refusal = new FailureException(
            Failure.OfProtocol(ProtocolCode.SessionRequired),
            new FailureException.Raised(FailureOrigin.Local, RouterSide.Client));

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(refusal);
        };

        Assert.Same(refusal, await Assert.ThrowsAsync<FailureException>(() =>
        {
            return manager.GetRequest(Echo, Asked)(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal<(DebugDirection, uint?, string?, Exception?)>(
            [(DebugDirection.Tx, null, null, null), (DebugDirection.Rx, null, null, refusal)],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Event.CallId, told.Event.ConnectionHandle, told.Error);
            }));
    }

    // debugging 4.4
    [Fact]
    public async Task Tells_a_call_made_over_a_router_that_draws_no_id_with_none_its_tx_step_then_its_rx_step()
    {
        var manager = new ServiceManager(new RecordingRouter { CallId = null });
        var seen = RecordDebug(manager);

        Assert.Equal(new Text("x"), await manager.GetRequest(Echo, Asked)(new Text("x"))().WaitAsync(Patience, Cancelled));
        Assert.Equal<(DebugDirection, uint?, object?)>(
            [(DebugDirection.Tx, null, null), (DebugDirection.Rx, null, new Text("x"))],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Event.CallId, told.Event.Rx);
            }));
    }

    [Fact]
    public async Task Raises_deprecated_before_the_call_s_tx_step()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var heard = new List<string>();

        manager.Deprecated += (_) =>
        {
            heard.Add("deprecated");
        };
        manager.Debug += (_, told) =>
        {
            heard.Add(told.Direction.ToString());
        };

        await manager.GetRequest(Echo with { Deprecation = new ProcedureDeprecation { Message = "use echo2" } }, Asked)(new Text("a"))()
            .WaitAsync(Patience, Cancelled);

        Assert.Equal(["deprecated", nameof(DebugDirection.Tx), nameof(DebugDirection.Rx)], heard);
    }

    // debugging 3.2, 4.1.5 and 4.1.6
    [Fact]
    public async Task Reads_its_router_s_clock_a_call_s_start_on_the_wall_clock_its_duration_on_the_monotonic_reading()
    {
        var clock = new SteppingClock(Started);
        var router = new RecordingRouter { Clock = clock };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);

        router.Answer = async (payload) =>
        {
            // a wall clock set back by hand moves no duration
            clock.Wall(TimeSpan.FromDays(-1));
            await clock.Advance(TimeSpan.FromMilliseconds(250));

            return await EchoOf(payload);
        };
        await manager.GetRequest(Echo, Asked)(new Text("hello"))().WaitAsync(Patience, Cancelled);

        Assert.Equal<(DateTimeOffset, TimeSpan?)>(
            [(Started, null), (Started, TimeSpan.FromMilliseconds(250))],
            seen.Select((told) =>
            {
                return (told.Event.StartedAt, told.Event.Duration);
            }));
    }

    // debugging 4.1.6
    [Fact]
    public async Task Tells_a_duration_in_whole_milliseconds_its_fraction_dropped()
    {
        var clock = new SteppingClock(Started);
        var router = new RecordingRouter { Clock = clock };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var before = clock.GetTimestamp();

        router.Answer = async (payload) =>
        {
            await clock.Advance(TimeSpan.FromMicroseconds(30_600));

            return await EchoOf(payload);
        };
        await manager.GetRequest(Echo, Asked)(new Text("hello"))().WaitAsync(Patience, Cancelled);

        // the call took 30.6 ms of the monotonic reading, and is told as 30
        Assert.Equal(TimeSpan.FromMicroseconds(30_600), clock.GetElapsedTime(before));
        Assert.Equal<TimeSpan?>(
            [null, TimeSpan.FromMilliseconds(30)],
            seen.Select((told) =>
            {
                return told.Event.Duration;
            }));
    }

    // debugging 4.1.5, 4.2.5 and 4.2.6
    [Fact]
    public async Task A_notification_starts_as_it_is_heard_or_sent_and_a_failed_notify_tells_its_failure_at_that_same_start()
    {
        var time = new FakeTimeProvider(Started);
        var client = new RecordingRouter(RouterSide.Client) { Clock = time };
        var server = new RecordingRouter { Clock = time };
        var hearing = new ServiceManager(client);
        var notifying = new ServiceManager(server);
        var notification = hearing.GetNotification(Echo, Notified());
        var resolver = notifying.GetNotificationResolver(Echo, Notifying)(UnansweringNotified);
        var failure = new IOException("gone");
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        var heard = RecordDebug(hearing);
        var sent = RecordDebug(notifying);

        time.Advance(TimeSpan.FromMilliseconds(10));
        await client.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);
        time.Advance(TimeSpan.FromMilliseconds(10));

        // the router fails the notify 30 ms after it was sent
        server.NotifyError = failure;
        server.NotifyGate = gate.Task;

        var failing = resolver.Notify(new Text("late"));

        time.Advance(TimeSpan.FromMilliseconds(30));
        gate.SetResult();
        await failing.WaitAsync(Patience, Cancelled);

        Assert.Equal<(DebugDirection, DateTimeOffset, TimeSpan?)>(
            [(DebugDirection.Rx, Started.AddMilliseconds(10), null)],
            heard.Select((told) =>
            {
                return (told.Event.Direction, told.Event.StartedAt, told.Event.Duration);
            }));
        Assert.Equal<(Exception?, DateTimeOffset, TimeSpan?)>(
            [(null, Started.AddMilliseconds(20), null), (failure, Started.AddMilliseconds(20), null)],
            sent.Select((told) =>
            {
                return (told.Error, told.Event.StartedAt, told.Event.Duration);
            }));
    }

    // debugging 3.1, 3.2 and 3.4
    [Fact]
    public async Task Reads_no_clock_for_a_call_made_a_request_answered_a_notification_sent_and_one_heard_while_nobody_listens_and_three_for_a_call_with_a_listener()
    {
        var clock = new SteppingClock(Started);
        var client = new RecordingRouter(RouterSide.Client) { Clock = clock };
        var server = new RecordingRouter { Clock = clock };
        var hearing = new ServiceManager(client);
        var notifying = new ServiceManager(server);
        var notification = hearing.GetNotification(Echo, Notified());
        var resolver = notifying.GetNotificationResolver(Echo, Notifying)((request, response) =>
        {
            return response.Answer(request.Payload);
        });
        var asking = hearing.GetRequest(Echo, Asked);

        // the readings `run` takes of the wall clock and of the monotonic one, each apart
        async Task<(int Wall, int Monotonic)> ReadingsOf(Func<Task> run)
        {
            var before = clock.Readings;

            await run().WaitAsync(Patience, Cancelled);

            return (clock.Readings.Wall - before.Wall, clock.Readings.Monotonic - before.Monotonic);
        }

        async Task<(int Wall, int Monotonic)[]> ReadEach()
        {
            return
            [
                await ReadingsOf(() =>
                {
                    return asking(new Text("x"))();
                }),
                await ReadingsOf(() =>
                {
                    return resolver.Handle(PropsOf(Encode(new Text("hi"))));
                }),
                await ReadingsOf(() =>
                {
                    return resolver.Notify(new Text("news"));
                }),
                await ReadingsOf(() =>
                {
                    return client.Deliver(Echo.Address, new Text("news"));
                }),
            ];
        }

        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);
        var unheard = await ReadEach();

        Assert.Equal([(0, 0), (0, 0), (0, 0), (0, 0)], unheard);

        foreach (var manager in new[] { hearing, notifying })
        {
            manager.Debug += (_, _) =>
            {
            };
        }

        // a call's start on both clocks, and its end on the monotonic one; a notification's on the
        // wall clock alone (spec/debugging.md 3.2)
        var listened = await ReadEach();

        Assert.Equal([(1, 2), (1, 2), (1, 0), (1, 0)], listened);
    }

    // debugging 2.2 and 2.3
    [Fact]
    public async Task A_debug_listener_that_throws_on_the_answer_is_reported_through_the_router_and_the_call_resolves_with_its_result_each_step_told()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = new List<DebugDirection>();
        var heard = new List<DebugDirection>();
        var failure = new InvalidOperationException("listener bug");

        manager.Debug += (_, told) =>
        {
            seen.Add(told.Direction);

            if (told.Direction == DebugDirection.Rx)
            {
                throw failure;
            }
        };

        // a listener after it hears each step all the same
        manager.Debug += (_, told) =>
        {
            heard.Add(told.Direction);
        };

        Assert.Equal(new Text("x"), await manager.GetRequest(Echo, Asked)(new Text("x"))().WaitAsync(Patience, Cancelled));
        Assert.Equal([DebugDirection.Tx, DebugDirection.Rx], seen);
        Assert.Equal([DebugDirection.Tx, DebugDirection.Rx], heard);
        Assert.Equal([(failure, (string?)null)], router.Reports.Select((report) =>
        {
            return ((Exception)report.Reason, report.ConnectionHandle);
        }));
    }

    // debugging 2.2 and 2.3
    [Fact]
    public async Task A_request_is_answered_as_a_debug_listener_throws_on_its_rx_step_the_error_reported_through_the_router_with_its_connection()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var failure = new InvalidOperationException("listener bug");

        manager.Debug += (_, told) =>
        {
            if (told.Direction == DebugDirection.Rx)
            {
                throw failure;
            }
        };

        var resolver = manager.GetRequestResolver(Echo, Answered())((request, response) =>
        {
            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(new Responded(Target, new Text("hi"), null), Assert.Single(router.Responses));
        Assert.Equal([(failure, (string?)Handle)], router.Reports.Select((report) =>
        {
            return ((Exception)report.Reason, report.ConnectionHandle);
        }));
    }

    // the C# side's alone, as its router client's test of the scheduler is: a router that hears a
    // call's id on the thread pool, under no scheduler of its own, where the runtime would run an
    // await inline, and the task source's continuations alone keep the tx step out of its OnCallId
    [Fact]
    public async Task Tells_a_call_s_tx_step_off_the_thread_its_router_hears_its_call_id_on()
    {
        var router = new RecordingRouter { CallId = null };
        var manager = new ServiceManager(router);
        var told = new List<(uint? CallId, bool IsAnswered)>();

        using var answered = new ManualResetEventSlim();

        // the id heard, then the answer given, by one work item: a listener run inside its OnCallId
        // would wait for an answer that work item never gets to give
        router.Answer = (payload) =>
        {
            var request = router.Requests[^1].Request;

            return Task.Run(() =>
            {
                request.OnCallId?.Invoke(7);
                answered.Set();

                return ResultOf(payload);
            });
        };
        manager.Debug += (_, step) =>
        {
            if (step.Direction == DebugDirection.Tx)
            {
                var isAnswered = answered.Wait(Patience);

                lock (told)
                {
                    told.Add((step.CallId, isAnswered));
                }
            }
        };

        Assert.Equal(new Text("x"), await manager.GetRequest(Echo, Asked)(new Text("x"))().WaitAsync(Patience, Cancelled));
        Assert.Equal<(uint?, bool)>([(7, true)], told);
    }

    // debugging 3.1 and 3.4
    [Fact]
    public async Task Allocates_for_a_call_made_a_request_answered_and_a_notification_sent_or_heard_the_same_while_nobody_listens_whoever_listened_before_and_less_than_with_a_listener()
    {
        var client = new RecordingRouter(RouterSide.Client);
        var server = new RecordingRouter();
        var hearing = new ServiceManager(client);
        var notifying = new ServiceManager(server);
        var notification = hearing.GetNotification(Echo, Notified());
        var resolver = notifying.GetNotificationResolver(Echo, Notifying)((request, response) =>
        {
            return response.Answer(request.Payload);
        });
        var asking = hearing.GetRequest(Echo, Asked)(new Text("x"));
        var props = PropsOf(Encode(new Text("hi")));
        Action<Exception?, DebugEvent> listener = (_, _) =>
        {
        };

        // what each step allocates on this thread, the router drawing its call id and answering at
        // once, so nothing awaits: the least of eight rounds, since what else runs on the thread only
        // ever adds bytes, and the first rounds allocate what is allocated once and for all
        long[] AllocatedOf()
        {
            Func<Task>[] steps =
            [
                () =>
                {
                    return asking();
                },
                () =>
                {
                    return resolver.Handle(props);
                },
                () =>
                {
                    return resolver.Notify(new Text("news"));
                },
                () =>
                {
                    return client.Deliver(Echo.Address, new Text("news"));
                },
            ];

            return [.. steps.Select((step) =>
            {
                var allocated = long.MaxValue;

                for (var round = 0; round < 8; round += 1)
                {
                    // what the routers record, emptied, so a list that grows allocates nothing more
                    client.Requests.Clear();
                    server.Responses.Clear();
                    server.Notified.Clear();

                    var before = GC.GetAllocatedBytesForCurrentThread();
                    var stepped = step();

                    allocated = Math.Min(allocated, GC.GetAllocatedBytesForCurrentThread() - before);
                    Assert.True(stepped.IsCompletedSuccessfully);
                }

                return allocated;
            })];
        }

        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        var unheard = AllocatedOf();

        // * each step's bytes while nobody listens, pinned: what the comparisons below let pass, a
        // field or a closure that moves every side alike, shows here
        Assert.Equal(AllocatedWhileNobodyListens, unheard);

        hearing.Debug += listener;
        notifying.Debug += listener;

        var listened = AllocatedOf();

        hearing.Debug -= listener;
        notifying.Debug -= listener;

        Assert.Equal(unheard, AllocatedOf());
        Assert.All(unheard.Zip(listened), (each) =>
        {
            Assert.True(each.First < each.Second, $"{each.First} bytes while nobody listens, {each.Second} with a listener");
        });
    }
}
