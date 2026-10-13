using System.Collections.Frozen;
using System.Runtime.CompilerServices;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// A <c>proto</c> payload's records, read against its message before its stock library reads them
/// (spec 17.9, decision 0028): the check the code beadc generates calls, which refuses what protobuf
/// refuses where a stock library reads on, and reads nothing in the library's place. It walks the
/// payload once, by the message's own descriptor, and allocates nothing per record. The TypeScript
/// side's twin is <c>checkProtoRecords</c>, of <c>@francisdesjardins/bead/proto</c>.
/// </summary>
public static class ProtoRecords
{
    // constants

    // * spec 17.9.3: how deep a message nests below the top one, a group and a map's entry each
    // counting as a message
    private const int Depth = 100;

    // the wire types of protobuf's Encoding guide
    private const int Varint = 0;
    private const int Fixed64 = 1;
    private const int Delimited = 2;
    private const int StartGroup = 3;
    private const int EndGroup = 4;
    private const int Fixed32 = 5;

    // each message's shape, built once from its descriptor and held as long as the descriptor is
    private static readonly ConditionalWeakTable<MessageDescriptor, Shape> Shapes = [];

    // helpers

    /// <summary>The shape of <paramref name="message"/>, built at its first use and cached by its descriptor.</summary>
    internal static Shape ShapeOf(MessageDescriptor message)
    {
        return Shapes.GetValue(message, (descriptor) =>
        {
            return new Shape(descriptor);
        });
    }

    // definition

    /// <summary>
    /// Checks <paramref name="bytes"/> against the records of <paramref name="message"/>, at every
    /// depth: refused, a tag of more than 5 bytes, past 32 bits or of field number 0; a varint of
    /// more than 10 bytes; a length past the bytes that follow it; a record past the end of its
    /// message; a packed record whose values do not end at its length; a group closed by another
    /// number's end group or never closed, an end group that closes none, and the wire types 6 and
    /// 7; a message nested more than 100 deep below the top one (17.9.3); a field the message
    /// declares at a wire type its type does not take (17.9.5); and a map's entry with a field other
    /// than its key and its value (17.9.6). An unknown length-delimited record is opaque, as
    /// protobuf keeps it.
    /// </summary>
    /// <exception cref="FormatException">The bytes are no encoding of the message, or nest too deep.</exception>
    public static void Check(ReadOnlySpan<byte> bytes, MessageDescriptor message)
    {
        ArgumentNullException.ThrowIfNull(message);

        var walk = new Walk(bytes);

        walk.Message(ShapeOf(message), new Frame(bytes.Length, 0, 0));
    }

    // what a record of a field the message declares takes, read once from its descriptor
    internal sealed class FieldShape
    {
        private readonly MessageDescriptor? _message;

        private Shape? _shape;

        public FieldShape(FieldDescriptor field)
        {
            Own = WireTypeOf(field.FieldType);
            Width = Own switch
            {
                Fixed64 => 8,
                Fixed32 => 4,
                _ => 0,
            };

            // * a repeated scalar of a numeric type takes its own wire type and the length-delimited,
            // packed or not, as protobuf's parsers must (Encoding, "Packed Repeated Fields")
            IsPackable = field.IsRepeated && Own is Varint or Fixed64 or Fixed32;

            if (field.FieldType is FieldType.Message or FieldType.Group)
            {
                _message = field.MessageType;
            }
        }

        /// <summary>The wire type of its type.</summary>
        public int Own { get; }

        /// <summary>The bytes of each of its values, a fixed width's, or 0 for a varint's.</summary>
        public int Width { get; }

        /// <summary>Whether it takes a packed record too.</summary>
        public bool IsPackable { get; }

        /// <summary>
        /// The shape of the message it holds, or null: resolved at its first use, so that a message
        /// can hold itself.
        /// </summary>
        public Shape? Message
        {
            get
            {
                // ! a race resolves the same shape twice, from the one table
                if (_shape is null && _message is not null)
                {
                    _shape = ShapeOf(_message);
                }

                return _shape;
            }
        }

        /// <summary>Whether a record at <paramref name="wireType"/> is one of its type's.</summary>
        public bool Takes(int wireType)
        {
            return wireType == Own || (IsPackable && wireType == Delimited);
        }

        private static int WireTypeOf(FieldType type)
        {
            return type switch
            {
                FieldType.Double or FieldType.Fixed64 or FieldType.SFixed64 => Fixed64,
                FieldType.Float or FieldType.Fixed32 or FieldType.SFixed32 => Fixed32,
                FieldType.String or FieldType.Bytes or FieldType.Message => Delimited,
                FieldType.Group => StartGroup,
                _ => Varint,
            };
        }
    }

    // a message's fields by their number, each what its records take
    internal sealed class Shape
    {
        // an unknown group's: every field it holds unknown
        public static readonly Shape Unknown = new();

        private readonly FrozenDictionary<int, FieldShape> _fields;

        public Shape(MessageDescriptor message)
        {
            _fields = message.Fields.InFieldNumberOrder().ToFrozenDictionary(
                (field) =>
                {
                    return field.FieldNumber;
                },
                (field) =>
                {
                    return new FieldShape(field);
                });
            IsMapEntry = message.IsMapEntry;
        }

        private Shape()
        {
            _fields = FrozenDictionary<int, FieldShape>.Empty;
        }

