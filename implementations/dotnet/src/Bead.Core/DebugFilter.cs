using System.Text.RegularExpressions;

namespace Bead;

/// <summary>
/// What a debug listener hears: the directions, the types of call, the kinds of envelope and the
/// procedures it keeps, and those it leaves out; each list left empty keeps every one. Two filters
/// of the same lists are equal, whatever lists hold them.
/// </summary>
public sealed record DebugFilter
{
    // a spec's words part on commas and on white space, as DEBUG's do
    private static readonly Regex Separators = new(@"[\s,]+", RegexOptions.CultureInvariant);

    // a spec names a type by its first letter, as it names a direction by its two
    private static readonly Dictionary<string, DebugType> TypeLetters = new()
    {
        ["c"] = DebugType.Command,
        ["n"] = DebugType.Notification,
        ["r"] = DebugType.Request,
    };

    private static readonly Dictionary<string, DebugDirection> DirectionNames = new()
    {
        ["rx"] = DebugDirection.Rx,
        ["tx"] = DebugDirection.Tx,
    };

    // a spec names a kind as its constant does, which a letter could not: a request, a result
    private static readonly Dictionary<string, EnvelopeKind> KindNames = Enum.GetValues<EnvelopeKind>().ToDictionary((kind) =>
    {
        return kind.ToString().ToLowerInvariant();
    });

    /// <summary>The directions kept.</summary>
    public IReadOnlyList<DebugDirection> Directions { get; init; } = [];

    /// <summary>The procedures left out, by a pattern of their name: <c>*</c> for any run of characters.</summary>
    public IReadOnlyList<string> Exclude { get; init; } = [];

    /// <summary>The procedures kept, by a pattern of their name: <c>*</c> for any run of characters.</summary>
    public IReadOnlyList<string> Include { get; init; } = [];

    /// <summary>The kinds of envelope a router's <c>Debug</c> tells of; a call's listener does not ask.</summary>
    public IReadOnlyList<EnvelopeKind> Kinds { get; init; } = [];

    /// <summary>The types of call kept.</summary>
    public IReadOnlyList<DebugType> Types { get; init; } = [];

    /// <summary>
    /// A filter, from its spec: words parted by commas or white space, as the <c>DEBUG</c> variable of
    /// the <c>debug</c> package has them. <c>d(rx)</c> or <c>d(tx)</c> keeps a direction;
    /// <c>t(r)</c>, <c>t(n)</c> or <c>t(c)</c> a call's type — a request, a notification or a
    /// command, by its first letter; <c>e(request)</c>, <c>e(result)</c>, <c>e(failure)</c>,
    /// <c>e(notification)</c>, <c>e(chunk)</c>, <c>e(credit)</c> or <c>e(cancel)</c> an envelope's
    /// kind, by its name; <c>d(rx|tx)</c>, <c>t(r|c)</c> or <c>e(request|failure)</c> keeps either.
    /// <c>-name</c> leaves a procedure out, and any other word is a procedure to keep, <c>*</c>
    /// standing for any run of characters. A direction, a type letter or a kind that is not one is an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    /// <example><c>DebugFilter.Parse("d(rx), t(r|c), e(failure), get*, -getStatus")</c></example>
    public static DebugFilter Parse(string spec)
    {
        ArgumentNullException.ThrowIfNull(spec);

        var directions = new List<string>();
        var kinds = new List<string>();
        var types = new List<string>();
        var include = new List<string>();
        var exclude = new List<string>();

        foreach (var word in Separators.Split(spec))
        {
            // a selector: d(…) for directions, t(…) for types, e(…) for an envelope's kinds, their
            // values parted by |
            if (word.Length >= 3 && word[1] == '(' && word[^1] == ')' && char.ToLowerInvariant(word[0]) is 'd' or 'e' or 't')
            {
                var values = word[2..^1].Split('|');
                var selected = char.ToLowerInvariant(word[0]) switch
                {
                    'd' => directions,
                    'e' => kinds,
                    _ => types,
                };

                selected.AddRange(values);
            }
            else if (word.StartsWith('-'))
            {
                exclude.Add(word[1..]);
            }
            else if (word.Length > 0)
            {
                include.Add(word);
            }
        }

        return new DebugFilter
        {
            Directions = NamedOf(directions, (DirectionNames, "direction")),
            Exclude = exclude,
            Include = include,
            Kinds = NamedOf(kinds, (KindNames, "kind")),
            Types = NamedOf(types, (TypeLetters, "type")),
        };
    }

    /// <inheritdoc/>
    public bool Equals(DebugFilter? other)
    {
        return other is not null
            && Directions.SequenceEqual(other.Directions)
            && Exclude.SequenceEqual(other.Exclude)
            && Include.SequenceEqual(other.Include)
            && Kinds.SequenceEqual(other.Kinds)
            && Types.SequenceEqual(other.Types);
    }

