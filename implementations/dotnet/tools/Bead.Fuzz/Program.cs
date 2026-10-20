using Bead.Fuzz;

// Bead's parsers fed raw bytes by libFuzzer, one target by its name, the first argument: the
// TypeScript side's tools/fuzz holds the same targets, one for one. libfuzzer-dotnet runs this as
// its child, once SharpFuzz has instrumented Bead.Core beside it: tools/fuzz.mjs at the root does
// both, and says how to read what it finds.

IFuzzTarget[] targets = [new EnvelopeTarget(), new PayloadCodecsTarget(), new HttpFieldsTarget(), new DebugFilterTarget(), new JwtTarget(), new WsHandshakeTarget()];
var target = targets.FirstOrDefault((each) =>
{
    return args.Length > 0 && each.Name == args[0];
});

if (target is null)
{
    var names = targets.Select((each) =>
    {
        return each.Name;
    });

    Console.Error.WriteLine($"a fuzz target's name, among {string.Join(", ", names)}");

    return 2;
}

SharpFuzz.Fuzzer.LibFuzzer.Run(target.Run);

return 0;
