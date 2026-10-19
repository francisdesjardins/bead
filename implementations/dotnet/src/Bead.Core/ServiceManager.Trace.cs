namespace Bead;

public sealed partial class ServiceManager
{
    // a live view of the manager's listeners, and the steps a call tells them
    private sealed class ServiceTrace(Func<Action<Exception?, DebugEvent>?> listeners, ServiceTrace.Options options)
    {
        internal sealed record Options
        {
            internal required TimeProvider Clock { get; init; }

            internal required Func<RouterSide> Side { get; init; }

            internal required Action<Exception, string?> Report { get; init; }
        }

        internal bool IsDebugging
        {
            get
            {
                return listeners() is not null;
            }
        }

        // now, for a call starting: the instant it is told at, on the wall clock, and the reading its
        // duration counts from, on the monotonic one
        internal Started StartedNow()
        {
            return new Started(options.Clock.GetUtcNow(), options.Clock.GetTimestamp());
        }

        // now, for a notification sent or heard: one step, which takes no duration, read on the wall
        // clock alone
        internal Started NotifiedNow()
        {
            return new Started(options.Clock.GetUtcNow(), 0);
        }

        // tells Debug of one step of a call, each listener within a guard: what one throws is reported
        // through the router, and changes nothing of the call; nothing is built when nobody hears it
        internal void Trace(Procedure procedure, DebugStep step)
        {
            if (listeners() is not { } debug)
            {
                return;
            }

            var debugEvent = new DebugEvent
            {
                CallId = step.CallId,
                ConnectionHandle = ConnectionOf(step),
                Direction = step.Direction,
                Duration = step.IsAnswered ? WholeMillisecondsOf(options.Clock.GetElapsedTime(step.Started.Timestamp)) : null,
                Options = step.Options,
                ProcedureId = procedure.ProcedureId,
                ProcedureName = procedure.ProcedureName,
                Rx = step.Rx,
                ServiceId = procedure.ServiceId,
                ServiceRevision = procedure.ServiceRevision,
                StartedAt = step.Started.Instant,
                Tx = step.Tx,
                Type = step.Type,
            };

            foreach (var listener in debug.GetInvocationList())
            {
                try
                {
                    ((Action<Exception?, DebugEvent>)listener)(step.Error, debugEvent);
                }
                catch (Exception reason)
                {
                    options.Report(reason, step.ConnectionHandle);
                }
            }
        }

        // the connection a step's call is on, as its envelopes name it: a client's one peer, the server,
        // whatever its options said; none for a step that names no call
        private string? ConnectionOf(DebugStep step)
        {
            if (step.CallId is null)
            {
                return null;
            }

            return options.Side() == RouterSide.Client ? RouterClient.ServerConnectionHandle : step.ConnectionHandle;
        }

        // a time in whole milliseconds, a fraction dropped
        private static TimeSpan WholeMillisecondsOf(TimeSpan time)
        {
            return TimeSpan.FromTicks(time.Ticks - (time.Ticks % TimeSpan.TicksPerMillisecond));
        }
    }

    // the failure a failed call carries, for a trace: its code, its scope and its detail; none when
    // it carries none
    private static Failure? TracedFailureOf(Exception reason)
    {
        return reason is FailureException { Failure: var failure }
            ? new Failure { Code = failure.Code, Detail = failure.Detail, Scope = failure.Scope }
            : null;
    }

    // one step of a call, as Trace tells it, and the connection a listener's error is reported with
    private sealed record DebugStep(DebugDirection Direction, DebugType Type)
    {
        // the call id its envelopes carry, once drawn; none for a step that names no call
        public uint? CallId { get; init; }

        public string? ConnectionHandle { get; init; }

        public Exception? Error { get; init; }

        public bool IsAnswered { get; init; }

        public ResolvedRequestOptions? Options { get; init; }

        public object? Rx { get; init; }

        // when its call started: every step of one call carries the same
        public required Started Started { get; init; }

        public object? Tx { get; init; }
    }

    // a call made while someone listens, and made only then: it hears its call id as its router
    // draws it, and tells its tx step from the manager's own flow once it holds the id, or once the
    // request failed before one was drawn; its rx step names the same id
    private sealed class TracedCall(ServiceTrace trace, (Procedure Procedure, DebugStep Step) call)
    {
        // ! continuations run asynchronously: what awaits the id, and the tx step's listeners with
        // it, never runs inside OnCallId, on its router's scheduler, where one that blocks holds
        // every connection of that router. Bead's routers draw it in a task of their scheduler,
        // where the runtime inlines no await; over a router that draws it under no scheduler of its
        // own, this alone keeps them off
        private readonly TaskCompletionSource<uint> _drawn = new(TaskCreationOptions.RunContinuationsAsynchronously);

        // the call id its steps name, once its tx step was told; none for a call refused before
        // its router drew one
        private uint? _callId;

        // hears the call id on the router's scheduler: it records it, and tells nothing there
        public void OnCallId(uint callId)
        {
            _drawn.TrySetResult(callId);
        }

        // * the tx step, told once the first of the id and the request's end came, with the id or
        // with none; then the request's outcome, which its rx step follows
        public async Task<RouterResult> Told(Task<RouterResult> requested)
        {
            await Task.WhenAny(_drawn.Task, requested);

            // drawn before the request goes, so before it ends: whichever came first, it is held
            _callId = _drawn.Task.IsCompletedSuccessfully ? await _drawn.Task : null;
            trace.Trace(call.Procedure, call.Step with { CallId = _callId });

            return await requested;
        }

        // its answer, decoded
        public void Answered(object? response)
        {
            trace.Trace(call.Procedure, call.Step with { CallId = _callId, Direction = DebugDirection.Rx, IsAnswered = true, Rx = response });
        }

        // what the call failed with once it started, told as its answer
        public void Failed(Exception reason)
        {
            trace.Trace(
                call.Procedure,
                call.Step with { CallId = _callId, Direction = DebugDirection.Rx, Error = reason, IsAnswered = true, Rx = TracedFailureOf(reason) });
        }
    }

    // when a call started: its instant on the wall clock, and the monotonic reading its duration counts from
    private readonly record struct Started(DateTimeOffset Instant, long Timestamp);
}
