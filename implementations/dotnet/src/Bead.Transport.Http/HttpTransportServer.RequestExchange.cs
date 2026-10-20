using System.IO.Pipelines;
using Microsoft.AspNetCore.Http;

namespace Bead.Transport.Http;

public sealed partial class HttpTransportServer
{
    // an exchange of one envelope: its body read under its limits, its prefix checked, then handed on
    // and its answer written; what the server holds, its connection among it, is the port's, under the
    // server's lock
    private sealed class HttpRequestExchange<TConnection>
    {
        private const int ReadBytes = 65_536;

        private readonly Port _port;
        private readonly int _maximumBodyBytes;

        // the exchanges of one server, through its port, each body read to `maximumBodyBytes` at most
        internal HttpRequestExchange(Port port, int maximumBodyBytes)
        {
            _port = port;
            _maximumBodyBytes = maximumBodyBytes;
        }

        // what the first 8 bytes say: a request waits under its call id from now on; or how the
        // exchange is refused
        internal delegate End? ClassifyCallback(ReadOnlySpan<byte> head, (TConnection Connection, Waiting Waiting) call);

        // what an exchange needs of its server, for the connection it is on: its bounds, its
        // exchange's state, how a prefix is judged, and where the request and its answer go
        internal sealed record Port
        {
            internal required Func<TConnection, PipeReader, Waiting?> BeginExchange { get; init; }

            internal required Action<TConnection> EndExchange { get; init; }

            internal required Func<int, bool> ChargeBody { get; init; }

            internal required Action<long> ReleaseBody { get; init; }

            internal required ClassifyCallback Classify { get; init; }

            internal required Func<(TConnection Connection, Waiting Waiting), (bool IsGone, bool IsEnded)> FinishBody { get; init; }

            internal required Func<Waiting, bool> BeginHandOff { get; init; }

            internal required Func<(TConnection Connection, Waiting Waiting, uint CallId), bool> WaitAfterHandOff { get; init; }

            internal required Func<HttpContext, End, Task> Finish { get; init; }

            internal required Action<(TConnection Connection, Waiting Waiting)> EndEarly { get; init; }

            internal required Action<(TConnection Connection, Waiting Waiting)> Lose { get; init; }

            internal required Action<(TConnection Connection, uint CallId)> Cancel { get; init; }

            internal required Action<TransportMessage, TConnection> Message { get; init; }

            internal required Func<Func<CancellationToken, Task>?> Answering { get; init; }
        }

        // one envelope: read into one buffer, its prefix checked from its first 8 bytes, then handed on;
        // a request waits for its answer
        internal async Task Receive(HttpContext context, TConnection connection)
        {
            // ! a field that is no list is not combined (RFC 9110 §5.3): two are refused before either
            // could be taken for the other
            if (context.Request.Headers.Authorization.Count > 1)
            {
                await _port.Finish(context, Malformed);

                return;
            }

            if (context.Request.ContentLength > _maximumBodyBytes)
            {
                await _port.Finish(context, new End(StatusCodes.Status413PayloadTooLarge, HttpRefusals.TooLarge));

                return;
            }

            var waiting = _port.BeginExchange(connection, context.Request.BodyReader);

            if (waiting is null)
            {
                await _port.Finish(context, new End(StatusCodes.Status429TooManyRequests, HttpRefusals.Busy));

                return;
            }

            // closed before the transport ended it: lost, as a dropped socket's frames are
            using var lost = context.RequestAborted.Register(() =>
            {
                _port.Lose((connection, waiting));
            });

            try
            {
                var (envelope, end) = await BodyOf(context, (connection, waiting));

                // handed on; or ended as it came — answered, by an answer no request handed on was owed,
                // or its connection closed — and so never handed on
                if (end is null)
                {
                    // its body still coming, which is not read on: its socket closes behind its end
                    if (waiting.Reading is not null)
                    {
                        HttpServerFields.CloseBehind(context);
                    }

                    end = envelope is { } bytes ? await Hand(context, (connection, waiting, bytes)) : await Reply(context, waiting);
                }

                if (end is not null)
                {
                    _port.EndEarly((connection, waiting));

                    // told its connection is gone, and nothing more: what it read whole keeps its socket
                    await (end == Unknown ? HttpServerFields.EndWith(context, end) : _port.Finish(context, end));
                }
            }
            catch (Microsoft.AspNetCore.Http.BadHttpRequestException reason)
            {
                // ! Kestrel failed its body's read, a framing it cannot read: answered the failure's
                // status as HTTP answers it, never the 200 Kestrel writes of an exchange left
                // unanswered, which would say the server had the envelope (spec 15.7); lost, its
                // connection with it
                _port.Lose((connection, waiting));
                await RefuseAsHttp(context, reason.StatusCode);
            }
            catch (Exception reason) when (reason is IOException or OperationCanceledException)
            {
                // the client went: lost, as its abort says — which may have resumed this exchange, and
                // ended its registration, before that one ran
                _port.Lose((connection, waiting));
            }
            finally
            {
                waiting.Written.TrySetException(new IOException("the exchange closed before its answer went out"));

                _port.EndExchange(connection);
            }
        }

