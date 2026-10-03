namespace Bead;

/// <summary>
/// The part of a router a service manager calls: it registers the resolvers, answers through the
/// router, and names the side whose failures it raises and the clock the manager runs on.
/// </summary>
public interface IRouterLike
{
    /// <summary>Which side the router is.</summary>
    RouterSide Side { get; }

    /// <summary>What the router's timers run on: its transport's clock.</summary>
    TimeProvider Clock { get; }

    /// <summary>Registers a resolver; a second one for its procedure is an <see cref="ArgumentException"/>.</summary>
    void RegisterResolver(IRequestResolver resolver);

    /// <summary>Answers a request, while its call is open.</summary>
    Task Respond(RouterAnswer response, AnswerTarget target);

    /// <summary>Sends a request, and settles with its result.</summary>
    Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request);

    /// <summary>
    /// Notifies the connections subscribed to a procedure: a server's router does; a client's, which
    /// notifies nobody, throws an <see cref="InvalidOperationException"/>.
    /// </summary>
    Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request);

    /// <summary>
    /// Subscribes the connection a request came from to that request's procedure, and gives the call
    /// id of the subscription: a server's router does; a client's cannot.
    /// </summary>
    Task<uint> Subscribe(AnswerTarget target);

    /// <summary>Whether the router holds this notification — this one, not another of its procedure.</summary>
    bool HasNotification(INotificationLike notification);

    /// <summary>
    /// Holds a notification for its procedure: a client's router does, a second for the same
    /// procedure an <see cref="InvalidOperationException"/>; a server's, which subscribes nobody,
    /// cannot.
    /// </summary>
    Task RegisterNotification(INotificationLike notification);

    /// <summary>
    /// Holds a notification no more, and unbinds the call it is bound to: unless
    /// <paramref name="cancel"/> is false — its subscription taken away already, acknowledged — the
    /// peer is sent a cancel. The call id is reserved either way.
    /// </summary>
    Task UnregisterNotification(INotificationLike notification, bool cancel = true);
}

/// <summary>
/// How the side that asks writes a request and reads its answer. What does not decode throws, and
/// its call fails with <see cref="ProtocolCode.PayloadUndecodable"/>.
/// </summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public interface IRequestSerializerClient<TRequest, TResponse>
{
    /// <summary>A request's payload, encoded.</summary>
    ReadOnlyMemory<byte> Encode(TRequest request);

    /// <summary>A result's payload, decoded.</summary>
    TResponse Decode(ReadOnlyMemory<byte> response);
}

/// <summary>What a requester of a procedure needs: how its payloads are written.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public sealed record RequestDependencies<TRequest, TResponse>
{
    /// <summary>How its payloads are written and read.</summary>
    public required IRequestSerializerClient<TRequest, TResponse> Serializer { get; init; }
}

/// <summary>One call of a procedure, its payload given: its options, when any, then its result.</summary>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public delegate Task<TResponse> Requester<TResponse>(RequestOptions? options = null);

/// <summary>
/// How the side that answers a request reads it and writes the answer. A failure is the router's to
/// write. What does not decode throws, and its request is answered with
/// <see cref="ProtocolCode.PayloadUndecodable"/>.
/// </summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public interface IRequestSerializerServer<TRequest, TResponse>
{
    /// <summary>A request's payload, decoded.</summary>
    TRequest Decode(ReadOnlyMemory<byte> request);

    /// <summary>A result's payload, encoded.</summary>
    ReadOnlyMemory<byte> Encode(TResponse response);
}

/// <summary>
/// Whether a request may reach a resolver, on its header alone: only <c>true</c> admits it; anything
/// else refuses it, with <see cref="Refusal"/>, or with <see cref="ProtocolCode.AccessDenied"/>.
/// </summary>
public sealed class BeforeRequest
{
    private readonly Func<AdmissionRequest, bool> _admits;

    /// <summary>
    /// An admission; its refusal, when given, is <see cref="ProtocolCode.SessionRequired"/> or
    /// <see cref="ProtocolCode.AccessDenied"/>, or it is an <see cref="ArgumentException"/>.
    /// </summary>
    public BeforeRequest(Func<AdmissionRequest, bool> admits, Failure? refusal = null)
    {
        ArgumentNullException.ThrowIfNull(admits);

        if (refusal is not null && !IsAdmissionFailure(refusal))
        {
            throw new ArgumentException("an admission refuses with SESSION_REQUIRED or ACCESS_DENIED", nameof(refusal));
        }

        _admits = admits;
        Refusal = refusal;
    }

