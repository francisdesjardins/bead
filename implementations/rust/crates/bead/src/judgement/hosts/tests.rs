//! The hosts and origins a server takes, and what it reads of a target, a field and a credential
//! (spec 15.1, 15.2, 15.12): the twins of `hosts-and-origins.test.ts` and `HostsAndOriginsTests`,
//! by their rows.

use super::{
    EVERY_HOST, HOST_REFUSAL, ORIGIN_REFUSAL, RequestTarget, TakenOrigins, assert_hosts,
    assert_listening_address, assert_origins, credential_of, has_visible_fields, is_ip_address,
    is_ipv4_address, is_listed_origin, is_taken_host, is_taken_origin, is_visible_field,
    is_visible_target, is_well_formed_host, origin_of, own_authority_of, request_target_of,
};

// what every server takes, by its host on any port
const EVERY_SERVERS: &[&str] = &[
    "localhost",
    "LocalHost:8080",
    "bead.localhost",
    "a.b.LOCALHOST:80",
    "127.0.0.1",
    "127.0.0.1:8080",
    "192.0.2.1:80",
    "0.0.0.0",
    "255.255.255.255",
    "[::1]",
    "[::1]:8443",
    "[2001:db8::7]:80",
    "localhost:80",
    "Bead.LocalHost:8443",
    "a.b.localhost",
    ".localhost",
    "[2001:db8::7]",
    "[::ffff:127.0.0.1]:8080",
];

// and what a server takes only where it is listed: an empty host, none, a name that only looks
// like one of those, a final dot, and what a platform's parser reads as an IPv4 address
const NO_SERVERS: &[Option<&str>] = &[
    None,
    Some(""),
    Some(":8080"),
    Some("elsewhere.test"),
    Some("localhost."),
    Some("localhost.example"),
    Some("localhost.example:8080"),
    Some("notlocalhost"),
    Some("127.1"),
    Some("0177.0.0.1"),
    Some("127.0.0.1.example"),
    Some("256.0.0.1"),
    Some("xn--a"),
    Some("rebind.example:8080"),
    Some("localhost.:8080"),
    Some("bead-localhost"),
    Some("localhost.localhost.example"),
    Some("0x7f.0.0.1"),
    Some("2130706433"),
    Some("127.0.0.01"),
    Some("1.2.3.4.5"),
];

// the hosts given, and the rows they take and refuse, in any ASCII case, on any port
const HOSTS: &[&str] = &["bead.test", "xn--bad-bma.test", "Elsewhere.Example"];
const TAKEN_HOSTS: &[&str] = &[
    "bead.test",
    "Bead.Test",
    "BEAD.TEST:8443",
    "bead.test:80",
    "XN--BAD-BMA.test",
    "elsewhere.example:1",
    "bead.test:443",
    "XN--BAD-BMA.test:8080",
];
const OTHER_HOSTS: &[Option<&str>] = &[
    None,
    Some(""),
    Some(":80"),
    Some("sub.bead.test"),
    Some("bead.test."),
    Some("bead.testx"),
    Some("b\u{e9}ad.test"),
    Some("xn--a.test"),
    Some(":8080"),
    Some("elsewhere.test"),
    Some("bead.testing"),
];
const ORIGINS: &[&str] = &["https://bead.example"];

// a `Host` value HTTP takes, an authority of spec 15.12's grammar, and one it does not (RFC 9112
// §3.2)
const WELL_FORMED_HOSTS: &[&str] = &[
    "bead.test",
    "bead.test:8080",
    "BEAD.test:8080",
    "bead.test:0",
    "bead.test:080",
    "bead.test:65536",
    "BEAD.TEST",
    "",
    ":8080",
    "127.0.0.1",
    "127.0.0.1:8080",
    "127.1",
    "[::1]",
    "[::1]:8080",
    "[2001:db8::7]",
    "[::ffff:127.0.0.1]",
    "[::ffff:192.0.2.1]",
    "xn--a",
    "xn---bad-cpa.test",
    "bead_test~",
    "!$&'()",
    "a-._~!$&'()b",
    " bead.test\t",
];
const MALFORMED_HOSTS: &[&str] = &[
    "bead.test:",
    "localhost:",
    "[::1]:",
    "a%41.test",
    "bead%2Etest",
    "b%C3%A9ad.test",
    "a*b.test",
    "a+b.test",
    "a,b.test",
    "a;b=c",
    "a=b.test",
    "!$&'()*+,;=",
    "[v1.bead]",
    "[v1.fe80::a+en1]",
    "bad host",
    "user@bead.test",
    "bead/test",
    "bead.test/path",
    "bead.test?query",
    "bead.test#fragment",
    "bead.test:80x",
    "bead.test:80a",
    "bead.test:80:80",
    "bead.test:8080:1",
    "bead.test:-1",
    "[::1",
    "[::1]x",
    "[::1]:a",
    "[]",
    "[bead.test]",
    "[127.0.0.1]",
    "[::1%eth0]",
    "[::1%25eth0]",
    "[fe80::1%25eth0]",
    "[::1/64]",
    "[v.x]",
    "[v1.]",
    "bead%2test",
    "%zz.test",
    "bead.test%",
    "b\u{e9}ad.test",
    "::1",
];

