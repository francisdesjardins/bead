using System.Text.Json;

namespace Bead;

/// <summary>
/// How a side resolves a request presenting a <see cref="CredentialScheme.Jwt"/> or an
/// <see cref="CredentialScheme.Elsewhere"/> to its credential's session (spec 9.2, step 5), from
/// the <see cref="Credentials"/> it was given, on the clock it runs on: a JWT verified as section
/// 13.8 states, its key found among the application's keys and those the key set answered; an
/// ELSEWHERE by the application's verifier, as section 13.10 states. What does not hold resolves to
/// none; what fails throws, for its call to fail PROCEDURE_FAILED. Its key set's state is kept
/// under a lock: calls of any thread find an ask under way.
/// </summary>
internal sealed class CredentialResolver
{
    // constants

    // how long an ask of the key set holds off the next for its issuer, on the monotonic reading
    private static readonly TimeSpan KeySetMinute = TimeSpan.FromMinutes(1);

    // the largest integer every side holds exactly (section 1.2)
    private const long Largest = (1L << 53) - 1;

    private readonly Credentials _credentials;
    private readonly TimeProvider _clock;
    private readonly IReadOnlyList<string> _audiences;
    private readonly Lock _gate = new();

    // by issuer, what the key set answered for it, and its asks
    private readonly Dictionary<string, Issuer> _issuers = new(StringComparer.Ordinal);

    /// <summary>
    /// A resolver of <paramref name="credentials"/>, on <paramref name="clock"/>. A key not shaped
    /// for its algorithm, or an audience that is not a string of well-formed Unicode, is an
    /// <see cref="ArgumentException"/>, as it is built. Keys without an audience hold a token to
    /// none: its <c>aud</c> names none, and it does not hold.
    /// </summary>
    public CredentialResolver(Credentials? credentials, TimeProvider clock)
    {
        _credentials = credentials ?? new Credentials();
        _clock = clock;
        _audiences = _credentials.Audience is { } audience ? [audience] : [];
        JwtVerifier.AssertHeld((_credentials.Keys, _audiences));

        var schemes = new List<CredentialScheme> { CredentialScheme.Opaque };

        if (_credentials.TakesJwt)
        {
            schemes.Add(CredentialScheme.Jwt);
        }

        if (_credentials.Verify is not null)
        {
            schemes.Add(CredentialScheme.Elsewhere);
        }

        Schemes = schemes;
    }

    /// <summary>
    /// The credential schemes the side takes, in the order of their numbers: <see cref="CredentialScheme.Opaque"/>,
    /// which every side takes, then those its credentials give.
    /// </summary>
    public IReadOnlyList<CredentialScheme> Schemes { get; }

    /// <summary>Whether the side takes a <see cref="CredentialScheme.Jwt"/>.</summary>
    public bool TakesJwt
    {
        get
        {
            return _credentials.TakesJwt;
        }
    }

    // helpers

    /// <summary>
    /// Refuses limits a side that takes or presents a JWT cannot hold by: its chunk and its envelope
    /// under 1,024 bytes, which a header of 1,020 bytes and the byte of payload an opening carries
    /// need (spec 12.2), as limits that do not hold together, an <see cref="ArgumentException"/>.
    /// </summary>
    public static void AssertLimits(RouterLimits limits, bool isJwt)
    {
        ArgumentNullException.ThrowIfNull(limits);

        if (isJwt && (limits.ChunkBytes < 1_024 || limits.MaximumEnvelopeBytes < 1_024))
        {
            throw new ArgumentException(
                "the router's limits do not hold together: a side that takes or presents a JWT holds a chunk's envelope and an envelope of 1,024 bytes at least");
        }
    }

    /// <summary>
    /// Whether a token's <c>aud</c> names <paramref name="audience"/>, read without verifying the
    /// token, as section 13.8's step 11 reads it: a token that does not read names none.
    /// </summary>
    public static bool NamesAudience(string token, string audience)
    {
        return JwtVerifier.ReadUnverified(token) is { } read && JwtVerifier.NamesAudience(read.Claims, [audience]);
    }

