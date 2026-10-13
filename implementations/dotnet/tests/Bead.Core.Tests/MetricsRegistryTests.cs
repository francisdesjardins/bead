namespace Bead.Tests;

/// <summary>
/// <see cref="MetricsRegistry"/>: what <c>spec/metrics.json</c> leaves to the twins — its refusals'
/// sentences, a name holding a lone surrogate, its ceiling — and the routers and the manager that
/// declare to it, refusing as they are made what it refuses.
/// </summary>
public sealed class MetricsRegistryTests
{
    // constants

    private static readonly Procedure Echo = new() { ServiceId = 1, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1 };

    // helpers

    private static RouterServer ServerOf(MetricsRegistry registry)
    {
        return new RouterServer(new Unconnected(), new RouterServerOptions { MetricsRegistry = registry });
    }

    // definition

    // spec 16.7
    [Fact]
    public void Refuses_a_declaration_as_it_is_made_in_sentences_that_name_its_address_its_names_and_its_reason_declaring_nothing()
    {
        var registry = new MetricsRegistry(new MetricsRegistryOptions { MaximumProcedures = 2 });
        var server = registry.Give(RouterSide.Server);

        string RefusalOf(Action declare)
        {
            return Assert.Throws<ArgumentException>(declare).Message;
        }

        server.DeclareResolver(Echo, false);
        server.DeclareResolver(Echo with { ProcedureId = 2, ProcedureName = "fail" }, false);

        Assert.Equal(
            "a metrics registry holds 1/1 as \"echo\": \"other\" is another name at its address (Parameter 'procedure')",
            RefusalOf(() =>
            {
                server.DeclareRequester(Echo with { ProcedureName = "other" });
            }));
        Assert.Equal(
            "a metrics registry holds \"echo\" at 1/1: \"echo\" at 1/3 is its name at another address (Parameter 'procedure')",
            RefusalOf(() =>
            {
                server.DeclareResolver(Echo with { ProcedureId = 3 }, false);
            }));
        Assert.Equal(
            "a metrics registry's families name 2 procedures at most: \"slow\" at 1/3 is past the ceiling (Parameter 'procedure')",
            RefusalOf(() =>
            {
                server.DeclareResolver(Echo with { ProcedureId = 3, ProcedureName = "slow" }, false);
            }));

        // refused, it declared nothing: its address is free for its own name, in other families
        server.DeclareRequester(Echo with { ProcedureId = 3, ProcedureName = "slow" });
        Assert.Contains(
            "bead_client_call_started_total{service=\"1\",procedure=\"slow\",type=\"command\"} 0",
            registry.Exposition().Text.Split('\n'));
    }

    // spec 16.7
    [Fact]
    public void Refuses_a_name_its_service_holds_at_another_address_in_another_case_declaring_nothing()
    {
        var registry = new MetricsRegistry();
        var server = registry.Give(RouterSide.Server);

        server.DeclareResolver(Echo with { ProcedureName = "getHTTPStatus" }, false);

        Assert.Equal(
            "a metrics registry holds \"getHTTPStatus\" at 1/1: \"getHttpStatus\" at 1/2 is its name at another address (Parameter 'procedure')",
            Assert.Throws<ArgumentException>(() =>
            {
                server.DeclareRequester(Echo with { ProcedureId = 2, ProcedureName = "getHttpStatus" });
            }).Message);

        // refused, it declared nothing: the address takes another name, and another service holds
        // the name
        server.DeclareResolver(Echo with { ProcedureId = 2, ProcedureName = "fail" }, false);
        server.DeclareResolver(Echo with { ServiceId = 2, ProcedureName = "getHttpStatus" }, false);
        Assert.Equal(
            [
                "bead_server_call_started_total{service=\"1\",procedure=\"getHTTPStatus\",type=\"request\"} 0",
                "bead_server_call_started_total{service=\"1\",procedure=\"fail\",type=\"request\"} 0",
                "bead_server_call_started_total{service=\"2\",procedure=\"getHttpStatus\",type=\"request\"} 0",
            ],
            registry.Exposition().Text.Split('\n').Where((line) =>
            {
                return line.StartsWith("bead_server_call_started_total{service=\"", StringComparison.Ordinal) && !line.Contains("_OTHER", StringComparison.Ordinal);
            }));
    }

