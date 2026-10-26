using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;

namespace Bead.Transport.Http;

/// <summary>How an HTTP transport client holds its connection, and listens.</summary>
public sealed record HttpTransportClientOptions
{
    /// <summary>
    /// What its exchanges go through; a handler of its own when none, which follows no redirect and
    /// races the address families of a name (RFC 8305), as Node's and a browser's do. One given
    /// keeps its own behaviour, and follows no redirect: an <see cref="HttpClientHandler"/> or a
    /// <see cref="SocketsHttpHandler"/>, innermost of the <see cref="DelegatingHandler"/>s given,
    /// whose <c>AllowAutoRedirect</c> is true is refused as the client is built; an answer from
    /// another URL than the one asked fails the connect, and loses the connection of a send or a
    /// listen. The tests' way, as the TypeScript side's give it a <c>fetch</c>.
    /// </summary>
    public HttpMessageHandler? Handler { get; init; }

    /// <summary>
    /// How long it goes on listening again, its listens lost, before it counts its connection lost: 5
    /// minutes by default, a server's own inactivity timeout; infinite for ever. From 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds otherwise, rounded to the nearest whole one;
    /// zero is refused.
    /// </summary>
    public TimeSpan InactivityTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Whether it listens for what the server sends of its own, once the server says it back at connect.</summary>
    public bool IsListening { get; init; } = true;

    /// <summary>The largest answer, and the largest envelope a batch brings, it reads: an envelope's limit by default.</summary>
    public int? MaximumBodyBytes { get; init; }

    /// <summary>
    /// How long it waits before it listens again after a listen that brought nothing: none, zero, by
    /// default, which listens again at once; from 1 to <see cref="Clocks.LongestTimer"/> milliseconds
    /// otherwise, rounded to the nearest whole one. Infinite is refused.
    /// </summary>
    public TimeSpan Pause { get; init; } = TimeSpan.Zero;

    /// <summary>
    /// How long each listen asks the server to wait: 25 seconds by default, under a server's 30 and
    /// an intermediary's 60; zero asks it to answer at once, which polls. From 1 to
    /// <see cref="Clocks.LongestTimer"/> milliseconds otherwise, rounded to the nearest whole one;
    /// infinite is refused.
    /// </summary>
    public TimeSpan Wait { get; init; } = TimeSpan.FromSeconds(25);

    /// <summary>
    /// What the stack built on it runs on, its timeouts and waits among them; the system's clock when
    /// none. A disconnect's wait on the server bounds the platform's exchange, on the real clock.
    /// </summary>
    public TimeProvider? Clock { get; init; }
}

/// <summary>Where a client connects — <c>http://host:port/pathname</c>, or <c>https://</c> when secured — and how long it waits.</summary>
public sealed record HttpConnectOptions
{
    /// <summary>The server's host.</summary>
    public required string Host { get; init; }

    /// <summary>The server's port.</summary>
    public required int Port { get; init; }

    /// <summary>Whether the connection is over TLS.</summary>
    public bool Secured { get; init; }

    /// <summary>The path the server answers on, prefixed with a single leading slash.</summary>
    public string Pathname { get; init; } = HttpTransport.Pathname;

    /// <summary>
    /// How long the connect may take before it throws a <see cref="TimeoutException"/>: 30 seconds
    /// unless told, from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, rounded to the nearest
    /// whole one, or <see cref="System.Threading.Timeout.InfiniteTimeSpan"/>, which never times out;
    /// zero is refused.
    /// </summary>
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// A transport client over HTTP, on a connection the server draws for it: <see cref="Connect"/>
/// posts no envelope and takes the token the server answers 201 with, each send posts one envelope
/// with that token, and <see cref="CloseConnection"/> deletes the connection. A send settles on the
/// head of its answer, so a caller knows whether the server had its envelope: a 2xx settles — the
/// answer comes as a message when it does; a refusal the server marks fails, nothing having been
/// tried, and the one that says the connection is gone closes it, once that failure is heard;
/// anything else leaves the outcome unknown: it settles, and closes the connection, as a socket
/// that drops does. It follows no redirect (spec 15.6): one answered to its connect fails it, its
/// status named, and one answered to a send or a listen is judged as any status nothing marks, its
/// <c>bead-refusal</c> unread. Each send carries its credential, when it has one, in the
/// <c>Authorization</c> field of its <c>POST</c>, as it is given; one that is no field's value —
/// anything but visible ASCII, spaces and tabs — is refused before it goes. An answer, and what a
/// listen brings back, carry none.
/// </summary>
/// <remarks>
/// What the server sends of its own, a client that listens — the default, once the server says it
/// back at connect — hears by a listen: a <c>GET</c> the server holds up to its wait, which brings
/// back a batch, each envelope heard as it comes whole. A listen lost is listened again from where
/// it was, at once, then later and later, drawn apart, until one reaches the server — or until its
/// inactivity timeout has passed, which loses the connection. It goes from
/// <see cref="ReadyState.Uninitialized"/> through Connecting and Open to Closing and Closed, and
/// connects again once Closed — or reconnects, with the options of its last connect.
/// </remarks>
public sealed class HttpTransportClient : IRouterClientTransport, IAsyncDisposable
{
    private const int LengthBytes = 4;

