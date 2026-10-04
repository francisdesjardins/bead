namespace Bead;

/// <summary>
/// How a side resolves a request presenting a <see cref="CredentialScheme.Jwt"/> or an
/// <see cref="CredentialScheme.Elsewhere"/> to its credential's session (spec 9.2, step 5), from
/// the <see cref="Credentials"/> it was given, on the clock it runs on: a JWT verified as section
/// 13.8 states, its key found among the application's keys and those its key set answered that
/// serve; an ELSEWHERE by the application's verifier, as section 13.10 states. What does not hold
/// resolves to none; what fails throws, for its call to fail PROCEDURE_FAILED. Its key set's state
/// is kept under a lock, so calls of any thread find an ask under way, and what an ask's deadline
/// does is posted where the side runs.
/// </summary>
internal sealed class CredentialResolver
{
    // constants

    // how long an ask of the key set holds off the next for its issuer: its deadline
    private static readonly TimeSpan KeySetMinute = TimeSpan.FromMinutes(1);

    // how long the keys an answer gave serve, from that answer
    private static readonly TimeSpan KeySetHold = TimeSpan.FromMinutes(10);

    // the largest integer every side holds exactly (section 1.2)
    private const long Largest = (1L << 53) - 1;

    private readonly Credentials _credentials;
    private readonly TimeProvider _clock;
    private readonly Action<Action> _post;
    private readonly IReadOnlyList<string> _audiences;
    private readonly Lock _gate = new();

    // the minute and the ten minutes, on the monotonic reading
    private readonly long _minute;
    private readonly long _hold;

    // by issuer the key set names, what it answered for it, and its asks
    private readonly Dictionary<string, IssuerKeys> _issuers = new(StringComparer.Ordinal);

