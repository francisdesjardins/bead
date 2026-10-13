using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>
/// The opening handshakes of a WebSocket client of the tests' own, its socket bound with
/// <c>SO_REUSEADDR</c> to <c>127.0.0.1</c> and a port that clients share, each to another address of
/// one server listening on every address: two TCP connections that share the peer's half of their
/// pair of sockets and differ by the server's (RFC 9293 §3.4.1). Linux and Windows open them; macOS
/// answers on <c>127.0.0.1</c> alone by default. What its socket reads is kept, the close it was
/// sent read from it.
/// </summary>
internal sealed class SamePort : IDisposable
{
    // constants

    /// <summary>Why a test of two sockets from one address and port is skipped where it is.</summary>
    public const string Reason = "two sockets from one address and port, to two loopback addresses, open on Linux and Windows alone";

    // the octets its socket read, in order
    private readonly Kept _read = new();

    /// <summary>
    /// Handshakes over a socket bound to the port given, any free one for 0, which it then holds,
    /// so the next client shares it.
    /// </summary>
    public SamePort(StrongBox<int> port)
    {
        ArgumentNullException.ThrowIfNull(port);

        Invoker = new HttpMessageInvoker(new SocketsHttpHandler
        {
            ConnectCallback = async (context, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

                try
                {
                    socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    socket.Bind(new IPEndPoint(IPAddress.Loopback, port.Value));
                    port.Value = ((IPEndPoint)socket.LocalEndPoint!).Port;
                    await socket.ConnectAsync(context.DnsEndPoint, cancellationToken);

                    return new KeptStream(new NetworkStream(socket, true), _read);
                }
                catch
                {
                    socket.Dispose();

                    throw;
                }
            },
        });
    }

    // helpers

    /// <summary>Whether this platform opens two sockets from one address and port.</summary>
    public static bool IsOpened
    {
        get
        {
            return OperatingSystem.IsLinux() || OperatingSystem.IsWindows();
        }
    }

    /// <summary>What sends the handshakes.</summary>
    public HttpMessageInvoker Invoker { get; }

    /// <summary>
    /// The code of the close frame its socket was sent, read from what came after the handshake's
    /// answer, the server's frames unmasked (RFC 6455 §5.2); none when none came.
    /// </summary>
    public int? CloseCode
    {
        get
        {
            var bytes = _read.ToArray();
            var at = bytes.AsSpan().IndexOf("\r\n\r\n"u8) + 4;

            while (at > 3 && at + 2 <= bytes.Length)
            {
                var opcode = bytes[at] & 0x0F;
                var length = (long)(bytes[at + 1] & 0x7F);

                at += 2;

                if (length == 126)
                {
                    length = BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(at));
                    at += 2;
                }
                else if (length == 127)
                {
                    length = (long)BinaryPrimitives.ReadUInt64BigEndian(bytes.AsSpan(at));
                    at += 8;
                }

                if (opcode == 0x8)
                {
                    return length >= 2 ? BinaryPrimitives.ReadUInt16BigEndian(bytes.AsSpan(at)) : null;
                }

                at += (int)length;
            }

            return null;
        }
    }

    /// <summary>
    /// A client connected to <c>ws://</c> the server's address and port given, its socket bound to
    /// <c>127.0.0.1</c> and the port given, any free one for 0, and the port it was bound to.
    /// </summary>
    public static async Task<(ClientWebSocket Client, int Port)> Connect(IPEndPoint server, int port)
    {
        var bound = new StrongBox<int>(port);
        var client = new ClientWebSocket();

        try
        {
            // ! the handshake alone is the invoker's: the socket upgraded is the client's from then on
            using var handshakes = new SamePort(bound);

            await client.ConnectAsync(new Uri($"ws://{server}/"), handshakes.Invoker, TestContext.Current.CancellationToken);

            return (client, bound.Value);
        }
        catch
        {
            client.Dispose();

            throw;
        }
    }

    public void Dispose()
    {
        Invoker.Dispose();
    }

    // octets kept as they are read, under a lock: the socket reads on the platform's threads
    private sealed class Kept
    {
        private readonly Lock _gate = new();
        private readonly List<byte> _bytes = [];

        public void Add(ReadOnlySpan<byte> bytes)
        {
            lock (_gate)
            {
                _bytes.AddRange(bytes);
            }
        }

        public byte[] ToArray()
        {
            lock (_gate)
            {
                return [.. _bytes];
            }
        }
    }

    // a stream that keeps what it reads, and is otherwise the one it wraps
    private sealed class KeptStream(Stream inner, Kept kept) : Stream
    {
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
                return true;
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

        public override void Flush()
        {
            inner.Flush();
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
        {
            return inner.FlushAsync(cancellationToken);
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, count);

            kept.Add(buffer.AsSpan(offset, read));

            return read;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer, cancellationToken);

            kept.Add(buffer.Span[..read]);

            return read;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            inner.Write(buffer, offset, count);
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return inner.WriteAsync(buffer, cancellationToken);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return inner.WriteAsync(buffer, offset, count, cancellationToken);
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
            }

            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await inner.DisposeAsync();
            await base.DisposeAsync();
        }
    }
}
