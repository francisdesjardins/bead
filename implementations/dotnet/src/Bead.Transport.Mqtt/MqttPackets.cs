using System.Globalization;
using System.Text;

namespace Bead.Transport.Mqtt;

/// <summary>What a PUBLISH is counted at: its QoS, and whether it carries a Message Expiry Interval.</summary>
internal readonly record struct MqttPublishShape(int Qos, bool HasLife);

/// <summary>What a Reason Code of a PUBACK, a SUBACK or an UNSUBACK is (spec 15.27 to 15.29).</summary>
internal enum MqttAcknowledgementVerdict
{
    /// <summary>One its packet's table names, read as that table says.</summary>
    Named,

    /// <summary>One of 0x80 or more its table does not name, a refusal all the same (MQTT 5.0 §2.4, §4.13.2).</summary>
    Refusal,

    /// <summary>One under 0x80 its table does not name, a Protocol Error (MQTT 5.0 §4.13.1).</summary>
    Unreadable,
}

/// <summary>
/// The count of an MQTT 5 PUBLISH to its every byte (spec 15.30; MQTT 5.0 §2.1.4, §3.3.2), how a
/// broker's topic and a group's shared subscription are written (spec 15.25), and how a PUBACK, a
/// SUBACK or an UNSUBACK is judged by its Reason Codes (spec 15.27 to 15.29). Nothing here reaches
/// MQTTnet: the adapter counts each publication with it and judges each acknowledgement at MQTTnet's
/// packet inspector, and <c>spec/vectors.json</c>'s <c>mqttPublishBounds</c> and
/// <c>mqttAcknowledgementCodes</c> hold every side to it with no broker. The TypeScript side's
/// <c>mqtt-packets</c> counts alike.
/// </summary>
internal static class MqttPackets
{
    /// <summary>A PUBACK's fixed header's packet type (MQTT 5.0 §2.1.2).</summary>
    public const int PubAck = 4;

    /// <summary>A SUBACK's fixed header's packet type.</summary>
    public const int SubAck = 9;

    /// <summary>An UNSUBACK's fixed header's packet type.</summary>
    public const int UnsubAck = 11;

    // ! the tables of MQTT 5.0, code for code, which spec/vectors.json's mqttAcknowledgementCodes
    // holds: PUBACK §3.4.2.1, SUBACK §3.9.3 Table 3-8, UNSUBACK §3.11.3 Table 3-9
    private static readonly HashSet<int> PubAckCodes = [0x00, 0x10, 0x80, 0x83, 0x87, 0x90, 0x91, 0x97, 0x99];
    private static readonly HashSet<int> SubAckCodes = [0x00, 0x01, 0x02, 0x80, 0x83, 0x87, 0x8F, 0x91, 0x97, 0x9E, 0xA1, 0xA2];
    private static readonly HashSet<int> UnsubAckCodes = [0x00, 0x11, 0x80, 0x83, 0x87, 0x8F, 0x91];

    /// <summary>The largest Remaining Length a Variable Byte Integer holds (MQTT 5.0 §1.5.5).</summary>
    public const long LargestRemainingLength = 268_435_455;

    /// <summary>The largest packet MQTT 5 writes, the bound of a CONNACK that names none: 268,435,460 bytes.</summary>
    public const long LargestPacketSize = 1 + 4 + LargestRemainingLength;

    /// <summary>A participant's Maximum Packet Size, its CONNECT's, by default: 16 MiB (spec 15.30).</summary>
    public const long MaximumPacketSize = 16_777_216;

    // a Message Expiry Interval: its identifier and its Four Byte Integer (MQTT 5.0 §3.3.2.3.3)
    private const int ExpiryBytes = 5;

    /// <summary>The bytes of a Variable Byte Integer of <paramref name="value"/> (MQTT 5.0 §1.5.5).</summary>
    public static int WidthOf(long value)
    {
        if (value < 128)
        {
            return 1;
        }

        if (value < 16_384)
        {
            return 2;
        }

        return value < 2_097_152 ? 3 : 4;
    }

