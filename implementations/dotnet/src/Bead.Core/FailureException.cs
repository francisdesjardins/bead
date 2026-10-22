using System.Text;

namespace Bead;

/// <summary>
/// A failure, thrown: whose code it is, the code, why, and — deduced, never sent — which side raised
/// it and where. Raised here, it is <see cref="FailureOrigin.Local"/>, of this router's side;
/// received through no relay, it is the peer's; received through a relay, whose side raised it is
/// not known.
/// </summary>
public sealed class FailureException : Exception
{
    private readonly IEnvelopeHeader? _header;

    /// <summary>A failure raised or received, with the side that raised it and where.</summary>
    public FailureException(Failure failure, FailureException.Raised raised)
    {
        ArgumentNullException.ThrowIfNull(failure);
        Failure = failure;
        Origin = raised.Origin;
        Side = raised.Side;
    }

    /// <summary>
    /// A failure raised here, with the side that raised it and what caused it — a payload's decoder
    /// that threw, say — as its <see cref="Exception.InnerException"/>, the TypeScript side's cause.
    /// </summary>
    public FailureException(Failure failure, (FailureException.Raised Raised, Exception Cause) raising)
        : base(null, raising.Cause)
    {
        ArgumentNullException.ThrowIfNull(failure);
        Failure = failure;
        Origin = raising.Raised.Origin;
        Side = raising.Raised.Side;
    }

    /// <summary>The failure, as it is sent.</summary>
    public Failure Failure { get; }

    /// <summary>The code, from 1 to 65535.</summary>
    public ushort Code
    {
        get
        {
            return Failure.Code;
        }
    }

    /// <summary>Why, readable: empty when it says nothing.</summary>
    public string Detail
    {
        get
        {
            return Failure.Detail;
        }
    }

    /// <summary>The relays it crossed: 0 when the peer raised it.</summary>
    public byte Relays
    {
        get
        {
            return Failure.Relays;
        }
    }

    /// <summary>Where it was raised.</summary>
    public FailureOrigin Origin { get; }

    /// <summary>Whose code it is.</summary>
    public FailureScope Scope
    {
        get
        {
            return Failure.Scope;
        }
    }

    /// <summary>The side that raised it; none through a relay.</summary>
    public RouterSide? Side { get; }

    /// <summary>
    /// The envelope that said it, kept redacted: its credential's scheme alone in place of its
    /// credential, whatever header it is given; none for a failure raised before any.
    /// </summary>
    public IEnvelopeHeader? Header
    {
        get
        {
            return _header;
        }

        init
        {
            _header = value is null ? null : RouterCore.Redact(value);
        }
    }

    /// <summary>The procedure the call asked for, which a failure envelope does not repeat.</summary>
    public ProcedureAddress? ProcedureAddress { get; init; }

    /// <summary>What the call went to behind the peer, as the call named it.</summary>
    public uint? DestinationId { get; init; }

    /// <summary>
    /// Whether it came by a way that keeps no order with the call's own answer, which it may
    /// overtake: over HTTP, a listen's batch (spec 15.9). Such a failure ends a subscription its
    /// server had answered, and withdraws no credential (spec 13.4).
    /// </summary>
    public bool MayOvertake { get; init; }

    /// <inheritdoc/>
    public override string Message
    {
        get
        {
            return MessageOf(this);
        }
    }

    /// <summary>Whether this is the procedure's own failure, whatever its code.</summary>
    public bool IsApplication()
    {
        return Scope == FailureScope.Application;
    }

    /// <summary>Whether this is the procedure's own failure <paramref name="code"/>, never a protocol code of the same number.</summary>
    public bool IsApplication(ushort code)
    {
        return Scope == FailureScope.Application && Code == code;
    }

    /// <summary>Whether this is the procedure's own failure, one of <paramref name="codes"/>.</summary>
    public bool IsApplication(IReadOnlyCollection<ushort> codes)
    {
        ArgumentNullException.ThrowIfNull(codes);

        return Scope == FailureScope.Application && codes.Contains(Code);
    }

