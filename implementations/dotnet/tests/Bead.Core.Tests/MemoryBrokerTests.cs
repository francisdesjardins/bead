using System.Collections.Concurrent;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// The core's in-memory broker (spec 15.24): every capability but a publisher's identity, each
/// message handed on once, later, in its publisher's order; and, as a test asks, copied, held,
/// dropped, handed to another member, its queues bounded and its links lost.
/// </summary>
public sealed class MemoryBrokerTests
{
    private static readonly IReadOnlyList<string> Topic = ["bead", "s", "interop"];

    // a linked adapter of the broker and what reached it, its acknowledgement given as it comes
    private static async Task<(MemoryBrokerAdapter Adapter, ConcurrentQueue<string> Heard)> LinkedOf((MemoryBroker Broker, string Id) linked)
    {
        var adapter = linked.Broker.Adapter(new MemoryBrokerAdapterOptions { Id = linked.Id });
        var heard = new ConcurrentQueue<string>();

        adapter.Message += (message) =>
        {
            heard.Enqueue($"{(message.IsRetained ? "retained " : "")}{Convert.ToHexString(message.Payload.Span)}");
            message.Settle();
        };
        await adapter.Start();

        return (adapter, heard);
    }

    private static BrokerPublication PublicationOf(byte payload)
    {
        return new BrokerPublication { Topic = Topic, Payload = (byte[])[payload] };
    }

    [Fact]
    public async Task Hands_each_message_on_once_in_a_later_turn_in_the_order_its_publisher_published_to_that_topic_spec_15_24()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        var (publisher, _) = await LinkedOf((broker, "ada"));
        var (subscriber, heard) = await LinkedOf((broker, "bob"));
        var counted = new List<int>();
        var payload = new byte[] { 1 };

        await subscriber.Subscribe(Topic);
        await broker.Turn(() =>
        {
            _ = publisher.Publish(new BrokerPublication { Topic = Topic, Payload = payload });

            // * copied as it is published: the publisher's buffer stays its own
            payload[0] = 9;
            _ = publisher.Publish(PublicationOf(2));
            _ = publisher.Publish(PublicationOf(3));

            // never within the turn it was published in
            counted.Add(heard.Count);
        });
        await scheduler.WhenIdle();

        Assert.Equal([0], counted);
        Assert.Equal(["01", "02", "03"], heard);
        Assert.Equal(0, subscriber.Unsettled);

