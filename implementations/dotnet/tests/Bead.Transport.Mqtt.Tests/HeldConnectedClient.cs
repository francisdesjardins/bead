using MQTTnet;
using MQTTnet.Diagnostics.PacketInspection;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// MQTTnet's client, which a test can hold saying it connected once its link is lost: the moment
/// MQTTnet itself says so, between failing what awaits that link and marking it disconnected,
/// held as long as the test asks. It counts the DISCONNECTs it was asked.
/// </summary>
internal sealed class HeldConnectedClient(IMqttClient inner) : IMqttClient
{
    private int _disconnects;

    public event Func<MqttApplicationMessageReceivedEventArgs, Task> ApplicationMessageReceivedAsync
    {
        add
        {
            inner.ApplicationMessageReceivedAsync += value;
        }
        remove
        {
            inner.ApplicationMessageReceivedAsync -= value;
        }
    }

    public event Func<MqttClientConnectedEventArgs, Task> ConnectedAsync
    {
        add
        {
            inner.ConnectedAsync += value;
        }
        remove
        {
            inner.ConnectedAsync -= value;
        }
    }

    public event Func<MqttClientConnectingEventArgs, Task> ConnectingAsync
    {
        add
        {
            inner.ConnectingAsync += value;
        }
        remove
        {
            inner.ConnectingAsync -= value;
        }
    }

    public event Func<MqttClientDisconnectedEventArgs, Task> DisconnectedAsync
    {
        add
        {
            inner.DisconnectedAsync += value;
        }
        remove
        {
            inner.DisconnectedAsync -= value;
        }
    }

    public event Func<InspectMqttPacketEventArgs, Task> InspectPacketAsync
    {
        add
        {
            inner.InspectPacketAsync += value;
        }
        remove
        {
            inner.InspectPacketAsync -= value;
        }
    }

    /// <summary>Whether it says it connected whatever MQTTnet says.</summary>
    public bool IsHeld { get; set; }

    /// <summary>The DISCONNECTs it was asked.</summary>
    public int Disconnects
    {
        get
        {
            return Volatile.Read(ref _disconnects);
        }
    }

    public bool IsConnected
    {
        get
        {
            return IsHeld || inner.IsConnected;
        }
    }

    public MqttClientOptions Options
    {
        get
        {
            return inner.Options;
        }
    }

    public Task<MqttClientConnectResult> ConnectAsync(MqttClientOptions options, CancellationToken cancellationToken = default)
    {
        return inner.ConnectAsync(options, cancellationToken);
    }

    public Task DisconnectAsync(MqttClientDisconnectOptions options, CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref _disconnects);

        return inner.DisconnectAsync(options, cancellationToken);
    }

    public Task PingAsync(CancellationToken cancellationToken = default)
    {
        return inner.PingAsync(cancellationToken);
    }

    public Task<MqttClientPublishResult> PublishAsync(MqttApplicationMessage applicationMessage, CancellationToken cancellationToken = default)
    {
        return inner.PublishAsync(applicationMessage, cancellationToken);
    }

    public Task SendEnhancedAuthenticationExchangeDataAsync(MqttEnhancedAuthenticationExchangeData data, CancellationToken cancellationToken = default)
    {
        return inner.SendEnhancedAuthenticationExchangeDataAsync(data, cancellationToken);
    }

    public Task<MqttClientSubscribeResult> SubscribeAsync(MqttClientSubscribeOptions options, CancellationToken cancellationToken = default)
    {
        return inner.SubscribeAsync(options, cancellationToken);
    }

    public Task<MqttClientUnsubscribeResult> UnsubscribeAsync(MqttClientUnsubscribeOptions options, CancellationToken cancellationToken = default)
    {
        return inner.UnsubscribeAsync(options, cancellationToken);
    }

    public void Dispose()
    {
        inner.Dispose();
    }
}
