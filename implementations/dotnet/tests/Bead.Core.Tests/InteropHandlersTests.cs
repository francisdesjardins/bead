using System.Text.Json;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// <see cref="InteropHandlers"/>: what <c>endSessionsOf</c> takes, by <c>verifiers.endSessionsOf</c>
/// of <c>spec/interop-service.json</c>, which the TypeScript side's handler answers alike.
/// </summary>
public sealed class InteropHandlersTests
{
    // constants

    private static readonly JsonElement EndSessionsOf = Load().GetProperty("verifiers").GetProperty("endSessionsOf");

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "interop-service.json")));

        return document.RootElement.Clone();
    }

    // definition

    [Fact]
    public void The_interop_service_s_endSessionsOf_takes_an_issuer_alone_a_string_and_throws_for_anything_else()
    {
        var refusal = EndSessionsOf.GetProperty("refusal").GetString();

        Assert.NotEmpty(EndSessionsOf.GetProperty("takes").EnumerateArray());
        Assert.NotEmpty(EndSessionsOf.GetProperty("refuses").EnumerateArray());

        foreach (var taken in EndSessionsOf.GetProperty("takes").EnumerateArray())
        {
            Assert.Equal(taken.GetProperty("issuer").GetString(), InteropHandlers.IssuerOf(taken.GetProperty("request")));
        }

        foreach (var request in EndSessionsOf.GetProperty("refuses").EnumerateArray())
        {
            var thrown = Assert.Throws<ArgumentException>(() =>
            {
                return InteropHandlers.IssuerOf(request);
            });

            Assert.Equal(refusal, thrown.Message);
        }
    }
}
