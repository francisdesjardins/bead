namespace Bead;

/// <summary>
/// Who may call a procedure: every call, a call with a session, or a hook the server side is given
/// by name. A rule is data: the service layer makes each one's admission as the service is offered.
/// </summary>
public sealed record AdmissionRule
{
    private AdmissionRule(AdmissionKind kind, string? hookName)
    {
        Kind = kind;
        HookName = hookName;
    }

    /// <summary>Every call is admitted.</summary>
    public static AdmissionRule None { get; } = new(AdmissionKind.None, null);

    /// <summary>
    /// A call in a session is admitted: the side's own admission of a session — on a server its
    /// <see cref="IBeadServer{TData}.RequireSession"/> — refusing one in none with SESSION_REQUIRED.
    /// </summary>
    public static AdmissionRule Session { get; } = new(AdmissionKind.Session, null);

    /// <summary>The hook's name, for a hook's rule; none for the others.</summary>
    public string? HookName { get; }

    // which of the three it is
    internal AdmissionKind Kind { get; }

    /// <summary>
    /// A call the hook <paramref name="name"/> admits, which a server side is given by that name;
    /// an empty name is an <see cref="ArgumentException"/>.
    /// </summary>
    public static AdmissionRule Hook(string name)
    {
        ArgumentException.ThrowIfNullOrEmpty(name);

        return new AdmissionRule(AdmissionKind.Hook, name);
    }
}

/// <summary>The three rules of admission.</summary>
internal enum AdmissionKind
{
    /// <summary>Every call.</summary>
    None,

    /// <summary>A call with a session.</summary>
    Session,

    /// <summary>A call a hook admits.</summary>
    Hook,
}

/// <summary>
/// A hook: whether a call may reach its resolver, on its header and its call's session, present or
/// not, decided at once (decision 0010). Only <c>true</c> admits; one that throws answers
/// PROCEDURE_FAILED, and is reported. A call it refuses is answered ACCESS_DENIED, never
/// SESSION_REQUIRED, with <see cref="Detail"/>.
/// </summary>
public sealed record AdmissionHook
{
    /// <summary>Whether the call is admitted.</summary>
    public required Func<AdmissionRequest, bool> Admits { get; init; }

    /// <summary>The detail of the ACCESS_DENIED a call it refuses is answered with; empty says nothing.</summary>
    public string Detail { get; init; } = "";
}

/// <summary>A procedure of the service whose type tag is <typeparamref name="TService"/>, whatever its kind.</summary>
/// <typeparam name="TService">The service's type tag: a descriptor of another service is another type.</typeparam>
public interface IServiceProcedure<TService>
{
    /// <summary>The procedure, its kind set.</summary>
    Procedure Procedure { get; }

    /// <summary>Who may call it.</summary>
    AdmissionRule Admission { get; }
}

/// <summary>A procedure's admission and its payloads' codecs.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
public sealed record ProcedureBindings<TRequest, TResult>
{
    /// <summary>Who may call it.</summary>
    public required AdmissionRule Admission { get; init; }

    /// <summary>Its request's codec.</summary>
    public required IPayloadCodec<TRequest> Request { get; init; }

    /// <summary>Its result's codec.</summary>
    public required IPayloadCodec<TResult> Result { get; init; }

    /// <summary>
    /// What judges a request's value by its procedure's rules (spec section 18): the side that
    /// answers judges every request once it decoded, before its resolver, and answers one it refuses
    /// <see cref="ProtocolCode.PayloadInvalid"/>; the side that asks judges it before it is written,
    /// when its options say so, and fails the call before it goes with a
    /// <see cref="FailureException"/> of that code. None judges nothing; one that throws is answered
    /// as a resolver that throws, and fails a call before it goes. beadc generates it from a
    /// <c>proto</c> binding's protovalidate rules.
    /// </summary>
    public RequestValidator<TRequest>? Validate { get; init; }
}

/// <summary>A notifying procedure's admission and its payloads' codecs.</summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public sealed record ProcedureBindings<TRequest, TResult, TNotification>
{
    /// <summary>Who may call it.</summary>
    public required AdmissionRule Admission { get; init; }

    /// <summary>Its request's codec.</summary>
    public required IPayloadCodec<TRequest> Request { get; init; }

    /// <summary>Its result's codec.</summary>
    public required IPayloadCodec<TResult> Result { get; init; }

    /// <summary>Its notifications' codec.</summary>
    public required IPayloadCodec<TNotification> Notification { get; init; }

    /// <summary>As <see cref="ProcedureBindings{TRequest, TResult}.Validate"/> says: a subscribing request is judged as a plain one.</summary>
    public RequestValidator<TRequest>? Validate { get; init; }
}