    // spec 16.7
    [Fact]
    public void Counts_a_service_declared_at_a_second_revision_into_its_series()
    {
        var registry = new MetricsRegistry();
        var first = registry.Give(RouterSide.Server);
        var second = registry.Give(RouterSide.Server);
        var client = registry.Give(RouterSide.Client);

        // an address the registry holds, at another revision on another router, takes its series; a
        // third revision of the service, at an address of its own, a series of its own
        var echo = first.DeclareResolver(Echo, false);
        var revised = second.DeclareResolver(Echo with { ServiceRevision = 2 }, false);
        var fail = client.DeclareRequester(Echo with { ProcedureId = 2, ProcedureName = "fail", ServiceRevision = 3 });

        Assert.Same(echo.Calls, revised.Calls);

        echo.Calls.Start();
        revised.Calls.Start();
        fail.Start();

        Assert.Equal(
            [
                "bead_client_call_started_total{service=\"1\",procedure=\"fail\",type=\"request\"} 1",
                "bead_server_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 2",
            ],
            registry.Exposition().Text.Split('\n').Where((line) =>
            {
                return line.Contains("_call_started_total{service=\"1\"", StringComparison.Ordinal);
            }));
    }

    // debugging 8.5 and 11.2
    [Fact]
    public async Task Writes_each_series_from_one_reading_of_its_counts()
    {
        const int Threads = 4;
        const int Readings = 200;

        var registry = new MetricsRegistry();
        var calls = registry.Give(RouterSide.Client).DeclareRequester(Echo);
        var failed = (CallOutcome.Failure, (Failure?)Failure.OfApplication(1));
        using var running = new CountdownEvent(Threads);
        using var read = new CancellationTokenSource();

        // * its calls counted from several threads for as long as it reads, each ending in its own
        // bucket and column, by turns
        var counting = Task.WhenAll(Enumerable.Range(0, Threads).Select((_) =>
        {
            return Task.Factory.StartNew(
                () =>
                {
                    running.Signal();

                    for (var call = 0; !read.IsCancellationRequested; call += 1)
                    {
                        calls.Start();
                        calls.End(call % 2 == 0 ? (CallOutcome.Result, null) : failed, call % 1_000);
                    }
                },
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default);
        }));

        Assert.True(running.Wait(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken));

        for (var reading = 0; reading < Readings; reading += 1)
        {
            HoldsOneReading(registry.Exposition().Text);
        }

        await read.CancelAsync();
        await counting.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);

        // once nobody counts, every call started ended
        var (started, handled) = HoldsOneReading(registry.Exposition().Text);

