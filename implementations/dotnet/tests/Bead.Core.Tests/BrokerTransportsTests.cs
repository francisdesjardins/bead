namespace Bead.Tests;

/// <summary>
/// The broker's cases of Bead's transports' cases, <c>spec/transports.json</c>, played against the
/// core's broker transports over its in-memory broker (spec 15.16 to 15.24), both roles, by the
/// player every broker's cases share, <see cref="BrokerCasePlayer"/>. The broker, its adapters, the
/// participant under test and the server share one scheduler, on which the clock given settles; a
/// case marked <c>realTime</c> plays its heartbeat on the real clock. The TypeScript side plays the
/// same cases.
/// </summary>
public sealed class BrokerTransportsTests
{
    // constants

    // the language a row of the support matrix names when it excuses this side from a case
    private const string Language = "C#";

    private const string Transport = "broker";

    // helpers

    private static bool IsBroker(System.Text.Json.JsonElement entry)
    {
        return entry.GetProperty("transport").GetString() == Transport;
    }

    // definition

    /// <summary>The names of every broker case this side plays: each but those a row of the support matrix excuses it from.</summary>
    public static TheoryData<string> Names { get; } = new(BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where((entry) =>
    {
        return IsBroker(entry) && !BrokerCasePlayer.IsExcused((entry, Language));
    }).Select(BrokerCasePlayer.NameOf));

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Plays(string name)
    {
        await BrokerCasePlayer.Play(BrokerCasePlayer.CaseOf((Transport, name)), (setup) =>
        {
            return new MemoryCaseBroker(setup);
        });
    }

    [Fact]
    public void Plays_every_broker_case_but_those_a_row_of_the_support_matrix_excuses_this_side_from()
    {
        var cases = BrokerCasePlayer.Root.GetProperty("cases").EnumerateArray().Where(IsBroker).ToList();
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
    /// The in-memory broker a case plays against, on the case's clock and its scheduler, each
    /// subscriber's queue bounded as the case says: a link lost by its adapter's <c>Lose</c>, taken
    /// over by its <c>TakeOver</c>, what a peer publishes published in one turn of its broker's.
    /// </summary>
    private sealed class MemoryCaseBroker(BrokerCaseSetup setup) : IBrokerCaseBroker
    {
        private readonly MemoryBroker _broker = new(new MemoryBrokerOptions
        {
            Clock = setup.Clock,
            MaximumQueuedMessages = setup.Entry.TryGetProperty("options", out var options) && options.TryGetProperty("maximumQueuedMessages", out var bound) ? bound.GetInt32() : null,
            Scheduler = setup.Scheduler,
        });

        private readonly Dictionary<string, MemoryBrokerAdapter> _adapters = new(StringComparer.Ordinal);

        public TimeSpan Settling
        {
            get
            {
                return TimeSpan.Zero;
            }
        }

        public IBrokerAdapter AdapterOf(string id)
        {
            var adapter = _broker.Adapter(new MemoryBrokerAdapterOptions { Id = id });

            _adapters[id] = adapter;

            return adapter;
        }

        public Task Lose(string id)
        {
            _adapters[id].Lose();

            return Task.CompletedTask;
        }

        public Task TakeOver(string id)
        {
            _adapters[id].TakeOver();

            return Task.CompletedTask;
        }

        public async Task<BrokerPublished[]> PublishAll((IBrokerAdapter Peer, IReadOnlyList<BrokerPublication> Publications, bool IsRetained) publishing)
        {
            var (peer, publications, isRetained) = publishing;
            var adapter = (MemoryBrokerAdapter)peer;
            var published = new List<Task<BrokerPublished>>();

            await _broker.Turn(() =>
            {
                foreach (var publication in publications)
                {
                    published.Add(isRetained ? adapter.PublishRetained(publication) : adapter.Publish(publication));
                }
            });

            return await Task.WhenAll(published);
        }

        public Task Turn(Action action)
        {
            return _broker.Turn(action);
        }

        public long UnsettledOf(IBrokerAdapter adapter)
        {
            return ((MemoryBrokerAdapter)adapter).Unsettled;
        }

        public ValueTask DisposeAsync()
        {
            return ValueTask.CompletedTask;
        }
    }
}
