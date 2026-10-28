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
/// which it holds as bytes. A message that reaches no required field costs one lookup. The
/// TypeScript side's twin is the walk of <c>protoCodecOf</c>, of <c>@francisdesjardins/bead/proto</c>.
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
    /// with a <see cref="FormatException"/> naming the first the walk finds, by its full name: a
    /// field of the schema, never a key its peer sent. The codec's one refusal, reading and writing.
    /// </summary>
    /// <exception cref="FormatException">The message leaves a field of <c>LEGACY_REQUIRED</c> presence unset.</exception>
    public static void Check(IMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (UnsetOf(message) is { } unset)
        {
            throw new FormatException($"a proto message leaves {unset.Field.FullName} unset");
        }
    }

    /// <summary>The first field of <c>LEGACY_REQUIRED</c> presence the walk finds unset in <paramref name="message"/>, and its way there; none where it leaves none.</summary>
    internal static UnsetField? UnsetOf(IMessage message)
    {
        var shape = ProtoRecords.ShapeOf(message.Descriptor);

        if (!shape.ReachesRequired)
        {
            return null;
        }

        var steps = new List<UnsetStep>();

        return Walked(message, (shape, steps));
    }

    // a message's own required fields, then each message it holds that reaches one
    private static UnsetField? Walked(IMessage message, (ProtoRecords.Shape Shape, List<UnsetStep> Steps) at)
    {
        var (shape, steps) = at;

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

                foreach (var key in keys)
                {
                    if (Held(map[key], (new UnsetStep { Field = field, Key = key }, steps)) is { } unset)
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
                    if (Held(list[index], (new UnsetStep { Field = field, Index = index }, steps)) is { } unset)
                    {
                        return unset;
                    }
                }
            }
            else if (Held(value, (new UnsetStep { Field = field }, steps)) is { } unset)
            {
                return unset;
            }
        }

        return null;
    }

    // a message a field holds, walked one step further
    private static UnsetField? Held(object? value, (UnsetStep Step, List<UnsetStep> Steps) at)
    {
        if (value is not IMessage held)
        {
            return null;
        }

        var (step, steps) = at;

        steps.Add(step);

        var unset = Walked(held, (ProtoRecords.ShapeOf(held.Descriptor), steps));

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
