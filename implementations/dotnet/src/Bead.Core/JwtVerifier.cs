using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Unicode;

namespace Bead;

/// <summary>
/// The algorithms a <c>JWT</c>'s key verifies with, one a key, which the application names
/// (RFC 8725 §3.1).
/// </summary>
internal enum JwtAlgorithm
{
    /// <summary>ECDSA on P-256 with SHA-256 (RFC 7518 §3.4), for keys a federation shares by their public half.</summary>
    Es256,

    /// <summary>HMAC with SHA-256 (RFC 7518 §3.2), for one trust domain.</summary>
    Hs256,
}

/// <summary>Why a <c>JWT</c> does not hold: the step of section 13.8 that refused it, in their order.</summary>
internal enum JwtRefusal
{
    /// <summary>Not three parts of base64url whose header and claims set are JSON objects.</summary>
    Token,

    /// <summary>A header that carries <c>crit</c>.</summary>
    Crit,

    /// <summary>A <c>typ</c> that is not an access token's (RFC 9068 §4).</summary>
    Typ,

    /// <summary>No key found among the keys alone.</summary>
    Kid,

    /// <summary>An <c>alg</c> that is not its key's algorithm.</summary>
    Alg,

    /// <summary>A key whose JWK does not serve to verify, by its <c>alg</c>, <c>use</c> or <c>key_ops</c>.</summary>
    Key,

    /// <summary>A signature that does not verify.</summary>
    Signature,

    /// <summary>An <c>iss</c> that is not its key's issuer.</summary>
    Iss,

    /// <summary>An <c>exp</c> absent, not a JSON number whose end every side holds exactly, or past, its leeway counted.</summary>
    Exp,

    /// <summary>An <c>nbf</c> not a JSON number whose milliseconds every side holds exactly, or to come, its leeway counted.</summary>
    Nbf,

    /// <summary>An <c>aud</c> that does not name the audience.</summary>
    Aud,

    /// <summary>A <c>sid</c> that is not a string.</summary>
    Sid,

    /// <summary>Without a <c>sid</c>, a <c>sub</c> that is not a string.</summary>
    Sub,
}

/// <summary>
/// A key a <c>JWT</c> is verified with: a JWK (RFC 7517), the issuer whose tokens it signs, and its
/// one algorithm, which the application names (RFC 8725 §3.1).
/// </summary>
internal sealed record JwtKey
{
    /// <summary>The issuer whose tokens the key signs, compared to their <c>iss</c> octet for octet.</summary>
    public required string Issuer { get; init; }

    /// <summary>The key's one algorithm.</summary>
    public required JwtAlgorithm Algorithm { get; init; }

    /// <summary>The key, a JWK, as a key set writes it.</summary>
    public required JsonElement Jwk { get; init; }
}

/// <summary>
/// What <see cref="JwtVerifier.VerifyJwt"/> holds a token to: the keys, the receiver's audience, and
/// the wall clock's reading, <em>W</em>, a whole number of milliseconds since the epoch.
/// </summary>
internal sealed record VerifyJwtProps
{
    /// <summary>The keys a token is verified with, the application's.</summary>
    public required IReadOnlyList<JwtKey> Keys { get; init; }

    /// <summary>The receiver's audience, which a token's <c>aud</c> names.</summary>
    public required string Audience { get; init; }

    /// <summary>The wall clock's reading, in milliseconds since the epoch.</summary>
    public required long Now { get; init; }
}

/// <summary>A <c>JWT</c>'s session's identifier: its issuer with its <c>sid</c>, else with its <c>sub</c>.</summary>
internal sealed record JwtSessionIdentifier
{
    /// <summary>The token's <c>iss</c>, its key's issuer.</summary>
    public required string Issuer { get; init; }

    /// <summary>The token's <c>sid</c>, when it carries one; none otherwise.</summary>
    public string? Sid { get; init; }

    /// <summary>The token's <c>sub</c>, when it carries no <c>sid</c>; none otherwise.</summary>
    public string? Sub { get; init; }
}

/// <summary>
/// A <c>JWT</c>'s verdict: it holds, with its session's identifier, its claims set and its end,
/// <em>E</em>, in milliseconds since the epoch; or it does not, with the step of section 13.8 that
/// refused it.
/// </summary>
internal sealed record JwtVerdict
{
    /// <summary>Whether the token holds.</summary>
    public bool Holds
    {
        get
        {
            return Reason is null;
        }
    }

    /// <summary>Why the token does not hold; none when it holds.</summary>
    public JwtRefusal? Reason { get; init; }

    /// <summary>The session's identifier, for a token that holds.</summary>
    public JwtSessionIdentifier? Identifier { get; init; }

