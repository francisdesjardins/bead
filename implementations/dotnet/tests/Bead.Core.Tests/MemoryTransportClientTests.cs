using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="MemoryTransportClient"/> (spec 15.13): what it hands its server and when, the
/// credential it carries, and how a close is told at each end. The TypeScript side's
/// <c>memory-transport-client.test.ts</c> holds the same sentences.
/// </summary>
public sealed class MemoryTransportClientTests
{
    // constants

    [Fact]
    public async Task Takes_a_field_s_value_as_a_credential_visible_ASCII_spaces_and_tabs_alone_none_first_or_last()
    {
        await using var client = new MemoryTransportClient();

        foreach (var value in new[] { "", "Interop sub=ada", "Bearer mF_9.B5f-4.1JqM", "a\tb", "~!" })
        {
            Assert.True(client.Carries(value), value);
        }

        foreach (var value in new[] { " Bearer x", "x ", "\tx", "Interop\nsub=ada", "café", "a\u007fb" })
        {
            Assert.False(client.Carries(value), value);
        }
    }

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private const string Carried = "Interop sub=ada";

    // whether the current thread is inside a send or a close of the test's own, which a delivery
    // told within it would see
    private static readonly ThreadLocal<bool> IsWithin = new();

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // runs what a test calls with the thread marked as within it
    private static T Within<T>(Func<T> call)
    {
        IsWithin.Value = true;

        try
        {
            return call();
        }
        finally
        {
            IsWithin.Value = false;
        }
    }

    // a server started and a client connected to it, both telling on the scheduler given
    private static async Task<(MemoryTransportServer Server, MemoryTransportClient Client, string ConnectionHandle)> Connected(SerialScheduler scheduler)
    {
        var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var connections = new List<string>();

        server.Connection += connections.Add;
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

        return (server, client, Assert.Single(connections));
    }

    // definition

    // spec 15.15
    [Fact]
    public async Task Hands_each_envelope_on_whole_once_and_in_order_in_a_later_turn_than_its_send()
    {
        var scheduler = new SerialScheduler();
        var (server, client, connectionHandle) = await Connected(scheduler);
        var toServer = new List<(string Bytes, string ConnectionHandle, bool IsWithin)>();
        var toClient = new List<(string Bytes, bool IsWithin)>();

        await using (server)
        await using (client)
        {
            server.Message += (message, handle) =>
            {
                toServer.Add((Convert.ToHexString(message.Bytes.Span), handle, IsWithin.Value));
            };
            client.Message += (message) =>
            {
                toClient.Add((Convert.ToHexString(message.Bytes.Span), IsWithin.Value));
            };

            byte[][] sent = [[1, 2, 3], [4], [5, 6]];
            byte[][] answered = [[7], [8, 9], [10]];

            // a view on a larger buffer crosses as its own bytes alone
            var pool = new byte[] { 9, 11, 12, 9 };

            // ! every turn of the receiving ends held behind a gate until the buffers changed, both
            // ways: a delivery that read the sender's buffer, not its copy, would hand on the change
            using var gate = new ManualResetEventSlim();

            scheduler.Post(() =>
            {
                gate.Wait(Patience);
            });

            foreach (var bytes in sent)
            {
                await Within(() =>
                {
                    return client.Send(new TransportMessage(bytes, false));
                });
            }

            await Within(() =>
            {
                return client.Send(new TransportMessage(pool.AsMemory(1, 2), false));
            });

            foreach (var bytes in answered)
            {
                await Within(() =>
                {
                    return server.Send(new TransportMessage(bytes, false), connectionHandle);
                });
            }

            // * nothing within the send; the sender's buffers its own once sent
            Assert.Empty(toServer);
            Assert.Empty(toClient);

            foreach (var bytes in sent.Concat(answered))
            {
                Array.Fill(bytes, (byte)0);
            }

            Array.Fill(pool, (byte)0);
            gate.Set();
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

            Assert.Equal([("010203", connectionHandle, false), ("04", connectionHandle, false), ("0506", connectionHandle, false), ("0B0C", connectionHandle, false)], toServer);
            Assert.Equal([("07", false), ("0809", false), ("0A", false)], toClient);
        }
    }

    [Fact]
    public async Task Carries_the_credential_a_request_presents_beside_it_and_none_toward_its_client()
    {
        var scheduler = new SerialScheduler();
        var (server, client, connectionHandle) = await Connected(scheduler);
        var toServer = new List<string?>();
        var toClient = new List<string?>();

        await using (server)
        await using (client)
        {
            server.Message += (message, _) =>
            {
                toServer.Add(message.Credential);
            };
            client.Message += (message) =>
            {
                toClient.Add(message.Credential);
            };

            // any field value, as POST /bead carries one; none toward a client, whatever it is given
            Assert.True(client.Carries(Carried));
            Assert.True(client.Carries("Bearer mF_9.B5f-4.1JqM"));
            Assert.False(client.Carries(" Bearer x"));
            Assert.False(server.CarriesCredential(connectionHandle));
            Assert.True(client.IsSecure);
            Assert.True(server.IsSecure(connectionHandle));

            await client.Send(new TransportMessage(new byte[] { 1 }, false) { Credential = Carried });
            await client.Send(new TransportMessage(new byte[] { 2 }, false));

            // an empty field carries none
            await client.Send(new TransportMessage(new byte[] { 3 }, false) { Credential = "" });
            await server.Send(new TransportMessage(new byte[] { 4 }, false) { Credential = Carried }, connectionHandle);

            // one no field carries is refused before it goes, the connection kept
            Assert.StartsWith("a credential holds visible ASCII, spaces and tabs alone", (await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return client.Send(new TransportMessage(new byte[] { 5 }, false) { Credential = "Interop\nsub=ada" });
            })).Message, StringComparison.Ordinal);
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

