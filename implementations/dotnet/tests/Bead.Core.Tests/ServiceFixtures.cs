namespace Bead.Tests;

/// <summary>
/// The greeter, service 7, as generated code describes it: a request, one that notifies, one in a
/// session, one behind a hook, one that opens a session, and two commands, one in a session. The
/// service layer's tests serve and call it, as the TypeScript side's serve and call its own.
/// </summary>
public sealed class GreeterProcedures
{
    private static readonly ProcedureBindings<string, string> Open = new()
    {
        Admission = AdmissionRule.None,
        Request = PayloadCodecs.Text,
        Result = PayloadCodecs.Text,
    };

    private GreeterProcedures()
    {
    }

    /// <summary>A command, which a client answers.</summary>
    public static CommandProcedure<GreeterProcedures, string, string, NoFailure> Clock { get; } = new(ProcedureOf(9, "clock"), Open);

    /// <summary>A command in a session.</summary>
    public static CommandProcedure<GreeterProcedures, string, string, NoFailure> Guarded { get; } = new(
        ProcedureOf(10, "guarded"),
        Open with { Admission = AdmissionRule.Session });

    /// <summary>A request that opens a session.</summary>
    public static RequestProcedure<GreeterProcedures, string, string, NoFailure> Login { get; } = new(ProcedureOf(5, "login"), Open);

    /// <summary>A request that notifies.</summary>
    public static RequestProcedure<GreeterProcedures, string, string, string, NoFailure> News { get; } = new(
        ProcedureOf(2, "news"),
        new ProcedureBindings<string, string, string>
        {
            Admission = AdmissionRule.None,
            Notification = PayloadCodecs.Text,
            Request = PayloadCodecs.Text,
            Result = PayloadCodecs.Text,
        });

    /// <summary>A request, which lists one failure.</summary>
    public static RequestProcedure<GreeterProcedures, string, string, SayHelloFailure> SayHello { get; } = new(ProcedureOf(1, "sayHello"), Open);

    /// <summary>A request behind the hook <c>loud</c>.</summary>
    public static RequestProcedure<GreeterProcedures, string, string, NoFailure> Shout { get; } = new(
        ProcedureOf(4, "shout"),
        Open with { Admission = AdmissionRule.Hook("loud") });

    /// <summary>A request in a session.</summary>
    public static RequestProcedure<GreeterProcedures, string, string, NoFailure> Whoami { get; } = new(
        ProcedureOf(3, "whoami"),
        Open with { Admission = AdmissionRule.Session });

    /// <summary>Every procedure of the greeter.</summary>
    public static IReadOnlyList<IServiceProcedure<GreeterProcedures>> All { get; } = [Clock, Guarded, Login, News, SayHello, Shout, Whoami];

    /// <summary>The greeter's catalogue.</summary>
    public static FailureCatalogue Failures { get; } = new(7);

    private static Procedure ProcedureOf(ushort procedureId, string procedureName)
    {
        return new Procedure { ServiceId = 7, ProcedureId = procedureId, ProcedureName = procedureName, ServiceRevision = 1 };
    }
}

/// <summary>
/// The checked service, 8, each procedure's request held to one rule, by hand: a string of one
/// character at least, <c>string.min_len</c>, as section 18 words it. A request, one that notifies,
/// and a command; the service layer's tests judge each before its resolver, and before it goes.
/// </summary>
public sealed class CheckedProcedures
{
    private CheckedProcedures()
    {
    }

    /// <summary>The detail a request its rule refuses is answered with (spec 18.6).</summary>
    public const string Detail = "{\"bounds\":{\"min_len\":\"1\"},\"message\":\"must be at least 1 characters\",\"ruleId\":\"string.min_len\"}\n{\"more\":0}";

    /// <summary>The rule, its value one character at least: none for any other.</summary>
    public static RequestValidator<string> NotEmpty { get; } = (request, options) =>
    {
        return request.Length > 0
            ? Judged.None
            : new Judged
            {
                Stopped = options.FailFast,
                Violations = [new Violation { Bounds = MinLen, Message = "must be at least 1 characters", RuleId = "string.min_len", Value = request }],
            };
    };

    /// <summary>A request.</summary>
    public static RequestProcedure<CheckedProcedures, string, string, NoFailure> Echo { get; } = new(ProcedureOf(1, "echo"), BindingsOf(NotEmpty));

    /// <summary>A request that notifies.</summary>
    public static RequestProcedure<CheckedProcedures, string, string, string, NoFailure> News { get; } = new(
        ProcedureOf(2, "news"),
        new ProcedureBindings<string, string, string>
        {
            Admission = AdmissionRule.None,
            Notification = PayloadCodecs.Text,
            Request = PayloadCodecs.Text,
            Result = PayloadCodecs.Text,
            Validate = NotEmpty,
        });

    /// <summary>A command, which a client answers.</summary>
    public static CommandProcedure<CheckedProcedures, string, string, NoFailure> Shout { get; } = new(ProcedureOf(3, "shout"), BindingsOf(NotEmpty));

