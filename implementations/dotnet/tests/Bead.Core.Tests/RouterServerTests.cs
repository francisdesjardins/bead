using System.Globalization;
using System.Text;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/>, over a scripted transport of several connections, on one scheduler a
/// test waits on: what a connection asks and the server answers, its commands, its notifications
/// and the places its subscriptions hold, as the TypeScript side's router-server tests show them.
/// This side keeps its subscriptions to itself, where the TypeScript side lists them: a test sees
/// one by the notification that reaches it. What <c>spec/conversations.json</c> pins,
/// <see cref="ConversationsTests"/> plays.
/// </summary>
public sealed partial class RouterServerTests : IDisposable
{
    // constants

    private const string First = "type=WS;ip=127.0.0.1;port=50001";
    private const string Second = "type=WS;ip=127.0.0.1;port=50002";
    private const string Third = "type=WS;ip=127.0.0.1;port=50003";

    // what a test notifies to see who is subscribed
    private const string Probe = "probe";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly SessionToken Token = SessionToken.FromBytes(Enumerable.Repeat((byte)7, SessionToken.Bytes).ToArray());

    private static readonly SessionToken OtherToken = SessionToken.FromBytes(Enumerable.Repeat((byte)8, SessionToken.Bytes).ToArray());

    private static readonly Procedure Echo = new() { ServiceId = 2, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 3 };

    private static readonly Procedure News = new() { ServiceId = 2, ProcedureId = 5, ProcedureName = "news", ServiceRevision = 3 };

    private static readonly Procedure UnsubscribeProcedure = new() { ServiceId = 2, ProcedureId = 6, ProcedureName = "unsubscribe", ServiceRevision = 3 };

    private static readonly Procedure Other = new() { ServiceId = 2, ProcedureId = 7, ProcedureName = "other", ServiceRevision = 3 };

    private static readonly TextPayloads Text = new();

    private readonly SerialScheduler _scheduler = new();
    private readonly FakeTimeProvider _time = new();
    private readonly ScriptedTransport _transport = new();
    private readonly TaskCompletionSource _released = new();
    private readonly List<(Exception Reason, string ConnectionHandle)> _errors = [];
    private readonly List<string> _activity = [];
    private RouterServer? _router;
    private ServiceManager? _services;

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private RouterServer Router
    {
        get
        {
            return _router!;
        }
    }

    private ServiceManager Services
    {
        get
        {
            return _services!;
        }
    }

    // a router on the test's scheduler, over a transport on the test's clock — or the clock its
    // options give — its errors and its activity recorded
    private void Start(RouterServerOptions? options = null)
    {
        _transport.Clock = options?.Clock ?? _time;
        _router = new RouterServer(
            _transport,
            (options ?? new RouterServerOptions()) with { ResolverScheduler = _scheduler, Scheduler = _scheduler });
        _services = new ServiceManager(_router);
        _router.Error += (reason, connectionHandle) =>
        {
            _errors.Add((reason, connectionHandle));
        };
        _router.Activity += (activity, connectionHandle) =>
        {
            _activity.Add($"{activity} {NameOf(connectionHandle)}");
        };
    }

    private async Task Settle()
    {
        for (var round = 0; round < 3; round += 1)
        {
            await _scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        }
    }

    private static string NameOf(string connectionHandle)
    {
        return connectionHandle switch
        {
            First => "first",
            Second => "second",
            Third => "third",
            _ => connectionHandle,
        };
    }

    // a failure's code: a protocol failure's name, an application failure's number
    private static string CodeOf(Failure failure)
    {
        return failure.Scope == FailureScope.Protocol
            ? ((ProtocolCode)failure.Code).ToString()
            : failure.Code.ToString(CultureInfo.InvariantCulture);
    }

    private static string TextOf(ReadOnlyMemory<byte> payload)
    {
        return Encoding.UTF8.GetString(payload.Span);
    }

    private static ReadOnlyMemory<byte> BytesOf(string text)
    {
        return Encoding.UTF8.GetBytes(text);
    }

    private void Deliver(string connectionHandle, Envelope envelope)
    {
        _transport.Deliver(connectionHandle, EnvelopeCodec.WriteEnvelope(envelope));
    }

    private static Envelope RequestOf(uint callId, Procedure? procedure = null, string payload = "")
    {
        var called = procedure ?? Echo;

        return new Envelope
        {
            Header = new RequestHeader { CallId = callId, ServiceId = called.ServiceId, ProcedureId = called.ProcedureId },
            Payload = BytesOf(payload),
        };
    }

    // a request that opens a subscription to `procedure`, news when none
    private static Envelope SubscribingOf(uint callId, string payload = "", Procedure? procedure = null)
    {
        var called = procedure ?? News;

        return new Envelope
        {
            Header = new RequestHeader
            {
                CallId = callId,
                ServiceId = called.ServiceId,
                ProcedureId = called.ProcedureId,
                OpensSubscription = true,
            },
            Payload = BytesOf(payload),
        };
    }

    // a request that opens a subscription to news, paced
    private static Envelope PacedOf(uint callId, string payload = "")
    {
        return new Envelope
        {
            Header = new RequestHeader
            {
                CallId = callId,
                ServiceId = News.ServiceId,
                ProcedureId = News.ProcedureId,
                OpensSubscription = true,
                Paced = true,
            },
            Payload = BytesOf(payload),
        };
    }

    // a credit of the notifications of the subscription `callId`, up to `creditEnd`
    private static Envelope PacedCreditOf(uint callId, long creditEnd)
    {
        return new Envelope { Header = new CreditHeader { CallId = callId, CreditEnd = creditEnd, Paced = true } };
    }

    private static Envelope CancelOf(uint callId)
    {
        return new Envelope { Header = new CancelHeader { CallId = callId } };
    }

    private static Envelope ResultOf(uint callId, string payload = "")
    {
        return new Envelope { Header = new ResultHeader { CallId = callId }, Payload = BytesOf(payload) };
    }

    // a command of the server's to `connectionHandle`, of echo
    private static RouterRequest CommandOf(string connectionHandle, TimeSpan? timeout = null)
    {
        return new RouterRequest(
            Echo,
            new ResolvedRequestOptions { ConnectionHandle = connectionHandle, Timeout = timeout ?? TimeSpan.FromSeconds(1) });
    }

    private IRequestResolver EchoOf(RequestResolverCallback<string, string> callback)
    {
        return Services.GetRequestResolver(Echo, new RequestResolverDependencies<string, string> { Serializer = Text })(callback);
    }

    // the resolver of a notification's procedure, news when none
    private INotificationResolver<string> NotifierOf(NotificationResolverCallback<string, string> callback, Procedure? procedure = null)
    {
        return Services.GetNotificationResolver(
            procedure ?? News,
            new NotificationResolverDependencies<string, string, string> { Serializer = Text })(callback);
    }

