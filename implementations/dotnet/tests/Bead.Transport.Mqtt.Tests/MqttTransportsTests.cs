using System.Text.Json;
using Bead.Tests;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The cases over MQTT 5 of Bead's transports' cases, <c>spec/transports.json</c>, played against a
/// Mosquitto that <c>tools/mqtt-broker.mjs</c> starts (spec 15.25 to 15.31), both roles, by the
/// player the in-memory broker's cases share, <see cref="BrokerCasePlayer"/>: every participant a
/// link of this side's MQTT adapter, through a relay of its own that a <c>lose</c> cuts, linked as
/// its user with the run's password. The cases play one at a time, a class's theory rows in their
/// order, every participant of one stopped before the next, since each case's participant under
/// test has the same id. Skipped, saying so, where no broker is given; the TypeScript side plays the
/// same cases.
/// </summary>
public sealed class MqttTransportsTests
{
    // constants

    // the language a row of the support matrix names when it excuses this side from a case
    private const string Language = "C#";

    private const string Transport = "mqtt";

    // helpers

    /// <summary>Whether a broker is given, or asked for: the cases run, and fail where none is.</summary>
    public static bool IsMqtt
    {
        get
        {
            return MqttFixture.IsGiven;
        }
    }

    private static bool IsMqttCase(JsonElement entry)
    {
        return entry.GetProperty("transport").GetString() == Transport;
    }

    // definition

    /// <summary>The names of every case over MQTT 5 this side plays: each but those a row of the support matrix excuses it from.</summary>
    public static TheoryData<string> Names { get; } = new(BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where((entry) =>
    {
        return IsMqttCase(entry) && !BrokerCasePlayer.IsExcused((entry, Language));
    }).Select(BrokerCasePlayer.NameOf));

    [Theory(Skip = MqttFixture.Reason, SkipUnless = nameof(IsMqtt))]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        await BrokerCasePlayer.Play(BrokerCasePlayer.CaseOf((Transport, name)), (_) =>
        {
            return new MqttCaseBroker();
        });
    }

    [Fact]
    public void Plays_every_mqtt_case_but_those_a_row_of_the_support_matrix_excuses_this_side_from()
    {
        var cases = BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where(IsMqttCase).ToList();
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
    /// The Mosquitto a case plays against: each participant's adapter linked through a relay of its
    /// own, as its user; a link lost by its relay cut; taken over by a link of the player's own under
    /// its id, which subscribes nothing, stopped clean once the case ends; what a peer publishes
    /// published in its order, its adapter keeping it.
    /// </summary>
    private sealed class MqttCaseBroker : IBrokerCaseBroker
    {
        private readonly Dictionary<string, LinkRelay> _relays = new(StringComparer.Ordinal);
        private readonly List<MqttBrokerAdapter> _takeovers = [];

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
            var relay = LinkRelay.To(MqttFixture.Url);

            _relays[id] = relay;

            return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = id, Password = MqttFixture.Password, Uri = relay.Uri });
        }

        public Task Lose(string id)
        {
            _relays[id].Cut();

            return Task.CompletedTask;
        }

        public async Task TakeOver(string id)
        {
            var takeover = new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = id, Password = MqttFixture.Password, Uri = MqttFixture.Url });

            _takeovers.Add(takeover);
            await takeover.Start();
        }

        public async Task<BrokerPublished[]> PublishAll((IBrokerAdapter Peer, IReadOnlyList<BrokerPublication> Publications, bool IsRetained) publishing)
        {
            var (peer, publications, isRetained) = publishing;

            // ! no participant writes a retained message, and the fixture's broker refuses one (spec 15.31)
            if (isRetained)
            {
                throw new NotSupportedException("a case over MQTT 5 publishes nothing retained");
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
            return ((MqttBrokerAdapter)adapter).Unsettled;
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var takeover in _takeovers)
            {
                await takeover.Stop();
            }

            foreach (var relay in _relays.Values)
            {
                await relay.DisposeAsync();
            }
        }
    }
}
