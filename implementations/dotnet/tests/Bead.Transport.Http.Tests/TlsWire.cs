using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// What a request over TLS was answered: over HTTP/2, its status and its mark, or the code its
/// stream was reset with, or its session ended with, nothing written; over HTTP/1.1, its status.
/// </summary>
internal sealed record TlsAnswer(int? Status, string? Refusal, uint? Reset, uint? Ended = null);

/// <summary>
/// A socket of the tests' own over TLS, trusting the certificate given alone, which writes by hand
/// what <see cref="HttpClient"/> will not, since it derives <c>:authority</c> from its URI and judges
/// a <c>Host</c> itself: over HTTP/2 (RFC 9113), offered by ALPN, its preface, an empty SETTINGS and
/// one HEADERS frame of the fields given, each a literal never indexed, never Huffman-coded (RFC
/// 7541 §6.2.3); over HTTP/1.1, a head as it is given.
/// </summary>
internal sealed class TlsWire : IAsyncDisposable
{
    // constants

    // the client's connection preface (RFC 9113 §3.4)
    private static readonly byte[] Preface = Encoding.ASCII.GetBytes("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

    private const byte Headers = 0x1;
    private const byte ResetStream = 0x3;
    private const byte Settings = 0x4;
    private const byte GoAway = 0x7;
    private const byte EndStream = 0x1;
    private const byte EndHeaders = 0x4;
    private const byte Acknowledged = 0x1;

    // the fields of RFC 7541's static table a response's status is written by (Appendix A)
    private static readonly Dictionary<int, int> StaticStatuses = new() { [8] = 200, [9] = 204, [10] = 206, [11] = 304, [12] = 400, [13] = 404, [14] = 500 };

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly TcpClient _tcp;
    private readonly SslStream _tls;

    private TlsWire(TcpClient tcp, SslStream tls)
    {
        _tcp = tcp;
        _tls = tls;
    }

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // a frame: its length, its type, its flags and its stream (RFC 9113 §4.1), then its payload
    private static byte[] FrameOf((byte Type, byte Flags, int Stream) head, byte[] payload)
    {
        var frame = new byte[9 + payload.Length];

        frame[0] = (byte)(payload.Length >> 16);
        frame[1] = (byte)(payload.Length >> 8);
        frame[2] = (byte)payload.Length;
        frame[3] = head.Type;
        frame[4] = head.Flags;
        BinaryPrimitives.WriteInt32BigEndian(frame.AsSpan(5), head.Stream);
        payload.CopyTo(frame, 9);

        return frame;
    }

    // a header block of literals never indexed, each name and value of fewer than 127 octets
    private static byte[] BlockOf(IReadOnlyList<(string Name, string Value)> fields)
    {
        var block = new List<byte>();

        foreach (var (name, value) in fields)
        {
            // ! a length past 126 would take more than its one octet's prefix
            Assert.True(name.Length < 127 && value.Length < 127, name);
            block.Add(0x10);
            block.Add((byte)name.Length);
            block.AddRange(Encoding.Latin1.GetBytes(name));
            block.Add((byte)value.Length);
            block.AddRange(Encoding.Latin1.GetBytes(value));
        }

        return [.. block];
    }

    private async Task<byte[]> ReadExactly(int length)
    {
        var bytes = new byte[length];

        await _tls.ReadExactlyAsync(bytes, Cancelled).AsTask().WaitAsync(Patience, Cancelled);

        return bytes;
    }

    private async Task<(byte Type, byte Flags, int Stream, byte[] Payload)> ReadFrame()
    {
        var head = await ReadExactly(9);
        var length = (head[0] << 16) | (head[1] << 8) | head[2];

        return (head[3], head[4], BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(5)) & 0x7FFF_FFFF, await ReadExactly(length));
    }

    // definition