    /// <summary>A topic's tokens joined by <c>/</c>, as MQTT names it (spec 15.25): <c>bead/i/ada</c>.</summary>
    public static string TopicOf(IReadOnlyList<string> topic)
    {
        ArgumentNullException.ThrowIfNull(topic);

        return string.Join('/', topic);
    }

    /// <summary>
    /// The shared subscription a name served in a group is (spec 15.25; MQTT 5.0 §4.8.2): its share
    /// name the group, then the name's topic, <c>$share/interop/bead/s/interop</c>.
    /// </summary>
    public static string GroupFilterOf((string Group, IReadOnlyList<string> Topic) grouped)
    {
        return $"$share/{grouped.Group}/{TopicOf(grouped.Topic)}";
    }

    /// <summary>
    /// S, the bytes of a PUBLISH of <c>Payload</c> bytes to a topic of <c>TopicBytes</c> bytes in
    /// UTF-8, shaped as <paramref name="shape"/> says: its fixed header's byte, its Remaining Length's
    /// own bytes, and R (spec 15.30).
    /// </summary>
    public static long PublishBytes((long TopicBytes, long Payload) publish, MqttPublishShape shape)
    {
        var remaining = RemainingOf(publish, shape);

        return 1 + WidthOf(remaining) + remaining;
    }

    /// <summary>
    /// The largest payload of a PUBLISH to <c>Topic</c> within <c>Maximum</c> bytes, shaped as
    /// <paramref name="shape"/> says — at QoS 1, a life counted, for every bound the adapter keeps,
    /// whatever the message (spec 15.30) — or none where an empty one does not fit. Found by a
    /// search: S grows with N, and v(R) with it, so no overhead is fixed.
    /// </summary>
    public static long? LargestPayload((string Topic, long Maximum) bound, MqttPublishShape shape)
    {
        ArgumentNullException.ThrowIfNull(bound.Topic);

        var topicBytes = Encoding.UTF8.GetByteCount(bound.Topic);

        bool Fits(long payload)
        {
            return PublishBytes((topicBytes, payload), shape) <= bound.Maximum && RemainingOf((topicBytes, payload), shape) <= LargestRemainingLength;
        }

        if (!Fits(0))
        {
            return null;
        }

        var low = 0L;
        var high = LargestRemainingLength;

        while (low < high)
        {
            var middle = low + ((high - low + 1) / 2);

            if (Fits(middle))
            {
                low = middle;
            }
            else
            {
                high = middle - 1;
            }
        }

        return low;
    }

    /// <summary>
    /// What <paramref name="code"/> is in an acknowledgement of packet type <paramref name="type"/>, a
    /// PUBACK, a SUBACK or an UNSUBACK: named by its table, a refusal of 0x80 or more it does not
    /// name, or unreadable, under 0x80 and not named (spec 15.27 to 15.29). Any other type is an
    /// <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public static MqttAcknowledgementVerdict VerdictOf(int type, int code)
    {
        var table = type switch
        {
            PubAck => PubAckCodes,
            SubAck => SubAckCodes,
            UnsubAck => UnsubAckCodes,
            _ => throw new ArgumentOutOfRangeException(nameof(type), type, "a PUBACK, a SUBACK or an UNSUBACK has a table of Reason Codes, packet type 4, 9 or 11"),
        };

        if (table.Contains(code))
        {
            return MqttAcknowledgementVerdict.Named;
        }

        return code >= 0x80 ? MqttAcknowledgementVerdict.Refusal : MqttAcknowledgementVerdict.Unreadable;
    }

