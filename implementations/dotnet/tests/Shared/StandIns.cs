using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Bead.Tests;

/// <summary>What a connect to the loopback that failed says.</summary>
internal static class LoopbackFailures
{
    /// <summary>The sentence a localhost name's failed connect carries (spec 13.4).</summary>
    public const string Sentence = "bead-probe.localhost names the loopback: connected to 127.0.0.1 and ::1, no resolver asked";
}

// ! a port let go before its connect is one another test's listener may take in the meantime, and
// a connect then reaches it: keep this undisposed across the connect, never only its number
/// <summary>
/// A port nothing listens on, held until disposed, as the TypeScript side's <c>closedPort</c> and the
/// Rust side's <c>closed_port</c> are: a socket bound on 127.0.0.1 and one on ::1, where this machine
/// has it, both on the same port and neither listening, so that a connect to either is refused.
/// Another test's draw of a port never takes it meanwhile. On Linux, a bind of that port by its
/// number is not kept off.
/// </summary>
internal sealed class ClosedPort : IDisposable
{
    private readonly List<Socket> _held = [];

    public ClosedPort()
    {
        while (true)
        {
            var ipv4 = Bound(new IPEndPoint(IPAddress.Loopback, 0));
            var port = ((IPEndPoint)ipv4.LocalEndPoint!).Port;

            _held.Add(ipv4);

            try
            {
                _held.Add(Bound(new IPEndPoint(IPAddress.IPv6Loopback, port)));
                Port = port;

                return;
            }
            catch (SocketException error) when (error.SocketErrorCode == SocketError.AddressAlreadyInUse)
            {
                // * taken on ::1 already: another port
                ipv4.Dispose();
                _held.Clear();
            }
            catch (SocketException)
            {
                // * a machine without the IPv6 loopback refuses its connect there all the same
                Port = port;

                return;
            }
        }
    }

    /// <summary>
    /// A port drawn free on both loopbacks and held on the one given alone: a listener of the other
    /// family alone takes it there, and a connect to this one is refused.
    /// </summary>
    public ClosedPort(IPAddress loopback) : this()
    {
        ArgumentNullException.ThrowIfNull(loopback);

        foreach (var socket in _held.ToList())
        {
            if (!((IPEndPoint)socket.LocalEndPoint!).Address.Equals(loopback))
            {
                socket.Dispose();
                _held.Remove(socket);
            }
        }
    }

    /// <summary>The port.</summary>
    public int Port { get; }

    public void Dispose()
    {
        foreach (var socket in _held)
        {
            socket.Dispose();
        }
    }

    private static Socket Bound(IPEndPoint endpoint)
    {
        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp);

        try
        {
            socket.Bind(endpoint);

            return socket;
        }
        catch (SocketException)
        {
            socket.Dispose();

            throw;
        }
    }
}

// ! ports below every system's ephemeral range (RFC 6335 §6), which no bind of port 0 is given: a
// test that probes a port once its listener let it go draws it here, or another test's bind of port
// 0 may take that port meanwhile, and its probe reaches that test's listener
/// <summary>
/// The ports below the ephemeral range, as the TypeScript side's <c>drawnNonEphemeral</c> and the
/// Rust side's <c>drawn_non_ephemeral</c> draw them.
/// </summary>
internal static class NonEphemeralPorts
{
    private const int First = 20_000;
    private const int Count = 10_000;

    /// <summary>A port below the ephemeral range, free on both loopbacks as it is drawn, let go at once.</summary>
    public static int Drawn()
    {
        for (var attempt = 0; ; attempt += 1)
        {
            var port = First + Random.Shared.Next(Count);

            try
            {
                using var v4 = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                using var v6 = new Socket(AddressFamily.InterNetworkV6, SocketType.Stream, ProtocolType.Tcp) { DualMode = false };

                v4.Bind(new IPEndPoint(IPAddress.Loopback, port));

                try
                {
                    v6.Bind(new IPEndPoint(IPAddress.IPv6Loopback, port));
                }
                catch (SocketException error) when (error.SocketErrorCode is SocketError.AddressNotAvailable or SocketError.AddressFamilyNotSupported)
                {
                    // * a machine without the IPv6 loopback: free where it has one
                }

                return port;
            }
            catch (SocketException) when (attempt < 64)
            {
                // taken on one loopback or the other: another draw
            }
        }
    }
}

/// <summary>
/// A resolver that stands in for the platform's, <see cref="HappyEyeballs.PlatformResolve"/>, until
/// disposed: it answers every name with 192.0.2.7 of TEST-NET-1 (RFC 5737), which no host answers,
/// and records each name it is asked.
/// </summary>
internal sealed class StandInResolver : IDisposable
{
    private readonly Func<string, CancellationToken, Task<IPAddress[]>> _found;
    private readonly ConcurrentQueue<string> _asked = new();

    public StandInResolver()
    {
        _found = HappyEyeballs.PlatformResolve;
        HappyEyeballs.PlatformResolve = (name, _) =>
        {
            _asked.Enqueue(name);

            return Task.FromResult(new[] { IPAddress.Parse("192.0.2.7") });
        };
    }

    /// <summary>The names it was asked, in turn.</summary>
    public IReadOnlyList<string> Asked
    {
        get
        {
            return [.. _asked];
        }
    }

