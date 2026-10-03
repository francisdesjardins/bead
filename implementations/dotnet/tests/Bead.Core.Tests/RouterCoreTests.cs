using System.Text;
using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s requests, which the conversations, played from a client's bytes, do not
/// make: a client's core against a server of the interop service, linked in memory.
/// </summary>
public sealed partial class RouterCoreTests
{
    // constants

    private const string Handle = "server";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // helpers

    private static ReadOnlyMemory<byte> JsonOf(string text)
    {
        return Encoding.UTF8.GetBytes(text);
    }

    private static CoreRequest RequestOf(string procedureName, (TimeSpan Timeout, CancellationToken Token) options)
    {
        return new CoreRequest
        {
            ConnectionHandle = Handle,
            Procedure = InteropService.ProcedureOf(procedureName),
            Options = new ResolvedRequestOptions { Timeout = options.Timeout, CancellationToken = options.Token },
        };
    }

    private static CoreRequest RequestOf(string procedureName)
    {
        return RequestOf(procedureName, (TimeSpan.FromSeconds(5), CancellationToken.None));
    }

    // definition

    [Fact]
    public async Task Requests_and_resolves_with_the_result()
    {
        await using var link = new Link();

        var result = await link.Client.Request(JsonOf("{\"a\":1}"), RequestOf("echo")).WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal("{\"a\":1}", Encoding.UTF8.GetString(result.Payload.Span));
        Assert.Equal(1u, result.Header.CallId);
    }

    [Fact]
    public async Task Throws_the_failure_the_peer_answered_with_saying_it_raised_it()
    {
        await using var link = new Link();

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return link.Client.Request(JsonOf("null"), RequestOf("fail")).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(7, failure.Code);
        Assert.Equal(FailureScope.Application, failure.Scope);
        Assert.Equal(FailureOrigin.Peer, failure.Origin);
        Assert.Equal(RouterSide.Server, failure.Side);
        Assert.Equal(InteropService.ProcedureOf("fail").Address, failure.ProcedureAddress);
        Assert.Equal("server application failure 7 (service 1, procedure 2): this procedure fails, on purpose", failure.Message);
    }

