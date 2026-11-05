namespace Bead;

/// <summary>
/// What a transport holds of one connection its router paused (spec 15.12, decision 0046): what it
/// received meanwhile, in order, handed on once resumed. A message is handed at once while the hold
/// is neither paused, nor holding anything, nor releasing; held behind what it holds otherwise, so
/// nothing overtakes what is held. Its release runs from a later step of its transport's own, which
/// <see cref="Resume"/> asks for, and takes each message after asking whether it was paused again.
/// What a transport whose peer is its application's own code holds is bounded by nothing: that code
/// is its sender. Touched from any thread, under its lock, which it holds while it calls nothing.
/// </summary>
internal sealed class TransportHold<T>
{
    private readonly Lock _gate = new();
    private readonly Queue<T> _held = new();
    private bool _isPaused;

    // a release asked for and not over, which what comes meanwhile waits for, behind what is held
    private bool _isReleasing;

    // what waits for it to open: neither paused, nor holding, nor releasing
    private TaskCompletionSource? _opened;

    /// <summary>Whether its router paused it.</summary>
    public bool IsPaused
    {
        get
        {
            lock (_gate)
            {
                return _isPaused;
            }
        }
    }

    /// <summary>The messages it holds.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _held.Count;
            }
        }
    }

    /// <summary>
    /// A message received: true when it is to be handed on at once; false when it was held, the
    /// hold paused, holding or releasing.
    /// </summary>
    public bool Offer(T message)
    {
        lock (_gate)
        {
            if (_isPaused || _held.Count > 0 || _isReleasing)
            {
                _held.Enqueue(message);

                return false;
            }

            return true;
        }
    }

    /// <summary>Holds what comes from now on. Idempotent; it hands nothing.</summary>
    public void Pause()
    {
        lock (_gate)
        {
            _isPaused = true;
        }
    }

    /// <summary>
    /// Paused no more: true when its transport is to run a release from a later step of its own,
    /// <see cref="TryTake"/> until it gives nothing; false when nothing is held, or a release is
    /// under way already. Idempotent; it hands nothing.
    /// </summary>
    public bool Resume()
    {
        lock (_gate)
        {
            _isPaused = false;

            if (_isReleasing || _held.Count == 0)
            {
                Opened();

                return false;
            }

            _isReleasing = true;

            return true;
        }
    }

    /// <summary>
    /// Within a release: the next message held, while it is not paused again; or none, the release
    /// over, what it still holds left to the next resume.
    /// </summary>
    public bool TryTake(out T message)
    {
        lock (_gate)
        {
            // ! taken before it is handed, so a hand that pauses it, or drops it, leaves nothing
            // behind it
            if (!_isPaused && _held.TryDequeue(out message!))
            {
                return true;
            }

            _isReleasing = false;
            message = default!;
            Opened();

            return false;
        }
    }

    /// <summary>Lets go of what it holds, its connection gone, and gives it, in order. A pause outlasts it, until a resume.</summary>
    public List<T> Drop()
    {
        lock (_gate)
        {
            var dropped = _held.ToList();

            _held.Clear();
            Opened();

            return dropped;
        }
    }

    /// <summary>Settles once it is neither paused, nor holding, nor releasing.</summary>
    public Task WhenOpen()
    {
        lock (_gate)
        {
            if (IsOpen())
            {
                return Task.CompletedTask;
            }

            _opened ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            return _opened.Task;
        }
    }

    // under the lock
    private bool IsOpen()
    {
        return !_isPaused && _held.Count == 0 && !_isReleasing;
    }

    // under the lock: what waits for it to open goes on, from a later step of its own
    private void Opened()
    {
        if (IsOpen() && _opened is { } opened)
        {
            _opened = null;
            opened.TrySetResult();
        }
    }
}
