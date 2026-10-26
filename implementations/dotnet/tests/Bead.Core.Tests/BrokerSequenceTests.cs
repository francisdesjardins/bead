namespace Bead.Tests;

/// <summary>
/// One direction of a broker connection (spec 15.19, 15.20): its sequence, which hands each parcel
/// on once and in order, drops a copy and loses its connection at a gap; and its envelope in parts,
/// whole once its last part came, held to its bound, its participant's budget and its rate.
/// </summary>
public sealed class BrokerSequenceTests
{
    private static readonly DateTimeOffset Epoch = DateTimeOffset.UnixEpoch;

    private static BrokerPartsBounds BoundsOf((TimeProvider Clock, long Budget) given)
    {
        return new BrokerPartsBounds
        {
            BodyGracePeriod = TimeSpan.FromSeconds(5),
            Budget = new BrokerBudget(given.Budget),
            Clock = given.Clock,
            MaximumEnvelopePartsBytes = 64,
            MinimumBodyBytesPerSecond = 240,
        };
    }

    [Fact]
    public void Hands_parcels_on_in_their_order_once_each_drops_a_copy_and_loses_the_connection_at_a_gap()
    {
        // an acceptor's direction, its OPEN 1 taken: the next awaited is 2
        var sequence = new BrokerSequence(2);

        Assert.Equal(
            [BrokerTaking.Copy, BrokerTaking.Next, BrokerTaking.Copy, BrokerTaking.Next, BrokerTaking.Next, BrokerTaking.Copy],
            new ulong[] { 1, 2, 2, 3, 4, 3 }.Select(sequence.Take));
        Assert.Equal(5UL, sequence.Awaited);

        // * past the next one awaited: a loss, the window kept where it stood
        Assert.Equal(BrokerTaking.Gap, sequence.Take(7));
        Assert.Equal(5UL, sequence.Awaited);
        Assert.Equal("a parcel lost: 5 was awaited, and 7 came", sequence.GapOf(7));
    }

    [Fact]
    public async Task Reassembles_an_envelope_from_its_parts_and_loses_the_connection_past_its_bound_its_budget_or_its_rate()
    {
        var clock = new SteppingClock(Epoch);
        var lates = 0;
        var bounds = BoundsOf((clock, 100));
        var parts = new BrokerParts(bounds, () =>
        {
            Interlocked.Increment(ref lates);
        });

        // whole at once, its credential beside it
        var whole = parts.Take(((byte[])[1, 2, 3], false, "Bearer a"));

        Assert.Equal([1, 2, 3], whole.Envelope);
        Assert.Equal(("Bearer a", null), (whole.Credential, whole.Lost));

        // in parts: held, then whole once its last came, the credential its first carried
        Assert.Equal(new BrokerPartTaking(null, null, null), parts.Take(((byte[])[1, 2], true, "Bearer b")));
        Assert.Equal(2, parts.HeldBytes);
        Assert.Equal(2, bounds.Budget.Held);

        var reassembled = parts.Take(((byte[])[3], false, null));

        Assert.Equal([1, 2, 3], reassembled.Envelope);
        Assert.Equal("Bearer b", reassembled.Credential);
        Assert.Equal((0L, 0L), (parts.HeldBytes, bounds.Budget.Held));

        // a credential on a part past the first does not read: 1002, naming it
        parts.Take(((byte[])[1], true, null));
        Assert.Equal((1002, "a part past the first of an envelope carries a credential"), parts.Take(((byte[])[2], false, "Bearer c")).Lost!.Value);
        Assert.Equal(0L, bounds.Budget.Held);

        // past maximumEnvelopePartsBytes: 1009, naming the bound
        parts.Take((new byte[40], true, null));

        var past = parts.Take((new byte[40], true, null)).Lost!.Value;

        Assert.Equal((1009, "an envelope's parts would pass maximumEnvelopePartsBytes, 64 bytes"), past);
        parts.Stop();

        // past the participant's budget, held across its connections: 4000, naming it
        var other = new BrokerParts(bounds, () =>
        {
        });

        other.Take((new byte[60], true, null));
        parts.Take((new byte[10], true, null));

        // * its last part charged as each before it
        Assert.Equal((4000, "a part would pass its participant's heldBytesBudget, 100 bytes"), parts.Take((new byte[35], false, null)).Lost!.Value);
        Assert.Equal(60L, bounds.Budget.Held);
        other.Stop();

        // too slow once its grace passed, on the clock given: late at its deadline, not before
        parts.Take((new byte[10], true, null));
        Assert.Equal([TimeSpan.FromSeconds(5)], clock.Dues());
        await clock.Advance(TimeSpan.FromMilliseconds(4_999));
        Assert.Equal((0, false), (lates, parts.IsLate()));
        await clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal((1, true), (lates, parts.IsLate()));
        Assert.Equal("an envelope's parts came slower than minimumBodyBytesPerSecond, 240 bytes a second, past bodyGracePeriod, 5000 ms", parts.LateOf());
        parts.Stop();
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public void Cuts_an_envelope_in_parts_each_as_large_as_the_peer_s_bound_lets_it_the_credential_on_the_first_alone()
    {
        var envelope = Enumerable.Range(0, 100).Select((index) =>
        {
            return (byte)index;
        }).ToArray();

        // whole where it fits
        var whole = Assert.Single(BrokerParts.Cut(envelope, (1_024, "Bearer a")));

        Assert.Equal((BrokerParcelFlags.Credential, "Bearer a", 100), (whole.Flags, whole.Credential, whole.Carried.Length));

        // in parts of the bound but the last: 28 bytes of prefix, 10 of credential on the first
        var parts = BrokerParts.Cut(envelope, (68, "Bearer a"));

        Assert.Equal(
            [(BrokerParcelFlags.More | BrokerParcelFlags.Credential, "Bearer a", 30), (BrokerParcelFlags.More, null, 40), ((byte)0, null, 30)],
            parts.Select((part) =>
            {
                return (part.Flags, part.Credential, part.Carried.Length);
            }));
        Assert.Equal(envelope, parts.SelectMany((part) =>
        {
            return part.Carried.ToArray();
        }));
        Assert.All(parts, (part) =>
        {
            Assert.True(BrokerParcels.Write(part with { Opener = 1, Acceptor = 2, Sequence = 3 }).Length <= 68);
        });

        // a bound that leaves no byte beside the credential cuts none
        Assert.Empty(BrokerParts.Cut(envelope, (38, "Bearer a")));
    }
}
