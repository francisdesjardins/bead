using System.Globalization;
using System.Text;
using System.Text.Json;
using Bead.Tests;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The count of an MQTT 5 PUBLISH (spec 15.30) against <c>spec/vectors.json</c>'s
/// <c>mqttPublishBounds</c>, with no broker: each row's largest payload within its bound, and the
/// packet it makes, to its every byte. The TypeScript side's <c>mqtt-packets</c> plays the same rows.
/// </summary>
public sealed class MqttPacketsTests
{
    [Fact]
    public void Plays_mqttPublishBounds_a_PUBLISH_counted_to_its_every_byte_and_the_largest_payload_within_a_bound_found_exactly()
    {
        var names = Vectors.NamesOf("mqttPublishBounds").Select((row) =>
        {
            return row.Data;
        }).ToList();

        Assert.NotEmpty(names);

        foreach (var name in names)
        {
            var vector = Vectors.Of("mqttPublishBounds", name);
            var topic = vector.GetProperty("topic").GetString()!;
            var maximum = vector.GetProperty("maximumPacketSize").GetInt64();
            var shape = new MqttPublishShape(vector.GetProperty("qos").GetInt32(), vector.GetProperty("expiry").GetBoolean());
            var largest = MqttPackets.LargestPayload((topic, maximum), shape);
            var packet = largest is { } payload ? MqttPackets.PublishBytes((Encoding.UTF8.GetByteCount(topic), payload), shape) : (long?)null;

            // * the row's name beside each value, so that a failure says which row
            Assert.Equal(
                $"{name}: payload {Written(vector.GetProperty("largestPayload"))}, packet {Written(vector.GetProperty("packetBytes"))}",
                $"{name}: payload {largest?.ToString(CultureInfo.InvariantCulture) ?? "none"}, packet {packet?.ToString(CultureInfo.InvariantCulture) ?? "none"}");

            // ! exact: one byte more passes the bound, or the largest Remaining Length
            if (largest is { } found)
            {
                Assert.True(
                    MqttPackets.PublishBytes((Encoding.UTF8.GetByteCount(topic), found + 1), shape) > maximum || found + 1 > MqttPackets.LargestRemainingLength,
                    $"{name}: a payload of {found + 1} bytes passes its bound");
            }
        }
    }

    // a vector's count, or none for null
    private static string Written(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Null ? "none" : value.GetInt64().ToString(CultureInfo.InvariantCulture);
    }
}
