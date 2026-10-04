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

    private static readonly Procedure Echo = InteropService.ProcedureOf("echo");

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
    public async Task Sends_a_request_as_a_transfer_its_opening_the_chunks_each_credit_lets_go_then_waits_on_its_answer()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(payload, TimeSpan.FromSeconds(5));

        await peer.Settle();

        var opening = Assert.Single(peer.Sent);

        Assert.Equal(new RequestHeader { CallId = 1, ServiceId = Echo.ServiceId, ProcedureId = Echo.ProcedureId, Total = 300 }, opening.Header);
        Assert.Equal(payload[..44], opening.Payload.ToArray());

        // a credit of 172 lets two full chunks go; the third would pass it
        await peer.Deliver(CreditOf(1, 172));
        Assert.Equal([(44L, false), (92L, false)], ChunksOf(peer.Sent));
        Assert.Empty(peer.Activities);
        await peer.Deliver(CreditOf(1, 300));
        Assert.Equal([(44L, false), (92L, false), (140L, false), (188L, false), (236L, false), (284L, true)], ChunksOf(peer.Sent));
        Assert.Equal(payload[284..], peer.Sent[^1].Payload.ToArray());
        Assert.Equal([RouterActivity.Request], peer.Activities);

        // whole, it waits on its answer
        await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = new byte[] { 1 } });
        Assert.Equal(new byte[] { 1 }, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
    }

    [Fact]
    public async Task Waits_on_a_request_s_own_timer_the_inactivity_while_it_goes_as_a_transfer_then_its_timeout_for_its_answer()
    {
        var peer = new Peer(RouterSide.Client);
        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(1));

        // past its timeout, short of the transfer's inactivity, which a credit sets going again — one
        // that lets no full chunk go too
        await peer.Settle();
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(CreditOf(1, 80));
        Assert.Empty(ChunksOf(peer.Sent));
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        Assert.False(asked.IsCompleted);

        // its last chunk handed off, its timeout counts afresh
        await peer.Deliver(CreditOf(1, 300));
        await peer.Advance(TimeSpan.FromSeconds(0.9));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.1));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.IsType<CancelHeader>(peer.Sent[^1].Header);
    }

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

    [Fact]
    public async Task Stops_a_request_the_peer_answers_or_its_caller_gives_up_and_sends_nothing_more_of_it()
    {
        var answered = new Peer(RouterSide.Client);
        var asked = answered.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await answered.Settle();
        await answered.Deliver(CreditOf(1, 100));
        await answered.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfApplication(7) });
        await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await answered.Deliver(CreditOf(1, 300));
        Assert.Equal([(44L, false)], ChunksOf(answered.Sent));

        var cancelled = new Peer(RouterSide.Client);

        using var source = new CancellationTokenSource();

        var given = cancelled.Request(PatternOf(300), (TimeSpan.FromSeconds(5), source.Token));

        await cancelled.Settle();
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return given.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await cancelled.Deliver(CreditOf(1, 300));
        Assert.Empty(ChunksOf(cancelled.Sent));
        Assert.IsType<CancelHeader>(cancelled.Sent[^1].Header);
    }

    [Fact]
    public async Task Ends_a_request_whose_chunk_cannot_go_out_telling_the_peer_to_cancel_it()
    {
        var peer = new Peer(RouterSide.Client);
        var refused = new IOException("the transport refused the chunk");

        peer.OnSend = (envelope) =>
        {
            return envelope.Header is ChunkHeader ? Task.FromException(refused) : Task.CompletedTask;
        };

        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(CreditOf(1, 300));
        Assert.Same(refused, await Assert.ThrowsAsync<IOException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        }));
        Assert.Single(peer.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
    }

    [Fact]
    public async Task Receives_a_result_in_a_transfer_credited_as_it_comes_and_settles_its_call_once_whole()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        Assert.Equal([160L], CreditsOf(peer.Sent));

        // in any order; a credit once half a window can go
        foreach (var offset in new[] { 80, 32, 128, 176, 224 })
        {
            await peer.Deliver(ChunkOf(1, (payload, offset, 48)));
        }

        Assert.Equal([160L, 256L, 300L], CreditsOf(peer.Sent));
        Assert.False(asked.IsCompleted);
        await peer.Deliver(ChunkOf(1, (payload, 272, 28)));

        var result = await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);

        Assert.Equal(payload, result.Payload.ToArray());
        Assert.Equal(300, ((ResultHeader)result.Header).Total);
        Assert.Equal([RouterActivity.Request, RouterActivity.Response], peer.Activities);

        // what its credit let come, a copy, is late, and dropped in silence
        await peer.Deliver(ChunkOf(1, (payload, 224, 48)));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Rejects_a_result_whose_chunk_breaks_its_transfer_cancels_its_call_and_drops_what_comes_after()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(ChunkOf(1, (payload, 32, 20)));

        var invalid = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.ChunkInvalid, invalid.Code);
        Assert.Equal(FailureOrigin.Local, invalid.Origin);
        Assert.Equal(Echo.Address, invalid.ProcedureAddress);
        Assert.IsType<CancelHeader>(peer.Sent[^1].Header);
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
    }

    [Fact]
    public async Task Ends_a_result_s_transfer_the_peer_fails_and_drops_what_comes_after()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(new Envelope { Header = new FailureHeader { CallId = 1 }, Failure = Failure.OfProtocol(ProtocolCode.TransferStalled) });
        Assert.Equal((ushort)ProtocolCode.TransferStalled, (await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        })).Code);

        // the peer ended it: no cancel, and what its credit let come is dropped in silence
        Assert.DoesNotContain(peer.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
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
    public async Task Reports_a_second_result_on_a_call_whose_result_comes_in_a_transfer_and_goes_on_receiving_it()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(100);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Deliver(new Envelope { Header = new ResultHeader { CallId = 1 }, Payload = new byte[] { 9 } });
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, Assert.IsType<FailureException>(Assert.Single(peer.Reports)).Code);
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        await peer.Deliver(ChunkOf(1, (payload, 80, 20)));
        Assert.Equal(payload, (await asked.WaitAsync(Patience, TestContext.Current.CancellationToken)).Payload.ToArray());
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
        var payload = PatternOf(100);

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
        var payload = PatternOf(100);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(ChunkOf(1, (payload, 44, 48)));
        await server.Deliver(ChunkOf(1, (payload, 92, 8)));
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, server.Sent[^1].Failure!.Code);
        await resolver.Answer(0, new byte[] { 1 }).WaitAsync(Patience, TestContext.Current.CancellationToken);
        await server.Deliver(RequestOpeningOf(5, (payload, 44)));
        Assert.Equal(new CreditHeader { CallId = 5, CreditEnd = 100 }, server.Sent[^1].Header);
    }

    [Fact]
    public async Task Gives_the_budget_back_once_a_payload_is_whole_and_grants_the_transfer_it_starved()
    {
        var server = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256 });

        server.Resolve();

        var payload = PatternOf(200);

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
    }

    [Fact]
    public async Task Ends_the_transfers_of_a_connection_that_goes_before_their_budget_grants_any_credit_and_sends_nothing_once_disposed()
    {
        var server = new Peer(RouterSide.Server, Chunked with { BufferedBytesBudget = 256, MaximumPayloadBytes = 256 });

        server.Resolve();

        var payload = PatternOf(200);

        await server.Deliver(RequestOpeningOf(1, (payload, 44)));
        await server.Deliver(RequestOpeningOf(3, (payload, 44)));
        server.Core.RejectPending("the connection closed", Handle);
        await server.Settle();
        Assert.Equal([172L], CreditsOf(server.Sent));

        server.Core.Dispose();
        await server.Deliver(RequestOpeningOf(5, (payload, 44)));
        Assert.Equal([172L], CreditsOf(server.Sent));
    }

    [Fact]
    public async Task Reserves_the_call_id_of_a_result_it_received_in_part_as_long_as_the_peer_keeps_its_call_abandoned_or_its_timeout_when_longer()
    {
        var peer = new Peer(RouterSide.Client, Chunked, lastCallId: 3);
        var payload = PatternOf(300);

        using var source = new CancellationTokenSource();

        var asked = peer.Request(new byte[] { 1 }, (TimeSpan.FromSeconds(1), source.Token));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await source.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        // its timeout of 1 s is shorter than the 2 s the peer keeps its call abandoned
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Empty(peer.Reports);
        Assert.Equal(3u, await peer.CallIdOf(peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5))));
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.Equal((ushort)ProtocolCode.CallUnknown, Assert.IsType<FailureException>(Assert.Single(peer.Reports)).Code);
    }

    [Fact]
    public async Task Sets_a_call_s_timer_going_again_as_the_bytes_of_its_result_come_and_not_for_bytes_it_has()
    {
        var peer = new Peer(RouterSide.Client);
        var payload = PatternOf(300);
        var asked = peer.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await peer.Settle();
        await peer.Deliver(ResultOpeningOf(1, (payload, 32)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        await peer.Advance(TimeSpan.FromSeconds(1.5));

        // a copy is no progress
        await peer.Deliver(ChunkOf(1, (payload, 32, 48)));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Keeps_the_inactivity_of_a_result_that_opens_before_the_last_chunk_of_its_request_goes()
    {
        // the TypeScript side's transport may hand the result over inside the last chunk's send; the
        // core here takes what comes after that send, so the result opens before the last credit
        var peer = new Peer(RouterSide.Client);
        var asked = peer.Request(PatternOf(300), TimeSpan.FromSeconds(1));

        await peer.Settle();
        await peer.Deliver(CreditOf(1, 172));
        await peer.Deliver(ResultOpeningOf(1, (PatternOf(300), 32)));
        await peer.Deliver(CreditOf(1, 300));
        Assert.True(ChunksOf(peer.Sent)[^1].IsLast);

        // the result's inactivity governs, not the request's timeout
        await peer.Advance(TimeSpan.FromSeconds(1.5));
        Assert.False(asked.IsCompleted);
        await peer.Advance(TimeSpan.FromSeconds(0.5));
        await Assert.ThrowsAsync<TimeoutException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
    }

    [Fact]
    public async Task Sends_a_result_as_a_transfer_its_call_held_open_until_its_last_chunk_is_handed_off()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();
        var payload = PatternOf(100);

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

        var answered = resolver.Answer(0, payload);

        await server.Settle();
        Assert.Equal(new ResultHeader { CallId = 1, Total = 100 }, server.Sent[^1].Header);
        Assert.Equal(payload[..28], server.Sent[^1].Payload.ToArray());

        // its call is open still: the same call id is refused
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 2 } });
        Assert.Equal((ushort)ProtocolCode.EnvelopeMalformed, Assert.IsType<FailureException>(Assert.Single(server.Reports)).Code);
        await server.Deliver(CreditOf(1, 76));
        Assert.Equal([(28L, false)], ChunksOf(server.Sent));
        Assert.False(answered.IsCompleted);
        await server.Deliver(CreditOf(1, 100));
        await answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
        Assert.Equal([(28L, false), (76L, true)], ChunksOf(server.Sent));

        // answered: a request on its call id is dispatched
        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 3 } });
        Assert.Equal(2, resolver.Requests.Count);
    }

    [Fact]
    public async Task Stops_a_result_the_peer_cancels_and_sends_nothing_more_of_it_whatever_credit_comes()
    {
        var server = new Peer(RouterSide.Server);
        var resolver = server.Resolve();

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });

        var answered = resolver.Answer(0, PatternOf(100));

        await server.Settle();
        await server.Deliver(new Envelope { Header = new CancelHeader { CallId = 1 } });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return answered.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        await server.Deliver(CreditOf(1, 100));
        Assert.Empty(ChunksOf(server.Sent));
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
            return resolver.Answer(0, PatternOf(100)).WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal((ushort)ProtocolCode.PayloadTooLarge, subscribing.Code);
        await Assert.ThrowsAsync<ArgumentException>(() =>
        {
            return server.Core.Respond(RouterAnswer.OfPayload(PatternOf(100)), new AnswerTarget(Handle, RequestOf(3)))
                .WaitAsync(Patience, TestContext.Current.CancellationToken);
        });
        Assert.Equal(0, server.BeforeAnswers);
        Assert.Empty(server.Sent);
    }

    [Fact]
    public async Task Announces_a_session_on_a_result_s_opening_which_leaves_room_for_it_within_its_envelope()
    {
        var server = new Peer(RouterSide.Server) { Session = SessionToken.FromBytes(PatternOf(16)) };
        var resolver = server.Resolve();
        var payload = PatternOf(100);

        await server.Deliver(new Envelope { Header = RequestOf(1), Payload = new byte[] { 1 } });
        _ = resolver.Answer(0, payload);
        await server.Settle();

        var opening = server.Sent[^1];

        Assert.Equal(new ResultHeader { CallId = 1, Total = 100, Credential = server.Session }, opening.Header);
        Assert.Equal(64, EnvelopeCodec.WriteEnvelope(opening).Length);
    }

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
        // an offset of 2⁵³, past what a 64-bit field holds
        const string Unreadable = "A1 14 40 04  00 00 00 01  00 20 00 00 00 00 00 00 | 01";

        var client = new Peer(RouterSide.Client);
        var asked = client.Request(new byte[] { 1 }, TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(ResultOpeningOf(1, (PatternOf(300), 32)));
        await client.Deliver(Unreadable);

        var invalid = await Assert.ThrowsAsync<FailureException>(() =>
        {
            return asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        });

        Assert.Equal(((ushort)ProtocolCode.ChunkInvalid, FailureOrigin.Local), (invalid.Code, invalid.Origin));
        Assert.IsType<CancelHeader>(client.Sent[^1].Header);

        // late, on its call id reserved; on a call id of its own it never opened, reported
        await client.Deliver(Unreadable);
        Assert.Empty(client.Reports);
        await client.Deliver("A1 14 40 04  00 00 00 05  00 20 00 00 00 00 00 00 | 01");
        Assert.Single(client.Reports);

        // on a call whose payload came whole: reported; on one abandoned: dropped; on none: reported
        var server = new Peer(RouterSide.Server);
        var payload = PatternOf(100);

        server.Resolve();
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
    public async Task Ends_nothing_more_by_a_chunk_whose_send_failed_behind_its_answer()
    {
        var client = new Peer(RouterSide.Client);
        var held = new TaskCompletionSource();

        client.OnSend = (envelope) =>
        {
            return envelope.Header is ChunkHeader ? held.Task : Task.CompletedTask;
        };

        var asked = client.Request(PatternOf(300), TimeSpan.FromSeconds(5));

        await client.Settle();
        await client.Deliver(CreditOf(1, 100));
        await client.Deliver(ResultOf(1));
        await asked.WaitAsync(Patience, TestContext.Current.CancellationToken);
        held.SetException(new IOException("the transport lost the chunk"));
        await client.Settle();
        Assert.DoesNotContain(client.Sent, (envelope) =>
        {
            return envelope.Header is CancelHeader;
        });
        Assert.Empty(client.Reports);
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

    // a resolver of one procedure, the interop service's echo, that keeps each request it is given for
    // the test to answer; what it admits, and what handling a request does, are the test's to say
    private sealed class Held(RouterCore core) : IRequestResolver
    {
        public Procedure Procedure { get; init; } = Echo;

        public int? MaximumPayloadBytes { get; init; }

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

        public List<Exception> Reports { get; } = [];

        public List<RouterActivity> Activities { get; } = [];

        public int BeforeAnswers { get; private set; }

        // what an answer that did not go out undid
        public int Undone { get; private set; }

        public List<(DebugDirection Direction, TracedEnvelope Envelope)> Traces { get; } = [];

        // the call ids the side holds otherwise: a subscription's
        public HashSet<uint> InUse { get; } = [];

        public bool IsTwoWayConnection { get; set; } = true;

        public int TwoWayAsked { get; private set; }

        // what the transport does as it is handed an envelope, before its send settles
        public Func<Envelope, Task>? OnSend { get; set; }

        public SessionToken? Session { get; set; }

        // the session of a connection, when the test says it otherwise
        public Func<string, SessionToken?>? SessionOf { get; set; }

        // whether the side takes a failure no call waits on
        public Func<Envelope, bool>? Unpaired { get; set; }

        public void Activity(RouterActivity activity, string connectionHandle)
        {
            Activities.Add(activity);
        }

        public Action? BeforeAnswer(AnswerInfo answer)
        {
            BeforeAnswers += 1;

            return () =>
            {
                Undone += 1;
            };
        }

        public bool IsCallIdInUse(uint callId, string connectionHandle)
        {
            return InUse.Contains(callId);
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
            return SessionOf is null ? Session : SessionOf(connectionHandle);
        }

        public void Trace(DebugDirection direction, TracedEnvelope envelope)
        {
            Traces.Add((direction, envelope));
        }

        public void Report(Exception reason, string connectionHandle)
        {
            Reports.Add(reason);
        }

        public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
        {
            var envelope = EnvelopeCodec.ReadEnvelope(
                bytes.Span,
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

            public void Report(Exception reason, string connectionHandle)
            {
                link.Reports.Add(reason);
            }

            public Task Send(ReadOnlyMemory<byte> bytes, string connectionHandle)
            {
                link.Queue(side, bytes);

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
