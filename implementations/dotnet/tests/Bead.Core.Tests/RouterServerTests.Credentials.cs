namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/>'s credentials: an <c>ELSEWHERE</c> resolved by its verifier from what
/// its transport carried (spec 13.10), in a later turn, its cancel and its close told by its signal;
/// what a command presents, failed before it goes when its transport cannot carry it (spec 13.4);
/// and the limits a side that takes a <c>JWT</c> holds (spec 12.2).
/// </summary>
public sealed partial class RouterServerTests
{
    // constants

    private const string Carried = "Interop sub=ada";

    // helpers

    // a router whose ELSEWHERE verifier is `verify`, on the first connection, its echo answering in
    // the session its call resolved to, by the id it carries
    private void StartVerifying(Func<string, CancellationToken, ValueTask<ElsewhereSession?>> verify)
    {
        Start(new RouterServerOptions { Credentials = new Credentials { Verify = verify } });
        _transport.Open(First);
        EchoOf((request, response) =>
        {
            return response.Answer(request.Session?.Identifier?.Id ?? "none");
        });
    }

    // a request of echo on `callId` presenting ELSEWHERE, with what its transport carried
    private void DeliverElsewhere(string connectionHandle, (uint CallId, string Carried) request)
    {
        _transport.Carrying(connectionHandle, (EnvelopeCodec.WriteEnvelope(Presenting(RequestOf(request.CallId), Credential.Elsewhere())), request.Carried));
    }

