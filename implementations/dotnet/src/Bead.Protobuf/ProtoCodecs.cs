using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Protobuf;

/// <summary>
/// The runtime codec of a <c>proto</c> message (spec 17.9, decision 0042), which holds 17.9 once:
/// its records checked against its descriptor before Google.Protobuf reads them
/// (<see cref="ProtoRecords"/>, decision 0028), a singular closed enum's record of a number its enum
/// declares no value of dropped first (17.9.8), the bound of 17.9.3 set in the call, then the
/// message refused where it leaves a required field unset (<see cref="ProtoRequired"/>, 17.9.7). A
/// value is written as its reader would read it (17.2, decision 0031): refused before
/// Google.Protobuf writes any of it where its known fields nest past the bound
/// (<see cref="ProtoDepth"/>) or the same walk finds a required field unset; then its bytes checked
/// as a reader checks them, which refuses what a reading kept nesting past the bound. Each refusal
/// is a <see cref="FormatException"/> of its reason in 17.2's words, <c>not its message</c>,
/// <c>nested past 100</c> or <c>a required field unset</c>, Google.Protobuf's own error or what Bead
/// found its inner exception. Generated code, a gateway's reader of a result, a stream's event and
/// the HTTP caller go through it. The TypeScript side's twin is <c>protoCodecOf</c>, of
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
    /// what 17.9 refuses, each refusal a <see cref="FormatException"/> of its reason, its records',
    /// its required fields', or Google.Protobuf's own, which it holds as its inner exception; its
    /// writing refuses a message whose known fields nest past the bound, or that leaves a required
    /// field unset, with a <see cref="FormatException"/> of the same reason, before anything is
    /// written, then checks what it wrote as its reading does, so it writes nothing its reader refuses.
    /// </summary>
    public static IPayloadCodec<T> Of<T>()
        where T : IMessage<T>, new()
    {
        return PayloadCodecs.Of(
            (bytes) =>
            {
                var message = new T();

                ReadInto(message, (bytes, Bound));
                ProtoRequired.CheckRead(message);

                return message;
            },
            (T message) =>
            {
                ArgumentNullException.ThrowIfNull(message);

                // ! the depth pass first: past it, neither the required walk nor Google.Protobuf's
                // CalculateSize recurses past the bound
                ProtoDepth.Check(message);
                ProtoRequired.Check(message);

                return ReadBack(message.ToByteArray(), message.Descriptor);
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

        ProtoRequired.CheckRead(message);

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

    // * what a writer writes, its reader reads (17.2): the bytes checked as a reader checks them, its
    // refusal the writer's, of the same reason, the reader's its inner exception; past the depth
    // pass, it refuses what a reading kept nesting past the bound, an unknown group or an
    // extension's message
    private static byte[] ReadBack(byte[] bytes, MessageDescriptor descriptor)
    {
        try
        {
            ProtoRecords.Checked(bytes, descriptor);
        }
        catch (FormatException reason)
        {
            throw new FormatException(reason.Message, reason);
        }

        return bytes;
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

        // ! Google.Protobuf throws an InvalidProtocolBufferException on a string that is not UTF-8,
        // and on what else it cannot read: what the stock reader throws as it reads is spec 17.9's
        // refusal, never the side's own error
        try
        {
            input.ReadMessage(message);
        }
        catch (InvalidProtocolBufferException reason)
        {
            throw new FormatException(ProtoRecords.NotItsMessage, reason);
        }
    }
}
