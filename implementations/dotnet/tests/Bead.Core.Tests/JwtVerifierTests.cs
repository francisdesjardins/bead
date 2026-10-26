using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Bead.Tests;

/// <summary>
/// <see cref="JwtVerifier"/>: every vector of <c>jwtVerdicts</c>, then what throws, which no vector
/// holds.
/// </summary>
public sealed class JwtVerifierTests
{
    // constants

    // a vector that holds, whose HS256 key signs the tokens these tests write
    private const string Holding = "sub alone, named by sub";

    // 32 zero bytes, and 31, in base64url
    private static readonly string Bytes32 = new('A', 43);
    private static readonly string Bytes31 = new('A', 42);

    // keys not shaped for their algorithm, each by its JWK's JSON
    private static readonly Dictionary<string, (JwtAlgorithm Algorithm, string Jwk)> Unshaped = new()
    {
        ["an ES256 key whose kty is oct"] = (JwtAlgorithm.Es256, $$"""{"k":"{{Bytes32}}","kty":"oct"}"""),
        ["an ES256 key on P-384"] = (JwtAlgorithm.Es256, $$"""{"crv":"P-384","kty":"EC","x":"{{Bytes32}}","y":"{{Bytes32}}"}"""),
        ["an ES256 key whose x is 31 bytes"] =
            (JwtAlgorithm.Es256, $$"""{"crv":"P-256","kty":"EC","x":"{{Bytes31}}","y":"{{Bytes32}}"}"""),
        ["an ES256 key whose y is no base64url"] =
            (JwtAlgorithm.Es256, $$"""{"crv":"P-256","kty":"EC","x":"{{Bytes32}}","y":"y="}"""),
        ["an HS256 key whose kty is EC"] = (JwtAlgorithm.Hs256, $$"""{"crv":"P-256","kty":"EC","x":"{{Bytes32}}","y":"{{Bytes32}}"}"""),
        ["an HS256 key of 31 bytes"] = (JwtAlgorithm.Hs256, $$"""{"k":"{{Bytes31}}","kty":"oct"}"""),
        ["an HS256 key with no k"] = (JwtAlgorithm.Hs256, """{"kty":"oct"}"""),
        ["a key whose kid is a number"] = (JwtAlgorithm.Hs256, $$"""{"k":"{{Bytes32}}","kid":7,"kty":"oct"}"""),
        ["a key of an algorithm neither ES256 nor HS256"] = ((JwtAlgorithm)2, $$"""{"k":"{{Bytes32}}","kty":"oct"}"""),
        ["a JWK that is not an object"] = (JwtAlgorithm.Hs256, "[]"),
    };

    // helpers

    private static JsonElement ElementOf(string json)
    {
        using var document = JsonDocument.Parse(json);

        return document.RootElement.Clone();
    }

    private static List<JwtKey> KeysOf(JsonElement vector)
    {
        return vector.GetProperty("keys")
            .EnumerateArray()
            .Select((key) =>
            {
                return new JwtKey
                {
                    Issuer = key.GetProperty("issuer").GetString()!,
                    Algorithm = Enum.Parse<JwtAlgorithm>(key.GetProperty("algorithm").GetString()!, ignoreCase: true),
                    Jwk = key.GetProperty("jwk"),
                };
            })
            .ToList();
    }

    // the wall clock's reading an RFC 3339 instant gives, in milliseconds since the epoch
    private static long MillisecondsOf(JsonElement vector)
    {
        var instant = DateTimeOffset.Parse(
            vector.GetProperty("now").GetString()!,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);

        return instant.ToUnixTimeMilliseconds();
    }

    // the audience a vector gives, or its set, an array
    private static List<string> AudiencesOf(JsonElement vector)
    {
        var audience = vector.GetProperty("audience");

        return audience.ValueKind == JsonValueKind.Array
            ? [.. audience.EnumerateArray().Select((name) =>
            {
                return name.GetString()!;
            })]
            : [audience.GetString()!];
    }

    private static VerifyJwtProps PropsOf(JsonElement vector)
    {
        return new VerifyJwtProps
        {
            Keys = KeysOf(vector),
            Audiences = AudiencesOf(vector),
            Now = () =>
            {
                return MillisecondsOf(vector);
            },
        };
    }

    // a token of claims under the published HS256 key the vectors give its issuer
    private static string Signed(JsonObject claims)
    {
        var key = KeysOf(Vectors.Of("jwtVerdicts", Holding))[0];
        var part = (string json) =>
        {
            return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(json));
        };
        var signingInput = $$"""{{part("""{"alg":"HS256","typ":"at+jwt"}""")}}.{{part(claims.ToJsonString())}}""";
        var secret = Base64Url.DecodeFromChars(key.Jwk.GetProperty("k").GetString()!);

