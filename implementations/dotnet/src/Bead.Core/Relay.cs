using System.Security.Cryptography;

namespace Bead;

/// <summary>How a server's router relays the requests that name a destination.</summary>
public sealed record RelayOptions
{
    /// <summary>
    /// Whether a request may be relayed, asked on its header — its destination included — and its
    /// call's session, before its destination is looked up, so a requester presenting none or OPAQUE
    /// who is not admitted learns only whether any is registered (spec 14.3, step 1). Without it,
    /// the relay admits nobody; a server's admits by <see cref="Server{TData}.RequireCredential"/>.
    /// </summary>
    public BeforeRequest? BeforeRoute { get; init; }

    /// <summary>
    /// Whether the relay verifies what it forwards besides, with its side's credentials, at step 1 of
    /// spec 14.3, before <see cref="BeforeRoute"/>, which then reads the credential's session: a
    /// <see cref="CredentialScheme.Jwt"/> against the audiences its destinations were registered
    /// with. One that does not hold is refused SESSION_REQUIRED; a scheme its side has no verifier
    /// for, CREDENTIAL_UNSUPPORTED. Without it, a JWT and an ELSEWHERE are forwarded read from their
    /// scheme alone, and their destination verifies them.
    /// </summary>
    public bool Verifies { get; init; }

    /// <summary>
    /// How long leg B waits for its answer at most, whatever a destination says; without end by
    /// default: the requester's own timeout governs, end to end, by the cancel it sends. From 1 to
    /// 2³¹ − 1 milliseconds, rounded to the nearest whole one, or infinite; another, zero among them,
    /// is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public TimeSpan Timeout { get; init; } = System.Threading.Timeout.InfiniteTimeSpan;

    // where a destination drawn takes its bytes: the system's random numbers, unless a test gives others
    internal Action<Span<byte>>? Fill { get; init; }
}

/// <summary>A destination, as its registration names it.</summary>
/// <param name="DestinationId">The destination, from 1 to 2³² − 1.</param>
/// <param name="Label">What the application calls it, for a list of its own.</param>
public sealed record Destination(uint DestinationId, string? Label);

/// <summary>How a destination is registered.</summary>
public sealed record DestinationOptions
{
    /// <summary>The destination, from 1 to 2³² − 1; drawn, one not in use, when none.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>What the application calls it, for a list of its own.</summary>
    public string? Label { get; init; }

    /// <summary>
    /// How long leg B waits for its answer, the relay's at most; the relay's when none. From 1 to
    /// 2³¹ − 1 milliseconds, rounded to the nearest whole one, or infinite; another, zero among them,
    /// is an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>
    /// The audience the destination verifies, as a resource is named for a token (RFC 8707): a
    /// <see cref="CredentialScheme.Jwt"/> goes to it only when its <c>aud</c> names it, and an
    /// <see cref="CredentialScheme.Elsewhere"/> to a destination registered with one; none, and the
    /// relay forwards neither to it (spec 14.3, step 5).
    /// </summary>
    public string? Audience { get; init; }
}

/// <summary>A connection of the relay's own, which it asks by a request of its own.</summary>
/// <param name="ConnectionHandle">The connection.</param>
public sealed record ConnectionTarget(string ConnectionHandle);

/// <summary>What a relay calls through to reach a destination: a client's router meets it.</summary>
public interface IRouterTarget
{
    /// <summary>What it reads, writes and holds by: what leg B carries at most.</summary>
    RouterLimits Limits { get; }

    /// <summary>
    /// Whether its transport carries <paramref name="credential"/> beside an envelope, as a leg B
    /// presenting <see cref="CredentialScheme.Elsewhere"/> needs: over a WebSocket, only the bytes its
    /// upgrade carried. None carries one by default.
    /// </summary>
    bool Carries(string credential)
    {
        return false;
    }

    /// <summary>
    /// Whether its transport is secure — under TLS, on the loopback, or within the machine — as a
    /// leg B presenting a bearer credential needs; none is by default.
    /// </summary>
    bool IsSecure
    {
        get
        {
            return false;
        }
    }

    /// <summary>A request to the destination, as a client's router sends one.</summary>
    Task<RouterResult> Request(ReadOnlyMemory<byte> payload, RouterRequest request);
}

/// <summary>A destination registered: what names it, and what takes it out.</summary>
public sealed class DestinationRegistration
{
    private readonly Func<bool> _unregister;

