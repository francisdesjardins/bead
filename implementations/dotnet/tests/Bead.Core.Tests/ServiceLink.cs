namespace Bead.Tests;

/// <summary>
/// A server and a client of Bead linked through a pair of the in-memory transport (spec 15.13), one
/// connection between them, for the service layer's tests: a <see cref="Server{TData}"/> of string
/// sessions over a <see cref="MemoryTransportServer"/>, and an <see cref="IClient"/> over a client's
/// router on a <see cref="MemoryTransportClient"/>, secure, so a call may present any credential.
/// </summary>
internal sealed class ServiceLink : IAsyncDisposable
{
    /// <summary>The one connection's handle on the server: the first its transport drew, of a client that gave no address.</summary>
    public const string Handle = "type=MEMORY;ip=local;ordinal=1";

    private readonly MemoryTransportClient _client;
    private readonly TaskCompletionSource<Exception> _reported = new(TaskCreationOptions.RunContinuationsAsynchronously);

    // a link whose routers count into the registry given, when given, not yet connected
    private ServiceLink(MemoryTransportServer transport, MetricsRegistry? registry)
    {
        _client = new MemoryTransportClient();
        Transport = transport;
        Server = new Server<string>(transport, new ServerOptions { MetricsRegistry = registry });
        Client = new LinkedClient(new RouterClient(_client, new RouterClientOptions { MetricsRegistry = registry }));
        Server.Router.Error += (reason, _) =>
        {
            lock (Reported)
            {
                Reported.Add(reason);
            }

            _reported.TrySetResult(reason);
        };
    }

    /// <summary>The server's transport.</summary>
    public MemoryTransportServer Transport { get; }

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

    /// <summary>
    /// A link whose routers count into <paramref name="registry"/>, when given: its server's
    /// transport started, and its client connected.
    /// </summary>
    public static async Task<ServiceLink> Open(MetricsRegistry? registry = null)
    {
        var link = new ServiceLink(new MemoryTransportServer(), registry);

        await link.Transport.Start();
        await link._client.Connect(new MemoryConnectOptions { Server = link.Transport });

        return link;
    }

    /// <summary>Closes the connection, then disposes both ends.</summary>
    public async ValueTask DisposeAsync()
    {
        await _client.DisposeAsync();
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
}