        return $"{signingInput}.{Base64Url.EncodeToString(HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(signingInput)))}";
    }

    // definition

    /// <summary>The names of every vector of the <c>jwtVerdicts</c> group.</summary>
    public static TheoryData<string> JwtVerdicts { get; } = Vectors.NamesOf("jwtVerdicts");

    /// <summary>The names of the keys a verifier refuses for their shape.</summary>
    public static TheoryData<string> UnshapedNames { get; } = new(Unshaped.Keys);

    [Theory]
    [MemberData(nameof(JwtVerdicts))]
    public async Task Gives_each_JWT_its_verdict(string name)
    {
        var vector = Vectors.Of("jwtVerdicts", name);
        var expected = vector.GetProperty("verdict");
        var verdict = await JwtVerifier.VerifyJwt(vector.GetProperty("token").GetString()!, PropsOf(vector));

        Assert.Equal(expected.GetProperty("holds").GetBoolean(), verdict.Holds);

        if (!verdict.Holds)
        {
            Assert.Equal(Enum.Parse<JwtRefusal>(expected.GetProperty("reason").GetString()!, ignoreCase: true), verdict.Reason);

            return;
        }

        var identifier = expected.GetProperty("identifier");
        var named = (string claim) =>
        {
            return identifier.TryGetProperty(claim, out var value) ? value.GetString() : null;
        };

        Assert.Equal(
            new JwtSessionIdentifier { Issuer = identifier.GetProperty("issuer").GetString()!, Sid = named("sid"), Sub = named("sub") },
            verdict.Identifier);
        Assert.True(JsonElement.DeepEquals(expected.GetProperty("claims"), verdict.Claims), verdict.Claims.GetRawText());
        Assert.Equal(expected.GetProperty("end").GetInt64(), verdict.End);
    }

    [Fact]
    public async Task Throws_for_a_key_without_a_string_issuer_before_reading_the_clock()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var token = vector.GetProperty("token").GetString()!;
        var keys = KeysOf(vector);
        var key = keys[0] with { Issuer = null! };
        var reads = 0;
        var props = PropsOf(vector) with
        {
            Keys = [.. keys, key],
            Now = () =>
            {
                reads += 1;

                return MillisecondsOf(vector);
            },
        };

        foreach (var presented in new[] { "", token })
        {
            await Assert.ThrowsAsync<ArgumentException>(async () =>
            {
                await JwtVerifier.VerifyJwt(presented, props);
            });
            Assert.Equal(0, reads);
        }

        Assert.True((await JwtVerifier.VerifyJwt(token, props with { Keys = keys })).Holds);
        Assert.Equal(1, reads);
    }

    [Fact]
    public async Task Refuses_an_HS256_signature_of_the_wrong_byte_length_before_reading_the_clock()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var token = vector.GetProperty("token").GetString()!;
        var parts = token.Split('.');
        var signature = Base64Url.DecodeFromChars(parts[2]);
        var reads = 0;
        var props = PropsOf(vector) with
        {
            Now = () =>
            {
                reads += 1;

                return MillisecondsOf(vector);
            },
        };

        Assert.Equal(32, signature.Length);

        foreach (var length in new[] { 31, 33 })
        {
            var bytes = new byte[length];

            signature.AsSpan(0, Math.Min(length, signature.Length)).CopyTo(bytes);

            var malformed = $"{parts[0]}.{parts[1]}.{Base64Url.EncodeToString(bytes)}";
            var refused = await JwtVerifier.VerifyJwt(malformed, props);

            Assert.False(refused.Holds);
            Assert.Equal(JwtRefusal.Signature, refused.Reason);
            Assert.Equal(0, reads);
        }

        Assert.True((await JwtVerifier.VerifyJwt(token, props)).Holds);
        Assert.Equal(1, reads);
    }

    [Fact]
    public void Reads_unverified_JWTs_only_when_all_three_parts_decode()
    {
        var parts = Vectors.Of("jwtVerdicts", Holding).GetProperty("token").GetString()!.Split('.');
        var header = parts[0];
        var claims = parts[1];
        var encode = (string text) =>
        {
            return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));
        };

        foreach (var token in new[]
        {
            "",
            "a.b",
            $"{header}.{claims}.AA.extra",
            $"{encode("[]")}.{claims}.AA",
            $"{encode("no JSON")}.{claims}.AA",
            $"{header}.{encode("[]")}.AA",
            $"{header}.{encode("no JSON")}.AA",
            $"{header}.{claims}.*",
        })
        {
            Assert.Null(JwtVerifier.ReadUnverified(token));
        }

        // * a one-byte signature is readable here: only the verifier judges its signature.
        var read = JwtVerifier.ReadUnverified($"{header}.{claims}.AA");

        Assert.NotNull(read);
        Assert.True(JsonElement.DeepEquals(ElementOf(Encoding.UTF8.GetString(Base64Url.DecodeFromChars(header))), read.Value.Header));
        Assert.True(JsonElement.DeepEquals(ElementOf(Encoding.UTF8.GetString(Base64Url.DecodeFromChars(claims))), read.Value.Claims));
    }

    [Fact]
    public async Task Gives_the_claims_set_of_a_token_that_holds_whole_past_its_document()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var token = vector.GetProperty("token").GetString()!;
        var claims = JsonNode.Parse(Base64Url.DecodeFromChars(token.Split('.')[1]))!.AsObject();

        claims["realm"] = new JsonObject { ["roles"] = new JsonArray("reader") };

        var verdict = await JwtVerifier.VerifyJwt(Signed(claims), PropsOf(vector));

        Assert.True(verdict.Holds, $"the token does not hold: {verdict.Reason}");
        Assert.True(JsonElement.DeepEquals(ElementOf(claims.ToJsonString()), verdict.Claims), verdict.Claims.GetRawText());
        Assert.Equal("reader", verdict.Claims.GetProperty("realm").GetProperty("roles")[0].GetString());
    }

    [Fact]
    public async Task Reads_the_wall_clock_once_the_signature_verifies_so_a_verification_that_waits_past_a_token_s_end_refuses_it_at_exp()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var token = vector.GetProperty("token").GetString()!;
        var end = vector.GetProperty("verdict").GetProperty("end").GetInt64();
        var reads = 0;

        // .NET's crypto waits for nothing: the reading taken as the signature verified stands for
        // a wall clock that went past the token's end meanwhile
        var props = PropsOf(vector) with
        {
            Now = () =>
            {
                reads += 1;

                return end;
            },
        };

        Assert.Equal((JwtRefusal.Exp, 1), ((await JwtVerifier.VerifyJwt(token, props)).Reason, reads));

        // one refused before its signature verified reads none
        var forged = $"{token[..token.LastIndexOf('.')]}.{new string('A', 43)}";

        Assert.Equal((JwtRefusal.Signature, 1), ((await JwtVerifier.VerifyJwt(forged, props)).Reason, reads));
    }

    [Theory]
    [MemberData(nameof(UnshapedNames))]
    public async Task Throws_for_a_key_not_shaped_for_its_algorithm_whatever_the_token(string name)
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var (algorithm, jwk) = Unshaped[name];
        var key = new JwtKey { Issuer = "https://issuer.example", Algorithm = algorithm, Jwk = ElementOf(jwk) };
        var props = PropsOf(vector) with
        {
            Keys = [.. KeysOf(vector), key],
            Now = () =>
            {
                return 0;
            },
        };

        await Assert.ThrowsAsync<ArgumentException>(async () =>
        {
            await JwtVerifier.VerifyJwt("", props);
        });
    }

    [Fact]
    public async Task Refuses_at_key_a_key_whose_key_ops_holds_verify_with_a_lone_surrogate()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var key = KeysOf(vector)[0];

        // the escape reaches the JWK through its JSON text alone, as a key set's answer brings it
        var jwk = ElementOf($$"""{"k":"{{key.Jwk.GetProperty("k").GetString()}}","key_ops":["verify\ud800"],"kty":"oct"}""");
        var props = PropsOf(vector) with { Keys = [key with { Jwk = jwk }] };

        var verdict = await JwtVerifier.VerifyJwt(vector.GetProperty("token").GetString()!, props);

        Assert.Equal<(bool, JwtRefusal?)>((false, JwtRefusal.Key), (verdict.Holds, verdict.Reason));
    }

    [Fact]
    public async Task Refuses_at_crit_a_token_whose_header_names_crit_with_an_escape_whatever_a_token_of_its_shape_held_before()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var parts = vector.GetProperty("token").GetString()!.Split('.');

        // * the TypeScript twin's shape, its first name drawn for this run
        var first = $"onTheLedge{Convert.ToHexString(RandomNumberGenerator.GetBytes(8))}";
        var headed = (string header) =>
        {
            return $"{Base64Url.EncodeToString(Encoding.UTF8.GetBytes(header))}.{parts[1]}.{parts[2]}";
        };

        // V8's JSON.parse can read the second header's last name as the first's, each of four
        // characters once read, the first holding a backslash
        await JwtVerifier.VerifyJwt(headed($$"""{"{{first}}":0,"alg":"HS256","typ":"at+jwt","\\u00":1}"""), PropsOf(vector));

        var verdict = await JwtVerifier.VerifyJwt(headed($$"""{"{{first}}":0,"alg":"HS256","typ":"at+jwt","\u0063rit":["exp"]}"""), PropsOf(vector));

        Assert.Equal<(bool, JwtRefusal?)>((false, JwtRefusal.Crit), (verdict.Holds, verdict.Reason));
    }

    [Fact]
    public async Task Throws_for_an_audience_that_is_not_well_formed_Unicode()
    {
        var vector = Vectors.Of("jwtVerdicts", Holding);
        var props = PropsOf(vector) with { Audiences = ["\ud800"] };

        await Assert.ThrowsAsync<ArgumentException>(async () =>
        {
            await JwtVerifier.VerifyJwt(vector.GetProperty("token").GetString()!, props);
        });
    }
}
