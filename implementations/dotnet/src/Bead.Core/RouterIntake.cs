namespace Bead;

/// <summary>
/// What one router's transport handed it that no turn took yet, per connection, and the connections
/// it paused for it (spec 15.12, decision 0046): each envelope counted as it is handed, and released
/// once the turn that took it returned or threw. The envelope that reaches a bound is taken; past it
/// the connection is paused, and resumed once both its counts are at half their bound or below, as a
/// pipe's writer pauses at one threshold and resumes at another. What the router does of its own
/// never meets the count. Touched from any thread, under its lock.
/// </summary>
internal sealed class RouterIntake(IntakeLimits limits)
{
    private readonly IntakeLimits _limits = limits.Validate();
    private readonly Lock _gate = new();

    // by connection, in the order each was first counted, so an end resumes them in that order
    private readonly OrderedDictionary<string, Untaken> _untaken = new(StringComparer.Ordinal);
    private bool _isEnded;

    /// <summary>The connections it holds paused, in the order each was first counted.</summary>
    public IReadOnlyList<string> Paused
    {
        get
        {
            lock (_gate)
            {
                return [.. _untaken.Where((entry) =>
                {
                    return entry.Value.IsPaused;
                }).Select((entry) =>
                {
                    return entry.Key;
                })];
            }
        }
    }

    /// <summary>
    /// An envelope of <c>Bytes</c> its transport handed on <c>ConnectionHandle</c>: counted, and the
    /// connection paused by <paramref name="pause"/> once either count reaches its bound, the
    /// envelope that reached it taken all the same. False once it ended, nothing counted.
    /// </summary>
    public bool Handed((string ConnectionHandle, long Bytes) handed, Action<string> pause)
    {
        var (connectionHandle, bytes) = handed;

        lock (_gate)
        {
            if (_isEnded)
            {
                return false;
            }

            if (!_untaken.TryGetValue(connectionHandle, out var untaken))
            {
                untaken = new Untaken();
                _untaken.Add(connectionHandle, untaken);
            }

            untaken.Envelopes += 1;
            untaken.Bytes += bytes;

            var isReached = untaken.Envelopes >= _limits.MaximumUntakenEnvelopes || untaken.Bytes >= _limits.MaximumUntakenBytes;

            if (isReached && !untaken.IsPaused)
            {
                untaken.IsPaused = true;

                // ! called under the lock that guards the counts, so a pause from a reader's thread
                // and a resume from the router's turn reach the transport in the order they were
                // decided: a transport's pair takes no lock it holds while it tells a listener, and
                // tells none
                pause(connectionHandle);
            }

            return true;
        }
    }

    /// <summary>
    /// The envelope of <c>Bytes</c> handed on <c>ConnectionHandle</c> taken: released, and the
    /// connection resumed by <paramref name="resume"/> once both counts are at half their bound or
    /// below. Nothing once it ended, or for a connection forgotten.
    /// </summary>
    public void Taken((string ConnectionHandle, long Bytes) taken, Action<string> resume)
    {
        var (connectionHandle, bytes) = taken;

        lock (_gate)
        {
            if (_isEnded || !_untaken.TryGetValue(connectionHandle, out var untaken))
            {
                return;
            }

            untaken.Envelopes = Math.Max(0, untaken.Envelopes - 1);
            untaken.Bytes = Math.Max(0, untaken.Bytes - bytes);

            // both counts at half their bound or below: with a bound of 1, half is 0
            var isLow = untaken.Envelopes <= _limits.MaximumUntakenEnvelopes / 2 && untaken.Bytes <= _limits.MaximumUntakenBytes / 2;

            if (untaken.IsPaused && isLow)
            {
                untaken.IsPaused = false;

                // ! under the lock, as Handed pauses: see there
                resume(connectionHandle);
            }

            if (untaken.Envelopes == 0 && !untaken.IsPaused)
            {
                _untaken.Remove(connectionHandle);
            }
        }
    }

    /// <summary>Forgets what it counted of a connection closed: its transport resumes nothing of it.</summary>
    public void Forget(string connectionHandle)
    {
        lock (_gate)
        {
            _untaken.Remove(connectionHandle);
        }
    }

    /// <summary>
    /// Ends, its router disposed: each connection it paused resumed by <paramref name="resume"/>, in
    /// the order each was first counted, under the lock, and nothing counted from now on, so no
    /// pause comes after.
    /// </summary>
    public void End(Action<string> resume)
    {
        lock (_gate)
        {
            if (_isEnded)
            {
                return;
            }

            _isEnded = true;

            foreach (var (connectionHandle, untaken) in _untaken)
            {
                if (untaken.IsPaused)
                {
                    // ! under the lock, as Handed pauses: see there
                    resume(connectionHandle);
                }
            }

            _untaken.Clear();
        }
    }

    // one connection's untaken envelopes, their bytes, and whether its transport is paused
    private sealed class Untaken
    {
        public long Envelopes { get; set; }

        public long Bytes { get; set; }

        public bool IsPaused { get; set; }
    }
}
