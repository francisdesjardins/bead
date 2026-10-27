using System.Globalization;
using System.Text;
using System.Text.Json;
using Bead.Tests;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// The message profile of a parcel over AMQP 1.0 (spec 15.35, 15.37) against
/// <c>spec/vectors.json</c>'s <c>amqpMessages</c> and <c>amqpPublishBounds</c>, with no broker:
/// each message AMQPNetLite writes, to its every byte — the gate that fails the day an upgrade of it
/// writes another encoding — and each row's largest payload within its bound. The TypeScript side's
/// <c>amqp-messages</c> plays the same rows with the profile's writer of its own.
/// </summary>
public sealed class AmqpMessagesTests
{
    [Fact]
    public void Plays_amqpMessages_a_message_of_the_profile_written_to_its_every_byte()
    {
        var names = NamesOf("amqpMessages");

        Assert.NotEmpty(names);

        foreach (var name in names)
        {
            var vector = Vectors.Of("amqpMessages", name);
            var to = vector.GetProperty("to").GetString()!;
            var payload = Enumerable.Repeat(vector.GetProperty("payloadByte").GetByte(), vector.GetProperty("payloadLength").GetInt32()).ToArray();
            uint? ttl = vector.TryGetProperty("ttl", out var life) ? life.GetUInt32() : null;
            using var message = AmqpMessages.MessageOf((to, payload), ttl);
            var encoded = message.Encode();
            var written = encoded.Buffer.AsSpan(encoded.Offset, encoded.Length).ToArray();

            // * the row's name beside its bytes, so that a failure says which row
            Assert.Equal($"{name}: {Convert.ToHexString(Vectors.BytesOf(vector, "bytes"))}", $"{name}: {Convert.ToHexString(written)}");

            // ! and the count the formula gives is the bytes written: S is one formula on every side
            Assert.Equal(written.Length, AmqpMessages.MessageBytes((Encoding.UTF8.GetByteCount(to), payload.Length), ttl is not null) - (ttl is null ? 0 : 13 - HeaderOf(ttl.Value)));
        }
    }

    [Fact]
    public void Plays_amqpPublishBounds_the_largest_payload_within_a_bound_found_exactly()
    {
        var names = NamesOf("amqpPublishBounds");

        Assert.NotEmpty(names);

        foreach (var name in names)
        {
            var vector = Vectors.Of("amqpPublishBounds", name);
            var address = vector.GetProperty("address").GetString()!;
            var maximum = vector.GetProperty("maximumMessageSize").GetInt64();
            var largest = AmqpMessages.LargestPayload((address, maximum));
            var bytes = largest is { } payload ? AmqpMessages.MessageBytes((Encoding.UTF8.GetByteCount(address), payload), true) : (long?)null;

            Assert.Equal(
                $"{name}: payload {Written(vector.GetProperty("largestPayload"))}, message {Written(vector.GetProperty("messageBytes"))}",
                $"{name}: payload {largest?.ToString(CultureInfo.InvariantCulture) ?? "none"}, message {bytes?.ToString(CultureInfo.InvariantCulture) ?? "none"}");

            // ! exact: one byte more passes the bound, or the largest a Data section holds
            if (largest is { } found)
            {
                Assert.True(
                    AmqpMessages.MessageBytes((Encoding.UTF8.GetByteCount(address), found + 1), true) > maximum || found + 1 > AmqpMessages.LargestBound,
                    $"{name}: a payload of {found + 1} bytes passes its bound");
            }
        }
    }

    // a group's names, as its theory rows hold them
    private static List<string> NamesOf(string group)
    {
        return [.. Vectors.NamesOf(group).Select((row) =>
        {
            return row.Data;
        })];
    }

    // a header's exact bytes, which the count takes at 13 whatever its ttl: 9 for a ttl of 0, 10
    // under 256, 13 past it (AMQP 1.0 §1.6.4)
    private static int HeaderOf(uint ttl)
    {
        if (ttl == 0)
        {
            return 9;
        }

        return ttl < 256 ? 10 : 13;
    }

    // a vector's count, or none for null
    private static string Written(JsonElement value)
    {
        return value.ValueKind == JsonValueKind.Null ? "none" : value.GetInt64().ToString(CultureInfo.InvariantCulture);
    }
}