    /// <summary>What a refused request is answered with; ACCESS_DENIED when none.</summary>
    public Failure? Refusal { get; }

    /// <summary>Whether <paramref name="failure"/> refuses admission: one of the two protocol failures that do.</summary>
    public static bool IsAdmissionFailure(Failure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure.Scope == FailureScope.Protocol
            && failure.Code is (ushort)ProtocolCode.SessionRequired or (ushort)ProtocolCode.AccessDenied;
    }

    /// <summary>Whether the request is admitted.</summary>
    public bool Admits(AdmissionRequest request)
    {
        return _admits(request);
    }
}

/// <summary>What a resolver of a procedure needs: how its payloads are written, and who it admits.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public sealed record RequestResolverDependencies<TRequest, TResponse>
{
    /// <summary>How its payloads are read and written.</summary>
    public required IRequestSerializerServer<TRequest, TResponse> Serializer { get; init; }

    /// <summary>Who it admits, on a request's header; everyone when none.</summary>
    public BeforeRequest? BeforeRequest { get; init; }
}

/// <summary>A request as a resolver's callback receives it: decoded.</summary>
/// <typeparam name="TPayload">What it carries.</typeparam>
public sealed record RequestProps<TPayload>
{
    /// <summary>The connection it came from.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>Its header.</summary>
    public required RequestHeader Header { get; init; }

    /// <summary>Its payload, decoded.</summary>
    public required TPayload Payload { get; init; }

    /// <summary>
    /// Cancelled when the call ends before its answer — its requester cancelled it, its connection
    /// closed — so the callback may stop: its answer would go nowhere.
    /// </summary>
    public required CancellationToken Signal { get; init; }
}

/// <summary>How a callback answers its request, once: with a payload, or with a failure.</summary>
/// <typeparam name="TPayload">What a result carries.</typeparam>
public interface IResponse<TPayload>
{
    /// <summary>Answers with <paramref name="payload"/>.</summary>
    Task Answer(TPayload payload);

    /// <summary>
    /// Answers with a failure: the procedure's own, of the application, or a refusal of admission.
    /// Any other is an <see cref="ArgumentException"/>, and the request is answered as failed.
    /// </summary>
    Task Fail(Failure failure);
}

/// <summary>What answers the requests of one procedure, decoded.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public delegate Task RequestResolverCallback<TRequest, TResponse>(RequestProps<TRequest> request, IResponse<TResponse> response);

/// <summary>What a notification goes to: its procedure, which connections, and its key.</summary>
/// <param name="Procedure">The procedure that notifies.</param>
/// <param name="Filter">Whether a connection subscribed gets it; each does when none.</param>
/// <param name="Key">What it replaces, queued for a paced subscription: the one of the same key.</param>
public sealed record NotifyRequest(ProcedureAddress Procedure, Func<string, bool>? Filter, object? Key);

/// <summary>Who a notification goes to, as its code says: the connections, and what it is about.</summary>
public sealed record NotifyOptions
{
    /// <summary>A connection left out: the one whose request made the change, say.</summary>
    public string? Exclude { get; init; }

    /// <summary>Whether a connection gets it: those of one user, say.</summary>
    public Func<string, bool>? Filter { get; init; }

    /// <summary>
    /// What it is about — the entity whose state it carries — for a paced subscription: queued past
    /// its credit, it replaces the one queued under the same key, in its place. The server's own: it
    /// never travels.
    /// </summary>
    public object? Key { get; init; }
}

/// <summary>A procedure's resolver that notifies its subscribers.</summary>
public interface INotificationResolver : IRequestResolver
{
}

/// <summary>A procedure's resolver that notifies its subscribers what it notifies.</summary>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public interface INotificationResolver<TNotification> : INotificationResolver
{
    /// <summary>
    /// Notifies each connection subscribed, as <paramref name="options"/> filter them; settles once
    /// each was sent or queued. What keeps one from going out is the router's to report.
    /// </summary>
    Task Notify(TNotification notification, NotifyOptions? options = null);
}

