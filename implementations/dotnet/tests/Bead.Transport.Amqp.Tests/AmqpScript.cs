using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using Amqp;
using Amqp.Framing;
using Amqp.Sasl;
using Amqp.Types;

using AmqpClose = Amqp.Framing.Close;
using AmqpEnd = Amqp.Framing.End;
using AmqpTransfer = Amqp.Framing.Transfer;

namespace Bead.Transport.Amqp.Tests;

/// <summary>
/// A scripted AMQP 1.0 peer on the loopback, which the adapter's tests play a RabbitMQ 4 with: each
/// connection's frames read as they come, decoded by AMQPNetLite's own decoder, and answered by the
/// script as a broker that limits nothing answers them — its SASL taken, its OPEN, each BEGIN, each
/// ATTACH and DETACH, each END and its CLOSE echoed, each transfer <c>accepted</c>, each management
/// request answered as RabbitMQ's management answers it — unless the test holds a frame, which it
/// then answers itself, so that a refusal, an outcome withheld or an end is the test's own and
/// nothing a real broker does hides what the adapter sends. Its frames are written by the same
/// library's encoder, frame by frame, rather than through its listener, whose links answer for
/// themselves. The TypeScript side's <c>amqp-script</c> plays its tests alike over rhea.
/// </summary>
internal sealed class AmqpScript : IAsyncDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly X509Certificate2? _certificate;
    private readonly List<ScriptedConnection> _connections = [];
    private readonly List<ScriptedConnection> _every = [];
    private readonly SemaphoreSlim _arrived = new(0);
    private readonly CancellationTokenSource _closing = new();
    private Task? _accepting;

    static AmqpScript()
    {
        // * the library's codec knows its frames once one of them was made
        _ = new Open();
    }

    private AmqpScript(X509Certificate2? certificate)
    {
        _certificate = certificate;
    }

    /// <summary>Where it listens: <c>amqp://127.0.0.1:…</c>, or <c>amqps://127.0.0.1:…</c> under a certificate.</summary>
    public Uri Uri { get; private set; } = new("amqp://127.0.0.1");

    /// <summary>The channel-max its OPEN announces: RabbitMQ's 63 unless told.</summary>
    public ushort ChannelMax { get; set; } = 63;

    /// <summary>The idle-time-out its OPEN announces, in milliseconds; none unless told.</summary>
    public uint IdleTimeout { get; set; }

    /// <summary>The max-message-size a sender's ATTACH is answered with; none unless told.</summary>
    public ulong? MaxMessageSize { get; set; }

    /// <summary>The credit each sender is given as it attaches: RabbitMQ's 170 unless told.</summary>
    public uint SenderCredit { get; set; } = 170;

    /// <summary>The outcome each unsettled transfer to the anonymous terminus is settled with: <c>accepted</c> unless told.</summary>
    public Func<ScriptedTransfer, Outcome> Outcome { get; set; } = (_) =>
    {
        return new Accepted();
    };

    /// <summary>How each management request is answered: as RabbitMQ answers one that succeeds, unless told.</summary>
    public Func<ScriptedRequest, (string Status, object? Body)> Management { get; set; } = (request) =>
    {
        return (request.Method, request.Path) switch
        {
            ("PUT", _) => ("201", new Map()),
            ("POST", _) => ("204", null),
            _ => ("200", new Map { ["message_count"] = 0UL }),
        };
    };

    /// <summary>Which frames the script answers none of, the test answering them itself.</summary>
    public Func<ScriptedFrame, bool> Holding { get; set; } = (_) =>
    {
        return false;
    };

    /// <summary>A script on a port of its own, over TCP, or over TLS under <paramref name="certificate"/>.</summary>
    public static AmqpScript Start(X509Certificate2? certificate = null)
    {
        var script = new AmqpScript(certificate);

        script._listener.Start();
        script.Uri = new Uri($"{(certificate is null ? "amqp" : "amqps")}://127.0.0.1:{((IPEndPoint)script._listener.LocalEndpoint).Port}");
        script._accepting = script.Accepting();

        return script;
    }

    /// <summary>The next connection that came, its OPEN read, within its wait; it fails when none came.</summary>
    public async Task<ScriptedConnection> Connection(TimeSpan? within = null)
    {
        if (!await _arrived.WaitAsync(within ?? Patience, TestContext.Current.CancellationToken))
        {
            throw new TimeoutException("no connection came within its time");
        }

        lock (_connections)
        {
            var connection = _connections[0];

            _connections.RemoveAt(0);

            return connection;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _closing.CancelAsync();
        _listener.Stop();

        List<ScriptedConnection> every;

        lock (_connections)
        {
            every = [.. _every];
        }

        foreach (var connection in every)
        {
            connection.Cut();
        }

        if (_accepting is not null)
        {
            try
            {
                await _accepting;
            }
            catch (Exception reason) when (reason is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                // its listener stopped
            }
        }

        _arrived.Dispose();
        _closing.Dispose();
    }

    private async Task Accepting()
    {
        while (!_closing.IsCancellationRequested)
        {
            var socket = await _listener.AcceptSocketAsync(_closing.Token);

            _ = Accepted(socket);
        }
    }

    // a connection that came: over TLS where the script has a certificate, its SASL and its OPEN read before it is handed on
    private async Task Accepted(Socket socket)
    {
        try
        {
            Stream stream = new NetworkStream(socket, ownsSocket: false);

            if (_certificate is not null)
            {
                var secured = new SslStream(stream, false, (_, certificate, _, _) =>
                {
                    // a client certificate is taken whatever its chain: the test reads what came
                    return certificate is not null;
                });

                await secured.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = _certificate, ClientCertificateRequired = true }, _closing.Token);
                stream = secured;
            }

            var connection = new ScriptedConnection(this, (socket, stream)) { ClientCertificate = (stream as SslStream)?.RemoteCertificate };

            lock (_connections)
            {
                _every.Add(connection);
            }

            await connection.Opened();

            lock (_connections)
            {
                _connections.Add(connection);
            }

            _arrived.Release();
            connection.Read();
        }
        catch (Exception reason) when (reason is IOException or SocketException or TimeoutException or OperationCanceledException or System.Security.Authentication.AuthenticationException or ObjectDisposedException or AmqpException)
        {
            socket.Dispose();
        }
    }
}

