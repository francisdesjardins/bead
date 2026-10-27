using System.Reflection;

namespace Bead.Tests;

/// <summary><see cref="GeneratedCode"/>: the twin of the TypeScript side's <c>generated-code.test.ts</c>.</summary>
public sealed class GeneratedCodeTests
{
    // * as a generated file names it: a private constant of the runtime's, which an older runtime lacks
    private const bool Supports = GeneratedCode.SupportsVersion6;

    // the route table's, which calls no codec, beside it
    private const bool SupportsRoutes = GeneratedCode.SupportsVersion5;

    [Fact]
    public void Holds_the_constants_of_the_contracts_this_runtime_supports_5_and_6_and_no_other()
    {
        Assert.True(Supports);
        Assert.True(SupportsRoutes);

        // * 4 goes: code that names it reads a required field unset, which no longer conforms
        Assert.Equal(
            ["SupportsVersion5", "SupportsVersion6"],
            typeof(GeneratedCode).GetFields(BindingFlags.Public | BindingFlags.Static).Select((field) =>
            {
                return field.Name;
            }).Order(StringComparer.Ordinal));
    }
}
