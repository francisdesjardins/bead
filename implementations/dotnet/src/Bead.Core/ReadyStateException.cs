namespace Bead;

/// <summary>
/// A transport client asked for what its state does not allow: <c>the transport client is
/// uninitialized, not open</c>, as the TypeScript side's <c>ReadyStateError</c>. A send is refused so
/// before its open alone, uninitialized or connecting, a send once its state is a close's being a
/// <see cref="DisconnectException"/> (debugging 9.7); a close unless open is refused so in any state.
/// </summary>
public sealed class ReadyStateException : Exception
{
    /// <summary>A refusal by the state <paramref name="got"/>, where <paramref name="expected"/> was asked.</summary>
    public ReadyStateException(ReadyState got, ReadyState expected)
        : base($"the transport client is {NotOpen.NameOf(got)}, not {NotOpen.NameOf(expected)}")
    {
        Got = got;
        Expected = expected;
    }

    /// <summary>The state the transport client was in.</summary>
    public ReadyState Got { get; }

    /// <summary>The state what was asked needs.</summary>
    public ReadyState Expected { get; }
}
