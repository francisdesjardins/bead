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

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

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
        InteropHandlers.Offer(Server);
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
        var procedure = InteropProcedures.All.Single((described) =>
        {
            return described.Procedure.ProcedureName == call.ProcedureName;
        }).Procedure;

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
            InteropProcedures.Clock.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });

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
    public async Task Ends_a_session_past_its_timeout_with_its_subscriptions_and_keeps_its_connection_for_the_server_s_own_timeout_counted_from_its_end()
    {
        Start(TimeSpan.FromSeconds(3));
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle) with
        {
            ConnectionInactivityTimeout = TimeSpan.FromSeconds(5),
            SessionInactivityTimeout = TimeSpan.FromSeconds(1),
        });
        await Deliver(RequestOf(1, ("ticks", true)));

        var answer = _transport.Read(0);

        Assert.Equal(new ResultHeader { CallId = 1, Credential = Server.Sessions.SessionTokenOf(Handle) }, answer.Header);

        // the session timeout ends it, its subscription with SESSION_REQUIRED, the end announced
        await Advance(TimeSpan.FromSeconds(1));
        Assert.False(Server.Sessions.Has(Handle));

        var ended = _transport.Read(1);

        Assert.Equal(new FailureHeader { CallId = 1, Credential = Credential.None }, ended.Header);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, ended.Failure!.Code);
        Assert.Empty(_transport.Closed);

        // the connection stays, then goes once silent past the server's own timeout, not the
        // session's
        await Advance(TimeSpan.FromSeconds(3) - TimeSpan.FromMilliseconds(1));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
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
    public async Task A_listen_held_is_no_silence_a_connection_with_no_session_is_not_closed_while_one_is_and_is_closed_the_server_s_own_timeout_after_the_last_ends()
    {
        Start(TimeSpan.FromMilliseconds(60));
        _transport.Open(Handle);
        await Advance(TimeSpan.FromMilliseconds(40));
        _transport.Listening(true);

        // held: no timer runs, a message meanwhile arms none, and a second listen said before the
        // first ends keeps the connection held
        await Deliver(UnknownRequestOf(1));
        await Advance(TimeSpan.FromSeconds(1));
        _transport.Listening(true);
        _transport.Listening(false);
        await Advance(TimeSpan.FromSeconds(1));
        Assert.Equal((0, 1L), (_transport.Closed.Count, (await Server.Gauges()).Server.Counts["listening"]));

        // the last ends: the silence counts anew from it
        _transport.Listening(false);
        await Advance(TimeSpan.FromMilliseconds(59));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Handle], _transport.Closed);
        Assert.Equal(0, (await Server.Gauges()).Server.Counts["listening"]);
    }

    [Fact]
    public async Task A_listen_held_is_no_silence_for_a_session_s_connection_timeout_either_a_message_meanwhile_restarts_its_session_timer_alone_and_the_listen_s_end_counts_anew()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);

        // a session opened while a listen is held, as a client over HTTP logs in: its session timer alone
        _transport.Listening(true);
        await Deliver(RequestOf(1, ("login", false), "{\"name\":\"ada\",\"connectionTimeout\":100,\"sessionTimeout\":1000}"));

        // a message, and a session opened anew, each restart the session timer alone
        await Advance(TimeSpan.FromMilliseconds(200));
        await Deliver(UnknownRequestOf(3));
        await Deliver(RequestOf(5, ("login", false), "{\"name\":\"bob\",\"connectionTimeout\":100,\"sessionTimeout\":1000}"));

        var lastActivity = Server.Sessions.Get(Handle)!.LastActivity;

        await Advance(TimeSpan.FromMilliseconds(400));
        Assert.Empty(_transport.Closed);

        // the listen's end starts the connection timer from it, and leaves the session timer and the
        // session's activity to the messages: a listen is no message
        _transport.Listening(false);
        Assert.Equal(lastActivity, Server.Sessions.Get(Handle)!.LastActivity);
        await Advance(TimeSpan.FromMilliseconds(99));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Handle], _transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(499));
        Assert.True(Server.Sessions.Has(Handle));
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.False(Server.Sessions.Has(Handle));
    }

    [Fact]
    public async Task A_session_s_session_timeout_ends_its_session_while_a_listen_is_held_its_subscription_s_failure_goes_out_and_the_connection_stays_held()
    {
        Start(TimeSpan.FromMilliseconds(60));
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("login", false), "{\"name\":\"ada\",\"connectionTimeout\":100,\"sessionTimeout\":30}"));
        await Deliver(RequestOf(3, ("ticks", true)));
        _transport.Listening(true);
        await Advance(TimeSpan.FromMilliseconds(30));

        // over HTTP, the failure is what the listen held brings back
        var ended = _transport.Read(2);

        Assert.Equal(new FailureHeader { CallId = 3, Credential = Credential.None }, ended.Header);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, ended.Failure!.Code);
        Assert.False(Server.Sessions.Has(Handle));
        await Advance(TimeSpan.FromSeconds(1));
        Assert.Empty(_transport.Closed);

        // the listen's end: the server's own timeout, the session gone
        _transport.Listening(false);
        await Advance(TimeSpan.FromMilliseconds(59));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
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
        Assert.Equal(new ResultHeader { CallId = 3, Credential = Server.Sessions.SessionTokenOf(Handle) }, _transport.Read(0).Header);
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
        Assert.NotNull(((ResultHeader)_transport.Read(0).Header).Credential);

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
        Assert.Equal(new ResultHeader { CallId = 1, Credential = TokenOf(4) }, _transport.Read(0).Header);
    }

    [Fact]
    public void RequireSession_refuses_a_call_in_none_with_SESSION_REQUIRED_testing_the_call_s_session_never_its_connection_s()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        Server.Sessions.Set(Server.Sessions.Create(Handle));

        var request = new AdmissionRequest(Handle, (RequestHeader)RequestOf(1, ("whoami", false)).Header);

        // the call's session, never its connection's
        Assert.False(Server.RequireSession.Admits(request));
        Assert.Equal(Failure.OfProtocol(ProtocolCode.SessionRequired), Server.RequireSession.Refusal);
        Assert.True(Server.RequireSession.Admits(request with { Session = new CallSession() }));
    }

    [Fact]
    public void Each_server_is_an_IBeadServer_with_RequireSessionOrCredential()
    {
        Start(Timeout.InfiniteTimeSpan);

        var server = Assert.IsAssignableFrom<IBeadServer<string>>(Server);

        Assert.Same(_transport, server.Transport);
        Assert.Same(Server.RequireSessionOrCredential, server.RequireSessionOrCredential);
        Assert.Same(Server.RequireSession, server.RequireSession);
        Assert.Same(Server.Services, server.Services);
    }

    [Fact]
    public async Task A_request_runs_in_its_connection_s_session_presenting_none_or_its_token_as_OPAQUE_the_session_s_data_a_copy_the_call_keeps_another_token_is_refused_SESSION_REQUIRED_whatever_its_procedure_requires()
    {
        static Envelope Presenting(Envelope request, Credential credential)
        {
            return new Envelope { Header = (RequestHeader)request.Header with { Credential = credential }, Payload = request.Payload };
        }

        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);

        var token = Server.Sessions.Set(Server.Sessions.Create(Handle) with { Data = "ada" }).SessionToken!.Value;

        await Deliver(RequestOf(1, ("whoami", false)));
        await Deliver(Presenting(RequestOf(3, ("whoami", false)), token));

        // another token, and the token of a session drawn anew, do not hold, whatever the
        // procedure requires
        await Deliver(Presenting(RequestOf(5, ("echo", false)), SessionToken.Parse("AQIDBAUGBwgJCgsMDQ4PEA")));
        Server.Sessions.Set(Server.Sessions.Create(Handle) with { Data = "bob" });
        await Deliver(Presenting(RequestOf(7, ("echo", false)), token));

        // the call keeps the data it resolved with, whatever its session holds after
        var released = new TaskCompletionSource();
        var held = new Procedure { ServiceId = 2, ProcedureId = 1, ProcedureName = "held", ServiceRevision = 1 };

        Server.Services.GetRequestResolver(held, new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() })(async (request, response) =>
        {
            await released.Task;
            await response.Answer(JsonSerializer.SerializeToElement(request.Session?.Data));
        });

        var bob = Server.Sessions.Get(Handle)!;

        await Deliver(new Envelope { Header = new RequestHeader { CallId = 9, ServiceId = 2, ProcedureId = 1 }, Payload = Encoding.UTF8.GetBytes("null") });
        Server.Sessions.UpdateData(bob with { Data = "eve" });
        released.SetResult();
        await _scheduler.WhenIdle();

        Assert.Equal(
            ["1 \"ada\"", "3 \"ada\"", "5 failure 32", "7 failure 32", "9 \"bob\""],
            Enumerable.Range(0, 5).Select((index) =>
            {
                var envelope = _transport.Read(index);

                return envelope.Failure is { } failure
                    ? $"{envelope.Header.CallId} failure {failure.Code}"
                    : $"{envelope.Header.CallId} {Encoding.UTF8.GetString(envelope.Payload.Span)}";
            }));
    }

    [Fact]
    public async Task A_call_presenting_its_connection_s_OPAQUE_and_one_presenting_none_hold_one_subscription_to_a_procedure_the_connection_s_session_s()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);

        var token = Server.Sessions.Set(Server.Sessions.Create(Handle)).SessionToken!.Value;
        var subscribing = RequestOf(1, ("ticks", true));

        await Deliver(new Envelope { Header = (RequestHeader)subscribing.Header with { Credential = token }, Payload = subscribing.Payload });
        await Deliver(RequestOf(3, ("ticks", true)));
        await Deliver(RequestOf(5, ("tick", false), "{\"value\":7}"));

        // the second is answered, and holds nothing: the tick goes on the first's call id alone
        Assert.Equal(
            ["Result 1", "Result 3", "Notification 1", "Result 5"],
            Enumerable.Range(0, _transport.Sent.Count).Select((index) =>
            {
                var envelope = _transport.Read(index);

                return $"{envelope.Kind} {envelope.Header.CallId}";
            }));
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
    public void Admits_a_call_with_a_session_its_call_s_whatever_its_header_presents_and_refuses_one_in_none_SESSION_REQUIRED()
    {
        Start(new ServerOptions());

        var requireSession = Server.RequireSession;
        var header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1 };
        var inSession = new AdmissionRequest(Handle, header) { Session = new CallSession() };

        Assert.True(requireSession.Admits(inSession));
        Assert.True(requireSession.Admits(inSession with { Header = header with { Credential = Credential.Jwt("a.b.c") } }));
        Assert.False(requireSession.Admits(new AdmissionRequest(Handle, header)));
        Assert.False(requireSession.Admits(new AdmissionRequest(Handle, header with { Credential = Credential.Jwt("a.b.c") })));
        Assert.Equal((ushort)ProtocolCode.SessionRequired, requireSession.Refusal!.Code);
    }

    [Fact]
    public void Admits_a_call_in_a_session_or_presenting_a_JWT_or_an_ELSEWHERE_by_its_scheme_alone_and_refuses_any_other_in_none_SESSION_REQUIRED()
    {
        Start(new ServerOptions());

        var requireSessionOrCredential = Server.RequireSessionOrCredential;
        var header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1 };
        var inNone = new AdmissionRequest(Handle, header);

        Assert.True(requireSessionOrCredential.Admits(inNone with { Session = new CallSession() }));
        Assert.True(requireSessionOrCredential.Admits(inNone with { Header = header with { Credential = Credential.Jwt("not even a token") } }));
        Assert.True(requireSessionOrCredential.Admits(inNone with { Header = header with { Credential = Credential.Elsewhere() } }));
        Assert.False(requireSessionOrCredential.Admits(inNone));
        Assert.False(requireSessionOrCredential.Admits(inNone with { Header = header with { Credential = Credential.Opaque(SessionToken.FromBytes(new byte[16] { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 })) } }));
        Assert.Equal((ushort)ProtocolCode.SessionRequired, requireSessionOrCredential.Refusal!.Code);
    }

    [Fact]
    public async Task Relays_as_its_options_say_its_own_admission_and_timeout_kept_requireSessionOrCredential_where_it_gives_none()
    {
        const string device = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";
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

        // none of its own: the server's RequireSessionOrCredential, which refuses a call in none, and
        // lets a JWT by on its scheme alone, for its destination to verify — one of no audience here
        await DisposeServer();
        _transport.Sent.Clear();
        Start(new ServerOptions { Relay = new RelayOptions { Timeout = TimeSpan.FromMilliseconds(250) } });
        _transport.Open(Handle);
        _transport.Open(device);
        Server.Router.RegisterDestination(new ConnectionTarget(device), new DestinationOptions { DestinationId = 7 });
        await Deliver(RelayedOf(1));

        var jwt = RelayedOf(3);

        await Deliver(new Envelope { Header = (RequestHeader)jwt.Header with { Credential = Credential.Jwt("a.b.c") }, Payload = jwt.Payload });
        Assert.Equal(
            [(ushort)ProtocolCode.SessionRequired, (ushort)ProtocolCode.DestinationUnreachable],
            _transport.Sent.Select((_, index) =>
            {
                return _transport.Read(index).Failure!.Code;
            }));
    }

    [Fact]
    public async Task Counts_each_layer_set_against_the_connections_it_holds_when_its_transport_counts_none_back_to_nothing_as_each_closes()
    {
        Start(TimeSpan.FromHours(1));
        _transport.Open(Handle);
        await _scheduler.WhenIdle();

        // no session yet: idle, until its timeout closes it
        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 1, ["idle"] = 1, ["listening"] = 0 }, (await Server.Gauges()).Server.Counts);
        Server.Sessions.Set(Server.Sessions.Create(Handle));

        var gauges = await Server.Gauges();

        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 1, ["idle"] = 0, ["listening"] = 0 }, gauges.Server.Counts);
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
        Assert.Equal(new Dictionary<string, long> { ["closing"] = 0, ["connections"] = 0, ["idle"] = 0, ["listening"] = 0 }, (await Server.Gauges()).Server.Counts);
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
    public void Hears_its_transport_s_error_and_refusal_through_the_server_s_transport()
    {
        Start(Timeout.InfiniteTimeSpan);

        var thrown = new InvalidOperationException("a listener that throws");
        var refusal = new TransportServerRefusal("127.0.0.1", "rebind.example:8080", null, 50_000, "host-refused", 403);
        var heard = new List<string>();

        // the server gives its transport as IServerTransport, which carries both, whichever
        // transport it was built on: no listener on the concrete transport is needed
        Server.Transport.Error += (reason, connectionHandle) =>
        {
            heard.Add($"error {reason.Message} on {connectionHandle}");
        };
        Server.Transport.Refusal += (told) =>
        {
            heard.Add($"refusal {told.Status} {told.Reason} of {told.Authority}");
        };

        _transport.Report(thrown, Handle);
        _transport.Refuse(refusal);
        // a refusal's listener's throw, reported with the empty handle
        _transport.Report(thrown, string.Empty);

        Assert.Equal(
            [
                $"error a listener that throws on {Handle}",
                "refusal 403 host-refused of rebind.example:8080",
                "error a listener that throws on ",
            ],
            heard);
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
        var errors = new List<(Exception Reason, string? ConnectionHandle)>();
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
        var dependencies = new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() };

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

        var session = Server.Sessions.Set(Server.Sessions.Create(Handle) with { SessionInactivityTimeout = null });

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

    [Theory]
    [InlineData(1)]
    [InlineData(int.MaxValue)]
    public async Task Closes_a_connection_silent_for_a_millisecond_or_the_longest_timer_at_its_due(int milliseconds)
    {
        var timeout = TimeSpan.FromMilliseconds(milliseconds);

        Start(timeout);
        _transport.Open(Handle);

        await Advance(timeout - TimeSpan.FromMilliseconds(1));
        Assert.Empty(_transport.Closed);
        await Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Handle], _transport.Closed);
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
    public async Task Counts_no_close_under_way_once_disposed()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Start(TimeSpan.FromMilliseconds(20));
        _transport.CloseHold = release.Task;
        _transport.Open(Handle);
        await Advance(TimeSpan.FromMilliseconds(20));

        // its close under way, its transport still on it
        Assert.Equal([Handle], _transport.Closed);
        Assert.Equal(1, (await Server.Gauges()).Server.Counts["closing"]);

        var server = await DisposeServer();

        Assert.Equal(0, (await server.Gauges()).Server.Counts["closing"]);

        release.SetResult();
    }

    [Fact]
    public async Task Dispose_lets_go_of_the_transport_rejects_what_waits_forgets_the_sessions_and_stops()
    {
        Start(Timeout.InfiniteTimeSpan);
        _transport.Open(Handle);
        await Deliver(RequestOf(1, ("login", false), "{\"name\":\"ada\"}"));

        var clock = Server.Services.GetCommand(
            InteropProcedures.Clock.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });
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

        public event Action<bool, string>? Listen;

        public event Action<TransportServerRefusal>? Refusal;

        public event Action<Exception, string>? Error;

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

        // the handlers on its four events
        public int Subscribers
        {
            get
            {
                return (Connection?.GetInvocationList().Length ?? 0)
                    + (Message?.GetInvocationList().Length ?? 0)
                    + (Close?.GetInvocationList().Length ?? 0)
                    + (Listen?.GetInvocationList().Length ?? 0);
            }
        }

        public void Open(string connectionHandle)
        {
            Connection?.Invoke(connectionHandle);
        }

        // a listen held on the connection, as an HTTP transport tells it, or its end
        public void Listening(bool isHeld)
        {
            Listen?.Invoke(isHeld, Handle);
        }

        // what a listener of its events threw, as a transport reports it
        public void Report(Exception reason, string connectionHandle)
        {
            Error?.Invoke(reason, connectionHandle);
        }

        // a request it refused of its own, as a transport tells it
        public void Refuse(TransportServerRefusal refusal)
        {
            Refusal?.Invoke(refusal);
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

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var bytes = message.Bytes;

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

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var bytes = message.Bytes;

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
