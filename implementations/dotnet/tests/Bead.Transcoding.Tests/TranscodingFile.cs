using System.Text;
using System.Text.Json;
using Bead.Transcoding.V1;
using Google.Protobuf;
using Google.Protobuf.Reflection;

namespace Bead.Transcoding.Tests;

/// <summary>
/// What the tests read of <c>spec/transcoding.json</c> and of the code beadc generated of
/// <c>spec/transcoding.proto</c> into <c>Generated/</c>, an output with <c>http: true</c>: the file's
/// root, a message by its full name, a procedure's route by its name, and the mapping over the route
/// table's messages.
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
        return TranscodingReflection.Descriptor.MessageTypes.Single((message) =>
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

    // a reading's or a writing's message, from its binary payload as its stock library reads it
    public static IMessage Parsed(MessageDescriptor descriptor, byte[] payload)
    {
        return descriptor.Parser.ParseFrom(payload);
    }

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "transcoding.json")));

        return document.RootElement.Clone();
    }
}
