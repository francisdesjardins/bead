using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Interop;
using Bead.Transport.WebSockets;
using Xunit.Sdk;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// Bead's transports' cases, <c>spec/transports.json</c>, played against the C# server of the
/// interop service over HTTP: a peer of the test's own writes each exchange's octets on a socket of
/// its own and reads what the server answers on it, what it reports, and what its transport's
/// gauges say. The TypeScript server plays the same file.
/// </summary>
public sealed class TransportsTests
{
    // constants

    private const string Host = "127.0.0.1";

    // the language a row of the support matrix names when it excuses this side from a case
    private const string Language = "C#";

    private const int ReadBytes = 4_096;

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly HttpTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    // each shape a value drawn takes, in ASCII classes alone: a token, 16 bytes in base64url without
    // padding; a delay, in seconds; an IMF-fixdate
    private static readonly Dictionary<string, Regex> Shapes = new()
    {
        ["token"] = new Regex("^[A-Za-z0-9_-]{21}[AQgw]$", RegexOptions.ECMAScript),
        ["delay-seconds"] = new Regex("^[0-9]+$", RegexOptions.ECMAScript),
        ["http-date"] = new Regex(
            "^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$",
            RegexOptions.ECMAScript),
    };

    private static readonly JsonElement Root = Load();

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "transports.json")));

        return document.RootElement.Clone();
    }

    private static string NameOf(JsonElement entry)
    {
        return entry.GetProperty("name").GetString()!;
    }

    // an entry of one of the file's groups, by its name
    private static JsonElement EntryOf((string Group, string Name) entry)
    {
        foreach (var each in Root.GetProperty(entry.Group).EnumerateArray())
        {
            if (NameOf(each) == entry.Name)
            {
                return each;
            }
        }

        throw new KeyNotFoundException($"no {entry.Group} \"{entry.Name}\"");
    }

    // whether a row of the support matrix excuses this side from a case
    private static bool IsExcused(JsonElement entry)
    {
        return entry.TryGetProperty("differs", out var differs) && differs.EnumerateArray().Any((row) =>
        {
            return row.GetProperty("language").GetString() == Language;
        });
    }

    private static byte[] BytesOf(string hexadecimal)
    {
        return Convert.FromHexString(hexadecimal.Replace(" ", "", StringComparison.Ordinal).Replace("|", "", StringComparison.Ordinal));
    }

    private static TimeSpan TimeOf(JsonElement milliseconds)
    {
        return TimeSpan.FromMilliseconds(milliseconds.GetInt64());
    }

    private static string[] TextsOf(JsonElement texts)
    {
        return [.. texts.EnumerateArray().Select((text) =>
        {
            return text.GetString()!;
        })];
    }

    // the transport's options, the case's where it gives them, by the names section 15.12 gives
    private static HttpTransportServerOptions OptionsOf(JsonElement entry)
    {
        var options = new HttpTransportServerOptions();

        if (!entry.TryGetProperty("options", out var given))
        {
            return options;
        }

        foreach (var option in given.EnumerateObject())
        {
            var value = option.Value;

            options = option.Name switch
            {
                "maximumConnections" => options with { MaximumConnections = value.GetInt32() },
                "maximumConnectionsPerAddress" => options with { MaximumConnectionsPerAddress = value.GetInt32() },
                "maximumWaitingExchanges" => options with { MaximumWaitingExchanges = value.GetInt32() },
                "bodyBytesBudget" => options with { BodyBytesBudget = value.GetInt64() },
                "maximumBodyBytes" => options with { MaximumBodyBytes = value.GetInt32() },
                "maximumOutboxBytes" => options with { MaximumOutboxBytes = value.GetInt64() },
                "maximumWait" => options with { MaximumWait = TimeOf(value) },
                "exchangeTimeout" => options with { ExchangeTimeout = TimeOf(value) },
                "inactivityTimeout" => options with { InactivityTimeout = TimeOf(value) },
                "hosts" => options with { Hosts = TextsOf(value) },
                "origins" => options with { Origins = TextsOf(value) },
                "isProxyTrusted" => options with { IsProxyTrusted = value.GetBoolean() },
                _ => throw new ArgumentException($"a case sets an option no test reads: {option.Name}", nameof(entry)),
            };
        }

        return options;
    }

    // this side's default of a bound the file names, in milliseconds for a time
    private static long DefaultOf(string bound)
    {
        var http = new HttpTransportServerOptions();
        var webSocket = new WebSocketTransportServerOptions();

        return bound switch
        {
            "maximumConnections" => http.MaximumConnections,
            "maximumConnectionsPerAddress" => http.MaximumConnectionsPerAddress,
            "maximumWaitingExchanges" => http.MaximumWaitingExchanges,
            "bodyBytesBudget" => http.BodyBytesBudget,
            "maximumBodyBytes" => http.MaximumBodyBytes,
            "maximumOutboxBytes" => http.MaximumOutboxBytes,
            "maximumWait" => (long)http.MaximumWait.TotalMilliseconds,
            "exchangeTimeout" => (long)http.ExchangeTimeout.TotalMilliseconds,
            "inactivityTimeout" => (long)http.InactivityTimeout.TotalMilliseconds,

            // the WebSocket server takes its router's largest envelope when its transport's options give none
            "maximumMessageBytes" => webSocket.MaximumMessageBytes ?? RouterLimits.Default.MaximumEnvelopeBytes,
            "heartbeat" => (long)webSocket.Heartbeat.TotalMilliseconds,
            _ => throw new ArgumentException($"the file states a default no test reads: {bound}", nameof(bound)),
        };
    }

    // an envelope sent, as a case writes what it expects; one that is none, as its bytes
    private static string OutOf(ReadOnlyMemory<byte> bytes)
    {
        Envelope envelope;

        try
        {
            envelope = EnvelopeCodec.ReadEnvelope(
                bytes.Span,
                new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!;
        }
        catch (FailureException)
        {
            return $"no envelope: {Convert.ToHexString(bytes.Span)}";
        }

        var callId = envelope.Header.CallId;
        var kind = (int)envelope.Kind;

        var session = envelope.Header switch
        {
            ResultHeader { Session: { } announced } => announced.IsEnded ? " ended" : " announced",
            FailureHeader { Session: { } announced } => announced.IsEnded ? " ended" : " announced",
            _ => "",
        };

        if (envelope.Failure is { } failure)
        {
            return $"{kind} {callId} failure {failure.Code} {(int)failure.Scope} through {failure.Relays}{session}";
        }

        return envelope.Header switch
        {
            ResultHeader { Total: { } total } => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{session} total {total}",
            ResultHeader or NotificationHeader => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{session}",
            ChunkHeader chunk => $"{kind} {callId} from {chunk.Offset}{(chunk.IsLast ? " last" : "")} {Convert.ToHexString(envelope.Payload.Span)}",
            CreditHeader credit => $"{kind} {callId} credit {credit.CreditEnd}",

            // a command the server sends its client, with its flags, the envelope's byte 2 as sent
            RequestHeader request => $"{kind} {callId} flags {bytes.Span[2]} {request.ServiceId}/{request.ProcedureId} {Convert.ToHexString(envelope.Payload.Span)}",
            _ => $"{kind} {callId}",
        };
    }

    // what a case expects of an envelope, written as OutOf writes what was sent
    private static string ExpectedOf(JsonElement expected)
    {
        var kind = expected.GetProperty("kind").GetInt32();
        var callId = expected.GetProperty("callId").GetUInt32();

        var session = expected.TryGetProperty("session", out var announced) ? $" {announced.GetString()}" : "";

        if (expected.TryGetProperty("failure", out var failure))
        {
            return $"{kind} {callId} failure {failure.GetProperty("code").GetInt32()} {failure.GetProperty("scope").GetInt32()} through {failure.GetProperty("relays").GetInt32()}{session}";
        }

        var hexadecimal = expected.TryGetProperty("payload", out var payload)
            ? Convert.ToHexString(BytesOf(payload.GetString()!))
            : null;

        if (expected.TryGetProperty("procedureId", out var procedureId))
        {
            return $"{kind} {callId} flags {expected.GetProperty("flags").GetInt32()} {expected.GetProperty("serviceId").GetInt32()}/{procedureId.GetInt32()} {hexadecimal}";
        }

        if (expected.TryGetProperty("offset", out var offset))
        {
            return $"{kind} {callId} from {offset.GetInt64()}{(expected.GetProperty("isLast").GetBoolean() ? " last" : "")} {hexadecimal}";
        }

        if (expected.TryGetProperty("creditEnd", out var creditEnd))
        {
            return $"{kind} {callId} credit {creditEnd.GetInt64()}";
        }

        var total = expected.TryGetProperty("total", out var declared) ? $" total {declared.GetInt64()}" : "";

        return hexadecimal is null ? $"{kind} {callId}" : $"{kind} {callId} {hexadecimal}{session}{total}";
    }

    // a batch's envelopes, each after its length on 4 bytes, big-endian, as OutOf writes each; a
    // batch cut short, as its bytes left
    private static List<string> BatchOf(byte[] batch)
    {
        var envelopes = new List<string>();

        for (var at = 0; at < batch.Length;)
        {
            var length = batch.Length - at < 4 ? -1 : (long)BinaryPrimitives.ReadUInt32BigEndian(batch.AsSpan(at));

            if (length < 0 || at + 4 + length > batch.Length)
            {
                envelopes.Add($"no batch: {Convert.ToHexString(batch.AsSpan(at))}");

                return envelopes;
            }

            envelopes.Add(OutOf(batch.AsMemory(at + 4, (int)length)));
            at += 4 + (int)length;
        }

        return envelopes;
    }

    private static string BodyOf(byte[] body)
    {
        return body.Length == 0 ? "body: none" : $"body: {Convert.ToHexString(body)}";
    }

    // a field as a case expects it: its value, absent, or of a shape
    private static string ExpectedFieldOf(JsonElement expected)
    {
        return expected.ValueKind switch
        {
            JsonValueKind.String => expected.GetString()!,
            JsonValueKind.Null => "absent",
            _ => $"a {expected.GetProperty("shape").GetString()}",
        };
    }

    // a field as it came, written as ExpectedFieldOf writes what it expects of it
    private static string FieldOf((JsonElement Expected, string? Value) field)
    {
        if (field.Value is null)
        {
            return "absent";
        }

        if (field.Expected.ValueKind == JsonValueKind.Object)
        {
            var shape = field.Expected.GetProperty("shape").GetString()!;

            return Shapes[shape].IsMatch(field.Value) ? $"a {shape}" : field.Value;
        }

        return field.Value;
    }

    // definition

    /// <summary>The names of every case this side plays: each but those a row of the support matrix excuses it from.</summary>
    public static TheoryData<string> Names { get; } = new(
        Root.GetProperty("cases").EnumerateArray().Where((entry) =>
        {
            return !IsExcused(entry);
        }).Select(NameOf));

    /// <summary>The names of the responses every side's reader reads alike.</summary>
    public static TheoryData<string> Responses { get; } = new(Root.GetProperty("responses").EnumerateArray().Select(NameOf));

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        var entry = EntryOf(("cases", name));
        var steps = entry.GetProperty("steps").EnumerateArray().ToList();

        // the server layer as HttpServer composes it, built by hand: HttpServer sizes its transport's
        // body on its router's envelope, where a case bounds the body on its own, as the TypeScript
        // side's harness does; all else as HttpServer sets it
        var transport = new HttpTransportServer(OptionsOf(entry));

        await using var server = new Server<string>(transport, new ServerOptions
        {
            ConnectionInactivityTimeout = HttpServerOptions.ConnectionInactivityTimeoutDefault,
            Limits = RouterLimits.WholeEnvelopeOf(null),
        });

        InteropService.Offer(server);

        // dropped before the server stops: the sockets its exchanges went on
        using var peer = new Peer((server, transport));

        await peer.Start();

        for (var index = 0; index < steps.Count; index += 1)
        {
            try
            {
                await peer.Take(steps[index]);
            }
            catch (Exception reason) when (reason is not OperationCanceledException)
            {
                throw new XunitException($"step {index + 1}, {Peer.Describe(steps[index])}: {reason.Message}", reason is XunitException ? null : reason);
            }
        }

        peer.NothingMore();
    }

    [Theory]
    [MemberData(nameof(Responses))]
    public async Task Reads_a_response_by_its_length_or_de_chunked_whatever_reads_it_comes_in(string name)
    {
        var response = EntryOf(("responses", name));
        var pieces = new Pieces([.. response.GetProperty("pieces").EnumerateArray().Select((piece) =>
        {
            return BytesOf(piece.GetString()!);
        })]);
        var reader = new Reader(pieces.Read);

        var head = await reader.ReadHead();
        var body = await reader.ReadBody(head);
        var fields = response.GetProperty("fields").EnumerateObject().ToList();

        Assert.Equal(response.GetProperty("status").GetInt32(), head.Status);
        Assert.Equal(
            fields.Select((field) =>
            {
                return $"{field.Name}: {field.Value.GetString()}";
            }),
            fields.Select((field) =>
            {
                return $"{field.Name}: {head.Fields.GetValueOrDefault(field.Name) ?? "absent"}";
            }));
        Assert.Equal(BodyOf(BytesOf(response.GetProperty("body").GetString()!)), BodyOf(body));
    }

    [Fact]
    public void Bounds_default_to_what_the_file_states()
    {
        var defaults = Root.GetProperty("defaults").EnumerateObject().ToList();

        Assert.Equal(
            defaults.Select((bound) =>
            {
                return $"{bound.Name} {bound.Value.GetInt64()}";
            }),
            defaults.Select((bound) =>
            {
                return $"{bound.Name} {DefaultOf(bound.Name)}";
            }));
    }

    [Fact]
    public void Plays_every_case_but_those_a_row_of_the_support_matrix_excuses_this_side_from()
    {
        var cases = Root.GetProperty("cases").EnumerateArray().ToList();
        var played = Names.Select((row) =>
        {
            return row.Data;
        }).ToHashSet();

        // each case plays under its own name
        Assert.Equal(cases.Count, cases.Select(NameOf).Distinct().Count());
        Assert.All(cases, (entry) =>
        {
            Assert.Equal(!IsExcused(entry), played.Contains(NameOf(entry)));
        });
    }

    // a case played: the server under test, the exchanges a peer of the test's own opened by name,
    // the values it captured, and what the server reported that no step took yet
    private sealed class Peer : IDisposable
    {
        private readonly HttpTransportServer _transport;
        private readonly Dictionary<string, Exchange> _exchanges = [];
        private readonly Dictionary<string, string> _captured = [];
        private readonly ConcurrentQueue<string> _reports = new();
        private int _port;

        public Peer((Server<string> Server, HttpTransportServer Transport) served)
        {
            _transport = served.Transport;

            // what the server reports: a failure's code, or an exception, which carries none
            served.Server.Router.Error += (reason, _) =>
            {
                _reports.Enqueue(reason is FailureException failure ? failure.Code.ToString(CultureInfo.InvariantCulture) : "exception");
            };
        }

        // a step in a few words: what it does, and on which exchange
        public static string Describe(JsonElement step)
        {
            var kind = step.EnumerateObject().First((property) =>
            {
                return property.Name != "on";
            }).Name;

            return step.TryGetProperty("on", out var on) ? $"{kind} on {on.GetString()}" : kind;
        }

        public async Task Start()
        {
            _port = (await _transport.Start(Loopback, Cancelled)).Port;
        }

        public async Task Take(JsonElement step)
        {
            var on = step.TryGetProperty("on", out var named) ? named.GetString()! : "";

            if (step.TryGetProperty("send", out var send))
            {
                NothingMore();
                await Send((send, on));
            }
            else if (step.TryGetProperty("expect", out var expected))
            {
                await Expect((expected, on));
            }
            else if (step.TryGetProperty("close", out _))
            {
                NothingMore();
                _exchanges[on].Dispose();
                _exchanges.Remove(on);
            }
            else if (step.TryGetProperty("until", out var until))
            {
                await Until(until);
            }
            else if (step.TryGetProperty("report", out var report))
            {
                await Report(report);
            }
            else
            {
                throw new ArgumentException($"a step no test plays: {Describe(step)}", nameof(step));
            }
        }

        // the server reported nothing that no step took
        public void NothingMore()
        {
            Assert.Empty(_reports);
        }

        public void Dispose()
        {
            foreach (var exchange in _exchanges.Values)
            {
                exchange.Dispose();
            }

            _exchanges.Clear();
        }

        // a request's octets, on a socket of its own: its head, the server's host and each value
        // captured put in, then its body
        private async Task Send((JsonElement Request, string On) step)
        {
            var head = step.Request.GetProperty("head").GetString()!.Replace("{host}", $"{Host}:{_port}", StringComparison.Ordinal);

            foreach (var (name, value) in _captured)
            {
                head = head.Replace($"{{{name}}}", value, StringComparison.Ordinal);
            }

            byte[] body = step.Request.TryGetProperty("body", out var given) ? BytesOf(given.GetString()!) : [];

            if (_exchanges.Remove(step.On, out var before))
            {
                before.Dispose();
            }

            _exchanges[step.On] = await Exchange.Send((_port, [.. Encoding.ASCII.GetBytes(head), .. body]));
        }

        // the response on an exchange: its head within a patience, then, when the case expects
        // anything of it, its body, or that its socket was cut first; each written alike as expected
        // and as it came
        private async Task Expect((JsonElement Response, string On) step)
        {
            var (response, on) = step;
            var exchange = _exchanges[on];
            var expected = new List<string> { $"status {response.GetProperty("status").GetInt32()}" };
            Head head;

            try
            {
                head = await exchange.Head.WaitAsync(Patience, Cancelled);
            }
            catch (IOException reason)
            {
                throw new XunitException($"expected {expected[0]}\n    came no head, its socket cut: {reason.Message}");
            }

            var came = new List<string> { $"status {head.Status}" };

            if (response.TryGetProperty("fields", out var fields))
            {
                foreach (var field in fields.EnumerateObject())
                {
                    var value = head.Fields.GetValueOrDefault(field.Name);

                    expected.Add($"{field.Name}: {ExpectedFieldOf(field.Value)}");
                    came.Add($"{field.Name}: {FieldOf((field.Value, value))}");

                    if (value is not null && field.Value.ValueKind == JsonValueKind.Object && field.Value.TryGetProperty("capture", out var capture))
                    {
                        _captured[capture.GetString()!] = value;
                    }
                }
            }

            if (response.TryGetProperty("body", out var body))
            {
                expected.Add(BodyOf(BytesOf(body.GetString()!)));
                came.Add(await exchange.BodyWithin() is { } bytes ? BodyOf(bytes) : "body: cut");
            }

            if (response.TryGetProperty("envelope", out var envelope))
            {
                expected.Add(ExpectedOf(envelope));
                came.Add(await exchange.BodyWithin() is { } bytes ? OutOf(bytes) : "body: cut");
            }

            if (response.TryGetProperty("batch", out var batch))
            {
                expected.AddRange(batch.EnumerateArray().Select(ExpectedOf));
                came.AddRange(await exchange.BodyWithin() is { } bytes ? BatchOf(bytes) : ["body: cut"]);
            }

            var (wanted, got) = (string.Join("; ", expected), string.Join("; ", came));

            if (wanted != got)
            {
                Assert.Fail($"expected {wanted}\n    came {got}");
            }
        }

        // a gauge of the transport, read until it has its value, within a patience
        private async Task Until(JsonElement until)
        {
            var gauge = until.GetProperty("gauge").GetString()!;
            var value = until.GetProperty("is").GetInt64();
            var watch = Stopwatch.StartNew();

            while (CountOf(gauge) != value && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
            }

            Assert.Equal($"{gauge} {value}", $"{gauge} {CountOf(gauge)}");
        }

        private long CountOf(string gauge)
        {
            return _transport.Gauges().Counts[gauge];
        }

        // the next report, within a patience
        private async Task Report(JsonElement report)
        {
            var expected = report.ValueKind == JsonValueKind.Number ? report.GetInt32().ToString(CultureInfo.InvariantCulture) : report.GetString();
            var watch = Stopwatch.StartNew();

            while (_reports.IsEmpty && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
            }

            Assert.Equal($"report {expected}", _reports.TryDequeue(out var came) ? $"report {came}" : "no report");
        }
    }

    /// <summary>A response's head: its status, and its fields by their names in lower case.</summary>
    private sealed record Head(int Status, IReadOnlyDictionary<string, string> Fields);

    // an exchange: the socket of its own a request went on, and its response, read as it comes —
    // its head at once, its body after it
    private sealed class Exchange : IDisposable
    {
        private readonly TcpClient _tcp;

        private Exchange(TcpClient tcp)
        {
            var stream = tcp.GetStream();
            var reader = new Reader((buffer) =>
            {
                return stream.ReadAsync(buffer, Cancelled);
            });

            _tcp = tcp;
            Head = reader.ReadHead();
            Body = BodyAfter((reader, Head));
        }

        public Task<Head> Head { get; }

        public Task<byte[]> Body { get; }

        // the request's octets written whole, its response read from before they go: a refusal on
        // the head alone comes before the server lets go of the socket
        public static async Task<Exchange> Send((int Port, byte[] Octets) request)
        {
            var tcp = new TcpClient();

            try
            {
                await tcp.ConnectAsync(IPAddress.Loopback, request.Port, Cancelled);

                var exchange = new Exchange(tcp);

                await tcp.GetStream().WriteAsync(request.Octets, Cancelled);

                return exchange;
            }
            catch
            {
                tcp.Dispose();

                throw;
            }
        }

        // its body within a patience; none when its socket was cut before it came whole
        public async Task<byte[]?> BodyWithin()
        {
            try
            {
                return await Body.WaitAsync(Patience, Cancelled);
            }
            catch (IOException)
            {
                return null;
            }
        }

        public void Dispose()
        {
            _tcp.Dispose();
        }

        private static async Task<byte[]> BodyAfter((Reader Reader, Task<Head> Head) response)
        {
            return await response.Reader.ReadBody(await response.Head);
        }
    }

    // a response as the file's comment reads one, from whatever reads it comes in: its status line,
    // its fields, and its body by its length, de-chunked, or to the end of what comes
    private sealed class Reader(Func<Memory<byte>, ValueTask<int>> read)
    {
        // what came and is not read yet
        private readonly List<byte> _came = [];

        public async Task<Head> ReadHead()
        {
            var statusLine = await ReadLine();
            var fields = new Dictionary<string, string>();

            for (var line = await ReadLine(); line.Length > 0; line = await ReadLine())
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);
                var name = line[..colon].Trim().ToLowerInvariant();
                var value = line[(colon + 1)..].Trim();

                fields[name] = fields.TryGetValue(name, out var before) ? $"{before}, {value}" : value;
            }

            return new Head(int.Parse(statusLine.Split(' ')[1], CultureInfo.InvariantCulture), fields);
        }

        public async Task<byte[]> ReadBody(Head head)
        {
            // a 1xx, a 204 or a 304 has none (RFC 9112, section 6.3)
            if (head.Status is (>= 100 and < 200) or 204 or 304)
            {
                return [];
            }

            if (head.Fields.TryGetValue("transfer-encoding", out var coding) && coding.EndsWith("chunked", StringComparison.OrdinalIgnoreCase))
            {
                return await ReadChunks();
            }

            if (head.Fields.TryGetValue("content-length", out var length))
            {
                return await ReadExactly(int.Parse(length, CultureInfo.InvariantCulture));
            }

            while (await Fill())
            {
                // to the end of what comes
            }

            return Take(_came.Count);
        }

        // a chunk's size, its extensions aside
        private static int SizeOf(string line)
        {
            var semicolon = line.IndexOf(';', StringComparison.Ordinal);

            return int.Parse(semicolon < 0 ? line : line[..semicolon], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        private async Task<byte[]> ReadChunks()
        {
            var body = new List<byte>();

            for (var size = SizeOf(await ReadLine()); size > 0; size = SizeOf(await ReadLine()))
            {
                body.AddRange(await ReadExactly(size));
                await ReadLine();
            }

            // its trailer, up to the line that ends it
            while ((await ReadLine()).Length > 0)
            {
                // a trailer field, which no case reads
            }

            return [.. body];
        }

        // whether more came: false at the end of what comes
        private async Task<bool> Fill()
        {
            var buffer = new byte[ReadBytes];
            var count = await read(buffer);

            _came.AddRange(buffer.AsSpan(0, count));

            return count > 0;
        }

        private byte[] Take(int count)
        {
            var bytes = CollectionsMarshal.AsSpan(_came)[..count].ToArray();

            _came.RemoveRange(0, count);

            return bytes;
        }

        private async Task<byte[]> ReadExactly(int count)
        {
            while (_came.Count < count)
            {
                if (!await Fill())
                {
                    throw new IOException($"the response ended {count - _came.Count} bytes short");
                }
            }

            return Take(count);
        }

        private async Task<string> ReadLine()
        {
            var end = CollectionsMarshal.AsSpan(_came).IndexOf("\r\n"u8);

            while (end < 0)
            {
                if (!await Fill())
                {
                    throw new IOException("the response ended within a line");
                }

                end = CollectionsMarshal.AsSpan(_came).IndexOf("\r\n"u8);
            }

            return Encoding.ASCII.GetString(Take(end + 2), 0, end);
        }
    }

    // reads that come as the given pieces, one by one, then the end
    private sealed class Pieces(byte[][] pieces)
    {
        private readonly Queue<byte[]> _left = new(pieces);
        private byte[] _piece = [];
        private int _offset;

        public ValueTask<int> Read(Memory<byte> buffer)
        {
            while (_offset == _piece.Length)
            {
                if (!_left.TryDequeue(out var next))
                {
                    return ValueTask.FromResult(0);
                }

                (_piece, _offset) = (next, 0);
            }

            var count = Math.Min(_piece.Length - _offset, buffer.Length);

            _piece.AsSpan(_offset, count).CopyTo(buffer.Span);
            _offset += count;

            return ValueTask.FromResult(count);
        }
    }
}
