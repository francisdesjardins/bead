using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// Its messages partway (spec 15.3, 15.12, decision 0056): each frame judged at its head by its
/// meter, what its connections hold charged to its budget, and each message held to its rate.
/// </summary>
public sealed partial class WebSocketTransportServerTests
{
    // a WebSocket's opcodes, as a frame's first byte carries them, final or not (RFC 6455 §5.2)
    private const byte Fragment = 0x02;
    private const byte Continued = 0x00;
    private const byte Ended = 0x80;
    private const byte Whole = 0x82;

    // helpers

    // a masked client frame of the first byte and the payload given, its length in 7, 16 or 64 bits
    // as its size needs (RFC 6455 §5.2): one that announces more than comes is cut from it
    private static byte[] MaskedFrame((byte First, byte[] Payload) given)
    {
        var (first, payload) = given;
        var mask = RandomNumberGenerator.GetBytes(4);
        var head = new List<byte> { first };

        if (payload.Length > ushort.MaxValue)
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

        head.AddRange(mask);

        return [.. head, .. payload.Select((octet, index) =>
        {
            return (byte)(octet ^ mask[index % 4]);
        })];
    }

    // frames written in one write
    private static byte[] Joined(params byte[][] frames)
    {
        return [.. frames.SelectMany((frame) =>
        {
            return frame;
        })];
    }

    // a frame that announces `Announced` octets and brings `Brought` of them: its head and those
    private static byte[] Announcing((byte First, int Announced, int Brought) given)
    {
        var frame = MaskedFrame((given.First, new byte[given.Announced]));

        return frame[..(frame.Length - given.Announced + given.Brought)];
    }

    // what a frame of so many octets of payload charges, its head 6, 8 or 14 octets, and 128 more
    private static int ChargeOf(int payload)
    {
        return (payload > ushort.MaxValue ? 14 : payload > 125 ? 8 : 6) + payload + FrameMeter.PerFrame;
    }

    // what its connections hold of messages partway, its gauge
    private long MessageBytes
    {
        get
        {
            return _server.Gauges().Counts["messageBytes"];
        }
    }

    // waits until its connections hold `bytes` of messages partway, then holds it so
    private async Task UntilHeld(long bytes)
    {
        await Until(() =>
        {
            return MessageBytes == bytes;
        });

        Assert.Equal(bytes, MessageBytes);
    }

    // a socket of the tests' own upgraded, and the handle the server gave it
    private async Task<(TcpClient Tcp, NetworkStream Stream, string ConnectionHandle)> Raw()
    {
        var (tcp, status) = await Upgraded(UpgradeRequest());

        Assert.Equal(101, status);

        return (tcp, tcp.GetStream(), await Next(_connections));
    }

    // what it told of a connection that ended: its one error, by its type and its message, then its close
    private static async Task<object[]> EndedOf(ConcurrentQueue<(string Name, Exception? Reason, string ConnectionHandle)> told, string connectionHandle)
    {
        await Until(() =>
        {
            return told.Any((each) =>
            {
                return each.Name.EndsWith("close", StringComparison.Ordinal) && each.ConnectionHandle == connectionHandle;
            });
        });

        return [.. told.Where((each) =>
        {
            return each.ConnectionHandle == connectionHandle;
        }).Select((each) =>
        {
            return each.Reason is { } reason ? $"{reason.GetType().Name}: {reason.Message}" : (object)each.Name;
        })];
    }

    // whether the server sent nothing more on `tcp`, nor ended its writing, within a while: nothing
    // read of it
    private static bool IsQuiet(TcpClient tcp)
    {
        return !tcp.Client.Poll(TimeSpan.FromMilliseconds(300), SelectMode.SelectRead);
    }

    // definition

