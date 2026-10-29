using System.Globalization;
using Amqp;
using Amqp.Framing;
using Amqp.Types;

namespace Bead.Transport.Amqp;

/// <summary>A management answer: its status, the subject RabbitMQ writes it in, and its body.</summary>
internal sealed record AmqpManagementAnswer(string Status, object? Body)
{
    /// <summary>What it says, for a failure that names it: its status, and its body where it is text.</summary>
    public string Said
    {
        get
        {
            return Body is string text ? $"{Status}, {text}" : Status;
        }
    }
}

/// <summary>
/// RabbitMQ 4's management, asked over AMQP 1.0 on one connection (spec 15.33): a sender and a
/// receiver of one name, paired, on a session of their own (AMQP Request-Response Messaging with Link
/// Pairing v1.0), the receiver's ATTACH going once the sender's was answered; each request a message
/// whose <c>subject</c> is its method, <c>to</c> its path, <c>reply-to</c> <c>$me</c> and
/// <c>message-id</c> its own, its answer matched by its <c>correlation-id</c>, its status in its
/// <c>subject</c> (HTTP over AMQP). A request under way fails once a link of the pair, its session
/// or its connection ends; an answer that comes to no request of this pair is dropped, so none of an
/// ended pair reaches a later one. Nothing is settled but by its sender: the pair's transfers go
/// settled both ways. The TypeScript side's <c>amqp-management</c> asks alike.
/// </summary>
internal sealed class AmqpManagement
{
    /// <summary>The node RabbitMQ's management is.</summary>
    public const string Node = "/management";

    // the name the pair shares
    private const string PairName = "bead-management";

    // what a paired link's ATTACH carries in its properties (Link Pairing v1.0 §2)
    private static readonly Symbol Paired = new("paired");

    // the message ids every pair draws from, so that no two requests of a process share one
    private static long _drawn;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, TaskCompletionSource<AmqpManagementAnswer>> _pending = new(StringComparer.Ordinal);
    private readonly Session _session;
    private SenderLink? _sender;
    private ReceiverLink? _receiver;
    private Exception? _ended;

    private AmqpManagement(Session session)
    {
        _session = session;
    }

    /// <summary>The session the pair is on.</summary>
    public Session Session
    {
        get
        {
            return _session;
        }
    }

    /// <summary>
    /// A pair on a session of its own on <paramref name="connection"/>: its session begun, its sender
    /// attached, then its receiver. Its end, or the end of either link, before then fails it naming
    /// why, an <see cref="IOException"/>, its session ended; <paramref name="token"/> gives it up
    /// alike.
    /// </summary>
    public static async Task<AmqpManagement> Open(Connection connection, CancellationToken token)
    {
        var (session, begun) = AmqpEndpoints.Begin(connection);
        var management = new AmqpManagement(session);

        session.AddClosedCallback((_, error) =>
        {
            management.End(new IOException($"its management's session ended: {AmqpEndpoints.ReasonOf(error)}"));
        });

        try
        {
            await begun.WaitAsync(token);

            var sent = AmqpEndpoints.AttachedOf();
            var sender = new SenderLink(session, PairName, AttachOf(isReceiver: false), (_, attach) =>
            {
                sent.TrySetResult(attach);
            });

            management.Watch((sender, sent));
            management._sender = sender;

            if ((await sent.Task.WaitAsync(token)).Target is null)
            {
                throw new IOException($"its broker refused its management's sender: {AmqpEndpoints.ReasonOf(await AmqpEndpoints.EndOf(sender).WaitAsync(token))}");
            }

            // ! one after the other: a paired receiver's ATTACH waits for its sender's answer, so
            // that each link of one name is the peer's to pair, never two in flight at once
            var received = AmqpEndpoints.AttachedOf();
            var receiver = new ReceiverLink(session, PairName, AttachOf(isReceiver: true), (_, attach) =>
            {
                received.TrySetResult(attach);
            });

            management.Watch((receiver, received));
            management._receiver = receiver;

            if ((await received.Task.WaitAsync(token)).Source is null)
            {
                throw new IOException($"its broker refused its management's receiver: {AmqpEndpoints.ReasonOf(await AmqpEndpoints.EndOf(receiver).WaitAsync(token))}");
            }

            receiver.Start(0, management.Answered);

            return management;
        }
        catch
        {
            management.End(new IOException("its management was given up as it opened"));
            AmqpEndpoints.CloseAtOnce(session);

            throw;
        }
    }

