namespace Bead;

/// <summary>
/// How a resolver of the service layer answers its request, once: a result, a failure its procedure
/// lists, or a refusal of admission.
/// </summary>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures its procedure lists.</typeparam>
public interface IServiceResponse<TResult, TFailure>
    where TFailure : IApplicationFailure
{
    /// <summary>Answers with <paramref name="result"/>.</summary>
    Task Answer(TResult result);

    /// <summary>Answers with a failure its procedure lists, and why.</summary>
    Task Fail(TFailure failure, string detail = "");

    /// <summary>Answers with a refusal of admission.</summary>
    Task Fail(AdmissionFailure refusal);
}

/// <summary>As <see cref="IServiceResponse{TResult, TFailure}"/>, for a procedure that notifies: it may subscribe first.</summary>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures its procedure lists.</typeparam>
public interface IServiceNotificationResponse<TResult, TFailure> : IServiceResponse<TResult, TFailure>
    where TFailure : IApplicationFailure
{
    /// <summary>Subscribes the requester now, as <see cref="INotificationResponse{TPayload}.RegisterNotification"/> does.</summary>
    Task<uint> RegisterNotification();
}

/// <summary>What answers the calls of a procedure of the service layer, decoded.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures its procedure lists.</typeparam>
public delegate Task ServiceResolverCallback<TRequest, TResult, TFailure>(RequestProps<TRequest> request, IServiceResponse<TResult, TFailure> response)
    where TFailure : IApplicationFailure;

/// <summary>What answers the calls of a procedure of the service layer that notifies, decoded; it may subscribe first.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures its procedure lists.</typeparam>
public delegate Task ServiceNotificationResolverCallback<TRequest, TResult, TFailure>(RequestProps<TRequest> request, IServiceNotificationResponse<TResult, TFailure> response)
    where TFailure : IApplicationFailure;

/// <summary>
/// The hooks a server side of <typeparamref name="TService"/> is given, as the service layer reads
/// them: each by the name its procedures give it. A service's record of hooks, which beadc generates
/// with a required member a hook, implements it.
/// </summary>
/// <typeparam name="TService">The service's type tag: the hooks of another service are another type.</typeparam>
public interface IServiceAdmissions<TService>
{
    /// <summary>Each hook, by the name its procedures give it, in a dictionary of its own.</summary>
    IReadOnlyDictionary<string, AdmissionHook> ToDictionary();
}

/// <summary>What a server side of <typeparamref name="TService"/> is given: its hooks.</summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
public sealed record ServiceServerOptions<TService>
{
    /// <summary>
    /// The hooks its procedures name, an empty record where they name none: a hook a procedure
    /// names that they lack, one they give that no procedure names, and one that is null, are an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public required IServiceAdmissions<TService> Admissions { get; init; }

    /// <summary>
    /// Whether the judging of a request by its procedure's rules stops at its first violation,
    /// protovalidate's <c>failFast</c> (spec 18.5), its detail saying it stopped; every rule is
    /// judged by default.
    /// </summary>
    public bool FailFast { get; init; }

    /// <summary>
    /// Whether each command's requester judges its request's value by its procedure's rules before
    /// it is written, so that a call they refuse fails before it goes, with PAYLOAD_INVALID; none
    /// does by default, as a client side's options say.
    /// </summary>
    public bool Validates { get; init; }
}

/// <summary>
/// The server side of the service whose type tag is <typeparamref name="TService"/>, offered on one
/// Bead server: a resolver of each request registered by <c>On</c>, before or after
/// <see cref="Offer"/>; a requester of each command and a notifier of each procedure that notifies.
/// Each resolver and requester is declared once, its admission made of its rule as the service is
/// offered.
/// </summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
/// <typeparam name="TData">What a session of the server keeps.</typeparam>
public sealed class ServiceServer<TService, TData>
{
    private readonly Lock _gate = new();
    private readonly Dictionary<ProcedureAddress, IServiceProcedure<TService>> _procedures = [];
    private readonly IReadOnlyDictionary<string, AdmissionHook> _hooks;
    private readonly RequesterJudging _judging;

    // what registers each resolver given, kept until the service is offered, and run at once after
    private readonly Dictionary<ProcedureAddress, Action<IBeadServer<TData>>> _resolvers = [];

    // what the service holds once offered: its server, each hook's admission, each command's
    // requester, and the resolver of each procedure that notifies
    private readonly Dictionary<string, BeforeRequest> _admissions = new(StringComparer.Ordinal);
    private readonly Dictionary<ProcedureAddress, object> _commands = [];
    private readonly Dictionary<ProcedureAddress, object> _notifiers = [];
    private IBeadServer<TData>? _server;

