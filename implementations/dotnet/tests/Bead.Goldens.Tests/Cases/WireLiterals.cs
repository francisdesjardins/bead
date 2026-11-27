// The cases of the wire literal rule (decision 0057): a line the rule refuses follows a comment of
// its own, `// refused:` and why, and every other line is one it accepts. No project compiles this
// file: WireLiteralTests reads it, and fails unless the lines refused are exactly the ones marked.
// A comment's 0x80 & 7 is no code.

using System.Net.WebSockets;
using System.Text.RegularExpressions;

namespace Bead.Cases;

// an enum member's value is a definition
internal enum Kinds
{
    Advisory = 0x80,
}

internal static class Definitions
{
    // a const field is a definition, and so is a mask it builds
    private const int FinBit = 0x80;
    private const int Masks = FinBit | 0x70 | 64;

    // a binary literal and a suffix, in a definition
    private const ulong TopBit = 0b1000_0000UL;

    // a cast to an enum before its literal, in a definition
    private const WebSocketCloseStatus TryAgainLater = (WebSocketCloseStatus)1013;

    // a static readonly field, a table, is a definition
    private static readonly int[] Codes = [0x00, 0x10, 0x80];

    // a regex holding (, {, ' and a backquote, which hides nothing after it
    private static readonly Regex Brackets = new("[({'`]");

    // a static span property whose getter returns its literals
    private static ReadOnlySpan<byte> ByteOrderMark
    {
        get
        {
            return [0xEF, 0xBB, 0xBF];
        }
    }

    // a lambda a static readonly field holds is no definition
    private static readonly Func<int, bool> IsFailure = (code) =>
    {
        // refused: a literal inside a lambda
        return code >= 0x80;
    };

    // refused: a literal after the regex's brackets and quotes
    private static int AfterRegex(int value) { return value & 0xF0; }
}

internal sealed class Readers
{
    // a decimal length is no mask
    private readonly byte[] _head = new byte[14];

    // refused: an instance field is no definition
    private readonly int _mask = 0x7F;

    private static int Opcode(int octet)
    {
        // refused: a hex literal outside a definition
        return octet & 0x0F;
    }

    private static int Field(uint tag)
    {
        // refused: a decimal mask, the tag's wire type
        return (int)(tag & 7);
    }

    private static int Digit(int digit)
    {
        // refused: a decimal bit set by |, a digit's continuation
        return digit | 128;
    }

    private static int Flip(int value)
    {
        // refused: an operand of ^ behind a cast and parentheses
        return value ^ ((int)(255));
    }

    private static void Compound(ref int value)
    {
        // refused: a compound |=
        value |= 64;
        // refused: a compound &=, under a complement
        value &= ~6;
        // refused: a compound ^= of a suffixed literal
        value ^= unchecked((int)2u);
        // a 0 or a 1 is no mask
        value &= 1;
        value |= 0;
        value = value & 1;
    }

    private static bool Local()
    {
        // refused: a local const is no definition
        const int Mask = 0x7F;

        return Mask > 0;
    }

    private static int LocalFunction()
    {
        int Inner()
        {
            // refused: a literal in a local function
            return 0b0101;
        }

        return Inner();
    }

    private static bool Pattern(int code)
    {
        // a pattern of decimal codes is no expression of |
        return code is 1002 or 1008;
    }

    private static bool Logical(bool one, bool other)
    {
        // bools, and a shift, left to review
        return (one | other) && (one & other) && (1 << 3) > 0;
    }

    private static string Texts(int code)
    {
        var verbatim = @"0x80 & 7";
        var raw = """0x80 | 128""";
        // the text of an interpolated string is no code, its format neither
        var interpolated = $"0x{code:X2} & 7";
        // refused: an interpolation's hole is code
        var hole = $"{code & 0x7F}";
        var masked = $"{code & 1}";

        return verbatim + raw + interpolated + hole + masked;
    }

    private static int Switch(int code)
    {
        return code switch
        {
            // refused: a switch's arm is no definition
            0x80 => 1,
            _ => 0,
        };
    }

    // refused: a static field that is not readonly is no definition
    private static int _count = 0x01;
}
