using System.Buffers;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using MQTTnet;
using MQTTnet.Channel;
using MQTTnet.Implementations;

namespace Bead.Transport.Mqtt;

/// <summary>
/// The connect of a link over TCP, <c>mqtt</c> or <c>mqtts</c>: its broker's name raced (RFC 8305), a
/// localhost name connected to the loopback itself, asking no resolver (spec 13.4). MQTTnet layers
/// its TLS on the stream, its broker's name the server name.
/// </summary>
internal sealed class RacingStreamProvider : IMqttClientStreamProvider
{
    // the socket's settings, MQTTnet's own TCP channel's defaults
    private static readonly MqttClientTcpOptions Defaults = new();

    private RacingStreamProvider()
    {
    }

    /// <summary>The one every link shares: it holds nothing of a link's.</summary>
    public static RacingStreamProvider Instance { get; } = new();

    // one attempt at an address, its socket set before it connects, as MQTTnet's own channel sets it
    private static async Task<Socket> Attempt(IPEndPoint endPoint, CancellationToken cancellationToken)
    {
        // ! its buffers sized before it connects: shrunk on a connected socket, they stalled a
        // transfer of 3 MiB on Linux for good
        var socket = new Socket(endPoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
        {
            // ! its close a reset, as MQTTnet's own channel closes it
            LingerState = Defaults.LingerState,
            NoDelay = Defaults.NoDelay,
            ReceiveBufferSize = Defaults.BufferSize,
            SendBufferSize = Defaults.BufferSize,
        };

        try
        {
            await socket.ConnectAsync(endPoint, cancellationToken).ConfigureAwait(false);

            return socket;
        }
        catch
        {
            socket.Dispose();

            throw;
        }
    }

    /// <summary>A stream that owns the socket of the first attempt that connects to <paramref name="brokerEndPoint"/>.</summary>
    public async Task<Stream> ConnectAsync(EndPoint brokerEndPoint, CancellationToken cancellationToken)
    {
        var target = brokerEndPoint switch
        {
            DnsEndPoint named => named,
            IPEndPoint address => new DnsEndPoint(address.Address.ToString(), address.Port),
            _ => throw new NotSupportedException($"a link connects to a name or an address, not {brokerEndPoint?.GetType().Name}"),
        };
        var socket = await HappyEyeballs.ConnectAsync(target, new HappyEyeballsOptions
        {
            Connect = Attempt,
            CancellationToken = cancellationToken,
        }).ConfigureAwait(false);

        return new NetworkStream(socket, ownsSocket: true);
    }
}

/// <summary>
/// The channel of a link over a WebSocket, <c>ws</c> or <c>wss</c>: its upgrade sent through the
/// adapter's handler, which races its broker's name and connects a host on the loopback to the
/// loopback itself, through no proxy (spec 13.4), under the adapter's TLS; its reads and writes
/// MQTTnet's own channel's, over that socket.
/// </summary>
internal sealed class RacingWebSocketChannel(MqttClientWebSocketOptions options, HttpMessageInvoker upgrading) : IMqttChannel
{
    private MqttWebSocketChannel? _inner;

    /// <inheritdoc/>
    public X509Certificate2 ClientCertificate
    {
        get
        {
            return null!;
        }
    }

    /// <inheritdoc/>
    public EndPoint RemoteEndPoint
    {
        get
        {
            return _inner?.RemoteEndPoint!;
        }
    }

    /// <inheritdoc/>
    public EndPoint LocalEndPoint
    {
        get
        {
            return _inner?.LocalEndPoint!;
        }
    }

    /// <inheritdoc/>
    public bool IsSecureConnection
    {
        get
        {
            return options.Uri.StartsWith("wss://", StringComparison.OrdinalIgnoreCase);
        }
    }

    // the channel it reads and writes through, once connected
    private MqttWebSocketChannel Connected
    {
        get
        {
            return _inner ?? throw new InvalidOperationException("the WebSocket of the link is not connected");
        }
    }

    /// <summary>
    /// Connects its WebSocket through the adapter's handler, offering its subprotocols with its
    /// request headers and its keep-alive, as MQTTnet's own channel sets them.
    /// </summary>
    public async Task ConnectAsync(CancellationToken cancellationToken)
    {
        // ! beside an invoker, a ClientWebSocket's proxy, credentials, cookies, certificates and
        // validation callback each throw: the handler holds them
        var socket = new ClientWebSocket();

        try
        {
            foreach (var protocol in options.SubProtocols ?? [])
            {
                socket.Options.AddSubProtocol(protocol);
            }

            foreach (var header in options.RequestHeaders ?? new Dictionary<string, string>())
            {
                socket.Options.SetRequestHeader(header.Key, header.Value);
            }

            if (options.KeepAliveInterval != WebSocket.DefaultKeepAliveInterval)
            {
                socket.Options.KeepAliveInterval = options.KeepAliveInterval;
            }

            await socket.ConnectAsync(new Uri(options.Uri), upgrading, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            socket.Dispose();

            throw;
        }

        _inner = new MqttWebSocketChannel(socket, null, IsSecureConnection, null);
    }

    /// <inheritdoc/>
    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        return _inner?.DisconnectAsync(cancellationToken) ?? Task.CompletedTask;
    }

    /// <inheritdoc/>
    public Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        return Connected.ReadAsync(buffer, offset, count, cancellationToken);
    }

    /// <inheritdoc/>
    public Task WriteAsync(ReadOnlySequence<byte> buffer, bool isEndOfPacket, CancellationToken cancellationToken)
    {
        return Connected.WriteAsync(buffer, isEndOfPacket, cancellationToken);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _inner?.Dispose();
    }
}
