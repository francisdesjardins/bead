namespace Bead;

/// <summary>A request whose connection closed, or whose router was disposed, before its answer came.</summary>
public sealed class DisconnectException : Exception
{
    /// <summary>A disconnection, saying why.</summary>
    public DisconnectException(string message)
        : base(message)
    {
    }
}

/// <summary>Where a procedure is: its service, and its own number in that service.</summary>
/// <param name="ServiceId">The service, from 1.</param>
/// <param name="ProcedureId">The procedure, from 1.</param>
public readonly record struct ProcedureAddress(ushort ServiceId, ushort ProcedureId);

/// <summary>Where a call is: the connection it is on, and its call id there.</summary>
/// <param name="CallId">The call id.</param>
/// <param name="ConnectionHandle">The connection.</param>
public readonly record struct CallAddress(uint CallId, string ConnectionHandle);

/// <summary>One procedure of one service, which names what is made for it.</summary>
public sealed record Procedure
{
    /// <summary>The service the procedure is in, from 1.</summary>
    public required ushort ServiceId { get; init; }

    /// <summary>The procedure's own number in its service, from 1.</summary>
    public required ushort ProcedureId { get; init; }

    /// <summary>Its name, for a trace and an error.</summary>
    public required string ProcedureName { get; init; }

    /// <summary>Which revision of its service the procedure is; it does not travel.</summary>
    public required int ServiceRevision { get; init; }

    /// <summary>
    /// The bytes a payload of the procedure holds at most, its request's and its result's: the
    /// router's own limit where that one is smaller, and the router's alone when none.
    /// </summary>
    public int? MaximumPayloadBytes { get; init; }

    /// <summary>
    /// Present when the procedure is on its way out: a requester raises the manager's
    /// <c>Deprecated</c> at each call, and its message says what to use instead, when it says.
    /// </summary>
    public ProcedureDeprecation? Deprecation { get; init; }

    /// <summary>Where the procedure is.</summary>
    public ProcedureAddress Address
    {
        get
        {
            return new ProcedureAddress(ServiceId, ProcedureId);
        }
    }
}

/// <summary>A request as its admission sees it: where it came from, and its header — never its payload.</summary>
/// <param name="ConnectionHandle">The connection it came from.</param>
/// <param name="Header">Its header.</param>
public readonly record struct AdmissionRequest(string ConnectionHandle, RequestHeader Header)
{
    /// <summary>The call's session, as its credential resolved it; none when the call runs in none.</summary>
    public CallSession? Session { get; init; }
}

/// <summary>A request as the router hands it to a resolver: its payload still encoded.</summary>
public sealed record RequestResolverProps
{
    /// <summary>The connection it came from.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>Its header, the very one the router dispatched: an answer finds its call by it.</summary>
    public required RequestHeader Header { get; init; }

    /// <summary>Set by a router that asked the resolver's admission already.</summary>
    public bool IsAdmitted { get; init; }

    /// <summary>Its payload, encoded.</summary>
    public required ReadOnlyMemory<byte> Payload { get; init; }

    /// <summary>The call's session, as its credential resolved it; none when the call runs in none.</summary>
    public CallSession? Session { get; init; }

    /// <summary>
    /// Cancelled when the call ends before its answer: its requester cancelled it, its connection
    /// closed, or its router was disposed. Its answer would go nowhere.
    /// </summary>
    public required CancellationToken Signal { get; init; }
}

/// <summary>
/// What answers a request the router hands it, once its payload is whole: a resolver, for one
/// procedure, or a relay's handler, for one destination.
/// </summary>
public interface IRequestHandler
{
    /// <summary>
    /// The bytes a payload it takes or answers holds at most: the router's own limit where that one
    /// is smaller, and the router's alone when none.
    /// </summary>
    int? MaximumPayloadBytes { get; }

    /// <summary>Answers a request, through the router's <c>Respond</c>.</summary>
    Task Handle(RequestResolverProps props);

    /// <summary>
    /// Whether a request may reach the handler, asked on its header before its payload is read:
    /// none admits it; a failure refuses it, and the router answers with it; one that throws
    /// refuses it as failed, and is reported.
    /// </summary>
    Failure? Admit(AdmissionRequest request);
}

