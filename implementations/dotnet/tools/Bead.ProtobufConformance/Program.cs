using System.Buffers.Binary;
using System.Text;
using Bead;
using Bead.Conformance.V1;
using Bead.Transcoding;
using Conformance;
using Google.Protobuf;
using Google.Protobuf.Reflection;

// The C# side's testee of protobuf's conformance suite (decisions 0028 and 0037), as the suite's
// runner drives one: on the standard input, each ConformanceRequest after its length, a 32-bit
// little-endian integer; on the standard output, each ConformanceResponse alike, until the input
// ends. Each message is read and written back through the codec beadc generates for the procedure
// that binds it, found by the message's full name, so the check of its records runs before
// Google.Protobuf reads it, as it does in any project that binds proto; its JSON is read and written
// by Bead's own mapping, the transcoding layer's, so the suite tests the code a gateway answers by.

// each message the suite sends, by its full name: its descriptor, read from its bytes and written
// back to them by its procedure's codec
var codecs = new Dictionary<string, Codec>(StringComparer.Ordinal)
{
    ["protobuf_test_messages.proto3.TestAllTypesProto3"] = CodecOf(ConformanceProcedures.Proto3.Bindings),
    ["protobuf_test_messages.proto2.TestAllTypesProto2"] = CodecOf(ConformanceProcedures.Proto2.Bindings),
    ["protobuf_test_messages.editions.TestAllTypesEdition2023"] = CodecOf(ConformanceProcedures.Edition2023.Bindings),
    ["protobuf_test_messages.editions.proto2.TestAllTypesProto2"] = CodecOf(ConformanceProcedures.EditionsProto2.Bindings),
    ["protobuf_test_messages.editions.proto3.TestAllTypesProto3"] = CodecOf(ConformanceProcedures.EditionsProto3.Bindings),
    ["bead.codecs.v1.Probe"] = CodecOf(ConformanceProcedures.Probe.Bindings),
};
var form = new JsonForm(codecs.Values.Select((codec) =>
{
    return codec.Descriptor;
}));
var exchange = ConformanceProcedures.Conformance.Bindings;

using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
var head = new byte[4];

while (input.ReadAtLeast(head, head.Length, throwOnEndOfStream: false) == head.Length)
{
    var request = new byte[BinaryPrimitives.ReadInt32LittleEndian(head)];

    input.ReadExactly(request);

    var response = exchange.Result.Encode(Answer(exchange.Request.Decode(request)));

    BinaryPrimitives.WriteInt32LittleEndian(head, response.Length);
    output.Write(head);
    output.Write(response.Span);
    output.Flush();
}

Codec CodecOf<TMessage>(ProcedureBindings<TMessage, TMessage> bindings)
    where TMessage : IMessage<TMessage>, new()
{
    return new Codec(
        new TMessage().Descriptor,
        (payload) =>
        {
            return bindings.Request.Decode(payload);
        },
        (message) =>
        {
            return bindings.Result.Encode((TMessage)message);
        });
}

ConformanceResponse Answer(ConformanceRequest request)
{
    // the runner asks first which tests a testee expects to fail: none of its own, the failure list
    // the tool gives the runner names them
    if (request.MessageType == "conformance.FailureSet")
    {
        return new ConformanceResponse { ProtobufPayload = ByteString.Empty };
    }

    // ! Bead's proto carries the binary form and protobuf's JSON mapping alone; a skip never hides
    // a binary or a JSON test of a form Bead reads
    if (request.PayloadCase is ConformanceRequest.PayloadOneofCase.JspbPayload or ConformanceRequest.PayloadOneofCase.TextPayload
        || request.RequestedOutputFormat is Conformance.WireFormat.Jspb or Conformance.WireFormat.TextFormat)
    {
        return new ConformanceResponse { Skipped = "Bead's proto carries the binary form and protobuf's JSON mapping alone" };
    }

    if (request.TestCategory == TestCategory.JsonIgnoreUnknownParsingTest)
    {
        return new ConformanceResponse { Skipped = "Bead's mapping refuses an unknown member, and takes no option to ignore one" };
    }

    if (request.MessageType.StartsWith("protobuf_test_messages.edition_unstable.", StringComparison.Ordinal))
    {
        return new ConformanceResponse { Skipped = "an unstable edition, which no stock generator compiles" };
    }

    // ! a message gone fails its tests, rather than skipping them
    if (!codecs.TryGetValue(request.MessageType, out var codec))
    {
        return new ConformanceResponse { RuntimeError = $"no procedure binds {request.MessageType}" };
    }

    IMessage message;

    try
    {
        // * a JSON payload read by Bead's mapping, then its bytes read as its codec reads a payload
        // (transcoding 5.2, its last step)
        message = request.PayloadCase == ConformanceRequest.PayloadOneofCase.JsonPayload
            ? codec.Decode(form.Read(codec.Descriptor, Encoding.UTF8.GetBytes(request.JsonPayload)).ToByteArray())
            : codec.Decode(request.ProtobufPayload.Memory);
    }
    catch (Exception reason) when (reason is JsonFormException or FormatException or InvalidProtocolBufferException)
    {
        return new ConformanceResponse { ParseError = reason.Message };
    }

    if (request.RequestedOutputFormat == Conformance.WireFormat.Json)
    {
        try
        {
            return new ConformanceResponse { JsonPayload = Encoding.UTF8.GetString(form.Write(message)) };
        }
        catch (JsonFormException reason)
        {
            return new ConformanceResponse { SerializeError = reason.Message };
        }
    }

    return new ConformanceResponse { ProtobufPayload = ByteString.CopyFrom(codec.Encode(message).Span) };
}

// a message's descriptor, and its procedure's codec, either way
internal sealed record Codec(MessageDescriptor Descriptor, Func<ReadOnlyMemory<byte>, IMessage> Decode, Func<IMessage, ReadOnlyMemory<byte>> Encode);