    // spec 15.12
    [Fact]
    public async Task Fails_with_1008_a_message_slower_than_minimumBodyBytesPerSecond_once_bodyGracePeriod_passed_since_its_first_byte_its_payload_alone_counting()
    {
        var clock = new FakeTimeProvider(Now);

        await Start(new WebSocketTransportServerOptions { Clock = clock });

        var told = Told();

        // * its first frame of 12 octets, a pong, then 250 empty fragments: 1,500 octets of heads,
        // which would hold it 6,250 ms were they payload, due at its grace all the same
        var (slow, slowStream, slowHandle) = await Raw();

        using (slow)
        {
            byte[] heads = [.. Enumerable.Range(0, 250).SelectMany((_) =>
            {
                return MaskedFrame((Continued, []));
            })];

            await slowStream.WriteAsync(Joined(MaskedFrame((Fragment, new byte[12])), PongOf([1, 2, 3, 4]), heads), Cancelled);
            await UntilHeld(ChargeOf(12) + ChargeOf(4) + (250 * ChargeOf(0)));
            clock.Advance(TimeSpan.FromMilliseconds(4_999));

            Assert.True(IsQuiet(slow));

            clock.Advance(TimeSpan.FromMilliseconds(1));

            Assert.Equal(1008, await FirstCloseCodeOf(slowStream));
            await UntilHeld(0);
        }

        Assert.Equal(
            new object[] { $"IOException: {slowHandle} is closed with 1008: a message came slower than minimumBodyBytesPerSecond, 240 bytes a second, past bodyGracePeriod, 5000 ms", "close" },
            await EndedOf(told, slowHandle));

        // its payload holds it longer: 1,440 octets, 6 seconds at 240 a second
        var (paid, paidStream, _) = await Raw();

        using (paid)
        {
            await paidStream.WriteAsync(MaskedFrame((Fragment, new byte[1_440])), Cancelled);
            await UntilHeld(ChargeOf(1_440));
            clock.Advance(TimeSpan.FromMilliseconds(5_999));

            Assert.True(IsQuiet(paid));

            clock.Advance(TimeSpan.FromMilliseconds(1));

            Assert.Equal(1008, await FirstCloseCodeOf(paidStream));
        }
    }

    // spec 15.12; docs/support.md, a message read on while paused
    [Fact]
    public async Task Counts_the_time_of_a_message_partway_only_while_it_reads_its_connection()
    {
        var clock = new FakeTimeProvider(Now);

        await Start(new WebSocketTransportServerOptions { Clock = clock });

        // * paused partway, the C# side reads its message on to its end, and its clock runs meanwhile
        var (partway, partwayStream, partwayHandle) = await Raw();

        using (partway)
        {
            await partwayStream.WriteAsync(MaskedFrame((Fragment, new byte[12])), Cancelled);
            await UntilHeld(ChargeOf(12));
            _server.Pause(partwayHandle);
            clock.Advance(TimeSpan.FromMilliseconds(5_000));

            Assert.Equal(1008, await FirstCloseCodeOf(partwayStream));
        }

        // * a read held by its router, at its gate or before its next message: its meter's clock stops
        var held = new FakeTimeProvider(Now);
        var meter = new FrameMeter(new FrameMeter.MeterOptions
        {
            MaximumMessageBytes = 64,
            IsServer = true,
            Rate = new FrameMeter.RateOptions { MinimumBodyBytesPerSecond = 240, BodyGracePeriod = TimeSpan.FromSeconds(5), Clock = held },
        });
        var first = MaskedFrame((Fragment, new byte[12]));

        Assert.Equal(first.Length, meter.Read(first));
        meter.Hold();
        held.Advance(TimeSpan.FromSeconds(30));

        Assert.Null(meter.Verdict);

        meter.Unhold();
        held.Advance(TimeSpan.FromMilliseconds(4_999));

        Assert.Null(meter.Verdict);

        held.Advance(TimeSpan.FromMilliseconds(1));

        Assert.Equal(WebSocketCloseStatus.PolicyViolation, meter.Verdict?.Code);
    }

    // spec 15.12
    [Fact]
    public async Task Charges_a_message_partway_every_byte_its_frames_bring_and_128_a_frame_pongs_between_them_among_it_never_what_a_head_announces()
    {
        await Start(new WebSocketTransportServerOptions());

        var (tcp, stream, _) = await Raw();

        using (tcp)
        {
            var last = MaskedFrame((Ended, new byte[1_000]));

            Assert.Equal(268_435_456, _server.Gauges().Ceilings["messageBytes"]);

            await stream.WriteAsync(MaskedFrame((Fragment, new byte[12])), Cancelled);
            await UntilHeld(146);

            // a pong between its frames, its head, its payload and 128
            await stream.WriteAsync(PongOf([1, 2, 3, 4]), Cancelled);
            await UntilHeld(284);

            // its last frame announces 1,000 octets, and 10 of them come: what came is charged
            await stream.WriteAsync(last.AsMemory(0, 18), Cancelled);
            await UntilHeld(284 + 8 + 10 + 128);

            // its message whole, its charge released, and handed on
            await stream.WriteAsync(last.AsMemory(18), Cancelled);

            var (message, _) = await Next(_messages);

            Assert.Equal(1_012, message.Bytes.Length);
            await UntilHeld(0);
        }
    }

