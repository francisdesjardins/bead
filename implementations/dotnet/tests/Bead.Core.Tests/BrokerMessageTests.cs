namespace Bead.Tests;

/// <summary>A message an adapter hands its participant (spec 15.19): its acknowledgement, given once.</summary>
public sealed class BrokerMessageTests
{
    private static readonly BrokerPublication Publication = new() { Topic = ["bead", "i", "ada"], Payload = (byte[])[0xB1] };

    [Fact]
    public void Acknowledges_its_broker_once_and_nothing_when_built_without_a_settle()
    {
        var settled = 0;
        var counted = new BrokerMessage(Publication, new BrokerMessageOptions
        {
            IsRetained = true,
            Settle = () =>
            {
                settled += 1;
            },
        });

        // * a second settle does nothing
        counted.Settle();
        counted.Settle();
        Assert.Equal((1, true), (settled, counted.IsRetained));

        // none given, as at most once: acknowledged to nothing, and not retained
        foreach (var bare in new[] { new BrokerMessage(Publication), new BrokerMessage(Publication, new BrokerMessageOptions()) })
        {
            bare.Settle();
            Assert.Equal((false, (byte)0xB1), (bare.IsRetained, bare.Payload.Span[0]));
        }
    }
}
