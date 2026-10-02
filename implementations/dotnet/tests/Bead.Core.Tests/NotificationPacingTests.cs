using System.Text;

namespace Bead.Tests;

/// <summary>
/// <see cref="PacingLimits"/> and <see cref="NotificationPacing"/>: what a paced subscription queues
/// at most, and how its credit lets go, in order, what it queued.
/// </summary>
public sealed class NotificationPacingTests
{
    // constants

    private static readonly PacingLimits Limits = new() { MaximumQueuedNotificationBytes = 1_024, MaximumQueuedNotifications = 8 };

    // helpers

    // a payload that reads as `word`
    private static ReadOnlyMemory<byte> PayloadOf(string word)
    {
        return Encoding.UTF8.GetBytes(word);
    }

    // what payloads read as
    private static List<string> WordsOf(List<ReadOnlyMemory<byte>> payloads)
    {
        return [.. payloads.Select((payload) =>
        {
            return Encoding.UTF8.GetString(payload.Span);
        })];
    }

    // definition

    [Fact]
    public void Queue_64_notifications_and_1_MiB_at_most_by_default()
    {
        Assert.Equal(new PacingLimits { MaximumQueuedNotificationBytes = 1_048_576, MaximumQueuedNotifications = 64 }, PacingLimits.Default);
        Assert.Equal(PacingLimits.Default, new PacingLimits().Validate());

        // past its first credit, a pacing at the defaults queues 64 and no more
        var pacing = new NotificationPacing(PacingLimits.Default);

        Assert.Equal(PacingOutcome.Send, pacing.Offer(PayloadOf("sent"), null));

        for (var queued = 0; queued < 64; queued++)
        {
            Assert.Equal(PacingOutcome.Queued, pacing.Offer(new byte[1], null));
        }

        Assert.Equal(PacingOutcome.Exceeded, pacing.Offer(new byte[1], null));
    }

    [Fact]
    public void Take_each_limit_given_over_the_default_one_left_out_keeping_it()
    {
        Assert.Equal(
            new PacingLimits { MaximumQueuedNotificationBytes = 1_048_576, MaximumQueuedNotifications = 1 },
            new PacingLimits { MaximumQueuedNotifications = 1 }.Validate());
        Assert.Equal(
            new PacingLimits { MaximumQueuedNotificationBytes = int.MaxValue, MaximumQueuedNotifications = 64 },
            new PacingLimits { MaximumQueuedNotificationBytes = int.MaxValue }.Validate());
    }

