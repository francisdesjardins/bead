using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Bead.Tests;
using Bead.Transport.WebSockets;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The places of the transports: an HTTP server's three bounds, read from the timers it arms on
/// its clock as a client of the tests' own drives it; an HTTP client's three durations, against a
/// handler of the tests' own; a WebSocket's heartbeat and a WebSocket server's close timeout, taken
/// or refused as each is built, on the real clock; and every client's connect timeout and
/// reconnection delay.
/// </summary>
public sealed partial class DurationsTests
{
    // constants

    private static readonly HttpTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    // a wait no bound of a server's reaches
    private const long LongestWait = 999_999_999_999_999;

    private static readonly string Token = new('T', 22);

    // httpTransportServer.exchangeTimeout, httpTransportServer.inactivityTimeout, httpTransportServer.maximumWait

    // the transport server's options, as it is built: the due of the timer it arms for an exchange
    // handed on, waiting its answer; never, none armed; refused, no server built
    private static Task<Observed> ExchangeTimeoutByOptions(TimeSpan? given)
    {
        return HttpServerOf(given is { } timeout ? new HttpTransportServerOptions { ExchangeTimeout = timeout } : new HttpTransportServerOptions(), async (drive) =>
        {
            using var asking = PostOf(drive.Url, (await drive.Connect(false), EnvelopeOf(EnvelopeKind.Request, 1)));

            // its head says the router has it, its timer armed
            using var head = await drive.Http.SendAsync(asking, HttpCompletionOption.ResponseHeadersRead, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(200, (int)head.StatusCode);

            return drive.Clock.Dues();
        });
    }

    // the due of the timer it arms for a connection drawn with no exchange under way
    private static Task<Observed> ServerIdleByOptions(TimeSpan? given)
    {
        return HttpServerOf(given is { } timeout ? new HttpTransportServerOptions { InactivityTimeout = timeout } : new HttpTransportServerOptions(), async (drive) =>
        {
            await drive.Connect(false);

            return drive.Clock.Dues();
        });
    }

    // the due of the timer it arms for a listen that asks a longer wait, held to the bound
    private static Task<Observed> MaximumWaitByOptions(TimeSpan? given)
    {
        return HttpServerOf(given is { } bound ? new HttpTransportServerOptions { MaximumWait = bound } : new HttpTransportServerOptions(), async (drive) =>
        {
            var connectionToken = await drive.Connect(true);
            var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            drive.Server.Listen += (isHeld, _) =>
            {
                if (isHeld)
                {
                    held.TrySetResult();
                }
            };

            var listening = new HttpRequestMessage(HttpMethod.Get, drive.Url);

            listening.Headers.TryAddWithoutValidation(HttpTransport.ConnectionTokenHeader, connectionToken);
            listening.Headers.TryAddWithoutValidation(HttpTransport.AfterHeader, "0");
            listening.Headers.TryAddWithoutValidation(HttpTransport.WaitHeader, LongestWait.ToString(CultureInfo.InvariantCulture));
            _ = drive.Http.SendAsync(listening, HttpCompletionOption.ResponseHeadersRead, Cancelled);
            await held.Task.WaitAsync(Patience, Cancelled);

            return drive.Clock.Dues();
        });
    }

    // a transport server on a clock of the tests' own, built with the options given, and started;
    // what the client of the tests' own then drives it to arms one timer, whose due it holds, or none
    private static async Task<Observed> HttpServerOf(HttpTransportServerOptions options, Func<ServerDrive, Task<IReadOnlyList<TimeSpan>>> drive)
    {
        var clock = new SteppingClock(Epoch);
        HttpTransportServer server;

        try
        {
            server = new HttpTransportServer(options with { Clock = clock });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await using (server)
        {
            var port = (await server.Start(Loopback, Cancelled)).Port;
            using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false });
            var dues = await drive(new ServerDrive(server, (http, clock, new Uri($"http://{Host}:{port}{HttpTransport.Pathname}"))));

            return HeldAt(dues is [var due] ? due : Never);
        }
    }

