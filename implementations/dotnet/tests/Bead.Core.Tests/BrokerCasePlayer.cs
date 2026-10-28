using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Bead.Interop;
using Xunit.Sdk;

namespace Bead.Tests;

/// <summary>What a broker's case is played on: the case, the clock given and the scheduler the side's participant runs on.</summary>
internal sealed record BrokerCaseSetup(JsonElement Entry, SteppingClock Clock, SerialScheduler Scheduler);

/// <summary>
/// The broker a case of <c>spec/transports.json</c> over a broker plays against: the in-memory one
/// of the core (transport <c>broker</c>), or a real one (transport <c>mqtt</c> or <c>amqp</c>). It makes the adapter
/// of each participant a case names, the one under test among them, and does to a link what a step
/// asks; the player does the rest alike over every broker.
/// </summary>
internal interface IBrokerCaseBroker : IAsyncDisposable
{
    /// <summary>
    /// The adapter of the participant <paramref name="id"/>, not started: the one under test, a
    /// peer, or a twin.
    /// </summary>
    IBrokerAdapter AdapterOf(string id);

    /// <summary>Loses the link of the participant <paramref name="id"/> without a clean end: its will published where it left one.</summary>
    Task Lose(string id);

    /// <summary>Takes the link of the participant <paramref name="id"/> over by another link of its id.</summary>
    Task TakeOver(string id);

    /// <summary>
    /// Publishes each publication of a peer, in its order, none awaited before the next — in memory
    /// in one turn of its broker's — marked retained where asked, which a real broker's binding
    /// never writes; what its broker said of each.
    /// </summary>
    Task<BrokerPublished[]> PublishAll((IBrokerAdapter Peer, IReadOnlyList<BrokerPublication> Publications, bool IsRetained) publishing);

    /// <summary>Runs <paramref name="action"/> as one turn: in memory one of its broker's, so what it publishes goes before anything it then starts.</summary>
    Task Turn(Action action);

    /// <summary>The messages the adapter under test handed its participant and it has not acknowledged.</summary>
    long UnsettledOf(IBrokerAdapter adapter);

    /// <summary>How long a copy of what was read may take to come after it: none in memory, where what is idle came.</summary>
    TimeSpan Settling { get; }

    /// <summary>
    /// Subscribes a peer of the client role to the server's name, so that it reads every OPEN to
    /// it, as each subscriber of a topic does over a broker: the name itself, unless a broker's
    /// name is a queue its consumers compete on, as AMQP 1.0's is, and then through a queue of the
    /// peer's own, bound by the name.
    /// </summary>
    Task SubscribeName((IBrokerAdapter Peer, string Id, IReadOnlyList<string> Name) subscribing)
    {
        return subscribing.Peer.Subscribe(subscribing.Name);
    }
}

/// <summary>
/// One case of <c>spec/transports.json</c> over a broker, played against a side's broker transports
/// over the broker it is given, both roles: in the server role the interop service's server on a
/// broker server transport, its participant's id <c>server</c>; in the client role a broker client
/// transport alone, its participant's id <c>client</c>, built with no reconnection; and the test's
/// own peers, a twin and a takeover's link among them, publishing the parcels a case writes and
/// reading what reaches them. The participant under test, the server and the clock given share one
/// scheduler, on which the clock settles. Every participant of the case is stopped clean once it
/// ends, since a link left up of the same id would take the next case's over. The TypeScript side
/// plays the same cases.
/// </summary>
internal sealed class BrokerCasePlayer : IAsyncDisposable
{
    // constants

    private const string RootToken = "bead";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // the incarnation every peer's OPENs name, which a peer's will names too
    private const string PeerIncarnation = "C0C1C2C3C4C5C6C7C8C9CACBCCCDCECF";

    private readonly SerialScheduler _scheduler = new();
    private readonly SteppingClock _clock;
    private readonly IBrokerCaseBroker _broker;
    private readonly BrokerParticipant _participant;
    private readonly RecordingAdapter _adapter;
    private readonly Dictionary<string, Peer> _peers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _captured = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<(Exception Reason, string ConnectionHandle)> _reports = new();
    private readonly ConcurrentQueue<TransportServerRefusal> _refusals = new();
    private readonly ConcurrentQueue<(bool IsClean, string ConnectionHandle)> _closes = new();
    private readonly ConcurrentQueue<string> _routerReports = new();
    private readonly Channel<TransportMessage> _received = Channel.CreateUnbounded<TransportMessage>();
    private readonly bool _isClient;
    private readonly TimeSpan _connectTimeout;
    private BrokerTransportServer? _transport;
    private Server<string>? _server;
    private BrokerTransportClient? _client;
    private Peer? _twin;
    private Task? _connecting;

