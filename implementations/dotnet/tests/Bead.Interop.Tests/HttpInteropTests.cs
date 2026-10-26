using System.Text;
using Bead.Transcoding.Http;
using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Interop.Tests;

/// <summary>The generated C# HTTP client against the TypeScript gateway, twins of interop.test.ts.</summary>
public sealed class HttpInteropTests(InteropTests.TypeScriptServer server) : IClassFixture<InteropTests.TypeScriptServer>
{
    private const string Reason = "it starts the TypeScript server, and Node or the TypeScript side are not installed";

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private async Task<Uri> Gateway()
    {
        var ports = await server.Ports();

        return new Uri($"http://127.0.0.1:{ports.GatewayPort}");
    }

    [Fact(Skip = Reason, SkipUnless = nameof(InteropTests.IsInterop), SkipType = typeof(InteropTests))]
    public async Task Calls_the_other_gateway_with_protobuf_JSON_and_every_native_encoding()
    {
        using var client = new TranscodingHttpClient(await Gateway());
        var book = await client.GetBook(new GetBookRequest { Name = "shelves/a/books/b", Revision = 7 });

        Assert.Equal(new Book { Name = "shelves/a/books/b", Pages = 7, Title = "A tale" }, book);
        Assert.Equal("Ada\r\nJosé", await client.Text("Ada\r\nJosé"));
        Assert.Equal(new byte[] { 0, 127, 255 }, (await client.Raw(new byte[] { 0, 127, 255 })).ToArray());
        Assert.Equal("{\"a\":\"José\",\"z\":[true,null]}", (await client.Json(PayloadCodecs.Json.Decode(Encoding.UTF8.GetBytes("{\"z\":[true,null],\"a\":\"José\"}")))).GetRawText());
    }

    [Fact(Skip = Reason, SkipUnless = nameof(InteropTests.IsInterop), SkipType = typeof(InteropTests))]
    public async Task Reads_the_other_gateway_problems_and_presents_its_authorization()
    {
        using var client = new TranscodingHttpClient(await Gateway());
        var application = await Assert.ThrowsAsync<FailureException>(() => { return client.Fail(new FailRequest { Detail = "by choice" }); });
        var protocol = await Assert.ThrowsAsync<FailureException>(() => { return client.WhoAmI(new Empty()); });

        Assert.Equal((1, FailureScope.Application, "by choice"), ((int)application.Code, application.Scope, application.Detail));
        Assert.Equal((ProtocolCode.SessionRequired, FailureScope.Protocol), ((ProtocolCode)protocol.Code, protocol.Scope));
        Assert.Equal("ada", (await client.WhoAmI(new Empty(), new Transcoding.HttpCallOptions { Authorization = "Bearer good" })).Session);
    }

    [Fact(Skip = Reason, SkipUnless = nameof(InteropTests.IsInterop), SkipType = typeof(InteropTests))]
    public async Task Reads_the_other_gateway_result_notifications_and_ending_failure()
    {
        using var client = new TranscodingHttpClient(await Gateway());
        var received = new List<(bool IsResult, int Value)>();
        var failed = await Assert.ThrowsAsync<FailureException>(async () =>
        {
            await foreach (var entry in client.SubscribeTicks(new TicksRequest { From = 2 }))
            {
                received.Add((entry.IsResult, entry.IsResult ? entry.Result!.Ticks : entry.Notification!.Remaining));
            }
        });

        Assert.Equal((2, FailureScope.Application), ((int)failed.Code, failed.Scope));
        Assert.Equal([(true, 2), (false, 1), (false, 0)], received);
    }

    [Fact(Skip = Reason, SkipUnless = nameof(InteropTests.IsInterop), SkipType = typeof(InteropTests))]
    public async Task Reads_the_other_gateway_own_route_size_and_busy_refusals()
    {
        var url = await Gateway();
        using var missing = new TranscodingHttpClient(new Uri(url, "/missing/"));
        var route = await Assert.ThrowsAsync<FailureException>(() => { return missing.Json(PayloadCodecs.Json.Decode("null"u8.ToArray())); });
        Assert.Equal(((ushort)ProtocolCode.DestinationUnreachable, FailureOrigin.Peer, "the HTTP call answers 404; a path no route matches"), (route.Code, route.Origin, route.Detail));
        using var client = new TranscodingHttpClient(url);
        var size = await Assert.ThrowsAsync<FailureException>(() => { return client.Text(new string('x', 1025)); });
        Assert.Equal(((ushort)ProtocolCode.PayloadTooLarge, FailureOrigin.Peer), (size.Code, size.Origin));
        await using var iterator = client.SubscribeWatch(new Empty()).GetAsyncEnumerator(Cancelled);
        Assert.True(await iterator.MoveNextAsync());
        Assert.True(iterator.Current.IsResult);
        var busy = await Assert.ThrowsAsync<FailureException>(async () => { await foreach (var entry in client.SubscribeWatch(new Empty())) { _ = entry; } });
        Assert.Equal(((ushort)ProtocolCode.CapacityExceeded, FailureOrigin.Peer), (busy.Code, busy.Origin));
        Assert.StartsWith("the HTTP call answers 503; Retry-After: 1;", busy.Detail, StringComparison.Ordinal);
    }

    [Fact(Skip = Reason, SkipUnless = nameof(InteropTests.IsInterop), SkipType = typeof(InteropTests))]
    public async Task Compares_the_gateways_OpenAPI_documents_byte_for_byte()
    {
        await using var memory = new MemoryTransportServer();
        await using var local = new HttpGateway(new HttpGatewayOptions { Transport = memory, Routes = HttpRoutes.All, Document = HttpRoutes.OpenApiDocument.ToArray() });
        var own = await local.Start(new HttpGatewayStartOptions { Address = "127.0.0.1", FindOpenPort = true }, Cancelled);
        using var http = new HttpClient();
        using var remote = await http.GetAsync(new Uri(await Gateway(), "/openapi.json"), Cancelled);
        using var served = await http.GetAsync(new Uri($"http://127.0.0.1:{own.Port}/openapi.json"), Cancelled);

        Assert.Equal(System.Net.HttpStatusCode.OK, remote.StatusCode);
        Assert.Equal(System.Net.HttpStatusCode.OK, served.StatusCode);
        Assert.Equal(await remote.Content.ReadAsByteArrayAsync(Cancelled), await served.Content.ReadAsByteArrayAsync(Cancelled));
    }
}