/// <summary>How the side that answers a notification's requests writes its notifications too.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public interface INotificationSerializerServer<TRequest, TResponse, TNotification> : IRequestSerializerServer<TRequest, TResponse>
{
    /// <summary>A notification's payload, encoded.</summary>
    ReadOnlyMemory<byte> EncodeNotification(TNotification notification);
}

/// <summary>What a resolver of a notification needs: how its payloads are written, and who it admits.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public sealed record NotificationResolverDependencies<TRequest, TResponse, TNotification>
{
    /// <summary>How its payloads are read and written.</summary>
    public required INotificationSerializerServer<TRequest, TResponse, TNotification> Serializer { get; init; }

    /// <summary>Who it admits, on a request's header; everyone when none.</summary>
    public BeforeRequest? BeforeRequest { get; init; }
}

/// <summary>How a notification's callback answers: as any callback does, and it may subscribe first.</summary>
/// <typeparam name="TPayload">What a result carries.</typeparam>
public interface INotificationResponse<TPayload> : IResponse<TPayload>
{
    /// <summary>
    /// Subscribes the requester to the procedure now, and gives the call id of the subscription: the
    /// request's own when it is the connection's first subscription to the procedure, and otherwise
    /// the one it holds already. A failure answer undoes it. After the answer, or for a request that
    /// opens no subscription, it is an <see cref="InvalidOperationException"/>; a connection closed,
    /// a <see cref="DisconnectException"/>; a call cancelled or answered, an
    /// <see cref="OperationCanceledException"/>. A Task, since it asks the router, on its scheduler.
    /// </summary>
    Task<uint> RegisterNotification();
}

/// <summary>What answers the requests of a notification's procedure, decoded; it may subscribe first.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public delegate Task NotificationResolverCallback<TRequest, TResponse>(RequestProps<TRequest> request, INotificationResponse<TResponse> response);

/// <summary>What a call is: a request, a notification, or a command — a request the server makes of a client.</summary>
public enum DebugType
{
    /// <summary>A request the server makes of a client.</summary>
    Command,

    /// <summary>A notification, sent or heard.</summary>
    Notification,

    /// <summary>A request, made or answered.</summary>
    Request,
}

/// <summary>What one step of a call tells whoever hears a manager's <c>Debug</c>.</summary>
public sealed record DebugEvent
{
    /// <summary>Whether it went out or came in.</summary>
    public required DebugDirection Direction { get; init; }

    /// <summary>
    /// How long the call took once it answered, in whole milliseconds of its router clock's
    /// monotonic reading, a fraction dropped; none before, and for a notification. A span's duration,
    /// as <see cref="System.Diagnostics.Activity.Duration"/> and an OpenTelemetry span carry it.
    /// </summary>
    public TimeSpan? Duration { get; init; }

    /// <summary>The call's options, its defaults applied; none for a step that has none.</summary>
    public ResolvedRequestOptions? Options { get; init; }

    /// <summary>The procedure's number in its service.</summary>
    public required ushort ProcedureId { get; init; }

    /// <summary>The procedure's name.</summary>
    public required string ProcedureName { get; init; }

    /// <summary>What came in, decoded; a failure, for a call that failed.</summary>
    public object? Rx { get; init; }

    /// <summary>The procedure's service.</summary>
    public required ushort ServiceId { get; init; }

    /// <summary>The revision of the procedure's service.</summary>
    public required int ServiceRevision { get; init; }

    /// <summary>
    /// When the call started, on its router clock's wall reading; a notification, one step, starts
    /// as it is sent or heard. A span's start, as <see cref="System.Diagnostics.Activity.StartTimeUtc"/>
    /// and an OpenTelemetry span's start time carry it.
    /// </summary>
    public required DateTimeOffset StartedAt { get; init; }

    /// <summary>What went out, decoded.</summary>
    public object? Tx { get; init; }

    /// <summary>What the call is.</summary>
    public required DebugType Type { get; init; }
}

/// <summary>What a call's options leave out, for a manager to fill.</summary>
public sealed record RequestDefaults
{
    /// <summary>How long a call waits for its answer; 5 s when none.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>Whether a command unanswered in time closes the connection it went to; none closes nothing.</summary>
    public bool? CloseOnTimeout { get; init; }
}