        // HTTP's own refusal of a request it could not read, written while its client may still read it
        private static async Task RefuseAsHttp(HttpContext context, int status)
        {
            try
            {
                await HttpServerFields.RefuseAsHttp(context, status);
            }
            catch (Exception reason) when (reason is IOException or OperationCanceledException)
            {
                // the client went first: nothing to write it to
            }
        }

        // the body, read whole and counted against the limit and the budget as it comes; or how its
        // exchange ends early, no more of it read
        private async Task<(byte[]? Envelope, End? End)> BodyOf(HttpContext context, (TConnection Connection, Waiting Waiting) call)
        {
            var (connection, waiting) = call;
            var declared = context.Request.ContentLength;
            var body = new byte[(int)Math.Min(declared ?? ReadBytes, ReadBytes)];
            var read = new byte[ReadBytes];
            var length = 0;
            long charged = 0;
            var isClassified = false;

            try
            {
                while (true)
                {
                    int count;

                    try
                    {
                        count = await context.Request.Body.ReadAsync(read, context.RequestAborted);
                    }
                    catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
                    {
                        // its read ended as it waited under its call id, its body still coming: its
                        // connection closed, or its answer came; its client learns it at once
                        return (null, null);
                    }

                    if (count == 0)
                    {
                        break;
                    }

                    var isOverBudget = _port.ChargeBody(count);
                    charged += count;

                    // past the limit, it is refused, and then no more of it is read
                    if (charged > _maximumBodyBytes)
                    {
                        return (null, new End(StatusCodes.Status413PayloadTooLarge, HttpRefusals.TooLarge));
                    }

                    if (isOverBudget)
                    {
                        return (null, Busy);
                    }

                    // a cancel came for it while it came: read to its end, and dropped
                    if (waiting.IsCancelled)
                    {
                        continue;
                    }

                    if (length + count > body.Length)
                    {
                        Array.Resize(ref body, Math.Min(Math.Max(length + count, 2 * body.Length), _maximumBodyBytes));
                    }

                    read.AsSpan(0, count).CopyTo(body.AsSpan(length));
                    length += count;

                    if (!isClassified && length >= HttpTransport.PrefixBytes)
                    {
                        isClassified = true;

                        if (_port.Classify(body.AsSpan(0, HttpTransport.PrefixBytes), (connection, waiting)) is { } refused)
                        {
                            return (null, refused);
                        }
                    }
                }
            }
            finally
            {
                _port.ReleaseBody(charged);
            }

            var (isGone, isEnded) = _port.FinishBody((connection, waiting));

            if (isGone)
            {
                return (null, Unknown);
            }

            if (isEnded)
            {
                return (null, null);
            }

            if (waiting.Prefix is null)
            {
                return (null, Malformed);
            }

            // its cancel came first, or while it came: dropped, and ended empty
            return waiting.IsCancelled ? (null, Nothing) : (body.AsSpan(0, length).ToArray(), null);
        }

