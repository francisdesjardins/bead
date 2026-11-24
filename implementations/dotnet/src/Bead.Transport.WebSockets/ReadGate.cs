using System.Buffers;
using System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Bead.Transport.WebSockets;

/// <summary>
/// A connection's read gate (spec 15.12, decision 0046): shut while its router paused it, but
/// for a message partway, which is read to its end; opened for good once the connection closes,
/// which reads on to its peer's Close (RFC 6455 §7.1.1). Each read of its socket's stream waits at
/// it, a server's and a client's, so a read already pending as the pause comes reads nothing more
/// of its peer, and its socket's end lets every wait go, so a paused connection ends at once. It
/// takes its own lock alone, never held as it settles a wait. Each read of its socket's stream fills
/// a buffer of its own, up to <see cref="ServerBounds.GateReadBytes"/>, which goes through its meter
/// (decision 0056) at once, all that read brought, before .NET's reader is served from it. Once its
/// socket ended while its router paused it, its meter ends, and what it reads goes unmetered.
/// </summary>
internal sealed class ReadGate
{
    // what a read of its socket's stream drains into once its meter's verdict was drawn
    private const int DrainBytes = 4_096;

    private readonly Lock _lock = new();
    private bool _isPaused;
    private bool _isReadingOn;
    private bool _isPartway;
    private bool _isEnded;
    private TaskCompletionSource? _resumed;
    private TaskCompletionSource? _readable;

    /// <summary>
    /// The meter its socket's stream is read through, which judges each frame at its head; none
    /// meters nothing.
    /// </summary>
    public FrameMeter? Meter { get; init; }

    /// <summary>Whether it opened for good, its connection closing.</summary>
    public bool IsReadingOn
    {
        get
        {
            lock (_lock)
            {
                return _isReadingOn;
            }
        }
    }

    /// <summary>
    /// Whether what it read is dropped: its connection closing, or its socket ended while its
    /// router paused it, what it held going with the connection.
    /// </summary>
    public bool IsDropping
    {
        get
        {
            lock (_lock)
            {
                return _isReadingOn || (_isEnded && _isPaused);
            }
        }
    }

    /// <summary>Shuts it, its router behind; nothing once it opened for good. Idempotent.</summary>
    public void Pause()
    {
        bool isDropped;

        lock (_lock)
        {
            if (!_isReadingOn)
            {
                _isPaused = true;
            }

            isDropped = _isEnded && _isPaused;
        }

        if (isDropped)
        {
            Unmetered();
        }
    }

    /// <summary>Opens it: for a resume, or for good, its connection closing.</summary>
    public void Open(bool isForGood)
    {
        TaskCompletionSource? resumed;
        TaskCompletionSource? readable;

        lock (_lock)
        {
            _isReadingOn |= isForGood;
            _isPaused = false;
            resumed = _resumed;
            readable = _readable;
            _resumed = null;
            _readable = null;
        }

        resumed?.TrySetResult();
        readable?.TrySetResult();
    }

    /// <summary>
    /// Whether its read holds a message partway, whose socket's reads go on to its end, paused or not.
    /// </summary>
    public void Partway(bool isPartway)
    {
        TaskCompletionSource? readable = null;

        lock (_lock)
        {
            _isPartway = isPartway;

            if (isPartway)
            {
                readable = _readable;
                _readable = null;
            }
        }

        readable?.TrySetResult();
    }

    /// <summary>
    /// Its socket ended: every wait goes, and its socket's reads meet that end, paused or not. A
    /// connection its router did not pause reads on as before, nothing it read dropped. Idempotent.
    /// </summary>
    public void End()
    {
        TaskCompletionSource? resumed;
        TaskCompletionSource? readable;
        bool isDropped;

        lock (_lock)
        {
            _isEnded = true;
            isDropped = _isPaused;
            resumed = _resumed;
            readable = _readable;
            _resumed = null;
            _readable = null;
        }

        if (isDropped)
        {
            Unmetered();
        }

        resumed?.TrySetResult();
        readable?.TrySetResult();
    }

    // ! its socket ended while its router paused it: what it held goes with its connection, its
    // charge released, and what it reads after is dropped unmetered, as the other sides drop it,
    // charging no other connection's cast-off
    private void Unmetered()
    {
        Meter?.End();
    }

    /// <summary>
    /// Settles once a message may be handed, or dropped: at once unless its router paused it and
    /// its socket did not end.
    /// </summary>
    public Task Resumed()
    {
        lock (_lock)
        {
            if (!_isPaused || _isEnded)
            {
                return Task.CompletedTask;
            }

            _resumed ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            return _resumed.Task;
        }
    }

    /// <summary>
    /// Settles once its socket may be read: at once unless its router paused it with no message
    /// partway and its socket did not end.
    /// </summary>
    public Task Readable()
    {
        lock (_lock)
        {
            if (!_isPaused || _isPartway || _isEnded)
            {
                return Task.CompletedTask;
            }

            _readable ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            return _readable.Task;
        }
    }

