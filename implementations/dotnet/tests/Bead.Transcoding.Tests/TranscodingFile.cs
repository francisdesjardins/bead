using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Transcoding.Tests;

/// <summary>
/// What the tests read of <c>spec/transcoding.json</c> and of the code beadc generated of
/// <c>spec/transcoding.proto</c> and <c>spec/transcoding-required.proto</c>, which it imports, into
/// <c>Generated/</c>, an output with <c>http: true</c>: the file's root, a message by its full name,
/// a procedure's route by its name, and the mapping over the route table's messages.
/// </summary>
internal static class TranscodingFile
{
    public static JsonElement Root { get; } = Load();

    /// <summary>The mapping over the route table's messages, as a gateway builds it.</summary>
    public static JsonForm Form { get; } = new(HttpRoutes.All.SelectMany((route) =>
    {
        return new[] { route.Request, route.Result, route.Notification }.Select((payload) =>
        {
            return payload?.Descriptor;
        }).OfType<MessageDescriptor>();
    }));

    /// <summary>The document beadc wrote of <c>spec/transcoding.proto</c>, as its output's file holds it.</summary>
    public static byte[] Document
    {
        get
        {
            return File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "Generated", "openapi.json"));
        }
    }

    public static MessageDescriptor MessageOf(string fullName)
    {
        return TranscodingReflection.Descriptor.MessageTypes.Concat(TranscodingRequiredReflection.Descriptor.MessageTypes).Single((message) =>
        {
            return message.FullName == fullName;
        });
    }

    public static HttpRoute RouteOf(string procedureName)
    {
        return HttpRoutes.All.Single((route) =>
        {
            return route.Procedure.ProcedureName == procedureName;
        });
    }

    public static byte[] Hex(string text)
    {
        return text.Length == 0 ? [] : Convert.FromHexString(text.Replace(" ", "", StringComparison.Ordinal));
    }

    public static string Text(ReadOnlyMemory<byte> bytes)
    {
        return Encoding.UTF8.GetString(bytes.Span);
    }

    public static string? StringOf(JsonElement entry, string name)
    {
        return entry.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    // a reading's or a binding's message, from its binary payload as its stock library reads it
    public static IMessage Parsed(MessageDescriptor descriptor, byte[] payload)
    {
        return descriptor.Parser.ParseFrom(payload);
    }

    // a writing's result, from its binary payload as the gateway reads it, through the runtime
    // reader (spec 17.9): a closed enum's undeclared number set aside among them
    public static IMessage Answered(MessageDescriptor descriptor, byte[] payload)
    {
        return Bead.Protobuf.ProtoCodecs.Read(descriptor, payload);
    }

    /// <summary>The companion's version, as <c>spec/transcoding.md</c> states it.</summary>
    public static string CompanionVersion
    {
        get
        {
            var text = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "transcoding.md"));

            return Regex.Match(text, @"\*\*Version: ([0-9]+\.[0-9]+\.[0-9]+)\*\*").Groups[1].Value;
        }
    }

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "transcoding.json")));

        return document.RootElement.Clone();
    }
}