    // how long a disconnect waits on the server before it lets the connection go all the same: on
    // the real clock, since it bounds the platform's exchange against a server that does not
    // answer, never what Bead times
    private static readonly TimeSpan DisconnectTimeout = TimeSpan.FromSeconds(5);

    // how long it waits before listening again after its listens were lost: nothing after the first,
    // then a second, twice as long each time, up to 30 — each drawn between half of it and all of it
    private static readonly TimeSpan FirstRetry = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan LastRetry = TimeSpan.FromSeconds(30);

    private readonly HttpTransportClientOptions _options;
    private readonly TimeProvider _clock;
    private readonly int _maximumBodyBytes;

    // what every move from one state to another decides by
    private readonly Lock _gate = new();
    private volatile ReadyState _readyState = ReadyState.Uninitialized;
    private HttpClient? _http;

    // the options of the last connect its guard let through, which a reconnection connects with
    private HttpConnectOptions? _lastConnectOptions;

    // what aborts a connect under way: a dispose does
    private CancellationTokenSource? _connecting;

    // the connection the server drew; one this side let go of is none, and its end tells nothing
    private Drawn? _drawn;
    private Action? _reconnect;

    // how its events are told: what a listener throws is reported through Error
    private readonly ListenerGuard _listeners;

    /// <summary>
    /// A transport client, not yet connected, its durations held. An inactivity timeout neither
    /// infinite nor from 1 to <see cref="Clocks.LongestTimer"/> milliseconds, or a wait or a pause
    /// neither zero nor in that range, is an <see cref="ArgumentOutOfRangeException"/>; a handler
    /// given that would follow a redirect, an <see cref="ArgumentException"/> naming
    /// <c>AllowAutoRedirect</c>.
    /// </summary>
    public HttpTransportClient(HttpTransportClientOptions? options = null)
    {
        var given = options ?? new HttpTransportClientOptions();

        if (given.Handler is { } handler && IsFollowing(handler))
        {
            throw new ArgumentException("a handler given would follow a redirect, which the client follows none of: its AllowAutoRedirect is true (spec 15.6)", nameof(options));
        }

        // zero is at once for a delay: a listen again at once, and a listen the server answers at
        // once, which polls
        _options = given with
        {
            InactivityTimeout = Clocks.AssertHeld((nameof(HttpTransportClientOptions.InactivityTimeout), nameof(HttpTransportClientOptions.InactivityTimeout)), given.InactivityTimeout),
            Pause = Clocks.AssertHeldDelay((nameof(HttpTransportClientOptions.Pause), nameof(HttpTransportClientOptions.Pause)), given.Pause),
            Wait = Clocks.AssertHeldDelay((nameof(HttpTransportClientOptions.Wait), nameof(HttpTransportClientOptions.Wait)), given.Wait),
        };
        _clock = _options.Clock ?? TimeProvider.System;
        _maximumBodyBytes = _options.MaximumBodyBytes ?? LimitDefaults.MaximumEnvelopeBytes;
        _listeners = new ListenerGuard((reason, _) =>
        {
            Error?.Invoke(reason);
        });
    }

    /// <inheritdoc/>
    public event Action<TransportMessage>? Message;

    /// <summary>
    /// The connection closed: clean when this side's close was told so, never when the server or the
    /// network ended it; quick when this side dropped it. A connection a dispose drops, or a
    /// reconnection replaces, tells none.
    /// </summary>
    public event Action<bool, bool>? Close;

    /// <summary>
    /// What this side closed its connection for of its own, once, before its close (spec 15.1), an
    /// <see cref="InvalidDataException"/>: an envelope past
    /// <see cref="HttpTransportClientOptions.MaximumBodyBytes"/>, an answer's or a batch's, "the
    /// connection is closed: an envelope past its maximumBodyBytes, N bytes"; a batch that does not
    /// read, "the connection is closed: a batch that does not read, …", saying what of it does not;
    /// a listener that throws keeps the close told. A server gone, a refusal of its own, a redirect,
    /// a timeout, an answer of another type and a network that failed tell their close alone. And
    /// what a listener of its messages, its close or its reconnection threw: the client went on as
    /// if it returned.
    /// </summary>
    public event Action<Exception>? Error;

    /// <summary>
    /// A reconnection starts: what was sent on the connection it replaces will not be answered there.
    /// Each listener is told within its guard, its throw reported through <see cref="Error"/>, and the
    /// reconnection goes on. Reached through <see cref="IRouterClientTransport"/>:
    /// <see cref="Reconnect"/> names the method here.
    /// </summary>
    event Action? IRouterClientTransport.Reconnect
    {
        add
        {
            lock (_gate)
            {
                _reconnect += value;
            }
        }

        remove
        {
            lock (_gate)
            {
                _reconnect -= value;
            }
        }
    }

    /// <summary>Where it is in its life: Uninitialized until its first connect.</summary>
    public ReadyState ReadyState
    {
        get
        {
            return _readyState;
        }
    }

    /// <summary>What the stack built on it runs on: the clock its options gave, the system's when none.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>Whether the server took its listen at connect: what it sends of its own reaches this client.</summary>
    public bool IsListening
    {
        get
        {
            return _drawn?.IsListening ?? false;
        }
    }

