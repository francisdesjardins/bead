using System.Text;

namespace Bead.Transport.Mqtt;

/// <summary>What a PUBLISH is counted at: its QoS, and whether it carries a Message Expiry Interval.</summary>
internal readonly record struct MqttPublishShape(int Qos, bool HasLife);

/// <summary>
/// The count of an MQTT 5 PUBLISH to its every byte (spec 15.30; MQTT 5.0 §2.1.4, §3.3.2), and how a
/// broker's topic and a group's shared subscription are written (spec 15.25). Nothing here reaches
/// MQTTnet: the adapter counts each publication with it, and <c>spec/vectors.json</c>'s
/// <c>mqttPublishBounds</c> holds both sides to it with no broker. The TypeScript side's
/// <c>mqtt-packets</c> counts alike.
/// </summary>
internal static class MqttPackets
{
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

    // R: the topic's length and bytes, the packet identifier at QoS 1, the properties' length and a
    // Message Expiry Interval where there is one, then the payload
    private static long RemainingOf((long TopicBytes, long Payload) publish, MqttPublishShape shape)
    {
        var properties = shape.HasLife ? ExpiryBytes : 0;

        return 2 + publish.TopicBytes + (shape.Qos == 1 ? 2 : 0) + WidthOf(properties) + properties + publish.Payload;
    }
}
