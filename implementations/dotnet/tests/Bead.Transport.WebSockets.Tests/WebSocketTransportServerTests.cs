using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketTransportServer"/>, on Kestrel, against a <see cref="ClientWebSocket"/>:
/// what it delivers, what it sends, how it starts and stops, and how its connections close.
/// </summary>
public sealed class WebSocketTransportServerTests : IAsyncLifetime
{
    // constants

    // a handle the tests give every connection, as a port given again would
    private const string Shared = "type=WS;ip=127.0.0.1;port=1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly WebSocketTransportStartOptions Loopback = new() { Address = "127.0.0.1", FindOpenPort = true };

    private readonly Channel<(TransportMessage Message, string ConnectionHandle)> _messages = Channel.CreateUnbounded<(TransportMessage, string)>();
    private readonly Channel<(bool WasClean, string ConnectionHandle)> _closes = Channel.CreateUnbounded<(bool, string)>();
    private readonly Channel<string> _connections = Channel.CreateUnbounded<string>();
    private WebSocketTransportServer _server = new();
    private int _port;

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static Uri UriOf(int port)
    {
        return new Uri($"ws://127.0.0.1:{port}/");
    }

    private static async Task<T> Next<T>(Channel<T> channel, TimeSpan? within = null)
    {
        return await channel.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(within ?? Patience, Cancelled);
    }

    private async Task Start(WebSocketTransportServerOptions options)
    {
        await Start(new WebSocketTransportServer(options));
    }

    private async Task Start(WebSocketTransportServer server)
    {
        await _server.Stop();
        _server = server;
        await Listen();
    }

    private async Task Listen()
    {
        _server.Message += (message, connectionHandle) =>
        {
            _messages.Writer.TryWrite((message, connectionHandle));
        };
        _server.Close += (wasClean, connectionHandle) =>
        {
            _closes.Writer.TryWrite((wasClean, connectionHandle));
        };
        _server.Connection += (connectionHandle) =>
        {
            _connections.Writer.TryWrite(connectionHandle);
        };
        _port = (await _server.Start(Loopback, Cancelled)).Port;
    }

    // a client connected, and the handle the server gave its connection
    private async Task<(ClientWebSocket Client, string ConnectionHandle)> Connect()
    {
        var client = new ClientWebSocket();

        await client.ConnectAsync(UriOf(_port), Cancelled);

        return (client, await Next(_connections));
    }

    private static async Task<(WebSocketReceiveResult Result, byte[] Bytes)> ReceiveOf(ClientWebSocket client)
    {
        var buffer = new byte[1024];
        var result = await client.ReceiveAsync(buffer, Cancelled).WaitAsync(Patience, Cancelled);

        return (result, buffer[..result.Count]);
    }

