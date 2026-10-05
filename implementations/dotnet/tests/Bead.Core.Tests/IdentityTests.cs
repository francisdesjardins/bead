namespace Bead.Tests;

/// <summary>
/// <see cref="Identity"/>: what <c>spec/identities.json</c> leaves to the twins — its refusals'
/// sentences, a name holding a surrogate alone, which no JSON text holds, the order of its reasons
/// against the router's, the registry's and the manager's own, a refused declaration declaring
/// nothing — and the types that hold an id and a revision, which the support matrix's row "An id
/// or a revision no C# type holds" names.
/// </summary>
public sealed class IdentityTests
{
    // constants

    private static readonly Procedure Echo = new() { ServiceId = 1, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1 };

    // helpers

    private static string RefusalOf(Procedure procedure)
    {
        return Assert.Throws<ArgumentException>(() =>
        {
            Identity.Check(procedure, nameof(procedure));
        }).Message;
    }

    private static RouterServer ServerOf(MetricsRegistry? registry = null)
    {
        return new RouterServer(new Unconnected(), new RouterServerOptions { MetricsRegistry = registry });
    }

    // definition

    [Fact]
    public void Refuses_out_of_its_range_before_off_its_form_in_sentences_that_name_the_procedure_and_its_reason()
    {
        Assert.Equal(
            "\"echo\" at 0/1, revision 1, is out of its range: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2) (Parameter 'procedure')",
            RefusalOf(Echo with { ServiceId = 0 }));
        Assert.Equal(
            "\"Echo\" at 0/1, revision 1, is out of its range: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2) (Parameter 'procedure')",
            RefusalOf(Echo with { ServiceId = 0, ProcedureName = "Echo" }));
        Assert.Contains("is out of its range", RefusalOf(Echo with { ProcedureId = 0 }), StringComparison.Ordinal);
        Assert.Contains("is out of its range", RefusalOf(Echo with { ServiceRevision = 0 }), StringComparison.Ordinal);
        Assert.Contains("is out of its range", RefusalOf(Echo with { ServiceRevision = int.MinValue }), StringComparison.Ordinal);
        Assert.Equal(
            "\"Echo\" at 1/1 is off its form: a procedure's name is a lower-case ASCII letter, then up to 62 ASCII letters or digits (spec 16.4) (Parameter 'procedure')",
            RefusalOf(Echo with { ProcedureName = "Echo" }));
    }

    [Fact]
    public void Refuses_a_name_holding_a_surrogate_alone_off_its_form_and_folds_none_but_an_ASCII_letter()
    {
        // * no JSON text holds one (RFC 7493 §2.1), so the file leaves it here
        Assert.Contains("is off its form", RefusalOf(Echo with { ProcedureName = "a\ud800b" }), StringComparison.Ordinal);
        Assert.Contains("is off its form", RefusalOf(Echo with { ProcedureName = "echo\udc00" }), StringComparison.Ordinal);
        Assert.False(Identity.IsProcedureName("a\ud83d\ude00"));
        Assert.True(Identity.AreOneName("a\ud800", "A\ud800"));
        Assert.False(Identity.AreOneName("a\ud800", "a\udc00"));
        Assert.False(Identity.AreOneName("[", "{"));
    }

