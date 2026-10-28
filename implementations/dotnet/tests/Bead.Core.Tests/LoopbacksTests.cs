using System.Net;
using System.Net.Sockets;

namespace Bead.Tests;

/// <summary>The loopback binder, through its supplied bind and platform refusal seams.</summary>
public sealed class LoopbacksTests
{
    [Fact]
    public async Task Draws_another_port_for_an_occupied_loopback_in_the_platform_bind_failure()
    {
        var reason = new AggregateException(new InvalidOperationException("another listener"), new IOException("bind", new SocketException((int)SocketError.AddressAlreadyInUse)));
        var draws = 0;
        var calls = new List<(IReadOnlyList<IPAddress> Addresses, int Port)>();
        var bound = new object();
        var result = await Loopbacks.Bind((listen) =>
        {
            calls.Add(listen);
            return Task.FromResult(bound);
        }, new LoopbackBinding
        {
            FindOpenPort = true,
            DrawPort = () =>
            {
                return 42000 + draws++;
            },
            IPv6Refusal = (port) =>
            {
                return port == 42000 ? reason : null;
            },
        });

        Assert.Equal(2, draws);
        Assert.Same(bound, result.Started);
        Assert.Equal("localhost", result.Address);
        var call = Assert.Single(calls);
        Assert.Equal(42001, call.Port);
        Assert.Equal([IPAddress.Loopback, IPAddress.IPv6Loopback], call.Addresses);
    }

    [Fact]
    public async Task Falls_back_to_IPv4_only_for_an_absent_loopback_in_the_platform_bind_failure()
    {
        foreach (var code in new[] { SocketError.AddressNotAvailable, SocketError.AddressFamilyNotSupported })
        {
            // * .NET hosts wrap socket failures; Node reports the socket's code on its error
            foreach (var reason in new Exception[]
            {
                new SocketException((int)code),
                new IOException("bind", new SocketException((int)code)),
                new AggregateException(new InvalidOperationException("another listener"), new IOException("bind", new AggregateException(new SocketException((int)code)))),
            })
            {
                var draws = 0;
                var calls = new List<(IReadOnlyList<IPAddress> Addresses, int Port)>();
                var bound = new object();
                var result = await Loopbacks.Bind((listen) =>
                {
                    calls.Add(listen);
                    return Task.FromResult(bound);
                }, new LoopbackBinding
                {
                    FindOpenPort = true,
                    DrawPort = () =>
                    {
                        draws++;
                        return 42000;
                    },
                    IPv6Refusal = (_) =>
                    {
                        return reason;
                    },
                });

                Assert.Equal(1, draws);
                Assert.Same(bound, result.Started);
                Assert.Equal("127.0.0.1", result.Address);
                var call = Assert.Single(calls);
                Assert.Equal(42000, call.Port);
                Assert.Equal([IPAddress.Loopback], call.Addresses);
            }
        }
    }

    [Fact]
    public async Task Propagates_a_bind_failure_whose_platform_errors_name_no_absent_loopback_or_occupied_port()
    {
        var reason = new AggregateException(new InvalidOperationException("another listener"), new IOException("bind", new SocketException((int)SocketError.AccessDenied)));
        var draws = 0;
        var calls = 0;
        var thrown = await Assert.ThrowsAsync<AggregateException>(() =>
        {
            return Loopbacks.Bind((_) =>
            {
                calls++;
                return Task.FromResult(new object());
            }, new LoopbackBinding
            {
                FindOpenPort = true,
                DrawPort = () =>
                {
                    draws++;
                    return 42000;
                },
                IPv6Refusal = (_) =>
                {
                    return reason;
                },
            });
        });

        Assert.Same(reason, thrown);
        Assert.Equal(1, draws);
        Assert.Equal(0, calls);
    }
}
