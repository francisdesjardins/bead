namespace Bead.Tests;

/// <summary>
/// The tests that stand in for the platform's resolver or its proxy, each process-wide: they run
/// alone, after the others, and put back what they found (spec 13.4).
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class PlatformSeams
{
    /// <summary>The collection's name.</summary>
    public const string Name = "the platform's resolver and proxy";
}
