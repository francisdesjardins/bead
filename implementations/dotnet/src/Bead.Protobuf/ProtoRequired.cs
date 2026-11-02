using System.Collections;
using System.Globalization;
using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// A <c>proto</c> message judged by its fields of <c>LEGACY_REQUIRED</c> presence (spec 17.9.7,
/// decision 0042): proto2's <c>required</c>, an edition's <c>features.field_presence =
/// LEGACY_REQUIRED</c>, which protobuf has "required for parsing and serialization" and
/// Google.Protobuf reads and writes unset. Bead's own walk, since <c>IsInitialized()</c> reads a
/// proto3 message as initialized and throws on a group or a delimited field. It takes a message's
/// own fields first, by their numbers, then each message it holds, depth first, by field number: a
/// repeated field's items by index, a map's entries by key in spec 18.5's order. It looks into no
/// extension, which Google.Protobuf holds among the unknown fields, and no <c>Any</c>'s message,
/// which it holds as bytes. A message that reaches no required field costs one lookup. It goes 100
/// messages deep below the top one at most, as a reader reads (17.9.3), so it never recurses past
/// the bound, whatever a value holds; over a reading, whose records were held to the bound first,
/// one more where Google.Protobuf gives a map's entry that held no value its value's default. The
/// TypeScript side's twin is the walk of <c>protoCodecOf</c>, of
/// <c>@francisdesjardins/bead/proto</c>.
/// </summary>
public static class ProtoRequired
{
    // a map's keys in spec 18.5's order: integers ascending, false before true, strings by code points
    private static readonly Comparer<object> ByKey = Comparer<object>.Create((one, other) =>
    {
        if (one is string text && other is string another)
        {
            return Validators.ByCodePoints.Compare(text, another);
        }

        return Comparer<object>.Default.Compare(one, other);
    });

    // definition

    /// <summary>
    /// Refuses <paramref name="message"/> where it leaves a required field unset, at any depth,
    /// with a <see cref="FormatException"/> of spec 17.2's reason, <c>a required field unset</c>,
    /// its inner exception naming the first field the walk finds by its full name: a field of the
    /// schema, never a key its peer sent. The codec's refusal, reading and writing. A message that
    /// nests one reaching a required field more than 100 deep below it is refused,
    /// <c>nested past 100</c>, the walk going no deeper.
    /// </summary>
    /// <exception cref="FormatException">The message leaves a field of <c>LEGACY_REQUIRED</c> presence unset, or nests past the bound.</exception>
    public static void Check(IMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (UnsetOf(message) is { } unset)
        {
            throw new FormatException(
                ProtoRecords.RequiredUnset,
                new FormatException($"a proto message leaves {unset.Field.FullName} unset"));
        }
    }

    /// <summary>
    /// <see cref="Check"/> of a message a reading gave, its depth not judged: the records' check
    /// judged the wire's before Google.Protobuf read it, and Google.Protobuf gives a map's entry that
    /// held no value its value's default, a message one deeper than the wire nests, which a reader
    /// takes (17.9.3) and its writer then refuses.
    /// </summary>
    /// <exception cref="FormatException">The message leaves a field of <c>LEGACY_REQUIRED</c> presence unset.</exception>
    internal static void CheckRead(IMessage message)
    {
        if (UnsetOf(message, new Walk([], JudgesDepth: false)) is { } unset)
        {
            throw new FormatException(
                ProtoRecords.RequiredUnset,
                new FormatException($"a proto message leaves {unset.Field.FullName} unset"));
        }
    }

    /// <summary>
    /// The first field of <c>LEGACY_REQUIRED</c> presence the walk finds unset in
    /// <paramref name="message"/>, and its way there; none where it leaves none.
    /// </summary>
    /// <exception cref="FormatException">The message nests one reaching a required field more than 100 deep below it.</exception>
    internal static UnsetField? UnsetOf(IMessage message)
    {
        return UnsetOf(message, new Walk([], JudgesDepth: true));
    }

