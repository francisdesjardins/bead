using Bead.Tests;
using Bead.Transport.WebSockets;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// Bead's durations, <c>spec/durations.json</c>, played at every place that takes a duration an
/// application gives this side, by every way it takes it (decision 0014): each place built on a
/// clock of the tests' own, given each input the file holds or none, and what it holds read back —
/// an option, the due of the timer it arms, the wait a listen asks — or its refusal, in this side's
/// words, naming its option; then that nothing moved. The TypeScript side's harness plays the same
/// file, a test a place.
/// </summary>
public sealed partial class DurationsTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private const string Host = "127.0.0.1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan Millisecond = TimeSpan.FromMilliseconds(1);

    private static readonly TimeSpan Never = Timeout.InfiniteTimeSpan;

    // where a clock of the tests' own starts
    private static readonly DateTimeOffset Epoch = DateTimeOffset.UnixEpoch;

    // each place, by the id the file keys it by: its phrase, in this side's words, and each way this
    // side has, by its id, with the option its refusal names and what builds the place that way
    private static readonly Dictionary<string, (string Phrase, Dictionary<string, Way> Ways)> Table = new()
    {
        ["call.timeout"] = ("a call's timeout", new()
        {
            ["serviceManager"] = new(nameof(RequestOptions.Timeout), CallByServiceManager),
            ["router"] = new(nameof(ResolvedRequestOptions.Timeout), CallByRouter),
        }),
        ["serviceManager.defaultTimeout"] = ("a call's default timeout", new()
        {
            ["options"] = new(nameof(RequestDefaults.Timeout), DefaultTimeoutByOptions),
        }),
        ["router.reservation"] = ("a call id's reservation", new()
        {
            ["reserve"] = new("timeout", ReservationByReserve),
            ["cancel"] = new("timeout", ReservationByCancel),
        }),
        ["router.transferInactivityTimeout"] = ("a transfer's inactivity", new()
        {
            ["limits"] = new(nameof(RouterLimits.TransferInactivityTimeout), TransferInactivityByLimits),
        }),
        ["relay.timeout"] = ("a relay's timeout", new()
        {
            ["relay"] = new(nameof(RelayOptions.Timeout), RelayTimeoutByRelay),
            ["register"] = new(nameof(RelayOptions.Timeout), RelayTimeoutByRegister),
        }),
        ["sessionManager.connectionInactivityTimeout"] = (nameof(SessionManagerOptions.ConnectionInactivityTimeout), new()
        {
            ["options"] = new(nameof(SessionManagerOptions.ConnectionInactivityTimeout), ConnectionDefaultByOptions),
        }),
        ["sessionManager.sessionInactivityTimeout"] = (nameof(SessionManagerOptions.SessionInactivityTimeout), new()
        {
            ["options"] = new(nameof(SessionManagerOptions.SessionInactivityTimeout), SessionDefaultByOptions),
        }),
        ["session.inactivityTimeouts"] = ("an inactivity timeout", new()
        {
            ["setConnection"] = new(nameof(Session<string>.ConnectionInactivityTimeout), SessionTimeoutBySetConnection),
            ["setSession"] = new(nameof(Session<string>.SessionInactivityTimeout), SessionTimeoutBySetSession),
            ["updateConnection"] = new(nameof(Session<string>.ConnectionInactivityTimeout), SessionTimeoutByUpdateConnection),
            ["updateSession"] = new(nameof(Session<string>.SessionInactivityTimeout), SessionTimeoutByUpdateSession),
        }),
        ["sessionManager.resetConnectionInactivityTimeout"] = ("a connection inactivity timeout", new()
        {
            ["reset"] = new("timeout", ConnectionResetByReset),
        }),
        ["sessionManager.resetSessionInactivityTimeout"] = ("a session inactivity timeout", new()
        {
            ["reset"] = new("timeout", SessionResetByReset),
        }),
        ["server.connectionInactivityTimeout"] = ("a connection's inactivity timeout", new()
        {
            ["options"] = new(nameof(ServerOptions.ConnectionInactivityTimeout), ServerInactivityByOptions),
        }),
        ["httpTransportServer.exchangeTimeout"] = (nameof(HttpTransportServerOptions.ExchangeTimeout), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.ExchangeTimeout), ExchangeTimeoutByOptions),
        }),
        ["httpTransportServer.inactivityTimeout"] = (nameof(HttpTransportServerOptions.InactivityTimeout), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.InactivityTimeout), ServerIdleByOptions),
        }),
        ["httpTransportServer.maximumWait"] = (nameof(HttpTransportServerOptions.MaximumWait), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.MaximumWait), MaximumWaitByOptions),
        }),
        ["httpTransportServer.sendGracePeriod"] = (nameof(HttpTransportServerOptions.SendGracePeriod), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.SendGracePeriod), SendGracePeriodByHttpOptions),
        }),
        ["httpTransportServer.headersTimeout"] = (nameof(HttpTransportServerOptions.HeadersTimeout), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.HeadersTimeout), HeadersTimeoutByHttpOptions),
        }),
        ["httpTransportServer.bodyGracePeriod"] = (nameof(HttpTransportServerOptions.BodyGracePeriod), new()
        {
            ["options"] = new(nameof(HttpTransportServerOptions.BodyGracePeriod), BodyGracePeriodByOptions),
        }),
        ["httpTransportClient.inactivityTimeout"] = (nameof(HttpTransportClientOptions.InactivityTimeout), new()
        {
            ["options"] = new(nameof(HttpTransportClientOptions.InactivityTimeout), ClientInactivityByOptions),
        }),
        ["httpTransportClient.wait"] = (nameof(HttpTransportClientOptions.Wait), new()
        {
            ["options"] = new(nameof(HttpTransportClientOptions.Wait), WaitByOptions),
        }),
        ["httpTransportClient.pause"] = (nameof(HttpTransportClientOptions.Pause), new()
        {
            ["options"] = new(nameof(HttpTransportClientOptions.Pause), PauseByOptions),
        }),
        ["webSocketTransport.heartbeat"] = ("a heartbeat", new()
        {
            ["client"] = new(nameof(WebSocketTransportClientOptions.Heartbeat), HeartbeatByClient),
            ["server"] = new(nameof(WebSocketTransportServerOptions.Heartbeat), HeartbeatByServer),
        }),
        ["transportClient.connectTimeout"] = ("a connect's timeout", new()
        {
            ["http"] = new(nameof(HttpConnectOptions.Timeout), ConnectTimeoutByHttp),
            ["webSocket"] = new(nameof(WebSocketConnectOptions.Timeout), ConnectTimeoutByWebSocket),
        }),
        ["transportClient.reconnectionDelay"] = ("a delay", new()
        {
            ["function"] = new(nameof(TransportReconnectOptions.Delay), ReconnectionDelayByFunction),
        }),
        ["webSocketTransportServer.closeTimeout"] = ("a close timeout", new()
        {
            ["options"] = new(nameof(WebSocketTransportServerOptions.CloseTimeout), CloseTimeoutByOptions),
        }),
        ["webSocketTransportServer.sendGracePeriod"] = (nameof(WebSocketTransportServerOptions.SendGracePeriod), new()
        {
            ["options"] = new(nameof(WebSocketTransportServerOptions.SendGracePeriod), SendGracePeriodByWebSocketOptions),
        }),
        ["webSocketTransportServer.headersTimeout"] = (nameof(WebSocketTransportServerOptions.HeadersTimeout), new()
        {
            ["options"] = new(nameof(WebSocketTransportServerOptions.HeadersTimeout), HeadersTimeoutByWebSocketOptions),
        }),
    };

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static Observed HeldAt(TimeSpan held)
    {
        return new Observed(held, null);
    }

    private static Observed Refused(ArgumentOutOfRangeException refusal)
    {
        return new Observed(null, refusal);
    }

    // what a place built at the real clock shows: that it took its duration, nothing it holds read
    private static Observed Taken()
    {
        return new Observed(null, null);
    }

    // what the file says a place holds of an input, as a way reports it: at once as zero, never as
    // infinite, and none where it is taken alone
    private static TimeSpan? HeldOf(PlaceOutcome outcome)
    {
        return outcome.Outcome switch
        {
            "at once" => TimeSpan.Zero,
            "never" => Never,
            "taken" => null,
            _ => outcome.Held!.Value,
        };
    }

    // a refusal's words as they are checked: the sentence, when its message opens with it, and its
    // whole message otherwise, which a failure then shows
    private static string? WordsOf(ArgumentOutOfRangeException? refusal, string words)
    {
        return refusal?.Message.StartsWith(words, StringComparison.Ordinal) == true ? words : refusal?.Message;
    }

    // definition

    /// <summary>The id of every place of the file.</summary>
    public static TheoryData<string> Ids { get; } = new(Durations.Places.Select((place) =>
    {
        return place.Id;
    }));

    [Theory]
    [MemberData(nameof(Ids))]
    public async Task Plays(string id)
    {
        var place = Durations.PlaceOf(id);
        var (phrase, ways) = Table[id];

        foreach (var way in place.Ways.Where((way) =>
        {
            return !way.IsExcused;
        }))
        {
            var (parameter, play) = ways[way.Id];

            foreach (var (input, outcome) in Durations.Played(place))
            {
                var given = input.Given!.Value;
                var observed = await play(given);

                // each check names the way and the input it plays
                if (outcome.Outcome == "refused")
                {
                    var words = Durations.RefusalOf((phrase, place), given);

                    Assert.Equal<(string, string, string?, string?)>(
                        (way.Id, input.Name, parameter, words),
                        (way.Id, input.Name, observed.Refusal?.ParamName, WordsOf(observed.Refusal, words)));
                }
                else
                {
                    Assert.Equal((way.Id, input.Name, (string?)null, HeldOf(outcome)), (way.Id, input.Name, observed.Refusal?.Message, observed.Held));
                }
            }

            // a default a clause states, read by each way built with nothing given
            if (place.Default is { } stated && stated.Ways.Contains(way.Id))
            {
                var observed = await play(null);

                Assert.Equal((way.Id, "nothing given", (string?)null, (TimeSpan?)stated.Held), (way.Id, "nothing given", observed.Refusal?.Message, observed.Held));
            }
        }
    }

    // this side lacks the ways a row of the support matrix excuses it from, and has every other
    [Fact]
    public void Its_table_plays_every_place_of_the_file_each_by_every_way_the_file_gives_it_and_no_other()
    {
        Assert.Equal(
            [.. Durations.Places.Select((place) =>
            {
                return place.Id;
            }).Order(StringComparer.Ordinal)],
            Table.Keys.Order(StringComparer.Ordinal).ToArray());

        foreach (var place in Durations.Places)
        {
            var ways = place.Ways.Where((way) =>
            {
                return !way.IsExcused;
            }).Select((way) =>
            {
                return way.Id;
            });

            Assert.Equal(
                (place.Id, string.Join(", ", ways.Order(StringComparer.Ordinal))),
                (place.Id, string.Join(", ", Table[place.Id].Ways.Keys.Order(StringComparer.Ordinal))));
        }
    }

    /// <summary>
    /// What a place built one way holds of what it was given: a duration, <see cref="TimeSpan.Zero"/>
    /// for at once, <see cref="Timeout.InfiniteTimeSpan"/> for never, none where it is taken alone;
    /// or its refusal.
    /// </summary>
    private sealed record Observed(TimeSpan? Held, ArgumentOutOfRangeException? Refusal);

    /// <summary>
    /// A way a place takes its duration: the option its refusal names, and what builds the place
    /// that way, given a duration or none, checks what it keeps besides, and says what it holds.
    /// </summary>
    private sealed record Way(string Parameter, Func<TimeSpan?, Task<Observed>> Play);
}