    /// <summary>
    /// The server side of <paramref name="procedures"/>: two at one address, one the service layer
    /// did not describe, a hook a procedure names that the options lack, one they give that no
    /// procedure names, and one that is no hook, are an <see cref="ArgumentException"/>.
    /// </summary>
    public ServiceServer(IReadOnlyList<IServiceProcedure<TService>> procedures, ServiceServerOptions<TService> options)
        : this(procedures, (HooksOf(options), new RequesterJudging { FailFast = options.FailFast, Validates = options.Validates }))
    {
    }

    /// <summary>
    /// The server side of <paramref name="procedures"/>, given no options: as the constructor that
    /// takes them, for procedures that name no hook.
    /// </summary>
    public ServiceServer(IReadOnlyList<IServiceProcedure<TService>> procedures)
        : this(procedures, (new Dictionary<string, AdmissionHook>(), RequesterJudging.None))
    {
    }

    private ServiceServer(
        IReadOnlyList<IServiceProcedure<TService>> procedures,
        (IReadOnlyDictionary<string, AdmissionHook> Hooks, RequesterJudging Judging) made)
    {
        ArgumentNullException.ThrowIfNull(procedures);

        _hooks = made.Hooks;
        _judging = made.Judging;

        foreach (var procedure in procedures)
        {
            ServiceLayer.Hold(_procedures, procedure);
        }

        ServiceLayer.CheckHooks(_procedures.Values, _hooks);
    }

    // the hooks the options give, by name, read once
    private static IReadOnlyDictionary<string, AdmissionHook> HooksOf(ServiceServerOptions<TService> options)
    {
        ArgumentNullException.ThrowIfNull(options);

        // ! a record past the types, null, gives no hook, as the TypeScript side reads admissions undefined
        return options.Admissions?.ToDictionary() ?? new Dictionary<string, AdmissionHook>();
    }

    /// <summary>
    /// Registers the resolver of a request, before or after <see cref="Offer"/>: a procedure the
    /// service lacks, or one given its resolver already, is an <see cref="ArgumentException"/>.
    /// </summary>
    public void On<TRequest, TResult, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TFailure> procedure,
        ServiceResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(callback);

        var bindings = procedure.Bindings;