        Assert.True(started > 0);
        Assert.Equal(started, handled);
    }

    // what one reading of the echo series holds, its started count and the sum of its handled
    // counts: its started count never below its handled counts, its _count and its +Inf bucket their
    // sum, and its buckets rising to it
    private static (long Started, long Handled) HoldsOneReading(string text)
    {
        const string Labels = "{service=\"1\",procedure=\"echo\",type=\"request\"";

        long CountOf(string line)
        {
            return long.Parse(line[(line.LastIndexOf(' ') + 1)..], System.Globalization.CultureInfo.InvariantCulture);
        }

        var lines = text.Split('\n');
        var started = lines.Where((line) =>
        {
            return line.StartsWith($"bead_client_call_started_total{Labels}", StringComparison.Ordinal);
        }).Select(CountOf).Single();
        var handled = lines.Where((line) =>
        {
            return line.StartsWith($"bead_client_call_handled_total{Labels}", StringComparison.Ordinal);
        }).Sum(CountOf);
        var buckets = lines.Where((line) =>
        {
            return line.StartsWith($"bead_client_call_duration_seconds_bucket{Labels}", StringComparison.Ordinal);
        }).Select(CountOf).ToList();
        var count = lines.Where((line) =>
        {
            return line.StartsWith($"bead_client_call_duration_seconds_count{Labels}", StringComparison.Ordinal);
        }).Select(CountOf).Single();

        Assert.True(started >= handled, $"started {started}, below its handled counts' {handled}");
        Assert.Equal(handled, count);
        Assert.Equal(handled, buckets[^1]);
        Assert.Equal(buckets.Order(), buckets);

        return (started, handled);
    }

    [Fact]
    public void Writes_a_lone_surrogate_in_a_name_as_U_FFFD_as_spec_7_4_writes_a_detail()
    {
        var registry = new MetricsRegistry();
        var client = registry.Give(RouterSide.Client);

        client.DeclareNotification(Echo with { ProcedureName = "a\ud800b" });
        client.DeclareNotification(Echo with { ProcedureId = 2, ProcedureName = "c\udc00" });
        client.DeclareNotification(Echo with { ProcedureId = 3, ProcedureName = "😀" });

        Assert.Equal(
            [
                "bead_notifications_heard_total{service=\"1\",procedure=\"a�b\"} 0",
                "bead_notifications_heard_total{service=\"1\",procedure=\"c�\"} 0",
                "bead_notifications_heard_total{service=\"1\",procedure=\"😀\"} 0",
            ],
            registry.Exposition().Text.Split('\n').Where((line) =>
            {
                return line.StartsWith("bead_notifications_heard_total{", StringComparison.Ordinal);
            }));
    }

    [Fact]
    public void Refuses_a_ceiling_that_is_not_a_whole_number_above_0_and_names_1000_procedures_by_default()
    {
        Assert.Equal(1_000, new MetricsRegistryOptions().MaximumProcedures);
        Assert.Equal(
            "MaximumProcedures is a whole number above 0, not 0 (Parameter 'options')",
            Assert.Throws<ArgumentException>(() =>
            {
                return new MetricsRegistry(new MetricsRegistryOptions { MaximumProcedures = 0 });
            }).Message);
        Assert.Equal(new MetricsExposition("text/plain; version=0.0.4; charset=utf-8", ""), new MetricsRegistry().Exposition());
    }

    // spec 16.7
    [Fact]
    public void A_router_refuses_a_resolver_its_registry_refuses_registering_nothing_and_a_manager_a_requester_as_it_is_made_its_names_folded()
    {
        var registry = new MetricsRegistry();

        using var server = ServerOf(registry);

        var services = new ServiceManager(server);
        var dependencies = new RequestResolverDependencies<string, string> { Serializer = new Texts() };

        services.GetRequestResolver(Echo, dependencies)((_, response) =>
        {
            return response.Answer("echo");
        });

        // the same procedure under its name, at another address, its case another: one name (spec 16.6)
        var renamed = Assert.Throws<ArgumentException>(() =>
        {
            services.GetRequestResolver(Echo with { ProcedureId = 2, ProcedureName = "eCHO" }, dependencies)((_, response) =>
            {
                return response.Answer("again");
            });
        });

        Assert.Contains("is its name at another address", renamed.Message, StringComparison.Ordinal);

        // registered nothing: its address is free, for its own name
        services.GetRequestResolver(Echo with { ProcedureId = 2, ProcedureName = "twice" }, dependencies)((_, response) =>
        {
            return response.Answer("twice");
        });
        Assert.Contains(
            "is another name at its address",
            Assert.Throws<ArgumentException>(() =>
            {
                return services.GetCommand(Echo with { ProcedureName = "clock" }, new RequestDependencies<string, string> { Serializer = new Texts() });
            }).Message,
            StringComparison.Ordinal);
    }

    // a server's transport whose connections never open
    private sealed class Unconnected : IRouterServerTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<string>? Connection
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<TransportMessage, string>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, string>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }
    }

    // text, in UTF-8, either way
    private sealed class Texts : IRequestSerializerServer<string, string>, IRequestSerializerClient<string, string>
    {
        public string Decode(ReadOnlyMemory<byte> request)
        {
            return System.Text.Encoding.UTF8.GetString(request.Span);
        }

        public ReadOnlyMemory<byte> Encode(string response)
        {
            return System.Text.Encoding.UTF8.GetBytes(response);
        }
    }
}
