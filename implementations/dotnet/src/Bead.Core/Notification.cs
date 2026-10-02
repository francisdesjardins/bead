namespace Bead;

/// <summary>
/// What a router keeps of a notification: which procedure it is, how to trigger it, and how to drop
/// it. A registration is one callback; a notification is one per procedure and per side; a
/// subscription is the call left open, named by its call id at both ends.
/// </summary>
public interface INotificationLike
{
    /// <summary>The procedure that notifies.</summary>
    Procedure Procedure { get; }

    /// <summary>
    /// The notifications its subscription lets come while their callbacks have not all settled:
    /// asked for, the subscription is paced. None, each comes as it is sent.
    /// </summary>
    int? Window { get; }

    /// <summary>
    /// Calls every callback with a notification, still encoded, and settles as every one did, with
    /// the faults of those that failed. Throws what a callback threw before it returned, and a
    /// notification that does not decode.
    /// </summary>
    Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload);

    /// <summary>
    /// What the router calls once it dropped the notification: with its connection, or with the
    /// failure the other end ended it with. Nothing more reaches the callbacks, and the next
    /// registration asks anew.
    /// </summary>
    void Drop(Failure? failure);
}

/// <summary>How the side that subscribes writes its request and reads its answer and its notifications.</summary>
/// <typeparam name="TRequest">What the subscribing request carries.</typeparam>
/// <typeparam name="TResponse">What its result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public interface INotificationSerializerClient<TRequest, TResponse, TNotification> : IRequestSerializerClient<TRequest, TResponse>
{
    /// <summary>A notification's payload, decoded.</summary>
    TNotification DecodeNotification(ReadOnlyMemory<byte> notification);
}

/// <summary>What a notification needs: how its payloads are written, its window, and how it unsubscribes.</summary>
/// <typeparam name="TRequest">What the subscribing request carries.</typeparam>
/// <typeparam name="TResponse">What its result carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public sealed record NotificationDependencies<TRequest, TResponse, TNotification>
{
    /// <summary>How its payloads are written and read.</summary>
    public required INotificationSerializerClient<TRequest, TResponse, TNotification> Serializer { get; init; }

    /// <summary>
    /// Asks for the subscription paced: at most this many notifications come while their callbacks
    /// have not all settled, above 0. None, each comes as it is sent.
    /// </summary>
    public int? Window { get; init; }

    /// <summary>
    /// Tells the other end to stop notifying, given the call id of the subscription and the answer
    /// that made it. Without it, or when it fails, the router cancels the call that subscribed.
    /// </summary>
    public Func<uint, TResponse, Task>? Unsubscribe { get; init; }
}

/// <summary>One callback registered: what takes it away.</summary>
public interface INotificationRegistration : IAsyncDisposable
{
    /// <summary>
    /// Takes the callback away; the last one taken away stops the notification, at the other end
    /// first. Twice, or once the notification was dropped, it does nothing.
    /// </summary>
    Task Unregister();
}

/// <summary>A registration, its payload and callback given: its options, when any, then the registration.</summary>
public delegate Task<INotificationRegistration> Registrar(RequestOptions? options = null);

/// <summary>
/// One procedure's notification, as a service manager makes it: callbacks register on it, one request
/// going out however many register at once.
/// </summary>
/// <typeparam name="TRequest">What the subscribing request carries.</typeparam>
/// <typeparam name="TNotification">What a notification carries.</typeparam>
public interface INotification<TRequest, TNotification> : INotificationLike
{
    /// <summary>
    /// Registers <paramref name="callback"/>, given the payload of the request that subscribes; the
    /// first registration subscribes, those meanwhile wait on it. A connection that closes before it
    /// subscribed, or drops it meanwhile, is a <see cref="DisconnectException"/>.
    /// </summary>
    Registrar Register(TRequest payload, Func<TNotification, Task> callback);
}

/// <summary>
/// One procedure's notification: its callbacks, its one subscribing request, and its state, each
/// field answering one question — is its request in flight, is its last callback leaving, which call
/// subscribed, how many times it was dropped — guarded by one lock, since callbacks register from
/// any thread.
/// </summary>
internal sealed class Notification<TRequest, TResponse, TNotification> : INotification<TRequest, TNotification>
{
    private readonly Lock _gate = new();
    private readonly IRouterLike _router;
    private readonly NotificationDependencies<TRequest, TResponse, TNotification> _dependencies;
    private readonly Func<TRequest, (RequestOptions? Options, INotificationLike Subscribes), Task<(uint CallId, TResponse Response)>> _subscribe;
    private readonly Action<Failure?> _onDropped;
    private readonly Action<Exception?, object?> _trace;
    private readonly List<Func<TNotification, Task>> _callbacks = [];
    private Task? _registering;
    private Task? _unregistering;
    private (uint CallId, TResponse Response)? _subscription;
    private int _generation;

    public Notification(
        Procedure procedure,
        (IRouterLike Router, NotificationDependencies<TRequest, TResponse, TNotification> Dependencies) made,
        (Func<TRequest, (RequestOptions? Options, INotificationLike Subscribes), Task<(uint CallId, TResponse Response)>> Subscribe, Action<Failure?> OnDropped, Action<Exception?, object?> Trace) calls)
    {
        if (made.Dependencies.Window is < 1)
        {
            throw new ArgumentException($"a window is a whole number above 0, not {made.Dependencies.Window}", nameof(made));
        }

        Procedure = procedure;
        (_router, _dependencies) = made;
        (_subscribe, _onDropped, _trace) = calls;
    }

    public Procedure Procedure { get; }

    public int? Window
    {
        get
        {
            return _dependencies.Window;
        }
    }

