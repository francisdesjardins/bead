using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterClient"/>: against a server of the interop service, linked in memory, and against
/// bytes a test writes as a server would.
/// </summary>
public sealed partial class RouterClientTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly SessionToken Token = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw");

    // the procedure the scripted tests ask and subscribe: procedure 1 of service 2
    private static readonly Procedure Service = new() { ServiceId = 2, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 3 };

    private static readonly ResolvedRequestOptions Options = new() { Timeout = TimeSpan.FromSeconds(1) };

    // text both ways, a notification's too, for a service manager over the router
    private static readonly TextPayloads Text = new();

    private static readonly byte[] NotAnEnvelope = [0x0a, 0x14];

    // a whole envelope's prefix, of kind 0x17, which no side takes
    private static readonly byte[] OfAnUnknownKind = [0xa1, 0x17, 0, 2, 0, 0, 0, 2];

    // helpers

    private static Func<JsonElement, BoundCall<JsonElement>> RequesterOf(ServiceManager services, string procedureName)
    {
        return services.GetRequest(
            InteropProcedures.All.Single((procedure) =>
            {
                return procedure.Procedure.ProcedureName == procedureName;
            }).Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });
    }

    private static JsonElement JsonOf(string text)
    {
        using var document = JsonDocument.Parse(text);

        return document.RootElement.Clone();
    }

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static RouterRequest RequestOf(INotificationLike? subscribes = null, ResolvedRequestOptions? options = null)
    {
        return new RouterRequest(Service, options ?? Options) { Subscribes = subscribes };
    }

    // a request's header for the procedure, as either side writes it
    private static RequestHeader RequestHeaderOf(uint callId)
    {
        return new RequestHeader { CallId = callId, ServiceId = 2, ProcedureId = 1 };
    }

    private static Envelope ResultOf(uint callId, Credential? announcement = null)
    {
        return new Envelope { Header = new ResultHeader { CallId = callId, Credential = announcement } };
    }

    private static Envelope FailureOf(uint callId, ProtocolCode code, Credential? announcement = null)
    {
        return new Envelope { Header = new FailureHeader { CallId = callId, Credential = announcement }, Failure = Failure.OfProtocol(code) };
    }

    private static Envelope NotificationOf(uint callId, byte value = 5)
    {
        return new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = new byte[] { value } };
    }

    // what each error says: a failure its code, by name; anything else its message
    private static List<string> CodesOf(IEnumerable<Exception> errors)
    {
        return [.. errors.Select((error) =>
        {
            return error is FailureException failure ? ((ProtocolCode)failure.Code).ToString() : error.Message;
        })];
    }

    // definition

    [Fact]
    public async Task Calls_a_procedure_with_a_payload_then_options_and_gives_its_result_decoded()
    {
        using var link = new Link();

        var echoed = await RequesterOf(link.ClientServices, "echo")(JsonOf("{\"a\":[1,\"two\"]}"))().WaitAsync(Patience, Cancelled);

        Assert.Equal("{\"a\":[1,\"two\"]}", echoed.GetRawText());
    }

    [Fact]
    public async Task Answers_the_command_its_server_asks_it_on_an_even_call_id()
    {
        using var link = new Link();

        InteropHandlers.OfferClient(new InteropClient(link.AsClient));

        var asked = await RequesterOf(link.ClientServices, "ask")(JsonOf("null"))().WaitAsync(Patience, Cancelled);

        Assert.Equal("\"noon\"", asked.GetRawText());
        Assert.Contains(link.ClientReceived, (header) =>
        {
            return header is RequestHeader { CallId: 2 };
        });
    }

    [Fact]
    public async Task Fails_a_command_to_no_connection_or_to_none_named()
    {
        using var link = new Link();

        var clock = link.ServerServices.GetCommand(
            InteropProcedures.Clock.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return clock(JsonOf("null"))(new RequestOptions { ConnectionHandle = "type=WS;ip=127.0.0.1;port=1;ordinal=1" }).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return clock(JsonOf("null"))();
        });
    }

    // spec 17.2.2
    [Fact]
    public async Task Fails_a_result_that_does_not_decode_here_as_undecodable()
    {
        using var link = new Link();

        var requester = link.ClientServices.GetRequest(
            InteropProcedures.Echo.Procedure,
            new RequestDependencies<JsonElement, int> { Serializer = new Unreadable() });

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return requester(JsonOf("1"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(RouterSide.Client, failure.Side);
        Assert.Equal(InteropProcedures.Echo.Procedure.Address, failure.ProcedureAddress);
    }

    [Fact]
    public async Task Refuses_a_payload_that_would_go_as_a_transfer_where_it_sends_none_before_anything_goes_out()
    {
        var transport = new ScriptedTransport();

        using var router = new RouterClient(transport, new RouterClientOptions { Limits = RouterLimits.Default with { MaximumTransfers = 0 } });

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return RequesterOf(new ServiceManager(router), "echo")(JsonOf($"\"{new string('x', 2 * 1_048_576)}\""))()
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Contains("which this side sends none of", failure.Detail, StringComparison.Ordinal);
        Assert.Empty(transport.Sent);
    }

    [Fact]
    public async Task Offers_every_procedure_of_the_interop_service_s_API_on_the_side_its_kind_names()
    {
        await using var link = await ServiceLink.Open();

        var server = new InterceptedServer(link.Server);
        var client = new InterceptedClient(link.Client);
        var interop = InteropHandlers.Offer(server);

        InteropHandlers.OfferClient(new InteropClient(client));

        IEnumerable<string> NamesOf(bool isCommand)
        {
            return InteropProcedures.All.Where((procedure) =>
            {
                return (procedure.Procedure.ProcedureKind == ProcedureKind.Command) == isCommand;
            }).Select((procedure) =>
            {
                return $"resolver {procedure.Procedure.ProcedureName}";
            }).Order(StringComparer.Ordinal);
        }

        IEnumerable<string> ResolversOf(InterceptingRouter router)
        {
            return router.Declared.Where((declared) =>
            {
                return declared.StartsWith("resolver ", StringComparison.Ordinal);
            }).Order(StringComparer.Ordinal);
        }

        // * checked alone is answered by a server side of its own, which holds it with its rules: its
        // resolver is registered all the same
        Assert.Equal([InteropProcedures.Checked.Procedure], interop.ProceduresWithoutResolver());
        Assert.Equal(NamesOf(false), ResolversOf(server.Intercepted));
        Assert.Equal(NamesOf(true), ResolversOf(client.Intercepted));
    }

    [Fact]
    public async Task Rejects_what_waits_once_its_connection_closed_and_forgets_its_session()
    {
        var transport = new ScriptedTransport();
        var scheduler = new SerialScheduler();

        using var router = new RouterClient(transport, new RouterClientOptions { Scheduler = scheduler, ResolverScheduler = scheduler });

        transport.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = 9, Credential = Token } }));

        var waiting = RequesterOf(new ServiceManager(router), "slow")(JsonOf("{\"milliseconds\":3600000}"))();

        await scheduler.WhenIdle();
        Assert.Equal(Token, router.SessionToken);
        transport.CloseConnection();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, Cancelled);
        });
        Assert.Null(router.SessionToken);
    }

    [Fact]
    public void Runs_on_its_transport_s_clock_and_refuses_another()
    {
        var time = new FakeTimeProvider();
        var transport = new ScriptedTransport { Clock = time };

        using var router = new RouterClient(transport);
        using var same = new RouterClient(transport, new RouterClientOptions { Clock = time });
        using var told = new RouterClient(new ScriptedTransport());

        Assert.Equal((time, time), (router.Clock, same.Clock));
        Assert.Same(TimeProvider.System, told.Clock);

        var refusal = Assert.Throws<ArgumentException>(() =>
        {
            return new RouterClient(transport, new RouterClientOptions { Clock = TimeProvider.System });
        });

        Assert.Equal(
            "a client's router runs on the clock of its transport, a FakeTimeProvider, and was given another, the system's",
            refusal.Message);
    }

    [Fact]
    public void Takes_any_transport_of_this_package()
    {
        var transport = new ScriptedTransport();

        using var router = new RouterClient(transport);

        Assert.Same(transport, router.Transport);
        Assert.Null(router.SessionToken);
        Assert.Equal(RouterSide.Client, router.Side);
    }

    [Fact]
    public async Task Sends_a_request_on_an_odd_call_id_and_resolves_with_its_result()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var activity = new List<RouterActivity>();
        var payload = new byte[] { 1, 2 };

        router.Activity += activity.Add;

        var answering = router.Request(payload, RequestOf());

        await scripted.Settle();

        var request = Assert.Single(transport.Envelopes);

        Assert.Equal(RequestHeaderOf(1), request.Header);
        Assert.Equal(payload, request.Payload.ToArray());

        transport.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = new byte[] { 9 } });

        var answer = await answering.WaitAsync(Patience, Cancelled);

        await scripted.Settle();
        Assert.Equal(new ResultHeader { CallId = 1 }, answer.Header);
        Assert.Equal([9], answer.Payload.ToArray());
        Assert.Equal([RouterActivity.Request, RouterActivity.Response], activity);
    }

    [Fact]
    public async Task Times_out_and_cancels_its_call_and_a_result_too_late_says_nothing_while_its_call_id_is_reserved()
    {
        var time = new FakeTimeProvider();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var given = TimeSpan.FromMilliseconds(10);

        var asking = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { Timeout = given }));

        await scripted.Settle();
        time.Advance(given);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asking.WaitAsync(Patience, Cancelled);
        });
        await scripted.Settle();
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u)], transport.Calls);

        transport.Deliver(ResultOf(1));
        await scripted.Settle();
        Assert.Empty(scripted.Errors);

        // reserved as long as the call was given, then free
        time.Advance(given);
        await scripted.Settle();
        transport.Deliver(ResultOf(1));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.CallUnknown)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Learns_the_session_from_every_answer_paired_or_not_keeps_it_loses_it_and_presents_it_on_no_call_that_does_not_ask_for_it()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);

        // an answer to nothing still announces
        transport.Deliver(ResultOf(99, Token));
        await scripted.Settle();
        Assert.Equal(Token, router.SessionToken);
        Assert.Equal([nameof(ProtocolCode.CallUnknown)], CodesOf(scripted.Errors));

        // an answer that says nothing keeps it
        var first = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(ResultOf(1));
        await first.WaitAsync(Patience, Cancelled);
        Assert.Equal(Token, router.SessionToken);
        Assert.Equal(RequestHeaderOf(1), transport.Envelopes[0].Header);

        // the end announced loses it
        var second = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(FailureOf(3, ProtocolCode.SessionRequired, Credential.None));

        var ended = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return second.WaitAsync(Patience, Cancelled);
        });

        await scripted.Settle();
        Assert.Equal((ushort)ProtocolCode.SessionRequired, ended.Code);
        Assert.Null(router.SessionToken);

        // one announced before the connection closed is lost with it
        transport.Deliver(ResultOf(98, Token));
        transport.CloseConnection();
        await scripted.Settle();
        Assert.Null(router.SessionToken);
        Assert.All(transport.Envelopes, (envelope) =>
        {
            Assert.Null(Assert.IsType<RequestHeader>(envelope.Header).Credential);
        });
    }

    [Fact]
    public async Task Writes_the_destination_a_request_names_refuses_a_destination_of_0_and_writes_none_left_null()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);

        _ = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { DestinationId = 7 }));
        _ = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { DestinationId = null }));
        await Assert.ThrowsAnyAsync<ArgumentException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { DestinationId = 0 }))
                .WaitAsync(Patience, Cancelled);
        });
        await scripted.Settle();
        Assert.Equal(
            [RequestHeaderOf(1) with { DestinationId = 7 }, RequestHeaderOf(3)],
            transport.Envelopes.Select((envelope) =>
            {
                return envelope.Header;
            }));
    }

    [Fact]
    public async Task Requests_are_held_to_the_limits_the_router_is_built_with_which_must_hold_together_and_show_them()
    {
        var limits = RouterLimits.Default with { MaximumPayloadBytes = 8 };

        using var scripted = new ScriptedRouter(limits);
        var (router, transport) = (scripted.Router, scripted.Transport);

        Assert.Equal(limits, router.Limits);

        var heard = new List<string>();

        // what hears the request handed to the transport, each of its own
        RouterRequest Heard(int length)
        {
            return RequestOf() with
            {
                OnSent = (isHanded) =>
                {
                    lock (heard)
                    {
                        heard.Add($"{length} {isHanded}");
                    }
                },
            };
        }

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return router.Request(new byte[9], Heard(9)).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code);
        Assert.Equal("a payload is 8 bytes at most, not 9", failure.Detail);
        Assert.Empty(transport.Sent);

        // what hears the request handed to the transport hears it as it goes, before any answer
        var asking = router.Request(new byte[1], Heard(1));

        await scripted.Settle();
        Assert.Equal(["1 True"], heard);
        transport.Deliver(ResultOf(transport.Envelopes[0].Header.CallId));
        await asking.WaitAsync(Patience, Cancelled);

        // limits that do not hold together build no router, and leave the transport as it was
        var listeners = transport.Listeners;

        Assert.Throws<ArgumentException>(() =>
        {
            return new RouterClient(transport, new RouterClientOptions { Limits = RouterLimits.Default with { ChunkBytes = 63 } });
        });
        Assert.Equal(listeners, transport.Listeners);
    }

    [Fact]
    public async Task Triggers_the_notification_whose_subscription_opened_their_call_one_ahead_of_its_result_included()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var activity = new List<RouterActivity>();

        router.Activity += activity.Add;
        await router.RegisterNotification(notification).WaitAsync(Patience, Cancelled);
        Assert.True(router.HasNotification(notification));

        // another of the same procedure is not it
        Assert.False(router.HasNotification(new ScriptedNotification(Service)));

        var subscribing = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(notification));

        // the notification that doubles its result, ahead of it: the call is bound already
        transport.Deliver(NotificationOf(1, 5));
        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1, 6));
        await scripted.Settle();
        Assert.Equal([5, 6], notification.Triggered);
        Assert.Equal([RouterActivity.Request, RouterActivity.Notification, RouterActivity.Response, RouterActivity.Notification], activity);

        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        Assert.False(router.HasNotification(notification));
    }

    [Fact]
    public async Task An_ordinary_request_to_the_procedure_never_moves_the_subscription()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);

        var ordinary = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(ResultOf(3));
        await ordinary.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal([5], notification.Triggered);
    }

    [Fact]
    public async Task A_subscription_refused_lets_go_of_its_call_id_one_that_times_out_is_cancelled_its_call_id_reserved_a_while()
    {
        var time = new FakeTimeProvider();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var given = TimeSpan.FromMilliseconds(10);

        var refused = await scripted.Subscribe(notification);

        transport.Deliver(FailureOf(1, ProtocolCode.AccessDenied));

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return refused.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.AccessDenied, failure.Code);

        var timingOut = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(notification, Options with { Timeout = given }));

        await scripted.Settle();
        time.Advance(given);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timingOut.WaitAsync(Patience, Cancelled);
        });
        transport.Deliver(NotificationOf(1));
        transport.Deliver(NotificationOf(3));
        await scripted.Settle();
        Assert.Empty(notification.Triggered);
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown)], CodesOf(scripted.Errors));
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Request, 3u), (EnvelopeKind.Cancel, 3u)], transport.Calls);

        time.Advance(given);
        await scripted.Settle();
        transport.Deliver(NotificationOf(3));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown), nameof(ProtocolCode.SubscriptionUnknown)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Binds_no_notification_the_router_does_not_hold_for_the_procedure()
    {
        using var scripted = new ScriptedRouter();
        var router = scripted.Router;
        var held = new ScriptedNotification(Service);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(held)).WaitAsync(Patience, Cancelled);
        });
        await router.RegisterNotification(held).WaitAsync(Patience, Cancelled);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(new ScriptedNotification(Service))).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, new RouterRequest(Service with { ProcedureId = 9 }, Options) { Subscribes = held })
                .WaitAsync(Patience, Cancelled);
        });
        await scripted.Settle();
        Assert.Empty(scripted.Transport.Sent);
    }

    // spec 11.7, 12.9.2 and 12.9.3
    [Fact]
    public async Task Keeps_the_call_id_of_a_subscription_let_go_of_a_while_silent_on_what_comes_under_it_then_reports_it()
    {
        var time = new FakeTimeProvider();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var given = TimeSpan.FromMilliseconds(20);
        var ending = FailureOf(1, ProtocolCode.SessionRequired, Credential.None);

        var subscribing = await scripted.Subscribe(notification, Options with { Timeout = given });

        transport.Deliver(ResultOf(1, Token));
        await subscribing.WaitAsync(Patience, Cancelled);
        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);

        // on its way when it was let go of: dropped in silence, and so is the failure that ends it,
        // whose end of session is learned all the same
        transport.Deliver(NotificationOf(1));
        transport.Deliver(ending);
        await scripted.Settle();
        Assert.Empty(scripted.Errors);
        Assert.Null(router.SessionToken);

        time.Advance(given);
        await scripted.Settle();
        transport.Deliver(NotificationOf(1));
        transport.Deliver(ending);
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown), nameof(ProtocolCode.CallUnknown)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task A_subscription_that_waits_without_end_let_go_of_is_cancelled_and_its_call_id_reserved_5_s_or_until_the_connection_closes()
    {
        var time = new RecordingTime();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(notification, Options with { Timeout = Timeout.InfiniteTimeSpan });

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        await scripted.Settle();

        var armed = time.Timers.Count;

        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal(
            [TimeSpan.FromSeconds(5)],
            time.Timers.Skip(armed).Select((timer) =>
            {
                return timer.DueTime;
            }));
        Assert.Empty(scripted.Errors);

        transport.CloseConnection();
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown)], CodesOf(scripted.Errors));
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u)], transport.Calls);
    }

    [Fact]
    public async Task A_notification_let_go_of_is_cancelled_unless_its_subscription_was_taken_away_already_and_only_when_bound()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        async Task Subscribe(uint callId)
        {
            var subscribing = await scripted.Subscribe(notification);

            transport.Deliver(ResultOf(callId));
            await subscribing.WaitAsync(Patience, Cancelled);
        }

        await Subscribe(1);
        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        await Subscribe(3);
        await router.UnregisterNotification(notification, cancel: false).WaitAsync(Patience, Cancelled);

        // registered but bound to no call, and another's of the same procedure
        await router.RegisterNotification(notification).WaitAsync(Patience, Cancelled);
        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        await router.UnregisterNotification(new ScriptedNotification(Service)).WaitAsync(Patience, Cancelled);

        // what was on its way to either call id says nothing
        transport.Deliver(NotificationOf(1));
        transport.Deliver(NotificationOf(3));
        await scripted.Settle();
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u), (EnvelopeKind.Request, 3u)], transport.Calls);
        Assert.Empty(scripted.Errors);
    }

    [Fact]
    public async Task A_second_subscription_of_the_same_notification_cancels_the_call_of_the_first()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        await router.RegisterNotification(notification).WaitAsync(Patience, Cancelled);

        foreach (var callId in new uint[] { 1, 3 })
        {
            var subscribing = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(notification));

            transport.Deliver(ResultOf(callId));
            await subscribing.WaitAsync(Patience, Cancelled);
        }

        transport.Deliver(NotificationOf(1));
        transport.Deliver(NotificationOf(3));
        await scripted.Settle();
        Assert.Equal([5], notification.Triggered);
        Assert.Empty(scripted.Errors);

        // the server is told before the second goes out, so the second is the one it keeps
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Cancel, 1u), (EnvelopeKind.Request, 3u)], transport.Calls);
    }

    [Fact]
    public async Task Takes_away_only_the_notification_that_asks_not_another_of_its_procedure()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var held = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(held);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        await router.UnregisterNotification(new ScriptedNotification(Service)).WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.True(router.HasNotification(held));
        Assert.Equal([5], held.Triggered);
    }

    // spec 11.7 and 12.9.3
    [Fact]
    public async Task Reports_a_notification_under_no_subscription_and_one_whose_callback_throws()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var throwing = new ScriptedNotification(Service)
        {
            Callbacks = () =>
            {
                throw new InvalidOperationException("callback failed");
            },
        };
        var activity = new List<RouterActivity>();

        scripted.Router.Activity += activity.Add;
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();

        var subscribing = await scripted.Subscribe(throwing);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown), "callback failed"], CodesOf(scripted.Errors));
        Assert.Equal("no subscription under call 1", Assert.IsType<FailureException>(scripted.Errors[0]).Detail);

        // the first, under no subscription, is not told as activity; the second is, though its
        // trigger threw: this side triggers off its router's loop, so it tells a notification as it
        // arrives, where the TypeScript side tells none for a trigger that throws (0007)
        Assert.Single(activity, (what) =>
        {
            return what == RouterActivity.Notification;
        });
    }

    // spec 12.9.2
    [Fact]
    public async Task A_failure_after_its_result_ends_the_subscription_no_call_unknown_the_notification_told_the_next_registration_asks_anew()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1, Token));
        await subscribing.WaitAsync(Patience, Cancelled);

        // the session ended: the server ends the subscription, and announces the end; one on its way
        // behind it is dropped in silence
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired, Credential.None));
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Empty(scripted.Errors);

        // told what ended it
        Assert.Equal(
            [(ushort)ProtocolCode.SessionRequired],
            notification.Dropped.Select((failure) =>
            {
                return failure?.Code;
            }));
        Assert.Empty(notification.Triggered);
        Assert.Null(router.SessionToken);
        Assert.False(router.HasNotification(notification));

        // registered again, it subscribes with a request of its own
        var again = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(3));
        await again.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(3));
        await scripted.Settle();
        Assert.Equal([5], notification.Triggered);
        Assert.Equal([(EnvelopeKind.Request, 1u), (EnvelopeKind.Request, 3u)], transport.Calls);

        // a failure on no subscription answers nothing
        transport.Deliver(FailureOf(9, ProtocolCode.SessionRequired));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.CallUnknown)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task A_drop_that_throws_when_a_failure_ends_its_subscription_is_reported()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var failure = new InvalidOperationException("drop bug");
        var notification = new ScriptedNotification(Service)
        {
            OnDrop = (_) =>
            {
                throw failure;
            },
        };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        await scripted.Settle();
        Assert.Same(failure, Assert.Single(scripted.Errors));
    }

    [Fact]
    public async Task Refuses_a_second_notification_for_one_procedure()
    {
        using var scripted = new ScriptedRouter();
        var router = scripted.Router;

        await router.RegisterNotification(new ScriptedNotification(Service)).WaitAsync(Patience, Cancelled);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.RegisterNotification(new ScriptedNotification(Service)).WaitAsync(Patience, Cancelled);
        });
    }

    [Fact]
    public async Task Cannot_notify_nor_subscribe_a_connection_only_a_server_does()
    {
        using var scripted = new ScriptedRouter();
        var router = scripted.Router;

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Notify(ReadOnlyMemory<byte>.Empty, new NotifyRequest { Procedure = Service.Address }).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Notify(new FormatException("unwritten"), new NotifyRequest { Procedure = Service.Address }).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Subscribe(new AnswerTarget(RouterClient.ServerConnectionHandle, RequestHeaderOf(2))).WaitAsync(Patience, Cancelled);
        });
    }

    // spec 11.7.3
    [Fact]
    public async Task Forgets_each_notification_when_its_connection_closes_or_it_is_disposed_and_tells_it()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var closed = new ScriptedNotification(Service);
        var disposed = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(closed);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.CloseConnection();
        await scripted.Settle();
        Assert.Null(Assert.Single(closed.Dropped));
        Assert.False(router.HasNotification(closed));

        // nothing is bound any more: what comes under the old call id is reported
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown)], CodesOf(scripted.Errors));

        await router.RegisterNotification(disposed).WaitAsync(Patience, Cancelled);
        router.Dispose();
        await scripted.Settle();
        Assert.Single(closed.Dropped);
        Assert.Null(Assert.Single(disposed.Dropped));
        Assert.False(router.HasNotification(disposed));
    }

    [Fact]
    public async Task Clears_the_timers_of_its_reservations_with_the_connection()
    {
        var time = new RecordingTime();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);

        var subscribing = await scripted.Subscribe(notification, Options with { Timeout = TimeSpan.FromMilliseconds(20) });

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        await scripted.Settle();

        var armed = time.Timers.Count;

        await router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        transport.CloseConnection();
        await scripted.Settle();
        Assert.True(Assert.Single(time.Timers.Skip(armed)).IsDisposed);
    }

    [Fact]
    public async Task Drops_every_notification_though_one_of_them_throws_and_keeps_what_a_drop_registers_again()
    {
        using var scripted = new ScriptedRouter();
        var router = scripted.Router;
        var failure = new InvalidOperationException("drop bug");
        var again = new ScriptedNotification(Service);
        var reregistering = new ScriptedNotification(Service with { ProcedureId = 7 })
        {
            OnDrop = (reason) =>
            {
                _ = router.RegisterNotification(again);
            },
        };

        await router.RegisterNotification(new ScriptedNotification(Service)
        {
            OnDrop = (_) =>
            {
                throw failure;
            },
        }).WaitAsync(Patience, Cancelled);
        await router.RegisterNotification(reregistering).WaitAsync(Patience, Cancelled);
        scripted.Transport.CloseConnection();
        await scripted.Settle();
        Assert.Same(failure, Assert.Single(scripted.Errors));
        Assert.True(router.HasNotification(again));
        Assert.False(router.HasNotification(reregistering));
    }

    // spec 11.11
    [Fact]
    public async Task Opens_its_window_once_subscribed_and_renews_it_once_half_a_window_settled()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 4, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        await scripted.Settle();
        Assert.Equal([4], transport.Credits);

        foreach (var value in new byte[] { 1, 2, 3, 4 })
        {
            transport.Deliver(NotificationOf(1, value));
        }

        await scripted.Settle();
        await scripted.Done(notification, 0);
        Assert.Equal([4], transport.Credits);

        await scripted.Done(notification, 1);
        Assert.Equal([4, 6], transport.Credits);

        // settled out of order, counted all the same
        await scripted.Done(notification, 3);
        await scripted.Done(notification, 2);
        Assert.Equal([4, 6, 8], transport.Credits);
    }

    // spec 11.11
    [Fact]
    public async Task Credits_a_notification_ahead_of_its_result_and_its_window_after_no_further_than_it_reaches()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 2, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        await scripted.Done(notification, 0);
        Assert.Equal([3], transport.Credits);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        await scripted.Settle();
        Assert.Equal([3], transport.Credits);
    }

    [Fact]
    public async Task Counts_done_a_notification_whose_callback_threw_or_rejected_and_reports_why()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 1, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        notification.Held[0].SetResult([new InvalidOperationException("callback failed"), new InvalidOperationException("another failed")]);
        await scripted.Settle();
        Assert.Equal(["callback failed", "another failed"], CodesOf(scripted.Errors));
        Assert.Equal([2], transport.Credits);

        notification.Callbacks = () =>
        {
            throw new FormatException("decoded nothing");
        };
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.Equal(["callback failed", "another failed", "decoded nothing"], CodesOf(scripted.Errors));
        Assert.Equal([2, 3], transport.Credits);

        // callbacks cancelled are done too, and said so
        notification.Callbacks = () =>
        {
            return Task.FromCanceled<IReadOnlyList<Exception>>(new CancellationToken(true));
        };
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        Assert.IsType<TaskCanceledException>(scripted.Errors[^1]);
        Assert.Equal([2, 3, 4], transport.Credits);
    }

    [Fact]
    public async Task Credits_nothing_for_a_subscription_let_go_of_while_its_callbacks_ran()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 1, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        await scripted.Router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);
        await scripted.Done(notification, 0);
        Assert.Empty(transport.Credits);
        Assert.Equal(EnvelopeKind.Cancel, transport.Envelopes[^1].Kind);
    }

    [Fact]
    public async Task Opens_no_window_for_a_subscription_the_server_ended_in_the_read_of_its_result()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 4, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        // delivered in one turn of the router's scheduler, as one read brings both
        await scripted.Router.Core.Loop.Run(() =>
        {
            transport.Deliver(ResultOf(1));
            transport.Deliver(FailureOf(1, ProtocolCode.CapacityExceeded));

            return Task.CompletedTask;
        }).WaitAsync(Patience, Cancelled);
        await subscribing.WaitAsync(Patience, Cancelled);
        await scripted.Settle();
        Assert.Empty(transport.Credits);
        Assert.Empty(scripted.Errors);
    }

    [Fact]
    public async Task Reports_a_credit_that_cannot_go_out()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { Window = 1, IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        transport.Refusal = new IOException("gone");
        await scripted.Done(notification, 0);
        Assert.Equal([2], transport.Credits);
        Assert.Equal(["gone"], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Credits_nothing_for_a_subscription_that_did_not_ask_and_reports_its_callbacks_rejections_all_the_same()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service) { IsHeld = true };

        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        await scripted.Settle();
        notification.Held[0].SetResult([new InvalidOperationException("callback failed")]);
        await scripted.Settle();
        Assert.False(Assert.IsType<RequestHeader>(transport.Envelopes[0].Header).Paced);
        Assert.Empty(transport.Credits);
        Assert.Equal(["callback failed"], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Presents_OPAQUE_the_session_it_learned_on_a_call_that_asks_and_on_no_other_one_that_asks_before_any_session_fails_before_it_goes_SESSION_REQUIRED()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);

        async Task<FailureException> Refused()
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { Credential = Credential.Opaque() }))
                    .WaitAsync(Patience, Cancelled);
            });
        }

        var before = await Refused();

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (before.Code, before.Origin));
        Assert.Empty(transport.Sent);

        // learned, it goes on a call that asks, and on no other
        transport.Deliver(ResultOf(99, Token));
        await scripted.Settle();
        _ = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { Credential = Credential.Opaque() }));
        _ = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());
        _ = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(options: Options with { Credential = Credential.None }));
        await scripted.Settle();

        Assert.Equal(
            [(1u, Credential.Opaque(Token)), (3u, null), (5u, null)],
            transport.Envelopes.Select((envelope) =>
            {
                return (envelope.Header.CallId, Assert.IsType<RequestHeader>(envelope.Header).Credential);
            }));

        // once it ended, a call that asks fails before it goes again
        transport.Deliver(ResultOf(98, Credential.None));
        await scripted.Settle();

        var ended = await Refused();

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (ended.Code, ended.Origin));
        Assert.Equal(3, transport.Sent.Count);
    }

    [Fact]
    public async Task The_server_s_requests_resolve_their_credential_as_a_server_does_none_and_the_session_it_learned_run_in_it_another_token_is_refused_SESSION_REQUIRED_a_JWT_CREDENTIAL_UNSUPPORTED()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var sessions = new List<(uint CallId, bool IsInSession)>();

        router.RegisterResolver(new ScriptedResolver(Service, (props) =>
        {
            sessions.Add((props.Header.CallId, props.Session is not null));

            return router.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header));
        }));

        // none runs in none while it learned none, and an OPAQUE does not hold
        transport.Deliver(new Envelope { Header = RequestHeaderOf(2), Payload = new byte[] { 1 } });
        transport.Deliver(new Envelope { Header = RequestHeaderOf(4) with { Credential = Token }, Payload = new byte[] { 1 } });
        await scripted.Settle();

        // learned, none and its token run in it; another token does not hold, and a JWT is a
        // scheme it takes none of
        transport.Deliver(ResultOf(99, Token));
        transport.Deliver(new Envelope { Header = RequestHeaderOf(6), Payload = new byte[] { 1 } });
        transport.Deliver(new Envelope { Header = RequestHeaderOf(8) with { Credential = Token }, Payload = new byte[] { 1 } });
        transport.Deliver(new Envelope { Header = RequestHeaderOf(10) with { Credential = SessionToken.Parse("AQIDBAUGBwgJCgsMDQ4PEA") }, Payload = new byte[] { 1 } });
        transport.Deliver(new Envelope { Header = RequestHeaderOf(12) with { Credential = Credential.Jwt("a.b.c") }, Payload = new byte[] { 1 } });
        await scripted.Settle();

        Assert.Equal([(2u, false), (6u, true), (8u, true)], sessions);
        Assert.Equal(
            [(4u, ProtocolCode.SessionRequired), (10u, ProtocolCode.SessionRequired), (12u, ProtocolCode.CredentialUnsupported)],
            transport.Failures);

        // a client announces nothing
        Assert.All(transport.Envelopes, (envelope) =>
        {
            Assert.True(envelope.Header is ResultHeader { Credential: null } or FailureHeader { Credential: null });
        });
    }

    [Fact]
    public async Task The_server_s_requests_cancelled_by_the_server_abort_their_resolver_s_signal_and_are_answered_by_nothing()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var cancelled = new List<uint>();

        router.RegisterResolver(new ScriptedResolver(Service, (props) =>
        {
            var stopped = new TaskCompletionSource();

            props.Signal.Register(() =>
            {
                cancelled.Add(props.Header.CallId);

                // an answer from what hears the signal finds no call to answer
                _ = router.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(props.ConnectionHandle, props.Header));
                stopped.SetException(new InvalidOperationException("stopped"));
            });

            return stopped.Task;
        }));
        transport.Deliver(new Envelope { Header = RequestHeaderOf(30), Payload = new byte[] { 3 } });
        transport.Deliver(new Envelope { Header = new CancelHeader { CallId = 30 } });
        await scripted.Settle();
        Assert.Equal([30u], cancelled);
        Assert.Empty(transport.Sent);
        Assert.Empty(scripted.Errors);
    }

    [Fact]
    public async Task Answers_CAPACITY_EXCEEDED_a_command_past_the_calls_its_server_has_it_answer()
    {
        using var scripted = new ScriptedRouter(RouterLimits.Default with { MaximumAnsweringCalls = 2 });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var held = new List<RequestResolverProps>();

        router.RegisterResolver(new ScriptedResolver(Service, (props) =>
        {
            held.Add(props);

            return Task.CompletedTask;
        }));

        foreach (var callId in new uint[] { 30, 32, 34 })
        {
            transport.Deliver(new Envelope { Header = RequestHeaderOf(callId) });
        }

        await scripted.Settle();
        Assert.Equal(2, held.Count);
        Assert.Equal([(34u, ProtocolCode.CapacityExceeded)], transport.Failures);

        // one answered, the next is taken
        await router.Respond(RouterAnswer.OfPayload(new byte[] { 1 }), new AnswerTarget(held[0].ConnectionHandle, held[0].Header));
        transport.Deliver(new Envelope { Header = RequestHeaderOf(36) });
        await scripted.Settle();
        Assert.Equal(3, held.Count);
        Assert.Empty(scripted.Errors);
    }

    [Fact]
    public async Task The_server_s_requests_of_the_client_s_own_parity_are_reported_and_never_answered()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;

        scripted.Router.RegisterResolver(new ScriptedResolver(Service, (_) =>
        {
            return Task.CompletedTask;
        }));
        transport.Deliver(new Envelope { Header = RequestHeaderOf(31) });
        await scripted.Settle();
        Assert.Empty(transport.Sent);
        Assert.Equal([nameof(ProtocolCode.EnvelopeMalformed)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task The_server_s_requests_for_a_service_a_procedure_or_a_destination_it_does_not_know_are_refused_with_the_client_s_failures()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;

        // read before the service has a resolver
        transport.Deliver(new Envelope { Header = RequestHeaderOf(2) });
        await scripted.Settle();
        scripted.Router.RegisterResolver(new ScriptedResolver(Service with { ProcedureId = 9 }, (_) =>
        {
            return Task.CompletedTask;
        }));
        transport.Deliver(new Envelope { Header = RequestHeaderOf(4) });
        transport.Deliver(new Envelope { Header = RequestHeaderOf(6) with { DestinationId = 5 } });
        await scripted.Settle();
        Assert.Equal(
            [(2u, ProtocolCode.ServiceUnknown), (4u, ProtocolCode.ProcedureUnknown), (6u, ProtocolCode.DestinationUnknown)],
            transport.Failures);
        Assert.Equal(3, transport.Sent.Count);
    }

    [Fact]
    public async Task Reports_a_resolver_that_rejects_and_an_answer_the_transport_cannot_send()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var failure = new InvalidOperationException("resolver failed");
        var refusal = new IOException("not open");

        scripted.Router.RegisterResolver(new ScriptedResolver(Service, (_) =>
        {
            return Task.FromException(failure);
        }));

        // each settled before the next, so what is reported comes in the order they were read
        transport.Deliver(new Envelope { Header = RequestHeaderOf(2) });
        await scripted.Settle();
        transport.Refusal = refusal;
        transport.Deliver(new Envelope { Header = RequestHeaderOf(4) });
        await scripted.Settle();
        transport.Deliver(new Envelope { Header = RequestHeaderOf(6) with { ServiceId = 99 } });
        await scripted.Settle();

        // each failed resolver answered PROCEDURE_FAILED, the one the transport refused reported too
        Assert.Equal([failure, failure, refusal, refusal], scripted.Errors);
        Assert.Equal(
            [(2u, ProtocolCode.ProcedureFailed), (4u, ProtocolCode.ProcedureFailed), (6u, ProtocolCode.ServiceUnknown)],
            transport.Failures);
    }

    [Fact]
    public async Task Reports_a_resolver_that_throws_before_it_returns_and_keeps_taking_envelopes()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;
        var failure = new InvalidOperationException("thrown at once");

        scripted.Router.RegisterResolver(new ScriptedResolver(Service, (_) =>
        {
            throw failure;
        }));

        Assert.Null(Record.Exception(() =>
        {
            transport.Deliver(new Envelope { Header = RequestHeaderOf(2) });
        }));
        await scripted.Settle();
        transport.Deliver(OfAnUnknownKind);
        await scripted.Settle();
        Assert.Same(failure, scripted.Errors[0]);
        Assert.Equal(["thrown at once", nameof(ProtocolCode.KindUnsupported)], CodesOf(scripted.Errors));
    }

    [Fact]
    public async Task Reports_bytes_that_are_not_an_envelope_and_an_envelope_of_a_kind_it_does_not_take()
    {
        using var scripted = new ScriptedRouter();
        var transport = scripted.Transport;

        transport.DeliverText("text"u8.ToArray());
        transport.Deliver(NotAnEnvelope);
        transport.Deliver(OfAnUnknownKind);
        await scripted.Settle();
        Assert.Equal(
            [nameof(ProtocolCode.EnvelopeMalformed), nameof(ProtocolCode.EnvelopeMalformed), nameof(ProtocolCode.KindUnsupported)],
            CodesOf(scripted.Errors));
        Assert.Contains("not a string", Assert.IsType<FailureException>(scripted.Errors[0]).Detail, StringComparison.Ordinal);
    }

    // debugging 5.1
    [Fact]
    public async Task Tells_each_envelope_out_and_in_with_its_connection_server_its_header_and_never_its_session_token()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var seen = new List<(DebugDirection Direction, TracedEnvelope Envelope)>();

        router.Debug += (direction, envelope) =>
        {
            seen.Add((direction, envelope));
        };

        var answering = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(ResultOf(1, Token));
        Assert.Equal(1u, (await answering.WaitAsync(Patience, Cancelled)).Header.CallId);
        await scripted.Settle();

        // on its one connection, the server, the session announced traced by its scheme alone
        Assert.Equal(
            [
                (DebugDirection.Tx, new TracedEnvelope(RouterClient.ServerConnectionHandle, RequestHeaderOf(1))),
                (DebugDirection.Rx, new TracedEnvelope(RouterClient.ServerConnectionHandle, new ResultHeader { CallId = 1, Credential = Credential.Opaque() })),
            ],
            seen);
    }

    // debugging 4.4
    [Fact]
    public async Task Tells_a_call_s_steps_with_the_call_id_its_REQUEST_carries()
    {
        // a payload past 1,000 bytes goes as a transfer
        using var scripted = new ScriptedRouter(new RouterLimits { ChunkBytes = 1_000, MaximumEnvelopeBytes = 1_000, WindowBytes = 2_000 });
        var (router, transport) = (scripted.Router, scripted.Transport);
        var services = new ServiceManager(router);
        var asking = services.GetRequest(Service, new RequestDependencies<string, string> { Serializer = Text });
        var envelopes = new List<(DebugDirection Direction, EnvelopeKind Kind, uint CallId, bool IsTransfer)>();
        var steps = new List<(DebugDirection Direction, uint? CallId)>();

        router.Debug += (direction, envelope) =>
        {
            lock (envelopes)
            {
                envelopes.Add((direction, envelope.Header.Kind, envelope.Header.CallId, envelope.Header is RequestHeader { Total: not null }));
            }
        };
        services.Debug += (_, told) =>
        {
            lock (steps)
            {
                steps.Add((told.Direction, told.CallId));
            }
        };

        var whole = asking("a")();

        transport.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = Text.Encode("b") });
        Assert.Equal("b", await whole.WaitAsync(Patience, Cancelled));

        // its opening carries its call id as a whole request does; the server refuses it there
        var opening = asking(new string('x', 3_000))();

        transport.Deliver(FailureOf(3, ProtocolCode.SessionRequired));
        Assert.Equal((ushort)ProtocolCode.SessionRequired, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return opening.WaitAsync(Patience, Cancelled);
        })).Code);
        await scripted.Settle();

        // * each trace in its own order: no order between a step and its envelope
        Assert.Equal(
            [
                (DebugDirection.Tx, EnvelopeKind.Request, 1u, false),
                (DebugDirection.Rx, EnvelopeKind.Result, 1u, false),
                (DebugDirection.Tx, EnvelopeKind.Request, 3u, true),
                (DebugDirection.Rx, EnvelopeKind.Failure, 3u, false),
            ],
            envelopes);
        Assert.Equal<(DebugDirection, uint?)>(
            [(DebugDirection.Tx, 1), (DebugDirection.Rx, 1), (DebugDirection.Tx, 3), (DebugDirection.Rx, 3)],
            steps);
    }

    // debugging 4.4
    [Fact]
    public async Task Two_calls_to_one_procedure_started_in_one_millisecond_and_answered_in_one_batch_name_each_its_own_call_id()
    {
        var start = DateTimeOffset.FromUnixTimeMilliseconds(1_767_225_600_000);

        // a clock that does not move
        using var scripted = new ScriptedRouter(clock: new FakeTimeProvider(start));
        var (router, transport) = (scripted.Router, scripted.Transport);
        var services = new ServiceManager(router);
        var asking = services.GetRequest(Service, new RequestDependencies<string, string> { Serializer = Text });
        var steps = new List<(DebugDirection Direction, uint? CallId, DateTimeOffset StartedAt, object? Seen)>();

        services.Debug += (_, told) =>
        {
            lock (steps)
            {
                steps.Add((told.Direction, told.CallId, told.StartedAt, told.Direction == DebugDirection.Tx ? told.Tx : told.Rx));
            }
        };

        var first = asking("a")();
        var second = asking("b")();

        // one batch, the second call's answer first
        transport.Deliver(new Envelope { Header = new ResultHeader { CallId = 3 }, Payload = Text.Encode("answers b") });
        transport.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = Text.Encode("answers a") });

        Assert.Equal(["answers a", "answers b"], await Task.WhenAll(first, second).WaitAsync(Patience, Cancelled));

        // * this side tells calls made from one thread in no order among themselves: each by its id
        IEnumerable<(DebugDirection, uint?, DateTimeOffset, object?)> Told(DebugDirection direction)
        {
            return steps
                .Where((step) =>
                {
                    return step.Direction == direction;
                })
                .OrderBy((step) =>
                {
                    return step.CallId;
                })
                .Select((step) =>
                {
                    return (step.Direction, step.CallId, step.StartedAt, step.Seen);
                });
        }

        Assert.Equal<(DebugDirection, uint?, DateTimeOffset, object?)>(
            [(DebugDirection.Tx, 1, start, "a"), (DebugDirection.Tx, 3, start, "b")],
            Told(DebugDirection.Tx));
        Assert.Equal<(DebugDirection, uint?, DateTimeOffset, object?)>(
            [(DebugDirection.Rx, 1, start, "answers a"), (DebugDirection.Rx, 3, start, "answers b")],
            Told(DebugDirection.Rx));
    }

    // debugging 4.4
    [Fact]
    public async Task A_subscribing_call_binds_its_subscription_before_debug_hears_its_tx_step()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var services = new ServiceManager(router);
        var notification = services.GetNotification(Service, new NotificationDependencies<string, string, string> { Serializer = Text });
        var heard = new List<string>();
        var told = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // a notification right behind its result, delivered as the tx step is told
        services.Debug += (_, step) =>
        {
            if (step is { Direction: DebugDirection.Tx, Type: DebugType.Request, CallId: { } callId })
            {
                transport.Deliver(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = Text.Encode("first news") });
                told.TrySetResult();
            }
        };

        var registering = notification.Register("subscribe", (news) =>
        {
            lock (heard)
            {
                heard.Add(news);
            }

            return Task.CompletedTask;
        })();

        // its result once its tx step was told, its request on its way by then: the registration
        // asks it from another thread, which settling the router does not wait for
        await told.Task.WaitAsync(Patience, Cancelled);
        transport.Deliver(ResultOf(1));
        await using var registration = await registering.WaitAsync(Patience, Cancelled);
        await scripted.Settle();

        Assert.Equal(["first news"], heard);
        Assert.Empty(scripted.Errors);
    }

    // the C# side's alone: one thread runs the TypeScript side, which has no scheduler to stay off
    [Fact]
    public async Task Tells_a_call_s_tx_step_off_its_router_s_scheduler()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var services = new ServiceManager(router);
        var told = new List<(bool IsOnScheduler, bool IsAnswered)>();

        using var answered = new ManualResetEventSlim();

        // its answer, as the router takes it, on its scheduler
        router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Rx && envelope.Header is ResultHeader)
            {
                answered.Set();
            }
        };

        // * a listener that blocks until its call's answer came: on the router's scheduler, the
        // answer would wait behind it, and it would wait in vain
        services.Debug += (_, step) =>
        {
            if (step is { Direction: DebugDirection.Tx, CallId: { } callId })
            {
                var isOnScheduler = router.Core.Loop.IsCurrent;

                transport.Deliver(new Envelope { Header = new ResultHeader { CallId = callId }, Payload = Text.Encode("b") });

                var isAnswered = answered.Wait(Patience);

                lock (told)
                {
                    told.Add((isOnScheduler, isAnswered));
                }
            }
        };

        Assert.Equal(
            "b",
            await services.GetRequest(Service, new RequestDependencies<string, string> { Serializer = Text })("a")().WaitAsync(Patience, Cancelled));
        Assert.Equal([(false, true)], told);
    }

    [Fact]
    public async Task Dispose_lets_go_of_the_transport_rejects_what_still_waits_and_sends_nothing_more()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);

        var waiting = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        await scripted.Settle();
        router.Dispose();
        transport.Deliver(ResultOf(1));
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf()).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return router.Respond(
                RouterAnswer.OfPayload(ReadOnlyMemory<byte>.Empty),
                new AnswerTarget(RouterClient.ServerConnectionHandle, RequestHeaderOf(2))).WaitAsync(Patience, Cancelled);
        });
        await scripted.Settle();

        // the one request that went before
        Assert.Single(transport.Sent);
        Assert.Empty(scripted.Errors);
        Assert.Equal(0, transport.Listeners);
    }

    // a router that records the resolvers registered on it, and does nothing else
    private sealed class Registrations(RouterSide side) : IRouterLike
    {
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public int DetailBytes { get; init; } = LimitDefaults.MaximumDetailBytes;

        public List<string> Names { get; } = [];

        public RouterSide Side
        {
            get
            {
                return side;
            }
        }

        public void RegisterResolver(IRequestResolver resolver)
        {
            Names.Add(resolver.Procedure.ProcedureName);
        }

        public Task Respond(RouterAnswer response, AnswerTarget target)
        {
            return Task.CompletedTask;
        }

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            return Task.FromException<RouterResult>(new InvalidOperationException("nothing is asked here"));
        }

        public ProcedureSeries? DeclareRequester(Procedure procedure)
        {
            return null;
        }

        public void Report(Exception reason, string? connectionHandle)
        {
        }

        public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
        {
            return Task.CompletedTask;
        }

        public Task Notify(Exception unwritten, NotifyRequest request)
        {
            return Task.CompletedTask;
        }

        public Task<uint> Subscribe(AnswerTarget target)
        {
            return Task.FromResult(target.Header.CallId);
        }

        public Failure? AnsweredOf(AnswerTarget target)
        {
            return null;
        }

        public bool HasNotification(INotificationLike notification)
        {
            return false;
        }

        public Task RegisterNotification(INotificationLike notification)
        {
            return Task.CompletedTask;
        }

        public Task UnregisterNotification(INotificationLike notification, bool cancel = true)
        {
            return Task.CompletedTask;
        }
    }

    // a result's payload this client cannot read
    private sealed class Unreadable : IRequestSerializerClient<JsonElement, int>
    {
        public ReadOnlyMemory<byte> Encode(JsonElement request)
        {
            return new JsonPayloads().Encode(request);
        }

        public int Decode(ReadOnlyMemory<byte> response)
        {
            throw new FormatException("not a number this client reads");
        }
    }

    // text in UTF-8, a request, its result and a notification alike
    private sealed class TextPayloads : INotificationSerializerClient<string, string, string>
    {
        public ReadOnlyMemory<byte> Encode(string request)
        {
            return Payloads.WriteText(request);
        }

        public string Decode(ReadOnlyMemory<byte> response)
        {
            return Payloads.ReadText(response);
        }

        public string DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return Payloads.ReadText(notification);
        }
    }

    // a client's transport a test delivers to and closes, which records what it sends, read as the
    // server reads it, and fails its sends once told to
    private sealed class ScriptedTransport : IRouterClientTransport
    {
        private readonly Lock _gate = new();
        private readonly List<ReadOnlyMemory<byte>> _sent = [];
        private readonly List<string?> _carried = [];

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        // what a send fails with, once set: what it was given is recorded all the same
        public Exception? Refusal { get; set; }

        // whether it carries a credential beside an envelope, and is secure: in process, it is both;
        // once told one, it carries that one alone, as a WebSocket carries its upgrade's
        public bool CarriesCredential { get; set; } = true;

        public string? CarriedByUpgrade { get; set; }

        public bool IsSecure { get; set; } = true;

        // what it carried beside each envelope sent, in order
        public List<string?> Carried
        {
            get
            {
                lock (_gate)
                {
                    return [.. _carried];
                }
            }
        }

        public List<ReadOnlyMemory<byte>> Sent
        {
            get
            {
                lock (_gate)
                {
                    return [.. _sent];
                }
            }
        }

        public List<Envelope> Envelopes
        {
            get
            {
                return [.. Sent.Select((bytes) =>
                {
                    return EnvelopeCodec.ReadEnvelope(bytes.Span, new EnvelopeReadOptions { Side = RouterSide.Server })!;
                })];
            }
        }

        // each envelope sent, by its kind and its call id
        public List<(EnvelopeKind Kind, uint CallId)> Calls
        {
            get
            {
                return [.. Envelopes.Select((envelope) =>
                {
                    return (envelope.Kind, envelope.Header.CallId);
                })];
            }
        }

        // the credits sent, as their ends: none for one that does not count notifications
        public List<long?> Credits
        {
            get
            {
                return [.. Envelopes.Select((envelope) =>
                {
                    return envelope.Header;
                }).OfType<CreditHeader>().Select((credit) =>
                {
                    return credit.Paced ? credit.CreditEnd : (long?)null;
                })];
            }
        }

        // the failures sent, by their call id and their code
        public List<(uint CallId, ProtocolCode Code)> Failures
        {
            get
            {
                return [.. Envelopes.Where((envelope) =>
                {
                    return envelope.Failure is not null;
                }).Select((envelope) =>
                {
                    return (envelope.Header.CallId, (ProtocolCode)envelope.Failure!.Code);
                })];
            }
        }

        // how many handlers its events hold
        public int Listeners
        {
            get
            {
                return (Message?.GetInvocationList().Length ?? 0) + (Close?.GetInvocationList().Length ?? 0);
            }
        }

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false));
        }

        public void Deliver(Envelope envelope)
        {
            Deliver(EnvelopeCodec.WriteEnvelope(envelope));
        }

        // an envelope that came by a way that keeps no order with the answers, which it may overtake
        public void Overtaking(Envelope envelope)
        {
            Message?.Invoke(new TransportMessage(EnvelopeCodec.WriteEnvelope(envelope), false) { MayOvertake = true });
        }

        // an envelope, with what the transport carried beside it
        public void Carrying(Envelope envelope, string carried)
        {
            Message?.Invoke(new TransportMessage(EnvelopeCodec.WriteEnvelope(envelope), false) { Credential = carried });
        }

        public void DeliverText(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, true));
        }

        public void CloseConnection()
        {
            Close?.Invoke(false, false);
        }

        public bool Carries(string credential)
        {
            return CarriesCredential && (CarriedByUpgrade is null || CarriedByUpgrade == credential);
        }

        public Task Send(TransportMessage message)
        {
            var bytes = message.Bytes;

            lock (_gate)
            {
                _sent.Add(bytes.ToArray());
                _carried.Add(message.Credential);
            }

            return Refusal is { } refusal ? Task.FromException(refusal) : Task.CompletedTask;
        }
    }

    // a client's router over a scripted transport, its loop and its callbacks on one scheduler a test
    // settles, and the errors it raised; its transport's clock, which the router runs on, moves only
    // when a test moves it, so no call times out and no reservation ends while a test looks
    private sealed class ScriptedRouter : IDisposable
    {
        public ScriptedRouter(RouterLimits? limits = null, TimeProvider? clock = null)
            : this(new RouterClientOptions { Limits = limits, Clock = clock })
        {
        }

        // a router of the options given, on its own scheduler, and on a clock only a test moves
        // unless they give one
        public ScriptedRouter(RouterClientOptions options)
        {
            var scheduler = new SerialScheduler();

            Transport = new ScriptedTransport { Clock = options.Clock ?? new FakeTimeProvider() };
            Router = new RouterClient(
                Transport,
                options with
                {
                    ResolverScheduler = scheduler,
                    Scheduler = scheduler,
                });
            Router.Error += Errors.Add;
        }

        public ScriptedTransport Transport { get; }

        public RouterClient Router { get; }

        public List<Exception> Errors { get; } = [];

        // what the router's scheduler holds, run, and what that queued behind it
        public async Task Settle()
        {
            for (var round = 0; round < 3; round += 1)
            {
                await Router.Core.Loop.WhenIdle().WaitAsync(Patience, Cancelled);
            }
        }

        // a notification registered, and the request that subscribes it gone out: what the test
        // delivers next finds its call bound; the request is awaited for its result
        public async Task<Task<RouterResult>> Subscribe(ScriptedNotification notification, ResolvedRequestOptions? options = null)
        {
            await Router.RegisterNotification(notification).WaitAsync(Patience, Cancelled);

            var subscribing = Router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(notification, options));

            await Settle();

            return subscribing;
        }

        // settles the callbacks of the notification triggered `index`th
        public async Task Done(ScriptedNotification notification, int index)
        {
            notification.Held[index].SetResult([]);
            await Settle();
        }

        public void Dispose()
        {
            Router.Dispose();
        }
    }

    // a notification a test triggers and drops: it records the first byte of each payload and the
    // failure each drop was told; its callbacks settle at once, unless held for the test to settle,
    // and do what the test says once told
    private sealed class ScriptedNotification(Procedure procedure) : INotificationLike
    {
        public Procedure Procedure
        {
            get
            {
                return procedure;
            }
        }

        public int? Window { get; init; }

        public bool IsHeld { get; init; }

        public Func<Task<IReadOnlyList<Exception>>>? Callbacks { get; set; }

        public Action<Failure?>? OnDrop { get; init; }

        public List<byte> Triggered { get; } = [];

        public List<TaskCompletionSource<IReadOnlyList<Exception>>> Held { get; } = [];

        public List<Failure?> Dropped { get; } = [];

        public Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload)
        {
            Triggered.Add(payload.Span[0]);

            if (Callbacks is { } callbacks)
            {
                return callbacks();
            }

            if (!IsHeld)
            {
                return Task.FromResult<IReadOnlyList<Exception>>([]);
            }

            // settled where the test settles it, so the router hears of it in the same turn
            var held = new TaskCompletionSource<IReadOnlyList<Exception>>();

            Held.Add(held);

            return held.Task;
        }

        public void Drop(Failure? failure)
        {
            Dropped.Add(failure);
            OnDrop?.Invoke(failure);
        }
    }

    // a resolver of a procedure, which handles a request as the test says
    private sealed class ScriptedResolver(Procedure procedure, Func<RequestResolverProps, Task> handle) : IRequestResolver
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

        // what its admission refuses every request with; none admits each
        public Failure? Refusal { get; init; }

        public Task Handle(RequestResolverProps props)
        {
            return handle(props);
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return Refusal;
        }
    }

    // a fake clock that keeps each timer made on it: when it was due, and whether it was stopped
    private sealed class RecordingTime : TimeProvider
    {
        private readonly FakeTimeProvider _time = new();
        private readonly Lock _gate = new();
        private readonly List<RecordedTimer> _timers = [];

        public List<RecordedTimer> Timers
        {
            get
            {
                lock (_gate)
                {
                    return [.. _timers];
                }
            }
        }

        public override long TimestampFrequency
        {
            get
            {
                return _time.TimestampFrequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            return _time.GetUtcNow();
        }

        public override long GetTimestamp()
        {
            return _time.GetTimestamp();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new RecordedTimer(_time.CreateTimer(callback, state, dueTime, period), dueTime);

            lock (_gate)
            {
                _timers.Add(timer);
            }

            return timer;
        }
    }

    private sealed class RecordedTimer(ITimer timer, TimeSpan due) : ITimer
    {
        private volatile bool _isDisposed;

        public TimeSpan DueTime
        {
            get
            {
                return due;
            }
        }

        public bool IsDisposed
        {
            get
            {
                return _isDisposed;
            }
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            return timer.Change(dueTime, period);
        }

        public void Dispose()
        {
            _isDisposed = true;
            timer.Dispose();
        }

        public ValueTask DisposeAsync()
        {
            _isDisposed = true;

            return timer.DisposeAsync();
        }
    }

    // a client's router and a server of the interop service, linked in memory
    private sealed class Link : IDisposable
    {
        private readonly ClientEnd _client = new();
        private readonly ServerEnd _server = new();

        // both ends given `registry`, when given: one registry summing the two routers
        public Link(MetricsRegistry? registry = null)
        {
            _client.Peer = _server;
            _server.Peer = _client;
            Client = new RouterClient(_client, new RouterClientOptions { MetricsRegistry = registry });
            Facade = new Server<string>(_server, new ServerOptions { MetricsRegistry = registry });
            AsClient = new ServiceLink.LinkedClient(Client);
            ClientServices = AsClient.Services;
            ServerServices = Facade.Services;
            InteropHandlers.Offer(Facade);
            _server.Open();
            Client.Debug += (direction, envelope) =>
            {
                if (direction == DebugDirection.Rx)
                {
                    lock (ClientReceived)
                    {
                        ClientReceived.Add(envelope.Header);
                    }
                }
            };
        }

        public RouterClient Client { get; }

        public Server<string> Facade { get; }

        public RouterServer Server
        {
            get
            {
                return Facade.Router;
            }
        }

        public ServiceManager ClientServices { get; }

        // the client as a Bead client, its services those above, for the interop's generated client
        public ServiceLink.LinkedClient AsClient { get; }

        public ServiceManager ServerServices { get; }

        public List<IEnvelopeHeader> ClientReceived { get; } = [];

        public void Dispose()
        {
            _server.Closed();
            _client.CloseConnection();
            Facade.DisposeAsync().AsTask().GetAwaiter().GetResult();
            Client.Dispose();
        }

        private sealed class ClientEnd : IRouterClientTransport
        {
            public TimeProvider Clock { get; init; } = TimeProvider.System;

            public event Action<TransportMessage>? Message;

            public event Action<bool, bool>? Close;

            public ServerEnd? Peer { get; set; }

            public void Deliver(ReadOnlyMemory<byte> bytes)
            {
                Message?.Invoke(new TransportMessage(bytes.ToArray(), false));
            }

            public void CloseConnection()
            {
                Close?.Invoke(false, false);
            }

            public Task Send(TransportMessage message)
            {
                var bytes = message.Bytes;

                Peer!.Deliver(bytes);

                return Task.CompletedTask;
            }
        }

        private sealed class ServerEnd : IServerTransport
        {
            public string? Type
            {
                get
                {
                    return TransportTypes.WebSocket;
                }
            }

            public TimeProvider Clock { get; init; } = TimeProvider.System;

            public event Action<string>? Connection;

            public event Action<TransportMessage, string>? Message;

            public event Action<bool, string>? Close;

            public ClientEnd? Peer { get; set; }

            public void Open()
            {
                Connection?.Invoke(Handle);
            }

            public void Deliver(ReadOnlyMemory<byte> bytes)
            {
                Message?.Invoke(new TransportMessage(bytes.ToArray(), false), Handle);
            }

            public void Closed()
            {
                Close?.Invoke(false, Handle);
            }

            public Task<bool> CloseConnection(string connectionHandle)
            {
                return Task.FromResult(false);
            }

            public Task Shutdown()
            {
                return Task.CompletedTask;
            }

            public Task Send(TransportMessage message, string connectionHandle)
            {
                var bytes = message.Bytes;

                Peer!.Deliver(bytes);

                return Task.CompletedTask;
            }
        }
    }

    [Fact]
    public async Task Rejects_every_request_still_waiting_and_forgets_the_session_when_a_reconnection_starts()
    {
        var transport = new ReconnectingTransport();
        var scheduler = new SerialScheduler();

        using var router = new RouterClient(transport, new RouterClientOptions { Scheduler = scheduler, ResolverScheduler = scheduler });

        var services = new ServiceManager(router);
        var first = RequesterOf(services, "echo")(JsonOf("null"))();

        await scheduler.WhenIdle();
        transport.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = 1, Credential = Token }, Payload = "null"u8.ToArray() }));
        await first.WaitAsync(Patience, Cancelled);
        Assert.Equal(Token, router.SessionToken);

        var waiting = RequesterOf(services, "echo")(JsonOf("null"))();

        await scheduler.WhenIdle();
        transport.Replace();

        Assert.Equal("the connection was replaced before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Null(router.SessionToken);
    }

    // a client's transport a test delivers to, and whose connection it replaces, as a reconnection does
    private sealed class ReconnectingTransport : IRouterClientTransport
    {
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<TransportMessage>? Message;

        public event Action? Reconnect;

        // never raised: a connection replaced tells no close
        public event Action<bool, bool>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false));
        }

        public void Replace()
        {
            Reconnect?.Invoke();
        }

        public Task Send(TransportMessage message)
        {
            var bytes = message.Bytes;

            return Task.CompletedTask;
        }
    }
}
