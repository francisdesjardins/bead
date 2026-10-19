using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Net.Http.Headers;

namespace Bead.Transport.Http;

public sealed partial class HttpTransportServer
{
    // request fields and HTTP response writing, with no connection state or refusal listeners
    private static class HttpServerFields
    {
        // the error a stream of a malformed request is reset with over HTTP/2 (RFC 9113 §7)
        private const int ProtocolError = 0x1;

        // whether the request says it has a body: a length above 0, or a transfer coding, as its headers
        // say it and as the TypeScript side reads them — never whether HTTP/2's end of stream has come
        // in yet, which an empty body's last frame races
        internal static bool HasBody(HttpContext context)
        {
            return context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey(HeaderNames.TransferEncoding);
        }

        // a body of Bead's media type, parameters aside, sent as it is
        internal static bool IsBeadBody(HttpRequest request)
        {
            var types = request.Headers.ContentType;
            var type = (types.Count == 0 ? null : types[0])?.Split(';')[0].Trim().ToLowerInvariant();
            var encoding = HeaderOf(request, HeaderNames.ContentEncoding)?.Trim().ToLowerInvariant();

            return type == HttpTransport.MediaType && encoding is null or "identity";
        }

        // whether a connect says its client listens: an Item whose bare item is a Boolean, its
        // parameters ignored (RFC 9651 §2.3), absent being ?0; anything else is none
        internal static bool? ListeningOf(HttpRequest request)
        {
            return StructuredFields.ParseItem(HeaderOf(request, HttpTransport.ListenHeader) ?? "?0")?.BareItem as bool?;
        }

        // a CORS preflight's answer from an origin the server lists, whatever method it asks for: the
        // browser judges its request against it (Fetch §4.8). Authorization is named, since no wildcard
        // covers it; then the names the preflight asks, its lines joined by ", " (RFC 9110 §5.3), since
        // a browser may cache a name where it caches no wildcard; then `*`, a wildcard for a request
        // without credentials (Fetch §3.3.4), which every request to the server is. No Vary names what
        // it asked: no cache stores an answer to OPTIONS (RFC 9110 §9.3.7)
        internal static End PreflightOf(HttpRequest request)
        {
            // ! joined by ", " here, as Node joins them: StringValues.ToString() joins by ","
            var asked = string.Join(", ", request.Headers.AccessControlRequestHeaders.AsEnumerable());
            string[] allowed = asked.Length == 0 ? ["authorization", "*"] : ["authorization", asked, "*"];

            return new End(StatusCodes.Status204NoContent)
            {
                Headers = new Dictionary<string, string>
                {
                    ["access-control-allow-methods"] = "GET, POST, DELETE",
                    ["access-control-allow-headers"] = string.Join(", ", allowed),
                    ["access-control-max-age"] = "7200",
                },
            };
        }

        // a header as the request gives it, given twice as one; none when absent, which is not empty
        internal static string? HeaderOf(HttpRequest request, string name)
        {
            var values = request.Headers[name];

            return values.Count == 0 ? null : values.ToString();
        }

        // a count a listen gives in its field (spec 15.9): an Item whose bare item is an Integer of 0 or
        // more, its parameters ignored (RFC 9651 §2.3), its lines joined, so two lines never parse.
        // Absent, it is 0, or none where it is required; anything else is none
        internal static long? CountOf(HttpRequest request, string name, CountOptions? options = null)
        {
            if (HeaderOf(request, name) is not { } value)
            {
                return options is { IsRequired: true } ? null : 0;
            }

            return StructuredFields.ParseItem(value)?.BareItem is long count and >= 0 ? count : null;
        }

        // a token as the server draws it: 22 characters of base64url
        internal static bool IsToken(string token)
        {
            return token.Length == 22 && token.All((character) =>
            {
                return char.IsAsciiLetterOrDigit(character) || character is '-' or '_';
            });
        }

        // the authority a request names, as it came (spec 15.12): an HTTP/1 request's absolute-form
        // target's, else its Host's; none when it names none
        internal static string? AuthorityOf(HttpContext context)
        {
            return HostsAndOrigins.AuthorityOf(context.Request.Headers.Host, TargetAuthorityOf(context));
        }