    // spec 15.12, its cast-off order
    [Fact]
    public async Task Casts_off_with_1013_the_connections_whose_messages_hold_the_most_when_a_charge_would_pass_messageBytesBudget_the_newcomer_only_when_it_holds_the_most()
    {
        await Start(new WebSocketTransportServerOptions { MessageBytesBudget = 500 });

        var told = Told();
        var (ada, adaStream, adaHandle) = await Raw();
        var (bob, bobStream, _) = await Raw();
        var (carol, carolStream, carolHandle) = await Raw();
        var (dave, daveStream, daveHandle) = await Raw();

        using (ada)
        using (bob)
        using (carol)
        using (dave)
        {
            await adaStream.WriteAsync(MaskedFrame((Fragment, new byte[60])), Cancelled);
            await UntilHeld(194);

            // * a head that announces 1,000 octets is charged what came of it, 10
            await bobStream.WriteAsync(Announcing((Fragment, 1_000, 10)), Cancelled);
            await UntilHeld(340);

            // carol's 174 would take it to 514: ada, who holds the most, is cast off
            await carolStream.WriteAsync(MaskedFrame((Fragment, new byte[40])), Cancelled);

            Assert.Equal(1013, await FirstCloseCodeOf(adaStream));
            await UntilHeld(320);

            // dave's 234 would hold the most: the newcomer is cast off himself, nothing of his taken
            await daveStream.WriteAsync(MaskedFrame((Fragment, new byte[100])), Cancelled);

            Assert.Equal(1013, await FirstCloseCodeOf(daveStream));
            await UntilHeld(320);

            // carol's message, whole, is handed on, and its charge released
            await carolStream.WriteAsync(MaskedFrame((Ended, new byte[40])), Cancelled);

            var (message, connectionHandle) = await Next(_messages);

            Assert.Equal((80, carolHandle), (message.Bytes.Length, connectionHandle));
            await UntilHeld(146);
        }

        foreach (var handle in new[] { adaHandle, daveHandle })
        {
            Assert.Equal(
                new object[] { $"IOException: {handle} is closed with 1013: the messages partway would pass messageBytesBudget, 500 bytes", "close" },
                await EndedOf(told, handle));
        }
    }

    // spec 15.12, its cast-off order's first step
    [Fact]
    public async Task Casts_off_a_message_past_its_grace_before_one_within_it()
    {
        var clock = new FakeTimeProvider(Now);

        await Start(new WebSocketTransportServerOptions { Clock = clock, MessageBytesBudget = 3_200 });

        var (ada, adaStream, _) = await Raw();

        using (ada)
        {
            // ada's 1,440 octets hold her 6 seconds; past 5.5, she is past her grace
            await adaStream.WriteAsync(MaskedFrame((Fragment, new byte[1_440])), Cancelled);
            await UntilHeld(1_576);

            // * at 5 s, ada is within her grace, not past it: carol's 1,636, the most, is cast off
            clock.Advance(TimeSpan.FromMilliseconds(5_000));

            var (carol, carolStream, _) = await Raw();

            using (carol)
            {
                await carolStream.WriteAsync(MaskedFrame((Fragment, new byte[1_500])), Cancelled);

                Assert.Equal(1013, await FirstCloseCodeOf(carolStream));
                await UntilHeld(1_576);
            }

            clock.Advance(TimeSpan.FromMilliseconds(500));

            var (bob, bobStream, _) = await Raw();

            using (bob)
            {
                // * bob's 1,636, more than ada holds, would take it to 3,212: ada is cast off
                await bobStream.WriteAsync(MaskedFrame((Fragment, new byte[1_500])), Cancelled);

                Assert.Equal(1013, await FirstCloseCodeOf(adaStream));
                await UntilHeld(1_636);
                Assert.True(IsQuiet(bob));
            }
        }
    }

    // spec 15.12
    [Fact]
    public async Task Releases_a_charge_at_its_connection_s_verdict_and_charges_nothing_that_comes_after_it()
    {
        await Start(new WebSocketTransportServerOptions());

        var (tcp, stream, _) = await Raw();

        using (tcp)
        {
            await stream.WriteAsync(MaskedFrame((Fragment, new byte[12])), Cancelled);
            await UntilHeld(146);

            // a frame of a reserved opcode: 1002, its charge released at once
            await stream.WriteAsync(MaskedFrame((0x83, [0x78])), Cancelled);

            Assert.Equal(1002, await FirstCloseCodeOf(stream));
            await UntilHeld(0);

            // what still comes is dropped, charged nothing
            await stream.WriteAsync(MaskedFrame((Continued, new byte[100])), Cancelled);

            Assert.True(IsQuiet(tcp));
            Assert.Equal(0, MessageBytes);
        }
    }

