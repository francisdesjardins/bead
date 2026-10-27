using System.Text.Json;

namespace Bead;

/// <summary>How one encoding reads a payload and writes a value; what does not read, or write, throws.</summary>
/// <typeparam name="T">The value a payload holds.</typeparam>
public interface IPayloadCodec<T>
{
    /// <summary>The value a payload holds; one that does not read throws.</summary>
    T Decode(ReadOnlyMemory<byte> payload);

    /// <summary>The payload of a value; one that does not write throws.</summary>
    ReadOnlyMemory<byte> Encode(T value);
}

/// <summary>
/// The codecs of spec section 17, by their encoding's name — <c>raw</c>, <c>text</c> and
/// <c>json</c>, each refusing with a <see cref="FormatException"/> saying why — and a codec made of
/// two functions, a protobuf message's from its stock library's, as gRPC's marshallers are.
/// </summary>
public static class PayloadCodecs
{
    /// <summary>A <c>raw</c> payload's bytes, as they are (17.3).</summary>
    public static IPayloadCodec<ReadOnlyMemory<byte>> Raw { get; } = new FunctionCodec<ReadOnlyMemory<byte>>(Payloads.ReadRaw, Payloads.WriteRaw);

    /// <summary>A <c>text</c> payload's string, in UTF-8, read strictly (17.4).</summary>
    public static IPayloadCodec<string> Text { get; } = new FunctionCodec<string>(Payloads.ReadText, Payloads.WriteText);

    /// <summary>A <c>json</c> payload's value, read as 17.5 and 17.6 say, written in its canonical form (17.7).</summary>
    public static IPayloadCodec<JsonElement> Json { get; } = new FunctionCodec<JsonElement>(Payloads.ReadJson, Payloads.WriteJson);

    /// <summary>
    /// A codec of <paramref name="decode"/> and <paramref name="encode"/>: a protobuf message's,
    /// which <c>Bead.Protobuf</c>'s <c>ProtoCodecs</c> makes of its stock library's reader and
    /// writer, spec 17.9 held whole. One that is none is an <see cref="ArgumentNullException"/>.
    /// </summary>
    public static IPayloadCodec<T> Of<T>(Func<ReadOnlyMemory<byte>, T> decode, Func<T, ReadOnlyMemory<byte>> encode)
    {
        ArgumentNullException.ThrowIfNull(decode);
        ArgumentNullException.ThrowIfNull(encode);

        return new FunctionCodec<T>(decode, encode);
    }

    // a codec of two functions, which it calls as they are
    private sealed class FunctionCodec<T>(Func<ReadOnlyMemory<byte>, T> decode, Func<T, ReadOnlyMemory<byte>> encode) : IPayloadCodec<T>
    {
        public T Decode(ReadOnlyMemory<byte> payload)
        {
            return decode(payload);
        }

        public ReadOnlyMemory<byte> Encode(T value)
        {
            return encode(value);
        }
    }
}
