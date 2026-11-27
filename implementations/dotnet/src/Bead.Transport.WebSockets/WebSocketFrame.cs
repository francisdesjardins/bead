using System.Net.WebSockets;

namespace Bead.Transport.WebSockets;

/// <summary>
/// The numbers of a WebSocket frame's head that the meter reads (RFC 6455 §5.2, §5.5), each under
/// the standard's name, and the one close code .NET's <see cref="WebSocketCloseStatus"/> has no
/// member for (decision 0057).
/// </summary>
internal static class WebSocketFrame
{
    /// <summary>RFC 6455 §5.2: the opcode of a continuation frame.</summary>
    public const int Continuation = 0x0;

    /// <summary>RFC 6455 §5.2: the opcode of a text frame.</summary>
    public const int Text = 0x1;

    /// <summary>RFC 6455 §5.2: the opcode of a binary frame.</summary>
    public const int Binary = 0x2;

    /// <summary>RFC 6455 §5.2: the opcode of a close frame, the first of the control frames.</summary>
    public const int Close = 0x8;

    /// <summary>RFC 6455 §5.2: the opcode of a ping.</summary>
    public const int Ping = 0x9;

    /// <summary>RFC 6455 §5.2: the opcode of a pong, the last opcode defined.</summary>
    public const int Pong = 0xA;

    /// <summary>RFC 6455 §5.2: FIN, the top bit of a frame's first byte, set on a message's final frame.</summary>
    public const int FinBit = 0x80;

    /// <summary>RFC 6455 §5.2: RSV1, RSV2 and RSV3, the three bits of a frame's first byte after FIN.</summary>
    public const int ReservedMask = 0x70;

    /// <summary>RFC 6455 §5.2: the opcode, the low four bits of a frame's first byte.</summary>
    public const int OpcodeMask = 0x0F;

    /// <summary>RFC 6455 §5.5: the opcode's bit every control frame sets, its most significant.</summary>
    public const int ControlBit = 0x08;

    /// <summary>RFC 6455 §5.2: Mask, the top bit of a frame's second byte, set on a masked payload.</summary>
    public const int MaskBit = 0x80;

    /// <summary>RFC 6455 §5.2: Payload length, the low seven bits of a frame's second byte.</summary>
    public const int PayloadLengthMask = 0x7F;

    /// <summary>RFC 6455 §5.2: the Payload length that a 16-bit length follows.</summary>
    public const int ExtendedLength16 = 126;

    /// <summary>RFC 6455 §5.2: the Payload length that a 64-bit length follows.</summary>
    public const int ExtendedLength64 = 127;

    /// <summary>RFC 6455 §5.2: the top bit of a 64-bit length's first byte, which is 0.</summary>
    public const int LengthTopBit = 0x80;

    /// <summary>RFC 6455 §5.5: the longest payload of a control frame, in bytes.</summary>
    public const int LongestControlPayload = 125;

    /// <summary>RFC 6455 §5.2: the bytes of a masking key.</summary>
    public const int MaskingKeyBytes = 4;

    /// <summary>RFC 6455 §5.2: the longest head, in bytes: 2, a 64-bit length's 8, and a masking key's 4.</summary>
    public const int LongestHeadBytes = 14;

    /// <summary>1013, Try Again Later in IANA's WebSocket Close Code Number Registry, which .NET has no name for.</summary>
    public const WebSocketCloseStatus TryAgainLater = (WebSocketCloseStatus)1013;
}