/// <summary>A frame that came: its channel, its performative as the library decodes it, and what followed it.</summary>
internal sealed record ScriptedFrame(ushort Channel, object? Performative, byte[] Payload);

/// <summary>A message the adapter transferred, whole: on which channel and link, its delivery, and its bytes.</summary>
internal sealed record ScriptedTransfer(ushort Channel, uint Handle, uint DeliveryId, bool IsSettled, uint MessageFormat, byte[] Bytes)
{
    /// <summary>Its message, as the library decodes it.</summary>
    public Message Message
    {
        get
        {
            return Message.Decode(new ByteBuffer(Bytes, 0, Bytes.Length, Bytes.Length));
        }
    }
}

/// <summary>A management request that came: its method, its path, its id and its body.</summary>
internal sealed record ScriptedRequest(string Method, string Path, object MessageId, object? Body);

/// <summary>One link the adapter attached: its channel, its handle, its name, its role and its ATTACH.</summary>
internal sealed class ScriptedLink(ushort channel, Attach attach)
{
    public ushort Channel { get; } = channel;

    public uint Handle { get; } = attach.Handle;

    public string Name { get; } = attach.LinkName;

    /// <summary>Whether the adapter's end of it receives.</summary>
    public bool IsReceiver { get; } = attach.Role;

    public Attach Attach { get; } = attach;

    /// <summary>Its source's address, a receiver's; its target's, a sender's.</summary>
    public string? Address { get; } = attach.Role ? (attach.Source as Source)?.Address : (attach.Target as Target)?.Address;

    /// <summary>The deliveries the script sent it.</summary>
    public uint DeliveryCount { get; set; }

    /// <summary>The credit its adapter's last FLOW left the script.</summary>
    public long Credit { get; set; }

    public bool IsDetached { get; set; }
}

