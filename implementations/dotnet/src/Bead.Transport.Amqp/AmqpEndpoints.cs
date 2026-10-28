using Amqp;
using Amqp.Framing;

namespace Bead.Transport.Amqp;

/// <summary>
/// What AMQPNetLite tells by callbacks, awaited: a session begun, a link attached, an end read, each
/// failing on its endpoint's end, which names its condition (AMQP 1.0 §2.7, §2.8). Every callback
/// runs on its connection's own reader, so nothing here blocks it.
/// </summary>
internal static class AmqpEndpoints
{
    /// <summary>
    /// A session begun on <paramref name="connection"/>: settles once its peer's BEGIN came, and
    /// fails, naming why, once it ended first. Its <c>Session</c> is the library's at once, so that
    /// what gives up on it can end it.
    /// </summary>
    public static (Session Session, Task Begun) Begin(Connection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);

        var begun = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var session = new Session(
            connection,
            new Begin { IncomingWindow = 2_048, OutgoingWindow = 2_048, HandleMax = 7, NextOutgoingId = 0 },
            (_, _) =>
            {
                begun.TrySetResult();
            });

        session.AddClosedCallback((_, error) =>
        {
            begun.TrySetException(new IOException($"its session ended as it began: {ReasonOf(error)}"));
        });

        return (session, begun.Task);
    }

    /// <summary>
    /// What a link's peer answered its ATTACH with, once it came; it fails, naming why, once the link
    /// ended first. A source or a target its peer left null is no refusal yet: the DETACH that
    /// follows it names one (AMQP 1.0 §2.6.3).
    /// </summary>
    public static TaskCompletionSource<Attach> AttachedOf()
    {
        return new TaskCompletionSource<Attach>(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>Fails what waits for a link's ATTACH once the link ended before it came.</summary>
    public static void FailOnEnd((Link Link, TaskCompletionSource<Attach> Attached) watched)
    {
        var (link, attached) = watched;

        link.AddClosedCallback((_, error) =>
        {
            attached.TrySetException(new IOException(ReasonOf(error)));
        });
    }

    /// <summary>Settles once <paramref name="amqpObject"/> ended, its peer's end or its own, with what its end named; none for a clean one.</summary>
    public static Task<Error?> EndOf(AmqpObject amqpObject)
    {
        ArgumentNullException.ThrowIfNull(amqpObject);

        var ended = new TaskCompletionSource<Error?>(TaskCreationOptions.RunContinuationsAsynchronously);

        amqpObject.AddClosedCallback((_, error) =>
        {
            ended.TrySetResult(error);
        });

        return ended.Task;
    }

    /// <summary>
    /// Ends <paramref name="amqpObject"/> and awaits its peer's answer within <paramref name="bound"/>,
    /// whatever ends it first; nothing it throws reaches the caller, since its end is what was asked.
    /// </summary>
    public static async Task Ending(AmqpObject amqpObject, TimeSpan bound)
    {
        ArgumentNullException.ThrowIfNull(amqpObject);

        var ended = EndOf(amqpObject);

        try
        {
            CloseAtOnce(amqpObject);
            await ended.WaitAsync(bound, TimeProvider.System);
        }
        catch (Exception reason) when (reason is AmqpException or TimeoutException or ObjectDisposedException or InvalidOperationException or IOException)
        {
            // ended all the same, or past its bound
        }
    }

    /// <summary>
    /// Ends <paramref name="amqpObject"/> without waiting for its peer's answer, which its end tells:
    /// the library's close that waits would block its connection's reader, every callback's thread.
    /// </summary>
    public static void CloseAtOnce(AmqpObject? amqpObject)
    {
        try
        {
            amqpObject?.Close(TimeSpan.Zero);
        }
        catch (Exception reason) when (reason is AmqpException or TimeoutException or ObjectDisposedException or InvalidOperationException or IOException)
        {
            // ended already
        }
    }

    /// <summary>What an end names: its condition and its description, or a clean end.</summary>
    public static string ReasonOf(Error? error)
    {
        if (error is null)
        {
            return "ended with no error";
        }

        return error.Description is { Length: > 0 } description ? $"{error.Condition}, {description}" : $"{error.Condition}";
    }
}