    /// <summary>
    /// Connects: the server draws a connection, and its token is kept here, never shown. Refused with
    /// an <see cref="ArgumentOutOfRangeException"/> for a timeout
    /// <see cref="HttpConnectOptions.Timeout"/> does not take, zero among them, which leaves the state, and the target a
    /// reconnection replays, as they were; with an <see cref="InvalidOperationException"/> unless
    /// Uninitialized or Closed; and with an <see cref="OperationCanceledException"/>, nothing
    /// changed, when its token is cancelled already.
    /// Then it throws a <see cref="TimeoutException"/> past its timeout, an
    /// <see cref="OperationCanceledException"/> once its token is cancelled, and an
    /// <see cref="HttpRequestException"/> when the server draws none, ending Closed.
    /// </summary>
    public Task Connect(HttpConnectOptions options, CancellationToken cancellationToken = default)
    {
        return Connecting(options, (cancellationToken, false));
    }

    /// <summary>
    /// It carries any credential a field can hold beside an envelope, in the <c>Authorization</c> of
    /// each <c>POST</c> (spec 15.5): visible ASCII, spaces and tabs, none first or last.
    /// </summary>
    public bool Carries(string credential)
    {
        ArgumentNullException.ThrowIfNull(credential);

        return HostsAndOrigins.IsVisibleField(credential);
    }

    /// <summary>
    /// Whether it is secure, judged from the options of its last connect, never from what its host
    /// resolves to (spec 13.4): <c>https</c>, or a host on the loopback. None before its first connect.
    /// </summary>
    public bool IsSecure
    {
        get
        {
            lock (_gate)
            {
                return _lastConnectOptions is { } given && TransportSecurity.IsSecure((given.Secured, given.Host));
            }
        }
    }

    /// <summary>
    /// Posts one envelope, with its credential in the <c>Authorization</c> field when it has one,
    /// settling on the head of its answer; refused with a <see cref="DisconnectException"/> unless
    /// Open, and with an <see cref="ArgumentException"/>, its connection kept, for a credential no
    /// field carries. A refusal the server marks is an <see cref="IOException"/>: nothing of it was
    /// tried.
    /// </summary>
    public Task Send(TransportMessage message)
    {
        Drawn? connection;
        ReadyState readyState;

        lock (_gate)
        {
            connection = _drawn;
            readyState = _readyState;
        }

        if (readyState != ReadyState.Open || connection is null)
        {
            return Task.FromException(new DisconnectException($"the transport client is {NameOf(readyState)}, not open"));
        }

        // refused before it goes, the connection kept: a field could not carry it as it is (RFC 9110
        // §5.5), and one with a space or a tab first or last the server would read trimmed
        if (message.Credential is { } credential && !HostsAndOrigins.IsVisibleField(credential))
        {
            return Task.FromException(new ArgumentException("a credential holds visible ASCII, spaces and tabs alone, none first or last", nameof(message)));
        }

        return Posting((connection, message));
    }

    /// <summary>
    /// Deletes the connection — the server ends it first, so what waits there learns it, then what
    /// waits here goes — and raises its close, which says it was clean as
    /// <see cref="TransportDisconnectOptions.IsClean"/> does; quick, it lets the connection go at once,
    /// the server told unwaited. Refused with a <see cref="DisconnectException"/> unless Open.
    /// </summary>
    public async Task CloseConnection(TransportDisconnectOptions? options = null)
    {
        var isClean = options?.IsClean ?? true;
        var isQuick = options?.IsQuick ?? false;
        Drawn connection;

        lock (_gate)
        {
            if (_readyState != ReadyState.Open || _drawn is null)
            {
                throw new DisconnectException($"the transport client is {NameOf(_readyState)}, not open");
            }

            _readyState = ReadyState.Closing;
            connection = _drawn;
            _drawn = null;
        }

        if (isQuick)
        {
            await connection.Exchanges.CancelAsync();
            Release(connection);
        }
        else
        {
            try
            {
                using var deleting = new CancellationTokenSource(DisconnectTimeout, TimeProvider.System);
                using var deleted = await Deleting(connection, deleting.Token);
            }
            catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException)
            {
                // gone already, or unreachable: the connection ends here all the same
            }

            await connection.Exchanges.CancelAsync();
        }

        lock (_gate)
        {
            _readyState = ReadyState.Closed;
        }

        _listeners.Tell(Close, (isClean, isQuick));
    }