        Register(procedure, (server) =>
        {
            server.Services.GetRequestResolver(
                procedure.Procedure,
                new RequestResolverDependencies<TRequest, TResult>
                {
                    BeforeRequest = AdmissionOf((procedure.Admission, server)),
                    FailFast = _judging.FailFast,
                    Serializer = new ServerCodecs<TRequest, TResult>(bindings.Request, bindings.Result),

                    // * its rules judged by its service manager, after its decode and before its resolver
                    Validate = bindings.Validate,
                })((request, response) =>
                {
                    return callback(request, new ServiceResponse<TResult, TFailure>(response));
                });
        });
    }

    /// <summary>
    /// Registers the resolver of a procedure that notifies, before or after <see cref="Offer"/>, as
    /// the other <c>On</c> does.
    /// </summary>
    public void On<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure,
        ServiceNotificationResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(callback);

        var bindings = procedure.Bindings;

        Register(procedure, (server) =>
        {
            var resolver = server.Services.GetNotificationResolver(
                procedure.Procedure,
                new NotificationResolverDependencies<TRequest, TResult, TNotification>
                {
                    BeforeRequest = AdmissionOf((procedure.Admission, server)),
                    FailFast = _judging.FailFast,
                    Serializer = new ServerNotificationCodecs<TRequest, TResult, TNotification>(bindings),
                    Validate = bindings.Validate,
                })((request, response) =>
                {
                    return callback(request, new ServiceNotificationResponse<TResult, TFailure>(response));
                });

            lock (_gate)
            {
                _notifiers[procedure.Procedure.Address] = resolver;
            }
        });
    }

    /// <summary>
    /// Offers the service on <paramref name="server"/>: each hook's admission made, each command's
    /// requester made, and every resolver registered, now and as each is given. A second offer is an
    /// <see cref="InvalidOperationException"/>.
    /// </summary>
    public void Offer(IBeadServer<TData> server)
    {
        ArgumentNullException.ThrowIfNull(server);

        List<Action<IBeadServer<TData>>> registering;

        lock (_gate)
        {
            if (_server is not null)
            {
                throw new InvalidOperationException("this service's server side is offered already");
            }

            _server = server;

            // * each hook's admission built once, its refusal the router's own ACCESS_DENIED
            foreach (var (name, hook) in _hooks)
            {
                _admissions[name] = new BeforeRequest(hook.Admits, Failure.OfProtocol(ProtocolCode.AccessDenied, hook.Detail));
            }

            foreach (var procedure in _procedures.Values.Where(ServiceLayer.IsCommand))
            {
                _commands[procedure.Procedure.Address] = ((IDescribedProcedure)procedure).RequesterOn(server.Services, _judging);
            }

            registering = [.. _resolvers.Values];
        }

        foreach (var register in registering)
        {
            register(server);
        }
    }

    /// <summary>
    /// The requester of a command: given its request, the call to the client its options name. One
    /// called before the service is offered is an <see cref="InvalidOperationException"/>; a command
    /// the service lacks, an <see cref="ArgumentException"/>.
    /// </summary>
    public Func<TRequest, BoundCall<TResult>> CommandOf<TRequest, TResult, TFailure>(CommandProcedure<TService, TRequest, TResult, TFailure> procedure)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ServiceLayer.CheckKnown(_procedures, procedure);

        var address = procedure.Procedure.Address;

        return (request) =>
        {
            object? made;

            lock (_gate)
            {
                _commands.TryGetValue(address, out made);
            }

            if (made is not Func<TRequest, BoundCall<TResult>> requester)
            {
                throw new InvalidOperationException(
                    $"{procedure.Procedure.ProcedureName} is a command of a service not offered yet: its requester is made as the service is offered");
            }

            return requester(request);
        };
    }

    /// <summary>
    /// What notifies the subscribers of a procedure that notifies, as its options filter them: before
    /// the service is offered, or before its resolver is registered, it sends nothing and resolves. A
    /// procedure the service lacks is an <see cref="ArgumentException"/>.
    /// </summary>
    public Func<TNotification, NotifyOptions?, Task> NotifierOf<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ServiceLayer.CheckKnown(_procedures, procedure);

        var address = procedure.Procedure.Address;

        return (notification, options) =>
        {
            object? resolver;

            lock (_gate)
            {
                _notifiers.TryGetValue(address, out resolver);
            }

            return resolver is INotificationResolver<TNotification> notifier ? notifier.Notify(notification, options) : Task.CompletedTask;
        };
    }

    /// <summary>The procedures a client calls that no <c>On</c> answers: the router answers them PROCEDURE_UNKNOWN.</summary>
    public IReadOnlyList<Procedure> ProceduresWithoutResolver()
    {
        lock (_gate)
        {
            return [.. _procedures.Values.Where((procedure) =>
            {
                return !ServiceLayer.IsCommand(procedure) && !_resolvers.ContainsKey(procedure.Procedure.Address);
            }).Select((procedure) =>
            {
                return procedure.Procedure;
            })];
        }
    }

    // a resolver given: kept, and registered at once once the service is offered; a second for its
    // procedure refused, as the router refuses one
    private void Register(IServiceProcedure<TService> procedure, Action<IBeadServer<TData>> register)
    {
        ServiceLayer.CheckKnown(_procedures, procedure);

        IBeadServer<TData>? server;

        lock (_gate)
        {
            if (_resolvers.ContainsKey(procedure.Procedure.Address))
            {
                throw new ArgumentException($"{procedure.Procedure.ProcedureName} is already a registered resolver", nameof(procedure));
            }

            server = _server;

            if (server is null)
            {
                _resolvers[procedure.Procedure.Address] = register;

                return;
            }
        }

        // registered first, so one the router refuses is not kept
        register(server);

        lock (_gate)
        {
            _resolvers[procedure.Procedure.Address] = register;
        }
    }

    // the admission of a rule on the server it is offered on: none for every call, the server's own
    // for a session, and the hook's, made once, for a hook
    private BeforeRequest? AdmissionOf((AdmissionRule Rule, IBeadServer<TData> Server) admitting)
    {
        var (rule, server) = admitting;

        return rule.Kind switch
        {
            AdmissionKind.Session => server.RequireSession,
            AdmissionKind.Hook => _admissions[rule.HookName!],
            _ => null,
        };
    }
}

