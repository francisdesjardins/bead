namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/> given a registry: what it counts at its gates that no conversation of
/// <c>spec/metrics.json</c> reaches — a notification it cannot hand over, a call it ends with no
/// answer, an admission that fails, a subscription its connection cannot carry back, and the
/// subscriptions a close or its disposal drop.
/// </summary>
public sealed partial class RouterServerTests
{
    // helpers

    // what a registry counted of a procedure of service 2, its labels but the first two left out
    private static List<string> CountedOf((MetricsRegistry Registry, string Procedure) counted)
    {
        var labels = $"service=\"2\",procedure=\"{counted.Procedure}\"";

        return [.. MetricsTests.CountsOf(counted.Registry).Where((line) =>
        {
            return line.Contains(labels, StringComparison.Ordinal);
        }).Select((line) =>
        {
            return line.Replace($"{labels},", "", StringComparison.Ordinal).Replace(labels, "", StringComparison.Ordinal);
        })];
    }

    // definition

    [Fact]
    public async Task Counts_a_notification_it_cannot_hand_to_its_transport_as_failed_and_one_its_transport_refuses_once_it_has_it_as_sent()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { Limits = RouterLimits.Default with { MaximumPayloadBytes = 64 }, MetricsRegistry = registry });
        _transport.Open(First);

        var news = NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        await Settle();

        // whole; past the payload a router's envelope carries; refused by its transport once handed
        await news.Notify("small").WaitAsync(Patience, Cancelled);
        await news.Notify(new string('x', 100)).WaitAsync(Patience, Cancelled);
        _transport.SendErrors[First] = new IOException("refused");
        await news.Notify("late").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["PayloadTooLarge first", "refused first"], Reported());
        Assert.Equal(
            [
                "bead_notifications_sent_total{outcome=\"sent\"} 2",
                "bead_notifications_sent_total{outcome=\"failed\"} 1",
            ],
            CountedOf((registry, "news")).Where((line) =>
            {
                return line.StartsWith("bead_notifications_", StringComparison.Ordinal);
            }));
    }

    [Fact]
    public async Task Counts_a_call_whose_admission_fails_PROCEDURE_FAILED_and_one_whose_subscription_its_connection_cannot_carry_back_SUBSCRIPTION_UNSUPPORTED()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { MetricsRegistry = registry });
        _transport.OneWay.Add(Second);
        _transport.Open(First);
        _transport.Open(Second);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });
        Services.GetRequestResolver(
            Echo,
            new RequestResolverDependencies<string, string>
            {
                Serializer = Text,
                BeforeRequest = new BeforeRequest((_) =>
                {
                    throw new InvalidOperationException("this admission fails, on purpose");
                }),
            })((_, response) =>
            {
                return response.Answer("never");
            });

        Deliver(First, RequestOf(1, Echo));
        Deliver(Second, SubscribingOf(1));
        await Settle();

        Assert.Equal(["first failure 1 ProcedureFailed", "second failure 1 SubscriptionUnsupported"], SentSince());
        Assert.Contains(
            "bead_server_call_handled_total{type=\"request\",outcome=\"failure\",code=\"PROCEDURE_FAILED\"} 1",
            CountedOf((registry, "echo")));
        Assert.Contains(
            "bead_server_call_handled_total{type=\"request\",outcome=\"failure\",code=\"SUBSCRIPTION_UNSUPPORTED\"} 1",
            CountedOf((registry, "news")));

        // a subscription refused in its own answer is its call's failure: none dropped
        Assert.DoesNotContain(CountedOf((registry, "news")), (line) =>
        {
            return line.StartsWith("bead_subscriptions_dropped_total", StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task Counts_a_command_to_a_connection_not_open_as_started_and_closed_in_the_turn_it_started()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { MetricsRegistry = registry });

        var series = Router.DeclareRequester(Echo);

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return Router.Request(BytesOf("x"), CommandOf(Second) with { Series = series }).WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(
            [
                "bead_client_call_duration_seconds_bucket{type=\"command\",le=\"0.0\"} 1",
                "bead_client_call_duration_seconds_count{type=\"command\"} 1",
                "bead_client_call_handled_total{type=\"command\",outcome=\"closed\"} 1",
                "bead_client_call_started_total{type=\"command\"} 1",
            ],
            CountedOf((registry, "echo")));
    }

    [Fact]
    public async Task Counts_a_call_whose_handler_fails_with_no_answer_handed_to_its_transport_as_an_error()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { MetricsRegistry = registry });
        _transport.Open(First);
        Router.RegisterResolver(new Breaking(Other));
        Services.GetRequestResolver(
            Echo,
            new RequestResolverDependencies<string, string>
            {
                Serializer = Text,
                BeforeRequest = new BeforeRequest((_) =>
                {
                    throw new InvalidOperationException("this admission fails, on purpose");
                }),
            })((_, response) =>
            {
                return response.Answer("never");
            });

        Deliver(First, RequestOf(1, Other));
        await Settle();

        Assert.Empty(SentSince());
        Assert.Equal(
            [
                "bead_server_call_duration_seconds_bucket{type=\"request\",le=\"0.0\"} 1",
                "bead_server_call_duration_seconds_count{type=\"request\"} 1",
                "bead_server_call_handled_total{type=\"request\",outcome=\"error\"} 1",
                "bead_server_call_started_total{type=\"request\"} 1",
            ],
            CountedOf((registry, "other")));
    }

    [Fact]
    public async Task A_debug_listener_that_throws_on_an_envelope_is_reported_with_its_connection_and_the_envelope_and_its_call_go_on_every_listener_told()
    {
        var failure = new InvalidOperationException("listener bug");
        var told = new List<DebugDirection>();

        Start();
        _transport.Open(First);
        EchoOf((request, response) =>
        {
            return response.Answer(request.Payload);
        });
        Router.Debug += (_, _) =>
        {
            throw failure;
        };
        Router.Debug += (direction, _) =>
        {
            told.Add(direction);
        };

        Deliver(First, RequestOf(1, Echo, "hi"));
        await Settle();

        Assert.Equal(["first result 1 hi"], SentSince());
        Assert.Equal([DebugDirection.Rx, DebugDirection.Tx], told);
        Assert.Equal([(failure, First), (failure, First)], _errors.Select((error) =>
        {
            return ((Exception)error.Reason, error.ConnectionHandle);
        }));
    }

    [Fact]
    public async Task Drops_each_subscription_a_close_or_its_disposal_ends_with_no_code_and_none_its_client_cancels()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { MetricsRegistry = registry });
        _transport.Open(First);
        _transport.Open(Second);
        _transport.Open(Third);
        NotifierOf((_, response) =>
        {
            return response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        Deliver(Third, SubscribingOf(1));
        await Settle();

        // a cancel ends a subscription its client asked to end: no drop
        Deliver(Third, CancelOf(1));
        await Settle();
        Assert.DoesNotContain(CountedOf((registry, "news")), (line) =>
        {
            return line.StartsWith("bead_subscriptions_dropped_total", StringComparison.Ordinal);
        });

        _transport.Closed(First);
        await Settle();
        Assert.Contains("bead_subscriptions_dropped_total 1", CountedOf((registry, "news")).Select((line) =>
        {
            return line.Replace("{}", "", StringComparison.Ordinal);
        }));

        Router.Dispose();
        await Settle();
        Assert.Contains("bead_subscriptions_dropped_total 2", CountedOf((registry, "news")).Select((line) =>
        {
            return line.Replace("{}", "", StringComparison.Ordinal);
        }));
    }

    // a resolver of its own whose handler fails before it answers, and answers nothing
    private sealed class Breaking(Procedure procedure) : IRequestResolver
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
            return Task.FromException(new InvalidOperationException("this handler breaks, on purpose"));
        }
    }
}
