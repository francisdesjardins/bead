using System.Globalization;
using System.Text;
using Bead.Protobuf;

namespace Bead.Transcoding;

/// <summary>
/// A stream's call written as Server-Sent Events (transcoding 8, WHATWG HTML §9.2): nothing before
/// its result, which opens it as its first event, <c>event: result</c>; a notification that came
/// before held until then, written after it in its order, or dropped with the failure that took its
/// subscription away; each notification a plain event, which an <c>EventSource</c> dispatches as
/// <c>message</c>; then the failure that ends it, <c>event: failure</c>. Each event has an
/// <c>id</c>, its count in the stream from 1. Each write is handed to its sink in order, one at a
/// time, and a notification's task settles once its event was taken, which its subscription's
/// credit waits on (8.8), or once the stream could not take it, its credit moot. A second result,
/// or a result or a notification once its failure ended it, is its caller's bug, an
/// <see cref="InvalidOperationException"/>.
/// </summary>
public sealed class HttpEvents
{
    private readonly Lock _gate = new();
    private readonly Func<ReadOnlyMemory<byte>, Task> _write;
    private readonly List<(ReadOnlyMemory<byte> Data, TaskCompletionSource Taken)> _held = [];
    private Task _last = Task.CompletedTask;
    private long _count;
    private bool _isAnswered;
    private bool _isEnded;

    /// <summary>
    /// A stream that hands each write to <paramref name="write"/>, which settles once the bytes were
    /// taken: written whole to the socket, or taken as the stream's flow control lets them.
    /// </summary>
    public HttpEvents(Func<ReadOnlyMemory<byte>, Task> write)
    {
        ArgumentNullException.ThrowIfNull(write);

        _write = write;
    }

    /// <summary>Whether its result came, which opened it.</summary>
    public bool IsAnswered
    {
        get
        {
            lock (_gate)
            {
                return _isAnswered;
            }
        }
    }

    /// <summary>Whether a failure ended it.</summary>
    public bool IsEnded
    {
        get
        {
            lock (_gate)
            {
                return _isEnded;
            }
        }
    }

    /// <summary>An event's bytes: its name's line where it has one, its id's, its data's, then an empty line (8.5).</summary>
    public static byte[] EventOf(string? name, (long Id, ReadOnlyMemory<byte> Data) at)
    {
        var head = new StringBuilder();

        if (name is not null)
        {
            head.Append("event: ").Append(name).Append('\n');
        }

        head.Append("id: ").Append(at.Id.ToString(CultureInfo.InvariantCulture)).Append("\ndata: ");

        return [.. Encoding.ASCII.GetBytes(head.ToString()), .. at.Data.Span, (byte)'\n', (byte)'\n'];
    }

    /// <summary>
    /// An event's data (8.4), one JSON text: a <c>proto</c> payload by Bead's proto JSON form, a
    /// <c>json</c> one as it is, a <c>text</c> one as a JSON string, a <c>raw</c> one as a JSON string
    /// of its bytes in standard base64, padded. A <c>proto</c> payload is read as spec 17.9 reads one,
    /// through <see cref="ProtoCodecs"/>: one that does not read is a <see cref="FormatException"/>,
    /// and one Bead's proto JSON form holds none of a <see cref="JsonFormException"/>.
    /// </summary>
    public static ReadOnlyMemory<byte> DataOf(HttpPayload payload, (ReadOnlyMemory<byte> Bytes, JsonForm Form) of)
    {
        ArgumentNullException.ThrowIfNull(payload);

        var (bytes, form) = of;

        return payload.Encoding switch
        {
            HttpEncoding.Proto => form.Write(ProtoCodecs.Read(payload.Descriptor!, bytes)),
            HttpEncoding.Json => bytes,
            HttpEncoding.Text => Payloads.WriteJsonString(Payloads.ReadText(bytes)),
            _ => Payloads.WriteJsonString(Convert.ToBase64String(bytes.Span)),
        };
    }

    /// <summary>Its result: the stream's first event, then each notification it held, in their order.</summary>
    public Task Result(ReadOnlyMemory<byte> data)
    {
        List<(ReadOnlyMemory<byte> Data, TaskCompletionSource Taken)> held;
        Task written;

        lock (_gate)
        {
            if (_isAnswered || _isEnded)
            {
                throw new InvalidOperationException("a stream has one result, before its end");
            }

            _isAnswered = true;
            written = Enqueue(EventOf("result", (++_count, data)));
            held = [.. _held];
            _held.Clear();

            foreach (var (notification, taken) in held)
            {
                Settle(Enqueue(EventOf(null, (++_count, notification))), taken);
            }
        }

        return written;
    }

    /// <summary>
    /// A notification: held before its result, written after it otherwise; the task settles once its
    /// event was taken, or once the stream could not take it, its credit moot: dropped by the failure
    /// that ends it, or refused by its sink. One once its failure ended it faults: its caller's bug.
    /// </summary>
    public Task Notification(ReadOnlyMemory<byte> data)
    {
        lock (_gate)
        {
            if (_isEnded)
            {
                return Task.FromException(new InvalidOperationException("the stream ended"));
            }

            if (!_isAnswered)
            {
                var taken = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

                _held.Add((data, taken));

                return taken.Task;
            }

            var settled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            Settle(Enqueue(EventOf(null, (++_count, data))), settled);

            return settled.Task;
        }
    }

    /// <summary>
    /// The failure that ends it: after its result, its last event, and true; before, false, the
    /// notifications it held dropped, and its caller answers the failure as any call's (8.2).
    /// </summary>
    public bool Failure(ReadOnlyMemory<byte> problem, out Task written)
    {
        lock (_gate)
        {
            if (_isEnded)
            {
                written = Task.CompletedTask;

                return _isAnswered;
            }

            _isEnded = true;

            if (!_isAnswered)
            {
                // * their credit moot: settled, never faulted
                foreach (var (_, taken) in _held)
                {
                    taken.TrySetResult();
                }

                _held.Clear();
                written = Task.CompletedTask;

                return false;
            }

            written = Enqueue(EventOf("failure", (++_count, problem)));

            return true;
        }
    }

    /// <summary>A comment, <c>:</c>, written while nothing else goes once it is open (8.7); nothing before its result or after its end.</summary>
    public Task Heartbeat()
    {
        lock (_gate)
        {
            if (!_isAnswered || _isEnded || !_last.IsCompleted)
            {
                return Task.CompletedTask;
            }

            return Enqueue(":\n"u8.ToArray());
        }
    }

    // a notification's task settled once its event was taken, or once the stream could not take it
    private static void Settle(Task written, TaskCompletionSource taken)
    {
        written.ContinueWith(
            (_) =>
            {
                taken.TrySetResult();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    // a write after the one before it, whatever that one came to: one at a time, in order
    private Task Enqueue(byte[] bytes)
    {
        var previous = _last;

        _last = Writing(previous, bytes);

        return _last;
    }

    private async Task Writing(Task previous, byte[] bytes)
    {
        await previous.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        await _write(bytes);
    }
}
