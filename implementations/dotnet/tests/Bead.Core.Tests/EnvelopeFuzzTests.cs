using System.Diagnostics;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="EnvelopeCodec"/>'s readers fed mutations of <c>spec/vectors.json</c>'s bytes: each
/// read returns or throws a <see cref="FailureException"/>, never another exception and never takes
/// over a second. The generator is seeded, so a failure replays; the TypeScript side's
/// <c>envelope-fuzz.test.ts</c> holds the same property.
/// </summary>
public sealed class EnvelopeFuzzTests
{
    // constants

    // how many inputs a seed draws; BEAD_FUZZ_INPUTS sets it for a longer run, as on the TypeScript side
    private static readonly int Inputs =
        int.TryParse(Environment.GetEnvironmentVariable("BEAD_FUZZ_INPUTS"), out var given) ? given : 20_000;
    private static readonly byte[] Interesting = [0x00, 0x01, 0x7F, 0x80, 0xFF, 0x10, 0x11, 0x12, 0xA1];
    private static readonly List<byte[]> Seeds = SeedsOfVectors();

    // helpers

    private static List<byte[]> SeedsOfVectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors.json");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var seeds = new List<byte[]>();

        Collect(document.RootElement, seeds);

        return seeds;
    }

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
                    if (property.Name is "bytes" or "record" && property.Value.ValueKind == JsonValueKind.String)
                    {
                        var digits = property.Value.GetString()!.Replace(" ", "").Replace("|", "");

                        if (digits.Length > 0 && digits.Length % 2 == 0 && digits.All(Uri.IsHexDigit))
                        {
                            seeds.Add(Convert.FromHexString(digits));
                        }
                    }
                    else
                    {
                        Collect(property.Value, seeds);
                    }
                }

                break;
            default:
                break;
        }
    }

    // ! a xorshift32 generator, the TypeScript side's: below(count) is in [0, count), and one seed
    // draws the same inputs on both sides, in the same order
    private static Func<int, int> GeneratorOf(int seed)
    {
        var state = seed == 0 ? 1u : (uint)seed;

        return (count) =>
        {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;

            return (int)(state % (uint)count);
        };
    }

    private static byte[] Mutate(byte[] source, Func<int, int> below)
    {
        var bytes = new List<byte>(source);

        for (var round = 1 + below(4); round > 0; round--)
        {
            var at = below(bytes.Count + 1);

            switch (below(7))
            {
                case 0:
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
                    var other = Seeds[below(Seeds.Count)];

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

                    bytes.InsertRange(at, Enumerable.Range(0, inserted).Select(_ =>
                    {
                        return (byte)below(256);
                    }).ToList());

                    break;
            }
        }

        return [.. bytes];
    }

    private static void Read(Action read, byte[] input)
    {
        var clock = Stopwatch.StartNew();

        try
        {
            read();
        }
        catch (FailureException)
        {
            // a refusal is the answer to bytes that are no envelope
        }
        catch (Exception exception)
        {
            Assert.Fail($"{exception.GetType().Name}: {exception.Message}; input {Convert.ToHexString(input)}");
        }

        Assert.True(clock.ElapsedMilliseconds < 1000, $"over a second; input {Convert.ToHexString(input)}");
    }

    // definition

    /// <summary>The vectors hold the bytes the mutations start from.</summary>
    [Fact]
    public void Finds_the_vectors_bytes()
    {
        Assert.True(Seeds.Count > 100, "the vectors hold their bytes");
    }

    /// <summary>The generator draws what the TypeScript side's draws for a seed, so a seed replays alike on both.</summary>
    [Fact]
    public void Draws_what_the_TypeScript_side_draws_for_a_seed()
    {
        var below = GeneratorOf(1);

        Assert.Equal([369, 689, 461, 695, 233, 504, 482, 210], Enumerable.Range(0, 8).Select((_) =>
        {
            return below(1_000);
        }));
    }

    /// <summary>The readers return or refuse with a failure for every mutation of a vector.</summary>
    /// <param name="seed">The generator's seed.</param>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Reads_or_refuses_with_a_failure_every_mutation_of_a_vector(int seed)
    {
        var below = GeneratorOf(seed);

        for (var count = 0; count < Inputs; count++)
        {
            var input = Mutate(Seeds[below(Seeds.Count)], below);

            foreach (var side in new[] { RouterSide.Server, RouterSide.Client })
            {
                var options = new EnvelopeReadOptions { Side = side, MaximumEnvelopeBytes = LimitDefaults.MaximumEnvelopeBytes };

                Read(
                    () =>
                    {
                        EnvelopeCodec.ReadEnvelope(input, options);
                    },
                    input);
                Read(
                    () =>
                    {
                        EnvelopeCodec.ReadFailure(input, options);
                    },
                    input);
            }
        }
    }

    /// <summary>A reader that throws something else than a failure is reported.</summary>
    [Fact]
    public void Reports_an_exception_that_is_no_failure()
    {
        var thrown = Assert.ThrowsAny<Exception>(
            () =>
            {
                Read(
                    () =>
                    {
                        throw new InvalidOperationException("boom");
                    },
                    [0x01]);
            });

        Assert.Equal("InvalidOperationException: boom; input 01", thrown.Message);
    }
}