// a `hosts` that is built, and one that is refused as it is built
const BUILT_HOSTS: &[&[&str]] = &[
    &[],
    &["*"],
    &["bead.test"],
    &[
        "Bead.Test",
        "127.0.0.1",
        "[::1]",
        "localhost",
        "xn--a",
        "bead.localhost",
    ],
    &[
        "Bead.Test",
        "xn--bad-bma.test",
        "127.0.0.1",
        "[::1]",
        "localhost",
    ],
];
const REFUSED_HOSTS: &[&[&str]] = &[
    &["bead.test:8080"],
    &["bead.test", "127.0.0.1:8080"],
    &["[::1]:80"],
    &["localhost:"],
    &[""],
    &["bead.test", ""],
    &["b\u{e9}ad.test"],
    &["bad host"],
    &["a*b.test"],
    &["[v1.bead]"],
    &["bead.test/"],
    &["http://bead.test"],
    &["*", "bead.test"],
    &["bead.test", "*"],
    &["*", "*"],
    &["bead.test:"],
    &["127.0.0.1:8080"],
    &["[::1]:8443"],
    &[":8080"],
    &["*.bead.test"],
];

// an `origins` entry that is built, and one that is refused as it is built
const BUILT_ORIGINS: &[&str] = &[
    "http://bead.test",
    "https://bead.test",
    "http://bead.test:8080",
    "https://bead.test:8443",
    "https://bead.test:80",
    "ws://bead.test:443",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "http://localhost:0",
    "https://xn--bad-bma.test",
    "chrome-extension://abcdefghijklmnop",
    "tauri://localhost",
    "app://Bead.Test",
];
const REFUSED_ORIGINS: &[&str] = &[
    "*",
    "null",
    "http://*.bead.test",
    "https://bead.test/",
    "https://bead.test/path",
    "http://bead.test?query",
    "https://user@bead.test",
    "HTTPS://bead.test",
    "https://Bead.test",
    "https://bead.test:443",
    "http://bead.test:80",
    "ws://bead.test:80",
    "wss://bead.test:443",
    "https://bead.test:",
    "https://bead.test:0443",
    "http://bead.test:080",
    "https://bead.test:65536",
    "https://",
    "https://b\u{e9}ad.test",
    "https://a*b.test",
    "https://[::1",
    "bead.test",
    "//bead.test",
    "http:bead.test",
    "1http://bead.test",
    " http://bead.test",
    "Null",
    "",
    "http://bead.test/",
    "http://bead.test/path",
    "http://user@bead.test",
    "HTTP://bead.test",
    "http://Bead.Test",
    "http://bead.test:",
    "http://bead.test:65536",
    "http://",
    "http://b\u{e9}ad.test",
    "http://a*b.test",
];

// an origin, and the Host of a request that comes from it: the server's own, `http://` or
// `https://` followed by its Host, in any ASCII case, as a browser writes both from one URL first
const OWN: &[(&str, &str)] = &[
    ("http://bead.test", "bead.test"),
    ("https://bead.test", "bead.test"),
    ("http://bead.test:8080", "bead.test:8080"),
    ("https://bead.test:8443", "bead.test:8443"),
    ("http://127.0.0.1:8080", "127.0.0.1:8080"),
    ("http://[::1]:8080", "[::1]:8080"),
    ("http://localhost:8080", "localhost:8080"),
    ("http://xn--bad-bma.test", "xn--bad-bma.test"),
    ("https://xn--bad-bma.test:8443", "xn--bad-bma.test:8443"),
    ("http://bead.test", "Bead.Test"),
    ("HTTPS://BEAD.test", "bead.test"),
    ("http://XN--BAD-BMA.test", "xn--bad-bma.test"),
    ("http://xn--a.test", "xn--a.test"),
    ("http://bead.test:80", "bead.test:80"),
    ("http://bead.test.", "bead.test."),
];
const NOT_OWN: &[(&str, Option<&str>)] = &[
    ("http://bead.test", Some("bead.test:8080")),
    ("http://bead.test:8080", Some("bead.test")),
    ("https://elsewhere.test", Some("bead.test")),
    ("http://bead.test", None),
    ("http://", Some("")),
    ("null", Some("bead.test")),
    ("not an origin", Some("bead.test")),
    // the same origin written otherwise than the Host, which no browser sends: a default port on
    // one side alone, a host not in its canonical form, a path, a userinfo, a space
    ("http://bead.test:80", Some("bead.test")),
    ("https://bead.test:443", Some("bead.test")),
    ("http://bead.test", Some("bead.test:80")),
    ("https://bead.test:80", Some("bead.test")),
    ("http://127.1", Some("127.0.0.1")),
    ("http://[0:0::1]:8080", Some("[::1]:8080")),
    ("http://b\u{e9}ad.test", Some("xn--bad-bma.test")),
    ("http://bead%2Etest", Some("bead.test")),
    ("http://bead.test.", Some("bead.test")),
    ("http://bead.test:", Some("bead.test")),
    ("http:bead.test", Some("bead.test")),
    ("http://bead.test/", Some("bead.test")),
    ("http://bead.test/path?query#fragment", Some("bead.test")),
    ("http://user@bead.test", Some("bead.test")),
    (" http://bead.test", Some("bead.test")),
    ("http://bead.test:8080x", Some("bead.test:8080")),
    ("http://[::1]x", Some("[::1]")),
    // any scheme but http and https, whatever host it names
    ("ws://bead.test", Some("bead.test")),
    ("wss://bead.test", Some("bead.test")),
    ("ftp://bead.test", Some("bead.test")),
    ("file://bead.test", Some("bead.test")),
    ("foo://bead.test", Some("bead.test")),
    ("chrome-extension://bead.test", Some("bead.test")),
    ("blob:http://bead.test", Some("bead.test")),
];

