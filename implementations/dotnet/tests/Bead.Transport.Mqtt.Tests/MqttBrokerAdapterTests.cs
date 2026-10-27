using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using MQTTnet.Packets;
using MQTTnet.Protocol;

namespace Bead.Transport.Mqtt.Tests;

/// <summary>
/// The adapter over MQTTnet against a scripted MQTT 5 peer, <see cref="MqttScript"/>, which writes
/// each CONNACK, SUBACK and PUBACK itself, so that every packet the adapter sends is read as it goes;
/// and, where <c>BEAD_MQTT_URL</c> names a Mosquitto (<c>node tools/mqtt-broker.mjs run -- dotnet
/// test</c>), a link over its WebSocket. The TypeScript side's <c>mqtt-broker-adapter.test.ts</c>
/// plays the same sentences.
/// </summary>
public sealed class MqttBrokerAdapterTests : IAsyncLifetime
{
    // constants

    private const string Id = "ada";
    private const string Password = "secret";

    // the user the WebSocket leg links as, which no case and no interop leg is
    private const string FixtureUser = "fixture";

    private static readonly string[] Inbox = ["bead", "i", Id];
    private static readonly string[] Name = ["bead", "s", "interop"];
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    // a self-signed certificate for 127.0.0.1, its server's and its client's alike
    private static readonly Lazy<X509Certificate2> Certificate = new(CertificateOf);

    private MqttScript _script = null!;

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    public ValueTask InitializeAsync()
    {
        _script = MqttScript.Start();

        return ValueTask.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        await _script.DisposeAsync();
    }

    private static X509Certificate2 CertificateOf()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=127.0.0.1", key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();

