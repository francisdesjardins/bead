using Amqp;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// The RabbitMQ 4.4.0 of the run's own that <c>tools/amqp-broker.mjs</c> starts, as its variables
/// name it (spec 15.38): what every test that needs a broker plays against, skipped, saying so,
/// where none is given — unless <c>BEAD_AMQP_REQUIRED=1</c> asks for one, and then it fails, saying
/// so, as <c>BEAD_INTEROP_REQUIRED=1</c> fails the interop. Its own user, <c>fixture</c>, reads what
/// a queue holds, its listing and its purge, through the broker's management, and configures and
/// writes nothing. The TypeScript side reads the same variables.
/// </summary>
internal static class AmqpFixture
{
    /// <summary>What a test that needs a broker says as it is skipped.</summary>
    public const string Reason = "no broker: BEAD_AMQP_URL is not set (node tools/amqp-broker.mjs start)";

    /// <summary>
    /// The collection of every class that plays against the broker, so that none plays beside
    /// another: the cases' users are the adapter's tests' too, and an inbox is its id's alone.
    /// </summary>
    public const string Collection = "the RabbitMQ of the run";

    // the user the fixture reads queues as, which no case and no interop leg is
    private const string FixtureUser = "fixture";

    /// <summary>Whether a broker is given, or asked for, so that its tests run, and fail where none is.</summary>
    public static bool IsGiven
    {
        get
        {
            return Environment.GetEnvironmentVariable("BEAD_AMQP_URL") is { Length: > 0 } || Environment.GetEnvironmentVariable("BEAD_AMQP_REQUIRED") == "1";
        }
    }

    /// <summary>Its AMQP 1.0 listener, over TCP.</summary>
    public static Uri Url
    {
        get
        {
            return new Uri(Required("BEAD_AMQP_URL"));
        }
    }

    /// <summary>The password drawn for the run, every user's.</summary>
    public static string Password
    {
        get
        {
            return Required("BEAD_AMQP_PASSWORD");
        }
    }

    /// <summary>
    /// Runs <paramref name="asked"/> on the broker's management, on a connection of the fixture's
    /// own user, closed once it ends.
    /// </summary>
    public static async Task<T> Managed<T>(Func<AmqpManagement, Task<T>> asked)
    {
        ArgumentNullException.ThrowIfNull(asked);

        var url = Url;
        var connection = await new ConnectionFactory().CreateAsync(new Address(url.Host, url.Port, FixtureUser, Password, "/", "AMQP"));

        try
        {
            var management = await AmqpManagement.Open(connection, TestContext.Current.CancellationToken);

            try
            {
                return await asked(management);
            }
            finally
            {
                await management.Close(TimeSpan.FromSeconds(5));
            }
        }
        finally
        {
            await AmqpEndpoints.Ending(connection, TimeSpan.FromSeconds(5));
        }
    }

    /// <summary>The status the broker's management gives of a queue: 200 while it is, 404 once it is not.</summary>
    public static Task<string> QueueStatusOf(string queue)
    {
        return Managed(async (management) =>
        {
            return (await management.Request(("GET", $"/queues/{Uri.EscapeDataString(queue)}"), null, TestContext.Current.CancellationToken)).Status;
        });
    }

    /// <summary>Waits, within <c>Within</c>, until no queue of <c>Queues</c> is: each an inbox whose connection its broker ends.</summary>
    public static async Task Gone((IReadOnlyList<string> Queues, TimeSpan Within) waited)
    {
        var (queues, within) = waited;
        var deadline = TimeProvider.System.GetUtcNow() + within;

        foreach (var queue in queues)
        {
            while (await QueueStatusOf(queue) == "200")
            {
                if (TimeProvider.System.GetUtcNow() > deadline)
                {
                    throw new TimeoutException($"the queue {queue} was still there after {within.TotalSeconds} s");
                }

                await Task.Delay(50, TestContext.Current.CancellationToken);
            }
        }
    }

    /// <summary>Empties the queue <paramref name="queue"/> of what an earlier test left in it.</summary>
    public static Task Purge(string queue)
    {
        return Managed(async (management) =>
        {
            var purged = await management.Request(("DELETE", $"/queues/{Uri.EscapeDataString(queue)}/messages"), null, TestContext.Current.CancellationToken);

            return purged.Status == "200" ? true : throw new IOException($"the fixture could not purge {queue}: {purged.Said}");
        });
    }

    // a variable the run gives, or a failure naming it where BEAD_AMQP_REQUIRED=1 asked for a broker
    private static string Required(string name)
    {
        return Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"BEAD_AMQP_REQUIRED=1 asks for a broker, and {name} is not set (node tools/amqp-broker.mjs start)");
    }
}

/// <summary>The classes that play against the run's broker, one at a time.</summary>
[CollectionDefinition(AmqpFixture.Collection, DisableParallelization = true)]
public sealed class AmqpBrokerRun
{
}