    /// <summary>The token's claims set, for a token that holds, outliving the document it was read in.</summary>
    public JsonElement Claims { get; init; }

    /// <summary>The session's end, <em>E</em> = <em>X</em> + 60,000, for a token that holds.</summary>
    public long End { get; init; }
}

/// <summary>
/// The verdict on a <c>JWT</c>: an access token of RFC 9068's profile in JWS Compact Serialization
/// (RFC 7515), verified as section 13.8 states, the same on every side.
/// </summary>
internal static class JwtVerifier
{
    // constants

    /// <summary>
    /// The leeway for clock skew on <c>exp</c> and <c>nbf</c>, in milliseconds: a constant on every
    /// side, which the verdict vectors pin, never an option.
    /// </summary>
    public const long LeewayMilliseconds = 60_000;

    // the largest integer every side holds exactly (section 1.2)
    private const long Largest = (1L << 53) - 1;

    // the base64url alphabet (RFC 4648 §5), each character at its value
    private const string Base64Url = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    // ! a member named twice, or by a name that is not well-formed, refuses the JSON as the
    // TypeScript side's check does; and no depth bound, as JSON.parse sets none
    private static readonly JsonDocumentOptions Json = new()
    {
        AllowDuplicateProperties = false,
        MaxDepth = int.MaxValue,
    };

    // the media type of an access token (RFC 9068 §4), whole or without its `application/`
    private static readonly HashSet<string> AccessTokenTypes = new(StringComparer.Ordinal)
    {
        "at+jwt",
        "application/at+jwt",
    };

    // helpers

    private static JwtVerdict Refused(JwtRefusal reason)
    {
        return new JwtVerdict { Reason = reason };
    }

    // text's bytes, strictly: base64url without padding, the bits past its last byte zero, so that
    // one string alone spells given bytes; none for any other text
    private static byte[]? FromBase64Url(string text)
    {
        if (text.Length % 4 == 1)
        {
            return null;
        }

        var bytes = new byte[text.Length * 3 / 4];
        var buffer = 0;
        var bits = 0;
        var at = 0;

        foreach (var character in text)
        {
            var value = Base64Url.IndexOf(character, StringComparison.Ordinal);

            if (value < 0)
            {
                return null;
            }

            buffer = ((buffer << 6) | value) & 0xFFFF;
            bits += 6;

            if (bits >= 8)
            {
                bits -= 8;
                bytes[at] = (byte)(buffer >> bits);
                at += 1;
            }
        }

        return (buffer & ((1 << bits) - 1)) == 0 ? bytes : null;
    }

    // whether text is well-formed UTF-16, no surrogate alone
    private static bool IsWellFormed(string text)
    {
        for (var index = 0; index < text.Length; index += 1)
        {
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index += 1;
            }
            else if (char.IsSurrogate(text[index]))
            {
                return false;
            }
        }

