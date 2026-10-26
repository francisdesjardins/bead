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
        foreach (var size in new[] { 40, 64 })
        {
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

            await endless.Write(ChunkOf(new byte[size]));
            if (size == 40)
            {
                await Until(() =>
                {
                    return Count("bodyBytes") == 56;
                });
            }
            await endless.Write(ChunkOf(new byte[size]));

            var refused = await endless.ReadHead();

            Assert.Equal((413, HttpRefusals.TooLarge, "close"), (refused.Status, refused.Headers[HttpTransport.RefusalHeader], refused.Headers["connection"]));
        }

        Assert.Equal([EnvelopeKind.Cancel, EnvelopeKind.Cancel, EnvelopeKind.Cancel], KindsHandedOn());
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
        await Until(() =>
        {
            return _messages.Count == 3 && Count("bodyBytes") == 8;
        });
        await holding.Write(new byte[8]);

        Assert.Equal(200, (await holding.ReadHead()).Status);
        await Until(() =>
        {
            return _messages.Count == 4 && Count("bodyBytes") == 0;
        });
    }

    [Fact]
    public async Task Answers_a_body_whose_read_fails_a_malformed_chunked_one_the_status_of_its_failure_unmarked_its_connection_closed_never_200_and_empty()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 8));
        using var malformed = await Wire.Open(_port);

        // its prefix first, in a chunk of its own, so the exchange waits under its call id; then a
        // chunk whose size is no hexadecimal number
        await malformed.Write(PostHead(connectionToken, "Transfer-Encoding: chunked"));
        await malformed.Write(ChunkOf(request[..12]));
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });
        await malformed.Write("zz\r\n");

        var (head, body) = await malformed.Read();

        Assert.Equal((400, (string?)null, "close", 0), (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection"), body.Length));
        Assert.True(await malformed.IsClosed());
        await Until(() =>
        {
            return _closes.Any((close) =>
            {
                return close.ConnectionHandle == connectionHandle;
            });
        });
        Assert.Empty(_messages);
        Assert.Empty(_refusals);
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
        Assert.Equal("close", head.Headers.GetValueOrDefault("connection"));

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

    // what a client that goes on sending its body writes of it, as fast as its socket takes it,
    // until its body is whole or the server lets go of its socket
    private static async Task GoOnSending(Wire wire, long left)
    {
        var more = new byte[4_096];

        Array.Fill(more, (byte)7);

        try
        {
            for (; left > 0; left -= more.Length)
            {
                await wire.Write(left < more.Length ? more[..(int)left] : more);
            }
        }
        catch (Exception reason) when (reason is IOException or OperationCanceledException or ObjectDisposedException)
        {
            // the server let go of its socket
        }
    }

    [Fact]
    public async Task Refuses_408_too_slow_a_body_that_comes_slower_than_its_rate_once_its_grace_passed_its_client_reading_the_408_as_it_goes_on_sending_and_keeps_its_connection_a_body_at_its_rate_taken()
    {
        await Start();

        var (connectionToken, connectionHandle) = await Connect();
        var request = EnvelopeOf(EnvelopeKind.Request, (1, 4_000));
        using var slow = await Wire.Open(_port);
        var before = _time.Armed.Count;

        // its prefix, then nothing: its rate held once its grace of 5 s passed since its head
        await slow.Write(PostHead(connectionToken, $"Content-Length: {request.Length}"));
        await slow.Write(request[..12]);
        await Until(() =>
        {
            return DelaysSince(before).Contains(TimeSpan.FromSeconds(5));
        });
        _time.Advance(TimeSpan.FromSeconds(5));

        // refused, its client going on sending its body as it reads the 408, which a reset never erases
        var sending = GoOnSending(slow, request.Length - 12);
        var (head, body) = await slow.Read();

        await sending;
        Assert.Equal(
            (408, (string?)HttpRefusals.TooSlow, (string?)"close", 0),
            (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection"), body.Length));
        await Until(() =>
        {
            return !_refusals.IsEmpty;
        });
        Assert.Equal([(408, HttpRefusals.TooSlow)], _refusals.Select((refusal) =>
        {
            return (refusal.Status, refusal.Reason);
        }));
        Assert.Empty(_messages);

        // its connection kept: a body that keeps its rate is taken whole and handed on
        var paced = EnvelopeOf(EnvelopeKind.Request, (3, 2_392));
        using var steady = await Wire.Open(_port);

        await steady.Write(PostHead(connectionToken, $"Content-Length: {paced.Length}"));
        await steady.Write(paced[..12]);
        await Until(() =>
        {
            return Count("waitingExchanges") == 1;
        });
        _time.Advance(TimeSpan.FromSeconds(4));
        await steady.Write(paced[12..1_200]);
        await Until(() =>
        {
            return Count("bodyBytes") == 1_200;
        });
        _time.Advance(TimeSpan.FromSeconds(0.9));
        await steady.Write(paced[1_200..]);
        await Until(() =>
        {
            return !_messages.IsEmpty;
        });
        Assert.Equal((200, paced.Length), ((await steady.ReadHead()).Status, Assert.Single(_messages).Bytes.Length));
        Assert.Empty(_closes);
        Assert.Contains(connectionHandle, _server.ConnectionHandles);
    }

    [Fact]
    public async Task Closes_in_stages_every_answer_written_before_its_body_is_whole_so_a_client_that_sends_at_full_speed_reads_it_and_its_connection_then_answers_a_POST()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 1_024 });

        var (connectionToken, _) = await Connect();

        // a body past its bound, declared, and an exchange of a connection none holds: each answered
        // before its body is whole, its client sending at full speed meanwhile
        foreach (var (token, framing, status, reason) in new (string Token, string Framing, int Status, string Reason)[]
        {
            (connectionToken, "Content-Length: 1048576", 413, HttpRefusals.TooLarge),
            (new string('A', 22), "Content-Length: 1048576", 404, HttpRefusals.ConnectionUnknown),
        })
        {
            using var wire = await Wire.Open(_port);

            await wire.Write(PostHead(token, framing));

            var sending = GoOnSending(wire, 1_048_576);
            var head = await wire.ReadHead();

            await sending;
            Assert.Equal(
                (status, (string?)reason, (string?)"close"),
                (head.Status, head.Headers.GetValueOrDefault(HttpTransport.RefusalHeader), head.Headers.GetValueOrDefault("connection")));
            Assert.True(await wire.IsClosed());
        }

        // its connection stands: a cancel on it ends 204
        using var cancelled = await Fetch(PostOf(connectionToken, EnvelopeOf(EnvelopeKind.Cancel, 9)));

        Assert.Equal(204, (int)cancelled.StatusCode);
    }

    [Fact]
    public async Task Destroys_a_socket_whose_client_never_ends_it_after_2_s_on_the_platform_s_clock()
    {
        await Start(new HttpTransportServerOptions { MaximumBodyBytes = 1_024 });

        var (connectionToken, _) = await Connect();
        using var silent = await Wire.Open(_port);

        // an answer written before its body is whole, whose client neither sends on nor closes
        await silent.Write(PostHead(connectionToken, "Content-Length: 4096"));
        Assert.Equal(413, (await silent.ReadHead()).Status);

        var started = TimeProvider.System.GetTimestamp();

        Assert.True(await silent.IsClosed());
        Assert.InRange(TimeProvider.System.GetElapsedTime(started), TimeSpan.FromSeconds(1.5), TimeSpan.FromSeconds(4));
    }
}
