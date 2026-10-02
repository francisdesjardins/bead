using System.Text.Json;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// Bead's conversations, <c>spec/conversations.json</c>, played against the C# server of the
/// interop service: what one client sends, what the server sends back and reports. The
/// TypeScript server plays the same file.
/// </summary>
public sealed class ConversationsTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001";

    private static readonly JsonElement Root = Load();

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

        var session = envelope.Header switch
        {
            ResultHeader { Session: { } announced } => announced.IsEnded ? " ended" : " announced",
            FailureHeader { Session: { } announced } => announced.IsEnded ? " ended" : " announced",
            _ => "",
        };

        if (envelope.Failure is { } failure)
        {
            return $"{kind} {callId} failure {failure.Code} {(int)failure.Scope}{session}";
        }

        return envelope.Header switch
        {
            ResultHeader { Total: { } total } => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{session} total {total}",
            ResultHeader or NotificationHeader => $"{kind} {callId} {Convert.ToHexString(envelope.Payload.Span)}{session}",
            ChunkHeader chunk => $"{kind} {callId} from {chunk.Offset}{(chunk.IsLast ? " last" : "")} {Convert.ToHexString(envelope.Payload.Span)}",
            CreditHeader credit => $"{kind} {callId} credit {credit.CreditEnd}",

            // a command the server sends its client
            RequestHeader request => $"{kind} {callId} {request.ServiceId}/{request.ProcedureId} {Convert.ToHexString(envelope.Payload.Span)}",
            _ => $"{kind} {callId}",
        };
    }

    // what a conversation expects, written as OutOf writes what was sent
    private static string ExpectedOf(JsonElement expected)
    {
        var kind = expected.GetProperty("kind").GetInt32();
        var callId = expected.GetProperty("callId").GetUInt32();

        var session = expected.TryGetProperty("session", out var announced) ? $" {announced.GetString()}" : "";

        if (expected.TryGetProperty("failure", out var failure))
        {
            return $"{kind} {callId} failure {failure.GetProperty("code").GetInt32()} {failure.GetProperty("scope").GetInt32()}{session}";
        }

        var hexadecimal = expected.TryGetProperty("payload", out var payload)
            ? Convert.ToHexString(Vectors.FromHexadecimal(payload.GetString()!))
            : null;

        if (expected.TryGetProperty("procedureId", out var procedureId))
        {
            return $"{kind} {callId} {expected.GetProperty("serviceId").GetInt32()}/{procedureId.GetInt32()} {hexadecimal}";
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
        var scheduler = new SerialScheduler();
        var transport = new ScriptedTransport();
        var reports = new List<string>();
        var isOpen = true;

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

        router.Error += (reason, _) =>
        {
            reports.Add(reason is FailureException failure ? failure.Code.ToString(System.Globalization.CultureInfo.InvariantCulture) : "exception");
        };
        InteropService.Offer(server);
        transport.Open(Handle);

        var sent = transport.Sent;

        try
        {
            foreach (var step in conversation.GetProperty("steps").EnumerateArray())
            {
                if (step.TryGetProperty("in", out var input))
                {
                    await scheduler.WhenIdle();
                    Assert.Empty(sent.Select(OutOf));
                    Assert.Empty(reports);
                    transport.Deliver(Vectors.FromHexadecimal(input.GetString()!), Handle);
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("close", out _))
                {
                    await scheduler.WhenIdle();
                    Assert.Empty(sent.Select(OutOf));
                    Assert.Empty(reports);
                    isOpen = false;
                    transport.Closed(Handle);
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("out", out var output))
                {
                    Assert.NotEmpty(sent);
                    Assert.Equal(ExpectedOf(output), OutOf(sent[0]));
                    sent.RemoveAt(0);
                }

                if (step.TryGetProperty("report", out var report))
                {
                    Assert.NotEmpty(reports);
                    Assert.Equal(
                        report.ValueKind == JsonValueKind.Number ? report.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture) : report.GetString(),
                        reports[0]);
                    reports.RemoveAt(0);
                }
            }

            await scheduler.WhenIdle();
            Assert.Empty(sent.Select(OutOf));
            Assert.Empty(reports);
        }
        finally
        {
            if (isOpen)
            {
                transport.Closed(Handle);
            }

            await scheduler.WhenIdle();
        }
    }

    // a transport of connections a test opens, delivers to and closes, which records what it sends
    private sealed class ScriptedTransport : IServerTransport
    {
        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public List<ReadOnlyMemory<byte>> Sent { get; } = [];

        public void Open(string connectionHandle)
        {
            Connection?.Invoke(connectionHandle);
        }

        public void Deliver(byte[] bytes, string connectionHandle)
        {
            Message?.Invoke(new TransportMessage(bytes, false), connectionHandle);
        }

        public void Closed(string connectionHandle)
        {
            Close?.Invoke(false, connectionHandle);
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
            Sent.Add(bytes.ToArray());

            return Task.CompletedTask;
        }
    }
}
