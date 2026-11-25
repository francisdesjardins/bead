using System.Net;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;

namespace Bead;

/// <summary>How <see cref="HappyEyeballs.ConnectAsync"/> resolves, connects and waits.</summary>
internal sealed record HappyEyeballsOptions
{
    /// <summary>What answers a name with its addresses, in the platform's order: its resolver when none.</summary>
    public Func<string, CancellationToken, Task<IPAddress[]>>? Resolve { get; init; }

    /// <summary>
    /// What makes one attempt at an address, a connected socket or a failure, given up when its
    /// token is cancelled: a TCP socket of its own when none. A caller's way to set its socket before
    /// it connects, and the tests' way to watch the race.
    /// </summary>
    public Func<IPEndPoint, CancellationToken, Task<Socket>>? Connect { get; init; }

    /// <summary>How long an attempt goes unanswered before the next starts: 250 milliseconds, RFC 8305 §5's default.</summary>
    public TimeSpan AttemptDelay { get; init; } = TimeSpan.FromMilliseconds(250);

    /// <summary>What the delay between attempts runs on: the system's clock when none.</summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>What gives the whole connect up, every attempt with it.</summary>
    public CancellationToken CancellationToken { get; init; }
}

/// <summary>
/// A connect by a name that races its addresses, as RFC 8305 (Happy Eyeballs v2) asks and as Node's
/// clients and the browsers do: the name resolved in the platform's order (RFC 6724), the address
/// families interleaved, the first family the first answer's (§4); an attempt started every 250
/// milliseconds, each kept until one connects (§5), or at once when one fails, which is Bead's own;
/// the first connected kept, and the attempts left cancelled, a socket one of them connects after
/// closed. A connect given up ends every attempt, and no socket stays. The platform's own
/// connect tries each address in turn, and so waits out the refusal of a loopback family a server
/// does not listen on, two seconds on Windows, before it tries the other. A localhost name,
/// <c>localhost</c> or a name that ends in <c>.localhost</c>, asks no resolver: its addresses are
/// <c>127.0.0.1</c> then <c>::1</c>, the IPv4 loopback first, where a Bead server listens on its
/// defaults (spec 13.4, 15.12).
/// </summary>
internal static class HappyEyeballs
{
    // constants

    // the addresses of a localhost name, the IPv4 loopback first (spec 13.4)
    private static readonly IPAddress[] Loopbacks = [IPAddress.Loopback, IPAddress.IPv6Loopback];

    // helpers

    // the addresses in the order they are tried: the first answer's family first, then the families
    // in turn, each in its own order (RFC 8305 §4)
    private static List<IPAddress> Interleave(IPAddress[] addresses)
    {
        if (addresses.Length == 0)
        {
            return [];
        }

        var family = addresses[0].AddressFamily;
        var first = new Queue<IPAddress>(addresses.Where((address) =>
        {
            return address.AddressFamily == family;
        }));
        var other = new Queue<IPAddress>(addresses.Where((address) =>
        {
            return address.AddressFamily != family;
        }));
        var ordered = new List<IPAddress>(addresses.Length);

        while (first.Count > 0 || other.Count > 0)
        {
            if (first.TryDequeue(out var preferred))
            {
                ordered.Add(preferred);
            }

            if (other.TryDequeue(out var next))
            {
                ordered.Add(next);
            }
        }

        return ordered;
    }

    // one attempt at an address, on a socket of its own, which goes with a failure
    private static async Task<Socket> Attempt(IPEndPoint endPoint, CancellationToken cancellationToken)
    {
        var socket = new Socket(endPoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };

        try
        {
            await socket.ConnectAsync(endPoint, cancellationToken);

            return socket;
        }
        catch
        {
            socket.Dispose();

            throw;
        }
    }

    // an attempt the race no longer waits on: a socket it connects after all is closed
    private static async Task Abandon(Task<Socket> attempt)
    {
        try
        {
            (await attempt).Dispose();
        }
        catch (Exception)
        {
            // cancelled, or failed: nothing is left of it
        }
    }

