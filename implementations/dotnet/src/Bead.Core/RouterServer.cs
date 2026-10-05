namespace Bead;

/// <summary>
/// What a transport carries, both ways: an envelope's bytes, whether they came as text, which is no
/// envelope, and the credential carried beside them (spec 15.1).
/// </summary>
/// <param name="Bytes">The bytes, the transport's no more: they must not change afterwards.</param>
/// <param name="IsText">Whether they came as text; what a transport sends goes as bytes.</param>
public readonly record struct TransportMessage(ReadOnlyMemory<byte> Bytes, bool IsText)
{
    /// <summary>
    /// The credential carried beside the envelope: over HTTP, the <c>Authorization</c> field of the
    /// <c>POST /bead</c> that carries a request, as it came, its surrounding whitespace removed; none
    /// when nothing was carried, an empty field among them. A WebSocket carries none, nor does an
    /// answer or what a listen brings back.
    /// </summary>
    public string? Credential { get; init; }
}

/// <summary>
/// What a server's router needs of its transport: the connections that open and close, what they
/// deliver, a way to send to each, and the clock it runs on.
/// </summary>
public interface IRouterServerTransport
{
    /// <summary>What its timers run on: the clock of the stack built on it.</summary>
    TimeProvider Clock { get; }

    /// <summary>A connection opened, named by its handle.</summary>
    event Action<string>? Connection;

    /// <summary>A connection delivered a message: an envelope, and the credential carried beside it.</summary>
    event Action<TransportMessage, string>? Message;

    /// <summary>A connection closed: whether cleanly, and its handle.</summary>
    event Action<bool, string>? Close;

    /// <summary>
    /// Hands <paramref name="message"/> to a connection: at once, in order, without blocking; the
    /// task settles once it was sent, or could not be. No server carries a credential: an answer and
    /// what a listen brings back carry none, nor does a socket.
    /// </summary>
    Task Send(TransportMessage message, string connectionHandle);

    /// <summary>Whether a connection carries both ways; every one does by default.</summary>
    bool IsTwoWay(string connectionHandle)
    {
        return true;
    }

    /// <summary>
    /// Whether a connection carries a credential beside an envelope the server sends on it (spec
    /// 15.1): a command presenting <see cref="CredentialScheme.Elsewhere"/>, a relay's leg B among
    /// them, needs one. None does by default, as no server's transport carries one toward its client.
    /// </summary>
    bool CarriesCredential(string connectionHandle)
    {
        return false;
    }

    /// <summary>
    /// Whether a connection is secure — its listener under TLS, or bound to the loopback, or within
    /// the machine, or as its application says what stands in front of it (spec 13.4): a command
    /// presenting a bearer credential needs one. None is by default.
    /// </summary>
    bool IsSecure(string connectionHandle)
    {
        return false;
    }
}

/// <summary>How a server's router is built.</summary>
public sealed record RouterServerOptions
{
    /// <summary>What it reads, writes and holds by; <see cref="RouterLimits.Default"/> when none.</summary>
    public RouterLimits? Limits { get; init; }

    /// <summary>
    /// What its timers run on: its transport's clock when none; another is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>What each paced subscription queues at most; <see cref="PacingLimits.Default"/> when none.</summary>
    public PacingLimits? Pacing { get; init; }

    /// <summary>How it relays a request that names a destination registered in it.</summary>
    public RelayOptions? Relay { get; init; }

    /// <summary>
    /// The session of a connection, which its next answer announces when it changed; none for none.
    /// Asked for each answer only, from the router's scheduler, and never waiting. No session is
    /// announced when none.
    /// </summary>
    public Func<string, SessionToken?>? SessionTokenOf { get; init; }

    /// <summary>
    /// The call's session a request's credential resolves to, asked once per request, with the
    /// call's signal, between holding its call id and its admission (spec 9.2, step 5): none, for a
    /// request presenting none, runs it in none; for one presenting a credential, says that
    /// credential does not hold, and it is refused SESSION_REQUIRED. One that throws or faults fails
    /// the call, PROCEDURE_FAILED, and is reported. It may wait, never for a request presenting none
    /// or <see cref="CredentialScheme.Opaque"/>, which resolves in the turn it came; a cancel or its
    /// connection closing cancels the signal, and a resolution that settles after is dropped. When
    /// none, the router knows no session: a request presenting none runs in none, and one presenting
    /// a credential does not hold.
    /// </summary>
    public Func<SessionRequest, CancellationToken, ValueTask<CallSession?>>? SessionOf { get; init; }