    // spec 15.3
    [Fact]
    public async Task Fails_with_1009_at_its_head_without_waiting_for_its_payload_a_frame_that_would_take_its_message_past_maximumMessageBytes_a_continuation_among_them()
    {
        await Start(new WebSocketTransportServerOptions { MaximumMessageBytes = 64 });

        var told = Told();

        // a frame that announces 100 octets, none of which comes; then a continuation that announces
        // 60 behind 12 that came
        foreach (var frames in new byte[][] { Announcing((Whole, 100, 0)), [.. MaskedFrame((Fragment, new byte[12])), .. Announcing((Continued, 60, 0))] })
        {
            var (tcp, stream, connectionHandle) = await Raw();

            using (tcp)
            {
                await stream.WriteAsync(frames, Cancelled);

                Assert.Equal(1009, await FirstCloseCodeOf(stream));
            }

            Assert.Equal(
                new object[] { $"InvalidDataException: {connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes", "close" },
                await EndedOf(told, connectionHandle));
        }

        Assert.True(_messages.Reader.Count == 0);
    }

    // spec 15.3
    [Fact]
    public async Task Hands_on_a_message_whole_ahead_of_a_frame_that_draws_a_verdict_in_the_same_read_and_nothing_from_that_frame_on()
    {
        await Start(new WebSocketTransportServerOptions());

        var (tcp, stream, connectionHandle) = await Raw();

        using (tcp)
        {
            // * one write: a message whole, a frame of a reserved opcode, then a message whole
            await stream.WriteAsync(Joined(MaskedFrame((Whole, [0x68, 0x69])), MaskedFrame((0x83, [0x78])), MaskedFrame((Whole, [0x6E, 0x6F]))), Cancelled);

            var (message, handle) = await Next(_messages);

            Assert.Equal(connectionHandle, handle);
            Assert.Equal(new byte[] { 0x68, 0x69 }, message.Bytes.ToArray());
            Assert.Equal(1002, await FirstCloseCodeOf(stream));
        }

        Assert.Equal((false, connectionHandle), await Next(_closes));
        Assert.True(_messages.Reader.Count == 0);
    }

    // spec 15.3
    [Fact]
    public async Task Fails_with_1008_the_frame_past_maximumMessageFrames_at_its_head_an_empty_frame_counting()
    {
        await Start(new WebSocketTransportServerOptions { MaximumMessageFrames = 4 });

        var told = Told();
        var (whole, wholeStream, _) = await Raw();

        using (whole)
        {
            // four frames, two of them empty: one message
            await wholeStream.WriteAsync(Joined(MaskedFrame((Fragment, new byte[12])), MaskedFrame((Continued, [])), MaskedFrame((Continued, [])), MaskedFrame((Ended, new byte[3]))), Cancelled);

            Assert.Equal(15, (await Next(_messages)).Message.Bytes.Length);
        }

        var (past, pastStream, pastHandle) = await Raw();

        using (past)
        {
            // * the fifth frame's head, its payload never sent
            await pastStream.WriteAsync(Joined(MaskedFrame((Fragment, [0x78])), MaskedFrame((Continued, [])), MaskedFrame((Continued, [])), MaskedFrame((Continued, [])), Announcing((Continued, 10, 0))), Cancelled);

            Assert.Equal(1008, await FirstCloseCodeOf(pastStream));
        }

        Assert.Equal(
            new object[] { $"InvalidDataException: {pastHandle} is closed with 1008: a message past its maximumMessageFrames, 4 frames", "close" },
            await EndedOf(told, pastHandle));
    }

    // spec 15.3; RFC 6455 §5.2, §5.4, §5.5
    [Fact]
    public async Task Fails_with_1002_a_frame_head_RFC_6455_forbids_before_its_platform_reads_it()
    {
        await Start(new WebSocketTransportServerOptions());

        var told = Told();
        byte[] key = [1, 2, 3, 4];

        foreach (var (bytes, rule) in new (byte[], string)[]
        {
            ([0xC2, 0x80, .. key], "a reserved bit set"),
            ([0x83, 0x80, .. key], "a reserved opcode, 3"),
            ([0x8B, 0x80, .. key], "a reserved opcode, 11"),
            ([0x09, 0x80, .. key], "a control frame not final"),
            ([0x89, 0x80 | 126, 0x00, 0x05, .. key], "a control frame longer than 125 bytes"),
            ([0x80, 0x80, .. key], "a continuation with no message under way"),
            ([0x02, 0x80, .. key, 0x82, 0x80, .. key], "a data frame that is not a continuation while a message is under way"),
            ([0x82, 0x80 | 127, 0x80, 0, 0, 0, 0, 0, 0, 0, .. key], "a 64-bit length with its top bit set"),
            ([0x82, 0x00], "an unmasked frame"),
        })
        {
            var (tcp, stream, connectionHandle) = await Raw();

            using (tcp)
            {
                await stream.WriteAsync(bytes, Cancelled);

                Assert.Equal((rule, 1002), (rule, await FirstCloseCodeOf(stream)));
            }

            Assert.Equal(
                new object[] { $"WebSocketException: {connectionHandle} is closed with 1002: a frame head RFC 6455 forbids, {rule}", "close" },
                await EndedOf(told, connectionHandle));
        }
    }

