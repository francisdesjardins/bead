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
    /// options typed by the service, a client side's Bead client apart from them, and the check of a
    /// <c>proto</c> payload's records, <c>Bead.Protobuf</c>'s <c>ProtoRecords</c>, that a generated
    /// codec calls before its library reads them (decision 0028).
    /// </summary>
    public const bool SupportsVersion3 = true;
}
