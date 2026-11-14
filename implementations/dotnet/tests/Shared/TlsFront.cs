using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

// * the PKI it reads is Pki.cs's, which every project linking this file links too
[assembly: AssemblyFixture(typeof(Bead.Tests.TlsStore))]

namespace Bead.Tests;

/// <summary>
/// The user's CA store of Windows, into which the platform writes the intermediates a client
/// presents by a context: its PKI's intermediate let go of before the first test of an assembly and
/// after its last, by thumbprint, so that no run judges a chain by what another left. Nothing on any
/// other platform, whose store the platform leaves alone.
/// </summary>
internal sealed class TlsStore : IDisposable
{
    public TlsStore()
    {
        Clean();
    }

    public void Dispose()
    {
        Clean();
    }

    private static void Clean()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var intermediate = X509Certificate2.CreateFromPem(Pki.Read("intermediate.pem"));
        using var store = new X509Store(StoreName.CertificateAuthority, StoreLocation.CurrentUser);

        store.Open(OpenFlags.ReadWrite);

        foreach (var found in store.Certificates.Find(X509FindType.FindByThumbprint, intermediate.Thumbprint, false))
        {
            using (found)
            {
                store.Remove(found);
            }
        }
    }
}

/// <summary>How a <see cref="TlsFront"/> takes TLS.</summary>
internal sealed record TlsFrontOptions
{
    /// <summary>The certificate it serves, of the PKI: <c>server</c> unless told, or <c>stranger-server</c>.</summary>
    public string Serving { get; init; } = "server";

    /// <summary>Whether it requires a client certificate under the PKI's root, or asks for none.</summary>
    public bool IsRequiring { get; init; } = true;

    /// <summary>The highest TLS version it speaks, and the one it speaks: TLS 1.3 unless told.</summary>
    public SslProtocols Protocol { get; init; } = SslProtocols.Tls13;
}

/// <summary>
/// The TLS front of the twins of spec 15.39, a small local proxy: it listens on the loopback, takes
/// TLS under a certificate of the PKI, requires a client certificate under its root, or asks for
/// none, and pipes the bytes to a plain transport server's port. It resumes no session, so each
/// connect is judged by a handshake of its own.
/// </summary>
internal sealed class TlsFront : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly X509Certificate2 _certificate;
    private readonly X509Certificate2 _root;
    private readonly (int Port, TlsFrontOptions Options) _behind;
    private readonly CancellationTokenSource _stopped = new();
    private readonly List<Task> _pipes = [];
    private readonly Task _accepting;

    private TlsFront((int Port, TlsFrontOptions Options) behind)
    {
        _behind = behind;
        _certificate = Pki.Serving(behind.Options.Serving);
        _root = X509Certificate2.CreateFromPem(Pki.Read("root.pem"));
        _listener.Start();
        _accepting = Accept();
    }

    /// <summary>The port it listens on, on 127.0.0.1.</summary>
    public int Port
    {
        get
        {
            return ((IPEndPoint)_listener.LocalEndpoint).Port;
        }
    }

    /// <summary>A front before the plain server listening on 127.0.0.1 at <paramref name="port"/>.</summary>
    public static TlsFront Start(int port, TlsFrontOptions? options = null)
    {
        return new TlsFront((port, options ?? new TlsFrontOptions()));
    }

    public async ValueTask DisposeAsync()
    {
        await _stopped.CancelAsync();
        _listener.Stop();

        try
        {
            await _accepting;
        }
        catch (Exception)
        {
            // its listener stopped under it
        }

        Task[] pipes;

        lock (_pipes)
        {
            pipes = [.. _pipes];
        }

        await Task.WhenAll(pipes);
        _certificate.Dispose();
        _root.Dispose();
        _stopped.Dispose();
    }

    private async Task Accept()
    {
        while (!_stopped.IsCancellationRequested)
        {
            var accepted = await _listener.AcceptTcpClientAsync(_stopped.Token);

            lock (_pipes)
            {
                _pipes.Add(Pipe(accepted));
            }
        }
    }

    // one connection: its handshake judged, then its bytes piped both ways until either end closes
    private async Task Pipe(TcpClient accepted)
    {
        var (port, options) = _behind;
        var policy = new X509ChainPolicy { TrustMode = X509ChainTrustMode.CustomRootTrust, RevocationMode = X509RevocationMode.NoCheck };

        policy.CustomTrustStore.Add(_root);

        using (accepted)
        await using (var tls = new SslStream(accepted.GetStream(), false))
        {
            try
            {
                await tls.AuthenticateAsServerAsync(
                    new SslServerAuthenticationOptions
                    {
                        AllowTlsResume = false,
                        CertificateChainPolicy = policy,
                        ClientCertificateRequired = options.IsRequiring,
                        EnabledSslProtocols = options.Protocol,
                        RemoteCertificateValidationCallback = (_, _, _, errors) =>
                        {
                            return !options.IsRequiring || errors == SslPolicyErrors.None;
                        },
                        ServerCertificate = _certificate,
                    },
                    _stopped.Token);

                using var behind = new TcpClient();

                await behind.ConnectAsync(IPAddress.Loopback, port, _stopped.Token);

                await using var plain = behind.GetStream();
                using var ending = CancellationTokenSource.CreateLinkedTokenSource(_stopped.Token);
                var outward = tls.CopyToAsync(plain, ending.Token);
                var inward = plain.CopyToAsync(tls, ending.Token);

                await Task.WhenAny(outward, inward);
                await ending.CancelAsync();
                await Task.WhenAll(outward, inward).ContinueWith((_) => { }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
            catch (Exception)
            {
                // a handshake refused, or an end gone: the connection closes
            }
        }
    }
}
