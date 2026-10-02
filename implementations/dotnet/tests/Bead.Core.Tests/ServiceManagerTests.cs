using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceManager"/>: its requesters, its resolvers and their admission, and its
/// notifications, over a router that records every call and answers as a test scripts it.
/// </summary>
public sealed class ServiceManagerTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001";

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

    // when a test's clock starts: a trace's timestamps are read from it
    private static readonly DateTimeOffset Started = DateTimeOffset.FromUnixTimeMilliseconds(1_000);

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
    public async Task Fills_what_the_options_leave_out_and_passes_a_destination_as_it_is()
    {
        var router = new RecordingRouter();
        var requester = new ServiceManager(router).GetRequest(Echo, Asked)(new Text("a"));

        await requester().WaitAsync(Patience, Cancelled);
        await requester(new RequestOptions { ConnectionHandle = Handle, DestinationId = null }).WaitAsync(Patience, Cancelled);
        await requester(new RequestOptions { DestinationId = 4, Timeout = TimeSpan.FromMilliseconds(10) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                new ResolvedRequestOptions { Timeout = TimeoutDefault },
                new ResolvedRequestOptions { ConnectionHandle = Handle, Timeout = TimeoutDefault },
                new ResolvedRequestOptions { DestinationId = 4, Timeout = TimeSpan.FromMilliseconds(10) },
            ],
            router.Requests.Select((sent) =>
            {
                return sent.Request.Options;
            }));
    }

    [Fact]
    public async Task Sends_the_encoded_payload_with_the_resolved_options_and_decodes_the_answer()
    {
        var router = new RecordingRouter();

        var echoed = await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("hello"))(
            new RequestOptions { Timeout = TimeSpan.FromMilliseconds(100) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(new Text("hello"), echoed);

        var (payload, request) = Assert.Single(router.Requests);

        Assert.Equal(new Text("hello"), payload);
        Assert.Equal(new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromMilliseconds(100) }), request);
    }

    // a destination is a call's own, never a default: RequestDefaults has none
    [Fact]
    public async Task Takes_the_manager_defaults_where_the_call_says_nothing_and_its_token_as_given()
    {
        var router = new RecordingRouter();
        var requester = new ServiceManager(router, new ServiceManagerOptions
        {
            Defaults = new RequestDefaults { Timeout = TimeSpan.FromMilliseconds(50) },
        }).GetRequest(Echo, Asked);

        using var source = new CancellationTokenSource();

        await requester(new Text("a"))().WaitAsync(Patience, Cancelled);
        await requester(new Text("b"))(new RequestOptions
        {
            CancellationToken = source.Token,
            DestinationId = 2,
            Timeout = TimeSpan.FromMilliseconds(9),
        }).WaitAsync(Patience, Cancelled);

        // a manager given no defaults waits 5 s
        await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("c"))().WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                new ResolvedRequestOptions { Timeout = TimeSpan.FromMilliseconds(50) },
                new ResolvedRequestOptions { CancellationToken = source.Token, DestinationId = 2, Timeout = TimeSpan.FromMilliseconds(9) },
                new ResolvedRequestOptions { Timeout = TimeoutDefault },
            ],
            router.Requests.Select((sent) =>
            {
                return sent.Request.Options;
            }));
    }

    [Fact]
    public async Task On_a_server_router_names_the_connection_it_goes_to()
    {
        var router = new RecordingRouter();

        await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("a"))(new RequestOptions { ConnectionHandle = Handle })
            .WaitAsync(Patience, Cancelled);

        Assert.Equal(Handle, Assert.Single(router.Requests).Request.Options.ConnectionHandle);
    }

    [Fact]
    public async Task Rethrows_what_the_router_rejects_with_and_tells_debug_its_failure_and_only_a_failure_one()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var requester = manager.GetRequest(Echo, Asked);
        var failure = new FailureException(
            Failure.OfProtocol(ProtocolCode.AccessDenied, "no"),
            new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server));

        // what is not a failure goes on as it is as well
        var reset = new IOException("reset");

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(failure);
        };
        Assert.Same(failure, await Assert.ThrowsAsync<FailureException>(() =>
        {
            return requester(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal<Exception?>(
            [null, failure],
            seen.Select((told) =>
            {
                return told.Error;
            }));
        Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied, "no"), seen[1].Event.Rx);
        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(reset);
        };
        Assert.Same(reset, await Assert.ThrowsAsync<IOException>(() =>
        {
            return requester(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Same(reset, seen[3].Error);
        Assert.Null(seen[3].Event.Rx);
    }

    [Fact]
    public async Task A_deprecated_procedure_raises_deprecated_at_each_call_and_only_a_deprecated_one()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var seen = new List<Procedure>();
        var old = Echo with { Deprecation = new ProcedureDeprecation { Message = "use echo2" } };

        // present, even empty, is deprecated
        var empty = Echo with { Deprecation = new ProcedureDeprecation() };

        manager.Deprecated += seen.Add;

        var requester = manager.GetRequest(old, Asked);

        await requester(new Text("a"))().WaitAsync(Patience, Cancelled);
        await requester(new Text("b"))().WaitAsync(Patience, Cancelled);
        await manager.GetRequest(Echo, Asked)(new Text("c"))().WaitAsync(Patience, Cancelled);
        await manager.GetRequest(empty, Asked)(new Text("d"))().WaitAsync(Patience, Cancelled);

        Assert.Equal([old, old, empty], seen);
    }

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

    [Fact]
    public async Task Tells_each_step_of_a_request_and_once_answered_its_duration()
    {
        var time = new FakeTimeProvider(Started);
        var router = new RecordingRouter();
        var manager = new ServiceManager(router, new ServiceManagerOptions { Time = time });
        var seen = RecordDebug(manager);

        router.Answer = (payload) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(30));

            return EchoOf(payload);
        };
        await manager.GetRequest(Echo, Asked)(new Text("hello"))().WaitAsync(Patience, Cancelled);

        var sent = new DebugEvent
        {
            Direction = DebugDirection.Tx,
            Options = new ResolvedRequestOptions { Timeout = TimeoutDefault },
            ProcedureId = 1,
            ProcedureName = "echo",
            ServiceId = 2,
            ServiceRevision = 3,
            Timestamp = new DebugTimestamp(null, 1_000),
            Tx = new Text("hello"),
            Type = DebugType.Request,
        };

        Assert.Equal(
            [sent, sent with { Direction = DebugDirection.Rx, Rx = new Text("hello"), Timestamp = new DebugTimestamp(30, 1_000) }],
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
    }

    [Fact]
    public async Task A_debug_listener_that_throws_on_the_answer_fails_the_call_once_with_no_second_trace()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var seen = new List<DebugDirection>();
        var failure = new InvalidOperationException("listener bug");

        manager.Debug += (_, told) =>
        {
            seen.Add(told.Direction);

            if (told.Direction == DebugDirection.Rx)
            {
                throw failure;
            }
        };

        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return manager.GetRequest(Echo, Asked)(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal([DebugDirection.Tx, DebugDirection.Rx], seen);
    }

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
    public async Task Hands_the_router_a_procedure_payload_limit_with_its_requests_and_its_resolver()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var limited = Echo with { MaximumPayloadBytes = 64 };

        manager.GetRequestResolver(limited, Answered())(Unanswering);
        await manager.GetRequest(limited, Asked)(new Text("hi"))().WaitAsync(Patience, Cancelled);

        Assert.Equal(64, Assert.Single(router.RegisteredResolvers).MaximumPayloadBytes);
        Assert.Equal(limited, Assert.Single(router.Requests).Request.Procedure);
    }

    [Fact]
    public void Makes_and_registers_the_resolver_only_once_it_is_given_its_callback()
    {
        var router = new RecordingRouter();
        var define = new ServiceManager(router).GetRequestResolver(Echo, Answered());

        Assert.Empty(router.RegisteredResolvers);

        var resolver = define(Unanswering);

        Assert.Same(resolver, Assert.Single(router.RegisteredResolvers));
        Assert.Equal("echo", resolver.Procedure.ProcedureName);
        Assert.Equal(1, resolver.Procedure.ProcedureId);
    }

    [Fact]
    public async Task Hands_the_callback_a_decoded_request_and_sends_its_answer_back()
    {
        var router = new RecordingRouter();
        RequestProps<Text>? handed = null;
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())((request, response) =>
        {
            handed = request;

            return response.Answer(new Text($"{request.Payload.Value}!"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(new Text("hi"), handed?.Payload);
        Assert.Equal(Handle, handed?.ConnectionHandle);
        Assert.Same(Header, handed?.Header);
        Assert.Equal([new Responded(Target, new Text("hi!"), null)], router.Responses);
    }

    [Fact]
    public async Task Hands_the_callback_the_signal_of_its_call_which_its_cancel_aborts()
    {
        var seen = new List<bool>();

        using var source = new CancellationTokenSource();

        var resolver = new ServiceManager(new RecordingRouter()).GetRequestResolver(Echo, Answered())(async (request, response) =>
        {
            seen.Add(request.Signal.IsCancellationRequested);
            await Task.Yield();
            await source.CancelAsync();
            seen.Add(request.Signal.IsCancellationRequested);
            await response.Answer(new Text("late"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi"))) with { Signal = source.Token }).WaitAsync(Patience, Cancelled);

        Assert.Equal([false, true], seen);
    }

    [Fact]
    public async Task An_answer_with_a_failure_of_the_procedure_own_sends_it_as_the_application_one()
    {
        var router = new RecordingRouter();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())((_, response) =>
        {
            return response.Fail(Failure.OfApplication(7, "why"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            new Failure { Code = 7, Detail = "why", Scope = FailureScope.Application },
            Assert.Single(router.Responses).Failure);
    }

    [Fact]
    public async Task A_payload_that_does_not_decode_is_answered_as_undecodable_with_no_detail_never_reaching_the_callback()
    {
        var router = new RecordingRouter();
        var reached = false;
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())((_, _) =>
        {
            reached = true;

            return Task.CompletedTask;
        });

        await resolver.Handle(PropsOf("{not json"u8.ToArray())).WaitAsync(Patience, Cancelled);

        Assert.False(reached);
        Assert.Equal([new Responded(Target, null, Failure.OfProtocol(ProtocolCode.PayloadUndecodable))], router.Responses);
    }

    [Fact]
    public async Task A_request_before_request_refuses_is_answered_with_an_access_denied_seen_on_its_header_alone()
    {
        var router = new RecordingRouter();
        var reached = new List<string>();
        var seen = new List<AdmissionRequest>();
        var beforeRequest = new BeforeRequest((request) =>
        {
            seen.Add(request);

            return request.Header.CallId == 9;
        });
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(beforeRequest))((request, response) =>
        {
            reached.Add(request.Payload.Value);

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("refused")))).WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("allowed"))) with { Header = Header with { CallId = 9 } }).WaitAsync(Patience, Cancelled);

        Assert.Equal(["allowed"], reached);
        Assert.Equal([new AdmissionRequest(Handle, Header), new AdmissionRequest(Handle, Header with { CallId = 9 })], seen);
        Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied), router.Responses[0].Failure);
    }

    // a failure carries no side here — the router writes it as its own — so what is left to show is
    // a client's resolver refusing before it reads
    [Fact]
    public async Task On_a_client_router_a_refusal_is_the_client_one()
    {
        var router = new RecordingRouter(RouterSide.Client);
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(new BeforeRequest((_) =>
        {
            return false;
        })))(Unanswering);

        // refused before it is read, one that does not decode as well
        await resolver.Handle(PropsOf("{not json"u8.ToArray())).WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [Failure.OfProtocol(ProtocolCode.AccessDenied), Failure.OfProtocol(ProtocolCode.AccessDenied)],
            router.Responses.Select((responded) =>
            {
                return responded.Failure;
            }));
    }

    [Fact]
    public async Task A_request_is_answered_once_a_second_answer_is_an_invalid_operation_and_sends_nothing()
    {
        var router = new RecordingRouter();
        var second = new List<Exception>();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())(async (request, response) =>
        {
            await response.Answer(request.Payload);
            second.Add(await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return response.Answer(request.Payload);
            }));
            second.Add(await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return response.Fail(Failure.OfApplication(1));
            }));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Responses);
        Assert.Equal(2, second.Count);
    }

    [Fact]
    public async Task A_callback_that_fails_before_it_answers_is_answered_as_failed_and_its_reason_goes_on_to_the_router()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var thrown = new InvalidOperationException("thrown");
        var rejected = new InvalidOperationException("rejected");
        var throwing = manager.GetRequestResolver(Echo, Answered())((_, _) =>
        {
            throw thrown;
        });
        var rejecting = manager.GetRequestResolver(Echo with { ProcedureId = 2 }, Answered())((_, _) =>
        {
            return Task.FromException(rejected);
        });
        var refusing = manager.GetRequestResolver(Echo with { ProcedureId = 3 }, Answered(new BeforeRequest((_) =>
        {
            throw thrown;
        })))(Unanswering);
        var request = PropsOf(Encode(new Text("hi")));

        Assert.Same(thrown, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return throwing.Handle(request).WaitAsync(Patience, Cancelled);
        }));
        Assert.Same(rejected, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return rejecting.Handle(request).WaitAsync(Patience, Cancelled);
        }));
        Assert.Same(thrown, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return refusing.Handle(request).WaitAsync(Patience, Cancelled);
        }));

        // the reason stays with the router: what the requester hears is only that it failed
        Assert.Equal(
            Enumerable.Repeat(new Responded(Target, null, Failure.OfProtocol(ProtocolCode.ProcedureFailed)), 3),
            router.Responses);
    }

    [Fact]
    public async Task An_answer_that_cannot_go_out_leaves_the_request_to_be_answered_as_failed()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);

        // an answer the serializer cannot encode
        var unencodable = manager.GetRequestResolver(
            Echo with { ProcedureId = 10 },
            new RequestResolverDependencies<Text, Text> { Serializer = new Unencodable() })((_, response) =>
            {
                return response.Answer(new Text("unencodable"));
            });

        await Assert.ThrowsAsync<FormatException>(() =>
        {
            return unencodable.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        });

        // a code of the procedure's own below 1, and a protocol failure other than an admission's
        Failure[] refused = [Failure.OfApplication(0), Failure.OfProtocol(ProtocolCode.ServiceUnknown)];

        for (var index = 0; index < refused.Length; index += 1)
        {
            var failure = refused[index];
            var resolver = manager.GetRequestResolver(Echo with { ProcedureId = (ushort)(11 + index) }, Answered())((_, response) =>
            {
                return response.Fail(failure);
            });

            await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
            });
        }

        Assert.Equal(
            Enumerable.Repeat(Failure.OfProtocol(ProtocolCode.ProcedureFailed), 3),
            router.Responses.Select((responded) =>
            {
                return responded.Failure;
            }));
    }

    [Fact]
    public async Task An_answer_the_router_cannot_send_is_answered_as_failed_and_the_callback_hears_why()
    {
        var router = new RecordingRouter();
        var tooLarge = FailureException.OfProtocol(ProtocolCode.PayloadTooLarge, RouterSide.Server);
        Exception? heard = null;

        // the payload answer goes nowhere; a failure goes out
        router.RespondError = (answer) =>
        {
            return answer.Failure is null ? tooLarge : null;
        };

        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())(async (request, response) =>
        {
            heard = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return response.Answer(request.Payload);
            });
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Same(tooLarge, heard);
        Assert.Equal(
            [new Responded(Target, new Text("hi"), null), new Responded(Target, null, Failure.OfProtocol(ProtocolCode.ProcedureFailed))],
            router.Responses);
    }

    [Fact]
    public async Task A_refusal_that_cannot_go_out_is_not_answered_again()
    {
        var router = new RecordingRouter();
        var gone = new IOException("gone");

        router.RespondError = (_) =>
        {
            return gone;
        };

        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(new BeforeRequest((_) =>
        {
            return false;
        })))(Unanswering);

        Assert.Same(gone, await Assert.ThrowsAsync<IOException>(() =>
        {
            return resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal([new Responded(Target, null, Failure.OfProtocol(ProtocolCode.AccessDenied))], router.Responses);
    }

    [Fact]
    public async Task A_callback_that_fails_after_it_answered_is_not_answered_again()
    {
        var router = new RecordingRouter();
        var failure = new InvalidOperationException("after");
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered())(async (request, response) =>
        {
            await response.Answer(request.Payload);

            throw failure;
        });

        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal([new Responded(Target, new Text("hi"), null)], router.Responses);
    }

    [Fact]
    public async Task Tells_debug_the_request_it_received_and_the_answer_it_sent()
    {
        var time = new FakeTimeProvider(Started);
        var manager = new ServiceManager(new RecordingRouter(), new ServiceManagerOptions { Time = time });
        var seen = RecordDebug(manager);
        var resolver = manager.GetRequestResolver(Echo, Answered())((request, response) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(30));

            return response.Answer(new Text($"{request.Payload.Value}!"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        var received = new DebugEvent
        {
            Direction = DebugDirection.Rx,
            ProcedureId = 1,
            ProcedureName = "echo",
            Rx = new Text("hi"),
            ServiceId = 2,
            ServiceRevision = 3,
            Timestamp = new DebugTimestamp(null, 1_000),
            Type = DebugType.Request,
        };

        Assert.Equal(
            [received, received with { Direction = DebugDirection.Tx, Timestamp = new DebugTimestamp(30, 1_000), Tx = new Text("hi!") }],
            seen.Select((told) =>
            {
                return told.Event;
            }));
    }

    [Fact]
    public async Task A_command_unanswered_in_time_closes_its_connection_as_the_call_or_else_the_manager_says_nothing_else_does()
    {
        var router = new RecordingRouter();
        var closed = new List<string>();
        var late = new TimeoutException("unanswered in 10 ms");
        var refused = new FailureException(
            Failure.OfProtocol(ProtocolCode.ProcedureFailed),
            new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server));
        Exception failure = late;
        var byDefault = new ServiceManager(router, new ServiceManagerOptions
        {
            CloseConnection = closed.Add,
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });
        var unlessAsked = new ServiceManager(router, new ServiceManagerOptions { CloseConnection = closed.Add });
        var unable = new ServiceManager(router, new ServiceManagerOptions
        {
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });

        // what the command fails with, the manager and the call's close on timeout given
        ValueTask<Exception?> Call((ServiceManager Manager, bool? CloseOnTimeout) call)
        {
            return Record.ExceptionAsync(() =>
            {
                return call.Manager.GetCommand(Echo, Asked)(new Text("run"))(new RequestOptions
                {
                    CloseOnTimeout = call.CloseOnTimeout,
                    ConnectionHandle = Handle,
                }).WaitAsync(Patience, Cancelled);
            });
        }

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(failure);
        };

        // the call fails with what went wrong either way
        Assert.Same(late, await Call((byDefault, null)));
        Assert.Equal([Handle], closed);

        Assert.Same(late, await Call((byDefault, false)));
        Assert.Same(late, await Call((unlessAsked, null)));
        Assert.Same(late, await Call((unable, null)));
        Assert.Equal([Handle], closed);

        Assert.Same(late, await Call((unlessAsked, true)));
        Assert.Equal([Handle, Handle], closed);

        // a request that names no connection has none to close
        Assert.Same(late, await Record.ExceptionAsync(() =>
        {
            return byDefault.GetRequest(Echo, Asked)(new Text("run"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal(2, closed.Count);

        // an answer, even a refusal, is not silence; nor is a connection gone, or a caller that gave up
        foreach (var other in new Exception[] { refused, new DisconnectException("gone"), new OperationCanceledException() })
        {
            failure = other;

            Assert.Same(other, await Call((byDefault, null)));
        }

        Assert.Equal(2, closed.Count);
    }

    [Fact]
    public async Task Get_command_asks_one_connection_as_a_server_request_does_and_tells_debug_it_is_a_command()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var command = manager.GetCommand(Echo, Asked);

        Assert.Equal(
            new Text("run"),
            await command(new Text("run"))(new RequestOptions { ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled));
        Assert.Equal(Handle, Assert.Single(router.Requests).Request.Options.ConnectionHandle);
        Assert.Equal([(DebugDirection.Tx, DebugType.Command), (DebugDirection.Rx, DebugType.Command)], StepsOf(seen));
    }

    [Fact]
    public async Task Tells_debug_the_close_on_timeout_that_applies_the_call_or_else_the_manager_one()
    {
        var manager = new ServiceManager(new RecordingRouter(), new ServiceManagerOptions
        {
            CloseConnection = (_) =>
            {
            },
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });
        var seen = RecordDebug(manager);
        var command = manager.GetCommand(Echo, Asked)(new Text("run"));

        await command(new RequestOptions { ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled);
        await command(new RequestOptions { CloseOnTimeout = false, ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled);

        Assert.Equal<bool?>(
            [true, false],
            seen
                .Where((told) =>
                {
                    return told.Event.Direction == DebugDirection.Tx;
                })
                .Select((told) =>
                {
                    return told.Event.Options?.CloseOnTimeout;
                }));
    }

    [Fact]
    public async Task Get_command_resolver_runs_the_server_request_registered_in_the_router_and_tells_debug_it_is_a_command()
    {
        var router = new RecordingRouter(RouterSide.Client);
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var resolver = manager.GetCommandResolver(Echo, Answered())((request, response) =>
        {
            return response.Answer(new Text($"{request.Payload.Value} done"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("run")))).WaitAsync(Patience, Cancelled);

        Assert.Same(resolver, Assert.Single(router.RegisteredResolvers));
        Assert.Equal(new Text("run done"), Assert.Single(router.Responses).Payload);
        Assert.Equal([(DebugDirection.Rx, DebugType.Command), (DebugDirection.Tx, DebugType.Command)], StepsOf(seen));
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
        Assert.Equal(new NotifyRequest(Echo.Address, null, null), request);
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
            Filter = (handle) =>
            {
                return handle != "a";
            },
        }).WaitAsync(Patience, Cancelled);
        await resolver.Notify(new Text("news"), new NotifyOptions
        {
            Exclude = "c",
            Filter = (handle) =>
            {
                return handle != "a";
            },
        }).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            ["each", "a c", "b c", "b"],
            router.Notified.Select((notified) =>
            {
                return notified.Request.Filter is { } filter ? string.Join(' ', handles.Where(filter)) : "each";
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

        Assert.Equal(
            new RouterRequest(Echo, new ResolvedRequestOptions { DestinationId = 3, Timeout = TimeSpan.FromMilliseconds(50) })
            {
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

        var first = notification.Register(new Text("a"), Unheard)();

        // the router holds it now, and is still subscribing
        Assert.True(router.Holds(Echo.Address));

        var second = notification.Register(new Text("b"), Unheard)();

        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);

        gate.SetResult();
        await Task.WhenAll(first, second).WaitAsync(Patience, Cancelled);

        Assert.Single(router.Requests);
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

    [Fact]
    public async Task Tells_debug_each_notification_it_hears()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var notification = manager.GetNotification(Echo, Notified());

        await notification.Register(new Text("s"), Unheard)().WaitAsync(Patience, Cancelled);

        var seen = RecordDebug(manager);

        await router.Deliver(Echo.Address, new Text("news")).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [(DebugDirection.Rx, DebugType.Notification, (object?)new Text("news"))],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Event.Type, told.Event.Rx);
            }));
    }

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
    public async Task Refuses_with_an_access_denied_what_is_not_admitted_with_true()
    {
        var refused = new List<string>();
        var admitted = new List<string>();

        Assert.Equal(
            new Responded(Target, null, Failure.OfProtocol(ProtocolCode.AccessDenied)),
            await AdmittedBy(
                new BeforeRequest((_) =>
                {
                    return false;
                }),
                refused));
        Assert.Empty(refused);
        Assert.Equal(
            new Responded(Target, new Text("hi"), null),
            await AdmittedBy(
                new BeforeRequest((_) =>
                {
                    return true;
                }),
                admitted));
        Assert.Equal(["hi"], admitted);
    }

    [Fact]
    public async Task Refuses_with_the_refusal_a_before_request_carries_and_never_reaches_the_callback()
    {
        var reached = new List<string>();
        var requireSession = new BeforeRequest(
            (_) =>
            {
                return false;
            },
            Failure.OfProtocol(ProtocolCode.SessionRequired));

        Assert.Equal(
            new Responded(Target, null, Failure.OfProtocol(ProtocolCode.SessionRequired)),
            await AdmittedBy(requireSession, reached));

        // composed with &&, the refusal is lost: the composition refuses as access denied
        Assert.Equal(
            new Responded(Target, null, Failure.OfProtocol(ProtocolCode.AccessDenied)),
            await AdmittedBy(
                new BeforeRequest((request) =>
                {
                    return requireSession.Admits(request) && request.Header.CallId == 7;
                }),
                reached));
        Assert.Empty(reached);
    }

    [Fact]
    public async Task Is_asked_before_the_payload_is_read_a_request_refused_is_refused_undecodable_and_never_traced()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var resolver = manager.GetRequestResolver(Echo, Answered(new BeforeRequest((_) =>
        {
            return false;
        })))(Unanswering);

        await resolver.Handle(PropsOf("{not json"u8.ToArray())).WaitAsync(Patience, Cancelled);

        Assert.Equal([new Responded(Target, null, Failure.OfProtocol(ProtocolCode.AccessDenied))], router.Responses);
        Assert.Empty(seen);
    }

    [Fact]
    public void Is_the_resolver_one_to_answer_for_its_router_nothing_admits_a_failure_refuses_a_throw_goes_on()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var thrown = new InvalidOperationException("thrown");
        var request = new AdmissionRequest(Handle, Header);

        IRequestResolver ResolverOf(ushort procedureId, BeforeRequest? beforeRequest = null)
        {
            return manager.GetRequestResolver(Echo with { ProcedureId = procedureId }, Answered(beforeRequest))(Unanswering);
        }

        Assert.Equal<Failure?>(
            [null, null, Failure.OfProtocol(ProtocolCode.AccessDenied), Failure.OfProtocol(ProtocolCode.SessionRequired)],
            [
                ResolverOf(1).Admit(request),
                ResolverOf(2, new BeforeRequest((_) =>
                {
                    return true;
                })).Admit(request),
                ResolverOf(3, new BeforeRequest((_) =>
                {
                    return false;
                })).Admit(request),
                ResolverOf(
                    4,
                    new BeforeRequest(
                        (_) =>
                        {
                            return false;
                        },
                        Failure.OfProtocol(ProtocolCode.SessionRequired))).Admit(request),
            ]);
        Assert.Same(thrown, Assert.Throws<InvalidOperationException>(() =>
        {
            return ResolverOf(5, new BeforeRequest((_) =>
            {
                throw thrown;
            })).Admit(request);
        }));
    }

    [Fact]
    public async Task Is_not_asked_again_of_a_request_its_router_admitted()
    {
        var router = new RecordingRouter();
        var asked = new List<uint>();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(new BeforeRequest((request) =>
        {
            asked.Add(request.Header.CallId);

            return false;
        })))((request, response) =>
        {
            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi"))) with { IsAdmitted = true }).WaitAsync(Patience, Cancelled);

        Assert.Empty(asked);
        Assert.Equal(new Text("hi"), Assert.Single(router.Responses).Payload);
    }

    // this side refuses the refusal as its admission is made, before any resolver is; a failure
    // carries no side here, so the other side's table has no twin
    [Fact]
    public void A_refusal_that_is_not_an_admission_is_an_argument_exception_as_the_admission_is_made()
    {
        foreach (var refusal in new[] { Failure.OfProtocol(ProtocolCode.ProcedureUnknown), Failure.OfApplication(33) })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return new BeforeRequest(
                    (_) =>
                    {
                        return false;
                    },
                    refusal);
            });
        }
    }

    [Fact]
    public async Task Are_the_procedure_own_from_1_to_65535_and_nothing_outside()
    {
        foreach (var code in new ushort[] { 1, 0x1000, 0xFFFF })
        {
            Assert.Equal(Failure.OfApplication(code), await AnsweredWith(Failure.OfApplication(code)));
        }

        Assert.Equal(Failure.OfProtocol(ProtocolCode.ProcedureFailed), await AnsweredWith(Failure.OfApplication(0)));
    }

    // a caller that ignores nullability is this side's caller without types
    [Fact]
    public async Task Are_nothing_but_failures_from_a_caller_that_ignores_nullability()
    {
        Assert.Equal(Failure.OfProtocol(ProtocolCode.ProcedureFailed), await AnsweredWith(null!));
    }

    [Fact]
    public async Task May_be_a_refusal_of_admission_with_a_detail()
    {
        Assert.Equal(
            new Failure { Code = 32, Scope = FailureScope.Protocol },
            await AnsweredWith(Failure.OfProtocol(ProtocolCode.SessionRequired)));
        Assert.Equal(
            new Failure { Code = 33, Detail = "admins only", Scope = FailureScope.Protocol },
            await AnsweredWith(Failure.OfProtocol(ProtocolCode.AccessDenied, "admins only")));
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

    // a router that records every call, answers each request as a test scripts it — its own payload
    // unless told otherwise — and holds notifications; it raises the failures of its side, a
    // server's unless given, and subscribes a request under its own call id
    private sealed class RecordingRouter(RouterSide side = RouterSide.Server) : IRouterLike
    {
        private readonly Lock _gate = new();
        private readonly Dictionary<ProcedureAddress, INotificationLike> _held = [];

        public List<IRequestResolver> RegisteredResolvers { get; } = [];

        public List<(Text Payload, RouterRequest Request)> Requests { get; } = [];

        public List<Responded> Responses { get; } = [];

        public List<(Text Payload, NotifyRequest Request)> Notified { get; } = [];

        public List<AnswerTarget> Subscribed { get; } = [];

        public List<string> RegisteredNotifications { get; } = [];

        // each notification unregistered, and whether the router was told to cancel its call
        public List<(string ProcedureName, bool Cancel)> UnregisteredNotifications { get; } = [];

        // what a request settles with
        public Func<ReadOnlyMemory<byte>, Task<RouterResult>> Answer { get; set; } = EchoOf;

        // what an answer fails with once recorded; none unless a test says
        public Func<RouterAnswer, Exception?> RespondError { get; set; } = (_) =>
        {
            return null;
        };

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
            lock (_gate)
            {
                Requests.Add((Json.Decode(payload), request));
            }

            return Answer(payload);
        }

        public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
        {
            lock (_gate)
            {
                Notified.Add((Json.Decode(payload), request));
            }

            return NotifyError is { } error ? Task.FromException(error) : Task.CompletedTask;
        }

        public Task<uint> Subscribe(AnswerTarget target)
        {
            lock (_gate)
            {
                Subscribed.Add(target);
            }

            return Task.FromResult(target.Header.CallId);
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
