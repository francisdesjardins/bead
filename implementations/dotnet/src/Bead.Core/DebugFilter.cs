using System.Globalization;
using System.Text;

namespace Bead;

/// <summary>
/// What a debug listener hears: the directions, the types of call, the kinds of envelope and the
/// procedures it keeps, and those it leaves out; each list left empty keeps every one. Two filters
/// of the same lists are equal, whatever lists hold them.
/// </summary>
public sealed record DebugFilter
{
    // the directions, by the grammar's rule `direction`
    private static readonly (string Name, DebugDirection Value)[] DirectionNames =
    [
        ("rx", DebugDirection.Rx),
        ("tx", DebugDirection.Tx),
    ];

    // the types of call, by the grammar's rule `type`: the trace's words, then their short forms
    private static readonly (string Name, DebugType Value)[] TypeNames =
    [
        ("request", DebugType.Request),
        ("command", DebugType.Command),
        ("notification", DebugType.Notification),
        ("r", DebugType.Request),
        ("c", DebugType.Command),
        ("n", DebugType.Notification),
    ];

    // the kinds of envelope, by their names in section 3.1 of spec.md, in lower case, in the order of
    // their numbers
    private static readonly (string Name, EnvelopeKind Value)[] KindNames =
    [
        ("request", EnvelopeKind.Request),
        ("result", EnvelopeKind.Result),
        ("failure", EnvelopeKind.Failure),
        ("notification", EnvelopeKind.Notification),
        ("chunk", EnvelopeKind.Chunk),
        ("credit", EnvelopeKind.Credit),
        ("cancel", EnvelopeKind.Cancel),
    ];

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

    // helpers

    // ! a separator is a comma or one of the six characters C's isspace reads as white space in the
    // C locale: nothing outside ASCII parts two words (spec/debugging.md 6.2)
    private static bool IsSeparator(char character)
    {
        return character is ',' or ' ' or '\t' or '\n' or '\v' or '\f' or '\r';
    }

    // a character lowered when it is an ASCII capital, and as it is otherwise: U+212A and U+0130 stay
    private static int FoldedOf(int codePoint)
    {
        return codePoint is >= 'A' and <= 'Z' ? codePoint + ('a' - 'A') : codePoint;
    }

    // a text with its ASCII capitals lowered, and nothing else
    private static string AsciiLowerOf(string text)
    {
        return string.Create(text.Length, text, static (lowered, given) =>
        {
            for (var index = 0; index < given.Length; index += 1)
            {
                lowered[index] = (char)FoldedOf(given[index]);
            }
        });
    }

    // a text's code points, a pair of surrogates as one, and a lone surrogate as itself
    private static int[] CodePointsOf(string text)
    {
        var codePoints = new List<int>(text.Length);

        for (var index = 0; index < text.Length; index += 1)
        {
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                codePoints.Add(char.ConvertToUtf32(text[index], text[index + 1]));
                index += 1;

                continue;
            }

            codePoints.Add(text[index]);
        }