/// <summary>What the server side and the client side of a service check alike.</summary>
internal static class ServiceLayer
{
    /// <summary>
    /// Holds a descriptor by its address: one the service layer did not describe, and a second at
    /// one address, are an <see cref="ArgumentException"/>.
    /// </summary>
    public static void Hold<TService>(Dictionary<ProcedureAddress, IServiceProcedure<TService>> procedures, IServiceProcedure<TService> procedure)
    {
        ArgumentNullException.ThrowIfNull(procedure);

        if (procedure is not IDescribedProcedure)
        {
            throw new ArgumentException(
                $"{procedure.Procedure.ProcedureName} is no descriptor of the service layer's: a RequestProcedure or a CommandProcedure",
                nameof(procedure));
        }

        if (!procedures.TryAdd(procedure.Procedure.Address, procedure))
        {
            throw new ArgumentException(
                $"{procedure.Procedure.ProcedureName} is at {procedure.Procedure.ServiceId}/{procedure.Procedure.ProcedureId}, where the service holds another",
                nameof(procedure));
        }
    }

    /// <summary>
    /// Refuses, with an <see cref="ArgumentException"/>, a hook a procedure names that
    /// <paramref name="hooks"/> lacks; then, each hook it gives in turn, one that no procedure names,
    /// and one that is no hook, null or without its <c>Admits</c>.
    /// </summary>
    public static void CheckHooks<TService>(IEnumerable<IServiceProcedure<TService>> procedures, IReadOnlyDictionary<string, AdmissionHook> hooks)
    {
        var named = new HashSet<string>(StringComparer.Ordinal);

        foreach (var procedure in procedures)
        {
            if (procedure.Admission.HookName is { } name)
            {
                if (!hooks.ContainsKey(name))
                {
                    throw new ArgumentException($"a procedure names the hook {name}, which the options lack", nameof(hooks));
                }

                named.Add(name);
            }
        }

        foreach (var (name, hook) in hooks)
        {
            if (!named.Contains(name))
            {
                throw new ArgumentException($"the options give the hook {name}, which no procedure names", nameof(hooks));
            }

            if (hook?.Admits is null)
            {
                throw new ArgumentException($"the hook {name} admits by a function, Admits", nameof(hooks));
            }
        }
    }

    /// <summary>Refuses, with an <see cref="ArgumentException"/>, a descriptor the service does not hold.</summary>
    public static void CheckKnown<TService>(Dictionary<ProcedureAddress, IServiceProcedure<TService>> procedures, IServiceProcedure<TService> procedure)
    {
        if (!procedures.TryGetValue(procedure.Procedure.Address, out var held) || !ReferenceEquals(held, procedure))
        {
            throw new ArgumentException($"{procedure.Procedure.ProcedureName} is no procedure of this service", nameof(procedure));
        }
    }

    /// <summary>Whether a descriptor is a command's.</summary>
    public static bool IsCommand<TService>(IServiceProcedure<TService> procedure)
    {
        return procedure.Procedure.ProcedureKind == ProcedureKind.Command;
    }
}

/// <summary>A resolver's answer, as the service layer narrows it: a result, a failure its procedure lists, or a refusal.</summary>
internal sealed class ServiceResponseOf<TResult>(IResponse<TResult> response)
{
    public Task Answer(TResult result)
    {
        return response.Answer(result);
    }

    public Task Fail(IApplicationFailure failure, string detail)
    {
        ArgumentNullException.ThrowIfNull(failure);
        ArgumentNullException.ThrowIfNull(detail);

        return response.Fail(Failure.OfApplication(failure.Code, detail));
    }

    public Task Fail(AdmissionFailure refusal)
    {
        ArgumentNullException.ThrowIfNull(refusal);

        return response.Fail(refusal.Failure);
    }
}

/// <summary>A plain resolver's answer.</summary>
internal sealed class ServiceResponse<TResult, TFailure>(IResponse<TResult> response) : IServiceResponse<TResult, TFailure>
    where TFailure : IApplicationFailure
{
    private readonly ServiceResponseOf<TResult> _response = new(response);

    public Task Answer(TResult result)
    {
        return _response.Answer(result);
    }

    public Task Fail(TFailure failure, string detail = "")
    {
        return _response.Fail(failure, detail);
    }

    public Task Fail(AdmissionFailure refusal)
    {
        return _response.Fail(refusal);
    }
}

/// <summary>The answer of a resolver that notifies, which may subscribe first.</summary>
internal sealed class ServiceNotificationResponse<TResult, TFailure>(INotificationResponse<TResult> response) : IServiceNotificationResponse<TResult, TFailure>
    where TFailure : IApplicationFailure
{
    private readonly ServiceResponseOf<TResult> _response = new(response);

    public Task Answer(TResult result)
    {
        return _response.Answer(result);
    }

    public Task Fail(TFailure failure, string detail = "")
    {
        return _response.Fail(failure, detail);
    }

    public Task Fail(AdmissionFailure refusal)
    {
        return _response.Fail(refusal);
    }

    public Task<uint> RegisterNotification()
    {
        return response.RegisterNotification();
    }
}
