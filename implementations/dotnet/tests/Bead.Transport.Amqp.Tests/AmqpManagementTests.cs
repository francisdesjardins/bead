using Amqp;
using Amqp.Framing;
using Amqp.Types;
using AmqpTransfer = Amqp.Framing.Transfer;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// RabbitMQ 4's management over AMQP 1.0, as the adapter asks it, against a scripted peer,
/// <see cref="AmqpScript"/>: its pair attached one link after the other on a session of its own,
/// each answer matched by its correlation-id, and each request under way failed by the end of what
/// carries it. The TypeScript side's <c>amqp-management.test.ts</c> plays the same sentences.
/// </summary>
public sealed class AmqpManagementTests : IAsyncLifetime
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private AmqpScript _script = null!;

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    public ValueTask InitializeAsync()
    {
        _script = AmqpScript.Start();

        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        await _script.DisposeAsync();
    }

    // a connection of the library's own to the script, and the script's end of it
    private async Task<(Connection Connection, ScriptedConnection Scripted)> ConnectedOf()
    {
        var connecting = new ConnectionFactory().CreateAsync(new Address("127.0.0.1", _script.Uri.Port, "ada", "secret", "/", "AMQP"));
        var scripted = await _script.Connection();

        return (await connecting.WaitAsync(Patience, Cancelled), scripted);
    }

    private static async Task<Exception> FailureOf(Task call)
    {
        try
        {
            await call.WaitAsync(Patience, Cancelled);
        }
        catch (Exception reason) when (reason is not TimeoutException)
        {
            return reason;
        }

        throw new Xunit.Sdk.XunitException("it did not fail");
    }

    // definition

    [Fact]
    public async Task Pairs_its_sender_and_receiver_under_one_name_on_a_session_of_its_own_one_after_the_other_and_matches_each_answer_by_its_correlation_id()
    {
        var (connection, scripted) = await ConnectedOf();

        // * the sender's ATTACH held: the receiver's waits for its answer
        _script.Holding = (frame) =>
        {
            return frame.Performative is Attach { Role: false };
        };

        var opening = AmqpManagement.Open(connection, Cancelled);
        var (begun, _) = await scripted.Next<Begin>();
        var (sent, sender) = await scripted.Next<Attach>();

        Assert.Equal(
            (false, AmqpManagement.Node, AmqpManagement.Node, SenderSettleMode.Settled, ReceiverSettleMode.First, (object)true, begun.Channel),
            (sender.Role, ((Source)sender.Source).Address, ((Target)sender.Target).Address, sender.SndSettleMode, sender.RcvSettleMode, sender.Properties[new Symbol("paired")], sent.Channel));
        await Task.Delay(200, Cancelled);
        Assert.Single(scripted.Of<Attach>());

        _script.Holding = (frame) =>
        {
            return frame.Performative is AmqpTransfer;
        };
        await scripted.AnswerAttach(sent);

        var (received, receiver) = await scripted.Next<Attach>(1);

        Assert.Equal(
            (true, sender.LinkName, AmqpManagement.Node, (object)true, sent.Channel),
            (receiver.Role, receiver.LinkName, ((Source)receiver.Source).Address, receiver.Properties[new Symbol("paired")], received.Channel));

        var management = await opening.WaitAsync(Patience, Cancelled);

        // two requests under way, answered the other way round, each matched by its correlation-id
        var first = management.Request(("GET", "/queues/bead.s.first"), null, Cancelled);
        var second = management.Request(("PUT", "/queues/bead.s.second"), new Map { ["durable"] = true }, Cancelled);
        var (firstRequest, firstTransfer) = await scripted.NextRequest(0);
        var (secondRequest, secondTransfer) = await scripted.NextRequest(1);

        Assert.Equal(
            ("GET", "/queues/bead.s.first", "$me", "PUT", "/queues/bead.s.second", true),
            (firstRequest.Method, firstRequest.Path, firstTransfer.Message.Properties.ReplyTo, secondRequest.Method, secondRequest.Path, firstTransfer.IsSettled && secondTransfer.IsSettled));
        Assert.NotEqual(firstRequest.MessageId, secondRequest.MessageId);

        // an answer naming no request under way is none of theirs
        await scripted.Answer(firstTransfer, ("200", new Map()), "another");
        await Task.Delay(100, Cancelled);
        Assert.False(first.IsCompleted || second.IsCompleted);
        await scripted.Answer(secondTransfer, ("201", new Map()));
        await scripted.Answer(firstTransfer, ("404", "queue 'bead.s.first' in vhost '/' not found"));
        Assert.Equal("201", (await second.WaitAsync(Patience, Cancelled)).Status);
        Assert.Equal("404, queue 'bead.s.first' in vhost '/' not found", (await first.WaitAsync(Patience, Cancelled)).Said);

        await management.Close(Patience);
        await scripted.Next<End>();
        AmqpEndpoints.CloseAtOnce(connection);
    }

    [Fact]
    public async Task Fails_each_request_under_way_when_its_link_is_detached_its_session_ends_or_its_connection_is_lost_and_matches_no_answer_of_an_ended_pair_to_a_later_request()
    {
        _script.Holding = (frame) =>
        {
            return frame.Performative is AmqpTransfer;
        };

        var ends = new (string Name, Func<ScriptedConnection, Task> End)[]
        {
            ("its sender detached", (scripted) =>
            {
                return scripted.Detach(scripted.Links.First((link) =>
                {
                    return !link.IsReceiver;
                }), new Error(new Symbol("amqp:internal-error")));
            }),
            ("its receiver detached", (scripted) =>
            {
                return scripted.Detach(scripted.LinkOf(AmqpManagement.Node), new Error(new Symbol("amqp:internal-error")));
            }),
            ("its session ended", (scripted) =>
            {
                return scripted.End(scripted.LinkOf(AmqpManagement.Node).Channel, new Error(new Symbol("amqp:unauthorized-access")));
            }),
            ("its connection lost", (scripted) =>
            {
                scripted.Cut();

                return Task.CompletedTask;
            }),
        };

        foreach (var (name, end) in ends)
        {
            var (connection, scripted) = await ConnectedOf();
            var management = await AmqpManagement.Open(connection, Cancelled);
            var pending = management.Request(("PUT", "/queues/bead.i.ada"), new Map(), Cancelled);

            await scripted.NextRequest();
            await end(scripted);

            Assert.True((await FailureOf(pending)) is IOException, name);

            // and what it is asked after fails at once
            Assert.True((await FailureOf(management.Request(("GET", "/queues/bead.i.ada"), null, Cancelled))) is IOException, name);
            AmqpEndpoints.CloseAtOnce(connection);
        }

        // an answer of an ended pair is matched to no request of a later one
        var (shared, sharedScript) = await ConnectedOf();
        var ended = await AmqpManagement.Open(shared, Cancelled);
        var abandoned = ended.Request(("GET", "/queues/bead.s.first"), null, Cancelled);
        var (abandonedRequest, _) = await sharedScript.NextRequest(0);

        await ended.Close(Patience);
        Assert.IsType<IOException>(await FailureOf(abandoned));

        var later = await AmqpManagement.Open(shared, Cancelled);
        var asked = later.Request(("GET", "/queues/bead.s.second"), null, Cancelled);
        var (_, askedTransfer) = await sharedScript.NextRequest(1);

        await sharedScript.Answer(askedTransfer, ("200", new Map()), abandonedRequest.MessageId);
        await Task.Delay(200, Cancelled);
        Assert.False(asked.IsCompleted);
        await sharedScript.Answer(askedTransfer, ("404", "not found"));
        Assert.Equal("404", (await asked.WaitAsync(Patience, Cancelled)).Status);
        await later.Close(Patience);
        AmqpEndpoints.CloseAtOnce(shared);

        // and one given up as it opens fails, its session ended
        _script.Holding = (frame) =>
        {
            return frame.Performative is Attach;
        };

        var (given, givenScript) = await ConnectedOf();
        using var giving = new CancellationTokenSource();
        var opening = AmqpManagement.Open(given, giving.Token);

        await givenScript.Next<Attach>();
        await giving.CancelAsync();
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(opening));
        await givenScript.Next<End>();
        AmqpEndpoints.CloseAtOnce(given);
    }
}