    internal DestinationRegistration(Destination destination, Func<bool> unregister)
    {
        Destination = destination;
        _unregister = unregister;
    }

    /// <summary>The destination, as it was registered.</summary>
    public Destination Destination { get; }

    /// <summary>
    /// Takes the destination out, unless another took its id since; whether it did. A call relayed
    /// to it already finishes: what comes after is refused with DESTINATION_UNKNOWN.
    /// </summary>
    public bool Unregister()
    {
        return _unregister();
    }
}

/// <summary>What the relay needs of its router: its limits, its own request and answer, and its report.</summary>
internal sealed record RelayRouter
{
    /// <summary>The router's own limits.</summary>
    public required RouterLimits Limits { get; init; }

    /// <summary>The router's own request, to a connection of its own: leg B to a connection.</summary>
    public required Func<ReadOnlyMemory<byte>, RouterRequest, Task<RouterResult>> Request { get; init; }

    /// <summary>The router's own answer, to a request it was handed: leg A's.</summary>
    public required Func<RouterAnswer, AnswerTarget, Task> Respond { get; init; }

    /// <summary>What hears why leg B failed, with leg A's connection.</summary>
    public required Action<Exception, string> Report { get; init; }

    /// <summary>Whether a connection of the relay's own takes a request of the relay's.</summary>
    public required Func<string, bool> IsTwoWay { get; init; }

    /// <summary>Whether a connection of the relay's own carries a credential beside an envelope; none does when not said.</summary>
    public Func<string, bool> CarriesCredential { get; init; } = (_) =>
    {
        return false;
    };

    /// <summary>Whether a connection of the relay's own is secure: TLS, the loopback, or within the machine; none is when not said.</summary>
    public Func<string, bool> IsSecure { get; init; } = (_) =>
    {
        return false;
    };
}

/// <summary>
/// The relay of a server's router: the requests that name a destination registered in it go on to
/// that destination's target, and their answers come back, as the router's own. The relay
/// terminates each leg — leg A, from the requester, and leg B, to the target, each with its own call
/// id, limits and session — and passes on the payload's bytes, undecoded, and the answer: a failure
/// of the target's counted one relay more; one of its own with none.
/// </summary>
/// <remarks>
/// A request is asked <see cref="RelayOptions.BeforeRoute"/> on its header first, then its
/// destination is looked up, then its credential is held to what leg B can carry, then it is held to
/// the smaller of the two legs' limits, leg B's header counted with its credential: every refusal
/// falls on the opening, before any of its payload crosses. Leg B presents what leg A presents, by
/// its scheme (spec 14.2): none for none or OPAQUE; a JWT, its same bytes; an ELSEWHERE, what leg
/// A's transport carried moved to leg B's. When leg B fails, leg A hears how far the
/// request went: DESTINATION_UNREACHABLE while the relay's transport never had it, or refused it, and
/// DESTINATION_LOST once it was handed to that transport, the procedure run or not. What leg B failed
/// with is reported, not passed on. A cancel on leg A — or its connection gone — cancels leg B. Its
/// registrations are kept under a lock: they are registered from any thread, and read on the router's
/// scheduler.
/// </remarks>
internal sealed class Relay
{
    private readonly Lock _gate = new();

    // in the order they were registered, as the TypeScript side's Map lists them
    private readonly OrderedDictionary<uint, Registration> _registrations = [];
    private readonly RelayRouter _router;
    private readonly BeforeRequest? _beforeRoute;
    private readonly Action<Span<byte>> _fill;
    private readonly TimeSpan _timeout;

    public Relay(RelayRouter router, RelayOptions? options)
    {
        _router = router;
        _beforeRoute = options?.BeforeRoute;
        _fill = options?.Fill ?? RandomNumberGenerator.Fill;
        _timeout = HeldTimeoutOf(options?.Timeout ?? System.Threading.Timeout.InfiniteTimeSpan);
        Verifies = options?.Verifies ?? false;
    }

    /// <summary>Whether it verifies what it forwards, at step 1 of section 14.3.</summary>
    public bool Verifies { get; }

