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
    /// token is cancelled: a TCP socket of its own when none. The tests' way to watch the race.
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
/// milliseconds, or at once when one fails, until one connects (§5); the first connected kept, and
/// the attempts left cancelled, a socket one of them connects after closed. The platform's own
/// connect tries each address in turn, and so waits out the refusal of a loopback family a server
/// does not listen on, two seconds on Windows, before it tries the other.
/// </summary>
internal static class HappyEyeballs
{
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

    // definition

    /// <summary>
    /// Connects to <paramref name="endPoint"/>: its host, an IP address or a name, the name resolved
    /// and its addresses raced; the socket of the first attempt that connects. When every one fails,
    /// the last failure; a name that resolves to none, a <see cref="SocketException"/>, host not found.
    /// </summary>
    public static async Task<Socket> ConnectAsync(DnsEndPoint endPoint, HappyEyeballsOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(endPoint);

        var given = options ?? new HappyEyeballsOptions();
        var cancellationToken = given.CancellationToken;
        var host = endPoint.Host.StartsWith('[') && endPoint.Host.EndsWith(']') ? endPoint.Host[1..^1] : endPoint.Host;
        var resolve = given.Resolve ?? Dns.GetHostAddressesAsync;
        var connect = given.Connect ?? Attempt;
        var clock = given.Clock ?? TimeProvider.System;
        var addresses = Interleave(IPAddress.TryParse(host, out var literal) ? [literal] : await resolve(host, cancellationToken));

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

            ExceptionDispatchInfo.Throw(failure!);

            throw failure!;
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
