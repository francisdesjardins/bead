namespace Bead.Tests;

/// <summary><see cref="SendingTransfers"/>: the chunks each credit lets go, on the call it names.</summary>
public sealed class SendingTransfersTests
{
    // constants

    private static readonly CallAddress First = new(1, "a");
    private static readonly CallAddress Other = new(3, "a");

    // helpers

    // a transfer of 200 bytes opened on a call — its opening 40 of them, each chunk 48 — which
    // records the offset of each chunk it sends, and each credit it hears; `onSend` runs as a chunk goes
    private static (List<long> Credits, List<long> Offsets, Sending Sending) OpenOn(
        SendingTransfers sendings,
        (CallAddress Call, Action<Chunk>? OnSend) opened)
    {
        var credits = new List<long>();
        var offsets = new List<long>();
        var outgoing = new OutgoingTransfer(new byte[200], (40, 48));

        void Credited()
        {
            credits.Add(outgoing.CreditEnd);
        }

        void Send(Chunk chunk)
        {
            offsets.Add(chunk.Offset);
            opened.OnSend?.Invoke(chunk);
        }

        return (credits, offsets, sendings.Open(outgoing, (opened.Call, Credited, Send)));
    }

    // definition

    [Fact]
    public void Sends_nothing_before_a_credit_then_the_chunks_each_one_lets_go_to_its_total()
    {
        var sendings = new SendingTransfers();
        var (credits, offsets, _) = OpenOn(sendings, (First, null));

        Assert.Empty(offsets);
        sendings.Credit(First, 168);
        Assert.Equal([40, 88], offsets);
        sendings.Credit(First, 200);

        // past its total, a credit grants nothing more
        sendings.Credit(First, 400);
        Assert.Equal([40, 88, 136, 184], offsets);
        Assert.Equal([168, 200], credits);
    }

    [Fact]
    public void Drops_a_credit_that_grants_nothing_and_one_that_comes_for_no_transfer()
    {
        var sendings = new SendingTransfers();
        var (credits, offsets, _) = OpenOn(sendings, (First, null));

        sendings.Credit(First, 100);

        // lower, and the same again
        sendings.Credit(First, 90);
        sendings.Credit(First, 100);

        // another call on its connection, and another connection
        sendings.Credit(Other, 200);
        sendings.Credit(new CallAddress(1, "b"), 200);
        Assert.Equal([40], offsets);
        Assert.Equal([100], credits);
    }

    [Fact]
    public void Takes_a_credit_that_comes_as_its_chunks_go_out_as_a_raise_alone_which_they_take_on()
    {
        var sendings = new SendingTransfers();
        var depth = 0;
        var deepest = 0;

        // a transport that credits a chunk more before each chunk's send returns
        void Crediting(Chunk chunk)
        {
            depth += 1;
            deepest = Math.Max(deepest, depth);
            sendings.Credit(First, chunk.Offset + 96);
            depth -= 1;
        }

        var (credits, offsets, _) = OpenOn(sendings, (First, Crediting));

        sendings.Credit(First, 88);

        // each chunk once, in order, and none sent inside another's send
        Assert.Equal([40, 88, 136, 184], offsets);
        Assert.Equal([88, 136, 184, 200], credits);
        Assert.Equal(1, deepest);
    }

    [Fact]
    public void Sends_nothing_more_of_a_transfer_once_ended_even_as_a_credit_s_chunks_go_out()
    {
        var sendings = new SendingTransfers();
        Sending? ended = null;

        // ended as its first chunk goes, by what that chunk's send brings back
        void Ending(Chunk chunk)
        {
            sendings.Close(ended!);
        }

        var (_, endedOffsets, endedSending) = OpenOn(sendings, (First, Ending));

        ended = endedSending;

        var (_, keptOffsets, kept) = OpenOn(sendings, (Other, null));

        sendings.Credit(First, 200);
        Assert.Equal([40], endedOffsets);

        // ended already, with a transfer left on its connection, then none
        sendings.Close(ended);
        sendings.Credit(Other, 200);
        sendings.Close(kept);
        sendings.Close(kept);
        Assert.Equal([40, 88, 136, 184], keptOffsets);
    }

    [Fact]
    public void Closes_no_transfer_but_its_own_not_one_opened_on_its_call_since()
    {
        var sendings = new SendingTransfers();
        var before = OpenOn(sendings, (First, null));
        var after = OpenOn(sendings, (First, null));

        // the one before ends late, once another took its call
        sendings.Close(before.Sending);
        sendings.Credit(First, 88);
        Assert.Empty(before.Offsets);
        Assert.Equal([40], after.Offsets);
    }

    [Fact]
    public void Counts_the_transfers_sent_and_the_connections_they_go_to()
    {
        var sendings = new SendingTransfers();
        var (_, _, sending) = OpenOn(sendings, (First, null));

        OpenOn(sendings, (Other, null));
        Assert.Equal(["a"], sendings.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["sendingTransfers"] = 2 }, sendings.Gauges().Counts);
        sendings.Close(sending);
        Assert.Equal(new Dictionary<string, long> { ["sendingTransfers"] = 1 }, sendings.Gauges().Counts);
    }
}
