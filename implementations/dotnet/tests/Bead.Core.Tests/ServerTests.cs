using System.Text;
using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="Server{TData}"/> over a transport a test scripts, on a clock a test moves: its layers,
/// the admission that needs a session, the timeouts of section 13.7 of the spec, which no
/// conversation reaches, the closes it asks for — once, and what one that fails or finds its
/// connection gone leaves — and what its disposal lets go of. What a client sees of its sessions on
/// the wire is the conversations' to play.
/// </summary>
public sealed class ServerTests : IAsyncLifetime
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // how long a command waits for its answer here
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromMilliseconds(10);

    private readonly FakeTimeProvider _time = new();
    private readonly SerialScheduler _scheduler = new();
    private readonly ScriptedTransport _transport;
    private Server<string>? _server;

    // the transport runs on the test's clock, which every layer of the server takes
    public ServerTests()
    {
        _transport = new ScriptedTransport { Clock = _time };
    }

    // helpers

    private Server<string> Server
    {
        get
        {
            return _server!;
        }
    }

    private void Start(TimeSpan connectionInactivityTimeout)
    {
        Start(new ServerOptions { ConnectionInactivityTimeout = connectionInactivityTimeout });
    }

    private void Start(ServerOptions options)
    {
        _server = new Server<string>(
            _transport,
            options with
            {
                ResolverScheduler = _scheduler,
                Scheduler = _scheduler,
            });
        InteropService.Offer(Server);
    }

    // disposes the server within its test, so the test's end does not again
    private async Task<Server<string>> DisposeServer()
    {
        var server = Server;

        _server = null;
        await server.DisposeAsync();

        return server;
    }

    private async Task Deliver(Envelope envelope)
    {
        _transport.Deliver(EnvelopeCodec.WriteEnvelope(envelope));
        await _scheduler.WhenIdle();
    }

    private async Task Advance(TimeSpan by)
    {
        _time.Advance(by);
        await _scheduler.WhenIdle();
    }

    private static Envelope RequestOf(uint callId, (string ProcedureName, bool OpensSubscription) call)
    {
        return RequestOf(callId, call, "null");
    }

    private static Envelope RequestOf(uint callId, (string ProcedureName, bool OpensSubscription) call, string payload)
    {
        var procedure = InteropService.ProcedureOf(call.ProcedureName);

        return new Envelope
        {
            Header = new RequestHeader
            {
                CallId = callId,
                ServiceId = procedure.ServiceId,
                ProcedureId = procedure.ProcedureId,
                OpensSubscription = call.OpensSubscription,
            },
            Payload = Encoding.UTF8.GetBytes(payload),
        };
    }

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // what the clock command, which a client offers, fails with: asked of the connection with the
    // close on timeout given, of a client that never answers; it goes out at once
    private Task<Exception?> Asked(bool? closeOnTimeout)
    {
        var clock = Server.Services.GetCommand(
            InteropService.ProcedureOf("clock"),
            new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked });

        return Record.ExceptionAsync(() =>
        {
            return clock(JsonSerializer.SerializeToElement(0))(new RequestOptions
            {
                CloseOnTimeout = closeOnTimeout,
                ConnectionHandle = Handle,
                Timeout = CommandTimeout,
            });
        }).AsTask();
    }

    // what the clock command fails with once its timeout passed, unanswered
    private async Task<Exception?> Unanswered(bool? closeOnTimeout)
    {
        var asking = Asked(closeOnTimeout);

        await _scheduler.WhenIdle();
        await Advance(CommandTimeout);

        return await asking.WaitAsync(Patience, Cancelled);
    }

    // a request for echo, to destination 7 behind the server
    private static Envelope RelayedOf(uint callId)
    {
        var relayed = RequestOf(callId, ("echo", false));

        return new Envelope { Header = (RequestHeader)relayed.Header with { DestinationId = 7 }, Payload = relayed.Payload };
    }

    // a request for a procedure nobody answers
    private static Envelope UnknownRequestOf(uint callId)
    {
        return new Envelope
        {
            Header = new RequestHeader { CallId = callId, ServiceId = 1, ProcedureId = 99 },
            Payload = Encoding.UTF8.GetBytes("null"),
        };
    }

    // a token of 16 bytes of `value`
    private static SessionToken TokenOf(byte value)
    {
        var bytes = new byte[SessionToken.Bytes];

        Array.Fill(bytes, value);

        return SessionToken.FromBytes(bytes);
    }

    // definition

    public ValueTask InitializeAsync()
    {
        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        if (_server is not null)
        {
            await _server.DisposeAsync();
        }
    }

    [Fact]
    public async Task Ends_a_session_past_its_timeout_with_its_subscriptions_and_keeps_its_connection_for_its_own_timeout()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with
        {
            ConnectionInactivityTimeout = TimeSpan.FromSeconds(5),
            SessionInactivityTimeout = TimeSpan.FromSeconds(1),
        });
        await Deliver(RequestOf(1, ("ticks", true)));

        var answer = _transport.Read(0);

        Assert.Equal(new ResultHeader { CallId = 1, Session = Server.Sessions.SessionTokenOf(Handle) }, answer.Header);

        // the session timeout ends it, its subscription with SESSION_REQUIRED, the end announced
        await Advance(TimeSpan.FromSeconds(1));
        Assert.False(Server.Sessions.Has(Handle));

        var ended = _transport.Read(1);

        Assert.Equal(new FailureHeader { CallId = 1, Session = SessionAnnouncement.Ended }, ended.Header);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, ended.Failure!.Code);
        Assert.Empty(_transport.Closed);

        // the connection stays, then goes once silent past that session's connection timeout
        await Advance(TimeSpan.FromSeconds(5));
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public async Task Closes_a_session_s_connection_silent_past_its_connection_timeout_unless_it_speaks()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromSeconds(2) });

        await Advance(TimeSpan.FromSeconds(1.5));
        await Deliver(RequestOf(1, ("echo", false)));
        await Advance(TimeSpan.FromSeconds(1.5));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromSeconds(0.5));
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public async Task Closes_a_connection_without_a_session_silent_past_the_server_s_own_timeout()
    {
        Start(TimeSpan.FromSeconds(3));
        _transport.Open(Handle);

        await Advance(TimeSpan.FromSeconds(2));
        await Deliver(RequestOf(1, ("echo", false)));
        await Advance(TimeSpan.FromSeconds(2));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromSeconds(1));
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public async Task Ends_at_once_a_session_stored_for_a_connection_already_closed_and_with_a_connection_that_closes()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle));
        _transport.CloseFromPeer(Handle);
        await _scheduler.WhenIdle();
        Assert.False(Server.Sessions.Has(Handle));

        Server.Sessions.Set(Server.Sessions.Create(Handle));
        Assert.False(Server.Sessions.Has(Handle));
    }

    // no twin in server.test.ts: the TypeScript side shows this on its router's core and on its
    // announcements module (router-core.test.ts:1756, announcements.test.ts:91), a module this side
    // does not have; through a server is where it shows here
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Announces_again_a_session_the_answer_that_carried_it_did_not_deliver(bool isThrown)
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle));
        _transport.Failing = isThrown ? Failing.Thrown : Failing.Faulted;
        await Deliver(RequestOf(1, ("echo", false)));
        Assert.Empty(_transport.Sent);

        await Deliver(RequestOf(3, ("echo", false)));
        Assert.Equal(new ResultHeader { CallId = 3, Session = Server.Sessions.SessionTokenOf(Handle) }, _transport.Read(0).Header);
    }

    // no twin in server.test.ts: the TypeScript side shows this on its router's core and on its
    // announcements module (router-core.test.ts:1831, announcements.test.ts:122), a module this side
    // does not have; through a server is where it shows here
    [Fact]
    public async Task Forgets_what_a_connection_was_told_once_it_closed()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("login", false), "{\"name\":\"ada\"}"));
        Assert.NotNull(((ResultHeader)_transport.Read(0).Header).Session);

        // a connection of the same handle, with no session, was told nothing: its answer announces nothing
        _transport.CloseFromPeer(Handle);
        _transport.Open(Handle);
        await Deliver(RequestOf(3, ("echo", false)));
        Assert.Equal(new ResultHeader { CallId = 3 }, _transport.Read(1).Header);
    }

    [Fact]
    public async Task Builds_each_layer_on_the_one_under_it_the_router_with_the_sessions_tokens()
    {
        // the TypeScript side builds each layer by a factory a test may give, which this side does
        // not take: what it builds, and how, is what shows here
        Start(new ServerOptions { Limits = new RouterLimits { MaximumPayloadBytes = 8 } });

        Assert.Same(_transport, Server.Transport);
        Assert.Same(_transport, Server.Router.Transport);
        Assert.Equal(new RouterLimits { MaximumPayloadBytes = 8 }, Server.Router.Limits);

        // the router reads each connection's token from the sessions
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { SessionToken = TokenOf(4) });
        await Deliver(RequestOf(1, ("echo", false)));
        Assert.Equal(new ResultHeader { CallId = 1, Session = TokenOf(4) }, _transport.Read(0).Header);
    }

    [Fact]
    public void RequireSession_refuses_a_connection_without_a_session_with_SESSION_REQUIRED()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);

        var request = new AdmissionRequest(Handle, (RequestHeader)RequestOf(1, ("whoami", false)).Header);

        Assert.False(Server.RequireSession.Admits(request));
        Assert.Equal(Failure.OfProtocol(ProtocolCode.SessionRequired), Server.RequireSession.Refusal);

        Server.Sessions.Set(Server.Sessions.Create(Handle));
        Assert.True(Server.RequireSession.Admits(request));
    }

    [Fact]
    public async Task Each_message_is_activity_a_connection_that_speaks_keeps_going_a_silent_one_is_closed()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(80) });

        // requests for a procedure nobody answers, and a message that is not an envelope: activity
        // all the same
        await Advance(TimeSpan.FromMilliseconds(40));
        await Deliver(UnknownRequestOf(1));
        await Advance(TimeSpan.FromMilliseconds(40));
        _transport.Deliver([0x0A, 0x02]);
        await _scheduler.WhenIdle();
        await Advance(TimeSpan.FromMilliseconds(40));
        await Deliver(UnknownRequestOf(3));
        Assert.Empty(_transport.Closed);
        Assert.True(Server.Sessions.Has(Handle));

        await Advance(TimeSpan.FromMilliseconds(79));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public async Task A_connection_that_never_opens_a_session_is_never_closed_when_the_server_says_nothing()
    {
        // the other half of server.test.ts:444, whose first is
        // Closes_a_connection_without_a_session_silent_past_the_server_s_own_timeout
        Start(new ServerOptions());
        _transport.Open(Handle);

        await Advance(TimeSpan.FromDays(1));
        await Deliver(UnknownRequestOf(1));
        await Advance(TimeSpan.FromDays(1));
        Assert.Empty(_transport.Closed);
        Assert.Empty(Server.Sessions.GetAll());
    }

    [Fact]
    public async Task A_close_that_finds_the_connection_gone_already_takes_its_session_all_the_same()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        _transport.CloseResult = false;
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(20) });

        await Advance(TimeSpan.FromMilliseconds(20));
        Assert.Equal([Handle], _transport.Closed);
        Assert.False(Server.Sessions.Has(Handle));
    }

    [Fact]
    public async Task Relays_as_its_options_say_its_own_admission_and_timeout_kept_require_session_where_it_gives_none()
    {
        const string device = "type=WS;ip=127.0.0.1;port=50002";
        var admitting = new BeforeRequest((_) =>
        {
            return true;
        });

        // its own admission relays a connection without a session; its timeout ends leg B, lost
        Start(new ServerOptions { Relay = new RelayOptions { BeforeRoute = admitting, Timeout = TimeSpan.FromMilliseconds(250) } });
        _transport.Open(Handle);
        _transport.Open(device);
        Assert.Empty(Server.Router.Destinations());
        Server.Router.RegisterDestination(new ConnectionTarget(device), new DestinationOptions { DestinationId = 7 });
        await Deliver(RelayedOf(1));
        Assert.IsType<RequestHeader>(_transport.Read(0).Header);
        await Advance(TimeSpan.FromMilliseconds(250));

        var lost = _transport.Read(_transport.Sent.Count - 1);

        Assert.Equal(new FailureHeader { CallId = 1 }, lost.Header);
        Assert.Equal((ushort)ProtocolCode.DestinationLost, lost.Failure!.Code);

        // none of its own: the server's RequireSession
        await DisposeServer();
        _transport.Sent.Clear();
        Start(new ServerOptions { Relay = new RelayOptions { Timeout = TimeSpan.FromMilliseconds(250) } });
        _transport.Open(Handle);
        _transport.Open(device);
        Server.Router.RegisterDestination(new ConnectionTarget(device), new DestinationOptions { DestinationId = 7 });
        await Deliver(RelayedOf(1));
        Assert.Equal((ushort)ProtocolCode.SessionRequired, Assert.Single(_transport.Sent.Select((_, index) =>
        {
            return _transport.Read(index).Failure!.Code;
        })));
    }

    [Fact]
    public async Task Counts_each_layer_set_against_the_connections_it_holds_when_its_transport_counts_none_back_to_nothing_as_each_closes()
    {
        Start(TimeSpan.FromHours(1));
        _transport.Open(Handle);
        await _scheduler.WhenIdle();

        // no session yet: idle, until its timeout closes it
        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 1, ["idle"] = 1 }, (await Server.Gauges()).Server.Counts);
        Server.Sessions.Set(Server.Sessions.Create(Handle));

        var gauges = await Server.Gauges();

        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 1, ["idle"] = 0 }, gauges.Server.Counts);
        Assert.Equal(new Dictionary<string, long> { ["sessions"] = 1, ["timedConnections"] = 1 }, gauges.Sessions.Counts);
        Assert.Empty(gauges.Transport.Counts);
        Assert.All([gauges.Router, gauges.Server, gauges.Sessions, gauges.Transport], (layer) =>
        {
            Assert.Equal((0, 0), (layer.Anomalies.Count, layer.Orphans));
        });
        Assert.Equal((1, 0), (gauges.Router.Counts["connections"], gauges.Router.Counts["pendingCalls"]));
        Assert.Equal(HealthStatus.Pass, (await Server.Health()).Status);
        _transport.CloseFromPeer(Handle);
        await _scheduler.WhenIdle();
        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 0, ["idle"] = 0 }, (await Server.Gauges()).Server.Counts);
        Assert.Equal(new Dictionary<string, long> { ["sessions"] = 0, ["timedConnections"] = 0 }, (await Server.Gauges()).Sessions.Counts);
        Assert.Equal(HealthStatus.Pass, (await Server.Health()).Status);
    }

    // the TypeScript side keeps a connection the transport does not hold by a session timer set by
    // hand, which this side's sessions do not let out: a transport that counts fewer does it here
    [Fact]
    public async Task Fails_what_a_layer_keeps_for_a_connection_the_transport_does_not_hold_and_says_why()
    {
        Start(new ServerOptions());
        _transport.Counted = new HashSet<string>();
        _transport.Open(Handle);
        await _scheduler.WhenIdle();

        var (checks, status) = await Server.Health();

        Assert.Equal(HealthStatus.Fail, status);
        Assert.Equal(
            [new HealthCheck(1, HealthStatus.Fail, "1 connections kept that the transport no longer holds")],
            checks["server:orphans"]);
        Assert.Equal([new HealthCheck(1, HealthStatus.Fail, "1 connections kept that the transport no longer holds")], checks["router:orphans"]);
        Assert.Equal(new Dictionary<string, long> { ["connections"] = 0 }, (await Server.Gauges()).Transport.Counts);
        _transport.Counted = new HashSet<string> { Handle };
        Assert.Equal(HealthStatus.Pass, (await Server.Health()).Status);
    }

    [Fact]
    public void A_transport_counts_nothing_unless_it_says_so()
    {
        Assert.Null(((IServerTransport)new Uncounted()).Gauges());
    }

    [Fact]
    public async Task A_command_whose_timeout_passes_is_cancelled_before_its_connection_is_closed()
    {
        Start(new ServerOptions { CloseOnCommandTimeout = true });
        _transport.Open(Handle);

        Assert.IsType<TimeoutException>(await Unanswered(null));
        await _scheduler.WhenIdle();
        Assert.Equal(
            ["cancel", "close"],
            _transport.Steps.Where((step) =>
            {
                return step != "other";
            }));
    }

    [Fact]
    public async Task A_connection_is_asked_to_close_once_however_many_times_it_earns_it()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Start(new ServerOptions { CloseOnCommandTimeout = true });
        _transport.CloseHold = release.Task;
        _transport.Open(Handle);

        Task<Exception?>[] asking = [Asked(null), Asked(null)];

        await _scheduler.WhenIdle();
        await Advance(CommandTimeout);
        await Task.WhenAll(asking).WaitAsync(Patience, Cancelled);
        Assert.Equal([Handle], _transport.Closed);

        release.SetResult();
    }

    [Fact]
    public async Task A_command_unanswered_in_time_closes_its_connection_as_the_server_default_or_the_command_says()
    {
        Start(new ServerOptions { CloseOnCommandTimeout = true });

        // a connection the router knows, which never answers
        _transport.Open(Handle);

        Assert.IsType<TimeoutException>(await Unanswered(null));
        Assert.IsType<TimeoutException>(await Unanswered(false));
        await _scheduler.WhenIdle();
        Assert.Equal([Handle], _transport.Closed);

        await DisposeServer();
        _transport.Closed.Clear();
        Start(new ServerOptions());
        _transport.Open(Handle);

        await Unanswered(null);
        await _scheduler.WhenIdle();
        Assert.Empty(_transport.Closed);

        await Unanswered(true);
        await _scheduler.WhenIdle();
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public async Task A_connection_that_closes_takes_its_session_and_a_close_that_fails_is_reported()
    {
        var errors = new List<(Exception Reason, string ConnectionHandle)>();
        var refused = new IOException("refused");

        Start(Timeout.InfiniteTimeSpan);
        Server.Router.Error += (reason, connectionHandle) =>
        {
            errors.Add((reason, connectionHandle));
        };
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(30) });
        _transport.CloseFromPeer(Handle);
        Assert.False(Server.Sessions.Has(Handle));

        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { ConnectionInactivityTimeout = TimeSpan.FromMilliseconds(30) });
        _transport.CloseFailure = refused;
        await Advance(TimeSpan.FromMilliseconds(30));
        Assert.Equal([(refused, Handle)], errors);
    }

    [Fact]
    public async Task A_resolver_that_finishes_after_dispose_stores_nothing()
    {
        // the first half of server.test.ts:665, the session events the server lets go of, is not
        // shown: a C# event tells nobody outside its class who listens
        var gated = new Procedure { ServiceId = 2, ProcedureId = 1, ProcedureName = "gated", ServiceRevision = 1 };
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stored = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        Start(Timeout.InfiniteTimeSpan);

        var sessions = Server.Sessions;
        var dependencies = new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = InteropService.Json };

        Server.Services.GetRequestResolver(gated, dependencies)(async (request, _) =>
        {
            // a credential check, say, while the server goes
            await gate.Task;

            try
            {
                sessions.Set(sessions.Create(request.ConnectionHandle));
                stored.SetResult(true);
            }
            catch (DisconnectException)
            {
                stored.SetResult(false);
            }
        });
        _transport.Open(Handle);
        await Deliver(new Envelope
        {
            Header = new RequestHeader { CallId = 1, ServiceId = gated.ServiceId, ProcedureId = gated.ProcedureId },
            Payload = Encoding.UTF8.GetBytes("null"),
        });
        await DisposeServer();
        gate.SetResult();

        Assert.False(await stored.Task.WaitAsync(TestContext.Current.CancellationToken));
        Assert.Empty(sessions.GetAll());
    }

    [Fact]
    public void Limits_that_do_not_hold_together_refuse_the_server_which_leaves_nothing_on_its_transport()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            return new Server<string>(_transport, new ServerOptions { Limits = new RouterLimits { ChunkBytes = 63 } });
        });
        Assert.Equal(0, _transport.Subscribers);
    }

    [Fact]
    public async Task Builds_its_sessions_with_their_own_options_on_its_transport_s_clock()
    {
        Start(new ServerOptions
        {
            ConnectionInactivityTimeout = Timeout.InfiniteTimeSpan,
            ResolverScheduler = _scheduler,
            Scheduler = _scheduler,
            Sessions = new SessionManagerOptions { SessionInactivityTimeout = TimeSpan.FromSeconds(3) },
        });
        _transport.Open(Handle);

        var session = Server.Sessions.Set(Server.Sessions.Create(Handle) with { SessionInactivityTimeout = TimeSpan.Zero });

        // the default of its own options, timed by the server's clock
        Assert.Equal(TimeSpan.FromSeconds(3), session.SessionInactivityTimeout);
        await Advance(TimeSpan.FromSeconds(3));
        Assert.False(Server.Sessions.Has(Handle));
    }

    [Fact]
    public void Runs_every_layer_on_its_transport_s_clock_and_refuses_another_which_leaves_nothing_on_its_transport()
    {
        Start(new ServerOptions { Clock = _time });

        var subscribers = _transport.Subscribers;

        Assert.Same(_time, Server.Clock);
        Assert.Same(_time, Server.Router.Clock);
        Assert.Same(_time, Server.Sessions.Clock);

        var other = new FakeTimeProvider();
        var refusal = Assert.Throws<ArgumentException>(() =>
        {
            return new Server<string>(_transport, new ServerOptions { Clock = other });
        });

        Assert.Equal(
            "a server runs on the clock of its transport, a FakeTimeProvider, and was given another, a FakeTimeProvider",
            refusal.Message);
        Assert.Throws<ArgumentException>(() =>
        {
            return new Server<string>(_transport, new ServerOptions { Sessions = new SessionManagerOptions { Clock = other } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new Server<string>(new ScriptedTransport(), new ServerOptions { Clock = _time });
        });

        // what the server started with is all it holds
        Assert.Equal(subscribers, _transport.Subscribers);
    }

    [Fact]
    public void Refuses_an_inactivity_timeout_past_the_longest_timer_as_it_is_built_which_leaves_nothing_on_its_transport()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new Server<string>(_transport, new ServerOptions { ConnectionInactivityTimeout = Clocks.LongestTimer + TimeSpan.FromMilliseconds(1) });
        });
        Assert.Equal(0, _transport.Subscribers);
    }

    [Fact]
    public async Task Answers_slow_once_its_server_s_clock_passed_its_wait_never_before()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("slow", false), "{\"milliseconds\":50}"));
        await Advance(TimeSpan.FromMilliseconds(49));
        Assert.Empty(_transport.Sent);
        await Advance(TimeSpan.FromMilliseconds(1));
        await _scheduler.WhenIdle();
        Assert.Equal(new ResultHeader { CallId = 1 }, _transport.Read(0).Header);
    }

    [Fact]
    public async Task Closes_a_connection_silent_for_the_longest_timer_at_its_due()
    {
        Start(Clocks.LongestTimer);
        _transport.Open(Handle);

        await Advance(Clocks.LongestTimer - TimeSpan.FromMilliseconds(1));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Handle], _transport.Closed);
    }

    [Fact]
    public void Refuses_a_negative_inactivity_timeout_as_it_is_built_which_leaves_nothing_on_its_transport()
    {
        // C# only: the TypeScript side's timer fires at once for a negative delay, where a .NET timer
        // throws, which would stop the transport's handlers for the first connection
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new Server<string>(_transport, new ServerOptions { ConnectionInactivityTimeout = TimeSpan.FromSeconds(-2) });
        });
        Assert.Equal(0, _transport.Subscribers);
    }

    [Fact]
    public async Task Dispose_stops_the_timer_of_a_connection_with_no_session_nothing_is_closed_after_it()
    {
        Start(TimeSpan.FromMilliseconds(20));
        _transport.Open(Handle);
        await DisposeServer();
        await Advance(TimeSpan.FromMilliseconds(50));
        Assert.Empty(_transport.Closed);
    }

    [Fact]
    public async Task Dispose_lets_go_of_the_transport_rejects_what_waits_forgets_the_sessions_and_stops()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("login", false), "{\"name\":\"ada\"}"));

        var clock = Server.Services.GetCommand(
            InteropService.ProcedureOf("clock"),
            new RequestDependencies<JsonElement, JsonElement> { Serializer = InteropService.JsonAsked });
        var waiting = clock(JsonSerializer.SerializeToElement("ping"))(new RequestOptions { ConnectionHandle = Handle });

        await _scheduler.WhenIdle();

        var server = await DisposeServer();

        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return waiting.WaitAsync(TestContext.Current.CancellationToken);
        });
        Assert.False(server.Sessions.Has(Handle));
        Assert.Equal(1, _transport.Shutdowns);
        Assert.Equal(0, _transport.Subscribers);
        Assert.Throws<DisconnectException>(() =>
        {
            return server.Sessions.Set(server.Sessions.Create(Handle));
        });
    }

    [Fact]
    public async Task An_ordinary_request_to_the_procedure_of_a_subscription_held_moves_nothing_notify_still_reaches_it()
    {
        // its TypeScript twin, ws-server.test.ts:975, runs over a WebSocket: the scripted transport
        // stands in for it
        var errors = new List<Exception>();

        Start(Timeout.InfiniteTimeSpan);
        Server.Router.Error += (reason, _) =>
        {
            errors.Add(reason);
        };
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("ticks", true)));

        // an ordinary request subscribes nothing: its callback cannot, and fails if it tries
        await Deliver(RequestOf(3, ("ticks", false)));
        await Deliver(RequestOf(5, ("ticks", false), "{\"hold\":1}"));
        await Deliver(RequestOf(7, ("tick", false), "{\"value\":1}"));

        var failed = _transport.Read(2);

        Assert.Equal(new ResultHeader { CallId = 1 }, _transport.Read(0).Header);
        Assert.Equal(new ResultHeader { CallId = 3 }, _transport.Read(1).Header);
        Assert.Equal(new FailureHeader { CallId = 5 }, failed.Header);
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, failed.Failure!.Code);
        Assert.Equal(new NotificationHeader { CallId = 1 }, _transport.Read(3).Header);
        Assert.Equal(new ResultHeader { CallId = 7 }, _transport.Read(4).Header);
        Assert.Equal(5, _transport.Sent.Count);
        Assert.IsType<InvalidOperationException>(Assert.Single(errors));
    }

    // how the next send fails, once
    private enum Failing
    {
        None,
        Thrown,
        Faulted,
    }

    // a transport of one connection, which records what it sends, what it is asked to close, and
    // how often it is stopped
    private sealed class ScriptedTransport : IServerTransport
    {
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public List<ReadOnlyMemory<byte>> Sent { get; } = [];

        public List<string> Closed { get; } = [];

        // what it did, in order: each envelope it sent — a cancel, or other — and each close it was asked
        public List<string> Steps { get; } = [];

        public Failing Failing { get; set; }

        // what a close resolves to: false for a connection the transport no longer holds
        public bool CloseResult { get; set; } = true;

        // what a close throws, when set
        public Exception? CloseFailure { get; set; }

        // what a close waits on before it settles, when set
        public Task? CloseHold { get; set; }

        // the connections it says it holds, when it counts them; none, for a transport that counts nothing
        public IReadOnlySet<string>? Counted { get; set; }

        public int Shutdowns { get; private set; }

        // the handlers on its three events
        public int Subscribers
        {
            get
            {
                return (Connection?.GetInvocationList().Length ?? 0)
                    + (Message?.GetInvocationList().Length ?? 0)
                    + (Close?.GetInvocationList().Length ?? 0);
            }
        }

        public void Open(string connectionHandle)
        {
            Connection?.Invoke(connectionHandle);
        }

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false), Handle);
        }

        public void CloseFromPeer(string connectionHandle)
        {
            Close?.Invoke(false, connectionHandle);
        }

        public Envelope Read(int index)
        {
            return EnvelopeCodec.ReadEnvelope(Sent[index].Span, new EnvelopeReadOptions { Side = RouterSide.Client })!;
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            var failing = Failing;

            Failing = Failing.None;

            return failing switch
            {
                Failing.Thrown => throw new IOException("the transport refused it at once"),
                Failing.Faulted => Task.FromException(new IOException("the transport could not send it")),
                _ => Record(bytes.ToArray()),
            };
        }

        private Task Record(byte[] bytes)
        {
            Sent.Add(bytes);
            Steps.Add(EnvelopeCodec.ReadEnvelope(bytes, new EnvelopeReadOptions { Side = RouterSide.Client })?.Header is CancelHeader ? "cancel" : "other");

            return Task.CompletedTask;
        }

        public async Task<bool> CloseConnection(string connectionHandle)
        {
            Closed.Add(connectionHandle);
            Steps.Add("close");

            if (CloseHold is { } hold)
            {
                await hold;
            }

            if (CloseFailure is { } failure)
            {
                throw failure;
            }

            return CloseResult;
        }

        public Task Shutdown()
        {
            Shutdowns += 1;

            return Task.CompletedTask;
        }

        public Gauges? Gauges()
        {
            return Counted is { } counted ? Bead.Gauges.Of(new Dictionary<string, long> { ["connections"] = counted.Count }, counted) : null;
        }
    }

    // a transport that counts nothing: the server's own connections stand for its
    private sealed class Uncounted : IServerTransport
    {
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<string>? Connection
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<TransportMessage, string>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, string>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return Task.CompletedTask;
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }
    }
}