/// <summary>A procedure as a resolver answers it.</summary>
public interface IRequestResolver : IRequestHandler
{
    /// <summary>The procedure it answers.</summary>
    Procedure Procedure { get; }
}

/// <summary>An answer for the router to send: a payload, or a failure.</summary>
public sealed record RouterAnswer
{
    private RouterAnswer(ReadOnlyMemory<byte> payload, Failure? failure)
    {
        Payload = payload;
        Failure = failure;
    }

    /// <summary>The payload of a result.</summary>
    public ReadOnlyMemory<byte> Payload { get; }

    /// <summary>The failure, for a failure; none for a result.</summary>
    public Failure? Failure { get; }

    /// <summary>A result carrying <paramref name="payload"/>.</summary>
    public static RouterAnswer OfPayload(ReadOnlyMemory<byte> payload)
    {
        return new RouterAnswer(payload, null);
    }

    /// <summary>A failure.</summary>
    public static RouterAnswer OfFailure(Failure failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return new RouterAnswer(ReadOnlyMemory<byte>.Empty, failure);
    }
}

/// <summary>A request an answer is for: its connection, and its header as it was dispatched.</summary>
/// <param name="ConnectionHandle">The connection the request came from.</param>
/// <param name="Header">Its header, the very one dispatched.</param>
public readonly record struct AnswerTarget(string ConnectionHandle, RequestHeader Header);

/// <summary>A result, as a request resolves with it: its header and its payload.</summary>
/// <param name="Header">The result's header.</param>
/// <param name="Payload">Its payload.</param>
public sealed record RouterResult(ResultHeader Header, ReadOnlyMemory<byte> Payload);

/// <summary>The options of a request, with the manager's defaults applied.</summary>
public sealed record ResolvedRequestOptions
{
    /// <summary>
    /// How long to wait for the answer, the call's or the manager's default, held as the defaults are
    /// applied: from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest
    /// whole one, or <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which waits on. Any
    /// other, zero among them, is an <see cref="ArgumentOutOfRangeException"/>, and the call draws
    /// nothing.
    /// </summary>
    public required TimeSpan Timeout { get; init; }

    /// <summary>What the request is for behind the peer; the peer itself when none.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>
    /// What cancels the request: it throws an <see cref="OperationCanceledException"/>, and the peer,
    /// once the request went out, is sent a cancel.
    /// </summary>
    public CancellationToken CancellationToken { get; init; }

    /// <summary>
    /// The connection the request goes to, for a router with more than one: a server's names its
    /// client; a client's has one peer, and names none.
    /// </summary>
    public string? ConnectionHandle { get; init; }

    /// <summary>
    /// Whether a command unanswered in time closes the connection it went to: a server's manager
    /// closes it; none takes the manager's default.
    /// </summary>
    public bool? CloseOnTimeout { get; init; }

    /// <summary>
    /// The credential the call presents, as <see cref="RequestOptions.Credential"/> says; none
    /// presents none.
    /// </summary>
    public Credential? Credential { get; init; }
}

/// <summary>The options of a request, as its caller gives them: what it leaves out is the manager's.</summary>
public sealed record RequestOptions
{
    /// <summary>
    /// How long to wait for the answer; the manager's default, 5 s, when none. From 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest whole one, or
    /// <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which waits on. Any other, zero among
    /// them, is an <see cref="ArgumentOutOfRangeException"/>, and the call draws nothing: a
    /// manager's call, before it is traced or told deprecated.
    /// </summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>What the request is for behind the peer; the peer itself when none.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>What cancels the request.</summary>
    public CancellationToken CancellationToken { get; init; }

    /// <summary>The connection the request goes to, which a server names.</summary>
    public string? ConnectionHandle { get; init; }

    /// <summary>
    /// Whether a command unanswered in time closes the connection it went to: a server's manager
    /// closes it; none takes the manager's default.
    /// </summary>
    public bool? CloseOnTimeout { get; init; }

    /// <summary>
    /// The credential this call alone presents; none presents none, never one by default.
    /// <see cref="Credential.Opaque()"/> stands for the connection's session as its side knows it —
    /// a client's, the session it learned — and binds the call to it: a call made once that session
    /// ended, or was opened anew under a new token, is refused SESSION_REQUIRED rather than run in
    /// whatever session the connection holds. A side that knows no session fails such a call before
    /// it goes, with SESSION_REQUIRED, and draws nothing.
    /// </summary>
    public Credential? Credential { get; init; }
}

