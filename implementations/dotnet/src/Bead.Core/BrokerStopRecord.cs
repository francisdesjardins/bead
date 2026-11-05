namespace Bead;

/// <summary>
/// One stop of a broker's participant (spec 15.21): its mark, set as the stop is called, and its two
/// signals, cancelled right after it, its adapter's start under way giving up at the first and each
/// reconnection, its own or a client's, and each connect awaiting its link or its answer ending at
/// the second. Each operation captures the record current at its call and reads that one alone,
/// never its participant's current one, so that what a stop ended is told as that stop's, though a
/// start follows it at once; its participant renews it as its stop settles, never at the next start.
/// </summary>
internal sealed class BrokerStopRecord : IDisposable
{
    // ! never disposed while an operation may hold it: its tokens read once, as it is made, since a
    // disposed source's Token throws
    private readonly CancellationTokenSource _starting = new();
    private readonly CancellationTokenSource _ending = new();
    private volatile bool _isMarked;

    public BrokerStopRecord()
    {
        Starting = _starting.Token;
        Ending = _ending.Token;
    }

    /// <summary>Whether its stop came.</summary>
    public bool IsMarked
    {
        get
        {
            return _isMarked;
        }
    }

    /// <summary>What its adapter's start under way gives up on (spec 15.21).</summary>
    public CancellationToken Starting { get; }

    /// <summary>What a reconnection, its participant's own or a client's, and a connect awaiting its link or its answer end at (spec 15.15, 15.21).</summary>
    public CancellationToken Ending { get; }

    /// <summary>Marks its stop come: every read of it from now on says so.</summary>
    public void Mark()
    {
        _isMarked = true;
    }

    /// <summary>Cancels its two signals, its adapter's start's first; once marked, outside any gate, so no callback runs under one.</summary>
    public async Task Cancel()
    {
        await _starting.CancelAsync();
        await _ending.CancelAsync();
    }

    /// <summary>What its stop is carried as, inside the cancel it makes: the stop of the participant <paramref name="id"/>.</summary>
    public static IOException CauseOf(string id)
    {
        return new IOException($"the participant {id} stopped");
    }

    public void Dispose()
    {
        _starting.Dispose();
        _ending.Dispose();
    }
}
