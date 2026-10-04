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

    // the issuer the key set names, which no key of the application's signs for
    private const string SetIssuer = "https://keys.example";

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

    // an HS256 access token of an issuer for grace, an hour from the start, under a key and its kid
    private static string TokenOf((byte[] Secret, string? Kid) key, string issuer = Issuer)
    {
        var header = key.Kid is { } kid
            ? PartOf(new Dictionary<string, string> { ["alg"] = "HS256", ["kid"] = kid, ["typ"] = "at+jwt" })
            : PartOf(new Dictionary<string, string> { ["alg"] = "HS256", ["typ"] = "at+jwt" });
        var claims = PartOf(new Dictionary<string, object> { ["aud"] = Audience, ["exp"] = 1_767_229_200, ["iss"] = issuer, ["sub"] = "grace" });
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

    // what a deadline does, run where the clock fires it
    private static void Inline(Action action)
    {
        action();
    }

    // a resolver of credentials, on a clock
    private static CredentialResolver ResolverOf(Credentials credentials, TimeProvider clock)
    {
        return new CredentialResolver(credentials, (clock, Inline));
    }

    // a resolver of an ELSEWHERE verifier, on a clock at the start
    private static (CredentialResolver Resolver, FakeTimeProvider Clock) ElsewhereOf(Func<string, CancellationToken, ValueTask<ElsewhereSession?>> verify)
    {
        var clock = new FakeTimeProvider(Start);

        return (ResolverOf(new Credentials { Verify = verify }, clock), clock);
    }

    // a key set for the issuer that answers as its ask does
    private static JwtKeySet KeySetOf(Func<string, CancellationToken, ValueTask<IReadOnlyList<JwtSetKey>>> ask)
    {
        return new JwtKeySet { Issuers = [Issuer], Ask = ask };
    }

    // a key set for the issuer answering keys at once
    private static JwtKeySet AnsweringOf(params JwtSetKey[] keys)
    {
        return KeySetOf((_, _) =>
        {
            return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>(keys);
        });
    }

    private static JwtSetKey SetKeyOf((byte[] Secret, string? Kid) key)
    {
        return new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = JwkOf(key) };
    }

    // definition

    [Fact]
    public async Task Resolves_a_JWT_that_verifies_to_its_credential_s_session_its_claims_its_identifier_with_its_scheme_its_end_exp_plus_60_s_and_one_that_does_not_to_none()
    {
        var clock = new FakeTimeProvider(Start);
        var resolver = ResolverOf(
            new Credentials { Audience = Audience, Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }] },
            clock);
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

        Assert.Equal([CredentialScheme.Opaque], ResolverOf(new Credentials(), clock).Schemes);
        Assert.Equal([CredentialScheme.Opaque, CredentialScheme.Jwt], ResolverOf(new Credentials { Audience = Audience, Keys = keys }, clock).Schemes);
        Assert.Equal(
            [CredentialScheme.Opaque, CredentialScheme.Jwt, CredentialScheme.Elsewhere],
            ResolverOf(
                new Credentials
                {
                    Audience = Audience,
                    KeySet = AnsweringOf(),
                    Verify = (_, _) =>
                    {
                        return ValueTask.FromResult<ElsewhereSession?>(null);
                    },
                },
                clock).Schemes);
    }

    [Fact]
    public void Refuses_as_it_is_built_a_key_not_shaped_for_its_algorithm_and_an_audience_not_of_well_formed_Unicode()
    {
        var clock = new FakeTimeProvider(Start);
        var key = new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) };

        Assert.Throws<ArgumentException>(() =>
        {
            return ResolverOf(new Credentials { Audience = Audience, Keys = [key with { Jwk = JwkOf((First[..31], null)) }] }, clock);
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return ResolverOf(new Credentials { Audience = "\ud800", Keys = [key] }, clock);
        });
    }

    [Fact]
    public void Refuses_as_it_is_built_a_key_set_given_no_issuer_or_one_that_is_no_string()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = AnsweringOf();

        foreach (var issuers in new IReadOnlyList<string>[] { [], [null!], [Issuer, null!], null! })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return ResolverOf(new Credentials { Audience = Audience, KeySet = keySet with { Issuers = issuers } }, clock);
            });
        }

        Assert.Equal([CredentialScheme.Opaque, CredentialScheme.Jwt], ResolverOf(new Credentials { Audience = Audience, KeySet = keySet }, clock).Schemes);
    }

    [Fact]
    public void Refuses_as_it_is_built_keys_or_a_key_set_given_without_an_audience()
    {
        var clock = new FakeTimeProvider(Start);
        var keys = new Credentials { Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }] };
        var keySet = new Credentials { KeySet = AnsweringOf() };

        foreach (var credentials in new[] { keys, keySet })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return ResolverOf(credentials, clock);
            });
        }

        // an ELSEWHERE's verifier needs none
        Assert.Equal(
            [CredentialScheme.Opaque, CredentialScheme.Elsewhere],
            ResolverOf(
                new Credentials
                {
                    Verify = (_, _) =>
                    {
                        return ValueTask.FromResult<ElsewhereSession?>(null);
                    },
                },
                clock).Schemes);
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
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = AnsweringOf(SetKeyOf((First, "first"))) }, clock);
        var key = new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((Second, "second")) };
        var twoKeyed = ResolverOf(new Credentials { Audience = Audience, Keys = [key], KeySet = AnsweringOf(SetKeyOf((First, "first"))) }, clock);

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
    public async Task Asks_its_key_set_once_a_minute_at_most_for_an_issuer_sharing_an_ask_under_way_a_kid_none_names_within_the_minute_waits_for_the_deadline_and_the_ask_then_refused_once_its_answer_does_not_name_it()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var named = Credential.Jwt(TokenOf((First, "first")));
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));

        // two calls on one ask, for the token's issuer
        var sharing = new[] { ResolvedOf((resolver, named)), ResolvedOf((resolver, named)) };

        Assert.Single(keySet.Asks);
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.All(await Task.WhenAll(sharing), Assert.NotNull);

        // its answer held, no ask goes; a kid none names waits for the deadline, a minute after the
        // ask went, on the monotonic reading
        Assert.NotNull(await ResolvedOf((resolver, named)));

        var unknown = ResolvedOf((resolver, unnamed));

        clock.Advance(TimeSpan.FromMilliseconds(59_999));
        Assert.False(unknown.IsCompleted);
        Assert.Single(keySet.Asks);

        // the ask goes at the deadline, for the issuer, and its answer names no "second"
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([Issuer, Issuer], keySet.Issuers());
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Null(await unknown);
    }

    [Fact]
    public async Task Lets_a_call_s_cancel_end_its_own_wait_never_the_ask_the_others_wait_on()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
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

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);

        Assert.NotNull(await waiting.WaitAsync(Patience, Cancelled));
        Assert.Single(keySet.Asks);
    }

    [Fact]
    public async Task Fails_the_calls_that_wait_on_an_ask_that_rejects_and_has_a_token_within_the_minute_wait_for_the_deadline_and_the_ask_then()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var token = Credential.Jwt(TokenOf((First, "first")));
        var failing = ResolvedOf((resolver, token));

        keySet.Asks[0].Settle.SetException(new HttpRequestException("the key set cannot be reached"));
        Assert.Contains("key set", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return failing;
        })).Message, StringComparison.Ordinal);

        // within the minute, the next waits for the deadline, asking nothing before it
        var next = ResolvedOf((resolver, token));

        clock.Advance(TimeSpan.FromMilliseconds(59_999));
        Assert.False(next.IsCompleted);
        Assert.Single(keySet.Asks);

        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await next)!.Identifier!.Sub);
    }

    [Fact]
    public async Task Fails_a_call_alike_when_its_key_set_throws_as_it_is_asked_and_has_the_next_within_the_minute_wait_for_the_deadline_and_the_ask_then()
    {
        var clock = new FakeTimeProvider(Start);
        var asked = 0;
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                KeySet = KeySetOf((_, _) =>
                {
                    asked += 1;

                    if (asked == 1)
                    {
                        throw new HttpRequestException("the key set cannot be reached");
                    }

                    return ValueTask.FromResult<IReadOnlyList<JwtSetKey>>([SetKeyOf((First, "first"))]);
                }),
            },
            clock);
        var token = Credential.Jwt(TokenOf((First, "first")));

        Assert.Contains("key set", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ResolvedOf((resolver, token));
        })).Message, StringComparison.Ordinal);

        var next = ResolvedOf((resolver, token));

        Assert.False(next.IsCompleted);
        Assert.Equal(1, asked);

        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal("grace", (await next)!.Identifier!.Sub);
        Assert.Equal(2, asked);
    }

    [Fact]
    public async Task Aborts_the_signal_it_gives_its_key_set_s_ask_at_the_ask_s_deadline_a_minute_after_it_went_and_not_before_failing_the_calls_that_wait_on_it()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var token = Credential.Jwt(TokenOf((First, "first")));
        var waiting = ResolvedOf((resolver, token));

        clock.Advance(TimeSpan.FromMilliseconds(59_999));
        Assert.False(keySet.Asks[0].Signal.IsCancellationRequested);
        Assert.False(waiting.IsCompleted);

        // unsettled at its deadline, it has failed, whatever it does with its signal
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.True(keySet.Asks[0].Signal.IsCancellationRequested);
        Assert.Contains("key set", (await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return waiting;
        })).Message, StringComparison.Ordinal);

        // the next ask goes at once, its own signal live
        var next = ResolvedOf((resolver, token));

        Assert.Equal(2, keySet.Asks.Count);
        Assert.False(keySet.Asks[1].Signal.IsCancellationRequested);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await next)!.Identifier!.Sub);
    }

    [Fact]
    public async Task Drops_what_an_ask_settles_to_after_its_deadline_its_keys_are_never_held()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var token = Credential.Jwt(TokenOf((First, "first")));
        var late = ResolvedOf((resolver, token));

        clock.Advance(TimeSpan.FromMinutes(1));
        await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return late;
        });
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);

        // nothing held: a token of that kid asks anew, and holds only once that ask names it
        var again = ResolvedOf((resolver, token));

        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([]);
        Assert.Null(await again);
    }

    [Fact]
    public async Task Has_a_token_without_a_kid_wait_on_a_new_ask_once_the_keys_held_for_its_issuer_are_past_their_ten_minutes_a_millisecond_either_side()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var kidless = Credential.Jwt(TokenOf((First, null)));
        var first = ResolvedOf((resolver, Credential.Jwt(TokenOf((First, "first")))));

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.NotNull(await first);
        clock.Advance(TimeSpan.FromMilliseconds(599_999));

        // a millisecond short of ten minutes from the answer, its keys serve: no ask
        Assert.Equal("grace", (await ResolvedOf((resolver, kidless)))!.Identifier!.Sub);
        Assert.Single(keySet.Asks);

        // ten minutes from it, they serve no more: the token waits on a new ask, which serves anew
        clock.Advance(TimeSpan.FromMilliseconds(1));

        var stale = ResolvedOf((resolver, kidless));

        Assert.False(stale.IsCompleted);
        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await stale)!.Identifier!.Sub);
    }

    [Fact]
    public async Task Refuses_at_once_asking_nothing_a_token_of_an_issuer_its_key_set_does_not_name_the_application_s_own_among_them_whose_kid_another_issuer_s_held_key_names()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet(SetIssuer);
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }],
                KeySet = keySet.KeySet,
            },
            clock);
        var first = ResolvedOf((resolver, Credential.Jwt(TokenOf((Second, "set-1"), SetIssuer))));

        keySet.Asks[0].Settle.SetResult([SetKeyOf((Second, "set-1"))]);
        Assert.Equal(SetIssuer, (await first)!.Identifier!.Issuer);

        // set-1 is held for the key set's issuer alone: each of these is judged by the keys there are
        foreach (var issuer in new[] { "https://other.example", Issuer })
        {
            foreach (var secret in new[] { Second, First })
            {
                Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((secret, "set-1"), issuer)))));
            }
        }

        Assert.Single(keySet.Asks);
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

    // a key set for an issuer that records each ask, its issuer and its signal, and answers as each
    // is settled
    private sealed class RecordingKeySet
    {
        public RecordingKeySet(string issuer = Issuer)
        {
            KeySet = new JwtKeySet
            {
                Issuers = [issuer],
                Ask = (asked, signal) =>
                {
                    var settle = new TaskCompletionSource<IReadOnlyList<JwtSetKey>>();

                    Asks.Add((asked, settle, signal));

                    return new ValueTask<IReadOnlyList<JwtSetKey>>(settle.Task);
                },
            };
        }

        public JwtKeySet KeySet { get; }

        public List<(string Issuer, TaskCompletionSource<IReadOnlyList<JwtSetKey>> Settle, CancellationToken Signal)> Asks { get; } = [];

        public List<string> Issuers()
        {
            return [.. Asks.Select((ask) =>
            {
                return ask.Issuer;
            })];
        }
    }
}