/// <summary>That a procedure is on its way out, and what to use instead, when it says.</summary>
public sealed record ProcedureDeprecation
{
    /// <summary>What to use instead, or why; none when it says nothing.</summary>
    public string? Message { get; init; }
}

/// <summary>A request a router sends for a service manager: its procedure, and its options.</summary>
/// <param name="Procedure">The procedure it calls.</param>
/// <param name="Options">Its options, the manager's defaults applied.</param>
public sealed record RouterRequest(Procedure Procedure, ResolvedRequestOptions Options)
{
    /// <summary>
    /// The notification the call subscribes, which the router holds for the procedure: the request
    /// opens a subscription, and what comes under its call id triggers it. A client's router alone
    /// subscribes.
    /// </summary>
    public INotificationLike? Subscribes { get; init; }

    /// <summary>
    /// Hears the request handed to the transport, then — should the transport refuse it — that it
    /// did not go out.
    /// </summary>
    public Action<bool>? OnSent { get; init; }
}

/// <summary>A request a router's core sends: where, for which procedure, and how.</summary>
public sealed record CoreRequest
{
    /// <summary>The connection the request goes to.</summary>
    public required string ConnectionHandle { get; init; }

    /// <summary>The procedure it calls.</summary>
    public required Procedure Procedure { get; init; }

    /// <summary>Its options.</summary>
    public required ResolvedRequestOptions Options { get; init; }

    /// <summary>Whether the request opens a subscription.</summary>
    public bool OpensSubscription { get; init; }

    /// <summary>Whether the subscription it opens goes at its client's pace.</summary>
    public bool Paced { get; init; }

    /// <summary>What hears the call id before the request goes out.</summary>
    public Action<uint>? OnCallId { get; init; }

    /// <summary>
    /// What hears <c>true</c> as the request is handed to the transport, and <c>false</c> should
    /// the transport refuse it.
    /// </summary>
    public Action<bool>? OnSent { get; init; }
}

/// <summary>What a router did: sent or took a request, a response, or a notification.</summary>
public enum RouterActivity
{
    /// <summary>A request sent.</summary>
    Request,

    /// <summary>A response taken.</summary>
    Response,

    /// <summary>A notification sent or taken.</summary>
    Notification,
}

/// <summary>Which way an envelope went.</summary>
public enum DebugDirection
{
    /// <summary>In.</summary>
    Rx,

    /// <summary>Out.</summary>
    Tx,
}

/// <summary>
/// An envelope fit to be traced: its connection, and its header without its credential, whose
/// scheme alone it keeps.
/// </summary>
/// <param name="ConnectionHandle">The connection it went on.</param>
/// <param name="Header">Its header, its credential left out.</param>
/// <param name="CredentialScheme">The scheme of the credential it carried; none, it carried none.</param>
public readonly record struct TracedEnvelope(
    string ConnectionHandle,
    IEnvelopeHeader Header,
    CredentialScheme? CredentialScheme);

/// <summary>An answer about to be written, and the handler its request was routed to.</summary>
/// <param name="Target">The request it answers.</param>
/// <param name="IsFailure">Whether it is a failure.</param>
/// <param name="Resolver">The handler its request was routed to, if any.</param>
public readonly record struct AnswerInfo(AnswerTarget Target, bool IsFailure, IRequestHandler? Resolver);

/// <summary>
/// What sets one side of a router apart, for its core: its side, how it sends, and what it hears of
/// what the core does. A member a side has nothing to say with keeps its default.
/// </summary>
public interface IRouterCorePort
{
    /// <summary>Which side the router is: its failures say so, and it draws call ids of its parity.</summary>
    RouterSide Side { get; }

    /// <summary>Whether the side takes notifications; one that does not reports them.</summary>
    bool TakesNotifications
    {
        get
        {
            return false;
        }
    }

    /// <summary>Whether the side sends notifications; one that does not reports their credits.</summary>
    bool SendsNotifications
    {
        get
        {
            return false;
        }
    }

    /// <summary>What the router did: sent a request, or took the response to one.</summary>
    void Activity(RouterActivity activity, string connectionHandle)
    {
    }

