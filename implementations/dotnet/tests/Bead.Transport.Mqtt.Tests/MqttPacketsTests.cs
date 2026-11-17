using System.Globalization;
using System.Text;
using System.Text.Json;
using Bead.Tests;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The count of an MQTT 5 PUBLISH (spec 15.30) against <c>spec/vectors.json</c>'s
/// <c>mqttPublishBounds</c>, with no broker: each row's largest payload within its bound, and the
/// packet it makes, to its every byte; and each Reason Code of a PUBACK, a SUBACK and an UNSUBACK
/// (spec 15.27 to 15.29) against its <c>mqttAcknowledgementCodes</c>, judged as the adapter's
/// packet inspector judges it. The TypeScript side's <c>mqtt-packets</c> and
/// <c>mqtt-packet-guard</c> play the same rows.
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

    [Fact]
    public void Plays_mqttAcknowledgementCodes_each_code_of_a_PUBACK_a_SUBACK_and_an_UNSUBACK_named_refused_or_unreadable_as_its_packets_table_says()
    {
        var names = Vectors.NamesOf("mqttAcknowledgementCodes").Select((row) =>
        {
            return row.Data;
        }).ToList();

        Assert.Equal(3, names.Count);

        foreach (var name in names)
        {
            var vector = Vectors.Of("mqttAcknowledgementCodes", name);
            var packet = vector.GetProperty("packet").GetString()!;
            var type = vector.GetProperty("type").GetInt32();
            var named = vector.GetProperty("named").EnumerateArray().Select((code) =>
            {
                return code.GetInt32();
            }).ToHashSet();

            for (var code = 0x00; code <= 0xFF; code++)
            {
                var expected = named.Contains(code) ? MqttAcknowledgementVerdict.Named : code >= 0x80 ? MqttAcknowledgementVerdict.Refusal : MqttAcknowledgementVerdict.Unreadable;
                var words = string.Create(CultureInfo.InvariantCulture, $"{(packet == "UNSUBACK" ? "an" : "a")} {packet} of 0x{code:X2}, a Reason Code its table does not name");

                // * the row's name and the code beside each verdict, so that a failure says which
                Assert.Equal($"{name} 0x{code:X2}: {expected}", $"{name} 0x{code:X2}: {MqttPackets.VerdictOf(type, code)}");

                // * and read off the packet's own bytes, as its inspector reads them: its words where
                // it is unreadable, none otherwise
                Assert.Equal(
                    $"{name} 0x{code:X2}: {(expected == MqttAcknowledgementVerdict.Unreadable ? words : "none")}",
                    $"{name} 0x{code:X2}: {MqttPackets.UnreadableOf(AcknowledgementOf(type, [(byte)code])) ?? "none"}");
            }
        }
    }

    [Fact]
    public void Trips_on_an_acknowledgement_of_a_code_under_0x80_its_table_does_not_name_or_of_a_count_of_codes_other_than_one_handing_on_what_came_before_it()
    {
        const string Unnamed = "a Reason Code its table does not name";

        (byte[] Bytes, string Reason)[] cases =
        [
            ([0x40, 0x03, 0x00, 0x01, 0x01], $"a PUBACK of 0x01, {Unnamed}"),

            // its reserved flags set: judged by its type alone
            ([0x42, 0x03, 0x00, 0x01, 0x01], $"a PUBACK of 0x01, {Unnamed}"),
            ([0x90, 0x04, 0x00, 0x01, 0x00, 0x03], $"a SUBACK of 0x03, {Unnamed}"),

            // a property MQTT 5 does not define passed over, its code judged all the same
            ([0x90, 0x06, 0x00, 0x01, 0x02, 0x7F, 0x00, 0x03], $"a SUBACK of 0x03, {Unnamed}"),
            ([0xB0, 0x04, 0x00, 0x01, 0x00, 0x01], $"an UNSUBACK of 0x01, {Unnamed}"),

            // * a count other than one, whatever its codes
            ([0x90, 0x05, 0x00, 0x01, 0x00, 0x01, 0x01], "a SUBACK of 2 Reason Codes for one filter"),
            ([0x90, 0x05, 0x00, 0x01, 0x00, 0x01, 0x87], "a SUBACK of 2 Reason Codes for one filter"),
            ([0xB0, 0x05, 0x00, 0x01, 0x00, 0x00, 0x11], "an UNSUBACK of 2 Reason Codes for one filter"),
            ([0x90, 0x03, 0x00, 0x01, 0x00], "a SUBACK of no Reason Code"),
            ([0xB0, 0x03, 0x00, 0x01, 0x00], "an UNSUBACK of no Reason Code"),

            // ! no Property Length at all, so no code
            ([0xB0, 0x02, 0x00, 0x01], "an UNSUBACK of no Reason Code"),

            // ! a Property Length still continuing at its body's last byte, which leaves no room for
            // a code
            ([0x90, 0x03, 0x00, 0x01, 0x80], "a SUBACK of no Reason Code"),
            ([0xB0, 0x03, 0x00, 0x01, 0x80], "an UNSUBACK of no Reason Code"),
        ];

        // * each packet judged whole, as MQTTnet's inspector hands it on its own: one before it, a
        // PINGRESP, never judged, so MQTTnet hands it on
        Assert.Null(MqttPackets.UnreadableOf([0xD0, 0x00]));

        foreach (var (bytes, reason) in cases)
        {
            Assert.Equal(reason, MqttPackets.UnreadableOf(bytes));
        }

        // and nothing its table names trips it: a PUBACK of none, Remaining Length 2, is 0x00, and
        // one of 0x95 a refusal
        Assert.Null(MqttPackets.UnreadableOf([0x40, 0x02, 0x00, 0x01]));
        Assert.Null(MqttPackets.UnreadableOf([0x40, 0x03, 0x00, 0x01, 0x95]));
        Assert.Null(MqttPackets.UnreadableOf([0x90, 0x04, 0x00, 0x01, 0x00, 0x01]));
    }

    [Fact]
    public void Leaves_to_the_library_an_acknowledgement_whose_Property_Length_it_cannot_follow_judging_nothing_more()
    {
        // * a Property Length past its body, and one still continuing at its fourth byte: MQTTnet's
        // to refuse, which ends the link, so that no packet after it is read
        Assert.Null(MqttPackets.UnreadableOf([0x90, 0x03, 0x00, 0x01, 0x05]));
        Assert.Null(MqttPackets.UnreadableOf([0x90, 0x07, 0x00, 0x01, 0x80, 0x80, 0x80, 0x80, 0x01]));

        // and so is a Remaining Length past what came, or still continuing at its fourth byte, and a
        // PUBACK too short for its identifier
        Assert.Null(MqttPackets.UnreadableOf([]));
        Assert.Null(MqttPackets.UnreadableOf([0x40]));
        Assert.Null(MqttPackets.UnreadableOf([0x40, 0x03, 0x00, 0x01]));
        Assert.Null(MqttPackets.UnreadableOf([0xB0, 0x80]));
        Assert.Null(MqttPackets.UnreadableOf([0xB0, 0xFF, 0xFF, 0xFF, 0xFF, 0x01]));
        Assert.Null(MqttPackets.UnreadableOf([0x40, 0x01, 0x00]));

        // any other packet, a PUBLISH or a CONNACK, is none of its
        Assert.Null(MqttPackets.UnreadableOf([0x30, 0x05, 0x00, 0x01, 0x61, 0x00, 0x01]));
        Assert.Null(MqttPackets.UnreadableOf([0x20, 0x03, 0x00, 0x01, 0x00]));
    }

    // an acknowledgement of the packet type given, its identifier 1: a PUBACK of one code, its
    // Remaining Length 3, or a SUBACK or an UNSUBACK of no property and the codes given
    private static byte[] AcknowledgementOf(int type, byte[] codes)
    {
        byte[] body = type == MqttPackets.PubAck ? [0x00, 0x01, .. codes] : [0x00, 0x01, 0x00, .. codes];

        return [(byte)(type << 4), (byte)body.Length, .. body];
    }

    // a vector's count, or none for null
    private static string Written(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Null ? "none" : value.GetInt64().ToString(CultureInfo.InvariantCulture);
    }
}
