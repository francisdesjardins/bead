using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Bead.Interop;

/// <summary>
/// The credentials of Bead's interop service, <c>credentials.jwt</c> and
/// <c>credentials.elsewhere</c> of <c>spec/interop-service.json</c>, as the C# side's interop server
/// and its tests are given them.
/// </summary>
public static class InteropCredentials
{
    // constants

    // the interop service's relay and credentials, as its file states them
    private static readonly JsonElement Service = Load("interop-service.json");

    // what the ELSEWHERE verifier holds, by credentials.elsewhere's grammar: its auth-scheme
    // case-insensitive (RFC 9110 §11.1), one space, then its parameters, case-sensitive (RFC 7405)
    private static readonly Regex Carried = new(
        "^[Ii][Nn][Tt][Ee][Rr][Oo][Pp] (?:sub=(?<sub>[a-z]{1,32})(?:, after=(?<after>[1-9][0-9]{0,9}))?(?:, end=(?<end>[1-9][0-9]{0,15}))?|fail=true(?:, after=(?<failingAfter>[1-9][0-9]{0,9}))?)\\z",
        RegexOptions.CultureInvariant | RegexOptions.ExplicitCapture);

    // the bounds of an after and an end, 2³¹ − 1 (spec 1.4) and 2⁵³ − 1 (spec 1.2)
    private const long LongestAfter = int.MaxValue;
    private const long LatestEnd = (1L << 53) - 1;

    // how long the key set takes to answer, on the server's clock, so a conversation sees each ask
    private static readonly TimeSpan KeySetWait = TimeSpan.FromMilliseconds(1_000);

    // the issuers whose key set answers as their words say: its keys at its first ask alone, and
    // never; any other it names answers its keys at every ask
    private const string RotatedIssuer = "https://rotated.interop.bead.example";
    private const string StalledIssuer = "https://stalled.interop.bead.example";

    // helpers

    private static JsonElement Load(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, name);

        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.Clone();
    }

    // definition

    /// <summary>
    /// The interop service's credentials, <c>credentials.jwt</c> and <c>credentials.elsewhere</c>,
    /// on <paramref name="clock"/>, the clock its server is given (decision 0011): the two
    /// issuers' published test keys and their audience; the key set, given with the issuers it
    /// answers for and the most calls that wait for one issuer's keys at once, which answers each
    /// as its words say, on that clock whatever its signal, and fails at once for any other, its
    /// rotated issuer's asks counted for this key set alone; and the ELSEWHERE verifier, by its
    /// grammar, which settles on that clock whatever its signal.
    /// </summary>
    public static Credentials Of(TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(clock);

        var jwt = Service.GetProperty("credentials").GetProperty("jwt");
        var keySet = jwt.GetProperty("keySet");
        var answered = keySet.GetProperty("issuers").EnumerateArray().ToDictionary(
            (named) =>
            {
                return named.GetProperty("issuer").GetString()!;
            },
            (named) =>
            {
                return (IReadOnlyList<JwtSetKey>)[.. named.GetProperty("keys").EnumerateArray().Select((key) =>
                {
                    return new JwtSetKey { Algorithm = AlgorithmOf(key), Jwk = key.GetProperty("jwk").Clone() };
                })];
            },
            StringComparer.Ordinal);
        var rotatedAsks = 0;

        return new Credentials
        {
            Audience = jwt.GetProperty("audience").GetString(),
            Keys = [.. jwt.GetProperty("keys").EnumerateArray().Select((key) =>
            {
                return new JwtKey { Issuer = key.GetProperty("issuer").GetString()!, Algorithm = AlgorithmOf(key), Jwk = key.GetProperty("jwk").Clone() };
            })],
            KeySet = new JwtKeySet
            {
                Issuers = [.. answered.Keys],
                Ask = (issuer, _) =>
                {
                    if (!answered.TryGetValue(issuer, out var keys))
                    {
                        return ValueTask.FromException<IReadOnlyList<JwtSetKey>>(
                            new InvalidOperationException($"the interop key set names no issuer {issuer}"));
                    }

                    // ! never settles, and arms no timer: its ask fails at its deadline alone
                    if (issuer == StalledIssuer)
                    {
                        return new ValueTask<IReadOnlyList<JwtSetKey>>(new TaskCompletionSource<IReadOnlyList<JwtSetKey>>().Task);
                    }

                    var isWithdrawn = issuer == RotatedIssuer && Interlocked.Increment(ref rotatedAsks) > 1;

                    return Answer((isWithdrawn ? [] : keys, clock));
                },
                MaximumWaitingCalls = keySet.GetProperty("maximumWaitingCalls").GetInt32(),
            },
            Verify = (carried, _) =>
            {
                return Verify((carried, clock));
            },
        };
    }

    // the key set's answer, once 1,000 ms passed on the server's clock, whatever its signal
    private static async ValueTask<IReadOnlyList<JwtSetKey>> Answer((IReadOnlyList<JwtSetKey> Keys, TimeProvider Clock) answering)
    {
        await Task.Delay(KeySetWait, answering.Clock);

        return answering.Keys;
    }

    // a key's one algorithm, as the service's file names it
    private static JwtAlgorithm AlgorithmOf(JsonElement key)
    {
        return key.GetProperty("algorithm").GetString() switch
        {
            "ES256" => JwtAlgorithm.Es256,
            "HS256" => JwtAlgorithm.Hs256,
            var other => throw new ArgumentException($"the interop service names no algorithm {other}", nameof(key)),
        };
    }

    // credentials.elsewhere's verifier: a value of holding settles with its session, its id its sub,
    // its data {"sub":sub}, its end when it gives one; a value of failing rejects; either once its
    // after passed on the server's clock — whatever the call's signal, so its settling may come once
    // its call ended — or at once; any other value holds nothing
    private static async ValueTask<ElsewhereSession?> Verify((string Carried, TimeProvider Clock) asked)
    {
        var (carried, clock) = asked;
        var match = Carried.Match(carried);
        var after = match.Groups["after"].Success ? match.Groups["after"] : match.Groups["failingAfter"];
        var end = match.Groups["end"];

        if (!match.Success
            || (after.Success && long.Parse(after.Value, CultureInfo.InvariantCulture) > LongestAfter)
            || (end.Success && long.Parse(end.Value, CultureInfo.InvariantCulture) > LatestEnd))
        {
            return null;
        }

        if (after.Success)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(long.Parse(after.Value, CultureInfo.InvariantCulture)), clock);
        }

        if (!match.Groups["sub"].Success)
        {
            throw new InvalidOperationException("this verifier fails, on purpose");
        }

        var sub = match.Groups["sub"].Value;

        return new ElsewhereSession
        {
            Data = JsonSerializer.SerializeToElement(new Dictionary<string, string> { ["sub"] = sub }),
            End = end.Success ? long.Parse(end.Value, CultureInfo.InvariantCulture) : null,
            Id = sub,
        };
    }
}
