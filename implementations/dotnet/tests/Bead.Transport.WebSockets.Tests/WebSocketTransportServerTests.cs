using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Bead.Tests;
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

    // a bearer credential, RFC 6750's own example, its auth-scheme included
    private const string Bearer = "Bearer mF_9.B5f-4.1JqM";

    // a router's largest envelope by default (spec 15.3)
    private const int EnvelopeLimit = 16_778_240;

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // the addresses a server is secure on, the loopback's, and those it is not, the wildcards
    private static readonly string[] OnTheLoopbackOrNot = ["::1", "127.0.0.1", "127.0.0.2", "0.0.0.0", "::"];

    // the fields a response on an HTTP server's path carries, a refusal of the transport's own the
    // first two of them, and HTTP's own 400 none (spec 15.6)
    private static readonly string[] PathFields = ["cache-control", "x-content-type-options", "vary"];

    // RFC 6455 §1.3's key, 16 bytes in base64
    private const string Key = "dGhlIHNhbXBsZSBub25jZQ==";

    // RFC 6455 §1.3's handshake, at a host the tests' servers take
    private static readonly string[] Handshake =
    [
        "Host: bead.test",
        "Upgrade: websocket",
        "Connection: Upgrade",
        $"Sec-WebSocket-Key: {Key}",
        "Sec-WebSocket-Version: 13",
    ];

    // where the tests' clock stands, and the date a refusal carries from it
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private const string Today = "Thu, 01 Jan 2026 00:00:00 GMT";

    private static readonly WebSocketTransportStartOptions Loopback = new() { Address = "127.0.0.1", FindOpenPort = true };

    private readonly Channel<(TransportMessage Message, string ConnectionHandle)> _messages = Channel.CreateUnbounded<(TransportMessage, string)>();
    private readonly Channel<(bool WasClean, string ConnectionHandle)> _closes = Channel.CreateUnbounded<(bool, string)>();
    private readonly Channel<string> _connections = Channel.CreateUnbounded<string>();
    private readonly ConcurrentQueue<TransportServerRefusal> _refusals = new();
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

    private Task Listen()
    {
        return Listen(Loopback);
    }

    private async Task Listen(WebSocketTransportStartOptions start)
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
        _server.Refusal += _refusals.Enqueue;
        _port = (await _server.Start(start, Cancelled)).Port;
    }

    /// <summary>Whether this platform opens two sockets from one address and port.</summary>
    public static bool OpensTwoSocketsFromOnePort
    {
        get
        {
            return SamePort.IsOpened;
        }
    }

    // a server of its own, listening on every address of the machine, its loopback ones among them
    private async Task ListenEverywhere()
    {
        await _server.Stop();
        _server = new WebSocketTransportServer();
        await Listen(new WebSocketTransportStartOptions { Address = "0.0.0.0", FindOpenPort = true });
    }

    // the rank a handle names
    private static long OrdinalOf(string connectionHandle)
    {
        return long.Parse(connectionHandle.Split(";ordinal=")[1], CultureInfo.InvariantCulture);
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

    // what the server answers a head on a socket of its own, written one octet per character
    // (ISO-8859-1), read until it lets go of the socket: its status and its mark, and the socket's
    // own port, which the server sees as its peer's
    private async Task<(int Status, string? Reason, int Port)> RefusalOf(string head)
    {
        using var tcp = await OpenTcp();
        var stream = tcp.GetStream();
        var answer = new MemoryStream();

        await stream.WriteAsync(Encoding.Latin1.GetBytes(head), Cancelled);
        await stream.CopyToAsync(answer, Cancelled).WaitAsync(Patience, Cancelled);

        var lines = Encoding.ASCII.GetString(answer.ToArray()).Split("\r\n");
        var reason = lines.FirstOrDefault((line) =>
        {
            return line.StartsWith("bead-refusal:", StringComparison.OrdinalIgnoreCase);
        })?["bead-refusal:".Length..].Trim();

        return (int.Parse(lines[0].Split(' ')[1], CultureInfo.InvariantCulture), reason, ((IPEndPoint)tcp.Client.LocalEndPoint!).Port);
    }

    private static async Task Until(Func<bool> condition)
    {
        var watch = Stopwatch.StartNew();

        while (!condition() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }
    }

    private static byte[] UpgradeRequest()
    {
        return Encoding.ASCII.GetBytes(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            $"Sec-WebSocket-Key: {Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))}\r\nSec-WebSocket-Version: 13\r\n\r\n");
    }

    // an opening handshake naming a host, from a page of an origin when given one
    private static byte[] UpgradeRequest((string Host, string? Origin) from)
    {
        var origin = from.Origin is { } given ? $"Origin: {given}\r\n" : "";

        return Encoding.ASCII.GetBytes(
            $"GET / HTTP/1.1\r\nHost: {from.Host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n{origin}" +
            $"Sec-WebSocket-Key: {Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))}\r\nSec-WebSocket-Version: 13\r\n\r\n");
    }

    // what the server answers a handshake on a socket of its own, read until it lets go of the
    // socket: its status, its fields by their names in lower case, and its body
    private Task<(int Status, Dictionary<string, string> Fields, string Body)> AnswerOf((string Host, string? Origin) from)
    {
        return AnswerOf(UpgradeRequest(from));
    }

    private async Task<(int Status, Dictionary<string, string> Fields, string Body)> AnswerOf(byte[] request)
    {
        using var tcp = await OpenTcp();
        var stream = tcp.GetStream();
        var answer = new MemoryStream();

        await stream.WriteAsync(request, Cancelled);
        await stream.CopyToAsync(answer, Cancelled).WaitAsync(Patience, Cancelled);

        var text = Encoding.ASCII.GetString(answer.ToArray());
        var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var lines = text[..end].Split("\r\n");
        var fields = lines[1..].ToDictionary(
            (line) =>
            {
                return line[..line.IndexOf(':', StringComparison.Ordinal)].ToLowerInvariant();
            },
            (line) =>
            {
                return line[(line.IndexOf(':', StringComparison.Ordinal) + 1)..].Trim();
            });

        return (int.Parse(lines[0].Split(' ')[1], CultureInfo.InvariantCulture), fields, text[(end + 4)..]);
    }

    // RFC 6455 §1.3's handshake at bead.test, under the start line given: each field line given in
    // place of those of its name, which a name alone leaves out
    private static byte[] HandshakeOf(string start, params string[] fields)
    {
        var named = fields.Select(NameOf).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var lines = Handshake.Where((line) =>
        {
            return !named.Contains(NameOf(line));
        }).Concat(fields.Where((field) =>
        {
            return field.Contains(':', StringComparison.Ordinal);
        }));

        return Encoding.ASCII.GetBytes($"{start}\r\n{string.Concat(lines.Select((line) =>
        {
            return $"{line}\r\n";
        }))}\r\n");
    }

    // a field line's name, or the name given alone
    private static string NameOf(string field)
    {
        var colon = field.IndexOf(':', StringComparison.Ordinal);

        return colon < 0 ? field : field[..colon];
    }

    // the whole head of a refusal of the transport's own: marked, never stored nor sniffed, dated by
    // the tests' clock, its body empty, its connection closed, and the fields given beside or in
    // place of those
    private static Dictionary<string, string> RefusedWith(string reason, params (string Name, string Value)[] beside)
    {
        var fields = new Dictionary<string, string>
        {
            ["bead-refusal"] = reason,
            ["cache-control"] = "no-store",
            ["x-content-type-options"] = "nosniff",
            ["content-length"] = "0",
            ["connection"] = "close",
            ["date"] = Today,
        };

        foreach (var (name, value) in beside)
        {
            fields[name] = value;
        }

        return fields;
    }

    // a server started on the tests' clock, which dates its refusals
    private async Task StartDated(WebSocketTransportServerOptions options)
    {
        await Start(options with { Clock = new FakeTimeProvider(Now) });
    }

    // that the server answers each request with the status and the whole head given, its body empty,
    // and lets go of its socket; each told by its own octets
    private async Task AssertAnswered(IEnumerable<byte[]> requests, (int Status, Dictionary<string, string> Fields) expected)
    {
        static string FieldsOf(Dictionary<string, string> fields)
        {
            return string.Join("; ", fields.OrderBy((field) =>
            {
                return field.Key;
            }, StringComparer.Ordinal).Select((field) =>
            {
                return $"{field.Key}: {field.Value}";
            }));
        }

        foreach (var request in requests)
        {
            var asked = Encoding.ASCII.GetString(request).Replace("\r\n", " | ", StringComparison.Ordinal);
            var answer = await AnswerOf(request);

            Assert.Equal(
                (asked, expected.Status, FieldsOf(expected.Fields), ""),
                (asked, answer.Status, FieldsOf(answer.Fields), answer.Body));
        }
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

    // a socket of another process's on the IPv6 loopback, IPv6 alone, listening on the port given,
    // any free one for 0
    private static Socket HeldOnIPv6(int port)
    {
        var socket = new Socket(AddressFamily.InterNetworkV6, SocketType.Stream, ProtocolType.Tcp) { DualMode = false };

        try
        {
            socket.Bind(new IPEndPoint(IPAddress.IPv6Loopback, port));
            socket.Listen();

            return socket;
        }
        catch
        {
            socket.Dispose();

            throw;
        }
    }

    // ! the keep-alive the platform armed on a socket it accepted, read by the private names of
    // .NET 10's ManagedWebSocket, which shows it nowhere else: the delay of its ping and how long its
    // pong is waited, in milliseconds, or none when it armed no timer
    private static (int DelayMs, int TimeoutMs)? KeepAliveOf(WebSocket socket)
    {
        const BindingFlags Fields = BindingFlags.NonPublic | BindingFlags.Instance;
        const BindingFlags Properties = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
        var type = socket.GetType();

        if (type.GetField("_keepAliveTimer", Fields)!.GetValue(socket) is null)
        {
            return null;
        }

        var state = type.GetField("_keepAlivePingState", Fields)!.GetValue(socket)!;
        var stateType = state.GetType();

        return ((int)stateType.GetProperty("DelayMs", Properties)!.GetValue(state)!, (int)stateType.GetProperty("TimeoutMs", Properties)!.GetValue(state)!);
    }

    // a server whose every socket accepted is written to the channel given, as it was accepted
    private static WebSocketTransportServer Keeping(Channel<WebSocket> accepted, WebSocketTransportServerOptions? options = null)
    {
        return new WebSocketTransportServer(options)
        {
            Accepted = (socket, connectionHandle) =>
            {
                accepted.Writer.TryWrite(socket);

                return (socket, connectionHandle);
            },
        };
    }

    // the counts of a server's gauges, each by its name, in order
    private static string CountsOf(WebSocketTransportServer server)
    {
        return string.Join("; ", server.Gauges().Counts.OrderBy((count) =>
        {
            return count.Key;
        }, StringComparer.Ordinal).Select((count) =>
        {
            return $"{count.Key}={count.Value}";
        }));
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
    public async Task Carries_no_credential_toward_a_connection_and_is_secure_on_a_loopback_host_it_listens_on_or_as_its_transport_says()
    {
        await using var unstarted = new WebSocketTransportServer();

        // bound to the loopback, it never leaves the machine; nothing bound, nothing is
        Assert.Equal((false, true), (_server.CarriesCredential("any"), _server.IsSecure("any")));
        Assert.Equal((false, false), (unstarted.CarriesCredential("any"), unstarted.IsSecure("any")));
    }

    [Fact]
    public async Task Is_secure_as_its_application_says_what_stands_in_front_of_it_whatever_it_listens_on_and_by_what_it_listens_on_when_it_says_nothing()
    {
        // whether one bound to the loopback is secure, and one bound to nothing, which no listener
        // makes secure
        async Task<(bool Bound, bool Unbound)> SecuredBy(bool? secure)
        {
            await using var bound = new WebSocketTransportServer(new WebSocketTransportServerOptions { Secure = secure });
            await using var unbound = new WebSocketTransportServer(new WebSocketTransportServerOptions { Secure = secure });

            await bound.Start(Loopback, Cancelled);

            return (bound.IsSecure("any"), unbound.IsSecure("any"));
        }

        // nothing said, by its listener; TLS terminated before it, on another host; a proxy on the
        // machine that serves the network in the clear
        Assert.Equal((true, false), await SecuredBy(null));
        Assert.Equal((true, true), await SecuredBy(true));
        Assert.Equal((false, false), await SecuredBy(false));
    }

    [Fact]
    public async Task Tells_each_refusal_it_judges_of_its_own_its_status_its_reason_the_request_s_authority_and_origin_and_the_client_s_address_and_port_and_nothing_of_HTTP_s_own_at_its_address()
    {
        await Start(new WebSocketTransportServerOptions());

        var own = $"127.0.0.1:{_port}";
        var upgrade = $"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {Key}\r\n";

        // a host not taken, its Origin in two field lines joined by ", "; an absolute-form target's
        // authority over its Host; an empty Host; HTTP/1.0 naming none; a method, an upgrade, a
        // version, a form and an origin refused
        var refused = new[]
        {
            await RefusalOf($"GET / HTTP/1.1\r\nHost: rebind.example:8080\r\nOrigin: http://a.example\r\nOrigin: http://b.example\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n"),
            await RefusalOf($"GET http://rebind.example/ HTTP/1.1\r\nHost: {own}\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n"),
            await RefusalOf($"GET / HTTP/1.1\r\nHost: \r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n"),
            await RefusalOf("GET / HTTP/1.0\r\n\r\n"),
            await RefusalOf($"PUT / HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            await RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\n\r\n"),
            await RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\n{upgrade}Sec-WebSocket-Version: 8\r\n\r\n"),
            await RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n"),
            await RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\nOrigin: http://elsewhere.example\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n"),
        };

        // what HTTP refuses of its own, unmarked: an authority that is no host, two Host lines
        Assert.Equal((400, null), ((await RefusalOf($"GET / HTTP/1.1\r\nHost: localhost:\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n")).Status, (await RefusalOf("GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n")).Reason));

        // and, its stop under way, an upgrade it would take: 503, busy
        var (client, _) = await Connect();
        (int Status, string? Reason, int Port)? busy = null;

        _server.Close += (_, _) =>
        {
            busy ??= RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n").GetAwaiter().GetResult();
        };

        using (client)
        {
            var answering = AnswerClose(client);

            await Task.Run(_server.Stop, Cancelled).WaitAsync(Patience, Cancelled);
            await answering.WaitAsync(Patience, Cancelled);
        }

        Assert.Equal((503, WebSocketRefusals.Busy), (busy!.Value.Status, busy.Value.Reason));
        await Until(() =>
        {
            return _refusals.Count == refused.Length + 1;
        });

        Assert.Equal(
            [
                new("127.0.0.1", "rebind.example:8080", "http://a.example, http://b.example", refused[0].Port, WebSocketRefusals.Host, 403),
                new("127.0.0.1", "rebind.example", null, refused[1].Port, WebSocketRefusals.Host, 403),
                new("127.0.0.1", "", null, refused[2].Port, WebSocketRefusals.Host, 403),
                new("127.0.0.1", null, null, refused[3].Port, WebSocketRefusals.Host, 403),
                new("127.0.0.1", own, null, refused[4].Port, WebSocketRefusals.Method, 405),
                new("127.0.0.1", own, null, refused[5].Port, WebSocketRefusals.Upgrade, 426),
                new("127.0.0.1", own, null, refused[6].Port, WebSocketRefusals.Version, 426),
                new("127.0.0.1", own, null, refused[7].Port, WebSocketRefusals.Malformed, 400),
                new("127.0.0.1", own, "http://elsewhere.example", refused[8].Port, WebSocketRefusals.Origin, 403),
                new TransportServerRefusal("127.0.0.1", own, null, busy.Value.Port, WebSocketRefusals.Busy, 503),
            ],
            _refusals);
    }

    [Fact]
    public async Task Answers_400_unmarked_with_none_of_the_path_s_fields_a_field_holding_a_control_character_other_than_HTAB_or_an_octet_past_ASCII_and_tells_nothing()
    {
        await Start(new WebSocketTransportServerOptions());

        var own = $"127.0.0.1:{_port}";
        var answers = new List<(string Field, (int, string?, string) Answer)>();

        // each an upgrade but for one field: the octets as given, each character one octet, or, for
        // the UTF-8 one, its two; its status, its mark, and the fields of the path it carries
        foreach (var field in new[]
        {
            "Origin: http://a.example\u001b[2J",
            "X-Other: a\u0007b",
            "Origin: http://a.example\u007f",
            "Origin: http://caf\u00e9.example",
            "X-Other: caf\u00e9",
            $"X-Other: {Encoding.Latin1.GetString(Encoding.UTF8.GetBytes("caf\u00e9"))}",
        })
        {
            var (status, fields, _) = await AnswerOf(Encoding.Latin1.GetBytes($"GET / HTTP/1.1\r\nHost: {own}\r\n{field}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {Key}\r\nSec-WebSocket-Version: 13\r\n\r\n"));
            var stamped = string.Join(" ", PathFields.Where(fields.ContainsKey));

            answers.Add((field, (status, fields.GetValueOrDefault("bead-refusal"), stamped)));
        }

        Assert.All(answers, (answer) =>
        {
            Assert.Equal((answer.Field, (400, (string?)null, "")), answer);
        });

        // a tab is taken: the origin is refused as it is, and told
        var (tabbed, tabbedReason, _) = await RefusalOf($"GET / HTTP/1.1\r\nHost: {own}\r\nOrigin: http://a.example\tb\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {Key}\r\nSec-WebSocket-Version: 13\r\n\r\n");

        Assert.Equal((403, WebSocketRefusals.Origin), (tabbed, tabbedReason));
        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });
        Assert.Equal(["http://a.example\tb"], _refusals.Select((refusal) =>
        {
            return refusal.Origin;
        }));
    }

    [Fact]
    public async Task Refuses_as_it_would_though_a_refusal_listener_throws_the_throw_reported_with_no_connection()
    {
        await Start(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        var thrown = new InvalidOperationException("a refusal listener that throws");
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Refusal += (_) =>
        {
            throw thrown;
        };
        _server.Error += (reason, connectionHandle) =>
        {
            errors.Enqueue((reason, connectionHandle));
        };
        var after = new ConcurrentQueue<TransportServerRefusal>();
        _server.Refusal += after.Enqueue;

        Assert.Equal(403, (await AnswerOf(("rebind.example", null))).Status);
        await Until(() =>
        {
            return !errors.IsEmpty;
        });

        // the listener before it told, the throw reported with the empty handle, and the next
        // upgrade taken as ever
        Assert.Equal([WebSocketRefusals.Host], _refusals.Select((refusal) =>
        {
            return refusal.Reason;
        }));
        Assert.Equal([(thrown, "")], errors);
        var method = await AnswerOf(HandshakeOf("POST / HTTP/1.1"));
        Assert.Equal((405, WebSocketRefusals.Method), (method.Status, method.Fields["bead-refusal"]));
        await Until(() => { return errors.Count == 2 && after.Count == 2; });
        Assert.Equal([WebSocketRefusals.Host, WebSocketRefusals.Method], after.Select((refusal) => { return refusal.Reason; }));
        Assert.Equal([(thrown, ""), (thrown, "")], errors);

        var (client, _) = await Connect();

        client.Dispose();
    }

    [Fact]
    public async Task Listens_on_localhost_when_given_no_address_both_loopbacks_on_one_port_reached_by_127_0_0_1_by_the_IPv6_loopback_and_by_localhost_reports_localhost_and_is_secure_there()
    {
        await using var server = new WebSocketTransportServer();
        var bound = await server.Start(new WebSocketTransportStartOptions { FindOpenPort = true }, Cancelled);
        var hasIPv6 = Addresses.HasIPv6Loopback();
        string[] hosts = hasIPv6 ? ["127.0.0.1", "::1", "localhost"] : ["127.0.0.1", "localhost"];

        // where the IPv6 loopback is absent, the IPv4 one alone, reported as it is
        Assert.Equal(hasIPv6 ? "localhost" : "127.0.0.1", bound.Address);
        Assert.True(server.IsSecure("any"));

        foreach (var host in hosts)
        {
            await using var client = new WebSocketTransportClient();

            await client.Connect(new WebSocketConnectOptions { Host = host, Port = bound.Port }, Cancelled).WaitAsync(Patience, Cancelled);
            Assert.Equal((host, ReadyState.Open), (host, client.ReadyState));
        }
    }

    [Fact]
    public async Task Refuses_to_start_on_localhost_when_another_socket_holds_the_other_loopback_s_port_ending_closed()
    {
        if (!Addresses.HasIPv6Loopback())
        {
            return;
        }

        // * the capture itself: another process on [::1] would answer a client that reaches the
        // server by localhost over IPv6
        using var other = HeldOnIPv6(0);
        var port = ((IPEndPoint)other.LocalEndPoint!).Port;
        await using var server = new WebSocketTransportServer();

        await Assert.ThrowsAnyAsync<IOException>(() =>
        {
            return server.Start(new WebSocketTransportStartOptions { Port = port }, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, server.ReadyState);

        // nothing kept the IPv4 loopback's port
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

        probe.Bind(new IPEndPoint(IPAddress.Loopback, port));
    }

    [Fact]
    public async Task Draws_a_port_on_localhost_again_when_the_IPv6_loopback_holds_the_one_drawn_on_IPv4()
    {
        if (!Addresses.HasIPv6Loopback())
        {
            return;
        }

        using var other = HeldOnIPv6(0);
        var held = ((IPEndPoint)other.LocalEndPoint!).Port;
        var drawn = new List<int>();
        var built = new List<WebApplication>();
        await using var server = new WebSocketTransportServer()
        {
            // the first port drawn free on IPv4, held on IPv6: drawn again
            Loopback = new LoopbackBinding
            {
                DrawPort = () =>
                {
                    drawn.Add(drawn.Count == 0 ? held : Loopbacks.DrawPort());

                    return drawn[^1];
                },
            },
        };

        server.Built += built.Add;

        var bound = await server.Start(new WebSocketTransportStartOptions { FindOpenPort = true }, Cancelled);

        Assert.Equal(("localhost", 2), (bound.Address, drawn.Count));
        Assert.Equal((held, drawn[1]), (drawn[0], bound.Port));
        Assert.Equal(2, built.Count);
        Assert.Throws<ObjectDisposedException>(() =>
        {
            return built[0].Services.GetService(typeof(IServer));
        });
        Assert.NotNull(built[1].Services.GetService(typeof(IServer)));

        // the abandoned listener releases IPv4 while the other process holds IPv6
        using (var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
        {
            probe.Bind(new IPEndPoint(IPAddress.Loopback, held));
        }
        await server.Stop().WaitAsync(Patience, Cancelled);
        Assert.All(built, (application) =>
        {
            Assert.Throws<ObjectDisposedException>(() =>
            {
                return application.Services.GetService(typeof(IServer));
            });
        });
        using (var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
        {
            probe.Bind(new IPEndPoint(IPAddress.Loopback, bound.Port));
        }
        using (var free = HeldOnIPv6(bound.Port))
        {
            Assert.Equal(bound.Port, ((IPEndPoint)free.LocalEndPoint!).Port);
        }

        // eight draws at most, then the last error; a supplied port is never drawn again
        foreach (var findOpenPort in new[] { true, false })
        {
            var draws = 0;
            var abandoned = new List<WebApplication>();
            await using var refused = new WebSocketTransportServer
            {
                Loopback = new LoopbackBinding
                {
                    DrawPort = () =>
                    {
                        draws += 1;

                        return held;
                    },
                },
            };

            refused.Built += abandoned.Add;

            var failure = await Assert.ThrowsAnyAsync<IOException>(() =>
            {
                return refused.Start(new WebSocketTransportStartOptions { FindOpenPort = findOpenPort, Port = held }, Cancelled);
            });

            Assert.True(Loopbacks.IsInUse(failure));
            Assert.Equal(ReadyState.Closed, refused.ReadyState);
            Assert.Equal(findOpenPort ? 8 : 0, draws);
            Assert.Equal(findOpenPort ? 8 : 1, abandoned.Count);
            Assert.All(abandoned, (application) =>
            {
                Assert.Throws<ObjectDisposedException>(() =>
                {
                    return application.Services.GetService(typeof(IServer));
                });
            });
            using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

            probe.Bind(new IPEndPoint(IPAddress.Loopback, held));
        }
    }

    [Fact]
    public async Task Listens_on_127_0_0_1_alone_where_the_IPv6_loopback_is_absent_and_reports_127_0_0_1()
    {
        foreach (var refusal in new[] { SocketError.AddressNotAvailable, SocketError.AddressFamilyNotSupported })
        {
            // its bind refused for want of the address, as in a container with IPv6 off
            await using var server = new WebSocketTransportServer()
            {
                Loopback = new LoopbackBinding
                {
                    IPv6Refusal = (_) =>
                    {
                        return new SocketException((int)refusal);
                    },
                },
            };
            var bound = await server.Start(new WebSocketTransportStartOptions { FindOpenPort = true }, Cancelled);
            string[] hosts = ["127.0.0.1"];

            Assert.Equal("127.0.0.1", bound.Address);
            Assert.True(server.IsSecure("any"));

            foreach (var host in hosts)
            {
                await using var client = new WebSocketTransportClient();

                await client.Connect(new WebSocketConnectOptions { Host = host, Port = bound.Port }, Cancelled).WaitAsync(Patience, Cancelled);
                Assert.Equal((host, ReadyState.Open), (host, client.ReadyState));
            }

            // the IPv6 loopback's port is left alone
            if (Addresses.HasIPv6Loopback())
            {
                using var free = HeldOnIPv6(bound.Port);
            }
        }
    }

    [Fact]
    public async Task Refuses_to_start_on_an_address_that_is_no_bare_IP_address_ending_closed()
    {
        foreach (var address in Addresses.NotListening)
        {
            await using var server = new WebSocketTransportServer();
            var refused = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return server.Start(new WebSocketTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled);
            });

            Assert.Equal((address, nameof(WebSocketTransportStartOptions.Address), ReadyState.Closed), (address, refused.ParamName, server.ReadyState));
            Assert.StartsWith($"a server listens on an IP address, or on localhost, both loopbacks, not \"{address}\"", refused.Message, StringComparison.Ordinal);
        }

        // localhost, both loopbacks, or the IPv4 one alone where the IPv6 one is absent
        foreach (var address in Addresses.NamedListening)
        {
            await using var server = new WebSocketTransportServer();

            Assert.Equal(Addresses.HasIPv6Loopback() ? address : "127.0.0.1", (await server.Start(new WebSocketTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled)).Address);
            await server.Stop();
        }

        foreach (var address in Addresses.Listening.Where((address) =>
        {
            return Socket.OSSupportsIPv6 || !address.Contains(':', StringComparison.Ordinal);
        }))
        {
            await using var server = new WebSocketTransportServer();

            Assert.Equal(address, (await server.Start(new WebSocketTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled)).Address);
            await server.Stop();
        }
    }

    [Fact]
    public async Task Is_secure_on_the_IPv6_loopback_or_an_address_in_127_0_0_0_8_and_not_on_a_wildcard()
    {
        var addresses = OnTheLoopbackOrNot.Where((address) =>
        {
            return Socket.OSSupportsIPv6 || !address.Contains(':', StringComparison.Ordinal);
        });
        var secured = new List<(string Address, bool IsSecure)>();

        foreach (var address in addresses)
        {
            await using var server = new WebSocketTransportServer();

            await server.Start(new WebSocketTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled);
            secured.Add((address, server.IsSecure("any")));
            await server.Stop();
        }

        Assert.Equal(
            addresses.Select((address) =>
            {
                return (address, address is "::1" or "127.0.0.1" or "127.0.0.2");
            }),
            secured);
    }

    [Fact]
    public async Task Refuses_an_upgrade_403_before_its_handshake_marked_host_refused_for_a_host_it_does_not_take_and_origin_refused_for_an_origin_neither_its_own_nor_among_those_it_takes_its_body_empty_its_date_written_whatever_its_method_its_upgrade_or_its_form()
    {
        await StartDated(new WebSocketTransportServerOptions { Hosts = ["bead.test"], Origins = ["https://bead.example"] });

        // a host not taken, whatever else the request holds: a page that rebinds its name reaches
        // the address with any method and no upgrade
        await AssertAnswered(
            [
                UpgradeRequest(("elsewhere.test", null)),
                UpgradeRequest(("elsewhere.test", "http://elsewhere.test")),
                HandshakeOf("POST / HTTP/1.1", "Host: elsewhere.test"),
                HandshakeOf("GET / HTTP/1.1", "Host: elsewhere.test", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"),
                HandshakeOf("POST / HTTP/1.1", "Host: elsewhere.test", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Content-Length: 0"),
                HandshakeOf("PUT /bead HTTP/1.1", "Host: elsewhere.test", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Content-Length: 0"),
                HandshakeOf("HEAD / HTTP/1.1", "Host: elsewhere.test"),
                HandshakeOf("GET / HTTP/1.1", "Host: elsewhere.test", "Sec-WebSocket-Key: dGVzdA=="),
                HandshakeOf("GET / HTTP/1.1", "Host: elsewhere.test", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Host: elsewhere.test", "Sec-WebSocket-Version: 14"),
                HandshakeOf("GET / HTTP/1.1", "Host: "),
            ],
            (403, RefusedWith(WebSocketRefusals.Host)));

        // a host taken, from an origin neither its own nor among those it takes
        await AssertAnswered(
            [UpgradeRequest(("bead.test", "https://elsewhere.test")), UpgradeRequest(("bead.test", "http://elsewhere.test:80"))],
            (403, RefusedWith(WebSocketRefusals.Origin)));
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Takes_an_upgrade_with_no_Origin_from_its_own_origin_and_from_one_among_those_it_takes()
    {
        await Start(new WebSocketTransportServerOptions { Origins = ["https://bead.example"] });

        foreach (var origin in new[] { null, $"http://127.0.0.1:{_port}", $"https://127.0.0.1:{_port}", "https://bead.example" })
        {
            using var client = new ClientWebSocket();

            if (origin is not null)
            {
                client.Options.SetRequestHeader("Origin", origin);
            }

            await client.ConnectAsync(UriOf(_port), Cancelled);

            Assert.Equal(WebSocketState.Open, client.State);
            Assert.StartsWith("type=WS;", await Next(_connections), StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Reads_the_Host_of_an_upgrade_as_it_came_an_IDN_page_s_own_in_punycode_and_one_of_invalid_punycode_taken_or_refused_host_refused_never_a_500()
    {
        // an upgrade taken: its 101, then its connection
        async Task Upgraded((string Host, string? Origin) from)
        {
            using var tcp = await OpenTcp();
            var stream = tcp.GetStream();

            await stream.WriteAsync(UpgradeRequest(from), Cancelled);
            await ReadHead(stream);

            Assert.StartsWith("type=WS;", await Next(_connections), StringComparison.Ordinal);
        }

        // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
        // and a Host of punycode that decodes to none, taken where every host is; under *, no page is
        // the server's own by a host * alone takes (spec 15.12)
        var page = ("xn--bad-bma.test:8080", "http://xn--bad-bma.test:8080");

        await Start(new WebSocketTransportServerOptions { Hosts = ["*"] });

        var notOwn = new[] { await AnswerOf(page), await AnswerOf(("xn--a", "http://xn--a")) };

        Assert.Equal([(403, "origin-refused"), (403, "origin-refused")], notOwn.Select((refusal) =>
        {
            return (refusal.Status, refusal.Fields["bead-refusal"]);
        }));

        foreach (var from in new (string Host, string? Origin)[] { ("xn--a", null), ("xn--a.test", null), ("xn---bad-cpa.test", null) })
        {
            await Upgraded(from);
        }

        // hosts name an IDN host as the field carries it, in punycode
        await Start(new WebSocketTransportServerOptions { Hosts = ["xn--bad-bma.test"] });
        await Upgraded(page);
        await Upgraded(("XN--BAD-BMA.test:8080", null));

        var refusals = new[] { await AnswerOf(("xn--a.test", null)), await AnswerOf(("xn---bad-cpa.test", null)) };

        Assert.Equal([(403, "host-refused"), (403, "host-refused")], refusals.Select((refusal) =>
        {
            return (refusal.Status, refusal.Fields["bead-refusal"]);
        }));
    }

    // spec 15.12
    [Fact]
    public void Refuses_as_it_is_built_a_hosts_entry_with_a_port_and_an_origins_entry_that_is_a_star_or_null()
    {
        var port = Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["bead.test", "bead.test:8080"] });
        });
        var star = Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { Origins = ["*"] });
        });
        var opaque = Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["*"], Origins = ["https://bead.test", "null"] });
        });

        Assert.Equal(("Hosts", "Origins", "Origins"), (port.ParamName, star.ParamName, opaque.ParamName));
        Assert.Throws<ArgumentException>(() => { return new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["bead.test:8080"] }); });
        Assert.Throws<ArgumentException>(() => { return new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["bead.test", "*"] }); });
        Assert.Throws<ArgumentException>(() => { return new WebSocketTransportServer(new WebSocketTransportServerOptions { Origins = ["https://bead.test/"] }); });
        Assert.Throws<ArgumentException>(() => { return new WebSocketTransportServer(new WebSocketTransportServerOptions { Origins = ["null"] }); });
        Assert.Contains("\"bead.test:8080\"", port.Message, StringComparison.Ordinal);
        Assert.Contains("no wildcard of origins", star.Message, StringComparison.Ordinal);
        Assert.Contains("a sandboxed frame of any site", opaque.Message, StringComparison.Ordinal);
        Assert.Null(Record.Exception(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["*"], Origins = ["https://bead.test"] });
        }));
    }

    // spec 15.12
    [Fact]
    public void Refuses_as_it_is_built_a_trustedProxies_entry_that_is_a_name_or_a_network_of_prefix_0_or_an_unnamedProxies_past_8()
    {
        var name = Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { TrustedProxies = ["127.0.0.1", "proxy.internal"] });
        });

        Assert.Equal("TrustedProxies", name.ParamName);
        Assert.Contains("\"proxy.internal\"", name.Message, StringComparison.Ordinal);

        foreach (var entry in new[] { "0.0.0.0/0", "::/0" })
        {
            var everyone = Assert.Throws<ArgumentException>(() =>
            {
                return new WebSocketTransportServer(new WebSocketTransportServerOptions { TrustedProxies = [entry] });
            });

            Assert.Equal("TrustedProxies", everyone.ParamName);
            Assert.Contains("would trust what every client writes", everyone.Message, StringComparison.Ordinal);
        }

        Assert.Null(Record.Exception(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { TrustedProxies = ["127.0.0.1", "10.0.0.0/8", "::1", "fd00::/8"] });
        }));

        // the proxies it counts, those the list does not name, 8 at most
        foreach (var count in new[] { 9, -1 })
        {
            Assert.Equal("UnnamedProxies", Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new WebSocketTransportServer(new WebSocketTransportServerOptions { UnnamedProxies = count });
            }).ParamName);
        }

        Assert.Null(Record.Exception(() =>
        {
            return new WebSocketTransportServer(new WebSocketTransportServerOptions { TrustedProxies = ["10.0.0.0/8"], UnnamedProxies = 8 });
        }));
    }

    [Fact]
    public async Task Refuses_a_method_but_GET_or_HEAD_405_after_its_host_and_before_its_upgrade_is_read_its_Allow_naming_GET_and_HEAD_marked_method_refused()
    {
        await StartDated(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        // a handshake under another method, one of version 8 among them, or none at all; a CONNECT,
        // whose Host Kestrel holds to its target
        await AssertAnswered(
            [
                HandshakeOf("POST / HTTP/1.1"),
                HandshakeOf("PUT / HTTP/1.1"),
                HandshakeOf("OPTIONS / HTTP/1.1"),
                HandshakeOf("POST / HTTP/1.1", "Sec-WebSocket-Version: 8"),
                HandshakeOf("DELETE / HTTP/1.1", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"),
                HandshakeOf("POST / HTTP/1.1", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Content-Length: 0"),
                HandshakeOf("CONNECT bead.test:80 HTTP/1.1", "Host: bead.test:80"),
            ],
            (405, RefusedWith(WebSocketRefusals.Method, ("allow", "GET, HEAD"))));
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Answers_a_request_that_asks_no_WebSocket_426_marked_upgrade_required_its_Upgrade_naming_websocket_its_Connection_upgrade_and_close()
    {
        await StartDated(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        // no upgrade at all; an Upgrade missing or naming no websocket; a Connection missing or
        // naming no upgrade; a HEAD, which cannot switch, its body none and its length 0; an
        // HTTP/1.0 request, whose Upgrade is ignored
        await AssertAnswered(
            [
                HandshakeOf("GET / HTTP/1.1", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"),
                HandshakeOf("GET / HTTP/1.1", "Upgrade: h2c"),
                HandshakeOf("GET / HTTP/1.1", "Upgrade"),
                HandshakeOf("GET / HTTP/1.1", "Upgrade: websocket/13"),
                HandshakeOf("GET / HTTP/1.1", "Connection"),
                HandshakeOf("GET / HTTP/1.1", "Connection: keep-alive"),
                HandshakeOf("GET / HTTP/1.1", "Connection: upgraded"),
                HandshakeOf("GET / HTTP/1.1", "Upgrade: h2c", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Upgrade", "Sec-WebSocket-Version: 8"),
                HandshakeOf("HEAD / HTTP/1.1"),
                HandshakeOf("HEAD / HTTP/1.1", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"),
                HandshakeOf("GET / HTTP/1.0"),
                HandshakeOf("GET / HTTP/1.0", "Upgrade: websocket, h2c"),
                HandshakeOf("GET / HTTP/1.0", "Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version"),
            ],
            (426, RefusedWith(WebSocketRefusals.Upgrade, ("connection", "upgrade, close"), ("upgrade", "websocket"))));
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Refuses_a_malformed_upgrade_400_marked_malformed_before_its_origin_is_judged_its_body_empty()
    {
        await StartDated(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        // a key missing, not base64, of 4 or 17 bytes, twice, empty, or with a space inside; two
        // versions; subprotocols that are no list of tokens, or none; content, by its length or in
        // chunks; a bad key from an origin not taken; two Authorization lines, which are no list to
        // combine, from no page or from an origin not taken
        await AssertAnswered(
            [
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: not a key at all!!!!!=="),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: dGVzdA=="),
                HandshakeOf("GET / HTTP/1.1", $"Sec-WebSocket-Key: {Convert.ToBase64String(new byte[17])}"),
                HandshakeOf("GET / HTTP/1.1", $"Sec-WebSocket-Key: {Key}", $"Sec-WebSocket-Key: {Key}"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: "),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: dGhlIHNhbXBs ZSBub25jZQ=="),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Version: 13"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Protocol: a b"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Protocol: "),
                [.. HandshakeOf("GET / HTTP/1.1", "Content-Length: 5"), .. "hello"u8],
                [.. HandshakeOf("GET / HTTP/1.1", "Transfer-Encoding: chunked"), .. "5\r\nhello\r\n0\r\n\r\n"u8],
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: dGVzdA==", "Origin: https://elsewhere.test"),
                HandshakeOf("GET / HTTP/1.1", $"Authorization: {Bearer}", $"Authorization: {Bearer}"),
                HandshakeOf("GET / HTTP/1.1", $"Authorization: {Bearer}", $"Authorization: {Bearer}", "Origin: https://elsewhere.test"),
            ],
            (400, RefusedWith(WebSocketRefusals.Malformed)));
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Answers_426_to_an_upgrade_of_a_version_but_13_or_of_none_marked_version_refused_naming_version_13_and_websocket_before_its_key_and_its_origin_are_judged()
    {
        await StartDated(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        // version 8, which RFC 6455 left behind and no browser sends, from an origin not taken, with
        // its own origin's field, or with a bad key; any other, none, or a list in one field line
        await AssertAnswered(
            [
                HandshakeOf("GET / HTTP/1.1", "Origin: https://elsewhere.test", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Origin: http://bead.test", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: dGVzdA==", "Sec-WebSocket-Version: 8"),
                HandshakeOf("GET / HTTP/1.1", "Origin: https://elsewhere.test", "Sec-WebSocket-Version: 7"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version: 013"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version: 13, 8"),
                HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Version: 8, 13"),
            ],
            (426, RefusedWith(WebSocketRefusals.Version, ("connection", "upgrade, close"), ("upgrade", "websocket"), ("sec-websocket-version", "13"))));
        Assert.True(_connections.Reader.Count == 0);

        // version 13, from the server's own origin, upgrades
        using var tcp = await OpenTcp();
        var stream = tcp.GetStream();

        await stream.WriteAsync(UpgradeRequest(("bead.test", "http://bead.test")), Cancelled);
        await ReadHead(stream);

        Assert.StartsWith("type=WS;", await Next(_connections), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Answers_a_request_without_a_Host_with_two_or_with_one_that_is_no_host_400_as_HTTP_does_unmarked()
    {
        var requests = new[]
        {
            HandshakeOf("GET / HTTP/1.1", "Host"),
            HandshakeOf("GET / HTTP/1.1", "Host: bead.test", "Host: elsewhere.test"),
            HandshakeOf("GET / HTTP/1.1", "Host: elsewhere.test", "Host: bead.test"),
            HandshakeOf("GET / HTTP/1.1", "Host: bad host"),
        };

        // its head is the HTTP server's own, whether the server takes every host or names some
        foreach (var hosts in new[] { null, new[] { "bead.test" } })
        {
            await Start(new WebSocketTransportServerOptions { Hosts = hosts });

            foreach (var request in requests)
            {
                var answer = await AnswerOf(request);

                Assert.Equal((400, false, ""), (answer.Status, answer.Fields.ContainsKey("bead-refusal"), answer.Body));
            }
        }

        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Takes_whatever_its_hosts_the_hosts_every_server_takes_and_any_page_of_its_own_and_refuses_403_any_other_host_an_empty_one_and_none_before_its_method_and_its_upgrade()
    {
        // the targets in absolute-form of the judgement's twin, on the wire: Kestrel answers 400 a
        // scheme not in lower case before the judgement runs, as it answers any other target it does
        // not read (docs/support.md, "Leveled down")
        foreach (var hosts in new[] { null, [], new[] { "bead.test" } })
        {
            await Start(new WebSocketTransportServerOptions { Hosts = hosts });

            // a target in absolute-form names the authority, its Host ignored but for being one
            foreach (var taken in new[]
            {
                HandshakeOf("GET http://127.0.0.1:8080/ HTTP/1.1", "Origin: http://127.0.0.1:8080"),
                HandshakeOf("GET http://localhost/ HTTP/1.1", "Host: bad host"),
            })
            {
                using var tcp = await OpenTcp();
                var stream = tcp.GetStream();

                await stream.WriteAsync(taken, Cancelled);
                await ReadHead(stream);
            }

            var refused = await AnswerOf(HandshakeOf("GET http://rebind.example/ HTTP/1.1", "Host: 127.0.0.1"));

            Assert.Equal((403, WebSocketRefusals.Host), (refused.Status, refused.Fields.GetValueOrDefault("bead-refusal")));

            // what HTTP refuses of its own, first, unmarked
            foreach (var target in new[] { "http://a%41.test/", "http:///", "HTTP://127.0.0.1/", "ftp://127.0.0.1/", "http://localhost:/", "http://user@localhost/" })
            {
                var answer = await AnswerOf(HandshakeOf($"GET {target} HTTP/1.1"));

                Assert.Equal((target, 400, false), (target, answer.Status, answer.Fields.ContainsKey("bead-refusal")));
            }
        }
    }

    [Fact]
    public async Task Takes_an_upgrade_whose_Upgrade_lists_websocket_in_any_case_in_one_field_line_or_several_whose_Connection_names_upgrade_among_other_tokens_with_no_content()
    {
        await Start(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        foreach (var request in new[]
        {
            HandshakeOf("GET / HTTP/1.1", "Upgrade: WebSocket"),
            HandshakeOf("GET / HTTP/1.1", "Upgrade: h2c, websocket"),
            HandshakeOf("GET / HTTP/1.1", "Upgrade: websocket, h2c"),
            HandshakeOf("GET / HTTP/1.1", "Upgrade: h2c", "Upgrade: websocket"),
            HandshakeOf("GET / HTTP/1.1", "Connection: keep-alive, upgrade"),
            HandshakeOf("GET / HTTP/1.1", "Connection: UPGRADE"),
            HandshakeOf("GET / HTTP/1.1", "Connection: keep-alive", "Connection: upgrade"),
            HandshakeOf("GET / HTTP/1.1", "Content-Length: 0"),
            HandshakeOf("GET / HTTP/1.1", "Content-Length: 00"),
            HandshakeOf("GET / HTTP/1.1", "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=="),
        })
        {
            using var tcp = await OpenTcp();
            var stream = tcp.GetStream();

            await stream.WriteAsync(request, Cancelled);
            await ReadHead(stream);

            Assert.StartsWith("type=WS;", await Next(_connections), StringComparison.Ordinal);
        }
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
            Assert.Matches(@"^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=\d+$", connectionHandle);
        }
    }

    [Fact]
    public async Task Delivers_text_as_text_and_binary_as_bytes_stamping_the_activity()
    {
        var time = new FakeTimeProvider();

        await Start(new WebSocketTransportServerOptions { Clock = time });

        var (client, _) = await Connect();

        using (client)
        {
            Assert.Null(Assert.Single(_server.Clients).LastActivity);

            time.Advance(TimeSpan.FromSeconds(1));
            await client.SendAsync("hi"u8.ToArray(), WebSocketMessageType.Text, true, Cancelled);

            var (text, _) = await Next(_messages);

            Assert.True(text.IsText);
            Assert.Equal(time.GetUtcNow(), Assert.Single(_server.Clients).LastActivity);

            // each message stamps it again
            time.Advance(TimeSpan.FromSeconds(1));
            await client.SendAsync("bytes"u8.ToArray(), WebSocketMessageType.Binary, true, Cancelled);

            var (binary, _) = await Next(_messages);

            Assert.False(binary.IsText);
            Assert.Equal("bytes"u8.ToArray(), binary.Bytes.ToArray());
            Assert.Equal(time.GetUtcNow(), Assert.Single(_server.Clients).LastActivity);
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
                return _server.Send(new TransportMessage(new[] { (byte)index }, false), connectionHandle);
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
    public async Task Closes_with_1009_a_message_past_an_envelope_s_limit_16778240_bytes_when_told_no_bound()
    {
        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // an envelope's limit is taken whole, one byte more closes
            await client.SendAsync(new byte[EnvelopeLimit], WebSocketMessageType.Binary, true, Cancelled);

            Assert.Equal(EnvelopeLimit, (await Next(_messages)).Message.Bytes.Length);

            var sending = client.SendAsync(new byte[EnvelopeLimit + 1], WebSocketMessageType.Binary, true, Cancelled);
            var (result, _) = await ReceiveOf(client);

            Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.MessageTooBig), (result.MessageType, result.CloseStatus));
            // what is left of the message goes, or fails as the socket goes: either way it is heard no more
            client.Abort();
            await Task.WhenAny(sending).WaitAsync(Patience, Cancelled);
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

    // what a close timeout holds or refuses is the durations' file's to play: infinite arms no
    // timer, and a peer that does not answer its close is waited on without end
    [Fact]
    public async Task Waits_on_its_peer_without_end_for_a_close_timeout_of_infinity_arming_no_timer()
    {
        await Start(new WebSocketTransportServerOptions { CloseTimeout = Timeout.InfiniteTimeSpan });

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            var closing = _server.CloseConnection(connectionHandle);

            await Task.Delay(TimeSpan.FromMilliseconds(50), Cancelled);
            Assert.False(closing.IsCompleted);
            Assert.Equal(WebSocketCloseStatus.NormalClosure, await AnswerClose(client));
            await closing.WaitAsync(Patience, Cancelled);
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
    public async Task Keeps_a_connection_whose_connection_listener_throws_its_messages_heard_the_throw_reported_with_it()
    {
        var server = new WebSocketTransportServer();
        var thrown = new InvalidOperationException("a connection listener that throws");
        var errors = Channel.CreateUnbounded<(Exception Reason, string ConnectionHandle)>();

        // before the tests' own listeners, which are told all the same
        server.Connection += (_) =>
        {
            throw thrown;
        };
        server.Error += (reason, connectionHandle) =>
        {
            errors.Writer.TryWrite((reason, connectionHandle));
        };
        await Start(server);

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            Assert.Equal((thrown, connectionHandle), await Next(errors));

            await client.SendAsync(new byte[] { 1 }, WebSocketMessageType.Binary, true, Cancelled);

            var (message, heardOn) = await Next(_messages);

            Assert.Equal(new byte[] { 1 }, message.Bytes.ToArray());
            Assert.Equal(connectionHandle, heardOn);
            Assert.Equal([connectionHandle], _server.ConnectionHandles);
            Assert.True(_closes.Reader.Count == 0);
            Assert.Equal(WebSocketState.Open, client.State);
        }
    }

    [Fact]
    public async Task Hears_the_next_message_after_a_message_listener_throws_the_throw_reported_with_its_connection()
    {
        var server = new WebSocketTransportServer();
        var thrown = new InvalidOperationException("a message listener that throws");
        var errors = Channel.CreateUnbounded<(Exception Reason, string ConnectionHandle)>();
        var throws = 1;

        // before the tests' own listeners, which are told all the same
        server.Message += (_, _) =>
        {
            if (Interlocked.Exchange(ref throws, 0) == 1)
            {
                throw thrown;
            }
        };
        server.Error += (reason, connectionHandle) =>
        {
            errors.Writer.TryWrite((reason, connectionHandle));
        };
        await Start(server);

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await client.SendAsync(new byte[] { 1 }, WebSocketMessageType.Binary, true, Cancelled);
            await client.SendAsync(new byte[] { 2 }, WebSocketMessageType.Binary, true, Cancelled);

            Assert.Equal(new byte[] { 1 }, (await Next(_messages)).Message.Bytes.ToArray());
            Assert.Equal(new byte[] { 2 }, (await Next(_messages)).Message.Bytes.ToArray());
            Assert.Equal((thrown, connectionHandle), await Next(errors));
            Assert.True(errors.Reader.Count == 0);
            Assert.Equal([connectionHandle], _server.ConnectionHandles);
            Assert.True(_closes.Reader.Count == 0);
        }
    }

    // spec 15.2.8
    [Fact]
    public async Task Refuses_an_upgrade_that_comes_as_it_stops_503_busy_told_when_to_come_back()
    {
        await StartDated(new WebSocketTransportServerOptions());

        var (client, connectionHandle) = await Connect();
        (int Status, Dictionary<string, string> Fields, string Body)? refused = null;

        // the stop under way, its connection's close told: an upgrade comes, Kestrel still serving
        _server.Close += (_, _) =>
        {
            refused = AnswerOf(UpgradeRequest(("127.0.0.1", null))).GetAwaiter().GetResult();
        };

        using (client)
        {
            var answering = AnswerClose(client);

            await Task.Run(_server.Stop, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, await answering.WaitAsync(Patience, Cancelled));
        }

        static string FieldsOf(Dictionary<string, string> fields)
        {
            return string.Join("; ", fields.OrderBy((field) =>
            {
                return field.Key;
            }, StringComparer.Ordinal).Select((field) =>
            {
                return $"{field.Key}: {field.Value}";
            }));
        }

        var (status, fields, body) = refused!.Value;

        // marked, never stored nor sniffed, its connection closed, and told when to come back
        Assert.Equal(
            (503, FieldsOf(RefusedWith(WebSocketRefusals.Busy, ("retry-after", "1"))), ""),
            (status, FieldsOf(fields), body));
        Assert.Equal((false, connectionHandle), await Next(_closes));
        Assert.True(_connections.Reader.Count == 0);
    }

    [Fact]
    public async Task Closes_going_away_a_connection_whose_accept_a_stop_crossed()
    {
        WebSocketTransportServer server = null!;

        server = new WebSocketTransportServer
        {
            Accepted = (socket, peerHandle) =>
            {
                // the stop begins as the accept registers: the connection is closed with its own
                _ = server.Stop();

                return (socket, peerHandle);
            },
        };

        await Start(server);

        using var client = new ClientWebSocket();

        await client.ConnectAsync(UriOf(_port), Cancelled);

        var connectionHandle = await Next(_connections);

        Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, await AnswerClose(client));
        Assert.Equal((false, connectionHandle), await Next(_closes));
        await server.Stop().WaitAsync(Patience, Cancelled);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Empty(_server.Clients);
        Assert.True(_closes.Reader.Count == 0);
        Assert.Equal(ReadyState.Closed, _server.ReadyState);

        // a second accept registers after the stop's snapshot, while a silent peer's close holds it
        using var releaseAccept = new ManualResetEventSlim();
        using var releaseStop = new ManualResetEventSlim();
        var accepted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var snapshotClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrivals = 0;
        var crossing = new WebSocketTransportServer(new WebSocketTransportServerOptions { CloseTimeout = TimeSpan.FromMilliseconds(50) })
        {
            Accepted = (socket, peerHandle) =>
            {
                if (Interlocked.Increment(ref arrivals) == 2)
                {
                    accepted.TrySetResult();
                    Assert.True(releaseAccept.Wait(Patience, Cancelled));
                }

                return (socket, peerHandle);
            },
        };

        await Start(crossing);

        var (silent, silentHandle) = await Connect();

        using (silent)
        using (var late = new ClientWebSocket())
        {
            crossing.Close += (_, connection) =>
            {
                if (connection == silentHandle)
                {
                    snapshotClosed.TrySetResult();
                    Assert.True(releaseStop.Wait(Patience, Cancelled));
                }
            };

            var connecting = late.ConnectAsync(UriOf(_port), Cancelled);

            try
            {
                await accepted.Task.WaitAsync(Patience, Cancelled);

                var stopping = crossing.Stop();
                var (close, _) = await ReceiveOf(silent);

                Assert.Equal((WebSocketMessageType.Close, WebSocketCloseStatus.EndpointUnavailable), (close.MessageType, close.CloseStatus));
                await snapshotClosed.Task.WaitAsync(Patience, Cancelled);
                Assert.Equal((false, silentHandle), await Next(_closes));
                Assert.False(stopping.IsCompleted);
                Assert.Equal(ReadyState.Closing, crossing.ReadyState);
                releaseAccept.Set();
                await connecting.WaitAsync(Patience, Cancelled);

                var lateHandle = await Next(_connections);

                Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, await AnswerClose(late));
                Assert.Equal((false, lateHandle), await Next(_closes));
                releaseStop.Set();
                await stopping.WaitAsync(Patience, Cancelled);
                Assert.Empty(crossing.ConnectionHandles);
                Assert.Empty(crossing.Clients);
                Assert.True(_closes.Reader.Count == 0);
                Assert.Equal(ReadyState.Closed, crossing.ReadyState);
            }
            finally
            {
                releaseAccept.Set();
                releaseStop.Set();
            }
        }
    }

    [Fact]
    public async Task Hands_every_envelope_of_a_connection_its_upgrade_s_Authorization_as_it_came_and_trimmed_and_carries_none_toward_its_client()
    {
        var upgrades = Channel.CreateUnbounded<Microsoft.AspNetCore.Http.HttpRequest>();
        var snapshot = new WebSocketTransportServer(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });
        snapshot.Built += (application) =>
        {
            application.Use((context, next) => { upgrades.Writer.TryWrite(context.Request); return next(context); });
        };
        await Start(snapshot);

        // its spaces and tabs around it removed, its auth-scheme kept, beside each envelope
        using (var tcp = await OpenTcp())
        {
            await tcp.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", $"Authorization:  \t{Bearer}\t "), .. TextFrame("first"), .. TextFrame("second")], Cancelled);

            var first = await Next(_messages);
            var second = await Next(_messages);

            Assert.Equal((Bearer, Bearer), (first.Message.Credential, second.Message.Credential));
            Assert.Equal((await Next(_connections), first.ConnectionHandle), (first.ConnectionHandle, second.ConnectionHandle));
            Assert.False(_server.CarriesCredential(first.ConnectionHandle));
            var request = await Next(upgrades);
            request.Headers.Authorization = "Bearer another";
            await tcp.GetStream().WriteAsync(TextFrame("after"), Cancelled);
            var after = await Next(_messages);
            Assert.Equal((Bearer, "after"), (after.Message.Credential, Encoding.ASCII.GetString(after.Message.Bytes.Span)));

            using var padded = await OpenTcp();
            await padded.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", "Authorization:  \tInterop sub=bob\t "), .. TextFrame("three")], Cancelled);
            var other = await Next(_messages);
            Assert.Equal(("Interop sub=bob", "three"), (other.Message.Credential, Encoding.ASCII.GetString(other.Message.Bytes.Span)));
            Assert.NotEqual(first.ConnectionHandle, other.ConnectionHandle);
            await Next(_connections);
        }

        // none from an upgrade that carries none, or an empty one
        foreach (var fields in new string[][] { [], ["Authorization: "] })
        {
            using var tcp = await OpenTcp();

            await tcp.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", fields), .. TextFrame("bare")], Cancelled);

            var drawn = await Next(_connections);
            var (message, from) = await Next(_messages);

            Assert.Equal((drawn, (string?)null), (from, message.Credential));
        }

        // nothing toward its client: the envelope alone goes
        var (client, connectionHandle) = await Connect();

        using (client)
        {
            await _server.Send(new TransportMessage("down"u8.ToArray(), false) { Credential = Bearer }, connectionHandle).WaitAsync(Patience, Cancelled);

            var (result, bytes) = await ReceiveOf(client);

            Assert.Equal((WebSocketMessageType.Binary, "down"), (result.MessageType, Encoding.ASCII.GetString(bytes)));
        }
    }

    [Fact]
    public async Task Names_a_connection_to_its_listeners_by_its_handle_and_nothing_of_its_credential()
    {
        await Start(new WebSocketTransportServerOptions { Hosts = ["bead.test"] });

        using var tcp = await OpenTcp();

        await tcp.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", $"Authorization: {Bearer}"), .. TextFrame("up")], Cancelled);

        // the handle alone, as its client was drawn: the credential stays beside the envelopes
        var connectionHandle = await Next(_connections);

        Assert.StartsWith("type=WS;ip=127.0.0.1;port=", connectionHandle, StringComparison.Ordinal);
        Assert.DoesNotContain("mF_9", connectionHandle, StringComparison.Ordinal);
        Assert.DoesNotContain("mF_9", string.Join(",", HandlesOf(_server.Clients)), StringComparison.Ordinal);
        Assert.Equal(Bearer, (await Next(_messages)).Message.Credential);
    }

    [Fact]
    public async Task Carries_no_credential_from_an_upgrade_that_carries_an_Origin_its_own_or_one_it_takes_whatever_its_Authorization()
    {
        await Start(new WebSocketTransportServerOptions { Hosts = ["bead.test"], Origins = ["https://bead.example"] });

        // ! a page's browser writes its own authentication on its upgrade, a page of any origin's
        foreach (var origin in new[] { "http://bead.test", "https://bead.example" })
        {
            using var tcp = await OpenTcp();

            await tcp.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", $"Origin: {origin}", $"Authorization: {Bearer}"), .. TextFrame("page")], Cancelled);

            var (message, _) = await Next(_messages);

            Assert.Equal(("page", (string?)null), (Encoding.ASCII.GetString(message.Bytes.Span), message.Credential));
        }

        // from no page, the same Authorization is carried
        using (var tcp = await OpenTcp())
        {
            await tcp.GetStream().WriteAsync((byte[])[.. HandshakeOf("GET / HTTP/1.1", $"Authorization: {Bearer}"), .. TextFrame("service")], Cancelled);
            Assert.Equal(Bearer, (await Next(_messages)).Message.Credential);
        }
    }

    [Fact]
    public async Task Resolves_a_send_for_a_handle_nobody_holds()
    {
        await _server.Send(new TransportMessage(new byte[] { 1 }, false), "type=WS;ip=127.0.0.1;port=1;ordinal=1").WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Listens_on_localhost_port_80_and_beats_every_30_seconds_when_told_nothing()
    {
        var start = new WebSocketTransportStartOptions();
        var options = new WebSocketTransportServerOptions();

        Assert.Equal(("localhost", 80, false), (start.Address, start.Port, start.FindOpenPort));
        Assert.Equal(TimeSpan.FromSeconds(30), options.Heartbeat);
        Assert.Equal(TimeSpan.FromSeconds(5), options.CloseTimeout);
        Assert.Null(options.MaximumMessageBytes);
        Assert.Equal(EnvelopeLimit, _server.MaximumMessageBytes);

        // started told nothing, on localhost, a connection it takes is pinged every 30 seconds, its
        // pong waited as long
        var accepted = Channel.CreateUnbounded<WebSocket>();
        await using var server = Keeping(accepted);
        var bound = await server.Start(new WebSocketTransportStartOptions { FindOpenPort = true }, Cancelled);
        await using var client = new WebSocketTransportClient();

        await client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = bound.Port }, Cancelled).WaitAsync(Patience, Cancelled);

        // where the IPv6 loopback is absent, the IPv4 one alone, reported as it is
        Assert.Equal(Addresses.HasIPv6Loopback() ? "localhost" : "127.0.0.1", bound.Address);
        Assert.Equal((30_000, 30_000), KeepAliveOf(await Next(accepted)));
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
        var (before, beforeHandle) = await Connect();

        before.Dispose();
        Assert.Same(Task.CompletedTask, never.Stop());
        Assert.Equal(ReadyState.Uninitialized, never.ReadyState);
        await _server.Stop().WaitAsync(Patience, Cancelled);
        Assert.Same(Task.CompletedTask, _server.Stop());
        Assert.Equal(ReadyState.Closed, _server.ReadyState);
        _port = (await _server.Start(Loopback, Cancelled)).Port;

        var (client, connectionHandle) = await Connect();

        // the connection taken after the restart ranked after every one before it: none given twice
        using (client)
        {
            Assert.Equal([connectionHandle], _server.ConnectionHandles);
            Assert.True(OrdinalOf(connectionHandle) > OrdinalOf(beforeHandle), $"{beforeHandle} then {connectionHandle}");
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
            Assert.Equal(
                new Dictionary<string, long> { ["connections"] = 10_000, ["largestAddressConnections"] = 64, ["largestUnsentBytes"] = 184_551_424 },
                gauges.Ceilings);
            Assert.Equal(new HashSet<string> { firstHandle, secondHandle }, new HashSet<string>(gauges.ConnectionHandles));
            Assert.Equal(
                new Dictionary<string, long> { ["connections"] = 2, ["largestAddressConnections"] = 2, ["largestUnsentBytes"] = 0, ["unsentBytes"] = 0 },
                gauges.Counts);
        }
    }

    [Fact]
    public async Task Resolves_false_closing_a_handle_nobody_holds()
    {
        Assert.False(await _server.CloseConnection("type=WS;ip=0.0.0.0;port=1;ordinal=1").WaitAsync(Patience, Cancelled));
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
            Assert.Equal([WebSocketCloseStatus.EndpointUnavailable, WebSocketCloseStatus.EndpointUnavailable], await answering.WaitAsync(Patience, Cancelled));
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

    // a heartbeat refused is the durations' file's to play
    [Fact]
    public async Task Pings_nothing_with_a_heartbeat_of_infinity()
    {
        foreach (var (heartbeat, keepAlive) in new (TimeSpan, (int, int)?)[] { (TimeSpan.FromMilliseconds(200), (200, 200)), (Timeout.InfiniteTimeSpan, null) })
        {
            var isPinging = keepAlive is not null;
            var accepted = Channel.CreateUnbounded<WebSocket>();

            await Start(Keeping(accepted, new WebSocketTransportServerOptions { Heartbeat = heartbeat }));

            // a peer of the tests' own, read raw, so every frame the server sends shows
            using var tcp = await OpenTcp();
            var stream = tcp.GetStream();

            await stream.WriteAsync(UpgradeRequest(), Cancelled);

            var connectionHandle = await Next(_connections);

            await ReadHead(stream);

            // the platform's own timer, armed at the heartbeat; none at all for an infinite one
            Assert.Equal((heartbeat, keepAlive), (heartbeat, KeepAliveOf(await Next(accepted))));

            var first = new byte[1];
            var reading = stream.ReadAsync(first, Cancelled).AsTask();
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
                Assert.Equal([connectionHandle], _server.ConnectionHandles);
            }
        }
    }

    [Fact]
    public async Task Refuses_a_close_timeout_past_the_longest_timer_and_runs_on_the_clock_it_is_given()
    {
        var time = new FakeTimeProvider();
        await using var given = new WebSocketTransportServer(new WebSocketTransportServerOptions { Clock = time });
        await using var none = new WebSocketTransportServer();

        Assert.Equal((time, TimeProvider.System), (given.Clock, none.Clock));

        // 2³¹ ms, one past what JavaScript's timers hold
        foreach (var closeTimeout in new[] { TimeSpan.FromMilliseconds(-2), Clocks.LongestTimer + TimeSpan.FromMilliseconds(1) })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new WebSocketTransportServer(new WebSocketTransportServerOptions { CloseTimeout = closeTimeout });
            });
        }
    }

    [Fact]
    public async Task Meets_a_connection_already_registered_and_can_send_to_it()
    {
        var seen = new TaskCompletionSource<(bool IsRegistered, Task Sent)>(TaskCreationOptions.RunContinuationsAsynchronously);

        _server.Connection += (connectionHandle) =>
        {
            seen.TrySetResult((_server.ConnectionHandles.Contains(connectionHandle), _server.Send(new TransportMessage("hi"u8.ToArray(), false), connectionHandle)));
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
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Exception? error = null;

        _server.Error += (reason, connectionHandle) =>
        {
            error = reason;
            events.Enqueue(("error", connectionHandle));
        };
        _server.Close += (wasClean, connectionHandle) =>
        {
            events.Enqueue((wasClean ? "clean close" : "close", connectionHandle));
            closed.TrySetResult();
        };

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // a text frame that is not UTF-8
            await client.SendAsync(new byte[] { 0xFF, 0xFE }, WebSocketMessageType.Text, true, Cancelled);
            await Next(_closes);
            // ! the fixture's close listener runs before this one: wait for this one's, not the fixture's
            await closed.Task.WaitAsync(Patience, Cancelled);

            Assert.Equal([("error", connectionHandle), ("close", connectionHandle)], events);
            Assert.Equal(WebSocketError.Faulted, Assert.IsType<WebSocketException>(error).WebSocketErrorCode);
        }
    }

    [Fact]
    public async Task Tells_a_peer_that_drops_without_its_closing_handshake_by_its_unclean_close_alone_no_error()
    {
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Error += (reason, connectionHandle) =>
        {
            errors.Enqueue((reason, connectionHandle));
        };

        // its socket ended with no close frame, then reset
        var drops = new Func<Task<string>>[]
        {
            async () =>
            {
                var (client, connectionHandle) = await Connect();

                using (client)
                {
                    client.Abort();
                }

                return connectionHandle;
            },
            async () =>
            {
                var (tcp, status) = await Upgraded(UpgradeRequest());
                var connectionHandle = await Next(_connections);

                using (tcp)
                {
                    Assert.Equal(101, status);
                    // a linger of 0: its close an abort, a reset sent rather than a FIN (RFC 9293 §3.10.5)
                    tcp.Client.LingerState = new LingerOption(true, 0);
                }

                return connectionHandle;
            },
        };

        foreach (var drop in drops)
        {
            var connectionHandle = await drop();

            // ! an error, were one told, comes before its close: the read's catch runs before its finally
            Assert.Equal((false, connectionHandle), await Next(_closes));
        }

        // and it keeps serving
        var (next, nextHandle) = await Connect();

        using (next)
        {
            await next.SendAsync("ping"u8.ToArray(), WebSocketMessageType.Text, true, Cancelled);

            var (message, messageHandle) = await Next(_messages);

            Assert.Equal(("ping", nextHandle), (Encoding.UTF8.GetString(message.Bytes.Span), messageHandle));
            Assert.True(_closes.Reader.Count == 0);
            Assert.Empty(errors);
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

    [Fact(Skip = SamePort.Reason, SkipUnless = nameof(OpensTwoSocketsFromOnePort))]
    public async Task Names_each_connection_by_its_peer_s_port_and_the_rank_it_came_at_two_sockets_from_one_address_and_port_among_them_and_gives_no_handle_twice()
    {
        await ListenEverywhere();

        // two sockets from one address and port, to two addresses of the server, then a third from
        // it once the first is closed
        var (first, port) = await SamePort.Connect(new IPEndPoint(IPAddress.Loopback, _port), 0);
        var firstHandle = await Next(_connections);
        var (second, _) = await SamePort.Connect(new IPEndPoint(IPAddress.Parse("127.0.0.2"), _port), port);
        var secondHandle = await Next(_connections);

        using (first)
        using (second)
        {
            Assert.Equal(
                (port, port),
                (_server.Clients[0].Port, _server.Clients[1].Port));
            Assert.Equal([firstHandle, secondHandle], HandlesOf(_server.Clients));
            Assert.Equal(2, _server.Gauges().Counts["connections"]);

            await first.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled).WaitAsync(Patience, Cancelled);

            Assert.Equal((true, firstHandle), await Next(_closes));

            var (third, _) = await SamePort.Connect(new IPEndPoint(IPAddress.Parse("127.0.0.3"), _port), port);
            var thirdHandle = await Next(_connections);

            using (third)
            {
                var ordinal = OrdinalOf(firstHandle);

                Assert.Equal(
                    [
                        $"type=WS;ip=127.0.0.1;port={port};ordinal={ordinal}",
                        $"type=WS;ip=127.0.0.1;port={port};ordinal={ordinal + 1}",
                        $"type=WS;ip=127.0.0.1;port={port};ordinal={ordinal + 2}",
                    ],
                    new[] { firstHandle, secondHandle, thirdHandle });
                Assert.Equal([secondHandle, thirdHandle], HandlesOf(_server.Clients));
            }
        }
    }

    [Fact(Skip = SamePort.Reason, SkipUnless = nameof(OpensTwoSocketsFromOnePort))]
    public async Task Closes_each_of_two_sockets_from_one_address_and_port_on_its_own_each_its_own_close_told()
    {
        // its peer's close, clean, or its socket gone, unclean
        static async Task End(ClientWebSocket peer, bool wasClean)
        {
            if (wasClean)
            {
                await peer.CloseAsync(WebSocketCloseStatus.NormalClosure, null, Cancelled).WaitAsync(Patience, Cancelled);
            }
            else
            {
                peer.Abort();
            }
        }

        // what its gauges count once the address's place a connection held is given back, as its
        // request ends, after its close is told
        async Task<string> CountsOnceHeldBy(int connections)
        {
            await Until(() =>
            {
                return _server.Gauges().Counts["largestAddressConnections"] == connections;
            });

            return CountsOf(_server);
        }

        await ListenEverywhere();

        // each ending in turn
        foreach (var wasClean in new[] { true, false })
        {
            var (older, port) = await SamePort.Connect(new IPEndPoint(IPAddress.Loopback, _port), 0);
            var olderHandle = await Next(_connections);
            var (newer, _) = await SamePort.Connect(new IPEndPoint(IPAddress.Parse("127.0.0.2"), _port), port);
            var newerHandle = await Next(_connections);

            using (older)
            using (newer)
            {
                Assert.NotEqual(olderHandle, newerHandle);
                await End(older, wasClean);

                Assert.Equal((wasClean, olderHandle), await Next(_closes));
                Assert.Equal(
                    (wasClean, "connections=1; largestAddressConnections=1; largestUnsentBytes=0; unsentBytes=0"),
                    (wasClean, await CountsOnceHeldBy(1)));

                // the newer stands, and is sent to
                await _server.Send(new TransportMessage(new byte[] { 1 }, false), newerHandle).WaitAsync(Patience, Cancelled);

                Assert.Equal(new byte[] { 1 }, (await ReceiveOf(newer)).Bytes);
                Assert.Equal([newerHandle], _server.ConnectionHandles);

                await End(newer, wasClean);

                Assert.Equal((wasClean, newerHandle), await Next(_closes));
                Assert.Empty(_server.ConnectionHandles);
                Assert.Equal(
                    (wasClean, "connections=0; largestAddressConnections=0; largestUnsentBytes=0; unsentBytes=0"),
                    (wasClean, await CountsOnceHeldBy(0)));
                Assert.True(_closes.Reader.Count == 0);
            }
        }
    }

    [Fact]
    public async Task Names_a_client_that_comes_over_IPv4_to_a_dual_stack_listener_by_its_IPv4_address()
    {
        await _server.Stop();
        _server = new WebSocketTransportServer();
        await Listen(new WebSocketTransportStartOptions { Address = "::", FindOpenPort = true });

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            Assert.Matches(@"^type=WS;ip=127\.0\.0\.1;port=\d+;ordinal=\d+$", connectionHandle);
            Assert.Equal("127.0.0.1", Assert.Single(_server.Clients).Address);
        }
    }

    // spec 15.12
    [Fact]
    public async Task Takes_a_client_s_address_from_X_Forwarded_For_only_from_a_proxy_it_names_and_names_its_connection_by_it()
    {
        await Start(new WebSocketTransportServerOptions { Hosts = ["bead.test"], TrustedProxies = ["127.0.0.1"] });

        var sockets = new List<TcpClient>();

        // an upgrade from an address of the loopback's, its X-Forwarded-For given, taken: the handle
        // its connection is named by, beside the socket's own port, which the server sees as its peer's
        async Task<(string ConnectionHandle, int Port)> DrawOf(string forwarded, IPAddress from)
        {
            var tcp = new TcpClient(new IPEndPoint(from, 0));

            sockets.Add(tcp);
            await tcp.ConnectAsync(IPAddress.Loopback, _port, Cancelled);
            await tcp.GetStream().WriteAsync(HandshakeOf("GET / HTTP/1.1", $"X-Forwarded-For: {forwarded}"), Cancelled);
            await ReadHead(tcp.GetStream());

            return (await Next(_connections), ((IPEndPoint)tcp.Client.LocalEndPoint!).Port);
        }

        try
        {
            var walked = await DrawOf("203.0.113.9, 198.51.100.7", IPAddress.Loopback);
            // what is no address is not taken, nor what only a lenient parse reads as one
            var noAddress = await DrawOf("evil;ordinal=1", IPAddress.Loopback);
            var lenient = await DrawOf("1", IPAddress.Loopback);
            // an IPv6 address as RFC 7239 writes a node, its port dropped, held as RFC 5952 writes it
            var bracketed = await DrawOf("[2001:DB8::1]:443", IPAddress.Loopback);
            // nor what a peer it does not name forwards: one of another address of the loopback's
            var foreign = await DrawOf("192.0.2.1", IPAddress.Parse("127.0.0.2"));
            var ordinal = OrdinalOf(walked.ConnectionHandle);

            Assert.Equal(
                [
                    $"type=WS;ip=198.51.100.7;port={walked.Port};ordinal={ordinal}",
                    $"type=WS;ip=127.0.0.1;port={noAddress.Port};ordinal={ordinal + 1}",
                    $"type=WS;ip=127.0.0.1;port={lenient.Port};ordinal={ordinal + 2}",
                    $"type=WS;ip=2001:db8::1;port={bracketed.Port};ordinal={ordinal + 3}",
                    $"type=WS;ip=127.0.0.2;port={foreign.Port};ordinal={ordinal + 4}",
                ],
                new[] { walked.ConnectionHandle, noAddress.ConnectionHandle, lenient.ConnectionHandle, bracketed.ConnectionHandle, foreign.ConnectionHandle });
            Assert.Equal(
                [("198.51.100.7", walked.Port), ("127.0.0.1", noAddress.Port), ("127.0.0.1", lenient.Port), ("2001:db8::1", bracketed.Port), ("127.0.0.2", foreign.Port)],
                _server.Clients.Select((client) =>
                {
                    return (client.Address, client.Port);
                }));

            // and a refusal tells the client's address so read, its field's lines joined, beside the
            // socket's port; what is no address ends the walk at the proxy that wrote it
            var upgrade = $"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {Key}\r\nSec-WebSocket-Version: 13\r\n";
            var lines = await RefusalOf($"GET / HTTP/1.1\r\nHost: rebind.example\r\n{upgrade}X-Forwarded-For: 203.0.113.9\r\nX-Forwarded-For: 198.51.100.7\r\n\r\n");
            var unknown = await RefusalOf($"GET / HTTP/1.1\r\nHost: rebind.example\r\n{upgrade}X-Forwarded-For: unknown\r\n\r\n");

            await Until(() =>
            {
                return _refusals.Count == 2;
            });

            Assert.Equal(
                [
                    new TransportServerRefusal("198.51.100.7", "rebind.example", null, lines.Port, WebSocketRefusals.Host, 403),
                    new TransportServerRefusal("127.0.0.1", "rebind.example", null, unknown.Port, WebSocketRefusals.Host, 403),
                ],
                _refusals);
        }
        finally
        {
            foreach (var socket in sockets)
            {
                socket.Dispose();
            }
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
        // a beat of a second: the peer that answers has that long for its pong, which a loaded runner
        // may take more than half a second to send
        await Start(new WebSocketTransportServerOptions { Heartbeat = TimeSpan.FromSeconds(1) });

        // the first reads nothing, so it answers no ping; the second, always reading, answers each
        var (silent, silentHandle) = await Connect();
        var (answering, answeringHandle) = await Connect();

        using (silent)
        using (answering)
        {
            var reading = answering.ReceiveAsync(new byte[16], Cancelled);

            Assert.Equal((false, silentHandle), await Next(_closes, Patience));
            // a few beats more, and the one that answers is still there
            await Task.Delay(3_000, Cancelled);

            Assert.Equal([answeringHandle], _server.ConnectionHandles);
            Assert.True(_closes.Reader.Count == 0);
            Assert.False(reading.IsCompleted);
        }
    }

    // an upgrade from behind a proxy that writes the client's address, as a socket of its own
    private static byte[] UpgradeFrom(string forwarded)
    {
        return Encoding.ASCII.GetBytes(
            $"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Forwarded-For: {forwarded}\r\n" +
            $"Sec-WebSocket-Key: {Convert.ToBase64String(RandomNumberGenerator.GetBytes(16))}\r\nSec-WebSocket-Version: 13\r\n\r\n");
    }

    // a socket upgraded, held open: the status of its answer's head, read to its blank line
    private async Task<(TcpClient Socket, int Status)> Upgraded(byte[] request)
    {
        var tcp = await OpenTcp();
        var stream = tcp.GetStream();
        var head = new StringBuilder();
        var octet = new byte[1];

        await stream.WriteAsync(request, Cancelled);

        while (!head.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
        {
            await stream.ReadExactlyAsync(octet, Cancelled).AsTask().WaitAsync(Patience, Cancelled);
            head.Append((char)octet[0]);
        }

        return (tcp, int.Parse(head.ToString().Split(' ')[1], CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Bounds_its_connections_and_those_of_one_address_refusing_an_upgrade_past_them_503_busy_before_its_101_with_Retry_After_and_takes_one_once_a_connection_closes()
    {
        await Start(new WebSocketTransportServerOptions { MaximumConnections = 2, MaximumConnectionsPerAddress = 1, TrustedProxies = ["127.0.0.1"], Clock = new FakeTimeProvider(Now) });

        // one address's one place taken, then another's: the server's two
        var (first, firstStatus) = await Upgraded(UpgradeFrom("192.0.2.1"));
        var (second, secondStatus) = await Upgraded(UpgradeFrom("192.0.2.2"));

        using (second)
        {
            using (first)
            {
                Assert.Equal((101, 101), (firstStatus, secondStatus));

                // past the first address's bound, then past the server's: 503 busy, no 101
                foreach (var forwarded in new[] { "192.0.2.1", "198.51.100.7" })
                {
                    var (status, fields, body) = await AnswerOf(UpgradeFrom(forwarded));

                    Assert.Equal((503, WebSocketRefusals.Busy, "1", ""), (status, fields["bead-refusal"], fields["retry-after"], body));
                }

                Assert.Equal(
                    [(503, WebSocketRefusals.Busy, "192.0.2.1"), (503, WebSocketRefusals.Busy, "198.51.100.7")],
                    _refusals.Select((refusal) =>
                    {
                        return (refusal.Status, refusal.Reason, refusal.Address!);
                    }));
                Assert.Equal((2, 1), (_server.Gauges().Counts["connections"], _server.Gauges().Counts["largestAddressConnections"]));
            }

            // a connection gone gives its place back
            await Next(_closes);

            var (again, againStatus) = await Upgraded(UpgradeFrom("192.0.2.1"));

            using (again)
            {
                Assert.Equal(101, againStatus);
            }
        }
    }

    [Fact]
    public async Task Takes_no_more_upgrades_than_its_places_when_they_cross()
    {
        await Start(new WebSocketTransportServerOptions { MaximumConnections = 4 });

        // sixteen at once against four places
        var clients = Enumerable.Range(0, 16).Select((_) =>
        {
            return new ClientWebSocket();
        }).ToList();

        try
        {
            var outcomes = await Task.WhenAll(clients.Select(async (client) =>
            {
                try
                {
                    await client.ConnectAsync(UriOf(_port), Cancelled);

                    return true;
                }
                catch (WebSocketException)
                {
                    return false;
                }
            }));

            Assert.Equal((4, 12), (outcomes.Count((taken) =>
            {
                return taken;
            }), outcomes.Count((taken) =>
            {
                return !taken;
            })));
            Assert.Equal(4, _server.Gauges().Counts["connections"]);
            Assert.All(_refusals, (refusal) =>
            {
                Assert.Equal((503, WebSocketRefusals.Busy), (refusal.Status, refusal.Reason));
            });
        }
        finally
        {
            foreach (var client in clients)
            {
                client.Dispose();
            }
        }
    }

    [Fact]
    public void Refuses_a_MaximumConnections_or_a_MaximumConnectionsPerAddress_that_is_not_a_whole_number_above_0()
    {
        foreach (var (name, options) in new (string, WebSocketTransportServerOptions)[]
        {
            (nameof(WebSocketTransportServerOptions.MaximumConnections), new() { MaximumConnections = 0 }),
            (nameof(WebSocketTransportServerOptions.MaximumConnections), new() { MaximumConnections = -1 }),
            (nameof(WebSocketTransportServerOptions.MaximumConnectionsPerAddress), new() { MaximumConnectionsPerAddress = 0 }),
            (nameof(WebSocketTransportServerOptions.MaximumConnectionsPerAddress), new() { MaximumConnectionsPerAddress = int.MinValue }),
        })
        {
            Assert.Equal(name, Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new WebSocketTransportServer(options);
            }).ParamName);
        }

        // a place at once holds; and by default, 10,000 in all, 64 an address
        _ = new WebSocketTransportServer(new WebSocketTransportServerOptions { MaximumConnections = 1, MaximumConnectionsPerAddress = 1 });
        Assert.Equal((10_000, 64), (new WebSocketTransportServerOptions().MaximumConnections, new WebSocketTransportServerOptions().MaximumConnectionsPerAddress));
    }

    [Fact]
    public async Task Keeps_a_client_that_reads_through_a_burst_of_answers_to_the_calls_it_has_it_answer_each_of_chunkBytes()
    {
        await Start(new WebSocketTransportServerOptions());

        var reported = new ConcurrentQueue<Exception>();

        _server.Error += (reason, _) =>
        {
            reported.Enqueue(reason);
        };

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            // the answers to as many calls as a connection has answered at once, each of a chunk, in
            // one turn: given the time their bytes take at the rate, never dropped
            var answer = new byte[LimitDefaults.ChunkBytes];
            var sending = Enumerable.Range(0, LimitDefaults.MaximumAnsweringCalls).Select((_) =>
            {
                return _server.Send(new TransportMessage(answer, false), connectionHandle);
            }).ToList();
            var buffer = new byte[LimitDefaults.ChunkBytes];

            Assert.InRange(_server.Gauges().Counts["largestUnsentBytes"], 0, (long)LimitDefaults.MaximumAnsweringCalls * LimitDefaults.ChunkBytes);

            for (var received = 0; received < LimitDefaults.MaximumAnsweringCalls; received += 1)
            {
                var length = 0;
                ValueWebSocketReceiveResult result;

                do
                {
                    result = await client.ReceiveAsync(buffer.AsMemory(length), Cancelled).AsTask().WaitAsync(Patience, Cancelled);
                    length += result.Count;
                }
                while (!result.EndOfMessage);

                Assert.Equal(LimitDefaults.ChunkBytes, length);
            }

            await Task.WhenAll(sending).WaitAsync(Patience, Cancelled);
            Assert.Equal(WebSocketState.Open, client.State);
            Assert.Equal(0, _server.Gauges().Counts["unsentBytes"]);
            Assert.Empty(reported);
            Assert.True(_closes.Reader.Count == 0);
        }
    }

    // spec 15.12.11 and 15.12.12
    [Fact]
    public async Task Drops_a_client_that_stops_reading_once_its_socket_holds_what_waits_for_it_past_its_deadline_and_reports_it()
    {
        PausedWebSocket? paused = null;

        // ! a client that stops reading, its socket's sends held: a platform that takes every send
        // into its own buffers, Windows', never holds them itself
        await Start(new WebSocketTransportServer(new WebSocketTransportServerOptions { SendGracePeriod = TimeSpan.FromMilliseconds(200) })
        {
            Accepted = (socket, connectionHandle) =>
            {
                paused = new PausedWebSocket(socket);

                return (paused, connectionHandle);
            },
        });

        var reported = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Error += (reason, connectionHandle) =>
        {
            reported.Enqueue((reason, connectionHandle));
        };

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            paused!.Pause();

            // what waits for its socket, past its deadline of 200 ms: dropped at the next check
            _ = _server.Send(new TransportMessage(new byte[16], false), connectionHandle);

            Assert.Equal(16, _server.Gauges().Counts["largestUnsentBytes"]);
            Assert.Equal((false, connectionHandle), await Next(_closes));
            Assert.Equal(connectionHandle, Assert.Single(reported).ConnectionHandle);
            Assert.Contains(nameof(WebSocketTransportServerOptions.MinimumSendBytesPerSecond), Assert.Single(reported).Reason.Message, StringComparison.Ordinal);
            Assert.Empty(_server.ConnectionHandles);
        }
    }

    // spec 15.12.13
    [Fact]
    public async Task Drops_a_client_once_what_waits_for_it_would_pass_maximumUnsentBytes_the_bytes_it_holds_never_past_them_its_close_unclean_and_reports_it()
    {
        PausedWebSocket? paused = null;

        await Start(new WebSocketTransportServer(new WebSocketTransportServerOptions { Heartbeat = Timeout.InfiniteTimeSpan, MaximumUnsentBytes = 65_536 })
        {
            Accepted = (socket, connectionHandle) =>
            {
                paused = new PausedWebSocket(socket);

                return (paused, connectionHandle);
            },
        });

        var reported = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Error += (reason, connectionHandle) =>
        {
            reported.Enqueue((reason, connectionHandle));
        };

        var (client, connectionHandle) = await Connect();

        using (client)
        {
            paused!.Pause();

            // sixteen KiB at a time, each sampled under the bound, until one would pass it
            var samples = new List<long>();

            for (var sent = 0; sent < 8 && _server.ConnectionHandles.Count > 0; sent += 1)
            {
                _ = _server.Send(new TransportMessage(new byte[16_384], false), connectionHandle);
                samples.Add(_server.Gauges().Counts["largestUnsentBytes"]);
            }

            Assert.Equal((false, connectionHandle), await Next(_closes));
            Assert.All(samples, (sample) =>
            {
                Assert.InRange(sample, 0, 65_536);
            });
            Assert.Equal(65_536, samples.Max());
            Assert.Equal(connectionHandle, Assert.Single(reported).ConnectionHandle);
            Assert.Contains(nameof(WebSocketTransportServerOptions.MaximumUnsentBytes), Assert.Single(reported).Reason.Message, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// A socket whose sends wait, once paused, until it is aborted: a client that stops reading. The
    /// rest is the socket it wraps.
    /// </summary>
    private sealed class PausedWebSocket(WebSocket socket) : WebSocket
    {
        private readonly TaskCompletionSource _aborted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private volatile bool _isPaused;

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

        public void Pause()
        {
            _isPaused = true;
        }

        public override void Abort()
        {
            _aborted.TrySetException(new WebSocketException("aborted"));
            socket.Abort();
        }

        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            return socket.CloseAsync(closeStatus, statusDescription, cancellationToken);
        }

        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            return socket.CloseOutputAsync(closeStatus, statusDescription, cancellationToken);
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
            return _isPaused ? _aborted.Task : socket.SendAsync(buffer, messageType, endOfMessage, cancellationToken);
        }

        public override ValueTask SendAsync(ReadOnlyMemory<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            return _isPaused ? new ValueTask(_aborted.Task) : socket.SendAsync(buffer, messageType, endOfMessage, cancellationToken);
        }
    }

    [Fact]
    public void Refuses_a_MaximumUnsentBytes_a_MinimumSendBytesPerSecond_or_a_SendGracePeriod_it_cannot_hold_as_it_is_built()
    {
        foreach (var (options, name, refusal) in new (WebSocketTransportServerOptions, string, string)[]
        {
            (new() { MaximumUnsentBytes = 0 }, nameof(WebSocketTransportServerOptions.MaximumUnsentBytes), "MaximumUnsentBytes is a whole number above 0, not 0"),
            (new() { MinimumSendBytesPerSecond = -1 }, nameof(WebSocketTransportServerOptions.MinimumSendBytesPerSecond), "MinimumSendBytesPerSecond is a whole number, not -1"),
            (new() { SendGracePeriod = Timeout.InfiniteTimeSpan }, nameof(WebSocketTransportServerOptions.SendGracePeriod), "SendGracePeriod is a number of milliseconds from 1 to 2147483647, not infinite"),
        })
        {
            var refused = Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new WebSocketTransportServer(options);
            });

            Assert.Equal((name, true), (refused.ParamName, refused.Message.StartsWith(refusal[..refusal.LastIndexOf(", not ", StringComparison.Ordinal)], StringComparison.Ordinal)));
        }

        // 0 holds no pace; a transport built alone holds what a peer that keeps every rule can be owed
        Assert.Equal(184_551_424, new WebSocketTransportServer(new WebSocketTransportServerOptions { MinimumSendBytesPerSecond = 0 }).MaximumUnsentBytes);
    }
}
