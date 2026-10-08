using System.Text.Json;
using Bead.Interop;

namespace Bead.Tests;

/// <summary><see cref="InteropHandlers"/>: what <c>endSessionsOf</c> takes.</summary>
public sealed class InteropHandlersTests
{
    [Fact]
    public void The_interop_service_s_endSessionsOf_takes_an_issuer_alone_a_string_and_throws_for_anything_else()
    {
        const string Issuer = "https://hs256.interop.bead.example";

        Assert.Equal(Issuer, InteropHandlers.IssuerOf(JsonSerializer.SerializeToElement(new { issuer = Issuer })));
        Assert.Equal("", InteropHandlers.IssuerOf(JsonSerializer.SerializeToElement(new { issuer = "" })));

        foreach (var request in new[]
        {
            "[]",
            "null",
            "7",
            "\"https://hs256.interop.bead.example\"",
            "{}",
            "{\"issuer\":7}",
            "{\"issuer\":null}",
            "{\"issuer\":\"https://hs256.interop.bead.example\",\"sub\":\"grace\"}",
            "{\"iss\":\"https://hs256.interop.bead.example\"}",
        })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return InteropHandlers.IssuerOf(JsonSerializer.Deserialize<JsonElement>(request));
            });
        }
    }
}
