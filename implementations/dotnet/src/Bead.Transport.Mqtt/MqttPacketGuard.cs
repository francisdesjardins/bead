using System.Buffers;
using System.Globalization;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using MQTTnet;
using MQTTnet.Adapter;
using MQTTnet.Channel;
using MQTTnet.Diagnostics.Logger;
using MQTTnet.Formatter;
using MQTTnet.Implementations;

namespace Bead.Transport.Mqtt;

/// <summary>What a guard judges each received packet against, and what it tells once one passes it.</summary>
internal sealed record MqttPacketGuardOptions
{
    /// <summary>Its participant's own Maximum Packet Size, its CONNECT's, never its CONNACK's.</summary>
    public required long MaximumPacketSize { get; init; }

    /// <summary>Told once, with the packet's size, as the first packet past it is judged.</summary>
    public required Action<long> PastMaximum { get; init; }
}

/// <summary>
/// The adapters of a client of MQTTnet, each over its channel under a <see cref="MqttPacketGuard"/>:
/// what MQTTnet's own factory builds, the guard between its channel and its reader.
/// </summary>
internal sealed class GuardedAdapterFactory(MqttPacketGuardOptions guarded) : IMqttClientAdapterFactory
{
    /// <summary>A channel over TCP or a WebSocket, as its options say, guarded, under MQTTnet's own reader.</summary>
    public IMqttChannelAdapter CreateClientAdapter(MqttClientOptions options, MqttPacketInspector packetInspector, IMqttNetLogger logger)
    {
        ArgumentNullException.ThrowIfNull(options);

        // ! it mirrors MQTTnet's own MqttClientAdapterFactory, which a bump of MQTTnet re-reads
        IMqttChannel channel = options.ChannelOptions switch
        {
            MqttClientTcpOptions => new MqttTcpChannel(options),
            MqttClientWebSocketOptions webSocket => new MqttWebSocketChannel(webSocket),
            _ => throw new NotSupportedException(string.Create(CultureInfo.InvariantCulture, $"MQTTnet carries no channel of {options.ChannelOptions?.GetType().Name}")),
        };
        var formatter = new MqttPacketFormatterAdapter(options.ProtocolVersion, new MqttBufferWriter(options.WriterBufferSize, options.WriterBufferSizeMax));

        return new MqttChannelAdapter(new MqttPacketGuard(channel, guarded), formatter, logger)
        {
            AllowPacketFragmentation = options.AllowPacketFragmentation,
            PacketInspector = packetInspector,
        };
    }
}

/// <summary>
/// A channel that reads each received packet's fixed header as it passes and counts its size,
/// <c>1 + v(R) + R</c>, as soon as its Remaining Length is whole, before any byte of its body
/// (spec 15.29, 15.30). Past its bound, it hands on what came before that packet's first byte, tells
/// it once, and reads nothing more: every later read is 0, the end MQTTnet reads as its connection
/// closed. A packet within its bound passes untouched, in the reads it came in; a Remaining Length
/// whose fourth byte still has its continuation bit, malformed, passes on to MQTTnet, which refuses
/// it, and nothing more is judged. It writes nothing. The TypeScript side's
/// <c>mqtt-packet-guard</c> reads alike.
/// </summary>
internal sealed class MqttPacketGuard(IMqttChannel inner, MqttPacketGuardOptions options) : IMqttChannel
{
    // the widest fixed header: its first byte and a Remaining Length of four bytes (MQTT 5.0 §1.5.5)
    private const int WidestHeader = 5;

    // the fixed header read so far: its bytes, its first among them, and its Remaining Length so far
    private int _width;
    private long _length;

    // the body bytes of the packet passing that are still to come
    private long _rest;

    // whether it still judges: no more once a Remaining Length is malformed
    private bool _isJudging = true;

    // the size of a packet past its bound, told at the next read where bytes came before it
    private long _pastMaximum;
    private bool _isTripped;

    /// <inheritdoc/>
    public X509Certificate2 ClientCertificate
    {
        get
        {
            return inner.ClientCertificate;
        }
    }

    /// <inheritdoc/>
    public EndPoint RemoteEndPoint
    {
        get
        {
            return inner.RemoteEndPoint;
        }
    }

    /// <inheritdoc/>
    public EndPoint LocalEndPoint
    {
        get
        {
            return inner.LocalEndPoint;
        }
    }

    /// <inheritdoc/>
    public bool IsSecureConnection
    {
        get
        {
            return inner.IsSecureConnection;
        }
    }

    /// <inheritdoc/>
    public Task ConnectAsync(CancellationToken cancellationToken)
    {
        return inner.ConnectAsync(cancellationToken);
    }

    /// <inheritdoc/>
    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        return inner.DisconnectAsync(cancellationToken);
    }

    /// <inheritdoc/>
    public Task WriteAsync(ReadOnlySequence<byte> buffer, bool isEndOfPacket, CancellationToken cancellationToken)
    {
        return inner.WriteAsync(buffer, isEndOfPacket, cancellationToken);
    }

    /// <summary>
    /// What its channel read, up to the first byte of a packet past its bound; that packet told and
    /// 0 from then on, nothing more read.
    /// </summary>
    public async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        if (_isTripped)
        {
            return 0;
        }

        if (_pastMaximum > 0)
        {
            return Trip();
        }

        var read = await inner.ReadAsync(buffer, offset, count, cancellationToken).ConfigureAwait(false);

        if (!_isJudging || read <= 0)
        {
            return read;
        }

        var end = offset + read;

        // * a fixed header's first byte, then its Remaining Length, a Variable Byte Integer of one to
        // four bytes, seven bits each, least significant first (MQTT 5.0 §2.1.4, §1.5.5); its body
        // passed over, never held
        for (var at = offset; at < end; at++)
        {
            if (_rest > 0)
            {
                var passed = (int)Math.Min(_rest, end - at);

                _rest -= passed;
                at += passed - 1;

                continue;
            }

            if (_width == 0)
            {
                _width = 1;
                _length = 0;

                continue;
            }

            var digit = buffer[at];

            _length += (long)(digit & 0x7F) << (7 * (_width - 1));
            _width += 1;

            if ((digit & 0x80) != 0)
            {
                // ! malformed: MQTTnet refuses it and ends the link; nothing more is judged
                if (_width == WidestHeader)
                {
                    _isJudging = false;

                    return read;
                }

                continue;
            }

            var size = _width + _length;
            var first = at + 1 - _width;

            _width = 0;

            if (size > options.MaximumPacketSize)
            {
                _pastMaximum = size;

                // header bytes of it that came in an earlier read were handed on already
                return first > offset ? first - offset : Trip();
            }

            _rest = _length;
        }

        return read;
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        inner.Dispose();
    }

    // the packet past its bound told, once, and nothing read from then on
    private int Trip()
    {
        _isTripped = true;
        options.PastMaximum(_pastMaximum);

        return 0;
    }
}
