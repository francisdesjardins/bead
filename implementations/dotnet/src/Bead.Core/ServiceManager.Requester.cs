namespace Bead;

public sealed partial class ServiceManager
{
    // calls this manager makes, their held defaults, and their decoded results
    private sealed class ServiceRequester
    {
        private readonly IRouterLike _router;
        private readonly RequestDefaults _defaults;
        private readonly Action<string>? _closeConnection;
        private readonly ServiceTrace _trace;
        private readonly Action<Procedure> _deprecated;

        internal ServiceRequester(IRouterLike router, Options options)
        {
            _router = router;
            _defaults = options.Defaults;
            _closeConnection = options.CloseConnection;
            _trace = options.Trace;
            _deprecated = options.Deprecated;
        }

        internal sealed record Options
        {
            internal required RequestDefaults Defaults { get; init; }

            internal Action<string>? CloseConnection { get; init; }

            internal required ServiceTrace Trace { get; init; }

            internal required Action<Procedure> Deprecated { get; init; }
        }

        // a requester: given a payload, then options, one call
        internal Func<TRequest, BoundCall<TResponse>> RequesterOf<TRequest, TResponse>(
            Procedure procedure,
            (RequestDependencies<TRequest, TResponse> Dependencies, DebugType Type) made)
        {
            ArgumentNullException.ThrowIfNull(procedure);
            ArgumentNullException.ThrowIfNull(made.Dependencies);

            // declared as it is made (spec/debugging.md 7.2): each of its calls carries its series
            var series = _router.DeclareRequester(procedure);

            async Task<TResponse> Called(TRequest payload, RequestOptions? options)
            {
                return (await CallOf(payload, (procedure, made.Dependencies.Serializer, options, (made.Type, null, series)))).Response;
            }

            return (payload) =>
            {
                return (options) =>
                {
                    return Called(payload, options);
                };
            };
        }

        // a call's options, with the defaults applied: the call's, then the manager's, which is 5 s when
        // none, and no close; the timeout held as a call's, so the trace, the router and the error tell
        // one number
        private ResolvedRequestOptions OptionsOf(RequestOptions? given)
        {
            return new ResolvedRequestOptions
            {
                CancellationToken = given?.CancellationToken ?? CancellationToken.None,
                CloseOnTimeout = given?.CloseOnTimeout ?? _defaults.CloseOnTimeout,
                ConnectionHandle = given?.ConnectionHandle,
                Credential = given?.Credential,
                DestinationId = given?.DestinationId,
                Timeout = Clocks.AssertHeld(("a call's timeout", nameof(RequestOptions.Timeout)), given?.Timeout ?? _defaults.Timeout!.Value),
            };
        }

        // a result decoded; one that does not decode fails here, with the result's header
        private TResponse DecodeOf<TRequest, TResponse>(
            RouterResult result,
            (Procedure Procedure, IRequestSerializerClient<TRequest, TResponse> Serializer, ResolvedRequestOptions Options) call)
        {
            try
            {
                return call.Serializer.Decode(result.Payload);
            }
            catch (Exception reason)
            {
                throw new FailureException(
                    Failure.OfProtocol(ProtocolCode.PayloadUndecodable, reason.Message),
                    (new FailureException.Raised(FailureOrigin.Local, _router.Side), reason))
                {
                    DestinationId = call.Options.DestinationId,
                    Header = result.Header,
                    ProcedureAddress = call.Procedure.Address,
                };
            }
        }

        // whether a serializer's throw is a value its rules refused: a PAYLOAD_INVALID raised here,
        // which its call fails with once it starts, counted, rather than a value that does not write
        private static bool IsJudged(FailureException refused)
        {
            return refused.Origin == FailureOrigin.Local
                && refused.Scope == FailureScope.Protocol
                && refused.Code == (ushort)ProtocolCode.PayloadInvalid;
        }

        // a request's payload written, or the refusal its rules judged it with in its place; a
        // value that does not write throws
        private static (ReadOnlyMemory<byte> Encoded, Failure? Refusal) WrittenOf<TRequest, TResponse>(
            IRequestSerializerClient<TRequest, TResponse> serializer,
            TRequest payload)
        {
            try
            {
                return (serializer.Encode(payload), null);
            }
            catch (FailureException refused) when (IsJudged(refused))
            {
                return (default, refused.Failure);
            }
        }

        // one call — a request, a command, or the request that subscribes a notification: its options
        // with the defaults applied, its trace, the request, the close on timeout, and its result
        // decoded; a timeout refused fails as the options are resolved, and a value that does not write
        // as it is written, both before the trace and the deprecation: no call is made (spec 17.2,
        // item 4; spec/debugging.md 4.3). A value its rules refuse is a call refused before it goes:
        // handed to the router with its refusal, which fails it in its turn, counted, its tx step told
        // as it is refused, no call id drawn (spec 18.2; spec/debugging.md 4.4, 9.6)
        internal async Task<(uint CallId, TResponse Response)> CallOf<TRequest, TResponse>(
            TRequest payload,
            (Procedure Procedure, IRequestSerializerClient<TRequest, TResponse> Serializer, RequestOptions? Options, (DebugType Type, INotificationLike? Subscribes, ProcedureSeries? Series) Made) call)
        {
            var (procedure, serializer, given, (type, subscribes, series)) = call;
            var options = OptionsOf(given);
            var (encoded, refusal) = WrittenOf(serializer, payload);

            // * one check a call while nobody listens: no clock read, no step, no copy of its options,
            // nothing to hear its call id; a credential stays out of what a side tells, and the trace
            // carries none
            var traced = _trace.IsDebugging
                ? new TracedCall(_trace, (procedure, new DebugStep(DebugDirection.Tx, type)
                {
                    ConnectionHandle = options.ConnectionHandle,
                    Options = options with { Credential = null },
                    Started = _trace.StartedNow(),
                    Tx = payload,
                }))
                : null;

            if (procedure.Deprecation is not null)
            {
                _deprecated(procedure);
            }

            var requested = _router.Request(
                encoded,
                new RouterRequest(procedure, options)
                {
                    OnCallId = traced is null ? null : traced.OnCallId,
                    Refusal = refusal,
                    Series = series,
                    Subscribes = subscribes,
                });
            RouterResult result;

            try
            {
                // one awaiter either way: the request itself, or the request once its tx step was told
                result = await (traced is null ? requested : traced.Told(requested));
            }
            catch (Exception reason)
            {
                // a connection that let it go unanswered is closed, when the call or the manager says so
                if (reason is TimeoutException && options.CloseOnTimeout == true && options.ConnectionHandle is { } connectionHandle)
                {
                    _closeConnection?.Invoke(connectionHandle);
                }

                traced?.Failed(reason);

                throw;
            }

            TResponse response;

            try
            {
                response = DecodeOf(result, (procedure, serializer, options));
            }
            catch (FailureException reason)
            {
                traced?.Failed(reason);

                throw;
            }

            traced?.Answered(response);

            return (result.Header.CallId, response);
        }
    }
}
