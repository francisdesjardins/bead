using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Bead.Tests;

/// <summary>What a connect to the loopback that failed says, and where nothing listens.</summary>
internal static class LoopbackFailures
{
    /// <summary>The sentence a localhost name's failed connect carries (spec 13.4).</summary>
    public const string Sentence = "bead-probe.localhost names the loopback: connected to 127.0.0.1 and ::1, no resolver asked";

    /// <summary>A port nothing listens on, on either loopback, as far as a test can tell.</summary>
    public static int Unheard()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        return ((IPEndPoint)listener.LocalEndpoint).Port;
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
/// every destination it is asked about goes to a listener of its own on 127.0.0.1, which records
/// what each connection sends first.
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
            Asked.Enqueue(destination);

            return new Uri($"http://127.0.0.1:{listener.Port}");
        }

        public bool IsBypassed(Uri host)
        {
            return false;
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
    // they came
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

            if (_answer is not null)
            {
                await stream.WriteAsync(Encoding.Latin1.GetBytes(_answer), deadline.Token);
            }
        }
        catch (Exception)
        {
            // what it read so far stands
        }

        _heads.Enqueue(read.ToString());

        try
        {
            _arrived.Release();
            socket.Shutdown(SocketShutdown.Both);
        }
        catch (Exception)
        {
            // disposed, or its peer gone first
        }
    }
}
