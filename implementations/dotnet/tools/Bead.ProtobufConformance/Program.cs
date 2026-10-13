using System.Buffers.Binary;
using Bead;
using Bead.Conformance.V1;
using Conformance;
using Google.Protobuf;

// The C# side's testee of protobuf's conformance suite (decision 0028), as the suite's runner drives
// one: on the standard input, each ConformanceRequest after its length, a 32-bit little-endian
// integer; on the standard output, each ConformanceResponse alike, until the input ends. Each
// message is read and written back through the codec beadc generates for the procedure that binds
// it, found by the message's full name, so the check of its records runs before Google.Protobuf
// reads it, as it does in any project that binds proto.

// each message the suite sends, by its full name: read now, written back by what the read returns
var roundTrips = new Dictionary<string, Func<ReadOnlyMemory<byte>, Func<ReadOnlyMemory<byte>>>>(StringComparer.Ordinal)
{
    ["protobuf_test_messages.proto3.TestAllTypesProto3"] = RoundTripOf(ConformanceProcedures.Proto3.Bindings),
    ["protobuf_test_messages.proto2.TestAllTypesProto2"] = RoundTripOf(ConformanceProcedures.Proto2.Bindings),
    ["protobuf_test_messages.editions.TestAllTypesEdition2023"] = RoundTripOf(ConformanceProcedures.Edition2023.Bindings),
    ["protobuf_test_messages.editions.proto2.TestAllTypesProto2"] = RoundTripOf(ConformanceProcedures.EditionsProto2.Bindings),
    ["protobuf_test_messages.editions.proto3.TestAllTypesProto3"] = RoundTripOf(ConformanceProcedures.EditionsProto3.Bindings),
    ["bead.codecs.v1.Probe"] = RoundTripOf(ConformanceProcedures.Probe.Bindings),
};
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

Func<ReadOnlyMemory<byte>, Func<ReadOnlyMemory<byte>>> RoundTripOf<TMessage>(ProcedureBindings<TMessage, TMessage> bindings)
{
    return (payload) =>
    {
        var message = bindings.Request.Decode(payload);

        return () =>
        {
            return bindings.Result.Encode(message);
        };
    };
}

ConformanceResponse Answer(ConformanceRequest request)
{
    // the runner asks first which tests a testee expects to fail: none of its own, the failure list
    // the tool gives the runner names them
    if (request.MessageType == "conformance.FailureSet")
    {
        return new ConformanceResponse { ProtobufPayload = ByteString.Empty };
    }

    // ! Bead's proto carries the binary form alone; a skip never hides a binary test
    if (request.PayloadCase != ConformanceRequest.PayloadOneofCase.ProtobufPayload || request.RequestedOutputFormat != Conformance.WireFormat.Protobuf)
    {
        return new ConformanceResponse { Skipped = "Bead's proto carries the binary form alone" };
    }

    if (request.MessageType.StartsWith("protobuf_test_messages.edition_unstable.", StringComparison.Ordinal))
    {
        return new ConformanceResponse { Skipped = "an unstable edition, which no stock generator compiles" };
    }

    // ! a message gone fails its tests, rather than skipping them
    if (!roundTrips.TryGetValue(request.MessageType, out var roundTrip))
    {
        return new ConformanceResponse { RuntimeError = $"no procedure binds {request.MessageType}" };
    }

    Func<ReadOnlyMemory<byte>> writeBack;

    try
    {
        writeBack = roundTrip(request.ProtobufPayload.Memory);
    }
    catch (FormatException reason)
    {
        return new ConformanceResponse { ParseError = reason.Message };
    }
    catch (InvalidProtocolBufferException reason)
    {
        return new ConformanceResponse { ParseError = reason.Message };
    }

    return new ConformanceResponse { ProtobufPayload = ByteString.CopyFrom(writeBack().Span) };
}
