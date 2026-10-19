namespace Bead;

internal sealed partial class RouterCore
{
    // what goes to the transport, and the session each connection was last told of
    private sealed class RouterWriter
    {
        // what a failure's envelope holds besides its detail: its prefix, the announcement it may
        // carry, and its record
        private const int FailureOverheadBytes = 8 + Credential.AnnouncementBytes + 4;

        private readonly IRouterCorePort _port;
        private readonly Options _options;
        private readonly RouterSide _side;
        private readonly int _detailBytes;

        // what each connection was last told of its session: a token, none once told it ended; a
        // connection never told has no entry
        private readonly Dictionary<string, SessionToken?> _announced = [];

        internal RouterWriter(IRouterCorePort port, Options options)
        {
            _port = port;
            _options = options;
            _side = port.Side;

            // a failure's detail fits in an envelope, whatever the limit of a detail says
            _detailBytes = Math.Min(options.Limits.MaximumDetailBytes, options.Limits.MaximumEnvelopeBytes - FailureOverheadBytes);
        }

        internal sealed record Options
        {
            internal required RouterLimits Limits { get; init; }

            internal required Func<bool> IsDisposed { get; init; }
        }

        // sends an envelope
        internal Task Deliver(Envelope envelope, string connectionHandle)
        {
            return Deliver(envelope, (connectionHandle, null));
        }

        // sends an envelope; `OnHandOff` runs once the transport has it, before it settles
        internal Task Deliver(Envelope envelope, (string ConnectionHandle, Action? OnHandOff) going)
        {
            return Carrying(envelope, (going.ConnectionHandle, null, going.OnHandOff, null));
        }

        // sends an envelope with what its transport carries beside it — a request's presenting
        // ELSEWHERE — and none for any other; `OnHandOff` runs once the transport has it, before it
        // settles. A notification counts into its procedure's series as it is handed off, or as it
        // cannot be (spec/debugging.md 10.1); one its transport refuses after keeps its count
        internal async Task Carrying(Envelope envelope, (string ConnectionHandle, string? Carried, Action? OnHandOff, NotifyingSeries? Notifying) going)
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
            if (_options.IsDisposed())
            {
                throw new DisconnectException(Disposed);
            }

            // a failure, a credit and a cancel carry no payload of their own
            if (envelope.Kind is not (EnvelopeKind.Cancel or EnvelopeKind.Credit or EnvelopeKind.Failure)
                && envelope.Payload.Length > _options.Limits.MaximumPayloadBytes)
            {
                throw LocalOf(PayloadPlacement.TooLargeOf(envelope.Payload.Length, _options.Limits.MaximumPayloadBytes), (_side, envelope.Header));
            }

            var (announced, restore) = Announce(envelope, connectionHandle);

            try
            {
                var bytes = EnvelopeCodec.WriteEnvelope(announced, _detailBytes);

                // one past its limit, the peer would refuse
                if (bytes.Length > _options.Limits.MaximumEnvelopeBytes)
                {
                    throw LocalOf(
                        ProtocolFailureOf(
                            ProtocolCode.PayloadTooLarge,
                            $"an envelope is {_options.Limits.MaximumEnvelopeBytes} bytes at most, not {bytes.Length}"),
                        (_side, envelope.Header));
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
        internal void SendReporting(Envelope envelope, string connectionHandle)
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

        // forgets what one connection was told of its session, or what every one was
        internal void Forget(string? connectionHandle)
        {
            if (connectionHandle is null)
            {
                _announced.Clear();
            }
            else
            {
                _announced.Remove(connectionHandle);
            }
        }

        // the announcements' gauges
        internal Gauges Gauges()
        {
            return Bead.Gauges.Of(new Dictionary<string, long> { ["announced"] = _announced.Count }, _announced.Keys);
        }
    }
}