    // a router whose ELSEWHERE verifier holds a value "id +n" as the session of that id, its end n
    // milliseconds past the wall clock as it verifies, on the first connection: news subscribes,
    // then answers — a request of `hold` once `_released` — and echo answers its session's id and end
    private void StartKeeping()
    {
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Verify = (carried, _) =>
                {
                    var (id, after) = (carried.Split(' ')[0], long.Parse(carried.Split('+')[1], System.Globalization.CultureInfo.InvariantCulture));

                    return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = id, End = _time.GetUtcNow().ToUnixTimeMilliseconds() + after });
                },
            },
        });
        _transport.Open(First);
        NotifierOf(async (request, response) =>
        {
            await response.RegisterNotification();

            if (request.Payload == "hold")
            {
                await _released.Task;
            }

            await response.Answer("ok");
        });
        EchoOf((request, response) =>
        {
            return response.Answer($"{request.Session?.Identifier?.Id} {request.Session?.End - _time.GetUtcNow().ToUnixTimeMilliseconds()}");
        });
    }

    // a request that opens a subscription to news, presenting ELSEWHERE with what its transport carried
    private void SubscribeElsewhere(string connectionHandle, (uint CallId, string Carried) request)
    {
        _transport.Carrying(connectionHandle, (EnvelopeCodec.WriteEnvelope(Presenting(SubscribingOf(request.CallId), Credential.Elsewhere())), request.Carried));
    }

    private async Task AdvanceBy(long milliseconds)
    {
        _time.Advance(TimeSpan.FromMilliseconds(milliseconds));
        await Settle();
    }

    // definition

    [Fact]
    public async Task Keeps_a_credential_s_session_from_its_first_subscription_on_a_connection_to_its_last_timing_its_end_meanwhile_its_connection_s_session_it_never_keeps()
    {
        StartKeeping();

        SubscribeElsewhere(First, (1, "ada +1000"));
        await Settle();
        Deliver(First, SubscribingOf(3));
        await Settle();
        Assert.Equal(["first result 1 ok", "first result 3 ok"], SentSince());

        // its last subscription gone, it is kept no more, nor timed
        Deliver(First, CancelOf(1));
        await AdvanceBy(1_000);
        Assert.Empty(SentSince());

        // kept anew, it ends at its end, its connection's own subscription staying
        SubscribeElsewhere(First, (5, "ada +2000"));
        await Settle();
        await AdvanceBy(1_999);
        Assert.Equal(["first result 5 ok"], SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 5 SessionRequired"], SentSince());
        Assert.Equal(["first 3"], await SubscribedTo(News));
    }

    [Fact]
    public async Task Times_an_end_past_a_timer_s_ceiling_in_steps_the_wall_clock_read_again_at_each_due_and_ends_it_at_once_once_reached_no_timer_armed()
    {
        StartKeeping();

        SubscribeElsewhere(First, (1, "ada +2147484647"));
        await Settle();
        Assert.Equal(["first result 1 ok"], SentSince());
        await AdvanceBy(2_147_483_647);
        await AdvanceBy(999);
        Assert.Empty(SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 1 SessionRequired"], SentSince());

        // reached while the call that subscribed it was in flight: kept as its answer goes, it ends
        // then, behind that answer
        SubscribeElsewhere(First, (3, "bob +1000"));
        _transport.Carrying(First, (EnvelopeCodec.WriteEnvelope(Presenting(SubscribingOf(5, "hold"), Credential.Elsewhere())), "cyd +1000"));
        await Settle();
        await AdvanceBy(1_000);
        Assert.Equal(["first result 3 ok", "first failure 3 SessionRequired"], SentSince());
        _released.SetResult();
        await Settle();
        Assert.Equal(["first result 5 ok", "first failure 5 SessionRequired"], SentSince());
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Moves_a_kept_session_s_end_to_the_later_of_the_two_in_whatever_order_calls_resolve_its_timer_armed_anew_a_call_runs_with_the_end_kept()
    {
        StartKeeping();

        SubscribeElsewhere(First, (1, "ada +1000"));
        await Settle();
        DeliverElsewhere(First, (3, "ada +5000"));
        await Settle();
        DeliverElsewhere(First, (5, "ada +2000"));
        await Settle();

        // the later end, whichever came first, and the call that brought an earlier one runs with it
        Assert.Equal(["first result 1 ok", "first result 3 ada 5000", "first result 5 ada 5000"], SentSince());
        await AdvanceBy(1_000);
        await AdvanceBy(3_999);
        Assert.Empty(SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 1 SessionRequired"], SentSince());

        // a session not kept runs with its own end
        DeliverElsewhere(First, (7, "ada +3000"));
        await Settle();
        Assert.Equal(["first result 7 ada 3000"], SentSince());
    }

    [Fact]
    public async Task Moves_the_end_of_a_session_kept_by_a_call_whose_credential_renews_it_and_by_none_that_settles_once_its_call_ended()
    {
        var late = new TaskCompletionSource<ElsewhereSession?>();

        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Verify = (carried, _) =>
                {
                    var after = long.Parse(carried.Split('+')[1], System.Globalization.CultureInfo.InvariantCulture);
                    var session = new ElsewhereSession { Id = "ada", End = _time.GetUtcNow().ToUnixTimeMilliseconds() + after };

                    return carried.StartsWith("late", StringComparison.Ordinal) ? new ValueTask<ElsewhereSession?>(late.Task) : ValueTask.FromResult<ElsewhereSession?>(session);
                },
            },
        });
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("ok");
        });
        EchoOf((_, response) =>
        {
            return response.Answer("ok");
        });

        SubscribeElsewhere(First, (1, "ada +1000"));
        await Settle();

        // a call that ended as its credential resolved moves nothing, whatever it settles to
        DeliverElsewhere(First, (3, "late +9000"));
        await Settle();
        Deliver(First, CancelOf(3));
        await Settle();
        late.SetResult(new ElsewhereSession { Id = "ada", End = _time.GetUtcNow().ToUnixTimeMilliseconds() + 9_000 });

        // one that renews it moves its end
        DeliverElsewhere(First, (5, "ada +2000"));
        await Settle();
        Assert.Equal(["first result 1 ok", "first result 5 ok"], SentSince());
        await AdvanceBy(1_999);
        Assert.Empty(SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 1 SessionRequired"], SentSince());
    }

    [Fact]
    public async Task Ends_a_session_by_its_identifier_on_every_connection_that_keeps_it_and_forgets_those_of_a_connection_that_closes()
    {
        StartKeeping();
        _transport.Open(Second);
        _transport.Open(Third);

        SubscribeElsewhere(First, (1, "ada +1000"));
        SubscribeElsewhere(Second, (1, "ada +1000"));
        SubscribeElsewhere(Third, (1, "ada +1000"));
        SubscribeElsewhere(First, (3, "bob +1000"));
        await Settle();
        _transport.Closed(Third);
        await Settle();
        SentSince();

        await Router.EndSession(new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "ada" }).WaitAsync(Patience, Cancelled);
        await Settle();
        Assert.Equal(["first failure 1 SessionRequired", "second failure 1 SessionRequired"], SentSince().Order(StringComparer.Ordinal));

        // an identifier none keeps ends nothing; what was kept ends no more at its end
        await Router.EndSession(new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "cyd" }).WaitAsync(Patience, Cancelled);
        await AdvanceBy(1_000);
        Assert.Equal(["first failure 3 SessionRequired"], SentSince());
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Asks_verify_once_per_request_with_exactly_what_its_transport_carried_and_a_live_signal_never_for_none_OPAQUE_or_an_ELSEWHERE_that_carried_nothing()
    {
        var asked = new List<(string Carried, bool IsLive)>();

        StartVerifying((carried, signal) =>
        {
            asked.Add((carried, signal.CanBeCanceled && !signal.IsCancellationRequested));

            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = "ada" });
        });

        DeliverElsewhere(First, (1, " Interop  sub=ada "));
        await Settle();

        // what a request presenting none, OPAQUE or a JWT carried stands for nothing
        _transport.Carrying(First, (EnvelopeCodec.WriteEnvelope(RequestOf(3)), Carried));
        _transport.Carrying(First, (EnvelopeCodec.WriteEnvelope(Presenting(RequestOf(5), Token)), Carried));
        _transport.Carrying(First, (EnvelopeCodec.WriteEnvelope(Presenting(RequestOf(7), Credential.Jwt("a.b.c"))), Carried));
        Deliver(First, Presenting(RequestOf(9), Credential.Elsewhere()));
        await Settle();

        // a refusal and a resolver's answer, in one turn, come in no order of their own
        Assert.Equal([(" Interop  sub=ada ", true)], asked);
        Assert.Equal(
            ["first failure 5 SessionRequired", "first failure 7 CredentialUnsupported", "first failure 9 SessionRequired", "first result 1 ada", "first result 3 none"],
            SentSince().Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Resolves_an_ELSEWHERE_whose_verifier_settles_at_once_in_a_later_turn_answering_a_request_presenting_none_delivered_behind_it_first()
    {
        StartVerifying((_, _) =>
        {
            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = "ada" });
        });

        // in one turn: the router takes both before either is answered
        DeliverElsewhere(First, (1, Carried));
        Deliver(First, RequestOf(3));
        await Settle();

        Assert.Equal(["first result 3 none", "first result 1 ada"], SentSince());
    }

    [Fact]
    public async Task A_cancel_and_a_close_during_resolution_abort_the_signal_and_what_the_verifier_settles_to_after_is_dropped_in_silence()
    {
        var pending = new List<(TaskCompletionSource<ElsewhereSession?> Settling, CancellationToken Signal)>();

        StartVerifying((_, signal) =>
        {
            var settling = new TaskCompletionSource<ElsewhereSession?>();

            pending.Add((settling, signal));

            return new ValueTask<ElsewhereSession?>(settling.Task);
        });
        _transport.Open(Second);

        DeliverElsewhere(First, (1, Carried));
        DeliverElsewhere(Second, (1, Carried));
        await Settle();
        Deliver(First, CancelOf(1));
        _transport.Closed(Second);
        await Settle();

        Assert.All(pending, (call) =>
        {
            Assert.True(call.Signal.IsCancellationRequested);
        });

        // its call id free at once, for a request that opens a new call
        Deliver(First, RequestOf(1));
        await Settle();
        Assert.Equal(["first result 1 none"], SentSince());

        // a session, and a failure, settled once their calls ended: no answer, no report
        pending[0].Settling.SetResult(new ElsewhereSession { Id = "ada" });
        pending[1].Settling.SetException(new InvalidOperationException("this verifier fails, on purpose"));
        await Settle();
        Assert.Empty(SentSince());
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Answers_a_verifier_that_throws_at_once_PROCEDURE_FAILED_and_reports_it_as_one_that_rejects_never_SESSION_REQUIRED()
    {
        var calls = 0;

        StartVerifying((_, _) =>
        {
            calls += 1;

            return calls == 1
                ? throw new InvalidOperationException("thrown")
                : ValueTask.FromException<ElsewhereSession?>(new InvalidOperationException("rejected"));
        });

        DeliverElsewhere(First, (1, Carried));
        await Settle();
        DeliverElsewhere(First, (3, Carried));
        await Settle();

        Assert.Equal(["first failure 1 ProcedureFailed", "first failure 3 ProcedureFailed"], SentSince());
        Assert.Equal(["thrown first", "rejected first"], Reported());
    }

    [Fact]
    public async Task Reports_and_traces_no_carried_value_of_an_ELSEWHERE_only_its_scheme()
    {
        var traced = new List<TracedEnvelope>();
        const string Secret = "Bearer s3cr3t";

        StartVerifying((carried, _) =>
        {
            return carried == Secret
                ? ValueTask.FromException<ElsewhereSession?>(new InvalidOperationException("this verifier fails, on purpose"))
                : ValueTask.FromResult<ElsewhereSession?>(null);
        });
        Router.Debug += (_, envelope) =>
        {
            traced.Add(envelope);
        };

        DeliverElsewhere(First, (1, Secret));
        DeliverElsewhere(First, (3, $"{Secret}!"));
        Deliver(First, Presenting(RequestOf(5), Credential.Elsewhere()));
        await Settle();

        var told = string.Join(
            "\n",
            _errors.Select((error) =>
            {
                return error.Reason.ToString();
            }).Concat(_transport.Sent.Select((entry) =>
            {
                return entry.Envelope.Failure?.Detail ?? "";
            })).Concat(traced.Select((envelope) =>
            {
                return envelope.ToString();
            })));

        Assert.Equal(["first failure 1 ProcedureFailed", "first failure 3 SessionRequired", "first failure 5 SessionRequired"], SentSince());
        Assert.DoesNotContain(Secret, told, StringComparison.Ordinal);
        Assert.All(traced.Where((envelope) =>
        {
            return envelope.Header is RequestHeader;
        }), (envelope) =>
        {
            Assert.Equal(CredentialScheme.Elsewhere, envelope.CredentialScheme);
        });
    }

    [Fact]
    public async Task Fails_a_command_presenting_ELSEWHERE_over_a_transport_that_carries_none_and_a_JWT_command_over_one_not_secure_before_they_go_DESTINATION_UNREACHABLE()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);
        _transport.Uncarrying.Add(First);
        _transport.InTheClear.Add(Second);

        async Task<FailureException> Refused((string ConnectionHandle, Credential Credential) command)
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                var request = CommandOf(command.ConnectionHandle);

                return Router.Request(BytesOf("hi"), request with { Options = request.Options with { Credential = command.Credential } })
                    .WaitAsync(Patience, Cancelled);
            });
        }

        var refusals = new[]
        {
            await Refused((First, Credential.Elsewhere(Carried))),
            await Refused((Second, Credential.Jwt("a.b.c"))),
            await Refused((Second, Credential.Elsewhere(Carried))),
        };

        Assert.All(refusals, (refused) =>
        {
            Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local), (refused.Code, refused.Origin));
        });

        // a JWT goes over a transport that carries none, and an ELSEWHERE over one that carries it,
        // beside its envelope
        var jwt = CommandOf(First);
        var elsewhere = CommandOf(Third);

        _transport.Open(Third);
        _ = Router.Request(BytesOf("hi"), jwt with { Options = jwt.Options with { Credential = Credential.Jwt("a.b.c") } });
        _ = Router.Request(BytesOf("ho"), elsewhere with { Options = elsewhere.Options with { Credential = Credential.Elsewhere(Carried) } });
        await Settle();

        Assert.Equal(["first request 2 hi", "third request 4 ho"], SentSince());
        Assert.Equal([null, Carried], _transport.Carried);
        Assert.Empty(Reported());
    }

    [Fact]
    public void Refuses_as_it_is_built_limits_that_hold_no_header_of_1020_bytes_once_it_takes_a_JWT()
    {
        var small = RouterLimits.Default with { ChunkBytes = 512, MaximumEnvelopeBytes = 1_024 };
        var keys = new Credentials
        {
            Audience = "bead-interop",
            KeySet = (_) =>
            {
                return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
            },
        };

        Assert.Throws<ArgumentException>(() =>
        {
            Start(new RouterServerOptions { Credentials = keys, Limits = small });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            Start(new RouterServerOptions { Credentials = keys, Limits = small with { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_023 } });
        });

        // one that takes no JWT holds them
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Verify = (_, _) =>
                {
                    return ValueTask.FromResult<ElsewhereSession?>(null);
                },
            },
            Limits = small,
        });
        Assert.Equal(512, Router.Limits.ChunkBytes);
    }
}
