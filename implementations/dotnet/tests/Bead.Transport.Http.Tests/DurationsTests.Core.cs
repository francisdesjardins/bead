using System.Globalization;
using Bead.Tests;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// The places of the core: a call's timeout, a service manager's default, a call id's reservation, a
/// transfer's inactivity, a relay's timeout, a session's two timeouts as its manager holds them, and
/// a server's own connection timeout, each on a clock of the tests' own where it arms a timer.
/// </summary>
public sealed partial class DurationsTests
{
    // constants

    private const string Other = "type=WS;ip=127.0.0.1;port=50002";

    private static readonly Procedure Echo = new()
    {
        ServiceId = 2,
        ProcedureId = 1,
        ProcedureName = "echo",
        ServiceRevision = 3,
    };

    private static readonly RequestDependencies<byte[], byte[]> Asked = new() { Serializer = new Bytes() };

    private static readonly RelayOptions Admitting = new()
    {
        BeforeRoute = new BeforeRequest((_) =>
        {
            return true;
        }),
    };

    // the other timeout of a session a reset plays, armed as it is set
    private static readonly TimeSpan OtherTimeout = TimeSpan.FromSeconds(1);

    // call.timeout

    // a call's own options, as its service manager applies its defaults, a manager given none: the
    // timeout traced and the one its router is handed alike; refused, nothing traced, no
    // deprecation told, and nothing handed on
    private static async Task<Observed> CallByServiceManager(TimeSpan? given)
    {
        var router = new Router();
        var manager = new ServiceManager(router);
        var seen = new List<DebugEvent>();
        var deprecated = new List<Procedure>();

        manager.Debug += (_, told) =>
        {
            lock (seen)
            {
                seen.Add(told);
            }
        };
        manager.Deprecated += deprecated.Add;

        var calling = manager.GetRequest(Echo with { Deprecation = new ProcedureDeprecation() }, Asked)([1])(new RequestOptions { Timeout = given });

        try
        {
            await calling.WaitAsync(Patience, Cancelled);
        }
        catch (ArgumentOutOfRangeException refused)
        {
            Assert.Equal((0, 0, 0), (seen.Count, deprecated.Count, router.Requests.Count));

            return Refused(refused);
        }

        var handed = Assert.Single(router.Requests).Timeout;

        Assert.Equal(handed, seen[0].Options!.Timeout);

        return HeldAt(handed);
    }

    // the options its router's request is given: no answer a millisecond short of what it holds, and
    // the call ended at it, its TimeoutException telling it; never, waiting on past the ceiling;
    // refused, no call id drawn and nothing sent
    private static async Task<Observed> CallByRouter(TimeSpan? given)
    {
        var port = new Port(RouterSide.Client);
        var drawn = new List<uint>();
        var asking = port.Core.Request(
            new byte[] { 1 },
            new CoreRequest
            {
                ConnectionHandle = Handle,
                Procedure = Echo,
                Options = new ResolvedRequestOptions { Timeout = Assert.NotNull(given) },
                OnCallId = drawn.Add,
            });

        await port.Settle();

        if (asking.IsFaulted)
        {
            var refused = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            {
                return asking;
            });

            Assert.Equal((0, 0), (drawn.Count, port.Sent.Count));

            return Refused(refused);
        }

        Assert.Equal([1u], drawn);

        if (port.Clock.Dues() is not [var due])
        {
            Assert.Empty(port.Clock.Dues());
            await port.Clock.Advance(Clocks.LongestTimer);
            Assert.False(asking.IsCompleted);

            return HeldAt(Never);
        }

        await port.Clock.Advance(due - Millisecond);
        Assert.False(asking.IsCompleted);
        await port.Clock.Advance(Millisecond);

        var ended = await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asking.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(string.Create(CultureInfo.InvariantCulture, $"no answer came in {due.TotalMilliseconds} milliseconds"), ended.Message);

