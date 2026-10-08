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
    public async Task Validates_a_request_before_it_encodes_it_when_its_options_say_so_by_its_descriptor_s_validate()
    {
        await using var link = new ServiceLink();
        var echo = new RequestProcedure<ServiceServerTests.EchoService, string, string, NoFailure>(
            new Procedure { ServiceId = 8, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1 },
            new ProcedureBindings<string, string>
            {
                Admission = AdmissionRule.None,
                Request = PayloadCodecs.Text,
                Result = PayloadCodecs.Text,
                Validate = (request) =>
                {
                    if (request.Length == 0)
                    {
                        throw new ArgumentOutOfRangeException(nameof(request), "an empty echo");
                    }
                },
            });
        var server = new ServiceServer<ServiceServerTests.EchoService, string>([echo]);
        var sent = new List<string>();

        server.On(echo, (request, response) =>
        {
            sent.Add(request.Payload);

            return response.Answer(request.Payload);
        });
        server.Offer(link.Server);

        var validating = new ServiceClient<ServiceServerTests.EchoService>([echo], link.Client, new ServiceClientOptions<ServiceServerTests.EchoService> { Validates = true });
        var trusting = new ServiceClient<ServiceServerTests.EchoService>([echo], link.Client);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
        {
            return validating.RequesterOf(echo)("")().WaitAsync(Patience, Cancelled);
        });

        // * the server's layer holds it too: the request went, and its resolver never saw it
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return trusting.RequesterOf(echo)("")().WaitAsync(Patience, Cancelled);
        });
        Assert.Empty(sent);
    }
}