    [Fact]
    public async Task Checks_a_declaration_before_the_router_s_reasons_and_its_registry_s()
    {
        var registry = new MetricsRegistry();

        using var server = ServerOf(registry);
        using var client = new RouterClient(new UnconnectedClient());

        server.RegisterResolver(new Resolver(Echo));
        server.DeclareRequester(Echo);
        await client.RegisterNotification(new Heard(Echo));

        // the address is registered, and held under another name: the form refuses first
        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            server.RegisterResolver(new Resolver(Echo with { ProcedureName = "Echo" }));
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            server.DeclareRequester(Echo with { ProcedureName = "Echo" });
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is off its form", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.RegisterNotification(new Heard(Echo with { ProcedureName = "Echo" }));
        })).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_manager_refuses_a_resolver_off_section_16_as_it_is_asked_for_before_its_callback_is_given()
    {
        using var server = ServerOf();

        var services = new ServiceManager(server);
        var request = new RequestResolverDependencies<string, string> { Serializer = new ServerTexts() };
        var notification = new NotificationResolverDependencies<string, string, string> { Serializer = new ServerTexts() };
        var named = Echo with { ProcedureName = "Echo" };
        var ranged = Echo with { ServiceRevision = 0 };

        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            services.GetRequestResolver(named, request);
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            services.GetCommandResolver(named, request);
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is out of its range", Assert.Throws<ArgumentException>(() =>
        {
            services.GetNotificationResolver(ranged, notification);
        }).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_manager_runs_its_router_s_check_before_its_own_reason_as_a_notification_is_asked_for()
    {
        using var client = new RouterClient(new UnconnectedClient());

        var services = new ServiceManager(client);
        var dependencies = new NotificationDependencies<string, string, string> { Serializer = new Texts() };

        services.GetNotification(Echo, dependencies);

        // asked for otherwise, and off its form: the form first
        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            services.GetNotification(Echo with { ProcedureName = "Echo" }, dependencies);
        }).Message, StringComparison.Ordinal);
        Assert.Throws<InvalidOperationException>(() =>
        {
            services.GetNotification(Echo with { ProcedureName = "other" }, dependencies);
        });
    }

    [Fact]
    public void A_refused_declaration_declares_nothing_its_registry_holding_no_series_of_it()
    {
        var registry = new MetricsRegistry();

        using var server = ServerOf(registry);

        var empty = registry.Exposition().Text;

        Assert.Throws<ArgumentException>(() =>
        {
            server.DeclareRequester(Echo with { ProcedureName = "Echo" });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            server.RegisterResolver(new Resolver(Echo with { ServiceRevision = 0 }));
        });
        Assert.Equal(empty, registry.Exposition().Text);

        // its address is free, at its service's first revision
        server.RegisterResolver(new Resolver(Echo));
        Assert.Contains(
            "bead_server_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 0",
            registry.Exposition().Text.Split('\n'));
    }

    [Fact]
    public void Holds_an_id_in_a_ushort_and_a_revision_in_an_int_their_largest_values_taken()
    {
        // * what no C# type holds is never given: 65536, -1 as an id, 2³¹, a fraction, a string, a
        // boolean, null (docs/support.md, "An id or a revision no C# type holds")
        Assert.Equal(typeof(ushort), typeof(Procedure).GetProperty(nameof(Procedure.ServiceId))!.PropertyType);
        Assert.Equal(typeof(ushort), typeof(Procedure).GetProperty(nameof(Procedure.ProcedureId))!.PropertyType);
        Assert.Equal(typeof(int), typeof(Procedure).GetProperty(nameof(Procedure.ServiceRevision))!.PropertyType);
        Identity.Check(Echo with { ServiceId = ushort.MaxValue, ProcedureId = ushort.MaxValue, ServiceRevision = int.MaxValue }, "procedure");
    }

    // a resolver of a procedure, which no call reaches
    private sealed class Resolver(Procedure procedure) : IRequestResolver
    {
        public Procedure Procedure { get; } = procedure;

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
            return Task.CompletedTask;
        }
    }

    // a notification of a procedure, which nothing triggers
    private sealed class Heard(Procedure procedure) : INotificationLike
    {
        public Procedure Procedure { get; } = procedure;

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

    // text, either way, through the runtime's codec
    private sealed class Texts : INotificationSerializerClient<string, string, string>
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

    // text, either way, as a resolver writes it, through the runtime's codec
    private sealed class ServerTexts : INotificationSerializerServer<string, string, string>
    {
        public string Decode(ReadOnlyMemory<byte> request)
        {
            return Payloads.ReadText(request);
        }

        public ReadOnlyMemory<byte> Encode(string response)
        {
            return Payloads.WriteText(response);
        }

        public ReadOnlyMemory<byte> EncodeNotification(string notification)
        {
            return Payloads.WriteText(notification);
        }
    }

    // a client's transport that never connects
    private sealed class UnconnectedClient : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<TransportMessage>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, bool>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message)
        {
            return Task.CompletedTask;
        }
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
}
