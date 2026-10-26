using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketServer{TData}"/>, the facade an application starts from, against
/// <see cref="WebSocketClient"/> and a raw <see cref="ClientWebSocket"/>: what it builds, the
/// message limit it gives its transport, and its layers end to end — transfers, a relay, sessions,
/// commands, subscriptions and cancels — each ending with the server at rest once its client is gone.
/// </summary>
public sealed class WebSocketServerTests
{
    // constants

    private const string Host = "127.0.0.1";

    private const int Mebibyte = 1_048_576;

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // bytes by the tens of megabytes, on a machine that may be slow: the clock is no part of it
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private static readonly WebSocketTransportStartOptions Loopback = new() { Address = Host, FindOpenPort = true };

    // envelopes of 1 024 bytes, a window of 8 KiB
    private static readonly RouterLimits Small = new() { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, WindowBytes = 8_192 };

    // what a registration keeps on purpose, whether its connection stands or not
    private static readonly HashSet<string> Kept = ["closedDestinations", "destinations"];

    private static readonly TextSerializer Text = new();

    private static readonly BytesSerializer Bytes = new();

    private static readonly RequestDependencies<string, string> TextAsked = new() { Serializer = Text };

    private static readonly RequestResolverDependencies<string, string> TextAnswered = new() { Serializer = Text };

    private static readonly NotificationDependencies<string, string, string> TextSubscribed = new() { Serializer = Text };

    private static readonly NotificationResolverDependencies<string, string, string> TextNotified = new() { Serializer = Text };

    private static readonly RequestDependencies<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>> BytesAsked = new() { Serializer = Bytes };

    private static readonly RequestResolverDependencies<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>> BytesAnswered = new() { Serializer = Bytes };

    private static readonly Procedure OpenSession = new() { ServiceId = 1, ProcedureId = 1, ProcedureName = "openSession", ServiceRevision = 1 };

    private static readonly Procedure Echo = new() { ServiceId = 1, ProcedureId = 2, ProcedureName = "echo", ServiceRevision = 1 };

    private static readonly Procedure Ping = new() { ServiceId = 1, ProcedureId = 3, ProcedureName = "ping", ServiceRevision = 1 };

    private static readonly Procedure News = new() { ServiceId = 1, ProcedureId = 4, ProcedureName = "news", ServiceRevision = 1 };

    private static readonly Procedure Unsubscribe = new() { ServiceId = 1, ProcedureId = 5, ProcedureName = "unsubscribe", ServiceRevision = 1 };

    private static readonly Procedure Whoami = new() { ServiceId = 1, ProcedureId = 6, ProcedureName = "whoami", ServiceRevision = 1 };

    // helpers

    /// <summary>Whether this platform opens two sockets from one address and port.</summary>
    public static bool OpensTwoSocketsFromOnePort
    {
        get
        {
            return SamePort.IsOpened;
        }
    }

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static byte[] PatternOf(int length)
    {
        var bytes = new byte[length];

        for (var index = 0; index < length; index += 1)
        {
            bytes[index] = (byte)(((index * 7) + 3) % 256);
        }

        return bytes;
    }

    // what tells a payload apart, however large, without printing it: its length and its SHA-256
    private static string DigestOf(ReadOnlyMemory<byte> bytes)
    {
        return $"{bytes.Length} {Convert.ToHexStringLower(SHA256.HashData(bytes.Span))}";
    }

    // whether it comes to hold within the patience, asked again and again, as expect.poll asks
    private static async Task<bool> Eventually(Func<Task<bool>> holds)
    {
        var watch = Stopwatch.StartNew();

        while (!await holds())
        {
            if (watch.Elapsed > Patience)
            {
                return false;
            }

            await Task.Delay(10, Cancelled);
        }

        return true;
    }

    private static Task<bool> Eventually(Func<bool> holds)
    {
        return Eventually(() =>
        {
            return Task.FromResult(holds());
        });
    }

    // what a call failed with, or none: the TypeScript side's `.catch((reason) => reason)`
    private static async Task<Exception?> Caught(Task called)
    {
        try
        {
            await called;

            return null;
        }
        catch (Exception reason)
        {
            return reason;
        }
    }

    private static bool IsCredit(DebugDirection direction, TracedEnvelope envelope)
    {
        return direction == DebugDirection.Tx && envelope.Header.Kind == EnvelopeKind.Credit;
    }

    private static WebSocketServerOptions OptionsOf(RouterLimits? limits, int? maximumMessageBytes)
    {
        return new WebSocketServerOptions
        {
            Server = new ServerOptions { Limits = limits },
            Transport = new WebSocketTransportServerOptions { MaximumMessageBytes = maximumMessageBytes },
        };
    }

    private static async Task<int> PortOf(WebSocketServer<string> server)
    {
        return (await server.Transport.Start(Loopback, Cancelled)).Port;
    }

    private static Task Connect(WebSocketClient client, int port)
    {
        return client.Connect(new WebSocketConnectOptions { Host = Host, Port = port }, Cancelled);
    }

    // reads what comes until the server's close, answers it, and gives its status
    private static async Task<WebSocketCloseStatus?> CloseOf(ClientWebSocket socket)
    {
        var buffer = new byte[16 * 1_024];

        while (true)
        {
            var received = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), Cancelled).WaitAsync(Patience, Cancelled);