    /// <summary>
    /// Asks <c>Method</c> of <c>Path</c> with <paramref name="body"/>, an <c>amqp-value</c>, and
    /// settles with its answer; fails, an <see cref="IOException"/> naming why, once the pair ended
    /// first; <paramref name="token"/> gives it up.
    /// </summary>
    public async Task<AmqpManagementAnswer> Request((string Method, string Path) request, object? body, CancellationToken token)
    {
        var answered = new TaskCompletionSource<AmqpManagementAnswer>(TaskCreationOptions.RunContinuationsAsynchronously);
        var id = Interlocked.Increment(ref _drawn).ToString(CultureInfo.InvariantCulture);
        SenderLink sender;
        ReceiverLink receiver;

        lock (_gate)
        {
            if (_ended is not null)
            {
                throw new IOException(_ended.Message, _ended);
            }

            sender = _sender!;
            receiver = _receiver!;
            _pending[id] = answered;
        }

        try
        {
            // * one credit a request: what comes past it is nothing it asked
            receiver.SetCredit(1, CreditMode.Manual);
            sender.Send(
                new Message
                {
                    Properties = new Properties { MessageId = id, To = request.Path, Subject = request.Method, ReplyTo = "$me" },
                    BodySection = new AmqpValue { Value = body },
                },
                null,
                null,
                null);

            return await answered.Task.WaitAsync(token);
        }
        catch (AmqpException reason)
        {
            throw new IOException($"its management could not ask {request.Method} {request.Path}: {AmqpEndpoints.ReasonOf(reason.Error)}", reason);
        }
        finally
        {
            lock (_gate)
            {
                _pending.Remove(id);
            }
        }
    }

    /// <summary>Ends its session, and with it both links, awaiting its peer's END within <paramref name="bound"/>.</summary>
    public async Task Close(TimeSpan bound)
    {
        End(new IOException("its management ended"));
        await AmqpEndpoints.Ending(_session, bound);
    }

    // a paired link's ATTACH: settled both ways, first, paired, the management node its source and target
    private static Attach AttachOf(bool isReceiver)
    {
        return new Attach
        {
            SndSettleMode = SenderSettleMode.Settled,
            RcvSettleMode = ReceiverSettleMode.First,
            Properties = new Fields { [Paired] = true },
            Source = new Source { Address = Node },
            Target = new Target { Address = Node },
            Role = isReceiver,
        };
    }

    // a link of the pair whose end fails what it waits on and every request under way
    private void Watch((Link Link, TaskCompletionSource<Attach> Attached) watched)
    {
        AmqpEndpoints.FailOnEnd(watched);
        watched.Link.AddClosedCallback((_, error) =>
        {
            End(new IOException($"its management's link was detached: {AmqpEndpoints.ReasonOf(error)}"));
        });
    }

    // an answer, matched to its request by its correlation-id; one of no request under way dropped
    private void Answered(IReceiverLink link, Message message)
    {
        TaskCompletionSource<AmqpManagementAnswer>? answered = null;

        lock (_gate)
        {
            // ! GetCorrelationId, never CorrelationId: the typed accessor throws on an id of another
            // AMQP type, a ulong, a uuid or a binary, which is no request of this pair's and is dropped
            if (_ended is null && message.Properties?.GetCorrelationId() is string correlation)
            {
                _pending.Remove(correlation, out answered);
            }
        }

        if (answered is null)
        {
            // * dropped, its credit given back: the answer its request awaits may still come
            try
            {
                link.SetCredit(1, CreditMode.Manual);
            }
            catch (Exception reason) when (reason is AmqpException or InvalidOperationException or ObjectDisposedException)
            {
                // its pair ended
            }

            return;
        }

        answered.TrySetResult(new AmqpManagementAnswer(message.Properties?.Subject ?? "", message.Body));
    }

    // the pair's end, once: every request under way failed, naming why
    private void End(Exception reason)
    {
        List<TaskCompletionSource<AmqpManagementAnswer>> pending;

        lock (_gate)
        {
            if (_ended is not null)
            {
                return;
            }

            _ended = reason;
            pending = [.. _pending.Values];
            _pending.Clear();
        }

        foreach (var answered in pending)
        {
            answered.TrySetException(new IOException(reason.Message, reason));
        }
    }
}
