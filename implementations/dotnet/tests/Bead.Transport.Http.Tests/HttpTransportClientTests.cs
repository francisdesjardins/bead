using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Threading.Channels;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="HttpTransportClient"/>, against a transport server on Kestrel and against a handler of
/// the tests' own, the TypeScript side's fake fetch, which answers each exchange as its test says:
/// how it draws its connection, settles its sends, closes, and listens.
/// </summary>
public sealed class HttpTransportClientTests
{
    // constants

    private const string Host = "127.0.0.1";

    // a bearer credential, RFC 6750's own example, its auth-scheme included
    private const string Bearer = "Bearer mF_9.B5f-4.1JqM";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan Millisecond = TimeSpan.FromMilliseconds(1);

    // the whole of each wait after a listen lost, in seconds, from the second loss on
    private static readonly int[] WholeRetries = [1, 2, 4, 8, 16, 30, 30, 30];

    private static readonly string Token = new('T', 22);

    private static readonly HttpTransportClientOptions NotListening = new() { IsListening = false };

    private static readonly IReadOnlyDictionary<string, string> Bead = new Dictionary<string, string>
    {
        ["content-type"] = HttpTransport.MediaType,
    };

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static async Task<T> Next<T>(Channel<T> channel)
    {
        return await channel.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
    }

    private static async Task Eventually(Func<bool> condition)
    {
        for (var tries = 0; tries < 500 && !condition(); tries += 1)
        {
            await Task.Delay(10, Cancelled);
        }

        Assert.True(condition());
    }

    // each close the client raises, in order
    private static Channel<(bool WasClean, bool WasQuick)> ClosesOf(HttpTransportClient client)
    {
        var closes = Channel.CreateUnbounded<(bool, bool)>();

        client.Close += (wasClean, wasQuick) =>
        {
            closes.Writer.TryWrite((wasClean, wasQuick));
        };

        return closes;
    }

    // an envelope as the transports read it: its layout, its kind, its call id, and extra bytes
    private static byte[] EnvelopeOf(EnvelopeKind kind, (uint CallId, int Extra) shape)
    {
        var bytes = new byte[8 + shape.Extra];

        Array.Fill(bytes, (byte)3);
        bytes[0] = 0xa1;
        bytes[1] = (byte)kind;
        BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(4), shape.CallId);

