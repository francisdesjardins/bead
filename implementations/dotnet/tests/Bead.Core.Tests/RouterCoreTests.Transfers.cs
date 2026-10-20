using System.Globalization;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s transfers, as section 12 of the spec has them: what a client's core
/// sends and receives, which the conversations, played against a server, do not reach, and what a
/// server's core does over time, which they cannot.
/// </summary>
public sealed partial class RouterCoreTests
{
    // constants

    // limits that send a payload of more than 64 bytes as a transfer: an opening of a request
    // carries 44 bytes of it, one of a result 28 — the 20 bytes of an announcement counted — and a
    // chunk 48; a window of 128 bytes; 2 s without a chunk or a credit
    private static readonly RouterLimits Chunked = RouterLimits.Default with
    {
        ChunkBytes = 64,
        TransferInactivityTimeout = TimeSpan.FromSeconds(2),
        WindowBytes = 128,
    };

    // echo's address, of no kind, so that a peer of either side resolves it (spec 16.11)
    private static readonly Procedure Echo = InteropProcedures.Echo.Procedure with { ProcedureKind = null };

    // helpers

    // bytes that differ from one to the next, so a byte out of place shows
    private static byte[] PatternOf(int length)
    {
        return [.. Enumerable.Range(0, length).Select((index) =>
        {
            return (byte)(((index * 7) + (index >> 8)) % 251);
        })];
    }

    private static Envelope CreditOf(uint callId, long creditEnd)
    {
        return new Envelope { Header = new CreditHeader { CallId = callId, CreditEnd = creditEnd } };
    }

    private static Envelope ChunkOf(uint callId, (byte[] Payload, int Offset, int Length) chunk)
    {
        return new Envelope
        {
            Header = new ChunkHeader { CallId = callId, IsLast = chunk.Offset + chunk.Length == chunk.Payload.Length, Offset = chunk.Offset },
            Payload = chunk.Payload.AsMemory(chunk.Offset, chunk.Length),
        };
    }

    private static Envelope ResultOpeningOf(uint callId, (byte[] Payload, int OpeningBytes) opening)
    {
        return new Envelope
        {
            Header = new ResultHeader { CallId = callId, Total = opening.Payload.Length },
            Payload = opening.Payload.AsMemory(0, opening.OpeningBytes),
        };
    }

    private static Envelope RequestOpeningOf(uint callId, (byte[] Payload, int OpeningBytes) opening)
    {
        return new Envelope
        {
            Header = new RequestHeader { CallId = callId, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId, Total = opening.Payload.Length },
            Payload = opening.Payload.AsMemory(0, opening.OpeningBytes),
        };
    }

    // the offsets of the chunks sent, and whether each is the last
    private static List<(long Offset, bool IsLast)> ChunksOf(IEnumerable<Envelope> sent)
    {
        return [.. sent.Select((envelope) =>
        {
            return envelope.Header;
        }).OfType<ChunkHeader>().Select((chunk) =>
        {
            return (chunk.Offset, chunk.IsLast);
        })];
    }

    private static List<long> CreditsOf(IEnumerable<Envelope> sent)
    {
        return [.. sent.Select((envelope) =>
        {
            return envelope.Header;
        }).OfType<CreditHeader>().Select((credit) =>
        {
            return credit.CreditEnd;
        })];
    }

    // definition

    [Fact]
    public async Task Ends_a_transfer_it_sends_that_no_credit_comes_for_a_request_with_a_timeout_a_result_with_a_failure()
    {
        var client = new Peer(RouterSide.Client);
        var asked = client.Request(PatternOf(300), Timeout.InfiniteTimeSpan);

        await client.Settle();
        await client.Advance(TimeSpan.FromSeconds(2));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);

        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

        var answered = resolver.Answer(0, PatternOf(300));

        await server.Settle();
        await server.Advance(TimeSpan.FromSeconds(2));

