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

    /// <summary>
    /// Registers a resolver; one out of its range, off its form or against its kind (spec 16.10), or a
    /// second one for its procedure, is an <see cref="ArgumentException"/>.
    /// </summary>
    void RegisterResolver(IRequestResolver resolver);

    /// <summary>Answers a request, while its call is open.</summary>
    Task Respond(RouterAnswer response, AnswerTarget target);

    /// <summary>
    /// The failure the router answered a request with in its resolver's place — a server's, as the
    /// subscription the request opens queued past its bounds (spec 11.10) — read as its resolver
    /// answers, whose answer then goes nowhere; none while the request is its resolver's to answer.
    /// </summary>
    Failure? AnsweredOf(AnswerTarget target);

    /// <summary>
    /// Sends a request, and settles with its result. <see cref="RouterRequest.OnCallId"/> hears the
    /// call's id once the router drew it, before the request goes; a call refused before it draws
    /// one is never heard, and a router that never calls it leaves every step of its calls unnamed.
    /// It fails by the task it gives, never by a throw: the manager tells the call's tx step only
    /// once it returned, so a router that throws loses that step.
    /// </summary>
    Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request);

    /// <summary>
    /// Declares a requester of <paramref name="procedure"/> to the router's registry, as the
    /// requester is made (spec/debugging.md 7.2), and gives the series each of its calls carries as
    /// <see cref="RouterRequest.Series"/>; one out of its range, off its form or against its kind
    /// (spec 16.10), first, or one the registry refuses, is an <see cref="ArgumentException"/>. A
    /// router given no registry gives none.
    /// </summary>
    ProcedureSeries? DeclareRequester(Procedure procedure);

    /// <summary>
    /// What went wrong around the router that no call waits on — a debug listener's error among it —
    /// told through its error event, in its turn, with <paramref name="connectionHandle"/> on a
    /// server's: none for what belongs to no connection's step, a notification sent or heard.
    /// </summary>
    void Report(Exception reason, string? connectionHandle);

    /// <summary>
    /// Notifies the connections subscribed to a procedure: a server's router does. A client's, which
    /// notifies nobody, throws an <see cref="InvalidOperationException"/>.
    /// </summary>
    Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request);

    /// <summary>
    /// A notification whose value did not write, given why in its payload's place: a server's router
    /// sends it to none of the subscriptions it was for, counts it failed for each, and reports why
    /// once (spec 17.2, item 6; spec/debugging.md 10.1). A client's, which notifies nobody, throws an
    /// <see cref="InvalidOperationException"/>.
    /// </summary>
    Task Notify(Exception unwritten, NotifyRequest request);

    /// <summary>
    /// Subscribes the connection a request came from to that request's procedure, and gives the call
    /// id of the subscription: a server's router does; a client's cannot.
    /// </summary>
    Task<uint> Subscribe(AnswerTarget target);

    /// <summary>Whether the router holds this notification — this one, not another of its procedure.</summary>
    bool HasNotification(INotificationLike notification);

    /// <summary>
    /// Holds a notification for its procedure: a client's router does, one out of its range or off
    /// its form (spec 16.10), first, an <see cref="ArgumentException"/>, and a second for the same
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

