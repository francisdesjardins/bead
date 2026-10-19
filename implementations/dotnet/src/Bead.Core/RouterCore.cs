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
public sealed partial class RouterCore : IDisposable
{
    // constants

    private const string Disposed = "the router was disposed";

    // what a relay that does not verify takes at step 1 of section 14.3: none and OPAQUE it resolves,
    // a JWT and an ELSEWHERE it forwards
    private static readonly CredentialScheme[] ForwardedSchemes = [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere];

    private readonly IRouterCorePort _port;
    private readonly RouterSide _side;
    private readonly RouterWriter _writer;
    private readonly PayloadPlacement _placement;
    private readonly TimeProvider _clock;
    private readonly TaskScheduler _resolverScheduler;
    private readonly ReceivingTransfers _receivings;
    private readonly SendingTransfers _sendings = new();
    private readonly RouterRequester _requester;
    private readonly AnsweringCalls _answeringCalls;
    private readonly ConcurrentDictionary<ProcedureAddress, Registered> _resolvers = new();
    private readonly ConcurrentDictionary<ushort, int> _services = new();

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

        _writer = new RouterWriter(_port, new RouterWriter.Options
        {
            Limits = Limits,
            IsDisposed = () =>
            {
                return _isDisposed;
            },
        });

        _placement = new PayloadPlacement(Limits);
        _receivings = new ReceivingTransfers(new ReceivingTransfersOptions
        {
            Limits = Limits,
            PayloadBytesPerChunk = _placement.PayloadBytesPerChunk,
            Post = Post,
            SendCredit = (call, creditEnd) =>
            {
                _writer.SendReporting(
                    new Envelope { Header = new CreditHeader { CallId = call.CallId, CreditEnd = creditEnd } },
                    call.ConnectionHandle);
            },
            Clock = _clock,
        });

