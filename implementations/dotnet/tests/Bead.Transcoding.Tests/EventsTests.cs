using System.Text;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpEvents"/>: a stream's call written as Server-Sent Events, its result first, each
/// notification a plain event, the failure that ends it last, each event an id, and each
/// notification's task settled once its event was taken (transcoding 8). The twins of the TypeScript
/// side's <c>events.test.ts</c>.
/// </summary>
public sealed class EventsTests
{
    private static ReadOnlyMemory<byte> Bytes(string text)
    {
        return Encoding.UTF8.GetBytes(text);
    }

    [Fact]
    public async Task Writes_the_result_then_each_notification_as_a_message_then_the_failure_that_ends_them_each_event_an_id()
    {
        var written = new StringBuilder();
        var events = new HttpEvents((bytes) =>
        {
            written.Append(Encoding.UTF8.GetString(bytes.Span));

            return Task.CompletedTask;
        });

        // * a notification before its answer is held until its result, then written after it
        var held = events.Notification(Bytes("{\"remaining\":2}"));

        Assert.Equal("", written.ToString());
        await events.Result(Bytes("{\"ticks\":3}"));
        await held;
        await events.Notification(Bytes("{\"remaining\":1}"));
        await events.Heartbeat();
        Assert.True(events.Failure(Bytes("{\"code\":2}"), out var ending));
        await ending;

        Assert.Equal(
            "event: result\nid: 1\ndata: {\"ticks\":3}\n\nid: 2\ndata: {\"remaining\":2}\n\nid: 3\ndata: {\"remaining\":1}\n\n:\nevent: failure\nid: 4\ndata: {\"code\":2}\n\n",
            written.ToString());

        // a failure before its answer writes nothing: its caller answers it as a call's, the notifications it held dropped
        var unanswered = new HttpEvents((_) =>
        {
            throw new InvalidOperationException("nothing is written before its result");
        });
        var dropped = unanswered.Notification(Bytes("{}"));

        Assert.False(unanswered.Failure(Bytes("{}"), out _));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return dropped;
        });
    }

    [Fact]
    public async Task Credits_each_notification_once_the_event_before_it_was_taken()
    {
        var taking = new List<TaskCompletionSource>();
        var events = new HttpEvents((_) =>
        {
            var taken = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            lock (taking)
            {
                taking.Add(taken);
            }

            return taken.Task;
        });

        var result = events.Result(Bytes("{}"));
        var first = events.Notification(Bytes("{\"remaining\":1}"));
        var second = events.Notification(Bytes("{\"remaining\":0}"));

        // * one write at a time: the next is handed on only once the one before it was taken
        Assert.Single(taking);
        taking[0].SetResult();
        await result;
        Assert.False(first.IsCompleted);

        await WaitFor(taking, 2);
        Assert.False(first.IsCompleted);
        taking[1].SetResult();
        await first;
        Assert.False(second.IsCompleted);

        await WaitFor(taking, 3);
        taking[2].SetResult();
        await second;
    }

    private static async Task WaitFor(List<TaskCompletionSource> taking, int count)
    {
        for (var tries = 0; tries < 500; tries += 1)
        {
            lock (taking)
            {
                if (taking.Count >= count)
                {
                    return;
                }
            }

            await Task.Delay(TimeSpan.FromMilliseconds(2), TimeProvider.System);
        }

        throw new TimeoutException($"{count} writes never came");
    }
}
