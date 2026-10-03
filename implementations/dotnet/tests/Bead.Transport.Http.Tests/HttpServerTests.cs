using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Bead.Transport.WebSockets;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="HttpServer{TData}"/> and <see cref="BeadHttpClient"/> together, over a real port: a
/// session, calls in flight, an upload, a cancel, what a client that listens hears, relays either way,
/// and the bounds; each test ends with the server at rest once its client is gone.
/// </summary>
public sealed class HttpServerTests
{
    // constants

    private const string Host = "127.0.0.1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly Procedure OpenSession = ProcedureOf(1, "openSession");
    private static readonly Procedure Read = ProcedureOf(2, "read");
    private static readonly Procedure Upload = ProcedureOf(3, "upload");
    private static readonly Procedure Slow = ProcedureOf(4, "slow");
    private static readonly Procedure News = ProcedureOf(5, "news");
    private static readonly Procedure Ping = ProcedureOf(6, "ping");
    private static readonly Procedure Echo = ProcedureOf(7, "echo");

    private static readonly TextPayloads Text = new();
    private static readonly BytesPayloads Bytes = new();

    // what a registration keeps on purpose, whether its connection stands or not
    private static readonly HashSet<string> Kept = ["closedDestinations", "destinations"];

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static Procedure ProcedureOf(ushort procedureId, string procedureName)
    {
        return new Procedure { ServiceId = 1, ProcedureId = procedureId, ProcedureName = procedureName, ServiceRevision = 1 };
    }

    private static string DigestOf(byte[] payload)
    {
        return Convert.ToHexStringLower(SHA256.HashData(payload));
    }

    private static Func<string, Requester<string>> TextRequester(ServiceManager services, Procedure procedure)
    {
        return services.GetRequest(procedure, new RequestDependencies<string, string> { Serializer = Text });
    }

