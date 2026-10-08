namespace Bead;

/// <summary>
/// The contract between generated code and this runtime, a counter from 1: a generated file names
/// the highest it needs, as a constant of its own, so a runtime too old for it fails its build. The
/// counter moves only when generated code needs something the runtime did not have; an older
/// constant stays while the runtime still serves the code that names it, and from 1.0.0 for the
/// whole major. It names no release.
/// </summary>
public static class GeneratedCode
{
    /// <summary>
    /// The runtime carries the service layer, its descriptors, its catalogue and its codecs, its
    /// options typed by the service, and a client side's Bead client apart from them.
    /// </summary>
    public const bool SupportsVersion2 = true;
}
