namespace Bead;

internal sealed partial class RouterCore
{
    // how a payload fits in one envelope, or opens a transfer under the held limits
    internal sealed class PayloadPlacement
    {
        // a chunk's header: its prefix, then its offset
        private static readonly int ChunkHeaderBytes = EnvelopeCodec.HeaderBytesOf(new ChunkHeader { CallId = 1, IsLast = true, Offset = 0 });

        private readonly RouterLimits _limits;

        internal PayloadPlacement(RouterLimits limits)
        {
            _limits = limits;

            // the largest envelope a payload goes whole in, and the bytes a chunk carries
            WholeBytes = Math.Min(limits.ChunkBytes, limits.MaximumEnvelopeBytes);
            PayloadBytesPerChunk = Transfer.ChunkPayloadBytes(limits, ChunkHeaderBytes);
        }

        // the largest envelope a payload goes whole in
        internal int WholeBytes { get; }

        // the bytes of a payload a chunk carries
        internal int PayloadBytesPerChunk { get; }

        // a chunk's envelope, on its call id
        internal static Envelope ChunkEnvelopeOf(uint callId, Chunk chunk)
        {
            return new Envelope
            {
                Header = new ChunkHeader { CallId = callId, IsLast = chunk.IsLast, Offset = chunk.Offset },
                Payload = chunk.Bytes,
            };
        }

        // the failure of a payload of `length` bytes, past `limit`
        internal static Failure TooLargeOf(long length, int limit)
        {
            return ProtocolFailureOf(ProtocolCode.PayloadTooLarge, $"a payload is {limit} bytes at most, not {length}");
        }

        // * the bytes of its payload an opening of `header` carries, as its sender places them: the
        // largest envelope a payload goes whole in, less its header, and a result's less the 20 bytes
        // of an announcement too, its header counted without the one it may carry, since its sender
        // places it before any rides on it; the sender's placement and the receiver's check both ask
        // here, so the two cannot drift (spec 12.3)
        internal int OpeningBytesOf(IEnvelopeHeader header)
        {
            if (header is ResultHeader result)
            {
                return WholeBytes - EnvelopeCodec.UnboundedHeaderBytesOf(result with { Credential = null }) - Credential.AnnouncementBytes;
            }

            return WholeBytes - EnvelopeCodec.UnboundedHeaderBytesOf(header);
        }

        // the bytes a payload of `handler` holds at most: its own limit, within the router's
        internal int PayloadLimitOf(int? maximumPayloadBytes)
        {
            return Math.Min(maximumPayloadBytes ?? int.MaxValue, _limits.MaximumPayloadBytes);
        }

        // how a payload goes after its header: whole — none — or as a transfer, a result's header counted
        // with the announcement it may carry; or not at all, and the failure says why
        internal (OutgoingTransfer? Transfer, Failure? Refusal) TransferOf(
            ReadOnlyMemory<byte> payload,
            (IEnvelopeHeader Header, int MaximumPayloadBytes) going)
        {
            var (header, maximumPayloadBytes) = going;
            var announcementBytes = header is ResultHeader ? Credential.AnnouncementBytes : 0;

            if (payload.Length > maximumPayloadBytes)
            {
                return (null, TooLargeOf(payload.Length, maximumPayloadBytes));
            }

            if (EnvelopeCodec.HeaderBytesOf(header) + announcementBytes + payload.Length <= WholeBytes)
            {
                return (null, null);
            }

            if (_limits.MaximumTransfers == 0)
            {
                return (null, ProtocolFailureOf(
                    ProtocolCode.PayloadTooLarge,
                    $"a payload of {FailureException.ByteCountOf(payload.Length)} goes as a transfer, which this side sends none of"));
            }

            // only a request and a result open a transfer
            IEnvelopeHeader opening = header is RequestHeader request
                ? request with { Total = payload.Length }
                : (ResultHeader)header with { Total = payload.Length };
            var openingHeaderBytes = EnvelopeCodec.UnboundedHeaderBytesOf(opening);
            var openingBytes = OpeningBytesOf(opening);

            // ! a header past 1,020 bytes no reader takes, and an opening without a byte of its payload
            // none places: a payload that needs such a transfer goes whole or not at all (spec 12.3)
            if (openingHeaderBytes > EnvelopeCodec.MaximumHeaderBytes)
            {
                return (null, ProtocolFailureOf(
                    ProtocolCode.PayloadTooLarge,
                    $"a payload of {FailureException.ByteCountOf(payload.Length)} goes as a transfer, whose opening's header of {openingHeaderBytes} bytes passes {EnvelopeCodec.MaximumHeaderBytes}"));
            }

            if (openingBytes < 1)
            {
                return (null, ProtocolFailureOf(
                    ProtocolCode.PayloadTooLarge,
                    $"a payload of {FailureException.ByteCountOf(payload.Length)} goes as a transfer, whose opening's header of {openingHeaderBytes} bytes leaves it no byte within {WholeBytes}"));
            }

            return (new OutgoingTransfer(payload, (openingBytes, PayloadBytesPerChunk)), null);
        }
    }
}
