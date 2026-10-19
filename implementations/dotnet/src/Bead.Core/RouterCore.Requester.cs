using System.Globalization;

namespace Bead;

internal sealed partial class RouterCore
{
    // what the requester asks of the core it serves
    private interface IRouterRequesterPort
    {
        // whether the core is disposed, read at each call
        bool IsDisposed { get; }

        // runs an action on the core's scheduler, after what came before it
        void Post(Action action);

        // whether the side holds a call id beyond what the core waits on: none is drawn
        bool IsCallIdInUse(uint callId, string connectionHandle);

        // whether a connection is open
        bool IsOpen(string connectionHandle);

        // the session a connection was last told of, which a request may present
        SessionToken? KnownSessionTokenOf(string connectionHandle);

        // whether a connection's transport carries a credential beside an envelope
        bool Carries(string credential, string connectionHandle);

        // whether a connection's transport is secure
        bool IsSecure(string connectionHandle);

        // what went wrong that no call waits on, with its connection
        void Report(Exception reason, string? connectionHandle);

        // a failure the core raises itself, on what came in, for the side to hear
        void ReportFailure(Failure failure, (string ConnectionHandle, IEnvelopeHeader Header) about);

        // what the router did: sent a request, or took the response to one
        void Activity(RouterActivity kind, string connectionHandle);

        // every result and every failure received, before it is paired with its request
        void OnAnswerReceived(IEnvelopeHeader header, string connectionHandle);

        // a failure that answers no call waiting; true when the side took it
        bool OnUnpairedFailure(Envelope envelope, string connectionHandle);

        // a chunk no transfer takes, on a call open or on none, as the core reads one
        void ReceiveUnplaced(Envelope envelope, (string ConnectionHandle, long? CreditEnd, bool IsOpen) unplaced);
    }

    // calls this side starts, and the request and result transfers they hold in the shared pools
    private sealed class RouterRequester
    {
        private readonly IRouterRequesterPort _port;
        private readonly RouterSide _side;
        private readonly TimeProvider _clock;
        private readonly RouterLimits _limits;
        private readonly RouterSeries? _metrics;
        private readonly RouterWriter _writer;
        private readonly PayloadPlacement _placement;
        private readonly ReceivingTransfers _receivings;
        private readonly SendingTransfers _sendings;
        private readonly PendingCalls _pendingCalls;

