using System.Diagnostics.CodeAnalysis;

namespace Bead;

/// <summary>
/// How an envelope's header is laid out, in its first byte. Only <see cref="First"/> is read; 0xA2
/// to 0xAF are the layouts to come, which a request is refused with
/// <see cref="ProtocolCode.LayoutUnsupported"/>; any other first byte is not an envelope.
/// </summary>
public enum EnvelopeLayout : byte
{
    /// <summary>The layout this implementation reads and writes.</summary>
    First = 0xA1,
}

/// <summary>
/// What an envelope is, in its second byte. A chunk carries the next bytes of a payload a request or
/// a result opened as a transfer, at its offset; a credit lets the other end send a transfer's bytes
/// up to its end, or a subscription's notifications up to its count, and carries nothing else. A
/// cancel is a requester ending its call, 8 bytes and never answered.
/// </summary>
public enum EnvelopeKind : byte
{
    /// <summary>A call to a procedure.</summary>
    Request = 0x10,

    /// <summary>The answer of a call that succeeded.</summary>
    Result = 0x11,

    /// <summary>The answer of a call that failed, its record as its payload.</summary>
    Failure = 0x12,

    /// <summary>What a subscription pushes, on the call id of the request that opened it.</summary>
    Notification = 0x13,

    /// <summary>The next bytes of a transfer, at their offset.</summary>
    Chunk = 0x14,

    /// <summary>The end below which the other end may send.</summary>
    Credit = 0x15,

    /// <summary>A requester ending its call.</summary>
    Cancel = 0x16,
}

/// <summary>
/// The flags of an envelope, in its third byte. The low nibble adds blocks, in the order of their
/// bits, <see cref="Credential"/> last, and 0x01 is kept for a block to come; the high nibble adds
/// none, and 0x80 is kept.
/// </summary>
[Flags]
[SuppressMessage(
    "Naming",
    "CA1711:Identifiers should not have incorrect suffix",
    Justification = "byte 2 is the flags, as the spec names it: one word, one meaning (0003)")]
public enum EnvelopeFlags : byte
{
    /// <summary>No flag.</summary>
    None = 0,

    /// <summary>A 4-byte block: what a request is for behind the peer that takes it.</summary>
    Destination = 0x02,

    /// <summary>An 8-byte block: the total of a payload sent in parts.</summary>
    Transfer = 0x04,

    /// <summary>
    /// The last block, the one whose length varies: the credential a request presents, or the
    /// session an answer announces — its scheme on 2 bytes, its length on 2, its bytes, then zero
    /// bytes to the next 4-byte word.
    /// </summary>
    Credential = 0x08,

    /// <summary>The request opens a subscription.</summary>
    Subscription = 0x10,

    /// <summary>
    /// The subscription goes at its client's pace; on a credit, the credit counts notifications.
    /// </summary>
    Paced = 0x20,

    /// <summary>More chunks follow this one.</summary>
    More = 0x40,
}

/// <summary>
/// The format of a credential, the first 2 bytes of a header's CREDENTIAL block, as HTTP's
/// authentication scheme names one (RFC 9110 §11.1): a side never reads the bytes to learn what they
/// are. The schemes from 4 to 65535 are the ones to come, which a value cast from their number
/// holds.
/// </summary>
public enum CredentialScheme : ushort
{
    /// <summary>No credential: on an answer, that its connection's session ended. No byte.</summary>
    None = 0,

    /// <summary>The token of a connection's session: 16 bytes, never all zero.</summary>
    Opaque = 1,

    /// <summary>A token in JWS Compact Serialization (RFC 7515), a byte a character.</summary>
    Jwt = 2,

    /// <summary>The credential its transport carried beside the envelope. No byte.</summary>
    Elsewhere = 3,
}

/// <summary>Whose code a failure's is: the protocol's, or the procedure's own.</summary>
public enum FailureScope : byte
{
    /// <summary>One of <see cref="ProtocolCode"/>.</summary>
    Protocol = 0,

    /// <summary>The procedure's own code, from 1 to 65535.</summary>
    Application = 1,
}