    // the token's iss and its header's kid, read without verifying it, to know whether to ask the
    // key set; none for a token that does not read, or for a member that is no string
    private static (string? Issuer, string? Kid) KidOf(string token)
    {
        if (JwtVerifier.ReadUnverified(token) is not { } read)
        {
            return (null, null);
        }

        var issuer = read.Claims.TryGetProperty("iss", out var iss) && iss.ValueKind == JsonValueKind.String ? iss.GetString() : null;

        return (issuer, read.Kid);
    }

    // whether a key held names a kid
    private bool IsNamed(string kid)
    {
        return KeysHeld().Any((key) =>
        {
            return key.Jwk.TryGetProperty("kid", out var named) && named.ValueKind == JsonValueKind.String && named.ValueEquals(kid);
        });
    }

    // the wall clock's reading, W, in whole milliseconds since the epoch, a fraction dropped
    private long Now()
    {
        return _clock.GetUtcNow().ToUnixTimeMilliseconds();
    }

    // the application's keys, and those the key set answered, each held for its issuer
    private List<JwtKey> KeysHeld()
    {
        lock (_gate)
        {
            return [.. _credentials.Keys, .. _issuers.Values.SelectMany((issuer) =>
            {
                return issuer.Held;
            })];
        }
    }

    // the verdict on a token, against the keys held now and the wall clock read now
    private async ValueTask<JwtVerdict> VerdictOf(string token, IReadOnlyCollection<string> audiences)
    {
        return await JwtVerifier.VerifyJwt(token, new VerifyJwtProps { Audiences = audiences, Keys = KeysHeld(), Now = Now() });
    }