    /// <summary>
    /// What it resolves a request's <see cref="CredentialScheme.Jwt"/> and
    /// <see cref="CredentialScheme.Elsewhere"/> with, on its clock; it takes no other when none. A
    /// request presenting a scheme it takes none of is refused CREDENTIAL_UNSUPPORTED. Given JWT keys
    /// or a key set, its limits hold a chunk's envelope and an envelope of 1,024 bytes at least, or
    /// they do not hold together, an <see cref="ArgumentException"/> (spec 12.2); and they come with
    /// their audience, whatever its relay does, or they are an <see cref="ArgumentException"/>
    /// (spec 13.8).
    /// </summary>
    public Credentials? Credentials { get; init; }

    /// <summary>
    /// What it counts its calls answered, its commands and its notifications sent into, at its gates
    /// (spec/debugging.md 7.1); none counts nothing.
    /// </summary>
    public MetricsRegistry? MetricsRegistry { get; init; }

    /// <summary>
    /// The credential schemes it takes besides <see cref="CredentialScheme.Opaque"/> and those its
    /// credentials give, which <see cref="SessionOf"/> resolves: a test's own.
    /// </summary>
    internal IReadOnlyCollection<CredentialScheme>? CredentialSchemes { get; init; }

    /// <summary>Where resolvers run: the thread pool when none.</summary>
    internal TaskScheduler? ResolverScheduler { get; init; }

    /// <summary>The scheduler the router runs on; one of its own when none.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// The server side of a router, over any transport that meets
/// <see cref="IRouterServerTransport"/>; built before the transport starts, so it sees every
/// connection. A connection's requests go to the resolvers registered, by service and procedure; a
/// request of the router's own — a command — goes to the connection its options name, on an even
/// call id. A notification goes to each connection subscribed, under the call id of the request that
/// subscribed it: a connection subscribes by getting a successful answer from a notification's
/// resolver to a request that opens a subscription, and its first subscription to a procedure is the
/// one it keeps. A paced subscription gets a notification while its client credited one, and queues
/// the others, within <see cref="RouterServerOptions.Pacing"/>; past it, it ends with
/// CAPACITY_EXCEEDED. Each request runs in its call's session, which its credential resolves to by
/// <see cref="RouterServerOptions.SessionOf"/> — a <see cref="CredentialScheme.Jwt"/> and an
/// <see cref="CredentialScheme.Elsewhere"/> by its <see cref="RouterServerOptions.Credentials"/> —
/// and each answer announces its connection's session, as
/// <see cref="RouterServerOptions.SessionTokenOf"/> gives it. A connection holds one subscription
/// per procedure and per session (spec 11.3): its connection's, for calls presenting none or OPAQUE,
/// and each credential's, kept while it bounds one and ended at its end on a timer of the router's
/// clock, or by <see cref="EndSession"/> or <see cref="EndSessionsOf"/>. A request that names a
/// destination goes on through the relay to the destination registered, as
/// <see cref="RouterServerOptions.Relay"/> admits it; while none is registered, it is refused: this
/// router relays nothing.
/// </summary>
public sealed class RouterServer : IRouterLike, IDisposable
{
    private readonly RouterCore _core;

    // what it counts its calls and its notifications through, attached to the registry it was
    // given; none when it was given none
    private readonly RouterSeries? _metrics;

    private readonly HashSet<string> _connections = [];
    private readonly NotificationManager _notifications;
    private readonly SubscriptionPlaces _places;
    private readonly Func<string, SessionToken?>? _sessionTokenOf;
    private readonly Func<SessionRequest, CancellationToken, ValueTask<CallSession?>>? _sessionOf;

    // what resolves a JWT and an ELSEWHERE, from its credentials
    private readonly CredentialResolver _resolver;

    // the credential schemes it takes, OPAQUE among them, in the order of their numbers
    private readonly IReadOnlyList<CredentialScheme> _credentialSchemes;

    // the credentials' sessions kept, by connection and identifier, each while it bounds a
    // subscription: its end, and the one timer toward it
    private readonly Dictionary<SubscriptionPlace, Kept> _kept = [];

    // the requests that name a destination go on through it; none does until one is registered
    private readonly Relay _relay;

    // the request of each paced subscription its resolver subscribed in flight, so one whose queue
    // goes past its bounds before the answer is answered with that failure
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<NotificationPacing, RequestHeader> _requests = [];

