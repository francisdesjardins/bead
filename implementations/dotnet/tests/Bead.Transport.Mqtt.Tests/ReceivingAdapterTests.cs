using System.Net;
using System.Security.Cryptography.X509Certificates;
using MQTTnet.Adapter;
using MQTTnet.Formatter;
using MQTTnet.Packets;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The adapter between MQTTnet's client and its reader on its own, over a reader that gives
/// scripted packets: MQTTnet's receive loop held past its CONNACK until its connect returned, so
/// that a packet ending its link beside its CONNACK is told by MQTTnet as a disconnect.
/// </summary>
public sealed class ReceivingAdapterTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // definition

    [Fact]
    public async Task Reads_nothing_past_its_CONNACK_until_its_connect_returned()
    {
        var returned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reader = new ScriptedReader([new MqttConnAckPacket(), new MqttPublishPacket { Topic = "bead/i/ada" }]);
        using var adapter = new ReceivingAdapter(reader, new MqttPacketGuardOptions
        {
            MaximumPacketSize = 1_024,
            PastMaximum = (_) =>
            {
            },
            Connected = returned.Task,
        });

        Assert.IsType<MqttConnAckPacket>(await adapter.ReceivePacketAsync(Cancelled));

        // * its receive loop's first read, held: nothing read of its reader meanwhile
        var next = adapter.ReceivePacketAsync(Cancelled);

        Assert.False(next.IsCompleted);
        Assert.Equal(1, reader.Reads);

        returned.SetResult();
        Assert.IsType<MqttPublishPacket>(await next.WaitAsync(Patience, Cancelled));
        Assert.Equal(2, reader.Reads);
    }

    // a reader whose packets are the ones given, then none, its connection's end
    private sealed class ScriptedReader(MqttPacket[] scripted) : IMqttChannelAdapter
    {
        private readonly Queue<MqttPacket> _packets = new(scripted);

        // how many packets it was asked
        public int Reads { get; private set; }

        public long BytesReceived
        {
            get
            {
                return 0;
            }
        }

        public long BytesSent
        {
            get
            {
                return 0;
            }
        }

        public X509Certificate2 ClientCertificate
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public EndPoint RemoteEndPoint
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public EndPoint LocalEndPoint
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public bool IsSecureConnection
        {
            get
            {
                return false;
            }
        }

        public MqttPacketFormatterAdapter PacketFormatterAdapter
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public Task ConnectAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task DisconnectAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task<MqttPacket> ReceivePacketAsync(CancellationToken cancellationToken)
        {
            Reads += 1;

            return Task.FromResult(_packets.TryDequeue(out var packet) ? packet : null!);
        }

        public void ResetStatistics()
        {
            // nothing counted
        }

        public Task SendPacketAsync(MqttPacket packet, CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }

        public void Dispose()
        {
            // nothing held
        }
    }
}
