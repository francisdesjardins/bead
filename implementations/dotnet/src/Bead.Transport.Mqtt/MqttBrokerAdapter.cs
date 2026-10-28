using System.Buffers;
using System.Globalization;
using System.Text;
using MQTTnet;
using MQTTnet.Diagnostics.PacketInspection;
using MQTTnet.Exceptions;
using MQTTnet.Formatter;
using MQTTnet.Protocol;

namespace Bead.Transport.Mqtt;

/// <summary>
/// One link of a participant to a broker of MQTT 5 (spec 15.25 to 15.31), over MQTTnet, as its
/// participant takes it: a network connection that keeps no session, its Client Identifier the
/// participant's id, authenticated by a Password under its id or by a TLS client certificate; a
/// subscription of QoS 1 and Retain Handling 2 for each topic, a name in a group as its shared
/// subscription; a publication of QoS 1, RETAIN 0, counted to its byte before it goes and held to
/// its CONNACK's Receive Maximum, its PUBACK's 0x10 read as no subscriber; each message handed on
/// before its PUBACK, which goes once its participant settled it; a will of its GONE; a DISCONNECT of
/// 0x00 at a stop, and one of 0x8E read as its link taken over. MQTTnet's automation is off: no
/// reconnection, resubscription, offline queue or alias; each incarnation is a client of its own,
/// every late callback of a former one doing nothing. The TypeScript side's adapter over MQTT.js
/// does the same.
/// </summary>
public sealed class MqttBrokerAdapter : IBrokerAdapter, IAsyncDisposable
{
    // ! MQTTnet bounds its transport's close by its Timeout and awaits it before it tells the link
    // down; every call it is given carries a token of its own, so this bounds that close alone
    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(1);

    // a CONNECT's Keep Alive, a Two Byte Integer of seconds (MQTT 5.0 §3.1.2.10)
    private static readonly TimeSpan LongestKeepAlive = TimeSpan.FromSeconds(ushort.MaxValue);

    // how often a Server Keep Alive shorter than its own is looked at, as MQTTnet looks at its own
    private static readonly TimeSpan PingCheck = TimeSpan.FromMilliseconds(250);

    private readonly MqttBrokerAdapterOptions _options;
    private readonly bool _isSecure;
    private readonly Lock _gate = new();
    private Link? _link;

    // what it publishes is bounded by, the last link's while down, and the protocol's before any
    private long _publicationBound = MqttPackets.LargestPacketSize;
    private int _unsettled;

    /// <summary>
    /// An adapter of <see cref="MqttBrokerAdapterOptions.Id"/> to the broker at
    /// <see cref="MqttBrokerAdapterOptions.Uri"/>, not yet started. A scheme but <c>mqtt</c>,
    /// <c>mqtts</c>, <c>ws</c> or <c>wss</c>, or an empty id, is an <see cref="ArgumentException"/>;
    /// a bound or a duration out of its range an <see cref="ArgumentOutOfRangeException"/> naming it.
    /// </summary>
    public MqttBrokerAdapter(MqttBrokerAdapterOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(options.Uri, nameof(options));
        ArgumentNullException.ThrowIfNull(options.Id, nameof(options));

        if (options.Uri.Scheme is not ("mqtt" or "mqtts" or "ws" or "wss"))
        {
            throw new ArgumentException($"an MQTT broker is reached by mqtt, mqtts, ws or wss, not {options.Uri.Scheme}", nameof(options));
        }

        if (options.Tls?.ClientCertificates is not null && options.Uri.Scheme is not ("mqtts" or "wss"))
        {
            throw new ArgumentException("a TLS client certificate is carried over mqtts or wss, never in the clear", nameof(options));
        }

        if (options.Id.Length == 0)
        {
            throw new ArgumentException("an MQTT adapter's id, its Client Identifier, is not empty", nameof(options));
        }

        AssertPacketSize((nameof(MqttBrokerAdapterOptions.MaximumPacketSize), options.MaximumPacketSize));

        _options = options with
        {
            // ! never without end: a broker never counts a link of Keep Alive 0 lost, and its will never goes
            KeepAlive = Clocks.AssertHeldWithin((nameof(MqttBrokerAdapterOptions.KeepAlive), nameof(MqttBrokerAdapterOptions.KeepAlive)), (options.KeepAlive, LongestKeepAlive)),
            ConnectTimeout = Clocks.AssertHeldFinite((nameof(MqttBrokerAdapterOptions.ConnectTimeout), nameof(MqttBrokerAdapterOptions.ConnectTimeout)), options.ConnectTimeout),
        };
        _isSecure = TransportSecurity.IsSecure((options.Uri.Scheme is "mqtts" or "wss", options.Uri.Host));
    }

