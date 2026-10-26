using System.Text;
using System.Text.Json;

namespace Bead.Protobuf;

/// <summary>
/// A rule's site, a constant of a generated file: what every violation of it says — its rule's id,
/// its words, its bounds and whether it is a map key's — fixed when beadc writes it.
/// </summary>
public sealed record ViolationRule
{
    /// <summary>Its rule's id, protovalidate's <c>rule_id</c>.</summary>
    public required string RuleId { get; init; }

    /// <summary>Its words, spec 18.8.6's.</summary>
    public required string Message { get; init; }

    /// <summary>The members its rule takes, a JSON object as protobuf's JSON mapping writes them; none for a rule that takes none.</summary>
    public JsonElement? Bounds { get; init; }

    /// <summary>Whether it judges a map's key.</summary>
    public bool ForKey { get; init; }
}

/// <summary>
/// Where a generated file's rules write, in spec 18.5's order: a violation at the path the sink
/// stands at, and the steps of that path. A sink builds a path only for a violation it keeps.
/// </summary>
public interface IViolationSink
{
    /// <summary>Adds a violation of <paramref name="rule"/>, of <paramref name="value"/>; true where the judging stops there (failFast).</summary>
    bool Add(ViolationRule rule, object? value);

    /// <summary>Steps into the field <paramref name="name"/> of the message it stands at, or names its oneof.</summary>
    void Enter(string name);

    /// <summary>Steps into the item <paramref name="index"/> of the repeated field <paramref name="name"/>.</summary>
    void EnterIndex(string name, int index);

    /// <summary>Steps into the entry of the string key <paramref name="key"/> of the map field <paramref name="name"/>.</summary>
    void EnterKey(string name, string key);

    /// <summary>Steps into the entry of the signed key <paramref name="key"/> of the map field <paramref name="name"/>.</summary>
    void EnterKey(string name, long key);

    /// <summary>Steps into the entry of the unsigned key <paramref name="key"/> of the map field <paramref name="name"/>.</summary>
    void EnterKey(string name, ulong key);

    /// <summary>Steps into the entry of the bool key <paramref name="key"/> of the map field <paramref name="name"/>.</summary>
    void EnterKey(string name, bool key);

    /// <summary>Steps back out of the last field it stepped into.</summary>
    void Leave();
}

/// <summary>
/// What the validators beadc generates are made of (decision 0035): a validator of a message's
/// rules, the lengths and orders those rules read, and the bounds of a rule's site. The TypeScript
/// side's twin is <c>validatorOf</c> and its helpers, of <c>@francisdesjardins/bead/proto</c>.
/// </summary>
public static class Validators
{
    // helpers

    // strings by their code points (spec 18.5): an ordinal comparison of UTF-16 code units but
    // where a surrogate meets a unit from U+E000, which code points order the other way
    private static readonly Comparer<string> ByCodePoints = Comparer<string>.Create((one, other) =>
    {
        var length = Math.Min(one.Length, other.Length);

        for (var index = 0; index < length; index += 1)
        {
            if (one[index] != other[index])
            {
                return OrderOf(one[index]) - OrderOf(other[index]);
            }
        }

        return one.Length - other.Length;
    });

    // a UTF-16 unit's place among code points: a surrogate after every unit below U+10000
    private static int OrderOf(char unit)
    {
        if (unit < 0xD800)
        {
            return unit;
        }

        return unit >= 0xE000 ? unit - 0x800 : unit + 0x2000;
    }

    // definition

    /// <summary>
    /// The validator of a message's <paramref name="rules"/>, as a binding's <c>Validate</c> takes
    /// it: its rules judged into a sink that keeps the violations a detail of its options' bound
    /// carries and counts the rest, or stops at the first under <see cref="ValidateOptions.FailFast"/>.
    /// A request that breaks nothing builds no violation and no path. A request that is null is an
    /// <see cref="ArgumentNullException"/>.
    /// </summary>
    public static RequestValidator<TMessage> Of<TMessage>(Func<TMessage, IViolationSink, bool> rules)
    {
        ArgumentNullException.ThrowIfNull(rules);

        return (request, options) =>
        {
            ArgumentNullException.ThrowIfNull(request);
            ArgumentNullException.ThrowIfNull(options);

            var sink = new ViolationSink(options);

            return sink.JudgedOf(rules(request, sink));
        };
    }

