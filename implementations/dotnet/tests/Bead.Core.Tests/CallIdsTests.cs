namespace Bead.Tests;

/// <summary>
/// <see cref="CallIds"/> and <see cref="CallIdSequence"/>: which side a call id is, and how a side
/// draws its own. A side draws from its first, two apart, where the TypeScript side's sequence takes
/// any first and step: each test below walks a side's own range.
/// </summary>
public sealed class CallIdsTests
{
    // helpers

    private static bool Free(uint callId)
    {
        return false;
    }

    // definition

    [Fact]
    public void Walks_its_range_by_two_then_from_its_first_again()
    {
        var sequence = new CallIdSequence(RouterSide.Client, 7);

        Assert.Equal([1u, 3u, 5u, 7u, 1u], new[] { sequence.Draw(Free), sequence.Draw(Free), sequence.Draw(Free), sequence.Draw(Free), sequence.Draw(Free) });
    }

    [Fact]
    public void Skips_the_ids_in_use_and_gives_none_once_every_one_is()
    {
        var sequence = new CallIdSequence(RouterSide.Server, 8);
        var used = new HashSet<uint> { 2, 6 };

        Assert.Equal([4u, 8u, 4u], new[] { sequence.Draw(used.Contains), sequence.Draw(used.Contains), sequence.Draw(used.Contains) });
        used.Add(4);
        used.Add(8);
        Assert.Null(sequence.Draw(used.Contains));

        // ids outside the range, however many, stop nothing: every id but 5 is in use here
        Assert.Equal(5u, new CallIdSequence(RouterSide.Client, 7).Draw((callId) =>
        {
            return callId is not 5;
        }));
    }

    [Fact]
    public void Asks_about_each_id_once_at_most_however_many_are_in_use()
    {
        var sequence = new CallIdSequence(RouterSide.Client, 9);
        var asked = new List<uint>();

        Assert.Null(sequence.Draw((callId) =>
        {
            asked.Add(callId);

            return true;
        }));
        Assert.Equal([1u, 3u, 5u, 7u, 9u], asked);
    }

    [Fact]
    public void Draws_a_side_s_own_range_by_default_to_its_last_unsigned()
    {
        Assert.Equal((1u, uint.MaxValue), (CallIds.FirstOf(RouterSide.Client), CallIds.LastOf(RouterSide.Client)));
        Assert.Equal((2u, uint.MaxValue - 1), (CallIds.FirstOf(RouterSide.Server), CallIds.LastOf(RouterSide.Server)));
        Assert.Equal(1u, new CallIdSequence(RouterSide.Client, null).Draw(Free));
        Assert.Equal(2u, new CallIdSequence(RouterSide.Server, null).Draw(Free));
    }

    [Theory]
    [InlineData(RouterSide.Client, 4u)]
    [InlineData(RouterSide.Client, 0u)]
    [InlineData(RouterSide.Server, 3u)]
    [InlineData(RouterSide.Server, 0u)]
    public void Refuses_a_last_call_id_of_the_other_parity_or_before_its_first(RouterSide side, uint last)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new CallIdSequence(side, last);
        });
    }

    [Fact]
    public void Is_the_client_for_an_odd_call_id_and_the_server_for_an_even_one()
    {
        Assert.All([1u, 3u, (1u << 31) + 1, uint.MaxValue], (callId) =>
        {
            Assert.Equal(RouterSide.Client, CallIds.SideOf(callId));
        });
        Assert.All([2u, 1u << 31, uint.MaxValue - 1], (callId) =>
        {
            Assert.Equal(RouterSide.Server, CallIds.SideOf(callId));
        });
    }

    [Fact]
    public void Is_no_side_for_0_which_is_no_call_id()
    {
        Assert.Null(CallIds.SideOf(0));
    }
}
