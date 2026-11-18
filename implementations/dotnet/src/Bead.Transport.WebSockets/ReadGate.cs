using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Bead.Transport.WebSockets;

/// <summary>
/// A connection's read gate (spec 15.12, decision 0046): shut while its router paused it, but
/// for a message partway, which is read to its end; opened for good once the connection closes,
/// which reads on to its peer's Close (RFC 6455 §7.1.1), or once its socket ends. On a server, each
/// read of its socket's stream waits at it, so a read already pending as the pause comes reads
/// nothing more of its peer. It takes its own lock alone, never held as it settles a wait.
/// </summary>
internal sealed class ReadGate
{
    private readonly Lock _lock = new();
    private bool _isPaused;
    private bool _isReadingOn;
    private bool _isPartway;
    private TaskCompletionSource? _resumed;
    private TaskCompletionSource? _readable;

    /// <summary>Whether it opened for good, its connection closing or its socket ended.</summary>
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

    /// <summary>Shuts it, its router behind; nothing once it opened for good. Idempotent.</summary>
    public void Pause()
    {
        lock (_lock)
        {
            if (!_isReadingOn)
            {
                _isPaused = true;
            }
        }
    }

    /// <summary>Opens it: for a resume, or for good, its connection closing or its socket ended.</summary>
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

    /// <summary>Settles once a message may be handed: at once unless its router paused it.</summary>
    public Task Resumed()
    {
        lock (_lock)
        {
            if (!_isPaused)
            {
                return Task.CompletedTask;
            }

            _resumed ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            return _resumed.Task;
        }
    }

    /// <summary>
    /// Settles once its socket may be read: at once unless its router paused it with no message
    /// partway.
    /// </summary>
    public Task Readable()
    {
        lock (_lock)
        {
            if (!_isPaused || _isPartway)
            {
                return Task.CompletedTask;
            }

            _readable ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            return _readable.Task;
        }
    }

    /// <summary>
    /// Gives an upgrade a gate of its own, ahead of ASP.NET Core's WebSocket middleware: its
    /// upgrade's stream read through the gate, the gate its <c>HttpContext</c>'s feature, and
    /// opened for good once its request is aborted.
    /// </summary>
    public static async Task Gating(HttpContext context, RequestDelegate next)
    {
        var features = context.Features;
        var upgrade = features.Get<IHttpUpgradeFeature>();
        var connect = features.Get<IHttpExtendedConnectFeature>();

        if (upgrade is not { IsUpgradableRequest: true } && connect is not { IsExtendedConnect: true })
        {
            await next(context);

            return;
        }

        var gate = new ReadGate();

        features.Set(gate);

        if (upgrade is not null)
        {
            features.Set<IHttpUpgradeFeature>(new GatedUpgrade(upgrade, gate));
        }

        if (connect is not null)
        {
            features.Set<IHttpExtendedConnectFeature>(new GatedConnect(connect, gate));
        }

        // ! its socket's end, as Kestrel tells it, opens it for good, so a paused read meets that
        // end at once: .NET's keep-alive, dropping the connection, aborts its request
        using var ending = context.RequestAborted.Register(() =>
        {
            gate.Open(true);
        });

        await next(context);
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
            _gate.Readable().GetAwaiter().GetResult();

            return _inner.Read(buffer, offset, count);
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await _gate.Readable().WaitAsync(cancellationToken);

            return await _inner.ReadAsync(buffer, cancellationToken);
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

        // its socket gone, its gate opens for good: a read waiting at it meets the end
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _gate.Open(true);
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
