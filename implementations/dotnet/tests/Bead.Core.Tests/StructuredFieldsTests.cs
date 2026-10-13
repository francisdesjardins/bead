using System.Globalization;

namespace Bead.Tests;

/// <summary>
/// <see cref="StructuredFields"/>: a field's value read as an Item of RFC 9651, by the rows the
/// TypeScript side's twin reads alike.
/// </summary>
public sealed class StructuredFieldsTests
{
    // constants

    // the Items of httpwg's structured-field-tests, by file (an Item's raw lines, several joined by
    // ", " as RFC 9110 §5.3 combines them), each with what RFC 9651 §4.2 reads, written as Describe
    // writes it: none where parsing fails. The TypeScript side reads the same rows
    private static readonly (string Raw, string? Parsed)[] Httpwg =
    [
        // item.json
        ("", null),
        (" \t 1", null),
        ("1 \t ", null),
        ("  1  ", "integer 1"),
        ("     1  ", "integer 1"),

        // number.json
        ("42", "integer 42"),
        ("0", "integer 0"),
        ("-0", "integer 0"),
        ("--0", null),
        ("-42", "integer -42"),
        ("042", "integer 42"),
        ("-042", "integer -42"),
        ("00", "integer 0"),
        ("2,3", null),
        ("-a23", null),
        ("4-2", null),
        ("- 42", null),
        ("123456789012345", "integer 123456789012345"),
        ("-123456789012345", "integer -123456789012345"),
        ("1234567890123456", null),
        ("-1234567890123456", null),
        ("1.23", "decimal 1.23"),
        ("-1.23", "decimal -1.23"),
        ("1. 23", null),
        ("1 .23", null),
        ("- 1.23", null),
        ("123456789012.1", "decimal 123456789012.1"),
        ("1.5.4", null),
        ("1..4", null),
        ("1.123", "decimal 1.123"),
        ("-1.123", "decimal -1.123"),
        ("1.", null),
        ("1.1234", null),
        ("-1.1234", null),
        ("1234567890123.0", null),
        ("-1234567890123.0", null),
        ("1.20", "decimal 1.2"),
        ("1.200", "decimal 1.2"),
        ("1.230", "decimal 1.23"),

        // string.json
        ("\"foo bar\"", "string foo bar"),
        ("\"\"", "string "),
        ("\"   \"", "string    "),
        ("\"f\u00fc\u00fc\"", null),
        ("\"\t\"", null),
        ("\" \n \"", null),
        ("'foo'", null),
        ("\"foo", null),
        ("\"foo \\\"bar\\\" \\\\ baz\"", "string foo \"bar\" \\ baz"),
        ("\"foo \\,\"", null),
        ("\"foo \\\"", null),
        ("\"foo \\", null),
        ("\"foo, bar\"", "string foo, bar"),

        // token.json
        ("a_b-c.d3:f%00/*", "token a_b-c.d3:f%00/*"),
        ("fooBar", "token fooBar"),
        ("FooBar", "token FooBar"),

        // binary.json, a Byte Sequence its padding left out taken, as §4.2.7 lets a parser, and
        // one padded in part refused
        (":aGVsbG8=:", "byte-sequence aGVsbG8="),
        ("::", "byte-sequence "),
        (":=aGVsbG8=:", null),
        (":a=GVsbG8=:", null),
        (":aGVsbG8:", "byte-sequence aGVsbG8="),
        (":uuueGVsbG8=:", null),
        (":aGVsbG8==:", null),
        (":aGVsbG8.:", null),
        (":aGVsbG8=", null),
        (":aGVsb G8=:", null),
        (":    :", null),
        (":aGVsbG!8=:", null),
        (":aGVsbG8=!:", null),
        (":iZ==:", "byte-sequence iQ=="),
        (":/+Ah:", "byte-sequence /+Ah"),
        (":_-Ah:", null),
        (":", null),

        // boolean.json
        ("?1", "boolean True"),
        ("?0", "boolean False"),
        ("?Q", null),
        ("? 1", null),
        ("?-0", null),
        ("?T", null),
        ("?F", null),
        ("?t", null),
        ("?f", null),
        ("?True", null),
        ("?False", null),
        ("?", null),

        // date.json
        ("@0", "date 0"),
        ("@1659578233", "date 1659578233"),
        ("@-1659578233", "date -1659578233"),
        ("@2147483648", "date 2147483648"),
        ("@4294967296", "date 4294967296"),
        ("@253402214400", "date 253402214400"),
        ("@-62135596800", "date -62135596800"),
        ("@1659578233.12", null),
        ("@999999999999999", "date 999999999999999"),
        ("@-999999999999999", "date -999999999999999"),
        ("@1000000000000000", null),
        ("@-1000000000000000", null),
        ("@-0", "date 0"),
        ("@", null),
        ("@-", null),
        ("@ 12345678", null),
        ("@abc", null),

        // display-string.json
        ("%\"foo bar\"", "display-string foo bar"),
        (
            "%\" !%22#$%25&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\"",
            "display-string  !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"
        ),
        ("%\"f%C3%BC%C3%BC\"", null),
        ("%\"f%c3%bc%c3%bc\"", "display-string f\u00fc\u00fc"),
        ("%\"f\u00fc\u00fc\"", null),
        ("%\"\t\"", null),
        ("%\"\n\"", null),
        ("%\"\u001f\"", null),
        ("%\"\u007f\"", null),
        ("%\"%0a\"", "display-string \n"),
        ("%\"%1f\"", "display-string \u001f"),
        ("%\"%7f\"", "display-string \u007f"),
        ("%'foo'", null),
        ("%foo", null),
        ("%foo\"", null),
        ("%\"foo", null),
        ("%\"foo %22bar%22 \\ baz\"", "display-string foo \"bar\" \\ baz"),
        ("%\"foo %a", null),
        ("%\"%c3%28\"", null),
        ("%\"%a0%a1\"", null),
        ("%\"%g0%1w\"", null),
        ("%\"%e2%28%a1\"", null),
        ("%\"%f0%28%8c%28\"", null),
        ("%\"BOM: %ef%bb%bf\"", "display-string BOM: \ufeff"),
        ("%\"foo, bar\"", "display-string foo, bar"),
        ("%\"%\"", null),
        ("%\"%61\"", "display-string a"),
    ];