    /// <summary>
    /// A server's router over <paramref name="transport"/>, on its transport's clock: one given that
    /// differs is an <see cref="ArgumentException"/>.
    /// </summary>
    public RouterServer(IRouterServerTransport transport, RouterServerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        var clock = Clocks.Of((options?.Clock, transport.Clock), ("a server's router", "its transport"));

        Transport = transport;
        _notifications = new NotificationManager((options?.Pacing ?? PacingLimits.Default).Validate());
        _places = new SubscriptionPlaces(
            _notifications,
            (connectionHandle) =>
            {
                return _connections.Contains(connectionHandle);
            });
        _sessionTokenOf = options?.SessionTokenOf;
        _sessionOf = options?.SessionOf;
        _metrics = options?.MetricsRegistry?.Give(RouterSide.Server);
        _core = new RouterCore(
            new Port(this),
            new RouterCoreOptions
            {
                Limits = options?.Limits,
                ResolverScheduler = options?.ResolverScheduler,
                Scheduler = options?.Scheduler,
                Clock = clock,
                Metrics = _metrics,
            });

        // * what a key set's deadline does goes on the router's scheduler, as its other timers' work
        _resolver = new CredentialResolver(options?.Credentials, (clock, _core.Post));
        _credentialSchemes = [.. (options?.CredentialSchemes ?? []).Concat(_resolver.Schemes).Distinct().Order()];
        CredentialResolver.AssertLimits(_core.Limits, _resolver.TakesJwt);
        _relay = new Relay(
            new RelayRouter
            {
                CarriesCredential = transport.CarriesCredential,
                IsSecure = transport.IsSecure,
                IsTwoWay = transport.IsTwoWay,
                Limits = _core.Limits,
                Report = Report,
                Request = Request,
                Respond = Respond,
            },
            options?.Relay);
        _notifications.OnRegister = OnSubscribed;
        _notifications.OnRemove = OnUnsubscribed;
        _notifications.SeriesOf = _core.NotifyingSeriesOf;
        transport.Connection += OnConnection;
        transport.Message += OnMessage;
        transport.Close += OnClose;
    }

    /// <summary>
    /// What went wrong that no call waits on, with the connection it came on; none for what belongs
    /// to no connection's step — a debug listener's error as a notification is traced, say.
    /// </summary>
    public event Action<Exception, string?>? Error;

    /// <summary>What the router did: sent a request, took a response, sent a notification.</summary>
    public event Action<RouterActivity, string>? Activity;

    /// <summary>
    /// Each envelope, out or in, on its connection, its credential's scheme alone in place of its
    /// credential; nothing is built while none listens. A listener that throws is reported through
    /// <see cref="Error"/>, with that connection, and changes nothing.
    /// </summary>
    public event Action<DebugDirection, TracedEnvelope>? Debug;

    /// <inheritdoc/>
    public RouterSide Side
    {
        get
        {
            return RouterSide.Server;
        }
    }

    /// <summary>What it reads, writes and holds by.</summary>
    public RouterLimits Limits
    {
        get
        {
            return _core.Limits;
        }
    }

    /// <inheritdoc/>
    public TimeProvider Clock
    {
        get
        {
            return _core.Clock;
        }
    }

    /// <summary>Its transport.</summary>
    public IRouterServerTransport Transport { get; }

    /// <inheritdoc/>
    public void RegisterResolver(IRequestResolver resolver)
    {
        _core.RegisterResolver(resolver);
    }

    /// <inheritdoc/>
    public Task Respond(RouterAnswer response, AnswerTarget target)
    {
        return _core.Respond(response, target);
    }

    /// <summary>
    /// A request of the router's own — a command — to the connection its options name, on an even
    /// call id. One that names none is an <see cref="ArgumentException"/>, refused before it starts;
    /// one that names a connection not open, a <see cref="DisconnectException"/>, as it starts.
    /// </summary>
    public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.Subscribes is not null)
        {
            throw new InvalidOperationException("a server does not subscribe to notifications; it sends them");
        }

        var connectionHandle = request.Options.ConnectionHandle
            ?? throw new ArgumentException("a server request names the connection it goes to", nameof(request));