    /// <summary>A socket connected to the port given and its TLS shaken hands, offering the protocol given.</summary>
    public static async Task<TlsWire> Open(int port, (X509Certificate2 Certificate, SslApplicationProtocol Protocol) tls)
    {
        var tcp = new TcpClient();

        try
        {
            await tcp.ConnectAsync(IPAddress.Loopback, port, Cancelled);

            var stream = new SslStream(tcp.GetStream());

            await stream.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
            {
                TargetHost = "127.0.0.1",
                ApplicationProtocols = [tls.Protocol],
                RemoteCertificateValidationCallback = (_, certificate, _, _) =>
                {
                    return certificate is not null && certificate.GetCertHashString() == tls.Certificate.GetCertHashString();
                },
            }, Cancelled);
            Assert.Equal(tls.Protocol, stream.NegotiatedApplicationProtocol);

            return new TlsWire(tcp, stream);
        }
        catch
        {
            tcp.Dispose();

            throw;
        }
    }

    /// <summary>
    /// One request over HTTP/2, of the fields given after <c>:method</c>, <c>:scheme</c> and
    /// <c>:path</c>, its stream ended with its head: what its stream was answered, its status and
    /// its mark, or the code its stream was reset with, or its session ended with before any answer.
    /// </summary>
    public async Task<TlsAnswer> Ask(IReadOnlyList<(string Name, string Value)> fields)
    {
        (string, string)[] request = [(":method", "POST"), (":scheme", "https"), (":path", "/bead"), .. fields];

        await _tls.WriteAsync(Preface, Cancelled);
        await _tls.WriteAsync(FrameOf((Settings, 0, 0), []), Cancelled);
        await _tls.WriteAsync(FrameOf((Headers, EndStream | EndHeaders, 1), BlockOf(request)), Cancelled);

        while (true)
        {
            var (type, flags, stream, payload) = await ReadFrame();

            if (type == Settings && (flags & Acknowledged) == 0)
            {
                await _tls.WriteAsync(FrameOf((Settings, Acknowledged, 0), []), Cancelled);
            }
            else if (stream == 1 && type == ResetStream)
            {
                return new TlsAnswer(null, null, BinaryPrimitives.ReadUInt32BigEndian(payload));
            }
            else if (type == GoAway)
            {
                // the session ended before any answer, the stream with it: its code after the last
                // stream id
                return new TlsAnswer(null, null, null, BinaryPrimitives.ReadUInt32BigEndian(payload.AsSpan(4)));
            }
            else if (stream == 1 && type == Headers)
            {
                return new HeaderBlock(payload).Answer();
            }
        }
    }

    /// <summary>One request over HTTP/1.1, its head as given: the status it was answered.</summary>
    public async Task<int> AskHead(string head)
    {
        await _tls.WriteAsync(Encoding.ASCII.GetBytes(head), Cancelled);

        var line = new List<byte>();

        while (line.Count < 2 || line[^2] != '\r' || line[^1] != '\n')
        {
            line.Add((await ReadExactly(1))[0]);
        }

        return int.Parse(Encoding.ASCII.GetString([.. line]).Split(' ')[1], CultureInfo.InvariantCulture);
    }

    public async ValueTask DisposeAsync()
    {
        await _tls.DisposeAsync();
        _tcp.Dispose();
    }

    // a response's header block, read as RFC 7541 writes one, its status and its mark kept
    private sealed class HeaderBlock(byte[] bytes)
    {
        private int _at;

        // an integer of the prefix given, and the octets that continue it (RFC 7541 §5.1)
        private int Integer(int prefix)
        {
            var most = (1 << prefix) - 1;
            var value = bytes[_at] & most;

            _at += 1;

            if (value < most)
            {
                return value;
            }

            for (var shift = 0; ; shift += 7)
            {
                var next = bytes[_at];

                _at += 1;
                value += (next & 0x7F) << shift;

                if ((next & 0x80) == 0)
                {
                    return value;
                }
            }
        }

        // a string literal (RFC 7541 §5.2): Kestrel writes none Huffman-coded
        private string Text()
        {
            Assert.True((bytes[_at] & 0x80) == 0, "a Huffman-coded string");

            var length = Integer(7);
            var text = Encoding.ASCII.GetString(bytes, _at, length);

            _at += length;

            return text;
        }

        public TlsAnswer Answer()
        {
            int? status = null;
            string? refusal = null;

            while (_at < bytes.Length)
            {
                var first = bytes[_at];

                if ((first & 0x80) != 0)
                {
                    // an indexed field: a status the static table holds, or one of no matter here
                    status = StaticStatuses.TryGetValue(Integer(7), out var indexed) ? indexed : status;

                    continue;
                }

                if ((first & 0xE0) == 0x20)
                {
                    // a dynamic table size update
                    Integer(5);

                    continue;
                }

                var index = Integer((first & 0x40) != 0 ? 6 : 4);
                var name = index == 0 ? Text() : StaticStatuses.ContainsKey(index) ? ":status" : $"#{index}";
                var value = Text();

                if (name == ":status")
                {
                    status = int.Parse(value, CultureInfo.InvariantCulture);
                }
                else if (name == HttpTransport.RefusalHeader)
                {
                    refusal = value;
                }
            }

            return new TlsAnswer(status, refusal, null);
        }
    }
}
