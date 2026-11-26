using System.Buffers.Binary;
using System.Net.WebSockets;
using Microsoft.Extensions.Time.Testing;

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

    [Fact]
    public void Counts_a_message_s_time_only_while_its_connection_is_not_paused()
    {
        var clock = new FakeTimeProvider();
        var meter = new FrameMeter(new FrameMeter.MeterOptions
        {
            MaximumMessageBytes = 64,
            IsServer = true,
            Rate = new FrameMeter.RateOptions { MinimumBodyBytesPerSecond = 240, BodyGracePeriod = TimeSpan.FromSeconds(3), Clock = clock },
        });
        var first = FrameOf((0x02, new byte[10], false));

        Assert.Equal(first.Length, meter.Read(first));
        clock.Advance(TimeSpan.FromSeconds(1));
        meter.Hold();
        clock.Advance(TimeSpan.FromSeconds(9));
        Assert.Null(meter.Verdict);
        meter.Unhold();
        clock.Advance(TimeSpan.FromMilliseconds(1_999));
        Assert.Null(meter.Verdict);
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, meter.Verdict?.Code);
        meter.End();
    }

    [Fact]
    public void Fails_with_1009_at_its_head_a_frame_that_takes_its_message_past_its_bound_a_continuation_s_among_them()
    {
        var options = new FrameMeter.MeterOptions { MaximumMessageBytes = 64, IsServer = true };
        var meter = new FrameMeter(options);
        byte[] head = [0x82, 0x80 | 100, .. Key];

        Assert.Equal(0, meter.Read(head));
        Assert.Equal(WebSocketCloseStatus.MessageTooBig, meter.Verdict?.Code);

        var first = FrameOf((0x02, new byte[40], false));
        byte[] continuation = [0x80, 0x80 | 25, .. Key];
        var continued = new FrameMeter(options);

        Assert.Equal(first.Length, continued.Read([.. first, .. continuation]));
        Assert.Equal(WebSocketCloseStatus.MessageTooBig, continued.Verdict?.Code);
    }

    [Fact]
    public void Fails_with_1008_the_frame_past_its_bound_at_its_head_an_empty_frame_counting_a_control_frame_not()
    {
        var meter = new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = 64, MaximumMessageFrames = 2, IsServer = true });
        byte[] before = [.. FrameOf((0x02, [1], false)), .. FrameOf((0x89, [], false)), .. FrameOf((0x00, [], false))];

        Assert.Equal(before.Length, meter.Read([.. before, 0x80]));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, meter.Verdict?.Code);
    }

    [Fact]
    public void Fails_with_1002_each_head_RFC_6455_forbids_at_the_byte_that_draws_it()
    {
        foreach (var (bytes, reason) in new (byte[] Bytes, string Reason)[]
        {
            ([0xC2, 0x80], "a reserved bit set"),
            ([0x83, 0x80], "a reserved opcode, 3"),
            ([0x8B, 0x80], "a reserved opcode, 11"),
            ([0x09, 0x80], "a control frame not final"),
            ([0x80, 0x80], "a continuation with no message under way"),
            ([0x89, 0xFE], "a control frame longer than 125 bytes"),
            ([0x8A, 0xFF], "a control frame longer than 125 bytes"),
            ([0x82, 0x00], "an unmasked frame"),
            ([0x82, 0xFF, 0x80], "a 64-bit length with its top bit set"),
        })
        {
            var meter = new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = int.MaxValue, IsServer = true });

            Assert.Equal(0, meter.Read(bytes));
            Assert.Equal(WebSocketCloseStatus.ProtocolError, meter.Verdict?.Code);
            Assert.Equal($"a frame head RFC 6455 forbids, {reason}", meter.Verdict?.Why);
        }

        var first = FrameOf((0x02, [1], false));
        var continued = new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = int.MaxValue, IsServer = true });

        Assert.Equal(first.Length, continued.Read([.. first, 0x82]));
        Assert.Equal(WebSocketCloseStatus.ProtocolError, continued.Verdict?.Code);
        Assert.EndsWith("a data frame that is not a continuation while a message is under way", continued.Verdict?.Why, StringComparison.Ordinal);

        var client = new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = int.MaxValue, IsServer = false });

        Assert.Equal(0, client.Read(FrameOf((0x82, [1], false))));
        Assert.Equal(WebSocketCloseStatus.ProtocolError, client.Verdict?.Code);
        Assert.EndsWith("a masked frame", client.Verdict?.Why, StringComparison.Ordinal);
    }

    [Fact]
    public void Takes_a_length_not_in_its_minimal_form_as_tungstenite_takes_it()
    {
        var meter = new FrameMeter(new FrameMeter.MeterOptions { MaximumMessageBytes = int.MaxValue, IsServer = true });
        var frame = FrameOf((0x82, [1, 2, 3], true));

        Assert.Equal(frame.Length, meter.Read(frame));
        Assert.Null(meter.Verdict);
    }

    [Fact]
    public void Charges_each_byte_of_a_message_partway_and_128_a_head_a_pong_between_its_frames_among_it()
    {
        var budget = new MessageBudget(long.MaxValue);
        var meter = MeterOf(budget);
        var before = FrameOf((0x89, [], false));
        byte[] message = [.. FrameOf((0x02, new byte[12], false)), .. FrameOf((0x8A, "beat"u8.ToArray(), false)), .. FrameOf((0x80, new byte[3], false))];

        Assert.Equal(before.Length, meter.Read(before));
        Assert.Equal(0, budget.Charged);
        foreach (var octet in message[..^1])
        {
            Assert.Equal(1, meter.Read([octet]));
            Assert.Null(meter.Verdict);
        }

        Assert.Equal((6 + 12 + 128) + (6 + 4 + 128) + (6 + 3 + 128) - 1, budget.Charged);
        Assert.Equal(1, meter.Read(message.AsSpan(message.Length - 1)));
        Assert.Equal(0, budget.Charged);
        Assert.Equal(before.Length, meter.Read(before));
        Assert.Equal(0, budget.Charged);
        Assert.Null(meter.Verdict);
    }

    // spec 15.3, 15.12
    [Fact]
    public void Charges_a_frame_s_head_once_whole_so_a_head_that_draws_a_verdict_charges_nothing_and_a_cast_off_at_an_earlier_byte_wins_over_it()
    {
        // * a head split across reads charges nothing until its last byte: then its bytes and 128
        var budget = new MessageBudget(long.MaxValue);
        var meter = MeterOf(budget);
        var frame = FrameOf((0x02, PayloadOf(12), false));

        Assert.Equal(3, meter.Read(frame.AsSpan(0, 3)));
        Assert.Equal(0, budget.Charged);
        Assert.Equal(3, meter.Read(frame.AsSpan(3, 3)));
        Assert.Equal(6 + FrameMeter.PerFrame, budget.Charged);
        Assert.Equal(12, meter.Read(frame.AsSpan(6)));
        Assert.Equal(6 + 12 + FrameMeter.PerFrame, budget.Charged);

        // * 364 octets charge 500, the budget's whole; a ping's head written in a 16-bit length draws
        // 1002 at its second byte, never whole, and charges nothing, in one read or cut at its first
        // byte: 1002, not 1013
        var charged = FrameOf((0x02, PayloadOf(364), false));
        byte[] edge = [.. charged, 0x89, 0x80 | 126, 0x00, 0x7E, .. Key];

        foreach (var cut in new[] { edge.Length, charged.Length + 1 })
        {
            var edgeMeter = MeterOf(new MessageBudget(500));

            // what came before the ping's head handed on, its first byte too where it came alone
            Assert.Equal((cut, cut == edge.Length ? charged.Length : cut), (cut, edgeMeter.Read(edge.AsSpan(0, cut))));

            if (cut < edge.Length)
            {
                Assert.Equal(0, edgeMeter.Read(edge.AsSpan(cut)));
            }

            Assert.Equal((cut, WebSocketCloseStatus.ProtocolError), (cut, edgeMeter.Verdict?.Code));
        }

        // * 464 octets charge 600, past 500, then a head of a reserved opcode in the same read: the
        // cast-off at the earlier byte wins, 1013, and nothing of the read is handed on
        var castOff = new MessageBudget(500);
        var castMeter = MeterOf(castOff);
        byte[] past = [.. FrameOf((0x02, PayloadOf(464), false)), .. FrameOf((0x83, [0x78], false))];

        Assert.Equal(0, castMeter.Read(past));
        Assert.Equal(FrameVerdict.TryAgainLater, castMeter.Verdict?.Code);
        Assert.Equal(0, castOff.Charged);
    }

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