    // reads until the server's close comes, and answers it with its own status, as a browser does
    private static async Task<WebSocketCloseStatus?> AnswerClose(ClientWebSocket client)
    {
        while (true)
        {
            var (result, _) = await ReceiveOf(client);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                await client.CloseOutputAsync(result.CloseStatus ?? WebSocketCloseStatus.NormalClosure, null, Cancelled);

                return result.CloseStatus;
            }
        }
    }

    private static async Task AssertRefused(int port)
    {
        using var late = new ClientWebSocket();

        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return late.ConnectAsync(UriOf(port), Cancelled);
        });
    }

    private async Task<TcpClient> OpenTcp()
    {
        var tcp = new TcpClient();

        await tcp.ConnectAsync(IPAddress.Loopback, _port, Cancelled);

        return tcp;
    }

    private static string[] HandlesOf(IEnumerable<TransportServerClient> clients)
    {
        return [.. clients.Select((client) =>
        {
            return client.ConnectionHandle;
        })];
    }

    private static byte[] UpgradeRequest()
    {
        return Encoding.ASCII.GetBytes(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            $"Sec-WebSocket-Key: {Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))}\r\nSec-WebSocket-Version: 13\r\n\r\n");
    }

    // reads an answer's head, byte by byte, so nothing after it is taken with it
    private static async Task ReadHead(NetworkStream stream)
    {
        var head = new List<byte>();
        var buffer = new byte[1];

        while (!Encoding.ASCII.GetString([.. head]).EndsWith("\r\n\r\n", StringComparison.Ordinal))
        {
            Assert.Equal(1, await stream.ReadAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled));
            head.Add(buffer[0]);
        }

        Assert.StartsWith("HTTP/1.1 101 ", Encoding.ASCII.GetString([.. head]), StringComparison.Ordinal);
    }

    // a masked client text frame, as a browser sends one
    private static byte[] TextFrame(string text)
    {
        var payload = Encoding.UTF8.GetBytes(text);
        var mask = RandomNumberGenerator.GetBytes(4);
        var frame = new byte[6 + payload.Length];

        frame[0] = 0x81;
        frame[1] = (byte)(0x80 | payload.Length);
        mask.CopyTo(frame, 2);

        for (var index = 0; index < payload.Length; index += 1)
        {
            frame[6 + index] = (byte)(payload[index] ^ mask[index % 4]);
        }

        return frame;
    }

    /// <summary>A socket whose close throws, as one already broken can; the rest is the socket it wraps.</summary>
    private sealed class StubbornWebSocket(WebSocket socket) : WebSocket
    {
        public override WebSocketCloseStatus? CloseStatus
        {
            get
            {
                return socket.CloseStatus;
            }
        }

        public override string? CloseStatusDescription
        {
            get
            {
                return socket.CloseStatusDescription;
            }
        }

        public override WebSocketState State
        {
            get
            {
                return socket.State;
            }
        }

        public override string? SubProtocol
        {
            get
            {
                return socket.SubProtocol;
            }
        }

        public override void Abort()
        {
            socket.Abort();
        }

        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            return Task.FromException(new WebSocketException("the close cannot go out"));
        }

        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            return Task.FromException(new WebSocketException("the close cannot go out"));
        }

        public override void Dispose()
        {
            socket.Dispose();
        }

        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
        {
            return socket.ReceiveAsync(buffer, cancellationToken);
        }

        public override ValueTask<ValueWebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken cancellationToken)
        {
            return socket.ReceiveAsync(buffer, cancellationToken);
        }

        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            return socket.SendAsync(buffer, messageType, endOfMessage, cancellationToken);
        }

        public override ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            return socket.SendAsync(buffer, messageType, endOfMessage, cancellationToken);
        }

        public override ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, WebSocketMessageFlags messageFlags, CancellationToken cancellationToken)
        {
            return socket.SendAsync(buffer, messageType, messageFlags, cancellationToken);
        }
    }

    // definition

    public async ValueTask InitializeAsync()
    {
        await Listen();
    }

    public async ValueTask DisposeAsync()
    {
        await _server.Stop();
    }

    [Fact]
    public async Task Answers_a_request_that_does_not_upgrade_with_426()
    {
        // the TypeScript side's ws library answers the same to a request that asks no WebSocket
        using var http = new HttpClient();
        using var answered = await http.GetAsync(new Uri($"http://127.0.0.1:{_port}/"), Cancelled);

        Assert.Equal(426, (int)answered.StatusCode);
    }

    [Fact]
    public async Task Delivers_a_message_sent_in_frames_as_one_and_names_its_connection()
    {
        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await client.SendAsync(new byte[] { 0xA1, 0x11 }, WebSocketMessageType.Binary, false, Cancelled);
            await client.SendAsync(new byte[] { 0x00, 0x02 }, WebSocketMessageType.Binary, true, Cancelled);

            var (message, handle) = await Next(_messages);

            Assert.Equal(new byte[] { 0xA1, 0x11, 0x00, 0x02 }, message.Bytes.ToArray());
            Assert.False(message.IsText);
            Assert.Equal(connectionHandle, handle);
            Assert.StartsWith("type=WS;ip=127.0.0.1;port=", connectionHandle, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Delivers_text_as_text_and_binary_as_bytes_stamping_the_activity()
    {
        var time = new FakeTimeProvider();

        await Start(new WebSocketTransportServerOptions { Time = time });

        var (client, _) = await Connect();

        using (client)
        {
            Assert.Null(Assert.Single(_server.Clients).LastActivityTimestamp);

            time.Advance(TimeSpan.FromSeconds(1));
            await client.SendAsync("hi"u8.ToArray(), WebSocketMessageType.Text, true, Cancelled);

            var (text, _) = await Next(_messages);

            Assert.True(text.IsText);
            Assert.Equal(time.GetUtcNow(), Assert.Single(_server.Clients).LastActivityTimestamp);

            // each message stamps it again
            time.Advance(TimeSpan.FromSeconds(1));
            await client.SendAsync("bytes"u8.ToArray(), WebSocketMessageType.Binary, true, Cancelled);

            var (binary, _) = await Next(_messages);

            Assert.False(binary.IsText);
            Assert.Equal("bytes"u8.ToArray(), binary.Bytes.ToArray());
            Assert.Equal(time.GetUtcNow(), Assert.Single(_server.Clients).LastActivityTimestamp);
        }
    }

    [Fact]
    public async Task Sends_to_a_connection_in_order_one_message_at_a_time()
    {
        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await Task.WhenAll(Enumerable.Range(1, 20).Select((index) =>
            {
                return _server.Send(new[] { (byte)index }, connectionHandle);
            }));

            for (var index = 1; index <= 20; index += 1)
            {
                var (result, bytes) = await ReceiveOf(client);

                Assert.Equal(WebSocketMessageType.Binary, result.MessageType);
                Assert.Equal(new[] { (byte)index }, bytes);
            }
        }
    }

    [Fact]
    public async Task Answers_a_close_at_once_and_says_it_was_clean()
    {
        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await client.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled).WaitAsync(TimeSpan.FromSeconds(2), Cancelled);

            // well within the close timeout, 5 s, which only a peer that never answers waits out
            Assert.Equal((true, connectionHandle), await Next(_closes, TimeSpan.FromSeconds(2)));
            Assert.Empty(_server.ConnectionHandles);
        }
    }

    [Fact]
    public async Task Closes_with_1009_a_message_past_its_bound()
    {
        await Start(new WebSocketTransportServerOptions { MaximumMessageBytes = 64 });

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await client.SendAsync(new byte[100], WebSocketMessageType.Binary, true, Cancelled);

            var (result, _) = await ReceiveOf(client);

            Assert.Equal(WebSocketMessageType.Close, result.MessageType);
            Assert.Equal(WebSocketCloseStatus.MessageTooBig, result.CloseStatus);
            await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            Assert.Equal(connectionHandle, (await Next(_closes)).ConnectionHandle);
            Assert.True(_messages.Reader.Count == 0);
        }
    }

    [Fact]
    public async Task Drops_a_connection_that_never_answers_its_close_once_the_timeout_passed()
    {
        await Start(new WebSocketTransportServerOptions { CloseTimeout = TimeSpan.FromMilliseconds(200) });

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // the client reads nothing, so it never answers; 2 s is well past the 200 ms asked, and
            // well before the 5 s a close timeout left at its default would take
            await _server.CloseConnection(connectionHandle).WaitAsync(TimeSpan.FromSeconds(2), Cancelled);

            Assert.Equal((false, connectionHandle), await Next(_closes, TimeSpan.FromSeconds(2)));
        }
    }

    [Fact]
    public async Task Closes_each_connection_with_1001_as_it_stops()
    {
        var (client, _) = await Connect();

        using (client)
        {
            var receiving = ReceiveOf(client);
            var stopping = _server.Stop();
            var (result, _) = await receiving;

            Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, result.CloseStatus);
            await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            await stopping.WaitAsync(Patience, Cancelled);
        }
    }

    [Fact]
    public async Task Resolves_a_send_for_a_handle_nobody_holds()
    {
        await _server.Send(new byte[] { 1 }, "type=WS;ip=127.0.0.1;port=1").WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public void Listens_on_0_0_0_0_port_80_and_beats_every_30_seconds_when_told_nothing()
    {
        var start = new WebSocketTransportStartOptions();
        var options = new WebSocketTransportServerOptions();

        Assert.Equal(("0.0.0.0", 80, false), (start.Address, start.Port, start.FindOpenPort));
        Assert.Equal(TimeSpan.FromSeconds(30), options.Heartbeat);
        Assert.Equal(TimeSpan.FromSeconds(5), options.CloseTimeout);
        Assert.Null(options.MaximumMessageBytes);
    }

    [Fact]
    public async Task Starts_uninitialized_and_is_open_once_listening_on_a_port_the_system_picked()
    {
        await using var server = new WebSocketTransportServer();

        Assert.Equal(ReadyState.Uninitialized, server.ReadyState);

        var address = await server.Start(Loopback, Cancelled);

        Assert.Equal(ReadyState.Open, server.ReadyState);
        Assert.Equal("127.0.0.1", address.Address);
        Assert.True(address.Port > 0);
    }

    [Fact]
    public async Task Refuses_a_second_start_and_keeps_serving()
    {
        Assert.Equal("the transport server is already open", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _server.Start(Loopback, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, _server.ReadyState);

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await client.SendAsync(new byte[] { 1 }, WebSocketMessageType.Binary, true, Cancelled);

            Assert.Equal(connectionHandle, (await Next(_messages)).ConnectionHandle);
        }
    }

    [Fact]
    public async Task Refuses_a_second_start_while_the_first_is_still_starting()
    {
        await using var server = new WebSocketTransportServer();
        using var gate = new ManualResetEventSlim();
        var building = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // the first start held as it builds, as the TypeScript side's stub holds its start on a
        // gate: Kestrel binds without yielding, which leaves no other window to start again in
        server.Built += (_) =>
        {
            if (building.TrySetResult())
            {
                gate.Wait(Patience, Cancelled);
            }
        };

        var starting = Task.Run(() =>
        {
            return server.Start(Loopback, Cancelled);
        }, Cancelled);

        await building.Task.WaitAsync(Patience, Cancelled);
        Assert.Equal("the transport server is already connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return server.Start(Loopback, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Connecting, server.ReadyState);
        gate.Set();

        var address = await starting.WaitAsync(Patience, Cancelled);
        using var client = new ClientWebSocket();

        await client.ConnectAsync(UriOf(address.Port), Cancelled);
    }

    [Fact]
    public async Task Refuses_a_stop_while_starting_and_stops_once_started()
    {
        await using var server = new WebSocketTransportServer();
        using var gate = new ManualResetEventSlim();
        var building = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // held as it builds, as the start above is
        server.Built += (_) =>
        {
            if (building.TrySetResult())
            {
                gate.Wait(Patience, Cancelled);
            }
        };

        var starting = Task.Run(() =>
        {
            return server.Start(Loopback, Cancelled);
        }, Cancelled);

        await building.Task.WaitAsync(Patience, Cancelled);
        Assert.Equal("the transport server is starting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return server.Stop();
        })).Message);
        Assert.Equal(ReadyState.Connecting, server.ReadyState);
        gate.Set();

        var address = await starting.WaitAsync(Patience, Cancelled);

        await server.Stop().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Closed, server.ReadyState);
        await AssertRefused(address.Port);
    }

    [Fact]
    public async Task Throws_on_a_port_taken_ending_closed_and_starts_again_on_a_free_one_and_after_a_stop()
    {
        await using var other = new WebSocketTransportServer();

        await Assert.ThrowsAnyAsync<IOException>(() =>
        {
            return other.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = _port }, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, other.ReadyState);

        var address = await other.Start(Loopback, Cancelled);

        Assert.NotEqual(_port, address.Port);
        Assert.Equal(ReadyState.Open, other.ReadyState);

        await other.Stop().WaitAsync(Patience, Cancelled);
        await other.Start(Loopback, Cancelled);

        Assert.Equal(ReadyState.Open, other.ReadyState);
    }

    [Fact]
    public async Task A_start_that_fails_disposes_the_application_it_built()
    {
        await using var other = new WebSocketTransportServer();
        WebApplication? built = null;

        other.Built += (application) =>
        {
            built = application;
        };

        await Assert.ThrowsAnyAsync<IOException>(() =>
        {
            return other.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", Port = _port }, Cancelled);
        });
        Assert.NotNull(built);
        Assert.Throws<ObjectDisposedException>(() =>
        {
            return built.Services.GetService(typeof(IServer));
        });
    }

    [Fact]
    public async Task A_cancelled_start_throws_disposes_what_it_built_and_can_start_again()
    {
        await using var other = new WebSocketTransportServer();
        using var source = new CancellationTokenSource();
        WebApplication? built = null;

        other.Built += (application) =>
        {
            built = application;
        };
        await source.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return other.Start(Loopback, source.Token);
        });
        Assert.Equal(ReadyState.Closed, other.ReadyState);
        Assert.NotNull(built);
        Assert.Throws<ObjectDisposedException>(() =>
        {
            return built.Services.GetService(typeof(IServer));
        });

        var address = await other.Start(Loopback, Cancelled);

        Assert.NotEqual(0, address.Port);
    }

    [Fact]
    public async Task Stops_at_once_when_never_started_stops_twice_then_starts_again_and_accepts()
    {
        var never = new WebSocketTransportServer();

        Assert.Same(Task.CompletedTask, never.Stop());
        Assert.Equal(ReadyState.Uninitialized, never.ReadyState);
        await _server.Stop().WaitAsync(Patience, Cancelled);
        Assert.Same(Task.CompletedTask, _server.Stop());
        Assert.Equal(ReadyState.Closed, _server.ReadyState);
        _port = (await _server.Start(Loopback, Cancelled)).Port;

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            Assert.Equal([connectionHandle], _server.ConnectionHandles);
        }
    }

    [Fact]
    public async Task Clients_is_a_copy_without_the_sockets()
    {
        // a socket of the tests' own, whose port is known
        using var first = await OpenTcp();

        await first.GetStream().WriteAsync(UpgradeRequest(), Cancelled);
        await ReadHead(first.GetStream());

        var firstHandle = await Next(_connections);
        var port = ((IPEndPoint)first.Client.LocalEndPoint!).Port;
        var clients = _server.Clients;

        Assert.Equal([new TransportServerClient("127.0.0.1", firstHandle, null, port, TransportTypes.WebSocket)], clients);

        // in the order the connections came, whichever went in between — four, so a dictionary's
        // own order seldom passes for it; the copy taken before stays
        var (second, secondHandle) = await Connect();

        first.Dispose();
        await Next(_closes);

        var (third, thirdHandle) = await Connect();
        var (fourth, fourthHandle) = await Connect();
        var (fifth, fifthHandle) = await Connect();

        using (second)
        using (third)
        using (fourth)
        using (fifth)
        {
            Assert.Equal([secondHandle, thirdHandle, fourthHandle, fifthHandle], HandlesOf(_server.Clients));
            Assert.Equal([firstHandle], HandlesOf(clients));
        }
    }

    [Fact]
    public async Task Counts_the_connections_it_holds_and_gives_their_handles_for_no_one_outside_the_process()
    {
        var (first, firstHandle) = await Connect();
        var (second, secondHandle) = await Connect();

        using (first)
        using (second)
        {
            var gauges = _server.Gauges();

            Assert.Empty(gauges.Anomalies);
            Assert.Empty(gauges.Ceilings);
            Assert.Equal(new HashSet<string> { firstHandle, secondHandle }, new HashSet<string>(gauges.ConnectionHandles));
            Assert.Equal(new Dictionary<string, long> { ["connections"] = 2 }, gauges.Counts);
        }
    }

    [Fact]
    public async Task Resolves_false_closing_a_handle_nobody_holds()
    {
        Assert.False(await _server.CloseConnection("type=WS;ip=0.0.0.0;port=1").WaitAsync(Patience, Cancelled));
        Assert.True(_closes.Reader.Count == 0);
    }

    [Fact]
    public async Task Await_using_stops_it_closing_with_1001_and_refusing_what_comes_after()
    {
        using var client = new ClientWebSocket();
        var connected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new WebSocketTransportServer();
        Task<WebSocketCloseStatus?> answering;
        int port;

        await using (server)
        {
            server.Connection += (_) =>
            {
                connected.TrySetResult();
            };
            port = (await server.Start(Loopback, Cancelled)).Port;
            await client.ConnectAsync(UriOf(port), Cancelled);
            await connected.Task.WaitAsync(Patience, Cancelled);
            answering = AnswerClose(client);
        }

        Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, await answering.WaitAsync(Patience, Cancelled));
        Assert.Equal(ReadyState.Closed, server.ReadyState);
        await AssertRefused(port);
    }

    [Fact]
    public async Task Shutdown_stops_it_as_Stop_does()
    {
        // the name a server's facade stops its transport by, which only the C# side has
        var (client, _) = await Connect();

        using (client)
        {
            var answering = AnswerClose(client);

            await _server.Shutdown().WaitAsync(Patience, Cancelled);

            Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, await answering.WaitAsync(Patience, Cancelled));
            await AssertRefused(_port);
        }
    }

    [Fact]
    public async Task Stop_closes_every_connection_each_raising_its_close_before_it_resolves_and_stops_listening()
    {
        var (first, firstHandle) = await Connect();
        var (second, secondHandle) = await Connect();

        using (first)
        using (second)
        {
            var answering = Task.WhenAll(AnswerClose(first), AnswerClose(second));

            await _server.Stop().WaitAsync(Patience, Cancelled);

            Assert.True(_closes.Reader.TryRead(out var one));
            Assert.True(_closes.Reader.TryRead(out var other));
            // each answered 1001 with 1001, going away: not a clean close
            Assert.Equal(
                new HashSet<(bool, string)> { (false, firstHandle), (false, secondHandle) },
                new HashSet<(bool, string)> { one, other });
            Assert.Empty(_server.ConnectionHandles);
            Assert.Empty(_server.Clients);
            Assert.Equal(ReadyState.Closed, _server.ReadyState);
            await answering.WaitAsync(Patience, Cancelled);
            await AssertRefused(_port);
        }
    }

    [Fact]
    public async Task Shares_a_stop_already_in_progress()
    {
        var (client, _) = await Connect();

        using (client)
        {
            var answering = AnswerClose(client);
            var first = _server.Stop();
            var second = _server.Stop();

            Assert.Same(first, second);
            Assert.Equal(ReadyState.Closing, _server.ReadyState);
            await first.WaitAsync(Patience, Cancelled);
            await answering.WaitAsync(Patience, Cancelled);
            Assert.Equal(ReadyState.Closed, _server.ReadyState);
        }
    }

    [Fact]
    public async Task A_stop_reentered_from_a_close_listener_shares_the_stop_in_progress()
    {
        var reentered = new TaskCompletionSource<Task>(TaskCreationOptions.RunContinuationsAsynchronously);

        _server.Close += (_, _) =>
        {
            reentered.TrySetResult(_server.Stop());
        };

        var (client, _) = await Connect();

        using (client)
        {
            var answering = AnswerClose(client);
            var stopping = _server.Stop();

            Assert.Same(stopping, await reentered.Task.WaitAsync(Patience, Cancelled));
            await stopping.WaitAsync(Patience, Cancelled);
            await answering.WaitAsync(Patience, Cancelled);
        }
    }

    [Fact]
    public async Task A_stop_that_throws_still_ends_closed()
    {
        await using var server = new WebSocketTransportServer();

        server.Stopped += () =>
        {
            throw new IOException("stop failed");
        };

        var port = (await server.Start(Loopback, Cancelled)).Port;

        Assert.Equal("stop failed", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return server.Stop().WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Closed, server.ReadyState);
        await AssertRefused(port);
    }

    [Fact]
    public async Task CloseAll_closes_every_connection_with_1000_and_gives_nothing_without_one()
    {
        Assert.Empty(await _server.CloseAll().WaitAsync(Patience, Cancelled));

        var (first, firstHandle) = await Connect();
        var (second, secondHandle) = await Connect();

        using (first)
        using (second)
        {
            var answering = Task.WhenAll(AnswerClose(first), AnswerClose(second));
            var closed = await _server.CloseAll().WaitAsync(Patience, Cancelled);

            Assert.Equal([true, true], closed);
            Assert.Empty(_server.ConnectionHandles);
            Assert.Empty(_server.Clients);
            Assert.True(_closes.Reader.TryRead(out var one));
            Assert.True(_closes.Reader.TryRead(out var other));
            Assert.Equal(
                new HashSet<(bool, string)> { (true, firstHandle), (true, secondHandle) },
                new HashSet<(bool, string)> { one, other });

            var answered = await answering.WaitAsync(Patience, Cancelled);

            Assert.Equal([WebSocketCloseStatus.NormalClosure, WebSocketCloseStatus.NormalClosure], answered);
            Assert.Equal(ReadyState.Open, _server.ReadyState);
        }
    }

    [Fact]
    public async Task Pings_nothing_with_a_heartbeat_of_infinity_and_refuses_one_no_timer_holds()
    {
        foreach (var (heartbeat, isPinging) in new[] { (TimeSpan.FromMilliseconds(200), true), (Timeout.InfiniteTimeSpan, false) })
        {
            await Start(new WebSocketTransportServerOptions { Heartbeat = heartbeat });

            // a peer of the tests' own, read raw, so every frame the server sends shows
            using var tcp = await OpenTcp();
            var stream = tcp.GetStream();

            await stream.WriteAsync(UpgradeRequest(), Cancelled);
            await Next(_connections);
            await ReadHead(stream);

            var first = new byte[1];
            var reading = stream.ReadAsync(first, Cancelled).AsTask();
            var isRead = await Task.WhenAny(reading, Task.Delay(1_000, Cancelled)) == reading;

            Assert.Equal(isPinging, isRead);

            if (isRead)
            {
                // a ping, its opcode 9
                Assert.Equal(0x9, first[0] & 0x0F);
            }
            else
            {
                Assert.Single(_server.ConnectionHandles);
            }
        }

        foreach (var heartbeat in new[] { TimeSpan.Zero, TimeSpan.FromMilliseconds(1.5), TimeSpan.FromMilliseconds(int.MaxValue + 1L), TimeSpan.FromSeconds(-1) })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new WebSocketTransportServer(new WebSocketTransportServerOptions { Heartbeat = heartbeat });
            });
        }
    }

    [Fact]
    public async Task Meets_a_connection_already_registered_and_can_send_to_it()
    {
        var seen = new TaskCompletionSource<(bool IsRegistered, Task Sent)>(TaskCreationOptions.RunContinuationsAsynchronously);

        _server.Connection += (connectionHandle) =>
        {
            seen.TrySetResult((_server.ConnectionHandles.Contains(connectionHandle), _server.Send("hi"u8.ToArray(), connectionHandle)));
        };

        var (client, _) = await Connect();

        using (client)
        {
            var (isRegistered, sent) = await seen.Task.WaitAsync(Patience, Cancelled);

            Assert.True(isRegistered);
            await sent.WaitAsync(Patience, Cancelled);
            Assert.Equal("hi"u8.ToArray(), (await ReceiveOf(client)).Bytes);
        }
    }

    [Fact]
    public async Task Closes_one_connection_which_is_gone_once_it_resolves()
    {
        var (client, connectionHandle) = await Connect();

        using (client)
        using (var gate = new ManualResetEventSlim())
        {
            var heard = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            // a close listener that takes its time: the TypeScript side's close resolves once the
            // server's own close listeners ran, so this one must wait for it
            _server.Close += (_, _) =>
            {
                heard.TrySetResult();
                gate.Wait(Patience, Cancelled);
            };

            var answering = AnswerClose(client);
            var closing = _server.CloseConnection(connectionHandle);

            await heard.Task.WaitAsync(Patience, Cancelled);

            Assert.NotSame(closing, await Task.WhenAny(closing, Task.Delay(200, Cancelled)));
            gate.Set();
            Assert.True(await closing.WaitAsync(Patience, Cancelled));
            Assert.Empty(_server.ConnectionHandles);
            Assert.Empty(_server.Clients);
            Assert.Equal((true, connectionHandle), await Next(_closes));
            Assert.Equal(WebSocketCloseStatus.NormalClosure, await answering.WaitAsync(Patience, Cancelled));
        }
    }

    [Fact]
    public async Task Raises_an_error_with_the_handle_then_that_connection_s_close_on_a_protocol_error()
    {
        var events = new ConcurrentQueue<(string Name, string ConnectionHandle)>();
        Exception? error = null;

        _server.Error += (reason, connectionHandle) =>
        {
            error = reason;
            events.Enqueue(("error", connectionHandle));
        };
        _server.Close += (wasClean, connectionHandle) =>
        {
            events.Enqueue((wasClean ? "clean close" : "close", connectionHandle));
        };

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // a text frame that is not UTF-8
            await client.SendAsync(new byte[] { 0xFF, 0xFE }, WebSocketMessageType.Text, true, Cancelled);
            await Next(_closes);

            Assert.Equal([("error", connectionHandle), ("close", connectionHandle)], events);
            Assert.IsType<WebSocketException>(error);
        }
    }

    [Fact]
    public async Task Raises_connection_before_a_frame_that_arrived_with_the_upgrade_request()
    {
        var events = new ConcurrentQueue<string>();
        var heard = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _server.Connection += (_) =>
        {
            events.Enqueue("connection");
        };
        _server.Message += (message, _) =>
        {
            events.Enqueue($"message:{Encoding.UTF8.GetString(message.Bytes.Span)}");
            heard.TrySetResult();
        };

        using var tcp = await OpenTcp();

        await tcp.GetStream().WriteAsync((byte[])[.. UpgradeRequest(), .. TextFrame("early")], Cancelled);

        // its own listener's, not the one before it, whose turn may come first
        await heard.Task.WaitAsync(Patience, Cancelled);

        Assert.Equal(["connection", "message:early"], events);
    }

    [Fact]
    public async Task Stops_within_its_close_timeout_on_a_peer_that_never_finished_its_HTTP_request()
    {
        await Start(new WebSocketTransportServerOptions { CloseTimeout = TimeSpan.FromMilliseconds(200) });

        using var tcp = await OpenTcp();

        await tcp.GetStream().WriteAsync("GET / HTTP/1.1\r\nHost: x\r\n"u8.ToArray(), Cancelled);
        // long enough for Kestrel to start reading it, which is what keeps the connection busy
        await Task.Delay(100, Cancelled);

        var watch = Stopwatch.StartNew();

        await _server.Stop().WaitAsync(Patience, Cancelled);

        // Kestrel waits on a request it began to read, until the close timeout; the TypeScript side
        // waits on no peer that never upgraded
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(1), $"{watch.Elapsed}");
    }

    [Fact]
    public async Task Leaves_the_connection_a_newer_socket_took_the_handle_of_alone_when_the_older_one_closes()
    {
        await Start(new WebSocketTransportServer
        {
            Accepted = (socket, _) =>
            {
                return (socket, Shared);
            },
        });

        var (older, _) = await Connect();
        var (newer, connectionHandle) = await Connect();

        using (older)
        using (newer)
        {
            Assert.Equal(Shared, connectionHandle);
            await older.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled).WaitAsync(Patience, Cancelled);
            // a round trip on the newer: the older's end, which came first, is told by now
            await _server.Send(new byte[] { 1 }, Shared).WaitAsync(Patience, Cancelled);
            await ReceiveOf(newer);

            Assert.Equal([Shared], _server.ConnectionHandles);
            Assert.Equal(new Dictionary<string, long> { ["connections"] = 1 }, _server.Gauges().Counts);
            Assert.True(_closes.Reader.Count == 0);

            await newer.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((true, Shared), await Next(_closes));
            Assert.Empty(_server.ConnectionHandles);
            Assert.Equal(new Dictionary<string, long> { ["connections"] = 0 }, _server.Gauges().Counts);
        }
    }

    [Fact]
    public async Task Drops_a_connection_whose_close_throws_and_still_resolves_its_close_to_true()
    {
        StubbornWebSocket? stubborn = null;

        await Start(new WebSocketTransportServer(new WebSocketTransportServerOptions { CloseTimeout = TimeSpan.FromMilliseconds(200) })
        {
            Accepted = (socket, connectionHandle) =>
            {
                stubborn = new StubbornWebSocket(socket);

                return (stubborn, connectionHandle);
            },
        });

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // the close never went out, so nothing answers it: the socket is dropped at the close timeout
            Assert.True(await _server.CloseConnection(connectionHandle).WaitAsync(TimeSpan.FromSeconds(2), Cancelled));
            Assert.Equal(WebSocketState.Aborted, stubborn?.State);
            Assert.Empty(_server.ConnectionHandles);
            Assert.Empty(_server.Clients);
            Assert.Equal((false, connectionHandle), await Next(_closes));
        }
    }

    [Fact]
    public async Task Drops_a_peer_that_never_answers_its_pings_and_keeps_one_that_does()
    {
        await Start(new WebSocketTransportServerOptions { Heartbeat = TimeSpan.FromMilliseconds(500) });

        // the first reads nothing, so it answers no ping; the second, always reading, answers each
        var (silent, silentHandle) = await Connect();
        var (answering, answeringHandle) = await Connect();

        using (silent)
        using (answering)
        {
            var reading = answering.ReceiveAsync(new byte[16], Cancelled);

            Assert.Equal((false, silentHandle), await Next(_closes, TimeSpan.FromSeconds(5)));
            // a few beats more, and the one that answers is still there
            await Task.Delay(1_500, Cancelled);

            Assert.Equal([answeringHandle], _server.ConnectionHandles);
            Assert.True(_closes.Reader.Count == 0);
            Assert.False(reading.IsCompleted);
        }
    }
}
