namespace Bead.Tests;

/// <summary>
/// <see cref="ServiceClient{TService}"/>: the greeter's client side, over a client linked in memory
/// to a server whose <see cref="ServiceServer{TService, TData}"/> serves it; the twins of the
/// TypeScript side's <c>service-client.test.ts</c>.
/// </summary>
public sealed class ServiceClientTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

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

    private static ServiceServer<GreeterProcedures, string> GreeterOf()
    {
        return new ServiceServer<GreeterProcedures, string>(
            GreeterProcedures.All,
            new ServiceServerOptions<GreeterProcedures> { Admissions = new GreeterAdmissions { Loud = Loud } });
    }

    // a command's call to the link's one connection
    private static RequestOptions Call
    {
        get
        {
            return new RequestOptions { ConnectionHandle = ServiceLink.Handle };
        }
    }

    // definition

    [Fact]
    public async Task Admits_a_command_by_its_rule()
    {
        await using var link = new ServiceLink();
        var greeter = GreeterOf();
        var client = new ServiceClient<GreeterProcedures>(GreeterProcedures.All, link.Client);

        greeter.On(GreeterProcedures.Login, (request, response) =>
        {
            link.Server.Sessions.Set(link.Server.Sessions.Create(request.ConnectionHandle));

            return response.Answer("in");
        });
        client.On(GreeterProcedures.Clock, (_, response) =>
        {
            return response.Answer("noon");
        });
        client.On(GreeterProcedures.Guarded, (request, response) =>
        {
            return response.Answer($"guarded {request.Payload}");
        });

        // * before the offer, no command is made: the refusal is the layer's, not the router's
        Assert.Throws<InvalidOperationException>(() =>
        {
            return greeter.CommandOf(GreeterProcedures.Guarded)("who");
        });

        greeter.Offer(link.Server);

        Assert.Equal("noon", await greeter.CommandOf(GreeterProcedures.Clock)("now")(Call).WaitAsync(Patience, Cancelled));
        Assert.Equal((ushort)ProtocolCode.SessionRequired, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return greeter.CommandOf(GreeterProcedures.Guarded)("who")(Call).WaitAsync(Patience, Cancelled);
        })).Code);

        // a session learned by the client: the server's command runs in it
        await client.RequesterOf(GreeterProcedures.Login)("ada")().WaitAsync(Patience, Cancelled);

        Assert.Equal("guarded who", await greeter.CommandOf(GreeterProcedures.Guarded)("who")(Call).WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task Refuses_a_command_admitted_by_a_hook_which_a_client_side_is_given_none_of()
    {
        await using var link = new ServiceLink();
        var clock = new CommandProcedure<GreeterProcedures, string, string, NoFailure>(
            new Procedure { ServiceId = 8, ProcedureId = 9, ProcedureName = "clock", ServiceRevision = 1 },
            new ProcedureBindings<string, string> { Admission = AdmissionRule.Hook("loud"), Request = PayloadCodecs.Text, Result = PayloadCodecs.Text });
        var client = new ServiceClient<GreeterProcedures>([clock], link.Client);

        Assert.Throws<ArgumentException>(() =>
        {
            client.On(clock, (_, response) =>
            {
                return response.Answer("noon");
            });
        });
    }

    [Fact]
    public async Task Makes_each_requester_and_notification_once_at_its_window()
    {
        await using var link = new ServiceLink();
        var intercepted = new InterceptedClient(link.Client);
        var windows = new GreeterWindows { News = 4 };
        var client = new ServiceClient<GreeterProcedures>(GreeterProcedures.All, intercepted, new ServiceClientOptions<GreeterProcedures> { Windows = windows });

        Assert.Equal(4, client.NotificationOf(GreeterProcedures.News).Window);

        // * the notification's subscribing call is a requester of its own procedure, declared with it
        Assert.Equal(
            ["requester login", "requester news", "requester news", "requester sayHello", "requester shout", "requester whoami"],
            intercepted.Intercepted.Declared.Order(StringComparer.Ordinal));

        // the same procedure at the same window gives the same notification; at another, a refusal
        Assert.Same(
            client.NotificationOf(GreeterProcedures.News),
            new ServiceClient<GreeterProcedures>(GreeterProcedures.All, intercepted, new ServiceClientOptions<GreeterProcedures> { Windows = windows })
                .NotificationOf(GreeterProcedures.News));
        Assert.Throws<InvalidOperationException>(() =>
        {
            return new ServiceClient<GreeterProcedures>(GreeterProcedures.All, intercepted);
        });
    }

    [Fact]
    public async Task A_request_to_a_procedure_that_notifies_opens_no_subscription()
    {
        await using var link = new ServiceLink();
        var greeter = GreeterOf();
        var client = new ServiceClient<GreeterProcedures>(GreeterProcedures.All, link.Client);
        var opened = new List<bool>();

        greeter.On(GreeterProcedures.News, (request, response) =>
        {
            opened.Add(request.Header.OpensSubscription);

            return response.Answer("headlines");
        });
        greeter.Offer(link.Server);

        Assert.Equal("headlines", await client.RequesterOf(GreeterProcedures.News)("today")().WaitAsync(Patience, Cancelled));
        Assert.Equal([false], opened);
        Assert.Equal(0, (await link.Server.Router.Gauges().WaitAsync(Patience, Cancelled)).Counts["notifiedSubscriptions"]);
    }

    [Fact]
    public async Task Refuses_a_window_for_a_procedure_that_does_not_notify()
    {
        await using var link = new ServiceLink();

        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceClient<GreeterProcedures>(
                GreeterProcedures.All,
                link.Client,
                new ServiceClientOptions<GreeterProcedures> { Windows = new AnyNames(windows: new Dictionary<string, int?> { ["sayHello"] = 1 }) });
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new ServiceClient<GreeterProcedures>(
                GreeterProcedures.All,
                link.Client,
                new ServiceClientOptions<GreeterProcedures> { Windows = new GreeterWindows { News = 0 } });
        });
    }

    [Fact]
    public async Task Fails_a_call_before_it_goes_with_PAYLOAD_INVALID_when_its_options_say_so_and_sends_nothing()
    {
        await using var link = new ServiceLink();
        var server = new ServiceServer<CheckedProcedures, string>(CheckedProcedures.All);
        var sent = new List<string>();

        server.On(CheckedProcedures.Echo, (request, response) =>
        {
            sent.Add(request.Payload);

            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        var validating = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client, new ServiceClientOptions<CheckedProcedures> { Validates = true });
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return validating.RequesterOf(CheckedProcedures.Echo)("")().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, refused.Code);
        Assert.Equal((FailureOrigin.Local, RouterSide.Client), (refused.Origin, refused.Side));
        Assert.Equal(CheckedProcedures.Detail, refused.Detail);
        Assert.Equal(CheckedProcedures.Echo.Procedure.Address, refused.ProcedureAddress);
        Assert.Empty(sent);

        // * a value its rules take goes as ever
        Assert.Equal("hi", await validating.RequesterOf(CheckedProcedures.Echo)("hi")().WaitAsync(Patience, Cancelled));
        Assert.Equal(["hi"], sent);
    }

    [Fact]
    public async Task Validates_a_subscribing_request_as_a_plain_one_when_its_options_say_so()
    {
        await using var link = new ServiceLink();
        var server = new ServiceServer<CheckedProcedures, string>(CheckedProcedures.All);
        var sent = new List<string>();

        server.On(CheckedProcedures.News, (request, response) =>
        {
            sent.Add(request.Payload);

            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        var validating = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client, new ServiceClientOptions<CheckedProcedures> { Validates = true });
        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return validating.NotificationOf(CheckedProcedures.News).Register("", (_) =>
            {
                return Task.CompletedTask;
            })().WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, refused.Code);
        Assert.Equal(FailureOrigin.Local, refused.Origin);
        Assert.Equal(CheckedProcedures.Detail, refused.Detail);
        Assert.Empty(sent);
    }

    [Fact]
    public async Task Answers_PAYLOAD_INVALID_to_a_command_its_rules_refuse_before_its_resolver()
    {
        await using var link = new ServiceLink();
        var server = new ServiceServer<CheckedProcedures, string>(CheckedProcedures.All);
        var client = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client);
        var heard = new List<string>();

        client.On(CheckedProcedures.Shout, (request, response) =>
        {
            heard.Add(request.Payload);

            return response.Answer(request.Payload.ToUpperInvariant());
        });
        server.Offer(link.Server);

        Assert.Equal("HI", await server.CommandOf(CheckedProcedures.Shout)("hi")(Call).WaitAsync(Patience, Cancelled));

        var refused = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return server.CommandOf(CheckedProcedures.Shout)("")(Call).WaitAsync(Patience, Cancelled);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, refused.Code);
        Assert.Equal(FailureOrigin.Peer, refused.Origin);
        Assert.Equal(CheckedProcedures.Detail, refused.Detail);
        Assert.Equal(["hi"], heard);
    }

    // debugging 9.6.5
    [Fact]
    public async Task Counts_a_call_its_rules_refuse_before_it_goes_as_PAYLOAD_INVALID_started_and_ended_in_its_turn()
    {
        var registry = new MetricsRegistry();

        await using var link = new ServiceLink(registry);
        var server = new ServiceServer<CheckedProcedures, string>(CheckedProcedures.All);

        server.On(CheckedProcedures.Echo, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        var validating = new ServiceClient<CheckedProcedures>(CheckedProcedures.All, link.Client, new ServiceClientOptions<CheckedProcedures> { Validates = true });
        var steps = new List<(Exception? Error, DebugEvent Step)>();

        link.Client.Services.Debug += (error, step) =>
        {
            steps.Add((error, step));
        };

        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return validating.RequesterOf(CheckedProcedures.Echo)("")().WaitAsync(Patience, Cancelled);
        });

        var exposition = registry.Exposition().Text;

        Assert.Contains("bead_client_call_started_total{service=\"8\",procedure=\"echo\",type=\"request\"} 1\n", exposition, StringComparison.Ordinal);
        Assert.Contains(
            "bead_client_call_handled_total{service=\"8\",procedure=\"echo\",type=\"request\",outcome=\"failure\",code=\"PAYLOAD_INVALID\"} 1\n",
            exposition,
            StringComparison.Ordinal);
        Assert.Contains("bead_client_call_duration_seconds_count{service=\"8\",procedure=\"echo\",type=\"request\"} 1\n", exposition, StringComparison.Ordinal);

        // * its tx step told as it was refused, naming no call, then its failure
        Assert.Equal(2, steps.Count);
        Assert.Equal((DebugDirection.Tx, (uint?)null, (object?)""), (steps[0].Step.Direction, steps[0].Step.CallId, steps[0].Step.Tx));
        Assert.Null(steps[0].Error);
        Assert.Equal((DebugDirection.Rx, (uint?)null), (steps[1].Step.Direction, steps[1].Step.CallId));
        Assert.Equal((ushort)ProtocolCode.PayloadInvalid, Assert.IsType<FailureException>(steps[1].Error).Code);
    }
}
