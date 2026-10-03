namespace Bead.Tests;

/// <summary>
/// <see cref="Relay"/>: who it admits, the limits it holds a payload to, leg B as it asks it and the
/// answer leg A then hears, and its destinations, over a router that records every answer, request
/// and report, and targets that record what they are asked.
/// </summary>
public sealed class RelayTests
{
    // constants

    private const string First = "type=WS;ip=127.0.0.1;port=50001";

    private const string Device = "type=WS;ip=127.0.0.1;port=50002";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan Infinite = Timeout.InfiniteTimeSpan;

    private static readonly DestinationOptions Seven = new() { DestinationId = 7 };

    private static readonly RelayOptions Admitting = new()
    {
        BeforeRoute = new BeforeRequest((_) =>
        {
            return true;
        }),
    };

    private static readonly Action<bool> Unheard = (_) =>
    {
    };

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static RouterResult ResultOf(byte[] payload)
    {
        return new RouterResult(new ResultHeader { CallId = 2 }, payload);
    }

    // handed over, then answered with the payload
    private static Func<Action<bool>, Task<RouterResult>> Answering(byte[] payload)
    {
        return (onSent) =>
        {
            onSent(true);

            return Task.FromResult(ResultOf(payload));
        };
    }

    // as far as the reach says, then refused with the reason
    private static Func<Action<bool>, Task<RouterResult>> Refusing(Exception reason, Reach reach)
    {
        return (onSent) =>
        {
            if (reach != Reach.Never)
            {
                onSent(true);
            }

            if (reach == Reach.Refused)
            {
                onSent(false);
            }

            return Task.FromException<RouterResult>(reason);
        };
    }

    // a request's header to a destination, for procedure 1 of service 2, the very one dispatched
    private static RequestHeader HeaderOf(uint callId, uint destinationId = 7)
    {
        return new RequestHeader { CallId = callId, DestinationId = destinationId, ProcedureId = 1, ServiceId = 2 };
    }

    // the props a router hands a handler: admitted, unless told
    private static RequestResolverProps PropsOf(RequestHeader header)
    {
        return new RequestResolverProps
        {
            ConnectionHandle = First,
            Header = header,
            IsAdmitted = true,
            Payload = new byte[] { 1, 2, 3 },
            Signal = CancellationToken.None,
        };
    }

    private static Task Handled(IRequestHandler? handler, RequestResolverProps props)
    {
        Assert.NotNull(handler);

        return handler.Handle(props).WaitAsync(Patience, Cancelled);
    }

    // the answers written, each as its payload's bytes, or its failure
    private static List<object> FailuresOf(List<(RouterAnswer Answer, AnswerTarget Target)> answers)
    {
        return [.. answers.Select((answered) =>
        {
            return answered.Answer.Failure is { } failure ? (object)failure : answered.Answer.Payload.ToArray();
        })];
    }

    // the connection a request of the relay's own router went to
    private static string? HandleOf(Asked asked)
    {
        return asked.Options.ConnectionHandle;
    }

    // definition

    [Fact]
    public void Relays_nothing_while_no_destination_is_registered_and_every_destination_once_one_is()
    {
        var relay = new TestRelay().Relay;

        Assert.Null(relay.HandlerOf(7));

        var registration = relay.Register(new RecordingTarget(), Seven);

        // one it does not know is refused, not left to the router: it is asked who may learn so
        Assert.NotNull(relay.HandlerOf(7));
        Assert.NotNull(relay.HandlerOf(8));
        Assert.True(registration.Unregister());
        Assert.Null(relay.HandlerOf(7));
    }

