using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Bead.Tests;
using Bead.Transport.Amqp;
using Bead.Transport.Amqp.Tests;
using Bead.Transport.Http;
using Bead.Transport.Mqtt;
using Bead.Transport.Mqtt.Tests;
using Bead.Transport.WebSockets;

// ! one TypeScript server for every class: two would each link as ts-server over MQTT 5, and the
// later would take the former over, which then connects no more (spec 15.21); over AMQP 1.0 the
// later would be refused while the former holds its inbox (spec 15.33)
[assembly: AssemblyFixture(typeof(Bead.Interop.Tests.InteropTests.TypeScriptServer))]

namespace Bead.Interop.Tests;

/// <summary>
/// Bead's C# client against the TypeScript server of the interop service, over WebSocket, over
/// HTTP, over MQTT 5 and over AMQP 1.0: the same procedures, the same failures, the same cancel, and a command the
/// server asks. It starts the TypeScript server with Node: it runs wherever Node and the TypeScript
/// side are installed, and is skipped, saying so, where they are not — unless
/// <c>BEAD_INTEROP_REQUIRED=1</c> asks for it, and then it fails, saying so: a path to the other side
/// gone wrong is not a skip. Over MQTT 5, where <c>BEAD_MQTT_URL</c> names a broker (<c>node
/// tools/mqtt-broker.mjs run -- dotnet test</c>), its participant <c>cs-client</c> calls
/// <c>interop-ts</c>, and <c>interop-both</c>, which a C# server of its own serves in one group with
/// the TypeScript one; where none is given, those cases are skipped, saying so, or fail where
/// <c>BEAD_MQTT_REQUIRED=1</c>. Over AMQP 1.0 alike, where <c>BEAD_AMQP_URL</c> names a RabbitMQ
/// (<c>node tools/amqp-broker.mjs run -- dotnet test</c>), or fail where <c>BEAD_AMQP_REQUIRED=1</c>.
/// </summary>
public sealed class InteropTests(InteropTests.TypeScriptServer server, InteropTests.MqttSide mqtt, InteropTests.AmqpSide amqp) : IClassFixture<InteropTests.MqttSide>, IClassFixture<InteropTests.AmqpSide>
{
    // constants

    private const string Reason = "it starts the TypeScript server, and Node or the TypeScript side are not installed";

    private const string Host = "127.0.0.1";

    // the transports each test is played over
    private const string WebSocket = "WebSocket";
    private const string Http = "HTTP";
    private const string Mqtt = "MQTT";
    private const string Amqp = "AMQP";

    private const string NoBroker = MqttFixture.Reason;
    private const string NoAmqpBroker = AmqpFixture.Reason;

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

    /// <summary>Whether the interop runs over MQTT 5: it runs, and a broker is given, or asked for.</summary>
    public static bool IsMqttInterop
    {
        get
        {
            return IsInterop && MqttFixture.IsGiven;
        }
    }

