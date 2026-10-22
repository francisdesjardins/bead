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

    // what a registry counted of the subscriptions to news it dropped, its labels left out
    private static List<string> DroppedOf(MetricsRegistry registry)
    {
        return [.. CountedOf((registry, "news")).Where((line) =>
        {
            return line.StartsWith("bead_subscriptions_dropped_total", StringComparison.Ordinal);
        }).Select((line) =>
        {
            return line.Replace("{}", "", StringComparison.Ordinal);
        })];
    }

    // definition

    // debugging 9.2
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

    // spec 17.2.6
    [Fact]
    public async Task Counts_a_notification_whose_value_does_not_write_as_failed_for_each_subscription_it_was_for_sends_it_to_none_reports_why_once_and_fails_no_caller()
    {
        var registry = new MetricsRegistry();
        var told = new List<(Exception? Error, DebugDirection Direction)>();

        Start(new RouterServerOptions { MetricsRegistry = registry });
        Services.Debug += (error, step) =>
        {
            told.Add((error, step.Direction));
        };
        _transport.Open(First);
        _transport.Open(Second);

        var news = NotifierOf(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("ok");
        });

        Deliver(First, SubscribingOf(1));
        Deliver(Second, SubscribingOf(1));
        await Settle();
        told.Clear();
        _transport.Sent.Clear();

        // a surrogate alone, which the text codec refuses: sent to none, settled all the same
        await news.Notify("a\ud800b").WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Empty(_transport.Sent);
        Assert.Equal(["a text value holds a surrogate alone no connection"], Reported());
        Assert.Equal(
            [
                "bead_notifications_sent_total{outcome=\"failed\"} 2",
            ],
            CountedOf((registry, "news")).Where((line) =>
            {
                return line.StartsWith("bead_notifications_", StringComparison.Ordinal);
            }));

        // told as a notification sent, then as its failure to go at that start (spec/debugging.md 4.2)
        Assert.Equal<(bool, DebugDirection)>(
            [(false, DebugDirection.Tx), (true, DebugDirection.Tx)],
            told.Select((step) =>
            {
                return (step.Error is FormatException, step.Direction);
            }));
    }

    // debugging 9.4.6
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
        Assert.Equal(["this admission fails, on purpose first"], Reported());
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

    // debugging 9.7
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
    public async Task Answers_a_call_whose_handler_fails_before_it_answers_PROCEDURE_FAILED_and_counts_it_so()
    {
        var registry = new MetricsRegistry();

        Start(new RouterServerOptions { MetricsRegistry = registry });
        _transport.Open(First);
        Router.RegisterResolver(new Breaking(Other));

        Deliver(First, RequestOf(1, Other));
        await Settle();

        Assert.Equal(["first failure 1 ProcedureFailed"], SentSince());
        Assert.Equal(["this handler breaks, on purpose first"], Reported());
        Assert.Equal(
            [
                "bead_server_call_duration_seconds_bucket{type=\"request\",le=\"0.0\"} 1",
                "bead_server_call_duration_seconds_count{type=\"request\"} 1",
                "bead_server_call_handled_total{type=\"request\",outcome=\"failure\",code=\"PROCEDURE_FAILED\"} 1",
                "bead_server_call_started_total{type=\"request\"} 1",
            ],
            CountedOf((registry, "other")));
    }

    // debugging 2.2 and 2.3
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
        Assert.Empty(DroppedOf(registry));

        _transport.Closed(First);
        await Settle();
        Assert.Equal(["bead_subscriptions_dropped_total 1"], DroppedOf(registry));

        Router.Dispose();
        await Settle();
        Assert.Equal(["bead_subscriptions_dropped_total 2"], DroppedOf(registry));
    }

    [Fact]
    public async Task Counts_a_subscription_its_application_drops_under_the_code_of_the_failure_that_ends_it_whatever_its_code()
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
        _transport.Sent.Clear();

        // a protocol code section 8 names, a procedure's own, and a protocol code it names none of
        await Router.DropSubscriptions(First, Failure.OfProtocol(ProtocolCode.AccessDenied)).WaitAsync(Patience, Cancelled);
        await Router.DropSubscriptions(Second, Failure.OfApplication(9)).WaitAsync(Patience, Cancelled);
        await Router.DropSubscriptions(Third, Failure.OfProtocol((ProtocolCode)99)).WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal(["first failure 1 AccessDenied", "second failure 1 9", "third failure 1 99"], SentSince());

        // nothing under none, and every code a series, made at 0 as its procedure was declared
        Assert.Equal(
            [
                "bead_subscriptions_dropped_total{code=\"ACCESS_DENIED\"} 1",
                "bead_subscriptions_dropped_total{code=\"application\"} 1",
                "bead_subscriptions_dropped_total{code=\"_OTHER\"} 1",
            ],
            CountedOf((registry, "news")).Where((line) =>
            {
                return line.StartsWith("bead_subscriptions_dropped_total", StringComparison.Ordinal);
            }));
        Assert.Equal(26, registry.Exposition().Text.Split('\n').Count((line) =>
        {
            return line.StartsWith("bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\"", StringComparison.Ordinal);
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
