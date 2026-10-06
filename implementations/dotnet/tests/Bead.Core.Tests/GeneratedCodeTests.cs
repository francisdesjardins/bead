namespace Bead.Tests;

/// <summary><see cref="GeneratedCode"/>: the twin of the TypeScript side's <c>generated-code.test.ts</c>.</summary>
public sealed class GeneratedCodeTests
{
    // * as a generated file names it: a private constant of the runtime's, which an older runtime lacks
    private const bool Supports = GeneratedCode.SupportsVersion1;

    [Fact]
    public void Holds_the_constant_of_the_contract_this_runtime_supports()
    {
        Assert.True(Supports);
    }
}
