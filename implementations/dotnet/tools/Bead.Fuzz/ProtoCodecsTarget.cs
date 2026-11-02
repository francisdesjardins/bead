using Bead.Codecs.V1;
using Bead.Protobuf;
using Google.Protobuf;

namespace Bead.Fuzz;

/// <summary>
/// The <c>proto</c> codecs over <c>spec/codecs.proto</c>'s <c>Probe</c> (spec 17.9). The input's
/// first byte draws a path, a child, a map's entry or a group; its second a count, 0 to 127; its
/// third a number of unknown groups, 0 to 127. The rest, wrapped in that many groups of field 4,
/// which <c>Probe</c> does not declare, is read by the generated codec and by the codec of its
/// descriptor, which both read it alike or both refuse it, a <see cref="FormatException"/>. A
/// message that reads is wrapped <c>count</c> times on its path, then written: its writer refuses
/// it, a <see cref="FormatException"/> of <c>nested past 100</c>, or its reader takes what it wrote
/// (17.2), which equals the message as Google.Protobuf compares messages and writes again to the
/// same bytes. The TypeScript side's <c>tools/fuzz/proto-codecs.ts</c> and the Rust side's
/// <c>proto-codecs</c> target are its twins.
/// </summary>
internal sealed class ProtoCodecsTarget : IFuzzTarget
{
    // a group of field 4, opened and closed (Encoding, "Groups")
    private const byte Start = 0x23;
    private const byte End = 0x24;

    private static readonly IPayloadCodec<Probe> Codec = ProtoCodecs.Of<Probe>();

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "proto-codecs";
        }
    }

    // helpers

    // a Probe that holds `inner` on the path `path` draws: as its child, as an entry's value under the
    // key "", or as its group
    private static Probe Wrapped(Probe inner, int path)
    {
        return (path % 3) switch
        {
            0 => new Probe { Child = inner },
            1 => new Probe { Children = { [""] = inner } },
            _ => new Probe { Delimited = inner },
        };
    }

    // the message the generated codec reads of `bytes`, which the codec of its descriptor reads alike;
    // none where both refuse
    private static Probe? ReadOf(byte[] bytes)
    {
        Probe? typed = null;
        IMessage? described = null;

        try
        {
            typed = Codec.Decode(bytes);
        }
        catch (FormatException)
        {
            // a refusal is the answer to bytes that are no Probe
        }

        try
        {
            described = ProtoCodecs.Read(Probe.Descriptor, bytes);
        }
        catch (FormatException)
        {
            // and the codec of its descriptor's
        }

        if ((typed is null) != (described is null) || (typed is not null && !typed.Equals(described)))
        {
            throw new InvalidOperationException($"the generated codec and the codec of its descriptor read otherwise: {Convert.ToHexStringLower(bytes)}");
        }

        return typed;
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        if (data.Length < 3)
        {
            return;
        }

        int path = data[0];
        var count = data[1] % 128;
        var groups = data[2] % 128;
        var bytes = new byte[groups + (data.Length - 3) + groups];

        bytes.AsSpan(0, groups).Fill(Start);
        data[3..].CopyTo(bytes.AsSpan(groups));
        bytes.AsSpan(bytes.Length - groups).Fill(End);

        if (ReadOf(bytes) is not { } message)
        {
            return;
        }

        for (var above = 0; above < count; above += 1)
        {
            message = Wrapped(message, path);
        }

        ReadOnlyMemory<byte> written;

        try
        {
            written = Codec.Encode(message);
        }
        catch (FormatException reason) when (reason.Message == "nested past 100")
        {
            // * the writer refuses for its depth alone: any other refusal, or error, is a finding
            return;
        }

        var read = Codec.Decode(written);

        if (!read.Equals(message))
        {
            throw new InvalidOperationException($"a proto message reads back otherwise: {Convert.ToHexStringLower(data)}");
        }

        if (!Codec.Encode(read).Span.SequenceEqual(written.Span))
        {
            throw new InvalidOperationException($"a proto message is written again otherwise: {Convert.ToHexStringLower(data)}");
        }
    }
}
