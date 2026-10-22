using System.Net;
using System.Net.Sockets;
using System.Text;
using Bead.Tests;
using Bead.Transcoding;
using Bead.Transcoding.Http;

namespace Bead.Transport.Http.Tests;

// a gateway's durations (decision 0037): its call timeout and its heartbeat, its own, and the bounds
// spec 15.12 names that it takes as an HTTP transport server does, each by its options as it is built
public sealed partial class DurationsTests
{
    // a gateway of one raw procedure, POST /api/Echo/echo, over an in-memory transport no call reaches
    private static HttpGatewayOptions GatewayOptionsOf(MemoryTransportServer memory)
    {
        return new HttpGatewayOptions
        {
            Transport = memory,
            Routes =
            [
                new HttpRoute
                {
                    Procedure = new Procedure { ServiceId = 1, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1, ProcedureKind = ProcedureKind.Request },
                    Request = HttpPayload.Raw,
                    Result = HttpPayload.Raw,
                    Failures = new Dictionary<string, int>(),
                    Routes = [new HttpRouteTemplate { Method = "POST", Template = "/api/Echo/echo", Body = "*" }],
                },
            ],
        };
    }

    // a gateway built, what it holds read back, or refused
    private static async Task<Observed> GatewayBuilt(Func<HttpGatewayOptions, HttpGatewayOptions> given, Func<HttpGateway, Observed> read)
    {
        await using var memory = new MemoryTransportServer();
        HttpGateway gateway;

        try
        {
            gateway = new HttpGateway(given(GatewayOptionsOf(memory)));
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await using (gateway)
        {
            return read(gateway);
        }
    }

    // gateway.timeout

    // the gateway's options, as it is built: the timeout its calls are given, as it holds it
    private static Task<Observed> TimeoutByGateway(TimeSpan? given)
    {
        return GatewayBuilt(
            (options) =>
            {
                return given is { } timeout ? options with { Timeout = timeout } : options;
            },
            (gateway) =>
            {
                return HeldAt(gateway.Timeout);
            });
    }

    // gateway.heartbeat

    // the gateway's options, as it is built: taken or refused, on the real clock
    private static Task<Observed> HeartbeatByGateway(TimeSpan? given)
    {
        return GatewayBuilt(
            (options) =>
            {
                return options with { Heartbeat = Assert.NotNull(given) };
            },
            (_) =>
            {
                return Taken();
            });
    }

    // httpTransportServer.sendGracePeriod, httpTransportServer.headersTimeout, a gateway's

    // the gateway's options, as it is built: taken or refused, on the real clock
    private static Task<Observed> SendGracePeriodByGateway(TimeSpan? given)
    {
        return GatewayBuilt(
            (options) =>
            {
                return options with { SendGracePeriod = Assert.NotNull(given) };
            },
            (_) =>
            {
                return Taken();
            });
    }

    private static Task<Observed> HeadersTimeoutByGateway(TimeSpan? given)
    {
        return GatewayBuilt(
            (options) =>
            {
                return options with { HeadersTimeout = Assert.NotNull(given) };
            },
            (_) =>
            {
                return Taken();
            });
    }

    // httpTransportServer.bodyGracePeriod, a gateway's

    // the gateway's options, as it is built: the due of the timer it arms for a body that declares
    // its bytes and brings none, the one timer an exchange arms before its body; refused, none built
    private static async Task<Observed> BodyGracePeriodByGateway(TimeSpan? given)
    {
        var clock = new SteppingClock(Epoch);
        await using var memory = new MemoryTransportServer();
        HttpGateway gateway;

        try
        {
            var options = GatewayOptionsOf(memory) with { Clock = clock };

            gateway = new HttpGateway(given is { } grace ? options with { BodyGracePeriod = grace } : options);
        }
        catch (ArgumentOutOfRangeException refused)
        {
            return Refused(refused);
        }

        await using (gateway)
        {
            var port = (await gateway.Start(new HttpGatewayStartOptions { Address = Host, FindOpenPort = true }, Cancelled)).Port;
            using var socket = new TcpClient();

            await socket.ConnectAsync(IPAddress.Loopback, port, Cancelled);
            await socket.GetStream().WriteAsync(
                Encoding.ASCII.GetBytes($"POST /api/Echo/echo HTTP/1.1\r\nHost: {Host}\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\n\r\n"),
                Cancelled);

            var watch = System.Diagnostics.Stopwatch.StartNew();
            var dues = clock.Dues();

            while (dues.Count == 0 && watch.Elapsed < Patience)
            {
                await Task.Delay(5, Cancelled);
                dues = clock.Dues();
            }

            return HeldAt(dues is [var due] ? due : Never);
        }
    }
}
