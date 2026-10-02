namespace Bead;

/// <summary>What a transport delivered: its bytes, and whether it came as text, which is no envelope.</summary>
/// <param name="Bytes">The bytes, the transport's no more: they must not change afterwards.</param>
/// <param name="IsText">Whether it came as text.</param>
public readonly record struct TransportMessage(ReadOnlyMemory<byte> Bytes, bool IsText);

/// <summary>
/// What a server's router needs of its transport: the connections that open and close, what they
/// deliver, and a way to send to each.
/// </summary>
public interface IRouterServerTransport
{
    /// <summary>A connection opened, named by its handle.</summary>
    event Action<string>? Connection;

    /// <summary>A connection delivered a message.</summary>
    event Action<TransportMessage, string>? Message;

    /// <summary>A connection closed: whether cleanly, and its handle.</summary>
    event Action<bool, string>? Close;

    /// <summary>
    /// Hands <paramref name="bytes"/> to a connection: at once, in order, without blocking; the
    /// task settles once they were sent, or could not be.
    /// </summary>
    Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle);

    /// <summary>Whether a connection carries both ways; every one does by default.</summary>
    bool IsTwoWay(string connectionHandle)
    {
        return true;
    }
}

/// <summary>How a server's router is built.</summary>
public sealed record RouterServerOptions
{
    /// <summary>What it reads, writes and holds by; <see cref="RouterLimits.Default"/> when none.</summary>
    public RouterLimits? Limits { get; init; }

    /// <summary>What its timers run on; the system's clock when none.</summary>
    public TimeProvider? Time { get; init; }

    /// <summary>What each paced subscription queues at most; <see cref="PacingLimits.Default"/> when none.</summary>
    public PacingLimits? Pacing { get; init; }

    /// <summary>How it relays a request that names a destination registered in it.</summary>
    public RelayOptions? Relay { get; init; }

    /// <summary>
    /// The session of a connection, which its next answer announces when it changed; none for none.
    /// Asked for each answer only, from the router's scheduler. No session is announced when none.
    /// </summary>
    public Func<string, SessionToken?>? SessionTokenOf { get; init; }

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
/// CAPACITY_EXCEEDED. Each answer announces its connection's session, as
/// <see cref="RouterServerOptions.SessionTokenOf"/> gives it. A request that names a destination goes
/// on through the relay to the destination registered, as <see cref="RouterServerOptions.Relay"/>
/// admits it; while none is registered, it is refused: this router relays nothing.
/// </summary>
public sealed class RouterServer : IRouterLike, IDisposable
{
    private readonly RouterCore _core;
    private readonly HashSet<string> _connections = [];
    private readonly NotificationManager _notifications;
    private readonly SubscriptionPlaces _places;
    private readonly Func<string, SessionToken?>? _sessionTokenOf;

    // the requests that name a destination go on through it; none does until one is registered
    private readonly Relay _relay;

    // the request of each paced subscription its resolver subscribed in flight, so one whose queue
    // goes past its bounds before the answer is answered with that failure
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<NotificationPacing, RequestHeader> _requests = [];

    /// <summary>A server's router over <paramref name="transport"/>.</summary>
    public RouterServer(IRouterServerTransport transport, RouterServerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        Transport = transport;
        _notifications = new NotificationManager((options?.Pacing ?? PacingLimits.Default).Validate());
        _places = new SubscriptionPlaces(
            _notifications,
            (connectionHandle) =>
            {
                return _connections.Contains(connectionHandle);
            });
        _sessionTokenOf = options?.SessionTokenOf;
        _core = new RouterCore(
            new Port(this),
            new RouterCoreOptions
            {
                Limits = options?.Limits,
                ResolverScheduler = options?.ResolverScheduler,
                Scheduler = options?.Scheduler,
                Time = options?.Time,
            });
        _relay = new Relay(
            new RelayRouter
            {
                IsTwoWay = transport.IsTwoWay,
                Limits = _core.Limits,
                Report = Report,
                Request = Request,
                Respond = Respond,
            },
            options?.Relay);
        transport.Connection += OnConnection;
        transport.Message += OnMessage;
        transport.Close += OnClose;
    }

    /// <summary>What went wrong that no call waits on, with the connection it came on.</summary>
    public event Action<Exception, string>? Error;

    /// <summary>What the router did: sent a request, took a response, sent a notification.</summary>
    public event Action<RouterActivity, string>? Activity;

    /// <summary>Each envelope, out or in, its token left out; nothing is built while none listens.</summary>
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
    /// call id. One that names none is an <see cref="ArgumentException"/>; one that names a
    /// connection not open, a <see cref="DisconnectException"/>.
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