    // an Item's parameters (§4.2.3.2), and what Bead's own fields carry (spec 15.9)
    private static readonly (string Raw, string? Parsed)[] Parameters =
    [
        ("0;x=1", "integer 0;x=integer 1"),
        ("0;y=\"a;b\"", "integer 0;y=string a;b"),
        ("?1;x", "boolean True;x=boolean True"),
        ("-0;x", "integer 0;x=boolean True"),
        ("abc;a=1;b=2; cde_456", "token abc;a=integer 1;b=integer 2;cde_456=boolean True"),
        ("1;a=1;b=2;a=3", "integer 1;a=integer 3;b=integer 2"),
        ("1;*a-b.c_d*=?0", "integer 1;*a-b.c_d*=boolean False"),
        ("1;a=@0;b=:AQ==:;c=%\"%c3%bc\";d=1.5;e=tok", "integer 1;a=date 0;b=byte-sequence AQ==;c=display-string \u00fc;d=decimal 1.5;e=token tok"),
        ("1;a=1 ", "integer 1;a=integer 1"),
        ("0;X=1", null),
        ("1 ;a=1", null),
        ("1;a=", null),
        ("1;=1", null),
        ("1;a=?2", null),
        ("1;a=1;", null),
        ("1;1a=1", null),
        ("0, 0", null),
        ("0;x=1, 0", null),
        ("0 0", null),
        ("\t0", null),
        ("0\t", null),
        ("+0", null),
    ];

    // helpers

    // an Item as a row writes it: its bare item, then each parameter as ;key=value, in order
    private static string? RowOf(string raw)
    {
        if (StructuredFields.ParseItem(raw) is not { } item)
        {
            return null;
        }

        return BareOf(item.BareItem) + string.Concat(item.Parameters.Select((parameter) =>
        {
            return $";{parameter.Key}={BareOf(parameter.Value)}";
        }));
    }

    // a bare item as a row writes it: its type, then its value, a Byte Sequence's in base64
    private static string BareOf(object bareItem)
    {
        return bareItem switch
        {
            bool boolean => $"boolean {boolean}",
            long integer => $"integer {integer.ToString(CultureInfo.InvariantCulture)}",
            decimal number => $"decimal {number.ToString("0.###", CultureInfo.InvariantCulture)}",
            string text => $"string {text}",
            StructuredFields.Token token => $"token {token.Value}",
            StructuredFields.ByteSequence bytes => $"byte-sequence {bytes.Base64}",
            StructuredFields.Date date => $"date {date.Seconds.ToString(CultureInfo.InvariantCulture)}",
            StructuredFields.DisplayString display => $"display-string {display.Value}",
            _ => throw new ArgumentOutOfRangeException(nameof(bareItem), bareItem, "no bare item of RFC 9651's"),
        };
    }

    // tests

    [Fact]
    public void Parses_an_Item_as_RFC_9651_does_its_bare_item_of_each_type_its_parameters_in_their_order_and_none_for_anything_else_as_httpwg_s_structured_field_tests_hold()
    {
        Assert.All(Httpwg.Concat(Parameters), (row) =>
        {
            Assert.Equal(row, (row.Raw, RowOf(row.Raw)));
        });
    }
}
