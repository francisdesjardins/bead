using System.Buffers;
using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Transcoding;

/// <summary>
/// Bead's own mapping of protobuf's JSON (transcoding 5, decision 0037), one reader and one writer
/// over a message's descriptor and Google.Protobuf's reflection: a <c>proto</c> request's body read
/// as 5.2 to 5.4 read one, the message built through <see cref="FieldDescriptor.Accessor"/>, whose
/// bytes the stock library writes; a result the stock library read, written in Bead's proto JSON
/// form (5.6), one sequence of bytes on every side, or refused (5.7). <c>JsonParser</c> and
/// <c>JsonFormatter</c> are never called. An <c>Any</c> holds a message of the definitions it was
/// built over, or a well-known type.
/// </summary>
public sealed partial class JsonForm
{
    // how deep a message nests below the request or the result, as spec 17.9.3 counts one
    private const int Depth = 100;

    // a JSON number's value past this magnitude, or under its inverse, is no integer of any type's
    // range, and is never built: an exponent alone builds no number of its own
    private const int Magnitude = 40;

    private const string Protobuf = "google.protobuf.";

    // the well-known types whose JSON is a form of their own, which an Any holds under `value` (5.4, item 6)
    private static readonly HashSet<string> OwnForms = new(StringComparer.Ordinal)
    {
        Timestamp.Descriptor.FullName,
        Duration.Descriptor.FullName,
        FieldMask.Descriptor.FullName,
        Struct.Descriptor.FullName,
        Value.Descriptor.FullName,
        ListValue.Descriptor.FullName,
        Any.Descriptor.FullName,
        DoubleValue.Descriptor.FullName,
        FloatValue.Descriptor.FullName,
        Int64Value.Descriptor.FullName,
        UInt64Value.Descriptor.FullName,
        Int32Value.Descriptor.FullName,
        UInt32Value.Descriptor.FullName,
        BoolValue.Descriptor.FullName,
        StringValue.Descriptor.FullName,
        BytesValue.Descriptor.FullName,
    };

    // ! read and written by their forms: an Empty's is `{}`, a message's own, yet no field of its reads
    private static readonly HashSet<string> WellKnown = new(OwnForms, StringComparer.Ordinal)
    {
        Empty.Descriptor.FullName,
    };

    private static readonly FileDescriptor[] WellKnownFiles =
    [
        Any.Descriptor.File,
        Duration.Descriptor.File,
        Empty.Descriptor.File,
        FieldMask.Descriptor.File,
        Struct.Descriptor.File,
        Timestamp.Descriptor.File,
        Int64Value.Descriptor.File,
    ];

    // a field by its JSON name or its proto name, each message's built once
    private static readonly ConcurrentDictionary<MessageDescriptor, Lookup> Lookups = new();

    // Timestamp's earliest and latest seconds, and a Duration's longest (5.4)
    private const long Earliest = -62_135_596_800;
    private const long Latest = 253_402_300_799;
    private const long Longest = 315_576_000_000;

    // ! the quiet NaN of a positive sign, as JavaScript and protobuf's other libraries write one: .NET's
    // own double.NaN has its sign bit set, which a message compared bit by bit tells apart
    private static readonly double QuietNaN = BitConverter.Int64BitsToDouble(0x7FF8_0000_0000_0000);
    private static readonly float QuietNaNFloat = BitConverter.Int32BitsToSingle(0x7FC0_0000);

    private readonly TypeRegistry _registry;

    /// <summary>
    /// A mapping whose <c>Any</c> holds a message of the files <paramref name="messages"/> are of, or
    /// of the files those import, or a well-known type.
    /// </summary>
    public JsonForm(IEnumerable<MessageDescriptor> messages)
    {
        ArgumentNullException.ThrowIfNull(messages);

        _registry = TypeRegistry.FromFiles([.. messages.Select((message) =>
        {
            return message.File;
        }).Concat(WellKnownFiles).Distinct()]);
    }

