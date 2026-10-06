namespace Bead;

/// <summary>
/// The contract between generated code and this runtime, a counter from 1: a generated file names
/// the highest it needs, as a constant of its own, so a runtime too old for it fails its build. The
/// counter moves only when generated code needs something the runtime did not have; an older
/// constant is kept within a major. It names no release.
/// </summary>
public static class GeneratedCode
{
    /// <summary>The runtime carries the service layer, its descriptors, its catalogue and its codecs.</summary>
    public const bool SupportsVersion1 = true;
}