    /// <summary>
    /// Connects again with the options of the last connect its guard let through, replacing an open
    /// connection without a close, and raises <see cref="IRouterClientTransport.Reconnect"/> as it
    /// starts — as the WebSocket transport client does, attempt for attempt.
    /// </summary>
    public async Task Reconnect(TransportReconnectOptions? options = null)
    {
        var reconnect = options ?? new TransportReconnectOptions();
        var token = reconnect.CancellationToken;
        HttpConnectOptions target;
        Drawn? replaced;
        Action? starting;

        lock (_gate)
        {
            if (_readyState == ReadyState.Reconnecting)
            {
                throw new InvalidOperationException("the transport client is already reconnecting");
            }

            if (_lastConnectOptions is null)
            {
                throw new InvalidOperationException("the transport client was never connected");
            }

            if (_readyState is ReadyState.Connecting or ReadyState.Closing)
            {
                throw new InvalidOperationException($"the transport client cannot reconnect while {NameOf(_readyState)}");
            }

            // before the drop below, so a token cancelled already leaves an open connection alone
            if (token.IsCancellationRequested)
            {
                throw new OperationCanceledException(TransportReconnection.Cancelled, token);
            }

            // taken out as the state turns to reconnecting, so its end, however soon, tells nothing
            target = _lastConnectOptions;
            replaced = _drawn;
            _drawn = null;
            _readyState = ReadyState.Reconnecting;
            starting = _reconnect;
        }

        try
        {
            // each listener within its guard, its throw reported through Error; the connection
            // replaced goes whatever a listener of Error does
            try
            {
                _listeners.Tell(starting);
            }
            finally
            {
                if (replaced is not null)
                {
                    await replaced.Exchanges.CancelAsync();
                    Release(replaced);
                }
            }

            await TransportReconnection.Attempting(
                (token) =>
                {
                    return Connecting(target, (token, true));
                },
                (reconnect, _clock));

            // the last attempt opened as the token was cancelled: what it opened goes with it
            if (token.IsCancellationRequested)
            {
                try
                {
                    await CloseConnection();
                }
                catch (DisconnectException)
                {
                    // closed meanwhile: there is nothing left to close
                }

                throw new OperationCanceledException(TransportReconnection.Cancelled, token);
            }
        }
        catch
        {
            lock (_gate)
            {
                _readyState = ReadyState.Closed;
            }

            throw;
        }
    }

    /// <summary>
    /// Closes an open connection as <see cref="CloseConnection"/> does, its close raised; otherwise
    /// lets go of what it holds — a connect under way fails — and of its HTTP client, which a next
    /// connect builds anew.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_readyState == ReadyState.Open)
        {
            try
            {
                await CloseConnection();
            }
            catch (DisconnectException)
            {
                // closed or replaced meanwhile: what is left is dropped below
            }
        }

        CancellationTokenSource? connecting;
        Drawn? connection;
        HttpClient? http;

        lock (_gate)
        {
            connecting = _connecting;
            connection = _drawn;
            _connecting = null;
            _drawn = null;

            if (_readyState == ReadyState.Open)
            {
                _readyState = ReadyState.Closed;
            }

            http = _readyState == ReadyState.Reconnecting ? null : _http;
            _http = http is null ? _http : null;
        }

        if (connecting is not null)
        {
            await connecting.CancelAsync();
        }

        if (connection is not null)
        {
            await connection.Exchanges.CancelAsync();
            Release(connection);
        }

