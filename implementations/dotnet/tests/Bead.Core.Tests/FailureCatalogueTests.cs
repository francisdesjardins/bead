namespace Bead.Tests;

/// <summary>
/// <see cref="FailureCatalogue"/> and the failures a resolver of the service layer answers: the twins
/// of the TypeScript side's <c>failures.test.ts</c>, but what a C# failure class holds by its type,
/// its names and their codes.
/// </summary>
public sealed class FailureCatalogueTests
{
    [Fact]
    public void Tells_a_failure_of_its_service_by_its_name_and_none_of_another_service()
    {
        // a failure that names no procedure tells no service
        var received = FailureException.OfReceived(Failure.OfApplication(1, "a name is needed"), RouterSide.Client);
        var greeter = new FailureException(Failure.OfApplication(1), new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server))
        {
            ProcedureAddress = new ProcedureAddress(7, 1),
        };
        var other = new FailureException(Failure.OfApplication(1), new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server))
        {
            ProcedureAddress = new ProcedureAddress(8, 1),
        };
        var protocol = new FailureException(Failure.OfProtocol(ProtocolCode.EnvelopeMalformed), new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server))
        {
            ProcedureAddress = new ProcedureAddress(7, 1),
        };

        Assert.True(GreeterProcedures.Failures.Is(greeter, SayHelloFailure.NobodyToGreet));
        Assert.False(GreeterProcedures.Failures.Is(other, SayHelloFailure.NobodyToGreet));
        Assert.False(GreeterProcedures.Failures.Is(protocol, SayHelloFailure.NobodyToGreet));
        Assert.False(GreeterProcedures.Failures.Is(received, SayHelloFailure.NobodyToGreet));
    }

    [Fact]
    public void Refuses_a_service_outside_1_to_65535()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
        {
            return new FailureCatalogue(0);
        });
        Assert.Equal((ushort)65535, new FailureCatalogue(65535).ServiceId);
    }

    [Fact]
    public void Makes_a_refusal_of_admission_ACCESS_DENIED_or_SESSION_REQUIRED_and_why()
    {
        Assert.Equal((ProtocolCode.AccessDenied, "too quiet"), (AdmissionFailure.AccessDenied("too quiet").Code, AdmissionFailure.AccessDenied("too quiet").Detail));
        Assert.Equal((ProtocolCode.SessionRequired, ""), (AdmissionFailure.SessionRequired().Code, AdmissionFailure.SessionRequired().Detail));
        Assert.Equal(Failure.OfProtocol(ProtocolCode.AccessDenied, "too quiet"), AdmissionFailure.AccessDenied("too quiet").Failure);
    }
}