    private BrokerCasePlayer((JsonElement Entry, Func<BrokerCaseSetup, IBrokerCaseBroker> Broker) played)
    {
        var (entry, brokerOf) = played;

        _isClient = entry.TryGetProperty("role", out var role) && role.GetString() == "client";
        _clock = new SteppingClock(WallClock) { Settle = _scheduler.WhenIdle };
        _broker = brokerOf(new BrokerCaseSetup(entry, _clock, _scheduler));
        _adapter = new RecordingAdapter(_broker.AdapterOf(_isClient ? "client" : "server"));
        _connectTimeout = OptionOf((entry, "timeout")) is { } timeout ? TimeOf(timeout) : TimeSpan.FromSeconds(10);

        var limits = LimitsOf(entry);

        _participant = new BrokerParticipant(_adapter, new BrokerParticipantOptions
        {
            BodyGracePeriod = OptionOf((entry, "bodyGracePeriod")) is { } grace ? TimeOf(grace) : ServerBounds.BodyGracePeriod,
            Clock = _clock,
            HeldBytesBudget = OptionOf((entry, "heldBytesBudget"))?.GetInt64() ?? 268_435_456,
            Heartbeat = OptionOf((entry, "heartbeat")) is { } heartbeat ? TimeOf(heartbeat) : TimeSpan.FromSeconds(30),

            // * a client alone connects no more once its link is lost; a server's participant links anew
            IsReconnecting = !_isClient,

            // * the router's envelope by default, as its server sizes it (spec 15.20)
            MaximumEnvelopePartsBytes = OptionOf((entry, "maximumEnvelopePartsBytes"))?.GetInt64() ?? limits.MaximumEnvelopeBytes,
            MinimumBodyBytesPerSecond = OptionOf((entry, "minimumBodyBytesPerSecond"))?.GetInt32() ?? ServerBounds.MinimumBodyBytesPerSecond,
            Scheduler = _scheduler,
        });

        foreach (var option in entry.TryGetProperty("options", out var options) ? options.EnumerateObject().ToList() : [])
        {
            if (option.Name is not ("maximumConnections" or "maximumConnectionsPerAddress" or "acceptTimeout" or "names" or "group" or "maximumUnsentBytes"
                or "heartbeat" or "heldBytesBudget" or "maximumEnvelopePartsBytes" or "minimumBodyBytesPerSecond" or "bodyGracePeriod" or "maximumQueuedMessages"
                or "twin" or "wills" or "timeout"))
            {
                throw new ArgumentException($"a case sets an option no test reads: {option.Name}", nameof(played));
            }
        }

        if (_isClient)
        {
            _client = _participant.Client();
            _client.Message += (message) =>
            {
                _received.Writer.TryWrite(message);
            };
            _client.Close += (isClean, _) =>
            {
                _closes.Enqueue((isClean, ""));
            };
            _client.Error += (reason) =>
            {
                _reports.Enqueue((reason, ""));
            };

            return;
        }

        _transport = _participant.Server(new BrokerTransportServerOptions
        {
            AcceptTimeout = OptionOf((entry, "acceptTimeout")) is { } accept ? TimeOf(accept) : TimeSpan.FromSeconds(30),
            IsInGroup = OptionOf((entry, "group"))?.GetBoolean() ?? false,
            MaximumConnections = OptionOf((entry, "maximumConnections"))?.GetInt32() ?? 10_000,
            MaximumConnectionsPerAddress = OptionOf((entry, "maximumConnectionsPerAddress"))?.GetInt32() ?? 64,
            MaximumUnsentBytes = OptionOf((entry, "maximumUnsentBytes"))?.GetInt64(),
            Names = OptionOf((entry, "names")) is { } names ? [.. names.EnumerateArray().Select((named) =>
            {
                return named.GetString()!;
            })] : ["interop"],
        });
        _server = new Server<string>(_transport, new ServerOptions
        {
            Credentials = CredentialsOf((limits, _clock)),
            Limits = limits,
            ResolverScheduler = _scheduler,
            Scheduler = _scheduler,
        });
        InteropHandlers.Offer(_server);
        _transport.Error += (reason, connectionHandle) =>
        {
            _reports.Enqueue((reason, connectionHandle));
        };
        _transport.Refusal += _refusals.Enqueue;
        _transport.Close += (isClean, connectionHandle) =>
        {
            _closes.Enqueue((isClean, connectionHandle));
        };
        _server.Router.Error += (reason, connectionHandle) =>
        {
            _routerReports.Enqueue($"{(reason is FailureException failure ? failure.Code.ToString(CultureInfo.InvariantCulture) : reason.Message)} on {connectionHandle}");
        };
    }

    /// <summary>Every case of the transports' cases, as their file holds them.</summary>
    public static JsonElement Root { get; } = Load();