// the addresses a server listens on, the one name it takes, and the forms it refuses (spec
// 15.12), as the other sides' tests hold them alike: any other name, `localhost` in another case,
// with a final dot or under it among them; the short, hexadecimal, octal, padded and one-number
// forms; a leading zero; a final dot; brackets; a zone; an IPv4-mapped address
const LISTENING_ADDRESSES: &[&str] = &["127.0.0.1", "0.0.0.0", "::1", "::"];
const LISTENING_NAMES: &[&str] = &["localhost"];
const NO_LISTENING_ADDRESSES: &[&str] = &[
    "LOCALHOST",
    "localhost.",
    "a.localhost",
    "bead.example",
    "127.1",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "127.000.000.001",
    "2130706433",
    "1",
    "0",
    "1.2.3.04",
    "127.0.0.1.",
    "[::1]",
    "fe80::1%4",
    "::ffff:127.0.0.1",
];

fn owned(entries: &[&str]) -> Vec<String> {
    entries.iter().map(|entry| (*entry).to_owned()).collect()
}

fn taken<'a>(rows: &[Option<&'a str>], hosts: &[String]) -> Vec<Option<&'a str>> {
    rows.iter()
        .copied()
        .filter(|host| is_taken_host(*host, hosts))
        .collect()
}

fn some<'a>(rows: &[&'a str]) -> Vec<Option<&'a str>> {
    rows.iter().copied().map(Some).collect()
}

#[test]
fn takes_custom_origin_schemes_with_digits_and_punctuation_and_refuses_invalid_scheme_characters() {
    for scheme in ["demo+1", "demo-1", "demo.1", "a0+-."] {
        let origin = format!("{scheme}://Example.COM:80");
        let listed = [origin.clone()];

        assert_origins(&listed).expect("an origin of its own scheme, as written");
        assert!(
            is_taken_origin(
                Some(&origin),
                &TakenOrigins::new(Some("localhost"), &listed)
            ),
            "{origin} taken where it is listed"
        );
        assert!(
            !is_taken_origin(Some(&origin), &TakenOrigins::new(Some("localhost"), &[])),
            "{origin} refused where it is not"
        );
        assert_eq!(
            request_target_of(Some(&format!("{scheme}://bead.example/path"))),
            None,
            "another scheme's target, refused"
        );
    }

    for scheme in ["1demo", "Demo", "demo_1", "demo^1"] {
        assert_origins(&[format!("{scheme}://bead.example")]).expect_err(scheme);
    }
}

// spec 15.1
#[test]
fn trims_only_spaces_and_tabs_around_a_carried_credential_and_keeps_its_scheme_and_inner_whitespace()
 {
    for (lines, carried) in [
        (&[][..], None),
        (&[""][..], None),
        (&[" \t \t"][..], None),
        (&["Bearer token"][..], Some("Bearer token")),
        (&[" \tBearer token\t "][..], Some("Bearer token")),
        (&["\tBasic a \t b\t"][..], Some("Basic a \t b")),
        (
            &["\u{a0}Bearer token\u{a0}"][..],
            Some("\u{a0}Bearer token\u{a0}"),
        ),
    ] {
        assert_eq!(credential_of(lines), carried, "{lines:?}");
    }
}

