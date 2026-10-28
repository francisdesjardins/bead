namespace Bead.Tests;

/// <summary>
/// <see cref="FailureException"/>: what it says of itself, as the TypeScript FailureError does, and a
/// header redacted, as its <c>redactHeader</c> does; the twins of the TypeScript side's
/// <c>errors.test.ts</c>.
/// </summary>
public sealed class FailureExceptionTests
{
    [Fact]
    public void Matches_failure_code_sets_by_scope_code_and_the_known_side()
    {
        var protocol = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.SubscriptionUnknown), RouterSide.Client);
        var application = FailureException.OfReceived(Failure.OfApplication(21), RouterSide.Client);
        var relayed = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.SubscriptionUnknown) with { Relays = 1 }, RouterSide.Client);

        foreach (var error in new[] { protocol, application, relayed })
        {
            var isProtocol = error.Scope == FailureScope.Protocol;

            Assert.Equal(isProtocol, error.IsProtocol([ProtocolCode.SubscriptionUnknown]));
            Assert.Equal(isProtocol && error.Side == RouterSide.Server, error.IsProtocol([ProtocolCode.SubscriptionUnknown], RouterSide.Server));
            Assert.False(error.IsProtocol([ProtocolCode.SubscriptionUnknown], RouterSide.Client));
            Assert.False(error.IsProtocol([ProtocolCode.ServiceUnknown]));
            Assert.False(error.IsProtocol(Array.Empty<ProtocolCode>()));
            Assert.Equal(!isProtocol, error.IsApplication([(ushort)21]));
            Assert.False(error.IsApplication([(ushort)7]));
            Assert.False(error.IsApplication(Array.Empty<ushort>()));
        }
    }

    [Fact]
    public void Carries_no_header_when_none_is_supplied_explicitly()
    {
        var error = new FailureException(Failure.OfApplication(21), new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server)) { Header = null };

        Assert.Null(error.Header);
        Assert.Equal("server application failure 21", error.Message);
    }

    [Fact]
    public void Carries_the_failure_and_where_it_belongs_and_keeps_a_redacted_copy_of_the_header()
    {
        var token = SessionToken.FromBytes(Enumerable.Repeat((byte)7, 16).ToArray());
        var cause = new InvalidOperationException("underneath");
        var error = new FailureException(
            Failure.OfProtocol(ProtocolCode.ProcedureUnknown, "no procedure 1 in service 2"),
            (new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server), cause))
        {
            DestinationId = 5,
            Header = new FailureHeader { CallId = 3, Credential = Credential.Opaque(token) },
            ProcedureAddress = new ProcedureAddress(2, 1),
        };

        Assert.Equal(
            ((ushort)19, (uint?)5, "no procedure 1 in service 2", FailureOrigin.Peer, (ProcedureAddress?)new ProcedureAddress(2, 1), (byte)0, FailureScope.Protocol, (RouterSide?)RouterSide.Server),
            (error.Code, error.DestinationId, error.Detail, error.Origin, error.ProcedureAddress, error.Relays, error.Scope, error.Side));

        // * its credential's scheme alone, whatever header it was given
        Assert.Equal(new FailureHeader { CallId = 3, Credential = Credential.SchemeOf(CredentialScheme.Opaque) }, error.Header);
        Assert.Same(cause, error.InnerException);
    }

    [Fact]
    public void Is_local_through_no_relay_with_no_detail_and_nothing_it_belongs_to_when_not_told()
    {
        var error = FailureException.OfProtocol(ProtocolCode.PayloadTooLarge, RouterSide.Client);

        Assert.Equal(
            ((ushort)34, (uint?)null, "", (IEnvelopeHeader?)null, FailureOrigin.Local, (ProcedureAddress?)null, (byte)0, (RouterSide?)RouterSide.Client),
            (error.Code, error.DestinationId, error.Detail, error.Header, error.Origin, error.ProcedureAddress, error.Relays, error.Side));
        Assert.Equal("local client protocol failure 34 PAYLOAD_TOO_LARGE", error.Message);
    }

    [Fact]
    public void Says_a_local_protocol_failure_by_its_side_its_code_and_its_name()
    {
        // an empty detail says nothing
        Assert.Equal(
            "local server protocol failure 33 ACCESS_DENIED",
            FailureException.OfProtocol(ProtocolCode.AccessDenied, RouterSide.Server).Message);
        Assert.Equal(
            "local client protocol failure 1 ENVELOPE_MALFORMED: a call id is never 0",
            FailureException.OfProtocol(ProtocolCode.EnvelopeMalformed, RouterSide.Client, "a call id is never 0").Message);

        // raised by the peer, it is not local
        Assert.Equal(
            "server protocol failure 19 PROCEDURE_UNKNOWN: no procedure 1 in service 2",
            new FailureException(
                Failure.OfProtocol(ProtocolCode.ProcedureUnknown, "no procedure 1 in service 2"),
                new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server)).Message);
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
    public void Names_no_protocol_code_for_an_application_failure()
    {
        var failure = new Failure { Code = 21, Detail = "out of range", Scope = FailureScope.Application };
        var error = new FailureException(failure, new FailureException.Raised(FailureOrigin.Peer, RouterSide.Server))
        {
            ProcedureAddress = new ProcedureAddress(2, 1),
        };

        Assert.Equal("server application failure 21 (service 2, procedure 1): out of range", error.Message);
        Assert.Equal(((ushort)21, FailureOrigin.Peer, FailureScope.Application), (error.Code, error.Origin, error.Scope));
        Assert.Equal(
            "client application failure 21",
            new FailureException(Failure.OfApplication(21), new FailureException.Raised(FailureOrigin.Peer, RouterSide.Client)).Message);
    }

    // spec 8.1
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

    [Fact]
    public void Is_the_peer_s_of_the_other_side_through_no_relay_when_received()
    {
        var fromServer = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.ProcedureUnknown), RouterSide.Client);

        Assert.Equal((FailureOrigin.Peer, (RouterSide?)RouterSide.Server, (byte)0), (fromServer.Origin, fromServer.Side, fromServer.Relays));
        Assert.Equal(RouterSide.Client, FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.ProcedureUnknown), RouterSide.Server).Side);
    }

    [Fact]
    public void Is_of_no_known_side_when_received_through_a_relay()
    {
        var relayed = FailureException.OfReceived(Failure.OfProtocol(ProtocolCode.ServiceUnknown) with { Relays = 1 }, RouterSide.Client);

        Assert.Equal((FailureOrigin.Relayed, (RouterSide?)null, (byte)1), (relayed.Origin, relayed.Side, relayed.Relays));
    }

    [Fact]
    public void Leaves_the_credential_out_and_says_its_scheme_alone_when_there_was_one()
    {
        var token = SessionToken.FromBytes(Enumerable.Repeat((byte)9, 16).ToArray());
        var result = new ResultHeader { CallId = 2, Credential = Credential.Opaque(token) };
        var request = new RequestHeader { CallId = 1, ServiceId = 2, ProcedureId = 1 };

        Assert.Equal(result with { Credential = Credential.SchemeOf(CredentialScheme.Opaque) }, RouterCore.Redact(result));

        // an ended session is announced, and names none
        Assert.Equal(result with { Credential = Credential.None }, RouterCore.Redact(result with { Credential = Credential.None }));
        Assert.Equal(new NotificationHeader { CallId = 3 }, RouterCore.Redact(new NotificationHeader { CallId = 3 }));
        Assert.Equal(
            request with { Credential = Credential.SchemeOf(CredentialScheme.Jwt) },
            RouterCore.Redact(request with { Credential = Credential.Jwt("a.b.c") }));
        Assert.Equal(
            request with { Credential = Credential.SchemeOf((CredentialScheme)7) },
            RouterCore.Redact(request with { Credential = Credential.Of((CredentialScheme)7, [1, 2]) }));
    }
}
