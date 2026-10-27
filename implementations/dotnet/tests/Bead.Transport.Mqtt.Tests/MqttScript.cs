using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using MQTTnet.Adapter;
using MQTTnet.Formatter;
using MQTTnet.Formatter.V5;
using MQTTnet.Packets;
using MQTTnet.Protocol;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// A scripted MQTT 5 peer on the loopback, which the adapter's tests play a broker with: each
/// link's packets read as they come, decoded by MQTTnet's own decoder, each answer written by the
/// test through its own encoder, so that a CONNACK, a PUBACK withheld or a DISCONNECT is the test's
/// own and nothing a real broker does hides what the adapter sends. The TypeScript side's
/// <c>mqtt-script</c> plays its tests alike.
/// </summary>
internal sealed class MqttScript : IAsyncDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly X509Certificate2? _certificate;
    private readonly List<ScriptedLink> _links = [];
    private readonly List<ScriptedLink> _every = [];
    private readonly SemaphoreSlim _arrived = new(0);
    private readonly CancellationTokenSource _closing = new();
    private Task? _accepting;

    private MqttScript(X509Certificate2? certificate)
    {
        _certificate = certificate;
    }

    /// <summary>Where it listens: <c>mqtt://127.0.0.1:…</c>, or <c>mqtts://127.0.0.1:…</c> under a certificate.</summary>
    public Uri Uri { get; private set; } = new("mqtt://127.0.0.1");

    /// <summary>A script on a port of its own, over TCP, or over TLS under <paramref name="certificate"/>.</summary>
    public static MqttScript Start(X509Certificate2? certificate = null)
    {
        var script = new MqttScript(certificate);

        script._listener.Start();
        script.Uri = new Uri($"{(certificate is null ? "mqtt" : "mqtts")}://127.0.0.1:{((IPEndPoint)script._listener.LocalEndpoint).Port}");
        script._accepting = script.Accepting();

        return script;
    }

    /// <summary>The next link that came, its CONNECT read, within its wait; it fails when none came.</summary>
    public async Task<ScriptedLink> Link(TimeSpan? within = null)
    {
        if (!await _arrived.WaitAsync(within ?? Patience, TestContext.Current.CancellationToken))
        {
            throw new TimeoutException("no link came within its time");
        }

        lock (_links)
        {
            var link = _links[0];

            _links.RemoveAt(0);

            return link;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _closing.CancelAsync();
        _listener.Stop();

        List<ScriptedLink> every;

        lock (_links)
        {
            every = [.. _every];
        }

        foreach (var link in every)
        {
            link.Cut();
        }

        if (_accepting is not null)
        {
            try
            {
                await _accepting;
            }
            catch (Exception reason) when (reason is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                // its listener stopped
            }
        }

        _arrived.Dispose();
        _closing.Dispose();
    }

    private async Task Accepting()
    {
        while (!_closing.IsCancellationRequested)
        {
            var socket = await _listener.AcceptSocketAsync(_closing.Token);

            _ = Accepted(socket);
        }
    }

    // a link that came: over TLS where the script has a certificate, its CONNECT read before it is handed on
    private async Task Accepted(Socket socket)
    {
        try
        {
            Stream stream = new NetworkStream(socket, ownsSocket: false);

            if (_certificate is not null)
            {
                var secured = new SslStream(stream, false, (_, certificate, _, _) =>
                {
                    // a client certificate is taken whatever its chain: the test reads what came
                    return certificate is not null;
                });

                await secured.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = _certificate, ClientCertificateRequired = true }, _closing.Token);
                stream = secured;
            }

            var link = new ScriptedLink(socket, stream);

            lock (_links)
            {
                _every.Add(link);
            }

            link.Read();
            await link.Next<MqttConnectPacket>();

            lock (_links)
            {
                _links.Add(link);
            }

            _arrived.Release();
        }
        catch (Exception reason) when (reason is IOException or SocketException or TimeoutException or OperationCanceledException or System.Security.Authentication.AuthenticationException or ObjectDisposedException)
        {
            socket.Dispose();
        }
    }
}

