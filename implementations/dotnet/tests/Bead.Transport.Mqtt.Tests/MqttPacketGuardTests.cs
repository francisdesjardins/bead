using System.Buffers;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using MQTTnet.Channel;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The guard on its own (spec 15.29, 15.30), over a channel that gives scripted reads: each packet
/// judged at its Remaining Length, before its body; what came before one past its bound handed on,
/// that packet told once and nothing more read; a packet within its bound passed as it came. The
/// TypeScript side's <c>mqtt-packet-guard</c> plays the same sentences.
/// </summary>
public sealed class MqttPacketGuardTests
{
    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // a guard of the bound given over the reads given, what it tells recorded
    private static (MqttPacketGuard Guard, ScriptedChannel Channel, List<long> Told) GuardOf((long Maximum, byte[][] Reads) guarded)
    {
        var channel = new ScriptedChannel(guarded.Reads);
        var told = new List<long>();

        return (new MqttPacketGuard(channel, new MqttPacketGuardOptions { MaximumPacketSize = guarded.Maximum, PastMaximum = told.Add }), channel, told);
    }

    // what each read hands on, as MQTTnet asks it, into a buffer of its own, until one hands on nothing
    private static async Task<List<byte[]>> HandedOn(MqttPacketGuard guard)
    {
        var handed = new List<byte[]>();

        while (true)
        {
            var buffer = new byte[4_096];
            var read = await guard.ReadAsync(buffer, 0, buffer.Length, Cancelled);

            if (read == 0)
            {
                return handed;
            }

            handed.Add(buffer[..read]);
        }
    }

    // definition

    [Fact]
    public async Task Refuses_a_packet_past_its_bound_as_its_Remaining_Length_is_read()
    {
        // * 32 E5 07: a PUBLISH of 997 bytes after its header, 1,000 in all
        byte[] header = [0x32, 0xE5, 0x07];

        var (past, _, pastTold) = GuardOf((999, [header, [0x00]]));

        Assert.Empty(await HandedOn(past));
        Assert.Equal([1_000L], pastTold);

        var (within, withinChannel, withinTold) = GuardOf((1_000, [header, [0x00, 0x01]]));

        Assert.Equal([header, [0x00, 0x01]], await HandedOn(within));
        Assert.Empty(withinTold);
        Assert.Equal(3, withinChannel.Reads);

        // the same header one byte a read: 32 and E5 handed on as they came, 07 and every byte after it withheld
        var (split, splitChannel, splitTold) = GuardOf((999, [[0x32], [0xE5], [0x07], [0x00]]));

        Assert.Equal([[0x32], [0xE5]], await HandedOn(split));
        Assert.Equal([1_000L], splitTold);
        Assert.Equal(3, splitChannel.Reads);

        // a packet within its bound, then that header, in one read: the first handed on whole, the
        // second told at the next read, which reads nothing
        var (after, afterChannel, afterTold) = GuardOf((999, [[0xD0, 0x00, .. header], [0x00]]));
        var buffer = new byte[16];

        Assert.Equal(2, await after.ReadAsync(buffer, 0, buffer.Length, Cancelled));
        Assert.Equal([0xD0, 0x00], buffer[..2]);
        Assert.Empty(afterTold);
        Assert.Equal(0, await after.ReadAsync(buffer, 0, buffer.Length, Cancelled));
        Assert.Equal([1_000L], afterTold);
        Assert.Equal(0, await after.ReadAsync(buffer, 0, buffer.Length, Cancelled));
        Assert.Equal([1_000L], afterTold);
        Assert.Equal(1, afterChannel.Reads);
    }

    [Fact]
    public async Task Refuses_a_packet_past_its_bound_whatever_its_kind()
    {
        // * a first byte of type 0, reserved: refused as past its bound, never as malformed
        var (guard, channel, told) = GuardOf((1_000, [[0x00, 0x80, 0x80, 0x80, 0x08], [0x00]]));

        Assert.Empty(await HandedOn(guard));
        Assert.Equal([16_777_221L], told);
        Assert.Equal(1, channel.Reads);
    }

    [Fact]
    public async Task Reads_a_packet_at_its_bound_and_the_next_in_the_same_read_as_they_came()
    {
        // * a PUBLISH of 1,100 bytes in all, 1 + 2 + 1,097, then a PINGRESP
        var publish = new byte[1_100];

        publish[0] = 0x32;
        publish[1] = 0xC9;
        publish[2] = 0x08;

        byte[] read = [.. publish, 0xD0, 0x00];
        byte[] next = [0x30, 0x02, 0x00, 0x00];
        var (guard, _, told) = GuardOf((1_100, [read, next]));

        Assert.Equal([read, next], await HandedOn(guard));
        Assert.Empty(told);

        // a Remaining Length of five bytes, malformed: handed on, MQTTnet's to refuse, and nothing judged after it
        byte[] malformed = [0x30, 0x80, 0x80, 0x80, 0x80, 0x01];
        byte[] past = [0x32, 0x80, 0x80, 0x80, 0x08];
        var (lenient, _, lenientTold) = GuardOf((1_100, [malformed, past]));

        Assert.Equal([malformed, past], await HandedOn(lenient));
        Assert.Empty(lenientTold);
    }

    // a channel whose reads are the ones given, each whole, then its end
    private sealed class ScriptedChannel(byte[][] scripted) : IMqttChannel
    {
        private readonly Queue<byte[]> _reads = new(scripted);

        // how many reads it was asked
        public int Reads { get; private set; }

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

        public Task ConnectAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task DisconnectAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task WriteAsync(ReadOnlySequence<byte> buffer, bool isEndOfPacket, CancellationToken cancellationToken)
        {
            throw new NotSupportedException();
        }

        public Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            Reads += 1;

            if (!_reads.TryDequeue(out var read))
            {
                return Task.FromResult(0);
            }

            Assert.True(read.Length <= count, "a scripted read fits what is asked");
            read.CopyTo(buffer, offset);

            return Task.FromResult(read.Length);
        }

        public void Dispose()
        {
            // nothing held
        }
    }
}
