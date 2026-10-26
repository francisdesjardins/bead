using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Bead.Tests;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketTransportClient"/>, on a <see cref="ClientWebSocket"/>, against a transport
/// server on Kestrel, and against a listener of the tests' own that answers a handshake its way,
/// refuses it, or never answers it: how it connects, what it delivers, how its connection closes,
/// and how it reconnects.
/// </summary>
public sealed class WebSocketTransportClientTests : IAsyncLifetime
{
    [Fact]
    public async Task Bounds_an_unresponsive_WebSocket_handshake_by_cancellation_timeout_and_disposal()
    {
        foreach (var ending in new[] { "cancel", "timeout", "dispose" })
        {
            var time = new FakeTimeProvider();
            using var handler = new PendingUpgrade();
            using var invoker = new HttpMessageInvoker(handler);
            using var cancelling = new CancellationTokenSource();
            await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time, Invoker = invoker });
            var connecting = client.Connect(Target with { Timeout = TimeSpan.FromMilliseconds(100) }, cancelling.Token);
            var outcome = Record.ExceptionAsync(() => { return connecting; });
            await handler.Entered.Task.WaitAsync(Patience, Cancelled);
            if (ending == "cancel") { await cancelling.CancelAsync(); }
            else if (ending == "timeout") { time.Advance(TimeSpan.FromMilliseconds(100)); }
            else { await client.DisposeAsync(); }
            var failure = await outcome.AsTask().WaitAsync(Patience, Cancelled);
            if (ending == "cancel") { Assert.IsAssignableFrom<OperationCanceledException>(failure); }
            else if (ending == "timeout") { Assert.IsType<TimeoutException>(failure); }
            else { Assert.Equal("the transport client was disposed as it connected", Assert.IsType<WebSocketException>(failure).Message); }
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            handler.Answer.TrySetException(new InvalidOperationException("late upgrade failure"));
            Assert.Empty(_server.ConnectionHandles);
        }
    }

    private sealed class PendingUpgrade : HttpMessageHandler
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<HttpResponseMessage> Answer { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Entered.TrySetResult();
            return Answer.Task;
        }
    }

    // constants

    private const string Host = "127.0.0.1";

    // a bearer credential, RFC 6750's own example, its auth-scheme included
    private const string Bearer = "Bearer mF_9.B5f-4.1JqM";

    // a router's largest envelope by default (spec 15.3)
    private const int EnvelopeLimit = 16_778_240;

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // a frame of an opcode RFC 6455 reserves, which fails the connection that reads it (§5.2)
    private static readonly byte[] ReservedFrame = [0x83, 0x01, 0x78];

    private readonly WebSocketTransportServer _server = new();
    private readonly Channel<(bool WasClean, string ConnectionHandle)> _closes = Channel.CreateUnbounded<(bool, string)>();
    private readonly Channel<string> _connections = Channel.CreateUnbounded<string>();
    private readonly WebSocketTransportClient _client = new();
    private int _port;

    // helpers

    private sealed class ObservedRequests(bool refuse) : DelegatingHandler(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectCallback = (context, token) =>
        {
            return refuse
                ? ValueTask.FromException<Stream>(new IOException("the test refuses its socket"))
                : HappyEyeballs.ConnectCallback(context, token);
        },
    })
    {
        public ConcurrentQueue<Uri> Uris { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Uris.Enqueue(request.RequestUri!);

            return base.SendAsync(request, cancellationToken);
        }
    }


    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private WebSocketConnectOptions Target
    {
        get
        {
            return new WebSocketConnectOptions { Host = Host, Port = _port };
        }
    }

    private static async Task<T> Next<T>(Channel<T> channel, TimeSpan? within = null)
    {
        return await channel.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(within ?? Patience, Cancelled);
    }

    // a port nothing listens on
    private static int ClosedPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        listener.Stop();

        return port;
    }

    // whether the peer closed its end of the connection: what is read then is nothing, or a reset
    private static async Task<bool> IsClosed(TcpClient peer)
    {
        try
        {
            return await peer.GetStream().ReadAsync(new byte[1], Cancelled).AsTask().WaitAsync(Patience, Cancelled) == 0;
        }
        catch (IOException)
        {
            return true;
        }
    }

    // the same wait after every failed attempt
    private static TransportReconnectDelay DelayOf(TimeSpan delay)
    {
        return (_, _) =>
        {
            return delay;
        };
    }

    // each close the client raises, in order
    private static Channel<(bool WasClean, bool WasQuick)> ClosesOf(WebSocketTransportClient client)
    {
        var closes = Channel.CreateUnbounded<(bool, bool)>();

        client.Close += (wasClean, wasQuick) =>
        {
            closes.Writer.TryWrite((wasClean, wasQuick));
        };

        return closes;
    }

    // what a client tells as its connection ends, in order: each error, then its close, which ends it
    private static (List<object> Told, Task Closed) EndOf(WebSocketTransportClient client)
    {
        var told = new List<object>();
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        client.Error += (reason) =>
        {
            lock (told)
            {
                told.Add(reason);
            }
        };
        client.Close += (wasClean, wasQuick) =>
        {
            lock (told)
            {
                told.Add((wasClean, wasQuick));
            }

            closed.TrySetResult();
        };

        return (told, closed.Task);
    }

    // what it told, each error by its type and its message, or kept whole, each close as it came
    private static object[] Described(List<object> told, bool isWorded = true)
    {
        lock (told)
        {
            return [.. told.Select((each) =>
            {
                return isWorded && each is Exception reason ? $"{reason.GetType().Name}: {reason.Message}" : each;
            })];
        }
    }

    // a client's 1009, as its Error tells it
    private static string TooBig(int maximumMessageBytes)
    {
        return string.Create(CultureInfo.InvariantCulture, $"InvalidDataException: the connection is closed with 1009: a message past its maximumMessageBytes, {maximumMessageBytes} bytes");
    }

    // the Authorization lines of a request's head, their values as they came
    private static List<string> AuthorizationsOf(byte[] head)
    {
        return [.. Encoding.ASCII.GetString(head)
            .Split("\r\n")
            .Where((line) =>
            {
                return line.StartsWith("Authorization:", StringComparison.OrdinalIgnoreCase);
            })
            .Select((line) =>
            {
                return line["Authorization:".Length..].Trim(' ', '\t');
            })];
    }

    // a connect the listener refuses: it fails, and its target is the one a reconnection takes
    private static async Task ConnectRefused(WebSocketTransportClient client, Listener listener)
    {
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, _) = await listener.Next();

        await Listener.Refuse(peer, 503);
        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });
    }

    /// <summary>
    /// A listener of the tests' own: it takes each connection's first bytes, a request's head or a
    /// TLS hello, and answers the handshake, or refuses it, only when told to.
    /// </summary>
    private sealed class Listener : IDisposable
    {
        private readonly TcpListener _listener;

        public Listener(IPAddress address)
        {
            _listener = new TcpListener(address, 0);
            _listener.Start();
        }

        public int Port
        {
            get
            {
                return ((IPEndPoint)_listener.LocalEndpoint).Port;
            }
        }

        // whether a connection waits to be taken
        public bool IsPending
        {
            get
            {
                return _listener.Pending();
            }
        }

        // the next connection, and what it sent first: a request's head, or a TLS hello
        public async Task<(TcpClient Peer, byte[] Head)> Next()
        {
            var peer = await _listener.AcceptTcpClientAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
            var head = new List<byte>();
            var buffer = new byte[1024];

            do
            {
                var count = await peer.GetStream().ReadAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled);

                head.AddRange(buffer[..count]);
            }
            while (head[0] == (byte)'G' && !Encoding.ASCII.GetString([.. head]).EndsWith("\r\n\r\n", StringComparison.Ordinal));

            return (peer, [.. head]);
        }

        // answers the handshake the head asked for, and leaves the frames that follow to be read raw
        public static async Task Upgrade(TcpClient peer, byte[] head)
        {
            var key = Encoding.ASCII.GetString(head)
                .Split("\r\n")
                .Single((line) =>
                {
                    return line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase);
                })["Sec-WebSocket-Key:".Length..]
                .Trim();
            // the handshake's own hash, which RFC 6455 names: nothing secret rests on it
