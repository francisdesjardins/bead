use super::*;

// a host, and what the parser reads it as: none where it fails, as the other sides read the rows
// alike, the TypeScript side through `URL`; an xn-- label that does not decode is left out, its
// answer moving with the IDNA version a parser follows
const HOSTS: &[(&str, Option<&str>)] = &[
    ("127.0.0.1.", Some("127.0.0.1")),
    ("127.1", Some("127.0.0.1")),
    ("0x7f.1", Some("127.0.0.1")),
    ("0X7F.0.0.1", Some("127.0.0.1")),
    ("2130706433", Some("127.0.0.1")),
    ("0177.0.0.1", Some("127.0.0.1")),
    ("127.0.0.0x1", Some("127.0.0.1")),
    ("127.65535", Some("127.0.255.255")),
    ("127.0.0.1..", Some("127.0.0.1..")),
    ("127.0.0.256", None),
    ("127.0.0.1.1", None),
    ("1.2.3.4.5", None),
    ("127.0.0.09", None),
    ("4294967296", None),
    ("0x", Some("0.0.0.0")),
    ("0x.0x.0x.1", Some("0.0.0.1")),
    ("127.0.0.1 ", None),
    ("LOCALHOST", Some("localhost")),
    ("localhost.", Some("localhost.")),
    ("A.LocalHost", Some("a.localhost")),
    ("loc%61lhost", Some("localhost")),
    ("%6c%6f%63%61%6c%68%6f%73%74", Some("localhost")),
    ("%zz", None),
    ("a%", None),
    ("a%2520", None),
    (
        "\u{ff11}\u{ff12}\u{ff17}\u{ff0e}\u{ff10}\u{ff0e}\u{ff10}\u{ff0e}\u{ff11}",
        Some("127.0.0.1"),
    ),
    (
        "\u{ff4c}\u{ff4f}\u{ff43}\u{ff41}\u{ff4c}\u{ff48}\u{ff4f}\u{ff53}\u{ff54}",
        Some("localhost"),
    ),
    ("b\u{fc}cher.example", Some("xn--bcher-kva.example")),
    ("a..b", Some("a..b")),
    ("[::1]", Some("[::1]")),
    ("[0:0:0:0:0:0:0:1]", Some("[::1]")),
    ("[0:0::1]", Some("[::1]")),
    ("[::0.0.0.1]", Some("[::1]")),
    ("[::1%1]", None),
    ("[::1:]", None),
    ("[::01.0.0.1]", None),
    ("[::ffff:127.0.0.1]", Some("[::ffff:7f00:1]")),
    ("[1:0:0:2:0:0:0:3]", Some("[1:0:0:2::3]")),
    ("[1::]", Some("[1::]")),
    ("[::]", Some("[::]")),
    ("[1:2:3:4:5:6:7:8]", Some("[1:2:3:4:5:6:7:8]")),
    ("[1:2:3:4:5:6:7:8:9]", None),
    ("[::1", None),
    ("[FE80::A]", Some("[fe80::a]")),
    ("bead.test^", None),
    ("a|b", None),
    ("a<b", None),
    ("a b", None),
    ("1..2", None),
    ("1a.2.3.4", None),
    ("0x1g.0.0.1", None),
    ("256.0.0.1", None),
    ("1.0x", Some("1.0.0.0")),
    ("a.0xg", Some("a.0xg")),
    ("%41.example", Some("a.example")),
    ("\u{fffd}.example", None),
    ("a\u{ad}b.example", Some("ab.example")),
    ("[]", None),
    ("[:1]", None),
    ("[1::2::3]", None),
    ("[1:2:3]", None),
    ("[::12345]", None),
    ("[::1:2:3:4:5:6:7]", Some("[0:1:2:3:4:5:6:7]")),
    ("[1:2:3:4:5:6:7::]", Some("[1:2:3:4:5:6:7:0]")),
    ("[1:2:3:4:5:6:7:8::]", None),
    ("[1::2:3:4:5:6:7:8]", None),
    ("[1:2:3:4:5:6:1.2.3.4]", Some("[1:2:3:4:5:6:102:304]")),
    ("[1:2:3:4:5:6:7:1.2.3.4]", None),
    ("[::.1.2.3]", None),
    ("[::1.2.3]", None),
    ("[::1.2.3.]", None),
    ("[::1.a.3.4]", None),
    ("[::1.02.3.4]", None),
    ("[::1.2.3.256]", None),
    ("[::1.2.3.4.5]", None),
];

#[test]
fn reads_a_host_as_the_url_standard_s_host_parser_does_and_serializes_it_alike() {
    let read: Vec<(&str, Option<String>)> = HOSTS
        .iter()
        .map(|(host, _)| (*host, url_host_of(host)))
        .collect();
    let expected: Vec<(&str, Option<String>)> = HOSTS
        .iter()
        .map(|(host, parsed)| (*host, parsed.map(str::to_owned)))
        .collect();

    assert_eq!(read, expected, "each host as the URL Standard reads it");
}