/// <summary>
/// A request of the service <typeparamref name="TService"/>, which notifies nothing: its procedure,
/// its kind set to <see cref="ProcedureKind.Request"/>, and its bindings. A descriptor is no
/// declaration: its identity and its kind are checked as it is declared (spec 16.10).
/// </summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures it lists: <see cref="NoFailure"/> for none.</typeparam>
public sealed class RequestProcedure<TService, TRequest, TResult, TFailure> : IServiceProcedure<TService>, IDescribedProcedure
    where TFailure : IApplicationFailure
{
    /// <summary>
    /// A descriptor of <paramref name="procedure"/>: one that states a kind other than a request, or
    /// a binding missing, is an <see cref="ArgumentException"/>.
    /// </summary>
    public RequestProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult> bindings)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(bindings.Admission, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Request, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Result, nameof(bindings));

        Procedure = Descriptors.KindSet(procedure, ProcedureKind.Request);
        Bindings = bindings;
    }

    /// <inheritdoc/>
    public Procedure Procedure { get; }

    /// <inheritdoc/>
    public AdmissionRule Admission
    {
        get
        {
            return Bindings.Admission;
        }
    }

    /// <summary>Its bindings.</summary>
    public ProcedureBindings<TRequest, TResult> Bindings { get; }

    object IDescribedProcedure.RequesterOn(ServiceManager services, RequesterJudging judging)
    {
        return services.GetRequest(
            Procedure,
            new RequestDependencies<TRequest, TResult> { Serializer = new ClientCodecs<TRequest, TResult>((Bindings.Request, Bindings.Result), RequestJudge<TRequest>.Of(Bindings.Validate, (judging, services))) });
    }

    object? IDescribedProcedure.NotificationOn(ServiceManager services, (int? Window, RequesterJudging Judging) made)
    {
        return null;
    }
}

/// <summary>
/// A request of the service <typeparamref name="TService"/> that notifies: its procedure, its kind
/// set to <see cref="ProcedureKind.Notifies"/>, and its bindings. A request to it may open no
/// subscription (spec 11.2).
/// </summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
/// <typeparam name="TFailure">The failures it lists: <see cref="NoFailure"/> for none.</typeparam>
public sealed class RequestProcedure<TService, TRequest, TResult, TNotification, TFailure> : IServiceProcedure<TService>, IDescribedProcedure
    where TFailure : IApplicationFailure
{
    /// <summary>
    /// A descriptor of <paramref name="procedure"/>: one that states a kind other than a request that
    /// notifies, or a binding missing, is an <see cref="ArgumentException"/>.
    /// </summary>
    public RequestProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult, TNotification> bindings)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(bindings.Admission, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Request, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Result, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Notification, nameof(bindings));

        Procedure = Descriptors.KindSet(procedure, ProcedureKind.Notifies);
        Bindings = bindings;
    }

    /// <inheritdoc/>
    public Procedure Procedure { get; }

    /// <inheritdoc/>
    public AdmissionRule Admission
    {
        get
        {
            return Bindings.Admission;
        }
    }

    /// <summary>Its bindings.</summary>
    public ProcedureBindings<TRequest, TResult, TNotification> Bindings { get; }

    object IDescribedProcedure.RequesterOn(ServiceManager services, RequesterJudging judging)
    {
        return services.GetRequest(
            Procedure,
            new RequestDependencies<TRequest, TResult> { Serializer = new ClientCodecs<TRequest, TResult>((Bindings.Request, Bindings.Result), RequestJudge<TRequest>.Of(Bindings.Validate, (judging, services))) });
    }

    object? IDescribedProcedure.NotificationOn(ServiceManager services, (int? Window, RequesterJudging Judging) made)
    {
        return services.GetNotification(
            Procedure,
            new NotificationDependencies<TRequest, TResult, TNotification>
            {
                Serializer = new ClientNotificationCodecs<TRequest, TResult, TNotification>(Bindings, RequestJudge<TRequest>.Of(Bindings.Validate, (made.Judging, services))),
                Window = made.Window,
            });
    }
}

