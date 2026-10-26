using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>How a conversation is played: where its wall clock starts, and the registry its server is given, when any.</summary>
internal sealed record PlayerOptions
{
    /// <summary>Where the conversation's wall clock starts: its file's.</summary>
    public required DateTimeOffset WallClock { get; init; }

    /// <summary>
    /// The registry the server is given; with one, each <c>counted</c> step compares the series
    /// that moved since the case began, or since the last, with the lines it lists.
    /// </summary>
    public MetricsRegistry? MetricsRegistry { get; init; }

    /// <summary>
    /// Whether its clients reach the server through a real pair of the in-memory transport (spec
    /// 15.13), each connection a <see cref="MemoryTransportClient"/> of one
    /// <see cref="MemoryTransportServer"/>, rather than a transport the player scripts; a
    /// conversation that opens a connection the in-memory transport is not is played scripted all
    /// the same (<see cref="ConversationPlayer.CanStandFor"/>).
    /// </summary>
    public bool IsInMemory { get; init; }
}

/// <summary>
/// What plays a conversation of <c>spec/conversations.json</c>'s against the C# server of the
/// interop service — what its clients send, each on its own connection, what the server sends back
/// on each and reports, on a clock the conversation alone advances — and, given a registry, an exit
/// of <c>spec/metrics.json</c>'s, the same steps and its <c>counted</c> ones. The TypeScript side's
/// player plays the same files.
/// </summary>
internal static class ConversationPlayer
{
    // constants

    // the one connection of a conversation that opens none, opened before its first step
    private const string OnlyConnection = "connection";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // every key a step may hold, each one read as it is played: a step that holds another fails,
    // never passes with what it asks left unplayed
    private static readonly HashSet<string> StepKeys =
    [
        "advance", "carried", "carries", "close", "counted", "expect", "on", "open", "report", "secure",
        "send", "token", "twoWay", "until", "wall",
    ];