        // what no subscription takes is refused so, and a topic is matched whole
        Assert.Equal(BrokerPublished.NoSubscriber, await publisher.Publish(PublicationOf(4) with { Topic = ["bead", "s", "other"] }));
        Assert.Equal(BrokerPublished.Taken, await publisher.Publish(PublicationOf(5)));
        await scheduler.WhenIdle();
        Assert.Equal(["01", "02", "03", "05"], heard);
    }

    [Fact]
    public async Task Hands_a_group_message_to_one_member_in_turn_and_again_to_another_when_a_test_asks_spec_15_24()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        var (publisher, _) = await LinkedOf((broker, "ada"));
        var (first, firstHeard) = await LinkedOf((broker, "bob"));
        var (second, secondHeard) = await LinkedOf((broker, "cid"));
        var (alone, aloneHeard) = await LinkedOf((broker, "dee"));
        var group = new BrokerSubscription { Group = "interop" };

        await first.Subscribe(Topic, group);
        await second.Subscribe(Topic, group);
        await alone.Subscribe(Topic);

        foreach (var payload in new byte[] { 1, 2, 3, 4 })
        {
            await publisher.Publish(PublicationOf(payload));
        }

        await scheduler.WhenIdle();

        // * one member in turn; one held alone takes every one
        Assert.Equal(["01", "03"], firstHeard);
        Assert.Equal(["02", "04"], secondHeard);
        Assert.Equal(["01", "02", "03", "04"], aloneHeard);

        // again to another member, as a broker whose member's session ended unacknowledged does
        broker.Fault(MemoryBrokerFault.Redeliver, new MemoryBrokerFaultOptions { Topic = Topic });
        await publisher.Publish(PublicationOf(5));
        await scheduler.WhenIdle();
        Assert.Equal(["01", "03", "05"], firstHeard);
        Assert.Equal(["02", "04", "05"], secondHeard);
        Assert.Equal(["01", "02", "03", "04", "05"], aloneHeard);

        // a group needs its adapter to offer one
        var plain = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "plain", Capabilities = BrokerCapabilities.None });

        await plain.Start();
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return plain.Subscribe(Topic, group);
        });
    }

    [Fact]
    public async Task Copies_reorders_and_drops_a_message_as_a_test_asks_drops_past_a_subscriber_s_queue_bound_and_publishes_a_will_as_a_link_is_lost_spec_15_24()
    {
        var scheduler = new SerialScheduler();
        var clock = new FakeTimeProvider();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Clock = clock, MaximumQueuedMessages = 2, Scheduler = scheduler });
        var (publisher, _) = await LinkedOf((broker, "ada"));
        var (subscriber, heard) = await LinkedOf((broker, "bob"));

        await subscriber.Subscribe(Topic);

        // copied, held behind the next, dropped: each fault befalls one message, in turn
        broker.Fault(MemoryBrokerFault.Copy);
        broker.Fault(MemoryBrokerFault.Hold);
        broker.Fault(MemoryBrokerFault.Drop);

        foreach (var payload in new byte[] { 1, 2, 3, 4, 5 })
        {
            await publisher.Publish(PublicationOf(payload) with { ExpiresAfter = TimeSpan.FromMinutes(1) });
            await scheduler.WhenIdle();
        }

        Assert.Equal(["01", "01", "04", "02", "05"], heard);
        heard.Clear();

        // past a subscriber's queue bound, the one published is dropped
        await broker.Turn(() =>
        {
            _ = publisher.Publish(PublicationOf(6));
            _ = publisher.Publish(PublicationOf(7));
            _ = publisher.Publish(PublicationOf(8));
        });
        await scheduler.WhenIdle();
        Assert.Equal(["06", "07"], heard);
        heard.Clear();

        // retained, as a test asks; and a message whose life passed before it was handed on, deleted
        await publisher.PublishRetained(PublicationOf(9));
        await broker.Turn(() =>
        {
            _ = publisher.Publish(PublicationOf(10) with { ExpiresAfter = TimeSpan.FromSeconds(1) });
            clock.Advance(TimeSpan.FromSeconds(2));
        });
        await scheduler.WhenIdle();
        Assert.Equal(["retained 09"], heard);
        heard.Clear();

        // a will, published as a link is lost, never at a stop; its loss told
        IReadOnlyList<string> departure = ["bead", "d", "cid"];
        var (lost, _) = await LinkedOf((broker, "cid-link"));
        var downs = 0;
        var will = new BrokerStart { Will = new BrokerPublication { Topic = departure, Payload = (byte[])[0xA] } };
        var leaving = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "cid" });

        leaving.Down += (_) =>
        {
            Interlocked.Increment(ref downs);
        };
        await subscriber.Subscribe(departure);
        await leaving.Start(will);
        await leaving.Stop();
        await scheduler.WhenIdle();
        Assert.Empty(heard);

        await leaving.Start(will);
        leaving.Lose();
        await scheduler.WhenIdle();
        Assert.Equal(["0A"], heard);
        Assert.Equal((1, false), (downs, leaving.IsLinked));
        Assert.True(lost.IsLinked);
    }

    [Fact]
    public async Task Takes_a_link_over_as_a_test_asks_as_a_second_link_of_its_id_would_its_subscriptions_dropped_its_will_published_its_down_told_taken_over_spec_15_24()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        var (ada, heard) = await LinkedOf((broker, "ada"));
        var bob = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "bob" });
        IReadOnlyList<string> departure = ["bead", "d", "bob"];
        IReadOnlyList<string> inbox = ["bead", "i", "bob"];
        var downs = new ConcurrentQueue<bool>();

        bob.Down += (down) =>
        {
            downs.Enqueue(down.IsTakenOver);
        };
        await ada.Subscribe(departure);
        await bob.Start(new BrokerStart { Will = new BrokerPublication { Topic = departure, Payload = (byte[])[0xA] } });
        await bob.Subscribe(inbox);
        bob.TakeOver();
        await scheduler.WhenIdle();

        Assert.False(bob.IsLinked);
        Assert.Equal([true], downs);
        Assert.Equal(["0A"], heard);

        // * no link of its id holds its inbox now
        Assert.Equal(BrokerPublished.NoSubscriber, await ada.Publish(new BrokerPublication { Topic = inbox, Payload = (byte[])[1] }));

        // a loss tells its down otherwise, and a takeover of a link not up does nothing
        await bob.Start();
        bob.Lose();
        bob.TakeOver();
        await scheduler.WhenIdle();
        Assert.Equal([true, false], downs);
    }

    [Fact]
    public async Task Refuses_a_second_adapter_of_one_id_and_a_will_asked_of_an_adapter_that_takes_none()
    {
        var broker = new MemoryBroker();
        var plain = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada", Capabilities = BrokerCapabilities.None });

        Assert.Equal("an adapter of this broker is ada already (Parameter 'options')", Assert.Throws<ArgumentException>(() =>
        {
            return broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
        }).Message);
        Assert.Equal("the adapter of ada takes no will (Parameter 'start')", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return plain.Start(new BrokerStart { Will = new BrokerPublication { Topic = ["bead", "d", "ada"], Payload = "gone"u8.ToArray() } });
        })).Message);
        Assert.False(plain.IsLinked);
    }

    [Fact]
    public async Task Refuses_a_publication_given_up_on_before_it_goes()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = scheduler });
        var (publisher, _) = await LinkedOf((broker, "ada"));
        var (subscriber, heard) = await LinkedOf((broker, "bob"));

        await subscriber.Subscribe(Topic);
        Assert.Equal("the publication was given up on", (await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return publisher.Publish(PublicationOf(1) with { CancellationToken = new CancellationToken(true) });
        })).Message);
        await scheduler.WhenIdle();
        Assert.Empty(heard);
    }

    [Fact]
    public async Task Refuses_a_start_of_a_link_up_already_and_a_publication_past_maximumMessageBytes_or_of_a_link_not_up_drops_what_a_link_lost_held_and_a_loss_of_a_link_not_up_does_nothing()
    {
        var scheduler = new SerialScheduler();
        var broker = new MemoryBroker(new MemoryBrokerOptions { MaximumMessageBytes = 4, Scheduler = scheduler });
        var ada = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "ada" });
        var heard = new ConcurrentQueue<string>();
        var downs = 0;
        IReadOnlyList<string> inbox = ["bead", "i", "ada"];

        ada.Down += (_) =>
        {
            Interlocked.Increment(ref downs);
        };
        ada.Message += (message) =>
        {
            heard.Enqueue(Convert.ToHexString(message.Payload.Span));
            message.Settle();
        };

        // a link never up is lost of nothing: no down told
        ada.Lose();
        await scheduler.WhenIdle();
        Assert.Equal(0, downs);

        await ada.Start();
        await ada.Subscribe(inbox);

        var (bob, _) = await LinkedOf((broker, "bob"));

        Assert.Equal("the link of ada is up already", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ada.Start();
        })).Message);
        Assert.Equal("a payload of 5 bytes, past the broker's maximumMessageBytes, 4 bytes (Parameter 'published')", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return bob.Publish(new BrokerPublication { Topic = inbox, Payload = "fives"u8.ToArray() });
        })).Message);

        // * published, then its subscriber's link lost in the same turn: what it held goes with it
        var published = bob.Publish(new BrokerPublication { Topic = inbox, Payload = "lost"u8.ToArray() });

        ada.Lose();
        await scheduler.WhenIdle();
        Assert.Equal((BrokerPublished.Taken, 0, 1), (await published, heard.Count, downs));
        Assert.Equal("the link of ada is not up", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ada.Publish(PublicationOf(1));
        })).Message);

        // an adapter no listener hears: handed a message, then lost, telling no one
        var cid = broker.Adapter(new MemoryBrokerAdapterOptions { Id = "cid" });

        await cid.Start();
        await cid.Subscribe(["bead", "i", "cid"]);
        await bob.Publish(new BrokerPublication { Topic = ["bead", "i", "cid"], Payload = (byte[])[1] });
        await scheduler.WhenIdle();
        cid.Lose();
        await scheduler.WhenIdle();
        Assert.False(cid.IsLinked);
    }
}
