namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceManager"/>'s requesters: a call's options against the defaults, its
/// payload written, its answer decoded, its deprecation, and a command's close on timeout.
/// </summary>
public sealed partial class ServiceManagerTests
{
    [Fact]
    public async Task Fills_what_the_options_leave_out_and_passes_a_destination_as_it_is()
    {
        var router = new RecordingRouter();
        var requester = new ServiceManager(router).GetRequest(Echo, Asked)(new Text("a"));

        await requester().WaitAsync(Patience, Cancelled);
        await requester(new RequestOptions { ConnectionHandle = Handle, DestinationId = null }).WaitAsync(Patience, Cancelled);
        await requester(new RequestOptions { DestinationId = 4, Timeout = TimeSpan.FromMilliseconds(10) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                new ResolvedRequestOptions { Timeout = TimeoutDefault },
                new ResolvedRequestOptions { ConnectionHandle = Handle, Timeout = TimeoutDefault },
                new ResolvedRequestOptions { DestinationId = 4, Timeout = TimeSpan.FromMilliseconds(10) },
            ],
            router.Requests.Select((sent) =>
            {
                return sent.Request.Options;
            }));
    }

    [Fact]
    public async Task Sends_the_encoded_payload_with_the_resolved_options_and_decodes_the_answer()
    {
        var router = new RecordingRouter();

        var echoed = await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("hello"))(
            new RequestOptions { Timeout = TimeSpan.FromMilliseconds(100) }).WaitAsync(Patience, Cancelled);

        Assert.Equal(new Text("hello"), echoed);

        var (payload, request) = Assert.Single(router.Requests);

