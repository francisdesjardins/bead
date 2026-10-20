namespace Bead.Fuzz;

/// <summary>
/// Raw bytes, as a transport delivers them, read by each side's router as an envelope, its header
/// then its body, and as a failure's record: each read returns, or refuses with a
/// <see cref="FailureException"/>, as <c>EnvelopeFuzzTests</c> holds of the vectors' mutations. The
/// TypeScript side's <c>tools/fuzz/envelope.ts</c> is its twin.
/// </summary>
internal sealed class EnvelopeTarget : IFuzzTarget
{
    // each side's reader, at the bounds a router reads with by default
    private static readonly EnvelopeReadOptions[] Readers =
    [
        new EnvelopeReadOptions { Side = RouterSide.Server },
        new EnvelopeReadOptions { Side = RouterSide.Client },
    ];

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "envelope";
        }
    }

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        foreach (var options in Readers)
        {
            try
            {
                EnvelopeCodec.ReadEnvelope(data, options);
            }
            catch (FailureException)
            {
                // a refusal is the answer to bytes that are no envelope
            }

            try
            {
                EnvelopeCodec.ReadFailure(data, options);
            }
            catch (FailureException)
            {
                // and to bytes that are no failure's record
            }
        }
    }
}
