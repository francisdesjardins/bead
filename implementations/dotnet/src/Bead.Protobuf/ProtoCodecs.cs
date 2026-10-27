using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// The runtime codec of a <c>proto</c> message (spec 17.9, decision 0042), which holds 17.9 once:
/// its records checked against its descriptor before Google.Protobuf reads them
/// (<see cref="ProtoRecords"/>, decision 0028), a singular closed enum's record of a number its enum
/// declares no value of dropped first (17.9.8), the bound of 17.9.3 set in the call, then the
/// message refused where it leaves a required field unset (<see cref="ProtoRequired"/>, 17.9.7);
/// written once the same walk takes it. Generated code, a gateway's reader of a result, a stream's
/// event and the HTTP caller go through it. The TypeScript side's twin is <c>protoCodecOf</c>, of
/// <c>@francisdesjardins/bead/proto</c>.
/// </summary>
public static class ProtoCodecs
{
    // * spec 17.9.3: how deep a message nests below the top one; the payload is read as a message
    // field holds one, so the top message counts, and 101 is 100 below it
    private const int Bound = 101;

    // definition

    /// <summary>
    /// The codec of <typeparamref name="T"/>, as a generated binding names it: its reading refuses
    /// what 17.9 refuses, with a <see cref="FormatException"/> where its records or its required
    /// fields do, and its writing refuses a message that leaves a required field unset, with a
    /// <see cref="FormatException"/> in the same words, before anything is written.
    /// </summary>
    public static IPayloadCodec<T> Of<T>()
        where T : IMessage<T>, new()
    {
        return PayloadCodecs.Of(
            (bytes) =>
            {
                var message = new T();

                ReadInto(message, (bytes, Bound));
                ProtoRequired.Check(message);

                return message;
            },
            (T message) =>
            {
                ArgumentNullException.ThrowIfNull(message);
                ProtoRequired.Check(message);

                return message.ToByteArray();
            });
    }

    /// <summary>
    /// <paramref name="bytes"/> read as a message of <paramref name="descriptor"/>, as
    /// <see cref="Of{T}"/> reads one: a gateway's result or notification, a stream's event.
    /// </summary>
    /// <exception cref="FormatException">The bytes are no encoding of the message, nest too deep, or leave a required field unset.</exception>
    public static IMessage Read(MessageDescriptor descriptor, ReadOnlyMemory<byte> bytes)
    {
        var message = Unjudged(descriptor, (bytes, Bound));

        ProtoRequired.Check(message);

        return message;
    }

    /// <summary>
    /// Bytes read as <see cref="Read"/> reads them, within a bound of their own, the top message
    /// counted, but not judged by their required fields: an <c>Any</c>'s message, which 17.9.7
    /// does not look into, read within the depth left below it.
    /// </summary>
    internal static IMessage Unjudged(MessageDescriptor descriptor, (ReadOnlyMemory<byte> Bytes, int Bound) read)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        var message = descriptor.Parser.ParseFrom(ByteString.Empty);

        ReadInto(message, read);

        return message;
    }

    // the records checked, a closed enum's undeclared ones dropped, then read framed within the bound
    private static void ReadInto(IMessage message, (ReadOnlyMemory<byte> Bytes, int Bound) given)
    {
        var (bytes, bound) = given;

        // ! the check first, by the descriptor Google.Protobuf reads with: it refuses what protobuf
        // refuses where a stock library reads on (decision 0028)
        var read = ProtoRecords.Checked(bytes.Span, message.Descriptor)
            ? ProtoRecords.Filtered(bytes.Span, message.Descriptor)
            : bytes;

        // ! read as a message field holds one, after its length: the library then refuses a message
        // that ends before its bytes do, as its own parse of bytes does and its parse of a stream
        // does not
        var framed = new byte[CodedOutputStream.ComputeLengthSize(read.Length) + read.Length];

        using (var output = new CodedOutputStream(framed))
        {
            output.WriteLength(read.Length);
        }

        read.Span.CopyTo(framed.AsSpan(framed.Length - read.Length));

        using var stream = new MemoryStream(framed, writable: false);
        using var input = CodedInputStream.CreateWithLimits(stream, int.MaxValue, bound);

        input.ReadMessage(message);
    }
}
