using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

namespace Bead;

/// <summary>How a router's core is built, beyond its port.</summary>
public sealed record RouterCoreOptions
{
    /// <summary>What it reads, writes and holds by; <see cref="RouterLimits.Default"/> when none.</summary>
    public RouterLimits? Limits { get; init; }

    /// <summary>The last call id it draws before its first again; its side's last when none.</summary>
    public uint? LastCallId { get; init; }

    /// <summary>What its timers run on; the system's clock when none.</summary>
    public TimeProvider? Clock { get; init; }

    /// <summary>
    /// What it counts its calls and its notifications through, at its gates (spec/debugging.md
    /// 7.1): its router's, attached to the registry that router was given; none counts nothing.
    /// </summary>
    internal RouterSeries? Metrics { get; init; }

    /// <summary>
    /// Where resolvers run, and where a call's signal is cancelled: the thread pool when none. A
    /// test runs them on the router's own scheduler, so it knows when everything settled.
    /// </summary>
    internal TaskScheduler? ResolverScheduler { get; init; }

    /// <summary>The scheduler the core runs on; one of its own when none.</summary>
    internal SerialScheduler? Scheduler { get; init; }
}

/// <summary>
/// What both sides of a router do alike: write what goes out, take what comes in — read, checked,
/// traced, then dispatched by kind — pair each result and failure with its request by call id, send
/// a payload too large for one envelope as a transfer and put together one that comes as a transfer,
/// and hand each request to the resolver registered for it. What sets a side apart is its port.
/// Everything it holds is touched on its own serial scheduler, as Bead's TypeScript core is on its one thread;
/// its public methods may be called from any thread.
/// </summary>
public sealed class RouterCore : IDisposable
{
    // constants

    private const string Disposed = "the router was disposed";

    // what a failure's envelope holds besides its detail: its prefix, the announcement it may
    // carry, and its record
    private const int FailureOverheadBytes = 8 + Credential.AnnouncementBytes + 4;

    // a chunk's header: its prefix, then its offset
    private static readonly int ChunkHeaderBytes = EnvelopeCodec.HeaderBytesOf(new ChunkHeader { CallId = 1, IsLast = true, Offset = 0 });

    // what a relay that does not verify takes at step 1 of section 14.3: none and OPAQUE it resolves,
    // a JWT and an ELSEWHERE it forwards
    private static readonly CredentialScheme[] ForwardedSchemes = [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere];

    private readonly IRouterCorePort _port;
    private readonly RouterSide _side;
    private readonly int _detailBytes;
    private readonly int _wholeBytes;
    private readonly int _payloadBytesPerChunk;
    private readonly TimeProvider _clock;
    private readonly TaskScheduler _resolverScheduler;
    private readonly ReceivingTransfers _receivings;
    private readonly SendingTransfers _sendings = new();
    private readonly PendingCalls _pendingCalls;
    private readonly AnsweringCalls _answeringCalls;
    private readonly ConcurrentDictionary<ProcedureAddress, Registered> _resolvers = new();
    private readonly ConcurrentDictionary<ushort, int> _services = new();

    // what each connection was last told of its session: a token, none once told it ended; a
    // connection never told has no entry
    private readonly Dictionary<string, SessionToken?> _announced = [];

    // the handler each request was routed to, by the very header dispatched
    private readonly ConditionalWeakTable<RequestHeader, IRequestHandler> _handlers = [];

    // the failure each request dispatched was answered with, by the very header dispatched: one its
    // router answered in its resolver's place, which its resolver's answer tells (spec/debugging.md
    // 4.2); read from the resolver's thread
    private readonly ConditionalWeakTable<RequestHeader, Failure> _failuresAnswered = [];

    // what it counts through, at its gates: its router's; none when its router was given no registry
    private readonly RouterSeries? _metrics;

    private volatile bool _isDisposed;

    /// <summary>A core for the side <paramref name="port"/> is, with its options.</summary>
    public RouterCore(IRouterCorePort port, RouterCoreOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(port);

        _port = port;
        _side = port.Side;
        Limits = (options?.Limits ?? RouterLimits.Default).Validate();
        _clock = options?.Clock ?? TimeProvider.System;
        Loop = options?.Scheduler ?? new SerialScheduler();
        Loop.OnUnhandled = (exception) =>
        {
            _port.Report(exception, null);
        };
        _resolverScheduler = options?.ResolverScheduler ?? TaskScheduler.Default;
        _metrics = options?.Metrics;

        // a failure's detail fits in an envelope, whatever the limit of a detail says
        _detailBytes = Math.Min(Limits.MaximumDetailBytes, Limits.MaximumEnvelopeBytes - FailureOverheadBytes);

        // the largest envelope a payload goes whole in, and the bytes a chunk carries
        _wholeBytes = Math.Min(Limits.ChunkBytes, Limits.MaximumEnvelopeBytes);
        _payloadBytesPerChunk = Transfer.ChunkPayloadBytes(Limits, ChunkHeaderBytes);
        _receivings = new ReceivingTransfers(new ReceivingTransfersOptions
        {
            Limits = Limits,
            PayloadBytesPerChunk = _payloadBytesPerChunk,
            Post = Post,
            SendCredit = (call, creditEnd) =>
            {
                SendReporting(
                    new Envelope { Header = new CreditHeader { CallId = call.CallId, CreditEnd = creditEnd } },
                    call.ConnectionHandle);
            },
            Clock = _clock,
        });

        // what a call holds leaves with the call, whichever way the call leaves: its timer, and the
        // transfers it sends and receives
        _pendingCalls = new PendingCalls(
            _side,
            new PendingCallsOptions
            {
                IsCallIdInUse = (callId, connectionHandle) =>
                {
                    return _port.IsCallIdInUse(callId, connectionHandle);
                },
                LastCallId = options?.LastCallId,
                OnRemove = (pendingRequest) =>
                {
                    if (pendingRequest.Receiving is { } receiving)
                    {
                        _receivings.Close(receiving.Transfer);
                    }

                    if (pendingRequest.Sending is { } sending)
                    {
                        _sendings.Close(sending);
                    }
                },
                Post = Post,
                Clock = _clock,
            });
        _answeringCalls = new AnsweringCalls(new AnsweringCallsOptions
        {
            Limits = Limits,
            OnRemove = (receiving) =>
            {
                _receivings.Close(receiving.Transfer);
            },
            Post = Post,
            Clock = _clock,
        });
    }

    /// <summary>What it reads, writes and holds by.</summary>
    public RouterLimits Limits { get; }