        var stalled = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.TransferStalled, stalled.Code);
        Assert.Equal((ushort)ProtocolCode.TransferStalled, server.Sent[^1].Failure!.Code);

        // the call went with it: a request on its call id is the peer's to open again
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal(2, resolver.Requests.Count);
        Assert.Empty(server.Reports);
    }

    [Fact]
    public async Task Finds_a_transfer_it_sends_at_once_for_a_credit_that_comes_back_as_its_opening_goes()
    {
        var peer = new Peer(RouterSide.Client);

        // the transport hears its credit as it is handed the opening
        peer.OnSend = (envelope) =>
        {
            if (envelope.Header is RequestHeader)
            {
                peer.Core.Receive(EnvelopeCodec.WriteEnvelope(CreditOf(1, 300)), Handle);
            }

            return Task.CompletedTask;
        };
        _ = peer.Request(PatternOf(300), TimeSpan.FromSeconds(5));
        await peer.Settle();
        Assert.Equal(6, ChunksOf(peer.Sent).Count);
    }

    // fr-CA writes 0.5 as "0,5": a refusal, and a detail that goes on the wire, read alike on every
    // machine, whatever its culture
    [Fact]
    public async Task Writes_its_milliseconds_with_a_dot_under_a_culture_that_writes_a_comma_a_refusal_and_a_failure_s_detail_alike()
    {
        var culture = CultureInfo.CurrentCulture;

        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-CA");

        try
        {
            Assert.Equal("0,5", 0.5.ToString(CultureInfo.CurrentCulture));
            Assert.StartsWith("a transfer's inactivity is a number of milliseconds from 1 to 2147483647, not 0.5", Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return (RouterLimits.Default with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(0.5) }).Validate();
            }).Message, StringComparison.Ordinal);

            var server = new Peer(RouterSide.Server);
            var resolver = server.Resolve();

            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

            var answered = resolver.Answer(0, PatternOf(300));

            await server.Settle();
            await server.Advance(TimeSpan.FromSeconds(2));
            await Assert.ThrowsAsync<FailureException>(() =>
            {
                return answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.Equal("no credit came for 2000 milliseconds", server.Sent[^1].Failure!.Detail);
        }
        finally
        {
            CultureInfo.CurrentCulture = culture;
        }
    }

    [Fact]
    public async Task Ends_a_transfer_nothing_comes_for_a_request_s_with_a_failure_a_result_s_with_a_timeout()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var payload = PatternOf(300);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Advance(TimeSpan.FromSeconds(1.5));

        // bytes placed set its timer going again
        await server.Deliver(ChunkOf(1, (payload, 44, 48)));
        await server.Advance(TimeSpan.FromSeconds(1.5));
        Assert.DoesNotContain(server.Sent, (envelope) =>
        {
            return envelope.Header is FailureHeader;
        });
        await server.Advance(TimeSpan.FromSeconds(0.5));
        Assert.Equal((ushort)ProtocolCode.TransferStalled, server.Sent[^1].Failure!.Code);
        Assert.Empty(resolver.Requests);

        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, Timeout.InfiniteTimeSpan);

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (payload, 32)));
        await client.Advance(TimeSpan.FromSeconds(2));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);
    }

    [Fact]
    public async Task Stalls_no_request_whose_payload_came_whole_however_long_its_resolver_takes()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var payload = RequesterBytesOf(100);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(ChunkOf(1, (payload, 44, 48)));
        await server.Deliver(ChunkOf(1, (payload, 92, 8)));
        Assert.Equal(payload, Assert.Single(resolver.Requests).Payload.ToArray());
        await server.Advance(TimeSpan.FromSeconds(10));

        // once whole, the payload went on to the resolver, which answers the call: a chunk past its
        // total is reported, and ends nothing
        await server.Deliver(new Envelope { Header = new ChunkHeader { CallId = 1, IsLast = true, Offset = 100 }, Payload = new byte[] { 1 } });
        Assert.Equal((ushort)ProtocolCode.ChunkInvalid, Assert.IsType<FailureException>(Assert.Single(server.Reports)).Code);
        Assert.DoesNotContain(server.Sent, (envelope) =>
        {
            return envelope.Header is FailureHeader;
        });
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.IsType<ResultHeader>(server.Sent[^1].Header);
        Assert.Equal(new byte[] { 1 }, server.Sent[^1].Payload.ToArray());

        var waiting = new Peer(RouterSide.Server, Chunked with { TransferInactivityTimeout = TimeSpan.FromMilliseconds(250) });
        using var waitingCore = waiting.Core;
        var waitingResolver = waiting.Resolve();
        var never = new TaskCompletionSource();
        waitingResolver.Handling = (_) => { return never.Task; };
        await waiting.Deliver(new Envelope { Header = RequestOf(1) with { Total = 60 }, Payload = RequesterBytesOf(40) });
        await waiting.Deliver(new Envelope { Header = new ChunkHeader { CallId = 1, Offset = 40, IsLast = true }, Payload = RequesterBytesOf(20) });
        await waiting.Advance(TimeSpan.FromSeconds(10));
        Assert.Equal(new CreditHeader { CallId = 1, CreditEnd = 60 }, Assert.Single(waiting.Sent).Header);
    }

    [Fact]
    public async Task Ends_a_request_s_transfer_with_the_failure_a_chunk_breaks_and_drops_what_its_credit_let_come_after()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var payload = PatternOf(200);

        await server.Deliver(RequestOpeningOf(1, (payload, 40)));

        // the last, it says, yet it ends before the total
        await server.Deliver(new Envelope { Header = new ChunkHeader { CallId = 1, IsLast = true, Offset = 40 }, Payload = payload.AsMemory(40, 40) });

        // under the credit granted, then past it
        await server.Deliver(ChunkOf(1, (payload, 80, 48)));
        await server.Deliver(ChunkOf(1, (payload, 160, 40)));
        await server.Deliver(RequestOpeningOf(3, (payload, 40)));
        await server.Deliver(ChunkOf(3, (payload, 168, 32)));

        // a request opens the call id abandoned again, without a transfer
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        await server.Deliver(ChunkOf(1, (payload, 80, 48)));
        Assert.Equal(
            [
                "credit 1 168",
                $"failure 1 {(ushort)ProtocolCode.ChunkInvalid}",
                "credit 3 168",
                $"failure 3 {(ushort)ProtocolCode.CreditExceeded}",
            ],
            server.Sent.Select((envelope) =>
            {
                return envelope.Header switch
                {
                    CreditHeader credit => $"credit {credit.CallId} {credit.CreditEnd}",
                    _ => $"failure {envelope.Header.CallId} {envelope.Failure?.Code}",
                };
            }));
        Assert.Equal(
            [(ushort)ProtocolCode.CreditExceeded, (ushort)ProtocolCode.EnvelopeMalformed],
            server.Reports.Select((reason) =>
            {
                return ((FailureException)reason).Code;
            }));
        Assert.Contains("call 1 receives no transfer", server.Reports[1].Message, StringComparison.Ordinal);
        Assert.Equal([(1u, (long?)null)], resolver.Requests.Select((props) =>
        {
            return (props.Header.CallId, props.Header.Total);
        }));
    }

    [Fact]
    public async Task Holds_a_connection_s_place_for_a_transfer_until_its_call_ends_not_once_its_payload_is_whole()
    {
        var server = new Peer(RouterSide.Server, Chunked with { MaximumTransfers = 1 });
        var resolver = server.Resolve();
        var payload = RequesterBytesOf(100);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(ChunkOf(1, (payload, 44, 48)));
        await server.Deliver(ChunkOf(1, (payload, 92, 8)));
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, server.Sent[^1].Failure!.Code);
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Deliver(RequestOpeningOf(5, (payload, 44)));
        Assert.Equal(new CreditHeader { CallId = 5, CreditEnd = 100 }, server.Sent[^1].Header);
        Assert.Equal(new IEnvelopeHeader[] { new CreditHeader { CallId = 1, CreditEnd = 100 }, new FailureHeader { CallId = 3 }, new ResultHeader { CallId = 1 }, new CreditHeader { CallId = 5, CreditEnd = 100 } }, server.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Equal(new byte[] { 1 }, server.Sent[2].Payload.ToArray());

        var small = new Peer(RouterSide.Server, Chunked with { MaximumTransfers = 1 });
        using var smallCore = small.Core;
        var smallResolver = small.Resolve();

        await small.Deliver(RequestOpeningOf(1, (payload, 40)));
        await small.Deliver(ChunkOf(1, (payload, 40, 48)));
        await small.Deliver(ChunkOf(1, (payload, 88, 12)));
        await small.Deliver(new Envelope { Header = RequestOf(3) with { Total = 8 }, Payload = new byte[] { 1 } });
        await smallResolver.Answer(0, new byte[] { 9 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await small.Deliver(new Envelope { Header = RequestOf(5) with { Total = 8 }, Payload = new byte[] { 1 } });
        Assert.Equal(new IEnvelopeHeader[] { new CreditHeader { CallId = 1, CreditEnd = 100 }, new FailureHeader { CallId = 3 }, new ResultHeader { CallId = 1 }, new CreditHeader { CallId = 5, CreditEnd = 8 } }, small.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, small.Sent[1].Failure!.Code);
        Assert.Equal(new byte[] { 9 }, small.Sent[2].Payload.ToArray());
    }

    [Fact]
    public async Task Gives_the_budget_back_once_a_payload_is_whole_and_grants_the_transfer_it_starved()
    {
        var server = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256 });

        server.Resolve();

        var payload = RequesterBytesOf(200);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        Assert.Equal([172L], CreditsOf(server.Sent));

        foreach (var offset in new[] { 44, 92 })
        {
            await server.Deliver(ChunkOf(1, (payload, offset, 48)));
        }

        // the budget left grants the first the rest of its window, then none to the second
        Assert.Equal([172L, 200L], CreditsOf(server.Sent));
        await server.Deliver(ChunkOf(1, (payload, 140, 48)));
        await server.Deliver(ChunkOf(1, (payload, 188, 12)));
        Assert.Equal([172L, 200L, 172L], CreditsOf(server.Sent));
        Assert.Equal(3u, server.Sent[^1].Header.CallId);

        var cross = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 200, MaximumPayloadBytes = 200, MaximumEnvelopeBytes = 64 });
        using var crossCore = cross.Core;
        var resolver = cross.Resolve();
        var first = RequesterBytesOf(168);

        await cross.Deliver(RequestOpeningOf(1, (first, 40)), "a");
        await cross.Deliver(new Envelope { Header = RequestOf(3) with { Total = 100 }, Payload = new byte[32] }, "b");
        await cross.Deliver(new Envelope { Header = RequestOf(5) with { Total = 8 }, Payload = new byte[] { 1 } }, "a");
        foreach (var offset in new[] { 40, 88, 136 })
        {
            await cross.Deliver(ChunkOf(1, (first, offset, Math.Min(48, first.Length - offset))), "a");
        }
        Assert.Single(resolver.Requests);
        Assert.Equal(new IEnvelopeHeader[] { new CreditHeader { CallId = 1, CreditEnd = 168 }, new FailureHeader { CallId = 5 }, new CreditHeader { CallId = 3, CreditEnd = 100 } }, cross.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, cross.Sent[1].Failure!.Code);
        Assert.Equal(["a", "a", "b"], cross.SentOn);
    }

    // spec 12.10
    [Fact]
    public async Task Ends_the_transfers_of_a_connection_that_goes_before_their_budget_grants_any_credit_and_sends_nothing_once_disposed()
    {
        var server = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256 });

        server.Resolve();

        var payload = RequesterBytesOf(200);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        server.Core.RejectPending("the connection closed", Handle);
        await server.Settle();
        Assert.Equal([172L], CreditsOf(server.Sent));

        server.Core.Dispose();
        await server.Deliver(RequestOpeningOf(5, (payload, 44)));
        Assert.Equal([172L], CreditsOf(server.Sent));

        var cross = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 200, MaximumPayloadBytes = 200, MaximumEnvelopeBytes = 64 });
        cross.Resolve();
        await cross.Deliver(new Envelope { Header = RequestOf(1) with { Total = 168 }, Payload = new byte[40] }, "a");
        await cross.Deliver(new Envelope { Header = RequestOf(3) with { Total = 100 }, Payload = new byte[16] }, "a");
        await cross.Deliver(new Envelope { Header = RequestOf(1) with { Total = 100 }, Payload = new byte[16] }, "b");
        cross.Core.RejectPending("gone", "a");
        await cross.Settle();
        await cross.Deliver(new Envelope { Header = RequestOf(3) with { Total = 200 }, Payload = new byte[44] }, "b");
        cross.Core.Dispose();
        await cross.Settle();
        Assert.Equal(new IEnvelopeHeader[] { new CreditHeader { CallId = 1, CreditEnd = 168 }, new CreditHeader { CallId = 1, CreditEnd = 100 } }, cross.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Empty(cross.Reports);
        Assert.Equal(["a", "b"], cross.SentOn);
    }

    [Fact]
    public async Task Sends_a_result_as_a_transfer_its_call_held_open_until_its_last_chunk_is_handed_off()
    {
        foreach (var total in new[] { 100, 150 })
        {
            var server = new Peer(RouterSide.Server);
            var resolver = server.Resolve();
            var payload = RequesterBytesOf(total);

            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

            var answered = resolver.Answer(0, payload);

            await server.Settle();
            Assert.Equal(new ResultHeader { CallId = 1, Total = total }, server.Sent[^1].Header);
            Assert.Equal(payload[..28], server.Sent[^1].Payload.ToArray());

            // its call is open still: the same call id is refused
            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
            Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, Assert.IsType<FailureException>(Assert.Single(server.Reports)).Code);
            await server.Deliver(CreditOf(1, total == 100 ? 76 : 80));
            Assert.Equal([(28L, false)], ChunksOf(server.Sent));
            Assert.False(answered.IsCompleted);
            await server.Deliver(CreditOf(1, total));
            await answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
            Assert.Equal(total == 100 ? [(28L, false), (76L, true)] : new List<(long, bool)> { (28L, false), (76L, false), (124L, true) }, ChunksOf(server.Sent));
            Assert.Equal(payload, server.Sent.SelectMany((envelope) => { return envelope.Payload.ToArray(); }).ToArray());
            int[] sizes = total == 100 ? [44, 64, 40] : [44, 64, 64, 42];
            Assert.Equal(sizes, server.Sent.Select((envelope) => { return EnvelopeCodec.WriteEnvelope(envelope).Length; }));
            Assert.All(server.Sent, (envelope) => { Assert.True(EnvelopeCodec.WriteEnvelope(envelope).Length <= 64); });
            Assert.Equal([Handle], server.ReportedOn);

            // answered: a request on its call id is dispatched
            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 3 } });
            Assert.Equal(2, resolver.Requests.Count);
        }
    }

    [Fact]
    public async Task Stops_a_result_the_peer_cancels_and_sends_nothing_more_of_it_whatever_credit_comes()
    {
        foreach (var (total, initialCredit) in new (int Total, int? InitialCredit)[] { (100, null), (150, 80) })
        {
            var server = new Peer(RouterSide.Server, Chunked with
            {
                BufferedBytesBudget = 1_024,
                MaximumEnvelopeBytes = 64,
                MaximumPayloadBytes = 1_024,
                TransferInactivityTimeout = TimeSpan.FromSeconds(30),
            });
            using var core = server.Core;
            var resolver = server.Resolve();

            await server.Deliver(new Envelope { Header = RequestOf(1), Payload = total == 100 ? new byte[] { 1 } : ReadOnlyMemory<byte>.Empty });

            var payload = Enumerable.Range(0, total).Select((index) =>
            {
                return (byte)(((index * 7) + 3) % 256);
            }).ToArray();
            var answered = resolver.Answer(0, payload);

            await server.Settle();
            if (initialCredit is { } credit)
            {
                await server.Deliver(CreditOf(1, credit));
            }
            await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 1 } });
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            {
                return answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });
            Assert.True(answered.IsCanceled);
            Assert.True(Assert.Single(resolver.Requests).Signal.IsCancellationRequested);
            await server.Deliver(CreditOf(1, total));
            Assert.Equal(new ResultHeader { CallId = 1, Total = total }, server.Sent[0].Header);
            Assert.Equal(payload[..28], server.Sent[0].Payload.ToArray());
            if (initialCredit is null)
            {
                Assert.Single(server.Sent);
                Assert.Empty(ChunksOf(server.Sent));
            }
            else
            {
                Assert.Equal(2, server.Sent.Count);
                Assert.Equal([(28L, false)], ChunksOf(server.Sent));
                Assert.Equal(payload[28..76], server.Sent[1].Payload.ToArray());
            }
            Assert.Empty(server.Reports);
        }
    }

    [Fact]
    public async Task Ends_a_result_whose_chunk_cannot_go_out_forgetting_its_call()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var refused = new IOException("the transport refused the chunk");

        server.OnSend = (envelope) =>
        {
            return envelope.Header is ChunkHeader ? Task.FromException(refused) : Task.CompletedTask;
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

        var answered = resolver.Answer(0, PatternOf(100));

        await server.Settle();
        await server.Deliver(CreditOf(1, 100));
        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal(2, resolver.Requests.Count);
    }

    [Fact]
    public async Task Refuses_a_transfer_for_a_subscription_s_result_or_on_a_call_it_never_dispatched_before_the_side_hears_of_it()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1) with { OpensSubscription = true }, Payload = new byte[] { 1 } });

        var subscribing = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return resolver.Answer(0, RequesterBytesOf(100)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, subscribing.Code);
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfPayload(RequesterBytesOf(100)), new AnswerTarget(Handle, RequestOf(3)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal(0, server.BeforeAnswers);
        Assert.Empty(server.Sent);

        var boundary = new Peer(RouterSide.Server, Chunked with { MaximumEnvelopeBytes = 64 });
        using var boundaryCore = boundary.Core;
        var boundaryResolver = boundary.Resolve();
        await boundary.Deliver(new Envelope { Header = RequestOf(1) with { OpensSubscription = true } });
        var tooLarge = await Assert.ThrowsAsync<FailureException>(() => { return boundaryResolver.Answer(0, new byte[37]).WaitAsync(Patience, TestContext.Current.CancellationToken); });
        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, tooLarge.Code);
        Assert.Equal("a subscription's result goes in one envelope, of 64 bytes at most", tooLarge.Detail);
        await Assert.ThrowsAsync<ArgumentException>(() => { return boundaryCore.Respond(RouterAnswer.OfPayload(new byte[37]), new AnswerTarget(Handle, RequestOf(3))).WaitAsync(Patience, TestContext.Current.CancellationToken); });
        Assert.Equal(0, boundary.BeforeAnswers);
        Assert.Empty(boundary.Sent);
        await boundaryResolver.Answer(0, new byte[36]).WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal(1, boundary.BeforeAnswers);
        Assert.Equal(new ResultHeader { CallId = 1 }, Assert.Single(boundary.Sent).Header);
        Assert.Equal(new byte[36], boundary.Sent[0].Payload.ToArray());
    }

    [Fact]
    public async Task Announces_a_session_on_a_result_s_opening_which_leaves_room_for_it_within_its_envelope()
    {
        var server = new Peer(RouterSide.Server) { Session = SessionToken.FromBytes(Enumerable.Repeat((byte)1, 16).ToArray()) };
        var resolver = server.Resolve();
        var payload = RequesterBytesOf(100);

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        var answering = resolver.Answer(0, payload);
        await server.Settle();

        var opening = server.Sent[^1];

        Assert.Equal(new ResultHeader { CallId = 1, Total = 100, Credential = server.Session }, opening.Header);
        Assert.Equal(64, EnvelopeCodec.WriteEnvelope(opening).Length);
        await server.Deliver(CreditOf(1, 100));
        await answering.WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([64, 64, 40], server.Sent.Select((envelope) => { return EnvelopeCodec.WriteEnvelope(envelope).Length; }));
    }

    // spec 12.10
    [Fact]
    public async Task Ends_the_transfers_it_sends_on_a_connection_that_goes_and_on_a_router_disposed_sending_nothing_more()
    {
        var gone = new Peer(RouterSide.Client);
        var asked = gone.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await gone.Settle();
        gone.Core.RejectPending("the connection closed", Handle);
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await gone.Deliver(CreditOf(1, 300));
        Assert.Empty(ChunksOf(gone.Sent));

        var disposed = new Peer(RouterSide.Client);
        var given = disposed.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await disposed.Settle();
        disposed.Core.Dispose();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return given.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await disposed.Deliver(CreditOf(1, 300));
        Assert.Single(disposed.Sent);

        var both = new Peer(RouterSide.Server, Chunked with { MaximumEnvelopeBytes = 64, MaximumPayloadBytes = 1_024, BufferedBytesBudget = 1_024 });
        using var bothCore = both.Core;
        var resolver = both.Resolve();
        var asking = bothCore.Request(RequesterBytesOf(200), new CoreRequest { ConnectionHandle = "b", Procedure = Echo, Options = new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(1) } });
        await both.Deliver(new Envelope { Header = RequestOf(1) }, "a");
        var responding = resolver.Answer(0, RequesterBytesOf(150));
        await both.Settle();
        bothCore.RejectPending("gone", "a");
        await both.Deliver(CreditOf(1, 150), "a");
        Assert.Equal("gone", (await Assert.ThrowsAsync<DisconnectException>(() => { return responding.WaitAsync(Patience, TestContext.Current.CancellationToken); })).Message);
        Assert.False(asking.IsCompleted);
        bothCore.Dispose();
        await both.Deliver(CreditOf(2, 200), "b");
        await Assert.ThrowsAsync<DisconnectException>(() => { return asking.WaitAsync(Patience, TestContext.Current.CancellationToken); });
        Assert.Equal(new IEnvelopeHeader[] { RequestOf(2) with { Total = 200 }, new ResultHeader { CallId = 1, Total = 150 } }, both.Sent.Select((envelope) => { return envelope.Header; }));
        Assert.Equal([44, 28], both.Sent.Select((envelope) => { return envelope.Payload.Length; }));
        Assert.Equal(["b", "a"], both.SentOn);
        Assert.Empty(both.Reports);
    }

    [Fact]
    public async Task Ends_nothing_by_a_timer_that_fired_as_a_credit_set_it_going_again()
    {
        // C# only: a timer fires on the thread pool and posts its end to the core's scheduler, where
        // a credit that came first set it going again; JavaScript's one thread has no such race
        var peer = new Peer(RouterSide.Client);
        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await peer.Settle();

        using var gate = new ManualResetEventSlim();

        // the scheduler held, a credit comes, then the transfer's inactivity passes
        peer.Loop.Post(() =>
        {
            gate.Wait(TestContext.Current.CancellationToken);
        });
        peer.Core.Receive(EnvelopeCodec.WriteEnvelope(CreditOf(1, 172)), Handle);
        peer.Clock.Advance(TimeSpan.FromSeconds(2));
        gate.Set();
        await peer.Settle();
        Assert.False(asked.IsCompleted);
        Assert.Equal(2, ChunksOf(peer.Sent).Count);
    }

    [Fact]
    public async Task Ends_the_transfer_a_chunk_that_does_not_read_was_for_but_where_it_is_late_or_its_payload_whole()
    {
        static byte[] BytesOf(int length)
        {
            return Enumerable.Range(0, length).Select((index) =>
            {
                return (byte)(((index * 7) + 3) % 256);
            }).ToArray();
        }

        static (EnvelopeKind Kind, uint CallId, long Value)[] TrafficOf(Peer peer)
        {
            return [.. peer.Sent.Select((envelope) =>
            {
                var value = envelope.Header is CreditHeader credit ? credit.CreditEnd : envelope.Failure?.Code ?? 0;

                return (envelope.Header.Kind, envelope.Header.CallId, value);
            })];
        }

        var limits = Chunked with
        {
            BufferedBytesBudget = 1_024,
            MaximumEnvelopeBytes = 64,
            MaximumPayloadBytes = 1_024,
            TransferInactivityTimeout = TimeSpan.FromSeconds(30),
        };
        var simultaneous = new Peer(RouterSide.Server, limits);
        using var simultaneousCore = simultaneous.Core;
        var resolver = simultaneous.Resolve();
        var bytes = BytesOf(200);
        var asking = simultaneous.Request(ReadOnlyMemory<byte>.Empty, TimeSpan.FromSeconds(1));

        await simultaneous.Settle();
        await simultaneous.Deliver(RequestOpeningOf(1, (bytes, 40)));
        await simultaneous.Deliver(ResultOpeningOf(2, (bytes, 32)));
        await simultaneous.Deliver(RequestOpeningOf(3, (bytes[..60], 40)));
        await simultaneous.Deliver(ChunkOf(3, (bytes[..60], 40, 20)));

        foreach (var callId in new[] { 1, 1, 2, 2, 3, 5 })
        {
            await simultaneous.Deliver($"A1 14 00 04  00 00 00 0{callId}  00 00 00 00 00 00 00 00");
        }

        await simultaneous.Deliver("A1 15 00 04  00 00 00 01  00 00 00 00 00 00 00 08  01");
        await simultaneous.Deliver(new Envelope
        {
            Header = new ChunkHeader { CallId = 3, IsLast = false, Offset = 50 },
            Payload = new byte[20],
        });
        await resolver.Answer(0, new byte[] { 9 });

        var broken = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asking.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, RouterSide.Server), (broken.Code, broken.Side));
        Assert.Equal(FailureOrigin.Local, broken.Origin);
        Assert.Equal(
            [(EnvelopeKind.Request, 2u, 0L), (EnvelopeKind.Credit, 1u, 168L), (EnvelopeKind.Credit, 2u, 160L),
                (EnvelopeKind.Credit, 3u, 60L), (EnvelopeKind.Failure, 1u, (long)ProtocolCode.ChunkInvalid),
                (EnvelopeKind.Cancel, 2u, 0L), (EnvelopeKind.Result, 3u, 0L)],
            TrafficOf(simultaneous));
        Assert.Equal(new byte[] { 9 }, simultaneous.Sent[^1].Payload.ToArray());
        Assert.Equal(
            [(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.EnvelopeMalformed,
                (ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.ChunkInvalid],
            simultaneous.Reports.Select(CodeOf));
        Assert.Equal([Handle, Handle, Handle, Handle], simultaneous.ReportedOn);
        var dispatched = Assert.Single(resolver.Requests);

        Assert.Equal((3u, 60L), (dispatched.Header.CallId, dispatched.Header.Total));
        Assert.Equal(bytes[..60], dispatched.Payload.ToArray());

        // an offset of 2⁵³, above the largest safe integer
        const string Unreadable = "A1 14 40 04  00 00 00 01  00 20 00 00 00 00 00 00 | 01";

        var client = new Peer(RouterSide.Client, limits);
        using var clientCore = client.Core;
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (BytesOf(300), 32)));
        await client.Deliver(Unreadable);

        var invalid = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, FailureOrigin.Local), (invalid.Code, invalid.Origin));
        Assert.Equal(RouterSide.Client, invalid.Side);
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);
        Assert.Equal(
            [(EnvelopeKind.Request, 1u, 0L), (EnvelopeKind.Credit, 1u, 160L), (EnvelopeKind.Cancel, 1u, 0L)],
            TrafficOf(client));

        // late, on its call id reserved; on a call id of its own it never opened, reported
        await client.Deliver(Unreadable);
        Assert.Empty(client.Reports);
        await client.Deliver("A1 14 40 04  00 00 00 05  00 20 00 00 00 00 00 00 | 01");
        Assert.Single(client.Reports);
        Assert.Equal([(ushort)ProtocolCode.EnvelopeMalformed], client.Reports.Select(CodeOf));
        Assert.Equal([Handle], client.ReportedOn);

        // on a call whose payload came whole: reported; on one abandoned: dropped; on none: reported
        var server = new Peer(RouterSide.Server, limits);
        using var serverCore = server.Core;
        var payload = BytesOf(100);

        var received = server.Resolve();
        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(ChunkOf(1, (payload, 44, 48)));
        await server.Deliver(ChunkOf(1, (payload, 92, 8)));
        await server.Deliver(Unreadable);
        Assert.Single(server.Reports);
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        await server.Deliver(ChunkOf(3, (payload, 44, 20)));
        await server.Deliver("A1 14 40 04  00 00 00 03  00 20 00 00 00 00 00 00 | 01");
        Assert.Single(server.Reports);
        await server.Deliver("A1 14 40 04  00 00 00 05  00 20 00 00 00 00 00 00 | 01");
        Assert.Equal(2, server.Reports.Count);
        Assert.Equal([(ushort)ProtocolCode.EnvelopeMalformed, (ushort)ProtocolCode.EnvelopeMalformed], server.Reports.Select(CodeOf));
        Assert.Equal([Handle, Handle], server.ReportedOn);
        Assert.Equal(
            [(EnvelopeKind.Credit, 1u, 100L), (EnvelopeKind.Credit, 3u, 100L), (EnvelopeKind.Failure, 3u, (long)ProtocolCode.ChunkInvalid)],
            TrafficOf(server));
        Assert.Equal(1u, Assert.Single(received.Requests).Header.CallId);
        Assert.Equal(payload, received.Requests[0].Payload.ToArray());
    }

    [Fact]
    public async Task Ends_a_result_whose_opening_cannot_go_out_forgetting_its_call()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var refused = new IOException("the transport refused the opening");

        server.OnSend = (envelope) =>
        {
            return envelope.Header is ResultHeader { Total: not null } ? Task.FromException(refused) : Task.CompletedTask;
        };
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return resolver.Answer(0, PatternOf(100)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal(2, resolver.Requests.Count);
    }

    [Fact]
    public async Task Ends_nothing_by_a_result_s_timer_that_fired_as_a_credit_set_it_going_again()
    {
        // C# only: as the request's twin above, for a result the core sends
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

        var answered = resolver.Answer(0, PatternOf(300));

        await server.Settle();

        using var gate = new ManualResetEventSlim();

        server.Loop.Post(() =>
        {
            gate.Wait(TestContext.Current.CancellationToken);
        });
        server.Core.Receive(EnvelopeCodec.WriteEnvelope(CreditOf(1, 76)), Handle);
        server.Clock.Advance(TimeSpan.FromSeconds(2));
        gate.Set();
        await server.Settle();
        Assert.False(answered.IsCompleted);
        Assert.Equal([(28L, false)], ChunksOf(server.Sent));
    }

    [Fact]
    public async Task Carries_a_request_and_its_result_as_transfers_their_chunks_and_credits_doubled_and_out_of_order()
    {
        var link = new Shuffled();
        var payload = PatternOf(1_000);
        var asked = link.Client.Request(
            payload,
            new CoreRequest
            {
                ConnectionHandle = Handle,
                Procedure = Echo,
                Options = new ResolvedRequestOptions { Timeout = TimeSpan.FromSeconds(5) },
            });

        await link.Run();

        var result = await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(payload, result.Payload.ToArray());
        Assert.Empty(link.Reports);
    }

    [Fact]
    public async Task Refuses_the_opening_of_a_sender_whose_chunkBytes_is_larger_than_its_own_ENVELOPE_TOO_LARGE_and_the_chunks_of_one_whose_chunkBytes_is_smaller_CHUNK_INVALID_both_ends_setting_their_limits_alike()
    {
        var larger = Chunked with { ChunkBytes = 128, WindowBytes = 256 };

        foreach (var (requesterLimits, receiverLimits, chunks, refusal) in new (RouterLimits, RouterLimits, int[]?, (ProtocolCode Code, string Detail))[]
        {
            // its opening of 128 bytes past the receiver's request of 64 at most, nothing credited
            (larger, Chunked, null, (ProtocolCode.EnvelopeTooLarge, "a request is 64 bytes at most, not 128")),

            // its chunks of 48 under the receiver's full of 112, every one under the credit
            (Chunked, larger, [48, 48, 48, 48, 48, 16], (ProtocolCode.ChunkInvalid, "a chunk before the last carries 112 bytes, not 48")),
        })
        {
            var requester = new Peer(RouterSide.Client, requesterLimits);
            var receiver = new Peer(RouterSide.Server, receiverLimits);
            var resolver = receiver.Resolve();

            requester.OnSend = (envelope) =>
            {
                receiver.Core.Receive(EnvelopeCodec.WriteEnvelope(envelope), Handle);

                return Task.CompletedTask;
            };
            receiver.OnSend = (envelope) =>
            {
                requester.Core.Receive(EnvelopeCodec.WriteEnvelope(envelope), Handle);

                return Task.CompletedTask;
            };

            var asked = requester.Request(PatternOf(300), TimeSpan.FromSeconds(5));

            for (var round = 0; round < 4; round += 1)
            {
                await requester.Settle();
                await receiver.Settle();
            }

            var failed = await Assert.ThrowsAsync<FailureException>(() =>
            {
                return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
            });

            Assert.Equal(
                ((ushort)refusal.Code, refusal.Detail, FailureOrigin.Peer),
                (failed.Code, failed.Detail, failed.Origin));

            // the opening refused; or taken and credited, then the first chunk refused
            Assert.Equal(
                [(EnvelopeKind.Request, requesterLimits.ChunkBytes), .. (chunks ?? []).Select((bytes) =>
                {
                    return (EnvelopeKind.Chunk, 16 + bytes);
                })],
                requester.Sent.Select((envelope) =>
                {
                    return (envelope.Kind, EnvelopeCodec.WriteEnvelope(envelope).Length);
                }));
            Assert.Equal(
                chunks is null ? [EnvelopeKind.Failure] : [EnvelopeKind.Credit, EnvelopeKind.Failure],
                receiver.Sent.Select((envelope) =>
                {
                    return envelope.Kind;
                }));
            Assert.Empty(resolver.Requests);
        }
    }

    // a resolver of one procedure, the interop service's echo, or the handler of a destination, that
    // keeps each request it is given for the test to answer; what it admits, and what handling a
    // request does, are the test's to say
    private sealed class Held(RouterCore core) : IRequestResolver, IDestinationHandler
    {
        public Procedure Procedure { get; init; } = Echo;

        public int? MaximumPayloadBytes { get; init; }

        // whether, as a destination's handler, it forwards a JWT and an ELSEWHERE without resolving
        // them, as a relay that does not verify
        public bool ForwardsCredentials { get; init; }

        public List<RequestResolverProps> Requests { get; } = [];

        // the requests asked their admission
        public int Admitted { get; private set; }

        public Func<AdmissionRequest, Failure?>? Admission { get; set; }

        public Func<RequestResolverProps, Task>? Handling { get; set; }

        public Failure? Admit(AdmissionRequest request)
        {
            Admitted += 1;

            return Admission?.Invoke(request);
        }

        public Task Handle(RequestResolverProps props)
        {
            Requests.Add(props);

            return Handling?.Invoke(props) ?? Task.CompletedTask;
        }

        public Task Answer(int index, ReadOnlyMemory<byte> payload)
        {
            var props = Requests[index];

            return core.Respond(RouterAnswer.OfPayload(payload), new AnswerTarget(props.ConnectionHandle, props.Header));
        }

        public Task Fail(int index, Failure failure)
        {
            var props = Requests[index];

            return core.Respond(RouterAnswer.OfFailure(failure), new AnswerTarget(props.ConnectionHandle, props.Header));
        }
    }

    // a core of either side whose peer is the test: what it sends is read back, in order, and what it
    // reports kept; what the peer sends it goes through Deliver, and the clock moves through Advance
    private sealed class Peer : IRouterCorePort
    {
        public Peer(RouterSide side, RouterLimits? limits = null, uint? lastCallId = null)
        {
            Side = side;
            Core = new RouterCore(
                this,
                new RouterCoreOptions
                {
                    LastCallId = lastCallId,
                    Limits = limits ?? Chunked,
                    ResolverScheduler = Loop,
                    Scheduler = Loop,
                    Clock = Clock,
                });
        }

        public RouterSide Side { get; }

        public FakeTimeProvider Clock { get; } = new();

        public SerialScheduler Loop { get; } = new();

        public RouterCore Core { get; }

        public List<Envelope> Sent { get; } = [];

        public List<string> SentOn { get; } = [];

        public List<Exception> Reports { get; } = [];

        // the connection each report came with, in order
        public List<string?> ReportedOn { get; } = [];

        public List<RouterActivity> Activities { get; } = [];

        public int BeforeAnswers { get; private set; }

        public Func<AnswerInfo, Action?>? OnBeforeAnswer { get; set; }

        // what an answer that did not go out undid
        public int Undone { get; private set; }

        public List<(DebugDirection Direction, TracedEnvelope Envelope)> Traces { get; } = [];

        // the call ids the side holds otherwise: a subscription's
        public HashSet<uint> InUse { get; } = [];

        // the handler of a request that names a destination, when the test gives one, as a relay's
        public Func<RequestHeader, IDestinationHandler?>? Destination { get; set; }

        public bool IsTwoWayConnection { get; set; } = true;

        public int TwoWayAsked { get; private set; }

        // whether its transport carries a credential beside an envelope, and is secure: in process
        public bool IsCarrying { get; set; } = true;

        public bool IsSecureConnection { get; set; } = true;

        // what its transport was handed beside each envelope, in order
        public List<string?> Carried { get; } = [];

        // what the transport does as it is handed an envelope, before its send settles
        public Func<Envelope, Task>? OnSend { get; set; }

        public SessionToken? Session { get; set; }

        // the session of a connection, when the test says it otherwise
        public Func<string, SessionToken?>? TokenOf { get; set; }

        // the credential schemes the side takes, when the test says it takes more than OPAQUE
        public IReadOnlyList<CredentialScheme>? Schemes { get; set; }

        // how a request's credential resolves, when the test says it otherwise: each one asked is kept
        public Func<SessionRequest, CancellationToken, ValueTask<CallSession?>>? Resolution { get; set; }

        public List<(SessionRequest Request, CancellationToken Signal)> Resolved { get; } = [];

        public IReadOnlyList<CredentialScheme> CredentialSchemes
        {
            get
            {
                return Schemes ?? [CredentialScheme.Opaque];
            }
        }

        // whether the side takes a failure no call waits on
        public Func<Envelope, bool>? Unpaired { get; set; }

        public void Activity(RouterActivity activity, string connectionHandle)
        {
            Activities.Add(activity);
        }

        public Action? BeforeAnswer(AnswerInfo answer)
        {
            BeforeAnswers += 1;
            var undo = OnBeforeAnswer?.Invoke(answer);

            return () =>
            {
                Undone += 1;
                undo?.Invoke();
            };
        }

        public bool IsCallIdInUse(uint callId, string connectionHandle)
        {
            return InUse.Contains(callId);
        }

        public IDestinationHandler? HandlerOfDestination(RequestHeader header)
        {
            return Destination?.Invoke(header);
        }

        public bool IsTwoWay(string connectionHandle)
        {
            TwoWayAsked += 1;

            return IsTwoWayConnection;
        }

        public bool OnUnpairedFailure(Envelope envelope, string connectionHandle)
        {
            return Unpaired?.Invoke(envelope) ?? false;
        }

        public SessionToken? SessionTokenOf(string connectionHandle)
        {
            return TokenOf is null ? Session : TokenOf(connectionHandle);
        }

        public ValueTask<CallSession?> SessionOf(SessionRequest request, CancellationToken signal)
        {
            Resolved.Add((request, signal));

            return Resolution?.Invoke(request, signal)
                ?? ValueTask.FromResult(CallSession.ConnectionSessionOf(request.Header.Credential, (SessionTokenOf(request.ConnectionHandle), null)));
        }

        // it hears every envelope, so the core traces each
        public bool IsTracing
        {
            get
            {
                return true;
            }
        }

        public void Trace(DebugDirection direction, TracedEnvelope envelope)
        {
            Traces.Add((direction, envelope));
        }

        public void Report(Exception reason, string? connectionHandle)
        {
            Reports.Add(reason);
            ReportedOn.Add(connectionHandle);
        }

        public bool Carries(string credential, string connectionHandle)
        {
            return IsCarrying;
        }

        public bool IsSecure(string connectionHandle)
        {
            return IsSecureConnection;
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            Carried.Add(message.Credential);
            SentOn.Add(connectionHandle);

            var envelope = EnvelopeCodec.ReadEnvelope(
                message.Bytes.Span,
                new EnvelopeReadOptions { Side = CallIds.PeerOf(Side), MaximumEnvelopeBytes = int.MaxValue })!;

            Sent.Add(envelope);

            return OnSend?.Invoke(envelope) ?? Task.CompletedTask;
        }

        public Held Resolve(int? maximumPayloadBytes = null)
        {
            var resolver = new Held(Core) { MaximumPayloadBytes = maximumPayloadBytes };

            Core.RegisterResolver(resolver);

            return resolver;
        }


        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, (TimeSpan Timeout, CancellationToken Token) options)
        {
            return Core.Request(
                payload,
                new CoreRequest
                {
                    ConnectionHandle = Handle,
                    Procedure = Echo,
                    Options = new ResolvedRequestOptions { Timeout = options.Timeout, CancellationToken = options.Token },
                });
        }

        public Task<RouterResult> Request(ReadOnlyMemory<byte> payload, TimeSpan timeout)
        {
            return Request(payload, (timeout, CancellationToken.None));
        }

        // the call id a request went out on
        public async Task<uint> CallIdOf(Task<RouterResult> asked)
        {
            await Settle();

            return Sent.Last((envelope) =>
            {
                return envelope.Header is RequestHeader;
            }).Header.CallId;
        }

        public async Task Deliver(Envelope envelope, string connectionHandle = Handle)
        {
            Core.Receive(EnvelopeCodec.WriteEnvelope(envelope), connectionHandle);
            await Settle();
        }

        // bytes as the vectors write them, which need not read
        public async Task Deliver(string hexadecimal, string connectionHandle = Handle)
        {
            Core.Receive(Vectors.FromHexadecimal(hexadecimal), connectionHandle);
            await Settle();
        }

        public async Task Advance(TimeSpan by)
        {
            Clock.Advance(by);
            await Settle();
        }

        public async Task Settle()
        {
            for (var round = 0; round < 3; round += 1)
            {
                await Loop.WhenIdle();
            }
        }
    }

    // a client's core and a server's, each sending into a queue the test drains: every chunk and
    // credit doubled, and what is queued taken from its end, out of order
    private sealed class Shuffled
    {
        private readonly List<(RouterCore To, byte[] Bytes)> _queue = [];
        private readonly SerialScheduler _loop = new();

        public Shuffled()
        {
            Client = new RouterCore(new Side(this, RouterSide.Client), new RouterCoreOptions { Limits = Chunked, ResolverScheduler = _loop, Scheduler = _loop });
            Server = new RouterCore(new Side(this, RouterSide.Server), new RouterCoreOptions { Limits = Chunked, ResolverScheduler = _loop, Scheduler = _loop });

            var server = Server;

            Server.RegisterResolver(new Echoing(server));
        }

        public RouterCore Client { get; }

        public RouterCore Server { get; }

        public List<Exception> Reports { get; } = [];

        // delivers what is queued, last first, until nothing more comes
        public async Task Run()
        {
            await _loop.WhenIdle();

            while (_queue.Count > 0)
            {
                var (to, bytes) = _queue[^1];

                _queue.RemoveAt(_queue.Count - 1);
                to.Receive(bytes, Handle);
                await _loop.WhenIdle();
            }
        }

        private void Queue(RouterSide from, ReadOnlyMemory<byte> bytes)
        {
            var to = from == RouterSide.Client ? Server : Client;
            var kind = (EnvelopeKind)bytes.Span[1];

            _queue.Add((to, bytes.ToArray()));

            if (kind is EnvelopeKind.Chunk or EnvelopeKind.Credit)
            {
                _queue.Insert(0, (to, bytes.ToArray()));
            }
        }

        private sealed class Side(Shuffled link, RouterSide side) : IRouterCorePort
        {
            RouterSide IRouterCorePort.Side
            {
                get
                {
                    return side;
                }
            }

            public void Report(Exception reason, string? connectionHandle)
            {
                link.Reports.Add(reason);
            }

            public Task Send(TransportMessage message, string connectionHandle)
            {
                link.Queue(side, message.Bytes);

                return Task.CompletedTask;
            }
        }

        // echo, answered by the server's core itself
        private sealed class Echoing(RouterCore core) : IRequestResolver
        {
            public Procedure Procedure
            {
                get
                {
                    return Echo;
                }
            }

            public int? MaximumPayloadBytes
            {
                get
                {
                    return null;
                }
            }

            public Failure? Admit(AdmissionRequest request)
            {
                return null;
            }

            public Task Handle(RequestResolverProps props)
            {
                _ = core.Respond(RouterAnswer.OfPayload(props.Payload), new AnswerTarget(props.ConnectionHandle, props.Header));

                return Task.CompletedTask;
            }
        }
    }

    private static RequestHeader RequestOf(uint callId)
    {
        return new RequestHeader { CallId = callId, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId };
    }
}