            Assert.Equal([Carried, null, null], toServer);
            Assert.Equal([null], toClient);
            Assert.Equal(ReadyState.Open, client.ReadyState);
        }

        // * through both routers: a call presenting ELSEWHERE stands for what came beside it
        var transport = new MemoryTransportServer();
        await using var built = new Server<string>(transport, new ServerOptions { Credentials = InteropCredentials.Of(TimeProvider.System) });
        await using var caller = new MemoryTransportClient();
        var router = new RouterClient(caller, new RouterClientOptions { Credential = Credential.Elsewhere(Carried) });
        await using var linked = new ServiceLink.LinkedClient(router);

        InteropHandlers.Offer(built);
        await transport.Start();
        await caller.Connect(new MemoryTransportClientConnectOptions { Server = transport, CancellationToken = Cancelled });

        var whoami = await new InteropClient(linked).Whoami(JsonSerializer.SerializeToElement<object?>(null))().WaitAsync(Patience, Cancelled);

        Assert.Equal("ada", whoami.GetString());
    }

    [Fact]
    public async Task Tells_the_other_end_of_a_close_in_a_later_turn_the_closer_s_clean()
    {
        var scheduler = new SerialScheduler();
        var (server, client, connectionHandle) = await Connected(scheduler);
        var atServer = Channel.CreateUnbounded<string>();
        var atClient = new List<string>();

        await using (server)
        await using (client)
        {
            server.Message += (message, _) =>
            {
                atServer.Writer.TryWrite($"heard {message.Bytes.Span[0]}");
            };
            server.Close += (isClean, handle) =>
            {
                atServer.Writer.TryWrite($"closed {isClean} {handle == connectionHandle} within {IsWithin.Value}");
            };
            client.Close += (isClean, isQuick) =>
            {
                atClient.Add($"closed {isClean} {isQuick} within {IsWithin.Value}");
            };

            // the client closes: its own close in its call, clean as told; its server's in a later
            // turn, after what it sent before, clean as the closer's
            await client.Send(new TransportMessage(new byte[] { 1 }, false));
            await Within(() =>
            {
                return client.CloseConnection();
            });
            Assert.Equal(["closed True False within True"], atClient);
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
            atServer.Writer.TryWrite("settled");

            Assert.Equal(["heard 1", "closed True True within False", "settled"], await TakeAll(atServer, 3));
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Empty(server.ConnectionHandles);
        }

        // the server closes: its own close in a turn of its own, clean; its client's in a later
        // turn, after what it sent before, unclean, as a close of the peer's
        var other = new SerialScheduler();
        var (closing, closed, handle) = await Connected(other);
        var heard = Channel.CreateUnbounded<string>();

        await using (closing)
        await using (closed)
        {
            closing.Close += (isClean, _) =>
            {
                heard.Writer.TryWrite($"server closed {isClean} within {IsWithin.Value}");
            };
            closed.Message += (message) =>
            {
                heard.Writer.TryWrite($"client heard {message.Bytes.Span[0]}");
            };
            closed.Close += (isClean, isQuick) =>
            {
                heard.Writer.TryWrite($"client closed {isClean} {isQuick} within {IsWithin.Value}");
            };

            await closing.Send(new TransportMessage(new byte[] { 2 }, false), handle);

            Assert.True(await Within(() =>
            {
                return closing.CloseConnection(handle);
            }));
            await other.WhenIdle().WaitAsync(Patience, Cancelled);
            heard.Writer.TryWrite("settled");

            Assert.Equal(
                ["client heard 2", "server closed True within False", "client closed False False within False", "settled"],
                await TakeAll(heard, 4));
            Assert.Equal(ReadyState.Closed, closed.ReadyState);
            Assert.False(await closing.CloseConnection(handle));
        }

        // a close told unclean is told so at its server
        var third = new SerialScheduler();
        var (told, unclean, uncleanHandle) = await Connected(third);
        var atTold = Channel.CreateUnbounded<string>();
        var atUnclean = new List<string>();

        await using (told)
        await using (unclean)
        {
            // ! each end heard apart: the server's close is told on its scheduler's thread, which
            // may run before the closer's call has told its own
            told.Close += (isClean, connectionHandle) =>
            {
                atTold.Writer.TryWrite($"closed {isClean} {connectionHandle == uncleanHandle}");
            };
            unclean.Close += (isClean, isQuick) =>
            {
                atUnclean.Add($"closed {isClean} {isQuick}");
            };

            await unclean.CloseConnection(new TransportClientDisconnectOptions { IsClean = false });
            Assert.Equal(["closed False False"], atUnclean);
            await third.WhenIdle().WaitAsync(Patience, Cancelled);
            atTold.Writer.TryWrite("settled");

            Assert.Equal(["closed False True", "settled"], await TakeAll(atTold, 2));
        }
    }

    [Fact]
    public async Task Refuses_a_send_or_a_disconnect_unless_open_and_a_send_of_what_is_no_bytes()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();

        // * never connected: nothing to send on, nor to close
        foreach (var refused in new[]
        {
            await Assert.ThrowsAsync<ReadyStateException>(() =>
            {
                return client.Send(new TransportMessage(new byte[] { 1 }, false));
            }),
            await Assert.ThrowsAsync<ReadyStateException>(() =>
            {
                return client.CloseConnection();
            }),
        })
        {
            Assert.Equal((ReadyState.Uninitialized, ReadyState.Open, "the transport client is uninitialized, not open"), (refused.Got, refused.Expected, refused.Message));
        }

        // open: a text message refused before it goes, the connection kept
        server.Message += (message, _) =>
        {
            heard.Add(Convert.ToHexString(message.Bytes.Span));
        };
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

        Assert.StartsWith("an in-memory connection carries envelopes, as bytes", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Send(new TransportMessage("text"u8.ToArray(), true));
        })).Message, StringComparison.Ordinal);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Empty(heard);
        Assert.Equal(ReadyState.Open, client.ReadyState);

        // * closed: a send fails as a disconnection, a disconnect by its state (debugging 9.7)
        await client.CloseConnection();
        Assert.Equal("the transport client is closed, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Send(new TransportMessage(new byte[] { 1 }, false));
        })).Message);

        var closed = await Assert.ThrowsAsync<ReadyStateException>(() =>
        {
            return client.CloseConnection();
        });

        Assert.Equal((ReadyState.Closed, "the transport client is closed, not open"), (closed.Got, closed.Message));
    }

    // debugging 9.7
    [Fact]
    public async Task Refuses_a_send_by_its_ready_state_before_the_open_and_as_a_disconnection_after_it_in_each_state_it_holds()
    {
        // * a server that holds each connect until the test lets it go, or its token ends it
        var held = Channel.CreateUnbounded<TaskCompletionSource>();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Accepting = async (token) =>
            {
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

                held.Writer.TryWrite(release);
                await release.Task.WaitAsync(token);
            },
        });
        await using var client = new MemoryTransportClient();
        var refusals = new List<string>();

        await server.Start();

        // never connected
        refusals.Add(await SendRefusals.Of(client));

        // connecting, its server not yet accepting
        var connecting = client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        var accept = await held.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);

        refusals.Add(await SendRefusals.Of(client));
        accept.SetResult();
        await connecting.WaitAsync(Patience, Cancelled);

        // open, the send going
        refusals.Add(await SendRefusals.Of(client));

        // closing left out: its close is closing and closed within one call
        await client.CloseConnection();
        refusals.Add(await SendRefusals.Of(client));

        // reconnecting, its attempt held by its server, then ended by its token
        using var ending = new CancellationTokenSource();
        var reconnecting = client.Reconnect(new TransportClientReconnectOptions { CancellationToken = ending.Token });

        await held.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled);
        refusals.Add(await SendRefusals.Of(client));
        await ending.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return reconnecting.WaitAsync(Patience, Cancelled);
        });

        // closed by a connect that started and failed: its server not started
        await using var unstarted = new MemoryTransportServer();
        await using var failed = new MemoryTransportClient();

        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return failed.Connect(new MemoryTransportClientConnectOptions { Server = unstarted, CancellationToken = Cancelled });
        });
        refusals.Add(await SendRefusals.Of(failed));

        Assert.Equal(
            [
                "ReadyStateException Uninitialized: the transport client is uninitialized, not open",
                "ReadyStateException Connecting: the transport client is connecting, not open",
                "sent",
                "DisconnectException: the transport client is closed, not open",
                "DisconnectException: the transport client is reconnecting, not open",
                "DisconnectException: the transport client is closed, not open",
            ],
            refusals);
    }

    [Fact]
    public async Task Refuses_a_reconnect_never_connected_and_a_connect_unless_closed_nothing_changed()
    {
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient();

        // * never connected: nothing to connect again to
        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);

        // a token cancelled already, and a server not started: refused, the first leaving its state as it was
        using var cancelled = new CancellationTokenSource();

        await cancelled.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
        Assert.Equal("the in-memory transport server is uninitialized, not open", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        })).Message);
        Assert.Equal(ReadyState.Closed, client.ReadyState);

        // open: a second connect refused, and a reconnection whose token is cancelled already leaves it open
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        Assert.Equal("the transport client is already open", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        })).Message);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(server.ConnectionHandles);
    }

    // spec 1.4
    [Fact]
    public async Task Refuses_a_fixed_delay_out_of_bounds_as_reconnect_is_called_nothing_changed()
    {
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient();
        var told = new ConcurrentQueue<string>();

        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            told.Enqueue("reconnect");
        };
        client.Close += (_, _) =>
        {
            told.Enqueue("close");
        };

        // * refused as it is called: after its state's guards, before its token
        foreach (var (delay, written) in new[]
        {
            (TimeSpan.FromTicks(4_000), "0.4"),
            (TimeSpan.FromMilliseconds(2_147_483_648), "2147483648"),
            (Timeout.InfiniteTimeSpan, "infinite"),
        })
        {
            var refused = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            {
                return client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(delay), CancellationToken = new CancellationToken(true) });
            });

            Assert.Equal($"a delay is 0 for at once, or a number of milliseconds from 1 to 2147483647, not {written} (Parameter 'Delay')", refused.Message);
        }

        // nothing changed: open, its connection kept, no reconnect told and no close
        Assert.Equal((ReadyState.Open, 1), (client.ReadyState, server.ConnectionHandles.Count));
        Assert.Empty(told);

        // its state's guards first: a client never connected says so
        await using var never = new MemoryTransportClient();

        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return never.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(Timeout.InfiniteTimeSpan) });
        })).Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Refuses_a_second_connect_or_reconnect_while_one_is_pending(bool isReconnect)
    {
        var scheduler = new SerialScheduler();
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var isHolding = !isReconnect;
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Scheduler = scheduler,
            Accepting = async (token) =>
            {
                if (isHolding)
                {
                    held.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
            },
        });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var drawn = new List<string>();
        var clientCloses = new List<(bool, bool)>();
        var serverCloses = new List<bool>();
        var errors = new List<Exception>();
        var starts = 0;

        server.Connection += drawn.Add;
        server.Close += (isClean, _) =>
        {
            serverCloses.Add(isClean);
        };
        server.Error += (error, _) =>
        {
            errors.Add(error);
        };
        client.Close += (isClean, isQuick) =>
        {
            clientCloses.Add((isClean, isQuick));
        };
        client.Error += errors.Add;
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            starts += 1;
        };
        await server.Start();

        if (isReconnect)
        {
            await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
            isHolding = true;
        }

        var pending = isReconnect
            ? client.Reconnect(new TransportClientReconnectOptions { MaximumAttempts = 1, CancellationToken = Cancelled })
            : client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

        try
        {
            await held.Task.WaitAsync(Patience, Cancelled);
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

            var state = isReconnect ? "reconnecting" : "connecting";

            Assert.Equal($"the transport client is already {state}", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
            })).Message);
            Assert.Equal(isReconnect ? "the transport client is already reconnecting" : "the transport client cannot reconnect while connecting", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return client.Reconnect();
            })).Message);
            Assert.Equal(isReconnect ? ReadyState.Reconnecting : ReadyState.Connecting, client.ReadyState);
            Assert.False(pending.IsCompleted);
            Assert.Equal(isReconnect ? 1 : 0, starts);
            Assert.Equal(isReconnect ? 1 : 0, drawn.Count);
            Assert.Empty(server.ConnectionHandles);
            Assert.Empty(clientCloses);
            Assert.Equal<bool>(isReconnect ? [false] : [], serverCloses);
            Assert.Empty(errors);
        }
        finally
        {
            release.TrySetResult();
            await pending.WaitAsync(Patience, Cancelled);
        }

        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(server.ConnectionHandles);
        Assert.Equal(isReconnect ? 2 : 1, drawn.Count);
        Assert.Empty(clientCloses);
        await client.CloseConnection();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.ConnectionHandles);
        Assert.Equal([(true, false)], clientCloses);
        Assert.Equal<bool>(isReconnect ? [false, true] : [true], serverCloses);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Reconnects_with_its_last_connect_s_options_replacing_its_connection_without_a_close()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var drawn = new List<string>();
        var closedAtServer = new List<string>();
        var closedAtClient = new List<string>();
        var reported = new List<string>();
        var starts = 0;

        server.Connection += drawn.Add;
        server.Close += (isClean, handle) =>
        {
            closedAtServer.Add($"{handle} {isClean}");
        };
        client.Close += (isClean, isQuick) =>
        {
            closedAtClient.Add($"{isClean} {isQuick}");
        };
        client.Error += (reason) =>
        {
            reported.Add(reason.Message);
        };

        // * each listener of its start told, the one that throws reported, and the reconnection goes on
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            starts += 1;
        };
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            throw new InvalidOperationException("a listener broke");
        };

        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "10.0.0.1", Port = 4_000, CancellationToken = Cancelled });
        await client.Reconnect(new TransportClientReconnectOptions { CancellationToken = Cancelled });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(["type=MEMORY;ip=10.0.0.1;ordinal=1", "type=MEMORY;ip=10.0.0.1;ordinal=2"], drawn);
        Assert.Equal(["type=MEMORY;ip=10.0.0.1;ordinal=1 False"], closedAtServer);
        Assert.Empty(closedAtClient);
        Assert.Equal(1, starts);
        Assert.Equal(["a listener broke"], reported);

        // its server gone: each attempt refused, until they run out, Closed with no close of its own
        await server.Stop();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Equal(["False False"], closedAtClient);

        var gaveUp = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { MaximumAttempts = 1, CancellationToken = Cancelled });
        });

        Assert.IsType<ConnectException>(gaveUp.InnerException);
        Assert.Equal((ReadyState.Closed, 1), (client.ReadyState, closedAtClient.Count));
    }

    [Fact]
    public async Task Cancels_a_reconnection_before_its_first_attempt_when_its_start_listener_cancels()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var drawn = new List<string>();
        var clientCloses = new List<(bool, bool)>();
        var serverCloses = new List<(bool, string)>();
        var errors = new List<Exception>();
        var starts = 0;

        server.Connection += drawn.Add;
        server.Close += (isClean, connectionHandle) =>
        {
            serverCloses.Add((isClean, connectionHandle));
        };
        server.Error += (error, _) =>
        {
            errors.Add(error);
        };
        client.Close += (isClean, isQuick) =>
        {
            clientCloses.Add((isClean, isQuick));
        };
        client.Error += errors.Add;
        ((IRouterClientTransport)client).Reconnect += cancelling.Cancel;
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            starts += 1;
        };

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { MaximumAttempts = 1, CancellationToken = cancelling.Token });
        });

        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        Assert.Equal("the reconnection was cancelled", cancelled.Message);
        Assert.Equal(cancelling.Token, cancelled.CancellationToken);
        Assert.Equal(1, starts);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.ConnectionHandles);
        Assert.Empty(drawn);
        Assert.Empty(clientCloses);
        Assert.Equal([(false, handle)], serverCloses);
        Assert.Empty(errors);
    }

    [Fact]
    public async Task Closes_what_its_last_attempt_opened_as_its_reconnection_was_cancelled()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var closedAtClient = new List<string>();
        var closedAtServer = new List<bool>();

        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        client.Close += (isClean, isQuick) =>
        {
            closedAtClient.Add($"{isClean} {isQuick}");
        };
        server.Close += (isClean, _) =>
        {
            closedAtServer.Add(isClean);
        };

        // * the reconnection cancelled in the very turn its server draws the connection: the
        // cancel holds until its attempt's connect settles, which fails, what was drawn closed
        // unclean and no close told here
        server.Connection += (_) =>
        {
            cancelling.Cancel();
        };

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { CancellationToken = cancelling.Token });
        });

        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal("the reconnection was cancelled", cancelled.Message);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(closedAtClient);
        Assert.Equal([false, false], closedAtServer);
        Assert.Empty(server.ConnectionHandles);
    }

    [Fact]
    public async Task Closes_a_successful_last_attempt_when_its_reconnection_is_cancelled_after_it_opens()
    {
        foreach (var closedBeforeCancel in new[] { false, true })
        {
            var scheduler = new SerialScheduler();
            var clock = new CompletingClock();
            await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
            await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock, Scheduler = scheduler });
            using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
            var closedAtClient = new List<(bool IsClean, bool IsQuick)>();
            var closedAtServer = new List<bool>();
            var errors = new List<Exception>();
            var opened = 0;

            await server.Start();
            await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
            client.Close += (isClean, isQuick) =>
            {
                closedAtClient.Add((isClean, isQuick));
            };
            server.Close += (isClean, _) =>
            {
                closedAtServer.Add(isClean);
            };
            client.Error += errors.Add;
            server.Error += (reason, _) =>
            {
                errors.Add(reason);
            };

            // ! the attempt disposes its timeout after publishing Open, before it returns to Reconnect
            clock.OnTimerDisposed = () =>
            {
                Assert.Equal(ReadyState.Open, client.ReadyState);
                opened += 1;

                if (closedBeforeCancel)
                {
                    Assert.True(client.CloseConnection().IsCompletedSuccessfully);
                }

                cancelling.Cancel();
            };
            var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return client.Reconnect(new TransportClientReconnectOptions { CancellationToken = cancelling.Token, MaximumAttempts = 1 });
            });
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

            Assert.Equal("the reconnection was cancelled", cancelled.Message);
            Assert.Equal(cancelling.Token, cancelled.CancellationToken);
            Assert.Equal(1, opened);
            Assert.Equal(ReadyState.Closed, client.ReadyState);
            Assert.Equal([(true, false)], closedAtClient);
            Assert.Equal([false, true], closedAtServer);
            Assert.Empty(server.ConnectionHandles);
            Assert.Empty(errors);
        }
    }

    // spec 15.15
    [Fact]
    public async Task Gives_up_a_connect_its_dispose_its_token_or_its_clock_ends_before_its_server_drew_it()
    {
        var clock = new FakeTimeProvider();
        var held = 0;
        // whether each connect its server held was told it was given up, in the order they came
        var givenUp = new List<bool>();

        // * a server that holds each connect until its token is cancelled, as a peer that never answers
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Accepting = async (token) =>
            {
                Interlocked.Increment(ref held);

                try
                {
                    await Task.Delay(System.Threading.Timeout.InfiniteTimeSpan, TimeProvider.System, token);
                }
                finally
                {
                    lock (givenUp)
                    {
                        givenUp.Add(token.IsCancellationRequested);
                    }
                }
            },
        });

        await server.Start();

        async Task Holding(Func<Task> connect, int count)
        {
            var since = TimeProvider.System.GetTimestamp();

            while (Volatile.Read(ref held) < count)
            {
                Assert.True(TimeProvider.System.GetElapsedTime(since) < Patience, "the connect was never held");
                await Task.Delay(TimeSpan.FromMilliseconds(5), TimeProvider.System, Cancelled);
            }

            await connect();
        }

        // its clock past its timeout
        await using var timed = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        var timing = timed.Connect(new MemoryTransportClientConnectOptions { Server = server, Timeout = TimeSpan.FromSeconds(1), CancellationToken = Cancelled });

        await Holding(
            () =>
            {
                clock.Advance(TimeSpan.FromSeconds(1));

                return Task.CompletedTask;
            },
            1);
        Assert.Equal("timed out after 1000ms", (await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return timing;
        })).Message);
        Assert.Equal(ReadyState.Closed, timed.ReadyState);

        // its token cancelled
        await using var asked = new MemoryTransportClient();
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var asking = asked.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = cancelling.Token });

        await Holding(
            () =>
            {
                return cancelling.CancelAsync();
            },
            2);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asking;
        });
        Assert.Equal(ReadyState.Closed, asked.ReadyState);

        // its dispose
        var disposed = new MemoryTransportClient();
        var disposing = disposed.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });

        await Holding(
            () =>
            {
                return disposed.DisposeAsync().AsTask();
            },
            3);
        Assert.StartsWith("the transport client was disposed as it connected: ", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return disposing;
        })).Message, StringComparison.Ordinal);
        Assert.Equal(ReadyState.Closed, disposed.ReadyState);
        Assert.Empty(server.ConnectionHandles);

        // each connect its server held told it was given up, so none is drawn for it
        lock (givenUp)
        {
            Assert.Equal([true, true, true], givenUp);
        }
    }

    [Fact]
    public async Task Hears_what_its_server_sent_before_the_connection_opened_once_it_has_in_its_order()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();

        // * sent in the turn its server draws it, before its client opened: heard once it has, in order
        server.Connection += (handle) =>
        {
            _ = server.Send(new TransportMessage(new byte[] { 1 }, false), handle);
            _ = server.Send(new TransportMessage(new byte[] { 2 }, false), handle);
        };
        client.Message += (message) =>
        {
            heard.Add($"heard {message.Bytes.Span[0]}");
        };

        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(["heard 1", "heard 2"], heard);
        Assert.Equal(ReadyState.Open, client.ReadyState);

        // the TypeScript side plays it too through a server of the test's own, which hands what it
        // sent before it accepts; a C# client connects to a MemoryTransportServer alone
    }

    // spec 15.15
    [Fact]
    public async Task Fails_a_connect_its_server_closed_as_it_opened_what_it_sent_before_unheard()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();

        // * sent and closed in the turn its server draws it, before its client opened
        server.Connection += (handle) =>
        {
            _ = server.Send(new TransportMessage(new byte[] { 1 }, false), handle);
            _ = server.CloseConnection(handle);
        };
        client.Message += (message) =>
        {
            heard.Add($"heard {message.Bytes.Span[0]}");
        };
        client.Close += (isClean, isQuick) =>
        {
            heard.Add($"closed {isClean} {isQuick}");
        };
        await server.Start();

        Assert.Equal("the in-memory transport server closed the connection as it opened", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        })).Message);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Empty(heard);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.ConnectionHandles);
    }

    // spec 15.15
    [Fact]
    public async Task Closes_at_once_unclean_a_connection_its_server_draws_once_a_dispose_gave_up_on_its_connect()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var heard = new List<string>();
        var closedAtServer = new List<bool>();

        // * its dispose in the turn its server draws the connection, before its client opened; what
        // its server sends after goes unheard
        server.Connection += (handle) =>
        {
            _ = client.DisposeAsync().AsTask();
            _ = server.Send(new TransportMessage(new byte[] { 1 }, false), handle);
        };
        server.Close += (isClean, _) =>
        {
            closedAtServer.Add(isClean);
        };
        client.Message += (message) =>
        {
            heard.Add($"heard {message.Bytes.Span[0]}");
        };
        await server.Start();

        Assert.Equal("the transport client was disposed as it connected", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        })).Message);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Equal([false], closedAtServer);
        Assert.Empty(heard);
        Assert.Empty(server.ConnectionHandles);
    }

    [Fact]
    public async Task Hears_nothing_once_it_let_go_of_its_connection_and_tells_one_close_at_each_end()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        var heard = new List<string>();
        var closedAtClient = new List<string>();
        var closedAtServer = new List<string>();

        await using (server)
        await using (client)
        {
            server.Close += (isClean, _) =>
            {
                closedAtServer.Add($"{isClean}");
            };
            client.Message += (message) =>
            {
                heard.Add($"heard {message.Bytes.Span[0]}");
            };
            client.Close += (isClean, isQuick) =>
            {
                closedAtClient.Add($"{isClean} {isQuick}");
            };

            // * its server sends and ends it as its client closes it, every turn held behind a gate:
            // none of it heard, one close told at each end
            using var gate = new ManualResetEventSlim();

            scheduler.Post(() =>
            {
                gate.Wait(Patience);
            });
            await server.Send(new TransportMessage(new byte[] { 8 }, false), handle);

            var ending = server.CloseConnection(handle);

            await client.CloseConnection();
            gate.Set();
            Assert.True(await ending.WaitAsync(Patience, Cancelled));
            await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

            Assert.Empty(heard);
            Assert.Equal(["True False"], closedAtClient);
            Assert.Equal(["True"], closedAtServer);
        }
    }

    // a timeout's release, at a connect's return, is a deterministic seam after it publishes Open
    private sealed class CompletingClock : TimeProvider
    {
        public Action? OnTimerDisposed { get; set; }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            return new CompletingTimer(TimeProvider.System.CreateTimer(callback, state, dueTime, period), this);
        }

        private sealed class CompletingTimer(ITimer timer, CompletingClock clock) : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                return timer.Change(dueTime, period);
            }

            public void Dispose()
            {
                timer.Dispose();
                var completing = clock.OnTimerDisposed;

                clock.OnTimerDisposed = null;
                completing?.Invoke();
            }

            public ValueTask DisposeAsync()
            {
                Dispose();

                return ValueTask.CompletedTask;
            }
        }
    }

    // the next count messages told, in order, within a patience
    private static async Task<List<string>> TakeAll(Channel<string> told, int count)
    {
        var taken = new List<string>();

        while (taken.Count < count)
        {
            taken.Add(await told.Reader.ReadAsync(Cancelled).AsTask().WaitAsync(Patience, Cancelled));
        }

        return taken;
    }
    [Fact]
    public async Task Starts_uninitialized_with_no_protocol()
    {
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient();

        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
        Assert.Empty(server.Clients);
        Assert.Equal("the transport client was never connected", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        })).Message);
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
    }

    [Fact]
    public async Task Connect_with_a_signal_already_aborted_rejects_with_a_cancel_error_never_reaching_the_transport()
    {
        var attempts = 0;
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions
        {
            Accepting = (_) =>
            {
                Interlocked.Increment(ref attempts);
                return Task.CompletedTask;
            },
        });
        await using var client = new MemoryTransportClient();
        using var cancelling = new CancellationTokenSource();

        await cancelling.CancelAsync();
        await server.Start();
        var refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = cancelling.Token });
        });

        Assert.Equal(cancelling.Token, refused.CancellationToken);
        Assert.Equal(0, Volatile.Read(ref attempts));
        Assert.Empty(server.Clients);
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
    }

    [Fact]
    public async Task Rejects_with_a_reconnect_error_carrying_the_last_failure_as_cause_ending_closed()
    {
        var scheduler = new SerialScheduler();
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock, Scheduler = scheduler });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });

        var taps = new ConcurrentQueue<(TimeSpan, int)>();
        var pending = client.Reconnect(new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromSeconds(1)),
            MaximumAttempts = 2,
            CancellationToken = Cancelled,
            Tap = (delay, attempt) =>
            {
                taps.Enqueue((delay, attempt));
            },
        });

        Assert.Equal(ReadyState.Reconnecting, client.ReadyState);
        Assert.Equal([TimeSpan.FromSeconds(1)], await clock.UntilArmed(TimeSpan.FromSeconds(1), Patience));
        await clock.Advance(TimeSpan.FromSeconds(1));
        var refused = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return pending.WaitAsync(Patience, Cancelled);
        });

        Assert.IsType<ConnectException>(refused.InnerException);
        Assert.Equal([(TimeSpan.FromSeconds(1), 1)], taps);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Does_not_keep_the_signal_of_a_connect_for_its_reconnections()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        using var cancelling = new CancellationTokenSource();
        var drawn = new List<string>();

        server.Connection += drawn.Add;
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = cancelling.Token });
        await cancelling.CancelAsync();
        await client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.Zero), CancellationToken = Cancelled });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(["type=MEMORY;ip=local;ordinal=1", "type=MEMORY;ip=local;ordinal=2"], drawn);
        Assert.Single(server.Clients);
    }

    [Fact]
    public async Task Connect_on_an_open_client_rejects_without_reaching_the_transport()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var drawn = new List<string>();

        server.Connection += drawn.Add;
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "h", Port = 1, CancellationToken = Cancelled });
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "h", Port = 2, CancellationToken = Cancelled });
        });

        Assert.Equal("the transport client is already open", refused.Message);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(["type=MEMORY;ip=h;ordinal=1"], drawn);
        Assert.Equal(1, Assert.Single(server.Clients).Port);
    }

    [Fact]
    public async Task Reuses_the_options_of_the_last_accepted_connect_disposing_an_open_protocol_first()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var told = new List<string>();

        server.Connection += (handle) =>
        {
            told.Add($"connection {handle}");
        };
        server.Close += (clean, handle) =>
        {
            told.Add($"closed {handle} {clean}");
        };
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "h", Port = 7, CancellationToken = Cancelled });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, Address = "h", Port = 8, CancellationToken = Cancelled });
        });
        await client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.Zero), CancellationToken = Cancelled });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(["connection type=MEMORY;ip=h;ordinal=1", "closed type=MEMORY;ip=h;ordinal=1 False", "connection type=MEMORY;ip=h;ordinal=2"], told);
        Assert.Equal(7, Assert.Single(server.Clients).Port);
    }

    [Fact]
    public async Task Emits_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        var starts = 0;

        ((IRouterClientTransport)client).Reconnect += () =>
        {
            starts += 1;
        };
        await server.Start();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        });
        Assert.Equal(0, starts);
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await client.Reconnect(new TransportClientReconnectOptions { CancellationToken = Cancelled });
        await client.CloseConnection();
        await client.Reconnect(new TransportClientReconnectOptions { CancellationToken = Cancelled });

        Assert.Equal(2, starts);
        Assert.Equal(ReadyState.Open, client.ReadyState);
    }

    [Fact]
    public async Task Rejects_with_a_programmer_error_when_the_transport_was_never_connected()
    {
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient();
        await server.Start();
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        });

        Assert.Equal("the transport client was never connected", refused.Message);
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
        Assert.Empty(server.Clients);
    }

    [Fact]
    public async Task Calls_each_listener_though_one_throws_reporting_a_client_s_throw_with_no_connection()
    {
        var scheduler = new SerialScheduler();
        var (server, client, _) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        var thrown = new InvalidOperationException("a listener that throws");
        var told = new List<string>();
        var reported = new List<Exception>();

        client.Close += (_, _) =>
        {
            throw thrown;
        };
        client.Close += (clean, quick) =>
        {
            told.Add($"closed {clean} {quick}");
        };
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            throw thrown;
        };
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            told.Add("reconnect");
        };
        client.Error += reported.Add;

        await client.CloseConnection();
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);
        await client.Reconnect(new TransportClientReconnectOptions { CancellationToken = Cancelled });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(["closed True False", "reconnect"], told);
        Assert.Equal(2, reported.Count);
        Assert.All(reported, (reason) =>
        {
            Assert.Same(thrown, reason);
        });
    }

    [Fact]
    public async Task Passes_on_what_tap_throws_ending_closed_with_no_attempt_after_it_and_no_wait_left_armed()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var thrown = new InvalidOperationException("tap_error");
        var taps = 0;
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.FromMilliseconds(10)),
                CancellationToken = Cancelled,
                Tap = (_, attempt) =>
                {
                    taps += 1;
                    Assert.Equal(1, attempt);
                    throw thrown;
                },
            });
        });

        Assert.Same(thrown, refused);
        Assert.Equal(1, taps);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
        await clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1, taps);
    }

    [Fact]
    public async Task Rejects_with_a_cancel_error_without_waiting_out_the_delay_when_the_signal_aborts_mid_wait()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var before = clock.GetTimestamp();
        var pending = client.Reconnect(new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromMinutes(1)),
            CancellationToken = cancelling.Token,
        });

        Assert.Equal([TimeSpan.FromMinutes(1)], await clock.UntilArmed(TimeSpan.FromMinutes(1), Patience));
        await cancelling.CancelAsync();
        var refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return pending.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the reconnection was cancelled", refused.Message);
        Assert.Equal(cancelling.Token, refused.CancellationToken);
        Assert.Equal(before, clock.GetTimestamp());
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Waits_its_delay_after_each_failed_attempt_on_the_clock_its_transport_runs_on_connecting_once_per_attempt()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await using var defaulted = new MemoryTransportClient();
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var tapped = new TaskCompletionSource<(TimeSpan, int)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = client.Reconnect(new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromMilliseconds(60)),
            CancellationToken = Cancelled,
            Tap = (delay, attempt) =>
            {
                Assert.True(tapped.TrySetResult((delay, attempt)), "one failed attempt before the server starts");
            },
        });

        Assert.Equal((TimeSpan.FromMilliseconds(60), 1), await tapped.Task.WaitAsync(Patience, Cancelled));
        Assert.Equal([TimeSpan.FromMilliseconds(60)], clock.Dues());
        await clock.Advance(TimeSpan.FromMilliseconds(59));
        Assert.Equal(ReadyState.Reconnecting, client.ReadyState);
        Assert.False(pending.IsCompleted);
        Assert.Equal([TimeSpan.FromMilliseconds(1)], clock.Dues());
        await server.Start();
        await clock.Advance(TimeSpan.FromMilliseconds(1));
        await pending.WaitAsync(Patience, Cancelled);

        Assert.Same(clock, client.Clock);
        Assert.Same(TimeProvider.System, defaulted.Clock);
        Assert.Single(server.Clients);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Arms_its_wait_before_tap_hears_it_so_a_tap_that_moves_the_clock_by_the_wait_lets_the_next_attempt_follow_with_no_other_move()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var taps = 0;
        Task? opening = null;
        Task? advancing = null;

        await client.Reconnect(new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromMilliseconds(60)),
            CancellationToken = Cancelled,
            Tap = (delay, attempt) =>
            {
                taps += 1;
                Assert.Equal((TimeSpan.FromMilliseconds(60), 1), (delay, attempt));
                Assert.Equal([delay], clock.Dues());
                opening = server.Start();
                advancing = clock.Advance(delay);
            },
        }).WaitAsync(Patience, Cancelled);
        await Assert.IsAssignableFrom<Task>(opening);
        await Assert.IsAssignableFrom<Task>(advancing);

        Assert.Equal(1, taps);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(server.Clients);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task The_drop_leaves_an_open_client_closed()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        await using var ownedServer = server;
        var told = new List<(bool, string)>();

        server.Close += (clean, connection) =>
        {
            told.Add((clean, connection));
        };
        Assert.Equal(ReadyState.Open, client.ReadyState);
        // * the internal drop, which Rust's dispose and TypeScript's dispose symbol reach
        typeof(MemoryTransportClient).GetMethod("Drop", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(client, null);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Equal([(false, handle)], told);
        Assert.Empty(server.Clients);
    }

    [Fact]
    public async Task Rejects_with_a_programmer_error_when_already_reconnecting_and_leaves_the_first_one_alone()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var first = client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.FromMilliseconds(20)), CancellationToken = Cancelled });

        Assert.Equal([TimeSpan.FromMilliseconds(20)], await clock.UntilArmed(TimeSpan.FromMilliseconds(20), Patience));
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        });
        Assert.Equal("the transport client is already reconnecting", refused.Message);
        Assert.Equal(ReadyState.Reconnecting, client.ReadyState);
        Assert.False(first.IsCompleted);
        await server.Start();
        await clock.Advance(TimeSpan.FromMilliseconds(20));
        await first.WaitAsync(Patience, Cancelled);

        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(server.Clients);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Never_attempts_with_a_signal_already_aborted_and_stops_at_the_wait_when_tap_aborts()
    {
        var scheduler = new SerialScheduler();
        var (opened, client, handle) = await Connected(scheduler);
        await using var ownedServer = opened;
        await using var ownedClient = client;
        var refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { CancellationToken = new CancellationToken(true) });
        });
        Assert.Equal("the reconnection was cancelled", refused.Message);
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Equal(handle, Assert.Single(opened.Clients).ConnectionHandle);

        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var failing = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return failing.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var taps = 0;
        refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return failing.Reconnect(new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.FromMinutes(1)),
                CancellationToken = cancelling.Token,
                Tap = (_, attempt) =>
                {
                    taps += 1;
                    Assert.Equal(1, attempt);
                    cancelling.Cancel();
                },
            });
        });

        Assert.Equal("the reconnection was cancelled", refused.Message);
        Assert.Equal(cancelling.Token, refused.CancellationToken);
        Assert.Equal(1, taps);
        Assert.Equal(ReadyState.Closed, failing.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Connect_during_the_wait_rejects_with_a_programmer_error()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var first = client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.FromMinutes(1)), CancellationToken = cancelling.Token });

        Assert.Equal([TimeSpan.FromMinutes(1)], await clock.UntilArmed(TimeSpan.FromMinutes(1), Patience));
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        Assert.Equal("the transport client is already reconnecting", refused.Message);
        Assert.Equal(ReadyState.Reconnecting, client.ReadyState);
        await cancelling.CancelAsync();
        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return first.WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("the reconnection was cancelled", cancelled.Message);
        Assert.Equal(cancelling.Token, cancelled.CancellationToken);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
        Assert.Empty(server.Clients);
    }

    [Fact]
    public async Task Rejects_with_a_programmer_error_ending_closed_when_delay_throws()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var thrown = new InvalidOperationException("decay_error");
        var delays = 0;
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions
            {
                CancellationToken = Cancelled,
                Delay = new TransportClientReconnectDelay((_, attempt) =>
                {
                    delays += 1;
                    Assert.Equal(1, attempt);
                    throw thrown;
                }),
            });
        });

        Assert.Equal("decay_error", refused.Message);
        Assert.Same(thrown, refused.InnerException);
        Assert.Equal(1, delays);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task An_explicit_undefined_option_falls_back_to_its_default()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        var refused = await Assert.ThrowsAsync<ReconnectException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions
            {
                Delay = new TransportClientReconnectDelay(TimeSpan.Zero),
                MaximumAttempts = null,
                Tap = null,
                CancellationToken = default,
            }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal("attempt 5 reached", refused.Message);
        Assert.IsType<ConnectException>(refused.InnerException);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(clock.Dues());
    }

    [Fact]
    public async Task Aborts_the_attempt_in_flight_when_the_signal_aborts()
    {
        var scheduler = new SerialScheduler();
        await using var server = new MemoryTransportServer(new MemoryTransportServerOptions { Scheduler = scheduler });
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Scheduler = scheduler });
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });
        await server.Start();
        var drawn = 0;
        server.Connection += (_) =>
        {
            drawn += 1;
            cancelling.Cancel();
        };
        var refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.Zero), CancellationToken = cancelling.Token });
        });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal("the reconnection was cancelled", refused.Message);
        Assert.Equal(cancelling.Token, refused.CancellationToken);
        Assert.Equal(1, drawn);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.Clients);
    }

    [Fact]
    public async Task Tells_tap_the_wait_and_the_attempt_that_failed_and_nothing_when_the_first_one_succeeds()
    {
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        await using var server = new MemoryTransportServer();
        await using var client = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        var taps = new ConcurrentQueue<(TimeSpan, int)>();
        var tapped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var options = new TransportClientReconnectOptions
        {
            Delay = new TransportClientReconnectDelay(TimeSpan.FromMilliseconds(10)),
            CancellationToken = Cancelled,
            Tap = (delay, attempt) =>
            {
                taps.Enqueue((delay, attempt));
                tapped.TrySetResult();
            },
        };
        await server.Start();
        await client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        await client.Reconnect(options);
        Assert.Empty(taps);

        await using var failingServer = new MemoryTransportServer();
        await using var failing = new MemoryTransportClient(new MemoryTransportClientOptions { Clock = clock });
        await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return failing.Connect(new MemoryTransportClientConnectOptions { Server = failingServer, CancellationToken = Cancelled });
        });
        var pending = failing.Reconnect(options);
        await tapped.Task.WaitAsync(Patience, Cancelled);
        Assert.Equal([(TimeSpan.FromMilliseconds(10), 1)], taps);
        Assert.Equal([TimeSpan.FromMilliseconds(10)], clock.Dues());
        await failingServer.Start();
        await clock.Advance(TimeSpan.FromMilliseconds(10));
        await pending.WaitAsync(Patience, Cancelled);

        Assert.Equal([(TimeSpan.FromMilliseconds(10), 1)], taps);
        Assert.Equal(ReadyState.Open, failing.ReadyState);
        Assert.Single(failingServer.Clients);
    }

    // * the Rust unit fixture sets its state directly for these guards; neither runtime exposes
    // a closing memory connection across a turn
    private static void GivenState(MemoryTransportClient client, ReadyState state)
    {
        typeof(MemoryTransportClient).GetField("_readyState", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(client, state);
    }

    [Fact]
    public async Task Connect_while_closing_rejects_without_reaching_the_transport()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        GivenState(client, ReadyState.Closing);
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryTransportClientConnectOptions { Server = server, CancellationToken = Cancelled });
        });

        Assert.Equal("the transport client is already closing", refused.Message);
        Assert.Equal(ReadyState.Closing, client.ReadyState);
        Assert.Equal(handle, Assert.Single(server.Clients).ConnectionHandle);
    }

    [Fact]
    public async Task Rejects_with_a_programmer_error_while_connecting()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        GivenState(client, ReadyState.Connecting);
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        });

        Assert.Equal("the transport client cannot reconnect while connecting", refused.Message);
        Assert.Equal(ReadyState.Connecting, client.ReadyState);
        Assert.Equal(handle, Assert.Single(server.Clients).ConnectionHandle);
    }

    [Fact]
    public async Task Rejects_with_a_programmer_error_while_closing()
    {
        var scheduler = new SerialScheduler();
        var (server, client, handle) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        GivenState(client, ReadyState.Closing);
        var refused = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Reconnect();
        });

        Assert.Equal("the transport client cannot reconnect while closing", refused.Message);
        Assert.Equal(ReadyState.Closing, client.ReadyState);
        Assert.Equal(handle, Assert.Single(server.Clients).ConnectionHandle);
    }

    [Fact]
    public async Task Disconnects_and_rejects_with_a_cancel_error_when_the_signal_aborts_after_the_connect_resolved()
    {
        var scheduler = new SerialScheduler();
        var (server, client, first) = await Connected(scheduler);
        await using var ownedServer = server;
        await using var ownedClient = client;
        using var cancelling = CancellationTokenSource.CreateLinkedTokenSource(Cancelled);
        var atClient = new List<string>();
        var atServer = new List<string>();

        server.Connection += (handle) =>
        {
            atServer.Add($"connection {handle}");
            _ = server.Send(new TransportMessage(new byte[] { 1 }, false), handle);
        };
        server.Close += (clean, handle) =>
        {
            atServer.Add($"closed {handle} {clean}");
        };
        ((IRouterClientTransport)client).Reconnect += () =>
        {
            atClient.Add("reconnect");
        };
        client.Message += (message) =>
        {
            atClient.Add($"heard {Convert.ToHexString(message.Bytes.Span)}");
            cancelling.Cancel();
        };
        client.Close += (clean, quick) =>
        {
            atClient.Add($"closed {clean} {quick}");
        };
        var refused = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportClientReconnectOptions { Delay = new TransportClientReconnectDelay(TimeSpan.Zero), CancellationToken = cancelling.Token });
        });
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal("the reconnection was cancelled", refused.Message);
        Assert.Equal(cancelling.Token, refused.CancellationToken);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Equal(["reconnect", "heard 01", "closed True False"], atClient);
        Assert.Equal([$"closed {first} False", "connection type=MEMORY;ip=local;ordinal=2", "closed type=MEMORY;ip=local;ordinal=2 True"], atServer);
        Assert.Empty(server.Clients);
    }

}