    /// <inheritdoc/>
    public override int GetHashCode()
    {
        return HashCode.Combine(Directions.Count, Exclude.Count, Include.Count, Kinds.Count, Types.Count);
    }

    /// <summary>Whether a call's event passes: its direction, its type, its procedure's name.</summary>
    internal Func<DebugEvent, bool> CallPredicate()
    {
        var directions = ValuesOf(Directions, "direction");
        var types = ValuesOf(Types, "type");
        var include = Include.Select(PatternOf).ToArray();
        var exclude = Exclude.Select(PatternOf).ToArray();

        return (debugEvent) =>
        {
            return (directions.Count == 0 || directions.Contains(debugEvent.Direction))
                && (types.Count == 0 || types.Contains(debugEvent.Type))
                && (include.Length == 0 || include.Any((pattern) =>
                {
                    return pattern.IsMatch(debugEvent.ProcedureName);
                }))
                && !exclude.Any((pattern) =>
                {
                    return pattern.IsMatch(debugEvent.ProcedureName);
                });
        };
    }

    /// <summary>Whether an envelope passes: its direction and its kind; it carries no name.</summary>
    internal Func<(DebugDirection Direction, TracedEnvelope Envelope), bool> EnvelopePredicate()
    {
        var directions = ValuesOf(Directions, "direction");
        var kinds = ValuesOf(Kinds, "kind");

        return (traced) =>
        {
            return (directions.Count == 0 || directions.Contains(traced.Direction))
                && (kinds.Count == 0 || kinds.Contains(traced.Envelope.Header.Kind));
        };
    }

    // values, each checked to be one its enum defines, as `what` names them
    private static IReadOnlyList<TValue> ValuesOf<TValue>(IReadOnlyList<TValue> values, string what)
        where TValue : struct, Enum
    {
        ArgumentNullException.ThrowIfNull(values);

        foreach (var value in values)
        {
            if (!Enum.IsDefined(value))
            {
                throw new ArgumentException(
                    $"a debug filter takes a {what} among {string.Join(", ", Enum.GetNames<TValue>())}, not {value}");
            }
        }

        return values;
    }

    // each of `words`, lowered, as `named` names it; `what` says what they are, should one not be
    private static List<TValue> NamedOf<TValue>(List<string> words, (Dictionary<string, TValue> Named, string What) naming)
    {
        return words.ConvertAll((word) =>
        {
            if (!naming.Named.TryGetValue(word.ToLowerInvariant(), out var value))
            {
                throw new ArgumentException(
                    $"a debug filter takes a {naming.What} among {string.Join(", ", naming.Named.Keys)}, not \"{word}\"");
            }

            return value;
        });
    }

    // a pattern as it matches a whole name, without regard to case: * for any run of characters
    private static Regex PatternOf(string pattern)
    {
        ArgumentNullException.ThrowIfNull(pattern);

        return new Regex(
            $"^{Regex.Escape(pattern).Replace("\\*", ".*", StringComparison.Ordinal)}$",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase | RegexOptions.NonBacktracking);
    }
}

/// <summary>
/// Debug listeners that hear only what a <see cref="DebugFilter"/> keeps. A filter is given as it
/// is, as a spec, or as a function asked at each event — read again only when it gives other than
/// it gave last, compiled again only when that reads as another filter, and left as it was when
/// that no longer holds, or the function throws, since a trace never fails a call. The first must
/// hold, or the listener is not made: an <see cref="ArgumentException"/>.
/// </summary>
public static class DebugFilters
{
    /// <summary>
    /// <paramref name="listener"/>, hearing only the events of the calls <paramref name="filter"/>
    /// keeps: their direction, their type, their procedure's name; an envelope's kind says nothing of
    /// a call, and is not asked.
    /// </summary>
    public static Action<Exception?, DebugEvent> FilterDebug(Action<Exception?, DebugEvent> listener, DebugFilter filter)
    {
        return CallsOf(listener, () =>
        {
            return filter;
        });
    }

    /// <summary><paramref name="listener"/>, hearing only the calls <paramref name="spec"/> keeps, as <see cref="DebugFilter.Parse"/> reads it.</summary>
    public static Action<Exception?, DebugEvent> FilterDebug(Action<Exception?, DebugEvent> listener, string spec)
    {
        return CallsOf(listener, () =>
        {
            return spec;
        });
    }

    /// <summary>
    /// <paramref name="listener"/>, hearing only the calls the filter <paramref name="source"/> gives
    /// at each event keeps; none keeps every one.
    /// </summary>
    /// <example><c>manager.Debug += DebugFilters.FilterDebug(listener, () => Environment.GetEnvironmentVariable("DEBUG_CALLS"))</c></example>
    public static Action<Exception?, DebugEvent> FilterDebug(Action<Exception?, DebugEvent> listener, Func<string?> source)
    {
        return CallsOf(listener, source);
    }

