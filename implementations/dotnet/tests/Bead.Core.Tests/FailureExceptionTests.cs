namespace Bead.Tests;

/// <summary><see cref="FailureException"/>: what it says of itself, as the TypeScript FailureError does.</summary>
public sealed class FailureExceptionTests
{
    [Fact]
    public void Says_a_local_protocol_failure_by_its_side_its_code_and_its_name()
    {
        Assert.Equal(
            "local server protocol failure 33 ACCESS_DENIED",
            FailureException.OfProtocol(ProtocolCode.AccessDenied, RouterSide.Server).Message);
        Assert.Equal(
            "local client protocol failure 1 ENVELOPE_MALFORMED: a call id is never 0",
            FailureException.OfProtocol(ProtocolCode.EnvelopeMalformed, RouterSide.Client, "a call id is never 0").Message);
    }

    [Fact]
    public void Says_a_failure_relayed_has_no_side_it_knows()
    {
        var failure = new Failure { Code = 18, Relays = 1, Scope = FailureScope.Protocol };

        Assert.Equal(
            "unknown side protocol failure 18 SERVICE_UNKNOWN, through 1 relay",
            new FailureException(failure, new FailureException.Raised(FailureOrigin.Relayed, null)).Message);
        Assert.Equal(
            "unknown side protocol failure 18 SERVICE_UNKNOWN, through 2 relays: gone",
            new FailureException(
                failure with { Relays = 2, Detail = "gone" },
                new FailureException.Raised(FailureOrigin.Relayed, null)).Message);
    }

    [Fact]
    public void Is_the_peer_s_of_the_other_side_through_no_relay_when_received()
    {
        var failure = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.AccessDenied), RouterSide.Client);

        Assert.Equal((FailureOrigin.Peer, (RouterSide?)RouterSide.Server, (byte)0), (failure.Origin, failure.Side, failure.Relays));
    }

    [Fact]
    public void Is_of_no_known_side_when_received_through_a_relay()
    {
        var failure = FailureException.OfReceived(Failure.OfApplication(7) with { Relays = 1 }, RouterSide.Client);

        Assert.Equal((FailureOrigin.Relayed, (RouterSide?)null, (byte)1), (failure.Origin, failure.Side, failure.Relays));
    }

    [Fact]
    public void Names_no_protocol_code_for_an_application_failure()
    {
        var failure = new Failure { Code = 19, Detail = "out of range", Scope = FailureScope.Application };
        var exception = new FailureException(failure, new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server));

        Assert.Equal("server application failure 19: out of range", exception.Message);
        Assert.Equal((ushort)19, exception.Code);
        Assert.Equal(FailureScope.Application, exception.Scope);
        Assert.Equal(FailureOrigin.Peer, exception.Origin);
    }

    [Fact]
    public void Keeps_a_protocol_code_no_name_has_as_a_number()
    {
        var failure = new Failure { Code = 77, Scope = FailureScope.Protocol };

        Assert.Equal(
            "client protocol failure 77",
            new FailureException(failure, new FailureException.Raised(FailureOrigin.Peer, RouterSide.Client)).Message);
    }

    [Fact]
    public void IsProtocol_matches_the_protocol_codes_and_the_side_when_given_through_a_relay_the_code_alone()
    {
        var error = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.ServiceUnknown), RouterSide.Client);

        Assert.True(error.IsProtocol(ProtocolCode.ServiceUnknown));
        Assert.True(error.IsProtocol([ProtocolCode.ProcedureUnknown, ProtocolCode.ServiceUnknown]));
        Assert.False(error.IsProtocol(ProtocolCode.ProcedureUnknown));
        Assert.True(error.IsProtocol(ProtocolCode.ServiceUnknown, RouterSide.Server));
        Assert.False(error.IsProtocol(ProtocolCode.ServiceUnknown, RouterSide.Client));
        Assert.False(error.IsApplication());

        var relayed = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.ServiceUnknown) with { Relays = 1 }, RouterSide.Client);

        // its scope travelled with it; who raised it did not
        Assert.True(relayed.IsProtocol(ProtocolCode.ServiceUnknown));
        Assert.False(relayed.IsProtocol(ProtocolCode.ProcedureUnknown));
        Assert.False(relayed.IsProtocol(ProtocolCode.ServiceUnknown, RouterSide.Server));
        Assert.False(relayed.IsProtocol(ProtocolCode.ServiceUnknown, RouterSide.Client));
    }

    [Fact]
    public void IsApplication_matches_the_procedure_s_own_codes_never_a_protocol_code_of_the_same_number()
    {
        var error = FailureException.OfReceived(Failure.OfApplication(21), RouterSide.Client);

        Assert.True(error.IsApplication());
        Assert.True(error.IsApplication(21));
        Assert.True(error.IsApplication([7, 21]));
        Assert.False(error.IsApplication(7));
        Assert.False(error.IsProtocol(ProtocolCode.SubscriptionUnknown));

        var protocol = FailureException.OfProtocol(ProtocolCode.SubscriptionUnknown, RouterSide.Server);

        Assert.False(protocol.IsApplication());
        Assert.False(protocol.IsApplication(21));
    }
}
