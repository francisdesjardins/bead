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

    // a page of another origin, which a server answers CORS to when its origins name it (spec 15.12)
    private const string Page = "https://page.test";

    // the fields every response on the path carries but HTTP's own 400
    private static readonly string[] PathFields = ["cache-control", "x-content-type-options", "vary"];

    // the fields of CORS an answer carries, in the order CorsOf writes them
    private static readonly string[] CorsFields =
    [
        "access-control-allow-origin",
        "access-control-expose-headers",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-max-age",
    ];

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly HttpTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    // another address of this machine, which a socket of the tests' own comes from, as a peer elsewhere
    private static readonly IPAddress Elsewhere = IPAddress.Parse("127.0.0.2");

    // what a cancel before its request buries that call id for: the least a requester reserves one for
    private static readonly TimeSpan Burial = TimeSpan.FromSeconds(5);

    private static readonly Lazy<X509Certificate2> Certificate = new(CertificateOf);

    // the addresses a server is secure on, the loopback's, and those it is not, the wildcards
    private static readonly string[] OnTheLoopbackOrNot = ["::1", "127.0.0.1", "127.0.0.2", "0.0.0.0", "::"];

    private readonly ConcurrentQueue<string> _connections = new();
    private readonly ConcurrentQueue<(byte[] Bytes, string ConnectionHandle)> _messages = new();
    private readonly ConcurrentQueue<(bool WasClean, string ConnectionHandle)> _closes = new();
    private readonly ConcurrentQueue<TransportServerRefusal> _refusals = new();
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

    // what an answer's head says of CORS: each field of it, then those of the path, then its mark,
    // "none" for each it does not carry
    private static string CorsOf(IReadOnlyDictionary<string, string> headers)
    {
        string ValueOf(string name)
        {
            return headers.GetValueOrDefault(name) ?? "none";
        }

        var cors = string.Join(" | ", CorsFields.Select(ValueOf));
        var path = string.Join(" ", PathFields.Select(ValueOf));

        return $"{cors} | {path} | {headers.GetValueOrDefault(HttpTransport.RefusalHeader) ?? "unmarked"}";
    }

    private static string CorsOf(HttpResponseMessage response)
    {
        var headers = response.Headers.Concat(response.Content.Headers).ToDictionary((header) =>
        {
            return header.Key.ToLowerInvariant();
        }, (header) =>
        {
            return string.Join(", ", header.Value);
        });

        return CorsOf(headers);
    }

    // the fields of the path a head carries, by name
    private static string StampedOf(IReadOnlyDictionary<string, string> headers)
    {
        return string.Join(" ", PathFields.Where(headers.ContainsKey));
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

    // once the token is cancelled, within the tests' patience
    private static async Task WhenCancelled(CancellationToken token)
    {
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        await using (token.Register(() =>
        {
            cancelled.TrySetResult();
        }))
        {
            await cancelled.Task.WaitAsync(Patience, Cancelled);
        }
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

    private Task<HttpResponseMessage> ListenOf(string connectionToken, ListenFields? fields = null)
    {
        return Fetch(ListenRequestOf(connectionToken, fields));
    }

    // a listen at the connection's one URL, its counts in their fields as given, each left out when
    // none (spec 15.9)
    private HttpRequestMessage ListenRequestOf(string connectionToken, ListenFields? fields = null)
    {
        var given = fields ?? new ListenFields();
        var request = With(new HttpRequestMessage(HttpMethod.Get, Url), (HttpTransport.ConnectionTokenHeader, connectionToken));

        foreach (var (name, value) in new[] { (HttpTransport.AfterHeader, given.After), (HttpTransport.WaitHeader, given.Wait) })
        {
            if (value is not null)
            {
                request.Headers.TryAddWithoutValidation(name, value);
            }
        }

        return request;
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
        _server.Refusal += _refusals.Enqueue;
        _port = (await _server.Start(Loopback, Cancelled)).Port;
    }

    /// <summary>An answer's head: its status, and its headers by their names in lower case.</summary>
    private sealed record Head(int Status, IReadOnlyDictionary<string, string> Headers);

    /// <summary>
    /// A listen's counts, as its fields carry them (spec 15.9): <c>bead-after</c> 0 unless given,
    /// <c>bead-wait</c> left out unless given; each left out when none.
    /// </summary>
    private sealed record ListenFields
    {
        public string? After { get; init; } = "0";

        public string? Wait { get; init; }
    }

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

        // ! one octet per character, its code point (ISO-8859-1): a character past U+007F is an
        // octet past ASCII
        public async Task Write(string text)
        {
            await Write(Encoding.Latin1.GetBytes(text));
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

    // spec 15.12.4
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
        Assert.Equal(("127.0.0.1", 80, false), (start.Address, start.Port, start.FindOpenPort));
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
    public async Task Takes_an_Authorization_as_it_came_an_empty_one_carrying_none()
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
            (1, "Authorization: Bearer  mF_9.B5f-4.1JqM\r\n"),
            (3, "Authorization: basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\r\n"),
            (5, "Authorization:\r\n"),
            (7, ""),
        })
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(connectionToken, $"{field}Content-Length: 8"));
            await wire.Write(EnvelopeOf(EnvelopeKind.Request, callId));

            Assert.Equal(200, (await wire.Read()).Head.Status);
        }

        Assert.Equal(["Bearer  mF_9.B5f-4.1JqM", "basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", null, null], taken);
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

    // spec 15.12.4
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
        // a cancel takes no place: it is never refused for the requests waiting
        // ! before the request refused, whose exchange is counted until after its 429 is read, and
        // whose socket it closes: on the cancel's, which it keeps, the two come one after the other
        using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 9)));
        var crowded = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)));

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
    public async Task Draws_a_connection_whose_connection_listener_throws_the_next_listener_told_the_throw_reported_with_it()
    {
        await Start();

        var thrown = new InvalidOperationException("a connection listener that throws");
        var told = new ConcurrentQueue<string>();
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Connection += (_) =>
        {
            throw thrown;
        };
        _server.Connection += told.Enqueue;
        _server.Error += (reason, connectionHandle) =>
        {
            errors.Enqueue((reason, connectionHandle));
        };

        // drawn as if it returned: its 201 and its token, its connection held
        var (connectionToken, connectionHandle) = await Connect();

        Assert.NotEmpty(connectionToken);
        Assert.Equal([connectionHandle], told);
        Assert.Equal([(thrown, connectionHandle)], errors);
        Assert.Equal([connectionHandle], _server.ConnectionHandles);
        Assert.Equal((1, 1), (Count("connections"), Count("addresses")));
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Hands_on_a_request_whose_message_listener_throws_its_answer_still_written_the_throw_reported_with_its_connection()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var thrown = new InvalidOperationException("a message listener that throws");
        var answer = EnvelopeOf(EnvelopeKind.Result, (1, 3));
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();
        Task? answered = null;

        _server.Message += (_, _) =>
        {
            throw thrown;
        };

        // a listener after it, as a router answering, hears the request all the same
        _server.Message += (_, handle) =>
        {
            answered = _server.Send(new TransportMessage(answer, false), handle);
        };
        _server.Error += (reason, handle) =>
        {
            errors.Enqueue((reason, handle));
        };

        using var response = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

        Assert.Equal(200, (int)response.StatusCode);
        Assert.Equal(answer, await BytesOf(response));
        await answered!.WaitAsync(Patience, Cancelled);
        Assert.Equal([(thrown, connectionHandle)], errors);
        Assert.Equal(0, Count("waitingExchanges"));
        Assert.Equal([connectionHandle], _server.ConnectionHandles);
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Stops_though_a_close_listener_throws_each_connection_still_ends_its_close_told_the_throw_reported()
    {
        await Start();

        var (_, first) = await Connect();
        var (_, second) = await Connect();
        var thrown = new InvalidOperationException("a close listener that throws");
        var told = new ConcurrentQueue<string>();
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Close += (_, _) =>
        {
            throw thrown;
        };
        _server.Close += (_, connectionHandle) =>
        {
            told.Enqueue(connectionHandle);
        };
        _server.Error += (reason, connectionHandle) =>
        {
            errors.Enqueue((reason, connectionHandle));
        };

        await _server.Stop().WaitAsync(Patience, Cancelled);

        Assert.Equal([(false, first), (false, second)], _closes);
        Assert.Equal([first, second], told);
        Assert.Equal([(thrown, first), (thrown, second)], errors);
        Assert.Equal(ReadyState.Closed, _server.ReadyState);
        Assert.Empty(_server.ConnectionHandles);
    }

    [Fact]
    public async Task Closes_a_connection_idle_past_its_timeout_though_a_close_listener_throws_the_throw_reported()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var (_, connectionHandle) = await Connect();
        var thrown = new InvalidOperationException("a close listener that throws");
        var errors = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();

        _server.Close += (_, _) =>
        {
            throw thrown;
        };
        _server.Error += (reason, handle) =>
        {
            errors.Enqueue((reason, handle));
        };

        // out of its timer, which no call waits on
        _time.Advance(TimeSpan.FromSeconds(2));

        Assert.Equal([(false, connectionHandle)], _closes);
        Assert.Equal([(thrown, connectionHandle)], errors);
        Assert.Empty(_server.ConnectionHandles);
        Assert.Equal((0, 0), (Count("connections"), Count("addresses")));
    }

    [Fact]
    public async Task Refuses_a_connect_that_comes_as_it_stops_busy_told_when_to_come_back_drawing_nothing()
    {
        await Start();

        var (_, connectionHandle) = await Connect();
        (int Status, string? RetryAfter, string? Reason) refused = default;
        (int Status, string? Reason)[] judged = [];

        // the stop under way, its connection's close told: a connect comes, Kestrel still serving
        _server.Close += (_, _) =>
        {
            using var response = Fetch(PostOf(null, null)).GetAwaiter().GetResult();

            refused = ((int)response.StatusCode, HeaderOf(response, "retry-after"), HeaderOf(response, HttpTransport.RefusalHeader));

            // what a connect is comes before when it came: another type, then a body
            judged =
            [
                RefusalOf(With(PostOf(null, null), ("content-type", "text/plain"))).GetAwaiter().GetResult(),
                RefusalOf(PostOf(null, [0xA1, 0x10, 0x00, 0x00, 0x00])).GetAwaiter().GetResult(),
            ];
        };

        await Task.Run(_server.Stop, Cancelled).WaitAsync(Patience, Cancelled);

        Assert.Equal((503, "1", HttpRefusals.Busy), refused);
        Assert.Equal([(415, HttpRefusals.Type), (400, HttpRefusals.Malformed)], judged);
        Assert.Equal([connectionHandle], _connections);
        Assert.Equal([(false, connectionHandle)], _closes);
        Assert.Empty(_server.ConnectionHandles);
    }

    [Fact]
    public async Task Answers_the_404_marked_connection_unknown_an_exchange_that_comes_as_it_stops_its_connection_not_yet_closed_nothing_handed_on()
    {
        await Start(new HttpTransportServerOptions { Origins = ["https://app.example"] });

        var first = await Connect();
        var second = await Connect();
        var others = new Dictionary<string, string> { [first.ConnectionHandle] = second.ConnectionToken, [second.ConnectionHandle] = first.ConnectionToken };
        (int Status, string? Reason)? refused = null;
        (int Status, string? Reason)[] judged = [];
        var held = 0;

        // a POST by hand, which HttpClient would not send: its head, then no body
        async Task<(int Status, string? Reason)> ByHand(string connectionToken, string framing)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(connectionToken, framing));

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        // what a request is comes before when it came; what is judged of an exchange against its
        // connection comes after the lookup a stopping server answers, in spec 15.6's order
        async Task<(int Status, string? Reason)[]> Judged(string connectionToken)
        {
            return
            [
                await RefusalOf(PostOf("not-a-token", EnvelopeOf(EnvelopeKind.Request, 1))),
                await RefusalOf(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)), ("origin", "https://elsewhere.example"))),
                await RefusalOf(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 1)), ("content-type", "text/plain"))),
                await ByHand(connectionToken, "Authorization: Bearer a\r\nAuthorization: Bearer b\r\nContent-Length: 0"),
                await ByHand(connectionToken, "Content-Length: 2147483648"),
                await RefusalOf(ListenOf(connectionToken, new() { After = "x" })),
            ];
        }

        // the stop under way, one connection's close told: an exchange comes on the other, which
        // the stop has not closed yet
        _server.Close += (_, connectionHandle) =>
        {
            if (refused is not null)
            {
                return;
            }

            held = _server.ConnectionHandles.Count;
            refused = RefusalOf(PostOf(others[connectionHandle], EnvelopeOf(EnvelopeKind.Request, 1))).GetAwaiter().GetResult();
            judged = Judged(others[connectionHandle]).GetAwaiter().GetResult();
        };

        await Task.Run(_server.Stop, Cancelled).WaitAsync(Patience, Cancelled);

        Assert.Equal(1, held);
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), refused);
        Assert.Equal(
            [
                (400, HttpRefusals.Malformed),
                (403, HttpRefusals.Origin),
                (404, HttpRefusals.ConnectionUnknown),
                (404, HttpRefusals.ConnectionUnknown),
                (404, HttpRefusals.ConnectionUnknown),
                (404, HttpRefusals.ConnectionUnknown),
            ],
            judged);
        Assert.Empty(_messages);
        Assert.Equal(2, _closes.Count);
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
    public async Task Is_secure_under_TLS_whatever_it_listens_on_or_on_a_loopback_host_alone_and_carries_no_credential_toward_a_connection()
    {
        using var key = System.Security.Cryptography.ECDsa.Create();
        using var certificate = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=bead.example", key, System.Security.Cryptography.HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        await using var unstarted = new HttpTransportServer();
        await using var underTls = new HttpTransportServer(new HttpTransportServerOptions { Certificate = certificate });

        await Start();

        // bound to the loopback, it never leaves the machine; under TLS, wherever it listens;
        // otherwise, nothing bound, nothing is
        Assert.Equal((false, true), (_server.CarriesCredential("any"), _server.IsSecure("any")));
        Assert.Equal((false, true), (underTls.CarriesCredential("any"), underTls.IsSecure("any")));
        Assert.Equal((false, false), (unstarted.CarriesCredential("any"), unstarted.IsSecure("any")));
    }

    [Fact]
    public async Task Is_secure_as_its_application_says_what_stands_in_front_of_it_whatever_it_listens_on_and_by_what_it_listens_on_when_it_says_nothing()
    {
        using var key = System.Security.Cryptography.ECDsa.Create();
        using var certificate = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=bead.example", key, System.Security.Cryptography.HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        await using var underTls = new HttpTransportServer(new HttpTransportServerOptions { Certificate = certificate, Secure = false });

        // whether one bound to the loopback is secure, and one bound to nothing, which no listener
        // makes secure
        async Task<(bool Bound, bool Unbound)> SecuredBy(bool? secure)
        {
            await using var unbound = new HttpTransportServer(new HttpTransportServerOptions { Secure = secure });

            await Start(new HttpTransportServerOptions { Secure = secure });

            return (_server.IsSecure("any"), unbound.IsSecure("any"));
        }

        // nothing said, by its listener; TLS terminated before it, on another host; a proxy on the
        // machine that serves the network in the clear, before a server of its own under TLS too
        Assert.Equal((true, false), await SecuredBy(null));
        Assert.Equal((true, true), await SecuredBy(true));
        Assert.Equal((false, false), await SecuredBy(false));
        Assert.False(underTls.IsSecure("any"));
    }

    [Fact]
    public async Task Answers_each_listen_it_holds_the_marked_404_as_it_stops_however_many()
    {
        await Start();

        var held = new List<Task<HttpResponseMessage>>();

        for (var connection = 0; connection < 32; connection += 1)
        {
            held.Add(ListenOf((await Connect(true)).ConnectionToken, new() { Wait = "20000" }));
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

        // an authority that is no host, a colon with no port: its stream reset over HTTP/2, 400 over
        // HTTP/1.1
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of((":authority", "localhost:"), ("content-type", HttpTransport.MediaType)));

        await using (var http1 = await TlsWire.Open(_port, (Certificate.Value, SslApplicationProtocol.Http11)))
        {
            Assert.Equal(400, await http1.AskHead($"POST /bead HTTP/1.1\r\nHost: localhost:\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"));
        }

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
    public async Task Names_its_host_over_HTTP_2_by_its_authority_a_host_beside_it_ignored_for_the_host_and_the_own_origin()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        var own = $"{Host}:{_port}";
        var bead = ("content-type", HttpTransport.MediaType);

        // :authority names the host and the own origin, a host beside it ignored; a host alone names
        // it where :authority is absent; neither names none, which the server refuses as it refuses
        // a request over HTTP/1.0 that names none
        Assert.Equal(
            [
                new TlsAnswer(201, null, null),
                new TlsAnswer(201, null, null),
                new TlsAnswer(403, HttpRefusals.Host, null),
                new TlsAnswer(201, null, null),
                new TlsAnswer(403, HttpRefusals.Origin, null),
                new TlsAnswer(201, null, null),
                new TlsAnswer(201, null, null),
                new TlsAnswer(403, HttpRefusals.Host, null),
                new TlsAnswer(403, HttpRefusals.Host, null),
            ],
            [
                await Http2Of((":authority", own), bead),
                await Http2Of((":authority", own), ("host", "rebind.example:8080"), bead),
                await Http2Of((":authority", "rebind.example:8080"), ("host", own), bead),
                await Http2Of((":authority", own), ("host", "rebind.example:8080"), bead, ("origin", $"https://{own}")),
                await Http2Of((":authority", own), ("host", "rebind.example:8080"), bead, ("origin", "https://rebind.example:8080")),
                await Http2Of((":authority", "Bead.LocalHost:443"), bead, ("origin", "https://bead.localhost:443")),
                await Http2Of(("host", own), bead, ("origin", $"https://{own}")),
                await Http2Of(("host", "rebind.example:8080"), bead),
                await Http2Of(bead),
            ]);
    }

    [Fact]
    public async Task Answers_a_preflight_over_HTTP_2_as_over_HTTP_1_1()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value, Origins = [Page] });

        using var http = SecureClient();
        var answers = new List<(Version Version, string Preflight, string Connect)>();

        // the page's preflight, then its connect, over each
        foreach (var version in new[] { HttpVersion.Version20, HttpVersion.Version11 })
        {
            var asked = With(With(new HttpRequestMessage(HttpMethod.Options, SecureUrl), ("origin", Page)), ("access-control-request-method", "POST"));
            using var preflight = await Fetch(http, Over(With(asked, ("access-control-request-headers", "bead-listen,content-type,traceparent")), version));
            using var connect = await Fetch(http, Over(With(PostOf(SecureUrl, (null, null)), ("origin", Page)), version));

            answers.Add((preflight.Version, $"{(int)preflight.StatusCode} {(await BytesOf(preflight)).Length} {CorsOf(preflight)}", $"{(int)connect.StatusCode} {CorsOf(connect)}"));
        }

        var answered = $"204 0 {Page} | * | none | GET, POST, DELETE | authorization, bead-listen,content-type,traceparent, * | 7200 | no-store nosniff Origin | unmarked";
        var drawn = $"201 {Page} | * | none | none | none | none | no-store nosniff Origin | unmarked";

        Assert.Equal([(HttpVersion.Version20, answered, drawn), (HttpVersion.Version11, answered, drawn)], answers);
        Assert.Equal(2, _connections.Count);
        Assert.Empty(_refusals);
    }

    [Fact]
    public async Task Resets_over_HTTP_2_the_stream_of_a_request_whose_authority_is_no_host_PROTOCOL_ERROR_nothing_written()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value, Hosts = ["*"] });

        var bead = ("content-type", HttpTransport.MediaType);
        var answers = new List<(string Authority, TlsAnswer Answer)>();

        foreach (var authority in new[] { "a*b.test", "a%41.test", "a;b=c", "a+b.test", "[v1.bead]", "localhost:", "[::1]:", "bad host" })
        {
            answers.Add((authority, await Http2Of((":authority", authority), bead)));
        }

        // a host alone, where :authority is absent, judged as it would be
        answers.Add(("host a*b.test", await Http2Of(("host", "a*b.test"), bead)));

        // PROTOCOL_ERROR (RFC 9113 §7)
        Assert.All(answers, (answer) =>
        {
            Assert.Equal((answer.Authority, new TlsAnswer(null, null, 0x1)), answer);
        });
        Assert.Empty(_connections);
    }

    // one request over HTTP/2, written by hand on a socket of its own: its answer, or its reset
    private async Task<TlsAnswer> Http2Of(params (string Name, string Value)[] fields)
    {
        await using var wire = await TlsWire.Open(_port, (Certificate.Value, SslApplicationProtocol.Http2));

        return await wire.Ask(fields);
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
        var options = new HttpTransportServerOptions { Hosts = ["bead.example"] };

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
            // a target in absolute-form names the host, its Host ignored but for being one, or none
            // over HTTP/1.0
            await StatusOf("http://bead.example/bead HTTP/1.1", $"Host: rebound.example\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("http://localhost/bead?after=1 HTTP/1.1", $"Host: bad host\r\nContent-Type: {HttpTransport.MediaType}\r\n"),
            await StatusOf("http://bead.example/bead HTTP/1.0", $"Content-Type: {HttpTransport.MediaType}\r\n"),
            // and HTTP refuses one that names no host, its authority read as it came, a colon with no
            // port and a userinfo among them, which Kestrel's Uri drops; another scheme's, or one
            // beside two Host lines
            await StatusOf("http:///bead HTTP/1.1", bead),
            await StatusOf("http://a%41.test/bead HTTP/1.1", bead),
            await StatusOf("http://127.0.0.1:/bead HTTP/1.1", bead),
            await StatusOf("http://user@bead.example/bead HTTP/1.1", bead),
            await StatusOf("HTTP://bead.example/bead HTTP/1.1", bead),
            await StatusOf("ftp://bead.example/bead HTTP/1.1", bead),
            await StatusOf("http://bead.example/bead HTTP/1.1", $"Host: bead.example\r\n{bead}"),
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
                (201, null),
                (201, null),
                (201, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
                (400, null),
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
    public async Task Reads_the_Host_as_it_came_an_IDN_page_s_own_in_punycode_and_one_of_invalid_punycode_taken_or_refused_host_refused_never_a_500()
    {
        async Task<(int Status, string? Reason)> StatusOf((string Host, string? Origin) from)
        {
            using var wire = await Wire.Open(_port);
            var origin = from.Origin is { } given ? $"Origin: {given}\r\n" : "";

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {from.Host}\r\n{origin}Content-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
        // and a Host of punycode that decodes to none, taken where every host is; under *, no page is
        // the server's own by a host * alone takes (spec 15.12)
        var page = ("xn--bad-bma.test:8080", "http://xn--bad-bma.test:8080");

        await Start(new HttpTransportServerOptions { Hosts = ["*"] });

        Assert.Equal(
            [(403, HttpRefusals.Origin), (403, HttpRefusals.Origin), (201, null), (201, null), (201, null)],
            [
                await StatusOf(page),
                await StatusOf(("xn--a", "http://xn--a")),
                await StatusOf(("xn--a", null)),
                await StatusOf(("xn--a.test", null)),
                await StatusOf(("xn---bad-cpa.test", null)),
            ]);

        // hosts name an IDN host as the field carries it, in punycode
        await Start(new HttpTransportServerOptions { Hosts = ["xn--bad-bma.test"] });

        Assert.Equal(
            [(201, null), (201, null), (403, HttpRefusals.Host), (403, HttpRefusals.Host)],
            [await StatusOf(page), await StatusOf(("XN--BAD-BMA.test:8080", null)), await StatusOf(("xn--a.test", null)), await StatusOf(("xn---bad-cpa.test", null))]);
    }

    // spec 15.12
    [Fact]
    public void Refuses_as_it_is_built_a_hosts_entry_with_a_port_and_an_origins_entry_that_is_a_star_or_null()
    {
        var port = Assert.Throws<ArgumentException>(() =>
        {
            return new HttpTransportServer(new HttpTransportServerOptions { Hosts = ["bead.test", "bead.test:8080"] });
        });
        var star = Assert.Throws<ArgumentException>(() =>
        {
            return new HttpTransportServer(new HttpTransportServerOptions { Origins = ["*"] });
        });
        var opaque = Assert.Throws<ArgumentException>(() =>
        {
            return new HttpTransportServer(new HttpTransportServerOptions { Hosts = ["*"], Origins = ["https://bead.test", "null"] });
        });

        Assert.Equal(("Hosts", "Origins", "Origins"), (port.ParamName, star.ParamName, opaque.ParamName));
        Assert.Contains("\"bead.test:8080\"", port.Message, StringComparison.Ordinal);
        Assert.Contains("no wildcard of origins", star.Message, StringComparison.Ordinal);
        Assert.Contains("a sandboxed frame of any site", opaque.Message, StringComparison.Ordinal);
        Assert.Null(Record.Exception(() =>
        {
            return new HttpTransportServer(new HttpTransportServerOptions { Hosts = ["*"], Origins = ["https://bead.test"] });
        }));
    }

    [Fact]
    public async Task Names_a_client_that_comes_over_IPv4_to_a_dual_stack_listener_by_its_IPv4_address()
    {
        await Start(new HttpTransportServerOptions { TrustedProxies = ["127.0.0.1"] });
        await _server.Stop().WaitAsync(Patience, Cancelled);
        _port = (await _server.Start(new HttpTransportStartOptions { Address = "::", FindOpenPort = true }, Cancelled)).Port;

        var drawn = await Connect();

        // the socket's address, IPv4 mapped into IPv6, read as the loopback the proxy it names comes
        // from
        using var forwarded = await Fetch(With(PostOf(null, null), ("x-forwarded-for", "203.0.113.9")));

        Assert.Equal(201, (int)forwarded.StatusCode);
        Assert.Equal("type=HTTP;ip=127.0.0.1;ordinal=1", drawn.ConnectionHandle);
        Assert.Equal(
            [(Host, drawn.ConnectionHandle), ("203.0.113.9", "type=HTTP;ip=203.0.113.9;ordinal=2")],
            _server.Clients.OrderBy((client) =>
            {
                return client.ConnectionHandle;
            }, StringComparer.Ordinal).Select((client) =>
            {
                return (client.Address, client.ConnectionHandle);
            }));
    }

    [Fact]
    public async Task Answers_a_request_without_a_Host_with_two_or_with_one_that_is_no_host_400_as_HTTP_does_unmarked()
    {
        // a connect with the Host field lines given: none, two in either order, or one that is no host
        var hosts = new[] { "", "Host: bead.test\r\nHost: elsewhere.test\r\n", "Host: elsewhere.test\r\nHost: bead.test\r\n", "Host: bad host\r\n" };

        // its head is the HTTP server's own, whether the server takes every host or names some
        foreach (var options in new[] { new HttpTransportServerOptions(), new HttpTransportServerOptions { Hosts = ["bead.test"] } })
        {
            await Start(options);

            foreach (var host in hosts)
            {
                using var wire = await Wire.Open(_port);

                await wire.Write($"POST /bead HTTP/1.1\r\n{host}Content-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

                var (head, body) = await wire.Read();

                Assert.Equal((host, 400, false, 0), (host, head.Status, head.Headers.ContainsKey(HttpTransport.RefusalHeader), body.Length));
            }
        }

        Assert.Empty(_connections);
    }

    [Fact]
    public async Task Tells_each_refusal_it_judges_of_its_own_its_status_its_reason_the_request_s_authority_and_origin_and_the_client_s_address_and_port_and_nothing_of_HTTP_s_own()
    {
        await Start();

        var own = $"{Host}:{_port}";
        var told = new List<TransportServerRefusal>();

        // each head on a socket of its own, which the refusal names by its port
        async Task<int> Refused(string head)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(head);
            await wire.Read();

            return wire.Port;
        }

        // a host not taken, its Origin in two field lines joined by ", "; an absolute-form target's
        // authority over its Host; an empty Host; HTTP/1.0 naming none; a path, an origin, a method
        // and a type refused; a token no connection holds; a connect past what one address holds
        var ports = new[]
        {
            await Refused("POST /bead HTTP/1.1\r\nHost: rebind.example:8080\r\nOrigin: http://a.example\r\nOrigin: http://b.example\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"POST http://rebind.example/bead HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            await Refused("POST /bead HTTP/1.1\r\nHost: \r\nContent-Length: 0\r\n\r\n"),
            await Refused("POST /bead HTTP/1.0\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"POST /other HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"POST /bead HTTP/1.1\r\nHost: {own}\r\nOrigin: http://elsewhere.example\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"PUT /bead HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"POST /bead HTTP/1.1\r\nHost: {own}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n"),
            await Refused($"POST /bead HTTP/1.1\r\nHost: {own}\r\nContent-Type: {HttpTransport.MediaType}\r\n{HttpTransport.ConnectionTokenHeader}: AAAAAAAAAAAAAAAAAAAAAA\r\nContent-Length: 0\r\n\r\n"),
        };

        // what HTTP refuses of its own, unmarked: an authority that is no host, two Host lines
        await Refused("POST /bead HTTP/1.1\r\nHost: localhost:\r\nContent-Length: 0\r\n\r\n");
        await Refused("POST /bead HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\nContent-Length: 0\r\n\r\n");

        await Until(() =>
        {
            return _refusals.Count == ports.Length;
        });
        told.AddRange(_refusals);

        Assert.Equal(
            [
                new("127.0.0.1", "rebind.example:8080", "http://a.example, http://b.example", ports[0], HttpRefusals.Host, 403),
                new("127.0.0.1", "rebind.example", null, ports[1], HttpRefusals.Host, 403),
                new("127.0.0.1", "", null, ports[2], HttpRefusals.Host, 403),
                new("127.0.0.1", null, null, ports[3], HttpRefusals.Host, 403),
                new("127.0.0.1", own, null, ports[4], HttpRefusals.Path, 404),
                new("127.0.0.1", own, "http://elsewhere.example", ports[5], HttpRefusals.Origin, 403),
                new("127.0.0.1", own, null, ports[6], HttpRefusals.Method, 405),
                new("127.0.0.1", own, null, ports[7], HttpRefusals.Type, 415),
                new TransportServerRefusal("127.0.0.1", own, null, ports[8], HttpRefusals.ConnectionUnknown, 404),
            ],
            told);
        Assert.Empty(_connections);
    }

    [Fact]
    public async Task Tells_no_refusal_of_the_404_that_ends_an_exchange_or_a_listen_as_its_connection_closes_by_a_DELETE_a_timeout_an_outbox_past_its_bound_a_close_and_a_stop()
    {
        await Start(new HttpTransportServerOptions { ExchangeTimeout = TimeSpan.FromSeconds(1), MaximumOutboxBytes = 20 });

        // a listen held, then its connection gone, each of its own way
        async Task<Task<(int Status, string? Reason)>> Held((string ConnectionToken, string ConnectionHandle) connection)
        {
            var listens = Count("listens");
            var held = RefusalOf(ListenOf(connection.ConnectionToken, new() { Wait = "20000" }));

            await Until(() =>
            {
                return Count("listens") == listens + 1;
            });

            return held;
        }

        // a DELETE
        var deleted = await Connect(true);
        var heldAtDelete = await Held(deleted);

        using (var deleting = await Fetch(RequestOf(HttpMethod.Delete, deleted.ConnectionToken)))
        {
            Assert.Equal(204, (int)deleting.StatusCode);
        }

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await heldAtDelete);

        // a request waiting past its exchange timeout
        var waited = await Connect(true);
        var heldAtTimeout = await Held(waited);
        using var asking = await Fetch(PostOf(waited.ConnectionToken, EnvelopeOf(EnvelopeKind.Request, 1)));

        _time.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal("cut", await EndOf(asking));
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await heldAtTimeout);

        // an outbox past its bound, a request's body still coming
        var (connectionToken, connectionHandle) = await Connect(true);
        var envelope = EnvelopeOf(EnvelopeKind.Request, (3, 8));
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, $"Content-Length: {envelope.Length}"));
        await coming.Write(envelope[..12]);
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });

        for (var sent = 0; sent < 3; sent += 1)
        {
            await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, (5, 2)), false), connectionHandle).WaitAsync(Patience, Cancelled);
        }

        var gone = await coming.ReadHead();

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), (gone.Status, gone.Headers[HttpTransport.RefusalHeader]));

        // a close by the application, and a stop
        var closed = await Connect(true);
        var heldAtClose = await Held(closed);

        await _server.CloseConnection(closed.ConnectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await heldAtClose);

        var stopped = await Connect(true);
        var heldAtStop = await Held(stopped);

        // and, for the tell's sake, a token no longer held, which is a request refused as it comes
        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(RequestOf(HttpMethod.Delete, deleted.ConnectionToken)));
        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });
        await _server.Stop().WaitAsync(Patience, Cancelled);

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await heldAtStop);
        Assert.Equal([HttpRefusals.ConnectionUnknown], _refusals.Select((refusal) =>
        {
            return refusal.Reason;
        }));
        Assert.Equal(5, _closes.Count);
    }

    [Fact]
    public async Task Answers_400_unmarked_with_none_of_the_path_s_fields_a_field_holding_a_control_character_other_than_HTAB_or_an_octet_past_ASCII_and_tells_nothing()
    {
        await Start();

        var own = $"{Host}:{_port}";

        // each a connect but for one field, over HTTP/1.1 by hand: the octets as given, each
        // character one octet, or, for the UTF-8 one, its two; its status, its mark, and the fields
        // of the path it carries
        async Task<(int Status, string? Reason, string Stamped)> Answered(string field)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {own}\r\n{field}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n");

            var (head, _) = await wire.Read();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), StampedOf(head.Headers));
        }

        var answers = new List<(string Field, (int, string?, string) Answer)>();

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
            answers.Add((field, await Answered(field)));
        }

        Assert.All(answers, (answer) =>
        {
            Assert.Equal((answer.Field, (400, (string?)null, "")), answer);
        });
        Assert.Empty(_refusals);
        Assert.Empty(_connections);

        // a tab is taken: the origin is refused as it is, with the path's fields, and told
        Assert.Equal((403, HttpRefusals.Origin, "cache-control x-content-type-options vary"), await Answered("Origin: http://a.example\tb"));
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
    public async Task Resets_over_HTTP_2_the_stream_of_a_request_with_a_field_holding_an_octet_past_ASCII_PROTOCOL_ERROR_and_tells_nothing()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        var own = (":authority", $"{Host}:{_port}");
        var bead = ("content-type", HttpTransport.MediaType);

        // é in UTF-8, each of its two octets one character, which Kestrel decodes and the transport
        // refuses: PROTOCOL_ERROR (RFC 9113 §8.1.1), nothing written
        var cafe = Encoding.Latin1.GetString(Encoding.UTF8.GetBytes("café"));

        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("x-other", cafe)));
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("origin", $"http://{cafe}.example")));
        Assert.Empty(_refusals);

        // a tab is taken
        Assert.Equal(new TlsAnswer(201, null, null), await Http2Of(own, bead, ("x-other", "a\tb")));
    }

    [Fact]
    public async Task Resets_over_HTTP_2_the_stream_of_a_request_with_a_field_holding_a_control_character_but_a_tab_or_whose_value_starts_or_ends_with_a_space_or_a_tab_and_Kestrel_ends_the_session_of_an_octet_that_is_no_UTF_8()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value });

        var own = (":authority", $"{Host}:{_port}");
        var bead = ("content-type", HttpTransport.MediaType);

        // a control character Kestrel decodes, and the transport resets the stream of, where Node's
        // parser drops the field before the TypeScript side's transport reads the request
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("origin", "http://a.example\u001b[2J")));
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("x-other", "a\u0007b")));

        // and a value with a space or a tab at either end (RFC 9113 §8.2.1), which Node's parser
        // drops alike under its default
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("x-other", " a")));
        Assert.Equal(new TlsAnswer(null, null, 0x1), await Http2Of(own, bead, ("x-other", "a\t")));

        // ! a lone 0xE9, no UTF-8, Kestrel refuses of its own, ending the session, PROTOCOL_ERROR
        Assert.Equal(new TlsAnswer(null, null, null, 0x1), await Http2Of(own, bead, ("x-other", "café")));
        Assert.Empty(_refusals);
        Assert.Empty(_connections);
    }

    [Fact]
    public async Task Resets_over_HTTP_2_the_stream_of_a_request_with_a_field_whose_value_starts_or_ends_with_a_space_or_a_tab_PROTOCOL_ERROR_and_tells_nothing()
    {
        await Start(new HttpTransportServerOptions { Certificate = Certificate.Value, Origins = [Page] });

        var own = (":authority", $"{Host}:{_port}");
        var bead = ("content-type", HttpTransport.MediaType);
        var answers = new List<(string Field, TlsAnswer Answer)>();

        // each field the transport reads, padded: Kestrel hands it on as it came, and the transport
        // resets its stream before it reads any, PROTOCOL_ERROR (RFC 9113 §8.1.1), nothing written —
        // a credential never presented, a body never taken, an origin never judged, a count never read
        foreach (var field in new[]
        {
            ("authorization", "  Bearer x "),
            ("content-type", $"{HttpTransport.MediaType} "),
            ("origin", $" {Page}"),
            (HttpTransport.AfterHeader, "\t0"),
        })
        {
            (string, string)[] fields = field.Item1 == "content-type" ? [own, field] : [own, bead, field];

            answers.Add((field.Item1, await Http2Of(fields)));
        }

        Assert.Equal(
            [
                ("authorization", new TlsAnswer(null, null, 0x1)),
                ("content-type", new TlsAnswer(null, null, 0x1)),
                ("origin", new TlsAnswer(null, null, 0x1)),
                (HttpTransport.AfterHeader, new TlsAnswer(null, null, 0x1)),
            ],
            answers);
        Assert.Empty(_refusals);
        Assert.Empty(_connections);
    }

    [Fact]
    public async Task Refuses_as_it_would_though_a_refusal_listener_throws_the_throw_reported_with_no_connection()
    {
        await Start();

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

        var refused = RefusalOf(With(PostOf(null, null), ("origin", "http://elsewhere.example")));

        Assert.Equal((403, HttpRefusals.Origin), await refused);
        await Until(() =>
        {
            return !errors.IsEmpty;
        });

        // the listener before it told, the throw reported with the empty handle, and the next
        // request served as ever
        Assert.Equal([HttpRefusals.Origin], _refusals.Select((refusal) =>
        {
            return refusal.Reason;
        }));
        Assert.Equal([(thrown, "")], errors);
        Assert.NotEmpty((await Connect()).ConnectionToken);
    }

    [Fact]
    public async Task Listens_on_the_loopback_when_given_no_address_reached_by_127_0_0_1_and_by_localhost_and_is_secure_there()
    {
        await using var server = new HttpTransportServer();
        var bound = await server.Start(new HttpTransportStartOptions { FindOpenPort = true }, Cancelled);
        using var racing = new HttpClient(new SocketsHttpHandler { ConnectCallback = HappyEyeballs.ConnectCallback });

        Assert.Equal("127.0.0.1", bound.Address);
        Assert.True(server.IsSecure("any"));

        foreach (var host in new[] { "127.0.0.1", "localhost" })
        {
            using var drew = await Fetch(racing, With(PostOf(new Uri($"http://{host}:{bound.Port}/bead"), (null, null)), ("origin", $"http://{host}:{bound.Port}")));

            Assert.Equal((host, 201), (host, (int)drew.StatusCode));
        }
    }

    [Fact]
    public async Task Refuses_to_start_on_an_address_that_is_no_bare_IP_address_ending_closed()
    {
        foreach (var address in Addresses.NotListening)
        {
            await using var server = new HttpTransportServer();
            var refused = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return server.Start(new HttpTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled);
            });

            Assert.Equal((address, nameof(HttpTransportStartOptions.Address), ReadyState.Closed), (address, refused.ParamName, server.ReadyState));
            Assert.StartsWith($"a server listens on an IP address, not \"{address}\"", refused.Message, StringComparison.Ordinal);
        }

        foreach (var address in Addresses.Listening.Where((address) =>
        {
            return Socket.OSSupportsIPv6 || !address.Contains(':', StringComparison.Ordinal);
        }))
        {
            await using var server = new HttpTransportServer();

            Assert.Equal(address, (await server.Start(new HttpTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled)).Address);
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
            await using var server = new HttpTransportServer();

            await server.Start(new HttpTransportStartOptions { Address = address, FindOpenPort = true }, Cancelled);
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

    // spec 15.12
    [Fact]
    public async Task Takes_a_client_s_address_from_X_Forwarded_For_only_from_a_proxy_it_names_and_bounds_the_connections_of_each_address()
    {
        await Start(new HttpTransportServerOptions { MaximumConnectionsPerAddress = 1, TrustedProxies = ["127.0.0.1"] });

        async Task<(int Status, string ConnectionHandle)> DrawOf(string forwarded, IPAddress from)
        {
            using var wire = await Wire.Open(_port, from);

            await wire.Write($"POST /bead HTTP/1.1\r\nHost: {Host}\r\nContent-Type: {HttpTransport.MediaType}\r\nX-Forwarded-For: {forwarded}\r\nContent-Length: 0\r\n\r\n");

            return ((await wire.ReadHead()).Status, _connections.LastOrDefault() ?? "");
        }

        Assert.Equal((201, "type=HTTP;ip=198.51.100.7;ordinal=1"), await DrawOf("203.0.113.9, 198.51.100.7", IPAddress.Loopback));
        // one address, one connection
        Assert.Equal(503, (await DrawOf("198.51.100.7", IPAddress.Loopback)).Status);
        // what is no address is not taken, nor what a peer it does not name forwards — one of
        // another address of the loopback's here
        Assert.Equal((201, "type=HTTP;ip=127.0.0.1;ordinal=2"), await DrawOf("evil;ordinal=1", IPAddress.Loopback));
        // nor what only a lenient parse reads as one, as isIP is strict: the loopback's own, which
        // holds its one connection already
        Assert.Equal(503, (await DrawOf("1", IPAddress.Loopback)).Status);
        Assert.Equal((201, "type=HTTP;ip=127.0.0.2;ordinal=3"), await DrawOf("192.0.2.1", Elsewhere));
    }

    // spec 15.12
    [Fact]
    public async Task Gauges_the_connections_its_busiest_address_holds_against_maximumConnectionsPerAddress_which_its_health_warns_on_at_80_percent()
    {
        await Start(new HttpTransportServerOptions { MaximumConnectionsPerAddress = 5 });

        var none = new LayerGauges([], new Dictionary<string, long>(), new Dictionary<string, long>(), 0);

        // the transport's one check of its busiest address, as its server's health gives it
        HealthCheck CheckOf()
        {
            var gauges = _server.Gauges();
            var health = Health.Of(new ServerGauges(none, none, none, LayerGauges.Of(gauges, gauges.ConnectionHandles)));

            return Assert.Single(health.Checks["transport:largestAddressConnections"]);
        }

        Assert.Equal((0L, 5L), (_server.Gauges().Counts["largestAddressConnections"], _server.Gauges().Ceilings["largestAddressConnections"]));

        // a proxy no trustedProxies entry holds, the loopback here: every client behind it is its
        // address
        await Connect();
        await Connect();
        await Connect();
        await ConnectFrom(Elsewhere, false);
        Assert.Equal(new HealthCheck(3, HealthStatus.Pass, "3 of 5"), CheckOf());

        // the busiest address at 80% of its ceiling warns, before its first 503
        await Connect();
        Assert.Equal(new HealthCheck(4, HealthStatus.Warn, "4 of 5"), CheckOf());
        await Connect();
        Assert.Equal((503, HttpRefusals.Busy), await RefusalOf(PostOf(null, null)));
        Assert.Equal(new HealthCheck(5, HealthStatus.Warn, "5 of 5"), CheckOf());
        await _server.Stop().WaitAsync(Patience, Cancelled);
        Assert.Equal(0, _server.Gauges().Counts["largestAddressConnections"]);
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

        // an answer whose client goes as it is sent: held until the server is told, whatever the
        // machine's pace, as no answer is too large to be taken whole by a socket that takes it at
        // once — Windows takes 64 MiB a client never reads before its reset is told
        using (var asking = await Wire.Open(_port))
        {
            await asking.Write(PostHead(connectionToken, "Content-Length: 8"));
            await asking.Write(EnvelopeOf(EnvelopeKind.Request, 1));

            Assert.Equal(200, (await asking.ReadHead()).Status);

            _server.Answering = async (aborted) =>
            {
                asking.Reset();
                await WhenCancelled(aborted);
            };

            Assert.Equal("the exchange closed before its answer went out", (await Assert.ThrowsAsync<IOException>(() =>
            {
                return _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, 1), false), connectionHandle).WaitAsync(Patience, Cancelled);
            })).Message);
        }

        _server.Answering = null;

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

    // spec 15.12.4
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

        // counted, with no length declared: its 16 bytes, once the first 16 were given back, which
        // they are before the envelope is handed on
        await Until(() =>
        {
            return _messages.Count == 1;
        });

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

    // createHTTPTransportServer, CORS

    [Fact]
    public async Task Answers_a_preflight_from_an_origin_it_names_204_naming_it_the_methods_Authorization_the_fields_it_asks_for_in_its_lines_joined_and_any_other_field_for_7200_seconds_and_tells_no_refusal()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        // a preflight's answer, whatever method it asks for: its status, its body's length, and the
        // fields of CORS and of the path
        async Task<string> Preflighted((string Method, string? Fields) asked)
        {
            var request = With(With(new HttpRequestMessage(HttpMethod.Options, Url), ("origin", Page)), ("access-control-request-method", asked.Method));
            using var response = await Fetch(asked.Fields is { } fields ? With(request, ("access-control-request-headers", fields)) : request);

            return $"{(int)response.StatusCode} {(await BytesOf(response)).Length} {CorsOf(response)}";
        }

        // what it asks in two field lines, by hand: HttpClient writes a field's values in one
        async Task<string> PreflightedInLines(string method)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"OPTIONS /bead HTTP/1.1\r\nHost: {Host}\r\nOrigin: {Page}\r\nAccess-Control-Request-Method: {method}\r\nAccess-Control-Request-Headers: bead-after\r\nAccess-Control-Request-Headers: bead-wait\r\n\r\n");

            var (head, body) = await wire.Read();

            return $"{head.Status} {body.Length} {CorsOf(head.Headers)}";
        }

        string AnswerOf(string allowed)
        {
            return $"204 0 {Page} | * | none | GET, POST, DELETE | {allowed} | 7200 | no-store nosniff Origin | unmarked";
        }

        // Authorization, then what it asks as it came, its lines joined by ", ", then any other
        Assert.Equal(
            [
                AnswerOf("authorization, bead-listen,content-type,traceparent,sentry-trace,baggage, *"),
                AnswerOf("authorization, bead-after,bead-connection-token,bead-wait, *"),
                AnswerOf("authorization, bead-after, bead-wait, *"),
                AnswerOf("authorization, *"),
            ],
            [
                await Preflighted(("POST", "bead-listen,content-type,traceparent,sentry-trace,baggage")),
                await Preflighted(("GET", "bead-after,bead-connection-token,bead-wait")),
                await PreflightedInLines("GET"),
                await Preflighted(("PUT", null)),
            ]);
        Assert.Empty(_connections);
        Assert.Empty(_refusals);

        // an OPTIONS that is no preflight is still a method refused, and told
        using (var bare = await Fetch(With(new HttpRequestMessage(HttpMethod.Options, Url), ("origin", Page))))
        {
            Assert.Equal((405, HttpRefusals.Method), ((int)bare.StatusCode, HeaderOf(bare, HttpTransport.RefusalHeader)));
        }

        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });
        Assert.Equal([HttpRefusals.Method], _refusals.Select((refusal) =>
        {
            return refusal.Reason;
        }));
    }

    [Fact]
    public async Task Names_an_origin_it_names_on_every_answer_it_writes_to_it_once_that_origin_is_judged_a_batch_and_a_refusal_among_them_and_exposes_every_field()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        // each request answered by its result, as a router would
        _server.Message += (message, connectionHandle) =>
        {
            if ((EnvelopeKind)message.Bytes.Span[1] == EnvelopeKind.Request)
            {
                _ = _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, BinaryPrimitives.ReadUInt32BigEndian(message.Bytes.Span[4..])), false), connectionHandle);
            }
        };

        // a request from the page: its status, and the fields of CORS and of the path
        async Task<string> Answered(HttpRequestMessage request)
        {
            using var response = await Fetch(With(request, ("origin", Page)));

            await BytesOf(response);

            return $"{(int)response.StatusCode} {CorsOf(response)}";
        }

        HttpRequestMessage ListenAfter(string connectionToken, int after)
        {
            return ListenRequestOf(connectionToken, new() { After = after.ToString(CultureInfo.InvariantCulture), Wait = "0" });
        }

        using var drawn = await Fetch(With(With(PostOf(null, null), (HttpTransport.ListenHeader, "?1")), ("origin", Page)));
        var connectionToken = HeaderOf(drawn, HttpTransport.ConnectionTokenHeader) ?? "";

        await _server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Notification, 1), false), _connections.Last()).WaitAsync(Patience, Cancelled);

        var plain = PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 7));

        plain.Content!.Headers.ContentType = new MediaTypeHeaderValue("text/plain");

        // a connect, a request with its Authorization answered, an envelope handed on, a batch and
        // a listen that brought nothing, a type, a method and a token refused, a DELETE, and a
        // connection gone
        string[] answers =
        [
            $"{(int)drawn.StatusCode} {CorsOf(drawn)}",
            await Answered(With(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 3)), ("authorization", Bearer))),
            await Answered(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Result, 5))),
            await Answered(ListenAfter(connectionToken, 0)),
            await Answered(ListenAfter(connectionToken, 1)),
            await Answered(plain),
            await Answered(new HttpRequestMessage(HttpMethod.Put, Url)),
            await Answered(RequestOf(HttpMethod.Delete, "not a token")),
            await Answered(RequestOf(HttpMethod.Delete, connectionToken)),
            await Answered(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, 9))),
        ];

        // each naming the page, every field exposed, no credential allowed
        string Named(int status, string reason)
        {
            return $"{status} {Page} | * | none | none | none | none | no-store nosniff Origin | {reason}";
        }

        Assert.Equal(
            [
                Named(201, "unmarked"),
                Named(200, "unmarked"),
                Named(204, "unmarked"),
                Named(200, "unmarked"),
                Named(204, "unmarked"),
                Named(415, HttpRefusals.Type),
                Named(405, HttpRefusals.Method),
                Named(400, HttpRefusals.Malformed),
                Named(204, "unmarked"),
                Named(404, HttpRefusals.ConnectionUnknown),
            ],
            answers);
    }

    [Fact]
    public async Task Names_no_origin_to_its_own_to_a_request_with_none_to_one_it_does_not_take_nor_before_the_origin_is_judged_and_varies_every_answer_by_Origin_but_HTTP_s_own_400()
    {
        await Start(new HttpTransportServerOptions { Origins = [Page] });

        var own = $"{Host}:{_port}";

        // a head on a socket of its own: its status, and the fields of CORS and of the path
        async Task<string> Answered(string head)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(head);

            var (answer, _) = await wire.Read();

            return $"{answer.Status} {CorsOf(answer.Headers)}";
        }

        string ConnectWith(string fields)
        {
            return $"POST /bead HTTP/1.1\r\nHost: {own}\r\n{fields}Content-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n";
        }

        static string PreflightOf((string Target, string Host, string Origin) asked)
        {
            return $"OPTIONS {asked.Target} HTTP/1.1\r\nHost: {asked.Host}\r\nOrigin: {asked.Origin}\r\nAccess-Control-Request-Method: POST\r\n\r\n";
        }

        static string Unnamed(int status, string reason)
        {
            return $"{status} none | none | none | none | none | none | no-store nosniff Origin | {reason}";
        }

        const string Bare = "400 none | none | none | none | none | none | none none none | unmarked";

        Assert.Equal(
            [
                Unnamed(201, "unmarked"),
                Unnamed(201, "unmarked"),
                Unnamed(405, HttpRefusals.Method),
                Unnamed(405, HttpRefusals.Method),
                Unnamed(403, HttpRefusals.Origin),
                Unnamed(403, HttpRefusals.Origin),
                Unnamed(403, HttpRefusals.Host),
                Unnamed(404, HttpRefusals.Path),
                Unnamed(400, HttpRefusals.Malformed),
                Bare,
                Bare,
                Bare,
            ],
            [
                // its own origin, and none: a connect, and a preflight, which no browser sends of them
                await Answered(ConnectWith($"Origin: http://{own}\r\n")),
                await Answered(ConnectWith("")),
                await Answered(PreflightOf(("/bead", own, $"http://{own}"))),
                await Answered($"OPTIONS /bead HTTP/1.1\r\nHost: {own}\r\nAccess-Control-Request-Method: POST\r\n\r\n"),

                // an origin it does not take
                await Answered(ConnectWith("Origin: https://elsewhere.test\r\n")),
                await Answered(PreflightOf(("/bead", own, "https://elsewhere.test"))),

                // the page it names, before its origin is judged: by a host it does not take, and at
                // another path
                await Answered(PreflightOf(("/bead", "rebind.example", Page))),
                await Answered(PreflightOf(("/elsewhere", own, Page))),

                // a token that is none, refused of its own, from no page: marked, the path's fields kept
                await Answered($"POST /bead HTTP/1.1\r\nHost: {own}\r\n{HttpTransport.ConnectionTokenHeader}: short\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"),

                // HTTP's own 400, from the page it names: a control character, an octet past ASCII,
                // and an absolute-form target whose authority is no host
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: a\u0007b\r\n")),
                await Answered(ConnectWith($"Origin: {Page}\r\nX-Other: café\r\n")),
                await Answered($"POST http://localhost:/bead HTTP/1.1\r\nHost: {own}\r\nOrigin: {Page}\r\nContent-Type: {HttpTransport.MediaType}\r\nContent-Length: 0\r\n\r\n"),
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

        using var brought = await ListenOf(connectionToken, new() { After = "0", Wait = "0" });

        Assert.Equal(
            (200, HttpTransport.BatchMediaType, "1", "no-store"),
            ((int)brought.StatusCode, brought.Content.Headers.ContentType?.MediaType, HeaderOf(brought, HttpTransport.SequenceHeader), HeaderOf(brought, "cache-control")));
        Assert.Equal(BatchOf(first, second), await BytesOf(brought));

        // not acknowledged: brought back again
        using var again = await ListenOf(connectionToken, new() { After = "0" });

        Assert.Equal(BatchOf(first, second), await BytesOf(again));

        // acknowledged: gone, and nothing left
        using var empty = await ListenOf(connectionToken, new() { After = "2", Wait = "0" });

        Assert.Equal((204, 0), ((int)empty.StatusCode, (await BytesOf(empty)).Length));
    }

    [Fact]
    public async Task Holds_a_listen_until_something_comes_within_its_wait_no_longer_than_its_limit_and_ends_it_empty_past_it()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan, MaximumWait = TimeSpan.FromSeconds(1) });

        var (connectionToken, connectionHandle) = await Connect(true);
        var lapsing = ListenOf(connectionToken, new() { Wait = "60000" });

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

        var held = ListenOf(connectionToken, new() { After = "0", Wait = "500" });
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
        var first = ListenOf(connectionToken, new() { Wait = "20000" });

        await Until(() =>
        {
            return Count("listens") == 1;
        });

        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);

        // the second, on a socket of its own: what it brings back goes nowhere, and is brought back
        // to the next
        using (var second = await Wire.Open(_port))
        {
            await second.Write($"GET /bead HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 20000\r\n\r\n");

            using var ended = await first;

            Assert.Equal((204, 1), ((int)ended.StatusCode, Count("listens")));
            await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);
            second.Reset();
        }

        using var third = await ListenOf(connectionToken, new() { After = "0", Wait = "0" });

        Assert.Equal((200, Convert.ToHexString(BatchOf(envelope))), ((int)third.StatusCode, Convert.ToHexString(await BytesOf(third))));

        // a listen held, lost: what comes next waits for the one after it
        using (var dropped = await Wire.Open(_port))
        {
            await dropped.Write($"GET /bead HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{HttpTransport.AfterHeader}: 1\r\n{HttpTransport.WaitHeader}: 20000\r\n\r\n");
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

        using var next = await ListenOf(connectionToken, new() { After = "1", Wait = "0" });

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
        using var all = await ListenOf(connectionToken, new() { Wait = "0" });
        using var rest = await ListenOf(connectionToken, new() { After = "1", Wait = "0" });

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

        using var response = await ListenOf(listening.ConnectionToken, new() { Wait = "0" });

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
        var withBody = ListenRequestOf(listening.ConnectionToken);

        withBody.Content = new ByteArrayContent(new byte[8]);

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
                await RefusalOf(ListenOf(deaf.ConnectionToken)),
                await RefusalOf(withBody),
                await RefusalOf(ListenOf(listening.ConnectionToken, new() { After = "one" })),
                await RefusalOf(ListenOf(listening.ConnectionToken, new() { Wait = "-1" })),
                await RefusalOf(ListenOf(listening.ConnectionToken, new() { After = "1" })),
                await RefusalOf(With(PostOf(null, null), (HttpTransport.ListenHeader, "yes"))),
                await RefusalOf(new HttpRequestMessage(HttpMethod.Get, Url)),
            ]);

        // `?0` says it does not
        using var declined = await Fetch(With(PostOf(null, null), (HttpTransport.ListenHeader, "?0")));

        Assert.Equal((201, null), ((int)declined.StatusCode, HeaderOf(declined, HttpTransport.ListenHeader)));
        Assert.False(_server.IsTwoWay(_connections.Last()));
    }

    // spec 15.9
    [Fact]
    public async Task Reads_a_listen_s_counts_from_bead_after_and_bead_wait_a_field_given_as_several_lines_joined_and_refuses_400_a_listen_without_bead_after_whatever_its_target_holds()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);
        var envelope = EnvelopeOf(EnvelopeKind.Notification, 1);

        // a listen by hand, its target and its fields as given: its status and its mark
        async Task<(int Status, string? Reason)> Listened((string Target, string Fields) listen)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write($"GET {listen.Target} HTTP/1.1\r\nHost: {Host}\r\n{HttpTransport.ConnectionTokenHeader}: {connectionToken}\r\n{listen.Fields}\r\n");

            var (head, _) = await wire.Read();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader));
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                // its lines joined, as RFC 9110 §5.3 combines them, parse as no Item, alike or not
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                // no bead-after, whatever its target holds: the query is never read
                (400, HttpRefusals.Malformed),
                (400, HttpRefusals.Malformed),
                // with it, whatever its query, a bead-wait left out 0: brought back at once
                (200, null),
                (200, null),
                (200, null),
            ],
            [
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n{HttpTransport.WaitHeader}: 1\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0, 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?after=0&wait=0", "")),
                await Listened(("/bead", $"{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?after=5&x=1", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead?", $"{HttpTransport.AfterHeader}: 0\r\n{HttpTransport.WaitHeader}: 0\r\n")),
                await Listened(("/bead", $"{HttpTransport.AfterHeader}: 0\r\n")),
            ]);
        await Until(() =>
        {
            return _refusals.Count == 5;
        });

        // its parameters ignored (RFC 9651 §2.3): what it acknowledges goes, and nothing is left
        Assert.Equal((204, null), await Listened(("/bead", $"{HttpTransport.AfterHeader}: 1;x=1\r\n{HttpTransport.WaitHeader}: 0;y=\"a;b\"\r\n")));
        Assert.Empty(_closes);
    }

    [Fact]
    public async Task Stamps_a_connection_s_activity_as_an_exchange_of_an_envelope_or_a_listen_begins_never_at_its_connect_nor_at_a_listen_refused()
    {
        await Start();

        var deaf = await Connect();
        var listening = await Connect(true);

        Assert.Equal((409, HttpRefusals.ListenUndeclared), await RefusalOf(ListenOf(deaf.ConnectionToken)));
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

        using var listened = await ListenOf(listening.ConnectionToken, new() { Wait = "0" });

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
                await RefusalOf(ListenOf(deaf.ConnectionToken)),
                await RefusalOf(ListenOf(connectionToken, new() { Wait = "soon" })),
                await RefusalOf(ListenOf(connectionToken, new() { After = "1" })),
            ]);
        Assert.Empty(told);
        Assert.Empty(DelaysSince(before));
        Assert.All(_time.Armed, (armed) =>
        {
            Assert.False(armed.IsCleared);
        });

        // a second in the place of the first, which ends empty: each tells its own
        var first = ListenOf(connectionToken, new() { Wait = "20000" });

        await Until(() =>
        {
            return !told.IsEmpty;
        });

        var second = ListenOf(connectionToken, new() { Wait = "20000" });

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
        using (var acknowledged = await ListenOf(connectionToken, new() { After = "2", Wait = "0" }))
        {
            Assert.Equal(204, (int)acknowledged.StatusCode);
        }

        await _server.Send(new TransportMessage(envelope, false), connectionHandle).WaitAsync(Patience, Cancelled);

        var held = ListenOf(connectionToken, new() { After = "3", Wait = "20000" });

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
        var waiting = RefusalOf(ListenOf(other.ConnectionToken, new() { Wait = "20000" }));

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
        var held = ListenOf(connectionToken, new() { Wait = "20000" });
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

        using var next = await ListenOf(connectionToken, new() { After = "1", Wait = "0" });

        Assert.Equal(BatchOf(second, third), await BytesOf(next));
    }

    [Fact]
    public async Task Ends_a_listen_asked_not_to_wait_at_once_with_nothing_arming_no_timer()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = Timeout.InfiniteTimeSpan });

        var (connectionToken, _) = await Connect(true);
        using var response = await ListenOf(connectionToken, new() { Wait = "0" });

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

        using var response = await ListenOf(connectionToken, new() { Wait = "0" });

        Assert.Equal(BatchOf(notification), await BytesOf(response));
        Assert.Equal((200, 1), ((int)asking.StatusCode, Count("waitingExchanges")));
    }

    [Fact]
    public async Task Does_not_rest_a_connection_whose_listen_is_held_when_another_of_its_exchanges_ends()
    {
        await Start(new HttpTransportServerOptions { InactivityTimeout = TimeSpan.FromSeconds(2) });

        var (connectionToken, _) = await Connect(true);
        var held = ListenOf(connectionToken, new() { Wait = "20000" });

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
        var held = ListenOf(connectionToken, new() { Wait = "20000" });

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

        var held = ListenOf(listening.ConnectionToken, new() { Wait = "20000" });

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
            new Dictionary<string, long> { ["bodyBytes"] = 268_435_456, ["connections"] = 10_000, ["largestAddressConnections"] = 64, ["largestOutboxBytes"] = 64 },
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
                ["largestAddressConnections"] = 3,
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
            (0L, 0L, 0L, 0L, 0L, 0L, 0L),
            (counts["addresses"], counts["bodyBytes"], counts["connections"], counts["largestAddressConnections"], counts["listens"], counts["outboxBytes"], counts["waitingExchanges"]));
    }

    [Fact]
    public async Task Refuses_a_listen_on_a_connection_gone_404_as_any_exchange_on_it()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect(true);

        await _server.CloseConnection(connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal((404, HttpRefusals.ConnectionUnknown), await RefusalOf(ListenOf(connectionToken, new() { Wait = "20000" })));

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
            [await RefusalOf(ListenOf(listening.ConnectionToken, new() { Wait = "20000" })), await RefusalOf(ListenOf(deaf.ConnectionToken, new() { Wait = "20000" }))]);
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
        var listen = ListenOf(listeningToken, new() { Wait = "20000" });

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
