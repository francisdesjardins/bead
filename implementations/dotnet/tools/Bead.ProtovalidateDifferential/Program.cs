using System.Text;
using System.Text.Json;
using Bead;
using Bead.Validations.V1;
using Google.Protobuf;

// The C# side's testee of the protovalidate differential (decision 0035), as
// tools/protovalidate-differential.mjs drives one: on the standard input, a case a line,
// {"message":"<full name>","payload":"<base64>"}; on the standard output, a line for each, the
// violations the validator beadc generates for that message gives, failFast off and no bound, or
// {"refused":true} where its codec does not read the payload. Generated/ is what that tool generates
// at run time, never committed.

// a judging whole: failFast off, no bound
var whole = new ValidateOptions();

// each message, by its full name: its payload read by its binding's codec, then judged by its rules
var judges = new Dictionary<string, Func<byte[], Judged>>(StringComparer.Ordinal)
{
    ["bead.validations.v1.Numbers"] = JudgeOf(ValidationsProcedures.JudgeNumbers),
    ["bead.validations.v1.Floats"] = JudgeOf(ValidationsProcedures.JudgeFloats),
    ["bead.validations.v1.Strings"] = JudgeOf(ValidationsProcedures.JudgeStrings),
    ["bead.validations.v1.Bytes"] = JudgeOf(ValidationsProcedures.JudgeBytes),
    ["bead.validations.v1.Enums"] = JudgeOf(ValidationsProcedures.JudgeEnums),
    ["bead.validations.v1.Repeated"] = JudgeOf(ValidationsProcedures.JudgeRepeated),
    ["bead.validations.v1.Maps"] = JudgeOf(ValidationsProcedures.JudgeMaps),
    ["bead.validations.v1.Presence"] = JudgeOf(ValidationsProcedures.JudgePresence),
    ["bead.validations.v1.Wrappers"] = JudgeOf(ValidationsProcedures.JudgeWrappers),
    ["bead.validations.v1.Oneofs"] = JudgeOf(ValidationsProcedures.JudgeOneofs),
    ["bead.validations.v1.Nested"] = JudgeOf(ValidationsProcedures.JudgeNested),
    ["bead.validations.v1.Order"] = JudgeOf(ValidationsProcedures.JudgeOrder),
    ["bead.validations.v1.Patterns"] = JudgeOf(ValidationsProcedures.JudgePatterns),
};

using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
using var output = Console.OpenStandardOutput();

while (input.ReadLine() is { } line)
{
    if (line.Length == 0)
    {
        continue;
    }

    output.Write(Answer(line));
    output.WriteByte((byte)'\n');
}

output.Flush();

Func<byte[], Judged> JudgeOf<TRequest>(RequestProcedure<ValidationsProcedures, TRequest, Taken, NoFailure> procedure)
{
    return (payload) =>
    {
        var request = procedure.Bindings.Request.Decode(payload);

        return procedure.Bindings.Validate!(request, whole);
    };
}

byte[] Answer(string line)
{
    using var read = JsonDocument.Parse(line);
    var message = read.RootElement.GetProperty("message").GetString()!;

    // ! a message gone fails the run, rather than passing as refused
    if (!judges.TryGetValue(message, out var judge))
    {
        throw new InvalidOperationException($"no procedure judges {message}");
    }

    Judged judged;

    try
    {
        judged = judge(Convert.FromBase64String(read.RootElement.GetProperty("payload").GetString()!));
    }
    catch (FormatException)
    {
        return """{"refused":true}"""u8.ToArray();
    }
    catch (InvalidProtocolBufferException)
    {
        return """{"refused":true}"""u8.ToArray();
    }

    using var written = new MemoryStream();

    using (var writer = new Utf8JsonWriter(written))
    {
        writer.WriteStartObject();
        writer.WriteStartArray("violations");

        // * a violation as the wire carries it: its members, the value it broke left on this side
        foreach (var violation in judged.Violations)
        {
            writer.WriteStartObject();

            if (violation.FieldPath is { } fieldPath)
            {
                writer.WriteString("fieldPath", fieldPath);
            }

            writer.WriteString("ruleId", violation.RuleId);

            if (violation.Bounds is { } bounds)
            {
                writer.WritePropertyName("bounds");
                bounds.WriteTo(writer);
            }

            if (violation.Message is { } words)
            {
                writer.WriteString("message", words);
            }

            if (violation.ForKey)
            {
                writer.WriteBoolean("forKey", true);
            }

            writer.WriteEndObject();
        }

        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    return written.ToArray();
}
