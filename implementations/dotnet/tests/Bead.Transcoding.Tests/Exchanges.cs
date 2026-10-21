using System.Globalization;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <c>transcoding.json</c>'s exchanges, each against a gateway of the Transcoding service in
/// process, its server joined, over a real socket: a socket of the test's own writes each request's
/// octets, an exchange to a socket, and reads its response as a client reads one.
/// </summary>
internal static partial class Exchanges
{
    private const string Host = "127.0.0.1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    /// <summary>Each exchange played, what parts from the file told in <paramref name="parted"/>.</summary>
    public static async Task Play(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("exchanges").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;

            try
            {
                await PlayOne(entry, parted);
            }
            catch (Exception reason) when (reason is IOException or SocketException or TimeoutException or FormatException or InvalidOperationException)
            {
                parted.Add($"exchanges: {name}: {reason.GetType().Name}, {reason.Message}");
            }
        }
    }

    /// <summary>A gateway of the Transcoding service, built of the file's defaults and <paramref name="given"/> beside them.</summary>
    public static HttpGatewayOptions OptionsOf(MemoryTransportServer memory, JsonElement? given)
    {
        var defaults = Root.GetProperty("defaults");
        long Count(string name)
        {
            return given is { } case_ && case_.TryGetProperty(name, out var value) ? value.GetInt64() : defaults.GetProperty(name).GetInt64();
        }

        TimeSpan Time(string name)
        {
            return TimeSpan.FromMilliseconds(Count(name));
        }

        string Text(string name)
        {
            return given is { } case_ && case_.TryGetProperty(name, out var value) ? value.GetString()! : defaults.GetProperty(name).GetString()!;
        }

        return new HttpGatewayOptions
        {
            Transport = memory,
            Routes = HttpRoutes.All,
            Document = Document,
            ProblemTypes = HttpRoutes.ProblemTypes,
            Origins = [.. defaults.GetProperty("origins").EnumerateArray().Select((origin) =>
            {
                return origin.GetString()!;
            })],
            Authorization = Text("authorization") == "bearer-jwt" ? GatewayAuthorization.BearerJwt : GatewayAuthorization.Elsewhere,
            Challenge = Text("challenge"),
            Timeout = Time("timeout"),
            Window = (int)Count("window"),
            Heartbeat = Time("heartbeat"),
            MaximumExchanges = (int)Count("maximumExchanges"),
            MaximumExchangesPerAddress = (int)Count("maximumExchangesPerAddress"),
            MaximumConnections = (int)Count("maximumConnections"),
            MaximumConnectionsPerAddress = (int)Count("maximumConnectionsPerAddress"),
            BodyBytesBudget = Count("bodyBytesBudget"),
            MaximumBodyBytes = (int)Count("maximumBodyBytes"),
            HeadersTimeout = Time("headersTimeout"),
            MinimumBodyBytesPerSecond = (int)Count("minimumBodyBytesPerSecond"),
            BodyGracePeriod = Time("bodyGracePeriod"),
            MinimumSendBytesPerSecond = (int)Count("minimumSendBytesPerSecond"),
            SendGracePeriod = Time("sendGracePeriod"),
            MaximumUnsentBytes = Count("maximumUnsentBytes"),
        };
    }

    private static async Task PlayOne(JsonElement entry, List<string> parted)
    {
        var name = entry.GetProperty("name").GetString()!;

        await using var service = await TranscodingService.Start();
        await using var gateway = new HttpGateway(OptionsOf(service.Memory, entry.TryGetProperty("options", out var options) ? options : null));

        var address = await gateway.Start(new HttpGatewayStartOptions { Address = Host, FindOpenPort = true });
        var host = $"{Host}:{address.Port.ToString(CultureInfo.InvariantCulture)}";
        var sockets = new Dictionary<string, (Socket Socket, Reader Reader, string Method)>(StringComparer.Ordinal);
        var captured = new Dictionary<string, string>(StringComparer.Ordinal);

        try
        {
            foreach (var step in entry.GetProperty("steps").EnumerateArray())
            {
                if (step.TryGetProperty("send", out var send))
                {
                    var on = step.GetProperty("on").GetString()!;
                    var head = Substituted(send.GetProperty("head").GetString()!, (host, captured));
                    var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

                    await socket.ConnectAsync(Host, address.Port);
                    await socket.SendAsync(Encoding.UTF8.GetBytes(head));

                    if (StringOf(send, "body") is { } body)
                    {
                        await socket.SendAsync(Hex(body));
                    }

                    sockets[on] = (socket, new Reader(socket), head.Split(' ')[0]);
                }
                else if (step.TryGetProperty("expect", out var expect))
                {
                    var on = step.GetProperty("on").GetString()!;
                    var (_, reader, method) = sockets[on];
                    var parts = await Expect(expect, (reader, method, captured)).WaitAsync(Patience);

                    parted.AddRange(parts.Select((part) =>
                    {
                        return $"exchanges: {name}: {part}";
                    }));
                }
                else if (step.TryGetProperty("close", out var close))
                {
                    var (socket, _, _) = sockets[close.GetString()!];

                    socket.Close();
                }
                else
                {
                    var until = step.GetProperty("until").GetProperty("hanging").GetInt32();
                    var since = TimeProvider.System.GetTimestamp();

                    while (service.Hanging < until)
                    {
                        if (TimeProvider.System.GetElapsedTime(since) > Patience)
                        {
                            throw new TimeoutException($"hanging never reached {until}");
                        }

                        await Task.Delay(TimeSpan.FromMilliseconds(10), TimeProvider.System);
                    }
                }
            }
        }
        finally
        {
            foreach (var (socket, _, _) in sockets.Values)
            {
                socket.Dispose();
            }
        }
    }

    private static string Substituted(string text, (string Host, Dictionary<string, string> Captured) with)
    {
        var substituted = text.Replace("{host}", with.Host, StringComparison.Ordinal);

        foreach (var (name, value) in with.Captured)
        {
            substituted = substituted.Replace("{" + name + "}", value, StringComparison.Ordinal);
        }

        return substituted;
    }

    // what a response parts from what a step expects of it: its status, its fields, its body
    private static async Task<List<string>> Expect(JsonElement expect, (Reader Reader, string Method, Dictionary<string, string> Captured) on)
    {
        var (reader, method, captured) = on;
        var parts = new List<string>();
        var (status, fields) = await reader.ReadHead();
        var etag = $"\"{Convert.ToHexStringLower(SHA256.HashData(Document))}\"";

        if (status != expect.GetProperty("status").GetInt32())
        {
            parts.Add($"status {status}");
        }

        foreach (var field in expect.GetProperty("fields").EnumerateObject())
        {
            var held = fields.GetValueOrDefault(field.Name);

            switch (field.Value.ValueKind)
            {
                case JsonValueKind.Null:
                    if (held is not null)
                    {
                        parts.Add($"{field.Name}: {held}, where none is");
                    }

                    break;
                case JsonValueKind.String:
                    if (held != field.Value.GetString())
                    {
                        parts.Add($"{field.Name}: {held ?? "none"}");
                    }

                    break;
                default:
                    if (held != etag)
                    {
                        parts.Add($"{field.Name}: {held ?? "none"}, no tag of the document");
                    }

                    if (StringOf(field.Value, "capture") is { } capture && held is not null)
                    {
                        captured[capture] = held;
                    }

                    break;
            }
        }

        if (StringOf(expect, "stream") is { } stream)
        {
            var begun = Encoding.UTF8.GetString(await reader.ReadPrefix((fields, Encoding.UTF8.GetByteCount(stream))));

            if (begun != stream)
            {
                parts.Add($"stream {begun}");
            }

            return parts;
        }

        var body = method == "HEAD" ? [] : await reader.ReadBody((status, fields));

        if (StringOf(expect, "bodyBytes") is { } bytes)
        {
            if (!body.SequenceEqual(Hex(bytes)))
            {
                parts.Add($"body {Convert.ToHexString(body)}");
            }

            return parts;
        }

        var text = Encoding.UTF8.GetString(body);
        var expected = expect.GetProperty("body").GetString()!.Replace("{document}", Encoding.UTF8.GetString(Document), StringComparison.Ordinal);
        var pattern = "^" + Regex.Escape(expected).Replace(Regex.Escape("{words}"), "\"(?:[^\"\\\\]|\\\\.)+\"", StringComparison.Ordinal) + "$";

        if (!Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant))
        {
            parts.Add($"body {text}");
        }

        return parts;
    }

    // a response read off a socket: its head, then its body by its length, de-chunked, or to its end
    private sealed class Reader(Socket socket)
    {
        private readonly List<byte> _came = [];

        public async Task<(int Status, Dictionary<string, string> Fields)> ReadHead()
        {
            var statusLine = await ReadLine();
            var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            for (var line = await ReadLine(); line.Length > 0; line = await ReadLine())
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);
                var name = line[..colon].Trim().ToLowerInvariant();
                var value = line[(colon + 1)..].Trim();

                fields[name] = fields.TryGetValue(name, out var before) ? $"{before}, {value}" : value;
            }

            return (int.Parse(statusLine.Split(' ')[1], CultureInfo.InvariantCulture), fields);
        }

        public async Task<byte[]> ReadBody((int Status, Dictionary<string, string> Fields) head)
        {
            if (head.Status is (>= 100 and < 200) or 204 or 304)
            {
                return [];
            }

            if (head.Fields.TryGetValue("transfer-encoding", out var coding) && coding.EndsWith("chunked", StringComparison.OrdinalIgnoreCase))
            {
                var body = new List<byte>();

                for (var size = SizeOf(await ReadLine()); size > 0; size = SizeOf(await ReadLine()))
                {
                    body.AddRange(await ReadExactly(size));
                    await ReadLine();
                }

                return [.. body];
            }

            if (head.Fields.TryGetValue("content-length", out var length))
            {
                return await ReadExactly(int.Parse(length, CultureInfo.InvariantCulture));
            }

            while (await Fill())
            {
                // to its end
            }

            return Take(_came.Count);
        }

        // the first bytes of a body that does not end, de-chunked
        public async Task<byte[]> ReadPrefix((Dictionary<string, string> Fields, int Count) asked)
        {
            var body = new List<byte>();
            var isChunked = asked.Fields.TryGetValue("transfer-encoding", out var coding) && coding.EndsWith("chunked", StringComparison.OrdinalIgnoreCase);

            while (body.Count < asked.Count)
            {
                if (!isChunked)
                {
                    body.AddRange(await ReadExactly(asked.Count - body.Count));

                    continue;
                }

                var size = SizeOf(await ReadLine());

                if (size == 0)
                {
                    break;
                }

                body.AddRange(await ReadExactly(size));
                await ReadLine();
            }

            return [.. body.Take(asked.Count)];
        }

        private static int SizeOf(string line)
        {
            var semicolon = line.IndexOf(';', StringComparison.Ordinal);

            return int.Parse(semicolon < 0 ? line : line[..semicolon], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        private async Task<bool> Fill()
        {
            var buffer = new byte[65_536];
            var count = await socket.ReceiveAsync(buffer);

            _came.AddRange(buffer.AsSpan(0, count));

            return count > 0;
        }

        private async Task<string> ReadLine()
        {
            while (true)
            {
                var at = _came.IndexOf((byte)'\n');

                if (at >= 0)
                {
                    var line = Encoding.ASCII.GetString(Take(at + 1));

                    return line.TrimEnd('\r', '\n');
                }

                if (!await Fill())
                {
                    throw new IOException("the socket ended before its line");
                }
            }
        }

        private async Task<byte[]> ReadExactly(int count)
        {
            while (_came.Count < count)
            {
                if (!await Fill())
                {
                    throw new IOException("the socket ended before its body");
                }
            }

            return Take(count);
        }

        private byte[] Take(int count)
        {
            var taken = _came.GetRange(0, count).ToArray();

            _came.RemoveRange(0, count);

            return taken;
        }
    }
}
