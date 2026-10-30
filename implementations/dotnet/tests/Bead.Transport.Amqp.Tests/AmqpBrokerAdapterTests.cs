using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Amqp;
using Amqp.Framing;
using Amqp.Types;
using Bead.Tests;
using AmqpClose = Amqp.Framing.Close;
using AmqpEnd = Amqp.Framing.End;
using AmqpMessage = Amqp.Message;
using AmqpTransfer = Amqp.Framing.Transfer;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// The adapter over AMQPNetLite against a scripted AMQP 1.0 peer, <see cref="AmqpScript"/>, which
/// answers as RabbitMQ 4 does unless a test holds a frame and answers it itself, so that every frame
/// the adapter sends is read as it goes; and, where <c>BEAD_AMQP_URL</c> names a RabbitMQ (<c>node
/// tools/amqp-broker.mjs run -- dotnet test</c>), what only a real broker shows: an id's inbox held
/// by a silent connection until its broker reaps it, a queue gone with its connection, a name its
/// permissions deny, a message past a bound, and a name's queue its consumers share. The TypeScript
/// side's <c>amqp-broker-adapter.test.ts</c> plays the same sentences.
/// </summary>
[Collection(AmqpFixture.Collection)]
public sealed class AmqpBrokerAdapterTests : IAsyncLifetime
{
    // constants

    private const string Id = "ada";
    private const string Password = "secret";

    // where a test plays: against the script, or against the run's broker
    private const string Scripted = "scripted";
    private const string Fixture = "fixture";

    private const string InboxQueue = "/queues/bead.i.ada";
    private const string NameQueue = "/queues/bead.s.interop";

    private static readonly string[] Inbox = ["bead", "i", Id];
    private static readonly string[] Name = ["bead", "s", "interop"];
    private static readonly string[] PeerInbox = ["bead", "i", "peer"];
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    // a self-signed certificate for 127.0.0.1, its server's and its client's alike
    private static readonly Lazy<X509Certificate2> Certificate = new(CertificateOf);

    private AmqpScript _script = null!;

    // helpers

    /// <summary>Whether a broker is given, or asked for: what plays against it runs, and fails where none is.</summary>
    public static bool IsBroker
    {
        get
        {
            return AmqpFixture.IsGiven;
        }
    }

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
    private AmqpBrokerAdapter AdapterOf(Func<AmqpBrokerAdapterOptions, AmqpBrokerAdapterOptions>? changed = null)
    {
        var options = new AmqpBrokerAdapterOptions { Id = Id, Password = Password, Uri = _script.Uri };

        return new AmqpBrokerAdapter(changed?.Invoke(options) ?? options);
    }

    // an adapter of an id to the run's broker, through a relay where one is given
    private static AmqpBrokerAdapter BrokerAdapterOf((string Id, LinkRelay? Relay) linked, Func<AmqpBrokerAdapterOptions, AmqpBrokerAdapterOptions>? changed = null)
    {
        var options = new AmqpBrokerAdapterOptions { Id = linked.Id, Password = AmqpFixture.Password, Uri = linked.Relay?.Uri ?? AmqpFixture.Url };

        return new AmqpBrokerAdapter(changed?.Invoke(options) ?? options);
    }

    // the adapter started, its connection the script's next
    private static async Task<ScriptedConnection> Started((AmqpBrokerAdapter Adapter, AmqpScript Script) starting)
    {
        var started = starting.Adapter.Start();
        var connection = await starting.Script.Connection();

        await started.WaitAsync(Patience, Cancelled);

        return connection;
    }

    // the adapter started and its inbox subscribed: its link up
    private static async Task<ScriptedConnection> LinkUp((AmqpBrokerAdapter Adapter, AmqpScript Script) linking)
    {
        var connection = await Started(linking);

        await linking.Adapter.Subscribe(Inbox).WaitAsync(Patience, Cancelled);

        return connection;
    }

    // the messages and the downs an adapter tells, as they come
    private static (ConcurrentQueue<BrokerMessage> Messages, ConcurrentQueue<BrokerDown> Downs) HeardOf(AmqpBrokerAdapter adapter)
    {
        var messages = new ConcurrentQueue<BrokerMessage>();
        var downs = new ConcurrentQueue<BrokerDown>();

        adapter.Message += messages.Enqueue;
        adapter.Down += downs.Enqueue;

        return (messages, downs);
    }