    public void Dispose()
    {
        HappyEyeballs.PlatformResolve = _found;
    }
}

/// <summary>
/// A proxy that stands in for the platform's, <see cref="HttpClient.DefaultProxy"/>, until disposed:
/// every destination of the tests' own it is asked about goes to a listener of its own on 127.0.0.1,
/// which records what each connection sends first. The tests' own destinations are an address or a
/// special-use name (RFC 6761: <c>localhost</c>, <c>.localhost</c>, <c>.test</c>); any other goes
/// direct, unrecorded.
/// </summary>
internal sealed class StandInProxy : IAsyncDisposable
{
    private readonly IWebProxy _found;
    private readonly Recording _proxy;

    public StandInProxy()
    {
        _found = HttpClient.DefaultProxy;
        _proxy = new Recording(Listener);
        HttpClient.DefaultProxy = _proxy;
    }

    /// <summary>What receives what goes through it.</summary>
    public HeadListener Listener { get; } = new();

    /// <summary>The destinations it was asked to carry, in turn.</summary>
    public IReadOnlyList<Uri> Asked
    {
        get
        {
            return [.. _proxy.Asked];
        }
    }

    public async ValueTask DisposeAsync()
    {
        HttpClient.DefaultProxy = _found;
        await Listener.DisposeAsync();
    }

    private sealed class Recording(HeadListener listener) : IWebProxy
    {
        public ConcurrentQueue<Uri> Asked { get; } = new();

        public ICredentials? Credentials { get; set; }

        public Uri? GetProxy(Uri destination)
        {
            if (!IsTheTests(destination))
            {
                return null;
            }

            Asked.Enqueue(destination);

            return new Uri($"http://127.0.0.1:{listener.Port}");
        }

        public bool IsBypassed(Uri host)
        {
            return !IsTheTests(host);
        }

        // ! the proxy is the process's: the test platform's own traffic, its telemetry say, asks it
        // too, and recorded it would read as a test's connect
        private static bool IsTheTests(Uri destination)
        {
            var host = destination.IdnHost;

            if (destination.HostNameType is UriHostNameType.IPv4 or UriHostNameType.IPv6)
            {
                return true;
            }

            return host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
                || host.EndsWith(".test", StringComparison.OrdinalIgnoreCase);
        }
    }
}

/// <summary>
/// A listener on 127.0.0.1 that reads what each connection sends first, an HTTP request's head or
/// the first bytes of another protocol, answers it as told, nothing when none, and closes it.
/// </summary>
internal sealed class HeadListener : IAsyncDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentQueue<string> _heads = new();
    private readonly SemaphoreSlim _arrived = new(0);
    private readonly string? _answer;
    private readonly Task _accepting;

    public HeadListener(string? answer = null)
    {
        _answer = answer;
        _listener.Start();
        _accepting = Accept();
    }

    /// <summary>The port it listens on.</summary>
    public int Port
    {
        get
        {
            return ((IPEndPoint)_listener.LocalEndpoint).Port;
        }
    }

    /// <summary>What each connection sent first, in turn, read as Latin-1.</summary>
    public IReadOnlyList<string> Heads
    {
        get
        {
            return [.. _heads];
        }
    }

    /// <summary>Waits for the next connection's first bytes, and gives every one so far.</summary>
    public async Task<IReadOnlyList<string>> Next()
    {
        await _arrived.WaitAsync(Patience, TestContext.Current.CancellationToken);

        return Heads;
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();

        try
        {
            await _accepting;
        }
        catch (Exception)
        {
            // stopped
        }

        _stop.Dispose();
        _arrived.Dispose();
    }

    private async Task Accept()
    {
        while (!_stop.IsCancellationRequested)
        {
            var socket = await _listener.AcceptSocketAsync(_stop.Token);

            _ = Serve(socket);
        }
    }

    // an HTTP head read to its blank line; another protocol's bytes, a control byte among them, as
    // they came; recorded before its answer goes
    private async Task Serve(Socket socket)
    {
        using var owned = socket;
        using var stream = new NetworkStream(socket, ownsSocket: false);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        var read = new StringBuilder();
        var buffer = new byte[4096];

        deadline.CancelAfter(Patience);

        try
        {
            while (true)
            {
                var count = await stream.ReadAsync(buffer, deadline.Token);

                if (count == 0)
                {
                    break;
                }

                read.Append(Encoding.Latin1.GetString(buffer, 0, count));

                var text = read.ToString();

                if (text.Contains("\r\n\r\n", StringComparison.Ordinal) || text.Any((character) =>
                {
                    return character < ' ' && character is not '\r' and not '\n';
                }))
                {
                    break;
                }
            }
        }
        catch (Exception)
        {
            // what it read so far stands
        }

        // ! recorded before it answers: its client reads what it holds as soon as its answer came
        _heads.Enqueue(read.ToString());

        try
        {
            _arrived.Release();

            if (_answer is not null)
            {
                await stream.WriteAsync(Encoding.Latin1.GetBytes(_answer), deadline.Token);
            }

            socket.Shutdown(SocketShutdown.Both);
        }
        catch (Exception)
        {
            // disposed, or its peer gone first
        }
    }
}
