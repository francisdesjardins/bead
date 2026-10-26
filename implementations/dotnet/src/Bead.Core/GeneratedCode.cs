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
    /// The runtime carries the service layer, its descriptors, its catalogue and its codecs, its
    /// options typed by the service, a client side's Bead client apart from them, the check of a
    /// <c>proto</c> payload's records, <c>Bead.Protobuf</c>'s <c>ProtoRecords</c>, that a generated
    /// codec calls before its library reads them (decision 0028), and the payload rules a generated
    /// file's validators judge a request by (decision 0035): a descriptor's <c>Validate</c> a
    /// <see cref="RequestValidator{TRequest}"/>, and <c>Bead.Protobuf</c>'s <c>Validators</c>,
    /// <c>IViolationSink</c>, <c>ViolationRule</c>, <c>PatternTable</c> and <c>Pattern</c>.
    /// </summary>
    public const bool SupportsVersion4 = true;

    /// <summary>
    /// The runtime carries all of 4, and what the route table of an output with <c>http: true</c>
    /// names (decision 0037): <c>Bead.Transcoding</c>'s <c>HttpRoute</c>, <c>HttpRouteTemplate</c>
    /// and <c>HttpPayload</c>, which a gateway reads its routes and its messages' JSON by.
    /// </summary>
    public const bool SupportsVersion5 = true;
}