    /// <summary>
    /// The audiences its destinations are registered with now, which a relay that verifies holds a
    /// <see cref="CredentialScheme.Jwt"/> to.
    /// </summary>
    public IReadOnlyCollection<string> Audiences()
    {
        lock (_gate)
        {
            return [.. _registrations.Values.Select((registration) =>
            {
                return registration.Audience;
            }).OfType<string>().Distinct(StringComparer.Ordinal)];
        }
    }

    /// <summary>
    /// Marks the destinations on a connection of the relay's own that closed: each is unreachable
    /// until the application unregisters it and registers it anew, so a newcomer under the same
    /// handle is never taken for it.
    /// </summary>
    public void CloseConnection(string connectionHandle)
    {
        lock (_gate)
        {
            foreach (var registration in _registrations.Values)
            {
                if (registration.Target is ConnectionTarget target && target.ConnectionHandle == connectionHandle)
                {
                    registration.IsClosed = true;
                }
            }
        }
    }

    /// <summary>The destinations registered, each as its registration names it.</summary>
    public IReadOnlyList<Destination> Destinations()
    {
        lock (_gate)
        {
            return [.. _registrations.Values.Select((registration) =>
            {
                return registration.Destination;
            })];
        }
    }

    /// <summary>
    /// Its destinations, counted, those whose connection closed among them: kept until the
    /// application unregisters them, so none counts for a connection.
    /// </summary>
    public Gauges Gauges()
    {
        lock (_gate)
        {
            return Bead.Gauges.Of(
                new Dictionary<string, long>
                {
                    ["closedDestinations"] = _registrations.Values.Count((registration) =>
                    {
                        return registration.IsClosed;
                    }),
                    ["destinations"] = _registrations.Count,
                },
                []);
        }
    }

    /// <summary>
    /// The handler of a request to <paramref name="destinationId"/> presenting none, as
    /// <see cref="HandlerOf(RequestHeader)"/> gives it.
    /// </summary>
    public IRequestHandler? HandlerOf(uint destinationId)
    {
        return HandlerOf(new RequestHeader { CallId = 1, DestinationId = destinationId, ProcedureId = 1, ServiceId = 1 });
    }

    /// <summary>
    /// The handler of a request that names a destination, its header given, bound to the destination
    /// as it is now; none while none is registered at all: the router relays nothing.
    /// </summary>
    public IRequestHandler? HandlerOf(RequestHeader header)
    {
        var destinationId = header.DestinationId!.Value;
        Registration? registration;

        lock (_gate)
        {
            if (_registrations.Count == 0)
            {
                return null;
            }

            registration = _registrations.GetValueOrDefault(destinationId);
        }

        // bound now: a destination registered again later takes nothing of this call
        return registration is null ? new Unknown(this, destinationId) : new Route(this, (registration, header));
    }

    /// <summary>
    /// Registers a target as a destination: given, or drawn. A timeout is rounded to the nearest whole
    /// millisecond; one neither infinite nor from 1 to 2³¹ − 1, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>; a destination of 0, or registered already, or an
    /// audience that is not a string of well-formed Unicode, an <see cref="ArgumentException"/>.
    /// </summary>
    public DestinationRegistration Register(object target, DestinationOptions? options)
    {
        var timeout = HeldTimeoutOf(options?.Timeout ?? System.Threading.Timeout.InfiniteTimeSpan);

        if (options?.DestinationId == 0)
        {
            throw new ArgumentException("a destination is from 1 to 4294967295, not 0", nameof(options));
        }

        if (options?.Audience is { } audience)
        {
            JwtVerifier.AssertHeld(([], [audience]));
        }

        lock (_gate)
        {
            if (options?.DestinationId is { } given && _registrations.ContainsKey(given))
            {
                throw new ArgumentException($"destination {given} is registered already", nameof(options));
            }

            var destinationId = options?.DestinationId ?? DrawDestinationId();

            // the relay's timeout is the longest any leg B waits: a destination's own stays under it
            var registration = new Registration(new Destination(destinationId, options?.Label), (target, ShorterOf(timeout, _timeout)))
            {
                Audience = options?.Audience,
            };

            _registrations[destinationId] = registration;

            return new DestinationRegistration(registration.Destination, () =>
            {
                // its own registration alone: one that took its id since stays
                lock (_gate)
                {
                    return _registrations.GetValueOrDefault(destinationId) == registration && _registrations.Remove(destinationId);
                }
            });
        }
    }

