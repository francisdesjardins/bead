using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="CredentialResolver"/>: a side's <c>JWT</c>s, verified against its keys and those its
/// key set answered (spec 13.8), and its <c>ELSEWHERE</c>s, by its verifier (spec 13.10), on the
/// clock it is given.
/// </summary>
public sealed class CredentialResolverTests
{
    // constants

    private const string Issuer = "https://hs256.example";

    private const string Audience = "bead-interop";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // where the wall clock starts: 2026-01-01T00:00:00Z
    private static readonly DateTimeOffset Start = DateTimeOffset.FromUnixTimeMilliseconds(1_767_225_600_000);

    // two HS256 keys of 32 bytes, in base64url, and the JWKs that name them
    private static readonly byte[] First = [.. Enumerable.Repeat((byte)1, 32)];
    private static readonly byte[] Second = [.. Enumerable.Repeat((byte)2, 32)];

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement JwkOf((byte[] Secret, string? Kid) key)
    {
        var members = new Dictionary<string, string> { ["k"] = Base64Url.EncodeToString(key.Secret), ["kty"] = "oct" };

        if (key.Kid is { } kid)
        {
            members["kid"] = kid;
        }

        return JsonSerializer.SerializeToElement(members);
    }

    private static string PartOf(object value)
    {
        return Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(value));
    }

    // an HS256 access token of the issuer for grace, an hour from the start, under a key and its kid
    private static string TokenOf((byte[] Secret, string? Kid) key)
    {
        var header = key.Kid is { } kid
            ? PartOf(new Dictionary<string, string> { ["alg"] = "HS256", ["kid"] = kid, ["typ"] = "at+jwt" })
            : PartOf(new Dictionary<string, string> { ["alg"] = "HS256", ["typ"] = "at+jwt" });
        var claims = PartOf(new Dictionary<string, object> { ["aud"] = Audience, ["exp"] = 1_767_229_200, ["iss"] = Issuer, ["sub"] = "grace" });
        var signature = HMACSHA256.HashData(key.Secret, Encoding.ASCII.GetBytes($"{header}.{claims}"));

        return $"{header}.{claims}.{Base64Url.EncodeToString(signature)}";
    }

    private static SessionRequest RequestOf(Credential credential, string? carried = null)
    {
        return new SessionRequest
        {
            ConnectionHandle = "first",
            Header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, Credential = credential },
            TransportCredential = carried,
        };
    }

    // what a request presenting a credential resolves to, on the test's own signal
    private static Task<CallSession?> ResolvedOf((CredentialResolver Resolver, Credential Credential) asked)
    {
        return asked.Resolver.Resolve(RequestOf(asked.Credential), Cancelled).AsTask().WaitAsync(Patience, Cancelled);
    }

    // a resolver of an ELSEWHERE verifier, on a clock at the start
    private static (CredentialResolver Resolver, FakeTimeProvider Clock) ElsewhereOf(Func<string, CancellationToken, ValueTask<ElsewhereSession?>> verify)
    {
        var clock = new FakeTimeProvider(Start);

        return (new CredentialResolver(new Credentials { Verify = verify }, (clock, false)), clock);
    }

    // definition

    [Fact]
    public async Task Resolves_a_JWT_that_verifies_to_its_credential_s_session_its_claims_its_identifier_with_its_scheme_its_end_exp_plus_60_s_and_one_that_does_not_to_none()
    {
        var clock = new FakeTimeProvider(Start);
        var resolver = new CredentialResolver(
            new Credentials { Audience = Audience, Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }] },
            (clock, false));
        var session = await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null)))));

        Assert.Equal(new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = Issuer, Sub = "grace" }, session!.Identifier);
        Assert.Equal("grace", ((JsonElement)session.Data!).GetProperty("sub").GetString());
        Assert.Equal(1_767_229_200_000 + 60_000, session.End);

        // signed under another key, or held past its end
        Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((Second, null))))));
        clock.SetUtcNow(DateTimeOffset.FromUnixTimeMilliseconds(1_767_229_260_000));
        Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null))))));
    }

    [Fact]
    public void Takes_a_JWT_once_given_keys_or_a_key_set_an_ELSEWHERE_once_given_its_verifier_and_nothing_else()
    {
        var clock = new FakeTimeProvider(Start);
        var keys = new[] { new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) } };

        Assert.Equal([CredentialScheme.Opaque], new CredentialResolver(null, (clock, false)).Schemes);
        Assert.Equal([CredentialScheme.Opaque, CredentialScheme.Jwt], new CredentialResolver(new Credentials { Audience = Audience, Keys = keys }, (clock, false)).Schemes);
        Assert.Equal(
            [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere],
            new CredentialResolver(
                new Credentials
                {
                    Audience = Audience,
                    KeySet = (_) =>
                    {
                        return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
                    },
                    Verify = (_, _) =>
                    {
                        return ValueTask.FromResult<ElsewhereSession?>(null);
                    },
                },
                (clock, false)).Schemes);
    }

    [Fact]
    public void Refuses_as_it_is_built_a_key_not_shaped_for_its_algorithm_and_an_audience_not_of_well_formed_Unicode()
    {
        var clock = new FakeTimeProvider(Start);
        var key = new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) };

        Assert.Throws<ArgumentException>(() =>
        {
            return new CredentialResolver(new Credentials { Audience = Audience, Keys = [key with { Jwk = JwkOf((First[..31], null)) }] }, (clock, false));
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new CredentialResolver(new Credentials { Audience = "\ud800", Keys = [key] }, (clock, false));
        });
    }

    [Fact]
    public void Refuses_as_it_is_built_keys_or_a_key_set_given_without_an_audience_unless_its_side_s_relay_verifies()
    {
        var clock = new FakeTimeProvider(Start);
        var keys = new Credentials { Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }] };
        var keySet = new Credentials
        {
            KeySet = (_) =>
            {
                return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([]);
            },
        };

        Assert.Throws<ArgumentException>(() =>
        {
            return new CredentialResolver(keys, (clock, false));
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return new CredentialResolver(keySet, (clock, false));
        });

        // a relay that verifies holds its destinations' audiences; an ELSEWHERE's verifier needs none
        Assert.Equal([CredentialScheme.Opaque, CredentialScheme.Jwt], new CredentialResolver(keys, (clock, true)).Schemes);
        Assert.Equal([CredentialScheme.Opaque, CredentialScheme.Jwt], new CredentialResolver(keySet, (clock, true)).Schemes);
        Assert.Equal(
            [CredentialScheme.Opaque, CredentialScheme.Elsewhere],
            new CredentialResolver(
                new Credentials
                {
                    Verify = (_, _) =>
                    {
                        return ValueTask.FromResult<ElsewhereSession?>(null);
                    },
                },
                (clock, false)).Schemes);
    }

    [Fact]
    public void Refuses_limits_whose_chunk_or_envelope_is_under_1024_bytes_and_takes_them_from_1024()
    {
        var held = RouterLimits.Default with { ChunkBytes = 1_024, MaximumEnvelopeBytes = 1_024, WindowBytes = 2_048 };

        Assert.Throws<ArgumentException>(() =>
        {
            CredentialResolver.AssertLimits(held with { ChunkBytes = 1_023 }, true);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            CredentialResolver.AssertLimits(held with { MaximumEnvelopeBytes = 1_023 }, true);
        });
        CredentialResolver.AssertLimits(held, true);

        // a side that takes no JWT holds what limits it holds
        CredentialResolver.AssertLimits(held with { ChunkBytes = 64, MaximumEnvelopeBytes = 64, WindowBytes = 128 }, false);
    }

    [Fact]
    public async Task Counts_the_keys_held_toward_an_issuer_s_one_key_for_a_token_without_a_kid()
    {
        var clock = new FakeTimeProvider(Start);
        var resolver = new CredentialResolver(
            new Credentials
            {
                Audience = Audience,
                KeySet = (_) =>
                {
                    return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((First, "first")) }]);
                },
            },
            (clock, false));
        var key = new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((Second, "second")) };
        var twoKeyed = new CredentialResolver(
            new Credentials
            {
                Audience = Audience,
                Keys = [key],
                KeySet = (_) =>
                {
                    return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((First, "first")) }]);
                },
            },
            (clock, false));

        // none held yet: a kid-less token asks nothing, and finds no key
        Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null))))));

        // the one key its issuer holds, once the set answered it, serves a token without a kid
        Assert.NotNull(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, "first"))))));
        Assert.NotNull(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null))))));

        // beside a key of the application's, two: a token without a kid finds neither
        Assert.NotNull(await ResolvedOf((twoKeyed, Credential.Jwt(TokenOf((First, "first"))))));
        Assert.Null(await ResolvedOf((twoKeyed, Credential.Jwt(TokenOf((Second, null))))));
    }

    [Fact]
    public async Task Asks_its_key_set_for_a_kid_no_key_held_names_once_a_minute_at_most_for_an_issuer_sharing_an_ask_under_way_and_holding_its_answer_until_the_next()
    {
        var clock = new FakeTimeProvider(Start);
        var asked = new List<string>();
        var later = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();
        IReadOnlyList<JwtSetKey>[] answers =
        [
            [new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((First, "first")) }],
            [new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((Second, "second")) }],
        ];
        var resolver = new CredentialResolver(
            new Credentials
            {
                Audience = Audience,
                KeySet = (issuer) =>
                {
                    asked.Add(issuer);

                    return asked.Count == 1 ? ValueTask.FromResult(answers[0]) : new ValueTask<IReadOnlyList<JwtSetKey>>(later.Task);
                },
            },
            (clock, false));
        var first = Credential.Jwt(TokenOf((First, "first")));
        var second = Credential.Jwt(TokenOf((Second, "second")));

        // asked for the token's issuer, then held: no ask for the kid it named
        Assert.NotNull(await ResolvedOf((resolver, first)));
        Assert.NotNull(await ResolvedOf((resolver, first)));

        // a kid none names, within the minute: refused, nothing asked
        Assert.Null(await ResolvedOf((resolver, second)));
        Assert.Equal([Issuer], asked);

        // past the minute, asked again, two calls sharing the ask: its answer replaces the keys held
        clock.Advance(TimeSpan.FromMinutes(1));

        var sharing = new[] { ResolvedOf((resolver, second)), ResolvedOf((resolver, second)) };

        later.SetResult(answers[1]);
        Assert.All(await Task.WhenAll(sharing), Assert.NotNull);
        Assert.Null(await ResolvedOf((resolver, first)));
        Assert.Equal([Issuer, Issuer], asked);
    }

    [Fact]
    public async Task Lets_a_call_s_cancel_end_its_own_wait_never_the_ask_the_others_wait_on()
    {
        var clock = new FakeTimeProvider(Start);
        var answer = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();
        var asks = 0;
        var resolver = new CredentialResolver(
            new Credentials
            {
                Audience = Audience,
                KeySet = (_) =>
                {
                    asks += 1;

                    return new ValueTask<IReadOnlyList<JwtSetKey>>(answer.Task);
                },
            },
            (clock, false));
        var token = Credential.Jwt(TokenOf((First, "first")));

        using var leaving = new CancellationTokenSource();

        var left = resolver.Resolve(RequestOf(token), leaving.Token).AsTask();
        var waiting = resolver.Resolve(RequestOf(token), Cancelled).AsTask();

        await leaving.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return left.WaitAsync(Patience, Cancelled);
        });
        Assert.False(waiting.IsCompleted);

        answer.SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((First, "first")) }]);

        Assert.NotNull(await waiting.WaitAsync(Patience, Cancelled));
        Assert.Equal(1, asks);
    }

    [Fact]
    public async Task Fails_a_call_while_its_issuer_s_last_ask_failed_within_the_minute_and_asks_again_past_it()
    {
        var clock = new FakeTimeProvider(Start);
        var asks = 0;
        var resolver = new CredentialResolver(
            new Credentials
            {
                Audience = Audience,
                KeySet = (_) =>
                {
                    asks += 1;

                    return asks == 1
                        ? ValueTask.FromException<IReadOnlyList<JwtSetKey>>(new HttpRequestException("the key set cannot be reached"))
                        : ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf((First, "first")) }]);
                },
            },
            (clock, false));
        var token = Credential.Jwt(TokenOf((First, "first")));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ResolvedOf((resolver, token));
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ResolvedOf((resolver, token));
        });
        Assert.Equal(1, asks);

        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.NotNull(await ResolvedOf((resolver, token)));
        Assert.Equal(2, asks);
    }

    [Fact]
    public async Task Asks_the_ELSEWHERE_verifier_once_with_exactly_what_its_transport_carried_and_the_call_s_signal_and_never_for_one_that_carried_nothing()
    {
        var asked = new List<(string Carried, CancellationToken Signal)>();
        var (resolver, _) = ElsewhereOf((carried, signal) =>
        {
            asked.Add((carried, signal));

            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Data = "ada's", Id = "ada" });
        });

        using var call = new CancellationTokenSource();

        var session = await resolver.Resolve(RequestOf(Credential.Elsewhere(), " Interop  sub=ada "), call.Token);

        Assert.Equal(
            new CallSession { Data = "ada's", Identifier = new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = "ada" } },
            session);
        Assert.Null(await resolver.Resolve(RequestOf(Credential.Elsewhere()), call.Token));
        Assert.Equal([(" Interop  sub=ada ", call.Token)], asked);
    }

    [Fact]
    public async Task Fails_a_verifier_that_throws_at_once_as_one_that_rejects()
    {
        var thrown = new InvalidOperationException("this verifier fails, on purpose");
        var (throwing, _) = ElsewhereOf((_, _) =>
        {
            throw thrown;
        });
        var (rejecting, _) = ElsewhereOf((_, _) =>
        {
            return ValueTask.FromException<ElsewhereSession?>(thrown);
        });

        foreach (var resolver in new[] { throwing, rejecting })
        {
            Assert.Same(thrown, await Assert.ThrowsAsync<InvalidOperationException>(() =>
            {
                return resolver.Resolve(RequestOf(Credential.Elsewhere(), "Interop fail=true"), Cancelled).AsTask();
            }));
        }
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(9_007_199_254_740_992.0)]
    [InlineData(-9_007_199_254_740_992.0)]
    public async Task Fails_a_session_whose_end_is_not_a_number_within_2_53_and_one_whose_id_is_no_string(double end)
    {
        var (resolver, _) = ElsewhereOf((_, _) =>
        {
            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { End = end, Id = "ada" });
        });
        var (nameless, _) = ElsewhereOf((_, _) =>
        {
            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { Id = null! });
        });

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return resolver.Resolve(RequestOf(Credential.Elsewhere(), "Interop sub=ada"), Cancelled).AsTask();
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return nameless.Resolve(RequestOf(Credential.Elsewhere(), "Interop sub=ada"), Cancelled).AsTask();
        });
    }

    [Fact]
    public async Task Rounds_an_end_up_to_a_millisecond_half_a_millisecond_past_the_wall_clock_holds_and_half_short_does_not()
    {
        var wall = Start.ToUnixTimeMilliseconds();
        var ends = new Queue<double>([wall + 0.5, wall - 0.5, wall + 1]);
        var (resolver, _) = ElsewhereOf((_, _) =>
        {
            return ValueTask.FromResult<ElsewhereSession?>(new ElsewhereSession { End = ends.Dequeue(), Id = "ada" });
        });

        Assert.Equal(wall + 1, (await resolver.Resolve(RequestOf(Credential.Elsewhere(), "Interop sub=ada"), Cancelled))!.End);
        Assert.Null(await resolver.Resolve(RequestOf(Credential.Elsewhere(), "Interop sub=ada"), Cancelled));
        Assert.Equal(wall + 1, (await resolver.Resolve(RequestOf(Credential.Elsewhere(), "Interop sub=ada"), Cancelled))!.End);
    }
}
