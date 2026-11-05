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
public sealed record LayerGauges
{
    /// <summary>What it found that should never be.</summary>
    public required IReadOnlyList<string> Anomalies { get; init; }

    /// <summary>The ceiling of each count that has one.</summary>
    public required IReadOnlyDictionary<string, long> Ceilings { get; init; }

    /// <summary>Each count, by its name.</summary>
    public required IReadOnlyDictionary<string, long> Counts { get; init; }

    /// <summary>The connections it keeps anything for that the transport no longer holds.</summary>
    public required int Orphans { get; init; }

    /// <summary><paramref name="gauges"/> for leaving the process: its handles gone, each one <paramref name="held"/> does not hold an orphan.</summary>
    internal static LayerGauges Of(Gauges gauges, IReadOnlySet<string> held)
    {
        ArgumentNullException.ThrowIfNull(gauges);
        ArgumentNullException.ThrowIfNull(held);

        var orphans = gauges.ConnectionHandles.Count((connectionHandle) =>
        {
            return !held.Contains(connectionHandle);
        });

        return new LayerGauges
        {
            Anomalies = gauges.Anomalies,
            Ceilings = gauges.Ceilings,
            Counts = gauges.Counts,
            Orphans = orphans,
        };
    }
}

/// <summary>What each layer of a server holds.</summary>
public sealed record ServerGauges
{
    /// <summary>Its router's: its core, its subscriptions, its notifications, its relay.</summary>
    public required LayerGauges Router { get; init; }

    /// <summary>Its own: its connections, those closing, those with no session.</summary>
    public required LayerGauges Server { get; init; }

    /// <summary>Its sessions'.</summary>
    public required LayerGauges Sessions { get; init; }

    /// <summary>Its transport's: the connections it holds, which the others are set against.</summary>
    public required LayerGauges Transport { get; init; }
}

/// <summary>A check, as the IETF draft "Health Check Response Format for HTTP APIs" writes one.</summary>
public sealed record HealthCheck
{
    /// <summary>What it measured.</summary>
    public required long ObservedValue { get; init; }

    /// <summary>Its verdict.</summary>
    public required HealthStatus Status { get; init; }

    /// <summary>What it says of a verdict other than a pass, or of a count and its ceiling.</summary>
    public string? Output { get; init; }
}

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
    internal static Health Of(ServerGauges gauges)
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

        foreach (var (layer, measured) in layers)
        {
            var orphans = measured.Orphans;
            var anomalies = measured.Anomalies;

            Check(
                $"{layer}:orphans",
                orphans == 0
                    ? new HealthCheck { ObservedValue = 0, Status = HealthStatus.Pass }
                    : new HealthCheck
                    {
                        ObservedValue = orphans,
                        Status = HealthStatus.Fail,
                        Output = $"{orphans} connections kept that the transport no longer holds",
                    });
            Check(
                $"{layer}:anomalies",
                anomalies.Count == 0
                    ? new HealthCheck { ObservedValue = 0, Status = HealthStatus.Pass }
                    : new HealthCheck { ObservedValue = anomalies.Count, Status = HealthStatus.Fail, Output = string.Join("; ", anomalies) });

            foreach (var (name, count) in measured.Counts)
            {
                if (measured.Ceilings.TryGetValue(name, out var ceiling))
                {
                    Check(
                        $"{layer}:{name}",
                        new HealthCheck
                        {
                            ObservedValue = count,
                            Status = count >= WarningRatio * ceiling ? HealthStatus.Warn : HealthStatus.Pass,
                            Output = $"{count} of {ceiling}",
                        });
                }
            }
        }

        return new Health(checks, status);
    }
}
