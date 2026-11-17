using Bead.Transcoding;
using Bead.Transcoding.V1;
using Google.Protobuf.Reflection;

namespace Bead.Fuzz;

/// <summary>
/// protobuf's JSON read by Bead's own mapping, <see cref="JsonForm"/>, over
/// <c>spec/transcoding.proto</c>'s <c>Everything</c> and <c>Edges</c> (transcoding 5). The input's
/// first byte picks the message, <c>Everything</c> when it is even and <c>Edges</c> when it is odd;
/// the rest is read as a body (5.2). What reads is written; what was written reads; and it writes
/// again to the same text, byte for byte. A refusal of the reading, a
/// <see cref="JsonFormException"/>, is the form's documented one; any other throw, a write's refusal
/// of what read, or a second text that differs is a finding. No message is compared: a map's entries
/// read in the text's order are written in 17.7.6's, and a <c>-0</c> is written <c>0</c> or left out
/// (5.6). The TypeScript side's <c>tools/fuzz/json-form.ts</c> and the Rust side's <c>json-form</c>
/// target are its twins.
/// </summary>
internal sealed class JsonFormTarget : IFuzzTarget
{
    private static readonly MessageDescriptor[] Messages = [Everything.Descriptor, Edges.Descriptor];

    private static readonly JsonForm Form = new(Messages);

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "json-form";
        }
    }

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        if (data.Length < 1)
        {
            return;
        }

        var descriptor = Messages[data[0] % 2];
        Google.Protobuf.IMessage message;

        try
        {
            message = Form.Read(descriptor, data[1..]);
        }
        catch (JsonFormException)
        {
            // * a refusal is the answer to a body that is no such message: any other throw is a finding
            return;
        }

        var written = Form.Write(message);
        var again = Form.Write(Form.Read(descriptor, written));

        if (!again.AsSpan().SequenceEqual(written))
        {
            throw new InvalidOperationException($"a JSON text is written again otherwise: {Convert.ToHexStringLower(data)}");
        }
    }
}
