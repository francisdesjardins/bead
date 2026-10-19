using System.Globalization;

namespace Bead.Transport.Http.Tests;

/// <summary>
/// <see cref="HttpTransportServer"/>'s exchange of one envelope: its body read under its
/// limits, then handed on, and an answer that comes as it still comes.
/// </summary>
public sealed partial class HttpTransportServerTests
{
    [Fact]
    public async Task Refuses_a_POST_with_two_Authorization_fields_400_malformed_before_reading_its_body_and_hands_the_router_nothing()
    {
        await Start();

        var (connectionToken, _) = await Connect();

        async Task<(int Status, string? Reason, string? Connection)> TwiceOf(string second)
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(connectionToken, $"Authorization: {Bearer}\r\nAuthorization: {second}\r\nContent-Length: 8"));
            await wire.Write(EnvelopeOf(EnvelopeKind.Request, 1));

            var head = await wire.ReadHead();

            return (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection"));
        }

        Assert.Equal(
            [(400, HttpRefusals.Malformed, "close"), (400, HttpRefusals.Malformed, "close")],
            [await TwiceOf(Bearer), await TwiceOf("")]);
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Refuses_a_body_past_its_limit_413_declared_or_counted_and_hands_the_router_nothing()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 64 });

        var (connectionToken, _) = await Connect();
        var declared = await RefusalOf(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Request, (1, 57))));
        var chunked = PostOf(connectionToken, [.. EnvelopeOf(EnvelopeKind.Request, (3, 40)), .. new byte[40]]);
        string counted;

        chunked.Headers.TransferEncodingChunked = true;

        try
        {
            counted = (await RefusalOf(chunked)).Status.ToString(CultureInfo.InvariantCulture);
        }
        catch (HttpRequestException)
        {
            counted = "reset";
        }

        Assert.Equal((413, HttpRefusals.TooLarge), declared);
        // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
        Assert.Matches("^(?:413|reset)$", counted);
        Assert.Empty(_messages);
    }

    [Fact]
    public async Task Puts_a_body_together_from_as_many_pieces_as_it_comes_in_and_hands_on_one_envelope()
    {
        await Start();

        var (connectionToken, _) = await Connect();
        var envelope = EnvelopeOf(EnvelopeKind.Request, (1, 70_000));
        using var wire = await Wire.Open(_port);

        await wire.Write(PostHead(connectionToken, $"Content-Length: {envelope.Length}"));

        foreach (var piece in envelope.Chunk(1_000))
        {
            await wire.Write(piece);
        }

        Assert.Equal(200, (await wire.ReadHead()).Status);
        Assert.Equal(envelope, Assert.Single(_messages).Bytes);
    }

    [Fact]
    public async Task Ends_an_upload_whose_cancel_came_as_it_came_never_handing_it_on_and_one_past_its_limit_reading_no_more_of_it()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 64 });

        var (connectionToken, _) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 40));

        using (var upload = await Wire.Open(_port))
        {
            await upload.Write(PostHead(connectionToken, $"Content-Length: {request.Length}"));
            await upload.Write(request[..16]);
            await Until(() =>
            {
                return Count("waitingExchanges") == 1;
            });

            using var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1)));

            await upload.Write(request[16..]);

            Assert.Equal((204, 204), ((int)cancel.StatusCode, (await upload.ReadHead()).Status));
        }

        // cancelled, and still coming past the limit: refused, and read no more — each piece counted
        // though none is kept
        using var endless = await Wire.Open(_port);

        await endless.Write(PostHead(connectionToken, "Transfer-Encoding: chunked"));
        await endless.Write(ChunkOf(request[..16]));
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });

        using (var cancel = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 1))))
        {
            Assert.Equal(204, (int)cancel.StatusCode);
        }

        await endless.Write(ChunkOf(new byte[40]));
        await Until(() =>
        {
            return Count("bodyBytes") == 56;
        });
        await endless.Write(ChunkOf(new byte[40]));

        var refused = await endless.ReadHead();

        Assert.Equal((413, HttpRefusals.TooLarge, "close"), (refused.Status, refused.Headers[HttpTransport.RefusalHeader], refused.Headers["connection"]));
        Assert.Equal([EnvelopeKind.Cancel, EnvelopeKind.Cancel], KindsHandedOn());
    }

    // spec 15.12.4
    [Fact]
    public async Task Reads_a_body_up_to_its_limit_exactly_declared_or_counted_refuses_one_declared_past_it_before_any_of_it_and_gives_back_the_bytes_each_held()
    {
        await Start(new HttpTransportServerOptions { BodyBytesBudget = 24, MaximumBodyBytes = 16 });

        var (connectionToken, _) = await Connect();
        using var declared = await Wire.Open(_port);
        using var past = await Wire.Open(_port);

        await declared.Write(PostHead(connectionToken, "Content-Length: 16"));
        await past.Write(PostHead(connectionToken, "Content-Length: 17"));

        // the one past its limit is refused as it comes; the one at it waits for its body
        Assert.Equal(413, (await past.ReadHead()).Status);

        await declared.Write(EnvelopeOf(EnvelopeKind.Request, (1, 8)));

        // counted, with no length declared: its 16 bytes, once the first 16 were given back, which
        // they are before the envelope is handed on
        await Until(() =>
        {
            return _messages.Count == 1;
        });

        using var counted = await Wire.Open(_port);

        await counted.Write(PostHead(connectionToken, "Transfer-Encoding: chunked"));
        await counted.Write([.. ChunkOf(EnvelopeOf(EnvelopeKind.Request, 3)), .. ChunkOf(new byte[8]), .. "0\r\n\r\n"u8]);

        Assert.Equal((200, 200), ((await declared.ReadHead()).Status, (await counted.ReadHead()).Status));
        Assert.Equal(2, _messages.Count);

        // up to the budget exactly, across exchanges: 8 bytes held, and 16 more
        using var holding = await Wire.Open(_port);
        using var filling = await Wire.Open(_port);

        await holding.Write(PostHead(connectionToken, "Content-Length: 16"));
        await holding.Write(EnvelopeOf(EnvelopeKind.Request, 5));
        await Until(() =>
        {
            return Count("bodyBytes") == 8;
        });
        await filling.Write(PostHead(connectionToken, "Content-Length: 16"));
        await filling.Write(EnvelopeOf(EnvelopeKind.Request, (7, 8)));

        Assert.Equal(200, (await filling.ReadHead()).Status);
    }

    [Fact]
    public async Task Answers_a_request_an_answer_comes_for_as_its_body_still_comes_at_once_never_handing_it_on()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 8));
        var answer = EnvelopeOf(EnvelopeKind.Result, 1);
        using var coming = await Wire.Open(_port);

        await coming.Write(PostHead(connectionToken, $"Content-Length: {request.Length}"));
        await coming.Write(request[..12]);
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });
        await _server.Send(new TransportMessage(answer, false), connectionHandle).WaitAsync(Patience, Cancelled);

        var (head, body) = await coming.Read();

        Assert.Equal((200, Convert.ToHexString(answer)), (head.Status, Convert.ToHexString(body)));

        // the rest of it changes nothing: it is never handed on, and its socket, its body not read
        // on, closes behind its answer
        try
        {
            await coming.Write(request[12..]);
        }
        catch (IOException)
        {
            // the server may have closed the socket already
        }

        Assert.True(await coming.IsClosed());
        Assert.Empty(_messages);
    }
}