        return _core.Request(
            payload,
            new CoreRequest
            {
                ConnectionHandle = connectionHandle,
                OnSent = request.OnSent,
                Options = request.Options,
                Procedure = request.Procedure,
                Series = request.Series,
            });
    }

    /// <inheritdoc/>
    public ProcedureSeries? DeclareRequester(Procedure procedure)
    {
        ArgumentNullException.ThrowIfNull(procedure);

        return _metrics is { } metrics ? new ProcedureSeries(metrics.DeclareRequester(procedure)) : null;
    }

    /// <summary>
    /// Notifies each connection subscribed to a procedure, as its filter keeps them, in order: a
    /// paced subscription sends it, queues it, or ends past its bounds. Settles once each was sent or
    /// queued; one that cannot go out is reported, and keeps none of the others from going.
    /// </summary>
    public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        return _core.Loop.Run(() =>
        {
            // who gets it is settled before any is sent
            var targets = _notifications.Candidates(request.Procedure).Where((candidate) =>
            {
                return request.Filter is null
                    || request.Filter(candidate.ConnectionHandle, _notifications.SubscriptionAt(candidate.CallId, candidate.ConnectionHandle)?.Session);
            }).ToList();
            var sending = targets.Select((target) =>
            {
                var call = new CallAddress(target.CallId, target.ConnectionHandle);
                var (pacing, series) = _notifications.TargetOf(target.CallId, target.ConnectionHandle);

                if (pacing is null)
                {
                    return SendNotification(payload, (call, series));
                }

                return pacing.Offer(payload, request.Key) switch
                {
                    PacingOutcome.Send => SendNotification(payload, (call, series)),
                    PacingOutcome.Exceeded => Exceed(call, (pacing, series)),
                    _ => Task.CompletedTask,
                };
            }).ToList();

            return Task.WhenAll(sending);
        });
    }

    /// <summary>
    /// Subscribes the connection a request came from to that request's procedure, in the call's
    /// session, which bounds it, and gives the call id of the subscription. A request that opens no subscription is an
    /// <see cref="InvalidOperationException"/>; a connection closed, a
    /// <see cref="DisconnectException"/>; a call cancelled or answered already, an
    /// <see cref="OperationCanceledException"/>.
    /// </summary>
    public Task<uint> Subscribe(AnswerTarget target)
    {
        var (connectionHandle, header) = target;

        ArgumentNullException.ThrowIfNull(header);

        return _core.Loop.Run(() =>
        {
            // its requester asked for an answer alone, and would take the notifications for nothing
            if (!header.OpensSubscription)
            {
                return Task.FromException<uint>(new InvalidOperationException(
                    $"call {header.CallId} opens no subscription: an ordinary request to {header.ServiceId}/{header.ProcedureId} subscribes nothing"));
            }

            if (!_connections.Contains(connectionHandle))
            {
                return Task.FromException<uint>(new DisconnectException($"{connectionHandle} is not an open connection"));
            }

            if (!_core.IsAnswering(target))
            {
                return Task.FromException<uint>(new OperationCanceledException($"call {header.CallId} was cancelled, or answered already"));
            }

            var subscribed = _places.Subscribe(
                new SubscribingCall(header.CallId, connectionHandle, header.Paced) { Session = _core.SessionOf(target) },
                new ProcedureAddress(header.ServiceId, header.ProcedureId));

            // the call took the place, in flight: its request answers it, should its queue go past
            // its bounds before its answer
            if (subscribed == header.CallId && _notifications.PacingOf(subscribed, connectionHandle) is { } pacing)
            {
                _requests.AddOrUpdate(pacing, header);
            }

            return Task.FromResult(subscribed);
        });
    }

    /// <summary>
    /// Registers a connection of the router's own as a destination, which the relay asks by a request
    /// of the router's: the destination given, or drawn. Once that connection closes, the destination
    /// is unreachable, whoever connects under the same handle next, until it is registered anew. A
    /// timeout under a millisecond, or past 2³¹ − 1 ms, is an
    /// <see cref="ArgumentOutOfRangeException"/>; a destination of 0, or registered already, an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public DestinationRegistration RegisterDestination(ConnectionTarget target, DestinationOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(target);

        return _relay.Register(target, options);
    }

    /// <summary>
    /// Registers a client's router the relay calls through as a destination, as
    /// <see cref="RegisterDestination(ConnectionTarget, DestinationOptions?)"/> does a connection.
    /// </summary>
    public DestinationRegistration RegisterDestination(IRouterTarget target, DestinationOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(target);

        return _relay.Register(target, options);
    }

    /// <summary>
    /// What it and its parts hold — its core, its subscriptions' places, its notifications, its relay
    /// — for the connections it follows, which it forgets as each closes; taken on its scheduler.
    /// </summary>
    public Task<Gauges> Gauges()
    {
        return _core.Loop.Run(() =>
        {
            return Task.FromResult(Bead.Gauges.Merge(
            [
                Bead.Gauges.Of(new Dictionary<string, long> { ["connections"] = _connections.Count }, _connections),
                _core.Gauges(),
                _places.Gauges(),
                _notifications.Gauges(),
                _relay.Gauges(),
            ]));
        });
    }

    /// <summary>The destinations registered, each as its registration names it, for the application to publish.</summary>
    public IReadOnlyList<Destination> Destinations()
    {
        return _relay.Destinations();
    }

    /// <summary>A server holds no notification: it sends them.</summary>
    public bool HasNotification(INotificationLike notification)
    {
        return false;
    }

    /// <summary>A server subscribes to no notification: an <see cref="InvalidOperationException"/>.</summary>
    public Task RegisterNotification(INotificationLike notification)
    {
        return Task.FromException(new InvalidOperationException("a server does not subscribe to notifications; it sends them"));
    }

    /// <summary>A server subscribes to no notification: an <see cref="InvalidOperationException"/>.</summary>
    public Task UnregisterNotification(INotificationLike notification, bool cancel = true)
    {
        return Task.FromException(new InvalidOperationException("a server does not subscribe to notifications; it sends them"));
    }

    /// <summary>
    /// Ends each subscription a connection's session bounds — those of the connection that no
    /// credential's session bounds — established by its answer, with <paramref name="failure"/> on
    /// its call id — SESSION_REQUIRED when its session ended, say, whose end the first failure
    /// announces — then forgets it; each call waiting ends the same way. A subscribing call still in
    /// flight is left to its own answer. Settles once each failure was tried; one that cannot go out
    /// is reported.
    /// </summary>
    public Task DropSubscriptions(string connectionHandle, Failure failure)
    {
        return _core.Loop.Run(() =>
        {
            return Task.WhenAll(_places.Drop(connectionHandle).Select((dropped) =>
            {
                return EndSubscription((new CallAddress(dropped.CallId, connectionHandle), _core.NotifyingSeriesOf(dropped.Procedure)), failure);
            }).ToList());
        });
    }

    /// <summary>
    /// Ends a credential's session by its identifier on every connection that keeps it, and nothing
    /// else: each subscription it bounds fails SESSION_REQUIRED on its call id (spec 13.9). An
    /// identifier no connection keeps ends nothing. Ending a session refuses no credential: one that
    /// still holds opens it anew, a call that resolved to it before it ended and subscribes as it is
    /// answered after among them. Settles once each failure was tried; one that cannot go out is
    /// reported.
    /// </summary>
    public Task EndSession(SessionIdentifier identifier)
    {
        ArgumentNullException.ThrowIfNull(identifier);

        return _core.Loop.Run(() =>
        {
            return Task.WhenAll(_kept.Keys.Where((place) =>
            {
                return place.Session == identifier;
            }).ToList().Select(EndKept).ToList());
        });
    }

    /// <summary>
    /// Ends every credential's session of an issuer alike, as when a key of that issuer's leaks:
    /// each <see cref="CredentialScheme.Jwt"/>'s session whose identifier's issuer it is, compared
    /// octet for octet, whatever its <c>sid</c> or <c>sub</c>, on every connection that keeps one,
    /// and nothing else — an <see cref="CredentialScheme.Elsewhere"/>'s identifier names no
    /// issuer. Each subscription they bound fails SESSION_REQUIRED on its call id (spec 13.9). An
    /// issuer no kept session names ends nothing. Ending a session refuses no credential: one that
    /// still holds opens its session anew, a token a leaked key signed among them while that key
    /// serves. Settles once each failure was tried; one that cannot go out is reported. An issuer
    /// that is null is an <see cref="ArgumentNullException"/>.
    /// </summary>
    public Task EndSessionsOf(string issuer)
    {
        ArgumentNullException.ThrowIfNull(issuer);

        return _core.Loop.Run(() =>
        {
            return Task.WhenAll(_kept.Keys.Where((place) =>
            {
                return place.Session is { Scheme: CredentialScheme.Jwt, Issuer: { } named } && string.Equals(named, issuer, StringComparison.Ordinal);
            }).ToList().Select(EndKept).ToList());
        });
    }

    /// <summary>
    /// What went wrong around the router that no call waits on — a debug listener's error among it —
    /// told to its error event with the connection it came with, none for what belongs to no
    /// connection's step, in its turn.
    /// </summary>
    public void Report(Exception reason, string? connectionHandle)
    {
        _core.Post(() =>
        {
            Error?.Invoke(reason, connectionHandle);
        });
    }

    /// <summary>Takes a subscription away, as its requester asks; whether the connection held it.</summary>
    public Task<bool> Unsubscribe(CallAddress call)
    {
        return _core.Loop.Run(() =>
        {
            return Task.FromResult(_places.Unsubscribe(call));
        });
    }

    /// <summary>
    /// Follows no connection any more, forgets its subscriptions, rejects what still waits and
    /// cancels the signal of each call it still answers.
    /// </summary>
    public void Dispose()
    {
        Transport.Connection -= OnConnection;
        Transport.Message -= OnMessage;
        Transport.Close -= OnClose;
        _core.Post(() =>
        {
            DropEstablished(null);
            _connections.Clear();
            _places.Clear();
            _notifications.CleanAll();
            Forget(null);
        });
        _core.Dispose();
    }

    // the end a credential's session gives, in milliseconds since the epoch; none for one no timer
    // ends
    private static long? EndOf(CallSession session)
    {
        return session.End;
    }

    // whether an end is later than another, none — a session no timer ends — the latest
    private static bool IsLater(long? end, long? than)
    {
        return than is { } before && (end is not { } after || after > before);
    }

    // a call that subscribed in a credential's session keeps that session on its connection, with
    // the later of its end and the one kept
    private void OnSubscribed(SubscribingCall call)
    {
        if (call.Session is not { Identifier: not null } session || !_connections.Contains(call.ConnectionHandle))
        {
            return;
        }

        var place = call.Place;

        if (_kept.TryGetValue(place, out var kept))
        {
            if (IsLater(EndOf(session), kept.End))
            {
                kept.End = EndOf(session);
                Arm(place, kept);
            }

            return;
        }

        kept = new Kept { End = EndOf(session) };
        _kept[place] = kept;
        Arm(place, kept);
    }

    // a credential's session that bounds no subscription any more is kept no more, nor timed
    private void OnUnsubscribed(Subscription subscription)
    {
        if (subscription.Session is not { } identifier)
        {
            return;
        }

        var place = new SubscriptionPlace(subscription.ConnectionHandle, identifier);

        if (!_kept.TryGetValue(place, out var kept)
            || _notifications.Subscriptions(subscription.ConnectionHandle).Any((held) =>
            {
                return held.Session == identifier;
            }))
        {
            return;
        }

        _kept.Remove(place);
        kept.Stop();
    }

    // a call resolving to the identifier of a session its connection keeps moves that end to the
    // later of the two, and runs with it: a credential renewed keeps its subscriptions
    private CallSession Renew(CallSession session, string connectionHandle)
    {
        var place = new SubscriptionPlace(connectionHandle, session.Identifier);

        if (!_kept.TryGetValue(place, out var kept))
        {
            return session;
        }

        if (IsLater(EndOf(session), kept.End))
        {
            kept.End = EndOf(session);
            Arm(place, kept);
        }

        return session with { End = kept.End };
    }

    // the timer toward a kept session's end, in place of the one before, from the wall clock read
    // now, never counted down: R = E − W, ended at once at R ≤ 0, else armed for R, or for the
    // longest timer, whose due reads it again
    private void Arm(SubscriptionPlace place, Kept kept)
    {
        kept.Stop();

        if (kept.End is not { } end)
        {
            return;
        }

        var remaining = end - _core.Clock.GetUtcNow().ToUnixTimeMilliseconds();
        var generation = kept.Generation;

        // ended then, no timer armed: in its own turn, past what subscribed or renewed it
        if (remaining <= 0)
        {
            _core.Post(() =>
            {
                if (kept.Generation == generation && _kept.TryGetValue(place, out var current) && ReferenceEquals(current, kept))
                {
                    _ = EndKept(place);
                }
            });

            return;
        }

        kept.Timer = _core.Clock.CreateTimer(
            (_) =>
            {
                _core.Post(() =>
                {
                    if (kept.Generation == generation && _kept.TryGetValue(place, out var current) && ReferenceEquals(current, kept))
                    {
                        Arm(place, kept);
                    }
                });
            },
            null,
            TimeSpan.FromMilliseconds(Math.Min(remaining, int.MaxValue)),
            Timeout.InfiniteTimeSpan);
    }

    // a kept session that ends ends the subscriptions it bounds on its connection, each with
    // SESSION_REQUIRED on its call id; a call still unanswered is left to its own answer
    private Task EndKept(SubscriptionPlace place)
    {
        if (_kept.Remove(place, out var kept))
        {
            kept.Stop();
        }

        var failure = Failure.OfProtocol(ProtocolCode.SessionRequired, "its credential's session ended");

        return Task.WhenAll(_places.Drop(place).Select((dropped) =>
        {
            return EndSubscription((new CallAddress(dropped.CallId, place.ConnectionHandle), _core.NotifyingSeriesOf(dropped.Procedure)), failure);
        }).ToList());
    }

    // the kept sessions of a connection that closed, or every one, forgotten with their timers
    private void Forget(string? connectionHandle)
    {
        foreach (var place in _kept.Keys.Where((place) =>
        {
            return connectionHandle is null || place.ConnectionHandle == connectionHandle;
        }).ToList())
        {
            _kept.Remove(place, out var kept);
            kept?.Stop();
        }
    }

    // the subscriptions a close ends — a connection's, or every one — each dropped with no code, at
    // the side that notifies (spec/debugging.md 10.3)
    private void DropEstablished(string? connectionHandle)
    {
        foreach (var (_, procedure) in _places.Established(connectionHandle))
        {
            _core.NotifyingSeriesOf(procedure)?.Dropped.Drop(null);
        }
    }

    // one notification to one subscription, counted into its series as it is handed to its
    // transport or as it cannot be; a connection that cannot take it keeps none of the others from
    // getting theirs
    private async Task SendNotification(ReadOnlyMemory<byte> payload, (CallAddress Call, NotifyingSeries? Series) to)
    {
        var (call, series) = to;

        try
        {
            await _core.SendNotification(
                new Envelope { Header = new NotificationHeader { CallId = call.CallId }, Payload = payload },
                (call.ConnectionHandle, series));
            Activity?.Invoke(RouterActivity.Notification, call.ConnectionHandle);
        }
        catch (Exception reason)
        {
            Error?.Invoke(reason, call.ConnectionHandle);
        }
    }

    // ends an established subscription with `failure` on its call id, forgotten as the failure goes,
    // so no notification follows it: dropped, by the failure's code, at the side that notifies
    private async Task EndSubscription((CallAddress Call, NotifyingSeries? Series) subscription, Failure failure)
    {
        var call = subscription.Call;

        subscription.Series?.Dropped.Drop(failure);

        var sending = _core.Send(
            new Envelope { Header = new FailureHeader { CallId = call.CallId }, Failure = failure },
            call.ConnectionHandle);

        _notifications.Unregister(call.CallId, call.ConnectionHandle);

        try
        {
            await sending;
        }
        catch (Exception reason)
        {
            Error?.Invoke(reason, call.ConnectionHandle);
        }
    }

    // a subscription that queued past its bounds ends: in flight, its call is answered with the
    // failure, which takes away what it subscribed; established, the failure follows its answer
    private async Task Exceed(CallAddress call, (NotificationPacing Pacing, NotifyingSeries? Series) target)
    {
        var failure = Failure.OfProtocol(
            ProtocolCode.CapacityExceeded,
            $"the notifications queued for call {call.CallId} went past their bounds");

        if (!_requests.TryGetValue(target.Pacing, out var request) || !_core.IsAnswering(new AnswerTarget(call.ConnectionHandle, request)))
        {
            await EndSubscription((call, target.Series), failure);

            return;
        }

        try
        {
            await _core.Respond(RouterAnswer.OfFailure(failure), new AnswerTarget(call.ConnectionHandle, request));
        }
        catch (Exception reason)
        {
            Error?.Invoke(reason, call.ConnectionHandle);
        }
    }

    private void OnConnection(string connectionHandle)
    {
        _core.Post(() =>
        {
            _connections.Add(connectionHandle);
        });
    }

    private void OnMessage(TransportMessage message, string connectionHandle)
    {
        // a connection that speaks is open, even one opened before the router was built
        _core.Post(() =>
        {
            _connections.Add(connectionHandle);
        });

        if (message.IsText)
        {
            _core.Post(() =>
            {
                Error?.Invoke(FailureException.OfProtocol(ProtocolCode.EnvelopeMalformed, RouterSide.Server, "an envelope is binary, not a string"), connectionHandle);
            });

            return;
        }

        _core.Receive(message, connectionHandle);
    }

    private void OnClose(bool wasClean, string connectionHandle)
    {
        _core.Post(() =>
        {
            _connections.Remove(connectionHandle);

            // its destinations stay unreachable, whoever takes its handle next
            _relay.CloseConnection(connectionHandle);
            DropEstablished(connectionHandle);
            _places.Clear(connectionHandle);
            _notifications.Clean(connectionHandle);
            Forget(connectionHandle);
        });
        _core.RejectPending("the connection closed before the answer", connectionHandle);
    }

    // what sets the server's side apart, for its core
    private sealed class Port(RouterServer server) : IRouterCorePort
    {
        public RouterSide Side
        {
            get
            {
                return RouterSide.Server;
            }
        }

        // a server sends notifications: a credit for a subscription it does not hold crossed its end
        public bool SendsNotifications
        {
            get
            {
                return true;
            }
        }

        public void Activity(RouterActivity activity, string connectionHandle)
        {
            server.Activity?.Invoke(activity, connectionHandle);
        }

        public bool IsTracing
        {
            get
            {
                return server.Debug is not null;
            }
        }

        // a command to a connection not open fails as one whose connection closes, once it started
        public bool IsOpen(string connectionHandle)
        {
            return server._connections.Contains(connectionHandle);
        }

        // a request of the peer's on a subscription's call id would answer that subscription
        public bool IsCallIdInUse(uint callId, string connectionHandle)
        {
            return server._notifications.Has(callId, connectionHandle);
        }

        // a notification's resolver answering a request that opens a subscription, on a connection
        // still open, subscribes it as the answer goes out
        public Action? BeforeAnswer(AnswerInfo answer)
        {
            var (connectionHandle, header) = answer.Target;
            var call = new SubscribingCall(header.CallId, connectionHandle, header.Paced) { Session = answer.Session };
            var undo = server._places.Settle(
                call,
                (answer.IsFailure,
                    header.OpensSubscription && answer.Resolver is INotificationResolver && server._connections.Contains(connectionHandle),
                    new ProcedureAddress(header.ServiceId, header.ProcedureId)));

            // a call in flight whose session ended meanwhile keeps it anew as its answer subscribes
            // it, which ends it then should its end be reached
            if (server._notifications.SubscriptionAt(header.CallId, connectionHandle) is { Session: { } identifier } && identifier == answer.Session?.Identifier)
            {
                server.OnSubscribed(call);
            }

            return undo;
        }

        // a cancel takes away what its call subscribed, established or still in flight
        public void OnCancel(uint callId, string connectionHandle)
        {
            server._places.Cancel(new CallAddress(callId, connectionHandle));
        }

        // a credit lets go what the subscription queued; one for a subscription gone may have crossed
        // its end, and is dropped in silence
        public void OnSubscriptionCredit(CreditHeader header, string connectionHandle)
        {
            var (pacing, series) = server._notifications.TargetOf(header.CallId, connectionHandle);
            var released = pacing?.Credit(header.CreditEnd) ?? [];

            foreach (var payload in released)
            {
                _ = server.SendNotification(payload, (new CallAddress(header.CallId, connectionHandle), series));
            }
        }

        public bool IsTwoWay(string connectionHandle)
        {
            return server.Transport.IsTwoWay(connectionHandle);
        }

        public bool CarriesCredential(string connectionHandle)
        {
            return server.Transport.CarriesCredential(connectionHandle);
        }

        public bool IsSecure(string connectionHandle)
        {
            return server.Transport.IsSecure(connectionHandle);
        }

        // a request that names a destination goes on through the relay
        public IRequestHandler? HandlerOfDestination(RequestHeader header)
        {
            return server._relay.HandlerOf(header);
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            server.Error?.Invoke(reason, connectionHandle);
        }

        public SessionToken? SessionTokenOf(string connectionHandle)
        {
            return server._sessionTokenOf?.Invoke(connectionHandle);
        }

        public IReadOnlyList<CredentialScheme> CredentialSchemes
        {
            get
            {
                return server._credentialSchemes;
            }
        }

        // a JWT and an ELSEWHERE by its credentials — a relay's that verifies held to the audiences
        // its destinations were registered with as the call came — and the rest by the server's own
        // resolution, when it gives one; without it, the router knows no session: a request
        // presenting none runs in none, and one presenting a credential does not hold.
        // SessionTokenOf stays the announcement's alone, asked for each answer
        public ValueTask<CallSession?> SessionOf(SessionRequest request, CancellationToken signal)
        {
            if (request.Header.Credential?.Scheme is { } scheme && server._resolver.Schemes.Contains(scheme) && scheme != CredentialScheme.Opaque)
            {
                return server._resolver.Resolve(
                    request.Header.DestinationId is null ? request : request with { Audiences = server._relay.Audiences() },
                    signal);
            }

            if (server._sessionOf is { } sessionOf)
            {
                return sessionOf(request, signal);
            }

            return ValueTask.FromResult<CallSession?>(null);
        }

        public CallSession OnResolved(CallSession session, string connectionHandle)
        {
            return server.Renew(session, connectionHandle);
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return server.Transport.Send(message, connectionHandle);
        }

        // each listener within a guard: what one throws is reported with its connection, and changes
        // nothing
        public void Trace(DebugDirection direction, TracedEnvelope envelope)
        {
            if (server.Debug is not { } debug)
            {
                return;
            }

            foreach (var listener in debug.GetInvocationList())
            {
                try
                {
                    ((Action<DebugDirection, TracedEnvelope>)listener)(direction, envelope);
                }
                catch (Exception reason)
                {
                    server.Error?.Invoke(reason, envelope.ConnectionHandle);
                }
            }
        }
    }

    // a credential's session kept on a connection: its end in milliseconds since the epoch, none
    // for one no timer ends, and the one timer toward it, whose arming stands while its generation
    // does
    private sealed class Kept
    {
        public long? End { get; set; }

        public ITimer? Timer { get; set; }

        public int Generation { get; private set; }

        // its timer stopped, and one whose due was on its way ends nothing
        public void Stop()
        {
            Timer?.Dispose();
            Timer = null;
            Generation += 1;
        }
    }
}
