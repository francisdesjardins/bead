using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Bead.Goldens.Tests;

/// <summary>
/// A consumer's build over the C# target's goldens, which mark what is deprecated: the twin of the
/// TypeScript target's consumer test, in <c>typescript.test.ts</c>, which lints
/// <c>use-deprecated.ts</c> with <c>no-deprecated</c>. Roslyn compiles the goldens and
/// <c>UseDeprecated.cs</c> together, every warning a warning, against what this program runs on:
/// Bead.Core, Google.Protobuf and the framework.
/// </summary>
public sealed partial class ConsumerTests
{
    // constants

    // Bead's diagnostic id, which every mark the C# target writes carries
    private const string DeprecationId = "BEAD0001";

    // the consumer, and the goldens, as this project copies them beside it
    private const string Consumer = "UseDeprecated.cs";

    // ! the SDK's implicit usings, which a project of Microsoft.NET.Sdk holds unless it turns them off:
    // a golden's codec of a message calls the extension AsSpan, which System's using brings in
    private const string ImplicitUsings = """
        global using global::System;
        global using global::System.Collections.Generic;
        global using global::System.IO;
        global using global::System.Linq;
        global using global::System.Net.Http;
        global using global::System.Threading;
        global using global::System.Threading.Tasks;
        """;

    [GeneratedRegex("^ *// reported: (.+)$")]
    private static partial Regex Reported();

    // helpers

    // what a diagnostic says, at its file's name and its line
    private static string ReportOf(Diagnostic diagnostic)
    {
        var span = diagnostic.Location.GetLineSpan();

        return $"{Path.GetFileName(span.Path)}:{span.StartLinePosition.Line + 1}: {diagnostic.GetMessage(CultureInfo.InvariantCulture)}";
    }

    // definition

    [Fact]
    public void A_consumers_every_use_of_a_marked_declaration_is_reported_and_the_files_own_uses_are_not()
    {
        var consumer = Path.Combine(AppContext.BaseDirectory, "Consumer", Consumer);
        var goldens = Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "Golden"), "*.cs", SearchOption.AllDirectories);
        var parsing = new CSharpParseOptions(LanguageVersion.Latest);
        var trees = goldens.Append(consumer).Select((path) =>
        {
            return CSharpSyntaxTree.ParseText(File.ReadAllText(path), parsing, path, cancellationToken: TestContext.Current.CancellationToken);
        }).Append(CSharpSyntaxTree.ParseText(ImplicitUsings, parsing, "GlobalUsings.g.cs", cancellationToken: TestContext.Current.CancellationToken));
        // * what this program runs on, as a consumer's build references it: the framework, Bead.Core
        // and Google.Protobuf among the platform's trusted assemblies
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select((path) =>
            {
                return MetadataReference.CreateFromFile(path);
            });
        var compilation = CSharpCompilation.Create(
            "Consumer",
            trees,
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        // the line under each that says what it is reported, and no other line, the goldens' none
        var expected = File.ReadAllLines(consumer)
            .Select((line, at) =>
            {
                var reported = Reported().Match(line);

                return reported.Success ? $"{Consumer}:{at + 2}: {reported.Groups[1].Value}" : null;
            })
            .OfType<string>()
            .ToList();

        var diagnostics = compilation.GetDiagnostics(TestContext.Current.CancellationToken);
        // what each id reports
        var reports = (string id) =>
        {
            return diagnostics
                .Where((diagnostic) =>
                {
                    return diagnostic.Id == id;
                })
                .Select(ReportOf)
                .ToList();
        };

        Assert.NotEmpty(expected);
        Assert.Empty(diagnostics.Where((diagnostic) =>
        {
            return diagnostic.Severity == DiagnosticSeverity.Error;
        }).Select(ReportOf));
        Assert.Equal(expected, reports(DeprecationId));
        // and none of the compiler's own: every mark is Bead's, protobuf's silenced where it is named
        Assert.Empty(reports("CS0612"));
        Assert.Empty(reports("CS0618"));
    }
}