        return [.. codePoints];
    }

    // whether a name matches a pattern whole, both by code point: * any run, none included, line
    // terminators among them; an ASCII letter itself in either case; any other code point itself
    // alone. The last star takes one more character each time what follows it does not match
    private static bool MatchesWhole(int[] pattern, int[] name)
    {
        const int Star = '*';
        var (at, of, star, reached) = (0, 0, -1, 0);

        while (of < name.Length)
        {
            if (at < pattern.Length && pattern[at] != Star && FoldedOf(pattern[at]) is var wanted
                && (pattern[at] == name[of] || (wanted is >= 'a' and <= 'z' && wanted == FoldedOf(name[of]))))
            {
                at += 1;
                of += 1;
            }
            else if (at < pattern.Length && pattern[at] == Star)
            {
                star = at;
                at += 1;
                reached = of;
            }
            else if (star != -1)
            {
                at = star + 1;
                reached += 1;
                of = reached;
            }
            else
            {
                return false;
            }
        }

        while (at < pattern.Length && pattern[at] == Star)
        {
            at += 1;
        }

        return at == pattern.Length;
    }

    // a pattern as it matches a whole name
    private static Func<string, bool> PatternOf(string pattern)
    {
        ArgumentNullException.ThrowIfNull(pattern);

        var codePoints = CodePointsOf(pattern);

        return (name) =>
        {
            return MatchesWhole(codePoints, CodePointsOf(name));
        };
    }

    // a value quoted as JSON writes a string (RFC 8259), as JSON.stringify writes it: a quote, a
    // backslash and each control character escaped, a lone surrogate written \u its four digits,
    // and every other character as it is
    internal static string QuotedOf(string value)
    {
        var quoted = new StringBuilder(value.Length + 2).Append('"');

        for (var index = 0; index < value.Length; index += 1)
        {
            var character = value[index];

            if (char.IsHighSurrogate(character) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                quoted.Append(character).Append(value[index + 1]);
                index += 1;

                continue;
            }

            quoted.Append(character switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\b' => "\\b",
                '\f' => "\\f",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                _ when character < ' ' || char.IsSurrogate(character) => string.Create(CultureInfo.InvariantCulture, $"\\u{(int)character:x4}"),
                _ => character.ToString(),
            });
        }

        return quoted.Append('"').ToString();
    }

    // what a selector's letter takes, named for a refusal: "direction among rx, tx"
    private static string TakenOf<TValue>((string Name, TValue Value)[] named, string what)
    {
        return $"{what} among {string.Join(", ", named.Select((each) => { return each.Name; }))}";
    }

    // one selector's values as they were written within `word`'s parentheses, each read in ASCII
    // case: the first left empty, or that names none of its letter's, refuses the filter
    private static List<TValue> SelectedOf<TValue>(string[] values, ((string Name, TValue Value)[] Named, string What, string Word) selected)
    {
        var (named, what, word) = selected;

        return [.. values.Select((value) =>
        {
            if (value.Length == 0)
            {
                throw new ArgumentException($"a debug filter's selector leaves no value empty, not {QuotedOf(word)}");
            }

            var lowered = AsciiLowerOf(value);

            foreach (var (name, each) in named)
            {
                if (string.Equals(name, lowered, StringComparison.Ordinal))
                {
                    return each;
                }
            }

            throw new ArgumentException($"a debug filter takes a {TakenOf(named, what)}, not {QuotedOf(value)}");
        })];
    }

    // a spec's words, parted on runs of separators, none empty
    private static IEnumerable<string> WordsOf(string spec)
    {
        var start = 0;

        for (var index = 0; index <= spec.Length; index += 1)
        {
            if (index < spec.Length && !IsSeparator(spec[index]))
            {
                continue;
            }

            if (index > start)
            {
                yield return spec[start..index];
            }

            start = index + 1;
        }
    }

    // values given whole, each checked to be one of the grammar's, named for a refusal in its names
    private static IReadOnlyList<TValue> ValuesOf<TValue>(IReadOnlyList<TValue> values, ((string Name, TValue Value)[] Named, string What) known)
        where TValue : struct, Enum
    {
        ArgumentNullException.ThrowIfNull(values);

        var names = known.Named.DistinctBy((each) =>
        {
            return each.Value;
        }).ToArray();

        foreach (var value in values)
        {
            if (!names.Any((each) => { return EqualityComparer<TValue>.Default.Equals(each.Value, value); }))
            {
                throw new ArgumentException(
                    $"a debug filter takes a {TakenOf(names, known.What)}, not {QuotedOf(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture))}");
            }
        }

        return values;
    }

    // definition

    /// <summary>
    /// A filter, from its spec, as <c>spec/debugging.md</c> states it (section 6): words parted by
    /// commas or ASCII white space, as the <c>DEBUG</c> variable of the <c>debug</c> package has
    /// them. <c>d(rx)</c> or <c>d(tx)</c> keeps a direction; <c>t(request)</c>, <c>t(command)</c>
    /// or <c>t(notification)</c> a call's type, <c>r</c>, <c>c</c> and <c>n</c> its short forms;
    /// <c>e(request)</c>, <c>e(result)</c>, <c>e(failure)</c>, <c>e(notification)</c>,
    /// <c>e(chunk)</c>, <c>e(credit)</c> or <c>e(cancel)</c> an envelope's kind;
    /// <c>d(rx|tx)</c>, <c>t(r|c)</c> or <c>e(request|failure)</c> keeps either, and selectors of
    /// one letter add up. A selector's letter and its values are read in ASCII case. <c>-name</c>
    /// leaves a procedure out, which wins, and any other word is a procedure to keep, matched whole,
    /// <c>*</c> standing for any run of characters and an ASCII letter for itself in either case.
    /// Each list keeps the order of its words, a value given twice kept twice. The first word that
    /// does not hold is an <see cref="ArgumentException"/>, naming it, or its value, as it was
    /// written, quoted as JSON: a selector empty or with a value left empty, a value that names none
    /// of its letter's, a word holding a parenthesis that is no selector.
    /// </summary>
    /// <example><c>DebugFilter.Parse("d(rx), t(r|c), e(failure), get*, -getStatus")</c></example>
    public static DebugFilter Parse(string spec)
    {
        ArgumentNullException.ThrowIfNull(spec);

        var directions = new List<DebugDirection>();
        var types = new List<DebugType>();
        var kinds = new List<EnvelopeKind>();
        var include = new List<string>();
        var exclude = new List<string>();

        foreach (var word in WordsOf(spec))
        {
            var letter = (char)FoldedOf(word[0]);

            // a selector: d(…) for directions, t(…) for types, e(…) for an envelope's kinds, their
            // values parted by |
            if (word.Length >= 3 && word[1] == '(' && word[^1] == ')' && letter is 'd' or 't' or 'e')
            {
                var within = word[2..^1];

                if (within.Length == 0)
                {
                    throw new ArgumentException($"a debug filter's selector names a value, not {QuotedOf(word)}");
                }

                var values = within.Split('|');

                switch (letter)
                {
                    case 'd':
                        directions.AddRange(SelectedOf(values, (DirectionNames, "direction", word)));
                        break;
                    case 't':
                        types.AddRange(SelectedOf(values, (TypeNames, "type", word)));
                        break;
                    default:
                        kinds.AddRange(SelectedOf(values, (KindNames, "kind", word)));
                        break;
                }
            }
            else if (word.Contains('(', StringComparison.Ordinal) || word.Contains(')', StringComparison.Ordinal))
            {
                throw new ArgumentException($"a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not {QuotedOf(word)}");
            }
            else if (word.StartsWith('-'))
            {
                exclude.Add(word[1..]);
            }
            else
            {
                include.Add(word);
            }
        }

        return new DebugFilter
        {
            Directions = directions,
            Exclude = exclude,
            Include = include,
            Kinds = kinds,
            Types = types,
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

    /// <summary>
    /// Whether a call's event passes: its direction, its type, its procedure's name. A filter given
    /// whole holding a value the grammar names none of is an <see cref="ArgumentException"/>, in the
    /// grammar's names.
    /// </summary>
    internal Func<DebugEvent, bool> CallPredicate()
    {
        var directions = ValuesOf(Directions, (DirectionNames, "direction"));
        var types = ValuesOf(Types, (TypeNames, "type"));
        var include = Include.Select(PatternOf).ToArray();
        var exclude = Exclude.Select(PatternOf).ToArray();

        return (debugEvent) =>
        {
            return (directions.Count == 0 || directions.Contains(debugEvent.Direction))
                && (types.Count == 0 || types.Contains(debugEvent.Type))
                && (include.Length == 0 || include.Any((matches) =>
                {
                    return matches(debugEvent.ProcedureName);
                }))
                && !exclude.Any((matches) =>
                {
                    return matches(debugEvent.ProcedureName);
                });
        };
    }

    /// <summary>Whether an envelope passes: its direction and its kind; it carries no name.</summary>
    internal Func<(DebugDirection Direction, TracedEnvelope Envelope), bool> EnvelopePredicate()
    {
        var directions = ValuesOf(Directions, (DirectionNames, "direction"));
        var kinds = ValuesOf(Kinds, (KindNames, "kind"));

        return (traced) =>
        {
            return (directions.Count == 0 || directions.Contains(traced.Direction))
                && (kinds.Count == 0 || kinds.Contains(traced.Envelope.Header.Kind));
        };
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
