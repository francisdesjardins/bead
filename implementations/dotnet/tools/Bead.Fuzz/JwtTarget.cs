using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes as a <c>JWT</c>'s token, one character an octet, as the header's reader hands a
/// <c>JWT</c> credential's bytes on in Latin-1, verified as section 13.8 states it, then read
/// unverified, as a relay that does not verify reads it. A token of three parts is verified again
/// with its first two signed by the HS256 key below, so a claims set the fuzzer changes reaches the
/// steps past the signature. The keys, the audiences and the clock are the JWT verdicts' of
/// spec/vectors.json, each well formed: every answer is a verdict, and any exception is a finding.
/// The TypeScript side's <c>tools/fuzz/jwt.ts</c> is its twin, with the same keys, audiences and
/// clock.
/// </summary>
internal sealed class JwtTarget : IFuzzTarget
{
    // ! the published test keys are read from spec/vectors.json, copied beside this build: no file
    // but spec/, the tests and the interop service writes one out
    private static readonly JsonElement[] VectorKeys = VectorKeysOf(Path.Combine(AppContext.BaseDirectory, "vectors.json"));

    private static readonly JsonElement Es256 = VectorKeyOf(("https://issuer.example", "ES256"));

    private static readonly JsonElement Hs256 = VectorKeyOf(("https://trust.example", "HS256"));

    // the HS256 key's secret, in base64url, as its JWK writes it
    private static readonly string Secret = Hs256.GetProperty("jwk").GetProperty("k").GetString()!;

    // the wall clock, 2026-10-03T12:01:00.000Z, in milliseconds since the epoch
    private const long Now = 1_791_028_860_000;

    // an ES256 key of one issuer, an HS256 key of another, and the HS256 key again under a kid
    private static readonly VerifyJwtProps Props = new()
    {
        Keys =
        [
            KeyOf((Es256, JwtAlgorithm.Es256), Es256.GetProperty("jwk").GetRawText()),
            KeyOf((Hs256, JwtAlgorithm.Hs256), Hs256.GetProperty("jwk").GetRawText()),
            KeyOf((Hs256, JwtAlgorithm.Hs256), $$"""{"kty":"oct","k":"{{Secret}}","kid":"k1"}"""),
        ],
        Audiences = ["https://bead.example", "https://other.example"],
        Now = () =>
        {
            return Now;
        },
    };

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "jwt";
        }
    }

    // helpers

    private static JwtKey KeyOf((JsonElement Vector, JwtAlgorithm Algorithm) key, string jwk)
    {
        using var document = JsonDocument.Parse(jwk);

        return new JwtKey { Issuer = key.Vector.GetProperty("issuer").GetString()!, Algorithm = key.Algorithm, Jwk = document.RootElement.Clone() };
    }

    // every key spec/vectors.json's JWT verdicts write
    private static JsonElement[] VectorKeysOf(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return [.. document.RootElement.GetProperty("jwtVerdicts").EnumerateArray().SelectMany((verdict) =>
        {
            return verdict.GetProperty("keys").EnumerateArray().Select((key) =>
            {
                return key.Clone();
            });
        })];
    }

    // the first key of an issuer under an algorithm and no kid, as the verdicts write it
    private static JsonElement VectorKeyOf((string Issuer, string Algorithm) wanted)
    {
        foreach (var key in VectorKeys)
        {
            if (key.GetProperty("issuer").GetString() == wanted.Issuer && key.GetProperty("algorithm").GetString() == wanted.Algorithm && !key.GetProperty("jwk").TryGetProperty("kid", out _))
            {
                return key;
            }
        }

        throw new InvalidOperationException($"spec/vectors.json holds no {wanted.Algorithm} key of {wanted.Issuer}");
    }

    // .NET's crypto being synchronous, the verdict is settled as the call returns
    private static void Verify(string token)
    {
        var verdict = JwtVerifier.VerifyJwt(token, Props);

        if (!verdict.IsCompletedSuccessfully)
        {
            throw new InvalidOperationException("a JWT's verdict is settled as its verification returns");
        }
    }

    // the parts' first two signed by the HS256 key, as an issuer of the trust domain signs them
    private static string SignedAgain(string[] parts)
    {
        var signingInput = $"{parts[0]}.{parts[1]}";
        var signature = HMACSHA256.HashData(Base64Url.DecodeFromChars(Secret), Encoding.Latin1.GetBytes(signingInput));

        return $"{signingInput}.{Base64Url.EncodeToString(signature)}";
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        var token = Encoding.Latin1.GetString(data);
        var parts = token.Split('.');

        Verify(token);
        JwtVerifier.ReadUnverified(token);

        if (parts.Length == 3)
        {
            Verify(SignedAgain(parts));
        }
    }
}
