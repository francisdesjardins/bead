using System.Text.Json;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes, as a payload, read by the <c>json</c> and the <c>text</c> codecs (spec section 17):
/// each read returns, or refuses with a <see cref="FormatException"/>. What a reader returns, its
/// writer writes: a <c>text</c> payload as the bytes it came in, a <c>json</c> one in a canonical
/// form that reads back as itself. The TypeScript side's <c>tools/fuzz/payload-codecs.ts</c> is its
/// twin.
/// </summary>
internal sealed class PayloadCodecsTarget : IFuzzTarget
{
    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "payload-codecs";
        }
    }

    // helpers

    private static JsonElement? JsonOf(ReadOnlyMemory<byte> payload)
    {
        try
        {
            return PayloadCodecs.Json.Decode(payload);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static string? TextOf(ReadOnlyMemory<byte> payload)
    {
        try
        {
            return PayloadCodecs.Text.Decode(payload);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        var payload = data.ToArray();

        if (JsonOf(payload) is { } value)
        {
            var written = PayloadCodecs.Json.Encode(value);

            // * the canonical form is a fixed point: read again and written again, it is the same bytes
            if (!PayloadCodecs.Json.Encode(PayloadCodecs.Json.Decode(written)).Span.SequenceEqual(written.Span))
            {
                throw new InvalidOperationException($"a json payload's canonical form reads back otherwise: {Convert.ToHexStringLower(payload)}");
            }
        }

        if (TextOf(payload) is { } text && !PayloadCodecs.Text.Encode(text).Span.SequenceEqual(payload))
        {
            throw new InvalidOperationException($"a text payload is written back otherwise: {Convert.ToHexStringLower(payload)}");
        }
    }
}
