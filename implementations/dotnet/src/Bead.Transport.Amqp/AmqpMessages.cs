using System.Text;
using Amqp;
using Amqp.Framing;

namespace Bead.Transport.Amqp;

/// <summary>
/// The message profile of a parcel over AMQP 1.0, counted to its every byte (spec 15.35, 15.37;
/// AMQP 1.0 §1.6, §3.2), and how a topic is addressed through RabbitMQ 4 (spec 15.32): a header
/// only where a life is asked, its ttl alone; properties whose <c>to</c> alone is set; one Data
/// section. AMQPNetLite writes the bytes, each value in the smallest of its encodings as the profile
/// asks, since it takes no message already written; <c>spec/vectors.json</c>'s <c>amqpMessages</c>
/// holds its bytes to the profile, and <c>amqpPublishBounds</c> the count, with no broker. The
/// TypeScript side's <c>amqp-messages</c> writes and counts alike.
/// </summary>
internal static class AmqpMessages
{
    /// <summary>A participant's largest message, its receive bound's, by default: 16 MiB (spec 15.37).</summary>
    public const long MaximumMessageSize = 16_777_216;

    /// <summary>The largest payload a Data section's <c>vbin32</c> holds, and the bound of a sender ATTACH that names none.</summary>
    public const long LargestBound = uint.MaxValue;

    // the header with a life: its descriptor, its list8 and its ttl as a uint, the five fields before it
    // null — counted so whatever the ttl, as 15.30 counts a Message Expiry's five bytes
    private const int HeaderBytes = 13;

    // the properties without their to: the descriptor's 3, the list8's 3, the nulls of message-id
    // and user-id, and the str8's code and length
    private const int PropertiesBytes = 10;

    // the Data section's descriptor
    private const int DataDescriptorBytes = 3;

    /// <summary>A topic's tokens joined by <c>.</c>, as a queue and a routing key name it (spec 15.32): <c>bead.i.ada</c>.</summary>
    public static string TopicOf(IReadOnlyList<string> topic)
    {
        ArgumentNullException.ThrowIfNull(topic);

        return string.Join('.', topic);
    }

    /// <summary>
    /// Where a topic is written: the topic exchange named its root, then the topic as its routing
    /// key, each segment percent-encoded as RFC 3986 §2.1 has it, <c>/exchanges/bead/bead.i.ada</c>
    /// (RabbitMQ 4's address v2).
    /// </summary>
    public static string AddressOf(IReadOnlyList<string> topic)
    {
        ArgumentNullException.ThrowIfNull(topic);

        return $"/exchanges/{Uri.EscapeDataString(topic.Count > 0 ? topic[0] : "")}/{Uri.EscapeDataString(TopicOf(topic))}";
    }

    /// <summary>Where a queue is read, by its name: <c>/queues/bead.s.interop</c>.</summary>
    public static string QueueAddressOf(string queue)
    {
        return $"/queues/{Uri.EscapeDataString(queue)}";
    }

    /// <summary>The bytes of a <c>vbin8</c> or <c>vbin32</c>'s code and length before <paramref name="payload"/> bytes.</summary>
    public static int WidthOf(long payload)
    {
        return payload < 256 ? 2 : 5;
    }

    /// <summary>
    /// S, the bytes of a message of <c>Payload</c> bytes to an address of <c>AddressBytes</c> bytes in
    /// UTF-8, a life counted where <paramref name="hasLife"/> says (spec 15.37).
    /// </summary>
    public static long MessageBytes((long AddressBytes, long Payload) message, bool hasLife)
    {
        return (hasLife ? HeaderBytes : 0) + PropertiesBytes + message.AddressBytes + DataDescriptorBytes + WidthOf(message.Payload) + message.Payload;
    }

    /// <summary>
    /// The largest payload of a message to <c>Address</c> within <c>Maximum</c> bytes, a life counted,
    /// whatever the message (spec 15.37), at most 4,294,967,295 — or none where an empty one does not
    /// fit. Found by a search: S grows with N, and w(N) with it, so no overhead is fixed.
    /// </summary>
    public static long? LargestPayload((string Address, long Maximum) bound)
    {
        ArgumentNullException.ThrowIfNull(bound.Address);

        var addressBytes = Encoding.UTF8.GetByteCount(bound.Address);

        bool Fits(long payload)
        {
            return MessageBytes((addressBytes, payload), true) <= bound.Maximum;
        }

        if (!Fits(0))
        {
            return null;
        }

        var low = 0L;
        var high = LargestBound;

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
    /// The message of a parcel (spec 15.35): its header, its ttl alone, in milliseconds, where a life
    /// is asked; its properties, <c>to</c> alone; its Data section, the payload.
    /// </summary>
    public static Message MessageOf((string To, ReadOnlyMemory<byte> Payload) parcel, uint? ttl)
    {
        return new Message
        {
            Header = ttl is { } milliseconds ? new Header { Ttl = milliseconds } : null,
            Properties = new Properties { To = parcel.To },
            BodySection = new Data { Binary = parcel.Payload.ToArray() },
        };
    }
}
