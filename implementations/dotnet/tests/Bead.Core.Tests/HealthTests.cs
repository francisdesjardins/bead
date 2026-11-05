namespace Bead.Tests;

/// <summary>
/// <see cref="LayerGauges"/> and <see cref="Health"/>: a layer's gauges as they leave the process,
/// and the verdict on a server's.
/// </summary>
public sealed class HealthTests
{
    // constants

    private static readonly LayerGauges Quiet = new LayerGauges
    {
        Anomalies = [],
        Ceilings = new Dictionary<string, long>(),
        Counts = new Dictionary<string, long>(),
        Orphans = 0,
    };

    // helpers

    private static ServerGauges LayersOf(
        (LayerGauges? Router, LayerGauges? Sessions) above,
        LayerGauges? transport)
    {
        return new ServerGauges { Router = above.Router ?? Quiet, Server = Quiet, Sessions = above.Sessions ?? Quiet, Transport = transport ?? Quiet };
    }

    // a transport's gauges: its connections, under a ceiling of `ceiling`
    private static LayerGauges ConnectionsOf((long Connections, long Ceiling) counted)
    {
        return Quiet with
        {
            Ceilings = new Dictionary<string, long> { ["connections"] = counted.Ceiling },
            Counts = new Dictionary<string, long> { ["connections"] = counted.Connections },
        };
    }

    // definition

    [Fact]
    public void Keeps_a_layer_counts_ceilings_and_anomalies_and_counts_as_orphans_the_connections_held_nowhere_else()
    {
        var layer = LayerGauges.Of(
            Gauges.Of(new Dictionary<string, long> { ["calls"] = 3 }, ["a", "b", "c"]) with
            {
                Anomalies = ["odd"],
                Ceilings = new Dictionary<string, long> { ["calls"] = 4 },
            },
            new HashSet<string> { "a" });

        Assert.Equal(["odd"], layer.Anomalies);
        Assert.Equal(new Dictionary<string, long> { ["calls"] = 4 }, layer.Ceilings);
        Assert.Equal(new Dictionary<string, long> { ["calls"] = 3 }, layer.Counts);
        Assert.Equal(2, layer.Orphans);
    }

    [Fact]
    public void Passes_a_server_with_no_orphan_no_anomaly_and_each_count_under_its_ceiling()
    {
        var health = Health.Of(LayersOf((null, null), ConnectionsOf((7, 10)) with
        {
            Counts = new Dictionary<string, long> { ["connections"] = 7, ["listens"] = 3 },
        }));

        Assert.Equal(HealthStatus.Pass, health.Status);
        Assert.Equal(
            [
                "router:anomalies",
                "router:orphans",
                "server:anomalies",
                "server:orphans",
                "sessions:anomalies",
                "sessions:orphans",
                "transport:anomalies",
                "transport:connections",
                "transport:orphans",
            ],
            health.Checks.Keys.Order(StringComparer.Ordinal));
        Assert.All(
            health.Checks.Where((check) =>
            {
                return check.Key != "transport:connections";
            }),
            (check) =>
            {
                Assert.Equal([new HealthCheck { ObservedValue = 0, Status = HealthStatus.Pass }], check.Value);
            });
        Assert.Equal([new HealthCheck { ObservedValue = 7, Status = HealthStatus.Pass, Output = "7 of 10" }], health.Checks["transport:connections"]);
    }

    [Fact]
    public void Warns_of_a_count_from_its_warning_share_of_its_ceiling_and_fails_an_orphan_or_an_anomaly_the_worst_standing()
    {
        var near = Health.Of(LayersOf((null, null), ConnectionsOf((8, 10))));

        Assert.Equal(HealthStatus.Warn, near.Status);
        Assert.Equal([new HealthCheck { ObservedValue = 8, Status = HealthStatus.Warn, Output = "8 of 10" }], near.Checks["transport:connections"]);
        Assert.Equal(0.8, Health.WarningRatio);

        var failing = Health.Of(LayersOf((Quiet with { Orphans = 2 }, Quiet with { Anomalies = ["one", "two"] }), ConnectionsOf((9, 10))));

        Assert.Equal(HealthStatus.Fail, failing.Status);
        Assert.Equal(
            [new HealthCheck { ObservedValue = 2, Status = HealthStatus.Fail, Output = "2 connections kept that the transport no longer holds" }],
            failing.Checks["router:orphans"]);
        Assert.Equal([new HealthCheck { ObservedValue = 2, Status = HealthStatus.Fail, Output = "one; two" }], failing.Checks["sessions:anomalies"]);

        // a warning after a failure leaves it the worst
        Assert.Equal(HealthStatus.Fail, Health.Of(LayersOf((Quiet with { Orphans = 1 }, null), ConnectionsOf((1, 1)))).Status);
    }
}