    // helpers

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
                "maximumAnsweringCalls" => limits with { MaximumAnsweringCalls = value },
                "transferInactivityTimeout" => limits with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(value) },
                _ => throw new ArgumentException($"a conversation sets a limit no test reads: {limit.Name}", nameof(conversation)),
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

    // the server's relay, the conversation's where it gives it: whether it verifies, and its
    // admission, requireCredential, the server's default, which the server built gives, or
    // shareLegBSession or requireSession in its place, the server's once it is built
    private static RelayOptions? RelayOf((JsonElement Conversation, Func<Server<string>> Built) given)
    {
        if (!given.Conversation.TryGetProperty("relay", out var relay))
        {
            return null;
        }

        var options = new RelayOptions { Verifies = relay.TryGetProperty("verifies", out var verifies) && verifies.GetBoolean() };

        // an admission of the server's, read once it is built, with the refusal it gives
        RelayOptions Admitting(string name, Func<Server<string>, BeforeRequest> admission)
        {
            return options with
            {
                // ! under the name of the server's own, which a refusal it marks reports as its reason
                BeforeRoute = new BeforeRequest(
                    (request) =>
                    {
                        return admission(given.Built()).Admits(request);
                    },
                    Failure.OfProtocol(ProtocolCode.SessionRequired))
                {
                    Name = name,
                },
            };
        }

        return relay.TryGetProperty("beforeRoute", out var beforeRoute) switch
        {
            false => options,
            true when beforeRoute.GetString() == "requireCredential" => options,
            true when beforeRoute.GetString() == "shareLegBSession" => Admitting("shareLegBSession", (server) =>
            {
                return server.ShareLegBSession;
            }),
            true when beforeRoute.GetString() == "requireSession" => Admitting("requireSession", (server) =>
            {
                return server.RequireSession;
            }),
            _ => throw new ArgumentException($"a conversation's relay admits by a name no test reads: {beforeRoute}", nameof(given)),
        };
    }

    // a header's credential, as vectors.json writes it, a JWT's token a character a byte; an
    // OPAQUE's token and a scheme to come's bytes in hexadecimal, a scheme to come by its number
    private static string CredentialOf(Credential credential)
    {
        switch (credential.Scheme)
        {
            case CredentialScheme.Jwt:
                {
                    return $"credential JWT {credential.Token}";
                }

            case CredentialScheme.Opaque:
                {
                    var token = new byte[SessionToken.Bytes];

                    credential.SessionToken!.Value.CopyTo(token);

                    return $"credential OPAQUE {Convert.ToHexString(token)}";
                }

            case CredentialScheme.None or CredentialScheme.Elsewhere:
                {
                    return $"credential {credential.Scheme.ToString().ToUpperInvariant()}";
                }

            default:
                {
                    return $"credential {(ushort)credential.Scheme} {Convert.ToHexString(credential.Bytes.Span)}";
                }
        }
    }

    // a credential a request presents, as a conversation writes it, written as CredentialOf writes
    // what was sent
    private static string PresentedOf(JsonElement credential)
    {
        var scheme = credential.GetProperty("scheme");

        if (scheme.ValueKind == JsonValueKind.Number)
        {
            return $"credential {scheme.GetInt32()} {Convert.ToHexString(Vectors.FromHexadecimal(credential.GetProperty("bytes").GetString()!))}";
        }

        return scheme.GetString() switch
        {
            "JWT" => $"credential JWT {credential.GetProperty("token").GetString()}",
            "OPAQUE" => $"credential OPAQUE {Convert.ToHexString(Vectors.FromHexadecimal(credential.GetProperty("bytes").GetString()!))}",
            var name => $"credential {name}",
        };
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

    // an envelope sent, and the credential its transport carried beside it, as a conversation
    // writes what it expects
    private static string OutOf((ReadOnlyMemory<byte> Bytes, string? Carried) sent)
    {
        var bytes = sent.Bytes;
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
            CreditHeader credit => $"{kind} {callId}{(credit.Paced ? " paced" : "")} credit {credit.CreditEnd}",

            // a command the server sends its client, with its flags, the envelope's byte 2 as sent,
            // the credential it presents, and what its transport carried beside it
            RequestHeader request => $"{kind} {callId} flags {bytes.Span[2]} {request.ServiceId}/{request.ProcedureId} {Convert.ToHexString(envelope.Payload.Span)}"
                + (request.Credential is { } presented ? $" {CredentialOf(presented)}" : "")
                + (sent.Carried is { } carried ? $" carried {carried}" : ""),
            _ => $"{kind} {callId}",
        };
    }

    // what a send writes, its tokens named between angle brackets written as their 16 bytes
    private static byte[] SentOf(string written, Dictionary<string, SessionToken> tokens)
    {
        var hexadecimal = Regex.Replace(written, "<([^<>]+)>", (named) =>
        {
            Span<byte> bytes = stackalloc byte[SessionToken.Bytes];

            tokens[named.Groups[1].Value].CopyTo(bytes);

            return Convert.ToHexString(bytes);
        });

        return Vectors.FromHexadecimal(hexadecimal);
    }

    // what a step says a transport carried beside its envelope: its carried; none when it says none
    private static string? CarriedOf(JsonElement step)
    {
        return step.TryGetProperty("carried", out var carried) ? carried.GetString() : null;
    }

    // the token an answer announced, OPAQUE; none for any other
    private static SessionToken? AnnouncedOf(ReadOnlyMemory<byte> bytes)
    {
        var header = EnvelopeCodec.ReadEnvelope(
            bytes.Span,
            new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!.Header;

        return header switch
        {
            ResultHeader { Credential.SessionToken: { } token } => token,
            FailureHeader { Credential.SessionToken: { } token } => token,
            _ => null,
        };
    }

    // a failure's detail, as it was sent
    private static string DetailOf(ReadOnlyMemory<byte> bytes)
    {
        return EnvelopeCodec.ReadEnvelope(
            bytes.Span,
            new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!.Failure!.Detail;
    }

    // what a conversation expects, and what its transport carried beside a request, written as OutOf
    // writes what was sent
    private static string ExpectedOf((JsonElement Expected, string? Carried) step)
    {
        var expected = step.Expected;
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
            ? Convert.ToHexString(Vectors.FromHexadecimal(payload.GetString()!))
            : null;

        if (expected.TryGetProperty("procedureId", out var procedureId))
        {
            var presented = announced.ValueKind == JsonValueKind.Object ? $" {PresentedOf(announced)}" : "";

            return $"{kind} {callId} flags {expected.GetProperty("flags").GetInt32()} {expected.GetProperty("serviceId").GetInt32()}/{procedureId.GetInt32()} {hexadecimal}"
                + presented
                + (step.Carried is { } carried ? $" carried {carried}" : "");
        }

        if (expected.TryGetProperty("offset", out var offset))
        {
            return $"{kind} {callId} from {offset.GetInt64()}{(expected.GetProperty("isLast").GetBoolean() ? " last" : "")} {hexadecimal}";
        }

        if (expected.TryGetProperty("creditEnd", out var creditEnd))
        {
            return $"{kind} {callId}{(expected.GetProperty("paced").GetBoolean() ? " paced" : "")} credit {creditEnd.GetInt64()}";
        }

        var total = expected.TryGetProperty("total", out var declared) ? $" total {declared.GetInt64()}" : "";

        return hexadecimal is null ? $"{kind} {callId}" : $"{kind} {callId} {hexadecimal}{credential}{total}";
    }

    // each series an exposition writes, by its name and its labels, with its line
    private static Dictionary<string, string> SeriesOf(string exposition)
    {
        return exposition.Split('\n', StringSplitOptions.RemoveEmptyEntries).Where((line) =>
        {
            return !line.StartsWith('#');
        }).ToDictionary(
            (line) =>
            {
                return line[..line.LastIndexOf(' ')];
            },
            (line) =>
            {
                return line;
            },
            StringComparer.Ordinal);
    }

    // definition

    /// <summary>
    /// Plays <paramref name="conversation"/>, its steps, its limits, its pacing and its relay, on a
    /// server of the interop service's built anew, as <paramref name="options"/> say.
    /// </summary>
    public static async Task Play(JsonElement conversation, PlayerOptions options)
    {
        var steps = conversation.GetProperty("steps");
        var scheduler = new SerialScheduler();

        // the server's clock, which settles once its router and its resolvers are idle
        var clock = new SteppingClock(options.WallClock) { Settle = scheduler.WhenIdle };
        IPlayedTransport transport = options.IsInMemory && CanStandFor(conversation)
            ? new InMemoryTransport(scheduler, clock)
            : new ScriptedTransport { Clock = clock };

        // what the server reported, each with the connection it came with
        var reports = new List<(string Report, string? ConnectionHandle)>();

        // the tokens the server announced, by the name the conversation gave each
        var tokens = new Dictionary<string, SessionToken>();
        var limits = LimitsOf(conversation);
        Server<string>? built = null;

        // the server a conversation's relay takes an admission of, once it is built
        Server<string> Built()
        {
            return built!;
        }

        await using var server = new Server<string>(
            transport.Server,
            new ServerOptions
            {
                Credentials = CredentialsOf((limits, clock)),
                Limits = limits,
                MetricsRegistry = options.MetricsRegistry,
                Pacing = PacingOf(conversation),
                Relay = RelayOf((conversation, Built)),
                ResolverScheduler = scheduler,
                Scheduler = scheduler,
            });

        built = server;

        var router = server.Router;

        router.Error += (reason, connectionHandle) =>
        {
            reports.Add((
                reason is FailureException failure ? failure.Code.ToString(System.Globalization.CultureInfo.InvariantCulture) : "exception",
                connectionHandle));
        };
        InteropHandlers.Offer(server);

        // the series written once the server settled, read on its scheduler
        async Task<Dictionary<string, string>> Exposed()
        {
            await scheduler.WhenIdle();

            return SeriesOf(await scheduler.Run(() =>
            {
                return Task.FromResult(options.MetricsRegistry!.Exposition().Text);
            }));
        }

        // as the case begins, once the server declared what it offers: every series at 0
        var exposed = options.MetricsRegistry is null ? [] : await Exposed();

        // what was sent on each connection and reported, and the conversation did not expect yet
        IEnumerable<string> Pending()
        {
            return transport.Left().Select((left) =>
            {
                return $"{left.Name}: {OutOf((left.Bytes, left.Carried))}";
            }).Concat(reports.Select((report) =>
            {
                return $"{transport.NameOf(report.ConnectionHandle ?? "no connection")}: report {report.Report}";
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
            await transport.Open(OnlyConnection, new Carrying(true, true, true));
        }

        try
        {
            foreach (var step in steps.EnumerateArray())
            {
                Assert.Subset(StepKeys, step.EnumerateObject().Select((property) =>
                {
                    return property.Name;
                }).ToHashSet(StringComparer.Ordinal));

                var connection = step.TryGetProperty("on", out var on) ? on.GetString()! : OnlyConnection;

                if (step.TryGetProperty("open", out var opened))
                {
                    var carrying = new Carrying(
                        !step.TryGetProperty("twoWay", out var twoWay) || twoWay.GetBoolean(),
                        !step.TryGetProperty("carries", out var carries) || carries.GetBoolean(),
                        !step.TryGetProperty("secure", out var secure) || secure.GetBoolean());

                    await NothingMore();
                    await transport.Open(opened.GetString()!, carrying);
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("send", out var bytes))
                {
                    await NothingMore();
                    await transport.Deliver(new TransportMessage(SentOf(bytes.GetString()!, tokens), false) { Credential = CarriedOf(step) }, connection);
                    await scheduler.WhenIdle();
                }

                if (step.TryGetProperty("close", out _))
                {
                    await NothingMore();
                    await transport.Closed(connection);
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

                // the next envelope sent on its connection; when none was, what came instead. A
                // failure's detail is compared where the conversation gives it, and a token
                // announced is kept under the name the step gives it
                if (step.TryGetProperty("expect", out var expected))
                {
                    var sent = transport.Next(connection);

                    Assert.Equal(
                        ExpectedOf((expected, CarriedOf(step))),
                        sent is { } envelope ? OutOf(envelope) : $"nothing, but [{string.Join(", ", Pending())}]");

                    if (expected.TryGetProperty("failure", out var failure) && failure.TryGetProperty("detail", out var detail))
                    {
                        Assert.Equal(detail.GetString(), DetailOf(sent!.Value.Bytes));
                    }

                    if (step.TryGetProperty("token", out var token))
                    {
                        tokens[token.GetString()!] = AnnouncedOf(sent!.Value.Bytes)!.Value;
                    }
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

                // the series that moved since the case began or the last counted, read on the server's
                // scheduler once the step before settled: each by its line, in the exposition's order;
                // none made, none gone
                if (step.TryGetProperty("counted", out var counted))
                {
                    var now = await Exposed();

                    Assert.Equal(exposed.Keys, now.Keys);
                    Assert.Equal(
                        counted.EnumerateArray().Select((line) =>
                        {
                            return line.GetString();
                        }),
                        now.Where((series) =>
                        {
                            return exposed[series.Key] != series.Value;
                        }).Select((series) =>
                        {
                            return series.Value;
                        }));
                    exposed = now;
                }
            }

            await NothingMore();
        }
        finally
        {
            await transport.CloseEach();
            await scheduler.WhenIdle();
        }
    }

    /// <summary>
    /// Whether a pair of the in-memory transport can stand for every connection a conversation
    /// opens: each carries the server's own envelopes back and is secure, as an in-memory one is;
    /// and none is asked to carry a credential toward its client, which an in-memory one never
    /// carries (spec 15.13).
    /// </summary>
    public static bool CanStandFor(JsonElement conversation)
    {
        var steps = conversation.GetProperty("steps").EnumerateArray().ToList();

        return steps.All((step) =>
        {
            var isTwoWay = !step.TryGetProperty("twoWay", out var twoWay) || twoWay.GetBoolean();
            var isSecure = !step.TryGetProperty("secure", out var secure) || secure.GetBoolean();
            var carriesBack = step.TryGetProperty("expect", out var expected) && expected.TryGetProperty("procedureId", out _) && step.TryGetProperty("carried", out _);

            return isTwoWay && isSecure && !carriesBack;
        });
    }

    // what a connection opened carries: the server's own envelopes back, a credential beside an
    // envelope, and whether it is secure
    private readonly record struct Carrying(bool IsTwoWay, bool CarriesCredential, bool IsSecure);

    // what the player plays its clients through: connections it opens by name, delivers to and
    // closes, and what the server sent on each, with the credential carried beside it
    private interface IPlayedTransport
    {
        IServerTransport Server { get; }

        string HandleOf(string name);

        string NameOf(string connectionHandle);

        Task Open(string name, Carrying carrying);

        Task Deliver(TransportMessage message, string name);

        Task Closed(string name);

        Task CloseEach();

        (ReadOnlyMemory<byte> Bytes, string? Carried)? Next(string name);

        IReadOnlyList<(string Name, ReadOnlyMemory<byte> Bytes, string? Carried)> Left();
    }

    // a real pair of the in-memory transport: each connection a client of its own, the first named
    // on the port 50001, the next on 50002, both ends telling on the server's scheduler, so its idle
    // is the transport's too. A name opened again is a new connection, under the handle it drew
    private sealed class InMemoryTransport(SerialScheduler scheduler, TimeProvider clock) : IPlayedTransport, IAsyncDisposable
    {
        private readonly MemoryTransportServer _server = new(new MemoryTransportServerOptions { Clock = clock, Scheduler = scheduler });

        // what is sent on the scheduler, and taken on the test's
        private readonly Lock _gate = new();

        // by name, its client, its handle and its port; and back
        private readonly Dictionary<string, MemoryTransportClient> _clients = [];
        private readonly Dictionary<string, string> _handles = [];
        private readonly Dictionary<string, string> _names = [];
        private readonly Dictionary<string, int> _ports = [];

        // by handle, what was sent on it and not yet taken, in order
        private readonly Dictionary<string, Queue<(ReadOnlyMemory<byte> Bytes, string? Carried)>> _sent = [];

        public IServerTransport Server
        {
            get
            {
                return _server;
            }
        }

        public string HandleOf(string name)
        {
            return _handles.GetValueOrDefault(name, name);
        }

        public string NameOf(string connectionHandle)
        {
            return _names.GetValueOrDefault(connectionHandle, connectionHandle);
        }

        // * what the step asks of a connection is what an in-memory one is: CanStandFor chose it so
        public async Task Open(string name, Carrying carrying)
        {
            if (_server.ReadyState != ReadyState.Open)
            {
                await _server.Start();
            }

            if (!_ports.TryGetValue(name, out var port))
            {
                port = 50_001 + _ports.Count;
                _ports[name] = port;
            }

            var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock, Scheduler = scheduler });
            var drawn = new List<string>();

            void Drawn(string connectionHandle)
            {
                drawn.Add(connectionHandle);
            }

            _server.Connection += Drawn;

            try
            {
                await client.Connect(new MemoryConnectOptions { Server = _server, Address = "127.0.0.1", Port = port });
            }
            finally
            {
                _server.Connection -= Drawn;
            }

            var handle = Assert.Single(drawn);

            client.Message += (message) =>
            {
                lock (_gate)
                {
                    if (!_sent.TryGetValue(handle, out var sent))
                    {
                        sent = [];
                        _sent[handle] = sent;
                    }

                    sent.Enqueue((message.Bytes, message.Credential));
                }
            };
            _clients[name] = client;
            _handles[name] = handle;
            _names[handle] = name;
        }

        public Task Deliver(TransportMessage message, string name)
        {
            return _clients[name].Send(message);
        }

        // closed by its client, unclean, as the scripted transport tells it
        public async Task Closed(string name)
        {
            if (_clients.Remove(name, out var client))
            {
                await client.CloseConnection(new TransportDisconnectOptions { IsClean = false });
                await client.DisposeAsync();
            }
        }

        // closes every connection still open, then stops the server
        public async Task CloseEach()
        {
            foreach (var name in _clients.Keys.ToList())
            {
                await Closed(name);
            }

            await DisposeAsync();
        }

        // stops the server
        public ValueTask DisposeAsync()
        {
            return _server.DisposeAsync();
        }

        public (ReadOnlyMemory<byte> Bytes, string? Carried)? Next(string name)
        {
            var handle = HandleOf(name);

            lock (_gate)
            {
                return _sent.TryGetValue(handle, out var sent) && sent.TryDequeue(out var next) ? next : null;
            }
        }

        public IReadOnlyList<(string Name, ReadOnlyMemory<byte> Bytes, string? Carried)> Left()
        {
            lock (_gate)
            {
                return [.. _sent.SelectMany((sent) =>
                {
                    return sent.Value.Select((left) =>
                    {
                        return (NameOf(sent.Key), left.Bytes, left.Carried);
                    });
                })];
            }
        }
    }

    // a transport of connections a test opens by name, delivers to and closes, which records what
    // it sends on each, with the credential it carries beside it. A name opened again is a new
    // connection, under a new handle, its ordinal the next, as every transport draws a handle it
    // never gave (spec 15.1)
    private sealed class ScriptedTransport : IServerTransport, IPlayedTransport
    {
        // what is sent and asked on the router's scheduler, and taken on the test's
        private readonly Lock _gate = new();

        // by name, the handle of the connection it opened last, the first named on the port 50001,
        // the next on 50002, its port and how many it opened; and back, every handle drawn
        private readonly Dictionary<string, string> _handles = [];
        private readonly Dictionary<string, int> _ports = [];
        private readonly Dictionary<string, int> _opens = [];
        private readonly Dictionary<string, string> _names = [];

        // by handle, what was sent on it and not yet taken, in order
        private readonly Dictionary<string, Queue<(ReadOnlyMemory<byte> Bytes, string? Carried)>> _sent = [];

        // the handles of the connections open, and what each carries
        private readonly HashSet<string> _open = [];
        private readonly Dictionary<string, Carrying> _carrying = [];

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public string? Type
        {
            get
            {
                return TransportTypes.WebSocket;
            }
        }

        public IServerTransport Server
        {
            get
            {
                return this;
            }
        }

        public string HandleOf(string name)
        {
            if (!_handles.TryGetValue(name, out var handle))
            {
                if (!_ports.TryGetValue(name, out var port))
                {
                    port = 50001 + _ports.Count;
                    _ports[name] = port;
                }

                handle = $"type=WS;ip=127.0.0.1;port={port};ordinal={Math.Max(_opens.GetValueOrDefault(name), 1)}";
                _handles[name] = handle;
                _names[handle] = name;
            }

            return handle;
        }

        public string NameOf(string connectionHandle)
        {
            return _names.GetValueOrDefault(connectionHandle, connectionHandle);
        }

        public Task Open(string name, Carrying carrying)
        {
            // * a name opened before opens a new connection, under a handle never given
            var opens = _opens.GetValueOrDefault(name) + 1;

            _opens[name] = opens;

            if (opens > 1)
            {
                _handles.Remove(name);
            }

            var handle = HandleOf(name);

            lock (_gate)
            {
                _carrying[handle] = carrying;
            }

            _open.Add(handle);
            Connection?.Invoke(handle);

            return Task.CompletedTask;
        }

        public Task Deliver(TransportMessage message, string name)
        {
            Message?.Invoke(message, HandleOf(name));

            return Task.CompletedTask;
        }

        public Task Closed(string name)
        {
            var handle = HandleOf(name);

            _open.Remove(handle);
            Close?.Invoke(false, handle);

            return Task.CompletedTask;
        }

        // closes every connection still open
        public Task CloseEach()
        {
            foreach (var handle in _open.ToList())
            {
                _open.Remove(handle);
                Close?.Invoke(false, handle);
            }

            return Task.CompletedTask;
        }

        // the next envelope sent on a connection, with what it carried beside it, taken; none while
        // none waits
        public (ReadOnlyMemory<byte> Bytes, string? Carried)? Next(string name)
        {
            var handle = HandleOf(name);

            lock (_gate)
            {
                return _sent.TryGetValue(handle, out var sent) && sent.TryDequeue(out var next) ? next : null;
            }
        }

        // what was sent and not yet taken, each with the name of its connection
        public IReadOnlyList<(string Name, ReadOnlyMemory<byte> Bytes, string? Carried)> Left()
        {
            lock (_gate)
            {
                return [.. _sent.SelectMany((sent) =>
                {
                    return sent.Value.Select((left) =>
                    {
                        return (NameOf(sent.Key), left.Bytes, left.Carried);
                    });
                })];
            }
        }

        public bool IsTwoWay(string connectionHandle)
        {
            lock (_gate)
            {
                return !_carrying.TryGetValue(connectionHandle, out var carrying) || carrying.IsTwoWay;
            }
        }

        public bool CarriesCredential(string connectionHandle)
        {
            lock (_gate)
            {
                return !_carrying.TryGetValue(connectionHandle, out var carrying) || carrying.CarriesCredential;
            }
        }

        public bool IsSecure(string connectionHandle)
        {
            lock (_gate)
            {
                return !_carrying.TryGetValue(connectionHandle, out var carrying) || carrying.IsSecure;
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

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var bytes = message.Bytes;

            lock (_gate)
            {
                if (!_sent.TryGetValue(connectionHandle, out var sent))
                {
                    sent = [];
                    _sent[connectionHandle] = sent;
                }

                sent.Enqueue((bytes.ToArray(), message.Credential));
            }

            return Task.CompletedTask;
        }
    }
}
