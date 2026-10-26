using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.ExceptionServices;
using Bead;
using Bead.Transport.WebSockets;
using Hello.V1;

namespace Hello;

/// <summary>
/// HelloService's C# client: it calls the server on 127.0.0.1, and writes what each call answered,
/// a line each, which the TypeScript client writes alike.
/// </summary>
public static class Calling
{
    // constants

    // the name it answers askName with, the first time it is asked; an empty one after
    private const string Name = "Ada";

    // how long each countDown callback holds itself, so ticks the window did not pace overlap
    private const int HoldMs = 10;

    // helpers

    // LF, as the TypeScript client writes it, on every platform
    private static void Say(string line)
    {
        Console.Out.Write($"{line}\n");
    }

    // what a refused or failed call answered: a failure of HelloService's catalogue by its name, an
    // admission refused by its detail, a request its rules refused by its violations, the detail's
    // lines as they came; anything else is thrown again
    private static string FailureOf(FailureException exception)
    {
        if (HelloFailures.Is(exception, HelloFailures.SayHello.Nameless))
        {
            return $"NAMELESS, {exception.Failure.Detail}";
        }

        if (exception.Failure is { Scope: FailureScope.Protocol, Code: (ushort)ProtocolCode.AccessDenied })
        {
            return $"ACCESS_DENIED, {exception.Failure.Detail}";
        }

        if (exception.Failure is { Scope: FailureScope.Protocol, Code: (ushort)ProtocolCode.PayloadInvalid })
        {
            return $"PAYLOAD_INVALID, {exception.Failure.Detail}";
        }

        ExceptionDispatchInfo.Throw(exception);

        return "";
    }

    // definition

    /// <summary>Calls HelloService on <paramref name="port"/>, and writes what it answered.</summary>
    public static async Task<int> Call(int port)
    {
        await using var client = new WebSocketClient();
        // at a window of 1: each tick comes once the callback before it settled
        var hello = new HelloClient(client, new ServiceClientOptions<HelloProcedures> { Windows = new HelloWindows { CountDown = 1 } });
        var asked = 0;

        hello.On(HelloProcedures.AskName, (_, response) =>
        {
            return response.Answer(new AskNameResponse { Name = Interlocked.Increment(ref asked) == 1 ? Name : "" });
        });

        await client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = port });

        try
        {
            await hello.CountDown(new CountDownRequest { From = 3 })();
        }
        catch (FailureException exception)
        {
            Say($"countDown before sayHello: {FailureOf(exception)}");
        }

        Say($"sayHello Bead: {(await hello.SayHello(new SayHelloRequest { Name = "Bead" })()).Greeting}");
        Say($"sayHello, nameless: {(await hello.SayHello(new SayHelloRequest { Name = "" })()).Greeting}");

        try
        {
            await hello.CountDown(new CountDownRequest { From = 11 })();
        }
        catch (FailureException exception)
        {
            Say($"countDown from 11: {FailureOf(exception)}");
        }

        // * the callbacks counted while they run: at a window of 1, one at a time, by construction;
        // unpaced, they would run at once on the thread pool, so the count is kept under a lock
        var ticks = new ConcurrentQueue<int>();
        var counting = new Lock();
        var inFlight = 0;
        var most = 0;
        var counted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = await hello.Notifications.CountDown.Register(new CountDownRequest { From = 3 }, async (tick) =>
        {
            lock (counting)
            {
                inFlight += 1;
                most = Math.Max(most, inFlight);
            }

            ticks.Enqueue(tick.Remaining);
            // a callback that takes its time: the window holds the next tick until it settles
            await Task.Delay(HoldMs);

            lock (counting)
            {
                inFlight -= 1;
            }

            if (tick.Remaining == 0)
            {
                counted.TrySetResult();
            }
        })();

        await counted.Task;
        await registration.Unregister();

        int seen;

        lock (counting)
        {
            seen = most;
        }

        Say($"countDown from 3: {string.Join(' ', ticks)}, {(seen == 1 ? "one" : seen.ToString(CultureInfo.InvariantCulture))} at a time");

        try
        {
            await hello.SayHello(new SayHelloRequest { Name = "" })();
        }
        catch (FailureException exception)
        {
            Say($"sayHello, nameless again: {FailureOf(exception)}");
        }

        await client.Disconnect();

        return 0;
    }
}
