using Bead.Transport.Amqp;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The places of AMQP 1.0's adapter (spec 15.33, 15.37): its idle-time-out, held up to 1,073,741,823
/// ms, its library counting its link lost by twice it, and its start's wait for its broker's OPEN,
/// its sessions and its inbox, each taken or refused as it is built, never without end.
/// </summary>
public sealed partial class DurationsTests
{
    // an AMQP 1.0 adapter to a broker it never links to, built with the options given
    private static Observed AmqpAdapterOf(Func<AmqpBrokerAdapterOptions, AmqpBrokerAdapterOptions> given)
    {
        try
        {
            _ = new AmqpBrokerAdapter(given(new AmqpBrokerAdapterOptions { Id = "ada", Uri = new Uri("amqp://127.0.0.1:5672") }));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        return Taken();
    }

    // amqpBrokerAdapter.idleTimeout

    // the adapter's options, as it is built: taken or refused
    private static Task<Observed> IdleTimeoutByOptions(TimeSpan? given)
    {
        return Task.FromResult(AmqpAdapterOf((options) =>
        {
            return options with { IdleTimeout = Assert.NotNull(given) };
        }));
    }

    // amqpBrokerAdapter.connectTimeout

    // the adapter's options, as it is built: taken or refused
    private static Task<Observed> AmqpConnectTimeoutByOptions(TimeSpan? given)
    {
        return Task.FromResult(AmqpAdapterOf((options) =>
        {
            return options with { ConnectTimeout = Assert.NotNull(given) };
        }));
    }
}