        names.AddIpAddress(IPAddress.Loopback);
        names.AddDnsName("localhost");
        request.CertificateExtensions.Add(names.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, false));

        using var made = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));

        // imported again, so SslStream can use its key on Windows
        return X509CertificateLoader.LoadPkcs12(made.Export(X509ContentType.Pfx), null);
    }

    // an adapter of the id to the script, its password unless told
    private MqttBrokerAdapter AdapterOf(Func<MqttBrokerAdapterOptions, MqttBrokerAdapterOptions>? changed = null)
    {
        var options = new MqttBrokerAdapterOptions { Id = Id, Password = Password, Uri = _script.Uri };

        return new MqttBrokerAdapter(changed?.Invoke(options) ?? options);
    }

    // the adapter started, its link the script's next, answered by the CONNACK given or one that limits nothing
    private static async Task<ScriptedLink> LinkUp((MqttBrokerAdapter Adapter, MqttScript Script) linking, (MqttConnAckPacket? ConnAck, BrokerPublication? Will) answer = default)
    {
        var starting = linking.Adapter.Start(new BrokerStart { Will = answer.Will });
        var link = await linking.Script.Link();

        await link.Send(answer.ConnAck ?? ScriptedLink.ConnAck());
        await starting.WaitAsync(Patience, Cancelled);

        return link;
    }

    // a SUBACK of the code given to the next SUBSCRIBE the link reads, which it gives back
    private static async Task<MqttSubscribePacket> SubAckOf((ScriptedLink Link, int Code) answer)
    {
        var subscribe = await answer.Link.Next<MqttSubscribePacket>();

        await answer.Link.Send(new MqttSubAckPacket { PacketIdentifier = subscribe.PacketIdentifier, ReasonCodes = [(MqttSubscribeReasonCode)answer.Code] });

        return subscribe;
    }

    private static Task PubAckOf((ScriptedLink Link, ushort PacketIdentifier, int Code) answer)
    {
        return answer.Link.Send(new MqttPubAckPacket { PacketIdentifier = answer.PacketIdentifier, ReasonCode = (MqttPubAckReasonCode)answer.Code });
    }

    // a PUBLISH a broker forwards, of QoS 1 unless told
    private static MqttPublishPacket PublishOf((string Topic, byte[] Payload, ushort PacketIdentifier) publish, bool isRetained = false)
    {
        return new MqttPublishPacket
        {
            Topic = publish.Topic,
            PayloadSegment = publish.Payload,
            PacketIdentifier = publish.PacketIdentifier,
            QualityOfServiceLevel = MqttQualityOfServiceLevel.AtLeastOnce,
            Retain = isRetained,
        };
    }

    // the messages and the downs an adapter tells, as they come
    private static (ConcurrentQueue<BrokerMessage> Messages, ConcurrentQueue<BrokerDown> Downs) HeardOf(MqttBrokerAdapter adapter)
    {
        var messages = new ConcurrentQueue<BrokerMessage>();
        var downs = new ConcurrentQueue<BrokerDown>();

        adapter.Message += messages.Enqueue;
        adapter.Down += downs.Enqueue;

        return (messages, downs);
    }

    // polls on the real clock until it holds, within five seconds
    private static async Task Until(Func<bool> isDone)
    {
        var watch = Stopwatch.StartNew();

        while (!isDone() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }
    }

    private static async Task<Exception> FailureOf(Func<Task> call)
    {
        try
        {
            await call().WaitAsync(Patience, Cancelled);
        }
        catch (Exception reason) when (reason is not TimeoutException || !reason.Message.Contains("The operation has timed out", StringComparison.Ordinal))
        {
            return reason;
        }

        throw new Xunit.Sdk.XunitException("it did not fail");
    }

    // definition

    [Fact]
    public async Task Connects_a_link_that_keeps_no_session_its_id_its_Client_Identifier_its_password_under_its_id_or_none_under_a_certificate_Topic_Alias_Maximum_0_its_Maximum_Packet_Size_and_its_Keep_Alive_spec_15_26()
    {
        var asked = 0;
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                KeepAlive = TimeSpan.FromMilliseconds(1_500),
                MaximumPacketSize = 2_048,
                Password = null,
                PasswordProvider = (_) =>
                {
                    return Task.FromResult($"{Password}-{Interlocked.Increment(ref asked)}");
                },
            };
        });
        var connect = (await LinkUp((adapter, _script))).Connect;

        Assert.Equal(
            (true, Id, (ushort)2, 2_048u, (ushort)65_535, (ushort)0, Id, $"{Password}-1", 0u),
            (connect.CleanSession, connect.ClientId, connect.KeepAlivePeriod, connect.MaximumPacketSize, connect.ReceiveMaximum, connect.TopicAliasMaximum, connect.Username, Encoding.UTF8.GetString(connect.Password), connect.SessionExpiryInterval));
        Assert.Equal(TransportTypes.Mqtt, adapter.Type);
        await adapter.Stop();

        // * a password asked at each link's start, renewed with each incarnation
        var again = (await LinkUp((adapter, _script))).Connect;

        Assert.Equal($"{Password}-2", Encoding.UTF8.GetString(again.Password));
        await adapter.Stop();

        // under a client certificate its broker ties to its id, over TLS: neither User Name nor Password
        await using (var secured = MqttScript.Start(Certificate.Value))
        {
            await using var certified = new MqttBrokerAdapter(new MqttBrokerAdapterOptions
            {
                Id = Id,
                Tls = new MqttBrokerTlsOptions { ClientCertificates = [Certificate.Value], TrustChain = [Certificate.Value] },
                Uri = secured.Uri,
            });
            var bare = (await LinkUp((certified, secured))).Connect;

            Assert.Equal((Id, (string?)null, (byte[]?)null, true), (bare.ClientId, bare.Username, bare.Password, certified.IsSecure));
            await certified.Stop();
        }

        // a certificate in the clear is refused as it is built
        Assert.StartsWith("a TLS client certificate is carried over mqtts or wss", Assert.Throws<ArgumentException>(() =>
        {
            return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Tls = new MqttBrokerTlsOptions { ClientCertificates = [Certificate.Value] }, Uri = _script.Uri });
        }).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Fails_its_start_on_a_CONNACK_whose_Maximum_QoS_is_0_naming_it_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var limited = ScriptedLink.ConnAck();

        limited.MaximumQoS = MqttQualityOfServiceLevel.AtMostOnce;
        Assert.Contains("Maximum QoS 0", (await FailureOf(() =>
        {
            return LinkUp((adapter, _script), (limited, null));
        })).Message, StringComparison.Ordinal);
        Assert.Empty(downs);

        // a CONNACK that refuses fails it too, naming its reason
        var starting = adapter.Start();
        var refused = await _script.Link();

        await refused.Send(new MqttConnAckPacket { ReasonCode = MqttConnectReasonCode.BadUserNameOrPassword, MaximumQoS = MqttQualityOfServiceLevel.ExactlyOnce, RetainAvailable = true, SharedSubscriptionAvailable = true });
        Assert.Contains("0x86", (await FailureOf(() =>
        {
            return starting;
        })).Message, StringComparison.Ordinal);

        // and so does no CONNACK within connectTimeout
        await using var waiting = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(200) };
        });

        Assert.Contains("no CONNACK within 200 ms", Assert.IsType<TimeoutException>(await FailureOf(() =>
        {
            return waiting.Start();
        })).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Keeps_a_Server_Keep_Alive_shorter_than_its_own_a_PINGREQ_once_nothing_went_for_that_long_spec_15_26()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { KeepAlive = TimeSpan.FromSeconds(30) };
        });
        var answer = ScriptedLink.ConnAck();

        answer.ServerKeepAlive = 1;

        var link = await LinkUp((adapter, _script), (answer, null));
        var watch = Stopwatch.StartNew();

        await link.Next<MqttPingReqPacket>(TimeSpan.FromSeconds(3));
        Assert.True(watch.Elapsed < TimeSpan.FromMilliseconds(2_500), $"its PINGREQ went after {watch.ElapsedMilliseconds} ms");
        await link.Send(MqttPingRespPacket.Instance);
        await adapter.Stop();
    }

    [Fact]
    public async Task Leaves_a_will_of_its_GONE_QoS_1_RETAIN_0_and_a_Will_Delay_Interval_of_0_and_stops_with_a_DISCONNECT_of_0x00_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var gone = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Gone, Id = Id, Incarnation = UInt128.MaxValue / 3 });
        var link = await LinkUp((adapter, _script), (null, new BrokerPublication { Topic = ["bead", "d", Id], Payload = gone }));
        var connect = link.Connect;

        Assert.Equal(
            (true, 0u, MqttQualityOfServiceLevel.AtLeastOnce, false, $"bead/d/{Id}", Convert.ToHexString(gone)),
            (connect.WillFlag, connect.WillDelayInterval, connect.WillQoS, connect.WillRetain, connect.WillTopic, Convert.ToHexString(connect.WillMessage)));

        var (_, downs) = HeardOf(adapter);

        await adapter.Stop();

        var disconnect = await link.Next<MqttDisconnectPacket>();

        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, disconnect.ReasonCode);
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
    }

    [Fact]
    public async Task Tells_its_link_taken_over_on_a_DISCONNECT_of_0x8E_and_lost_on_any_other_end_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var first = await LinkUp((adapter, _script));

        await first.Send(new MqttDisconnectPacket { ReasonCode = MqttDisconnectReasonCode.SessionTakenOver });
        first.End();
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown { IsTakenOver = true }], downs);

        // a DISCONNECT of another reason, and a cut, are a link lost
        var second = await LinkUp((adapter, _script));

        await second.Send(new MqttDisconnectPacket { ReasonCode = MqttDisconnectReasonCode.PacketTooLarge });
        second.End();
        await Until(() =>
        {
            return downs.Count > 1;
        });

        var third = await LinkUp((adapter, _script));

        third.Cut();
        await Until(() =>
        {
            return downs.Count > 2;
        });
        Assert.Equal([new BrokerDown { IsTakenOver = true }, new BrokerDown(), new BrokerDown()], downs);
    }

    [Fact]
    public async Task Subscribes_at_QoS_1_No_Local_0_Retain_As_Published_0_and_Retain_Handling_2_a_group_as_its_shared_subscription_held_once_its_SUBACK_grants_QoS_1_and_refused_otherwise_spec_15_27()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));
        var subscribing = adapter.Subscribe(Inbox);
        var subscribe = await link.Next<MqttSubscribePacket>();
        var filter = Assert.Single(subscribe.TopicFilters);

        Assert.Equal(
            ("bead/i/ada", MqttQualityOfServiceLevel.AtLeastOnce, false, false, MqttRetainHandling.DoNotSendOnSubscribe),
            (filter.Topic, filter.QualityOfServiceLevel, filter.NoLocal, filter.RetainAsPublished, filter.RetainHandling));
        await Task.Delay(50, Cancelled);
        Assert.False(subscribing.IsCompleted);
        await link.Send(new MqttSubAckPacket { PacketIdentifier = subscribe.PacketIdentifier, ReasonCodes = [MqttSubscribeReasonCode.GrantedQoS1] });
        await subscribing.WaitAsync(Patience, Cancelled);

        // * a group's own filter, which its UNSUBSCRIBE names again
        var grouped = adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        var shared = await SubAckOf((link, 1));

        await grouped.WaitAsync(Patience, Cancelled);
        Assert.Equal("$share/interop/bead/s/interop", shared.TopicFilters[0].Topic);

        var leaving = adapter.Unsubscribe(Name);
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();

        Assert.Equal(["$share/interop/bead/s/interop"], unsubscribe.TopicFilters);
        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.Success] });
        await leaving.WaitAsync(Patience, Cancelled);

        // QoS 0 granted is refused, as a failure is
        var downgraded = adapter.Subscribe(["bead", "d", "bob"]);

        await SubAckOf((link, 0));
        Assert.Contains("0x00", (await FailureOf(() =>
        {
            return downgraded;
        })).Message, StringComparison.Ordinal);

        var failed = adapter.Subscribe(["bead", "d", "eve"]);

        await SubAckOf((link, 0x87));
        Assert.Contains("0x87", (await FailureOf(() =>
        {
            return failed;
        })).Message, StringComparison.Ordinal);
        await adapter.Stop();
    }

    [Fact]
    public async Task Refuses_a_group_once_its_CONNACK_says_Shared_Subscription_Available_0_or_its_SUBACK_0x9E_spec_15_25()
    {
        await using var adapter = AdapterOf();
        var unshared = ScriptedLink.ConnAck();

        unshared.SharedSubscriptionAvailable = false;

        var link = await LinkUp((adapter, _script), (unshared, null));

        Assert.Contains("no shared subscription", (await FailureOf(() =>
        {
            return adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        })).Message, StringComparison.Ordinal);
        await Task.Delay(50, Cancelled);
        Assert.Empty(link.PacketsOf<MqttSubscribePacket>());
        await adapter.Stop();

        // its SUBACK's 0x9E refuses that group, and every one after it on that link
        var again = await LinkUp((adapter, _script));
        var first = adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });

        await SubAckOf((again, 0x9E));
        Assert.Contains("0x9E", (await FailureOf(() =>
        {
            return first;
        })).Message, StringComparison.Ordinal);
        Assert.Contains("no shared subscription", (await FailureOf(() =>
        {
            return adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        })).Message, StringComparison.Ordinal);
        await adapter.Stop();

        // and an adapter told its broker offers none states it, and refuses one as asked
        await using var none = AdapterOf((options) =>
        {
            return options with { Groups = false };
        });

        Assert.Equal((BrokerCapabilities)0, none.Capabilities & BrokerCapabilities.Groups);
        Assert.Equal(BrokerCapabilities.Groups, adapter.Capabilities & BrokerCapabilities.Groups);
        Assert.IsType<ArgumentException>(await FailureOf(() =>
        {
            return none.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        }));
    }

    [Fact]
    public async Task Publishes_at_QoS_1_and_RETAIN_0_a_life_in_whole_seconds_rounded_up_where_one_is_asked_and_no_other_property_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));
        byte[] payload = [1, 2, 3];

        foreach (var expiresAfter in new TimeSpan?[] { null, TimeSpan.FromMilliseconds(1), TimeSpan.FromMilliseconds(1_000), TimeSpan.FromMilliseconds(1_001), TimeSpan.FromMilliseconds(60_000) })
        {
            var publishing = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = payload, ExpiresAfter = expiresAfter });
            var publish = await link.Next<MqttPublishPacket>();

            await PubAckOf((link, publish.PacketIdentifier, 0));
            Assert.Equal(BrokerPublished.Taken, await publishing.WaitAsync(Patience, Cancelled));
            Assert.Equal(
                ("010203", expiresAfter is { } life ? (uint)Math.Max(1, Math.Ceiling(life.TotalMilliseconds / 1_000)) : 0u, MqttQualityOfServiceLevel.AtLeastOnce, false, "bead/i/ada"),
                (Convert.ToHexString(publish.Payload.ToArray()), publish.MessageExpiryInterval, publish.QualityOfServiceLevel, publish.Retain, publish.Topic));

            // * no other property: no alias, response topic, correlation, user property, subscription
            // identifier, format or content type
            Assert.Equal(
                ((ushort)0, (string?)null, (byte[]?)null, 0, 0, MqttPayloadFormatIndicator.Unspecified, (string?)null),
                (publish.TopicAlias, publish.ResponseTopic, publish.CorrelationData, publish.UserProperties?.Count ?? 0, publish.SubscriptionIdentifiers?.Count ?? 0, publish.PayloadFormatIndicator, publish.ContentType));
        }

        await adapter.Stop();

        // at most once, each of QoS 0, which no PUBACK answers
        await using var quick = AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce };
        });
        var quickLink = await LinkUp((quick, _script));

        Assert.Equal((BrokerCapabilities)0, quick.Capabilities & BrokerCapabilities.NoSubscriber);
        Assert.Equal(BrokerPublished.Taken, await quick.Publish(new BrokerPublication { Topic = Inbox, Payload = payload }).WaitAsync(Patience, Cancelled));
        Assert.Equal(MqttQualityOfServiceLevel.AtMostOnce, (await quickLink.Next<MqttPublishPacket>()).QualityOfServiceLevel);
        await quick.Stop();
    }

    [Fact]
    public async Task Holds_its_QoS_1_publications_to_its_CONNACK_s_Receive_Maximum_the_next_one_going_once_a_PUBACK_came_and_delays_no_other_packet_for_them_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var answer = ScriptedLink.ConnAck();

        answer.ReceiveMaximum = 2;

        var link = await LinkUp((adapter, _script), (answer, null));
        var publishing = Enumerable.Range(1, 5).Select((index) =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[(byte)index] });
        }).ToList();

        await Task.Delay(100, Cancelled);
        Assert.Equal(2, link.PacketsOf<MqttPublishPacket>().Count);

        // * a SUBSCRIBE goes past them, its quota none of theirs
        var subscribing = adapter.Subscribe(["bead", "d", "bob"]);

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);
        Assert.Equal(2, link.PacketsOf<MqttPublishPacket>().Count);

        foreach (var expected in new[] { 3, 4, 5 })
        {
            var oldest = link.PacketsOf<MqttPublishPacket>()[expected - 3];

            await PubAckOf((link, oldest.PacketIdentifier, 0));
            await Until(() =>
            {
                return link.PacketsOf<MqttPublishPacket>().Count == expected;
            });
            Assert.Equal(expected, link.PacketsOf<MqttPublishPacket>().Count);
        }

        foreach (var publish in link.PacketsOf<MqttPublishPacket>().Skip(3))
        {
            await PubAckOf((link, publish.PacketIdentifier, 0));
        }

        Assert.Equal(Enumerable.Repeat(BrokerPublished.Taken, 5), await Task.WhenAll(publishing).WaitAsync(Patience, Cancelled));
        Assert.Equal([1, 2, 3, 4, 5], link.PacketsOf<MqttPublishPacket>().Select((publish) =>
        {
            return (int)publish.Payload.FirstSpan[0];
        }));
        await adapter.Stop();
    }

    [Fact]
    public async Task Reads_a_PUBACK_of_0x10_as_no_subscriber_under_0x80_as_taken_and_0x80_or_more_as_refused_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));

        async Task<BrokerPublished> Answered(int reasonCode)
        {
            var publishing = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
            var publish = await link.Next<MqttPublishPacket>();

            await PubAckOf((link, publish.PacketIdentifier, reasonCode));

            return await publishing.WaitAsync(Patience, Cancelled);
        }

        Assert.Equal(BrokerPublished.NoSubscriber, await Answered(0x10));
        Assert.Equal(BrokerPublished.Taken, await Answered(0x00));
        Assert.Contains("0x87", (await FailureOf(() =>
        {
            return Answered(0x87);
        })).Message, StringComparison.Ordinal);
        Assert.Contains("0x80", (await FailureOf(() =>
        {
            return Answered(0x80);
        })).Message, StringComparison.Ordinal);
        Assert.Equal(BrokerCapabilities.NoSubscriber, adapter.Capabilities & BrokerCapabilities.NoSubscriber);
        await adapter.Stop();
    }

    [Fact]
    public async Task Refuses_a_publication_past_its_CONNACK_s_Maximum_Packet_Size_before_it_goes_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var answer = ScriptedLink.ConnAck();

        answer.MaximumPacketSize = 1_024;

        var link = await LinkUp((adapter, _script), (answer, null));
        var room = adapter.MaximumPayloadBytes(Inbox);

        // its bound counts a life, whatever the publication
        Assert.Equal(MqttPackets.LargestPayload(("bead/i/ada", 1_024), new MqttPublishShape(1, true)), room);

        var fits = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = new byte[room], ExpiresAfter = TimeSpan.FromSeconds(1) });
        var publish = await link.Next<MqttPublishPacket>();

        await PubAckOf((link, publish.PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await fits.WaitAsync(Patience, Cancelled));
        Assert.Contains("past its broker's Maximum Packet Size, 1024 bytes", Assert.IsType<ArgumentException>(await FailureOf(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = new byte[room + 1], ExpiresAfter = TimeSpan.FromSeconds(1) });
        })).Message, StringComparison.Ordinal);
        await Task.Delay(50, Cancelled);
        Assert.Single(link.PacketsOf<MqttPublishPacket>());
        await adapter.Stop();
    }

    [Fact]
    public async Task Hands_each_message_on_before_its_PUBACK_which_goes_once_it_is_settled_and_once_spec_15_29()
    {
        await using var adapter = AdapterOf();
        var (messages, _) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        await link.Send(PublishOf(("bead/i/ada", [9], 7)));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });

        var message = Assert.Single(messages);

        Assert.Equal(("09", "bead/i/ada"), (Convert.ToHexString(message.Payload.Span), string.Join('/', message.Topic)));
        Assert.Equal(1, adapter.Unsettled);
        await Task.Delay(50, Cancelled);
        Assert.Empty(link.PacketsOf<MqttPubAckPacket>());

        message.Settle();
        message.Settle();

        var puback = await link.Next<MqttPubAckPacket>();

        Assert.Equal(((ushort)7, MqttPubAckReasonCode.Success), (puback.PacketIdentifier, puback.ReasonCode));
        Assert.Equal(0, adapter.Unsettled);
        await Task.Delay(50, Cancelled);
        Assert.Single(link.PacketsOf<MqttPubAckPacket>());
        Assert.Single(messages);
        await adapter.Stop();
    }

    [Fact]
    public async Task Drops_a_message_whose_RETAIN_is_1_acknowledging_it_spec_15_29()
    {
        await using var adapter = AdapterOf();
        await using var participant = new BrokerParticipant(adapter, new BrokerParticipantOptions { Heartbeat = Timeout.InfiniteTimeSpan });
        var errors = new ConcurrentQueue<Exception>();

        participant.Error += errors.Enqueue;

        var starting = participant.Start();
        var link = await _script.Link();

        await link.Send(ScriptedLink.ConnAck());
        await SubAckOf((link, 1));
        await starting.WaitAsync(Patience, Cancelled);
        await link.Send(PublishOf(("bead/i/ada", [0xFF], 3), isRetained: true));

        var puback = await link.Next<MqttPubAckPacket>();

        Assert.Equal(((ushort)3, MqttPubAckReasonCode.Success), (puback.PacketIdentifier, puback.ReasonCode));
        Assert.Equal(0, adapter.Unsettled);
        Assert.Empty(errors);
        await participant.Stop();
    }

    [Fact]
    public async Task Closes_its_link_no_DISCONNECT_on_a_packet_past_its_own_Maximum_Packet_Size_spec_15_29()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_100 };
        });
        var (messages, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        await link.Send(PublishOf(("bead/i/ada", new byte[1_100], 1)));
        await link.Closed.WaitAsync(Patience, Cancelled);
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.DoesNotContain(link.Packets, (packet) =>
        {
            return packet is MqttDisconnectPacket or MqttPubAckPacket;
        });
    }

    [Fact]
    public async Task Announces_as_its_receive_bound_the_largest_payload_of_a_message_to_its_inbox_within_its_Maximum_Packet_Size_a_life_counted_spec_15_30()
    {
        await using var server = AdapterOf();
        await using var peer = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 4_096 };
        });

        Assert.Equal(16_777_188, server.ReceiveBound(["bead", "i", "server"]));
        Assert.Equal(4_072, peer.ReceiveBound(["bead", "i", "peer"]));
        Assert.Equal(16_777_216, MqttPackets.MaximumPacketSize);

        // a bound whose receive bound is under 1,024 is refused as its participant is built, and one
        // past what MQTT 5 writes as the adapter is
        await using var small = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_000 };
        });

        Assert.StartsWith("a participant's inbox takes a parcel of 1,024 bytes at least", Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(small);
        }).Message, StringComparison.Ordinal);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return AdapterOf((options) =>
            {
                return options with { MaximumPacketSize = 268_435_461 };
            });
        });
    }

    [Fact]
    public async Task Tells_its_link_lost_once_and_nothing_of_a_lost_link_reaches_the_next_no_message_no_acknowledgement_no_PUBACK_s_reason_no_quota_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var single = ScriptedLink.ConnAck();

        single.ReceiveMaximum = 1;

        var first = await LinkUp((adapter, _script), (single, null));

        await first.Send(PublishOf(("bead/i/ada", [1], 5)));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });

        var pending = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1] });
        var waiting = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[2] });
        var sent = await first.Next<MqttPublishPacket>();

        first.Cut();
        Assert.IsType<IOException>(await FailureOf(() =>
        {
            return pending;
        }));
        Assert.IsType<IOException>(await FailureOf(() =>
        {
            return waiting;
        }));
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        await Task.Delay(50, Cancelled);
        Assert.Equal([new BrokerDown()], downs);

        // * the next link's quota is its own, and the former's message is acknowledged on none
        var second = await LinkUp((adapter, _script), (single, null));

        Assert.Single(messages).Settle();
        Assert.Equal(0, adapter.Unsettled);

        // a PUBACK of the former's packet identifier taken as no reason of the next
        await PubAckOf((second, sent.PacketIdentifier, 0x10));
        await Task.Delay(50, Cancelled);

        var next = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[3] });
        var publish = await second.Next<MqttPublishPacket>();

        await PubAckOf((second, publish.PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await next.WaitAsync(Patience, Cancelled));
        await Task.Delay(50, Cancelled);
        Assert.Empty(second.PacketsOf<MqttPubAckPacket>());
        Assert.Single(downs);
        await adapter.Stop();
    }

    [Fact]
    public async Task Refuses_what_is_asked_while_its_link_is_down_and_leaves_no_library_to_reconnect_subscribe_again_or_hold_a_publication_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);

        async Task NotUp(Func<Task> asked)
        {
            Assert.Equal("the link of ada is not up", Assert.IsType<InvalidOperationException>(await FailureOf(asked)).Message);
        }

        await NotUp(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1] });
        });
        await NotUp(() =>
        {
            return adapter.Subscribe(Inbox);
        });
        await NotUp(() =>
        {
            return adapter.Unsubscribe(Inbox);
        });

        var link = await LinkUp((adapter, _script));
        var subscribing = adapter.Subscribe(Inbox);

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);
        link.Cut();
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        await NotUp(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1] });
        });

        // no link comes of its own, and the next one subscribes nothing nor sends what was refused
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(1_500));
        });

        var next = await LinkUp((adapter, _script));

        await Task.Delay(100, Cancelled);
        Assert.IsType<MqttConnectPacket>(Assert.Single(next.Packets));
        await adapter.Stop();
    }

    [Fact]
    public async Task Gives_up_a_start_a_subscription_or_a_publication_its_signal_aborts_a_publication_that_waits_on_its_quota_leaving_it_unsent_and_retires_its_link_where_what_it_asked_may_have_gone()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        using var given = new CancellationTokenSource();
        var starting = adapter.Start(new BrokerStart { CancellationToken = given.Token });

        await _script.Link();
        await given.CancelAsync();
        await FailureOf(() =>
        {
            return starting;
        });
        Assert.Empty(downs);

        var single = ScriptedLink.ConnAck();

        single.ReceiveMaximum = 1;

        var link = await LinkUp((adapter, _script), (single, null));
        var first = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1] });
        using var leaving = new CancellationTokenSource();
        var waiting = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[2], CancellationToken = leaving.Token });

        await link.Next<MqttPublishPacket>();
        await leaving.CancelAsync();
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
        {
            return waiting;
        }));

        // * its link kept: the first still awaits its PUBACK, and nothing goes after it
        await PubAckOf((link, link.PacketsOf<MqttPublishPacket>()[0].PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await first.WaitAsync(Patience, Cancelled));
        await Task.Delay(50, Cancelled);
        Assert.Single(link.PacketsOf<MqttPublishPacket>());
        Assert.Empty(downs);

        // a subscription given up once its SUBSCRIBE went retires its link
        using var cancelled = new CancellationTokenSource();
        var subscribing = adapter.Subscribe(Inbox, new BrokerSubscription { CancellationToken = cancelled.Token });

        await link.Next<MqttSubscribePacket>();
        await cancelled.CancelAsync();
        await FailureOf(() =>
        {
            return subscribing;
        });
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown()], downs);
        await link.Closed.WaitAsync(Patience, Cancelled);

        // and a signal aborted already sends nothing
        var again = await LinkUp((adapter, _script));

        await FailureOf(() =>
        {
            return adapter.Subscribe(Inbox, new BrokerSubscription { CancellationToken = new CancellationToken(true) });
        });
        await FailureOf(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1], CancellationToken = new CancellationToken(true) });
        });
        await Task.Delay(50, Cancelled);
        Assert.IsType<MqttConnectPacket>(Assert.Single(again.Packets));
        await adapter.Stop();
    }

    [Fact]
    public void Is_secure_over_mqtts_and_wss_and_over_mqtt_and_ws_to_the_loopback_alone()
    {
        static bool IsSecure(string uri)
        {
            return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Uri = new Uri(uri) }).IsSecure;
        }

        string[] uris =
        [
            "mqtts://broker.example:8883",
            "wss://broker.example/mqtt",
            "mqtt://127.0.0.1:1883",
            "ws://localhost:9001/mqtt",
            "mqtt://[::1]:1883",
            "mqtt://broker.example:1883",
            "ws://broker.example/mqtt",
        ];

        Assert.Equal([true, true, true, true, true, false, false], uris.Select(IsSecure));
        Assert.Throws<ArgumentException>(() =>
        {
            return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Uri = new Uri("http://broker.example") });
        });
    }

    [Fact(Skip = MqttFixture.Reason, SkipUnless = nameof(IsMqtt))]
    public async Task Carries_a_link_over_a_WebSocket_of_subprotocol_mqtt_spec_15_25()
    {
        await using var adapter = new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = FixtureUser, Password = MqttFixture.Password, Uri = MqttFixture.WebSocketUrl });
        string[] inbox = ["bead", "i", FixtureUser];
        var kinds = new ConcurrentQueue<string>();

        adapter.Message += (message) =>
        {
            var read = BrokerParcels.Read(message.Payload);

            kinds.Enqueue(read.Parcel is { } parcel ? BrokerParcels.KindNamed(parcel.Kind) : read.Why ?? "nothing");
            message.Settle();
        };
        await adapter.Start();

        try
        {
            await adapter.Subscribe(inbox);

            var parcel = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Reset, Opener = 0x0102030405060708, Acceptor = 0x0807060504030201 });

            Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = inbox, Payload = parcel, ExpiresAfter = TimeSpan.FromSeconds(5) }).WaitAsync(Patience, Cancelled));
            await Until(() =>
            {
                return !kinds.IsEmpty;
            });
            Assert.Equal([BrokerParcels.KindNamed(BrokerParcelKinds.Reset)], kinds);
            Assert.Equal(0, adapter.Unsettled);

            // an inbox no one reads is the broker's 0x10
            Assert.Equal(BrokerPublished.NoSubscriber, await adapter.Publish(new BrokerPublication { Topic = ["bead", "i", "nobody"], Payload = parcel }).WaitAsync(Patience, Cancelled));
        }
        finally
        {
            await adapter.Stop();
        }
    }

    /// <summary>Whether a broker is given, or asked for: the fixture's tests run, and fail where none is.</summary>
    public static bool IsMqtt
    {
        get
        {
            return MqttFixture.IsGiven;
        }
    }
}
