namespace Bead;

/// <summary>
/// What an HTTP server judges a request by first, given once to every listener of an application —
/// its HTTP transport and its gateway alike (decision 0037, transcoding 3.14) — so two listeners never
/// keep two lists alike in silence: the hosts it takes, the origins it answers CORS to, the proxies
/// whose <c>X-Forwarded-For</c> it believes, and the bounds spec 15.12 names. Each member is the
/// option of its name a listener takes, none where the policy gives none, which leaves the
/// listener's own. Built by <see cref="Of"/>, checked once as each listener checks its own members,
/// its lists copied.
/// </summary>
public sealed record HttpPolicy
{
    private HttpPolicy()
    {
    }

    /// <summary>The hosts it takes beside the loopbacks' names and IP literals; <c>*</c> takes any (spec 15.12).</summary>
    public IReadOnlyList<string>? Hosts { get; private init; }

    /// <summary>The origins it answers CORS to, beside its own (spec 15.12, decision 0027).</summary>
    public IReadOnlyList<string>? Origins { get; private init; }

    /// <summary>The proxies whose <c>X-Forwarded-For</c> it believes, by address or network (decision 0030).</summary>
    public IReadOnlyList<string>? TrustedProxies { get; private init; }

    /// <summary>How many proxies stand in front of it unnamed, from 0 to 8 (decision 0030).</summary>
    public int? UnnamedProxies { get; private init; }

    /// <summary>The bytes of body every request together holds at once.</summary>
    public long? BodyBytesBudget { get; private init; }

    /// <summary>The bytes one request's body holds at most.</summary>
    public int? MaximumBodyBytes { get; private init; }

    /// <summary>How long a request's head may take to come whole.</summary>
    public TimeSpan? HeadersTimeout { get; private init; }

    /// <summary>The slowest a request's body may come once its grace passed, in bytes a second; 0 holds none.</summary>
    public int? MinimumBodyBytesPerSecond { get; private init; }

    /// <summary>How long a body comes before its rate is held.</summary>
    public TimeSpan? BodyGracePeriod { get; private init; }

    /// <summary>The slowest a socket may take what goes to it once its grace passed, in bytes a second; 0 holds none.</summary>
    public int? MinimumSendBytesPerSecond { get; private init; }

    /// <summary>The least time what goes is given to be taken.</summary>
    public TimeSpan? SendGracePeriod { get; private init; }

    /// <summary>The connections it holds at once.</summary>
    public int? MaximumConnections { get; private init; }

    /// <summary>The connections one client's address holds at once.</summary>
    public int? MaximumConnectionsPerAddress { get; private init; }

    /// <summary>
    /// A policy of <paramref name="given"/>'s members, checked once as a listener checks its own: an
    /// entry of its hosts, its origins or its proxies none takes is an
    /// <see cref="ArgumentException"/> naming it; a count not above 0, a rate under 0, or a duration
    /// off its range, finite, an <see cref="ArgumentOutOfRangeException"/>.
    /// </summary>
    public static HttpPolicy Of(HttpPolicyOptions given)
    {
        ArgumentNullException.ThrowIfNull(given);

        HostsAndOrigins.AssertHosts(given.Hosts, nameof(HttpPolicyOptions.Hosts));
        HostsAndOrigins.AssertOrigins(given.Origins, nameof(HttpPolicyOptions.Origins));
        Bead.TrustedProxies.TrustOf((given.TrustedProxies, nameof(HttpPolicyOptions.TrustedProxies)), (given.UnnamedProxies ?? 0, nameof(HttpPolicyOptions.UnnamedProxies)));

        foreach (var (name, count) in new (string Name, long? Count)[]
        {
            (nameof(HttpPolicyOptions.BodyBytesBudget), given.BodyBytesBudget),
            (nameof(HttpPolicyOptions.MaximumBodyBytes), given.MaximumBodyBytes),
            (nameof(HttpPolicyOptions.MaximumConnections), given.MaximumConnections),
            (nameof(HttpPolicyOptions.MaximumConnectionsPerAddress), given.MaximumConnectionsPerAddress),
        })
        {
            if (count is { } value)
            {
                ServerBounds.AssertCount((name, value));
            }
        }

        foreach (var (name, rate) in new (string Name, int? Rate)[]
        {
            (nameof(HttpPolicyOptions.MinimumBodyBytesPerSecond), given.MinimumBodyBytesPerSecond),
            (nameof(HttpPolicyOptions.MinimumSendBytesPerSecond), given.MinimumSendBytesPerSecond),
        })
        {
            if (rate is { } value)
            {
                ServerBounds.AssertCountOrNone((name, value));
            }
        }

        return new HttpPolicy
        {
            Hosts = given.Hosts is { } hosts ? [.. hosts] : null,
            Origins = given.Origins is { } origins ? [.. origins] : null,
            TrustedProxies = given.TrustedProxies is { } proxies ? [.. proxies] : null,
            UnnamedProxies = given.UnnamedProxies,
            BodyBytesBudget = given.BodyBytesBudget,
            MaximumBodyBytes = given.MaximumBodyBytes,
            HeadersTimeout = HeldOf((nameof(HttpPolicyOptions.HeadersTimeout), given.HeadersTimeout)),
            MinimumBodyBytesPerSecond = given.MinimumBodyBytesPerSecond,
            BodyGracePeriod = HeldOf((nameof(HttpPolicyOptions.BodyGracePeriod), given.BodyGracePeriod)),
            MinimumSendBytesPerSecond = given.MinimumSendBytesPerSecond,
            SendGracePeriod = HeldOf((nameof(HttpPolicyOptions.SendGracePeriod), given.SendGracePeriod)),
            MaximumConnections = given.MaximumConnections,
            MaximumConnectionsPerAddress = given.MaximumConnectionsPerAddress,
        };
    }

