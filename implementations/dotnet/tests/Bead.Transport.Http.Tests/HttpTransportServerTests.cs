using System.Buffers.Binary;
using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Bead.Tests;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="HttpTransportServer"/>, on Kestrel, against <see cref="HttpClient"/> and, for what it
/// will not send, a socket of the tests' own writing HTTP/1.1 by hand: its connections drawn, its
/// exchanges, its refusals, its listens, its bounds and its timers, on a clock a test moves — the
/// twins of the TypeScript side's own tests, one for one.
/// </summary>
public sealed class HttpTransportServerTests : IAsyncLifetime
{
    // constants

    private const string Host = "127.0.0.1";

    // a bearer credential, RFC 6750's own example, its auth-scheme included
    private const string Bearer = "Bearer mF_9.B5f-4.1JqM";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly HttpTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    // another address of this machine, which a socket of the tests' own comes from, as a peer elsewhere
    private static readonly IPAddress Elsewhere = IPAddress.Parse("127.0.0.2");

    // what a cancel before its request buries that call id for: the least a requester reserves one for
    private static readonly TimeSpan Burial = TimeSpan.FromSeconds(5);

    private static readonly Lazy<X509Certificate2> Certificate = new(CertificateOf);

    private readonly ConcurrentQueue<string> _connections = new();
    private readonly ConcurrentQueue<(byte[] Bytes, string ConnectionHandle)> _messages = new();
    private readonly ConcurrentQueue<(bool WasClean, string ConnectionHandle)> _closes = new();
    private readonly SpiedTime _time = new();
    private readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = false });
    private HttpTransportServer _server = new();
    private int _port;

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private Uri Url
    {
        get
        {
            return new Uri($"http://{Host}:{_port}/bead");
        }
    }

    private Uri SecureUrl
    {
        get
        {
            return new Uri($"https://{Host}:{_port}/bead");
        }
    }

    /// <summary>An envelope as the transport reads it: its kind, its call id, and <c>Extra</c> bytes of 7.</summary>
    private static byte[] EnvelopeOf(EnvelopeKind kind, (uint CallId, int Extra) shape)
    {
        var bytes = new byte[8 + shape.Extra];

        Array.Fill(bytes, (byte)7);
        bytes[0] = 0xA1;
        bytes[1] = (byte)kind;
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(4), shape.CallId);

        return bytes;
    }

    private static byte[] EnvelopeOf(EnvelopeKind kind, uint callId)
    {
        return EnvelopeOf(kind, (callId, 0));
    }

    /// <summary>What a listen brings back of <paramref name="envelopes"/>: each after its length in 4 bytes.</summary>
    private static byte[] BatchOf(params byte[][] envelopes)
    {
        return [.. envelopes.SelectMany((envelope) =>
        {
            var length = new byte[4];

            BinaryPrimitives.WriteUInt32BigEndian(length, (uint)envelope.Length);

            return (byte[])[.. length, .. envelope];
        })];
    }

    // a self-signed certificate for 127.0.0.1 and bead.example, which a client trusts alone
    private static X509Certificate2 CertificateOf()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=127.0.0.1", key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();

        names.AddIpAddress(IPAddress.Loopback);
        names.AddDnsName("bead.example");
        request.CertificateExtensions.Add(names.Build());

        using var made = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));

        // imported again, so SslStream can use its key on Windows
        return X509CertificateLoader.LoadPkcs12(made.Export(X509ContentType.Pfx), null);
    }

    // a client over TLS that trusts the tests' certificate alone, as the TypeScript side's trusts its fixture's
    private static HttpClient SecureClient()
    {
        var policy = new X509ChainPolicy { RevocationMode = X509RevocationMode.NoCheck, TrustMode = X509ChainTrustMode.CustomRootTrust };

        policy.CustomTrustStore.Add(Certificate.Value);

        return new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            SslOptions = new SslClientAuthenticationOptions { CertificateChainPolicy = policy },
        });
    }

    private static HttpRequestMessage Over(HttpRequestMessage request, Version version)
    {
        request.Version = version;
        request.VersionPolicy = HttpVersionPolicy.RequestVersionExact;

        return request;
    }

    private static HttpRequestMessage With(HttpRequestMessage request, (string Name, string Value) header)
    {
        if (!request.Headers.TryAddWithoutValidation(header.Name, header.Value))
        {
            request.Content?.Headers.Remove(header.Name);
            request.Content?.Headers.TryAddWithoutValidation(header.Name, header.Value);
        }

        return request;
    }

    private static string? HeaderOf(HttpResponseMessage response, string name)
    {
        return response.Headers.TryGetValues(name, out var values) || response.Content.Headers.TryGetValues(name, out values)
            ? string.Join(", ", values)
            : null;
    }

    private static async Task<byte[]> BytesOf(HttpResponseMessage response)
    {
        return await response.Content.ReadAsByteArrayAsync(Cancelled).WaitAsync(Patience, Cancelled);
    }

    // whether a body comes whole, or is cut
    private static async Task<string> EndOf(HttpResponseMessage response)
    {
        try
        {
            await BytesOf(response);

            return "whole";
        }
        catch (Exception reason) when (reason is IOException or HttpRequestException)
        {
            return "cut";
        }
    }

    // an exchange lost before any status: its socket reset, or ended
    private static bool IsLost(HttpRequestException reason)
    {
        return reason.HttpRequestError == HttpRequestError.ResponseEnded || reason.InnerException is IOException or SocketException;
    }

    private static async Task Until(Func<bool> condition)
    {
        var watch = Stopwatch.StartNew();

        while (!condition() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }

        Assert.True(condition(), "what was awaited never came");
    }

    private static async Task<HttpResponseMessage> Fetch(HttpClient client, HttpRequestMessage request)
    {
        using (request)
        {
            return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Cancelled).WaitAsync(Patience, Cancelled);
        }
    }

    private Task<HttpResponseMessage> Fetch(HttpRequestMessage request)
    {
        return Fetch(_http, request);
    }

    private HttpRequestMessage PostOf(string? connectionToken, byte[]? body)
    {
        return PostOf(Url, (connectionToken, body));
    }

    private static HttpRequestMessage PostOf(Uri url, (string? ConnectionToken, byte[]? Body) exchange)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new ByteArrayContent(exchange.Body ?? []) };

        request.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

        return exchange.ConnectionToken is { } connectionToken
            ? With(request, (HttpTransport.ConnectionTokenHeader, connectionToken))
            : request;
    }

    private HttpRequestMessage RequestOf(HttpMethod method, string? connectionToken)
    {
        var request = new HttpRequestMessage(method, Url);

        return connectionToken is null ? request : With(request, (HttpTransport.ConnectionTokenHeader, connectionToken));
    }

    /// <summary>What a response says of itself: its status and its refusal's reason.</summary>
    private static async Task<(int Status, string? Reason)> RefusalOf(Task<HttpResponseMessage> answered)
    {
        using var response = await answered;

        await BytesOf(response);

        return ((int)response.StatusCode, HeaderOf(response, HttpTransport.RefusalHeader));
    }

    private Task<(int Status, string? Reason)> RefusalOf(HttpRequestMessage request)
    {
        return RefusalOf(Fetch(request));
    }

    private Task<HttpResponseMessage> ListenOf(string connectionToken, string query)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, new Uri($"{Url}?{query}"));

        return Fetch(With(request, (HttpTransport.ConnectionTokenHeader, connectionToken)));
    }

    /// <summary>Connects: the token the server drew, and the handle it named the connection by.</summary>
    private async Task<(string ConnectionToken, string ConnectionHandle)> Connect(bool isListening = false)
    {
        var request = PostOf(null, null);
        using var response = await Fetch(isListening ? With(request, (HttpTransport.ListenHeader, "?1")) : request);

        Assert.Equal(201, (int)response.StatusCode);

        return (HeaderOf(response, HttpTransport.ConnectionTokenHeader) ?? "", _connections.Last());
    }

    // a connect from another address of this machine
    private async Task<(string ConnectionToken, string ConnectionHandle)> ConnectFrom(IPAddress from, bool isListening)
    {
        using var wire = await Wire.Open(_port, from);

        await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\n{HttpTransport.ListenHeader}: {(isListening ? "?1" : "?0")}\r\nContent-Length: 0\r\n\r\n");

        var (head, _) = await wire.Read();

        Assert.Equal(201, head.Status);

        return (head.Headers[HttpTransport.ConnectionTokenHeader], _connections.Last());
    }

    // a POST's head on a connection, by hand: its body framed as `framing` says
    private static string PostHead(string connectionToken, string framing)
    {
        return $"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{framing}\r\n\r\n";
    }

    private static byte[] ChunkOf(byte[] bytes)
    {
        return [.. Encoding.ASCII.GetBytes($"{bytes.Length:x}\r\n"), .. bytes, .. "\r\n"u8];
    }

    private long Count(string name)
    {
        return _server.Gauges().Counts[name];
    }

    private TimeSpan[] DelaysSince(int before)
    {
        return [.. _time.Armed.Skip(before).Select((armed) =>
        {
            return armed.Delay;
        })];
    }

    private static string[] HandlesOf(IEnumerable<TransportServerClient> clients)
    {
        return [.. clients.Select((client) =>
        {
            return client.ConnectionHandle;
        })];
    }

    private DateTimeOffset?[] StampsOf()
    {
        return [.. _server.Clients.Select((client) =>
        {
            return client.LastActivity;
        })];
    }

    private EnvelopeKind[] KindsHandedOn()
    {
        return [.. _messages.Select((message) =>
        {
            return (EnvelopeKind)message.Bytes[1];
        })];
    }

    private async Task Start(HttpTransportServerOptions? options = null)
    {
        await _server.Stop().WaitAsync(Patience, Cancelled);
        _server = new HttpTransportServer((options ?? new HttpTransportServerOptions()) with { Clock = _time });
        _server.Connection += (connectionHandle) =>
        {
            _connections.Enqueue(connectionHandle);
        };
        _server.Message += (message, connectionHandle) =>
        {
            _messages.Enqueue((message.Bytes.ToArray(), connectionHandle));
        };
        _server.Close += (wasClean, connectionHandle) =>
        {
            _closes.Enqueue((wasClean, connectionHandle));
        };
        _port = (await _server.Start(Loopback, Cancelled)).Port;
    }

    /// <summary>An answer's head: its status, and its headers by their names in lower case.</summary>
    private sealed record Head(int Status, IReadOnlyDictionary<string, string> Headers);

    /// <summary>A socket of the tests' own, writing HTTP/1.1 by hand: what HttpClient will not send.</summary>
    private sealed class Wire : IDisposable
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;

        private Wire(TcpClient tcp)
        {
            _tcp = tcp;
            _stream = tcp.GetStream();
        }

        // its own port, which the server sees as its peer's
        public int Port
        {
            get
            {
                return ((IPEndPoint)_tcp.Client.LocalEndPoint!).Port;
            }
        }

        public static async Task<Wire> Open(int port, IPAddress? from = null)
        {
            var tcp = from is null ? new TcpClient() : new TcpClient(new IPEndPoint(from, 0));

            try
            {
                await tcp.ConnectAsync(IPAddress.Loopback, port, Cancelled);

                return new Wire(tcp);
            }
            catch
            {
                tcp.Dispose();

                throw;
            }
        }

        public async Task Write(string text)
        {
            await Write(Encoding.ASCII.GetBytes(text));
        }

        public async Task Write(byte[] bytes)
        {
            await _stream.WriteAsync(bytes, Cancelled);
        }

        public async Task<Head> ReadHead()
        {
            var status = int.Parse((await ReadLine()).Split(' ')[1], CultureInfo.InvariantCulture);
            var headers = new Dictionary<string, string>();

            for (var line = await ReadLine(); line.Length > 0; line = await ReadLine())
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);

                headers[line[..colon].Trim().ToLowerInvariant()] = line[(colon + 1)..].Trim();
            }

            return new Head(status, headers);
        }

        // a body as its head frames it: by its length, in chunks, or none
        public async Task<byte[]> ReadBody(Head head)
        {
            if (head.Headers.TryGetValue("content-length", out var length))
            {
                return await ReadExactly(int.Parse(length, CultureInfo.InvariantCulture));
            }

            if (!head.Headers.ContainsKey("transfer-encoding"))
            {
                return [];
            }

            var body = new List<byte>();

            for (var size = int.Parse(await ReadLine(), NumberStyles.HexNumber, CultureInfo.InvariantCulture); size > 0; size = int.Parse(await ReadLine(), NumberStyles.HexNumber, CultureInfo.InvariantCulture))
            {
                body.AddRange(await ReadExactly(size));
                await ReadLine();
            }

            await ReadLine();

            return [.. body];
        }

        public async Task<(Head Head, byte[] Body)> Read()
        {
            var head = await ReadHead();

            return (head, await ReadBody(head));
        }

        // some of what comes, however little
        public async Task<int> ReadSome()
        {
            return await _stream.ReadAsync(new byte[4_096], Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        // whether the server ended it: a read that finds its end, or its reset
        public async Task<bool> IsClosed()
        {
            try
            {
                return await _stream.ReadAsync(new byte[1], Cancelled).AsTask().WaitAsync(Patience, Cancelled) == 0;
            }
            catch (IOException)
            {
                return true;
            }
        }

        // dropped with a reset, as a client gone does
        public void Reset()
        {
            _tcp.LingerState = new LingerOption(true, 0);
            _tcp.Dispose();
        }

        public void Dispose()
        {
            _tcp.Dispose();
        }

        private async Task<byte[]> ReadExactly(int count)
        {
            var bytes = new byte[count];

            await _stream.ReadExactlyAsync(bytes, Cancelled).AsTask().WaitAsync(Patience, Cancelled);

            return bytes;
        }

        private async Task<string> ReadLine()
        {
            var line = new List<byte>();

            while (line.Count < 2 || line[^2] != '\r' || line[^1] != '\n')
            {
                line.AddRange(await ReadExactly(1));
            }

            return Encoding.ASCII.GetString([.. line[..^2]]);
        }
    }

    /// <summary>A clock a test moves, which keeps each timer it armed, as the TypeScript side's spy does.</summary>
    private sealed class SpiedTime : FakeTimeProvider
    {
        private readonly ConcurrentQueue<Armed> _armed = new();

        public IReadOnlyList<Armed> Armed
        {
            get
            {
                return [.. _armed];
            }
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var armed = new Armed(base.CreateTimer(callback, state, dueTime, period), dueTime);

            _armed.Enqueue(armed);

            return armed;
        }
    }

    /// <summary>A timer armed, its delay, and whether it was cleared.</summary>
    private sealed class Armed(ITimer timer, TimeSpan delay) : ITimer
    {
        private volatile bool _isCleared;

        public TimeSpan Delay { get; } = delay;

        public bool IsCleared
        {
            get
            {
                return _isCleared;
            }
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            return timer.Change(dueTime, period);
        }

        public void Dispose()
        {
            _isCleared = true;
            timer.Dispose();
        }

        public ValueTask DisposeAsync()
        {
            _isCleared = true;

            return timer.DisposeAsync();
        }
    }

    // definition

    public ValueTask InitializeAsync()
    {
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        _http.Dispose();
        await _server.Stop().WaitAsync(Patience, Cancelled);
    }

    // createHTTPTransportServer

    [Fact]
    public void Keeps_its_constants_in_step_with_the_router_s()
    {
        // the kinds it tells apart are the router's own, EnvelopeKind; what it reads by default, the
        // router's largest envelope, and its outbox two of them
        var options = new HttpTransportServerOptions();
        var start = new HttpTransportStartOptions();

        Assert.Equal(LimitDefaults.MaximumEnvelopeBytes, options.MaximumBodyBytes);
        Assert.Equal(2L * LimitDefaults.MaximumEnvelopeBytes, options.MaximumOutboxBytes);
        Assert.Equal(268_435_456, options.BodyBytesBudget);
        Assert.Equal(TimeSpan.FromMinutes(5), options.ExchangeTimeout);
        Assert.Equal(TimeSpan.FromMinutes(5), options.InactivityTimeout);
        Assert.Equal(TimeSpan.FromSeconds(30), options.MaximumWait);
        Assert.Equal((10_000, 64, 64), (options.MaximumConnections, options.MaximumConnectionsPerAddress, options.MaximumWaitingExchanges));
        Assert.Equal("/bead", options.Pathname);
        Assert.Equal(("0.0.0.0", 80, false), (start.Address, start.Port, start.FindOpenPort));
    }

    [Fact]
    public async Task Draws_a_connection_on_a_connect_a_token_of_16_bytes_a_201_and_connection_first_showing_neither()
    {
        await Start();

        var order = new ConcurrentQueue<string>();

        _server.Connection += (_) =>
        {
            order.Enqueue("connection");
        };

        using var response = await Fetch(PostOf(null, null));

        order.Enqueue("answered");

        var connectionToken = HeaderOf(response, HttpTransport.ConnectionTokenHeader) ?? "";
        var connectionHandle = Assert.Single(_connections);

        Assert.Equal(201, (int)response.StatusCode);
        Assert.Equal("no-store", HeaderOf(response, "cache-control"));
        Assert.Equal("nosniff", HeaderOf(response, "x-content-type-options"));
        Assert.Matches("^[A-Za-z0-9_-]{22}$", connectionToken);
        Assert.Equal(16, Base64Url.DecodeFromChars(connectionToken).Length);
        Assert.Equal("type=HTTP;ip=127.0.0.1;ordinal=1", connectionHandle);
        Assert.Equal(["connection", "answered"], order);
        Assert.Empty(_messages);
        Assert.Empty(_closes);
        Assert.False(_server.IsTwoWay(connectionHandle));
        Assert.Equal([connectionHandle], _server.ConnectionHandles);

        var client = Assert.Single(_server.Clients);

        Assert.Equal((Host, connectionHandle, TransportTypes.Http), (client.Address, client.ConnectionHandle, client.Type));
        // the token reaches no event, no handle, and no client listed
        Assert.DoesNotContain(connectionToken, string.Join(";", [.. _server.ConnectionHandles, .. _connections]), StringComparison.Ordinal);
        Assert.DoesNotContain(connectionToken, string.Join(";", _server.Clients), StringComparison.Ordinal);

        var second = await Connect();

        Assert.Equal("type=HTTP;ip=127.0.0.1;ordinal=2", second.ConnectionHandle);
        Assert.NotEqual(connectionToken, second.ConnectionToken);
    }

    [Fact]
    public async Task Clients_is_a_copy_without_the_sockets()
    {
        await Start();

        int port;

        // a socket of the tests' own, whose port is known
        using (var wire = await Wire.Open(_port))
        {
            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

            Assert.Equal(201, (await wire.Read()).Head.Status);
            port = wire.Port;
        }

        var first = Assert.Single(_connections);
        var clients = _server.Clients;

        Assert.Equal([new TransportServerClient(Host, first, null, port, TransportTypes.Http)], clients);

        // in the order they were drawn, whichever went in between; the copy taken before stays
        var (_, second) = await Connect();

        Assert.True(await _server.CloseConnection(first).WaitAsync(Patience, Cancelled));

        var (_, third) = await Connect();

        Assert.Equal([second, third], HandlesOf(_server.Clients));
        Assert.Equal([first], HandlesOf(clients));
    }

    [Fact]
    public async Task Pairs_each_answer_with_the_exchange_of_its_request_whatever_the_order_the_head_going_as_the_request_is_handed_on()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var first = Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        var second = Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, (3, 2))));

        // both heads arrive before any answer: the router has both
        using var firstHead = await first;
        using var secondHead = await second;

        Assert.Equal((200, 200), ((int)firstHead.StatusCode, (int)secondHead.StatusCode));
        Assert.Equal(HttpTransport.MediaType, firstHead.Content.Headers.ContentType?.MediaType);
        Assert.Equal(2, _messages.Count);

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, (3, 1)), false), connectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Failure, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal(EnvelopeOf(EnvelopeKind.Result, (3, 1)), await BytesOf(secondHead));
        Assert.Equal(EnvelopeOf(EnvelopeKind.Failure, 1), await BytesOf(firstHead));
        // an answer whose exchange ended is dropped, as one to a connection gone
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Answers_an_answer_sent_as_its_request_is_handed_on_in_one_go()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();

        _server.Message += (_, _) =>
        {
            _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Failure, 5), false), connectionHandle);
        };

        using var response = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 5)));

        Assert.Equal(8, response.Content.Headers.ContentLength);
        Assert.Equal(EnvelopeOf(EnvelopeKind.Failure, 5), await BytesOf(response));
    }

    [Fact]
    public async Task Hands_on_any_other_envelope_and_ends_its_exchange_204_at_once()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();

        foreach (var kind in new[] { EnvelopeKind.Result, (EnvelopeKind)0x80 })
        {
            using var response = await Fetch(PostOf(connectionToken, EnvelopeOf(kind, 2)));

            Assert.Equal(204, (int)response.StatusCode);
        }

        Assert.Equal(
            [(Convert.ToHexString(EnvelopeOf(EnvelopeKind.Result, 2)), connectionHandle), (Convert.ToHexString(EnvelopeOf((EnvelopeKind)0x80, 2)), connectionHandle)],
            _messages.Select((message) =>
            {
                return (Convert.ToHexString(message.Bytes), message.ConnectionHandle);
            }));
    }

    [Fact]
    public async Task Hands_a_request_on_with_its_Authorization_whole_and_any_other_envelope_with_none()
    {
        await Start();

        var (connectionToken, _) = await Connect();
        var taken = new ConcurrentQueue<(EnvelopeKind Kind, string? Credential)>();

        _server.Message += (message, connectionHandle) =>
        {
            var kind = (EnvelopeKind)message.Bytes.Span[1];

            taken.Enqueue((kind, message.Credential));

            if (kind == EnvelopeKind.Request)
            {
                _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false) { Credential = Bearer }, connectionHandle);
            }
        };

        using var answered = await Fetch(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)), ("Authorization", Bearer)));
        using var cancelled = await Fetch(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1)), ("Authorization", Bearer)));

        await BytesOf(answered);

        // an answer carries none
        Assert.Equal((200, (string?)null, 204), ((int)answered.StatusCode, HeaderOf(answered, "Authorization"), (int)cancelled.StatusCode));
        Assert.Equal([(EnvelopeKind.Request, Bearer), (EnvelopeKind.Cancel, null)], taken);
    }

    [Fact]
    public async Task Takes_an_Authorization_as_it_came_its_surrounding_spaces_and_tabs_removed_an_empty_one_carrying_none()
    {
        await Start();

        var (connectionToken, _) = await Connect();
        var taken = new ConcurrentQueue<string?>();

        // each request answered, so its socket may go
        _server.Message += (message, connectionHandle) =>
        {
            taken.Enqueue(message.Credential);
            _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, BinaryPrimitives.ReadUInt32BigEndian(message.Bytes.Span[4..])), false), connectionHandle);
        };

        foreach (var (callId, field) in new (uint CallId, string Field)[]
        {
            (1, "Authorization: \tBearer  mF_9.B5f-4.1JqM \t\r\n"),
            (3, "Authorization: basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\r\n"),
            (5, "Authorization:\r\n"),
            (7, "Authorization: \t \r\n"),
            (9, ""),
        })
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(connectionToken, $"{field}Content-Length: 8"));
            await wire.Write(EnvelopeOf(EnvelopeKind.Request, callId));

            Assert.Equal(200, (await wire.Read()).Head.Status);
        }

        Assert.Equal(["Bearer  mF_9.B5f-4.1JqM", "basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", null, null, null], taken);
    }

    [Fact]
    public async Task Refuses_a_POST_with_two_Authorization_fields_400_malformed_before_reading_its_body_and_hands_the_router_nothing()
    {
        await Start();

        var (connectionToken, _) = await Connect();

        async Task<(int Status, string? Reason, string? Connection)> TwiceOf(string second)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(connectionToken, $"Authorization: {Bearer}\r\nAuthorization: {second}\r\nContent-Length: 8"));
            await wire.Write(EnvelopeOf(EnvelopeKind.Request, 1));

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection"));
        }

        Assert.Equal(
            [(400, HttpRefusals.Malformed, "close"), (400, HttpRefusals.Malformed, "close")],
            [await TwiceOf(Bearer), await TwiceOf("")]);
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Ends_the_exchange_a_cancel_names_empty_and_drops_a_request_its_cancel_came_before()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var head = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1)));

        // its head gone already: a 200 that ends with no body
        Assert.Equal((200, 204), ((int)head.StatusCode, (int)cancel.StatusCode));
        Assert.Empty(await BytesOf(head));

        // its cancel first, then the request: buried, never handed on
        using var early = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 3)));
        using var late = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));

        Assert.Equal((204, 204), ((int)early.StatusCode, (int)late.StatusCode));
        Assert.Equal([EnvelopeKind.Request, EnvelopeKind.Cancel, EnvelopeKind.Cancel], KindsHandedOn());

        // the burial is spent: the call id may come again
        using var again = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));

        Assert.Equal(200, (int)again.StatusCode);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 3), false), connectionHandle).WaitAsync(Patience, Cancelled);
        await BytesOf(again);
    }

    [Fact]
    public async Task Refuses_what_is_not_a_Bead_exchange_with_a_status_of_its_own_marked_and_hands_the_router_nothing()
    {
        await Start(new HttpTransportServerOptions { Origins = ["https://app.example"] });

        var (connectionToken, _) = await Connect();
        var refusals = await Task.WhenAll(
            RefusalOf(new HttpRequestMessage(HttpMethod.Post, new Uri($"{Url}/else"))),
            RefusalOf(new HttpRequestMessage(HttpMethod.Put, Url)),
            RefusalOf(With(PostOf(connectionToken, null), ("origin", "https://elsewhere.example"))),
            RefusalOf(With(PostOf(connectionToken, null), ("content-type", "application/octet-stream"))),
            RefusalOf(With(PostOf(null, null), ("content-type", "text/plain"))),
            RefusalOf(With(PostOf(connectionToken, null), ("content-encoding", "gzip"))),
            RefusalOf(PostOf(null, EnvelopeOf(EnvelopeKind.Request, 1))),
            RefusalOf(PostOf("not-a-token", null)),
            RefusalOf(PostOf(new string('A', 22), null)),
            RefusalOf(new HttpRequestMessage(HttpMethod.Delete, Url)),
            RefusalOf(PostOf(connectionToken, [0xA1, 0x10])),
            RefusalOf(PostOf(connectionToken, [0x20, .. EnvelopeOf(EnvelopeKind.Request, 1)[1..]])),
            RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 2))),
            RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 0))));

        Assert.Equal(
            [
                (404, HttpRefusals.Path),
                (405, HttpRefusals.Method),
                (403, HttpRefusals.Origin),
                (415, HttpRefusals.Type),
                (415, HttpRefusals.Type),
                (415, HttpRefusals.Type),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (404, HttpRefusals.ConnectionUnknown),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
            ],
            refusals);

        using var method = await Fetch(new HttpRequestMessage(HttpMethod.Put, Url));

        Assert.Equal("GET, POST, DELETE", HeaderOf(method, "allow"));

        // its own origin, and one it was told of, pass
        foreach (var origin in new[] { $"http://{Host}:{_port}", "https://app.example" })
        {
            using var response = await Fetch(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1)), ("origin", origin)));

            Assert.Equal(204, (int)response.StatusCode);
        }

        Assert.Equal(2, _messages.Count);
        // the connection stays: a refusal ends its exchange alone
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Refuses_a_request_on_a_call_id_already_waiting_409()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var first = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 7)));
        var again = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 7)));

        Assert.Equal((200, (409, HttpRefusals.CallWaiting)), ((int)first.StatusCode, again));
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 7), false), connectionHandle).WaitAsync(Patience, Cancelled);
        Assert.Equal(EnvelopeOf(EnvelopeKind.Result, 7), await BytesOf(first));
    }

    [Fact]
    public async Task Refuses_a_body_past_its_limit_413_declared_or_counted_and_hands_the_router_nothing()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 64 });

        var (connectionToken, _) = await Connect();
        var declared = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, (1, 57))));
        var chunked = PostOf(connectionToken, [.. EnvelopeOf(EnvelopeKind.Request, (3, 40)), .. new byte[40]]);
        string counted;

        chunked.Headers.TransferEncodingChunked = true;

        try
        {
            counted = (await RefusalOf(chunked)).Status.ToString(CultureInfo.InvariantCulture);
        }
        catch (HttpRequestException)
        {
            counted = "reset";
        }

        Assert.Equal((413, HttpRefusals.TooLarge), declared);
        // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
        Assert.Matches("^(?:413|reset)$", counted);
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Bounds_its_connections_and_those_of_one_address_the_requests_one_waits_on_and_the_bytes_of_body_under_way()
    {
        await Start(new HttpTransportServerOptions
        {
            BodyBytesBudget = 32,
            MaximumConnections = 2,
            MaximumConnectionsPerAddress = 1,
            MaximumWaitingExchanges = 1,
        });

        var (connectionToken, connectionHandle) = await Connect();
        using var response = await Fetch(PostOf(null, null));

        // one address, one connection: busy, and told when to come back
        Assert.Equal((503, "1"), ((int)response.StatusCode, HeaderOf(response, "retry-after")));
        Assert.Equal(HttpRefusals.Busy, HeaderOf(response, HttpTransport.RefusalHeader));

        using var waiting = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        var crowded = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));
        // a cancel takes no place: it is never refused for the requests waiting
        using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 9)));

        Assert.Equal((200, (429, HttpRefusals.Busy), 204), ((int)waiting.StatusCode, crowded, (int)cancel.StatusCode));
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
        await BytesOf(waiting);

        var heavy = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, (5, 32))));

        Assert.Equal((503, HttpRefusals.Busy), heavy);
    }

    [Fact]
    public async Task Closes_a_connection_on_its_DELETE_a_request_handed_on_learns_it_by_its_exchange_cut()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var waiting = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        using var deleted = await Fetch(RequestOf(HttpMethod.Delete, connectionToken));

        Assert.Equal(204, (int)deleted.StatusCode);
        // its head was out: nothing of a 404 can follow, so its body is cut, as a lost one's is
        Assert.Equal("cut", await EndOf(waiting));
        Assert.Equal((true, connectionHandle), _closes.Last());
        Assert.Empty(_server.ConnectionHandles);
        Assert.Empty(_server.Clients);

        var after = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), after);
        // an answer for it goes nowhere
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Closes_a_connection_the_server_closes_cutting_the_exchange_of_a_request_it_handed_on()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var waiting = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

        Assert.True(await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled));
        Assert.Equal("cut", await EndOf(waiting));
        Assert.Single(_messages);
        Assert.Equal((true, connectionHandle), _closes.Last());
    }

    [Fact]
    public async Task Closes_a_connection_the_server_closes_as_the_request_is_handed_on_cutting_its_exchange_after_its_head()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();

        _server.Message += (_, _) =>
        {
            _ = _server.CloseConnection(connectionHandle);
        };

        string answer;

        try
        {
            using var waiting = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

            answer = $"{(int)waiting.StatusCode} {HeaderOf(waiting, "content-type")} {HeaderOf(waiting, "cache-control")} {HeaderOf(waiting, HttpTransport.RefusalHeader) ?? "unmarked"} {await EndOf(waiting)}";
        }
        catch (HttpRequestException reason) when (IsLost(reason))
        {
            answer = "lost";
        }

        // the router had it, which no refusal may deny: a 200 whose body is cut, or, the cut
        // overtaking its head, the exchange lost before any status — never the marked 404 that says
        // nothing was tried
        Assert.Contains(answer, (string[])[$"200 {HttpTransport.MediaType} no-store unmarked cut", "lost"]);
        Assert.Single(_messages);
        Assert.Equal((true, connectionHandle), _closes.Last());
    }

    [Fact]
    public async Task Closes_a_connection_whose_exchange_was_lost_before_its_answer()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();

        using (var wire = await Wire.Open(_port))
        {
            await wire.Write(PostHead(connectionToken, "Content-Length: 8"));
            await wire.Write(EnvelopeOf(EnvelopeKind.Request, 1));

            Assert.Equal(200, (await wire.ReadHead()).Status);
        }

        await Until(() =>
        {
            return !_closes.IsEmpty;
        });

        Assert.Equal([(false, connectionHandle)], _closes);
        // nor does a connection's end show its token: no event, and no client listed
        Assert.DoesNotContain(connectionToken, string.Join(";", _connections), StringComparison.Ordinal);
        Assert.DoesNotContain(connectionToken, string.Join(";", _server.Clients), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Sends_a_connection_that_does_not_listen_its_answers_alone_anything_else_of_the_server_s_own_rejects()
    {
        await Start();

        var (_, connectionHandle) = await Connect();

        foreach (var kind in new[] { EnvelopeKind.Notification, EnvelopeKind.Request, EnvelopeKind.Credit })
        {
            var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return _server.Send(new TransportMessage(EnvelopeOf(kind, 2), false), connectionHandle);
            });

            Assert.StartsWith("this connection does not listen", refused.Message, StringComparison.Ordinal);
        }

        // its kind as the TypeScript side words it, in hexadecimal digits alone
        Assert.Equal("this connection does not listen: an envelope of kind 0x5 goes nowhere", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _server.Send(new TransportMessage(EnvelopeOf((EnvelopeKind)0x05, 2), false), connectionHandle);
        })).Message);

        // what is no envelope: the TypeScript side's string has no counterpart, bytes alone being sent
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return _server.Send(new TransportMessage(new byte[4], false), connectionHandle);
        });
    }

    [Fact]
    public async Task Stops_with_a_client_keeping_its_socket_alive_each_waiting_exchange_cut()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var waiting = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        var body = EndOf(waiting);
        // and one whose body still comes, its prefix unread, which no stop waits on either
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, "Content-Length: 16"));
        await coming.Write([0xA1, 0x10]);
        await Until(() =>
        {
            return Count("bodyBytes") == 2;
        });

        var watch = Stopwatch.StartNew();

        await _server.Stop().WaitAsync(Patience, Cancelled);

        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"{watch.Elapsed}");
        Assert.Equal((false, connectionHandle), _closes.Last());
        Assert.Equal("cut", await body);
        Assert.True(await coming.IsClosed());
        Assert.Equal(ReadyState.Closed, _server.ReadyState);
        // the port is free once it stopped
        Assert.Equal(_port, (await _server.Start(new HttpTransportStartOptions { Address = Host, Port = _port }, Cancelled)).Port);
    }

    [Fact]
    public async Task Answers_each_listen_it_holds_the_marked_404_as_it_stops_however_many()
    {
        await Start();

        var held = new List<Task<HttpResponseMessage>>();

        for (var connection = 0; connection < 32; connection += 1)
        {
            held.Add(ListenOf((await Connect(true)).ConnectionToken, "wait=20000"));
        }

        await Until(() =>
        {
            return Count("listens") == 32;
        });
        await _server.Stop().WaitAsync(Patience, Cancelled);

        foreach (var listen in held)
        {
            Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(listen));
        }
    }

    [Fact]
    public void Refuses_options_it_cannot_hold()
    {
        foreach (var (name, options) in new (string, HttpTransportServerOptions)[]
        {
            ("BodyBytesBudget", new() { BodyBytesBudget = 0 }),
            ("ExchangeTimeout", new() { ExchangeTimeout = TimeSpan.FromMilliseconds(2L << 30) }),
            ("ExchangeTimeout", new() { ExchangeTimeout = TimeSpan.FromMilliseconds(0.5) }),
            ("InactivityTimeout", new() { InactivityTimeout = TimeSpan.Zero }),
            ("InactivityTimeout", new() { InactivityTimeout = TimeSpan.FromMilliseconds(-2) }),
            ("MaximumBodyBytes", new() { MaximumBodyBytes = 0 }),
            ("MaximumConnections", new() { MaximumConnections = -1 }),
            ("MaximumConnectionsPerAddress", new() { MaximumConnectionsPerAddress = 0 }),
            ("MaximumOutboxBytes", new() { MaximumOutboxBytes = 0 }),
            ("MaximumWait", new() { MaximumWait = Timeout.InfiniteTimeSpan }),
            ("MaximumWait", new() { MaximumWait = TimeSpan.FromMilliseconds(0.5) }),
            ("MaximumWaitingExchanges", new() { MaximumWaitingExchanges = int.MinValue }),
        })
        {
            Assert.Equal(name, Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return new HttpTransportServer(options);
            }).ParamName);
        }

        _ = new HttpTransportServer(new HttpTransportServerOptions { ExchangeTimeout = Timeout.InfiniteTimeSpan, InactivityTimeout = Timeout.InfiniteTimeSpan });
        _ = new HttpTransportServer(new HttpTransportServerOptions
        {
            ExchangeTimeout = TimeSpan.FromMilliseconds(1),
            InactivityTimeout = TimeSpan.FromMilliseconds(1),
            MaximumWait = TimeSpan.FromMilliseconds(1),
        });
        Assert.Equal(TimeSpan.FromMinutes(5), new HttpTransportServerOptions().ExchangeTimeout);
    }

    [Fact]
    public void Holds_its_timeouts_and_its_longest_wait_to_a_whole_number_of_milliseconds_rounded_refusing_zero_infinite_for_the_timeouts_alone()
    {
        var options = new (string Option, DurationOutcome Never, Func<TimeSpan, HttpTransportServerOptions> Of)[]
        {
            (nameof(HttpTransportServerOptions.ExchangeTimeout), DurationOutcome.Never, (given) =>
            {
                return new HttpTransportServerOptions { ExchangeTimeout = given };
            }),
            (nameof(HttpTransportServerOptions.InactivityTimeout), DurationOutcome.Never, (given) =>
            {
                return new HttpTransportServerOptions { InactivityTimeout = given };
            }),
            (nameof(HttpTransportServerOptions.MaximumWait), DurationOutcome.Refused, (given) =>
            {
                return new HttpTransportServerOptions { MaximumWait = given };
            }),
        };

        foreach (var (option, never, of) in options)
        {
            foreach (var (given, outcome, _, refusal) in Durations.Of(option, (DurationOutcome.Refused, never)))
            {
                if (outcome == DurationOutcome.Refused)
                {
                    var refused = Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        return new HttpTransportServer(of(given));
                    });

                    Assert.StartsWith(refusal!, refused.Message, StringComparison.Ordinal);
                    Assert.Equal(option, refused.ParamName);
                }
                else
                {
                    _ = new HttpTransportServer(of(given));
                }
            }
        }
    }

    // createHTTPTransportServer, over HTTP/2

    [Fact]
    public async Task Draws_a_connection_pairs_an_answer_takes_a_same_origin_browser_s_exchange_by_its_authority_and_closes_on_a_stream_reset()
    {
        // Kestrel serves HTTP/2 over TLS alone, so the session is a secure one
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        using var http2 = SecureClient();
        using var drew = await Fetch(http2, Over(With(PostOf(SecureUrl, (null, null)), ("origin", $"https://{Host}:{_port}")), HttpVersion.Version20));
        var connectionToken = HeaderOf(drew, HttpTransport.ConnectionTokenHeader);
        var connectionHandle = Assert.Single(_server.ConnectionHandles);

        Assert.Equal((201, HttpVersion.Version20), ((int)drew.StatusCode, drew.Version));

        using var asking = await Fetch(http2, Over(PostOf(SecureUrl, (connectionToken, EnvelopeOf(EnvelopeKind.Request, 1))), HttpVersion.Version20));

        Assert.Equal(200, (int)asking.StatusCode);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
        Assert.Equal(EnvelopeOf(EnvelopeKind.Result, 1), await BytesOf(asking));

        // a request waiting, its stream reset by its client: lost, and its connection with it
        using (var waiting = await Fetch(http2, Over(PostOf(SecureUrl, (connectionToken, EnvelopeOf(EnvelopeKind.Request, 3))), HttpVersion.Version20)))
        {
            Assert.Equal(200, (int)waiting.StatusCode);
        }

        await Until(() =>
        {
            return !_closes.IsEmpty;
        });

        Assert.Equal([(false, connectionHandle)], _closes);
        // an answer after it goes nowhere, and never hangs
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 3), false), connectionHandle).WaitAsync(Patience, Cancelled);
    }

    // createHTTPTransportServer, over TLS

    [Fact]
    public async Task Serves_HTTP_2_and_HTTP_1_1_on_one_port_a_call_over_each_and_closes_its_sessions_as_it_stops()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        // each request answered by its result, as a router would
        _server.Message += (message, connectionHandle) =>
        {
            _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, BinaryPrimitives.ReadUInt32BigEndian(message.Bytes.Span[4..])), false), connectionHandle);
        };

        using var http = SecureClient();
        var calls = new List<(int Drew, int Asked, string Answer, Version Version)>();

        foreach (var (version, callId) in new[] { (HttpVersion.Version20, 1u), (HttpVersion.Version11, 3u) })
        {
            using var drew = await Fetch(http, Over(PostOf(SecureUrl, (null, null)), version));
            using var asked = await Fetch(http, Over(PostOf(SecureUrl, (HeaderOf(drew, HttpTransport.ConnectionTokenHeader), EnvelopeOf(EnvelopeKind.Request, callId))), version));

            calls.Add(((int)drew.StatusCode, (int)asked.StatusCode, Convert.ToHexString(await BytesOf(asked)), asked.Version));
        }

        Assert.Equal(
            [
                (201, 200, Convert.ToHexString(EnvelopeOf(EnvelopeKind.Result, 1)), HttpVersion.Version20),
                (201, 200, Convert.ToHexString(EnvelopeOf(EnvelopeKind.Result, 3)), HttpVersion.Version11),
            ],
            calls);
        Assert.Equal(["type=HTTP;ip=127.0.0.1;ordinal=1", "type=HTTP;ip=127.0.0.1;ordinal=2"], _connections);

        // the HTTP/2 session the client keeps open holds no stop back, and is closed with it
        var watch = Stopwatch.StartNew();

        await _server.Stop().WaitAsync(Patience, Cancelled);

        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"{watch.Elapsed}");
        await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return Fetch(http, Over(PostOf(SecureUrl, (null, null)), HttpVersion.Version20));
        });
    }

    [Fact]
    public async Task Draws_a_connection_over_HTTP_2_before_its_empty_body_ends()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        using var http = SecureClient();
        var ending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var request = Over(PostOf(SecureUrl, (null, null)), HttpVersion.Version20);

        // its head says its body is empty, and its stream ends later: whether a connect has a body is
        // read from its head, never from an end of stream still to come
        request.Content = new LateEmptyContent(ending.Task);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

        try
        {
            using var drew = await Fetch(http, request);

            Assert.Equal((201, HttpVersion.Version20), ((int)drew.StatusCode, drew.Version));
        }
        finally
        {
            ending.TrySetResult();
        }
    }

    // a body that says it is empty and ends only when told: HTTP/2's end of stream comes after its head
    private sealed class LateEmptyContent(Task ending) : HttpContent
    {
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            // the client holds a head back to send it with the body's first bytes: flushed, it goes
            // now, and the stream stays open
            await stream.FlushAsync();
            await ending;
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;

            return true;
        }
    }

    // createHTTPTransportServer, its edges

    [Fact]
    public async Task Listens_on_the_port_it_was_asked_for()
    {
        // the TypeScript side's fake server alone reports no address, errs late and keeps sessions:
        // Kestrel always reports its port, has no error after listening to raise, and shows no
        // HTTP/2 session, which the gauges here do not count
        int port;

        using (var probe = new TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
        }

        await using var server = new HttpTransportServer();

        Assert.Equal(ReadyState.Uninitialized, server.ReadyState);
        Assert.Equal(new TransportServerAddress(Host, port), await server.Start(new HttpTransportStartOptions { Address = Host, Port = port }, Cancelled));
        Assert.Equal(ReadyState.Open, server.ReadyState);
        Assert.DoesNotContain("http2Sessions", server.Gauges().Counts.Keys);
    }

    [Fact]
    public async Task An_error_before_listening_or_an_abort_rejects_the_start_and_closes_what_was_opened()
    {
        await Start();

        await using var failing = new HttpTransportServer();

        await Assert.ThrowsAnyAsync<IOException>(() =>
        {
            return failing.Start(new HttpTransportStartOptions { Address = Host, Port = _port }, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, failing.ReadyState);
        // what it opened is closed: it starts again
        Assert.NotEqual(_port, (await failing.Start(Loopback, Cancelled)).Port);

        await using var aborted = new HttpTransportServer();
        using var source = new CancellationTokenSource();

        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return aborted.Start(Loopback, source.Token);
        });
        Assert.Equal(ReadyState.Closed, aborted.ReadyState);
        Assert.NotEqual(0, (await aborted.Start(Loopback, Cancelled)).Port);
    }

    [Fact]
    public async Task Reads_any_target_without_throwing_a_header_given_twice_by_its_first_and_HTTP_2_s_authority_as_the_host()
    {
        var options = new HttpTransportServerOptions { Hosts = ["bead.example", "bead.example:8443"] };

        await Start(options);

        async Task<(int Status, string? Reason)> StatusOf(string target, string headers)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST {target}\r\n{headers}Content-Length: 0\r\n\r\n");

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        var bead = $"Host: bead.example\r\nContent-Type: {HttpTransport.MediaType}\r\n";
        var statuses = new[]
        {
            await StatusOf("/bead HTTP/1.1", $"Host: bead.example\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Type: text/plain\r\n"),
            await StatusOf("//:99999/bead HTTP/1.1", bead),
            await StatusOf("//[ HTTP/1.1", bead),
            await StatusOf("/bead?after=1 HTTP/1.1", bead),
            await StatusOf("/bead HTTP/1.1", $"{bead}Origin: not an origin\r\n"),
            await StatusOf("/bead HTTP/1.1", $"Host: rebound.example\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("/bead HTTP/1.1", $"Host:\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("/bead HTTP/1.1", "Host: bead.example\r\n"),
            // no host at all, where hosts are listed
            await StatusOf("/bead HTTP/1.0", $"Content-Type: {HttpTransport.MediaType}\r\n"),
            // the root, which is not the path: Kestrel takes no request without a target
            await StatusOf("/ HTTP/1.1", bead),
        };

        Assert.Equal(
            [
                (201, null),
                (404, HttpRefusals.Path),
                (404, HttpRefusals.Path),
                (201, null),
                (403, HttpRefusals.Origin),
                (403, HttpRefusals.Host),
                (403, HttpRefusals.Host),
                (415, HttpRefusals.Type),
                (403, HttpRefusals.Host),
                (404, HttpRefusals.Path),
            ],
            statuses);

        // HTTP/2 names its host by its authority, and a browser's origin matches it
        await Start(options with { Certificate = Certificate.Value });

        using var http2 = SecureClient();
        var request = Over(With(PostOf(SecureUrl, (null, null)), ("origin", "https://bead.example:8443")), HttpVersion.Version20);

        request.Headers.Host = "bead.example:8443";

        using var drew = await Fetch(http2, request);

        Assert.Equal((201, HttpVersion.Version20), ((int)drew.StatusCode, drew.Version));
    }

    [Fact]
    public async Task Takes_a_proxy_s_last_forwarded_address_when_told_to_and_bounds_the_connections_of_each_address()
    {
        await Start(new HttpTransportServerOptions { IsProxyTrusted = true, MaximumConnectionsPerAddress = 1 });

        async Task<(int Status, string ConnectionHandle)> DrawOf(string forwarded, IPAddress from)
        {
            using var wire = await Wire.Open(_port, from);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\nX-Forwarded-For: {forwarded}\r\nContent-Length: 0\r\n\r\n");

            return ((await wire.ReadHead()).Status, _connections.LastOrDefault() ?? "");
        }

        Assert.Equal((201, "type=HTTP;ip=198.51.100.7;ordinal=1"), await DrawOf("203.0.113.9, 198.51.100.7", IPAddress.Loopback));
        // one address, one connection
        Assert.Equal(503, (await DrawOf("198.51.100.7", IPAddress.Loopback)).Status);
        // what is no address is not taken, nor what a peer not on this machine forwards — one of
        // another address than the loopback's own here
        Assert.Equal((201, "type=HTTP;ip=127.0.0.1;ordinal=2"), await DrawOf("evil;ordinal=1", IPAddress.Loopback));
        // nor what only a lenient parse reads as one, as isIP is strict: the loopback's own, which
        // holds its one connection already
        Assert.Equal(503, (await DrawOf("1", IPAddress.Loopback)).Status);
        Assert.Equal((201, "type=HTTP;ip=127.0.0.2;ordinal=3"), await DrawOf("192.0.2.1", Elsewhere));
    }

    [Fact]
    public async Task Puts_a_body_together_from_as_many_pieces_as_it_comes_in_and_hands_on_one_envelope()
    {
        await Start();

        var (connectionToken, _) = await Connect();
        var envelope = EnvelopeOf(EnvelopeKind.Request, (1, 70_000));
        using var wire = await Wire.Open(_port);

        await wire.Write(PostHead(connectionToken, $"Content-Length: {envelope.Length}"));

        foreach (var piece in envelope.Chunk(1_000))
        {
            await wire.Write(piece);
        }

        Assert.Equal(200, (await wire.ReadHead()).Status);
        Assert.Equal(envelope, Assert.Single(_messages).Bytes);
    }

    [Fact]
    public async Task Ends_an_upload_whose_cancel_came_as_it_came_never_handing_it_on_and_one_past_its_limit_reading_no_more_of_it()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 64 });

        var (connectionToken, _) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 40));

        using (var upload = await Wire.Open(_port))
        {
            await upload.Write(PostHead(connectionToken, $"Content-Length: {request.Length}"));
            await upload.Write(request[..16]);
            await Until(() =>
            {
                return Count("waitingExchanges") == 1;
            });

            using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1)));

            await upload.Write(request[16..]);

            Assert.Equal((204, 204), ((int)cancel.StatusCode, (await upload.ReadHead()).Status));
        }

        // cancelled, and still coming past the limit: refused, and read no more — each piece counted
        // though none is kept
        using var endless = await Wire.Open(_port);

        await endless.Write(PostHead(connectionToken, "Transfer-Encoding: chunked"));
        await endless.Write(ChunkOf(request[..16]));
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });

        using (var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1))))
        {
            Assert.Equal(204, (int)cancel.StatusCode);
        }

        await endless.Write(ChunkOf(new byte[40]));
        await Until(() =>
        {
            return Count("bodyBytes") == 56;
        });
        await endless.Write(ChunkOf(new byte[40]));

        var refused = await endless.ReadHead();

        Assert.Equal((413, HttpRefusals.TooLarge, "close"), (refused.Status, refused.Headers[HttpTransport.RefusalHeader], refused.Headers["connection"]));
        Assert.Equal([EnvelopeKind.Cancel, EnvelopeKind.Cancel], KindsHandedOn());
    }

    [Fact]
    public async Task Lets_a_burial_lapse_buries_only_the_client_s_call_ids_and_so_many_of_them_and_answers_a_body_still_coming_as_its_connection_closes()
    {
        await Start(new HttpTransportServerOptions { MaximumWaitingExchanges = 2 });

        var (connectionToken, connectionHandle) = await Connect();

        async Task CancelOf(uint callId)
        {
            using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, callId)));

            Assert.Equal(204, (int)cancel.StatusCode);
        }

        // a cancel before its request, whose burial lapses: the request that comes after goes on
        await CancelOf(5);

        Assert.Equal(1, Count("buriedCallIds"));
        Assert.Single(_time.Armed, (armed) =>
        {
            return armed.Delay == Burial;
        });
        _time.Advance(Burial);
        Assert.Equal(0, Count("buriedCallIds"));

        // an even call id is no client's, and two burials are all a connection holds here
        foreach (var callId in new uint[] { 2, 7, 9, 11 })
        {
            await CancelOf(callId);
        }

        Assert.Equal(2, Count("buriedCallIds"));
        Assert.Equal(3, _time.Armed.Count((armed) =>
        {
            return armed.Delay == Burial;
        }));

        using var late = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 5)));

        Assert.Equal(200, (int)late.StatusCode);

        // a cancel still coming as its connection closes learns the connection is gone
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, "Content-Length: 16"));
        await coming.Write(EnvelopeOf(EnvelopeKind.Cancel, 13));
        await Until(() =>
        {
            return Count("bodyBytes") == 8;
        });
        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);
        await coming.Write(new byte[8]);

        var gone = await coming.ReadHead();

        Assert.Equal("cut", await EndOf(late));
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), (gone.Status, gone.Headers[HttpTransport.RefusalHeader]));
        Assert.Equal([(true, connectionHandle)], _closes);
    }

    [Fact]
    public async Task Closes_as_lost_a_connection_whose_request_waited_past_its_timeout_and_one_idle_past_its_own_never_while_an_exchange_is_under_way()
    {
        await Start(new HttpTransportServerOptions { ExchangeTimeout = TimeSpan.FromSeconds(1), InactivityTimeout = TimeSpan.FromSeconds(2) });

        var unanswered = await Connect();

        _time.Advance(TimeSpan.FromSeconds(1.5));

        var idle = await Connect();
        using var asking = await Fetch(PostOf(unanswered.ConnectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

        // one idle timer per connection as drawn; the one asking lost its own as its exchange came
        Assert.Equal([TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(1)], DelaysSince(0));
        Assert.True(_time.Armed[0].IsCleared);

        // past the first's rest, which its exchange stopped: nothing closes
        _time.Advance(TimeSpan.FromSeconds(0.6));

        Assert.Empty(_closes);

        _time.Advance(TimeSpan.FromSeconds(0.4));

        Assert.Equal("cut", await EndOf(asking));

        _time.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal([(false, unanswered.ConnectionHandle), (false, idle.ConnectionHandle)], _closes);
    }

    [Fact]
    public async Task Keeps_a_connection_whose_refused_exchange_lost_its_socket_and_closes_one_whose_answer_could_not_be_written()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();

        using (var refused = await Wire.Open(_port))
        {
            await refused.Write(PostHead(connectionToken, "Content-Length: 8"));
            await refused.Write(EnvelopeOf(EnvelopeKind.Request, 2));

            Assert.Equal(400, (await refused.ReadHead()).Status);
            refused.Reset();
        }

        // an answer too large to be taken by a client that reads nothing, which then goes: as it is
        // sent, or once its writing is under way — which Kestrel drops without a word, or throws on
        foreach (var (callId, isUnderWay) in new[] { (1u, false), (3u, true) })
        {
            using var asking = await Wire.Open(_port);

            await asking.Write(PostHead(connectionToken, "Content-Length: 8"));
            await asking.Write(EnvelopeOf(EnvelopeKind.Request, callId));

            Assert.Equal(200, (await asking.ReadHead()).Status);

            var sending = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, (callId, 64 << 20)), false), connectionHandle);

            Assert.True(!isUnderWay || await asking.ReadSome() > 0);
            asking.Reset();

            Assert.Equal("the exchange closed before its answer went out", (await Assert.ThrowsAsync<IOException>(() =>
            {
                return sending.WaitAsync(Patience, Cancelled);
            })).Message);
        }

        Assert.Empty(_closes);

        // a request that failed as it came lets go of what it held, and its connection is lost
        using (var broken = await Wire.Open(_port))
        {
            await broken.Write(PostHead(connectionToken, "Content-Length: 16"));
            await broken.Write(EnvelopeOf(EnvelopeKind.Request, 3));
            await Until(() =>
            {
                return Count("bodyBytes") == 8;
            });
            broken.Reset();
        }

        await Until(() =>
        {
            return !_closes.IsEmpty && Count("bodyBytes") == 0;
        });

        Assert.Equal([(false, connectionHandle)], _closes);
    }

    [Fact]
    public async Task Bounds_the_exchanges_under_way_on_one_connection_bodies_still_coming_included_and_closes_it_once_however_many_it_loses_after()
    {
        await Start(new HttpTransportServerOptions { MaximumWaitingExchanges = 1 });

        var (connectionToken, connectionHandle) = await Connect();

        // two bodies still coming, their prefix unread: under way, waiting for nothing yet
        using var first = await Wire.Open(_port);
        using var second = await Wire.Open(_port);

        foreach (var wire in new[] { first, second })
        {
            await wire.Write(PostHead(connectionToken, "Content-Length: 8"));
            await wire.Write([0xA1]);
        }

        await Until(() =>
        {
            return Count("bodyBytes") == 2;
        });

        Assert.Equal((429, HttpRefusals.Busy), await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1))));

        // closed, then each body's socket gone: the connection closes once
        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);
        first.Reset();
        second.Reset();
        await Until(() =>
        {
            return Count("bodyBytes") == 0;
        });

        Assert.Equal([(true, connectionHandle)], _closes);
    }

    [Fact]
    public async Task Closes_the_socket_behind_a_refusal_of_a_body_it_will_not_read_over_HTTP_1_alone()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        using var http = SecureClient();

        async Task<HttpResponseHeaders> HeadersOf(HttpRequestMessage request, Version version)
        {
            using var response = await Fetch(http, Over(request, version));

            return response.Headers;
        }

        HttpRequestMessage Plain(bool isChunked)
        {
            var request = With(PostOf(SecureUrl, (null, new byte[8])), ("content-type", "text/plain"));

            request.Headers.TransferEncodingChunked = isChunked;

            return request;
        }

        // a 400 is a refusal too
        var malformed = await HeadersOf(PostOf(SecureUrl, ("not-a-token", new byte[8])), HttpVersion.Version11);

        Assert.True((await HeadersOf(Plain(false), HttpVersion.Version11)).ConnectionClose);
        Assert.Null((await HeadersOf(Plain(false), HttpVersion.Version20)).ConnectionClose);
        // a body of no declared length, chunked, is a body all the same
        Assert.True((await HeadersOf(Plain(true), HttpVersion.Version11)).ConnectionClose);
        Assert.Equal((HttpRefusals.Malformed, true), (malformed.GetValues(HttpTransport.RefusalHeader).Single(), malformed.ConnectionClose));
    }

    [Fact]
    public async Task Reads_a_body_up_to_its_limit_exactly_declared_or_counted_refuses_one_declared_past_it_before_any_of_it_and_gives_back_the_bytes_each_held()
    {
        await Start(new HttpTransportServerOptions { BodyBytesBudget = 24, MaximumBodyBytes = 16 });

        var (connectionToken, _) = await Connect();
        using var declared = await Wire.Open(_port);
        using var past = await Wire.Open(_port);

        await declared.Write(PostHead(connectionToken, "Content-Length: 16"));
        await past.Write(PostHead(connectionToken, "Content-Length: 17"));

        // the one past its limit is refused as it comes; the one at it waits for its body
        Assert.Equal(413, (await past.ReadHead()).Status);

        await declared.Write(EnvelopeOf(EnvelopeKind.Request, (1, 8)));

        // counted, with no length declared: its 16 bytes, once the first 16 were given back
        using var counted = await Wire.Open(_port);

        await counted.Write(PostHead(connectionToken, "Transfer-Encoding: chunked"));
        await counted.Write([.. ChunkOf(EnvelopeOf(EnvelopeKind.Request, 3)), .. ChunkOf(new byte[8]), .. "0\r\n\r\n"u8]);

        Assert.Equal((200, 200), ((await declared.ReadHead()).Status, (await counted.ReadHead()).Status));
        Assert.Equal(2, _messages.Count);

        // up to the budget exactly, across exchanges: 8 bytes held, and 16 more
        using var holding = await Wire.Open(_port);
        using var filling = await Wire.Open(_port);

        await holding.Write(PostHead(connectionToken, "Content-Length: 16"));
        await holding.Write(EnvelopeOf(EnvelopeKind.Request, 5));
        await Until(() =>
        {
            return Count("bodyBytes") == 8;
        });
        await filling.Write(PostHead(connectionToken, "Content-Length: 16"));
        await filling.Write(EnvelopeOf(EnvelopeKind.Request, (7, 8)));

        Assert.Equal(200, (await filling.ReadHead()).Status);
    }

    [Fact]
    public async Task Bounds_its_connections_all_together_whichever_address_each_comes_from()
    {
        await Start(new HttpTransportServerOptions { MaximumConnections = 1 });
        await Connect();

        using var wire = await Wire.Open(_port, Elsewhere);

        await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

        var head = await wire.ReadHead();

        Assert.Equal((503, HttpRefusals.Busy), (head.Status, head.Headers[HttpTransport.RefusalHeader]));
    }

    [Fact]
    public async Task Buries_the_client_s_call_ids_alone_a_cancel_of_the_server_s_takes_no_place()
    {
        await Start(new HttpTransportServerOptions { MaximumWaitingExchanges = 1 });

        var (connectionToken, _) = await Connect();
        var statuses = new List<int>();

        foreach (var envelope in new[] { EnvelopeOf(EnvelopeKind.Cancel, 2), EnvelopeOf(EnvelopeKind.Cancel, 3), EnvelopeOf(EnvelopeKind.Request, 3) })
        {
            using var response = await Fetch(PostOf(connectionToken, envelope));

            statuses.Add((int)response.StatusCode);
        }

        // its cancel came first: dropped
        Assert.Equal([204, 204, 204], statuses);
        // the two cancels, handed on; the request, never
        Assert.Equal(2, _messages.Count);
    }

    [Fact]
    public async Task Ends_a_request_whose_connection_closes_as_its_body_comes_with_the_marked_404_its_head_not_out_yet()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var envelope = EnvelopeOf(EnvelopeKind.Request, (1, 8));
        using var coming = await Wire.Open(_port);

        // its prefix read: it waits under its call id, its body not whole
        await coming.Write(PostHead(connectionToken, $"Content-Length: {envelope.Length}"));
        await coming.Write(envelope[..12]);
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });
        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);

        var gone = await coming.ReadHead();

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), (gone.Status, gone.Headers[HttpTransport.RefusalHeader]));
        Assert.Empty(await coming.ReadBody(gone));

        // the rest of it changes nothing
        try
        {
            await coming.Write(envelope[12..]);
        }
        catch (IOException)
        {
            // the server may have closed the socket behind its refusal
        }

        Assert.True(await coming.IsClosed());
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Rests_a_connection_once_none_of_its_exchanges_is_under_way_and_arms_no_timer_that_is_Infinity()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var (connectionToken, connectionHandle) = await Connect();
        using var first = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        using var second = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));
        var before = _time.Armed.Count;

        // one answered, the other still waiting: no rest yet
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
        await BytesOf(first);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 3), false), connectionHandle).WaitAsync(Patience, Cancelled);
        await BytesOf(second);
        await Until(() =>
        {
            return _time.Armed.Count > before;
        });

        Assert.Equal([TimeSpan.FromSeconds(2)], DelaysSince(before));

        // a request waits for its answer for ever, and a connection rests for ever: no timer
        await Start(new HttpTransportServerOptions { ExchangeTimeout = Timeout.InfiniteTimeSpan, InactivityTimeout = Timeout.InfiniteTimeSpan });
        before = _time.Armed.Count;

        var forever = await Connect();
        using var asking = await Fetch(PostOf(forever.ConnectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

        Assert.Equal(200, (int)asking.StatusCode);
        Assert.Empty(DelaysSince(before));
    }

    [Fact]
    public async Task Keeps_the_socket_of_an_exchange_whose_connection_closed_as_its_body_came_read_whole_and_closes_the_one_of_a_refusal_whose_body_goes_unread()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, "Content-Length: 16"));
        await coming.Write(EnvelopeOf(EnvelopeKind.Cancel, 3));
        await Until(() =>
        {
            return Count("bodyBytes") == 8;
        });
        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);
        await coming.Write(new byte[8]);

        var gone = await coming.ReadHead();

        // what comes after on its token, a body it will not read
        using var after = await Wire.Open(_port);

        await after.Write(PostHead(connectionToken, "Content-Length: 8"));
        await after.Write(EnvelopeOf(EnvelopeKind.Request, 1));

        var refused = await after.ReadHead();

        Assert.Equal(
            new (int, string?, string?)[] { (404, HttpRefusals.ConnectionUnknown, null), (404, HttpRefusals.ConnectionUnknown, "close") },
            new[] { gone, refused }.Select((head) =>
            {
                return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection"));
            }));

        // the socket kept serves the next exchange; the other is closed
        await coming.Write($"GET /else HTTP/1.1\r\nHost: {Host}\r\n\r\n");

        Assert.Equal(404, (await coming.ReadHead()).Status);
        Assert.True(await after.IsClosed());
    }

    [Fact]
    public async Task Answers_a_request_an_answer_comes_for_as_its_body_still_comes_at_once_never_handing_it_on()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 8));
        var answer = EnvelopeOf(EnvelopeKind.Result, 1);
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, $"Content-Length: {request.Length}"));
        await coming.Write(request[..12]);
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });
        await _server.Send(new TransportMessage(answer, false), connectionHandle).WaitAsync(Patience, Cancelled);

        var (head, body) = await coming.Read();

        Assert.Equal((200, Convert.ToHexString(answer)), (head.Status, Convert.ToHexString(body)));

        // the rest of it changes nothing: it is never handed on, and its socket, its body not read
        // on, closes behind its answer
        try
        {
            await coming.Write(request[12..]);
        }
        catch (IOException)
        {
            // the server may have closed the socket already
        }

        Assert.True(await coming.IsClosed());
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Tells_a_header_given_empty_from_one_absent_an_empty_token_is_malformed_an_empty_origin_or_encoding_refused_an_empty_listen_none()
    {
        await Start();

        var (connectionToken, _) = await Connect();

        async Task<(int Status, string? Reason)> StatusOf(string headers)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\n{headers}\r\nContent-Length: 0\r\n\r\n");

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        Assert.Equal(
            [(400, HttpRefusals.Malformed), (403, HttpRefusals.Origin), (415, HttpRefusals.Type), (400, HttpRefusals.Malformed)],
            [
                await StatusOf($"{HttpTransport.ConnectionTokenHeader}:"),
                await StatusOf("Origin:"),
                await StatusOf($"{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\nContent-Encoding:"),
                await StatusOf($"{HttpTransport.ListenHeader}:"),
            ]);
    }

    // createHTTPTransportServer, listening

    [Fact]
    public async Task Brings_back_what_the_server_sent_of_its_own_in_order_and_numbered_again_until_a_listen_acknowledges_it()
    {
        await Start();

        using var drawn = await Fetch(With(PostOf(null, null), (HttpTransport.ListenHeader, "?1")));
        var connectionToken = HeaderOf(drawn, HttpTransport.ConnectionTokenHeader) ?? "";
        var connectionHandle = _connections.Last();
        var first = EnvelopeOf(EnvelopeKind.Notification, 1);
        var second = EnvelopeOf(EnvelopeKind.Request, (2, 3));

        // the listen taken, said back
        Assert.Equal(("?1", true), (HeaderOf(drawn, HttpTransport.ListenHeader), _server.IsTwoWay(connectionHandle)));
        await _server.Send(new TransportMessage(first, false), connectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(second, false), connectionHandle).WaitAsync(Patience, Cancelled);

        using var brought = await ListenOf(connectionToken, "after=0&wait=0");

        Assert.Equal(
            (200, HttpTransport.BatchMediaType, "1", "no-store"),
            ((int)brought.StatusCode, brought.Content.Headers.ContentType?.MediaType, HeaderOf(brought, HttpTransport.SequenceHeader), HeaderOf(brought, "cache-control")));
        Assert.Equal(BatchOf(first, second), await BytesOf(brought));

        // not acknowledged: brought back again
        using var again = await ListenOf(connectionToken, "after=0");

        Assert.Equal(BatchOf(first, second), await BytesOf(again));

        // acknowledged: gone, and nothing left
        using var empty = await ListenOf(connectionToken, "after=2&wait=0");

        Assert.Equal((204, 0), ((int)empty.StatusCode, (await BytesOf(empty)).Length));
    }

    [Fact]
    public async Task Holds_a_listen_until_something_comes_within_its_wait_no_longer_than_its_limit_and_ends_it_empty_past_it()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan, MaximumWait = TimeSpan.FromSeconds(1) });

        var (connectionToken, connectionHandle) = await Connect(true);
        var lapsing = ListenOf(connectionToken, "wait=60000");

        // waiting, as long as the server lets it
        await Until(() =>
        {
            return Count("listens") == 1;
        });

        Assert.Equal([TimeSpan.FromSeconds(1)], DelaysSince(0));

        _time.Advance(TimeSpan.FromMilliseconds(999));

        Assert.Equal(1, Count("listens"));

        _time.Advance(TimeSpan.FromMilliseconds(1));

        using (var lapsed = await lapsing)
        {
            Assert.Equal(204, (int)lapsed.StatusCode);
        }

        var held = ListenOf(connectionToken, "after=0&wait=500");
        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);

        await Until(() =>
        {
            return Count("listens") == 1;
        });
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        using var brought = await held;

        Assert.Equal(
            (200, "1", Convert.ToHexString(BatchOf(envelope))),
            ((int)brought.StatusCode, HeaderOf(brought, HttpTransport.SequenceHeader), Convert.ToHexString(await BytesOf(brought))));
        // its timer, of its own wait, went with it
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(500)], DelaysSince(0));
        Assert.True(_time.Armed[1].IsCleared);
    }

    [Fact]
    public async Task Lets_a_second_listen_take_the_place_of_the_first_which_ends_empty_a_listen_lost_closes_nothing_and_what_it_carried_comes_again()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);
        var first = ListenOf(connectionToken, "wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1;
        });

        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);

        // the second, on a socket of its own: what it brings back goes nowhere, and is brought back
        // to the next
        using (var second = await Wire.Open(_port))
        {
            await second.Write($"GET /bead?wait=20000 HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n\r\n");

            using var ended = await first;

            Assert.Equal((204, 1), ((int)ended.StatusCode, Count("listens")));
            await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);
            second.Reset();
        }

        using var third = await ListenOf(connectionToken, "after=0&wait=0");

        Assert.Equal((200, Convert.ToHexString(BatchOf(envelope))), ((int)third.StatusCode, Convert.ToHexString(await BytesOf(third))));

        // a listen held, lost: what comes next waits for the one after it
        using (var dropped = await Wire.Open(_port))
        {
            await dropped.Write($"GET /bead?after=1&wait=20000 HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n\r\n");
            await Until(() =>
            {
                return Count("listens") == 1;
            });
            dropped.Reset();
        }

        await Until(() =>
        {
            return Count("listens") == 0;
        });
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        using var next = await ListenOf(connectionToken, "after=1&wait=0");

        Assert.Equal((200, "2"), ((int)next.StatusCode, HeaderOf(next, HttpTransport.SequenceHeader)));
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Brings_back_all_that_waits_in_one_batch_however_large_numbered_from_its_first()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 32 });

        var (connectionToken, connectionHandle) = await Connect(true);
        int[] extras = [8, 8, 32];
        var envelopes = extras.Select((extra, index) =>
        {
            return EnvelopeOf(EnvelopeKind.Notification, ((uint)(2 * index) + 1, extra));
        }).ToArray();

        foreach (var envelope in envelopes)
        {
            await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);
        }

        // past the body limit together, and one alone: a batch is read as it comes, each bounded alone
        using var all = await ListenOf(connectionToken, "wait=0");
        using var rest = await ListenOf(connectionToken, "after=1&wait=0");

        Assert.Equal(
            (("1", Convert.ToHexString(BatchOf(envelopes))), ("2", Convert.ToHexString(BatchOf(envelopes[1..]))), 4L + 16 + 4 + 40),
            ((HeaderOf(all, HttpTransport.SequenceHeader), Convert.ToHexString(await BytesOf(all))), (HeaderOf(rest, HttpTransport.SequenceHeader), Convert.ToHexString(await BytesOf(rest))), rest.Content.Headers.ContentLength));
    }

    [Fact]
    public async Task Keeps_for_a_listen_an_answer_whose_exchange_ended_and_anything_else_the_server_sends_one_that_does_not_listen_drops_the_one_and_rejects_the_other()
    {
        await Start();

        var listening = await Connect(true);
        var deaf = await Connect();
        var late = EnvelopeOf(EnvelopeKind.Result, 1);
        var command = EnvelopeOf(EnvelopeKind.Request, 2);

        await _server.Send(new TransportMessage(late, false), listening.ConnectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(command, false), listening.ConnectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(late, false), deaf.ConnectionHandle).WaitAsync(Patience, Cancelled);
        Assert.Equal("this connection does not listen: an envelope of kind 0x10 goes nowhere", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _server.Send(new TransportMessage(command, false), deaf.ConnectionHandle);
        })).Message);

        using var response = await ListenOf(listening.ConnectionToken, "wait=0");

        Assert.Equal(BatchOf(late, command), await BytesOf(response));
        Assert.Equal(
            (true, false, false),
            (_server.IsTwoWay(listening.ConnectionHandle), _server.IsTwoWay(deaf.ConnectionHandle), _server.IsTwoWay("type=HTTP;ip=127.0.0.1;ordinal=99")));
    }

    [Fact]
    public async Task Refuses_a_listen_where_none_was_declared_409_and_one_that_asks_what_it_cannot_400_a_connect_that_says_it_listens_in_any_other_way()
    {
        await Start();

        var listening = await Connect(true);
        var deaf = await Connect();
        var withBody = With(new HttpRequestMessage(HttpMethod.Get, Url) { Content = new ByteArrayContent(new byte[8]) }, (HttpTransport.ConnectionTokenHeader, listening.ConnectionToken));

        Assert.Equal(
            [
                (409, HttpRefusals.ListenUndeclared),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
            ],
            [
                await RefusalOf(ListenOf(deaf.ConnectionToken, "")),
                await RefusalOf(withBody),
                await RefusalOf(ListenOf(listening.ConnectionToken, "after=one")),
                await RefusalOf(ListenOf(listening.ConnectionToken, "wait=-1")),
                await RefusalOf(ListenOf(listening.ConnectionToken, "after=1")),
                await RefusalOf(With(PostOf(null, null), (HttpTransport.ListenHeader, "yes"))),
                await RefusalOf(new HttpRequestMessage(HttpMethod.Get, Url)),
            ]);

        // `?0` says it does not
        using var declined = await Fetch(With(PostOf(null, null), (HttpTransport.ListenHeader, "?0")));

        Assert.Equal((201, null), ((int)declined.StatusCode, HeaderOf(declined, HttpTransport.ListenHeader)));
        Assert.False(_server.IsTwoWay(_connections.Last()));
    }

    [Fact]
    public async Task Stamps_a_connection_s_activity_as_an_exchange_of_an_envelope_or_a_listen_begins_never_at_its_connect_nor_at_a_listen_refused()
    {
        await Start();

        var deaf = await Connect();
        var listening = await Connect(true);

        Assert.Equal((409, HttpRefusals.ListenUndeclared), await RefusalOf(ListenOf(deaf.ConnectionToken, "")));
        Assert.Equal([null, null], StampsOf());

        // an envelope's, as its exchange begins: not as its body ends
        _time.Advance(TimeSpan.FromSeconds(1));

        var begun = _time.GetUtcNow();

        using (var wire = await Wire.Open(_port))
        {
            await wire.Write(PostHead(listening.ConnectionToken, "Content-Length: 8"));
            await Until(() =>
            {
                return StampsOf()[1] is not null;
            });
            _time.Advance(TimeSpan.FromSeconds(1));
            await wire.Write(EnvelopeOf(EnvelopeKind.Result, 2));

            Assert.Equal(204, (await wire.ReadHead()).Status);
        }

        Assert.Equal([null, begun], StampsOf());

        // a listen's, as it is held
        _time.Advance(TimeSpan.FromSeconds(1));

        using var listened = await ListenOf(listening.ConnectionToken, "wait=0");

        Assert.Equal([null, _time.GetUtcNow()], StampsOf());
    }

    // the TypeScript side tells the second before the first ends; here each ends on its own request's
    // thread, so the two come in either order, which a server's count of listens takes alike
    [Fact]
    public async Task Tells_a_listen_held_once_past_its_refusals_and_its_end_while_its_connection_stands_one_refused_tells_nothing_and_restarts_nothing_and_a_second_and_the_first_it_replaces_each_tell_theirs()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var told = new ConcurrentQueue<(bool IsHeld, string ConnectionHandle)>();

        _server.Listen += (isHeld, connectionHandle) =>
        {
            told.Enqueue((isHeld, connectionHandle));
        };

        var deaf = await Connect();
        var (connectionToken, connectionHandle) = await Connect(true);
        var before = _time.Armed.Count;

        // undeclared, 409, and asking what it cannot, 400: no timer stopped nor armed
        Assert.Equal(
            [(409, HttpRefusals.ListenUndeclared), (400, HttpRefusals.Malformed), (400, HttpRefusals.Malformed)],
            [
                await RefusalOf(ListenOf(deaf.ConnectionToken, "")),
                await RefusalOf(ListenOf(connectionToken, "wait=soon")),
                await RefusalOf(ListenOf(connectionToken, "after=1")),
            ]);
        Assert.Empty(told);
        Assert.Empty(DelaysSince(before));
        Assert.All(_time.Armed, (armed) =>
        {
            Assert.False(armed.IsCleared);
        });

        // a second in the place of the first, which ends empty: each tells its own
        var first = ListenOf(connectionToken, "wait=20000");

        await Until(() =>
        {
            return !told.IsEmpty;
        });

        var second = ListenOf(connectionToken, "wait=20000");

        using (var ended = await first)
        {
            Assert.Equal(204, (int)ended.StatusCode);
        }

        await Until(() =>
        {
            return told.Count == 3;
        });
        Assert.Equal(
            [(false, connectionHandle), (true, connectionHandle), (true, connectionHandle)],
            told.Order());

        // its connection closed: the listen it held ends untold
        Assert.True(await _server.CloseConnection(connectionHandle));

        using (var gone = await second)
        {
            Assert.Equal(404, (int)gone.StatusCode);
        }

        Assert.Equal(3, told.Count);
    }

    [Fact]
    public async Task Closes_a_connection_whose_outbox_holds_more_than_its_bound_and_its_listen_learns_it_is_gone()
    {
        await Start(new HttpTransportServerOptions { MaximumOutboxBytes = 20 });

        var (connectionToken, connectionHandle) = await Connect(true);
        var envelope = EnvelopeOf(EnvelopeKind.Notification, (1, 2));

        // 10 bytes, then 20: held
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Empty(_closes);

        // acknowledged, 10 bytes again; then 30: past it
        using (var acknowledged = await ListenOf(connectionToken, "after=2&wait=0"))
        {
            Assert.Equal(204, (int)acknowledged.StatusCode);
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        var held = ListenOf(connectionToken, "after=3&wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1;
        });
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        using (var brought = await held)
        {
            Assert.Equal(200, (int)brought.StatusCode);
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal([(false, connectionHandle)], _closes);

        // a listen held as its connection closes learns it is gone
        var other = await Connect(true);
        var waiting = RefusalOf(ListenOf(other.ConnectionToken, "wait=20000"));

        await Until(() =>
        {
            return Count("listens") == 1;
        });
        await _server.CloseConnection(other.ConnectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await waiting);
        Assert.Equal((2L * LimitDefaults.MaximumEnvelopeBytes, TimeSpan.FromSeconds(30)), (new HttpTransportServerOptions().MaximumOutboxBytes, new HttpTransportServerOptions().MaximumWait));
    }

    [Fact]
    public async Task Answers_a_listen_held_once_what_comes_after_or_its_wait_running_out_before_its_response_closes_waits_for_the_next()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan });

        var (connectionToken, connectionHandle) = await Connect(true);
        var held = ListenOf(connectionToken, "wait=20000");
        var first = EnvelopeOf(EnvelopeKind.Notification, 1);
        var second = EnvelopeOf(EnvelopeKind.Notification, 3);
        var third = EnvelopeOf(EnvelopeKind.Notification, 5);
        var changing = third.ToArray();

        await Until(() =>
        {
            return Count("listens") == 1;
        });
        await _server.Send(new TransportMessage(first, false), connectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(second, false), connectionHandle).WaitAsync(Patience, Cancelled);
        // its wait running out after it was answered changes nothing
        _time.Advance(TimeSpan.FromSeconds(20));

        using (var brought = await held)
        {
            Assert.Equal(BatchOf(first), await BytesOf(brought));
        }

        Assert.True(_time.Armed[0].IsCleared);

        // what waits is a copy: changed after its send, it goes as it was
        await _server.Send(new TransportMessage(changing, false), connectionHandle).WaitAsync(Patience, Cancelled);
        Array.Clear(changing);

        using var next = await ListenOf(connectionToken, "after=1&wait=0");

        Assert.Equal(BatchOf(second, third), await BytesOf(next));
    }

    [Fact]
    public async Task Ends_a_listen_asked_not_to_wait_at_once_with_nothing_arming_no_timer()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan });

        var (connectionToken, _) = await Connect(true);
        using var response = await ListenOf(connectionToken, "wait=0");

        Assert.Equal(204, (int)response.StatusCode);
        Assert.Empty(_time.Armed);
    }

    [Fact]
    public async Task Keeps_a_notification_for_a_listen_even_on_the_call_id_of_a_request_still_waiting_which_it_never_answers()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);
        using var asking = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        var notification = EnvelopeOf(EnvelopeKind.Notification, 1);

        await _server.Send(new TransportMessage(notification, false), connectionHandle).WaitAsync(Patience, Cancelled);

        using var response = await ListenOf(connectionToken, "wait=0");

        Assert.Equal(BatchOf(notification), await BytesOf(response));
        Assert.Equal((200, 1), ((int)asking.StatusCode, Count("waitingExchanges")));
    }

    [Fact]
    public async Task Does_not_rest_a_connection_whose_listen_is_held_when_another_of_its_exchanges_ends()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var (connectionToken, _) = await Connect(true);
        var held = ListenOf(connectionToken, "wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1;
        });

        var before = _time.Armed.Count;
        using var wire = await Wire.Open(_port);

        // a cancel, handed on and ended at once: the listen still holds the connection awake
        await wire.Write(PostHead(connectionToken, "Content-Length: 8"));
        await wire.Write(EnvelopeOf(EnvelopeKind.Cancel, 1));

        var cancel = (await wire.Read()).Head;

        // a second exchange on the same socket, which Kestrel takes once the first ended whole
        await wire.Write($"GET /else HTTP/1.1\r\nHost: {Host}\r\n\r\n");
        await wire.Read();

        Assert.Equal(204, cancel.Status);
        Assert.Equal([Burial], DelaysSince(before));
        Assert.False(held.IsCompleted);
    }

    [Fact]
    public async Task Counts_a_listen_held_as_an_exchange_under_way_its_connection_does_not_rest_while_it_waits()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var (connectionToken, connectionHandle) = await Connect(true);
        var before = _time.Armed.Count;
        var held = ListenOf(connectionToken, "wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1;
        });

        // its wait alone, no rest
        Assert.Equal([TimeSpan.FromSeconds(20)], DelaysSince(before));

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);

        using var brought = await held;

        await Until(() =>
        {
            return _time.Armed.Count > before + 1;
        });

        // answered: the connection rests
        Assert.Equal(200, (int)brought.StatusCode);
        Assert.Equal([TimeSpan.FromSeconds(20), TimeSpan.FromSeconds(2)], DelaysSince(before));
    }

    [Fact]
    public async Task Counts_what_it_keeps_of_its_connections_at_the_ceilings_it_has()
    {
        await Start(new HttpTransportServerOptions { MaximumOutboxBytes = 64 });

        var listening = await Connect(true);
        var queued = await Connect(true);
        var other = await ConnectFrom(Elsewhere, false);
        var smaller = await Connect(true);

        // a request waiting, a cancel before its request, a body still coming, a listen held, and an
        // outbox of two envelopes
        using var asking = await Fetch(PostOf(other.ConnectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        using var cancelling = await Fetch(PostOf(other.ConnectionToken, EnvelopeOf(EnvelopeKind.Cancel, 3)));
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(other.ConnectionToken, "Content-Length: 8"));
        await coming.Write([0xA1, 0x10, 0, 0]);

        var held = ListenOf(listening.ConnectionToken, "wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1 && Count("bodyBytes") == 4;
        });
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 1), false), queued.ConnectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, (3, 4)), false), queued.ConnectionHandle).WaitAsync(Patience, Cancelled);
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 5), false), smaller.ConnectionHandle).WaitAsync(Patience, Cancelled);

        var gauges = _server.Gauges();

        Assert.Empty(gauges.Anomalies);
        Assert.Equal(
            new Dictionary<string, long> { ["bodyBytes"] = 268_435_456, ["connections"] = 10_000, ["largestOutboxBytes"] = 64 },
            gauges.Ceilings);
        Assert.Equal(
            new HashSet<string> { listening.ConnectionHandle, queued.ConnectionHandle, other.ConnectionHandle, smaller.ConnectionHandle },
            gauges.ConnectionHandles);
        // the TypeScript side counts its HTTP/2 sessions too, which Kestrel does not show
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["addresses"] = 2,
                ["bodyBytes"] = 4,
                ["buriedCallIds"] = 1,
                ["connections"] = 4,
                ["largestOutboxBytes"] = 20,
                ["listens"] = 1,
                ["outboxBytes"] = 28,
                ["outboxEnvelopes"] = 3,
                ["waitingExchanges"] = 1,
            },
            gauges.Counts);

        // what a body held goes back as its request ends; what the connections held goes with them
        coming.Reset();
        await Until(() =>
        {
            return Count("bodyBytes") == 0;
        });
        await _server.Stop().WaitAsync(Patience, Cancelled);
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(held));

        var counts = _server.Gauges().Counts;

        Assert.Equal(
            (0L, 0L, 0L, 0L, 0L, 0L),
            (counts["addresses"], counts["bodyBytes"], counts["connections"], counts["listens"], counts["outboxBytes"], counts["waitingExchanges"]));
    }

    [Fact]
    public async Task Refuses_a_listen_on_a_connection_gone_404_as_any_exchange_on_it()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);

        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(ListenOf(connectionToken, "wait=20000")));

        // closed between its token's lookup and its hold, here as the listen comes: gone all the same,
        // whether its client listens or not
        _server.Holding += (handle) =>
        {
            _ = _server.CloseConnection(handle);
        };

        var listening = await Connect(true);
        var deaf = await Connect();

        Assert.Equal(
            [(404, HttpRefusals.ConnectionUnknown), (404, HttpRefusals.ConnectionUnknown)],
            [await RefusalOf(ListenOf(listening.ConnectionToken, "wait=20000")), await RefusalOf(ListenOf(deaf.ConnectionToken, "wait=20000"))]);
    }

    // createTransportServer: what the TypeScript side keeps once, for every transport server, and
    // this server keeps a copy of — the WebSocket transport server's twins

    [Fact]
    public async Task Resolves_false_closing_a_handle_nobody_holds()
    {
        await Start();

        var (_, connectionHandle) = await Connect();

        Assert.False(await _server.CloseConnection("type=HTTP;ip=127.0.0.1;ordinal=2").WaitAsync(Patience, Cancelled));
        Assert.Empty(_closes);
        Assert.True(await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled));
        Assert.Empty(_server.Clients);
    }

    // closed cleanly, as with 1000 over a socket: each close raised, and each exchange still waiting
    // told its connection is gone
    [Fact]
    public async Task CloseAll_closes_every_connection_cleanly_and_gives_nothing_without_one()
    {
        await Start();

        Assert.Empty(await _server.CloseAll().WaitAsync(Patience, Cancelled));

        var (waitingToken, waitingHandle) = await Connect();
        var (listeningToken, listeningHandle) = await Connect(true);
        using var waiting = await Fetch(PostOf(waitingToken, EnvelopeOf(EnvelopeKind.Request, 1)));
        var listen = ListenOf(listeningToken, "wait=20000");

        await Until(() =>
        {
            return Count("listens") == 1;
        });

        var closed = await _server.CloseAll().WaitAsync(Patience, Cancelled);

        Assert.Equal([true, true], closed);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Empty(_server.Clients);
        Assert.Equal(
            new HashSet<(bool, string)> { (true, waitingHandle), (true, listeningHandle) },
            new HashSet<(bool, string)>(_closes));
        // a request handed on, its head out, by its body cut; a listen held, by the marked 404
        Assert.Equal("cut", await EndOf(waiting));
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(listen));
        Assert.Equal(ReadyState.Open, _server.ReadyState);
    }

    [Fact]
    public async Task Resolves_a_send_for_a_handle_nobody_holds()
    {
        await Start();

        var (_, connectionHandle) = await Connect(true);

        // what a connection it holds would keep for its listen, one it does not takes nothing
        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 2), false), "type=HTTP;ip=127.0.0.1;ordinal=2").WaitAsync(Patience, Cancelled);

        Assert.Equal(0, Count("outboxEnvelopes"));

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 2), false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal(1, Count("outboxEnvelopes"));
    }
}