#pragma warning disable CA5350
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes($"{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
#pragma warning restore CA5350

            await peer.GetStream().WriteAsync(
                Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"),
                Cancelled);
        }

        // answers the handshake the head asked for, and gives the server's end of the socket
        public static async Task<WebSocket> Answer(TcpClient peer, byte[] head)
        {
            await Upgrade(peer, head);

            return WebSocket.CreateFromStream(peer.GetStream(), new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.Zero });
        }

        // refuses the handshake with a status of its own, which the client's error names, and hangs up
        public static Task Refuse(TcpClient peer, int status)
        {
            return Refuse(peer, (status, null));
        }

        // and with its mark, when it is a refusal of the transport's own
        public static async Task Refuse(TcpClient peer, (int Status, string? Reason) refusal)
        {
            var mark = refusal.Reason is { } reason ? $"Bead-Refusal: {reason}\r\n" : "";

            using (peer)
            {
                await peer.GetStream().WriteAsync(
                    Encoding.ASCII.GetBytes($"HTTP/1.1 {refusal.Status} Refused\r\n{mark}Content-Length: 0\r\nConnection: close\r\n\r\n"),
                    Cancelled);
            }
        }

        public void Dispose()
        {
            _listener.Dispose();
        }
    }

    // definition

    public async ValueTask InitializeAsync()
    {
        _server.Close += (wasClean, connectionHandle) =>
        {
            _closes.Writer.TryWrite((wasClean, connectionHandle));
        };
        _server.Connection += (connectionHandle) =>
        {
            _connections.Writer.TryWrite(connectionHandle);
        };
        _port = (await _server.Start(new WebSocketTransportStartOptions { Address = Host, FindOpenPort = true }, Cancelled)).Port;
    }

    public async ValueTask DisposeAsync()
    {
        await _client.DisposeAsync();
        await _server.Stop();
    }

    [Fact]
    public void Beats_every_30_seconds_waits_30_seconds_and_asks_for_the_root_over_ws_when_told_nothing()
    {
        var options = new WebSocketTransportClientOptions();
        var target = new WebSocketConnectOptions { Host = Host, Port = 80 };
        var disconnect = new TransportDisconnectOptions();
        var reconnect = new TransportReconnectOptions();

        Assert.Equal(TimeSpan.FromSeconds(30), options.Heartbeat);
        Assert.Equal(TimeSpan.FromSeconds(5), options.CloseTimeout);
        Assert.Null(options.MaximumMessageBytes);
        Assert.Null(options.Clock);
        Assert.Equal(("/", false, TimeSpan.FromSeconds(30)), (target.Pathname, target.Secured, target.Timeout));
        Assert.Null(target.Protocols);
        Assert.Equal((true, false), (disconnect.IsClean, disconnect.IsQuick));
        Assert.Equal((5, false), (reconnect.MaximumAttempts, reconnect.CancellationToken.CanBeCanceled));
        Assert.Null(reconnect.Delay);
        Assert.Null(reconnect.Tap);
    }

    [Fact]
    public async Task Holds_one_ready_state_at_a_time_from_uninitialized_to_closed()
    {
        using var listener = new Listener(IPAddress.Loopback);

        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);

        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        // the listener holds the handshake, so nothing on another thread moves the state meanwhile
        Assert.Equal(ReadyState.Connecting, _client.ReadyState);

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
            Assert.Equal(ReadyState.Open, _client.ReadyState);

            // the server's end reads nothing yet, so the close waits for its answer
            var closing = _client.CloseConnection();

            Assert.Equal(ReadyState.Closing, _client.ReadyState);

            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(WebSocketMessageType.Close, received.MessageType);
            await server.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            await closing.WaitAsync(Patience, Cancelled);
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
        }
    }

    [Fact]
    public async Task Carries_no_credential_its_upgrade_did_not_carry_and_is_secure_under_wss_or_to_a_loopback_host_judged_by_the_URL_it_was_given()
    {
        await using var faraway = new WebSocketTransportClient();
        await using var secured = new WebSocketTransportClient();
        var instant = TimeSpan.FromMilliseconds(1);

        // judged from what it connects with, before its first connect from nothing
        Assert.Equal((false, false), (_client.Carries(Bearer), _client.IsSecure));
        await _client.Connect(Target, Cancelled);
        Assert.Equal((false, true), (_client.Carries(Bearer), _client.IsSecure));

        var observed = new ObservedRequests(true);
        using var invoker = new HttpMessageInvoker(observed);

        foreach (var (host, tls, expected) in new[]
        {
            ("bead.example", true, true),
            ("localhost", false, true),
            ("127.0.0.1", false, true),
            ("::1", false, true),
            ("bead.example", false, false),
            ("192.0.2.1", false, false),
            ("192.0.2.1", true, true),
        })
        {
            await using var judged = new WebSocketTransportClient(new WebSocketTransportClientOptions { Invoker = invoker });

            await Assert.ThrowsAsync<WebSocketException>(() =>
            {
                return judged.Connect(new WebSocketConnectOptions { Host = host, Port = 8_080, Secured = tls }, Cancelled);
            });
            Assert.Equal((false, expected), (judged.Carries(Bearer), judged.IsSecure));
        }

        // off the machine, in the clear or under TLS, whether its connect went through or not
        await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return faraway.Connect(new WebSocketConnectOptions { Host = "192.0.2.1", Port = 80, Timeout = instant }, Cancelled);
        });
        await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return secured.Connect(new WebSocketConnectOptions { Host = "192.0.2.1", Port = 443, Secured = true, Timeout = instant }, Cancelled);
        });
        Assert.Equal((false, true), (faraway.IsSecure, secured.IsSecure));
    }

    [Fact]
    public async Task Throws_what_its_socket_threw_when_nothing_listens_ending_closed_and_can_connect_again()
    {
        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return _client.Connect(new WebSocketConnectOptions { Host = Host, Port = ClosedPort() }, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, _client.ReadyState);

        await _client.Connect(Target, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Throws_on_a_port_no_url_can_hold_ending_closed()
    {
        await Assert.ThrowsAsync<UriFormatException>(() =>
        {
            return _client.Connect(new WebSocketConnectOptions { Host = Host, Port = 100_000 }, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
    }

    [Fact]
    public async Task Refuses_a_connect_while_open_reaching_no_server()
    {
        await _client.Connect(Target, Cancelled);
        await Next(_connections);

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Connect(Target, Cancelled);
        });

        Assert.Equal("the transport client is already open", refused.Message);
        Assert.Equal(ReadyState.Open, _client.ReadyState);
        Assert.Single(_server.ConnectionHandles);
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Refuses_a_second_connect_while_the_first_is_connecting_opening_one_socket_only()
    {
        var first = _client.Connect(Target, Cancelled);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Connect(Target, Cancelled);
        });
        await first.WaitAsync(Patience, Cancelled);
        await Next(_connections);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
        Assert.Single(_server.ConnectionHandles);
    }

    // spec 15.2
    [Fact]
    public async Task Writes_no_Origin_on_its_upgrade()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
        }

        var lines = Encoding.ASCII.GetString(head).Split("\r\n");

        // a page's browser writes its own, which the server judges; the client, none
        Assert.StartsWith("GET ", lines[0], StringComparison.Ordinal);
        Assert.DoesNotContain(lines, (line) =>
        {
            return line.StartsWith("Origin:", StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public async Task Refuses_a_connect_while_its_close_is_under_way_and_connects_again_once_closed()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // under way as long as the server's end reads nothing, whatever the machine's pace
            var closing = _client.CloseConnection();

            Assert.Equal("the transport client is already closing", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return _client.Connect(Target, Cancelled);
            })).Message);
            Assert.Equal(WebSocketMessageType.Close, (await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled)).MessageType);
            await server.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            await closing.WaitAsync(Patience, Cancelled);
        }

        await _client.Connect(Target, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task A_connect_cancelled_before_its_handshake_changes_nothing_and_one_cancelled_during_it_ends_closed()
    {
        using var before = new CancellationTokenSource();

        await before.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Connect(Target, before.Token);
        });
        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);

        using var listener = new Listener(IPAddress.Loopback);
        using var during = new CancellationTokenSource();
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, during.Token);
        var (peer, _) = await listener.Next();

        using (peer)
        {
            await during.CancelAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
            Assert.True(await IsClosed(peer));
        }

        await _client.Connect(Target, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Throws_a_TimeoutException_past_its_timeout_ending_closed_and_drops_the_socket_that_never_finished_its_handshake()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Timeout = TimeSpan.FromMilliseconds(100) }, Cancelled);
        var (peer, _) = await listener.Next();

        using (peer)
        {
            time.Advance(TimeSpan.FromMilliseconds(100));

            Assert.Equal("timed out after 100ms", (await Assert.ThrowsAsync<TimeoutException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            })).Message);
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.True(await IsClosed(peer));
        }
    }

    [Fact]
    public async Task Waits_on_its_handshake_without_end_with_an_infinite_timeout_until_its_token_is_cancelled()
    {
        var time = new SteppingClock(DateTimeOffset.UnixEpoch);
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Timeout = Timeout.InfiniteTimeSpan }, source.Token);
        var (peer, _) = await listener.Next();

        using (peer)
        {
            // a day, where the 30 seconds a timeout left at its default would have passed: no timer
            // armed, and still connecting
            await time.Advance(TimeSpan.FromDays(1));

            Assert.Empty(time.Dues());
            Assert.False(connecting.IsCompleted);
            Assert.Equal(ReadyState.Connecting, client.ReadyState);

            await source.CancelAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, client.ReadyState);
        }
    }

    [Fact]
    public async Task Finishes_a_connect_whose_provider_completion_callback_throws()
    {
        var callback = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reason = new InvalidOperationException("provider callback failed");
        await using var client = new WebSocketTransportClient();
        var errors = new List<Exception>();
        client.Error += errors.Add;
        await client.Connect(Target with
        {
            CredentialProvider = (token) =>
            {
                token.Register(() => { callback.TrySetResult(); throw reason; });
                return ValueTask.FromResult(Bearer);
            }
        }, Cancelled).WaitAsync(Patience, Cancelled);
        await callback.Task.WaitAsync(Patience, Cancelled);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Empty(errors);
        await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
    }

    [Fact]
    public async Task Bounds_a_pending_credential_provider_by_cancellation_timeout_and_disposal()
    {
        foreach (var ending in new[] { "cancel", "timeout", "dispose" })
        {
            foreach (var late in new[] { "value", "failure" })
            {
                var time = new FakeTimeProvider();
                var entered = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
                var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                using var cancelling = new CancellationTokenSource();
                await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
                var connecting = client.Connect(Target with { Timeout = TimeSpan.FromMilliseconds(100), CredentialProvider = (token) => { entered.TrySetResult(token); return new ValueTask<string>(answer.Task); } }, cancelling.Token);
                var outcome = Record.ExceptionAsync(() => { return connecting; });
                var providerToken = await entered.Task.WaitAsync(Patience, Cancelled);
                if (ending == "cancel") { await cancelling.CancelAsync(); }
                else if (ending == "timeout") { time.Advance(TimeSpan.FromMilliseconds(100)); }
                else { await client.DisposeAsync(); }
                var failure = await outcome.AsTask().WaitAsync(Patience, Cancelled);
                if (ending == "cancel") { Assert.IsAssignableFrom<OperationCanceledException>(failure); }
                else if (ending == "timeout") { Assert.IsType<TimeoutException>(failure); }
                else { Assert.Equal("the transport client was disposed as it connected", Assert.IsType<WebSocketException>(failure).Message); }
                Assert.Equal(ReadyState.Closed, client.ReadyState);
                Assert.False(client.Carries(Bearer));
                Assert.True(providerToken.IsCancellationRequested);
                if (late == "value") { answer.TrySetResult(Bearer); }
                else { answer.TrySetException(new InvalidOperationException("late provider failure")); }
                Assert.Empty(_server.ConnectionHandles);
            }
        }
    }

    [Fact]
    public async Task Joins_a_pending_provider_call_and_uses_its_late_outcome_for_the_waiting_attempt()
    {
        foreach (var late in new[] { "value", "failure" })
        {
            var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var cancelling = new CancellationTokenSource();
            await using var client = new WebSocketTransportClient();
            var calls = 0;
            var options = Target with { CredentialProvider = (_) => { calls++; entered.TrySetResult(); return new ValueTask<string>(answer.Task); } };
            var first = client.Connect(options, cancelling.Token);
            var failed = Record.ExceptionAsync(() => { return first; });
            await entered.Task.WaitAsync(Patience, Cancelled);
            await cancelling.CancelAsync();
            Assert.IsAssignableFrom<OperationCanceledException>(await failed.AsTask().WaitAsync(Patience, Cancelled));
            var second = client.Connect(options, Cancelled);
            var outcome = Record.ExceptionAsync(() => { return second; });
            Assert.Equal(1, calls);
            var failure = new InvalidOperationException("late provider failure");
            if (late == "failure")
            {
                answer.TrySetException(failure);
                var refused = Assert.IsType<WebSocketException>(await outcome.AsTask().WaitAsync(Patience, Cancelled));
                Assert.Equal("the credential provider failed", refused.Message);
                Assert.Same(failure, refused.InnerException);
            }
            else
            {
                answer.TrySetResult(Bearer);
                await second.WaitAsync(Patience, Cancelled);
                Assert.Equal(ReadyState.Open, client.ReadyState);
                Assert.True(client.Carries(Bearer));
                await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
            }
            Assert.Equal(1, calls);
        }
    }

    [Fact]
    public async Task Treats_a_provider_own_cancellation_as_its_failure_while_the_attempt_stays_live()
    {
        var reason = new OperationCanceledException("provider cancelled");
        await using var client = new WebSocketTransportClient();
        var refused = await Assert.ThrowsAsync<WebSocketException>(() => { return client.Connect(Target with { CredentialProvider = (_) => { throw reason; } }, Cancelled); });
        Assert.Equal("the credential provider failed", refused.Message);
        Assert.Same(reason, refused.InnerException);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
    }

    [Fact]
    public async Task Keeps_its_timeout_when_the_provider_completion_callback_throws()
    {
        var time = new FakeTimeProvider();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var callback = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reason = new InvalidOperationException("provider callback failed");
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var connecting = client.Connect(Target with
        {
            Timeout = TimeSpan.FromMilliseconds(100),
            CredentialProvider = (token) =>
            {
                token.Register(() => { callback.TrySetResult(); throw reason; });
                entered.TrySetResult(); return new ValueTask<string>(answer.Task);
            }
        }, Cancelled);
        var outcome = Record.ExceptionAsync(() => { return connecting; });
        await entered.Task.WaitAsync(Patience, Cancelled);
        time.Advance(TimeSpan.FromMilliseconds(100));
        var failure = Assert.IsType<TimeoutException>(await outcome.AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal("timed out after 100ms", failure.Message);
        await callback.Task.WaitAsync(Patience, Cancelled);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        answer.TrySetException(new InvalidOperationException("late provider failure"));
    }

    [Fact]
    public async Task Finishes_a_connect_while_its_provider_callback_blocks()
    {
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var left = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var client = new WebSocketTransportClient();
        try
        {
            var connecting = client.Connect(Target with
            {
                CredentialProvider = (token) =>
                {
                    token.Register(() => { entered.TrySetResult(); release.Wait(Cancelled); left.TrySetResult(); });
                    return ValueTask.FromResult(Bearer);
                }
            }, Cancelled);
            await entered.Task.WaitAsync(Patience, Cancelled);
            await connecting.WaitAsync(Patience, Cancelled);
            Assert.Equal(ReadyState.Open, client.ReadyState);
            await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
        }
        finally { release.Set(); await left.Task.WaitAsync(Patience, Cancelled); }
    }

    [Fact]
    public async Task DisposeAsync_while_connecting_fails_the_connect_ending_closed_and_closes_its_socket()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        // the handshake under way, which the listener never answers
        var (peer, _) = await listener.Next();

        using (peer)
        {
            await _client.DisposeAsync().AsTask().WaitAsync(Patience, Cancelled);

            await Assert.ThrowsAsync<WebSocketException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
            Assert.True(await IsClosed(peer));
        }
    }

    [Fact]
    public async Task Offers_its_protocols_in_the_handshake()
    {
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Protocols = ["echo"] }, source.Token);
        var (peer, head) = await listener.Next();

        using (peer)
        {
            Assert.Contains("\r\nSec-WebSocket-Protocol: echo\r\n", Encoding.ASCII.GetString(head), StringComparison.OrdinalIgnoreCase);

            // the listener never answers: the connect ends by its token
            await source.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
        }
    }

    [Theory]
    [InlineData("rpc", "/rpc")]
    [InlineData("/rpc", "/rpc")]
    [InlineData(null, "/")]
    public async Task Requests_the_path_its_pathname_names(string? pathname, string expected)
    {
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var target = new WebSocketConnectOptions { Host = Host, Port = listener.Port };
        var connecting = _client.Connect(pathname is null ? target : target with { Pathname = pathname }, source.Token);
        var (peer, head) = await listener.Next();

        using (peer)
        {
            Assert.StartsWith($"GET {expected} HTTP/1.1\r\n", Encoding.ASCII.GetString(head), StringComparison.Ordinal);

            // the listener never answers: the connect ends by its token
            await source.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
        }
    }

    [Fact]
    public async Task Offers_no_extension_in_its_upgrade_permessage_deflate_among_them()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        Assert.DoesNotContain("\r\nSec-WebSocket-Extensions:", Encoding.ASCII.GetString(head), StringComparison.OrdinalIgnoreCase);
        await Listener.Refuse(peer, 503);
        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
    }

    [Fact]
    public async Task Asks_for_wss_when_secured()
    {
        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return _client.Connect(new WebSocketConnectOptions { Host = Host, Port = ClosedPort(), Secured = true }, Cancelled);
        });

        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Secured = true }, source.Token);
        var (peer, head) = await listener.Next();

        using (peer)
        {
            // a TLS handshake record, where ws would have asked with GET
            Assert.Equal(0x16, head[0]);

            await source.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });
        }
    }

    [Fact]
    public async Task Brackets_an_IPv6_literal_host()
    {
        var observed = new ObservedRequests(true);
        using var invoker = new HttpMessageInvoker(observed);

        foreach (var host in new[] { "::1", "[::1]", "127.0.0.1", "example.test" })
        {
            await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Invoker = invoker });

            await Assert.ThrowsAsync<WebSocketException>(() =>
            {
                return client.Connect(new WebSocketConnectOptions { Host = host, Port = 8_080 }, Cancelled);
            });
        }

        Assert.Equal(
            ["ws://[::1]:8080/", "ws://[::1]:8080/", "ws://127.0.0.1:8080/", "ws://example.test:8080/"],
            observed.Uris.Select((uri) =>
            {
                Assert.True(uri.Scheme is "http" or "ws");

                return $"ws://{uri.Authority}{uri.PathAndQuery}";
            }));

        foreach (var host in new[] { "127.0.0.1", "localhost" })
        {
            await using var client = new WebSocketTransportClient();

            await client.Connect(new WebSocketConnectOptions { Host = host, Port = _port }, Cancelled);
            Assert.Equal(ReadyState.Open, client.ReadyState);
        }

        if (!Socket.OSSupportsIPv6)
        {
            return;
        }

        await using var server = new WebSocketTransportServer();
        var port = (await server.Start(new WebSocketTransportStartOptions { Address = "::1", FindOpenPort = true }, Cancelled)).Port;

        foreach (var host in new[] { "::1", "[::1]" })
        {
            await using var client = new WebSocketTransportClient();

            await client.Connect(new WebSocketConnectOptions { Host = host, Port = port }, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
        }
    }

    [Fact]
    public async Task Its_own_close_or_dispose_raises_a_clean_close_not_quick_on_both_ends()
    {
        await using var defaulted = new WebSocketTransportClient();
        await using var disposed = new WebSocketTransportClient();

        foreach (var (client, end) in new (WebSocketTransportClient, Func<Task>)[]
        {
            (_client, () =>
            {
                return _client.CloseConnection();
            }),
            // options given and left at their defaults close as none given
            (defaulted, () =>
            {
                return defaulted.CloseConnection(new TransportDisconnectOptions());
            }),
            (disposed, () =>
            {
                return disposed.DisposeAsync().AsTask();
            }),
        })
        {
            var closes = ClosesOf(client);

            await client.Connect(Target, Cancelled);

            var connectionHandle = await Next(_connections);

            await end().WaitAsync(Patience, Cancelled);

            Assert.Equal((true, false), await Next(closes));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Equal((true, connectionHandle), await Next(_closes));
        }
    }

    [Fact]
    public async Task Says_a_close_the_server_made_was_neither_clean_nor_quick_and_refuses_a_send_after_it()
    {
        var closes = ClosesOf(_client);

        await _client.Connect(Target, Cancelled);

        var connectionHandle = await Next(_connections);

        // closed with 1000, by the server: not this side's close
        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);
        Assert.Equal((false, false), await Next(closes));
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return _client.Send(new TransportMessage(new byte[] { 1 }, false));
        });
    }

    [Fact]
    public async Task Refuses_a_close_before_it_connects_and_once_closed()
    {
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return _client.CloseConnection();
        });

        await _client.Connect(Target, Cancelled);
        await _client.CloseConnection().WaitAsync(Patience, Cancelled);

        Assert.Equal("the transport client is closed, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return _client.CloseConnection();
        })).Message);
    }

    [Fact]
    public async Task Says_a_quick_close_was_quick_and_settles_it_without_waiting_on_the_server()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var closes = ClosesOf(_client);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // the server's end has read nothing yet: a close that waited for its answer would wait
            // out its close timeout, 5 s
            await _client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(TimeSpan.FromSeconds(2), Cancelled);

            Assert.Equal((true, true), await Next(closes));
            Assert.Equal(ReadyState.Closed, _client.ReadyState);

            // its close went out all the same, going away, which a server does not call clean
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(WebSocketMessageType.Close, received.MessageType);
            Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, received.CloseStatus);
        }
    }

    [Fact]
    public async Task A_dispose_during_a_close_settles_it_without_a_close_a_second_close_refused_meanwhile_and_it_can_connect_again()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var closes = ClosesOf(_client);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // the server's end reads nothing, so it never answers the close
            var first = _client.CloseConnection();

            await Assert.ThrowsAsync<DisconnectException>(() =>
            {
                return _client.CloseConnection();
            });
            await _client.DisposeAsync();

            // well within the close timeout, 5 s, which only a close nothing settled waits out
            await first.WaitAsync(TimeSpan.FromSeconds(2), Cancelled);

            Assert.Equal(ReadyState.Closed, _client.ReadyState);
            // dropped, not closed by a handshake: no close says otherwise
            Assert.True(closes.Reader.Count == 0);
        }

        await _client.Connect(Target, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Releases_a_replacement_opened_by_its_close_listener_before_dispose_completes()
    {
        var closes = new List<(bool WasClean, bool WasQuick)>();
        var errors = new List<Exception>();
        Task<Exception?>? replacement = null;

        _client.Close += (clean, quick) =>
        {
            closes.Add((clean, quick));
            replacement = Record.ExceptionAsync(() => { return _client.Connect(Target, Cancelled); }).AsTask();
        };
        _client.Error += errors.Add;
        await _client.Connect(Target, Cancelled);
        await _client.DisposeAsync().AsTask().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.NotNull(replacement);
        var failure = await replacement.WaitAsync(Patience, Cancelled);

        Assert.True(failure is null or WebSocketException or OperationCanceledException);
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.Equal([(true, false)], closes);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task A_dispose_on_a_client_never_connected_does_nothing()
    {
        await _client.DisposeAsync();

        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);
    }

    [Fact]
    public async Task A_dispose_on_an_open_client_leaves_it_closed_refusing_a_send_and_ready_to_connect_again()
    {
        await _client.Connect(Target, Cancelled);
        await _client.DisposeAsync();

        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.Equal("the transport client is closed, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return _client.Send(new TransportMessage(new byte[] { 1 }, false));
        })).Message);

        await _client.Connect(Target, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Writes_the_credential_it_is_given_on_its_upgrade_and_carries_those_bytes_alone()
    {
        using var listener = new Listener(IPAddress.Loopback);
        Assert.False(_client.Carries(Bearer));
        var upgrades = new List<string[]>();
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Credential = Bearer }, Cancelled);
        var (peer, head) = await listener.Next();
        upgrades.Add([.. AuthorizationsOf(head)]);

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // its Authorization, one line, as given
            Assert.Equal([Bearer], AuthorizationsOf(head));

            // those bytes alone, none a byte off, longer or shorter, nor trimmed of what a field
            // cannot hold
            Assert.True(_client.Carries(Bearer));
            Assert.All(new[] { "Bearer mF_9.B5f-4.1JqN", $"{Bearer}x", Bearer[..^1], $" {Bearer}", "", "Bearer mF_9.B5f-4.1Jq?" }, (other) =>
            {
                Assert.False(_client.Carries(other), other);
            });

            // the envelope alone goes: a credential a message is given is not sent beside it
            await _client.Send(new TransportMessage("hello"u8.ToArray(), false) { Credential = Bearer }).WaitAsync(Patience, Cancelled);

            var buffer = new byte[16];
            var received = await server.ReceiveAsync(buffer, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((WebSocketMessageType.Binary, "hello"), (received.MessageType, Encoding.ASCII.GetString(buffer, 0, received.Count)));
            await _client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
        }

        // none once its connection is gone, and none on an upgrade given none, an empty one among them
        Assert.False(_client.Carries(Bearer));

        var reconnecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (reopened, reopenedHead) = await listener.Next();
        using (reopened)
        using (await Listener.Answer(reopened, reopenedHead))
        {
            await reconnecting.WaitAsync(Patience, Cancelled);
            upgrades.Add([.. AuthorizationsOf(reopenedHead)]);
            Assert.Empty(AuthorizationsOf(reopenedHead));
            Assert.False(_client.Carries(""));
            Assert.False(_client.Carries(Bearer));
            await _client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
        }

        foreach (var given in new[] { null, "" })
        {
            await using var client = new WebSocketTransportClient();
            var bare = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Credential = given }, Cancelled);
            var (other, otherHead) = await listener.Next();
            upgrades.Add([.. AuthorizationsOf(otherHead)]);

            using (other)
            using (await Listener.Answer(other, otherHead))
            {
                await bare.WaitAsync(Patience, Cancelled);
                Assert.Empty(AuthorizationsOf(otherHead));
                Assert.False(client.Carries(""));
                Assert.False(client.Carries(Bearer));
            }
        }
        Assert.Equal(new string[][] { [Bearer], [], [], [] }, upgrades);
    }

    [Fact]
    public async Task Calls_its_credential_provider_at_each_attempt_a_reconnection_s_included_and_carries_the_bytes_it_handed()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var tokens = new List<CancellationToken>();
        var handed = 0;
        await using var client = new WebSocketTransportClient();
        var target = new WebSocketConnectOptions
        {
            Host = Host,
            Port = listener.Port,
            CredentialProvider = (token) =>
            {
                tokens.Add(token);
                handed += 1;

                // * its second call throws: that attempt fails, its throw the cause, and the next calls it again
                return handed == 2 ? throw new InvalidOperationException("the token store is away") : ValueTask.FromResult($"Bearer token-{handed}");
            },
        };
        var connecting = client.Connect(target, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
            Assert.Equal(["Bearer token-1"], AuthorizationsOf(head));
            Assert.Equal((true, 1), (client.Carries("Bearer token-1"), handed));

            var reconnecting = client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), MaximumAttempts = 2 });
            var (again, againHead) = await listener.Next();

            using (again)
            using (await Listener.Answer(again, againHead))
            {
                await reconnecting.WaitAsync(Patience, Cancelled);

                // the failed attempt went nowhere: the next one carries what the provider handed it
                Assert.Equal(["Bearer token-3"], AuthorizationsOf(againHead));
                Assert.Equal((false, true, 3), (client.Carries("Bearer token-1"), client.Carries("Bearer token-3"), handed));
                // each told when its attempt is over
                Assert.All(tokens, (token) =>
                {
                    Assert.True(token.IsCancellationRequested);
                });
                Assert.Equal(3, tokens.Count);
                await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
            }
        }

        // a provider's throw fails the connect, its cause
        await using var failing = new WebSocketTransportClient();
        var away = new InvalidOperationException("the token store is away");
        var thrown = await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return failing.Connect(
                target with
                {
                    CredentialProvider = (_) =>
                    {
                        throw away;
                    },
                },
                Cancelled);
        });

        Assert.Equal(("the credential provider failed", away, ReadyState.Closed), (thrown.Message, thrown.InnerException, failing.ReadyState));
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Refuses_a_credential_that_is_no_field_value_a_space_or_a_tab_first_or_last_among_them_or_over_a_URL_in_the_clear_off_the_loopback_before_its_upgrade_goes()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var target = new WebSocketConnectOptions { Host = Host, Port = listener.Port };

        foreach (var credential in new[] { $" {Bearer}", $"{Bearer} ", $"\t{Bearer}", $"{Bearer}\t", "Bearer a\r\nb", "Bearer é", "Bearer \0" })
        {
            Assert.Equal(
                "a credential holds visible ASCII, spaces and tabs alone, none first or last (Parameter 'credential')",
                (await Assert.ThrowsAsync<ArgumentException>(() =>
                {
                    return _client.Connect(target with { Credential = credential }, Cancelled);
                })).Message);
        }

        // the upgrade itself would carry it in the clear, a provider's alike, which is never called
        var called = 0;

        var provider = (CancellationToken _) =>
        {
            called += 1;

            return ValueTask.FromResult(Bearer);
        };

        foreach (var faraway in new[] { target with { Host = "192.0.2.1", Credential = Bearer }, target with { Host = "example.com", CredentialProvider = provider } })
        {
            Assert.Equal(
                "a credential never crosses off the machine in the clear: connect over wss, or to a host on the loopback (Parameter 'options')",
                (await Assert.ThrowsAsync<ArgumentException>(() =>
                {
                    return _client.Connect(faraway, Cancelled);
                })).Message);
        }

        // nothing moved: no state, no target a reconnection replays, no upgrade sent
        Assert.Equal(0, called);
        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Reconnect();
        });
        Assert.False(listener.IsPending);

        // a provider's value, held alike once handed: the connect fails, and a reconnection does not
        // try again what no attempt would mend
        await using var client = new WebSocketTransportClient();
        var handed = Bearer;
        var connecting = client.Connect(
            target with
            {
                CredentialProvider = (_) =>
                {
                    called += 1;

                    return ValueTask.FromResult(handed);
                },
            },
            Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
            handed = $"{Bearer} ";

            await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), MaximumAttempts = 3 }).WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Equal(2, called);
            Assert.Contains($"Authorization: {Bearer}\r\n", Encoding.ASCII.GetString(head), StringComparison.OrdinalIgnoreCase);
        }

        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Opens_no_connection_when_its_credential_provider_settles_after_cancellation()
    {
        var entered = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        var answer = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var errors = new List<Exception>();
        var closes = ClosesOf(_client);
        var opened = 0;

        _client.Error += errors.Add;
        _client.Opened += () =>
        {
            opened += 1;
        };

        var connecting = _client.Connect(Target with
        {
            CredentialProvider = (token) =>
            {
                entered.TrySetResult(token);

                return new ValueTask<string>(answer.Task);
            },
        }, cancelling.Token);
        var providerToken = await entered.Task.WaitAsync(Patience, Cancelled);

        try
        {
            await cancelling.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => { return connecting.WaitAsync(Patience, Cancelled); });
            Assert.True(providerToken.IsCancellationRequested);
        }
        finally
        {
            answer.TrySetResult(Bearer);
        }
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.False(_client.Carries(Bearer));
        Assert.Equal(0, opened);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Equal(0, _connections.Reader.Count);
        Assert.Equal(0, closes.Reader.Count);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Refuses_a_credential_and_a_credential_provider_given_together()
    {
        var both = Target with
        {
            Credential = Bearer,
            CredentialProvider = (_) =>
            {
                return ValueTask.FromResult(Bearer);
            },
        };

        Assert.Equal(
            "a connect takes a credential or a credential provider, not both (Parameter 'options')",
            (await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return _client.Connect(both, Cancelled);
            })).Message);
        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);
    }

    [Fact]
    public async Task Closes_with_1009_a_message_past_an_envelope_s_limit_16778240_bytes_when_told_no_bound()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var messages = Channel.CreateUnbounded<TransportMessage>();
        var closes = ClosesOf(_client);

        _client.Message += (message) =>
        {
            messages.Writer.TryWrite(message);
        };

        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // an envelope's limit is taken whole, one byte more closes
            await server.SendAsync(new byte[EnvelopeLimit], WebSocketMessageType.Binary, true, Cancelled);

            Assert.Equal(EnvelopeLimit, (await Next(messages)).Bytes.Length);

            var sending = server.SendAsync(new byte[EnvelopeLimit + 1], WebSocketMessageType.Binary, true, Cancelled);
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.MessageTooBig), (received.MessageType, received.CloseStatus));

            // what is left of the message goes, or fails as the socket goes: either way it is heard no more
            server.Abort();
            await Task.WhenAny(sending).WaitAsync(Patience, Cancelled);
            await Next(closes);

            Assert.True(messages.Reader.Count == 0);
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
        }
    }

    [Fact]
    public async Task Tells_a_server_that_drops_without_its_closing_handshake_by_a_FIN_or_a_reset_by_its_unclean_close_alone_no_error()
    {
        using var listener = new Listener(IPAddress.Loopback);

        foreach (var isReset in new[] { false, true })
        {
            await using var client = new WebSocketTransportClient();
            var (told, closed) = EndOf(client);
            var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
            var (peer, head) = await listener.Next();

            using (peer)
            {
                await Listener.Upgrade(peer, head);
                await connecting.WaitAsync(Patience, Cancelled);

                if (isReset)
                {
                    // a linger of 0: its close an abort, a reset sent rather than a FIN (RFC 9293 §3.10.5)
                    peer.Client.LingerState = new LingerOption(true, 0);
                    peer.Client.Close();
                }
                else
                {
                    peer.Client.Shutdown(SocketShutdown.Send);
                }

                await closed.WaitAsync(Patience, Cancelled);

                Assert.Equal(new object[] { (false, false) }, Described(told));
            }
        }
    }

    [Fact]
    public async Task Tells_a_protocol_error_on_its_connection_once_then_its_unclean_close()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var (told, closed) = EndOf(_client);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        {
            await Listener.Upgrade(peer, head);
            await connecting.WaitAsync(Patience, Cancelled);
            await peer.GetStream().WriteAsync(ReservedFrame, Cancelled);
            await peer.GetStream().WriteAsync(ReservedFrame, Cancelled);
            await closed.WaitAsync(Patience, Cancelled);

            Assert.Collection(
                Described(told, false),
                (error) =>
                {
                    Assert.Equal(WebSocketError.Faulted, Assert.IsType<WebSocketException>(error).WebSocketErrorCode);
                },
                (close) =>
                {
                    Assert.Equal((false, false), close);
                });
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
        }
    }

    [Fact]
    public async Task Fails_with_1009_a_message_past_its_bound_telling_one_error_that_names_maximumMessageBytes_then_an_unclean_close_even_when_its_server_answers_its_close()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { MaximumMessageBytes = 1024 });
        var (told, closed) = EndOf(client);
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            var sending = server.SendAsync(new byte[4096], WebSocketMessageType.Binary, true, Cancelled);
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.MessageTooBig), (received.MessageType, received.CloseStatus));

            // its close answered with a 1009 of its own
            await server.CloseOutputAsync(WebSocketCloseStatus.MessageTooBig, null, Cancelled);
            await closed.WaitAsync(Patience, Cancelled);
            await Task.WhenAny(sending).WaitAsync(Patience, Cancelled);

            Assert.Equal(new object[] { TooBig(1024), (false, false) }, Described(told));
        }
    }

    [Fact]
    public async Task Fails_with_1009_a_message_past_its_bound_for_a_server_that_never_answers_telling_one_error_then_an_unclean_close_once_its_close_timeout_passed()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { MaximumMessageBytes = 1024, CloseTimeout = TimeSpan.FromMilliseconds(200) });
        var (told, closed) = EndOf(client);
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            var sending = server.SendAsync(new byte[4096], WebSocketMessageType.Binary, true, Cancelled);
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);
            var began = TimeProvider.System.GetTimestamp();

            // it reads its close and answers nothing, its socket held open
            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.MessageTooBig), (received.MessageType, received.CloseStatus));

            await closed.WaitAsync(Patience, Cancelled);
            await Task.WhenAny(sending).WaitAsync(Patience, Cancelled);

            Assert.True(TimeProvider.System.GetElapsedTime(began) >= TimeSpan.FromMilliseconds(150));
            Assert.Equal(new object[] { TooBig(1024), (false, false) }, Described(told));
        }
    }

    [Fact]
    public async Task Fails_its_connection_on_a_protocol_error_whose_error_listener_throws_telling_its_close_all_the_same()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var closes = ClosesOf(_client);

        _client.Error += (_) =>
        {
            throw new InvalidOperationException("an error listener that throws");
        };

        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        {
            await Listener.Upgrade(peer, head);
            await connecting.WaitAsync(Patience, Cancelled);
            await peer.GetStream().WriteAsync(ReservedFrame, Cancelled);

            // what the listener threw goes on to the task no one awaits, the platform's
            Assert.Equal((false, false), await Next(closes));
            Assert.Equal(ReadyState.Closed, _client.ReadyState);
        }
    }

    [Fact]
    public async Task Raises_no_message_for_what_comes_after_it_sent_its_close()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var messages = Channel.CreateUnbounded<TransportMessage>();
        var closes = ClosesOf(_client);

        _client.Message += (message) =>
        {
            messages.Writer.TryWrite(message);
        };

        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
            await server.SendAsync(new byte[] { 1 }, WebSocketMessageType.Binary, true, Cancelled);

            Assert.Equal(new byte[] { 1 }, (await Next(messages)).Bytes.ToArray());

            var closing = _client.CloseConnection();
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(WebSocketMessageType.Close, received.MessageType);

            // sent once the client's close came: the client reads it to its close, and drops it
            await server.SendAsync(new byte[] { 2 }, WebSocketMessageType.Binary, true, Cancelled);
            await server.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            await closing.WaitAsync(Patience, Cancelled);
            await Next(closes);

            Assert.True(messages.Reader.Count == 0);
        }
    }

    [Fact]
    public async Task Hears_the_next_message_after_a_message_listener_throws_the_throw_reported()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var thrown = new InvalidOperationException("a message listener that throws");
        var messages = Channel.CreateUnbounded<TransportMessage>();
        var errors = Channel.CreateUnbounded<Exception>();
        var throws = 1;

        _client.Message += (_) =>
        {
            if (Interlocked.Exchange(ref throws, 0) == 1)
            {
                throw thrown;
            }
        };
        _client.Message += (message) =>
        {
            messages.Writer.TryWrite(message);
        };
        _client.Error += (reason) =>
        {
            errors.Writer.TryWrite(reason);
        };

        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);
            foreach (var (bytes, type) in new[]
            {
                (Encoding.UTF8.GetBytes("first"), WebSocketMessageType.Text),
                (new byte[] { 1 }, WebSocketMessageType.Binary),
                (Encoding.UTF8.GetBytes("second"), WebSocketMessageType.Text),
                (new byte[] { 2 }, WebSocketMessageType.Binary),
            })
            {
                await server.SendAsync(bytes, type, true, Cancelled);

                var message = await Next(messages);

                Assert.Equal(bytes, message.Bytes.ToArray());
                Assert.Equal(type == WebSocketMessageType.Text, message.IsText);
            }
            Assert.Same(thrown, await Next(errors));
            Assert.True(errors.Reader.Count == 0);
            Assert.Equal(ReadyState.Open, _client.ReadyState);
        }
    }

    [Fact]
    public async Task Closes_when_its_server_leaves_its_pings_unanswered_telling_no_error()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Heartbeat = TimeSpan.FromMilliseconds(500) });
        var (told, closed) = EndOf(client);
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // the server's end reads nothing, so it answers no ping
            await closed.WaitAsync(TimeSpan.FromSeconds(5), Cancelled);

            Assert.Equal(new object[] { (false, false) }, Described(told));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
        }
    }

    // a heartbeat refused is the durations' file's to play
    [Fact]
    public async Task Pings_nothing_with_a_heartbeat_of_infinity()
    {
        using var listener = new Listener(IPAddress.Loopback);

        foreach (var (heartbeat, isPinging) in new[] { (TimeSpan.FromMilliseconds(200), true), (Timeout.InfiniteTimeSpan, false) })
        {
            await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Heartbeat = heartbeat });
            var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
            var (peer, head) = await listener.Next();

            using (peer)
            {
                // read raw, so the server's end answers nothing and every frame the client sends shows
                await Listener.Upgrade(peer, head);
                await connecting.WaitAsync(Patience, Cancelled);

                var first = new byte[1];
                var reading = peer.GetStream().ReadAsync(first, Cancelled).AsTask();
                // a ping comes within the patience of every wait; its absence is waited for a second
                var isRead = await Task.WhenAny(reading, Task.Delay(isPinging ? Patience : TimeSpan.FromSeconds(1), Cancelled)) == reading;

                Assert.Equal(isPinging, isRead);

                if (isRead)
                {
                    // a ping, its opcode 9
                    Assert.Equal(0x9, first[0] & 0x0F);
                }
                else
                {
                    // unpinged, so never dropped for a ping left unanswered
                    Assert.Equal(ReadyState.Open, client.ReadyState);
                }
            }
        }
    }

    // a WebSocket's close timeout, its client's way of the durations' file, which the durations'
    // harness plays by its refusal; this loop holds, besides, what its connections are built with
    [Fact]
    public async Task Holds_its_close_timeout_to_a_whole_number_of_milliseconds_rounded_refusing_zero_and_runs_on_the_clock_it_is_given()
    {
        var time = new FakeTimeProvider();
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });

        Assert.Same(time, client.Clock);
        Assert.Same(TimeProvider.System, _client.Clock);

        var place = Durations.PlaceOf("webSocketTransport.closeTimeout");

        foreach (var (input, outcome) in Durations.Played(place, "client"))
        {
            var given = input.Given!.Value;

            if (outcome.Outcome == "refused")
            {
                var refused = Assert.Throws<ArgumentOutOfRangeException>(() =>
                {
                    return new WebSocketTransportClient(new WebSocketTransportClientOptions { CloseTimeout = given });
                });

                Assert.StartsWith(Durations.RefusalOf(("a close timeout", place), given), refused.Message, StringComparison.Ordinal);
                Assert.Equal(nameof(WebSocketTransportClientOptions.CloseTimeout), refused.ParamName);
            }
            else
            {
                await using var taken = new WebSocketTransportClient(new WebSocketTransportClientOptions { CloseTimeout = given });

                // rounded a half away from zero, as spec 1.4 rounds, and infinite kept as it is
                var held = given == Timeout.InfiniteTimeSpan
                    ? given
                    : TimeSpan.FromMilliseconds(Math.Round(given.TotalMilliseconds, MidpointRounding.AwayFromZero));

                Assert.Equal((input.Name, held), (input.Name, taken.CloseTimeout));
            }
        }
    }

    [Fact]
    public async Task Drops_a_server_that_never_answers_its_disconnect_once_its_close_timeout_passed_telling_no_error_its_close_as_the_disconnect_said()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { CloseTimeout = TimeSpan.FromMilliseconds(200) });
        var (told, _) = EndOf(client);
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            var began = TimeProvider.System.GetTimestamp();
            var closing = client.CloseConnection();

            // it reads its close and answers nothing, its socket held open
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.NormalClosure), (received.MessageType, received.CloseStatus));

            await closing.WaitAsync(Patience, Cancelled);

            Assert.True(TimeProvider.System.GetElapsedTime(began) >= TimeSpan.FromMilliseconds(150));
            Assert.Equal(new object[] { (true, false) }, Described(told));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
        }
    }

    // an infinite close timeout arms no timer: a server that does not answer its disconnect is
    // waited on without end, and its answer ends the close
    [Fact]
    public async Task Waits_on_its_server_without_end_for_a_close_timeout_of_infinity_closing_once_it_answers()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { CloseTimeout = Timeout.InfiniteTimeSpan });
        var (told, _) = EndOf(client);
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (var server = await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            var closing = client.CloseConnection();

            // it reads its close and answers nothing, for longer than any close timeout of these tests
            var received = await server.ReceiveAsync(new byte[16], Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.NormalClosure), (received.MessageType, received.CloseStatus));

            await Task.Delay(TimeSpan.FromMilliseconds(300), Cancelled);

            Assert.False(closing.IsCompleted);

            await server.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled);
            await closing.WaitAsync(Patience, Cancelled);

            Assert.Equal(new object[] { (true, false) }, Described(told));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
        }
    }

    [Fact]
    public async Task Reconnects_after_a_close()
    {
        await _client.Connect(Target, Cancelled);
        await _client.CloseConnection();
        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMilliseconds(10)), MaximumAttempts = 1 }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Reconnects_an_open_client_without_raising_a_close_its_replaced_connection_closed_at_the_server()
    {
        var closes = ClosesOf(_client);

        await _client.Connect(Target, Cancelled);

        var replaced = await Next(_connections);

        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMilliseconds(10)) }).WaitAsync(Patience, Cancelled);

        var opened = await Next(_connections);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
        Assert.NotEqual(replaced, opened);
        Assert.Equal(replaced, (await Next(_closes)).ConnectionHandle);
        Assert.Equal([opened], _server.ConnectionHandles);
        Assert.True(closes.Reader.Count == 0);
    }

    [Fact]
    public async Task Reconnects_to_the_target_of_the_last_accepted_connect()
    {
        await _client.Connect(Target, Cancelled);
        await Next(_connections);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Connect(Target with { Port = ClosedPort() }, Cancelled);
        });
        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero) }).WaitAsync(Patience, Cancelled);
        await Next(_connections);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task A_connect_refused_after_a_close_keeps_the_target_before_it_which_a_reconnection_replays()
    {
        await _client.Connect(Target, Cancelled);
        await Next(_connections);
        await _client.CloseConnection().WaitAsync(Patience, Cancelled);

        var refused = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
        {
            return _client.Connect(Target with { Port = ClosedPort(), Timeout = TimeSpan.FromMilliseconds(0.5) }, Cancelled);
        });

        Assert.StartsWith("a connect's timeout is a number of milliseconds from 1 to 2147483647, or infinite for never, not 0.5", refused.Message, StringComparison.Ordinal);
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero) }).WaitAsync(Patience, Cancelled);
        await Next(_connections);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Keeps_no_token_of_a_connect_for_its_reconnections()
    {
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);

        await _client.Connect(Target, source.Token);
        await source.CancelAsync();
        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, _client.ReadyState);
    }

    [Fact]
    public async Task Refuses_to_reconnect_a_client_never_connected_leaving_it_uninitialized()
    {
        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Reconnect();
        })).Message);
        Assert.Equal(ReadyState.Uninitialized, _client.ReadyState);
    }

    [Fact]
    public async Task Refuses_to_reconnect_while_a_close_is_under_way()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await connecting.WaitAsync(Patience, Cancelled);

            // the server's end reads nothing, so the close stays under way until the dispose
            var closing = _client.CloseConnection();

            Assert.Equal("the transport client cannot reconnect while closing", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return _client.Reconnect();
            })).Message);
            await _client.DisposeAsync();
            await closing.WaitAsync(Patience, Cancelled);
        }
    }

    [Fact]
    public async Task Refuses_to_reconnect_while_a_connect_is_under_way_and_that_connect_still_opens()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { CloseTimeout = TimeSpan.FromMilliseconds(100) });

        // under way as long as its handshake is held, whatever the machine's pace
        var connecting = client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = listener.Port }, Cancelled);
        var (peer, head) = await listener.Next();

        using var held = peer;

        Assert.Equal("the transport client cannot reconnect while connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);
        await Listener.Upgrade(peer, head);
        await connecting.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Refuses_a_second_reconnection_leaving_the_first_alone()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();

        await ConnectRefused(client, listener);

        var first = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMilliseconds(20)),
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });

        Assert.Equal("the transport client is already reconnecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);
        Assert.Equal(ReadyState.Reconnecting, client.ReadyState);

        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        await Next(taps);
        time.Advance(TimeSpan.FromMilliseconds(20));

        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await first.WaitAsync(Patience, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
        }
    }

    [Fact]
    public async Task Refuses_a_connect_while_it_waits_to_attempt_again()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMinutes(1)),
            CancellationToken = source.Token,
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        await Next(taps);

        Assert.Equal("the transport client is already reconnecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
        })).Message);

        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, client.ReadyState);
    }

    [Fact]
    public async Task Passes_on_what_its_tap_throws_ending_closed_with_no_attempt_after_it_and_no_wait_left_armed()
    {
        var time = new SteppingClock(DateTimeOffset.UnixEpoch);
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var failure = new FormatException("tap_error");

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMilliseconds(10)),
            Tap = (_, _) =>
            {
                throw failure;
            },
        });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        Assert.Same(failure, await Assert.ThrowsAsync<FormatException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal(ReadyState.Closed, client.ReadyState);

        // its wait disposed with it: no timer left to bring an attempt after
        Assert.Empty(time.Dues());
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Throws_an_InvalidOperationException_ending_closed_when_its_delay_throws()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = (_, _) =>
            {
                throw new FormatException("decay_error");
            },
        });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("decay_error", thrown.Message);
        Assert.IsType<FormatException>(thrown.InnerException);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
    }

    [Fact]
    public async Task Raises_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse()
    {
        var reconnects = 0;

        ((IRouterClientTransport)_client).Reconnect += () =>
        {
            Interlocked.Increment(ref reconnects);
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Reconnect();
        });
        Assert.Equal(0, reconnects);

        await _client.Connect(Target, Cancelled);
        await _client.Reconnect().WaitAsync(Patience, Cancelled);
        await _client.CloseConnection();
        await _client.Reconnect().WaitAsync(Patience, Cancelled);

        Assert.Equal(2, reconnects);
    }

    [Fact]
    public async Task Reconnects_though_a_reconnect_listener_throws_the_throw_reported_the_next_listener_told()
    {
        var thrown = new InvalidOperationException("a reconnect listener that throws");
        var reported = new List<Exception>();
        var told = 0;

        ((IRouterClientTransport)_client).Reconnect += () =>
        {
            throw thrown;
        };
        ((IRouterClientTransport)_client).Reconnect += () =>
        {
            Interlocked.Increment(ref told);
        };
        _client.Error += (reason) =>
        {
            lock (reported)
            {
                reported.Add(reason);
            }
        };

        await _client.Connect(Target, Cancelled);
        await _client.Reconnect().WaitAsync(Patience, Cancelled);

        // the reconnection went on to its attempt, which opened
        Assert.Equal(ReadyState.Open, _client.ReadyState);
        Assert.Equal(1, told);
        lock (reported)
        {
            Assert.Equal([thrown], reported);
        }
    }

    [Fact]
    public async Task Makes_its_first_attempt_at_once()
    {
        // a clock that never moves: a first attempt that waited would wait for ever
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = new FakeTimeProvider() });

        await client.Connect(Target, Cancelled);
        await client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMinutes(1)) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Waits_its_delay_after_each_failed_attempt_connecting_once_per_attempt()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();
        var attempts = new List<TimeSpan>();

        await ConnectRefused(client, listener);

        var started = time.GetUtcNow();
        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMilliseconds(60)),
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });

        for (var refusals = 0; refusals < 2; refusals += 1)
        {
            var (refused, _) = await listener.Next();

            attempts.Add(time.GetUtcNow() - started);
            await Listener.Refuse(refused, 503);
            await Next(taps);
            time.Advance(TimeSpan.FromMilliseconds(60));
        }

        var (peer, head) = await listener.Next();

        attempts.Add(time.GetUtcNow() - started);

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await reconnecting.WaitAsync(Patience, Cancelled);
        }

        Assert.Equal([TimeSpan.Zero, TimeSpan.FromMilliseconds(60), TimeSpan.FromMilliseconds(120)], attempts);
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Arms_its_wait_before_its_tap_hears_it_so_a_tap_that_moves_the_clock_by_the_wait_lets_the_next_attempt_follow_with_no_other_move()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        var observed = new ObservedRequests(false);
        using var invoker = new HttpMessageInvoker(observed);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time, Invoker = invoker });

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMilliseconds(60)),
            Tap = (delay, _) =>
            {
                time.Advance(delay);
            },
        });
        var (first, _) = await listener.Next();

        await Listener.Refuse(first, 503);

        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await reconnecting.WaitAsync(Patience, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
            Assert.Equal(3, observed.Uris.Count);
            Assert.False(listener.IsPending);
        }
    }

    [Fact]
    public async Task Tells_its_tap_the_wait_and_the_attempt_that_failed_and_nothing_when_the_first_succeeds()
    {
        var taps = new ConcurrentQueue<(TimeSpan Delay, int Attempt)>();
        var tap = (TimeSpan delay, int attempt) =>
        {
            taps.Enqueue((delay, attempt));
        };

        await _client.Connect(Target, Cancelled);
        await _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMilliseconds(10)), Tap = tap }).WaitAsync(Patience, Cancelled);

        Assert.Empty(taps);

        using var listener = new Listener(IPAddress.Loopback);
        await using var failingOnce = new WebSocketTransportClient();

        await ConnectRefused(failingOnce, listener);

        var reconnecting = failingOnce.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMilliseconds(10)), Tap = tap });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);

        var (peer, head) = await listener.Next();

        using (peer)
        using (await Listener.Answer(peer, head))
        {
            await reconnecting.WaitAsync(Patience, Cancelled);
        }

        Assert.Equal([(TimeSpan.FromMilliseconds(10), 1)], taps);
    }

    [Fact]
    public async Task Hands_its_delay_function_the_wait_before_and_the_attempt_that_failed()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient();
        var seen = new ConcurrentQueue<(TimeSpan? PreviousDelay, int Attempt)>();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = (previousDelay, attempt) =>
            {
                seen.Enqueue((previousDelay, attempt));

                return (previousDelay ?? TimeSpan.FromMilliseconds(5)) * 2;
            },
            MaximumAttempts = 4,
        });

        for (var refusals = 0; refusals < 4; refusals += 1)
        {
            var (refused, _) = await listener.Next();

            await Listener.Refuse(refused, 503);
        }

        await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(
            [(null, 1), (TimeSpan.FromMilliseconds(10), 2), (TimeSpan.FromMilliseconds(20), 3)],
            seen);
    }

    [Fact]
    public async Task Names_the_status_and_the_reason_of_an_upgrade_refused()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var failures = new List<(string Message, WebSocketError Error, Type? Inner)>();

        // marked, as a server's refusal of its own; then unmarked, a gateway's
        foreach (var refusal in new (int, string?)[] { (403, "host-refused"), (502, null) })
        {
            await using var client = new WebSocketTransportClient();
            var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);
            var (peer, _) = await listener.Next();

            await Listener.Refuse(peer, refusal);

            var thrown = await Assert.ThrowsAsync<WebSocketException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });

            failures.Add((thrown.Message, thrown.WebSocketErrorCode, thrown.InnerException?.GetType()));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
        }

        // the platform's own failure kept as its cause
        Assert.Equal(
            [
                ("the server refused the upgrade: 403 host-refused", WebSocketError.NotAWebSocket, typeof(WebSocketException)),
                ("the server refused the upgrade: 502", WebSocketError.NotAWebSocket, typeof(WebSocketException)),
            ],
            failures);
    }

    [Fact]
    public async Task Fails_its_connect_on_a_redirect_answered_to_its_upgrade_naming_its_status()
    {
        using var listener = new Listener(IPAddress.Loopback);
        var connecting = _client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Credential = Bearer }, Cancelled);
        var (peer, _) = await listener.Next();

        // to a server that would take the upgrade: followed, the connect would open there
        using (peer)
        {
            await peer.GetStream().WriteAsync(
                Encoding.ASCII.GetBytes($"HTTP/1.1 302 Found\r\nLocation: ws://{Host}:{_port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                Cancelled);

            var thrown = await Assert.ThrowsAsync<WebSocketException>(() =>
            {
                return connecting.WaitAsync(Patience, Cancelled);
            });

            Assert.Equal("the server refused the upgrade: 302", thrown.Message);
        }

        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Equal(0, _connections.Reader.Count);
        Assert.False(_client.Carries(Bearer));
    }

    [Fact]
    public async Task Connects_by_a_name_to_a_server_that_listens_on_one_loopback_family_alone_whichever_it_is()
    {
        var connects = new List<(string Address, TimeSpan Took)>();

        foreach (var address in Addresses.ReachedByLocalhost())
        {
            await using var server = new WebSocketTransportServer();
            var port = (await server.Start(new WebSocketTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled)).Port;
            await using var client = new WebSocketTransportClient();
            var started = TimeProvider.System.GetTimestamp();

            await client.Connect(new WebSocketConnectOptions { Host = "localhost", Port = port }, Cancelled).WaitAsync(Patience, Cancelled);
            connects.Add((address, TimeProvider.System.GetElapsedTime(started)));
            Assert.Equal((address, ReadyState.Open), (address, client.ReadyState));
        }

        // the families raced: neither waits out the other's refusal, two seconds on Windows
        Assert.All(connects, (connect) =>
        {
            Assert.True(connect.Took < TimeSpan.FromSeconds(1.5), $"{connect.Address}: {connect.Took}");
        });
    }

    [Fact]
    public async Task Throws_a_ReconnectException_carrying_the_last_failure_ending_closed()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), MaximumAttempts = 2 });

        // each refused with a status of its own, which its failure names
        foreach (var status in new[] { 501, 502 })
        {
            var (refused, _) = await listener.Next();

            await Listener.Refuse(refused, status);
        }

        var thrown = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("attempt 2 reached", thrown.Message);
        Assert.Contains("502", Assert.IsType<WebSocketException>(thrown.InnerException).Message, StringComparison.Ordinal);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Always_makes_one_attempt_even_with_a_maximum_of_zero()
    {
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), MaximumAttempts = 0 });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Makes_five_attempts_a_second_apart_when_told_nothing()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });

        for (var attempt = 1; attempt <= 5; attempt += 1)
        {
            var (refused, _) = await listener.Next();

            await Listener.Refuse(refused, 503);

            if (attempt < 5)
            {
                Assert.Equal((TimeSpan.FromSeconds(1), attempt), await Next(taps));
                time.Advance(TimeSpan.FromSeconds(1));
            }
        }

        Assert.Equal("attempt 5 reached", (await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Throws_an_OperationCanceledException_without_waiting_out_its_delay_when_cancelled_mid_wait()
    {
        var time = new FakeTimeProvider();
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMinutes(1)),
            CancellationToken = source.Token,
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        await Next(taps);
        // once the wait began; the clock never moves, so only the cancel ends it
        await source.CancelAsync();

        var thrown = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(source.Token, thrown.CancellationToken);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Never_attempts_with_a_token_cancelled_already_and_stops_at_the_wait_when_its_tap_cancels()
    {
        using var cancelled = new CancellationTokenSource();
        var reconnects = 0;

        ((IRouterClientTransport)_client).Reconnect += () =>
        {
            Interlocked.Increment(ref reconnects);
        };
        await cancelled.CancelAsync();
        await _client.Connect(Target, Cancelled);
        await Next(_connections);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), CancellationToken = cancelled.Token });
        });

        // the open connection left alone
        Assert.Equal(ReadyState.Open, _client.ReadyState);
        Assert.Equal(0, reconnects);
        Assert.True(_connections.Reader.Count == 0);

        using var listener = new Listener(IPAddress.Loopback);
        using var source = new CancellationTokenSource();
        await using var failing = new WebSocketTransportClient();

        await ConnectRefused(failing, listener);

        var reconnecting = failing.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMinutes(1)),
            CancellationToken = source.Token,
            Tap = (_, _) =>
            {
                source.Cancel();
            },
        });
        var (refused, _) = await listener.Next();

        await Listener.Refuse(refused, 503);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(ReadyState.Closed, failing.ReadyState);
        Assert.False(listener.IsPending);
    }

    [Fact]
    public async Task Cancels_the_attempt_in_flight_when_its_token_is_cancelled()
    {
        using var listener = new Listener(IPAddress.Loopback);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await using var client = new WebSocketTransportClient();

        await ConnectRefused(client, listener);

        var reconnecting = client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), CancellationToken = source.Token });
        // the attempt's handshake, which the listener never answers
        var (peer, _) = await listener.Next();

        using (peer)
        {
            await source.CancelAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return reconnecting.WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.True(await IsClosed(peer));
            Assert.False(listener.IsPending);
        }
    }

    [Fact]
    public async Task Cancels_a_reconnection_whose_last_attempt_closes_before_cancellation_is_checked()
    {
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var closes = ClosesOf(_client);
        var errors = new List<Exception>();

        _client.Error += errors.Add;
        await _client.Connect(Target, Cancelled);

        var replaced = await Next(_connections);
        Task? closing = null;
        var attempts = 0;

        _client.Opened += () =>
        {
            attempts += 1;
            Assert.Equal(ReadyState.Open, _client.ReadyState);
            closing = _client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
            Assert.True(closing.IsCompletedSuccessfully);
            source.Cancel();
        };

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1, CancellationToken = source.Token }).WaitAsync(Patience, Cancelled);
        });

        Assert.NotNull(closing);
        await closing;

        var opened = await Next(_connections);
        var ended = new HashSet<string> { (await Next(_closes)).ConnectionHandle, (await Next(_closes)).ConnectionHandle };

        Assert.Equal("the reconnection was cancelled", cancelled.Message);
        Assert.Equal(source.Token, cancelled.CancellationToken);
        Assert.Equal(1, attempts);
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        Assert.Equal((true, true), await Next(closes));
        Assert.Equal(0, closes.Reader.Count);
        Assert.Equal(new HashSet<string> { replaced, opened }, ended);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Disconnects_and_throws_an_OperationCanceledException_when_cancelled_once_its_attempt_opened()
    {
        using var source = new CancellationTokenSource();
        var closes = ClosesOf(_client);

        await _client.Connect(Target, Cancelled);

        var replaced = await Next(_connections);

        // right after the attempt opened, as the TypeScript side's test cancels from its connect
        _client.Opened += () =>
        {
            source.Cancel();
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), CancellationToken = source.Token }).WaitAsync(Patience, Cancelled);
        });

        var opened = await Next(_connections);

        Assert.Equal(ReadyState.Closed, _client.ReadyState);
        // the close of the disconnect, and none for the connection replaced
        Assert.Equal((true, false), await Next(closes));
        Assert.True(closes.Reader.Count == 0);
        Assert.Equal(
            new HashSet<string> { replaced, opened },
            new HashSet<string> { (await Next(_closes)).ConnectionHandle, (await Next(_closes)).ConnectionHandle });
    }

    [Fact]
    public async Task Throws_a_ReconnectException_from_what_its_socket_threw_when_the_server_is_gone()
    {
        var reconnecting = new TaskCompletionSource<Task>(TaskCreationOptions.RunContinuationsAsynchronously);

        // from its close, as the TypeScript side's test reconnects; one attempt, for a port nothing
        // listens on takes this system two seconds to refuse
        _client.Close += (_, _) =>
        {
            reconnecting.TrySetResult(_client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1 }));
        };
        await _client.Connect(Target, Cancelled);
        await Next(_connections);
        await _server.Stop().WaitAsync(Patience, Cancelled);

        var reconnect = await reconnecting.Task.WaitAsync(Patience, Cancelled);
        var thrown = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnect.WaitAsync(Patience, Cancelled);
        });

        Assert.IsType<WebSocketException>(thrown.InnerException);
        Assert.Equal(ReadyState.Closed, _client.ReadyState);
    }
}
