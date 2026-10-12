namespace Bead.Tests;

/// <summary>
/// A server and a client of Bead linked in memory, one connection between them, for the service
/// layer's tests: a <see cref="Server{TData}"/> of string sessions, and an <see cref="IClient"/>
/// over a client's router, its transport secure, so a call may present any credential.
/// </summary>
internal sealed class ServiceLink : IAsyncDisposable
{
    /// <summary>The one connection's handle on the server.</summary>
    public const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private readonly ClientEnd _client = new();
    private readonly ServerEnd _server = new();
    private readonly TaskCompletionSource<Exception> _reported = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>A link whose routers count into <paramref name="registry"/>, when given.</summary>
    public ServiceLink(MetricsRegistry? registry = null)
    {
        _client.Peer = _server;
        _server.Peer = _client;
        Server = new Server<string>(_server, new ServerOptions { MetricsRegistry = registry });
        Client = new LinkedClient(new RouterClient(_client, new RouterClientOptions { MetricsRegistry = registry }));
        Server.Router.Error += (reason, _) =>
        {
            lock (Reported)
            {
                Reported.Add(reason);
            }

            _reported.TrySetResult(reason);
        };
        _server.Open();
    }

    /// <summary>The server.</summary>
    public Server<string> Server { get; }

    /// <summary>The client.</summary>
    public LinkedClient Client { get; }

    /// <summary>What the server's router reported, in order.</summary>
    public List<Exception> Reported { get; } = [];

    /// <summary>
    /// The first thing the server's router reports: in its own turn, so after the answer a failed
    /// resolver's call was given, which its caller may hear first.
    /// </summary>
    public Task<Exception> FirstReported
    {
        get
        {
            return _reported.Task;
        }
    }

    /// <summary>Closes the connection, then disposes both ends.</summary>
    public async ValueTask DisposeAsync()
    {
        _server.Closed();
        _client.CloseConnection();
        await Server.DisposeAsync();
        await Client.DisposeAsync();
    }

    /// <summary>A client over a router its test built: its layers, and a transport that never reconnects.</summary>
    internal sealed class LinkedClient : IClient
    {
        public LinkedClient(RouterClient router)
        {
            Router = router;
            Services = new ServiceManager(router);
        }

        public RouterClient Router { get; }

        public ServiceManager Services { get; }

        public Task Disconnect(TransportDisconnectOptions? options = null)
        {
            return Task.CompletedTask;
        }

        public Task Reconnect(TransportReconnectOptions? options = null)
        {
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Router.Dispose();

            return ValueTask.CompletedTask;
        }
    }

    private sealed class ClientEnd : IRouterClientTransport
    {
        public TimeProvider Clock { get; } = TimeProvider.System;

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        public ServerEnd? Peer { get; set; }

        // as the loopback is: a JWT may go over it
        public bool IsSecure
        {
            get
            {
                return true;
            }
        }

        public void Deliver(ReadOnlyMemory<byte> bytes)
        {
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false));
        }

        public void CloseConnection()
        {
            Close?.Invoke(false, false);
        }

        public Task Send(TransportMessage message)
        {
            Peer!.Deliver(message.Bytes);

            return Task.CompletedTask;
        }
    }

    private sealed class ServerEnd : IServerTransport
    {
        public TimeProvider Clock { get; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public ClientEnd? Peer { get; set; }

        public void Open()
        {
            Connection?.Invoke(Handle);
        }

        public void Deliver(ReadOnlyMemory<byte> bytes)
        {
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false), Handle);
        }

        public void Closed()
        {
            Close?.Invoke(false, Handle);
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            Peer!.Deliver(message.Bytes);

            return Task.CompletedTask;
        }
    }
}