        return true;
    }

    // json's member name, when it is a string of well-formed Unicode, which JSON's escapes need not
    // write; none otherwise
    private static string? StringOf(JsonElement json, string name)
    {
        if (!json.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        try
        {
            return value.GetString();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    // a header or a claims set: a JSON object in UTF-8 that names each member once; none for any
    // other part
    private static JsonDocument? ObjectOf(string part)
    {
        var bytes = FromBase64Url(part);

        // ! .NET's reader takes bytes that are not UTF-8 within a string, which TextDecoder refuses
        if (bytes is null || !Utf8.IsValid(bytes))
        {
            return null;
        }

        JsonDocument document;

        try
        {
            document = JsonDocument.Parse(bytes, Json);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException)
        {
            return null;
        }

        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            return document;
        }

        document.Dispose();

        return null;
    }

    // a key not shaped for its algorithm is the application's fault, never the token's: it throws,
    // so the call fails rather than withdraw a credential that holds
    private static void AssertKey(JwtKey key)
    {
        ArgumentNullException.ThrowIfNull(key);

        var jwk = key.Jwk;

        if (key.Issuer is null || jwk.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("a JWT's key has its issuer, and is a JWK, a JSON object", nameof(key));
        }

        if (jwk.TryGetProperty("kid", out var kid) && kid.ValueKind != JsonValueKind.String)
        {
            throw new ArgumentException($"a JWT's key names its kid by a string, for the issuer {key.Issuer}", nameof(key));
        }

        var shaped = key.Algorithm switch
        {
            JwtAlgorithm.Es256 => StringOf(jwk, "kty") == "EC"
                && StringOf(jwk, "crv") == "P-256"
                && LengthOf(jwk, "x") == 32
                && LengthOf(jwk, "y") == 32,
            JwtAlgorithm.Hs256 => StringOf(jwk, "kty") == "oct" && LengthOf(jwk, "k") >= 32,
            _ => false,
        };

        if (!shaped)
        {
            throw new ArgumentException(
                $"a JWT's key of ES256 is EC on P-256, its x and y of 32 bytes each, and of HS256 oct, its k of 32 bytes at least (RFC 7518 §3.2); got {key.Algorithm} for the issuer {key.Issuer}",
                nameof(key));
        }
    }

    // the bytes a JWK's member spells in base64url, or -1
    private static int LengthOf(JsonElement jwk, string name)
    {
        var value = StringOf(jwk, name);

        return (value is null ? null : FromBase64Url(value))?.Length ?? -1;
    }

    // the key the token names among the keys alone: by its kid, the one key of that kid, or of
    // several the one of its iss; without a kid, its iss's one key. iss is read unverified, to
    // choose, and held to its key's issuer once the signature verifies
    private static JwtKey? KeyOf(JsonElement header, (JsonElement Claims, IReadOnlyList<JwtKey> Keys) token)
    {
        var issuer = StringOf(token.Claims, "iss");
        var ofIssuer = (JwtKey key) =>
        {
            return string.Equals(key.Issuer, issuer, StringComparison.Ordinal);
        };

        if (!header.TryGetProperty("kid", out _))
        {
            var ofItsIssuer = token.Keys.Where(ofIssuer).ToList();

            return ofItsIssuer.Count == 1 ? ofItsIssuer[0] : null;
        }

        var kid = StringOf(header, "kid");
        var named = token.Keys
            .Where((key) =>
            {
                return kid is not null && string.Equals(StringOf(key.Jwk, "kid"), kid, StringComparison.Ordinal);
            })
            .ToList();
        var found = named.Count > 1 ? named.Where(ofIssuer).ToList() : named;

        return found.Count == 1 ? found[0] : null;
    }

    // whether a key's JWK serves to verify: its alg, use and key_ops, each when present (RFC 7517
    // §4.2 to §4.4)
    private static bool Serves(JwtKey key)
    {
        var algorithm = key.Algorithm == JwtAlgorithm.Es256 ? "ES256" : "HS256";
        var jwk = key.Jwk;
        var verifies = !jwk.TryGetProperty("key_ops", out var operations)
            || (operations.ValueKind == JsonValueKind.Array
                && operations.EnumerateArray().Any((operation) =>
                {
                    return operation.ValueKind == JsonValueKind.String && operation.ValueEquals("verify");
                }));

        return (!jwk.TryGetProperty("alg", out _) || StringOf(jwk, "alg") == algorithm)
            && (!jwk.TryGetProperty("use", out _) || StringOf(jwk, "use") == "sig")
            && verifies;
    }

    // * ES256's signature is R then S, 64 bytes (RFC 7518 §3.4), as IEEE P1363 writes it: never DER
    private static bool Verifies(JwtKey key, (string SigningInput, byte[] Signature) signed)
    {
        var data = Encoding.ASCII.GetBytes(signed.SigningInput);

        if (key.Algorithm == JwtAlgorithm.Es256)
        {
            if (signed.Signature.Length != 64)
            {
                return false;
            }

            using var ecdsa = ECDsa.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = FromBase64Url(StringOf(key.Jwk, "x")!), Y = FromBase64Url(StringOf(key.Jwk, "y")!) },
            });

            return ecdsa.VerifyData(
                data,
                signed.Signature,
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }

        if (signed.Signature.Length != 32)
        {
            return false;
        }

        var mac = HMACSHA256.HashData(FromBase64Url(StringOf(key.Jwk, "k")!)!, data);

        return CryptographicOperations.FixedTimeEquals(mac, signed.Signature);
    }

    // a NumericDate's milliseconds, rounded up, when it is a JSON number every side holds exactly (section
    // 1.2); none otherwise
    private static long? MillisecondsOf(JsonElement claims, string name)
    {
        if (!claims.TryGetProperty(name, out var value)
            || value.ValueKind != JsonValueKind.Number
            || !value.TryGetDouble(out var seconds))
        {
            return null;
        }

        var milliseconds = Math.Ceiling(seconds * 1000);

        return milliseconds >= -Largest && milliseconds <= Largest ? (long)milliseconds : null;
    }

    private static bool NamesAudience(JsonElement claims, string audience)
    {
        if (!claims.TryGetProperty("aud", out var aud))
        {
            return false;
        }

        if (aud.ValueKind == JsonValueKind.String)
        {
            return aud.ValueEquals(audience);
        }

        return aud.ValueKind == JsonValueKind.Array
            && aud.EnumerateArray().All((name) =>
            {
                return name.ValueKind == JsonValueKind.String;
            })
            && aud.EnumerateArray().Any((name) =>
            {
                return name.ValueEquals(audience);
            });
    }

    // steps 8 to 13 of section 13.8, on a token whose signature verified under its key
    private static JwtVerdict VerdictOf(JsonElement claims, (JwtKey Key, VerifyJwtProps Props) verified)
    {
        var (key, props) = verified;

        if (!string.Equals(StringOf(claims, "iss"), key.Issuer, StringComparison.Ordinal))
        {
            return Refused(JwtRefusal.Iss);
        }

        if (MillisecondsOf(claims, "exp") is not { } expiry
            || expiry > Largest - LeewayMilliseconds
            || props.Now >= expiry + LeewayMilliseconds)
        {
            return Refused(JwtRefusal.Exp);
        }

        if (claims.TryGetProperty("nbf", out _)
            && (MillisecondsOf(claims, "nbf") is not { } start || props.Now + LeewayMilliseconds < start))
        {
            return Refused(JwtRefusal.Nbf);
        }

        if (!NamesAudience(claims, props.Audience))
        {
            return Refused(JwtRefusal.Aud);
        }

        var sid = StringOf(claims, "sid");
        var sub = StringOf(claims, "sub");

        if (claims.TryGetProperty("sid", out _) && sid is null)
        {
            return Refused(JwtRefusal.Sid);
        }

        if (sid is null && sub is null)
        {
            return Refused(JwtRefusal.Sub);
        }

        return new JwtVerdict
        {
            Identifier = sid is null
                ? new JwtSessionIdentifier { Issuer = key.Issuer, Sub = sub }
                : new JwtSessionIdentifier { Issuer = key.Issuer, Sid = sid },
            Claims = claims.Clone(),
            End = expiry + LeewayMilliseconds,
        };
    }

    // definition

    /// <summary>
    /// The verdict on <paramref name="token"/>, a <c>JWT</c>, verified as section 13.8 states, step
    /// by step, the first that fails naming the verdict's reason. Settled at once, .NET's crypto being
    /// synchronous, as a <see cref="ValueTask{TResult}"/> for the shape the TypeScript side's Web
    /// Crypto gives it. Throws an <see cref="ArgumentException"/> for a key not shaped for its
    /// algorithm or an audience that is not well-formed Unicode, and a
    /// <see cref="CryptographicException"/> for a key .NET does not import, a point off its curve.
    /// </summary>
    public static ValueTask<JwtVerdict> VerifyJwt(string token, VerifyJwtProps props)
    {
        ArgumentNullException.ThrowIfNull(token);
        ArgumentNullException.ThrowIfNull(props);

        if (props.Audience is null || !IsWellFormed(props.Audience))
        {
            throw new ArgumentException("an audience is a string of well-formed Unicode", nameof(props));
        }

        foreach (var key in props.Keys)
        {
            AssertKey(key);
        }

        return ValueTask.FromResult(Verdict(token, props));
    }

    private static JwtVerdict Verdict(string token, VerifyJwtProps props)
    {
        var parts = token.Split('.');

        if (parts.Length != 3)
        {
            return Refused(JwtRefusal.Token);
        }

        using var header = ObjectOf(parts[0]);
        using var claims = ObjectOf(parts[1]);
        var signature = FromBase64Url(parts[2]);

        if (header is null || claims is null || signature is null)
        {
            return Refused(JwtRefusal.Token);
        }

        // ! jwk, jku, x5u and x5c are never read: a token names no key of its own
        if (header.RootElement.TryGetProperty("crit", out _))
        {
            return Refused(JwtRefusal.Crit);
        }

        if (StringOf(header.RootElement, "typ") is not { } type || !AccessTokenTypes.Contains(type))
        {
            return Refused(JwtRefusal.Typ);
        }

        var key = KeyOf(header.RootElement, (claims.RootElement, props.Keys));

        if (key is null)
        {
            return Refused(JwtRefusal.Kid);
        }

        if (StringOf(header.RootElement, "alg") != (key.Algorithm == JwtAlgorithm.Es256 ? "ES256" : "HS256"))
        {
            return Refused(JwtRefusal.Alg);
        }

        if (!Serves(key))
        {
            return Refused(JwtRefusal.Key);
        }

        if (!Verifies(key, ($"{parts[0]}.{parts[1]}", signature)))
        {
            return Refused(JwtRefusal.Signature);
        }

        return VerdictOf(claims.RootElement, (key, props));
    }
}
