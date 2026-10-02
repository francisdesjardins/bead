using System.Collections.Frozen;

namespace Bead;

/// <summary>
/// What a part holds right now: each count by its name, the ceiling some have, the connections it
/// keeps anything for, and what it found that should never be. Its names are the TypeScript side's,
/// so a health check reads alike from either.
/// </summary>
public sealed record Gauges
{
    /// <summary>Gauges that count nothing.</summary>
    public static Gauges Empty { get; } = new();

    /// <summary>What it found that should never be, in sentences that name no connection.</summary>
    public IReadOnlyList<string> Anomalies { get; init; } = [];

    /// <summary>The ceiling of each count that has one.</summary>
    public IReadOnlyDictionary<string, long> Ceilings { get; init; } = FrozenDictionary<string, long>.Empty;

    /// <summary>The connections it keeps anything for: never to leave the process.</summary>
    public IReadOnlySet<string> ConnectionHandles { get; init; } = FrozenSet<string>.Empty;

    /// <summary>Each count, by its name.</summary>
    public IReadOnlyDictionary<string, long> Counts { get; init; } = FrozenDictionary<string, long>.Empty;

    /// <summary>
    /// What several parts hold, as one: their counts and ceilings side by side, the connections any
    /// of them keeps anything for, and all they found that should never be. A count two parts name
    /// is an <see cref="ArgumentException"/>.
    /// </summary>
    public static Gauges Merge(IEnumerable<Gauges> parts)
    {
        ArgumentNullException.ThrowIfNull(parts);

        var counts = new Dictionary<string, long>();
        var ceilings = new Dictionary<string, long>();
        var connectionHandles = new HashSet<string>();
        var anomalies = new List<string>();

        foreach (var part in parts)
        {
            foreach (var (name, count) in part.Counts)
            {
                if (!counts.TryAdd(name, count))
                {
                    throw new ArgumentException($"two parts count {name}", nameof(parts));
                }
            }

            foreach (var (name, ceiling) in part.Ceilings)
            {
                ceilings[name] = ceiling;
            }

            connectionHandles.UnionWith(part.ConnectionHandles);
            anomalies.AddRange(part.Anomalies);
        }

        return new Gauges
        {
            Anomalies = anomalies,
            Ceilings = ceilings.ToFrozenDictionary(),
            ConnectionHandles = connectionHandles.ToFrozenSet(),
            Counts = counts.ToFrozenDictionary(),
        };
    }

    /// <summary>A part's gauges: its counts, and the connections it keeps them for.</summary>
    public static Gauges Of(IReadOnlyDictionary<string, long> counts, IEnumerable<string> connectionHandles)
    {
        return new Gauges { ConnectionHandles = connectionHandles.ToFrozenSet(), Counts = counts.ToFrozenDictionary() };
    }
}
