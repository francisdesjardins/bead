using System.Collections.Immutable;
using System.Diagnostics;
using System.Text;

namespace Bead.Protobuf.Tests;

/// <summary>
/// <see cref="Pattern"/>: a pattern's table walked as generated code walks it, tables written by
/// hand as beadc writes them. The twins of the TypeScript side's <c>pattern.test.ts</c>, which counts
/// the cells and bounds read through a proxy; an <see cref="ImmutableArray{T}"/> takes no hook, so
/// these show the same by what the walk ends in: a ring whose last state is the count of the cells
/// read, a match kept by a table that would leave it, and a bound of time no backtracking meets.
/// </summary>
public sealed class PatternTests
{
    // constants

    // `^(a+)+$`, as its DFA: state 0 the start, 1 dead, 2 after one `a` or more, accepting at the
    // end; class 0 every code point but `a`, class 1 `a`
    private static readonly PatternTable Nested = new()
    {
        Accepting = [2],
        Bounds = [0, 0x61, 0x62],
        ClassCount = 2,
        Classes = [0, 1, 0],
        Dead = 1,
        Matched = -1,
        StateCount = 3,
        Transitions = [1, 2, 1, 1, 1, 2],
    };

    // `ok`, unanchored: matched for good once `ok` was read, wherever it is
    private static readonly PatternTable Anywhere = new()
    {
        Accepting = [2],
        Bounds = [0, 0x6B, 0x6C, 0x6F, 0x70],
        ClassCount = 3,
        Classes = [0, 1, 0, 2, 0],
        Dead = -1,
        Matched = 2,
        StateCount = 3,
        Transitions = [0, 0, 1, 0, 2, 1, 2, 2, 2],
    };

    // the largest table beadc takes, 16,384 cells: 4,096 states in a ring, each of 4 classes stepping on
    private const int RingStates = 4_096;
    private const int RingClasses = 4;
    private const int RingRanges = 1_024;

    // helpers

    // a ring of RingStates states, each class stepping it on by one more, over RingRanges ranges,
    // the state given its accepting one
    private static PatternTable RingOf(int accepting)
    {
        var transitions = new ushort[RingStates * RingClasses];

        for (var state = 0; state < RingStates; state += 1)
        {
            for (var each = 0; each < RingClasses; each += 1)
            {
                transitions[(state * RingClasses) + each] = (ushort)((state + 1 + each) % RingStates);
            }
        }

        return new PatternTable
        {
            Accepting = [accepting],
            Bounds = [.. Enumerable.Range(0, RingRanges).Select((at) =>
            {
                return at * 64;
            })],
            ClassCount = RingClasses,
            Classes = [.. Enumerable.Range(0, RingRanges).Select((at) =>
            {
                return (ushort)(at % RingClasses);
            })],
            Dead = -1,
            Matched = -1,
            StateCount = RingStates,
            Transitions = [.. transitions],
        };
    }

    // definition

    [Fact]
    public void Matches_in_time_linear_in_its_input()
    {
        // * a backtracking engine never ends on this one; a table reads a cell a character
        var watch = Stopwatch.StartNew();

        foreach (var length in new[] { 1_000, 100_000 })
        {
            Assert.False(Pattern.Matches(Nested, new string('a', length) + "!"));
        }

        Assert.True(Pattern.Matches(Nested, new string('a', 100_000)));
        Assert.False(Pattern.Matches(Nested, ""));
        Assert.InRange(watch.ElapsedMilliseconds, 0, 5_000);
    }

    [Fact]
    public void Walks_one_cell_a_character_whatever_the_pattern_s_size()
    {
        // 1 MiB of characters, the first code point of every range in turn, a surrogate's left out
        var points = Enumerable.Range(0, RingRanges).Select((at) =>
        {
            return at * 64;
        }).Where((point) =>
        {
            return point is < 0xD800 or > 0xDFFF;
        }).ToArray();
        var text = new StringBuilder();
        var last = 0;

        for (var at = 0; at < 1_048_576; at += 1)
        {
            var point = points[at % points.Length];

            text.Append(char.ConvertFromUtf32(point));
            // * the state a walk of one cell a character ends in: each class steps the ring on by one more
            last = (last + 1 + ((point / 64) % RingClasses)) % RingStates;
        }

        var ring = RingOf(last);
        var watch = Stopwatch.StartNew();

        Assert.Equal(16_384, ring.Transitions.Length);
        Assert.True(Pattern.Matches(ring, text.ToString()));
        Assert.InRange(watch.ElapsedMilliseconds, 0, 5_000);
        // a walk that read one cell more or one less ends elsewhere
        Assert.False(Pattern.Matches(RingOf((last + 1) % RingStates), text.ToString()));
    }

    [Fact]
    public void Keeps_a_match_once_reached_wherever_it_is_and_stops_there()
    {
        // Anywhere, but its matched state left for the start by any character: a walk that went on
        // past the match would end unmatched
        var leaving = Anywhere with { Transitions = [0, 0, 1, 0, 2, 1, 0, 0, 0] };

        Assert.True(Pattern.Matches(Anywhere, $"xxok{new string('y', 1_000)}"));
        Assert.True(Pattern.Matches(leaving, $"xxok{new string('y', 1_000)}"));
        Assert.False(Pattern.Matches(Anywhere, "o k"));
    }

    [Fact]
    public void Reads_a_surrogate_alone_as_U_FFFD_a_code_point_of_no_range_of_its_own()
    {
        var replacement = new PatternTable
        {
            Accepting = [2],
            Bounds = [0, 0xFFFD, 0xFFFE],
            ClassCount = 2,
            Classes = [0, 1, 0],
            Dead = 1,
            Matched = -1,
            StateCount = 3,
            Transitions = [1, 2, 1, 1, 1, 1],
        };

        Assert.True(Pattern.Matches(replacement, "\uD800"));
        Assert.True(Pattern.Matches(replacement, "\uDFFF"));
        Assert.False(Pattern.Matches(replacement, "😀"));
    }
}
