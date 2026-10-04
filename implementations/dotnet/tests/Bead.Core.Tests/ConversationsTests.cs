using System.Globalization;
using System.Text.Json;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// Bead's conversations, <c>spec/conversations.json</c>, played against the C# server of the
/// interop service: what its clients send, each on its own connection, what the server sends back
/// on each and reports, on a clock the conversation alone advances. The TypeScript server plays the
/// same file.
/// </summary>
public sealed class ConversationsTests
{
    // constants

    // the one connection of a conversation that opens none, opened before its first step
    private const string OnlyConnection = "connection";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly JsonElement Root = Load();

    // where every conversation's wall clock starts
    private static readonly DateTimeOffset WallClock = DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "conversations.json")));

        return document.RootElement.Clone();
    }

    private static JsonElement ConversationOf(string name)
    {
        foreach (var conversation in Root.GetProperty("conversations").EnumerateArray())
        {
            if (conversation.GetProperty("name").GetString() == name)
            {
                return conversation;
            }
        }

        throw new KeyNotFoundException($"no conversation \"{name}\"");
    }

    // the server's limits, the conversation's where it gives them
    private static RouterLimits LimitsOf(JsonElement conversation)
    {
        var limits = RouterLimits.Default;

        if (!conversation.TryGetProperty("limits", out var given))
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
                "transferInactivityTimeout" => limits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(value) },
                _ => throw new ArgumentException($"a conversation sets a limit no test reads: {limit.Name}", nameof(conversation)),
            };
        }

        return limits;
    }

    // the server's pacing, the conversation's where it gives it
    private static PacingLimits PacingOf(JsonElement conversation)
    {
        var pacing = PacingLimits.Default;

        if (!conversation.TryGetProperty("pacing", out var given))
        {
            return pacing;
        }

        foreach (var limit in given.EnumerateObject())
        {
            pacing = limit.Name switch
            {
                "maximumQueuedNotifications" => pacing with { MaximumQueuedNotifications = limit.Value.GetInt32() },
                "maximumQueuedNotificationBytes" => pacing with { MaximumQueuedNotificationBytes = limit.Value.GetInt32() },
                _ => throw new ArgumentException($"a conversation sets a pacing no test reads: {limit.Name}", nameof(conversation)),
            };
        }

        return pacing;
    }

    // an envelope sent, as a conversation writes what it expects
    private static string OutOf(ReadOnlyMemory<byte> bytes)
    {
        var envelope = EnvelopeCodec.ReadEnvelope(
            bytes.Span,
            new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!;
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

            // a command the server sends its client, with its flags, the envelope's byte 2 as sent
            RequestHeader request => $"{kind} {callId} flags {bytes.Span[2]} {request.ServiceId}/{request.ProcedureId} {Convert.ToHexString(envelope.Payload.Span)}",
            _ => $"{kind} {callId}",
        };
    }

    // what a conversation expects, written as OutOf writes what was sent
    private static string ExpectedOf(JsonElement expected)
    {
        var kind = expected.GetProperty("kind").GetInt32();
        var callId = expected.GetProperty("callId").GetUInt32();

        var credential = expected.TryGetProperty("credential", out var announced) ? $" {announced.GetString()}" : "";

        if (expected.TryGetProperty("failure", out var failure))
        {
            return $"{kind} {callId} failure {failure.GetProperty("code").GetInt32()} {failure.GetProperty("scope").GetInt32()} through {failure.GetProperty("relays").GetInt32()}{credential}";
        }

        var hexadecimal = expected.TryGetProperty("payload", out var payload)
            ? Convert.ToHexString(Vectors.FromHexadecimal(payload.GetString()!))
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

        return hexadecimal is null ? $"{kind} {callId}" : $"{kind} {callId} {hexadecimal}{credential}{total}";
    }

    // definition

    /// <summary>The names of every conversation.</summary>
    public static TheoryData<string> Names { get; } = new(
        Root.GetProperty("conversations").EnumerateArray().Select((conversation) =>
        {
            return conversation.GetProperty("name").GetString()!;
        }));

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        var conversation = ConversationOf(name);
        var steps = conversation.GetProperty("steps");
        var scheduler = new SerialScheduler();

        // the server's clock, which settles once its router and its resolvers are idle
        var clock = new SteppingClock(WallClock) { Settle = scheduler.WhenIdle };
        var transport = new ScriptedTransport { Clock = clock };

        // what the server reported, each with the connection it came with
        var reports = new List<(string Report, string ConnectionHandle)>();

        await using var server = new Server<string>(
            transport,
            new ServerOptions
            {
                Limits = LimitsOf(conversation),
                Pacing = PacingOf(conversation),
                ResolverScheduler = scheduler,
                Scheduler = scheduler,
            });

        var router = server.Router;

        router.Error += (reason, connectionHandle) =>
        {
            reports.Add((
                reason is FailureException failure ? failure.Code.ToString(System.Globalization.CultureInfo.InvariantCulture) : "exception",
                connectionHandle));
        };
        InteropService.Offer(server);

        // what was sent on each connection and reported, and the conversation did not expect yet
        IEnumerable<string> Pending()
        {
            return transport.Left().Select((left) =>
            {
                return $"{left.Name}: {OutOf(left.Bytes)}";
            }).Concat(reports.Select((report) =>
            {
                return $"{transport.NameOf(report.ConnectionHandle)}: report {report.Report}";
            }));
        }

        // nothing more was sent, on any connection, or reported
        async Task NothingMore()
        {
            await scheduler.WhenIdle();
            Assert.Empty(Pending());
        }

        // a conversation that opens none plays one connection, opened before its first step
        if (!steps.EnumerateArray().Any((step) =>
        {
            return step.TryGetProperty("open", out _);
        }))
        {
            transport.Open(OnlyConnection, true);
        }

        try
        {
            foreach (var step in steps.EnumerateArray())
            {
                var connection = step.TryGetProperty("on", out var on) ? on.GetString()! : OnlyConnection;

                if (step.TryGetProperty("open", out var opened))
                {
                    await NothingMore();
                    transport.Open(opened.GetString()!, !step.TryGetProperty("twoWay", out var twoWay) || twoWay.GetBoolean());
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("send", out var bytes))
                {
                    await NothingMore();
                    transport.Deliver(Vectors.FromHexadecimal(bytes.GetString()!), connection);
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("close", out _))
                {
                    await NothingMore();
                    transport.Closed(connection);
                    await scheduler.WhenIdle();
                }

                // a timer armed on the server's clock, due that many milliseconds from now, within a patience
                if (step.TryGetProperty("until", out var until))
                {
                    var due = TimeSpan.FromMilliseconds(until.GetProperty("timer").GetInt64());

                    Assert.Contains(due, await clock.UntilArmed(due, Patience));
                }

                if (step.TryGetProperty("advance", out var advance))
                {
                    await clock.Advance(TimeSpan.FromMilliseconds(advance.GetInt64()));
                }

                if (step.TryGetProperty("wall", out var wall))
                {
                    clock.Wall(TimeSpan.FromMilliseconds(wall.GetInt64()));
                }

                // the next envelope sent on its connection; when none was, what came instead
                if (step.TryGetProperty("expect", out var expected))
                {
                    Assert.Equal(
                        ExpectedOf(expected),
                        transport.Next(connection) is { } sent ? OutOf(sent) : $"nothing, but [{string.Join(", ", Pending())}]");
                }

                // the next report; on a connection named, it came with that connection's handle
                if (step.TryGetProperty("report", out var report))
                {
                    Assert.NotEmpty(reports);
                    Assert.Equal(
                        report.ValueKind == JsonValueKind.Number ? report.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture) : report.GetString(),
                        reports[0].Report);

                    if (step.TryGetProperty("on", out _))
                    {
                        Assert.Equal(transport.HandleOf(connection), reports[0].ConnectionHandle);
                    }

                    reports.RemoveAt(0);
                }
            }

            await NothingMore();
        }
        finally
        {
            transport.CloseEach();
            await scheduler.WhenIdle();
        }
    }

    // a transport of connections a test opens by name, delivers to and closes, which records what
    // it sends on each. A name keeps its handle: a connection opened again under it is a new
    // connection under the same handle
    private sealed class ScriptedTransport : IServerTransport
    {
        // what is sent and asked on the router's scheduler, and taken on the test's
        private readonly Lock _gate = new();

        // by name, its handle, the first named on the port 50001, the next on 50002; and back
        private readonly Dictionary<string, string> _handles = [];
        private readonly Dictionary<string, string> _names = [];

        // by handle, what was sent on it and not yet taken, in order
        private readonly Dictionary<string, Queue<ReadOnlyMemory<byte>>> _sent = [];

        // the handles of the connections open, and of those that carry nothing back
        private readonly HashSet<string> _open = [];
        private readonly HashSet<string> _oneWay = [];

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public string HandleOf(string name)
        {
            if (!_handles.TryGetValue(name, out var handle))
            {
                handle = $"type=WS;ip=127.0.0.1;port={50001 + _handles.Count}";
                _handles[name] = handle;
                _names[handle] = name;
            }

            return handle;
        }

        public string NameOf(string connectionHandle)
        {
            return _names.GetValueOrDefault(connectionHandle, connectionHandle);
        }

        public void Open(string name, bool isTwoWay)
        {
            var handle = HandleOf(name);

            lock (_gate)
            {
                if (isTwoWay)
                {
                    _oneWay.Remove(handle);
                }
                else
                {
                    _oneWay.Add(handle);
                }
            }

            _open.Add(handle);
            Connection?.Invoke(handle);
        }

        public void Deliver(byte[] bytes, string name)
        {
            Message?.Invoke(new TransportMessage(bytes, false), HandleOf(name));
        }

        public void Closed(string name)
        {
            var handle = HandleOf(name);

            _open.Remove(handle);
            Close?.Invoke(false, handle);
        }

        // closes every connection still open
        public void CloseEach()
        {
            foreach (var handle in _open.ToList())
            {
                _open.Remove(handle);
                Close?.Invoke(false, handle);
            }
        }

        // the next envelope sent on a connection, taken; none while none waits
        public ReadOnlyMemory<byte>? Next(string name)
        {
            var handle = HandleOf(name);

            lock (_gate)
            {
                return _sent.TryGetValue(handle, out var sent) && sent.TryDequeue(out var bytes) ? bytes : null;
            }
        }

        // what was sent and not yet taken, each with the name of its connection
        public IReadOnlyList<(string Name, ReadOnlyMemory<byte> Bytes)> Left()
        {
            lock (_gate)
            {
                return [.. _sent.SelectMany((sent) =>
                {
                    return sent.Value.Select((bytes) =>
                    {
                        return (NameOf(sent.Key), bytes);
                    });
                })];
            }
        }

        public bool IsTwoWay(string connectionHandle)
        {
            lock (_gate)
            {
                return !_oneWay.Contains(connectionHandle);
            }
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            lock (_gate)
            {
                if (!_sent.TryGetValue(connectionHandle, out var sent))
                {
                    sent = [];
                    _sent[connectionHandle] = sent;
                }

                sent.Enqueue(bytes.ToArray());
            }

            return Task.CompletedTask;
        }
    }
}
