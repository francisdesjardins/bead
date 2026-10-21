using System.Text.Json;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// <see cref="JoinedServerTransport"/> (spec 15.14): one server transport over an in-memory one
/// and a WebSocket-typed one of the tests' own, each handle its transport's, each flag, send and
/// close asked of it, their stops and gauges taken together, and one server serving both. The
/// TypeScript side's <c>joined-transport-server.test.ts</c> holds the same sentences.
/// </summary>
public sealed class JoinedServerTransportTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // the one connection of the WebSocket-typed transport
    private const string Socket = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // a JSON value, as the interop's generated client takes it
    private static JsonElement JsonOf<T>(T value)
    {
        return JsonSerializer.SerializeToElement(value);
    }

    // definition

    [Fact]
    public async Task Hands_on_each_transport_s_events_with_the_handle_it_drew()
    {
        var scheduler = new SerialScheduler();
        await using var memory = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        var paired = new PairedTransport(scheduler);
        await using var joined = new JoinedServerTransport([memory, paired]);
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var told = new List<string>();
        var refusal = new TransportServerRefusal("203.0.113.7", "example.com", null, 50_002, "host-refused", 403);

        joined.Connection += (connectionHandle) =>
        {
            told.Add($"connection {connectionHandle}");
        };

        // * a listener that throws is reported with its connection, and the next is told all the same
        joined.Connection += (connectionHandle) =>
        {
            throw new InvalidOperationException($"a listener of {connectionHandle} throws");
        };
        joined.Connection += (connectionHandle) =>
        {
            told.Add($"after {connectionHandle}");
        };
        joined.Message += (message, connectionHandle) =>
        {
            told.Add($"message {message.Bytes.Span[0]} {connectionHandle}");
        };
        joined.Listen += (isHeld, connectionHandle) =>
        {
            told.Add($"listen {isHeld} {connectionHandle}");
        };
        joined.Refusal += (refused) =>
        {
            told.Add($"refusal {refused.Reason}");
        };
        joined.Close += (isClean, connectionHandle) =>
        {
            told.Add($"close {isClean} {connectionHandle}");
        };
        joined.Error += (reason, connectionHandle) =>
        {
            told.Add($"error {reason.Message} {connectionHandle}");
        };

        await memory.Start();
        await client.Connect(new MemoryConnectOptions { Server = memory }, Cancelled);

        var drawn = Assert.Single(memory.ConnectionHandles);

        await client.Send(new TransportMessage(new byte[] { 1 }, false));
        await client.CloseConnection();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        paired.Open();
        paired.Deliver(new TransportMessage(new byte[] { 2 }, false));
        paired.Told(true);
        paired.Refuse(refusal);
        paired.Fail(new IOException("a socket broke"));
        paired.Closed();

        Assert.Equal(
            [
                $"connection {drawn}",
                $"error a listener of {drawn} throws {drawn}",
                $"after {drawn}",
                $"message 1 {drawn}",
                $"close True {drawn}",
                $"connection {Socket}",
                $"error a listener of {Socket} throws {Socket}",
                $"after {Socket}",
                $"message 2 {Socket}",
                $"listen True {Socket}",
                "refusal host-refused",
                $"error a socket broke {Socket}",
                $"close False {Socket}",
            ],
            told);
    }

    [Fact]
    public async Task Asks_each_connection_s_flags_of_the_transport_that_drew_it_and_sends_and_closes_through_it()
    {
        var scheduler = new SerialScheduler();
        await using var memory = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        var paired = new PairedTransport(scheduler) { IsSecured = false, IsCarrying = true, IsBothWays = false };
        await using var joined = new JoinedServerTransport([memory, paired]);
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();

        client.Message += (message) =>
        {
            heard.Add(Convert.ToHexString(message.Bytes.Span));
        };
        await memory.Start();
        await client.Connect(new MemoryConnectOptions { Server = memory }, Cancelled);
        paired.Open();

        var drawn = Assert.Single(memory.ConnectionHandles);

        Assert.Equal((true, false, true), (joined.IsSecure(drawn), joined.CarriesCredential(drawn), joined.IsTwoWay(drawn)));
        Assert.Equal((false, true, false), (joined.IsSecure(Socket), joined.CarriesCredential(Socket), joined.IsTwoWay(Socket)));

        // a handle none of them drew is none of theirs, nor one no handle's form holds: neither
        // secure, nor carrying, nor two-way, and closes nothing
        const string Elsewhere = "type=HTTP;ip=127.0.0.1;ordinal=1";
        const string Formless = "nothing";

        Assert.Equal((false, false, false), (joined.IsSecure(Elsewhere), joined.CarriesCredential(Elsewhere), joined.IsTwoWay(Elsewhere)));
        Assert.Equal((false, false, false), (joined.IsSecure(Formless), joined.CarriesCredential(Formless), joined.IsTwoWay(Formless)));

        await joined.Send(new TransportMessage(new byte[] { 1 }, false), drawn);
        await joined.Send(new TransportMessage(new byte[] { 2 }, false), Socket);
        await joined.Send(new TransportMessage(new byte[] { 3 }, false), Elsewhere);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(["01"], heard);
        Assert.Equal(["send 02"], paired.Calls);

        Assert.True(await joined.CloseConnection(drawn));
        Assert.True(await joined.CloseConnection(Socket));
        Assert.False(await joined.CloseConnection(Elsewhere));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal((ReadyState.Closed, 0), (client.ReadyState, memory.ConnectionHandles.Count));
        Assert.Equal(["send 02", $"close {Socket}"], paired.Calls);
    }

    [Fact]
    public async Task Refuses_to_join_two_transports_of_one_type()
    {
        await using var first = new MemoryTransportServer();
        await using var second = new MemoryTransportServer();
        var paired = new PairedTransport(new SerialScheduler());

        var twice = Assert.Throws<ArgumentException>(() =>
        {
            return new JoinedServerTransport([first, paired, second]);
        });

        Assert.StartsWith("a join takes one transport of each type: two are MEMORY, whose handles might be one", twice.Message, StringComparison.Ordinal);

        // a join names no type of its own, so no join takes it; nor is any taken alone, nor on
        // another clock than the others
        await using var joined = new JoinedServerTransport([first]);

        Assert.Null(joined.Type);
        Assert.Throws<ArgumentException>(() =>
        {
            return new JoinedServerTransport([joined, paired]);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new JoinedServerTransport([]);
        });
        await using var elsewhere = new MemoryTransportServer(new MemoryTransportServerOptions { Clock = new SteppingClock(DateTimeOffset.UnixEpoch) });

        Assert.Throws<ArgumentException>(() =>
        {
            return new JoinedServerTransport([paired, elsewhere]);
        });
    }

    [Fact]
    public async Task Stops_every_transport_it_joined_and_sums_their_gauges()
    {
        var scheduler = new SerialScheduler();
        await using var memory = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        var paired = new PairedTransport(scheduler)
        {
            Held = new Gauges
            {
                Anomalies = ["a socket held twice"],
                Ceilings = new Dictionary<string, long> { ["connections"] = 10_000, ["largestAddressConnections"] = 64 },
                ConnectionHandles = new HashSet<string> { Socket },
                Counts = new Dictionary<string, long> { ["connections"] = 1, ["largestAddressConnections"] = 1 },
            },
        };
        // what counts nothing: its connections as its events told them
        var uncounted = new PairedTransport(scheduler) { Kind = TransportTypes.Http, Handle = "type=HTTP;ip=127.0.0.1;port=50002;ordinal=1" };
        await using var joined = new JoinedServerTransport([memory, paired, uncounted]);
        await using var first = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        await using var second = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });

        await memory.Start();
        await first.Connect(new MemoryConnectOptions { Server = memory }, Cancelled);
        await second.Connect(new MemoryConnectOptions { Server = memory }, Cancelled);
        uncounted.Open();

        var gauges = joined.Gauges();

        Assert.Equal(new Dictionary<string, long> { ["connections"] = 4, ["largestAddressConnections"] = 1 }, gauges.Counts);
        Assert.Equal(new Dictionary<string, long> { ["connections"] = 10_000, ["largestAddressConnections"] = 64 }, gauges.Ceilings);
        Assert.Equal(new HashSet<string>([Socket, uncounted.Handle, .. memory.ConnectionHandles]), gauges.ConnectionHandles);
        Assert.Equal(["a socket held twice"], gauges.Anomalies);

        uncounted.Closed();

        Assert.Equal(3, joined.Gauges().Counts["connections"]);

        await joined.Shutdown();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal((ReadyState.Closed, ReadyState.Closed, ReadyState.Closed), (memory.ReadyState, first.ReadyState, second.ReadyState));
        Assert.Equal(["shutdown"], paired.Calls);
        Assert.Equal(["shutdown"], uncounted.Calls);

        // one that fails to stop fails the join's, once every other settled
        var failing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var late = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failingOne = new PairedTransport(scheduler)
        {
            Kind = TransportTypes.Http,
            Stopping = () =>
            {
                return failing.Task;
            },
        };
        var lateOne = new PairedTransport(scheduler)
        {
            Stopping = () =>
            {
                return late.Task;
            },
        };
        var stopping = new JoinedServerTransport([failingOne, lateOne]).Shutdown();

        failing.SetException(new InvalidOperationException("a stop that fails"));
        await Task.Delay(TimeSpan.FromMilliseconds(50), Cancelled);

        Assert.False(stopping.IsCompleted);
        Assert.Equal(["shutdown"], failingOne.Calls);
        Assert.Equal(["shutdown"], lateOne.Calls);

        late.SetResult();

        var reason = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return stopping.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("a stop that fails", reason.Message);
    }

    [Fact]
    public async Task Serves_one_service_offered_once_to_a_client_of_each_transport()
    {
        var scheduler = new SerialScheduler();
        var memory = new MemoryTransportServer();
        var paired = new PairedTransport(scheduler)
        {
            Held = Gauges.Of(new Dictionary<string, long> { ["connections"] = 1 }, [Socket]),
        };
        var joined = new JoinedServerTransport([memory, paired]);
        await using var server = new Server<string>(joined);
        await using var inMemory = new MemoryTransportClient();
        await using var byMemory = new ServiceLink.LinkedClient(new RouterClient(inMemory));
        await using var bySocket = new ServiceLink.LinkedClient(new RouterClient(paired.Client));

        // * offered once, on the one server: each transport's client reaches it
        InteropHandlers.Offer(server);
        await memory.Start();
        await inMemory.Connect(new MemoryConnectOptions { Server = memory }, Cancelled);
        paired.Open();

        var fromMemory = await new InteropClient(byMemory).Echo(JsonOf("from memory"))().WaitAsync(Patience, Cancelled);
        var fromSocket = await new InteropClient(bySocket).Echo(JsonOf("from a socket"))().WaitAsync(Patience, Cancelled);

        Assert.Equal(("from memory", "from a socket"), (fromMemory.GetString(), fromSocket.GetString()));
        Assert.Same(joined, server.Transport);

        var gauges = await server.Gauges();

        // both transports' connections counted as one transport's, and none of the router's left out
        Assert.Equal((2L, 0), (gauges.Transport.Counts["connections"], gauges.Router.Orphans));
    }

    // a WebSocket-typed transport of the tests' own, its one connection paired with a client end:
    // its flags as a test sets them, each envelope handed on in a turn of the scheduler given, and
    // each of its calls recorded
    private sealed class PairedTransport : IServerTransport
    {
        private readonly SerialScheduler _scheduler;

        public PairedTransport(SerialScheduler scheduler)
        {
            _scheduler = scheduler;
            Client = new ClientEnd(this);
        }

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public event Action<bool, string>? Listen;

        public event Action<TransportServerRefusal>? Refusal;

        public event Action<Exception, string>? Error;

        public string? Type
        {
            get
            {
                return Kind;
            }
        }

        public string Kind { get; init; } = TransportTypes.WebSocket;

        public string Handle { get; init; } = Socket;

        public Func<Task>? Stopping { get; init; }

        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public bool IsSecured { get; init; } = true;

        public bool IsCarrying { get; init; }

        public bool IsBothWays { get; init; } = true;

        public Gauges? Held { get; init; }

        public ClientEnd Client { get; }

        public List<string> Calls { get; } = [];

        public void Open()
        {
            Connection?.Invoke(Handle);
        }

        public void Deliver(TransportMessage message)
        {
            Message?.Invoke(message, Handle);
        }

        public void Told(bool isHeld)
        {
            Listen?.Invoke(isHeld, Handle);
        }

        public void Refuse(TransportServerRefusal refusal)
        {
            Refusal?.Invoke(refusal);
        }

        public void Fail(Exception reason)
        {
            Error?.Invoke(reason, Handle);
        }

        public void Closed()
        {
            Close?.Invoke(false, Handle);
        }

        public bool IsSecure(string connectionHandle)
        {
            return IsSecured;
        }

        public bool CarriesCredential(string connectionHandle)
        {
            return IsCarrying;
        }

        public bool IsTwoWay(string connectionHandle)
        {
            return IsBothWays;
        }

        public Gauges? Gauges()
        {
            return Held;
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            Calls.Add($"close {connectionHandle}");

            return Task.FromResult(true);
        }

        public Task Shutdown()
        {
            Calls.Add("shutdown");

            return Stopping?.Invoke() ?? Task.CompletedTask;
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var bytes = message.Bytes.ToArray();

            lock (Calls)
            {
                Calls.Add($"send {Convert.ToHexString(bytes)}");
            }

            _scheduler.Post(() =>
            {
                Client.Deliver(bytes);
            });

            return Task.CompletedTask;
        }

        // what the client's router sends, handed to the server in a turn of the scheduler's own
        public void Receive(byte[] bytes)
        {
            _scheduler.Post(() =>
            {
                Deliver(new TransportMessage(bytes, false));
            });
        }
    }

    // the client's end of the paired transport's one connection, secure
    private sealed class ClientEnd(PairedTransport server) : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public bool IsSecure
        {
            get
            {
                return true;
            }
        }

        public void Deliver(byte[] bytes)
        {
            Message?.Invoke(new TransportMessage(bytes, false));
        }

        public Task Send(TransportMessage message)
        {
            server.Receive(message.Bytes.ToArray());

            return Task.CompletedTask;
        }
    }
}
