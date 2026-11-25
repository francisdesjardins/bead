using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Bead.Interop;
using Bead.Tests;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketClient"/>, the transport, the router and the services together, against a
/// server of the interop service on Kestrel: the C# side talking to itself over a socket.
/// </summary>
public sealed class WebSocketClientTests : IAsyncLifetime
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // a procedure of no service the interop server offers, which a test resolves itself
    private static readonly Procedure Held = new() { ServiceId = 2, ProcedureId = 1, ProcedureName = "held", ServiceRevision = 1 };

    private readonly WebSocketTransportServer _transport = new();
    private readonly Server<string> _server;
    private WebSocketClient _client = new();
    private int _port;

    public WebSocketClientTests()
    {
        _server = new Server<string>(_transport);
        InteropHandlers.Offer(_server);
    }

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement JsonOf(string text)
    {
        using var document = JsonDocument.Parse(text);

        return document.RootElement.Clone();
    }

    private Func<JsonElement, BoundCall<JsonElement>> RequesterOf(string procedureName)
    {
        return _client.Services.GetRequest(
            InteropProcedures.All.Single((procedure) =>
            {
                return procedure.Procedure.ProcedureName == procedureName;
            }).Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });
    }

    // the next request the client's router sends, read by the server's router: what a test cancels,
    // stops or replaces after, never a delay that a loaded runner outlasts
    // ! the server's read, not the client's Tx: a Tx is handed to the socket, whose send a dispose
    // that follows at once can still fail with the transport's own refusal
    private Task RequestSent()
    {
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _server.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Rx && envelope.Header is RequestHeader)
            {
                sent.TrySetResult();
            }
        };

        return sent.Task.WaitAsync(Patience, Cancelled);
    }

    // * a transport without a router: each envelope waits for the test's answer
    private sealed class EnvelopePeer : IAsyncDisposable
    {
        private readonly WebSocketTransportServer _transport = new();
        private readonly Channel<Envelope> _received = Channel.CreateUnbounded<Envelope>();
        private string _handle = "";

        public WebSocketClient Client { get; } = new();

        public static async Task<EnvelopePeer> Start()
        {
            var peer = new EnvelopePeer();
            peer._transport.Connection += (handle) => { peer._handle = handle; };
            peer._transport.Message += (message, _) =>
            {
                peer._received.Writer.TryWrite(EnvelopeCodec.ReadEnvelope(message.Bytes.Span, new EnvelopeReadOptions { Side = RouterSide.Server })!);
            };
            try
            {
                var bound = await peer._transport.Start(new TransportServerStartOptions { Address = "127.0.0.1", FindOpenPort = true, CancellationToken = Cancelled });
                await peer.Client.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = bound.Port, CancellationToken = Cancelled });
                return peer;
            }
            catch
            {
                await peer.DisposeAsync();
                throw;
            }
        }

        public Task<Envelope> Next()
        {
            return _received.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        public Task Send(Envelope envelope)
        {
            return _transport.Send(new TransportMessage(EnvelopeCodec.WriteEnvelope(envelope), false), _handle).WaitAsync(Patience, Cancelled);
        }

        public Task<bool> Close()
        {
            return _transport.CloseConnection(_handle).WaitAsync(Patience, Cancelled);
        }

        public async ValueTask DisposeAsync()
        {
            await Client.DisposeAsync();
            await _transport.DisposeAsync();
        }
    }

    private static readonly Procedure RawEcho = new() { ServiceId = 1, ProcedureId = 2, ProcedureName = "echo", ServiceRevision = 1 };

    private static Task<string> RawCall(WebSocketClient client, string payload, RequestOptions? options = null)
    {
        return client.Services.GetRequest(RawEcho, new RequestDependencies<string, string> { Serializer = new TextSerializer() })(payload)(options);
    }

    private static Envelope ResultTo(uint callId, string payload)
    {
        return new Envelope { Header = new ResultHeader { CallId = callId }, Payload = System.Text.Encoding.UTF8.GetBytes(payload) };
    }

    // definition

    public async ValueTask InitializeAsync()
    {
        _port = (await _transport.Start(new TransportServerStartOptions { Address = "127.0.0.1", FindOpenPort = true, CancellationToken = Cancelled })).Port;
        await _client.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = _port, CancellationToken = Cancelled });
    }

    public async ValueTask DisposeAsync()
    {
        await _client.DisposeAsync();
        await _server.DisposeAsync();
    }

    [Fact]
    public async Task Sends_a_request_as_an_envelope_resolves_with_its_result_and_learns_the_session()
    {
        await using var peer = await EnvelopePeer.Start();
        var answering = RawCall(peer.Client, "hello");
        var request = await peer.Next();

        Assert.Equal(new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 2 }, request.Header);
        Assert.Equal("hello", System.Text.Encoding.UTF8.GetString(request.Payload.Span));
        var token = SessionToken.FromBytes(Enumerable.Repeat((byte)9, 16).ToArray());
        await peer.Send(new Envelope { Header = new ResultHeader { CallId = 1, Credential = Credential.Opaque(token) }, Payload = "HELLO"u8.ToArray() });
        Assert.Equal("HELLO", await answering.WaitAsync(Patience, Cancelled));
        Assert.Equal(token, peer.Client.Router.SessionToken);
    }

    [Fact]
    public async Task Rejects_with_the_failure_the_server_answers_its_procedure_s_own_included()
    {
        await using var peer = await EnvelopePeer.Start();
        var answering = RawCall(peer.Client, "hello");
        var request = await peer.Next();
        await peer.Send(new Envelope { Header = new FailureHeader { CallId = request.Header.CallId }, Failure = Failure.OfApplication(21, "not ready") });
        var failure = await Assert.ThrowsAsync<FailureException>(() => { return answering.WaitAsync(Patience, Cancelled); });

        Assert.Equal((ushort)21, failure.Code);
        Assert.Equal("not ready", failure.Detail);
        Assert.Equal(FailureOrigin.Peer, failure.Origin);
        Assert.Equal(RouterSide.Server, failure.Side);
        Assert.Equal(new ProcedureAddress { ServiceId = 1, ProcedureId = 2 }, failure.ProcedureAddress);
        Assert.True(failure.IsApplication(21));
    }

    [Fact]
    public async Task Hears_the_notifications_of_its_subscription_under_the_call_id_that_opened_it_one_ahead_of_its_result_included()
    {
        await using var peer = await EnvelopePeer.Start();
        var heard = Channel.CreateUnbounded<string>();
        var news = RawEcho with { ProcedureId = 4, ProcedureName = "news", ProcedureKind = ProcedureKind.Notifies };
        var subscribing = peer.Client.Services.GetNotification(news, new NotificationDependencies<string, string, string> { Serializer = new TextSerializer() }).Register("subscribe", (payload) =>
        {
            heard.Writer.TryWrite(payload);
            return Task.CompletedTask;
        })();
        var callId = (await peer.Next()).Header.CallId;
        await peer.Send(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = "first"u8.ToArray() });
        await peer.Send(ResultTo(callId, ""));
        await using var held = await subscribing.WaitAsync(Patience, Cancelled);
        await peer.Send(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = "news"u8.ToArray() });

        Assert.Equal("first", await heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal("news", await heard.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal(0, heard.Reader.Count);
    }

    [Fact]
    public async Task Answers_the_server_s_commands_on_even_call_ids_with_the_resolver_registered()
    {
        await using var peer = await EnvelopePeer.Start();
        var ping = RawEcho with { ProcedureId = 3, ProcedureName = "ping", ProcedureKind = ProcedureKind.Command };
        peer.Client.Services.GetCommandResolver(ping, new RequestResolverDependencies<string, string> { Serializer = new TextSerializer() })((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        await peer.Send(new Envelope { Header = new RequestHeader { CallId = 78, ServiceId = 1, ProcedureId = 3 }, Payload = "quiet"u8.ToArray() });
        var answer = await peer.Next();

        Assert.Equal(new ResultHeader { CallId = 78 }, answer.Header);
        Assert.Equal("QUIET", System.Text.Encoding.UTF8.GetString(answer.Payload.Span));
    }

    [Fact]
    public async Task Cancels_a_request_whose_timeout_passes_and_hears_nothing_of_an_answer_too_late()
    {
        await using var peer = await EnvelopePeer.Start();
        var errors = new ConcurrentQueue<Exception>();
        peer.Client.Router.Error += errors.Enqueue;
        var answering = RawCall(peer.Client, "hello", new RequestOptions { Timeout = TimeSpan.FromMilliseconds(500) });
        var callId = (await peer.Next()).Header.CallId;
        await Assert.ThrowsAsync<TimeoutException>(() => { return answering.WaitAsync(Patience, Cancelled); });
        Assert.Equal(new CancelHeader { CallId = 1 }, (await peer.Next()).Header);
        await peer.Send(ResultTo(callId, "late"));
        var following = RawCall(peer.Client, "after");
        var next = (await peer.Next()).Header.CallId;
        await peer.Send(ResultTo(next, "AFTER"));

        Assert.Equal("AFTER", await following.WaitAsync(Patience, Cancelled));
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Rejects_a_request_still_waiting_when_the_server_closes_the_connection()
    {
        await using var peer = await EnvelopePeer.Start();
        var answering = RawCall(peer.Client, "hello");
        await peer.Next();
        Assert.True(await peer.Close());
        await Assert.ThrowsAsync<DisconnectException>(() => { return answering.WaitAsync(Patience, Cancelled); });
    }

    [Fact]
    public async Task Each_client_is_an_IClient()
    {
        await using var client = new WebSocketClient();

        var beadClient = Assert.IsAssignableFrom<IClient>(client);

        Assert.Same(client.Router, beadClient.Router);
        Assert.Same(client.Services, beadClient.Services);
        Assert.Equal(typeof(IServiceManagerClient), typeof(WebSocketClient).GetProperty(nameof(WebSocketClient.Services))!.PropertyType);
    }

    [Fact]
    public async Task Runs_its_router_on_its_transport_s_clock_which_times_a_request_out()
    {
        var time = new FakeTimeProvider();
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var client = new WebSocketClient(new WebSocketClientOptions { Transport = new WebSocketTransportClientOptions { Clock = time } });

        Assert.Equal((time, time), (client.Transport.Clock, client.Router.Clock));
        await client.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = _port, CancellationToken = Cancelled });

        // its timer is armed before its request goes out
        client.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Tx && envelope.Header is RequestHeader)
            {
                sent.TrySetResult();
            }
        };

        var slow = client.Services.GetRequest(
            InteropProcedures.Slow.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() })(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { Timeout = TimeSpan.FromSeconds(1) });

        await sent.Task.WaitAsync(Patience, Cancelled);
        time.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        });
    }

    [Fact]
    public async Task Calls_the_server_and_reads_its_failures_as_the_peer_s()
    {
        Assert.Equal("{\"a\":1}", (await RequesterOf("echo")(JsonOf("{\"a\":1}"))().WaitAsync(Patience, Cancelled)).GetRawText());

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return RequesterOf("fail")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(7, failure.Code);
        Assert.Equal(FailureOrigin.Peer, failure.Origin);
        Assert.Equal(RouterSide.Server, failure.Side);
    }

    [Fact]
    public async Task Answers_the_server_s_command_over_the_socket()
    {
        InteropHandlers.OfferClient(new InteropClient(_client));

        Assert.Equal("\"noon\"", (await RequesterOf("ask")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Fact]
    public async Task Cancels_a_call_at_the_server_when_its_token_is_cancelled()
    {
        using var source = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var text = new TextSerializer();

        // a resolver of its own, which says it started and settles once its call is cancelled
        _server.Services.GetRequestResolver(Held, new RequestResolverDependencies<string, string> { Serializer = text })((request, _) =>
        {
            var stopped = new TaskCompletionSource();

            request.Signal.Register(() =>
            {
                cancelled.TrySetResult();
                stopped.TrySetResult();
            });
            entered.TrySetResult();

            return stopped.Task;
        });

        var held = _client.Services.GetRequest(Held, new RequestDependencies<string, string> { Serializer = text })("held")(new RequestOptions { CancellationToken = source.Token });

        // ! cancelled once its resolver started, as the TypeScript twin waits: a cancel that comes
        // before its turn starts none, and cancels nothing it would hear
        await entered.Task.WaitAsync(Patience, Cancelled);
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return held.WaitAsync(Patience, Cancelled);
        });
        await cancelled.Task.WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Takes_its_layers_apart_in_reverse_rejecting_what_waits_as_disposed_then_closing()
    {
        var sent = RequestSent();
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();
        var errors = new ConcurrentQueue<Exception>();
        var closed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        _client.Router.Error += errors.Enqueue;
        _client.Transport.Close += (wasClean, _) =>
        {
            closed.TrySetResult(wasClean);
        };
        await sent;
        await _client.DisposeAsync();
        Assert.Equal("the router was disposed before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.True(await closed.Task.WaitAsync(Patience, Cancelled));
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Rejects_what_waits_once_the_server_stops()
    {
        var sent = RequestSent();
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();
        var closed = new TaskCompletionSource<bool>();

        _client.Transport.Close += (wasClean, _) =>
        {
            closed.TrySetResult(wasClean);
        };
        await sent;
        await _transport.Stop();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        });
        Assert.False(await closed.Task.WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Refuses_a_connect_while_open_and_a_message_limit_below_its_envelope_s()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return _client.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = _port, CancellationToken = Cancelled });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketClient(new WebSocketClientOptions { Transport = new WebSocketTransportClientOptions { MaximumMessageBytes = 64 } });
        });
    }

    [Fact]
    public async Task Takes_a_message_of_an_envelope_at_most_more_when_the_transport_says_so_and_never_less()
    {
        var limits = new RouterLimits { ChunkBytes = 128, MaximumEnvelopeBytes = 256, WindowBytes = 256 };
        await using var byDefault = new WebSocketClient(new WebSocketClientOptions { Limits = limits });
        await using var more = new WebSocketClient(new WebSocketClientOptions { Limits = limits, Transport = new WebSocketTransportClientOptions { MaximumMessageBytes = 257 } });

        Assert.Equal((RouterLimits.Default.MaximumEnvelopeBytes, 256, 257), (_client.Transport.MaximumMessageBytes, byDefault.Transport.MaximumMessageBytes, more.Transport.MaximumMessageBytes));
        Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketClient(new WebSocketClientOptions { Limits = limits, Transport = new WebSocketTransportClientOptions { MaximumMessageBytes = 255 } });
        });
    }

    [Fact]
    public async Task Connects_disconnects_and_reconnects_through_its_transport_with_the_options_given()
    {
        var closes = Channel.CreateUnbounded<(bool WasClean, bool WasQuick)>();
        using var cancelled = new CancellationTokenSource();

        _client.Transport.Close += (wasClean, wasQuick) =>
        {
            closes.Writer.TryWrite((wasClean, wasQuick));
        };
        await _client.Disconnect(new TransportClientDisconnectOptions { IsClean = false }).WaitAsync(Patience, Cancelled);

        Assert.Equal((false, false), await closes.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal(ReadyState.Closed, _client.Transport.ReadyState);

        // the token given reaches the transport, which refuses to start
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Reconnect(new TransportClientReconnectOptions { CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Closed, _client.Transport.ReadyState);

        await _client.Reconnect(new TransportClientReconnectOptions { MaximumAttempts = 1 }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, _client.Transport.ReadyState);
        Assert.Same(_client.Transport, _client.Router.Transport);
        Assert.Equal("{\"a\":1}", (await RequesterOf("echo")(JsonOf("{\"a\":1}"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Fact]
    public async Task A_dispose_cancels_a_reconnection_under_way_and_a_token_given_still_cancels_it_too()
    {
        await using var other = new WebSocketClient();
        using var source = new CancellationTokenSource();
        var waiting = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();
        var reconnecting = new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromMinutes(1)),
            Tap = (delay, attempt) =>
            {
                waiting.Writer.TryWrite((delay, attempt));
            },
        };

        await other.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = _port, CancellationToken = Cancelled });
        var closed = Channel.CreateUnbounded<bool>();

        _client.Transport.Close += (_, _) =>
        {
            closed.Writer.TryWrite(true);
        };
        other.Transport.Close += (_, _) =>
        {
            closed.Writer.TryWrite(true);
        };
        await _transport.Stop().WaitAsync(Patience, Cancelled);
        for (var index = 0; index < 2; index++)
        {
            Assert.True(await closed.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        }

        using var refused = new ClosedPort();

        foreach (var subject in new[] { _client, other })
        {
            await Assert.ThrowsAsync<System.Net.WebSockets.WebSocketException>(() =>
            {
                return subject.Connect(new WebSocketTransportClientConnectOptions { Host = "127.0.0.1", Port = refused.Port, CancellationToken = Cancelled });
            });
        }

        var byDispose = _client.Reconnect(reconnecting);
        var byToken = other.Reconnect(reconnecting with { CancellationToken = source.Token });

        for (var index = 0; index < 2; index++)
        {
            Assert.Equal((TimeSpan.FromMinutes(1), 1), await waiting.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        }

        await _client.DisposeAsync();
        await source.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return byDispose.WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return byToken.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, _client.Transport.ReadyState);
        Assert.Equal(ReadyState.Closed, other.Transport.ReadyState);
    }

    [Fact]
    public async Task Rejects_what_waits_as_replaced_once_its_transport_reconnects()
    {
        // only this side's router hears the transport's reconnect through its interface, the
        // transport's own name being the method's: this pins that the two meet
        var sent = RequestSent();
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();

        await sent;
        await _client.Reconnect().WaitAsync(Patience, Cancelled);

        Assert.Equal("the connection was replaced before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, _client.Transport.ReadyState);
        Assert.Equal("{\"a\":1}", (await RequesterOf("echo")(JsonOf("{\"a\":1}"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    // debugging 9.7
    [Fact]
    public async Task Fails_a_call_before_it_connects_by_its_ready_state_sending_nothing()
    {
        await using var unconnected = new WebSocketClient();
        var received = RequestsReceived();

        var refused = await Assert.ThrowsAsync<ReadyStateException>(() =>
        {
            return unconnected.Services.GetRequest(
                InteropProcedures.Echo.Procedure,
                new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() })(JsonOf("null"))()
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ReadyState.Uninitialized, ReadyState.Open), (refused.Got, refused.Expected));
        Assert.Empty(received);
    }

    // debugging 9.7
    [Fact]
    public async Task Fails_a_call_once_disconnected_as_a_disconnection_sending_nothing()
    {
        var received = RequestsReceived();

        await _client.Transport.CloseConnection().WaitAsync(Patience, Cancelled);

        Assert.Equal("the transport client is closed, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return RequesterOf("echo")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Empty(received);
    }

    // each request the server's router reads
    private ConcurrentQueue<uint> RequestsReceived()
    {
        var received = new ConcurrentQueue<uint>();

        _server.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Rx && envelope.Header is RequestHeader request)
            {
                received.Enqueue(request.CallId);
            }
        };

        return received;
    }

    [Fact]
    public async Task Builds_its_router_with_the_limits_given()
    {
        await using var client = new WebSocketClient(new WebSocketClientOptions
        {
            Limits = new RouterLimits { MaximumPayloadBytes = 8 },
        });
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Services.GetRequest(
                InteropProcedures.Echo.Procedure,
                new RequestDependencies<string, string> { Serializer = new TextSerializer() })("much too long")()
                .WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("a payload is 8 bytes at most, not 13", refused.Detail);
    }

    private sealed class TextSerializer : INotificationSerializerClient<string, string, string>, IRequestSerializerServer<string, string>
    {
        public ReadOnlyMemory<byte> Encode(string request)
        {
            return System.Text.Encoding.UTF8.GetBytes(request);
        }

        public string Decode(ReadOnlyMemory<byte> response)
        {
            return System.Text.Encoding.UTF8.GetString(response.Span);
        }

        public string DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return Decode(notification);
        }
    }
}
