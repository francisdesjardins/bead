namespace Bead;

/// <summary>
/// A connect that failed before anything went: in memory, to a server that is not open, or one a
/// dispose gave up on as it connected (spec 15.13), as the TypeScript side's <c>ConnectError</c>.
/// </summary>
public sealed class ConnectException : Exception
{
    /// <summary>A connect refused, saying why.</summary>
    public ConnectException(string message)
        : base(message)
    {
    }
}