        return _core.Loop.Run(() =>
        {
            if (!_connections.Contains(connectionHandle))
            {
                return Task.FromException<RouterResult>(new DisconnectException($"{connectionHandle} is not an open connection"));
            }

            return _core.Request(
                payload,
                new CoreRequest { ConnectionHandle = connectionHandle, Procedure = request.Procedure, Options = request.Options, OnSent = request.OnSent });
        });
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
                return request.Filter is null || request.Filter(candidate.ConnectionHandle);
            }).ToList();
            var sending = targets.Select((target) =>
            {
                var call = new CallAddress(target.CallId, target.ConnectionHandle);
                var pacing = _notifications.PacingOf(target.CallId, target.ConnectionHandle);

                if (pacing is null)
                {
                    return SendNotification(payload, call);
                }

                return pacing.Offer(payload, request.Key) switch
                {
                    PacingOutcome.Send => SendNotification(payload, call),
                    PacingOutcome.Exceeded => Exceed(call, pacing),
                    _ => Task.CompletedTask,
                };
            }).ToList();

            return Task.WhenAll(sending);
        });
    }

    /// <summary>
    /// Subscribes the connection a request came from to that request's procedure, and gives the call
    /// id of the subscription. A request that opens no subscription is an
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
                new SubscribingCall(header.CallId, connectionHandle, header.Paced),
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
    /// timeout not above 0, or past 2³¹ − 1 ms, is an <see cref="ArgumentOutOfRangeException"/>; a
    /// destination of 0, or registered already, an <see cref="ArgumentException"/>.
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
    /// Ends each subscription a connection holds, established by its answer, with
    /// <paramref name="failure"/> on its call id — SESSION_REQUIRED when its session ended, say,
    /// whose end the first failure announces — then forgets it; each call waiting ends the same way.
    /// A subscribing call still in flight is left to its own answer. Settles once each failure was
    /// tried; one that cannot go out is reported.
    /// </summary>
    public Task DropSubscriptions(string connectionHandle, Failure failure)
    {
        return _core.Loop.Run(() =>
        {
            return Task.WhenAll(_places.Drop(connectionHandle).Select((callId) =>
            {
                return EndSubscription(new CallAddress(callId, connectionHandle), failure);
            }).ToList());
        });
    }

    /// <summary>What went wrong around the router that no call waits on: told to its error event, in its turn.</summary>
    internal void Report(Exception reason, string connectionHandle)
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
            _connections.Clear();
            _places.Clear();
            _notifications.CleanAll();
        });
        _core.Dispose();
    }

    // one notification to one subscription; a connection that cannot take it keeps none of the
    // others from getting theirs
    private async Task SendNotification(ReadOnlyMemory<byte> payload, CallAddress call)
    {
        try
        {
            await _core.Send(new Envelope { Header = new NotificationHeader { CallId = call.CallId }, Payload = payload }, call.ConnectionHandle);
            Activity?.Invoke(RouterActivity.Notification, call.ConnectionHandle);
        }
        catch (Exception reason)
        {
            Error?.Invoke(reason, call.ConnectionHandle);
        }
    }

    // ends an established subscription with `failure` on its call id, forgotten as the failure goes,
    // so no notification follows it
    private async Task EndSubscription(CallAddress call, Failure failure)
    {
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
    private async Task Exceed(CallAddress call, NotificationPacing pacing)
    {
        var failure = Failure.OfProtocol(
            ProtocolCode.CapacityExceeded,
            $"the notifications queued for call {call.CallId} went past their bounds");

        if (!_requests.TryGetValue(pacing, out var request) || !_core.IsAnswering(new AnswerTarget(call.ConnectionHandle, request)))
        {
            await EndSubscription(call, failure);

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

        _core.Receive(message.Bytes, connectionHandle);
    }

    private void OnClose(bool wasClean, string connectionHandle)
    {
        _core.Post(() =>
        {
            _connections.Remove(connectionHandle);

            // its destinations stay unreachable, whoever takes its handle next
            _relay.CloseConnection(connectionHandle);
            _places.Clear(connectionHandle);
            _notifications.Clean(connectionHandle);
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

            return server._places.Settle(
                new SubscribingCall(header.CallId, connectionHandle, header.Paced),
                (answer.IsFailure,
                    header.OpensSubscription && answer.Resolver is INotificationResolver && server._connections.Contains(connectionHandle),
                    new ProcedureAddress(header.ServiceId, header.ProcedureId)));
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
            var released = server._notifications.PacingOf(header.CallId, connectionHandle)?.Credit(header.CreditEnd) ?? [];

            foreach (var payload in released)
            {
                _ = server.SendNotification(payload, new CallAddress(header.CallId, connectionHandle));
            }
        }

        public bool IsTwoWay(string connectionHandle)
        {
            return server.Transport.IsTwoWay(connectionHandle);
        }

        // a request that names a destination goes on through the relay
        public IRequestHandler? HandlerOfDestination(uint destinationId)
        {
            return server._relay.HandlerOf(destinationId);
        }

        public void Report(Exception reason, string connectionHandle)
        {
            server.Error?.Invoke(reason, connectionHandle);
        }

        public SessionToken? SessionTokenOf(string connectionHandle)
        {
            return server._sessionTokenOf?.Invoke(connectionHandle);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return server.Transport.Send(bytes, connectionHandle);
        }

        public void Trace(DebugDirection direction, TracedEnvelope envelope)
        {
            server.Debug?.Invoke(direction, envelope);
        }
    }
}