    /// <summary>Whether the interop runs over AMQP 1.0: it runs, and a RabbitMQ is given, or asked for.</summary>
    public static bool IsAmqpInterop
    {
        get
        {
            return IsInterop && AmqpFixture.IsGiven;
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

    // a requester no generated client holds: a procedure or a service its server lacks, or a payload
    // that is not JSON, through the service manager's own accessor
    private static Func<JsonElement, BoundCall<JsonElement>> RequesterOf(Connected client, (Procedure Procedure, IRequestSerializerClient<JsonElement, JsonElement>? Serializer) asked)
    {
        return client.Services.GetRequest(
            asked.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = asked.Serializer ?? new JsonPayloads() });
    }

    // the calls to slow the connection cancelled, once the server counted as many as expected
    private static async Task<int> CancellationsReaching(Connected client, int count)
    {
        var counted = -1;

        for (var tries = 0; tries < 40 && counted != count; tries += 1)
        {
            counted = (await client.Interop.Cancellations(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetInt32();

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

    // a client of the TypeScript server, connected over a transport, a WebSocket's upgrade carrying
    // the credential given
    private async Task<Connected> ConnectedOver(string transport, string? credential = null)
    {
        var (port, httpPort, _) = await server.Ports();

        if (transport is Mqtt or Amqp)
        {
            var link = await LinkedOver(transport);
            var broker = new BrokerClient(link.Participant.Client());

            await broker.Transport.Connect(new BrokerConnectOptions { Server = "interop-ts" }, Cancelled);

            return new Connected(broker, broker.DisposeAsync);
        }

        if (transport == WebSocket)
        {
            var client = new WebSocketClient();

            await client.Connect(new WebSocketConnectOptions { Host = Host, Port = port, Credential = credential }, Cancelled);

            return new Connected(client, client.DisposeAsync);
        }

        var inOrder = new InOrder();
        var httpClient = new BeadHttpClient(new BeadHttpClientOptions { Transport = new HttpTransportClientOptions { Handler = inOrder } });

        await httpClient.Connect(new HttpConnectOptions { Host = Host, Port = httpPort }, Cancelled);

        return new Connected(httpClient, async () =>
        {
            await httpClient.DisposeAsync();
            inOrder.Dispose();
        });
    }

    // definition

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Echo_and_bytes_answer_as_the_service_says(string transport)
    {
        await using var client = await ConnectedOver(transport);

        Assert.Equal("{\"a\":[1,\"two\",null]}", (await client.Interop.Echo(JsonOf("{\"a\":[1,\"two\",null]}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal(new string('x', 1_000), (await client.Interop.Bytes(JsonOf("{\"length\":1000}"))().WaitAsync(Patience, Cancelled)).GetString());
    }

    // the two codecs read each other's bytes: each side writes its members sorted, in UTF-8
    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_value_outside_ASCII_its_members_in_another_order_echoed_equal(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var value = JsonOf("{\"z\":\"Jos\u00E9 \U0001F600\",\"a\":[1e21,0.000001]}");
        var echoed = await client.Interop.Echo(value)().WaitAsync(Patience, Cancelled);

        Assert.True(JsonElement.DeepEquals(value, echoed), echoed.GetRawText());
    }

    // HTTP carries no transfer: a payload is what one envelope holds
    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_payload_that_goes_as_a_transfer_comes_back_as_one_and_so_does_a_result_too_large_for_one_envelope(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var text = new string('x', 3 * 1_048_576);
        var echoed = await client.Interop.Echo(JsonOf($"\"{text}\""))().WaitAsync(Patience, Cancelled);
        var sent = await client.Interop.Bytes(JsonOf("{\"length\":3145728}"))().WaitAsync(Patience, Cancelled);

        // compared, not diffed: three mebibytes would bury a failure
        Assert.True(echoed.GetString() == text);
        Assert.True(sent.GetString() == text);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Fail_answers_with_its_own_failure_raised_by_the_server(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Interop.Fail(JsonOf("null"))().WaitAsync(Patience, Cancelled);
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
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Refuses_what_the_protocol_refuses(string transport)
    {
        await using var client = await ConnectedOver(transport);

        async Task<FailureException> FailureOf(BoundCall<JsonElement> requester)
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                return requester().WaitAsync(Patience, Cancelled);
            });
        }

        var echo = InteropProcedures.Echo.Procedure;

        var unknownProcedure = await FailureOf(RequesterOf(client, (echo with { ProcedureId = 99 }, null))(JsonOf("null")));
        var unknownService = await FailureOf(RequesterOf(client, (echo with { ServiceId = 9 }, null))(JsonOf("null")));
        var denied = await FailureOf(client.Interop.Denied(JsonOf("null")));

        Assert.Equal(((ushort)ProtocolCode.ProcedureUnknown, FailureScope.Protocol), (unknownProcedure.Code, unknownProcedure.Scope));
        Assert.Equal(((ushort)ProtocolCode.ServiceUnknown, FailureScope.Protocol), (unknownService.Code, unknownService.Scope));
        Assert.Equal(((ushort)ProtocolCode.AccessDenied, "this procedure admits nobody"), (denied.Code, denied.Detail));
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, (await FailureOf(client.Interop.Broken(JsonOf("null")))).Code);
        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, (await FailureOf(RequesterOf(client, (echo, new NotJson()))(JsonOf("null")))).Code);
    }

    // * the detail as the server writes it, lines of canonical JSON, byte for byte
    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_request_its_rules_refuse_is_answered_PAYLOAD_INVALID_its_violations_in_its_detail(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Interop.Checked(JsonOf("{\"names\":[\"ab\",\"\",\"abcd\"]}"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, failure.Code);
        Assert.Equal(FailureScope.Protocol, failure.Scope);
        Assert.Equal(
            string.Join(
                '\n',
                "{\"bounds\":{\"min_len\":\"1\"},\"fieldPath\":\"names[1]\",\"message\":\"must be at least 1 characters\",\"ruleId\":\"string.min_len\"}",
                "{\"bounds\":{\"max_len\":\"3\"},\"fieldPath\":\"names[2]\",\"message\":\"must be at most 3 characters\",\"ruleId\":\"string.max_len\"}",
                "{\"more\":0}"),
            failure.Detail);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Checked_answers_the_count_of_the_names_its_rules_take(string transport)
    {
        await using var client = await ConnectedOver(transport);

        Assert.Equal(2, (await client.Interop.Checked(JsonOf("{\"names\":[\"a\",\"bc\"]}"))().WaitAsync(Patience, Cancelled)).GetInt32());
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_call_cancelled_by_its_token_is_cancelled_at_the_server_too(string transport)
    {
        await using var client = await ConnectedOver(transport);
        using var source = new CancellationTokenSource();
        var slow = client.Interop.Slow(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { CancellationToken = source.Token });

        // a call after it answered: the server has it, where its cancel must find it — by the
        // socket's order, or by the handler's
        await client.Interop.Echo(JsonOf("null"))().WaitAsync(Patience, Cancelled);
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
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_call_past_its_timeout_is_cancelled_at_the_server_too(string transport)
    {
        await using var client = await ConnectedOver(transport);

        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return client.Interop.Slow(JsonOf("{\"milliseconds\":3600000}"))(new RequestOptions { Timeout = TimeSpan.FromMilliseconds(200) })
                .WaitAsync(Patience, Cancelled);
        });
        Assert.Equal(1, await CancellationsReaching(client, 1));
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Answers_the_command_the_server_asks(string transport)
    {
        await using var client = await ConnectedOver(transport);

        InteropHandlers.OfferClient(client.Interop);

        Assert.Equal("\"noon\"", (await client.Interop.Ask(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task An_unpaced_subscription_hears_each_tick(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var heard = new List<int>();

        await using var registration = await client.Interop.Notifications.Ticks.Register(JsonOf("null"), (value) =>
        {
            lock (heard)
            {
                heard.Add(value.GetInt32());
            }

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await client.Interop.Tick(JsonOf("{\"value\":1}"))().WaitAsync(Patience, Cancelled);
        await client.Interop.Tick(JsonOf("{\"value\":2}"))().WaitAsync(Patience, Cancelled);
        await Heard(heard, [1, 2]);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_paced_subscription_waits_for_its_callback_to_settle_before_the_next_comes(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var heard = new List<int>();
        var holding = new TaskCompletionSource();
        // its client side made first, at its window: a Bead client asks a notification at one alone
        var ticks = client.InteropWith(new InteropWindows { Ticks = 1 }).Notifications.Ticks;

        await using var registration = await ticks.Register(JsonOf("null"), (value) =>
        {
            lock (heard)
            {
                heard.Add(value.GetInt32());

                return heard.Count == 1 ? holding.Task : Task.CompletedTask;
            }
        })().WaitAsync(Patience, Cancelled);

        await client.Interop.Tick(JsonOf("{\"value\":1}"))().WaitAsync(Patience, Cancelled);
        await client.Interop.Tick(JsonOf("{\"value\":2}"))().WaitAsync(Patience, Cancelled);
        await Heard(heard, [1]);
        await Task.Delay(100, Cancelled);
        Assert.Equal([1], Snapshot(heard));
        holding.SetResult();
        await Heard(heard, [1, 2]);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Learns_a_session_opened_from_its_answer_and_its_end_too(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Interop.Whoami(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.SessionRequired, refused.Code);
        Assert.Equal("\"ada\"", (await client.Interop.Login(JsonOf("{\"name\":\"ada\"}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Matches("^[A-Za-z0-9_-]{22}$", client.Router.SessionToken.ToString());
        Assert.Equal("\"ada\"", (await client.Interop.Whoami(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("null", (await client.Interop.Logout(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Null(client.Router.SessionToken);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_call_presenting_the_session_it_learned_runs_in_it_the_session_opened_anew_presented_anew_and_none_presented_once_it_ended(string transport)
    {
        await using var client = await ConnectedOver(transport);

        var presenting = new RequestOptions { Credential = Credential.Opaque() };

        async Task<string> Answered((Func<JsonElement, BoundCall<JsonElement>> Requester, string Payload) call)
        {
            return (await call.Requester(JsonOf(call.Payload))(presenting).WaitAsync(Patience, Cancelled)).GetRawText();
        }

        async Task<FailureException> Refused(Func<JsonElement, BoundCall<JsonElement>> requester)
        {
            return await Assert.ThrowsAsync<FailureException>(() =>
            {
                return requester(JsonOf("null"))(presenting).WaitAsync(Patience, Cancelled);
            });
        }

        var before = await Refused(client.Interop.Login);

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (before.Code, before.Origin));
        Assert.Equal("\"ada\"", (await client.Interop.Login(JsonOf("{\"name\":\"ada\"}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("\"ada\"", await Answered((client.Interop.Whoami, "null")));
        Assert.Equal("\"bob\"", await Answered((client.Interop.Login, "{\"name\":\"bob\"}")));
        Assert.Equal("\"bob\"", await Answered((client.Interop.Whoami, "null")));
        Assert.Equal("null", await Answered((client.Interop.Logout, "null")));

        var ended = await Refused(client.Interop.Whoami);

        Assert.Equal(((ushort)ProtocolCode.SessionRequired, FailureOrigin.Local), (ended.Code, ended.Origin));
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task Login_and_register_hold_a_duration_as_section_1_4_does_a_fraction_rounded_one_under_a_millisecond_or_past_2_31_minus_1_refused_with_PROCEDURE_FAILED_nothing_opened_or_registered(string transport)
    {
        await using var client = await ConnectedOver(transport);

        async Task<ushort> CodeOf(BoundCall<JsonElement> requester)
        {
            return (await Assert.ThrowsAsync<FailureException>(() =>
            {
                return requester().WaitAsync(Patience, Cancelled);
            })).Code;
        }

        foreach (var refused in new[] { "{\"name\":\"ada\",\"sessionTimeout\":0.4}", "{\"connectionTimeout\":2147483648,\"name\":\"ada\"}", "{\"name\":\"ada\",\"sessionTimeout\":-1}" })
        {
            Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(client.Interop.Login(JsonOf(refused))));
        }

        Assert.Equal((ushort)ProtocolCode.SessionRequired, await CodeOf(client.Interop.Whoami(JsonOf("null"))));
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(client.Interop.Register(JsonOf("{\"destination\":41,\"timeout\":0}"))));
        Assert.Equal("41", (await client.Interop.Register(JsonOf("{\"destination\":41,\"timeout\":1.5}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("true", (await client.Interop.Unregister(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());

        // a session timeout given ends its session once past, rounded; silence counts it alone
        Assert.Equal("\"ada\"", (await client.Interop.Login(JsonOf("{\"connectionTimeout\":2147483647,\"name\":\"ada\",\"sessionTimeout\":99.6}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        // ! the other side's timer may not have fired on a loaded runner, and an ask that finds the
        // session still there counts afresh: ask again after each silence, until one ends it
        var code = (ushort)0;

        for (var tries = 0; tries < 10 && code != (ushort)ProtocolCode.SessionRequired; tries += 1)
        {
            await Task.Delay(400, Cancelled);

            try
            {
                await client.Interop.Whoami(JsonOf("null"))().WaitAsync(Patience, Cancelled);
            }
            catch (FailureException failure)
            {
                code = failure.Code;
            }
        }

        Assert.Equal((ushort)ProtocolCode.SessionRequired, code);
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_JWT_presented_by_default_runs_in_its_credential_s_session_whoami_answers_its_sub_and_logout_is_refused_ACCESS_DENIED(string transport)
    {
        await using var client = await ConnectedOver(transport);

        // an access token of the HS256 issuer for grace, an hour on the platform's clock, signed with
        // the service file's published key
        var key = InteropCredentials.Of(TimeProvider.System).Keys.Single((held) =>
        {
            return held.Algorithm == JwtAlgorithm.Hs256;
        });
        var part = (object value) =>
        {
            return System.Buffers.Text.Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(value));
        };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var signingInput = $"{part(new Dictionary<string, string> { ["alg"] = "HS256", ["typ"] = "at+jwt" })}.{part(new Dictionary<string, object>
        {
            ["aud"] = InteropCredentials.Of(TimeProvider.System).Audience!,
            ["client_id"] = "bead-interop-client",
            ["exp"] = now + 3_600,
            ["iat"] = now,
            ["iss"] = key.Issuer,
            ["jti"] = "at-interop-0001",
            ["sub"] = "grace",
        })}";
        var signature = System.Security.Cryptography.HMACSHA256.HashData(
            System.Buffers.Text.Base64Url.DecodeFromChars(key.Jwk.GetProperty("k").GetString()!),
            System.Text.Encoding.ASCII.GetBytes(signingInput));

        client.Router.Credential = Credential.Jwt($"{signingInput}.{System.Buffers.Text.Base64Url.EncodeToString(signature)}");

        // a login opens the connection's session, whatever the call presents
        Assert.Equal("\"ada\"", (await client.Interop.Login(JsonOf("{\"name\":\"ada\"}"))().WaitAsync(Patience, Cancelled)).GetRawText());
        Assert.Equal("\"grace\"", (await client.Interop.Whoami(JsonOf("null"))().WaitAsync(Patience, Cancelled)).GetRawText());

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.Interop.Logout(JsonOf("null"))().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.AccessDenied, FailureOrigin.Peer), (refused.Code, refused.Origin));
        Assert.Equal("a call in a credential's session ends no connection's session", refused.Detail);
        Assert.NotNull(client.Router.Credential);

        // the connection's session stays, a call presenting none running in it
        Assert.Equal("\"ada\"", (await client.Interop.Whoami(JsonOf("null"))(new RequestOptions { Credential = Credential.None }).WaitAsync(Patience, Cancelled)).GetRawText());
    }

    [Theory(Skip = Reason, SkipUnless = nameof(IsInterop))]
    [InlineData(WebSocket)]
    [InlineData(Http)]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task An_ELSEWHERE_goes_in_each_POST_s_Authorization_over_HTTP_and_in_its_upgrade_s_over_a_WebSocket_whoami_answers_the_sub_it_names(string transport)
    {
        if (transport == WebSocket)
        {
            // its upgrade carries none: a call presenting one fails before it goes
            await using var bare = await ConnectedOver(transport);
            var none = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return bare.Interop.Whoami(JsonOf("null"))(new RequestOptions { Credential = Credential.Elsewhere("Interop sub=ada") }).WaitAsync(Patience, Cancelled);
            });

            Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local), (none.Code, none.Origin));
        }

        // * the one place one side's client writes the field and the other side's server reads it
        await using var client = await ConnectedOver(transport, "Interop sub=ada");

        var whoami = client.Interop.Whoami(JsonOf("null"));

        Assert.Equal("\"ada\"", (await whoami(new RequestOptions { Credential = Credential.Elsewhere("Interop sub=ada") }).WaitAsync(Patience, Cancelled)).GetRawText());

        // over a broker, as over HTTP, each request carries its own (spec 15.22)
        if (transport != WebSocket)
        {
            return;
        }

        // over a WebSocket, those bytes alone: another credential fails before it goes
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return whoami(new RequestOptions { Credential = Credential.Elsewhere("Interop sub=bob") }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Local), (refused.Code, refused.Origin));
    }

    // * what a broker alone has (spec 15.18 to 15.21, 15.25 to 15.31)

    [Theory]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_name_served_by_two_in_one_group_answers_each_of_sixteen_connections_and_no_OPEN_reaches_both(string transport)
    {
        await server.Ports();

        var link = await LinkedOver(transport);
        var before = link.Adapter.AcceptedTwice;

        for (var index = 0; index < 16; index += 1)
        {
            await using var each = new BrokerClient(link.Participant.Client());
            var payload = $"{{\"index\":{index}}}";

            await each.Transport.Connect(new BrokerConnectOptions { Server = "interop-both" }, Cancelled);
            Assert.Equal(payload, (await new InteropClient(each).Echo(JsonOf(payload))().WaitAsync(Patience, Cancelled)).GetRawText());
        }

        // ! the count proves one group of a member of each side: two would hand each OPEN to both
        Assert.Equal(0, link.Adapter.AcceptedTwice - before);
    }

    [Theory]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_parcel_its_broker_delivers_twice_is_answered_once(string transport)
    {
        await using var client = await ConnectedOver(transport);
        var link = await LinkedOver(transport);

        link.Adapter.IsCopying = true;

        try
        {
            Assert.Equal("{\"copied\":true}", (await client.Interop.Echo(JsonOf("{\"copied\":true}"))().WaitAsync(Patience, Cancelled)).GetRawText());
            Assert.Equal(new string('x', 10), (await client.Interop.Bytes(JsonOf("{\"length\":10}"))().WaitAsync(Patience, Cancelled)).GetString());
        }
        finally
        {
            link.Adapter.IsCopying = false;
        }
    }

    [Fact(Skip = NoBroker, SkipUnless = nameof(IsMqttInterop))]
    [Trait("transport", "MQTT")]
    public async Task A_string_of_100_000_characters_goes_in_parts_both_ways_under_its_broker_s_Maximum_Packet_Size()
    {
        await using var client = await ConnectedOver(Mqtt);
        var text = new string('y', 100_000);

        // compared, not diffed: a hundred thousand characters would bury a failure
        Assert.True((await client.Interop.Echo(JsonOf($"\"{text}\""))().WaitAsync(Patience, Cancelled)).GetString() == text);
    }

    [Theory]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_link_cut_at_its_relay_closes_its_connection_unclean_as_a_dropped_socket_does(string transport)
    {
        await server.Ports();

        var link = await LinkedOver(transport);
        await using var client = new BrokerClient(link.Participant.Client());
        var closes = new ConcurrentQueue<bool>();

        client.Transport.Close += (isClean, _) =>
        {
            closes.Enqueue(isClean);
        };
        await client.Transport.Connect(new BrokerConnectOptions { Server = "interop-ts" }, Cancelled);
        Assert.Equal("\"before\"", (await new InteropClient(client).Echo(JsonOf("\"before\""))().WaitAsync(Patience, Cancelled)).GetRawText());
        link.Relay.Cut();
        await Until(() =>
        {
            return !closes.IsEmpty;
        });
        Assert.Equal([false], closes);

        // its participant links anew of its own, as its reconnection says
        await Until(() =>
        {
            return link.Participant.IsLinked;
        });
        Assert.True(link.Participant.IsLinked);
    }

    [Theory]
    [InlineData(Mqtt, Skip = NoBroker, SkipUnless = nameof(IsMqttInterop), Traits = ["transport", "MQTT"])]
    [InlineData(Amqp, Skip = NoAmqpBroker, SkipUnless = nameof(IsAmqpInterop), Traits = ["transport", "AMQP"])]
    public async Task A_link_lost_connects_anew_and_the_next_connection_through_the_name_is_answered(string transport)
    {
        await server.Ports();

        var link = await LinkedOver(transport);
        var former = link.Participant.Incarnation;

        link.Relay.Cut();
        await Until(() =>
        {
            return link.Participant.IsLinked && link.Participant.Incarnation != former;
        });
        Assert.NotEqual(former, link.Participant.Incarnation);

        await using var next = new BrokerClient(link.Participant.Client());

        await next.Transport.Connect(new BrokerConnectOptions { Server = "interop-ts" }, Cancelled);
        Assert.Equal("\"after\"", (await new InteropClient(next).Echo(JsonOf("\"after\""))().WaitAsync(Patience, Cancelled)).GetRawText());
    }

    // the C# client's link over a broker, MQTT 5's or AMQP 1.0's
    private Task<Linked> LinkedOver(string transport)
    {
        return transport == Amqp ? amqp.Linked() : mqtt.Linked();
    }

    // waits, a while at most, until it holds
    private static async Task Until(Func<bool> holds)
    {
        var watch = Stopwatch.StartNew();

        while (!holds() && watch.Elapsed < Patience)
        {
            await Task.Delay(10, Cancelled);
        }
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

    // a client connected over one transport or the other: its services, its router, the interop's
    // generated client over it, made once, at its first use, and what lets it go
    private sealed class Connected(IClient client, Func<ValueTask> dispose) : IAsyncDisposable
    {
        private InteropClient? _interop;

        public ServiceManager Services
        {
            get
            {
                return client.Services;
            }
        }

        public RouterClient Router
        {
            get
            {
                return client.Router;
            }
        }

        public InteropClient Interop
        {
            get
            {
                return _interop ??= new InteropClient(client);
            }
        }

        // the generated client made with its windows, before any other use
        public InteropClient InteropWith(InteropWindows windows)
        {
            _interop = new InteropClient(client, new() { Windows = windows });

            return _interop;
        }

        public ValueTask DisposeAsync()
        {
            return dispose();
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
            return new JsonPayloads().Decode(response);
        }
    }

    /// <summary>A client of Bead over a broker's client transport: its router and its services, as each other client's.</summary>
    private sealed class BrokerClient : IClient
    {
        public BrokerClient(BrokerTransportClient transport)
        {
            Transport = transport;
            Router = new RouterClient(transport);
            Services = new ServiceManager(Router);
        }

        public BrokerTransportClient Transport { get; }

        public RouterClient Router { get; }

        public ServiceManager Services { get; }

        public Task Disconnect(TransportDisconnectOptions? options = null)
        {
            return Transport.CloseConnection(options);
        }

        public Task Reconnect(TransportReconnectOptions? options = null)
        {
            return Transport.Reconnect(options);
        }

        public async ValueTask DisposeAsync()
        {
            Router.Dispose();
            await Transport.DisposeAsync();
        }
    }

    /// <summary>
    /// The C# client's adapter over a broker, MQTT 5's or AMQP 1.0's, wrapped so that a test has it
    /// publish each parcel twice, and counting each ACCEPT it read for an opener's half it read one
    /// for already: a second member of a group, or a second group, handed the OPEN.
    /// </summary>
    public sealed class CopyingAdapter : IBrokerAdapter
    {
        private readonly IBrokerAdapter _inner;
        private readonly ConcurrentDictionary<ulong, int> _answered = new();
        private int _acceptedTwice;

        public CopyingAdapter(IBrokerAdapter inner)
        {
            ArgumentNullException.ThrowIfNull(inner);

            _inner = inner;
            inner.Message += Count;
        }

        public event Action<BrokerMessage>? Message
        {
            add
            {
                _inner.Message += value;
            }

            remove
            {
                _inner.Message -= value;
            }
        }

        public event Action<BrokerDown>? Down
        {
            add
            {
                _inner.Down += value;
            }

            remove
            {
                _inner.Down -= value;
            }
        }

        /// <summary>Whether each parcel is published twice, as a broker that delivers one twice does.</summary>
        public bool IsCopying { get; set; }

        /// <summary>The ACCEPTs read for an opener's half one was read for already.</summary>
        public int AcceptedTwice
        {
            get
            {
                return Volatile.Read(ref _acceptedTwice);
            }
        }

        public string Type
        {
            get
            {
                return _inner.Type;
            }
        }

        public string Id
        {
            get
            {
                return _inner.Id;
            }
        }

        public BrokerCapabilities Capabilities
        {
            get
            {
                return _inner.Capabilities;
            }
        }

        public BrokerDelivery Delivery
        {
            get
            {
                return _inner.Delivery;
            }
        }

        public bool IsSecure
        {
            get
            {
                return _inner.IsSecure;
            }
        }

        public long ReceiveBound(IReadOnlyList<string> topic)
        {
            return _inner.ReceiveBound(topic);
        }

        public Task Start(BrokerStart? start = null)
        {
            return _inner.Start(start);
        }

        public Task Subscribe(IReadOnlyList<string> topic, BrokerSubscription? subscription = null)
        {
            return _inner.Subscribe(topic, subscription);
        }

        public Task Unsubscribe(IReadOnlyList<string> topic)
        {
            return _inner.Unsubscribe(topic);
        }

        public Task<BrokerPublished> Publish(BrokerPublication publication)
        {
            if (IsCopying)
            {
                _ = _inner.Publish(publication).ContinueWith(
                    (copied) =>
                    {
                        _ = copied.Exception;
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }

            return _inner.Publish(publication);
        }

        public long MaximumPayloadBytes(IReadOnlyList<string> topic)
        {
            return _inner.MaximumPayloadBytes(topic);
        }

        public Task Stop()
        {
            return _inner.Stop();
        }

        // * an ACCEPT for an opener's half it read one for already: a second member of a group, or
        // a second group, handed the OPEN
        private void Count(BrokerMessage message)
        {
            if (message.Topic is not [_, "i", _] || BrokerParcels.Read(message.Payload) is not { Verdict: ParcelVerdict.Taken, Parcel: { Kind: BrokerParcelKinds.Accept } accept })
            {
                return;
            }

            var count = _answered.AddOrUpdate(accept.Opener, 1, (_, before) =>
            {
                return before + 1;
            });

            if (count > 1)
            {
                Interlocked.Increment(ref _acceptedTwice);
            }
        }
    }

    /// <summary>
    /// The C# side over MQTT 5, linked once, on the first test that asks it: its client's
    /// participant <c>cs-client</c>, through a relay of the test's own that a cut ends, linking anew
    /// a tenth of a second after a loss; and a C# server of the interop service of its own,
    /// participant <c>cs-server</c>, serving <c>interop-cs</c> alone and <c>interop-both</c> in one
    /// group with the TypeScript server, as the C# interop server does.
    /// </summary>
    public sealed class MqttSide : IAsyncDisposable
    {
        private readonly BrokerSide _side = new((
            () =>
            {
                return MqttFixture.Url;
            },
            (linked) =>
            {
                return new MqttBrokerAdapter(new MqttBrokerAdapterOptions { Id = linked.Id, Password = MqttFixture.Password, Uri = linked.Uri });
            }
        ));

        /// <summary>Its link and its servers, started once.</summary>
        internal Task<Linked> Linked()
        {
            return _side.Linked();
        }

        public ValueTask DisposeAsync()
        {
            return _side.DisposeAsync();
        }
    }

    /// <summary>
    /// The C# side over AMQP 1.0, alike: <c>cs-client</c> through a relay of its own, and
    /// <c>cs-server</c> serving <c>interop-cs</c> alone and <c>interop-both</c> in one group, a name's
    /// queue its participants compete on, with the TypeScript server.
    /// </summary>
    public sealed class AmqpSide : IAsyncDisposable
    {
        private readonly BrokerSide _side = new((
            () =>
            {
                return AmqpFixture.Url;
            },
            (linked) =>
            {
                return new AmqpBrokerAdapter(new AmqpBrokerAdapterOptions { Id = linked.Id, Password = AmqpFixture.Password, Uri = linked.Uri });
            }
        ));

        /// <summary>Its link and its servers, started once.</summary>
        internal Task<Linked> Linked()
        {
            return _side.Linked();
        }

        public ValueTask DisposeAsync()
        {
            return _side.DisposeAsync();
        }
    }

    /// <summary>
    /// The C# side over one broker, linked once, on the first test that asks it: its client's
    /// participant <c>cs-client</c>, through a relay of the test's own that a cut ends, linking anew
    /// a tenth of a second after a loss; and its server's participant <c>cs-server</c>.
    /// </summary>
    internal sealed class BrokerSide((Func<Uri> Broker, Func<(string Id, Uri Uri), IBrokerAdapter> AdapterOf) linking) : IAsyncDisposable
    {
        private readonly SemaphoreSlim _starting = new(1, 1);
        private Linked? _linked;
        private BrokerParticipant? _serving;
        private List<Server<string>> _servers = [];

        /// <summary>Its link and its servers, started once.</summary>
        public async Task<Linked> Linked()
        {
            await _starting.WaitAsync(TestContext.Current.CancellationToken);

            try
            {
                if (_linked is null)
                {
                    _serving = new BrokerParticipant(linking.AdapterOf(("cs-server", linking.Broker())));

                    BrokerTransportServer[] transports =
                    [
                        _serving.Server(new BrokerTransportServerOptions { Names = ["interop-cs"] }),
                        _serving.Server(new BrokerTransportServerOptions { Names = ["interop-both"], IsInGroup = true }),
                    ];

                    _servers = [.. transports.Select((transport) =>
                    {
                        var served = new Server<string>(transport, new ServerOptions { Credentials = InteropCredentials.Of(TimeProvider.System) });

                        InteropHandlers.Offer(served);

                        return served;
                    })];

                    foreach (var transport in transports)
                    {
                        await transport.Start();
                    }

                    var relay = LinkRelay.To(linking.Broker());
                    var adapter = new CopyingAdapter(linking.AdapterOf(("cs-client", relay.Uri)));
                    var participant = new BrokerParticipant(adapter, new BrokerParticipantOptions
                    {
                        Reconnect = new TransportReconnectOptions
                        {
                            Delay = (_, _) =>
                            {
                                return TimeSpan.FromMilliseconds(100);
                            },
                            MaximumAttempts = int.MaxValue,
                        },
                    });

                    await participant.Start();
                    _linked = new Linked(participant, adapter, relay);
                }

                return _linked;
            }
            finally
            {
                _starting.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (_linked is { } linked)
            {
                await linked.Participant.DisposeAsync();
                await linked.Relay.DisposeAsync();
            }

            foreach (var served in _servers)
            {
                await served.DisposeAsync();
            }

            if (_serving is not null)
            {
                await _serving.DisposeAsync();
            }

            _starting.Dispose();
        }
    }

    /// <summary>The C# client's link over a broker: its participant, its adapter, and the relay a cut ends.</summary>
    internal sealed record Linked(BrokerParticipant Participant, CopyingAdapter Adapter, LinkRelay Relay);

    /// <summary>
    /// The TypeScript server of the interop service, started once for every class, on the first test
    /// that asks its ports, and stopped by closing its input.
    /// </summary>
    public sealed class TypeScriptServer : IAsyncDisposable
    {
        private readonly SemaphoreSlim _starting = new(1, 1);
        private Process? _process;
        private (int Port, int HttpPort, int GatewayPort) _ports;

        /// <summary>The ports it listens on, over WebSocket and over HTTP, once started.</summary>
        public async Task<(int Port, int HttpPort, int GatewayPort)> Ports()
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

        private static async Task<(Process Process, (int Port, int HttpPort, int GatewayPort) Ports)> Start()
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

                    if (document.RootElement.TryGetProperty("port", out var port) && document.RootElement.TryGetProperty("httpPort", out var httpPort) && document.RootElement.TryGetProperty("gatewayPort", out var gatewayPort))
                    {
                        return (process, (port.GetInt32(), httpPort.GetInt32(), gatewayPort.GetInt32()));
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
