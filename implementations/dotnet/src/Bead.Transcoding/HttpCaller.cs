using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Bead.Protobuf;
using Google.Protobuf;

namespace Bead.Transcoding;

/// <summary>A generated HTTP client's handler, default authorization and body bound.</summary>
public sealed record HttpCallerOptions
{
    /// <summary>Its HTTP handler, which follows no redirect; a handler of its own when none.</summary>
    public HttpMessageHandler? Handler { get; init; }

    /// <summary>The Authorization field every call presents unless it gives its own or omits it.</summary>
    public string? Authorization { get; init; }

    /// <summary>The largest unary body or event, in bytes; the gateway's body bound by default.</summary>
    public int MaximumBodyBytes { get; init; } = LimitDefaults.MaximumEnvelopeBytes;
}

/// <summary>A call's authorization and cancellation; WithoutAuthorization overrides either field.</summary>
public sealed record HttpCallOptions
{
    /// <summary>The Authorization field this call presents instead of the default.</summary>
    public string? Authorization { get; init; }

    /// <summary>Whether this call presents no authorization, whatever its default.</summary>
    public bool WithoutAuthorization { get; init; }

    /// <summary>What cancels this call or its stream.</summary>
    public CancellationToken CancellationToken { get; init; }

    internal bool Stream { get; init; }
}

/// <summary>A stream's result or notification, with its kind explicit.</summary>
/// <typeparam name="TResult">Its result's type.</typeparam>
/// <typeparam name="TNotification">Its notification's type.</typeparam>
public sealed record HttpEvent<TResult, TNotification>
{
    /// <summary>Whether this is the stream's first event, its result.</summary>
    public required bool IsResult { get; init; }

    /// <summary>The result when IsResult is true.</summary>
    public TResult? Result { get; init; }

    /// <summary>The notification when IsResult is false.</summary>
    public TNotification? Notification { get; init; }
}

