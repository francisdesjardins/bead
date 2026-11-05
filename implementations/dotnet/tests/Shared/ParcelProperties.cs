namespace Bead.Tests;

/// <summary>
/// What a broker's parcel reader and writer hold of any bytes (spec 15.17, 15.18), which the
/// <c>broker-parcel</c> fuzz target and <c>BrokerParcelFuzzTests</c> share: the reader gives a
/// parcel, no parcel or a parcel that does not read; a parcel that reads is written again, its
/// writer refusing exactly those it refuses by design and never with its read-back refusal; what it
/// writes reads as the same parcel and writes again to the same bytes. The TypeScript side's twin is
/// <c>transport/shared/__tests__/parcel-properties.ts</c>, the Rust side's
/// <c>bead::testing::parcels</c>.
/// </summary>
internal static class ParcelProperties
{
    // constants

    // the writer's own refusal of what would not read back: never met by a parcel that read
    private const string ReadBack = "a parcel this side refuses is never written";

    // helpers

    // whether two parcels hold the same fields, their bytes compared by their content
    private static bool IsSame(BrokerParcel one, BrokerParcel other)
    {
        return one with { Layouts = null, Carried = default } == other with { Layouts = null, Carried = default }
            && (one.Layouts ?? []).SequenceEqual(other.Layouts ?? [])
            && one.Carried.Span.SequenceEqual(other.Carried.Span);
    }

    // a parcel's fields, its bytes in hexadecimal, for a break's words
    private static string Described(BrokerParcel parcel)
    {
        var layouts = parcel.Layouts is null ? "none" : Convert.ToHexStringLower([.. parcel.Layouts]);

        return $"{parcel with { Layouts = null, Carried = default }}, layouts {layouts}, carried {Convert.ToHexStringLower(parcel.Carried.Span)}";
    }

    // definition

    /// <summary>
    /// Whether the side's writer refuses <paramref name="parcel"/> by design (spec 15.18): a layout
    /// other than <c>0xB1</c>, an advisory kind or one not assigned, or an OPEN or an ACCEPT that
    /// names no token or a receive bound outside 1,024 to 2³² − 1. Such a parcel a side reads and no
    /// writer writes.
    /// </summary>
    public static bool IsRefusedByDesign(BrokerParcel parcel)
    {
        var isOpening = parcel.Kind is BrokerParcelKinds.Open or BrokerParcelKinds.Accept;
        var isOpenAsWritten = BrokerParcels.IsToken(parcel.Id) && parcel.Bound is >= BrokerParcels.LeastBound and <= BrokerParcels.LargestBound;

        return parcel.Layout != BrokerParcels.Layout || parcel.Kind is 0 or > BrokerParcelKinds.Gone || (isOpening && !isOpenAsWritten);
    }

    /// <summary>
    /// What <paramref name="input"/> breaks of the properties, in words; none where it holds them.
    /// What the reader or the writer throws other than the writer's documented refusal, an
    /// <see cref="ArgumentException"/>, goes on.
    /// </summary>
    public static string? BreakOf(byte[] input)
    {
        var read = BrokerParcels.Read(input);

        if (read.Verdict != ParcelVerdict.Taken)
        {
            return null;
        }

        var fields = read.Parcel!;
        byte[] written;

        try
        {
            written = BrokerParcels.Write(fields);
        }
        catch (ArgumentException reason)
        {
            if (reason.Message.StartsWith(ReadBack, StringComparison.Ordinal))
            {
                return $"{reason.Message}: {Described(fields)}";
            }

            return IsRefusedByDesign(fields) ? null : $"refused, not by design, {reason.Message}: {Described(fields)}";
        }

        if (IsRefusedByDesign(fields))
        {
            return $"written, where it is refused by design: {Described(fields)}";
        }

        var again = BrokerParcels.Read(written);

        if (again.Verdict != ParcelVerdict.Taken || !IsSame(again.Parcel!, fields))
        {
            return $"what it wrote reads as {again.Verdict}, {again.Why}: {Described(fields)}";
        }

        return BrokerParcels.Write(again.Parcel!).AsSpan().SequenceEqual(written)
            ? null
            : $"written again to other bytes: {Described(fields)}";
    }
}
