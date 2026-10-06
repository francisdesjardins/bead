namespace Bead;

/// <summary>What a client side is given: its Bead client, and a window for each procedure that notifies.</summary>
public sealed record ServiceClientOptions
{
    /// <summary>The Bead client it calls through.</summary>
    public required IClient Client { get; init; }

    /// <summary>
    /// The window of each procedure that notifies, by its name, above 0: its subscription paced at
    /// it (spec 11.4). One not given goes unpaced. A window for a procedure the service lacks, or
    /// one that does not notify, is an <see cref="ArgumentException"/>.
    /// </summary>
    public IReadOnlyDictionary<string, int> Windows { get; init; } = new Dictionary<string, int>();

    /// <summary>
    /// Whether each requester checks a request's value by its procedure's <c>Validate</c> before it
    /// is written, so that a call that would be refused fails before it goes; none does by default.
    /// </summary>
    public bool Validates { get; init; }
}

/// <summary>
/// The client side of the service whose type tag is <typeparamref name="TService"/>, over one Bead
/// client: a requester of each procedure its server answers and a notification of each that
/// notifies, each made once, as the client side is built, at the windows its caller gives; and a
/// resolver of each command it answers, by <see cref="On"/>.
/// </summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
public sealed class ServiceClient<TService>
{
    // the admission of a command that needs a session, built from the client router's own failures
    private static readonly BeforeRequest SessionRequired = new(
        (request) =>
        {
            return request.Session is not null;
        },
        Failure.OfProtocol(ProtocolCode.SessionRequired));

    private readonly Lock _gate = new();
    private readonly ServiceManager _services;
    private readonly Dictionary<ProcedureAddress, IServiceProcedure<TService>> _procedures = [];
    private readonly Dictionary<ProcedureAddress, object> _requesters = [];
    private readonly Dictionary<ProcedureAddress, object> _notifications = [];
    private readonly HashSet<ProcedureAddress> _answered = [];

    /// <summary>
    /// The client side of <paramref name="procedures"/>: two at one address, one the service layer
    /// did not describe, and a window for a procedure the service lacks or one that does not notify,
    /// are an <see cref="ArgumentException"/>; a window below 1 too, as its notification refuses it.
    /// A procedure its client's services hold already at another window, a second client side over
    /// one Bead client, is an <see cref="InvalidOperationException"/>.
    /// </summary>
    public ServiceClient(IReadOnlyList<IServiceProcedure<TService>> procedures, ServiceClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(procedures);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Client, nameof(options));

        _services = options.Client.Services;

        foreach (var procedure in procedures)
        {
            ServiceLayer.Hold(_procedures, procedure);
        }

        var notifying = _procedures.Values.Where((procedure) =>
        {
            return procedure.Procedure.ProcedureKind == ProcedureKind.Notifies;
        }).ToDictionary(
            (procedure) =>
            {
                return procedure.Procedure.ProcedureName;
            },
            StringComparer.Ordinal);

        foreach (var name in options.Windows.Keys)
        {
            if (!notifying.ContainsKey(name))
            {
                throw new ArgumentException($"a window is given for {name}, which is no procedure of this service that notifies", nameof(options));
            }
        }

        // * each requester and notification made once, as the client side is built (decision 0013)
        foreach (var procedure in _procedures.Values.Where((procedure) =>
        {
            return !ServiceLayer.IsCommand(procedure);
        }))
        {
            var described = (IDescribedProcedure)procedure;
            var address = procedure.Procedure.Address;

            _requesters[address] = described.RequesterOn(_services, options.Validates);

            if (procedure.Procedure.ProcedureKind == ProcedureKind.Notifies)
            {
                _notifications[address] = described.NotificationOn(
                    _services,
                    options.Windows.TryGetValue(procedure.Procedure.ProcedureName, out var window) ? window : null)!;
            }
        }
    }

    /// <summary>The requester of a request: given its request, the call. A procedure the service lacks is an <see cref="ArgumentException"/>.</summary>
    public Func<TRequest, BoundCall<TResult>> RequesterOf<TRequest, TResult, TFailure>(RequestProcedure<TService, TRequest, TResult, TFailure> procedure)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);

        return (Func<TRequest, BoundCall<TResult>>)MadeOf((procedure, _requesters));
    }

    /// <summary>
    /// The requester of a procedure that notifies: its calls open no subscription (spec 11.2), which
    /// its notification's registrations do. A procedure the service lacks is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public Func<TRequest, BoundCall<TResult>> RequesterOf<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);

        return (Func<TRequest, BoundCall<TResult>>)MadeOf((procedure, _requesters));
    }

    /// <summary>
    /// The notification of a procedure that notifies, at the window the options gave it, or none.
    /// A procedure the service lacks is an <see cref="ArgumentException"/>.
    /// </summary>
    public INotification<TRequest, TNotification> NotificationOf<TRequest, TResult, TNotification, TFailure>(
        RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> procedure)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);

        return (INotification<TRequest, TNotification>)MadeOf((procedure, _notifications));
    }

    /// <summary>
    /// Registers the resolver of a command it answers, its admission its rule's: a call in no session
    /// refused SESSION_REQUIRED for a session's. A command the service lacks, one admitted by a hook,
    /// which a client side is given none of, and one given its resolver already, are an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public void On<TRequest, TResult, TFailure>(
        CommandProcedure<TService, TRequest, TResult, TFailure> procedure,
        ServiceResolverCallback<TRequest, TResult, TFailure> callback)
        where TFailure : IApplicationFailure
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(callback);
        ServiceLayer.CheckKnown(_procedures, procedure);

        if (procedure.Admission.HookName is { } hook)
        {
            throw new ArgumentException(
                $"{procedure.Procedure.ProcedureName} is admitted by the hook {hook}, which a client side is given none of",
                nameof(procedure));
        }

        var address = procedure.Procedure.Address;
        var bindings = procedure.Bindings;

        lock (_gate)
        {
            if (!_answered.Add(address))
            {
                throw new ArgumentException($"{procedure.Procedure.ProcedureName} is already a registered resolver", nameof(procedure));
            }
        }

        try
        {
            _services.GetCommandResolver(
                procedure.Procedure,
                new RequestResolverDependencies<TRequest, TResult>
                {
                    // * a client's router resolves a command's credential to a session as a server
                    // does, so a session's rule is the same on both ends of a call (decision 0018)
                    BeforeRequest = procedure.Admission.Kind == AdmissionKind.Session ? SessionRequired : null,
                    Serializer = new ServerCodecs<TRequest, TResult>(bindings.Request, bindings.Result),
                })((request, response) =>
                {
                    bindings.Validate?.Invoke(request.Payload);

                    return callback(request, new ServiceResponse<TResult, TFailure>(response));
                });
        }
        catch
        {
            lock (_gate)
            {
                _answered.Remove(address);
            }

            throw;
        }
    }

    // what was made for a procedure of the service, as it was built
    private object MadeOf((IServiceProcedure<TService> Procedure, Dictionary<ProcedureAddress, object> Made) asked)
    {
        ServiceLayer.CheckKnown(_procedures, asked.Procedure);

        return asked.Made[asked.Procedure.Procedure.Address];
    }
}
