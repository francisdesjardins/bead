namespace Bead.Tests;

/// <summary>
/// <see cref="IntakeLimits"/>: what a router holds of each connection that no turn of it took yet
/// (spec 15.12, decision 0046), a side's own, its defaults fixed, each bound 1 at least.
/// </summary>
public sealed class IntakeLimitsTests
{
    // a transport that hands nothing on, which a router is built over
    private sealed class Silent : IRouterServerTransport, IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<string>? Connection
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<TransportMessage, string>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, string>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        event Action<TransportMessage>? IRouterClientTransport.Message
        {
            add
            {
            }

            remove
            {
            }
        }

        event Action<bool, bool>? IRouterClientTransport.Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }

        public Task Send(TransportMessage message)
        {
            return Task.CompletedTask;
        }

        public void Pause(string connectionHandle)
        {
        }

        public void Resume(string connectionHandle)
        {
        }

        public void Pause()
        {
        }

        public void Resume()
        {
        }
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public void The_intake_limits_refuse_a_bound_below_1_and_default_to_64_and_1_MiB()
    {
        Assert.Equal(new IntakeLimits { MaximumUntakenEnvelopes = 64, MaximumUntakenBytes = 1_048_576 }, IntakeLimits.Default);
        Assert.Equal(IntakeLimits.Default, new IntakeLimits().Validate());
        Assert.Equal(
            new IntakeLimits { MaximumUntakenEnvelopes = 1, MaximumUntakenBytes = 1_048_576 },
            new IntakeLimits { MaximumUntakenEnvelopes = 1 }.Validate());

        foreach (var value in new[] { 0, -1, int.MinValue })
        {
            Assert.Equal(
                $"MaximumUntakenEnvelopes is a whole number above 0, not {value}",
                Assert.Throws<ArgumentException>(() =>
                {
                    return new IntakeLimits { MaximumUntakenEnvelopes = value }.Validate();
                }).Message);
            Assert.Equal(
                $"MaximumUntakenBytes is a whole number above 0, not {value}",
                Assert.Throws<ArgumentException>(() =>
                {
                    return new IntakeLimits { MaximumUntakenBytes = value }.Validate();
                }).Message);
        }

        // * refused as a router is built, a server's and a client's alike
        var silent = new Silent();

        Assert.Throws<ArgumentException>(() =>
        {
            return new RouterServer(silent, new RouterServerOptions { Intake = new IntakeLimits { MaximumUntakenBytes = 0 } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new RouterClient(silent, new RouterClientOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 0 } });
        });
    }
}
