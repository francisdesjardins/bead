namespace Bead;

/// <summary>A procedure's own failure, of its service's catalogue: its code.</summary>
public interface IApplicationFailure
{
    /// <summary>Its code, from 1 to 65,535 (spec 9.5).</summary>
    ushort Code { get; }
}

/// <summary>
/// The failure of a procedure that lists none: it has no value, so a resolver of such a procedure
/// answers a result or a refusal of admission alone.
/// </summary>
public sealed class NoFailure : IApplicationFailure
{
    private NoFailure()
    {
    }

    /// <summary>Never read: no value of it exists, so a read is an <see cref="InvalidOperationException"/>.</summary>
    public ushort Code
    {
        get
        {
            throw new InvalidOperationException("a procedure that lists no failure has none to answer");
        }
    }
}

/// <summary>
/// A refusal of admission a resolver answers, beside the failures its procedure lists:
/// ACCESS_DENIED or SESSION_REQUIRED, and why. Its router answers SESSION_REQUIRED of a call that
/// presented a credential ACCESS_DENIED, its detail kept (spec 9.2, step 6).
/// </summary>
public sealed record AdmissionFailure
{
    private AdmissionFailure(ProtocolCode code, string detail)
    {
        Code = code;
        Detail = detail;
    }

    /// <summary>Its code, of the protocol's admission block.</summary>
    public ProtocolCode Code { get; }

    /// <summary>Why, readable: empty when it says nothing.</summary>
    public string Detail { get; }

    /// <summary>The failure it is answered with.</summary>
    internal Failure Failure
    {
        get
        {
            return Failure.OfProtocol(Code, Detail);
        }
    }

    /// <summary>ACCESS_DENIED, and why.</summary>
    public static AdmissionFailure AccessDenied(string detail = "")
    {
        ArgumentNullException.ThrowIfNull(detail);

        return new AdmissionFailure(ProtocolCode.AccessDenied, detail);
    }

    /// <summary>SESSION_REQUIRED, and why.</summary>
    public static AdmissionFailure SessionRequired(string detail = "")
    {
        ArgumentNullException.ThrowIfNull(detail);

        return new AdmissionFailure(ProtocolCode.SessionRequired, detail);
    }
}

/// <summary>
/// A service's catalogue of failures: whether a failure received is one of it. Each failure is a
/// value of its procedure's failure class, which holds its code; the catalogue tells it apart from
/// another service's failure of the same code.
/// </summary>
public sealed class FailureCatalogue
{
    /// <summary>The catalogue of the service <paramref name="serviceId"/>, from 1 to 65,535 (spec 16.2).</summary>
    public FailureCatalogue(ushort serviceId)
    {
        ArgumentOutOfRangeException.ThrowIfZero(serviceId);

        ServiceId = serviceId;
    }

    /// <summary>Its service.</summary>
    public ushort ServiceId { get; }

    /// <summary>
    /// Whether <paramref name="exception"/> is the application failure <paramref name="failure"/>,
    /// received from a procedure of this service.
    /// </summary>
    public bool Is(FailureException exception, IApplicationFailure failure)
    {
        ArgumentNullException.ThrowIfNull(exception);
        ArgumentNullException.ThrowIfNull(failure);

        return exception.IsApplication(failure.Code) && exception.ProcedureAddress?.ServiceId == ServiceId;
    }
}