    // what each layer of the server still keeps, each as `layer:count value`
    private static async Task<List<string>> KeptOf(HttpServer<string> server)
    {
        var gauges = await server.Gauges();
        (string Layer, LayerGauges Gauges)[] layers =
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
                    return $"{layer.Layer}:{count.Key} {count.Value}";
                });
        })];
    }

    // waits until each layer keeps nothing — its destinations aside — then expects its health to pass
    private static async Task AtRest(HttpServer<string> server)
    {
        for (var tries = 0; tries < 100 && (await KeptOf(server)).Count > 0; tries += 1)
        {
            await Task.Delay(20, Cancelled);
        }

        Assert.Empty(await KeptOf(server));
        Assert.Equal(HealthStatus.Pass, (await server.Health()).Status);
    }

    private static async Task Eventually(Func<bool> condition)
    {
        for (var tries = 0; tries < 200 && !condition(); tries += 1)
        {
            await Task.Delay(20, Cancelled);
        }

        Assert.True(condition());
    }

    // an HTTP server on a free port — a session opened by openSession, read behind it, upload
    // answering its payload's digest, slow waiting on its signal, news a subscription — and an HTTP
    // client connected to it
    private static async Task<Connected> ConnectHttp(ServerOptions? options = null, bool isListening = true)
    {
        var server = new HttpServer<string>(new HttpServerOptions { Server = options });
        var (services, sessions) = (server.Services, server.Sessions);
        var aborted = new List<string>();

        services.GetRequestResolver(OpenSession, new RequestResolverDependencies<string, string> { Serializer = Text })((request, response) =>
        {
            sessions.Set(sessions.Create(request.ConnectionHandle) with { SessionInactivityTimeout = Timeout.InfiniteTimeSpan });

            return response.Answer("opened");
        });
        services.GetRequestResolver(Read, new RequestResolverDependencies<string, string> { Serializer = Text, BeforeRequest = server.RequireSession })(async (request, response) =>
        {
            // the later a call comes, the sooner it answers: the answers come out of order
            await Task.Delay(int.Parse(request.Payload, System.Globalization.CultureInfo.InvariantCulture), Cancelled);
            await response.Answer(request.Payload);
        });
        services.GetRequestResolver(Upload, new RequestResolverDependencies<byte[], byte[]> { Serializer = Bytes, BeforeRequest = server.RequireSession })((request, response) =>
        {
            return response.Answer(Encoding.UTF8.GetBytes(DigestOf(request.Payload)));
        });
        services.GetRequestResolver(Slow, new RequestResolverDependencies<string, string> { Serializer = Text })(async (request, _) =>
        {
            var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            await using (request.Signal.Register(() =>
            {
                lock (aborted)
                {
                    aborted.Add("cancelled");
                }

                cancelled.TrySetResult();
            }))
            {
                await cancelled.Task;
            }
        });

        var news = services.GetNotificationResolver(News, new NotificationResolverDependencies<string, string, string> { Serializer = Text })(async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("subscribed");
        });
        var address = await server.Transport.Start(new HttpTransportStartOptions { Address = Host, FindOpenPort = true }, Cancelled);
        var client = new BeadHttpClient(new BeadHttpClientOptions { Transport = new HttpTransportClientOptions { IsListening = isListening } });

        await client.Connect(new HttpConnectOptions { Host = Host, Port = address.Port }, Cancelled);

        return new Connected((server, client), (address.Port, aborted, news));
    }

    // definition

    [Fact]
    public async Task Open_a_session_by_a_request_and_answer_within_it_refusing_before_it()
    {
        await using var connected = await ConnectHttp();
        var reading = TextRequester(connected.Client.Services, Read);

        Assert.Equal((ushort)ProtocolCode.SessionRequired, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return reading("0")().WaitAsync(Patience, Cancelled);
        })).Code);
        Assert.Equal("opened", await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled));

        // the session announced on that answer, and kept by the connection drawn
        Assert.NotNull(connected.Client.Router.SessionToken);
        Assert.Equal("0", await reading("0")().WaitAsync(Patience, Cancelled));

        // each layer counts the one connection, the transport's own counts among them, and holds up
        var gauges = await connected.Server.Gauges();

        Assert.Equal(
            (1L, 1L, 1L, HealthStatus.Pass),
            (gauges.Transport.Counts["connections"], gauges.Server.Counts["connections"], gauges.Sessions.Counts["sessions"], (await connected.Server.Health()).Status));
    }

    [Fact]
    public async Task Answer_calls_in_flight_together_each_by_its_own_call_id_whatever_the_order_they_end_in()
    {
        await using var connected = await ConnectHttp();

        await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);

        var reading = TextRequester(connected.Client.Services, Read);
        string[] waits = ["60", "30", "0"];
        var answered = await Task.WhenAll(waits.Select((wait) =>
        {
            return reading(wait)().WaitAsync(Patience, Cancelled);
        }));

        Assert.Equal(["60", "30", "0"], answered);
    }

    [Fact]
    public async Task Upload_8_MiB_in_one_exchange_and_refuse_on_the_client_what_one_envelope_cannot_hold()
    {
        await using var connected = await ConnectHttp();
        var payload = new byte[8 * 1_048_576];

        for (var index = 0; index < payload.Length; index += 1)
        {
            payload[index] = (byte)(index % 251);
        }

        var uploading = connected.Client.Services.GetRequest(Upload, new RequestDependencies<byte[], byte[]> { Serializer = Bytes });

        await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);
        Assert.Equal(DigestOf(payload), Encoding.UTF8.GetString(await uploading(payload)(new RequestOptions { Timeout = TimeSpan.FromSeconds(30) }).WaitAsync(TimeSpan.FromSeconds(30), Cancelled)));
        Assert.Equal((0, 0), (connected.Client.Router.Limits.MaximumTransfers, connected.Server.Router.Limits.MaximumTransfers));

        // no transfer over HTTP: past what one envelope holds, refused before anything goes
        await using var small = new BeadHttpClient(new BeadHttpClientOptions { Limits = RouterLimits.Default with { MaximumEnvelopeBytes = 1_024 } });

        await small.Connect(new HttpConnectOptions { Host = Host, Port = connected.Port }, Cancelled);
        await TextRequester(small.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return small.Services.GetRequest(Upload, new RequestDependencies<byte[], byte[]> { Serializer = Bytes })(new byte[2_000])().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(
            ((ushort)ProtocolCode.PayloadTooLarge, "a payload of 2000 bytes goes as a transfer, which this side sends none of", FailureOrigin.Local),
            (refused.Code, refused.Detail, refused.Origin));
    }

    [Fact]
    public async Task Cancel_a_call_on_its_server_when_it_times_out_on_the_client()
    {
        await using var connected = await ConnectHttp();

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return TextRequester(connected.Client.Services, Slow)("wait")(new RequestOptions { Timeout = TimeSpan.FromMilliseconds(100) }).WaitAsync(Patience, Cancelled);
        });
        await Eventually(() =>
        {
            lock (connected.Aborted)
            {
                return connected.Aborted.Count == 1;
            }
        });
    }

    [Fact]
    public async Task Refuse_a_subscription_to_a_client_that_does_not_listen_which_nothing_brings_back_and_a_command_which_nothing_carries()
    {
        await using var connected = await ConnectHttp(null, false);
        var notification = connected.Client.Services.GetNotification(News, new NotificationDependencies<string, string, string> { Serializer = Text });
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return notification.Register("subscribe", (_) =>
            {
                return Task.CompletedTask;
            })().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.SubscriptionUnsupported, (RouterSide?)RouterSide.Server), (refused.Code, refused.Side));

        var connectionHandle = connected.Server.Transport.ConnectionHandles.Single();
        var commanded = await Record.ExceptionAsync(() =>
        {
            return TextRequester(connected.Server.Services, Ping)("ping")(new RequestOptions { ConnectionHandle = connectionHandle, Timeout = TimeSpan.FromSeconds(1) })
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Contains("this connection does not listen", commanded?.Message ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public async Task Close_a_connection_that_opened_no_session_within_its_timeout_30_s_by_default()
    {
        await using (var connected = await ConnectHttp(new ServerOptions { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(50) }))
        {
            var closed = new TaskCompletionSource<(bool WasClean, bool WasQuick)>(TaskCreationOptions.RunContinuationsAsynchronously);

            connected.Client.Transport.Close += (wasClean, wasQuick) =>
            {
                closed.TrySetResult((wasClean, wasQuick));
            };

            // the connection is gone: the next exchange learns it, and the client closes
            await Task.Delay(120, Cancelled);
            await Record.ExceptionAsync(() =>
            {
                return TextRequester(connected.Client.Services, Read)("0")().WaitAsync(Patience, Cancelled);
            });
            Assert.Equal((false, false), await closed.Task.WaitAsync(Patience, Cancelled));
        }

        // by default, 30 s: a connection with no session stays for 30 s, then goes
        var time = new Microsoft.Extensions.Time.Testing.FakeTimeProvider();

        await using var server = new HttpServer<string>(new HttpServerOptions { Transport = new HttpTransportServerOptions { Clock = time } });
        var address = await server.Transport.Start(new HttpTransportStartOptions { Address = Host, FindOpenPort = true }, Cancelled);
        await using var client = new BeadHttpClient();

        await client.Connect(new HttpConnectOptions { Host = Host, Port = address.Port }, Cancelled);
        Assert.Equal(TimeSpan.FromSeconds(30), HttpServerOptions.ConnectionInactivityTimeoutDefault);
        time.Advance(TimeSpan.FromSeconds(29));
        Assert.Single(server.Transport.ConnectionHandles);
        time.Advance(TimeSpan.FromSeconds(1));
        await Eventually(() =>
        {
            return server.Transport.ConnectionHandles.Count == 0;
        });
    }

    [Fact]
    public async Task Bring_a_client_that_listens_what_the_server_sends_of_its_own_a_subscription_s_notifications_a_command_a_call_relayed_to_it()
    {
        await using var connected = await ConnectHttp();
        var (client, server) = (connected.Client, connected.Server);
        var heard = new List<string>();
        var connectionHandle = server.Transport.ConnectionHandles.Single();
        var notification = client.Services.GetNotification(News, new NotificationDependencies<string, string, string> { Serializer = Text });

        await using var subscribed = await notification.Register("subscribe", (news) =>
        {
            lock (heard)
            {
                heard.Add(news);
            }

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await connected.Notify("first");
        await connected.Notify("second");
        await Eventually(() =>
        {
            lock (heard)
            {
                return heard.SequenceEqual(["first", "second"]);
            }
        });

        // the server asks, and the client answers
        client.Services.GetRequestResolver(Ping, new RequestResolverDependencies<string, string> { Serializer = Text })((request, response) =>
        {
            return response.Answer($"{request.Payload} pong");
        });
        Assert.Equal(
            "ping pong",
            await TextRequester(server.Services, Ping)("ping")(new RequestOptions { ConnectionHandle = connectionHandle, Timeout = TimeSpan.FromSeconds(5) }).WaitAsync(Patience, Cancelled));

        // a call another client makes, relayed to this one
        await using var requester = new BeadHttpClient();

        client.Services.GetRequestResolver(Echo, new RequestResolverDependencies<string, string> { Serializer = Text })((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        server.Router.RegisterDestination(new ConnectionTarget(connectionHandle), new DestinationOptions { DestinationId = 5 });
        await requester.Connect(new HttpConnectOptions { Host = Host, Port = connected.Port }, Cancelled);
        await TextRequester(requester.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);
        Assert.Equal("HI", await TextRequester(requester.Services, Echo)("hi")(new RequestOptions { DestinationId = 5 }).WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Relay_a_call_from_an_HTTP_requester_to_a_target_behind_a_WebSocket_once_a_session_admits_it()
    {
        await using var target = new WebSocketServer<string>();
        var targetAddress = await target.Transport.Start(new WebSocketTransportStartOptions { Address = Host, FindOpenPort = true }, Cancelled);
        await using var toTarget = new WebSocketClient();

        target.Services.GetRequestResolver(Echo, new RequestResolverDependencies<string, string> { Serializer = Text })((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        await toTarget.Connect(new WebSocketConnectOptions { Host = Host, Port = targetAddress.Port }, Cancelled);

        await using var connected = await ConnectHttp();
        var echoing = TextRequester(connected.Client.Services, Echo);

        connected.Server.Router.RegisterDestination(toTarget.Router, new DestinationOptions { DestinationId = 7 });
        Assert.Equal((ushort)ProtocolCode.SessionRequired, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return echoing("hi")(new RequestOptions { DestinationId = 7 }).WaitAsync(Patience, Cancelled);
        })).Code);
        await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);
        Assert.Equal("HI", await echoing("hi")(new RequestOptions { DestinationId = 7 }).WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Pass_nothing_on_to_a_connection_drawn_over_HTTP_whose_client_does_not_listen_which_takes_no_request_of_the_server_s()
    {
        await using var connected = await ConnectHttp(null, false);

        connected.Server.Router.RegisterDestination(new ConnectionTarget(connected.Server.Transport.ConnectionHandles.Single()), new DestinationOptions { DestinationId = 9 });
        await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return TextRequester(connected.Client.Services, Echo)("hi")(new RequestOptions { DestinationId = 9 }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, "destination 9 is unreachable: its connection carries no request"), (refused.Code, refused.Detail));
    }

    [Fact]
    public async Task Relay_a_call_whose_leg_B_goes_over_HTTP_refused_there_nothing_tried_lost_there_it_may_have_run()
    {
        await using var connected = await ConnectHttp();
        using var handler = new ScriptedHandler();
        await using var legB = new BeadHttpClient(new BeadHttpClientOptions { Transport = new HttpTransportClientOptions { Handler = handler, IsListening = false } });
        var connecting = legB.Connect(new HttpConnectOptions { Host = Host, Port = 1 }, Cancelled);

        (await handler.Next()).Answer.SetResult(ScriptedHandler.Drawn());
        await connecting.WaitAsync(Patience, Cancelled);
        connected.Server.Router.RegisterDestination(legB.Router, new DestinationOptions { DestinationId = 7 });
        await TextRequester(connected.Client.Services, OpenSession)("me")().WaitAsync(Patience, Cancelled);

        var echoing = TextRequester(connected.Client.Services, Echo);
        var refused = echoing("hi")(new RequestOptions { DestinationId = 7 });
        var busy = new HttpResponseMessage(HttpStatusCode.TooManyRequests);

        busy.Headers.Add(HttpTransport.RefusalHeader, HttpRefusals.Busy);
        (await handler.Next()).Answer.SetResult(busy);

        var unreachable = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return refused.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, (byte)0), (unreachable.Code, unreachable.Relays));

        var lost = echoing("hi")(new RequestOptions { DestinationId = 7 });

        (await handler.Next()).Answer.SetException(new HttpRequestException("the network failed"));

        var gone = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return lost.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.DestinationLost, (byte)0), (gone.Code, gone.Relays));
    }

    [Fact]
    public async Task Refuse_a_body_past_the_envelope_its_router_takes_413_before_the_router_reads_any_of_it()
    {
        await using var connected = await ConnectHttp(new ServerOptions { Limits = RouterLimits.Default with { MaximumEnvelopeBytes = 1_024 } });
        using var http = new HttpClient();
        var uri = new Uri($"http://{Host}:{connected.Port}/bead");
        using var connect = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new ByteArrayContent([]) };

        connect.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

        using var drawn = await http.SendAsync(connect, Cancelled);
        var connectionToken = drawn.Headers.GetValues(HttpTransport.ConnectionTokenHeader).Single();
        using var posting = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new ByteArrayContent(new byte[1_025]) };

        posting.Headers.Add(HttpTransport.ConnectionTokenHeader, connectionToken);
        posting.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

        string outcome;

        try
        {
            using var refused = await http.SendAsync(posting, Cancelled);

            outcome = $"{(int)refused.StatusCode} {refused.Headers.GetValues(HttpTransport.RefusalHeader).Single()}";
        }
        catch (HttpRequestException)
        {
            outcome = "reset";
        }

        // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
        Assert.True(outcome is "413 too-large" or "reset", outcome);

        // the connection drawn by hand, ended by hand
        using var deleting = new HttpRequestMessage(HttpMethod.Delete, uri);

        deleting.Headers.Add(HttpTransport.ConnectionTokenHeader, connectionToken);
        using var deleted = await http.SendAsync(deleting, Cancelled);
    }

    [Fact]
    public async Task Build_its_router_with_the_pacing_its_options_give()
    {
        await using var server = new HttpServer<string>(new HttpServerOptions { Server = new ServerOptions { Pacing = new PacingLimits { MaximumQueuedNotifications = 3 } } });

        Assert.Equal(3, (await server.Gauges()).Router.Ceilings["largestQueuedNotifications"]);
    }

    // the TypeScript side refuses limits that ask for a transfer; a record's default cannot tell
    // given from not, so this side takes none whatever is given
    [Fact]
    public async Task Take_no_transfer_whatever_the_limits_give()
    {
        await using var server = new HttpServer<string>(new HttpServerOptions { Server = new ServerOptions { Limits = RouterLimits.Default with { MaximumTransfers = 2 } } });
        await using var client = new BeadHttpClient(new BeadHttpClientOptions { Limits = RouterLimits.Default with { MaximumTransfers = 2 } });

        Assert.Equal((0, 0), (server.Router.Limits.MaximumTransfers, client.Router.Limits.MaximumTransfers));
    }

    [Fact]
    public void Refuse_an_inactivity_timeout_of_0_which_its_default_does_not_stand_in_for()
    {
        Assert.StartsWith("a connection's inactivity timeout is a whole number of milliseconds from 1 to 2147483647, or infinite for never, not 0", Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new HttpServer<string>(new HttpServerOptions { Server = new ServerOptions { ConnectionInactivityTimeout = TimeSpan.Zero } });
        }).Message, StringComparison.Ordinal);
    }

    // an HTTP server and its client, connected: taken apart once each layer keeps nothing of the
    // client gone
    private sealed class Connected((HttpServer<string> Server, BeadHttpClient Client) ends, (int Port, List<string> Aborted, INotificationResolver<string> News) made) : IAsyncDisposable
    {
        public HttpServer<string> Server { get; } = ends.Server;

        public BeadHttpClient Client { get; } = ends.Client;

        public int Port { get; } = made.Port;

        // the calls to slow whose signal was cancelled
        public List<string> Aborted { get; } = made.Aborted;

        // what tells the subscribers to news
        public Task Notify(string value)
        {
            return made.News.Notify(value);
        }

        public async ValueTask DisposeAsync()
        {
            await Client.DisposeAsync();

            try
            {
                await AtRest(Server);
            }
            finally
            {
                await Server.DisposeAsync();
            }
        }
    }

    // UTF-8 text both ways, notifications included
    private sealed class TextPayloads : INotificationSerializerClient<string, string, string>, INotificationSerializerServer<string, string, string>
    {
        public ReadOnlyMemory<byte> Encode(string payload)
        {
            return Encoding.UTF8.GetBytes(payload);
        }

        public string Decode(ReadOnlyMemory<byte> payload)
        {
            return Encoding.UTF8.GetString(payload.Span);
        }

        public string DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return Encoding.UTF8.GetString(notification.Span);
        }

        public ReadOnlyMemory<byte> EncodeNotification(string notification)
        {
            return Encoding.UTF8.GetBytes(notification);
        }
    }

    // bytes as they are, both ways
    private sealed class BytesPayloads : IRequestSerializerClient<byte[], byte[]>, IRequestSerializerServer<byte[], byte[]>
    {
        public ReadOnlyMemory<byte> Encode(byte[] payload)
        {
            return payload;
        }

        public byte[] Decode(ReadOnlyMemory<byte> payload)
        {
            return payload.ToArray();
        }
    }

    // what an HTTP client's exchanges go through, answered as a test says: the TypeScript side's fake fetch
    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly Channel<(HttpRequestMessage Request, TaskCompletionSource<HttpResponseMessage> Answer)> _calls = Channel.CreateUnbounded<(HttpRequestMessage, TaskCompletionSource<HttpResponseMessage>)>();

        // the 201 that draws a connection, its token given
        public static HttpResponseMessage Drawn()
        {
            var drawn = new HttpResponseMessage(HttpStatusCode.Created);

            drawn.Headers.Add(HttpTransport.ConnectionTokenHeader, new string('T', 22));

            return drawn;
        }

        // the next exchange it was handed, to answer
        public async Task<(HttpRequestMessage Request, TaskCompletionSource<HttpResponseMessage> Answer)> Next()
        {
            return await _calls.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var answer = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);

            // a DELETE nobody waits on is answered at once
            if (request.Method == HttpMethod.Delete)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }

            _calls.Writer.TryWrite((request, answer));

            return answer.Task.WaitAsync(cancellationToken);
        }
    }
}
