using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Bead.Goldens.Tests;

/// <summary>
/// The notation rule over the C# side's wire modules (decision 0057), the twin of bead-house's: a
/// hex or binary integer literal stands only in a definition, and outside one no <c>&amp;</c>,
/// <c>|</c> or <c>^</c>, compound forms included, takes an integer literal above 1 as an operand.
/// The modules are those the C# column of <c>tools/wire-names.tsv</c> names, holders and readers
/// alike. Roslyn reads each as the compiler does, so a comment or a string is never code, and an
/// interpolation's hole is.
/// </summary>
public sealed class WireLiteralTests
{
    // constants

    // the solution's file, whose folder is the C# side's
    private const string Solution = "Bead.slnx";

    // the table, from the repository's root
    private const string Table = "tools/wire-names.tsv";

    // the cases, from the C# side's folder: a file no project compiles
    private const string Cases = "tests/Bead.Goldens.Tests/Cases/WireLiterals.cs";

    // what opens the comment above a line the cases mark refused
    private const string Marker = "// refused:";

    // ! the fewest lines the cases mark: emptied, they would hold nothing
    private const int Floor = 12;

    // the table's columns, and the C# side's among them
    private const int Columns = 7;
    private const int CSharpColumn = 5;

    // helpers

    // the C# side's folder, the one that holds the solution, found from where the tests run
    private static string SideFolder()
    {
        var folder = new DirectoryInfo(AppContext.BaseDirectory);

        while (folder is not null && !File.Exists(Path.Combine(folder.FullName, Solution)))
        {
            folder = folder.Parent;
        }

        return folder?.FullName ?? throw new InvalidOperationException($"no folder above {AppContext.BaseDirectory} holds {Solution}");
    }

    // the modules the table's C# column names, each once, in its order: a cell's paths split on
    // `, `, each cut at its `#`; a cell that opens with `-` is a reason whole
    private static List<string> ModulesOf(string table)
    {
        var modules = new List<string>();

        foreach (var line in table.Split('\n'))
        {
            var row = line.TrimEnd('\r');

            if (row.Length == 0 || row.StartsWith('#'))
            {
                continue;
            }

            var fields = row.Split('\t');

            Assert.True(fields.Length == Columns, $"a row of {fields.Length} fields, not {Columns}: {row}");

            var cell = fields[CSharpColumn];

            if (cell.StartsWith('-'))
            {
                continue;
            }

            foreach (var path in cell.Split(", ").Select((part) =>
            {
                return part.Split('#')[0];
            }))
            {
                if (!modules.Contains(path))
                {
                    modules.Add(path);
                }
            }
        }

        return modules;
    }

    // a source read by Roslyn, refused when it does not parse: a misread would hide what it holds
    private static SyntaxTree TreeOf(string path)
    {
        var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path), new CSharpParseOptions(LanguageVersion.Latest), path, cancellationToken: TestContext.Current.CancellationToken);
        var errors = tree.GetDiagnostics(TestContext.Current.CancellationToken).Where((diagnostic) =>
        {
            return diagnostic.Severity == DiagnosticSeverity.Error;
        });

        Assert.Empty(errors.Select((diagnostic) =>
        {
            return diagnostic.ToString();
        }));

        return tree;
    }

    // the lines a cases file marks refused: each right after a `// refused:` comment
    private static List<int> MarkedOf(string source)
    {
        return source
            .Split('\n')
            .Select((line, index) =>
            {
                return (IsMarker: line.TrimStart().StartsWith(Marker, StringComparison.Ordinal), Line: index + 2);
            })
            .Where((line) =>
            {
                return line.IsMarker;
            })
            .Select((line) =>
            {
                return line.Line;
            })
            .ToList();
    }

    // definition

    [Fact]
    public void Every_hex_or_binary_literal_of_a_wire_module_stands_in_a_definition()
    {
        var side = SideFolder();
        var root = Path.GetFullPath(Path.Combine(side, "..", ".."));
        var modules = ModulesOf(File.ReadAllText(Path.Combine(root, Table)));
        var missing = modules.Where((module) =>
        {
            return !File.Exists(Path.Combine(root, module));
        });

        Assert.NotEmpty(modules);
        Assert.Equal("", string.Join('\n', missing));

        var refused = modules.SelectMany((module) =>
        {
            return WireLiterals.FindingsOf(TreeOf(Path.Combine(root, module))).Select((finding) =>
            {
                return $"{module}:{finding.Line}: {finding.Reason}";
            });
        });

        // * each refusal on a line of its own, every one shown
        Assert.Equal("", string.Join('\n', refused));
    }

    [Fact]
    public void The_wire_literal_rule_refuses_exactly_what_its_cases_mark()
    {
        var path = Path.Combine(SideFolder(), Cases);
        var marked = MarkedOf(File.ReadAllText(path));
        var refused = WireLiterals.FindingsOf(TreeOf(path))
            .Select((finding) =>
            {
                return finding.Line;
            })
            .Distinct()
            .Order()
            .ToList();

        Assert.True(marked.Count >= Floor, $"the cases mark {marked.Count} lines, under {Floor}");
        Assert.Equal(marked, refused);
    }
}

