using System.Net.WebSockets;

namespace Bead.Transport.WebSockets.Tests;

/// <summary>The connection's queues, with a socket whose frames and first send the test controls.</summary>
public sealed class WebSocketConnectionTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private sealed class HeldWebSocket : WebSocket
    {
        private WebSocketState _state = WebSocketState.Open;

        public TaskCompletionSource Sending { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Released { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<byte[]> Sent { get; } = [];

        public Queue<(byte[] Bytes, bool IsEnd)> Incoming { get; } = new();

        public int Aborts { get; private set; }

        public override WebSocketCloseStatus? CloseStatus
        {
            get { return null; }
        }

        public override string? CloseStatusDescription
        {
            get { return null; }
        }

        public override WebSocketState State
        {
            get { return _state; }
        }

        public override string? SubProtocol
        {
            get { return null; }
        }

        public void Break()
        {
            _state = WebSocketState.Aborted;
            Released.TrySetException(new IOException("the socket breaks during its send"));
        }

        public override void Abort()
        {
            Aborts += 1;
            _state = WebSocketState.Aborted;
        }

        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            return CloseOutputAsync(closeStatus, statusDescription, cancellationToken);
        }

        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken)
        {
            _state = WebSocketState.CloseSent;

            return Task.CompletedTask;
        }

        public override void Dispose()
        {
            _state = WebSocketState.Closed;
            Released.TrySetResult();
        }

        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken)
        {
            if (Incoming.TryDequeue(out var frame))
            {
                frame.Bytes.AsSpan().CopyTo(buffer.AsSpan());

                return Task.FromResult(new WebSocketReceiveResult(frame.Bytes.Length, WebSocketMessageType.Binary, frame.IsEnd));
            }

            _state = WebSocketState.CloseReceived;

            return Task.FromResult(new WebSocketReceiveResult(0, WebSocketMessageType.Close, true));
        }

        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType messageType, bool endOfMessage, CancellationToken cancellationToken)
        {
            Sent.Add(buffer.ToArray());
            Sending.TrySetResult();

            return Released.Task;
        }
    }

    private static WebSocketConnection ConnectionOf(HeldWebSocket socket, bool isPaced)
    {
        return new WebSocketConnection(socket, new WebSocketConnection.Bounds
        {
            MaximumMessageBytes = 64,
            CloseTimeout = Timeout.InfiniteTimeSpan,
            Pace = isPaced ? new WebSocketConnection.Pacing
            {
                MaximumUnsentBytes = 64,
                MinimumSendBytesPerSecond = 0,
                SendGracePeriod = TimeSpan.Zero,
            } : null,
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Settles_a_send_after_its_connection_ends_without_writing_or_holding_bytes(bool isPaced)
    {
        using var socket = new HeldWebSocket();
        var connection = ConnectionOf(socket, isPaced);

        connection.End();
        await connection.Send(new byte[] { 1, 2, 3 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await connection.CloseQuietly(WebSocketCloseStatus.NormalClosure).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Empty(socket.Sent);
        Assert.Equal(0, socket.Aborts);
        Assert.Equal(0, connection.UnsentBytes);
        Assert.False(connection.IsEndedHere);
    }

    [Fact]
    public async Task Settles_queued_sends_and_releases_their_byte_count_when_its_socket_fails()
    {
        using var socket = new HeldWebSocket();
        var connection = ConnectionOf(socket, true);

        try
        {
            var first = connection.Send(new byte[] { 1, 2, 3 });
            await socket.Sending.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
            var second = connection.Send(new byte[] { 4, 5 });
            var third = connection.Send(new byte[] { 6 });

            Assert.Equal(6, connection.UnsentBytes);
            socket.Break();
            await Task.WhenAll(first, second, third).WaitAsync(Patience, TestContext.Current.CancellationToken);

            Assert.Equal(new byte[] { 1, 2, 3 }, Assert.Single(socket.Sent));
            Assert.Equal(0, connection.UnsentBytes);
            Assert.Equal(0, socket.Aborts);
            Assert.False(connection.IsEndedHere);
            Assert.Null(connection.Dropped);
        }
        finally
        {
            connection.End();
        }
    }

    [Fact]
    public async Task Delivers_a_fragmented_message_whole_then_the_next_message_separately()
    {
        using var socket = new HeldWebSocket();
        var connection = ConnectionOf(socket, false);
        var messages = new List<TransportMessage>();

        socket.Incoming.Enqueue(([1, 2], false));
        socket.Incoming.Enqueue(([3], true));
        socket.Incoming.Enqueue(([4], true));

        await connection.Read(messages.Add).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(2, messages.Count);
        Assert.Equal(new byte[] { 1, 2, 3 }, messages[0].Bytes.ToArray());
        Assert.Equal(new byte[] { 4 }, messages[1].Bytes.ToArray());
        Assert.All(messages, (message) => { Assert.False(message.IsText); });
        Assert.Equal(WebSocketState.CloseSent, socket.State);
        Assert.Equal(0, socket.Aborts);
        Assert.False(connection.IsEndedHere);
    }
}
