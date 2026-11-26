using System.Collections.Concurrent;
using System.Net.Security;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core.Features;

namespace Bead.Transport.Http;

public sealed partial class HttpTransportServer
{
    // the HTTP/2 sessions it times, by their connection's id, which each exchange's context carries
    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.Ordinal);

    // * an HTTP/2 session with no answer under way reads a head whole within HeadersTimeout, or ends
    // (spec 15.12): Kestrel's KeepAliveTimeout ends one silent, but a PING keeps it alive, so the
    // transport times each of its own, from its handshake's end and again in full from its last
    // answer's end, and ends it by RequestClose(), Kestrel's GOAWAY. No frame is read; HTTP/1.1
    // stays KeepAliveTimeout's
    private ConnectionDelegate Idling(ConnectionDelegate next)
    {
        return async (connection) =>
        {
            if (!IsHttp2(connection))
            {
                await next(connection);

                return;
            }

            using var session = new Session((_platform, _options.HeadersTimeout), () =>
            {
                CloseIdle(connection);
            });

            _sessions[connection.ConnectionId] = session;

            try
            {
                await next(connection);
            }
            finally
            {
                _sessions.TryRemove(connection.ConnectionId, out _);
            }
        };
    }

    // whether its handshake chose HTTP/2 by ALPN (RFC 7301)
    private static bool IsHttp2(ConnectionContext connection)
    {
        return connection.Features.Get<ITlsApplicationProtocolFeature>() is { } tls
            && tls.ApplicationProtocol.Span.SequenceEqual(SslApplicationProtocol.Http2.Protocol.Span);
    }

    // a session idle past its time ended: its GOAWAY, its socket closed once no stream is open
    private static void CloseIdle(ConnectionContext connection)
    {
        try
        {
            connection.Features.Get<IConnectionLifetimeNotificationFeature>()?.RequestClose();
        }
        catch (ObjectDisposedException)
        {
            // ! a session that ended as its timer fired: nothing left to close
        }
    }

    // an HTTP/2 session's idle span: its answers under way, and the timer that ends it once none
    // has been for HeadersTimeout, armed as it opens
    private sealed class Session : IDisposable
    {
        private readonly Lock _gate = new();
        private readonly TimeSpan _idle;
        private readonly Action _ending;
        private readonly ITimer _timer;
        private int _answering;
        private bool _isGone;

        public Session((TimeProvider Platform, TimeSpan Idle) timing, Action ending)
        {
            _idle = timing.Idle;
            _ending = ending;
            _timer = timing.Platform.CreateTimer(Fire, null, timing.Idle, Timeout.InfiniteTimeSpan);
        }

        // a head read whole: its timer held until its answer ends
        public void Begin()
        {
            lock (_gate)
            {
                _answering += 1;

                if (_answering == 1 && !_isGone)
                {
                    _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                }
            }
        }

        // ! an answer's end, marked once on every path its exchange takes: its last end arms its
        // timer again in full, and one left unmarked would keep its session for ever
        public void End()
        {
            lock (_gate)
            {
                _answering -= 1;

                if (_answering == 0 && !_isGone)
                {
                    _timer.Change(_idle, Timeout.InfiniteTimeSpan);
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _isGone = true;
            }

            _timer.Dispose();
        }

        // its time passed with no answer under way: its session ended, outside its lock
        private void Fire(object? state)
        {
            lock (_gate)
            {
                if (_isGone || _answering > 0)
                {
                    return;
                }
            }

            _ending();
        }
    }
}
