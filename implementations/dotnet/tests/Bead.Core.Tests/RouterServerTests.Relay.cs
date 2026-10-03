namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer"/> relaying: a request that names a destination goes on, as leg B, to a
/// device's router behind a client's router on a pipe, or to a connection of the relay's own, and
/// its answer comes back on leg A, as the TypeScript side's router-server tests show it. Every
/// router runs on the test's scheduler, so a test that settles it settles them all.
/// </summary>
public sealed partial class RouterServerTests
{
    // constants

    // the device behind the relay
    private const string DeviceHandle = "type=WS;ip=127.0.0.1;port=50100";

    private static readonly Procedure Failing = new() { ServiceId = 2, ProcedureId = 2, ProcedureName = "failing", ServiceRevision = 3 };

    private static readonly Procedure Held = new() { ServiceId = 2, ProcedureId = 3, ProcedureName = "held", ServiceRevision = 3 };

    private static readonly RelayOptions Admitting = new()
    {
        BeforeRoute = new BeforeRequest((_) =>
        {
            return true;
        }),
    };

    // helpers

    // `request`, to `destinationId` behind the relay
    private static Envelope To(uint destinationId, Envelope request)
    {
        return new Envelope { Header = (RequestHeader)request.Header with { DestinationId = destinationId }, Payload = request.Payload };
    }

    // the kind of each envelope a pipe's client sent, as its server reads it
    private static List<EnvelopeKind> KindsOf(IEnumerable<byte[]> sent)
    {
        return [.. sent.Select((bytes) =>
        {
            return EnvelopeCodec.ReadEnvelope(bytes, new EnvelopeReadOptions { Side = RouterSide.Server, MaximumEnvelopeBytes = int.MaxValue })!.Kind;
        })];
    }

