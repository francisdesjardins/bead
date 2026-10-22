using System.Diagnostics.CodeAnalysis;

namespace Bead.Tests;

/// <summary>
/// <see cref="Relay"/>: who it admits, the limits it holds a payload to, leg B as it asks it and the
/// answer leg A then hears, and its destinations, over a router that records every answer, request
/// and report, and targets that record what they are asked.
/// </summary>
public sealed class RelayTests
{
    // constants

    private const string First = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private const string Device = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";

    // the connection the device opened next, under a handle its transport never gave
    private const string Second = "type=WS;ip=127.0.0.1;port=50002;ordinal=2";

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

    // a JWT read without verifying it, its aud the one given; its signature none verifies
    private static Credential JwtFor(string audience)
    {
        var part = (string json) =>
        {
            return System.Buffers.Text.Base64Url.EncodeToString(System.Text.Encoding.UTF8.GetBytes(json));
        };

        return Credential.Jwt($"{part("{\"alg\":\"HS256\",\"typ\":\"at+jwt\"}")}.{part("{\"aud\":\"" + audience + "\"}")}.c2ln");
    }

    // an OPAQUE's token, any
    private static Credential Opaque()
    {
        return Credential.Opaque(SessionToken.FromBytes(Enumerable.Repeat((byte)7, SessionToken.Bytes).ToArray()));
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
    public void Takes_the_audience_each_destination_verifies_gives_the_set_of_them_and_refuses_one_not_of_well_formed_Unicode()
    {
        var relay = new TestRelay().Relay;

        relay.Register(new RecordingTarget(), Seven with { Audience = "bead-interop" });
        relay.Register(new RecordingTarget(), new DestinationOptions { Audience = "bead-other", DestinationId = 8 });
        relay.Register(new RecordingTarget(), new DestinationOptions { Audience = "bead-interop", DestinationId = 9 });
        relay.Register(new RecordingTarget(), new DestinationOptions { DestinationId = 10 });

        Assert.Equal(["bead-interop", "bead-other"], relay.Audiences());
        Assert.Throws<ArgumentException>(() =>
        {
            return relay.Register(new RecordingTarget(), new DestinationOptions { Audience = "\ud800", DestinationId = 11 });
        });
        Assert.Equal(4, relay.Destinations().Count);
    }

    [Fact]
    public void Answers_an_ELSEWHERE_whose_transport_carried_nothing_DESTINATION_UNREACHABLE_to_a_leg_B_that_carries_a_credential_as_to_any_other()
    {
        var relay = new TestRelay(null, true).Relay;

        relay.Register(new RecordingTarget(), new DestinationOptions { Audience = "bead-interop", DestinationId = 9 });
        relay.Register(new ConnectionTarget(Device), new DestinationOptions { Audience = "bead-interop", DestinationId = 10 });

        ushort? CodeOf(uint destinationId, string? carried)
        {
            var header = HeaderOf(1, destinationId) with { Credential = Credential.Elsewhere() };

            return relay.HandlerOf(header)!.Admit(new AdmissionRequest(First, header) { TransportCredential = carried })?.Code;
        }

        Assert.All(new uint[] { 9, 10 }, (destinationId) =>
        {
            Assert.Equal((ushort)ProtocolCode.DestinationUnreachable, CodeOf(destinationId, null));
            Assert.Null(CodeOf(destinationId, "Interop sub=ada"));
        });
    }

    [Fact]
    public void Forwards_a_credential_unresolved_unless_it_verifies_as_each_of_its_handlers_says_to_a_destination_registered_or_not()
    {
        var forwarding = new TestRelay().Relay;
        var verifying = new TestRelay(Admitting with { Verifies = true }).Relay;

        forwarding.Register(new RecordingTarget(), Seven);
        verifying.Register(new RecordingTarget(), Seven);

        Assert.True(forwarding.HandlerOf(7)!.ForwardsCredentials);
        Assert.True(forwarding.HandlerOf(99)!.ForwardsCredentials);
        Assert.False(verifying.HandlerOf(7)!.ForwardsCredentials);
        Assert.False(verifying.HandlerOf(99)!.ForwardsCredentials);
    }

    [Fact]
    public void Answers_a_call_leg_B_cannot_carry_DESTINATION_UNREACHABLE_nothing_tried_a_JWT_whose_aud_names_not_its_destination_s_audience_or_to_one_of_none_an_ELSEWHERE_to_one_of_none_or_over_a_leg_B_that_carries_none_either_in_the_clear()
    {
        var relay = new TestRelay().Relay;
        var interop = JwtFor("bead-interop");

        relay.Register(new RecordingTarget(), Seven with { Audience = "bead-other" });
        relay.Register(new RecordingTarget(), new DestinationOptions { DestinationId = 8 });
        relay.Register(new RecordingTarget { CarriesCredential = false }, new DestinationOptions { Audience = "bead-interop", DestinationId = 9 });
        relay.Register(new RecordingTarget { IsSecure = false }, new DestinationOptions { Audience = "bead-interop", DestinationId = 10 });
        relay.Register(new RecordingTarget(), new DestinationOptions { Audience = "bead-interop", DestinationId = 11 });

        Failure? RefusalOf((uint DestinationId, Credential? Credential) call)
        {
            var header = HeaderOf(1, call.DestinationId) with { Credential = call.Credential };

            return relay.HandlerOf(header)!.Admit(new AdmissionRequest(First, header) { TransportCredential = "Interop sub=ada" });
        }

        static Failure Unreachable((uint DestinationId, string Why) refused)
        {
            return Failure.OfProtocol(ProtocolCode.DestinationUnreachable, $"destination {refused.DestinationId} is unreachable: {refused.Why}");
        }

        const string Audience = "it verifies another audience than the one the token names, or none";
        const string InTheClear = "its transport leaves the machine in the clear, which a bearer credential never crosses";

        // a JWT whose aud names another, or none, or that does not read
        Assert.Equal(
            [
                Unreachable((7, Audience)),
                Unreachable((8, Audience)),
                Unreachable((8, "it was registered with no audience")),
                Unreachable((9, "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another")),
                Unreachable((10, InTheClear)),
                Unreachable((10, InTheClear)),
                Unreachable((11, Audience)),
            ],
            new (uint, Credential?)[]
            {
                (7, interop),
                (8, interop),
                (8, Credential.Elsewhere()),
                (9, Credential.Elsewhere()),
                (10, interop),
                (10, Credential.Elsewhere()),
                (11, Credential.Jwt("a.b.c")),
            }.Select(RefusalOf));

        // what it can carry goes on; none and OPAQUE cross any leg B
        Assert.All(
            new (uint, Credential?)[] { (11, interop), (11, Credential.Elsewhere()), (9, interop), (8, null), (10, Opaque()) },
            (call) =>
            {
                Assert.Null(RefusalOf(call));
            });
    }

    [Fact]
    public async Task Answers_an_ELSEWHERE_DESTINATION_UNREACHABLE_over_a_leg_B_whose_upgrade_carried_the_relay_s_own_credential()
    {
        var test = new TestRelay();
        var relay = test.Relay;
        var target = new RecordingTarget { CarriedByUpgrade = "Interop sub=relay" };

        // a WebSocket leg B, its upgrade carrying the relay's own credential
        relay.Register(target, Seven with { Audience = "bead-interop" });

        Failure? RefusalOf(string carried)
        {
            var header = HeaderOf(1) with { Credential = Credential.Elsewhere() };

            return relay.HandlerOf(header)!.Admit(new AdmissionRequest(First, header) { TransportCredential = carried });
        }

        // ! leg A's credential never rides on the relay's: the confused deputy stays shut
        var refused = RefusalOf("Interop sub=ada");

        Assert.Equal(
            ((ushort)ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"),
            (refused?.Code, refused?.Detail));

        var header = HeaderOf(1) with { Credential = Credential.Elsewhere() };

        await Handled(relay.HandlerOf(header), PropsOf(header) with { IsAdmitted = false, TransportCredential = "Interop sub=ada" });
        Assert.Equal<object>([refused!], FailuresOf(test.Answers));
        Assert.Empty(target.Asked);
        Assert.Empty(test.Own);

        // the very bytes its upgrade carried go
        Assert.Null(RefusalOf("Interop sub=relay"));
    }

    [Fact]
    public async Task Presents_on_leg_B_what_leg_A_does_a_JWT_s_same_bytes_an_ELSEWHERE_with_what_leg_A_s_transport_carried_none_for_none_or_OPAQUE()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();
        var interop = JwtFor("bead-interop");

        test.Relay.Register(target, Seven with { Audience = "bead-interop" });

        foreach (var (callId, credential) in new (uint, Credential?)[] { (1, interop), (3, Credential.Elsewhere()), (5, null), (7, Opaque()) })
        {
            var header = HeaderOf(callId) with { Credential = credential };

            await Handled(test.Relay.HandlerOf(header), PropsOf(header) with { TransportCredential = "Interop sub=ada" });
        }

        Assert.Equal(
            [interop, Credential.Elsewhere("Interop sub=ada"), Credential.None, Credential.None],
            target.Asked.Select((asked) =>
            {
                return asked.Options.Credential!.Value;
            }));
        Assert.Equal(4, test.Answers.Count);
    }

    [Fact]
    public async Task Answers_leg_A_PAYLOAD_TOO_LARGE_the_relay_s_own_and_not_reported_for_a_JWT_that_came_whole_and_leaves_leg_B_s_opening_no_room()
    {
        // leg B: a router whose envelopes hold 1,024 bytes, so 100 bytes behind a JWT of 1,000 go as a
        // transfer, whose opening's header of 1,024 bytes passes 1,020
        var transport = new SilentTransport();
        using var legB = new RouterClient(
            transport,
            new RouterClientOptions { Limits = new RouterLimits { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, WindowBytes = 2_048 } });
        var test = new TestRelay();
        var jwt = Credential.Jwt(JwtFor("bead-interop").Token!.PadRight(1_000, 'A'));

        test.Relay.Register(legB, Seven with { Audience = "bead-interop" });

        // whole on leg A: 1,020 bytes of header beside its destination, then its payload
        var header = HeaderOf(1) with { Credential = jwt };

        await Handled(test.Relay.HandlerOf(header), PropsOf(header) with { Payload = new byte[100] });

        Assert.Equal<object>(
            [Failure.OfProtocol(ProtocolCode.PayloadTooLarge, "a payload of 100 bytes goes as a transfer, whose opening's header of 1024 bytes passes 1020")],
            FailuresOf(test.Answers));
        Assert.Empty(test.Reports);
        Assert.Equal(0, transport.Sent);
    }

    [Fact]
    public void Holds_a_payload_to_what_one_envelope_holds_behind_leg_B_s_header_with_its_credential_call_by_call_for_a_target_that_takes_no_transfer()
    {
        var relay = new TestRelay().Relay;
        var whole = new RouterLimits { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, MaximumTransfers = 0, WindowBytes = 2_048 };

        relay.Register(new RecordingTarget(whole), Seven);

        int? LimitOf(Credential? credential)
        {
            return relay.HandlerOf(HeaderOf(1) with { Credential = credential })!.MaximumPayloadBytes;
        }

        // 12 bytes of header; a JWT's block, 4 and its token padded to a word; an ELSEWHERE's, 4
        Assert.Equal(1_012, LimitOf(null));
        Assert.Equal(1_012, LimitOf(Opaque()));
        Assert.Equal(1_024 - 316, LimitOf(Credential.Jwt(new string('a', 300))));
        Assert.Equal(1_008, LimitOf(Credential.Elsewhere()));
    }

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
        Assert.Equal(sessionRequired, AdmitOf(7)(new AdmissionRequest(Device, HeaderOf(1))));
        Assert.Equal(sessionRequired, AdmitOf(8)(new AdmissionRequest(Device, HeaderOf(1, 8))));

        // admitted
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.DestinationUnknown, "no destination 8 behind this relay"),
            AdmitOf(8)(new AdmissionRequest(First, HeaderOf(3, 8))));
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.SubscriptionUnsupported, "this relay carries no subscription"),
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

        // one its router admitted already goes on, not asked again
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

        // presenting none, as leg A did, whatever its target presents by default
        Assert.Equal(new ResolvedRequestOptions { CancellationToken = source.Token, Credential = Credential.None, Timeout = Infinite }, asked.Options);
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
            new ResolvedRequestOptions { CancellationToken = source.Token, ConnectionHandle = Device, Credential = Credential.None, Timeout = Infinite },
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
    [SuppressMessage(
        "Usage",
        "VSTHRD103:Call async methods when in an async method",
        Justification = "leg A's signal is cancelled while leg B's call is in flight, its callbacks run before the call settles; CancelAsync would run them later")]
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
        Assert.Empty(test.Reports);
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
        // the relay's own draw, from the bytes the test fills
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
    public async Task Leaves_a_connection_of_its_own_unreachable_once_it_closed_until_registered_anew_on_another_connection()
    {
        var test = new TestRelay();
        var target = new RecordingTarget();
        var closed = test.Relay.Register(new ConnectionTarget(Device), Seven);

        test.Relay.Register(new ConnectionTarget(First), new DestinationOptions { DestinationId = 8 });
        test.Relay.Register(target, new DestinationOptions { DestinationId = 9 });

        // admitted as its payload came, then its connection closed: nothing is handed over
        var admitted = test.Relay.HandlerOf(7);

        test.Close(Device);

        var unreachable = Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its connection closed");

        Assert.Equal(unreachable, test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1))));

        // a subscription is refused before a connection closed
        Assert.Equal(
            Failure.OfProtocol(ProtocolCode.SubscriptionUnsupported, "this relay carries no subscription"),
            test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1) with { OpensSubscription = true })));
        await Handled(admitted, PropsOf(HeaderOf(3)));

        // the others are reached still
        await Handled(test.Relay.HandlerOf(8), PropsOf(HeaderOf(5, 8)));
        await Handled(test.Relay.HandlerOf(9), PropsOf(HeaderOf(7, 9)));

        Assert.Equal<object>([unreachable, new byte[] { 8 }, new byte[] { 9 }], FailuresOf(test.Answers));
        Assert.Equal([First], test.Own.Select(HandleOf));
        Assert.Single(target.Asked);

        // it stays registered, and listed closed, until the application takes it out: its id is not
        // free
        Assert.Contains(new Destination(7, null) { IsClosed = true }, test.Relay.Destinations());
        Assert.Throws<ArgumentException>(() =>
        {
            return test.Relay.Register(new ConnectionTarget(Second), Seven);
        });
        Assert.True(closed.Unregister());

        // registered anew, on another connection, it is asked
        test.Relay.Register(new ConnectionTarget(Second), Seven);
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(9)));

        Assert.Equal([First, Second], test.Own.Select(HandleOf));
    }

    [Fact]
    public void Lists_whether_each_destination_s_connection_closed_as_its_registration_says_it_now()
    {
        var test = new TestRelay();
        var onDevice = test.Relay.Register(new ConnectionTarget(Device), new DestinationOptions { DestinationId = 3 });
        var onFirst = test.Relay.Register(new ConnectionTarget(First), new DestinationOptions { DestinationId = 5 });
        var behind = test.Relay.Register(new RecordingTarget(), new DestinationOptions { DestinationId = 7, Label = "behind" });

        Assert.Equal([false, false, false], [onDevice.Destination.IsClosed, onFirst.Destination.IsClosed, behind.Destination.IsClosed]);

        test.Close(Device);

        Assert.Equal(
            [new Destination(3, null) { IsClosed = true }, new Destination(5, null), new Destination(7, "behind")],
            test.Relay.Destinations());
        Assert.Equal([true, false, false], [onDevice.Destination.IsClosed, onFirst.Destination.IsClosed, behind.Destination.IsClosed]);
    }

    [Fact]
    public async Task Takes_the_place_of_the_registration_it_replaces_at_once_which_takes_nothing_out_after_and_refuses_one_that_does_not_hold_its_destination()
    {
        var test = new TestRelay();
        var replaced = test.Relay.Register(new ConnectionTarget(Device), new DestinationOptions { DestinationId = 7, Label = "a" });

        test.Close(Device);

        // bound to the one replaced, a call finishes with it; the next goes to the one in its place,
        // and none in between finds the destination unknown
        var bound = test.Relay.HandlerOf(7);
        var replacing = test.Relay.Register(new ConnectionTarget(Second), new DestinationOptions { Label = "b", Replaces = replaced });

        await Handled(bound, PropsOf(HeaderOf(1)));
        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(3)));

        Assert.Equal(7u, replacing.Destination.DestinationId);
        Assert.Equal<object>(
            [Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its connection closed"), new byte[] { 8 }],
            FailuresOf(test.Answers));
        Assert.Equal([Second], test.Own.Select(HandleOf));
        Assert.Equal([new Destination(7, "b")], test.Relay.Destinations());
        Assert.False(replaced.Unregister());

        // one open is replaced as well: whether to is the application's
        var again = test.Relay.Register(new ConnectionTarget(First), new DestinationOptions { Replaces = replacing });

        // a registration replaced already, or named beside another destination, holds nothing to replace
        foreach (var options in new DestinationOptions[]
        {
            new() { Replaces = replaced },
            new() { Replaces = replacing },
            new() { DestinationId = 9, Replaces = again },
        })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return test.Relay.Register(new ConnectionTarget(First), options);
            });
        }

        // nor one taken out
        Assert.True(again.Unregister());
        Assert.Throws<ArgumentException>(() =>
        {
            return test.Relay.Register(new ConnectionTarget(First), new DestinationOptions { Replaces = again });
        });
        Assert.Empty(test.Relay.Destinations());
    }

    [Fact]
    public async Task Registers_a_connection_its_router_no_longer_holds_closed_and_forwards_nothing_to_it()
    {
        var test = new TestRelay();

        test.Close(Device);

        var registration = test.Relay.Register(new ConnectionTarget(Device), Seven);
        var unreachable = Failure.OfProtocol(ProtocolCode.DestinationUnreachable, "destination 7 is unreachable: its connection closed");

        Assert.True(registration.Destination.IsClosed);
        Assert.Equal([new Destination(7, null) { IsClosed = true }], test.Relay.Destinations());
        Assert.Equal(unreachable, test.Relay.HandlerOf(7)!.Admit(new AdmissionRequest(First, HeaderOf(1))));

        await Handled(test.Relay.HandlerOf(7), PropsOf(HeaderOf(3)));

        Assert.Equal<object>([unreachable], FailuresOf(test.Answers));
        Assert.Empty(test.Own);
        Assert.Equal(new Dictionary<string, long> { ["closedDestinations"] = 1, ["destinations"] = 1 }, test.Relay.Gauges().Counts);
    }

    [Fact]
    public void Refuses_an_id_taken_while_the_close_of_its_connection_is_not_heard_yet_and_closes_with_it_a_registration_that_replaced_it_then()
    {
        var test = new TestRelay();
        var taken = test.Relay.Register(new ConnectionTarget(Device), Seven);

        // its connection gone, its router not told yet: the destination is open, and taken
        Assert.Throws<ArgumentException>(() =>
        {
            return test.Relay.Register(new ConnectionTarget(Second), Seven);
        });
        Assert.False(taken.Destination.IsClosed);

        var replacing = test.Relay.Register(new ConnectionTarget(Device), new DestinationOptions { Replaces = taken });

        test.Close(Device);

        Assert.Equal([false, true], [taken.Destination.IsClosed, replacing.Destination.IsClosed]);
        Assert.Equal([new Destination(7, null) { IsClosed = true }], test.Relay.Destinations());
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

        // in process: it carries a credential, and is secure, unless a test says otherwise; once told
        // one, it carries that one alone, as a WebSocket carries its upgrade's
        public bool CarriesCredential { get; init; } = true;

        public string? CarriedByUpgrade { get; init; }

        public bool IsSecure { get; init; } = true;

        public List<Asked> Asked { get; } = [];

        public Func<Action<bool>, Task<RouterResult>> Settle { get; set; } = Answering(new byte[] { 9 });

        public bool Carries(string credential)
        {
            return CarriesCredential && (CarriedByUpgrade is null || CarriedByUpgrade == credential);
        }

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request)
        {
            ArgumentNullException.ThrowIfNull(request);
            Asked.Add(new Asked(request.Options, payload, request.Procedure));

            return Settle(request.OnSent ?? Unheard);
        }
    }

    // a client's transport that counts what it is handed and hears nothing: secure, in process
    private sealed class SilentTransport : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public bool IsSecure
        {
            get
            {
                return true;
            }
        }

        public int Sent { get; private set; }

        public event Action<TransportMessage>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, bool>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message)
        {
            Sent += 1;

            return Task.CompletedTask;
        }
    }

    // a relay under the options given — admitting every request unless they say otherwise — which
    // records each answer it writes, with the request it answers, each request of its own router's
    // it makes, and each error it reports, as its message and whether leg A's connection came with
    // it; Close closes a connection as its router does, which holds it no longer
    private sealed class TestRelay
    {
        private readonly HashSet<string> _closed = [];

        // `isCarrying`: a connection of the relay's own carries a credential, and is secure
        public TestRelay(RelayOptions? options = null, bool isCarrying = false)
        {
            Relay = new Relay(
                new RelayRouter
                {
                    CarriesCredential = (_) =>
                    {
                        return isCarrying;
                    },
                    IsSecure = (_) =>
                    {
                        return isCarrying;
                    },
                    IsOpen = (connectionHandle) =>
                    {
                        return !_closed.Contains(connectionHandle);
                    },
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

                        return Task.CompletedTask;
                    },
                },
                options ?? Admitting);
        }

        public Relay Relay { get; }

        public List<(RouterAnswer Answer, AnswerTarget Target)> Answers { get; } = [];

        public List<Asked> Own { get; } = [];

        public List<(string Message, bool IsLegA)> Reports { get; } = [];

        public Func<Action<bool>, Task<RouterResult>> Settle { get; set; } = Answering(new byte[] { 8 });

        public void Close(string connectionHandle)
        {
            _closed.Add(connectionHandle);
            Relay.CloseConnection(connectionHandle);
        }
    }
}