/// <summary>How a service manager is built.</summary>
public sealed record ServiceManagerOptions
{
    /// <summary>
    /// Closes a connection that let a command go unanswered, when the call's
    /// <see cref="RequestOptions.CloseOnTimeout"/>, or the manager's default, says so. A server gives
    /// it; a client has no connection to name.
    /// </summary>
    public Action<string>? CloseConnection { get; init; }

    /// <summary>What a call's options leave out.</summary>
    public RequestDefaults? Defaults { get; init; }

    /// <summary>
    /// What a trace's instants are read from: its router's clock when none; another is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public TimeProvider? Clock { get; init; }
}

/// <summary>
/// The requesters and resolvers of the services on one router: what a requester calls, and what
/// answers it on the other side. Both sides of a router use the same manager.
/// </summary>
public sealed class ServiceManager
{
    // how long a request waits for its answer when its options and the manager's say nothing
    private static readonly TimeSpan TimeoutDefault = TimeSpan.FromSeconds(5);

    private readonly IRouterLike _router;
    private readonly Action<string>? _closeConnection;
    private readonly RequestDefaults _defaults;
    private readonly TimeProvider _clock;

    // the notifications this manager made, one per procedure, kept for its life: asked for again,
    // the same one is given
    private readonly Dictionary<ProcedureAddress, (Procedure Procedure, object Notification)> _notifications = [];

    /// <summary>
    /// A manager of the services on <paramref name="router"/>, with its options, on its router's
    /// clock: one given that differs is an <see cref="ArgumentException"/>.
    /// </summary>
    public ServiceManager(IRouterLike router, ServiceManagerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(router);

        _router = router;
        _closeConnection = options?.CloseConnection;
        _defaults = options?.Defaults ?? new RequestDefaults();
        _clock = Clocks.Of((options?.Clock, router.Clock), ("a service manager", "its router"));
    }

    /// <summary>A notification dropped: its procedure, and the failure the other end ended it with, if any.</summary>
    public event Action<Procedure, Failure?>? Dropped;

    /// <summary>
    /// One step of a call — a request made or answered, a command, a notification sent or heard —
    /// and the exception it failed with, or none. Nothing is built when nobody hears it.
    /// </summary>
    public event Action<Exception?, DebugEvent>? Debug;

    /// <summary>A deprecated procedure was called; its deprecation says what to use instead, when it says.</summary>
    public event Action<Procedure>? Deprecated;

    /// <summary>Whether anyone hears <see cref="Debug"/>: nothing is traced while nobody does.</summary>
    public bool IsDebugging
    {
        get
        {
            return Debug is not null;
        }
    }

    /// <summary>
    /// The notification of <paramref name="procedure"/>, which callbacks register on: the first
    /// registration subscribes, by a request that opens a subscription — paced, with a window — and
    /// the last one taken away unsubscribes. The same procedure asked for again gives the same
    /// notification; asked for differently, it is an <see cref="InvalidOperationException"/>.
    /// </summary>
    public INotification<TRequest, TNotification> GetNotification<TRequest, TResponse, TNotification>(
        Procedure procedure,
        NotificationDependencies<TRequest, TResponse, TNotification> dependencies)
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(dependencies);

