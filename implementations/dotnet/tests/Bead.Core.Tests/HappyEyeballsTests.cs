using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="HappyEyeballs"/>: a connect by a name that races its addresses (RFC 8305), as the
/// TypeScript side's own race does.
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

    // waits until `condition` holds, within its patience
    private static async Task Until(Func<bool> condition)
    {
        var since = TimeProvider.System.GetTimestamp();

        while (!condition())
        {
            Assert.True(TimeProvider.System.GetElapsedTime(since) < Patience, "it never held");
            await Task.Delay(10, Cancelled);
        }
    }

    // a resolver that answers every name with the addresses given, and records each name it is asked
    private static Func<string, CancellationToken, Task<IPAddress[]>> Recording(ConcurrentQueue<string> asked, params IPAddress[] addresses)
    {
        return (name, _) =>
        {
            asked.Enqueue(name);

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

    // spec 13.4.2; RFC 8305 §5
    [Fact]
    public async Task Keeps_an_attempt_that_has_not_connected_by_its_delay_while_the_next_one_starts_the_first_to_connect_winning_and_the_other_closed()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var clock = new FakeTimeProvider();
        var tokens = new ConcurrentDictionary<IPAddress, CancellationToken>();
        var released = new ConcurrentDictionary<IPAddress, TaskCompletionSource>();
        var late = new TaskCompletionSource<Socket>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        foreach (var address in new[] { IPAddress.Loopback, IPAddress.IPv6Loopback })
        {
            released[address] = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        var connecting = HappyEyeballs.ConnectAsync(new DnsEndPoint("bead-probe.localhost", port), new HappyEyeballsOptions
        {
            Clock = clock,
            Connect = async (endPoint, cancellationToken) =>
            {
                tokens[endPoint.Address] = cancellationToken;

                if (endPoint.Address.Equals(IPAddress.IPv6Loopback))
                {
                    second.TrySetResult();
                }

                // * each attempt held back until released, whatever the race asks of it: an attempt
                // that connects late, as a slow accept does
                await released[endPoint.Address].Task;

                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

                await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), Cancelled);

                if (endPoint.Address.Equals(IPAddress.IPv6Loopback))
                {
                    late.TrySetResult(socket);
                }

                return socket;
            },
            CancellationToken = Cancelled,
        });

        // the next attempt starts at the delay, and the first is kept, never given up
        clock.Advance(TimeSpan.FromMilliseconds(250));
        await second.Task.WaitAsync(Patience, Cancelled);

        Assert.False(tokens[IPAddress.Loopback].IsCancellationRequested);
        Assert.False(connecting.IsCompleted);

        // * the first attempt connects first, and wins
        released[IPAddress.Loopback].TrySetResult();

        using var socket = await connecting.WaitAsync(Patience, Cancelled);

        Assert.True(socket.Connected);
        Assert.True(tokens[IPAddress.IPv6Loopback].IsCancellationRequested);

        // the other connects after it, and is closed
        released[IPAddress.IPv6Loopback].TrySetResult();

        var other = await late.Task.WaitAsync(Patience, Cancelled);

        await Until(() =>
        {
            return other.SafeHandle.IsClosed;
        });
    }

    // spec 13.4.2
    [Fact]
    public async Task Ends_every_attempt_leaving_no_socket_once_its_connect_is_given_up()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        // given up before it began: no connection made, and no socket stays
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return HappyEyeballs.ConnectAsync(new DnsEndPoint("bead-probe.localhost", port), new HappyEyeballsOptions
            {
                CancellationToken = new CancellationToken(canceled: true),
            }).WaitAsync(Patience, Cancelled);
        });
        Assert.False(listener.Pending());

        var clock = new FakeTimeProvider();
        var givenUp = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var late = new TaskCompletionSource<Socket>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var giving = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var connecting = HappyEyeballs.ConnectAsync(new DnsEndPoint("bead-probe.localhost", port), new HappyEyeballsOptions
        {
            Clock = clock,
            Connect = async (endPoint, cancellationToken) =>
            {
                if (endPoint.Address.Equals(IPAddress.Loopback))
                {
                    // an attempt nothing answers, given up with its connect
                    try
                    {
                        await Task.Delay(Timeout.InfiniteTimeSpan, TimeProvider.System, cancellationToken);
                    }
                    finally
                    {
                        givenUp.TrySetResult();
                    }
                }

                second.TrySetResult();

                // * one that connects after its connect was given up, as a late accept does
                await release.Task;

                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);

                await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), Cancelled);
                late.TrySetResult(socket);

                return socket;
            },
            CancellationToken = giving.Token,
        });

        clock.Advance(TimeSpan.FromMilliseconds(250));
        await second.Task.WaitAsync(Patience, Cancelled);

        // * its connect given up, by its timeout or its cancellation: every attempt ends
        await giving.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });
        await givenUp.Task.WaitAsync(Patience, Cancelled);

        // and the one that connects after is closed: no socket stays
        release.TrySetResult();

        var other = await late.Task.WaitAsync(Patience, Cancelled);

        await Until(() =>
        {
            return other.SafeHandle.IsClosed;
        });
    }

    // spec 13.4.2
    [Fact]
    public async Task Connects_a_localhost_name_to_the_loopback_asking_its_resolver_nothing()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var asked = new ConcurrentQueue<string>();

        foreach (var name in new[] { "localhost", "bead-probe.localhost", "BEAD-PROBE.LocalHost" })
        {
            using var socket = await HappyEyeballs.ConnectAsync(new DnsEndPoint(name, port), new HappyEyeballsOptions
            {
                Resolve = Recording(asked, IPAddress.Parse("192.0.2.7")),
                CancellationToken = Cancelled,
            }).WaitAsync(Patience, Cancelled);
            using var accepted = await listener.AcceptSocketAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);

            Assert.Equal((name, IPAddress.Loopback), (name, ((IPEndPoint)socket.RemoteEndPoint!).Address));
        }

        Assert.Empty(asked);
    }

    // spec 13.4.2
    [Fact]
    public async Task Tries_the_IPv4_loopback_first_for_a_localhost_name_then_the_IPv6_one_an_attempt_delay_after()
    {
        var clock = new FakeTimeProvider();
        var started = clock.GetUtcNow();
        var attempts = new ConcurrentQueue<(IPAddress Address, TimeSpan At)>();
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var connecting = HappyEyeballs.ConnectAsync(new DnsEndPoint("bead-probe.localhost", 9), new HappyEyeballsOptions
        {
            Resolve = Recording(new ConcurrentQueue<string>(), Unanswered),
            Clock = clock,
            Connect = async (endPoint, cancellationToken) =>
            {
                attempts.Enqueue((endPoint.Address, clock.GetUtcNow() - started));

                if (attempts.Count == 2)
                {
                    second.TrySetResult();
                }

                // an attempt nothing answers, until it is given up
                await Task.Delay(Timeout.InfiniteTimeSpan, TimeProvider.System, cancellationToken);

                throw new InvalidOperationException("never reached");
            },
            CancellationToken = cancelling.Token,
        });

        Assert.Equal([IPAddress.Loopback], attempts.Select((attempt) =>
        {
            return attempt.Address;
        }));

        // the next family once the attempt delay has passed, not before
        clock.Advance(TimeSpan.FromMilliseconds(249));
        await Task.Delay(TimeSpan.FromMilliseconds(50), Cancelled);
        Assert.Single(attempts);
        clock.Advance(TimeSpan.FromMilliseconds(1));
        await second.Task.WaitAsync(Patience, Cancelled);

        Assert.Equal([(IPAddress.Loopback, TimeSpan.Zero), (IPAddress.IPv6Loopback, TimeSpan.FromMilliseconds(250))], attempts);

        await cancelling.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });
    }

    // spec 13.4.2
    [Fact]
    public async Task Asks_its_resolver_for_any_other_name_localhost_with_a_trailing_dot_among_them()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var asked = new ConcurrentQueue<string>();
        string[] names = ["localhost.", "bead-probe.localhost.", "localhost.example", "bead.test"];

        foreach (var name in names)
        {
            using var socket = await HappyEyeballs.ConnectAsync(new DnsEndPoint(name, port), new HappyEyeballsOptions
            {
                Resolve = Recording(asked, IPAddress.Loopback),
                CancellationToken = Cancelled,
            }).WaitAsync(Patience, Cancelled);
            using var accepted = await listener.AcceptSocketAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        }

        Assert.Equal(names, asked);
    }

    // spec 13.4.2
    [Fact]
    public async Task Says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked()
    {
        var asked = new ConcurrentQueue<string>();
        var tried = new ConcurrentQueue<IPAddress>();
        var refused = await Assert.ThrowsAsync<SocketException>(() =>
        {
            return HappyEyeballs.ConnectAsync(new DnsEndPoint("bead-probe.localhost", 9), new HappyEyeballsOptions
            {
                Resolve = Recording(asked, Unanswered),
                Connect = (endPoint, _) =>
                {
                    tried.Enqueue(endPoint.Address);

                    return Task.FromException<Socket>(new SocketException((int)SocketError.ConnectionRefused));
                },
                CancellationToken = Cancelled,
            });
        });

        // * the platform's cause kept, its code and its words, beside the sentence
        Assert.Equal(SocketError.ConnectionRefused, refused.SocketErrorCode);
        Assert.Equal($"{new SocketException((int)SocketError.ConnectionRefused).Message}; bead-probe.localhost names the loopback: connected to 127.0.0.1 and ::1, no resolver asked", refused.Message);
        Assert.Equal([IPAddress.Loopback, IPAddress.IPv6Loopback], tried);
        Assert.Empty(asked);
    }
}
