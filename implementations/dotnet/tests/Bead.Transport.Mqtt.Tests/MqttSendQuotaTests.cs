namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The send quota on its own (spec 15.28): what no link reaches through the adapter, which refuses
/// what is asked of a link ended or under a token cancelled already before its quota hears of it — a
/// cancel that comes once a publication went, an end told twice. The TypeScript side keeps its quota
/// inside its adapter, whose tests play the rest of it, as the adapter's tests here do.
/// </summary>
public sealed class MqttSendQuotaTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    // definition

    [Fact]
    public async Task Sends_at_once_within_its_room_holds_the_rest_in_their_order_and_keeps_one_sent_as_it_freed_whatever_its_token_says_after()
    {
        var quota = new MqttSendQuota(1);
        var sent = new List<int>();
        using var leaving = new CancellationTokenSource();
        var first = quota.Enqueue((
            () =>
            {
                sent.Add(1);
            },
            CancellationToken.None));
        var second = quota.Enqueue((
            () =>
            {
                sent.Add(2);
            },
            leaving.Token));

        Assert.True(first.IsCompletedSuccessfully);
        Assert.Equal([1], sent);
        Assert.Equal((1, 1), (quota.InFlight, quota.Queued));

        // * sent as a PUBACK freed its room: a cancel after it takes nothing back
        quota.Release();
        await leaving.CancelAsync();
        await second.WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([1, 2], sent);
        Assert.Equal((1, 0), (quota.InFlight, quota.Queued));
    }

    [Fact]
    public async Task Fails_at_once_what_is_asked_once_it_ended_or_under_a_token_cancelled_already_sending_nothing_and_ends_once()
    {
        var quota = new MqttSendQuota(1);
        var sent = 0;

        void Send()
        {
            sent += 1;
        }

        Assert.True(quota.Enqueue((Send, new CancellationToken(true))).IsCanceled);
        await quota.Enqueue((Send, CancellationToken.None));

        var waiting = quota.Enqueue((Send, CancellationToken.None));
        var lost = new IOException("the link of ada was lost");

        quota.End(lost);
        quota.End(new IOException("the link of ada stopped"));
        Assert.Same(lost, await Assert.ThrowsAsync<IOException>(() =>
        {
            return waiting;
        }));
        Assert.Same(lost, await Assert.ThrowsAsync<IOException>(() =>
        {
            return quota.Enqueue((Send, CancellationToken.None));
        }));

        // nothing goes once it ended, whatever frees its room
        quota.Release();
        Assert.Equal((1, 0), (sent, quota.Queued));
    }
}