    /// <summary>
    /// Whether this is the protocol's <paramref name="code"/> — raised by the peer, here, or behind a
    /// relay — and by <paramref name="side"/>, when given. A failure through a relay has no side
    /// known, so it never passes with one: its scope, which travels, is what tells the protocol's
    /// codes from a procedure's.
    /// </summary>
    public bool IsProtocol(ProtocolCode code, RouterSide? side = null)
    {
        return Scope == FailureScope.Protocol && Code == (ushort)code && (side is null || side == Side);
    }

    /// <summary>As <see cref="IsProtocol(ProtocolCode, RouterSide?)"/>, for one of <paramref name="codes"/>.</summary>
    public bool IsProtocol(IReadOnlyCollection<ProtocolCode> codes, RouterSide? side = null)
    {
        ArgumentNullException.ThrowIfNull(codes);

        return Scope == FailureScope.Protocol && codes.Contains((ProtocolCode)Code) && (side is null || side == Side);
    }

    /// <summary>
    /// One of the protocol's failures, as a router of <paramref name="side"/> raises it here.
    /// </summary>
    public static FailureException OfProtocol(ProtocolCode code, RouterSide side, string detail = "")
    {
        return new FailureException(
            new Failure { Code = (ushort)code, Detail = detail, Scope = FailureScope.Protocol },
            new Raised(FailureOrigin.Local, side));
    }

    /// <summary>
    /// A failure a router of <paramref name="side"/> received: the peer's when it crossed no relay,
    /// of no side known when it did.
    /// </summary>
    public static FailureException OfReceived(Failure failure, RouterSide side)
    {
        return new FailureException(failure, RaisedOf(failure, side));
    }

    /// <summary>
    /// Where a failure a router of <paramref name="side"/> received was raised: by the peer when it
    /// crossed no relay, by no side known when it did.
    /// </summary>
    public static Raised RaisedOf(Failure failure, RouterSide side)
    {
        ArgumentNullException.ThrowIfNull(failure);

        return failure.Relays > 0
            ? new Raised(FailureOrigin.Relayed, null)
            : new Raised(FailureOrigin.Peer, CallIds.PeerOf(side));
    }

    // what a failure says of itself, as its exception's message
    private static string MessageOf(FailureException exception)
    {
        var failure = exception.Failure;
        var isProtocol = failure.Scope == FailureScope.Protocol;
        var name = isProtocol && Enum.IsDefined((ProtocolCode)failure.Code)
            ? $" {ConstantOf((ProtocolCode)failure.Code)}"
            : "";
        var side = exception.Side switch
        {
            RouterSide.Client => "client",
            RouterSide.Server => "server",
            _ => "unknown side",
        };
        var address = isProtocol || exception.ProcedureAddress is not { } procedure
            ? ""
            : $" (service {procedure.ServiceId}, procedure {procedure.ProcedureId})";
        var relays = failure.Relays switch
        {
            0 => "",
            1 => ", through 1 relay",
            _ => $", through {failure.Relays} relays",
        };

        return string.Concat(
            exception.Origin == FailureOrigin.Local ? "local " : "",
            $"{side} {(isProtocol ? "protocol" : "application")} failure {failure.Code}",
            name,
            address,
            relays,
            failure.Detail.Length == 0 ? "" : $": {failure.Detail}");
    }

    // a code's name as the spec writes it, ENVELOPE_MALFORMED for EnvelopeMalformed
    private static string ConstantOf(ProtocolCode code)
    {
        var text = code.ToString();
        var builder = new StringBuilder(text.Length + 4);

        foreach (var character in text)
        {
            if (char.IsUpper(character) && builder.Length > 0)
            {
                builder.Append('_');
            }

            builder.Append(char.ToUpperInvariant(character));
        }

        return builder.ToString();
    }

    /// <summary>Where a failure was raised, and by which side: none through a relay.</summary>
    /// <param name="Origin">Where it was raised.</param>
    /// <param name="Side">The side that raised it.</param>
    public readonly record struct Raised(FailureOrigin Origin, RouterSide? Side);
}