    // a POST of Bead's type, on a connection or to draw one, carrying what it is given
    private static HttpRequestMessage PostOf(Uri url, (string? ConnectionToken, byte[] Body) exchange)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new ByteArrayContent(exchange.Body) };

        request.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

        if (exchange.ConnectionToken is { } connectionToken)
        {
            request.Headers.TryAddWithoutValidation(HttpTransport.ConnectionTokenHeader, connectionToken);
        }

        return request;
    }

    // an envelope as the transport reads it: its layout, its kind and its call id
    private static byte[] EnvelopeOf(EnvelopeKind kind, uint callId)
    {
        var bytes = new byte[8];

        bytes[0] = 0xa1;
        bytes[1] = (byte)kind;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(4), callId);

        return bytes;
    }

    // httpTransportClient.inactivityTimeout, httpTransportClient.wait, httpTransportClient.pause

    // the transport client's options, as it is built: the due of the timer it arms at a listen's
    // first loss, as it listens again at once; never, none armed; refused, no client built
    private static Task<Observed> ClientInactivityByOptions(TimeSpan? given)
    {
        return HttpClientOf(given is { } timeout ? new HttpTransportClientOptions { InactivityTimeout = timeout } : new HttpTransportClientOptions(), async (drive) =>
        {
            (await drive.Fetch.Next()).Fail();

            var again = await drive.Fetch.Next();

            Assert.Equal(HttpMethod.Get, again.Method);

            return HeldAt(drive.Clock.Dues() is [var due] ? due : Never);
        });
    }

    // the wait its listen asks
    private static Task<Observed> WaitByOptions(TimeSpan? given)
    {
        return HttpClientOf(new HttpTransportClientOptions { Wait = Assert.NotNull(given) }, async (drive) =>
        {
            var listen = await drive.Fetch.Next();
            return HeldAt(TimeSpan.FromMilliseconds(long.Parse(listen.Wait ?? "", CultureInfo.InvariantCulture)));
        });
    }

    // the due of the timer it arms between a listen that brought nothing and the next, which comes
    // at it and not before; at once, none armed, and the next at once
    private static Task<Observed> PauseByOptions(TimeSpan? given)
    {
        return HttpClientOf(new HttpTransportClientOptions { Pause = Assert.NotNull(given) }, async (drive) =>
        {
            (await drive.Fetch.Next()).Answer(new HttpResponseMessage(HttpStatusCode.NoContent));

            var next = drive.Fetch.Next();

            await Until(() =>
            {
                return next.IsCompleted || drive.Clock.Dues().Count > 0;
            });

            if (next.IsCompleted)
            {
                Assert.Empty(drive.Clock.Dues());

                return HeldAt(TimeSpan.Zero);
            }

            var due = Assert.Single(drive.Clock.Dues());

            await drive.Clock.Advance(due - Millisecond);
            Assert.False(next.IsCompleted);
            await drive.Clock.Advance(Millisecond);
            await next;

            return HeldAt(due);
        });
    }

    // a transport client on a clock of the tests' own and on a handler of the tests' own, built with
    // the options given, and connected, listening; then what it holds, as the handler drives it
    private static async Task<Observed> HttpClientOf(HttpTransportClientOptions options, Func<ClientDrive, Task<Observed>> drive)
    {
        var clock = new SteppingClock(Epoch);
        using var fetch = new Fetch();
        HttpTransportClient client;

        try
        {
            client = new HttpTransportClient(options with { Clock = clock, Handler = fetch });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await using (client)
        {
            var connecting = client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);
            var drawn = new HttpResponseMessage(HttpStatusCode.Created);

            drawn.Headers.TryAddWithoutValidation(HttpTransport.ConnectionTokenHeader, Token);
            drawn.Headers.TryAddWithoutValidation(HttpTransport.ListenHeader, "?1");
            (await fetch.Next()).Answer(drawn);
            await connecting.WaitAsync(Patience, Cancelled);

            var observed = await drive(new ClientDrive(fetch, clock));

            await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);

            return observed;
        }
    }

    // webSocketTransport.heartbeat

    // the transport client's options, as it is built: taken or refused
    private static async Task<Observed> HeartbeatByClient(TimeSpan? given)
    {
        WebSocketTransportClient client;

        try
        {
            client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Heartbeat = Assert.NotNull(given) });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await client.DisposeAsync();

        return Taken();
    }

    // the transport server's options, as it is built: taken or refused
    private static async Task<Observed> HeartbeatByServer(TimeSpan? given)
    {
        WebSocketTransportServer server;

        try
        {
            server = new WebSocketTransportServer(new WebSocketTransportServerOptions { Heartbeat = Assert.NotNull(given) });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await server.DisposeAsync();

        return Taken();
    }

    // webSocketTransportServer.closeTimeout

    // the transport server's options, as it is built: taken or refused
    private static async Task<Observed> CloseTimeoutByOptions(TimeSpan? given)
    {
        WebSocketTransportServer server;

        try
        {
            server = new WebSocketTransportServer(new WebSocketTransportServerOptions { CloseTimeout = Assert.NotNull(given) });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await server.DisposeAsync();

        return Taken();
    }

    // transportClient.connectTimeout

    // an HTTP client's connect, on a handler that never answers it: connecting a millisecond short of
    // what it holds, timed out at it, its TimeoutException telling it, then closed; never, connecting
    // until aborted; refused, nothing fetched, the client uninitialized on the clock it was given,
    // and a reconnection refused
    private static async Task<Observed> ConnectTimeoutByHttp(TimeSpan? given)
    {
        var clock = new SteppingClock(Epoch);
        using var fetch = new Fetch();
        await using var client = new HttpTransportClient(new HttpTransportClientOptions { IsListening = false, Handler = fetch, Clock = clock });

        return await ConnectTimeoutOf(new Connecting(client, clock)
        {
            Connect = (token) =>
            {
                return client.Connect(new HttpConnectOptions { Host = Host, Port = 80, Timeout = Assert.NotNull(given) }, token);
            },
            StateOf = () =>
            {
                return client.ReadyState;
            },
            Reconnect = () =>
            {
                return client.Reconnect();
            },
            Reached = async () =>
            {
                await fetch.Next();
            },
            IsUntouched = () =>
            {
                return fetch.Count == 0;
            },
        });
    }

    // a WebSocket client's connect, to a peer that never answers its handshake: as an HTTP client's,
    // nothing opened where it is refused
    private static async Task<Observed> ConnectTimeoutByWebSocket(TimeSpan? given)
    {
        var clock = new SteppingClock(Epoch);
        using var listener = new Listener();
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = clock });
        TcpClient? peer = null;

        try
        {
            return await ConnectTimeoutOf(new Connecting(client, clock)
            {
                Connect = (token) =>
                {
                    return client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port, Timeout = Assert.NotNull(given) }, token);
                },
                StateOf = () =>
                {
                    return client.ReadyState;
                },
                Reconnect = () =>
                {
                    return client.Reconnect();
                },
                Reached = async () =>
                {
                    peer = (await listener.Next()).Peer;
                },
                IsUntouched = () =>
                {
                    return !listener.IsPending;
                },
            });
        }
        finally
        {
            peer?.Dispose();
        }
    }

    private static async Task<Observed> ConnectTimeoutOf(Connecting connecting)
    {
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var client = connecting.Client;
        Task connected;

        try
        {
            connected = connecting.Connect(cancelling.Token);

            if (connected.IsFaulted)
            {
                await connected;
            }
        }
        catch (ArgumentOutOfRangeException refused)
        {
            // nothing moved, and nothing is kept for a reconnection
            Assert.Equal((ReadyState.Uninitialized, true, connecting.Clock), (connecting.StateOf(), connecting.IsUntouched(), client.Clock));
            await Assert.ThrowsAsync<InvalidOperationException>(connecting.Reconnect);

            return Refused(refused);
        }

        await connecting.Reached();

        if (connecting.Clock.Dues() is not [var due])
        {
            Assert.Empty(connecting.Clock.Dues());
            await connecting.Clock.Advance(Clocks.LongestTimer);
            Assert.Equal(ReadyState.Connecting, connecting.StateOf());
            await cancelling.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return connected.WaitAsync(Patience, Cancelled);
            });
            Assert.Equal(ReadyState.Closed, connecting.StateOf());

            return HeldAt(Never);
        }

        await connecting.Clock.Advance(due - Millisecond);
        Assert.Equal(ReadyState.Connecting, connecting.StateOf());
        await connecting.Clock.Advance(Millisecond);

        var ended = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return connected.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(string.Create(CultureInfo.InvariantCulture, $"timed out after {due.TotalMilliseconds}ms"), ended.Message);
        Assert.Equal(ReadyState.Closed, connecting.StateOf());

        return HeldAt(due);
    }

    // transportClient.reconnectionDelay

    // a function of the previous delay and the attempt, on a WebSocket client whose connect was
    // refused, after a first attempt refused again: the delay its tap hears and the due of its wait,
    // the attempt at it and not before; at once, no wait and the attempt at once; refused, before
    // its tap hears it, no attempt more, and the client closed
    private static async Task<Observed> ReconnectionDelayByFunction(TimeSpan? given)
    {
        var delay = Assert.NotNull(given);
        var clock = new SteppingClock(Epoch);
        using var listener = new Listener();
        await using var client = new WebSocketTransportClient(new WebSocketTransportClientOptions { Clock = clock });
        var taps = Channel.CreateUnbounded<TimeSpan>();
        var connecting = client.Connect(new WebSocketConnectOptions { Host = Host, Port = listener.Port }, Cancelled);

        await Listener.Refuse((await Reached(listener, connecting)).Peer);
        await Assert.ThrowsAsync<WebSocketException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });

        var reconnecting = client.Reconnect(new TransportReconnectOptions
        {
            Delay = (_, _) =>
            {
                return delay;
            },
            Tap = (heard, _) =>
            {
                taps.Writer.TryWrite(heard);
            },
        });

        await Listener.Refuse((await Reached(listener, Task.WhenAny(reconnecting, taps.Reader.WaitToReadAsync(Cancelled).AsTask()).Unwrap())).Peer);
        await Task.WhenAny(reconnecting, taps.Reader.WaitToReadAsync(Cancelled).AsTask()).WaitAsync(Patience, Cancelled);

        if (!taps.Reader.TryRead(out var held))
        {
            var refused = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            {
                return reconnecting;
            });

            Assert.Equal((ReadyState.Closed, false), (client.ReadyState, listener.IsPending));

            return Refused(refused);
        }

        // at once, the attempt comes with the clock where it stands
        if (held != TimeSpan.Zero)
        {
            Assert.Equal([held], clock.Dues());
            await clock.Advance(held - Millisecond);
            Assert.False(listener.IsPending);
            await clock.Advance(Millisecond);
        }

        var (peer, head) = await Reached(listener, Task.WhenAny(reconnecting, taps.Reader.WaitToReadAsync(Cancelled).AsTask()).Unwrap());

        using (peer)
        using (await Listener.Answer((peer, head)))
        {
            await reconnecting.WaitAsync(Patience, Cancelled);

            Assert.Equal(ReadyState.Open, client.ReadyState);
        }

        return HeldAt(held);
    }

    // the listener's next connection, unless what was to reach it ended first: an attempt that failed
    // before the listener saw it says so at once, by its own exception where it has one, never by a
    // wait on the accept that runs out
    private static async Task<(TcpClient Peer, string Head)> Reached(Listener listener, Task ending)
    {
        var next = listener.Next();

        if (await Task.WhenAny(next, ending).WaitAsync(Patience, Cancelled) != next)
        {
            await ending;
            Assert.Fail("what was to reach the listener ended before it did");
        }

        return await next;
    }

    // waits, on the real clock, for what the side does on its own threads
    private static async Task Until(Func<bool> condition)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();

        while (!condition() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }

        Assert.True(condition(), "what was awaited never came");
    }

    /// <summary>A transport server started, on its clock, and a client of the tests' own at its URL.</summary>
    private sealed record ServerDrive(HttpTransportServer Server, (HttpClient Http, SteppingClock Clock, Uri Url) Client)
    {
        public HttpClient Http
        {
            get
            {
                return Client.Http;
            }
        }

        public SteppingClock Clock
        {
            get
            {
                return Client.Clock;
            }
        }

        public Uri Url
        {
            get
            {
                return Client.Url;
            }
        }

        // draws a connection, listening or not: the token the server drew
        public async Task<string> Connect(bool isListening)
        {
            using var request = PostOf(Url, (null, []));

            if (isListening)
            {
                request.Headers.TryAddWithoutValidation(HttpTransport.ListenHeader, "?1");
            }

            using var response = await Http.SendAsync(request, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(201, (int)response.StatusCode);

            return response.Headers.GetValues(HttpTransport.ConnectionTokenHeader).Single();
        }
    }

    /// <summary>A transport client connected, listening, the handler its exchanges go through, and its clock.</summary>
    private sealed record ClientDrive(Fetch Fetch, SteppingClock Clock);

    /// <summary>
    /// A client's connect, on its clock: how it is made, where the client stands, how it is asked to
    /// reconnect, how the test knows the connect reached its peer, and whether its peer saw nothing
    /// of it.
    /// </summary>
    private sealed record Connecting(IRouterClientTransport Client, SteppingClock Clock)
    {
        public required Func<CancellationToken, Task> Connect { get; init; }

        public required Func<ReadyState> StateOf { get; init; }

        public required Func<Task> Reconnect { get; init; }

        public required Func<Task> Reached { get; init; }

        public required Func<bool> IsUntouched { get; init; }
    }

    /// <summary>One exchange a client made, as the handler took it, answered as its test says.</summary>
    private sealed class Call
    {
        private readonly TaskCompletionSource<HttpResponseMessage> _answered = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Call(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Wait = request.Headers.TryGetValues(HttpTransport.WaitHeader, out var waits) ? waits.FirstOrDefault() : null;

            // an exchange aborted is answered by its abort
            cancellationToken.Register(() =>
            {
                _answered.TrySetCanceled(cancellationToken);
            });
        }

        public HttpMethod Method { get; }

        // the wait a listen asks, in its field
        public string? Wait { get; }

        public Task<HttpResponseMessage> Answered
        {
            get
            {
                return _answered.Task;
            }
        }

        public void Answer(HttpResponseMessage response)
        {
            if (!_answered.TrySetResult(response))
            {
                response.Dispose();
            }
        }

        // as a network that failed
        public void Fail()
        {
            _answered.TrySetException(new HttpRequestException("fetch failed"));
        }
    }

    /// <summary>
    /// What a client's exchanges go through: the TypeScript side's fake fetch. Each call waits for
    /// the answer its test gives, or for its abort; a DELETE is answered 204 at once.
    /// </summary>
    private sealed class Fetch : HttpMessageHandler
    {
        private readonly Channel<Call> _calls = Channel.CreateUnbounded<Call>();
        private int _count;

        // the calls it took, its DELETEs aside
        public int Count
        {
            get
            {
                return Volatile.Read(ref _count);
            }
        }

        public async Task<Call> Next()
        {
            return await _calls.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Delete)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }

            var call = new Call(request, cancellationToken);

            Interlocked.Increment(ref _count);
            _calls.Writer.TryWrite(call);

            return call.Answered;
        }
    }

    /// <summary>
    /// A listener of the tests' own: it takes each connection's handshake, and answers it, or refuses
    /// it, only when told to.
    /// </summary>
    private sealed class Listener : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);

        public Listener()
        {
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

        // the next connection, and the head of the handshake it asked
        public async Task<(TcpClient Peer, string Head)> Next()
        {
            var peer = await _listener.AcceptTcpClientAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
            var head = new StringBuilder();
            var buffer = new byte[1024];

            do
            {
                var count = await peer.GetStream().ReadAsync(buffer, Cancelled).AsTask().WaitAsync(Patience, Cancelled);

                head.Append(Encoding.ASCII.GetString(buffer, 0, count));
            }
            while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal));

            return (peer, head.ToString());
        }

        // answers the handshake the head asked for, and gives the server's end of the socket
        public static async Task<WebSocket> Answer((TcpClient Peer, string Head) handshake)
        {
            var key = handshake.Head
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

            await handshake.Peer.GetStream().WriteAsync(
                Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"),
                Cancelled);

            return WebSocket.CreateFromStream(handshake.Peer.GetStream(), new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.Zero });
        }

        // refuses the handshake with a 503, and hangs up
        public static async Task Refuse(TcpClient peer)
        {
            using (peer)
            {
                await peer.GetStream().WriteAsync("HTTP/1.1 503 Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray(), Cancelled);
            }
        }

        public void Dispose()
        {
            _listener.Dispose();
        }
    }
}
