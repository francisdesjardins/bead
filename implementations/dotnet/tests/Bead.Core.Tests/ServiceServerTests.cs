namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceServer{TService, TData}"/>: the greeter's server side, offered on a server
/// linked in memory to a client whose <see cref="ServiceClient{TService}"/> calls it; the twins of
/// the TypeScript side's <c>service-server.test.ts</c>, but the unlisted code, which no C# failure
/// class holds.
/// </summary>
public sealed class ServiceServerTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // a hook that admits every call
    private static readonly AdmissionHook Loud = new()
    {
        Admits = (_) =>
        {
            return true;
        },
    };

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // the greeter's server side, its hook admitting every call unless one is given
    private static ServiceServer<GreeterProcedures, string> GreeterOf(AdmissionHook? hook = null)
    {
        return new ServiceServer<GreeterProcedures, string>(
            GreeterProcedures.All,
            new ServiceServerOptions<GreeterProcedures> { Admissions = new GreeterAdmissions { Loud = hook ?? Loud } });
    }

    private static ServiceClient<GreeterProcedures> ClientOf(ServiceLink link)
    {
        return new ServiceClient<GreeterProcedures>(GreeterProcedures.All, link.Client);
    }

    // what a call fails with, by its code
    private static async Task<ushort> CodeOf(Task call)
    {
        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return call.WaitAsync(Patience, Cancelled);
        });

        return failure.Code;
    }

    private static Task Answered(IServiceResponse<string, NoFailure> response)
    {
        return response.Answer("x");
    }

    // definition

    [Fact]
    public async Task Admits_every_call_with_none()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);

        greeter.On(GreeterProcedures.SayHello, (request, response) =>
        {
            return response.Answer($"Hello, {request.Payload}!");
        });
        greeter.Offer(link.Server);

        Assert.Equal("Hello, Bead!", await client.RequesterOf(GreeterProcedures.SayHello)("Bead")().WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Refuses_a_call_in_no_session_SESSION_REQUIRED()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);

        greeter.On(GreeterProcedures.Whoami, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        greeter.Offer(link.Server);

        Assert.Equal((ushort)ProtocolCode.SessionRequired, await CodeOf(client.RequesterOf(GreeterProcedures.Whoami)("who")()));
    }

    [Fact]
    public async Task Refuses_with_a_hook_s_detail_ACCESS_DENIED_in_a_session_or_in_none()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf(new AdmissionHook
        {
            Admits = (_) =>
            {
                return false;
            },
            Detail = "too quiet",
        });
        var client = ClientOf(link);
        var refusals = new List<(ushort Code, string Detail)>();

        greeter.On(GreeterProcedures.Login, (request, response) =>
        {
            link.Server.Sessions.Set(link.Server.Sessions.Create(request.ConnectionHandle));

            return response.Answer("in");
        });
        greeter.On(GreeterProcedures.Shout, (request, response) =>
        {
            return response.Answer(request.Payload.ToUpperInvariant());
        });
        greeter.Offer(link.Server);

        foreach (var _ in new[] { "none", "in one" })
        {
            var refusal = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return client.RequesterOf(GreeterProcedures.Shout)("hi")().WaitAsync(Patience, Cancelled);
            });

            refusals.Add((refusal.Code, refusal.Detail));
            await client.RequesterOf(GreeterProcedures.Login)("ada")().WaitAsync(Patience, Cancelled);
        }

        Assert.Equal([((ushort)ProtocolCode.AccessDenied, "too quiet"), ((ushort)ProtocolCode.AccessDenied, "too quiet")], refusals);
    }

    [Fact]
    public async Task Answers_PROCEDURE_FAILED_to_a_hook_that_throws_and_reports_it()
    {
        await using var link = await ServiceLink.Open();
        var thrown = new InvalidOperationException("the hook broke");
        var greeter = GreeterOf(new AdmissionHook
        {
            Admits = (_) =>
            {
                throw thrown;
            },
        });
        var client = ClientOf(link);
        var reported = new TaskCompletionSource<(Exception Reason, string? ConnectionHandle)>(TaskCreationOptions.RunContinuationsAsynchronously);

        link.Server.Router.Error += (reason, connectionHandle) =>
        {
            reported.TrySetResult((reason, connectionHandle));
        };
        greeter.On(GreeterProcedures.Shout, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        greeter.Offer(link.Server);

        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(client.RequesterOf(GreeterProcedures.Shout)("hi")()));

        // * reported with the connection of the call it failed
        var (reason, connectionHandle) = await reported.Task.WaitAsync(Patience, Cancelled);

        Assert.Same(thrown, reason);
        Assert.Equal(ServiceLink.Handle, connectionHandle);
        Assert.Single(link.Reported);
    }

    [Fact]
    public void Refuses_a_hook_the_options_lack_one_no_procedure_names_and_one_that_is_no_hook()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceServer<GreeterProcedures, string>(
                GreeterProcedures.All,
                new ServiceServerOptions<GreeterProcedures> { Admissions = new GreeterAdmissions { Loud = null! } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceServer<GreeterProcedures, string>(
                GreeterProcedures.All,
                new ServiceServerOptions<GreeterProcedures> { Admissions = new GreeterAdmissions { Loud = new AdmissionHook { Admits = null! } } });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceServer<GreeterProcedures, string>(GreeterProcedures.All, new ServiceServerOptions<GreeterProcedures> { Admissions = new AnyNames() });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceServer<GreeterProcedures, string>(
                GreeterProcedures.All,
                new ServiceServerOptions<GreeterProcedures> { Admissions = new AnyNames(new Dictionary<string, AdmissionHook> { ["loud"] = Loud, ["quiet"] = Loud }) });
        });

        // each hook given is checked in turn, as the TypeScript side checks it
        var first = Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceServer<GreeterProcedures, string>(
                GreeterProcedures.All,
                new ServiceServerOptions<GreeterProcedures> { Admissions = new AnyNames(new Dictionary<string, AdmissionHook> { ["loud"] = null!, ["quiet"] = Loud }) });
        });

        Assert.StartsWith("the hook loud admits by a function", first.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Answers_a_failure_its_procedure_lists()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);

        greeter.On(GreeterProcedures.SayHello, (request, response) =>
        {
            return request.Payload.Length == 0
                ? response.Fail(SayHelloFailure.NobodyToGreet, "a name is needed")
                : response.Answer($"Hello, {request.Payload}!");
        });
        greeter.Offer(link.Server);

        var failure = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.RequesterOf(GreeterProcedures.SayHello)("")().WaitAsync(Patience, Cancelled);
        });

        Assert.True(GreeterProcedures.Failures.Is(failure, SayHelloFailure.NobodyToGreet));
        Assert.Equal(((ushort)1, "a name is needed"), (failure.Code, failure.Detail));
    }

    [Fact]
    public async Task Registers_before_and_after_offer()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);

        greeter.On(GreeterProcedures.SayHello, (request, response) =>
        {
            return response.Answer($"Hello, {request.Payload}!");
        });
        greeter.Offer(link.Server);
        greeter.On(GreeterProcedures.Login, (_, response) =>
        {
            return response.Answer("in");
        });

        Assert.Equal("Hello, Bead!", await client.RequesterOf(GreeterProcedures.SayHello)("Bead")().WaitAsync(Patience, Cancelled));
        Assert.Equal("in", await client.RequesterOf(GreeterProcedures.Login)("ada")().WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Refuses_on_twice_offered_or_not()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var other = new RequestProcedure<GreeterProcedures, string, string, NoFailure>(
            GreeterProcedures.Login.Procedure,
            GreeterProcedures.Login.Bindings);

        greeter.On(GreeterProcedures.Shout, (_, response) =>
        {
            return Answered(response);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            greeter.On(GreeterProcedures.Shout, (_, response) =>
            {
                return Answered(response);
            });
        });

        greeter.Offer(link.Server);
        greeter.On(GreeterProcedures.Login, (_, response) =>
        {
            return Answered(response);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            greeter.On(GreeterProcedures.Login, (_, response) =>
            {
                return Answered(response);
            });
        });

        // * a descriptor the service does not hold, at an address it holds, is no procedure it
        // answers: a command, or another service's, does not compile
        Assert.Throws<ArgumentException>(() =>
        {
            greeter.On(other, (_, response) =>
            {
                return Answered(response);
            });
        });
    }

    [Fact]
    public async Task Refuses_a_second_offer()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();

        greeter.Offer(link.Server);

        Assert.Throws<InvalidOperationException>(() =>
        {
            greeter.Offer(link.Server);
        });
    }

    [Fact]
    public async Task Makes_each_command_s_requester_once_as_it_is_offered_and_refuses_one_called_before()
    {
        await using var link = await ServiceLink.Open();
        var server = new InterceptedServer(link.Server);
        var greeter = GreeterOf();
        var client = ClientOf(link);
        var clock = greeter.CommandOf(GreeterProcedures.Clock);

        client.On(GreeterProcedures.Clock, (request, response) =>
        {
            return response.Answer($"noon, {request.Payload}");
        });

        Assert.Throws<InvalidOperationException>(() =>
        {
            return clock("now");
        });
        Assert.Empty(server.Intercepted.Declared);

        greeter.Offer(server);

        foreach (var asked in new[] { "now", "again" })
        {
            Assert.Equal(
                $"noon, {asked}",
                await greeter.CommandOf(GreeterProcedures.Clock)(asked)(new RequestOptions { ConnectionHandle = ServiceLink.Handle }).WaitAsync(Patience, Cancelled));
        }

        Assert.Equal(["requester clock", "requester guarded"], server.Intercepted.Declared.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Notifies_nothing_before_it_is_offered_and_resolves()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);
        var heard = new List<string>();
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var news = greeter.NotifierOf(GreeterProcedures.News);

        await news("before", null).WaitAsync(Patience, Cancelled);

        greeter.On(GreeterProcedures.News, async (_, response) =>
        {
            await response.RegisterNotification();
            await response.Answer("subscribed");
        });
        greeter.Offer(link.Server);

        await using var registration = await client.NotificationOf(GreeterProcedures.News).Register("subscribe", (notification) =>
        {
            lock (heard)
            {
                heard.Add(notification);
            }

            first.TrySetResult();

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await news("after", null).WaitAsync(Patience, Cancelled);
        await first.Task.WaitAsync(Patience, Cancelled);

        // * every notification heard, collected: the one after its offer, once, none before
        lock (heard)
        {
            Assert.Equal(["after"], heard);
        }
    }

    [Fact]
    public async Task Lists_the_procedures_without_a_resolver_which_the_router_answers_PROCEDURE_UNKNOWN()
    {
        await using var link = await ServiceLink.Open();
        var greeter = GreeterOf();
        var client = ClientOf(link);

        greeter.On(GreeterProcedures.SayHello, (_, response) =>
        {
            return response.Answer("hi");
        });
        greeter.Offer(link.Server);

        Assert.Equal(
            ["login", "news", "shout", "whoami"],
            greeter.ProceduresWithoutResolver().Select((procedure) =>
            {
                return procedure.ProcedureName;
            }).Order(StringComparer.Ordinal));
        Assert.Equal((ushort)ProtocolCode.ProcedureUnknown, await CodeOf(client.RequesterOf(GreeterProcedures.Login)("ada")()));
    }

    [Fact]
    public async Task Declares_each_resolver_and_requester_once_to_a_registry()
    {
        await using var link = await ServiceLink.Open();
        var server = new InterceptedServer(link.Server);
        var greeter = GreeterOf();

        greeter.On(GreeterProcedures.SayHello, (_, response) =>
        {
            return response.Answer("hi");
        });
        greeter.On(GreeterProcedures.News, (_, response) =>
        {
            return response.Answer("subscribed");
        });
        greeter.Offer(server);
        greeter.On(GreeterProcedures.Login, (_, response) =>
        {
            return response.Answer("in");
        });

        await Record.ExceptionAsync(() =>
        {
            return greeter.CommandOf(GreeterProcedures.Clock)("now")(new RequestOptions
            {
                ConnectionHandle = ServiceLink.Handle,
                Timeout = TimeSpan.FromMilliseconds(50),
            }).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(
            ["requester clock", "requester guarded", "resolver login", "resolver news", "resolver sayHello"],
            server.Intercepted.Declared.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Answers_PAYLOAD_INVALID_with_its_violations_to_a_request_its_rules_refuse_before_its_resolver()
    {
        await using var link = await ServiceLink.Open();
        var server = new ServiceServer<CheckedProcedures, string>(CheckedProcedures.All);
        var client = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client);
        var seen = new List<string>();

        server.On(CheckedProcedures.Echo, (request, response) =>
        {
            seen.Add(request.Payload);

            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        Assert.Equal("hi", await client.RequesterOf(CheckedProcedures.Echo)("hi")().WaitAsync(Patience, Cancelled));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return client.RequesterOf(CheckedProcedures.Echo)("")().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal(((ushort)ProtocolCode.PayloadInvalid, FailureScope.Protocol), (refused.Code, refused.Scope));
        Assert.Equal(FailureOrigin.Peer, refused.Origin);
        Assert.Equal(CheckedProcedures.Detail, refused.Detail);

        var violations = Violations.Of(refused.Failure);
        var violation = Assert.Single(violations.Violations);

        Assert.Equal(
            ("string.min_len", "must be at least 1 characters", "{\"min_len\":\"1\"}", (long?)0),
            (violation.RuleId, violation.Message, violation.Bounds?.GetRawText(), violations.More));

        // * the protocol's answer, never its resolver's: nothing ran, nothing to report
        Assert.Equal(["hi"], seen);
        Assert.Empty(link.Reported);
    }

    [Fact]
    public async Task Answers_PROCEDURE_FAILED_to_a_validate_that_throws_and_reports_it()
    {
        await using var link = await ServiceLink.Open();
        var broken = new RequestProcedure<CheckedProcedures, string, string, NoFailure>(
            CheckedProcedures.Echo.Procedure,
            CheckedProcedures.BindingsOf((request, options) =>
            {
                if (request.Length == 0)
                {
                    throw new ArgumentOutOfRangeException(nameof(request), "a rule that cannot judge");
                }

                return CheckedProcedures.NotEmpty(request, options);
            }));
        var server = new ServiceServer<CheckedProcedures, string>([broken]);
        var client = new ServiceClient<CheckedProcedures>([broken], link.Client);
        var seen = new List<string>();

        server.On(broken, (request, response) =>
        {
            seen.Add(request.Payload);

            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        // * one it judges goes as ever; one it fails to judge fails, its resolver never reached
        Assert.Equal("hi", await client.RequesterOf(broken)("hi")().WaitAsync(Patience, Cancelled));
        Assert.Equal((ushort)ProtocolCode.ProcedureFailed, await CodeOf(client.RequesterOf(broken)("")()));
        Assert.Equal(["hi"], seen);
        Assert.IsType<ArgumentOutOfRangeException>(await link.FirstReported.WaitAsync(Patience, Cancelled));
        Assert.Single(link.Reported);
    }

    [Fact]
    public async Task Validates_a_command_before_it_goes_when_its_options_say_so()
    {
        await using var link = await ServiceLink.Open();
        var validating = new ServiceServer<CheckedProcedures, string>(
            CheckedProcedures.All,
            new ServiceServerOptions<CheckedProcedures> { Admissions = new CheckedAdmissions(), Validates = true });
        var client = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client);
        var heard = new List<string>();

        client.On(CheckedProcedures.Shout, (request, response) =>
        {
            heard.Add(request.Payload);

            return response.Answer(request.Payload.ToUpperInvariant());
        });
        validating.Offer(link.Server);

        var call = new RequestOptions { ConnectionHandle = ServiceLink.Handle };
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return validating.CommandOf(CheckedProcedures.Shout)("")(call).WaitAsync(Patience, Cancelled);
        });

        // * refused here, before it went: the client never heard it
        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, refused.Code);
        Assert.Equal((FailureOrigin.Local, RouterSide.Server), (refused.Origin, refused.Side));
        Assert.Equal(CheckedProcedures.Detail, refused.Detail);
        Assert.Empty(heard);
        Assert.Equal("HI", await validating.CommandOf(CheckedProcedures.Shout)("hi")(call).WaitAsync(Patience, Cancelled));
        Assert.Equal(["hi"], heard);
    }
}