    // a router whose news resolver subscribes first, then answers at once, but for a request of
    // `hold`, which waits for `_released`, then fails or answers as `outcome` says; on the first
    // connection, the call that holds the place, then one answered meanwhile, which waits for it
    private INotificationResolver<string> StartHolding(Outcome outcome)
    {
        Start();
        _transport.Open(First);

        var news = NotifierOf(async (request, response) =>
        {
            await response.RegisterNotification();

            if (request.Payload != "hold")
            {
                await response.Answer("ok");

                return;
            }

            await _released.Task;
            await (outcome == Outcome.Fail ? response.Fail(Failure.OfApplication(1)) : response.Answer("held"));
        });

        Deliver(First, SubscribingOf(1, "hold"));
        Deliver(First, SubscribingOf(3, "subscribe"));

        return news;
    }

    // a router on two connections whose news resolver subscribes first, then answers, a request of
    // `hold` once `_released`
    private INotificationResolver<string> StartPaced(PacingLimits? pacing = null)
    {
        Start(new RouterServerOptions { Pacing = pacing });
        _transport.Open(First);
        _transport.Open(Second);

        return NotifierOf(async (request, response) =>
        {
            await response.RegisterNotification();

            if (request.Payload == "hold")
            {
                await _released.Task;
            }

            await response.Answer("ok");
        });
    }

    // what was sent since the last call: the connection, the kind, the call id, and a failure's
    // code or a payload's text
    private List<string> SentSince()
    {
        var sent = _transport.Sent.Select((entry) =>
        {
            var (connectionHandle, envelope) = entry;
            var name = NameOf(connectionHandle);
            var callId = envelope.Header.CallId;

            return envelope switch
            {
                { Failure: { } failure } => $"{name} failure {callId} {CodeOf(failure)}",
                { Header: ResultHeader } => $"{name} result {callId} {TextOf(envelope.Payload)}",
                { Header: NotificationHeader } => $"{name} notification {callId} {TextOf(envelope.Payload)}",
                { Header: RequestHeader } => $"{name} request {callId} {TextOf(envelope.Payload)}",
                _ => $"{name} {envelope.Kind.ToString().ToLowerInvariant()} {callId}",
            };
        }).ToList();

        _transport.Sent.Clear();

        return sent;
    }

    // each error reported: a failure's code or the message, and the connection
    private List<string> Reported()
    {
        return [.. _errors.Select((error) =>
        {
            var (reason, connectionHandle) = error;
            var what = reason is FailureException failure ? CodeOf(failure.Failure) : reason.Message;

            return $"{what} {NameOf(connectionHandle)}";
        })];
    }

    // the subscriptions to `procedure`, as the connection and call id a notification reaches; a
    // paced subscription out of credit queues it, and is not seen
    private async Task<List<string>> SubscribedTo(Procedure procedure)
    {
        await Settle();

        var mark = _transport.Sent.Count;

        await Router.Notify(BytesOf(Probe), new NotifyRequest(procedure.Address, null, null)).WaitAsync(Patience, Cancelled);
        await Settle();

        var reached = _transport.Sent.Skip(mark).Select((entry) =>
        {
            Assert.Equal(Probe, TextOf(entry.Envelope.Payload));

            return $"{NameOf(entry.ConnectionHandle)} {entry.Envelope.Header.CallId}";
        }).Order(StringComparer.Ordinal).ToList();

        _transport.Sent.RemoveRange(mark, _transport.Sent.Count - mark);

        return reached;
    }

    // definition

    public void Dispose()
    {
        _router?.Dispose();
    }

    [Fact]
    public void Runs_on_its_transport_s_clock_and_refuses_another()
    {
        Start();

        using var same = new RouterServer(_transport, new RouterServerOptions { Clock = _time });

        Assert.Equal((_time, _time), (Router.Clock, same.Clock));
        Assert.Equal(
            "a server's router runs on the clock of its transport, a FakeTimeProvider, and was given another, the system's",
            Assert.Throws<ArgumentException>(() =>
            {
                return new RouterServer(_transport, new RouterServerOptions { Clock = TimeProvider.System });
            }).Message);
    }

    [Fact]
    public async Task Requests_that_fail_in_their_resolver_or_do_not_read_are_reported_with_their_connection()
    {
        var gone = new IOException("gone");

        Start();
        Router.RegisterResolver(new RawResolver(Echo, (_) =>
        {
            return Task.FromException(new InvalidOperationException("rejected"));
        }));
        Router.RegisterResolver(new RawResolver(News, (_) =>
        {
            throw new InvalidOperationException("thrown");
        }));

        // one at a time: the TypeScript side's order is its event loop's
        Deliver(First, RequestOf(1));
        await Settle();
        Deliver(Second, SubscribingOf(1));
        await Settle();
        _transport.DeliverText(First, "text");
        await Settle();

        // a refusal that cannot go out
        _transport.SendErrors[Second] = gone;
        Deliver(Second, RequestOf(3, Echo with { ServiceId = 99 }));
        await Settle();

        Assert.Equal(["rejected first", "thrown second", "EnvelopeMalformed first", "gone second"], Reported());
        Assert.Same(gone, _errors[3].Reason);
    }

    [Fact]
    public async Task Requests_of_the_server_s_own_parity_or_on_a_subscription_s_call_id_are_reported_on_their_connection_and_taken_on_another()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Deliver(First, SubscribingOf(13));
        await Settle();
        SentSince();

        Deliver(First, SubscribingOf(13));
        Deliver(First, SubscribingOf(14));
        Deliver(Second, SubscribingOf(13));
        await Settle();

