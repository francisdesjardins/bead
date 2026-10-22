namespace Bead.Tests;

/// <summary>
/// <see cref="ReadyState"/>: the states of a transport's end, numbered as the TypeScript side's
/// twin numbers them, the WebSocket's own first.
/// </summary>
public sealed class ReadyStateTests
{
    // definition

    [Fact]
    public void Keeps_the_WebSocket_numbering_for_CONNECTING_to_CLOSED()
    {
        Assert.Equal(
            [
                ("Connecting", 0),
                ("Open", 1),
                ("Closing", 2),
                ("Closed", 3),
                ("Uninitialized", 4),
                ("Reconnecting", 5),
            ],
            Enum.GetValues<ReadyState>().Select((state) =>
            {
                return (state.ToString(), (int)state);
            }));
    }
}
