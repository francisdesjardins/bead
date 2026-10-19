namespace Bead;

public sealed partial class ServiceManager
{
    // the resolvers this manager registers, and the one answer each incoming request may take
    private sealed class ServiceResolver(IRouterLike router, ServiceTrace trace)
    {
        internal Resolver<TRequest, TResponse> Create<TRequest, TResponse>(ResolverMade<TRequest, TResponse> made)
        {
            return new Resolver<TRequest, TResponse>(trace, (router, made));
        }
    }

    // what a resolver is made of: its procedure, its serializer, its admission, its callback, and
    // what its calls are
    private sealed record ResolverMade<TRequest, TResponse>
    {
        internal required Procedure Procedure { get; init; }

        internal required IRequestSerializerServer<TRequest, TResponse> Serializer { get; init; }

        internal BeforeRequest? BeforeRequest { get; init; }

        internal required Func<RequestProps<TRequest>, INotificationResponse<TResponse>, Task> Callback { get; init; }

        internal required DebugType Type { get; init; }
    }

    // the resolver of one procedure, registered in the router
    private sealed class Resolver<TRequest, TResponse>(ServiceTrace trace, (IRouterLike Router, ResolverMade<TRequest, TResponse> Made) made) : IRequestResolver
    {
        private readonly IRouterLike _router = made.Router;

        public Procedure Procedure
        {
            get
            {
                return made.Made.Procedure;
            }
        }

        public int? MaximumPayloadBytes
        {
            get
            {
                return Procedure.MaximumPayloadBytes;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return made.Made.BeforeRequest?.RefusalOf(request);
        }

        public async Task Handle(RequestResolverProps props)
        {
            ArgumentNullException.ThrowIfNull(props);

            // * the call starts as it arrives, its admission and its decoding counted in its duration,
            // for a listener: one check while nobody listens, and no clock read
            Started? started = trace.IsDebugging ? trace.StartedNow() : null;
            var target = new AnswerTarget(props.ConnectionHandle, props.Header);
            TRequest payload;

            // a router that did not ask its admission leaves it here, before the payload is read
            if (!props.IsAdmitted)
            {
                Failure? refusal;

                try
                {
                    refusal = Admit(new AdmissionRequest(props.ConnectionHandle, props.Header) { Session = props.Session });
                }
                catch
                {
                    await AnswerFailed(target);

                    throw;
                }

                if (refusal is not null)
                {
                    await _router.Respond(RouterAnswer.OfFailure(refusal), target);

                    return;
                }
            }

            // a payload that does not decode never reaches the callback
            try
            {
                payload = made.Made.Serializer.Decode(props.Payload);
            }
            catch (Exception)
            {
                await _router.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.PayloadUndecodable)), target);

                return;
            }

            if (started is { } at)
            {
                trace.Trace(Procedure, new DebugStep(DebugDirection.Rx, made.Made.Type)
                {
                    CallId = props.Header.CallId,
                    ConnectionHandle = props.ConnectionHandle,
                    Rx = payload,
                    Started = at,
                });
            }

            var response = new Response(this, (target, payload, started, props.Signal));
            var request = new RequestProps<TRequest>
            {
                ConnectionHandle = props.ConnectionHandle,
                Header = props.Header,
                Payload = payload,
                Session = props.Session,
                Signal = props.Signal,
            };