    /// <inheritdoc/>
    public event Action<BrokerMessage>? Message;

    /// <inheritdoc/>
    public event Action<BrokerDown>? Down;

    /// <summary>Its handles' type, <see cref="TransportTypes.Mqtt"/>.</summary>
    public string Type
    {
        get
        {
            return TransportTypes.Mqtt;
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
    /// What MQTT 5 gives: groups, unless its options say its broker offers none; a will; a
    /// publication refused when no subscriber takes it, PUBACK 0x10, at least once alone; a message's life.
    /// </summary>
    public BrokerCapabilities Capabilities
    {
        get
        {
            var capabilities = BrokerCapabilities.Will | BrokerCapabilities.Expiry;

            if (_options.Groups)
            {
                capabilities |= BrokerCapabilities.Groups;
            }

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

    /// <summary>Whether its leg is secure: <c>mqtts</c> or <c>wss</c>, or its broker on the loopback, judged as section 13.4 judges a client's URL.</summary>
    public bool IsSecure
    {
        get
        {
            return _isSecure;
        }
    }

    /// <summary>The messages it handed its participant at least once that are not acknowledged yet.</summary>
    public int Unsettled
    {
        get
        {
            return Volatile.Read(ref _unsettled);
        }
    }

    /// <summary>Whether its link is up: its CONNACK read, and neither stopped nor lost since.</summary>
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
    /// Maximum Packet Size, a life counted, whatever the message: what its broker may forward it
    /// with what is left of one (spec 15.30).
    /// </summary>
    public long ReceiveBound(IReadOnlyList<string> topic)
    {
        return MqttPackets.LargestPayload((MqttPackets.TopicOf(topic), _options.MaximumPacketSize), new MqttPublishShape(1, true)) ?? 0;
    }

    /// <summary>
    /// The largest payload of what it publishes to <paramref name="topic"/> within its CONNACK's
    /// Maximum Packet Size, a life counted, or within 268,435,460 bytes where it names none; the last
    /// link's while down (spec 15.30).
    /// </summary>
    public long MaximumPayloadBytes(IReadOnlyList<string> topic)
    {
        long bound;

        lock (_gate)
        {
            bound = _link is { IsUp: true, IsEnded: false } link ? link.PublicationBound : _publicationBound;
        }

        return MqttPackets.LargestPayload((MqttPackets.TopicOf(topic), bound), new MqttPublishShape(QosOf(_options.Delivery), true)) ?? 0;
    }

    /// <summary>
    /// Connects a link that keeps no session (spec 15.26): its CONNECT of Protocol Version 5, Clean
    /// Start 1, Session Expiry 0, Receive Maximum 65,535, Topic Alias Maximum 0, its Maximum Packet
    /// Size and its Keep Alive, its will the GONE given, of QoS 1, RETAIN 0 and Will Delay 0; settles
    /// once its CONNACK said 0x00. A CONNACK of any other code, or of Maximum QoS 0, fails it naming
    /// it, a <see cref="IOException"/>; none within its connect timeout, a <see cref="TimeoutException"/>;
    /// a link up already, an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Start(BrokerStart? start = null)
    {
        var client = new MqttClientFactory().CreateMqttClient();
        var link = new Link(client);

        lock (_gate)
        {
            if (_link is { IsEnded: false })
            {
                client.Dispose();

                throw new InvalidOperationException($"the link of {Id} is up already");
            }

            _link = link;
        }

        Listen(link);

        var token = start?.CancellationToken ?? CancellationToken.None;

        try
        {
            using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, link.Life.Token);
            var password = _options.PasswordProvider is { } provider ? await provider(linked.Token) : _options.Password;

            // ! stopped as it asked its password: no CONNECT goes
            if (link.IsEnded)
            {
                throw new IOException($"the link of {Id} stopped as it started");
            }

            MqttClientConnectResult connected;

            try
            {
                connected = await client.ConnectAsync(OptionsOf((start?.Will, password)), linked.Token);
            }
            // * the timeout's, whatever its cancel ended after it: MQTTnet tells the link down as it gives up
            catch (Exception reason) when (timeout.IsCancellationRequested && !token.IsCancellationRequested)
            {
                throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} had no CONNACK within {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
            }
            catch (Exception reason) when (reason is not OperationCanceledException || !token.IsCancellationRequested)
            {
                throw new IOException($"the link of {Id} ended before its CONNACK: {reason.Message}", reason);
            }

            if (connected.ResultCode != MqttClientConnectResultCode.Success)
            {
                throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused the link of {Id}: CONNACK 0x{(int)connected.ResultCode:X2}, {connected.ResultCode}"));
            }

            // * subscriptions of QoS 1 and a will of QoS 1: a broker of Maximum QoS 0 carries neither
            if (connected.MaximumQoS == MqttQualityOfServiceLevel.AtMostOnce)
            {
                await Quietly(client.DisconnectAsync(new MqttClientDisconnectOptionsBuilder().WithReason(MqttClientDisconnectOptionsReason.NormalDisconnection).Build(), linked.Token));

                throw new IOException($"its broker's CONNACK gives the link of {Id} a Maximum QoS 0, and Bead's subscriptions and will are of QoS 1");
            }

            lock (_gate)
            {
                // ! lost as it connected: its start fails, and nothing of it reaches the next
                if (link.IsEnded || !client.IsConnected)
                {
                    throw new IOException($"the link of {Id} was lost as it connected");
                }

                link.Quota = new MqttSendQuota(connected.ReceiveMaximum is > 0 and var receiveMaximum ? receiveMaximum : ushort.MaxValue);
                link.PublicationBound = connected.MaximumPacketSize is > 0 and var maximum ? Math.Min(maximum, MqttPackets.LargestPacketSize) : MqttPackets.LargestPacketSize;
                link.IsSharedAvailable = connected.SharedSubscriptionAvailable;
                link.IsUp = true;
                _publicationBound = link.PublicationBound;
            }

            KeepServerKeepAlive((link, connected.ServerKeepAlive));
        }
        catch (Exception reason)
        {
            End((link, null), reason);

            throw;
        }
    }

    /// <summary>
    /// Holds a subscription to <paramref name="topic"/> of QoS 1, No Local 0, Retain As Published 0
    /// and Retain Handling 2, a group's as its shared subscription; settles once its SUBACK granted
    /// QoS 1, and fails on any other code, QoS 0 among them (spec 15.27). A group its broker offers
    /// none of is refused, naming why; a link down, an <see cref="InvalidOperationException"/>.
    /// </summary>
    public async Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
    {
        var group = subscription?.Group;

        // ! a group its options say its broker offers none of is a programmer's error, one its
        // broker said it offers none of, the broker's word
        if (group is not null && !_options.Groups)
        {
            throw new ArgumentException($"the adapter of {Id} offers no groups: its options say its broker offers no shared subscription", nameof(subscription));
        }

        var link = LinkUp();
        var token = subscription?.CancellationToken ?? CancellationToken.None;

        token.ThrowIfCancellationRequested();

        if (group is not null && !link.IsSharedAvailable)
        {
            throw new IOException($"the broker of {Id} offers no shared subscription: its CONNACK or a SUBACK said so");
        }

        var filter = group is null ? MqttPackets.TopicOf(topic) : MqttPackets.GroupFilterOf((group, topic));
        var asked = new MqttClientSubscribeOptionsBuilder().WithTopicFilter(new MqttTopicFilterBuilder()
            .WithTopic(filter)
            .WithAtLeastOnceQoS()
            .WithNoLocal(false)
            .WithRetainAsPublished(false)
            .WithRetainHandling(MqttRetainHandling.DoNotSendOnSubscribe)
            .Build()).Build();
        MqttClientSubscribeResult subscribed;

        // ! given up once its packet may have gone: its link retired, so nothing it asked enters another
        using (token.Register(() =>
        {
            Retire(link);
        }))
        {
            subscribed = await Asked((link, token), link.Client.SubscribeAsync(asked, link.Life.Token));
        }

        var code = subscribed.Items.Single().ResultCode;

        if (code == MqttClientSubscribeResultCode.GrantedQoS1)
        {
            lock (_gate)
            {
                link.Filters[MqttPackets.TopicOf(topic)] = filter;
            }

            return;
        }

        if (code == MqttClientSubscribeResultCode.SharedSubscriptionsNotSupported)
        {
            link.IsSharedAvailable = false;
        }

        throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused the subscription of {Id} to {filter}: SUBACK 0x{(int)code:X2}"));
    }

    /// <summary>
    /// Lets the subscription to <paramref name="topic"/> go, by the filter its SUBSCRIBE named, or the
    /// topic itself where it held none; settles once its UNSUBACK came of 0x00, or 0x11 where its
    /// broker held none, and fails on 0x80 or more, an <see cref="IOException"/> naming it.
    /// </summary>
    public async Task Unsubscribe(IReadOnlyList<string> topic)
    {
        var link = LinkUp();
        string filter;

        lock (_gate)
        {
            filter = link.Filters.Remove(MqttPackets.TopicOf(topic), out var named) ? named : MqttPackets.TopicOf(topic);
        }

        var left = await Asked((link, CancellationToken.None), link.Client.UnsubscribeAsync(new MqttClientUnsubscribeOptionsBuilder().WithTopicFilter(filter).Build(), link.Life.Token));
        var code = left.Items.Single().ResultCode;

        if (code is not (MqttClientUnsubscribeResultCode.Success or MqttClientUnsubscribeResultCode.NoSubscriptionExisted))
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused to let the subscription of {Id} to {filter} go: UNSUBACK 0x{(int)code:X2}"));
        }
    }

    /// <summary>
    /// Publishes a parcel in one PUBLISH (spec 15.28): of QoS 1 at least once, held to its CONNACK's
    /// Receive Maximum, later ones waiting in their order, <see cref="BrokerPublished.Taken"/> once
    /// its PUBACK came under 0x80 but 0x10, <see cref="BrokerPublished.NoSubscriber"/> on 0x10, an
    /// <see cref="IOException"/> on 0x80 or more; of QoS 0 at most once, taken as it goes; RETAIN 0,
    /// its life in whole seconds rounded up where one is asked, no other property. One whose packet
    /// would pass its CONNACK's Maximum Packet Size is an <see cref="ArgumentException"/>, nothing
    /// sent; a link down, an <see cref="InvalidOperationException"/>. Given up while it waits for the
    /// quota, it leaves unsent, its link kept; given up once sent, its link is retired.
    /// </summary>
    public async Task<BrokerPublished> Publish(BrokerPublication publication)
    {
        ArgumentNullException.ThrowIfNull(publication);

        var link = LinkUp();
        var token = publication.CancellationToken;

        token.ThrowIfCancellationRequested();

        var topic = MqttPackets.TopicOf(publication.Topic);
        var qos = QosOf(_options.Delivery);
        var life = SecondsOf(publication.ExpiresAfter);
        var bytes = MqttPackets.PublishBytes((Encoding.UTF8.GetByteCount(topic), publication.Payload.Length), new MqttPublishShape(qos, life is not null));

        // ! counted before it goes: its broker ends the whole link on a packet past its bound
        // ([MQTT-3.2.2-15]), every connection of its participant with it
        if (bytes > link.PublicationBound)
        {
            throw new ArgumentException(string.Create(CultureInfo.InvariantCulture, $"a PUBLISH of {bytes} bytes to {topic}, past its broker's Maximum Packet Size, {link.PublicationBound} bytes"), nameof(publication));
        }

        var builder = new MqttApplicationMessageBuilder()
            .WithTopic(topic)
            .WithPayload(publication.Payload.ToArray())
            .WithQualityOfServiceLevel(qos == 1 ? MqttQualityOfServiceLevel.AtLeastOnce : MqttQualityOfServiceLevel.AtMostOnce)
            .WithRetainFlag(false);

        if (life is { } seconds)
        {
            builder = builder.WithMessageExpiryInterval(seconds);
        }

        var message = builder.Build();

        if (qos == 0)
        {
            await Asked((link, token), link.Client.PublishAsync(message, link.Life.Token));

            return BrokerPublished.Taken;
        }

        Task<MqttClientPublishResult>? sending = null;

        await link.Quota!.Enqueue((
            () =>
            {
                sending = Sent(() =>
                {
                    return link.Client.PublishAsync(message, link.Life.Token);
                });
            },
            token));

        MqttClientPublishResult published;

        try
        {
            using (token.Register(() =>
            {
                Retire(link);
            }))
            {
                published = await Asked((link, token), sending!);
            }
        }
        finally
        {
            link.Quota.Release();
        }

        var code = (int)published.ReasonCode;

        if (code == (int)MqttClientPublishReasonCode.NoMatchingSubscribers)
        {
            return BrokerPublished.NoSubscriber;
        }

        if (code >= 0x80)
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused the publication of {Id} to {topic}: PUBACK 0x{code:X2}"));
        }

        return BrokerPublished.Taken;
    }

    /// <summary>Ends its link with a DISCONNECT of 0x00, so that its broker publishes no will (spec 15.26); nothing where it has none.</summary>
    public async Task Stop()
    {
        Link? link;
        var stopped = new InvalidOperationException($"the link of {Id} stopped");

        lock (_gate)
        {
            link = _link is { IsEnded: false } up ? up : null;

            if (link is not null)
            {
                // ! named before its DISCONNECT goes, which fails what it awaits before its end
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
            if (link.IsUp && link.Client.IsConnected)
            {
                using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);

                await Quietly(link.Client.DisconnectAsync(new MqttClientDisconnectOptionsBuilder().WithReason(MqttClientDisconnectOptionsReason.NormalDisconnection).Build(), timeout.Token));
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

    // a Maximum Packet Size, a Four Byte Integer no larger than the largest packet MQTT 5 writes
    private static void AssertPacketSize((string Name, long Value) bound)
    {
        if (bound.Value is < 1 or > MqttPackets.LargestPacketSize)
        {
            throw new ArgumentOutOfRangeException(bound.Name, string.Create(CultureInfo.InvariantCulture, $"{bound.Name} is a whole number from 1 to {MqttPackets.LargestPacketSize}, not {bound.Value}"));
        }
    }

    // a QoS by the delivery its application asks
    private static int QosOf(BrokerDelivery delivery)
    {
        return delivery == BrokerDelivery.AtLeastOnce ? 1 : 0;
    }

    // a life in whole seconds, rounded up, 1 at least, within a Four Byte Integer; none when none
    private static uint? SecondsOf(TimeSpan? life)
    {
        if (life is not { } given)
        {
            return null;
        }

        var seconds = Math.Ceiling(given.TotalSeconds);

        return (uint)Math.Clamp(seconds, 1, uint.MaxValue);
    }

    // what a call started gives, or its throw as a failed task, never a throw into the turn that sends it
    private static Task<T> Sent<T>(Func<Task<T>> call)
    {
        try
        {
            return call();
        }
        catch (Exception reason)
        {
            return Task.FromException<T>(reason);
        }
    }

    // a task whose failure is the link's to find
    private static async Task Quietly(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception reason) when (reason is not OutOfMemoryException)
        {
            // its link's end tells what failed
        }
    }

    // the link, up; refused at once while it is down, so that no library holds what is asked
    private Link LinkUp()
    {
        lock (_gate)
        {
            if (_link is { IsUp: true, IsEnded: false, IsStopping: false } link && link.Client.IsConnected)
            {
                return link;
            }
        }

        throw new InvalidOperationException($"the link of {Id} is not up");
    }

    // what a call of a link gives, or why it failed: its link lost, or its own cancel
    private async Task<T> Asked<T>((Link Link, CancellationToken Token) asked, Task<T> call)
    {
        try
        {
            return await call;
        }
        catch (Exception reason) when (asked.Token.IsCancellationRequested)
        {
            throw new OperationCanceledException($"what the link of {Id} was asked was given up", reason, asked.Token);
        }
        // ! MQTTnet may fail what waits on a link as it goes down before its end is told, or refuse
        // what is asked once it knows itself down: a lost link all the same
        catch (Exception reason) when (asked.Link.IsEnded || reason is MqttClientDisconnectedException or MqttClientUnexpectedDisconnectReceivedException or MqttClientNotConnectedException)
        {
            throw new IOException(asked.Link.Ended?.Message ?? $"the link of {Id} went down", reason);
        }
    }

    // the connect's options: one network connection that keeps no session, its id and its means
    private MqttClientOptions OptionsOf((BrokerPublication? Will, string? Password) connect)
    {
        var (will, password) = connect;
        var uri = _options.Uri;
        var isTls = uri.Scheme is "mqtts" or "wss";
        var host = uri.Host.Trim('[', ']');
        var builder = new MqttClientOptionsBuilder()
            .WithProtocolVersion(MqttProtocolVersion.V500)
            .WithClientId(Id)
            .WithCleanStart(true)
            .WithSessionExpiryInterval(0)
            .WithReceiveMaximum(ushort.MaxValue)
            .WithTopicAliasMaximum(0)
            .WithMaximumPacketSize((uint)_options.MaximumPacketSize)
            .WithKeepAlivePeriod(TimeSpan.FromSeconds(Math.Ceiling(_options.KeepAlive.TotalSeconds)))
            .WithRequestResponseInformation(false)
            .WithTimeout(CloseTimeout);

        builder = uri.Scheme is "ws" or "wss"
            ? builder.WithWebSocketServer((webSocket) =>
            {
                // * offered and chosen ([MQTT-6.0.0-3], [-4]), set here rather than trusting a default
                webSocket.WithUri(uri.AbsoluteUri).WithSubProtocols(["mqtt"]);
            })
                // ! each message one binary frame (spec 15.25): MQTTnet sends a payload as a
                // continuation by default, and Mosquitto 2.1.2 frames what it writes amid one as one
                .WithoutPacketFragmentation()
            : builder.WithTcpServer(host, uri.IsDefaultPort || uri.Port < 0 ? (isTls ? 8883 : 1883) : uri.Port);

        if (isTls)
        {
            builder = builder.WithTlsOptions((tls) =>
            {
                tls.UseTls(true).WithTargetHost(host);

                if (_options.Tls?.ClientCertificates is { } certificates)
                {
                    tls.WithClientCertificates(certificates);
                }

                if (_options.Tls?.TrustChain is { } trusted)
                {
                    tls.WithTrustChain(trusted);
                }
            });
        }

        if (password is not null)
        {
            builder = builder.WithCredentials(Id, password);
        }

        if (will is not null)
        {
            builder = builder
                .WithWillTopic(MqttPackets.TopicOf(will.Topic))
                .WithWillPayload(will.Payload.ToArray())
                .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithWillRetain(false)
                .WithWillDelayInterval(0);
        }

        return builder.Build();
    }

    // its client's callbacks, each gated by the incarnation it was made for: one of a former does nothing
    private void Listen(Link link)
    {
        link.Client.ApplicationMessageReceivedAsync += (received) =>
        {
            // ! acknowledged by its participant's settle alone, never by the library
            received.AutoAcknowledge = false;
            Take((link, received));

            return Task.CompletedTask;
        };
        link.Client.DisconnectedAsync += (disconnected) =>
        {
            // * a DISCONNECT of 0x8E on a link up: another link of its Client Identifier took it over
            var down = new BrokerDown { IsTakenOver = disconnected.ClientWasConnected && disconnected.Reason == MqttClientDisconnectReason.SessionTakenOver };

            if (!link.IsStopping)
            {
                End((link, down), new IOException(down.IsTakenOver ? $"the link of {Id} was taken over" : $"the link of {Id} was lost: {disconnected.Reason}"));
            }

            return Task.CompletedTask;
        };
        link.Client.InspectPacketAsync += (inspected) =>
        {
            if (inspected.Direction == MqttPacketFlowDirection.Outbound)
            {
                Interlocked.Exchange(ref link.LastSent, TimeProvider.System.GetTimestamp());
            }
            else if (inspected.Buffer.Length > _options.MaximumPacketSize)
            {
                // ! a Protocol Error (MQTT 5.0 §3.1.2.11.4, §4.13.1): its incarnation retired before
                // the packet is decoded, so its message reaches no core, its network connection closed
                End((link, new BrokerDown()), new IOException(string.Create(CultureInfo.InvariantCulture, $"a packet of {inspected.Buffer.Length} bytes came past the Maximum Packet Size of {Id}, {_options.MaximumPacketSize} bytes")));
            }

            return Task.CompletedTask;
        };
    }

    // a message received, handed on before its PUBACK, which its participant's settle sends, once,
    // on the link it came by alone
    private void Take((Link Link, MqttApplicationMessageReceivedEventArgs Received) taken)
    {
        var (link, received) = taken;

        if (link.IsEnded)
        {
            return;
        }

        var message = received.ApplicationMessage;
        var isAcknowledged = message.QualityOfServiceLevel != MqttQualityOfServiceLevel.AtMostOnce;

        if (isAcknowledged)
        {
            Interlocked.Increment(ref _unsettled);
        }

        Message?.Invoke(new BrokerMessage(
            new BrokerPublication { Topic = message.Topic.Split('/'), Payload = message.Payload.ToArray() },
            new BrokerMessageOptions
            {
                IsRetained = message.Retain,
                Settle = () =>
                {
                    if (!isAcknowledged)
                    {
                        return;
                    }

                    lock (_gate)
                    {
                        // ! a message of a lost link is never acknowledged on the next
                        if (link.IsEnded)
                        {
                            return;
                        }

                        Interlocked.Decrement(ref _unsettled);
                    }

                    _ = Quietly(received.AcknowledgeAsync(link.Life.Token));
                },
            }));
    }

    // a Server Keep Alive shorter than its own, which MQTTnet reads and pings past all the same: a
    // PINGREQ once nothing went for that long, on the system's clock, as the library's own timer
    // runs ([MQTT-3.2.2-21])
    private void KeepServerKeepAlive((Link Link, ushort Seconds) kept)
    {
        var (link, seconds) = kept;
        var serverKeepAlive = TimeSpan.FromSeconds(seconds);

        if (seconds == 0 || serverKeepAlive >= TimeSpan.FromSeconds(Math.Ceiling(_options.KeepAlive.TotalSeconds)))
        {
            return;
        }

        var pinger = TimeProvider.System.CreateTimer(
            (_) =>
            {
                if (link.IsEnded || Interlocked.CompareExchange(ref link.IsPinging, 1, 0) != 0)
                {
                    return;
                }

                if (TimeProvider.System.GetElapsedTime(Interlocked.Read(ref link.LastSent)) < serverKeepAlive)
                {
                    Interlocked.Exchange(ref link.IsPinging, 0);

                    return;
                }

                _ = Task.Run(async () =>
                {
                    try
                    {
                        await Quietly(link.Client.PingAsync(link.Life.Token));
                    }
                    finally
                    {
                        Interlocked.Exchange(ref link.IsPinging, 0);
                    }
                });
            },
            null,
            PingCheck,
            PingCheck);

        lock (_gate)
        {
            if (link.IsEnded)
            {
                pinger.Dispose();

                return;
            }

            link.Pinger = pinger;
        }
    }

    // given up once what it asked may have gone: its link lost, so nothing of it enters another
    private void Retire(Link link)
    {
        End((link, new BrokerDown()), new IOException($"the link of {Id} was retired: what it was asked was given up once it may have gone"));
    }

    // an incarnation's end, once: told down where it was up, then what it awaits failed, its quota
    // ended, and its client let go of, which closes its network connection without a DISCONNECT
    private void End((Link Link, BrokerDown? Down) ending, Exception reason)
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
            link.Ended = reason;
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

        link.Quota?.End(new IOException(reason.Message, reason));
        link.Pinger?.Dispose();

        try
        {
            link.Life.Cancel();
        }
        catch (AggregateException)
        {
            // a registration's throw: what it cancelled ended all the same
        }

        // * let go of off this thread: MQTTnet's callback that ended it may be the one running
        _ = Task.Run(() =>
        {
            link.Client.Dispose();
            link.Life.Dispose();
        });
    }

    // one incarnation: its client, what ends with it, its quota and bounds, and its subscriptions' filters
    private sealed class Link(IMqttClient client)
    {
        public long LastSent = TimeProvider.System.GetTimestamp();

        public int IsPinging;

        public IMqttClient Client { get; } = client;

        public CancellationTokenSource Life { get; } = new();

        public Dictionary<string, string> Filters { get; } = new(StringComparer.Ordinal);

        public MqttSendQuota? Quota { get; set; }

        public long PublicationBound { get; set; } = MqttPackets.LargestPacketSize;

        public bool IsSharedAvailable { get; set; } = true;

        public bool IsUp { get; set; }

        public bool IsEnded { get; set; }

        public bool IsStopping { get; set; }

        public Exception? Ended { get; set; }

        public ITimer? Pinger { get; set; }
    }
}