#[test]
fn takes_a_host_http_takes_one_line_none_in_a_request_that_needs_none_its_value_uri_host_and_an_optional_port_without_the_whitespace_around_it_and_none_of_a_percent_encoded_octet_star_plus_comma_semicolon_or_equals_in_a_name_an_ipv_future_literal_or_a_colon_with_no_port()
 {
    for is_required in [false, true] {
        let well_formed: Vec<&str> = WELL_FORMED_HOSTS
            .iter()
            .copied()
            .filter(|host| is_well_formed_host(&[host], is_required))
            .collect();
        let malformed: Vec<&str> = MALFORMED_HOSTS
            .iter()
            .copied()
            .filter(|host| is_well_formed_host(&[host], is_required))
            .collect();

        assert_eq!(well_formed, WELL_FORMED_HOSTS, "each taken");
        assert_eq!(malformed, Vec::<&str>::new(), "none taken");
    }

    // none, where HTTP/1.1 asks one and HTTP/1.0 does not; two, whatever they name
    assert_eq!(
        [
            is_well_formed_host(&[], true),
            is_well_formed_host(&[], false),
            is_well_formed_host(&["bead.test", "bead.test"], true),
            is_well_formed_host(&["bead.test", "elsewhere.test"], false),
        ],
        [false, true, false, false],
        "none where one is required, and two whatever they name"
    );
}

#[test]
fn takes_whatever_its_hosts_localhost_the_names_under_localhost_and_ip_literals_each_by_its_host_on_any_port_and_no_other_host_nor_an_empty_one_nor_none_but_under_a_star()
 {
    for hosts in [
        &[][..],
        &["bead.test"][..],
        &["xn--bad-bma.test", "elsewhere.example"][..],
    ] {
        let hosts = owned(hosts);

        assert_eq!(
            taken(&some(EVERY_SERVERS), &hosts),
            some(EVERY_SERVERS),
            "{hosts:?}"
        );
        assert_eq!(
            taken(NO_SERVERS, &hosts),
            Vec::<Option<&str>>::new(),
            "{hosts:?}"
        );
    }

    let every: Vec<Option<&str>> = some(EVERY_SERVERS)
        .into_iter()
        .chain(NO_SERVERS.iter().copied())
        .collect();

    assert_eq!(
        taken(&every, &owned(&[EVERY_HOST])),
        every,
        "every host and none under *"
    );
    assert_eq!(
        [HOST_REFUSAL, ORIGIN_REFUSAL],
        ["host-refused", "origin-refused"],
        "the refusals' marks"
    );
}

#[test]
fn takes_the_hosts_given_besides_each_by_its_host_on_any_port_in_any_ascii_case_and_every_host_and_none_under_a_star()
 {
    let hosts = owned(HOSTS);

    assert_eq!(
        taken(&some(TAKEN_HOSTS), &hosts),
        some(TAKEN_HOSTS),
        "each listed host taken"
    );
    assert_eq!(
        taken(OTHER_HOSTS, &hosts),
        Vec::<Option<&str>>::new(),
        "none other"
    );

    let others: Vec<Option<&str>> = OTHER_HOSTS
        .iter()
        .copied()
        .chain([Some("rebind.example:8080"), Some("xn--a")])
        .collect();

    assert_eq!(taken(&others, &owned(&["*"])), others, "every host under *");
}

#[test]
fn refuses_a_hosts_entry_with_a_port_an_empty_one_one_that_is_no_host_and_a_star_beside_another() {
    for hosts in BUILT_HOSTS {
        assert_hosts(&owned(hosts)).expect("built");
    }

    for hosts in REFUSED_HOSTS {
        let refused = assert_hosts(&owned(hosts)).expect_err("refused");
        let named = if hosts.contains(&"*") {
            "*"
        } else {
            hosts
                .last()
                .copied()
                .filter(|last| !last.is_empty())
                .unwrap_or("empty")
        };

        assert!(refused.to_string().contains("hosts"), "{refused}");
        assert!(
            refused.to_string().contains(named),
            "{refused} names {named}"
        );
    }

    // the message names what to write instead
    assert!(
        assert_hosts(&owned(&["bead.test:8080"]))
            .expect_err("refused")
            .to_string()
            .contains("bead.test, not bead.test:8080"),
        "what to write instead"
    );
}

// spec 15.12
#[test]
fn refuses_an_origins_entry_that_is_a_star_or_null_or_not_an_origin_as_rfc_6454_serializes_it() {
    assert_origins(&[]).expect("none");
    assert_origins(&owned(BUILT_ORIGINS)).expect("built");

    for origin in REFUSED_ORIGINS {
        for origins in [owned(&[origin]), owned(&["https://bead.example", origin])] {
            let refused = assert_origins(&origins).expect_err(origin).to_string();

            assert!(refused.contains("origins"), "{refused}");
            assert!(refused.contains(origin), "{refused} names {origin}");
        }
    }

    assert!(
        assert_origins(&owned(&["*"]))
            .expect_err("refused")
            .to_string()
            .contains("no wildcard"),
        "no wildcard"
    );

    // null names every page with no origin of its own, and the message the better path
    let refused = assert_origins(&owned(&["https://bead.example", "null"]))
        .expect_err("refused")
        .to_string();

    assert!(
        refused.contains("does not take null: ")
            && refused.ends_with("serve the page from an origin, and name that one"),
        "{refused}"
    );
}