    // what a localhost name's connect that failed says, beside the platform's cause (spec 13.4)
    private static Exception FailureOf((string Host, Exception Last) failed)
    {
        var (host, last) = failed;

        if (!TransportSecurity.IsLocalhostName(host) || last is not SocketException platform)
        {
            return last;
        }

        // ! the constructor takes a SocketError: ErrorCode is the platform's own errno off Windows (111
        // for a refusal on Linux), which it would read as another
        return new SocketException((int)platform.SocketErrorCode, $"{platform.Message}; {host} names the loopback: connected to 127.0.0.1 and ::1, no resolver asked");
    }

    // definition

    // ! process-wide: a test that sets it runs alone, and puts back what it found
    /// <summary>
    /// What answers a name with its addresses where <see cref="HappyEyeballsOptions.Resolve"/> is
    /// none: the platform's resolver. A test hook, which stands in for that resolver end to end.
    /// </summary>
    public static Func<string, CancellationToken, Task<IPAddress[]>> PlatformResolve { get; set; } = Dns.GetHostAddressesAsync;

    /// <summary>
    /// Connects to <paramref name="endPoint"/>: its host, an IP address or a name, the name resolved
    /// and its addresses raced; the socket of the first attempt that connects. A localhost name is
    /// never resolved: its addresses are <c>127.0.0.1</c> and <c>::1</c>, in that order. When every
    /// attempt fails, the last failure, which for a localhost name says it went to the loopback; a
    /// name that resolves to none, a <see cref="SocketException"/>, host not found.
    /// </summary>
    public static async Task<Socket> ConnectAsync(DnsEndPoint endPoint, HappyEyeballsOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(endPoint);

        var given = options ?? new HappyEyeballsOptions();
        var cancellationToken = given.CancellationToken;
        // ! its host read as the URL Standard reads it, as every client reads it before it dials
        // (spec 13.4): a guard beside them, one that parser fails on refused before any attempt
        var read = TransportSecurity.DialedHost(endPoint.Host);
        var host = read.StartsWith('[') && read.EndsWith(']') ? read[1..^1] : read;
        var resolve = given.Resolve ?? PlatformResolve;
        var connect = given.Connect ?? Attempt;
        var clock = given.Clock ?? TimeProvider.System;

        // * a localhost name asks no resolver, whatever the platform's would answer (spec 13.4)
        var addresses = Interleave(IPAddress.TryParse(host, out var literal)
            ? [literal]
            : TransportSecurity.IsLocalhostName(host) ? Loopbacks : await resolve(host, cancellationToken));

        if (addresses.Count == 0)
        {
            throw new SocketException((int)SocketError.HostNotFound);
        }

        using var racing = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var attempts = new List<Task<Socket>>();
        var next = 0;
        Exception? failure = null;

        try
        {
            while (next < addresses.Count || attempts.Count > 0)
            {
                if (next < addresses.Count)
                {
                    attempts.Add(connect(new IPEndPoint(addresses[next], endPoint.Port), racing.Token));
                    next += 1;
                }

                using var pause = CancellationTokenSource.CreateLinkedTokenSource(racing.Token);
                var delay = Task.Delay(next < addresses.Count ? given.AttemptDelay : Timeout.InfiniteTimeSpan, clock, pause.Token);
                var done = await Task.WhenAny(attempts.Append<Task>(delay));

                await pause.CancelAsync();
                cancellationToken.ThrowIfCancellationRequested();

                if (done is not Task<Socket> attempt)
                {
                    continue;
                }

                attempts.Remove(attempt);

                if (attempt.IsCompletedSuccessfully)
                {
                    return attempt.Result;
                }

                // * a failure starts the next attempt at once, not 250 milliseconds after it
                failure = attempt.Exception?.InnerException ?? new OperationCanceledException(cancellationToken);
            }

            var failed = FailureOf((host, failure!));

            if (failed == failure)
            {
                ExceptionDispatchInfo.Throw(failure);
            }

            throw failed;
        }
        finally
        {
            await racing.CancelAsync();

            foreach (var left in attempts)
            {
                _ = Abandon(left);
            }
        }
    }

    /// <summary>
    /// The connect a <see cref="SocketsHttpHandler"/> makes through <see cref="ConnectAsync"/>: its
    /// endpoint raced, its socket a stream it owns.
    /// </summary>
    public static async ValueTask<Stream> ConnectCallback(SocketsHttpConnectionContext context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);

        var socket = await ConnectAsync(context.DnsEndPoint, new HappyEyeballsOptions { CancellationToken = cancellationToken });

        return new NetworkStream(socket, ownsSocket: true);
    }
}