    /// <summary>
    /// A listener's member of <paramref name="name"/>: its policy's, where the policy gives one and
    /// the listener's own is at its default; its own, where the policy gives none. One given in the
    /// policy and beside it, away from its default, is an <see cref="ArgumentException"/>, so that a
    /// listener never takes one value of two in silence.
    /// </summary>
    internal static IReadOnlyList<string>? Taken(string name, (IReadOnlyList<string>? Own, IReadOnlyList<string>? Default, IReadOnlyList<string>? Policy) member)
    {
        if (member.Policy is not { } given)
        {
            return member.Own;
        }

        if (!(member.Own ?? []).SequenceEqual(member.Default ?? [], StringComparer.Ordinal))
        {
            throw new ArgumentException($"{name} is given in the policy and beside it: give it once", name);
        }

        return given;
    }

    /// <summary>A listener's member that is a value, as a list's is taken.</summary>
    internal static T Taken<T>(string name, (T Own, T Default, T? Policy) member)
        where T : struct
    {
        if (member.Policy is not { } given)
        {
            return member.Own;
        }

        if (!EqualityComparer<T>.Default.Equals(member.Own, member.Default))
        {
            throw new ArgumentException($"{name} is given in the policy and beside it: give it once", name);
        }

        return given;
    }

    private static TimeSpan? HeldOf((string Name, TimeSpan? Duration) given)
    {
        return given.Duration is { } duration ? Clocks.AssertHeldFinite((given.Name, given.Name), duration) : null;
    }
}

/// <summary>What an <see cref="HttpPolicy"/> is built of: each member the listeners' option of its name, none where it is not given.</summary>
public sealed record HttpPolicyOptions
{
    /// <summary>As <see cref="HttpPolicy.Hosts"/>.</summary>
    public IReadOnlyList<string>? Hosts { get; init; }

    /// <summary>As <see cref="HttpPolicy.Origins"/>.</summary>
    public IReadOnlyList<string>? Origins { get; init; }

    /// <summary>As <see cref="HttpPolicy.TrustedProxies"/>.</summary>
    public IReadOnlyList<string>? TrustedProxies { get; init; }

    /// <summary>As <see cref="HttpPolicy.UnnamedProxies"/>.</summary>
    public int? UnnamedProxies { get; init; }

    /// <summary>As <see cref="HttpPolicy.BodyBytesBudget"/>.</summary>
    public long? BodyBytesBudget { get; init; }

    /// <summary>As <see cref="HttpPolicy.MaximumBodyBytes"/>.</summary>
    public int? MaximumBodyBytes { get; init; }

    /// <summary>As <see cref="HttpPolicy.HeadersTimeout"/>.</summary>
    public TimeSpan? HeadersTimeout { get; init; }

    /// <summary>As <see cref="HttpPolicy.MinimumBodyBytesPerSecond"/>.</summary>
    public int? MinimumBodyBytesPerSecond { get; init; }

    /// <summary>As <see cref="HttpPolicy.BodyGracePeriod"/>.</summary>
    public TimeSpan? BodyGracePeriod { get; init; }

    /// <summary>As <see cref="HttpPolicy.MinimumSendBytesPerSecond"/>.</summary>
    public int? MinimumSendBytesPerSecond { get; init; }

    /// <summary>As <see cref="HttpPolicy.SendGracePeriod"/>.</summary>
    public TimeSpan? SendGracePeriod { get; init; }

    /// <summary>As <see cref="HttpPolicy.MaximumConnections"/>.</summary>
    public int? MaximumConnections { get; init; }

    /// <summary>As <see cref="HttpPolicy.MaximumConnectionsPerAddress"/>.</summary>
    public int? MaximumConnectionsPerAddress { get; init; }
}