    /// <summary>Every procedure of the service.</summary>
    public static IReadOnlyList<IServiceProcedure<CheckedProcedures>> All { get; } = [Echo, News, Shout];

    private static System.Text.Json.JsonElement MinLen { get; } = Bead.Protobuf.Validators.BoundsOf("{\"min_len\":\"1\"}");

    /// <summary>A text procedure's bindings, judged by <paramref name="validate"/>.</summary>
    public static ProcedureBindings<string, string> BindingsOf(RequestValidator<string> validate)
    {
        return new ProcedureBindings<string, string>
        {
            Admission = AdmissionRule.None,
            Request = PayloadCodecs.Text,
            Result = PayloadCodecs.Text,
            Validate = validate,
        };
    }

    private static Procedure ProcedureOf(ushort procedureId, string procedureName)
    {
        return new Procedure { ServiceId = 8, ProcedureId = procedureId, ProcedureName = procedureName, ServiceRevision = 1 };
    }
}

/// <summary>
/// The required service, 9, whose one request takes and answers a <c>Probe</c>, of
/// <c>spec/codecs.proto</c>, through the runtime codec generated code names: a <c>Probe</c> whose
/// <c>needs</c> leaves a required field unset neither reads nor writes (spec 17.9.7). Its twin at
/// the same address reads and writes raw bytes, which a peer sends and answers as they are.
/// </summary>
public sealed class RequiredProcedures
{
    private RequiredProcedures()
    {
    }

    /// <summary>A request, a Probe both ways.</summary>
    public static RequestProcedure<RequiredProcedures, Bead.Codecs.V1.Probe, Bead.Codecs.V1.Probe, NoFailure> Echo { get; } = new(
        ProcedureOf(1, "echo"),
        new ProcedureBindings<Bead.Codecs.V1.Probe, Bead.Codecs.V1.Probe>
        {
            Admission = AdmissionRule.None,
            Request = Bead.Protobuf.ProtoCodecs.Of<Bead.Codecs.V1.Probe>(),
            Result = Bead.Protobuf.ProtoCodecs.Of<Bead.Codecs.V1.Probe>(),
        });

    /// <summary>The same request, its bytes raw both ways: what a peer of no such codec sends and answers.</summary>
    public static RequestProcedure<RequiredProcedures, ReadOnlyMemory<byte>, ReadOnlyMemory<byte>, NoFailure> RawEcho { get; } = new(
        ProcedureOf(1, "echo"),
        new ProcedureBindings<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>>
        {
            Admission = AdmissionRule.None,
            Request = PayloadCodecs.Raw,
            Result = PayloadCodecs.Raw,
        });

    /// <summary>A Probe whose needs leaves its shade unset, and its bytes: <c>3A 02 08 01</c>.</summary>
    public static Bead.Codecs.V1.Probe Unset
    {
        get
        {
            return new Bead.Codecs.V1.Probe { Needs = new Bead.Codecs.V1.Needs { Must = 1 } };
        }
    }

    /// <summary>The words its codec refuses <see cref="Unset"/> in, reading and writing.</summary>
    public const string Words = "a proto message leaves bead.codecs.v1.Needs.shade unset";

    private static Procedure ProcedureOf(ushort procedureId, string procedureName)
    {
        return new Procedure { ServiceId = 9, ProcedureId = procedureId, ProcedureName = procedureName, ServiceRevision = 1 };
    }
}

/// <summary>The checked service's hooks: none, its options' record.</summary>
public sealed class CheckedAdmissions : IServiceAdmissions<CheckedProcedures>
{
    IReadOnlyDictionary<string, AdmissionHook> IServiceAdmissions<CheckedProcedures>.ToDictionary()
    {
        return new Dictionary<string, AdmissionHook>();
    }
}

/// <summary>The greeter's hooks, as generated code writes them: <c>loud</c>, required.</summary>
public sealed class GreeterAdmissions : IServiceAdmissions<GreeterProcedures>
{
    /// <summary>The hook <c>loud</c>, which admits a call to <c>shout</c>.</summary>
    public required AdmissionHook Loud { get; init; }

    IReadOnlyDictionary<string, AdmissionHook> IServiceAdmissions<GreeterProcedures>.ToDictionary()
    {
        return new Dictionary<string, AdmissionHook>
        {
            ["loud"] = Loud,
        };
    }
}

/// <summary>The greeter's windows, as generated code writes them: <c>news</c>'s.</summary>
public sealed class GreeterWindows : IServiceWindows<GreeterProcedures>
{
    /// <summary>The window of <c>news</c>.</summary>
    public int? News { get; init; }

    IReadOnlyDictionary<string, int?> IServiceWindows<GreeterProcedures>.ToDictionary()
    {
        return new Dictionary<string, int?>
        {
            ["news"] = News,
        };
    }
}