    // spec 15.3; RFC 6455 §7.1.7
    [Fact]
    public async Task Sends_its_close_ends_its_writing_and_drops_what_still_comes_unparsed_until_its_peer_ends_or_its_close_timeout_passed_once_a_verdict_failed_it()
    {
        await Start(new WebSocketTransportServerOptions { MaximumMessageBytes = 64 });

        var told = Told();
        var (tcp, stream, connectionHandle) = await Raw();

        using (tcp)
        {
            await stream.WriteAsync(Announcing((Whole, 100, 0)), Cancelled);

            Assert.Equal(1009, await FirstCloseCodeOf(stream));

            // * what comes is parsed by none: a frame of a reserved opcode, a ping and a close
            // draw no 1002, no pong and no close of their own
            await stream.WriteAsync(Joined(MaskedFrame((0x83, [0x78])), MaskedFrame((0x89, [0x62])), MaskedFrame((0x88, [0x03, 0xE8]))), Cancelled);

            // ! Kestrel's upgraded stream has no half-close: its writing ends with its socket, at
            // its peer's end (docs/support.md)
            Assert.True(IsQuiet(tcp));

            // its peer ends: it ends at once, well before its close timeout, 5 s
            tcp.Client.Shutdown(SocketShutdown.Send);

            Assert.Equal(0, await stream.ReadAsync(new byte[16], Cancelled).AsTask().WaitAsync(TimeSpan.FromSeconds(2), Cancelled));
        }

        Assert.Equal(
            new object[] { $"InvalidDataException: {connectionHandle} is closed with 1009: a message past its maximumMessageBytes, 64 bytes", "close" },
            await EndedOf(told, connectionHandle));
        Assert.Equal((false, connectionHandle), await Next(_closes));

        // a peer that never ends is dropped once its close timeout passed
        await Start(new WebSocketTransportServerOptions { MaximumMessageBytes = 64, CloseTimeout = TimeSpan.FromMilliseconds(300) });

        var (silent, silentStream, silentHandle) = await Raw();

        using (silent)
        {
            var watch = Stopwatch.StartNew();

            await silentStream.WriteAsync(Announcing((Whole, 100, 0)), Cancelled);

            Assert.Equal(1009, await FirstCloseCodeOf(silentStream));
            Assert.Equal((false, silentHandle), await Next(_closes, TimeSpan.FromSeconds(2)));
            Assert.True(watch.Elapsed >= TimeSpan.FromMilliseconds(250), $"closed after {watch.Elapsed}");
        }
    }

    // docs/support.md, a single WebSocket frame read slower than its heartbeat
    [Fact]
    public async Task Reads_a_single_frame_trickled_within_each_heartbeat_as_its_platform_counts_its_reads()
    {
        await Start(new WebSocketTransportServerOptions { Heartbeat = TimeSpan.FromMilliseconds(300) });

        var (tcp, stream, connectionHandle) = await Raw();

        using (tcp)
        {
            // * one frame of 2,048 octets, 64 every 50 ms, a part within each heartbeat: .NET counts a
            // read once 16 KiB, or the rest of its frame, came, so its ping's echo waits behind the
            // frame, and it is dropped before the frame ends
            var frame = MaskedFrame((Whole, new byte[2_048]));
            var closed = Next(_closes, TimeSpan.FromSeconds(5));

            try
            {
                for (var at = 0; at < frame.Length && !closed.IsCompleted; at += 64)
                {
                    await stream.WriteAsync(frame.AsMemory(at, Math.Min(64, frame.Length - at)), Cancelled);
                    await Task.Delay(50, Cancelled);
                }
            }
            catch (IOException)
            {
                // dropped as it wrote
            }

            Assert.Equal((false, connectionHandle), await closed);
            Assert.True(_messages.Reader.Count == 0);
        }
    }
}
