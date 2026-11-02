using System.Diagnostics;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// A broker's parcel reader fed seeded mutations of <c>spec/vectors.json</c>'s parcels (spec 15.17,
/// decision 0006), held to the <c>broker-parcel</c> target's properties, <see cref="ParcelProperties"/>,
/// within a second an input. The generator is <see cref="Mutations"/>, the other sides' own, so a
/// seed draws the same inputs on every side, which the seeds' count and digests prove; the
/// TypeScript side's <c>broker-parcel-fuzz.test.ts</c> and the Rust side's
/// <c>broker_parcel_fuzz.rs</c> are its twins.
/// </summary>
public sealed class BrokerParcelFuzzTests
{
    // constants

    // how many inputs a seed draws; BEAD_FUZZ_INPUTS sets it for a longer run, as on the other sides
    private static readonly int Inputs =
        int.TryParse(Environment.GetEnvironmentVariable("BEAD_FUZZ_INPUTS"), out var given) ? given : 20_000;
    private static readonly List<byte[]> Seeds = SeedsOfParcels();

    // helpers

    // the bytes of every parcel and of every message refused as one, ordered by their SHA-1
    private static List<byte[]> SeedsOfParcels()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors.json");
        // ! past the default depth of 64: a JWT's claims set nests 64 deep below the file's own levels
        using var document = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { MaxDepth = 128 });
        var root = document.RootElement;

        return Mutations.Ordered(root.GetProperty("parcels").EnumerateArray().Concat(root.GetProperty("parcelRefusals").EnumerateArray()).Select((vector) =>
        {
            var text = vector.GetProperty("bytes").GetString()!;

            // * no byte at all is a message refused too
            return string.IsNullOrWhiteSpace(text)
                ? []
                : Mutations.BytesOfHex(text) ?? throw new FormatException($"\"{text}\" is no hexadecimal");
        }));
    }

    // what `check` gives that breaks a property, with the input: a break, a throw, or over a second
    private static string? DefectOf(Func<string?> check, byte[] input)
    {
        var clock = Stopwatch.StartNew();
        string? broken;

        try
        {
            broken = check();
        }
        catch (Exception exception)
        {
            return $"{exception.GetType().Name}: {exception.Message}; input {Mutations.LowerHexOf(input)}";
        }

        if (broken is not null)
        {
            return $"{broken}; input {Mutations.LowerHexOf(input)}";
        }

        return clock.ElapsedMilliseconds > 1000 ? $"over a second; input {Mutations.LowerHexOf(input)}" : null;
    }

    // definition

    /// <summary>The vectors hold the parcels' bytes, in the order every side holds them.</summary>
    [Fact]
    public void Finds_the_parcels_bytes()
    {
        Assert.Equal(72, Seeds.Count);

        // * the seeds in their order, as every side holds them
        Assert.Equal("654a2c65cf1911a21e201cd09d3f1cb59af1688e318e7ddf1f2f0d3c73984d45", Mutations.DigestOf(Seeds));
    }

    /// <summary>A seed draws what it draws on the other sides.</summary>
    [Fact]
    public void Draws_what_the_other_sides_draw_for_a_seed()
    {
        // * the first eight inputs of a seed of 1, as every side draws them
        Assert.Equal("3c513c8adf6e27cc4fbb1042b4f0dcaf9d6279e50b20ef52831433284c2c1e88", Mutations.DigestOf(Mutations.FirstInputs(Seeds, (8, 1))));
    }

    /// <summary>Every mutation of a parcel reads, is written back, or is refused as designed.</summary>
    /// <param name="seed">The generator's seed.</param>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel(int seed)
    {
        var below = Mutations.GeneratorOf(seed);
        var defects = new List<string>();

        for (var count = 0; count < Inputs; count += 1)
        {
            var input = Mutations.Mutate(Seeds[below(Seeds.Count)], (below, Seeds));

            if (DefectOf(
                () =>
                {
                    return ParcelProperties.BreakOf(input);
                },
                input) is { } defect)
            {
                defects.Add(defect);
            }
        }

        Assert.Empty(defects);
    }

    /// <summary>A reader or a writer that throws something else than its refusal is reported.</summary>
    [Fact]
    public void Reports_an_exception_that_is_no_refusal()
    {
        var defect = DefectOf(
            () =>
            {
                throw new InvalidOperationException("boom");
            },
            [0x01]);

        Assert.Equal("InvalidOperationException: boom; input 01", defect);
    }
}