    /// <summary>
    /// Whether the side holds <paramref name="callId"/> beyond what the core waits on — a
    /// subscription: the core draws none of these, and refuses a request on one.
    /// </summary>
    bool IsCallIdInUse(uint callId, string connectionHandle)
    {
        return false;
    }

    /// <summary>The handler of a request that names a destination; none refuses it.</summary>
    IRequestHandler? HandlerOfDestination(uint destinationId)
    {
        return null;
    }

    /// <summary>Whether a connection carries both ways; every one does by default.</summary>
    bool IsTwoWay(string connectionHandle)
    {
        return true;
    }

    /// <summary>
    /// An answer about to be written; what it returns undoes what it did, should the answer not go
    /// out.
    /// </summary>
    Action? BeforeAnswer(AnswerInfo answer)
    {
        return null;
    }

    /// <summary>A cancel from a connection, once the call it cancels is forgotten.</summary>
    void OnCancel(uint callId, string connectionHandle)
    {
    }

    /// <summary>A notification from a connection, for a side that takes them.</summary>
    void OnNotification(NotificationHeader header, (string ConnectionHandle, ReadOnlyMemory<byte> Payload) notification)
    {
    }

    /// <summary>A credit that counts notifications, for a side that sends them.</summary>
    void OnSubscriptionCredit(CreditHeader header, string connectionHandle)
    {
    }

    /// <summary>Every result and every failure received, before it is paired with its request.</summary>
    void OnAnswerReceived(IEnvelopeHeader header, string connectionHandle)
    {
    }

    /// <summary>A failure that answers no call waiting; <c>true</c> when the side took it.</summary>
    bool OnUnpairedFailure(Envelope envelope, string connectionHandle)
    {
        return false;
    }

    /// <summary>What went wrong that no call waits on.</summary>
    void Report(Exception reason, string connectionHandle);

    /// <summary>
    /// Hands <paramref name="bytes"/> over to the transport, for a connection: at once, without
    /// blocking; the task settles once the transport sent them, or could not.
    /// </summary>
    Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle);

    /// <summary>The session of a connection, which its next answer announces when it changed.</summary>
    SessionToken? SessionTokenOf(string connectionHandle)
    {
        return null;
    }

    /// <summary>
    /// The credential schemes the side takes, in the order of their numbers: a request presenting
    /// another is refused CREDENTIAL_UNSUPPORTED, its detail naming these. None is always taken, and
    /// <see cref="CredentialScheme.Opaque"/> by every side.
    /// </summary>
    IReadOnlyList<CredentialScheme> CredentialSchemes
    {
        get
        {
            return [CredentialScheme.Opaque];
        }
    }

    /// <summary>
    /// The token of a connection's session as the side knows it — a server's, the one its answers
    /// announce; a client's, the one it learned — which a call of the side's own presenting
    /// <see cref="Credential.Opaque()"/> presents, and which the side's own resolution holds a
    /// request presenting none or <see cref="CredentialScheme.Opaque"/> to.
    /// </summary>
    SessionToken? KnownSessionTokenOf(string connectionHandle)
    {
        return SessionTokenOf(connectionHandle);
    }

    /// <summary>
    /// The call's session a request's credential resolves to, asked once per request of a scheme the
    /// side takes, between holding its call id and its admission, with the call's signal, which a
    /// cancel or its connection closing cancels (spec 9.2, step 5). None, for a request presenting
    /// none, runs it in none; for one presenting a credential, says that credential does not hold,
    /// and it is refused SESSION_REQUIRED. One that throws or faults fails it, PROCEDURE_FAILED, and
    /// is reported. It may wait, never for a request presenting none or
    /// <see cref="CredentialScheme.Opaque"/>, which resolves in the turn it came. By default, those
    /// resolve against <see cref="KnownSessionTokenOf"/>, to a session without data.
    /// </summary>
    ValueTask<CallSession?> SessionOf(SessionRequest request, CancellationToken signal)
    {
        ArgumentNullException.ThrowIfNull(request);

        return ValueTask.FromResult(CallSession.ConnectionSessionOf(
            request.Header.Credential,
            (KnownSessionTokenOf(request.ConnectionHandle), null)));
    }

    /// <summary>Each envelope, out or in, its credential left out.</summary>
    void Trace(DebugDirection direction, TracedEnvelope envelope)
    {
    }
}