/// <summary>
/// Hooks and windows by any name, which no generated record gives: what reaches the layer's own
/// refusals, as a cast reaches them on the TypeScript side.
/// </summary>
public sealed class AnyNames(IReadOnlyDictionary<string, AdmissionHook>? hooks = null, IReadOnlyDictionary<string, int?>? windows = null)
    : IServiceAdmissions<GreeterProcedures>, IServiceWindows<GreeterProcedures>
{
    IReadOnlyDictionary<string, AdmissionHook> IServiceAdmissions<GreeterProcedures>.ToDictionary()
    {
        return hooks ?? new Dictionary<string, AdmissionHook>();
    }

    IReadOnlyDictionary<string, int?> IServiceWindows<GreeterProcedures>.ToDictionary()
    {
        return windows ?? new Dictionary<string, int?>();
    }
}

/// <summary>The failures <c>sayHello</c> may answer, and no other, as generated code writes them.</summary>
public sealed class SayHelloFailure : IApplicationFailure
{
    private SayHelloFailure(ushort code)
    {
        Code = code;
    }

    /// <summary>There is nobody to greet.</summary>
    public static SayHelloFailure NobodyToGreet { get; } = new(1);

    /// <summary>Its code.</summary>
    public ushort Code { get; }
}

/// <summary>
/// A server of Bead whose services go through <see cref="Intercepted"/>, over a server a test
/// built: what its router is asked to declare is heard, and a resolver it registers may be made one
/// that forwards a credential unresolved.
/// </summary>
internal sealed class InterceptedServer(Server<string> server) : IBeadServer<string>
{
    public InterceptingRouter Intercepted { get; } = new(server.Router);

    public IServerTransport Transport
    {
        get
        {
            return server.Transport;
        }
    }

    public RouterServer Router
    {
        get
        {
            return server.Router;
        }
    }

    public ServiceManager Services
    {
        get
        {
            return field ??= new ServiceManager(Intercepted);
        }
    }

    public SessionManager<string> Sessions
    {
        get
        {
            return server.Sessions;
        }
    }

    public BeforeRequest RequireSession
    {
        get
        {
            return server.RequireSession;
        }
    }

    public BeforeRequest RequireCredential
    {
        get
        {
            return server.RequireCredential;
        }
    }

    public BeforeRequest ShareLegBSession
    {
        get
        {
            return server.ShareLegBSession;
        }
    }

    public Task<ServerGauges> Gauges()
    {
        return server.Gauges();
    }

    public Task<Health> Health()
    {
        return server.Health();
    }

    public ValueTask DisposeAsync()
    {
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// A client of Bead whose services go through <see cref="Intercepted"/>, over a client a test
/// built: what its router is asked to declare is heard.
/// </summary>
internal sealed class InterceptedClient(IClient client) : IClient
{
    public InterceptingRouter Intercepted { get; } = new(client.Router);

    public RouterClient Router
    {
        get
        {
            return client.Router;
        }
    }

    public ServiceManager Services
    {
        get
        {
            return field ??= new ServiceManager(Intercepted);
        }
    }

    public Task Disconnect(TransportDisconnectOptions? options = null)
    {
        return client.Disconnect(options);
    }

    public Task Reconnect(TransportReconnectOptions? options = null)
    {
        return client.Reconnect(options);
    }

    public ValueTask DisposeAsync()
    {
        return ValueTask.CompletedTask;
    }
}

/// <summary>A router, each declaration to it heard, in order.</summary>
internal sealed class InterceptingRouter(IRouterLike router) : IRouterLike
{
    /// <summary>Each declaration, as <c>requester name</c> or <c>resolver name</c>.</summary>
    public List<string> Declared { get; } = [];

    public RouterSide Side
    {
        get
        {
            return router.Side;
        }
    }

    public TimeProvider Clock
    {
        get
        {
            return router.Clock;
        }
    }

    public int DetailBytes
    {
        get
        {
            return router.DetailBytes;
        }
    }

    public void RegisterResolver(IRequestResolver resolver)
    {
        lock (Declared)
        {
            Declared.Add($"resolver {resolver.Procedure.ProcedureName}");
        }

        router.RegisterResolver(resolver);
    }

    public Task Respond(RouterAnswer response, AnswerTarget target)
    {
        return router.Respond(response, target);
    }

    public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
    {
        return router.Request(payload, request);
    }

    public ProcedureSeries? DeclareRequester(Procedure procedure)
    {
        lock (Declared)
        {
            Declared.Add($"requester {procedure.ProcedureName}");
        }

        return router.DeclareRequester(procedure);
    }

    public void Report(Exception reason, string? connectionHandle)
    {
        router.Report(reason, connectionHandle);
    }

    public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
    {
        return router.Notify(payload, request);
    }

    public Task Notify(Exception unwritten, NotifyRequest request)
    {
        return router.Notify(unwritten, request);
    }

    public Task<uint> Subscribe(AnswerTarget target)
    {
        return router.Subscribe(target);
    }

    public Failure? AnsweredOf(AnswerTarget target)
    {
        return router.AnsweredOf(target);
    }

    public bool HasNotification(INotificationLike notification)
    {
        return router.HasNotification(notification);
    }

    public Task RegisterNotification(INotificationLike notification)
    {
        return router.RegisterNotification(notification);
    }

    public Task UnregisterNotification(INotificationLike notification, bool cancel = true)
    {
        return router.UnregisterNotification(notification, cancel);
    }
}