#[test]
fn reads_an_ipv4_address_by_rfc_3986_s_grammar_never_as_the_platform_s_parser_reads_one() {
    let addresses = [
        "0.0.0.0",
        "127.0.0.1",
        "10.0.0.10",
        "192.0.2.1",
        "255.255.255.255",
        "10.0.0.255",
        "1.22.199.249",
    ];
    // a short form, octal, hexadecimal, one number, an octet past 255, a leading zero, a final
    // dot, a fifth octet, a space, a port
    let others = [
        "127.1",
        "0177.0.0.1",
        "0x7f.0.0.1",
        "2130706433",
        "256.0.0.1",
        "127.0.0.01",
        "127.0.0.1.",
        "1.2.3.4.5",
        " 127.0.0.1",
        "127.0.0.1:80",
        "127.0.1",
        "00.0.0.0",
        "1.2.3.",
        ".1.2.3",
        "1..2.3",
        "+1.2.3.4",
        "1.2.3.4 ",
        "",
        "localhost",
    ];

    assert_eq!(
        addresses
            .iter()
            .copied()
            .filter(|address| is_ipv4_address(address))
            .collect::<Vec<&str>>(),
        addresses,
        "each an IPv4 address"
    );
    assert_eq!(
        others
            .iter()
            .copied()
            .filter(|address| is_ipv4_address(address))
            .collect::<Vec<&str>>(),
        Vec::<&str>::new(),
        "none"
    );

    // and so what every server takes: none of the others but the one with a port, by its host
    let every: Vec<&str> = addresses
        .iter()
        .chain(others.iter())
        .copied()
        .filter(|host| is_taken_host(Some(host), &[]))
        .collect();
    let expected: Vec<&str> = addresses
        .iter()
        .copied()
        .chain(["127.0.0.1:80", "localhost"])
        .collect();

    assert_eq!(every, expected, "what every server takes");
}

#[test]
fn takes_a_request_with_no_origin_one_among_those_given_and_the_server_s_own_http_or_https_followed_by_its_host_in_any_ascii_case_nothing_parsed()
 {
    let origins = owned(ORIGINS);

    // no page, or one among those given, exactly
    assert_eq!(
        [
            None,
            Some("https://bead.example"),
            Some("null"),
            Some("https://Bead.Example"),
        ]
        .map(|origin| is_taken_origin(origin, &TakenOrigins::new(Some("bead.test"), &origins))),
        [true, true, false, false],
        "none, or one listed exactly"
    );

    let own: Vec<(&str, &str)> = OWN
        .iter()
        .copied()
        .filter(|(origin, host)| is_taken_origin(Some(origin), &TakenOrigins::new(Some(host), &[])))
        .collect();
    let not_own: Vec<(&str, Option<&str>)> = NOT_OWN
        .iter()
        .copied()
        .filter(|(origin, host)| is_taken_origin(Some(origin), &TakenOrigins::new(*host, &[])))
        .collect();

    assert_eq!(own, OWN, "each its own");
    assert_eq!(not_own, Vec::<(&str, Option<&str>)>::new(), "none its own");
}

// spec 15.12
#[test]
fn own_authority_of_gives_the_authority_of_a_host_taken_by_name_every_server_s_or_one_listed_and_none_of_one_only_a_star_takes()
 {
    let authorities = [
        Some("localhost:8080"),
        Some("127.0.0.1:8080"),
        Some("[::1]:8080"),
        Some("Bead.Test:8443"),
        Some("rebind.example:8080"),
        Some(""),
        None,
    ];

    // by name, every server's or one listed, whether * is there or not
    assert_eq!(
        authorities.map(|authority| own_authority_of(authority, &owned(&["bead.test"]))),
        [
            Some("localhost:8080"),
            Some("127.0.0.1:8080"),
            Some("[::1]:8080"),
            Some("Bead.Test:8443"),
            None,
            None,
            None,
        ],
        "by name"
    );
    // * takes every host, and vouches for none of them: the rebound page names its own Host
    assert_eq!(
        authorities.map(|authority| own_authority_of(authority, &owned(&["*"]))),
        [
            Some("localhost:8080"),
            Some("127.0.0.1:8080"),
            Some("[::1]:8080"),
            None,
            None,
            None,
            None,
        ],
        "none of one only * takes"
    );
    assert_eq!(
        own_authority_of(Some("bead.test"), &[]),
        None,
        "none listed"
    );
    // and so the rebound page is none of the server's own under *, though * took its host
    assert!(
        is_taken_host(Some("rebind.example:8080"), &owned(&["*"])),
        "* takes its host"
    );
    assert!(
        !is_taken_origin(
            Some("http://rebind.example:8080"),
            &TakenOrigins::new(
                own_authority_of(Some("rebind.example:8080"), &owned(&["*"])),
                &[]
            )
        ),
        "and its origin is none of the server's own"
    );
}