        Assert.Equal(["EnvelopeMalformed first", "EnvelopeMalformed first"], Reported());
        Assert.Equal(["second result 13 ok"], SentSince());
        Assert.Equal(["first 13", "second 13"], await SubscribedTo(News));
    }

    [Fact]
    public async Task Requests_whose_answer_s_session_cannot_be_told_are_answered_by_nothing_and_reported()
    {
        var failure = new InvalidOperationException("no session");

        Start(new RouterServerOptions
        {
            SessionTokenOf = (_) =>
            {
                throw failure;
            },
        });
        EchoOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Deliver(First, RequestOf(1));
        await Settle();

        Assert.Empty(_transport.Sent);
        Assert.Equal(["no session first"], Reported());
        Assert.Same(failure, _errors[0].Reason);
    }

    [Fact]
    public void Requests_refuse_a_second_resolver_for_one_procedure()
    {
        Start();

        var resolver = new RawResolver(Echo, (_) =>
        {
            return Task.CompletedTask;
        });

        Router.RegisterResolver(resolver);

        Assert.Throws<ArgumentException>(() =>
        {
            Router.RegisterResolver(resolver);
        });
    }

    [Fact]
    public async Task Commands_go_to_the_connection_their_options_name_on_even_call_ids_and_resolve_with_that_connection_s_result_alone()
    {
        Start(new RouterServerOptions
        {
            SessionTokenOf = (_) =>
            {
                return Token;
            },
        });
        _transport.Open(First);
        _transport.Open(Second);

        var answering = Router.Request(BytesOf("ping"), CommandOf(First));

        await Settle();

        // a request presents no session
        var (connectionHandle, envelope) = Assert.Single(_transport.Sent);

        Assert.Equal(First, connectionHandle);
        Assert.Equal(new RequestHeader { CallId = 2, ServiceId = 2, ProcedureId = 1 }, envelope.Header);
        Assert.Equal("ping", TextOf(envelope.Payload));

        // the same call id, from another connection, answers nothing
        Deliver(Second, ResultOf(2));
        await Settle();
        Assert.False(answering.IsCompleted);
        Deliver(First, ResultOf(2, "pong"));

        Assert.Equal("pong", TextOf((await answering.WaitAsync(Patience, Cancelled)).Payload));
        await Settle();
        Assert.Equal(["CallUnknown second"], Reported());
        Assert.Equal(["Request first", "Response first"], _activity);
    }

    [Fact]
    public async Task Commands_name_their_connection_and_it_must_be_open_a_server_holds_no_subscription()
    {
        Start();

        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return Router.Request(
                ReadOnlyMemory<byte>.Empty,
                new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) })).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First)).WaitAsync(Patience, Cancelled);
        });

        _transport.Open(First);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return Router.Request(
                ReadOnlyMemory<byte>.Empty,
                CommandOf(First) with { Subscribes = new StandingNotification(News) }).WaitAsync(Patience, Cancelled);
        });

        _transport.Closed(First);

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First)).WaitAsync(Patience, Cancelled);
        });
    }

    [Fact]
    public async Task Commands_reach_a_connection_that_spoke_before_the_router_saw_it_open()
    {
        Start();

        // an advisory kind, which is skipped
        _transport.Deliver(First, Convert.FromHexString("A180000200000001"));

        var answering = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First));

        await Settle();
        Deliver(First, ResultOf(_transport.Sent[^1].Envelope.Header.CallId));

        Assert.NotNull(await answering.WaitAsync(Patience, Cancelled));
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Commands_reject_with_the_failure_answered_time_out_and_are_rejected_when_their_connection_closes()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);

        var failed = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First));

        await Settle();
        Deliver(First, new Envelope
        {
            Header = new FailureHeader { CallId = 2 },
            Failure = Failure.OfProtocol(ProtocolCode.ProcedureUnknown, "why"),
        });

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return failed.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.ProcedureUnknown, failure.Code);
        Assert.Equal("why", failure.Detail);
        Assert.Equal(FailureOrigin.Peer, failure.Origin);
        Assert.Equal(RouterSide.Client, failure.Side);

        var timing = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First, TimeSpan.FromMilliseconds(10)));

        await Settle();
        _time.Advance(TimeSpan.FromMilliseconds(10));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timing.WaitAsync(Patience, Cancelled);
        });

        var closing = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First));
        var staying = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(Second));

        await Settle();
        _transport.Closed(First);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return closing.WaitAsync(Patience, Cancelled);
        });

        Deliver(Second, ResultOf(8));

        Assert.NotNull(await staying.WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Commands_refuse_a_payload_too_large_here()
    {
        Start();
        _transport.Open(First);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Router.Request(new byte[0x1000001], CommandOf(First)).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code);
        Assert.Equal(RouterSide.Server, failure.Side);
        Assert.Empty(_transport.Sent);
    }

    [Fact]
    public async Task A_command_that_times_out_is_cancelled_on_its_even_call_id()
    {
        Start();
        _transport.Open(First);

        var asking = Router.Request(BytesOf("ping"), CommandOf(First, TimeSpan.FromMilliseconds(20)));

        await Settle();
        _time.Advance(TimeSpan.FromMilliseconds(20));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asking.WaitAsync(Patience, Cancelled);
        });
        await Settle();

        Assert.Equal(["first request 2 ping", "first cancel 2"], SentSince());
    }

    [Fact]
    public async Task A_callback_that_subscribes_an_ordinary_request_fails_is_reported_and_subscribes_nothing()
    {
        Start();
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("ok");
        });

        Deliver(First, RequestOf(1, News));
        await Settle();

        Assert.Equal(["first failure 1 ProcedureFailed"], SentSince());
        Assert.IsType<InvalidOperationException>(Assert.Single(_errors).Reason);
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task Notify_reaches_each_subscriber_under_the_call_id_it_subscribed_with_and_announces_no_session()
    {
        Start(new RouterServerOptions
        {
            SessionTokenOf = (connectionHandle) =>
            {
                return connectionHandle == First ? Token : OtherToken;
            },
        });
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(13));
        Deliver(Second, SubscribingOf(21));
        await Settle();
        _transport.Sent.Clear();
        _activity.Clear();
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(
            [(First, new NotificationHeader { CallId = 13 }), (Second, new NotificationHeader { CallId = 21 })],
            _transport.Sent.Select((entry) =>
            {
                return (entry.ConnectionHandle, entry.Envelope.Header);
            }));
        Assert.Equal(["first notification 13 flash", "second notification 21 flash"], SentSince());
        Assert.Equal(["Notification first", "Notification second"], _activity);
    }

    [Fact]
    public async Task Notify_reaches_only_those_its_options_keep()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);
        _transport.Open(Third);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        Deliver(Third, SubscribingOf(1));
        await Settle();

        async Task<List<string>> Reached(NotifyOptions? options = null)
        {
            _transport.Sent.Clear();
            await news.Notify("flash", options).WaitAsync(Patience, Cancelled);
            await Settle();

            return [.. _transport.Sent.Select((entry) =>
            {
                return NameOf(entry.ConnectionHandle);
            })];
        }

        bool IsNotFirst(string connectionHandle)
        {
            return connectionHandle != First;
        }

        Assert.Equal(["first", "second", "third"], await Reached());
        Assert.Equal(["first", "third"], await Reached(new NotifyOptions { Exclude = Second }));
        Assert.Equal(["second", "third"], await Reached(new NotifyOptions { Filter = IsNotFirst }));
        Assert.Equal(["second"], await Reached(new NotifyOptions { Exclude = Third, Filter = IsNotFirst }));
    }

    [Fact]
    public async Task Notify_sends_to_none_when_its_filter_throws_on_any()
    {
        var failure = new InvalidOperationException("no such user");

        Start();
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        bool Filter(string connectionHandle)
        {
            if (connectionHandle == Second)
            {
                throw failure;
            }

            return true;
        }

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        _transport.Sent.Clear();

        await news.Notify("flash", new NotifyOptions { Filter = Filter }).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Empty(_transport.Sent);

        // the TypeScript side's manager tells its debug event of the failure, which this side's
        // manager tells nowhere yet: it is seen here as the router's notify throws it
        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return Router.Notify(BytesOf("flash"), new NotifyRequest(News.Address, Filter, null)).WaitAsync(Patience, Cancelled);
        });

        Assert.Same(failure, thrown);
        Assert.Empty(_transport.Sent);
    }

    [Fact]
    public async Task A_connection_that_closes_is_no_longer_notified_and_one_that_cannot_take_it_keeps_none_from_the_others()
    {
        var full = new IOException("full");

        Start();
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        _transport.SendErrors[First] = full;
        _transport.Sent.Clear();
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["full first"], Reported());
        Assert.Same(full, _errors[0].Reason);
        Assert.Equal(["first notification 1 flash", "second notification 1 flash"], SentSince());
        Assert.Equal(["Notification second"], _activity);

        _transport.Closed(First);
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["second notification 1 flash"], SentSince());
        Assert.Single(_errors);
    }

    [Fact]
    public async Task Notify_refuses_a_payload_too_large_for_each_connection_and_reports_it_with_that_connection()
    {
        Start();
        _transport.Open(First);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Deliver(First, SubscribingOf(1));
        await Settle();
        _transport.Sent.Clear();

        await Router.Notify(new byte[0x1000001], new NotifyRequest(News.Address, null, null)).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Empty(_transport.Sent);
        Assert.Equal(["PayloadTooLarge first"], Reported());
    }

    [Fact]
    public async Task Notify_sends_a_notification_in_one_envelope_of_the_router_s_limits_or_refuses_it_for_each_connection()
    {
        Start(new RouterServerOptions { Limits = new RouterLimits { ChunkBytes = 64, MaximumEnvelopeBytes = 64, WindowBytes = 128 } });
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        _transport.Sent.Clear();

        // its header takes 8 bytes of the 64
        await Router.Notify(new byte[57], new NotifyRequest(News.Address, null, null)).WaitAsync(Patience, Cancelled);
        await Router.Notify(new byte[56], new NotifyRequest(News.Address, null, null)).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["PayloadTooLarge first", "PayloadTooLarge second"], Reported());
        Assert.Equal(2, SentSince().Count);
        Assert.Throws<ArgumentException>(() =>
        {
            return new RouterServer(_transport, new RouterServerOptions { Limits = new RouterLimits { WindowBytes = 1 } });
        });

        // it shows them, and which side it is
        Assert.Equal(RouterSide.Server, Router.Side);
        Assert.Equal(64, Router.Limits.ChunkBytes);
        Assert.Equal(64, Router.Limits.MaximumEnvelopeBytes);

        // and passes on what hears its own request handed to the transport
        var heard = new List<bool>();
        var asking = Router.Request(new byte[] { 1 }, CommandOf(First) with
        {
            OnSent = (isHanded) =>
            {
                lock (heard)
                {
                    heard.Add(isHanded);
                }
            },
        });

        await Settle();
        Assert.Equal([true], heard);
        Router.Dispose();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return asking.WaitAsync(Patience, Cancelled);
        });
    }

    [Fact]
    public async Task A_connection_that_closes_before_its_answer_goes_out_is_not_subscribed()
    {
        var closed = new TaskCompletionSource();
        var answered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Start();
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await closed.Task;
            await response.Answer("ok");
            answered.SetResult();
        });

        Deliver(First, SubscribingOf(1));
        await Settle();
        _transport.Closed(First);
        await Settle();
        closed.SetResult();
        await answered.Task.WaitAsync(Patience, Cancelled);

        Assert.Empty(await SubscribedTo(News));
        Assert.Empty(_transport.Sent);
    }

    [Fact]
    public async Task A_callback_that_subscribes_before_it_answers_gets_its_request_s_call_id_and_the_one_held_each_time_after()
    {
        Start();
        _transport.Open(First);

        var news = NotifierOf(async (_, response) =>
        {
            var callId = await response.RegisterNotification();

            await response.Answer(callId.ToString(CultureInfo.InvariantCulture));
        });

        Deliver(First, SubscribingOf(7));
        Deliver(First, SubscribingOf(9));
        await Settle();

        Assert.Equal(["first result 7 7", "first result 9 7"], SentSince());
        Assert.Equal(["first 7"], await SubscribedTo(News));

        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first notification 7 flash"], SentSince());
    }

    [Fact]
    public async Task Keeps_apart_the_subscribing_calls_in_flight_on_one_connection_each_settled_by_its_own_answer()
    {
        var gates = new Dictionary<ushort, TaskCompletionSource>
        {
            [News.ProcedureId] = new(),
            [Other.ProcedureId] = new(),
        };
        Procedure[] procedures = [News, Other];

        Start();
        _transport.Open(First);

        foreach (var procedure in procedures)
        {
            NotifierOf(
                async (request, response) =>
                {
                    await response.RegisterNotification();
                    await gates[request.Header.ProcedureId].Task;
                    await (request.Payload == "refuse" ? response.Fail(Failure.OfApplication(1)) : response.Answer("ok"));
                },
                procedure);
        }

        Deliver(First, SubscribingOf(1, "refuse"));
        Deliver(First, SubscribingOf(3, "in", Other));
        await Settle();

        Assert.Equal(["first 1"], await SubscribedTo(News));
        Assert.Equal(["first 3"], await SubscribedTo(Other));

        gates[News.ProcedureId].SetResult();
        gates[Other.ProcedureId].SetResult();
        await Settle();

        Assert.Empty(await SubscribedTo(News));
        Assert.Equal(["first 3"], await SubscribedTo(Other));
    }

    [Fact]
    public async Task What_an_answer_subscribed_goes_with_it_when_it_is_a_failure_or_does_not_go_out()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf(async (request, response) =>
        {
            if (request.Payload != "implicit")
            {
                await response.RegisterNotification();
            }

            await (request.Payload == "refuse" ? response.Fail(Failure.OfApplication(1)) : response.Answer("ok"));
        });

        // a failure answered, after its callback subscribed
        Deliver(First, SubscribingOf(1, "refuse"));
        await Settle();

        Assert.Empty(await SubscribedTo(News));

        // answers that cannot go out, whoever subscribed
        _transport.SendErrors[Second] = new IOException("gone");
        Deliver(Second, SubscribingOf(1, "explicit"));

        // undone before the next answers, so that one subscribes the connection itself
        await Settle();
        Deliver(Second, SubscribingOf(3, "implicit"));
        await Settle();
        _transport.SendErrors.Clear();

        Assert.Empty(await SubscribedTo(News));
        Assert.Equal(["gone second", "gone second"], Reported());
    }

    [Fact]
    public async Task A_subscription_s_result_too_large_for_one_envelope_is_refused_answered_as_failed_and_subscribes_nothing()
    {
        // one byte past what a result's envelope holds whole, its announcement counted: a chunk's
        // 1 MiB less its header's 8 bytes and an announcement's 20
        var large = new string('x', 1_048_549);

        Assert.Equal(
            RouterLimits.Default.ChunkBytes + 1,
            EnvelopeCodec.HeaderBytesOf(new ResultHeader { CallId = 1, Credential = Token }) + large.Length);
        Start();
        _transport.Open(First);
        NotifierOf(async (request, response) =>
        {
            if (request.Payload == "explicit")
            {
                await response.RegisterNotification();
            }

            await response.Answer(large);
        });

        // whether its callback subscribed, or its answer would have
        Deliver(First, SubscribingOf(1, "explicit"));
        Deliver(First, SubscribingOf(3, "implicit"));
        await Settle();

        Assert.Empty(await SubscribedTo(News));
        Assert.Equal(["first failure 1 ProcedureFailed", "first failure 3 ProcedureFailed"], SentSince());
        Assert.Equal(["PayloadTooLarge first", "PayloadTooLarge first"], Reported());
    }

    [Fact]
    public async Task A_callback_subscribes_only_an_open_connection_and_fails_otherwise()
    {
        var closed = new TaskCompletionSource();
        var thrown = new List<Exception>();

        Start();
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await closed.Task;

            try
            {
                await response.Answer((await response.RegisterNotification()).ToString(CultureInfo.InvariantCulture));
            }
            catch (Exception reason)
            {
                thrown.Add(reason);

                throw;
            }
        });

        Deliver(First, SubscribingOf(1));
        await Settle();
        _transport.Closed(First);
        await Settle();
        closed.SetResult();
        await Settle();

        Assert.Empty(await SubscribedTo(News));
        Assert.IsType<DisconnectException>(Assert.Single(thrown));

        // nor answered, nor reported: its connection took the call away, and its call id may be
        // another's now
        Assert.Empty(_transport.Sent);
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task A_callback_that_subscribes_once_its_call_was_cancelled_subscribes_nothing_and_the_next_one_is_kept()
    {
        var thrown = new List<Exception>();
        var cancelled = new TaskCompletionSource();
        var calls = 0;

        Start();
        _transport.Open(First);

        var news = NotifierOf(async (_, response) =>
        {
            calls += 1;

            // the first one is slow, and its requester gives up meanwhile
            if (calls == 1)
            {
                await cancelled.Task;
            }

            try
            {
                await response.Answer((await response.RegisterNotification()).ToString(CultureInfo.InvariantCulture));
            }
            catch (Exception reason)
            {
                thrown.Add(reason);

                throw;
            }
        });

        Deliver(First, SubscribingOf(1));
        await Settle();
        Deliver(First, CancelOf(1));
        await Settle();
        cancelled.SetResult();
        await Settle();

        Assert.IsType<OperationCanceledException>(Assert.Single(thrown));
        Assert.Empty(await SubscribedTo(News));

        // subscribed again, it hears what comes
        Deliver(First, SubscribingOf(3));
        await Settle();
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first result 3 3", "first notification 3 flash"], SentSince());
    }

    [Fact]
    public async Task A_cancel_takes_an_established_subscription_away_on_its_own_connection_alone()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        _transport.Sent.Clear();

        // another connection's cancel touches nothing of this one
        Deliver(Second, CancelOf(1));
        await Settle();
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first notification 1 flash"], SentSince());
        Assert.Equal(["first 1"], await SubscribedTo(News));
    }

    [Fact]
    public async Task A_waiting_subscription_takes_the_place_when_the_answer_of_the_call_that_holds_it_cannot_go_out()
    {
        StartHolding(Outcome.Answer);
        await Settle();
        _transport.SendErrors[First] = new IOException("gone");
        _released.SetResult();
        await Settle();
        _transport.SendErrors.Clear();

        Assert.Equal(["first 3"], await SubscribedTo(News));
    }

    [Fact]
    public async Task A_waiting_subscription_stays_out_once_the_call_that_holds_its_place_is_answered_and_does_not_take_a_place_it_leaves_later()
    {
        StartHolding(Outcome.Answer);
        await Settle();
        _released.SetResult();
        await Settle();

        // the holder answered keeps hearing
        Assert.Equal(["first 1"], await SubscribedTo(News));

        // the requester of the call that holds it lets go of it: the place is no one's
        Deliver(First, CancelOf(1));

        Assert.Empty(await SubscribedTo(News));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_waiting_subscription_takes_nothing_once_cancelled_or_unsubscribed_itself(bool isCancelled)
    {
        StartHolding(Outcome.Fail);
        await Settle();

        if (isCancelled)
        {
            Deliver(First, CancelOf(3));
        }
        else
        {
            // waiting, it holds no subscription to take away
            Assert.False(await Router.Unsubscribe(new CallAddress(3, First)).WaitAsync(Patience, Cancelled));
        }

        await Settle();
        _released.SetResult();
        await Settle();

        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_waiting_subscription_waits_by_procedure_two_held_on_one_connection_each_hand_their_own_place_over()
    {
        Procedure[] procedures = [News, Other];

        Start();
        _transport.Open(First);

        foreach (var procedure in procedures)
        {
            NotifierOf(
                async (request, response) =>
                {
                    await response.RegisterNotification();

                    if (request.Payload == "hold")
                    {
                        await _released.Task;
                        await response.Fail(Failure.OfApplication(1));

                        return;
                    }

                    await response.Answer("ok");
                },
                procedure);
        }

        Deliver(First, SubscribingOf(1, "hold"));
        Deliver(First, SubscribingOf(3, "hold", Other));
        Deliver(First, SubscribingOf(5, "subscribe"));
        Deliver(First, SubscribingOf(7, "subscribe", Other));
        await Settle();
        _released.SetResult();
        await Settle();

        Assert.Equal(["first 5"], await SubscribedTo(News));
        Assert.Equal(["first 7"], await SubscribedTo(Other));
    }

    [Fact]
    public async Task A_waiting_subscription_is_the_first_answered_one_answered_after_it_waits_for_nothing()
    {
        StartHolding(Outcome.Fail);
        Deliver(First, SubscribingOf(5, "subscribe"));
        await Settle();
        _released.SetResult();
        await Settle();

        Assert.Equal(["first 3"], await SubscribedTo(News));
    }

    [Fact]
    public async Task A_waiting_subscription_takes_no_place_on_a_connection_that_closed_as_the_answer_of_the_call_that_holds_it_failed_to_go_out()
    {
        var sending = new TaskCompletionSource();

        StartHolding(Outcome.Answer);
        await Settle();

        // the TypeScript side closes the connection as the transport takes the answer; this side
        // hears of a close in its turn, so the answer waits at the transport until the close was
        // heard, then fails
        _transport.Pending = sending;
        _released.SetResult();
        await Settle();
        _transport.Closed(First);
        await Settle();
        sending.SetException(new IOException("gone"));
        await Settle();

        Assert.Equal(["gone first"], Reported());
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_waiting_subscription_is_ended_as_an_established_one_when_the_session_ends_and_takes_nothing_after()
    {
        StartHolding(Outcome.Fail);
        await Settle();
        _transport.Sent.Clear();
        await Router.DropSubscriptions(First, Failure.OfProtocol(ProtocolCode.SessionRequired)).WaitAsync(Patience, Cancelled);
        _released.SetResult();
        await Settle();

        Assert.Equal(["first failure 3 SessionRequired", "first failure 1 1"], SentSince());
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_subscription_answered_once_another_holds_its_place_answered_already_waits_for_nothing()
    {
        Start();
        _transport.Open(First);
        NotifierOf(async (_, response) =>
        {
            await response.Answer((await response.RegisterNotification()).ToString(CultureInfo.InvariantCulture));
        });
        Deliver(First, SubscribingOf(1));
        await Settle();
        Deliver(First, SubscribingOf(3));
        await Settle();

        // the place is left, and no one takes it
        Deliver(First, CancelOf(1));

        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_callback_that_subscribes_as_the_router_is_disposed_hears_a_DisconnectException()
    {
        var thrown = new List<Exception>();

        Start();
        _transport.Open(First);
        NotifierOf(async (request, response) =>
        {
            var stopped = new TaskCompletionSource();

            using var registration = request.Signal.Register(() =>
            {
                stopped.SetResult();
            });

            await stopped.Task;

            try
            {
                await response.RegisterNotification();
            }
            catch (Exception reason)
            {
                thrown.Add(reason);
            }

            throw new InvalidOperationException("stopped");
        });

        Deliver(First, SubscribingOf(1));
        await Settle();
        Router.Dispose();
        await Settle();

        Assert.IsType<DisconnectException>(Assert.Single(thrown));
        Assert.Empty(await SubscribedTo(News));
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Unsubscribe_takes_a_connection_s_own_subscription_away_by_its_call_id_and_no_other_s()
    {
        Start();
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Deliver(First, SubscribingOf(11));
        await Settle();

        Assert.False(await Router.Unsubscribe(new CallAddress(11, Second)).WaitAsync(Patience, Cancelled));
        Assert.False(await Router.Unsubscribe(new CallAddress(13, First)).WaitAsync(Patience, Cancelled));
        Assert.True(await Router.Unsubscribe(new CallAddress(11, First)).WaitAsync(Patience, Cancelled));
        Assert.False(await Router.Unsubscribe(new CallAddress(11, First)).WaitAsync(Patience, Cancelled));

        // no notification follows it
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task DropSubscriptions_ends_each_established_subscription_with_a_failure_the_first_announcing_and_skips_a_call_in_flight()
    {
        var gone = new IOException("gone");
        var inFlight = new TaskCompletionSource();
        SessionToken? token = Token;

        Start(new RouterServerOptions
        {
            SessionTokenOf = (_) =>
            {
                return token;
            },
        });
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        NotifierOf(
            (_, response) =>
            {
                return response.Answer("ok");
            },
            Other);
        NotifierOf(
            async (_, response) =>
            {
                await response.RegisterNotification();
                await inFlight.Task;
                await response.Answer("late");
            },
            Echo);

        Deliver(First, SubscribingOf(1));
        Deliver(First, SubscribingOf(3, procedure: Other));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        Deliver(First, SubscribingOf(5, procedure: Echo));
        await Settle();
        _transport.Sent.Clear();
        token = null;

        await Router.DropSubscriptions(First, Failure.OfProtocol(ProtocolCode.SessionRequired)).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(
            [
                (First, new FailureHeader { CallId = 1, Credential = Credential.None }),
                (First, new FailureHeader { CallId = 3 }),
            ],
            _transport.Sent.Select((entry) =>
            {
                return (entry.ConnectionHandle, entry.Envelope.Header);
            }));
        Assert.Equal(["first failure 1 SessionRequired", "first failure 3 SessionRequired"], SentSince());

        // the call in flight keeps its subscription, and gets its own answer alone
        Assert.Equal(["first 5"], await SubscribedTo(Echo));
        Assert.Equal(["second 1"], await SubscribedTo(News));
        Assert.Empty(await SubscribedTo(Other));

        inFlight.SetResult();
        await Settle();

        Assert.Equal(["first result 5 late"], SentSince());

        // a failure that cannot go out is reported, and the subscription goes all the same
        _transport.SendErrors[Second] = gone;
        await Router.DropSubscriptions(Second, Failure.OfProtocol(ProtocolCode.SessionRequired)).WaitAsync(Patience, Cancelled);
        await Settle();
        _transport.SendErrors.Clear();

        Assert.Equal(["gone second"], Reported());
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_server_does_not_subscribe_it_notifies()
    {
        var notification = new StandingNotification(News);

        Start();

        Assert.False(Router.HasNotification(notification));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return Router.RegisterNotification(notification).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return Router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        });
    }

    [Fact]
    public async Task Dispose_lets_go_of_the_transport_rejects_what_waits_forgets_every_connection_and_sends_nothing_more()
    {
        Start();
        _transport.Open(First);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        await Settle();

        var waiting = Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First));

        await Settle();
        Router.Dispose();
        _transport.Sent.Clear();

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, Cancelled);
        });
        Assert.Empty(await SubscribedTo(News));
        Assert.False(_transport.IsFollowed);

        // an envelope now reaches nothing, and nothing goes out
        Deliver(First, SubscribingOf(3));
        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Router.Request(ReadOnlyMemory<byte>.Empty, CommandOf(First)).WaitAsync(Patience, Cancelled);
        });

        // nor does a resolver still at work subscribe a connection nothing would clean
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Router.Subscribe(new AnswerTarget(
                First,
                new RequestHeader { CallId = 5, ServiceId = 2, ProcedureId = 5, OpensSubscription = true })).WaitAsync(Patience, Cancelled);
        });
        await Settle();

        Assert.Empty(_transport.Sent);
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Tells_debug_each_envelope_with_its_connection_and_its_header_without_its_token()
    {
        var seen = new List<(DebugDirection Direction, TracedEnvelope Envelope)>();

        Start(new RouterServerOptions
        {
            SessionTokenOf = (_) =>
            {
                return Token;
            },
        });
        EchoOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Router.Debug += (direction, envelope) =>
        {
            seen.Add((direction, envelope));
        };

        Deliver(First, RequestOf(9));
        await Settle();

        Assert.Equal(
            [
                (DebugDirection.Rx, new TracedEnvelope(First, new RequestHeader { CallId = 9, ServiceId = 2, ProcedureId = 1 }, null)),
                (DebugDirection.Tx, new TracedEnvelope(First, new ResultHeader { CallId = 9 }, CredentialScheme.Opaque)),
            ],
            seen);
        Assert.Equal(new ResultHeader { CallId = 9, Credential = Token }, _transport.Sent[0].Envelope.Header);
    }

    // the TypeScript side links a WebSocket client and server over the wire; the test project
    // references no transport, so a client's router is linked to this server's in memory. What
    // they ask, answer and command each other, the conversations and RouterClientTests show
    [Fact]
    public async Task A_client_and_a_server_subscribe_notify_and_unsubscribe_each_other_over_a_link()
    {
        var unsubscribed = new List<string>();
        var heard = new List<string>();
        var dropped = new List<Procedure>();
        var clientEnd = new ClientEnd(_transport);

        Start();
        _transport.Peer = clientEnd;

        using var client = new RouterClient(clientEnd, new RouterClientOptions { ResolverScheduler = _scheduler, Scheduler = _scheduler });

        var clientServices = new ServiceManager(client);

        _transport.Open(First);

        var news = NotifierOf(async (_, response) =>
        {
            await response.Answer((await response.RegisterNotification()).ToString(CultureInfo.InvariantCulture));
        });

        Services.GetRequestResolver(UnsubscribeProcedure, new RequestResolverDependencies<string, string> { Serializer = Text })(async (request, response) =>
        {
            var callId = uint.Parse(request.Payload, CultureInfo.InvariantCulture);
            var isHeld = await Router.Unsubscribe(new CallAddress(callId, request.ConnectionHandle));

            await response.Answer(isHeld.ToString(CultureInfo.InvariantCulture));
        });

        var unsubscribe = clientServices.GetRequest(UnsubscribeProcedure, new RequestDependencies<string, string> { Serializer = Text });
        var notification = clientServices.GetNotification(
            News,
            new NotificationDependencies<string, string, string>
            {
                Serializer = Text,
                Unsubscribe = async (callId, response) =>
                {
                    unsubscribed.Add($"{callId} {response} {await unsubscribe(callId.ToString(CultureInfo.InvariantCulture))()}");
                },
            });

        var registration = await notification.Register("subscribe", (payload) =>
        {
            heard.Add(payload);

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await news.Notify("flash").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["flash"], heard);

        // unsubscribed at the server, by the call id that subscribed, by the time it is taken away
        await registration.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Equal(["1 1 True"], unsubscribed);
        Assert.Empty(await SubscribedTo(News));

        // a subscription again, which the connection takes away with it
        clientServices.Dropped += (procedure, _) =>
        {
            dropped.Add(procedure);
        };
        await notification.Register("subscribe", (_) =>
        {
            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);
        Assert.Equal(["first 5"], await SubscribedTo(News));

        clientEnd.Closed();
        _transport.Closed(First);
        await Settle();

        Assert.Equal([News], dropped);
        Assert.Empty(await SubscribedTo(News));
    }

    [Fact]
    public async Task A_paced_subscription_is_sent_one_notification_per_credit_and_queues_the_others_the_latest_of_a_key_in_its_place()
    {
        var news = StartPaced();

        Deliver(First, PacedOf(3));
        await Settle();

        Assert.Equal(["first result 3 ok"], SentSince());

        // each settles once queued, the transport having nothing of it
        await news.Notify("7 a", new NotifyOptions { Key = 7 }).WaitAsync(Patience, Cancelled);
        await news.Notify("7 b", new NotifyOptions { Key = 7 }).WaitAsync(Patience, Cancelled);
        await news.Notify("9 a", new NotifyOptions { Key = 9 }).WaitAsync(Patience, Cancelled);
        await news.Notify("event").WaitAsync(Patience, Cancelled);
        await news.Notify("7 c", new NotifyOptions { Key = 7 }).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first notification 3 7 a"], SentSince());
        Assert.Equal((1L, 3L), await Queued());

        Deliver(First, PacedCreditOf(3, 3));
        await Settle();

        Assert.Equal(["first notification 3 7 c", "first notification 3 9 a"], SentSince());

        // a credit that came late, and a transfer's on the same call id, let nothing go
        Deliver(First, PacedCreditOf(3, 2));
        Deliver(First, new Envelope { Header = new CreditHeader { CallId = 3, CreditEnd = 100 } });
        await Settle();

        Assert.Empty(SentSince());

        Deliver(First, PacedCreditOf(3, 5));
        await Settle();
        await news.Notify("after").WaitAsync(Patience, Cancelled);
        await news.Notify("past").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first notification 3 event", "first notification 3 after"], SentSince());
        Assert.Equal((1L, 1L), await Queued());
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Paces_no_subscription_that_did_not_ask_beside_one_that_did()
    {
        string[] words = ["a", "b", "c"];
        var news = StartPaced();

        Deliver(First, PacedOf(3));
        Deliver(Second, SubscribingOf(3));
        await Settle();
        SentSince();

        foreach (var word in words)
        {
            await news.Notify(word).WaitAsync(Patience, Cancelled);
        }

        await Settle();

        Assert.Equal(
            ["first notification 3 a", "second notification 3 a", "second notification 3 b", "second notification 3 c"],
            SentSince());

        _activity.Clear();
        Deliver(First, PacedCreditOf(3, 2));
        await Settle();

        // a notification the credit let go is one sent, as any
        Assert.Equal(["first notification 3 b"], SentSince());
        Assert.Equal(["Notification first"], _activity);
    }

    [Fact]
    public async Task Drops_in_silence_a_credit_for_no_subscription_paced_which_may_have_crossed_its_end()
    {
        StartPaced();
        Deliver(Second, SubscribingOf(3));
        await Settle();
        SentSince();

        Deliver(First, PacedCreditOf(9, 4));
        Deliver(Second, PacedCreditOf(3, 4));
        await Settle();

        Assert.Empty(SentSince());
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Ends_an_established_subscription_whose_queue_goes_past_its_bounds_and_sends_it_nothing_after()
    {
        string[] words = ["a", "b", "c", "d"];
        var news = StartPaced(new PacingLimits { MaximumQueuedNotifications = 2 });

        Deliver(First, PacedOf(3));
        Deliver(Second, PacedOf(5));
        await Settle();
        SentSince();

        foreach (var word in words)
        {
            await news.Notify(
                word,
                new NotifyOptions
                {
                    Filter = (connectionHandle) =>
                    {
                        return connectionHandle == First;
                    },
                }).WaitAsync(Patience, Cancelled);
        }

        await Settle();

        Assert.Equal("the notifications queued for call 3 went past their bounds", _transport.Sent[^1].Envelope.Failure?.Detail);
        Assert.Equal(["first notification 3 a", "first failure 3 CapacityExceeded"], SentSince());
        Assert.Equal((0L, 0L), await Queued());

        // the other paced connection keeps its subscription, and its credit
        await news.Notify("e").WaitAsync(Patience, Cancelled);
        Deliver(First, PacedCreditOf(3, 10));
        await Settle();

        Assert.Equal(["second notification 5 e"], SentSince());
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Answers_with_the_failure_a_call_in_flight_whose_queue_goes_past_its_bounds_and_hands_its_place_over()
    {
        string[] words = ["a", "b", "c"];
        var news = StartPaced(new PacingLimits { MaximumQueuedNotifications = 1 });

        // the holder, in flight; then one answered meanwhile, which waits for its place
        Deliver(First, PacedOf(3, "hold"));
        Deliver(First, PacedOf(5));
        await Settle();

        Assert.Equal(["first result 5 ok"], SentSince());

        foreach (var word in words)
        {
            await news.Notify(word).WaitAsync(Patience, Cancelled);
        }

        await Settle();

        Assert.Equal(["first notification 3 a", "first failure 3 CapacityExceeded"], SentSince());

        // the one that waited took the place, paced as it asked
        await news.Notify("d").WaitAsync(Patience, Cancelled);
        await news.Notify("e").WaitAsync(Patience, Cancelled);
        _released.SetResult();
        await Settle();

        // the holder's own answer goes nowhere: its call was answered
        Assert.Equal(["first notification 5 d"], SentSince());

        // the place is its own: its credit lets go what it queued
        Deliver(First, PacedCreditOf(5, 2));
        await Settle();

        Assert.Equal(["first notification 5 e"], SentSince());
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task Reports_the_failure_it_could_not_send_a_call_in_flight_whose_queue_went_past_its_bounds()
    {
        var gone = new IOException("gone");
        var news = StartPaced(new PacingLimits { MaximumQueuedNotifications = 1 });

        Deliver(First, PacedOf(3, "hold"));
        await Settle();
        await news.Notify("a").WaitAsync(Patience, Cancelled);
        await news.Notify("b").WaitAsync(Patience, Cancelled);
        await Settle();
        _transport.SendErrors[First] = gone;
        await news.Notify("c").WaitAsync(Patience, Cancelled);
        _released.SetResult();
        await Settle();
        _transport.SendErrors.Clear();

        Assert.Equal("first failure 3 CapacityExceeded", SentSince()[^1]);
        Assert.Contains((gone, First), _errors);

        // no subscription remains on the call: a credit lets nothing go, and nothing hears a notification
        Deliver(First, PacedCreditOf(3, 10));
        await Settle();

        Assert.Empty(SentSince());
        Assert.Empty(await SubscribedTo(News));
    }

    // subscription-places.test.ts:92 tests the places alone; here, through the router
    [Fact]
    public async Task Paces_a_call_handed_its_place_as_its_own_request_asked_whatever_its_holder_asked()
    {
        string[] words = ["a", "b"];

        Start();
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf(async (request, response) =>
        {
            await response.RegisterNotification();

            if (request.Payload == "hold")
            {
                await _released.Task;
                await response.Fail(Failure.OfApplication(1));

                return;
            }

            await response.Answer("ok");
        });

        // on the first, a paced holder and a waiter that is not; on the second, the other way round
        Deliver(First, PacedOf(1, "hold"));
        Deliver(First, SubscribingOf(3, "subscribe"));
        Deliver(Second, SubscribingOf(1, "hold"));
        Deliver(Second, PacedOf(3, "subscribe"));
        await Settle();

        // the first's holder fails, the second's is cancelled: each hands its place over
        Deliver(Second, CancelOf(1));
        await Settle();
        _released.SetResult();
        await Settle();
        _transport.Sent.Clear();

        foreach (var word in words)
        {
            await news.Notify(word).WaitAsync(Patience, Cancelled);
        }

        await Settle();

        Assert.Equal(
            ["first notification 3 a", "first notification 3 b", "second notification 3 a"],
            SentSince().Order(StringComparer.Ordinal));
    }

    // subscription-places.test.ts:191 tests the places alone; here, through the router, its holder
    // answered as it should
    [Fact]
    public async Task DropSubscriptions_ends_the_established_and_the_waiting_never_one_in_flight_and_no_call_waits_after()
    {
        StartHolding(Outcome.Answer);
        NotifierOf(
            (_, response) =>
            {
                return response.Answer("ok");
            },
            Other);
        Deliver(First, SubscribingOf(5, procedure: Other));
        await Settle();
        _transport.Sent.Clear();

        await Router.DropSubscriptions(First, Failure.OfProtocol(ProtocolCode.SessionRequired)).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first failure 5 SessionRequired", "first failure 3 SessionRequired"], SentSince());

        // the holder, left to its own answer, keeps its place
        _released.SetResult();
        await Settle();

        Assert.Equal(["first result 1 held"], SentSince());
        Assert.Equal(["first 1"], await SubscribedTo(News));
        Assert.Empty(await SubscribedTo(Other));
    }

    // subscription-places.test.ts:207 tests the places alone; here, through the router: a handle
    // opened again finds no call of the connection that closed waiting
    [Fact]
    public async Task A_connection_that_closes_takes_its_calls_in_flight_and_waiting_away()
    {
        StartHolding(Outcome.Fail);
        await Settle();
        _transport.Closed(First);
        _transport.Open(First);

        // a new holder, on the call id of the one that went with its connection
        Deliver(First, SubscribingOf(1, "hold"));
        await Settle();
        _released.SetResult();
        await Settle();

        Assert.Equal(["first failure 1 1"], SentSince().Where((sent) =>
        {
            return sent.Contains("failure", StringComparison.Ordinal);
        }));
        Assert.Empty(await SubscribedTo(News));
    }

    // how the call that holds a place answers
    private enum Outcome
    {
        Answer,
        Fail,
    }

    // a resolver as the router takes it, its payload still encoded, which admits every request
    private sealed class RawResolver(Procedure procedure, Func<RequestResolverProps, Task> handle) : IRequestResolver
    {
        public Procedure Procedure
        {
            get
            {
                return procedure;
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
            return handle(props);
        }
    }

    // a notification as a client's router would hold it, which nothing triggers
    private sealed class StandingNotification(Procedure procedure) : INotificationLike
    {
        public Procedure Procedure
        {
            get
            {
                return procedure;
            }
        }

        public int? Window
        {
            get
            {
                return null;
            }
        }

        public Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload)
        {
            return Task.FromResult<IReadOnlyList<Exception>>([]);
        }

        public void Drop(Failure? failure)
        {
        }
    }

    // text, in UTF-8, either way
    private sealed class TextPayloads : INotificationSerializerServer<string, string, string>, INotificationSerializerClient<string, string, string>
    {
        public string Decode(ReadOnlyMemory<byte> request)
        {
            return TextOf(request);
        }

        public ReadOnlyMemory<byte> Encode(string response)
        {
            return BytesOf(response);
        }

        public ReadOnlyMemory<byte> EncodeNotification(string notification)
        {
            return BytesOf(notification);
        }

        public string DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return TextOf(notification);
        }
    }

    // a client's end of a connection linked in memory to the server's transport, as the first
    private sealed class ClientEnd(ScriptedTransport server) : IRouterClientTransport
    {
        // the link's, which its server end runs on
        public TimeProvider Clock
        {
            get
            {
                return server.Clock;
            }
        }

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        public void Deliver(ReadOnlyMemory<byte> bytes)
        {
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false));
        }

        public void Closed()
        {
            Close?.Invoke(false, false);
        }

        public Task Send(ReadOnlyMemory<byte> bytes)
        {
            server.Deliver(First, bytes.ToArray());

            return Task.CompletedTask;
        }
    }

    // a transport of connections a test opens, delivers to and closes, which records each envelope
    // handed to it, read as a client reads it — one it fails to send too
    private sealed class ScriptedTransport : IRouterServerTransport
    {
        public TimeProvider Clock { get; set; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public List<(string ConnectionHandle, Envelope Envelope)> Sent { get; } = [];

        // what a send to each connection fails with, while set
        public Dictionary<string, Exception> SendErrors { get; } = [];

        // what the next send waits on, when set: it settles as the test settles it
        public TaskCompletionSource? Pending { get; set; }

        // the client's end each send also goes to, when linked
        public ClientEnd? Peer { get; set; }

        // the connections that carry no request of the server's, while listed
        public HashSet<string> OneWay { get; } = [];

        // whether the router still follows its events
        public bool IsFollowed
        {
            get
            {
                return Connection is not null || Message is not null || Close is not null;
            }
        }

        public void Open(string connectionHandle)
        {
            Connection?.Invoke(connectionHandle);
        }

        public void Closed(string connectionHandle)
        {
            Close?.Invoke(false, connectionHandle);
        }

        public void Deliver(string connectionHandle, byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false), connectionHandle);
        }

        public void DeliverText(string connectionHandle, string text)
        {
            Message?.Invoke(new TransportMessage(Encoding.UTF8.GetBytes(text), true), connectionHandle);
        }

        public bool IsTwoWay(string connectionHandle)
        {
            return !OneWay.Contains(connectionHandle);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            var copy = bytes.ToArray();
            var envelope = EnvelopeCodec.ReadEnvelope(
                copy,
                new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!;

            Sent.Add((connectionHandle, envelope));

            if (Pending is { } pending)
            {
                Pending = null;

                return pending.Task;
            }

            if (SendErrors.TryGetValue(connectionHandle, out var reason))
            {
                return Task.FromException(reason);
            }

            Peer?.Deliver(copy);

            return Task.CompletedTask;
        }
    }
}
