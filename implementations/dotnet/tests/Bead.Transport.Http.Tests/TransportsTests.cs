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
using System.Threading.Channels;
using Bead.Interop;
using Bead.Tests;
using Bead.Transport.WebSockets;
using Xunit.Sdk;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// Bead's transports' cases, <c>spec/transports.json</c>, played against the C# servers of the
/// interop service, over HTTP and over WebSocket: a peer of the test's own writes each exchange's
/// octets on a socket of its own — a WebSocket's frames among them, once its handshake is answered
/// — and reads what the server sends back on it, what it reports, and what its transport's gauges
/// say, on a clock the case alone advances. The TypeScript servers play the same file.
/// </summary>
public sealed class TransportsTests
{
    // constants

    private const string Host = "127.0.0.1";

    // the language a row of the support matrix names when it excuses this side from a case
    private const string Language = "C#";

    private const int ReadBytes = 4_096;

    // a WebSocket's opcodes (RFC 6455, section 5.2)
    private const int Continuation = 0x0;
    private const int Text = 0x1;
    private const int Binary = 0x2;
    private const int Closing = 0x8;
    private const int Ping = 0x9;
    private const int Pong = 0xA;

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly HttpTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    private static readonly WebSocketTransportStartOptions WebSocketLoopback = new() { Address = Host, FindOpenPort = true };

    // what masks each frame the peer writes, as a client's must be: RFC 6455's own example (section 5.7)
    private static readonly byte[] MaskingKey = [0x37, 0xFA, 0x21, 0x3D];

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

