namespace Bead.Tests;

/// <summary>
/// <see cref="LayerGauges"/> and <see cref="Health"/>: a layer's gauges as they leave the process,
/// and the verdict on a server's.
/// </summary>
public sealed class HealthTests
{
    // constants

    private static readonly LayerGauges Quiet = new(
        [],
        new Dictionary<string, long>(),
        new Dictionary<string, long>(),
        0);

    // helpers

    private static ServerGauges LayersOf(
        (LayerGauges? Router, LayerGauges? Sessions) above,
        LayerGauges? transport)
    {
        return new ServerGauges(above.Router ?? Quiet, Quiet, above.Sessions ?? Quiet, transport ?? Quiet);
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
                Assert.Equal([new HealthCheck(0, HealthStatus.Pass)], check.Value);
            });
        Assert.Equal([new HealthCheck(7, HealthStatus.Pass, "7 of 10")], health.Checks["transport:connections"]);
    }

    [Fact]
    public void Warns_of_a_count_from_its_warning_share_of_its_ceiling_and_fails_an_orphan_or_an_anomaly_the_worst_standing()
    {
        var near = Health.Of(LayersOf((null, null), ConnectionsOf((8, 10))));

        Assert.Equal(HealthStatus.Warn, near.Status);
        Assert.Equal([new HealthCheck(8, HealthStatus.Warn, "8 of 10")], near.Checks["transport:connections"]);
        Assert.Equal(0.8, Health.WarningRatio);

        var failing = Health.Of(LayersOf((Quiet with { Orphans = 2 }, Quiet with { Anomalies = ["one", "two"] }), ConnectionsOf((9, 10))));

        Assert.Equal(HealthStatus.Fail, failing.Status);
        Assert.Equal(
            [new HealthCheck(2, HealthStatus.Fail, "2 connections kept that the transport no longer holds")],
            failing.Checks["router:orphans"]);
        Assert.Equal([new HealthCheck(2, HealthStatus.Fail, "one; two")], failing.Checks["sessions:anomalies"]);

        // a warning after a failure leaves it the worst
        Assert.Equal(HealthStatus.Fail, Health.Of(LayersOf((Quiet with { Orphans = 1 }, null), ConnectionsOf((1, 1)))).Status);
    }
}
