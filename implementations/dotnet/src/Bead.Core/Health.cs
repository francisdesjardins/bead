namespace Bead;

/// <summary>A verdict, from the best to the worst, as the IETF draft "Health Check Response Format for HTTP APIs" names them.</summary>
public enum HealthStatus
{
    /// <summary>Nothing is wrong.</summary>
    Pass,

    /// <summary>A count is near its ceiling, or past it.</summary>
    Warn,

    /// <summary>A connection kept that the transport no longer holds, or something that should never be.</summary>
    Fail,
}

/// <summary>
/// A layer's gauges as they leave the process: its counts, their ceilings, its anomalies, and its
/// orphans — the connections it keeps anything for that the transport no longer holds — never a
/// handle.
/// </summary>
/// <param name="Anomalies">What it found that should never be.</param>
/// <param name="Ceilings">The ceiling of each count that has one.</param>
/// <param name="Counts">Each count, by its name.</param>
/// <param name="Orphans">The connections it keeps anything for that the transport no longer holds.</param>
public sealed record LayerGauges(
    IReadOnlyList<string> Anomalies,
    IReadOnlyDictionary<string, long> Ceilings,
    IReadOnlyDictionary<string, long> Counts,
    int Orphans)
{
    /// <summary><paramref name="gauges"/> for leaving the process: its handles gone, each one <paramref name="held"/> does not hold an orphan.</summary>
    public static LayerGauges Of(Gauges gauges, IReadOnlySet<string> held)
    {
        ArgumentNullException.ThrowIfNull(gauges);
        ArgumentNullException.ThrowIfNull(held);

        var orphans = gauges.ConnectionHandles.Count((connectionHandle) =>
        {
            return !held.Contains(connectionHandle);
        });

        return new LayerGauges(gauges.Anomalies, gauges.Ceilings, gauges.Counts, orphans);
    }
}

/// <summary>What each layer of a server holds.</summary>
/// <param name="Router">Its router's: its core, its subscriptions, its notifications, its relay.</param>
/// <param name="Server">Its own: its connections, those closing, those with no session.</param>
/// <param name="Sessions">Its sessions'.</param>
/// <param name="Transport">Its transport's: the connections it holds, which the others are set against.</param>
public sealed record ServerGauges(LayerGauges Router, LayerGauges Server, LayerGauges Sessions, LayerGauges Transport);

/// <summary>A check, as the IETF draft "Health Check Response Format for HTTP APIs" writes one.</summary>
/// <param name="ObservedValue">What it measured.</param>
/// <param name="Status">Its verdict.</param>
/// <param name="Output">What it says of a verdict other than a pass, or of a count and its ceiling.</param>
public sealed record HealthCheck(long ObservedValue, HealthStatus Status, string? Output = null);

/// <summary>A server's verdict: the worst of its checks, and each check under <c>layer:measure</c>.</summary>
/// <param name="Checks">Each check, under <c>layer:measure</c>.</param>
/// <param name="Status">The worst of its checks.</param>
public sealed record Health(IReadOnlyDictionary<string, IReadOnlyList<HealthCheck>> Checks, HealthStatus Status)
{
    /// <summary>The share of its ceiling from which a count warns.</summary>
    public const double WarningRatio = 0.8;

    /// <summary>
    /// The verdict on a server's gauges: <see cref="HealthStatus.Fail"/> for an orphan or an anomaly,
    /// <see cref="HealthStatus.Warn"/> for a count at <see cref="WarningRatio"/> of its ceiling or
    /// past it, <see cref="HealthStatus.Pass"/> otherwise; the server's, the worst.
    /// </summary>
    public static Health Of(ServerGauges gauges)
    {
        ArgumentNullException.ThrowIfNull(gauges);

        var checks = new Dictionary<string, IReadOnlyList<HealthCheck>>();
        var status = HealthStatus.Pass;

        void Check(string name, HealthCheck found)
        {
            checks[name] = [found];
            status = found.Status > status ? found.Status : status;
        }

        (string Layer, LayerGauges Gauges)[] layers =
        [
            ("router", gauges.Router),
            ("server", gauges.Server),
            ("sessions", gauges.Sessions),
            ("transport", gauges.Transport),
        ];

        foreach (var (layer, (anomalies, ceilings, counts, orphans)) in layers)
        {
            Check(
                $"{layer}:orphans",
                orphans == 0
                    ? new HealthCheck(0, HealthStatus.Pass)
                    : new HealthCheck(orphans, HealthStatus.Fail, $"{orphans} connections kept that the transport no longer holds"));
            Check(
                $"{layer}:anomalies",
                anomalies.Count == 0
                    ? new HealthCheck(0, HealthStatus.Pass)
                    : new HealthCheck(anomalies.Count, HealthStatus.Fail, string.Join("; ", anomalies)));

            foreach (var (name, count) in counts)
            {
                if (ceilings.TryGetValue(name, out var ceiling))
                {
                    Check(
                        $"{layer}:{name}",
                        new HealthCheck(count, count >= WarningRatio * ceiling ? HealthStatus.Warn : HealthStatus.Pass, $"{count} of {ceiling}"));
                }
            }
        }

        return new Health(checks, status);
    }
}