    /// <summary>
    /// Gives an upgrade a gate of its own, ahead of ASP.NET Core's WebSocket middleware, with the
    /// meter <c>MeterOf</c> makes: its upgrade's stream read through the gate, the gate its
    /// <c>HttpContext</c>'s feature, its socket's end told it once its request is aborted, and its
    /// meter ended once its request is.
    /// </summary>
    public static async Task Gating(HttpContext context, (RequestDelegate Next, Func<FrameMeter> MeterOf) call)
    {
        var (next, meterOf) = call;
        var features = context.Features;
        var upgrade = features.Get<IHttpUpgradeFeature>();
        var connect = features.Get<IHttpExtendedConnectFeature>();

        if (upgrade is not { IsUpgradableRequest: true } && connect is not { IsExtendedConnect: true })
        {
            await next(context);

            return;
        }

        var gate = new ReadGate { Meter = meterOf() };

        features.Set(gate);

        if (upgrade is not null)
        {
            features.Set<IHttpUpgradeFeature>(new GatedUpgrade(upgrade, gate));
        }

        if (connect is not null)
        {
            features.Set<IHttpExtendedConnectFeature>(new GatedConnect(connect, gate));
        }

        // ! its socket's end, as Kestrel tells it, a FIN or a reset, lets a paused read meet that
        // end at once
        using var ending = context.RequestAborted.Register(() =>
        {
            gate.End();
        });

        try
        {
            await next(context);
        }
        finally
        {
            // * whatever way its upgrade went, what its meter charged is released
            gate.Meter?.End();
        }
    }

    /// <summary>
    /// What sends a client's opening handshake through <paramref name="invoker"/>, the stream of its
    /// upgrade read through this gate: a <c>ClientWebSocket</c> reads the content of the answer to
    /// its upgrade, which this hands it gated. Its socket's end, as .NET's keep-alive drops it,
    /// disposes that stream, which tells the gate.
    /// </summary>
    public HttpMessageInvoker Upgrading(HttpMessageInvoker invoker)
    {
        return new HttpMessageInvoker(new GatedHandler(invoker, this));
    }

    // a client's handshake sent through the invoker it was given, never disposed here, its answer's
    // content read through its gate
    private sealed class GatedHandler : HttpMessageHandler
    {
        private readonly HttpMessageInvoker _invoker;
        private readonly ReadGate _gate;

        public GatedHandler(HttpMessageInvoker invoker, ReadGate gate)
        {
            _invoker = invoker;
            _gate = gate;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            // ! nothing posted to its caller's context: a connect's own end is its first post
            var response = await _invoker.SendAsync(request, cancellationToken).ConfigureAwait(false);

            response.Content = new GatedContent(response.Content, _gate);

            return response;
        }
    }

    // the content of a client's upgrade answered, its stream read through its gate; it disposes the
    // content it wraps
    private sealed class GatedContent : HttpContent
    {
        private readonly HttpContent _inner;
        private readonly ReadGate _gate;

        public GatedContent(HttpContent inner, ReadGate gate)
        {
            _inner = inner;
            _gate = gate;

            foreach (var (name, values) in inner.Headers)
            {
                Headers.TryAddWithoutValidation(name, values);
            }
        }

        protected override Stream CreateContentReadStream(CancellationToken cancellationToken)
        {
            return new GatedStream(_inner.ReadAsStream(cancellationToken), _gate);
        }

        protected override Task<Stream> CreateContentReadStreamAsync()
        {
            return CreateContentReadStreamAsync(CancellationToken.None);
        }

        protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken)
        {
            return new GatedStream(await _inner.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false), _gate);
        }

        // ! never what a WebSocket reads, which is its read stream: copied whole, it would read past
        // the gate
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            return _inner.CopyToAsync(stream, context);
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;

            return false;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }

    // an HTTP/1.1 upgrade whose stream is read through its gate
    private sealed class GatedUpgrade : IHttpUpgradeFeature
    {
        private readonly IHttpUpgradeFeature _upgrade;
        private readonly ReadGate _gate;

        public GatedUpgrade(IHttpUpgradeFeature upgrade, ReadGate gate)
        {
            _upgrade = upgrade;
            _gate = gate;
        }

        public bool IsUpgradableRequest
        {
            get
            {
                return _upgrade.IsUpgradableRequest;
            }
        }

        public async Task<Stream> UpgradeAsync()
        {
            return new GatedStream(await _upgrade.UpgradeAsync(), _gate);
        }
    }

    // an extended CONNECT's (RFC 8441) whose stream is read through its gate
    private sealed class GatedConnect : IHttpExtendedConnectFeature
    {
        private readonly IHttpExtendedConnectFeature _connect;
        private readonly ReadGate _gate;

        public GatedConnect(IHttpExtendedConnectFeature connect, ReadGate gate)
        {
            _connect = connect;
            _gate = gate;
        }

        public bool IsExtendedConnect
        {
            get
            {
                return _connect.IsExtendedConnect;
            }
        }

        public string? Protocol
        {
            get
            {
                return _connect.Protocol;
            }
        }

        public async ValueTask<Stream> AcceptAsync()
        {
            return new GatedStream(await _connect.AcceptAsync(), _gate);
        }
    }

    // * a socket's stream whose every read waits at its gate first; what it writes goes through as
    // it comes, so the heartbeat's ping goes while it is shut
    private sealed class GatedStream : Stream
    {
        private readonly Stream _inner;
        private readonly ReadGate _gate;

        // what its last read of its socket brought and its meter handed on, rented until served: from
        // _at to _end; and whether a verdict cut that read, what came before it served first. Its
        // reader's alone: .NET reads one read at a time
        private byte[]? _held;
        private int _at;
        private int _end;
        private bool _isCut;

        public GatedStream(Stream inner, ReadGate gate)
        {
            _inner = inner;
            _gate = gate;
        }

        public override bool CanRead
        {
            get
            {
                return _inner.CanRead;
            }
        }

        public override bool CanSeek
        {
            get
            {
                return false;
            }
        }

        public override bool CanWrite
        {
            get
            {
                return _inner.CanWrite;
            }
        }

        public override long Length
        {
            get
            {
                throw new NotSupportedException();
            }
        }

        public override long Position
        {
            get
            {
                throw new NotSupportedException();
            }

            set
            {
                throw new NotSupportedException();
            }
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            return ReadAsync(buffer.AsMemory(offset, count), CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        }

        // * each read waits at its gate, then is served from what its last read of its socket
        // brought, or reads its socket again into a buffer of its own, which goes through its meter
        // whole: what came before a verdict is served, and the verdict told once it is; from a
        // verdict on, nothing is
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var meter = _gate.Meter;

            if (meter?.Verdict is not null && !(_isCut && _at < _end))
            {
                Let();
                meter.Tell();

                return await Drain(cancellationToken);
            }

            var readable = _gate.Readable();

            // ! the rate's clock stops while its router holds the read (spec 15.12)
            if (!readable.IsCompleted)
            {
                meter?.Hold();

                try
                {
                    await readable.WaitAsync(cancellationToken);
                }
                finally
                {
                    meter?.Unhold();
                }
            }

            if (meter is null)
            {
                return await _inner.ReadAsync(buffer, cancellationToken);
            }

            if (_at == _end)
            {
                if (buffer.IsEmpty)
                {
                    return await _inner.ReadAsync(buffer, cancellationToken);
                }

                if (await Fill(meter, cancellationToken) == 0)
                {
                    return 0;
                }

                // a verdict at the read's first byte: nothing of it served
                if (_at == _end)
                {
                    meter.Tell();

                    return await Drain(cancellationToken);
                }
            }

            var count = Math.Min(buffer.Length, _end - _at);

            _held.AsSpan(_at, count).CopyTo(buffer.Span);
            _at += count;

            if (_at == _end)
            {
                Let();
            }

            return count;
        }

        // * its socket read once into a buffer rented once bytes are there, so a connection waiting
        // on its peer holds none, and all that read brought metered at once: how many bytes it
        // brought, what its meter handed on held from its start
        private async Task<int> Fill(FrameMeter meter, CancellationToken cancellationToken)
        {
            _ = await _inner.ReadAsync(Memory<byte>.Empty, cancellationToken);

            _held = ArrayPool<byte>.Shared.Rent(ServerBounds.GateReadBytes);

            int read;

            try
            {
                read = await _inner.ReadAsync(_held.AsMemory(0, ServerBounds.GateReadBytes), cancellationToken);
            }
            catch
            {
                Let();

                throw;
            }

            if (read == 0)
            {
                Let();

                return 0;
            }

            _at = 0;
            _end = meter.Read(_held.AsSpan(0, read));
            _isCut = meter.Verdict is not null;

            if (_end == 0)
            {
                Let();
            }

            return read;
        }

        // its buffer returned, once what it held was served or dropped
        private void Let()
        {
            if (_held is not null)
            {
                ArrayPool<byte>.Shared.Return(_held);
                _held = null;
            }

            _at = 0;
            _end = 0;
        }

        // ! once a verdict failed its connection, what comes is read and dropped, parsed by none,
        // the peer's close among it, until the peer ends, or its close timeout aborts the socket (RFC
        // 6455 §7.1.7): .NET's reader meets that end, never a frame
        private async Task<int> Drain(CancellationToken cancellationToken)
        {
            var dropped = new byte[DrainBytes];

            while (await _inner.ReadAsync(dropped, cancellationToken) > 0)
            {
                // dropped
            }

            return 0;
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            _inner.Write(buffer, offset, count);
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            _inner.Write(buffer);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return _inner.WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            return _inner.WriteAsync(buffer, cancellationToken);
        }

        public override void Flush()
        {
            _inner.Flush();
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
        {
            return _inner.FlushAsync(cancellationToken);
        }

        // its socket gone, as .NET's keep-alive drops it: a read waiting at its gate meets the end
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _gate.End();
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
