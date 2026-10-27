using Bead.Transport.Mqtt;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The places of MQTT 5's adapter (spec 15.26, 15.30): its Keep Alive, held in whole seconds up to
/// 65,535, and the wait for its CONNACK, each on MQTTnet's own timer, so taken or refused as it is
/// built, never without end.
/// </summary>
public sealed partial class DurationsTests
{
    // an adapter to a broker it never links to, built with the options given
    private static Observed AdapterOf(Func<MqttBrokerAdapterOptions, MqttBrokerAdapterOptions> given)
    {
        try
        {
            _ = new MqttBrokerAdapter(given(new MqttBrokerAdapterOptions { Id = "ada", Uri = new Uri("mqtt://127.0.0.1:1883") }));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        return Taken();
    }

    // mqttBrokerAdapter.keepAlive

    // the adapter's options, as it is built: taken or refused
    private static Task<Observed> KeepAliveByOptions(TimeSpan? given)
    {
        return Task.FromResult(AdapterOf((options) =>
        {
            return options with { KeepAlive = Assert.NotNull(given) };
        }));
    }

    // mqttBrokerAdapter.connectTimeout

    // the adapter's options, as it is built: taken or refused
    private static Task<Observed> MqttConnectTimeoutByOptions(TimeSpan? given)
    {
        return Task.FromResult(AdapterOf((options) =>
        {
            return options with { ConnectTimeout = Assert.NotNull(given) };
        }));
    }
}