        _requester = new RouterRequester(new RequesterPort(this), new RouterRequester.Options
        {
            Side = _side,
            Clock = _clock,
            Limits = Limits,
            Metrics = _metrics,
            LastCallId = options?.LastCallId,
            Writer = _writer,
            Placement = _placement,
            Receivings = _receivings,
            Sendings = _sendings,
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

    // whether every byte of a transfer came
    private static bool IsWhole(Receiving receiving)
    {
        return receiving.Incoming.Contiguous == receiving.Incoming.Total;
    }

    private static Failure ProtocolFailureOf(ProtocolCode code, string detail = "")
    {
        return new Failure { Code = (ushort)code, Detail = detail, Scope = FailureScope.Protocol };
    }

    private static FailureException LocalOf(Failure failure, (RouterSide Side, IEnvelopeHeader? Header) raised)
    {
        return new FailureException(failure, new FailureException.Raised(FailureOrigin.Local, raised.Side))
        {
            Header = raised.Header is null ? null : Redact(raised.Header),
        };
    }

    // a call counted as it starts, under its series, at this instant
    private static StartedCall StartedOf(CallSeries series, TimeProvider clock)
    {
        series.Start();

        return new StartedCall { Clock = clock, Series = series, Timestamp = clock.GetTimestamp() };
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
        _port.Report(LocalOf(failure, (_side, about.Header)), about.ConnectionHandle);
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
            ? ResultTransferOf(response.Payload, (answering, result, _placement.PayloadLimitOf(resolver?.MaximumPayloadBytes), header))
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
                await _writer.Deliver(
                    response.Failure is { } failure
                        ? new Envelope { Header = new FailureHeader { CallId = callId }, Failure = failure }
                        : new Envelope { Header = result, Payload = response.Payload },
                    (connectionHandle,
                    () =>
                    {
                        // * answered: its call ends as its answer is handed to its transport
                        // (spec/debugging.md 9.1), and its call id is the peer's to open again
                        if (answering is not null)
                        {
                            EndAnswered(answering, response.Failure is { } failed ? (CallOutcome.Failure, failed) : (CallOutcome.Result, null));
                            _answeringCalls.Close(call, answering);
                        }
                    }
                ));
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
        var (outgoing, refusal) = _placement.TransferOf(payload, (going.Header, going.MaximumPayloadBytes));

        if (refusal is not null)
        {
            throw LocalOf(refusal, (_side, going.Header));
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
                    $"a subscription's result goes in one envelope, of {_placement.WholeBytes} bytes at most"),
                (_side, going.Header));
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
                        Fail(LocalOf(stalled, (_side, header)));
                        _writer.SendReporting(new Envelope { Header = new FailureHeader { CallId = header.CallId }, Failure = stalled }, connectionHandle);
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
                await _writer.Deliver(PayloadPlacement.ChunkEnvelopeOf(header.CallId, chunk), (connectionHandle, chunk.IsLast ? Sent : Progress));
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
                await _writer.Deliver(new Envelope { Header = header with { Total = outgoing.Total }, Payload = outgoing.Opening }, connectionHandle);
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

        if (isAnswer)
        {
            _requester.GateMalformedAnswer(failure, (new CallAddress(callId, connectionHandle), isReported));

            return;
        }

        if (!isReported)
        {
            _port.Report(failure, connectionHandle);
        }
    }

    // a request answered at the gate, its header unread: it starts and ends in one turn, under
    // _OTHER (spec/debugging.md 9.3), as its answer is handed to its transport; one that cannot go
    // out is reported
    private async Task AnsweringAtGate(Failure failure, (string ConnectionHandle, uint CallId) gated)
    {
        var counted = _metrics is { } metrics ? StartedOf(metrics.Answered, _clock) : (StartedCall?)null;
        var isHandedOff = false;

        try
        {
            await _writer.Deliver(
                new Envelope { Header = new FailureHeader { CallId = gated.CallId }, Failure = failure },
                (gated.ConnectionHandle,
                () =>
                {
                    isHandedOff = true;
                    counted?.End((CallOutcome.Failure, failure));
                }
            ));
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

        if (CallIds.SideOf(call.CallId) == _side)
        {
            _requester.GateMalformedResultChunk(failure, gated);

            return;
        }

        var invalid = ProtocolFailureOf(ProtocolCode.ChunkInvalid, failure.Failure.Detail);
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

        // ! what its transport carried stands for ELSEWHERE alone, and stays here for any other: its
        // SessionOf, its admission and its resolver are handed nothing beside it (spec 15.1)
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
            answering.Counted = StartedOf(registered?.Series?.Calls ?? metrics.Answered, _clock);
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
        Resolve(resolver, new Arrival(target, answering, payload) { TransportCredential = answering.TransportCredential });
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
        var maximumPayloadBytes = _placement.PayloadLimitOf(resolver.MaximumPayloadBytes);
        var length = header.Total ?? payload.Length;

        if (length > maximumPayloadBytes)
        {
            Refuse(PayloadPlacement.TooLargeOf(length, maximumPayloadBytes), dispatched);

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

    private void ReceiveNotification(Envelope envelope, string connectionHandle)
    {
        var header = (NotificationHeader)envelope.Header;

        if (!_port.TakesNotifications)
        {
            Report(ProtocolFailureOf(ProtocolCode.KindUnsupported, "this side takes no notification"), (connectionHandle, header));

            return;
        }

        // one on a call id reserved was on its way, and is dropped in silence
        if (_requester.IsReserved(header.CallId, connectionHandle))
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

    // a chunk of a transfer this side receives: on the peer's call id, of a request's payload; on
    // this side's, of a result's
    private void ReceiveChunk(Envelope envelope, string connectionHandle)
    {
        var header = (ChunkHeader)envelope.Header;
        var received = (new CallAddress(header.CallId, connectionHandle), new Chunk(envelope.Payload, header.IsLast, header.Offset));

        if (CallIds.SideOf(header.CallId) == _side)
        {
            _requester.ReceiveResultChunk(envelope, received);

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
                _requester.ReceiveAnswer(envelope, (connectionHandle, message.MayOvertake));
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

        var rejected = _requester.TakeAll(connectionHandle);
        var aborted = _answeringCalls.TakeAll(connectionHandle);

        _writer.Forget(connectionHandle);

        // the signals first, which are cancelled in their turn where resolvers run: a resolver that
        // waits on one of its own calls, a relay's leg B, hears it ended before that call's rejection
        foreach (var answering in aborted)
        {
            EndAnswered(answering, (CallOutcome.Closed, null));
            Abort(answering, new DisconnectException(reason));
        }

        rejected.Reject(reason);
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
            _requester.CancelOnLoop(call, held);

            return;
        }

        Post(() =>
        {
            _requester.CancelOnLoop(call, held);
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
            _requester.Reserve(call, held);

            return;
        }

        Post(() =>
        {
            _requester.Reserve(call, held);
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
            return _requester.RequestOnLoop(payload, request);
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
            return _writer.Deliver(envelope, connectionHandle);
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
            return _writer.Carrying(envelope, (going.ConnectionHandle, null, null, going.Series));
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
            _requester.Gauges(),
            _answeringCalls.Gauges(),
            _sendings.Gauges(),
            _receivings.Gauges(),
            _writer.Gauges(),
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

    // what the requester asks of the core it serves: the core's port, its scheduler, whether it was
    // disposed, its reader of a chunk no transfer takes, and its report of what it raises itself
    private sealed class RequesterPort(RouterCore core) : IRouterRequesterPort
    {
        public bool IsDisposed
        {
            get
            {
                return core._isDisposed;
            }
        }

        public void Post(Action action)
        {
            core.Post(action);
        }

        public bool IsCallIdInUse(uint callId, string connectionHandle)
        {
            return core._port.IsCallIdInUse(callId, connectionHandle);
        }

        public bool IsOpen(string connectionHandle)
        {
            return core._port.IsOpen(connectionHandle);
        }

        public SessionToken? KnownSessionTokenOf(string connectionHandle)
        {
            return core._port.KnownSessionTokenOf(connectionHandle);
        }

        public bool Carries(string credential, string connectionHandle)
        {
            return core._port.Carries(credential, connectionHandle);
        }

        public bool IsSecure(string connectionHandle)
        {
            return core._port.IsSecure(connectionHandle);
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            core._port.Report(reason, connectionHandle);
        }

        public void ReportFailure(Failure failure, (string ConnectionHandle, IEnvelopeHeader Header) about)
        {
            core.Report(failure, about);
        }

        public void Activity(RouterActivity kind, string connectionHandle)
        {
            core._port.Activity(kind, connectionHandle);
        }

        public void OnAnswerReceived(IEnvelopeHeader header, string connectionHandle)
        {
            core._port.OnAnswerReceived(header, connectionHandle);
        }

        public bool OnUnpairedFailure(Envelope envelope, string connectionHandle)
        {
            return core._port.OnUnpairedFailure(envelope, connectionHandle);
        }

        public void ReceiveUnplaced(Envelope envelope, (string ConnectionHandle, long? CreditEnd, bool IsOpen) unplaced)
        {
            core.ReceiveUnplaced(envelope, unplaced);
        }
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
