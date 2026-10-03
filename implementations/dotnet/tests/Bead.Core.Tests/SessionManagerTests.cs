using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary><see cref="SessionManager{TData}"/>: its tokens, its events, and its two timers.</summary>
public sealed class SessionManagerTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001";
    private const string Other = "type=WS;ip=127.0.0.1;port=50002";

    // helpers

    // a token of 16 bytes of `value`
    private static SessionToken TokenOf(byte value)
    {
        var bytes = new byte[SessionToken.Bytes];

        Array.Fill(bytes, value);

        return SessionToken.FromBytes(bytes);
    }

    // the tokens of Handle's session and of Other's
    private static SessionToken?[] SessionTokensOfBoth(SessionManager<string> sessions)
    {
        return [sessions.SessionTokenOf(Handle), sessions.SessionTokenOf(Other)];
    }

    // definition

    [Fact]
    public void Draws_a_token_for_a_session_without_one_anew_each_time_and_keeps_one_given()
    {
        using var sessions = new SessionManager<string>();

        var first = sessions.Set(sessions.Create(Handle) with { Data = "ada" });
        var kept = sessions.Set(first with { Data = "bob" });
        var drawn = sessions.Set(sessions.Create(Handle) with { Data = "eve" });

        Assert.NotNull(first.SessionToken);
        Assert.Equal(first.SessionToken, kept.SessionToken);
        Assert.NotEqual(first.SessionToken, drawn.SessionToken);
        Assert.Equal(drawn.SessionToken, sessions.SessionTokenOf(Handle));
        Assert.Single(sessions.GetAll());
    }

    [Fact]
    public void Refuses_a_token_another_connection_holds_and_a_negative_timeout()
    {
        using var sessions = new SessionManager<string>();

        var held = sessions.Set(sessions.Create(Handle));

        Assert.Throws<ArgumentException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionToken = held.SessionToken });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionInactivityTimeout = TimeSpan.FromSeconds(-1) });
        });
        Assert.False(sessions.Has(Other));
    }

    [Fact]
    public void Gives_a_timeout_of_zero_the_default()
    {
        using var sessions = new SessionManager<string>(new SessionManagerOptions { SessionInactivityTimeout = TimeSpan.FromSeconds(7) });

        var session = sessions.Set(sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.Zero });

        Assert.Equal(TimeSpan.FromSeconds(7), session.SessionInactivityTimeout);
        Assert.Equal(Timeout.InfiniteTimeSpan, session.ConnectionInactivityTimeout);
    }

    [Fact]
    public void Says_what_it_created_updated_changed_and_deleted()
    {
        using var sessions = new SessionManager<string>();

        var told = new List<string>();

        sessions.Created += (session) =>
        {
            told.Add($"created {session.Data}");
        };
        sessions.Updated += (session) =>
        {
            told.Add($"updated {session.Data}");
        };
        sessions.DataChanged += (_, data, old) =>
        {
            told.Add($"data {old} to {data}");
        };
        sessions.Deleted += (session) =>
        {
            told.Add($"deleted {session.Data}");
        };

        var session = sessions.Set(sessions.Create(Handle) with { Data = "ada" });

        sessions.Set(session);
        sessions.UpdateData(session with { Data = "bob" });
        sessions.Set(sessions.Create(Handle) with { Data = "eve" });

        Assert.True(sessions.Delete(Handle));
        Assert.False(sessions.Delete(Handle));
        Assert.Equal(["created ada", "data ada to bob", "updated eve", "deleted eve"], told);
    }

    [Fact]
    public void Reaches_its_timeouts_unless_its_connection_speaks_which_starts_both_anew()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = new List<string>();

        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached.Add("connection");
        };
        sessions.SessionInactivityTimeoutReached += (_) =>
        {
            reached.Add("session");
        };
        sessions.Set(sessions.Create(Handle) with
        {
            ConnectionInactivityTimeout = TimeSpan.FromSeconds(5),
            SessionInactivityTimeout = TimeSpan.FromSeconds(2),
        });

        time.Advance(TimeSpan.FromSeconds(1));
        Assert.True(sessions.Touch(Handle));
        time.Advance(TimeSpan.FromSeconds(1.5));
        Assert.Empty(reached);
        time.Advance(TimeSpan.FromSeconds(0.5));
        Assert.Equal(["session"], reached);
        time.Advance(TimeSpan.FromSeconds(3));
        Assert.Equal(["session", "connection"], reached);
        Assert.False(sessions.Touch(Other));
    }

    [Fact]
    public void Says_what_each_timeout_changed_to_and_from_and_reaches_it()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var changed = new List<(string Timer, Session<string> Session, TimeSpan Timeout, TimeSpan Old)>();
        var reached = new List<string>();

        sessions.ConnectionInactivityTimeoutChanged += (session, timeout, old) =>
        {
            changed.Add(("connection", session, timeout, old));
        };
        sessions.SessionInactivityTimeoutChanged += (session, timeout, old) =>
        {
            changed.Add(("session", session, timeout, old));
        };
        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached.Add("connection");
        };
        sessions.SessionInactivityTimeoutReached += (_) =>
        {
            reached.Add("session");
        };

        var session = sessions.Set(sessions.Create(Handle));
        var connection = sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromSeconds(3) });

        // the same timeout again says nothing
        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromSeconds(3) });

        var stored = sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = TimeSpan.FromSeconds(2) });

        Assert.Equal(
            [
                ("connection", connection!, TimeSpan.FromSeconds(3), Timeout.InfiniteTimeSpan),
                ("session", stored!, TimeSpan.FromSeconds(2), Timeout.InfiniteTimeSpan),
            ],
            changed);
        Assert.Equal(TimeSpan.FromSeconds(3), stored!.ConnectionInactivityTimeout);
        time.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(["session"], reached);
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(["session", "connection"], reached);
        Assert.Null(sessions.UpdateConnectionInactivityTimeout(sessions.Create(Other)));
        Assert.Null(sessions.UpdateSessionInactivityTimeout(sessions.Create(Other)));
    }

    [Fact]
    public void Stamps_activity_as_a_touch_does_and_says_so_once_a_millisecond()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var changed = new List<(Session<string> Session, DateTimeOffset LastActivity, DateTimeOffset Old)>();

        sessions.LastActivityChanged += (session, lastActivity, old) =>
        {
            changed.Add((session, lastActivity, old));
        };

        var session = sessions.Set(sessions.Create(Handle));

        time.Advance(TimeSpan.FromMilliseconds(1));

        var stamped = sessions.UpdateLastActivity(session);

        // half a millisecond later, stamped but not said; a millisecond later, said from that stamp
        time.Advance(TimeSpan.FromMilliseconds(0.5));
        Assert.True(sessions.Touch(Handle));

        var unsaid = sessions.Get(Handle)!.LastActivity;

        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.True(sessions.Touch(Handle));

        Assert.Equal(
            [
                (stamped!, session.LastActivity + TimeSpan.FromMilliseconds(1), session.LastActivity),
                (sessions.Get(Handle)!, time.GetUtcNow(), unsaid),
            ],
            changed);
        Assert.Equal(session.LastActivity + TimeSpan.FromMilliseconds(1.5), unsaid);
        Assert.Null(sessions.UpdateLastActivity(sessions.Create(Other)));
    }

    [Fact]
    public void Takes_an_infinite_default_for_never_and_finds_data_alike_by_the_comparer_given()
    {
        using var sessions = new SessionManager<List<string>>(new SessionManagerOptions
        {
            DataComparer = new SequenceComparer(),
            SessionInactivityTimeout = Timeout.InfiniteTimeSpan,
        });

        var told = new List<string>();

        sessions.Updated += (_) =>
        {
            told.Add("updated");
        };
        sessions.DataChanged += (_, _, _) =>
        {
            told.Add("data");
        };

        var session = sessions.Set(sessions.Create(Handle) with { Data = ["ada"], SessionInactivityTimeout = TimeSpan.Zero });

        Assert.Equal(Timeout.InfiniteTimeSpan, session.SessionInactivityTimeout);

        // a list of the same names is alike, though another list: nothing changed
        sessions.Set(session with { Data = ["ada"] });
        sessions.UpdateData(session with { Data = ["ada"] });
        Assert.Empty(told);
        sessions.UpdateData(session with { Data = ["bob"] });
        Assert.Equal(["data"], told);
    }

    [Fact]
    public void Says_nothing_of_a_session_timeout_given_the_one_it_has()
    {
        using var sessions = new SessionManager<string>();

        var changed = 0;

        sessions.SessionInactivityTimeoutChanged += (_, _, _) =>
        {
            changed += 1;
        };

        var session = sessions.Set(sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.FromSeconds(2) });

        Assert.Equal(session, sessions.UpdateSessionInactivityTimeout(session));
        Assert.Equal(0, changed);
    }

    [Fact]
    public void Stops_its_timers_with_a_session_deleted_and_stores_nothing_once_disposed()
    {
        var time = new FakeTimeProvider();
        var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });
        var reached = 0;

        sessions.SessionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };
        sessions.Set(sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.FromSeconds(1) });
        sessions.Delete(Handle);
        time.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(0, reached);
        sessions.Dispose();
        Assert.Throws<DisconnectException>(() =>
        {
            return sessions.Set(sessions.Create(Handle));
        });
    }

    [Fact]
    public void Create_makes_a_session_without_storing_it_no_token_no_timeout_no_data()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        Assert.Equal(
            new Session<string>
            {
                ConnectionHandle = Handle,
                ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan,
                Data = null,
                LastActivity = time.GetUtcNow(),
                SessionInactivityTimeout = Timeout.InfiniteTimeSpan,
                SessionToken = null,
            },
            sessions.Create(Handle));
        Assert.False(sessions.Has(Handle));
    }

    [Fact]
    public void Set_draws_a_token_emits_created_and_leaves_the_session_it_was_given_alone()
    {
        using var sessions = new SessionManager<string>();

        var created = new List<Session<string>>();

        sessions.Created += (session) =>
        {
            created.Add(session);
        };

        var draft = sessions.Create(Handle);
        var stored = sessions.Set(draft);

        Assert.True(SessionToken.IsSessionToken(stored.SessionToken.ToString()));
        Assert.Null(draft.SessionToken);
        Assert.Equal([stored], created);
        Assert.True(sessions.Has(Handle));
    }

    [Fact]
    public void Set_emits_updated_when_it_replaces_a_different_session_and_nothing_for_the_same()
    {
        using var sessions = new SessionManager<string>();

        var updated = new List<Session<string>>();

        sessions.Updated += (session) =>
        {
            updated.Add(session);
        };

        var stored = sessions.Set(sessions.Create(Handle));

        sessions.Set(stored);
        Assert.Empty(updated);

        var changed = sessions.Set(stored with { Data = "guest" });

        Assert.Equal([changed], updated);
        Assert.Equal(stored.SessionToken, changed.SessionToken);
    }

    [Fact]
    public void Draws_tokens_the_wire_can_carry_each_its_own()
    {
        using var sessions = new SessionManager<string>();

        var drawn = new HashSet<SessionToken?>();

        for (var connection = 0; connection < 200; connection += 1)
        {
            drawn.Add(sessions.Set(sessions.Create($"type=WS;ip=127.0.0.1;port={connection}")).SessionToken);
        }

        Assert.Equal(200, drawn.Count);
        Assert.All(drawn, (token) =>
        {
            Assert.True(SessionToken.IsSessionToken(token.ToString()));
        });
    }

    [Fact]
    public void A_token_given_to_set_must_be_one_and_belong_to_no_other_connection_or_nothing_is_stored()
    {
        using var sessions = new SessionManager<string>();

        var first = sessions.GetOrElseSet(Handle);

        // a SessionToken spells no malformed text, which SessionTokenTests refuses as it parses: the
        // default, which is no token, is what is left to refuse here
        Assert.Throws<ArgumentException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionToken = default(SessionToken) });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionToken = first.SessionToken });
        });
        Assert.False(sessions.Has(Other));
        Assert.Equal([first.SessionToken, null], SessionTokensOfBoth(sessions));

        // its own token, stored again, is still its own
        Assert.Equal(first.SessionToken, sessions.Set(first with { Data = "x" }).SessionToken);
        Assert.Equal(TokenOf(3), sessions.Set(sessions.Create(Other) with { SessionToken = TokenOf(3) }).SessionToken);
    }

    [Fact]
    public void A_token_is_free_again_once_its_session_is_deleted_or_replaced()
    {
        using var sessions = new SessionManager<string>();

        var deleted = sessions.GetOrElseSet(Handle);

        sessions.Delete(Handle);
        Assert.Equal(
            deleted.SessionToken,
            sessions.Set(sessions.Create(Other) with { SessionToken = deleted.SessionToken }).SessionToken);

        var replaced = sessions.GetOrElseSet(Handle);

        sessions.Set(sessions.Create(Handle));
        sessions.Delete(Other);
        Assert.Equal(
            replaced.SessionToken,
            sessions.Set(sessions.Create(Other) with { SessionToken = replaced.SessionToken }).SessionToken);
    }

    [Fact]
    public void Keeps_each_connection_to_its_token_through_every_change_and_no_update_changes_it()
    {
        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = new FakeTimeProvider() });

        var session = sessions.Set(sessions.Create(Handle) with { SessionToken = TokenOf(1) });

        sessions.UpdateData(session with { Data = "guest" });
        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromSeconds(5) });
        sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = TimeSpan.FromSeconds(5) });
        sessions.UpdateLastActivity(session);
        sessions.Touch(Handle);
        Assert.Equal([TokenOf(1), null], SessionTokensOfBoth(sessions));
        Assert.Equal(TokenOf(1), sessions.Get(Handle)!.SessionToken);

        // what an update is handed says nothing of the token
        sessions.UpdateData(session with { SessionToken = TokenOf(2) });
        Assert.Equal(TokenOf(1), sessions.Get(Handle)!.SessionToken);

        sessions.Set(sessions.Get(Handle)! with { SessionToken = TokenOf(2) });
        Assert.Equal([TokenOf(2), null], SessionTokensOfBoth(sessions));

        // the token it let go of is free for another
        sessions.Set(sessions.Create(Other) with { SessionToken = TokenOf(1) });
        Assert.Equal([TokenOf(2), TokenOf(1)], SessionTokensOfBoth(sessions));
    }

    [Fact]
    public void GetOrElseSet_stores_a_session_once_then_returns_it()
    {
        using var sessions = new SessionManager<string>();

        var created = 0;

        sessions.Created += (_) =>
        {
            created += 1;
        };

        var session = sessions.GetOrElseSet(Handle);

        Assert.Equal(session.SessionToken, sessions.GetOrElseSet(Handle).SessionToken);
        Assert.Equal(1, created);
    }

    [Fact]
    public void GetAll_ConnectionHandles_and_Has_list_what_is_stored()
    {
        using var sessions = new SessionManager<string>();

        sessions.GetOrElseSet(Handle);
        sessions.GetOrElseSet(Other);

        // kept by dictionaries, which promise no order
        Assert.Equal([Handle, Other], sessions.ConnectionHandles().Order(StringComparer.Ordinal));
        Assert.Equal(
            [Handle, Other],
            sessions.GetAll().Select((session) =>
            {
                return session.ConnectionHandle;
            }).Order(StringComparer.Ordinal));
        Assert.True(sessions.Has(Other));
        Assert.Null(sessions.Get("type=WS;ip=127.0.0.1;port=1"));
    }

    [Fact]
    public void Every_update_of_a_connection_with_no_session_is_null()
    {
        using var sessions = new SessionManager<string>();

        var session = sessions.Create(Handle);

        Assert.Null(sessions.UpdateConnectionInactivityTimeout(session));
        Assert.Null(sessions.UpdateData(session));
        Assert.Null(sessions.UpdateLastActivity(session));
        Assert.Null(sessions.UpdateSessionInactivityTimeout(session));
    }

    [Fact]
    public void UpdateData_emits_nothing_for_equal_data()
    {
        using var sessions = new SessionManager<string>();

        var changed = 0;

        sessions.DataChanged += (_, _, _) =>
        {
            changed += 1;
        };

        var session = sessions.GetOrElseSet(Handle);

        // the TypeScript side compares data deep; this side by its equality, a record's by value
        sessions.UpdateData(session with { Data = "guest" });
        sessions.UpdateData(session with { Data = "guest" });
        Assert.Equal(1, changed);
    }

    [Fact]
    public void A_timeout_of_zero_takes_the_default_the_manager_s_own_or_its_options()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });
        using var tuned = new SessionManager<string>(new SessionManagerOptions
        {
            ConnectionInactivityTimeout = TimeSpan.FromSeconds(1),
            SessionInactivityTimeout = TimeSpan.FromSeconds(2),
            Clock = time,
        });

        var session = sessions.GetOrElseSet(Handle);
        var tunedSession = tuned.GetOrElseSet(Handle);

        Assert.Equal(
            TimeSpan.FromMilliseconds(600),
            sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.Zero })!.ConnectionInactivityTimeout);
        Assert.Equal(
            TimeSpan.FromSeconds(30),
            sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = TimeSpan.Zero })!.SessionInactivityTimeout);
        Assert.Equal(
            TimeSpan.FromSeconds(1),
            tuned.UpdateConnectionInactivityTimeout(tunedSession with { ConnectionInactivityTimeout = TimeSpan.Zero })!.ConnectionInactivityTimeout);
        Assert.Equal(
            TimeSpan.FromSeconds(2),
            tuned.UpdateSessionInactivityTimeout(tunedSession with { SessionInactivityTimeout = TimeSpan.Zero })!.SessionInactivityTimeout);
    }

    [Fact]
    public void Set_takes_the_default_for_a_timeout_of_zero_rather_than_firing_at_once()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = 0;

        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };

        var stored = sessions.Set(sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.Zero });

        time.Advance(TimeSpan.FromMilliseconds(599));
        Assert.Equal(TimeSpan.FromMilliseconds(600), stored.ConnectionInactivityTimeout);
        Assert.Equal(0, reached);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(1, reached);
    }

    // not -1 ms, which is .NET's infinite timeout; 2³¹ ms, one past what JavaScript's timers hold
    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(0.5)]
    [InlineData(2_147_483_648)]
    public void A_default_that_is_not_a_timeout_is_refused(double milliseconds)
    {
        var timeout = TimeSpan.FromMilliseconds(milliseconds);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new SessionManager<string>(new SessionManagerOptions { ConnectionInactivityTimeout = timeout });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new SessionManager<string>(new SessionManagerOptions { SessionInactivityTimeout = timeout });
        });
    }

    [Fact]
    public void A_negative_timeout_is_refused_and_nothing_is_stored()
    {
        using var sessions = new SessionManager<string>();

        var session = sessions.GetOrElseSet(Handle);

        // not -1 ms, which is .NET's infinite timeout
        var negative = TimeSpan.FromMilliseconds(-5);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionInactivityTimeout = negative });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = negative });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = negative });
        });
        Assert.False(sessions.Has(Other));
        Assert.Equal(session, sessions.Get(Handle));
    }

    [Fact]
    public void The_session_a_timer_reaches_is_the_one_stored_when_it_fires()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = new List<string?>();

        sessions.SessionInactivityTimeoutReached += (session) =>
        {
            reached.Add(session.Data);
        };

        var session = sessions.GetOrElseSet(Handle);

        sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = TimeSpan.FromMilliseconds(30) });
        sessions.UpdateData(session with { Data = "later" });
        time.Advance(TimeSpan.FromMilliseconds(30));
        Assert.Equal(["later"], reached);
    }

    [Fact]
    public void Infinite_stops_a_running_timer()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = 0;

        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };

        var session = sessions.GetOrElseSet(Handle);

        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });
        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan });
        time.Advance(TimeSpan.FromMilliseconds(60));
        Assert.Equal(0, reached);
    }

    [Fact]
    public void A_timeout_longer_than_a_timer_holds_is_refused_and_nothing_is_stored_the_longest_one_fires_at_its_due()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = 0;

        sessions.SessionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };

        var session = sessions.GetOrElseSet(Handle);

        // 2³¹ ms, one past what JavaScript's timers hold
        var longer = Clocks.LongestTimer + TimeSpan.FromMilliseconds(1);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { ConnectionInactivityTimeout = longer });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = longer });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = longer });
        });
        Assert.False(sessions.Has(Other));
        Assert.Equal(session, sessions.Get(Handle));

        sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = Clocks.LongestTimer });
        time.Advance(Clocks.LongestTimer - TimeSpan.FromMilliseconds(1));
        Assert.Equal(0, reached);
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(1, reached);
    }

    // a session manager has no reset of its own on this side: a store, an update and a default
    [Fact]
    public void A_timeout_under_a_millisecond_is_refused_by_a_store_an_update_and_a_default_and_nothing_changes_a_millisecond_is_armed()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = 0;

        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };

        var session = sessions.Set(sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.FromSeconds(1) });
        var under = TimeSpan.FromMilliseconds(0.5);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.Set(sessions.Create(Other) with { ConnectionInactivityTimeout = under });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = under });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new SessionManager<string>(new SessionManagerOptions { ConnectionInactivityTimeout = under });
        });
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new SessionManager<string>(new SessionManagerOptions { SessionInactivityTimeout = under });
        });
        Assert.StartsWith("an inactivity timeout is a millisecond at least, not 0.5", Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = under });
        }).Message, StringComparison.Ordinal);
        Assert.False(sessions.Has(Other));
        Assert.Equal(session, sessions.Get(Handle));

        // a millisecond is stored and armed
        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(1) });
        time.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(1, reached);
    }

    [Fact]
    public void Runs_on_the_clock_its_options_give_the_system_s_when_none()
    {
        var time = new FakeTimeProvider();

        using var given = new SessionManager<string>(new SessionManagerOptions { Clock = time });
        using var none = new SessionManager<string>();

        Assert.Same(time, given.Clock);
        Assert.Same(TimeProvider.System, none.Clock);
        Assert.Equal(time.GetUtcNow(), given.Create(Handle).LastActivity);
    }

    [Fact]
    public void SessionTokenOf_gives_the_token_the_router_announces_to_a_connection_none_without_a_session()
    {
        using var sessions = new SessionManager<string>();

        var stored = sessions.Set(sessions.Create(Handle) with { SessionToken = TokenOf(42) });

        Assert.Equal([TokenOf(42), null], SessionTokensOfBoth(sessions));
        sessions.Delete(stored.ConnectionHandle);
        Assert.Equal([null, null], SessionTokensOfBoth(sessions));
    }

    [Fact]
    public void A_session_stored_with_a_token_of_its_own_gets_its_timers_all_the_same()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = new List<SessionToken?>();

        sessions.ConnectionInactivityTimeoutReached += (session) =>
        {
            reached.Add(session.SessionToken);
        };

        var session = sessions.Set(sessions.Create(Other) with { SessionToken = TokenOf(7) });

        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });
        time.Advance(TimeSpan.FromMilliseconds(20));
        Assert.Equal([TokenOf(7)], reached);
    }

    [Fact]
    public void A_new_session_set_on_a_connection_stops_the_timers_of_the_one_it_replaces()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = 0;

        sessions.ConnectionInactivityTimeoutReached += (_) =>
        {
            reached += 1;
        };

        var session = sessions.GetOrElseSet(Handle);

        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });
        sessions.Set(sessions.Create(Handle));
        time.Advance(TimeSpan.FromMilliseconds(60));
        Assert.Equal(0, reached);
    }

    [Fact]
    public void Set_keeps_the_timers_in_step_with_the_timeouts_it_stores()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = new List<Session<string>>();

        sessions.ConnectionInactivityTimeoutReached += (session) =>
        {
            reached.Add(session);
        };

        var running = sessions.GetOrElseSet(Handle);

        // a timeout set to infinite stops the timer that was running
        sessions.UpdateConnectionInactivityTimeout(running with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });
        sessions.Set(sessions.Get(Handle)! with { ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan });

        // a new session with a timeout of its own is armed with it
        var armed = sessions.Set(sessions.Create(Other) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });

        time.Advance(TimeSpan.FromMilliseconds(80));
        Assert.Equal([armed], reached);
    }

    [Fact]
    public void A_new_session_with_the_timeout_of_the_one_it_replaces_is_armed_anew()
    {
        var time = new FakeTimeProvider();

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });

        var reached = new List<SessionToken?>();

        sessions.ConnectionInactivityTimeoutReached += (session) =>
        {
            reached.Add(session.SessionToken);
        };

        var session = sessions.GetOrElseSet(Handle);

        sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(30) });
        time.Advance(TimeSpan.FromMilliseconds(20));

        var replacing = sessions.Set(sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(30) });

        // past the deadline of the timer it replaced, short of its own
        time.Advance(TimeSpan.FromMilliseconds(10));
        Assert.Empty(reached);
        time.Advance(TimeSpan.FromMilliseconds(20));
        Assert.Equal([replacing.SessionToken], reached);
    }

    [Fact]
    public void Dispose_stops_every_timer_and_forgets_every_session_without_events()
    {
        var time = new FakeTimeProvider();
        var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = time });
        var told = new List<string>();

        sessions.Deleted += (_) =>
        {
            told.Add("deleted");
        };
        sessions.SessionInactivityTimeoutReached += (_) =>
        {
            told.Add("reached");
        };

        var session = sessions.GetOrElseSet(Handle);

        sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = TimeSpan.FromMilliseconds(20) });
        sessions.Dispose();
        Assert.Empty(sessions.ConnectionHandles());
        time.Advance(TimeSpan.FromMilliseconds(60));
        Assert.Empty(told);
    }

    [Fact]
    public void Draws_a_token_again_when_all_zero_or_in_use()
    {
        // its TypeScript twin, identifiers.test.ts:220, draws through the shared identifiers, a module
        // this side does not have: its draw is the session manager's own
        var fills = new Queue<byte>([0, 0, 1, 1, 2]);

        using var sessions = new SessionManager<string>(new SessionManagerOptions
        {
            Fill = (bytes) =>
            {
                bytes.Fill(fills.TryDequeue(out var value) ? value : (byte)3);
            },
        });

        sessions.Set(sessions.Create(Other) with { SessionToken = TokenOf(1) });
        Assert.Equal(TokenOf(2), sessions.Set(sessions.Create(Handle)).SessionToken);
        Assert.Empty(fills);
    }

    // the TypeScript side's timers are public, so a timer set by hand can outlive its session and be
    // told as an anomaly; this side's are its own, and cannot
    [Fact]
    public void Count_the_sessions_and_the_connections_timed()
    {
        using var sessions = new SessionManager<string>();

        sessions.Set(sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.FromSeconds(1) });

        var gauges = sessions.Gauges();

        Assert.Empty(gauges.Anomalies);
        Assert.Empty(gauges.Ceilings);
        Assert.Equal([Handle], gauges.ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["sessions"] = 1, ["timedConnections"] = 1 }, gauges.Counts);
        sessions.Delete(Handle);
        Assert.Empty(sessions.Gauges().ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["sessions"] = 0, ["timedConnections"] = 0 }, sessions.Gauges().Counts);
    }

    // two lists of names alike when their names are, in order, as the TypeScript side's structure
    private sealed class SequenceComparer : System.Collections.IEqualityComparer
    {
        public new bool Equals(object? data, object? other)
        {
            return data is IEnumerable<string> names && other is IEnumerable<string> others ? names.SequenceEqual(others) : Object.Equals(data, other);
        }

        public int GetHashCode(object data)
        {
            return 0;
        }
    }
}