    [Fact]
    public async Task Times_out_cancels_its_call_and_reserves_its_call_id_as_long_as_it_was_given()
    {
        var time = new FakeTimeProvider();

        await using var link = new Link(new RouterCoreOptions { LastCallId = 3, Clock = time });

        var sent = new TaskCompletionSource();
        var slow = link.Client.Request(
            JsonOf("{\"milliseconds\":3600000}"),
            RequestOf("slow", (TimeSpan.FromSeconds(1), CancellationToken.None)) with
            {
                OnCallId = (callId) =>
                {
                    link.CallIds.Add(callId);
                },
                OnSent = (_) =>
                {
                    sent.TrySetResult();
                },
            });

        await sent.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        time.Advance(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return slow.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await link.Settle();

        // the cancel reached the server, and 1 is skipped while it is reserved
        Assert.Equal("1", await link.Ask("cancellations"));
        await link.Ask("echo");
        Assert.Equal([1u, 3u, 3u], link.CallIds);
        time.Advance(TimeSpan.FromSeconds(1));
        await link.Ask("echo");
        Assert.Equal([1u, 3u, 3u, 1u], link.CallIds);
    }

    [Fact]
    public async Task Cancels_its_call_once_its_token_is_cancelled_after_it_went_out()
    {
        await using var link = new Link();
        using var source = new CancellationTokenSource();

        var sent = new TaskCompletionSource();
        var slow = link.Client.Request(
            JsonOf("{\"milliseconds\":3600000}"),
            RequestOf("slow", (TimeSpan.FromSeconds(5), source.Token)) with
            {
                OnSent = (_) =>
                {
                    sent.TrySetResult();
                },
            });

        await sent.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return slow.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await link.Settle();
        Assert.Equal("1", await link.Ask("cancellations"));
    }

    [Fact]
    public async Task Draws_nothing_for_a_token_cancelled_already()
    {
        await using var link = new Link();

        var drawn = false;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return link.Client.Request(
                JsonOf("null"),
                RequestOf("echo", (TimeSpan.FromSeconds(5), new CancellationToken(true))) with
                {
                    OnCallId = (_) =>
                    {
                        drawn = true;
                    },
                }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.False(drawn);
    }

    [Fact]
    public async Task Is_capacity_exceeded_once_every_call_id_is_in_use()
    {
        await using var link = new Link(new RouterCoreOptions { LastCallId = 1 });

        _ = link.Client.Request(JsonOf("{\"milliseconds\":3600000}"), RequestOf("slow"));

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return link.Client.Request(JsonOf("null"), RequestOf("echo")).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, failure.Code);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
    }

    [Fact]
    public async Task Rejects_what_waits_on_a_connection_that_closed()
    {
        await using var link = new Link();

        var slow = link.Client.Request(JsonOf("{\"milliseconds\":3600000}"), RequestOf("slow"));

        link.Client.RejectPending("the connection closed before the answer", Handle);

        var disconnect = await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal("the connection closed before the answer", disconnect.Message);
    }

    [Fact]
    public async Task Rejects_what_waits_once_disposed_and_sends_nothing_more()
    {
        await using var link = new Link();

        var slow = link.Client.Request(JsonOf("{\"milliseconds\":3600000}"), RequestOf("slow"));

        link.Client.Dispose();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return slow.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return link.Client.Request(JsonOf("null"), RequestOf("echo")).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Refuses_a_payload_past_its_procedure_s_limit_before_it_draws_or_sends()
    {
        await using var link = new Link();

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return link.Client.Request(
                JsonOf("\"too long\""),
                RequestOf("echo") with { Procedure = InteropService.ProcedureOf("echo") with { MaximumPayloadBytes = 4 } })
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, failure.Code);
        Assert.Empty(link.CallIds);
        Assert.Empty(link.ServerReceived);
    }

    [Fact]
    public async Task Stalls_nothing_for_a_resolver_that_blocks_its_thread()
    {
        using var released = new ManualResetEventSlim();
        await using var link = new Link(server: (router) =>
        {
            new ServiceManager(router).GetRequestResolver(
                InteropService.ProcedureOf("echo") with { ProcedureId = 50, ProcedureName = "block" },
                new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = InteropService.Json })((request, response) =>
                {
                    // a resolver that holds its thread, as a careless one would
                    released.Wait(Patience, TestContext.Current.CancellationToken);

                    return response.Answer(request.Payload);
                });
        });

        var blocked = link.Client.Request(
            JsonOf("\"held\""),
            RequestOf("echo") with { Procedure = InteropService.ProcedureOf("echo") with { ProcedureId = 50 } });

        // the server still reads and answers while one of its resolvers blocks
        Assert.Equal("\"free\"", await link.Ask("echo", "\"free\""));
        Assert.False(blocked.IsCompleted);
        released.Set();
        Assert.Equal("\"held\"", Encoding.UTF8.GetString((await blocked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.Span));
    }

    // a client's core and a server of the interop service, linked in memory: what one sends, the
    // other receives
    private sealed class Link : IServerTransport, IAsyncDisposable
    {
        private readonly SerialScheduler? _serverScheduler;

        public Link(RouterCoreOptions? options = null, Action<RouterServer>? server = null)
        {
            Client = new RouterCore(new ClientPort(this), options);

            // a server of the interop service, its resolvers on its own scheduler unless the test
            // offers its own procedures, which run where a server's run
            _serverScheduler = server is null ? new SerialScheduler() : null;
            Facade = new Server<string>(
                this,
                new ServerOptions { ResolverScheduler = _serverScheduler, Scheduler = _serverScheduler });
            InteropService.Offer(Facade);
            server?.Invoke(Server);
            Connection?.Invoke(Handle);
        }

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        // the server's: the client's core, built alone, runs on the clock its options give
        public TimeProvider Clock { get; } = TimeProvider.System;

        public RouterCore Client { get; }

        public Server<string> Facade { get; }

        public RouterServer Server
        {
            get
            {
                return Facade.Router;
            }
        }

        public List<uint> CallIds { get; } = [];

        public List<ReadOnlyMemory<byte>> ServerReceived { get; } = [];

        public List<Exception> Reports { get; } = [];

        // asks the server a procedure of the interop service, and gives its result's text
        public async Task<string> Ask(string procedureName, string payload = "null")
        {
            var result = await Client.Request(
                JsonOf(payload),
                RequestOf(procedureName) with
                {
                    OnCallId = (callId) =>
                    {
                        CallIds.Add(callId);
                    },
                }).WaitAsync(Patience, TestContext.Current.CancellationToken);

            return Encoding.UTF8.GetString(result.Payload.Span);
        }

        // lets both ends settle, as far as their schedulers know
        public async Task Settle()
        {
            for (var round = 0; round < 3; round += 1)
            {
                await Client.Loop.WhenIdle();

                if (_serverScheduler is not null)
                {
                    await _serverScheduler.WhenIdle();
                }
            }
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            Client.Receive(bytes.ToArray(), Handle);

            return Task.CompletedTask;
        }

        public async ValueTask DisposeAsync()
        {
            Close?.Invoke(false, Handle);
            await Facade.DisposeAsync();
            Client.Dispose();
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }

        public Task ToServer(ReadOnlyMemory<byte> bytes)
        {
            ServerReceived.Add(bytes);
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false), Handle);

            return Task.CompletedTask;
        }
    }

    // the client's side, for its core: it sends to the server, and records what it reports
    private sealed class ClientPort(Link link) : IRouterCorePort
    {
        public RouterSide Side
        {
            get
            {
                return RouterSide.Client;
            }
        }

        public void Report(Exception reason, string connectionHandle)
        {
            link.Reports.Add(reason);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            return link.ToServer(bytes);
        }
    }
}