// spec 15.12
#[test]
fn is_listed_origin_takes_an_origin_that_origins_names_exactly_the_server_s_own_only_when_named_and_never_none()
 {
    let origins = owned(ORIGINS);

    // ORIGINS names a page; the server's own is bead.test's
    assert_eq!(
        [
            Some("https://bead.example"),
            Some("null"),
            Some("https://Bead.Example"),
            Some("https://bead.example:443"),
            Some("http://bead.example"),
            Some("https://bead.test"),
            Some("Null"),
            None,
        ]
        .map(|origin| is_listed_origin(origin, &origins)),
        [true, false, false, false, false, false, false, false],
        "exactly as listed"
    );
    // the server's own, named
    assert!(
        is_listed_origin(Some("https://bead.test"), &owned(&["https://bead.test"])),
        "its own, named"
    );
    // none, whatever is named
    assert_eq!(
        [
            is_listed_origin(None, &[]),
            is_listed_origin(Some("null"), &[]),
            is_listed_origin(None, &owned(&["null"])),
        ],
        [false, false, false],
        "none is never listed"
    );

    for (origin, _) in OWN {
        assert!(!is_listed_origin(Some(origin), &[]), "{origin} unnamed");
        assert!(
            is_listed_origin(Some(origin), &owned(&[origin])),
            "{origin} named"
        );
    }
}

#[test]
fn is_ip_address_takes_a_bare_ip_address_by_rfc_3986_s_grammar_and_refuses_a_name_every_other_form_brackets_a_zone_and_an_ipv4_mapped_address()
 {
    assert_eq!(
        LISTENING_ADDRESSES
            .iter()
            .copied()
            .filter(|address| is_ip_address(address))
            .collect::<Vec<&str>>(),
        LISTENING_ADDRESSES,
        "each an IP address"
    );
    assert_eq!(
        NO_LISTENING_ADDRESSES
            .iter()
            .copied()
            .filter(|address| is_ip_address(address))
            .collect::<Vec<&str>>(),
        Vec::<&str>::new(),
        "none"
    );
    // the long forms of an IPv6 address are its own, and a mapped one is refused in any of them
    assert_eq!(
        [
            "0:0:0:0:0:0:0:1",
            "FE80::A",
            "::ffff:7f00:1",
            "0:0:0:0:0:ffff:127.0.0.1",
            "::1:",
        ]
        .map(is_ip_address),
        [true, true, false, false, false],
        "the long forms, and a mapped one in any of them"
    );
}

#[test]
fn refuses_to_listen_on_an_address_that_is_no_bare_ip_address_nor_localhost_naming_it_and_tells_a_bracketed_one_how_to_write_itself()
 {
    // localhost, exactly, both loopbacks
    for address in LISTENING_ADDRESSES.iter().chain(LISTENING_NAMES) {
        assert_listening_address(address).expect(address);
    }

    for address in NO_LISTENING_ADDRESSES {
        assert_listening_address(address).expect_err(address);
    }

    assert_eq!(
        assert_listening_address("LOCALHOST")
            .expect_err("refused")
            .to_string(),
        "a server listens on an IP address, or on localhost, both loopbacks, not \"LOCALHOST\"",
        "its message"
    );
    assert_eq!(
        assert_listening_address("[::1]")
            .expect_err("refused")
            .to_string(),
        "a server listens on an IP address, or on localhost, both loopbacks, not \"[::1]\": write ::1, not [::1]",
        "its message, and how to write it"
    );
}

// what is not visible ASCII in a field: each control character but a tab, DEL, and 0x80 to 0xFF
fn others_of_a_field() -> Vec<char> {
    ('\u{0}'..'\u{20}')
        .filter(|character| *character != '\t')
        .chain('\u{7F}'..='\u{FF}')
        .collect()
}

