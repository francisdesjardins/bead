using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Amqp;
using Amqp.Framing;
using Amqp.Handler;
using Amqp.Sasl;
using Amqp.Types;

namespace Bead.Transport.Amqp;

/// <summary>
/// One link of a participant to a broker of AMQP 1.0 that is RabbitMQ 4 (spec 15.32 to 15.38), over
/// AMQPNetLite, as its participant takes it: one network connection opened anew at each start, its
/// container-id the participant's id, authenticated by SASL PLAIN under its id or by EXTERNAL under
/// a TLS client certificate; on it a session for its inbox's receiver, one for each name it serves,
/// and one for each of its two senders, to inboxes and to names, each to the anonymous terminus; its
/// inbox an exclusive queue declared through its broker's management on that connection, so that it
/// ends with it; each publication one message of the profile, counted to its byte before it goes,
/// held to its sender's credit, <c>released</c> read as no subscriber; each message handed on before
/// its <c>accepted</c>, which goes once its participant settled it, with one more credit. AMQPNetLite
/// reconnects nothing, and nothing of a lost link reaches the next: each incarnation is a connection
/// of its own, every late callback of a former one doing nothing. The TypeScript side's adapter over
/// rhea does the same.
/// </summary>
public sealed class AmqpBrokerAdapter : IBrokerAdapter, IAsyncDisposable
{
    // the sessions a connection holds beside its names': its inbox's, its two senders' and its
    // management's while a request is under way (spec 15.33)
    private const int SessionsBesideNames = 4;

    // an OPEN's idle-time-out its library enforces twice over, within the int of milliseconds it counts in
    private static readonly TimeSpan LongestIdleTimeout = TimeSpan.FromMilliseconds(1_073_741_823);

    private readonly AmqpBrokerAdapterOptions _options;
    private readonly bool _isSecure;
    private readonly Lock _gate = new();
    private Incarnation? _link;

    // what it publishes to inboxes and to names is bounded by, the last link's while down, and none before any
    private long _inboxBound = AmqpMessages.LargestBound;
    private long _namesBound = AmqpMessages.LargestBound;
    private int _unsettled;

    // the links each connection draws, so that no two of one connection share a name
    private int _drawn;

    /// <summary>
    /// An adapter of <see cref="AmqpBrokerAdapterOptions.Id"/> to the broker at
    /// <see cref="AmqpBrokerAdapterOptions.Uri"/>, not yet started. A scheme but <c>amqp</c> or
    /// <c>amqps</c>, a certificate in the clear, or an empty id, is an <see cref="ArgumentException"/>;
    /// a bound or a duration out of its range an <see cref="ArgumentOutOfRangeException"/> naming it.
    /// </summary>
    public AmqpBrokerAdapter(AmqpBrokerAdapterOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Uri, nameof(options));
        ArgumentNullException.ThrowIfNull(options.Id, nameof(options));

        if (options.Uri.Scheme is "ws" or "wss")
        {
            throw new ArgumentException("AMQP 1.0 is carried over TCP or TLS alone: no open-source RabbitMQ 4 carries it over a WebSocket", nameof(options));
        }

        if (options.Uri.Scheme is not ("amqp" or "amqps"))
        {
            throw new ArgumentException($"an AMQP 1.0 broker is reached by amqp or amqps, not {options.Uri.Scheme}", nameof(options));
        }

        if (options.Tls?.ClientCertificates is not null && options.Uri.Scheme != "amqps")
        {
            throw new ArgumentException("a TLS client certificate is carried over amqps, never in the clear", nameof(options));
        }

        if (options.Id.Length == 0)
        {
            throw new ArgumentException("an AMQP adapter's id, its user, is not empty", nameof(options));
        }

        if (options.MaximumMessageSize is < 1 or > AmqpMessages.LargestBound)
        {
            throw new ArgumentOutOfRangeException(nameof(options), string.Create(CultureInfo.InvariantCulture, $"{nameof(AmqpBrokerAdapterOptions.MaximumMessageSize)} is a whole number from 1 to {AmqpMessages.LargestBound}, not {options.MaximumMessageSize}"));
        }

