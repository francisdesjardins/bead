namespace Bead;

/// <summary>
/// One task at a time, in the order they came, on the thread pool: what JavaScript's one thread
/// gives Bead's TypeScript router. A router's state is touched from its scheduler alone, and a task
/// that awaits on it comes back to it, so what that router does in one turn happens here without
/// another task between.
/// Resolvers run on the thread pool, never here: one that blocks its thread stalls no router.
/// </summary>
internal sealed class SerialScheduler : TaskScheduler
{
    // the scheduler the current thread is running a task of, if any
    [ThreadStatic]
    private static SerialScheduler? _running;

    private readonly Lock _gate = new();
    private readonly Queue<Task> _queue = new();
    private readonly List<TaskCompletionSource> _idleWaiters = [];
    private bool _isDraining;

    /// <summary>What hears a task posted that threw: none of the router's should.</summary>
    public Action<Exception>? OnUnhandled { get; set; }

    /// <summary>Whether the current thread runs a task of this scheduler right now.</summary>
    public bool IsCurrent
    {
        get
        {
            return ReferenceEquals(_running, this);
        }
    }

    /// <inheritdoc/>
    public override int MaximumConcurrencyLevel
    {
        get
        {
            return 1;
        }
    }

    /// <summary>Runs <paramref name="action"/> on the scheduler, after what came before it.</summary>
    public void Post(Action action)
    {
        Task.Factory.StartNew(
            () =>
            {
                try
                {
                    action();
                }
                catch (Exception exception) when (OnUnhandled is not null)
                {
                    OnUnhandled(exception);
                }
            },
            CancellationToken.None,
            TaskCreationOptions.DenyChildAttach,
            this);
    }

    /// <summary>
    /// Runs <paramref name="function"/> on the scheduler — at once when already on it — and every
    /// continuation of its own after it.
    /// </summary>
    public Task<T> Run<T>(Func<Task<T>> function)
    {
        if (IsCurrent)
        {
            return function();
        }

        return Task.Factory
            .StartNew(function, CancellationToken.None, TaskCreationOptions.DenyChildAttach, this)
            .Unwrap();
    }

    /// <summary>As <see cref="Run{T}(Func{Task{T}})"/>, for a task that gives nothing.</summary>
    public Task Run(Func<Task> function)
    {
        if (IsCurrent)
        {
            return function();
        }

        return Task.Factory
            .StartNew(function, CancellationToken.None, TaskCreationOptions.DenyChildAttach, this)
            .Unwrap();
    }

    /// <summary>Settles once nothing is queued and nothing runs.</summary>
    public Task WhenIdle()
    {
        lock (_gate)
        {
            if (!_isDraining && _queue.Count == 0)
            {
                return Task.CompletedTask;
            }

            var waiter = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            _idleWaiters.Add(waiter);

            return waiter.Task;
        }
    }

    /// <inheritdoc/>
    protected override void QueueTask(Task task)
    {
        lock (_gate)
        {
            _queue.Enqueue(task);

            if (_isDraining)
            {
                return;
            }

            _isDraining = true;
        }

        ThreadPool.UnsafeQueueUserWorkItem(
            (scheduler) =>
            {
                scheduler.Drain();
            },
            this,
            preferLocal: false);
    }

    /// <inheritdoc/>
    protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued)
    {
        // inline only what was never queued, on the thread draining this scheduler
        return !taskWasPreviouslyQueued && IsCurrent && TryExecuteTask(task);
    }

    /// <inheritdoc/>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage(Justification = "a debugger's alone, which lists what is queued")]
    protected override IEnumerable<Task> GetScheduledTasks()
    {
        lock (_gate)
        {
            return [.. _queue];
        }
    }

    private void Drain()
    {
        var previous = _running;

        _running = this;

        try
        {
            while (true)
            {
                Task? task;
                TaskCompletionSource[] idle = [];

                lock (_gate)
                {
                    if (!_queue.TryDequeue(out task))
                    {
                        _isDraining = false;
                        idle = [.. _idleWaiters];
                        _idleWaiters.Clear();
                    }
                }

                if (task is null)
                {
                    foreach (var waiter in idle)
                    {
                        waiter.TrySetResult();
                    }

                    return;
                }

                TryExecuteTask(task);
            }
        }
        finally
        {
            _running = previous;
        }
    }
}
