using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using MQTTnet.Formatter;
using MQTTnet.Formatter.V5;
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
[Collection(MqttFixture.Collection)]
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

    // ! users of the broker's that read every name, its cases' own: no case plays meanwhile, the
    // classes that play against the broker one collection
    private static readonly string[] GroupUsers = ["quiet", "late", "flagged"];

    // the peers whose departures a stop lets go of
    private static readonly string[] Departed = ["amy", "bea", "cyd", "dot", "eve"];

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

    // the filters the UNSUBSCRIBEs that came named, in their order
    private static List<string> LetGoOf(ScriptedLink link)
    {
        return [.. link.PacketsOf<MqttUnsubscribePacket>().SelectMany((unsubscribe) =>
        {
            return unsubscribe.TopicFilters;
        })];
    }

    // the bytes a packet takes, as MQTTnet's encoder writes MQTT 5
    private static int BytesOf(MqttPacket packet)
    {
        return EncodedOf(packet).Length;
    }

    // a packet's bytes, as MQTTnet's encoder writes MQTT 5, for a write that carries others beside it
    private static byte[] EncodedOf(MqttPacket packet)
    {
        return new MqttV5PacketEncoder(new MqttBufferWriter(4_096, 65_536)).Encode(packet).Join().ToArray();
    }

    // its stop, called under the context given, which its continuations then go by
    private static Task StopUnder((MqttBrokerAdapter Adapter, SynchronizationContext? Context) stopped)
    {
        var previous = SynchronizationContext.Current;

        SynchronizationContext.SetSynchronizationContext(stopped.Context);

        try
        {
            return stopped.Adapter.Stop();
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }
    }

    private static Task PubAckOf((ScriptedLink Link, ushort PacketIdentifier, int Code) answer)
    {
        return answer.Link.Send(new MqttPubAckPacket { PacketIdentifier = answer.PacketIdentifier, ReasonCode = (MqttPubAckReasonCode)answer.Code });
    }

    // a Packet Identifier's two bytes, as a packet written by hand carries it
    private static byte[] IdentifierOf(ushort packetIdentifier)
    {
        return [(byte)(packetIdentifier >> 8), (byte)packetIdentifier];
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

    // a link up on a script of its own under the Keep Alive and the CONNACK given, which its broker
    // answers nothing after: its PINGREQ, then its link lost at half its Keep Alive in force, no
    // DISCONNECT sent (spec 15.26)
    private static async Task LostUnanswered((string Case, TimeSpan KeepAlive, byte[] ConnAck) silent)
    {
        await using var script = MqttScript.Start();
        await using var adapter = new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Password = Password, Uri = script.Uri, KeepAlive = silent.KeepAlive });
        var (_, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        var link = await script.Link();

        await link.Write(silent.ConnAck);
        await starting.WaitAsync(Patience, Cancelled);

        var watch = Stopwatch.StartNew();

        await link.Next<MqttPingReqPacket>(TimeSpan.FromSeconds(4));
        Assert.True(watch.Elapsed < TimeSpan.FromMilliseconds(2_600), $"{silent.Case}: its PINGREQ went after {watch.ElapsedMilliseconds} ms");

        var pinged = Stopwatch.StartNew();

        await Task.Delay(TimeSpan.FromMilliseconds(700), Cancelled);
        Assert.True(downs.IsEmpty, $"{silent.Case}: its down was told within 700 ms of its PINGREQ");
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.True(pinged.Elapsed < TimeSpan.FromMilliseconds(1_700), $"{silent.Case}: its down was told {pinged.ElapsedMilliseconds} ms after its PINGREQ");
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(link.PacketsOf<MqttDisconnectPacket>());
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

    // an adapter of the id to a WebSocket the listener given answers by hand, its options changed as told
    private static MqttBrokerAdapter WebSocketAdapterOf(System.Net.Sockets.TcpListener listener, Func<MqttBrokerAdapterOptions, MqttBrokerAdapterOptions>? changed = null)
    {
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var options = new MqttBrokerAdapterOptions { Id = Id, Password = Password, Uri = new Uri($"ws://127.0.0.1:{port}/mqtt") };

        return new MqttBrokerAdapter(changed?.Invoke(options) ?? options);
    }

    // the adapter's next WebSocket on the listener, its upgrade read whole and answered with a 101
    // of subprotocol mqtt, then served as its broker's end (RFC 6455 §4.2.2)
    private static async Task<UpgradedPeer> UpgradedOf(System.Net.Sockets.TcpListener listener)
    {
        var peer = await listener.AcceptTcpClientAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);

        try
        {
            var stream = peer.GetStream();
            var head = new List<byte>();
            var octet = new byte[1];

            while (!Encoding.ASCII.GetString([.. head]).EndsWith("\r\n\r\n", StringComparison.Ordinal))
            {
                await stream.ReadExactlyAsync(octet, Cancelled).AsTask().WaitAsync(Patience, Cancelled);
                head.Add(octet[0]);
            }

            var text = Encoding.ASCII.GetString([.. head]);
            var key = text.Split("\r\n").Single((line) =>
            {
                return line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase);
            })["Sec-WebSocket-Key:".Length..].Trim();
            // the handshake's own hash, which RFC 6455 names: nothing secret rests on it
#pragma warning disable CA5350
            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes($"{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
#pragma warning restore CA5350

            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n"), Cancelled);

            var broker = System.Net.WebSockets.WebSocket.CreateFromStream(stream, new System.Net.WebSockets.WebSocketCreationOptions { IsServer = true, SubProtocol = "mqtt", KeepAliveInterval = TimeSpan.Zero });

            return new UpgradedPeer { Head = text, Peer = peer, Broker = broker };
        }
        catch
        {
            peer.Dispose();

            throw;
        }
    }

    // the adapter's CONNECT read off its WebSocket, which comes first
    private static async Task ConnectReadOf(System.Net.WebSockets.WebSocket broker)
    {
        await broker.ReceiveAsync(new byte[4_096], Cancelled).WaitAsync(Patience, Cancelled);
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
                    return ValueTask.FromResult($"{Password}-{Interlocked.Increment(ref asked)}");
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
    public async Task Fails_its_start_on_a_refusing_CONNACK_naming_its_code_and_its_MQTT_5_name()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);

        foreach (var (code, name) in new (byte, string?)[]
        {
            (0x80, "Unspecified error"),
            (0x81, "Malformed Packet"),
            (0x82, "Protocol Error"),
            (0x83, "Implementation specific error"),
            (0x84, "Unsupported Protocol Version"),
            (0x85, "Client Identifier not valid"),
            (0x86, "Bad User Name or Password"),
            (0x87, "Not authorized"),
            (0x88, "Server unavailable"),
            (0x89, "Server busy"),
            (0x8A, "Banned"),
            (0x8C, "Bad authentication method"),
            (0x90, "Topic Name invalid"),
            (0x95, "Packet too large"),
            (0x97, "Quota exceeded"),
            (0x99, "Payload format invalid"),
            (0x9A, "Retain not supported"),
            (0x9B, "QoS not supported"),
            (0x9C, "Use another server"),
            (0x9D, "Server moved"),
            (0x9F, "Connection rate exceeded"),
            (0x01, null),
        })
        {
            var starting = adapter.Start();
            var link = await _script.Link();

            await link.Send(new MqttConnAckPacket
            {
                ReasonCode = (MqttConnectReasonCode)code,
                MaximumQoS = MqttQualityOfServiceLevel.ExactlyOnce,
                RetainAvailable = true,
                SharedSubscriptionAvailable = true,
            });
            var reason = string.Create(CultureInfo.InvariantCulture, $"0x{code:X2}") + (name is null ? "" : $", {name}");
            var refused = Assert.IsType<IOException>(await FailureOf(() =>
            {
                return starting;
            }));

            Assert.Equal($"its broker refused the link of ada: CONNACK {reason}", refused.Message);
            Assert.False(adapter.IsLinked);
            await link.Closed.WaitAsync(Patience, Cancelled);
            Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
        }

        Assert.Empty(downs);
    }

    [Fact]
    public async Task Fails_its_start_on_a_CONNACK_whose_Maximum_QoS_is_0_naming_it_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var limited = ScriptedLink.ConnAck();

        limited.MaximumQoS = MqttQualityOfServiceLevel.AtMostOnce;

        var limiting = adapter.Start();
        var link = await _script.Link();

        await link.Send(limited);
        Assert.Contains("Maximum QoS 0", (await FailureOf(() =>
        {
            return limiting;
        })).Message, StringComparison.Ordinal);
        Assert.Empty(downs);

        // * a start that fails sends nothing: no DISCONNECT
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));

        // a CONNACK that refuses fails it too, naming its reason
        var starting = adapter.Start();
        var refused = await _script.Link();

        await refused.Send(new MqttConnAckPacket { ReasonCode = MqttConnectReasonCode.BadUserNameOrPassword, MaximumQoS = MqttQualityOfServiceLevel.ExactlyOnce, RetainAvailable = true, SharedSubscriptionAvailable = true });
        Assert.Contains("CONNACK 0x86, Bad User Name or Password", (await FailureOf(() =>
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
    public async Task Fails_its_start_where_its_broker_cannot_be_reached_over_TCP_TLS_or_a_WebSocket_naming_why()
    {
        int port;

        // a port no one listens on any more
        using (var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0))
        {
            listener.Start();
            port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
        }

        // * and a host no name resolves to (RFC 6761 §6.4), on the port of its scheme
        foreach (var uri in new[] { $"mqtt://127.0.0.1:{port}", $"mqtts://127.0.0.1:{port}", $"ws://127.0.0.1:{port}/mqtt", $"wss://127.0.0.1:{port}/mqtt", "mqtt://broker.invalid", "mqtts://broker.invalid" })
        {
            await using var adapter = AdapterOf((options) =>
            {
                return options with { Uri = new Uri(uri) };
            });
            var (_, downs) = HeardOf(adapter);

            Assert.Contains("the link of ada ended before its CONNACK", Assert.IsType<IOException>(await FailureOf(() =>
            {
                return adapter.Start();
            })).Message, StringComparison.Ordinal);
            Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));
        }
    }

    [Fact]
    public async Task Fails_its_start_over_TLS_where_its_broker_s_certificate_chains_to_no_authority_it_trusts()
    {
        await using var secured = MqttScript.Start(Certificate.Value);
        await using var untrusting = new MqttBrokerAdapter(new MqttBrokerAdapterOptions
        {
            Id = Id,
            Tls = new MqttBrokerTlsOptions { ClientCertificates = [Certificate.Value] },
            Uri = secured.Uri,
        });

        Assert.Contains("the link of ada ended before its CONNACK", Assert.IsType<IOException>(await FailureOf(() =>
        {
            return untrusting.Start();
        })).Message, StringComparison.Ordinal);

        // * no CONNECT went: its broker's certificate was refused before it
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return secured.Link(TimeSpan.FromMilliseconds(200));
        });
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

    // spec 15.26: MQTTnet's loop on its own period keeps it; a bump that applies the Server Keep Alive fails here
    [Fact]
    public async Task Keeps_its_own_Keep_Alive_under_a_Server_Keep_Alive_of_0_or_longer_than_its_own_spec_15_26()
    {
        foreach (var server in new byte[] { 0, 3 })
        {
            await using var adapter = AdapterOf((options) =>
            {
                return options with { KeepAlive = TimeSpan.FromSeconds(1) };
            });
            var starting = adapter.Start();
            var link = await _script.Link();

            // * a CONNACK written by hand, its Server Keep Alive (0x13) on the wire: MQTTnet's encoder
            // writes none of 0
            await link.Write([0x20, 0x06, 0, 0, 0x03, 0x13, 0, server]);
            await starting.WaitAsync(Patience, Cancelled);

            var watch = Stopwatch.StartNew();

            await link.Next<MqttPingReqPacket>(TimeSpan.FromSeconds(3));
            Assert.True(watch.Elapsed < TimeSpan.FromMilliseconds(2_500), $"{server}: its PINGREQ went after {watch.ElapsedMilliseconds} ms");
            await link.Send(MqttPingRespPacket.Instance);
            await adapter.Stop();
        }
    }

    [Fact]
    public async Task Loses_its_link_once_its_PINGREQ_has_no_PINGRESP_within_half_its_Keep_Alive_in_force_spec_15_26()
    {
        // * a CONNACK of 0x00 that names no Server Keep Alive, one of 2 under a Keep Alive of 30,
        // and one of 0 (0x13), each on a script of its own
        await Task.WhenAll(
            LostUnanswered(("none", TimeSpan.FromSeconds(2), [0x20, 0x03, 0, 0, 0])),
            LostUnanswered(("2 of 30", TimeSpan.FromSeconds(30), [0x20, 0x06, 0, 0, 0x03, 0x13, 0, 2])),
            LostUnanswered(("0", TimeSpan.FromSeconds(2), [0x20, 0x06, 0, 0, 0x03, 0x13, 0, 0])));
    }

    [Fact]
    public async Task Runs_a_Keep_Alive_under_a_second_as_its_CONNECT_announces_it_a_whole_second_rounded_up_spec_15_26()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { KeepAlive = TimeSpan.FromMilliseconds(200) };
        });
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));
        var watch = Stopwatch.StartNew();

        Assert.Equal(1, link.Connect.KeepAlivePeriod);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return link.Next<MqttPingReqPacket>(TimeSpan.FromMilliseconds(700) - watch.Elapsed);
        });
        await link.Next<MqttPingReqPacket>(TimeSpan.FromMilliseconds(2_000) - watch.Elapsed);
        Assert.True(watch.Elapsed >= TimeSpan.FromMilliseconds(900), $"its PINGREQ went after {watch.ElapsedMilliseconds} ms");

        // * half of the second it runs, not of 200 ms
        await Task.Delay(TimeSpan.FromMilliseconds(300), Cancelled);
        Assert.Empty(downs);
        await link.Send(MqttPingRespPacket.Instance);
        Assert.Single(link.PacketsOf<MqttPingReqPacket>());
        await adapter.Stop();
        Assert.Empty(downs);
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

        // what its stop finds unsettled fails, nothing of it left to a later link
        var pending = adapter.Subscribe(Inbox);

        await link.Next<MqttSubscribePacket>();
        await adapter.Stop();

        // * its SUBSCRIBE under way let go before its DISCONNECT
        Assert.Equal(["bead/i/ada"], LetGoOf(link));
        Assert.Equal("the link of ada stopped", (await FailureOf(() =>
        {
            return pending;
        })).Message);

        var disconnect = await link.Next<MqttDisconnectPacket>();

        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, disconnect.ReasonCode);
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
    }

    [Fact]
    public async Task Ends_a_participant_s_link_with_a_DISCONNECT_of_0x00_when_its_stop_meets_its_inbox_s_SUBSCRIBE_spec_15_21()
    {
        await using var participant = new BrokerParticipant(AdapterOf());
        var starting = participant.Start();
        var link = await _script.Link();

        // its CONNACK granted, its inbox's SUBSCRIBE left unanswered
        await link.Send(ScriptedLink.ConnAck());
        await link.Next<MqttSubscribePacket>();
        await participant.Stop().WaitAsync(Patience, Cancelled);

        // * its adapter's stop ends that SUBSCRIBE, cleanly, its broker letting its filter go: no
        // will goes
        Assert.Equal("the participant ada stopped as it started", (await FailureOf(() =>
        {
            return starting;
        })).Message);

        var disconnect = await link.Next<MqttDisconnectPacket>();

        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, disconnect.ReasonCode);
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Equal([typeof(MqttConnectPacket), typeof(MqttSubscribePacket), typeof(MqttUnsubscribePacket), typeof(MqttDisconnectPacket)], link.Packets.Select((packet) =>
        {
            return packet.GetType();
        }));
        Assert.Equal(["bead/i/ada"], Assert.Single(link.PacketsOf<MqttUnsubscribePacket>()).TopicFilters);
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
    public async Task Tells_its_link_taken_over_on_a_DISCONNECT_of_0x8E_whatever_else_it_carries_a_Session_Expiry_Interval_among_it_spec_15_21()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        // * a DISCONNECT of 0x8E, its Session Expiry Interval of 0 and its Reason String "n", which a
        // broker never sends together ([MQTT-3.14.2-2]) and which end its link all the same
        // ([MQTT-3.14.4-2])
        await link.Write([0xE0, 0x0B, 0x8E, 0x09, 0x11, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x00, 0x01, (byte)'n']);
        link.End();
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown { IsTakenOver = true }], downs);
        Assert.False(adapter.IsLinked);
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
    }

    [Fact]
    public async Task Subscribes_at_QoS_1_No_Local_0_Retain_As_Published_0_and_Retain_Handling_2_a_group_as_its_shared_subscription_held_once_its_SUBACK_grants_QoS_1_refused_on_QoS_0_or_2_granted_its_filter_kept_and_on_0x80_or_more_spec_15_27()
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
        _script.IsHoldingUnsubscribes = true;

        var leaving = adapter.Unsubscribe(Name);
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();

        Assert.Equal(["$share/interop/bead/s/interop"], unsubscribe.TopicFilters);
        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.Success] });
        await leaving.WaitAsync(Patience, Cancelled);
        _script.IsHoldingUnsubscribes = false;

        // * QoS 0 or 2 granted is refused, its filter kept, as one its broker holds; any code of
        // 0x80 or more refused, its filter forgotten, 0x95 among them, which SUBACK's table does
        // not name
        foreach (var (peer, code) in new[] { ("bob", 0x00), ("cyd", 0x02), ("eve", 0x87), ("fay", 0x95) })
        {
            var refused = adapter.Subscribe(["bead", "d", peer]);

            await SubAckOf((link, code));
            Assert.Contains(string.Create(CultureInfo.InvariantCulture, $"SUBACK 0x{code:X2}"), (await FailureOf(() =>
            {
                return refused;
            })).Message, StringComparison.Ordinal);
        }

        Assert.True(adapter.IsLinked);
        await adapter.Stop();

        // * its stop lets go of what its broker holds, QoS 0 and 2 granted among it, and of nothing
        // refused of 0x80 or more or let go before it
        Assert.Equal(["bead/d/bob", "bead/d/cyd", "bead/i/ada"], LetGoOf(link).Skip(1).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Lets_a_subscription_go_once_its_UNSUBACK_came_naming_the_topic_itself_where_it_held_none_and_refuses_it_on_a_code_of_0x80_or_more_spec_15_27()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));

        _script.IsHoldingUnsubscribes = true;

        async Task<string> Answered((string[] Topic, MqttUnsubscribeReasonCode Code) answer)
        {
            var leaving = adapter.Unsubscribe(answer.Topic);
            var unsubscribe = await link.Next<MqttUnsubscribePacket>();

            await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [answer.Code] });
            await leaving.WaitAsync(Patience, Cancelled);

            return Assert.Single(unsubscribe.TopicFilters);
        }

        // * one its broker held none of is let go all the same, 0x11
        Assert.Equal("bead/d/bob", await Answered((["bead", "d", "bob"], MqttUnsubscribeReasonCode.NoSubscriptionExisted)));
        Assert.Equal("bead/d/bob", await Answered((["bead", "d", "bob"], MqttUnsubscribeReasonCode.Success)));

        var subscribing = adapter.Subscribe(["bead", "d", "eve"]);

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);

        // * a code of 0x80 or more, 0x95 among them, which UNSUBACK's table does not name; one under
        // 0x80 it does not name loses the link (spec 15.29)
        foreach (var code in new[] { 0x80, 0x83, 0x87, 0x8F, 0x91, 0x95 })
        {
            var refused = string.Create(CultureInfo.InvariantCulture, $"UNSUBACK 0x{code:X2}");

            Assert.Contains(refused, (await FailureOf(() =>
            {
                return Answered((["bead", "d", "eve"], (MqttUnsubscribeReasonCode)code));
            })).Message, StringComparison.Ordinal);
        }

        // its link kept, and the filter refused its stop's to let go
        Assert.True(adapter.IsLinked);
        _script.IsHoldingUnsubscribes = false;
        await adapter.Stop();
        Assert.Equal("bead/d/eve", LetGoOf(link)[^1]);
        Assert.Equal(9, LetGoOf(link).Count);
    }

    [Fact]
    public async Task Fails_an_unsubscription_whose_UNSUBACK_has_not_come_within_connectTimeout_its_link_kept_and_no_will_gone_then_reads_the_late_UNSUBACK_spec_15_27()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(300) };
        });
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));
        var subscribing = adapter.Subscribe(Name);

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);
        _script.IsHoldingUnsubscribes = true;

        // * no UNSUBACK within its connectTimeout of its UNSUBSCRIBE: it fails, naming it, its link
        // kept
        var leaving = adapter.Unsubscribe(Name);
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();
        var failure = await FailureOf(() =>
        {
            return leaving;
        });

        Assert.IsType<TimeoutException>(failure);
        Assert.Equal("the subscription of ada to bead/s/interop had no UNSUBACK within 300 ms, its connectTimeout", failure.Message);
        Assert.True(adapter.IsLinked);

        // * its UNSUBACK, come late, read: its link kept, its filter its link's no more, so that its
        // stop lets go of nothing more, then its DISCONNECT, no will
        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.Success] });
        await Task.Delay(200, Cancelled);
        Assert.True(adapter.IsLinked);
        Assert.Empty(downs);
        _script.IsHoldingUnsubscribes = false;
        await adapter.Stop().WaitAsync(Patience, Cancelled);
        Assert.Equal(["bead/s/interop"], LetGoOf(link));
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await link.Next<MqttDisconnectPacket>()).ReasonCode);
        Assert.Empty(downs);
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

        Assert.Equal((BrokerDelivery.AtMostOnce, (BrokerCapabilities)0), (quick.Delivery, quick.Capabilities & BrokerCapabilities.NoSubscriber));

        // its bound counts no Packet Identifier, which a QoS 0 PUBLISH has none of
        Assert.Equal(MqttPackets.LargestPayload(("bead/i/ada", MqttPackets.LargestPacketSize), new MqttPublishShape(0, true)), quick.MaximumPayloadBytes(Inbox));
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
        Assert.Equal(["bead/d/bob"], LetGoOf(link));
    }

    [Fact]
    public async Task Reads_a_PUBACK_of_0x00_or_of_none_as_taken_0x10_as_no_subscriber_and_0x80_or_more_as_refused_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        // its PUBACK of the code given, or of none, its Remaining Length 2, where none is given
        async Task<BrokerPublished> Answered(int? reasonCode)
        {
            var publishing = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
            var publish = await link.Next<MqttPublishPacket>();

            if (reasonCode is { } code)
            {
                await PubAckOf((link, publish.PacketIdentifier, code));
            }
            else
            {
                await link.Write([0x40, 0x02, .. IdentifierOf(publish.PacketIdentifier)]);
            }

            return await publishing.WaitAsync(Patience, Cancelled);
        }

        Assert.Equal(BrokerPublished.Taken, await Answered(null));
        Assert.Equal(BrokerPublished.Taken, await Answered(0x00));
        Assert.Equal(BrokerPublished.NoSubscriber, await Answered(0x10));

        // * every code of 0x80 or more its table names, and 0x95, which it does not
        foreach (var code in new[] { 0x80, 0x83, 0x87, 0x90, 0x91, 0x97, 0x99, 0x95 })
        {
            Assert.Contains(string.Create(CultureInfo.InvariantCulture, $"PUBACK 0x{code:X2}"), (await FailureOf(() =>
            {
                return Answered(code);
            })).Message, StringComparison.Ordinal);
        }

        Assert.True(adapter.IsLinked);
        Assert.Empty(downs);
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
    public async Task Reports_no_payload_room_where_its_CONNACK_s_Maximum_Packet_Size_cannot_hold_a_PUBLISH_to_the_topic_and_refuses_even_an_empty_publication_spec_15_28()
    {
        await using var adapter = AdapterOf();
        var answer = ScriptedLink.ConnAck();

        answer.MaximumPacketSize = 16;

        var link = await LinkUp((adapter, _script), (answer, null));

        Assert.Equal(0, adapter.MaximumPayloadBytes(Inbox));
        Assert.Contains("past its broker's Maximum Packet Size, 16 bytes", Assert.IsType<ArgumentException>(await FailureOf(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = Array.Empty<byte>() });
        })).Message, StringComparison.Ordinal);
        Assert.True(adapter.IsLinked);
        await Task.Delay(50, Cancelled);
        Assert.Empty(link.PacketsOf<MqttPublishPacket>());
        await adapter.Stop();
    }

    [Fact]
    public async Task Tells_its_link_up_once_its_CONNACK_came_and_bounds_what_it_publishes_by_that_CONNACK_s_Maximum_Packet_Size_the_last_link_s_while_it_is_down_spec_15_30()
    {
        await using var adapter = AdapterOf();

        (bool, long?) Read()
        {
            return (adapter.IsLinked, adapter.MaximumPayloadBytes(Inbox));
        }

        static long? BoundOf(long packetSize)
        {
            return MqttPackets.LargestPayload(("bead/i/ada", packetSize), new MqttPublishShape(1, true));
        }

        // * before any link, what MQTT 5 writes at most
        Assert.Equal((false, BoundOf(MqttPackets.LargestPacketSize)), Read());

        var limited = ScriptedLink.ConnAck();

        limited.MaximumPacketSize = 1_024;

        var first = await LinkUp((adapter, _script), (limited, null));

        Assert.Equal((true, BoundOf(1_024)), Read());
        first.Cut();
        await Until(() =>
        {
            return !adapter.IsLinked;
        });

        // the last link's while it is down, and while the next one starts
        Assert.Equal((false, BoundOf(1_024)), Read());

        var starting = adapter.Start();
        var second = await _script.Link();

        Assert.Equal((false, BoundOf(1_024)), Read());
        await second.Send(ScriptedLink.ConnAck());
        await starting.WaitAsync(Patience, Cancelled);
        Assert.Equal((true, BoundOf(MqttPackets.LargestPacketSize)), Read());
        await adapter.Stop();
        Assert.Equal((false, BoundOf(MqttPackets.LargestPacketSize)), Read());
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

        // * one of QoS 0, which no PUBACK answers, handed on with nothing to acknowledge
        var quick = PublishOf(("bead/i/ada", [8], 0));

        quick.QualityOfServiceLevel = MqttQualityOfServiceLevel.AtMostOnce;
        await link.Send(quick);
        await Until(() =>
        {
            return messages.Count > 1;
        });

        var last = messages.Last();

        last.Settle();
        Assert.Equal(("08", 0), (Convert.ToHexString(last.Payload.Span), adapter.Unsettled));
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
        Assert.Equal(["bead/i/ada"], LetGoOf(link));
    }

    [Fact]
    public async Task Closes_its_link_no_DISCONNECT_on_a_packet_past_its_own_Maximum_Packet_Size_read_at_its_length_spec_15_29()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_100 };
        });
        var (messages, downs) = HeardOf(adapter);

        void Unanswered(ScriptedLink closed)
        {
            Assert.DoesNotContain(closed.Packets, (packet) =>
            {
                return packet is MqttDisconnectPacket or MqttPubAckPacket;
            });
        }

        // a PUBLISH of 1,118 bytes in all, after its CONNACK
        var whole = await LinkUp((adapter, _script));

        await whole.Send(PublishOf(("bead/i/ada", new byte[1_100], 1)));
        await whole.Closed.WaitAsync(Patience, Cancelled);
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown()], downs);
        Unanswered(whole);

        // * its fixed header alone, announcing 16,777,221 bytes, and nothing after it: judged at its length
        var announced = await LinkUp((adapter, _script));

        await announced.Write([0x32, 0x80, 0x80, 0x80, 0x08]);
        await announced.Closed.WaitAsync(Patience, Cancelled);
        await Until(() =>
        {
            return downs.Count == 2;
        });
        Assert.Equal([new BrokerDown(), new BrokerDown()], downs);
        Unanswered(announced);

        // a CONNACK's fixed header announcing as much: its start fails
        var starting = adapter.Start();
        var refused = await _script.Link();

        await refused.Write([0x20, 0x80, 0x80, 0x80, 0x08]);
        Assert.Contains("past its Maximum Packet Size", Assert.IsType<IOException>(await FailureOf(() =>
        {
            return starting;
        })).Message, StringComparison.Ordinal);
        await refused.Closed.WaitAsync(Patience, Cancelled);
        Unanswered(refused);
        Assert.Equal([new BrokerDown(), new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Loses_its_link_no_DISCONNECT_on_a_packet_its_client_cannot_read_spec_15_29()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        // * a PUBLISH to its inbox carrying a property MQTT 5 does not define, 0x7F, and a Remaining
        // Length still continuing at its fourth byte (MQTT 5.0 §2.2.2.2, §1.5.5)
        byte[] unreadable = [0x30, 0x0F, 0x00, 0x0A, .. Encoding.UTF8.GetBytes("bead/i/ada"), 0x02, 0x7F, 0x00];

        async Task IsLostIn((ScriptedLink Link, int Count) lost)
        {
            await lost.Link.Closed.WaitAsync(Patience, Cancelled);
            await Until(() =>
            {
                return downs.Count >= lost.Count;
            });
            Assert.Equal(Enumerable.Repeat(new BrokerDown(), lost.Count), downs);
            Assert.False(adapter.IsLinked);
            Assert.IsType<MqttConnectPacket>(Assert.Single(lost.Link.Packets));
        }

        byte[][] packets = [unreadable, [0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0x01]];

        for (var index = 0; index < packets.Length; index += 1)
        {
            var link = await LinkUp((adapter, _script));

            await link.Write(packets[index]);
            await IsLostIn((link, index + 1));
        }

        // and beside its CONNACK in one read: its start succeeds, and its link is lost once
        var starting = adapter.Start();
        var beside = await _script.Link();

        await beside.Write([0x20, 0x03, 0x00, 0x00, 0x00, .. unreadable]);
        Assert.Null(await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        }));
        await IsLostIn((beside, 3));
        Assert.Empty(messages);
    }

    [Fact]
    public async Task Loses_its_link_no_DISCONNECT_on_an_acknowledgement_of_a_Reason_Code_under_0x80_its_table_does_not_name_or_of_a_count_of_codes_other_than_one_awaited_or_not_its_start_failed_before_its_CONNACK_spec_15_26_15_27_15_28_15_29()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);

        // * a PUBLISH to its inbox behind each, in the same write, never handed on
        var behind = EncodedOf(PublishOf(("bead/i/ada", [7], 9)));

        _script.IsHoldingUnsubscribes = true;

        // its link lost, told once, no DISCONNECT, what it was asked failed with that loss
        async Task IsLostOn((string Packet, Func<Task>? Ask) call, Func<ScriptedLink, Task<byte[]>> answer)
        {
            var link = await LinkUp((adapter, _script));
            var told = downs.Count;
            var asked = call.Ask?.Invoke();

            await link.Write([.. await answer(link), .. behind]);
            await link.Closed.WaitAsync(Patience, Cancelled);
            await Until(() =>
            {
                return downs.Count > told;
            });

            if (asked is not null)
            {
                var failure = Assert.IsType<IOException>(await FailureOf(() =>
                {
                    return asked;
                }));

                // * never refused nor taken: its link's loss, naming what its broker sent
                Assert.StartsWith($"the link of ada went down: its broker sent {call.Packet} ", failure.Message, StringComparison.Ordinal);
            }

            Assert.Equal(Enumerable.Repeat(new BrokerDown(), told + 1), downs);
            Assert.False(adapter.IsLinked);
            Assert.DoesNotContain(link.Packets, (packet) =>
            {
                return packet is MqttDisconnectPacket;
            });
            Assert.Empty(messages);
        }

        // an answer to the next packet of a kind the link reads, by its identifier
        Func<ScriptedLink, Task<byte[]>> To<T>(Func<byte[], byte[]> answer)
            where T : MqttPacket
        {
            return async (link) =>
            {
                var packet = await link.Next<T>();
                var identifier = packet switch
                {
                    MqttSubscribePacket subscribe => subscribe.PacketIdentifier,
                    MqttUnsubscribePacket unsubscribe => unsubscribe.PacketIdentifier,
                    MqttPublishPacket publish => publish.PacketIdentifier,
                    _ => throw new InvalidOperationException("a packet of no identifier"),
                };

                return answer(IdentifierOf(identifier));
            };
        }

        Task Subscribing()
        {
            return adapter.Subscribe(["bead", "d", "bob"]);
        }

        Task Unsubscribing()
        {
            return adapter.Unsubscribe(["bead", "d", "bob"]);
        }

        Task Publishing()
        {
            return adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
        }

        // * awaited, up: a code under 0x80 its table does not name, or a count other than one
        await IsLostOn(("an UNSUBACK", Unsubscribing), To<MqttUnsubscribePacket>((id) =>
        {
            return [0xB0, 0x04, .. id, 0x00, 0x01];
        }));
        await IsLostOn(("a SUBACK", Subscribing), To<MqttSubscribePacket>((id) =>
        {
            return [0x90, 0x04, .. id, 0x00, 0x03];
        }));
        await IsLostOn(("a PUBACK", Publishing), To<MqttPublishPacket>((id) =>
        {
            return [0x40, 0x03, .. id, 0x01];
        }));
        await IsLostOn(("a SUBACK", Subscribing), To<MqttSubscribePacket>((id) =>
        {
            return [0x90, 0x05, .. id, 0x00, 0x01, 0x01];
        }));
        await IsLostOn(("a SUBACK", Subscribing), To<MqttSubscribePacket>((id) =>
        {
            return [0x90, 0x05, .. id, 0x00, 0x01, 0x87];
        }));
        await IsLostOn(("an UNSUBACK", Unsubscribing), To<MqttUnsubscribePacket>((id) =>
        {
            return [0xB0, 0x05, .. id, 0x00, 0x00, 0x11];
        }));
        await IsLostOn(("a SUBACK", Subscribing), To<MqttSubscribePacket>((id) =>
        {
            return [0x90, 0x03, .. id, 0x00];
        }));
        await IsLostOn(("an UNSUBACK", Unsubscribing), To<MqttUnsubscribePacket>((id) =>
        {
            return [0xB0, 0x03, .. id, 0x00];
        }));

        // * a packet both wrong, of 0x03 and of a property MQTT 5 does not define, 0x7F: lost all the
        // same, whichever check found it
        await IsLostOn(("a SUBACK", Subscribing), To<MqttSubscribePacket>((id) =>
        {
            return [0x90, 0x06, .. id, 0x02, 0x7F, 0x00, 0x03];
        }));

        // * a PUBACK of 0x01 whose reserved flags are set, which MQTTnet reads: judged by its code
        await IsLostOn(("a PUBACK", Publishing), To<MqttPublishPacket>((id) =>
        {
            return [0x42, 0x03, .. id, 0x01];
        }));

        // * no request awaiting it, an identifier its link never used
        foreach (byte[] unawaited in new byte[][] { [0xB0, 0x04, 0x77, 0x77, 0x00, 0x01], [0x40, 0x03, 0x77, 0x77, 0x01], [0x90, 0x05, 0x77, 0x77, 0x00, 0x01, 0x01], [0xB0, 0x03, 0x77, 0x77, 0x00] })
        {
            await IsLostOn(("", null), (_) =>
            {
                return Task.FromResult(unawaited);
            });
        }

        // * before its CONNACK, an UNSUBACK of 0x01, then the CONNACK in the same write: its start
        // fails, no down
        var told = downs.Count;
        var starting = adapter.Start();
        var early = await _script.Link();

        await early.Write([0xB0, 0x04, 0x00, 0x01, 0x00, 0x01, 0x20, 0x03, 0x00, 0x00, 0x00]);
        Assert.StartsWith("the link of ada went down: its broker sent an UNSUBACK ", Assert.IsType<IOException>(await FailureOf(() =>
        {
            return starting;
        })).Message, StringComparison.Ordinal);
        await early.Closed.WaitAsync(Patience, Cancelled);
        Assert.IsType<MqttConnectPacket>(Assert.Single(early.Packets));
        await Task.Delay(50, Cancelled);
        Assert.Equal(told, downs.Count);
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Ends_its_stop_at_once_no_DISCONNECT_and_no_down_on_a_packet_its_client_cannot_read_an_acknowledgement_under_0x80_its_table_does_not_name_or_of_a_count_other_than_one_among_it_spec_15_26_15_29()
    {
        var bound = TimeSpan.FromSeconds(5);
        byte[] unreadable = [0x30, 0x0F, 0x00, 0x0A, .. Encoding.UTF8.GetBytes("bead/i/ada"), 0x02, 0x7F, 0x00];

        _script.IsHoldingUnsubscribes = true;

        // an adapter up, of connectTimeout 5 s, its link's downs heard, holding a subscription to
        // each topic given
        async Task<(MqttBrokerAdapter Adapter, ScriptedLink Link, ConcurrentQueue<BrokerDown> Downs)> Up(string[][] topics)
        {
            var adapter = AdapterOf((options) =>
            {
                return options with { ConnectTimeout = bound };
            });
            var (_, downs) = HeardOf(adapter);
            var link = await LinkUp((adapter, _script));

            foreach (var topic in topics)
            {
                var subscribing = adapter.Subscribe(topic);

                await SubAckOf((link, 1));
                await subscribing.WaitAsync(Patience, Cancelled);
            }

            return (adapter, link, downs);
        }

        // * once its broker wrote what its client cannot read, its stop settles within half its
        // connectTimeout, no DISCONNECT sent and no down told
        async Task IsEndedBy((MqttBrokerAdapter Adapter, ScriptedLink Link, ConcurrentQueue<BrokerDown> Downs) up, (Task Stopping, byte[] Written) stop)
        {
            var watch = Stopwatch.StartNew();

            await up.Link.Write(stop.Written);
            await stop.Stopping.WaitAsync(Patience, Cancelled);
            Assert.True(watch.Elapsed < bound / 2, $"its stop settled {watch.Elapsed.TotalMilliseconds} ms after it");
            await up.Link.Closed.WaitAsync(Patience, Cancelled);
            Assert.DoesNotContain(up.Link.Packets, (packet) =>
            {
                return packet is MqttDisconnectPacket;
            });
            Assert.Empty(up.Downs);
            Assert.False(up.Adapter.IsLinked);
            await up.Adapter.DisposeAsync();
        }

        // * in its let-go, a PUBLISH carrying property 0x7F
        var publishing = await Up([Inbox]);
        var stopping = publishing.Adapter.Stop();

        await publishing.Link.Next<MqttUnsubscribePacket>();
        await IsEndedBy(publishing, (stopping, unreadable));

        // * in its let-go, an UNSUBACK of 0x01 while another's is withheld, under no context and under
        // one that posts its continuations
        foreach (var context in new SynchronizationContext?[] { null, new PostedContinuation() })
        {
            var two = await Up([Inbox, ["bead", "d", "bob"]]);
            var letting = StopUnder((two.Adapter, context));
            var first = await two.Link.Next<MqttUnsubscribePacket>();

            await two.Link.Next<MqttUnsubscribePacket>();
            await IsEndedBy(two, (letting, [0xB0, 0x04, .. IdentifierOf(first.PacketIdentifier), 0x00, 0x01]));
        }

        // * in its let-go, an UNSUBACK of no code
        var none = await Up([Inbox]);
        var leaving = none.Adapter.Stop();
        var unsubscribe = await none.Link.Next<MqttUnsubscribePacket>();

        await IsEndedBy(none, (leaving, [0xB0, 0x03, .. IdentifierOf(unsubscribe.PacketIdentifier), 0x00]));

        // * in its drain, a PUBACK of 0x01 to its publication, which fails with its link's loss,
        // never taken, under no context and under one that posts
        foreach (var context in new SynchronizationContext?[] { null, new PostedContinuation() })
        {
            var draining = await Up([]);
            var published = draining.Adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
            var publish = await draining.Link.Next<MqttPublishPacket>();
            var drained = StopUnder((draining.Adapter, context));

            await Task.Delay(50, Cancelled);
            Assert.False(drained.IsCompleted);
            await IsEndedBy(draining, (drained, [0x40, 0x03, .. IdentifierOf(publish.PacketIdentifier), 0x01]));
            Assert.StartsWith("the link of ada went down: its broker sent a PUBACK ", Assert.IsType<IOException>(await FailureOf(() =>
            {
                return published;
            })).Message, StringComparison.Ordinal);
        }

        // * a SUBACK of 0x01 0x01 to a SUBSCRIBE under way at its stop
        var asking = await Up([]);
        var subscribing = asking.Adapter.Subscribe(Inbox);
        var subscribe = await asking.Link.Next<MqttSubscribePacket>();
        var ending = asking.Adapter.Stop();

        await asking.Link.Next<MqttUnsubscribePacket>();
        await IsEndedBy(asking, (ending, [0x90, 0x05, .. IdentifierOf(subscribe.PacketIdentifier), 0x00, 0x01, 0x01]));
        Assert.StartsWith("the link of ada went down: its broker sent a SUBACK ", Assert.IsType<IOException>(await FailureOf(() =>
        {
            return subscribing;
        })).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reads_an_acknowledgement_of_0x80_or_more_its_table_does_not_name_as_a_refusal_awaited_or_not_naming_its_code_its_link_kept_spec_15_27_15_28()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        // * a PUBACK of 0x95, as Mosquitto 2.1.2 sends it past its message_size_limit: refused,
        // naming it, then the next publication taken
        var refused = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
        var publish = await link.Next<MqttPublishPacket>();

        await link.Write([0x40, 0x03, .. IdentifierOf(publish.PacketIdentifier), 0x95]);
        Assert.Contains("PUBACK 0x95", (await FailureOf(() =>
        {
            return refused;
        })).Message, StringComparison.Ordinal);

        var taken = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[2] });

        await PubAckOf((link, (await link.Next<MqttPublishPacket>()).PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await taken.WaitAsync(Patience, Cancelled));

        // * a SUBACK of 0x95: refused, naming it, its filter forgotten, its broker installing none
        var subscribing = adapter.Subscribe(["bead", "d", "bob"]);

        await SubAckOf((link, 0x95));
        Assert.Contains("SUBACK 0x95", (await FailureOf(() =>
        {
            return subscribing;
        })).Message, StringComparison.Ordinal);

        // * an UNSUBACK of 0x95: refused, naming it, its filter kept for its stop
        var held = adapter.Subscribe(Inbox);

        await SubAckOf((link, 1));
        await held.WaitAsync(Patience, Cancelled);
        _script.IsHoldingUnsubscribes = true;

        var leaving = adapter.Unsubscribe(Inbox);
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();

        await link.Write([0xB0, 0x04, .. IdentifierOf(unsubscribe.PacketIdentifier), 0x00, 0x95]);
        Assert.Contains("UNSUBACK 0x95", (await FailureOf(() =>
        {
            return leaving;
        })).Message, StringComparison.Ordinal);

        // * an UNSUBACK of 0xFF no request awaits: ignored, the next publication taken behind it
        var after = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[3] });

        await link.Write([0xB0, 0x04, 0x77, 0x77, 0x00, 0xFF]);
        await PubAckOf((link, (await link.Next<MqttPublishPacket>()).PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await after.WaitAsync(Patience, Cancelled));

        Assert.Empty(downs);
        Assert.Empty(messages);
        Assert.True(adapter.IsLinked);
        Assert.DoesNotContain(link.Packets, (packet) =>
        {
            return packet is MqttDisconnectPacket;
        });

        // its stop lets go of the filter its UNSUBACK refused, and of none its SUBACK refused
        _script.IsHoldingUnsubscribes = false;
        await adapter.Stop().WaitAsync(Patience, Cancelled);
        Assert.Equal(["bead/i/ada", "bead/i/ada"], LetGoOf(link));
    }

    // ! the tests of docs/support.md's row "What an MQTT 5 link lost on a packet its client cannot
    // read hands on of what came before it in one read": each asserts what held 40 runs of 40, a
    // PUBLISH before an UNSUBACK no request awaits handed on or not by the scheduler
    [Fact]
    public async Task Hands_on_what_came_before_a_packet_its_client_cannot_read_in_one_read_as_far_as_its_side_does_spec_15_29()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var inbox = EncodedOf(PublishOf(("bead/i/ada", [7], 9)));
        byte[] property = [0x30, 0x0F, 0x00, 0x0A, .. Encoding.UTF8.GetBytes("bead/i/ada"), 0x02, 0x7F, 0x00];

        // in one write, a PUBACK of 0x00 to its publication and a PUBLISH to its inbox, then what it
        // cannot read: what its publication gave
        async Task<BrokerPublished> Before(byte[] unreadable)
        {
            var link = await LinkUp((adapter, _script));
            var told = downs.Count;
            var publishing = adapter.Publish(new BrokerPublication { Topic = Name, Payload = (byte[])[1] });
            var publish = await link.Next<MqttPublishPacket>();

            await link.Write([0x40, 0x03, .. IdentifierOf(publish.PacketIdentifier), 0x00, .. inbox, .. unreadable]);
            await link.Closed.WaitAsync(Patience, Cancelled);
            await Until(() =>
            {
                return downs.Count > told;
            });
            Assert.Equal(told + 1, downs.Count);
            Assert.False(adapter.IsLinked);

            return await publishing.WaitAsync(Patience, Cancelled);
        }

        // * (i) an UNSUBACK of 0x01 no request awaits, judged at its inspector: its publication
        // taken, its PUBLISH handed on or not by the scheduler
        Assert.Equal(BrokerPublished.Taken, await Before([0xB0, 0x04, 0x77, 0x77, 0x00, 0x01]));
        messages.Clear();

        // * (ii) a PUBLISH carrying property 0x7F, which MQTTnet refuses as it decodes it: its
        // publication taken, its PUBLISH handed on or not by the scheduler, MQTTnet dispatching it
        // as the decoder's refusal retires the link; once at most, and the one read before
        Assert.Equal(BrokerPublished.Taken, await Before(property));
        await Task.Delay(TimeSpan.FromMilliseconds(200), Cancelled);
        Assert.True(messages.Count <= 1);
        Assert.All(messages, (message) =>
        {
            Assert.Equal([7], message.Payload.ToArray());
        });
    }

    [Fact]
    public async Task Loses_its_link_once_on_a_packet_past_its_Maximum_Packet_Size_beside_its_CONNACK_in_one_read_spec_15_29()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_100 };
        });
        var (messages, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        var link = await _script.Link();

        // * one broker write: a successful CONNACK followed by a header alone
        await link.Write([0x20, 0x03, 0, 0, 0, 0x32, 0x80, 0x80, 0x80, 0x08]);
        await link.Closed.WaitAsync(Patience, Cancelled);
        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
    }

    [Fact]
    public async Task Loses_its_link_once_on_a_packet_past_its_Maximum_Packet_Size_after_its_CONNACK_before_its_caller_resumes_spec_15_29()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_100 };
        });
        var (messages, downs) = HeardOf(adapter);
        var held = new HeldContinuation();
        var previous = SynchronizationContext.Current;
        Task starting;

        // * hold the adapter's await of ConnectAsync after MQTTnet accepts its CONNACK,
        // while its receiving loop keeps reading and the adapter has not counted itself up
        SynchronizationContext.SetSynchronizationContext(held);
        try
        {
            starting = adapter.Start();
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }

        var link = await _script.Link();

        // * a CONNACK of 0x00 whose Maximum Packet Size (0x27) is 1,024 bytes
        await link.Write([0x20, 0x08, 0, 0, 0x05, 0x27, 0, 0, 0x04, 0]);
        var resume = await held.Posted.Task.WaitAsync(Patience, Cancelled);

        try
        {
            Assert.False(starting.IsCompleted);
            Assert.False(adapter.IsLinked);
            await link.Write([0x32, 0x80, 0x80, 0x80, 0x08]);
            await link.Closed.WaitAsync(Patience, Cancelled);
        }
        finally
        {
            resume();
        }

        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
        Assert.Equal(MqttPackets.LargestPayload(("bead/i/ada", 1_024), new MqttPublishShape(1, true)), adapter.MaximumPayloadBytes(Inbox));
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
    }

    [Fact]
    public async Task Loses_its_link_once_as_its_network_connection_ends_after_its_CONNACK_before_its_caller_resumes_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var held = new HeldContinuation();
        var previous = SynchronizationContext.Current;
        Task starting;

        // * hold the adapter's await of ConnectAsync after MQTTnet accepts its CONNACK
        SynchronizationContext.SetSynchronizationContext(held);
        try
        {
            starting = adapter.Start();
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }

        var link = await _script.Link();

        await link.Write([0x20, 0x03, 0, 0, 0]);
        var resume = await held.Posted.Task.WaitAsync(Patience, Cancelled);

        try
        {
            Assert.False(starting.IsCompleted);
            link.End();
            await link.Closed.WaitAsync(Patience, Cancelled);
        }
        finally
        {
            resume();
        }

        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
    }

    [Fact]
    public async Task Fails_its_start_on_a_CONNACK_that_refuses_or_says_Maximum_QoS_0_beside_a_packet_past_its_Maximum_Packet_Size_in_one_read_naming_the_CONNACK_spec_15_26_15_29()
    {
        // * one broker write each: a CONNACK, then a header alone past 1,100 bytes
        (byte[] ConnAck, string Named)[] refusals =
        [
            ([0x20, 0x03, 0, 0x86, 0], "CONNACK 0x86, Bad User Name or Password"),
            ([0x20, 0x03, 0, 0x01, 0], "0x01"),
            ([0x20, 0x05, 0, 0, 0x02, 0x24, 0], "Maximum QoS 0"),
        ];

        foreach (var (connAck, named) in refusals)
        {
            await using var adapter = AdapterOf((options) =>
            {
                return options with { MaximumPacketSize = 1_100 };
            });
            var (messages, downs) = HeardOf(adapter);
            var starting = adapter.Start();
            var link = await _script.Link();

            await link.Write([.. connAck, 0x32, 0x80, 0x80, 0x80, 0x08]);
            var failure = Assert.IsType<IOException>(await FailureOf(() =>
            {
                return starting;
            }));

            Assert.Contains(named, failure.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("past its Maximum Packet Size", failure.Message, StringComparison.Ordinal);
            await link.Closed.WaitAsync(Patience, Cancelled);
            Assert.Empty(downs);
            Assert.Empty(messages);
            Assert.False(adapter.IsLinked);
            Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
        }
    }

    [Fact]
    public async Task Stops_its_link_with_a_DISCONNECT_of_0x00_after_its_CONNACK_before_its_caller_resumes_its_start_succeeding_and_no_down_told_spec_15_26()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var held = new HeldContinuation();
        var previous = SynchronizationContext.Current;
        Task starting;

        // * hold the adapter's await of ConnectAsync after MQTTnet accepts its CONNACK
        SynchronizationContext.SetSynchronizationContext(held);
        try
        {
            starting = adapter.Start();
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }

        var link = await _script.Link();

        await link.Write([0x20, 0x03, 0, 0, 0]);
        var resume = await held.Posted.Task.WaitAsync(Patience, Cancelled);

        try
        {
            Assert.False(starting.IsCompleted);
            await adapter.Stop().WaitAsync(Patience, Cancelled);
        }
        finally
        {
            resume();
        }

        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
        Assert.Collection(
            link.Packets,
            (packet) =>
            {
                Assert.IsType<MqttConnectPacket>(packet);
            },
            (packet) =>
            {
                Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, Assert.IsType<MqttDisconnectPacket>(packet).ReasonCode);
            });
    }

    [Fact]
    public async Task Takes_a_start_from_its_down_s_listener_once_its_link_is_lost_beside_its_CONNACK_spec_15_26()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumPacketSize = 1_100 };
        });
        var (messages, downs) = HeardOf(adapter);
        var restarted = new TaskCompletionSource<Task>(TaskCreationOptions.RunContinuationsAsynchronously);

        // * a start made as its down is told, synchronously, what it returns kept
        adapter.Down += (_) =>
        {
            restarted.TrySetResult(adapter.Start());
        };

        var starting = adapter.Start();
        var link = await _script.Link();

        await link.Write([0x20, 0x03, 0, 0, 0, 0x32, 0x80, 0x80, 0x80, 0x08]);
        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        var restarting = await restarted.Task.WaitAsync(Patience, Cancelled);

        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);

        // its restart taken, never refused as up already: a second link comes, its CONNECT read
        var next = await _script.Link();

        Assert.Equal(Id, next.Connect.ClientId);
        await next.Send(ScriptedLink.ConnAck());
        await restarting.WaitAsync(Patience, Cancelled);
        Assert.True(adapter.IsLinked);
        await adapter.Stop();
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Tells_its_link_taken_over_its_start_succeeding_on_a_DISCONNECT_of_0x8E_beside_its_CONNACK_in_one_read_spec_15_21_15_26()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        var link = await _script.Link();

        // * one broker write: a successful CONNACK, then a DISCONNECT of 0x8E, then its end
        await link.Write([0x20, 0x03, 0, 0, 0, 0xE0, 0x02, 0x8E, 0]);
        link.End();
        var failure = await Record.ExceptionAsync(() =>
        {
            return starting.WaitAsync(Patience, Cancelled);
        });

        Assert.Null(failure);
        await link.Closed.WaitAsync(Patience, Cancelled);
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown { IsTakenOver = true }], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked);
        Assert.IsType<MqttConnectPacket>(Assert.Single(link.Packets));
    }

    // * a caller's context that posts each continuation, as a UI thread's or a test runner's does,
    // none run inside the call that completed its task: the stop's awaits resume on the pool, after
    // MQTTnet's receive loop went on
    private sealed class PostedContinuation : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state)
        {
            ThreadPool.QueueUserWorkItem((_) =>
            {
                SetSynchronizationContext(this);
                callback(state);
            });
        }
    }

    private sealed class HeldContinuation : SynchronizationContext
    {
        public TaskCompletionSource<Action> Posted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override void Post(SendOrPostCallback callback, object? state)
        {
            Assert.True(Posted.TrySetResult(() =>
            {
                callback(state);
            }), "the adapter posts one continuation after its CONNACK");
        }
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

        // * a topic whose PUBLISH alone passes the bound leaves no payload any room
        Assert.Equal(0, peer.ReceiveBound(["bead", "i", new string('p', 4_096)]));
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

        // a listener let go hears no loss after
        var later = new ConcurrentQueue<BrokerDown>();

        adapter.Down += later.Enqueue;
        adapter.Down -= later.Enqueue;
        second.Cut();
        await Until(() =>
        {
            return downs.Count > 1;
        });
        Assert.Empty(later);
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

        // one link at a time: a start of a link up is refused
        Assert.Equal("the link of ada is up already", Assert.IsType<InvalidOperationException>(await FailureOf(() =>
        {
            return adapter.Start();
        })).Message);
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
    public async Task Gives_up_a_start_a_subscription_or_a_publication_its_signal_aborts_a_publication_that_waits_on_its_quota_leaving_it_unsent_and_retires_its_link_where_what_it_asked_may_have_gone_spec_15_26()
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
        await FailureOf(() =>
        {
            return adapter.Start(new BrokerStart { CancellationToken = new CancellationToken(true) });
        });

        // a stop before its CONNACK ends the start, and one as it asks its password, too
        var stoppedEarly = adapter.Start();

        await _script.Link();
        await adapter.Stop();
        Assert.Contains("before its CONNACK", (await FailureOf(() =>
        {
            return stoppedEarly;
        })).Message, StringComparison.Ordinal);

        var asking = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var asked = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (_) =>
                {
                    return new ValueTask<string>(asking.Task);
                },
            };
        });
        var askedStart = asked.Start();

        await asked.Stop();
        asking.SetResult(Password);
        Assert.Equal("the link of ada stopped as it started", (await FailureOf(() =>
        {
            return askedStart;
        })).Message);

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

        // and a publication given up once its PUBLISH went retires its link, too
        using var abandoned = new CancellationTokenSource();
        var publishing = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[3], CancellationToken = abandoned.Token });

        await again.Next<MqttPublishPacket>();
        await abandoned.CancelAsync();
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
        {
            return publishing;
        }));
        await Until(() =>
        {
            return downs.Count > 1;
        });
        Assert.Equal([new BrokerDown(), new BrokerDown()], downs);
        await again.Closed.WaitAsync(Patience, Cancelled);
        await adapter.Stop();
    }

    [Fact]
    public async Task Retires_its_link_where_a_publication_at_most_once_is_given_up_before_its_packet_is_written_spec_15_26_15_28()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce };
        });
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));
        var mebibyte = new byte[1_048_576];
        var held = new List<Task<BrokerPublished>>();

        // * 64 MiB its broker does not read, so that its writer blocks; each asked in a turn of its own
        link.Pause();

        for (var index = 0; index < 64; index += 1)
        {
            held.Add(adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = mebibyte }));
            await Task.Yield();
        }

        using var given = new CancellationTokenSource();
        var givenUp = adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[1], CancellationToken = given.Token });

        await Task.Delay(100, Cancelled);
        Assert.False(givenUp.IsCompleted, "held behind what is not written");
        await given.CancelAsync();
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
        {
            return givenUp;
        }));

        // * it may go yet, so its link goes
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal([new BrokerDown()], downs);

        foreach (var publishing in held)
        {
            var failure = await Record.ExceptionAsync(() =>
            {
                return publishing.WaitAsync(Patience, Cancelled);
            });

            if (failure is not null)
            {
                Assert.Equal("the link of ada was retired: what it was asked was given up once it may have gone", Assert.IsType<IOException>(failure).Message);
            }
        }

        // * its network connection closed, no DISCONNECT: what waited never written whole
        link.Resume();
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.DoesNotContain(link.Packets, (packet) =>
        {
            return packet is MqttDisconnectPacket;
        });
        Assert.True(link.PacketsOf<MqttPublishPacket>().Count < 64, "what waited never written whole");
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Fails_its_start_once_its_password_provider_outlives_its_connect_timeout_and_takes_no_late_answer()
    {
        var late = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                ConnectTimeout = TimeSpan.FromMilliseconds(200),
                Password = null,
                PasswordProvider = (_) =>
                {
                    return new ValueTask<string>(late.Task);
                },
            };
        });
        var (_, downs) = HeardOf(adapter);

        Assert.Equal("the link of ada had no password within 200 ms, its connectTimeout", Assert.IsType<TimeoutException>(await FailureOf(() =>
        {
            return adapter.Start();
        })).Message);

        // * its answer, come too late, opens no network connection
        late.SetResult(Password);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(300));
        });
        Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));

        // * one connectTimeout from its start's call: its CONNACK waits what its ask left of it
        await using var slow = AdapterOf((options) =>
        {
            return options with
            {
                ConnectTimeout = TimeSpan.FromMilliseconds(600),
                Password = null,
                PasswordProvider = async (token) =>
                {
                    await Task.Delay(450, token);

                    return Password;
                },
            };
        });
        var began = Stopwatch.StartNew();
        var waiting = FailureOf(() =>
        {
            return slow.Start();
        });

        await _script.Link();
        Assert.Equal("the link of ada had no CONNACK within 600 ms, its connectTimeout", Assert.IsType<TimeoutException>(await waiting).Message);
        Assert.True(began.Elapsed < TimeSpan.FromMilliseconds(900));
    }

    [Fact]
    public async Task Ends_its_start_once_stopped_as_its_password_is_asked_and_links_at_the_next_start_asked_anew()
    {
        var asked = 0;
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (_) =>
                {
                    var count = Interlocked.Increment(ref asked);

                    // * the first ask never answers, nor hears its token
                    return count == 1 ? new ValueTask<string>(new TaskCompletionSource<string>().Task) : ValueTask.FromResult($"{Password}-{count}");
                },
            };
        });
        var starting = adapter.Start();

        await Until(() =>
        {
            return Volatile.Read(ref asked) == 1;
        });
        await adapter.Stop();
        Assert.Equal("the link of ada stopped as it started", Assert.IsType<IOException>(await FailureOf(() =>
        {
            return starting;
        })).Message);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(200));
        });

        var connect = (await LinkUp((adapter, _script))).Connect;

        Assert.Equal($"{Password}-2", Encoding.UTF8.GetString(connect.Password));
        Assert.Equal((2, true), (Volatile.Read(ref asked), adapter.IsLinked));
        await adapter.Stop();
    }

    [Fact]
    public async Task Ends_its_start_at_its_own_cancellation_as_its_password_is_asked()
    {
        var tokens = new ConcurrentQueue<CancellationToken>();
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (token) =>
                {
                    tokens.Enqueue(token);

                    // it never settles
                    return new ValueTask<string>(new TaskCompletionSource<string>().Task);
                },
            };
        });
        using var given = new CancellationTokenSource();
        var starting = adapter.Start(new BrokerStart { CancellationToken = given.Token });

        await Until(() =>
        {
            return tokens.Count == 1;
        });

        var asked = Assert.Single(tokens);

        Assert.False(asked.IsCancellationRequested);
        await given.CancelAsync();
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
        {
            return starting;
        }));

        // * its provider's token cancelled with it
        Assert.True(asked.IsCancellationRequested);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(200));
        });

        // and a token cancelled already asks nothing
        Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
        {
            return adapter.Start(new BrokerStart { CancellationToken = new CancellationToken(true) });
        }));
        Assert.Single(tokens);
    }

    [Fact]
    public async Task Fails_its_start_when_its_password_provider_throws_its_throw_the_cause()
    {
        var thrown = new InvalidOperationException("the vault is down");

        // * as it is called, or as it answers
        Func<CancellationToken, ValueTask<string>>[] providers =
        [
            (_) =>
            {
                throw thrown;
            },
            (_) =>
            {
                return ValueTask.FromException<string>(thrown);
            },
        ];

        foreach (var provider in providers)
        {
            await using var adapter = AdapterOf((options) =>
            {
                return options with { Password = null, PasswordProvider = provider };
            });
            var error = Assert.IsType<IOException>(await FailureOf(() =>
            {
                return adapter.Start();
            }));

            Assert.Equal(("the password provider failed", (Exception)thrown), (error.Message, error.InnerException));
            Assert.False(adapter.IsLinked);
        }

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(200));
        });
    }

    [Fact]
    public async Task Refuses_a_password_that_is_empty_or_holds_a_NUL_as_built_or_as_answered()
    {
        const string Refusal = "a password is a non-empty string holding no NUL";

        foreach (var password in new[] { "", $"{Password}\0" })
        {
            var built = Assert.Throws<ArgumentException>(() =>
            {
                return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Password = password, Uri = _script.Uri });
            });

            Assert.Equal((Refusal, "options"), (built.Message.Split(" (Parameter", 2)[0], built.ParamName));

            await using var answering = AdapterOf((options) =>
            {
                return options with
                {
                    Password = null,
                    PasswordProvider = (_) =>
                    {
                        return ValueTask.FromResult(password);
                    },
                };
            });
            var answered = Assert.IsType<ArgumentException>(await FailureOf(() =>
            {
                return answering.Start();
            }));

            // ! no word names the secret it refuses
            Assert.StartsWith(Refusal, answered.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(Password, answered.Message, StringComparison.Ordinal);
        }

        // * and an answer that is none: none is never taken for no password
        await using var unanswered = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (_) =>
                {
                    return ValueTask.FromResult<string>(null!);
                },
            };
        });

        Assert.StartsWith(Refusal, Assert.IsType<ArgumentException>(await FailureOf(() =>
        {
            return unanswered.Start();
        })).Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Link(TimeSpan.FromMilliseconds(200));
        });
    }

    [Fact]
    public async Task Aborts_its_password_provider_s_signal_once_its_start_ends_linked_or_not()
    {
        var tokens = new ConcurrentQueue<CancellationToken>();
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (token) =>
                {
                    tokens.Enqueue(token);

                    return ValueTask.FromResult(Password);
                },
            };
        });
        var starting = adapter.Start();
        var link = await _script.Link();

        // * live while its start is under way
        Assert.False(Assert.Single(tokens).IsCancellationRequested);
        await link.Send(ScriptedLink.ConnAck());
        await starting.WaitAsync(Patience, Cancelled);
        await Until(() =>
        {
            return tokens.Single().IsCancellationRequested;
        });
        Assert.Equal((true, true), (tokens.Single().IsCancellationRequested, adapter.IsLinked));
        await adapter.Stop();

        // and a start its CONNACK refuses
        var refusing = adapter.Start();
        var refused = await _script.Link();

        await refused.Send(new MqttConnAckPacket { ReasonCode = MqttConnectReasonCode.BadUserNameOrPassword, MaximumQoS = MqttQualityOfServiceLevel.ExactlyOnce, RetainAvailable = true, SharedSubscriptionAvailable = true });
        Assert.Contains("CONNACK 0x86, Bad User Name or Password", (await FailureOf(() =>
        {
            return refusing;
        })).Message, StringComparison.Ordinal);
        await Until(() =>
        {
            return tokens.Count == 2 && tokens.All((token) =>
            {
                return token.IsCancellationRequested;
            });
        });
        Assert.Equal([true, true], tokens.Select((token) =>
        {
            return token.IsCancellationRequested;
        }));
    }

    [Fact]
    public async Task Refuses_a_password_beside_a_client_certificate_and_both_a_password_and_its_provider()
    {
        var secured = new Uri("mqtts://127.0.0.1:8883");
        var certificate = new MqttBrokerTlsOptions { ClientCertificates = [Certificate.Value] };
        Func<CancellationToken, ValueTask<string>> provider = (_) =>
        {
            return ValueTask.FromResult(Password);
        };
        MqttBrokerAdapterOptions[] refused =
        [
            new MqttBrokerAdapterOptions { Id = Id, Password = Password, Tls = certificate, Uri = secured },
            new MqttBrokerAdapterOptions { Id = Id, PasswordProvider = provider, Tls = certificate, Uri = secured },
            new MqttBrokerAdapterOptions { Id = Id, Password = Password, PasswordProvider = provider, Uri = secured },

            // * both, and a certificate: the first refusal, in one order on every side
            new MqttBrokerAdapterOptions { Id = Id, Password = Password, PasswordProvider = provider, Tls = certificate, Uri = secured },
        ];

        Assert.Equal(
            [
                "a link authenticates by its client certificate or by a password, not both",
                "a link authenticates by its client certificate or by a password, not both",
                "a link takes a password or a password provider, not both",
                "a link takes a password or a password provider, not both",
            ],
            refused.Select((options) =>
            {
                var refusal = Assert.Throws<ArgumentException>(() =>
                {
                    return new MqttBrokerAdapter(options);
                });

                Assert.Equal("options", refusal.ParamName);

                return refusal.Message.Split(" (Parameter", 2)[0];
            }));

        // neither: its User Name, its id, with no Password
        await using var bare = new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = Id, Uri = _script.Uri });
        var connect = (await LinkUp((bare, _script))).Connect;

        Assert.Equal((Id, (byte[]?)null), (connect.Username, connect.Password));
        await bare.Stop();
    }

    [Fact]
    public void Prints_no_password_nor_its_provider()
    {
        var given = new MqttBrokerAdapterOptions { Id = Id, Password = Password, Uri = new Uri("mqtt://127.0.0.1:1883") };
        var asked = given with
        {
            Password = null,
            PasswordProvider = (_) =>
            {
                return ValueTask.FromResult(Password);
            },
        };

        Assert.DoesNotContain(Password, given.ToString(), StringComparison.Ordinal);
        Assert.StartsWith("MqttBrokerAdapterOptions { Uri = mqtt://127.0.0.1:1883/, Id = ada, Password = set, PasswordProvider = none, Tls = , ", given.ToString(), StringComparison.Ordinal);
        Assert.Contains("Password = none, PasswordProvider = set", asked.ToString(), StringComparison.Ordinal);
        Assert.EndsWith("Delivery = AtLeastOnce, Groups = True }", asked.ToString(), StringComparison.Ordinal);
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

        // what is none of its four is refused as it is built, and so is an IPv6 address followed by
        // anything but its port (RFC 3986 §3.2.2), and an id that is none
        string[] refusedUris = ["http://broker.example", "mqtt://[::1]junk:1884", "mqtt://[::1]junk", "ws://[::1]junk/mqtt", "mqtt://user@[::1]junk:1884"];
        var refusedOptions = refusedUris.Select((uri) =>
        {
            return new MqttBrokerAdapterOptions { Id = Id, Uri = new Uri(uri) };
        }).Append(new MqttBrokerAdapterOptions { Id = "", Uri = new Uri("mqtt://127.0.0.1") });

        foreach (var refused in refusedOptions)
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return new MqttBrokerAdapter(refused);
            });
        }
    }

    // [MQTT-6.0.0-2] lets a WebSocket message hold several packets: each held to its Maximum Packet
    // Size alone, on every side
    [Fact]
    public async Task Reads_a_WebSocket_message_of_two_packets_past_its_Maximum_Packet_Size_together_each_within_it()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        await using var adapter = WebSocketAdapterOf(listener, (options) =>
        {
            return options with { MaximumPacketSize = 1_024 };
        });
        var (messages, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        using var upgraded = await UpgradedOf(listener);
        var publish = EncodedOf(new MqttPublishPacket { Topic = $"bead/i/{Id}", PayloadSegment = new byte[680], QualityOfServiceLevel = MqttQualityOfServiceLevel.AtMostOnce });

        // its CONNECT, then its CONNACK; then one message of two PUBLISHes of 700 bytes or so each
        await ConnectReadOf(upgraded.Broker);
        await upgraded.Broker.SendAsync(EncodedOf(ScriptedLink.ConnAck()), System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await starting.WaitAsync(Patience, Cancelled);
        Assert.True(publish.Length < 1_024 && publish.Length * 2 > 1_024 + 14, $"{publish.Length} bytes a packet");
        await upgraded.Broker.SendAsync((byte[])[.. publish, .. publish], System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await Until(() =>
        {
            return messages.Count == 2;
        });

        Assert.Equal((2, 0), (messages.Count, downs.Count));
        Assert.True(adapter.IsLinked, "its link kept");
    }

    [Fact]
    public async Task Reads_a_packet_across_two_WebSocket_messages_whole_spec_15_25()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        await using var adapter = WebSocketAdapterOf(listener);
        var (_, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        using var upgraded = await UpgradedOf(listener);
        var connAck = EncodedOf(ScriptedLink.ConnAck());

        // its CONNECT, then its CONNACK as two binary messages, its fixed header the first
        await ConnectReadOf(upgraded.Broker);
        await upgraded.Broker.SendAsync(connAck[..2], System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await upgraded.Broker.SendAsync(connAck[2..], System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await starting.WaitAsync(Patience, Cancelled);

        Assert.True(adapter.IsLinked, "its link up");
        Assert.Empty(downs);
    }

    [Fact]
    public async Task Offers_no_extension_in_its_WebSocket_s_upgrade_to_its_broker_permessage_deflate_among_them()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        await using var adapter = WebSocketAdapterOf(listener);
        var starting = adapter.Start();
        using var upgraded = await UpgradedOf(listener);

        await ConnectReadOf(upgraded.Broker);
        await upgraded.Broker.SendAsync(EncodedOf(ScriptedLink.ConnAck()), System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await starting.WaitAsync(Patience, Cancelled);

        // * no Sec-WebSocket-Extensions line in its upgrade (RFC 6455 §9.1), its broker's answer then
        // naming none it could hold it to
        Assert.DoesNotContain(upgraded.Head.Split("\r\n"), (line) =>
        {
            return line.StartsWith("Sec-WebSocket-Extensions:", StringComparison.OrdinalIgnoreCase);
        });
        Assert.True(adapter.IsLinked, "its link up");
    }

    // ClientWebSocket hands a message's first fragment on before its message ends, and MQTTnet reads
    // it as a stream: a packet past its Maximum Packet Size is judged at its Remaining Length, its
    // message's last fragment never awaited; a row of docs/support.md
    [Fact]
    public async Task Loses_its_link_on_the_first_fragment_of_a_WebSocket_message_holding_a_packet_past_its_Maximum_Packet_Size_read_at_its_Remaining_Length()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        await using var adapter = WebSocketAdapterOf(listener, (options) =>
        {
            return options with { MaximumPacketSize = 1_024 };
        });
        var (messages, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        using var upgraded = await UpgradedOf(listener);

        await ConnectReadOf(upgraded.Broker);
        await upgraded.Broker.SendAsync(EncodedOf(ScriptedLink.ConnAck()), System.Net.WebSockets.WebSocketMessageType.Binary, true, Cancelled);
        await starting.WaitAsync(Patience, Cancelled);

        // * a PUBLISH's fixed header announcing 2,000 bytes, then its topic's length: the first
        // fragment of a message never ended
        await upgraded.Broker.SendAsync(new byte[] { 0x30, 0xD0, 0x0F, 0x00, 0x09 }, System.Net.WebSockets.WebSocketMessageType.Binary, false, Cancelled);
        await Until(() =>
        {
            return !downs.IsEmpty;
        });

        Assert.Equal([new BrokerDown()], downs);
        Assert.Empty(messages);
        Assert.False(adapter.IsLinked, "its link lost");

        // no DISCONNECT: what its broker reads to its socket's end is no binary message, its client
        // disposed as MQTTnet's own close may still go
        var heard = new List<System.Net.WebSockets.WebSocketMessageType>();
        var received = new byte[4_096];
        var isOpen = true;

        while (isOpen)
        {
            try
            {
                var read = await upgraded.Broker.ReceiveAsync(received, Cancelled).WaitAsync(Patience, Cancelled);

                heard.Add(read.MessageType);
                isOpen = read.MessageType != System.Net.WebSockets.WebSocketMessageType.Close;
            }
            catch (System.Net.WebSockets.WebSocketException)
            {
                isOpen = false;
            }
        }

        Assert.DoesNotContain(System.Net.WebSockets.WebSocketMessageType.Binary, heard);
    }

    // [MQTT-6.0.0-1] closes the link on a text message: MQTTnet reads its bytes, a row of
    // docs/support.md
    [Fact]
    public async Task Reads_a_CONNACK_sent_as_a_text_WebSocket_message_its_link_up()
    {
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);

        listener.Start();

        await using var adapter = WebSocketAdapterOf(listener);
        var (_, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        using var upgraded = await UpgradedOf(listener);
        var connAck = EncodedOf(ScriptedLink.ConnAck());

        Assert.True(connAck.All((octet) =>
        {
            return octet < 0x80;
        }), "its bytes ASCII, so valid UTF-8 (RFC 6455 §5.6)");
        await ConnectReadOf(upgraded.Broker);
        await upgraded.Broker.SendAsync(connAck, System.Net.WebSockets.WebSocketMessageType.Text, true, Cancelled);
        await starting.WaitAsync(Patience, Cancelled);

        Assert.True(adapter.IsLinked, "its link up");
        Assert.Empty(downs);
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

    [Fact(Skip = MqttFixture.Reason, SkipUnless = nameof(IsMqtt))]
    public async Task Sends_each_WebSocket_message_to_its_broker_as_one_binary_frame_a_burst_past_64_KiB_among_them_spec_15_25()
    {
        await using var relay = FrameRelay.Start(MqttFixture.WebSocketUrl);
        await using var adapter = new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = FixtureUser, Password = MqttFixture.Password, Uri = relay.Uri });
        string[] inbox = ["bead", "i", FixtureUser];
        var heard = new ConcurrentQueue<byte[]>();

        adapter.Message += (message) =>
        {
            heard.Enqueue(message.Payload.ToArray());
            message.Settle();
        };
        await adapter.Start();

        try
        {
            await adapter.Subscribe(inbox);

            // * each the largest its broker takes, together past 64 KiB, all asked at once
            var size = (int)adapter.MaximumPayloadBytes(inbox);
            var payloads = Enumerable.Range(0, (196_608 + size - 1) / size).Select((index) =>
            {
                return Enumerable.Repeat((byte)index, size).ToArray();
            }).ToArray();
            var published = await Task.WhenAll(payloads.Select((payload) =>
            {
                return adapter.Publish(new BrokerPublication { Topic = inbox, Payload = payload });
            })).WaitAsync(Patience, Cancelled);

            Assert.All(published, (outcome) =>
            {
                Assert.Equal(BrokerPublished.Taken, outcome);
            });
            await Until(() =>
            {
                return heard.Count == payloads.Length;
            });
            Assert.Equal(payloads, heard);
            Assert.True(adapter.IsLinked);

            // * what its client sent, each message one frame: none ends no message, none continues one
            Assert.True(relay.Frames.Count > payloads.Length);
            Assert.Empty(FrameRelay.UnwholeOf(relay.Frames));
        }
        finally
        {
            await adapter.Stop();
        }
    }

    [Fact(Skip = MqttFixture.Reason, SkipUnless = nameof(IsMqtt))]
    public async Task Lets_one_member_of_a_group_go_at_its_stop_a_name_the_others_serve_still_taken_and_finds_no_subscriber_for_its_inbox_once_it_stopped_nor_for_the_name_once_the_last_did_spec_15_21_15_26()
    {
        var adapters = GroupUsers.Select((id) =>
        {
            return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = id, Password = MqttFixture.Password, Uri = MqttFixture.Url });
        }).ToList();
        var (leaving, staying, caller) = (adapters[0], adapters[1], adapters[2]);
        string[] name = ["bead", "s", string.Create(CultureInfo.InvariantCulture, $"stopping-{TimeProvider.System.GetTimestamp()}")];
        byte[] payload = [1];
        var heard = new ConcurrentQueue<int>();

        leaving.Message += (message) =>
        {
            message.Settle();
        };
        staying.Message += (message) =>
        {
            heard.Enqueue(message.Payload.Span[0]);
            message.Settle();
        };

        try
        {
            await Task.WhenAll(staying.Start(), caller.Start()).WaitAsync(Patience, Cancelled);
            await staying.Subscribe(name, new BrokerSubscription { Group = "stopping" }).WaitAsync(Patience, Cancelled);

            // * at once after each stop, as the race the stop closes was
            for (var round = 0; round < 5; round++)
            {
                await leaving.Start().WaitAsync(Patience, Cancelled);
                await leaving.Subscribe(["bead", "i", leaving.Id]).WaitAsync(Patience, Cancelled);
                await leaving.Subscribe(name, new BrokerSubscription { Group = "stopping" }).WaitAsync(Patience, Cancelled);
                await leaving.Stop().WaitAsync(Patience, Cancelled);
                Assert.Equal(BrokerPublished.NoSubscriber, await caller.Publish(new BrokerPublication { Topic = ["bead", "i", leaving.Id], Payload = payload }).WaitAsync(Patience, Cancelled));
                Assert.Equal(BrokerPublished.Taken, await caller.Publish(new BrokerPublication { Topic = name, Payload = (byte[])[(byte)round] }).WaitAsync(Patience, Cancelled));
            }

            // * each taken by the member that stays
            await Until(() =>
            {
                return heard.Count == 5;
            });
            Assert.Equal([0, 1, 2, 3, 4], heard);
            await staying.Stop().WaitAsync(Patience, Cancelled);
            Assert.Equal(BrokerPublished.NoSubscriber, await caller.Publish(new BrokerPublication { Topic = name, Payload = payload }).WaitAsync(Patience, Cancelled));
        }
        finally
        {
            foreach (var adapter in adapters)
            {
                await adapter.DisposeAsync();
            }
        }
    }

    [Fact(Skip = MqttFixture.Reason, SkipUnless = nameof(IsMqtt))]
    public async Task A_group_member_s_stop_answers_each_OPEN_that_comes_during_it_by_another_member_or_refuses_it_503_none_lost_spec_15_21()
    {
        // * the stopping member a round trip of 300 ms away, as the window its stop closes was
        await using var relay = Bead.Tests.LinkRelay.To(MqttFixture.Url, TimeSpan.FromMilliseconds(150));
        var participants = GroupUsers.Select((id, index) =>
        {
            return new BrokerParticipant(new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = id, Password = MqttFixture.Password, Uri = index == 0 ? relay.Uri : MqttFixture.Url }));
        }).ToList();
        var (stopping, twin, calling) = (participants[0], participants[1], participants[2]);
        var name = string.Create(CultureInfo.InvariantCulture, $"stopping-{TimeProvider.System.GetTimestamp()}");
        var outcomes = new ConcurrentQueue<string>();

        // each connect's outcome: opened by a member, refused 503 by the stopping one, or lost
        async Task ConnectOnce()
        {
            await using var client = calling.Client();

            try
            {
                await client.Connect(new BrokerTransportClientConnectOptions { Server = name, Timeout = TimeSpan.FromSeconds(3), CancellationToken = Cancelled });
                outcomes.Enqueue("opened");
                await client.CloseConnection();
            }
            catch (Exception reason) when (reason is ConnectException or TimeoutException)
            {
                outcomes.Enqueue(reason.Message.Contains("503 busy", StringComparison.Ordinal) ? "refused 503" : $"lost: {reason.Message}");
            }
        }

        try
        {
            await stopping.Server(new BrokerTransportServerOptions { Names = [name], IsInGroup = true }).Start().WaitAsync(Patience, Cancelled);
            await twin.Server(new BrokerTransportServerOptions { Names = [name], IsInGroup = true }).Start().WaitAsync(Patience, Cancelled);
            await calling.Start().WaitAsync(Patience, Cancelled);

            for (var round = 0; round < 2; round++)
            {
                var connects = new List<Task>();
                var stopped = stopping.Stop();

                // * a connect at once, then every 20 ms through its stop and a round trip past it
                while (!stopped.IsCompleted)
                {
                    connects.Add(ConnectOnce());
                    await Task.Delay(20, Cancelled);
                }

                for (var after = 0; after < 15; after++)
                {
                    connects.Add(ConnectOnce());
                    await Task.Delay(20, Cancelled);
                }

                await stopped.WaitAsync(Patience, Cancelled);
                await Task.WhenAll(connects).WaitAsync(TimeSpan.FromSeconds(15), Cancelled);
                await stopping.Start().WaitAsync(Patience, Cancelled);
            }
        }
        finally
        {
            foreach (var participant in new[] { calling, twin, stopping })
            {
                await participant.DisposeAsync();
            }
        }

        // * each answered: by another member, or refused 503 by the stopping one, none waiting out
        // its connect
        Assert.DoesNotContain(outcomes, (outcome) =>
        {
            return outcome.StartsWith("lost", StringComparison.Ordinal);
        });
        Assert.True(outcomes.Count > 20, $"each connect made: {outcomes.Count}");
    }

    /// <summary>Whether a broker is given, or asked for: the fixture's tests run, and fail where none is.</summary>
    public static bool IsMqtt
    {
        get
        {
            return MqttFixture.IsGiven;
        }
    }

    // ── Its stop's drain, its dispose, and a participant's stop in place over it ─────────────────

    // a CONNACK that holds its publications to a Receive Maximum
    private static MqttConnAckPacket ConnAckOf(ushort receiveMaximum)
    {
        var answer = ScriptedLink.ConnAck();

        answer.ReceiveMaximum = receiveMaximum;

        return answer;
    }

    // the participant's link, its server's start serving interop: its CONNACK the one given, its
    // inbox's SUBSCRIBE and its name's granted
    private async Task<ScriptedLink> ServedUp((BrokerTransportServer Server, MqttConnAckPacket ConnAck) serving)
    {
        var starting = serving.Server.Start();
        var link = await _script.Link();

        await link.Send(serving.ConnAck);
        await SubAckOf((link, 1));
        await SubAckOf((link, 1));
        await starting.WaitAsync(Patience, Cancelled);

        return link;
    }

    // an OPEN of bob's to interop for each opener given, each ACCEPT its participant answers
    // acknowledged: a connection half-open of each
    private static async Task HalfOpened((ScriptedLink Link, ushort Openers) opened)
    {
        for (ushort opener = 1; opener <= opened.Openers; opener++)
        {
            var open = BrokerParcels.Write(new BrokerParcel { Kind = BrokerParcelKinds.Open, Opener = opener, Sequence = 1, Id = "bob", Incarnation = 0xB0B, Bound = 65_536 });

            await opened.Link.Send(PublishOf(("bead/s/interop", open, opener)));

            var accept = await opened.Link.Next<MqttPublishPacket>();

            Assert.Equal("bead/i/bob", accept.Topic);
            await PubAckOf((opened.Link, accept.PacketIdentifier, 0));
        }
    }

    // the parcel a PUBLISH carries
    private static BrokerParcel ParcelOf(MqttPublishPacket publish)
    {
        return BrokerParcels.Read(publish.Payload.ToArray()).Parcel!;
    }

    // spec 15.24
    [Fact]
    public async Task Sends_what_waits_on_its_broker_s_Receive_Maximum_before_its_stop_s_DISCONNECT_within_its_connectTimeout_and_fails_what_has_not_gone_by_then()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script), (ConnAckOf(1), null));
        var publishing = Enumerable.Range(1, 3).Select((index) =>
        {
            return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[(byte)index] });
        }).ToList();
        var first = await link.Next<MqttPublishPacket>();
        var stopping = adapter.Stop();

        // * its stop waits for what it was handed, each PUBACK given late, then its DISCONNECT
        await Task.Delay(100, Cancelled);
        Assert.False(stopping.IsCompleted);
        await PubAckOf((link, first.PacketIdentifier, 0));

        foreach (var _ in new[] { 2, 3 })
        {
            var next = await link.Next<MqttPublishPacket>();

            await Task.Delay(50, Cancelled);
            await PubAckOf((link, next.PacketIdentifier, 0));
        }

        var disconnect = await link.Next<MqttDisconnectPacket>();

        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, disconnect.ReasonCode);
        Assert.Equal(Enumerable.Repeat(BrokerPublished.Taken, 3), await Task.WhenAll(publishing).WaitAsync(Patience, Cancelled));
        Assert.Equal([1, 2, 3], link.PacketsOf<MqttPublishPacket>().Select((publish) =>
        {
            return (int)publish.Payload.FirstSpan[0];
        }));

        // * past its connectTimeout, what has not gone fails, and its DISCONNECT goes all the same
        await using var bounded = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(300) };
        });
        var held = await LinkUp((bounded, _script), (ConnAckOf(1), null));
        var unanswered = bounded.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[4] });
        var waiting = bounded.Publish(new BrokerPublication { Topic = Inbox, Payload = (byte[])[5] });

        await held.Next<MqttPublishPacket>();
        await bounded.Stop().WaitAsync(Patience, Cancelled);

        foreach (var pending in new[] { unanswered, waiting })
        {
            Assert.Equal("the link of ada stopped", Assert.IsType<IOException>(await FailureOf(() =>
            {
                return pending;
            })).Message);
        }

        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await held.Next<MqttDisconnectPacket>()).ReasonCode);
        Assert.Single(held.PacketsOf<MqttPublishPacket>());
    }

    [Fact]
    public async Task Lets_go_at_its_stop_of_each_subscription_its_link_holds_once_what_it_was_handed_went_one_UNSUBSCRIBE_per_filter_sent_at_once_and_their_UNSUBACKs_of_0x00_or_0x11_awaited_together_then_sends_its_DISCONNECT_of_0x00_spec_15_24_15_26()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        // * its inbox, a name of its group and a peer's departure
        foreach (var (topic, group) in new (string[] Topic, string? Group)[] { (Inbox, null), (Name, "interop"), (["bead", "d", "bob"], null) })
        {
            var subscribing = adapter.Subscribe(topic, group is null ? null : new BrokerSubscription { Group = group });

            await SubAckOf((link, 1));
            await subscribing.WaitAsync(Patience, Cancelled);
        }

        _script.IsHoldingUnsubscribes = true;

        var publishing = adapter.Publish(new BrokerPublication { Topic = ["bead", "i", "bob"], Payload = (byte[])[1] });
        var publish = await link.Next<MqttPublishPacket>();
        var stopping = adapter.Stop();

        // none while what it was handed awaits its PUBACK
        await Task.Delay(100, Cancelled);
        Assert.Empty(link.PacketsOf<MqttUnsubscribePacket>());
        await PubAckOf((link, publish.PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await publishing.WaitAsync(Patience, Cancelled));

        // * each read before any UNSUBACK is sent: all of them at once, one filter each
        List<MqttUnsubscribePacket> unsubscribes = [await link.Next<MqttUnsubscribePacket>(), await link.Next<MqttUnsubscribePacket>(), await link.Next<MqttUnsubscribePacket>()];

        Assert.Equal(["$share/interop/bead/s/interop", "bead/d/bob", "bead/i/ada"], unsubscribes.Select((unsubscribe) =>
        {
            return Assert.Single(unsubscribe.TopicFilters);
        }).Order(StringComparer.Ordinal));

        // * 0x11, none held, lets one go as 0x00 does
        for (var index = 0; index < unsubscribes.Count; index++)
        {
            await Task.Delay(50, Cancelled);
            Assert.Empty(link.PacketsOf<MqttDisconnectPacket>());
            await link.Send(new MqttUnsubAckPacket
            {
                PacketIdentifier = unsubscribes[index].PacketIdentifier,
                ReasonCodes = [index == 1 ? MqttUnsubscribeReasonCode.NoSubscriptionExisted : MqttUnsubscribeReasonCode.Success],
            });
        }

        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await link.Next<MqttDisconnectPacket>()).ReasonCode);
        Assert.Equal(
            [
                typeof(MqttConnectPacket),
                typeof(MqttSubscribePacket),
                typeof(MqttSubscribePacket),
                typeof(MqttSubscribePacket),
                typeof(MqttPublishPacket),
                typeof(MqttUnsubscribePacket),
                typeof(MqttUnsubscribePacket),
                typeof(MqttUnsubscribePacket),
                typeof(MqttDisconnectPacket),
            ],
            link.Packets.Select((packet) =>
            {
                return packet.GetType();
            }));
        Assert.Empty(downs);
    }

    [Fact]
    public async Task Sends_its_stop_s_DISCONNECT_of_0x00_all_the_same_where_an_UNSUBACK_refuses_or_none_comes_what_it_was_handed_and_its_UNSUBACKs_awaited_within_one_connectTimeout_of_its_call_spec_15_26_15_30()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(1_000) };
        });
        var (_, downs) = HeardOf(adapter);
        var link = await LinkUp((adapter, _script));

        foreach (var topic in new[] { Inbox, ["bead", "d", "bob"] })
        {
            var subscribing = adapter.Subscribe(topic);

            await SubAckOf((link, 1));
            await subscribing.WaitAsync(Patience, Cancelled);
        }

        _script.IsHoldingUnsubscribes = true;

        var publishing = adapter.Publish(new BrokerPublication { Topic = ["bead", "i", "bob"], Payload = (byte[])[1] });
        var publish = await link.Next<MqttPublishPacket>();
        var watch = Stopwatch.StartNew();
        var stopping = adapter.Stop();

        // * half its connectTimeout spent on what it was handed
        await Task.Delay(500, Cancelled);
        await PubAckOf((link, publish.PacketIdentifier, 0));
        Assert.Equal(BrokerPublished.Taken, await publishing.WaitAsync(Patience, Cancelled));

        var refused = await link.Next<MqttUnsubscribePacket>();

        // the second's UNSUBACK withheld
        await link.Next<MqttUnsubscribePacket>();
        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = refused.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.UnspecifiedError] });
        await stopping.WaitAsync(Patience, Cancelled);

        var spent = watch.Elapsed;

        Assert.True(spent >= TimeSpan.FromMilliseconds(950), $"its connectTimeout waited, {spent.TotalMilliseconds} ms");
        Assert.True(spent < TimeSpan.FromMilliseconds(1_400), $"one connectTimeout from its call, not one after its drain, {spent.TotalMilliseconds} ms");

        // * its DISCONNECT, no will
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await link.Next<MqttDisconnectPacket>()).ReasonCode);
        Assert.Empty(downs);
    }

    [Fact]
    public async Task Lets_each_filter_go_at_its_stop_in_an_UNSUBSCRIBE_of_its_own_none_past_its_CONNACK_s_Maximum_Packet_Size_spec_15_26_15_27()
    {
        const uint MaximumPacketSize = 64;

        await using var adapter = AdapterOf();
        var answer = ScriptedLink.ConnAck();

        answer.MaximumPacketSize = MaximumPacketSize;

        var link = await LinkUp((adapter, _script), (answer, null));
        var departures = Departed.Select((peer) =>
        {
            return new[] { "bead", "d", $"{peer}-{new string('x', 30)}" };
        }).ToList();

        foreach (var topic in departures)
        {
            var subscribing = adapter.Subscribe(topic);

            await SubAckOf((link, 1));
            await subscribing.WaitAsync(Patience, Cancelled);
        }

        await adapter.Stop();

        var unsubscribes = link.PacketsOf<MqttUnsubscribePacket>();
        var filters = LetGoOf(link);

        Assert.Equal(departures.Select((topic) =>
        {
            return string.Join('/', topic);
        }).Order(StringComparer.Ordinal), filters.Order(StringComparer.Ordinal));

        // * one filter each, none past it
        Assert.Equal([1, 1, 1, 1, 1], unsubscribes.Select((unsubscribe) =>
        {
            return unsubscribe.TopicFilters.Count;
        }));
        Assert.All(unsubscribes, (unsubscribe) =>
        {
            Assert.True(BytesOf(unsubscribe) <= MaximumPacketSize, $"an UNSUBSCRIBE of {BytesOf(unsubscribe)} bytes");
        });

        // * one packet of them all would pass it, which its broker ends the link for, its will sent
        Assert.True(BytesOf(new MqttUnsubscribePacket { PacketIdentifier = 1, TopicFilters = filters }) > MaximumPacketSize);
    }

    [Fact]
    public async Task Lets_go_at_its_stop_of_a_filter_whose_SUBSCRIBE_went_with_no_SUBACK_yet_its_subscription_failed_spec_15_27()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));
        var subscribing = adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        var subscribe = await link.Next<MqttSubscribePacket>();

        _script.IsHoldingUnsubscribes = true;

        var stopping = adapter.Stop();
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();

        Assert.Equal(["$share/interop/bead/s/interop"], unsubscribe.TopicFilters);

        // * its SUBACK, come behind, holds nothing: its broker read the UNSUBSCRIBE after it
        await link.Send(new MqttSubAckPacket { PacketIdentifier = subscribe.PacketIdentifier, ReasonCodes = [MqttSubscribeReasonCode.GrantedQoS1] });
        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.Success] });
        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal("the link of ada stopped", (await FailureOf(() =>
        {
            return subscribing;
        })).Message);
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await link.Next<MqttDisconnectPacket>()).ReasonCode);
    }

    [Fact]
    public async Task Keeps_a_subscription_asked_again_while_its_UNSUBSCRIBE_awaits_its_UNSUBACK_which_its_stop_then_lets_go_spec_15_27()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));
        var subscribing = adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);

        // * let go, then asked again before that UNSUBACK came
        _script.IsHoldingUnsubscribes = true;

        var leaving = adapter.Unsubscribe(Name);
        var unsubscribe = await link.Next<MqttUnsubscribePacket>();
        var again = adapter.Subscribe(Name, new BrokerSubscription { Group = "interop" });
        var subscribe = await link.Next<MqttSubscribePacket>();

        await link.Send(new MqttUnsubAckPacket { PacketIdentifier = unsubscribe.PacketIdentifier, ReasonCodes = [MqttUnsubscribeReasonCode.Success] });
        await link.Send(new MqttSubAckPacket { PacketIdentifier = subscribe.PacketIdentifier, ReasonCodes = [MqttSubscribeReasonCode.GrantedQoS1] });
        await leaving.WaitAsync(Patience, Cancelled);
        await again.WaitAsync(Patience, Cancelled);
        _script.IsHoldingUnsubscribes = false;
        await adapter.Stop().WaitAsync(Patience, Cancelled);

        // its own UNSUBSCRIBE, then its stop's, of the subscription asked again
        Assert.Equal(["$share/interop/bead/s/interop", "$share/interop/bead/s/interop"], LetGoOf(link));
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, (await link.Next<MqttDisconnectPacket>()).ReasonCode);
    }

    [Fact]
    public async Task Sends_no_UNSUBSCRIBE_at_its_stop_ahead_of_a_publication_that_waits_on_its_broker_s_Receive_Maximum_spec_15_26_15_28()
    {
        await using var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script), (ConnAckOf(2), null));
        var subscribing = adapter.Subscribe(Inbox);

        await SubAckOf((link, 1));
        await subscribing.WaitAsync(Patience, Cancelled);

        // * a peer's CLOSE each, as a participant's stop hands them on
        var publishing = Enumerable.Range(1, 4).Select((index) =>
        {
            return adapter.Publish(new BrokerPublication { Topic = ["bead", "i", "bob"], Payload = (byte[])[(byte)index] });
        }).ToList();

        await Until(() =>
        {
            return link.PacketsOf<MqttPublishPacket>().Count == 2;
        });

        var stopping = adapter.Stop();

        for (var index = 0; index < 4; index++)
        {
            var sent = Math.Min(index + 2, 4);

            await Until(() =>
            {
                return link.PacketsOf<MqttPublishPacket>().Count == sent;
            });
            await Task.Delay(20, Cancelled);

            // none while one waits
            Assert.Empty(link.PacketsOf<MqttUnsubscribePacket>());
            await PubAckOf((link, link.PacketsOf<MqttPublishPacket>()[index].PacketIdentifier, 0));
        }

        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal(["bead/i/ada"], LetGoOf(link));
        Assert.Equal(Enumerable.Repeat(BrokerPublished.Taken, 4), await Task.WhenAll(publishing).WaitAsync(Patience, Cancelled));
        await link.Next<MqttDisconnectPacket>();
        Assert.Equal(
            [
                typeof(MqttConnectPacket),
                typeof(MqttSubscribePacket),
                typeof(MqttPublishPacket),
                typeof(MqttPublishPacket),
                typeof(MqttPublishPacket),
                typeof(MqttPublishPacket),
                typeof(MqttUnsubscribePacket),
                typeof(MqttDisconnectPacket),
            ],
            link.Packets.Select((packet) =>
            {
                return packet.GetType();
            }));
    }

    // decision 0003
    [Fact]
    public async Task Refuses_a_start_once_disposed_its_state_kept_and_disposes_once_stopping_it_first()
    {
        var adapter = AdapterOf();
        var link = await LinkUp((adapter, _script));

        // * two disposes: one stop, one DISCONNECT of 0x00
        await Task.WhenAll(adapter.DisposeAsync().AsTask(), adapter.DisposeAsync().AsTask()).WaitAsync(Patience, Cancelled);
        await link.Closed.WaitAsync(Patience, Cancelled);
        Assert.Single(link.PacketsOf<MqttDisconnectPacket>());
        Assert.False(adapter.IsLinked);

        // * a start after it: its application's misuse, refused before anything goes
        Assert.Equal("the adapter of ada is disposed", (await Assert.ThrowsAsync<ObjectDisposedException>(() =>
        {
            return adapter.Start();
        })).Message);
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Sends_each_connection_s_CLOSE_of_1001_before_its_adapter_s_DISCONNECT_past_its_broker_s_Receive_Maximum_spec_15_21()
    {
        await using var participant = new BrokerParticipant(AdapterOf());
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"] });
        var link = await ServedUp((server, ConnAckOf(1)));

        await HalfOpened((link, 3));

        var stopping = participant.Stop();

        // * one CLOSE at a time, its PUBACK given late, each before its adapter's DISCONNECT
        var closes = new List<BrokerParcel>();

        foreach (var _ in new[] { 1, 2, 3 })
        {
            var close = await link.Next<MqttPublishPacket>();

            closes.Add(ParcelOf(close));
            Assert.Equal("bead/i/bob", close.Topic);
            await Task.Delay(50, Cancelled);
            Assert.False(stopping.IsCompleted);
            await PubAckOf((link, close.PacketIdentifier, 0));
        }

        var disconnect = await link.Next<MqttDisconnectPacket>();

        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal(MqttDisconnectReasonCode.NormalDisconnection, disconnect.ReasonCode);
        Assert.All(closes, (close) =>
        {
            Assert.Equal((BrokerParcelKinds.Close, 1001), (close.Kind, close.Code));
        });
        Assert.Equal([1UL, 2UL, 3UL], closes.Select((close) =>
        {
            return close.Opener;
        }).Order());
    }

    [Fact]
    public async Task Resets_at_its_next_link_each_peer_whose_CLOSE_its_broker_did_not_take_as_it_stopped_spec_15_21()
    {
        await using var participant = new BrokerParticipant(AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(500) };
        }));
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"] });
        var link = await ServedUp((server, ConnAckOf(1)));

        await HalfOpened((link, 2));

        // * the first CLOSE taken, the second's PUBACK held past its connectTimeout: unanswered as
        // its DISCONNECT went
        var stopping = participant.Stop();
        var taken = await link.Next<MqttPublishPacket>();

        await PubAckOf((link, taken.PacketIdentifier, 0));

        var untaken = await link.Next<MqttPublishPacket>();

        await link.Next<MqttDisconnectPacket>(TimeSpan.FromSeconds(3));
        await stopping.WaitAsync(Patience, Cancelled);
        Assert.Equal(BrokerParcelKinds.Close, ParcelOf(untaken).Kind);

        // * its next link resets the second, whose CLOSE its broker did not take, and no other
        var starting = participant.Start();
        var next = await _script.Link();

        await next.Send(ConnAckOf(1));
        await SubAckOf((next, 1));
        await SubAckOf((next, 1));
        await starting.WaitAsync(Patience, Cancelled);

        var reset = await next.Next<MqttPublishPacket>();

        await PubAckOf((next, reset.PacketIdentifier, 0));
        Assert.Equal("bead/i/bob", reset.Topic);
        Assert.Equal((BrokerParcelKinds.Reset, ParcelOf(untaken).Opener, ParcelOf(untaken).Acceptor), (ParcelOf(reset).Kind, ParcelOf(reset).Opener, ParcelOf(reset).Acceptor));
        await Task.Delay(200, Cancelled);
        Assert.Single(next.PacketsOf<MqttPublishPacket>());

        // its link ended before its server's names are let go, which no UNSUBACK would answer
        await participant.DisposeAsync();
    }

    // the adapter's WebSocket as its broker's end holds it: the head of its upgrade as it came, its
    // peer, and the server WebSocket over that peer's stream
    private sealed record UpgradedPeer : IDisposable
    {
        public required string Head { get; init; }

        public required System.Net.Sockets.TcpClient Peer { get; init; }

        public required System.Net.WebSockets.WebSocket Broker { get; init; }

        public void Dispose()
        {
            Broker.Dispose();
            Peer.Dispose();
        }
    }
}
