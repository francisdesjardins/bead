using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Bead.Tests;

/// <summary>
/// <see cref="HappyEyeballs"/>: a connect by a name that races its addresses (RFC 8305), as Node's
/// clients do for the TypeScript side.
/// </summary>
public sealed class HappyEyeballsTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // an address of TEST-NET-1 (RFC 5737), which no host answers
    private static readonly IPAddress Unanswered = IPAddress.Parse("192.0.2.1");

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // helpers

    // a resolver that answers every name with the addresses given, in their order
    private static Func<string, CancellationToken, Task<IPAddress[]>> Answering(params IPAddress[] addresses)
    {
        return (_, _) =>
        {
            return Task.FromResult(addresses);
        };
    }

    // definition

    [Fact]
    public async Task Connects_by_the_next_family_250_ms_after_an_attempt_that_has_not_connected()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var clock = TimeProvider.System;
        var started = clock.GetTimestamp();
        var attempts = new ConcurrentQueue<(IPAddress Address, TimeSpan At)>();
        var connecting = HappyEyeballs.ConnectAsync(new DnsEndPoint("bead.test", port), new HappyEyeballsOptions
        {
            // TEST-NET-1 first, an IPv6 one as a resolver may answer, then the loopback: the
            // families interleaved, the first answer's first
            Resolve = Answering(Unanswered, IPAddress.Parse("192.0.2.2"), IPAddress.IPv6None, IPAddress.Loopback),
            Connect = async (endPoint, cancellationToken) =>
            {
                attempts.Enqueue((endPoint.Address, clock.GetElapsedTime(started)));

                if (!endPoint.Address.Equals(IPAddress.Loopback))
                {
                    // an attempt nothing answers, until it is given up
                    await Task.Delay(Timeout.InfiniteTimeSpan, clock, cancellationToken);
                }

                var socket = new Socket(endPoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp);

                await socket.ConnectAsync(endPoint, cancellationToken);

                return socket;
            },
            CancellationToken = Cancelled,
        });

        using var socket = await connecting.WaitAsync(Patience, Cancelled);
        var tried = attempts.ToList();

        Assert.Equal(IPAddress.Loopback, ((IPEndPoint)socket.RemoteEndPoint!).Address);
        Assert.Equal([Unanswered, IPAddress.IPv6None, IPAddress.Parse("192.0.2.2"), IPAddress.Loopback], tried.Select((attempt) =>
        {
            return attempt.Address;
        }));

        // each attempt 250 milliseconds after the one before it, which had not connected
        for (var index = 1; index < tried.Count; index += 1)
        {
            Assert.InRange(tried[index].At - tried[index - 1].At, TimeSpan.FromMilliseconds(240), TimeSpan.FromSeconds(2));
        }
    }

    [Fact]
    public async Task Cancels_the_attempts_left_once_one_connects()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var givenUp = new TaskCompletionSource<IPAddress>(TaskCreationOptions.RunContinuationsAsynchronously);
        var failed = new List<IPAddress>();
        var connecting = HappyEyeballs.ConnectAsync(new DnsEndPoint("bead.test", port), new HappyEyeballsOptions
        {
            Resolve = Answering(IPAddress.IPv6Loopback, Unanswered, IPAddress.Loopback),
            AttemptDelay = TimeSpan.FromMilliseconds(50),
            Connect = async (endPoint, cancellationToken) =>
            {
                if (endPoint.Address.Equals(IPAddress.IPv6Loopback))
                {
                    // a failure starts the next attempt at once
                    failed.Add(endPoint.Address);

                    throw new SocketException((int)SocketError.ConnectionRefused);
                }

                if (endPoint.Address.Equals(Unanswered))
                {
                    try
                    {
                        await Task.Delay(Timeout.InfiniteTimeSpan, TimeProvider.System, cancellationToken);
                    }
                    finally
                    {
                        givenUp.TrySetResult(endPoint.Address);
                    }
                }

                var socket = new Socket(endPoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp);

                await socket.ConnectAsync(endPoint, cancellationToken);

                return socket;
            },
            CancellationToken = Cancelled,
        });

        using var socket = await connecting.WaitAsync(Patience, Cancelled);

        Assert.Equal(IPAddress.Loopback, ((IPEndPoint)socket.RemoteEndPoint!).Address);
        Assert.Equal([IPAddress.IPv6Loopback], failed);
        Assert.Equal(Unanswered, await givenUp.Task.WaitAsync(Patience, Cancelled));

        // every attempt failed: the last failure; a name that resolves to none: host not found
        var refused = await Assert.ThrowsAsync<SocketException>(() =>
        {
            return HappyEyeballs.ConnectAsync(new DnsEndPoint("bead.test", port), new HappyEyeballsOptions
            {
                Resolve = Answering(IPAddress.IPv6Loopback),
                Connect = (_, _) =>
                {
                    return Task.FromException<Socket>(new SocketException((int)SocketError.ConnectionRefused));
                },
                CancellationToken = Cancelled,
            });
        });
        var unknown = await Assert.ThrowsAsync<SocketException>(() =>
        {
            return HappyEyeballs.ConnectAsync(new DnsEndPoint("bead.test", port), new HappyEyeballsOptions { Resolve = Answering(), CancellationToken = Cancelled });
        });

        Assert.Equal((SocketError.ConnectionRefused, SocketError.HostNotFound), (refused.SocketErrorCode, unknown.SocketErrorCode));
    }
}
