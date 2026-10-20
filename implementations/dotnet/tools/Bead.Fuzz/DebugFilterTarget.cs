using System.Text;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes as a <c>debug</c> filter's spec (spec/debugging.md, section 6) and a procedure's name,
/// parted by the first NUL, each read as UTF-8, a byte no sequence takes as U+FFFD and a leading
/// U+FEFF kept; without a NUL, the name is <c>getStatus</c>. The parse returns, or refuses with an
/// <see cref="ArgumentException"/>; a filter it returns makes both listeners, and the call's one is
/// asked of the name at each direction and type, its patterns matched whole. The TypeScript side's
/// <c>tools/fuzz/debug-filter.ts</c> is its twin.
/// </summary>
internal sealed class DebugFilterTarget : IFuzzTarget
{
    private const string ProcedureName = "getStatus";

    private static readonly DebugDirection[] Directions = [DebugDirection.Rx, DebugDirection.Tx];
    private static readonly DebugType[] Types = [DebugType.Request, DebugType.Command, DebugType.Notification];

    // listeners the fuzzer asks nothing of
    private static readonly Action<Exception?, DebugEvent> Unheard = (_, _) =>
    {
    };

    private static readonly Action<DebugDirection, TracedEnvelope> UnheardEnvelope = (_, _) =>
    {
    };

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "debug-filter";
        }
    }

    // helpers

    private static DebugEvent EventOf(string procedureName, (DebugDirection Direction, DebugType Type) step)
    {
        return new DebugEvent
        {
            Direction = step.Direction,
            ProcedureId = 1,
            ProcedureName = procedureName,
            ServiceId = 2,
            ServiceRevision = 1,
            StartedAt = DateTimeOffset.UnixEpoch,
            Type = step.Type,
        };
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        var at = data.IndexOf((byte)0);
        var spec = Encoding.UTF8.GetString(at < 0 ? data : data[..at]);
        var name = at < 0 ? ProcedureName : Encoding.UTF8.GetString(data[(at + 1)..]);
        DebugFilter filter;

        try
        {
            filter = DebugFilter.Parse(spec);
        }
        catch (ArgumentException)
        {
            // a refusal is the answer to a spec the grammar does not take
            return;
        }

        var listener = DebugFilters.FilterDebug(Unheard, filter);

        DebugFilters.FilterEnvelopeDebug(UnheardEnvelope, filter);

        foreach (var direction in Directions)
        {
            foreach (var type in Types)
            {
                listener(null, EventOf(name, (direction, type)));
            }
        }
    }
}