    /// <summary>A rule's bounds from their JSON object's text, as a generated file gives them; any other text is an <see cref="ArgumentException"/>.</summary>
    public static JsonElement BoundsOf(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        using var document = JsonDocument.Parse(json);

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("a rule's bounds are a JSON object", nameof(json));
        }

        return document.RootElement.Clone();
    }

    /// <summary>A string's length in code points (spec 18.8.2), a surrogate alone one.</summary>
    public static int CodePointLength(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        var length = 0;

        for (var index = 0; index < text.Length; index += 1)
        {
            // * a pair counts once: its low half is skipped
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
            {
                index += 1;
            }

            length += 1;
        }

        return length;
    }

    /// <summary>A string's length in the UTF-8 it is sent as (spec 18.8.2), a surrogate alone's U+FFFD three bytes.</summary>
    public static int Utf8Length(string text)
    {
        ArgumentNullException.ThrowIfNull(text);

        return Encoding.UTF8.GetByteCount(text);
    }

    /// <summary>Whether no two items are one, as <c>==</c> compares them (spec 18.8.4).</summary>
    public static bool IsUnique<T>(IReadOnlyList<T> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var seen = new HashSet<T>(items.Count);

        foreach (var item in items)
        {
            if (!seen.Add(item))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Whether no two doubles are one, as <c>==</c> compares them (spec 18.8.4): 0 and −0 one, two NaN two.</summary>
    public static bool IsUnique(IReadOnlyList<double> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var seen = new HashSet<double>(items.Count);

        foreach (var item in items)
        {
            // ! NaN equals nothing, itself among it, where a HashSet's own equality takes it as itself
            if (!double.IsNaN(item) && !seen.Add(item == 0 ? 0d : item))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Whether no two floats are one, as <c>==</c> compares them (spec 18.8.4): 0 and −0 one, two NaN two.</summary>
    public static bool IsUnique(IReadOnlyList<float> items)
    {
        ArgumentNullException.ThrowIfNull(items);

        var seen = new HashSet<float>(items.Count);

        foreach (var item in items)
        {
            if (!float.IsNaN(item) && !seen.Add(item == 0 ? 0f : item))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// A map's entries by key (spec 18.5), as protobuf's deterministic serialization orders them:
    /// integers ascending, <c>false</c> before <c>true</c>, strings by code points.
    /// </summary>
    public static IReadOnlyList<KeyValuePair<TKey, TValue>> ByKey<TKey, TValue>(IReadOnlyDictionary<TKey, TValue> map)
        where TKey : notnull
    {
        ArgumentNullException.ThrowIfNull(map);

        if (map.Count == 0)
        {
            return [];
        }

        var entries = map.ToArray();
        var keys = typeof(TKey) == typeof(string) ? (IComparer<TKey>)(object)ByCodePoints : Comparer<TKey>.Default;

        Array.Sort(entries, (one, other) =>
        {
            return keys.Compare(one.Key, other.Key);
        });

        return entries;
    }
}

/// <summary>
/// The sink a validator judges into (spec 18.6): it keeps a violation while a detail of its bound
/// would write it, sized as the writer sizes it with the closing line's bytes kept, and past that
/// counts the rest without building their path; it stops at the first under failFast. The path's
/// steps are held as they are entered, and written only for a violation it keeps.
/// </summary>
internal sealed class ViolationSink(ValidateOptions options) : IViolationSink
{
    private readonly bool _failFast = options.FailFast;
    private readonly int _maximumBytes = options.MaximumBytes;
    private Step[] _steps = [];
    private int _depth;
    private List<Violation>? _violations;
    private int _size;
    private long _more;
    private bool _isFull;

    // what a step of a path holds
    private enum StepKind
    {
        Field,
        Index,
        Text,
        Signed,
        Unsigned,
        Flag,
    }

    public bool Add(ViolationRule rule, object? value)
    {
        ArgumentNullException.ThrowIfNull(rule);

        if (_isFull)
        {
            _more += 1;

            return false;
        }

        var violation = new Violation
        {
            Bounds = rule.Bounds,
            FieldPath = PathOf(),
            ForKey = rule.ForKey,
            Message = rule.Message,
            RuleId = rule.RuleId,
            Value = value,
        };
        var separator = _violations is { Count: > 0 } ? 1 : 0;
        var bytes = Violations.LineBytesOf(violation, _maximumBytes - _size - separator - Violations.ClosingBytes);

        if (bytes < 0)
        {
            _isFull = true;
            _more += 1;
        }
        else
        {
            _size += separator + bytes;
            (_violations ??= []).Add(violation);
        }

        return _failFast;
    }

    public void Enter(string name)
    {
        Push(new Step(StepKind.Field, name));
    }

    public void EnterIndex(string name, int index)
    {
        Push(new Step(StepKind.Index, name) { Number = index });
    }

    public void EnterKey(string name, string key)
    {
        Push(new Step(StepKind.Text, name) { Text = key });
    }

    public void EnterKey(string name, long key)
    {
        Push(new Step(StepKind.Signed, name) { Number = key });
    }

    public void EnterKey(string name, ulong key)
    {
        Push(new Step(StepKind.Unsigned, name) { Unsigned = key });
    }

    public void EnterKey(string name, bool key)
    {
        Push(new Step(StepKind.Flag, name) { Unsigned = key ? 1UL : 0UL });
    }

    public void Leave()
    {
        _depth -= 1;
    }

    /// <summary>What the judging gave, <paramref name="stopped"/> where its rules stopped at a violation.</summary>
    public Judged JudgedOf(bool stopped)
    {
        var isStopped = _failFast && stopped;

        if (_violations is null && _more == 0 && !isStopped)
        {
            return Judged.None;
        }

        return new Judged { More = _more, Stopped = isStopped, Violations = (IReadOnlyList<Violation>?)_violations ?? [] };
    }

    private void Push(Step step)
    {
        if (_depth == _steps.Length)
        {
            Array.Resize(ref _steps, Math.Max(8, _steps.Length * 2));
        }

        _steps[_depth] = step;
        _depth += 1;
    }

    // the path the sink stands at (spec 18.4): its steps by `.`, an item by its index and an entry
    // by its key; none at the message's own
    private string? PathOf()
    {
        if (_depth == 0)
        {
            return null;
        }

        var path = new StringBuilder();

        for (var index = 0; index < _depth; index += 1)
        {
            var step = _steps[index];

            if (index > 0)
            {
                path.Append('.');
            }

            path.Append(step.Name);

            switch (step.Kind)
            {
                case StepKind.Index:
                case StepKind.Signed:
                    path.Append('[').Append(step.Number.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append(']');
                    break;
                case StepKind.Unsigned:
                    path.Append('[').Append(step.Unsigned.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append(']');
                    break;
                case StepKind.Flag:
                    path.Append(step.Unsigned == 1 ? "[true]" : "[false]");
                    break;
                case StepKind.Text:
                    path.Append('[').Append(Violations.KeySubscriptOf(step.Text!)).Append(']');
                    break;
                default:
                    break;
            }
        }

        return path.ToString();
    }

    // one step: a field, or an item or an entry of one, its subscript kept as it was given
    private readonly record struct Step(StepKind Kind, string Name)
    {
        public long Number { get; init; }

        public ulong Unsigned { get; init; }

        public string? Text { get; init; }
    }
}