/// <summary>One connection to the script: what came on it, and what the test writes back.</summary>
internal sealed class ScriptedConnection
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private readonly AmqpScript _script;
    private readonly Socket _socket;
    private readonly Stream _stream;
    private readonly List<ScriptedFrame> _frames = [];
    private readonly List<ScriptedTransfer> _transfers = [];
    private readonly List<ScriptedLink> _links = [];
    private readonly Dictionary<ushort, uint> _deliveryIds = [];
    private readonly Dictionary<(ushort Channel, uint Handle), (AmqpTransfer First, MemoryStream Bytes)> _partial = [];
    private readonly Lock _gate = new();
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TaskCompletionSource _heard = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly HashSet<(ushort Channel, uint Handle)> _detached = [];
    private readonly HashSet<ushort> _ended = [];
    // the channels the adapter's END came on, until a BEGIN opens one anew
    private readonly HashSet<ushort> _endedByAdapter = [];
    private uint _deliveryTag;
    private volatile bool _isClosing;

    // the last write, which the next goes after
    private Task _written = Task.CompletedTask;

    internal ScriptedConnection(AmqpScript script, (Socket Socket, Stream Stream) carried)
    {
        _script = script;
        (_socket, _stream) = carried;
    }

    /// <summary>The client certificate its TLS carried; none in the clear.</summary>
    public System.Security.Cryptography.X509Certificates.X509Certificate? ClientCertificate { get; init; }

    /// <summary>Its sasl-init, or none where it began with no SASL.</summary>
    public SaslInit? SaslInit { get; private set; }

    /// <summary>Its OPEN.</summary>
    public Open Open { get; private set; } = null!;

    /// <summary>Every frame that came after its OPEN, in its order, as it stands.</summary>
    public IReadOnlyList<ScriptedFrame> Frames
    {
        get
        {
            lock (_frames)
            {
                return [.. _frames];
            }
        }
    }

    /// <summary>Every message the adapter transferred whole, in its order, as it stands.</summary>
    public IReadOnlyList<ScriptedTransfer> Transfers
    {
        get
        {
            lock (_frames)
            {
                return [.. _transfers];
            }
        }
    }

    /// <summary>Every link the adapter attached, in its order, as it stands.</summary>
    public IReadOnlyList<ScriptedLink> Links
    {
        get
        {
            lock (_frames)
            {
                return [.. _links];
            }
        }
    }

    /// <summary>Settles once the adapter's end closed.</summary>
    public Task Closed
    {
        get
        {
            return _closed.Task;
        }
    }

    /// <summary>How many frames came: where a later look for one begins.</summary>
    public int Mark
    {
        get
        {
            lock (_frames)
            {
                return _frames.Count;
            }
        }
    }

    /// <summary>The performatives of a kind that came, as they stand.</summary>
    public List<T> Of<T>()
    {
        return [.. Frames.Select((frame) =>
        {
            return frame.Performative;
        }).OfType<T>()];
    }

    /// <summary>The link of the adapter's that reads or writes <paramref name="address"/>, the last attached.</summary>
    public ScriptedLink LinkOf(string address)
    {
        return Links.Last((link) =>
        {
            return link.Address == address;
        });
    }

    /// <summary>The next frame that satisfies <paramref name="isWanted"/>, skipping none that came before it, within its wait.</summary>
    public async Task<ScriptedFrame> Next(Func<ScriptedFrame, bool> isWanted, TimeSpan? within = null, int from = 0)
    {
        var deadline = DateTimeOffset.UtcNow + (within ?? Patience);
        var seen = from;

        while (true)
        {
            Task heard;

            lock (_frames)
            {
                for (; seen < _frames.Count; seen += 1)
                {
                    if (isWanted(_frames[seen]))
                    {
                        return _frames[seen];
                    }
                }

                heard = _heard.Task;
            }

            var left = deadline - DateTimeOffset.UtcNow;

            if (left <= TimeSpan.Zero || _closed.Task.IsCompleted)
            {
                throw new TimeoutException("no such frame came within its time");
            }

            await Task.WhenAny(heard, _closed.Task, Task.Delay(left, TestContext.Current.CancellationToken));
        }
    }

    /// <summary>The next frame of <typeparamref name="T"/> past the first <paramref name="skipping"/> of them, within its wait.</summary>
    public async Task<(ScriptedFrame Frame, T Performative)> Next<T>(int skipping = 0, TimeSpan? within = null)
    {
        var counted = 0;
        var frame = await Next(
            (each) =>
            {
                if (each.Performative is not T)
                {
                    return false;
                }

                counted += 1;

                return counted > skipping;
            },
            within);

        return (frame, (T)frame.Performative!);
    }

    /// <summary>The next management request, its pair's channel, and the link it came on, within its wait.</summary>
    public async Task<(ScriptedRequest Request, ScriptedTransfer Transfer)> NextRequest(int skipping = 0, TimeSpan? within = null)
    {
        var deadline = DateTimeOffset.UtcNow + (within ?? Patience);

        while (true)
        {
            var requests = Transfers.Where(IsManagement).ToList();

            if (requests.Count > skipping)
            {
                var transfer = requests[skipping];

                return (RequestOf(transfer.Message), transfer);
            }

            if (DateTimeOffset.UtcNow > deadline || _closed.Task.IsCompleted)
            {
                throw new TimeoutException("no management request came within its time");
            }

            await Task.Delay(5, TestContext.Current.CancellationToken);
        }
    }

    /// <summary>Writes <paramref name="performative"/> on <paramref name="channel"/>, and what follows it.</summary>
    public async Task Send(ushort channel, DescribedList performative, byte[]? payload = null)
    {
        var body = new ByteBuffer(256, true);

        performative.Encode(body);

        if (payload is not null)
        {
            AmqpBitConverter.WriteBytes(body, payload, 0, payload.Length);
        }

        var frame = new byte[8 + body.Length];

        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(frame, (uint)frame.Length);
        frame[4] = 2;
        frame[5] = performative is SaslMechanisms or SaslOutcome ? (byte)1 : (byte)0;
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(6), channel);
        Array.Copy(body.Buffer, body.Offset, frame, 8, body.Length);
        await Write(frame);
    }

    /// <summary>Answers an ATTACH: its terminus echoed, or, refusing it, a null one and a DETACH of <paramref name="refusal"/>.</summary>
    public async Task AnswerAttach(ScriptedFrame frame, Error? refusal = null)
    {
        var attach = (Attach)frame.Performative!;
        var link = Links.Last((each) =>
        {
            return each.Channel == frame.Channel && each.Handle == attach.Handle;
        });
        var answer = new Attach
        {
            LinkName = attach.LinkName,
            Handle = attach.Handle,
            Role = !attach.Role,
            SndSettleMode = attach.SndSettleMode,
            RcvSettleMode = attach.RcvSettleMode,
            Source = refusal is not null && attach.Role ? null : attach.Source,
            Target = refusal is not null && !attach.Role ? null : attach.Target,
            InitialDeliveryCount = 0,
        };

        if (!attach.Role && refusal is null && _script.MaxMessageSize is { } maximum)
        {
            answer.MaxMessageSize = maximum;
        }

        await Send(frame.Channel, answer);

        if (refusal is not null)
        {
            await Detach(link, refusal);

            return;
        }

        // * a sender of the adapter's is given its credit as a broker gives it
        if (!attach.Role && link.Address != AmqpManagement.Node)
        {
            await Credit((link, _script.SenderCredit));
        }
        else if (!attach.Role)
        {
            await Credit((link, 100));
        }
    }

    /// <summary>Gives a sender of the adapter's <c>Credit</c> more, by a FLOW.</summary>
    public Task Credit((ScriptedLink Link, uint Credit) given)
    {
        var (link, credit) = given;

        return Send(link.Channel, new Flow
        {
            NextIncomingId = 0,
            IncomingWindow = 65_536,
            NextOutgoingId = 0,
            OutgoingWindow = 65_536,
            Handle = link.Handle,
            DeliveryCount = link.DeliveryCount,
            LinkCredit = credit,
        });
    }

    /// <summary>Settles a transfer of the adapter's with <paramref name="outcome"/>.</summary>
    public Task Settle(ScriptedTransfer transfer, Outcome outcome)
    {
        ArgumentNullException.ThrowIfNull(transfer);

        return Send(transfer.Channel, new Dispose { Role = true, First = transfer.DeliveryId, Last = transfer.DeliveryId, Settled = true, State = outcome });
    }

    /// <summary>Answers a management request of <paramref name="transfer"/> with <c>Status</c> and its body.</summary>
    public Task Answer(ScriptedTransfer transfer, (string Status, object? Body) answer, object? correlation = null)
    {
        ArgumentNullException.ThrowIfNull(transfer);

        var request = RequestOf(transfer.Message);
        var receiver = Links.Last((link) =>
        {
            return link.Channel == transfer.Channel && link.IsReceiver && link.Address == AmqpManagement.Node;
        });

        var properties = new Properties { Subject = answer.Status };

        properties.SetCorrelationId(correlation ?? request.MessageId);

        return Deliver((receiver, new Message { Properties = properties, BodySection = new AmqpValue { Value = answer.Body } }), true);
    }

    /// <summary>
    /// Delivers <paramref name="delivered"/>'s message on a receiver of the adapter's once it has credit for it,
    /// settled where <paramref name="isSettled"/> says; its delivery id.
    /// </summary>
    public async Task<uint> Deliver((ScriptedLink Link, Message Message) delivered, bool isSettled = false)
    {
        var (link, message) = delivered;
        var encoded = message.Encode();

        return await DeliverBytes((link, encoded.Buffer.AsSpan(encoded.Offset, encoded.Length).ToArray()), isSettled);
    }

    /// <summary>As <see cref="Deliver"/>, of bytes as they are, for what no message writes: cut in frames of 16 KiB.</summary>
    public async Task<uint> DeliverBytes((ScriptedLink Link, byte[] Bytes) delivered, bool isSettled = false)
    {
        var (link, bytes) = delivered;
        var deadline = DateTimeOffset.UtcNow + Patience;

        while (true)
        {
            lock (_frames)
            {
                if (link.Credit > 0)
                {
                    link.Credit -= 1;
                    link.DeliveryCount += 1;

                    break;
                }
            }

            if (DateTimeOffset.UtcNow > deadline)
            {
                throw new TimeoutException($"the receiver {link.Name} gave no credit within its time");
            }

            await Task.Delay(5, TestContext.Current.CancellationToken);
        }

        uint id;

        lock (_frames)
        {
            id = _deliveryIds.GetValueOrDefault(link.Channel);
            _deliveryIds[link.Channel] = id + 1;
            _deliveryTag += 1;
        }

        const int Chunk = 16_384;

        for (var at = 0; at == 0 || at < bytes.Length; at += Chunk)
        {
            var size = Math.Min(Chunk, bytes.Length - at);
            var isFirst = at == 0;
            var transfer = new AmqpTransfer { Handle = link.Handle, More = at + size < bytes.Length };

            if (isFirst)
            {
                transfer.DeliveryId = id;
                transfer.DeliveryTag = BitConverter.GetBytes(_deliveryTag);
                transfer.MessageFormat = 0;
                transfer.Settled = isSettled;
            }

            await Send(link.Channel, transfer, bytes[at..(at + size)]);
        }

        return id;
    }

    /// <summary>Detaches a link of the adapter's, as a broker that ends it does, naming <paramref name="error"/>.</summary>
    public Task Detach(ScriptedLink link, Error? error = null)
    {
        ArgumentNullException.ThrowIfNull(link);

        lock (_frames)
        {
            _detached.Add((link.Channel, link.Handle));
        }

        return Send(link.Channel, new Detach { Handle = link.Handle, Closed = true, Error = error });
    }

    /// <summary>Ends a session of the adapter's, as RabbitMQ ends one on an access it refuses.</summary>
    public Task End(ushort channel, Error? error = null)
    {
        lock (_frames)
        {
            _ended.Add(channel);
        }

        return Send(channel, new AmqpEnd { Error = error });
    }

    /// <summary>Closes the connection, naming <paramref name="error"/>, then ends its socket.</summary>
    public async Task Close(Error? error = null)
    {
        _isClosing = true;
        await Send(0, new AmqpClose { Error = error });
        await Task.Delay(50, TestContext.Current.CancellationToken);
        End();
    }

    /// <summary>Ends it at once, as a network that drops a connection does, its socket reset.</summary>
    public void Cut()
    {
        try
        {
            _socket.LingerState = new LingerOption(true, 0);
            _socket.Close();
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            // closed already
        }
    }

    /// <summary>Ends it once what was written went.</summary>
    public void End()
    {
        try
        {
            _socket.Shutdown(SocketShutdown.Both);
            _socket.Close();
        }
        catch (Exception reason) when (reason is SocketException or ObjectDisposedException)
        {
            // closed already
        }
    }

    /// <summary>Its SASL taken, as a broker that takes any user does, and its OPEN read and answered.</summary>
    internal async Task Opened()
    {
        var header = new byte[8];

        await Filled(header);

        if (header[4] == 3)
        {
            await Write([.. "AMQP"u8, 3, 1, 0, 0]);
            await Send(0, new SaslMechanisms { SaslServerMechanisms = [new Symbol("PLAIN"), new Symbol("EXTERNAL"), new Symbol("ANONYMOUS")] });
            SaslInit = (SaslInit)(await NextFrame())!.Performative!;
            await Send(0, new SaslOutcome { Code = SaslCode.Ok });
            await Filled(header);
        }

        await Write([.. "AMQP"u8, 0, 1, 0, 0]);
        Open = (Open)(await NextFrame())!.Performative!;

        var open = new Open { ContainerId = "script", MaxFrameSize = 65_536, ChannelMax = _script.ChannelMax };

        if (_script.IdleTimeout > 0)
        {
            open.IdleTimeOut = _script.IdleTimeout;
        }

        await Send(0, open);
    }

    /// <summary>Reads its frames as they come, answering each as the script does, until its end.</summary>
    internal void Read()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                while (await NextFrame() is { } frame)
                {
                    // ! a frame on a channel once the adapter's END came on it is a protocol error
                    // (AMQP 1.0 §2.5.5): its connection cut, as rhea's peer refuses one
                    if (IsPastEnd(frame))
                    {
                        Cut();

                        break;
                    }

                    lock (_frames)
                    {
                        _frames.Add(frame);
                        Track(frame);
                        _heard.TrySetResult();
                        _heard = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    }

                    if (!_script.Holding(frame))
                    {
                        await Answered(frame);
                    }
                }
            }
            catch (Exception reason) when (reason is IOException or SocketException or ObjectDisposedException or OperationCanceledException)
            {
                // the adapter's end cut it
            }
            finally
            {
                _closed.TrySetResult();
            }
        });
    }

    // whether a frame comes on a channel the adapter ended: a BEGIN opens one anew, and OPEN and CLOSE
    // are the connection's
    private bool IsPastEnd(ScriptedFrame frame)
    {
        lock (_frames)
        {
            if (frame.Performative is Begin)
            {
                _endedByAdapter.Remove(frame.Channel);

                return false;
            }

            if (frame.Performative is global::Amqp.Framing.Open or AmqpClose)
            {
                return false;
            }

            var isPast = _endedByAdapter.Contains(frame.Channel);

            if (frame.Performative is AmqpEnd)
            {
                _endedByAdapter.Add(frame.Channel);
            }

            return isPast;
        }
    }

    // whether a transfer is a management request: one on a sender of the adapter's to the management node
    private bool IsManagement(ScriptedTransfer transfer)
    {
        return Links.Any((link) =>
        {
            return link.Channel == transfer.Channel && link.Handle == transfer.Handle && !link.IsReceiver && link.Address == AmqpManagement.Node;
        });
    }

    private static ScriptedRequest RequestOf(Message message)
    {
        return new ScriptedRequest(message.Properties.Subject, message.Properties.To, message.Properties.GetMessageId(), message.Body);
    }

    // what a frame changes of the script's view: a link attached, a receiver's credit, a transfer whole
    private void Track(ScriptedFrame frame)
    {
        switch (frame.Performative)
        {
            case Attach attach:
                _links.Add(new ScriptedLink(frame.Channel, attach));

                break;
            case Detach detach:
                foreach (var link in _links.Where((each) =>
                {
                    return each.Channel == frame.Channel && each.Handle == detach.Handle;
                }))
                {
                    link.IsDetached = true;
                }

                break;
            case Flow { HasHandle: true } flow:
                foreach (var link in _links.Where((each) =>
                {
                    return each.Channel == frame.Channel && each.Handle == flow.Handle && each.IsReceiver && !each.IsDetached;
                }))
                {
                    link.Credit = (long)flow.DeliveryCount + flow.LinkCredit - link.DeliveryCount;
                }

                break;
            case AmqpTransfer transfer:
                var key = (frame.Channel, transfer.Handle);

                if (!_partial.TryGetValue(key, out var partial))
                {
                    partial = (transfer, new MemoryStream());
                    _partial[key] = partial;
                }

                partial.Bytes.Write(frame.Payload);

                if (!transfer.More)
                {
                    // * a sender's deliveries counted, which the FLOW that gives it credit names
                    foreach (var link in _links.Where((each) =>
                    {
                        return each.Channel == frame.Channel && each.Handle == transfer.Handle && !each.IsReceiver && !each.IsDetached;
                    }))
                    {
                        link.DeliveryCount += 1;
                    }

                    _partial.Remove(key);
                    _transfers.Add(new ScriptedTransfer(frame.Channel, transfer.Handle, partial.First.DeliveryId, partial.First.Settled, partial.First.MessageFormat, partial.Bytes.ToArray()));
                }

                break;
        }
    }

    // a frame answered as a broker that limits nothing answers it
    private async Task Answered(ScriptedFrame frame)
    {
        switch (frame.Performative)
        {
            case Begin:
                await Send(frame.Channel, new Begin { RemoteChannel = frame.Channel, NextOutgoingId = 0, IncomingWindow = 65_536, OutgoingWindow = 65_536, HandleMax = 255 });

                break;
            case Attach:
                await AnswerAttach(frame);

                break;
            case Detach detach:
                bool isAnswer;

                lock (_frames)
                {
                    isAnswer = _detached.Remove((frame.Channel, detach.Handle));
                }

                // * the answer to a DETACH of the script's own is echoed no more
                if (!isAnswer)
                {
                    await Send(frame.Channel, new Detach { Handle = detach.Handle, Closed = detach.Closed });
                }

                break;
            case AmqpEnd:
                bool isEnded;

                lock (_frames)
                {
                    isEnded = _ended.Remove(frame.Channel);
                }

                if (!isEnded)
                {
                    await Send(frame.Channel, new AmqpEnd());
                }

                break;
            case AmqpClose when !_isClosing:
                await Send(0, new AmqpClose());
                End();

                break;
            case AmqpTransfer { More: false } transfer:
                var whole = Transfers.LastOrDefault((each) =>
                {
                    return each.Channel == frame.Channel && each.Handle == transfer.Handle;
                });

                if (whole is null)
                {
                    break;
                }

                if (IsManagement(whole))
                {
                    await Answer(whole, _script.Management(RequestOf(whole.Message)));
                }
                else if (!whole.IsSettled)
                {
                    await Settle(whole, _script.Outcome(whole));
                }

                break;
        }
    }

    // one frame: its size, its header, its performative and what follows it; none at its end, and
    // an empty one, a heartbeat, skipped
    private async Task<ScriptedFrame?> NextFrame()
    {
        while (true)
        {
            var head = new byte[8];

            if (!await Filled(head))
            {
                return null;
            }

            var size = (int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(head);
            var channel = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(head.AsSpan(6));
            var rest = new byte[size - 8];

            if (rest.Length > 0 && !await Filled(rest))
            {
                return null;
            }

            var offset = (head[4] * 4) - 8;

            if (rest.Length - offset == 0)
            {
                continue;
            }

            var buffer = new ByteBuffer(rest, offset, rest.Length - offset, rest.Length);
            var performative = global::Amqp.Types.Encoder.ReadObject(buffer);

            return new ScriptedFrame(channel, performative, buffer.Buffer.AsSpan(buffer.Offset, buffer.Length).ToArray());
        }
    }

    // a write after the one before it
    private Task Write(byte[] bytes)
    {
        lock (_gate)
        {
            _written = Writing((_written, bytes));

            return _written;
        }
    }

    private async Task Writing((Task Before, byte[] Bytes) write)
    {
        await write.Before;

        try
        {
            await _stream.WriteAsync(write.Bytes);
            await _stream.FlushAsync();
        }
        catch (Exception reason) when (reason is IOException or SocketException or ObjectDisposedException or NotSupportedException)
        {
            // the adapter's end closed it
        }
    }

    private async Task<bool> Filled(byte[] buffer)
    {
        var read = 0;

        while (read < buffer.Length)
        {
            var count = await _stream.ReadAsync(buffer.AsMemory(read));

            if (count == 0)
            {
                return false;
            }

            read += count;
        }

        return true;
    }
}
