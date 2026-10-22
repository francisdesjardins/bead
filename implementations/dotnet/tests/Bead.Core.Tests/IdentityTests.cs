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
    public void Refuses_an_id_or_a_revision_out_of_its_range_service_0_and_revision_0_among_them()
    {
        // * what no C# type holds is never given (docs/support.md, "An id or a revision no C# type holds")
        foreach (var procedure in new[]
        {
            Echo with { ServiceId = 0 },
            Echo with { ProcedureId = 0 },
            Echo with { ServiceRevision = 0 },
            Echo with { ServiceRevision = -1 },
            Echo with { ServiceRevision = int.MinValue },
        })
        {
            Assert.Contains("is out of its range", RefusalOf(procedure), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Refuses_a_name_off_its_form_and_refuses_out_of_its_range_first()
    {
        foreach (var procedureName in new[] { string.Empty, "Echo", "_OTHER", new string('a', 64), "get_thing" })
        {
            Assert.Contains("is off its form", RefusalOf(Echo with { ProcedureName = procedureName }), StringComparison.Ordinal);
        }

        Assert.Contains("is out of its range", RefusalOf(Echo with { ProcedureName = "Echo", ServiceId = 0 }), StringComparison.Ordinal);
    }

    [Fact]
    public void Says_which_ids_revision_and_name_it_was_given()
    {
        Assert.Equal(
            "\"echo\" at 0/1, revision 1, is out of its range: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2) (Parameter 'procedure')",
            RefusalOf(Echo with { ServiceId = 0 }));
        Assert.Equal(
            "\"_OTHER\" at 1/1 is off its form: a procedure's name is a lower-case ASCII letter, then up to 62 ASCII letters or digits (spec 16.4) (Parameter 'procedure')",
            RefusalOf(Echo with { ProcedureName = "_OTHER" }));
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
    public void Reads_a_name_whole_a_character_at_a_time_never_as_a_case_mapping_or_a_regular_expression_would()
    {
        // a line feed past its end, a Kelvin sign, a long s, a dotted I, an e with its acute, a byte
        // order mark, a NUL, and a surrogate alone
        foreach (var name in new[]
        {
            $"echo{(char)0x0A}",
            $"{(char)0x212A}elvin",
            $"{(char)0x017F}tatus",
            $"{(char)0x0130}d",
            $"caf{(char)0x00E9}",
            $"{(char)0xFEFF}echo",
            $"echo{(char)0}",
            $"echo{(char)0xD800}",
        })
        {
            Assert.False(Identity.IsProcedureName(name), name);
        }

        Assert.True(Identity.IsProcedureName("x9"));
    }

    [Fact]
    public void Folds_ASCII_letters_alone_character_by_character()
    {
        Assert.True(Identity.AreOneName("getHTTPStatus", "getHttpStatus"));
        Assert.False(Identity.AreOneName("key", $"{(char)0x212A}ey"));
        Assert.False(Identity.AreOneName($"caf{(char)0x00E9}", $"caf{(char)0x00C9}"));
        Assert.False(Identity.AreOneName("a@", "a`"));
        Assert.False(Identity.AreOneName("ab", "abc"));
    }

    [Fact]
    public void Refuses_a_kind_its_way_does_not_take_against_its_kind_and_takes_a_procedure_that_states_none()
    {
        Assert.Equal(
            "\"echo\" at 1/1 is against its kind: a request, which a requester on a server's router does not take; it takes a command (spec 16.11) (Parameter 'procedure')",
            Assert.Throws<ArgumentException>(() =>
            {
                Identity.Check(Echo with { ProcedureKind = ProcedureKind.Request }, (DeclarationWay.ServerRequester, "procedure"));
            }).Message);

        foreach (var way in new[] { DeclarationWay.ClientRequester, DeclarationWay.ServerResolver, DeclarationWay.ClientNotification })
        {
            Identity.Check(Echo, (way, "procedure"));
        }
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
    public void A_manager_refuses_a_procedure_off_section_16_before_its_own_reason_a_notification_s_asked_for_otherwise()
    {
        using var client = new RouterClient(new UnconnectedClient());

        var services = new ServiceManager(client);
        var dependencies = new NotificationDependencies<string, string, string> { Serializer = new Texts() };

        services.GetNotification(Echo, dependencies);

        // asked for otherwise, and off its form or out of its range: section 16 first
        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            services.GetNotification(Echo with { ProcedureName = "Echo" }, dependencies);
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is out of its range", Assert.Throws<ArgumentException>(() =>
        {
            services.GetNotification(Echo with { ServiceRevision = 0 }, dependencies);
        }).Message, StringComparison.Ordinal);

        // within it, its own reason
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

        Assert.Contains("is off its form", Assert.Throws<ArgumentException>(() =>
        {
            server.DeclareRequester(Echo with { ProcedureName = "Echo" });
        }).Message, StringComparison.Ordinal);
        Assert.Contains("is out of its range", Assert.Throws<ArgumentException>(() =>
        {
            server.RegisterResolver(new Resolver(Echo with { ServiceRevision = 0 }));
        }).Message, StringComparison.Ordinal);
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
