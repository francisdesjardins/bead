using System.Net;
using System.Net.Sockets;

namespace Bead;

/// <summary>
/// How a server binds <c>localhost</c>, as each transport server does alike (spec 15.12): the IPv4
/// loopback, <c>127.0.0.1</c>, first, on the port it is given or on one drawn there, then the IPv6
/// one, <c>::1</c>, on that port, taking no IPv4 there, as Kestrel's <c>ListenLocalhost</c> binds
/// both. A port another socket holds on either fails the start; a port drawn is drawn again, at
/// most <see cref="MaximumDraws"/> times. Where the IPv6 loopback is absent, its bind refused for
/// want of the address or of the family, it listens on <c>127.0.0.1</c> alone and reports it.
/// </summary>
internal static class Loopbacks
{
    // constants

    /// <summary>The name an address takes besides an IP literal: both loopbacks, never resolved.</summary>
    public const string Localhost = "localhost";

    /// <summary>The most ports a start on <c>localhost</c> draws before it fails with the last one's error.</summary>
    public const int MaximumDraws = 8;

    // helpers

    // the platform's socket errors behind a failure, the failure itself among them, however it was
    // wrapped: Kestrel throws an IOException around its own AddressInUseException, the socket's
    // error inside
    private static IEnumerable<SocketError> ErrorsOf(Exception reason)
    {
        for (Exception? cause = reason; cause is not null; cause = cause.InnerException)
        {
            if (cause is SocketException socket)
            {
                yield return socket.SocketErrorCode;
            }

            if (cause is AggregateException aggregate)
            {
                foreach (var error in aggregate.InnerExceptions.SelectMany(ErrorsOf))
                {
                    yield return error;
                }
            }
        }
    }

    // definition

    /// <summary>
    /// A port free on the IPv4 loopback, as the system draws one: a socket bound there to port 0,
    /// then closed.
    /// </summary>
    public static int DrawPort()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));

        return ((IPEndPoint)socket.LocalEndPoint!).Port;
    }

    /// <summary>Whether a bind failed on a port another socket holds.</summary>
    public static bool IsInUse(Exception reason)
    {
        ArgumentNullException.ThrowIfNull(reason);

        return ErrorsOf(reason).Contains(SocketError.AddressAlreadyInUse);
    }

    /// <summary>
    /// Whether a bind failed for want of its address or of its family: the IPv6 loopback absent, as
    /// in a container with IPv6 off, or a kernel without IPv6.
    /// </summary>
    public static bool IsAbsent(Exception reason)
    {
        ArgumentNullException.ThrowIfNull(reason);

        return ErrorsOf(reason).Any((error) =>
        {
            return error is SocketError.AddressNotAvailable or SocketError.AddressFamilyNotSupported;
        });
    }

    /// <summary>
    /// Binds <c>localhost</c> by <paramref name="listen"/>, which starts a server on the addresses
    /// and the port it is handed, and lets go of what it built when it fails: both loopbacks, or,
    /// where the IPv6 one is absent, <c>127.0.0.1</c> alone. Gives what it started and the address it
    /// reports, <c>localhost</c> or <c>127.0.0.1</c>.
    /// </summary>
    public static async Task<(T Started, string Address)> Bind<T>(Func<(IReadOnlyList<IPAddress> Addresses, int Port), Task<T>> listen, LoopbackBinding binding)
    {
        ArgumentNullException.ThrowIfNull(listen);
        ArgumentNullException.ThrowIfNull(binding);

        for (var draw = 1; ; draw += 1)
        {
            var port = binding.FindOpenPort ? binding.DrawPort() : binding.Port;

            try
            {
                // the tests' way to refuse the IPv6 bind, as a host without its loopback does
                if (binding.IPv6Refusal?.Invoke(port) is { } refused)
                {
                    throw refused;
                }

                return (await listen(([IPAddress.Loopback, IPAddress.IPv6Loopback], port)), Localhost);
            }
            catch (Exception reason) when (IsAbsent(reason))
            {
                // ! no process can take ::1 where there is none, so the IPv4 loopback alone leaves
                // no capture; a port taken there is never this, and fails the start
                return (await listen(([IPAddress.Loopback], port)), IPAddress.Loopback.ToString());
            }
            catch (Exception reason) when (binding.FindOpenPort && draw < MaximumDraws && IsInUse(reason))
            {
                // a port drawn on IPv4 that another socket holds on IPv6, or that another took
                // between the draw and the bind: drawn again
            }
        }
    }
}

/// <summary>Where a start on <c>localhost</c> binds, and the tests' ways into it.</summary>
internal sealed record LoopbackBinding
{
    /// <summary>The port it is given, when it draws none.</summary>
    public int Port { get; init; }

    /// <summary>Whether it draws a port free on the IPv4 loopback.</summary>
    public bool FindOpenPort { get; init; }

    /// <summary>What draws a port: the tests' way to draw one another socket holds on <c>::1</c>.</summary>
    public Func<int> DrawPort { get; init; } = Loopbacks.DrawPort;

    /// <summary>
    /// What refuses the IPv6 loopback's bind on a port, in place of the platform: the tests' way to
    /// start where it is absent. None, the platform binds it.
    /// </summary>
    public Func<int, Exception?>? IPv6Refusal { get; init; }
}
