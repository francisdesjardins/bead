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
            "a metrics registry holds \"echo\" at 1/1: 1/3 is its name at another address (Parameter 'procedure')",
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

    [Fact]
    public void A_router_refuses_a_resolver_its_registry_refuses_registering_nothing_and_a_manager_a_requester_as_it_is_made()
    {
        var registry = new MetricsRegistry();

        using var server = ServerOf(registry);

        var services = new ServiceManager(server);
        var dependencies = new RequestResolverDependencies<string, string> { Serializer = new Texts() };

        services.GetRequestResolver(Echo, dependencies)((_, response) =>
        {
            return response.Answer("echo");
        });

        // the same procedure under another name, at another address, past nothing
        var renamed = Assert.Throws<ArgumentException>(() =>
        {
            services.GetRequestResolver(Echo with { ProcedureId = 2 }, dependencies)((_, response) =>
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