    /// <summary>
    /// <paramref name="listener"/>, hearing only the calls the filter <paramref name="source"/> gives
    /// at each event keeps; none keeps every one.
    /// </summary>
    public static Action<Exception?, DebugEvent> FilterDebug(Action<Exception?, DebugEvent> listener, Func<DebugFilter?> source)
    {
        return CallsOf(listener, source);
    }

    /// <summary>
    /// <paramref name="listener"/>, hearing only the envelopes a router's <c>Debug</c> tells of that
    /// <paramref name="filter"/> keeps: their direction and their kind. An envelope carries no
    /// procedure's name, and a call's type is the services': names and types are not asked, so one
    /// spec serves both listeners.
    /// </summary>
    public static Action<DebugDirection, TracedEnvelope> FilterEnvelopeDebug(Action<DebugDirection, TracedEnvelope> listener, DebugFilter filter)
    {
        return EnvelopesOf(listener, () =>
        {
            return filter;
        });
    }

    /// <summary><paramref name="listener"/>, hearing only the envelopes <paramref name="spec"/> keeps, as <see cref="DebugFilter.Parse"/> reads it.</summary>
    public static Action<DebugDirection, TracedEnvelope> FilterEnvelopeDebug(Action<DebugDirection, TracedEnvelope> listener, string spec)
    {
        return EnvelopesOf(listener, () =>
        {
            return spec;
        });
    }

    /// <summary>
    /// <paramref name="listener"/>, hearing only the envelopes the filter <paramref name="source"/>
    /// gives at each event keeps; none keeps every one.
    /// </summary>
    public static Action<DebugDirection, TracedEnvelope> FilterEnvelopeDebug(Action<DebugDirection, TracedEnvelope> listener, Func<string?> source)
    {
        return EnvelopesOf(listener, source);
    }

    /// <summary>
    /// <paramref name="listener"/>, hearing only the envelopes the filter <paramref name="source"/>
    /// gives at each event keeps; none keeps every one.
    /// </summary>
    public static Action<DebugDirection, TracedEnvelope> FilterEnvelopeDebug(Action<DebugDirection, TracedEnvelope> listener, Func<DebugFilter?> source)
    {
        return EnvelopesOf(listener, source);
    }

    private static Action<Exception?, DebugEvent> CallsOf(Action<Exception?, DebugEvent> listener, Func<object?> source)
    {
        ArgumentNullException.ThrowIfNull(listener);

        var keeps = KeeperOf<DebugEvent>(source, (filter) =>
        {
            return filter.CallPredicate();
        });

        return (error, debugEvent) =>
        {
            if (keeps(debugEvent))
            {
                listener(error, debugEvent);
            }
        };
    }

    private static Action<DebugDirection, TracedEnvelope> EnvelopesOf(Action<DebugDirection, TracedEnvelope> listener, Func<object?> source)
    {
        ArgumentNullException.ThrowIfNull(listener);

        var keeps = KeeperOf<(DebugDirection, TracedEnvelope)>(source, (filter) =>
        {
            return filter.EnvelopePredicate();
        });

        return (direction, envelope) =>
        {
            if (keeps((direction, envelope)))
            {
                listener(direction, envelope);
            }
        };
    }

    // what a filter's source gives now, as a filter: a spec read, a filter as it is, none for every one
    private static DebugFilter FilterOf(object? given)
    {
        return given switch
        {
            string spec => DebugFilter.Parse(spec),
            DebugFilter filter => filter,
            _ => new DebugFilter(),
        };
    }

    // whether an event passes the filter `source` gives, as `predicateOf` compiles it; events may
    // come from more than one thread, so what it keeps is kept under a lock
    private static Func<TEvent, bool> KeeperOf<TEvent>(Func<object?> source, Func<DebugFilter, Func<TEvent, bool>> predicateOf)
    {
        ArgumentNullException.ThrowIfNull(source);

        var gate = new Lock();
        var given = source();
        var filter = FilterOf(given);
        var predicate = predicateOf(filter);

        return (debugEvent) =>
        {
            Func<TEvent, bool> current;

            lock (gate)
            {
                try
                {
                    var next = source();

                    // a burst of events asks a hundred times for the one spec it was given: none is
                    // read twice
                    if (!Equals(next, given))
                    {
                        var resolved = FilterOf(next);

                        if (resolved != filter)
                        {
                            predicate = predicateOf(resolved);
                            filter = resolved;
                        }

                        given = next;
                    }
                }
                catch (Exception)
                {
                    // the last filter that held stays: a filter that fails never fails the call it traces
                }

                current = predicate;
            }

            return current(debugEvent);
        };
    }
}
