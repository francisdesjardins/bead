using Bead.Tests;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes, as a broker delivers a message, read by the parcel reader (spec 15.17), which gives a
/// parcel, no parcel or a parcel that does not read, and never throws. A parcel that reads is written
/// again: its writer refuses exactly those it refuses by design, a layout other than <c>0xB1</c>, an
/// advisory kind or one not assigned, an OPEN or an ACCEPT that names no token or a receive bound
/// out of range (15.18), and never with its read-back refusal; what it writes reads as the same
/// parcel and writes again to the same bytes, as <c>BrokerParcelFuzzTests</c> holds of the vectors'
/// mutations. The TypeScript side's <c>tools/fuzz/broker-parcel.ts</c> and the Rust side's
/// <c>broker-parcel</c> target are its twins.
/// </summary>
internal sealed class BrokerParcelTarget : IFuzzTarget
{
    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "broker-parcel";
        }
    }

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        var input = data.ToArray();

        if (ParcelProperties.BreakOf(input) is { } broken)
        {
            throw new InvalidOperationException($"{broken}; input {Convert.ToHexStringLower(input)}");
        }
    }
}