/// <summary>One network connection to the script: what came on it, and what the test writes back.</summary>
internal sealed class ScriptedLink
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private readonly Socket _socket;
    private readonly Stream _stream;
    private readonly List<MqttPacket> _packets = [];
    private readonly List<MqttPacket> _unread = [];
    private readonly Lock _gate = new();
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TaskCompletionSource _heard = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // the last write, which the next goes after
    private Task _written = Task.CompletedTask;

    internal ScriptedLink(Socket socket, Stream stream)
    {
        _socket = socket;
        _stream = stream;
    }

    /// <summary>Its CONNECT, the first packet that came.</summary>
    public MqttConnectPacket Connect
    {
        get
        {
            lock (_packets)
            {
                return (MqttConnectPacket)_packets[0];
            }
        }
    }

    /// <summary>Every packet that came, in its order, as it stands.</summary>
    public IReadOnlyList<MqttPacket> Packets
    {
        get
        {
            lock (_packets)
            {
                return [.. _packets];
            }
        }
    }

    /// <summary>Settles once the adapter's end closed.</summary>
    public Task Closed
    {
        get
        {
            return _closed.Task;
        }
    }

    /// <summary>A CONNACK of 0x00 as a broker that limits nothing writes it, every property its default.</summary>
    public static MqttConnAckPacket ConnAck()
    {
        return new MqttConnAckPacket
        {
            ReasonCode = MqttConnectReasonCode.Success,
            MaximumQoS = MqttQualityOfServiceLevel.ExactlyOnce,
            RetainAvailable = true,
            SharedSubscriptionAvailable = true,
            SubscriptionIdentifiersAvailable = true,
            WildcardSubscriptionAvailable = true,
        };
    }

    /// <summary>The packets of a kind that came, as they stand.</summary>
    public List<T> PacketsOf<T>()
        where T : MqttPacket
    {
        return [.. Packets.OfType<T>()];
    }

    /// <summary>Ends it at once, as a broker that drops a link does, its socket reset.</summary>
    public void Cut()
    {
        try
        {
            _socket.LingerState = new LingerOption(true, 0);
            _socket.Close();
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            // closed already
        }
    }

    /// <summary>Ends it once what was written went, as a broker that closes a link does.</summary>
    public void End()
    {
        try
        {
            _socket.Shutdown(SocketShutdown.Both);
            _socket.Close();
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            // closed already
        }
    }

    /// <summary>The next packet of <typeparamref name="T"/> that comes, skipping others, within its wait.</summary>
    public async Task<T> Next<T>(TimeSpan? within = null)
        where T : MqttPacket
    {
        var deadline = DateTimeOffset.UtcNow + (within ?? Patience);

        while (true)
        {
            Task heard;

            lock (_packets)
            {
                var at = _unread.FindIndex((packet) =>
                {
                    return packet is T;
                });

                if (at >= 0)
                {
                    var packet = (T)_unread[at];

                    _unread.RemoveRange(0, at + 1);

                    return packet;
                }

                heard = _heard.Task;
            }

            var left = deadline - DateTimeOffset.UtcNow;

            if (left <= TimeSpan.Zero || _closed.Task.IsCompleted)
            {
                throw new TimeoutException($"no {typeof(T).Name} came within its time");
            }

            await Task.WhenAny(heard, _closed.Task, Task.Delay(left, TestContext.Current.CancellationToken));
        }
    }

    /// <summary>Writes <paramref name="packet"/>, as MQTTnet's encoder writes MQTT 5.</summary>
    public Task Send(MqttPacket packet)
    {
        var encoded = new MqttV5PacketEncoder(new MqttBufferWriter(4_096, 65_536)).Encode(packet).Join();

        return Write(encoded.ToArray());
    }

    /// <summary>Writes <paramref name="bytes"/> as they are, for what no encoder writes.</summary>
    public Task Write(byte[] bytes)
    {
        lock (_gate)
        {
            _written = Writing((_written, bytes));

            return _written;
        }
    }

    /// <summary>Reads its packets as they come, until its end.</summary>
    internal void Read()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                while (await NextPacket() is { } packet)
                {
                    lock (_packets)
                    {
                        _packets.Add(packet);
                        _unread.Add(packet);
                        _heard.TrySetResult();
                        _heard = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    }
                }
            }
            catch (Exception reason) when (reason is IOException or SocketException or ObjectDisposedException)
            {
                // the adapter's end cut it
            }
            finally
            {
                _closed.TrySetResult();
            }
        });
    }

    // a write after the one before it
    private async Task Writing((Task Before, byte[] Bytes) write)
    {
        await write.Before;

        try
        {
            await _stream.WriteAsync(write.Bytes, TestContext.Current.CancellationToken);
            await _stream.FlushAsync(TestContext.Current.CancellationToken);
        }
        catch (Exception reason) when (reason is IOException or SocketException or ObjectDisposedException or NotSupportedException)
        {
            // the adapter's end closed it
        }
    }

    // one packet: its fixed header, its Remaining Length, its body, decoded; none at its end
    private async Task<MqttPacket?> NextPacket()
    {
        var header = new byte[1];

        if (!await Filled(header))
        {
            return null;
        }

        var remaining = 0;
        var multiplier = 1;
        var length = 1;
        var one = new byte[1];

        do
        {
            if (!await Filled(one))
            {
                return null;
            }

            remaining += (one[0] & 0x7F) * multiplier;
            multiplier *= 128;
            length += 1;
        }
        while ((one[0] & 0x80) != 0);

        var body = new byte[remaining];

        if (remaining > 0 && !await Filled(body))
        {
            return null;
        }

        return new MqttV5PacketDecoder().Decode(new ReceivedMqttPacket(header[0], new ArraySegment<byte>(body), length + remaining));
    }

    private async Task<bool> Filled(byte[] buffer)
    {
        var read = 0;

        while (read < buffer.Length)
        {
            var count = await _stream.ReadAsync(buffer.AsMemory(read));

            if (count == 0)
            {
                return false;
            }

            read += count;
        }

        return true;
    }
}
