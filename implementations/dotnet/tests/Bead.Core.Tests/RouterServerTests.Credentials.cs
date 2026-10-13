using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/>'s credentials: an <c>ELSEWHERE</c> resolved by its verifier from what
/// its transport carried (spec 13.11), in a later turn, its cancel and its close told by its
/// signal; a <c>JWT</c> verified against the keys its key set answers (spec 13.9); what a command
/// presents, failed before it goes when its transport cannot carry it (spec 13.4); and what a side
/// that takes a <c>JWT</c> is built with: its audience, and limits that hold its header (spec
/// 12.2).
/// </summary>
public sealed partial class RouterServerTests
{
    // constants

    private const string Carried = "Interop sub=ada";

    private const string Issuer = "https://hs256.example";

    private const string Audience = "bead-interop";

    // an HS256 key of 32 bytes, and its JWK, which names it by the kid "first"
    private static readonly byte[] Secret = [.. Enumerable.Repeat((byte)1, 32)];

    private static readonly JsonElement Jwk = JwkOf("first");

    // helpers

    // the JWK of the key, named by `kid`
    private static JsonElement JwkOf(string kid)
    {
        return JsonSerializer.SerializeToElement(
            new Dictionary<string, string> { ["k"] = Base64Url.EncodeToString(Secret), ["kid"] = kid, ["kty"] = "oct" });
    }

    // an HS256 access token of the issuer for ada, under the key "first" or another kid of it, its
    // exp `exp` seconds since the epoch
    private static string JwtOf(long exp, string kid = "first")
    {
        return SignedOf(new Dictionary<string, object> { ["aud"] = Audience, ["exp"] = exp, ["iss"] = Issuer, ["sub"] = "ada" }, kid);
    }

    // an HS256 access token of an issuer, the issuer when none is given, under the key "first",
    // named by its sid or its sub, its exp the start of 2100
    private static string JwtOf((string Claim, string Value) identity, string issuer = Issuer)
    {
        return SignedOf(new Dictionary<string, object> { ["aud"] = Audience, ["exp"] = 4_102_444_800, ["iss"] = issuer, [identity.Claim] = identity.Value });
    }

    // claims, signed under the key, its kid "first" or the one given
    private static string SignedOf(Dictionary<string, object> claimed, string kid = "first")
    {
        var part = (object value) =>
        {
            return Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(value));
        };
        var header = part(new Dictionary<string, string> { ["alg"] = "HS256", ["kid"] = kid, ["typ"] = "at+jwt" });
        var claims = part(claimed);
        var signature = HMACSHA256.HashData(Secret, Encoding.ASCII.GetBytes($"{header}.{claims}"));

