using System.Buffers.Binary;
using System.Net.WebSockets;
using Bead.Transport.WebSockets;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes as the frames a WebSocket side reads, fed to its frame meter (spec 15.3, decision
/// 0056) and to .NET's own reader, <c>WebSocket.CreateFromStream</c>, over the same bytes. The
/// first byte picks the side, a server by its low bit clear, a client by it set, and the length of
/// each read the meter is fed in by the rest, 1 to 127 octets, or all at once for 0; the rest are
/// the frames. The meter, fed them whole and in those reads, reads the same frames, each bounded
/// alike, and draws the same verdict; and it agrees with .NET's reader on the end of each message
/// and whether the stream fails, and at which frame, up to a close: each message .NET reads whole
/// is one the meter read whole, in order, and .NET fails at the frame the meter's 1002 names,
/// having read every message before it. .NET's reader alone judges a payload, a text message's
/// UTF-8 and a close's code and reason, so where one of those comes first it may fail sooner; it
/// bounds no message, so a 1009 of the meter's, past 2³¹ − 1 octets announced, is no failure of
/// its; and it judges a head once whole, where the meter judges each byte as it comes. A control
/// frame whose length takes a longer form than its 7 bits fails the meter with 1002, as on every
/// side, where .NET takes one of 125 octets or fewer. The TypeScript side's
/// <c>tools/fuzz/websocket-frames.ts</c> and the Rust side's <c>websocket_frames</c> target are its
/// twins.
/// </summary>
internal sealed class WebSocketFramesTarget : IFuzzTarget
{
    // a WebSocket's opcodes that carry a payload .NET's reader judges (RFC 6455 §5.2, §5.5.1, §8.1)
    private const int Text = 0x1;
    private const int Closing = 0x8;

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "websocket-frames";
        }
    }

    // helpers

    // what a meter reads of the bytes in reads of `Cut` octets, all at once for 0: each frame it read
    // whole, its verdict, and how many octets it handed on
    private static (List<MeteredFrame> Frames, FrameVerdict? Verdict, long Handed) Metered((byte[] Bytes, bool IsServer, int Cut) given)
    {
        var (bytes, isServer, cut) = given;
        var frames = new List<MeteredFrame>();
        var meter = new FrameMeter(new FrameMeter.MeterOptions
        {
            MaximumMessageBytes = int.MaxValue,
            MaximumMessageFrames = int.MaxValue,
            IsServer = isServer,
            Framed = frames.Add,
        });
        var step = cut == 0 ? Math.Max(1, bytes.Length) : cut;
        long handed = 0;

        for (var at = 0; at < bytes.Length && meter.Verdict is null; at += step)
        {
            handed += meter.Read(bytes.AsSpan(at, Math.Min(step, bytes.Length - at)));
        }

        return (frames, meter.Verdict, handed);
    }

    // the messages a meter read whole before its first close, by their type and their length: a
    // message's type is its first frame's opcode, and a frame the bytes end within ends none
    private static List<(int Opcode, long Length)> MessagesOf((List<MeteredFrame> Frames, long Read) metered)
    {
        var messages = new List<(int Opcode, long Length)>();
        int? opcode = null;
        long length = 0;

        foreach (var frame in metered.Frames)
        {
            if (frame.Opcode == Closing || frame.End > metered.Read)
            {
                break;
            }

            if (frame.Opcode >= Closing)
            {
                continue;
            }

            opcode ??= frame.Opcode;
            length += frame.Length;

            if (frame.IsFinal)
            {
                messages.Add((opcode.Value, length));
                opcode = null;
                length = 0;
            }
        }

        return messages;
    }

    // what .NET's reader reads of the bytes: each message it reads whole, by its type and its length,
    // until it reads a close or the bytes end; and whether it failed for a protocol error
    private static (List<(int Opcode, long Length)> Messages, bool IsFailed) PlatformRead((byte[] Bytes, bool IsServer) given)
    {
        using var stream = new PeerStream(given.Bytes);
        using var socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = given.IsServer, KeepAliveInterval = TimeSpan.Zero });
        var messages = new List<(int Opcode, long Length)>();
        var buffer = new byte[65_536];
        long length = 0;

        try
        {
            while (true)
            {
                var received = socket.ReceiveAsync(buffer.AsMemory(), CancellationToken.None).AsTask().GetAwaiter().GetResult();

                if (received.MessageType == WebSocketMessageType.Close)
                {
                    return (messages, false);
                }

                length += received.Count;

                if (received.EndOfMessage)
                {
                    messages.Add((received.MessageType == WebSocketMessageType.Text ? Text : 0x2, length));
                    length = 0;
                }
            }
        }
        catch (WebSocketException reason) when (reason.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
        {
            // the bytes ended, a frame or a message partway
            return (messages, false);
        }
        catch (WebSocketException)
        {
            return (messages, true);
        }
    }

    // * whether .NET's reader leaves unjudged the head a 1002 of the meter's names, at `At`: the
    // bytes end before that head is whole as .NET reads one, its mask a server's alone, where the
    // meter judges each byte as it comes
    private static bool IsUnjudged((byte[] Bytes, int At, bool IsServer) given)
    {
        var (bytes, at, isServer) = given;
        var head = bytes.AsSpan(at);

        if (head.Length < 2)
        {
            return true;
        }

        var short7 = head[1] & 0x7F;
        var extended = short7 == 126 ? 2 : short7 == 127 ? 8 : 0;

        return head.Length < 2 + extended + (isServer ? 4 : 0);
    }

    // * whether the head a 1002 of the meter's names, at `At`, is a control frame whose length takes
    // a longer form than its 7 bits for 125 octets or fewer, which .NET takes and every side refuses
    private static bool IsTakenByNet((byte[] Bytes, int At) given)
    {
        var head = given.Bytes.AsSpan(given.At);

        if (head.Length < 2 || (head[0] & 0x08) == 0)
        {
            return false;
        }

        var short7 = head[1] & 0x7F;

        if (short7 == 126)
        {
            return head.Length >= 4 && BinaryPrimitives.ReadUInt16BigEndian(head[2..4]) <= 125;
        }

        if (short7 == 127)
        {
            return head.Length >= 10 && BinaryPrimitives.ReadUInt64BigEndian(head[2..10]) <= 125;
        }

        return false;
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty)
        {
            return;
        }

        var isServer = (data[0] & 0x1) == 0;
        var bytes = data[1..].ToArray();
        var whole = Metered((bytes, isServer, 0));
        var cut = Metered((bytes, isServer, data[0] >> 1));

        // * the reads that cut the bytes change nothing: the same frames and the same verdict, cut
        // at its frame's first byte, or past it by what an earlier read handed of its head
        if (!whole.Frames.SequenceEqual(cut.Frames) || whole.Verdict != cut.Verdict || cut.Handed - whole.Handed is < 0 or > 13)
        {
            throw new InvalidOperationException($"the meter reads bytes cut in reads of {data[0] >> 1} otherwise than whole: {whole.Frames.Count} frames and {whole.Verdict?.Why} at {whole.Handed}, against {cut.Frames.Count}, {cut.Verdict?.Why} at {cut.Handed}");
        }

        // the messages the meter read whole up to its verdict, or to the end, and whether a close
        // comes among the frames it read
        var read = whole.Verdict is null ? bytes.Length : whole.Handed;
        var metered = MessagesOf((whole.Frames, read));
        var isClosed = whole.Frames.Any((frame) =>
        {
            return frame.Opcode == Closing && frame.End <= read;
        });
        var (platform, isFailed) = PlatformRead((bytes, isServer));
        var shared = Math.Min(platform.Count, metered.Count);

        // what both read whole, they read alike, in order
        if (!platform.Take(shared).SequenceEqual(metered.Take(shared)))
        {
            throw new InvalidOperationException($"{platform.Count} messages read by .NET otherwise than the {metered.Count} the meter read");
        }

        // where the last message .NET read ends, and whether a payload .NET alone judges comes past
        // it: a frame of text, a continuation, or a close
        var readTo = whole.Frames.Where((frame) =>
        {
            return frame.IsFinal && frame.Opcode < Closing;
        }).Take(platform.Count).Select((frame) =>
        {
            return frame.End;
        }).LastOrDefault();
        var isJudged = whole.Frames.Any((frame) =>
        {
            return frame.End > readTo && frame.Opcode is Text or Closing or 0x0;
        });

        // .NET reads fewer only where it fails for a payload it alone judges, or a close ends it
        if (platform.Count < metered.Count && !(isFailed && isJudged) && !isClosed)
        {
            throw new InvalidOperationException($".NET reads {platform.Count} messages whole, where the meter reads {metered.Count}");
        }

        // * the meter's 1002 is .NET's failure at the same frame, but at a head .NET leaves unjudged,
        // past which .NET reads on; .NET fails nowhere else but for a payload it alone judges
        if (whole.Verdict is { Code: WebSocketCloseStatus.ProtocolError } verdict && !isClosed)
        {
            var isUnjudged = IsUnjudged((bytes, (int)whole.Handed, isServer)) || IsTakenByNet((bytes, (int)whole.Handed));

            if (!isUnjudged && (!isFailed || platform.Count > metered.Count))
            {
                throw new InvalidOperationException($"the meter fails the stream, {verdict.Why}, after {metered.Count} messages; .NET {(isFailed ? "fails it" : "does not")} after {platform.Count}");
            }
        }
        else if (whole.Verdict is null && ((isFailed && !isJudged) || platform.Count > metered.Count))
        {
            throw new InvalidOperationException($".NET {(isFailed ? "fails" : "reads")} the stream after {platform.Count} messages, where the meter reads {metered.Count} and draws no verdict");
        }
    }

    // the bytes a peer sent, read as they are asked for; what is written to it, a pong or a close, dropped
    private sealed class PeerStream(byte[] bytes) : Stream
    {
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
            var count = Math.Min(buffer.Length, bytes.Length - _at);

            bytes.AsSpan(_at, count).CopyTo(buffer);
            _at += count;

            return count;
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
}
