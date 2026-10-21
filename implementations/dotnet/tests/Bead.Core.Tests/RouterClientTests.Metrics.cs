using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterClient"/> given a registry: one registry summing the two ends of real calls, its
/// counts exact under calls made at once from many threads, and what the side that hears counts.
/// </summary>
public sealed partial class RouterClientTests
{
    // helpers

    // a line of echo's series among the calls a client makes, requests, by the rest of its name, its
    // labels and its value
    private static string MadeOf(string rest)
    {
        const string Labels = "service=\"2\",procedure=\"echo\",type=\"request\"";

        return $"bead_client_call_{rest.Replace("{}", $"{{{Labels}}}", StringComparison.Ordinal).Replace("{outcome", $"{{{Labels},outcome", StringComparison.Ordinal)}";
    }

    // the handled and started counts a registry holds, and the _count of each duration
    private static List<string> CallCountsOf(MetricsRegistry registry)
    {
        return [.. MetricsTests.CountsOf(registry).Where((line) =>
        {
            return !line.Contains("_bucket{", StringComparison.Ordinal);
        }).Order(StringComparer.Ordinal)];
    }

    // definition

    [Fact]
    public async Task One_registry_given_to_a_client_s_router_and_a_server_s_counts_a_call_at_each_of_its_ends_a_command_among_them()
    {
        var registry = new MetricsRegistry();

        using var link = new Link(registry);

        InteropHandlers.OfferClient(new InteropClient(link.AsClient));
        await RequesterOf(link.ClientServices, "echo")(JsonOf("1"))().WaitAsync(Patience, Cancelled);

        // the server asks its client back, by a command, before it answers
        await RequesterOf(link.ClientServices, "ask")(JsonOf("null"))().WaitAsync(Patience, Cancelled);

        // ! the server ends a call as its answer is handed to its transport, after the client may
        // have it: wait for the server's loop, behind that hand-off, before reading what it counted
        await link.Server.Gauges().WaitAsync(Patience, Cancelled);

        string[] expected =
        [
            "bead_client_call_duration_seconds_count{service=\"1\",procedure=\"echo\",type=\"request\"} 1",
            "bead_client_call_handled_total{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"result\"} 1",
            "bead_client_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 1",
            "bead_server_call_duration_seconds_count{service=\"1\",procedure=\"echo\",type=\"request\"} 1",
            "bead_server_call_handled_total{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"result\"} 1",
            "bead_server_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 1",
            "bead_client_call_duration_seconds_count{service=\"1\",procedure=\"ask\",type=\"request\"} 1",
            "bead_client_call_handled_total{service=\"1\",procedure=\"ask\",type=\"request\",outcome=\"result\"} 1",
            "bead_client_call_started_total{service=\"1\",procedure=\"ask\",type=\"request\"} 1",
            "bead_server_call_duration_seconds_count{service=\"1\",procedure=\"ask\",type=\"request\"} 1",
            "bead_server_call_handled_total{service=\"1\",procedure=\"ask\",type=\"request\",outcome=\"result\"} 1",
            "bead_server_call_started_total{service=\"1\",procedure=\"ask\",type=\"request\"} 1",

            // the command: made by the server, among its client families; answered by the client,
            // among its server families
            "bead_client_call_duration_seconds_count{service=\"1\",procedure=\"clock\",type=\"command\"} 1",
            "bead_client_call_handled_total{service=\"1\",procedure=\"clock\",type=\"command\",outcome=\"result\"} 1",
            "bead_client_call_started_total{service=\"1\",procedure=\"clock\",type=\"command\"} 1",
            "bead_server_call_duration_seconds_count{service=\"1\",procedure=\"clock\",type=\"command\"} 1",
            "bead_server_call_handled_total{service=\"1\",procedure=\"clock\",type=\"command\",outcome=\"result\"} 1",
            "bead_server_call_started_total{service=\"1\",procedure=\"clock\",type=\"command\"} 1",
        ];

        Assert.Equal(expected.Order(StringComparer.Ordinal), CallCountsOf(registry));
    }

    // debugging 2.2 and 2.3
    [Fact]
    public async Task A_debug_listener_that_throws_on_an_envelope_is_reported_and_the_envelope_and_its_call_go_on_every_listener_told()
    {
        using var scripted = new ScriptedRouter();

        var (router, transport) = (scripted.Router, scripted.Transport);
        var failure = new InvalidOperationException("listener bug");
        var told = new List<DebugDirection>();

        router.Debug += (_, _) =>
        {
            throw failure;
        };
        router.Debug += (direction, _) =>
        {
            told.Add(direction);
        };

        var answering = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf());

        transport.Deliver(ResultOf(1));
        Assert.Equal(1u, (await answering.WaitAsync(Patience, Cancelled)).Header.CallId);
        await scripted.Settle();
        Assert.Single(transport.Sent);
        Assert.Equal([DebugDirection.Tx, DebugDirection.Rx], told);
        Assert.Equal([failure, failure], scripted.Errors);
    }

    [Fact]
    public async Task Counts_exactly_under_calls_made_at_once_from_many_threads()
    {
        const int Threads = 8;
        const int Calls = 25;
        var registry = new MetricsRegistry();

        using var link = new Link(registry);

        var echo = RequesterOf(link.ClientServices, "echo");

        await Task.WhenAll(Enumerable.Range(0, Threads).Select((thread) =>
        {
            return Task.Run(
                async () =>
                {
                    for (var call = 0; call < Calls; call += 1)
                    {
                        await echo(JsonOf($"{thread}"))().WaitAsync(Patience, Cancelled);
                    }
                },
                Cancelled);
        })).WaitAsync(Patience, Cancelled);

        // ! the server ends a call as its answer is handed to its transport, after the client may
        // have it: wait for the server's loop, behind that hand-off, before reading what it counted
        await link.Server.Gauges().WaitAsync(Patience, Cancelled);

        var each = Threads * Calls;

        Assert.Equal(
            [
                $"bead_client_call_duration_seconds_count{{service=\"1\",procedure=\"echo\",type=\"request\"}} {each}",
                $"bead_client_call_handled_total{{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"result\"}} {each}",
                $"bead_client_call_started_total{{service=\"1\",procedure=\"echo\",type=\"request\"}} {each}",
                $"bead_server_call_duration_seconds_count{{service=\"1\",procedure=\"echo\",type=\"request\"}} {each}",
                $"bead_server_call_handled_total{{service=\"1\",procedure=\"echo\",type=\"request\",outcome=\"result\"}} {each}",
                $"bead_server_call_started_total{{service=\"1\",procedure=\"echo\",type=\"request\"}} {each}",
            ],
            CallCountsOf(registry));
    }

    // debugging 9.3, 9.6.1 and 9.6.2
    [Fact]
    public async Task Counts_a_call_refused_before_it_goes_SESSION_REQUIRED_or_DESTINATION_UNREACHABLE_as_started_and_ended_in_the_turn_it_started_and_a_programmer_s_error_or_an_aborted_signal_as_nothing()
    {
        var registry = new MetricsRegistry();

        using var scripted = new ScriptedRouter(new RouterClientOptions { MetricsRegistry = registry });

        var router = scripted.Router;
        var series = router.DeclareRequester(Service);

        scripted.Transport.CarriesCredential = false;

        Task<Exception> Asked(RouterRequest request)
        {
            return Assert.ThrowsAnyAsync<Exception>(() =>
            {
                return router.Request(ReadOnlyMemory<byte>.Empty, request with { Series = series }).WaitAsync(Patience, Cancelled);
            });
        }

        // OPAQUE with no session known, and an ELSEWHERE its transport cannot carry
        var noSession = await Asked(RequestOf(null, Options with { Credential = Credential.Opaque() }));
        var uncarried = await Asked(RequestOf(null, Options with { Credential = Credential.Elsewhere("x") }));

        Assert.Equal(
            [MadeOf("duration_seconds_count{} 2"), MadeOf("handled_total{outcome=\"failure\",code=\"DESTINATION_UNREACHABLE\"} 1"), MadeOf("handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 1"), MadeOf("started_total{} 2")],
            CallCountsOf(registry).Where((line) =>
            {
                return line.Contains("procedure=\"echo\"", StringComparison.Ordinal);
            }).Order(StringComparer.Ordinal));

        using var aborted = new CancellationTokenSource();

        await aborted.CancelAsync();

        // a programmer's error, and a signal aborted already: neither is a call
        Assert.IsType<InvalidOperationException>(await Asked(RequestOf(new ScriptedNotification(Service))));
        Assert.IsType<ArgumentException>(await Asked(RequestOf(null, Options with { Credential = Credential.Jwt("") })));
        Assert.IsType<ArgumentException>(await Asked(RequestOf(null, Options with { Credential = Credential.Elsewhere() })));
        Assert.IsType<ArgumentException>(await Asked(RequestOf(null, Options with { Credential = Credential.Of((CredentialScheme)4, [1]) })));
        Assert.IsType<ArgumentOutOfRangeException>(await Asked(RequestOf(null, Options with { Timeout = TimeSpan.Zero })));
        Assert.IsType<OperationCanceledException>(await Asked(RequestOf(null, Options with { CancellationToken = aborted.Token })));
        Assert.Contains(MadeOf("started_total{} 2"), CallCountsOf(registry));
        Assert.Equal(
            [(ushort)ProtocolCode.SessionRequired, (ushort)ProtocolCode.DestinationUnreachable],
            new[] { noSession, uncarried }.Select((reason) =>
            {
                return Assert.IsType<FailureException>(reason).Code;
            }));
    }

    // debugging 9.3, spec 13.4
    [Fact]
    public async Task Counts_a_call_that_would_present_a_withdrawn_default_as_started_and_ended_in_the_turn_it_started_SESSION_REQUIRED()
    {
        var registry = new MetricsRegistry();

        using var scripted = new ScriptedRouter(new RouterClientOptions { Credential = Credential.Jwt("a.b.c"), MetricsRegistry = registry });

        var (router, transport) = (scripted.Router, scripted.Transport);
        var series = router.DeclareRequester(Service);

        Task<RouterResult> Call()
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf() with { Series = series });
        }

        var refused = Call();

        await scripted.Settle();
        transport.Deliver(FailureOf(1, ProtocolCode.SessionRequired));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return refused.WaitAsync(Patience, Cancelled);
        });

        var withdrawn = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Call().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the default credential was withdrawn", withdrawn.Failure.Detail);
        Assert.Equal(
            [MadeOf("duration_seconds_count{} 2"), MadeOf("handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 2"), MadeOf("started_total{} 2")],
            CallCountsOf(registry).Where((line) =>
            {
                return line.Contains("procedure=\"echo\"", StringComparison.Ordinal);
            }).Order(StringComparer.Ordinal));
        Assert.Single(transport.Sent);
    }

    // debugging 9.6.12
    [Fact]
    public async Task Counts_a_call_its_caller_cancels_as_cancelled_and_one_its_transport_refuses_as_an_error()
    {
        var registry = new MetricsRegistry();

        using var scripted = new ScriptedRouter(new RouterClientOptions { MetricsRegistry = registry });
        using var cancelling = new CancellationTokenSource();

        var router = scripted.Router;
        var series = router.DeclareRequester(Service);
        var cancelled = router.Request(ReadOnlyMemory<byte>.Empty, RequestOf(null, Options with { CancellationToken = cancelling.Token }) with { Series = series });

        await scripted.Settle();
        await cancelling.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return cancelled.WaitAsync(Patience, Cancelled);
        });

        scripted.Transport.Refusal = new IOException("this transport refuses");

        await Assert.ThrowsAsync<IOException>(() =>
        {
            return router.Request(ReadOnlyMemory<byte>.Empty, RequestOf() with { Series = series }).WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(
            [MadeOf("duration_seconds_count{} 2"), MadeOf("handled_total{outcome=\"cancelled\"} 1"), MadeOf("handled_total{outcome=\"error\"} 1"), MadeOf("started_total{} 2")],
            CallCountsOf(registry).Where((line) =>
            {
                return line.Contains("procedure=\"echo\"", StringComparison.Ordinal);
            }).Order(StringComparer.Ordinal));
    }

    // debugging 9.1.6, 10.2 and 10.3.3
    [Fact]
    public async Task Counts_a_notification_heard_under_a_subscription_it_holds_and_a_subscription_dropped_at_this_end_by_the_failure_that_ends_it_or_with_its_connection_never_by_its_own_cancel()
    {
        var registry = new MetricsRegistry();

        using var scripted = new ScriptedRouter(new RouterClientOptions { MetricsRegistry = registry });

        var transport = scripted.Transport;
        var notification = new ScriptedNotification(Service);
        var other = new ScriptedNotification(Service with { ProcedureId = 2, ProcedureName = "other" });

        // answered, its subscription hears a notification; one under no subscription is reported
        var subscribing = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(1));
        await subscribing.WaitAsync(Patience, Cancelled);
        transport.Deliver(NotificationOf(1));
        transport.Deliver(NotificationOf(9));
        await scripted.Settle();

        // a failure on its call id once answered drops it, by its code
        transport.Deliver(FailureOf(1, ProtocolCode.CapacityExceeded));
        await scripted.Settle();

        // subscribed again, its own cancel drops nothing
        var again = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(3));
        await again.WaitAsync(Patience, Cancelled);
        await scripted.Router.UnregisterNotification(notification).WaitAsync(Patience, Cancelled);

        // and again, a close drops it with no code; a subscription not yet answered, none
        var last = await scripted.Subscribe(notification);

        transport.Deliver(ResultOf(5));
        await last.WaitAsync(Patience, Cancelled);
        _ = await scripted.Subscribe(other);
        transport.CloseConnection();
        await scripted.Settle();

        Assert.Equal([nameof(ProtocolCode.SubscriptionUnknown)], CodesOf(scripted.Errors));
        Assert.Equal(
            [
                "bead_notifications_heard_total{service=\"2\",procedure=\"echo\"} 1",
                "bead_subscriptions_dropped_total{service=\"2\",procedure=\"echo\"} 1",
                "bead_subscriptions_dropped_total{service=\"2\",procedure=\"echo\",code=\"CAPACITY_EXCEEDED\"} 1",
            ],
            MetricsTests.CountsOf(registry).Where((line) =>
            {
                return line.StartsWith("bead_notifications_", StringComparison.Ordinal) || line.StartsWith("bead_subscriptions_", StringComparison.Ordinal);
            }));
    }
}
