namespace Bead;

/// <summary>
/// The shared half of a transport server's life, whatever the transport, as the TypeScript side's
/// <c>createTransportServer</c> keeps it for each: its ready state, and the guards around its start
/// and its stop. What starting and stopping do is the transport's own.
/// </summary>
internal sealed class TransportServerLife
{
    // what a start and a stop decide by: the state, and the stop under way
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    private Task? _stopping;
    // its dispose, which every later one shares: a start after it is refused
    private Task? _disposed;

    /// <summary>Where it is in its life: Uninitialized until its first start.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _readyState;
        }
    }

    /// <summary>Whether a stop began, or ended: what comes now is taken by no connection.</summary>
    public bool IsStopping
    {
        get
        {
            return _readyState is ReadyState.Closing or ReadyState.Closed;
        }
    }

    /// <summary>Whether it was disposed: a start since is its application's misuse.</summary>
    public bool IsDisposed
    {
        get
        {
            lock (_gate)
            {
                return _disposed is not null;
            }
        }
    }

    /// <summary>
    /// Starts, as <paramref name="starting"/> does, and gives where it listens. Refused with an
    /// <see cref="ObjectDisposedException"/> once disposed, its state kept, before anything else
    /// (decision 0003); then with an <see cref="InvalidOperationException"/> unless Uninitialized or
    /// Closed — a second start even while the first is under way; one that fails ends Closed, ready
    /// to start again.
    /// </summary>
    public async Task<TransportServerAddress> Start(Func<Task<TransportServerAddress>> starting)
    {
        lock (_gate)
        {
            if (_disposed is not null)
            {
                throw Disposed();
            }

            if (_readyState is not (ReadyState.Uninitialized or ReadyState.Closed))
            {
                throw new InvalidOperationException($"the transport server is already {NameOf(_readyState)}");
            }

            _readyState = ReadyState.Connecting;
        }

        TransportServerAddress bound;

        try
        {
            bound = await starting();
        }
        catch
        {
            _readyState = ReadyState.Closed;

            throw;
        }

        _readyState = ReadyState.Open;

        return bound;
    }

    /// <summary>
    /// Stops, as <paramref name="stopping"/> does; it ends Closed, even when that throws. It settles
    /// at once when Uninitialized or Closed; a second stop, or one from a listener of what the stop
    /// causes, shares the stop under way; one while starting is an
    /// <see cref="InvalidOperationException"/>.
    /// </summary>
    public Task Stop(Func<Task> stopping)
    {
        lock (_gate)
        {
            if (_readyState is ReadyState.Uninitialized or ReadyState.Closed)
            {
                return Task.CompletedTask;
            }

            if (_stopping is { } shared)
            {
                return shared;
            }

            if (_readyState == ReadyState.Connecting)
            {
                return Task.FromException(new InvalidOperationException("the transport server is starting"));
            }

            _readyState = ReadyState.Closing;
            _stopping = Stopping(stopping);

            return _stopping;
        }
    }

    /// <summary>
    /// Stops it, as <see cref="Stop"/> does with <paramref name="stopping"/>, then ends it for good:
    /// a start after it is its application's misuse (decision 0003). A later dispose settles with
    /// the first.
    /// </summary>
    public Task Dispose(Func<Task> stopping)
    {
        var disposing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        lock (_gate)
        {
            if (_disposed is { } shared)
            {
                return shared;
            }

            _disposed = disposing.Task;
        }

        _ = Disposing((disposing, stopping));

        return disposing.Task;
    }

    /// <summary>What a start after its dispose is refused with: its application's misuse.</summary>
    public static ObjectDisposedException Disposed()
    {
        return new ObjectDisposedException(null, "the transport server is disposed");
    }

    // its dispose's body, outside its gate: its stop, its end settled whatever the stop did
    private async Task Disposing((TaskCompletionSource Disposed, Func<Task> Stopping) dispose)
    {
        try
        {
            await Stop(dispose.Stopping);
            dispose.Disposed.SetResult();
        }
        catch (Exception reason)
        {
            dispose.Disposed.SetException(reason);
        }
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // yields first, as the TypeScript side's stop starts from a settled promise: the stop is shared
    // before any close it causes is raised, and what throws in it is its fault, not its caller's
    private async Task Stopping(Func<Task> stopping)
    {
        await Task.Yield();

        try
        {
            await stopping();
        }
        finally
        {
            lock (_gate)
            {
                _readyState = ReadyState.Closed;
                _stopping = null;
            }
        }
    }
}