        /// <summary>Whether it is a map's entry, which holds its key and its value and no other field.</summary>
        public bool IsMapEntry { get; }

        /// <summary>The field of <paramref name="number"/>, or null when the message declares none.</summary>
        public FieldShape? FieldOf(int number)
        {
            return _fields.GetValueOrDefault(number);
        }
    }

    // where a message's records end, how deep it is below the top one, and the number of the group it
    // is, or 0
    private readonly record struct Frame(int End, int Depth, int Group);

    // one walk of a payload, its position moving over its bytes
    private ref struct Walk(ReadOnlySpan<byte> bytes)
    {
        private readonly ReadOnlySpan<byte> _bytes = bytes;

        private int _at;

        // the records of a message, up to its end or to the end group that closes it
        public void Message(Shape shape, Frame frame)
        {
            while (_at < frame.End)
            {
                var tag = Tag(frame.End);
                var number = (int)(tag >> 3);
                var wireType = (int)(tag & 7);

                if (number == 0)
                {
                    throw Refused("field number 0");
                }

                if (wireType == EndGroup)
                {
                    if (number == frame.Group)
                    {
                        return;
                    }

                    throw Refused("an end group that closes no group open");
                }

                var field = shape.FieldOf(number);

                // * spec 17.9.6: where protobuf's reference parsers skip it, one stock library reads it
                // as records
                if (field is null && shape.IsMapEntry)
                {
                    throw Refused("a map's entry with a field other than its key and its value");
                }

                // * spec 17.9.5: where protobuf's reference parsers keep it as unknown, one stock
                // library reads it as its declared type
                if (field is not null && !field.Takes(wireType))
                {
                    throw Refused("a field at a wire type its type does not take");
                }

                Record(field, (tag, frame));
            }

            if (frame.Group != 0)
            {
                throw Refused("a group never closed");
            }
        }

        private static FormatException Refused(string reason)
        {
            return new FormatException($"a proto payload is not its message: {reason}");
        }

        // one record after its tag, of a field the message declares, or null
        private void Record(FieldShape? field, (uint Tag, Frame Frame) record)
        {
            var (tag, frame) = record;
            var wireType = (int)(tag & 7);

            switch (wireType)
            {
                case Varint:
                    ReadVarint(frame.End);
                    break;
                case Fixed64:
                    Skip(8, frame.End);
                    break;
                case Fixed32:
                    Skip(4, frame.End);
                    break;
                case Delimited:
                    var end = Length(frame.End);

                    if (field?.Message is { } message)
                    {
                        Message(message, new Frame(end, Deeper(frame), 0));
                    }
                    else if (field is { IsPackable: true })
                    {
                        Packed(field, end);
                    }
                    else
                    {
                        // ! an unknown record is opaque, as protobuf keeps it; a string's bytes are
                        // its library's to read
                        _at = end;
                    }

                    break;
                case StartGroup:
                    // * an unknown group is walked as a message every field of which is unknown
                    Message(field?.Message ?? Shape.Unknown, new Frame(frame.End, Deeper(frame), (int)(tag >> 3)));
                    break;
                default:
                    throw Refused($"the wire type {wireType}");
            }
        }

        // the depth of a message frame's holds
        private static int Deeper(Frame frame)
        {
            if (frame.Depth >= Depth)
            {
                throw new FormatException($"a proto payload nests a message more than {Depth} deep below the top one");
            }

            return frame.Depth + 1;
        }

        // the values of a packed record, which end exactly at its end
        private void Packed(FieldShape field, int end)
        {
            if (field.Width != 0)
            {
                if ((end - _at) % field.Width != 0)
                {
                    throw Refused("a packed record whose values do not end at its length");
                }

                _at = end;

                return;
            }

            // ! a varint that runs past the record's end is refused as cut short
            while (_at < end)
            {
                ReadVarint(end);
            }
        }

        private void Skip(int count, int end)
        {
            if (end - _at < count)
            {
                throw Refused("a record past the end of its message");
            }

            _at += count;
        }

        // a length's varint, and where the bytes it counts end, within the message's
        private int Length(int end)
        {
            var length = ReadVarint(end);

            if (length > (ulong)(end - _at))
            {
                throw Refused("a length past the bytes that follow it");
            }

            return _at + (int)length;
        }

        private ulong ReadVarint(int end)
        {
            var value = 0UL;

            for (var index = 0; index < 10; index++)
            {
                if (_at >= end)
                {
                    throw Refused("a varint cut short, or past the end of its message");
                }

                var each = _bytes[_at++];

                value |= (ulong)(each & 0x7F) << (7 * index);

                if ((each & 0x80) == 0)
                {
                    return value;
                }
            }

            throw Refused("a varint of more than 10 bytes");
        }

        // a tag: a varint of 5 bytes at most, within 32 bits (Encoding, "Message Structure")
        private uint Tag(int end)
        {
            var value = 0U;

            for (var index = 0; index < 5; index++)
            {
                if (_at >= end)
                {
                    throw Refused("a tag cut short, or past the end of its message");
                }

                var each = _bytes[_at++];

                if (index == 4 && each > 0x0F)
                {
                    throw Refused("a tag of more than 5 bytes, or past 32 bits");
                }

                value |= (uint)(each & 0x7F) << (7 * index);

                if ((each & 0x80) == 0)
                {
                    return value;
                }
            }

            throw Refused("a tag of more than 5 bytes, or past 32 bits");
        }
    }
}
