using System.Buffers.Binary;
using System.Net.WebSockets;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="FrameMeter"/>, alone and below .NET's reader: the frames it reads, however reads cut
/// them, and what it charges of a message partway.
/// </summary>
public sealed class FrameMeterTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // a masking key, as a client draws one (RFC 6455 §5.3)
    private static readonly byte[] Key = [0x37, 0xFA, 0x21, 0x3D];

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // a masked frame of the first byte and the payload given, its length in 7, 16 or 64 bits, the
    // shortest it fits, or 64 when told
    private static byte[] FrameOf((byte First, byte[] Payload, bool IsLong) given)
    {
        var (first, payload, isLong) = given;
        var head = new List<byte> { first };

        if (isLong || payload.Length > ushort.MaxValue)
        {
            var length = new byte[8];

            BinaryPrimitives.WriteUInt64BigEndian(length, (ulong)payload.Length);
            head.Add(0x80 | 127);
            head.AddRange(length);
        }
        else if (payload.Length > 125)
        {
            var length = new byte[2];

            BinaryPrimitives.WriteUInt16BigEndian(length, (ushort)payload.Length);
            head.Add(0x80 | 126);
            head.AddRange(length);
        }
        else
        {
            head.Add((byte)(0x80 | payload.Length));
        }

        head.AddRange(Key);

        return [.. head, .. payload.Select((octet, index) =>
        {
            return (byte)(octet ^ Key[index % Key.Length]);
        })];
    }

    // the payload of n octets, each its index's low byte
    private static byte[] PayloadOf(int count)
    {
        return [.. Enumerable.Range(0, count).Select((index) =>
        {
            return (byte)index;
        })];
    }

    // a server's meter, charging the budget given, held to no rate
    private static FrameMeter MeterOf(MessageBudget budget)
    {
        return new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = int.MaxValue, IsServer = true, Budget = budget });
    }

    // the reads `bytes` is cut into at `cuts`, in order
    private static List<byte[]> ReadsOf((byte[] Bytes, IReadOnlyList<int> Cuts) split)
    {
        var (bytes, cuts) = split;
        var reads = new List<byte[]>();
        var at = 0;

        foreach (var cut in cuts.Append(bytes.Length))
        {
            reads.Add(bytes[at..cut]);
            at = cut;
        }

        return reads;
    }

    /// <summary>
    /// A peer's stream, read in the pieces it is given and each through a meter, as its gate reads
    /// one: what a read takes past a piece waits for the next read; what is written to it, a pong, is
    /// dropped.
    /// </summary>
    private sealed class MeteredStream((Queue<byte[]> Pieces, FrameMeter Meter) given) : Stream
    {
        private byte[] _piece = [];
        private int _at;

        public override bool CanRead
        {
            get
            {
                return true;
            }
        }

        public override bool CanSeek
        {
            get
            {
                return false;
            }
        }

        public override bool CanWrite
        {
            get
            {
                return true;
            }
        }

        public override long Length
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public override long Position
        {
            get
            {
                throw new NotSupportedException();
            }

            set
            {
                throw new NotSupportedException();
            }
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            return Read(buffer.AsSpan(offset, count));
        }

        public override int Read(Span<byte> buffer)
        {
            if (_at == _piece.Length)
            {
                if (!given.Pieces.TryDequeue(out var next))
                {
                    return 0;
                }

                _piece = next;
                _at = 0;
            }

            var count = Math.Min(buffer.Length, _piece.Length - _at);

            _piece.AsSpan(_at, count).CopyTo(buffer);
            _at += count;

            var handed = given.Meter.Read(buffer[..count]);

            Assert.Equal(count, handed);

            return handed;
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return ValueTask.FromResult(Read(buffer.Span));
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return Task.FromResult(Read(buffer.AsSpan(offset, count)));
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return ValueTask.CompletedTask;
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }
    }

    // the one message .NET's reader reads over `reads`, each through `meter`: its type and its bytes
    private static async Task<(WebSocketMessageType Type, byte[] Bytes)> PlatformRead((IEnumerable<byte[]> Reads, FrameMeter Meter) given)
    {
        using var stream = new MeteredStream((new Queue<byte[]>(given.Reads), given.Meter));
        using var socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.Zero });
        var message = new List<byte>();
        var buffer = new byte[16 * 1024];
        WebSocketReceiveResult received;

        do
        {
            received = await socket.ReceiveAsync(buffer, Cancelled).WaitAsync(Patience, Cancelled);
            message.AddRange(buffer[..received.Count]);
        }
        while (!received.EndOfMessage);

        return (received.MessageType, [.. message]);
    }

    // definition

    // spec 15.3, 15.12; RFC 6455 §5.2
    [Fact]
    public async Task Reads_frame_heads_split_across_reads_lengths_of_7_16_and_64_bits_control_frames_between_fragments_and_an_empty_frame_as_its_platform_reads_them()
    {
        // * a message of four fragments, 10 octets in a 7-bit length, 300 in a 16-bit one, none, and
        // 70,000 in a 64-bit one, a ping and a pong between them
        byte[][] frames =
        [
            FrameOf((0x02, PayloadOf(10), false)),
            FrameOf((0x89, [0x62, 0x65], false)),
            FrameOf((0x00, PayloadOf(300), false)),
            FrameOf((0x8A, [], false)),
            FrameOf((0x00, [], false)),
            FrameOf((0x80, PayloadOf(70_000), false)),
        ];
        byte[] bytes = [.. frames.SelectMany((frame) =>
        {
            return frame;
        })];
        var last = frames[^1].Length;
        byte[] expected = [.. PayloadOf(10), .. PayloadOf(300), .. PayloadOf(70_000)];

        // each frame charged its bytes and 128 (spec 15.12): every frame but the last read, then all
        var held = frames[..^1].Sum((frame) =>
        {
            return frame.Length + FrameMeter.PerFrame;
        });

        // every cut within a head, and one within each payload, two reads apiece; and a byte a read
        // up to the last frame's payload
        var heads = new List<int>();
        var at = 0;

        foreach (var frame in frames)
        {
            heads.AddRange(Enumerable.Range(at + 1, Math.Min(14, frame.Length - 1)));
            heads.Add(at + (frame.Length / 2));
            at += frame.Length;
        }

        foreach (var cuts in heads.Distinct().Where((cut) =>
        {
            return cut is > 0 && cut < bytes.Length;
        }).Select((cut) =>
        {
            return (IReadOnlyList<int>)[cut];
        }).Append([]).Append([.. Enumerable.Range(1, bytes.Length - last + 14)]))
        {
            var budget = new MessageBudget(long.MaxValue);
            var meter = MeterOf(budget);
            var reads = ReadsOf((bytes, cuts));

            // the meter alone: every read handed whole, the message held as it comes, then released
            foreach (var read in ReadsOf((bytes[..^last], cuts.Where((cut) =>
            {
                return cut < bytes.Length - last;
            }).ToList())))
            {
                Assert.Equal(read.Length, meter.Read(read));
            }

            Assert.Equal((string.Join(",", cuts.Take(3)), held), (string.Join(",", cuts.Take(3)), budget.Charged));
            Assert.Equal(last, meter.Read(bytes.AsSpan(bytes.Length - last)));
            Assert.Equal(0, budget.Charged);
            Assert.Null(meter.Verdict);

            // .NET's reader, below a meter of its own, reads the same message
            var platform = MeterOf(new MessageBudget(long.MaxValue));
            var (type, message) = await PlatformRead((reads, platform));

            Assert.Equal(WebSocketMessageType.Binary, type);
            Assert.Equal(expected, message);
            Assert.Null(platform.Verdict);
        }
    }
}