        internal RouterRequester(IRouterRequesterPort port, Options options)
        {
            _port = port;
            _side = options.Side;
            _clock = options.Clock;
            _limits = options.Limits;
            _metrics = options.Metrics;
            _writer = options.Writer;
            _placement = options.Placement;
            _receivings = options.Receivings;
            _sendings = options.Sendings;

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
                    LastCallId = options.LastCallId,
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
                    Post = _port.Post,
                    Clock = _clock,
                });
        }

        internal sealed record Options
        {
            internal required RouterSide Side { get; init; }

            internal required TimeProvider Clock { get; init; }

            internal required RouterLimits Limits { get; init; }

            internal RouterSeries? Metrics { get; init; }

            internal uint? LastCallId { get; init; }

            internal required RouterWriter Writer { get; init; }

            internal required PayloadPlacement Placement { get; init; }

            internal required ReceivingTransfers Receivings { get; init; }

            internal required SendingTransfers Sendings { get; init; }
        }

        // whether a call id of this side's is reserved on a connection
        internal bool IsReserved(uint callId, string connectionHandle)
        {
            return _pendingCalls.IsReserved(callId, connectionHandle);
        }

        // reserves a call id, as the core's Reserve does
        internal void Reserve(CallAddress call, TimeSpan? timeout)
        {
            _pendingCalls.Reserve(call, timeout);
        }

        // the pending calls' gauges
        internal Gauges Gauges()
        {
            return _pendingCalls.Gauges();
        }

        // takes every call waiting on one connection, or on all, out of the pending calls, for them to
        // be rejected with a DisconnectException after
        internal Detached TakeAll(string? connectionHandle)
        {
            return new Detached(_pendingCalls.TakeAll(connectionHandle));
        }

        // the calls taken, which rejects them
        internal sealed class Detached(IReadOnlyList<PendingRequest> entries)
        {
            internal void Reject(string reason)
            {
                foreach (var pendingRequest in entries)
                {
                    pendingRequest.Reject(new DisconnectException(reason));
                }
            }
        }

        private static bool IsTimeout(TimeSpan delay)
        {
            return delay > TimeSpan.Zero && delay != Timeout.InfiniteTimeSpan;
        }

        // tells the peer a call this side opened is cancelled, once, and reserves its call id in the same
        // step, so nothing drawn meanwhile takes it; a cancel that cannot go out is reported
        private void SendCancel(CallAddress call, TimeSpan? timeout)
        {
            // a disposed router sends nothing; a call id reserved already had its cancel
            if (_port.IsDisposed || _pendingCalls.IsReserved(call.CallId, call.ConnectionHandle))
            {
                return;
            }

            _pendingCalls.Reserve(call, timeout);
            _writer.SendReporting(new Envelope { Header = new CancelHeader { CallId = call.CallId } }, call.ConnectionHandle);
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

            return reservation > _limits.TransferInactivityTimeout ? reservation : _limits.TransferInactivityTimeout;
        }

        // ends a call this side waits on before its answer came whole: forgotten first, so what it holds
        // goes with it, then the peer told to cancel it, then the caller told; a call ended already ends
        // no more
        private void EndPending(Exception reason, (CallAddress Call, PendingRequest PendingRequest) waiting)
        {
            var (call, pendingRequest) = waiting;

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
        private void Wait(TimeSpan delay, (CallAddress Call, PendingRequest PendingRequest) waiting)
        {
            var (call, pendingRequest) = waiting;

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
                        _port.Post(() =>
                        {
                            if (pendingRequest.TimerGeneration != generation)
                            {
                                return;
                            }

                            EndPending(
                                new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"no answer came in {delay.TotalMilliseconds} milliseconds")),
                                (call, pendingRequest));
                        });
                    },
                    null,
                    delay,
                    Timeout.InfiniteTimeSpan)
                : null;
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

            // * a refusal its router judged before the call came, then its credential's, come before the
            // connection's state, as on the TypeScript side, whose router judges both before its core
            if (request.Refusal is { } judged)
            {
                throw new FailureException(judged, new FailureException.Raised(FailureOrigin.Local, _side))
                {
                    DestinationId = options.DestinationId,
                    ProcedureAddress = procedure.Address,
                };
            }

            var (credential, carried) = PresentedOf(request);

            // a call to a connection not open fails as one whose connection closes: one race with a close
            if (!_port.IsOpen(request.ConnectionHandle))
            {
                throw new DisconnectException($"{request.ConnectionHandle} is not an open connection");
            }

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
            var (outgoing, refusal) = _placement.TransferOf(payload, (header, maximumPayloadBytes));

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

        // lays out the header `request` goes out with, its call id aside: a JWT, whose token its caller
        // gives, may be longer than any header holds; OPAQUE, 16 bytes, and ELSEWHERE, none, always fit,
        // OPAQUE's token known only once the call starts.
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

        internal async Task<RouterResult> RequestOnLoop(ReadOnlyMemory<byte> payload, CoreRequest request)
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

            // ! a credential no call presents is a programmer's error, before a token cancelled already,
            // as the TypeScript side reads a call's credential before its signal (spec/debugging.md 9.3)
            CallSession.AssertPresentable(options.Credential);

            // drawn once the call starts: a cancelled token draws nothing
            token.ThrowIfCancellationRequested();

            // ! a credential no header of its request holds, whatever its payload, is a programmer's
            // error, thrown before the call starts and not counted (spec 4.4)
            AssertHeaderHolds(request);

            // * nothing made it a programmer's error: the call starts (spec/debugging.md 9.3), and each
            // refusal after ends it in this turn
            var counted = _metrics is { } metrics ? StartedOf(request.Series?.Calls ?? metrics.Made, _clock) : (StartedCall?)null;
            var maximumPayloadBytes = _placement.PayloadLimitOf(procedure.MaximumPayloadBytes);
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
            Wait(timeout, (call, pendingRequest));

            // its token ends it: rejected here, on the core's scheduler
            using var registration = token.Register(() =>
            {
                _port.Post(() =>
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
                await _writer.Carrying(envelope, (call.ConnectionHandle, pendingRequest.Carried, HandedOff, null));

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

                // ! a dispose that closed the transport under it rejects it as disposed, as its rejection
                // posted after would: which comes first is a race, and the TypeScript side has none
                pendingRequest.Reject(_port.IsDisposed ? new DisconnectException($"{Disposed} before the answer") : reason);
            }
        }

        // a request as a transfer: its opening, then each chunk credited; the call waits on the
        // transfer's inactivity, then on its own timeout once the last chunk is handed off
        private void SendRequestTransfer(OutgoingTransfer outgoing, (RequestHeader Header, CallAddress Call, PendingRequest PendingRequest) waiting)
        {
            var (header, call, pendingRequest) = waiting;

            void Progress()
            {
                Wait(_limits.TransferInactivityTimeout, (call, pendingRequest));
            }

            // the last one handed off, the call waits on its timeout — unless a result opened as it went,
            // which waits on its own inactivity
            void Sent()
            {
                if (pendingRequest.Receiving is null)
                {
                    Wait(pendingRequest.Timeout, (call, pendingRequest));
                }
            }

            async Task SendChunk(Chunk chunk)
            {
                try
                {
                    await _writer.Deliver(PayloadPlacement.ChunkEnvelopeOf(call.CallId, chunk), (call.ConnectionHandle, chunk.IsLast ? Sent : Progress));
                }
                catch (Exception reason)
                {
                    // one that cannot go out ends the call: the peer, which holds a part of it, cancels it
                    EndPending(reason, (call, pendingRequest));

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

        internal void CancelOnLoop(CallAddress call, TimeSpan? timeout)
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

        // an answer of this layout that does not read: it ends the call it answers, if one waits
        internal void GateMalformedAnswer(FailureException failure, (CallAddress Call, bool IsReported) received)
        {
            var (call, isReported) = received;
            var connectionHandle = call.ConnectionHandle;
            var callId = call.CallId;
            var pendingRequest = _pendingCalls.Get(call);

            if (pendingRequest is null)
            {
                // an answer of this layout on a call id reserved is late, and dropped in silence
                if (_pendingCalls.IsReserved(callId, connectionHandle))
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
                (call, pendingRequest));
        }

        // a chunk of this layout that does not read: it ends the result's transfer it was for
        internal void GateMalformedResultChunk(FailureException failure, (CallAddress Call, bool IsReported) gated)
        {
            var (call, isReported) = gated;
            var invalid = ProtocolFailureOf(ProtocolCode.ChunkInvalid, failure.Failure.Detail);
            var pendingRequest = _pendingCalls.Get(call);

            if (pendingRequest?.Receiving is not null)
            {
                EndPending(
                    new FailureException(invalid, new FailureException.Raised(FailureOrigin.Local, _side))
                    {
                        DestinationId = pendingRequest.DestinationId,
                        ProcedureAddress = pendingRequest.ProcedureAddress,
                    },
                    (call, pendingRequest));

                return;
            }

            if (_pendingCalls.IsReserved(call.CallId, call.ConnectionHandle))
            {
                return;
            }

            if (!isReported)
            {
                _port.Report(failure, call.ConnectionHandle);
            }
        }

        internal void ReceiveAnswer(Envelope envelope, (string ConnectionHandle, bool MayOvertake) received)
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

                _port.ReportFailure(ProtocolFailureOf(ProtocolCode.CallUnknown), (connectionHandle, header));

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
                _port.ReportFailure(
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
                ? (null, PayloadPlacement.TooLargeOf(total, pendingRequest.MaximumPayloadBytes))
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
                    (call, pendingRequest));

                return;
            }

            Wait(_limits.TransferInactivityTimeout, (call, pendingRequest));

            // kept before its first credit goes, so a chunk that credit brings at once finds it
            pendingRequest.Receiving = new ResultReceiving(result, receiving);
            _receivings.Grant(receiving);
        }

        // a chunk of a call's result: the call is this side's
        internal void ReceiveResultChunk(Envelope envelope, (CallAddress Call, Chunk Chunk) received)
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

                _port.ReceiveUnplaced(envelope, (call.ConnectionHandle, null, pendingRequest is not null));

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
                        (call, pendingRequest));
                    break;

                // bytes placed are progress
                case ChunkOutcome.Placed:
                    Wait(_limits.TransferInactivityTimeout, (call, pendingRequest));
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
    }
}