        return bytes;
    }

    // what a listen brings back of the envelopes: each after its length in 4 bytes
    private static byte[] BatchOf(params byte[][] envelopes)
    {
        return [.. envelopes.SelectMany((envelope) =>
        {
            var length = new byte[4];

            BinaryPrimitives.WriteUInt32BigEndian(length, (uint)envelope.Length);

            return length.Concat(envelope);
        })];
    }

    // a batch of the envelopes, the first numbered `first`
    private static Answer Batch(int first, params byte[][] envelopes)
    {
        return new Answer
        {
            Status = 200,
            Body = BatchOf(envelopes),
            Headers = new Dictionary<string, string>
            {
                ["content-type"] = HttpTransport.BatchMediaType,
                [HttpTransport.SequenceHeader] = first.ToString(CultureInfo.InvariantCulture),
            },
        };
    }

    // the 201 that draws a connection, its token given, its listen said back when told
    private static Answer DrawnOf(bool isListening)
    {
        var headers = new Dictionary<string, string> { [HttpTransport.ConnectionTokenHeader] = Token };

        if (isListening)
        {
            headers[HttpTransport.ListenHeader] = "?1";
        }

        return new Answer { Status = 201, Headers = headers };
    }

    // a refusal the transport marks
    private static Answer RefusalOf(int status, string refusal)
    {
        return new Answer { Status = status, Headers = new Dictionary<string, string> { [HttpTransport.RefusalHeader] = refusal } };
    }

    // a client that listens, its waits on a clock of the test's own
    private static HttpTransportClientOptions ListeningOn(FakeTimeProvider time)
    {
        return new HttpTransportClientOptions { Clock = time };
    }

    // a client on a scripted handler, connected: its first call drew the connection, the listen said
    // back when it listens
    private static async Task<Faked> ConnectFake(HttpTransportClientOptions options, Fetch? given = null)
    {
        var fetch = given ?? new Fetch();
        var faked = new Faked(new HttpTransportClient(options with { Handler = fetch }), fetch);
        var connecting = faked.Client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);

        if (!fetch.IsResponding)
        {
            (await fetch.CallOf(0)).Answer(DrawnOf(options.IsListening));
        }

        await connecting.WaitAsync(Patience, Cancelled);

        return faked;
    }

    // a client on a scripted handler whose connect drew nothing: it failed, ending Closed, and its
    // target is the one a reconnection takes
    private static async Task<Faked> ConnectRefused(HttpTransportClientOptions options)
    {
        var fetch = new Fetch();
        var faked = new Faked(new HttpTransportClient(options with { Handler = fetch }), fetch);
        var connecting = faked.Client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);

        (await fetch.CallOf(0)).Answer(new Answer { Status = 503 });
        await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });

        return faked;
    }

    // the same wait after every failed attempt
    private static TransportReconnectDelay DelayOf(TimeSpan delay)
    {
        return (_, _) =>
        {
            return delay;
        };
    }

    // a handler on which every listen is lost: it draws a listening connection, and takes its DELETE
    private static Fetch LosingFetch()
    {
        return new Fetch((call) =>
        {
            if (call.Method == HttpMethod.Get)
            {
                throw new HttpRequestException("fetch failed");
            }

            return call.Method == HttpMethod.Post ? DrawnOf(true) : new Answer { Status = 204 };
        });
    }

    // how many listens a handler took
    private static int ListensOf(Fetch fetch)
    {
        return fetch.Calls.Count((call) =>
        {
            return call.Method == HttpMethod.Get;
        });
    }

    // how long the client waited before it listened again past `made` calls: the clock moved a
    // millisecond at a time until it did
    private static TimeSpan WaitedFor((Fetch Fetch, int Made) listening, FakeTimeProvider time)
    {
        var waited = TimeSpan.Zero;

        while (listening.Fetch.Count == listening.Made && waited < TimeSpan.FromMinutes(1))
        {
            time.Advance(Millisecond);
            waited += Millisecond;
        }

        return waited;
    }

    /// <summary>What a scripted exchange answers: the TypeScript side's fake response.</summary>
    private sealed record Answer
    {
        public required int Status { get; init; }

        public IReadOnlyDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();

        public byte[] Body { get; init; } = [];

        // none at all, as a 204's
        public bool IsBodiless { get; init; }

        // its body never comes whole: reading it fails
        public bool IsBodyLost { get; init; }

        // its body, once this settles: the head comes first
        public Task<byte[]>? Later { get; init; }

        // its body as a stream reads it, a piece each read, then cut by `Cut` when given
        public IReadOnlyList<byte[]>? Pieces { get; init; }

        public Exception? Cut { get; init; }

        // settled once its body is read at all
        public TaskCompletionSource? Read { get; init; }

        public HttpResponseMessage ResponseOf()
        {
            var response = new HttpResponseMessage((HttpStatusCode)Status);

            if (!IsBodiless && Status != 204)
            {
                response.Content = new ScriptedBody(this);
            }

            foreach (var (name, value) in Headers)
            {
                if (name is "content-type" or "content-length")
                {
                    response.Content.Headers.TryAddWithoutValidation(name, value);
                }
                else
                {
                    response.Headers.TryAddWithoutValidation(name, value);
                }
            }

            return response;
        }
    }

    /// <summary>A scripted body, of no length unless its headers declare one.</summary>
    private sealed class ScriptedBody(Answer answer) : HttpContent
    {
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            await using var pieces = await CreateContentReadStreamAsync();

            await pieces.CopyToAsync(stream);
        }

        protected override Task<Stream> CreateContentReadStreamAsync()
        {
            answer.Read?.TrySetResult();

            return Task.FromResult<Stream>(new PieceStream(answer));
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;

            return false;
        }
    }

    /// <summary>A scripted body as it is read: a piece each read, whatever was asked.</summary>
    private sealed class PieceStream(Answer answer) : Stream
    {
        private Queue<byte[]>? _queue;
        private ReadOnlyMemory<byte> _rest;

        public override bool CanRead
        {
            get
            {
                return true;
            }
        }

        public override bool CanSeek
        {
            get
            {
                return false;
            }
        }

        public override bool CanWrite
        {
            get
            {
                return false;
            }
        }

        public override long Length
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public override long Position
        {
            get
            {
                throw new NotSupportedException();
            }

            set
            {
                throw new NotSupportedException();
            }
        }

        // what came already is read whatever the token says, as a socket's buffer is
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (answer.IsBodyLost)
            {
                throw new IOException("terminated");
            }

            if (_rest.IsEmpty)
            {
                _queue ??= new Queue<byte[]>(answer.Pieces ?? [await (answer.Later ?? Task.FromResult(answer.Body)).WaitAsync(cancellationToken)]);

                if (!_queue.TryDequeue(out var piece))
                {
                    return answer.Cut is { } cut ? throw cut : 0;
                }

                _rest = piece;
            }

            var taken = Math.Min(buffer.Length, _rest.Length);

            _rest[..taken].CopyTo(buffer);
            _rest = _rest[taken..];

            return taken;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }
    }

    /// <summary>One exchange a client made, as the handler took it, and answered as its test says.</summary>
    private sealed class Call
    {
        // continuations inline: an answer is heard as it is given
        private readonly TaskCompletionSource<HttpResponseMessage> _answered = new();
        private readonly CancellationToken _token;

        public Call(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Uri = request.RequestUri?.ToString() ?? "";
            ConnectionToken = HeaderOf(request, HttpTransport.ConnectionTokenHeader);
            Listen = HeaderOf(request, HttpTransport.ListenHeader);
            Authorization = HeaderOf(request, "Authorization");
            _token = cancellationToken;

            if (request.Content is { } content)
            {
                using var stream = content.ReadAsStream(cancellationToken);
                using var copy = new MemoryStream();

                stream.CopyTo(copy);
                Body = copy.ToArray();
            }
        }

        public HttpMethod Method { get; }

        public string Uri { get; }

        public string? ConnectionToken { get; }

        public string? Listen { get; }

        public string? Authorization { get; }

        public byte[]? Body { get; }

        // its exchange was aborted
        public bool IsAborted
        {
            get
            {
                return _token.IsCancellationRequested;
            }
        }

        public Task<HttpResponseMessage> Answered
        {
            get
            {
                return _answered.Task;
            }
        }

        public void Answer(Answer answer)
        {
            _answered.TrySetResult(answer.ResponseOf());
        }

        // as a network that failed
        public void Fail(Exception? reason = null)
        {
            _answered.TrySetException(reason ?? new HttpRequestException("fetch failed"));
        }

        private static string? HeaderOf(HttpRequestMessage request, string name)
        {
            return request.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;
        }
    }

    /// <summary>
    /// What a client's exchanges go through: the TypeScript side's fake fetch. Each call waits for
    /// the answer its test gives, or for its token, but a DELETE, answered 204 at once unless held;
    /// one built with <c>respond</c> answers each call at once.
    /// </summary>
    private sealed class Fetch(Func<Call, Answer>? respond = null) : HttpMessageHandler
    {
        private readonly List<Call> _calls = [];
        private readonly List<TaskCompletionSource<Call>> _made = [];

        // a DELETE waits for its answer, as any other call
        public bool IsDeleteHeld { get; init; }

        // what a call is answered with comes back even once its token was cancelled, as a response
        // read before the cancel came
        public bool IsDeaf { get; init; }

        public bool IsResponding
        {
            get
            {
                return respond is not null;
            }
        }

        public IReadOnlyList<Call> Calls
        {
            get
            {
                lock (_calls)
                {
                    return [.. _calls];
                }
            }
        }

        public int Count
        {
            get
            {
                lock (_calls)
                {
                    return _calls.Count;
                }
            }
        }

        // the call of rank `index`, once made
        public Task<Call> CallOf(int index)
        {
            lock (_calls)
            {
                return MadeOf(index).Task.WaitAsync(Patience, Cancelled);
            }
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var call = new Call(request, cancellationToken);

            lock (_calls)
            {
                _calls.Add(call);
                MadeOf(_calls.Count - 1).TrySetResult(call);
            }

            if (respond is not null)
            {
                try
                {
                    return Task.FromResult(respond(call).ResponseOf());
                }
                catch (HttpRequestException reason)
                {
                    return Task.FromException<HttpResponseMessage>(reason);
                }
            }

            if (call.Method == HttpMethod.Delete && !IsDeleteHeld)
            {
                call.Answer(new Answer { Status = 204 });
            }

            return IsDeaf ? call.Answered : call.Answered.WaitAsync(cancellationToken);
        }

        protected override void Dispose(bool disposing)
        {
            foreach (var call in Calls)
            {
                call.Fail(new ObjectDisposedException(nameof(Fetch)));
            }

            base.Dispose(disposing);
        }

        private TaskCompletionSource<Call> MadeOf(int index)
        {
            while (_made.Count <= index)
            {
                _made.Add(new TaskCompletionSource<Call>(TaskCreationOptions.RunContinuationsAsynchronously));
            }

            return _made[index];
        }
    }

    /// <summary>A client on a scripted handler: what it heard, and how it closed.</summary>
    private sealed class Faked : IAsyncDisposable
    {
        private readonly List<byte[]> _heard = [];

        public Faked(HttpTransportClient client, Fetch fetch)
        {
            Client = client;
            Fetch = fetch;
            Closes = ClosesOf(client);
            client.Message += (message) =>
            {
                lock (_heard)
                {
                    _heard.Add(message.Bytes.ToArray());
                }
            };
        }

        public HttpTransportClient Client { get; }

        public Fetch Fetch { get; }

        public Channel<(bool WasClean, bool WasQuick)> Closes { get; }

        public List<byte[]> Heard
        {
            get
            {
                lock (_heard)
                {
                    return [.. _heard];
                }
            }
        }

        public Task<(bool WasClean, bool WasQuick)> Closed()
        {
            return Next(Closes);
        }

        public async ValueTask DisposeAsync()
        {
            await Client.DisposeAsync();
            Fetch.Dispose();
        }
    }

    /// <summary>A transport server on a free port, and the connections it drew and closed, in order.</summary>
    private sealed class Started : IAsyncDisposable
    {
        private Started()
        {
            Server.Connection += (connectionHandle) =>
            {
                Connections.Writer.TryWrite(connectionHandle);
            };
            Server.Close += (wasClean, connectionHandle) =>
            {
                Closes.Writer.TryWrite((wasClean, connectionHandle));
            };
        }

        public HttpTransportServer Server { get; } = new();

        public int Port { get; private set; }

        public Channel<string> Connections { get; } = Channel.CreateUnbounded<string>();

        public Channel<(bool WasClean, string ConnectionHandle)> Closes { get; } = Channel.CreateUnbounded<(bool, string)>();

        public static async Task<Started> Start()
        {
            var started = new Started();

            started.Port = (await started.Server.Start(new HttpTransportStartOptions { Address = Host, FindOpenPort = true }, Cancelled)).Port;

            return started;
        }

        public HttpConnectOptions Target()
        {
            return new HttpConnectOptions { Host = Host, Port = Port };
        }

        public ValueTask DisposeAsync()
        {
            return Server.DisposeAsync();
        }
    }

    /// <summary>
    /// The test's clock, whose timers end a millisecond before their due time, as a timer can against
    /// a clock read on a loaded machine; one never due stays so.
    /// </summary>
    private sealed class HastyTime(TimeProvider time) : TimeProvider
    {
        public override long TimestampFrequency
        {
            get
            {
                return time.TimestampFrequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            return time.GetUtcNow();
        }

        public override long GetTimestamp()
        {
            return time.GetTimestamp();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            return time.CreateTimer(callback, state, dueTime > TimeSpan.Zero ? dueTime - Millisecond : dueTime, period);
        }
    }

    /// <summary>
    /// The test's timers, each ending when due, on a clock read apart from them: one that leaps an
    /// hour at each reading, as a machine woken from sleep or a clock set moves, or one that stands
    /// still.
    /// </summary>
    private sealed class WaywardTime(TimeProvider time, bool isLeaping) : TimeProvider
    {
        private readonly DateTimeOffset _stood = time.GetUtcNow();
        private long _readings;

        public override long TimestampFrequency
        {
            get
            {
                return time.TimestampFrequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            if (!isLeaping)
            {
                return _stood;
            }

            return time.GetUtcNow() + TimeSpan.FromHours(Interlocked.Increment(ref _readings));
        }

        public override long GetTimestamp()
        {
            return time.GetTimestamp();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            return time.CreateTimer(callback, state, dueTime, period);
        }
    }

    // definition

    [Theory]
    [InlineData("http://bead.example", false)]
    [InlineData("https://bead.example", true)]
    [InlineData("http://localhost", true)]
    [InlineData("http://127.0.0.1", true)]
    [InlineData("http://[::1]", true)]
    public async Task Carries_a_credential_beside_an_envelope_in_its_POST_s_Authorization_and_is_secure_under_https_or_to_a_loopback_host_judged_by_the_URL_it_was_given(string url, bool isSecure)
    {
        var target = new Uri(url);
        var (host, isTls) = (target.Host.Trim('[', ']'), target.Scheme == "https");
        var fetch = new Fetch();

        await using var faked = new Faked(new HttpTransportClient(NotListening with { Handler = fetch }), fetch);

        // judged from what it connects with, before its first connect from nothing
        Assert.Equal((true, false), (faked.Client.CarriesCredential, faked.Client.IsSecure));

        var connecting = faked.Client.Connect(new HttpConnectOptions { Host = host, Port = 8_080, Secured = isTls }, Cancelled);

        (await fetch.CallOf(0)).Answer(DrawnOf(false));
        await connecting.WaitAsync(Patience, Cancelled);
        Assert.Equal((true, isSecure), (faked.Client.CarriesCredential, faked.Client.IsSecure));
    }

    [Fact]
    public async Task Draws_its_connection_sends_an_envelope_settled_on_the_head_of_its_answer_and_hears_the_answer_as_a_message()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        var heard = Channel.CreateUnbounded<byte[]>();

        client.Message += (message) =>
        {
            heard.Writer.TryWrite(message.Bytes.ToArray());
        };
        await client.Connect(started.Target(), Cancelled);

        var connectionHandle = await Next(started.Connections);

        Assert.Equal(ReadyState.Open, client.ReadyState);

        // settled once the server has it, before any answer
        await client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false)).WaitAsync(Patience, Cancelled);

        Assert.True(heard.Reader.Count == 0);

        await started.Server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, (1, 2)), false), connectionHandle).WaitAsync(Patience, Cancelled);

        Assert.Equal(EnvelopeOf(EnvelopeKind.Result, (1, 2)), await Next(heard));

        // a cancel ends empty: nothing is heard
        await client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Cancel, (1, 0)), false)).WaitAsync(Patience, Cancelled);
        await client.CloseConnection().WaitAsync(Patience, Cancelled);

        Assert.True(heard.Reader.Count == 0);
    }

    [Fact]
    public async Task Rejects_an_exchange_the_server_refused_nothing_tried_and_stays_open()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);

        await client.Connect(started.Target(), Cancelled);

        // a request on the server's own parity
        Assert.Equal("the server refused the exchange: 400 malformed", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (2, 0)), false)).WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        await client.CloseConnection().WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Carries_its_credential_in_the_Authorization_of_its_POST_which_the_server_hands_on_with_the_request_and_hears_the_answer_with_none()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        var taken = Channel.CreateUnbounded<string?>();
        var heard = Channel.CreateUnbounded<TransportMessage>();

        started.Server.Message += (message, connectionHandle) =>
        {
            taken.Writer.TryWrite(message.Credential);
            _ = started.Server.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Result, (1, 0)), false) { Credential = Bearer }, connectionHandle);
        };
        client.Message += (message) =>
        {
            heard.Writer.TryWrite(message);
        };
        await client.Connect(started.Target(), Cancelled);
        await client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false) { Credential = Bearer }).WaitAsync(Patience, Cancelled);

        Assert.Equal((Bearer, (string?)null), (await Next(taken), (await Next(heard)).Credential));
        await client.CloseConnection().WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Writes_Authorization_only_with_a_credential_and_refuses_one_no_field_carries_before_it_goes_its_connection_kept()
    {
        await using var faked = await ConnectFake(NotListening);
        var carrying = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false) { Credential = Bearer });

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 204 });
        await carrying.WaitAsync(Patience, Cancelled);

        var bare = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Cancel, (1, 0)), false));

        (await faked.Fetch.CallOf(2)).Answer(new Answer { Status = 204 });
        await bare.WaitAsync(Patience, Cancelled);

        Assert.Equal((Bearer, (string?)null), (faked.Fetch.Calls[1].Authorization, faked.Fetch.Calls[2].Authorization));

        foreach (var credential in new[] { "Bearer a\r\nb", "Bearer é", "Bearer \0" })
        {
            Assert.StartsWith("a credential holds visible ASCII, spaces and tabs alone", (await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (3, 0)), false) { Credential = credential });
            })).Message, StringComparison.Ordinal);
        }

        Assert.Equal((3, ReadyState.Open), (faked.Fetch.Calls.Count, faked.Client.ReadyState));
    }

    [Fact]
    public async Task Disconnects_by_a_DELETE_the_server_closing_first_and_closes_clean()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        var closes = ClosesOf(client);

        await client.Connect(started.Target(), Cancelled);

        var connectionHandle = await Next(started.Connections);

        await client.CloseConnection(new TransportDisconnectOptions { IsClean = true }).WaitAsync(Patience, Cancelled);

        Assert.Equal((true, false), await Next(closes));
        // closed at the server before the DELETE was answered
        Assert.True(started.Closes.Reader.TryRead(out var closed));
        Assert.Equal((true, connectionHandle), closed);
        Assert.True(started.Closes.Reader.Count == 0);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.CloseConnection();
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Send(new TransportMessage(new byte[8], false));
        });
    }

    [Fact]
    public async Task Closes_once_the_server_says_the_connection_is_gone_after_rejecting_the_exchange_that_learned_it()
    {
        await using var faked = await ConnectFake(NotListening);
        var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));
        var closed = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        // where the TypeScript side's caller hears the rejection before the close, a caller here
        // resumes on a thread of its own: what holds is that the send is rejected when the close
        // is told. The answer comes once the send is held, so the close always finds it.
        faked.Client.Close += (wasClean, wasQuick) =>
        {
            closed.TrySetResult($"close [{wasClean},{wasQuick}], the send {(sending.IsFaulted ? "rejected" : "not yet rejected")}");
        };
        (await faked.Fetch.CallOf(1)).Answer(RefusalOf(404, HttpRefusals.ConnectionUnknown));

        var rejected = await Assert.ThrowsAsync<IOException>(() =>
        {
            return sending.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the server refused the exchange: 404 connection-unknown", rejected.Message);
        Assert.Equal("close [False,False], the send rejected", await closed.Task.WaitAsync(Patience, Cancelled));
        Assert.Equal(ReadyState.Closed, faked.Client.ReadyState);
    }

    [Fact]
    public async Task Closes_and_tells_the_server_when_the_server_is_lost_under_an_exchange_which_counts_as_handed_over()
    {
        await using var faked = await ConnectFake(NotListening);
        var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(1)).Fail();

        await sending.WaitAsync(Patience, Cancelled);
        Assert.Equal((false, false), await faked.Closed());
        Assert.Equal(
            new (string, string?)[] { ("POST", null), ("POST", Token), ("DELETE", Token) },
            faked.Fetch.Calls.Select((call) =>
            {
                return (call.Method.Method, call.ConnectionToken);
            }));
    }

    [Fact]
    public async Task Counts_a_status_nothing_marked_a_gateway_s_a_proxy_s_as_an_exchange_lost_which_may_have_run()
    {
        foreach (var status in new[] { 404, 502, 504 })
        {
            await using var faked = await ConnectFake(NotListening);
            var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

            (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = status });

            await sending.WaitAsync(Patience, Cancelled);
            Assert.Equal((false, false), await faked.Closed());
            // the server is told, when it can be
            Assert.Equal(HttpMethod.Delete, (await faked.Fetch.CallOf(2)).Method);
        }
    }

    [Fact]
    public async Task Rejects_a_refusal_the_server_marked_and_keeps_its_connection()
    {
        await using var faked = await ConnectFake(NotListening);
        var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(1)).Answer(RefusalOf(429, HttpRefusals.Busy));

        Assert.Equal("the server refused the exchange: 429 busy", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return sending.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
    }

    [Fact]
    public async Task Closes_on_an_answer_that_is_no_envelope_or_larger_than_an_envelope_and_hears_nothing_of_it()
    {
        foreach (var answer in new[]
        {
            new Answer { Status = 200, Body = "<html>"u8.ToArray(), Headers = new Dictionary<string, string> { ["content-type"] = "text/html" } },
            new Answer { Status = 200, Body = new byte[9], Headers = new Dictionary<string, string> { ["content-length"] = "9", ["content-type"] = HttpTransport.MediaType } },
            new Answer { Status = 200, Body = new byte[9], Headers = Bead },
        })
        {
            await using var faked = await ConnectFake(NotListening with { MaximumBodyBytes = 8 });
            var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

            (await faked.Fetch.CallOf(1)).Answer(answer);
            await sending.WaitAsync(Patience, Cancelled);

            Assert.Equal((false, false), await faked.Closed());
            Assert.Empty(faked.Heard);
        }
    }

    [Fact]
    public async Task Reads_an_answer_of_its_type_whatever_its_case_or_parameters_up_to_its_limit_exactly_and_closes_on_one_declared_past_it_unread()
    {
        var outcomes = new List<(string Heard, bool IsClosed, bool IsRead)>();

        foreach (var answer in new[]
        {
            new Answer
            {
                Status = 200,
                Body = Enumerable.Repeat((byte)1, 16).ToArray(),
                Headers = new Dictionary<string, string> { ["content-length"] = "16", ["content-type"] = "Application/PRS.Bead; charset=binary" },
                Read = new TaskCompletionSource(),
            },
            // its length said wrong: past the limit, whatever comes
            new Answer
            {
                Status = 200,
                Body = Enumerable.Repeat((byte)2, 16).ToArray(),
                Headers = new Dictionary<string, string> { ["content-length"] = "17", ["content-type"] = HttpTransport.MediaType },
                Read = new TaskCompletionSource(),
            },
        })
        {
            await using var faked = await ConnectFake(NotListening with { MaximumBodyBytes = 16 });
            var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

            (await faked.Fetch.CallOf(1)).Answer(answer);
            await sending.WaitAsync(Patience, Cancelled);
            await Eventually(() =>
            {
                return faked.Heard.Count > 0 || faked.Closes.Reader.Count > 0;
            });

            var firsts = faked.Heard.Select((heard) =>
            {
                return heard[0];
            });

            outcomes.Add((string.Join(",", firsts), faked.Closes.Reader.Count > 0, answer.Read?.Task.IsCompleted == true));
        }

        Assert.Equal([("1", false, true), ("", true, false)], outcomes);
    }

    [Fact]
    public async Task Hears_nothing_of_an_answer_ended_empty_nor_of_one_whose_connection_went_while_it_came()
    {
        await using var faked = await ConnectFake(NotListening);

        // cancelled: its exchange ends with no body
        var cancelled = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 200, Headers = Bead });
        await cancelled.WaitAsync(Patience, Cancelled);

        var later = new TaskCompletionSource<byte[]>();
        var coming = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (3, 0)), false));

        (await faked.Fetch.CallOf(2)).Answer(new Answer { Status = 200, Headers = Bead, Later = later.Task });
        await coming.WaitAsync(Patience, Cancelled);

        // another exchange lost: the connection goes, and the answer still coming with it
        var lost = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (5, 0)), false));

        (await faked.Fetch.CallOf(3)).Fail();
        await lost.WaitAsync(Patience, Cancelled);
        await faked.Closed();
        later.SetResult(EnvelopeOf(EnvelopeKind.Result, (3, 0)));
        await Task.Delay(20, Cancelled);

        Assert.Empty(faked.Heard);
    }

    [Fact]
    public async Task Reports_a_listener_that_throws_on_an_answer_and_stays_open()
    {
        await using var faked = await ConnectFake(NotListening);
        var thrown = new InvalidOperationException("a listener that throws");
        var errors = new ConcurrentQueue<Exception>();
        var told = 0;

        faked.Client.Message += (_) =>
        {
            throw thrown;
        };

        // a listener after it is told all the same
        faked.Client.Message += (_) =>
        {
            Interlocked.Increment(ref told);
        };
        faked.Client.Error += errors.Enqueue;

        var sent = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 200, Headers = Bead, Body = EnvelopeOf(EnvelopeKind.Result, (1, 0)) });
        await sent.WaitAsync(Patience, Cancelled);

        // heard once its body came whole, after the send settled on its head
        await Eventually(() =>
        {
            return Volatile.Read(ref told) == 1;
        });

        Assert.Single(faked.Heard);
        Assert.Equal([thrown], errors);
        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Closes_once_telling_the_server_once_however_many_exchanges_learn_it_is_lost_tells_a_server_that_said_it_is_gone_nothing()
    {
        await using var faked = await ConnectFake(NotListening);
        var first = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));
        var second = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (3, 0)), false));

        (await faked.Fetch.CallOf(1)).Fail();
        (await faked.Fetch.CallOf(2)).Fail();
        await Task.WhenAll(first, second).WaitAsync(Patience, Cancelled);

        Assert.Equal((false, false), await faked.Closed());
        Assert.Equal((0, 1), (faked.Closes.Reader.Count, faked.Fetch.Calls.Count((call) =>
        {
            return call.Method == HttpMethod.Delete;
        })));

        await using var told = await ConnectFake(NotListening);
        var refused = told.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await told.Fetch.CallOf(1)).Answer(RefusalOf(404, HttpRefusals.ConnectionUnknown));

        await Assert.ThrowsAsync<IOException>(() =>
        {
            return refused.WaitAsync(Patience, Cancelled);
        });
        await told.Closed();
        Assert.Equal(
            [HttpMethod.Post, HttpMethod.Post],
            told.Fetch.Calls.Select((call) =>
            {
                return call.Method;
            }));
    }

    [Fact]
    public async Task Closes_on_an_answer_with_no_type_or_whose_body_is_lost_on_its_way()
    {
        foreach (var answer in new[]
        {
            new Answer { Status = 200 },
            new Answer { Status = 200, Headers = Bead, IsBodyLost = true },
        })
        {
            await using var faked = await ConnectFake(NotListening);
            var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

            (await faked.Fetch.CallOf(1)).Answer(answer);
            await sending.WaitAsync(Patience, Cancelled);

            Assert.Equal((false, false), await faked.Closed());
        }
    }

    [Fact]
    public async Task Lets_go_of_a_connection_drawn_as_its_connect_gave_up_and_closes_even_when_the_server_cannot_hear_its_DELETE()
    {
        // drawn, then dropped before the connect heard it: its answer comes back all the same
        using var drawn = new Fetch { IsDeaf = true };
        await using var client = new HttpTransportClient(NotListening with { Handler = drawn });
        var connecting = client.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);
        var connect = await drawn.CallOf(0);

        await client.DisposeAsync();
        connect.Answer(DrawnOf(false));

        Assert.Equal("the transport client was disposed as it connected", (await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        })).Message);

        var deleted = await drawn.CallOf(1);

        Assert.Equal((HttpMethod.Delete, Token), (deleted.Method, deleted.ConnectionToken));

        // a DELETE the network failed
        await using var connected = await ConnectFake(NotListening, new Fetch { IsDeleteHeld = true });
        var disconnecting = connected.Client.CloseConnection();

        (await connected.Fetch.CallOf(1)).Fail();
        await disconnecting.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Closed, connected.Client.ReadyState);
    }

    // a DELETE never answered is waited on 5 s at most, on the real clock: it bounds the platform's
    // exchange against a server that does not answer, as AbortSignal.timeout does the TypeScript
    // side's. Played in real time, and bounded generously
    [Fact]
    public async Task Bounds_the_DELETE_of_its_disconnect_on_the_real_clock_never_on_the_one_it_is_given()
    {
        var time = new FakeTimeProvider();
        await using var waiting = await ConnectFake(NotListening with { Clock = time }, new Fetch { IsDeleteHeld = true });
        var unanswered = waiting.Client.CloseConnection();

        await waiting.Fetch.CallOf(1);

        var started = TimeProvider.System.GetTimestamp();

        time.Advance(TimeSpan.FromDays(1));
        await Task.Delay(100, Cancelled);

        Assert.False(unanswered.IsCompleted);

        await unanswered.WaitAsync(Patience, Cancelled);

        Assert.InRange(TimeProvider.System.GetElapsedTime(started), TimeSpan.FromSeconds(4.5), Patience);
        Assert.Equal(ReadyState.Closed, waiting.Client.ReadyState);
    }

    [Fact]
    public async Task Settles_its_send_on_the_head_of_the_answer_before_its_body_is_in_and_hears_the_answer_once_it_is()
    {
        var answer = EnvelopeOf(EnvelopeKind.Result, (1, 0));
        var later = new TaskCompletionSource<byte[]>();
        await using var faked = await ConnectFake(NotListening, new Fetch((call) =>
        {
            return call.Body is { Length: > 0 }
                ? new Answer { Status = 200, Headers = Bead, Later = later.Task }
                : DrawnOf(false);
        }));
        var heard = new List<string>();

        faked.Client.Message += (_) =>
        {
            lock (heard)
            {
                heard.Add("message");
            }
        };

        await faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false)).WaitAsync(Patience, Cancelled);

        lock (heard)
        {
            heard.Add("settled");
        }

        later.SetResult(answer);

        await Eventually(() =>
        {
            lock (heard)
            {
                return heard.SequenceEqual(["settled", "message"]);
            }
        });
        Assert.Equal([answer], faked.Heard);
    }

    [Fact]
    public async Task Refuses_to_connect_where_no_connection_is_drawn_and_lets_go_of_one_drawn_as_it_gave_up()
    {
        using var refused = new Fetch();
        await using var client = new HttpTransportClient(NotListening with { Handler = refused });
        var connecting = client.Connect(new HttpConnectOptions { Host = "::1", Pathname = "api", Port = 8_080, Secured = true }, Cancelled);

        (await refused.CallOf(0)).Answer(new Answer { Status = 503 });

        Assert.Equal("the server drew no connection: 503", (await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        })).Message);

        // a token without its 201, or a 201 without its token, draws nothing
        foreach (var answer in new[]
        {
            new Answer { Status = 200, Headers = new Dictionary<string, string> { [HttpTransport.ConnectionTokenHeader] = Token } },
            new Answer { Status = 201 },
        })
        {
            using var odd = new Fetch();
            await using var oddly = new HttpTransportClient(NotListening with { Handler = odd });
            var connectingOddly = oddly.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);

            (await odd.CallOf(0)).Answer(answer);

            Assert.Equal($"the server drew no connection: {answer.Status}", (await Assert.ThrowsAsync<HttpRequestException>(() =>
            {
                return connectingOddly.WaitAsync(Patience, Cancelled);
            })).Message);
        }

        Assert.Equal("https://[::1]:8080/api", refused.Calls[0].Uri);
        Assert.Equal(ReadyState.Closed, client.ReadyState);

        using var unreachable = new Fetch();
        await using var failed = new HttpTransportClient(NotListening with { Handler = unreachable });
        var failing = failed.Connect(new HttpConnectOptions { Host = Host, Port = 1 }, Cancelled);

        (await unreachable.CallOf(0)).Fail(new HttpRequestException("connect ECONNREFUSED"));

        Assert.Contains("connect ECONNREFUSED", (await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return failing.WaitAsync(Patience, Cancelled);
        })).Message, StringComparison.Ordinal);

        // timed out: its exchange aborted
        var time = new FakeTimeProvider();
        using var slow = new Fetch();
        await using var late = new HttpTransportClient(NotListening with { Handler = slow, Clock = time });
        var lateConnecting = late.Connect(new HttpConnectOptions { Host = Host, Port = 80, Timeout = TimeSpan.FromMilliseconds(20) }, Cancelled);
        var slowly = await slow.CallOf(0);

        time.Advance(TimeSpan.FromMilliseconds(20));

        Assert.Equal("timed out after 20ms", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return lateConnecting.WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.True(slowly.IsAborted);
        Assert.Equal("/bead", new HttpConnectOptions { Host = Host, Port = 80 }.Pathname);
    }

    // the TypeScript side drops its connection by `[dispose]`, unseen; DisposeAsync is its
    // asyncDispose, which closes an open connection
    [Fact]
    public async Task A_drop_aborts_what_is_in_flight_tells_the_server_and_a_dispose_while_connecting_rejects_the_connect()
    {
        await using var faked = await ConnectFake(NotListening);
        var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));
        var inFlight = await faked.Fetch.CallOf(1);

        await faked.Client.DisposeAsync().AsTask().WaitAsync(Patience, Cancelled);

        await sending.WaitAsync(Patience, Cancelled);
        Assert.True(inFlight.IsAborted);
        Assert.Equal((HttpMethod.Delete, Token), ((await faked.Fetch.CallOf(2)).Method, faked.Fetch.Calls[2].ConnectionToken));
        Assert.Equal(ReadyState.Closed, faked.Client.ReadyState);

        using var connecting = new Fetch();
        await using var disposed = new HttpTransportClient(NotListening with { Handler = connecting });
        var attempt = disposed.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);

        await connecting.CallOf(0);
        await disposed.DisposeAsync();

        Assert.Equal("the transport client was disposed as it connected", (await Assert.ThrowsAsync<HttpRequestException>(() =>
        {
            return attempt.WaitAsync(Patience, Cancelled);
        })).Message);
    }

    [Fact]
    public async Task Disconnects_quickly_without_waiting_on_the_server_which_is_told_all_the_same()
    {
        await using var faked = await ConnectFake(NotListening, new Fetch { IsDeleteHeld = true });

        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsClean = false, IsQuick = true }).WaitAsync(Patience, Cancelled);

        Assert.Equal((false, true), await faked.Closed());

        var deleted = await faked.Fetch.CallOf(1);

        Assert.Equal((HttpMethod.Delete, Token, false), (deleted.Method, deleted.ConnectionToken, deleted.Answered.IsCompleted));
    }

    // an open client's, as the WebSocket transport client's "reconnects an open transport without
    // emitting close" pins too: the connection replaced is let go of at the server, no close here
    [Fact]
    public async Task Reconnects_to_a_connection_drawn_anew()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        var closes = ClosesOf(client);

        await client.Connect(started.Target(), Cancelled);

        var first = await Next(started.Connections);

        await client.Reconnect().WaitAsync(Patience, Cancelled);

        var opened = await Next(started.Connections);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.NotEqual(first, opened);
        // its DELETE nobody waits on may come after the connect that replaced it
        Assert.Equal(first, (await Next(started.Closes)).ConnectionHandle);
        Assert.Equal([opened], started.Server.ConnectionHandles);
        Assert.True(closes.Reader.Count == 0);
        await client.CloseConnection().WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public void Marks_its_refusals_as_the_server_does()
    {
        Assert.Equal(("bead-refusal", "connection-unknown"), (HttpTransport.RefusalHeader, HttpRefusals.ConnectionUnknown));
    }

    // listening

    [Fact]
    public async Task Says_at_connect_that_it_listens_then_listens_a_batch_heard_in_order_acknowledged_by_the_next_listen()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()) with { Wait = TimeSpan.FromSeconds(1) });
        var first = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var second = EnvelopeOf(EnvelopeKind.Request, (2, 2));
        var listen = await faked.Fetch.CallOf(1);
        var credentials = Channel.CreateUnbounded<string?>();

        // what a listen brings back carries no credential
        faked.Client.Message += (message) =>
        {
            credentials.Writer.TryWrite(message.Credential);
        };

        Assert.Equal("?1", faked.Fetch.Calls[0].Listen);
        Assert.Equal(
            ($"http://{Host}:8080/bead?after=0&wait=1000", Token, HttpMethod.Get),
            (listen.Uri, listen.ConnectionToken, listen.Method));

        listen.Answer(Batch(1, first, second));

        Assert.Contains("?after=2&", (await faked.Fetch.CallOf(2)).Uri, StringComparison.Ordinal);
        Assert.Equal([first, second], faked.Heard);
        Assert.Equal([null, null], new[] { await Next(credentials), await Next(credentials) });

        // nothing, and it listens again at the same point
        (await faked.Fetch.CallOf(2)).Answer(new Answer { Status = 204 });

        Assert.Contains("?after=2&", (await faked.Fetch.CallOf(3)).Uri, StringComparison.Ordinal);

        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);

        Assert.True(faked.Fetch.Calls[3].IsAborted);
        Assert.Equal(TimeSpan.FromSeconds(25), new HttpTransportClientOptions().Wait);
    }

    [Fact]
    public async Task Marks_what_a_listen_brings_back_as_what_may_overtake_and_never_what_a_POST_s_body_brings()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()) with { Wait = TimeSpan.FromSeconds(1) });
        var listen = await faked.Fetch.CallOf(1);
        var marks = Channel.CreateUnbounded<bool>();

        faked.Client.Message += (message) =>
        {
            marks.Writer.TryWrite(message.MayOvertake);
        };

        // a request's own answer, in its POST's body
        var sending = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(2)).Answer(new Answer { Status = 200, Headers = Bead, Body = EnvelopeOf(EnvelopeKind.Result, (1, 0)) });
        await sending.WaitAsync(Patience, Cancelled);

        Assert.False(await Next(marks));

        // what a listen brings back keeps no order with it (spec 15.9)
        listen.Answer(Batch(1, EnvelopeOf(EnvelopeKind.Failure, (3, 0)), EnvelopeOf(EnvelopeKind.Notification, (1, 0))));

        var overtaking = new[] { await Next(marks), await Next(marks) };

        Assert.Equal([true, true], overtaking);

        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Listens_again_from_where_it_was_when_a_listen_is_lost_at_once_then_later_and_later_drawn_apart_and_one_that_reaches_the_server_ends_the_losses()
    {
        var time = new FakeTimeProvider();
        await using var faked = await ConnectFake(ListeningOn(time));
        var fetch = faked.Fetch;
        var envelope = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var waits = new List<TimeSpan>();

        // the first loss is listened again at once
        (await fetch.CallOf(1)).Fail();

        Assert.Equal(3, fetch.Count);

        for (var losses = 2; losses <= 8; losses += 1)
        {
            var made = fetch.Count;

            // a batch cut before anything came whole is a loss as well
            if (losses == 3)
            {
                fetch.Calls[^1].Answer(Batch(1, envelope) with { IsBodyLost = true });
            }
            else
            {
                fetch.Calls[^1].Fail();
            }

            waits.Add(WaitedFor((fetch, made), time));
        }

        // a 200 of another type — a proxy's page — is lost too, its body unread
        var page = new TaskCompletionSource();
        var madeBefore = fetch.Count;

        fetch.Calls[^1].Answer(new Answer
        {
            Status = 200,
            Body = "<html>"u8.ToArray(),
            Headers = new Dictionary<string, string> { ["content-type"] = "text/html" },
            Read = page,
        });
        waits.Add(WaitedFor((fetch, madeBefore), time));

        // it reaches the server: the losses end, and the next is listened again at once
        fetch.Calls[^1].Answer(new Answer { Status = 204 });

        Assert.Equal(12, fetch.Count);

        fetch.Calls[^1].Fail();

        // each between half of its wait and all of it — 1 s, then twice as long, up to 30 — and
        // not each at the same point of it
        var ranges = waits.Zip(WholeRetries, (waited, seconds) =>
        {
            return (Waited: waited, Whole: TimeSpan.FromSeconds(seconds));
        }).ToList();

        Assert.Equal(8, ranges.Count);
        Assert.All(ranges, (range) =>
        {
            Assert.InRange(range.Waited, range.Whole / 2, range.Whole);
        });
        Assert.Contains(ranges, (range) =>
        {
            return range.Waited > range.Whole / 2 + Millisecond && range.Waited < range.Whole;
        });
        Assert.False(page.Task.IsCompleted);
        Assert.Equal((ReadyState.Open, 13), (faked.Client.ReadyState, fetch.Count));

        // what was cut on its way comes whole at last, and is heard once
        fetch.Calls[12].Answer(Batch(1, envelope));

        Assert.Contains("?after=1&", (await fetch.CallOf(13)).Uri, StringComparison.Ordinal);
        Assert.Equal([envelope], faked.Heard);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Counts_its_connection_lost_once_its_listens_were_lost_for_its_inactivity_timeout_and_tells_the_server()
    {
        using var fetch = LosingFetch();
        var time = new FakeTimeProvider();
        await using var client = new HttpTransportClient(new HttpTransportClientOptions { Handler = fetch, InactivityTimeout = TimeSpan.FromMilliseconds(40), Clock = time });
        var closes = ClosesOf(client);

        await client.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);

        // its last wait ends at its timeout, never after it
        time.Advance(TimeSpan.FromMilliseconds(39));

        Assert.Equal(ReadyState.Open, client.ReadyState);

        time.Advance(Millisecond);

        Assert.Equal((false, false), await Next(closes));

        var methods = fetch.Calls.Select((call) =>
        {
            return call.Method;
        }).ToList();

        // at once, then no later than its timeout, then no more
        Assert.Equal((HttpMethod.Delete, 3), (methods[^1], methods.Count((method) =>
        {
            return method == HttpMethod.Get;
        })));
        Assert.Equal(TimeSpan.FromMinutes(5), new HttpTransportClientOptions().InactivityTimeout);

        // a timeout within the second wait's range: whichever is drawn, it ends at its timeout
        for (var draws = 0; draws < 20; draws += 1)
        {
            var drawing = new FakeTimeProvider();
            await using var drawn = new HttpTransportClient(new HttpTransportClientOptions { Handler = fetch, InactivityTimeout = TimeSpan.FromMilliseconds(700), Clock = drawing });
            var closesDrawn = ClosesOf(drawn);

            await drawn.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);
            drawing.Advance(TimeSpan.FromMilliseconds(699));

            Assert.Equal(ReadyState.Open, drawn.ReadyState);

            drawing.Advance(Millisecond);

            Assert.Equal((false, false), await Next(closesDrawn));
        }
    }

    [Fact]
    public async Task Times_its_inactivity_on_a_timer_never_on_its_clock_whether_the_clock_leaps_or_stands_still()
    {
        // a clock that leaps an hour at each reading buys nothing and costs nothing: three listens,
        // the last at its timeout
        using var leaping = LosingFetch();
        var time = new FakeTimeProvider();
        await using var onLeaps = new HttpTransportClient(new HttpTransportClientOptions
        {
            Handler = leaping,
            InactivityTimeout = TimeSpan.FromMilliseconds(40),
            Clock = new WaywardTime(time, true),
        });
        var closesOnLeaps = ClosesOf(onLeaps);

        await onLeaps.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);
        time.Advance(TimeSpan.FromMilliseconds(39));

        Assert.Equal((ReadyState.Open, 2), (onLeaps.ReadyState, ListensOf(leaping)));

        time.Advance(Millisecond);

        Assert.Equal((false, false), await Next(closesOnLeaps));
        Assert.Equal((HttpMethod.Delete, 3), (leaping.Calls[^1].Method, ListensOf(leaping)));

        // one that stands still holds nothing open past its timeout: whichever wait is drawn, the one
        // under way then is cut, and the listen after it is the last
        using var standing = LosingFetch();
        var stillTime = new FakeTimeProvider();
        await using var onStill = new HttpTransportClient(new HttpTransportClientOptions
        {
            Handler = standing,
            InactivityTimeout = TimeSpan.FromMilliseconds(700),
            Clock = new WaywardTime(stillTime, false),
        });
        var closesOnStill = ClosesOf(onStill);

        await onStill.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);
        stillTime.Advance(TimeSpan.FromMilliseconds(699));

        Assert.Equal(ReadyState.Open, onStill.ReadyState);

        stillTime.Advance(Millisecond);

        Assert.Equal((false, false), await Next(closesOnStill));
        Assert.Equal(HttpMethod.Delete, standing.Calls[^1].Method);
    }

    // its timeout ends on its own timer, so a timer that ends early ends it early, and buys no
    // listen more
    [Fact]
    public async Task Listens_three_times_within_its_inactivity_timeout_even_on_timers_that_end_early_and_never_a_fourth()
    {
        var gets = 0;
        using var fetch = new Fetch((call) =>
        {
            if (call.Method != HttpMethod.Get)
            {
                return call.Method == HttpMethod.Post ? DrawnOf(true) : new Answer { Status = 204 };
            }

            // a fourth is one too many: told gone, so that a burst ends there
            if (Interlocked.Increment(ref gets) > 3)
            {
                return RefusalOf(404, HttpRefusals.ConnectionUnknown);
            }

            throw new HttpRequestException("fetch failed");
        });
        var time = new FakeTimeProvider();
        await using var client = new HttpTransportClient(new HttpTransportClientOptions
        {
            Handler = fetch,
            InactivityTimeout = TimeSpan.FromMilliseconds(40),
            Clock = new HastyTime(time),
        });
        var closes = ClosesOf(client);

        await client.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);
        time.Advance(TimeSpan.FromMilliseconds(38));

        Assert.Equal((ReadyState.Open, 2), (client.ReadyState, Volatile.Read(ref gets)));

        time.Advance(Millisecond);

        Assert.Equal((false, false), await Next(closes));

        // and nothing after it
        time.Advance(TimeSpan.FromMinutes(1));

        Assert.Equal(3, Volatile.Read(ref gets));
        Assert.Equal(HttpMethod.Delete, fetch.Calls[^1].Method);
    }

    [Fact]
    public async Task A_listen_heard_ends_the_count_and_its_inactivity_timeout_runs_again_from_the_next_first_loss()
    {
        var time = new FakeTimeProvider();
        await using var faked = await ConnectFake(ListeningOn(time) with { InactivityTimeout = TimeSpan.FromMilliseconds(40) });
        var fetch = faked.Fetch;

        // lost, listened again at once, and heard 30 ms later
        (await fetch.CallOf(1)).Fail();

        var heard = await fetch.CallOf(2);

        time.Advance(TimeSpan.FromMilliseconds(30));
        heard.Answer(Batch(1, EnvelopeOf(EnvelopeKind.Notification, (1, 0))));
        await fetch.CallOf(3);

        // past where the first count would have ended, lost twice again
        time.Advance(TimeSpan.FromMilliseconds(20));
        fetch.Calls[3].Fail();
        (await fetch.CallOf(4)).Fail();

        // 40 ms from this first loss, not from the one before
        time.Advance(TimeSpan.FromMilliseconds(39));

        Assert.Equal((ReadyState.Open, 5), (faked.Client.ReadyState, fetch.Count));

        time.Advance(Millisecond);
        (await fetch.CallOf(5)).Fail();

        Assert.Equal((false, false), await faked.Closed());
        Assert.Equal(HttpMethod.Delete, (await fetch.CallOf(6)).Method);
    }

    [Fact]
    public async Task Loses_the_connection_on_a_batch_that_does_not_read_and_on_a_refusal_of_its_listen_told_it_is_gone_it_tells_the_server_nothing()
    {
        var envelope = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var framed = BatchOf(envelope);
        var numbered = (string first) =>
        {
            return Batch(1, envelope) with
            {
                Headers = new Dictionary<string, string> { ["content-type"] = HttpTransport.BatchMediaType, [HttpTransport.SequenceHeader] = first },
            };
        };
        var answers = new[]
        {
            Batch(1, envelope) with { Headers = new Dictionary<string, string> { ["content-type"] = HttpTransport.BatchMediaType } },
            // numbered other than from the one after the last it heard
            numbered("one"),
            numbered("01"),
            numbered("2"),
            Batch(1) with { Body = [0, 0, 0, 0, .. framed] },
            Batch(1) with { Body = [] },
            Batch(1) with { IsBodiless = true },
            // ended in the middle of a length, or of an envelope
            Batch(1) with { Body = [.. framed, 0, 0] },
            Batch(1) with { Body = [.. framed, .. framed[..6]] },
            // an envelope past the client's limit, however whole
            Batch(1) with { Body = [0, 0, 0, 25, .. new byte[25]] },
            RefusalOf(409, HttpRefusals.ListenUndeclared),
            RefusalOf(404, HttpRefusals.ConnectionUnknown),
        };
        var told = new List<bool>();
        var heardOf = new List<int>();

        foreach (var answer in answers)
        {
            await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()) with { MaximumBodyBytes = 24 });

            (await faked.Fetch.CallOf(1)).Answer(answer);

            Assert.Equal((false, false), await faked.Closed());
            heardOf.Add(faked.Heard.Count);
            told.Add(faked.Fetch.Calls.Any((call) =>
            {
                return call.Method == HttpMethod.Delete;
            }));
        }

        Assert.Equal([true, true, true, true, true, true, true, true, true, true, true, false], told);
        // what came whole before what does not read was heard, as it came
        Assert.Equal([0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0], heardOf);

        // one of the limit exactly is heard
        await using var atLimit = await ConnectFake(ListeningOn(new FakeTimeProvider()) with { MaximumBodyBytes = 24 });
        var largest = EnvelopeOf(EnvelopeKind.Notification, (1, 16));

        (await atLimit.Fetch.CallOf(1)).Answer(Batch(1, largest));

        Assert.Contains("?after=1&", (await atLimit.Fetch.CallOf(2)).Uri, StringComparison.Ordinal);
        Assert.Equal([largest], atLimit.Heard);
        await atLimit.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Asks_the_server_to_wait_its_wait_held_a_fraction_rounded_to_the_nearest_whole_millisecond()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()) with { Wait = TimeSpan.FromMilliseconds(1.5) });

        Assert.EndsWith("&wait=2", (await faked.Fetch.CallOf(1)).Uri, StringComparison.Ordinal);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Pauses_between_listens_that_bring_nothing_and_listens_no_more_once_its_connection_went()
    {
        var time = new FakeTimeProvider();
        await using var faked = await ConnectFake(ListeningOn(time) with { Pause = TimeSpan.FromMilliseconds(60), Wait = TimeSpan.Zero });

        Assert.EndsWith("&wait=0", (await faked.Fetch.CallOf(1)).Uri, StringComparison.Ordinal);

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 204 });
        time.Advance(TimeSpan.FromMilliseconds(59));

        // not yet
        Assert.Equal(2, faked.Fetch.Count);

        time.Advance(Millisecond);
        await faked.Fetch.CallOf(2);

        // gone while it listens: what its listen brings back is heard by nobody, and it listens no more
        var lost = faked.Client.Send(new TransportMessage(EnvelopeOf(EnvelopeKind.Request, (1, 0)), false));

        (await faked.Fetch.CallOf(3)).Fail();
        await lost.WaitAsync(Patience, Cancelled);
        await faked.Closed();
        faked.Fetch.Calls[2].Answer(Batch(1, EnvelopeOf(EnvelopeKind.Notification, (1, 0))));
        await Task.Delay(20, Cancelled);

        Assert.Equal(
            [HttpMethod.Post, HttpMethod.Get, HttpMethod.Get, HttpMethod.Post, HttpMethod.Delete],
            faked.Fetch.Calls.Select((call) =>
            {
                return call.Method;
            }));
        Assert.Empty(faked.Heard);
    }

    [Fact]
    public async Task Hears_the_rest_of_a_batch_when_a_listener_throws_the_throw_reported()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()));
        var thrown = new InvalidOperationException("a listener that throws");
        var errors = new ConcurrentQueue<Exception>();
        var throws = 1;
        var told = 0;

        faked.Client.Message += (_) =>
        {
            if (Interlocked.Exchange(ref throws, 0) == 1)
            {
                throw thrown;
            }
        };

        // a listener after it is told all the same
        faked.Client.Message += (_) =>
        {
            Interlocked.Increment(ref told);
        };
        faked.Client.Error += errors.Enqueue;
        (await faked.Fetch.CallOf(1)).Answer(Batch(1, EnvelopeOf(EnvelopeKind.Notification, (1, 0)), EnvelopeOf(EnvelopeKind.Notification, (3, 0))));

        Assert.Contains("?after=2&", (await faked.Fetch.CallOf(2)).Uri, StringComparison.Ordinal);
        Assert.Equal((2, 2), (faked.Heard.Count, Volatile.Read(ref told)));
        Assert.Equal([thrown], errors);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Hears_no_more_of_a_batch_once_its_connection_went_while_it_was_heard()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()));
        var first = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var heard = 0;

        faked.Client.Message += (message) =>
        {
            if (Interlocked.Increment(ref heard) == 1)
            {
                _ = faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true });
            }
        };
        (await faked.Fetch.CallOf(1)).Answer(Batch(1, first, EnvelopeOf(EnvelopeKind.Notification, (3, 0))));

        await Eventually(() =>
        {
            return faked.Client.ReadyState == ReadyState.Closed;
        });
        Assert.Equal([first], faked.Heard);
    }

    [Fact]
    public async Task Listens_again_after_a_status_nothing_marked_a_gateway_s_502_as_after_a_listen_lost()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()));
        var envelope = EnvelopeOf(EnvelopeKind.Notification, (1, 0));

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 502 });
        (await faked.Fetch.CallOf(2)).Answer(Batch(1, envelope));

        Assert.Contains("?after=1&", (await faked.Fetch.CallOf(3)).Uri, StringComparison.Ordinal);
        Assert.Equal([envelope], faked.Heard);
        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Reads_a_batch_as_it_comes_a_byte_at_a_time_each_envelope_heard_as_soon_as_it_is_whole()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()));
        var first = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var second = EnvelopeOf(EnvelopeKind.Notification, (3, 5));
        var pieces = BatchOf(first, second).Select((piece) =>
        {
            return new[] { piece };
        }).ToArray();
        // the first envelope's length and bytes, then the batch ends
        var cut = 4 + first.Length;

        (await faked.Fetch.CallOf(1)).Answer(Batch(1) with { Pieces = pieces[..cut] });

        // the rest, in the next listen: from the one after the first
        Assert.Contains("?after=1&", (await faked.Fetch.CallOf(2)).Uri, StringComparison.Ordinal);
        Assert.Equal([first], faked.Heard);

        (await faked.Fetch.CallOf(2)).Answer(Batch(2) with { Pieces = pieces[cut..] });

        Assert.Contains("?after=2&", (await faked.Fetch.CallOf(3)).Uri, StringComparison.Ordinal);
        Assert.Equal([first, second], faked.Heard);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Hears_what_came_whole_of_a_batch_cut_on_its_way_and_listens_again_from_there_as_no_loss()
    {
        await using var faked = await ConnectFake(ListeningOn(new FakeTimeProvider()));
        var first = EnvelopeOf(EnvelopeKind.Notification, (1, 0));
        var framed = BatchOf(first, EnvelopeOf(EnvelopeKind.Notification, (3, 0)));

        (await faked.Fetch.CallOf(1)).Answer(Batch(1) with { Pieces = [framed[..(4 + first.Length + 2)]], Cut = new IOException("terminated") });

        Assert.Contains("?after=1&", (await faked.Fetch.CallOf(2)).Uri, StringComparison.Ordinal);

        // one loss after it is the first in a row: listened again, at once
        (await faked.Fetch.CallOf(2)).Fail();

        Assert.Contains("?after=1&", (await faked.Fetch.CallOf(3)).Uri, StringComparison.Ordinal);
        Assert.Equal([first], faked.Heard);
        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Never_listens_where_the_server_did_not_say_its_listen_back()
    {
        using var fetch = new Fetch();
        await using var client = new HttpTransportClient(ListeningOn(new FakeTimeProvider()) with { Handler = fetch });
        var connecting = client.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);

        (await fetch.CallOf(0)).Answer(DrawnOf(false));
        await connecting.WaitAsync(Patience, Cancelled);
        await Task.Delay(20, Cancelled);

        Assert.Equal(("?1", 1, false), (fetch.Calls[0].Listen, fetch.Count, client.IsListening));
        await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Says_nothing_of_listening_and_never_listens_when_told_not_to()
    {
        using var fetch = new Fetch();
        await using var client = new HttpTransportClient(NotListening with { Handler = fetch, Clock = new FakeTimeProvider() });
        var connecting = client.Connect(new HttpConnectOptions { Host = Host, Port = 80 }, Cancelled);

        // a server that says a listen back all the same takes none from a client that asked for none
        (await fetch.CallOf(0)).Answer(DrawnOf(true));
        await connecting.WaitAsync(Patience, Cancelled);
        await Task.Delay(20, Cancelled);

        Assert.Equal((1, null, false), (fetch.Count, fetch.Calls[0].Listen, client.IsListening));
        await client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    // its guards and its reconnection, which the TypeScript side keeps once, in
    // createTransportClient, and this client keeps a copy of: the WebSocket transport client's twins

    [Fact]
    public async Task Refuses_a_connect_while_open_reaching_no_server()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);

        await client.Connect(started.Target(), Cancelled);
        await Next(started.Connections);

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(started.Target(), Cancelled).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the transport client is already open", refused.Message);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(started.Server.ConnectionHandles);
        Assert.True(started.Connections.Reader.Count == 0);
    }

    // a socket here is a POST, which draws a connection
    [Fact]
    public async Task Refuses_a_second_connect_while_the_first_is_connecting_opening_one_socket_only()
    {
        using var fetch = new Fetch();
        await using var client = new HttpTransportClient(NotListening with { Handler = fetch });
        var first = client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);

        Assert.Equal("the transport client is already connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled).WaitAsync(Patience, Cancelled);
        })).Message);

        (await fetch.CallOf(0)).Answer(DrawnOf(false));
        await first.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(1, fetch.Count);
    }

    [Fact]
    public async Task Refuses_a_connect_while_its_close_is_under_way_and_connects_again_once_closed()
    {
        // under way as long as its DELETE is held, whatever the machine's pace
        await using var faked = await ConnectFake(NotListening, new Fetch { IsDeleteHeld = true });
        var closing = faked.Client.CloseConnection();

        Assert.Equal("the transport client is already closing", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return faked.Client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled).WaitAsync(Patience, Cancelled);
        })).Message);

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 204 });
        await closing.WaitAsync(Patience, Cancelled);

        var connecting = faked.Client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);

        (await faked.Fetch.CallOf(2)).Answer(DrawnOf(false));
        await connecting.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        await faked.Client.CloseConnection(new TransportDisconnectOptions { IsQuick = true }).WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Reconnects_after_a_close()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);

        await client.Connect(started.Target(), Cancelled);
        await client.CloseConnection().WaitAsync(Patience, Cancelled);
        await client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.FromMilliseconds(10)), MaximumAttempts = 1 }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Reconnects_to_the_target_of_the_last_accepted_connect()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);

        await client.Connect(started.Target(), Cancelled);
        await Next(started.Connections);

        // a target where the server draws no connection: a reconnection that took it would fail
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(started.Target() with { Pathname = "/elsewhere" }, Cancelled).WaitAsync(Patience, Cancelled);
        });
        await client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero) }).WaitAsync(Patience, Cancelled);
        await Next(started.Connections);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Keeps_no_token_of_a_connect_for_its_reconnections()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);

        await client.Connect(started.Target(), source.Token);
        await source.CancelAsync();
        await client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Refuses_to_reconnect_a_client_never_connected_leaving_it_uninitialized()
    {
        await using var client = new HttpTransportClient(NotListening);

        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect().WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
    }

    [Fact]
    public async Task Refuses_to_reconnect_while_a_close_is_under_way()
    {
        // under way as long as its DELETE is held, whatever the machine's pace
        await using var faked = await ConnectFake(NotListening, new Fetch { IsDeleteHeld = true });
        var closing = faked.Client.CloseConnection();

        Assert.Equal("the transport client cannot reconnect while closing", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return faked.Client.Reconnect().WaitAsync(Patience, Cancelled);
        })).Message);

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 204 });
        await closing.WaitAsync(Patience, Cancelled);
    }

    [Fact]
    public async Task Refuses_to_reconnect_while_a_connect_is_under_way_and_that_connect_still_opens()
    {
        using var fetch = new Fetch();
        await using var client = new HttpTransportClient(NotListening with { Handler = fetch });

        // under way as long as its POST is held, whatever the machine's pace
        var connecting = client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled);
        var held = await fetch.CallOf(0);

        Assert.Equal("the transport client cannot reconnect while connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect().WaitAsync(Patience, Cancelled);
        })).Message);

        held.Answer(DrawnOf(false));
        await connecting.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Refuses_a_second_reconnection_leaving_the_first_alone()
    {
        var time = new FakeTimeProvider();
        await using var faked = await ConnectRefused(NotListening with { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();
        var first = faked.Client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMilliseconds(20)),
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });

        Assert.Equal("the transport client is already reconnecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return faked.Client.Reconnect().WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Reconnecting, faked.Client.ReadyState);

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 503 });
        await Next(taps);
        time.Advance(TimeSpan.FromMilliseconds(20));
        (await faked.Fetch.CallOf(2)).Answer(DrawnOf(false));
        await first.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        // the connect refused, then the first's two attempts: the second made none
        Assert.Equal(3, faked.Fetch.Count);
    }

    [Fact]
    public async Task Refuses_a_connect_while_it_waits_to_attempt_again()
    {
        var time = new FakeTimeProvider();
        using var source = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await using var faked = await ConnectRefused(NotListening with { Clock = time });
        var taps = Channel.CreateUnbounded<(TimeSpan Delay, int Attempt)>();
        var reconnecting = faked.Client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMinutes(1)),
            CancellationToken = source.Token,
            Tap = (delay, attempt) =>
            {
                taps.Writer.TryWrite((delay, attempt));
            },
        });

        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 503 });
        await Next(taps);

        Assert.Equal("the transport client is already reconnecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return faked.Client.Connect(new HttpConnectOptions { Host = Host, Port = 8_080 }, Cancelled).WaitAsync(Patience, Cancelled);
        })).Message);

        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(ReadyState.Closed, faked.Client.ReadyState);
        // the connect refused made no call
        Assert.Equal(2, faked.Fetch.Count);
    }

    [Fact]
    public async Task Raises_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient(NotListening);
        var reconnects = 0;

        ((IRouterClientTransport)client).Reconnect += () =>
        {
            Interlocked.Increment(ref reconnects);
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect().WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(0, reconnects);

        await client.Connect(started.Target(), Cancelled);
        await client.Reconnect().WaitAsync(Patience, Cancelled);
        await client.CloseConnection().WaitAsync(Patience, Cancelled);
        await client.Reconnect().WaitAsync(Patience, Cancelled);

        Assert.Equal(2, reconnects);
    }

    [Fact]
    public async Task Throws_a_ReconnectException_carrying_the_last_failure_ending_closed()
    {
        await using var faked = await ConnectRefused(NotListening);
        var reconnecting = faked.Client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), MaximumAttempts = 2 });

        // each refused with a status of its own, which its failure names
        (await faked.Fetch.CallOf(1)).Answer(new Answer { Status = 501 });
        (await faked.Fetch.CallOf(2)).Answer(new Answer { Status = 502 });

        var thrown = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("attempt 2 reached", thrown.Message);
        Assert.Equal("the server drew no connection: 502", Assert.IsType<HttpRequestException>(thrown.InnerException).Message);
        Assert.Equal(ReadyState.Closed, faked.Client.ReadyState);
        // no attempt after the last
        Assert.Equal(3, faked.Fetch.Count);
    }

    [Fact]
    public async Task Never_attempts_with_a_token_cancelled_already_and_stops_at_the_wait_when_its_tap_cancels()
    {
        using var cancelled = new CancellationTokenSource();
        await using var faked = await ConnectFake(NotListening);
        var reconnects = 0;

        ((IRouterClientTransport)faked.Client).Reconnect += () =>
        {
            Interlocked.Increment(ref reconnects);
        };
        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return faked.Client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), CancellationToken = cancelled.Token });
        });

        // the open connection left alone: never let go of, and none drawn
        Assert.Equal(ReadyState.Open, faked.Client.ReadyState);
        Assert.Equal(0, reconnects);
        Assert.Equal(1, faked.Fetch.Count);

        using var source = new CancellationTokenSource();
        await using var failing = await ConnectRefused(NotListening);
        var reconnecting = failing.Client.Reconnect(new TransportReconnectOptions
        {
            Delay = DelayOf(TimeSpan.FromMinutes(1)),
            CancellationToken = source.Token,
            Tap = (_, _) =>
            {
                source.Cancel();
            },
        });

        (await failing.Fetch.CallOf(1)).Answer(new Answer { Status = 503 });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(ReadyState.Closed, failing.Client.ReadyState);
        Assert.Equal(2, failing.Fetch.Count);
    }

    // the WebSocket transport client's test cancels from a hook as its attempt opens; here the
    // attempt's answer comes after its token was cancelled, a handler deaf to it handing it on
    [Fact]
    public async Task Disconnects_and_throws_an_OperationCanceledException_when_cancelled_once_its_attempt_opened()
    {
        using var source = new CancellationTokenSource();
        await using var faked = await ConnectFake(NotListening, new Fetch { IsDeaf = true });
        var reconnecting = faked.Client.Reconnect(new TransportReconnectOptions { Delay = DelayOf(TimeSpan.Zero), CancellationToken = source.Token });

        // the DELETE of the connection replaced, then the attempt
        await faked.Fetch.CallOf(2);
        await source.CancelAsync();
        faked.Fetch.Calls[2].Answer(DrawnOf(false));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(ReadyState.Closed, faked.Client.ReadyState);
        // the close of the disconnect, and none for the connection replaced
        Assert.Equal((true, false), await faked.Closed());
        Assert.True(faked.Closes.Reader.Count == 0);
        Assert.Equal(
            [HttpMethod.Post, HttpMethod.Delete, HttpMethod.Post, HttpMethod.Delete],
            faked.Fetch.Calls.Select((call) =>
            {
                return call.Method;
            }));
    }

    // what its connect threw, an HttpRequestException, where the WebSocket transport client's socket
    // throws: the server gone is told by the listen it holds, which its stop answers, and the attempt
    // after meets a server stopping, which draws no connection, or its exchange cut
    [Fact]
    public async Task Throws_a_ReconnectException_from_what_its_connect_threw_when_the_server_is_gone()
    {
        await using var started = await Started.Start();
        await using var client = new HttpTransportClient();
        var reconnecting = new TaskCompletionSource<Task>(TaskCreationOptions.RunContinuationsAsynchronously);

        // from its close, as the TypeScript side's test reconnects; one attempt, for a port nothing
        // listens on takes this system two seconds to refuse
        client.Close += (_, _) =>
        {
            reconnecting.TrySetResult(client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1 }));
        };
        await client.Connect(started.Target(), Cancelled);
        await Eventually(() =>
        {
            return started.Server.Gauges().Counts["listens"] == 1;
        });
        await started.Server.Stop().WaitAsync(Patience, Cancelled);

        var reconnect = await reconnecting.Task.WaitAsync(Patience, Cancelled);
        var thrown = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return reconnect.WaitAsync(Patience, Cancelled);
        });

        Assert.IsType<HttpRequestException>(thrown.InnerException);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
    }
}