        lock (_notifications)
        {
            // the router holds one notification per procedure, so a second one would never be triggered
            if (_notifications.TryGetValue(procedure.Address, out var known))
            {
                if (known.Procedure != procedure || known.Notification is not INotification<TRequest, TNotification> same)
                {
                    throw new InvalidOperationException(
                        $"{procedure.ServiceId}/{procedure.ProcedureId} is already a notification, asked for otherwise");
                }

                return same;
            }

            var notification = new Notification<TRequest, TResponse, TNotification>(
                procedure,
                (_router, dependencies),
                ((payload, call) =>
                {
                    return CallOf(payload, (procedure, dependencies.Serializer, call.Options, (DebugType.Request, call.Subscribes)));
                },
                (failure) =>
                {
                    Dropped?.Invoke(procedure, failure);
                },
                (error, notification) =>
                {
                    Trace(procedure, new DebugStep(DebugDirection.Rx, DebugType.Notification) { Error = error, Rx = notification, Started = StartedNow() });
                }
            ));

            _notifications[procedure.Address] = (procedure, notification);

            return notification;
        }
    }

    /// <summary>
    /// A requester of <paramref name="procedure"/>: given a payload, then options, it calls the
    /// procedure and gives its result, decoded. A failure answered, or one of the router's, throws a
    /// <see cref="FailureException"/>; a result that does not decode, one of
    /// <see cref="ProtocolCode.PayloadUndecodable"/>.
    /// </summary>
    public Func<TRequest, Requester<TResponse>> GetRequest<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies)
    {
        return RequesterOf(procedure, (dependencies, DebugType.Request));
    }

    /// <summary>
    /// A requester of a command: what a server asks its client, the connection named in its
    /// options. A requester as <see cref="GetRequest{TRequest, TResponse}"/> gives one; one
    /// unanswered in time closes its connection when its options, or the manager's defaults, say so.
    /// </summary>
    public Func<TRequest, Requester<TResponse>> GetCommand<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies)
    {
        return RequesterOf(procedure, (dependencies, DebugType.Command));
    }

    /// <summary>
    /// The resolver of a command, which a client offers its server: a resolver as
    /// <see cref="GetRequestResolver{TRequest, TResponse}"/> gives one.
    /// </summary>
    public Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> GetCommandResolver<TRequest, TResponse>(
        Procedure procedure,
        RequestResolverDependencies<TRequest, TResponse> dependencies)
    {
        return ResolverOf(procedure, (dependencies, DebugType.Command));
    }

    /// <summary>
    /// The resolver of <paramref name="procedure"/>: given its callback, it is registered on the
    /// router. A request is answered once — by its callback, by a refusal of its admission, with
    /// PAYLOAD_UNDECODABLE when it does not decode, or with PROCEDURE_FAILED when its callback
    /// throws before it answered.
    /// </summary>
    public Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> GetRequestResolver<TRequest, TResponse>(
        Procedure procedure,
        RequestResolverDependencies<TRequest, TResponse> dependencies)
    {
        return ResolverOf(procedure, (dependencies, DebugType.Request));
    }

    /// <summary>
    /// The resolver of a notification's <paramref name="procedure"/>: a resolver as
    /// <see cref="GetRequestResolver{TRequest, TResponse}"/> gives one, whose callback may subscribe
    /// its requester first, and which notifies its subscribers. A successful answer to a request that
    /// opens a subscription subscribes its requester all the same.
    /// </summary>
    public Func<NotificationResolverCallback<TRequest, TResponse>, INotificationResolver<TNotification>> GetNotificationResolver<TRequest, TResponse, TNotification>(
        Procedure procedure,
        NotificationResolverDependencies<TRequest, TResponse, TNotification> dependencies)
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(dependencies);

        return (callback) =>
        {
            ArgumentNullException.ThrowIfNull(callback);

            var resolver = new NotificationResolver<TRequest, TResponse, TNotification>(
                this,
                (new Resolver<TRequest, TResponse>(
                    this,
                    new ResolverMade<TRequest, TResponse>(
                        procedure,
                        dependencies.Serializer,
                        dependencies.BeforeRequest,
                        (request, response) =>
                        {
                            return callback(request, response);
                        },
                        DebugType.Request)),
                dependencies.Serializer));

            _router.RegisterResolver(resolver);

            return resolver;
        };
    }

    // the failure a failed call carries, for a trace; none when it carries none
    private static Failure? TracedFailureOf(Exception reason)
    {
        return reason is FailureException failure ? failure.Failure : null;
    }

    // now, for a call starting: the instant it is told at, on the wall clock, and the reading its
    // duration counts from, on the monotonic one
    private Started StartedNow()
    {
        return new Started(_clock.GetUtcNow(), _clock.GetTimestamp());
    }

    // tells Debug of one step of a call; nothing is built when nobody hears it
    private void Trace(Procedure procedure, DebugStep step)
    {
        if (Debug is not { } debug)
        {
            return;
        }

        debug(step.Error, new DebugEvent
        {
            Direction = step.Direction,
            Duration = step.IsAnswered ? WholeMillisecondsOf(_clock.GetElapsedTime(step.Started.Timestamp)) : null,
            Options = step.Options,
            ProcedureId = procedure.ProcedureId,
            ProcedureName = procedure.ProcedureName,
            Rx = step.Rx,
            ServiceId = procedure.ServiceId,
            ServiceRevision = procedure.ServiceRevision,
            StartedAt = step.Started.Instant,
            Tx = step.Tx,
            Type = step.Type,
        });
    }

    // a time in whole milliseconds, a fraction dropped
    private static TimeSpan WholeMillisecondsOf(TimeSpan time)
    {
        return TimeSpan.FromTicks(time.Ticks - (time.Ticks % TimeSpan.TicksPerMillisecond));
    }

    // a requester: given a payload, then options, one call
    private Func<TRequest, Requester<TResponse>> RequesterOf<TRequest, TResponse>(
        Procedure procedure,
        (RequestDependencies<TRequest, TResponse> Dependencies, DebugType Type) made)
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(made.Dependencies);

        async Task<TResponse> Called(TRequest payload, RequestOptions? options)
        {
            return (await CallOf(payload, (procedure, made.Dependencies.Serializer, options, (made.Type, null)))).Response;
        }

        return (payload) =>
        {
            return (options) =>
            {
                return Called(payload, options);
            };
        };
    }

    // a resolver of a request or a command: given its callback, it is registered on the router
    private Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> ResolverOf<TRequest, TResponse>(
        Procedure procedure,
        (RequestResolverDependencies<TRequest, TResponse> Dependencies, DebugType Type) made)
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(made.Dependencies);

        return (callback) =>
        {
            ArgumentNullException.ThrowIfNull(callback);

            var resolver = new Resolver<TRequest, TResponse>(
                this,
                new ResolverMade<TRequest, TResponse>(
                    procedure,
                    made.Dependencies.Serializer,
                    made.Dependencies.BeforeRequest,
                    (request, response) =>
                    {
                        return callback(request, response);
                    },
                    made.Type));

            _router.RegisterResolver(resolver);

            return resolver;
        };
    }

    // a call's options, with the defaults applied: the call's, then the manager's, then 5 s and no close
    private ResolvedRequestOptions OptionsOf(RequestOptions? given)
    {
        return new ResolvedRequestOptions
        {
            CancellationToken = given?.CancellationToken ?? CancellationToken.None,
            CloseOnTimeout = given?.CloseOnTimeout ?? _defaults.CloseOnTimeout,
            ConnectionHandle = given?.ConnectionHandle,
            DestinationId = given?.DestinationId,
            Timeout = given?.Timeout ?? _defaults.Timeout ?? TimeoutDefault,
        };
    }

    // a result decoded; one that does not decode fails here, with the result's header
    private TResponse DecodeOf<TRequest, TResponse>(
        RouterResult result,
        (Procedure Procedure, IRequestSerializerClient<TRequest, TResponse> Serializer, ResolvedRequestOptions Options) call)
    {
        try
        {
            return call.Serializer.Decode(result.Payload);
        }
        catch (Exception reason)
        {
            throw new FailureException(
                Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message),
                (new FailureException.Raised(FailureOrigin.Local, _router.Side), reason))
            {
                DestinationId = call.Options.DestinationId,
                Header = result.Header,
                ProcedureAddress = call.Procedure.Address,
            };
        }
    }

    // one call — a request, a command, or the request that subscribes a notification: its options
    // with the defaults applied, its trace, the request, the close on timeout, and its result decoded
    private async Task<(uint CallId, TResponse Response)> CallOf<TRequest, TResponse>(
        TRequest payload,
        (Procedure Procedure, IRequestSerializerClient<TRequest, TResponse> Serializer, RequestOptions? Options, (DebugType Type, INotificationLike? Subscribes) Made) call)
    {
        var (procedure, serializer, given, (type, subscribes)) = call;
        var options = OptionsOf(given);
        var step = new DebugStep(DebugDirection.Tx, type) { Options = options, Started = StartedNow(), Tx = payload };

        // what the call fails with once it went out is told as its answer
        void Failed(Exception reason)
        {
            Trace(procedure, step with { Direction = DebugDirection.Rx, Error = reason, IsAnswered = true, Rx = TracedFailureOf(reason) });
        }

        Trace(procedure, step);

        if (procedure.Deprecation is not null)
        {
            Deprecated?.Invoke(procedure);
        }

        var encoded = serializer.Encode(payload);
        RouterResult result;

        try
        {
            result = await _router.Request(encoded, new RouterRequest(procedure, options) { Subscribes = subscribes });
        }
        catch (Exception reason)
        {
            // a connection that let it go unanswered is closed, when the call or the manager says so
            if (reason is TimeoutException && options.CloseOnTimeout == true && options.ConnectionHandle is { } connectionHandle)
            {
                _closeConnection?.Invoke(connectionHandle);
            }

            Failed(reason);

            throw;
        }

        TResponse response;

        try
        {
            response = DecodeOf(result, (procedure, serializer, options));
        }
        catch (FailureException reason)
        {
            Failed(reason);

            throw;
        }

        Trace(procedure, step with { Direction = DebugDirection.Rx, IsAnswered = true, Rx = response });

        return (result.Header.CallId, response);
    }

    // one step of a call, as Trace tells it
    private sealed record DebugStep(DebugDirection Direction, DebugType Type)
    {
        public Exception? Error { get; init; }

        public bool IsAnswered { get; init; }

        public ResolvedRequestOptions? Options { get; init; }

        public object? Rx { get; init; }

        // when its call started: every step of one call carries the same
        public required Started Started { get; init; }

        public object? Tx { get; init; }
    }

    // when a call started: its instant on the wall clock, and the monotonic reading its duration counts from
    private readonly record struct Started(DateTimeOffset Instant, long Timestamp);

    // what a resolver is made of: its procedure, its serializer, its admission, its callback, and
    // what its calls are
    private sealed record ResolverMade<TRequest, TResponse>(
        Procedure Procedure,
        IRequestSerializerServer<TRequest, TResponse> Serializer,
        BeforeRequest? BeforeRequest,
        Func<RequestProps<TRequest>, INotificationResponse<TResponse>, Task> Callback,
        DebugType Type);

    // the resolver of a notification: the resolver of its procedure, and what it notifies
    private sealed class NotificationResolver<TRequest, TResponse, TNotification>(
        ServiceManager manager,
        (Resolver<TRequest, TResponse> Resolver, INotificationSerializerServer<TRequest, TResponse, TNotification> Serializer) made)
        : INotificationResolver<TNotification>
    {
        public Procedure Procedure
        {
            get
            {
                return made.Resolver.Procedure;
            }
        }

        public int? MaximumPayloadBytes
        {
            get
            {
                return made.Resolver.MaximumPayloadBytes;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return made.Resolver.Admit(request);
        }

        public Task Handle(RequestResolverProps props)
        {
            return made.Resolver.Handle(props);
        }

        public async Task Notify(TNotification notification, NotifyOptions? options = null)
        {
            var exclude = options?.Exclude;
            var filter = options?.Filter;
            Func<string, bool>? filtered = exclude is null && filter is null
                ? null
                : (connectionHandle) =>
                {
                    return connectionHandle != exclude && (filter is null || filter(connectionHandle));
                };

            var step = new DebugStep(DebugDirection.Tx, DebugType.Notification) { Started = manager.StartedNow(), Tx = notification };

            manager.Trace(Procedure, step);

            // what keeps it from going out is the router's to report, and the trace's to tell, at the
            // start it was sent with: notifying never fails its caller
            try
            {
                await manager._router.Notify(made.Serializer.EncodeNotification(notification), new NotifyRequest(Procedure.Address, filtered, options?.Key));
            }
            catch (Exception reason)
            {
                manager.Trace(Procedure, step with { Error = reason });
            }
        }
    }

    // the resolver of one procedure, registered in the router
    private sealed class Resolver<TRequest, TResponse>(ServiceManager manager, ResolverMade<TRequest, TResponse> made) : IRequestResolver
    {
        private readonly IRouterLike _router = manager._router;

        public Procedure Procedure
        {
            get
            {
                return made.Procedure;
            }
        }

        public int? MaximumPayloadBytes
        {
            get
            {
                return Procedure.MaximumPayloadBytes;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            var beforeRequest = made.BeforeRequest;

            if (beforeRequest is null || beforeRequest.Admits(request))
            {
                return null;
            }

            return beforeRequest.Refusal ?? Failure.OfProtocol(ProtocolCode.AccessDenied);
        }

        public async Task Handle(RequestResolverProps props)
        {
            ArgumentNullException.ThrowIfNull(props);

            // the call starts as it arrives: its admission and its decoding count in its duration
            var started = manager.StartedNow();
            var target = new AnswerTarget(props.ConnectionHandle, props.Header);
            TRequest payload;

            // a router that did not ask its admission leaves it here, before the payload is read
            if (!props.IsAdmitted)
            {
                Failure? refusal;

                try
                {
                    refusal = Admit(new AdmissionRequest(props.ConnectionHandle, props.Header));
                }
                catch
                {
                    await AnswerFailed(target);

                    throw;
                }

                if (refusal is not null)
                {
                    await _router.Respond(RouterAnswer.OfFailure(refusal), target);

                    return;
                }
            }

            // a payload that does not decode never reaches the callback
            try
            {
                payload = made.Serializer.Decode(props.Payload);
            }
            catch (Exception)
            {
                await _router.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.PayloadUndecodable)), target);

                return;
            }

            manager.Trace(Procedure, new DebugStep(DebugDirection.Rx, made.Type) { Rx = payload, Started = started });

            var response = new Response(this, (target, payload, started));
            var request = new RequestProps<TRequest>
            {
                ConnectionHandle = props.ConnectionHandle,
                Header = props.Header,
                Payload = payload,
                Signal = props.Signal,
            };

            try
            {
                await made.Callback(request, response);
            }
            catch
            {
                // a resolver that failed before it answered still answers, so its requester does
                // not wait out its timeout; why it failed goes on, for the router to report
                if (!response.IsAnswered)
                {
                    response.IsAnswered = true;
                    await AnswerFailed(target);
                }

                throw;
            }
        }

        private IRequestSerializerServer<TRequest, TResponse> Serializer
        {
            get
            {
                return made.Serializer;
            }
        }

        private DebugType Type
        {
            get
            {
                return made.Type;
            }
        }

        private void Traced(DebugStep step)
        {
            manager.Trace(Procedure, step);
        }

        // answers as failed; what keeps that answer from going out — a connection gone — is not heard
        private async Task AnswerFailed(AnswerTarget target)
        {
            try
            {
                await _router.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.ProcedureFailed)), target);
            }
            catch (Exception)
            {
                // nothing more to say: the failure that brought it here goes on
            }
        }

        // the failure a resolver's answer sends: the procedure's own, or a refusal of admission
        private static Failure ResolverFailureOf(Failure failure)
        {
            ArgumentNullException.ThrowIfNull(failure);

            if ((failure.Scope == FailureScope.Application && failure.Code >= 1) || BeforeRequest.IsAdmissionFailure(failure))
            {
                return failure;
            }

            throw new ArgumentException(
                $"a resolver answers a failure of its own, from 1 to 65535, or a refusal of admission, not {failure.Code}",
                nameof(failure));
        }

        private sealed class Response(Resolver<TRequest, TResponse> resolver, (AnswerTarget Target, object? Request, Started Started) answering) : INotificationResponse<TResponse>
        {
            public bool IsAnswered { get; set; }

            private AnswerTarget Target
            {
                get
                {
                    return answering.Target;
                }
            }

            public Task Answer(TResponse payload)
            {
                return Send(
                    () =>
                    {
                        return RouterAnswer.OfPayload(resolver.Serializer.Encode(payload));
                    },
                    payload);
            }

            public Task<uint> RegisterNotification()
            {
                // a subscription the answer carries, so made before it goes out
                if (IsAnswered)
                {
                    throw new InvalidOperationException($"{resolver.Procedure.ProcedureName} subscribes before it answers");
                }

                return resolver._router.Subscribe(Target);
            }

            public Task Fail(Failure failure)
            {
                return Send(
                    () =>
                    {
                        return RouterAnswer.OfFailure(ResolverFailureOf(failure));
                    },
                    failure);
            }

            private async Task Send(Func<RouterAnswer> answerOf, object? answered)
            {
                if (IsAnswered)
                {
                    throw new InvalidOperationException($"{resolver.Procedure.ProcedureName} has answered this request already");
                }

                // what fails before the answer goes out leaves the request unanswered, to be answered
                // as failed: a failure a resolver may not answer, or a payload that does not encode
                var answer = answerOf();

                IsAnswered = true;
                resolver.Traced(new DebugStep(DebugDirection.Tx, resolver.Type) { IsAnswered = true, Rx = answering.Request, Started = answering.Started, Tx = answered });

                try
                {
                    await resolver._router.Respond(answer, Target);
                }
                catch
                {
                    // an answer the router could not send — too large, say — is answered as failed,
                    // so its requester does not wait out its timeout
                    await resolver.AnswerFailed(Target);

                    throw;
                }
            }
        }
    }
}