            try
            {
                await made.Made.Callback(request, response);
            }
            catch (Exception reason)
            {
                // a resolver that failed before it answered still answers, so its requester does
                // not wait out its timeout, told with why beside it; why it failed goes on, for the
                // router to report; a call no longer answered takes neither
                if (!response.IsAnswered)
                {
                    response.IsAnswered = true;

                    if (started.HasValue && !props.Signal.IsCancellationRequested)
                    {
                        trace.Trace(Procedure, new DebugStep(DebugDirection.Tx, made.Made.Type)
                        {
                            CallId = props.Header.CallId,
                            ConnectionHandle = props.ConnectionHandle,
                            Error = reason,
                            IsAnswered = true,
                            Rx = payload,
                            Started = started.Value,
                        });
                    }

                    await AnswerFailed(target);
                }

                throw;
            }
        }

        private IRequestSerializerServer<TRequest, TResponse> Serializer
        {
            get
            {
                return made.Made.Serializer;
            }
        }

        private DebugType Type
        {
            get
            {
                return made.Made.Type;
            }
        }

        private void Traced(DebugStep step)
        {
            trace.Trace(Procedure, step);
        }

        // answers as failed; what keeps that answer from going out — a connection gone — is not heard
        private async Task AnswerFailed(AnswerTarget target)
        {
            try
            {
                await _router.Respond(RouterAnswer.OfFailure(Failure.OfProtocol(ProtocolCode.ProcedureFailed)), target);
            }
            catch (Exception)
            {
                // nothing more to say: the failure that brought it here goes on
            }
        }

        // the failure a resolver's answer sends: the procedure's own, or a refusal of admission
        private static Failure ResolverFailureOf(Failure failure)
        {
            ArgumentNullException.ThrowIfNull(failure);

            if ((failure.Scope == FailureScope.Application && failure.Code >= 1) || BeforeRequest.IsAdmissionFailure(failure))
            {
                return failure;
            }

            throw new ArgumentException(
                $"a resolver answers a failure of its own, from 1 to 65535, or a refusal of admission, not {failure.Code}",
                nameof(failure));
        }

        private sealed class Response(Resolver<TRequest, TResponse> resolver, (AnswerTarget Target, object? Request, Started? Started, CancellationToken Signal) answering) : INotificationResponse<TResponse>
        {
            public bool IsAnswered { get; set; }

            private AnswerTarget Target
            {
                get
                {
                    return answering.Target;
                }
            }

            public Task Answer(TResponse payload)
            {
                return Send(
                    () =>
                    {
                        return RouterAnswer.OfPayload(resolver.Serializer.Encode(payload));
                    },
                    payload);
            }

            public Task<uint> RegisterNotification()
            {
                // a subscription the answer carries, so made before it goes out
                if (IsAnswered)
                {
                    throw new InvalidOperationException($"{resolver.Procedure.ProcedureName} subscribes before it answers");
                }

                return resolver._router.Subscribe(Target);
            }

            public Task Fail(Failure failure)
            {
                return Send(
                    () =>
                    {
                        return RouterAnswer.OfFailure(ResolverFailureOf(failure));
                    },
                    failure);
            }

            private async Task Send(Func<RouterAnswer> answerOf, object? answered)
            {
                if (IsAnswered)
                {
                    throw new InvalidOperationException($"{resolver.Procedure.ProcedureName} has answered this request already");
                }

                // what fails before the answer goes out leaves the request unanswered, to be answered
                // as failed: a failure a resolver may not answer, or a payload that does not encode
                var answer = answerOf();

                IsAnswered = true;

                // * a request its router answered in its place takes this answer nowhere: its step is
                // told once, with the failure its router answered, and nothing failed here
                // (spec/debugging.md 4.2)
                if (ToldInPlace(answered))
                {
                    return;
                }

                // traced once its request was, to whoever listens
                Told(answered, null);

                try
                {
                    await resolver._router.Respond(answer, Target);
                }
                catch (Exception reason)
                {
                    // an answer the router could not send — too large, say — is told again at its
                    // start with why, and answered as failed, so its requester does not wait out its
                    // timeout
                    Told(answered, reason);

                    await resolver.AnswerFailed(Target);

                    throw;
                }

                ToldLate(answered, answer);
            }

            // whether its router answered its request in its place, its step told with that failure;
            // ! no local of its own in Send, whose state machine a request allocates
            private bool ToldInPlace(object? answered)
            {
                if (resolver._router.AnsweredOf(Target) is not { } inPlace)
                {
                    return false;
                }

                if (answering.Started.HasValue)
                {
                    Told(answered, FailureOf(inPlace));
                }

                return true;
            }

            // ! its router answered in its place on its own thread while this answer went to it, so
            // it went nowhere: told again at its start, with the failure its router answered; never
            // the failure this answer was
            private void ToldLate(object? answered, RouterAnswer answer)
            {
                if (answering.Started.HasValue
                    && resolver._router.AnsweredOf(Target) is { } late
                    && !ReferenceEquals(late, answer.Failure))
                {
                    Told(answered, FailureOf(late));
                }
            }

            // the failure its router answered in its place, raised here, on its call id
            private FailureException FailureOf(Failure failure)
            {
                return new FailureException(failure, new FailureException.Raised(FailureOrigin.Local, resolver._router.Side))
                {
                    Header = new FailureHeader { CallId = Target.Header.CallId },
                };
            }

            // ! tells its answer's step, or why it did not go, to whoever listens; built here, out of
            // the async Send, so that a request holds no step of its own while nobody listens. A call
            // no longer answered takes no failure
            private void Told(object? answered, Exception? reason)
            {
                if (answering.Started is { } started && (reason is null || !answering.Signal.IsCancellationRequested))
                {
                    resolver.Traced(new DebugStep(DebugDirection.Tx, resolver.Type)
                    {
                        CallId = Target.Header.CallId,
                        ConnectionHandle = Target.ConnectionHandle,
                        Error = reason,
                        IsAnswered = true,
                        Rx = answering.Request,
                        Started = started,
                        Tx = answered,
                    });
                }
            }
        }
    }
}
