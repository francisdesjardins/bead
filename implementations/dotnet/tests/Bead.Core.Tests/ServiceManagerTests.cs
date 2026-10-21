using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceManager"/>: its requesters, its resolvers and their admission, and its
/// notifications, over a router that records every call and answers as a test scripts it.
/// </summary>
public sealed partial class ServiceManagerTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan TimeoutDefault = TimeSpan.FromSeconds(5);

    private static readonly JsonSerializerOptions JsonOptions = new();

    private static readonly JsonPayloads<Text> Json = new();

    private static readonly Procedure Echo = new()
    {
        ServiceId = 2,
        ProcedureId = 1,
        ProcedureName = "echo",
        ServiceRevision = 3,
    };

    // a request's header, as the router hands it over
    private static readonly RequestHeader Header = new() { CallId = 7, ServiceId = 2, ProcedureId = 1 };

    private static readonly AnswerTarget Target = new(Handle, Header);

    private static readonly RequestResolverCallback<Text, Text> Unanswering = (_, _) =>
    {
        return Task.CompletedTask;
    };

    private static readonly NotificationResolverCallback<Text, Text> UnansweringNotified = (_, _) =>
    {
        return Task.CompletedTask;
    };

    private static readonly Func<Text, Task> Unheard = (_) =>
    {
        return Task.CompletedTask;
    };

    // where a test's wall clock starts: a call traced at once starts there
    private static readonly DateTimeOffset Started = DateTimeOffset.FromUnixTimeMilliseconds(1_000);

    // the bounds of the echo's rule, and the detail a request it refuses under failFast is answered with
    private static readonly JsonElement MinLen = JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["min_len"] = "1" });

    private const string RefusedDetail =
        "{\"bounds\":{\"min_len\":\"1\"},\"fieldPath\":\"value\",\"message\":\"must be at least 1 characters\",\"ruleId\":\"string.min_len\"}\n{\"stopped\":true}";

    // ! what a call made, a request answered, a notification sent and one heard allocate while
    // nobody listens, in bytes: the allocation gate's pin, which sees a field, a copy or a closure
    // added to a step's path. Measured on .NET 10.0.12, the runtime of the SDK global.json names,
    // x64, in the Debug build `dotnet test` makes, on Windows and on Linux alike. A runtime that
    // moves them is pinned anew, by hand: run the gate, take the bytes its failure prints, and name
    // the runtime, and why each step moved, in the commit. A call made holds the refusal its rules
    // may judge it with, which its router's request carries (decision 0035)
    private static readonly long[] AllocatedWhileNobodyListens = [1272, 984, 560, 768];

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static RequestDependencies<Text, Text> Asked
    {
        get
        {
            return new RequestDependencies<Text, Text> { Serializer = Json };
        }
    }

    private static NotificationResolverDependencies<Text, Text, Text> Notifying
    {
        get
        {
            return new NotificationResolverDependencies<Text, Text, Text> { Serializer = Json };
        }
    }

    private static ReadOnlyMemory<byte> Encode(Text payload)
    {
        return Json.Encode(payload);
    }

    // what a manager's Debug tells, in order: each step's exception and event
    private static List<(Exception? Error, DebugEvent Event)> RecordDebug(ServiceManager manager)
    {
        var seen = new List<(Exception? Error, DebugEvent Event)>();

        manager.Debug += (error, told) =>
        {
            lock (seen)
            {
                seen.Add((error, told));
            }
        };

        return seen;
    }

    // what each step a manager's Debug told is: its direction and its type
    private static IEnumerable<(DebugDirection Direction, DebugType Type)> StepsOf(List<(Exception? Error, DebugEvent Event)> seen)
    {
        return seen.Select((told) =>
        {
            return (told.Event.Direction, told.Event.Type);
        });
    }

    // a request as its router hands it to a resolver: on the header above, carrying a payload
    private static RequestResolverProps PropsOf(ReadOnlyMemory<byte> payload)
    {
        return new RequestResolverProps { ConnectionHandle = Handle, Header = Header, Payload = payload, Signal = CancellationToken.None };
    }

    // a result carrying a payload, as the router settles a request with it: call 7's
    private static RouterResult ResultOf(ReadOnlyMemory<byte> payload)
    {
        return new RouterResult(new ResultHeader { CallId = 7 }, payload);
    }

    // what the router answers a request with unless a test says otherwise: its own payload
    private static Task<RouterResult> EchoOf(ReadOnlyMemory<byte> payload)
    {
        return Task.FromResult(ResultOf(payload));
    }

    private static RequestResolverDependencies<Text, Text> Answered(BeforeRequest? beforeRequest = null)
    {
        return new RequestResolverDependencies<Text, Text> { Serializer = Json, BeforeRequest = beforeRequest };
    }

    // the echo's rule, by hand: its value one character at least, each judging's options written down
    private static RequestValidator<Text> Judging(List<ValidateOptions> given)
    {
        return (request, options) =>
        {
            given.Add(options);

            return request.Value.Length > 0
                ? Judged.None
                : new Judged
                {
                    Stopped = options.FailFast,
                    Violations = [new Violation { Bounds = MinLen, FieldPath = "value", Message = "must be at least 1 characters", RuleId = "string.min_len" }],
                };
        };
    }

    private static NotificationDependencies<Text, Text, Text> Notified(int? window = null, Func<uint, Text, Task>? unsubscribe = null)
    {
        return new NotificationDependencies<Text, Text, Text> { Serializer = Json, Window = window, Unsubscribe = unsubscribe };
    }

    // a callback that writes down what it hears, after its name when it has one
    private static Func<Text, Task> HeardBy(List<string> heard, string? name = null)
    {
        return (notification) =>
        {
            heard.Add(name is null ? notification.Value : $"{name} {notification.Value}");

            return Task.CompletedTask;
        };
    }

    // the answer a resolver of the echo procedure sends, its admission given
    private static async Task<Responded?> AdmittedBy(BeforeRequest beforeRequest, List<string> reached)
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(beforeRequest))((request, response) =>
        {
            reached.Add(request.Payload.Value);

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        return router.Responses.FirstOrDefault();
    }

    // the failure a resolver's answer sends, the callback answering with the one given
    private static async Task<Failure?> AnsweredWith(Failure failure)
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())((_, response) =>
        {
            return response.Fail(failure);
        });

        try
        {
            await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        }
        catch (ArgumentException)
        {
            // a failure a resolver may not answer goes on, for the router to report
        }

        return Assert.Single(router.Responses).Failure;
    }

    // definition

    [Fact]
    public void Runs_on_its_router_s_clock_and_refuses_another()
    {
        var time = new FakeTimeProvider();
        var router = new RecordingRouter { Clock = time };

        Assert.NotNull(new ServiceManager(router, new ServiceManagerOptions { Clock = time }));
        Assert.Equal(
            "a service manager runs on the clock of its router, a FakeTimeProvider, and was given another, the system's",
            Assert.Throws<ArgumentException>(() =>
            {
                return new ServiceManager(router, new ServiceManagerOptions { Clock = TimeProvider.System });
            }).Message);
    }

    [Fact]
    public void Registers_its_resolver_with_its_notify_for_its_router_to_declare_it_as_the_side_that_notifies()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);

        manager.GetRequestResolver(Echo, Answered())(Unanswering);
        manager.GetNotificationResolver(Echo with { ProcedureId = 2, ProcedureName = "news" }, Notifying)(UnansweringNotified);

        // a router tells a procedure that notifies by its resolver, which notifies
        Assert.Equal([false, true], router.RegisteredResolvers.Select((resolver) =>
        {
            return resolver is INotificationResolver;
        }));
    }

    // spec 17.2.2
    [Fact]
    public async Task An_answer_that_does_not_decode_fails_the_call_here_with_its_header_and_its_call()
    {
        var router = new RecordingRouter(RouterSide.Client);
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var answer = ResultOf("{not json"u8.ToArray());

        router.Answer = (_) =>
        {
            return Task.FromResult(answer);
        };

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return manager.GetRequest(Echo, Asked)(new Text("x"))(new RequestOptions { DestinationId = 4 })
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.Equal(4u, failure.DestinationId);
        Assert.Same(answer.Header, failure.Header);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(Echo.Address, failure.ProcedureAddress);
        Assert.Equal(FailureScope.Protocol, failure.Scope);
        Assert.Equal(RouterSide.Client, failure.Side);

        // the TypeScript side keeps the decoder's error as the cause; this side says it in the detail
        Assert.NotEqual("", failure.Detail);

        // what the decoder threw is its cause, as the TypeScript side keeps it
        Assert.Equal(failure.Detail, failure.InnerException!.Message);

        // told as the call's answer: the failure, and what it carries
        Assert.Equal([DebugDirection.Tx, DebugDirection.Rx], StepsOf(seen).Select((step) =>
        {
            return step.Direction;
        }));
        Assert.Null(seen[0].Error);
        Assert.Same(failure, seen[1].Error);
        Assert.Equal(failure.Failure, seen[1].Event.Rx);
    }

    [Fact]
    public async Task Notifies_through_the_router_with_the_encoded_notification()
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetNotificationResolver(Echo, Notifying)(UnansweringNotified);

        await resolver.Notify(new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Same(resolver, Assert.Single(router.RegisteredResolvers));

        var (payload, request) = Assert.Single(router.Notified);

        Assert.Equal(new Text("news"), payload);
        Assert.Equal(new NotifyRequest { Procedure = Echo.Address }, request);
    }

    // spec 17.2.6
    [Fact]
    public async Task A_notification_whose_value_does_not_write_goes_to_its_router_in_its_payload_s_place_its_failure_told_at_its_start_and_resolves()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var resolver = manager.GetNotificationResolver(
            Echo,
            new NotificationResolverDependencies<Text, Text, Text> { Serializer = new UnwritableNotification() })(UnansweringNotified);

        await resolver.Notify(new Text("news")).WaitAsync(Patience, Cancelled);

        var refusal = Assert.Single(router.Unwritten);

        Assert.Equal("cannot write", refusal.Message);
        Assert.Empty(router.Notified);
        Assert.Equal<(Exception?, DebugDirection, DateTimeOffset)>(
            [(null, DebugDirection.Tx, seen[0].Event.StartedAt), (refusal, DebugDirection.Tx, seen[0].Event.StartedAt)],
            seen.Select((told) =>
            {
                return (told.Error, told.Event.Direction, told.Event.StartedAt);
            }));
    }

    [Fact]
    public async Task Its_callback_may_subscribe_the_requester_before_answering_and_is_given_the_call_id_not_after()
    {
        var router = new RecordingRouter();
        var late = new List<Exception>();
        var resolver = new ServiceManager(router).GetNotificationResolver(Echo, Notifying)(async (request, response) =>
        {
            var callId = await response.RegisterNotification();

            await response.Answer(new Text(callId.ToString(CultureInfo.InvariantCulture)));
            late.Add(Assert.Throws<InvalidOperationException>(() =>
            {
                _ = response.RegisterNotification();
            }));
        });

        await resolver.Handle(PropsOf(Encode(new Text("subscribe")))).WaitAsync(Patience, Cancelled);

        Assert.Equal([Target], router.Subscribed);
        Assert.Equal(new Text("7"), Assert.Single(router.Responses).Payload);
        Assert.Single(late);
    }

    [Fact]
    public async Task Tells_the_router_whom_its_options_keep_none_excluded_and_those_the_filter_keeps()
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetNotificationResolver(Echo, Notifying)(UnansweringNotified);
        string[] handles = ["a", "b", "c"];

        await resolver.Notify(new Text("news"), new NotifyOptions()).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("news"), new NotifyOptions { Exclude = "b" }).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("news"), new NotifyOptions
        {
            Filter = (subscriber) =>
            {
                return subscriber.ConnectionHandle != "a";
            },
        }).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("news"), new NotifyOptions
        {
            Exclude = "c",
            Filter = (subscriber) =>
            {
                return subscriber.ConnectionHandle != "a";
            },
        }).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            ["each", "a c", "b c", "b"],
            router.Notified.Select((notified) =>
            {
                return notified.Request.Filter is { } filter
                    ? string.Join(' ', handles.Where((handle) =>
                    {
                        return filter(new Subscriber { ConnectionHandle = handle });
                    }))
                    : "each";
            }));
    }

    [Fact]
    public async Task Tells_the_router_what_a_notification_is_about_for_a_paced_subscription_to_keep_its_latest()
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetNotificationResolver(Echo, Notifying)(UnansweringNotified);

        await resolver.Notify(new Text("news"), new NotifyOptions { Key = 7 }).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("news"), new NotifyOptions { Key = "seven" }).WaitAsync(Patience, Cancelled);

        Assert.Equal<object?>(
            [7, "seven"],
            router.Notified.Select((notified) =>
            {
                return notified.Request.Key;
            }));
    }

    [Fact]
    public async Task A_failed_notify_completes_all_the_same_and_only_debug_hears_of_it()
    {
        var failure = new IOException("gone");
        var router = new RecordingRouter { NotifyError = failure };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var resolver = manager.GetNotificationResolver(Echo, Notifying)(UnansweringNotified);

        await resolver.Notify(new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Notified);
        Assert.Equal<Exception?>(
            [null, failure],
            seen.Select((told) =>
            {
                return told.Error;
            }));
        Assert.Equal([(DebugDirection.Tx, DebugType.Notification), (DebugDirection.Tx, DebugType.Notification)], StepsOf(seen));
    }

    [Fact]
    public async Task The_first_registration_requests_registers_and_then_hears_each_notification()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        await notification.Register(new Text("subscribe"), HeardBy(heard))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("one")).WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("two")).WaitAsync(Patience, Cancelled);

        Assert.Same(notification, Assert.Single(router.Requests).Request.Subscribes);
        Assert.Equal(["echo"], router.RegisteredNotifications);
        Assert.Equal(["one", "two"], heard);
    }

    [Fact]
    public async Task Its_request_takes_the_destination_and_the_timeout_it_is_given_and_names_the_notification_it_subscribes()
    {
        var router = new RecordingRouter();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        await notification.Register(new Text("s"), Unheard)(new RequestOptions { DestinationId = 3, Timeout = TimeSpan.FromMilliseconds(50) })
            .WaitAsync(Patience, Cancelled);

        // its series, a requester's of the procedure, declared as the notification was made
        Assert.Equal(
            new RouterRequest(Echo, new ResolvedRequestOptions { DestinationId = 3, Timeout = TimeSpan.FromMilliseconds(50) })
            {
                Series = Assert.Single(router.Declared).Series,
                Subscribes = notification,
            },
            Assert.Single(router.Requests).Request);
    }

    [Fact]
    public async Task The_router_holds_it_before_its_request_goes_out_so_a_notification_right_behind_the_answer_is_heard()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();

        // the notification comes with the answer, before anything waiting on the answer runs
        router.Answer = (payload) =>
        {
            _ = router.Deliver(Echo.Address, new Text("right behind"));

            return EchoOf(payload);
        };

        await new ServiceManager(router).GetNotification(Echo, Notified()).Register(new Text("s"), HeardBy(heard))()
            .WaitAsync(Patience, Cancelled);

        Assert.Equal(["right behind"], heard);
    }

    [Fact]
    public async Task Once_registered_another_callback_joins_without_a_request()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        await notification.Register(new Text("subscribe"), HeardBy(heard, "first"))().WaitAsync(Patience, Cancelled);
        await notification.Register(new Text("subscribe"), HeardBy(heard, "second"))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Requests);
        Assert.Equal(["first news", "second news"], heard);
    }

    [Fact]
    public async Task Callbacks_registering_at_once_share_one_request_and_one_registration()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var answered = new TaskCompletionSource<RouterResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        // the answer held, the second registers while the first one's request is in flight
        router.Answer = (_) =>
        {
            return answered.Task;
        };

        var first = notification.Register(new Text("a"), HeardBy(heard, "a"))();
        var second = notification.Register(new Text("b"), HeardBy(heard, "b"))();

        answered.SetResult(ResultOf(Encode(new Text("a"))));
        await Task.WhenAll(first, second).WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Requests);
        Assert.Equal(["echo"], router.RegisteredNotifications);
        Assert.Equal(["a news", "b news"], heard);
    }

    [Fact]
    public async Task A_failed_request_rejects_and_keeps_nothing_the_next_registration_asks_again()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var failure = new IOException("refused");

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(failure);
        };
        Assert.Same(failure, await Assert.ThrowsAsync<IOException>(() =>
        {
            return notification.Register(new Text("a"), HeardBy(heard, "a"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.False(router.Holds(Echo.Address));

        router.Answer = EchoOf;
        await notification.Register(new Text("b"), HeardBy(heard, "b"))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(2, router.Requests.Count);
        Assert.Equal(["b news"], heard);

        // the router cancels whatever its call may have left at the other end
        Assert.Equal([("echo", true)], router.UnregisteredNotifications);
    }

    [Fact]
    public async Task An_answer_to_its_subscription_that_does_not_decode_lets_go_of_it_the_router_cancelling_its_call()
    {
        var router = new RecordingRouter();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        router.Answer = (_) =>
        {
            return Task.FromResult(ResultOf("{not json"u8.ToArray()));
        };

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return notification.Register(new Text("a"), Unheard)().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.False(router.Holds(Echo.Address));
        Assert.Equal([("echo", true)], router.UnregisteredNotifications);
    }

    [Fact]
    public async Task The_last_callback_taken_away_unregisters_the_notification_taking_one_away_twice_does_nothing()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var first = await notification.Register(new Text("s"), HeardBy(heard, "first"))().WaitAsync(Patience, Cancelled);
        var second = await notification.Register(new Text("s"), HeardBy(heard, "second"))().WaitAsync(Patience, Cancelled);

        await first.Unregister().WaitAsync(Patience, Cancelled);
        await first.Unregister().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("one")).WaitAsync(Patience, Cancelled);

        Assert.Empty(router.UnregisteredNotifications);

        await second.Unregister().WaitAsync(Patience, Cancelled);

        // with no unsubscription to tell the other end, the router cancels its call
        Assert.Equal([("echo", true)], router.UnregisteredNotifications);
        Assert.False(router.Holds(Echo.Address));
        Assert.Equal(["second one"], heard);
    }

    [Fact]
    public async Task The_last_callback_out_unsubscribes_with_the_call_id_and_the_answer_that_subscribed_before_the_router_lets_go_of_it()
    {
        var router = new RecordingRouter();
        var told = new List<string>();

        router.Answer = (_) =>
        {
            return Task.FromResult(ResultOf(Encode(new Text("subscription 7"))));
        };

        var notification = new ServiceManager(router).GetNotification(Echo, Notified(unsubscribe: (callId, response) =>
        {
            told.Add($"{callId}: {response.Value}, held {router.Holds(Echo.Address)}");

            return Task.CompletedTask;
        }));
        var first = await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);
        var second = await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        await first.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Empty(told);

        await second.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Equal(["7: subscription 7, held True"], told);

        // taken away at the other end, acknowledged: nothing is left there to cancel
        Assert.Equal([("echo", false)], router.UnregisteredNotifications);
    }

    [Fact]
    public async Task An_unsubscription_that_fails_rejects_the_last_unregister_once_the_router_let_go_all_the_same()
    {
        var router = new RecordingRouter();
        var failure = new IOException("refused");
        var notification = new ServiceManager(router).GetNotification(Echo, Notified(unsubscribe: (_, _) =>
        {
            return Task.FromException(failure);
        }));
        var registration = await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        Assert.Same(failure, await Assert.ThrowsAsync<IOException>(() =>
        {
            return registration.Unregister().WaitAsync(Patience, Cancelled);
        }));
        Assert.False(router.Holds(Echo.Address));

        // the other end may hold it still: the router cancels its call
        Assert.Equal([("echo", true)], router.UnregisteredNotifications);

        // what comes next is not held back by it
        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        Assert.Equal(2, router.Requests.Count);
    }

    [Fact]
    public async Task Dropped_with_its_connection_it_tells_dropped_hears_nothing_more_has_nothing_to_take_away_and_asks_anew()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var heard = new List<string>();
        var dropped = new List<(Procedure Procedure, Failure? Failure)>();
        var unsubscribed = new List<Text>();

        manager.Dropped += (procedure, failure) =>
        {
            dropped.Add((procedure, failure));
        };

        var notification = manager.GetNotification(Echo, Notified(unsubscribe: (_, response) =>
        {
            unsubscribed.Add(response);

            return Task.CompletedTask;
        }));
        var registration = await notification.Register(new Text("s"), HeardBy(heard, "first"))().WaitAsync(Patience, Cancelled);

        router.Drop();
        await registration.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Equal<(Procedure, Failure?)>([(Echo, null)], dropped);
        Assert.Empty(unsubscribed);
        Assert.Empty(router.UnregisteredNotifications);

        await notification.Register(new Text("s"), HeardBy(heard, "second"))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(["second news"], heard);
        Assert.Equal(2, router.Requests.Count);

        // ended by the server: "dropped" says with what
        var failure = Failure.OfProtocol(ProtocolCode.CapacityExceeded, "queued");

        router.Drop(failure);

        Assert.Equal<(Procedure, Failure?)>([(Echo, null), (Echo, failure)], dropped);
    }

    [Fact]
    public void Makes_a_notification_with_the_window_its_dependencies_give_paced_by_it()
    {
        var manager = new ServiceManager(new RecordingRouter(RouterSide.Client));

        Assert.Equal(2, manager.GetNotification(Echo, Notified(window: 2)).Window);
        Assert.Null(manager.GetNotification(Echo with { ProcedureId = 9 }, Notified()).Window);
    }

    [Fact]
    public void Refuses_a_notification_asked_for_again_at_another_window_none_against_one_among_them_and_gives_the_same_at_the_same()
    {
        foreach (var (pacedId, unpacedId) in new (ushort, ushort)[] { (71, 1), (1, 9) })
        {
            var manager = new ServiceManager(new RecordingRouter(RouterSide.Client));
            var pacedProcedure = Echo with { ProcedureId = pacedId };
            var unpacedProcedure = Echo with { ProcedureId = unpacedId };
            var paced = manager.GetNotification(pacedProcedure, Notified(window: 4));
            var unpaced = manager.GetNotification(unpacedProcedure, Notified());

            Assert.Same(paced, manager.GetNotification(pacedProcedure, Notified(window: 4)));
            Assert.Same(unpaced, manager.GetNotification(unpacedProcedure, Notified()));
            Assert.Equal($"2/{pacedId} is already a notification with window 4, not window 1", Assert.Throws<InvalidOperationException>(() =>
            {
                return manager.GetNotification(pacedProcedure, Notified(window: 1));
            }).Message);
            Assert.Throws<InvalidOperationException>(() =>
            {
                return manager.GetNotification(pacedProcedure, Notified());
            });
            Assert.Equal($"2/{unpacedId} is already a notification with no window, not window 1", Assert.Throws<InvalidOperationException>(() =>
            {
                return manager.GetNotification(unpacedProcedure, Notified(window: 1));
            }).Message);
        }
    }

    [Fact]
    public async Task A_registration_under_way_when_its_notification_is_dropped_fails_with_a_disconnect_exception()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var answered = new TaskCompletionSource<RouterResult>(TaskCreationOptions.RunContinuationsAsynchronously);

        router.Answer = (_) =>
        {
            return answered.Task;
        };

        // held by the router, its request in flight
        var registering = new ServiceManager(router).GetNotification(Echo, Notified()).Register(new Text("s"), HeardBy(heard))();

        router.Drop();
        answered.SetResult(ResultOf(Encode(new Text("ok"))));

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return registering.WaitAsync(Patience, Cancelled);
        });
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Empty(heard);
    }

    [Fact]
    public async Task Await_using_takes_the_callback_away()
    {
        var router = new RecordingRouter();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        await using (var registration = await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled))
        {
            Assert.NotNull(registration);
        }

        Assert.Equal([("echo", true)], router.UnregisteredNotifications);
    }

    [Fact]
    public async Task A_registration_while_the_last_one_is_leaving_waits_for_it_then_registers_anew()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var gate = new TaskCompletionSource();
        var leaving = await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        router.UnregisterGate = gate.Task;

        var left = leaving.Unregister();
        var joining = notification.Register(new Text("s"), HeardBy(heard))();

        gate.SetResult();
        await left.WaitAsync(Patience, Cancelled);
        await joining.WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(["echo", "echo"], router.RegisteredNotifications);
        Assert.Equal(["news"], heard);
    }

    [Fact]
    public async Task Taking_the_same_registration_away_twice_leaves_another_of_the_same_callback_alone()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var callback = HeardBy(heard);
        var first = await notification.Register(new Text("s"), callback)().WaitAsync(Patience, Cancelled);
        var second = await notification.Register(new Text("s"), callback)().WaitAsync(Patience, Cancelled);

        await first.Unregister().WaitAsync(Patience, Cancelled);
        await first.Unregister().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("one")).WaitAsync(Patience, Cancelled);

        Assert.Empty(router.UnregisteredNotifications);
        Assert.Equal(["one"], heard);

        await second.Unregister().WaitAsync(Patience, Cancelled);
        await second.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Equal([("echo", true)], router.UnregisteredNotifications);
    }

    // the TypeScript side also says in which order the two settle; here the second's continuation
    // runs on the thread pool, so the test says only that both wait, then both settle
    [Fact]
    public async Task A_registration_arriving_while_the_router_subscribes_waits_for_the_subscription()
    {
        var router = new RecordingRouter();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());
        var gate = new TaskCompletionSource();

        router.SubscribeGate = gate.Task;

        var settled = new List<string>();

        async Task Register(string value)
        {
            await notification.Register(new Text(value), Unheard)();
            settled.Add(value);
        }

        var first = Register("a");

        // the router holds it now, and is still subscribing
        Assert.True(router.Holds(Echo.Address));

        var second = Register("b");

        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        gate.SetResult();
        await Task.WhenAll(first, second).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Requests);
        Assert.Equal(["a", "b"], settled);
    }

    [Fact]
    public async Task A_subscription_that_fails_is_undone_so_the_next_registration_starts_over()
    {
        var router = new RecordingRouter { SubscribeError = new IOException("refused by the broker") };
        var heard = new List<string>();
        var notification = new ServiceManager(router).GetNotification(Echo, Notified());

        var failure = await Assert.ThrowsAsync<IOException>(() =>
        {
            return notification.Register(new Text("a"), HeardBy(heard, "a"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("refused by the broker", failure.Message);
        Assert.False(router.Holds(Echo.Address));
        Assert.Equal([("echo", true)], router.UnregisteredNotifications);

        router.SubscribeError = null;
        await notification.Register(new Text("b"), HeardBy(heard, "b"))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        // the first never asked: the router could not hold it
        Assert.Single(router.Requests);
        Assert.Equal(["b news"], heard);
    }

    [Fact]
    public async Task A_second_manager_on_the_same_router_cannot_take_its_procedure_over_nor_away()
    {
        var router = new RecordingRouter();
        var heard = new List<string>();

        await using var registration = await new ServiceManager(router).GetNotification(Echo, Notified()).Register(new Text("s"), HeardBy(heard))()
            .WaitAsync(Patience, Cancelled);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return new ServiceManager(router).GetNotification(Echo, Notified()).Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);
        });
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(["news"], heard);
        Assert.Empty(router.UnregisteredNotifications);
    }

    [Fact]
    public async Task The_same_procedure_gives_the_same_notification_so_every_callback_is_heard()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var heard = new List<string>();
        var first = manager.GetNotification(Echo, Notified());
        var second = manager.GetNotification(Echo, Notified());

        Assert.Same(first, second);

        await first.Register(new Text("s"), HeardBy(heard, "first"))().WaitAsync(Patience, Cancelled);
        await second.Register(new Text("s"), HeardBy(heard, "second"))().WaitAsync(Patience, Cancelled);
        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(["first news", "second news"], heard);
    }

    [Fact]
    public void The_same_procedure_under_another_name_revision_or_limit_is_an_invalid_operation()
    {
        var manager = new ServiceManager(new RecordingRouter());

        manager.GetNotification(Echo, Notified());

        foreach (var asked in new[] { Echo with { ProcedureName = "echo2" }, Echo with { ServiceRevision = 4 }, Echo with { MaximumPayloadBytes = 8 } })
        {
            Assert.Throws<InvalidOperationException>(() =>
            {
                return manager.GetNotification(asked, Notified());
            });
        }

        // a serializer of its own, for the same ask, gets the same notification
        Assert.Same(
            manager.GetNotification(Echo, Notified()),
            manager.GetNotification(Echo, new NotificationDependencies<Text, Text, Text> { Serializer = new JsonPayloads<Text>() }));
    }

    // no twin on the TypeScript side, whose payload types are gone once compiled: here the same
    // procedure asked for with payloads of other types would be a notification its router never holds
    [Fact]
    public void The_same_procedure_asked_for_with_payloads_of_other_types_is_an_invalid_operation()
    {
        var manager = new ServiceManager(new RecordingRouter());

        manager.GetNotification(Echo, Notified());

        Assert.Throws<InvalidOperationException>(() =>
        {
            return manager.GetNotification(Echo, new NotificationDependencies<string, string, string> { Serializer = new JsonPayloads<string>() });
        });
    }

    [Fact]
    public async Task A_trigger_the_router_never_registered_is_an_invalid_operation()
    {
        var notification = new ServiceManager(new RecordingRouter()).GetNotification(Echo, Notified());

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return notification.Trigger(Encode(new Text("stray"))).WaitAsync(Patience, Cancelled);
        });
    }

    // debugging 4.1.10, 4.2.5 and 4.2.6
    [Fact]
    public async Task Tells_a_notification_sent_or_heard_with_no_call_id()
    {
        var router = new RecordingRouter(RouterSide.Client);
        var manager = new ServiceManager(router);
        var notifying = new ServiceManager(new RecordingRouter());
        var notification = manager.GetNotification(Echo, Notified());
        var resolver = notifying.GetNotificationResolver(Echo, Notifying)(UnansweringNotified);

        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        var seen = RecordDebug(manager);
        var sent = RecordDebug(notifying);

        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("more news")).WaitAsync(Patience, Cancelled);

        // * a notification names no call: no id, and no connection
        Assert.Equal<(DebugDirection, DebugType, object?, uint?, string?)>(
            [
                (DebugDirection.Rx, DebugType.Notification, new Text("news"), null, null),
                (DebugDirection.Tx, DebugType.Notification, new Text("more news"), null, null),
            ],
            seen.Concat(sent).Select((told) =>
            {
                return (told.Event.Direction, told.Event.Type, told.Event.Rx ?? told.Event.Tx, told.Event.CallId, told.Event.ConnectionHandle);
            }));
    }

    // spec 17.2.3
    [Fact]
    public async Task A_notification_that_does_not_decode_fails_here_for_the_router_to_report()
    {
        var router = new RecordingRouter(RouterSide.Client);
        var manager = new ServiceManager(router);
        var heard = new List<string>();
        var notification = manager.GetNotification(Echo, Notified());

        await notification.Register(new Text("s"), HeardBy(heard))().WaitAsync(Patience, Cancelled);

        var seen = RecordDebug(manager);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return notification.Trigger("{not json"u8.ToArray()).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.Null(failure.Header);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(Echo.Address, failure.ProcedureAddress);
        Assert.Equal(RouterSide.Client, failure.Side);
        Assert.Empty(heard);
        Assert.Equal([(DebugDirection.Rx, DebugType.Notification)], StepsOf(seen));
        Assert.Same(failure, Assert.Single(seen).Error);
    }

    [Fact]
    public async Task Hands_the_filter_one_subscriber_its_connection_and_its_session_s_identifier()
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetNotificationResolver(Echo, Notifying)(UnansweringNotified);
        var grace = new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = "https://a.example", Sub = "grace" };
        var heard = new List<(string ConnectionHandle, SessionIdentifier? Identifier)>();

        await resolver.Notify(new Text("news"), new NotifyOptions
        {
            Exclude = "b",
            Filter = (subscriber) =>
            {
                heard.Add((subscriber.ConnectionHandle, subscriber.Identifier));

                return subscriber.Identifier == grace;
            },
        }).WaitAsync(Patience, Cancelled);

        var filter = Assert.Single(router.Notified).Request.Filter!;

        Assert.Equal(
            [true, false, false],
            new[]
            {
                filter(new Subscriber { ConnectionHandle = "a", Identifier = grace }),
                filter(new Subscriber { ConnectionHandle = "a" }),
                filter(new Subscriber { ConnectionHandle = "b", Identifier = grace }),
            });
        Assert.Equal([("a", (SessionIdentifier?)grace), ("a", null)], heard);
    }

    [Fact]
    public async Task A_router_own_handle_reaches_the_callback_for_the_session_manager_to_take()
    {
        var router = new RecordingRouter();

        using var sessions = new SessionManager<string>();

        sessions.GetOrElseSet(Handle);

        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(new BeforeRequest((request) =>
        {
            return sessions.Has(request.ConnectionHandle);
        })))((request, response) =>
        {
            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(new Text("hi"), Assert.Single(router.Responses).Payload);
    }

    // what the tests send and answer: a text, as JSON
    private sealed record Text(string Value);

    // an answer as the router was handed it: its request, and its payload decoded, or its failure
    private sealed record Responded(AnswerTarget Target, Text? Payload, Failure? Failure);

    // JSON, in UTF-8, either way and on either side; what is not JSON throws
    private sealed class JsonPayloads<T> : INotificationSerializerClient<T, T, T>, INotificationSerializerServer<T, T, T>
    {
        public ReadOnlyMemory<byte> Encode(T request)
        {
            return JsonSerializer.SerializeToUtf8Bytes(request, JsonOptions);
        }

        public T Decode(ReadOnlyMemory<byte> response)
        {
            return JsonSerializer.Deserialize<T>(response.Span, JsonOptions)!;
        }

        public T DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return Decode(notification);
        }

        public ReadOnlyMemory<byte> EncodeNotification(T notification)
        {
            return Encode(notification);
        }
    }

    // a resolver's serializer that reads a request, and cannot write its answer
    private sealed class Unencodable : IRequestSerializerServer<Text, Text>
    {
        public Text Decode(ReadOnlyMemory<byte> request)
        {
            return Json.Decode(request);
        }

        public ReadOnlyMemory<byte> Encode(Text response)
        {
            throw new FormatException("cannot encode");
        }
    }

    // a requester's serializer that cannot write its request
    private sealed class Unwritable : IRequestSerializerClient<Text, Text>
    {
        public ReadOnlyMemory<byte> Encode(Text request)
        {
            throw new FormatException("cannot write");
        }

        public Text Decode(ReadOnlyMemory<byte> response)
        {
            return Json.Decode(response);
        }
    }

    // a notifying side's serializer that reads a request and writes an answer, and cannot write its
    // notification
    private sealed class UnwritableNotification : INotificationSerializerServer<Text, Text, Text>
    {
        public Text Decode(ReadOnlyMemory<byte> request)
        {
            return Json.Decode(request);
        }

        public ReadOnlyMemory<byte> Encode(Text response)
        {
            return Json.Encode(response);
        }

        public ReadOnlyMemory<byte> EncodeNotification(Text notification)
        {
            throw new FormatException("cannot write");
        }
    }

    // a router that records every call, draws call 7 for each request and answers it as a test
    // scripts it — its own payload unless told otherwise — and holds notifications; it raises the
    // failures of its side, a server's unless given, and subscribes a request under its own call id
    private sealed class RecordingRouter(RouterSide side = RouterSide.Server) : IRouterLike
    {
        private readonly Lock _gate = new();
        private readonly Dictionary<ProcedureAddress, INotificationLike> _held = [];

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public int DetailBytes { get; init; } = LimitDefaults.MaximumDetailBytes;

        public List<IRequestResolver> RegisteredResolvers { get; } = [];

        public List<(Text Payload, RouterRequest Request)> Requests { get; } = [];

        public List<Responded> Responses { get; } = [];

        public List<(Text Payload, NotifyRequest Request)> Notified { get; } = [];

        // why each notification whose value did not write was handed on with no payload
        public List<Exception> Unwritten { get; } = [];

        public List<AnswerTarget> Subscribed { get; } = [];

        // each requester declared, by its procedure's name, and the series each was given
        public List<(string ProcedureName, ProcedureSeries Series)> Declared { get; } = [];

        // what was reported through it, with its connection
        public List<(Exception Reason, string? ConnectionHandle)> Reports { get; } = [];

        public List<string> RegisteredNotifications { get; } = [];

        // each notification unregistered, and whether the router was told to cancel its call
        public List<(string ProcedureName, bool Cancel)> UnregisteredNotifications { get; } = [];

        // the call id each request draws, heard through its OnCallId; none, a router that draws none
        public uint? CallId { get; set; } = 7;

        // what a request settles with
        public Func<ReadOnlyMemory<byte>, Task<RouterResult>> Answer { get; set; } = EchoOf;

        // what an answer fails with once recorded; none unless a test says
        public Func<RouterAnswer, Exception?> RespondError { get; set; } = (_) =>
        {
            return null;
        };

        // the failure it answered a request with in its resolver's place; none unless a test says
        public Func<AnswerTarget, Failure?> FailureAnswered { get; set; } = (_) =>
        {
            return null;
        };

        // what a notify waits on once recorded, before it settles, and what it then fails with
        public Task NotifyGate { get; set; } = Task.CompletedTask;

        public Exception? NotifyError { get; set; }

        // what a registration waits on once the router holds it, as a subscription would, and what
        // it then fails with
        public Task SubscribeGate { get; set; } = Task.CompletedTask;

        public Exception? SubscribeError { get; set; }

        // what an unregistration waits on before the router lets go of the notification
        public Task UnregisterGate { get; set; } = Task.CompletedTask;

        public RouterSide Side
        {
            get
            {
                return side;
            }
        }

        public void RegisterResolver(IRequestResolver resolver)
        {
            lock (_gate)
            {
                RegisteredResolvers.Add(resolver);
            }
        }

        public Task Respond(RouterAnswer response, AnswerTarget target)
        {
            ArgumentNullException.ThrowIfNull(response);

            lock (_gate)
            {
                Responses.Add(new Responded(target, response.Failure is null ? Json.Decode(response.Payload) : null, response.Failure));
            }

            return RespondError(response) is { } error ? Task.FromException(error) : Task.CompletedTask;
        }

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            ArgumentNullException.ThrowIfNull(request);

            lock (_gate)
            {
                Requests.Add((Json.Decode(payload), request));
            }

            if (CallId is { } drawn)
            {
                request.OnCallId?.Invoke(drawn);
            }

            return Answer(payload);
        }

        public ProcedureSeries? DeclareRequester(Procedure procedure)
        {
            ArgumentNullException.ThrowIfNull(procedure);

            // a series of its own, which the requests it hands over are told apart by
            var series = new ProcedureSeries(new CallSeries(CallTable.Client, procedure.ProcedureName));

            lock (_gate)
            {
                Declared.Add((procedure.ProcedureName, series));
            }

            return series;
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            lock (_gate)
            {
                Reports.Add((reason, connectionHandle));
            }
        }

        public async Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
        {
            lock (_gate)
            {
                Notified.Add((Json.Decode(payload), request));
            }

            await Notifying();
        }

        public async Task Notify(Exception unwritten, NotifyRequest request)
        {
            lock (_gate)
            {
                Unwritten.Add(unwritten);
            }

            await Notifying();
        }

        // a notification handed on settles as the test lets it, with the error it gives
        private async Task Notifying()
        {
            await NotifyGate;

            if (NotifyError is { } error)
            {
                throw error;
            }
        }

        public Task<uint> Subscribe(AnswerTarget target)
        {
            lock (_gate)
            {
                Subscribed.Add(target);
            }

            return Task.FromResult(target.Header.CallId);
        }

        public Failure? AnsweredOf(AnswerTarget target)
        {
            return FailureAnswered(target);
        }

        public bool HasNotification(INotificationLike notification)
        {
            ArgumentNullException.ThrowIfNull(notification);

            lock (_gate)
            {
                return _held.TryGetValue(notification.Procedure.Address, out var held) && ReferenceEquals(held, notification);
            }
        }

        // held first, then subscribed, as a router over a broker does
        public async Task RegisterNotification(INotificationLike notification)
        {
            ArgumentNullException.ThrowIfNull(notification);

            lock (_gate)
            {
                RegisteredNotifications.Add(notification.Procedure.ProcedureName);

                if (!_held.TryAdd(notification.Procedure.Address, notification))
                {
                    throw new InvalidOperationException("already registered");
                }
            }

            await SubscribeGate;

            if (SubscribeError is { } error)
            {
                throw error;
            }
        }

        public async Task UnregisterNotification(INotificationLike notification, bool cancel = true)
        {
            ArgumentNullException.ThrowIfNull(notification);

            lock (_gate)
            {
                UnregisteredNotifications.Add((notification.Procedure.ProcedureName, cancel));
            }

            await UnregisterGate;

            // another's of the same procedure stays, as a router keeps it
            lock (_gate)
            {
                if (_held.TryGetValue(notification.Procedure.Address, out var held) && ReferenceEquals(held, notification))
                {
                    _held.Remove(notification.Procedure.Address);
                }
            }
        }

        // what the router does with a notification for a procedure: its callbacks' faults, if held
        public Task<IReadOnlyList<Exception>> Deliver(ProcedureAddress address, Text notification)
        {
            INotificationLike? held;

            lock (_gate)
            {
                held = _held.GetValueOrDefault(address);
            }

            return held is null ? Task.FromResult<IReadOnlyList<Exception>>([]) : held.Trigger(Json.Encode(notification));
        }

        // what the router does when its connection closes, or the server ends each subscription
        // with a failure: it lets go of each, and tells it
        public void Drop(Failure? failure = null)
        {
            List<INotificationLike> dropped;

            lock (_gate)
            {
                dropped = [.. _held.Values];
                _held.Clear();
            }

            foreach (var notification in dropped)
            {
                notification.Drop(failure);
            }
        }

        // whether the router holds a notification of a procedure, whichever it is
        public bool Holds(ProcedureAddress address)
        {
            lock (_gate)
            {
                return _held.ContainsKey(address);
            }
        }
    }
}
