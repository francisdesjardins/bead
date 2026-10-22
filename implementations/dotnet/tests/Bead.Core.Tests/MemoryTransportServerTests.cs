using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="MemoryTransportServer"/> (spec 15.13): the handles it draws, what it hands its router
/// beside each envelope, its stop, and a transfer carried under its routers' limits. The TypeScript
/// side's <c>memory-transport-server.test.ts</c> holds the same sentences.
/// </summary>
public sealed class MemoryTransportServerTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

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
    public async Task Draws_a_handle_of_type_MEMORY_for_each_connect_and_gives_none_twice()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var first = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        await using var second = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        await using var third = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var drawn = new List<string>();

        server.Connection += drawn.Add;
        Assert.Equal(TransportTypes.Memory, server.Type);
        Assert.Equal(new TransportServerAddress("local", 0), await server.Start());

        await first.Connect(new MemoryConnectOptions { Server = server, Address = "127.0.0.1", Port = 50_001 }, Cancelled);
        await second.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        await third.Connect(new MemoryConnectOptions { Server = server, Address = "::1" }, Cancelled);

        Assert.Equal(
            [
                new TransportServerClient("127.0.0.1", "type=MEMORY;ip=127.0.0.1;ordinal=1", null, 50_001, TransportTypes.Memory),
                new TransportServerClient("local", "type=MEMORY;ip=local;ordinal=2", null, 0, TransportTypes.Memory),
                new TransportServerClient("::1", "type=MEMORY;ip=::1;ordinal=3", null, 0, TransportTypes.Memory),
            ],
            server.Clients);

        // a client connected again is a new connection, drawn at the next rank; so is one after a
        // stop and a start, which reset no rank
        await first.CloseConnection();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        await first.Connect(new MemoryConnectOptions { Server = server, Address = "127.0.0.1", Port = 50_001 }, Cancelled);
        await second.Reconnect(new TransportReconnectOptions { CancellationToken = Cancelled });
        await server.Stop();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        await server.Start();
        await third.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        Assert.Equal(
            [
                "type=MEMORY;ip=127.0.0.1;ordinal=1",
                "type=MEMORY;ip=local;ordinal=2",
                "type=MEMORY;ip=::1;ordinal=3",
                "type=MEMORY;ip=127.0.0.1;ordinal=4",
                "type=MEMORY;ip=local;ordinal=5",
                "type=MEMORY;ip=local;ordinal=6",
            ],
            drawn);
        Assert.Equal(["type=MEMORY;ip=local;ordinal=6"], server.ConnectionHandles);

        // * an address names the connection: what no handle could name, nor a socket carry, is
        // refused before anything moves, and so is a port past its range
        await using var named = new MemoryTransportClient();

        foreach (var address in new[] { "", "a;ordinal=1", "a b" })
        {
            var refused = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return named.Connect(new MemoryConnectOptions { Server = server, Address = address }, Cancelled);
            });

            Assert.StartsWith("an in-memory connect's address", refused.Message, StringComparison.Ordinal);
        }

        foreach (var port in new[] { -1, 65_536 })
        {
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            {
                return named.Connect(new MemoryConnectOptions { Server = server, Port = port }, Cancelled);
            });
        }

        Assert.Equal(ReadyState.Uninitialized, named.ReadyState);
        Assert.Equal(6, drawn.Count);
    }

    [Fact]
    public async Task Hands_its_router_the_address_and_the_port_its_client_gave_as_it_connected()
    {
        // a clock that never moves: what the server reads of it is the instant it starts at
        var instant = new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.Zero);
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Clock = new FakeTimeProvider(instant), Scheduler = scheduler });
        await using var given = new MemoryTransportClient();
        await using var none = new MemoryTransportClient();
        var heard = new List<(string? Address, int? Port, string ConnectionHandle)>();

        server.Message += (message, connectionHandle) =>
        {
            heard.Add((message.Address, message.Port, connectionHandle));
        };
        Assert.Equal(new TransportServerAddress("local", 0), await server.Start());
        await given.Connect(new MemoryConnectOptions { Server = server, Address = "203.0.113.7", Port = 50_123 }, Cancelled);
        await none.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        await given.Send(new TransportMessage(new byte[] { 1 }, false));
        await none.Send(new TransportMessage(new byte[] { 2 }, false));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [("203.0.113.7", 50_123, "type=MEMORY;ip=203.0.113.7;ordinal=1"), ("local", null, "type=MEMORY;ip=local;ordinal=2")],
            heard);
        Assert.Equal(
            [
                new TransportServerClient("203.0.113.7", "type=MEMORY;ip=203.0.113.7;ordinal=1", instant, 50_123, TransportTypes.Memory),
                new TransportServerClient("local", "type=MEMORY;ip=local;ordinal=2", instant, 0, TransportTypes.Memory),
            ],
            server.Clients);

        // * and its router tells an access it refuses by them (spec 13.12): one with no verifier
        // refuses the ELSEWHERE it was handed, and tells who asked
        var transport = new MemoryTransportServer();
        await using var built = new Server<string>(transport);
        await using var caller = new MemoryTransportClient();
        await using var linked = new ServiceLink.LinkedClient(new RouterClient(caller, new RouterClientOptions { Credential = Credential.Elsewhere("Bearer token") }));
        var refused = new TaskCompletionSource<AccessRefusal>(TaskCreationOptions.RunContinuationsAsynchronously);

        InteropHandlers.Offer(built);
        built.Router.AccessRefused += (refusal) =>
        {
            refused.TrySetResult(refusal);
        };
        await transport.Start();
        await caller.Connect(new MemoryConnectOptions { Server = transport, Address = "198.51.100.4", Port = 61_000 }, Cancelled);

        var failed = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return new InteropClient(linked).Echo(JsonOf("hi"))().WaitAsync(Patience, Cancelled);
        });
        var refusal = await refused.Task.WaitAsync(Patience, Cancelled);

        Assert.Equal((ushort)ProtocolCode.CredentialUnsupported, failed.Code);
        Assert.Equal(
            ("198.51.100.4", (int?)61_000, "type=MEMORY;ip=198.51.100.4;ordinal=1", ProtocolCode.CredentialUnsupported),
            (refusal.Address, refusal.Port, refusal.ConnectionHandle, refusal.Code));
    }

    [Fact]
    public async Task Closes_each_connection_as_it_stops_and_takes_no_connect_after()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var first = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        await using var second = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var told = new List<string>();

        // a connect before its start fails before anything goes
        var early = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return first.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        });

        Assert.Equal("the in-memory transport server is uninitialized, not open", early.Message);
        Assert.Equal(ReadyState.Closed, first.ReadyState);

        server.Close += (isClean, connectionHandle) =>
        {
            told.Add($"server {connectionHandle} {isClean}");
        };
        first.Close += (isClean, isQuick) =>
        {
            told.Add($"first {isClean} {isQuick}");
        };
        second.Close += (isClean, isQuick) =>
        {
            told.Add($"second {isClean} {isQuick}");
        };
        await server.Start();
        await first.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        await second.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        await server.Stop();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(
            ["server type=MEMORY;ip=local;ordinal=1 True", "server type=MEMORY;ip=local;ordinal=2 True", "first False False", "second False False"],
            told);
        Assert.Equal((ReadyState.Closed, ReadyState.Closed, ReadyState.Closed), (server.ReadyState, first.ReadyState, second.ReadyState));
        Assert.Empty(server.ConnectionHandles);
        Assert.Equal(0, server.Gauges().Counts["connections"]);

        var late = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return first.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        });

        Assert.Equal("the in-memory transport server is closed, not open", late.Message);
        Assert.Equal(ReadyState.Closed, first.ReadyState);

        // * a connect its server took as it listened, its draw still queued as a stop begins: judged
        // in the turn it would be drawn in, refused, and no connection drawn
        var drawn = new List<string>();

        server.Connection += drawn.Add;
        await server.Start();

        using (var gate = new ManualResetEventSlim())
        {
            scheduler.Post(() =>
            {
                gate.Wait(Patience);
            });

            var queued = first.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
            var stopping = server.Stop();

            gate.Set();

            var closing = await Assert.ThrowsAsync<ConnectException>(() =>
            {
                return queued.WaitAsync(Patience, Cancelled);
            });

            Assert.Equal("the in-memory transport server is closing, not open", closing.Message);
            await stopping.WaitAsync(Patience, Cancelled);
        }

        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Empty(drawn);
        Assert.Equal((ReadyState.Closed, ReadyState.Closed), (server.ReadyState, first.ReadyState));
        Assert.Equal(0, server.Gauges().Counts["connections"]);

        // and one its server holds before it draws it, until a stop ended: refused all the same
        var holding = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var held = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Accepting = async (token) =>
            {
                reached.TrySetResult();
                await holding.Task.WaitAsync(token);
            },
        });

        held.Connection += drawn.Add;
        await held.Start();

        var connecting = second.Connect(new MemoryConnectOptions { Server = held }, Cancelled);

        await reached.Task.WaitAsync(Patience, Cancelled);
        await held.Stop();
        holding.TrySetResult();

        var stopped = await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return connecting.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the in-memory transport server is closed, not open", stopped.Message);
        Assert.Empty(drawn);
        Assert.Equal(ReadyState.Closed, second.ReadyState);
        Assert.Equal(0, held.Gauges().Counts["connections"]);
    }

    [Fact]
    public async Task Draws_no_connection_for_a_connect_cancelled_as_it_held_it_and_reports_what_a_listener_throws()
    {
        var scheduler = new SerialScheduler();
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var isCancelling = false;

        // * a connect whose token is cancelled as its server holds it: no connection drawn
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Scheduler = scheduler,
            Accepting = async (_) =>
            {
                if (isCancelling)
                {
                    await cancelling.CancelAsync();
                }
            },
        });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var drawn = new List<string>();
        var heard = new List<string>();
        var reported = new List<string>();

        server.Connection += drawn.Add;
        server.Message += (message, _) =>
        {
            heard.Add($"heard {message.Bytes.Span[0]}");

            throw new InvalidOperationException("a listener broke");
        };
        server.Error += (reason, handle) =>
        {
            reported.Add($"{reason.Message} {handle}");
        };
        await server.Start();

        isCancelling = true;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Connect(new MemoryConnectOptions { Server = server }, cancelling.Token);
        });
        Assert.Empty(server.ConnectionHandles);
        Assert.Empty(drawn);
        isCancelling = false;

        // a listener's throw reported with its connection, the transport going on
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        var handle = Assert.Single(server.ConnectionHandles);

        await client.Send(new TransportMessage(new byte[] { 1 }, false));
        await client.Send(new TransportMessage(new byte[] { 2 }, false));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Equal("type=MEMORY;ip=local;ordinal=1", handle);
        Assert.Equal([handle], drawn);
        Assert.Equal(["heard 1", "heard 2"], heard);
        Assert.Equal([$"a listener broke {handle}", $"a listener broke {handle}"], reported);
    }

    [Fact]
    public async Task Drops_what_an_end_it_no_longer_holds_receives_and_refuses_to_send_what_is_no_bytes()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();
        var told = new List<bool>();
        var closedAtClient = new List<string>();

        server.Message += (message, _) =>
        {
            heard.Add($"heard {message.Bytes.Span[0]}");
        };
        server.Close += (isClean, _) =>
        {
            told.Add(isClean);
        };
        client.Close += (isClean, isQuick) =>
        {
            closedAtClient.Add($"{isClean} {isQuick}");
        };
        await server.Start();
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        var handle = Assert.Single(server.ConnectionHandles);

        // * a text message is no envelope: refused before it goes
        Assert.StartsWith("an in-memory connection carries envelopes, as bytes", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Send(new TransportMessage("text"u8.ToArray(), true), handle);
        })).Message, StringComparison.Ordinal);

        await client.Send(new TransportMessage(new byte[] { 1 }, false));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        // ended twice, then a send its client made before it heard so, every turn held behind a gate:
        // neither heard nor ended again
        using var gate = new ManualResetEventSlim();

        scheduler.Post(() =>
        {
            gate.Wait(Patience);
        });

        var ending = server.CloseConnection(handle);
        var again = server.CloseConnection(handle);

        await client.Send(new TransportMessage(new byte[] { 2 }, false));
        gate.Set();
        Assert.Equal((true, true), (await ending.WaitAsync(Patience, Cancelled), await again.WaitAsync(Patience, Cancelled)));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(["heard 1"], heard);
        Assert.Equal([true], told);
        Assert.Equal(["False False"], closedAtClient);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.ConnectionHandles);
    }

    [Fact]
    public async Task Carries_a_transfer_under_its_routers_credit()
    {
        // * a chunk of 1 KiB and a window of two: a payload of 20 of them crosses only as the
        // other end credits it, both ways
        var limits = new RouterLimits { ChunkBytes = 1_024, WindowBytes = 2_048 };
        var transport = new MemoryTransportServer();
        await using var server = new Server<string>(transport, new ServerOptions { Limits = limits });
        await using var caller = new MemoryTransportClient();
        var router = new RouterClient(caller, new RouterClientOptions { Limits = limits });
        await using var linked = new ServiceLink.LinkedClient(router);
        var sent = new List<EnvelopeKind>();
        var received = new List<EnvelopeKind>();

        InteropHandlers.Offer(server);
        router.Debug += (direction, envelope) =>
        {
            lock (sent)
            {
                (direction == DebugDirection.Tx ? sent : received).Add(envelope.Header.Kind);
            }
        };
        await transport.Start();
        await caller.Connect(new MemoryConnectOptions { Server = transport }, Cancelled);

        var payload = new string('x', 20 * 1_024);
        var echoed = await new InteropClient(linked).Echo(JsonOf(payload))().WaitAsync(Patience, Cancelled);

        Assert.Equal(payload, echoed.GetString());

        lock (sent)
        {
            Assert.True(sent.Count((kind) =>
            {
                return kind == EnvelopeKind.Chunk;
            }) > 2);
            Assert.Contains(EnvelopeKind.Credit, sent);
            Assert.True(received.Count((kind) =>
            {
                return kind == EnvelopeKind.Chunk;
            }) > 2);
            Assert.Contains(EnvelopeKind.Credit, received);
        }

        // and no transfer left held at its server, either way
        var counts = (await server.Router.Gauges().WaitAsync(Patience, Cancelled)).Counts;

        Assert.Equal((0L, 0L), (counts["receivingTransfers"], counts["sendingTransfers"]));
    }
}