            if (received.MessageType == WebSocketMessageType.Close)
            {
                await socket.CloseOutputAsync(received.CloseStatus ?? WebSocketCloseStatus.NormalClosure, null, Cancelled);

                return received.CloseStatus;
            }
        }
    }

    // a message of `bytes` is delivered whole, and one byte more closes its connection with 1009
    private static async Task AssertTakes(WebSocketServerOptions options, int bytes)
    {
        await using var server = new WebSocketServer<string>(options);
        using var socket = new ClientWebSocket();
        var delivered = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

        server.Transport.Message += (message, _) =>
        {
            delivered.TrySetResult(message.Bytes.Length);
        };
        await socket.ConnectAsync(new Uri($"ws://{Host}:{await PortOf(server)}/"), Cancelled);
        await socket.SendAsync(new byte[bytes], WebSocketMessageType.Binary, true, Cancelled);

        Assert.Equal(bytes, await delivered.Task.WaitAsync(Patience, Cancelled));

        await socket.SendAsync(new byte[bytes + 1], WebSocketMessageType.Binary, true, Cancelled);

        Assert.Equal(WebSocketCloseStatus.MessageTooBig, await CloseOf(socket));
    }

    // what each layer still keeps, each as `layer:count value`, a registration's destinations aside
    private static async Task<List<string>> KeptOf(WebSocketServer<string> server)
    {
        var gauges = await server.Gauges();
        (string Name, LayerGauges Gauges)[] layers =
        [
            ("router", gauges.Router),
            ("server", gauges.Server),
            ("sessions", gauges.Sessions),
            ("transport", gauges.Transport),
        ];

        return [.. layers.SelectMany((layer) =>
        {
            return layer.Gauges.Counts
                .Where((count) =>
                {
                    return count.Value != 0 && !Kept.Contains(count.Key);
                })
                .Select((count) =>
                {
                    return $"{layer.Name}:{count.Key} {count.Value}";
                });
        })];
    }

    // waits until each layer keeps nothing, then expects its health to pass: a leak fails it
    private static async Task AtRest(WebSocketServer<string> server)
    {
        await Eventually(async () =>
        {
            return (await KeptOf(server)).Count == 0;
        });

        Assert.Empty(await KeptOf(server));
        Assert.Equal(HealthStatus.Pass, (await server.Health()).Status);
    }

    // the subscriptions the server's router notifies: the TypeScript side lists them, this side counts them
    private static async Task<long> SubscriptionsOf(WebSocketServer<string> server)
    {
        return (await server.Router.Gauges()).Counts["notifiedSubscriptions"];
    }

    // a server and a client, each with its limits, connected, which record the bytes of every
    // message they take, and each credit they send
    private static async Task<Ends> ConnectWith(RouterLimits? client, RouterLimits? server)
    {
        var ends = new Ends(
            new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Limits = server } }),
            new WebSocketClient(new WebSocketClientOptions { Limits = client }));
        var port = await PortOf(ends.Server);

        ends.Server.Transport.Message += (message, _) =>
        {
            ends.TakenByServer.Enqueue(message.Bytes.Length);
        };
        ends.Client.Transport.Message += (message) =>
        {
            ends.TakenByClient.Enqueue(message.Bytes.Length);
        };
        ends.Server.Router.Debug += (direction, envelope) =>
        {
            if (IsCredit(direction, envelope))
            {
                ends.CreditedByServer.Enqueue(envelope.Header.CallId);
            }
        };
        ends.Client.Router.Debug += (direction, envelope) =>
        {
            if (IsCredit(direction, envelope))
            {
                ends.CreditedByClient.Enqueue(envelope.Header.CallId);
            }
        };
        await Connect(ends.Client, port);

        return ends;
    }

    // a relay's server — relaying as `relay` says, or by its ShareLegBSession, as a hub whose
    // requesters log in at it does, a session required — with a device behind it at destination 7,
    // and a client connected to it; every router under `limits`. The TypeScript side's leg B is a
    // pipe to a bare router; this side has no piped transport, so its device is a server of its own,
    // reached by a client's router registered as the destination
    private static async Task<Ends> ConnectRelayed(RouterLimits? limits, RelayOptions? relay)
    {
        var hub = new StrongBox<WebSocketServer<string>>();
        var sharing = new RelayOptions
        {
            BeforeRoute = new BeforeRequest(
                (request) =>
                {
                    return hub.Value!.ShareLegBSession.Admits(request);
                },
                Failure.OfProtocol(ProtocolCode.SessionRequired)),
        };
        var device = new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Limits = limits } });
        var toDevice = new WebSocketClient(new WebSocketClientOptions { Limits = limits });
        var ends = new Ends(
            new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Limits = limits, Relay = relay ?? sharing } }),
            new WebSocketClient(new WebSocketClientOptions { Limits = limits }))
        {
            Device = device,
            ToDevice = toDevice,
        };
        var server = ends.Server;

        hub.Value = server;

        await Connect(toDevice, await PortOf(device));
        server.Router.RegisterDestination(toDevice.Router, new DestinationOptions { DestinationId = 7, Label = "the device" });
        server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
        {
            server.Sessions.Set(server.Sessions.Create(request.ConnectionHandle) with
            {
                ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan,
                SessionInactivityTimeout = Timeout.InfiniteTimeSpan,
            });

            return response.Answer("");
        });
        await Connect(ends.Client, await PortOf(server));

        return ends;
    }

    // a resolver that waits for its call's cancel, says it heard it, then throws
    private static RequestResolverCallback<string, string> StoppedOnCancel(ConcurrentQueue<bool> heard)
    {
        return async (request, _) =>
        {
            var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            using (request.Signal.Register(() =>
            {
                heard.Enqueue(request.Signal.IsCancellationRequested);
                stopped.TrySetResult();
            }))
            {
                await stopped.Task;
            }

            throw new InvalidOperationException("stopped");
        };
    }

    /// <summary>
    /// A server and its client — and, for a relay, the device behind it and the client that reaches
    /// it — with the bytes of each message each end took and each credit each router sent. Taken
    /// apart as the TypeScript side's fixtures do: the client, then the server once at rest.
    /// </summary>
    private sealed class Ends(WebSocketServer<string> server, WebSocketClient client) : IAsyncDisposable
    {
        public WebSocketServer<string> Server { get; } = server;

        public WebSocketClient Client { get; } = client;

        public WebSocketServer<string>? Device { get; init; }

        public WebSocketClient? ToDevice { get; init; }

        public ConcurrentQueue<int> TakenByServer { get; } = new();

        public ConcurrentQueue<int> TakenByClient { get; } = new();

        public ConcurrentQueue<uint> CreditedByServer { get; } = new();

        public ConcurrentQueue<uint> CreditedByClient { get; } = new();

        public async ValueTask DisposeAsync()
        {
            try
            {
                await Client.DisposeAsync();
                await AtRest(Server);
            }
            finally
            {
                await Server.DisposeAsync();

                if (ToDevice is not null)
                {
                    await ToDevice.DisposeAsync();
                }

                if (Device is not null)
                {
                    await Device.DisposeAsync();
                }
            }
        }
    }

    /// <summary>Text, in UTF-8, either way: a request, its answer, and a notification.</summary>
    private sealed class TextSerializer : INotificationSerializerServer<string, string, string>, INotificationSerializerClient<string, string, string>
    {
        public string Decode(ReadOnlyMemory<byte> request)
        {
            return Encoding.UTF8.GetString(request.Span);
        }

        public ReadOnlyMemory<byte> Encode(string response)
        {
            return Encoding.UTF8.GetBytes(response);
        }

        public ReadOnlyMemory<byte> EncodeNotification(string notification)
        {
            return Encoding.UTF8.GetBytes(notification);
        }

        public string DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return Encoding.UTF8.GetString(notification.Span);
        }
    }

    /// <summary>Payloads as they are: bytes, either way.</summary>
    private sealed class BytesSerializer
        : IRequestSerializerServer<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>>, IRequestSerializerClient<ReadOnlyMemory<byte>, ReadOnlyMemory<byte>>
    {
        public ReadOnlyMemory<byte> Decode(ReadOnlyMemory<byte> request)
        {
            return request;
        }

        public ReadOnlyMemory<byte> Encode(ReadOnlyMemory<byte> response)
        {
            return response;
        }
    }

    // definition

    [Fact]
    public async Task Each_server_is_an_IBeadServer_with_RequireCredential_and_ShareLegBSession()
    {
        await using var server = new WebSocketServer<string>();

        var beadServer = Assert.IsAssignableFrom<IBeadServer<string>>(server);

        Assert.Same(server.Transport, beadServer.Transport);
        Assert.Same(server.Router, beadServer.Router);
        Assert.Same(server.RequireSession, beadServer.RequireSession);
        Assert.NotNull(server.RequireCredential);
        Assert.Same(server.RequireCredential, beadServer.RequireCredential);
        Assert.NotNull(server.ShareLegBSession);
        Assert.Same(server.ShareLegBSession, beadServer.ShareLegBSession);
    }

    [Fact]
    public async Task WebSocketServer_builds_on_a_WebSocket_transport_server_not_yet_started_with_its_layers_and_the_limits_given()
    {
        // the TypeScript side takes a factory for each layer; this side builds its own
        var limits = new RouterLimits { MaximumPayloadBytes = 8 };

        await using var server = new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Limits = limits } });

        Assert.Equal(ReadyState.Uninitialized, server.Transport.ReadyState);
        Assert.Same(server.Transport, server.Router.Transport);
        Assert.Empty(server.Sessions.GetAll());
        // the router is built with the server's limits
        Assert.Equal(limits, server.Router.Limits);
    }

    [Fact]
    public async Task WebSocketServer_runs_every_layer_on_its_transport_s_clock_and_refuses_another()
    {
        var time = new Microsoft.Extensions.Time.Testing.FakeTimeProvider();

        await using var server = new WebSocketServer<string>(new WebSocketServerOptions { Transport = new WebSocketTransportServerOptions { Clock = time } });

        Assert.Equal((time, time, time), (server.Transport.Clock, server.Router.Clock, server.Sessions.Clock));
        Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Clock = time } });
        });
    }

    [Fact]
    public async Task WebSocketServer_takes_a_message_of_an_envelope_at_most_more_when_the_transport_says_so_and_never_less()
    {
        // envelopes of 256 bytes; the transport's options are its own, so a raw socket finds its limit
        var small = new RouterLimits { ChunkBytes = 128, MaximumEnvelopeBytes = 256, WindowBytes = 256 };

        foreach (var (limits, maximumMessageBytes, expected) in new (RouterLimits?, int?, int)[] { (null, null, 16_778_240), (small, null, 256), (small, 1_024, 1_024) })
        {
            await AssertTakes(OptionsOf(limits, maximumMessageBytes), expected);
        }

        // a socket that cuts off what the router would take
        foreach (var (limits, maximumMessageBytes) in new (RouterLimits?, int?)[] { (null, 256), (small, 255) })
        {
            Assert.Contains("a message is an envelope's limit at least", Assert.Throws<ArgumentException>(() =>
            {
                return new WebSocketServer<string>(OptionsOf(limits, maximumMessageBytes));
            }).Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task WebSocketServer_builds_its_router_with_the_pacing_its_options_give()
    {
        await using var server = new WebSocketServer<string>(new WebSocketServerOptions
        {
            Server = new ServerOptions { Pacing = new PacingLimits { MaximumQueuedNotificationBytes = 2_048, MaximumQueuedNotifications = 3 } },
        });

        var ceilings = (await server.Gauges()).Router.Ceilings;

        Assert.Equal((2_048L, 3L), (ceilings["largestQueuedNotificationBytes"], ceilings["largestQueuedNotifications"]));
    }

    [Fact]
    public async Task WebSocketServer_closes_with_1009_a_connection_that_sends_more_than_MaximumMessageBytes()
    {
        await using var server = new WebSocketServer<string>(OptionsOf(new RouterLimits { ChunkBytes = 128, MaximumEnvelopeBytes = 256, WindowBytes = 256 }, 256));
        using var socket = new ClientWebSocket();

        await socket.ConnectAsync(new Uri($"ws://{Host}:{await PortOf(server)}/"), Cancelled);
        await socket.SendAsync(new byte[257], WebSocketMessageType.Binary, true, Cancelled);

        Assert.Equal(WebSocketCloseStatus.MessageTooBig, await CloseOf(socket));
    }

    [Fact]
    public async Task WebSocketServer_closes_a_client_that_lets_a_command_go_unanswered_when_told_to()
    {
        await using var ends = new Ends(
            new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { CloseOnCommandTimeout = true } }),
            new WebSocketClient());
        var port = await PortOf(ends.Server);
        var opened = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        ends.Server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
        {
            opened.TrySetResult(request.ConnectionHandle);

            return response.Answer("");
        });
        // a client that takes the command and never answers it
        ends.Client.Services.GetCommandResolver(Ping, TextAnswered)((_, _) =>
        {
            return new TaskCompletionSource().Task;
        });

        await Connect(ends.Client, port);
        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        var connectionHandle = await opened.Task.WaitAsync(Patience, Cancelled);

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return ends.Server.Services.GetCommand(Ping, TextAsked)("ping")(new RequestOptions
            {
                ConnectionHandle = connectionHandle,
                Timeout = TimeSpan.FromMilliseconds(50),
            }).WaitAsync(Patience, Cancelled);
        });
        Assert.True(await Eventually(() =>
        {
            return ends.Client.Transport.ReadyState == ReadyState.Closed;
        }));
    }

    [Fact]
    public async Task Carry_20_MiB_both_ways_a_request_its_result_a_command_and_its_answer_in_messages_of_a_chunk_at_most()
    {
        var limits = new RouterLimits { MaximumPayloadBytes = 32 * Mebibyte };

        await using var ends = await ConnectWith(limits, limits);

        var (request, result, command, answer) = (PatternOf((20 * Mebibyte) + 1), PatternOf((20 * Mebibyte) + 2), PatternOf((20 * Mebibyte) + 3), PatternOf((20 * Mebibyte) + 4));
        var heard = new ConcurrentQueue<string>();
        var opened = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        ends.Server.Services.GetRequestResolver(Echo, BytesAnswered)((asked, response) =>
        {
            opened.TrySetResult(asked.ConnectionHandle);
            heard.Enqueue(DigestOf(asked.Payload));

            return response.Answer(result);
        });
        ends.Client.Services.GetCommandResolver(Ping, BytesAnswered)((asked, response) =>
        {
            heard.Enqueue(DigestOf(asked.Payload));

            return response.Answer(answer);
        });

        // the clock is no part of it: a generous timeout
        var resulted = await ends.Client.Services.GetRequest(Echo, BytesAsked)(request)(new RequestOptions { Timeout = Generous })
            .WaitAsync(Generous, Cancelled);
        var answered = await ends.Server.Services.GetCommand(Ping, BytesAsked)(command)(new RequestOptions
        {
            ConnectionHandle = await opened.Task.WaitAsync(Patience, Cancelled),
            Timeout = Generous,
        }).WaitAsync(Generous, Cancelled);

        Assert.Equal(new[] { DigestOf(result), DigestOf(answer) }, new[] { DigestOf(resulted), DigestOf(answered) });
        Assert.Equal([DigestOf(request), DigestOf(command)], heard);
        Assert.InRange(ends.TakenByServer.Concat(ends.TakenByClient).Max(), 1, Mebibyte);
    }

    [Fact]
    public async Task Refuse_20_MiB_with_the_limits_by_default_here_sending_nothing()
    {
        await using var ends = await ConnectWith(null, null);

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return ends.Client.Services.GetRequest(Echo, BytesAsked)(PatternOf(20 * Mebibyte))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.PayloadTooLarge, "a payload is 16777216 bytes at most, not 20971520"),
            (refused.Code, refused.Detail));
        Assert.Empty(ends.TakenByServer);
    }

    [Fact]
    public async Task Carry_100_KiB_over_envelopes_of_1_024_bytes_both_ways_credited_many_times()
    {
        await using var ends = await ConnectWith(Small, Small);

        var (request, result) = (PatternOf(102_400), PatternOf(102_401));

        ends.Server.Services.GetRequestResolver(Echo, BytesAnswered)((_, response) =>
        {
            return response.Answer(result);
        });

        var resulted = await ends.Client.Services.GetRequest(Echo, BytesAsked)(request)().WaitAsync(Patience, Cancelled);

        Assert.Equal(DigestOf(result), DigestOf(resulted));
        Assert.InRange(ends.TakenByServer.Concat(ends.TakenByClient).Max(), 1, 1_024);
        Assert.True(ends.CreditedByServer.Count > 1);
        Assert.True(ends.CreditedByClient.Count > 1);
    }

    [Fact]
    public async Task Refuse_a_transfer_at_its_opening_its_route_its_admission_its_size_its_connection_s_capacity_before_any_credit()
    {
        await using var ends = await ConnectWith(Small, Small with { MaximumTransfers = 1 });

        var held = Echo with { ProcedureId = 10, ProcedureName = "held" };
        var refusing = Echo with { ProcedureId = 11, ProcedureName = "refusing" };
        var limited = Echo with { ProcedureId = 12, ProcedureName = "limited" };
        var unknown = Echo with { ProcedureId = 13, ProcedureName = "unknown" };
        var holding = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var taken = new Dictionary<uint, List<EnvelopeKind>>();
        var credited = new HashSet<uint>();

        ends.Server.Router.Debug += (direction, envelope) =>
        {
            lock (taken)
            {
                if (direction == DebugDirection.Rx)
                {
                    taken.TryAdd(envelope.Header.CallId, []);
                    taken[envelope.Header.CallId].Add(envelope.Header.Kind);
                }
                else if (envelope.Header.Kind == EnvelopeKind.Credit)
                {
                    credited.Add(envelope.Header.CallId);
                }
            }
        };
        // taken whole, then held: its place on the connection stays until its call ends
        ends.Server.Services.GetRequestResolver(held, BytesAnswered)((_, _) =>
        {
            holding.TrySetResult();

            return new TaskCompletionSource().Task;
        });
        ends.Server.Services.GetRequestResolver(refusing, BytesAnswered with
        {
            BeforeRequest = new BeforeRequest((_) =>
            {
                return false;
            }),
        })((_, _) =>
        {
            return Task.CompletedTask;
        });
        // the server's own limit: the client's copy of the procedure has none
        ends.Server.Services.GetRequestResolver(limited with { MaximumPayloadBytes = 1_024 }, BytesAnswered)((_, _) =>
        {
            return Task.CompletedTask;
        });
        ends.Server.Services.GetRequestResolver(Echo, BytesAnswered)((_, _) =>
        {
            return Task.CompletedTask;
        });

        Task<Exception?> Ask(Procedure procedure)
        {
            return Caught(ends.Client.Services.GetRequest(procedure, BytesAsked)(PatternOf(102_400))());
        }

        _ = Ask(held);
        await holding.Task.WaitAsync(Patience, Cancelled);

        // asked in order, so their call ids are 3, 5, 7 and 9
        var refused = await Task.WhenAll(new[] { unknown, refusing, limited, Echo }.Select(Ask)).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            new ushort?[] { (ushort)ProtocolCode.ProcedureUnknown, (ushort)ProtocolCode.AccessDenied, (ushort)ProtocolCode.PayloadTooLarge, (ushort)ProtocolCode.CapacityExceeded },
            refused.Select((reason) =>
            {
                return (reason as FailureException)?.Code;
            }));

        // the server took each opening alone, and credited none
        lock (taken)
        {
            foreach (var callId in new uint[] { 3, 5, 7, 9 })
            {
                Assert.Equal([EnvelopeKind.Request], taken.GetValueOrDefault(callId, []));
                Assert.DoesNotContain(callId, credited);
            }
        }
    }

    [Fact]
    public async Task Relay_a_call_to_the_device_once_a_session_admits_it_and_bring_back_the_device_s_own_failure_one_relay_more()
    {
        await using var ends = await ConnectRelayed(null, null);

        var device = ends.Device!;
        var seven = new RequestOptions { DestinationId = 7 };
        // the scheme of the credential each envelope the device took presented, none for none
        var presented = new ConcurrentQueue<CredentialScheme?>();

        device.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Rx)
            {
                presented.Enqueue(envelope.Header is RequestHeader { Credential: { } credential } ? credential.Scheme : null);
            }
        };
        device.Services.GetRequestResolver(Echo, TextAnswered)((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });

        var echoing = ends.Client.Services.GetRequest(Echo, TextAsked);

        // a relay is a door: without a session, nothing goes through it, and the device sees nothing
        var shut = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return echoing("hi")(seven).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, (byte)0, FailureOrigin.Peer), (shut.Code, shut.Relays, shut.Origin));
        Assert.Empty(presented);

        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        Assert.Equal("HI", await echoing("hi")(seven).WaitAsync(Patience, Cancelled));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return ends.Client.Services.GetRequest(Echo with { ProcedureId = 99, ProcedureName = "unknown" }, TextAsked)("hi")(seven)
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.ProcedureUnknown, (uint?)7, (byte)1, FailureOrigin.Relayed, (RouterSide?)null),
            (refused.Code, refused.DestinationId, refused.Relays, refused.Origin, refused.Side));
        // the protocol's code, from behind the relay, whose side no one knows
        Assert.Equal(FailureScope.Protocol, refused.Scope);
        Assert.NotEqual(RouterSide.Server, refused.Side);
        // the client's session stays on leg A: none crosses to the device
        Assert.Equal([null, null], presented);
    }

    [Fact]
    public async Task Relay_as_the_server_s_options_say_an_admission_of_the_application_s_own_no_session_asked()
    {
        await using var ends = await ConnectRelayed(null, new RelayOptions
        {
            BeforeRoute = new BeforeRequest((request) =>
            {
                return request.Header.DestinationId == 7;
            }),
        });

        ends.Device!.Services.GetRequestResolver(Echo, TextAnswered)((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });

        var echoing = ends.Client.Services.GetRequest(Echo, TextAsked);

        Assert.Equal("HI", await echoing("hi")(new RequestOptions { DestinationId = 7 }).WaitAsync(Patience, Cancelled));
        Assert.Equal((ushort)ProtocolCode.AccessDenied, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return echoing("hi")(new RequestOptions { DestinationId = 8 }).WaitAsync(Patience, Cancelled);
        })).Code);
    }

    [Fact]
    public async Task Relay_100_KiB_each_way_as_transfers_on_each_leg_put_together_at_the_relay()
    {
        await using var ends = await ConnectRelayed(Small, null);

        var (request, result) = (PatternOf(102_400), PatternOf(102_401));
        var heard = new ConcurrentQueue<string>();
        var (legA, legB) = (new ConcurrentQueue<uint>(), new ConcurrentQueue<uint>());

        ends.Server.Router.Debug += (direction, envelope) =>
        {
            if (IsCredit(direction, envelope))
            {
                legA.Enqueue(envelope.Header.CallId);
            }
        };
        ends.ToDevice!.Router.Debug += (direction, envelope) =>
        {
            if (IsCredit(direction, envelope))
            {
                legB.Enqueue(envelope.Header.CallId);
            }
        };
        ends.Device!.Services.GetRequestResolver(Echo, BytesAnswered)((asked, response) =>
        {
            heard.Enqueue(DigestOf(asked.Payload));

            return response.Answer(result);
        });
        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        var resulted = await ends.Client.Services.GetRequest(Echo, BytesAsked)(request)(new RequestOptions { DestinationId = 7, Timeout = Generous })
            .WaitAsync(Generous, Cancelled);

        Assert.Equal(DigestOf(result), DigestOf(resulted));
        Assert.Equal([DigestOf(request)], heard);
        // the relay credited the client's request on leg A, and the device's result on leg B
        Assert.True(legA.Count > 1);
        Assert.True(legB.Count > 1);
    }

    [Fact]
    public async Task Cancel_the_device_s_call_when_the_client_cancels_its_own()
    {
        await using var ends = await ConnectRelayed(null, null);
        using var cancelling = new CancellationTokenSource();

        var held = Echo with { ProcedureId = 12, ProcedureName = "held" };
        var started = new ConcurrentQueue<string>();
        var cancels = new ConcurrentQueue<bool>();

        ends.Device!.Services.GetRequestResolver(held, TextAnswered)(async (request, _) =>
        {
            var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            started.Enqueue(request.Payload);

            using (request.Signal.Register(() =>
            {
                cancels.Enqueue(request.Signal.IsCancellationRequested);
                stopped.TrySetResult();
            }))
            {
                await stopped.Task;
            }
        });
        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        var asking = Caught(ends.Client.Services.GetRequest(held, TextAsked)("wait")(new RequestOptions
        {
            DestinationId = 7,
            CancellationToken = cancelling.Token,
        }));

        Assert.True(await Eventually(() =>
        {
            return started.SequenceEqual(["wait"]);
        }));
        await cancelling.CancelAsync();

        Assert.IsAssignableFrom<OperationCanceledException>(await asking.WaitAsync(Patience, Cancelled));
        Assert.True(await Eventually(() =>
        {
            return cancels.SequenceEqual([true]);
        }));
        // a token carries no reason: leg B still open says it was a cancel, not a close
        Assert.Equal(ReadyState.Open, ends.ToDevice!.Transport.ReadyState);
    }

    [Fact]
    public async Task Open_a_session_by_a_request_answer_within_it_command_the_client_and_close_a_silent_connection()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var server = ends.Server;
        var port = await PortOf(server);
        var opened = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
        {
            var session = server.Sessions.Set(server.Sessions.Create(request.ConnectionHandle) with
            {
                ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(300),
                SessionInactivityTimeout = Timeout.InfiniteTimeSpan,
            });

            opened.TrySetResult(request.ConnectionHandle);

            return response.Answer(session.SessionToken?.ToString() ?? "");
        });
        server.Services.GetRequestResolver(Echo, TextAnswered with { BeforeRequest = server.RequireSession })((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        ends.Client.Services.GetCommandResolver(Ping, TextAnswered)((_, response) =>
        {
            return response.Answer("pong");
        });

        await Connect(ends.Client, port);

        var echoing = ends.Client.Services.GetRequest(Echo, TextAsked);

        // nothing but the procedure that opens a session answers without one: the server refuses
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return echoing("hi")().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.SessionRequired, FailureOrigin.Peer, (RouterSide?)RouterSide.Server),
            (refused.Code, refused.Origin, refused.Side));

        var sessionToken = await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);
        var connectionHandle = await opened.Task.WaitAsync(Patience, Cancelled);

        // the same token at both ends
        Assert.Equal(sessionToken, server.Sessions.SessionTokenOf(connectionHandle)?.ToString());
        Assert.Equal(sessionToken, ends.Client.Router.SessionToken?.ToString());
        Assert.Equal("HI", await echoing("hi")().WaitAsync(Patience, Cancelled));

        // the server commands the client it names
        Assert.Equal("pong", await server.Services.GetCommand(Ping, TextAsked)("ping")(new RequestOptions { ConnectionHandle = connectionHandle })
            .WaitAsync(Patience, Cancelled));

        // silent past its connection timeout, the client is closed, and its session goes with it
        // ! the client's router forgets its token a turn after its transport reads closed: wait for
        // both, not for the state alone
        Assert.True(await Eventually(() =>
        {
            return ends.Client.Transport.ReadyState == ReadyState.Closed && ends.Client.Router.SessionToken is null;
        }));
        Assert.True(await Eventually(() =>
        {
            return server.Sessions.GetAll().Count == 0;
        }));
    }

    [Fact]
    public async Task Subscribe_get_the_notification_that_doubles_its_result_and_unsubscribe_by_call_id()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var server = ends.Server;
        var port = await PortOf(server);
        var subscribed = new ConcurrentQueue<uint>();
        INotificationResolver<string>? news = null;

        news = server.Services.GetNotificationResolver(News, TextNotified)(async (_, response) =>
        {
            var callId = await response.RegisterNotification();

            subscribed.Enqueue(callId);
            // sent before the answer, under the call id the answer is for
            await news!.Notify("ahead");
            await response.Answer(callId.ToString(CultureInfo.InvariantCulture));
        });
        server.Services.GetRequestResolver(Unsubscribe, TextAnswered)(async (request, response) =>
        {
            var isHeld = await server.Router.Unsubscribe(new CallAddress(uint.Parse(request.Payload, CultureInfo.InvariantCulture), request.ConnectionHandle));

            await response.Answer(isHeld ? "true" : "false");
        });

        await Connect(ends.Client, port);

        var heard = new ConcurrentQueue<string>();
        var unsubscribing = ends.Client.Services.GetRequest(Unsubscribe, TextAsked);
        var registration = await ends.Client.Services.GetNotification(News, TextSubscribed with
        {
            Unsubscribe = (callId, _) =>
            {
                return unsubscribing(callId.ToString(CultureInfo.InvariantCulture))();
            },
        }).Register("subscribe", (payload) =>
        {
            heard.Enqueue(payload);

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        Assert.True(await Eventually(() =>
        {
            return heard.SequenceEqual(["ahead"]);
        }));
        // one subscription, under call id 1: this side's router counts them, and names none
        Assert.Equal(1, await SubscriptionsOf(server));
        Assert.Equal([1u], subscribed);

        await registration.Unregister().WaitAsync(Patience, Cancelled);

        Assert.Equal(0, await SubscriptionsOf(server));
    }

    [Fact]
    public async Task A_subscription_let_go_of_without_an_unsubscribe_is_cancelled_so_subscribing_again_is_heard()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var port = await PortOf(ends.Server);
        var news = ends.Server.Services.GetNotificationResolver(News, TextNotified)((_, response) =>
        {
            return response.Answer("ok");
        });

        await Connect(ends.Client, port);

        var heard = new ConcurrentQueue<string>();
        var subscribe = ends.Client.Services.GetNotification(News, TextSubscribed);
        var first = await subscribe.Register("subscribe", (payload) =>
        {
            heard.Enqueue($"first {payload}");

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await first.Unregister().WaitAsync(Patience, Cancelled);
        Assert.True(await Eventually(async () =>
        {
            return await SubscriptionsOf(ends.Server) == 0;
        }));

        await subscribe.Register("subscribe", (payload) =>
        {
            heard.Enqueue($"again {payload}");

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);
        await news.Notify("flash").WaitAsync(Patience, Cancelled);

        Assert.True(await Eventually(() =>
        {
            return heard.SequenceEqual(["again flash"]);
        }));
    }

    [Fact]
    public async Task A_command_whose_timeout_passes_is_cancelled_and_the_client_s_resolver_hears_it()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var port = await PortOf(ends.Server);
        var opened = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancels = new ConcurrentQueue<bool>();

        ends.Server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
        {
            opened.TrySetResult(request.ConnectionHandle);

            return response.Answer("");
        });
        ends.Client.Services.GetCommandResolver(Ping, TextAnswered)(StoppedOnCancel(cancels));

        await Connect(ends.Client, port);
        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        var connectionHandle = await opened.Task.WaitAsync(Patience, Cancelled);

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return ends.Server.Services.GetCommand(Ping, TextAsked)("ping")(new RequestOptions
            {
                ConnectionHandle = connectionHandle,
                Timeout = TimeSpan.FromMilliseconds(50),
            }).WaitAsync(Patience, Cancelled);
        });
        // a token carries no reason: that it was cancelled is what this side's resolver hears
        Assert.True(await Eventually(() =>
        {
            return cancels.SequenceEqual([true]);
        }));
        // cancelled, not closed: CloseOnCommandTimeout is not set
        Assert.Equal(ReadyState.Open, ends.Client.Transport.ReadyState);
    }

    [Fact]
    public async Task A_request_whose_timeout_passes_is_cancelled_and_the_server_s_resolver_hears_it()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var port = await PortOf(ends.Server);
        var cancels = new ConcurrentQueue<bool>();
        var errors = new ConcurrentQueue<Exception>();

        ends.Server.Router.Error += (reason, _) =>
        {
            errors.Enqueue(reason);
        };
        ends.Server.Services.GetRequestResolver(Echo, TextAnswered)(StoppedOnCancel(cancels));

        await Connect(ends.Client, port);

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return ends.Client.Services.GetRequest(Echo, TextAsked)("hi")(new RequestOptions { Timeout = TimeSpan.FromMilliseconds(50) })
                .WaitAsync(Patience, Cancelled);
        });
        Assert.True(await Eventually(() =>
        {
            return cancels.SequenceEqual([true]);
        }));
        // what stopped because its call was cancelled is no one's to hear of
        Assert.Empty(errors);
    }

    [Fact]
    public async Task A_session_that_ends_ends_the_subscriptions_it_let_the_client_have_the_client_drops_them_and_asks_anew()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var server = ends.Server;
        var port = await PortOf(server);

        server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
        {
            server.Sessions.Set(server.Sessions.Create(request.ConnectionHandle) with
            {
                ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan,
                // ! on the real clock: the registration must reach the server inside it, which a
                // loaded runner takes far more than a few milliseconds to do
                SessionInactivityTimeout = TimeSpan.FromSeconds(1),
            });

            return response.Answer("");
        });
        server.Services.GetNotificationResolver(News, TextNotified with { BeforeRequest = server.RequireSession })((_, response) =>
        {
            return response.Answer("ok");
        });

        await Connect(ends.Client, port);
        await ends.Client.Services.GetRequest(OpenSession, TextAsked)("me")().WaitAsync(Patience, Cancelled);

        var dropped = new TaskCompletionSource<Procedure>(TaskCreationOptions.RunContinuationsAsynchronously);

        ends.Client.Services.Dropped += (procedure, _) =>
        {
            dropped.TrySetResult(procedure);
        };

        var notification = ends.Client.Services.GetNotification(News, TextSubscribed);

        await notification.Register("subscribe", (_) =>
        {
            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        Assert.NotNull(ends.Client.Router.SessionToken);
        Assert.Equal(News, await dropped.Task.WaitAsync(Patience, Cancelled));
        Assert.Null(ends.Client.Router.SessionToken);
        Assert.Equal(0, await SubscriptionsOf(server));

        // without a session, the next registration asks anew, and is refused
        Assert.Equal((ushort)ProtocolCode.SessionRequired, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return notification.Register("subscribe", (_) =>
            {
                return Task.CompletedTask;
            })().WaitAsync(Patience, Cancelled);
        })).Code);
    }

    [Fact]
    public async Task An_ordinary_request_to_the_procedure_of_a_subscription_held_moves_nothing_notify_still_reaches_it()
    {
        await using var ends = new Ends(new WebSocketServer<string>(), new WebSocketClient());
        var port = await PortOf(ends.Server);
        var subscribing = new ConcurrentQueue<uint>();
        var news = ends.Server.Services.GetNotificationResolver(News, TextNotified)(async (request, response) =>
        {
            if (request.Header.OpensSubscription)
            {
                subscribing.Enqueue(request.Header.CallId);
            }

            // an ordinary request subscribes nothing: its callback cannot, and fails if it tries
            if (request.Payload == "fail")
            {
                await response.RegisterNotification();
            }

            await response.Answer("ok");
        });

        await Connect(ends.Client, port);

        var heard = new ConcurrentQueue<string>();
        var notification = ends.Client.Services.GetNotification(News, TextSubscribed);

        await notification.Register("subscribe", (payload) =>
        {
            heard.Enqueue(payload);

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        var plain = ends.Client.Services.GetRequest(News, TextAsked);

        Assert.Equal("ok", await plain("again")().WaitAsync(Patience, Cancelled));
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return plain("fail")().WaitAsync(Patience, Cancelled);
        })).Code);

        await news.Notify("still").WaitAsync(Patience, Cancelled);

        Assert.True(await Eventually(() =>
        {
            return heard.SequenceEqual(["still"]);
        }));
        // one subscription, the one call 1 made: this side's router counts them, and names none
        Assert.Equal(1, await SubscriptionsOf(ends.Server));
        Assert.Equal([1u], subscribing);
    }

    [Fact(Skip = SamePort.Reason, SkipUnless = nameof(OpensTwoSocketsFromOnePort))]
    public async Task Keeps_two_sockets_from_one_address_and_port_to_two_of_its_addresses_as_two_connections_each_in_its_own_session_and_closes_both_going_away_as_it_stops()
    {
        // a server on every address, each socket bound to one address and port of the loopback
        var server = new WebSocketServer<string>();
        var port = (await server.Transport.Start(new WebSocketTransportStartOptions { Address = "0.0.0.0", FindOpenPort = true }, Cancelled)).Port;
        var localPort = new StrongBox<int>(0);
        using var aliceHandshakes = new SamePort(localPort);
        using var otherHandshakes = new SamePort(localPort);
        var alice = new WebSocketClient(new WebSocketClientOptions { Transport = new WebSocketTransportClientOptions { Invoker = aliceHandshakes.Invoker } });
        var other = new WebSocketClient(new WebSocketClientOptions { Transport = new WebSocketTransportClientOptions { Invoker = otherHandshakes.Invoker } });

        // who opened a session on each connection, as its handle names it
        var names = new ConcurrentDictionary<string, string>();

        try
        {
            server.Services.GetRequestResolver(OpenSession, TextAnswered)((request, response) =>
            {
                var session = server.Sessions.Set(server.Sessions.Create(request.ConnectionHandle));

                names[request.ConnectionHandle] = request.Payload;

                return response.Answer(session.SessionToken?.ToString() ?? "");
            });
            server.Services.GetRequestResolver(Whoami, TextAnswered with { BeforeRequest = server.RequireSession })((request, response) =>
            {
                return response.Answer(names.GetValueOrDefault(request.ConnectionHandle, "nobody"));
            });
            server.Services.GetRequestResolver(Echo, TextAnswered with { BeforeRequest = server.RequireSession })((request, response) =>
            {
                return response.Answer(request.Payload.ToUpperInvariant());
            });

            await alice.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = port }, Cancelled);
            await alice.Services.GetRequest(OpenSession, TextAsked)("alice")().WaitAsync(Patience, Cancelled);
            await other.Connect(new WebSocketConnectOptions { Host = "127.0.0.2", Port = port }, Cancelled);

            // ! the client's connect settles on the 101, which the server writes before it keeps the
            // connection: wait for it to hold both
            Assert.True(await Eventually(() =>
            {
                return server.Transport.Clients.Count == 2;
            }));

            // one address and one port, two connections: the second is in no session of the first's
            var clients = server.Transport.Clients;

            Assert.Equal((localPort.Value, localPort.Value), (clients[0].Port, clients[1].Port));
            Assert.NotEqual(clients[0].ConnectionHandle, clients[1].ConnectionHandle);

            var refused = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return other.Services.GetRequest(Whoami, TextAsked)("")().WaitAsync(Patience, Cancelled);
            });

            Assert.Equal((ushort)ProtocolCode.SessionRequired, refused.Code);
            Assert.Equal("alice", await alice.Services.GetRequest(Whoami, TextAsked)("")().WaitAsync(Patience, Cancelled));
            Assert.Equal("HI", await alice.Services.GetRequest(Echo, TextAsked)("hi")().WaitAsync(Patience, Cancelled));

            // the stop reaches each, going away, and resolves
            await server.DisposeAsync().AsTask().WaitAsync(Patience, Cancelled);

            Assert.True(await Eventually(() =>
            {
                return (aliceHandshakes.CloseCode, otherHandshakes.CloseCode) == (1001, 1001);
            }), $"{aliceHandshakes.CloseCode} {otherHandshakes.CloseCode}");
        }
        finally
        {
            await alice.DisposeAsync();
            await other.DisposeAsync();
            await server.DisposeAsync();
        }
    }

    [Fact]
    public async Task Answers_leg_A_DESTINATION_LOST_when_its_leg_B_over_WebSocket_is_dropped_behind_its_socket()
    {
        // a relay whose sockets hold 256 bytes waiting at most, admitting every call
        await using var hub = new WebSocketServer<string>(new WebSocketServerOptions
        {
            Server = new ServerOptions
            {
                Relay = new RelayOptions
                {
                    BeforeRoute = new BeforeRequest((_) =>
                    {
                        return true;
                    }),
                },
            },
            Transport = new WebSocketTransportServerOptions { MaximumUnsentBytes = 256 },
        });
        var reported = new ConcurrentQueue<(Exception Reason, string ConnectionHandle)>();
        var opened = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        hub.Transport.Error += (reason, connectionHandle) =>
        {
            reported.Enqueue((reason, connectionHandle));
        };
        hub.Transport.Connection += (connectionHandle) =>
        {
            opened.TrySetResult(connectionHandle);
        };

        var port = await PortOf(hub);

        // the device behind it, at destination 7, on the hub's own connection to it: leg B
        await using var device = new WebSocketClient();

        device.Services.GetRequestResolver(Echo, TextAnswered)((request, response) =>
        {
            return response.Answer(request.Payload);
        });
        await Connect(device, port);

        var legB = await opened.Task.WaitAsync(Patience, Cancelled);

        hub.Router.RegisterDestination(new ConnectionTarget(legB), new DestinationOptions { DestinationId = 7 });

        await using var requester = new WebSocketClient();

        await Connect(requester, port);

        // a request leg B cannot hold waiting for its socket: leg B is dropped, and leg A answered
        var lost = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return requester.Services.GetRequest(Echo, TextAsked)(new string('x', 400))(new RequestOptions { DestinationId = 7 }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.DestinationLost, lost.Code);
        Assert.Equal(legB, Assert.Single(reported).ConnectionHandle);
        Assert.Equal(
            $"{legB} is dropped: what waits for its socket would pass maximumUnsentBytes, 256 bytes",
            Assert.IsType<IOException>(Assert.Single(reported).Reason).Message);
    }
}
