namespace Bead;

/// <summary>A reconnection that ran out of attempts; the last attempt's exception is its inner one.</summary>
public sealed class ReconnectException : Exception
{
    /// <summary>A reconnection given up, saying why, and what its last attempt threw.</summary>
    public ReconnectException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
