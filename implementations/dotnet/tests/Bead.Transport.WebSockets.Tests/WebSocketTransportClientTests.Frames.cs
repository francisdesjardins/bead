using System.Net;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// Its meter (spec 15.3, decision 0056): each frame its server sends judged at its head, before
/// .NET's reader reads it.
/// </summary>
public sealed partial class WebSocketTransportClientTests
{
    // helpers

    // what a client failed by its meter tells, once its server sent `frames` and then went: the close
    // code it sent, then its error and its close
    private static async Task<(int Code, object[] Told)> FailedBy((byte[] Frames, WebSocketTransportClientOptions Options) given)
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(given.Options);
        var (told, closed) = EndOf(client);
        var connecting = client.Connect(new WebSocketTransportClientConnectOptions { Host = Host, Port = listener.Port, CancellationToken = Cancelled });
        var (peer, head) = await listener.Next();
        int code;

        using (peer)
        {
            await Listener.Upgrade(peer, head);
            await connecting.WaitAsync(Patience, Cancelled);
            await peer.GetStream().WriteAsync(given.Frames, Cancelled);
            code = await CloseCodeOf(peer.GetStream());
        }

        // * its server gone, what it drained ends: told at once, not at its close timeout
        await closed.WaitAsync(Patience, Cancelled);

        return (code, Described(told));
    }

    // definition

    // spec 15.3
    [Fact]
    public async Task Fails_with_1009_at_its_head_without_waiting_for_its_payload_a_frame_that_would_take_its_message_past_maximumMessageBytes_a_continuation_among_them()
    {
        var options = new WebSocketTransportClientOptions { MaximumMessageBytes = 64 };

        // unmasked, as a server sends them: a frame that announces 100 octets, none of which comes;
        // then a continuation that announces 60 behind 12 that came
        foreach (var frames in new byte[][] { [0x82, 100], [0x02, 12, .. new byte[12], 0x00, 60] })
        {
            var (code, told) = await FailedBy((frames, options));

            Assert.Equal(1009, code);
            Assert.Equal(new object[] { TooBig(64), (false, false) }, told);
        }
    }

    // spec 15.3
    [Fact]
    public async Task Fails_with_1008_the_frame_past_maximumMessageFrames_at_its_head_an_empty_frame_counting()
    {
        var options = new WebSocketTransportClientOptions { MaximumMessageFrames = 4 };

        // * the fifth frame's head, the three before it empty, its payload never sent
        byte[] frames = [0x02, 1, 0x78, 0x00, 0, 0x00, 0, 0x00, 0, 0x00, 10];

        var (code, told) = await FailedBy((frames, options));

        Assert.Equal(1008, code);
        Assert.Equal(new object[] { "InvalidDataException: the connection is closed with 1008: a message past its maximumMessageFrames, 4 frames", (false, false) }, told);
    }

    // spec 15.3
    [Fact]
    public async Task Closes_at_once_a_connection_whose_verdict_falls_behind_a_message_its_router_paused_on_dropping_what_the_pause_holds()
    {
        // one write: a message whole, then a head of a reserved opcode; then the same with a second
        // message past 125 octets between them, which the pause holds
        foreach (var between in new byte[][] { [], [0x82, 126, 0x01, 0x2C, .. new byte[300]] })
        {
            using var listener = new Listener(IPAddress.Loopback);
            await using var client = new WebSocketTransportClient();
            var (told, closed) = EndOf(client);
            var messages = 0;

            // * its router pauses on every message, and never resumes
            client.Message += (_) =>
            {
                Interlocked.Increment(ref messages);
                client.Pause();
            };

            var connecting = client.Connect(new WebSocketTransportClientConnectOptions { Host = Host, Port = listener.Port, CancellationToken = Cancelled });
            var (peer, head) = await listener.Next();

            using (peer)
            {
                await Listener.Upgrade(peer, head);
                await connecting.WaitAsync(Patience, Cancelled);
                await peer.GetStream().WriteAsync((byte[])[0x82, 3, 0x61, 0x62, 0x63, .. between, 0x83, 0x00], Cancelled);

                Assert.Equal(1002, await CloseCodeOf(peer.GetStream()));
            }

            await closed.WaitAsync(Patience, Cancelled);

            Assert.Equal(1, messages);
            Assert.Equal(new object[] { "WebSocketException: the connection is closed with 1002: a frame head RFC 6455 forbids, a reserved opcode, 3", (false, false) }, Described(told));
        }
    }

    // spec 15.3; RFC 6455 §5.1, §5.2
    [Fact]
    public async Task Fails_with_1002_a_frame_head_RFC_6455_forbids_before_its_platform_reads_it()
    {
        foreach (var (frames, rule) in new (byte[], string)[]
        {
            ([0x82, 0x81, 1, 2, 3, 4, 0x78], "a masked frame"),
            ([0xA2, 0x01, 0x78], "a reserved bit set"),
            ([0x80, 0x01, 0x78], "a continuation with no message under way"),
            ([0x82, 0x7F, 0x80, 0, 0, 0, 0, 0, 0, 0], "a 64-bit length with its top bit set"),
        })
        {
            var (code, told) = await FailedBy((frames, new WebSocketTransportClientOptions()));

            Assert.Equal((rule, 1002), (rule, code));
            Assert.Equal(new object[] { $"WebSocketException: the connection is closed with 1002: a frame head RFC 6455 forbids, {rule}", (false, false) }, told);
        }
    }
}