    public Registrar Register(TRequest payload, Func<TNotification, Task> callback)
    {
        ArgumentNullException.ThrowIfNull(callback);

        return (options) =>
        {
            return Registering(payload, (callback, options));
        };
    }

    public async Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload)
    {
        if (!_router.HasNotification(this))
        {
            throw new InvalidOperationException($"{Procedure.ProcedureName} should not have been triggered");
        }

        TNotification notification;

        // a notification that does not decode fails here, for the router to report
        try
        {
            notification = _dependencies.Serializer.DecodeNotification(payload);
        }
        catch (Exception reason)
        {
            var undecodable = new FailureException(
                Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message),
                (new FailureException.Raised(FailureOrigin.Local, _router.Side), reason))
            {
                ProcedureAddress = Procedure.Address,
            };

            _trace(undecodable, null);

            throw undecodable;
        }

        _trace(null, notification);

        List<Func<TNotification, Task>> callbacks;

        lock (_gate)
        {
            callbacks = [.. _callbacks];
        }

        // each callback in turn: one that throws before it returns stops the ones after it
        var returned = callbacks.Select((callback) =>
        {
            return callback(notification);
        }).ToList();
        var faults = new List<Exception>();

        foreach (var settling in returned)
        {
            try
            {
                await settling;
            }
            catch (Exception reason)
            {
                faults.Add(reason);
            }
        }

        return faults;
    }

    public void Drop(Failure? failure)
    {
        // the other end forgot the subscription: the callbacks hear nothing more, their
        // registrations have nothing left to take away, and the next asks anew
        lock (_gate)
        {
            _generation += 1;
            _subscription = null;
            _callbacks.Clear();
        }

        _onDropped(failure);
    }

    private async Task<INotificationRegistration> Registering(TRequest payload, (Func<TNotification, Task> Callback, RequestOptions? Options) registration)
    {
        var (callback, options) = registration;
        int own;

        // listening first, so a notification the registration lets through is not lost
        lock (_gate)
        {
            own = _generation;
            _callbacks.Add(callback);
        }

        try
        {
            Task? unregistering;

            lock (_gate)
            {
                unregistering = _unregistering;
            }

            // what leaving says is the leaver's to hear: a registration only waits for it
            if (unregistering is not null)
            {
                await Quietly(unregistering);
            }

            TaskCompletionSource? subscribing = null;
            Task registering;

            // decided and marked at once, so two registering together send one request; a
            // registration in flight is waited on even when the router already holds it
            lock (_gate)
            {
                if (_registering is not { IsCompleted: false } && !_router.HasNotification(this))
                {
                    subscribing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    _registering = subscribing.Task;
                }

                registering = _registering is { IsCompleted: false } inFlight ? inFlight : Task.CompletedTask;
            }

            if (subscribing is not null)
            {
                await Settle(Subscribing(payload, options), subscribing);
            }

            await registering;

            // dropped with its connection meanwhile: nothing is left to listen to
            lock (_gate)
            {
                if (own != _generation)
                {
                    throw new DisconnectException($"{Procedure.ProcedureName} was dropped with its connection");
                }
            }
        }
        catch
        {
            lock (_gate)
            {
                _callbacks.Remove(callback);
            }

            throw;
        }

        return new Registration(this, (callback, own));
    }

    // the one request that subscribes, held by the router before it is asked for, so a notification
    // sent right behind the answer is heard
    private async Task Subscribing(TRequest payload, RequestOptions? options)
    {
        try
        {
            await _router.RegisterNotification(this);

            var subscription = await _subscribe(payload, (options, this));

            lock (_gate)
            {
                _subscription = subscription;
            }
        }
        catch
        {
            // a router may hold it when what follows fails, as a subscription can
            if (_router.HasNotification(this))
            {
                await Quietly(_router.UnregisterNotification(this, true));
            }

            throw;
        }
    }

    // a gate opened as its work settles, whichever way: the work's failure is the gate's
    private static async Task Settle(Task work, TaskCompletionSource gate)
    {
        try
        {
            await work;
            gate.TrySetResult();
        }
        catch (Exception reason)
        {
            gate.TrySetException(reason);
        }
    }

    // the last callback out stops the notification: at the other end first, when it can be told, so
    // none comes for it after, then in the router
    private async Task Leave()
    {
        (uint CallId, TResponse Response)? left;
        var isAcknowledged = false;

        lock (_gate)
        {
            left = _subscription;
            _subscription = null;
        }

        try
        {
            if (_dependencies.Unsubscribe is { } unsubscribe && left is { } subscription)
            {
                await unsubscribe(subscription.CallId, subscription.Response);
                isAcknowledged = true;
            }
        }
        finally
        {
            await Quietly(_router.UnregisterNotification(this, !isAcknowledged));
        }
    }

    private static async Task Quietly(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception)
        {
            // what it says is the caller's to hear by another way
        }
    }

    // one callback registered, of one generation
    private sealed class Registration(Notification<TRequest, TResponse, TNotification> notification, (Func<TNotification, Task> Callback, int Generation) own)
        : INotificationRegistration
    {
        private bool _isRegistered = true;

        public async Task Unregister()
        {
            TaskCompletionSource? leaving = null;

            lock (notification._gate)
            {
                // taken away already, or dropped with its connection
                if (!_isRegistered || own.Generation != notification._generation)
                {
                    return;
                }

                _isRegistered = false;
                notification._callbacks.Remove(own.Callback);

                // the last out marks the notification leaving, for a registration meanwhile to wait on
                if (notification._callbacks.Count == 0)
                {
                    leaving = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    notification._unregistering = leaving.Task;
                }
            }

            if (leaving is not null)
            {
                await Settle(notification.Leave(), leaving);
                await leaving.Task;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await Unregister();
        }
    }
}