#[test]
fn is_visible_field_takes_htab_sp_and_visible_ascii_and_refuses_each_other_control_character_del_and_0x80_to_0xff_none_at_either_end()
 {
    let visible: String = (' '..='~').collect();
    let others = others_of_a_field();

    assert!(is_visible_field(&format!("a\t{visible}")), "visible ASCII");
    assert!(is_visible_field(""), "empty");
    assert!(is_visible_field("x \ty"), "a space and a tab within");
    // a space or a tab at either end, which HTTP/2 calls malformed (RFC 9113 §8.2.1)
    assert_eq!(
        [" x", "x ", "\tx", "x\t", " ", "\t", " \t "]
            .into_iter()
            .filter(|value| is_visible_field(value))
            .collect::<Vec<&str>>(),
        Vec::<&str>::new(),
        "none at either end"
    );
    assert_eq!(
        others
            .iter()
            .filter(|character| is_visible_field(&format!("a{character}b")))
            .collect::<Vec<&char>>(),
        Vec::<&char>::new(),
        "none other"
    );
    assert_eq!(others.len(), 31 + 129, "each counted");
    // a request's fields as they came, each name before its value: the values alone are read
    assert!(
        has_visible_fields(&["Host", "bead.test", "Origin", "http://a.example\tb"]),
        "visible"
    );
    assert!(
        !has_visible_fields(&["Host", "bead.test", "x-other", "caf\u{e9}"]),
        "past ASCII"
    );
    assert!(
        !has_visible_fields(&["Host", "bead.test", "x-other", "a\u{7}b"]),
        "a control"
    );
    assert!(
        !has_visible_fields(&["Host", "bead.test", "bead-after", "0 "]),
        "padded"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]
fn is_visible_target_takes_visible_ascii_and_a_percent_encoded_octet_nul_in_a_query_among_them_ends_a_target_at_its_hash_and_refuses_each_control_character_sp_del_and_0x80_to_0xff_a_character_a_browser_always_encodes_where_it_stands_and_nul_percent_encoded_in_a_path()
 {
    let visible: String = ('!'..='~').collect();
    let others: Vec<char> = ('\u{0}'..='\u{20}').chain('\u{7F}'..='\u{FF}').collect();
    let controls: Vec<char> = others
        .iter()
        .copied()
        .filter(|character| *character < ' ' || *character == '\u{7F}')
        .collect();
    // what a page's browser always percent-encodes in a path, and in a query
    let encoded_in_path = ['"', '<', '>', '^', '`', '{', '}'];
    let encoded_in_query = ['"', '<', '>'];
    let without = |left: &[char]| -> String {
        visible
            .chars()
            .filter(|character| *character != '#' && !left.contains(character))
            .collect()
    };
    let is_taken = |target: &str| is_visible_target(Some(target));

    // * a target ends at its #, and the characters a browser sends unencoded are taken as they came
    assert!(
        is_taken(&format!("/{}", without(&encoded_in_path))),
        "a path"
    );
    assert!(
        is_taken(&format!("/bead?{}", without(&encoded_in_query))),
        "a query"
    );
    assert!(
        is_taken(&format!(
            "http://127.0.0.1/{}?{}",
            without(&encoded_in_path),
            without(&encoded_in_query)
        )),
        "absolute-form"
    );
    assert!(is_taken("/be\\ad|x?a\\b|c^d`e{}f"), "sent unencoded");
    assert!(is_visible_target(None), "none");
    assert!(is_taken("/a%01b%7F%FF?x=%00"), "percent-encoded");
    assert!(is_taken("http://127.0.0.1/a%01?%00"), "percent-encoded");
    // what follows a # is neither its path nor its query: no rule of either reaches it
    assert_eq!(
        [
            format!("/bead#{visible}"),
            "/bead#a b".to_owned(),
            "/bead#\u{e9}".to_owned(),
            "/a#%00?x".to_owned(),
            "/bead?x#<\"".to_owned(),
            "http://127.0.0.1/#{}".to_owned(),
        ]
        .into_iter()
        .filter(|target| !is_taken(target))
        .collect::<Vec<String>>(),
        Vec::<String>::new(),
        "nothing past a # judged"
    );
    assert_eq!(
        others
            .iter()
            .filter(|character| {
                [
                    format!("/a{character}b"),
                    format!("/bead?a{character}b"),
                    format!("http://127.0.0.1/a{character}b"),
                ]
                .iter()
                .any(|target| is_taken(target))
            })
            .collect::<Vec<&char>>(),
        Vec::<&char>::new(),
        "none other"
    );
    assert_eq!(others.len(), 33 + 129, "each counted");
    // a control character is the request-line's, past a # too
    assert_eq!(
        controls
            .iter()
            .filter(|character| {
                [
                    format!("/bead#a{character}b"),
                    format!("/bead?x#{character}"),
                ]
                .iter()
                .any(|target| is_taken(target))
            })
            .collect::<Vec<&char>>(),
        Vec::<&char>::new(),
        "a control refused past a #"
    );
    assert_eq!(controls.len(), 32 + 1, "each counted");
    // a character a browser always encodes where it stands, in origin-form or absolute-form, and
    // those it sends unencoded in a query
    assert_eq!(
        encoded_in_path
            .iter()
            .filter(|character| {
                [
                    format!("/a{character}b"),
                    format!("http://127.0.0.1/a{character}b"),
                ]
                .iter()
                .any(|target| is_taken(target))
            })
            .collect::<Vec<&char>>(),
        Vec::<&char>::new(),
        "encoded in a path"
    );
    assert_eq!(
        encoded_in_query
            .iter()
            .filter(|character| {
                [
                    format!("/bead?a{character}b"),
                    format!("http://127.0.0.1/?a{character}b"),
                ]
                .iter()
                .any(|target| is_taken(target))
            })
            .collect::<Vec<&char>>(),
        Vec::<&char>::new(),
        "encoded in a query"
    );
    assert_eq!(
        ['^', '`', '{', '}', '\\', '|']
            .into_iter()
            .filter(|character| !is_taken(&format!("/bead?a{character}b")))
            .collect::<Vec<char>>(),
        Vec::<char>::new(),
        "sent unencoded in a query"
    );
    // a path whose percent-decoding holds NUL, in origin-form or absolute-form
    assert_eq!(
        ["/%00", "/be%00ad", "/a%00#x", "http://127.0.0.1/a%00b?x=1"]
            .into_iter()
            .filter(|target| is_taken(target))
            .collect::<Vec<&str>>(),
        Vec::<&str>::new(),
        "NUL in a path"
    );
}

#[test]
fn tells_a_request_s_origin_as_it_came_its_field_lines_joined_by_a_comma_and_a_space_and_none_when_it_sends_none()
 {
    assert_eq!(
        [
            origin_of(&[]),
            origin_of(&["null"]),
            origin_of(&["https://a.test", "null"]),
        ],
        [
            None,
            Some("null".to_owned()),
            Some("https://a.test, null".to_owned()),
        ],
        "as it came"
    );
}

#[test]
fn folds_ascii_alone_a_host_that_differs_past_ascii_is_another() {
    // the Kelvin sign and a dotted capital I, which a fold past ASCII would take for a k and an i;
    // an i without its dot and an É, which it would take for an I and an é
    assert!(
        !is_taken_host(Some("\u{212a}ey.test"), &owned(&["key.test"])),
        "the Kelvin sign"
    );
    assert!(
        !is_taken_host(Some("\u{130}tem.test"), &owned(&["item.test"])),
        "a dotted capital I"
    );
    assert!(
        !is_taken_host(Some("bead.\u{131}o"), &owned(&["bead.io"])),
        "an i without its dot"
    );
    assert!(
        !is_taken_host(Some("b\u{c9}ad.test"), &owned(&["b\u{e9}ad.test"])),
        "an \u{c9}"
    );
    assert!(
        is_taken_host(Some("B\u{e9}AD.test"), &owned(&["b\u{e9}ad.test"])),
        "ASCII folded"
    );
    assert!(is_taken_host(Some("LOCALHOST"), &[]), "localhost folded");
    assert!(
        !is_taken_origin(
            Some("http://key.test"),
            &TakenOrigins::new(Some("\u{212a}ey.test"), &[])
        ),
        "the Kelvin sign"
    );
    assert!(
        !is_taken_origin(
            Some("http://item.test"),
            &TakenOrigins::new(Some("\u{130}tem.test"), &[])
        ),
        "a dotted capital I"
    );
    assert!(
        !is_taken_origin(
            Some("http://bead.io"),
            &TakenOrigins::new(Some("BEAD.\u{131}O"), &[])
        ),
        "an i without its dot"
    );
}

#[test]
fn reads_an_absolute_form_targets_scheme_in_any_case_http_as_http_ends_a_target_at_its_and_refuses_one_without_an_authority()
 {
    for target in ["http:///", "HTTP:///", "http://#x/", "ftp://127.0.0.1/"] {
        assert_eq!(request_target_of(Some(target)), None, "{target}");
    }

    let read = RequestTarget {
        authority: Some("127.0.0.1"),
        path: "/bead",
        query: "x=1",
    };

    assert_eq!(
        [
            "HTTP://127.0.0.1/bead?x=1",
            "hTtP://127.0.0.1/bead?x=1",
            "HTTPS://127.0.0.1/bead?x=1",
        ]
        .map(|target| request_target_of(Some(target))),
        [Some(read); 3],
        "its scheme in any case"
    );
    assert_eq!(
        [
            "/bead#x",
            "/bead?x=1#y?z",
            "http://127.0.0.1#/bead",
            "/bead#",
            "http://bead.test?x",
        ]
        .map(|target| request_target_of(Some(target))),
        [
            Some(RequestTarget {
                authority: None,
                path: "/bead",
                query: "",
            }),
            Some(RequestTarget {
                authority: None,
                path: "/bead",
                query: "x=1",
            }),
            Some(RequestTarget {
                authority: Some("127.0.0.1"),
                path: "/",
                query: "",
            }),
            Some(RequestTarget {
                authority: None,
                path: "/bead",
                query: "",
            }),
            Some(RequestTarget {
                authority: Some("bead.test"),
                path: "/",
                query: "x",
            }),
        ],
        "ended at its #"
    );
}
