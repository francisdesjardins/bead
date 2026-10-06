using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="BeadHttpClient"/>: its layers on an HTTP transport, one envelope per exchange and no
/// transfer, against a handler of the tests' own, the TypeScript side's fake fetch.
/// </summary>
public sealed class BeadHttpClientTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly Procedure Echo = new() { ServiceId = 2, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 3 };

    private static readonly RequestDependencies<string, string> Text = new() { Serializer = new TextPayloads() };

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // the 201 that draws a connection, its token given
    private static HttpResponseMessage Drawn()
    {
        var drawn = new HttpResponseMessage(HttpStatusCode.Created);

        drawn.Headers.Add(HttpTransport.ConnectionTokenHeader, new string('T', 22));

        return drawn;
    }

    // a 200 of Bead's type, its length undeclared
    private static HttpResponseMessage AnswerOf(byte[] body)
    {
        var answer = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };

        answer.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);
        answer.Content.Headers.ContentLength = null;

        return answer;
    }

    // a server that draws the connection, answers each request with its payload in upper case, and
    // lets the connection go on its DELETE
    private static HttpResponseMessage Echoing((HttpMethod Method, byte[] Body) exchange)
    {
        if (exchange.Method == HttpMethod.Delete)
        {
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        }

        if (exchange.Body.Length == 0)
        {
            return Drawn();
        }

        var request = EnvelopeCodec.ReadEnvelope(exchange.Body, new EnvelopeReadOptions { Side = RouterSide.Server });

        if (request?.Kind != EnvelopeKind.Request)
        {
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        }

        return AnswerOf(EnvelopeCodec.WriteEnvelope(new Envelope
        {
            Header = new ResultHeader { CallId = request.Header.CallId },
            Payload = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(request.Payload.Span).ToUpperInvariant()),
        }));
    }

    // a client on the handler, which does not listen
    private static BeadHttpClient ClientOn(Fetch fetch)
    {
        return new BeadHttpClient(new BeadHttpClientOptions { Transport = new HttpTransportClientOptions { Handler = fetch, IsListening = false } });
    }

    // connected: its connect, which waits for its answer, drawn
    private static async Task Connect(BeadHttpClient client, Fetch fetch)
    {
        var connecting = client.Connect(new HttpConnectOptions { Host = "localhost", Port = 8_080 }, Cancelled);

        (await fetch.Next()).SetResult(Drawn());
        await connecting.WaitAsync(Patience, Cancelled);
    }

    /// <summary>UTF-8 text both ways.</summary>
    private sealed class TextPayloads : IRequestSerializerClient<string, string>
    {
        public ReadOnlyMemory<byte> Encode(string request)
        {
            return Encoding.UTF8.GetBytes(request);
        }

        public string Decode(ReadOnlyMemory<byte> response)
        {
            return Encoding.UTF8.GetString(response.Span);
        }
    }

    /// <summary>
    /// What a client's exchanges go through: each answered at once by <c>respond</c> when given,
    /// otherwise as its test says, but a DELETE, answered 204 at once.
    /// </summary>
    private sealed class Fetch(Func<(HttpMethod Method, byte[] Body), HttpResponseMessage>? respond = null) : HttpMessageHandler
    {
        private readonly Channel<TaskCompletionSource<HttpResponseMessage>> _waiting = Channel.CreateUnbounded<TaskCompletionSource<HttpResponseMessage>>();
        private readonly List<(string Method, string Uri)> _calls = [];

        public List<(string Method, string Uri)> Calls
        {
            get
            {
                lock (_calls)
                {
                    return [.. _calls];
                }
            }
        }

        // the next call that waits for its answer
        public async Task<TaskCompletionSource<HttpResponseMessage>> Next()
        {
            return await _waiting.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            using var body = new MemoryStream();

            request.Content?.ReadAsStream(cancellationToken).CopyTo(body);

            lock (_calls)
            {
                _calls.Add((request.Method.Method, request.RequestUri?.ToString() ?? ""));
            }

            if (respond is not null)
            {
                return Task.FromResult(respond((request.Method, body.ToArray())));
            }

            if (request.Method == HttpMethod.Delete)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
            }

            var answer = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);

            _waiting.Writer.TryWrite(answer);

            return answer.Task.WaitAsync(cancellationToken);
        }
    }

    // definition

    [Fact]
    public async Task Builds_on_an_HTTP_transport_with_the_fetch_it_is_given_one_envelope_per_exchange_and_no_transfer()
    {
        using var fetch = new Fetch(Echoing);
        await using var client = new BeadHttpClient(new BeadHttpClientOptions
        {
            Limits = RouterLimits.Default with { MaximumEnvelopeBytes = 4_096 },
            Transport = new HttpTransportClientOptions { Handler = fetch, IsListening = false },
        });

        await client.Connect(new HttpConnectOptions { Host = "localhost", Port = 8_080 }, Cancelled);

        Assert.Equal("HI", await client.Services.GetRequest(Echo, Text)("hi")().WaitAsync(Patience, Cancelled));

        var limits = client.Router.Limits;

        Assert.Equal((4_096, 4_096, 0, 8_192), (limits.ChunkBytes, limits.MaximumEnvelopeBytes, limits.MaximumTransfers, limits.WindowBytes));
        Assert.Equal([("POST", "http://localhost:8080/bead"), ("POST", "http://localhost:8080/bead")], fetch.Calls);
        await client.Disconnect().WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Runs_its_router_on_its_transport_s_clock_which_times_a_request_out()
    {
        var time = new FakeTimeProvider();
        using var fetch = new Fetch();
        await using var client = new BeadHttpClient(new BeadHttpClientOptions
        {
            Transport = new HttpTransportClientOptions { Clock = time, Handler = fetch, IsListening = false },
        });

        Assert.Equal((time, time), (client.Transport.Clock, client.Router.Clock));
        await Connect(client, fetch);

        var unanswered = client.Services.GetRequest(Echo, Text)("hi")(new RequestOptions { Timeout = TimeSpan.FromSeconds(1) });
        var exchange = await fetch.Next();

        time.Advance(TimeSpan.FromMilliseconds(999));

        Assert.False(unanswered.IsCompleted);

        time.Advance(TimeSpan.FromMilliseconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return unanswered.WaitAsync(Patience, Cancelled);
        });
        exchange.SetResult(new HttpResponseMessage(HttpStatusCode.NoContent));
    }

    [Fact]
    public async Task Each_client_is_an_IClient()
    {
        await using var client = new BeadHttpClient();

        var beadClient = Assert.IsAssignableFrom<IClient>(client);

        Assert.Same(client.Router, beadClient.Router);
        Assert.Same(client.Services, beadClient.Services);
    }

    [Fact]
    public async Task Builds_with_nothing_given_the_global_fetch_one_envelope_of_the_default_size_no_transfer()
    {
        await using var client = new BeadHttpClient();

        Assert.Equal((LimitDefaults.MaximumEnvelopeBytes, 0), (client.Router.Limits.MaximumEnvelopeBytes, client.Router.Limits.MaximumTransfers));
        Assert.Equal(ReadyState.Uninitialized, client.Transport.ReadyState);
    }

    [Fact]
    public async Task Reads_an_answer_no_larger_than_the_envelope_its_router_takes_and_closes_on_one_past_it()
    {
        using var fetch = new Fetch();
        await using var client = new BeadHttpClient(new BeadHttpClientOptions
        {
            Limits = RouterLimits.Default with { MaximumEnvelopeBytes = 1_024 },
            Transport = new HttpTransportClientOptions { Handler = fetch, IsListening = false },
        });
        var connecting = client.Connect(new HttpConnectOptions { Host = "localhost", Port = 8_080 }, Cancelled);

        (await fetch.Next()).SetResult(Drawn());
        await connecting.WaitAsync(Patience, Cancelled);

        var calling = client.Services.GetRequest(Echo, Text)("hi")();

        (await fetch.Next()).SetResult(AnswerOf(new byte[1_025]));

        Assert.Equal("the connection closed before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return calling.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Closed, client.Transport.ReadyState);
    }

    [Fact]
    public async Task Connects_disconnects_and_reconnects_through_its_transport_with_the_options_given()
    {
        var isDrawing = true;
        using var fetch = new Fetch((exchange) =>
        {
            // a connect, while the server is told to draw none, is refused
            if (!isDrawing && exchange.Method == HttpMethod.Post && exchange.Body.Length == 0)
            {
                return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            }

            return Echoing(exchange);
        });
        await using var client = ClientOn(fetch);
        var closes = Channel.CreateUnbounded<(bool WasClean, bool WasQuick)>();
        using var cancelled = new CancellationTokenSource();

        client.Transport.Close += (wasClean, wasQuick) =>
        {
            closes.Writer.TryWrite((wasClean, wasQuick));
        };
        await client.Connect(new HttpConnectOptions { Host = "localhost", Port = 8_080 }, Cancelled);
        await client.Disconnect(new TransportDisconnectOptions { IsClean = false }).WaitAsync(Patience, Cancelled);

        Assert.Equal((false, false), await closes.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        Assert.Equal(ReadyState.Closed, client.Transport.ReadyState);

        // the token given reaches the transport, which refuses to start
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportReconnectOptions { CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Closed, client.Transport.ReadyState);

        // and so do the attempts and the waits given
        isDrawing = false;

        Assert.Equal("attempt 2 reached", (await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return client.Reconnect(new TransportReconnectOptions
            {
                Delay = (_, _) =>
                {
                    return TimeSpan.Zero;
                },
                MaximumAttempts = 2,
            }).WaitAsync(Patience, Cancelled);
        })).Message);

        isDrawing = true;
        await client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1 }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.Transport.ReadyState);
        Assert.Same(client.Transport, client.Router.Transport);
        Assert.Equal("HI", await client.Services.GetRequest(Echo, Text)("hi")().WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task A_dispose_cancels_a_reconnection_under_way_and_a_token_given_still_cancels_it_too()
    {
        using var fetch = new Fetch();
        await using var client = ClientOn(fetch);
        await using var other = ClientOn(fetch);
        using var source = new CancellationTokenSource();

        await Connect(client, fetch);
        await Connect(other, fetch);

        var byDispose = client.Reconnect();
        var byToken = other.Reconnect(new TransportReconnectOptions { CancellationToken = source.Token });

        // each attempt under way, which the server never answers
        await fetch.Next();
        await fetch.Next();
        await client.DisposeAsync();
        await source.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return byDispose.WaitAsync(Patience, Cancelled);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return byToken.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, client.Transport.ReadyState);
        Assert.Equal(ReadyState.Closed, other.Transport.ReadyState);
    }

    [Fact]
    public async Task Rejects_what_waits_as_replaced_once_its_transport_reconnects()
    {
        // only this side's router hears the transport's reconnect through its interface, the
        // transport's own name being the method's: this pins that the two meet
        using var fetch = new Fetch();
        await using var client = ClientOn(fetch);

        await Connect(client, fetch);

        var calling = client.Services.GetRequest(Echo, Text)("hi")();

        // its exchange held, never answered
        await fetch.Next();

        var reconnecting = client.Reconnect();

        (await fetch.Next()).SetResult(Drawn());
        await reconnecting.WaitAsync(Patience, Cancelled);

        Assert.Equal("the connection was replaced before the answer", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return calling.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, client.Transport.ReadyState);
    }
}
