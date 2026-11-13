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
/// participant's id, authenticated by a Password under its id, given or asked at each start, by a
/// TLS client certificate, or by its User Name alone; a subscription of QoS 1 and Retain Handling 2
/// for each topic, a name in a group as its shared subscription; a publication of QoS 1, RETAIN 0,
/// counted to its byte before it goes and held to its CONNACK's Receive Maximum, its PUBACK's 0x10
/// read as no subscriber; each message handed on before its PUBACK, which goes once its participant
/// settled it; a will of its GONE; at a stop, an UNSUBSCRIBE of each filter it asked or holds, then
/// a DISCONNECT of 0x00, and one of 0x8E read as its link taken over. A packet past its own Maximum
/// Packet Size, read at its Remaining Length, or a PUBACK, a SUBACK or an UNSUBACK of a Reason Code
/// under 0x80 its table does not name or of a count of codes other than one, read at MQTTnet's
/// packet inspector before it decodes it, closes its network connection, no DISCONNECT, its link
/// lost, at its stop as at any other time. MQTTnet's automation is off: no reconnection,
/// resubscription, offline queue or alias; each incarnation is a client of its own, every late
/// callback of a former one doing nothing. The TypeScript side's adapter over MQTT.js does the same.
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

    // its dispose, which every later one shares: set under its gate, and a start after it refused
    private Task? _disposed;

    /// <summary>
    /// An adapter of <see cref="MqttBrokerAdapterOptions.Id"/> to the broker at
    /// <see cref="MqttBrokerAdapterOptions.Uri"/>, not yet started. A scheme but <c>mqtt</c>,
    /// <c>mqtts</c>, <c>ws</c> or <c>wss</c>, an IPv6 address followed by anything but its port, an
    /// empty id, or a password refused (a password and its provider both, either beside a client
    /// certificate, or one that is empty or holds a NUL), is an
    /// <see cref="ArgumentException"/>; a bound or a duration out of its range an
    /// <see cref="ArgumentOutOfRangeException"/> naming it.
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

        if (!IsAuthorityWhole(options.Uri))
        {
            throw new ArgumentException($"an MQTT broker's IPv6 address is followed by its port or by nothing, not {options.Uri.OriginalString}", nameof(options));
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

        // * what its link authenticates by, held in one order on every side; with neither a password
        // nor a provider, its User Name alone, or its certificate
        if (BrokerPasswords.RefusalOf((options.Password, options.PasswordProvider is not null), options.Tls?.ClientCertificates is not null) is { } refusal)
        {
            throw new ArgumentException(refusal, nameof(options));
        }

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
    /// Size and its Keep Alive, its will the GONE given, of QoS 1, RETAIN 0 and Will Delay 0, its User
    /// Name its id, and its Password the one given or its provider's answer, where its certificate
    /// does not authenticate it; settles once its CONNACK said 0x00 with a Maximum QoS that is not 0, a
    /// loss after it, before it settles, its link lost and <see cref="Down"/> told once. A CONNACK of
    /// any other code, or of Maximum QoS 0, fails it naming it, a <see cref="IOException"/>, and sends
    /// nothing; no password nor CONNACK within its connect timeout, a <see cref="TimeoutException"/>;
    /// a link up already, an <see cref="InvalidOperationException"/>. Refused with an
    /// <see cref="ObjectDisposedException"/> once disposed, before anything moves (decision 0003).
    /// </summary>
    public async Task Start(BrokerStart? start = null)
    {
        Link? guarded = null;
        var client = new MqttClientFactory().CreateMqttClient(new GuardedAdapterFactory(new MqttPacketGuardOptions
        {
            MaximumPacketSize = _options.MaximumPacketSize,
            PastMaximum = (size) =>
            {
                // ! its link set before its CONNECT goes, so before any packet is read
                if (guarded is not null)
                {
                    PastMaximum((guarded, size));
                }
            },
        }));
        var link = guarded = new Link(client);

        lock (_gate)
        {
            // ! a dispose is final: a start after it is its application's misuse (decision 0003)
            if (_disposed is not null)
            {
                client.Dispose();

                throw DisposedRefusal();
            }

            if (_link is { IsEnded: false })
            {
                client.Dispose();

                throw new InvalidOperationException($"the link of {Id} is up already");
            }

            _link = link;
        }

        Listen(link);

        var token = start?.CancellationToken ?? CancellationToken.None;

        // * one connectTimeout from its call: its password's ask, then its CONNACK
        using var timeout = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);

        // its provider's token, its start's, its timeout's and its stop's, cancelled once its start ends, linked or not
        var asking = _options.PasswordProvider is null ? null : CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, link.Life.Token);

        // the down its link's loss owes where it came before this start's continuation
        BrokerDown? withheld = null;

        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, link.Life.Token);
            var password = asking is not null && _options.PasswordProvider is { } provider
                ? await BrokerPasswords.Asked(provider, new BrokerPasswordAsk
                {
                    Id = Id,
                    ConnectTimeout = _options.ConnectTimeout,
                    Start = token,
                    Stop = link.Life.Token,
                    Timeout = timeout.Token,
                    Provider = asking.Token,
                })
                : _options.Password;

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
            // * a packet its client cannot read, read before its CONNACK or as it: past its own Maximum
            // Packet Size, its CONNACK among them, or an acknowledgement its table does not name
            catch (Exception) when (link.Unreadable is not null)
            {
                throw link.Unreadable;
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

            // * a code outside MQTT 5's CONNACK table has no name: its code alone
            if (connected.ResultCode != MqttClientConnectResultCode.Success)
            {
                var code = (int)connected.ResultCode;
                var name = ConnAckNameOf(code);
                var suffix = name is null ? "" : $", {name}";

                throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused the link of {Id}: CONNACK 0x{code:X2}{suffix}"));
            }

            // * subscriptions of QoS 1 and a will of QoS 1: a broker of Maximum QoS 0 carries neither,
            // and a start that fails sends nothing
            if (connected.MaximumQoS == MqttQualityOfServiceLevel.AtMostOnce)
            {
                throw new IOException($"its broker's CONNACK gives the link of {Id} a Maximum QoS 0, and Bead's subscriptions and will are of QoS 1");
            }

            bool isEnded;

            lock (_gate)
            {
                isEnded = link.IsEnded;
                // * its CONNACK's bound, the last link's once it is down, though it ended already
                link.PublicationBound = connected.MaximumPacketSize is > 0 and var maximum ? Math.Min(maximum, MqttPackets.LargestPacketSize) : MqttPackets.LargestPacketSize;
                _publicationBound = link.PublicationBound;

                // ! its CONNACK put it up, and it ended since: a loss, its down withheld, or a stop,
                // nothing withheld; its start succeeds all the same
                if (isEnded)
                {
                    withheld = link.Withheld;
                    link.Withheld = null;
                }
                else
                {
                    link.Quota = new MqttSendQuota(connected.ReceiveMaximum is > 0 and var receiveMaximum ? receiveMaximum : ushort.MaxValue);
                    link.IsSharedAvailable = connected.SharedSubscriptionAvailable;
                    link.IsUp = true;
                }
            }

            if (!isEnded)
            {
                KeepServerKeepAlive((link, connected.ServerKeepAlive));
            }
        }
        catch (Exception reason)
        {
            End((link, null), reason);

            throw;
        }
        finally
        {
            BrokerPasswords.Release(asking);
        }

        // * its CONNACK put it up and its receive loop met its loss before this continuation: told
        // here, once
        if (withheld is not null)
        {
            Down?.Invoke(withheld);
        }
    }

    /// <summary>
    /// Holds a subscription to <paramref name="topic"/> of QoS 1, No Local 0, Retain As Published 0
    /// and Retain Handling 2, a group's as its shared subscription; settles once its SUBACK granted
    /// QoS 1, and fails on QoS 0 or 2 granted and on a code of 0x80 or more, whether or not SUBACK's
    /// table names it (spec 15.27); a SUBACK of a code under 0x80 its table does not name, or of a
    /// count of codes other than one, loses its link, which it fails with (spec 15.29). Its filter
    /// is its link's as its SUBSCRIBE goes, so that its stop lets it go whether or not its SUBACK
    /// came, until a SUBACK of 0x80 or more says its broker installed none; one whose SUBACK comes as
    /// its link stops fails with its stop. A group its broker offers none of is refused, naming why;
    /// a link down, an <see cref="InvalidOperationException"/>.
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

        var key = MqttPackets.TopicOf(topic);
        var held = new Held(group is null ? key : MqttPackets.GroupFilterOf((group, topic)));
        var asked = new MqttClientSubscribeOptionsBuilder().WithTopicFilter(new MqttTopicFilterBuilder()
            .WithTopic(held.Filter)
            .WithAtLeastOnceQoS()
            .WithNoLocal(false)
            .WithRetainAsPublished(false)
            .WithRetainHandling(MqttRetainHandling.DoNotSendOnSubscribe)
            .Build()).Build();
        Task<MqttClientSubscribeResult> subscribing;

        lock (_gate)
        {
            // ! its filter its link's before its SUBSCRIBE goes, and that SUBSCRIBE asked under the
            // gate a stop is named under: a stop then finds it, its UNSUBSCRIBE behind it on the
            // link, which its broker reads in their order ([MQTT-3.10.4-2]), or it is refused,
            // nothing sent
            if (link.IsStopping || link.IsEnded)
            {
                throw new InvalidOperationException($"the link of {Id} is not up");
            }

            link.Filters[key] = held;
            subscribing = Sent(() =>
            {
                return link.Client.SubscribeAsync(asked, link.Life.Token);
            });
        }

        MqttClientSubscribeResult subscribed;

        // ! given up once its packet may have gone: its link retired, so nothing it asked enters another
        using (token.Register(() =>
        {
            Retire(link);
        }))
        {
            subscribed = await Asked((link, token), subscribing);
        }

        var code = subscribed.Items.Single().ResultCode;

        // ! its SUBACK come as its link stops: never held, its stop letting it go
        if (link.IsStopping || link.IsEnded)
        {
            throw new IOException(link.Ended?.Message ?? $"the link of {Id} went down");
        }

        if (code == MqttClientSubscribeResultCode.GrantedQoS1)
        {
            return;
        }

        // * refused of 0x80 or more, its broker installed none; QoS 0 granted, refused all the
        // same, is one its broker holds, which its stop lets go
        if ((int)code >= 0x80)
        {
            Forget((link, key), held);
        }

        if (code == MqttClientSubscribeResultCode.SharedSubscriptionsNotSupported)
        {
            link.IsSharedAvailable = false;
        }

        throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused the subscription of {Id} to {held.Filter}: SUBACK 0x{(int)code:X2}"));
    }

    /// <summary>
    /// Lets the subscription to <paramref name="topic"/> go, by the filter its SUBSCRIBE named, or
    /// the topic itself where it held none, its UNSUBSCRIBE sent as it is called; settles once its
    /// UNSUBACK came of 0x00, or 0x11 where its broker held none, each PUBLISH its broker sent of it
    /// before then read first, its connection carrying both in order ([MQTT-3.10.4-3]); fails on a
    /// code of 0x80 or more, whether or not UNSUBACK's table names it, an <see cref="IOException"/>
    /// naming it, with its link's loss on one under 0x80 it does not name or of a count of codes
    /// other than one (spec 15.29), and with none within
    /// <see cref="MqttBrokerAdapterOptions.ConnectTimeout"/> of its call, a
    /// <see cref="TimeoutException"/> naming it, its link kept so that no will goes (spec 15.27).
    /// Its filter stays its link's until such an UNSUBACK came, a late one among them, so that a
    /// stop meanwhile lets it go too.
    /// </summary>
    public async Task Unsubscribe(IReadOnlyList<string> topic)
    {
        var link = LinkUp();
        var key = MqttPackets.TopicOf(topic);
        Held? held;

        lock (_gate)
        {
            held = link.Filters.GetValueOrDefault(key);
        }

        var filter = held?.Filter ?? key;

        // ! its request never given up by a token, its link's own but, so that a late UNSUBACK is
        // still read; its wait alone is bounded
        var leaving = LeftOf((link, (key, held)), Asked((link, CancellationToken.None), link.Client.UnsubscribeAsync(new MqttClientUnsubscribeOptionsBuilder().WithTopicFilter(filter).Build(), link.Life.Token)));

        try
        {
            await leaving.WaitAsync(_options.ConnectTimeout, TimeProvider.System);
        }
        catch (TimeoutException reason)
        {
            _ = leaving.ContinueWith(
                (failed) =>
                {
                    _ = failed.Exception;
                },
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);

            throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the subscription of {Id} to {filter} had no UNSUBACK within {_options.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
        }
    }

    // an UNSUBSCRIBE's UNSUBACK, whenever it comes: of 0x00 or 0x11, its filter its link's no more;
    // of 0x80 or more, a refusal naming it
    private async Task LeftOf((Link Link, (string Key, Held? Held) Filter) asked, Task<MqttClientUnsubscribeResult> unsubscribing)
    {
        var (link, (key, held)) = asked;
        var left = await unsubscribing;
        var code = left.Items.Single().ResultCode;

        if (code is not (MqttClientUnsubscribeResultCode.Success or MqttClientUnsubscribeResultCode.NoSubscriptionExisted))
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture, $"its broker refused to let the subscription of {Id} to {held?.Filter ?? key} go: UNSUBACK 0x{(int)code:X2}"));
        }

        if (held is not null)
        {
            Forget((link, key), held);
        }
    }

    /// <summary>
    /// Publishes a parcel in one PUBLISH (spec 15.28): of QoS 1 at least once, held to its CONNACK's
    /// Receive Maximum, later ones waiting in their order, <see cref="BrokerPublished.Taken"/> once
    /// its PUBACK came of 0x00 or of none, <see cref="BrokerPublished.NoSubscriber"/> on 0x10, an
    /// <see cref="IOException"/> naming it on a code of 0x80 or more, whether or not PUBACK's table
    /// names it, and its link's loss on one under 0x80 it does not name (spec 15.29); of QoS 0 at
    /// most once, taken as it goes; RETAIN 0, its life in whole seconds rounded up where one is
    /// asked, no other property. One whose packet would pass its CONNACK's Maximum Packet Size is an
    /// <see cref="ArgumentException"/>, nothing sent; a link down, an
    /// <see cref="InvalidOperationException"/>. Given up while it waits for the quota, it leaves
    /// unsent, its link kept; given up once it may have gone, at either QoS, its link is retired.
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
            var going = Sent(() =>
            {
                return link.Client.PublishAsync(message, link.Life.Token);
            });

            // ! registered once it was asked, as at QoS 1: given up before its packet is written, it
            // may go yet, so its link goes
            using (token.Register(() =>
            {
                Retire(link);
            }))
            {
                await Asked((link, token), going);
            }

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

    /// <summary>
    /// Ends its link once its broker let go of each of its subscriptions, with a DISCONNECT of
    /// 0x00, so that its broker publishes no will (spec 15.26): no new publication taken, what it
    /// was handed to publish before it goes first, each PUBACK awaited, as a graceful close sends
    /// what is queued before its FIN (spec 15.24, RFC 9293 §3.6); then an UNSUBSCRIBE of each
    /// filter its link asked or holds, one filter each, all at once, their UNSUBACKs of 0x00 or
    /// 0x11 awaited together; what it was handed and those UNSUBACKs within one
    /// <see cref="MqttBrokerAdapterOptions.ConnectTimeout"/> of its call, what has not gone by then
    /// failed; its DISCONNECT within a bound of its own, an UNSUBACK of a code of 0x80 or more that
    /// refuses, or none by then, ending it all the same. A packet its client cannot read ends it at
    /// once, no DISCONNECT, no down told, its broker publishing its will, and what it awaited fails
    /// with that loss (spec 15.29). It settles once its broker let go of each subscription of its
    /// link, as its unsubscription lets one go, so that its broker hands it nothing more. Nothing
    /// where it has none, and nothing sent where its link is down; a later start a new link.
    /// </summary>
    public async Task Stop()
    {
        Link? link;
        var life = CancellationToken.None;
        var stopped = new InvalidOperationException($"the link of {Id} stopped");

        lock (_gate)
        {
            link = _link is { IsEnded: false } up ? up : null;

            if (link is not null)
            {
                // ! named before its DISCONNECT goes, which fails what it awaits before its end
                link.IsStopping = true;
                link.Ended = stopped;

                // ! read under its gate while it has not ended: its end disposes its source
                life = link.Life.Token;
            }
        }

        if (link is null)
        {
            return;
        }

        try
        {
            // * one connectTimeout from its call: what it was handed, then its broker's let-go; and
            // its link's end, a packet its client cannot read among it, ending both waits at once
            using var bounded = new CancellationTokenSource(_options.ConnectTimeout, TimeProvider.System);
            using var letting = CancellationTokenSource.CreateLinkedTokenSource(bounded.Token, life);

            // * what it was handed goes first, no new publication taken meanwhile: its quota drained,
            // each PUBACK come
            if (link.IsUp && link.Client.IsConnected && link.Quota is { } quota)
            {
                await Quietly(quota.Drained().WaitAsync(letting.Token));
            }

            // ! after the drain, so that no UNSUBSCRIBE overtakes a CLOSE waiting on the quota, its
            // peer reading no subscriber before its 1001; one filter each, since one packet of
            // every filter may pass its broker's Maximum Packet Size, a Protocol Error that
            // publishes its will
            if (link.IsUp && link.Client.IsConnected && !IsEnded(link))
            {
                List<string> filters;

                lock (_gate)
                {
                    filters = [.. link.Filters.Values.Select((held) =>
                    {
                        return held.Filter;
                    }).Distinct(StringComparer.Ordinal)];
                }

                await Quietly(Task.WhenAll(filters.Select((filter) =>
                {
                    // ! its link's client itself: LinkUp refuses a link stopping
                    return Sent(() =>
                    {
                        return link.Client.UnsubscribeAsync(new MqttClientUnsubscribeOptionsBuilder().WithTopicFilter(filter).Build(), letting.Token);
                    });
                })).WaitAsync(letting.Token));
            }

            // ! a bound of its own: a drain that spent its time leaves its DISCONNECT one, or the
            // broker would read no DISCONNECT and publish its will; sent once MQTTnet says it
            // connected, its CONNACK read, even before its start's continuation counted it up, and
            // never once its link ended, a packet its client cannot read ending it, which MQTTnet
            // may say connected a moment more
            if (link.Client.IsConnected && !IsEnded(link))
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

    /// <summary>
    /// Stops it, then ends it for good (decision 0003): a start after it is its application's
    /// misuse, an <see cref="ObjectDisposedException"/>; a later dispose settles with the first.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        var disposing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task disposed;

        lock (_gate)
        {
            _disposed ??= disposing.Task;
            disposed = _disposed;
        }

        if (disposed == disposing.Task)
        {
            try
            {
                await Stop();
                disposing.SetResult();
            }
            catch (Exception reason)
            {
                disposing.SetException(reason);
            }
        }

        await disposed;
    }

    // what a start after its dispose is refused with
    private ObjectDisposedException DisposedRefusal()
    {
        return new ObjectDisposedException(null, $"the adapter of {Id} is disposed");
    }

    // * whether what follows an IP literal in its authority, as it was written, is its port or
    // nothing (RFC 3986 §3.2.2, §3.2.3): System.Uri drops anything else, and its port with it
    private static bool IsAuthorityWhole(Uri uri)
    {
        var written = uri.OriginalString;
        var scheme = written.IndexOf("://", StringComparison.Ordinal);

        if (scheme < 0)
        {
            return true;
        }

        var authority = written[(scheme + 3)..];
        var end = authority.IndexOfAny(['/', '?', '#']);

        if (end >= 0)
        {
            authority = authority[..end];
        }

        // its host and port, after any user it names
        authority = authority[(authority.LastIndexOf('@') + 1)..];

        var bracket = authority.IndexOf(']', StringComparison.Ordinal);

        if (!authority.StartsWith('[') || bracket < 0)
        {
            return true;
        }

        var after = authority[(bracket + 1)..];

        return after.Length == 0 || (after[0] == ':' && after[1..].All(char.IsAsciiDigit));
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
    // MQTT 5.0 §3.2.2.2, Table 3-1: a CONNACK's Reason Code names.
    private static string? ConnAckNameOf(int code)
    {
        return code switch
        {
            0x00 => "Success",
            0x80 => "Unspecified error",
            0x81 => "Malformed Packet",
            0x82 => "Protocol Error",
            0x83 => "Implementation specific error",
            0x84 => "Unsupported Protocol Version",
            0x85 => "Client Identifier not valid",
            0x86 => "Bad User Name or Password",
            0x87 => "Not authorized",
            0x88 => "Server unavailable",
            0x89 => "Server busy",
            0x8A => "Banned",
            0x8C => "Bad authentication method",
            0x90 => "Topic Name invalid",
            0x95 => "Packet too large",
            0x97 => "Quota exceeded",
            0x99 => "Payload format invalid",
            0x9A => "Retain not supported",
            0x9B => "QoS not supported",
            0x9C => "Use another server",
            0x9D => "Server moved",
            0x9F => "Connection rate exceeded",
            _ => null,
        };
    }

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

        // * its User Name its id, with its Password where it has one; neither under its certificate,
        // which a password never stands beside
        if (_options.Tls?.ClientCertificates is null)
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
            // * a DISCONNECT of 0x8E: another link of its Client Identifier took it over, a server
            // sending none before a CONNACK under 0x80
            var down = new BrokerDown { IsTakenOver = disconnected.Reason == MqttClientDisconnectReason.SessionTakenOver };

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
            // ! judged whole, before MQTTnet decodes it: its end cancels what awaits it before
            // MQTTnet hands that a code, whatever context its caller resumes on
            else if (MqttPackets.UnreadableOf(inspected.Buffer) is { } words)
            {
                Lost((link, new IOException($"the link of {Id} went down: its broker sent {words}")));
            }

            return Task.CompletedTask;
        };
    }

    // a packet past its own Maximum Packet Size, a Protocol Error (MQTT 5.0 §3.1.2.11.4, §4.13.1),
    // judged at its Remaining Length by its channel's guard, on MQTTnet's receive loop
    private void PastMaximum((Link Link, long Size) past)
    {
        var (link, size) = past;

        Lost((link, new IOException(string.Create(CultureInfo.InvariantCulture, $"the link of {Id} went down: its broker sent a packet of {size} bytes, past its Maximum Packet Size, {_options.MaximumPacketSize} bytes"))));
    }

    // a packet its client cannot read (spec 15.29), on MQTTnet's receive loop, in every phase: its
    // link lost where it was up, its start failed where its CONNACK had not come, its stop ended
    // where it stopped, no down told; never a DISCONNECT
    private void Lost((Link Link, IOException Reason) lost)
    {
        var (link, reason) = lost;

        lock (_gate)
        {
            // ! a link ended already keeps the reason it ended for
            if (!link.IsEnded)
            {
                link.Unreadable = reason;
            }
        }

        End((link, new BrokerDown()), reason);
    }

    // whether its link ended, read under its gate
    private bool IsEnded(Link link)
    {
        lock (_gate)
        {
            return link.IsEnded;
        }
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

    // a filter its broker holds no more, its link's no more, unless a later SUBSCRIBE of its topic
    // recorded its own meanwhile
    private void Forget((Link Link, string Key) forgotten, Held held)
    {
        var (link, key) = forgotten;

        lock (_gate)
        {
            if (link.Filters.TryGetValue(key, out var current) && ReferenceEquals(current, held))
            {
                link.Filters.Remove(key);
            }
        }
    }

    // given up once what it asked may have gone: its link lost, so nothing of it enters another
    private void Retire(Link link)
    {
        End((link, new BrokerDown()), new IOException($"the link of {Id} was retired: what it was asked was given up once it may have gone"));
    }

    // an incarnation's end, once, on a packet past its own Maximum Packet Size as on any other cause:
    // told down where it was up, its down withheld for its start's continuation where it was not,
    // then what it awaits failed, its quota ended, and its client let go of, which closes its
    // network connection without a DISCONNECT
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

            // * a loss before its start's continuation, told by it where its CONNACK put it up,
            // dropped where its start fails
            if (!wasUp && down is not null && !link.IsStopping)
            {
                link.Withheld = down;
            }

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

    // the filter a SUBSCRIBE named, recorded as it goes, an instance of its own, so that what lets
    // it go forgets that one alone
    private sealed class Held(string filter)
    {
        public string Filter { get; } = filter;
    }

    // one incarnation: its client, what ends with it, its quota and bounds, and the filters it
    // asked, by topic, each until its broker let it go
    private sealed class Link(IMqttClient client)
    {
        public long LastSent = TimeProvider.System.GetTimestamp();

        public int IsPinging;

        public IMqttClient Client { get; } = client;

        public CancellationTokenSource Life { get; } = new();

        public Dictionary<string, Held> Filters { get; } = new(StringComparer.Ordinal);

        public MqttSendQuota? Quota { get; set; }

        public long PublicationBound { get; set; } = MqttPackets.LargestPacketSize;

        public bool IsSharedAvailable { get; set; } = true;

        public bool IsUp { get; set; }

        public bool IsEnded { get; set; }

        public bool IsStopping { get; set; }

        // the down a loss before its start's continuation owes, told by that continuation
        public BrokerDown? Withheld { get; set; }

        public Exception? Ended { get; set; }

        // a packet its client cannot read, set before it ends it, so that its start fails with it,
        // never as a stop's end
        public IOException? Unreadable { get; set; }

        public ITimer? Pinger { get; set; }
    }
}
