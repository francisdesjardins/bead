namespace Bead.Tests;

/// <summary>
/// <see cref="RouterIntake"/> (spec 15.12, decision 0046): when it pauses a connection and when it
/// resumes it, by both its counts.
/// </summary>
public sealed class RouterIntakeTests
{
    // helpers

    // what an intake asked of its transport, each call as a line
    private sealed class Calls
    {
        private readonly List<string> _lines = [];

        public void Pause(string connectionHandle)
        {
            _lines.Add($"pause {connectionHandle}");
        }

        public void Resume(string connectionHandle)
        {
            _lines.Add($"resume {connectionHandle}");
        }

        public string[] Taken()
        {
            string[] taken = [.. _lines];

            _lines.Clear();

            return taken;
        }
    }

    private static RouterIntake IntakeOf((int Envelopes, long Bytes) limits)
    {
        return new RouterIntake(new IntakeLimits { MaximumUntakenEnvelopes = limits.Envelopes, MaximumUntakenBytes = limits.Bytes });
    }

    // definition

    [Fact]
    public void Pauses_a_connection_once_what_it_handed_within_one_task_reaches_either_bound_once()
    {
        var intake = IntakeOf((3, 100));
        var calls = new Calls();

        foreach (var (handle, bytes) in new[] { ("a", 10), ("a", 10), ("b", 100) })
        {
            Assert.True(intake.Handed((handle, bytes), calls.Pause));
        }

        Assert.Equal(["pause b"], calls.Taken());
        Assert.Equal(["b"], intake.Paused);

        foreach (var (handle, bytes) in new[] { ("a", 10), ("a", 4), ("b", 1) })
        {
            Assert.True(intake.Handed((handle, bytes), calls.Pause));
        }

        Assert.Equal(["pause a"], calls.Taken());
        Assert.Equal(["a", "b"], intake.Paused.Order());
        intake.End(calls.Resume);
    }

    [Fact]
    public void Resumes_what_it_paused_as_it_ends_and_counts_nothing_after()
    {
        var intake = IntakeOf((1, 1_048_576));
        var calls = new Calls();

        Assert.True(intake.Handed(("a", 1), calls.Pause));
        intake.End(calls.Resume);
        intake.End(calls.Resume);

        Assert.False(intake.Handed(("b", 1), calls.Pause));
        Assert.Equal(["pause a", "resume a"], calls.Taken());
        Assert.Empty(intake.Paused);
    }

    [Fact]
    public void Counts_each_connection_apart_and_an_end_resumes_each_paused_and_counts_nothing_more()
    {
        var intake = IntakeOf((2, 1_048_576));
        var calls = new Calls();

        foreach (var handle in new[] { "first", "second", "first", "third", "second" })
        {
            Assert.True(intake.Handed((handle, 1), calls.Pause));
        }

        Assert.Equal(["pause first", "pause second"], calls.Taken());

        intake.Forget("second");
        intake.Taken(("second", 1), calls.Resume);

        Assert.Empty(calls.Taken());
        intake.End(calls.Resume);

        Assert.Equal(["resume first"], calls.Taken());
        Assert.False(intake.Handed(("first", 1), calls.Pause));
        Assert.False(intake.Handed(("first", 1), calls.Pause));

        intake.Taken(("third", 1), calls.Resume);

        Assert.Empty(calls.Taken());
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public void Pauses_at_the_envelope_that_reaches_a_bound_and_resumes_once_both_counts_are_at_half()
    {
        var intake = IntakeOf((4, 1_000));
        var calls = new Calls();
        const string First = "first";

        for (var i = 0; i < 3; i++)
        {
            Assert.True(intake.Handed((First, 10), calls.Pause), "counted");
        }

        Assert.Empty(calls.Taken());

        intake.Handed((First, 10), calls.Pause);

        Assert.Equal(["pause first"], calls.Taken());

        // * once paused, a fifth handed all the same pauses nothing again
        intake.Handed((First, 10), calls.Pause);

        Assert.Empty(calls.Taken());
        Assert.Equal([First], intake.Paused);

        // 4 untaken, then 3: still paused
        for (var i = 0; i < 2; i++)
        {
            intake.Taken((First, 10), calls.Resume);

            Assert.Empty(calls.Taken());
        }

        intake.Taken((First, 10), calls.Resume);

        // resumed at 2 untaken, half of 4
        Assert.Equal(["resume first"], calls.Taken());

        intake.Taken((First, 10), calls.Resume);
        intake.Taken((First, 10), calls.Resume);

        Assert.Empty(calls.Taken());
        Assert.Empty(intake.Paused);

        // * its bytes alike: one envelope past the byte bound pauses, and is released whole
        intake.Handed((First, 5_000), calls.Pause);

        Assert.Equal(["pause first"], calls.Taken());

        intake.Taken((First, 5_000), calls.Resume);

        Assert.Equal(["resume first"], calls.Taken());
    }

    // spec 15.12.17, 15.12.18
    [Fact]
    public void Resumes_only_once_both_counts_are_at_half_and_a_bound_of_1_at_0()
    {
        var intake = IntakeOf((10, 100));
        var calls = new Calls();
        const string First = "first";

        // * paused by its bytes, its envelopes under their half: resumed once its bytes are at 50
        intake.Handed((First, 60), calls.Pause);
        intake.Handed((First, 40), calls.Pause);

        Assert.Equal(["pause first"], calls.Taken());

        intake.Taken((First, 40), calls.Resume);

        // 60 bytes untaken, past half
        Assert.Empty(calls.Taken());

        intake.Taken((First, 60), calls.Resume);

        Assert.Equal(["resume first"], calls.Taken());

        // * a bound of 1: each envelope pauses, and its release resumes
        var single = IntakeOf((1, 1_048_576));

        single.Handed((First, 1), calls.Pause);
        single.Handed((First, 1), calls.Pause);
        single.Taken((First, 1), calls.Resume);

        // one untaken, past half of 1
        Assert.Equal(["pause first"], calls.Taken());

        single.Taken((First, 1), calls.Resume);

        // resumed at 0, half of 1
        Assert.Equal(["resume first"], calls.Taken());
    }
}
