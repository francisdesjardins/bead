using System.Collections.Concurrent;

namespace Bead;

/// <summary>
/// What a client's router needs of its transport: what its one connection delivers, its close, its
/// replacement when it reconnects, a way to send on it, and the clock it runs on.
/// </summary>
public interface IRouterClientTransport
{
    /// <summary>What its timers run on: the clock of the stack built on it.</summary>
    TimeProvider Clock { get; }

    /// <summary>The connection delivered a message.</summary>
    event Action<TransportMessage>? Message;

    /// <summary>
    /// The connection closed: whether it was clean — what this side's close was told, false when the
    /// peer or the network closed it — and whether it was dropped without a close handshake.
    /// </summary>
    event Action<bool, bool>? Close;

    /// <summary>
    /// A reconnection starts: what was sent on the connection it replaces will not be answered
    /// there, and that connection tells no close. Never raised by default, for a transport that does
    /// not reconnect.
    /// </summary>
    event Action? Reconnect
    {
        add
        {
        }

        remove
        {
        }
    }

    /// <summary>
    /// Hands <paramref name="bytes"/> to the connection: at once, in order, without blocking; the
    /// task settles once they were sent, or could not be.
    /// </summary>
    Task Send(ReadOnlyMemory<byte> bytes);
}

/// <summary>How a client's router is built.</summary>
public sealed record RouterClientOptions
{
    /// <summary>What it reads, writes and holds by; <see cref="RouterLimits.Default"/> when none.</summary>
    public RouterLimits? Limits { get; init; }

    /// <summary>
    /// What its timers run on: its transport's clock when none; another is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// Where resolvers run, and notifications' callbacks: the thread pool for the first, one
    /// serial scheduler of their own for the second, in the order they came, when none.
    /// </summary>
    internal TaskScheduler? ResolverScheduler { get; init; }

    /// <summary>The scheduler the router runs on; one of its own when none.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// The client side of a router, over any transport that meets <see cref="IRouterClientTransport"/>.
/// The request itself — its call id, its pairing, its timeout and its cancel — is the core's: this
/// router binds the notifications to the calls that subscribe them, learns the session the server
/// announces, and answers the server's own requests, its commands, with the resolvers registered.
/// A notification's callbacks run in the order the notifications came, never on the router's
/// scheduler. A connection that closes, or that a reconnection replaces, takes with it what still
/// waits, the session and the notifications.
/// </summary>
public sealed class RouterClient : IRouterLike, IRouterTarget, IDisposable
{
    /// <summary>How a client's router names its one peer, the server.</summary>
    public const string ServerConnectionHandle = "server";

    private readonly RouterCore _core;
    private readonly TaskScheduler _callbacks;

    // the notification registered for each procedure, until it is unregistered or dropped
    private readonly ConcurrentDictionary<ProcedureAddress, INotificationLike> _notifications = new();

    // each subscription by the call id that opened it, and each notification's call id: the
    // router's scheduler alone touches them
    private readonly Dictionary<uint, Bound> _subscriptions = [];
    private readonly Dictionary<INotificationLike, uint> _callIds = new(ReferenceEqualityComparer.Instance);

    // the session the server announced last, boxed, so a read from any thread sees it whole
    private volatile object? _sessionToken;

    /// <summary>
    /// A client's router over <paramref name="transport"/>, on its transport's clock: one given that
    /// differs is an <see cref="ArgumentException"/>.
    /// </summary>
    public RouterClient(IRouterClientTransport transport, RouterClientOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        var clock = Clocks.Of((options?.Clock, transport.Clock), ("a client's router", "its transport"));

        Transport = transport;
        _callbacks = options?.ResolverScheduler ?? new SerialScheduler();
        _core = new RouterCore(
            new Port(this),
            new RouterCoreOptions
            {
                Limits = options?.Limits,
                ResolverScheduler = options?.ResolverScheduler,
                Scheduler = options?.Scheduler,
                Clock = clock,
            });
        transport.Message += OnMessage;
        transport.Close += OnClose;
        transport.Reconnect += OnReconnect;
    }

    /// <summary>What went wrong that no call waits on.</summary>
    public event Action<Exception>? Error;

    /// <summary>What the router did: sent a request, took a response, took a notification.</summary>
    public event Action<RouterActivity>? Activity;

    /// <summary>Each envelope, out or in, its token left out; nothing is built while none listens.</summary>
    public event Action<DebugDirection, TracedEnvelope>? Debug;

