namespace Bead.Tests;

/// <summary>
/// <see cref="TransportServerLife"/>: the ready state and the guards around a start and a stop, as
/// the TypeScript side's <c>createTransportServer</c> keeps them, before any transport fills them.
/// </summary>
public sealed class TransportServerLifeTests
{
    // constants

    private static readonly TransportServerAddress Bound = new("127.0.0.1", 50_000);

    // helpers

    // a start that listens at once, counting each time it is reached
    private static Func<Task<TransportServerAddress>> Starting(List<string> calls)
    {
        return () =>
        {
            calls.Add("start");

            return Task.FromResult(Bound);
        };
    }

    // a stop that ends at once, counting each time it is reached
    private static Func<Task> Stopping(List<string> calls)
    {
        return () =>
        {
            calls.Add("stop");

            return Task.CompletedTask;
        };
    }

    // definition

    [Fact]
    public async Task Starts_reporting_where_it_listens()
    {
        var life = new TransportServerLife();

        Assert.Equal(ReadyState.Uninitialized, life.ReadyState);
        var bound = await life.Start(Starting([]));

        Assert.Equal(Bound, bound);
        Assert.Equal(("127.0.0.1", 50_000), (bound.Address, bound.Port));
        Assert.Equal(ReadyState.Open, life.ReadyState);
        Assert.False(life.IsStopping);
    }

    [Fact]
    public async Task Rejects_a_second_start_with_an_InvalidOperationException_without_reaching_the_transport()
    {
        var calls = new List<string>();
        var life = new TransportServerLife();

        await life.Start(Starting(calls));

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return life.Start(Starting(calls));
        });

        Assert.Equal("the transport server is already open", refused.Message);
        Assert.Equal(["start"], calls);
    }

    [Fact]
    public async Task Ends_CLOSED_when_the_transport_cannot_start_and_can_start_again()
    {
        var life = new TransportServerLife();

        var failed = await Assert.ThrowsAsync<IOException>(() =>
        {
            return life.Start(() =>
            {
                return Task.FromException<TransportServerAddress>(new IOException("taken"));
            });
        });

        Assert.Equal("taken", failed.Message);
        Assert.Equal(ReadyState.Closed, life.ReadyState);

        await life.Start(Starting([]));
        Assert.Equal(ReadyState.Open, life.ReadyState);

        await life.Stop(Stopping([]));
        await life.Start(Starting([]));
        Assert.Equal(ReadyState.Open, life.ReadyState);
    }

    [Fact]
    public async Task Rejects_a_second_start_while_the_first_is_still_starting()
    {
        var calls = new List<string>();
        var gate = new TaskCompletionSource<TransportServerAddress>(TaskCreationOptions.RunContinuationsAsynchronously);
        var life = new TransportServerLife();

        var starting = life.Start(() =>
        {
            calls.Add("start");

            return gate.Task;
        });

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return life.Start(Starting(calls));
        });

        Assert.Equal("the transport server is already connecting", refused.Message);

        gate.SetResult(Bound);
        await starting;
        Assert.Equal(["start"], calls);
    }

    [Fact]
    public async Task Stops_at_once_when_never_started_or_already_stopped()
    {
        var calls = new List<string>();
        var life = new TransportServerLife();

        await life.Stop(Stopping(calls));
        await life.Start(Starting(calls));
        await life.Stop(Stopping(calls));
        await life.Stop(Stopping(calls));

        Assert.Equal(["start", "stop"], calls);
        Assert.Equal(ReadyState.Closed, life.ReadyState);
        Assert.True(life.IsStopping);
    }

    [Fact]
    public async Task Shares_a_stop_already_in_progress()
    {
        var calls = new List<string>();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var life = new TransportServerLife();

        await life.Start(Starting(calls));

        var first = life.Stop(() =>
        {
            calls.Add("stop");

            return gate.Task;
        });
        var second = life.Stop(Stopping(calls));

        Assert.Same(first, second);
        Assert.Equal(ReadyState.Closing, life.ReadyState);
        Assert.True(life.IsStopping);

        gate.SetResult();
        await first;
        Assert.Equal(["start", "stop"], calls);
        Assert.Equal(ReadyState.Closed, life.ReadyState);
    }

    [Fact]
    public async Task Rejects_a_stop_while_starting()
    {
        var gate = new TaskCompletionSource<TransportServerAddress>(TaskCreationOptions.RunContinuationsAsynchronously);
        var life = new TransportServerLife();

        var starting = life.Start(() =>
        {
            return gate.Task;
        });

        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return life.Stop(Stopping([]));
        });

        Assert.Equal("the transport server is starting", refused.Message);
        Assert.Equal(ReadyState.Connecting, life.ReadyState);

        gate.SetResult(Bound);
        await starting;
        await life.Stop(Stopping([]));
        Assert.Equal(ReadyState.Closed, life.ReadyState);
    }

    [Fact]
    public async Task A_transport_stop_that_throws_still_ends_CLOSED_as_a_rejection()
    {
        var life = new TransportServerLife();

        await life.Start(Starting([]));

        var failed = await Assert.ThrowsAsync<IOException>(() =>
        {
            return life.Stop(() =>
            {
                throw new IOException("stop failed");
            });
        });

        Assert.Equal("stop failed", failed.Message);
        Assert.Equal(ReadyState.Closed, life.ReadyState);
    }

    [Fact]
    public async Task A_stop_re_entered_from_a_close_listener_shares_the_stop_in_progress()
    {
        var calls = new List<string>();
        var stops = new List<Task>();
        var life = new TransportServerLife();

        await life.Start(Starting(calls));

        var stopping = life.Stop(() =>
        {
            calls.Add("stop");

            // what the stop causes, a close, stops it again
            stops.Add(life.Stop(Stopping(calls)));

            return Task.CompletedTask;
        });
        await stopping;

        Assert.Equal([stopping], stops);
        Assert.Equal(["start", "stop"], calls);
    }
}