/// <summary>
/// A command of the service <typeparamref name="TService"/>, a request its server makes of a
/// client: its procedure, its kind set to <see cref="ProcedureKind.Command"/>, and its bindings. A
/// command never notifies.
/// </summary>
/// <typeparam name="TService">The service's type tag.</typeparam>
/// <typeparam name="TRequest">What a request carries.</typeparam>
/// <typeparam name="TResult">What a result carries.</typeparam>
/// <typeparam name="TFailure">The failures it lists: <see cref="NoFailure"/> for none.</typeparam>
public sealed class CommandProcedure<TService, TRequest, TResult, TFailure> : IServiceProcedure<TService>, IDescribedProcedure
    where TFailure : IApplicationFailure
{
    /// <summary>
    /// A descriptor of <paramref name="procedure"/>: one that states a kind other than a command, or
    /// a binding missing, is an <see cref="ArgumentException"/>.
    /// </summary>
    public CommandProcedure(Procedure procedure, ProcedureBindings<TRequest, TResult> bindings)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(bindings.Admission, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Request, nameof(bindings));
        ArgumentNullException.ThrowIfNull(bindings.Result, nameof(bindings));

        Procedure = Descriptors.KindSet(procedure, ProcedureKind.Command);
        Bindings = bindings;
    }

    /// <inheritdoc/>
    public Procedure Procedure { get; }

    /// <inheritdoc/>
    public AdmissionRule Admission
    {
        get
        {
            return Bindings.Admission;
        }
    }

    /// <summary>Its bindings.</summary>
    public ProcedureBindings<TRequest, TResult> Bindings { get; }

    object IDescribedProcedure.RequesterOn(ServiceManager services, RequesterJudging judging)
    {
        return services.GetCommand(
            Procedure,
            new RequestDependencies<TRequest, TResult> { Serializer = new ClientCodecs<TRequest, TResult>((Bindings.Request, Bindings.Result), RequestJudge<TRequest>.Of(Bindings.Validate, (judging, services))) });
    }

    object? IDescribedProcedure.NotificationOn(ServiceManager services, (int? Window, RequesterJudging Judging) made)
    {
        return null;
    }
}

/// <summary>
/// What the service layer makes of a descriptor it was handed whole, its types its own: the
/// requester a side calls it through, and its notification.
/// </summary>
internal interface IDescribedProcedure
{
    /// <summary>
    /// A requester of it on <paramref name="services"/>, as a <c>Func</c> of its request to a
    /// <see cref="BoundCall{TResponse}"/>: a command's, or a request's; its request judged before it
    /// is written as <paramref name="judging"/> says.
    /// </summary>
    object RequesterOn(ServiceManager services, RequesterJudging judging);

    /// <summary>
    /// Its notification on <paramref name="services"/>, at its window, its subscribing request judged
    /// as a plain one; none for a procedure that does not notify.
    /// </summary>
    object? NotificationOn(ServiceManager services, (int? Window, RequesterJudging Judging) made);
}

/// <summary>Whether a side's requesters judge a request's value before it is written, and whether they stop at its first violation.</summary>
internal sealed record RequesterJudging
{
    /// <summary>None judges, as a side's options say by default.</summary>
    public static RequesterJudging None { get; } = new();

    /// <summary>Whether a requester judges its request before it is written.</summary>
    public bool Validates { get; init; }

    /// <summary>Whether its judging stops at the first violation.</summary>
    public bool FailFast { get; init; }
}

/// <summary>
/// What judges a request before its requester writes it (spec 18.2): a value its rules refuse is a
/// <see cref="FailureException"/> of <see cref="ProtocolCode.PayloadInvalid"/>, raised here, its
/// detail written under its router's bound, which its service manager hands its router as the call's
/// refusal, so that it fails before it goes, counted.
/// </summary>
/// <typeparam name="TRequest">What a request carries.</typeparam>
internal sealed class RequestJudge<TRequest>(RequestValidator<TRequest> validate, (bool FailFast, ServiceManager Services) judging)
{
    /// <summary>The judge of a requester's requests, when its side validates and its procedure has rules; none otherwise.</summary>
    public static RequestJudge<TRequest>? Of(RequestValidator<TRequest>? validate, (RequesterJudging Judging, ServiceManager Services) made)
    {
        return made.Judging.Validates && validate is not null ? new RequestJudge<TRequest>(validate, (made.Judging.FailFast, made.Services)) : null;
    }

