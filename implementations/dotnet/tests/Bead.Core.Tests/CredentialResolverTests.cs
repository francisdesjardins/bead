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

    // a resolver of a recording key set for the issuer and the set's issuer, letting `maximum`
    // calls wait for one issuer's keys, on a clock
    private static CredentialResolver BoundedOf((RecordingKeySet KeySet, int Maximum) bounded, TimeProvider clock)
    {
        return ResolverOf(
            new Credentials { Audience = Audience, KeySet = bounded.KeySet.KeySet with { MaximumWaitingCalls = bounded.Maximum } },
            clock);
    }

    // what a request presenting a credential resolves to, on a signal of the test's
    private static Task<CallSession?> ResolvedOn((CredentialResolver Resolver, Credential Credential) asked, CancellationToken signal)
    {
        return asked.Resolver.Resolve(RequestOf(asked.Credential), signal).AsTask();
    }

    // the failure a call refused as it would wait past its bound is answered with
    private static async Task<Failure> RefusalOf(Task<CallSession?> resolving)
    {
        return (await Assert.ThrowsAsync<RefusalException>(() =>
        {
            return resolving.WaitAsync(Patience, Cancelled);
        })).Failure;
    }

    // whether each of `calls` still waits
    private static void AssertWaiting(IEnumerable<Task<CallSession?>> calls)
    {
        Assert.All(calls, (call) =>
        {
            Assert.False(call.IsCompleted);
        });
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
    public async Task Has_a_token_without_a_kid_wait_on_its_issuer_s_keys_at_a_cold_start_and_counts_the_keys_held_toward_its_issuer_s_one_key()
    {
        var clock = new FakeTimeProvider(Start);
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = AnsweringOf(SetKeyOf((First, "first"))) }, clock);
        var key = new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((Second, "second")) };
        var twoKeyed = ResolverOf(new Credentials { Audience = Audience, Keys = [key], KeySet = AnsweringOf(SetKeyOf((First, "first"))) }, clock);

        // none of its issuer's keys serving yet, a kid-less token asks, and finds the one key the
        // set answered, which then serves a token without a kid, or with its kid, asking nothing
        Assert.NotNull(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null))))));
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
    public async Task Judges_a_token_again_when_its_key_comes_to_serve_during_its_first_judgment_never_answering_the_refusal_it_had_before()
    {
        var clock = new ReadingClock();
        var keySet = new RecordingKeySet(SetIssuer);

        // set-1 names the application's key of another issuer too: a token of the key set's issuer
        // naming it verifies by that key, and is refused at its iss while its own does not serve
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((Second, "set-1")) }],
                KeySet = keySet.KeySet,
            },
            clock);
        var named = Credential.Jwt(TokenOf((Second, "set-1"), SetIssuer));
        var first = ResolvedOf((resolver, named));

        Assert.Single(keySet.Asks);

        // the answer naming set-1 settles as the next is judged: its key serves once it is refused,
        // and it is judged again by the keys that serve
        clock.OnRead = () =>
        {
            keySet.Asks[0].Settle.SetResult([SetKeyOf((Second, "set-1"))]);
        };

        var again = await ResolvedOf((resolver, named));

        Assert.Equal((SetIssuer, "grace"), (again!.Identifier!.Issuer, again.Identifier.Sub));
        Assert.Equal(SetIssuer, (await first)!.Identifier!.Issuer);
        Assert.Null(clock.OnRead);
        Assert.Single(keySet.Asks);
    }

    [Fact]
    public void Refuses_as_it_is_built_a_key_set_whose_maximumWaitingCalls_is_not_a_whole_number_from_1_to_2147483647_and_takes_either_bound()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = AnsweringOf();

        // ! an int holds no fraction, nothing past 2³¹ − 1, and no NaN: what is left is under 1
        foreach (var maximum in new[] { 0, -1, int.MinValue })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() =>
            {
                return ResolverOf(new Credentials { Audience = Audience, KeySet = keySet with { MaximumWaitingCalls = maximum } }, clock);
            });
        }

        // from one to 2³¹ − 1, and 64 when not given
        foreach (var maximum in new[] { 1, int.MaxValue })
        {
            ResolverOf(new Credentials { Audience = Audience, KeySet = keySet with { MaximumWaitingCalls = maximum } }, clock);
        }

        Assert.Equal(64, keySet.MaximumWaitingCalls);
    }

    [Fact]
    public async Task Lets_as_many_calls_wait_for_an_issuer_s_deadline_as_maximumWaitingCalls_says_64_when_not_given_and_refuses_one_more_CAPACITY_EXCEEDED_at_once_asking_nothing_more()
    {
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));

        foreach (var (maximum, given) in new (int, int?)[] { (64, null), (3, 3) })
        {
            var clock = new FakeTimeProvider(Start);
            var keySet = new RecordingKeySet();
            var resolver = given is { } bound ? BoundedOf((keySet, bound), clock) : ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
            var first = ResolvedOn((resolver, Credential.Jwt(TokenOf((First, "first")))), Cancelled);

            keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
            Assert.NotNull(await first.WaitAsync(Patience, Cancelled));

            var waiting = Enumerable.Range(0, maximum).Select((_) =>
            {
                return ResolvedOn((resolver, unnamed), Cancelled);
            }).ToList();

            AssertWaiting(waiting);

            var refused = await RefusalOf(ResolvedOn((resolver, unnamed), Cancelled));

            Assert.Equal(
                (FailureScope.Protocol, (ushort)ProtocolCode.CapacityExceeded, $"as many calls as its key set lets wait for the deadline of {Issuer} wait already"),
                (refused.Scope, refused.Code, refused.Detail));
            Assert.Single(keySet.Asks);

            // the ask at the deadline names "second": those that waited are verified
            clock.Advance(TimeSpan.FromMinutes(1));
            Assert.Equal(2, keySet.Asks.Count);
            keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first")), SetKeyOf((Second, "second"))]);
            Assert.All(await Task.WhenAll(waiting).WaitAsync(Patience, Cancelled), Assert.NotNull);
        }
    }

    [Fact]
    public async Task Lets_every_call_that_waits_on_an_ask_under_way_wait_however_many_65_valid_tokens_at_a_cold_start_and_65_at_the_ten_minute_mark_all_verified()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();

        // 64 wait for a deadline at most, the key set saying nothing
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var named = Credential.Jwt(TokenOf((First, "first")));

        // at a cold start, then once the keys held are past their ten minutes: no key serves, and
        // every call waits on the one ask the first sets off, none refused
        foreach (var (asks, held) in new[] { (1, TimeSpan.Zero), (2, TimeSpan.FromMinutes(10)) })
        {
            clock.Advance(held);

            var waiting = Enumerable.Range(0, 65).Select((_) =>
            {
                return ResolvedOn((resolver, named), Cancelled);
            }).ToList();

            AssertWaiting(waiting);
            Assert.Equal(asks, keySet.Asks.Count);
            keySet.Asks[^1].Settle.SetResult([SetKeyOf((First, "first"))]);
            Assert.All(await Task.WhenAll(waiting).WaitAsync(Patience, Cancelled), (session) =>
            {
                Assert.Equal("grace", session?.Identifier?.Sub);
            });
        }
    }

    [Fact]
    public async Task Refuses_CAPACITY_EXCEEDED_a_call_an_answer_moves_onto_a_deadline_that_holds_as_many_as_its_key_set_lets_wait()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = BoundedOf((keySet, 2), clock);
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));

        // the ask goes for a kid it names; three kids none names come while it is under way, which
        // went before they came, and wait on it, uncounted
        var first = ResolvedOn((resolver, Credential.Jwt(TokenOf((First, "first")))), Cancelled);
        var moved = new[] { ResolvedOn((resolver, unnamed), Cancelled), ResolvedOn((resolver, unnamed), Cancelled) };
        var refusing = ResolvedOn((resolver, unnamed), Cancelled);

        AssertWaiting([.. moved, refusing]);

        // its answer names no "second": the first two it moves onto the deadline take its places, and
        // the third is refused as it moves
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await first.WaitAsync(Patience, Cancelled))!.Identifier!.Sub);

        var refused = await RefusalOf(refusing);

        Assert.Equal(
            ((ushort)ProtocolCode.CapacityExceeded, $"as many calls as its key set lets wait for the deadline of {Issuer} wait already"),
            (refused.Code, refused.Detail));
        AssertWaiting(moved);
        Assert.Single(keySet.Asks);

        // at the deadline the two wait on the ask then, whose answer names "second"
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first")), SetKeyOf((Second, "second"))]);
        Assert.All(await Task.WhenAll(moved).WaitAsync(Patience, Cancelled), Assert.NotNull);
    }

    [Fact]
    public async Task Gives_a_call_a_place_as_an_answer_moves_it_from_its_issuer_s_ask_onto_the_deadline_refusing_one_that_comes_past_the_bound_then_and_frees_it_as_the_call_leaves()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = BoundedOf((keySet, 1), clock);
        var named = Credential.Jwt(TokenOf((First, "first")));
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));

        using var leaving = new CancellationTokenSource();
        using var moving = new CancellationTokenSource();

        // an ask under way that its one call left, which a token comes to find: it went before, and
        // the token waits on it
        var left = ResolvedOn((resolver, named), leaving.Token);

        await leaving.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return left.WaitAsync(Patience, Cancelled);
        });

        var moved = ResolvedOn((resolver, unnamed), moving.Token);

        // its answer names no "second": it moves onto the deadline, taking its one place, and the
        // next that comes is refused
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.False(moved.IsCompleted);
        await RefusalOf(ResolvedOn((resolver, unnamed), Cancelled));

        // it leaves, and frees its place for the next, which the ask at the deadline judges
        await moving.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return moved.WaitAsync(Patience, Cancelled);
        });

        var next = ResolvedOn((resolver, unnamed), Cancelled);

        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first")), SetKeyOf((Second, "second"))]);
        Assert.Equal("grace", (await next.WaitAsync(Patience, Cancelled))!.Identifier!.Sub);
    }

    [Fact]
    public async Task Counts_the_calls_that_wait_for_each_issuer_s_deadline_apart()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet(Issuer, SetIssuer);
        var resolver = BoundedOf((keySet, 1), clock);
        string[] issuers = [Issuer, SetIssuer];

        // each issuer's keys held, from an ask of its own
        var held = issuers.Select((issuer) =>
        {
            return ResolvedOn((resolver, Credential.Jwt(TokenOf((First, "first"), issuer))), Cancelled);
        }).ToList();

        Assert.Equal([Issuer, SetIssuer], keySet.Issuers());
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.All(await Task.WhenAll(held).WaitAsync(Patience, Cancelled), Assert.NotNull);

        // one of each waits for its issuer's deadline, whatever the other's holds; one more of each
        // is refused
        var waiting = issuers.Select((issuer) =>
        {
            return ResolvedOn((resolver, Credential.Jwt(TokenOf((Second, "second"), issuer))), Cancelled);
        }).ToList();

        AssertWaiting(waiting);

        foreach (var issuer in issuers)
        {
            await RefusalOf(ResolvedOn((resolver, Credential.Jwt(TokenOf((Second, "second"), issuer))), Cancelled));
        }

        // at the deadlines, each issuer's ask names "second"
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(4, keySet.Asks.Count);

        foreach (var (_, settle, _) in keySet.Asks.Skip(2))
        {
            settle.SetResult([SetKeyOf((First, "first")), SetKeyOf((Second, "second"))]);
        }

        Assert.All(await Task.WhenAll(waiting).WaitAsync(Patience, Cancelled), Assert.NotNull);
    }

    [Fact]
    public async Task Lets_a_call_that_comes_past_a_deadline_its_timer_has_yet_to_reach_for_which_as_many_calls_wait_as_the_key_set_lets_let_the_ask_go_for_them_and_wait_on_it_with_them_never_refused()
    {
        var clock = new LateClock();
        var keySet = new RecordingKeySet();
        var resolver = BoundedOf((keySet, 2), clock);
        var named = Credential.Jwt(TokenOf((First, "first")));
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));
        var first = ResolvedOn((resolver, named), Cancelled);

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.NotNull(await first.WaitAsync(Patience, Cancelled));

        // two wait for the deadline, the third refused
        var waiting = new[] { ResolvedOn((resolver, unnamed), Cancelled), ResolvedOn((resolver, unnamed), Cancelled) };

        await RefusalOf(ResolvedOn((resolver, unnamed), Cancelled));

        // past the deadline, its timer yet to fire: the call that comes reaches it, lets the ask go
        // for the two, and waits on it with them, uncounted
        clock.Reading = 60_000;

        var coming = ResolvedOn((resolver, unnamed), Cancelled);

        Assert.Equal(2, keySet.Asks.Count);
        AssertWaiting([.. waiting, coming]);

        // the late timer does nothing more
        clock.Timers[0].Fire();
        Assert.Equal(2, keySet.Asks.Count);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first")), SetKeyOf((Second, "second"))]);
        Assert.All(await Task.WhenAll(waiting.Append(coming)).WaitAsync(Patience, Cancelled), Assert.NotNull);
    }

    [Fact]
    public async Task Drops_an_answer_that_comes_as_the_reading_reaches_its_ask_s_deadline_its_timer_yet_to_fire_the_calls_that_wait_on_it_fail_nothing_is_held_and_the_late_timer_does_nothing_more()
    {
        var clock = new LateClock();
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var token = Credential.Jwt(TokenOf((First, "first")));
        var late = ResolvedOn((resolver, token), Cancelled);

        clock.Reading = 60_000;
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Contains("key set", (await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return late.WaitAsync(Patience, Cancelled);
        })).Message, StringComparison.Ordinal);
        Assert.True(keySet.Asks[0].Signal.IsCancellationRequested);

        // nothing held: a token of that kid asks anew; the late timer does nothing more
        var again = ResolvedOn((resolver, token), Cancelled);

        Assert.Equal(2, keySet.Asks.Count);
        clock.Timers[0].Fire();
        Assert.Equal(2, keySet.Asks.Count);
        Assert.False(again.IsCompleted);
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await again.WaitAsync(Patience, Cancelled))!.Identifier!.Sub);
    }

    [Fact]
    public async Task Fails_an_ask_still_unsettled_as_a_call_comes_past_its_deadline_its_timer_yet_to_fire_aborting_its_signal_and_judges_that_call_by_a_new_ask_with_a_live_signal_the_late_timer_does_nothing_more()
    {
        var clock = new LateClock();
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var token = Credential.Jwt(TokenOf((First, "first")));
        var stalled = ResolvedOn((resolver, token), Cancelled);

        clock.Reading = 60_000;

        var coming = ResolvedOn((resolver, token), Cancelled);

        // the first ask failed as the call came, its signal aborted; the next went, its own live
        Assert.Contains("key set", (await Assert.ThrowsAnyAsync<Exception>(() =>
        {
            return stalled.WaitAsync(Patience, Cancelled);
        })).Message, StringComparison.Ordinal);
        Assert.True(keySet.Asks[0].Signal.IsCancellationRequested);
        Assert.Equal(2, keySet.Asks.Count);
        Assert.False(keySet.Asks[1].Signal.IsCancellationRequested);

        // the late timer, and what the first ask settles to now, do nothing more
        clock.Timers[0].Fire();
        keySet.Asks[0].Settle.SetResult([SetKeyOf((Second, "first"))]);
        Assert.Equal(2, keySet.Asks.Count);
        Assert.False(keySet.Asks[1].Signal.IsCancellationRequested);
        Assert.False(coming.IsCompleted);

        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await coming.WaitAsync(Patience, Cancelled))!.Identifier!.Sub);
    }

    [Fact]
    public async Task Lets_the_deadline_s_ask_go_as_a_call_comes_past_it_its_timer_yet_to_fire_and_refuses_that_call_at_once_once_that_ask_s_answer_does_not_name_its_kid_the_late_timer_does_nothing_more()
    {
        var clock = new LateClock();
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var named = Credential.Jwt(TokenOf((First, "first")));
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));
        var first = ResolvedOn((resolver, named), Cancelled);

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.NotNull(await first.WaitAsync(Patience, Cancelled));
        clock.Reading = 1_000;

        var waiting = ResolvedOn((resolver, unnamed), Cancelled);

        // its coming reaches the deadline: the ask goes then, after it came, for it as for the call
        // that waited
        clock.Reading = 60_000;

        var coming = ResolvedOn((resolver, unnamed), Cancelled);

        Assert.Equal(2, keySet.Asks.Count);
        AssertWaiting([waiting, coming]);

        // a kid its answer does not name is refused then, never held another minute
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Null(await coming.WaitAsync(Patience, Cancelled));
        Assert.Null(await waiting.WaitAsync(Patience, Cancelled));

        // the late timer does nothing more
        clock.Timers[0].Fire();
        Assert.Equal(2, keySet.Asks.Count);
    }

    [Fact]
    public async Task Lets_no_ask_go_as_the_last_call_that_waits_for_a_deadline_leaves_past_it_its_timer_yet_to_fire_then_or_as_the_timer_fires()
    {
        var clock = new LateClock();
        var keySet = new RecordingKeySet();
        var resolver = ResolverOf(new Credentials { Audience = Audience, KeySet = keySet.KeySet }, clock);
        var first = ResolvedOn((resolver, Credential.Jwt(TokenOf((First, "first")))), Cancelled);

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.NotNull(await first.WaitAsync(Patience, Cancelled));

        using var leaving = new CancellationTokenSource();

        var left = ResolvedOn((resolver, Credential.Jwt(TokenOf((Second, "second")))), leaving.Token);

        // a timer that fires before the reading reaches its deadline is armed again for the rest
        clock.Reading = 59_999;
        clock.Timers[0].Fire();
        Assert.Equal(TimeSpan.FromMilliseconds(1), clock.Timers[0].Due);
        Assert.False(left.IsCompleted);
        Assert.Single(keySet.Asks);

        // a leave reads nothing of its issuer's state, and reaches no deadline
        clock.Reading = 60_000;
        await leaving.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        {
            return left.WaitAsync(Patience, Cancelled);
        });
        Assert.Single(keySet.Asks);

        clock.Timers[0].Fire();
        Assert.Single(keySet.Asks);
    }

    [Fact]
    public async Task Has_a_token_without_a_kid_wait_for_nothing_when_its_issuer_has_a_key_of_the_application_s_and_for_the_deadline_and_the_ask_then_after_an_answer_that_gave_its_issuer_none()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet(Issuer, SetIssuer);
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = Issuer, Jwk = JwkOf((First, null)) }],
                KeySet = keySet.KeySet,
            },
            clock);

        // a key of its issuer's serves: verified, or refused, at once, asking nothing
        Assert.Equal("grace", (await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null))))))!.Identifier!.Sub);
        Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((Second, null))))));
        Assert.Empty(keySet.Asks);

        // of the other issuer, at a cold start it asks, and is judged by that answer, which gives
        // no key
        var kidless = Credential.Jwt(TokenOf((First, null), SetIssuer));
        var cold = ResolvedOn((resolver, kidless), Cancelled);

        Assert.Single(keySet.Asks);
        keySet.Asks[0].Settle.SetResult([]);
        Assert.Null(await cold.WaitAsync(Patience, Cancelled));

        // none of its issuer's keys serving, the next waits for the deadline, never refused at once
        var next = ResolvedOn((resolver, kidless), Cancelled);

        clock.Advance(TimeSpan.FromMilliseconds(59_999));
        Assert.False(next.IsCompleted);
        Assert.Single(keySet.Asks);
        clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal([SetIssuer, SetIssuer], keySet.Issuers());
        keySet.Asks[1].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.Equal("grace", (await next.WaitAsync(Patience, Cancelled))!.Identifier!.Sub);
    }

    [Fact]
    public async Task Takes_the_application_s_copy_of_a_key_its_key_set_answers_again_beside_another_under_its_kid_and_refuses_a_token_without_a_kid_there()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet(SetIssuer);
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = SetIssuer, Jwk = JwkOf((First, "app-1")) }],
                KeySet = keySet.KeySet,
            },
            clock);
        var asking = ResolvedOf((resolver, Credential.Jwt(TokenOf((Second, "set-1"), SetIssuer))));

        // the application's key again, under its kid, which does not serve, beside a key of another
        // material
        var again = JsonSerializer.SerializeToElement(new Dictionary<string, string>
        {
            ["k"] = Base64Url.EncodeToString(First),
            ["kid"] = "app-1",
            ["kty"] = "oct",
            ["use"] = "enc",
        });

        Assert.Single(keySet.Asks);
        keySet.Asks[0].Settle.SetResult([new JwtSetKey { Algorithm = JwtAlgorithm.Hs256, Jwk = again }, SetKeyOf((Second, "set-1"))]);
        Assert.NotNull(await asking);

        // one material under app-1: the application's copy, which serves, taken first
        Assert.Equal("grace", (await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, "app-1"), SetIssuer)))))!.Identifier!.Sub);

        // two materials for its issuer: a token without a kid is refused at once, asking nothing
        Assert.Null(await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, null), SetIssuer)))));
        Assert.Single(keySet.Asks);
    }

    [Fact]
    public async Task Takes_a_token_without_a_kid_once_its_key_set_answers_the_application_s_key_alone_again_under_another_kid()
    {
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet(SetIssuer);
        var resolver = ResolverOf(
            new Credentials
            {
                Audience = Audience,
                Keys = [new JwtKey { Algorithm = JwtAlgorithm.Hs256, Issuer = SetIssuer, Jwk = JwkOf((First, "app-1")) }],
                KeySet = keySet.KeySet,
            },
            clock);
        var asking = ResolvedOf((resolver, Credential.Jwt(TokenOf((First, "app-2"), SetIssuer))));

        Assert.Single(keySet.Asks);
        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "app-2"))]);
        Assert.NotNull(await asking);

        // one material for its issuer, under two kids: each token finds it, one without a kid too
        foreach (var kid in new[] { "app-1", "app-2", null })
        {
            Assert.Equal("grace", (await ResolvedOf((resolver, Credential.Jwt(TokenOf((First, kid), SetIssuer)))))!.Identifier!.Sub);
        }

        Assert.Single(keySet.Asks);
    }

    [Fact]
    public async Task Frees_the_place_of_each_call_that_leaves_its_wait_10000_that_leave_as_their_connection_closes_wait_again_none_refused_and_no_ask_goes_at_a_deadline_none_waits_for()
    {
        const int Many = 10_000;
        var clock = new FakeTimeProvider(Start);
        var keySet = new RecordingKeySet();
        var resolver = BoundedOf((keySet, Many), clock);
        var unnamed = Credential.Jwt(TokenOf((Second, "second")));
        var first = ResolvedOn((resolver, Credential.Jwt(TokenOf((First, "first")))), Cancelled);

        keySet.Asks[0].Settle.SetResult([SetKeyOf((First, "first"))]);
        Assert.NotNull(await first.WaitAsync(Patience, Cancelled));

        // the bound's worth twice, a round at a time, their connection closing on them: the second
        // round finds every place free
        for (var round = 0; round < 2; round += 1)
        {
            using var connection = new CancellationTokenSource();

            var waiting = Enumerable.Range(0, Many).Select((_) =>
            {
                return ResolvedOn((resolver, unnamed), connection.Token);
            }).ToList();

            AssertWaiting(waiting);
            await connection.CancelAsync();

            foreach (var left in waiting)
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                {
                    return left.WaitAsync(Patience, Cancelled);
                });
            }
        }

        clock.Advance(TimeSpan.FromMinutes(1));
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

    // a key set for its issuers, the issuer when none is given, that records each ask, its issuer
    // and its signal, and answers as each is settled
    private sealed class RecordingKeySet
    {
        public RecordingKeySet(params string[] issuers)
        {
            KeySet = new JwtKeySet
            {
                Issuers = issuers.Length > 0 ? issuers : [Issuer],
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

    // a clock whose monotonic reading, in milliseconds, the test moves as it likes, past a due
    // without its timer firing, and whose timers fire as the test fires them, late, or once
    // disposed, as a timer's callback already on its way does; its wall reading stays at the start
    private sealed class LateClock : TimeProvider
    {
        public long Reading { get; set; }

        public List<LateTimer> Timers { get; } = [];

        public override long TimestampFrequency
        {
            get
            {
                return 1_000;
            }
        }

        public override long GetTimestamp()
        {
            return Reading;
        }

        public override DateTimeOffset GetUtcNow()
        {
            return Start;
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new LateTimer(callback, state);

            Timers.Add(timer);

            return timer;
        }
    }

    // a clock at the start whose wall clock runs what the test gives it as it is next read, once: as
    // a token's signature has verified, its first judgment under way
    private sealed class ReadingClock : TimeProvider
    {
        private readonly FakeTimeProvider _clock = new(Start);

        public Action? OnRead { get; set; }

        public override long TimestampFrequency
        {
            get
            {
                return _clock.TimestampFrequency;
            }
        }

        public override long GetTimestamp()
        {
            return _clock.GetTimestamp();
        }

        public override DateTimeOffset GetUtcNow()
        {
            var read = OnRead;

            OnRead = null;
            read?.Invoke();

            return _clock.GetUtcNow();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            return _clock.CreateTimer(callback, state, dueTime, period);
        }
    }

    // a timer of the late clock, which fires as the test fires it, whatever it was told: the due it
    // was last armed again for, when it was
    private sealed class LateTimer(TimerCallback callback, object? state) : ITimer
    {
        public bool IsDisposed { get; private set; }

        public TimeSpan? Due { get; private set; }

        public void Fire()
        {
            callback(state);
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            Due = dueTime;

            return !IsDisposed;
        }

        public void Dispose()
        {
            IsDisposed = true;
        }

        public ValueTask DisposeAsync()
        {
            Dispose();

            return ValueTask.CompletedTask;
        }
    }
}
