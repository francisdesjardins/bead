namespace Bead.Tests;

/// <summary><see cref="Gauges"/>: a part's gauges, what it does not give being none, and several parts as one.</summary>
public sealed class GaugesTests
{
    // definition

    [Fact]
    public void Gives_a_part_gauges_what_it_does_not_give_being_none()
    {
        var gauges = Gauges.Of(new Dictionary<string, long> { ["calls"] = 2 }, []);

        Assert.Empty(gauges.Anomalies);
        Assert.Empty(gauges.Ceilings);
        Assert.Empty(gauges.ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["calls"] = 2 }, gauges.Counts);
        Assert.Equal(["a", "b"], Gauges.Of(new Dictionary<string, long>(), ["a", "a", "b"]).ConnectionHandles.Order());
        Assert.Empty(Gauges.Empty.Counts);
        var populated = Gauges.Of(new Dictionary<string, long> { ["calls"] = 3 }, ["a", "a", "b"]) with
        {
            Anomalies = ["odd"],
            Ceilings = new Dictionary<string, long> { ["calls"] = 4 },
        };

        Assert.Equal(["odd"], populated.Anomalies);
        Assert.Equal(new Dictionary<string, long> { ["calls"] = 4 }, populated.Ceilings);
        Assert.Equal(["a", "b"], populated.ConnectionHandles.Order());
        Assert.Equal(new Dictionary<string, long> { ["calls"] = 3 }, populated.Counts);
    }

    [Fact]
    public void Gives_several_parts_as_one_and_refuses_a_count_two_of_them_name()
    {
        var merged = Gauges.Merge(
        [
            Gauges.Of(new Dictionary<string, long> { ["bytes"] = 1 }, ["a"]) with { Ceilings = new Dictionary<string, long> { ["bytes"] = 8 } },
            Gauges.Of(new Dictionary<string, long> { ["calls"] = 2 }, ["a", "b"]) with { Anomalies = ["odd"] },
        ]);

        Assert.Equal(["odd"], merged.Anomalies);
        Assert.Equal(new Dictionary<string, long> { ["bytes"] = 8 }, merged.Ceilings);
        Assert.Equal(["a", "b"], merged.ConnectionHandles.Order());
        Assert.Equal(new Dictionary<string, long> { ["bytes"] = 1, ["calls"] = 2 }, merged.Counts);
        Assert.Empty(Gauges.Merge([]).Counts);
        Assert.Equal(
            "two parts count calls (Parameter 'parts')",
            Assert.Throws<ArgumentException>(() =>
            {
                return Gauges.Merge(
                [
                    Gauges.Of(new Dictionary<string, long> { ["calls"] = 1 }, []),
                    Gauges.Of(new Dictionary<string, long> { ["calls"] = 2 }, []),
                ]);
            }).Message);
    }
}