    // where every case's wall clock starts
    private static DateTimeOffset WallClock
    {
        get
        {
            return DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);
        }
    }

    // the name the server under test serves, or the client under test connects to
    private string ServedName { get; init; } = "interop";

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    /// <summary>A case's name.</summary>
    public static string NameOf(JsonElement entry)
    {
        return entry.GetProperty("name").GetString()!;
    }

    /// <summary>The case of a transport by its name.</summary>
    public static JsonElement CaseOf((string Transport, string Name) named)
    {
        return Root.GetProperty("cases").EnumerateArray().First((entry) =>
        {
            return entry.GetProperty("transport").GetString() == named.Transport && NameOf(entry) == named.Name;
        });
    }

    /// <summary>Whether a row of the support matrix excuses the side of a language from a case.</summary>
    public static bool IsExcused((JsonElement Entry, string Language) excused)
    {
        return excused.Entry.TryGetProperty("differs", out var differs) && differs.EnumerateArray().Any((row) =>
        {
            return row.GetProperty("language").GetString() == excused.Language;
        });
    }

    /// <summary>
    /// Plays a case against the broker <paramref name="brokerOf"/> makes: each step in its order, a
    /// failure naming the step, then nothing more reported, and every participant stopped.
    /// </summary>
    public static async Task Play(JsonElement entry, Func<BrokerCaseSetup, IBrokerCaseBroker> brokerOf)
    {
        var steps = entry.GetProperty("steps").EnumerateArray().ToList();

        // * the keys of a case, as the schema defines them: one this harness does not know fails its case
        Assert.Empty(entry.EnumerateObject().Where((property) =>
        {
            return property.Name is not ("clauses" or "differs" or "limits" or "name" or "options" or "peers" or "realTime" or "role" or "steps" or "transport");
        }).Select((property) =>
        {
            return property.Name;
        }));

        await using var played = await Of((entry, brokerOf));

        for (var index = 0; index < steps.Count; index += 1)
        {
            try
            {
                await played.Take(steps[index]);
            }
            catch (Exception reason) when (reason is not OperationCanceledException)
            {
                throw new XunitException($"step {index + 1}, {Describe(steps[index])}: {reason.Message}", reason is XunitException ? null : reason);
            }
        }

        await played.NothingMore();
    }

    public async ValueTask DisposeAsync()
    {
        // ! every participant of the case stopped clean, whatever its end: a link of the same id
        // left up would take the next case's over
        try
        {
            if (_server is not null)
            {
                await _server.DisposeAsync();
            }

            if (_client is not null)
            {
                await _client.DisposeAsync();
            }

            await _participant.DisposeAsync();
        }
        finally
        {
            foreach (var peer in _peers.Values.Append(_twin).OfType<Peer>())
            {
                try
                {
                    await peer.Adapter.Stop();
                }
                catch (InvalidOperationException)
                {
                    // its link lost by the case: there is nothing left to stop
                }
            }

            await _broker.DisposeAsync();
        }
    }

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "transports.json")));

        return document.RootElement.Clone();
    }

    private static TimeSpan TimeOf(JsonElement milliseconds)
    {
        return TimeSpan.FromMilliseconds(milliseconds.GetInt64());
    }

    private static string MillisecondsOf(TimeSpan time)
    {
        return Math.Round(time.TotalMilliseconds, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture);
    }

    private static string HexadecimalOf(string written)
    {
        return Convert.ToHexString(Vectors.FromHexadecimal(written));
    }

    private static string HalfOf(ulong half)
    {
        var bytes = new byte[8];

        BinaryPrimitives.WriteUInt64BigEndian(bytes, half);

        return Convert.ToHexString(bytes);
    }

    private static string IncarnationOf(UInt128 incarnation)
    {
        var bytes = new byte[16];

        BinaryPrimitives.WriteUInt128BigEndian(bytes, incarnation);

        return Convert.ToHexString(bytes);
    }

    // a case's option, or none
    private static JsonElement? OptionOf((JsonElement Entry, string Name) option)
    {
        return option.Entry.TryGetProperty("options", out var options) && options.TryGetProperty(option.Name, out var value) ? value : null;
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

    // the words a report must name, each whole
    private static bool IsNaming((string Message, string Word) named)
    {
        return Regex.IsMatch(named.Message, $"(?<![A-Za-z0-9]){Regex.Escape(named.Word)}(?![A-Za-z0-9])", RegexOptions.CultureInvariant);
    }

    // the peer a handle names, by its participant's id
    private static string PeerOf(string connectionHandle)
    {
        return Regex.Match(connectionHandle, "participant=([^;]*)", RegexOptions.CultureInvariant) is { Success: true } named ? named.Groups[1].Value : connectionHandle;
    }

    // an envelope, as a conversation writes what it expects; what is none, as its bytes
    private static string EnvelopeOf(ReadOnlyMemory<byte> bytes)
    {
        try
        {
            return ConversationPlayer.OutOf((bytes, null));
        }
        catch (Exception reason) when (reason is FailureException or NullReferenceException)
        {
            return $"no envelope: {Convert.ToHexString(bytes.Span)}";
        }
    }

    // a step in a few words: what it does, and on which peer
    private static string Describe(JsonElement step)
    {
        var kind = step.EnumerateObject().First((property) =>
        {
            return property.Name is not "on" and not "within" and not "from" and not "to" and not "retained" and not "refused" and not "at";
        }).Name;

        return step.TryGetProperty("on", out var on) ? $"{kind} on {on.GetString()}" : kind;
    }

    // a GONE of a peer's id and the incarnation its OPENs name, its will where the case asks one
    private static BrokerPublication WillOf(string id)
    {
        return new BrokerPublication
        {
            Topic = [RootToken, "d", id],
            Payload = BrokerParcels.Write(new BrokerParcel
            {
                Kind = BrokerParcelKinds.Gone,
                Incarnation = BinaryPrimitives.ReadUInt128BigEndian(Convert.FromHexString(PeerIncarnation)),
                Id = id,
            }),
        };
    }

    // a reader of what reaches an adapter, settling each as it comes: what reaches a departure on a
    // channel of its own, everything else on another, each in order
    private static Peer PeerOf(IBrokerAdapter adapter)
    {
        var peer = new Peer(adapter, Channel.CreateUnbounded<BrokerMessage>(), Channel.CreateUnbounded<BrokerMessage>());

        adapter.Message += (message) =>
        {
            message.Settle();
            (message.Topic is [_, "d", _] ? peer.Departures : peer.Heard).Writer.TryWrite(message);
        };

        return peer;
    }

    // the case's broker and peers, each linked with its inbox subscribed, and, in the client role,
    // the server's name and the client's departure; its twin, where it names one, subscribed to the
    // name in its group; the server under test started
    private static async Task<BrokerCasePlayer> Of((JsonElement Entry, Func<BrokerCaseSetup, IBrokerCaseBroker> Broker) played)
    {
        var entry = played.Entry;
        var player = new BrokerCasePlayer(played)
        {
            ServedName = OptionOf((entry, "names")) is { } names ? names[0].GetString()! : "interop",
        };

        try
        {
            var ids = entry.TryGetProperty("peers", out var peers)
                ? peers.EnumerateArray().Select((peer) =>
                {
                    return peer.GetString()!;
                }).ToList()
                : ["peer"];
            var hasWills = OptionOf((entry, "wills"))?.GetBoolean() ?? false;

            foreach (var id in ids)
            {
                var peer = PeerOf(player._broker.AdapterOf(id));

                player._peers[id] = peer;
                await peer.Adapter.Start(new BrokerStart { Will = hasWills ? WillOf(id) : null });
                await peer.Adapter.Subscribe([RootToken, "i", id]);

                if (player._isClient)
                {
                    await player._broker.SubscribeName((peer.Adapter, id, [RootToken, "s", player.ServedName]));

                    // * a departure where its broker leaves a will: AMQP 1.0's leaves none
                    if ((peer.Adapter.Capabilities & BrokerCapabilities.Will) != 0)
                    {
                        await peer.Adapter.Subscribe([RootToken, "d", "client"]);
                    }
                }
            }

            if (OptionOf((entry, "twin")) is { } twin)
            {
                player._twin = PeerOf(player._broker.AdapterOf(twin.GetString()!));
                await player._twin.Adapter.Start();
                await player._twin.Adapter.Subscribe([RootToken, "s", player.ServedName], new BrokerSubscription { Group = player.ServedName });
            }

            if (player._transport is { } transport)
            {
                await transport.Start();
            }
            else
            {
                await player._participant.Start();
            }

            await player._scheduler.WhenIdle();

            return player;
        }
        catch
        {
            await player.DisposeAsync();

            throw;
        }
    }

    private async Task Take(JsonElement step)
    {
        var on = step.TryGetProperty("on", out var named) ? named.GetString()! : "";
        var timing = new Timing(step);

        if (step.TryGetProperty("publish", out var publish))
        {
            await NothingMore();
            await Publish(step, publish);
        }
        else if (step.TryGetProperty("expect", out var expected))
        {
            await Expect((expected, step, timing));
        }
        else if (step.TryGetProperty("reported", out var reported))
        {
            await Reported((reported, on));
        }
        else if (step.TryGetProperty("until", out var until))
        {
            await (until.TryGetProperty("timer", out var timer) ? UntilArmed(timer) : Until(until));
        }
        else if (step.TryGetProperty("advance", out var advance))
        {
            await _clock.Advance(TimeOf(advance));
        }
        else if (step.TryGetProperty("wall", out var wall))
        {
            _clock.Wall(TimeOf(wall));
        }
        else if (step.TryGetProperty("wait", out var wait))
        {
            await Task.Delay(TimeOf(wait), Cancelled);
        }
        else if (step.TryGetProperty("stop", out var stop))
        {
            await NothingMore();
            await Stop(stop);
        }
        else if (step.TryGetProperty("connect", out var connect))
        {
            await NothingMore();
            _connecting = _client!.Connect(new BrokerConnectOptions { Server = connect.GetString()!, Timeout = _connectTimeout }, Cancelled);
        }
        else if (step.TryGetProperty("transportSend", out var send))
        {
            await NothingMore();
            await _client!.Send(new TransportMessage(Vectors.FromHexadecimal(send.GetProperty("envelope").GetString()!), false)
            {
                Credential = send.TryGetProperty("credential", out var credential) ? credential.GetString() : null,
            });
        }
        else if (step.TryGetProperty("lose", out var lose))
        {
            await NothingMore();
            await _broker.Lose(lose.GetString()!);
        }
        else if (step.TryGetProperty("takeover", out var takeover))
        {
            await NothingMore();
            await _broker.TakeOver(takeover.GetString()!);
        }
        else if (step.TryGetProperty("leave", out var leave))
        {
            var id = leave.GetString()!;

            await NothingMore();
            await _peers[id].Adapter.Unsubscribe([RootToken, "i", id]);
        }
        else
        {
            throw new ArgumentException($"a step no test plays: {Describe(step)}", nameof(step));
        }
    }

    // the side under test reported nothing, told no refusal, and its router reported nothing, that no step took
    private async Task NothingMore()
    {
        await _scheduler.WhenIdle();
        Assert.True(_reports.IsEmpty, $"reported nothing, and {string.Join("; ", _reports.Select((report) =>
        {
            return $"{report.Reason.Message} on {report.ConnectionHandle}";
        }))}");
        Assert.True(_refusals.IsEmpty, $"told no refusal, and {string.Join("; ", _refusals)}");
        Assert.True(_routerReports.IsEmpty, $"its router reported nothing, and {string.Join("; ", _routerReports)}");
    }

    // a value of a case with each value captured put in, as its {name}
    private string Filled(string text)
    {
        var filled = text;

        foreach (var (name, value) in _captured)
        {
            filled = filled.Replace($"{{{name}}}", value, StringComparison.Ordinal);
        }

        if (Regex.Match(filled, @"\{(\w+)\}") is { Success: true } uncaptured)
        {
            throw new InvalidOperationException($"nothing captured under {uncaptured.Groups[1].Value}");
        }

        return filled;
    }

    private ulong HalfFrom(JsonElement half)
    {
        return BinaryPrimitives.ReadUInt64BigEndian(Vectors.FromHexadecimal(Filled(half.GetString()!)));
    }

    // a parcel a peer publishes, by its fields, as its codec writes it, held to nothing
    private byte[] ParcelFrom(JsonElement fields)
    {
        var parcel = new BrokerParcel
        {
            Kind = fields.GetProperty("kind").GetByte(),
            Flags = fields.TryGetProperty("flags", out var flags) ? flags.GetByte() : (byte)0,
            Opener = HalfFrom(fields.GetProperty("opener")),
            Acceptor = HalfFrom(fields.GetProperty("acceptor")),
            Sequence = fields.GetProperty("sequence").GetUInt64(),
            Id = fields.TryGetProperty("id", out var id) ? id.GetString() : null,
            Incarnation = fields.TryGetProperty("incarnation", out var incarnation)
                ? BinaryPrimitives.ReadUInt128BigEndian(Vectors.FromHexadecimal(Filled(incarnation.GetString()!)))
                : null,
            Bound = fields.TryGetProperty("bound", out var bound) ? bound.GetInt64() : null,
            Status = fields.TryGetProperty("status", out var status) ? status.GetInt32() : null,
            Layouts = fields.TryGetProperty("layouts", out var layouts) ? [.. layouts.EnumerateArray().Select((layout) =>
            {
                return layout.GetByte();
            })] : null,
            Code = fields.TryGetProperty("code", out var code) ? code.GetInt32() : null,
            Answers = fields.TryGetProperty("answers", out var answers) ? answers.GetUInt64() : null,
            Credential = fields.TryGetProperty("credential", out var credential) ? credential.GetString() : null,
            Carried = fields.TryGetProperty("envelope", out var envelope)
                ? Vectors.FromHexadecimal(envelope.GetString()!)
                : fields.TryGetProperty("part", out var part) ? Vectors.FromHexadecimal(part.GetString()!) : ReadOnlyMemory<byte>.Empty,
        };

        return BrokerParcels.Encode(parcel);
    }

    // where a peer publishes: the server's name, the inbox of the participant under test, or its own departure
    private IReadOnlyList<string> TopicOf((string To, string From) publication)
    {
        return publication.To switch
        {
            "name" => [RootToken, "s", ServedName],
            "inbox" => [RootToken, "i", _participant.Id],
            "departure" => [RootToken, "d", publication.From],
            var other => throw new ArgumentException($"a publish to what no test reads: {other}", nameof(publication)),
        };
    }

    // each item of a publish, as its peer publishes it
    private List<BrokerPublication> PublicationsOf((IReadOnlyList<string> Topic, JsonElement Items) publishing)
    {
        return [.. publishing.Items.EnumerateArray().Select((item) =>
        {
            var payload = item.TryGetProperty("bytes", out var bytes)
                ? Vectors.FromHexadecimal(Filled(bytes.GetString()!))
                : ParcelFrom(item.GetProperty("parcel"));

            return new BrokerPublication { Topic = publishing.Topic, Payload = payload };
        })];
    }

    // what a peer publishes, each in its order, none awaited before the next; refused as the step
    // says, or taken
    private async Task Publish(JsonElement step, JsonElement items)
    {
        var from = step.GetProperty("from").GetString()!;
        var topic = TopicOf((step.GetProperty("to").GetString()!, from));
        var isRetained = step.TryGetProperty("retained", out var retained) && retained.GetBoolean();
        var said = await _broker.PublishAll((_peers[from].Adapter, PublicationsOf((topic, items)), isRetained)).WaitAsync(Patience, Cancelled);
        var expected = step.TryGetProperty("refused", out var refused) ? refused.GetString() : "taken";

        Assert.All(said, (each) =>
        {
            Assert.Equal(expected, each == BrokerPublished.NoSubscriber ? "no-subscriber" : "taken");
        });
    }

    // the stop of the server's transport, a publish crossing it published in the turn it begins, before it
    private async Task Stop(JsonElement stop)
    {
        Task? stopping = null;
        Task? crossed = null;

        await _broker.Turn(() =>
        {
            if (stop.ValueKind == JsonValueKind.Object && stop.TryGetProperty("crossing", out var crossing))
            {
                var from = crossing.GetProperty("from").GetString()!;

                crossed = _broker.PublishAll((_peers[from].Adapter, PublicationsOf((TopicOf((crossing.GetProperty("to").GetString()!, from)), crossing.GetProperty("publish"))), false));
            }

            stopping = _transport!.Stop();
        });
        await stopping!.WaitAsync(Patience, Cancelled);

        if (crossed is not null)
        {
            await crossed.WaitAsync(Patience, Cancelled);
        }
    }

    private async Task Expect((JsonElement Expected, JsonElement Step, Timing Timing) step)
    {
        var (expected, taken, timing) = step;
        var on = taken.TryGetProperty("on", out var named) ? named.GetString()! : "";

        if (expected.TryGetProperty("parcel", out var parcel))
        {
            var isDeparture = taken.TryGetProperty("at", out var at) && at.GetString() == "departure";

            await Heard((parcel, (on, isDeparture), timing));

            if (expected.TryGetProperty("told", out var told))
            {
                await Told(told);
            }
        }
        else if (expected.TryGetProperty("closed", out var closed))
        {
            var came = await NextOf(_closes, timing.Wait);
            var wanted = $"closed {(closed.GetProperty("clean").GetBoolean() ? "clean" : "unclean")}{(on.Length == 0 ? "" : $" on {on}")}";

            Assert.Equal(wanted, came is { } close ? $"closed {(close.IsClean ? "clean" : "unclean")}{(on.Length == 0 ? "" : $" on {PeerOf(close.ConnectionHandle)}")}" : "no close");
        }
        else if (expected.TryGetProperty("opened", out _))
        {
            await _connecting!.WaitAsync(timing.Wait, Cancelled);
        }
        else if (expected.TryGetProperty("failed", out var failed))
        {
            await Failed((failed, timing));
        }
        else if (expected.TryGetProperty("secure", out var secure))
        {
            Assert.Equal($"secure {secure.GetBoolean()}", $"secure {_client!.IsSecure}");
        }
        else if (expected.TryGetProperty("received", out var received))
        {
            using var waiting = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);

            waiting.CancelAfter(timing.Wait);

            var message = await _received.Reader.ReadAsync(waiting.Token);

            Assert.Equal(ConversationPlayer.ExpectedOf((received, null)), EnvelopeOf(message.Bytes));
        }
        else if (expected.TryGetProperty("placed", out var placed))
        {
            await Placed((placed, timing));
        }
        else if (expected.TryGetProperty("lives", out var lives))
        {
            Lives(lives);
        }
        else
        {
            throw new ArgumentException($"an expect no test plays: {expected.GetRawText()}", nameof(step));
        }
    }

    // the connect under test failed, naming the status, the reason and the layouts of the REFUSE
    // it read, or the reason no-subscriber
    private async Task Failed((JsonElement Failed, Timing Timing) step)
    {
        var (failed, timing) = step;
        var failure = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return _connecting!.WaitAsync(timing.Wait, Cancelled);
        });
        var refused = Assert.IsType<BrokerRefusedException>(failure.InnerException);
        var refusal = refused.Refusal;
        var layouts = failed.TryGetProperty("layouts", out var named) ? string.Join(",", named.EnumerateArray().Select((layout) =>
        {
            return layout.GetInt32();
        })) : "none";

        Assert.Equal(
            $"failed {(failed.TryGetProperty("status", out var status) ? status.GetInt32() : null)} {failed.GetProperty("reason").GetString()} layouts {layouts}",
            $"failed {refusal.Status} {refusal.Reason} layouts {(refusal.Layouts is { } read ? string.Join(",", read) : "none")}");

        // a refusal is named as section 15.6 names one: its status and its reason
        Assert.True(IsNaming((refused.Message, refusal.Reason)), refused.Message);
    }

    // the next message of a channel within a wait; none when none came
    private static async Task<BrokerMessage?> NextOf((Channel<BrokerMessage> Channel, TimeSpan Wait) reading)
    {
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);

        waiting.CancelAfter(reading.Wait);

        try
        {
            return await reading.Channel.Reader.ReadAsync(waiting.Token);
        }
        catch (OperationCanceledException) when (!Cancelled.IsCancellationRequested)
        {
            return null;
        }
    }

    // the next parcel a peer received, on its inbox or the name, or on the departure it reads, field
    // by field, each captured where the case says
    private async Task Heard((JsonElement Parcel, (string On, bool IsDeparture) At, Timing Timing) step)
    {
        var (expected, (on, isDeparture), timing) = step;
        var peer = _peers[on.Length == 0 ? "peer" : on];
        var message = await NextOf((isDeparture ? peer.Departures : peer.Heard, timing.Wait));

        if (message is null)
        {
            Assert.Fail($"no parcel came within {MillisecondsOf(timing.Wait)} ms");
        }

        var reading = BrokerParcels.Read(message.Payload);

        Assert.True(reading.Verdict == BrokerParcelVerdict.Parcel, $"a parcel came: {reading.Why}");

        var parcel = reading.Parcel!;
        var wanted = new List<string>();
        var came = new List<string>();

        foreach (var field in expected.EnumerateObject())
        {
            var value = FieldOf((field.Name, parcel));

            if (field.Value.ValueKind == JsonValueKind.Object && field.Value.TryGetProperty("shape", out var shape))
            {
                var isShaped = shape.GetString() switch
                {
                    "half" => value.Length == 16 && value != new string('0', 16),
                    "incarnation" => value.Length == 32,
                    var other => throw new ArgumentException($"a shape no test reads: {other}", nameof(step)),
                };

                wanted.Add($"{field.Name} a {shape.GetString()}");
                came.Add(isShaped ? $"{field.Name} a {shape.GetString()}" : $"{field.Name} {value}");

                // * a value captured before that this one is not: an incarnation drawn anew
                if (field.Value.TryGetProperty("unlike", out var unlike))
                {
                    var before = _captured.TryGetValue(unlike.GetString()!, out var captured) ? captured : throw new InvalidOperationException($"nothing captured under {unlike.GetString()}");

                    wanted.Add($"{field.Name} unlike {unlike.GetString()}");
                    came.Add(value == before ? $"{field.Name} {value}, as {unlike.GetString()}" : $"{field.Name} unlike {unlike.GetString()}");
                }

                if (field.Value.TryGetProperty("capture", out var capture))
                {
                    _captured[capture.GetString()!] = value;
                }

                continue;
            }

            wanted.Add($"{field.Name} {ExpectedFieldOf(field)}");
            came.Add($"{field.Name} {value}");
        }

        // ! a DATA read without a credential carries none
        if (parcel.Kind == BrokerParcelKinds.Data && !expected.TryGetProperty("credential", out _))
        {
            wanted.Add("credential none");
            came.Add($"credential {parcel.Credential ?? "none"}");
        }

        Assert.Equal(string.Join("; ", wanted), string.Join("; ", came));
    }

    // each OPEN of the openers given reached the server under test, its ACCEPT read on the opener's
    // inbox, or the twin, the OPEN read on the name: one of them, never both and never neither
    private async Task Placed((JsonElement Placed, Timing Timing) step)
    {
        var (placed, timing) = step;
        var openers = placed.GetProperty("openers").EnumerateArray().Select((opener) =>
        {
            return HexadecimalOf(Filled(opener.GetString()!));
        }).ToList();
        var reached = openers.ToDictionary((opener) =>
        {
            return opener;
        }, (_) =>
        {
            return new List<string>();
        }, StringComparer.Ordinal);
        // the ACCEPTs the server under test sent reach the openers' inbox, the peer's
        var opener = _peers.Values.First();
        var twin = _twin ?? throw new InvalidOperationException("a placement read of a case that names no twin");
        var watch = Stopwatch.StartNew();

        // what came of either: each opener's ACCEPT by the server, or its OPEN by the twin
        void Read((Peer Peer, string By, byte Kind) reading)
        {
            while (reading.Peer.Heard.Reader.TryRead(out var message))
            {
                if (BrokerParcels.Read(message.Payload) is { Verdict: BrokerParcelVerdict.Parcel, Parcel: { } parcel } && parcel.Kind == reading.Kind
                    && reached.TryGetValue(HalfOf(parcel.Opener), out var places))
                {
                    places.Add(reading.By);
                }
            }
        }

        while (reached.Values.Any((places) =>
        {
            return places.Count == 0;
        }) && watch.Elapsed < timing.Wait)
        {
            Read((opener, "server", BrokerParcelKinds.Accept));
            Read((twin, "twin", BrokerParcelKinds.Open));
            await Task.Delay(5, Cancelled);
        }

        // * a copy that would place one twice may come after: given its time
        await Task.Delay(_broker.Settling, Cancelled);
        await _scheduler.WhenIdle();
        Read((opener, "server", BrokerParcelKinds.Accept));
        Read((twin, "twin", BrokerParcelKinds.Open));

        Assert.Equal(
            string.Join("; ", openers.Select((opener) =>
            {
                return $"{opener} placed once";
            })),
            string.Join("; ", openers.Select((opener) =>
            {
                return reached[opener].Count == 1 ? $"{opener} placed once" : $"{opener} placed at {(reached[opener].Count == 0 ? "none" : string.Join(" and ", reached[opener]))}";
            })));
    }

    // what the side under test asked its adapter of each publication's life, exactly: an OPEN's, a
    // DATA's that carries a credential, and every other parcel's
    private void Lives(JsonElement lives)
    {
        string Expected(string kind)
        {
            return lives.GetProperty(kind).ValueKind == JsonValueKind.Null ? "none" : lives.GetProperty(kind).GetInt64().ToString(CultureInfo.InvariantCulture);
        }

        string Came(string kind)
        {
            var asked = _adapter.Lives.Where((life) =>
            {
                return life.Kind == kind;
            }).Select((life) =>
            {
                return life.ExpiresAfter is { } after ? MillisecondsOf(after) : "none";
            }).Distinct(StringComparer.Ordinal).ToList();

            return asked.Count == 0 ? "no publication" : string.Join(" and ", asked);
        }

        Assert.Equal(
            $"open {Expected("open")}; credential {Expected("credential")}; other {Expected("other")}",
            $"open {Came("open")}; credential {Came("credential")}; other {Came("other")}");
    }

    // a field of a parcel received, as ExpectedFieldOf writes what a case expects of it
    private static string FieldOf((string Name, BrokerParcel Parcel) field)
    {
        var (name, parcel) = field;

        return name switch
        {
            "kind" => parcel.Kind.ToString(CultureInfo.InvariantCulture),
            "flags" => parcel.Flags.ToString(CultureInfo.InvariantCulture),
            "opener" => HalfOf(parcel.Opener),
            "acceptor" => HalfOf(parcel.Acceptor),
            "sequence" => parcel.Sequence.ToString(CultureInfo.InvariantCulture),
            "id" => parcel.Id ?? "none",
            "incarnation" => parcel.Incarnation is { } incarnation ? IncarnationOf(incarnation) : "none",
            "bound" => parcel.Bound?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "status" => parcel.Status?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "layouts" => parcel.Layouts is { } layouts ? string.Join(",", layouts) : "none",
            "credential" => parcel.Credential ?? "none",
            "answers" => parcel.Answers?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "code" => parcel.Code?.ToString(CultureInfo.InvariantCulture) ?? "none",
            "envelope" => EnvelopeOf(parcel.Carried),
            "part" => Convert.ToHexString(parcel.Carried.Span),
            _ => throw new ArgumentException($"a parcel's field no test reads: {name}", nameof(field)),
        };
    }

    // a field a case expects, its captured values put in
    private string ExpectedFieldOf(JsonProperty field)
    {
        return field.Name switch
        {
            "opener" or "acceptor" or "incarnation" or "part" => HexadecimalOf(Filled(field.Value.GetString()!)),
            "layouts" => string.Join(",", field.Value.EnumerateArray().Select((layout) =>
            {
                return layout.GetInt32();
            })),
            "envelope" => ConversationPlayer.ExpectedOf((field.Value, null)),
            _ => field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString()! : field.Value.GetRawText(),
        };
    }

    // what the server's transport told of the refusal a REFUSE answered: the next one told
    private async Task Told(JsonElement told)
    {
        var came = await NextOf(_refusals, Patience);
        var expected = $"told {told.GetProperty("status").GetInt32()} {told.GetProperty("reason").GetString()} from {told.GetProperty("address").GetString()}, authority null, origin null, port 0";

        Assert.Equal(expected, came is { } refusal ? $"told {refusal.Status} {refusal.Reason} from {refusal.Address}, authority {refusal.Authority ?? "null"}, origin {refusal.Origin ?? "null"}, port {refusal.Port}" : "no refusal told");
    }

    // the next error the side under test reported of its own, naming each word given, with the
    // connection of the peer named, or with none
    private async Task Reported((JsonElement Words, string On) step)
    {
        var (words, on) = step;
        var came = await NextOf(_reports, Patience);

        Assert.True(came is not null, "expected a report, and nothing was reported");

        var (reason, connectionHandle) = came.Value;

        Assert.Equal(on.Length == 0 ? "on no connection" : $"on {on}", connectionHandle.Length == 0 ? "on no connection" : $"on {PeerOf(connectionHandle)}");
        Assert.All(words.EnumerateArray().Select((word) =>
        {
            return word.GetString()!;
        }), (word) =>
        {
            Assert.True(IsNaming((reason.Message, word)), $"\"{reason.Message}\" names {word}");
        });
    }

    // the next of a queue, within a wait; none when nothing came
    private static async Task<T?> NextOf<T>(ConcurrentQueue<T> queue, TimeSpan wait)
        where T : struct
    {
        var watch = Stopwatch.StartNew();

        while (watch.Elapsed < wait)
        {
            if (queue.TryDequeue(out var next))
            {
                return next;
            }

            await Task.Delay(5, Cancelled);
        }

        return queue.TryDequeue(out var last) ? last : null;
    }

    private static async Task<TransportServerRefusal?> NextOf(ConcurrentQueue<TransportServerRefusal> queue, TimeSpan wait)
    {
        var watch = Stopwatch.StartNew();

        while (watch.Elapsed < wait)
        {
            if (queue.TryDequeue(out var next))
            {
                return next;
            }

            await Task.Delay(5, Cancelled);
        }

        return queue.TryDequeue(out var last) ? last : null;
    }

    // a gauge of the transport under test, read until it has its value, within a patience
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

    // the earliest timer armed on the clock given, due that many milliseconds from now, and the
    // only one so due, within a patience
    private async Task UntilArmed(JsonElement milliseconds)
    {
        var due = TimeOf(milliseconds);
        var dues = await _clock.UntilEarliest(due, Patience);

        Assert.True(SteppingClock.IsEarliest(dues, due), $"the earliest timer armed, alone so due, among {string.Join(", ", dues)}");
    }

    private long CountOf(string gauge)
    {
        return gauge == "unsettled" ? _broker.UnsettledOf(_adapter.Inner) : _transport!.Gauges().Counts[gauge];
    }

    /// <summary>
    /// How an expect is timed, from its step's start, on the real clock: its <c>within</c>, or a
    /// patience where it names none.
    /// </summary>
    private sealed class Timing(JsonElement step)
    {
        public TimeSpan Wait { get; } = step.TryGetProperty("within", out var within) ? TimeOf(within) : Patience;
    }

    // one of the test's own participants: its adapter, and what reached it, in order: what reached a
    // departure apart from the rest
    private sealed record Peer(IBrokerAdapter Adapter, Channel<BrokerMessage> Heard, Channel<BrokerMessage> Departures);
}