        // an envelope whole, handed on: a request waits for its answer, its head going now so its client
        // knows the router has it; a cancel ends the exchange of its call, or buries its call id; any
        // other ends empty
        private async Task<End?> Hand(HttpContext context, (TConnection Connection, Waiting Waiting, byte[] Envelope) call)
        {
            var (connection, waiting, envelope) = call;
            var (callId, kind) = waiting.Prefix!.Value;

            if (kind != EnvelopeKind.Request)
            {
                _port.Message(new TransportMessage(envelope, false), connection);

                if (kind == EnvelopeKind.Cancel)
                {
                    _port.Cancel((connection, callId));
                }

                return Nothing;
            }

            var isAnswered = _port.BeginHandOff(waiting);

            if (isAnswered)
            {
                return await Reply(context, waiting);
            }

            // a request is handed on with the credential its exchange carried; no other envelope is
            _port.Message(new TransportMessage(envelope, false) { Credential = HostsAndOrigins.CredentialOf(context.Request.Headers.Authorization) }, connection);

            var isWaiting = _port.WaitAfterHandOff((connection, waiting, callId));

            if (isWaiting)
            {
                await HttpServerFields.SendHead(context);
            }

            return await Reply(context, waiting);
        }

        // a request's answer, once it comes: written, or how its exchange ends instead — its connection
        // gone once its request was handed on, its head goes before its exchange is cut: a request
        // handed on ran, which no refusal may deny
        private async Task<End?> Reply(HttpContext context, Waiting waiting)
        {
            var ending = await waiting.Ended.Task.WaitAsync(context.RequestAborted);

            if (ending.IsGone)
            {
                if (ending.IsDelivered)
                {
                    await HttpServerFields.SendHead(context);
                }

                if (context.Response.HasStarted)
                {
                    context.Abort();

                    return null;
                }

                return Unknown;
            }

            if (ending.End is { } end)
            {
                return end;
            }

            if (_port.Answering() is { } answering)
            {
                await answering(context.RequestAborted);
            }

            try
            {
                if (!context.Response.HasStarted)
                {
                    context.Response.StatusCode = StatusCodes.Status200OK;
                    HttpServerFields.StampOf(context.Response);
                    context.Response.ContentType = HttpTransport.MediaType;
                    context.Response.ContentLength = ending.Bytes.Length;
                }

                await context.Response.Body.WriteAsync(ending.Bytes, context.RequestAborted);

                // Kestrel drops a write to a client gone without a word, before its abort is told: a
                // flush that finds nothing reading says the answer never went out whole
                if ((await context.Response.BodyWriter.FlushAsync(context.RequestAborted)).IsCompleted)
                {
                    throw new IOException("the exchange closed before its answer went out");
                }

                await context.Response.CompleteAsync();
                waiting.Written.TrySetResult();
            }
            catch (Exception reason) when (reason is IOException or OperationCanceledException)
            {
                waiting.Written.TrySetException(new IOException("the exchange closed before its answer went out", reason));
            }

            return null;
        }
    }

    // what an exchange waiting on the transport ends with: an answer's envelope or a listen's batch,
    // the number of a batch's first, an end of the transport's own, or its connection gone — after
    // its request was handed on, or before
    private sealed record Ending
    {
        public ReadOnlyMemory<byte> Bytes { get; init; }

        public long? Sequence { get; init; }

        public End? End { get; init; }

        public bool IsGone { get; init; }

        // its request went on to the router before its connection went: its head goes, then its
        // exchange is cut
        public bool IsDelivered { get; init; }
    }

    // an exchange of an envelope, from its first 8 bytes to its end; touched under the lock
    private sealed class Waiting
    {
        // what its first 8 bytes said, once they came
        public (uint CallId, EnvelopeKind Kind)? Prefix { get; set; }

        // a cancel came for it while its body was still coming: it is read to its end, then 204
        public bool IsCancelled { get; set; }

        // its request went on to the router, which owes it an answer
        public bool IsDelivered { get; set; }

        // the transport ended it — an answer, a 204, a refusal, its connection closed — so its close is no loss
        public bool IsEnded { get; set; }

        // ends its connection, as lost, once its request waited past the exchange timeout
        public ITimer? Timer { get; set; }

        // what reads its body, while it still comes: its connection's close ends the read
        public PipeReader? Reading { get; set; }

        public TaskCompletionSource<Ending> Ended { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        // its answer, once written: what its send settles on
        public TaskCompletionSource Written { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
