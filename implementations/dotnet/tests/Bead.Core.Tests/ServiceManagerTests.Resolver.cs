using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceManager"/>'s resolvers: their admission, their request decoded, their one
/// answer, a refusal or a failure answered in its place, and what each tells debug.
/// </summary>
public sealed partial class ServiceManagerTests
{
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
    public async Task Answers_PAYLOAD_INVALID_to_a_request_its_rules_refuse_before_its_callback()
    {
        var router = new RecordingRouter { DetailBytes = 512 };
        var reached = new List<string>();
        var given = new List<ValidateOptions>();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered() with { FailFast = true, Validate = Judging(given) })((request, response) =>
        {
            reached.Add(request.Payload.Value);

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("")))).WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(["hi"], reached);
        Assert.Equal(
            [
                new Responded(Target, null, Failure.OfProtocol(ProtocolCode.PayloadInvalid, RefusedDetail)),
                new Responded(Target, new Text("hi"), null),
            ],
            router.Responses);

        // * judged under its router's bound and its dependencies' failFast
        Assert.Equal([new ValidateOptions { FailFast = true, MaximumBytes = 512 }, new ValidateOptions { FailFast = true, MaximumBytes = 512 }], given);
    }

    [Fact]
    public async Task Answers_PROCEDURE_FAILED_to_rules_that_throw_and_hands_why_on_for_its_router_to_report()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var broken = new ArgumentOutOfRangeException("request", "a rule that fails to judge");
        var resolver = manager.GetRequestResolver(Echo, Answered() with
        {
            Validate = (_, _) =>
            {
                throw broken;
            },
        })((request, response) =>
        {
            return response.Answer(request.Payload);
        });

        Assert.Same(broken, await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
        {
            return resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal([new Responded(Target, null, Failure.OfProtocol(ProtocolCode.ProcedureFailed))], router.Responses);
        Assert.Equal<(DebugDirection, Exception?)>(
            [(DebugDirection.Rx, null), (DebugDirection.Tx, broken)],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Error);
            }));
    }

    // debugging 4.3
    [Fact]
    public async Task Traces_a_request_its_rules_refuse_its_rx_then_its_failure()
    {
        var time = new FakeTimeProvider(Started);
        var manager = new ServiceManager(new RecordingRouter { Clock = time });
        var seen = RecordDebug(manager);
        var resolver = manager.GetRequestResolver(Echo, Answered() with { FailFast = true, Validate = Judging([]) })(Unanswering);

        await resolver.Handle(PropsOf(Encode(new Text("")))).WaitAsync(Patience, Cancelled);

        var received = new DebugEvent
        {
            CallId = 7,
            ConnectionHandle = Handle,
            Direction = DebugDirection.Rx,
            ProcedureId = 1,
            ProcedureName = "echo",
            Rx = new Text(""),
            ServiceId = 2,
            ServiceRevision = 3,
            StartedAt = Started,
            Type = DebugType.Request,
        };

        Assert.Equal(
            [
                (null, received),
                ((Exception?)null, received with
                {
                    Direction = DebugDirection.Tx,
                    Duration = TimeSpan.Zero,
                    Tx = Failure.OfProtocol(ProtocolCode.PayloadInvalid, RefusedDetail),
                }),
            ],
            seen);
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
        Assert.All(seen, (request) =>
        {
            Assert.Equal(["ConnectionHandle", "Header", "Session"], request.GetType().GetProperties().Select((property) =>
            {
                return property.Name;
            }));
        });
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

    // spec 17.2.5
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

    // debugging 4.1.10, 4.2.3 and 4.2.4
    [Fact]
    public async Task Tells_the_request_it_received_and_the_answer_it_sent_with_that_request_s_call_id_and_connection()
    {
        var time = new FakeTimeProvider(Started);
        var manager = new ServiceManager(new RecordingRouter { Clock = time });
        var seen = RecordDebug(manager);
        var resolver = manager.GetRequestResolver(Echo, Answered())((request, response) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(30));

            return response.Answer(new Text($"{request.Payload.Value}!"));
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        var received = new DebugEvent
        {
            CallId = 7,
            ConnectionHandle = Handle,
            Direction = DebugDirection.Rx,
            ProcedureId = 1,
            ProcedureName = "echo",
            Rx = new Text("hi"),
            ServiceId = 2,
            ServiceRevision = 3,
            StartedAt = Started,
            Type = DebugType.Request,
        };

        Assert.Equal(
            [received, received with { Direction = DebugDirection.Tx, Duration = TimeSpan.FromMilliseconds(30), Tx = new Text("hi!") }],
            seen.Select((told) =>
            {
                return told.Event;
            }));
    }

    [Fact]
    public async Task A_received_call_starts_as_it_arrives_its_admission_and_its_decoding_count_in_its_duration()
    {
        var time = new FakeTimeProvider(Started);
        var manager = new ServiceManager(new RecordingRouter { Clock = time });
        var seen = RecordDebug(manager);

        // its admission takes 20 ms, and its callback 10 more
        var resolver = manager.GetRequestResolver(Echo, Answered(new BeforeRequest((_) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(20));

            return true;
        })))((request, response) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(10));

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal<(DebugDirection, DateTimeOffset, TimeSpan?)>(
            [(DebugDirection.Rx, Started, null), (DebugDirection.Tx, Started, TimeSpan.FromMilliseconds(30))],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Event.StartedAt, told.Event.Duration);
            }));
    }

    // debugging 4.2, 4.2.4 and 4.3
    [Fact]
    public async Task Tells_a_callback_that_fails_before_it_answers_as_an_answer_that_did_not_go_with_why_beside_it_nothing_more_for_one_that_fails_once_it_answered_nor_for_an_admission_that_fails()
    {
        foreach (var (start, rejectDelay, answerDelay, afterDelay) in new[] { (DateTimeOffset.FromUnixTimeMilliseconds(1_767_225_600_000), 10, 0, 0), (Started, 20, 5, 5) })
        {
            var time = new FakeTimeProvider(start);
            var manager = new ServiceManager(new RecordingRouter { Clock = time });
            var seen = RecordDebug(manager);
            var thrown = new InvalidOperationException("thrown");
            var rejected = new InvalidOperationException("rejected");
            var after = new InvalidOperationException("after");
            var throwing = manager.GetRequestResolver(Echo, Answered())((_, _) =>
            {
                time.Advance(TimeSpan.FromMilliseconds(10));

                throw thrown;
            });
            var rejecting = manager.GetRequestResolver(Echo with { ProcedureId = 2 }, Answered())((_, _) =>
            {
                time.Advance(TimeSpan.FromMilliseconds(rejectDelay));

                return Task.FromException(rejected);
            });
            var refusing = manager.GetRequestResolver(Echo with { ProcedureId = 3 }, Answered(new BeforeRequest((_) =>
            {
                throw thrown;
            })))(Unanswering);
            var answering = manager.GetRequestResolver(Echo with { ProcedureId = 4 }, Answered())(async (_, response) =>
            {
                time.Advance(TimeSpan.FromMilliseconds(answerDelay));
                await response.Answer(new Text("hi"));
                time.Advance(TimeSpan.FromMilliseconds(afterDelay));

                throw after;
            });
            var request = PropsOf(Encode(new Text("hi")));

            foreach (var (resolver, expected) in new[] { (throwing, thrown), (rejecting, rejected), (refusing, thrown), (answering, after) })
            {
                Assert.Same(expected, await Assert.ThrowsAsync<InvalidOperationException>(() =>
                {
                    return resolver.Handle(request).WaitAsync(Patience, Cancelled);
                }));
            }

            // each pair shares its start; the step of no answer carries the request and why, timed
            Assert.Equal<(DebugDirection, ushort, Exception?, object?, object?, DateTimeOffset, TimeSpan?, uint?, string?)>(
                [
                    (DebugDirection.Rx, 1, null, new Text("hi"), null, start, null, 7u, Handle),
                    (DebugDirection.Tx, 1, thrown, new Text("hi"), null, start, TimeSpan.FromMilliseconds(10), 7u, Handle),
                    (DebugDirection.Rx, 2, null, new Text("hi"), null, start.AddMilliseconds(10), null, 7u, Handle),
                    (DebugDirection.Tx, 2, rejected, new Text("hi"), null, start.AddMilliseconds(10), TimeSpan.FromMilliseconds(rejectDelay), 7u, Handle),
                    (DebugDirection.Rx, 4, null, new Text("hi"), null, start.AddMilliseconds(10 + rejectDelay), null, 7u, Handle),
                    (DebugDirection.Tx, 4, null, new Text("hi"), new Text("hi"), start.AddMilliseconds(10 + rejectDelay), TimeSpan.FromMilliseconds(answerDelay), 7u, Handle),
                ],
                seen.Select((told) =>
                {
                    return (told.Event.Direction, told.Event.ProcedureId, told.Error, told.Event.Rx, told.Event.Tx, told.Event.StartedAt, told.Event.Duration, told.Event.CallId, told.Event.ConnectionHandle);
                }));
        }
    }

    // debugging 4.2 and 4.2.4
    [Fact]
    public async Task Tells_an_answer_its_router_cannot_send_again_at_its_start_with_why_beside_it()
    {
        var time = new FakeTimeProvider(Started);
        var router = new RecordingRouter { Clock = time };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var tooLarge = FailureException.OfProtocol(ProtocolCode.PayloadTooLarge, RouterSide.Server);
        Exception? heard = null;

        // the payload answer goes nowhere, 5 ms after it was told; a failure goes out
        router.RespondError = (answer) =>
        {
            if (answer.Failure is not null)
            {
                return null;
            }

            time.Advance(TimeSpan.FromMilliseconds(5));

            return tooLarge;
        };

        var resolver = manager.GetRequestResolver(Echo, Answered())(async (request, response) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(10));
            heard = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return response.Answer(request.Payload);
            });
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Same(tooLarge, heard);
        Assert.Equal<(DebugDirection, Exception?, object?, DateTimeOffset, TimeSpan?)>(
            [
                (DebugDirection.Rx, null, null, Started, null),
                (DebugDirection.Tx, null, new Text("hi"), Started, TimeSpan.FromMilliseconds(10)),
                (DebugDirection.Tx, tooLarge, new Text("hi"), Started, TimeSpan.FromMilliseconds(15)),
            ],
            seen.Select((told) =>
            {
                return (told.Event.Direction, told.Error, told.Event.Tx, told.Event.StartedAt, told.Event.Duration);
            }));
    }

    // debugging 4.2
    [Fact]
    public async Task Tells_nothing_more_than_its_request_for_a_callback_that_fails_on_its_signal_its_call_cancelled_or_gone_with_its_connection()
    {
        var time = new FakeTimeProvider(Started);
        var manager = new ServiceManager(new RecordingRouter { Clock = time });
        var seen = RecordDebug(manager);
        using var source = new CancellationTokenSource();

        // its requester cancels, or its connection goes: either way its router aborts its signal
        var resolver = manager.GetRequestResolver(Echo, Answered())(async (request, _) =>
        {
            await source.CancelAsync();
            request.Signal.ThrowIfCancellationRequested();
        });

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
        {
            return resolver.Handle(PropsOf(Encode(new Text("hi"))) with { Signal = source.Token }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal([(DebugDirection.Rx, DebugType.Request)], StepsOf(seen));
        Assert.Null(Assert.Single(seen).Error);
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

    // debugging 4.3
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
    public void Is_the_resolver_s_to_answer_for_its_router_nothing_admits_a_failure_refuses_a_throw_goes_on()
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
    public async Task Admission_reads_the_call_s_session_its_router_resolved_and_so_does_the_callback_whoever_asks_it()
    {
        var ada = new CallSession { Data = "ada" };
        var bob = new CallSession { Data = "bob" };
        var read = new List<(string Phase, CallSession? Session)>();
        var resolver = new ServiceManager(new RecordingRouter()).GetRequestResolver(Echo, Answered(new BeforeRequest((request) =>
        {
            read.Add(("admission", request.Session));

            return request.Session is not null;
        })))((request, response) =>
        {
            read.Add(("callback", request.Session));

            return response.Answer(request.Payload);
        });

        Assert.Null(resolver.Admit(new AdmissionRequest(Handle, Header) { Session = ada }));
        await resolver.Handle(PropsOf(Encode(new Text("hi"))) with { IsAdmitted = true, Session = ada }).WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("hi"))) with { Session = ada }).WaitAsync(Patience, Cancelled);
        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal(["admission", "callback", "admission", "callback", "admission"], read.Select((entry) =>
        {
            return entry.Phase;
        }));
        Assert.All(read.Take(4), (entry) =>
        {
            Assert.Same(ada, entry.Session);
        });
        Assert.Null(read[4].Session);

        var admitted = new List<CallSession?>();
        var received = new List<CallSession?>();
        var permissive = new ServiceManager(new RecordingRouter()).GetRequestResolver(Echo, Answered(new BeforeRequest((request) =>
        {
            admitted.Add(request.Session);

            return true;
        })))((request, response) =>
        {
            received.Add(request.Session);

            return response.Answer(request.Payload);
        });

        await permissive.Handle(PropsOf(Encode(new Text("hi"))) with { Session = ada }).WaitAsync(Patience, Cancelled);
        await permissive.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);
        await permissive.Handle(PropsOf(Encode(new Text("hi"))) with { IsAdmitted = true, Session = bob }).WaitAsync(Patience, Cancelled);

        Assert.Equal(["ada", null], admitted.Select((session) =>
        {
            return session?.Data;
        }));
        Assert.Equal(["ada", null, "bob"], received.Select((session) =>
        {
            return session?.Data;
        }));
        Assert.Same(ada, admitted[0]);
        Assert.Null(admitted[1]);
        Assert.Same(ada, received[0]);
        Assert.Null(received[1]);
        Assert.Same(bob, received[2]);
    }

    [Fact]
    public async Task Is_not_asked_again_of_a_request_its_router_admitted()
    {
        var router = new RecordingRouter();
        var asked = new List<uint>();
        var handed = new List<string[]>();
        var resolver = new ServiceManager(router).GetRequestResolver(Echo, Answered(new BeforeRequest((request) =>
        {
            asked.Add(request.Header.CallId);

            return false;
        })))((request, response) =>
        {
            handed.Add([.. request.GetType().GetProperties().Select((property) =>
            {
                return property.Name;
            })]);

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi"))) with { IsAdmitted = true }).WaitAsync(Patience, Cancelled);

        Assert.Empty(asked);
        Assert.Equal(["ConnectionHandle", "Header", "Payload", "Session", "Signal"], Assert.Single(handed));
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
    public void Keeps_its_refusal_SESSION_REQUIRED_whatever_the_call_presented_for_its_router_to_answer()
    {
        BeforeRequest Refusing(Failure? refusal)
        {
            return new BeforeRequest(
                (_) =>
                {
                    return false;
                },
                refusal);
        }

        var plain = Refusing(Failure.OfProtocol(ProtocolCode.SessionRequired));
        var detailed = Refusing(Failure.OfProtocol(ProtocolCode.SessionRequired, "sign in first"));
        var request = new AdmissionRequest(Handle, Header);

        // the router answers a call that presented a credential ACCESS_DENIED, whatever the
        // admission
        foreach (var presenting in new Credential?[] { null, (Credential)SessionToken.FromBytes([.. Enumerable.Repeat((byte)1, SessionToken.Bytes)]), Credential.Jwt("a.b.c"), Credential.Elsewhere() }.Select((credential) =>
        {
            return request with { Header = Header with { Credential = credential } };
        }))
        {
            Assert.Equal(Failure.OfProtocol(ProtocolCode.SessionRequired), plain.RefusalOf(presenting));
            Assert.Equal(Failure.OfProtocol(ProtocolCode.SessionRequired, "sign in first"), detailed.RefusalOf(presenting));

            // ACCESS_DENIED when it gives none
            Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied), Refusing(null).RefusalOf(presenting));
        }
    }

    // spec 13.1
    [Fact]
    public void Hands_before_request_the_connection_the_header_and_the_call_s_session_alone_never_a_bearer_credential_its_call_came_with()
    {
        var handed = new List<AdmissionRequest>();
        var beforeRequest = new BeforeRequest((request) =>
        {
            handed.Add(request);

            return true;
        });
        var session = new CallSession { Data = "ada" };

        Assert.Null(beforeRequest.RefusalOf(new AdmissionRequest(Handle, Header with { Credential = Credential.Jwt("a.b.c") })
        {
            Session = session,
            TransportCredential = "Bearer e",
        }));

        // the connection, the header with its JWT's scheme alone, the session: nothing else
        var request = Assert.Single(handed);

        Assert.Equal(new AdmissionRequest(Handle, Header with { Credential = Credential.SchemeOf(CredentialScheme.Jwt) }) { Session = session }, request);
        Assert.Null(request.Header.Credential?.Token);
        Assert.Null(request.TransportCredential);
    }

    // debugging 4.2; the C# side's alone, whose router answers in its resolver's place on its own
    // thread while the resolver's answer goes to it
    [Fact]
    public async Task Tells_again_at_its_start_the_failure_its_router_answered_in_its_place_as_its_answer_went_to_it()
    {
        var time = new FakeTimeProvider(Started);
        var router = new RecordingRouter { Clock = time };
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var exceeded = Failure.OfProtocol(ProtocolCode.CapacityExceeded, "the notifications queued for call 7 went past their bounds");
        Failure? held = null;

        // its router answers in its place 5 ms after its answer was told, before that answer reaches it
        router.FailureAnswered = (target) =>
        {
            return ReferenceEquals(target.Header, Header) ? held : null;
        };
        router.RespondError = (_) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(5));
            held = exceeded;

            return null;
        };

        var resolver = manager.GetRequestResolver(Echo, Answered())((request, response) =>
        {
            time.Advance(TimeSpan.FromMilliseconds(10));

            return response.Answer(request.Payload);
        });

        await resolver.Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        var told = Assert.IsType<FailureException>(seen[^1].Error);

        Assert.Same(exceeded, told.Failure);
        Assert.Equal((FailureOrigin.Local, (RouterSide?)RouterSide.Server), (told.Origin, told.Side));
        Assert.Equal<IEnvelopeHeader?>(new FailureHeader { CallId = 7 }, told.Header);
        Assert.Equal<(DebugDirection, bool, object?, DateTimeOffset, TimeSpan?)>(
            [
                (DebugDirection.Rx, false, null, Started, null),
                (DebugDirection.Tx, false, new Text("hi"), Started, TimeSpan.FromMilliseconds(10)),
                (DebugDirection.Tx, true, new Text("hi"), Started, TimeSpan.FromMilliseconds(15)),
            ],
            seen.Select((step) =>
            {
                return (step.Event.Direction, step.Error is not null, step.Event.Tx, step.Event.StartedAt, step.Event.Duration);
            }));

        // a failure its own resolver answered is never told again
        held = null;
        router.RespondError = (answer) =>
        {
            held = answer.Failure;

            return null;
        };
        seen.Clear();

        await manager.GetRequestResolver(Echo with { ProcedureId = 2, ProcedureName = "fail" }, Answered())((_, response) =>
        {
            return response.Fail(Failure.OfApplication(7));
        }).Handle(PropsOf(Encode(new Text("hi")))).WaitAsync(Patience, Cancelled);

        Assert.Equal([(DebugDirection.Rx, DebugType.Request), (DebugDirection.Tx, DebugType.Request)], StepsOf(seen));
    }
}
