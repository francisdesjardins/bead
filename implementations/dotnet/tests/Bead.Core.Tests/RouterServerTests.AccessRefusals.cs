using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterServer.AccessRefused"/>: each access the router refuses as a request's credential
/// resolves or as it is admitted, told as the refusal is answered (spec 13.12) — its stage, the code
/// answered, why, what was called, the connection and the request's address and port, never the
/// credential — and what it does not tell.
/// </summary>
public sealed partial class RouterServerTests
{
    // constants

    // the address and port a transport hands beside every request of these tests
    private const string From = "192.0.2.7";

    private const int FromPort = 51_234;

    // helpers

    /// <summary>The names of the <c>jwtVerdicts</c> of <c>spec/vectors.json</c> that refuse their token.</summary>
    public static TheoryData<string> RefusedJwts
    {
        get
        {
            var names = new TheoryData<string>();

            foreach (var name in Vectors.NamesOf("jwtVerdicts"))
            {
                if (!Vectors.Of("jwtVerdicts", name).GetProperty("verdict").GetProperty("holds").GetBoolean())
                {
                    names.Add(name);
                }
            }

            return names;
        }
    }

    /// <summary>The names of every <c>credentialRefusals</c> entry of <c>spec/vectors.json</c>.</summary>
    public static TheoryData<string> CredentialRefusals { get; } = Vectors.NamesOf("credentialRefusals");

    // what the router tells of each access it refuses, from now on
    private List<AccessRefusal> Told()
    {
        var told = new List<AccessRefusal>();

        Router.AccessRefused += told.Add;

        return told;
    }

    // a request, from the address and the port the tests hand beside each
    private void DeliverFrom(string connectionHandle, Envelope envelope)
    {
        _transport.DeliverFrom(connectionHandle, (EnvelopeCodec.WriteEnvelope(envelope), From, FromPort));
    }

    // what an access refused to echo on the first connection is told with
    private static AccessRefusal RefusalOf((AccessRefusalStage Stage, ProtocolCode Code, string? Reason) refused, CredentialScheme? scheme)
    {
        return new AccessRefusal
        {
            Stage = refused.Stage,
            Code = refused.Code,
            Reason = refused.Reason,
            CredentialScheme = scheme,
            ServiceId = Echo.ServiceId,
            ProcedureId = Echo.ProcedureId,
            ConnectionHandle = First,
            Address = From,
            Port = FromPort,
        };
    }

    // definition

