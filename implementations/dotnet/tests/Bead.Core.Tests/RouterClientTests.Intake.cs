namespace Bead.Tests;

/// <summary>
/// <see cref="RouterClient"/>'s intake (spec 15.12, decision 0046): what its transport handed it
/// that no turn took yet, its transport paused whole once a bound is reached and resumed once both
/// counts are at half; the router held behind by a job of the test's own on its scheduler.
/// </summary>
public sealed partial class RouterClientTests
{
    // spec 15.12.17, 15.12.18
    [Fact]
    public async Task A_client_pauses_its_transport_while_what_its_server_sent_is_untaken_past_a_bound()
    {
        using var scripted = new ScriptedRouter(new RouterClientOptions { Intake = new IntakeLimits { MaximumUntakenEnvelopes = 2 } });
        var transport = scripted.Transport;
        var taken = new List<string>();

        scripted.Router.Debug += (direction, traced) =>
        {
            if (direction == DebugDirection.Rx)
            {
                taken.Add($"{traced.Header.CallId}{(transport.Hold.IsPaused ? " paused" : "")}");
            }
        };

        // * the router held behind by a job that waits until the test lets it go
        using (var released = new ManualResetEventSlim(false))
        {
            scripted.Router.Core.Loop.Post(() =>
            {
                released.Wait(Patience, Cancelled);
            });

            foreach (var callId in new uint[] { 2, 4, 6 })
            {
                transport.Deliver(new Envelope { Header = new CancelHeader { CallId = callId } });
            }

            // paused at the second, the third held
            Assert.Equal((true, 1, 0), (transport.Hold.IsPaused, transport.Hold.Count, taken.Count));

            released.Set();
            await scripted.Settle();
        }

        // resumed once its turns took it down to half, what it held handed on behind the rest
        Assert.Equal(["2 paused", "4", "6"], taken);
        Assert.Equal([true, false], transport.Pauses);
        Assert.False(transport.Hold.IsPaused);
    }
}