    // polls on the real clock until it holds, within its patience
    private static async Task Until(Func<bool> isDone, TimeSpan? within = null)
    {
        var watch = Stopwatch.StartNew();

        while (!isDone() && watch.Elapsed < (within ?? Patience))
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

    // whether a frame is an ATTACH of the adapter's to or from an address
    private static bool IsAttachOf(ScriptedFrame frame, string address)
    {
        return frame.Performative is Attach attach && (attach.Role ? (attach.Source as Source)?.Address : (attach.Target as Target)?.Address) == address;
    }

    // whether a frame is a management request of a method, whole in one frame
    private static bool IsRequestOf(ScriptedFrame frame, string method)
    {
        if (frame.Performative is not AmqpTransfer || frame.Payload.Length == 0)
        {
            return false;
        }

        try
        {
            return AmqpMessage.Decode(new ByteBuffer(frame.Payload, 0, frame.Payload.Length, frame.Payload.Length)).Properties?.Subject == method;
        }
        catch (AmqpException)
        {
            return false;
        }
    }

    // a message of one Data section, as a broker delivers a parcel
    private static AmqpMessage ParcelOf(byte[] payload)
    {
        return new AmqpMessage { Properties = new Properties { To = "/exchanges/bead/bead.i.ada" }, BodySection = new Data { Binary = payload } };
    }

    // an OPEN of the peer's, its opener told apart by its last byte, as its name's queue holds one
    private static AmqpMessage OpenOf(byte opener)
    {
        return ParcelOf(BrokerParcels.Write(new BrokerParcel
        {
            Kind = BrokerParcelKinds.Open,
            Opener = 0xA0UL << 56 | opener,
            Sequence = 1,
            Id = "peer",
            Incarnation = UInt128.Zero,
            Bound = 65_536,
        }));
    }

    // the kinds of the parcels the adapter published to an address, in their order
    private static List<byte> KindsTo((ScriptedConnection Connection, string Address) sent)
    {
        return [.. TransfersTo(sent).Select((transfer) =>
        {
            return ((Data)transfer.Message.BodySection).Binary[1];
        })];
    }

    // the transfers of the adapter's to an address
    private static List<ScriptedTransfer> TransfersTo((ScriptedConnection Connection, string Address) sent)
    {
        return [.. sent.Connection.Transfers.Where((transfer) =>
        {
            return transfer.Message.Properties?.To == sent.Address;
        })];
    }

    // definition

    [Fact]
    public async Task Fails_its_queued_publications_and_pending_name_subscription_when_stopped_and_lets_none_reach_its_next_link()
    {
        _script.SenderCredit = 1;
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = Inbox }));
        var waiting = adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = Inbox });
        var subscribing = adapter.Subscribe(Name);

        await connection.Next((frame) =>
        {
            return frame.Performative is AmqpTransfer && !IsRequestOf(frame, "PUT") && !IsRequestOf(frame, "POST");
        });
        await connection.Next((frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        });
        Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.ada")));
        await adapter.Stop();

        foreach (var pending in new Task[] { waiting, subscribing })
        {
            var failure = await FailureOf(() =>
            {
                return pending;
            });

            Assert.IsType<IOException>(failure);
            Assert.Equal("the link of ada stopped", failure.Message);
        }

        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
        Assert.Equal(0, adapter.Unsettled);
        Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.ada")));
        _script.Holding = (_) =>
        {
            return false;
        };

        var next = await LinkUp((adapter, _script));

        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[3], Topic = Inbox }));
        Assert.Equal((byte[])[3], ((Data)Assert.Single(next.Transfers, (transfer) =>
        {
            return transfer.Message.Properties?.To == "/exchanges/bead/bead.i.ada";
        }).Message.BodySection).Binary);
        Assert.Empty(downs);
        Assert.True(adapter.IsLinked);
    }

    [Fact]
    public async Task Fails_a_transmitted_publication_without_an_outcome_a_queued_publication_and_a_pending_name_subscription_alike_when_stopped_none_NoSubscriber()
    {
        _script.SenderCredit = 1;
        _script.Holding = (frame) =>
        {
            return (frame.Performative is AmqpTransfer && !IsRequestOf(frame, "PUT") && !IsRequestOf(frame, "POST")) || IsAttachOf(frame, NameQueue);
        };

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var sent = adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = Inbox });
        var waiting = adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = Inbox });
        var subscribing = adapter.Subscribe(Name);

        await connection.Next((frame) =>
        {
            return frame.Performative is AmqpTransfer && !IsRequestOf(frame, "PUT") && !IsRequestOf(frame, "POST");
        });
        await connection.Next((frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        });
        await adapter.Stop();

        // * its library releases what an ending session held: none of it is the broker's released
        foreach (var pending in new Task[] { sent, waiting, subscribing })
        {
            var failure = await FailureOf(() =>
            {
                return pending;
            });

            Assert.IsType<IOException>(failure);
            Assert.Equal("the link of ada stopped", failure.Message);
        }

        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
        Assert.Equal(0, adapter.Unsettled);
        Assert.Equal(1, connection.Frames.Count((frame) =>
        {
            return frame.Performative is AmqpTransfer && !IsRequestOf(frame, "PUT") && !IsRequestOf(frame, "POST");
        }));
    }

    [Fact]
    public async Task Fails_an_inbox_subscription_awaiting_its_ATTACH_with_its_stop_and_tells_no_loss_spec_15_33()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await Started((adapter, _script));

        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, InboxQueue);
        };

        var subscribing = adapter.Subscribe(Inbox);

        await connection.Next((frame) =>
        {
            return IsAttachOf(frame, InboxQueue);
        });
        await adapter.Stop();
        var failure = await FailureOf(() =>
        {
            return subscribing;
        });

        Assert.IsType<IOException>(failure);
        Assert.Equal("the link of ada stopped", failure.Message);
        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
    }

    [Fact]
    public async Task Refuses_its_start_when_a_sending_link_is_refused_and_a_publication_whose_fresh_sending_link_is_refused_sending_nothing_on_it_and_keeping_its_link_spec_15_33()
    {
        var refusal = new Error(new Symbol("amqp:not-allowed")) { Description = "sender denied" };
        Func<ScriptedFrame, bool> isSending = (frame) =>
        {
            return frame.Performative is Attach { Role: false } attach && (attach.Target as Target)?.Address is null;
        };

        _script.Holding = isSending;

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        var first = await _script.Connection();

        await first.AnswerAttach(await first.Next(isSending), refusal);
        var failure = await FailureOf(() =>
        {
            return starting;
        });

        Assert.IsType<IOException>(failure);
        Assert.Contains("amqp:not-allowed, sender denied", failure.Message, StringComparison.Ordinal);
        await first.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
        _script.Holding = (_) =>
        {
            return false;
        };

        // * the inboxes' sending session ended: the next publication begins another, refused
        var connection = await LinkUp((adapter, _script));

        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = Inbox }));
        var parcels = connection.Links.First((link) =>
        {
            return !link.IsReceiver && link.Name.StartsWith("parcels", StringComparison.Ordinal);
        });
        var ending = connection.Frames.Count;

        await connection.End(parcels.Channel);
        await connection.Next(
            (frame) =>
            {
                return frame.Performative is AmqpEnd && frame.Channel == parcels.Channel;
            },
            from: ending);
        _script.Holding = isSending;
        var sending = connection.Frames.Count;
        var publishing = adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = Inbox });

        await connection.AnswerAttach(await connection.Next(isSending, from: sending), refusal);
        var refused = await FailureOf(() =>
        {
            return publishing;
        });

        Assert.IsType<IOException>(refused);
        Assert.Contains("amqp:not-allowed, sender denied", refused.Message, StringComparison.Ordinal);
        Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.ada")));
        Assert.Empty(downs);
        Assert.True(adapter.IsLinked);
        _script.Holding = (_) =>
        {
            return false;
        };
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[3], Topic = Inbox }));
        Assert.Equal(2, TransfersTo((connection, "/exchanges/bead/bead.i.ada")).Count);
    }

    [Fact]
    public async Task Refuses_a_publication_and_a_subscription_whose_signal_is_aborted_without_sending_either_or_losing_its_link()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var begun = connection.Frames.Count((frame) =>
        {
            return frame.Performative is Begin;
        });
        var declared = connection.Transfers.Count;

        using var gone = new CancellationTokenSource();

        await gone.CancelAsync();

        foreach (var topic in new[] { Inbox, Name })
        {
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = topic, CancellationToken = gone.Token });
            }));
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return adapter.Subscribe(topic, new BrokerSubscription { CancellationToken = gone.Token });
            }));
        }

        Assert.Equal(begun, connection.Frames.Count((frame) =>
        {
            return frame.Performative is Begin;
        }));
        Assert.Equal(declared, connection.Transfers.Count);
        Assert.Empty(downs);
        Assert.True(adapter.IsLinked);
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = Inbox }));
    }

    [Fact]
    public async Task Fails_a_start_whose_sending_links_remain_unanswered_within_connectTimeout_and_starts_a_fresh_link_afterwards()
    {
        _script.Holding = (frame) =>
        {
            return frame.Performative is Attach attach && !attach.Role;
        };

        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromSeconds(1) };
        });
        var (_, downs) = HeardOf(adapter);
        var starting = adapter.Start();
        var connection = await _script.Connection();

        await connection.Next<Attach>();
        var failure = await FailureOf(() =>
        {
            return starting;
        });

        Assert.IsType<TimeoutException>(failure);
        Assert.Contains("within 1000 ms", failure.Message, StringComparison.Ordinal);
        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
        _script.Holding = (_) =>
        {
            return false;
        };

        var next = await LinkUp((adapter, _script));

        Assert.NotSame(connection, next);
        Assert.True(adapter.IsLinked);
    }

    [Fact]
    public async Task Fails_an_inbox_declaration_left_unanswered_within_connectTimeout_and_closes_its_connection_without_telling_a_loss()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromSeconds(1) };
        });
        var (_, downs) = HeardOf(adapter);
        var connection = await Started((adapter, _script));

        _script.Holding = (frame) =>
        {
            return IsRequestOf(frame, "PUT");
        };

        var subscribing = adapter.Subscribe(Inbox);

        await connection.NextRequest();
        var failure = await FailureOf(() =>
        {
            return subscribing;
        });

        Assert.IsType<TimeoutException>(failure);
        Assert.Contains("within 1000 ms", failure.Message, StringComparison.Ordinal);
        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Equal("PUT", Assert.Single(connection.Transfers).Message.Properties.Subject);
        Assert.Empty(downs);
        Assert.False(adapter.IsLinked);
        Assert.Equal(0, adapter.Unsettled);
    }

    [Fact]
    public async Task Refuses_its_inbox_when_either_management_link_is_refused_and_closes_its_connection_without_telling_a_loss()
    {
        foreach (var isReceiver in new[] { false, true })
        {
            await using var adapter = AdapterOf();
            var (_, downs) = HeardOf(adapter);
            var connection = await Started((adapter, _script));

            _script.Holding = (frame) =>
            {
                return IsAttachOf(frame, AmqpManagement.Node) && ((Attach)frame.Performative!).Role == isReceiver;
            };

            var subscribing = adapter.Subscribe(Inbox);
            var attaching = await connection.Next((frame) =>
            {
                return IsAttachOf(frame, AmqpManagement.Node) && ((Attach)frame.Performative!).Role == isReceiver;
            });

            await connection.AnswerAttach(attaching, new Error(new Symbol("amqp:not-allowed")) { Description = "management denied" });
            var failure = await FailureOf(() =>
            {
                return subscribing;
            });

            Assert.IsType<IOException>(failure);
            Assert.Contains("amqp:not-allowed, management denied", failure.Message, StringComparison.Ordinal);
            await connection.Closed.WaitAsync(Patience, Cancelled);
            Assert.False(adapter.IsLinked);
            Assert.Empty(downs);
            Assert.DoesNotContain(connection.Transfers, (transfer) =>
            {
                return transfer.Message.Properties?.Subject == "PUT";
            });
        }
    }

    [Fact]
    public async Task Opens_a_fresh_connection_each_start_its_container_id_its_id_SASL_PLAIN_as_its_id_or_EXTERNAL_under_a_certificate_its_idle_time_out_its_own_and_leaves_no_library_to_reconnect_or_recover_it_spec_15_33()
    {
        var asked = 0;
        await using var adapter = AdapterOf((options) =>
        {
            return options with
            {
                IdleTimeout = TimeSpan.FromMilliseconds(1_500),
                Password = null,
                PasswordProvider = (_) =>
                {
                    return Task.FromResult($"{Password}-{Interlocked.Increment(ref asked)}");
                },
            };
        });
        var (_, downs) = HeardOf(adapter);
        var first = await LinkUp((adapter, _script));

        Assert.Equal(
            (Id, "PLAIN", $"\0{Id}\0{Password}-1", 1_500u, (string?)null),
            (first.Open.ContainerId, first.SaslInit!.Mechanism.ToString(), Encoding.UTF8.GetString(first.SaslInit.InitialResponse), first.Open.IdleTimeOut, first.Open.HostName));
        Assert.Equal(TransportTypes.Amqp, adapter.Type);

        // * one link at a time: a start while it is up is refused
        Assert.Equal($"the link of {Id} is up already", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return adapter.Start();
        })).Message);

        // * lost, nothing of the library's connects it again
        first.Cut();
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Single(downs);
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return _script.Connection(TimeSpan.FromMilliseconds(500));
        });

        // a fresh connection each start, its password asked anew
        var second = await LinkUp((adapter, _script));

        Assert.Equal($"\0{Id}\0{Password}-2", Encoding.UTF8.GetString(second.SaslInit!.InitialResponse));
        await adapter.Stop();

        // its virtual host its OPEN's hostname
        await using var hosted = AdapterOf((options) =>
        {
            return options with { VirtualHost = "bead" };
        });

        Assert.Equal("vhost:bead", (await Started((hosted, _script))).Open.HostName);
        await hosted.Stop();

        // under a client certificate its broker maps to its id, over TLS: SASL EXTERNAL
        await using (var secured = AmqpScript.Start(Certificate.Value))
        {
            await using var certified = new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions
            {
                Id = Id,
                Tls = new AmqpBrokerTlsOptions { ClientCertificates = [Certificate.Value], TrustChain = [Certificate.Value] },
                Uri = secured.Uri,
            });
            var external = await Started((certified, secured));

            Assert.Equal(("EXTERNAL", Id, true, true), (external.SaslInit!.Mechanism.ToString(), external.Open.ContainerId, external.ClientCertificate is not null, certified.IsSecure));
            await certified.Stop();
        }

        // a certificate in the clear is refused as it is built
        Assert.StartsWith("a TLS client certificate is carried over amqps", Assert.Throws<ArgumentException>(() =>
        {
            return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = Id, Tls = new AmqpBrokerTlsOptions { ClientCertificates = [Certificate.Value] }, Uri = _script.Uri });
        }).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Declares_its_inbox_exclusive_classic_and_not_durable_through_management_on_its_own_connection_binds_it_to_its_root_s_exchange_and_is_up_once_its_receiver_attached_spec_15_33()
    {
        await using var adapter = AdapterOf();
        var connection = await Started((adapter, _script));

        // * its inbox's receiver held: its link is not up before its ATTACH is answered
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, InboxQueue);
        };

        var subscribing = adapter.Subscribe(Inbox);
        var (declared, _) = await connection.NextRequest(0);
        var (bound, _) = await connection.NextRequest(1);
        var attaching = await connection.Next((frame) =>
        {
            return IsAttachOf(frame, InboxQueue);
        });

        Assert.Equal(("PUT", "/queues/bead.i.ada", "POST", "/bindings"), (declared.Method, declared.Path, bound.Method, bound.Path));

        var queue = (Map)declared.Body!;
        var binding = (Map)bound.Body!;

        Assert.Equal(
            ((object)false, (object)true, (object)false, (object)"classic"),
            (queue["durable"], queue["exclusive"], queue["auto_delete"], ((Map)queue["arguments"])["x-queue-type"]));
        Assert.Equal(
            ((object)"bead", (object)"bead.i.ada", (object)"bead.i.ada", 0),
            (binding["source"], binding["destination_queue"], binding["binding_key"], ((Map)binding["arguments"]).Count));
        await Task.Delay(100, Cancelled);
        Assert.False(adapter.IsLinked);
        Assert.False(subscribing.IsCompleted);

        // its management's session ended before its inbox's begins, on the same connection
        var frames = connection.Frames.ToList();
        var management = connection.LinkOf(AmqpManagement.Node).Channel;
        var managementEnd = frames.FindIndex((frame) =>
        {
            return frame.Performative is AmqpEnd && frame.Channel == management;
        });

        Assert.InRange(managementEnd, 0, frames.IndexOf(attaching) - 1);

        await connection.AnswerAttach(attaching);
        await subscribing.WaitAsync(Patience, Cancelled);
        Assert.True(adapter.IsLinked);
        await adapter.Stop();
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Fails_its_start_on_a_declaration_answered_other_than_200_or_201_naming_it_and_while_another_connection_of_its_id_holds_the_inbox_its_participant_linking_once_it_is_let_go_spec_15_33(string against)
    {
        if (against == Fixture)
        {
            await HeldWhileSilent();

            return;
        }

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);

        _script.Management = (request) =>
        {
            return request.Method == "PUT"
                ? ("400", "cannot obtain exclusive access to locked queue 'bead.i.ada' in vhost '/'")
                : ("204", null);
        };

        var connection = await Started((adapter, _script));
        var refused = await FailureOf(() =>
        {
            return adapter.Subscribe(Inbox);
        });

        Assert.IsType<IOException>(refused);
        Assert.Contains("400, cannot obtain exclusive access to locked queue", refused.Message, StringComparison.Ordinal);

        // its connection closed, its inbox ending with it, and no loss told: it was never up
        await connection.Next<AmqpClose>();
        Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));

        // * once its inbox is let go, its next start links
        _script.Management = (request) =>
        {
            return request.Method == "PUT" ? ("201", new Map()) : ("204", null);
        };
        await LinkUp((adapter, _script));
        Assert.True(adapter.IsLinked);
        await adapter.Stop();

        // * and on its binding answered other than 204, naming it
        _script.Management = (request) =>
        {
            return request.Method == "PUT" ? ("201", new Map()) : ("403", "access refused");
        };

        var bound = await Started((adapter, _script));
        var unbound = await FailureOf(() =>
        {
            return adapter.Subscribe(Inbox);
        });

        Assert.IsType<IOException>(unbound);
        Assert.Contains("refused to bind the queue bead.i.ada of ada: 403, access refused", unbound.Message, StringComparison.Ordinal);
        await bound.Next<AmqpClose>();
        Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));
    }

    // against the broker: a participant's connection gone silent holds its inbox, so its next link
    // is refused 400 until its broker reaps the dead connection, after three of its heartbeat and
    // its close, about 40 s at the fixture's 10; its reconnection links once it is let go
    private static async Task HeldWhileSilent()
    {
        await using var relay = LinkRelay.To(AmqpFixture.Url);
        var adapter = BrokerAdapterOf((Id, relay), (options) =>
        {
            return options with { IdleTimeout = TimeSpan.FromSeconds(1) };
        });
        await using var participant = new BrokerParticipant(adapter);

        await participant.Start().WaitAsync(Patience, Cancelled);
        Assert.True(adapter.IsLinked);
        relay.Silence();
        await Until(
            () =>
            {
                return !adapter.IsLinked;
            },
            TimeSpan.FromSeconds(10));
        Assert.False(adapter.IsLinked);

        // * meanwhile, another link of its id is refused: the dead connection holds the inbox
        await using (var other = BrokerAdapterOf((Id, null)))
        {
            await other.Start().WaitAsync(Patience, Cancelled);
            Assert.Contains("400", (await FailureOf(() =>
            {
                return other.Subscribe(Inbox);
            })).Message, StringComparison.Ordinal);
        }

        var watch = Stopwatch.StartNew();

        await Until(
            () =>
            {
                return adapter.IsLinked;
            },
            TimeSpan.FromSeconds(120));
        Assert.True(adapter.IsLinked, $"its participant had not linked again after {watch.Elapsed.TotalSeconds} s");
        await participant.Stop();
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Fails_its_start_and_closes_its_connection_when_its_management_s_link_is_detached_its_session_ended_or_its_connection_lost_between_its_inbox_s_declaration_and_its_binding_and_leaves_no_queue_of_its_id_behind_spec_15_33(string against)
    {
        if (against == Fixture)
        {
            await using var relay = LinkRelay.To(AmqpFixture.Url);
            await using var linked = BrokerAdapterOf((Id, relay));

            // * cut as its declaration was answered, before its binding goes
            linked.InboxDeclared = async (token) =>
            {
                relay.Cut();
                await Task.Delay(100, token);
            };
            await linked.Start().WaitAsync(Patience, Cancelled);
            Assert.IsType<IOException>(await FailureOf(() =>
            {
                return linked.Subscribe(Inbox);
            }));
            await AmqpFixture.Gone((["bead.i.ada"], Patience));
            Assert.Equal("404", await AmqpFixture.QueueStatusOf("bead.i.ada"));

            return;
        }

        var ends = new (string Name, Func<ScriptedConnection, Task> End, bool IsClosed)[]
        {
            ("its management's link detached", (connection) =>
            {
                return connection.Detach(connection.Links.First((link) =>
                {
                    return link.Address == AmqpManagement.Node && !link.IsReceiver;
                }), new Error(new Symbol("amqp:internal-error")));
            }, true),
            ("its management's session ended", (connection) =>
            {
                return connection.End(connection.LinkOf(AmqpManagement.Node).Channel, new Error(new Symbol("amqp:internal-error")));
            }, true),
            ("its connection lost", (connection) =>
            {
                connection.Cut();

                return Task.CompletedTask;
            }, false),
        };

        // * its binding's request held: what ends comes between it and its declaration's answer
        _script.Holding = (frame) =>
        {
            return IsRequestOf(frame, "POST");
        };

        foreach (var (name, end, isClosed) in ends)
        {
            await using var adapter = AdapterOf();
            var (_, downs) = HeardOf(adapter);
            var connection = await Started((adapter, _script));
            var subscribing = adapter.Subscribe(Inbox);

            await connection.NextRequest(1);
            await end(connection);
            Assert.True(await FailureOf(() =>
            {
                return subscribing;
            }) is IOException, name);

            if (isClosed)
            {
                await connection.Next<AmqpClose>();
            }

            Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));
        }
    }

    [Fact]
    public async Task Tells_its_link_lost_once_on_the_end_of_its_connection_or_of_its_inbox_s_session_or_receiver_closes_its_connection_and_lets_nothing_of_a_lost_link_reach_the_next_spec_15_33()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var ends = new (string Name, Func<ScriptedConnection, Task> End, bool IsClosed)[]
        {
            ("its connection ended", (connection) =>
            {
                return connection.Close(new Error(new Symbol("amqp:connection:forced")));
            }, false),
            ("its connection cut", (connection) =>
            {
                connection.Cut();

                return Task.CompletedTask;
            }, false),
            ("its inbox's session ended", (connection) =>
            {
                return connection.End(connection.LinkOf(InboxQueue).Channel, new Error(new Symbol("amqp:internal-error")));
            }, true),
            ("its inbox's receiver detached", (connection) =>
            {
                return connection.Detach(connection.LinkOf(InboxQueue), new Error(new Symbol("amqp:resource-deleted")));
            }, true),
        };

        foreach (var (name, end, isClosed) in ends)
        {
            var told = downs.Count;
            var connection = await LinkUp((adapter, _script));

            // a message handed on and not settled as its link is lost
            await connection.Deliver((connection.LinkOf(InboxQueue), ParcelOf([1, 2, 3])));
            await Until(() =>
            {
                return !messages.IsEmpty;
            });
            Assert.Equal(1, adapter.Unsettled);
            await end(connection);
            await Until(() =>
            {
                return downs.Count > told;
            });
            Assert.True(downs.Count == told + 1 && !adapter.IsLinked, name);

            // * what is asked of a link that is down is refused at once
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return adapter.Publish(new BrokerPublication { Topic = Inbox, Payload = new byte[] { 1 } });
            });
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return adapter.Subscribe(Name);
            });
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return adapter.Unsubscribe(Name);
            });

            if (isClosed)
            {
                await connection.Next<AmqpClose>();
            }

            // ! nothing of the lost link reaches the next: its message settled after it is never settled
            var next = await LinkUp((adapter, _script));
            Assert.True(messages.TryDequeue(out var former));
            former.Settle();
            await Task.Delay(100, Cancelled);
            Assert.Empty(next.Of<global::Amqp.Framing.Dispose>());
            Assert.Empty(connection.Of<global::Amqp.Framing.Dispose>());
            Assert.Equal(0, adapter.Unsettled);
            await adapter.Stop();
            Assert.True(downs.Count == told + 1, name);
        }

        // a listener let go hears no loss after, nor a message
        await using var unheard = AdapterOf();
        var later = new ConcurrentQueue<BrokerDown>();
        var heard = new ConcurrentQueue<BrokerMessage>();
        void Lost(BrokerDown down)
        {
            later.Enqueue(down);
        }

        void Heard(BrokerMessage message)
        {
            heard.Enqueue(message);
        }

        unheard.Down += Lost;
        unheard.Down -= Lost;
        unheard.Message += Heard;
        unheard.Message -= Heard;

        var fourth = await LinkUp((unheard, _script));

        await fourth.Deliver((fourth.LinkOf(InboxQueue), ParcelOf([4])));
        fourth.Cut();
        await Until(() =>
        {
            return !unheard.IsLinked;
        });
        await Task.Delay(100, Cancelled);
        Assert.Equal((0, 0), (later.Count, heard.Count));
    }

    [Fact]
    public async Task Attaches_a_held_name_s_receiver_again_once_on_a_fresh_session_when_its_broker_ends_it_telling_no_loss_and_tells_its_link_lost_when_that_is_refused_or_the_name_is_lost_again_never_attaching_a_name_it_lets_go_spec_15_33()
    {
        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        var first = connection.LinkOf(NameQueue);
        var begun = connection.Of<Begin>().Count;
        var mark = connection.Mark;

        // its broker ends it: attached again once, on a fresh session, no loss told
        await connection.Detach(first, new Error(new Symbol("amqp:internal-error")));
        await connection.Next(
            (frame) =>
            {
                return frame.Performative is AmqpEnd && frame.Channel == first.Channel;
            },
            from: mark);

        var again = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        Assert.Equal(begun + 1, connection.Of<Begin>().Count);
        await Task.Delay(100, Cancelled);
        Assert.Equal((true, 0), (adapter.IsLinked, downs.Count));

        // lost again on the same link: its link lost
        await connection.End(again.Channel, new Error(new Symbol("amqp:unauthorized-access")));
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Single(downs);

        // refused as it attaches again: its link lost
        var refusing = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };
        mark = refusing.Mark;
        await refusing.Detach(refusing.LinkOf(NameQueue), new Error(new Symbol("amqp:internal-error")));

        var refused = await refusing.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        await refusing.AnswerAttach(refused, new Error(new Symbol("amqp:not-found")));
        await Until(() =>
        {
            return downs.Count > 1;
        });
        Assert.Equal(2, downs.Count);

        // a name it lets go is never attached again, though its broker ends it as it goes
        _script.Holding = (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach;
        };

        var letting = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        mark = letting.Mark;

        var unsubscribing = adapter.Unsubscribe(Name);
        var detaching = await letting.Next(
            (frame) =>
            {
                return frame.Performative is global::Amqp.Framing.Detach;
            },
            from: mark);

        await letting.Detach(letting.LinkOf(NameQueue), new Error(new Symbol("amqp:resource-deleted")));
        await unsubscribing.WaitAsync(Patience, Cancelled);
        await Task.Delay(200, Cancelled);
        Assert.Single(letting.Of<Attach>(), (attach) =>
        {
            return (attach.Source as Source)?.Address == NameQueue;
        });
        Assert.Equal((true, 2), (adapter.IsLinked, downs.Count));
        Assert.True(((global::Amqp.Framing.Detach)detaching.Performative!).Closed);

        // * let go while its receiver is attached again: let go at once, and that ATTACH never held
        _script.Holding = (_) =>
        {
            return false;
        };
        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };
        mark = letting.Mark;
        await letting.Detach(letting.LinkOf(NameQueue), new Error(new Symbol("amqp:resource-deleted")));

        var reattaching = await letting.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        await adapter.Unsubscribe(Name).WaitAsync(Patience, Cancelled);
        await letting.AnswerAttach(reattaching);
        await letting.Next(
            (frame) =>
            {
                return frame.Performative is AmqpEnd && frame.Channel == reattaching.Channel;
            },
            from: mark);
        await Task.Delay(100, Cancelled);
        Assert.Equal((true, 2), (adapter.IsLinked, downs.Count));
        await adapter.Stop();
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Refuses_each_publication_a_sending_session_held_as_it_ends_keeps_its_link_and_begins_another_for_the_next_spec_15_33(string against)
    {
        if (against == Fixture)
        {
            await AmqpFixture.Purge("bead.s.interop");
            await using var linked = BrokerAdapterOf((Id, null));
            var (_, lost) = HeardOf(linked);

            await linked.Start().WaitAsync(Patience, Cancelled);
            await linked.Subscribe(Inbox).WaitAsync(Patience, Cancelled);

            // * a name its permissions deny ends the session of every OPEN in flight beside it
            var denied = linked.Publish(new BrokerPublication { Topic = ["bead", "s", "forbidden"], Payload = new byte[] { 1 } });
            var beside = linked.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 2 } });

            Assert.Contains("unauthorized-access", (await FailureOf(() =>
            {
                return denied;
            })).Message, StringComparison.Ordinal);
            Assert.IsType<IOException>(await FailureOf(() =>
            {
                return beside;
            }));
            Assert.Equal(BrokerPublished.Taken, await linked.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 3 } }).WaitAsync(Patience, Cancelled));
            Assert.Equal((true, 0), (linked.IsLinked, lost.Count));
            await linked.Stop();
            await AmqpFixture.Purge("bead.s.interop");

            return;
        }

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        // * its OPENs' transfers held: the session ends with one in flight
        _script.Holding = (frame) =>
        {
            return frame.Performative is AmqpTransfer && frame.Payload.Length > 0 && TransfersTo((connection, "/exchanges/bead/bead.s.interop")).Count > 0;
        };

        var opens = connection.Links.First((link) =>
        {
            return !link.IsReceiver && link.Name.StartsWith("opens", StringComparison.Ordinal);
        });
        var held = adapter.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 1 } });

        await Until(() =>
        {
            return TransfersTo((connection, "/exchanges/bead/bead.s.interop")).Count > 0;
        });
        await connection.End(opens.Channel, new Error(new Symbol("amqp:unauthorized-access")) { Description = "write access to topic 'bead.s.interop' in exchange 'bead' refused" });

        var refused = await FailureOf(() =>
        {
            return held;
        });

        Assert.IsType<IOException>(refused);
        Assert.Contains("amqp:unauthorized-access", refused.Message, StringComparison.Ordinal);
        Assert.Equal((true, 0), (adapter.IsLinked, downs.Count));

        // the next begins another session and sender
        _script.Holding = (_) =>
        {
            return false;
        };

        var begun = connection.Of<Begin>().Count;

        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 2 } }).WaitAsync(Patience, Cancelled));
        Assert.Equal(begun + 1, connection.Of<Begin>().Count);
        Assert.Equal(2, connection.Links.Count((link) =>
        {
            return !link.IsReceiver && link.Name.StartsWith("opens", StringComparison.Ordinal);
        }));

        // and its inboxes' sender was never touched
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { 3 } }).WaitAsync(Patience, Cancelled));
        Assert.Single(connection.Links, (link) =>
        {
            return !link.IsReceiver && link.Name.StartsWith("parcels", StringComparison.Ordinal);
        });
        await adapter.Stop();
    }

    [Fact]
    public async Task Subscribes_a_name_on_a_session_of_its_own_unsettled_first_no_max_message_size_held_once_its_ATTACH_named_its_source_spec_15_34()
    {
        await using var adapter = AdapterOf();
        var connection = await LinkUp((adapter, _script));

        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };

        var subscribing = adapter.Subscribe(Name);
        var attaching = await connection.Next((frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        });
        var attach = (Attach)attaching.Performative!;
        // ! the links still attached: a channel its management's session ended on is its to begin again
        var others = connection.Links.Where((link) =>
        {
            return link.Address != NameQueue && !link.IsDetached;
        }).Select((link) =>
        {
            return link.Channel;
        });

        Assert.Equal(
            (true, SenderSettleMode.Unsettled, ReceiverSettleMode.First, false),
            (attach.Role, attach.SndSettleMode, attach.RcvSettleMode, attach.HasField(10)));
        Assert.DoesNotContain(attaching.Channel, others);

        // ! nor does its inbox's receiver name one
        Assert.False(connection.LinkOf(InboxQueue).Attach.HasField(10));
        await Task.Delay(100, Cancelled);
        Assert.False(subscribing.IsCompleted);
        await connection.AnswerAttach(attaching);
        await subscribing.WaitAsync(Patience, Cancelled);

        // * a name held, subscribed again, is held at once, no second ATTACH
        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);
        Assert.Single(connection.Links, (link) =>
        {
            return link.Address == NameQueue;
        });
        await adapter.Stop();

        // at most once, settled
        _script.Holding = (_) =>
        {
            return false;
        };

        await using var quick = AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce };
        });
        var quickConnection = await LinkUp((quick, _script));

        await quick.Subscribe(Name).WaitAsync(Patience, Cancelled);
        Assert.Equal(SenderSettleMode.Settled, quickConnection.LinkOf(NameQueue).Attach.SndSettleMode);
        await quick.Stop();
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Refuses_a_name_whose_ATTACH_names_no_source_and_is_detached_whose_session_its_broker_ends_or_past_its_broker_s_channel_max_naming_it_and_keeps_every_other_spec_15_34(string against)
    {
        if (against == Fixture)
        {
            await using var linked = BrokerAdapterOf((Id, null));
            var (_, lost) = HeardOf(linked);

            await linked.Start().WaitAsync(Patience, Cancelled);
            await linked.Subscribe(Inbox).WaitAsync(Patience, Cancelled);
            await linked.Subscribe(Name).WaitAsync(Patience, Cancelled);
            Assert.Contains("amqp:not-found", (await FailureOf(() =>
            {
                return linked.Subscribe(["bead", "s", "nobody"]);
            })).Message, StringComparison.Ordinal);
            Assert.Contains("amqp:unauthorized-access", (await FailureOf(() =>
            {
                return linked.Subscribe(["bead", "s", "interop-ts"]);
            })).Message, StringComparison.Ordinal);

            // every other kept: its link, and its name, which an OPEN still reaches
            await AmqpFixture.Purge("bead.s.interop");

            var (reached, _) = HeardOf(linked);

            Assert.Equal(BrokerPublished.Taken, await linked.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 7 } }).WaitAsync(Patience, Cancelled));
            await Until(() =>
            {
                return !reached.IsEmpty;
            });
            Assert.Equal((true, 0, 1), (linked.IsLinked, lost.Count, reached.Count));
            reached.First().Settle();
            await linked.Stop();

            return;
        }

        _script.ChannelMax = 6;

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        // * no source, and a DETACH naming why
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, "/queues/bead.s.absent");
        };

        var absent = adapter.Subscribe(["bead", "s", "absent"]);

        await connection.AnswerAttach(await connection.Next((frame) =>
        {
            return IsAttachOf(frame, "/queues/bead.s.absent");
        }), new Error(new Symbol("amqp:not-found")) { Description = "no queue 'bead.s.absent' in vhost '/'" });
        Assert.Contains("amqp:not-found", (await FailureOf(() =>
        {
            return absent;
        })).Message, StringComparison.Ordinal);

        // its session ended by its broker, as RabbitMQ refuses a read its permissions deny
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, "/queues/bead.s.denied");
        };

        var denied = adapter.Subscribe(["bead", "s", "denied"]);
        var attaching = await connection.Next((frame) =>
        {
            return IsAttachOf(frame, "/queues/bead.s.denied");
        });

        await connection.End(attaching.Channel, new Error(new Symbol("amqp:unauthorized-access")));
        Assert.Contains("amqp:unauthorized-access", (await FailureOf(() =>
        {
            return denied;
        })).Message, StringComparison.Ordinal);

        // past what its broker's channel-max of 6 leaves beside its inbox's, its senders' and its
        // management's sessions: three names, the fourth refused before it begins one
        _script.Holding = (_) =>
        {
            return false;
        };
        await adapter.Subscribe(["bead", "s", "second"]).WaitAsync(Patience, Cancelled);
        await adapter.Subscribe(["bead", "s", "third"]).WaitAsync(Patience, Cancelled);

        var begun = connection.Of<Begin>().Count;

        Assert.Contains("channel-max, 6", (await FailureOf(() =>
        {
            return adapter.Subscribe(["bead", "s", "fourth"]);
        })).Message, StringComparison.Ordinal);
        Assert.Equal(begun, connection.Of<Begin>().Count);

        // and every other kept: its link, and its names, a message still handed on on each
        var (messages, _) = HeardOf(adapter);

        await connection.Deliver((connection.LinkOf(NameQueue), ParcelOf([1])));
        await connection.Deliver((connection.LinkOf("/queues/bead.s.third"), ParcelOf([3])));
        await Until(() =>
        {
            return messages.Count == 2;
        });
        Assert.Equal((true, 0, 2), (adapter.IsLinked, downs.Count, messages.Count));
        await adapter.Stop();
    }

    [Fact]
    public async Task Grants_its_inbox_s_receiver_linkCredit_as_it_attaches_and_one_more_as_each_message_is_settled_never_as_it_arrives_spec_15_34()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { LinkCredit = 3 };
        });
        var (messages, _) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var inbox = connection.LinkOf(InboxQueue);

        List<Flow> FlowsOf()
        {
            return [.. connection.Frames.Where((frame) =>
            {
                return frame.Channel == inbox.Channel && frame.Performative is Flow { HasHandle: true } flow && flow.Handle == inbox.Handle;
            }).Select((frame) =>
            {
                return (Flow)frame.Performative!;
            })];
        }

        await Until(() =>
        {
            return FlowsOf().Count > 0;
        });
        Assert.Equal(3u, Assert.Single(FlowsOf()).LinkCredit);

        for (var each = 0; each < 3; each += 1)
        {
            await connection.Deliver((inbox, ParcelOf([(byte)each])));
        }

        await Until(() =>
        {
            return messages.Count == 3;
        });
        await Task.Delay(100, Cancelled);

        // * none granted as they arrive
        Assert.Single(FlowsOf());

        Assert.True(messages.TryDequeue(out var first));
        first.Settle();
        await Until(() =>
        {
            return FlowsOf().Count > 1;
        });
        Assert.Equal((3u, 1u), (FlowsOf()[1].DeliveryCount, FlowsOf()[1].LinkCredit));
        await adapter.Stop();
    }

    [Fact]
    public async Task Grants_a_name_s_receiver_a_credit_of_1_so_that_of_the_OPENs_its_broker_holds_for_a_member_with_room_for_one_it_hands_on_one_the_others_left_in_the_name_s_queue_none_refused_spec_15_34()
    {
        await using var adapter = AdapterOf();
        await using var participant = new BrokerParticipant(adapter);
        await using var server = participant.Server(new BrokerTransportServerOptions { Names = ["interop"], IsInGroup = true, MaximumConnections = 1 });
        var starting = server.Start();
        var connection = await _script.Connection();

        await starting.WaitAsync(Patience, Cancelled);

        var inbox = connection.LinkOf(InboxQueue);
        var name = connection.LinkOf(NameQueue);

        await Until(() =>
        {
            return inbox.Credit > 0 && name.Credit > 0;
        });
        Assert.Equal((1_000L, 1L), (inbox.Credit, name.Credit));

        // * three OPENs waiting in the name's queue, its broker handing on as many as its credit lets
        var waiting = new Queue<byte>([1, 2, 3]);

        while (waiting.Count > 0 && name.Credit > 0)
        {
            await connection.Deliver((name, OpenOf(waiting.Dequeue())));
        }

        // the first taken, which fills the server: the name let go, no credit given for another, and
        // the others left in its queue
        await connection.Next((frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach detach && frame.Channel == name.Channel && detach.Handle == name.Handle;
        });
        await Task.Delay(100, Cancelled);
        Assert.Equal([BrokerParcelKinds.Accept], KindsTo((connection, "/exchanges/bead/bead.i.peer")));
        Assert.Equal((2, 0L), (waiting.Count, name.Credit));
        await server.Stop();
    }

    [Fact]
    public async Task Lets_a_name_go_once_its_DETACH_came_and_its_inbox_once_management_deleted_it_telling_no_loss_spec_15_34()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        // * its DETACH held: it lets the name go once its broker answered
        _script.Holding = (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach;
        };

        var name = connection.LinkOf(NameQueue);

        await connection.Deliver((name, ParcelOf([1])));
        await Until(() =>
        {
            return messages.Count == 1;
        });

        // ! its DETACH waits for what it handed on to be settled, and none is credited once it is let go
        var unsubscribing = adapter.Unsubscribe(Name);

        await Task.Delay(100, Cancelled);
        Assert.Equal((false, false), (connection.Frames.Any((frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach detach && detach.Handle == name.Handle && frame.Channel == name.Channel;
        }), unsubscribing.IsCompleted));
        Assert.True(messages.TryDequeue(out var handedOn));
        handedOn.Settle();

        var detaching = await connection.Next<global::Amqp.Framing.Detach>();

        Assert.Equal(name.Handle, detaching.Performative.Handle);
        await Task.Delay(100, Cancelled);
        Assert.Equal((false, 0L), (unsubscribing.IsCompleted, name.Credit));
        await connection.Send(detaching.Frame.Channel, new global::Amqp.Framing.Detach { Handle = name.Handle, Closed = true });
        await unsubscribing.WaitAsync(Patience, Cancelled);
        await connection.Next((frame) =>
        {
            return frame.Performative is AmqpEnd && frame.Channel == name.Channel;
        });

        // * subscribed again and let go holding nothing, its DETACH at once: what its broker hands on
        // before it answered that DETACH is not handed on, and the name is let go once it did
        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        var again = connection.LinkOf(NameQueue);

        await Until(() =>
        {
            return again.Credit > 0;
        });

        var unsubscribingAgain = adapter.Unsubscribe(Name);
        var detachingAgain = await connection.Next<global::Amqp.Framing.Detach>(1);

        Assert.Equal(again.Handle, detachingAgain.Performative.Handle);
        await connection.Deliver((again, ParcelOf([2])));
        await Task.Delay(100, Cancelled);
        Assert.Equal((false, 0), (unsubscribingAgain.IsCompleted, messages.Count));
        await connection.Send(detachingAgain.Frame.Channel, new global::Amqp.Framing.Detach { Handle = again.Handle, Closed = true });
        await unsubscribingAgain.WaitAsync(Patience, Cancelled);

        // its inbox once its broker's management deleted it, its receiver detached by its broker with it
        _script.Holding = (frame) =>
        {
            return IsRequestOf(frame, "DELETE");
        };

        var inbox = connection.LinkOf(InboxQueue);
        var leaving = adapter.Unsubscribe(Inbox);
        var (deleted, transfer) = await connection.NextRequest(2);

        Assert.Equal(("DELETE", "/queues/bead.i.ada"), (deleted.Method, deleted.Path));
        await Task.Delay(100, Cancelled);
        Assert.False(leaving.IsCompleted);
        await connection.Detach(inbox, new Error(new Symbol("amqp:resource-deleted")));
        await connection.Answer(transfer, ("200", new Map { ["message_count"] = 0UL }));
        await leaving.WaitAsync(Patience, Cancelled);
        await Task.Delay(100, Cancelled);
        Assert.Empty(downs);

        // a name it does not hold let go at once
        await adapter.Unsubscribe(["bead", "s", "other"]).WaitAsync(Patience, Cancelled);
        await adapter.Stop();

        // * an inbox whose deletion is answered other than 200 is refused, naming it, and still held:
        // its end then its link lost
        _script.Holding = (_) =>
        {
            return false;
        };
        _script.Management = (request) =>
        {
            return request.Method switch
            {
                "PUT" => ("201", new Map()),
                "POST" => ("204", null),
                _ => ("500", null),
            };
        };

        var kept = await LinkUp((adapter, _script));

        Assert.Equal("its broker refused to delete the inbox bead.i.ada of ada: 500", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return adapter.Unsubscribe(Inbox);
        })).Message);
        await kept.Detach(kept.LinkOf(InboxQueue), new Error(new Symbol("amqp:resource-deleted")));
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal((1, false), (downs.Count, adapter.IsLinked));
    }

    [Fact]
    public async Task Lets_a_name_go_within_one_connectTimeout_what_it_handed_on_settled_and_its_DETACH_answered_and_tells_its_link_lost_past_it_spec_15_34_15_37()
    {
        const string LostWithin = "the link of ada was lost: it let the name bead.s.interop go within no 300 ms, its connectTimeout";

        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(300) };
        });
        var (messages, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        // * what it handed on not settled within it: no DETACH goes, and its link is lost
        var name = connection.LinkOf(NameQueue);

        await connection.Deliver((name, ParcelOf([1])));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        Assert.Equal(LostWithin, (await Assert.ThrowsAsync<IOException>(() =>
        {
            return adapter.Unsubscribe(Name);
        })).Message);
        await connection.Closed.WaitAsync(Patience, Cancelled);
        Assert.Equal((1, false, 0), (downs.Count, adapter.IsLinked, adapter.Unsettled));
        Assert.DoesNotContain(connection.Frames, (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach detach && frame.Channel == name.Channel && detach.Handle == name.Handle;
        });
        Assert.True(messages.TryDequeue(out var late));
        late.Settle();
        Assert.Empty(connection.Of<global::Amqp.Framing.Dispose>());

        // * its DETACH not answered within it: its link lost the same
        _script.Holding = (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach;
        };

        var unanswered = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);
        Assert.Equal(LostWithin, (await Assert.ThrowsAsync<IOException>(() =>
        {
            return adapter.Unsubscribe(Name);
        })).Message);
        Assert.Contains(unanswered.Frames, (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Detach;
        });
        await unanswered.Closed.WaitAsync(Patience, Cancelled);
        Assert.Equal((2, false), (downs.Count, adapter.IsLinked));

        // * its link lost as it lets a name go: its let-go fails, naming that loss
        _script.Holding = (_) =>
        {
            return false;
        };

        var cut = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);
        await cut.Deliver((cut.LinkOf(NameQueue), ParcelOf([2])));
        await Until(() =>
        {
            return messages.Count == 2;
        });

        var cutting = adapter.Unsubscribe(Name);

        cut.Cut();
        Assert.StartsWith("the link of ada ", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return cutting;
        })).Message, StringComparison.Ordinal);
        Assert.Equal((3, false), (downs.Count, adapter.IsLinked));
    }

    [Fact]
    public async Task Waits_subscribing_a_name_under_way_for_its_ATTACH_to_name_its_source_and_lets_a_name_whose_subscription_an_unsubscription_met_go_once_it_attached_never_held_spec_15_34()
    {
        await using var adapter = AdapterOf();
        var (messages, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var held = new ConcurrentQueue<string>();

        int AttachesFrom(int mark)
        {
            return connection.Frames.Skip(mark).Count((frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            });
        }

        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };

        // * subscribed twice under way: one ATTACH, and neither held before its broker answered it
        var mark = connection.Mark;
        var subscribing = Enumerable.Range(1, 2).Select(async (index) =>
        {
            await adapter.Subscribe(Name);
            held.Enqueue(string.Create(CultureInfo.InvariantCulture, $"subscribed {index}"));
        }).ToList();
        var attaching = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        await Task.Delay(100, Cancelled);
        Assert.Equal((0, 1), (held.Count, AttachesFrom(mark)));
        await connection.AnswerAttach(attaching);
        await Task.WhenAll(subscribing).WaitAsync(Patience, Cancelled);
        Assert.Equal((2, 1), (held.Count, AttachesFrom(mark)));
        await adapter.Unsubscribe(Name).WaitAsync(Patience, Cancelled);

        // * an unsubscription meets one under way: it is let go once attached, and never held, what
        // its broker hands on before it answered its DETACH not handed on
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue) || frame.Performative is global::Amqp.Framing.Detach;
        };
        mark = connection.Mark;

        var subscribed = adapter.Subscribe(Name);
        var met = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);
        var unsubscribing = adapter.Unsubscribe(Name);

        await Task.Delay(100, Cancelled);
        Assert.False(unsubscribing.IsCompleted);
        await connection.AnswerAttach(met);

        var metLink = connection.LinkOf(NameQueue);

        await Until(() =>
        {
            return metLink.Credit > 0;
        });
        await connection.Deliver((metLink, ParcelOf([1])));

        var detaching = await connection.Next(
            (frame) =>
            {
                return frame.Performative is global::Amqp.Framing.Detach detach && frame.Channel == metLink.Channel && detach.Handle == metLink.Handle;
            },
            from: mark);

        await Task.Delay(100, Cancelled);
        Assert.Equal((false, 0), (unsubscribing.IsCompleted, messages.Count));
        await connection.Send(detaching.Channel, new global::Amqp.Framing.Detach { Handle = metLink.Handle, Closed = true });
        await Task.WhenAll(subscribed, unsubscribing).WaitAsync(Patience, Cancelled);
        Assert.Empty(messages);

        // * one asked once an unsubscription met the one under way subscribes anew, once that is let go
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };
        mark = connection.Mark;

        var letGoFirst = adapter.Subscribe(Name);
        var first = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);
        var leaving = adapter.Unsubscribe(Name);
        var subscribedAnew = adapter.Subscribe(Name);

        mark = connection.Mark;
        await connection.AnswerAttach(first);
        await Task.WhenAll(letGoFirst, leaving).WaitAsync(Patience, Cancelled);
        await connection.AnswerAttach(await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark));
        await subscribedAnew.WaitAsync(Patience, Cancelled);
        Assert.False(connection.LinkOf(NameQueue).IsDetached);
        await adapter.Unsubscribe(Name).WaitAsync(Patience, Cancelled);

        // a subscription refused: one that met it fails with it, an unsubscription that met it holds
        // nothing to let go, and one asked after that subscribes anew, refused in its turn
        mark = connection.Mark;

        var refused = new[] { adapter.Subscribe(Name), adapter.Subscribe(Name) };
        var letGo = adapter.Unsubscribe(Name);
        var refusedAnew = adapter.Subscribe(Name);
        var refusing = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        mark = connection.Mark;
        await connection.AnswerAttach(refusing, new Error(new Symbol("amqp:not-found")));
        await connection.AnswerAttach(await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark), new Error(new Symbol("amqp:not-found")));

        foreach (var outcome in refused.Append(refusedAnew))
        {
            Assert.Contains("amqp:not-found", (await FailureOf(() =>
            {
                return outcome;
            })).Message, StringComparison.Ordinal);
        }

        await letGo.WaitAsync(Patience, Cancelled);

        // * one given up, which another met: that other subscribes anew, and is held
        using var given = new CancellationTokenSource();

        mark = connection.Mark;

        var givenUp = adapter.Subscribe(Name, new BrokerSubscription { CancellationToken = given.Token });
        var second = adapter.Subscribe(Name);

        await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);
        mark = connection.Mark;
        await given.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return givenUp;
        });

        var anew = await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);

        await connection.AnswerAttach(anew);
        await second.WaitAsync(Patience, Cancelled);
        Assert.Equal((0, true), (downs.Count, adapter.IsLinked));
        _script.Holding = (_) =>
        {
            return false;
        };
        await adapter.Stop();
    }

    [Fact]
    public async Task Hands_on_and_credits_what_comes_to_its_inbox_while_its_deletion_is_under_way_and_keeps_its_inbox_where_its_deletion_is_refused_or_not_answered_within_connectTimeout_spec_15_34_15_37()
    {
        await using var adapter = AdapterOf((options) =>
        {
            return options with { ConnectTimeout = TimeSpan.FromMilliseconds(300), LinkCredit = 2 };
        });
        var (messages, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var inbox = connection.LinkOf(InboxQueue);

        _script.Holding = (frame) =>
        {
            return IsRequestOf(frame, "DELETE");
        };

        // * a parcel during its deletion: handed on, and its credit given back as it is settled
        var deleting = adapter.Unsubscribe(Inbox);
        var (_, transfer) = await connection.NextRequest(2);

        await connection.Deliver((inbox, ParcelOf([1])));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        Assert.True(messages.TryDequeue(out var during));
        during.Settle();
        await Until(() =>
        {
            return inbox.Credit == 2;
        });
        Assert.Equal(2L, inbox.Credit);

        // its deletion refused: its inbox still held, handing on and crediting
        await connection.Answer(transfer, ("500", null));
        Assert.Equal("its broker refused to delete the inbox bead.i.ada of ada: 500", (await Assert.ThrowsAsync<IOException>(() =>
        {
            return deleting;
        })).Message);
        await connection.Deliver((inbox, ParcelOf([2])));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        Assert.Equal((0, true), (downs.Count, adapter.IsLinked));

        // * its deletion not answered within connectTimeout: refused, naming it, its inbox still held
        Assert.Equal("the broker of ada answered the deletion of bead.i.ada within no 300 ms, its connectTimeout", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return adapter.Unsubscribe(Inbox);
        })).Message);
        await connection.Deliver((inbox, ParcelOf([3])));
        await Until(() =>
        {
            return messages.Count == 2;
        });
        Assert.Equal((2, 0, true), (messages.Count, downs.Count, adapter.IsLinked));

        // its end then its link lost
        await connection.Detach(inbox, new Error(new Symbol("amqp:resource-deleted")));
        await Until(() =>
        {
            return !downs.IsEmpty;
        });
        Assert.Equal((1, false), (downs.Count, adapter.IsLinked));
    }

    [Fact]
    public async Task Publishes_each_parcel_as_one_message_of_format_0_to_the_anonymous_terminus_unsettled_its_to_the_topic_s_exchange_address_a_life_its_header_s_ttl_in_milliseconds_rounded_up_where_one_is_asked_and_nothing_else_spec_15_35()
    {
        await using var adapter = AdapterOf();
        var connection = await LinkUp((adapter, _script));
        byte[] payload = [0xB0, 0x0B];

        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = payload, ExpiresAfter = TimeSpan.FromMilliseconds(1_500.2) }).WaitAsync(Patience, Cancelled));
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = Name, Payload = payload }).WaitAsync(Patience, Cancelled));

        var withLife = Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.peer")));
        var withoutLife = Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.s.interop")));

        // * the profile's bytes, to the byte: a header of its ttl alone, properties of its to alone, one Data section
        using var expected = AmqpMessages.MessageOf(("/exchanges/bead/bead.i.peer", payload), 1_501);
        using var expectedWithout = AmqpMessages.MessageOf(("/exchanges/bead/bead.s.interop", payload), null);
        var bytes = expected.Encode();
        var bytesWithout = expectedWithout.Encode();

        Assert.Equal(Convert.ToHexString(bytes.Buffer, bytes.Offset, bytes.Length), Convert.ToHexString(withLife.Bytes));
        Assert.Equal(Convert.ToHexString(bytesWithout.Buffer, bytesWithout.Offset, bytesWithout.Length), Convert.ToHexString(withoutLife.Bytes));
        Assert.Equal((0u, false, 1_501u, 0u, false), (withLife.MessageFormat, withLife.IsSettled, withLife.Message.Header.Ttl, withoutLife.MessageFormat, withoutLife.IsSettled));
        Assert.Null(withoutLife.Message.Header);

        // each to the anonymous terminus, an inbox's and a name's on senders of their own
        var senders = connection.Links.Where((link) =>
        {
            return !link.IsReceiver && link.Address != AmqpManagement.Node;
        }).ToList();

        Assert.Equal(2, senders.Count);
        Assert.All(senders, (sender) =>
        {
            Assert.Null(((Target)sender.Attach.Target).Address);
        });
        Assert.NotEqual(withLife.Channel, withoutLife.Channel);
        await adapter.Stop();

        // at most once, each settled as it goes, with no outcome to read
        await using var quick = AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce };
        });
        var quickConnection = await LinkUp((quick, _script));

        Assert.Equal(BrokerPublished.Taken, await quick.Publish(new BrokerPublication { Topic = PeerInbox, Payload = payload }).WaitAsync(Patience, Cancelled));
        await Until(() =>
        {
            return TransfersTo((quickConnection, "/exchanges/bead/bead.i.peer")).Count > 0;
        });
        Assert.True(TransfersTo((quickConnection, "/exchanges/bead/bead.i.peer"))[0].IsSettled);
        await quick.Stop();
    }

    [Fact]
    public async Task Holds_its_publications_to_its_sender_s_credit_the_next_going_as_credit_comes_in_their_order_and_delays_no_receiver_for_them_spec_15_35()
    {
        _script.SenderCredit = 1;

        await using var adapter = AdapterOf();
        var (messages, _) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var published = Enumerable.Range(1, 3).Select((each) =>
        {
            return adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { (byte)each } });
        }).ToList();

        await Until(() =>
        {
            return TransfersTo((connection, "/exchanges/bead/bead.i.peer")).Count > 0;
        });
        await Task.Delay(200, Cancelled);
        Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.peer")));

        // * a receiver is delayed by none of them
        await connection.Deliver((connection.LinkOf(InboxQueue), ParcelOf([9])));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        Assert.Single(messages);

        var parcels = connection.Links.First((link) =>
        {
            return link.Name.StartsWith("parcels", StringComparison.Ordinal);
        });

        await connection.Credit((parcels, 2));
        await Task.WhenAll(published).WaitAsync(Patience, Cancelled);
        Assert.Equal(
            ["01", "02", "03"],
            TransfersTo((connection, "/exchanges/bead/bead.i.peer")).Select((transfer) =>
            {
                return Convert.ToHexString((byte[])transfer.Message.Body);
            }));
        await adapter.Stop();
    }

    [Fact]
    public async Task Reads_accepted_as_taken_released_as_no_subscriber_and_rejected_or_any_other_outcome_as_refused_spec_15_35()
    {
        _script.Outcome = (transfer) =>
        {
            return ((byte[])transfer.Message.Body)[0] switch
            {
                1 => new Accepted(),
                2 => new Released(),
                3 => new Rejected { Error = new Error(new Symbol("amqp:precondition-failed")) },
                _ => new Modified { DeliveryFailed = true },
            };
        };

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);

        await LinkUp((adapter, _script));

        Task<BrokerPublished> PublishOf(byte outcome)
        {
            return adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { outcome } });
        }

        Assert.Equal(BrokerPublished.Taken, await PublishOf(1).WaitAsync(Patience, Cancelled));
        Assert.Equal(BrokerPublished.NoSubscriber, await PublishOf(2).WaitAsync(Patience, Cancelled));

        var rejected = await FailureOf(() =>
        {
            return PublishOf(3);
        });
        var modified = await FailureOf(() =>
        {
            return PublishOf(4);
        });

        Assert.Equal((true, true), (rejected is IOException, modified is IOException));
        Assert.Contains("rejected, amqp:precondition-failed", rejected.Message, StringComparison.Ordinal);
        Assert.Contains("amqp:modified:list", modified.Message, StringComparison.Ordinal);
        Assert.Equal((true, 0), (adapter.IsLinked, downs.Count));
        await adapter.Stop();
    }

    [Fact]
    public async Task Refuses_a_publication_past_its_sender_s_max_message_size_before_it_goes_spec_15_35()
    {
        _script.MaxMessageSize = 100;

        await using var adapter = AdapterOf();
        var connection = await LinkUp((adapter, _script));
        var largest = adapter.MaximumPayloadBytes(PeerInbox);

        Assert.Equal(AmqpMessages.LargestPayload(("/exchanges/bead/bead.i.peer", 100)), largest);
        Assert.StartsWith("a message of 101 bytes to /exchanges/bead/bead.i.peer", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[largest + 1], ExpiresAfter = TimeSpan.FromSeconds(1) });
        })).Message, StringComparison.Ordinal);
        Assert.Empty(TransfersTo((connection, "/exchanges/bead/bead.i.peer")));
        Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[largest], ExpiresAfter = TimeSpan.FromSeconds(1) }).WaitAsync(Patience, Cancelled));
        Assert.Single(TransfersTo((connection, "/exchanges/bead/bead.i.peer")));
        await adapter.Stop();
    }

    [Fact]
    public async Task Checks_a_replacement_sender_s_smaller_bound_before_queued_publications_go_and_keeps_its_other_sender_and_link()
    {
        foreach (var topic in new[] { Inbox, Name })
        {
            _script.MaxMessageSize = 4_096;

            await using var adapter = AdapterOf();
            var (_, downs) = HeardOf(adapter);
            var connection = await LinkUp((adapter, _script));
            var room = adapter.MaximumPayloadBytes(topic);
            var other = topic == Inbox ? Name : Inbox;
            var otherRoom = adapter.MaximumPayloadBytes(other);

            await adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = topic }).WaitAsync(Patience, Cancelled);
            var transfer = Assert.Single(TransfersTo((connection, AmqpMessages.AddressOf(topic))));
            var ending = connection.Frames.Count;

            await connection.End(transfer.Channel);
            await connection.Next(
                (frame) =>
                {
                    return frame.Performative is AmqpEnd && frame.Channel == transfer.Channel;
                },
                from: ending);

            Func<ScriptedFrame, bool> isSending = (frame) =>
            {
                return frame.Performative is Attach { Role: false } attach && (attach.Target as Target)?.Address is null;
            };

            _script.Holding = isSending;
            var sending = connection.Frames.Count;
            var oversized = adapter.Publish(new BrokerPublication { ExpiresAfter = TimeSpan.FromSeconds(1), Payload = new byte[room], Topic = topic });
            var fitting = adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = topic });
            var attaching = await connection.Next(isSending, from: sending);

            Assert.Single(TransfersTo((connection, AmqpMessages.AddressOf(topic))));
            Assert.Equal(room, adapter.MaximumPayloadBytes(topic));
            _script.MaxMessageSize = 1_024;
            _script.Holding = (_) =>
            {
                return false;
            };
            await connection.AnswerAttach(attaching);
            var refused = await FailureOf(() =>
            {
                return oversized;
            });

            Assert.IsType<ArgumentException>(refused);
            Assert.Contains("past its sender's max-message-size, 1024 bytes", refused.Message, StringComparison.Ordinal);
            Assert.Equal(BrokerPublished.Taken, await fitting.WaitAsync(Patience, Cancelled));
            Assert.Equal(otherRoom, adapter.MaximumPayloadBytes(other));
            Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Payload = (byte[])[3], Topic = other }).WaitAsync(Patience, Cancelled));
            Assert.Equal(
                ["01", "02", "03"],
                connection.Transfers.Where((each) =>
                {
                    return each.Message.Properties?.To?.StartsWith("/exchanges/bead/", StringComparison.Ordinal) == true;
                }).Select((each) =>
                {
                    return Convert.ToHexString((byte[])each.Message.Body);
                }));
            Assert.True(adapter.IsLinked);
            Assert.Empty(downs);
            await adapter.Stop();
        }
    }

    [Fact]
    public async Task Cancels_a_publication_awaiting_its_replacement_sender_and_sends_only_its_successor_when_the_late_ATTACH_comes()
    {
        foreach (var topic in new[] { Inbox, Name })
        {
            await using var adapter = AdapterOf();
            var (_, downs) = HeardOf(adapter);
            var connection = await LinkUp((adapter, _script));

            await adapter.Publish(new BrokerPublication { Payload = (byte[])[1], Topic = topic }).WaitAsync(Patience, Cancelled);
            var transfer = Assert.Single(TransfersTo((connection, AmqpMessages.AddressOf(topic))));
            var ending = connection.Frames.Count;

            await connection.End(transfer.Channel);
            await connection.Next(
                (frame) =>
                {
                    return frame.Performative is AmqpEnd && frame.Channel == transfer.Channel;
                },
                from: ending);

            Func<ScriptedFrame, bool> isSending = (frame) =>
            {
                return frame.Performative is Attach { Role: false } attach && (attach.Target as Target)?.Address is null;
            };

            _script.Holding = isSending;
            using var given = new CancellationTokenSource();
            var sending = connection.Frames.Count;
            var publishing = adapter.Publish(new BrokerPublication { Payload = (byte[])[2], Topic = topic, CancellationToken = given.Token });
            var attaching = await connection.Next(isSending, from: sending);

            await given.CancelAsync();
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return publishing;
            }));
            Assert.Single(TransfersTo((connection, AmqpMessages.AddressOf(topic))));

            var successor = adapter.Publish(new BrokerPublication { Payload = (byte[])[3], Topic = topic });

            _script.Holding = (_) =>
            {
                return false;
            };
            await connection.AnswerAttach(attaching);
            Assert.Equal(BrokerPublished.Taken, await successor.WaitAsync(Patience, Cancelled));
            Assert.Equal(
                ["01", "03"],
                TransfersTo((connection, AmqpMessages.AddressOf(topic))).Select((each) =>
                {
                    return Convert.ToHexString((byte[])each.Message.Body);
                }));
            Assert.True(adapter.IsLinked);
            Assert.Empty(downs);
            await adapter.Stop();
        }
    }

    [Fact]
    public async Task Hands_each_message_on_before_its_accepted_which_goes_once_it_is_settled_on_the_receiver_it_came_on_and_once_never_released_or_modified_spec_15_36()
    {
        await using var adapter = AdapterOf();
        var (messages, _) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var inbox = connection.LinkOf(InboxQueue);
        var id = await connection.Deliver((inbox, ParcelOf([1, 2, 3])));

        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        Assert.True(messages.TryDequeue(out var message));
        Assert.Equal(Inbox, message.Topic);
        Assert.Equal(("010203", 1), (Convert.ToHexString(message.Payload.Span), adapter.Unsettled));
        await Task.Delay(100, Cancelled);
        Assert.Empty(connection.Of<global::Amqp.Framing.Dispose>());

        // * settled: accepted, settled, on its receiver's session; a second settle sends nothing
        message.Settle();

        var (settledFrame, settled) = await connection.Next<global::Amqp.Framing.Dispose>();

        Assert.Equal((inbox.Channel, true, id, id, true, true), (settledFrame.Channel, settled.Role, settled.First, settled.Last, settled.Settled, settled.State is Accepted));
        message.Settle();
        await Task.Delay(100, Cancelled);
        Assert.Single(connection.Of<global::Amqp.Framing.Dispose>());
        Assert.Equal(0, adapter.Unsettled);

        // ! a name's message settled once its receiver was attached again is settled on neither, and
        // counted no more
        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        var name = connection.LinkOf(NameQueue);

        await connection.Deliver((name, ParcelOf([4])));
        await Until(() =>
        {
            return !messages.IsEmpty;
        });
        var mark = connection.Mark;

        await connection.Detach(name, new Error(new Symbol("amqp:internal-error")));
        await connection.Next(
            (frame) =>
            {
                return IsAttachOf(frame, NameQueue);
            },
            from: mark);
        Assert.Equal(0, adapter.Unsettled);
        Assert.True(messages.TryDequeue(out var former));
        former.Settle();
        await Task.Delay(100, Cancelled);
        Assert.Single(connection.Of<global::Amqp.Framing.Dispose>());
        Assert.All(connection.Of<global::Amqp.Framing.Dispose>(), (each) =>
        {
            Assert.IsType<Accepted>(each.State);
        });
        await adapter.Stop();

        // * at most once: a message its broker settled is handed on, no accepted to go, and one more
        // credit granted as it is settled
        await using var quick = AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce, LinkCredit = 1 };
        });
        var (quickly, _) = HeardOf(quick);
        var quickConnection = await LinkUp((quick, _script));
        var quickInbox = quickConnection.LinkOf(InboxQueue);

        int FlowsOf()
        {
            return quickConnection.Frames.Count((frame) =>
            {
                return frame.Channel == quickInbox.Channel && frame.Performative is Flow { HasHandle: true } flow && flow.Handle == quickInbox.Handle;
            });
        }

        await quickConnection.Deliver((quickInbox, ParcelOf([9])), true);
        await Until(() =>
        {
            return !quickly.IsEmpty;
        });
        Assert.Equal(0, quick.Unsettled);

        var flows = FlowsOf();

        Assert.True(quickly.TryDequeue(out var settledAlready));
        settledAlready.Settle();
        await Until(() =>
        {
            return FlowsOf() > flows;
        });
        Assert.DoesNotContain(quickConnection.Frames, (frame) =>
        {
            return frame.Performative is global::Amqp.Framing.Dispose && frame.Channel == quickInbox.Channel;
        });
        await quick.Stop();
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Hands_on_a_message_whose_body_is_other_than_one_Data_section_or_whose_payload_passes_its_receive_bound_as_no_parcel_its_link_kept_spec_15_36(string against)
    {
        if (against == Fixture)
        {
            await using var bounded = BrokerAdapterOf((Id, null), (options) =>
            {
                return options with { MaximumMessageSize = 1_024 };
            });
            await using var publisher = BrokerAdapterOf(("bob", null));
            var (heard, lost) = HeardOf(bounded);

            await bounded.Start().WaitAsync(Patience, Cancelled);
            await bounded.Subscribe(Inbox).WaitAsync(Patience, Cancelled);
            await publisher.Start().WaitAsync(Patience, Cancelled);
            await publisher.Subscribe(["bead", "i", "bob"]).WaitAsync(Patience, Cancelled);

            // * a message of its broker's max_message_size, past the inbox's bound of 1,024
            var largest = publisher.MaximumPayloadBytes(Inbox);

            Assert.Equal(AmqpMessages.LargestPayload(("/exchanges/bead/bead.i.ada", 4_096)), largest);
            Assert.Equal(BrokerPublished.Taken, await publisher.Publish(new BrokerPublication { Topic = Inbox, Payload = new byte[largest], ExpiresAfter = TimeSpan.FromSeconds(5) }).WaitAsync(Patience, Cancelled));
            Assert.Equal(BrokerPublished.Taken, await publisher.Publish(new BrokerPublication { Topic = Inbox, Payload = new byte[] { 1 } }).WaitAsync(Patience, Cancelled));
            await Until(() =>
            {
                return heard.Count == 2;
            });
            Assert.Equal(
                ["", "01"],
                heard.Select((message) =>
                {
                    message.Settle();

                    return Convert.ToHexString(message.Payload.Span);
                }));
            Assert.Equal((true, 0), (bounded.IsLinked, lost.Count));
            await publisher.Stop();
            await bounded.Stop();

            return;
        }

        await using var adapter = AdapterOf((options) =>
        {
            return options with { MaximumMessageSize = 200 };
        });
        var (messages, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));
        var inbox = connection.LinkOf(InboxQueue);
        var bound = adapter.ReceiveBound(Inbox);
        var data = new ByteBuffer(64, true);

        new Properties { To = "/exchanges/bead/bead.i.ada" }.Encode(data);
        new Data { Binary = [1] }.Encode(data);
        new Data { Binary = [2] }.Encode(data);

        await connection.Deliver((inbox, new AmqpMessage("an amqp-value") { Properties = new Properties { To = "/exchanges/bead/bead.i.ada" } }));
        await connection.DeliverBytes((inbox, data.Buffer.AsSpan(data.Offset, data.Length).ToArray()));
        await connection.Deliver((inbox, new AmqpMessage { BodySection = new AmqpSequence { List = new global::Amqp.Types.List { 1, 2 } } }));
        await connection.Deliver((inbox, ParcelOf(new byte[bound + 1])));
        await connection.Deliver((inbox, ParcelOf(new byte[bound])));
        await Until(() =>
        {
            return messages.Count == 5;
        });
        Assert.Equal(
            [0, 0, 0, 0, (int)bound],
            messages.Select((message) =>
            {
                message.Settle();

                return message.Payload.Length;
            }));
        Assert.Equal((true, 0), (adapter.IsLinked, downs.Count));
        await adapter.Stop();
    }

    [Fact]
    public void Announces_as_its_receive_bound_the_largest_payload_of_a_message_to_its_inbox_within_its_maximumMessageSize_and_refuses_as_it_is_built_a_maximumMessageSize_outside_1_to_4_294_967_295_and_a_linkCredit_outside_1_to_2_147_483_647_spec_15_37()
    {
        var unbounded = AdapterOf();
        var bounded = AdapterOf((options) =>
        {
            return options with { MaximumMessageSize = 4_096 };
        });

        Assert.Equal(
            (16_777_156L, 4_038L, 4_036L),
            (unbounded.ReceiveBound(["bead", "i", "server"]), bounded.ReceiveBound(PeerInbox), bounded.ReceiveBound(["bead", "i", "server"])));
        Assert.Equal(16_777_216L, AmqpMessages.MaximumMessageSize);

        // * a bound whose receive bound is under 1,024 is refused as its participant is built, and one
        // out of its range as the adapter is; a linkCredit past 2,147,483,647 no int holds
        Assert.Contains("a participant's inbox takes a parcel of 1,024 bytes at least", Assert.Throws<ArgumentException>(() =>
        {
            return new BrokerParticipant(AdapterOf((options) =>
            {
                return options with { MaximumMessageSize = 1_000 };
            }));
        }).Message, StringComparison.Ordinal);

        foreach (var maximumMessageSize in new[] { 0L, -1L, 4_294_967_296L })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return AdapterOf((options) =>
                {
                    return options with { MaximumMessageSize = maximumMessageSize };
                });
            });
        }

        foreach (var linkCredit in new[] { 0, -1 })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return AdapterOf((options) =>
                {
                    return options with { LinkCredit = linkCredit };
                });
            });
        }

        Assert.Equal(
            (AmqpMessages.LargestPayload(("/exchanges/bead/bead.i.ada", AmqpMessages.LargestBound)) ?? 0, 16_777_159L),
            (AdapterOf((options) =>
            {
                return options with { MaximumMessageSize = AmqpMessages.LargestBound };
            }).ReceiveBound(Inbox), AdapterOf((options) =>
            {
                return options with { LinkCredit = int.MaxValue };
            }).ReceiveBound(Inbox)));

        // * a bound no message of the topic fits within takes no payload; what it publishes, before any
        // sender's ATTACH named a bound, is held within 4,294,967,295 bytes
        Assert.Equal(0L, AdapterOf((options) =>
        {
            return options with { MaximumMessageSize = 1 };
        }).ReceiveBound(Inbox));
        Assert.Equal(AmqpMessages.LargestPayload(("/exchanges/bead/bead.s.interop", AmqpMessages.LargestBound)), AdapterOf().MaximumPayloadBytes(Name));
    }

    [Fact]
    public async Task Gives_up_a_start_a_subscription_or_a_publication_its_signal_aborts_a_start_s_connection_closed_a_name_s_session_ended_a_publication_that_waits_on_credit_left_unsent()
    {
        // a start given up as it begins its sessions: its connection closed
        _script.Holding = (frame) =>
        {
            return frame.Performative is Begin;
        };

        await using (var adapter = AdapterOf())
        {
            using var leaving = new CancellationTokenSource();
            var starting = adapter.Start(new BrokerStart { CancellationToken = leaving.Token });
            var connection = await _script.Connection();

            await connection.Next<Begin>();
            await leaving.CancelAsync();
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return starting;
            }));
            await connection.Next<AmqpClose>();
            Assert.False(adapter.IsLinked);

            // and one given up before it began opens nothing
            using var gone = new CancellationTokenSource();

            await gone.CancelAsync();
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return adapter.Start(new BrokerStart { CancellationToken = gone.Token });
            }));
        }

        // a stop as it asks its password ends that start
        _script.Holding = (_) =>
        {
            return false;
        };

        var asking = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        await using (var asked = AdapterOf((options) =>
        {
            return options with
            {
                Password = null,
                PasswordProvider = (_) =>
                {
                    return asking.Task;
                },
            };
        }))
        {
            var askedStart = asked.Start();

            await asked.Stop();
            asking.SetResult(Password);
            Assert.Equal($"the link of {Id} stopped as it started", (await FailureOf(() =>
            {
                return askedStart;
            })).Message);
        }

        // an inbox's subscription given up as it is declared: its connection closed, and no loss
        // told, since it was never up
        _script.Holding = (frame) =>
        {
            return IsRequestOf(frame, "PUT");
        };

        await using (var adapter = AdapterOf())
        {
            var (_, downs) = HeardOf(adapter);
            var connection = await Started((adapter, _script));

            using var leaving = new CancellationTokenSource();
            var subscribing = adapter.Subscribe(Inbox, new BrokerSubscription { CancellationToken = leaving.Token });

            await connection.NextRequest(0);
            await leaving.CancelAsync();
            Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
            {
                return subscribing;
            }));
            await connection.Next<AmqpClose>();
            Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));
        }

        // a subscription given up as its ATTACH waits: its session ended, its link kept
        _script.Holding = (frame) =>
        {
            return IsAttachOf(frame, NameQueue);
        };
        _script.SenderCredit = 0;

        await using (var adapter = AdapterOf())
        {
            var connection = await LinkUp((adapter, _script));

            using (var leaving = new CancellationTokenSource())
            {
                var subscribing = adapter.Subscribe(Name, new BrokerSubscription { CancellationToken = leaving.Token });
                var attaching = await connection.Next((frame) =>
                {
                    return IsAttachOf(frame, NameQueue);
                });

                await leaving.CancelAsync();
                Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
                {
                    return subscribing;
                }));
                await connection.Next((frame) =>
                {
                    return frame.Performative is AmqpEnd && frame.Channel == attaching.Channel;
                });
            }

            Assert.True(adapter.IsLinked);

            // a publication given up as it waits on credit: left unsent, its link kept
            using (var leaving = new CancellationTokenSource())
            {
                var publishing = adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { 1 }, CancellationToken = leaving.Token });

                await Task.Delay(100, Cancelled);
                await leaving.CancelAsync();
                Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
                {
                    return publishing;
                }));
            }

            var parcels = connection.Links.First((link) =>
            {
                return link.Name.StartsWith("parcels", StringComparison.Ordinal);
            });

            await connection.Credit((parcels, 5));
            Assert.Equal(BrokerPublished.Taken, await adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { 2 } }).WaitAsync(Patience, Cancelled));
            Assert.Equal(
                ["02"],
                TransfersTo((connection, "/exchanges/bead/bead.i.peer")).Select((transfer) =>
                {
                    return Convert.ToHexString((byte[])transfer.Message.Body);
                }));
            Assert.True(adapter.IsLinked);

            // * a publication given up once it went is forgotten, its outcome unread, its link kept
            _script.Holding = (frame) =>
            {
                return frame.Performative is AmqpTransfer && frame.Channel == parcels.Channel;
            };

            using (var leaving = new CancellationTokenSource())
            {
                var publishing = adapter.Publish(new BrokerPublication { Topic = PeerInbox, Payload = new byte[] { 3 }, CancellationToken = leaving.Token });

                await Until(() =>
                {
                    return TransfersTo((connection, "/exchanges/bead/bead.i.peer")).Count == 2;
                });
                await leaving.CancelAsync();
                Assert.IsAssignableFrom<OperationCanceledException>(await FailureOf(() =>
                {
                    return publishing;
                }));
            }

            await connection.Settle(TransfersTo((connection, "/exchanges/bead/bead.i.peer"))[1], new Accepted());
            await Task.Delay(50, Cancelled);
            Assert.True(adapter.IsLinked);
            await adapter.Stop();
        }
    }

    [Theory]
    [InlineData(Scripted)]
    [InlineData(Fixture, Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Stops_by_detaching_its_receivers_and_closing_its_connection_with_no_error_its_inbox_gone_with_it_spec_15_33(string against)
    {
        if (against == Fixture)
        {
            await using var linked = BrokerAdapterOf((Id, null));

            await linked.Start().WaitAsync(Patience, Cancelled);
            await linked.Subscribe(Inbox).WaitAsync(Patience, Cancelled);
            Assert.Equal("200", await AmqpFixture.QueueStatusOf("bead.i.ada"));
            await linked.Stop();
            await AmqpFixture.Gone((["bead.i.ada"], Patience));
            Assert.Equal("404", await AmqpFixture.QueueStatusOf("bead.i.ada"));

            return;
        }

        await using var adapter = AdapterOf();
        var (_, downs) = HeardOf(adapter);
        var connection = await LinkUp((adapter, _script));

        await adapter.Subscribe(Name).WaitAsync(Patience, Cancelled);

        var receivers = connection.Links.Where((link) =>
        {
            return link.IsReceiver && link.Address != AmqpManagement.Node;
        }).ToList();

        await adapter.Stop();
        await connection.Closed.WaitAsync(Patience, Cancelled);

        var detaches = connection.Of<global::Amqp.Framing.Detach>();
        var close = Assert.Single(connection.Of<AmqpClose>());

        Assert.All(receivers, (receiver) =>
        {
            Assert.Contains(detaches, (detach) =>
            {
                return detach.Handle == receiver.Handle && detach.Closed && detach.Error is null;
            });
        });
        Assert.True(connection.Of<AmqpEnd>().Count >= 4);
        Assert.Null(close.Error);
        Assert.Equal((false, 0), (adapter.IsLinked, downs.Count));
    }

    [Fact]
    public async Task Refuses_a_departure_offering_no_will_spec_15_32()
    {
        await using var adapter = AdapterOf();

        Assert.Equal(BrokerCapabilities.Groups | BrokerCapabilities.NoSubscriber | BrokerCapabilities.Expiry, adapter.Capabilities);
        Assert.StartsWith("the adapter of ada offers no will", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return adapter.Start(new BrokerStart { Will = new BrokerPublication { Topic = ["bead", "d", Id], Payload = new byte[] { 1 } } });
        })).Message, StringComparison.Ordinal);

        await LinkUp((adapter, _script));
        Assert.StartsWith("the adapter of ada offers no will", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return adapter.Subscribe(["bead", "d", "peer"]);
        })).Message, StringComparison.Ordinal);

        // * at most once, no publication is said to find no subscriber either
        Assert.Equal(BrokerCapabilities.Groups | BrokerCapabilities.Expiry, AdapterOf((options) =>
        {
            return options with { Delivery = BrokerDelivery.AtMostOnce };
        }).Capabilities);
        await adapter.Stop();
    }

    [Fact]
    public void Is_secure_over_amqps_and_over_amqp_to_the_loopback_alone()
    {
        static bool IsSecure(string uri)
        {
            return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = Id, Uri = new Uri(uri) }).IsSecure;
        }

        Assert.Equal(
            (true, true, true, true, false, false),
            (IsSecure("amqps://broker.example"), IsSecure("amqp://127.0.0.1:5672"), IsSecure("amqp://localhost"), IsSecure("amqp://[::1]:5672"), IsSecure("amqp://broker.example"), IsSecure("amqp://10.0.0.1")));

        // ! a WebSocket or another scheme is no AMQP 1.0 leg
        Assert.Throws<ArgumentException>(() =>
        {
            return IsSecure("wss://broker.example/amqp");
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return IsSecure("mqtt://127.0.0.1");
        });

        // and an id that is none
        Assert.Throws<ArgumentException>(() =>
        {
            return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = "", Uri = new Uri("amqp://127.0.0.1") });
        });
    }

    [Fact]
    public void Refuses_a_WebSocket_URL_and_a_page_naming_why()
    {
        foreach (var uri in new[] { "ws://broker.example/amqp", "wss://broker.example/amqp" })
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = Id, Uri = new Uri(uri) });
            });

            Assert.StartsWith("AMQP 1.0 is carried over TCP or TLS alone: no open-source RabbitMQ 4 carries it over a WebSocket", refused.Message, StringComparison.Ordinal);
            Assert.Equal("options", refused.ParamName);
        }

        // a page has no C# adapter: the TypeScript twin also refuses a runtime without Node
    }

    [Fact(Skip = AmqpFixture.Reason, SkipUnless = nameof(IsBroker))]
    public async Task Carries_a_link_through_RabbitMQ_s_topic_exchange_a_name_s_queue_consumed_by_two_in_turn_spec_15_32()
    {
        await AmqpFixture.Purge("bead.s.interop");
        await using var first = BrokerAdapterOf((Id, null));
        await using var second = BrokerAdapterOf(("bob", null));
        await using var caller = BrokerAdapterOf(("other", null));
        var (firstHeard, _) = HeardOf(first);
        var (secondHeard, _) = HeardOf(second);
        var (callerHeard, _) = HeardOf(caller);

        foreach (var (adapter, id) in new[] { (first, Id), (second, "bob"), (caller, "other") })
        {
            await adapter.Start().WaitAsync(Patience, Cancelled);
            await adapter.Subscribe(["bead", "i", id]).WaitAsync(Patience, Cancelled);
        }

        await first.Subscribe(Name, new BrokerSubscription { Group = "interop" }).WaitAsync(Patience, Cancelled);
        await second.Subscribe(Name, new BrokerSubscription { Group = "interop" }).WaitAsync(Patience, Cancelled);

        // * two to its name, each to one of its two consumers; an answer to the caller's inbox
        Assert.Equal(BrokerPublished.Taken, await caller.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 1 } }).WaitAsync(Patience, Cancelled));
        Assert.Equal(BrokerPublished.Taken, await caller.Publish(new BrokerPublication { Topic = Name, Payload = new byte[] { 2 } }).WaitAsync(Patience, Cancelled));
        await Until(() =>
        {
            return firstHeard.Count + secondHeard.Count == 2;
        });
        Assert.Equal((1, 1), (firstHeard.Count, secondHeard.Count));
        Assert.All(firstHeard.Concat(secondHeard), (message) =>
        {
            Assert.Equal(Name, message.Topic);
            message.Settle();
        });
        Assert.Equal(BrokerPublished.Taken, await first.Publish(new BrokerPublication { Topic = ["bead", "i", "other"], Payload = new byte[] { 3 } }).WaitAsync(Patience, Cancelled));
        await Until(() =>
        {
            return !callerHeard.IsEmpty;
        });
        Assert.Equal("03", Convert.ToHexString(Assert.Single(callerHeard).Payload.Span));

        // and an inbox gone with its connection finds no subscriber
        await second.Stop();
        await AmqpFixture.Gone((["bead.i.bob"], Patience));
        Assert.Equal(BrokerPublished.NoSubscriber, await caller.Publish(new BrokerPublication { Topic = ["bead", "i", "bob"], Payload = new byte[] { 4 } }).WaitAsync(Patience, Cancelled));
        await first.Stop();
        await caller.Stop();
    }
}