    /// <inheritdoc/>
    public RouterSide Side
    {
        get
        {
            return RouterSide.Client;
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

    /// <summary>
    /// The session the server announced last, which the connection is: the client never presents
    /// it. None before any, once ended, or once the connection closed or a reconnection replaced it.
    /// </summary>
    public SessionToken? SessionToken
    {
        get
        {
            return _sessionToken is SessionToken token ? token : null;
        }
    }

    /// <summary>Its transport.</summary>
    public IRouterClientTransport Transport { get; }

    /// <summary>Its core, for the tests to know when it settled.</summary>
    internal RouterCore Core
    {
        get
        {
            return _core;
        }
    }

    /// <inheritdoc/>
    public void RegisterResolver(IRequestResolver resolver)
    {
        _core.RegisterResolver(resolver);
    }

    /// <inheritdoc/>
    public Task Respond(RouterAnswer response, AnswerTarget target)
    {
        return _core.Respond(response, target with { ConnectionHandle = ServerConnectionHandle });
    }

    /// <summary>Only a server notifies: an <see cref="InvalidOperationException"/>.</summary>
    public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
    {
        return Task.FromException(new InvalidOperationException("only a server notifies; a client asks with a request"));
    }

    /// <summary>Only a server subscribes a connection: an <see cref="InvalidOperationException"/>.</summary>
    public Task<uint> Subscribe(AnswerTarget target)
    {
        return Task.FromException<uint>(new InvalidOperationException("only a server subscribes a connection; a client asks with a request"));
    }

    /// <inheritdoc/>
    public bool HasNotification(INotificationLike notification)
    {
        ArgumentNullException.ThrowIfNull(notification);

        return _notifications.TryGetValue(notification.Procedure.Address, out var held) && ReferenceEquals(held, notification);
    }

    /// <inheritdoc/>
    public Task RegisterNotification(INotificationLike notification)
    {
        ArgumentNullException.ThrowIfNull(notification);

        return _core.Loop.Run(() =>
        {
            return _notifications.TryAdd(notification.Procedure.Address, notification)
                ? Task.CompletedTask
                : Task.FromException(new InvalidOperationException($"{notification.Procedure.ProcedureName} is already a registered notification"));
        });
    }

    /// <inheritdoc/>
    public Task UnregisterNotification(INotificationLike notification, bool cancel = true)
    {
        ArgumentNullException.ThrowIfNull(notification);

        return _core.Loop.Run(() =>
        {
            // another's of the same procedure stays: only what registered takes itself away
            if (!_notifications.TryRemove(new KeyValuePair<ProcedureAddress, INotificationLike>(notification.Procedure.Address, notification)))
            {
                return Task.CompletedTask;
            }

            // the server is told unless it ended it already; either way, what was on its way is
            // dropped in silence
            if (Unbind(notification) is { } call)
            {
                if (cancel)
                {
                    _core.Cancel(call.Address, call.Timeout);
                }
                else
                {
                    _core.Reserve(call.Address, call.Timeout);
                }
            }

            return Task.CompletedTask;
        });
    }

    /// <summary>
    /// Sends a request to the server, on an odd call id, and settles with its result. With
    /// <see cref="RouterRequest.Subscribes"/> — the notification the router holds for the procedure —
    /// the call subscribes it: the request opens a subscription, paced when the notification has a
    /// window, and what comes under its call id triggers the notification.
    /// </summary>
    public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var core = new CoreRequest { ConnectionHandle = ServerConnectionHandle, Procedure = request.Procedure, Options = request.Options, OnSent = request.OnSent };

        if (request.Subscribes is not { } subscribes)
        {
            return _core.Request(payload, core);
        }

        return _core.Loop.Run(() =>
        {
            // only the notification held for the procedure is bound, or its notifications would reach
            // none that is listening
            if (!_notifications.TryGetValue(request.Procedure.Address, out var held) || !ReferenceEquals(held, subscribes))
            {
                return Task.FromException<RouterResult>(new InvalidOperationException(
                    $"{subscribes.Procedure.ProcedureName} is not the notification this router holds for {request.Procedure.ProcedureName}"));
            }

            return Subscribing(payload, (core, subscribes));
        });
    }

    /// <summary>
    /// Follows its transport no more, forgets the session, drops its notifications, rejects what
    /// still waits and cancels the signal of each command it still answers.
    /// </summary>
    public void Dispose()
    {
        Transport.Message -= OnMessage;
        Transport.Close -= OnClose;
        Transport.Reconnect -= OnReconnect;
        _sessionToken = null;
        _core.Post(DropNotifications);
        _core.Dispose();
    }

    // the call that subscribes, bound as its call id is drawn: before the request goes out, so a
    // notification right behind its result is heard; one that did not take is unbound, whatever
    // ended it; once answered, the window of a paced one opens
    private async Task<RouterResult> Subscribing(ReadOnlyMemory<byte> payload, (CoreRequest Request, INotificationLike Subscribes) call)
    {
        var (request, notification) = call;
        uint? bound = null;
        RouterResult result;

        try
        {
            result = await _core.Request(
                payload,
                request with
                {
                    OpensSubscription = true,
                    Paced = notification.Window is not null,
                    OnCallId = (callId) =>
                    {
                        // the call it was bound to before is cancelled, so the server holds it no longer
                        if (Unbind(notification) is { } previous)
                        {
                            _core.Cancel(previous.Address, previous.Timeout);
                        }

                        _subscriptions[callId] = new Bound(
                            callId,
                            notification,
                            notification.Window is { } window ? new Pacing(window) : null,
                            request.Options.Timeout);
                        _callIds[notification] = callId;
                        bound = callId;
                    },
                });
        }
        catch
        {
            if (bound is { } callId && _callIds.TryGetValue(notification, out var held) && held == callId)
            {
                Unbind(notification);
            }

            throw;
        }

        // the server paces nothing before its answer: the window opens once it came, unless the
        // server ended the subscription since
        Renew(_subscriptions.GetValueOrDefault(result.Header.CallId));

        return result;
    }

    // unbinds the call a notification is bound to, and gives it, and how long it was given
    private (CallAddress Address, TimeSpan Timeout)? Unbind(INotificationLike notification)
    {
        if (!_callIds.Remove(notification, out var callId) || !_subscriptions.Remove(callId, out var subscription))
        {
            return null;
        }

        return (new CallAddress(callId, ServerConnectionHandle), subscription.Timeout);
    }

    // a paced subscription credits as far as its window reaches past what settled, once that is half
    // a window past its credit; one unbound meanwhile credits nothing
    private void Renew(Bound? subscription)
    {
        if (subscription?.Pacing is not { } pacing
            || !_subscriptions.TryGetValue(subscription.CallId, out var current)
            || !ReferenceEquals(current, subscription))
        {
            return;
        }

        var creditEnd = pacing.Settled + pacing.Window;

        if (creditEnd - pacing.CreditEnd < pacing.Window / 2.0)
        {
            return;
        }

        pacing.CreditEnd = creditEnd;
        _ = Reporting(_core.Send(
            new Envelope { Header = new CreditHeader { CallId = subscription.CallId, CreditEnd = creditEnd, Paced = true } },
            ServerConnectionHandle));
    }

    private async Task Reporting(Task sending)
    {
        try
        {
            await sending;
        }
        catch (Exception reason)
        {
            Error?.Invoke(reason);
        }
    }

    // a notification's callbacks, run where callbacks run, in the order notifications came; their
    // faults reported, and a paced subscription counting it done, back on the router's scheduler
    private void Trigger(Bound subscription, ReadOnlyMemory<byte> payload)
    {
        Task.Factory
            .StartNew(
                () =>
                {
                    return subscription.Notification.Trigger(payload);
                },
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                _callbacks)
            .Unwrap()
            .ContinueWith(
                (settled) =>
                {
                    var faults = settled.IsCompletedSuccessfully
                        ? settled.Result
                        : [settled.Exception?.InnerException ?? new TaskCanceledException(settled)];

                    foreach (var fault in faults)
                    {
                        Error?.Invoke(fault);
                    }

                    if (subscription.Pacing is { } pacing)
                    {
                        pacing.Settled += 1;
                        Renew(subscription);
                    }
                },
                CancellationToken.None,
                TaskContinuationOptions.DenyChildAttach,
                _core.Loop);
    }

    // the server forgets a connection's subscriptions with it: so does the client, and tells each
    private void DropNotifications()
    {
        var dropped = _notifications.Values.ToList();

        // emptied first, so what a drop registers again is the next connection's
        _notifications.Clear();
        _subscriptions.Clear();
        _callIds.Clear();

        foreach (var notification in dropped)
        {
            try
            {
                notification.Drop(null);
            }
            catch (Exception reason)
            {
                Error?.Invoke(reason);
            }
        }
    }

    private void OnMessage(TransportMessage message)
    {
        if (message.IsText)
        {
            _core.Post(() =>
            {
                Error?.Invoke(FailureException.OfProtocol(ProtocolCode.EnvelopeMalformed, RouterSide.Client, "an envelope is binary, not a string"));
            });

            return;
        }

        _core.Receive(message.Bytes, ServerConnectionHandle);
    }

    // in its turn, behind what the connection delivered before it closed
    private void OnClose(bool wasClean, bool wasQuick)
    {
        Forget("the connection closed before the answer");
    }

    // a connection replaced tells no close, but nothing sent on it will be answered either
    private void OnReconnect()
    {
        Forget("the connection was replaced before the answer");
    }

    // what a connection gone takes with it, in its turn: the session, what waits, the notifications
    private void Forget(string reason)
    {
        _core.Post(() =>
        {
            _sessionToken = null;
        });
        _core.RejectPending(reason);
        _core.Post(DropNotifications);
    }

    // a notification bound to the call that subscribed it, how long that call was given, and its
    // pacing when it asked for one
    private sealed record Bound(uint CallId, INotificationLike Notification, Pacing? Pacing, TimeSpan Timeout);

    // a paced subscription, as its client counts it: the notifications credited, those whose
    // callbacks settled, and how many may be under way
    private sealed class Pacing(int window)
    {
        public long CreditEnd { get; set; } = 1;

        public long Settled { get; set; }

        public int Window { get; } = window;
    }

    // what sets the client's side apart, for its core
    private sealed class Port(RouterClient client) : IRouterCorePort
    {
        public RouterSide Side
        {
            get
            {
                return RouterSide.Client;
            }
        }

        public bool TakesNotifications
        {
            get
            {
                return true;
            }
        }

        public void Activity(RouterActivity activity, string connectionHandle)
        {
            client.Activity?.Invoke(activity);
        }

        public bool IsCallIdInUse(uint callId, string connectionHandle)
        {
            return client._subscriptions.ContainsKey(callId);
        }

        // a notification under no subscription is reported; its callbacks hear one that is
        public void OnNotification(NotificationHeader header, (string ConnectionHandle, ReadOnlyMemory<byte> Payload) notification)
        {
            if (!client._subscriptions.TryGetValue(header.CallId, out var subscription))
            {
                client.Error?.Invoke(new FailureException(
                    Failure.OfProtocol(ProtocolCode.SubscriptionUnknown, $"no subscription under call {header.CallId}"),
                    new FailureException.Raised(FailureOrigin.Local, RouterSide.Client))
                {
                    Header = header,
                });

                return;
            }

            client.Trigger(subscription, notification.Payload);
            client.Activity?.Invoke(RouterActivity.Notification);
        }

        // a failure after its result ends a subscription the server ended: the notification is
        // dropped here too, and told, so the next registration asks anew
        public bool OnUnpairedFailure(Envelope envelope, string connectionHandle)
        {
            if (!client._subscriptions.TryGetValue(envelope.Header.CallId, out var subscription))
            {
                return false;
            }

            var notification = subscription.Notification;
            var call = client.Unbind(notification);

            client._notifications.TryRemove(new KeyValuePair<ProcedureAddress, INotificationLike>(notification.Procedure.Address, notification));

            // the server ended it: nothing is left there to cancel, and what was on its way is
            // dropped in silence
            if (call is { } ended)
            {
                client._core.Reserve(ended.Address, ended.Timeout);
            }

            try
            {
                notification.Drop(envelope.Failure);
            }
            catch (Exception reason)
            {
                client.Error?.Invoke(reason);
            }

            return true;
        }

        // the session is the server's to give: an answer announces it when it changes, and carries
        // none otherwise. Only a result or a failure comes here
        public void OnAnswerReceived(IEnvelopeHeader header, string connectionHandle)
        {
            var session = header is ResultHeader result ? result.Session : ((FailureHeader)header).Session;

            if (session is { } announced)
            {
                client._sessionToken = announced.Token is { } token ? token : null;
            }
        }

        public void Report(Exception reason, string connectionHandle)
        {
            client.Error?.Invoke(reason);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return client.Transport.Send(bytes);
        }

        public void Trace(DebugDirection direction, TracedEnvelope envelope)
        {
            client.Debug?.Invoke(direction, envelope);
        }
    }
}