        return $"{header}.{claims}.{Base64Url.EncodeToString(signature)}";
    }

    // a router whose JWTs verify against its key set alone, which answers the key "first" once
    // `answer` settles, counting its asks in `asks`, on the first connection: echo answers its
    // session's sub, counting the calls it ran in `ran`
    private void StartAsking((TaskCompletionSource<IReadOnlyList<JwtSetKey>> Answer, Counts Counts) asking)
    {
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                KeySet = new JwtKeySet
                {
                    Issuers = [Issuer],
                    Ask = (_, _) =>
                    {
                        asking.Counts.Asks += 1;

                        return new ValueTask<IReadOnlyList<JwtSetKey>>(asking.Answer.Task);
                    },
                },
            },
        });
        _transport.Open(First);
        EchoOf((request, response) =>
        {
            asking.Counts.Ran += 1;

            return response.Answer(request.Session?.Identifier?.Sub ?? "none");
        });
    }

    // a token of the key "first" that holds for a minute from the test's wall clock
    private string Holding()
    {
        return JwtOf(_time.GetUtcNow().ToUnixTimeSeconds());
    }

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
    // then answers — a request of `hold` once `_released`, one of `late` subscribing only then — and
    // echo answers its session's id and end
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
            if (request.Payload == "late")
            {
                await _released.Task;
            }

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

    // holds the router's scheduler until `release` is set: what is posted meanwhile runs after, in
    // the order it came
    private void Hold(ManualResetEventSlim release)
    {
        _scheduler.Post(() =>
        {
            release.Wait(Patience);
        });
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
    public async Task Hands_the_filter_one_subscriber_its_connection_and_its_session_s_identifier()
    {
        var seen = new List<Subscriber>();

        StartKeeping();
        Deliver(First, SubscribingOf(1));
        SubscribeElsewhere(First, (3, "ada +5000"));
        await Settle();

        await Router.Notify(BytesOf("to none"), new NotifyRequest
        {
            Procedure = News.Address,
            Filter = (subscriber) =>
            {
                seen.Add(subscriber);

                return false;
            },
        }).WaitAsync(Patience, Cancelled);

        // * its subscriber alone: nothing of the subscription's call reaches a filter
        Assert.Equal(
            [
                new Subscriber { ConnectionHandle = First },
                new Subscriber { ConnectionHandle = First, Identifier = new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "ada" } },
            ],
            seen);
    }

    [Fact]
    public async Task Ends_nothing_in_the_turn_after_its_end_was_reached_for_a_session_forgotten_or_renewed_meanwhile()
    {
        using var renewing = new ManualResetEventSlim();
        using var forgetting = new ManualResetEventSlim();

        StartKeeping();

        // renewed: a call resolved as its end was reached settles before that end is taken, and
        // arms its timer
        SubscribeElsewhere(First, (1, "ada +1000"));
        await Settle();
        Hold(renewing);
        DeliverElsewhere(First, (3, "ada +5000"));
        _time.Advance(TimeSpan.FromMilliseconds(1_000));
        renewing.Set();
        await Settle();
        Assert.Equal(["first result 1 ok", "first result 3 ada 5000"], SentSince());
        await AdvanceBy(4_999);
        Assert.Empty(SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 1 SessionRequired"], SentSince());

        // forgotten: its last subscription cancelled as its end was reached, and a call that
        // resolved before subscribes it anew, with its own end, before that end is taken
        _transport.Carrying(First, (EnvelopeCodec.WriteEnvelope(Presenting(SubscribingOf(5, "late"), Credential.Elsewhere())), "bob +5000"));
        SubscribeElsewhere(First, (7, "bob +1000"));
        await Settle();
        Hold(forgetting);
        _time.Advance(TimeSpan.FromMilliseconds(1_000));
        Deliver(First, CancelOf(7));
        _released.SetResult();
        forgetting.Set();
        await Settle();
        Assert.Equal(["first result 7 ok", "first result 5 ok"], SentSince());
        await AdvanceBy(3_999);
        Assert.Empty(SentSince());
        await AdvanceBy(1);
        Assert.Equal(["first failure 5 SessionRequired"], SentSince());
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
            Assert.Equal(Credential.Elsewhere(), ((RequestHeader)envelope.Header).Credential);
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
            KeySet = new JwtKeySet
            {
                Issuers = ["https://keys.example"],
                Ask = (_, _) =>
                {
                    return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
                },
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

    [Fact]
    public async Task Answers_an_admission_s_SESSION_REQUIRED_to_a_call_that_presented_a_credential_ACCESS_DENIED_and_to_one_that_presented_none_SESSION_REQUIRED()
    {
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }],
                Verify = (_, _) =>
                {
                    return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = "ada" });
                },
            },
            SessionOf = (request, _) =>
            {
                return ValueTask.FromResult(CallSession.ConnectionSessionOf(request.Header.Credential, (Token, "leg A")));
            },
        });
        _transport.Open(First);

        // an admission of the application's own, which refuses every call with SESSION_REQUIRED, its
        // detail its own
        Services.GetRequestResolver(
            Echo,
            new RequestResolverDependencies<string, string>
            {
                Serializer = Text,
                BeforeRequest = new BeforeRequest(
                    (_) =>
                    {
                        return false;
                    },
                    Failure.OfProtocol(ProtocolCode.SessionRequired, "not this one")),
            })((_, response) =>
            {
                return response.Answer("admitted");
            });
        Deliver(First, RequestOf(1));
        Deliver(First, Presenting(RequestOf(3), Token));
        Deliver(First, Presenting(RequestOf(5), Credential.Jwt(Holding())));
        DeliverElsewhere(First, (7, Carried));
        await Settle();

        // each credential held, and its call in a session: the admission's refusal is not the
        // credential's, which its requester keeps
        Assert.Equal(
            ["1 SessionRequired not this one", "3 AccessDenied not this one", "5 AccessDenied not this one", "7 AccessDenied not this one"],
            _transport.Sent
                .Select((entry) =>
                {
                    return $"{entry.Envelope.Header.CallId} {CodeOf(entry.Envelope.Failure!)} {entry.Envelope.Failure!.Detail}";
                })
                .Order(StringComparer.Ordinal));
        Assert.Empty(Reported());
    }

    [Fact]
    public void Refuses_as_it_is_built_keys_or_a_key_set_without_an_audience_whatever_its_relay_does_and_a_key_set_given_no_issuer()
    {
        var keys = new Credentials { Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }] };
        var ask = (string _, CancellationToken _) =>
        {
            return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
        };
        var keySet = new Credentials { KeySet = new JwtKeySet { Issuers = ["https://keys.example"], Ask = ask } };

        foreach (var credentials in new[] { keys, keySet })
        {
            // a relay that verifies holds the audiences of its destinations, but a request to the
            // server itself holds its own
            foreach (var relay in new[] { null, new RelayOptions { Verifies = false }, new RelayOptions { Verifies = true } })
            {
                Assert.Throws<ArgumentException>(() =>
                {
                    Start(new RouterServerOptions { Credentials = credentials, Relay = relay });
                });
            }
        }

        Assert.Throws<ArgumentException>(() =>
        {
            Start(new RouterServerOptions { Credentials = new Credentials { Audience = Audience, KeySet = new JwtKeySet { Issuers = [], Ask = ask } } });
        });

        // an ELSEWHERE's verifier needs none
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Verify = (_, _) =>
                {
                    return ValueTask.FromResult<ElsewhereSession?>(null);
                },
            },
        });
    }

    [Fact]
    public async Task Answers_a_subscribing_call_whose_JWT_s_end_passes_before_its_answer_with_its_RESULT_then_SESSION_REQUIRED_and_its_client_withdraws_nothing()
    {
        var withdrawn = new List<CredentialScheme>();
        var clientEnd = new ClientEnd(_transport);
        var entered = 0;
        var resolved = new TaskCompletionSource();
        var news = new StandingNotification(News);
        var flash = new StandingNotification(Other);

        // its end, E = exp + 60 s, a second past the wall clock as it resolves
        var token = JwtOf(_time.GetUtcNow().ToUnixTimeSeconds() - 59);

        // a resolver entered, on the router's scheduler: once both are, both resolved
        void Enter()
        {
            entered += 1;

            if (entered == 2)
            {
                resolved.SetResult();
            }
        }

        Start(new RouterServerOptions
        {
            Credentials = new Credentials { Audience = Audience, Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }] },
        });
        _transport.Peer = clientEnd;
        _transport.Open(First);

        // ! news subscribes in flight once released past its end, and answers a turn later; flash's
        // answer alone subscribes it
        NotifierOf(async (_, response) =>
        {
            Enter();
            await _released.Task;
            await response.RegisterNotification();
            await Task.Yield();
            await response.Answer("subscribed");
        });
        NotifierOf(
            async (_, response) =>
            {
                Enter();
                await _released.Task;
                await response.Answer("subscribed");
            },
            Other);

        using var client = new RouterClient(
            clientEnd,
            new RouterClientOptions { Credential = Credential.Jwt(token), ResolverScheduler = _scheduler, Scheduler = _scheduler });

        client.CredentialWithdrawn += withdrawn.Add;

        var subscribing = new[] { news, flash }.Select(async (notification) =>
        {
            await client.RegisterNotification(notification);

            var request = new RouterRequest(notification.Procedure, new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5) }) { Subscribes = notification };

            return TextOf((await client.Request(ReadOnlyMemory<byte>.Empty, request)).Payload);
        }).ToList();

        // both resolved before their end, and wait in their resolvers while the wall clock passes it
        await resolved.Task.WaitAsync(Patience, Cancelled);
        await AdvanceBy(1_000);
        _released.SetResult();
        Assert.Equal(["subscribed", "subscribed"], await Task.WhenAll(subscribing).WaitAsync(Patience, Cancelled));
        await Settle();

        // each call's RESULT goes first, its FAILURE behind it, never a FAILURE on a call still owed
        // its answer
        var sent = SentSince();

        foreach (var callId in new[] { 1, 3 })
        {
            Assert.Equal(
                [$"first result {callId} subscribed", $"first failure {callId} SessionRequired"],
                sent.Where((answer) =>
                {
                    return answer.EndsWith($" {callId} subscribed", StringComparison.Ordinal) || answer.EndsWith($" {callId} SessionRequired", StringComparison.Ordinal);
                }));
        }

        Assert.Equal(4, sent.Count);
        Assert.All(new[] { news, flash }, (notification) =>
        {
            Assert.Equal([(ushort?)ProtocolCode.SessionRequired], notification.Dropped.Select((failure) =>
            {
                return failure?.Code;
            }));
        });
        Assert.Empty(withdrawn);
        Assert.Equal(Credential.Jwt(token), client.Credential);
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Answers_nothing_to_a_call_cancelled_while_it_waits_on_its_key_set_whose_ask_goes_on_for_the_others()
    {
        var answer = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();
        var counts = new Counts();

        StartAsking((answer, counts));

        Deliver(First, Presenting(RequestOf(1), Credential.Jwt(Holding())));
        Deliver(First, Presenting(RequestOf(3), Credential.Jwt(Holding())));
        await Settle();
        Deliver(First, CancelOf(1));
        await Settle();
        answer.SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = Jwk }]);
        await Settle();

        Assert.Equal(["first result 3 ada"], SentSince());
        Assert.Equal((1, 1), (counts.Asks, counts.Ran));
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Dispatches_nothing_and_runs_no_resolver_for_a_JWT_call_that_waits_on_its_key_set_as_the_router_is_disposed()
    {
        var answer = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();
        var counts = new Counts();

        StartAsking((answer, counts));

        Deliver(First, Presenting(RequestOf(1), Credential.Jwt(Holding())));
        await Settle();
        Router.Dispose();
        await Settle();
        answer.SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = Jwk }]);
        await Settle();

        Assert.Empty(SentSince());
        Assert.Equal((1, 0), (counts.Asks, counts.Ran));
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Answers_a_JWT_call_past_the_calls_its_key_set_lets_wait_for_an_issuer_s_deadline_CAPACITY_EXCEEDED_reporting_nothing_and_its_client_keeps_its_default()
    {
        var answers = new List<TaskCompletionSource<IReadOnlyList<JwtSetKey>>>();
        var withdrawn = new List<CredentialScheme>();
        var clientEnd = new ClientEnd(_transport);
        var exp = _time.GetUtcNow().ToUnixTimeSeconds() + 3_600;

        // a key set that answers each ask as the test settles it, and lets one call wait for its
        // issuer's deadline
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                KeySet = new JwtKeySet
                {
                    Issuers = [Issuer],
                    Ask = (_, _) =>
                    {
                        var answer = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();

                        answers.Add(answer);

                        return new ValueTask<IReadOnlyList<JwtSetKey>>(answer.Task);
                    },
                    MaximumWaitingCalls = 1,
                },
            },
        });
        _transport.Open(First);
        EchoOf((request, response) =>
        {
            return response.Answer(request.Session?.Identifier?.Sub ?? "none");
        });
        _transport.Peer = clientEnd;

        // the client's default names a kid the key set's first answer does not
        var credential = Credential.Jwt(JwtOf(exp, "second"));
        var echo = new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromMinutes(2) });

        using var client = new RouterClient(clientEnd, new RouterClientOptions { Credential = credential, ResolverScheduler = _scheduler, Scheduler = _scheduler });

        client.CredentialWithdrawn += withdrawn.Add;

        // the key set's keys held, by a call presenting a kid its answer names
        var holding = client.Request(
            BytesOf("held"),
            new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5), Credential = Credential.Jwt(JwtOf(exp)) }));

        await Settle();
        answers[0].SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = Jwk }]);
        Assert.Equal("ada", TextOf((await holding.WaitAsync(Patience, Cancelled)).Payload));

        // within the minute, one waits for the deadline, the other is past the bound
        var waiting = client.Request(BytesOf("first"), echo);

        await Settle();

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Request(BytesOf("second"), echo).WaitAsync(Patience, Cancelled);
        });

        // nothing failed, and nothing is withdrawn
        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, FailureScope.Protocol), (refused.Code, refused.Scope));
        Assert.Empty(withdrawn);
        Assert.Equal(credential, client.Credential);
        Assert.Single(answers);

        // at the deadline, the ask then names its kid
        _time.Advance(TimeSpan.FromMinutes(1));
        await Settle();
        Assert.Equal(2, answers.Count);
        answers[1].SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = Jwk }, new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf("second") }]);
        Assert.Equal("ada", TextOf((await waiting.WaitAsync(Patience, Cancelled)).Payload));
        Assert.Empty(withdrawn);
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Answers_SESSION_REQUIRED_from_the_admission_of_a_resolver_registered_on_it_ACCESS_DENIED_to_a_call_that_presented_a_JWT_that_holds_whose_client_keeps_its_default_and_SESSION_REQUIRED_to_one_that_presented_none()
    {
        var withdrawn = new List<CredentialScheme>();
        var clientEnd = new ClientEnd(_transport);
        var credential = Credential.Jwt(Holding());

        Start(new RouterServerOptions
        {
            Credentials = new Credentials { Audience = Audience, Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }] },
        });
        _transport.Open(First);

        // ! no service manager between: the router asks the resolver's admission itself
        Router.RegisterResolver(
            new RawResolver(Echo, (_) =>
            {
                return Task.CompletedTask;
            })
            {
                Refusal = Failure.OfProtocol(ProtocolCode.SessionRequired, "short of its scope"),
            });
        Deliver(First, RequestOf(1));
        await Settle();
        Assert.Equal(["first failure 1 SessionRequired"], SentSince());

        _transport.Peer = clientEnd;

        using var client = new RouterClient(clientEnd, new RouterClientOptions { Credential = credential, ResolverScheduler = _scheduler, Scheduler = _scheduler });

        client.CredentialWithdrawn += withdrawn.Add;

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Request(BytesOf("hi"), new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5) }))
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.AccessDenied, "short of its scope"), (refused.Code, refused.Detail));
        Assert.Empty(withdrawn);
        Assert.Equal(credential, client.Credential);
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Ends_every_credential_s_session_of_an_issuer_by_that_issuer_on_every_connection_its_sid_s_and_its_sub_s_alike_and_nothing_of_another_issuer_s_nor_an_ELSEWHERE_s_whose_id_is_that_issuer_an_issuer_none_names_ends_nothing()
    {
        const string OtherIssuer = "https://other.example";

        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                Keys =
                [
                    new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk },
                    new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = OtherIssuer, Jwk = Jwk },
                ],
                Verify = (carried, _) =>
                {
                    return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = carried });
                },
            },
        });
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("ok");
        });

        // the issuer's by its sid and by its sub, on two connections; another issuer's; an
        // ELSEWHERE's whose id is the issuer's very string
        Deliver(First, Presenting(SubscribingOf(1), Credential.Jwt(JwtOf(("sid", "s-1")))));
        Deliver(First, Presenting(SubscribingOf(3), Credential.Jwt(JwtOf(("sub", "ada")))));
        Deliver(First, Presenting(SubscribingOf(5), Credential.Jwt(JwtOf(("sub", "ada"), OtherIssuer))));
        SubscribeElsewhere(First, (7, Issuer));
        Deliver(Second, Presenting(SubscribingOf(1), Credential.Jwt(JwtOf(("sub", "bob")))));
        await Settle();
        Assert.Equal(5, SentSince().Count);

        await Router.EndSessionsOf(Issuer).WaitAsync(Patience, Cancelled);
        await Settle();
        Assert.Equal(
            ["first failure 1 SessionRequired", "first failure 3 SessionRequired", "second failure 1 SessionRequired"],
            SentSince().Order(StringComparer.Ordinal));
        Assert.Equal(["first 5", "first 7"], await SubscribedTo(News));

        // again, and for an issuer none names — another case of its string among them — nothing
        await Router.EndSessionsOf(Issuer).WaitAsync(Patience, Cancelled);
        await Router.EndSessionsOf("https://none.example").WaitAsync(Patience, Cancelled);
        await Router.EndSessionsOf(Issuer.ToUpperInvariant()).WaitAsync(Patience, Cancelled);
        await Settle();
        Assert.Empty(SentSince());

        // ending refuses no credential: one that still holds opens its session anew
        Deliver(First, Presenting(SubscribingOf(9), Credential.Jwt(JwtOf(("sid", "s-1")))));
        await Settle();
        Assert.Equal(["first result 9 ok"], SentSince());
        Assert.Equal(["first 5", "first 7", "first 9"], await SubscribedTo(News));
        Assert.Empty(Reported());
    }

    [Fact]
    public async Task Refuses_endSessionsOf_an_issuer_that_is_no_string_ending_nothing()
    {
        Start(new RouterServerOptions
        {
            Credentials = new Credentials { Audience = Audience, Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }] },
        });
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("ok");
        });
        Deliver(First, Presenting(SubscribingOf(1), Credential.Jwt(JwtOf(("sub", "ada")))));
        await Settle();
        Assert.Equal(["first result 1 ok"], SentSince());

        // ! thrown as it is called, as EndSession's null is: the type takes no other that is no string
        Assert.Throws<ArgumentNullException>(() =>
        {
            _ = Router.EndSessionsOf(null!);
        });
        await Settle();
        Assert.Empty(SentSince());
        Assert.Equal(["first 1"], await SubscribedTo(News));
        Assert.Empty(Reported());
    }

    // what a key set and a resolver were asked
    private sealed class Counts
    {
        public int Asks { get; set; }

        public int Ran { get; set; }
    }
}
