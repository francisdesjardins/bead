using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterClient"/>: against a server of the interop service, linked in memory, and against
/// bytes a test writes as a server would.
/// </summary>
public sealed class RouterClientTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly SessionToken Token = SessionToken.Parse("AAECAwQFBgcICQoLDA0ODw");

    // the procedure the scripted tests ask and subscribe: procedure 1 of service 2
    private static readonly Procedure Service = new() { ServiceId = 2, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 3 };

    private static readonly ResolvedRequestOptions Options = new() { Timeout = TimeSpan.FromSeconds(1) };

    private static readonly byte[] NotAnEnvelope = [0x0a, 0x14];

    // a whole envelope's prefix, of kind 0x17, which no side takes
    private static readonly byte[] OfAnUnknownKind = [0xa1, 0x17, 0, 2, 0, 0, 0, 2];

    // helpers

    private static Func<JsonElement, Requester<JsonElement>> RequesterOf(ServiceManager services, string procedureName)
    {
        return services.GetRequest(
            InteropService.ProcedureOf(procedureName),
            new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked });
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

    private static Envelope ResultOf(uint callId, SessionAnnouncement? session = null)
    {
        return new Envelope { Header = new ResultHeader { CallId = callId, Session = session } };
    }

    private static Envelope FailureOf(uint callId, ProtocolCode code, SessionAnnouncement? session = null)
    {
        return new Envelope { Header = new FailureHeader { CallId = callId, Session = session }, Failure = Failure.OfProtocol(code) };
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

        InteropService.OfferClient(link.ClientServices);

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
            InteropService.ProcedureOf("clock"),
            new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked });

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return clock(JsonOf("null"))(new RequestOptions { ConnectionHandle = "type=WS;ip=127.0.0.1;port=1" }).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return clock(JsonOf("null"))();
        });
    }

    [Fact]
    public async Task Fails_a_result_that_does_not_decode_here_as_undecodable()
    {
        using var link = new Link();

        var requester = link.ClientServices.GetRequest(
            InteropService.ProcedureOf("echo"),
            new RequestDependencies<JsonElement, int> { Serializer = new Unreadable() });

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return requester(JsonOf("1"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(RouterSide.Client, failure.Side);
        Assert.Equal(InteropService.ProcedureOf("echo").Address, failure.ProcedureAddress);
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
    public void Offers_every_procedure_of_the_interop_manifest_on_the_side_it_names()
    {
        var server = new Registrations(RouterSide.Server);
        var client = new Registrations(RouterSide.Client);

        // the destinations go to a server's router, which takes none of these resolvers
        using var link = new Link();

        InteropService.Offer(new ServiceManager(server), (new SessionManager<string>(), new BeforeRequest((_) =>
        {
            return true;
        }), link.Server));
        InteropService.OfferClient(new ServiceManager(client));

        Assert.Equal(
            InteropService.Procedures.Where((procedure) =>
            {
                return !procedure.IsOfferedByClient;
            }).Select((procedure) =>
            {
                return procedure.ProcedureName;
            }).Order(),
            server.Names.Order());
        Assert.Equal(
            InteropService.Procedures.Where((procedure) =>
            {
                return procedure.IsOfferedByClient;
            }).Select((procedure) =>
            {
                return procedure.ProcedureName;
            }).Order(),
            client.Names.Order());
    }

    [Fact]
    public async Task Rejects_what_waits_once_its_connection_closed_and_forgets_its_session()
    {
        var transport = new ScriptedTransport();
        var scheduler = new SerialScheduler();

        using var router = new RouterClient(transport, new RouterClientOptions { Scheduler = scheduler, ResolverScheduler = scheduler });

        transport.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = 9, Session = Token } }));

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
    public async Task Learns_the_session_from_every_answer_paired_or_not_keeps_it_loses_it_and_never_presents_it()
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

        transport.Deliver(FailureOf(3, ProtocolCode.SessionRequired, SessionAnnouncement.Ended));

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
            Assert.Null(Assert.IsType<RequestHeader>(envelope.Header).SessionToken);
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

    [Fact]
    public async Task Keeps_the_call_id_of_a_subscription_let_go_of_a_while_silent_on_what_comes_under_it_then_reports_it()
    {
        var time = new FakeTimeProvider();

        using var scripted = new ScriptedRouter(clock: time);
        var (router, transport) = (scripted.Router, scripted.Transport);
        var notification = new ScriptedNotification(Service);
        var given = TimeSpan.FromMilliseconds(20);
        var ending = FailureOf(1, ProtocolCode.SessionRequired, SessionAnnouncement.Ended);

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
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired, SessionAnnouncement.Ended));
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
            return router.Notify(ReadOnlyMemory<byte>.Empty, new NotifyRequest(Service.Address, null, null)).WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return router.Subscribe(new AnswerTarget(RouterClient.ServerConnectionHandle, RequestHeaderOf(2))).WaitAsync(Patience, Cancelled);
        });
    }

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
        Assert.Equal([failure, failure, refusal], scripted.Errors);
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

    [Fact]
    public async Task Tells_each_envelope_out_and_in_with_its_header_and_never_its_session_token()
    {
        using var scripted = new ScriptedRouter();
        var (router, transport) = (scripted.Router, scripted.Transport);
        var seen = new List<(DebugDirection Direction, IEnvelopeHeader Header, bool HasSessionToken)>();

        router.Debug += (direction, envelope) =>
        {
            seen.Add((direction, envelope.Header, envelope.HasSessionToken));
        };

        var answering = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(ResultOf(1, Token));
        Assert.Equal(1u, (await answering.WaitAsync(Patience, Cancelled)).Header.CallId);
        await scripted.Settle();
        Assert.Equal(
            [(DebugDirection.Tx, RequestHeaderOf(1), false), (DebugDirection.Rx, new ResultHeader { CallId = 1 }, true)],
            seen);
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

        public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
        {
            return Task.CompletedTask;
        }

        public Task<uint> Subscribe(AnswerTarget target)
        {
            return Task.FromResult(target.Header.CallId);
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
            return InteropService.JsonAsked.Encode(request);
        }

        public int Decode(ReadOnlyMemory<byte> response)
        {
            throw new FormatException("not a number this client reads");
        }
    }

    // a client's transport a test delivers to and closes, which records what it sends, read as the
    // server reads it, and fails its sends once told to
    private sealed class ScriptedTransport : IRouterClientTransport
    {
        private readonly Lock _gate = new();
        private readonly List<ReadOnlyMemory<byte>> _sent = [];

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        // what a send fails with, once set: what it was given is recorded all the same
        public Exception? Refusal { get; set; }

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

        public void DeliverText(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, true));
        }

        public void CloseConnection()
        {
            Close?.Invoke(false, false);
        }

        public Task Send(ReadOnlyMemory<byte> bytes)
        {
            lock (_gate)
            {
                _sent.Add(bytes.ToArray());
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
        {
            var scheduler = new SerialScheduler();

            Transport = new ScriptedTransport { Clock = clock ?? new FakeTimeProvider() };
            Router = new RouterClient(
                Transport,
                new RouterClientOptions
                {
                    Limits = limits,
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

        public Task Handle(RequestResolverProps props)
        {
            return handle(props);
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return null;
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

        public Link()
        {
            _client.Peer = _server;
            _server.Peer = _client;
            Client = new RouterClient(_client);
            Facade = new Server<string>(_server);
            ClientServices = new ServiceManager(Client);
            ServerServices = Facade.Services;
            InteropService.Offer(Facade);
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

            public Task Send(ReadOnlyMemory<byte> bytes)
            {
                Peer!.Deliver(bytes);

                return Task.CompletedTask;
            }
        }

        private sealed class ServerEnd : IServerTransport
        {
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

            public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
            {
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
        transport.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = 1, Session = Token }, Payload = "null"u8.ToArray() }));
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

        public Task Send(ReadOnlyMemory<byte> bytes)
        {
            return Task.CompletedTask;
        }
    }
}
