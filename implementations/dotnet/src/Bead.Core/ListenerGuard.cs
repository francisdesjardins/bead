namespace Bead;

/// <summary>
/// How a transport tells its events (spec 15.1): each listener within its own guard, as a debug
/// listener is called (<c>debugging.md</c> 2.2, 2.3, after the DOM's inner invoke); what one throws
/// is given to its transport's report, the listeners after it are told all the same, and the
/// transport goes on as if it returned. The report is given the connection's handle on a server,
/// whose every event of a connection carries it last, and none on a client, whose events carry
/// none, nor for a server's refusal, which names no connection. Every error event a side tells, a
/// transport's, a router's, a participant's or a gateway's, is told through
/// <see cref="TellError{T}"/>, whose guard drops what a listener throws.
/// </summary>
internal sealed class ListenerGuard(Action<Exception, string?> report)
{
    /// <summary>Tells each of <paramref name="listeners"/> of an event that carries nothing, a client's reconnection, each within its guard.</summary>
    public void Tell(Action? listeners)
    {
        foreach (var listener in Delegate.EnumerateInvocationList(listeners))
        {
            try
            {
                listener();
            }
            catch (Exception reason)
            {
                report(reason, null);
            }
        }
    }

    /// <summary>Tells <paramref name="argument"/> to each of <paramref name="listeners"/>, each within its guard.</summary>
    public void Tell<T>(Action<T>? listeners, T argument)
    {
        foreach (var listener in Delegate.EnumerateInvocationList(listeners))
        {
            try
            {
                listener(argument);
            }
            catch (Exception reason)
            {
                // ! a server's one-argument event of a connection is the handle itself; an argument
                // that is no handle, a refusal's, is reported with none
                report(reason, argument as string);
            }
        }
    }

    /// <summary>Tells <paramref name="arguments"/> to each of <paramref name="listeners"/>, each within its guard.</summary>
    public void Tell<T1, T2>(Action<T1, T2>? listeners, (T1, T2) arguments)
    {
        var (first, last) = arguments;

        foreach (var listener in Delegate.EnumerateInvocationList(listeners))
        {
            try
            {
                listener(first, last);
            }
            catch (Exception reason)
            {
                // ! a server's event carries its connection's handle last
                report(reason, last as string);
            }
        }
    }

    /// <summary>
    /// Tells <paramref name="argument"/> to each listener of an error event, a client's, each within
    /// a guard that drops what it throws: the listeners after it are told all the same (spec 15.1).
    /// </summary>
    public static void TellError<T>(Action<T>? listeners, T argument)
    {
        foreach (var listener in Delegate.EnumerateInvocationList(listeners))
        {
            try
            {
                listener(argument);
            }
            catch (Exception)
            {
                // ! dropped, reported nowhere: reporting it would tell the event that threw, as an
                // error listener's own exception fires no error again in HTML's report of an
                // exception (spec 15.1)
            }
        }
    }

    /// <summary>
    /// Tells <paramref name="arguments"/> to each listener of an error event, a server's, each
    /// within a guard that drops what it throws: the listeners after it are told all the same
    /// (spec 15.1).
    /// </summary>
    public static void TellError<T1, T2>(Action<T1, T2>? listeners, (T1, T2) arguments)
    {
        var (first, last) = arguments;

        foreach (var listener in Delegate.EnumerateInvocationList(listeners))
        {
            try
            {
                listener(first, last);
            }
            catch (Exception)
            {
                // ! dropped, reported nowhere: reporting it would tell the event that threw, as an
                // error listener's own exception fires no error again in HTML's report of an
                // exception (spec 15.1)
            }
        }
    }
}