        // the authority an HTTP/1 request's target names in absolute-form; none for another form, and
        // over HTTP/2, whose :authority Kestrel has put in the Host
        internal static string? TargetAuthorityOf(HttpContext context)
        {
            var request = context.Request;
            var isHttp1 = HttpProtocol.IsHttp10(request.Protocol) || HttpProtocol.IsHttp11(request.Protocol);

            return isHttp1 ? HostsAndOrigins.TargetAuthorityOf(context.Features.Get<IHttpRequestFeature>()?.RawTarget) : null;
        }

        // whether every field value of a request is one a server reads (spec 15.12): visible ASCII, SP
        // and HTAB alone, neither SP nor HTAB at either end
        internal static bool HasVisibleFields(HttpRequest request)
        {
            return request.Headers.All((field) =>
            {
                return field.Value.All((value) =>
                {
                    return HostsAndOrigins.IsVisibleField(value ?? "");
                });
            });
        }

        // closes an HTTP/1 socket behind its exchange, whose body is not read: what follows would read as
        // the next request
        internal static void CloseBehind(HttpContext context)
        {
            if (!HttpProtocol.IsHttp2(context.Request.Protocol) && !HttpProtocol.IsHttp3(context.Request.Protocol))
            {
                context.Response.Headers.Connection = "close";
            }
        }

        // writes an exchange's end, once: its status and headers, marked when it is a refusal
        // ! never told: the 404 of a connection that closes is 15.7's close, told by Close, never a
        // refusal; Finish tells what the transport judges
        internal static async Task EndWith(HttpContext context, End end)
        {
            var response = context.Response;

            if (!response.HasStarted)
            {
                response.StatusCode = end.Status;
                StampOf(response);

                foreach (var (name, value) in end.Headers ?? new Dictionary<string, string>())
                {
                    response.Headers[name] = value;
                }

                if (end.Reason is { } reason)
                {
                    response.Headers[HttpTransport.RefusalHeader] = reason;
                }
            }

            await response.CompleteAsync();
        }

        // what every response on the path carries: never stored, never sniffed, and which one a request
        // gets turns on its Origin (RFC 9110 §12.5.5)
        internal static void StampOf(HttpResponse response)
        {
            response.Headers.CacheControl = "no-store";
            response.Headers.XContentTypeOptions = "nosniff";
            response.Headers.Vary = "Origin";
        }

        // what HTTP refuses of its own, as Kestrel answers it: 400, unmarked, none of the path's fields,
        // its socket closed behind it, nothing told (spec 15.12)
        internal static async Task RefuseMalformed(HttpContext context)
        {
            var response = context.Response;

            if (!response.HasStarted)
            {
                response.StatusCode = StatusCodes.Status400BadRequest;
                response.Headers.Connection = "close";
            }

            await response.CompleteAsync();
        }

        // a request's head, a 200 of Bead's type, which says the router has it: once, before its answer
        internal static async Task SendHead(HttpContext context)
        {
            if (!context.Response.HasStarted)
            {
                context.Response.StatusCode = StatusCodes.Status200OK;
                StampOf(context.Response);
                context.Response.ContentType = HttpTransport.MediaType;
                await context.Response.StartAsync(context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
            }
        }

        internal static bool ResetMalformedFields(HttpContext context)
        {
            if (HttpProtocol.IsHttp2(context.Request.Protocol) && context.Features.Get<IHttpResetFeature>() is { } reset)
            {
                reset.Reset(ProtocolError);

                return true;
            }

            return false;
        }
    }

    // how the transport ends an exchange of its own: its status, the refusal it is marked with, and
    // its headers
    private sealed record End(int Status, string? Reason = null)
    {
        public IReadOnlyDictionary<string, string>? Headers { get; init; }
    }

    // how a listen's count is read: whether its field is required, or 0 when left out
    private sealed record CountOptions
    {
        public bool IsRequired { get; init; }
    }
}
