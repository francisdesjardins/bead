using System.Collections;
using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// A <c>proto</c> writer's depth pass (spec 17.2, 17.9.3, decision 0031): a walk of a value's known
/// fields as the wire nests them, before anything walks it further or Google.Protobuf writes it, so
/// that no recursion is reached, <c>CalculateSize</c>'s or <see cref="ProtoRequired"/>'s; the bound
/// itself is the reader's check over the written bytes, <see cref="ProtoRecords"/>'s. A message
/// field, a repeated field's item, a group and a delimited field count one each, a oneof's message
/// member among them; a map's entry one, a map of scalars' among them, and its message value one
/// more. It counts less than the wire where a value holds what a reading kept, an extension or an
/// <c>Any</c>'s bytes, never more, so it never refuses what a reader takes. The TypeScript side's
/// twin is <c>assertProtoDepth</c>, the Rust side's the depth pass of <c>required.rs</c>.
/// </summary>
internal static class ProtoDepth
{
    // definition

    /// <summary>
    /// Refuses <paramref name="message"/> where its known fields nest a message more than 100 deep
    /// below it, with a <see cref="FormatException"/> of <c>nested past 100</c>, the writer's
    /// refusal. The walk goes 101 frames deep at most, and none where its message's fields cannot
    /// nest so deep.
    /// </summary>
    /// <exception cref="FormatException">The message nests a message more than 100 deep below it.</exception>
    public static void Check(IMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        Check(message, ProtoRecords.ShapeOf(message.Descriptor));
    }

    /// <summary>
    /// <paramref name="message"/> judged by <paramref name="shape"/>, its message's: not walked at
    /// all where the shape's fields cannot nest past the bound.
    /// </summary>
    internal static void Check(IMessage message, ProtoRecords.Shape shape)
    {
        if (shape.NestsPast && NestsPast(message, (shape, 0)))
        {
            throw new FormatException(
                ProtoRecords.NestedPast100,
                new FormatException($"a proto value nests a message more than {ProtoRecords.Depth} deep below the top one"));
        }
    }

    // whether `message`, `depth` below the top one, nests a message past the bound in its known fields
    private static bool NestsPast(IMessage message, (ProtoRecords.Shape Shape, int Depth) at)
    {
        var (shape, depth) = at;

        foreach (var field in shape.Nesting)
        {
            var value = field.Accessor.GetValue(message);

            if (field.IsMap)
            {
                if (EntriesNestPast((IDictionary)value, (field, depth)))
                {
                    return true;
                }
            }
            else if (field.IsRepeated)
            {
                foreach (var item in (IList)value)
                {
                    if (HeldNestsPast(item, depth + 1))
                    {
                        return true;
                    }
                }
            }
            else if (HeldNestsPast(value, depth + 1))
            {
                return true;
            }
        }

        return false;
    }

    // * a map's entry is a message on the wire, a map of scalars' among them; its message value one more
    private static bool EntriesNestPast(IDictionary map, (FieldDescriptor Field, int Depth) at)
    {
        var (field, depth) = at;

        if (map.Count == 0)
        {
            return false;
        }

        if (depth + 1 > ProtoRecords.Depth)
        {
            return true;
        }

        if (field.MessageType.FindFieldByNumber(2).FieldType is not (FieldType.Message or FieldType.Group))
        {
            return false;
        }

        foreach (var item in map.Values)
        {
            if (HeldNestsPast(item, depth + 2))
            {
                return true;
            }
        }

        return false;
    }

    // whether a message a field holds, `depth` below the top one, nests one past the bound: a
    // wrapper's, which Google.Protobuf holds as its value, one message and no more
    private static bool HeldNestsPast(object? held, int depth)
    {
        if (held is null)
        {
            return false;
        }

        if (depth > ProtoRecords.Depth)
        {
            return true;
        }

        return held is IMessage message && NestsPast(message, (ProtoRecords.ShapeOf(message.Descriptor), depth));
    }
}