    /// <summary>
    /// A resolver of <paramref name="credentials"/>, on its side's clock, posting what an ask's
    /// deadline does where its side runs. A key not shaped for its algorithm, an audience that is
    /// not a string of well-formed Unicode, keys or a key set given without an audience, whatever
    /// its side's relay does, and a key set given with no issuer, or one that is no string, are each
    /// an <see cref="ArgumentException"/>, as it is built.
    /// </summary>
    public CredentialResolver(Credentials? credentials, (TimeProvider Clock, Action<Action> Post) side)
    {
        _credentials = credentials ?? new Credentials();
        _clock = side.Clock;
        _post = side.Post;
        _audiences = _credentials.Audience is { } audience ? [audience] : [];
        _minute = (long)(KeySetMinute.TotalSeconds * _clock.TimestampFrequency);
        _hold = (long)(KeySetHold.TotalSeconds * _clock.TimestampFrequency);
        JwtVerifier.AssertHeld((_credentials.Keys, _audiences));

        // ! keys held to no audience would refuse every JWT SESSION_REQUIRED, which withdraws a
        // client's default: the application's fault, told as the side is built, never charged to a
        // token. A relay that verifies changes nothing: a request to the side itself names no
        // destination, and its token is held to the side's own audience
        if (_credentials is { TakesJwt: true, Audience: null })
        {
            throw new ArgumentException(
                "a side given a JWT's keys or a key set is given its audience too, whatever its relay does",
                nameof(credentials));
        }

        if (_credentials.KeySet is { } keySet)
        {
            if (keySet.Issuers is not { Count: > 0 } issuers
                || keySet.Ask is null
                || issuers.Any((issuer) =>
                {
                    return issuer is null;
                }))
            {
                throw new ArgumentException(
                    "a key set is given with the issuers it answers for, one at least, each a string, and how it is asked",
                    nameof(credentials));
            }

            foreach (var issuer in issuers)
            {
                _issuers.TryAdd(issuer, new IssuerKeys { Name = issuer });
            }
        }

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

    // the wall clock's reading, W, in whole milliseconds since the epoch, a fraction dropped
    private long Now()
    {
        return _clock.GetUtcNow().ToUnixTimeMilliseconds();
    }

    // whether the keys an issuer's last answer gave serve: while the monotonic reading is before that
    // answer's plus ten minutes
    private bool Serves(IssuerKeys issuer, long now)
    {
        return issuer.AnsweredAt is { } answeredAt && now < answeredAt + _hold;
    }

    // the keys that serve: the application's, for good, and those each answer gave, ten minutes from
    // it; under the lock
    private List<JwtKey> KeysServing(long now)
    {
        return [.. _credentials.Keys, .. _issuers.Values
            .Where((issuer) =>
            {
                return Serves(issuer, now);
            })
            .SelectMany((issuer) =>
            {
                return issuer.Held;
            })];
    }

    // whether a token's key does not serve, so that it waits for its issuer's keys: its kid names
    // none of its issuer's keys that serve, whatever another issuer's key names; without a kid, the
    // keys held for its issuer are past their ten minutes. A kid that is no string names none, ever,
    // and waits on nothing. Under the lock
    private bool Needs(IssuerKeys issuer, ((bool HasKid, string? Kid) Key, long Now) token)
    {
        var ((hasKid, kid), now) = token;

        if (!hasKid)
        {
            return issuer.Held.Count > 0 && !Serves(issuer, now);
        }

        var held = Serves(issuer, now) ? issuer.Held : [];

        return kid is not null && !_credentials.Keys
            .Where((key) =>
            {
                return string.Equals(key.Issuer, issuer.Name, StringComparison.Ordinal);
            })
            .Concat(held)
            .Any((key) =>
            {
                return string.Equals(JwtVerifier.StringOf(key.Jwk, "kid"), kid, StringComparison.Ordinal);
            });
    }

    // the verdict on a token, against the keys that serve now and the wall clock read as its
    // signature has verified
    private async ValueTask<JwtVerdict> VerdictOf(string token, IReadOnlyCollection<string> audiences)
    {
        List<JwtKey> keys;

        lock (_gate)
        {
            keys = KeysServing(_clock.GetTimestamp());
        }

        return await JwtVerifier.VerifyJwt(token, new VerifyJwtProps { Audiences = audiences, Keys = keys, Now = Now });
    }

    // the wait of a token of an issuer the key set names, while its key does not serve: on the ask
    // under way, which went before it came; before the deadline, for it and the ask then, which goes
    // after it came; otherwise on an ask that goes now. None for a token of any other issuer, which
    // never has the key set asked, or whose key serves
    private Task? WaitOf(string token, CancellationToken signal)
    {
        if (JwtVerifier.ReadUnverified(token) is not { } read
            || JwtVerifier.StringOf(read.Claims, "iss") is not { } name
            || !_issuers.TryGetValue(name, out var issuer))
        {
            return null;
        }

        var waiter = new Waiter((read.Header.TryGetProperty("kid", out _), JwtVerifier.StringOf(read.Header, "kid")));
        var effects = new Effects(_clock.GetTimestamp());
        var waits = true;

        lock (_gate)
        {
            // a deadline reached whose timer has yet to fire is reached all the same
            if (issuer.Minute is { IsOver: false } passed && effects.Now >= passed.Deadline)
            {
                Expire(issuer, effects);
            }

            if (!Needs(issuer, (waiter.Key, effects.Now)))
            {
                waits = false;
            }
            else if (issuer.Minute is { IsOver: false, Asked: { } asking })
            {
                waiter.In = asking;
                asking.Add(waiter);
            }
            else if (issuer.Minute is { IsOver: false } minute)
            {
                waiter.In = minute.Next;
                minute.Next.Add(waiter);
            }
            else
            {
                Go(issuer, ([waiter], effects));
            }
        }

        Apply(effects);

        return waits ? Wait(waiter, signal) : null;
    }

    // a call's wait on its issuer's keys, which its own signal ends, its alone
    private async Task Wait(Waiter waiter, CancellationToken signal)
    {
        using var leaving = signal.Register(() =>
        {
            Leave(waiter, signal);
        });

        await waiter.Settled.Task;
    }

    // a call that left its wait by its own signal: the ask goes on for the others, and a deadline
    // whose callers all left asks nothing
    private void Leave(Waiter waiter, CancellationToken signal)
    {
        lock (_gate)
        {
            waiter.In?.Remove(waiter);
            waiter.In = null;
        }

        waiter.Settled.TrySetCanceled(signal);
    }

    // an ask that goes now for an issuer, the calls given waiting on it, each come before it went,
    // its deadline a minute on and its timer armed. Under the lock
    private void Go(IssuerKeys issuer, (List<Waiter> Waiters, Effects Effects) going)
    {
        var minute = new Minute { Deadline = going.Effects.Now + _minute, Asked = going.Waiters };

        foreach (var waiter in going.Waiters)
        {
            waiter.IsAfter = true;
            waiter.In = going.Waiters;
        }

        // ! its work posted where the side runs, so the ask it may send goes from there
        minute.Timer = _clock.CreateTimer(
            (_) =>
            {
                _post(() =>
                {
                    OnDeadline(issuer, minute);
                });
            },
            null,
            KeySetMinute,
            Timeout.InfiniteTimeSpan);
        issuer.Minute = minute;
        going.Effects.Asking.Add((issuer, minute));
    }

    // an issuer's minute at its deadline: its ask, still under way, fails, its signal aborted; the
    // calls that wait for the deadline wait on an ask that goes now; for no call, none goes. Under
    // the lock
    private void Expire(IssuerKeys issuer, Effects effects)
    {
        var minute = issuer.Minute!;

        minute.IsOver = true;
        effects.Ended.Add(minute);

        if (minute.Asked is { } asking)
        {
            minute.Asked = null;
            effects.Aborted.Add(minute);
            Fail(asking, (new TimeoutException($"the key set's ask for {issuer.Name} was unsettled at its deadline"), effects));
        }

        if (minute.Next.Count > 0)
        {
            Go(issuer, ([.. minute.Next], effects));
            minute.Next.Clear();
        }
    }

    // an ask's deadline, as its timer fires, unless that minute ended already
    private void OnDeadline(IssuerKeys issuer, Minute minute)
    {
        var effects = new Effects(_clock.GetTimestamp());

        lock (_gate)
        {
            if (!minute.IsOver && ReferenceEquals(issuer.Minute, minute))
            {
                Expire(issuer, effects);
            }
        }

        Apply(effects);
    }

    // the calls of an ask that failed, failed with it. Under the lock
    private static void Fail(List<Waiter> waiters, (Exception Reason, Effects Effects) failed)
    {
        foreach (var waiter in waiters)
        {
            waiter.In = null;
        }

        failed.Effects.Failed.Add((waiters, failed.Reason));
    }

    // asks the key set for an issuer's keys, with its minute's signal: what it answers, or why it
    // failed — its answer a key not shaped for its algorithm among them — settles that ask
    private async Task Ask(IssuerKeys issuer, Minute minute)
    {
        List<JwtKey> answered;

        try
        {
            var keys = await _credentials.KeySet!.Ask(issuer.Name, minute.Signal.Token)
                ?? throw new InvalidOperationException($"the key set answered nothing for {issuer.Name}");

            answered = [.. keys.Select((key) =>
            {
                return new JwtKey { Issuer = issuer.Name, Algorithm = key.Algorithm, Jwk = key.Jwk };
            })];
            JwtVerifier.AssertHeld((answered, []));
        }
        catch (Exception reason)
        {
            Settle((issuer, minute), (null, new InvalidOperationException($"the key set's ask for {issuer.Name} failed", reason)));

            return;
        }

        Settle((issuer, minute), (answered, null));
    }

    // an ask settled: dropped once its deadline came, when it failed. Its answer is held for its
    // issuer in place of the last, as its reading is taken, and each call that waits on it goes on —
    // but one whose ask went before it came and whose key still does not serve, which waits for the
    // deadline and the ask then; its failure fails them all, and replaces nothing held
    private void Settle((IssuerKeys Issuer, Minute Minute) asked, (List<JwtKey>? Keys, Exception? Reason) settled)
    {
        var (issuer, minute) = asked;
        var effects = new Effects(_clock.GetTimestamp());

        lock (_gate)
        {
            // ! at its deadline it failed, whatever it settles to after
            if (!minute.IsOver && ReferenceEquals(issuer.Minute, minute) && effects.Now >= minute.Deadline)
            {
                Expire(issuer, effects);
            }

            if (minute.Asked is { } asking)
            {
                minute.Asked = null;

                if (settled.Keys is not { } keys)
                {
                    Fail(asking, (settled.Reason!, effects));
                }
                else
                {
                    issuer.Held = keys;
                    issuer.AnsweredAt = effects.Now;

                    foreach (var waiter in asking)
                    {
                        if (waiter.IsAfter || !Needs(issuer, (waiter.Key, effects.Now)))
                        {
                            waiter.In = null;
                            effects.Released.Add(waiter);
                        }
                        else
                        {
                            waiter.In = minute.Next;
                            minute.Next.Add(waiter);
                        }
                    }
                }
            }
        }

        Apply(effects);
    }

    // what a change of the key set's state does once the lock is let go: the calls failed or let go
    // on, the asks gone, then the timers of the minutes that ended disposed, and the signals of the
    // asks unsettled at their deadline cancelled
    private void Apply(Effects effects)
    {
        foreach (var (waiters, reason) in effects.Failed)
        {
            foreach (var waiter in waiters)
            {
                waiter.Settled.TrySetException(reason);
            }
        }

        foreach (var waiter in effects.Released)
        {
            waiter.Settled.TrySetResult();
        }

        foreach (var (issuer, minute) in effects.Asking)
        {
            _ = Ask(issuer, minute);
        }

        foreach (var minute in effects.Ended)
        {
            minute.Timer?.Dispose();
        }

        foreach (var minute in effects.Aborted)
        {
            minute.Signal.Cancel();
        }
    }

    // definition

    /// <summary>
    /// The credential's session a request presenting a <see cref="CredentialScheme.Jwt"/> or an
    /// <see cref="CredentialScheme.Elsewhere"/> resolves to, with its identifier, its data and its
    /// end; none for a credential that does not hold. A JWT is held to its request's audiences — a
    /// relay's that verifies — or to the side's own. Throws, for its call to fail PROCEDURE_FAILED,
    /// for a verifier that fails: its key set's ask failing, unreached or unsettled at its deadline,
    /// or the application's verifier failing; and an <see cref="OperationCanceledException"/> as
    /// <paramref name="signal"/> ends a wait on its key set, which goes on for the others.
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

    // a JWT, verified against the keys that serve; one of an issuer the key set names whose key does
    // not serve waits for that issuer's keys, then is verified again
    private async ValueTask<CallSession?> ResolveJwt(string token, (IReadOnlyCollection<string> Audiences, CancellationToken Signal) against)
    {
        var verdict = await VerdictOf(token, against.Audiences);

        // * a token refused before its key is looked for waits for none
        if (verdict.Reason is not (null or JwtRefusal.Token or JwtRefusal.Crit or JwtRefusal.Typ)
            && WaitOf(token, against.Signal) is { } waiting)
        {
            await waiting;
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

    // what the key set answered for an issuer it names: the keys its last answer gave, the monotonic
    // reading as that answer was taken, and its last ask's minute
    private sealed class IssuerKeys
    {
        public required string Name { get; init; }

        public List<JwtKey> Held { get; set; } = [];

        public long? AnsweredAt { get; set; }

        public Minute? Minute { get; set; }
    }

    // an ask, and the minute it holds off the next for its issuer: its deadline, the calls that wait
    // on it while it is under way, those that wait for its deadline and the ask then, its signal,
    // which its deadline cancels while it is under way, its timer, and whether its deadline came
    private sealed class Minute
    {
        public required long Deadline { get; init; }

        public List<Waiter>? Asked { get; set; }

        public List<Waiter> Next { get; } = [];

        public CancellationTokenSource Signal { get; } = new();

        public ITimer? Timer { get; set; }

        public bool IsOver { get; set; }
    }

    // a call that waits on its issuer's keys: its token's kid — whether it has one, and it when a
    // string — whether the ask it waits on went after it came, the list it waits in, and what tells
    // it to go on, or fails it
    private sealed class Waiter((bool HasKid, string? Kid) key)
    {
        public (bool HasKid, string? Kid) Key { get; } = key;

        public bool IsAfter { get; set; }

        public List<Waiter>? In { get; set; }

        public TaskCompletionSource Settled { get; } = new();
    }

    // what a change of the key set's state does once the lock is let go, at the monotonic reading it
    // was made at
    private sealed class Effects(long now)
    {
        public long Now { get; } = now;

        public List<Minute> Ended { get; } = [];

        public List<Minute> Aborted { get; } = [];

        public List<(List<Waiter> Waiters, Exception Reason)> Failed { get; } = [];

        public List<Waiter> Released { get; } = [];

        public List<(IssuerKeys Issuer, Minute Minute)> Asking { get; } = [];
    }
}
