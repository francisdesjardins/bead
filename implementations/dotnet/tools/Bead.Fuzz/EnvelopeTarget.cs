namespace Bead.Fuzz;

/// <summary>
/// Raw bytes, as a transport delivers them, read by each side's router as an envelope, its header
/// then its body, and as a failure's record: each read returns, or refuses with a
/// <see cref="FailureException"/>, as <c>EnvelopeFuzzTests</c> holds of the vectors' mutations. What
/// reads is written back, and from that writing on is written again as it was. The TypeScript
/// side's <c>tools/fuzz/envelope.ts</c> and the Rust side's <c>envelope</c> target are its twins.
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
            Envelope? envelope = null;

            try
            {
                envelope = EnvelopeCodec.ReadEnvelope(data, options);
            }
            catch (FailureException)
            {
                // a refusal is the answer to bytes that are no envelope
            }

            if (envelope is not null)
            {
                Rewrites(envelope, options);
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

    // ! the first writing is the fixed point, not the input: a detail's bytes that are no UTF-8 read
    // as U+FFFD (spec 7.3), three bytes each, and its writing cuts them again (7.4)
    private static void Rewrites(Envelope envelope, EnvelopeReadOptions options)
    {
        byte[] written;

        try
        {
            written = EnvelopeCodec.WriteEnvelope(envelope, options.MaximumDetailBytes);
        }
        catch (ArgumentException)
        {
            // what its writer refuses to write is no finding: an envelope it holds no form of
            return;
        }

        var normal = EnvelopeCodec.ReadEnvelope(written, options)
            ?? throw new InvalidOperationException("what is written reads");

        if (!EnvelopeCodec.WriteEnvelope(normal, options.MaximumDetailBytes).AsSpan().SequenceEqual(written))
        {
            throw new InvalidOperationException("what is written back is written as it was");
        }
    }
}
