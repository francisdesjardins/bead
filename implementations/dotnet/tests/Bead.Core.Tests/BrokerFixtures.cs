using System.Collections.Concurrent;
using System.Diagnostics;

namespace Bead.Tests;

/// <summary>How a broker pair is built: its client's adapter's capabilities, and its heartbeat.</summary>
internal sealed record BrokerPairOptions
{
    public BrokerCapabilities? ClientCapabilities { get; init; }

    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// A server's transport and its clients' participant over one in-memory broker, on one scheduler:
/// the server's participant <c>server</c> serving <c>interop</c>, the clients' <c>client</c>, and
/// what the server's transport told, in order.
/// </summary>
internal sealed class BrokerPair : IAsyncDisposable
{
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private BrokerPair(BrokerPairOptions options)
    {
        Broker = new MemoryBroker(new MemoryBrokerOptions { Scheduler = Scheduler });
        ServerAdapter = Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "server" });
        ClientAdapter = Broker.Adapter(new MemoryBrokerAdapterOptions { Id = "client", Capabilities = options.ClientCapabilities });
        ServerParticipant = new BrokerParticipant(ServerAdapter, new BrokerParticipantOptions { Heartbeat = options.Heartbeat, Scheduler = Scheduler });
        ClientParticipant = new BrokerParticipant(ClientAdapter, new BrokerParticipantOptions
        {
            Heartbeat = options.Heartbeat,
            Reconnect = new TransportReconnectOptions { Delay = Immediately, MaximumAttempts = int.MaxValue },
            Scheduler = Scheduler,
        });
        Server = ServerParticipant.Server(new BrokerTransportServerOptions { Names = ["interop"] });
        Server.Connection += Opened.Enqueue;
        Server.Close += (isClean, connectionHandle) =>
        {
            Closed.Enqueue((isClean, connectionHandle));
        };
    }

    public SerialScheduler Scheduler { get; } = new();

    public MemoryBroker Broker { get; }

    public MemoryBrokerAdapter ServerAdapter { get; }

    public MemoryBrokerAdapter ClientAdapter { get; }

    public BrokerParticipant ServerParticipant { get; }

    public BrokerParticipant ClientParticipant { get; }

    public BrokerTransportServer Server { get; }

    /// <summary>Each connection the server's transport told opened, by its handle.</summary>
    public ConcurrentQueue<string> Opened { get; } = new();

    /// <summary>Each close the server's transport told.</summary>
    public ConcurrentQueue<(bool IsClean, string ConnectionHandle)> Closed { get; } = new();

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    public static async Task<BrokerPair> Of(BrokerPairOptions? options = null)
    {
        var pair = new BrokerPair(options ?? new BrokerPairOptions());

        await pair.Server.Start();
        await pair.ClientParticipant.Start();

        return pair;
    }

    /// <summary>Waits, on the real clock and within a patience, until <paramref name="holds"/> does.</summary>
    public static async Task Until(Func<bool> holds, string what)
    {
        var watch = Stopwatch.StartNew();

        while (!holds() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }

        Assert.True(holds(), what);
    }

    /// <summary>A client of the clients' participant, connected to <c>interop</c>, its connection told open at the server.</summary>
    public async Task<BrokerTransportClient> Connect()
    {
        var before = Opened.Count;
        var client = ClientParticipant.Client();

        await client.Connect(new BrokerConnectOptions { Server = "interop" }, Cancelled);
        await Until(
            () =>
            {
                return Opened.Count > before;
            },
            "the server tells the connection open");

        return client;
    }

    public async ValueTask DisposeAsync()
    {
        await Server.DisposeAsync();
        await ClientParticipant.DisposeAsync();
        await ServerParticipant.DisposeAsync();
    }

    private static TimeSpan Immediately(TimeSpan? previousDelay, int attempt)
    {
        return TimeSpan.Zero;
    }
}
