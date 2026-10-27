namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The Mosquitto of the run's own that <c>tools/mqtt-broker.mjs</c> starts, as its variables name it
/// (spec 15.31): what every test that needs a broker plays against, skipped, saying so, where none
/// is given — unless <c>BEAD_MQTT_REQUIRED=1</c> asks for one, and then it fails, saying so, as
/// <c>BEAD_INTEROP_REQUIRED=1</c> fails the interop. The TypeScript side reads the same variables.
/// </summary>
internal static class MqttFixture
{
    /// <summary>What a test that needs a broker says as it is skipped.</summary>
    public const string Reason = "no broker: BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)";

    /// <summary>Whether a broker is given, or asked for, so that its tests run, and fail where none is.</summary>
    public static bool IsGiven
    {
        get
        {
            return Environment.GetEnvironmentVariable("BEAD_MQTT_URL") is { Length: > 0 } || Environment.GetEnvironmentVariable("BEAD_MQTT_REQUIRED") == "1";
        }
    }

    /// <summary>Its MQTT listener, over TCP.</summary>
    public static Uri Url
    {
        get
        {
            return new Uri(Required("BEAD_MQTT_URL"));
        }
    }

    /// <summary>Its WebSocket listener, of subprotocol <c>mqtt</c>.</summary>
    public static Uri WebSocketUrl
    {
        get
        {
            return new Uri(Required("BEAD_MQTT_WS_URL"));
        }
    }

    /// <summary>The password drawn for the run, every user's.</summary>
    public static string Password
    {
        get
        {
            return Required("BEAD_MQTT_PASSWORD");
        }
    }

    // a variable the run gives, or a failure naming it where BEAD_MQTT_REQUIRED=1 asked for a broker
    private static string Required(string name)
    {
        return Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"BEAD_MQTT_REQUIRED=1 asks for a broker, and {name} is not set (node tools/mqtt-broker.mjs start)");
    }
}