/// <summary>A line the wire literal rule refuses, and why.</summary>
internal sealed record WireLiteralFinding(int Line, string Reason);

/// <summary>
/// The wire literal rule (decision 0057), over one source as Roslyn reads it. A definition is a
/// <c>const</c> or <c>static readonly</c> field, an enum member's value, or a <c>static
/// ReadOnlySpan&lt;byte&gt;</c> property whose getter returns its literals, with no lambda or local
/// function between the literal and its declaration. Shifts are left to review.
/// </summary>
internal static class WireLiterals
{
    /// <summary>Each line of <paramref name="tree"/> the rule refuses, in the order they come.</summary>
    public static List<WireLiteralFinding> FindingsOf(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        var findings = new List<WireLiteralFinding>();

        // * a hex or binary literal outside a definition, whatever its suffix
        foreach (var token in root.DescendantTokens())
        {
            if (token.IsKind(SyntaxKind.NumericLiteralToken) && IsHexOrBinary(token.Text) && !IsInDefinition(token.Parent!))
            {
                findings.Add(new WireLiteralFinding(LineOf(token.GetLocation()), $"a hex or binary literal outside a definition, {token.Text}"));
            }
        }

        // * an integer literal above 1 as an operand of &, | or ^, outside a definition
        foreach (var node in root.DescendantNodes())
        {
            var (symbol, operands) = OperandsOf(node);

            if (symbol is null || IsInDefinition(node))
            {
                continue;
            }

            foreach (var literal in operands.Select(LiteralOf).OfType<LiteralExpressionSyntax>().Where(IsAboveOne))
            {
                findings.Add(new WireLiteralFinding(LineOf(literal.GetLocation()), $"{literal.Token.Text} as an operand of {symbol}"));
            }
        }

        return [.. findings.OrderBy((finding) =>
        {
            return finding.Line;
        })];
    }

    private static int LineOf(Location location)
    {
        return location.GetLineSpan().StartLinePosition.Line + 1;
    }

    private static bool IsHexOrBinary(string text)
    {
        return text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || text.StartsWith("0b", StringComparison.OrdinalIgnoreCase);
    }

    // whether a node stands in a definition: the first declaration above it decides, a lambda or a
    // local function between making it none
    private static bool IsInDefinition(SyntaxNode node)
    {
        var isInReturn = false;

        foreach (var ancestor in node.AncestorsAndSelf())
        {
            switch (ancestor)
            {
                case AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax:
                    return false;
                case ReturnStatementSyntax or ArrowExpressionClauseSyntax:
                    isInReturn = true;
                    break;
                case FieldDeclarationSyntax field:
                    return field.Modifiers.Any(SyntaxKind.ConstKeyword) || (field.Modifiers.Any(SyntaxKind.StaticKeyword) && field.Modifiers.Any(SyntaxKind.ReadOnlyKeyword));
                case EnumMemberDeclarationSyntax:
                    return true;
                case PropertyDeclarationSyntax property:
                    return isInReturn && property.Modifiers.Any(SyntaxKind.StaticKeyword) && property.Type.ToString().EndsWith("ReadOnlySpan<byte>", StringComparison.Ordinal);
                case MemberDeclarationSyntax:
                    return false;
            }
        }

        return false;
    }

    // the operator of a bitwise expression or its compound assignment, and the operands it takes
    private static (string? Operator, ExpressionSyntax[] Operands) OperandsOf(SyntaxNode node)
    {
        return node switch
        {
            BinaryExpressionSyntax binary when binary.Kind() is SyntaxKind.BitwiseAndExpression or SyntaxKind.BitwiseOrExpression or SyntaxKind.ExclusiveOrExpression => (binary.OperatorToken.Text, [binary.Left, binary.Right]),
            AssignmentExpressionSyntax assignment when assignment.Kind() is SyntaxKind.AndAssignmentExpression or SyntaxKind.OrAssignmentExpression or SyntaxKind.ExclusiveOrAssignmentExpression => (assignment.OperatorToken.Text, [assignment.Right]),
            _ => (null, []),
        };
    }

    // the numeric literal an operand is, through its parentheses, casts, checked forms and unary
    // operators, or none
    private static LiteralExpressionSyntax? LiteralOf(ExpressionSyntax operand)
    {
        var expression = operand;

        while (true)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    expression = parenthesized.Expression;
                    break;
                case CastExpressionSyntax cast:
                    expression = cast.Expression;
                    break;
                case CheckedExpressionSyntax checkedForm:
                    expression = checkedForm.Expression;
                    break;
                case PrefixUnaryExpressionSyntax unary:
                    expression = unary.Operand;
                    break;
                case LiteralExpressionSyntax literal when literal.IsKind(SyntaxKind.NumericLiteralExpression):
                    return literal;
                default:
                    return null;
            }
        }
    }

    // whether a numeric literal is an integer above 1
    private static bool IsAboveOne(LiteralExpressionSyntax literal)
    {
        return literal.Token.Value switch
        {
            int value => value > 1,
            uint value => value > 1,
            long value => value > 1,
            ulong value => value > 1,
            _ => false,
        };
    }
}
