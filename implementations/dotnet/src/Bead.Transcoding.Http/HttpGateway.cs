using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Bead.Protobuf;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Bead.Transcoding.Http;

/// <summary>
/// A gateway of HTTP/JSON transcoding (decision 0037, spec/transcoding.md): an HTTP server that
/// answers each procedure's routes by calling it as one more Bead client of its application's
/// server. It judges a request by the gates of transcoding 10.1 in their order — the HTTP server's
/// hosts, origins, CORS and bounds of spec 15.12, Fetch Metadata —, binds it, reads its body by Bead's
/// mapping, and calls its procedure through one Bead connection drawn for its exchange and closed
/// as its response ends, over the in-memory transport its server takes through a join: every
/// bound, admission, subscription and session of a connection one caller's. A result is 200 in
/// Bead's proto JSON form, a failure a problem of RFC 9457 by where it arose, a stream Server-Sent
/// Events at its reader's pace. It answers on a listener of its own, <see cref="Start"/>, or as an
/// endpoint an ASP.NET Core application maps, <see cref="HttpGatewayEndpoints.MapBeadGateway"/>.
/// </summary>
public sealed class HttpGateway : IAsyncDisposable
{
    // what the transport's refusals are marked with (spec 15.6), which a client tells from a call's answer
    private const string RefusalHeader = "bead-refusal";
    private const string DocumentPath = "/openapi.json";
    private const string EventStreamType = "text/event-stream";

    // the largest JWT a request's header holds with no other block (spec 4.4)
    private const int JwtBytes = 1_004;

    // the methods in the order an allow names them (transcoding 3.10)
    private static readonly string[] MethodOrder = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

    private readonly HttpGatewayOptions _options;
    private readonly Resolved _policy;
    private readonly ProxyTrust _proxyTrust;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _heartbeat;
    private readonly List<Served> _served = [];
    private readonly JsonForm _form;
    private readonly HttpBinding _binding;
    private readonly byte[]? _document;
    private readonly string? _etag;

    // what it holds at once, under its lock: its calls and its streams, in all and by address, and
    // the bytes of body being read
    private readonly Lock _gate = new();
    private readonly Dictionary<string, int> _callsByAddress = [];
    private readonly Dictionary<string, int> _streamsByAddress = [];
    private int _calls;
    private int _streams;
    private long _bodyBytes;
    private WebApplication? _application;

    /// <summary>
    /// A gateway, not yet listening, its options held: an entry of its hosts, origins or proxies none
    /// takes, a member that parts from its policy, or a route of a template off <c>http.proto</c>'s
    /// grammar is an <see cref="ArgumentException"/>; a bound not above 0, or a duration off its
    /// range, an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public HttpGateway(HttpGatewayOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Transport);
        ArgumentNullException.ThrowIfNull(options.Routes);

        _policy = PolicyOf(options);
        _options = options;
        _proxyTrust = Bead.TrustedProxies.TrustOf((_policy.TrustedProxies, nameof(HttpGatewayOptions.TrustedProxies)), (_policy.UnnamedProxies, nameof(HttpGatewayOptions.UnnamedProxies)));
        _clock = options.Clock ?? TimeProvider.System;
        Timeout = Clocks.AssertHeld((nameof(HttpGatewayOptions.Timeout), nameof(HttpGatewayOptions.Timeout)), options.Timeout);
        _heartbeat = Clocks.AssertHeld((nameof(HttpGatewayOptions.Heartbeat), nameof(HttpGatewayOptions.Heartbeat)), options.Heartbeat);

        ServerBounds.AssertCount((nameof(HttpGatewayOptions.Window), options.Window));
        ServerBounds.AssertCount((nameof(HttpGatewayOptions.MaximumExchanges), options.MaximumExchanges));
        ServerBounds.AssertCount((nameof(HttpGatewayOptions.MaximumExchangesPerAddress), options.MaximumExchangesPerAddress));
        ServerBounds.AssertCount((nameof(HttpGatewayOptions.MaximumUnsentBytes), options.MaximumUnsentBytes));

        foreach (var route in options.Routes)
        {
            for (var index = 0; index < route.Routes.Count; index += 1)
            {
                var rule = route.Routes[index];
                HttpTemplate template;

                try
                {
                    template = HttpTemplate.Parse(rule.Template);
                }
                catch (FormatException reason)
                {
                    throw new ArgumentException($"{route.Procedure.ProcedureName}'s route {rule.Method} {rule.Template}: {reason.Message}", nameof(options), reason);
                }

                _served.Add(new Served(route, rule, template));
            }
        }

        _form = new JsonForm(options.Routes.SelectMany((route) =>
        {
            return new[] { route.Request, route.Result, route.Notification }.Select((payload) =>
            {
                return payload?.Descriptor;
            }).OfType<MessageDescriptor>();
        }));
        _binding = new HttpBinding(_form);

