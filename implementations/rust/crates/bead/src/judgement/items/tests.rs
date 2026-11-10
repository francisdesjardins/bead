//! An Item of RFC 9651, by httpwg's structured-field-tests and the parameters Bead's own fields
//! carry: the twin of `structured-fields.test.ts` and `StructuredFieldsTests`, by their rows.

use super::{BareItem, Item, Parameter, parse_item};

// a bare item as a row writes it
fn integer(value: i64) -> BareItem {
    BareItem::Integer(value)
}

fn decimal(value: f64) -> BareItem {
    BareItem::Decimal(value)
}

fn string(value: &str) -> BareItem {
    BareItem::String(value.to_owned())
}

fn token(value: &str) -> BareItem {
    BareItem::Token(value.to_owned())
}

fn bytes(value: &[u8]) -> BareItem {
    BareItem::ByteSequence(value.to_vec())
}

fn boolean(value: bool) -> BareItem {
    BareItem::Boolean(value)
}

fn date(value: i64) -> BareItem {
    BareItem::Date(value)
}

fn display(value: &str) -> BareItem {
    BareItem::DisplayString(value.to_owned())
}

// the Items of httpwg's structured-field-tests, by file (an Item's raw lines joined), each with
// what RFC 9651 §4.2 reads, its parameters none: the other sides read the same rows
fn httpwg() -> Vec<(&'static str, Option<BareItem>)> {
    vec![
        // item.json
        ("", None),
        (" \t 1", None),
        ("1 \t ", None),
        ("  1  ", Some(integer(1))),
        ("     1  ", Some(integer(1))),
        // number.json
        ("42", Some(integer(42))),
        ("0", Some(integer(0))),
        ("-0", Some(integer(0))),
        ("--0", None),
        ("-42", Some(integer(-42))),
        ("042", Some(integer(42))),
        ("-042", Some(integer(-42))),
        ("00", Some(integer(0))),
        ("2,3", None),
        ("-a23", None),
        ("4-2", None),
        ("- 42", None),
        ("123456789012345", Some(integer(123_456_789_012_345))),
        ("-123456789012345", Some(integer(-123_456_789_012_345))),
        ("1234567890123456", None),
        ("-1234567890123456", None),
        ("1.23", Some(decimal(1.23))),
        ("-1.23", Some(decimal(-1.23))),
        ("1. 23", None),
        ("1 .23", None),
        ("- 1.23", None),
        ("123456789012.1", Some(decimal(123_456_789_012.1))),
        ("1.5.4", None),
        ("1..4", None),
        ("1.123", Some(decimal(1.123))),
        ("-1.123", Some(decimal(-1.123))),
        ("1.", None),
        ("1.1234", None),
        ("-1.1234", None),
        ("1234567890123.0", None),
        ("-1234567890123.0", None),
        ("1.20", Some(decimal(1.2))),
        ("1.200", Some(decimal(1.2))),
        ("1.230", Some(decimal(1.23))),
        // string.json
        ("\"foo bar\"", Some(string("foo bar"))),
        ("\"\"", Some(string(""))),
        ("\"   \"", Some(string("   "))),
        ("\"f\u{fc}\u{fc}\"", None),
        ("\"\t\"", None),
        ("\" \n \"", None),
        ("'foo'", None),
        ("\"foo", None),
        (
            "\"foo \\\"bar\\\" \\\\ baz\"",
            Some(string("foo \"bar\" \\ baz")),
        ),
        ("\"foo \\,\"", None),
        ("\"foo \\\"", None),
        ("\"foo \\", None),
        ("\"foo, bar\"", Some(string("foo, bar"))),
        // token.json
        ("a_b-c.d3:f%00/*", Some(token("a_b-c.d3:f%00/*"))),
        ("fooBar", Some(token("fooBar"))),
        ("FooBar", Some(token("FooBar"))),
        // binary.json
        (":aGVsbG8=:", Some(bytes(&[104, 101, 108, 108, 111]))),
        ("::", Some(bytes(&[]))),
        (":=aGVsbG8=:", None),
        (":a=GVsbG8=:", None),
        (":aGVsbG8:", Some(bytes(&[104, 101, 108, 108, 111]))),
        (":uuueGVsbG8=:", None),
        (":aGVsbG8==:", None),
        (":aGVsbG8.:", None),
        (":aGVsbG8=", None),
        (":aGVsb G8=:", None),
        (":    :", None),
        (":aGVsbG!8=:", None),
        (":aGVsbG8=!:", None),
        (":iZ==:", Some(bytes(&[137]))),
        (":/+Ah:", Some(bytes(&[255, 224, 33]))),
        (":_-Ah:", None),
        (":", None),
        // boolean.json
        ("?1", Some(boolean(true))),
        ("?0", Some(boolean(false))),
        ("?Q", None),
        ("? 1", None),
        ("?-0", None),
        ("?T", None),
        ("?F", None),
        ("?t", None),
        ("?f", None),
        ("?True", None),
        ("?False", None),
        ("?", None),
        // date.json
        ("@0", Some(date(0))),
        ("@1659578233", Some(date(1_659_578_233))),
        ("@-1659578233", Some(date(-1_659_578_233))),
        ("@2147483648", Some(date(2_147_483_648))),
        ("@4294967296", Some(date(4_294_967_296))),
        ("@253402214400", Some(date(253_402_214_400))),
        ("@-62135596800", Some(date(-62_135_596_800))),
        ("@1659578233.12", None),
        ("@999999999999999", Some(date(999_999_999_999_999))),
        ("@-999999999999999", Some(date(-999_999_999_999_999))),
        ("@1000000000000000", None),
        ("@-1000000000000000", None),
        ("@-0", Some(date(0))),
        ("@", None),
        ("@-", None),
        ("@ 12345678", None),
        ("@abc", None),
        // display-string.json
        ("%\"foo bar\"", Some(display("foo bar"))),
        (
            "%\" !%22#$%25&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\"",
            Some(display(
                " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
            )),
        ),
        ("%\"f%C3%BC%C3%BC\"", None),
        ("%\"f%c3%bc%c3%bc\"", Some(display("f\u{fc}\u{fc}"))),
        ("%\"f\u{fc}\u{fc}\"", None),
        ("%\"\t\"", None),
        ("%\"\n\"", None),
        ("%\"\u{1f}\"", None),
        ("%\"\u{7f}\"", None),
        ("%\"%0a\"", Some(display("\n"))),
        ("%\"%1f\"", Some(display("\u{1f}"))),
        ("%\"%7f\"", Some(display("\u{7f}"))),
        ("%'foo'", None),
        ("%foo", None),
        ("%foo\"", None),
        ("%\"foo", None),
        (
            "%\"foo %22bar%22 \\ baz\"",
            Some(display("foo \"bar\" \\ baz")),
        ),
        ("%\"foo %a", None),
        ("%\"%c3%28\"", None),
        ("%\"%a0%a1\"", None),
        ("%\"%g0%1w\"", None),
        ("%\"%e2%28%a1\"", None),
        ("%\"%f0%28%8c%28\"", None),
        ("%\"BOM: %ef%bb%bf\"", Some(display("BOM: \u{feff}"))),
        ("%\"foo, bar\"", Some(display("foo, bar"))),
        ("%\"%\"", None),
        ("%\"%61\"", Some(display("a"))),
    ]
}

