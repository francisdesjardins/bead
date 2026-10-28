using System.Runtime.CompilerServices;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// Whether an enum is closed (protobuf's <a href="https://protobuf.dev/programming-guides/enum/">Enum
/// Behavior</a>), which Google.Protobuf keeps to itself, treating every enum as open: a proto2
/// file's, or an edition's of <c>features.enum_type = CLOSED</c>, set on the enum, then on each
/// message it is declared in, then on its file, else the edition's default, which is open. The
/// TypeScript side reads it as protobuf-es resolves it, <c>enum.open === false</c>.
/// </summary>
internal static class ProtoEnums
{
    // each enum's closedness, resolved once and held as long as its descriptor is
    private static readonly ConditionalWeakTable<EnumDescriptor, object> Closed = [];

    // definition

    /// <summary>Whether <paramref name="descriptor"/> is closed: a number its values do not number sets nothing.</summary>
    public static bool IsClosed(EnumDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        return (bool)Closed.GetValue(descriptor, (each) =>
        {
            return Resolved(each);
        });
    }

    // ! Google.Protobuf strips features from GetOptions(): they are read from each descriptor's proto
    private static bool Resolved(EnumDescriptor descriptor)
    {
        var file = descriptor.File.ToProto();

        if (file.Syntax is "" or "proto2")
        {
            return true;
        }

        if (file.Syntax != "editions")
        {
            return false;
        }

        if (descriptor.ToProto().Options?.Features is { HasEnumType: true } own)
        {
            return own.EnumType == FeatureSet.Types.EnumType.Closed;
        }

        for (var holder = descriptor.ContainingType; holder is not null; holder = holder.ContainingType)
        {
            if (holder.ToProto().Options?.Features is { HasEnumType: true } held)
            {
                return held.EnumType == FeatureSet.Types.EnumType.Closed;
            }
        }

        if (file.Options?.Features is { HasEnumType: true } filed)
        {
            return filed.EnumType == FeatureSet.Types.EnumType.Closed;
        }

        // * every edition so far opens an enum by default
        return false;
    }
}
