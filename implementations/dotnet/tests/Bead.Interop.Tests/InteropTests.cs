using System.Diagnostics;
using System.Text.Json;
using Bead.Transport.Http;
using Bead.Transport.WebSockets;

namespace Bead.Interop.Tests;

/// <summary>
/// Bead's C# client against the TypeScript server of the interop service, over WebSocket and over
/// HTTP: the same procedures, the same failures, the same cancel, and a command the server asks. It
/// starts the TypeScript server with Node: it runs wherever Node and the TypeScript side are
/// installed, and is skipped, saying so, where they are not — unless <c>BEAD_INTEROP_REQUIRED=1</c>
/// asks for it, and then it fails, saying so: a path to the other side gone wrong is not a skip.
/// </summary>
public sealed class InteropTests(InteropTests.TypeScriptServer server) : IClassFixture<InteropTests.TypeScriptServer>
{
    // constants

    private const string Reason = "it starts the TypeScript server, and Node or the TypeScript side are not installed";

    private const string Host = "127.0.0.1";

    // the transports each test is played over
    private const string WebSocket = "WebSocket";
    private const string Http = "HTTP";

    // asked once: whether Node answers, and the TypeScript side it starts the server from is installed
    private static readonly Lazy<bool> CanStartTypeScript = new(() =>
    {
        try
        {
            var typescript = TypeScriptServer.TypeScript();

            if (!Directory.Exists(Path.Combine(typescript, "node_modules")))
            {
                return false;
            }

            using var node = Process.Start(new ProcessStartInfo("node", "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
            });

            return node is not null && node.WaitForExit(TimeSpan.FromSeconds(10)) && node.ExitCode == 0;
        }
        catch (Exception reason) when (reason is DirectoryNotFoundException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    });

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // helpers

    /// <summary>
    /// Whether the interop runs: Node answers, and the TypeScript side is installed — or the interop
    /// is required, and then what it cannot start fails rather than skips.
    /// </summary>
    public static bool IsInterop
    {
        get
        {
            return CanStartTypeScript.Value || IsRequired;
        }
    }

    // asked by BEAD_INTEROP_REQUIRED=1, where a skip would hide a path to the other side gone wrong
    private static bool IsRequired
    {
        get
        {
            return Environment.GetEnvironmentVariable("BEAD_INTEROP_REQUIRED") == "1";
        }
    }

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement JsonOf(string text)
    {
        using var document = JsonDocument.Parse(text);

        return document.RootElement.Clone();
    }

    private static Func<JsonElement, Requester<JsonElement>> RequesterOf(Connected client, (Procedure Procedure, IRequestSerializerClient<JsonElement, JsonElement>? Serializer) asked)
    {
        return client.Services.GetRequest(
            asked.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = asked.Serializer ?? InteropService.JsonAsked });
    }

    private static Func<JsonElement, Requester<JsonElement>> RequesterOf(Connected client, string procedureName)
    {
        return RequesterOf(client, (InteropService.ProcedureOf(procedureName), null));
    }