    /// <summary>Judges <paramref name="request"/>, and throws a PAYLOAD_INVALID where its rules refuse it.</summary>
    public void Judge(TRequest request)
    {
        var bound = judging.Services.DetailBytes;
        var judged = validate(request, new ValidateOptions { FailFast = judging.FailFast, MaximumBytes = bound });

        if (judged.Refuses)
        {
            throw new FailureException(
                Failure.OfProtocol(ProtocolCode.PayloadInvalid, Violations.DetailOf(judged, bound)),
                new FailureException.Raised(FailureOrigin.Local, judging.Services.Side));
        }
    }
}

/// <summary>What every descriptor does with the procedure it is given.</summary>
internal static class Descriptors
{
    /// <summary>
    /// <paramref name="procedure"/>, its kind set to <paramref name="procedureKind"/>: one that
    /// states another is an <see cref="ArgumentException"/>.
    /// </summary>
    public static Procedure KindSet(Procedure procedure, ProcedureKind procedureKind)
    {
        ArgumentNullException.ThrowIfNull(procedure);

        if (procedure.ProcedureKind is { } stated && stated != procedureKind)
        {
            throw new ArgumentException(
                $"{procedure.ProcedureName} is {Identity.WordsOf(stated)}, where its descriptor describes {Identity.WordsOf(procedureKind)}",
                nameof(procedure));
        }

        return procedure with { ProcedureKind = procedureKind };
    }
}

/// <summary>How the side that asks writes a request and reads its result, by its codecs, its request judged first when given its judge.</summary>
internal sealed class ClientCodecs<TRequest, TResult>((IPayloadCodec<TRequest> Request, IPayloadCodec<TResult> Result) codecs, RequestJudge<TRequest>? judge)
    : IRequestSerializerClient<TRequest, TResult>
{
    public ReadOnlyMemory<byte> Encode(TRequest request)
    {
        judge?.Judge(request);

        return codecs.Request.Encode(request);
    }

    public TResult Decode(ReadOnlyMemory<byte> response)
    {
        return codecs.Result.Decode(response);
    }
}

/// <summary>
/// How the side that subscribes writes its request and reads its result and its notifications, by
/// its codecs, its request judged first when given its judge, as a plain request's is.
/// </summary>
internal sealed class ClientNotificationCodecs<TRequest, TResult, TNotification>(ProcedureBindings<TRequest, TResult, TNotification> bindings, RequestJudge<TRequest>? judge)
    : INotificationSerializerClient<TRequest, TResult, TNotification>
{
    public ReadOnlyMemory<byte> Encode(TRequest request)
    {
        judge?.Judge(request);

        return bindings.Request.Encode(request);
    }

    public TResult Decode(ReadOnlyMemory<byte> response)
    {
        return bindings.Result.Decode(response);
    }

    public TNotification DecodeNotification(ReadOnlyMemory<byte> notification)
    {
        return bindings.Notification.Decode(notification);
    }
}

/// <summary>How the side that answers reads a request and writes its result, by its codecs.</summary>
internal sealed class ServerCodecs<TRequest, TResult>(IPayloadCodec<TRequest> request, IPayloadCodec<TResult> result)
    : IRequestSerializerServer<TRequest, TResult>
{
    public TRequest Decode(ReadOnlyMemory<byte> payload)
    {
        return request.Decode(payload);
    }

    public ReadOnlyMemory<byte> Encode(TResult response)
    {
        return result.Encode(response);
    }
}

/// <summary>How the side that answers a notifying procedure reads a request and writes its result and its notifications, by its codecs.</summary>
internal sealed class ServerNotificationCodecs<TRequest, TResult, TNotification>(ProcedureBindings<TRequest, TResult, TNotification> bindings)
    : INotificationSerializerServer<TRequest, TResult, TNotification>
{
    public TRequest Decode(ReadOnlyMemory<byte> request)
    {
        return bindings.Request.Decode(request);
    }

    public ReadOnlyMemory<byte> Encode(TResult response)
    {
        return bindings.Result.Encode(response);
    }

    public ReadOnlyMemory<byte> EncodeNotification(TNotification notification)
    {
        return bindings.Notification.Encode(notification);
    }
}
