using System.Diagnostics;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// <see cref="EnvelopeCodec"/>'s readers fed mutations of <c>spec/vectors.json</c>'s bytes: each
/// read returns or throws a <see cref="FailureException"/>, never another exception and never takes
/// over a second. The generator is <see cref="Mutations"/>, the other sides' own, so a seed draws
/// the same inputs on every side, which the seeds' count and digests prove; the TypeScript side's
/// <c>envelope-fuzz.test.ts</c> and the Rust side's <c>envelope_fuzz.rs</c> are its twins.
/// </summary>
public sealed class EnvelopeFuzzTests
{
    // constants

    // how many inputs a seed draws; BEAD_FUZZ_INPUTS sets it for a longer run, as on the other sides
    private static readonly int Inputs =
        int.TryParse(Environment.GetEnvironmentVariable("BEAD_FUZZ_INPUTS"), out var given) ? given : 20_000;
    private static readonly List<byte[]> Seeds = SeedsOfVectors();

    // helpers

    private static List<byte[]> SeedsOfVectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors.json");
        // ! past the default depth of 64: a JWT's claims set nests 64 deep below the file's own levels
        using var document = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { MaxDepth = 128 });

        return Mutations.SeedsOf(document.RootElement);
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
            Assert.Fail($"{exception.GetType().Name}: {exception.Message}; input {Mutations.LowerHexOf(input)}");
        }

        Assert.True(clock.ElapsedMilliseconds < 1000, $"over a second; input {Mutations.LowerHexOf(input)}");
    }

    // definition

    /// <summary>The vectors hold the bytes the mutations start from, in the order every side holds them.</summary>
    [Fact]
    public void Finds_the_vectors_bytes()
    {
        Assert.Equal(264, Seeds.Count);

        // * the seeds in their order, as every side holds them
        Assert.Equal("4d0885103f89b5753c2204b02affcb89106c9e8d2300b8262c6d6b8a577e1c48", Mutations.DigestOf(Seeds));
    }

    /// <summary>The generator draws what the other sides' draw for a seed, so a seed replays alike on every side.</summary>
    [Fact]
    public void Draws_what_the_other_sides_draw_for_a_seed()
    {
        var below = Mutations.GeneratorOf(1);

        Assert.Equal([369, 689, 461, 695, 233, 504, 482, 210], Enumerable.Range(0, 8).Select((_) =>
        {
            return below(1_000);
        }));

        // * the first eight inputs of a seed of 1, as every side draws them
        Assert.Equal("59e97d7f4c6b6dbd434bf66b5b848289e8903f415a5d075b848ef843c8d2fe28", Mutations.DigestOf(Mutations.FirstInputs(Seeds, (8, 1))));
    }

    /// <summary>The readers return or refuse with a failure for every mutation of a vector.</summary>
    /// <param name="seed">The generator's seed.</param>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Reads_or_refuses_with_a_failure_every_mutation_of_a_vector(int seed)
    {
        var below = Mutations.GeneratorOf(seed);

        for (var count = 0; count < Inputs; count++)
        {
            var input = Mutations.Mutate(Seeds[below(Seeds.Count)], (below, Seeds));

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