    /// <summary>
    /// What makes <paramref name="packet"/>, whole, its fixed header first, an acknowledgement its
    /// client cannot read (spec 15.29): a PUBACK, a SUBACK or an UNSUBACK of a Reason Code under 0x80
    /// its table does not name, or a SUBACK or an UNSUBACK whose count of Reason Codes is not one,
    /// in the words its loss tells, <c>a PUBACK of 0x01, a Reason Code its table does not name</c>;
    /// judged by its packet type whatever its flags, a SUBACK or an UNSUBACK of no Property Length,
    /// or of one still continuing at its body's last byte, of no Reason Code. None for any other
    /// packet, and for bytes it cannot follow, a Remaining Length or a Property Length past what
    /// came or still continuing at its fourth byte, which its client judges itself. It never throws.
    /// </summary>
    public static string? UnreadableOf(ReadOnlySpan<byte> packet)
    {
        if (packet.IsEmpty)
        {
            return null;
        }

        var type = packet[0] >> 4;

        if (type is not (PubAck or SubAck or UnsubAck))
        {
            return null;
        }

        if (VariableOf(packet[1..]) is not (var remaining, var width) || packet.Length < 1 + width + remaining)
        {
            return null;
        }

        var body = packet.Slice(1 + width, remaining);
        var name = type switch
        {
            PubAck => "a PUBACK",
            SubAck => "a SUBACK",
            _ => "an UNSUBACK",
        };

        // * a PUBACK's identifier, then its code where its Remaining Length is 3 or more, none 0x00
        // (MQTT 5.0 §3.4.2.1); its properties never read
        if (type == PubAck)
        {
            return body.Length >= 3 ? WordsOf((name, type), body[2]) : null;
        }

        // a SUBACK's or an UNSUBACK's identifier, its properties, then one Reason Code a filter
        // (MQTT 5.0 §3.9.3, §3.11.3): its count judged before its code
        if (CountOf(body) is not (var count, var at))
        {
            return null;
        }

        return count switch
        {
            0 => $"{name} of no Reason Code",
            1 => WordsOf((name, type), body[at]),
            _ => string.Create(CultureInfo.InvariantCulture, $"{name} of {count} Reason Codes for one filter"),
        };
    }

    // a SUBACK's or an UNSUBACK's count of Reason Codes, and where its first is, or none where its
    // Property Length runs past its body or still continues at its fourth byte, its client's to
    // judge; no Property Length, or one still continuing at its body's last byte, leaves no room
    // for a code, a count of 0, as the TypeScript side's guard counts it
    private static (int Count, int At)? CountOf(ReadOnlySpan<byte> body)
    {
        const int Identifier = 2;

        if (body.Length <= Identifier)
        {
            return (0, body.Length);
        }

        var properties = 0;

        for (var at = Identifier; at < body.Length; at++)
        {
            var digit = body[at];
            var digits = at - Identifier + 1;

            properties |= (digit & 0x7F) << (7 * (digits - 1));

            if ((digit & 0x80) != 0)
            {
                // ! its body's last byte first: a count of 0 though it is the fourth digit
                if (at + 1 == body.Length)
                {
                    return (0, body.Length);
                }

                if (digits == 4)
                {
                    return null;
                }

                continue;
            }

            var first = at + 1 + properties;

            return first > body.Length ? null : (body.Length - first, first);
        }

        return null;
    }

    // the words of a code its table does not name under 0x80, or none
    private static string? WordsOf((string Name, int Type) packet, int code)
    {
        return VerdictOf(packet.Type, code) == MqttAcknowledgementVerdict.Unreadable
            ? string.Create(CultureInfo.InvariantCulture, $"{packet.Name} of 0x{code:X2}, a Reason Code its table does not name")
            : null;
    }

    // a Variable Byte Integer at its start, its value and its width, or none where it runs past its
    // bytes or past four (MQTT 5.0 §1.5.5)
    private static (int Value, int Width)? VariableOf(ReadOnlySpan<byte> bytes)
    {
        var value = 0;

        for (var index = 0; index < 4 && index < bytes.Length; index++)
        {
            value |= (bytes[index] & 0x7F) << (7 * index);

            if ((bytes[index] & 0x80) == 0)
            {
                return (value, index + 1);
            }
        }

        return null;
    }

    // R: the topic's length and bytes, the packet identifier at QoS 1, the properties' length and a
    // Message Expiry Interval where there is one, then the payload
    private static long RemainingOf((long TopicBytes, long Payload) publish, MqttPublishShape shape)
    {
        var properties = shape.HasLife ? ExpiryBytes : 0;

        return 2 + publish.TopicBytes + (shape.Qos == 1 ? 2 : 0) + WidthOf(properties) + properties + publish.Payload;
    }
}