    // a device's router on a pipe, and a client's router to it — leg B — as the setup says: it
    // answers echo in upper case, fails failing with its code 21, and holds held until its signal is
    // cancelled
    private Device DeviceOf(Setup setup)
    {
        var pipe = new Pipe(DeviceHandle, setup.IsDeferred ? _scheduler : null) { Clock = setup.Clock ?? _time };
        var device = new Device(
            pipe,
            (new RouterServer(
                pipe.Server,
                new RouterServerOptions { Limits = setup.DeviceLimits, ResolverScheduler = _scheduler, Scheduler = _scheduler }),
            new RouterClient(
                pipe.Client,
                new RouterClientOptions { Limits = setup.DeviceLimits, ResolverScheduler = _scheduler, Scheduler = _scheduler })));
        var services = new ServiceManager(device.Router);
        var answering = new RequestResolverDependencies<string, string> { Serializer = Text };

        services.GetRequestResolver(Echo, answering)((request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        services.GetRequestResolver(Failing, answering)((_, response) =>
        {
            return response.Fail(Failure.OfApplication(21, "nothing to echo"));
        });
        services.GetRequestResolver(Held, answering)(async (request, _) =>
        {
            var cancelled = new TaskCompletionSource();

            using var registration = request.Signal.Register(() =>
            {
                cancelled.SetResult();
            });

            await cancelled.Task;
            device.Aborted += 1;
        });
        pipe.Open();

        return device;
    }

    // a relay on the scripted transport — leg A, the first connection open — relaying as the setup
    // says, every request by default, with the device behind it at destination 7
    private Device StartRelayed(Setup? setup = null)
    {
        var given = setup ?? new Setup();
        var device = DeviceOf(given);

        Start(new RouterServerOptions { Relay = given.Relay, Clock = given.Clock });
        _transport.Open(First);
        Router.RegisterDestination(device.ToDevice, new DestinationOptions { DestinationId = 7, Label = "the device" });

        return device;
    }

    // definition

    [Fact]
    public async Task Relays_a_request_to_the_destination_it_names_admitted_once_and_brings_the_answer_back_under_its_call_id_a_failure_of_the_target_s_one_relay_more()
    {
        var admissions = 0;

        using var device = StartRelayed(new Setup
        {
            Relay = new RelayOptions
            {
                BeforeRoute = new BeforeRequest((_) =>
                {
                    admissions += 1;

                    return true;
                }),
            },
        });

        // one at a time: the TypeScript side answers each within its delivery, over its pipe
        Deliver(First, To(7, RequestOf(1, payload: "hi")));
        await Settle();
        Deliver(First, To(7, RequestOf(3, Failing)));
        await Settle();
        Deliver(First, To(7, RequestOf(5, Echo with { ProcedureId = 9 })));
        await Settle();

        var answers = _transport.Sent.Select((entry) =>
        {
            return entry.Envelope.Failure ?? (object)entry.Envelope.Header;
        }).ToList();

        Assert.Equal(["first result 1 HI", "first failure 3 21", "first failure 5 ProcedureUnknown"], SentSince());
        Assert.Equal<object>(
            [
                // an answer names its call alone
                new ResultHeader { CallId = 1 },
                Failure.OfApplication(21, "nothing to echo") with { Relays = 1 },
                Failure.OfProtocol(ProtocolCode.ProcedureUnknown, "no procedure 9 in service 2") with { Relays = 1 },
            ],
            answers);
        Assert.Equal(3, admissions);

        // the target's own failures are answered, not reported
        Assert.Empty(_errors);
        Assert.Equal([new Destination(7, "the device")], Router.Destinations());
    }

    [Fact]
    public async Task Refuses_before_leg_B_the_routing_not_admitted_the_destination_unknown_a_subscription_a_payload_past_the_target_s_limit_and_sends_the_target_nothing()
    {
        using var device = StartRelayed(new Setup
        {
            DeviceLimits = new RouterLimits { MaximumPayloadBytes = 4 },
            Relay = new RelayOptions
            {
                BeforeRoute = new BeforeRequest((request) =>
                {
                    return request.Header.CallId != 1;
                }),
            },
        });

        Deliver(First, To(7, RequestOf(1)));
        Deliver(First, To(8, RequestOf(3)));
        Deliver(First, To(7, SubscribingOf(5, procedure: Echo)));
        Deliver(First, To(7, RequestOf(7, payload: "too long")));
        await Settle();

        Assert.Equal(
            [
                "first failure 1 AccessDenied",
                "first failure 3 DestinationUnknown",
                "first failure 5 SubscriptionUnsupported",
                "first failure 7 PayloadTooLarge",
            ],
            SentSince());
        Assert.Empty(device.Pipe.ClientSent);
    }

    [Fact]
    public async Task Cancels_leg_B_when_leg_A_cancels_its_call_when_its_connection_goes_and_when_the_relay_is_disposed_freeing_the_call_id_each_time()
    {
        using var device = StartRelayed();

        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();
        Deliver(First, CancelOf(1));
        await Settle();

        Assert.Equal(1, device.Aborted);

        // the same call id, free again, relayed anew
        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();
        _transport.Closed(First);
        await Settle();

        Assert.Equal(2, device.Aborted);

        _transport.Open(First);
        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();
        Router.Dispose();
        await Settle();

        // a signal carries no reason here: the device took a cancel for each
        Assert.Equal(3, device.Aborted);
        Assert.Equal(
            [EnvelopeKind.Request, EnvelopeKind.Cancel, EnvelopeKind.Request, EnvelopeKind.Cancel, EnvelopeKind.Request, EnvelopeKind.Cancel],
            KindsOf(device.Pipe.ClientSent));

        // leg A heard nothing: each answer went nowhere
        Assert.Empty(_transport.Sent);
    }

    [Fact]
    public async Task Cancels_leg_B_when_leg_A_cancels_its_call_as_leg_B_s_request_is_handed_over()
    {
        var taken = new List<EnvelopeKind>();

        using var device = StartRelayed();

        // leg A's cancel comes as the device takes the request
        device.Router.Debug += (direction, envelope) =>
        {
            if (direction != DebugDirection.Rx)
            {
                return;
            }

            taken.Add(envelope.Header.Kind);

            if (taken.Count == 1)
            {
                Deliver(First, CancelOf(1));
            }
        };
        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();

        Assert.Equal([EnvelopeKind.Request, EnvelopeKind.Cancel], taken);
        Assert.Equal(1, device.Aborted);
        Assert.Empty(_transport.Sent);
    }

    [Fact]
    public async Task Relays_over_a_pipe_that_hands_each_message_a_turn_later_and_cancels_over_it()
    {
        using var device = StartRelayed(new Setup { IsDeferred = true });

        Deliver(First, To(7, RequestOf(1, payload: "hi")));
        Deliver(First, To(7, RequestOf(3, Held)));
        await Settle();

        Assert.Equal(["first result 1 HI"], SentSince());

        Deliver(First, CancelOf(3));
        await Settle();

        Assert.Equal(1, device.Aborted);
        Assert.Empty(SentSince());
    }

    [Fact]
    public async Task Answers_unreachable_when_the_target_never_had_the_request_and_lost_when_it_went_after_it_had_it_reporting_why()
    {
        using var device = StartRelayed();

        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();
        device.Pipe.Close();
        await Settle();
        Deliver(First, To(7, RequestOf(3)));
        await Settle();

        var failures = _transport.Sent.Select((entry) =>
        {
            return entry.Envelope.Failure;
        }).ToList();

        Assert.Equal(["first failure 1 DestinationLost", "first failure 3 DestinationUnreachable"], SentSince());

        // the relay's own, with no address behind it: why is reported, with leg A's connection
        Assert.Equal(
            [
                Failure.OfProtocol(ProtocolCode.DestinationLost, "destination 7 was lost once handed the request: the procedure may have run"),
                Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: nothing was tried"),
            ],
            failures);
        Assert.Equal(["the connection closed before the answer first", $"{DeviceHandle} is not open first"], Reported());
    }

    [Fact]
    public async Task Ends_leg_B_past_the_relay_s_timeout_cancelling_it_at_the_target_and_answers_lost_no_timer_without_one()
    {
        var time = new RecordingTime(_time);

        using var device = StartRelayed(new Setup { Relay = Admitting with { Timeout = TimeSpan.FromMilliseconds(250) }, Clock = time });

        Deliver(First, To(7, RequestOf(1, Held)));
        await Settle();

        Assert.Equal([TimeSpan.FromMilliseconds(250)], time.Armed);

        _time.Advance(TimeSpan.FromMilliseconds(250));
        await Settle();

        // its call id on leg B stays reserved as long as its timeout, against a late answer
        Assert.Equal([TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(250)], time.Armed);
        Assert.Equal(1, device.Aborted);
        Assert.Equal(0, _transport.Sent[0].Envelope.Failure!.Relays);
        Assert.Equal(["first failure 1 DestinationLost"], SentSince());

        var (reason, connectionHandle) = Assert.Single(_errors);

        Assert.Contains("250", reason.Message, StringComparison.Ordinal);
        Assert.Equal(First, connectionHandle);

        // a relay of no timeout, on its own leg A, arms none
        var legA = new ScriptedTransport { Clock = time };

        using var unbounded = new RouterServer(
            legA,
            new RouterServerOptions { Relay = Admitting, ResolverScheduler = _scheduler, Scheduler = _scheduler });
        using var behind = DeviceOf(new Setup { Clock = time });

        legA.Open(First);
        unbounded.RegisterDestination(behind.ToDevice, new DestinationOptions { DestinationId = 7 });

        var armed = time.Armed.Count;

        legA.Deliver(First, EnvelopeCodec.WriteEnvelope(To(7, RequestOf(1, Held))));
        await Settle();

        Assert.Empty(time.Armed.Skip(armed));
    }

    [Fact]
    public async Task Holds_a_transfer_to_the_target_s_limit_at_its_opening_and_relays_one_to_the_destination_it_opened_on()
    {
        var limits = new RouterLimits { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, WindowBytes = 4_096 };
        var legA = new Pipe(First, null) { Clock = _time };
        var admissions = 0;
        var credits = new List<uint>();

        using var router = new RouterServer(
            legA.Server,
            new RouterServerOptions
            {
                Limits = limits,
                Relay = new RelayOptions
                {
                    BeforeRoute = new BeforeRequest((_) =>
                    {
                        admissions += 1;

                        return true;
                    }),
                },
                ResolverScheduler = _scheduler,
                Scheduler = _scheduler,
            });
        using var requester = new RouterClient(
            legA.Client,
            new RouterClientOptions { Limits = limits, ResolverScheduler = _scheduler, Scheduler = _scheduler });
        using var behind = DeviceOf(new Setup { DeviceLimits = limits with { MaximumPayloadBytes = 4_096 } });

        var registration = router.RegisterDestination(behind.ToDevice, new DestinationOptions { DestinationId = 7 });

        // registered in its place as the transfer comes, and never asked
        var later = new RefusingTarget(behind.ToDevice.Limits);

        router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Tx && envelope.Header is CreditHeader credit)
            {
                credits.Add(credit.CallId);
            }

            if (direction == DebugDirection.Rx && envelope.Header is ChunkHeader && registration.Unregister())
            {
                router.RegisterDestination(later, new DestinationOptions { DestinationId = 7 });
            }
        };
        legA.Open();

        Task<RouterResult> Ask(int length)
        {
            return requester.Request(
                BytesOf(new string('x', length)),
                new RouterRequest(Echo, new ResolvedRequestOptions { DestinationId = 7, Timeout = TimeSpan.FromSeconds(5) })).WaitAsync(Patience, Cancelled);
        }

        // past the device's 4 KiB: refused at its opening, before any credit
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Ask(5_000);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, refused.Code);
        Assert.Equal(0, refused.Relays);
        Assert.Empty(credits);
        Assert.Empty(behind.Pipe.ClientSent);