    /// <summary>What its timers run on.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _clock;
        }
    }

    /// <summary>Which side it is.</summary>
    public RouterSide Side
    {
        get
        {
            return _side;
        }
    }

    /// <summary>Whether it was disposed: nothing more goes out, and nothing more waits.</summary>
    public bool IsDisposed
    {
        get
        {
            return _isDisposed;
        }
    }

    /// <summary>The scheduler everything the core holds is touched on.</summary>
    internal SerialScheduler Loop { get; }

    // helpers

    /// <summary>
    /// A header fit to be traced or thrown: its credential's scheme alone in place of its credential,
    /// a copy for a header that carries one, the header itself for any other.
    /// </summary>
    internal static IEnvelopeHeader Redact(IEnvelopeHeader header)
    {
        return header switch
        {
            RequestHeader { Credential: { } credential } request => request with { Credential = Credential.SchemeOf(credential.Scheme) },
            ResultHeader { Credential: { } credential } result => result with { Credential = Credential.SchemeOf(credential.Scheme) },
            FailureHeader { Credential: { } credential } failure => failure with { Credential = Credential.SchemeOf(credential.Scheme) },
            _ => header,
        };
    }

    private static bool IsTimeout(TimeSpan delay)
    {
        return delay > TimeSpan.Zero && delay != Timeout.InfiniteTimeSpan;
    }

    // whether every byte of a transfer came
    private static bool IsWhole(Receiving receiving)
    {
        return receiving.Incoming.Contiguous == receiving.Incoming.Total;
    }

    // a chunk's envelope, on its call id
    private static Envelope ChunkEnvelopeOf(uint callId, Chunk chunk)
    {
        return new Envelope
        {
            Header = new ChunkHeader { CallId = callId, IsLast = chunk.IsLast, Offset = chunk.Offset },
            Payload = chunk.Bytes,
        };
    }

    private static Failure ProtocolFailureOf(ProtocolCode code, string detail = "")
    {
        return new Failure { Code = (ushort)code, Detail = detail, Scope = FailureScope.Protocol };
    }

    private static Failure TooLargeOf(long length, int limit)
    {
        return ProtocolFailureOf(ProtocolCode.PayloadTooLarge, $"a payload is {limit} bytes at most, not {length}");
    }

    private FailureException LocalOf(Failure failure, IEnvelopeHeader? header = null)
    {
        return new FailureException(failure, new FailureException.Raised(FailureOrigin.Local, _side))
        {
            Header = header is null ? null : Redact(header),
        };
    }

    // a call counted as it starts, under its series, at this instant
    private StartedCall StartedOf(CallSeries series)
    {
        series.Start();

        return new StartedCall { Clock = _clock, Series = series, Timestamp = _clock.GetTimestamp() };
    }

    // a call this side answers ends, once, whichever way it ends first
    private static void EndAnswered(AnsweringCall answering, (CallOutcome Outcome, Failure? Failure) ending)
    {
        if (answering.Counted is { } counted)
        {
            answering.Counted = null;
            counted.End(ending);
        }
    }

    // what the core raises itself about an envelope, for the side to hear
    private void Report(Failure failure, (string ConnectionHandle, IEnvelopeHeader Header) about)
    {
        _port.Report(LocalOf(failure, about.Header), about.ConnectionHandle);
    }

    // the bytes a payload of `handler` holds at most: its own limit, within the router's
    private int PayloadLimitOf(int? maximumPayloadBytes)
    {
        return Math.Min(maximumPayloadBytes ?? int.MaxValue, Limits.MaximumPayloadBytes);
    }

    // whether a call id is the peer's to open on this connection, and free: a refusal on it is answered
    private bool IsAnswerable(uint callId, string connectionHandle)
    {
        return CallIds.SideOf(callId) == CallIds.PeerOf(_side)
            && !_answeringCalls.Has(new CallAddress(callId, connectionHandle))
            && !_port.IsCallIdInUse(callId, connectionHandle);
    }

    /// <summary>Runs <paramref name="action"/> on the core's scheduler, after what came before it.</summary>
    internal void Post(Action action)
    {
        Loop.Post(action);
    }

    // sends an envelope; `onHandOff` runs once the transport has it, before it settles
    private Task Deliver(Envelope envelope, string connectionHandle, Action? onHandOff = null)
    {
        return Carrying(envelope, (connectionHandle, null, onHandOff, null));
    }

    // sends an envelope with what its transport carries beside it — a request's presenting
    // ELSEWHERE — and none for any other; `OnHandOff` runs once the transport has it, before it
    // settles. A notification counts into its procedure's series as it is handed off, or as it
    // cannot be (spec/debugging.md 10.1); one its transport refuses after keeps its count
    private async Task Carrying(Envelope envelope, (string ConnectionHandle, string? Carried, Action? OnHandOff, NotifyingSeries? Notifying) going)
    {
        var (connectionHandle, carried, onHandOff, notifying) = going;
        Task sending;
        Action restore;

        try
        {
            (sending, restore) = HandOver(envelope, (connectionHandle, carried));
        }
        catch
        {
            notifying?.Failed();

            throw;
        }

        notifying?.Sent();
        onHandOff?.Invoke();

        try
        {
            await sending;
        }
        catch
        {
            restore();

            throw;
        }
    }

    // hands an envelope to the transport, traced for whoever listens: what the transport settles,
    // and what undoes its announcement should it not go out
    private (Task Sending, Action Restore) HandOver(Envelope envelope, (string ConnectionHandle, string? Carried) going)
    {
        var (connectionHandle, carried) = going;

        // a disposed router is done with its transport: nothing more goes out on it
        if (_isDisposed)
        {
            throw new DisconnectException(Disposed);
        }

        // a failure, a credit and a cancel carry no payload of their own
        if (envelope.Kind is not (EnvelopeKind.Cancel or EnvelopeKind.Credit or EnvelopeKind.Failure)
            && envelope.Payload.Length > Limits.MaximumPayloadBytes)
        {
            throw LocalOf(TooLargeOf(envelope.Payload.Length, Limits.MaximumPayloadBytes), envelope.Header);
        }

        var (announced, restore) = Announce(envelope, connectionHandle);

        try
        {
            var bytes = EnvelopeCodec.WriteEnvelope(announced, _detailBytes);

            // one past its limit, the peer would refuse
            if (bytes.Length > Limits.MaximumEnvelopeBytes)
            {
                throw LocalOf(
                    ProtocolFailureOf(
                        ProtocolCode.PayloadTooLarge,
                        $"an envelope is {Limits.MaximumEnvelopeBytes} bytes at most, not {bytes.Length}"),
                    envelope.Header);
            }

            // * one check an envelope while nobody listens: redacted for a listener alone
            if (_port.IsTracing)
            {
                _port.Trace(DebugDirection.Tx, new TracedEnvelope(connectionHandle, Redact(announced.Header)));
            }

            return (_port.Send(new TransportMessage(bytes, false) { Credential = carried }, connectionHandle), restore);
        }
        catch
        {
            restore();

            throw;
        }
    }

    // an answer as it goes out to a connection: it carries the connection's session when it changed
    // since the last one announced, recorded as it is written, so answers that go out together
    // announce in the order they were written; what it gives back undoes that, should it not go out
    private (Envelope Envelope, Action Restore) Announce(Envelope envelope, string connectionHandle)
    {
        static void Unchanged()
        {
        }

        if (envelope.Header is not (ResultHeader or FailureHeader))
        {
            return (envelope, Unchanged);
        }

        var current = _port.SessionTokenOf(connectionHandle);
        var hadPrevious = _announced.TryGetValue(connectionHandle, out var previous);

        if (current == previous)
        {
            return (envelope, Unchanged);
        }

        _announced[connectionHandle] = current;

        // its token, once it opened or was drawn anew; NONE, once it ended
        var announcement = current is { } token ? Credential.Opaque(token) : Credential.None;
        IEnvelopeHeader header = envelope.Header is ResultHeader result
            ? result with { Credential = announcement }
            : (FailureHeader)envelope.Header with { Credential = announcement };

        return (
            new Envelope { Header = header, Payload = envelope.Payload, Failure = envelope.Failure },
            () =>
            {
                // an answer that did not go out announced nothing: what it recorded is undone,
                // unless something since recorded over it or forgot the connection
                if (_announced.TryGetValue(connectionHandle, out var recorded) && recorded == current)
                {
                    if (hadPrevious)
                    {
                        _announced[connectionHandle] = previous;
                    }
                    else
                    {
                        _announced.Remove(connectionHandle);
                    }
                }
            }
        );
    }

    // sends an envelope no call waits on: what keeps it from going out is reported
    private void SendReporting(Envelope envelope, string connectionHandle)
    {
        _ = Reporting(Deliver(envelope, connectionHandle), connectionHandle);
    }

    private async Task Reporting(Task sending, string connectionHandle)
    {
        try
        {
            await sending;
        }
        catch (Exception reason)
        {
            _port.Report(reason, connectionHandle);
        }
    }

    // tells the peer a call this side opened is cancelled, once, and reserves its call id in the same
    // step, so nothing drawn meanwhile takes it; a cancel that cannot go out is reported
    private void SendCancel(CallAddress call, TimeSpan? timeout)
    {
        // a disposed router sends nothing; a call id reserved already had its cancel
        if (_isDisposed || _pendingCalls.IsReserved(call.CallId, call.ConnectionHandle))
        {
            return;
        }

        _pendingCalls.Reserve(call, timeout);
        SendReporting(new Envelope { Header = new CancelHeader { CallId = call.CallId } }, call.ConnectionHandle);
    }

    // how long a call id stays reserved once its call ends: as its timeout says — and, once its
    // result came in part, as long as the peer keeps the call abandoned, should that be longer, since
    // what the credit let the peer send may still come
    private TimeSpan ReservedFor(PendingRequest pendingRequest, TimeSpan? timeout = null)
    {
        var given = timeout ?? pendingRequest.Timeout;

        if (pendingRequest.Receiving is null)
        {
            return given;
        }

        var reservation = PendingCalls.ReservationOf(given);

        return reservation > Limits.TransferInactivityTimeout ? reservation : Limits.TransferInactivityTimeout;
    }

    // ends a call this side waits on before its answer came whole: forgotten first, so what it holds
    // goes with it, then the peer told to cancel it, then the caller told; a call ended already ends
    // no more
    private void EndPending(Exception reason, CallAddress call, PendingRequest pendingRequest)
    {
        if (!ReferenceEquals(_pendingCalls.Get(call), pendingRequest))
        {
            return;
        }

        _pendingCalls.Forget(call);
        SendCancel(call, ReservedFor(pendingRequest));
        pendingRequest.Reject(reason);
    }

    // sets a waiting call's timer going again, which its caller waits on too: past `delay`, a
    // TimeoutException; none for no positive delay, nor for a call ended already. A timer that fired
    // as it was set going again — its end on its way to the scheduler — ends nothing
    private void Wait(TimeSpan delay, CallAddress call, PendingRequest pendingRequest)
    {
        if (!ReferenceEquals(_pendingCalls.Get(call), pendingRequest))
        {
            return;
        }

        pendingRequest.Timer?.Dispose();
        pendingRequest.TimerGeneration += 1;

        var generation = pendingRequest.TimerGeneration;

        pendingRequest.Timer = IsTimeout(delay)
            ? _clock.CreateTimer(
                (_) =>
                {
                    Post(() =>
                    {
                        if (pendingRequest.TimerGeneration != generation)
                        {
                            return;
                        }

                        EndPending(
                            new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"no answer came in {delay.TotalMilliseconds} milliseconds")),
                            call,
                            pendingRequest);
                    });
                },
                null,
                delay,
                Timeout.InfiniteTimeSpan)
            : null;
    }

    // how a payload goes after its header: whole — none — or as a transfer, a result's header counted
    // with the announcement it may carry; or not at all, and the failure says why
    private (OutgoingTransfer? Transfer, Failure? Refusal) TransferOf(
        ReadOnlyMemory<byte> payload,
        (IEnvelopeHeader Header, int MaximumPayloadBytes) going)
    {
        var (header, maximumPayloadBytes) = going;
        var announcementBytes = header is ResultHeader ? Credential.AnnouncementBytes : 0;

        if (payload.Length > maximumPayloadBytes)
        {
            return (null, TooLargeOf(payload.Length, maximumPayloadBytes));
        }

        if (EnvelopeCodec.HeaderBytesOf(header) + announcementBytes + payload.Length <= _wholeBytes)
        {
            return (null, null);
        }

        if (Limits.MaximumTransfers == 0)
        {
            return (null, ProtocolFailureOf(
                ProtocolCode.PayloadTooLarge,
                $"a payload of {payload.Length} bytes goes as a transfer, which this side sends none of"));
        }

        // only a request and a result open a transfer
        IEnvelopeHeader opening = header is RequestHeader request
            ? request with { Total = payload.Length }
            : (ResultHeader)header with { Total = payload.Length };
        var openingHeaderBytes = EnvelopeCodec.UnboundedHeaderBytesOf(opening);
        var openingBytes = _wholeBytes - openingHeaderBytes - announcementBytes;

        // ! a header past 1,020 bytes no reader takes, and an opening without a byte of its payload
        // none places: a payload that needs such a transfer goes whole or not at all (spec 12.3)
        if (openingHeaderBytes > EnvelopeCodec.MaximumHeaderBytes)
        {
            return (null, ProtocolFailureOf(
                ProtocolCode.PayloadTooLarge,
                $"a payload of {payload.Length} bytes goes as a transfer, whose opening's header of {openingHeaderBytes} bytes passes {EnvelopeCodec.MaximumHeaderBytes}"));
        }

        if (openingBytes < 1)
        {
            return (null, ProtocolFailureOf(
                ProtocolCode.PayloadTooLarge,
                $"a payload of {payload.Length} bytes goes as a transfer, whose opening's header of {openingHeaderBytes} bytes leaves it no byte within {_wholeBytes}"));
        }

        return (new OutgoingTransfer(payload, (openingBytes, _payloadBytesPerChunk)), null);
    }

    // the credential a call of this side's own presents, as its options ask, and what its transport
    // carries beside it: OPAQUE stands for the connection's session as this side knows it, and a
    // side that knows none fails the call before it goes, as its peer would refuse it; a bearer
    // credential its transport cannot carry, or would carry off the machine in the clear, fails it
    // before it goes too, DESTINATION_UNREACHABLE, nothing tried
    private (Credential? Presented, string? Carried) PresentedOf(CoreRequest request)
    {
        var asked = request.Options.Credential;
        var connectionHandle = request.ConnectionHandle;
        var known = asked is { Scheme: CredentialScheme.Opaque, SessionToken: null } ? _port.KnownSessionTokenOf(connectionHandle) : null;
        var (presented, carried, refusal) = CallSession.PresentedCredentialOf(asked, known);

        // * what the call presents, against what the connection carries: over a WebSocket, the bytes
        // its upgrade carried alone (spec 13.4)
        var carries = carried is { } bytes && _port.Carries(bytes, connectionHandle);

        refusal ??= CallSession.UncarriedOf(presented, (carries, _port.IsSecure(connectionHandle)));

        if (refusal is not null)
        {
            throw new FailureException(refusal, new FailureException.Raised(FailureOrigin.Local, _side))
            {
                DestinationId = request.Options.DestinationId,
                ProcedureAddress = request.Procedure.Address,
            };
        }

        return (presented, carried);
    }

    // what a request of the side's own goes out as, or why it does not, before it goes: a
    // connection not open, its credential, no call id free, its payload past its limit, or a
    // transfer its opening's header leaves no room
    private (RequestHeader Header, OutgoingTransfer? Outgoing, string? Carried) HeaderOf(
        ReadOnlyMemory<byte> payload,
        (CoreRequest Request, int MaximumPayloadBytes) going)
    {
        var (request, maximumPayloadBytes) = going;
        var options = request.Options;
        var procedure = request.Procedure;

        // a call to a connection not open fails as one whose connection closes: one race with a close
        if (!_port.IsOpen(request.ConnectionHandle))
        {
            throw new DisconnectException($"{request.ConnectionHandle} is not an open connection");
        }

        var (credential, carried) = PresentedOf(request);
        var callId = _pendingCalls.Draw(request.ConnectionHandle)
            ?? throw new FailureException(
                ProtocolFailureOf(ProtocolCode.CapacityExceeded, $"every call id of {request.ConnectionHandle} is in use"),
                new FailureException.Raised(FailureOrigin.Local, _side))
            {
                DestinationId = options.DestinationId,
                ProcedureAddress = procedure.Address,
            };
        var header = new RequestHeader
        {
            CallId = callId,
            ServiceId = procedure.ServiceId,
            ProcedureId = procedure.ProcedureId,
            DestinationId = options.DestinationId,
            OpensSubscription = request.OpensSubscription,
            Paced = request.Paced,
            Credential = credential,
        };

        // how it goes is decided before anything is kept of it: past its limit, nothing goes
        var (outgoing, refusal) = TransferOf(payload, (header, maximumPayloadBytes));

        if (refusal is not null)
        {
            throw new FailureException(refusal, new FailureException.Raised(FailureOrigin.Local, _side))
            {
                DestinationId = options.DestinationId,
                Header = Redact(header),
                ProcedureAddress = procedure.Address,
            };
        }

        return (header, outgoing, carried);
    }

    // lays out the header `request` goes out with, its call id aside: a credential whose bytes its
    // caller gives, a JWT or a scheme to come, may be longer than any header holds; OPAQUE, 16
    // bytes, and ELSEWHERE, none, always fit, OPAQUE's token known only once the call starts.
    // Throws an ArgumentException past 1,020 bytes
    private static void AssertHeaderHolds(CoreRequest request)
    {
        var options = request.Options;
        var asked = options.Credential is { Scheme: not (CredentialScheme.None or CredentialScheme.Opaque or CredentialScheme.Elsewhere) } given
            ? given
            : (Credential?)null;

        EnvelopeCodec.HeaderBytesOf(new RequestHeader
        {
            CallId = 1,
            ServiceId = request.Procedure.ServiceId,
            ProcedureId = request.Procedure.ProcedureId,
            DestinationId = options.DestinationId,
            OpensSubscription = request.OpensSubscription,
            Paced = request.Paced,
            Credential = asked,
        });
    }

    private async Task<RouterResult> RequestOnLoop(ReadOnlyMemory<byte> payload, CoreRequest request)
    {
        var options = request.Options;
        var procedure = request.Procedure;
        var token = options.CancellationToken;

        // what no call can take draws nothing
        if (procedure.MaximumPayloadBytes is < 1)
        {
            throw new ArgumentException(
                $"a payload's limit is a whole number above 0, not {procedure.MaximumPayloadBytes}",
                nameof(request));
        }

        // held, which its timer, its reservation and its TimeoutException all take
        var timeout = Clocks.AssertHeld(("a call's timeout", nameof(RequestOptions.Timeout)), options.Timeout);

        // drawn once the call starts: a cancelled token draws nothing
        token.ThrowIfCancellationRequested();

        // ! a credential no header of its request holds, whatever its payload, is a programmer's
        // error, thrown before the call starts and not counted (spec 4.4)
        AssertHeaderHolds(request);

        // * nothing made it a programmer's error: the call starts (spec/debugging.md 9.3), and each
        // refusal after ends it in this turn
        var counted = _metrics is { } metrics ? StartedOf(request.Series?.Calls ?? metrics.Made) : (StartedCall?)null;
        var maximumPayloadBytes = PayloadLimitOf(procedure.MaximumPayloadBytes);
        RequestHeader header;
        OutgoingTransfer? outgoing;
        string? carried;

        try
        {
            (header, outgoing, carried) = HeaderOf(payload, (request, maximumPayloadBytes));
        }
        catch (Exception reason)
        {
            counted?.End(StartedCall.EndingOf(reason));

            throw;
        }

        var callId = header.CallId;
        var pendingRequest = new PendingRequest
        {
            Carried = carried,
            Counted = counted,
            DestinationId = options.DestinationId,
            MaximumPayloadBytes = maximumPayloadBytes,
            OnSent = request.OnSent,
            ProcedureAddress = procedure.Address,
            Timeout = timeout,
        };
        var call = new CallAddress(callId, request.ConnectionHandle);

        _pendingCalls.Add(call, pendingRequest);
        request.OnCallId?.Invoke(callId);
        Wait(timeout, call, pendingRequest);

        // its token ends it: rejected here, on the core's scheduler
        using var registration = token.Register(() =>
        {
            Post(() =>
            {
                if (ReferenceEquals(_pendingCalls.Get(call), pendingRequest))
                {
                    pendingRequest.Reject(new OperationCanceledException($"call {callId} was cancelled", token));
                }
            });
        });

        if (outgoing is null)
        {
            _ = SendRequest(new Envelope { Header = header, Payload = payload }, (call, pendingRequest));
        }
        else
        {
            SendRequestTransfer(outgoing, (header, call, pendingRequest));
        }

        try
        {
            return await pendingRequest.Task;
        }
        catch (OperationCanceledException) when (pendingRequest.IsSent && ReferenceEquals(_pendingCalls.Get(call), pendingRequest))
        {
            // gone out and unanswered, ended by its token: the peer is told before the caller hears
            // of it, so a call made again in its place goes out behind the cancel
            _pendingCalls.Forget(call);
            SendCancel(call, ReservedFor(pendingRequest));

            throw;
        }
        finally
        {
            // its own entry only: a response or a close took it out already, and another may hold it
            _pendingCalls.Forget(call, pendingRequest);
        }
    }

    // a request whole, or a transfer's opening: its activity is said once its last bytes went
    private async Task SendRequest(Envelope envelope, (CallAddress Call, PendingRequest PendingRequest) waiting)
    {
        var (call, pendingRequest) = waiting;

        void HandedOff()
        {
            pendingRequest.IsSent = true;
            pendingRequest.OnSent?.Invoke(true);
        }

        try
        {
            await Carrying(envelope, (call.ConnectionHandle, pendingRequest.Carried, HandedOff, null));

            if (((RequestHeader)envelope.Header).Total is null)
            {
                _port.Activity(RouterActivity.Request, call.ConnectionHandle);
            }
        }
        catch (Exception reason)
        {
            // handed over, then refused by the transport: nothing of it went out
            if (pendingRequest.IsSent)
            {
                pendingRequest.OnSent?.Invoke(false);
            }

            pendingRequest.Reject(reason);
        }
    }

    // a request as a transfer: its opening, then each chunk credited; the call waits on the
    // transfer's inactivity, then on its own timeout once the last chunk is handed off
    private void SendRequestTransfer(OutgoingTransfer outgoing, (RequestHeader Header, CallAddress Call, PendingRequest PendingRequest) waiting)
    {
        var (header, call, pendingRequest) = waiting;

        void Progress()
        {
            Wait(Limits.TransferInactivityTimeout, call, pendingRequest);
        }

        // the last one handed off, the call waits on its timeout — unless a result opened as it went,
        // which waits on its own inactivity
        void Sent()
        {
            if (pendingRequest.Receiving is null)
            {
                Wait(pendingRequest.Timeout, call, pendingRequest);
            }
        }

        async Task SendChunk(Chunk chunk)
        {
            try
            {
                await Deliver(ChunkEnvelopeOf(call.CallId, chunk), call.ConnectionHandle, chunk.IsLast ? Sent : Progress);
            }
            catch (Exception reason)
            {
                // one that cannot go out ends the call: the peer, which holds a part of it, cancels it
                EndPending(reason, call, pendingRequest);

                return;
            }

            if (chunk.IsLast)
            {
                _port.Activity(RouterActivity.Request, call.ConnectionHandle);
            }
        }

        void Send(Chunk chunk)
        {
            _ = SendChunk(chunk);
        }

        Progress();

        // kept before its opening goes, so a credit that comes back as it goes finds it
        pendingRequest.Sending = _sendings.Open(outgoing, (call, Progress, Send));
        _ = SendRequest(new Envelope { Header = header with { Total = outgoing.Total }, Payload = outgoing.Opening }, (call, pendingRequest));
    }

    private void CancelOnLoop(CallAddress call, TimeSpan? timeout)
    {
        var pendingRequest = _pendingCalls.Get(call);

        _pendingCalls.Forget(call);

        // a request the transport never had leaves nothing at the other end to cancel
        if (pendingRequest is null || pendingRequest.IsSent)
        {
            SendCancel(call, pendingRequest is null ? timeout : ReservedFor(pendingRequest, timeout));
        }

        // heard after the cancel went out, so a call made again in its place goes out behind it
        pendingRequest?.Reject(new OperationCanceledException($"call {call.CallId} was cancelled"));
    }

    private async Task RespondOnLoop(RouterAnswer response, AnswerTarget target)
    {
        var (connectionHandle, header) = target;
        var callId = header.CallId;
        var call = new CallAddress(callId, connectionHandle);

        // a failure's code must be one before anything is done for it
        if (response.Failure is { } written)
        {
            EnvelopeCodec.WriteFailure(written);
        }

        // the call this answer is for, when this side dispatched its request
        var answering = _answeringCalls.CallOf(header);

        // a call its requester cancelled, its connection took away, or whose call id another request
        // opened since, is answered by nothing; once disposed, the answer goes on, to throw a
        // DisconnectException
        if (!_isDisposed && !_answeringCalls.IsAnswering(target))
        {
            return;
        }

        // an answer names its call alone: never its procedure, never its destination
        var result = new ResultHeader { CallId = callId };

        // the handler its request was routed to; a copy of a header finds its procedure's
        IRequestHandler? resolver = _handlers.TryGetValue(header, out var routed)
            ? routed
            : header.DestinationId is null && _resolvers.TryGetValue(new ProcedureAddress(header.ServiceId, header.ProcedureId), out var registered)
                ? registered.Resolver
                : null;

        var transfer = response.Failure is null
            ? ResultTransferOf(response.Payload, (answering, result, PayloadLimitOf(resolver?.MaximumPayloadBytes), header))
            : null;
        var undo = _port.BeforeAnswer(new AnswerInfo(target, response.Failure is not null, resolver) { Session = answering?.Session });

        // its answer going out: a second goes nowhere, and this one closes the call once done
        _answeringCalls.Answer(target);

        if (answering is not null && response.Failure is { } answeredWith)
        {
            _failuresAnswered.AddOrUpdate(header, answeredWith);
        }

        try
        {
            if (transfer is null)
            {
                await Deliver(
                    response.Failure is { } failure
                        ? new Envelope { Header = new FailureHeader { CallId = callId }, Failure = failure }
                        : new Envelope { Header = result, Payload = response.Payload },
                    connectionHandle,
                    () =>
                    {
                        // * answered: its call ends as its answer is handed to its transport
                        // (spec/debugging.md 9.1), and its call id is the peer's to open again
                        if (answering is not null)
                        {
                            EndAnswered(answering, response.Failure is { } failed ? (CallOutcome.Failure, failed) : (CallOutcome.Result, null));
                            _answeringCalls.Close(call, answering);
                        }
                    });
            }
            else
            {
                await SendResult(transfer, (connectionHandle, answering!, result));
            }
        }
        catch
        {
            // an answer that did not go out leaves nothing done for it behind, and its call closed,
            // ended with no answer handed to its transport
            undo?.Invoke();

            if (answering is not null)
            {
                EndAnswered(answering, (CallOutcome.Error, null));
                _answeringCalls.Close(call, answering);
            }

            throw;
        }
    }

    // how a result goes, decided before anything is done for it: whole — none — or as a transfer on
    // the call it answers, which it keeps open; it throws as Respond says
    private OutgoingTransfer? ResultTransferOf(
        ReadOnlyMemory<byte> payload,
        (AnsweringCall? Answering, ResultHeader Header, int MaximumPayloadBytes, RequestHeader Request) going)
    {
        var (outgoing, refusal) = TransferOf(payload, (going.Header, going.MaximumPayloadBytes));

        if (refusal is not null)
        {
            throw LocalOf(refusal, going.Header);
        }

        if (outgoing is null)
        {
            return null;
        }

        if (going.Request.OpensSubscription)
        {
            throw LocalOf(
                ProtocolFailureOf(
                    ProtocolCode.PayloadTooLarge,
                    $"a subscription's result goes in one envelope, of {_wholeBytes} bytes at most"),
                going.Header);
        }

        if (going.Answering is null)
        {
            throw new ArgumentException(
                $"a result goes as a transfer only on a call this router dispatched, not on call {going.Request.CallId}",
                nameof(payload));
        }

        return outgoing;
    }

    // a result as a transfer: its opening, then each chunk credited; its call stays open until the
    // last chunk is handed off, and the answer goes out once that one did
    private Task SendResult(OutgoingTransfer outgoing, (string ConnectionHandle, AnsweringCall Answering, ResultHeader Header) answered)
    {
        var (connectionHandle, answering, header) = answered;
        var call = new CallAddress(header.CallId, connectionHandle);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var isOpen = true;
        var generation = 0;
        ITimer? timer = null;
        Sending? sending = null;

        // nothing more goes, and nothing more ends it
        void Stop()
        {
            isOpen = false;
            generation += 1;
            timer?.Dispose();
            answering.OnAbort = null;

            if (sending is not null)
            {
                _sendings.Close(sending);
            }
        }

        // the call goes with it: its call id is the peer's to open again
        void Fail(Exception reason)
        {
            Stop();
            _answeringCalls.Close(call, answering);
            completion.TrySetException(reason);
        }

        // what the transfer does sets its timer going again — never once it stopped
        void Progress()
        {
            if (!isOpen)
            {
                return;
            }

            timer?.Dispose();
            generation += 1;

            var armed = generation;

            timer = _clock.CreateTimer(
                (_) =>
                {
                    Post(() =>
                    {
                        if (armed != generation)
                        {
                            return;
                        }

                        // silent too long, it ends, and the peer is told
                        var stalled = ProtocolFailureOf(
                            ProtocolCode.TransferStalled,
                            string.Create(CultureInfo.InvariantCulture, $"no credit came for {Limits.TransferInactivityTimeout.TotalMilliseconds} milliseconds"));

                        EndAnswered(answering, (CallOutcome.Failure, stalled));
                        Fail(LocalOf(stalled, header));
                        SendReporting(new Envelope { Header = new FailureHeader { CallId = header.CallId }, Failure = stalled }, connectionHandle);
                    });
                },
                null,
                Limits.TransferInactivityTimeout,
                Timeout.InfiniteTimeSpan);
        }

        // the last one handed off answers the call, and ends it (spec/debugging.md 9.5)
        void Sent()
        {
            Stop();
            EndAnswered(answering, (CallOutcome.Result, null));
            _answeringCalls.Close(call, answering);
        }

        async Task SendChunk(Chunk chunk)
        {
            try
            {
                await Deliver(ChunkEnvelopeOf(header.CallId, chunk), connectionHandle, chunk.IsLast ? Sent : Progress);
            }
            catch (Exception reason)
            {
                Fail(reason);

                return;
            }

            if (chunk.IsLast)
            {
                completion.TrySetResult();
            }
        }

        async Task SendOpening()
        {
            try
            {
                await Deliver(new Envelope { Header = header with { Total = outgoing.Total }, Payload = outgoing.Opening }, connectionHandle);
            }
            catch (Exception reason)
            {
                Fail(reason);
            }
        }

        void Send(Chunk chunk)
        {
            _ = SendChunk(chunk);
        }

        // the call's end ends it: a cancel, the connection gone
        void Aborted(Exception reason)
        {
            Stop();
            completion.TrySetException(reason);
        }

        // kept before its opening goes, so a credit that comes back as it goes finds it
        sending = _sendings.Open(outgoing, (call, Progress, Send));
        answering.OnAbort = Aborted;
        Progress();
        _ = SendOpening();

        return completion.Task;
    }

    // a refusal answers a request of the peer's; the answer that cannot go out is reported
    private void Refuse(Failure failure, (AnswerTarget Target, AnsweringCall Answering) dispatched)
    {
        _ = Refusing(failure, dispatched);
    }

    private async Task Refusing(Failure failure, (AnswerTarget Target, AnsweringCall Answering) dispatched)
    {
        var (target, answering) = dispatched;

        try
        {
            await RespondOnLoop(RouterAnswer.OfFailure(failure), target);
        }
        catch (Exception reason)
        {
            // a refusal that never reached the transport leaves no call open behind it
            _answeringCalls.Close(new CallAddress(target.Header.CallId, target.ConnectionHandle), answering);
            _port.Report(reason, target.ConnectionHandle);
        }
    }

    // ends a call this side answers before its answer: a result going as a transfer hears it at once,
    // and its signal is cancelled where resolvers run, so what hears it never runs on the core's
    // scheduler
    private void Abort(AnsweringCall answering, Exception reason)
    {
        answering.IsAborted = true;
        answering.OnAbort?.Invoke(reason);
        Task.Factory.StartNew(
            () =>
            {
                answering.Source.Cancel();
            },
            CancellationToken.None,
            TaskCreationOptions.DenyChildAttach,
            _resolverScheduler);
    }

    // hands a request to its resolver, where resolvers run: one that throws before it returns fails
    // as one whose task faults; one that fails before it answers is reported and answered
    // PROCEDURE_FAILED, its call id free once that answer goes; a call cancelled, or gone with its
    // connection, is not reported, and answered nothing
    private void Dispatch(IRequestHandler resolver, (AnswerTarget Target, AnsweringCall Answering, ReadOnlyMemory<byte> Payload) dispatched)
    {
        var (target, answering, payload) = dispatched;
        var props = new RequestResolverProps
        {
            ConnectionHandle = target.ConnectionHandle,
            Header = target.Header,
            IsAdmitted = true,
            Payload = payload,
            Session = answering.Session,
            Signal = answering.Source.Token,
            TransportCredential = answering.TransportCredential,
        };

        Task.Factory
            .StartNew(
                () =>
                {
                    return resolver.Handle(props);
                },
                CancellationToken.None,
                TaskCreationOptions.DenyChildAttach,
                _resolverScheduler)
            .Unwrap()
            .ContinueWith(
                (handled) =>
                {
                    if (handled.IsCompletedSuccessfully)
                    {
                        return;
                    }

                    var reason = handled.Exception?.InnerException ?? new TaskCanceledException(handled);

                    if (!answering.IsAborted)
                    {
                        _port.Report(reason, target.ConnectionHandle);
                    }

                    if (!_answeringCalls.IsAnswering(target))
                    {
                        return;
                    }

                    // ! a resolver that fails before it answers is answered PROCEDURE_FAILED, so its
                    // requester does not wait out its timeout (spec 9.5); a call cancelled, or gone
                    // with its connection, is answered nothing
                    if (answering.IsAborted)
                    {
                        EndAnswered(answering, (CallOutcome.Error, null));
                        _answeringCalls.Close(new CallAddress(target.Header.CallId, target.ConnectionHandle), answering);

                        return;
                    }

                    Refuse(ProtocolFailureOf(ProtocolCode.ProcedureFailed), (target, answering));
                },
                CancellationToken.None,
                TaskContinuationOptions.DenyChildAttach,
                Loop);
    }

    // what refuses a request before its payload is read: its resolver's admission, on its header,
    // whatever the resolver; one that throws refuses it as failed, and is reported. Its
    // SESSION_REQUIRED to a call whose header presents a credential goes out ACCESS_DENIED, its
    // detail kept (spec 9.2, step 5)
    private Failure? RefusalOf(IRequestHandler resolver, AdmissionRequest request)
    {
        Failure? refusal;

        try
        {
            refusal = resolver.Admit(request);
        }
        catch (Exception reason)
        {
            _port.Report(reason, request.ConnectionHandle);

            return ProtocolFailureOf(ProtocolCode.ProcedureFailed);
        }

        // ! never SESSION_REQUIRED to a call that presented a credential: it may hold, and its
        // requester would withdraw it (RFC 6750 §3.1, a token short of its scope answered 403)
        return refusal is { Scope: FailureScope.Protocol, Code: (ushort)ProtocolCode.SessionRequired } && request.Header.Credential is not null
            ? refusal with { Code = (ushort)ProtocolCode.AccessDenied }
            : refusal;
    }

    // what did not read: a request of the peer's on a free call id is answered; an answer of this
    // layout ends the call it is for; anything else is reported, once, or dropped when late
    private void Gate(FailureException failure, (string ConnectionHandle, EnvelopePrefix Prefix, bool IsReported) received)
    {
        var (connectionHandle, (callId, kind, layout), isReported) = received;
        var isThisLayout = layout == (byte)EnvelopeLayout.First;

        // a request of the peer's, on a call id free?
        if (kind == (byte)EnvelopeKind.Request && IsAnswerable(callId, connectionHandle))
        {
            _ = AnsweringAtGate(failure.Failure, (connectionHandle, callId));

            return;
        }

        // a chunk of this layout, of a transfer this side receives?
        if (kind == (byte)EnvelopeKind.Chunk && isThisLayout)
        {
            GateChunk(failure, (new CallAddress(callId, connectionHandle), isReported));

            return;
        }

        // an answer of this layout, to a call waiting?
        var isAnswer = kind is (byte)EnvelopeKind.Result or (byte)EnvelopeKind.Failure && isThisLayout;
        var call = new CallAddress(callId, connectionHandle);
        var pendingRequest = isAnswer ? _pendingCalls.Get(call) : null;

        if (pendingRequest is null)
        {
            // an answer of this layout on a call id reserved is late, and dropped in silence
            if (isAnswer && _pendingCalls.IsReserved(callId, connectionHandle))
            {
                return;
            }

            if (!isReported)
            {
                _port.Report(failure, connectionHandle);
            }

            return;
        }

        // the call it answers would otherwise wait out its timeout; the peer is told
        EndPending(
            new FailureException(failure.Failure, new FailureException.Raised(failure.Origin, failure.Side))
            {
                DestinationId = pendingRequest.DestinationId,
                ProcedureAddress = pendingRequest.ProcedureAddress,
            },
            call,
            pendingRequest);
    }

    // a request answered at the gate, its header unread: it starts and ends in one turn, under
    // _OTHER (spec/debugging.md 9.3), as its answer is handed to its transport; one that cannot go
    // out is reported
    private async Task AnsweringAtGate(Failure failure, (string ConnectionHandle, uint CallId) gated)
    {
        var counted = _metrics is { } metrics ? StartedOf(metrics.Answered) : (StartedCall?)null;
        var isHandedOff = false;

        try
        {
            await Deliver(
                new Envelope { Header = new FailureHeader { CallId = gated.CallId }, Failure = failure },
                gated.ConnectionHandle,
                () =>
                {
                    isHandedOff = true;
                    counted?.End((CallOutcome.Failure, failure));
                });
        }
        catch (Exception reason)
        {
            if (!isHandedOff)
            {
                counted?.End((CallOutcome.Error, null));
            }

            _port.Report(reason, gated.ConnectionHandle);
        }
    }

    // a chunk that did not read ends the transfer it was for, as invalid — unless its payload came
    // whole already; on a call id reserved or abandoned, it is late, and dropped in silence; anywhere
    // else, it is reported, once
    private void GateChunk(FailureException failure, (CallAddress Call, bool IsReported) gated)
    {
        var (call, isReported) = gated;
        var invalid = ProtocolFailureOf(ProtocolCode.ChunkInvalid, failure.Failure.Detail);

        if (CallIds.SideOf(call.CallId) == _side)
        {
            var pendingRequest = _pendingCalls.Get(call);

            if (pendingRequest?.Receiving is not null)
            {
                EndPending(
                    new FailureException(invalid, new FailureException.Raised(FailureOrigin.Local, _side))
                    {
                        DestinationId = pendingRequest.DestinationId,
                        ProcedureAddress = pendingRequest.ProcedureAddress,
                    },
                    call,
                    pendingRequest);

                return;
            }

            if (_pendingCalls.IsReserved(call.CallId, call.ConnectionHandle))
            {
                return;
            }
        }
        else
        {
            var receiving = _answeringCalls.ReceivingOf(call);

            if (receiving is not null && !IsWhole(receiving.Transfer))
            {
                Refuse(invalid, (receiving.Target, receiving.Answering));

                return;
            }

            if (_answeringCalls.AbandonedEndOf(call) is not null)
            {
                return;
            }
        }

        if (!isReported)
        {
            _port.Report(failure, call.ConnectionHandle);
        }
    }

    // a cancel from the peer ends a call it opened: forgotten first, so an answer from what hears the
    // signal finds no call to answer, then offered to the side, then the signal cancelled
    private void ReceiveCancel(CancelHeader header, string connectionHandle)
    {
        var callId = header.CallId;

        if (CallIds.SideOf(callId) == _side)
        {
            Report(
                ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, $"call {callId} is this side's, which the peer cannot cancel"),
                (connectionHandle, header));

            return;
        }

        var answering = _answeringCalls.Take(new CallAddress(callId, connectionHandle));

        _port.OnCancel(callId, connectionHandle);

        if (answering is not null)
        {
            EndAnswered(answering, (CallOutcome.Cancelled, null));
            Abort(answering, new OperationCanceledException($"call {callId} was cancelled by its requester"));
        }
    }

    private void ReceiveRequest(RequestHeader header, (string ConnectionHandle, ReadOnlyMemory<byte> Payload, string? TransportCredential) received)
    {
        var (connectionHandle, payload, _) = received;
        var callId = header.CallId;
        var target = new AnswerTarget(connectionHandle, header);

        // a request of this side's own parity, or on a call id in use, would answer another call
        if (CallIds.SideOf(callId) == _side)
        {
            Report(
                ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, $"call {callId} is this side's to open, not the peer's"),
                (connectionHandle, header));

            return;
        }

        if (_answeringCalls.Has(new CallAddress(callId, connectionHandle)) || _port.IsCallIdInUse(callId, connectionHandle))
        {
            Report(ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, $"call {callId} is open already"), (connectionHandle, header));

            return;
        }

        var answering = _answeringCalls.Open(target);
        var dispatched = (target, answering);

        // what its transport carried stands for ELSEWHERE alone, and stays here for any other
        if (header.Credential?.Scheme == CredentialScheme.Elsewhere)
        {
            answering.TransportCredential = received.TransportCredential;
        }

        // one that names a destination goes to the handler this side has for it — a relay's
        Registered? registered = null;
        IRequestHandler? resolver = header.DestinationId is not null
            ? _port.HandlerOfDestination(header)
            : _resolvers.TryGetValue(new ProcedureAddress(header.ServiceId, header.ProcedureId), out registered)
                ? registered.Resolver
                : null;

        // * the call starts as its request opens it, timed from its arrival (spec/debugging.md
        // 9.1): its procedure's series, through the resolver it is routed to; _OTHER's for a route
        // refused or a call relayed
        if (_metrics is { } metrics)
        {
            answering.Counted = StartedOf(registered?.Series?.Calls ?? metrics.Answered);
        }

        // one this side has no handler for: this peer relays nothing, to that destination or elsewhere
        if (header.DestinationId is { } unknown && resolver is null)
        {
            Refuse(
                ProtocolFailureOf(ProtocolCode.DestinationUnknown, $"this peer relays nothing, to {unknown} or elsewhere"),
                dispatched);

            return;
        }

        if (resolver is null)
        {
            Refuse(
                _services.ContainsKey(header.ServiceId)
                    ? ProtocolFailureOf(ProtocolCode.ProcedureUnknown, $"no procedure {header.ProcedureId} in service {header.ServiceId}")
                    : ProtocolFailureOf(ProtocolCode.ServiceUnknown, $"no service {header.ServiceId}"),
                dispatched);

            return;
        }

        _handlers.AddOrUpdate(header, resolver);
        Resolve(resolver, new Arrival(target, answering, payload) { TransportCredential = received.TransportCredential });
    }

    // whether a request whose credential resolves is still its call's: a cancel, its connection
    // closing or the router disposed ended it, and what its resolution brings is dropped
    private bool IsResolving(Arrival arrival)
    {
        return !_isDisposed
            && !arrival.Answering.IsAborted
            && ReferenceEquals(_answeringCalls.CallOf(arrival.Target.Header), arrival.Answering)
            && _answeringCalls.IsAnswering(arrival.Target);
    }

    // a resolution that failed: PROCEDURE_FAILED, and why reported, never SESSION_REQUIRED, which
    // would have its requester withdraw a credential that holds
    private void Fail(Exception reason, Arrival arrival)
    {
        _port.Report(reason, arrival.Target.ConnectionHandle);
        Refuse(ProtocolFailureOf(ProtocolCode.ProcedureFailed), (arrival.Target, arrival.Answering));
    }

    // step 5 of section 9.2, its first two steps: a scheme the side takes none of is refused, then
    // the credential resolves to the call's session, none and OPAQUE in the turn they came, JWT and
    // ELSEWHERE in a later one, whether their verifier waits or not. Meanwhile its call id stays
    // held, a cancel or its connection closing cancels the call's signal, which tells the verifier,
    // and its transfer's opening gets no credit
    private void Resolve(IRequestHandler resolver, Arrival arrival)
    {
        var (target, answering, _) = arrival;
        var (connectionHandle, header) = target;
        var credential = header.Credential;

        // a relay that does not verify forwards a JWT and an ELSEWHERE, which it resolves not
        var isForwarded = resolver.ForwardsCredentials;
        var schemes = isForwarded ? ForwardedSchemes : _port.CredentialSchemes;

        if (credential is { } presented && !schemes.Contains(presented.Scheme))
        {
            Refuse(ProtocolFailureOf(ProtocolCode.CredentialUnsupported, CallSession.CredentialSchemesDetailOf(schemes)), (target, answering));

            return;
        }

        var waits = credential?.Scheme is CredentialScheme.Jwt or CredentialScheme.Elsewhere;

        // an ELSEWHERE whose transport carried nothing has nothing to resolve: no credential came
        if (credential?.Scheme == CredentialScheme.Elsewhere && arrival.TransportCredential is null)
        {
            Post(() =>
            {
                if (IsResolving(arrival))
                {
                    Refuse(ProtocolFailureOf(ProtocolCode.SessionRequired, "no credential came"), (target, answering));
                }
            });

            return;
        }

        // ! read from its scheme alone, it resolves to no session here, and its destination
        // verifies it; in a later turn all the same, as a JWT and an ELSEWHERE resolve on every side
        if (waits && isForwarded)
        {
            Post(() =>
            {
                if (IsResolving(arrival))
                {
                    Admit(resolver, arrival);
                }
            });

            return;
        }

        ValueTask<CallSession?> resolving;

        try
        {
            resolving = _port.SessionOf(
                new SessionRequest { ConnectionHandle = connectionHandle, Header = header, TransportCredential = arrival.TransportCredential },
                answering.Source.Token);
        }
        catch (Exception reason)
        {
            // one that throws as it is asked fails as one that faults does, in the same turn
            resolving = ValueTask.FromException<CallSession?>(reason);
        }

        if (waits)
        {
            // * a later turn, even for a resolution that settled at once
            resolving.AsTask().ContinueWith(
                (resolved) =>
                {
                    Settle(resolver, (arrival, resolved));
                },
                CancellationToken.None,
                TaskContinuationOptions.DenyChildAttach,
                Loop);

            return;
        }

        // ! none and OPAQUE resolve in the turn they came, on every side: a resolution that waits
        // would let a request sent after it be taken first. It fails its call, reported, and what it
        // settles with is dropped
        if (!resolving.IsCompleted)
        {
            resolving.AsTask().ContinueWith(
                static (abandoned) =>
                {
                    _ = abandoned.Exception;
                },
                CancellationToken.None,
                TaskContinuationOptions.DenyChildAttach,
                TaskScheduler.Default);
            Fail(new InvalidOperationException("a request presenting none or OPAQUE resolves in the turn it came, and its session waited"), arrival);

            return;
        }

        Settle(resolver, (arrival, resolving.AsTask()));
    }

    // a credential resolved: dropped once its call ended; refused when it does not hold, or as it
    // would wait past the calls the side lets wait; otherwise the call runs in the session it
    // resolved to, whatever befell its connection's meanwhile
    private void Settle(IRequestHandler resolver, (Arrival Arrival, Task<CallSession?> Resolution) resolved)
    {
        var (arrival, resolution) = resolved;

        if (!IsResolving(arrival))
        {
            _ = resolution.Exception;

            return;
        }

        // * a call refused as it would go past a bound of the side's own: nothing failed, and
        // nothing is reported
        if (resolution.Exception?.InnerException is RefusalException refused)
        {
            Refuse(refused.Failure, (arrival.Target, arrival.Answering));

            return;
        }

        if (!resolution.IsCompletedSuccessfully)
        {
            Fail(resolution.Exception?.InnerException ?? new TaskCanceledException(resolution), arrival);

            return;
        }

        // a credential that resolves to no session does not hold, whatever the procedure requires
        if (resolution.Result is null && arrival.Target.Header.Credential is not null)
        {
            Refuse(ProtocolFailureOf(ProtocolCode.SessionRequired, "the credential does not hold"), (arrival.Target, arrival.Answering));

            return;
        }

        // a credential's session runs with the end its side keeps for its identifier, renewed by it
        arrival.Answering.Session = resolution.Result is { Identifier: not null } session
            ? _port.OnResolved(session, arrival.Target.ConnectionHandle)
            : resolution.Result;
        Admit(resolver, arrival);
    }

    // step 5 of section 9.2, its last: its admission, on the call's session; then the steps after
    // it, and its dispatch, or its transfer's first credit
    private void Admit(IRequestHandler resolver, Arrival arrival)
    {
        var (target, answering, payload) = arrival;
        var (connectionHandle, header) = target;
        var dispatched = (target, answering);

        // routed, it is asked its admission, on its header and its call's session
        if (RefusalOf(resolver, new AdmissionRequest(connectionHandle, header) { Session = answering.Session, TransportCredential = answering.TransportCredential }) is { } refusal)
        {
            Refuse(refusal, dispatched);

            return;
        }

        // admitted, one that opens a subscription where nothing this side sends of its own goes is
        // refused: no notification could reach it
        if (header.OpensSubscription && !_port.IsTwoWay(connectionHandle))
        {
            Refuse(
                ProtocolFailureOf(ProtocolCode.SubscriptionUnsupported, "this connection carries no notification back"),
                dispatched);

            return;
        }

        // admitted, past its procedure's limit — or the router's — it is refused, a transfer on the
        // total it declares, before any credit
        var maximumPayloadBytes = PayloadLimitOf(resolver.MaximumPayloadBytes);
        var length = header.Total ?? payload.Length;

        if (length > maximumPayloadBytes)
        {
            Refuse(TooLargeOf(length, maximumPayloadBytes), dispatched);

            return;
        }

        if (header.Total is not { } total)
        {
            Dispatch(resolver, (target, answering, payload));

            return;
        }

        // a transfer's opening is not its payload: refused once routed, before any credit goes;
        // opened, its call waits on the rest, which one silent too long ends
        var call = new CallAddress(header.CallId, connectionHandle);
        var (receiving, refused) = _receivings.Open(payload, (
            call,
            () =>
            {
                Refuse(
                    ProtocolFailureOf(
                        ProtocolCode.TransferStalled,
                        string.Create(CultureInfo.InvariantCulture, $"nothing came for {Limits.TransferInactivityTimeout.TotalMilliseconds} milliseconds")),
                    dispatched);
            },
            total));

        if (receiving is null)
        {
            Refuse(refused!, dispatched);

            return;
        }

        // kept before its first credit goes, so a chunk that credit brings at once finds it
        _answeringCalls.Attach(call, new RequestReceiving(target, answering, resolver, receiving));
        _receivings.Grant(receiving);
    }

    private void ReceiveAnswer(Envelope envelope, (string ConnectionHandle, bool MayOvertake) received)
    {
        var (connectionHandle, mayOvertake) = received;
        var header = envelope.Header;
        var call = new CallAddress(header.CallId, connectionHandle);

        _port.OnAnswerReceived(header, connectionHandle);

        var pendingRequest = _pendingCalls.Get(call);

        if (pendingRequest is null)
        {
            // a failure may end a call the side keeps open once answered — a subscription
            if (envelope.Failure is not null && _port.OnUnpairedFailure(envelope, connectionHandle))
            {
                return;
            }

            // one on a call id reserved is late, and dropped in silence
            if (_pendingCalls.IsReserved(header.CallId, connectionHandle))
            {
                return;
            }

            Report(ProtocolFailureOf(ProtocolCode.CallUnknown), (connectionHandle, header));

            return;
        }

        if (envelope.Failure is { } failure)
        {
            // out before it settles, so the same response again, even in the same read, pairs with
            // nothing; a result it received in part goes with it, what that credit let the peer send
            // dropped in silence behind its call id reserved
            _pendingCalls.Forget(call, pendingRequest);

            if (pendingRequest.Receiving is not null)
            {
                _pendingCalls.Reserve(call, ReservedFor(pendingRequest));
            }

            pendingRequest.Reject(new FailureException(failure, FailureException.RaisedOf(failure, _side))
            {
                DestinationId = pendingRequest.DestinationId,
                Header = Redact(header),
                MayOvertake = mayOvertake,
                ProcedureAddress = pendingRequest.ProcedureAddress,
            });
            _port.Activity(RouterActivity.Response, connectionHandle);

            return;
        }

        // a result that comes in a transfer answered the call: another answers nothing
        if (pendingRequest.Receiving is not null)
        {
            Report(
                ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, $"call {header.CallId} is answered already, by a transfer"),
                (connectionHandle, header));

            return;
        }

        var result = (ResultHeader)header;

        if (result.Total is not { } total)
        {
            // out before it settles, so the same response again, even in the same read, pairs with nothing
            _pendingCalls.Forget(call, pendingRequest);
            pendingRequest.Resolve(new RouterResult(result, envelope.Payload));
            _port.Activity(RouterActivity.Response, connectionHandle);

            return;
        }

        // a transfer's opening is not its result: one refused — past its procedure's limit, say — ends
        // the call, and the peer, which holds the result still, is told to cancel it; opened, the call
        // waits on the rest, which one silent too long ends — its own timer, rather than the transfer's
        var (receiving, refusal) = total > pendingRequest.MaximumPayloadBytes
            ? (null, TooLargeOf(total, pendingRequest.MaximumPayloadBytes))
            : _receivings.Open(envelope.Payload, (call, null, total));

        if (receiving is null)
        {
            EndPending(
                new FailureException(refusal!, new FailureException.Raised(FailureOrigin.Local, _side))
                {
                    DestinationId = pendingRequest.DestinationId,
                    Header = Redact(header),
                    ProcedureAddress = pendingRequest.ProcedureAddress,
                },
                call,
                pendingRequest);

            return;
        }

        Wait(Limits.TransferInactivityTimeout, call, pendingRequest);

        // kept before its first credit goes, so a chunk that credit brings at once finds it
        pendingRequest.Receiving = new ResultReceiving(result, receiving);
        _receivings.Grant(receiving);
    }

    private void ReceiveNotification(Envelope envelope, string connectionHandle)
    {
        var header = (NotificationHeader)envelope.Header;

        if (!_port.TakesNotifications)
        {
            Report(ProtocolFailureOf(ProtocolCode.KindUnsupported, "this side takes no notification"), (connectionHandle, header));

            return;
        }

        // one on a call id reserved was on its way, and is dropped in silence
        if (_pendingCalls.IsReserved(header.CallId, connectionHandle))
        {
            return;
        }

        _port.OnNotification(header, (connectionHandle, envelope.Payload));
    }

    // a chunk no transfer takes: on a call abandoned, one under the credit it granted is late, and
    // dropped in silence, and one past it was never granted; on a call open without a transfer, or on
    // none, it is reported
    private void ReceiveUnplaced(Envelope envelope, (string ConnectionHandle, long? CreditEnd, bool IsOpen) unplaced)
    {
        var header = (ChunkHeader)envelope.Header;

        if (unplaced.CreditEnd is { } creditEnd)
        {
            if (envelope.Payload.Length <= creditEnd - header.Offset)
            {
                return;
            }

            Report(
                ProtocolFailureOf(ProtocolCode.CreditExceeded, $"bytes from {header.Offset} run past the credit's end of {creditEnd}"),
                (unplaced.ConnectionHandle, header));

            return;
        }

        Report(
            unplaced.IsOpen
                ? ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, $"call {header.CallId} receives no transfer")
                : ProtocolFailureOf(ProtocolCode.CallUnknown),
            (unplaced.ConnectionHandle, header));
    }

    // a chunk of a request's payload: the call is the peer's
    private void ReceiveRequestChunk(Envelope envelope, (CallAddress Call, Chunk Chunk) received)
    {
        var (call, chunk) = received;

        if (_answeringCalls.ReceivingOf(call) is not { } receiving)
        {
            ReceiveUnplaced(envelope, (call.ConnectionHandle, _answeringCalls.AbandonedEndOf(call), _answeringCalls.Has(call)));

            return;
        }

        // once whole, the payload went on to the resolver, which answers the call: a chunk ends nothing
        var wasWhole = IsWhole(receiving.Transfer);
        var (outcome, refusal) = _receivings.Place(receiving.Transfer, chunk);

        switch (outcome)
        {
            case ChunkOutcome.Refused when wasWhole:
                Report(refusal!, (call.ConnectionHandle, envelope.Header));
                break;
            case ChunkOutcome.Refused:
                Refuse(refusal!, (receiving.Target, receiving.Answering));
                break;
            case ChunkOutcome.Placed:
                _receivings.Grant(receiving.Transfer);
                break;
            case ChunkOutcome.Complete:
                Dispatch(receiving.Resolver, (receiving.Target, receiving.Answering, _receivings.Complete(receiving.Transfer)));
                break;

            // a chunk that brings nothing new is dropped in silence
            case ChunkOutcome.Duplicate:
                break;
        }
    }

    // a chunk of a call's result: the call is this side's
    private void ReceiveResultChunk(Envelope envelope, (CallAddress Call, Chunk Chunk) received)
    {
        var (call, chunk) = received;
        var pendingRequest = _pendingCalls.Get(call);

        if (pendingRequest?.Receiving is not { } receiving)
        {
            // one on a call id reserved was on its way, and is dropped in silence
            if (_pendingCalls.IsReserved(call.CallId, call.ConnectionHandle))
            {
                return;
            }

            ReceiveUnplaced(envelope, (call.ConnectionHandle, null, pendingRequest is not null));

            return;
        }

        var (outcome, refusal) = _receivings.Place(receiving.Transfer, chunk);

        switch (outcome)
        {
            case ChunkOutcome.Refused:
                EndPending(
                    new FailureException(refusal!, new FailureException.Raised(FailureOrigin.Local, _side))
                    {
                        DestinationId = pendingRequest.DestinationId,
                        ProcedureAddress = pendingRequest.ProcedureAddress,
                    },
                    call,
                    pendingRequest);
                break;

            // bytes placed are progress
            case ChunkOutcome.Placed:
                Wait(Limits.TransferInactivityTimeout, call, pendingRequest);
                _receivings.Grant(receiving.Transfer);
                break;
            case ChunkOutcome.Complete:
                var payload = _receivings.Complete(receiving.Transfer);

                // out before it settles; what its credit let the peer send may still come, a copy or
                // out of order, and its call id stays reserved, for it to be dropped in silence
                _pendingCalls.Forget(call, pendingRequest);
                _pendingCalls.Reserve(call, ReservedFor(pendingRequest));
                pendingRequest.Resolve(new RouterResult(receiving.Header, payload));
                _port.Activity(RouterActivity.Response, call.ConnectionHandle);
                break;

            // a chunk that brings nothing new is dropped in silence
            case ChunkOutcome.Duplicate:
                break;
        }
    }

    // a chunk of a transfer this side receives: on the peer's call id, of a request's payload; on
    // this side's, of a result's
    private void ReceiveChunk(Envelope envelope, string connectionHandle)
    {
        var header = (ChunkHeader)envelope.Header;
        var received = (new CallAddress(header.CallId, connectionHandle), new Chunk(envelope.Payload, header.IsLast, header.Offset));

        if (CallIds.SideOf(header.CallId) == _side)
        {
            ReceiveResultChunk(envelope, received);

            return;
        }

        ReceiveRequestChunk(envelope, received);
    }

    private void ReceiveCredit(CreditHeader header, string connectionHandle)
    {
        // one for no transfer this side sends may have crossed its end: dropped in silence
        if (!header.Paced)
        {
            _sendings.Credit(new CallAddress(header.CallId, connectionHandle), header.CreditEnd);

            return;
        }

        if (!_port.SendsNotifications)
        {
            Report(ProtocolFailureOf(ProtocolCode.KindUnsupported, "this side sends no notification"), (connectionHandle, header));

            return;
        }

        _port.OnSubscriptionCredit(header, connectionHandle);
    }

    private void ReceiveOnLoop(TransportMessage message, string connectionHandle)
    {
        var data = message.Bytes;
        EnvelopePrefix prefix;

        try
        {
            prefix = EnvelopeCodec.ReadPrefix(data.Span, _side);
        }
        catch (FailureException reason)
        {
            // what is not an envelope's prefix has no call to answer: it is reported
            _port.Report(reason, connectionHandle);

            return;
        }
        catch (Exception reason)
        {
            // as ENVELOPE_MALFORMED, its words with it, with the connection it came on
            var raised = new FailureException.Raised(FailureOrigin.Local, _side);

            _port.Report(
                new FailureException(ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, reason.Message), (raised, reason)),
                connectionHandle);

            return;
        }

        Envelope? envelope;

        try
        {
            envelope = EnvelopeCodec.ReadEnvelope(
                data.Span,
                new EnvelopeReadOptions
                {
                    Side = _side,
                    MaximumDetailBytes = Limits.MaximumDetailBytes,
                    MaximumEnvelopeBytes = Limits.MaximumEnvelopeBytes,
                });
        }
        catch (FailureException reason)
        {
            Gate(reason, (connectionHandle, prefix, false));

            return;
        }
        catch (Exception reason)
        {
            // ! a codec that throws other than a refusal throws an error of this side's own: reported,
            // its words with it, while what answers or ends a call for it is ENVELOPE_MALFORMED with
            // none of them, which a peer's bytes could reach (spec 9.0)
            var raised = new FailureException.Raised(FailureOrigin.Local, _side);

            _port.Report(
                new FailureException(ProtocolFailureOf(ProtocolCode.EnvelopeMalformed, reason.Message), (raised, reason)),
                connectionHandle);
            Gate(new FailureException(ProtocolFailureOf(ProtocolCode.EnvelopeMalformed), (raised, reason)), (connectionHandle, prefix, true));

            return;
        }

        // an advisory kind is skipped
        if (envelope is null)
        {
            return;
        }

        // * one check an envelope while nobody listens: redacted for a listener alone
        if (_port.IsTracing)
        {
            _port.Trace(DebugDirection.Rx, new TracedEnvelope(connectionHandle, Redact(envelope.Header)));
        }

        switch (envelope.Header)
        {
            case RequestHeader request:
                ReceiveRequest(request, (connectionHandle, envelope.Payload, message.Credential));
                break;
            case ResultHeader or FailureHeader:
                ReceiveAnswer(envelope, (connectionHandle, message.MayOvertake));
                break;
            case NotificationHeader:
                ReceiveNotification(envelope, connectionHandle);
                break;
            case ChunkHeader:
                ReceiveChunk(envelope, connectionHandle);
                break;
            case CreditHeader credit:
                ReceiveCredit(credit, connectionHandle);
                break;
            case CancelHeader cancel:
                ReceiveCancel(cancel, connectionHandle);
                break;
        }
    }

    private void RejectPendingOnLoop(string reason, string? connectionHandle)
    {
        // what the connection receives, what it opened, what it answers, and what it was told of its
        // session, go with it, before anything hears of it; its transfers first, so the budget they
        // give back grants no credit to one about to go
        _receivings.CloseAll(connectionHandle);

        var rejected = _pendingCalls.TakeAll(connectionHandle);
        var aborted = _answeringCalls.TakeAll(connectionHandle);

        if (connectionHandle is null)
        {
            _announced.Clear();
        }
        else
        {
            _announced.Remove(connectionHandle);
        }

        // the signals first, which are cancelled in their turn where resolvers run: a resolver that
        // waits on one of its own calls, a relay's leg B, hears it ended before that call's rejection
        foreach (var answering in aborted)
        {
            EndAnswered(answering, (CallOutcome.Closed, null));
            Abort(answering, new DisconnectException(reason));
        }

        foreach (var pendingRequest in rejected)
        {
            pendingRequest.Reject(new DisconnectException(reason));
        }
    }

    // definition

    /// <summary>
    /// Cancels a call this side opened: one still waiting throws an
    /// <see cref="OperationCanceledException"/>, the peer is sent a cancel, and the call id is
    /// reserved for <paramref name="timeout"/> — the call's own when it is waiting and none is given.
    /// A call id reserved already, or a router disposed, sends nothing. A timeout is rounded to the
    /// nearest whole millisecond; infinite, a call that waited on, reserves it for the default time;
    /// any other that is not from 1 to <see cref="Clocks.LongestTimer"/>, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>, and nothing is done.
    /// </summary>
    public void Cancel(CallAddress call, TimeSpan? timeout = null)
    {
        var held = PendingCalls.AssertReservation(timeout);

        if (Loop.IsCurrent)
        {
            CancelOnLoop(call, held);

            return;
        }

        Post(() =>
        {
            CancelOnLoop(call, held);
        });
    }

    /// <summary>
    /// Reserves this side's call id on a connection for <paramref name="timeout"/>, rounded to the
    /// nearest whole millisecond, or for the default time for none or infinite: draws skip it, and
    /// what comes late on it is dropped in silence. Reserved twice, the later end stands. Any other
    /// timeout that is not from 1 to <see cref="Clocks.LongestTimer"/>, zero among them, is an
    /// <see cref="ArgumentOutOfRangeException"/>, as for <see cref="Cancel"/>.
    /// </summary>
    public void Reserve(CallAddress call, TimeSpan? timeout = null)
    {
        var held = PendingCalls.AssertReservation(timeout);

        if (Loop.IsCurrent)
        {
            _pendingCalls.Reserve(call, held);

            return;
        }

        Post(() =>
        {
            _pendingCalls.Reserve(call, held);
        });
    }

    /// <summary>
    /// Takes an envelope from a connection: read, traced, then dispatched by kind, on the core's
    /// scheduler, after what came before it. What does not read goes through the gate of section 9.6
    /// of the spec. The bytes must not change afterwards.
    /// </summary>
    public void Receive(ReadOnlyMemory<byte> data, string connectionHandle)
    {
        Receive(new TransportMessage(data, false), connectionHandle);
    }

    /// <summary>
    /// As <see cref="Receive(ReadOnlyMemory{byte}, string)"/>, with the credential its transport
    /// carried beside it, which a request presenting <see cref="CredentialScheme.Elsewhere"/>
    /// resolves.
    /// </summary>
    public void Receive(TransportMessage message, string connectionHandle)
    {
        Post(() =>
        {
            ReceiveOnLoop(message, connectionHandle);
        });
    }

    /// <summary>
    /// Registers a resolver; a procedure out of its range, off its form or against its kind (spec
    /// 16.10), first, then a second one for its procedure, a payload's limit below 1, or a procedure
    /// its router's registry refuses to declare (spec/debugging.md 7.3), is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public void RegisterResolver(IRequestResolver resolver)
    {
        ArgumentNullException.ThrowIfNull(resolver);

        var procedure = resolver.Procedure;

        // the call checked by the way it is declared: a resolver that notifies, or not, on this side
        Identity.Check(procedure, (Identity.ResolverWayOf(_port.Side, resolver is INotificationResolver), nameof(resolver)));

        if (resolver.MaximumPayloadBytes is < 1)
        {
            throw new ArgumentException(
                $"{procedure.ProcedureName}'s payload limit is a whole number above 0, not {resolver.MaximumPayloadBytes}",
                nameof(resolver));
        }

        if (_resolvers.ContainsKey(procedure.Address))
        {
            throw new ArgumentException($"{procedure.ProcedureName} is already a registered resolver", nameof(resolver));
        }

        // declared as it is registered (spec/debugging.md 7.2): one its router's registry refuses is
        // not registered either
        var series = _metrics?.DeclareResolver(procedure, resolver is INotificationResolver);

        if (!_resolvers.TryAdd(procedure.Address, new Registered(resolver, series)))
        {
            throw new ArgumentException($"{procedure.ProcedureName} is already a registered resolver", nameof(resolver));
        }

        _services.AddOrUpdate(
            procedure.ServiceId,
            1,
            (_, count) =>
            {
                return count + 1;
            });
    }

    /// <summary>
    /// Rejects what waits for an answer — from a connection only, when given — with a
    /// <see cref="DisconnectException"/> saying <paramref name="reason"/>, and forgets the calls the
    /// connection opened and the call ids it reserved; the signal of each call it opened is
    /// cancelled first.
    /// </summary>
    public void RejectPending(string reason, string? connectionHandle = null)
    {
        Post(() =>
        {
            RejectPendingOnLoop(reason, connectionHandle);
        });
    }

    /// <summary>
    /// Sends a request under a call id of this side's, and settles with its result. Throws a
    /// <see cref="FailureException"/> for a failure answered, a payload too large, or every call id
    /// taken; an <see cref="ArgumentException"/>, drawing nothing, for a procedure's limit below 1
    /// or a timeout no timer holds; a <see cref="TimeoutException"/> past its timeout, and an
    /// <see cref="OperationCanceledException"/> once its token is cancelled — once it went out,
    /// it cancels its call before its caller hears of it.
    /// </summary>
    public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, CoreRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        return Loop.Run(() =>
        {
            return RequestOnLoop(payload, request);
        });
    }

    /// <summary>
    /// Answers a request, on its call id alone, while its call is open; once cancelled, or gone with
    /// its connection, nothing goes out. A result too large for one envelope goes as a transfer, and
    /// the task settles once its last chunk went. A result past its limit, one that would need a
    /// transfer where this side sends none, or a subscription's that would need one, is a
    /// <see cref="FailureException"/>, and nothing goes out; a failure of code 0, or a result that
    /// would need a transfer on a call this side never dispatched, is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public Task Respond(RouterAnswer response, AnswerTarget target)
    {
        ArgumentNullException.ThrowIfNull(response);

        return Loop.Run(() =>
        {
            return RespondOnLoop(response, target);
        });
    }

    /// <summary>
    /// Sends an envelope to a connection. One past its limits is a <see cref="FailureException"/>,
    /// and nothing goes out.
    /// </summary>
    public Task Send(Envelope envelope, string connectionHandle)
    {
        ArgumentNullException.ThrowIfNull(envelope);

        return Loop.Run(() =>
        {
            return Deliver(envelope, connectionHandle);
        });
    }

    /// <summary>
    /// The failure the call of a request this side dispatched was answered with, kept once its call
    /// closed: so its resolver, answering after it, finds the failure its router answered in its
    /// place. None for a request answered otherwise, not yet answered, or never dispatched. From any
    /// thread.
    /// </summary>
    public Failure? AnsweredOf(AnswerTarget target)
    {
        ArgumentNullException.ThrowIfNull(target.Header);

        return _failuresAnswered.TryGetValue(target.Header, out var failure) ? failure : null;
    }

    /// <summary>Whether the call of a request is still to be answered; on the core's scheduler alone.</summary>
    internal bool IsAnswering(AnswerTarget target)
    {
        return _answeringCalls.IsAnswering(target);
    }

    /// <summary>
    /// The session a request this side dispatched runs in, its call's, while its call is open; none
    /// for one in none, or gone. On the core's scheduler alone.
    /// </summary>
    internal CallSession? SessionOf(AnswerTarget target)
    {
        return _answeringCalls.CallOf(target.Header)?.Session;
    }

    /// <summary>The series a procedure's notifications count into, its resolver's as it was registered; none for none.</summary>
    internal NotifyingSeries? NotifyingSeriesOf(ProcedureAddress procedure)
    {
        return _resolvers.TryGetValue(procedure, out var registered) ? registered.Series?.Notifying : null;
    }

    /// <summary>
    /// Sends a notification to a connection, counted into <c>Series</c> as it is handed to its
    /// transport, or as it cannot be: as <see cref="Send"/> otherwise.
    /// </summary>
    internal Task SendNotification(Envelope envelope, (string ConnectionHandle, NotifyingSeries? Series) going)
    {
        return Loop.Run(() =>
        {
            return Carrying(envelope, (going.ConnectionHandle, null, null, going.Series));
        });
    }

    /// <summary>
    /// What it holds, its parts' together: the calls it waits on and reserves, those it answers and
    /// abandoned, the transfers it sends and receives, and the connections told of a session; on the
    /// core's scheduler alone.
    /// </summary>
    internal Gauges Gauges()
    {
        return Bead.Gauges.Merge(
        [
            _pendingCalls.Gauges(),
            _answeringCalls.Gauges(),
            _sendings.Gauges(),
            _receivings.Gauges(),
            Bead.Gauges.Of(new Dictionary<string, long> { ["announced"] = _announced.Count }, _announced.Keys),
        ]);
    }

    /// <summary>
    /// Rejects what still waits, cancels the signal of each call it still answers, and sends
    /// nothing more: no cancel either.
    /// </summary>
    public void Dispose()
    {
        _isDisposed = true;
        RejectPending($"{Disposed} before the answer");
    }

    // a resolver registered, and its series, made as it was declared; none while its router counts
    // nothing
    private sealed record Registered(IRequestResolver Resolver, ResolverSeries? Series);

    // a request of the peer's, routed: where it is answered, its call, its payload — a transfer's
    // opening, for one — and the credential its transport carried beside it
    private sealed record Arrival(AnswerTarget Target, AnsweringCall Answering, ReadOnlyMemory<byte> Payload)
    {
        public string? TransportCredential { get; init; }

        // every member as the compiler writes it, but the credential, of which whether one was
        // carried
        private bool PrintMembers(StringBuilder builder)
        {
            // ! a credential's own string reaches no log, no exception's message and no debugger
            // (spec 15.1): whether there is one, alone
            builder.Append(CultureInfo.CurrentCulture, $"Target = {Target}, Answering = {Answering}, Payload = {Payload}, TransportCredential = ");
            builder.Append(TransportCredential is null ? "none" : "carried");

            return true;
        }
    }
}