    private static UnsetField? UnsetOf(IMessage message, Walk walk)
    {
        var shape = ProtoRecords.ShapeOf(message.Descriptor);

        if (!shape.ReachesRequired)
        {
            return null;
        }

        return Walked(message, (shape, walk, 0));
    }

    // a message's own required fields, then each message it holds that reaches one, the message
    // `depth` below the top one
    private static UnsetField? Walked(IMessage message, (ProtoRecords.Shape Shape, Walk Walk, int Depth) at)
    {
        var (shape, walk, depth) = at;
        var steps = walk.Steps;

        foreach (var field in shape.Required)
        {
            if (!IsSet(field, message))
            {
                return new UnsetField([.. steps], field);
            }
        }

        foreach (var field in shape.Holding)
        {
            var value = field.Accessor.GetValue(message);

            if (field.IsMap)
            {
                var map = (IDictionary)value;
                var keys = new List<object>(map.Count);

                foreach (var key in map.Keys)
                {
                    keys.Add(key);
                }

                keys.Sort(ByKey);

                // * a map's entry is a message on the wire, its value one more
                foreach (var key in keys)
                {
                    if (Held(map[key], (new UnsetStep { Field = field, Key = key }, walk, depth + 2)) is { } unset)
                    {
                        return unset;
                    }
                }
            }
            else if (field.IsRepeated)
            {
                var list = (IList)value;

                for (var index = 0; index < list.Count; index += 1)
                {
                    if (Held(list[index], (new UnsetStep { Field = field, Index = index }, walk, depth + 1)) is { } unset)
                    {
                        return unset;
                    }
                }
            }
            else if (Held(value, (new UnsetStep { Field = field }, walk, depth + 1)) is { } unset)
            {
                return unset;
            }
        }

        return null;
    }

    // a message a field holds, `depth` below the top one, walked one step further: refused past the
    // bound, as a reader refuses it, where the walk judges its depth
    private static UnsetField? Held(object? value, (UnsetStep Step, Walk Walk, int Depth) at)
    {
        if (value is not IMessage held)
        {
            return null;
        }

        var (step, walk, depth) = at;
        var steps = walk.Steps;

        if (depth > ProtoRecords.Depth && walk.JudgesDepth)
        {
            throw new FormatException(
                ProtoRecords.NestedPast100,
                new FormatException($"a proto message nests one more than {ProtoRecords.Depth} deep below the top one"));
        }

        steps.Add(step);

        var unset = Walked(held, (ProtoRecords.ShapeOf(held.Descriptor), walk, depth));

        steps.RemoveAt(steps.Count - 1);

        return unset;
    }

    // whether a required field holds a value: a closed enum's of a number its enum declares, which
    // only an application sets otherwise, since a reading of 17.9.8 sets none
    private static bool IsSet(FieldDescriptor field, IMessage message)
    {
        if (!field.Accessor.HasValue(message))
        {
            return false;
        }

        if (field.FieldType == FieldType.Enum && ProtoEnums.IsClosed(field.EnumType))
        {
            var number = Convert.ToInt32(field.Accessor.GetValue(message), CultureInfo.InvariantCulture);

            return field.EnumType.FindValueByNumber(number) is not null;
        }

        return true;
    }
}

/// <summary>
/// One walk: its way to the message it is in, and whether it refuses a message past the bound, as
/// every walk does but a reading's, whose records were held to it first.
/// </summary>
internal sealed record Walk(List<UnsetStep> Steps, bool JudgesDepth);

/// <summary>
/// A step of the walk's way to a field left unset: a field of a message, and the item's index of a
/// repeated field, or the entry's key of a map.
/// </summary>
internal sealed record UnsetStep
{
    /// <summary>The field the step takes.</summary>
    public required FieldDescriptor Field { get; init; }

    /// <summary>The item's index, of a repeated field; none otherwise.</summary>
    public int? Index { get; init; }

    /// <summary>The entry's key, of a map; none otherwise.</summary>
    public object? Key { get; init; }
}

/// <summary>The first field of <c>LEGACY_REQUIRED</c> presence the walk found unset, and its way there from the top message.</summary>
internal sealed record UnsetField(IReadOnlyList<UnsetStep> Steps, FieldDescriptor Field);