/// <summary>
/// The client half of transcoding (decision 0037, design 3.17): default POST routes, Bead's JSON
/// mapping, problems as failures, and an event stream carrying the caller's authorization.
/// </summary>
public sealed class HttpCaller : IDisposable
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly HttpClient _http;
    private readonly Uri _url;
    private readonly HttpCallerOptions _options;
    private readonly JsonForm _form;

    /// <summary>Its generated route table, gateway base URL and HTTP options.</summary>
    public HttpCaller(IReadOnlyList<HttpRoute> routes, Uri url, HttpCallerOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(routes);
        ArgumentNullException.ThrowIfNull(url);

        if (!url.IsAbsoluteUri || (url.Scheme != "http" && url.Scheme != "https") || url.UserInfo.Length != 0 || url.Query.Length != 0 || url.Fragment.Length != 0)
        {
            throw new ArgumentException("an HTTP client URL uses HTTP or HTTPS without user information, query or fragment", nameof(url));
        }

        _options = options ?? new HttpCallerOptions();

        if (_options.MaximumBodyBytes < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "maximumBodyBytes is a whole number above 0");
        }

        var handler = _options.Handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, ConnectCallback = HappyEyeballs.ConnectCallback };
        HttpRedirects.AssertHandler(handler, nameof(options));

        _url = url;
        _http = new HttpClient(handler, disposeHandler: _options.Handler is null) { Timeout = Timeout.InfiniteTimeSpan };
        _form = new JsonForm(routes.SelectMany((route) =>
        {
            return new[] { route.Request.Descriptor, route.Result.Descriptor, route.Notification?.Descriptor }.OfType<Google.Protobuf.Reflection.MessageDescriptor>();
        }));
    }

    /// <summary>Calls a procedure on its default route and reads its typed result.</summary>
    /// <typeparam name="TResult">The result's generated type.</typeparam>
    public async Task<TResult> Call<TResult>(HttpRoute route, object? value, HttpCallOptions? options = null)
    {
        using var response = await Send(route, value, options).ConfigureAwait(false);

        if (!string.Equals(response.Content.Headers.ContentType?.MediaType, MediaTypeOf(route.Result), StringComparison.OrdinalIgnoreCase))
        {
            throw Invalid("the HTTP result has another media type");
        }

        var bytes = await Whole(response.Content, options?.CancellationToken ?? default).ConfigureAwait(false);

        return Read<TResult>(route.Result, bytes);
    }

    /// <summary>Reads a procedure's result then notifications; an ended or truncated stream fails, and never reconnects.</summary>
    /// <typeparam name="TResult">The result's generated type.</typeparam>
    /// <typeparam name="TNotification">The notification's generated type.</typeparam>
    public IAsyncEnumerable<HttpEvent<TResult, TNotification>> Subscribe<TResult, TNotification>(HttpRoute route, object? value, HttpCallOptions? options = null)
    {
        return SubscribeCore<TResult, TNotification>((route, value, options), options?.CancellationToken ?? default);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        _http.Dispose();
    }

    private async IAsyncEnumerable<HttpEvent<TResult, TNotification>> SubscribeCore<TResult, TNotification>(
        (HttpRoute Route, object? Value, HttpCallOptions? Options) call,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var (route, value, options) = call;

        if (route.Notification is null)
        {
            throw new ArgumentException("only a notifying HTTP procedure opens a stream", nameof(call));
        }

        using var response = await Send(route, value, (options ?? new HttpCallOptions()) with { CancellationToken = cancellationToken, Stream = true }).ConfigureAwait(false);

        if (!string.Equals(response.Content.Headers.ContentType?.MediaType, "text/event-stream", StringComparison.OrdinalIgnoreCase))
        {
            throw Invalid("the HTTP subscription answers no event stream");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var hasResult = false;

        await foreach (var (name, data) in Events(stream, cancellationToken).ConfigureAwait(false))
        {
            if (name == "failure")
            {
                throw FailureOf(Utf8.GetBytes(data));
            }

            if ((!hasResult && name != "result") || (hasResult && name is not ("" or "message")))
            {
                throw Invalid("the HTTP event stream holds one result then notifications");
            }

            yield return hasResult
                ? new HttpEvent<TResult, TNotification> { IsResult = false, Notification = EventValue<TNotification>(route.Notification, data) }
                : new HttpEvent<TResult, TNotification> { IsResult = true, Result = EventValue<TResult>(route.Result, data) };
            hasResult = true;
        }
    }

    private async IAsyncEnumerable<(string Name, string Data)> Events(Stream stream, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        using var line = new MemoryStream();
        var data = new List<string>();
        var name = "";
        var size = 0;
        var skipLf = false;
        var firstLine = true;

        for (; ; )
        {
            var count = await ReadChunk(stream, (buffer, cancellationToken)).ConfigureAwait(false);

            if (count == 0)
            {
                _ = Decode(line.GetBuffer().AsSpan(0, (int)line.Length));
                throw LocalFailure(ProtocolCode.DestinationLost, "the HTTP event stream ends without a failure");
            }

            for (var index = 0; index < count; index++)
            {
                var octet = buffer[index];

                if (skipLf && octet == 10)
                {
                    skipLf = false;
                    continue;
                }

                skipLf = octet == 13;

                if (octet is not (10 or 13))
                {
                    if (++size > _options.MaximumBodyBytes)
                    {
                        throw LocalFailure(ProtocolCode.PayloadTooLarge, "the HTTP event passes maximumBodyBytes");
                    }

                    line.WriteByte(octet);
                    continue;
                }

                var lineLength = (int)line.Length;
                var text = Decode(line.GetBuffer().AsSpan(0, lineLength));

                if (firstLine)
                {
                    text = text.StartsWith('\uFEFF') ? text[1..] : text;
                    firstLine = false;
                }
                line.SetLength(0);

                if (text.Length == 0)
                {
                    if (data.Count > 0)
                    {
                        yield return (name, string.Join('\n', data));
                    }

                    data.Clear();
                    name = "";
                    size = 0;
                }
                else if (text.StartsWith("event:", StringComparison.Ordinal))
                {
                    name = FieldValue(text[6..]);
                }
                else if (text.StartsWith("data:", StringComparison.Ordinal))
                {
                    data.Add(FieldValue(text[5..]));
                }
                else if (text.StartsWith(':'))
                {
                    size -= lineLength;
                }
            }
        }
    }

    private static string FieldValue(string text)
    {
        return text.StartsWith(' ') ? text[1..] : text;
    }

    private async Task<HttpResponseMessage> Send(HttpRoute route, object? value, HttpCallOptions? options)
    {
        ArgumentNullException.ThrowIfNull(route);
        var template = route.Routes.Count == 0 ? null : route.Routes[0];

        if (template is not { Method: "POST", Body: "*", ResponseBody: null } || template.Template.Contains('{', StringComparison.Ordinal))
        {
            throw new ArgumentException("an HTTP client calls a default POST route with a whole body and result", nameof(route));
        }

        var baseUrl = new UriBuilder(_url) { Path = _url.AbsolutePath.TrimEnd('/') + "/" }.Uri;
        var target = new Uri(baseUrl, template.Template.StartsWith('/') ? template.Template[1..] : template.Template);

        if (target.GetLeftPart(UriPartial.Authority) != _url.GetLeftPart(UriPartial.Authority))
        {
            throw new ArgumentException("an HTTP route stays on its gateway origin", nameof(route));
        }

        var authorization = options?.WithoutAuthorization == true ? null : options?.Authorization ?? _options.Authorization;

        if (authorization is not null && !HostsAndOrigins.IsVisibleField(authorization))
        {
            throw new ArgumentException("a credential holds visible ASCII, spaces and tabs alone, none first or last", nameof(options));
        }

        authorization = authorization == "" ? null : authorization;

        if (authorization is not null && !TransportSecurity.IsSecure((target.Scheme == "https", target.Host)))
        {
            throw new FailureException(Failure.OfProtocol(ProtocolCode.DestinationUnreachable), new FailureException.Raised(FailureOrigin.Local, RouterSide.Client));
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, target) { Content = new ByteArrayContent(Write(route.Request, value)) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(MediaTypeOf(route.Request));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(options?.Stream == true ? "text/event-stream" : MediaTypeOf(route.Result)));

        if (authorization is not null && !request.Headers.TryAddWithoutValidation("Authorization", authorization))
        {
            throw new ArgumentException("Authorization is an HTTP field value", nameof(options));
        }

        var cancelled = options?.CancellationToken ?? default;
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancelled).ConfigureAwait(false);

        try
        {
            if (response.RequestMessage?.RequestUri != target || (int)response.StatusCode is >= 300 and < 400)
            {
                throw StatusFailure((int)response.StatusCode, (null, RetryOf(response), null, false));
            }

            if ((int)response.StatusCode != 200)
            {
                if (string.Equals(response.Content.Headers.ContentType?.MediaType, "application/problem+json", StringComparison.OrdinalIgnoreCase))
                {
                    throw FailureOf(await Whole(response.Content, cancelled).ConfigureAwait(false), response);
                }

                throw StatusFailure((int)response.StatusCode, (null, RetryOf(response), null, false));
            }

            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    // ! a proto value judged by its required fields first (spec 17.9.7), as the codec's writer
    // judges one: its FormatException thrown before anything goes, as the TypeScript side's codec
    // throws before it writes
    private byte[] Write(HttpPayload payload, object? value)
    {
        return payload.Encoding switch
        {
            HttpEncoding.Proto => _form.Write(Judged((IMessage)value!)),
            HttpEncoding.Json => PayloadCodecs.Json.Encode((JsonElement)value!).ToArray(),
            HttpEncoding.Text => PayloadCodecs.Text.Encode((string)value!).ToArray(),
            HttpEncoding.Raw => ((ReadOnlyMemory<byte>)value!).ToArray(),
            _ => throw new ArgumentException("an HTTP payload names a supported encoding", nameof(payload)),
        };
    }

    private static IMessage Judged(IMessage message)
    {
        ProtoRequired.Check(message);

        return message;
    }

    private TResult Read<TResult>(HttpPayload payload, ReadOnlyMemory<byte> bytes)
    {
        try
        {
            object result = payload.Encoding switch
            {
                HttpEncoding.Proto => _form.Read(payload.Descriptor!, bytes.Span),
                HttpEncoding.Json => PayloadCodecs.Json.Decode(bytes),
                HttpEncoding.Text => PayloadCodecs.Text.Decode(bytes),
                HttpEncoding.Raw => bytes,
                _ => throw new ArgumentException("an HTTP payload names a supported encoding", nameof(payload)),
            };

            var length = result switch
            {
                IMessage message => message.CalculateSize(),
                JsonElement json => PayloadCodecs.Json.Encode(json).Length,
                string text => Utf8.GetByteCount(text),
                ReadOnlyMemory<byte> raw => raw.Length,
                _ => 0,
            };

            if (length > LimitDefaults.MaximumEnvelopeBytes)
            {
                throw LocalFailure(ProtocolCode.PayloadTooLarge, "the HTTP payload passes maximumEnvelopeBytes");
            }

            return (TResult)result;
        }
        catch (Exception cause) when (cause is not FailureException)
        {
            throw LocalFailure(ProtocolCode.PayloadUndecodable, "the HTTP payload cannot be decoded", new LocalFailureOptions(cause));
        }
    }

    private TResult EventValue<TResult>(HttpPayload payload, string data)
    {
        try
        {
            var bytes = Utf8.GetBytes(data);

            if (payload.Encoding is HttpEncoding.Text or HttpEncoding.Raw)
            {
                var value = PayloadCodecs.Json.Decode(bytes);

                if (value.ValueKind != JsonValueKind.String)
                {
                    throw Invalid("an HTTP text or raw event holds a JSON string");
                }

                var text = value.GetString()!;

                if (payload.Encoding == HttpEncoding.Text)
                {
                    return Read<TResult>(payload, Utf8.GetBytes(text));
                }

                var raw = Convert.FromBase64String(text);

                if (Convert.ToBase64String(raw) != text)
                {
                    throw Invalid("an HTTP raw event holds standard padded base64");
                }

                return Read<TResult>(payload, raw);
            }

            return Read<TResult>(payload, bytes);
        }
        catch (Exception cause) when (cause is not FailureException)
        {
            throw LocalFailure(ProtocolCode.PayloadUndecodable, "the HTTP payload cannot be decoded", new LocalFailureOptions(cause));
        }
    }

    private async Task<byte[]> Whole(HttpContent content, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var body = new MemoryStream();
        var buffer = new byte[4096];
        int read;

        while ((read = await ReadChunk(stream, (buffer, cancellationToken)).ConfigureAwait(false)) != 0)
        {
            if (body.Length + read > _options.MaximumBodyBytes)
            {
                throw LocalFailure(ProtocolCode.PayloadTooLarge, "the HTTP body passes maximumBodyBytes");
            }

            await body.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }

        return body.ToArray();
    }

    private static string MediaTypeOf(HttpPayload payload)
    {
        return payload.Encoding switch
        {
            HttpEncoding.Raw => "application/octet-stream",
            HttpEncoding.Text => "text/plain",
            _ => "application/json",
        };
    }

    private static FailureException FailureOf(ReadOnlyMemory<byte> bytes, HttpResponseMessage? response = null)
    {
        var problem = ProblemOf(bytes);

        if (problem.ValueKind == JsonValueKind.Object && !problem.TryGetProperty("code", out _) && !problem.TryGetProperty("scope", out _) && (!problem.TryGetProperty("detail", out var ownDetail) || ownDetail.ValueKind == JsonValueKind.String))
        {
            var status = response is not null ? (int)response.StatusCode : problem.TryGetProperty("status", out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var statusNumber) ? statusNumber : 0;

            if (status is >= 100 and <= 599)
            {
                var refusal = response is not null && response.Headers.TryGetValues("bead-refusal", out var values) ? values.FirstOrDefault() : null;
                return StatusFailure(status, (refusal, response is null ? null : RetryOf(response), ownDetail.ValueKind == JsonValueKind.String ? ownDetail.GetString() : null, true));
            }
        }

        if (problem.ValueKind != JsonValueKind.Object || !problem.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.Number || !code.TryGetDouble(out var number) || number < 1 || number > ushort.MaxValue || number != Math.Truncate(number) || !problem.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.String || scope.GetString() is not ("application" or "protocol") || (problem.TryGetProperty("detail", out var detail) && detail.ValueKind != JsonValueKind.String))
        {
            throw Invalid("the HTTP problem holds no Bead failure");
        }

        return new FailureException(new Failure { Code = (ushort)number, Scope = scope.GetString() == "application" ? FailureScope.Application : FailureScope.Protocol, Detail = detail.ValueKind == JsonValueKind.String ? detail.GetString()! : "" }, new FailureException.Raised(FailureOrigin.Peer, null));
    }

    private static FailureException Invalid(string detail)
    {
        return LocalFailure(ProtocolCode.PayloadUndecodable, detail);
    }

    private sealed record LocalFailureOptions(Exception Cause);

    private static FailureException LocalFailure(ProtocolCode code, string detail, LocalFailureOptions? options = null)
    {
        var failure = Failure.OfProtocol(code, detail);
        var raised = new FailureException.Raised(FailureOrigin.Local, RouterSide.Client);
        return options is null ? new FailureException(failure, raised) : new FailureException(failure, (raised, options.Cause));
    }

    private static JsonElement ProblemOf(ReadOnlyMemory<byte> bytes)
    {
        try { return PayloadCodecs.Json.Decode(bytes); }
        catch (Exception cause) { throw LocalFailure(ProtocolCode.PayloadUndecodable, "the HTTP payload cannot be decoded", new LocalFailureOptions(cause)); }
    }

    private static string Decode(ReadOnlySpan<byte> bytes)
    {
        try { return Utf8.GetString(bytes); }
        catch (DecoderFallbackException cause) { throw LocalFailure(ProtocolCode.PayloadUndecodable, "the HTTP payload cannot be decoded", new LocalFailureOptions(cause)); }
    }

    private static async ValueTask<int> ReadChunk(Stream stream, (Memory<byte> Buffer, CancellationToken CancellationToken) read)
    {
        try { return await stream.ReadAsync(read.Buffer, read.CancellationToken).ConfigureAwait(false); }
        catch (Exception cause) when (!read.CancellationToken.IsCancellationRequested)
        {
            throw LocalFailure(ProtocolCode.DestinationLost, "the HTTP body ends before its answer", new LocalFailureOptions(cause));
        }
    }

    private static string? RetryOf(HttpResponseMessage response)
    {
        return response.Headers.TryGetValues("retry-after", out var values) ? string.Join(", ", values) : null;
    }

    private static FailureException StatusFailure(int status, (string? Refusal, string? Retry, string? Detail, bool Problem) options)
    {
        var code = options.Refusal switch
        {
            "busy" => ProtocolCode.CapacityExceeded,
            "host-refused" or "origin-refused" => ProtocolCode.AccessDenied,
            "path-unknown" or "method-refused" => ProtocolCode.DestinationUnreachable,
            "too-large" => ProtocolCode.PayloadTooLarge,
            "malformed" or "type-refused" => ProtocolCode.PayloadUndecodable,
            _ => (status, options.Problem) switch
            {
                (400 or 415, true) => ProtocolCode.PayloadUndecodable,
                (405 or 408, true) => ProtocolCode.DestinationUnreachable,
                (422, true) => ProtocolCode.PayloadInvalid,
                (431, true) => ProtocolCode.PayloadTooLarge,
                (501, true) => ProtocolCode.ProcedureUnknown,
                (401, _) => ProtocolCode.SessionRequired,
                (403, _) => ProtocolCode.AccessDenied,
                (404 or 503, _) => ProtocolCode.DestinationUnreachable,
                (413, _) => ProtocolCode.PayloadTooLarge,
                (429, _) => ProtocolCode.CapacityExceeded,
                _ => ProtocolCode.DestinationLost,
            },
        };
        var detail = $"the HTTP call answers {status}{(options.Retry is null ? "" : $"; Retry-After: {options.Retry}")}{(string.IsNullOrEmpty(options.Detail) ? "" : $"; {options.Detail}")}";
        return new FailureException(Failure.OfProtocol(code, detail), new FailureException.Raised(FailureOrigin.Peer, null));
    }
}
