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
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        return (server, client, Assert.Single(connections));
    }

    // definition

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
        await caller.Connect(new MemoryConnectOptions { Server = transport }, Cancelled);

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

            await unclean.CloseConnection(new TransportDisconnectOptions { IsClean = false });
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
        Assert.Equal("the transport client is uninitialized, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.Send(new TransportMessage(new byte[] { 1 }, false));
        })).Message);
        Assert.Equal("the transport client is uninitialized, not open", (await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return client.CloseConnection();
        })).Message);

        // open: a text message refused before it goes, the connection kept
        server.Message += (message, _) =>
        {
            heard.Add(Convert.ToHexString(message.Bytes.Span));
        };
        await server.Start();
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

        Assert.StartsWith("an in-memory connection carries envelopes, as bytes", (await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return client.Send(new TransportMessage("text"u8.ToArray(), true));
        })).Message, StringComparison.Ordinal);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Empty(heard);
        Assert.Equal(ReadyState.Open, client.ReadyState);
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
            return client.Connect(new MemoryConnectOptions { Server = server }, cancelled.Token);
        });
        Assert.Equal(ReadyState.Uninitialized, client.ReadyState);
        Assert.Equal("the in-memory transport server is uninitialized, not open", (await Assert.ThrowsAsync<ConnectException>(() =>
        {
            return client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        })).Message);
        Assert.Equal(ReadyState.Closed, client.ReadyState);

        // open: a second connect refused, and a reconnection whose token is cancelled already leaves it open
        await server.Start();
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        Assert.Equal("the transport client is already open", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        })).Message);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return client.Reconnect(new TransportReconnectOptions { CancellationToken = cancelled.Token });
        });
        Assert.Equal(ReadyState.Open, client.ReadyState);
        Assert.Single(server.ConnectionHandles);
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
        await client.Connect(new MemoryConnectOptions { Server = server, Address = "10.0.0.1", Port = 4_000 }, Cancelled);
        await client.Reconnect(new TransportReconnectOptions { CancellationToken = Cancelled });
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
            return client.Reconnect(new TransportReconnectOptions { MaximumAttempts = 1, CancellationToken = Cancelled });
        });

        Assert.IsType<ConnectException>(gaveUp.InnerException);
        Assert.Equal((ReadyState.Closed, 1), (client.ReadyState, closedAtClient.Count));
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
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
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
            return client.Reconnect(new TransportReconnectOptions { CancellationToken = cancelling.Token });
        });

        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal("the reconnection was cancelled", cancelled.Message);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(closedAtClient);
        Assert.Equal([false, false], closedAtServer);
        Assert.Empty(server.ConnectionHandles);
    }

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
        var timing = timed.Connect(new MemoryConnectOptions { Server = server, Timeout = TimeSpan.FromSeconds(1) }, Cancelled);

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
        var asking = asked.Connect(new MemoryConnectOptions { Server = server }, cancelling.Token);

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
        var disposing = disposed.Connect(new MemoryConnectOptions { Server = server }, Cancelled);

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
        await client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Equal(["heard 1", "heard 2"], heard);
        Assert.Equal(ReadyState.Open, client.ReadyState);

        // the TypeScript side plays it too through a server of the test's own, which hands what it
        // sent before it accepts; a C# client connects to a MemoryTransportServer alone
    }

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
            return client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
        })).Message);
        await scheduler.WhenIdle().WaitAsync(Patience, Cancelled);

        Assert.Empty(heard);
        Assert.Equal(ReadyState.Closed, client.ReadyState);
        Assert.Empty(server.ConnectionHandles);
    }

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
            return client.Connect(new MemoryConnectOptions { Server = server }, Cancelled);
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
}
