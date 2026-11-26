using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using Amqp;

namespace Bead.Transport.Amqp;

/// <summary>
/// The connect of a link, <c>amqp</c> or <c>amqps</c>: its broker's name raced (RFC 8305), a
/// localhost name connected to the loopback itself, asking no resolver (spec 13.4); under
/// <c>amqps</c>, its TLS spoken with the settings its library's factory holds, its broker's name the
/// server name, as the library's own transport speaks it. One per connect, given up with its token.
/// </summary>
internal sealed class RacingTransportProvider : TransportProvider
{
    // the platform's clock its adapter holds, which its race runs on
    private readonly TimeProvider _platform;
    private readonly CancellationToken _cancellationToken;

    /// <summary>
    /// A provider of <c>AMQP</c> and <c>AMQPS</c>, its race on <paramref name="platform"/>, its
    /// adapter's platform clock, whose connect <paramref name="cancellationToken"/> gives up.
    /// </summary>
    public RacingTransportProvider(TimeProvider platform, CancellationToken cancellationToken)
    {
        _platform = platform;
        _cancellationToken = cancellationToken;
        AddressSchemes = ["AMQP", "AMQPS"];
    }

    /// <summary>
    /// The TLS settings of its factory, read as it connects under <c>amqps</c>: set once that factory
    /// is built over it, before its connect.
    /// </summary>
    public ConnectionFactory.SslSettings? Ssl { get; set; }

    /// <summary>A transport over the socket of the first attempt that connects, under TLS for <c>AMQPS</c>.</summary>
    public override async Task<IAsyncTransport> CreateAsync(Address address)
    {
        ArgumentNullException.ThrowIfNull(address);

        var socket = await HappyEyeballs.ConnectAsync(new DnsEndPoint(address.Host, address.Port), new HappyEyeballsOptions { Clock = _platform, CancellationToken = _cancellationToken });
        Stream stream = new NetworkStream(socket, ownsSocket: true);

        try
        {
            if (address.UseSsl)
            {
                var secured = new SslStream(stream, leaveInnerStreamOpen: false);

                stream = secured;
                await secured.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                {
                    TargetHost = address.Host,
                    ClientCertificates = Ssl?.ClientCertificates,
                    EnabledSslProtocols = Ssl?.Protocols ?? default,
                    CertificateRevocationCheckMode = Ssl?.CheckCertificateRevocation == true ? X509RevocationMode.Online : X509RevocationMode.NoCheck,
                    RemoteCertificateValidationCallback = Ssl?.RemoteCertificateValidationCallback,
                    LocalCertificateSelectionCallback = Ssl?.LocalCertificateSelectionCallback,
                }, _cancellationToken);
            }

            return new StreamTransport(stream);
        }
        catch
        {
            await stream.DisposeAsync();

            throw;
        }
    }

    // a link's bytes over its stream, as the library's own transport reads and writes its socket
    private sealed class StreamTransport(Stream stream) : IAsyncTransport
    {
        public void SetConnection(Connection connection)
        {
            // its connection is told of a failure by its reads
        }

        public async Task SendAsync(IList<ByteBuffer> bufferList, int listSize)
        {
            // * one write, so one TLS record holds what the library sends together
            if (bufferList.Count == 1)
            {
                await stream.WriteAsync(bufferList[0].Buffer.AsMemory(bufferList[0].Offset, bufferList[0].Length));

                return;
            }

            var joined = new byte[listSize];
            var at = 0;

            foreach (var buffer in bufferList)
            {
                Buffer.BlockCopy(buffer.Buffer, buffer.Offset, joined, at, buffer.Length);
                at += buffer.Length;
            }

            await stream.WriteAsync(joined.AsMemory(0, at));
        }

        public Task<int> ReceiveAsync(byte[] buffer, int offset, int count)
        {
            return stream.ReadAsync(buffer, offset, count);
        }

        public void Send(ByteBuffer buffer)
        {
            stream.Write(buffer.Buffer, buffer.Offset, buffer.Length);
        }

        public int Receive(byte[] buffer, int offset, int count)
        {
            return stream.Read(buffer, offset, count);
        }

        public void Close()
        {
            stream.Dispose();
        }
    }
}