        if (options.Document is { } document)
        {
            _document = document.ToArray();
            _etag = $"\"{Convert.ToHexStringLower(SHA256.HashData(_document))}\"";
        }
    }

    /// <summary>
    /// What went wrong that no caller can mend, reported, its words never in a problem (spec 9.0): a
    /// result Bead's proto JSON form holds none of, a scheme its server takes none of (transcoding
    /// 7.6), an answer its stock library refuses, a connection it could not draw, what no gate foresaw.
    /// What a listener throws goes no further, and the exchange answers on.
    /// </summary>
    public event Action<Exception>? Error;

    // how long a call waits for its answer, as its options' duration is held (spec 1.4), which the
    // durations' harness reads back
    internal TimeSpan Timeout { get; }

    /// <summary>
    /// Starts its own listener, as an HTTP transport builds its own, and gives where it listens: an IP
    /// literal, or <c>localhost</c>, both loopbacks.
    /// </summary>
    public async Task<TransportServerAddress> Start(HttpGatewayStartOptions? options = null, CancellationToken cancellationToken = default)
    {
        var start = options ?? new HttpGatewayStartOptions();

        HostsAndOrigins.AssertAddress(start.Address, nameof(HttpGatewayStartOptions.Address));

        if (_application is not null)
        {
            throw new InvalidOperationException("a gateway listens once");
        }

        var ((application, port), address) = start.Address == Loopbacks.Localhost
            ? await Loopbacks.Bind(
                (listening) =>
                {
                    return Serving(listening, cancellationToken);
                },
                new LoopbackBinding { Port = start.Port, FindOpenPort = start.FindOpenPort })
            : (await Serving(([IPAddress.Parse(start.Address)], start.FindOpenPort ? 0 : start.Port), cancellationToken), start.Address);

        _application = application;

        return new TransportServerAddress(address, port);
    }

    /// <summary>Stops its own listener, each exchange under way closed with it; it settles at once when it listens on none.</summary>
    public async Task Stop()
    {
        if (Interlocked.Exchange(ref _application, null) is { } application)
        {
            await application.StopAsync();
            await application.DisposeAsync();
        }
    }

    /// <inheritdoc/>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    /// <summary>
    /// Answers one exchange, as its listener or the endpoint an application maps hands it on: each
    /// gate of transcoding 10.1 in its order, then its binding, its reading, and its call.
    /// </summary>
    public async Task Answer(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        try
        {
            await Exchange(context);
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException)
        {
            // its client went: nothing to write it to
        }
        catch (Exception reason) when (reason is not OutOfMemoryException)
        {
            // ! what no gate foresaw: its exchange ends, never the gateway, and its words are reported
            Report(reason);

            if (!context.Response.HasStarted)
            {
                await Answer(context, HttpProblems.Own(OwnFailure.Unwritable, ("the gateway failed", _options.Challenge)));
            }
        }
    }

    // ── The gates, transcoding 10.1 ─────────────────────────────────────────────────────────────

    private async Task Exchange(HttpContext context)
    {
        var request = context.Request;

        // 1. what HTTP refuses of its own, unmarked (spec 15.12)
        if (!HasVisibleFields(request) || !IsTakenTarget(context))
        {
            await RefuseAsHttp(context, StatusCodes.Status400BadRequest);

            return;
        }

        var authority = HostsAndOrigins.AuthorityOf(request.Headers.Host, TargetAuthorityOf(context));

        // 2. a host it does not take
        if (!HostsAndOrigins.IsTakenHost(authority, _policy.Hosts))
        {
            await Refuse(context, (StatusCodes.Status403Forbidden, "host-refused", "a host it does not take"));

            return;
        }

        var target = RawTargetOf(context);
        var question = target.IndexOf('?', StringComparison.Ordinal);
        var path = question < 0 ? target : target[..question];
        var isDocument = _document is not null && path == DocumentPath;
        var matched = isDocument ? [] : Matched(path);

        // 3. a path no route matches
        if (!isDocument && matched.Count == 0)
        {
            await Refuse(context, (StatusCodes.Status404NotFound, "path-unknown", "a path no route matches"));

            return;
        }

        var origin = HeaderOf(request, HeaderNames.Origin);
        var own = HostsAndOrigins.OwnAuthorityOf(authority, _policy.Hosts);

        // 4. an origin neither its own nor listed
        if (!HostsAndOrigins.IsTakenOrigin(origin, (own, _policy.Origins)))
        {
            await Refuse(context, (StatusCodes.Status403Forbidden, "origin-refused", "an origin neither its own nor listed"));

            return;
        }

        // * every answer a page of an origin it lists can read carries it, a refusal's too
        if (HostsAndOrigins.IsListedOrigin(origin, _policy.Origins))
        {
            context.Response.Headers.AccessControlAllowOrigin = origin;
            context.Response.Headers.AccessControlExposeHeaders = "*";

            // 6. a preflight from an origin it lists: the methods its path's routes take
            if (HttpMethods.IsOptions(request.Method) && request.Headers.ContainsKey(HeaderNames.AccessControlRequestMethod))
            {
                await Preflight(context, isDocument ? ["GET", "HEAD"] : MethodsOf(matched));

                return;
            }
        }

        // 5. a request with no Origin from a page of another site, but a navigation to what reads
        var site = HeaderOf(request, "sec-fetch-site");

        if (origin is null && site is "same-site" or "cross-site" && !IsNavigationTaken(context, (isDocument, matched)))
        {
            await Refuse(context, (StatusCodes.Status403Forbidden, "origin-refused", "a request from a page of another site that shows no origin"));

            return;
        }

        var method = HttpMethods.IsHead(request.Method) ? "GET" : request.Method;

        if (isDocument)
        {
            if (method != "GET")
            {
                await Refuse(context, (StatusCodes.Status405MethodNotAllowed, "method-refused", "a method the document takes none of"), new Dictionary<string, string> { ["allow"] = "GET, HEAD" });
            }
            else if (HasBody(request))
            {
                await Refuse(context, (StatusCodes.Status400BadRequest, "malformed", "content to the document"));
            }
            else
            {
                await ServeDocument(context);
            }

            return;
        }

        // 7. a method no route of its path takes
        if (!matched.TryGetValue(method, out var served))
        {
            await Refuse(context, (StatusCodes.Status405MethodNotAllowed, "method-refused", "a method no route of its path takes"), new Dictionary<string, string> { ["allow"] = string.Join(", ", MethodsOf(matched)) });

            return;
        }

        await Exchange(context, (served, target));
    }

    private async Task Exchange(HttpContext context, (Served Served, string Target) call)
    {
        var (served, target) = call;
        var request = context.Request;

        // 8. a body of a type that is not its route's, or to a route that takes none
        if (served.Rule.Body is null)
        {
            if (HasBody(request))
            {
                await Refuse(context, (StatusCodes.Status400BadRequest, "malformed", "content to a route that takes none"));

                return;
            }
        }
        else if ((HasBody(request) || request.Headers.ContentType.Count > 0) && !IsTypeTaken(request, served.Route.Request.Encoding))
        {
            await Refuse(context, (StatusCodes.Status415UnsupportedMediaType, "type-refused", $"this route's body is {MediaTypeOf(served.Route.Request.Encoding)}, unencoded"));

            return;
        }

        // 9. two authorization fields, a length past its bound, its bounds, a stream's reconnection
        if (request.Headers.Authorization.Count > 1)
        {
            await Refuse(context, (StatusCodes.Status400BadRequest, "malformed", "two authorization fields"));

            return;
        }

        if (request.ContentLength > _policy.MaximumBodyBytes)
        {
            await Refuse(context, (StatusCodes.Status413PayloadTooLarge, "too-large", $"a body declared past maximumBodyBytes {_policy.MaximumBodyBytes}"));

            return;
        }

        var isStream = served.Route.Notification is not null && AcceptsStream(request);
        var address = AddressOf(context) ?? "local";

        if (Hold((address, isStream)) is { } bound)
        {
            await Refuse(context, (StatusCodes.Status503ServiceUnavailable, "busy", bound), new Dictionary<string, string> { ["retry-after"] = "1" });

            return;
        }

        try
        {
            if (isStream && request.Headers.ContainsKey("last-event-id"))
            {
                await Nothing(context);

                return;
            }

            // 10. its body as it comes
            var (body, refused) = await BodyOf(context);

            if (refused is { } end)
            {
                CloseBehind(context);
                await Refuse(context, end, end.Status == StatusCodes.Status503ServiceUnavailable ? new Dictionary<string, string> { ["retry-after"] = "1" } : null);

                return;
            }

            // 11. its binding, its reading, then its call
            await Call(context, (served, target, body!, isStream, address));
        }
        finally
        {
            Release((address, isStream));
        }
    }

    // whether a navigation from another site with no origin is taken (10.1, step 5): to the
    // document, to a default route's GET, or to a get rule of a method marked NO_SIDE_EFFECTS
    private static bool IsNavigationTaken(HttpContext context, (bool IsDocument, Dictionary<string, Served> Matched) asked)
    {
        if (HeaderOf(context.Request, "sec-fetch-mode") != "navigate")
        {
            return false;
        }

        if (asked.IsDocument)
        {
            return true;
        }

        var isRead = HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method);

        return isRead && asked.Matched.TryGetValue("GET", out var served) && served.Route.NoSideEffects;
    }

    // each method's route that answers a raw path, by 3.5's precedence among that method's; HEAD as GET
    private Dictionary<string, Served> Matched(string path)
    {
        var matched = new Dictionary<string, Served>(StringComparer.Ordinal);

        if (HttpPath.Of(path) is not { } split)
        {
            return matched;
        }

        foreach (var group in _served.GroupBy((served) =>
        {
            return served.Rule.Method;
        }, StringComparer.Ordinal))
        {
            var candidates = group.Where((served) =>
            {
                return served.Template.Matches(split);
            }).ToList();

            if (HttpTemplate.Answering([.. candidates.Select((served) =>
            {
                return served.Template;
            })], split) is { } index)
            {
                matched[group.Key] = candidates[index];
            }
        }

        return matched;
    }

    private static List<string> MethodsOf(Dictionary<string, Served> matched)
    {
        return [.. MethodOrder.Where((method) =>
        {
            return matched.ContainsKey(method == "HEAD" ? "GET" : method);
        })];
    }

    // whether a request's accept names text/event-stream itself, of a weight above 0 and at least
    // the weight it gives application/json, by its most specific range (8.1, RFC 9110 §12.5.1)
    private static bool AcceptsStream(HttpRequest request)
    {
        double? stream = null;
        (int Specificity, double Weight) json = (-1, 0);

        foreach (var line in request.Headers.Accept)
        {
            foreach (var range in (line ?? "").Split(','))
            {
                var parts = range.Split(';');
                var type = parts[0].Trim().ToLowerInvariant();
                var weight = 1.0;

                foreach (var parameter in parts.Skip(1))
                {
                    var pair = parameter.Split('=', 2);

                    if (pair.Length == 2 && pair[0].Trim().Equals("q", StringComparison.OrdinalIgnoreCase)
                        && double.TryParse(pair[1].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var given))
                    {
                        weight = given;
                    }
                }

                if (type == EventStreamType)
                {
                    stream = weight;
                }

                var specificity = type switch
                {
                    "application/json" => 2,
                    "application/*" => 1,
                    "*/*" => 0,
                    _ => -1,
                };

                if (specificity > json.Specificity)
                {
                    json = (specificity, weight);
                }
            }
        }

        return stream is > 0 and var weighed && weighed >= json.Weight;
    }

    // whether a body's type is its route's, its type compared case-insensitively, no parameter but a
    // charset of utf-8, and no encoding but identity (5.1)
    private static bool IsTypeTaken(HttpRequest request, HttpEncoding encoding)
    {
        var encoded = HeaderOf(request, HeaderNames.ContentEncoding)?.Trim();

        if (encoded is not null && !encoded.Equals("identity", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (request.Headers.ContentType.Count != 1)
        {
            return false;
        }

        var parts = request.Headers.ContentType[0]!.Split(';');

        if (!parts[0].Trim().Equals(MediaTypeOf(encoding), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return parts.Skip(1).All((parameter) =>
        {
            var pair = parameter.Split('=', 2);

            return pair.Length == 2
                && pair[0].Trim().Equals("charset", StringComparison.OrdinalIgnoreCase)
                && pair[1].Trim().Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase);
        });
    }

    private static string MediaTypeOf(HttpEncoding encoding)
    {
        return encoding switch
        {
            HttpEncoding.Text => "text/plain",
            HttpEncoding.Raw => "application/octet-stream",
            _ => "application/json",
        };
    }

    // a call or a stream held against its bounds, in all and by its caller's address (10.3): none,
    // or the words of the bound it is past, every caller's before its address's
    private string? Hold((string Address, bool IsStream) held)
    {
        lock (_gate)
        {
            var (byAddress, all, maximum, perAddress) = held.IsStream
                ? (_streamsByAddress, _streams, _policy.MaximumConnections, _policy.MaximumConnectionsPerAddress)
                : (_callsByAddress, _calls, _options.MaximumExchanges, _options.MaximumExchangesPerAddress);
            var ofAddress = byAddress.GetValueOrDefault(held.Address);

            if (all >= maximum)
            {
                return held.IsStream ? "the streams under way hold maximumConnections" : "the calls under way hold maximumExchanges";
            }

            if (ofAddress >= perAddress)
            {
                return held.IsStream ? "the streams of its address hold maximumConnectionsPerAddress" : "the calls of its address hold maximumExchangesPerAddress";
            }

            byAddress[held.Address] = ofAddress + 1;

            if (held.IsStream)
            {
                _streams += 1;
            }
            else
            {
                _calls += 1;
            }

            return null;
        }
    }

    private void Release((string Address, bool IsStream) held)
    {
        lock (_gate)
        {
            var byAddress = held.IsStream ? _streamsByAddress : _callsByAddress;
            var left = byAddress.GetValueOrDefault(held.Address) - 1;

            if (left > 0)
            {
                byAddress[held.Address] = left;
            }
            else
            {
                byAddress.Remove(held.Address);
            }

            if (held.IsStream)
            {
                _streams -= 1;
            }
            else
            {
                _calls -= 1;
            }
        }
    }

    // ── Its body, as it comes ───────────────────────────────────────────────────────────────────

    // the body read whole, counted against the limit and the budget as it comes, and held to its
    // rate once its grace passed, on the gateway's clock (spec 15.12); or how it is refused
    private async Task<(byte[]? Body, Refused? End)> BodyOf(HttpContext context)
    {
        var headAt = _clock.GetTimestamp();
        var reader = context.Request.BodyReader;
        var body = new MemoryStream();
        long charged = 0;
        var isTooSlow = false;
        ITimer? rate = null;

        try
        {
            while (true)
            {
                var coming = reader.ReadAsync(context.RequestAborted);

                if (!coming.IsCompleted && rate is null && _policy.MinimumBodyBytesPerSecond > 0)
                {
                    rate = _clock.CreateTimer(
                        (_) =>
                        {
                            Volatile.Write(ref isTooSlow, true);
                            reader.CancelPendingRead();
                        },
                        null,
                        DueOf((charged, headAt)),
                        System.Threading.Timeout.InfiniteTimeSpan);
                }

                var result = await coming;
                var pieces = result.Buffer;

                if (result.IsCanceled)
                {
                    reader.AdvanceTo(pieces.Start);

                    return (null, Volatile.Read(ref isTooSlow) ? new Refused(StatusCodes.Status408RequestTimeout, "too-slow", "a body slower than minimumBodyBytesPerSecond") : null);
                }

                var count = pieces.Length;

                charged += count;

                bool isOverBudget;

                lock (_gate)
                {
                    _bodyBytes += count;
                    isOverBudget = _bodyBytes > _policy.BodyBytesBudget;
                }

                if (charged > _policy.MaximumBodyBytes)
                {
                    reader.AdvanceTo(pieces.End);

                    return (null, new Refused(StatusCodes.Status413PayloadTooLarge, "too-large", $"a body past maximumBodyBytes {_policy.MaximumBodyBytes}"));
                }

                if (isOverBudget)
                {
                    reader.AdvanceTo(pieces.End);

                    return (null, new Refused(StatusCodes.Status503ServiceUnavailable, "busy", "the bodies under way hold bodyBytesBudget"));
                }

                rate?.Change(DueOf((charged, headAt)), System.Threading.Timeout.InfiniteTimeSpan);

                foreach (var piece in pieces)
                {
                    body.Write(piece.Span);
                }

                reader.AdvanceTo(pieces.End);

                if (result.IsCompleted)
                {
                    break;
                }
            }
        }
        catch (Microsoft.AspNetCore.Http.BadHttpRequestException reason)
        {
            return (null, new Refused(reason.StatusCode, "malformed", "a body HTTP could not read"));
        }
        finally
        {
            rate?.Dispose();

            lock (_gate)
            {
                _bodyBytes -= charged;
            }
        }

        return (body.ToArray(), null);
    }

    // when a body that brought `charged` since its head is due: the longer of its grace and its
    // bytes at the rate, from its head's reading
    private TimeSpan DueOf((long Charged, long HeadAt) brought)
    {
        var allowed = TimeSpan.FromSeconds((double)brought.Charged / _policy.MinimumBodyBytesPerSecond);
        var due = (allowed > _policy.BodyGracePeriod ? allowed : _policy.BodyGracePeriod) - _clock.GetElapsedTime(brought.HeadAt);

        return due > TimeSpan.Zero ? due : TimeSpan.Zero;
    }

    // ── The call, transcoding 2 and 9 ───────────────────────────────────────────────────────────

    private async Task Call(HttpContext context, (Served Served, string Target, byte[] Body, bool IsStream, string Address) call)
    {
        var (served, target, body, isStream, address) = call;
        var route = served.Route;
        var problems = new ProblemContext
        {
            Arose = FailureArising.Gateway,
            Encoding = route.Request.Encoding,
            Challenge = _options.Challenge,
            ProblemTypes = _options.ProblemTypes,
            Failures = route.Failures,
            Request = route.Request.Descriptor,
            Rule = served.Rule,
        };

        // its credential, as its option says it presents one (2.4)
        var given = HostsAndOrigins.CredentialOf(context.Request.Headers.Authorization);
        Credential? credential = null;

        if (given is not null)
        {
            if (_options.Authorization == GatewayAuthorization.Elsewhere)
            {
                credential = Credential.Elsewhere(given);
            }
            else
            {
                var space = given.IndexOf(' ', StringComparison.Ordinal);
                var token = space < 0 ? "" : given[(space + 1)..].Trim();

                if (space < 0 || !given[..space].Equals("Bearer", StringComparison.OrdinalIgnoreCase) || token.Length == 0)
                {
                    await Answer(context, HttpProblems.Own(OwnFailure.Scheme, ("an auth-scheme but Bearer", _options.Challenge)));

                    return;
                }

                if (Encoding.ASCII.GetByteCount(token) > JwtBytes)
                {
                    await Answer(context, HttpProblems.Own(OwnFailure.Jwt, ($"a token past {JwtBytes} bytes", _options.Challenge)));

                    return;
                }

                credential = Credential.Jwt(token);
            }
        }

        problems = problems with { Credential = credential is not null };

        // its request's payload: a proto request bound and read by Bead's mapping, any other as it came
        ReadOnlyMemory<byte> payload;

        try
        {
            payload = PayloadOf((served, target, body));
        }
        catch (JsonFormException refused)
        {
            // * the mapping's own words of the client's own request, fixed in transcoding.json
            await Answer(context, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable, refused.Message), problems));

            return;
        }

        // * one Bead connection for this exchange, closed as its response ends, or as its client goes
        await using var transport = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = _clock });

        try
        {
            await transport.Connect(
                new MemoryConnectOptions { Server = _options.Transport, Address = address, Port = context.Connection.RemotePort },
                context.RequestAborted);
        }
        catch (Exception reason) when (reason is ConnectException or TimeoutException or InvalidOperationException)
        {
            // ! the in-memory transport's words tell of the gateway's inside, never its client's request
            Report(reason);
            await Answer(context, HttpProblems.Of(Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "the connection is gone"), problems with { Arose = FailureArising.Client }));

            return;
        }

        // its client declares no resolver: a command its server sends is answered SERVICE_UNKNOWN
        // (transcoding 2.6)
        using var router = new RouterClient(transport, new RouterClientOptions { Clock = _clock });

        using var aborted = context.RequestAborted.Register(() =>
        {
            _ = transport.CloseConnection();
        });
        var options = new ResolvedRequestOptions { Timeout = Timeout, Credential = credential };

        if (isStream)
        {
            await Stream(context, (route, router, payload, options, problems));

            return;
        }

        RouterResult result;

        try
        {
            result = await router.Request(payload, new RouterRequest(route.Procedure, options));
        }
        catch (Exception reason) when (FailureOf(reason, problems) is { } problem)
        {
            if (!context.RequestAborted.IsCancellationRequested)
            {
                await Answer(context, problem);
            }

            return;
        }

        await AnswerResult(context, (served, result.Payload, problems));
    }

    // a proto request bound by its route and read by Bead's mapping; a json, text or raw one as it
    // came, which no query binds
    private ReadOnlyMemory<byte> PayloadOf((Served Served, string Target, byte[] Body) request)
    {
        var (served, target, body) = request;

        if (served.Route.Request.Descriptor is not { } descriptor)
        {
            var question = target.IndexOf('?', StringComparison.Ordinal);

            if (question >= 0 && target[(question + 1)..].Split('&').Any((sequence) =>
            {
                return sequence.Length > 0;
            }))
            {
                throw new JsonFormException("a query beside a body of the whole request");
            }

            return body;
        }

        var message = _binding.Bind(
            new BindingRoute { Request = descriptor, Rule = served.Rule, Template = served.Template },
            new BindingRequest { Target = target, Body = body });

        return message.ToByteArray();
    }

    // a call's failure as its problem, by where it arose (7.5): none for what no answer is owed
    private HttpProblem? FailureOf(Exception reason, ProblemContext problems)
    {
        switch (reason)
        {
            case TimeoutException:
                return HttpProblems.Own(OwnFailure.Timeout, (string.Create(CultureInfo.InvariantCulture, $"no answer within {(long)Timeout.TotalMilliseconds} ms"), _options.Challenge));
            case FailureException failure:
                var arose = failure.Origin != FailureOrigin.Local
                    ? FailureArising.Server
                    : failure.Header is ResultHeader or NotificationHeader ? FailureArising.Answer : FailureArising.Client;

                if (failure.Code == (ushort)ProtocolCode.CredentialUnsupported && failure.Scope == FailureScope.Protocol)
                {
                    Report(new InvalidOperationException($"the server takes none of the scheme this gateway presents: {failure.Detail}", failure));
                }

                return HttpProblems.Of(failure.Failure, problems with { Arose = arose });
            case DisconnectException:
            case ConnectException:
                return HttpProblems.Own(OwnFailure.Closed, ("the connection closed", _options.Challenge));
            default:
                return null;
        }
    }

    // a result in its route's form (6.1): a proto result in Bead's proto JSON form, its response
    // body's field where its route names one; any other as it came
    private async Task AnswerResult(HttpContext context, (Served Served, ReadOnlyMemory<byte> Payload, ProblemContext Problems) answered)
    {
        var (served, payload, problems) = answered;
        var result = served.Route.Result;

        if (result.Descriptor is not { } descriptor)
        {
            var type = result.Encoding == HttpEncoding.Text ? "text/plain;charset=utf-8" : MediaTypeOf(result.Encoding);

            await WriteWhole(context, (StatusCodes.Status200OK, type, payload));

            return;
        }

        byte[] written;

        try
        {
            var message = Decoded(descriptor, payload);

            written = served.Rule.ResponseBody is { } field ? _form.WriteField(message, field) : _form.Write(message);
        }
        catch (Exception reason) when (reason is JsonFormException or UndecodedAnswerException)
        {
            await Answer(context, AnswerRefused(reason, problems));

            return;
        }

        await WriteWhole(context, (StatusCodes.Status200OK, "application/json", written));
    }

    // ! the server's answer read: a proto result or notification by its stock library, its records
    // checked first (spec 17.9), as its client's codec reads one; what refuses it is the answer's,
    // never the gateway's (7.5, item 2), and EventDataOf reads a text one so too
    private static IMessage Decoded(MessageDescriptor descriptor, ReadOnlyMemory<byte> bytes)
    {
        try
        {
            ProtoRecords.Check(bytes.Span, descriptor);

            return descriptor.Parser.ParseFrom(bytes.Span);
        }
        catch (Exception reason) when (reason is FormatException or InvalidProtocolBufferException)
        {
            throw new UndecodedAnswerException(reason);
        }
    }

    // a result or a notification as an event's data (8.4): a proto one read, then written in Bead's
    // proto JSON form; a text one read as UTF-8 (spec 17.4); a json or a raw one as it came
    private ReadOnlyMemory<byte> EventDataOf(HttpPayload payload, ReadOnlyMemory<byte> bytes)
    {
        if (payload.Descriptor is { } descriptor)
        {
            return _form.Write(Decoded(descriptor, bytes));
        }

        if (payload.Encoding == HttpEncoding.Text)
        {
            try
            {
                return Payloads.WriteJsonString(Payloads.ReadText(bytes));
            }
            catch (FormatException reason)
            {
                throw new UndecodedAnswerException(reason);
            }
        }

        return HttpEvents.DataOf(payload, (bytes, _form));
    }

    // what refused the server's answer, reported: Bead's mapping, of a result it holds no form of,
    // 500 in its own words, fixed in transcoding.json (5.7); or its stock library, 502, its code
    // alone, none of the library's words (spec 9.0)
    private HttpProblem AnswerRefused(Exception reason, ProblemContext problems)
    {
        if (reason is JsonFormException unwritable)
        {
            Report(unwritable);

            return HttpProblems.Own(OwnFailure.Unwritable, (unwritable.Message, _options.Challenge));
        }

        Report(reason.InnerException ?? reason);

        return HttpProblems.Of(Failure.OfProtocol(ProtocolCode.PayloadUndecodable), problems with { Arose = FailureArising.Answer });
    }

    // ── A stream, transcoding 8 ─────────────────────────────────────────────────────────────────

    private async Task Stream(HttpContext context, (HttpRoute Route, RouterClient Router, ReadOnlyMemory<byte> Payload, ResolvedRequestOptions Options, ProblemContext Problems) call)
    {
        var (route, router, payload, options, problems) = call;
        var response = context.Response;
        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        long unsent = 0;

        // each write after the one before it, once its response took it, the response's head with the first
        async Task Write(ReadOnlyMemory<byte> bytes)
        {
            if (!response.HasStarted)
            {
                response.StatusCode = StatusCodes.Status200OK;
                Stamp(response);
                response.ContentType = EventStreamType;
            }

            if (Interlocked.Add(ref unsent, bytes.Length) > _options.MaximumUnsentBytes)
            {
                context.Abort();

                throw new IOException($"a stream past maximumUnsentBytes {_options.MaximumUnsentBytes}");
            }

            await response.Body.WriteAsync(bytes, context.RequestAborted);
            await response.Body.FlushAsync(context.RequestAborted);
            Interlocked.Add(ref unsent, -bytes.Length);
        }

        var events = new HttpEvents(Write);
        var notification = new StreamNotification(route, (events, this, problems, ended));

        await router.RegisterNotification(notification);

        RouterResult result;

        try
        {
            result = await router.Request(payload, new RouterRequest(route.Procedure, options) { Subscribes = notification });
        }
        catch (Exception reason) when (FailureOf(reason, problems) is { } problem)
        {
            // * nothing of a stream written before its answer: its failure is a call's (8.2)
            events.Failure(problem.Body, out _);

            if (!context.RequestAborted.IsCancellationRequested)
            {
                await Answer(context, problem);
            }

            return;
        }

        ReadOnlyMemory<byte> data;

        try
        {
            data = EventDataOf(route.Result, result.Payload);
        }
        catch (Exception reason) when (reason is JsonFormException or UndecodedAnswerException)
        {
            var problem = AnswerRefused(reason, problems);

            events.Failure(problem.Body, out _);
            await Answer(context, problem);

            return;
        }

        await events.Result(data);

        using var heartbeat = _heartbeat == System.Threading.Timeout.InfiniteTimeSpan
            ? null
            : _clock.CreateTimer(
                (_) =>
                {
                    _ = Heartbeat(events);
                },
                null,
                _heartbeat,
                _heartbeat);
        var gone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var going = context.RequestAborted.Register(() =>
        {
            gone.TrySetResult();
        });

        // its end: the failure that ends its subscription, written as its last event, or its client gone
        await Task.WhenAny(ended.Task, gone.Task);
    }

    private static async Task Heartbeat(HttpEvents events)
    {
        try
        {
            await events.Heartbeat();
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException or InvalidOperationException)
        {
            // its client went: its stream ends with it
        }
    }

    // ── Answers ─────────────────────────────────────────────────────────────────────────────────

    // a problem, as a call's failure: its status, its fields, its body, unmarked
    private Task Answer(HttpContext context, HttpProblem problem)
    {
        foreach (var (name, value) in problem.Fields)
        {
            context.Response.Headers[name] = value;
        }

        return WriteWhole(context, (problem.Status, HttpProblems.MediaType, problem.Body));
    }

    // a refusal of the gateway's own (7.7): marked, its body a problem of about:blank, its words
    private Task Refuse(HttpContext context, Refused refused, Dictionary<string, string>? fields = null)
    {
        foreach (var (name, value) in fields ?? [])
        {
            context.Response.Headers[name] = value;
        }

        context.Response.Headers[RefusalHeader] = refused.Reason;

        return WriteWhole(context, (refused.Status, HttpProblems.MediaType, HttpProblems.Refusal(refused.Status, refused.Words)));
    }

    private Task Refuse(HttpContext context, (int Status, string Reason, string Words) refused, Dictionary<string, string>? fields = null)
    {
        return Refuse(context, new Refused(refused.Status, refused.Reason, refused.Words), fields);
    }

    // a stream's request that carries Last-Event-ID: 204, no call (8.3)
    private static async Task Nothing(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        Stamp(context.Response);
        await context.Response.CompleteAsync();
    }

    private static async Task Preflight(HttpContext context, List<string> methods)
    {
        var asked = string.Join(", ", context.Request.Headers.AccessControlRequestHeaders.AsEnumerable());
        string[] allowed = asked.Length == 0 ? ["authorization", "*"] : ["authorization", asked, "*"];
        var response = context.Response;

        response.StatusCode = StatusCodes.Status204NoContent;
        Stamp(response);
        response.Headers.AccessControlAllowMethods = string.Join(", ", methods);
        response.Headers.AccessControlAllowHeaders = string.Join(", ", allowed);
        response.Headers.AccessControlMaxAge = "7200";
        await response.CompleteAsync();
    }

    // the document its builder wrote, as it is (11.1): a strong tag of its sha256, and 304 to one that holds it
    private async Task ServeDocument(HttpContext context)
    {
        var response = context.Response;
        var asked = HeaderOf(context.Request, HeaderNames.IfNoneMatch);
        var isHeld = asked is not null && asked.Split(',').Any((tag) =>
        {
            var trimmed = tag.Trim();

            return trimmed == "*" || (trimmed.StartsWith("W/", StringComparison.Ordinal) ? trimmed[2..] : trimmed) == _etag;
        });

        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.Vary = "Origin";
        response.Headers.CacheControl = "no-cache";
        response.Headers.ETag = _etag;

        if (isHeld)
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            await response.CompleteAsync();

            return;
        }

        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "application/json";
        response.ContentLength = _document!.Length;

        if (!HttpMethods.IsHead(context.Request.Method))
        {
            await WritePaced(context, _document);
        }

        await response.CompleteAsync();
    }

    // a response whole: its status, the fields every answer carries, its type and its length, then
    // its body, but to a HEAD
    private async Task WriteWhole(HttpContext context, (int Status, string ContentType, ReadOnlyMemory<byte> Body) answer)
    {
        var response = context.Response;

        if (response.HasStarted)
        {
            return;
        }

        response.StatusCode = answer.Status;
        Stamp(response);
        response.ContentType = answer.ContentType;
        response.ContentLength = answer.Body.Length;

        if (!HttpMethods.IsHead(context.Request.Method) && answer.Body.Length > 0)
        {
            await WritePaced(context, answer.Body);
        }

        await response.CompleteAsync();
    }

    // ! an answer written at its pace (spec 15.12), on the real clock, since what it bounds is the
    // platform's socket: its socket still holding it past the longer of its grace and its bytes at
    // the rate, its exchange is aborted
    private async Task WritePaced(HttpContext context, ReadOnlyMemory<byte> bytes)
    {
        long unsent = bytes.Length;

        void Late()
        {
            context.Abort();
        }

        long Unsent()
        {
            return Interlocked.Read(ref unsent);
        }

        var pace = new SendPace((Late, Unsent), new SendPaceOptions { MinimumSendBytesPerSecond = _policy.MinimumSendBytesPerSecond, SendGracePeriod = _policy.SendGracePeriod });

        pace.Hand(bytes.Length);

        try
        {
            await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
            await context.Response.Body.FlushAsync(context.RequestAborted);
        }
        finally
        {
            Interlocked.Exchange(ref unsent, 0);
            pace.Stop();
        }
    }

    // what every response a gateway writes carries but its document's (6.2)
    private static void Stamp(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.Vary = "Origin";
    }

    // what HTTP refuses of its own: its status, unmarked, none of the gateway's fields, its socket closed behind it
    private static async Task RefuseAsHttp(HttpContext context, int status)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.StatusCode = status;
            context.Response.Headers.Connection = "close";
        }

        await context.Response.CompleteAsync();
    }

    private static void CloseBehind(HttpContext context)
    {
        if (!HttpProtocol.IsHttp2(context.Request.Protocol) && !HttpProtocol.IsHttp3(context.Request.Protocol))
        {
            context.Response.Headers.Connection = "close";
        }
    }

    // ── Fields ──────────────────────────────────────────────────────────────────────────────────

    private static string? HeaderOf(HttpRequest request, string name)
    {
        var values = request.Headers[name];

        return values.Count == 0 ? null : values.ToString();
    }

    private static bool HasBody(HttpRequest request)
    {
        return request.ContentLength is > 0 || request.Headers.ContainsKey(HeaderNames.TransferEncoding);
    }

    private static bool HasVisibleFields(HttpRequest request)
    {
        return request.Headers.All((field) =>
        {
            return field.Value.All((value) =>
            {
                return HostsAndOrigins.IsVisibleField(value ?? "");
            });
        });
    }

    private static bool IsHttp1(HttpRequest request)
    {
        return HttpProtocol.IsHttp10(request.Protocol) || HttpProtocol.IsHttp11(request.Protocol);
    }

    private static bool IsTakenTarget(HttpContext context)
    {
        return !IsHttp1(context.Request) || HostsAndOrigins.IsTakenTarget(context.Features.Get<IHttpRequestFeature>()?.RawTarget);
    }

    private static string? TargetAuthorityOf(HttpContext context)
    {
        return IsHttp1(context.Request) ? HostsAndOrigins.TargetAuthorityOf(context.Features.Get<IHttpRequestFeature>()?.RawTarget) : null;
    }

    // a request's target as it came (3.6): an absolute-form target's path and query, its authority aside
    private static string RawTargetOf(HttpContext context)
    {
        var raw = context.Features.Get<IHttpRequestFeature>()?.RawTarget ?? (context.Request.Path + context.Request.QueryString).ToString();

        if (raw.StartsWith('/'))
        {
            return raw;
        }

        var scheme = raw.IndexOf("://", StringComparison.Ordinal);
        var slash = scheme < 0 ? -1 : raw.IndexOf('/', scheme + 3);

        return slash < 0 ? "/" : raw[slash..];
    }

    private string? AddressOf(HttpContext context)
    {
        if (context.Connection.RemoteIpAddress is not { } remote)
        {
            return null;
        }

        var forwarded = context.Request.Headers["x-forwarded-for"];

        return Bead.TrustedProxies.ClientAddressOf(remote, (forwarded.Count == 0 ? null : forwarded.ToString(), _proxyTrust));
    }

    private void Report(Exception reason)
    {
        try
        {
            Error?.Invoke(reason);
        }
        catch (Exception thrown) when (thrown is not OutOfMemoryException)
        {
            // a listener's throw goes no further: the exchange answers on
        }
    }

    // its options' members, each its policy's where the policy gives one, one given in it and beside
    // it refused, checked once as the policy's are
    private static Resolved PolicyOf(HttpGatewayOptions options)
    {
        var policy = options.Policy;
        var checkedOnce = HttpPolicy.Of(new HttpPolicyOptions
        {
            Hosts = HttpPolicy.Taken(nameof(HttpGatewayOptions.Hosts), (options.Hosts, options.IsGiven(HttpPolicyMembers.Hosts), policy?.Hosts)),
            Origins = HttpPolicy.Taken(nameof(HttpGatewayOptions.Origins), (options.Origins, options.IsGiven(HttpPolicyMembers.Origins), policy?.Origins)),
            TrustedProxies = HttpPolicy.Taken(nameof(HttpGatewayOptions.TrustedProxies), (options.TrustedProxies, options.IsGiven(HttpPolicyMembers.TrustedProxies), policy?.TrustedProxies)),
            UnnamedProxies = HttpPolicy.Taken(nameof(HttpGatewayOptions.UnnamedProxies), (options.UnnamedProxies, options.IsGiven(HttpPolicyMembers.UnnamedProxies), policy?.UnnamedProxies)),
            BodyBytesBudget = HttpPolicy.Taken(nameof(HttpGatewayOptions.BodyBytesBudget), (options.BodyBytesBudget, options.IsGiven(HttpPolicyMembers.BodyBytesBudget), policy?.BodyBytesBudget)),
            MaximumBodyBytes = HttpPolicy.Taken(nameof(HttpGatewayOptions.MaximumBodyBytes), (options.MaximumBodyBytes, options.IsGiven(HttpPolicyMembers.MaximumBodyBytes), policy?.MaximumBodyBytes)),
            HeadersTimeout = HttpPolicy.Taken(nameof(HttpGatewayOptions.HeadersTimeout), (options.HeadersTimeout, options.IsGiven(HttpPolicyMembers.HeadersTimeout), policy?.HeadersTimeout)),
            MinimumBodyBytesPerSecond = HttpPolicy.Taken(nameof(HttpGatewayOptions.MinimumBodyBytesPerSecond), (options.MinimumBodyBytesPerSecond, options.IsGiven(HttpPolicyMembers.MinimumBodyBytesPerSecond), policy?.MinimumBodyBytesPerSecond)),
            BodyGracePeriod = HttpPolicy.Taken(nameof(HttpGatewayOptions.BodyGracePeriod), (options.BodyGracePeriod, options.IsGiven(HttpPolicyMembers.BodyGracePeriod), policy?.BodyGracePeriod)),
            MinimumSendBytesPerSecond = HttpPolicy.Taken(nameof(HttpGatewayOptions.MinimumSendBytesPerSecond), (options.MinimumSendBytesPerSecond, options.IsGiven(HttpPolicyMembers.MinimumSendBytesPerSecond), policy?.MinimumSendBytesPerSecond)),
            SendGracePeriod = HttpPolicy.Taken(nameof(HttpGatewayOptions.SendGracePeriod), (options.SendGracePeriod, options.IsGiven(HttpPolicyMembers.SendGracePeriod), policy?.SendGracePeriod)),
            MaximumConnections = HttpPolicy.Taken(nameof(HttpGatewayOptions.MaximumConnections), (options.MaximumConnections, options.IsGiven(HttpPolicyMembers.MaximumConnections), policy?.MaximumConnections)),
            MaximumConnectionsPerAddress = HttpPolicy.Taken(nameof(HttpGatewayOptions.MaximumConnectionsPerAddress), (options.MaximumConnectionsPerAddress, options.IsGiven(HttpPolicyMembers.MaximumConnectionsPerAddress), policy?.MaximumConnectionsPerAddress)),
        });

        return new Resolved
        {
            Hosts = checkedOnce.Hosts,
            Origins = checkedOnce.Origins ?? [],
            TrustedProxies = checkedOnce.TrustedProxies,
            UnnamedProxies = checkedOnce.UnnamedProxies!.Value,
            BodyBytesBudget = checkedOnce.BodyBytesBudget!.Value,
            MaximumBodyBytes = checkedOnce.MaximumBodyBytes!.Value,
            HeadersTimeout = checkedOnce.HeadersTimeout!.Value,
            MinimumBodyBytesPerSecond = checkedOnce.MinimumBodyBytesPerSecond!.Value,
            BodyGracePeriod = checkedOnce.BodyGracePeriod!.Value,
            MinimumSendBytesPerSecond = checkedOnce.MinimumSendBytesPerSecond!.Value,
            SendGracePeriod = checkedOnce.SendGracePeriod!.Value,
            MaximumConnections = checkedOnce.MaximumConnections!.Value,
            MaximumConnectionsPerAddress = checkedOnce.MaximumConnectionsPerAddress!.Value,
        };
    }

    // builds a slim application on the addresses and the port given and starts it, as an HTTP
    // transport builds its own, and gives the port it listens on
    private async Task<(WebApplication Application, int Port)> Serving((IReadOnlyList<IPAddress> Addresses, int Port) listening, CancellationToken cancellationToken)
    {
        WebApplication? application = null;

        try
        {
            var builder = WebApplication.CreateSlimBuilder();

            builder.Logging.ClearProviders();
            builder.WebHost.ConfigureKestrel((kestrel) =>
            {
                kestrel.AddServerHeader = false;

                // * an origin server MUST take an absolute-form target's authority over its Host (RFC 9112 §3.2.2)
                kestrel.AllowHostHeaderOverride = true;

                // the gateway counts each body against its own limit and budget, and holds it to its own rate
                kestrel.Limits.MaxRequestBodySize = null;
                kestrel.Limits.MinRequestBodyDataRate = null;
                kestrel.Limits.MinResponseDataRate = null;
                kestrel.Limits.RequestHeadersTimeout = _policy.HeadersTimeout;

                foreach (var address in listening.Addresses)
                {
                    kestrel.Listen(address, listening.Port);
                }
            });
            application = builder.Build();
            application.Run(Answer);
            await application.StartAsync(cancellationToken);

            var addresses = application.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()
                ?? throw new InvalidOperationException("Kestrel says nothing of where it listens");

            return (application, new Uri(addresses.Addresses.First()).Port);
        }
        catch
        {
            if (application is not null)
            {
                await application.DisposeAsync();
            }

            throw;
        }
    }

    // a route served: its procedure, its rule and its template, parsed once
    // its policy, each member resolved: its own, or its policy's, checked once
    private sealed record Resolved
    {
        public required IReadOnlyList<string>? Hosts { get; init; }

        public required IReadOnlyList<string> Origins { get; init; }

        public required IReadOnlyList<string>? TrustedProxies { get; init; }

        public required int UnnamedProxies { get; init; }

        public required long BodyBytesBudget { get; init; }

        public required int MaximumBodyBytes { get; init; }

        public required TimeSpan HeadersTimeout { get; init; }

        public required int MinimumBodyBytesPerSecond { get; init; }

        public required TimeSpan BodyGracePeriod { get; init; }

        public required int MinimumSendBytesPerSecond { get; init; }

        public required TimeSpan SendGracePeriod { get; init; }

        public required int MaximumConnections { get; init; }

        public required int MaximumConnectionsPerAddress { get; init; }
    }

    private sealed record Served(HttpRoute Route, HttpRouteTemplate Rule, HttpTemplate Template);

    // a refusal of the gateway's own: its status, its mark and its words
    private sealed record Refused(int Status, string Reason, string Words);

    // the server's answer its stock library refused, that refusal inside it
    private sealed class UndecodedAnswerException(Exception refusal) : Exception("the server's answer does not decode", refusal);

    // the notification of one stream's subscription, paced: each credited once the event before it
    // was taken by its response (8.8), and the failure that ends it written as its last event
    private sealed class StreamNotification(HttpRoute route, (HttpEvents Events, HttpGateway Gateway, ProblemContext Problems, TaskCompletionSource Ended) stream) : INotificationLike
    {
        public Procedure Procedure
        {
            get
            {
                return route.Procedure;
            }
        }

        public int? Window
        {
            get
            {
                return stream.Gateway._options.Window;
            }
        }

        public async Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload)
        {
            ReadOnlyMemory<byte> data;

            try
            {
                data = stream.Gateway.EventDataOf(route.Notification!, payload);
            }
            catch (Exception reason) when (reason is JsonFormException or UndecodedAnswerException)
            {
                End(stream.Gateway.AnswerRefused(reason, stream.Problems).Body);

                return [];
            }

            // * enqueued in the turn it came, so the stream keeps the order the notifications came in
            await stream.Events.Notification(data);

            return [];
        }

        public void Drop(Failure? failure)
        {
            End(failure is null
                ? HttpProblems.Own(OwnFailure.Closed, ("the connection closed", stream.Gateway._options.Challenge)).Body
                : HttpProblems.Of(failure, stream.Problems with { Arose = FailureArising.Server }).Body);
        }

        private void End(ReadOnlyMemory<byte> problem)
        {
            if (!stream.Events.Failure(problem, out var written))
            {
                return;
            }

            written.ContinueWith(
                (_) =>
                {
                    stream.Ended.TrySetResult();
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }
}

/// <summary>A gateway mapped on an ASP.NET Core application of its own.</summary>
public static class HttpGatewayEndpoints
{
    /// <summary>
    /// Maps <paramref name="gateway"/> as the endpoint that answers what no other endpoint of the
    /// application answers: its routes, its document, and its 404 to any other path.
    /// </summary>
    public static IEndpointConventionBuilder MapBeadGateway(this IEndpointRouteBuilder endpoints, HttpGateway gateway)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        ArgumentNullException.ThrowIfNull(gateway);

        return endpoints.MapFallback(gateway.Answer);
    }
}