    [Fact]
    public void Asks_before_route_first_then_whether_the_destination_is_known_then_refuses_a_subscription()
    {
        var asked = new List<string>();
        var sessionRequired = Failure.OfProtocol(ProtocolCode.SessionRequired);
        var relay = new TestRelay(new RelayOptions
        {
            BeforeRoute = new BeforeRequest(
                (request) =>
                {
                    asked.Add($"{(request.ConnectionHandle == First ? "first" : "device")} {request.Header.DestinationId}");

                    return request.ConnectionHandle == First;
                },
                sessionRequired),
        }).Relay;

        relay.Register(new RecordingTarget(), Seven);

        Func<AdmissionRequest, Failure?> AdmitOf(uint destinationId)
        {
            return relay.HandlerOf(destinationId)!.Admit;
        }

        // not admitted: the same refusal whether the destination exists or not
        Assert.Same(sessionRequired, AdmitOf(7)(new AdmissionRequest(Device, HeaderOf(1))));
        Assert.Same(sessionRequired, AdmitOf(8)(new AdmissionRequest(Device, HeaderOf(1, 8))));

        // admitted
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.DestinationUnknown, "no destination 8 behind this relay"),
            AdmitOf(8)(new AdmissionRequest(First, HeaderOf(3, 8))));
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.SubscriptionUnsupported, "this relay carries no subscription yet"),
            AdmitOf(7)(new AdmissionRequest(First, HeaderOf(5) with { OpensSubscription = true })));
        Assert.Null(AdmitOf(7)(new AdmissionRequest(First, HeaderOf(7))));
        Assert.Equal(["device 7", "device 8", "first 8", "first 7", "first 7"], asked);
    }

    // a failure carries no side here, so the other side's access denied has no twin
    [Fact]
    public void Admits_nobody_without_before_route_throws_what_before_route_throws_and_takes_an_admission_s_refusal_alone()
    {
        var relay = new TestRelay(new RelayOptions()).Relay;

        relay.Register(new RecordingTarget(), Seven);

        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.AccessDenied, "this relay admits nobody: it has no beforeRoute"),
            relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1))));

        var thrown = new InvalidOperationException("no routing today");
        var throwing = new TestRelay(new RelayOptions
        {
            BeforeRoute = new BeforeRequest((_) =>
            {
                throw thrown;
            }),
        }).Relay;

        throwing.Register(new RecordingTarget(), Seven);

        Assert.Same(thrown, Assert.Throws<InvalidOperationException>(() =>
        {
            return throwing.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1)));
        }));
        Assert.Throws<ArgumentException>(() =>
        {
            return new TestRelay(new RelayOptions
            {
                BeforeRoute = new BeforeRequest(
                    (_) =>
                    {
                        return false;
                    },
                    Failure.OfProtocol(ProtocolCode.PayloadTooLarge)),
            });
        });
    }

    [Fact]
    public async Task Answers_by_itself_a_call_a_router_hands_it_unasked_as_a_resolver_does()
    {
        var test = new TestRelay(new RelayOptions
        {
            BeforeRoute = new BeforeRequest((request) =>
            {
                return request.Header.CallId != 1;
            }),
        });
        var target = new RecordingTarget();

        test.Relay.Register(target, Seven);
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)) with { IsAdmitted = false });
        await Handled(test.Relay.HandlerOf(8), PropsOf(HeaderOf(3, 8)) with { IsAdmitted = false });
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(5)) with { IsAdmitted = false });

        Assert.Equal<object>(
            [
                Failure.OfProtocol(ProtocolCode.AccessDenied),
                Failure.OfProtocol(ProtocolCode.DestinationUnknown, "no destination 8 behind this relay"),
                new byte[] { 9 },
            ],
            FailuresOf(test.Answers));
        Assert.Single(target.Asked);

        // C# only: one its router admitted already goes on, not asked again
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)));

        Assert.Equal(2, target.Asked.Count);
    }

    [Fact]
    public void Holds_a_payload_to_the_smaller_of_the_two_legs_limits_and_to_one_envelope_of_a_target_that_takes_no_transfer()
    {
        var relay = new TestRelay().Relay;

        int? LimitOf(object target)
        {
            var destinationId = relay.Register(target, null).Destination.DestinationId;

            return relay.HandlerOf(destinationId)!.MaximumPayloadBytes;
        }

        Assert.Equal(1_000, LimitOf(new RecordingTarget(new RouterLimits { MaximumPayloadBytes = 1_000 })));

        // one envelope holds more than its limit: the limit
        Assert.Equal(500, LimitOf(new RecordingTarget(new RouterLimits { MaximumPayloadBytes = 500, MaximumTransfers = 0 })));
        Assert.Equal(
            LimitDefaults.MaximumPayloadBytes,
            LimitOf(new RecordingTarget(new RouterLimits { MaximumPayloadBytes = 1 << 30 })));

        // a request's header, 12 bytes, and the rest of an envelope of 1 024
        Assert.Equal(
            1_012,
            LimitOf(new RecordingTarget(new RouterLimits { ChunkBytes = 1_024, MaximumEnvelopeBytes = 4_096, MaximumTransfers = 0 })));

        // a connection of the relay's own: its own limits
        Assert.Equal(LimitDefaults.MaximumPayloadBytes, LimitOf(new ConnectionTarget(Device)));
    }

    [Fact]
    public async Task Asks_leg_B_the_same_service_and_procedure_with_the_payload_s_bytes_leg_A_s_signal_and_no_destination()
    {
        var test = new TestRelay();
        var target = new RecordingTarget(new RouterLimits { MaximumPayloadBytes = 1_000 });
        var header = HeaderOf(1);

        using var source = new CancellationTokenSource();

        var props = PropsOf(header) with { Payload = new byte[] { 4, 5 }, Signal = source.Token };

        test.Relay.Register(target, Seven);
        await Handled(test.Relay.HandlerOf(7), props);

        var asked = Assert.Single(target.Asked);

        Assert.Equal(new ResolvedRequestOptions { CancellationToken = source.Token, Timeout = Infinite }, asked.Options);
        Assert.Equal(new byte[] { 4, 5 }, asked.Payload.ToArray());
        Assert.Equal(
            new Procedure
            {
                MaximumPayloadBytes = 1_000,
                ProcedureId = 1,
                ProcedureName = "2/1 to 7",
                ServiceId = 2,
                ServiceRevision = 0,
            },
            asked.Procedure);

        // answered with the very header dispatched, which pairs the answer with its call
        var (answer, answered) = Assert.Single(test.Answers);

        Assert.Null(answer.Failure);
        Assert.Equal(new byte[] { 9 }, answer.Payload.ToArray());
        Assert.Equal(new AnswerTarget(First, header), answered);
        Assert.Same(header, answered.Header);
    }

    [Fact]
    public async Task Asks_a_connection_of_its_own_by_its_own_router_s_request_naming_that_connection()
    {
        var test = new TestRelay();

        using var source = new CancellationTokenSource();

        test.Relay.Register(new ConnectionTarget(Device), Seven);
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)) with { Signal = source.Token });

        Assert.Equal(
            new ResolvedRequestOptions { CancellationToken = source.Token, ConnectionHandle = Device, Timeout = Infinite },
            Assert.Single(test.Own).Options);

        // a relay told nothing of what its connections take passes a request on to any
        Assert.Null(test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(3))));
        Assert.Equal<object>([new byte[] { 8 }], FailuresOf(test.Answers));
    }

    [Fact]
    public async Task Passes_on_a_failure_of_the_target_s_one_relay_more_saturated_at_255_as_it_came()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();

        test.Relay.Register(target, Seven);

        foreach (var (relays, origin, scope) in new (byte, FailureOrigin, FailureScope)[]
        {
            (0, FailureOrigin.Peer, FailureScope.Application),
            (0, FailureOrigin.Peer, FailureScope.Protocol),
            (3, FailureOrigin.Relayed, FailureScope.Protocol),
            (254, FailureOrigin.Relayed, FailureScope.Protocol),
            (255, FailureOrigin.Relayed, FailureScope.Protocol),
        })
        {
            target.Settle = Refusing(
                new FailureException(
                    new Failure { Code = 19, Detail = "its own detail", Relays = relays, Scope = scope },
                    new FailureException.Raised(origin, origin == FailureOrigin.Peer ? RouterSide.Server : null)),
                Reach.Handed);
            await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)));
        }

        Failure RelayedOf(byte relays, FailureScope scope)
        {
            return new Failure { Code = 19, Detail = "its own detail", Relays = relays, Scope = scope };
        }

        Assert.Equal(
            [
                RelayedOf(1, FailureScope.Application),
                RelayedOf(1, FailureScope.Protocol),
                RelayedOf(4, FailureScope.Protocol),
                RelayedOf(255, FailureScope.Protocol),
                RelayedOf(255, FailureScope.Protocol),
            ],
            test.Answers.Select((answered) =>
            {
                return answered.Answer.Failure;
            }));
    }

    // a task faults with an exception alone: a reason that is no error has no twin
    [Fact]
    public async Task Passes_on_a_limit_of_leg_B_s_before_the_hand_off_as_its_own_and_tells_a_request_never_tried_from_one_lost_after()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();
        var tooLarge = FailureException.OfProtocol(ProtocolCode.PayloadTooLarge, RouterSide.Client, "a payload is 8 bytes at most, not 9");

        test.Relay.Register(target, Seven);

        foreach (var (reason, reach) in new (Exception, Reach)[]
        {
            (tooLarge, Reach.Never),

            // its result, past leg B's limit: the procedure ran
            (tooLarge, Reach.Handed),
            (FailureException.OfProtocol(ProtocolCode.CapacityExceeded, RouterSide.Client, $"every call id of {Device} is in use"), Reach.Never),
            (new IOException("the socket is closed"), Reach.Never),
            (new IOException("the socket refused it"), Reach.Refused),
            (new DisconnectException("the relay’s router was disposed"), Reach.Never),
            (new DisconnectException("the connection closed before the answer"), Reach.Handed),
            (new TimeoutException("no answer came in 250 milliseconds"), Reach.Handed),
            (FailureException.OfProtocol(ProtocolCode.TransferStalled, RouterSide.Client, "nothing came"), Reach.Handed),

            // any other refusal of leg B's own before the hand-off: nothing was tried
            (FailureException.OfProtocol(ProtocolCode.TransferStalled, RouterSide.Client, "nothing came"), Reach.Never),
        })
        {
            target.Settle = Refusing(reason, reach);
            await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)));
        }

        var unreachable = Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: nothing was tried");
        var lost = Failure.OfProtocol(
            ProtocolCode.DestinationLost,
            "destination 7 was lost once handed the request: the procedure may have run");

        // no address behind the relay reaches leg A: what leg B failed with is reported instead
        Assert.Equal<object>(
            [
                Failure.OfProtocol(ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"),
                lost,
                Failure.OfProtocol(ProtocolCode.CapacityExceeded, "destination 7 takes no more calls at once"),
                unreachable,
                unreachable,
                unreachable,
                lost,
                lost,
                lost,
                unreachable,
            ],
            FailuresOf(test.Answers));
        Assert.Equal(
            [
                (tooLarge.Message, true),
                ("the socket is closed", true),
                ("the socket refused it", true),
                ("the relay’s router was disposed", true),
                ("the connection closed before the answer", true),
                ("no answer came in 250 milliseconds", true),
                ("local client protocol failure 51 TRANSFER_STALLED: nothing came", true),
                ("local client protocol failure 51 TRANSFER_STALLED: nothing came", true),
            ],
            test.Reports);

        // a limit of leg B's own crossed no relay, whatever relays it says it crossed
        target.Settle = Refusing(
            new FailureException(tooLarge.Failure with { Relays = 3 }, new FailureException.Raised(FailureOrigin.Local, RouterSide.Client)),
            Reach.Never);
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(3)));

        Assert.Equal(Failure.OfProtocol(ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"), test.Answers[^1].Answer.Failure);
    }

    [Fact]
    public async Task Answers_nothing_once_leg_A_ended_leg_B_cancelled_by_the_same_signal_rejects()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();

        using var source = new CancellationTokenSource();

        test.Relay.Register(target, Seven);
        target.Settle = (onSent) =>
        {
            onSent(true);
            source.Cancel();

            return Task.FromException<RouterResult>(new OperationCanceledException("call 2 was cancelled"));
        };
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)) with { Signal = source.Token });

        Assert.Empty(test.Answers);
    }

    [Fact]
    public async Task Answers_as_failed_once_what_leg_A_cannot_carry_and_lets_why_be_reported()
    {
        var test = new TestRelay();
        var tooLarge = FailureException.OfProtocol(ProtocolCode.PayloadTooLarge, RouterSide.Server, "a payload is 8 bytes at most, not 9");
        var gone = new IOException("the socket is closed");

        test.Relay.Register(new RecordingTarget(), Seven);
        test.RespondErrors.Enqueue(tooLarge);

        Assert.Same(tooLarge, await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(1)));
        }));

        // the second cannot go out either: it goes nowhere, and the first reason is the one reported
        test.RespondErrors.Enqueue(gone);
        test.RespondErrors.Enqueue(new IOException("still closed"));

        Assert.Same(gone, await Assert.ThrowsAsync<IOException>(() =>
        {
            return Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(3)));
        }));
        Assert.Equal<object>(
            [
                new byte[] { 9 },
                Failure.OfProtocol(ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"),
                new byte[] { 9 },
                Failure.OfProtocol(ProtocolCode.ProcedureFailed, "the socket is closed"),
            ],
            FailuresOf(test.Answers));

        // C# only: a failure of leg A's own crossed no relay, whatever relays it says it crossed
        test.RespondErrors.Enqueue(
            new FailureException(tooLarge.Failure with { Relays = 3 }, new FailureException.Raised(FailureOrigin.Local, RouterSide.Server)));
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(5)));
        });

        Assert.Equal(Failure.OfProtocol(ProtocolCode.PayloadTooLarge, "a payload is 8 bytes at most, not 9"), test.Answers[^1].Answer.Failure);
    }

    // a destination is a uint here: one below 0, past 2³² − 1 or not whole has no twin
    [Fact]
    public void Registers_a_destination_given_or_drawn_never_0_nor_one_taken_lists_them_and_takes_out_its_own_alone()
    {
        var relay = new TestRelay().Relay;
        var target = new RecordingTarget();
        var seven = relay.Register(target, new DestinationOptions { DestinationId = 7, Label = "north" });
        var drawn = relay.Register(target, null).Destination.DestinationId;

        Assert.Equal(new Destination(7, "north"), seven.Destination);
        Assert.InRange(drawn, 1u, uint.MaxValue);
        Assert.NotEqual(7u, drawn);

        foreach (var destinationId in new uint[] { 7, 0 })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return relay.Register(target, new DestinationOptions { DestinationId = destinationId });
            });
        }

        Assert.Equal([new Destination(7, "north"), new Destination(drawn, null)], relay.Destinations());

        // taken out, then registered again: the first registration's own no longer takes it out
        Assert.True(seven.Unregister());

        var again = relay.Register(target, Seven);

        Assert.False(seven.Unregister());
        Assert.Equal([new Destination(drawn, null), new Destination(7, null)], relay.Destinations());
        Assert.True(again.Unregister());
    }

    [Fact]
    public void Draws_a_destination_again_when_0_or_in_use()
    {
        // its TypeScript twin, identifiers.test.ts:184, draws through the shared identifiers, a module
        // this side does not have: its draw is the relay's own
        var fills = new Queue<byte[]>([[0, 0, 0, 0], [0, 0, 0, 5], [0, 0, 1, 7]]);
        var relay = new TestRelay(Admitting with
        {
            Fill = (bytes) =>
            {
                (fills.TryDequeue(out var fill) ? fill : [0, 0, 0, 9]).CopyTo(bytes);
            },
        }).Relay;
        var target = new RecordingTarget();

        relay.Register(target, new DestinationOptions { DestinationId = 5 });

        Assert.Equal(263u, relay.Register(target, null).Destination.DestinationId);
        Assert.Empty(fills);
    }

    [Fact]
    public async Task Binds_a_call_to_its_destination_as_it_opens_one_registered_in_its_place_later_takes_nothing_of_it()
    {
        var relay = new TestRelay().Relay;
        var before = new RecordingTarget();
        var after = new RecordingTarget();
        var registration = relay.Register(before, Seven);
        var handler = relay.HandlerOf(7);

        registration.Unregister();
        relay.Register(after, Seven);
        await Handled(handler, PropsOf(HeaderOf(1)));

        Assert.Equal([1, 0], new[] { before.Asked.Count, after.Asked.Count });
    }

    // -1 ms is .NET's infinite, so -2 ms stands for a negative; a timeout is never NaN here
    [Fact]
    public async Task Waits_on_leg_B_as_long_as_the_destination_says_the_relay_s_timeout_at_most_or_on()
    {
        var relay = new TestRelay(Admitting with { Timeout = TimeSpan.FromSeconds(5) }).Relay;
        var unbounded = new TestRelay().Relay;
        var target = new RecordingTarget();

        relay.Register(target, Seven);
        relay.Register(target, new DestinationOptions { DestinationId = 8, Timeout = TimeSpan.FromMilliseconds(250) });
        relay.Register(target, new DestinationOptions { DestinationId = 9, Timeout = TimeSpan.FromMinutes(1) });
        unbounded.Register(target, Seven);
        unbounded.Register(target, new DestinationOptions { DestinationId = 8, Timeout = TimeSpan.FromMilliseconds(250) });

        foreach (var each in new[] { relay, unbounded })
        {
            await Handled(each.HandlerOf(7), PropsOf(HeaderOf(1)));
            await Handled(each.HandlerOf(8), PropsOf(HeaderOf(3, 8)));
        }

        await Handled(relay.HandlerOf(9), PropsOf(HeaderOf(5, 9)));

        Assert.Equal(
            [TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(250), Infinite, TimeSpan.FromMilliseconds(250), TimeSpan.FromSeconds(5)],
            target.Asked.Select((asked) =>
            {
                return asked.Options.Timeout;
            }));
    }

    [Fact]
    public async Task Holds_a_relay_s_timeout_and_a_destination_s_to_a_whole_number_of_milliseconds_refusing_zero_infinite_waiting_on()
    {
        foreach (var (given, outcome, refusal) in Durations.Of("a relay's timeout", (DurationOutcome.Refused, DurationOutcome.Taken)))
        {
            var relay = new TestRelay().Relay;
            var target = new RecordingTarget();

            if (outcome == DurationOutcome.Refused)
            {
                foreach (var refused in new[]
                {
                    Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        return relay.Register(target, new DestinationOptions { Timeout = given });
                    }),
                    Assert.Throws<ArgumentOutOfRangeException>(() =>
                    {
                        return new TestRelay(new RelayOptions { Timeout = given });
                    }),
                })
                {
                    Assert.StartsWith(refusal!, refused.Message, StringComparison.Ordinal);
                    Assert.Equal(nameof(RelayOptions.Timeout), refused.ParamName);
                }

                continue;
            }

            relay.Register(target, Seven with { Timeout = given });
            await Handled(relay.HandlerOf(7), PropsOf(HeaderOf(1)));
            Assert.Equal(
                [given],
                target.Asked.Select((asked) =>
                {
                    return asked.Options.Timeout;
                }));
            _ = new TestRelay(new RelayOptions { Timeout = given });
        }
    }

    [Fact]
    public async Task Passes_nothing_on_to_a_connection_of_its_own_that_takes_no_request_of_the_relay_s()
    {
        var answers = new List<RouterAnswer>();
        var own = new List<ReadOnlyMemory<byte>>();
        var relay = new Relay(
            new RelayRouter
            {
                IsTwoWay = (connectionHandle) =>
                {
                    return connectionHandle != Device;
                },
                Limits = RouterLimits.Default,
                Report = (_, _) =>
                {
                },
                Request = (payload, _) =>
                {
                    own.Add(payload);

                    return Answering(new byte[] { 8 })(Unheard);
                },
                Respond = (answer, _) =>
                {
                    answers.Add(answer);

                    return Task.CompletedTask;
                },
            },
            Admitting);

        relay.Register(new ConnectionTarget(Device), Seven);
        relay.Register(new ConnectionTarget(First), new DestinationOptions { DestinationId = 8 });

        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its connection carries no request"),
            relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1))));

        await Handled(relay.HandlerOf(8), PropsOf(HeaderOf(3, 8)));

        var answer = Assert.Single(answers);

        Assert.Null(answer.Failure);
        Assert.Equal(new byte[] { 8 }, answer.Payload.ToArray());
        Assert.Single(own);
    }

    [Fact]
    public async Task Leaves_a_connection_of_its_own_unreachable_once_it_closed_whoever_takes_its_handle_next_until_registered_anew()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();
        var closed = test.Relay.Register(new ConnectionTarget(Device), Seven);

        test.Relay.Register(new ConnectionTarget(First), new DestinationOptions { DestinationId = 8 });
        test.Relay.Register(target, new DestinationOptions { DestinationId = 9 });

        // admitted as its payload came, then its connection closed: nothing is handed over
        var admitted = test.Relay.HandlerOf(7);

        test.Relay.CloseConnection(Device);

        var unreachable = Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its connection closed");

        Assert.Equal(unreachable, test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1))));

        // C# only: a subscription is refused before a connection closed, as the TypeScript side checks
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.SubscriptionUnsupported, "this relay carries no subscription yet"),
            test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1) with { OpensSubscription = true })));
        await Handled(admitted, PropsOf(HeaderOf(3)));

        // the others are reached still
        await Handled(test.Relay.HandlerOf(8), PropsOf(HeaderOf(5, 8)));
        await Handled(test.Relay.HandlerOf(9), PropsOf(HeaderOf(7, 9)));

        Assert.Equal<object>([unreachable, new byte[] { 8 }, new byte[] { 9 }], FailuresOf(test.Answers));
        Assert.Equal([First], test.Own.Select(HandleOf));
        Assert.Single(target.Asked);

        // it stays registered, and listed, until the application takes it out: its id is not free
        Assert.Contains(new Destination(7, null), test.Relay.Destinations());
        Assert.Throws<ArgumentException>(() =>
        {
            return test.Relay.Register(new ConnectionTarget(Device), Seven);
        });
        Assert.True(closed.Unregister());

        test.Relay.Register(new ConnectionTarget(Device), Seven);
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(9)));

        Assert.Equal([First, Device], test.Own.Select(HandleOf));
    }

    [Fact]
    public void Counts_its_destinations_those_whose_connection_closed_among_them_and_keeps_none_for_a_connection()
    {
        var relay = new TestRelay().Relay;

        relay.Register(new RecordingTarget(), new DestinationOptions { DestinationId = 3 });
        relay.Register(new ConnectionTarget(Device), new DestinationOptions { DestinationId = 5 });
        relay.Register(new ConnectionTarget(First), new DestinationOptions { DestinationId = 7 });
        relay.CloseConnection(Device);

        var gauges = relay.Gauges();

        Assert.Empty(gauges.Anomalies);
        Assert.Empty(gauges.Ceilings);
        Assert.Empty(gauges.ConnectionHandles);
        Assert.Equal(new Dictionary<string, long> { ["closedDestinations"] = 1, ["destinations"] = 3 }, gauges.Counts);
    }

    // how far a leg B request went before it failed: never handed over, handed, or handed then refused
    private enum Reach
    {
        Handed,
        Never,
        Refused,
    }

    // what a leg B request was asked with
    private sealed record Asked(ResolvedRequestOptions Options, ReadOnlyMemory<byte> Payload, Procedure Procedure);

    // a client's router a destination names, which records what it is asked and settles as told
    private sealed class RecordingTarget(RouterLimits? limits = null) : IRouterTarget
    {
        public RouterLimits Limits { get; } = limits ?? RouterLimits.Default;

        public List<Asked> Asked { get; } = [];

        public Func<Action<bool>, Task<RouterResult>> Settle { get; set; } = Answering(new byte[] { 9 });

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            ArgumentNullException.ThrowIfNull(request);
            Asked.Add(new Asked(request.Options, payload, request.Procedure));

            return Settle(request.OnSent ?? Unheard);
        }
    }

    // a relay under the options given — admitting every request unless they say otherwise — which
    // records each answer it writes, with the request it answers, each request of its own router's
    // it makes, and each error it reports, as its message and whether leg A's connection came with it
    private sealed class TestRelay
    {
        public TestRelay(RelayOptions? options = null)
        {
            Relay = new Relay(
                new RelayRouter
                {
                    IsTwoWay = (_) =>
                    {
                        return true;
                    },
                    Limits = RouterLimits.Default,
                    Report = (error, connectionHandle) =>
                    {
                        Reports.Add((error.Message, connectionHandle == First));
                    },
                    Request = (payload, request) =>
                    {
                        Own.Add(new Asked(request.Options, payload, request.Procedure));

                        return Settle(request.OnSent ?? Unheard);
                    },
                    Respond = (answer, target) =>
                    {
                        Answers.Add((answer, target));

                        return RespondErrors.TryDequeue(out var error) ? Task.FromException(error) : Task.CompletedTask;
                    },
                },
                options ?? Admitting);
        }

        public Relay Relay { get; }

        public List<(RouterAnswer Answer, AnswerTarget Target)> Answers { get; } = [];

        public List<Asked> Own { get; } = [];

        public List<(string Message, bool IsLegA)> Reports { get; } = [];

        // what each answer throws, in turn, while there is one
        public Queue<Exception> RespondErrors { get; } = [];

        public Func<Action<bool>, Task<RouterResult>> Settle { get; set; } = Answering(new byte[] { 8 });
    }
}