        if (options.LinkCredit < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(options), string.Create(CultureInfo.InvariantCulture, $"{nameof(AmqpBrokerAdapterOptions.LinkCredit)} is a whole number from 1 to {int.MaxValue}, not {options.LinkCredit}"));
        }

        _options = options with
        {
            // ! never without end: a link that counts nothing lost waits on a dead connection forever
            IdleTimeout = Clocks.AssertHeldWithin((nameof(AmqpBrokerAdapterOptions.IdleTimeout), nameof(AmqpBrokerAdapterOptions.IdleTimeout)), (options.IdleTimeout, LongestIdleTimeout)),
            ConnectTimeout = Clocks.AssertHeldFinite((nameof(AmqpBrokerAdapterOptions.ConnectTimeout), nameof(AmqpBrokerAdapterOptions.ConnectTimeout)), options.ConnectTimeout),
        };
        _isSecure = TransportSecurity.IsSecure((options.Uri.Scheme == "amqps", options.Uri.Host));
    }

    /// <inheritdoc/>
    public event Action<BrokerMessage>? Message;

    /// <inheritdoc/>
    public event Action<BrokerDown>? Down;

    /// <summary>Its handles' type, <see cref="TransportTypes.Amqp"/>.</summary>
    public string Type
    {
        get
        {
            return TransportTypes.Amqp;
        }
    }

    /// <inheritdoc/>
    public string Id
    {
        get
        {
            return _options.Id;
        }
    }

    /// <summary>
    /// What AMQP 1.0 on RabbitMQ 4 gives: groups, a name's queue its consumers compete on; a
    /// publication <c>released</c> when no queue takes it, at least once alone; a message's life. No
    /// will: AMQP 1.0 has none (spec 15.32).
    /// </summary>
    public BrokerCapabilities Capabilities
    {
        get
        {
            var capabilities = BrokerCapabilities.Groups | BrokerCapabilities.Expiry;

            if (_options.Delivery == BrokerDelivery.AtLeastOnce)
            {
                capabilities |= BrokerCapabilities.NoSubscriber;
            }

            return capabilities;
        }
    }

    /// <inheritdoc/>
    public BrokerDelivery Delivery
    {
        get
        {
            return _options.Delivery;
        }
    }

    /// <summary>Whether its leg is secure: <c>amqps</c>, or its broker on the loopback, judged as section 13.4 judges a client's URL.</summary>
    public bool IsSecure
    {
        get
        {
            return _isSecure;
        }
    }

    /// <summary>The messages it handed its participant at least once that are not settled yet.</summary>
    public int Unsettled
    {
        get
        {
            return Volatile.Read(ref _unsettled);
        }
    }

    /// <summary>Whether its link is up: its OPEN came and its inbox's receiver attached, and neither stopped nor lost since.</summary>
    public bool IsLinked
    {
        get
        {
            lock (_gate)
            {
                return _link is { IsUp: true, IsEnded: false };
            }
        }
    }

    /// <summary>
    /// The largest payload of a message to <paramref name="topic"/>, its inbox, within its own
    /// <see cref="AmqpBrokerAdapterOptions.MaximumMessageSize"/>, a life counted, whatever the
    /// message, as its publisher writes it (spec 15.37).
    /// </summary>
    public long ReceiveBound(IReadOnlyList<string> topic)
    {
        return AmqpMessages.LargestPayload((AmqpMessages.AddressOf(topic), _options.MaximumMessageSize)) ?? 0;
    }

    /// <summary>
    /// The largest payload of what it publishes to <paramref name="topic"/> within its sender ATTACH's
    /// max-message-size, a life counted, or within 4,294,967,295 bytes where it names none; the last
    /// link's while down (spec 15.37).
    /// </summary>
    public long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        long bound;

        lock (_gate)
        {
            bound = IsInbox(topic) ? _inboxBound : _namesBound;
        }

        return AmqpMessages.LargestPayload((AmqpMessages.AddressOf(topic), bound)) ?? 0;
    }

    /// <summary>
    /// Opens a link anew (spec 15.33): one network connection, its SASL PLAIN under its id or
    /// EXTERNAL under its client certificate, its OPEN of its id as its container-id, its virtual
    /// host as its hostname where it has one and its idle-time-out; then its two sending sessions,
    /// each a sender to the anonymous terminus, whose ATTACH names what it may publish. A will is an
    /// <see cref="ArgumentException"/>: AMQP 1.0 has none. A connection refused or ended, or a sender
    /// refused, before then fails it naming why, an <see cref="IOException"/>; none of it within its connect timeout, a
    /// <see cref="TimeoutException"/>; a link up already, an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Start(BrokerStart? start = null)
    {
        if (start?.Will is not null)
        {
            throw new ArgumentException($"the adapter of {Id} offers no will: AMQP 1.0 has none", nameof(start));
        }

        var link = new Incarnation();

        lock (_gate)
        {
            if (_link is { IsEnded: false })
            {
                throw new InvalidOperationException($"the link of {Id} is up already");
            }

            _link = link;
        }

        var token = start?.CancellationToken ?? CancellationToken.None;

        try
        {
            using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, link.Life.Token);
            Sending parcels;
            Sending opens;

            try
            {
                var password = _options.PasswordProvider is { } provider ? await provider(linked.Token) : _options.Password;

                // ! stopped as it asked its password: no connection is opened
                if (link.IsEnded)
                {
                    throw new IOException($"the link of {Id} stopped as it started");
                }

                link.Connection = await Connected((link, password), linked.Token);
                Watch(link);
                link.Parcels = SenderOf((link, true));
                link.Opens = SenderOf((link, false));

                // * either sender refused fails it at once, whether the other was answered or not
                List<Task<Sending>> attaching = [link.Parcels, link.Opens];

                while (attaching.Count > 0)
                {
                    var answered = await Task.WhenAny(attaching).WaitAsync(linked.Token);

                    attaching.Remove(answered);
                    await answered;
                }

                parcels = await link.Parcels;
                opens = await link.Opens;
            }
            // * the timeout's, whatever its cancel ended after it
            catch (Exception reason) when (timeout.IsCancellationRequested && !token.IsCancellationRequested && !link.IsEnded)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} had no OPEN and sessions within {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
            }
            catch (Exception reason) when (reason is not (OperationCanceledException or IOException) || (reason is OperationCanceledException && !token.IsCancellationRequested))
            {
                throw new IOException(link.Ended?.Message ?? $"the link of {Id} ended before its OPEN and sessions: {reason.Message}", reason);
            }

            lock (_gate)
            {
                // ! lost as it opened: its start fails, and nothing of it reaches the next
                if (link.IsEnded || link.Connection.IsClosed)
                {
                    throw new IOException($"the link of {Id} was lost as it opened");
                }

                link.IsOpen = true;
                _inboxBound = parcels.Bound;
                _namesBound = opens.Bound;
            }
        }
        catch (Exception reason)
        {
            End((link, null), reason);

            throw;
        }
    }

    /// <summary>
    /// Holds a subscription to <paramref name="topic"/> (spec 15.34). Its inbox: declared exclusive,
    /// classic and not durable through its broker's management on its own connection, bound to its
    /// root's exchange by its own name, then read by a receiver on a session of its own; any other
    /// answer, or an end meanwhile, fails it and closes its connection, its inbox ending with it, and
    /// its link is up once its receiver attached. A name: a receiver of its queue on a session of
    /// its own, refused when its ATTACH names no source and a DETACH follows it, when its broker
    /// ends its session, or past its broker's channel-max, naming why, its link kept; one under way,
    /// subscribed again, waited for. Each receiver unsettled, first, of no max-message-size, its
    /// credit its own: its inbox's <see cref="AmqpBrokerAdapterOptions.LinkCredit"/>, a name's 1. A
    /// departure is an <see cref="ArgumentException"/>, the adapter offering no will; a link down,
    /// an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
    {
        ArgumentNullException.ThrowIfNull(topic);

        if (topic is [_, "d", ..])
        {
            throw new ArgumentException($"the adapter of {Id} offers no will, so no departure to read: AMQP 1.0 has none", nameof(topic));
        }

        var link = LinkOpen();
        var token = subscription?.CancellationToken ?? CancellationToken.None;

        token.ThrowIfCancellationRequested();

        if (IsInbox(topic))
        {
            await SubscribeInbox((link, topic), token);

            return;
        }

        await SubscribeName((link, topic), token);
    }

    // * a name: a receiver of its queue on a session of its own; one held, subscribed again, held at
    // once, and one met under way waited for, held once its ATTACH named its source
    private async Task SubscribeName((Incarnation Link, IReadOnlyList<string> Topic) subscribing, CancellationToken token)
    {
        var (link, topic) = subscribing;
        var key = AmqpMessages.TopicOf(topic);
        TaskCompletionSource<Receiving> attached;

        while (true)
        {
            Task<Receiving> pending;
            bool isMet;

            lock (_gate)
            {
                if (link.Names.ContainsKey(key))
                {
                    return;
                }

                if (!link.Pending.TryGetValue(key, out var under))
                {
                    // ! a session each name: one past what its broker's channel-max leaves beside the
                    // inbox's, the senders' and the management's is refused before it begins one
                    if (link.Names.Count + link.Pending.Count + 1 + SessionsBesideNames > link.ChannelMax + 1)
                    {
                        throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker's channel-max, {link.ChannelMax}, leaves the link of {Id} no session for its name {key}: it serves {link.Names.Count} names"));
                    }

                    attached = new TaskCompletionSource<Receiving>(TaskCreationOptions.RunContinuationsAsynchronously);
                    link.LetGo.Remove(key);
                    link.Pending[key] = attached.Task;

                    break;
                }

                pending = under;
                isMet = link.LetGo.Contains(key);
            }

            // ! one an unsubscription met before this came, or one given up, is never held: the name
            // is then subscribed anew; any other's outcome is this one's
            try
            {
                await Asked((link, token), pending);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested && !link.IsEnded)
            {
                continue;
            }
            catch (Exception reason) when (reason is not OutOfMemoryException && isMet && !token.IsCancellationRequested && !link.IsEnded)
            {
                continue;
            }

            if (!isMet)
            {
                return;
            }
        }

        try
        {
            var receiving = await Asked((link, token), ReceiverOf((link, topic, key), token));

            lock (_gate)
            {
                if (link.IsEnded)
                {
                    throw new IOException(link.Ended?.Message ?? $"the link of {Id} went down");
                }

                link.Pending.Remove(key);

                // ! one an unsubscription met as it attached is never held: that unsubscription lets it go
                if (link.LetGo.Contains(key))
                {
                    receiving.IsLetGo = true;
                }
                else
                {
                    link.Names[key] = receiving;
                }
            }

            attached.TrySetResult(receiving);
        }
        catch (Exception reason)
        {
            lock (_gate)
            {
                link.Pending.Remove(key);
            }

            attached.TrySetException(reason);

            throw;
        }
    }

    /// <summary>
    /// Lets the subscription to <paramref name="topic"/> go (spec 15.34). A name's within its connect
    /// timeout: once what it handed on was settled, none handed on after, and its receiver's DETACH
    /// came, its session then ended; past that bound its link is lost, an <see cref="IOException"/>.
    /// A name's subscription under way, once its ATTACH is answered, never held. Its inbox once its
    /// broker's management deleted it, answered 200 within its connect timeout, what comes meanwhile
    /// handed on and credited, its receiver detached with it, which tells no loss; a refusal an
    /// <see cref="IOException"/>, and no answer within it a <see cref="TimeoutException"/>, its inbox
    /// still held. A link down, an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Unsubscribe(IReadOnlyList<string> topic)
    {
        ArgumentNullException.ThrowIfNull(topic);

        var link = LinkOpen();
        var key = AmqpMessages.TopicOf(topic);

        if (IsInbox(topic))
        {
            await UnsubscribeInbox((link, key));

            return;
        }

        Receiving? receiving;
        Task<Receiving>? pending = null;

        lock (_gate)
        {
            link.LetGo.Add(key);

            // * let go as it is asked: none handed on after, and its receiver's end that follows no loss
            if (link.Names.Remove(key, out receiving))
            {
                receiving.IsLetGo = true;
            }
            else
            {
                link.Pending.TryGetValue(key, out pending);
            }
        }

        // * a subscription under way, met: never held, and let go once its ATTACH is answered
        if (pending is not null)
        {
            try
            {
                receiving = await Asked((link, CancellationToken.None), pending);
            }
            catch (Exception reason) when (reason is not OutOfMemoryException && !link.IsEnded)
            {
                // refused or given up: nothing is held to let go
                return;
            }
        }

        if (receiving is not null)
        {
            await LetGo((link, receiving));
        }
    }

    // * a name let go within its connect timeout: its DETACH once what its receiver handed on was
    // settled, then its session ended once its broker answered it; past that bound, its link lost
    private async Task LetGo((Incarnation Link, Receiving Receiving) letting)
    {
        var (link, receiving) = letting;
        using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, link.Life.Token);

        Drain(receiving);

        try
        {
            // ! what it handed on is settled before its DETACH goes: one detached unsettled goes back
            // to its queue, and an OPEN whose connection its server took and has since closed would be
            // answered anew, its pair gone
            await receiving.Drained.WaitAsync(linked.Token);

            var detached = AmqpEndpoints.EndOf(receiving.Receiver!);

            AmqpEndpoints.CloseAtOnce(receiving.Receiver);
            await detached.WaitAsync(linked.Token);
        }
        catch (OperationCanceledException reason) when (!link.IsEnded)
        {
            var lost = new IOException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} was lost: it let the name {receiving.Queue} go within no {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);

            End((link, new BrokerDown()), lost);

            throw lost;
        }
        catch (OperationCanceledException reason)
        {
            throw new IOException(link.Ended?.Message ?? $"the link of {Id} went down", reason);
        }

        AmqpEndpoints.CloseAtOnce(receiving.Session);
        Forget(receiving);
    }

    // * an inbox, deleted by its broker's management within its connect timeout, handing on and
    // crediting what comes meanwhile: its receiver's DETACH that follows is no loss
    private async Task UnsubscribeInbox((Incarnation Link, string Queue) inbox)
    {
        var (link, key) = inbox;
        Receiving? receiving;

        lock (_gate)
        {
            receiving = link.Inbox;

            if (receiving is not null)
            {
                receiving.IsDeleting = true;
            }
        }

        try
        {
            await Deleted((link, key));
        }
        catch
        {
            // * its deletion refused, its inbox still held: its end is its link lost again
            lock (_gate)
            {
                if (receiving is not null)
                {
                    receiving.IsDeleting = false;
                }
            }

            throw;
        }

        lock (_gate)
        {
            if (link.Inbox == receiving)
            {
                link.Inbox = null;
            }
        }

        if (receiving is not null)
        {
            // * its messages end with it: its receiver and its session ended at once, where its broker did not
            AmqpEndpoints.CloseAtOnce(receiving.Receiver);
            AmqpEndpoints.CloseAtOnce(receiving.Session);
            Forget(receiving);
        }
    }

    // an inbox deleted through its broker's management, answered 200 within its connect timeout
    private async Task Deleted((Incarnation Link, string Queue) deleting)
    {
        var (link, key) = deleting;

        using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, link.Life.Token);

        try
        {
            var management = await Asked((link, CancellationToken.None), AmqpManagement.Open(link.Connection!, linked.Token));

            try
            {
                var deleted = await Asked((link, CancellationToken.None), management.Request(("DELETE", $"/queues/{Uri.EscapeDataString(key)}"), null, linked.Token));

                if (deleted.Status != "200")
                {
                    throw new IOException($"its broker refused to delete the inbox {key} of {Id}: {deleted.Said}");
                }
            }
            finally
            {
                await management.Close(_options.ConnectTimeout);
            }
        }
        catch (OperationCanceledException reason) when (timeout.IsCancellationRequested && !link.IsEnded)
        {
            throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the broker of {Id} answered the deletion of {key} within no {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
        }
    }

    /// <summary>
    /// Publishes a parcel as one message of format 0 (spec 15.35): to an inbox on its sender to
    /// inboxes, to a name on its sender to names; unsettled at least once, held to its sender's
    /// credit, later ones waiting in their order, <see cref="BrokerPublished.Taken"/> once
    /// <c>accepted</c>, <see cref="BrokerPublished.NoSubscriber"/> on <c>released</c>, an
    /// <see cref="IOException"/> on <c>rejected</c>, any other outcome, its session's end or its
    /// stop; settled at most once, taken as it goes; its life, in whole milliseconds rounded up, its
    /// header's ttl where one is asked. One past its sender ATTACH's max-message-size is an
    /// <see cref="ArgumentException"/>, nothing sent; a link down, an
    /// <see cref="InvalidOperationException"/>. Given up while it waits for credit, it leaves unsent;
    /// given up once sent, its outcome is not read; either way its link is kept.
    /// </summary>
    public async Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        ArgumentNullException.ThrowIfNull(publication);

        var link = LinkOpen();
        var token = publication.CancellationToken;

        token.ThrowIfCancellationRequested();

        var isInbox = IsInbox(publication.Topic);
        var address = AmqpMessages.AddressOf(publication.Topic);
        var ttl = MillisecondsOf(publication.ExpiresAfter);
        var bytes = AmqpMessages.MessageBytes((Encoding.UTF8.GetByteCount(address), publication.Payload.Length), ttl is not null);
        var sending = await Asked((link, token), SendingOf((link, isInbox)));

        // ! counted before it goes: its broker ends the whole session on a message past its bound,
        // every publication on it with it
        if (bytes > sending.Bound)
        {
            throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a message of {bytes} bytes to {address}, past its sender's max-message-size, {sending.Bound} bytes"), nameof(publication));
        }

        var message = AmqpMessages.MessageOf((address, publication.Payload), ttl);
        var published = new TaskCompletionSource<BrokerPublished>(TaskCreationOptions.RunContinuationsAsynchronously);
        var sender = sending.Sender!;

        try
        {
            sender.Send(message, null, (ended, _, outcome, _) =>
            {
                Read((link, (global::Amqp.Link)ended, address), (outcome, published));
            }, null);
        }
        catch (AmqpException reason)
        {
            throw new IOException($"its broker ended the session of the publications of {Id}: {AmqpEndpoints.ReasonOf(reason.Error)}", reason);
        }

        try
        {
            return await Asked((link, token), published.Task);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            Unsent((sender, message));

            throw;
        }
    }

    /// <summary>
    /// Ends its link with no error (spec 15.33): each receiver detached and its DETACH awaited, each
    /// session ended, then its CLOSE and its broker's, all within its connect timeout; its inbox ends
    /// with its connection. Each publication without an outcome, sent or waiting for credit, and each
    /// subscription awaiting its ATTACH fail with its stop, an <see cref="IOException"/>. Nothing
    /// where it has none.
    /// </summary>
    public async Task Stop()
    {
        Incarnation? link;
        var stopped = new InvalidOperationException($"the link of {Id} stopped");

        lock (_gate)
        {
            link = _link is { IsEnded: false } up ? up : null;

            if (link is not null)
            {
                // ! named before its ends go, which fail what it awaits before its own end
                link.IsStopping = true;
                link.Ended = stopped;
            }
        }

        if (link is null)
        {
            return;
        }

        try
        {
            if (link.Connection is { IsClosed: false } connection)
            {
                List<Receiving> receivings;
                List<Session> sessions = [];

                lock (_gate)
                {
                    receivings = [.. link.Names.Values];

                    if (link.Inbox is { } inbox)
                    {
                        receivings.Insert(0, inbox);
                    }
                }

                await Task.WhenAll(receivings.Select((receiving) =>
                {
                    return AmqpEndpoints.Ending(receiving.Receiver!, _options.ConnectTimeout);
                }));
                sessions.AddRange(receivings.Select((receiving) =>
                {
                    return receiving.Session;
                }));

                sessions.AddRange(SendingSessionsOf(link));

                await Task.WhenAll(sessions.Select((session) =>
                {
                    return AmqpEndpoints.Ending(session, _options.ConnectTimeout);
                }));
                await AmqpEndpoints.Ending(connection, _options.ConnectTimeout);
            }
        }
        finally
        {
            End((link, null), stopped);
        }
    }

    /// <summary>As <see cref="Stop"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Stop();
    }

    /// <summary>
    /// For the tests: awaited once a queue's declaration was answered and before its binding goes,
    /// so that a test loses its link between the two, as no broker can be made to.
    /// </summary>
    internal Func<CancellationToken, Task>? InboxDeclared { get; set; }

    /// <summary>
    /// For the cases' peers in the client role (<c>spec/transports.json</c>): reads <c>Topic</c>
    /// through <c>Queue</c>, a queue of its link's own, exclusive to it and bound to its root's
    /// exchange by the topic, each message handed on as of the topic, so that each such peer reads
    /// every message to it, as each subscriber of a topic over MQTT 5 does, where the participants
    /// that serve a name compete on its queue (spec 15.32).
    /// </summary>
    internal async Task SubscribeThrough((IReadOnlyList<string> Topic, string Queue) through)
    {
        var link = LinkOpen();
        var receiving = await Asked((link, CancellationToken.None), Declared((link, through.Topic, through.Queue), CancellationToken.None));

        lock (_gate)
        {
            link.Names[through.Queue] = receiving;
        }
    }

    // a publication given up: one still waiting for credit leaves the library's queue unsent; one
    // that went is left as it is, its outcome naming its own delivery, so nothing of it reaches another
    private static void Unsent((SenderLink Sender, global::Amqp.Message Message) given)
    {
        var (sender, message) = given;

        // ! a delivery tag is drawn as a transfer goes: none, and it waits still
        if (message.DeliveryTag is not null)
        {
            return;
        }

        try
        {
            sender.Cancel(message);
        }
        catch (Exception reason) when (reason is AmqpException or InvalidOperationException or ObjectDisposedException)
        {
            // ended already
        }
    }

    // an inbox: a participant's topic, its second token i
    private static bool IsInbox(IReadOnlyList<string> topic)
    {
        return topic is [_, "i", _];
    }

    // a life in whole milliseconds, rounded up, 1 at least, within a uint; none when none
    private static uint? MillisecondsOf(TimeSpan? life)
    {
        if (life is not { } given)
        {
            return null;
        }

        var milliseconds = Math.Ceiling(given.TotalMilliseconds);

        return (uint)Math.Clamp(milliseconds, 1, uint.MaxValue);
    }

    // a sender ATTACH's max-message-size as a bound: none, or zero, is no maximum (AMQP 1.0 §2.7.3)
    private static long BoundOf(ulong maximum)
    {
        return maximum is 0 or > AmqpMessages.LargestBound ? AmqpMessages.LargestBound : (long)maximum;
    }

    // a publication's outcome (spec 15.35): accepted taken, released no subscriber, every other
    // refused; one its library gave as its link ended, the end's refusal
    private static void Read((Incarnation Link, global::Amqp.Link Sender, string Address) sent, (Outcome? Outcome, TaskCompletionSource<BrokerPublished> Published) read)
    {
        var (link, sender, address) = sent;
        var (outcome, published) = read;

        // ! none read once its stop began: its library releases what its sessions held as they end,
        // a release no broker gave, so that every publication without an outcome fails with the stop
        if (link.IsStopping)
        {
            published.TrySetException(new IOException(link.Ended?.Message));

            return;
        }

        if (sender.IsClosed)
        {
            published.TrySetException(new IOException($"the session of the publication to {address} ended: {AmqpEndpoints.ReasonOf((outcome as Rejected)?.Error ?? sender.Error)}"));

            return;
        }

        switch (outcome)
        {
            case Accepted:
                published.TrySetResult(BrokerPublished.Taken);

                break;
            case Released:
                published.TrySetResult(BrokerPublished.NoSubscriber);

                break;
            case Rejected rejected:
                published.TrySetException(new IOException($"its broker refused the publication to {address}: rejected, {AmqpEndpoints.ReasonOf(rejected.Error)}"));

                break;
            default:
                published.TrySetException(new IOException($"its broker refused the publication to {address}: {outcome?.Descriptor.Name ?? "no outcome"}"));

                break;
        }
    }

    // a sender begun and not ended since
    private static bool IsHeld(Task<Sending>? held)
    {
        return held is { IsCompletedSuccessfully: true } && !held.GetAwaiter().GetResult().IsEnded;
    }

    // the sessions of an incarnation's senders that began
    private static List<Session> SendingSessionsOf(Incarnation link)
    {
        return [.. new[] { link.Parcels, link.Opens }.Where((sending) =>
        {
            return sending is { IsCompletedSuccessfully: true };
        }).Select((sending) =>
        {
            return sending!.GetAwaiter().GetResult().Session;
        })];
    }

    // the link, open; refused at once while it is down, so that no library holds what is asked
    private Incarnation LinkOpen()
    {
        lock (_gate)
        {
            if (_link is { IsOpen: true, IsEnded: false, IsStopping: false } link && link.Connection is { IsClosed: false })
            {
                return link;
            }
        }

        throw new InvalidOperationException($"the link of {Id} is not up");
    }

    // what a call of a link gives, or why it failed: its link lost, or its own cancel
    private async Task<T> Asked<T>((Incarnation Link, CancellationToken Token) asked, Task<T> call)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(asked.Token, asked.Link.Life.Token);

        try
        {
            return await call.WaitAsync(linked.Token);
        }
        catch (Exception reason) when (asked.Token.IsCancellationRequested)
        {
            throw new OperationCanceledException($"what the link of {Id} was asked was given up", reason, asked.Token);
        }
        catch (Exception reason) when (asked.Link.IsEnded || asked.Link.IsStopping)
        {
            // * its stop's failure, whichever of its ends came first
            throw new IOException(asked.Link.Ended?.Message ?? $"the link of {Id} went down", reason);
        }
        catch (AmqpException reason)
        {
            throw new IOException(AmqpEndpoints.ReasonOf(reason.Error), reason);
        }
    }

    // a connection of its own: its SASL, its OPEN, its idle-time-out its library enforces twice
    // over, nothing of its library's reconnection, which has none
    private async Task<Connection> Connected((Incarnation Link, string? Password) linking, CancellationToken token)
    {
        var (link, password) = linking;
        var uri = _options.Uri;
        var isTls = uri.Scheme == "amqps";
        var certificates = _options.Tls?.ClientCertificates;
        var factory = new ConnectionFactory();

        factory.AMQP.ContainerId = Id;

        // * announced as half of it, so its OPEN's idle-time-out is the option, enforced twice over
        factory.AMQP.IdleTimeout = (int)(_options.IdleTimeout.TotalMilliseconds * 2);

        if (isTls)
        {
            factory.SSL.RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
            {
                return IsTrusted((certificate, errors));
            };

            if (certificates is not null)
            {
                factory.SSL.ClientCertificates.AddRange(certificates);
            }
        }

        // ! under a client certificate and no password, EXTERNAL: its broker maps the certificate to its user
        var isExternal = certificates is not null && password is null;

        if (isExternal)
        {
            factory.SASL.Profile = SaslProfile.External;
        }

        var host = uri.Host.Trim('[', ']');
        var port = uri.IsDefaultPort || uri.Port < 0 ? (isTls ? 5671 : 5672) : uri.Port;
        var address = new Address(host, port, isExternal ? null : Id, isExternal ? null : password ?? "", "/", isTls ? "AMQPS" : "AMQP");
        var opening = factory.CreateAsync(address, token, new Opening((link, _options.VirtualHost), (closing) =>
        {
            // ! its library closing it of its own, its idle-time-out passed or a frame it refused:
            // its link lost at once, though the library tells its end only once its peer answers
            if (!link.IsStopping && !link.IsEnded)
            {
                _ = Task.Run(() =>
                {
                    End((link, new BrokerDown()), new IOException($"the link of {Id} was lost: its library closed it, {AmqpEndpoints.ReasonOf(closing.Error)}"));
                });
            }
        }));

        try
        {
            return await opening.WaitAsync(token);
        }
        catch
        {
            // ! its library's cancel reaches its TCP connect alone: a connection that opens after its
            // start gave up is closed
            _ = opening.ContinueWith(
                (opened) =>
                {
                    AmqpEndpoints.CloseAtOnce(opened.Result);
                },
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnRanToCompletion | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);

            throw;
        }
    }

    // a broker's certificate: the system's judgement, or a chain to the authorities its options trust
    private bool IsTrusted((X509Certificate? Certificate, SslPolicyErrors Errors) presented)
    {
        var (certificate, errors) = presented;

        if (_options.Tls?.TrustChain is not { } trusted)
        {
            return errors == SslPolicyErrors.None;
        }

        if (certificate is null || (errors & (SslPolicyErrors.RemoteCertificateNotAvailable | SslPolicyErrors.RemoteCertificateNameMismatch)) != 0)
        {
            return false;
        }

        using var chain = new X509Chain();
        using var leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());

        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.CustomTrustStore.AddRange(trusted);

        return chain.Build(leaf);
    }

    // its connection's end it did not ask: its link lost
    private void Watch(Incarnation link)
    {
        link.Connection!.AddClosedCallback((_, error) =>
        {
            if (!link.IsStopping)
            {
                End((link, new BrokerDown()), new IOException($"the link of {Id} was lost: {AmqpEndpoints.ReasonOf(error)}"));
            }
        });
    }

    // a sender to the anonymous terminus on a session of its own, to inboxes or to names, once its
    // ATTACH named its target and what it may publish
    private async Task<Sending> SenderOf((Incarnation Link, bool IsInbox) asked)
    {
        var (link, isInbox) = asked;
        var (session, begun) = AmqpEndpoints.Begin(link.Connection!);
        var sending = new Sending(session);

        try
        {
            await begun;

            var attached = AmqpEndpoints.AttachedOf();
            var sender = new SenderLink(
                session,
                string.Create(CultureInfo.InvariantCulture, $"{(isInbox ? "parcels" : "opens")}-{Interlocked.Increment(ref _drawn)}"),
                new Attach
                {
                    SndSettleMode = _options.Delivery == BrokerDelivery.AtLeastOnce ? SenderSettleMode.Unsettled : SenderSettleMode.Settled,
                    RcvSettleMode = ReceiverSettleMode.First,
                    Source = new Source(),

                    // * the anonymous terminus: each message's to its destination
                    Target = new Target(),
                },
                (_, attach) =>
                {
                    attached.TrySetResult(attach);
                });

            sending.Sender = sender;
            AmqpEndpoints.FailOnEnd((sender, attached));

            var attach = await attached.Task;

            if (attach.Target is null)
            {
                throw new IOException($"its broker refused the sender of {Id}: {AmqpEndpoints.ReasonOf(await AmqpEndpoints.EndOf(sender))}");
            }

            sending.Bound = BoundOf(attach.MaxMessageSize);

            return sending;
        }
        catch
        {
            AmqpEndpoints.CloseAtOnce(session);

            throw;
        }
    }

    // the sender a publication goes on: the one held, or, once it ended, another begun for it
    private Task<Sending> SendingOf((Incarnation Link, bool IsInbox) asked)
    {
        var (link, isInbox) = asked;

        lock (_gate)
        {
            var held = isInbox ? link.Parcels : link.Opens;

            if (held is not null && (!held.IsCompleted || IsHeld(held)))
            {
                return held;
            }

            // * a sending session that ended refused what it held, its link kept: the next begins another
            var begun = SenderOf(asked);

            if (isInbox)
            {
                link.Parcels = begun;
            }
            else
            {
                link.Opens = begun;
            }

            return begun;
        }
    }

    // its inbox declared, bound and read, within its connect timeout; any failure closes its
    // connection, its inbox, exclusive to it, ending with it
    private async Task SubscribeInbox((Incarnation Link, IReadOnlyList<string> Topic) inbox, CancellationToken token)
    {
        var (link, topic) = inbox;

        try
        {
            var receiving = await Declared((link, topic, AmqpMessages.TopicOf(topic)), token);

            lock (_gate)
            {
                if (link.IsEnded)
                {
                    throw new IOException(link.Ended?.Message ?? $"the link of {Id} went down");
                }

                link.Inbox = receiving;
                link.IsUp = true;
            }
        }
        catch (Exception reason)
        {
            End((link, null), reason);

            throw;
        }
    }

    // a queue of its connection's own declared, exclusive, classic and not durable, through its
    // broker's management on that connection, bound to its root's exchange by its topic, then read,
    // within its connect timeout
    private async Task<Receiving> Declared((Incarnation Link, IReadOnlyList<string> Topic, string Queue) declared, CancellationToken token)
    {
        var (link, topic, queue) = declared;
        using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, link.Life.Token);

        try
        {
            var management = await AmqpManagement.Open(link.Connection!, linked.Token);

            try
            {
                var answer = await management.Request(
                    ("PUT", $"/queues/{Uri.EscapeDataString(queue)}"),
                    new Map { ["durable"] = false, ["exclusive"] = true, ["auto_delete"] = false, ["arguments"] = new Map { ["x-queue-type"] = "classic" } },
                    linked.Token);

                // * 400 where another connection of its id holds the inbox: the earlier keeps it
                if (answer.Status is not ("200" or "201"))
                {
                    throw new IOException($"its broker refused to declare the queue {queue} of {Id}: {answer.Said}");
                }

                if (InboxDeclared is { } isDeclared)
                {
                    await isDeclared(linked.Token);
                }

                var bound = await management.Request(
                    ("POST", "/bindings"),
                    new Map { ["source"] = topic[0], ["destination_queue"] = queue, ["binding_key"] = AmqpMessages.TopicOf(topic), ["arguments"] = new Map() },
                    linked.Token);

                if (bound.Status != "204")
                {
                    throw new IOException($"its broker refused to bind the queue {queue} of {Id}: {bound.Said}");
                }
            }
            finally
            {
                await management.Close(_options.ConnectTimeout);
            }

            return await ReceiverOf((link, topic, queue), linked.Token);
        }
        catch (Exception reason) when (link.IsStopping)
        {
            // * its stop's failure, whichever of its ends came first
            throw new IOException(link.Ended?.Message, reason);
        }
        catch (Exception reason) when (timeout.IsCancellationRequested && !token.IsCancellationRequested && !link.IsEnded)
        {
            throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} had no queue {queue} within {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
        }
        catch (Exception reason) when (token.IsCancellationRequested)
        {
            throw new OperationCanceledException($"the queue {queue} of {Id} was given up", reason, token);
        }
        catch (Exception reason) when (reason is not IOException)
        {
            throw new IOException(link.Ended?.Message ?? $"the queue {queue} of {Id} was refused: {reason.Message}", reason);
        }
    }

    // a receiver of a topic's queue on a session of its own, held once its ATTACH named its source
    // and its credit went; its session ended where it is refused or given up
    private async Task<Receiving> ReceiverOf((Incarnation Link, IReadOnlyList<string> Topic, string Queue) asked, CancellationToken token)
    {
        var (link, topic, name) = asked;
        var (session, begun) = AmqpEndpoints.Begin(link.Connection!);
        var isOwn = name == AmqpMessages.TopicOf(topic);
        var receiving = new Receiving((topic, name), session) { IsInbox = IsInbox(topic) && isOwn, IsServed = !IsInbox(topic) && isOwn, Bound = ReceiveBound(topic) };
        var queue = AmqpMessages.QueueAddressOf(name);

        try
        {
            await begun.WaitAsync(token);

            var attached = AmqpEndpoints.AttachedOf();
            var receiver = new ReceiverLink(
                session,
                string.Create(CultureInfo.InvariantCulture, $"{(receiving.IsInbox ? "inbox" : "name")}-{Interlocked.Increment(ref _drawn)}"),
                new Attach
                {
                    Source = new Source { Address = queue },
                    Target = new Target(),
                    SndSettleMode = _options.Delivery == BrokerDelivery.AtLeastOnce ? SenderSettleMode.Unsettled : SenderSettleMode.Settled,

                    // ! no max-message-size: its broker ends a receiver's session past it, and every
                    // participant may write every inbox (spec 15.34)
                    RcvSettleMode = ReceiverSettleMode.First,
                },
                (_, attach) =>
                {
                    attached.TrySetResult(attach);
                });

            receiving.Receiver = receiver;
            AmqpEndpoints.FailOnEnd((receiver, attached));

            var attach = await attached.Task.WaitAsync(token);

            if (attach.Source is null)
            {
                throw new IOException($"its broker refused the subscription of {Id} to {queue}: {AmqpEndpoints.ReasonOf(await AmqpEndpoints.EndOf(receiver).WaitAsync(token))}");
            }

            // * its credit its own: none restored by the library, one more as each message is settled;
            // a served name's 1, so that its queue hands a member one OPEN at a time, the others
            // waiting there for whichever member reads next (AMQP 1.0 §2.6.7)
            receiver.Start(0, (_, message) =>
            {
                Take((link, receiving), message);
            });
            receiver.SetCredit(receiving.IsServed ? 1 : _options.LinkCredit, CreditMode.Manual);
            session.AddClosedCallback((_, error) =>
            {
                Lost((link, receiving), $"its session ended: {AmqpEndpoints.ReasonOf(error)}");
            });
            receiver.AddClosedCallback((_, error) =>
            {
                Lost((link, receiving), $"it was detached: {AmqpEndpoints.ReasonOf(error)}");
            });

            return receiving;
        }
        catch (Exception reason)
        {
            AmqpEndpoints.CloseAtOnce(session);

            if (reason is AmqpException amqp)
            {
                throw new IOException($"its broker refused the subscription of {Id} to {queue}: {AmqpEndpoints.ReasonOf(amqp.Error)}", reason);
            }

            if (reason is IOException && !reason.Message.StartsWith("its broker refused", StringComparison.Ordinal))
            {
                throw new IOException($"its broker refused the subscription of {Id} to {queue}: {reason.Message}", reason);
            }

            throw;
        }
    }

    // a receiver's end it did not ask: its inbox's, its link lost; a held name's, attached again
    // once on a fresh session, and its link lost where that is refused or the name is lost again
    private void Lost((Incarnation Link, Receiving Receiving) lost, string reason)
    {
        var (link, receiving) = lost;
        bool isLinkLost;

        lock (_gate)
        {
            if (link.IsEnded || link.IsStopping || receiving.IsEnded)
            {
                return;
            }

            receiving.IsEnded = true;
            Interlocked.Add(ref _unsettled, -receiving.Unsettled);
            receiving.Unsettled = 0;
            receiving.Settled.TrySetResult();

            if (receiving.IsLetGo || receiving.IsDeleting)
            {
                return;
            }

            var key = receiving.Queue;

            if (receiving.IsInbox)
            {
                isLinkLost = true;
            }
            else
            {
                link.Names.Remove(key);
                link.Losses[key] = link.Losses.GetValueOrDefault(key) + 1;
                isLinkLost = link.Losses[key] > 1;
            }
        }

        AmqpEndpoints.CloseAtOnce(receiving.Session);

        if (isLinkLost)
        {
            End((link, new BrokerDown()), new IOException(receiving.IsInbox ? $"the link of {Id} lost its inbox: {reason}" : $"the link of {Id} lost its name {receiving.Queue} again: {reason}"));

            return;
        }

        _ = Reattach((link, receiving.Topic, receiving.Queue));
    }

    // a held name's receiver attached again, once, in place, on a fresh session, its core told nothing
    private async Task Reattach((Incarnation Link, IReadOnlyList<string> Topic, string Queue) lost)
    {
        var (link, topic, key) = lost;

        try
        {
            using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, link.Life.Token);
            var again = await ReceiverOf((link, topic, key), linked.Token);
            bool isLetGo;

            lock (_gate)
            {
                // ! a name let go meanwhile is never attached again
                isLetGo = link.IsEnded || link.LetGo.Contains(key);

                if (!isLetGo)
                {
                    link.Names[key] = again;
                }
                else
                {
                    again.IsLetGo = true;
                }
            }

            if (isLetGo)
            {
                AmqpEndpoints.CloseAtOnce(again.Session);
            }
        }
        catch (Exception reason) when (reason is not OutOfMemoryException)
        {
            bool isLetGo;

            lock (_gate)
            {
                isLetGo = link.LetGo.Contains(key);
            }

            if (!isLetGo)
            {
                End((link, new BrokerDown()), new IOException($"the link of {Id} could not attach its name {key} again: {reason.Message}", reason));
            }
        }
    }

    // a receiver let go: what it held unsettled counted no more
    private void Forget(Receiving receiving)
    {
        lock (_gate)
        {
            receiving.IsEnded = true;
            Interlocked.Add(ref _unsettled, -receiving.Unsettled);
            receiving.Unsettled = 0;
        }

        receiving.Settled.TrySetResult();
    }

    // a message received, handed on before its accepted, which its participant's settle sends, once,
    // on the receiver it came on alone; one whose body is other than one Data section, or whose
    // payload passes its receive bound, handed on as no parcel
    private void Take((Incarnation Link, Receiving Receiving) taken, global::Amqp.Message message)
    {
        var (link, receiving) = taken;
        var isAcknowledged = _options.Delivery == BrokerDelivery.AtLeastOnce;

        lock (_gate)
        {
            // * none handed on once let go, or once an unsubscription met it as it attached: unsettled,
            // it goes back to its queue
            if (link.IsEnded || receiving.IsEnded || receiving.IsLetGo || (receiving.IsServed && link.LetGo.Contains(receiving.Queue)))
            {
                return;
            }

            if (isAcknowledged)
            {
                receiving.Unsettled += 1;
                Interlocked.Increment(ref _unsettled);
            }
        }

        var payload = message.BodySection is Data data && data.GetType() == typeof(Data) ? data.Binary : null;

        if (payload is null || payload.LongLength > receiving.Bound)
        {
            payload = [];
        }

        Message?.Invoke(new BrokerMessage(
            new BrokerPublication { Topic = receiving.Topic, Payload = payload },
            new BrokerMessageOptions
            {
                Settle = () =>
                {
                    Settle((link, receiving), (message, isAcknowledged));
                },
            }));
    }

    // a message settled accepted, never released or modified, and one more credit on its receiver
    private void Settle((Incarnation Link, Receiving Receiving) settled, (global::Amqp.Message Message, bool IsAcknowledged) message)
    {
        var (link, receiving) = settled;

        lock (_gate)
        {
            // ! a message of a lost receiver is never settled on its successor
            if (link.IsEnded || receiving.IsEnded)
            {
                return;
            }

            if (message.IsAcknowledged)
            {
                receiving.Unsettled -= 1;
                Interlocked.Decrement(ref _unsettled);
            }
        }

        try
        {
            if (message.IsAcknowledged)
            {
                receiving.Receiver!.Accept(message.Message);
            }

            if (!receiving.IsLetGo)
            {
                receiving.Receiver!.SetCredit(1, CreditMode.Manual);
            }
        }
        catch (Exception reason) when (reason is AmqpException or InvalidOperationException or ObjectDisposedException)
        {
            // its receiver's end tells what failed
        }
        finally
        {
            Drain(receiving);
        }
    }

    // a receiver let go whose every message handed on was settled: its DETACH may go
    private void Drain(Receiving receiving)
    {
        bool isDrained;

        lock (_gate)
        {
            isDrained = receiving.IsLetGo && (receiving.Unsettled == 0 || receiving.IsEnded);
        }

        if (isDrained)
        {
            receiving.Settled.TrySetResult();
        }
    }

    // an incarnation's end, once: told down where it was up, then what it awaits failed, and its
    // connection closed, its inbox ending with it
    private void End((Incarnation Link, BrokerDown? Down) ending, Exception reason)
    {
        var (link, down) = ending;
        bool wasUp;

        lock (_gate)
        {
            if (link.IsEnded)
            {
                return;
            }

            link.IsEnded = true;
            link.Ended ??= reason;
            wasUp = link.IsUp;

            if (_link == link)
            {
                _link = null;
            }

            Interlocked.Exchange(ref _unsettled, 0);
        }

        // * told first, so that its participant hears its link down before what failed of it
        if (wasUp && down is not null && !link.IsStopping)
        {
            Down?.Invoke(down);
        }

        try
        {
            link.Life.Cancel();
        }
        catch (AggregateException)
        {
            // a registration's throw: what it cancelled ended all the same
        }

        AmqpEndpoints.CloseAtOnce(link.Connection);
    }

    // what its library tells of its connection: its OPEN's hostname its virtual host's alone, its
    // broker's channel-max read, and a CLOSE it sends of its own
    private sealed class Opening((Incarnation Link, string? VirtualHost) opening, Action<Close> closing) : IHandler
    {
        public bool CanHandle(EventId id)
        {
            return id is EventId.ConnectionLocalOpen or EventId.ConnectionRemoteOpen or EventId.ConnectionLocalClose;
        }

        public void Handle(Event protocolEvent)
        {
            if (protocolEvent.Context is Close close)
            {
                closing(close);

                return;
            }

            if (protocolEvent.Context is not Open open)
            {
                return;
            }

            if (protocolEvent.Id == EventId.ConnectionLocalOpen)
            {
                // * its broker's default virtual host where it names none (RabbitMQ 4: hostname vhost:…)
                open.HostName = opening.VirtualHost is { } virtualHost ? $"vhost:{virtualHost}" : null;
            }
            else
            {
                opening.Link.ChannelMax = open.ChannelMax;
            }
        }
    }

    // a sending session and its sender, and what its ATTACH lets it publish
    private sealed class Sending(Session session)
    {
        public Session Session { get; } = session;

        public SenderLink? Sender { get; set; }

        public long Bound { get; set; } = AmqpMessages.LargestBound;

        public bool IsEnded
        {
            get
            {
                return Session.IsClosed || Sender is null || Sender.IsClosed;
            }
        }
    }

    // a receiving session and its receiver: the topic it reads, its receive bound, and what it handed on unsettled
    private sealed class Receiving((IReadOnlyList<string> Topic, string Queue) read, Session session)
    {
        public IReadOnlyList<string> Topic { get; } = read.Topic;

        public string Queue { get; } = read.Queue;

        public Session Session { get; } = session;

        public ReceiverLink? Receiver { get; set; }

        public long Bound { get; init; }

        public bool IsInbox { get; init; }

        // a name it serves, read from the name's own queue, whose members compete on it
        public bool IsServed { get; init; }

        public int Unsettled { get; set; }

        public bool IsEnded { get; set; }

        // a name let go as asked: none handed on or credited after, and its end no loss
        public bool IsLetGo { get; set; }

        // an inbox's deletion under way, or done: its receiver's end that follows is no loss
        public bool IsDeleting { get; set; }

        // settles once it is let go and every message it handed on was settled, or it ended
        public TaskCompletionSource Settled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Drained
        {
            get
            {
                return Settled.Task;
            }
        }
    }

    // one incarnation: its connection, what ends with it, its sessions and receivers, and its names
    private sealed class Incarnation
    {
        public CancellationTokenSource Life { get; } = new();

        public Connection? Connection { get; set; }

        public int ChannelMax { get; set; } = ushort.MaxValue;

        public Task<Sending>? Parcels { get; set; }

        public Task<Sending>? Opens { get; set; }

        public Receiving? Inbox { get; set; }

        public Dictionary<string, Receiving> Names { get; } = new(StringComparer.Ordinal);

        // each name's subscription under way, until its ATTACH is answered
        public Dictionary<string, Task<Receiving>> Pending { get; } = new(StringComparer.Ordinal);

        public HashSet<string> LetGo { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, int> Losses { get; } = new(StringComparer.Ordinal);

        public bool IsOpen { get; set; }

        public bool IsUp { get; set; }

        public bool IsEnded { get; set; }

        public bool IsStopping { get; set; }

        public Exception? Ended { get; set; }
    }
}