        // within it: credited, and relayed to the device it opened on
        Assert.Equal(new string('X', 3_000), TextOf((await Ask(3_000)).Payload));
        Assert.NotEmpty(credits);
        Assert.Equal(2, admissions);
    }

    [Fact]
    public async Task Asks_a_connection_of_its_own_by_a_command_cancels_it_with_leg_A_answers_lost_when_it_goes_and_unreachable_after_whoever_takes_its_handle()
    {
        Start(new RouterServerOptions { Relay = Admitting });
        _transport.Open(First);
        _transport.Open(Second);

        var registration = Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = 9 });

        Deliver(First, To(9, RequestOf(1, payload: "hi")));
        await Settle();
        Deliver(Second, ResultOf(2, "HI"));
        await Settle();

        // leg A's cancel goes on to the connection
        Deliver(First, To(9, RequestOf(3)));
        await Settle();
        Deliver(First, CancelOf(3));
        await Settle();
        Deliver(First, To(9, RequestOf(5)));
        await Settle();
        _transport.Closed(Second);
        await Settle();

        // a newcomer under the same handle is not the destination
        _transport.Open(Second);
        Deliver(First, To(9, RequestOf(7)));
        await Settle();

        // the command names no destination: the connection is what is behind the relay
        Assert.Equal(new RequestHeader { CallId = 2, ServiceId = 2, ProcedureId = 1 }, _transport.Sent[0].Envelope.Header);
        Assert.Equal(
            [
                "second request 2 hi",
                "first result 1 HI",
                "second request 4 ",
                "second cancel 4",
                "second request 6 ",
                "first failure 5 DestinationLost",
                "first failure 7 DestinationUnreachable",
            ],
            SentSince());
        Assert.Equal([new Destination(9, null)], Router.Destinations());

        // registered anew, the newcomer is asked; the relay disposed, neither leg hears more
        Assert.True(registration.Unregister());
        Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = 9 });
        Deliver(First, To(9, RequestOf(9, payload: "again")));
        await Settle();
        Router.Dispose();
        await Settle();

        Assert.Equal(["second request 8 again"], SentSince());
        Assert.Equal(["the connection closed before the answer first"], Reported());
    }

    // relay.test.ts:333 and :614 test the relay alone; here, through the router, which hands it its
    // own limits and what its transport says each connection carries
    [Fact]
    public async Task Holds_a_connection_of_its_own_to_the_router_s_own_limits_and_passes_nothing_on_to_one_that_carries_no_request()
    {
        // past the default, so a limit not the router's own shows
        var past = LimitDefaults.MaximumPayloadBytes + 1;

        Start(new RouterServerOptions { Limits = RouterLimits.Default with { MaximumPayloadBytes = 2 * past }, Relay = Admitting });
        _transport.Open(First);
        _transport.Open(Second);
        _transport.Open(Third);
        _transport.OneWay.Add(Third);
        Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = 9 });
        Router.RegisterDestination(new ConnectionTarget(Third), new DestinationOptions { DestinationId = 11 });

        // a transfer's opening past the default, credited; nothing goes on before it is whole
        Deliver(First, To(9, new Envelope { Header = new RequestHeader { CallId = 1, ServiceId = 2, ProcedureId = 1, Total = past }, Payload = new byte[16] }));
        Deliver(First, To(11, RequestOf(3)));
        await Settle();

        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 11 is unreachable: its connection carries no request"),
            _transport.Sent[^1].Envelope.Failure);
        Assert.Equal(["first credit 1", "first failure 3 DestinationUnreachable"], SentSince());
    }

    // how a relay test sets its routers up: the relay's options, the device's limits, whether the
    // device's pipe hands each message a turn later, and the clock they all keep
    private sealed record Setup
    {
        public RelayOptions Relay { get; init; } = Admitting;

        public RouterLimits? DeviceLimits { get; init; }

        public bool IsDeferred { get; init; }

        public TimeProvider? Clock { get; init; }
    }

    // a device behind the relay, its router and leg B to it; how many calls to held it saw cancelled
    private sealed class Device(Pipe pipe, (RouterServer Router, RouterClient ToDevice) routers) : IDisposable
    {
        public Pipe Pipe { get; } = pipe;

        public RouterServer Router { get; } = routers.Router;

        public RouterClient ToDevice { get; } = routers.ToDevice;

        public int Aborted { get; set; }

        public void Dispose()
        {
            ToDevice.Dispose();
            Router.Dispose();
        }
    }

    // a destination that refuses every call: it opened none
    private sealed class RefusingTarget(RouterLimits limits) : IRouterTarget
    {
        public RouterLimits Limits { get; } = limits;

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            return Task.FromException<RouterResult>(new InvalidOperationException("asked a call it did not open"));
        }
    }

    // the test's clock, which keeps how long each timer armed on it waits
    private sealed class RecordingTime(TimeProvider time) : TimeProvider
    {
        private readonly Lock _gate = new();
        private readonly List<TimeSpan> _armed = [];

        public List<TimeSpan> Armed
        {
            get
            {
                lock (_gate)
                {
                    return [.. _armed];
                }
            }
        }

        public override long TimestampFrequency
        {
            get
            {
                return time.TimestampFrequency;
            }
        }

        public override DateTimeOffset GetUtcNow()
        {
            return time.GetUtcNow();
        }

        public override long GetTimestamp()
        {
            return time.GetTimestamp();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (_gate)
            {
                _armed.Add(dueTime);
            }

            return time.CreateTimer(callback, state, dueTime, period);
        }
    }

    // a client's transport and a server's joined back to back, as one connection: what one end
    // sends, the other takes — within the send, or a turn later on the scheduler given, while the
    // connection is still open; a send while it is not open fails. Each end's bytes are kept, in order
    private sealed class Pipe
    {
        private readonly SerialScheduler? _deferring;
        private volatile bool _isOpen;

        public Pipe(string connectionHandle, SerialScheduler? deferring)
        {
            ConnectionHandle = connectionHandle;
            _deferring = deferring;
            Client = new PipeClient(this);
            Server = new PipeServer(this);
        }

        public string ConnectionHandle { get; }

        // what both its ends run on
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public PipeClient Client { get; }

        public PipeServer Server { get; }

        public List<byte[]> ClientSent { get; } = [];

        public List<byte[]> ServerSent { get; } = [];

        public void Open()
        {
            _isOpen = true;
            Server.Opened();
        }

        public void Close()
        {
            _isOpen = false;
            Client.Closed();
            Server.Closed();
        }

        public Task FromClient(ReadOnlyMemory<byte> bytes)
        {
            if (!_isOpen)
            {
                return Task.FromException(new IOException($"{ConnectionHandle} is not open"));
            }

            var copy = bytes.ToArray();

            ClientSent.Add(copy);
            Hand(() =>
            {
                Server.Deliver(copy);
            });

            return Task.CompletedTask;
        }

        public Task FromServer(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            if (!_isOpen || connectionHandle != ConnectionHandle)
            {
                return Task.FromException(new IOException($"{connectionHandle} is not open"));
            }

            var copy = bytes.ToArray();

            ServerSent.Add(copy);
            Hand(() =>
            {
                Client.Deliver(copy);
            });

            return Task.CompletedTask;
        }

        // within the send, or a turn later while the connection is still open
        private void Hand(Action deliver)
        {
            if (_deferring is null)
            {
                deliver();

                return;
            }

            _deferring.Post(() =>
            {
                if (_isOpen)
                {
                    deliver();
                }
            });
        }
    }

    // a pipe's client end
    private sealed class PipeClient(Pipe pipe) : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return pipe.Clock;
            }
        }

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false));
        }

        public void Closed()
        {
            Close?.Invoke(false, false);
        }

        public Task Send(ReadOnlyMemory<byte> bytes)
        {
            return pipe.FromClient(bytes);
        }
    }

    // a pipe's server end, of its one connection
    private sealed class PipeServer(Pipe pipe) : IRouterServerTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return pipe.Clock;
            }
        }

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public void Opened()
        {
            Connection?.Invoke(pipe.ConnectionHandle);
        }

        public void Closed()
        {
            Close?.Invoke(false, pipe.ConnectionHandle);
        }

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false), pipe.ConnectionHandle);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return pipe.FromServer(bytes, connectionHandle);
        }
    }
}