    /// <summary>
    /// <paramref name="body"/> read as transcoding 5.2 reads a <c>proto</c> request's: the message,
    /// or a <see cref="JsonFormException"/> saying why it is refused, which a gateway answers 400
    /// <c>PAYLOAD_UNDECODABLE</c>.
    /// </summary>
    public IMessage Read(MessageDescriptor descriptor, ReadOnlySpan<byte> body)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        return ReadMessage(descriptor, (JsonText.Read(body), 0));
    }

    /// <summary>
    /// <paramref name="message"/> written in Bead's proto JSON form (transcoding 5.6), in UTF-8, or a
    /// <see cref="JsonFormException"/> saying why 5.7 refuses it, which a gateway answers 500.
    /// </summary>
    public byte[] Write(IMessage message)
    {
        ArgumentNullException.ThrowIfNull(message);

        var writer = new Writer();

        WriteMessage(writer, (message, 0));

        return writer.Bytes;
    }

    /// <summary>
    /// The field <paramref name="fieldName"/> of <paramref name="message"/> written as 5.6 writes a
    /// field, at its default too, so that a body is always there (transcoding 5.8): a route's
    /// <c>response_body</c>.
    /// </summary>
    public byte[] WriteField(IMessage message, string fieldName)
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(fieldName);

        var field = message.Descriptor.FindFieldByName(fieldName)
            ?? throw new ArgumentException($"{message.Descriptor.FullName} has no field {fieldName}", nameof(fieldName));
        var writer = new Writer();

        if (field.IsMap || field.IsRepeated || field.FieldType != FieldType.Message || field.Accessor.HasValue(message))
        {
            WriteField(writer, (field, field.Accessor.GetValue(message), 0));
        }
        else
        {
            WriteSingle(writer, (field, DefaultOf(field), 0));
        }

        return writer.Bytes;
    }

    /// <summary>The JSON a request's message is read from, built by its binding: its node read as 5.2's steps 2 to 4.</summary>
    internal IMessage ReadNode(MessageDescriptor descriptor, JsonNode node)
    {
        return ReadMessage(descriptor, (node, 0));
    }

    /// <summary>A field of <paramref name="descriptor"/> by its JSON name or its proto name; none where none is named so.</summary>
    internal static FieldDescriptor? FieldNamed(MessageDescriptor descriptor, string name)
    {
        var lookup = LookupOf(descriptor);

        return lookup.ByJson.GetValueOrDefault(name) ?? lookup.ByName.GetValueOrDefault(name);
    }

    /// <summary>Whether a message is read and written by a form of its own, a well-known type's.</summary>
    internal static bool IsWellKnown(MessageDescriptor descriptor)
    {
        return WellKnown.Contains(descriptor.FullName);
    }

    private static Lookup LookupOf(MessageDescriptor descriptor)
    {
        return Lookups.GetOrAdd(descriptor, (each) =>
        {
            var byJson = new Dictionary<string, FieldDescriptor>(StringComparer.Ordinal);
            var byName = new Dictionary<string, FieldDescriptor>(StringComparer.Ordinal);

            foreach (var field in each.Fields.InFieldNumberOrder())
            {
                byJson.TryAdd(field.JsonName, field);
                byName.TryAdd(field.Name, field);
            }

            return new Lookup(byJson, byName);
        });
    }

    // ── Reading, transcoding 5.2 to 5.4 ───────────────────────────────────────────────────────────

    // a message nested `depth` below the request (5.2, steps 2 to 4)
    private IMessage ReadMessage(MessageDescriptor descriptor, (JsonNode Value, int Depth) at)
    {
        var (value, depth) = at;

        if (depth > Depth)
        {
            throw new JsonFormException("nested past 100");
        }

        if (IsWellKnown(descriptor))
        {
            return ReadForm(descriptor, at);
        }

        if (value.Kind != JsonNodeKind.Object)
        {
            throw new JsonFormException($"a {descriptor.Name} that is no object");
        }

        var message = descriptor.Parser.ParseFrom(ByteString.Empty);
        var named = new HashSet<int>();
        var oneofs = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (key, member) in value.Members)
        {
            var field = FieldNamed(descriptor, key) ?? throw new JsonFormException("a key no field names");

            if (!named.Add(field.FieldNumber))
            {
                throw new JsonFormException("a field by its two names");
            }

            // * null is its field's default, but where it is a value of its own: a Value's, a NullValue's
            if (member.Kind == JsonNodeKind.Null && !(!field.IsRepeated && IsNullable(field)))
            {
                continue;
            }

            if (field.RealContainingOneof is { } oneof && !oneofs.Add(oneof.Name))
            {
                throw new JsonFormException("two members of one oneof");
            }

            ReadField(message, (field, member, depth));
        }

        return message;
    }

    // whether an enum is closed, a proto2 file's, which takes no number its values do not number
    private static bool IsClosed(EnumDescriptor descriptor)
    {
        return ClosedFiles.GetOrAdd(descriptor.File, (file) =>
        {
            return file.ToProto().Syntax is "" or "proto2";
        });
    }

    private static readonly ConcurrentDictionary<FileDescriptor, bool> ClosedFiles = new();

    // whether a field's null is a value of its own: a google.protobuf.Value's, or a NullValue's
    private static bool IsNullable(FieldDescriptor field)
    {
        return (field.FieldType == FieldType.Message && field.MessageType.FullName == Value.Descriptor.FullName)
            || (field.FieldType == FieldType.Enum && field.EnumType.FullName == NullValueName);
    }

    private const string NullValueName = "google.protobuf.NullValue";

    private void ReadField(IMessage message, (FieldDescriptor Field, JsonNode Member, int Depth) read)
    {
        var (field, member, depth) = read;

        if (field.IsMap)
        {
            ReadMap(message, read);

            return;
        }

        if (field.IsRepeated)
        {
            if (member.Kind != JsonNodeKind.Array)
            {
                throw new JsonFormException("a repeated field that is no array");
            }

            var list = (IList)field.Accessor.GetValue(message);

            foreach (var item in member.Items)
            {
                if (item.Kind == JsonNodeKind.Null && !IsNullable(field))
                {
                    throw new JsonFormException("a null item");
                }

                list.Add(ReadSingle(field, (item, depth)));
            }

            return;
        }

        field.Accessor.SetValue(message, ReadSingle(field, (member, depth)));
    }

    private void ReadMap(IMessage message, (FieldDescriptor Field, JsonNode Member, int Depth) read)
    {
        var (field, member, depth) = read;

        if (member.Kind != JsonNodeKind.Object)
        {
            throw new JsonFormException("a map that is no object");
        }

        var keyField = field.MessageType.FindFieldByNumber(1);
        var valueField = field.MessageType.FindFieldByNumber(2);
        var map = (IDictionary)field.Accessor.GetValue(message);

        foreach (var (key, item) in member.Members)
        {
            var readKey = KeyOf(keyField, key);

            if (map.Contains(readKey))
            {
                throw new JsonFormException("two keys of one value");
            }

            if (item.Kind == JsonNodeKind.Null && !IsNullable(valueField))
            {
                throw new JsonFormException("a null value in a map");
            }

            // * a map's entry is a message (17.9.3)
            if (depth + 1 > Depth)
            {
                throw new JsonFormException("nested past 100");
            }

            map[readKey] = ReadSingle(valueField, (item, depth + 1));
        }
    }

    // one value of a field, as its type reads it: a wrapper's its value, as a field of one holds it
    private object ReadSingle(FieldDescriptor field, (JsonNode Value, int Depth) at)
    {
        var (value, depth) = at;

        switch (field.FieldType)
        {
            case FieldType.Message:
                var message = ReadMessage(field.MessageType, (value, depth + 1));

                // ! a field of a wrapper holds its value, never the wrapper, in Google.Protobuf's
                // generated code
                return field.MessageType.IsWrapper() ? message.Descriptor.FindFieldByNumber(1).Accessor.GetValue(message) : message;
            case FieldType.Enum:
                return ReadEnum(field.EnumType, value);
            default:
                return ReadScalar(field.FieldType, value);
        }
    }

    private static object ReadEnum(EnumDescriptor descriptor, JsonNode value)
    {
        if (descriptor.FullName == NullValueName && value.Kind == JsonNodeKind.Null)
        {
            return System.Enum.ToObject(descriptor.ClrType, 0);
        }

        if (value.Kind == JsonNodeKind.String)
        {
            var named = descriptor.FindValueByName(value.Text) ?? throw new JsonFormException($"no value of {descriptor.Name} of that name");

            return System.Enum.ToObject(descriptor.ClrType, named.Number);
        }

        if (value.Kind == JsonNodeKind.Number)
        {
            var (isInteger, exact) = ExactOf(value.Text);

            if (!isInteger)
            {
                throw new JsonFormException("an enum number that is no integer");
            }

            if (exact < int.MinValue || exact > int.MaxValue)
            {
                throw new JsonFormException("an enum number past the 32-bit range");
            }

            // * an open enum takes a number no value numbers, as every enum of proto3 is
            if (IsClosed(descriptor) && descriptor.FindValueByNumber((int)exact) is null)
            {
                throw new JsonFormException($"no value of {descriptor.Name} of that number");
            }

            return System.Enum.ToObject(descriptor.ClrType, (int)exact);
        }

        throw new JsonFormException($"no {descriptor.Name}");
    }

    private static object ReadScalar(FieldType type, JsonNode value)
    {
        switch (type)
        {
            case FieldType.Int32:
            case FieldType.SInt32:
            case FieldType.SFixed32:
                return (int)ReadInteger(value, (type, int.MinValue, int.MaxValue));
            case FieldType.UInt32:
            case FieldType.Fixed32:
                return (uint)ReadInteger(value, (type, uint.MinValue, uint.MaxValue));
            case FieldType.Int64:
            case FieldType.SInt64:
            case FieldType.SFixed64:
                return (long)ReadInteger(value, (type, long.MinValue, long.MaxValue));
            case FieldType.UInt64:
            case FieldType.Fixed64:
                return (ulong)ReadInteger(value, (type, ulong.MinValue, ulong.MaxValue));
            case FieldType.Float:
                var wide = ReadFloat(value, "float");
                var narrow = double.IsNaN(wide) ? QuietNaNFloat : (float)wide;

                // * the 32-bit float nearest the double, a tie to the even, refused past its largest
                if (float.IsInfinity(narrow) && double.IsFinite(wide))
                {
                    throw new JsonFormException("a float past its range");
                }

                return narrow;
            case FieldType.Double:
                return ReadFloat(value, "double");
            case FieldType.Bool:
                return value.Kind switch
                {
                    JsonNodeKind.True => true,
                    JsonNodeKind.False => false,
                    _ => throw new JsonFormException("no bool"),
                };
            case FieldType.String:
                return value.Kind == JsonNodeKind.String ? value.Text : throw new JsonFormException("no string");
            case FieldType.Bytes:
                return ReadBytes(value);
            default:
                throw new JsonFormException($"no form for a {type}");
        }
    }

    private static bool Is64(FieldType type)
    {
        return type is FieldType.Int64 or FieldType.SInt64 or FieldType.SFixed64 or FieldType.UInt64 or FieldType.Fixed64;
    }

    // the article an integer type's name takes, as it is read aloud: an int32, a uint32, a fixed32
    private static string ArticleOf(string name)
    {
        return name[0] is 'a' or 'i' or 's' ? "an" : "a";
    }

    private static string NameOf(FieldType type)
    {
        return type switch
        {
            FieldType.SInt32 => "sint32",
            FieldType.SFixed32 => "sfixed32",
            FieldType.UInt32 => "uint32",
            FieldType.Fixed32 => "fixed32",
            FieldType.Int64 => "int64",
            FieldType.SInt64 => "sint64",
            FieldType.SFixed64 => "sfixed64",
            FieldType.UInt64 => "uint64",
            FieldType.Fixed64 => "fixed64",
            _ => "int32",
        };
    }

    private static BigInteger ReadInteger(JsonNode value, (FieldType Type, BigInteger Low, BigInteger High) range)
    {
        var name = NameOf(range.Type);
        BigInteger exact;

        // * a 64-bit integer's string is its decimal alone, a 32-bit one's any JSON number (5.3)
        if (Is64(range.Type) && value.Kind == JsonNodeKind.String)
        {
            if (!Decimal().IsMatch(value.Text))
            {
                throw new JsonFormException($"{ArticleOf(name)} {name} string off -?(0|[1-9][0-9]*)");
            }

            exact = BigInteger.Parse(value.Text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }
        else if (value.Kind == JsonNodeKind.Number || (value.Kind == JsonNodeKind.String && JsonNumber().IsMatch(value.Text)))
        {
            var (isInteger, read) = ExactOf(value.Text);

            if (!isInteger)
            {
                throw new JsonFormException($"{ArticleOf(name)} {name} that is no integer");
            }

            exact = read;
        }
        else
        {
            throw new JsonFormException($"no {name}");
        }

        if (exact < range.Low || exact > range.High)
        {
            throw new JsonFormException($"{ArticleOf(name)} {name} past its range");
        }

        return exact;
    }

    private static double ReadFloat(JsonNode value, string name)
    {
        if (value.Kind == JsonNodeKind.String)
        {
            switch (value.Text)
            {
                case "NaN":
                    return QuietNaN;
                case "Infinity":
                    return double.PositiveInfinity;
                case "-Infinity":
                    return double.NegativeInfinity;
                default:
                    if (!JsonNumber().IsMatch(value.Text))
                    {
                        throw new JsonFormException($"no {name}");
                    }

                    break;
            }
        }
        else if (value.Kind != JsonNodeKind.Number)
        {
            throw new JsonFormException($"no {name}");
        }

        // * the double nearest its digits, a tie to the even (spec 17.6)
        var read = double.Parse(value.Text, NumberStyles.Float, CultureInfo.InvariantCulture);

        if (!double.IsFinite(read))
        {
            throw new JsonFormException("a number past a double");
        }

        return read;
    }

    // base64 of one alphabet, padded correctly or not at all, its pad bits whatever they are (5.3, item 6)
    private static ByteString ReadBytes(JsonNode value)
    {
        if (value.Kind != JsonNodeKind.String)
        {
            throw new JsonFormException("no bytes");
        }

        var text = value.Text;
        var body = text.TrimEnd('=');
        var pads = text.Length - body.Length;

        if (!(Standard().IsMatch(body) || UrlSafe().IsMatch(body)))
        {
            throw new JsonFormException("bytes of no one alphabet of base64");
        }

        var missing = (4 - (body.Length % 4)) % 4;

        if (body.Length % 4 == 1 || (pads != 0 && pads != missing))
        {
            throw new JsonFormException("bytes padded wrongly");
        }

        var standard = body.Replace('-', '+').Replace('_', '/');
        var bits = standard.Length * 6;
        var bytes = new byte[bits / 8];
        var accumulator = 0;
        var held = 0;
        var at = 0;

        // ! by hand: Convert.FromBase64String refuses pad bits that are not zero, which 5.3 takes
        foreach (var character in standard)
        {
            accumulator = (accumulator << 6) | SextetOf(character);
            held += 6;

            if (held >= 8)
            {
                held -= 8;
                bytes[at] = (byte)(accumulator >> held);
                at += 1;
                accumulator &= (1 << held) - 1;
            }
        }

        return ByteString.CopyFrom(bytes);
    }

    private static int SextetOf(char character)
    {
        return character switch
        {
            >= 'A' and <= 'Z' => character - 'A',
            >= 'a' and <= 'z' => character - 'a' + 26,
            >= '0' and <= '9' => character - '0' + 52,
            '+' => 62,
            _ => 63,
        };
    }

    // a map's key, its key's form (5.3, item 8)
    private static object KeyOf(FieldDescriptor field, string key)
    {
        switch (field.FieldType)
        {
            case FieldType.String:
                return key;
            case FieldType.Bool:
                return key switch
                {
                    "true" => true,
                    "false" => false,
                    _ => throw new JsonFormException("a bool key that is neither true nor false"),
                };
            default:
                var name = NameOf(field.FieldType);

                if (!Decimal().IsMatch(key))
                {
                    throw new JsonFormException($"{ArticleOf(name)} {name} key off -?(0|[1-9][0-9]*)");
                }

                var number = BigInteger.Parse(key, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
                var (low, high) = field.FieldType switch
                {
                    FieldType.UInt32 or FieldType.Fixed32 => ((BigInteger)uint.MinValue, (BigInteger)uint.MaxValue),
                    FieldType.Int64 or FieldType.SInt64 or FieldType.SFixed64 => (long.MinValue, long.MaxValue),
                    FieldType.UInt64 or FieldType.Fixed64 => (ulong.MinValue, ulong.MaxValue),
                    _ => (int.MinValue, int.MaxValue),
                };

                if (number < low || number > high)
                {
                    throw new JsonFormException($"{ArticleOf(name)} {name} key past its range");
                }

                return field.FieldType switch
                {
                    FieldType.UInt32 or FieldType.Fixed32 => (object)(uint)number,
                    FieldType.Int64 or FieldType.SInt64 or FieldType.SFixed64 => (long)number,
                    FieldType.UInt64 or FieldType.Fixed64 => (ulong)number,
                    _ => (int)number,
                };
        }
    }

    /// <summary>
    /// A JSON number's value read exactly from its digits: whether it is an integer, and which; one
    /// whose magnitude is past 10^40 an integer of no type's range, one under 10^-40 none.
    /// </summary>
    internal static (bool IsInteger, BigInteger Value) ExactOf(string text)
    {
        var at = 0;
        var isNegative = text.StartsWith('-');

        if (isNegative)
        {
            at = 1;
        }

        var exponentAt = text.IndexOfAny(['e', 'E']);
        var mantissa = exponentAt < 0 ? text[at..] : text[at..exponentAt];
        var exponentText = exponentAt < 0 ? "0" : text[(exponentAt + 1)..];
        var point = mantissa.IndexOf('.', StringComparison.Ordinal);
        var digits = point < 0 ? mantissa : mantissa[..point] + mantissa[(point + 1)..];
        var fraction = point < 0 ? 0 : mantissa.Length - point - 1;
        var stripped = digits.TrimStart('0');

        if (stripped.Length == 0)
        {
            return (true, BigInteger.Zero);
        }

        // ! an exponent of many digits is past every magnitude: read whole, it builds nothing
        var exponent = BigInteger.Parse(exponentText, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) - fraction;
        var adjusted = exponent + stripped.Length - 1;

        if (adjusted > Magnitude)
        {
            return (true, BigInteger.Pow(2, 80));
        }

        if (adjusted < -Magnitude)
        {
            return (false, BigInteger.Zero);
        }

        var whole = BigInteger.Parse(stripped, NumberStyles.None, CultureInfo.InvariantCulture);
        var power = (int)exponent;

        if (power < 0)
        {
            var divisor = BigInteger.Pow(10, -power);

            if (!(whole % divisor).IsZero)
            {
                return (false, BigInteger.Zero);
            }

            whole /= divisor;
        }
        else
        {
            whole *= BigInteger.Pow(10, power);
        }

        return (true, isNegative ? -whole : whole);
    }

    // a well-known type's form (5.4), the message itself nested `depth` below the request
    private IMessage ReadForm(MessageDescriptor descriptor, (JsonNode Value, int Depth) at)
    {
        var (value, depth) = at;

        switch (descriptor.FullName)
        {
            case "google.protobuf.Timestamp":
                return ReadTimestamp(value);
            case "google.protobuf.Duration":
                return ReadDuration(value);
            case "google.protobuf.FieldMask":
                return ReadFieldMask(value);
            case "google.protobuf.Empty":
                if (value.Kind != JsonNodeKind.Object)
                {
                    throw new JsonFormException("an Empty that is no object");
                }

                return value.Members.Count == 0 ? new Empty() : throw new JsonFormException("a key no field names");
            case "google.protobuf.Struct":
                if (value.Kind != JsonNodeKind.Object)
                {
                    throw new JsonFormException("a Struct that is no object");
                }

                if (value.Members.Count > 0 && depth + 1 > Depth)
                {
                    throw new JsonFormException("nested past 100");
                }

                var fields = new Struct();

                foreach (var (key, member) in value.Members)
                {
                    fields.Fields[key] = (Value)ReadMessage(Value.Descriptor, (member, depth + 2));
                }

                return fields;
            case "google.protobuf.ListValue":
                if (value.Kind != JsonNodeKind.Array)
                {
                    throw new JsonFormException("a ListValue that is no array");
                }

                var list = new ListValue();

                foreach (var item in value.Items)
                {
                    list.Values.Add((Value)ReadMessage(Value.Descriptor, (item, depth + 1)));
                }

                return list;
            case "google.protobuf.Value":
                return ReadValue(value, depth);
            case "google.protobuf.Any":
                return ReadAny(value, depth);
            default:
                // a wrapper: its value's form
                var wrapper = descriptor.Parser.ParseFrom(ByteString.Empty);
                var inner = descriptor.FindFieldByNumber(1);

                inner.Accessor.SetValue(wrapper, ReadScalar(inner.FieldType, value));

                return wrapper;
        }
    }

    private Value ReadValue(JsonNode value, int depth)
    {
        return value.Kind switch
        {
            JsonNodeKind.Null => Value.ForNull(),
            JsonNodeKind.True => Value.ForBool(true),
            JsonNodeKind.False => Value.ForBool(false),
            JsonNodeKind.Number => Value.ForNumber(double.Parse(value.Text, NumberStyles.Float, CultureInfo.InvariantCulture)),
            JsonNodeKind.String => Value.ForString(value.Text),
            JsonNodeKind.Object => new Value { StructValue = (Struct)ReadMessage(Struct.Descriptor, (value, depth + 1)) },
            _ => new Value { ListValue = (ListValue)ReadMessage(ListValue.Descriptor, (value, depth + 1)) },
        };
    }

    // an Any (5.4, item 6): its @type anywhere among its members, then its message's members, or a
    // well-known type's form under value alone; {} alone the empty Any
    private Any ReadAny(JsonNode value, int depth)
    {
        if (value.Kind != JsonNodeKind.Object)
        {
            throw new JsonFormException("an Any that is no object");
        }

        if (value.Members.Count == 0)
        {
            return new Any();
        }

        var type = value.Members.FirstOrDefault((member) =>
        {
            return member.Key == "@type";
        });

        if (type.Key is null)
        {
            throw new JsonFormException("an Any without its @type");
        }

        if (type.Value.Kind != JsonNodeKind.String || !type.Value.Text.Contains('/', StringComparison.Ordinal))
        {
            throw new JsonFormException("an Any whose @type is no URL");
        }

        var url = type.Value.Text;
        var held = _registry.Find(url[(url.LastIndexOf('/') + 1)..]) ?? throw new JsonFormException("an Any of a type its definitions do not hold");
        var others = value.Members.Where((member) =>
        {
            return member.Key != "@type";
        }).ToList();
        IMessage inner;

        if (OwnForms.Contains(held.FullName))
        {
            if (others.Count != 1 || others[0].Key != "value")
            {
                throw new JsonFormException("an Any of a well-known type whose members are not its value alone");
            }

            inner = ReadMessage(held, (others[0].Value, depth + 1));
        }
        else
        {
            inner = ReadMessage(held, (JsonNode.ObjectOf(others), depth + 1));
        }

        return new Any { TypeUrl = url, Value = inner.ToByteString() };
    }

    private static Timestamp ReadTimestamp(JsonNode value)
    {
        var found = value.Kind == JsonNodeKind.String ? TimestampForm().Match(value.Text) : null;

        if (found is not { Success: true })
        {
            throw new JsonFormException("a Timestamp off RFC 3339");
        }

        int PartOf(int group)
        {
            return int.Parse(found.Groups[group].ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture);
        }

        var (year, month, day) = (PartOf(1), PartOf(2), PartOf(3));
        var (hour, minute, second) = (PartOf(4), PartOf(5), PartOf(6));

        if (month is < 1 or > 12 || day < 1 || day > DaysIn(year, month) || hour > 23 || minute > 59 || second > 59)
        {
            throw new JsonFormException("a Timestamp of no instant");
        }

        var zone = found.Groups[8].Value;
        var offset = 0L;

        if (zone != "Z")
        {
            var (hours, minutes) = (int.Parse(zone.AsSpan(1, 2), CultureInfo.InvariantCulture), int.Parse(zone.AsSpan(4, 2), CultureInfo.InvariantCulture));

            if (hours > 23 || minutes > 59)
            {
                throw new JsonFormException("a Timestamp of no offset");
            }

            offset = ((hours * 3600) + (minutes * 60)) * (zone[0] == '+' ? 1 : -1);
        }

        var seconds = (DaysFromCivil(year, month, day) * 86_400) + (hour * 3600) + (minute * 60) + second - offset;

        if (seconds is < Earliest or > Latest)
        {
            throw new JsonFormException("a Timestamp past its range");
        }

        return new Timestamp { Seconds = seconds, Nanos = NanosOf(found.Groups[7].Value) };
    }

    private static Duration ReadDuration(JsonNode value)
    {
        var found = value.Kind == JsonNodeKind.String ? DurationForm().Match(value.Text) : null;

        if (found is not { Success: true })
        {
            throw new JsonFormException("a Duration off its form");
        }

        var sign = found.Groups[1].Success ? -1 : 1;

        // ! its seconds' digits may be many: read whole, compared before they are narrowed
        var seconds = BigInteger.Parse(found.Groups[2].ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture);

        if (seconds > Longest)
        {
            throw new JsonFormException("a Duration past its range");
        }

        return new Duration { Seconds = sign * (long)seconds, Nanos = sign * NanosOf(found.Groups[3].Value) };
    }

    private static int NanosOf(string fraction)
    {
        return fraction.Length == 0 ? 0 : int.Parse(fraction.PadRight(9, '0'), NumberStyles.None, CultureInfo.InvariantCulture);
    }

    private static FieldMask ReadFieldMask(JsonNode value)
    {
        if (value.Kind != JsonNodeKind.String)
        {
            throw new JsonFormException("a FieldMask that is no string");
        }

        var mask = new FieldMask();

        if (value.Text.Length == 0)
        {
            return mask;
        }

        foreach (var path in value.Text.Split(','))
        {
            if (path.Length == 0)
            {
                throw new JsonFormException("a FieldMask of an empty path");
            }

            var segments = path.Split('.');

            if (segments.Any((segment) =>
            {
                return !CamelSegment().IsMatch(segment);
            }))
            {
                throw new JsonFormException("a FieldMask path off lowerCamelCase");
            }

            var snake = string.Join('.', segments.Select(SnakeOf));

            if (CamelOf(snake) != path)
            {
                throw new JsonFormException("a FieldMask path that does not read back");
            }

            mask.Paths.Add(snake);
        }

        return mask;
    }

    // a lowerCamelCase segment's snake case: each upper-case letter `_` and its lower case
    private static string SnakeOf(string segment)
    {
        var snake = new StringBuilder(segment.Length + 4);

        foreach (var character in segment)
        {
            if (char.IsAsciiLetterUpper(character))
            {
                snake.Append('_').Append(char.ToLowerInvariant(character));
            }
            else
            {
                snake.Append(character);
            }
        }

        return snake.ToString();
    }

    // a path's lowerCamelCase: each underscore dropped, a lower-case letter after it raised
    private static string CamelOf(string path)
    {
        var camel = new StringBuilder(path.Length);
        var isRaised = false;

        foreach (var character in path)
        {
            if (character == '_')
            {
                isRaised = true;

                continue;
            }

            camel.Append(isRaised && char.IsAsciiLetterLower(character) ? char.ToUpperInvariant(character) : character);
            isRaised = false;
        }

        return camel.ToString();
    }

    private static int DaysIn(int year, int month)
    {
        if (month == 2)
        {
            return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28;
        }

        return month is 4 or 6 or 9 or 11 ? 30 : 31;
    }

    // days since 1970-01-01 of a date of the proleptic Gregorian calendar (Hinnant's algorithm)
    private static long DaysFromCivil(long year, long month, long day)
    {
        year -= month <= 2 ? 1 : 0;

        var era = (year >= 0 ? year : year - 399) / 400;
        var ofEra = year - (era * 400);
        var ofYear = ((153 * (month + (month > 2 ? -3 : 9))) + 2) / 5 + day - 1;
        var ofEraDays = (ofEra * 365) + (ofEra / 4) - (ofEra / 100) + ofYear;

        return (era * 146_097) + ofEraDays - 719_468;
    }

    // a date from days since 1970-01-01 (Hinnant's algorithm)
    private static (long Year, long Month, long Day) CivilFromDays(long days)
    {
        days += 719_468;

        var era = (days >= 0 ? days : days - 146_096) / 146_097;
        var ofEra = days - (era * 146_097);
        var yearOfEra = (ofEra - (ofEra / 1460) + (ofEra / 36_524) - (ofEra / 146_096)) / 365;
        var year = yearOfEra + (era * 400);
        var ofYear = ofEra - ((365 * yearOfEra) + (yearOfEra / 4) - (yearOfEra / 100));
        var shifted = ((5 * ofYear) + 2) / 153;
        var day = ofYear - (((153 * shifted) + 2) / 5) + 1;
        var month = shifted + (shifted < 10 ? 3 : -9);

        return (year + (month <= 2 ? 1 : 0), month, day);
    }

    // ── Writing, Bead's proto JSON form, transcoding 5.6 and 5.7 ───────────────────────────────────

    // a message's JSON, nested `depth` below the result
    private void WriteMessage(Writer writer, (IMessage Message, int Depth) at)
    {
        var (message, depth) = at;

        if (depth > Depth)
        {
            throw new JsonFormException("a message nested past 100");
        }

        if (IsWellKnown(message.Descriptor))
        {
            WriteForm(writer, at);

            return;
        }

        writer.Append('{');

        var isFirst = true;

        foreach (var field in message.Descriptor.Fields.InFieldNumberOrder())
        {
            var value = field.Accessor.GetValue(message);

            if (IsLeftOut(field, (message, value)))
            {
                continue;
            }

            if (!isFirst)
            {
                writer.Append(',');
            }

            isFirst = false;
            writer.String(field.JsonName);
            writer.Append(':');
            WriteField(writer, (field, value, depth));
        }

        writer.Append('}');
    }

    // whether a field is left out: one of no presence of its own at its default, -0 among them, a
    // repeated field or a map that holds nothing, one of presence where it is not set (5.6, item 3)
    private static bool IsLeftOut(FieldDescriptor field, (IMessage Message, object? Value) held)
    {
        if (field.IsMap || field.IsRepeated)
        {
            return ((ICollection)held.Value!).Count == 0;
        }

        if (field.HasPresence)
        {
            return !field.Accessor.HasValue(held.Message);
        }

        return held.Value switch
        {
            null => true,
            int number => number == 0,
            uint number => number == 0,
            long number => number == 0,
            ulong number => number == 0,
            float number => number == 0,
            double number => number == 0,
            bool flag => !flag,
            string text => text.Length == 0,
            ByteString bytes => bytes.IsEmpty,
            System.Enum number => Convert.ToInt32(number, CultureInfo.InvariantCulture) == 0,
            _ => false,
        };
    }

    private void WriteField(Writer writer, (FieldDescriptor Field, object? Value, int Depth) at)
    {
        var (field, value, depth) = at;

        if (field.IsMap)
        {
            var keyField = field.MessageType.FindFieldByNumber(1);
            var valueField = field.MessageType.FindFieldByNumber(2);
            var entries = new List<(string Key, object? Value)>();

            foreach (DictionaryEntry entry in (IDictionary)value!)
            {
                entries.Add((KeyTextOf(keyField, entry.Key), entry.Value));
            }

            // * sorted by their keys' UTF-16 code units, as 17.7.6 sorts an object's members
            entries.Sort((one, other) =>
            {
                return string.CompareOrdinal(one.Key, other.Key);
            });
            writer.Append('{');

            for (var index = 0; index < entries.Count; index += 1)
            {
                if (index > 0)
                {
                    writer.Append(',');
                }

                writer.String(entries[index].Key);
                writer.Append(':');
                WriteSingle(writer, (valueField, entries[index].Value, depth + 1));
            }

            writer.Append('}');

            return;
        }

        if (field.IsRepeated)
        {
            writer.Append('[');

            var isFirst = true;

            foreach (var item in (IList)value!)
            {
                if (!isFirst)
                {
                    writer.Append(',');
                }

                isFirst = false;
                WriteSingle(writer, (field, item, depth));
            }

            writer.Append(']');

            return;
        }

        WriteSingle(writer, (field, value, depth));
    }

    private static string KeyTextOf(FieldDescriptor field, object key)
    {
        return key switch
        {
            bool flag => flag ? "true" : "false",
            string text => text,
            _ => Convert.ToString(key, CultureInfo.InvariantCulture)!,
        };
    }

    // one value of a field: a message's, a wrapper's as its value, an enum's, a scalar's
    private void WriteSingle(Writer writer, (FieldDescriptor Field, object? Value, int Depth) at)
    {
        var (field, value, depth) = at;

        switch (field.FieldType)
        {
            case FieldType.Message when field.MessageType.IsWrapper():
                WriteScalar(writer, (field.MessageType.FindFieldByNumber(1).FieldType, value));
                break;
            case FieldType.Message:
                WriteMessage(writer, ((IMessage)value!, depth + 1));
                break;
            case FieldType.Enum:
                WriteEnum(writer, (field.EnumType, Convert.ToInt32(value, CultureInfo.InvariantCulture)));
                break;
            default:
                WriteScalar(writer, (field.FieldType, value));
                break;
        }
    }

    // an enum by the name of its value declared first for its number, by its number where none is (5.6, item 5)
    private static void WriteEnum(Writer writer, (EnumDescriptor Descriptor, int Number) at)
    {
        var (descriptor, number) = at;

        if (descriptor.FullName == NullValueName)
        {
            writer.Append("null");

            return;
        }

        var named = descriptor.Values.FirstOrDefault((value) =>
        {
            return value.Number == number;
        });

        if (named is null)
        {
            writer.Append(number.ToString(CultureInfo.InvariantCulture));
        }
        else
        {
            writer.String(named.Name);
        }
    }

    private static void WriteScalar(Writer writer, (FieldType Type, object? Value) at)
    {
        var (type, value) = at;

        switch (type)
        {
            case FieldType.Int64:
            case FieldType.SInt64:
            case FieldType.SFixed64:
            case FieldType.UInt64:
            case FieldType.Fixed64:
                writer.Append('"');
                writer.Append(Convert.ToString(value ?? 0, CultureInfo.InvariantCulture)!);
                writer.Append('"');
                break;
            case FieldType.Float:
                var narrow = value is float held ? held : 0F;

                writer.Append(NotFiniteOf(narrow) ?? Payloads.NumberText(narrow));
                break;
            case FieldType.Double:
                var wide = value is double given ? given : 0D;

                writer.Append(NotFiniteOf(wide) ?? Payloads.NumberText(wide));
                break;
            case FieldType.Bool:
                writer.Append(value is true ? "true" : "false");
                break;
            case FieldType.String:
                writer.String((string?)value ?? "");
                break;
            case FieldType.Bytes:
                writer.Append('"');
                writer.Append(Convert.ToBase64String(((ByteString?)value ?? ByteString.Empty).Span));
                writer.Append('"');
                break;
            default:
                writer.Append(Convert.ToString(value ?? 0, CultureInfo.InvariantCulture)!);
                break;
        }
    }

    // a value that is not finite as its string (5.6, item 6); none for one that is
    private static string? NotFiniteOf(double value)
    {
        if (double.IsNaN(value))
        {
            return "\"NaN\"";
        }

        if (double.IsInfinity(value))
        {
            return value > 0 ? "\"Infinity\"" : "\"-Infinity\"";
        }

        return null;
    }

    // a well-known type's form (5.6, item 7)
    private void WriteForm(Writer writer, (IMessage Message, int Depth) at)
    {
        var (message, depth) = at;

        switch (message)
        {
            case Timestamp timestamp:
                WriteTimestamp(writer, timestamp);
                break;
            case Duration duration:
                WriteDuration(writer, duration);
                break;
            case FieldMask mask:
                WriteFieldMask(writer, mask);
                break;
            case Empty:
                writer.Append("{}");
                break;
            case Struct fields:
                if (fields.Fields.Count > 0 && depth + 1 > Depth)
                {
                    throw new JsonFormException("a message nested past 100");
                }

                writer.Append('{');

                var isFirst = true;

                foreach (var (key, member) in fields.Fields.OrderBy((member) =>
                {
                    return member.Key;
                }, StringComparer.Ordinal))
                {
                    if (!isFirst)
                    {
                        writer.Append(',');
                    }

                    isFirst = false;
                    writer.String(key);
                    writer.Append(':');
                    WriteMessage(writer, (member, depth + 2));
                }

                writer.Append('}');
                break;
            case ListValue list:
                writer.Append('[');

                for (var index = 0; index < list.Values.Count; index += 1)
                {
                    if (index > 0)
                    {
                        writer.Append(',');
                    }

                    WriteMessage(writer, (list.Values[index], depth + 1));
                }

                writer.Append(']');
                break;
            case Value value:
                WriteValue(writer, (value, depth));
                break;
            case Any any:
                WriteAny(writer, (any, depth));
                break;
            default:
                // a wrapper: its value, at its default too
                var inner = message.Descriptor.FindFieldByNumber(1);

                WriteScalar(writer, (inner.FieldType, inner.Accessor.GetValue(message)));
                break;
        }
    }

    private void WriteValue(Writer writer, (Value Value, int Depth) at)
    {
        var (value, depth) = at;

        switch (value.KindCase)
        {
            case Value.KindOneofCase.NullValue:
                writer.Append("null");
                break;
            case Value.KindOneofCase.NumberValue:
                if (!double.IsFinite(value.NumberValue))
                {
                    throw new JsonFormException("a Value whose number is not finite");
                }

                writer.Append(Payloads.NumberText(value.NumberValue));
                break;
            case Value.KindOneofCase.StringValue:
                writer.String(value.StringValue);
                break;
            case Value.KindOneofCase.BoolValue:
                writer.Append(value.BoolValue ? "true" : "false");
                break;
            case Value.KindOneofCase.StructValue:
                WriteMessage(writer, (value.StructValue, depth + 1));
                break;
            case Value.KindOneofCase.ListValue:
                WriteMessage(writer, (value.ListValue, depth + 1));
                break;
            default:
                throw new JsonFormException("a Value that holds no kind");
        }
    }

    // an Any: its @type first, then its message's members or its value (5.6, item 2)
    private void WriteAny(Writer writer, (Any Any, int Depth) at)
    {
        var (any, depth) = at;

        if (any.TypeUrl.Length == 0 && any.Value.IsEmpty)
        {
            writer.Append("{}");

            return;
        }

        var url = any.TypeUrl;
        var held = url.Contains('/', StringComparison.Ordinal) ? _registry.Find(url[(url.LastIndexOf('/') + 1)..]) : null;

        if (held is null)
        {
            throw new JsonFormException("an Any whose type its definitions do not hold");
        }

        IMessage inner;

        try
        {
            inner = held.Parser.ParseFrom(any.Value);
        }
        catch (InvalidProtocolBufferException reason)
        {
            throw new JsonFormException("an Any whose bytes do not read as its type", reason);
        }

        var written = new Writer();

        WriteMessage(written, (inner, depth + 1));
        writer.Append('{');
        writer.String("@type");
        writer.Append(':');
        writer.String(url);

        if (OwnForms.Contains(held.FullName))
        {
            writer.Append(',');
            writer.String("value");
            writer.Append(':');
            writer.Append(written.Bytes);
            writer.Append('}');

            return;
        }

        var members = written.Bytes;

        // * its message's members after the @type, an Empty's none
        if (members.Length > 2)
        {
            writer.Append(',');
        }

        writer.Append(members.AsSpan(1));
    }

    private static void WriteTimestamp(Writer writer, Timestamp timestamp)
    {
        if (timestamp.Seconds is < Earliest or > Latest || timestamp.Nanos is < 0 or > 999_999_999)
        {
            throw new JsonFormException("a Timestamp outside its range");
        }

        var days = Math.DivRem(timestamp.Seconds, 86_400, out var within);

        if (within < 0)
        {
            days -= 1;
            within += 86_400;
        }

        var (year, month, day) = CivilFromDays(days);
        var text = string.Create(CultureInfo.InvariantCulture, $"\"{year:0000}-{month:00}-{day:00}T{within / 3600:00}:{within % 3600 / 60:00}:{within % 60:00}{FractionOf(timestamp.Nanos)}Z\"");

        writer.Append(text);
    }

    private static void WriteDuration(Writer writer, Duration duration)
    {
        var (seconds, nanos) = (duration.Seconds, duration.Nanos);

        if (Math.Abs(seconds) > Longest || Math.Abs(nanos) > 999_999_999 || (seconds > 0 && nanos < 0) || (seconds < 0 && nanos > 0))
        {
            throw new JsonFormException("a Duration outside its range");
        }

        var sign = seconds < 0 || nanos < 0 ? "-" : "";

        writer.Append(string.Create(CultureInfo.InvariantCulture, $"\"{sign}{Math.Abs(seconds)}{FractionOf(Math.Abs(nanos))}s\""));
    }

    // 0, 3, 6 or 9 fraction digits, the fewest that hold a count of nanoseconds (5.6, item 7)
    private static string FractionOf(int nanos)
    {
        if (nanos == 0)
        {
            return "";
        }

        if (nanos % 1_000_000 == 0)
        {
            return "." + (nanos / 1_000_000).ToString("000", CultureInfo.InvariantCulture);
        }

        if (nanos % 1_000 == 0)
        {
            return "." + (nanos / 1_000).ToString("000000", CultureInfo.InvariantCulture);
        }

        return "." + nanos.ToString("000000000", CultureInfo.InvariantCulture);
    }

    private static void WriteFieldMask(Writer writer, FieldMask mask)
    {
        var paths = new List<string>(mask.Paths.Count);

        foreach (var path in mask.Paths)
        {
            var camel = CamelOf(path);

            if (string.Join('.', camel.Split('.').Select(SnakeOf)) != path)
            {
                throw new JsonFormException("a FieldMask path whose lowerCamelCase does not read back");
            }

            paths.Add(camel);
        }

        writer.String(string.Join(',', paths));
    }

    // a field's value where it is not set: its type's zero, an empty message's, for a response body
    private static object? DefaultOf(FieldDescriptor field)
    {
        return field.FieldType == FieldType.Message && !field.MessageType.IsWrapper()
            ? field.MessageType.Parser.ParseFrom(ByteString.Empty)
            : null;
    }

    [GeneratedRegex(@"\A-?(?:0|[1-9][0-9]*)\z", RegexOptions.CultureInvariant)]
    private static partial Regex Decimal();

    [GeneratedRegex(@"\A-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex JsonNumber();

    [GeneratedRegex(@"\A[A-Za-z0-9+/]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex Standard();

    [GeneratedRegex(@"\A[A-Za-z0-9_-]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex UrlSafe();

    [GeneratedRegex(@"\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})\z", RegexOptions.CultureInvariant)]
    private static partial Regex TimestampForm();

    [GeneratedRegex(@"\A(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?s\z", RegexOptions.CultureInvariant)]
    private static partial Regex DurationForm();

    [GeneratedRegex(@"\A[a-z][A-Za-z0-9]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex CamelSegment();

    // a message's fields by their two names
    private sealed record Lookup(Dictionary<string, FieldDescriptor> ByJson, Dictionary<string, FieldDescriptor> ByName);

    // what a write builds, in UTF-8: its tokens 17.7's, its strings' escapes the canonical form's
    private sealed class Writer
    {
        private readonly ArrayBufferWriter<byte> _written = new(256);

        public byte[] Bytes
        {
            get
            {
                return _written.WrittenSpan.ToArray();
            }
        }

        public void Append(char character)
        {
            _written.GetSpan(1)[0] = (byte)character;
            _written.Advance(1);
        }

        public void Append(string ascii)
        {
            var count = Encoding.UTF8.GetBytes(ascii, _written.GetSpan(Encoding.UTF8.GetMaxByteCount(ascii.Length)));

            _written.Advance(count);
        }

        public void Append(ReadOnlySpan<byte> bytes)
        {
            _written.Write(bytes);
        }

        public void String(string text)
        {
            _written.Write(Payloads.WriteJsonString(text).Span);
        }
    }
}

/// <summary>What the mapping asks of a message's descriptor that Google.Protobuf keeps to itself.</summary>
internal static class Descriptors
{
    /// <summary>Whether a message is one of <c>wrappers.proto</c>'s, which a field of holds its value alone.</summary>
    public static bool IsWrapper(this MessageDescriptor descriptor)
    {
        return descriptor.File == Int64Value.Descriptor.File;
    }
}