    // the relay's timeout, or a destination's, held: never zero, and infinite without end
    private static TimeSpan HeldTimeoutOf(TimeSpan timeout)
    {
        return Clocks.AssertHeld(("a relay's timeout", nameof(RelayOptions.Timeout)), timeout);
    }

    // the shorter of two timeouts, infinite the longest
    private static TimeSpan ShorterOf(TimeSpan timeout, TimeSpan other)
    {
        if (timeout == System.Threading.Timeout.InfiniteTimeSpan)
        {
            return other;
        }

        return other == System.Threading.Timeout.InfiniteTimeSpan || timeout < other ? timeout : other;
    }

    private static Failure UnreachableOf(uint destinationId, string why)
    {
        return Failure.OfProtocol(ProtocolCode.DestinationUnreachable, $"destination {destinationId} is unreachable: {why}");
    }

    // a destination not in use, from 4 random bytes; 0, which the wire refuses, is drawn again
    private uint DrawDestinationId()
    {
        Span<byte> bytes = stackalloc byte[4];

        for (; ; )
        {
            _fill(bytes);

            var destinationId = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(bytes);

            if (destinationId != 0 && !_registrations.ContainsKey(destinationId))
            {
                return destinationId;
            }
        }
    }

    // without a beforeRoute, the relay admits nobody: it is a door to what is behind it
    private Failure? AdmissionOf(AdmissionRequest request)
    {
        if (_beforeRoute is not { } beforeRoute)
        {
            return Failure.OfProtocol(ProtocolCode.AccessDenied, "this relay admits nobody: it has no beforeRoute");
        }

        return beforeRoute.RefusalOf(request);
    }

    // what leg B presents for what leg A presents (spec 14.2): none for none or OPAQUE, whatever its
    // target presents by default; a JWT, its same bytes; an ELSEWHERE, what leg A's transport carried
    private static Credential LegBCredentialOf(RequestHeader header, string? carried)
    {
        return header.Credential switch
        {
            { Scheme: CredentialScheme.Jwt } jwt => jwt,
            { Scheme: CredentialScheme.Elsewhere } when carried is not null => Credential.Elsewhere(carried),
            _ => Credential.None,
        };
    }

