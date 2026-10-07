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

    public BeforeRequest RequireSessionOrCredential
    {
        get
        {
            return server.RequireSessionOrCredential;
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

    /// <summary>Whether each resolver registered forwards a credential unresolved, as a relay's does.</summary>
    public bool ForwardsCredentials { get; set; }

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

    public void RegisterResolver(IRequestResolver resolver)
    {
        lock (Declared)
        {
            Declared.Add($"resolver {resolver.Procedure.ProcedureName}");
        }

        router.RegisterResolver(ForwardsCredentials ? new Forwarding(resolver) : resolver);
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

    // a resolver that forwards a credential unresolved: a call presenting one reaches its admission
    // in no session, the one way such a call meets a session's rule there (spec 9.2, step 5)
    private sealed class Forwarding(IRequestResolver resolver) : IRequestResolver
    {
        public Procedure Procedure
        {
            get
            {
                return resolver.Procedure;
            }
        }

        public int? MaximumPayloadBytes
        {
            get
            {
                return resolver.MaximumPayloadBytes;
            }
        }

        public bool ForwardsCredentials
        {
            get
            {
                return true;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return resolver.Admit(request);
        }

        public Task Handle(RequestResolverProps props)
        {
            return resolver.Handle(props);
        }
    }
}