    // where every case's wall clock starts
    private static readonly DateTimeOffset WallClock = DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);

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

    // whether a case is of a transport this player plays: over a broker, the core's player plays it
    // (BrokerTransportsTests)
    private static bool IsPlayedHere(JsonElement entry)
    {
        return entry.GetProperty("transport").GetString() is "http" or "websocket";
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

    // a time in whole milliseconds, as a failure tells it
    private static string MillisecondsOf(TimeSpan time)
    {
        return Math.Round(time.TotalMilliseconds, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture);
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
                "trustedProxies" => options with { TrustedProxies = TextsOf(value) },
                "unnamedProxies" => options with { UnnamedProxies = value.GetInt32() },
                "minimumSendBytesPerSecond" => options with { MinimumSendBytesPerSecond = value.GetInt32() },
                "sendGracePeriod" => options with { SendGracePeriod = TimeOf(value) },
                "headersTimeout" => options with { HeadersTimeout = TimeOf(value) },
                "minimumBodyBytesPerSecond" => options with { MinimumBodyBytesPerSecond = value.GetInt32() },
                "bodyGracePeriod" => options with { BodyGracePeriod = TimeOf(value) },

                // the server layer's, which ConnectionInactivityTimeoutOf reads
                "connectionInactivityTimeout" => options,
                _ => throw new ArgumentException($"a case sets an option no test reads: {option.Name}", nameof(entry)),
            };
        }

        return options;
    }

    // the HTTP server's own connection timeout, on its server layer: the case's where it gives one
    private static TimeSpan ConnectionInactivityTimeoutOf(JsonElement entry)
    {
        if (entry.TryGetProperty("options", out var given) && given.TryGetProperty("connectionInactivityTimeout", out var timeout))
        {
            return TimeOf(timeout);
        }

        return HttpServerOptions.ConnectionInactivityTimeoutDefault;
    }

    // a WebSocket transport's options, the case's where it gives them, by the names section 15.3 gives
    private static WebSocketTransportServerOptions WebSocketOptionsOf(JsonElement entry)
    {
        var options = new WebSocketTransportServerOptions();

        if (!entry.TryGetProperty("options", out var given))
        {
            return options;
        }

        foreach (var option in given.EnumerateObject())
        {
            options = option.Name switch
            {
                "maximumMessageBytes" => options with { MaximumMessageBytes = option.Value.GetInt32() },
                "heartbeat" => options with { Heartbeat = TimeOf(option.Value) },
                "hosts" => options with { Hosts = TextsOf(option.Value) },
                "origins" => options with { Origins = TextsOf(option.Value) },
                "trustedProxies" => options with { TrustedProxies = TextsOf(option.Value) },
                "unnamedProxies" => options with { UnnamedProxies = option.Value.GetInt32() },
                "maximumConnections" => options with { MaximumConnections = option.Value.GetInt32() },
                "maximumConnectionsPerAddress" => options with { MaximumConnectionsPerAddress = option.Value.GetInt32() },
                "minimumSendBytesPerSecond" => options with { MinimumSendBytesPerSecond = option.Value.GetInt32() },
                "sendGracePeriod" => options with { SendGracePeriod = TimeOf(option.Value) },
                "maximumUnsentBytes" => options with { MaximumUnsentBytes = option.Value.GetInt64() },
                "headersTimeout" => options with { HeadersTimeout = TimeOf(option.Value) },
                _ => throw new ArgumentException($"a case sets an option no test reads: {option.Name}", nameof(entry)),
            };
        }

        return options;
    }

    // the router's limits, the case's where it gives them, as conversations.json gives them
    private static RouterLimits LimitsOf(JsonElement entry)
    {
        var limits = RouterLimits.Default;

        if (!entry.TryGetProperty("limits", out var given))
        {
            return limits;
        }

        foreach (var limit in given.EnumerateObject())
        {
            var value = limit.Value.GetInt32();

            limits = limit.Name switch
            {
                "maximumEnvelopeBytes" => limits with { MaximumEnvelopeBytes = value },
                "chunkBytes" => limits with { ChunkBytes = value },
                "windowBytes" => limits with { WindowBytes = value },
                "maximumTransfers" => limits with { MaximumTransfers = value },
                "maximumPayloadBytes" => limits with { MaximumPayloadBytes = value },
                "bufferedBytesBudget" => limits with { BufferedBytesBudget = value },
                "maximumChunkRuns" => limits with { MaximumChunkRuns = value },
                "maximumDetailBytes" => limits with { MaximumDetailBytes = value },
                "maximumAnsweringCalls" => limits with { MaximumAnsweringCalls = value },
                "transferInactivityTimeout" => limits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(value) },
                _ => throw new ArgumentException($"a case sets a limit no test reads: {limit.Name}", nameof(entry)),
            };
        }

        return limits;
    }

    // the server's credentials, the interop service's on its clock: no JWT key and no key set under
    // limits whose chunk or envelope is under 1,024 bytes, which section 12.2 forbids beside them
    private static Credentials CredentialsOf((RouterLimits Limits, TimeProvider Clock) server)
    {
        var credentials = InteropCredentials.Of(server.Clock);

        return server.Limits.ChunkBytes < 1_024 || server.Limits.MaximumEnvelopeBytes < 1_024
            ? credentials with { Keys = [], KeySet = null }
            : credentials;
    }

    // the server under test, of the case's transport, the interop service offered on it: on a clock
    // that settles once its router and its resolvers, which share one scheduler, are idle
    private static Served ServedOf(JsonElement entry)
    {
        var scheduler = new SerialScheduler();
        var runsOn = (new SteppingClock(WallClock) { Settle = scheduler.WhenIdle }, scheduler);

        return entry.GetProperty("transport").GetString() switch
        {
            "http" => OverHttp(entry, runsOn),
            "websocket" => OverWebSocket(entry, runsOn),
            var other => throw new ArgumentException($"a case of a transport no test plays: {other}", nameof(entry)),
        };
    }

    // the server layer as HttpServer composes it, built by hand: HttpServer sizes its transport's
    // body on its router's envelope, where a case bounds the body on its own, as the TypeScript
    // side's harness does; its clock and scheduler the harness's; its own connection timeout the
    // case's, where it gives one; all else as HttpServer sets it
    private static Served OverHttp(JsonElement entry, (SteppingClock Clock, SerialScheduler Scheduler) runsOn)
    {
        var transport = new HttpTransportServer(OptionsOf(entry) with { Clock = runsOn.Clock });
        var limits = RouterLimits.WholeEnvelopeOf(LimitsOf(entry));
        var server = new Server<string>(transport, new ServerOptions
        {
            ConnectionInactivityTimeout = ConnectionInactivityTimeoutOf(entry),
            Credentials = CredentialsOf((limits, runsOn.Clock)),
            Limits = limits,
            ResolverScheduler = runsOn.Scheduler,
            Scheduler = runsOn.Scheduler,
        });

        InteropHandlers.Offer(server);

        return new Served
        {
            Clients = () =>
            {
                return transport.Clients;
            },
            Clock = runsOn.Clock,
            Gauges = transport.Gauges,
            Router = server.Router,
            Server = server,
            Start = async () =>
            {
                return (await transport.Start(Loopback, Cancelled)).Port;
            },
            Transport = transport,
            Stop = () =>
            {
                return server.DisposeAsync().AsTask();
            },
        };
    }

    // the WebSocket server as the interop server serves it: the case's options on its transport,
    // its limits on its router
    private static Served OverWebSocket(JsonElement entry, (SteppingClock Clock, SerialScheduler Scheduler) runsOn)
    {
        var limits = LimitsOf(entry);
        var server = new WebSocketServer<string>(new WebSocketServerOptions
        {
            Server = new ServerOptions
            {
                Credentials = CredentialsOf((limits, runsOn.Clock)),
                Limits = limits,
                ResolverScheduler = runsOn.Scheduler,
                Scheduler = runsOn.Scheduler,
            },
            Transport = WebSocketOptionsOf(entry) with { Clock = runsOn.Clock },
        });
        var transport = server.Transport;

        InteropHandlers.Offer(server);

        return new Served
        {
            Clients = () =>
            {
                return transport.Clients;
            },
            Clock = runsOn.Clock,
            Gauges = transport.Gauges,
            Router = server.Router,
            Server = server,
            Start = async () =>
            {
                return (await transport.Start(WebSocketLoopback, Cancelled)).Port;
            },
            Transport = transport,
            Stop = () =>
            {
                return server.DisposeAsync().AsTask();
            },
        };
    }

    // a frame of the peer's, masked as a client's must be, its payload's length in 7, 16 or 64 bits
    // as its size needs (RFC 6455, section 5.2)
    private static byte[] FrameOf((int Opcode, bool IsFinal, byte[] Payload) frame)
    {
        var (opcode, isFinal, payload) = frame;
        var bytes = new List<byte> { (byte)((isFinal ? 0x80 : 0) | opcode) };

        if (payload.Length < 126)
        {
            bytes.Add((byte)(0x80 | payload.Length));
        }
        else if (payload.Length <= ushort.MaxValue)
        {
            var length = new byte[2];

            BinaryPrimitives.WriteUInt16BigEndian(length, (ushort)payload.Length);
            bytes.Add(0x80 | 126);
            bytes.AddRange(length);
        }
        else
        {
            var length = new byte[8];

            BinaryPrimitives.WriteUInt64BigEndian(length, (ulong)payload.Length);
            bytes.Add(0x80 | 127);
            bytes.AddRange(length);
        }

        bytes.AddRange(MaskingKey);
        bytes.AddRange(payload.Select((octet, index) =>
        {
            return (byte)(octet ^ MaskingKey[index % MaskingKey.Length]);
        }));

        return [.. bytes];
    }

    // a frame of the server's: its opcode, whether it ends its message, and its payload, unmasked
    private static async Task<(int Opcode, bool IsFinal, byte[] Payload)> FrameFrom(Reader reader)
    {
        var head = await reader.ReadExactly(2);
        var length = (long)(head[1] & 0x7F);

        if (length == 126)
        {
            length = BinaryPrimitives.ReadUInt16BigEndian(await reader.ReadExactly(2));
        }
        else if (length == 127)
        {
            length = (long)BinaryPrimitives.ReadUInt64BigEndian(await reader.ReadExactly(8));
        }

        var key = (head[1] & 0x80) == 0 ? null : await reader.ReadExactly(4);
        var payload = await reader.ReadExactly((int)length);

        for (var index = 0; key is not null && index < payload.Length; index += 1)
        {
            payload[index] ^= key[index % key.Length];
        }

        return (head[0] & 0x0F, (head[0] & 0x80) != 0, payload);
    }

    // what the server sent on a WebSocket, written as a case writes what it expects: a binary
    // message as the envelope it holds, where one is expected
    private static string HeardOf((Heard Heard, string Expected) came)
    {
        var (heard, expected) = came;

        return heard.Kind switch
        {
            Binary when expected == "envelope" => $"envelope {OutOf(heard.Bytes)}",
            Binary => $"binary {Convert.ToHexString(heard.Bytes)}",
            Text => $"text {Encoding.UTF8.GetString(heard.Bytes)}",
            Closing when heard.Bytes.Length >= 2 => $"close {BinaryPrimitives.ReadUInt16BigEndian(heard.Bytes)}",
            Closing => "close with no code",
            Ping => "ping",
            Pong => "pong",
            _ => "end",
        };
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

            // the HTTP server's own, which its server layer holds
            "connectionInactivityTimeout" => (long)HttpServerOptions.ConnectionInactivityTimeoutDefault.TotalMilliseconds,

            // the bounds both servers hold alike, each the same on the WebSocket server's
            "minimumSendBytesPerSecond" => Alike((http.MinimumSendBytesPerSecond, webSocket.MinimumSendBytesPerSecond)),
            "sendGracePeriod" => Alike(((long)http.SendGracePeriod.TotalMilliseconds, (long)webSocket.SendGracePeriod.TotalMilliseconds)),
            "headersTimeout" => Alike(((long)http.HeadersTimeout.TotalMilliseconds, (long)webSocket.HeadersTimeout.TotalMilliseconds)),
            "minimumBodyBytesPerSecond" => http.MinimumBodyBytesPerSecond,
            "bodyGracePeriod" => (long)http.BodyGracePeriod.TotalMilliseconds,

            // what the WebSocket server holds for a socket when built alone, told none
            "maximumUnsentBytes" => new WebSocketTransportServer(webSocket).MaximumUnsentBytes,

            // the bound the WebSocket server layer takes when built alone and told none
            "maximumMessageBytes" => new WebSocketTransportServer(webSocket).MaximumMessageBytes,

            // a WebSocket's heartbeat and a broker participant's, alike
            "heartbeat" => Alike(((long)webSocket.Heartbeat.TotalMilliseconds, (long)new BrokerParticipantOptions().Heartbeat.TotalMilliseconds)),

            // a broker's, its server transport's and its participant's (spec 15.23)
            "acceptTimeout" => (long)new BrokerTransportServerOptions { Names = ["interop"] }.AcceptTimeout.TotalMilliseconds,
            "maximumEnvelopePartsBytes" => new BrokerParticipantOptions().MaximumEnvelopePartsBytes,
            "heldBytesBudget" => new BrokerParticipantOptions().HeldBytesBudget,
            _ => throw new ArgumentException($"the file states a default no test reads: {bound}", nameof(bound)),
        };
    }

    // a default both servers hold alike; any other is a number no file states
    private static long Alike((long Http, long WebSocket) defaults)
    {
        return defaults.Http == defaults.WebSocket ? defaults.Http : -1;
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

        // the scheme of what an answer announced, by its name: OPAQUE, a token, or NONE, its end
        var credential = envelope.Header switch
        {
            ResultHeader { Credential: { } announced } => $" {announced.Scheme.ToString().ToUpperInvariant()}",
            FailureHeader { Credential: { } announced } => $" {announced.Scheme.ToString().ToUpperInvariant()}",
            _ => "",
        };

        if (envelope.Failure is { } failure)
        {
            return $"{kind} {callId} failure {failure.Code} {(int)failure.Scope} through {failure.Relays}{credential}";
        }

        return envelope.Header switch
        {
            ResultHeader { Total: { } total } => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{credential} total {total}",
            ResultHeader or NotificationHeader => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{credential}",
            ChunkHeader chunk => $"{kind} {callId} from {chunk.Offset}{(chunk.IsLast ? " last" : "")} {Convert.ToHexString(envelope.Payload.Span)}",
            CreditHeader credit => $"{kind} {callId} credit {credit.CreditEnd}",

            // a command the server sends its client, with its flags, the envelope's byte 2 as sent,
            // and the credential it presents, as vectors.json writes a header's
            RequestHeader request => $"{kind} {callId} flags {bytes.Span[2]} {request.ServiceId}/{request.ProcedureId} {Convert.ToHexString(envelope.Payload.Span)}"
                + request.Credential switch
                {
                    { Scheme: CredentialScheme.Jwt, Token: { } token } => $" credential JWT {token}",
                    { } presented => $" credential {presented.Scheme.ToString().ToUpperInvariant()}",
                    null => "",
                },
            _ => $"{kind} {callId}",
        };
    }

    // a failure's detail, as an envelope that holds one says it; none for any other
    private static string? DetailOf(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            return EnvelopeCodec.ReadEnvelope(
                bytes.Span,
                new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })?.Failure?.Detail;
        }
        catch (FailureException)
        {
            return null;
        }
    }

    // the detail a case gives a failure it expects, which is compared where it gives one
    private static string? ExpectedDetailOf(JsonElement expected)
    {
        return expected.TryGetProperty("failure", out var failure) && failure.TryGetProperty("detail", out var detail) ? detail.GetString() : null;
    }

    // what a case expects of an envelope, written as OutOf writes what was sent
    private static string ExpectedOf(JsonElement expected)
    {
        var kind = expected.GetProperty("kind").GetInt32();
        var callId = expected.GetProperty("callId").GetUInt32();

        // on an answer, the scheme it announced; on a request, the credential it presents
        var credential = expected.TryGetProperty("credential", out var announced) && announced.ValueKind == JsonValueKind.String
            ? $" {announced.GetString()}"
            : "";

        if (expected.TryGetProperty("failure", out var failure))
        {
            return $"{kind} {callId} failure {failure.GetProperty("code").GetInt32()} {failure.GetProperty("scope").GetInt32()} through {failure.GetProperty("relays").GetInt32()}{credential}";
        }

        var hexadecimal = expected.TryGetProperty("payload", out var payload)
            ? Convert.ToHexString(BytesOf(payload.GetString()!))
            : null;

        if (expected.TryGetProperty("procedureId", out var procedureId))
        {
            var presented = announced.ValueKind == JsonValueKind.Object
                ? announced.GetProperty("scheme").GetString() switch
                {
                    "JWT" => $" credential JWT {announced.GetProperty("token").GetString()}",
                    var scheme => $" credential {scheme}",
                }
                : "";

            return $"{kind} {callId} flags {expected.GetProperty("flags").GetInt32()} {expected.GetProperty("serviceId").GetInt32()}/{procedureId.GetInt32()} {hexadecimal}{presented}";
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

        return hexadecimal is null ? $"{kind} {callId}" : $"{kind} {callId} {hexadecimal}{credential}{total}";
    }

    // a batch's envelopes, each after its length on 4 bytes, big-endian, as OutOf writes each; a
    // batch cut short, as its bytes left
    private static List<string> BatchOf(byte[] batch, List<JsonElement> expected)
    {
        var envelopes = new List<string>();
        var index = 0;

        for (var at = 0; at < batch.Length;)
        {
            var length = batch.Length - at < 4 ? -1 : (long)BinaryPrimitives.ReadUInt32BigEndian(batch.AsSpan(at));

            if (length < 0 || at + 4 + length > batch.Length)
            {
                envelopes.Add($"no batch: {Convert.ToHexString(batch.AsSpan(at))}");

                return envelopes;
            }

            var bytes = batch.AsMemory(at + 4, (int)length);

            envelopes.Add(OutOf(bytes));

            if (index < expected.Count && ExpectedDetailOf(expected[index]) is not null)
            {
                envelopes.Add($"detail {index + 1} {DetailOf(bytes)}");
            }

            index += 1;
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

    /// <summary>
    /// The names of every case over HTTP and over WebSocket this side plays: each but those a row of
    /// the support matrix excuses it from.
    /// </summary>
    public static TheoryData<string> Names { get; } = new(
        Root.GetProperty("cases").EnumerateArray().Where((entry) =>
        {
            return IsPlayedHere(entry) && !IsExcused(entry);
        }).Select(NameOf));

    /// <summary>The names of the responses every side's reader reads alike.</summary>
    public static TheoryData<string> Responses { get; } = new(Root.GetProperty("responses").EnumerateArray().Select(NameOf));

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        var entry = EntryOf(("cases", name));
        var steps = entry.GetProperty("steps").EnumerateArray().ToList();

        // * the keys of a case, as the schema defines them: one this harness does not know fails its case
        Assert.Empty(entry.EnumerateObject().Where((property) =>
        {
            return property.Name is not ("answersPings" or "clauses" or "differs" or "limits" or "name" or "options" or "realTime" or "steps" or "transport");
        }).Select((property) =>
        {
            return property.Name;
        }));

        await using var served = ServedOf(entry);

        // dropped before the server stops: the sockets its exchanges went on
        using var peer = new Peer(served, !entry.TryGetProperty("answersPings", out var answersPings) || answersPings.GetBoolean());

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
    public void Reads_each_batch_failure_detail_only_where_the_case_gives_one()
    {
        using var expected = JsonDocument.Parse("""
            [{"kind":18,"callId":3,"failure":{"code":1,"scope":0,"relays":0}},
             {"kind":18,"callId":5,"failure":{"code":1,"scope":0,"relays":0,"detail":"second"}}]
            """);
        var items = expected.RootElement.EnumerateArray().ToList();
        var batch = new List<byte>();

        foreach (var (callId, detail) in new[] { (3u, "first"), (5u, "second") })
        {
            var bytes = EnvelopeCodec.WriteEnvelope(new Envelope
            {
                Header = new FailureHeader { CallId = callId },
                Failure = new Failure { Code = 1, Scope = FailureScope.Protocol, Detail = detail },
            });
            var length = new byte[4];

            BinaryPrimitives.WriteUInt32BigEndian(length, (uint)bytes.Length);
            batch.AddRange(length);
            batch.AddRange(bytes);
        }

        Assert.Equal(
            ["18 3 failure 1 0 through 0", "18 5 failure 1 0 through 0", "detail 2 second"],
            BatchOf([.. batch], items));

        // ! the second item's detail comes from its own bytes, not its expectation or its neighbour
        batch[^1] = (byte)'!';
        Assert.Equal(
            ["18 3 failure 1 0 through 0", "18 5 failure 1 0 through 0", "detail 2 secon!"],
            BatchOf([.. batch], items));
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
        var cases = Root.GetProperty("cases").EnumerateArray().Where(IsPlayedHere).ToList();
        var played = Names.Select((row) =>
        {
            return row.Data;
        }).ToHashSet();

        // each case plays under its own name, whatever its transport
        var every = Root.GetProperty("cases").EnumerateArray().ToList();

        Assert.Equal(every.Count, every.Select(NameOf).Distinct().Count());
        Assert.All(cases, (entry) =>
        {
            Assert.Equal(!IsExcused(entry), played.Contains(NameOf(entry)));
        });
    }

    // the server under test, over either transport: its router; how its transport starts, giving its
    // port; its gauges and its clients; its clock; and the server it lets go of, which a stop
    // disposes, as the TypeScript side's runner does
    private sealed class Served : IAsyncDisposable
    {
        public required Func<IReadOnlyList<TransportServerClient>> Clients { get; init; }

        public required SteppingClock Clock { get; init; }

        public required Func<Gauges> Gauges { get; init; }

        public required RouterServer Router { get; init; }

        public required IAsyncDisposable Server { get; init; }

        public required Func<Task<int>> Start { get; init; }

        public required Func<Task> Stop { get; init; }

        public required IServerTransport Transport { get; init; }

        public ValueTask DisposeAsync()
        {
            return Server.DisposeAsync();
        }
    }

    // a case played: the server under test, the exchanges a peer of the test's own opened by name,
    // the values it captured, and what the server reported, and the refusals its transport told,
    // that no step took yet, each report with the connection it came with
    private sealed class Peer : IDisposable
    {
        private readonly Served _served;
        private readonly bool _isAnsweringPings;
        private readonly Dictionary<string, Exchange> _exchanges = [];
        private readonly Dictionary<string, string> _captured = [];
        private readonly ConcurrentQueue<(string Report, string? ConnectionHandle)> _reports = new();
        private readonly ConcurrentQueue<TransportServerRefusal> _refusals = new();
        private int _port;

        public Peer(Served served, bool isAnsweringPings)
        {
            _served = served;
            _isAnsweringPings = isAnsweringPings;

            // what the server reports: a failure's code, or an exception, which carries none
            served.Router.Error += (reason, connectionHandle) =>
            {
                _reports.Enqueue((reason is FailureException failure ? failure.Code.ToString(CultureInfo.InvariantCulture) : "exception", connectionHandle));
            };

            // what its transport tells of each refusal it judges (spec 15.1)
            served.Transport.Refusal += _refusals.Enqueue;
        }

        // a step in a few words: what it does, and on which exchange
        public static string Describe(JsonElement step)
        {
            var kind = step.EnumerateObject().First((property) =>
            {
                return property.Name is not "on" and not "within" and not "after";
            }).Name;

            return step.TryGetProperty("on", out var on) ? $"{kind} on {on.GetString()}" : kind;
        }

        public async Task Start()
        {
            _port = await _served.Start();
        }

        public async Task Take(JsonElement step)
        {
            var on = step.TryGetProperty("on", out var named) ? named.GetString()! : "";
            var timing = new Timing(step);

            // a step is one act, on the exchange and within the times it may name: one that holds a
            // second act fails, never passes with it left unplayed
            var acts = step.EnumerateObject().Count((property) =>
            {
                return property.Name is not "on" and not "within" and not "after";
            });

            if (acts != 1)
            {
                throw new ArgumentException($"a step no test plays: {step.GetRawText()}", nameof(step));
            }

            if (step.TryGetProperty("send", out var send))
            {
                NothingMore();
                await (send.TryGetProperty("head", out _) ? Send((send, on)) : Write((send, on)));
            }
            else if (step.TryGetProperty("expect", out var expected))
            {
                await (expected.TryGetProperty("status", out _) ? Expect((expected, on, timing)) : Hear((expected, on, timing)));
            }
            else if (step.TryGetProperty("close", out _))
            {
                NothingMore();
                _exchanges[on].Dispose();
                _exchanges.Remove(on);
            }
            else if (step.TryGetProperty("until", out var until))
            {
                await (until.TryGetProperty("timer", out var timer) ? UntilArmed(timer) : Until(until));
            }
            else if (step.TryGetProperty("advance", out var advance))
            {
                await _served.Clock.Advance(TimeOf(advance));
            }
            else if (step.TryGetProperty("wall", out var wall))
            {
                _served.Clock.Wall(TimeOf(wall));
            }
            else if (step.TryGetProperty("report", out var report))
            {
                await Report((report, on));
            }
            else if (step.TryGetProperty("stop", out _))
            {
                await _served.Stop().WaitAsync(Patience, Cancelled);
            }
            else
            {
                throw new ArgumentException($"a step no test plays: {Describe(step)}", nameof(step));
            }
        }

        // the server reported nothing, and told no refusal, that no step took
        public void NothingMore()
        {
            Assert.Empty(_reports);
            Assert.True(_refusals.IsEmpty, $"told no refusal, and {string.Join("; ", _refusals.Select(TellingOf))}");
        }

        // a refusal told, written as a case writes what it expects
        private static string TellingOf(TransportServerRefusal refusal)
        {
            return $"told {refusal.Status} {refusal.Reason}, authority {QuotedOf(refusal.Authority)}, origin {QuotedOf(refusal.Origin)}, from {refusal.Address}:{refusal.Port}";
        }

        // a string or none, as a case writes it
        private static string QuotedOf(string? text)
        {
            return text is null ? "null" : JsonSerializer.Serialize(text);
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
        // captured put in, a name nothing captured refused, then its body
        private async Task Send((JsonElement Request, string On) step)
        {
            var head = step.Request.GetProperty("head").GetString()!.Replace("{host}", $"{Host}:{_port}", StringComparison.Ordinal);

            foreach (var (name, value) in _captured)
            {
                head = head.Replace($"{{{name}}}", value, StringComparison.Ordinal);
            }

            // ! a name nothing captured fails the case, never goes out as it is written
            if (Regex.Match(head, @"\{(\w+)\}") is { Success: true } uncaptured)
            {
                throw new InvalidOperationException($"nothing captured under {uncaptured.Groups[1].Value}");
            }

            byte[] body = step.Request.TryGetProperty("body", out var given) ? BytesOf(given.GetString()!) : [];

            if (_exchanges.Remove(step.On, out var before))
            {
                before.Dispose();
            }

            // ! one octet per character, its code point (ISO-8859-1), as the file says: a character
            // past U+007F is an octet past ASCII
            _exchanges[step.On] = await Exchange.Send((_port, [.. Encoding.Latin1.GetBytes(head), .. body], _isAnsweringPings));
        }

        // a message on an exchange that is a WebSocket: binary or text, in one final frame; frames
        // as given; or a close and its code
        private async Task Write((JsonElement Message, string On) step)
        {
            var (message, on) = step;
            var exchange = _exchanges[on];

            if (message.TryGetProperty("binary", out var binary))
            {
                await exchange.Write((Binary, true, BytesOf(binary.GetString()!)));
            }
            else if (message.TryGetProperty("text", out var text))
            {
                await exchange.Write((Text, true, Encoding.UTF8.GetBytes(text.GetString()!)));
            }
            else if (message.TryGetProperty("frames", out var frames))
            {
                foreach (var frame in frames.EnumerateArray())
                {
                    await exchange.Write((frame.GetProperty("opcode").GetInt32(), frame.GetProperty("fin").GetBoolean(), BytesOf(frame.GetProperty("payload").GetString()!)));
                }
            }
            else
            {
                var code = new byte[2];

                BinaryPrimitives.WriteUInt16BigEndian(code, (ushort)message.GetProperty("close").GetInt32());
                await exchange.Write((Closing, true, code));
            }
        }

        // what a task gives within its step's wait, once it came no sooner than the step's after;
        // past a within missed, it waits up to a patience more, so the failure tells when it came,
        // or that it never did
        private static async Task<T> CameOf<T>(Task<T> task, (Timing Timing, string What) awaited)
        {
            var (timing, what) = awaited;

            if (!await IsDoneWithin((task, timing.Wait)))
            {
                var late = timing.Within is null ? "" : await LateOf((task, timing));

                throw new XunitException($"{what} did not come within {MillisecondsOf(timing.Wait)} ms{late}");
            }

            var cameAt = timing.Elapsed;

            if (timing.After is { } after && cameAt < after)
            {
                throw new XunitException($"{what} came at {MillisecondsOf(cameAt)} ms, before its {MillisecondsOf(after)} ms");
            }

            return await task;
        }

        // whether a task is done within a wait; it throws as the task does
        private static async Task<bool> IsDoneWithin((Task Task, TimeSpan Wait) awaited)
        {
            try
            {
                await awaited.Task.WaitAsync(awaited.Wait, Cancelled);

                return true;
            }
            catch (TimeoutException)
            {
                return false;
            }
        }

        // what befell a task in the patience past a wait it missed, as a failure tells it
        private static async Task<string> LateOf((Task Task, Timing Timing) awaited)
        {
            try
            {
                return await IsDoneWithin((awaited.Task, Patience))
                    ? $": it came at {MillisecondsOf(awaited.Timing.Elapsed)} ms"
                    : $", nor in the {MillisecondsOf(Patience)} ms past it";
            }
            catch (Exception reason) when (reason is not OperationCanceledException)
            {
                return $", and failed at {MillisecondsOf(awaited.Timing.Elapsed)} ms: {reason.Message}";
            }
        }

        // the response on an exchange: its head timed as its step says, then, when the case expects
        // anything of it, its body within what is left of the step's wait, or that its socket was
        // cut first; each written alike as expected and as it came
        private async Task Expect((JsonElement Response, string On, Timing Timing) step)
        {
            var (response, on, timing) = step;
            var exchange = _exchanges[on];
            var expected = new List<string> { $"status {response.GetProperty("status").GetInt32()}" };
            Head head;

            try
            {
                head = await CameOf(exchange.Head, (timing, "the response's head"));
            }
            catch (IOException reason)
            {
                // lost, its socket ended before any status, as a case may let it be
                if (response.TryGetProperty("orLost", out _) && !exchange.IsStatusRead)
                {
                    return;
                }

                throw new XunitException($"expected {expected[0]}\n    came no head, its socket cut: {reason.Message}");
            }

            var came = new List<string> { $"status {head.Status}" };

            if (response.TryGetProperty("fields", out var fields))
            {
                foreach (var field in fields.EnumerateObject())
                {
                    // * a field by its name in any case, as the file states it
                    var value = head.Fields.GetValueOrDefault(field.Name.ToLowerInvariant());

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
                came.Add(await exchange.BodyWithin(timing.Left) is { } bytes ? BodyOf(bytes) : "body: cut");
            }

            if (response.TryGetProperty("envelope", out var envelope))
            {
                var bytes = await exchange.BodyWithin(timing.Left);

                expected.Add(ExpectedOf(envelope));
                came.Add(bytes is not null ? OutOf(bytes) : "body: cut");

                if (ExpectedDetailOf(envelope) is { } detail)
                {
                    expected.Add($"detail {detail}");
                    came.Add($"detail {(bytes is null ? null : DetailOf(bytes))}");
                }
            }

            if (response.TryGetProperty("batch", out var batch))
            {
                var items = batch.EnumerateArray().ToList();

                for (var index = 0; index < items.Count; index += 1)
                {
                    expected.Add(ExpectedOf(items[index]));

                    if (ExpectedDetailOf(items[index]) is { } detail)
                    {
                        expected.Add($"detail {index + 1} {detail}");
                    }
                }

                came.AddRange(await exchange.BodyWithin(timing.Left) is { } bytes ? BatchOf(bytes, items) : ["body: cut"]);
            }

            var (wanted, got) = (string.Join("; ", expected), string.Join("; ", came));

            if (wanted != got)
            {
                Assert.Fail($"expected {wanted}\n    came {got}");
            }

            if (response.TryGetProperty("told", out var told))
            {
                await Told((told, exchange));
            }
        }

        // what the server's transport told of the refusal an exchange was answered: the next refusal
        // told, within a patience, since it is told once the refusal is written; none when null
        private async Task Told((JsonElement Told, Exchange Exchange) step)
        {
            var (told, exchange) = step;

            if (told.ValueKind == JsonValueKind.Null)
            {
                Assert.True(_refusals.IsEmpty, $"told no refusal, and {string.Join("; ", _refusals.Select(TellingOf))}");

                return;
            }

            var expected = TellingOf(new TransportServerRefusal(
                told.GetProperty("address").GetString(),
                Filled(told.GetProperty("authority").GetString()),
                Filled(told.GetProperty("origin").GetString()),
                told.GetProperty("port").GetString() == "{port}" ? exchange.Port : -1,
                told.GetProperty("reason").GetString()!,
                told.GetProperty("status").GetInt32()));
            var watch = Stopwatch.StartNew();

            while (_refusals.IsEmpty && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
            }

            Assert.True(_refusals.TryDequeue(out var came), $"expected {expected}, and no refusal was told");
            Assert.Equal(expected, TellingOf(came));
        }

        // a value of a case with the server's host, and each value captured, put in, as in a head
        private string? Filled(string? text)
        {
            if (text is null)
            {
                return null;
            }

            var filled = text.Replace("{host}", $"{Host}:{_port}", StringComparison.Ordinal);

            foreach (var (name, value) in _captured)
            {
                filled = filled.Replace($"{{{name}}}", value, StringComparison.Ordinal);
            }

            return filled;
        }

        // what the server sends next on an exchange that is a WebSocket, timed as its step says
        private async Task Hear((JsonElement Heard, string On, Timing Timing) step)
        {
            var (heard, on, timing) = step;
            var expected = heard.EnumerateObject().Single();
            var wanted = expected.Name switch
            {
                "envelope" => $"envelope {ExpectedOf(expected.Value)}",
                "binary" => $"binary {Convert.ToHexString(BytesOf(expected.Value.GetString()!))}",
                "close" => $"close {expected.Value.GetInt32()}",
                _ => expected.Name,
            };
            var exchange = _exchanges[on];
            var came = await exchange.NextWithin(timing.Wait);
            var cameAt = timing.Elapsed;
            string seen;

            if (came is null && timing.Within is null)
            {
                seen = $"nothing within {MillisecondsOf(timing.Wait)} ms";
            }
            else if (came is null)
            {
                // past a within missed, up to a patience more: when what it hears came, or that
                // nothing did
                var late = await exchange.NextWithin(Patience);

                seen = late is null
                    ? $"nothing within {MillisecondsOf(timing.Wait)} ms, nor in the {MillisecondsOf(Patience)} ms past it"
                    : $"nothing within {MillisecondsOf(timing.Wait)} ms: {HeardOf((late, expected.Name))} came at {MillisecondsOf(timing.Elapsed)} ms";
            }
            else if (timing.After is { } after && cameAt < after)
            {
                seen = $"{HeardOf((came, expected.Name))} came at {MillisecondsOf(cameAt)} ms, before its {MillisecondsOf(after)} ms";
            }
            else
            {
                seen = HeardOf((came, expected.Name));
            }

            Assert.Equal(wanted, seen);

            if (expected.Name == "envelope" && ExpectedDetailOf(expected.Value) is { } detail)
            {
                Assert.Equal(detail, DetailOf(came!.Bytes));
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

        // the earliest timer armed on the server's clock, due that many milliseconds from now, and the
        // only one so due, within a patience
        // ! one armed before it and not yet cleared, on Kestrel's threads, would fire first as the
        // clock advances
        private async Task UntilArmed(JsonElement milliseconds)
        {
            var due = TimeOf(milliseconds);
            var dues = await _served.Clock.UntilEarliest(due, Patience);

            Assert.True(SteppingClock.IsEarliest(dues, due), $"the earliest timer armed, alone so due, among {string.Join(", ", dues)}");
        }

        private long CountOf(string gauge)
        {
            return _served.Gauges().Counts[gauge];
        }

        // the next report, within a patience; on an exchange named, with that exchange's connection
        private async Task Report((JsonElement Report, string On) step)
        {
            var (report, on) = step;
            var expected = report.ValueKind == JsonValueKind.Number ? report.GetInt32().ToString(CultureInfo.InvariantCulture) : report.GetString();
            var watch = Stopwatch.StartNew();

            while (_reports.IsEmpty && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
            }

            Assert.True(_reports.TryDequeue(out var came), $"expected report {expected}, and nothing was reported");
            Assert.Equal(
                on.Length == 0 ? $"report {expected}" : $"report {expected} on {on}",
                on.Length == 0 ? $"report {came.Report}" : $"report {came.Report} on {ExchangeOf(came.ConnectionHandle ?? "no connection")}");
        }

        // the exchange whose socket a connection came by, as its port says; its handle when none did
        private string ExchangeOf(string connectionHandle)
        {
            var port = _served.Clients().FirstOrDefault((client) =>
            {
                return client.ConnectionHandle == connectionHandle;
            })?.Port;

            return _exchanges.FirstOrDefault((exchange) =>
            {
                return exchange.Value.Port == port;
            }).Key ?? connectionHandle;
        }
    }

    /// <summary>A response's head: its status, and its fields by their names in lower case.</summary>
    private sealed record Head(int Status, IReadOnlyDictionary<string, string> Fields);

    /// <summary>What the server sent on a WebSocket: a message whole, a close, a ping or a pong, by its opcode; or its socket's end.</summary>
    private sealed record Heard(int Kind, byte[] Bytes);

    /// <summary>
    /// How an expect is timed, from its step's start, on the real clock: its <c>within</c>, its wait,
    /// a patience where it names none, and its <c>after</c>, the soonest what it reads may come.
    /// </summary>
    private sealed class Timing
    {
        private readonly Stopwatch _started = Stopwatch.StartNew();

        public Timing(JsonElement step)
        {
            Within = step.TryGetProperty("within", out var within) ? TimeOf(within) : null;
            After = step.TryGetProperty("after", out var after) ? TimeOf(after) : null;
        }

        public TimeSpan? Within { get; }

        public TimeSpan? After { get; }

        // how long it waits in all
        public TimeSpan Wait
        {
            get
            {
                return Within ?? Patience;
            }
        }

        // how long since its step started
        public TimeSpan Elapsed
        {
            get
            {
                return _started.Elapsed;
            }
        }

        // what is left of its wait
        public TimeSpan Left
        {
            get
            {
                var left = Wait - Elapsed;

                return left > TimeSpan.Zero ? left : TimeSpan.Zero;
            }
        }
    }

    // an exchange: the socket of its own a request went on, and its response, read as it comes —
    // its head at once, its body after it; answered 101, a WebSocket, whose frames the peer writes
    // and hears itself
    private sealed class Exchange : IDisposable
    {
        // a socket's end, which no opcode names
        private const int Ended = -1;

        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private readonly Reader _reader;
        private readonly bool _isAnsweringPings;

        // what the peer writes on it, a frame at a time: its own, and its pongs
        private readonly SemaphoreSlim _writing = new(1, 1);

        // what the server sent on it once a WebSocket, in the order it came
        private readonly Channel<Heard> _heard = Channel.CreateUnbounded<Heard>();

        // whether the peer sent its close, which the server's close answers
        private volatile bool _isClosing;

        private Exchange((TcpClient Tcp, bool IsAnsweringPings) socket)
        {
            _tcp = socket.Tcp;
            _stream = socket.Tcp.GetStream();
            _isAnsweringPings = socket.IsAnsweringPings;
            Port = ((IPEndPoint)socket.Tcp.Client.LocalEndPoint!).Port;

            var reader = new Reader((buffer) =>
            {
                return _stream.ReadAsync(buffer, Cancelled);
            });

            _reader = reader;
            Head = reader.ReadHead();
            Body = BodyAfter((reader, Head));
            _ = HearAfter(reader);
        }

        // whether its response's status line came
        public bool IsStatusRead
        {
            get
            {
                return _reader.IsStatusRead;
            }
        }

        // its own port, which the server sees as its peer's
        public int Port { get; }

        public Task<Head> Head { get; }

        public Task<byte[]> Body { get; }

        // the request's octets written whole, its response read from before they go: a refusal on
        // the head alone comes before the server lets go of the socket
        public static async Task<Exchange> Send((int Port, byte[] Octets, bool IsAnsweringPings) request)
        {
            var tcp = new TcpClient();

            try
            {
                await tcp.ConnectAsync(IPAddress.Loopback, request.Port, Cancelled);

                var exchange = new Exchange((tcp, request.IsAnsweringPings));

                await tcp.GetStream().WriteAsync(request.Octets, Cancelled);

                return exchange;
            }
            catch
            {
                tcp.Dispose();

                throw;
            }
        }

        // its body within a wait; none when its socket was cut before it came whole
        public async Task<byte[]?> BodyWithin(TimeSpan wait)
        {
            try
            {
                return await Body.WaitAsync(wait, Cancelled);
            }
            catch (IOException)
            {
                return null;
            }
        }

        // a frame of the peer's, whole, after any other it writes
        public async Task Write((int Opcode, bool IsFinal, byte[] Payload) frame)
        {
            if (frame.Opcode == Closing)
            {
                _isClosing = true;
            }

            await _writing.WaitAsync(Cancelled);

            try
            {
                await _stream.WriteAsync(FrameOf(frame), Cancelled);
            }
            finally
            {
                _writing.Release();
            }
        }

        // what the server sent next once a WebSocket, within a wait; none when nothing came
        public async Task<Heard?> NextWithin(TimeSpan wait)
        {
            using var waiting = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);

            waiting.CancelAfter(wait);

            try
            {
                return await _heard.Reader.ReadAsync(waiting.Token);
            }
            catch (OperationCanceledException) when (!Cancelled.IsCancellationRequested)
            {
                return null;
            }
        }

        public void Dispose()
        {
            _tcp.Dispose();
            _writing.Dispose();
        }

        private static async Task<byte[]> BodyAfter((Reader Reader, Task<Head> Head) response)
        {
            return await response.Reader.ReadBody(await response.Head);
        }

        // once answered 101, what the server sends, frame by frame: a message whole, its fragments
        // put together; a ping, answered with a pong of its payload unless the case leaves it
        // unanswered; a pong, which no case expects, so that it fails the step it comes in, as the
        // TypeScript side's peer hears it; a close, answered with its code unless the peer closed
        // first; then the socket's end. A reserved opcode fails the case
        private async Task HearAfter(Reader reader)
        {
            try
            {
                if ((await Head).Status != 101)
                {
                    // * past its response, the socket's end alone: what its server ends of it, which
                    // an answer written before its body is whole has it do in stages (spec 15.12)
                    await Body;
                    await reader.UntilEnd();
                    _heard.Writer.TryWrite(new Heard(Ended, []));

                    return;
                }

                var message = new List<byte>();
                var kind = Binary;

                while (true)
                {
                    var (opcode, isFinal, payload) = await FrameFrom(reader);

                    if (opcode is Ping or Pong or Closing)
                    {
                        _heard.Writer.TryWrite(new Heard(opcode, payload));
                    }

                    if (opcode == Ping && _isAnsweringPings)
                    {
                        await Write((Pong, true, payload));
                    }
                    else if (opcode == Closing && !_isClosing)
                    {
                        await Write((Closing, true, payload.Length >= 2 ? payload[..2] : []));
                    }
                    else if (opcode is Continuation or Text or Binary)
                    {
                        kind = opcode == Continuation ? kind : opcode;
                        message.AddRange(payload);

                        if (isFinal)
                        {
                            _heard.Writer.TryWrite(new Heard(kind, [.. message]));
                            message.Clear();
                        }
                    }
                    else if (opcode is not (Ping or Pong or Closing))
                    {
                        // ! an opcode RFC 6455 reserves fails the case at its next read of the socket
                        _heard.Writer.TryComplete(new InvalidDataException($"the server sent a frame of the reserved opcode {opcode} (RFC 6455, section 5.2)"));

                        return;
                    }
                }
            }
            catch (Exception reason) when (reason is IOException or ObjectDisposedException or OperationCanceledException)
            {
                _heard.Writer.TryWrite(new Heard(Ended, []));
            }
        }
    }

    // a response as the file's comment reads one, from whatever reads it comes in: its status line,
    // its fields, and its body by its length, de-chunked, or to the end of what comes
    private sealed class Reader(Func<Memory<byte>, ValueTask<int>> read)
    {
        // what comes past a response, dropped, until its socket ends
        public async Task UntilEnd()
        {
            var dropped = new byte[ReadBytes];

            while (await read(dropped) > 0)
            {
                // dropped
            }
        }

        // what came and is not read yet
        private readonly List<byte> _came = [];

        // whether its status line came: a socket that ends before it is an exchange lost
        public bool IsStatusRead { get; private set; }

        public async Task<Head> ReadHead()
        {
            var statusLine = await ReadLine();
            var fields = new Dictionary<string, string>();

            IsStatusRead = true;

            for (var line = await ReadLine(); line.Length > 0; line = await ReadLine())
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);
                var name = line[..colon].Trim().ToLowerInvariant();
                var value = line[(colon + 1)..].Trim();

                fields[name] = fields.TryGetValue(name, out var before) ? $"{before}, {value}" : value;
            }

            // * a status line or none, as the TypeScript side's peer reads it
            var status = Regex.Match(statusLine, @"^HTTP/1\.[01] ([0-9]{3})(?: |$)", RegexOptions.CultureInvariant);

            if (!status.Success)
            {
                throw new IOException($"no status line: {statusLine}");
            }

            return new Head(int.Parse(status.Groups[1].Value, CultureInfo.InvariantCulture), fields);
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

        public async Task<byte[]> ReadExactly(int count)
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
