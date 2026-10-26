using System.Collections.Concurrent;
using Bead;
using Hello.V1;

namespace Hello;

/// <summary>
/// HelloService's resolvers and its hook, as the C# side answers them: the only code its server
/// writes, beside the generated <see cref="HelloServer{TData}"/>.
/// </summary>
public static class Resolvers
{
    // constants

    // what sayHello asks a caller that gave no name
    private const string Question = "What is your name?";

    // definition

    /// <summary>
    /// HelloService, offered on <paramref name="server"/>: <c>sayHello</c> greets a name, asking
    /// its caller's by <c>askName</c> when it is given none; <c>countDown</c> answers the ticks it
    /// will notify, then notifies them to its caller's connection alone, and admits a connection
    /// that <c>sayHello</c> greeted. A count past 10 never reaches it: its request's rule refuses it
    /// first.
    /// </summary>
    public static HelloServer<TData> OfferHello<TData>(IBeadServer<TData> server)
    {
        ArgumentNullException.ThrowIfNull(server);

        // the connections sayHello greeted, each until it closes
        var greeted = new ConcurrentDictionary<string, bool>();
        var hello = new HelloServer<TData>(new ServiceServerOptions<HelloProcedures>
        {
            Admissions = new HelloAdmissions
            {
                Greeted = new AdmissionHook
                {
                    Admits = (request) =>
                    {
                        return greeted.ContainsKey(request.ConnectionHandle);
                    },
                    Detail = "say hello first",
                },
            },
        });

        server.Transport.Close += (_, connectionHandle) =>
        {
            greeted.TryRemove(connectionHandle, out _);
        };

        hello.On(HelloProcedures.SayHello, async (request, response) =>
        {
            var connectionHandle = request.ConnectionHandle;
            var name = request.Payload.Name.Length == 0
                ? (await hello.Command.AskName(new AskNameRequest { Question = Question })(new RequestOptions { ConnectionHandle = connectionHandle })).Name
                : request.Payload.Name;

            if (name.Length == 0)
            {
                await response.Fail(HelloFailures.SayHello.Nameless, "nobody to greet");

                return;
            }

            greeted[connectionHandle] = true;
            await response.Answer(new SayHelloResponse { Greeting = $"Hello, {name}!" });
        });

        hello.On(HelloProcedures.CountDown, async (request, response) =>
        {
            var connectionHandle = request.ConnectionHandle;
            var from = request.Payload.From;

            await response.Answer(new CountDownResponse { Ticks = from + 1 });

            for (var remaining = from; remaining >= 0; remaining -= 1)
            {
                await hello.Notify.CountDown(
                    new Tick { Remaining = remaining },
                    new NotifyOptions
                    {
                        Filter = (subscriber) =>
                        {
                            return subscriber.ConnectionHandle == connectionHandle;
                        },
                    });
            }
        });

        hello.Offer(server);

        return hello;
    }
}
