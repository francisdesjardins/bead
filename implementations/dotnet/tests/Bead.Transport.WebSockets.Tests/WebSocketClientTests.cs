using System.Text.Json;
using System.Threading.Channels;
using Bead.Interop;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// <see cref="WebSocketClient"/>, the transport, the router and the services together, against a
/// server of the interop service on Kestrel: the C# side talking to itself over a socket.
/// </summary>
public sealed class WebSocketClientTests : IAsyncLifetime
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly WebSocketTransportServer _transport = new();
    private readonly Server<string> _server;
    private WebSocketClient _client = new();
    private int _port;

    public WebSocketClientTests()
    {
        _server = new Server<string>(_transport);
        InteropService.Offer(_server);
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

    private Func<JsonElement, Requester<JsonElement>> RequesterOf(string procedureName)
    {
        return _client.Services.GetRequest(
            InteropService.ProcedureOf(procedureName),
            new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked });
    }

    // definition

    public async ValueTask InitializeAsync()
    {
        _port = (await _transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled)).Port;
        await _client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = _port }, Cancelled);
    }

    public async ValueTask DisposeAsync()
    {
        await _client.DisposeAsync();
        await _server.DisposeAsync();
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
        InteropService.OfferClient(_client.Services);

        Assert.Equal("\"noon\"", (await RequesterOf("ask")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Fact]
    public async Task Cancels_a_call_at_the_server_when_its_token_is_cancelled()
    {
        using var source = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { CancellationToken = source.Token })
                .WaitAsync(Patience, Cancelled);
        });

        // the server counts it once its resolver heard the cancel, which comes after the cancel itself
        var counted = 0;

        for (var tries = 0; tries < 40 && counted != 1; tries += 1)
        {
            counted = (await RequesterOf("cancellations")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetInt32();
            await Task.Delay(50, Cancelled);
        }

        Assert.Equal(1, counted);
    }

    [Fact]
    public async Task Takes_its_layers_apart_in_reverse_rejecting_what_waits_as_disposed_then_closing()
    {
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();
        var errors = new List<Exception>();
        var closed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        _client.Router.Error += errors.Add;
        _client.Transport.Close += (wasClean, _) =>
        {
            closed.TrySetResult(wasClean);
        };
        await Task.Delay(100, Cancelled);
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
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();
        var closed = new TaskCompletionSource<bool>();

        _client.Transport.Close += (wasClean, _) =>
        {
            closed.TrySetResult(wasClean);
        };
        await Task.Delay(100, Cancelled);
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
            return _client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = _port }, Cancelled);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new WebSocketClient(new WebSocketClientOptions { Transport = new WebSocketTransportClientOptions { MaximumMessageBytes = 64 } });
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
        await _client.Disconnect(new TransportDisconnectOptions { IsClean = false }).WaitAsync(Patience, Cancelled);

        Assert.Equal((false, false), await closes.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal(ReadyState.Closed, _client.Transport.ReadyState);

        // the token given reaches the transport, which refuses to start
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return _client.Reconnect(new TransportReconnectOptions { CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Closed, _client.Transport.ReadyState);

        await _client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1 }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, _client.Transport.ReadyState);
        Assert.Same(_client.Transport, _client.Router.Transport);
        Assert.Equal("{\"a\":1}", (await RequesterOf("echo")(JsonOf("{\"a\":1}"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Fact]
    public async Task A_dispose_cancels_a_reconnection_under_way_and_a_token_given_still_cancels_it_too()
    {
        await using var other = new WebSocketClient();
        using var source = new CancellationTokenSource();
        var reconnecting = new TransportReconnectOptions
        {
            Delay = (_, _) =>
            {
                return TimeSpan.FromMinutes(1);
            },
        };

        await other.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = _port }, Cancelled);
        // nothing listens any more: each attempt fails, then waits a minute
        await _transport.Stop().WaitAsync(Patience, Cancelled);

        var byDispose = _client.Reconnect(reconnecting);
        var byToken = other.Reconnect(reconnecting with { CancellationToken = source.Token });

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
        var slow = RequesterOf("slow")(JsonOf("{\"milliseconds\":3600000}"))();

        await Task.Delay(100, Cancelled);
        await _client.Reconnect().WaitAsync(Patience, Cancelled);

        Assert.Equal("the connection was replaced before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, _client.Transport.ReadyState);
        Assert.Equal("{\"a\":1}", (await RequesterOf("echo")(JsonOf("{\"a\":1}"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Fact]
    public async Task Fails_a_send_before_it_connects()
    {
        await using var unconnected = new WebSocketClient();

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return unconnected.Services.GetRequest(
                InteropService.ProcedureOf("echo"),
                new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked })(JsonOf("null"))()
                .WaitAsync(Patience, Cancelled);
        });
    }
}