        Assert.Equal(new Text("hello"), payload);
        Assert.Equal(
            new RouterRequest(Echo, new ResolvedRequestOptions { Timeout = TimeSpan.FromMilliseconds(100) }) { Series = Assert.Single(router.Declared).Series },
            request);
    }

    // a destination is a call's own, never a default: RequestDefaults has none
    [Fact]
    public async Task Takes_the_manager_defaults_where_the_call_says_nothing_and_its_token_as_given()
    {
        var router = new RecordingRouter();
        var requester = new ServiceManager(router, new ServiceManagerOptions
        {
            Defaults = new RequestDefaults { Timeout = TimeSpan.FromMilliseconds(50) },
        }).GetRequest(Echo, Asked);

        using var source = new CancellationTokenSource();

        await requester(new Text("a"))().WaitAsync(Patience, Cancelled);
        await requester(new Text("b"))(new RequestOptions
        {
            CancellationToken = source.Token,
            DestinationId = 2,
            Timeout = TimeSpan.FromMilliseconds(9),
        }).WaitAsync(Patience, Cancelled);

        // a manager given no defaults waits 5 s
        await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("c"))().WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [
                new ResolvedRequestOptions { Timeout = TimeSpan.FromMilliseconds(50) },
                new ResolvedRequestOptions { CancellationToken = source.Token, DestinationId = 2, Timeout = TimeSpan.FromMilliseconds(9) },
                new ResolvedRequestOptions { Timeout = TimeoutDefault },
            ],
            router.Requests.Select((sent) =>
            {
                return sent.Request.Options;
            }));
    }

    [Fact]
    public async Task On_a_server_router_names_the_connection_it_goes_to()
    {
        var router = new RecordingRouter();

        await new ServiceManager(router).GetRequest(Echo, Asked)(new Text("a"))(new RequestOptions { ConnectionHandle = Handle })
            .WaitAsync(Patience, Cancelled);

        Assert.Equal(Handle, Assert.Single(router.Requests).Request.Options.ConnectionHandle);
    }

    // debugging 4.1.7
    [Fact]
    public async Task Hands_its_router_the_credential_a_call_presents_and_leaves_it_out_of_its_trace()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);

        await manager.GetRequest(Echo, Asked)(new Text("a"))(new RequestOptions { Credential = Credential.Opaque() }).WaitAsync(Patience, Cancelled);
        await manager.GetRequest(Echo, Asked)(new Text("b"))().WaitAsync(Patience, Cancelled);
        await manager.GetRequest(Echo, Asked)(new Text("c"))(new RequestOptions { Credential = Credential.Jwt("a.b.c") }).WaitAsync(Patience, Cancelled);
        await manager.GetRequest(Echo, Asked)(new Text("d"))(new RequestOptions { Credential = Credential.Elsewhere("Interop sub=ada") }).WaitAsync(Patience, Cancelled);

        Assert.Equal(
            [Credential.Opaque(), null, Credential.Jwt("a.b.c"), Credential.Elsewhere("Interop sub=ada")],
            router.Requests.Select((sent) =>
            {
                return sent.Request.Options.Credential;
            }));
        Assert.All(seen, (told) =>
        {
            Assert.Null(told.Event.Options!.Credential);
        });
    }

    // debugging 4.1.9 and 4.2.2
    [Fact]
    public async Task Rethrows_what_the_router_rejects_with_and_tells_debug_its_failure_and_only_a_failure_one()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var requester = manager.GetRequest(Echo, Asked);
        var failure = new FailureException(
            Failure.OfProtocol(ProtocolCode.AccessDenied, "no") with { Relays = 2 },
            new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server));

        // what is not a failure goes on as it is as well
        var reset = new IOException("reset");

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(failure);
        };
        Assert.Same(failure, await Assert.ThrowsAsync<FailureException>(() =>
        {
            return requester(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal<Exception?>(
            [null, failure],
            seen.Select((told) =>
            {
                return told.Error;
            }));
        // its code, its scope and its detail, the relays it crossed left out
        Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied, "no"), seen[1].Event.Rx);
        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(reset);
        };
        Assert.Same(reset, await Assert.ThrowsAsync<IOException>(() =>
        {
            return requester(new Text("x"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Same(reset, seen[3].Error);
        Assert.Null(seen[3].Event.Rx);
    }

    // spec 17.2.4; debugging 4.3
    [Fact]
    public async Task Makes_no_call_of_a_request_whose_value_does_not_write_tracing_deprecating_and_sending_nothing()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var deprecated = new List<Procedure>();
        var requester = manager.GetRequest(
            Echo with { Deprecation = new ProcedureDeprecation() },
            new RequestDependencies<Text, Text> { Serializer = new Unwritable() });

        manager.Deprecated += deprecated.Add;

        // * written before its trace and its deprecation: no call is made (spec 17.2, item 4)
        Assert.Equal("cannot write", (await Assert.ThrowsAsync<FormatException>(() =>
        {
            return requester(new Text("x"))().WaitAsync(Patience, Cancelled);
        })).Message);
        Assert.Empty(seen);
        Assert.Empty(deprecated);
        Assert.Empty(router.Requests);
    }

    [Fact]
    public async Task Declares_its_requester_to_its_router_as_it_is_made_and_hands_each_of_its_calls_the_series_it_gave()
    {
        var router = new RecordingRouter();
        var requester = new ServiceManager(router).GetRequest(Echo, Asked);

        // declared once, as it is made, before any call
        var (procedureName, series) = Assert.Single(router.Declared);

        Assert.Equal("echo", procedureName);
        await requester(new Text("a"))().WaitAsync(Patience, Cancelled);
        await requester(new Text("b"))().WaitAsync(Patience, Cancelled);
        Assert.Single(router.Declared);
        Assert.All(router.Requests, (sent) =>
        {
            Assert.Same(series, sent.Request.Series);
        });
    }

    [Fact]
    public async Task A_deprecated_procedure_raises_deprecated_at_each_call_and_only_a_deprecated_one()
    {
        var manager = new ServiceManager(new RecordingRouter());
        var seen = new List<Procedure>();
        var old = Echo with { Deprecation = new ProcedureDeprecation { Message = "use echo2" } };

        // present, even empty, is deprecated
        var empty = Echo with { Deprecation = new ProcedureDeprecation() };

        manager.Deprecated += seen.Add;

        var requester = manager.GetRequest(old, Asked);

        await requester(new Text("a"))().WaitAsync(Patience, Cancelled);
        await requester(new Text("b"))().WaitAsync(Patience, Cancelled);
        await manager.GetRequest(Echo, Asked)(new Text("c"))().WaitAsync(Patience, Cancelled);
        await manager.GetRequest(empty, Asked)(new Text("d"))().WaitAsync(Patience, Cancelled);

        Assert.Equal([old, old, empty], seen);
    }

    [Fact]
    public async Task A_command_unanswered_in_time_closes_its_connection_as_the_call_or_else_the_manager_says_nothing_else_does()
    {
        var router = new RecordingRouter();
        var closed = new List<string>();
        var late = new TimeoutException("unanswered in 10 ms");
        var refused = new FailureException(
            Failure.OfProtocol(ProtocolCode.ProcedureFailed),
            new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server));
        Exception failure = late;
        var byDefault = new ServiceManager(router, new ServiceManagerOptions
        {
            CloseConnection = closed.Add,
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });
        var unlessAsked = new ServiceManager(router, new ServiceManagerOptions { CloseConnection = closed.Add });
        var unable = new ServiceManager(router, new ServiceManagerOptions
        {
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });

        // what the command fails with, the manager and the call's close on timeout given
        ValueTask<Exception?> Call((ServiceManager Manager, bool? CloseOnTimeout) call)
        {
            return Record.ExceptionAsync(() =>
            {
                return call.Manager.GetCommand(Echo, Asked)(new Text("run"))(new RequestOptions
                {
                    CloseOnTimeout = call.CloseOnTimeout,
                    ConnectionHandle = Handle,
                }).WaitAsync(Patience, Cancelled);
            });
        }

        router.Answer = (_) =>
        {
            return Task.FromException<RouterResult>(failure);
        };

        // the call fails with what went wrong either way
        Assert.Same(late, await Call((byDefault, null)));
        Assert.Equal([Handle], closed);

        Assert.Same(late, await Call((byDefault, false)));
        Assert.Same(late, await Call((unlessAsked, null)));
        Assert.Same(late, await Call((unable, null)));
        Assert.Equal([Handle], closed);

        Assert.Same(late, await Call((unlessAsked, true)));
        Assert.Equal([Handle, Handle], closed);

        // a request that names no connection has none to close
        Assert.Same(late, await Record.ExceptionAsync(() =>
        {
            return byDefault.GetRequest(Echo, Asked)(new Text("run"))().WaitAsync(Patience, Cancelled);
        }));
        Assert.Equal(2, closed.Count);

        // an answer, even a refusal, is not silence; nor is a connection gone, or a caller that gave up
        foreach (var other in new Exception[] { refused, new DisconnectException("gone"), new OperationCanceledException() })
        {
            failure = other;

            Assert.Same(other, await Call((byDefault, null)));
        }

        Assert.Equal(2, closed.Count);
    }

    [Fact]
    public async Task Get_command_asks_one_connection_as_a_server_request_does_and_tells_debug_it_is_a_command()
    {
        var router = new RecordingRouter();
        var manager = new ServiceManager(router);
        var seen = RecordDebug(manager);
        var command = manager.GetCommand(Echo, Asked);

        Assert.Equal(
            new Text("run"),
            await command(new Text("run"))(new RequestOptions { ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled));
        Assert.Equal(Handle, Assert.Single(router.Requests).Request.Options.ConnectionHandle);
        Assert.Equal([(DebugDirection.Tx, DebugType.Command), (DebugDirection.Rx, DebugType.Command)], StepsOf(seen));
    }

    [Fact]
    public async Task Tells_debug_the_close_on_timeout_that_applies_the_call_or_else_the_manager_one()
    {
        var manager = new ServiceManager(new RecordingRouter(), new ServiceManagerOptions
        {
            CloseConnection = (_) =>
            {
            },
            Defaults = new RequestDefaults { CloseOnTimeout = true },
        });
        var seen = RecordDebug(manager);
        var command = manager.GetCommand(Echo, Asked)(new Text("run"));

        await command(new RequestOptions { ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled);
        await command(new RequestOptions { CloseOnTimeout = false, ConnectionHandle = Handle }).WaitAsync(Patience, Cancelled);

        Assert.Equal<bool?>(
            [true, false],
            seen
                .Where((told) =>
                {
                    return told.Event.Direction == DebugDirection.Tx;
                })
                .Select((told) =>
                {
                    return told.Event.Options?.CloseOnTimeout;
                }));
    }
}