    // the calls to slow the connection cancelled, once the server counted as many as expected
    private static async Task<int> CancellationsReaching(Connected client, int count)
    {
        var counted = -1;

        for (var tries = 0; tries < 40 && counted != count; tries += 1)
        {
            counted = (await RequesterOf(client, "cancellations")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetInt32();

            if (counted != count)
            {
                await Task.Delay(50, Cancelled);
            }
        }

        return counted;
    }

    private static List<int> Snapshot(List<int> heard)
    {
        lock (heard)
        {
            return [.. heard];
        }
    }

    // waits, a while at most, for what the callbacks heard to be what is expected
    private static async Task Heard(List<int> heard, int[] expected)
    {
        for (var tries = 0; tries < 100 && !Snapshot(heard).SequenceEqual(expected); tries += 1)
        {
            await Task.Delay(20, Cancelled);
        }

        Assert.Equal(expected, Snapshot(heard));
    }

    // a client of the TypeScript server, connected over a transport
    private async Task<Connected> ConnectedOver(string transport)
    {
        var (port, httpPort) = await server.Ports();

        if (transport == WebSocket)
        {
            var client = new WebSocketClient();

            await client.Connect(new WebSocketConnectOptions { Host = Host, Port = port }, Cancelled);

            return new Connected((client.Services, client.Router), client.DisposeAsync);
        }

        var inOrder = new InOrder();
        var httpClient = new BeadHttpClient(new BeadHttpClientOptions { Transport = new HttpTransportClientOptions { Handler = inOrder } });

        await httpClient.Connect(new HttpConnectOptions { Host = Host, Port = httpPort }, Cancelled);

        return new Connected((httpClient.Services, httpClient.Router), async () =>
        {
            await httpClient.DisposeAsync();
            inOrder.Dispose();
        });
    }

    // definition

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Echo_and_bytes_answer_as_the_service_says(string transport)
    {
        await using var client = await ConnectedOver(transport);

        Assert.Equal("{\"a\":[1,\"two\",null]}", (await RequesterOf(client, "echo")(JsonOf("{\"a\":[1,\"two\",null]}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal(new string('x', 1_000), (await RequesterOf(client, "bytes")(JsonOf("{\"length\":1000}"))().WaitAsync(Patience, Cancelled)).GetString());
    }

    // HTTP carries no transfer: a payload is what one envelope holds
    [Fact(Skip = Reason, SkipUnless = nameof(IsInterop))]
    public async Task A_payload_that_goes_as_a_transfer_comes_back_as_one_and_so_does_a_result_too_large_for_one_envelope()
    {
        await using var client = await ConnectedOver(WebSocket);

        var text = new string('x', 3 * 1_048_576);
        var echoed = await RequesterOf(client, "echo")(JsonOf($"\"{text}\""))().WaitAsync(Patience, Cancelled);
        var sent = await RequesterOf(client, "bytes")(JsonOf("{\"length\":3145728}"))().WaitAsync(Patience, Cancelled);

        // compared, not diffed: three mebibytes would bury a failure
        Assert.True(echoed.GetString() == text);
        Assert.True(sent.GetString() == text);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Fail_answers_with_its_own_failure_raised_by_the_server(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return RequesterOf(client, "fail")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(7, failure.Code);
        Assert.Equal("this procedure fails, on purpose", failure.Detail);
        Assert.Equal(FailureScope.Application, failure.Scope);
        Assert.Equal(FailureOrigin.Peer, failure.Origin);
        Assert.Equal(RouterSide.Server, failure.Side);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Refuses_what_the_protocol_refuses(string transport)
    {
        await using var client = await ConnectedOver(transport);

        async Task<FailureException> FailureOf(Requester<JsonElement> requester)
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                return requester().WaitAsync(Patience, Cancelled);
            });
        }

        var echo = InteropService.ProcedureOf("echo");

        Assert.Equal((ushort)ProtocolCode.ProcedureUnknown, (await FailureOf(RequesterOf(client, (echo with { ProcedureId = 99 }, null))(JsonOf("null")))).Code);
        Assert.Equal((ushort)ProtocolCode.ServiceUnknown, (await FailureOf(RequesterOf(client, (echo with { ServiceId = 9 }, null))(JsonOf("null")))).Code);
        Assert.Equal("this procedure admits nobody", (await FailureOf(RequesterOf(client, "denied")(JsonOf("null")))).Detail);
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, (await FailureOf(RequesterOf(client, "broken")(JsonOf("null")))).Code);
        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, (await FailureOf(RequesterOf(client, (echo, new NotJson()))(JsonOf("null")))).Code);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task A_call_cancelled_by_its_token_is_cancelled_at_the_server_too(string transport)
    {
        await using var client = await ConnectedOver(transport);
        using var source = new CancellationTokenSource();
        var slow = RequesterOf(client, "slow")(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { CancellationToken = source.Token });

        // a call after it answered: the server has it, where its cancel must find it — by the
        // socket's order, or by the handler's
        await RequesterOf(client, "echo")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return slow.WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(1, await CancellationsReaching(client, 1));
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task A_call_past_its_timeout_is_cancelled_at_the_server_too(string transport)
    {
        await using var client = await ConnectedOver(transport);

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return RequesterOf(client, "slow")(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { Timeout = TimeSpan.FromMilliseconds(200) })
                .WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(1, await CancellationsReaching(client, 1));
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Answers_the_command_the_server_asks(string transport)
    {
        await using var client = await ConnectedOver(transport);

        InteropService.OfferClient(client.Services);

        Assert.Equal("\"noon\"", (await RequesterOf(client, "ask")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task A_subscription_hears_each_tick_and_a_paced_one_waits_for_its_callback(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var heard = new List<int>();
        var holding = new TaskCompletionSource();
        var ticks = client.Services.GetNotification(
            InteropService.ProcedureOf("ticks"),
            new NotificationDependencies<JsonElement, JsonElement, JsonElement> { Serializer = new JsonNotifications(), Window = 1 });

        await using var registration = await ticks.Register(JsonOf("null"), (value) =>
        {
            lock (heard)
            {
                heard.Add(value.GetInt32());

                return heard.Count == 1 ? holding.Task : Task.CompletedTask;
            }
        })().WaitAsync(Patience, Cancelled);

        await RequesterOf(client, "tick")(JsonOf("{\"value\":1}"))().WaitAsync(Patience, Cancelled);
        await RequesterOf(client, "tick")(JsonOf("{\"value\":2}"))().WaitAsync(Patience, Cancelled);
        await Heard(heard, [1]);
        await Task.Delay(100, Cancelled);
        Assert.Equal([1], Snapshot(heard));
        holding.SetResult();
        await Heard(heard, [1, 2]);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Learns_a_session_opened_from_its_answer_and_its_end_too(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return RequesterOf(client, "whoami")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.SessionRequired, refused.Code);
        Assert.Equal("\"ada\"", (await RequesterOf(client, "login")(JsonOf("{\"name\":\"ada\"}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.NotNull(client.Router.SessionToken);
        Assert.Equal("\"ada\"", (await RequesterOf(client, "whoami")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
        await RequesterOf(client, "logout")(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        Assert.Null(client.Router.SessionToken);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task A_call_presenting_the_session_it_learned_runs_in_it_the_session_opened_anew_presented_anew_and_none_presented_once_it_ended(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var presenting = new RequestOptions { Credential = Credential.Opaque() };

        async Task<string> Answered((string ProcedureName, string Payload) call)
        {
            return (await RequesterOf(client, call.ProcedureName)(JsonOf(call.Payload))(presenting).WaitAsync(Patience, Cancelled)).GetRawText();
        }

        async Task<FailureException> Refused(string procedureName)
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                return RequesterOf(client, procedureName)(JsonOf("null"))(presenting).WaitAsync(Patience, Cancelled);
            });
        }

        var before = await Refused("login");

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (before.Code, before.Origin));
        Assert.Equal("\"ada\"", (await RequesterOf(client, "login")(JsonOf("{\"name\":\"ada\"}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("\"ada\"", await Answered(("whoami", "null")));
        Assert.Equal("\"bob\"", await Answered(("login", "{\"name\":\"bob\"}")));
        Assert.Equal("\"bob\"", await Answered(("whoami", "null")));
        Assert.Equal("null", await Answered(("logout", "null")));

        var ended = await Refused("whoami");

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (ended.Code, ended.Origin));
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    public async Task Login_and_register_hold_a_duration_as_section_1_4_does_a_fraction_rounded_one_under_a_millisecond_or_past_2_31_minus_1_refused_with_PROCEDURE_FAILED_nothing_opened_or_registered(string transport)
    {
        await using var client = await ConnectedOver(transport);

        async Task<ushort> CodeOf(Requester<JsonElement> requester)
        {
            return (await Assert.ThrowsAsync<FailureException>(() =>
            {
                return requester().WaitAsync(Patience, Cancelled);
            })).Code;
        }

        foreach (var refused in new[] { "{\"name\":\"ada\",\"sessionTimeout\":0.4}", "{\"connectionTimeout\":2147483648,\"name\":\"ada\"}", "{\"name\":\"ada\",\"sessionTimeout\":-1}" })
        {
            Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(RequesterOf(client, "login")(JsonOf(refused))));
        }

        Assert.Equal((ushort)ProtocolCode.SessionRequired, await CodeOf(RequesterOf(client, "whoami")(JsonOf("null"))));
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(RequesterOf(client, "register")(JsonOf("{\"destination\":41,\"timeout\":0}"))));
        Assert.Equal("41", (await RequesterOf(client, "register")(JsonOf("{\"destination\":41,\"timeout\":1.5}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("true", (await RequesterOf(client, "unregister")(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());

        // a session timeout given ends its session once past, rounded; silence counts it alone
        Assert.Equal("\"ada\"", (await RequesterOf(client, "login")(JsonOf("{\"connectionTimeout\":2147483647,\"name\":\"ada\",\"sessionTimeout\":99.6}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        await Task.Delay(400, Cancelled);
        Assert.Equal((ushort)ProtocolCode.SessionRequired, await CodeOf(RequesterOf(client, "whoami")(JsonOf("null"))));
    }

    /// <summary>
    /// What an HTTP client's exchanges go through: an envelope goes only once the server said it had
    /// the one before — its head came back (section 15.7) — as a socket keeps them in order, so a
    /// cancel never overtakes its request, which the server would bury unseen.
    /// </summary>
    private sealed class InOrder : DelegatingHandler
    {
        private readonly SemaphoreSlim _turn = new(1, 1);

        public InOrder()
            : base(new SocketsHttpHandler { AllowAutoRedirect = false })
        {
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Content is null)
            {
                return await base.SendAsync(request, cancellationToken);
            }

            await _turn.WaitAsync(cancellationToken);

            try
            {
                return await base.SendAsync(request, cancellationToken);
            }
            finally
            {
                _turn.Release();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _turn.Dispose();
            }

            base.Dispose(disposing);
        }
    }

    // a client connected over one transport or the other: its services, its router, and what lets it go
    private sealed class Connected((ServiceManager Services, RouterClient Router) layers, Func<ValueTask> dispose) : IAsyncDisposable
    {
        public ServiceManager Services { get; } = layers.Services;

        public RouterClient Router { get; } = layers.Router;

        public ValueTask DisposeAsync()
        {
            return dispose();
        }
    }

    // JSON, in UTF-8, for a subscribing request, its answer and its notifications
    private sealed class JsonNotifications : INotificationSerializerClient<JsonElement, JsonElement, JsonElement>
    {
        public ReadOnlyMemory<byte> Encode(JsonElement request)
        {
            return InteropService.JsonAsked.Encode(request);
        }

        public JsonElement Decode(ReadOnlyMemory<byte> response)
        {
            return InteropService.JsonAsked.Decode(response);
        }

        public JsonElement DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return InteropService.JsonAsked.Decode(notification);
        }
    }

    // a request's payload that is not JSON
    private sealed class NotJson : IRequestSerializerClient<JsonElement, JsonElement>
    {
        public ReadOnlyMemory<byte> Encode(JsonElement request)
        {
            return new byte[] { 0xFF };
        }

        public JsonElement Decode(ReadOnlyMemory<byte> response)
        {
            return InteropService.JsonAsked.Decode(response);
        }
    }

    /// <summary>
    /// The TypeScript server of the interop service, started once, on the first test that asks its
    /// ports, and stopped by closing its input.
    /// </summary>
    public sealed class TypeScriptServer : IAsyncDisposable
    {
        private readonly SemaphoreSlim _starting = new(1, 1);
        private Process? _process;
        private (int Port, int HttpPort) _ports;

        /// <summary>The ports it listens on, over WebSocket and over HTTP, once started.</summary>
        public async Task<(int Port, int HttpPort)> Ports()
        {
            await _starting.WaitAsync(TestContext.Current.CancellationToken);

            try
            {
                if (_process is null)
                {
                    (_process, _ports) = await Start();
                }

                return _ports;
            }
            finally
            {
                _starting.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_process is { } process)
            {
                process.StandardInput.Close();

                if (!process.WaitForExit(TimeSpan.FromSeconds(10)))
                {
                    process.Kill(entireProcessTree: true);
                }

                process.Dispose();
            }

            _starting.Dispose();
            await ValueTask.CompletedTask;
        }

        // the repository's root: the directory up from this test that holds spec/spec.md
        internal static string Root()
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            {
                if (File.Exists(Path.Combine(directory.FullName, "spec", "spec.md")))
                {
                    return directory.FullName;
                }
            }

            throw new DirectoryNotFoundException("no spec/spec.md above this test");
        }

        // the TypeScript side, its own Yarn project: where the interop server starts from
        internal static string TypeScript()
        {
            return Path.Combine(Root(), "implementations", "typescript");
        }

        private static async Task<(Process Process, (int Port, int HttpPort) Ports)> Start()
        {
            if (!CanStartTypeScript.Value)
            {
                throw new InvalidOperationException("BEAD_INTEROP_REQUIRED=1 asks for the interop, and Node or the TypeScript side are not installed");
            }

            var process = Process.Start(new ProcessStartInfo("node", "interop/serve.ts")
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                WorkingDirectory = TypeScript(),
            }) ?? throw new InvalidOperationException("node did not start");

            // what comes before the ports, a build's lines, is passed over
            while (await process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken) is { } line)
            {
                try
                {
                    using var document = JsonDocument.Parse(line);

                    if (document.RootElement.TryGetProperty("port", out var port) && document.RootElement.TryGetProperty("httpPort", out var httpPort))
                    {
                        return (process, (port.GetInt32(), httpPort.GetInt32()));
                    }
                }
                catch (JsonException)
                {
                    // not the line that says the ports
                }
            }

            throw new InvalidOperationException("the TypeScript interop server ended before it said its ports");
        }
    }
}