    // leg B's header, for leg A's: no destination, its credential as leg B presents it — 12 bytes,
    // and 4 more and a JWT's token padded to a word, or 4 for an ELSEWHERE
    private static int LegBHeaderBytesOf(RequestHeader header)
    {
        var credential = header.Credential?.Scheme switch
        {
            CredentialScheme.Jwt => header.Credential,
            CredentialScheme.Elsewhere => Credential.Elsewhere(),
            _ => null,
        };

        return EnvelopeCodec.HeaderBytesOf(new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = credential });
    }

    // the largest payload a target takes, and answers, behind leg B's header for this call: its
    // router's limit, or what one of its envelopes holds when it takes no transfer; the relay's own
    // where that one is smaller
    private int PayloadLimitOf((object Target, RequestHeader Header) leg)
    {
        var limits = leg.Target is IRouterTarget router ? router.Limits : _router.Limits;
        var limit = limits.MaximumTransfers == 0
            ? Math.Min(limits.MaximumPayloadBytes, Math.Min(limits.ChunkBytes, limits.MaximumEnvelopeBytes) - LegBHeaderBytesOf(leg.Header))
            : limits.MaximumPayloadBytes;

        return Math.Min(limit, _router.Limits.MaximumPayloadBytes);
    }

    // step 5 of section 14.3: what leg B cannot carry, its credential holding or not, nothing tried —
    // a JWT to a destination whose audience its aud does not name, or of none; an ELSEWHERE to a
    // destination of no audience, or over a leg B that cannot carry what leg A's transport carried —
    // ! a WebSocket's, whose upgrade carried the relay's own credential or none, never leg A's: the
    // confused deputy stays shut; either over a leg B in the clear off the machine. A call
    // presenting none or OPAQUE is never refused here
    private Failure? CredentialRefusalOf(Registration registration, AdmissionRequest request)
    {
        var header = request.Header;
        var carried = request.TransportCredential;
        var destinationId = registration.Destination.DestinationId;
        var target = registration.Target;
        var (carries, isSecure) = target is IRouterTarget router
            ? (carried is { } bytes && router.Carries(bytes), router.IsSecure)
            : (_router.CarriesCredential(((ConnectionTarget)target).ConnectionHandle), _router.IsSecure(((ConnectionTarget)target).ConnectionHandle));

        return header.Credential switch
        {
            { Scheme: CredentialScheme.Jwt, Token: { } token } when registration.Audience is not { } audience || !CredentialResolver.NamesAudience(token, audience)
                => UnreachableOf(destinationId, "it verifies another audience than the one the token names, or none"),
            { Scheme: CredentialScheme.Elsewhere } when registration.Audience is null
                => UnreachableOf(destinationId, "it was registered with no audience"),
            { Scheme: CredentialScheme.Elsewhere } when !carries
                => UnreachableOf(destinationId, "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"),
            { Scheme: CredentialScheme.Jwt or CredentialScheme.Elsewhere } when !isSecure
                => UnreachableOf(destinationId, "it is reached off the machine in the clear, which a bearer credential never crosses"),
            _ => null,
        };
    }

    // what leg A answers when leg B fails: the target's failure, one relay more; before the relay's
    // transport had the request, a limit of leg B's as the relay's own, or unreachable; lost after.
    // The relay's own name no address behind it: why leg B failed is reported instead
    private Failure FailureOf(Exception reason, (string ConnectionHandle, uint DestinationId, bool IsSent) leg)
    {
        if (reason is FailureException { Origin: not FailureOrigin.Local } received)
        {
            return received.Failure with { Relays = (byte)Math.Min(received.Relays + 1, byte.MaxValue) };
        }

        if (!leg.IsSent && reason is FailureException { Scope: FailureScope.Protocol } refused)
        {
            if (refused.Code == (ushort)ProtocolCode.PayloadTooLarge)
            {
                return refused.Failure with { Relays = 0 };
            }

            if (refused.Code == (ushort)ProtocolCode.CapacityExceeded)
            {
                return Failure.OfProtocol(ProtocolCode.CapacityExceeded, $"destination {leg.DestinationId} takes no more calls at once");
            }
        }

        _router.Report(reason, leg.ConnectionHandle);

        return leg.IsSent
            ? Failure.OfProtocol(
                ProtocolCode.DestinationLost,
                $"destination {leg.DestinationId} was lost once handed the request: the procedure may have run")
            : UnreachableOf(leg.DestinationId, "nothing was tried");
    }

    // leg B: the same service and procedure, the payload's bytes, leg A's signal; its answer, or none
    // once leg A ended
    private async Task<RouterAnswer?> AnswerOf(Registration registration, RequestResolverProps props)
    {
        var (connectionHandle, header) = (props.ConnectionHandle, props.Header);
        var destinationId = registration.Destination.DestinationId;
        var procedure = new Procedure
        {
            MaximumPayloadBytes = PayloadLimitOf((registration.Target, header)),
            ProcedureId = header.ProcedureId,
            ProcedureName = $"{header.ServiceId}/{header.ProcedureId} to {destinationId}",
            ServiceId = header.ServiceId,
            ServiceRevision = 0,
        };
        var isSent = false;

        // true as the relay's transport is handed the request, false should it refuse it
        void Sent(bool isHanded)
        {
            isSent = isHanded;
        }

        var credential = LegBCredentialOf(header, props.TransportCredential);

        try
        {
            var result = registration.Target is IRouterTarget router
                ? await router.Request(
                    props.Payload,
                    new RouterRequest(procedure, new ResolvedRequestOptions { CancellationToken = props.Signal, Credential = credential, Timeout = registration.Timeout })
                    {
                        OnSent = Sent,
                    })
                : await _router.Request(
                    props.Payload,
                    new RouterRequest(
                        procedure,
                        new ResolvedRequestOptions
                        {
                            CancellationToken = props.Signal,
                            ConnectionHandle = ((ConnectionTarget)registration.Target).ConnectionHandle,
                            Credential = credential,
                            Timeout = registration.Timeout,
                        })
                    { OnSent = Sent });

            return RouterAnswer.OfPayload(result.Payload);
        }
        catch (Exception reason)
        {
            // leg A ended — cancelled, or gone with its connection: its answer would go nowhere, and
            // leg B was cancelled with it
            if (props.Signal.IsCancellationRequested)
            {
                return null;
            }

            return RouterAnswer.OfFailure(FailureOf(reason, (connectionHandle, destinationId, isSent)));
        }
    }

    // leg B, then leg A's answer; a connection that closed while the payload came takes nothing
    private async Task Forward(Registration registration, RequestResolverProps props)
    {
        var target = new AnswerTarget(props.ConnectionHandle, props.Header);
        var answer = registration.IsClosed
            ? RouterAnswer.OfFailure(UnreachableOf(registration.Destination.DestinationId, "its connection closed"))
            : await AnswerOf(registration, props);

        if (answer is null)
        {
            return;
        }

        try
        {
            await _router.Respond(answer, target);
        }
        catch (Exception reason)
        {
            // an answer leg A cannot carry — a result past its limit, say — is answered as failed,
            // once; one that could not go out goes nowhere again, and what failed is reported either
            // way
            var failure = reason is FailureException refused
                ? refused.Failure with { Relays = 0 }
                : Failure.OfProtocol(ProtocolCode.ProcedureFailed, reason.Message);

            try
            {
                await _router.Respond(RouterAnswer.OfFailure(failure), target);
            }
            catch (Exception)
            {
                // the first failure goes on, for the router to report
            }

            throw;
        }
    }

    // a destination registered: its target, how long leg B waits, the audience it verifies, whether
    // its connection closed
    private sealed class Registration(Destination destination, (object Target, TimeSpan Timeout) leg)
    {
        public Destination Destination { get; } = destination;

        public object Target { get; } = leg.Target;

        public TimeSpan Timeout { get; } = leg.Timeout;

        public string? Audience { get; init; }

        // for a connection of the relay's own: set once it closed, whoever takes its handle next
        public volatile bool IsClosed;
    }

    // the handler of a request to a destination not registered: refused by its admission, or as unknown
    private sealed class Unknown(Relay relay, uint destinationId) : IRequestHandler
    {
        public int? MaximumPayloadBytes
        {
            get
            {
                return null;
            }
        }

        public bool ForwardsCredentials
        {
            get
            {
                return !relay.Verifies;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return relay.AdmissionOf(request)
                ?? Failure.OfProtocol(ProtocolCode.DestinationUnknown, $"no destination {destinationId} behind this relay");
        }

        // a router that asks no admission leaves it to the handler, as to a resolver
        public Task Handle(RequestResolverProps props)
        {
            ArgumentNullException.ThrowIfNull(props);

            return relay._router.Respond(
                RouterAnswer.OfFailure(Admit(new AdmissionRequest(props.ConnectionHandle, props.Header) { Session = props.Session })!),
                new AnswerTarget(props.ConnectionHandle, props.Header));
        }
    }

    // the handler of a request to a destination registered, its header given: admitted and routed,
    // then forwarded
    private sealed class Route(Relay relay, (Registration Registration, RequestHeader Header) routed) : IRequestHandler
    {
        private readonly Registration _registration = routed.Registration;

        public int? MaximumPayloadBytes
        {
            get
            {
                return relay.PayloadLimitOf((_registration.Target, routed.Header));
            }
        }

        public bool ForwardsCredentials
        {
            get
            {
                return !relay.Verifies;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return relay.AdmissionOf(request) ?? RefusalOfRoute(request);
        }

        public Task Handle(RequestResolverProps props)
        {
            ArgumentNullException.ThrowIfNull(props);

            var refusal = props.IsAdmitted
                ? null
                : Admit(new AdmissionRequest(props.ConnectionHandle, props.Header) { Session = props.Session, TransportCredential = props.TransportCredential });

            return refusal is null
                ? relay.Forward(_registration, props)
                : relay._router.Respond(RouterAnswer.OfFailure(refusal), new AnswerTarget(props.ConnectionHandle, props.Header));
        }

        // what refuses an admitted request to this destination: none, for one that goes on
        private Failure? RefusalOfRoute(AdmissionRequest request)
        {
            var header = request.Header;
            var destinationId = _registration.Destination.DestinationId;

            if (header.OpensSubscription)
            {
                return Failure.OfProtocol(ProtocolCode.SubscriptionUnsupported, "this relay carries no subscription");
            }

            if (_registration.IsClosed)
            {
                return UnreachableOf(destinationId, "its connection closed");
            }

            if (_registration.Target is ConnectionTarget target && !relay._router.IsTwoWay(target.ConnectionHandle))
            {
                return UnreachableOf(destinationId, "its connection carries no request");
            }

            return relay.CredentialRefusalOf(_registration, request);
        }
    }
}