        http?.Dispose();
    }

    // * what this side closes a connection for of its own, as its Error tells it before its close
    // (spec 15.1): an envelope past its bound, named with its value, as a WebSocket's 1009 is
    private static InvalidDataException PastBoundOf(int maximumBodyBytes)
    {
        return new InvalidDataException(string.Create(CultureInfo.InvariantCulture, $"the connection is closed: an envelope past its maximumBodyBytes, {maximumBodyBytes} bytes"));
    }

    // and a batch that does not read, saying what of it does not, as a WebSocket's protocol error
    private static (Listened, InvalidDataException?) UnreadOf(string why)
    {
        return (Listened.Broken, new InvalidDataException($"the connection is closed: a batch that does not read, {why}"));
    }

    // a state as a message words it: "open", "closing"…
    private static string NameOf(ReadyState readyState)
    {
        return readyState.ToString().ToLowerInvariant();
    }

    // http://host:port/pathname, or https://; an IPv6 literal bracketed, or its colons would read as
    // the port's
    private static Uri UriOf(HttpConnectOptions options)
    {
        var host = options.Host.Contains(':') && !options.Host.StartsWith('[') ? $"[{options.Host}]" : options.Host;
        var path = options.Pathname.StartsWith('/') ? options.Pathname : $"/{options.Pathname}";

        return new Uri($"{(options.Secured ? "https" : "http")}://{host}:{options.Port}{path}");
    }

    // the media type of a response, parameters aside
    private static string? TypeOf(HttpResponseMessage response)
    {
        return response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant();
    }

    private static string? HeaderOf(HttpResponseMessage response, string name)
    {
        return response.Headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;
    }

    // a field of Bead's the server writes, read as an Item of RFC 9651, its lines joined by ", "
    // (RFC 9110 §5.3) and its parameters ignored (§2.3); none when absent or when it does not parse
    private static StructuredFields.Item? ItemOf(HttpResponseMessage response, string name)
    {
        return response.Headers.TryGetValues(name, out var values) ? StructuredFields.ParseItem(string.Join(", ", values)) : null;
    }

    // whether a handler given would follow a redirect: the platform's own, innermost of the
    // delegating handlers around it, says so by its AllowAutoRedirect; one of another kind cannot be
    // read, and is taken, the check of each answer standing behind it
    private static bool IsFollowing(HttpMessageHandler handler)
    {
        var innermost = handler;

        while (innermost is DelegatingHandler { InnerHandler: { } inner })
        {
            innermost = inner;
        }

        return innermost switch
        {
            HttpClientHandler platform => platform.AllowAutoRedirect,
            SocketsHttpHandler platform => platform.AllowAutoRedirect,
            _ => false,
        };
    }

    // a redirect, by Fetch's redirect statuses: a 300 and a 304 are none, statuses like any other
    private static bool IsRedirect(HttpResponseMessage response)
    {
        return response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;
    }

    // ! whether a handler followed a redirect all the same: the request its answer names went
    // elsewhere than `sent`, the URI the exchange was sent to, since a following handler moves the
    // request's own in place. A handler that builds its own answer leaves RequestMessage null, the
    // tests' among them, and reads as not followed; Uri's equality ignores a default port and the
    // host's case
    private static bool IsFollowed((HttpResponseMessage Response, Uri Sent) answered)
    {
        return answered.Response.RequestMessage?.RequestUri is { } went && went != answered.Sent;
    }

    // how long to wait before listening again after `losses` listens lost in a row, drawn apart so
    // the clients one restart dropped together come back apart, as EventSource's do; in whole
    // milliseconds, as every wait of Bead's
    private static TimeSpan RetryDelayOf(int losses)
    {
        if (losses == 1)
        {
            return TimeSpan.Zero;
        }

        var delay = TimeSpan.FromTicks(Math.Min(LastRetry.Ticks, FirstRetry.Ticks * (1L << Math.Min(losses - 2, 30))));
        var drawn = (delay / 2) + (delay / 2 * Random.Shared.NextDouble());

        return TimeSpan.FromMilliseconds(Math.Floor(drawn.TotalMilliseconds));
    }

    // the HTTP client its exchanges go through, built as a connect needs it
    private HttpClient HttpOf()
    {
        lock (_gate)
        {
            return _http ??= NewHttp();
        }
    }

    // its own handler races the address families of a name, as RFC 8305 asks, where the
    // platform's tries each address in turn
    private HttpClient NewHttp()
    {
        return _options.Handler is { } handler
            ? new HttpClient(handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan }
            : new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, ConnectCallback = HappyEyeballs.ConnectCallback }) { Timeout = Timeout.InfiniteTimeSpan };
    }

    // a request carrying the connection's token, as each exchange after the connect does
    private static HttpRequestMessage RequestOf(Drawn connection, (HttpMethod Method, Uri Uri) target)
    {
        var request = new HttpRequestMessage(target.Method, target.Uri);

        request.Headers.Add(HttpTransport.ConnectionTokenHeader, connection.ConnectionToken);

        return request;
    }

    private Task<HttpResponseMessage> Deleting(Drawn connection, CancellationToken cancellationToken)
    {
        return HttpOf().SendAsync(RequestOf(connection, (HttpMethod.Delete, connection.Uri)), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }

    // a DELETE nobody waits on: the server told the connection goes. Once a dispose let go of the
    // HTTP client, it goes through one of its own, let go of in turn, so none outlives the client
    private void Release(Drawn connection)
    {
        HttpClient? own;
        HttpClient http;

        lock (_gate)
        {
            own = _http is null ? NewHttp() : null;
            http = _http ?? own!;
        }

        _ = Released();

        async Task Released()
        {
            try
            {
                using var deleting = new CancellationTokenSource(DisconnectTimeout, TimeProvider.System);
                using var request = RequestOf(connection, (HttpMethod.Delete, connection.Uri));
                using var deleted = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deleting.Token);
            }
            catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException or ObjectDisposedException)
            {
                // gone already, or unreachable: nothing more is owed
            }
            finally
            {
                own?.Dispose();
            }
        }
    }

    // the connection is gone: its exchanges abort, and the client closes, as over a socket dropped
    private void Lose(Drawn connection, bool isReleased)
    {
        Ended(connection, (isReleased, null));
    }

    // the connection this side closes of its own, released: why goes to Error before its close
    private void Fail(Drawn connection, InvalidDataException failure)
    {
        Ended(connection, (true, failure));
    }

    // * its end: its exchanges cut, the server told when it is released, then its one error, then
    // its close, told even when a listener of Error throws, which goes on to the task no one awaits,
    // the platform's (spec 15.1)
    private void Ended(Drawn connection, (bool IsReleased, InvalidDataException? Failure) end)
    {
        var (isReleased, failure) = end;
        bool isClosing;

        lock (_gate)
        {
            if (_drawn != connection)
            {
                return;
            }

            _drawn = null;
            isClosing = _readyState != ReadyState.Reconnecting;

            if (isClosing)
            {
                _readyState = ReadyState.Closed;
            }
        }

        connection.Exchanges.Cancel();

        if (isReleased)
        {
            Release(connection);
        }

        if (isClosing)
        {
            try
            {
                if (failure is not null)
                {
                    Error?.Invoke(failure);
                }
            }
            finally
            {
                _listeners.Tell(Close, (false, false));
            }
        }
    }

    // a connect, or a reconnection's attempt, which its guard alone tells apart: an attempt passes
    // only while the client reconnects, and leaves the state to its reconnection when it fails
    private async Task Connecting(HttpConnectOptions given, (CancellationToken Token, bool IsAttempt) call)
    {
        ArgumentNullException.ThrowIfNull(given);

        // held before anything moves or is kept, so a reconnection connects again with it held
        var options = given with
        {
            Timeout = Clocks.AssertHeld(("a connect's timeout", nameof(HttpConnectOptions.Timeout)), given.Timeout),
        };
        var (token, isAttempt) = call;
        var uri = UriOf(options);
        CancellationTokenSource connecting;

        lock (_gate)
        {
            if (isAttempt ? _readyState != ReadyState.Reconnecting : _readyState is not (ReadyState.Uninitialized or ReadyState.Closed))
            {
                throw new InvalidOperationException($"the transport client is already {NameOf(_readyState)}");
            }

            _lastConnectOptions = options;

            // honoured before anything moves, so one cancelled already leaves the state as it was
            token.ThrowIfCancellationRequested();

            if (!isAttempt)
            {
                _readyState = ReadyState.Connecting;
            }

            connecting = _connecting = new CancellationTokenSource();
        }

        Drawn connection;

        try
        {
            using var timeout = options.Timeout > TimeSpan.Zero ? new CancellationTokenSource(options.Timeout, _clock) : null;
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, connecting.Token, timeout?.Token ?? CancellationToken.None);
            using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new ByteArrayContent([]) };

            request.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);

            if (_options.IsListening)
            {
                request.Headers.Add(HttpTransport.ListenHeader, "?1");
            }

            HttpResponseMessage response;

            try
            {
                var opening = HttpOf().SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token);
                try
                {
                    response = await opening.WaitAsync(linked.Token);
                }
                catch
                {
                    _ = opening.ContinueWith((completed) =>
                    {
                        if (completed.IsCompletedSuccessfully)
                        {
                            using var late = completed.Result;
                            if (!IsFollowed((late, uri)) && late.StatusCode == HttpStatusCode.Created && HeaderOf(late, HttpTransport.ConnectionTokenHeader) is { } lateToken)
                            {
                                Release(new Drawn((lateToken, uri), false));
                            }
                        }
                        else { _ = completed.Exception; }
                    }, CancellationToken.None, TaskContinuationOptions.NotOnCanceled, TaskScheduler.Default);
                    throw;
                }
            }
            catch (OperationCanceledException reason) when (timeout is { IsCancellationRequested: true } && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"timed out after {options.Timeout.TotalMilliseconds}ms"), reason);
            }
            catch (OperationCanceledException reason) when (connecting.IsCancellationRequested && !token.IsCancellationRequested)
            {
                throw new HttpRequestException("the transport client was disposed as it connected", reason);
            }

            using (response)
            {
                // answered from a place it never judged: what was drawn there is none of its own,
                // and ends by its own inactivity timeout
                if (IsFollowed((response, uri)))
                {
                    throw new HttpRequestException("the server drew no connection: a redirect followed");
                }

                // a redirect is no refusal of the transport's own: its mark is left unread
                if (IsRedirect(response))
                {
                    throw new HttpRequestException($"the server drew no connection: {(int)response.StatusCode}");
                }

                var connectionToken = HeaderOf(response, HttpTransport.ConnectionTokenHeader);

                if (response.StatusCode != HttpStatusCode.Created || connectionToken is null)
                {
                    // named by its status, and by its mark where it is a refusal of the transport's
                    // own (spec 15.6)
                    var mark = HeaderOf(response, HttpTransport.RefusalHeader) is { } refusal ? $" {refusal}" : "";

                    throw new HttpRequestException($"the server drew no connection: {(int)response.StatusCode}{mark}");
                }

                // taken where the server said it back, and nowhere else
                connection = new Drawn((connectionToken, uri), _options.IsListening && ItemOf(response, HttpTransport.ListenHeader)?.BareItem is true);
            }

            lock (_gate)
            {
                // a dispose as it opened let it go: there is nothing to keep
                if (_connecting != connecting)
                {
                    Release(connection);

                    throw new HttpRequestException("the transport client was disposed as it connected");
                }

                _connecting = null;
                _drawn = connection;
                _readyState = ReadyState.Open;
            }
        }
        catch
        {
            lock (_gate)
            {
                if (_connecting == connecting)
                {
                    _connecting = null;
                }

                if (!isAttempt)
                {
                    _readyState = ReadyState.Closed;
                }
            }

            throw;
        }
        finally
        {
            connecting.Dispose();
        }

        if (connection.IsListening)
        {
            _ = Listening(connection);
        }
    }

    // one envelope posted, settling on the head of its answer, the answer itself read after: a
    // caller waiting on it resumes as it settles, before what follows, as a rejection's handlers run
    // before a timer of 0
    private Task Posting((Drawn Connection, TransportMessage Message) sent)
    {
        var settled = new TaskCompletionSource();

        // what none of its outcomes expected settles it, unless one did
        _ = Exchanging(sent, settled).ContinueWith(
            (exchanging) =>
            {
                settled.TrySetException(exchanging.Exception!.InnerExceptions);
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return settled.Task;
    }

    private async Task Exchanging((Drawn Connection, TransportMessage Message) sent, TaskCompletionSource settled)
    {
        var (connection, message) = sent;
        HttpResponseMessage response;

        try
        {
            using var request = RequestOf(connection, (HttpMethod.Post, connection.Uri));

            // as it is given: a header parsed would be written again its own way
            if (message.Credential is { } credential)
            {
                request.Headers.TryAddWithoutValidation(Microsoft.Net.Http.Headers.HeaderNames.Authorization, credential);
            }

            request.Content = new ReadOnlyMemoryContent(message.Bytes);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(HttpTransport.MediaType);
            response = await HttpOf().SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connection.Exchanges.Token);
        }
        catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException or ObjectDisposedException)
        {
            // lost before its head: whether the server had it is not known, so it counts as handed
            // over, and the connection closes, as a dropped socket's
            Lose(connection, true);
            settled.SetResult();

            return;
        }

        // followed all the same: nothing the other place answered is heard, and whether the server
        // had it is not known
        if (IsFollowed((response, connection.Uri)))
        {
            response.Dispose();
            Lose(connection, true);
            settled.SetResult();

            return;
        }

        if (response.IsSuccessStatusCode)
        {
            _ = Answering((connection, response));
            settled.SetResult();

            return;
        }

        using (response)
        {
            // a status nothing marked — a gateway's — or a redirect, its mark unread, says nothing of
            // whether the server had it: lost
            if (IsRedirect(response) || HeaderOf(response, HttpTransport.RefusalHeader) is not { } refusal)
            {
                Lose(connection, true);
                settled.SetResult();

                return;
            }

            // refused by the transport before the router saw it: nothing of it was tried
            settled.SetException(new IOException($"the server refused the exchange: {(int)response.StatusCode} {refusal}"));

            // its connection gone: told after the refusal is heard, so its caller learns first that
            // it was never tried
            if (refusal == HttpRefusals.ConnectionUnknown)
            {
                Lose(connection, false);
            }
        }
    }

    // the answer a 200 carries, read up to an envelope's limit; anything else loses the connection
    private async Task Answering((Drawn Connection, HttpResponseMessage Response) answered)
    {
        var (connection, response) = answered;

        using (response)
        {
            if (response.StatusCode != HttpStatusCode.OK)
            {
                return;
            }

            if (TypeOf(response) != HttpTransport.MediaType)
            {
                Lose(connection, true);

                return;
            }

            if (response.Content.Headers.ContentLength > _maximumBodyBytes)
            {
                Fail(connection, PastBoundOf(_maximumBodyBytes));

                return;
            }

            byte[] body;

            try
            {
                body = await response.Content.ReadAsByteArrayAsync(connection.Exchanges.Token);
            }
            catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException or ObjectDisposedException)
            {
                Lose(connection, true);

                return;
            }

            if (body.Length > _maximumBodyBytes)
            {
                Fail(connection, PastBoundOf(_maximumBodyBytes));

                return;
            }

            // an exchange ended empty — cancelled — has nothing to say, and one past its connection's
            // end — lost, or disconnecting — is no answer of this one's
            if (body.Length > 0 && _drawn == connection)
            {
                Hear(body, false);
            }
        }
    }

    // listened for while the connection stands: a listen lost is listened again from where it was —
    // at once, then later and later — until one reaches the server, which says whether the
    // connection stands, or until the inactivity timeout has ended since the first was lost
    private async Task Listening(Drawn connection)
    {
        var cursor = new Cursor();
        var losses = 0;

        // the inactivity timeout, armed at a first loss, on a timer: a clock read against a timer
        // can disagree with it by a moment, enough to buy a listen more. Once it ends, the listen
        // after it, or the one in flight, is the last
        CancellationTokenSource? expiring = null;

        try
        {
            while (_drawn == connection)
            {
                var (listened, failure) = await ListenOnce((connection, cursor));

                if (failure is not null)
                {
                    Fail(connection, failure);

                    return;
                }

                if (listened == Listened.Lost)
                {
                    losses += 1;

                    if (losses == 1 && _options.InactivityTimeout != Timeout.InfiniteTimeSpan)
                    {
                        expiring = new CancellationTokenSource(_options.InactivityTimeout, _clock);
                    }

                    if (expiring is { IsCancellationRequested: true })
                    {
                        Lose(connection, true);

                        return;
                    }

                    await PauseFor((connection, RetryDelayOf(losses)), expiring?.Token ?? CancellationToken.None);

                    continue;
                }

                if (listened is not (Listened.Heard or Listened.Nothing))
                {
                    Lose(connection, listened != Listened.Gone);

                    return;
                }

                // it reached the server: the count ends, its timer with it
                expiring?.Dispose();
                expiring = null;
                losses = 0;

                if (listened == Listened.Nothing)
                {
                    await PauseFor((connection, _options.Pause), CancellationToken.None);
                }
            }
        }
        finally
        {
            // the connection's end disarms it: nothing fires after it
            expiring?.Dispose();
        }
    }

    // an envelope an answer or a listen brought back, which carry no credential, what a listen
    // brought back marked as what may overtake an answer (spec 15.9); a listener that throws stops
    // nothing: its throw is reported through Error, and the client goes on
    private void Hear(byte[] envelope, bool mayOvertake)
    {
        _listeners.Tell(Message, new TransportMessage(envelope, false) { MayOvertake = mayOvertake });
    }

    // a wait between two listens, which the connection's end cuts short, and so does the end of the
    // inactivity timeout, when one runs
    private async Task PauseFor((Drawn Connection, TimeSpan Delay) pause, CancellationToken expiring)
    {
        if (pause.Delay <= TimeSpan.Zero)
        {
            return;
        }

        using var cut = CancellationTokenSource.CreateLinkedTokenSource(pause.Connection.Exchanges.Token, expiring);

        try
        {
            await Task.Delay(pause.Delay, _clock, cut.Token);
        }
        catch (OperationCanceledException)
        {
            // the connection went, and the listening ends; or the timeout did, and the next is the last
        }
    }

    // one listen: each envelope heard as it comes whole, the cursor advanced before — or what came
    // instead, the error that fails the connection among it
    private async Task<(Listened Outcome, InvalidDataException? Failure)> ListenOnce((Drawn Connection, Cursor Cursor) listen)
    {
        var (connection, cursor) = listen;
        HttpResponseMessage response;

        try
        {
            // at the connection's one URL, its cursor and its wait in fields of their own (spec 15.9)
            using var request = RequestOf(connection, (HttpMethod.Get, connection.Uri));

            request.Headers.Add(HttpTransport.AfterHeader, cursor.After.ToString(CultureInfo.InvariantCulture));
            request.Headers.Add(HttpTransport.WaitHeader, ((long)_options.Wait.TotalMilliseconds).ToString(CultureInfo.InvariantCulture));
            response = await HttpOf().SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connection.Exchanges.Token);
        }
        catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException or ObjectDisposedException)
        {
            return (Listened.Lost, null);
        }

        using (response)
        {
            // followed all the same: its batch is none of this connection's, and listening again
            // would go through the same handler
            if (IsFollowed((response, connection.Uri)))
            {
                return (Listened.Followed, null);
            }

            if (response.StatusCode != HttpStatusCode.OK || TypeOf(response) != HttpTransport.BatchMediaType)
            {
                if (response.StatusCode == HttpStatusCode.NoContent)
                {
                    return (Listened.Nothing, null);
                }

                // a redirect, its mark unread, is lost as any status nothing marks
                if (IsRedirect(response))
                {
                    return (Listened.Lost, null);
                }

                var refusal = HeaderOf(response, HttpTransport.RefusalHeader);

                return (refusal is null ? Listened.Lost : refusal == HttpRefusals.ConnectionUnknown ? Listened.Gone : Listened.Refused, null);
            }

            // numbered from the one after the last it heard, or it is no batch of this listen's
            if (ItemOf(response, HttpTransport.SequenceHeader)?.BareItem as long? != cursor.After + 1)
            {
                return UnreadOf(string.Create(CultureInfo.InvariantCulture, $"its bead-sequence not {cursor.After + 1}"));
            }

            var heard = 0;

            try
            {
                using var stream = await response.Content.ReadAsStreamAsync(connection.Exchanges.Token);
                var length = new byte[LengthBytes];

                while (true)
                {
                    // a batch ends where an envelope ends
                    var lengthRead = await stream.ReadAtLeastAsync(length, LengthBytes, false, connection.Exchanges.Token);

                    if (lengthRead == 0)
                    {
                        break;
                    }

                    var bytes = BinaryPrimitives.ReadUInt32BigEndian(length);

                    if (lengthRead < LengthBytes)
                    {
                        return UnreadOf("it ends within an envelope");
                    }

                    if (bytes == 0)
                    {
                        return UnreadOf("an envelope of 0 bytes");
                    }

                    if (bytes > _maximumBodyBytes)
                    {
                        return (Listened.Broken, PastBoundOf(_maximumBodyBytes));
                    }

                    var envelope = new byte[bytes];

                    if (await stream.ReadAtLeastAsync(envelope, envelope.Length, false, connection.Exchanges.Token) < envelope.Length)
                    {
                        return UnreadOf("it ends within an envelope");
                    }

                    // gone as it was heard: what is left goes unheard
                    if (_drawn != connection)
                    {
                        return (Listened.Heard, null);
                    }

                    cursor.After += 1;
                    heard += 1;
                    Hear(envelope, true);
                }
            }
            catch (Exception reason) when (reason is HttpRequestException or OperationCanceledException or IOException or ObjectDisposedException)
            {
                // cut on its way: what came whole was heard, and the rest comes again
                return (heard > 0 ? Listened.Heard : Listened.Lost, null);
            }

            return heard > 0 ? (Listened.Heard, null) : UnreadOf("it holds no envelope");
        }
    }

    // what came of one listen
    private enum Listened
    {
        Heard,
        Nothing,
        Lost,
        Gone,
        Refused,
        Followed,
        Broken,
    }

    // the number of the last envelope a listen heard, which the next acknowledges
    private sealed class Cursor
    {
        public long After { get; set; }
    }

    // a connection the server drew: its token, where its exchanges go, whether the server took its
    // listen, and what aborts its exchanges
    private sealed class Drawn((string ConnectionToken, Uri Uri) names, bool isListening)
    {
        public string ConnectionToken { get; } = names.ConnectionToken;

        public Uri Uri { get; } = names.Uri;

        public bool IsListening { get; } = isListening;

        public CancellationTokenSource Exchanges { get; } = new();
    }
}
