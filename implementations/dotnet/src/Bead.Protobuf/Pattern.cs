using System.Collections.Immutable;
using System.Text;

namespace Bead.Protobuf;

/// <summary>
/// A pattern's table, as beadc builds it ahead of time (spec 18.8.5, decision 0035): the DFA of RE2's
/// unanchored search, its code points partitioned into classes, each class written once by the
/// bounds of its ranges, and its transitions one cell a state and a class.
/// </summary>
public sealed record PatternTable
{
    /// <summary>The states that match at the string's end, its end's closure read in them.</summary>
    public required ImmutableArray<int> Accepting { get; init; }

    /// <summary>The first code point of each range, rising from 0; a code point's range is the last that starts at or below it.</summary>
    public required ImmutableArray<int> Bounds { get; init; }

    /// <summary>How many classes the code points fall into: a row's cells.</summary>
    public required int ClassCount { get; init; }

    /// <summary>Each range's class, by its index in <see cref="Bounds"/>.</summary>
    public required ImmutableArray<ushort> Classes { get; init; }

    /// <summary>The state no character leaves, which matches nothing: the walk ends there, refused.</summary>
    public required int Dead { get; init; }

    /// <summary>The state that matched, for good: the walk ends there, taken; -1 where none.</summary>
    public required int Matched { get; init; }

    /// <summary>How many states it holds.</summary>
    public required int StateCount { get; init; }

    /// <summary>Each state's next, by its class: the cell of state s and class c at <c>s × ClassCount + c</c>.</summary>
    public required ImmutableArray<ushort> Transitions { get; init; }
}

/// <summary>
/// A pattern matched by its table (spec 18.8.5): a character's class by a binary search over the
/// table's ranges, then one cell, so its time is a constant per character whatever the pattern,
/// never a backtracking engine's. The TypeScript side's twin is <c>matchesPattern</c>.
/// </summary>
public static class Pattern
{
    /// <summary>
    /// Whether <paramref name="table"/>'s pattern matches anywhere in <paramref name="text"/>, read a
    /// code point at a time, a surrogate alone as U+FFFD, as its UTF-8 would carry it.
    /// </summary>
    public static bool Matches(PatternTable table, string text)
    {
        ArgumentNullException.ThrowIfNull(table);
        ArgumentNullException.ThrowIfNull(text);

        var bounds = table.Bounds;
        var classes = table.Classes;
        var transitions = table.Transitions;
        var state = 0;

        for (var index = 0; index < text.Length;)
        {
            Rune.DecodeFromUtf16(text.AsSpan(index), out var rune, out var consumed);
            index += consumed;

            var point = rune.Value;
            var low = 0;
            var high = bounds.Length - 1;

            while (low < high)
            {
                var middle = (low + high + 1) >> 1;

                if (bounds[middle] <= point)
                {
                    low = middle;
                }
                else
                {
                    high = middle - 1;
                }
            }

            state = transitions[(state * table.ClassCount) + classes[low]];

            if (state == table.Matched)
            {
                return true;
            }

            if (state == table.Dead)
            {
                return false;
            }
        }

        return table.Accepting.Contains(state);
    }
}
