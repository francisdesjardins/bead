namespace Bead.Tests;

/// <summary>
/// <see cref="SerialScheduler"/>: one task at a time, in the order posted, what JavaScript's single
/// thread gives the TypeScript side for nothing; so this class has no TypeScript twin.
/// </summary>
public sealed class SerialSchedulerTests
{
    // definition

    [Fact]
    public async Task Runs_what_is_posted_one_at_a_time_in_the_order_posted()
    {
        var scheduler = new SerialScheduler();
        var order = new List<int>();
        var running = 0;
        var most = 0;

        for (var index = 0; index < 20; index += 1)
        {
            var posted = index;

            scheduler.Post(() =>
            {
                running += 1;
                most = Math.Max(most, running);
                order.Add(posted);
                running -= 1;
            });
        }

        await scheduler.WhenIdle();
        Assert.Equal(Enumerable.Range(0, 20), order);
        Assert.Equal(1, most);
        Assert.Equal(1, scheduler.MaximumConcurrencyLevel);
    }

    [Fact]
    public async Task Hands_what_throws_to_the_one_that_hears_it_and_runs_on()
    {
        var scheduler = new SerialScheduler();
        var heard = new List<Exception>();
        var broken = new InvalidOperationException("what runs broke");
        var ran = false;

        scheduler.OnUnhandled = heard.Add;
        scheduler.Post(() =>
        {
            throw broken;
        });
        scheduler.Post(() =>
        {
            ran = true;
        });
        await scheduler.WhenIdle();
        Assert.Same(broken, Assert.Single(heard));
        Assert.True(ran);
    }
}