        return HeldAt(due);
    }

    // serviceManager.defaultTimeout

    // the manager's options, as it is built: the timeout its router is handed for a call given none;
    // refused as the manager is built
    private static async Task<Observed> DefaultTimeoutByOptions(TimeSpan? given)
    {
        var router = new Router();
        ServiceManager manager;

        try
        {
            manager = new ServiceManager(router, new ServiceManagerOptions { Defaults = given is { } timeout ? new RequestDefaults { Timeout = timeout } : null });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await manager.GetRequest(Echo, Asked)([1])().WaitAsync(Patience, Cancelled);

        return HeldAt(Assert.Single(router.Requests).Timeout);
    }

    // router.reservation

    // a call id its router reserves: reserved a millisecond short of what it holds, free at it;
    // refused, nothing reserved, and nothing sent
    private static async Task<Observed> ReservationByReserve(TimeSpan? given)
    {
        var port = new Port(RouterSide.Client);

        try
        {
            port.Core.Reserve(new CallAddress(1, Handle), given);
        }
        catch (ArgumentOutOfRangeException refused)
        {
            await port.Settle();
            Assert.Empty(port.Sent);
            Assert.False(await port.IsReserved(1));

            return Refused(refused);
        }

        return await ReservedFor((port, 1));
    }

    // a call id its router cancels, which no call waits on: its cancel sent, and reserved as a
    // reserve is; refused, no cancel sent, and nothing reserved
    private static async Task<Observed> ReservationByCancel(TimeSpan? given)
    {
        var port = new Port(RouterSide.Client);

        try
        {
            port.Core.Cancel(new CallAddress(3, Handle), given);
        }
        catch (ArgumentOutOfRangeException refused)
        {
            await port.Settle();
            Assert.Empty(port.Sent);
            Assert.False(await port.IsReserved(3));

            return Refused(refused);
        }

        await port.Settle();
        Assert.IsType<CancelHeader>(Assert.Single(port.Sent).Header);

        return await ReservedFor((port, 3));
    }

    // how long a call id stays reserved: the due of its timer, reserved a millisecond short of it,
    // free at it
    private static async Task<Observed> ReservedFor((Port Port, uint CallId) reserved)
    {
        var (port, callId) = reserved;

        await port.Settle();

        var due = Assert.Single(port.Clock.Dues());

        await port.Clock.Advance(due - Millisecond);
        Assert.True(await port.IsReserved(callId));
        await port.Clock.Advance(Millisecond);
        Assert.False(await port.IsReserved(callId));

        return HeldAt(due);
    }

    // router.transferInactivityTimeout

    // the router's limits, as it is built: the limit read back from the router
    private static Task<Observed> TransferInactivityByLimits(TimeSpan? given)
    {
        var limits = given is { } timeout ? RouterLimits.Default with { TransferInactivityTimeout = timeout } : RouterLimits.Default;

        try
        {
            return Task.FromResult(HeldAt(new Port(RouterSide.Client, limits).Core.Limits.TransferInactivityTimeout));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Task.FromResult(Refused(refused));
        }
    }

    // relay.timeout

    // the relay's options, as it is built, its destination registered with none: the timeout of leg
    // B's request
    private static async Task<Observed> RelayTimeoutByRelay(TimeSpan? given)
    {
        var target = new Target();
        Relay relay;

        try
        {
            relay = RelayOf(given is { } timeout ? Admitting with { Timeout = timeout } : Admitting);
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        relay.Register(target, new DestinationOptions { DestinationId = 7 });

        return await LegBOf((relay, target));
    }

    // a destination's, as it is registered, under a relay given none: the timeout of leg B's
    // request; refused, nothing registered
    private static async Task<Observed> RelayTimeoutByRegister(TimeSpan? given)
    {
        var target = new Target();
        var relay = RelayOf(Admitting);

        try
        {
            relay.Register(target, new DestinationOptions { DestinationId = 7, Timeout = given });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            Assert.Null(relay.HandlerOf(7));

            return Refused(refused);
        }

        return await LegBOf((relay, target));
    }

    private static Relay RelayOf(RelayOptions options)
    {
        return new Relay(
            new RelayRouter
            {
                IsTwoWay = (_) =>
                {
                    return true;
                },
                Limits = RouterLimits.Default,
                Report = (_, _) =>
                {
                },
                Request = (_, _) =>
                {
                    return Task.FromException<RouterResult>(new InvalidOperationException("the relay asks its own router nothing here"));
                },
                Respond = (_, _) =>
                {
                    return Task.CompletedTask;
                },
            },
            options);
    }

    // the timeout leg B is asked with, of a request to destination 7
    private static async Task<Observed> LegBOf((Relay Relay, Target Target) relayed)
    {
        var (relay, target) = relayed;
        var handler = relay.HandlerOf(7);

        Assert.NotNull(handler);
        await handler.Handle(new RequestResolverProps
        {
            ConnectionHandle = Handle,
            Header = new RequestHeader { CallId = 1, DestinationId = 7, ProcedureId = 1, ServiceId = 2 },
            IsAdmitted = true,
            Payload = new byte[] { 1, 2, 3 },
            Signal = CancellationToken.None,
        }).WaitAsync(Patience, Cancelled);

        return HeldAt(Assert.Single(target.Asked).Timeout);
    }

    // sessionManager.connectionInactivityTimeout and sessionManager.sessionInactivityTimeout

    // the manager's options, as it is built: the timeout a session set with that one left out holds
    private static Task<Observed> ConnectionDefaultByOptions(TimeSpan? given)
    {
        return ManagerDefaultOf((true, given));
    }

    private static Task<Observed> SessionDefaultByOptions(TimeSpan? given)
    {
        return ManagerDefaultOf((false, given));
    }

    private static Task<Observed> ManagerDefaultOf((bool IsConnection, TimeSpan? Given) played)
    {
        var (isConnection, given) = played;
        var clock = new SteppingClock(Epoch);
        SessionManager<string> sessions;

        try
        {
            var options = new SessionManagerOptions { Clock = clock };

            sessions = new SessionManager<string>((isConnection, given) switch
            {
                (_, null) => options,
                (true, { } timeout) => options with { ConnectionInactivityTimeout = timeout },
                (false, { } timeout) => options with { SessionInactivityTimeout = timeout },
            });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Task.FromResult(Refused(refused));
        }

        using (sessions)
        {
            var created = sessions.Create(Handle);
            var session = sessions.Set(isConnection ? created with { ConnectionInactivityTimeout = null } : created with { SessionInactivityTimeout = null });

            return Task.FromResult(HeldAt((isConnection ? session.ConnectionInactivityTimeout : session.SessionInactivityTimeout)!.Value));
        }
    }

    // session.inactivityTimeouts

    // each of a session's two timeouts, as its manager, given none of its defaults, sets a session or
    // updates one: the timeout of the session it returns; refused, nothing stored, the session as it
    // was, and its timers as they were
    private static Task<Observed> SessionTimeoutBySetConnection(TimeSpan? given)
    {
        return SessionTimeoutOf((sessions, _) =>
        {
            return sessions.Set(sessions.Create(Other) with { ConnectionInactivityTimeout = given }).ConnectionInactivityTimeout;
        });
    }

    private static Task<Observed> SessionTimeoutBySetSession(TimeSpan? given)
    {
        return SessionTimeoutOf((sessions, _) =>
        {
            return sessions.Set(sessions.Create(Other) with { SessionInactivityTimeout = given }).SessionInactivityTimeout;
        });
    }

    private static Task<Observed> SessionTimeoutByUpdateConnection(TimeSpan? given)
    {
        return SessionTimeoutOf((sessions, session) =>
        {
            return sessions.UpdateConnectionInactivityTimeout(session with { ConnectionInactivityTimeout = given })!.ConnectionInactivityTimeout;
        });
    }

    private static Task<Observed> SessionTimeoutByUpdateSession(TimeSpan? given)
    {
        return SessionTimeoutOf((sessions, session) =>
        {
            return sessions.UpdateSessionInactivityTimeout(session with { SessionInactivityTimeout = given })!.SessionInactivityTimeout;
        });
    }

    // a session stored, both its timers armed, under a manager given none of its defaults; then the
    // timeout the way gives back
    private static Task<Observed> SessionTimeoutOf(Func<SessionManager<string>, Session<string>, TimeSpan?> timeoutOf)
    {
        var clock = new SteppingClock(Epoch);

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = clock });

        var session = sessions.Set(sessions.Create(Handle) with { ConnectionInactivityTimeout = OtherTimeout, SessionInactivityTimeout = 2 * OtherTimeout });
        var armed = clock.Dues();

        try
        {
            return Task.FromResult(HeldAt(timeoutOf(sessions, session)!.Value));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            Assert.False(sessions.Has(Other));
            Assert.Equal(session, sessions.Get(Handle));
            Assert.Equal(armed, clock.Dues());

            return Task.FromResult(Refused(refused));
        }
    }

    // sessionManager.resetConnectionInactivityTimeout and sessionManager.resetSessionInactivityTimeout

    // the reset's argument, on a session whose other timeout runs: the due of the timer it arms
    // beside the other's; never, none armed; refused, the timers as they were
    private static Task<Observed> ConnectionResetByReset(TimeSpan? given)
    {
        return ResetOf((true, Assert.NotNull(given)));
    }

    private static Task<Observed> SessionResetByReset(TimeSpan? given)
    {
        return ResetOf((false, Assert.NotNull(given)));
    }

    private static Task<Observed> ResetOf((bool IsConnection, TimeSpan Given) played)
    {
        var (isConnection, given) = played;
        var clock = new SteppingClock(Epoch);

        using var sessions = new SessionManager<string>(new SessionManagerOptions { Clock = clock });

        var created = sessions.Create(Handle);
        var session = sessions.Set(isConnection ? created with { SessionInactivityTimeout = OtherTimeout } : created with { ConnectionInactivityTimeout = OtherTimeout });

        Assert.Equal([OtherTimeout], clock.Dues());

        try
        {
            if (isConnection)
            {
                sessions.ResetConnectionInactivityTimeout(session, given);
            }
            else
            {
                sessions.ResetSessionInactivityTimeout(session, given);
            }
        }
        catch (ArgumentOutOfRangeException refused)
        {
            Assert.Equal([OtherTimeout], clock.Dues());

            return Task.FromResult(Refused(refused));
        }

        var dues = clock.Dues().ToList();

        Assert.True(dues.Remove(OtherTimeout));

        return Task.FromResult(HeldAt(dues is [var due] ? due : Never));
    }

    // server.connectionInactivityTimeout

    // the server layer's options, as it is built over a transport that gives it none: a silent
    // connection open a millisecond short of what it holds, closed at it; never, open past the
    // ceiling; refused, nothing listening on its transport
    private static async Task<Observed> ServerInactivityByOptions(TimeSpan? given)
    {
        var scheduler = new SerialScheduler();
        var clock = new SteppingClock(Epoch)
        {
            Settle = () =>
            {
                return scheduler.WhenIdle();
            },
        };
        var transport = new ServerTransport { Clock = clock };
        Server<string> server;

        try
        {
            server = new Server<string>(transport, new ServerOptions { ConnectionInactivityTimeout = given, ResolverScheduler = scheduler, Scheduler = scheduler });
        }
        catch (ArgumentOutOfRangeException refused)
        {
            Assert.Equal(0, transport.Subscribers);

            return Refused(refused);
        }

        await using (server)
        {
            transport.Open(Handle);
            await scheduler.WhenIdle();

            if (clock.Dues() is not [var due])
            {
                Assert.Empty(clock.Dues());
                await clock.Advance(Clocks.LongestTimer);
                Assert.Empty(transport.Closed);

                return HeldAt(Never);
            }

            await clock.Advance(due - Millisecond);
            Assert.Empty(transport.Closed);
            await clock.Advance(Millisecond);
            Assert.Equal([Handle], transport.Closed);

            return HeldAt(due);
        }
    }

    // a payload as it is: bytes, either way
    private sealed class Bytes : IRequestSerializerClient<byte[], byte[]>
    {
        public ReadOnlyMemory<byte> Encode(byte[] request)
        {
            return request;
        }

        public byte[] Decode(ReadOnlyMemory<byte> response)
        {
            return response.ToArray();
        }
    }

    // a router that records each request it is handed, and answers it with its own payload
    private sealed class Router : IRouterLike
    {
        public List<ResolvedRequestOptions> Requests { get; } = [];

        public RouterSide Side
        {
            get
            {
                return RouterSide.Client;
            }
        }

        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public void RegisterResolver(IRequestResolver resolver)
        {
        }

        public Task Respond(RouterAnswer response, AnswerTarget target)
        {
            return Task.CompletedTask;
        }

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            ArgumentNullException.ThrowIfNull(request);

            lock (Requests)
            {
                Requests.Add(request.Options);
            }

            return Task.FromResult(new RouterResult(new ResultHeader { CallId = 1 }, payload));
        }

        public Task Notify(ReadOnlyMemory<byte> payload, NotifyRequest request)
        {
            return Task.CompletedTask;
        }

        public Task<uint> Subscribe(AnswerTarget target)
        {
            return Task.FromResult(target.Header.CallId);
        }

        public bool HasNotification(INotificationLike notification)
        {
            return false;
        }

        public Task RegisterNotification(INotificationLike notification)
        {
            return Task.CompletedTask;
        }

        public Task UnregisterNotification(INotificationLike notification, bool cancel = true)
        {
            return Task.CompletedTask;
        }
    }

    // a core whose peer is the test, on a clock of the tests' own: what it sends is read back, and
    // what it reports kept
    private sealed class Port : IRouterCorePort
    {
        public Port(RouterSide side, RouterLimits? limits = null)
        {
            Side = side;
            Clock = new SteppingClock(Epoch)
            {
                Settle = () =>
                {
                    return Settle();
                },
            };
            Core = new RouterCore(this, new RouterCoreOptions { Limits = limits, ResolverScheduler = Loop, Scheduler = Loop, Clock = Clock });
        }

        public RouterSide Side { get; }

        public SerialScheduler Loop { get; } = new();

        public SteppingClock Clock { get; }

        public RouterCore Core { get; }

        public List<Envelope> Sent { get; } = [];

        public List<Exception> Reports { get; } = [];

        public void Report(Exception reason, string connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            Sent.Add(EnvelopeCodec.ReadEnvelope(message.Bytes.Span, new EnvelopeReadOptions { Side = CallIds.PeerOf(Side), MaximumEnvelopeBytes = int.MaxValue })!);

            return Task.CompletedTask;
        }

        public async Task Settle()
        {
            for (var round = 0; round < 3; round += 1)
            {
                await Loop.WhenIdle();
            }
        }

        // reserved while a result that comes on it is dropped in silence; free once it is reported unknown
        public async Task<bool> IsReserved(uint callId)
        {
            var reports = Reports.Count;

            Core.Receive(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new ResultHeader { CallId = callId }, Payload = new byte[] { 1 } }), Handle);
            await Settle();

            return Reports.Count == reports;
        }
    }

    // a destination's client router, which records the options each request it is asked has, and
    // never answers
    private sealed class Target : IRouterTarget
    {
        public RouterLimits Limits { get; } = RouterLimits.Default;

        public bool CarriesCredential
        {
            get
            {
                return true;
            }
        }

        public bool IsSecure
        {
            get
            {
                return true;
            }
        }

        public List<ResolvedRequestOptions> Asked { get; } = [];

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            ArgumentNullException.ThrowIfNull(request);
            Asked.Add(request.Options);
            request.OnSent?.Invoke(true);

            return Task.FromResult(new RouterResult(new ResultHeader { CallId = 2 }, new byte[] { 9 }));
        }
    }

    // a transport of the server layer whose connections the test opens: it records what it is asked
    // to close, and counts the handlers on its events
    private sealed class ServerTransport : IServerTransport
    {
        public required TimeProvider Clock { get; init; }

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public List<string> Closed { get; } = [];

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

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            Closed.Add(connectionHandle);

            return Task.FromResult(true);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }
    }
}