    [Fact]
    public async Task Tells_each_access_it_refuses_its_stage_its_code_its_reason_and_what_was_called_with_the_connection_and_the_request_s_address_and_port_never_the_credential()
    {
        var expired = JwtOf(1);

        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = Jwk }],
            },
            SessionOf = (request, _) =>
            {
                return ValueTask.FromResult(CallSession.ConnectionSessionOf(request.Header.Credential, (Token, null)));
            },
        });
        _transport.Open(First);
        _transport.Open(Second);
        Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = 4 });

        var told = Told();

        // an admission of the application's own, which refuses every call, its detail its own
        Services.GetRequestResolver(
            Echo,
            new RequestResolverDependencies<string, string>
            {
                Serializer = Text,
                BeforeRequest = new BeforeRequest(
                    (_) =>
                    {
                        return false;
                    },
                    Failure.OfProtocol(ProtocolCode.AccessDenied, "not this one")),
            })((_, response) =>
            {
                return response.Answer("admitted");
            });

        // a scheme to come, an OPAQUE of another session, a JWT whose exp passed, a call presenting
        // none its admission refuses, and one to a destination of a relay given no beforeRoute
        DeliverFrom(First, Presenting(RequestOf(1), Credential.Of((CredentialScheme)4, [])));
        DeliverFrom(First, Presenting(RequestOf(3), OtherToken));
        DeliverFrom(First, Presenting(RequestOf(5), Credential.Jwt(expired)));
        DeliverFrom(First, RequestOf(7));
        DeliverFrom(First, new Envelope { Header = (RequestHeader)RequestOf(9).Header with { DestinationId = 4 } });
        await Settle();

        // told in the turn each is answered, a JWT's in a later turn, each answered as it would be
        // untold
        Assert.Equal(
            ["1 CredentialUnsupported", "3 SessionRequired", "7 AccessDenied", "9 AccessDenied", "5 SessionRequired"],
            _transport.Sent
                .Select((entry) =>
                {
                    return $"{entry.Envelope.Header.CallId} {CodeOf(entry.Envelope.Failure!)}";
                }));
        Assert.Equal(
            [
                RefusalOf((AccessRefusalStage.Credential, ProtocolCode.CredentialUnsupported, "scheme"), (CredentialScheme)4),
                RefusalOf((AccessRefusalStage.Credential, ProtocolCode.SessionRequired, "session"), CredentialScheme.Opaque),
                RefusalOf((AccessRefusalStage.Admission, ProtocolCode.AccessDenied, null), null),
                RefusalOf((AccessRefusalStage.Admission, ProtocolCode.AccessDenied, "no-before-route"), null) with { DestinationId = 4 },
                RefusalOf((AccessRefusalStage.Credential, ProtocolCode.SessionRequired, "exp"), CredentialScheme.Jwt),
            ],
            told);

        // never the credential, nor an admission's detail
        Assert.All(told, (refusal) =>
        {
            Assert.DoesNotContain(expired, refusal.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(OtherToken.ToString(), refusal.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain("not this one", refusal.ToString(), StringComparison.Ordinal);
        });
        Assert.Empty(Reported());
    }

    [Theory]
    [MemberData(nameof(RefusedJwts))]
    public async Task Tells_a_JWT_refused_by_the_step_of_section_13_8_that_refused_it_for_every_verdict_of_spec_vectors_json_that_refuses(string name)
    {
        var vector = Vectors.Of("jwtVerdicts", name);
        var audience = vector.GetProperty("audience");

        // a set of audiences is a relay's that verifies, one of its destinations each
        var isSet = audience.ValueKind == JsonValueKind.Array;

        _time.SetUtcNow(DateTimeOffset.Parse(vector.GetProperty("now").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal));
        Start(new RouterServerOptions
        {
            Relay = isSet ? Admitting with { Verifies = true } : null,
            Credentials = new Credentials
            {
                Audience = isSet ? audience[0].GetString() : audience.GetString(),
                Keys = [.. vector.GetProperty("keys").EnumerateArray().Select((key) =>
                {
                    return new JwtKey
                    {
                        Issuer = key.GetProperty("issuer").GetString()!,
                        Algorithm = Enum.Parse<JwtAlgorithm>(key.GetProperty("algorithm").GetString()!, ignoreCase: true),
                        Jwk = key.GetProperty("jwk"),
                    };
                })],
            },
        });
        _transport.Open(First);
        EchoOf((_, response) =>
        {
            return response.Answer("ran");
        });

        if (isSet)
        {
            var destinationId = 7u;

            _transport.Open(Second);

            foreach (var each in audience.EnumerateArray())
            {
                Router.RegisterDestination(new ConnectionTarget(Second), new DestinationOptions { DestinationId = destinationId, Audience = each.GetString() });
                destinationId += 1;
            }
        }

        var told = Told();
        var request = Presenting(RequestOf(1), Credential.Jwt(vector.GetProperty("token").GetString()!));

        DeliverFrom(First, isSet ? To(7, request) : request);
        await Settle();

        Assert.Equal(
            RefusalOf((AccessRefusalStage.Credential, ProtocolCode.SessionRequired, vector.GetProperty("verdict").GetProperty("reason").GetString()), CredentialScheme.Jwt) with
            {
                DestinationId = isSet ? 7 : null,
            },
            Assert.Single(told));
    }

    [Theory]
    [MemberData(nameof(CredentialRefusals))]
    public async Task Tells_each_credential_refused_by_the_reason_spec_vectors_json_s_credentialRefusals_gives_it(string name)
    {
        var entry = Vectors.Of("credentialRefusals", name);
        var situation = entry.GetProperty("situation").GetString();
        var scheme = entry.GetProperty("scheme") is { ValueKind: JsonValueKind.Number } number
            ? (CredentialScheme)number.GetUInt16()
            : Enum.Parse<CredentialScheme>(entry.GetProperty("scheme").GetString()!, ignoreCase: true);

        // the situation the entry names, on a server of its own: the session the second connection
        // holds, an ELSEWHERE verifier that makes none of "none" and one whose end has come of
        // "ended", or no verifier at all; never a key
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Verify = situation == "no-verifier"
                    ? null
                    : (carried, _) =>
                    {
                        return ValueTask.FromResult(carried switch
                        {
                            "none" => null,
                            "ended" => new ElsewhereSession { Id = "ada", End = _time.GetUtcNow().ToUnixTimeMilliseconds() },
                            _ => new ElsewhereSession { Id = "ada" },
                        });
                    },
            },
            SessionOf = (request, _) =>
            {
                return ValueTask.FromResult(CallSession.ConnectionSessionOf(
                    request.Header.Credential,
                    (request.ConnectionHandle == Second ? Token : null, null)));
            },
        });
        _transport.Open(First);
        _transport.Open(Second);
        EchoOf((_, response) =>
        {
            return response.Answer("ran");
        });

        var told = Told();
        var request = situation switch
        {
            "another-connections-session" => Presenting(RequestOf(1), Token),
            "no-session" => Presenting(RequestOf(1), OtherToken),
            "nothing-carried" or "verifier-makes-none" or "end-come" or "no-verifier" => Presenting(RequestOf(1), Credential.Elsewhere()),
            "no-keys" => Presenting(RequestOf(1), Credential.Jwt("a.b.c")),
            _ => Presenting(RequestOf(1), Credential.Of(scheme, [])),
        };
        var carried = situation switch
        {
            "verifier-makes-none" => "none",
            "end-come" => "ended",
            "no-verifier" => "Interop sub=ada",
            _ => null,
        };

        Message(First, (EnvelopeCodec.WriteEnvelope(request), carried));
        await Settle();

        var code = (ProtocolCode)entry.GetProperty("code").GetUInt16();

        Assert.Equal(((ushort)code, 1u), (_transport.Sent.Single().Envelope.Failure!.Code, _transport.Sent.Single().Envelope.Header.CallId));
        Assert.Equal(
            RefusalOf((AccessRefusalStage.Credential, code, entry.GetProperty("reason").GetString()), scheme),
            Assert.Single(told));
    }

    [Fact]
    public async Task Tells_nothing_of_a_verifier_or_an_admission_that_fails_or_of_a_call_past_those_let_wait_for_an_issuer()
    {
        var answers = new List<TaskCompletionSource<IReadOnlyList<JwtSetKey>>>();
        var exp = _time.GetUtcNow().ToUnixTimeSeconds() + 3_600;

        // a verifier that fails, a key set that lets one call wait for its issuer's deadline, and an
        // admission that throws
        Start(new RouterServerOptions
        {
            Credentials = new Credentials
            {
                Audience = Audience,
                KeySet = new JwtKeySet
                {
                    Issuers = [Issuer],
                    Ask = (_, _) =>
                    {
                        var answer = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();

                        answers.Add(answer);

                        return new ValueTask<IReadOnlyList<JwtSetKey>>(answer.Task);
                    },
                    MaximumWaitingCalls = 1,
                },
                Verify = (_, _) =>
                {
                    return ValueTask.FromException<ElsewhereSession?>(new InvalidOperationException("the verifier broke"));
                },
            },
        });
        _transport.Open(First);
        Services.GetRequestResolver(
            Echo,
            new RequestResolverDependencies<string, string>
            {
                Serializer = Text,
                BeforeRequest = new BeforeRequest((request) =>
                {
                    if (request.Header.CallId == 3)
                    {
                        throw new InvalidOperationException("the admission broke");
                    }

                    return true;
                }),
            })((_, response) =>
            {
                return response.Answer("ran");
            });

        var told = Told();

        // the key set's keys held by a call presenting a kid its answer names
        DeliverFrom(First, Presenting(RequestOf(1), Credential.Jwt(JwtOf(exp))));
        await Settle();
        answers[0].SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = Jwk }]);
        await Settle();

        // an admission that throws, a verifier that fails, and two calls of a kid the keys do not
        // name: one waits for the deadline, the other is past the bound
        DeliverFrom(First, RequestOf(3));
        Message(First, (EnvelopeCodec.WriteEnvelope(Presenting(RequestOf(5), Credential.Elsewhere())), Carried));
        DeliverFrom(First, Presenting(RequestOf(7), Credential.Jwt(JwtOf(exp, "second"))));
        await Settle();
        DeliverFrom(First, Presenting(RequestOf(9), Credential.Jwt(JwtOf(exp, "second"))));
        await Settle();

        Assert.Equal(
            ["1 result", "3 ProcedureFailed", "5 ProcedureFailed", "9 CapacityExceeded"],
            _transport.Sent
                .Select((entry) =>
                {
                    return $"{entry.Envelope.Header.CallId} {(entry.Envelope.Failure is { } failure ? CodeOf(failure) : "result")}";
                })
                .Order(StringComparer.Ordinal));
        Assert.Equal(["the admission broke first", "the verifier broke first"], Reported());
        Assert.Empty(told);
    }

    [Fact]
    public async Task Refuses_as_it_would_though_an_AccessRefused_listener_throws_the_throw_reported_with_its_connection()
    {
        var thrown = new InvalidOperationException("the listener broke");

        Start();
        _transport.Open(First);
        EchoOf((_, response) =>
        {
            return response.Answer("ran");
        });
        Router.AccessRefused += (_) =>
        {
            throw thrown;
        };

        var told = Told();

        DeliverFrom(First, Presenting(RequestOf(1), Credential.Of((CredentialScheme)4, [])));
        DeliverFrom(First, RequestOf(3));
        await Settle();

        // refused as it would be, the call after it answered, the listener after it told all the same
        Assert.Equal(["first failure 1 CredentialUnsupported", "first result 3 ran"], SentSince());
        Assert.Single(told);
        Assert.Equal([(thrown, (string?)First)], _errors.Select((error) =>
        {
            return (error.Reason, error.ConnectionHandle);
        }));
    }

    // an envelope on a connection, with what its transport carried beside it, if anything, and the
    // address and port the tests hand beside each
    private void Message(string connectionHandle, (byte[] Bytes, string? Carried) message)
    {
        if (message.Carried is { } carried)
        {
            _transport.CarryingFrom(connectionHandle, (message.Bytes, carried, (From, FromPort)));

            return;
        }

        _transport.DeliverFrom(connectionHandle, (message.Bytes, From, FromPort));
    }
}
