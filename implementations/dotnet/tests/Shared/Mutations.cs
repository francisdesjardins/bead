using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Seeded mutations of the conformance files' bytes (decision 0006): one generator, the same on
/// every side, its seeds ordered by their SHA-1, so a seed draws the same inputs wherever it runs,
/// which each twin proves by the seeds' count and digests. The TypeScript side's twin is
/// <c>router/shared/__tests__/mutations.ts</c>, the Rust side's <c>bead::testing::mutations</c>.
/// </summary>
internal static class Mutations
{
    // constants

    // the bytes a mutation may write, as the other sides' generators hold them
    private static readonly byte[] Interesting = [0x00, 0x01, 0x7F, 0x80, 0xFF, 0x10, 0x11, 0x12, 0xA1];

    // helpers

    // the bytes a conformance file holds under each `bytes` or `record` key, at any depth
    private static void Collect(JsonElement element, List<byte[]> seeds)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    Collect(item, seeds);
                }

                break;
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    var bytes = property.Name is "bytes" or "record" && property.Value.ValueKind == JsonValueKind.String
                        ? BytesOfHex(property.Value.GetString()!)
                        : null;

                    if (bytes is null)
                    {
                        Collect(property.Value, seeds);
                    }
                    else
                    {
                        seeds.Add(bytes);
                    }
                }

                break;
            default:
                break;
        }
    }

    // definition

    /// <summary>The bytes <paramref name="text"/> holds in hexadecimal, its spaces and bars aside; none where it holds other, or nothing.</summary>
    public static byte[]? BytesOfHex(string text)
    {
        var digits = new string([.. text.Where((character) =>
        {
            return !char.IsWhiteSpace(character) && character != '|';
        })]);

        if (digits.Length == 0 || digits.Length % 2 != 0 || !digits.All(char.IsAsciiHexDigit))
        {
            return null;
        }

        return Convert.FromHexString(digits);
    }

    /// <summary><paramref name="bytes"/> in lowercase hexadecimal, unspaced.</summary>
    public static string LowerHexOf(byte[] bytes)
    {
        return Convert.ToHexStringLower(bytes);
    }

    /// <summary>
    /// A xorshift32 generator, the other sides' own: <c>below(count)</c> is in <c>[0, count)</c>, 0
    /// for a count of 0, and one seed draws the same on every side, in the same order.
    /// </summary>
    public static Func<int, int> GeneratorOf(int seed)
    {
        var state = seed == 0 ? 1u : (uint)seed;

        return (count) =>
        {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;

            return count == 0 ? 0 : (int)(state % (uint)count);
        };
    }

    /// <summary>
    /// <paramref name="source"/> changed by one to four edits drawn from the generator: a bit
    /// flipped, a byte of the interesting ones put in or written over one, bytes removed, the rest
    /// cut, the rest replaced by a tail of another of the seeds, or random bytes put in, each drawn
    /// as the other sides draw them, in their order.
    /// </summary>
    public static byte[] Mutate(byte[] source, (Func<int, int> Below, IReadOnlyList<byte[]> Seeds) mutation)
    {
        var (below, seeds) = mutation;
        var bytes = new List<byte>(source);

        for (var round = 1 + below(4); round > 0; round -= 1)
        {
            var at = below(bytes.Count + 1);

            switch (below(7))
            {
                case 0:
                    // ! a bit and a byte are drawn only where there is a byte, as on the other sides
                    if (bytes.Count > 0)
                    {
                        bytes[at % bytes.Count] ^= (byte)(1 << below(8));
                    }

                    break;
                case 1:
                    bytes.Insert(at, Interesting[below(Interesting.Length)]);

                    break;
                case 2:
                    bytes.RemoveRange(at, Math.Min(1 + below(4), bytes.Count - at));

                    break;
                case 3:
                    bytes.RemoveRange(at, bytes.Count - at);

                    break;
                case 4:
                    var drawn = below(seeds.Count);
                    var other = drawn < seeds.Count ? seeds[drawn] : [];

                    bytes.RemoveRange(at, bytes.Count - at);
                    bytes.AddRange(other.Skip(below(other.Length + 1)));

                    break;
                case 5:
                    if (bytes.Count > 0)
                    {
                        bytes[at % bytes.Count] = Interesting[below(Interesting.Length)];
                    }

                    break;
                default:
                    var inserted = 1 + below(16);

                    bytes.InsertRange(at, Enumerable.Range(0, inserted).Select((_) =>
                    {
                        return (byte)below(256);
                    }).ToList());

                    break;
            }
        }

        return [.. bytes];
    }

    /// <summary>
    /// <paramref name="seeds"/> ordered by their SHA-1, its lowercase hexadecimal ascending: the
    /// order every side draws them in, whatever order its reader of the file walks them in.
    /// </summary>
    [SuppressMessage(
        "Security",
        "CA5350:Do Not Use Weak Cryptographic Algorithms",
        Justification = "a seed's order, the same on every side, never a secret's digest (decision 0006)")]
    public static List<byte[]> Ordered(IEnumerable<byte[]> seeds)
    {
        return [.. seeds.OrderBy(
            (seed) =>
            {
                return Convert.ToHexStringLower(SHA1.HashData(seed));
            },
            StringComparer.Ordinal)];
    }

    /// <summary>The bytes a conformance file holds under each <c>bytes</c> or <c>record</c> key at any depth, ordered.</summary>
    public static List<byte[]> SeedsOf(JsonElement file)
    {
        var seeds = new List<byte[]>();

        Collect(file, seeds);

        return Ordered(seeds);
    }

    /// <summary>
    /// The SHA-256, in lowercase hexadecimal, of the inputs' lowercase hexadecimal, each a line ended
    /// by a line feed: what every side's twin asserts of its seeds and of its first inputs.
    /// </summary>
    public static string DigestOf(IEnumerable<byte[]> inputs)
    {
        var lines = new StringBuilder();

        foreach (var input in inputs)
        {
            lines.Append(LowerHexOf(input)).Append('\n');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(lines.ToString())));
    }

    /// <summary>The first inputs a seed draws from <paramref name="seeds"/>, as each twin draws them: a seed drawn, then mutated.</summary>
    public static List<byte[]> FirstInputs(IReadOnlyList<byte[]> seeds, (int Count, int Seed) draw)
    {
        var below = GeneratorOf(draw.Seed);

        return [.. Enumerable.Range(0, draw.Count).Select((_) =>
        {
            return Mutate(seeds[below(seeds.Count)], (below, seeds));
        })];
    }
}