/// <summary>
/// The protocol's own failures, in blocks of 16 by how far a request went: the envelope (1 to 15),
/// its route (16 to 31), its admission (32 to 47), its payload (48 to 63), then its procedure (64 to
/// 79). A code read that none of these names stays a number.
/// </summary>
public enum ProtocolCode : ushort
{
    /// <summary>The bytes are not an envelope this layout reads.</summary>
    EnvelopeMalformed = 1,

    /// <summary>The layout is one to come.</summary>
    LayoutUnsupported = 2,

    /// <summary>The kind is one to come, or one this side does not take.</summary>
    KindUnsupported = 3,

    /// <summary>The envelope is larger than this peer reads.</summary>
    EnvelopeTooLarge = 4,

    /// <summary>The request names a destination its relay has none of.</summary>
    DestinationUnknown = 16,

    /// <summary>The relay could not hand the request to its destination: nothing was tried.</summary>
    DestinationUnreachable = 17,

    /// <summary>No resolver is registered for the service.</summary>
    ServiceUnknown = 18,

    /// <summary>The service is known, the procedure is not.</summary>
    ProcedureUnknown = 19,

    /// <summary>An answer or a chunk belongs to no call.</summary>
    CallUnknown = 20,

    /// <summary>A notification comes under no subscription.</summary>
    SubscriptionUnknown = 21,

    /// <summary>The request opens a subscription on a path that carries no notification back.</summary>
    SubscriptionUnsupported = 22,

    /// <summary>The procedure needs a session the connection has not.</summary>
    SessionRequired = 32,

    /// <summary>The request was refused, on its header.</summary>
    AccessDenied = 33,

    /// <summary>A payload or an envelope going out passes its limit.</summary>
    PayloadTooLarge = 34,

    /// <summary>A side holds all it can: call ids, transfers, or a subscription's queue.</summary>
    CapacityExceeded = 35,

    /// <summary>
    /// The request presents a credential of a scheme the receiver takes none of: one to come, or
    /// one it has no verifier for. Its detail names the schemes the receiver takes.
    /// </summary>
    CredentialUnsupported = 36,

    /// <summary>A chunk does not fit its transfer.</summary>
    ChunkInvalid = 48,

    /// <summary>A chunk runs past the credit granted.</summary>
    CreditExceeded = 49,

    /// <summary>The procedure's serializer cannot read the payload.</summary>
    PayloadUndecodable = 50,

    /// <summary>Nothing came for a transfer through its inactivity timeout.</summary>
    TransferStalled = 51,

    /// <summary>The resolver failed before it answered.</summary>
    ProcedureFailed = 64,

    /// <summary>The relay handed the request on, then lost its destination.</summary>
    DestinationLost = 65,
}

/// <summary>Which end of a connection a router is.</summary>
public enum RouterSide
{
    /// <summary>The end that connected; it draws odd call ids.</summary>
    Client,

    /// <summary>The end that accepted; it draws even call ids.</summary>
    Server,
}

/// <summary>
/// Where a failure was raised: here, never sent; by the peer; or beyond a relay, which only passed
/// it on.
/// </summary>
public enum FailureOrigin
{
    /// <summary>Raised here.</summary>
    Local,

    /// <summary>Raised by the peer, received with no relay.</summary>
    Peer,

    /// <summary>Raised beyond a relay, whose side is not known.</summary>
    Relayed,
}

/// <summary>How much a router reads, writes and holds, when its options say nothing.</summary>
public static class LimitDefaults
{
    /// <summary>A failure's detail, in bytes, cut at a character's boundary.</summary>
    public const int MaximumDetailBytes = 1_024;

    /// <summary>A whole envelope, its header included, in bytes.</summary>
    public const int MaximumEnvelopeBytes = 16_778_240;

    /// <summary>A whole payload, in bytes, sent in one envelope or as a transfer.</summary>
    public const int MaximumPayloadBytes = 16_777_216;

    /// <summary>A chunk's envelope, its header included, in bytes.</summary>
    public const int ChunkBytes = 1_048_576;

    /// <summary>The calls a connection's peer has a side answer at once.</summary>
    public const int MaximumAnsweringCalls = 64;
}