fn item(bare_item: Option<BareItem>, parameters: &[(&str, Option<BareItem>)]) -> Option<Item> {
    Some(Item {
        bare_item: bare_item?,
        parameters: parameters
            .iter()
            .map(|(key, value)| {
                value.clone().map(|value| Parameter {
                    key: (*key).to_owned(),
                    value,
                })
            })
            .collect::<Option<Vec<Parameter>>>()?,
    })
}

// an Item's parameters (§4.2.3.2), and what Bead's own fields carry (spec 15.9)
fn parameters() -> Vec<(&'static str, Option<Item>)> {
    vec![
        ("0;x=1", item(Some(integer(0)), &[("x", Some(integer(1)))])),
        (
            "0;y=\"a;b\"",
            item(Some(integer(0)), &[("y", Some(string("a;b")))]),
        ),
        (
            "?1;x",
            item(Some(boolean(true)), &[("x", Some(boolean(true)))]),
        ),
        (
            "-0;x",
            item(Some(integer(0)), &[("x", Some(boolean(true)))]),
        ),
        (
            "abc;a=1;b=2; cde_456",
            item(
                Some(token("abc")),
                &[
                    ("a", Some(integer(1))),
                    ("b", Some(integer(2))),
                    ("cde_456", Some(boolean(true))),
                ],
            ),
        ),
        (
            "1;a=1;b=2;a=3",
            item(
                Some(integer(1)),
                &[("a", Some(integer(3))), ("b", Some(integer(2)))],
            ),
        ),
        (
            "1;*a-b.c_d*=?0",
            item(Some(integer(1)), &[("*a-b.c_d*", Some(boolean(false)))]),
        ),
        (
            "1;a=@0;b=:AQ==:;c=%\"%c3%bc\";d=1.5;e=tok",
            item(
                Some(integer(1)),
                &[
                    ("a", Some(date(0))),
                    ("b", Some(bytes(&[1]))),
                    ("c", Some(display("\u{fc}"))),
                    ("d", Some(decimal(1.5))),
                    ("e", Some(token("tok"))),
                ],
            ),
        ),
        ("1;a=1 ", item(Some(integer(1)), &[("a", Some(integer(1)))])),
        ("0;X=1", None),
        ("1 ;a=1", None),
        ("1;a=", None),
        ("1;=1", None),
        ("1;a=?2", None),
        ("1;a=1;", None),
        ("1;1a=1", None),
        ("0, 0", None),
        ("0;x=1, 0", None),
        ("0 0", None),
        ("\t0", None),
        ("0\t", None),
        ("+0", None),
    ]
}

#[test]
fn parses_an_item_as_rfc_9651_does_its_bare_item_of_each_type_its_parameters_in_their_order_and_none_for_anything_else_as_httpwg_s_structured_field_tests_hold()
 {
    for (raw, parsed) in httpwg() {
        assert_eq!(parse_item(raw), item(parsed, &[]), "{raw:?}");
    }

    for (raw, parsed) in parameters() {
        assert_eq!(parse_item(raw), parsed, "{raw:?}");
    }

    // * a sign kept on a zero would tell two counts apart that are one (§4.2.4)
    assert!(
        matches!(
            parse_item("-0.0").map(|parsed| parsed.bare_item),
            Some(BareItem::Decimal(zero)) if zero.is_sign_positive() && zero == 0.0
        ),
        "a decimal zero, unsigned"
    );
}
