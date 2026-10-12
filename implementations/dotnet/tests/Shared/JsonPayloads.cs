using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// JSON, read and written as spec section 17 states, for a test that calls through the service
/// manager's accessors rather than a generated client: the runtime's json codec, each way an
/// accessor takes a serializer.
/// </summary>
internal sealed class JsonPayloads :
    IRequestSerializerClient<JsonElement, JsonElement>,
    INotificationSerializerClient<JsonElement, JsonElement, JsonElement>,
    INotificationSerializerServer<JsonElement, JsonElement, JsonElement>
{
    public JsonElement Decode(ReadOnlyMemory<byte> payload)
    {
        return PayloadCodecs.Json.Decode(payload);
    }

    public ReadOnlyMemory<byte> Encode(JsonElement value)
    {
        return PayloadCodecs.Json.Encode(value);
    }

    public JsonElement DecodeNotification(ReadOnlyMemory<byte> notification)
    {
        return PayloadCodecs.Json.Decode(notification);
    }

    public ReadOnlyMemory<byte> EncodeNotification(JsonElement notification)
    {
        return PayloadCodecs.Json.Encode(notification);
    }
}