    // what the key set answered for `issuer`, asked when no ask went for it within the minute; a
    // call that finds an ask under way waits on it, its signal ending its own wait alone. Settles
    // once the keys are held, or throws: an ask that failed, now or within the minute
    private async Task KeysOf(string issuer, CancellationToken signal)
    {
        Task asking;
        TaskCompletionSource? started = null;

        Issuer? held;

        lock (_gate)
        {
            Forget(_clock.GetTimestamp());

            if (!_issuers.TryGetValue(issuer, out held))
            {
                held = new Issuer();
                _issuers[issuer] = held;
            }

            if (held.Asking is { } underWay)
            {
                asking = underWay;
            }
            else if (held.Deadline is { } deadline && _clock.GetTimestamp() < deadline)
            {
                if (held.Failed is { } failed)
                {
                    throw new InvalidOperationException($"the key set of {issuer} could not be reached within the minute", failed);
                }

                return;
            }
            else
            {
                // ! its waiters go on where it settles, on the router's scheduler, never by the thread pool
                started = new TaskCompletionSource();
                held.Deadline = _clock.GetTimestamp() + (long)(KeySetMinute.TotalSeconds * _clock.TimestampFrequency);
                held.Asking = started.Task;
                asking = started.Task;

                // ! an ask whose waiters all left still fails observed
                _ = started.Task.ContinueWith(
                    static (failed) =>
                    {
                        _ = failed.Exception;
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }

        if (started is not null)
        {
            _ = Ask((issuer, held), started);
        }

        await asking.WaitAsync(signal);
    }

    // the issuers that hold nothing, no ask under way, past their minute: forgotten as a call asks,
    // so tokens naming any issuer keep nothing for long; under the lock
    private void Forget(long now)
    {
        foreach (var (issuer, held) in _issuers.ToList())
        {
            if (held.Held.Count == 0 && held.Asking is null && held.Deadline is { } deadline && now >= deadline)
            {
                _issuers.Remove(issuer);
            }
        }
    }

    // asks the key set for an issuer's keys, and holds them in place of those it answered before;
    // an ask that fails — its answer a key not shaped for its algorithm among them — leaves them,
    // and fails what waits on it
    private async Task Ask((string Name, Issuer Held) asking, TaskCompletionSource asked)
    {
        var (issuer, held) = asking;
        List<JwtKey> answered;

        try
        {
            var keys = await _credentials.KeySet!(issuer) ?? throw new InvalidOperationException($"the key set answered nothing for {issuer}");

            answered = [.. keys.Select((key) =>
            {
                return new JwtKey { Issuer = issuer, Algorithm = key.Algorithm, Jwk = key.Jwk };
            })];
            JwtVerifier.AssertHeld((answered, []));
        }
        catch (Exception reason)
        {
            lock (_gate)
            {
                held.Asking = null;
                held.Failed = reason;
            }

            asked.SetException(new InvalidOperationException($"the key set of {issuer} could not be reached", reason));

            return;
        }

        lock (_gate)
        {
            held.Asking = null;
            held.Failed = null;
            held.Held = answered;
        }

        asked.SetResult();
    }

    // definition

    /// <summary>
    /// The credential's session a request presenting a <see cref="CredentialScheme.Jwt"/> or an
    /// <see cref="CredentialScheme.Elsewhere"/> resolves to, with its identifier, its data and its
    /// end; none for a credential that does not hold. A JWT is held to its request's audiences — a
    /// relay's that verifies — or to the side's own. Throws, for its call to fail PROCEDURE_FAILED,
    /// for a verifier that fails: its key set unreached, or the application's verifier failing.
    /// </summary>
    public ValueTask<CallSession?> Resolve(SessionRequest request, CancellationToken signal)
    {
        ArgumentNullException.ThrowIfNull(request);

        return request.Header.Credential switch
        {
            { Scheme: CredentialScheme.Jwt, Token: { } token } => ResolveJwt(token, (request.Audiences ?? _audiences, signal)),
            { Scheme: CredentialScheme.Elsewhere } when request.TransportCredential is { } carried => ResolveElsewhere(carried, signal),
            _ => ValueTask.FromResult<CallSession?>(null),
        };
    }

    // a JWT, verified; a kid no key held names asks the key set for its issuer, then verifies again
    private async ValueTask<CallSession?> ResolveJwt(string token, (IReadOnlyCollection<string> Audiences, CancellationToken Signal) against)
    {
        var verdict = await VerdictOf(token, against.Audiences);

        // ? a token without a kid asks nothing, whatever keys its issuer has: a kid names none
        if (verdict.Reason == JwtRefusal.Kid
            && _credentials.KeySet is not null
            && KidOf(token) is (Issuer: { } issuer, Kid: { } kid)
            && !IsNamed(kid))
        {
            await KeysOf(issuer, against.Signal);
            verdict = await VerdictOf(token, against.Audiences);
        }

        if (!verdict.Holds)
        {
            return null;
        }

        var identifier = verdict.Identifier!;

        return new CallSession
        {
            Data = verdict.Claims,
            Identifier = new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = identifier.Issuer, Sid = identifier.Sid, Sub = identifier.Sub },
            End = verdict.End,
        };
    }

    // an ELSEWHERE, by the application's verifier: its end rounded up to a millisecond, E, against
    // the wall clock read as it settles, W; W ≥ E does not hold
    private async ValueTask<CallSession?> ResolveElsewhere(string carried, CancellationToken signal)
    {
        var session = await _credentials.Verify!(carried, signal);

        if (session is null)
        {
            return null;
        }

        if (session.Id is null)
        {
            throw new InvalidOperationException("an ELSEWHERE's verifier settled with a session whose id is no string");
        }

        long? end = session.End is { } given ? MillisecondsOf(given) : null;

        if (end is { } ends && Now() >= ends)
        {
            return null;
        }

        return new CallSession
        {
            Data = session.Data,
            Identifier = new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = session.Id },
            End = end,
        };
    }

    // an end in milliseconds since the epoch, rounded up to a whole one, as a number every side
    // holds exactly, from −(2⁵³ − 1) to 2⁵³ − 1; any other — not a number, an infinity — is the
    // verifier's fault
    private static long MillisecondsOf(double end)
    {
        if (!double.IsFinite(end) || end < -Largest || end > Largest)
        {
            throw new InvalidOperationException("an ELSEWHERE's verifier settled with a session whose end is no number from −(2⁵³ − 1) to 2⁵³ − 1");
        }

        return (long)Math.Ceiling(end);
    }

    // what the key set answered for an issuer, held until its next answer, and its asks: the one
    // under way, the deadline before which no other goes, and why the last failed, while it did
    private sealed class Issuer
    {
        public List<JwtKey> Held { get; set; } = [];

        public Task? Asking { get; set; }

        public long? Deadline { get; set; }

        public Exception? Failed { get; set; }
    }
}