/// <summary>A call bound to its payload: given its options, when any, it goes, and gives its result.</summary>
/// <typeparam name="TResponse">What a result carries.</typeparam>
public delegate Task<TResponse> BoundCall<TResponse>(RequestOptions? options = null);

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
/// Whether a request may reach a resolver, on its header alone: only <c>true</c> admits it;
/// anything else refuses it, with <see cref="Refusal"/>, or with
/// <see cref="ProtocolCode.AccessDenied"/>. The router answers a refusal SESSION_REQUIRED of a
/// call that presented a credential ACCESS_DENIED, its detail kept: the credential may hold, and
/// its requester would withdraw it (spec 9.2, step 5).
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

    /// <summary>
    /// What the admission makes of a request: none admits it; any other its refusal, or
    /// ACCESS_DENIED. The router answers a refusal SESSION_REQUIRED of a call whose header presents
    /// a credential ACCESS_DENIED, whatever the admission (spec 9.2, step 5). An admission that
    /// throws throws.
    /// </summary>
    internal Failure? RefusalOf(AdmissionRequest request)
    {
        if (Admits(request))
        {
            return null;
        }

        return Refusal ?? Failure.OfProtocol(ProtocolCode.AccessDenied);
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

    /// <summary>The call's session, as its credential resolved it; none when the call runs in none.</summary>
    public CallSession? Session { get; init; }

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

/// <summary>
/// Who holds a subscription: a connection, and the identifier of the session holding it — a
/// credential's; none for its connection's (spec 11.3).
/// </summary>
public readonly record struct Subscriber
{
    /// <summary>Its connection.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>Its credential's session's identifier; none for its connection's session.</summary>
    public SessionIdentifier? Identifier { get; init; }
}

/// <summary>What a notification goes to: its procedure, which subscriptions, and its key.</summary>
public sealed record NotifyRequest
{
    /// <summary>The procedure that notifies.</summary>
    public required ProcedureAddress Procedure { get; init; }

    /// <summary>Whether a subscriber gets it; each does when none.</summary>
    public Func<Subscriber, bool>? Filter { get; init; }

    /// <summary>What it replaces, queued for a paced subscription: the one of the same key.</summary>
    public object? Key { get; init; }
}

/// <summary>Who a notification goes to, as its code says: the connections, and what it is about.</summary>
public sealed record NotifyOptions
{
    /// <summary>A connection left out: the one whose request made the change, say.</summary>
    public string? Exclude { get; init; }

    /// <summary>
    /// Whether a subscriber gets it, by its connection and the identifier of the session that holds
    /// its subscription: those of one user, say.
    /// </summary>
    public Func<Subscriber, bool>? Filter { get; init; }

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
    /// <summary>
    /// The call id its call's envelopes carry: a call made's, once its router drew it; a request
    /// received's, its header's. None for a call refused before its id was drawn, and none for a
    /// notification, sent or heard. A request's id on its span, as OpenTelemetry's
    /// <c>jsonrpc.request.id</c> carries it; it names its call on its connection while the call is
    /// open, and its router may draw it again once the call ended.
    /// </summary>
    public uint? CallId { get; init; }

    /// <summary>
    /// The connection its call is on, as its envelopes name it:
    /// <see cref="RouterClient.ServerConnectionHandle"/> on a client. None where
    /// <see cref="CallId"/> is none.
    /// </summary>
    public string? ConnectionHandle { get; init; }

    /// <summary>Whether it went out or came in.</summary>
    public required DebugDirection Direction { get; init; }

    /// <summary>
    /// How long the call took once it answered, in whole milliseconds of its router clock's
    /// monotonic reading, a fraction dropped; none before, and for a notification. A span's duration,
    /// as <see cref="System.Diagnostics.Activity.Duration"/> and an OpenTelemetry span carry it.
    /// </summary>
    public TimeSpan? Duration { get; init; }

    /// <summary>
    /// The call's options, its defaults applied, its credential left out; none for a step that has
    /// none.
    /// </summary>
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
    /// <summary>
    /// How long a call waits for its answer; 5 s when none. Held as a call's, as the manager is
    /// built: rounded to the nearest whole millisecond, infinite to wait on, and an
    /// <see cref="ArgumentOutOfRangeException"/> for any other not from 1 to
    /// <see cref="Clocks.LongestTimer"/>, zero among them.
    /// </summary>
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
public sealed partial class ServiceManager
{
    // how long a request waits for its answer when its options and the manager's say nothing
    private static readonly TimeSpan TimeoutDefault = TimeSpan.FromSeconds(5);

    private readonly IRouterLike _router;
    private readonly ServiceRequester _requester;
    private readonly ServiceTrace _trace;
    private readonly ServiceResolver _resolver;

    // the notifications this manager made, one per procedure, kept for its life: asked for again,
    // the same one is given
    private readonly Dictionary<ProcedureAddress, (Procedure Procedure, object Notification)> _notifications = [];

    /// <summary>
    /// A manager of the services on <paramref name="router"/>, with its options, on its router's
    /// clock: one given that differs is an <see cref="ArgumentException"/>, and a default timeout
    /// not held an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public ServiceManager(IRouterLike router, ServiceManagerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(router);

        _router = router;

        // held as the manager is built, rather than refused at each call it would time
        var defaults = (options?.Defaults ?? new RequestDefaults()) with
        {
            Timeout = Clocks.AssertHeld(("a call's default timeout", nameof(RequestDefaults.Timeout)), options?.Defaults?.Timeout ?? TimeoutDefault),
        };
        var clock = Clocks.Of((options?.Clock, router.Clock), ("a service manager", "its router"));
        _trace = new ServiceTrace(
            () =>
            {
                return Debug;
            },
            new ServiceTrace.Options
            {
                Clock = clock,
                Side = () =>
                {
                    return router.Side;
                },
                Report = router.Report,
            });
        _resolver = new ServiceResolver(router, _trace);
        _requester = new ServiceRequester(router, new ServiceRequester.Options
        {
            Defaults = defaults,
            CloseConnection = options?.CloseConnection,
            Trace = _trace,
            Deprecated = (procedure) =>
            {
                Deprecated?.Invoke(procedure);
            },
        });
    }

    /// <summary>A notification dropped: its procedure, and the failure the other end ended it with, if any.</summary>
    public event Action<Procedure, Failure?>? Dropped;

    /// <summary>
    /// One step of a call — a request made or answered, a command, a notification sent or heard —
    /// and the exception it failed with, or none; on a tx step, why its tx did not go out: a
    /// notification that could not go, an answer its router refused, told again at its start, or
    /// none, from a resolver that failed before it answered. Nothing is built, and no clock read,
    /// while nobody hears it. A listener that throws is reported through the router, with the
    /// call's connection on a server's, and changes nothing of the call.
    /// </summary>
    public event Action<Exception?, DebugEvent>? Debug;

    /// <summary>A deprecated procedure was called; its deprecation says what to use instead, when it says.</summary>
    public event Action<Procedure>? Deprecated;

    /// <summary>Whether anyone hears <see cref="Debug"/>: nothing is traced, and nothing built for it, while nobody does.</summary>
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
    /// the last one taken away unsubscribes. The same procedure asked for again, at the same window
    /// or at none twice, gives the same notification; asked for differently, or at another window, it
    /// is an <see cref="InvalidOperationException"/>, after its router's check: one out of its range
    /// or off its form (spec 16.10) is an <see cref="ArgumentException"/> first, and one against its
    /// call as its router holds it.
    /// </summary>
    public INotification<TRequest, TNotification> GetNotification<TRequest, TResponse, TNotification>(
        Procedure procedure,
        NotificationDependencies<TRequest, TResponse, TNotification> dependencies)
    {
        ArgumentNullException.ThrowIfNull(procedure);
        ArgumentNullException.ThrowIfNull(dependencies);

        // * the router's reasons come before the manager's own, as at every layer (spec 16.10)
        Identity.Check(procedure, nameof(procedure));

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

                // ! a window is the subscription's, unpaced and paced two of them: a second caller's
                // kept in silence would pace it at the first's
                if (same.Window != dependencies.Window)
                {
                    throw new InvalidOperationException(
                        $"{procedure.ServiceId}/{procedure.ProcedureId} is already a notification with {WindowOf(same.Window)}, not {WindowOf(dependencies.Window)}");
                }

                return same;
            }

            // its subscribing request is a requester of the procedure, declared as it is made
            var series = _router.DeclareRequester(procedure);
            var notification = new Notification<TRequest, TResponse, TNotification>(
                procedure,
                (_router, dependencies),
                ((payload, call) =>
                {
                    return _requester.CallOf(payload, (procedure, dependencies.Serializer, call.Options, (DebugType.Request, call.Subscribes, series)));
                },
                (failure) =>
                {
                    Dropped?.Invoke(procedure, failure);
                },
                (error, notification) =>
                {
                    // * one check a notification heard while nobody listens
                    if (IsDebugging)
                    {
                        _trace.Trace(procedure, new DebugStep(DebugDirection.Rx, DebugType.Notification) { Error = error, Rx = notification, Started = _trace.NotifiedNow() });
                    }
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
    public Func<TRequest, BoundCall<TResponse>> GetRequest<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies)
    {
        return _requester.RequesterOf(procedure, (dependencies, DebugType.Request));
    }

    /// <summary>
    /// A requester of a command: what a server asks its client, the connection named in its
    /// options. A requester as <see cref="GetRequest{TRequest, TResponse}"/> gives one; one
    /// unanswered in time closes its connection when its options, or the manager's defaults, say so.
    /// </summary>
    public Func<TRequest, BoundCall<TResponse>> GetCommand<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies)
    {
        return _requester.RequesterOf(procedure, (dependencies, DebugType.Command));
    }

    /// <summary>
    /// The resolver of a command, which a client offers its server: a resolver as
    /// <see cref="GetRequestResolver{TRequest, TResponse}"/> gives one.
    /// </summary>
    public Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> GetCommandResolver<TRequest, TResponse>(
        Procedure procedure,
        RequestResolverDependencies<TRequest, TResponse> dependencies)
    {
        return _resolver.ResolverOf(procedure, (dependencies, DebugType.Command));
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
        return _resolver.ResolverOf(procedure, (dependencies, DebugType.Request));
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
        Identity.Check(procedure, nameof(procedure));

        return (callback) =>
        {
            ArgumentNullException.ThrowIfNull(callback);

            var resolver = new NotificationResolver<TRequest, TResponse, TNotification>(
                this,
                (_resolver.Create(new ResolverMade<TRequest, TResponse>
                {
                    Procedure = procedure,
                    Serializer = dependencies.Serializer,
                    BeforeRequest = dependencies.BeforeRequest,
                    Callback = (request, response) =>
                    {
                        return callback(request, response);
                    },
                    Type = DebugType.Request,
                }),
                dependencies.Serializer));

            _router.RegisterResolver(resolver);

            return resolver;
        };
    }

    // a window, in a refusal's sentence
    private static string WindowOf(int? window)
    {
        return window is { } given ? $"window {given}" : "no window";
    }

    // the resolver of a notification: the resolver of its procedure, and what it notifies
    private sealed class NotificationResolver<TRequest, TResponse, TNotification>(
        ServiceManager manager,
        (IRequestResolver Resolver, INotificationSerializerServer<TRequest, TResponse, TNotification> Serializer) made)
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
            Func<Subscriber, bool>? filtered = exclude is null && filter is null
                ? null
                : (subscriber) =>
                {
                    return subscriber.ConnectionHandle != exclude && (filter is null || filter(subscriber));
                };

            // * one check a notification sent while nobody listens: no clock read, no step
            var step = manager.IsDebugging
                ? new DebugStep(DebugDirection.Tx, DebugType.Notification) { Started = manager._trace.NotifiedNow(), Tx = notification }
                : null;

            if (step is not null)
            {
                manager._trace.Trace(Procedure, step);
            }

            var request = new NotifyRequest { Filter = filtered, Key = options?.Key, Procedure = Procedure.Address };

            // * a value that does not write goes to none of its subscriptions: handed to the router in
            // its payload's place, which counts it failed for each and reports it (spec 17.2, item 6)
            ReadOnlyMemory<byte> encoded = default;
            Exception? failure = null;

            try
            {
                encoded = made.Serializer.EncodeNotification(notification);
            }
            catch (Exception reason)
            {
                failure = reason;
            }

            // what keeps it from going out is the router's to report, and the trace's to tell, at the
            // start it was sent with: notifying never fails its caller
            try
            {
                await (failure is null ? manager._router.Notify(encoded, request) : manager._router.Notify(failure, request));
            }
            catch (Exception reason)
            {
                failure = reason;
            }

            if (failure is not null && step is not null)
            {
                manager._trace.Trace(Procedure, step with { Error = failure });
            }
        }
    }
}
