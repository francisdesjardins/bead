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

    // a connection's handle, which a server given a list answers of alike
    private const string First = "type=MEMORY;ip=local;ordinal=1";

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

        await first.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "127.0.0.1", Port = 50_001, CancellationToken = Cancelled });
        await second.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await third.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "::1", CancellationToken = Cancelled });

        Assert.Equal(
            [
                new TransportServerClient { Address = "127.0.0.1", ConnectionHandle = "type=MEMORY;ip=127.0.0.1;ordinal=1", LastActivity = null, Port = 50_001, Type = TransportTypes.Memory },
                new TransportServerClient { Address = "local", ConnectionHandle = "type=MEMORY;ip=local;ordinal=2", LastActivity = null, Port = 0, Type = TransportTypes.Memory },
                new TransportServerClient { Address = "::1", ConnectionHandle = "type=MEMORY;ip=::1;ordinal=3", LastActivity = null, Port = 0, Type = TransportTypes.Memory },
            ],
            server.Clients);

        // a client connected again is a new connection, drawn at the next rank; so is one after a
        // stop and a start, which reset no rank
        await first.CloseConnection();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        await first.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "127.0.0.1", Port = 50_001, CancellationToken = Cancelled });
        await second.Reconnect(new TransportClientReconnectOptions { CancellationToken = Cancelled });
        await server.Stop();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        await server.Start();
        await third.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

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
                return named.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = address, CancellationToken = Cancelled });
            });

            Assert.StartsWith("an in-memory connect's address", refused.Message, StringComparison.Ordinal);
        }

        foreach (var port in new[] { -1, 65_536 })
        {
            await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            {
                return named.Connect(new MemoryTransportClientConnectOptions { Server = server, Port = port, CancellationToken = Cancelled });
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
        await given.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "203.0.113.7", Port = 50_123, CancellationToken = Cancelled });
        await none.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await given.Send(new TransportMessage(new byte[] { 1 }, false));
        await none.Send(new TransportMessage(new byte[] { 2 }, false));
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [("203.0.113.7", 50_123, "type=MEMORY;ip=203.0.113.7;ordinal=1"), ("local", null, "type=MEMORY;ip=local;ordinal=2")],
            heard);
        Assert.Equal(
            [
                new TransportServerClient { Address = "203.0.113.7", ConnectionHandle = "type=MEMORY;ip=203.0.113.7;ordinal=1", LastActivity = instant, Port = 50_123, Type = TransportTypes.Memory },
                new TransportServerClient { Address = "local", ConnectionHandle = "type=MEMORY;ip=local;ordinal=2", LastActivity = instant, Port = 0, Type = TransportTypes.Memory },
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
        await caller.Connect(new MemoryTransportClientConnectOptions { Server = transport, Address = "198.51.100.4", Port = 61_000, CancellationToken = Cancelled });

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
            return first.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
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
        await first.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await second.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

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
            return first.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
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

            var queued = first.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
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

        var connecting = second.Connect(new MemoryTransportClientConnectOptions { Server = held, CancellationToken = Cancelled });

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
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = cancelling.Token });
        });
        Assert.Empty(server.ConnectionHandles);
        Assert.Empty(drawn);
        isCancelling = false;

        // a listener's throw reported with its connection, the transport going on
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

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
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

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
        await caller.Connect(new MemoryTransportClientConnectOptions { Server = transport, CancellationToken = Cancelled });

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

    // spec 15.12.17, 15.12.18
    [Fact]
    public async Task A_paused_in_memory_transport_holds_what_it_is_sent_in_order_and_hands_it_on_once_resumed()
    {
        const string ConnectionHandle = "type=MEMORY;ip=local;ordinal=1";

        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var atServer = new List<byte>();
        var atClient = new List<byte>();

        async Task Turn()
        {
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        }

        server.Message += (message, _) =>
        {
            var value = message.Bytes.Span[0];

            atServer.Add(value);

            // * a router at its bound pauses within the hand: what comes after waits
            if (value == 3)
            {
                server.Pause(ConnectionHandle);
            }
        };
        client.Message += (message) =>
        {
            atClient.AddRange(message.Bytes.ToArray());
        };
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

        // the server's end, paused, then paused again as it hands what it held
        server.Pause(ConnectionHandle);
        server.Pause(ConnectionHandle);

        foreach (var value in new byte[] { 1, 2, 3, 4, 5 })
        {
            await client.Send(new TransportMessage(new[] { value }, false));
        }

        await Turn();

        Assert.Empty(atServer);

        // * handed in a turn of its own, never within the resume; what comes meanwhile waits behind it
        server.Resume(ConnectionHandle);
        await client.Send(new TransportMessage(new byte[] { 6 }, false));

        Assert.Empty(atServer);

        await Turn();

        Assert.Equal([1, 2, 3], atServer);

        server.Resume(ConnectionHandle);
        await Turn();

        Assert.Equal([1, 2, 3, 4, 5, 6], atServer);

        // the client's end, paused whole
        client.Pause();

        foreach (var value in new byte[] { 7, 8 })
        {
            await server.Send(new TransportMessage(new[] { value }, false), ConnectionHandle);
        }

        await Turn();

        Assert.Empty(atClient);

        client.Resume();
        client.Resume();
        await Turn();

        Assert.Equal([7, 8], atClient);

        // * a handle no longer held is let be; what a connection held goes with it
        server.Pause(ConnectionHandle);
        await client.Send(new TransportMessage(new byte[] { 9 }, false));
        await Turn();
        await client.CloseConnection();
        await Turn();
        server.Resume(ConnectionHandle);
        await Turn();

        Assert.Equal([1, 2, 3, 4, 5, 6], atServer);
        Assert.Empty(server.Clients);
    }

    // decision 0003
    [Fact]
    public async Task Refuses_a_start_once_disposed_its_state_kept_and_disposes_once_stopping_it_first()
    {
        var server = new MemoryTransportServer();
        var closed = 0;

        await server.Start();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions());

        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = TestContext.Current.CancellationToken });
        server.Close += (_, _) =>
        {
            Interlocked.Increment(ref closed);
        };

        // * two disposes: one stop, its connection closed once
        await Task.WhenAll(server.DisposeAsync().AsTask(), server.DisposeAsync().AsTask());
        await BrokerPair.Until(
            () =>
            {
                return Volatile.Read(ref closed) == 1;
            },
            "its connection closed");
        Assert.Equal(ReadyState.Closed, server.ReadyState);

        // * a start after it: its application's misuse, its state kept
        Assert.Equal("the transport server is disposed", (await Assert.ThrowsAsync<ObjectDisposedException>(() =>
        {
            return server.Start();
        })).Message);
        Assert.Equal(ReadyState.Closed, server.ReadyState);
        Assert.Equal(1, Volatile.Read(ref closed));
    }

    // the procedures its connections take (spec 9.11, 9.12)

    // spec 9.12: the twin of "refuses procedures that name an id out of its range or service 0, as
    // the transport is built (spec 9.12)"
    [Fact]
    public void Refuses_procedures_that_name_an_id_out_of_its_range_or_service_0_as_the_transport_is_built()
    {
        foreach (var (address, said) in new[] { (new ProcedureAddress(0, 1), "0/1"), (new ProcedureAddress(1, 0), "1/0"), (new ProcedureAddress(0, 0), "0/0") })
        {
            var refused = Assert.Throws<ArgumentException>(() =>
            {
                return new MemoryTransportServer(new MemoryTransportServerOptions { Procedures = [new ProcedureAddress(1, 1), address] });
            });

            Assert.Equal(
                $"an in-memory transport server takes {said}, out of its range: a service and a procedure are from 1 to 65535, service 0 the protocol's (spec 9.12, 16.2, 16.3) (Parameter 'options')",
                refused.Message);
        }

        var bounds = new MemoryTransportServer(new MemoryTransportServerOptions { Procedures = [new ProcedureAddress(1, 1), new ProcedureAddress(65_535, 65_535)] });

        Assert.True(bounds.TakesProcedure(First, new ProcedureAddress(65_535, 65_535)));
    }

    // spec 9.12: the twin of "takes an address named twice as one (spec 9.12)"
    [Fact]
    public void Takes_an_address_named_twice_as_one()
    {
        var server = new MemoryTransportServer(new MemoryTransportServerOptions { Procedures = [new ProcedureAddress(1, 1), new ProcedureAddress(1, 1)] });

        Assert.True(server.NamesProcedures());
        Assert.True(server.TakesProcedure(First, new ProcedureAddress(1, 1)));
        Assert.False(server.TakesProcedure(First, new ProcedureAddress(1, 2)));
    }

    // spec 9.11: the twin of "a transport given no list takes every procedure, and one given an
    // empty list takes none (spec 9.11)"
    [Fact]
    public async Task A_transport_given_no_list_takes_every_procedure_and_one_given_an_empty_list_takes_none()
    {
        var every = new MemoryTransportServer();
        var none = new MemoryTransportServer(new MemoryTransportServerOptions { Procedures = [] });
        ProcedureAddress[] asked = [new(1, 1), new(9, 99)];

        // * given no list, it names none, and its router never asks
        Assert.False(every.NamesProcedures());
        Assert.All(asked, (address) =>
        {
            Assert.True(every.TakesProcedure(First, address));
        });
        Assert.True(none.NamesProcedures());
        Assert.All(asked, (address) =>
        {
            Assert.False(none.TakesProcedure(First, address));
        });

        // through a server of the interop service, each request it takes none of answered as one
        // to no resolver
        var transport = new MemoryTransportServer(new MemoryTransportServerOptions { Procedures = [] });
        await using var server = new Server<string>(transport);
        await using var caller = new MemoryTransportClient();
        await using var linked = new ServiceLink.LinkedClient(new RouterClient(caller));

        InteropHandlers.Offer(server);
        await transport.Start();
        await caller.Connect(new MemoryTransportClientConnectOptions { Server = transport, CancellationToken = Cancelled });

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return new InteropClient(linked).Echo(JsonOf("x"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.ServiceUnknown, refused.Code);
        Assert.Equal("no service 1", refused.Failure.Detail);
    }
}