    [Fact]
    public void Refuse_a_limit_that_is_not_a_whole_number_above_0_naming_it()
    {
        foreach (var value in new[] { 0, -1, int.MinValue })
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                return new PacingLimits { MaximumQueuedNotifications = value }.Validate();
            });

            Assert.StartsWith("MaximumQueuedNotifications is a whole number above 0, not ", refused.Message, StringComparison.Ordinal);
        }

        Assert.Equal(
            "MaximumQueuedNotificationBytes is a whole number above 0, not 0",
            Assert.Throws<ArgumentException>(() =>
            {
                return new PacingLimits { MaximumQueuedNotificationBytes = 0 }.Validate();
            }).Message);
    }

    [Fact]
    public void Sends_the_first_notification_credited_by_asking_and_queues_the_next()
    {
        var pacing = new NotificationPacing(Limits);

        Assert.False(pacing.IsPaused);
        Assert.Equal(PacingOutcome.Send, pacing.Offer(PayloadOf("first"), null));
        Assert.True(pacing.IsPaused);
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("second"), null));
        Assert.Equal(1, pacing.QueuedNotifications);
        Assert.Equal(6L, pacing.QueuedNotificationBytes);
    }

    [Fact]
    public void Lets_go_in_order_what_a_credit_reaches_and_sends_at_once_while_credit_is_left()
    {
        var pacing = new NotificationPacing(Limits);

        pacing.Offer(PayloadOf("a"), null);

        foreach (var word in new[] { "b", "c", "d" })
        {
            pacing.Offer(PayloadOf(word), null);
        }

        // counted from the first: 3 sent at most, so 2 of the 3 queued
        Assert.Equal(["b", "c"], WordsOf(pacing.Credit(3)));
        Assert.Equal(1, pacing.QueuedNotifications);
        Assert.True(pacing.IsPaused);
        Assert.Equal(["d"], WordsOf(pacing.Credit(6)));
        Assert.False(pacing.IsPaused);
        Assert.Equal(0L, pacing.QueuedNotificationBytes);
        Assert.Equal(PacingOutcome.Send, pacing.Offer(PayloadOf("e"), null));
        Assert.Equal(PacingOutcome.Send, pacing.Offer(PayloadOf("f"), null));
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("g"), null));
    }

    [Fact]
    public void Grants_nothing_for_a_credit_at_or_below_the_one_it_has()
    {
        var pacing = new NotificationPacing(Limits);

        pacing.Offer(PayloadOf("a"), null);
        pacing.Offer(PayloadOf("b"), null);

        Assert.Empty(pacing.Credit(1));
        Assert.Empty(pacing.Credit(0));
        Assert.Equal(["b"], WordsOf(pacing.Credit(2)));

        // a credit that came late, below the one granted since
        Assert.Empty(pacing.Credit(1));
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("c"), null));
    }

    [Fact]
    public void Keeps_the_credit_it_has_when_one_below_it_comes_late_with_credit_left()
    {
        var pacing = new NotificationPacing(Limits);

        pacing.Offer(PayloadOf("a"), null);
        pacing.Credit(4);
        pacing.Credit(2);

        Assert.Equal(
            [PacingOutcome.Send, PacingOutcome.Send, PacingOutcome.Send, PacingOutcome.Queued],
            [
                pacing.Offer(PayloadOf("b"), null),
                pacing.Offer(PayloadOf("c"), null),
                pacing.Offer(PayloadOf("d"), null),
                pacing.Offer(PayloadOf("e"), null),
            ]);
    }

    [Fact]
    public void Keeps_the_latest_of_a_key_in_the_place_of_the_first_and_every_notification_without_one()
    {
        var pacing = new NotificationPacing(Limits);

        pacing.Offer(PayloadOf("sent"), 7);
        pacing.Offer(PayloadOf("7 a"), 7);
        pacing.Offer(PayloadOf("event 1"), null);
        pacing.Offer(PayloadOf("9 a"), "nine");
        pacing.Offer(PayloadOf("event 2"), null);
        pacing.Offer(PayloadOf("7 b"), 7);

        // a number and a string are two keys
        pacing.Offer(PayloadOf("\"7\""), "7");

        Assert.Equal(5, pacing.QueuedNotifications);
        Assert.Equal(["7 b", "event 1", "9 a", "event 2", "\"7\""], WordsOf(pacing.Credit(100)));
    }

    [Fact]
    public void Counts_the_bytes_of_what_replaces_not_of_what_it_replaced()
    {
        var pacing = new NotificationPacing(Limits);

        pacing.Offer(PayloadOf("sent"), null);
        pacing.Offer(new byte[10], 1);
        pacing.Offer(new byte[4], 1);
        pacing.Offer(new byte[3], null);

        Assert.Equal(7L, pacing.QueuedNotificationBytes);
        pacing.Credit(2);
        Assert.Equal(3L, pacing.QueuedNotificationBytes);
    }

    [Fact]
    public void Says_a_queue_went_past_its_count_but_not_a_key_that_only_replaces()
    {
        var pacing = new NotificationPacing(Limits with { MaximumQueuedNotifications = 2 });

        pacing.Offer(PayloadOf("sent"), null);

        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("a"), 1));
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("b"), 2));
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(PayloadOf("c"), 1));
        Assert.Equal(PacingOutcome.Exceeded, pacing.Offer(PayloadOf("d"), null));
        Assert.Equal(3, pacing.QueuedNotifications);
    }

    [Fact]
    public void Says_a_queue_went_past_its_bytes_a_replacement_larger_than_what_it_replaced_too()
    {
        var pacing = new NotificationPacing(Limits with { MaximumQueuedNotificationBytes = 8 });

        pacing.Offer(PayloadOf("sent"), null);

        Assert.Equal(PacingOutcome.Queued, pacing.Offer(new byte[4], 1));
        Assert.Equal(PacingOutcome.Queued, pacing.Offer(new byte[4], 2));
        Assert.Equal(PacingOutcome.Exceeded, pacing.Offer(new byte[5], 2));
        Assert.Equal(9L, pacing.QueuedNotificationBytes);
    }

    [Fact]
    public void Says_a_notification_larger_than_its_bytes_went_past_them_alone()
    {
        var pacing = new NotificationPacing(Limits with { MaximumQueuedNotificationBytes = 8 });

        pacing.Offer(PayloadOf("sent"), null);

        Assert.Equal(PacingOutcome.Exceeded, pacing.Offer(new byte[9], null));
    }
}
