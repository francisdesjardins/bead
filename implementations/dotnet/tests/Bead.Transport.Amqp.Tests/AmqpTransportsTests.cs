using System.Text.Json;
using Bead.Tests;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// The cases over AMQP 1.0 of Bead's transports' cases, <c>spec/transports.json</c>, played against a
/// RabbitMQ that <c>tools/amqp-broker.mjs</c> starts (spec 15.32 to 15.38), both roles, by the player
/// the in-memory broker's cases share, <see cref="BrokerCasePlayer"/>: every participant a link of
/// this side's AMQP 1.0 adapter, through a relay of its own that a <c>lose</c> cuts, linked as its
/// user with the run's password; in the client role, each peer reads the server's name through a
/// queue of its own, bound by the name, so that each reads every OPEN. Each case begins with every
/// name's queue empty, what an earlier one left in it purged, and with the inbox of each of its ids
/// gone with the connection that held it. The cases play one at a time, a class's theory rows in
/// their order, every participant of one stopped before the next, since each case's participant
/// under test has the same id. Skipped, saying so, where no broker is given; the TypeScript side
/// plays the same cases.
/// </summary>
[Collection(AmqpFixture.Collection)]
public sealed class AmqpTransportsTests
{
    // constants

    // the language a row of the support matrix names when it excuses this side from a case
    private const string Language = "C#";

    private const string Transport = "amqp";

    // helpers

    /// <summary>Whether a broker is given, or asked for: the cases run, and fail where none is.</summary>
    public static bool IsAmqp
    {
        get
        {
            return AmqpFixture.IsGiven;
        }
    }

    private static bool IsAmqpCase(JsonElement entry)
    {
        return entry.GetProperty("transport").GetString() == Transport;
    }

    // the ids a case links as: the participant under test, its peers and its twin
    private static List<string> IdsOf(JsonElement entry)
    {
        var ids = new List<string> { entry.TryGetProperty("role", out var role) && role.GetString() == "client" ? "client" : "server" };

        ids.AddRange(entry.TryGetProperty("peers", out var peers)
            ? peers.EnumerateArray().Select((peer) =>
            {
                return peer.GetString()!;
            })
            : ["peer"]);

        if (entry.TryGetProperty("options", out var options) && options.TryGetProperty("twin", out var twin))
        {
            ids.Add(twin.GetString()!);
        }

        return ids;
    }

    // definition

    /// <summary>The names of every case over AMQP 1.0 this side plays: each but those a row of the support matrix excuses it from.</summary>
    public static TheoryData<string> Names { get; } = new(BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where((entry) =>
    {
        return IsAmqpCase(entry) && !BrokerCasePlayer.IsExcused((entry, Language));
    }).Select(BrokerCasePlayer.NameOf));

    [Theory(Skip = AmqpFixture.Reason, SkipUnless = nameof(IsAmqp))]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        var entry = BrokerCasePlayer.CaseOf((Transport, name));
        var broker = BrokerCasePlayer.Root.GetProperty("brokers").GetProperty("amqp");
        var root = broker.GetProperty("exchange").GetString()!;

        // * every name's queue empty, and every inbox of its ids gone with its former connection
        foreach (var served in broker.GetProperty("names").EnumerateArray())
        {
            await AmqpFixture.Purge($"{root}.s.{served.GetString()}");
        }

        await AmqpFixture.Gone(([.. IdsOf(entry).SelectMany((id) =>
        {
            return new[] { $"{root}.i.{id}", $"{root}.p.{id}" };
        })], TimeSpan.FromSeconds(10)));
        await BrokerCasePlayer.Play(entry, (_) =>
        {
            return new AmqpCaseBroker(root);
        });
    }

    [Fact]
    public void Plays_every_amqp_case_but_those_a_row_of_the_support_matrix_excuses_this_side_from()
    {
        var cases = BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where(IsAmqpCase).ToList();
        var played = Names.Select((row) =>
        {
            return row.Data;
        }).ToHashSet();

        Assert.NotEmpty(cases);
        Assert.All(cases, (entry) =>
        {
            Assert.Equal(!BrokerCasePlayer.IsExcused((entry, Language)), played.Contains(BrokerCasePlayer.NameOf(entry)));
        });
    }

    /// <summary>
    /// The RabbitMQ a case plays against: each participant's adapter linked through a relay of its
    /// own, as its user; a link lost by its relay cut; no takeover, which no case over AMQP 1.0 asks;
    /// a peer of the client role reading the server's name through a queue of its own,
    /// <c>bead.p.</c> and its id, exclusive to its link; what a peer publishes published in its
    /// order, its adapter keeping it.
    /// </summary>
    private sealed class AmqpCaseBroker(string root) : IBrokerCaseBroker
    {
        private readonly Dictionary<string, LinkRelay> _relays = new(StringComparer.Ordinal);

        public TimeSpan Settling
        {
            get
            {
                // * a copy over a real broker may come a moment after what was read
                return TimeSpan.FromMilliseconds(200);
            }
        }

        public IBrokerAdapter AdapterOf(string id)
        {
            var relay = LinkRelay.To(AmqpFixture.Url);

            _relays[id] = relay;

            return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = id, Password = AmqpFixture.Password, Uri = relay.Uri });
        }

        public Task Lose(string id)
        {
            _relays[id].Cut();

            return Task.CompletedTask;
        }

        public Task TakeOver(string id)
        {
            // ! AMQP 1.0 has no takeover: an id's later link is refused while its earlier holds its inbox
            throw new NotSupportedException("no case over AMQP 1.0 takes a link over");
        }

        public Task SubscribeName((IBrokerAdapter Peer, string Id, IReadOnlyList<string> Name) subscribing)
        {
            return ((AmqpBrokerAdapter)subscribing.Peer).SubscribeThrough((subscribing.Name, $"{root}.p.{subscribing.Id}"));
        }

        public async Task<BrokerPublished[]> PublishAll((IBrokerAdapter Peer, IReadOnlyList<BrokerPublication> Publications, bool IsRetained) publishing)
        {
            var (peer, publications, isRetained) = publishing;

            // ! no AMQP 1.0 broker retains a message: no participant writes one so
            if (isRetained)
            {
                throw new NotSupportedException("a case over AMQP 1.0 publishes nothing retained");
            }

            var published = publications.Select(peer.Publish).ToList();

            return await Task.WhenAll(published);
        }

        public Task Turn(Action action)
        {
            ArgumentNullException.ThrowIfNull(action);
            action();

            return Task.CompletedTask;
        }

        public long UnsettledOf(IBrokerAdapter adapter)
        {
            return ((AmqpBrokerAdapter)adapter).Unsettled;
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var relay in _relays.Values)
            {
                await relay.DisposeAsync();
            }
        }
    }
}
