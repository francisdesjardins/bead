namespace Bead;

/// <summary>
/// The contract between generated code and this runtime, a counter from 1: a generated file names
/// the highest it needs, as a constant of its own, so a runtime too old for it fails its build. The
/// counter moves only when generated code needs something the runtime did not have. Before 1.0.0,
/// an older constant goes once the code that names it no longer conforms through this runtime; from
/// 1.0.0 it stays for the whole major. It names no release.
/// </summary>
public static class GeneratedCode
{
    /// <summary>
    /// The runtime carries what the route table of an output with <c>http: true</c> names (decision
    /// 0037), beside the contract 6: <c>Bead.Transcoding</c>'s <c>HttpRoute</c>,
    /// <c>HttpRouteTemplate</c> and <c>HttpPayload</c>, which a gateway reads its routes and its
    /// messages' JSON by. A route table calls no codec.
    /// </summary>
    public const bool SupportsVersion5 = true;

    /// <summary>
    /// The runtime carries the service layer, its descriptors, its catalogue and its codecs, its
    /// options typed by the service, a client side's Bead client apart from them; the runtime codec
    /// of a <c>proto</c> message, <c>Bead.Protobuf</c>'s <c>ProtoCodecs</c>, which a generated
    /// binding names and which holds spec 17.9 whole: its records checked, <c>ProtoRecords</c>
    /// (decision 0028), its bound, a closed enum's undeclared number set aside (17.9.8), and a
    /// message that leaves a required field unset refused both ways, <c>ProtoRequired</c> (17.9.7,
    /// decision 0042); and the payload rules a generated file's validators judge a request by
    /// (decision 0035): a descriptor's <c>Validate</c> a <see cref="RequestValidator{TRequest}"/>,
    /// and <c>Bead.Protobuf</c>'s <c>Validators</c>, <c>IViolationSink</c>, <c>ViolationRule</c>,
    /// <c>PatternTable</c> and <c>Pattern</c>.
    /// </summary>
    public const bool SupportsVersion6 = true;
}
