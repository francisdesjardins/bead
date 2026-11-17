namespace Bead.Transport.Amqp.Tests;

/// <summary>The classes that play against the run's broker, one at a time.</summary>
[CollectionDefinition(AmqpFixture.Collection, DisableParallelization = true)]
public sealed class AmqpBrokerRun
{
}
