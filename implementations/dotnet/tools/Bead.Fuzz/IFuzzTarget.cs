namespace Bead.Fuzz;

/// <summary>
/// A parser fed raw bytes, by its name: it returns, or refuses with what it is designed to refuse
/// with, which passes; anything else it throws is a finding, which SharpFuzz hands on to libFuzzer.
/// </summary>
internal interface IFuzzTarget
{
    /// <summary>The target's name, as the TypeScript side names its twin's file.</summary>
    string Name { get; }

    /// <summary>Reads <paramref name="data"/>, as one input of the fuzzer's.</summary>
    void Run(ReadOnlySpan<byte> data);
}
