//! The proxies a server believes `X-Forwarded-For` from, and the client's address it reads past
//! them (spec 15.12): the twins of `trusted-proxies.test.ts` and `TrustedProxiesTests`, by their
//! rows.

use super::{
    ClientAddressOptions, MAXIMUM_UNNAMED_PROXIES, TrustedProxies, address_of_entry,
    assert_trusted_proxies, client_address_of, held_address_of, trusted_proxies_of,
};

// the entries a server is built with, and those it is refused
const TAKEN: &[&str] = &[
    "127.0.0.1",
    "::1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.1.178",
    "192.0.2.0/24",
    "192.0.2.7/32",
    "192.0.2.1/32",
    "0.0.0.0/1",
    "fd00::/8",
    "2001:DB8::/32",
    "2001:db8::1/128",
    "::/1",
];
const REFUSED: &[&str] = &[
    "nginx",
    "localhost",
    "",
    "*",
    "[::1]",
    "[2001:db8::]/32",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.0/104",
    "127.1",
    "10.0.0.0/",
    "10.0.0.0/08",
    "10.0.0.0/-8",
    "10.0.0.0/a",
    "10.0.0.0/8/8",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.1.2.3/8",
    "192.0.2.1/24",
    "fd00::1/8",
    "2001:db8::1/32",
    "2001:db8::1/127",
];

fn owned(entries: &[&str]) -> Vec<String> {
    entries.iter().map(|entry| (*entry).to_owned()).collect()
}

fn trusted(entries: &[&str]) -> TrustedProxies {
    trusted_proxies_of(&owned(entries), None).expect("trusted proxies")
}

// the client's address `remote` reaches past `trusted`, `forwarded` its field
fn walked(remote: &str, (forwarded, trusted): (Option<&str>, Option<&TrustedProxies>)) -> String {
    client_address_of(
        remote,
        &ClientAddressOptions {
            forwarded,
            trusted_proxies: trusted,
        },
    )
}

#[test]
fn reads_one_to_five_ascii_port_digits_and_stops_forwarding_at_any_other_port() {
    let proxies = trusted(&["127.0.0.1", "10.0.0.0/8"]);

    for (node, address) in [("192.0.2.7", "192.0.2.7"), ("[2001:db8::1]", "2001:db8::1")] {
        for port in ["0", "9", "00000", "65535", "99999"] {
            let entry = format!("{node}:{port}");

            assert_eq!(
                address_of_entry(&entry).as_deref(),
                Some(address),
                "{entry}"
            );
            assert_eq!(
                walked(
                    "127.0.0.1",
                    (Some(&format!("203.0.113.9, {entry}")), Some(&proxies))
                ),
                address,
                "{entry}"
            );
        }

        for port in ["", "123456", "x", "1x", "\u{ff11}\u{ff12}", "\u{661}"] {
            let entry = format!("{node}:{port}");

            assert_eq!(address_of_entry(&entry), None, "{entry}");
            assert_eq!(
                walked(
                    "127.0.0.1",
                    (Some(&format!("203.0.113.9, {entry}")), Some(&proxies))
                ),
                "127.0.0.1",
                "{entry}"
            );
            assert_eq!(
                walked(
                    "127.0.0.1",
                    (
                        Some(&format!("203.0.113.9, {entry}, 10.0.0.1")),
                        Some(&proxies)
                    )
                ),
                "10.0.0.1",
                "{entry}"
            );
        }
    }
}

#[test]
fn keeps_a_direct_client_address_when_no_forwarding_policy_is_supplied() {
    assert_eq!(
        ["192.0.2.7", "::ffff:192.0.2.7", "2001:DB8::1", "fe80::1%3"]
            .map(|address| walked(address, (None, None))),
        ["192.0.2.7", "192.0.2.7", "2001:db8::1", "fe80::1"],
        "each in its one form"
    );
}

#[test]
fn stops_at_a_malformed_bracketed_forwarding_entry_before_reading_a_claimed_client() {
    let proxies = trusted(&["127.0.0.1", "10.0.0.0/8"]);

    for entry in ["[", "[::1", "[2001:db8::1", "[::1]extra", "[::1]:x"] {
        assert_eq!(address_of_entry(entry), None, "{entry}");
        assert_eq!(
            walked(
                "127.0.0.1",
                (Some(&format!("203.0.113.9, {entry}")), Some(&proxies))
            ),
            "127.0.0.1",
            "{entry}"
        );
        assert_eq!(
            walked(
                "127.0.0.1",
                (
                    Some(&format!("203.0.113.9, {entry}, 10.0.0.1")),
                    Some(&proxies)
                )
            ),
            "10.0.0.1",
            "{entry}"
        );
    }
}

#[test]
fn trusts_only_the_two_addresses_of_an_uncompressed_ipv6_prefix_of_127_bits() {
    let network = "2001:db8:1:2:3:4:5:6/127";
    let proxies = trusted(&[network]);

    assert_eq!(
        [
            "2001:db8:1:2:3:4:5:5",
            "2001:db8:1:2:3:4:5:6",
            "2001:db8:1:2:3:4:5:7",
            "2001:db8:1:2:3:4:5:8",
        ]
        .map(|remote| walked(remote, (Some("203.0.113.9"), Some(&proxies)))),
        [
            "2001:db8:1:2:3:4:5:5",
            "203.0.113.9",
            "203.0.113.9",
            "2001:db8:1:2:3:4:5:8",
        ],
        "its two addresses"
    );
    assert_eq!(
        assert_trusted_proxies(&owned(&["2001:db8:1:2:3:4:5:7/127"]))
            .expect_err("refused")
            .to_string(),
        format!(
            "a trustedProxies network has no bits set past its prefix: write {network}, not 2001:db8:1:2:3:4:5:7/127"
        ),
        "what to write instead"
    );
}

// spec 15.12
#[test]
fn refuses_a_trusted_proxies_entry_that_is_a_name_a_bracketed_or_zoned_address_an_ipv4_mapped_one_a_prefix_of_0_or_past_its_family_s_bits_or_a_network_whose_bits_past_its_prefix_are_set()
 {
    assert_trusted_proxies(&[]).expect("none");
    assert_trusted_proxies(&owned(TAKEN)).expect("built");

    for entry in REFUSED {
        for entries in [owned(&[entry]), owned(&["127.0.0.1", entry])] {
            let refused = assert_trusted_proxies(&entries)
                .expect_err(entry)
                .to_string();
            let named = if entry.ends_with("/0") {
                "prefix 0"
            } else {
                entry
            };

            assert!(refused.contains("trustedProxies"), "{refused}");
            assert!(refused.contains(named), "{refused} names {named}");
        }
    }

    // the messages name what to write instead, and why prefix 0 is refused
    assert!(
        assert_trusted_proxies(&owned(&["10.1.2.3/8"]))
            .expect_err("refused")
            .to_string()
            .ends_with("write 10.0.0.0/8, not 10.1.2.3/8"),
        "what to write instead"
    );
    assert!(
        assert_trusted_proxies(&owned(&["fd00::1/8"]))
            .expect_err("refused")
            .to_string()
            .ends_with("write fd00::/8, not fd00::1/8"),
        "what to write instead"
    );
    assert_eq!(
        assert_trusted_proxies(&owned(&["127.0.0.1", "::/0"]))
            .expect_err("refused")
            .to_string(),
        "trustedProxies does not take a network of prefix 0: it would trust what every client writes",
        "why prefix 0 is refused"
    );
    // and the building refuses alike
    trusted_proxies_of(&owned(&["nginx"]), None).expect_err("refused as it is built");
    assert!(
        assert_trusted_proxies(&owned(&["[::1]"]))
            .expect_err("refused")
            .to_string()
            .contains("write ::1, not [::1]"),
        "how to write a bracketed one"
    );
}

// spec 15.12
#[test]
fn walks_x_forwarded_for_from_the_right_past_each_proxy_it_names_and_stops_at_the_first_address_none_holds_or_at_an_entry_that_is_no_address()
 {
    let proxies = trusted(&["127.0.0.0/8", "10.0.0.0/8"]);
    let walk = |remote: &str, forwarded: Option<&str>| walked(remote, (forwarded, Some(&proxies)));

    assert_eq!(
        [
            // one proxy, then two: the rightmost entry none of them holds
            walk("127.0.0.1", Some("198.51.100.7")),
            walk("127.0.0.1", Some("198.51.100.7, 10.0.0.5")),
            // what a client wrote left of it is never read
            walk("127.0.0.1", Some("203.0.113.9, 198.51.100.7, 10.0.0.6")),
            // every entry a proxy: the leftmost
            walk("127.0.0.2", Some("10.0.0.7, 10.0.0.6")),
            // an entry that is no address ends the walk at the proxy that wrote it
            walk("127.0.0.1", Some("evil, 10.0.0.5")),
            walk("127.0.0.1", Some("198.51.100.7, unknown")),
            walk("127.0.0.1", Some("198.51.100.7, , 10.0.0.5")),
            walk("127.0.0.1", Some("198.51.100.7, ")),
            walk("127.0.0.1", Some("")),
            // its lines joined by commas, the spaces and tabs around each entry dropped
            walk("127.0.0.1", Some("203.0.113.9,\t198.51.100.7 ,10.0.0.5")),
            // no field: the socket's
            walk("127.0.0.1", None),
            // a socket no entry holds: its field is never read
            walk("192.0.2.1", Some("198.51.100.7")),
        ],
        [
            "198.51.100.7",
            "198.51.100.7",
            "198.51.100.7",
            "10.0.0.7",
            "10.0.0.5",
            "127.0.0.1",
            "10.0.0.5",
            "127.0.0.1",
            "127.0.0.1",
            "198.51.100.7",
            "127.0.0.1",
            "192.0.2.1",
        ],
        "each walked"
    );
    // none named, none trusted, the loopback among them
    assert_eq!(
        [
            walked("127.0.0.1", (Some("198.51.100.7"), None)),
            walked("127.0.0.1", (Some("198.51.100.7"), Some(&trusted(&[])))),
        ],
        ["127.0.0.1", "127.0.0.1"],
        "none trusted"
    );
}

// spec 15.12; a count is a whole number by its type here: the fraction, NaN and the infinities the
// other sides refuse are none
#[test]
fn refuses_an_unnamed_proxies_that_is_not_a_whole_number_from_0_to_8_infinity_among_it_as_the_server_is_built()
 {
    for count in [9, (1 << 31) - 1, u64::MAX] {
        assert_eq!(
            trusted_proxies_of(&[], Some(count))
                .expect_err("refused")
                .to_string(),
            format!(
                "unnamedProxies is a whole number of proxies from 0 to 8, those trustedProxies does not name: not {count}"
            ),
            "{count}"
        );
    }

    assert_eq!(MAXIMUM_UNNAMED_PROXIES, 8, "its bound");

    for count in [None, Some(0), Some(1), Some(8)] {
        trusted_proxies_of(&[], count).expect("built");
    }

    assert_eq!(
        [
            trusted_proxies_of(&[], None).expect("built").unnamed(),
            trusted_proxies_of(&[], Some(3)).expect("built").unnamed(),
        ],
        [0, 3],
        "its count"
    );
}

// spec 15.12
#[test]
fn spends_unnamed_proxies_on_each_address_trusted_proxies_does_not_hold_none_on_one_it_holds_and_stops_at_the_first_past_the_count()
 {
    let walk = |(named, unnamed): (&[&str], u64), (forwarded, remote): (&str, &str)| {
        let proxies = trusted_proxies_of(&owned(named), Some(unnamed)).expect("trusted proxies");

        walked(remote, (Some(forwarded), Some(&proxies)))
    };
    let at = "127.0.0.1";

    assert_eq!(
        [
            // a count alone: that many hops from the socket, whatever their address
            walk((&[], 1), ("198.51.100.7, 192.0.2.1", at)),
            walk((&[], 2), ("203.0.113.9, 198.51.100.7, 192.0.2.1", at)),
            // a named hop passes free, wherever it stands: before the unnamed one or after it
            walk((&["10.0.0.0/8"], 1), ("198.51.100.7, 10.0.0.5", at)),
            walk(
                (&["10.0.0.0/8"], 1),
                ("198.51.100.8, 10.0.0.6, 10.0.0.5", at)
            ),
            walk(
                (&["10.0.0.0/8"], 1),
                ("203.0.113.9, 10.0.0.5, 198.51.100.7", "10.0.0.1")
            ),
            // past the count, the first address none holds is the client: what it wrote left is
            // not read
            walk((&["10.0.0.0/8"], 1), ("203.0.113.9, 198.51.100.7", at)),
            // a proxy both named and counted gives the client an entry it wrote
            walk(
                (&["127.0.0.1/32"], 2),
                ("192.0.2.66, 203.0.113.1, 198.51.100.7", at)
            ),
            // an entry that is no address ends the walk within the count, and so does the
            // field's end
            walk((&[], 3), ("unknown, 192.0.2.1", at)),
            walk((&[], 3), ("192.0.2.1", at)),
            // 0 counts none: an unnamed socket's field is not read
            walk((&[], 0), ("192.0.2.1", at)),
        ],
        [
            "192.0.2.1",
            "198.51.100.7",
            "198.51.100.7",
            "198.51.100.8",
            "203.0.113.9",
            "198.51.100.7",
            "192.0.2.66",
            "192.0.2.1",
            "192.0.2.1",
            "127.0.0.1",
        ],
        "each walked"
    );
}

// spec 15.12
#[test]
fn reads_an_entry_in_rfc_7239_s_node_forms_its_port_dropped_and_holds_it_in_one_form_an_ipv4_mapped_one_as_ipv4_ipv6_as_rfc_5952_writes_it_hexadecimal_throughout_a_zone_ends_the_walk()
 {
    let forms: &[(&str, Option<&str>)] = &[
        ("192.0.2.7", Some("192.0.2.7")),
        (" \t192.0.2.7 ", Some("192.0.2.7")),
        ("192.0.2.7:51234", Some("192.0.2.7")),
        (" 192.0.2.7:51234 ", Some("192.0.2.7")),
        ("::ffff:192.0.2.7", Some("192.0.2.7")),
        ("::FFFF:c000:207", Some("192.0.2.7")),
        ("[::ffff:192.0.2.7]:80", Some("192.0.2.7")),
        ("2001:db8:0:0:0:0:0:1", Some("2001:db8::1")),
        ("2001:DB8::1", Some("2001:db8::1")),
        ("[2001:DB8::1]:443", Some("2001:db8::1")),
        ("[2001:db8::1]", Some("2001:db8::1")),
        ("[2001:db8::3]", Some("2001:db8::3")),
        ("2001:db8:0:0:1:0:0:1", Some("2001:db8::1:0:0:1")),
        ("2001:0:0:1:0:0:0:1", Some("2001:0:0:1::1")),
        ("0:0:0:0:0:0:0:0", Some("::")),
        ("::1", Some("::1")),
        ("::192.0.2.1", Some("::c000:201")),
        ("[::192.0.2.1]:1", Some("::c000:201")),
        ("fe80::5efe:192.0.2.1", Some("fe80::5efe:c000:201")),
        ("::ffff:0:192.0.2.1", Some("::ffff:0:c000:201")),
        // a zone, a name, unknown, an obfuscated node, a quoted one, brackets around IPv4, a port
        // past five digits, an empty entry
        ("2001:db8::2%eth0", None),
        ("[fe80::1%25eth0]:80", None),
        ("[fe80::1%25eth0]", None),
        ("proxy.example", None),
        ("bead.test", None),
        ("unknown", None),
        ("_hidden", None),
        ("\"[2001:db8::1]:443\"", None),
        ("\"192.0.2.7\"", None),
        ("[192.0.2.7]", None),
        ("[2001:db8::1]:", None),
        ("[2001:db8::1]:123456", None),
        ("192.0.2.7:123456", None),
        ("192.0.2.7:", None),
        ("127.1", None),
        ("010.0.0.1", None),
        ("", None),
    ];

    assert_eq!(
        forms
            .iter()
            .map(|(entry, _)| (*entry, address_of_entry(entry)))
            .collect::<Vec<(&str, Option<String>)>>(),
        forms
            .iter()
            .map(|(entry, address)| (*entry, address.map(str::to_owned)))
            .collect::<Vec<(&str, Option<String>)>>(),
        "each read"
    );
    // a socket's address alike, its zone left out
    assert_eq!(
        [
            "::ffff:127.0.0.1",
            "::1",
            "0:0:0:0:0:0:0:1",
            "::192.0.2.1",
            "127.0.0.1",
            "2001:DB8::1%3",
            "fe80::1%3",
            "::ffff:192.0.2.7",
        ]
        .map(held_address_of),
        [
            "127.0.0.1",
            "::1",
            "::1",
            "::c000:201",
            "127.0.0.1",
            "2001:db8::1",
            "fe80::1",
            "192.0.2.7",
        ],
        "each held"
    );

    // a zone ends the walk at the proxy that wrote it
    let proxies = trusted(&["127.0.0.1"]);

    assert_eq!(
        [
            "2001:db8::2%eth0",
            "[2001:DB8::1]:443",
            "::ffff:192.0.2.7",
            "192.0.2.7:51234",
            "2001:db8:0:0:0:0:0:1",
            "[2001:db8::3]",
            "unknown",
        ]
        .map(|forwarded| walked("127.0.0.1", (Some(forwarded), Some(&proxies)))),
        [
            "127.0.0.1",
            "2001:db8::1",
            "192.0.2.7",
            "192.0.2.7",
            "2001:db8::1",
            "2001:db8::3",
            "127.0.0.1",
        ],
        "each walked"
    );
}

// spec 15.12
#[test]
fn holds_an_ipv4_client_of_a_dual_stack_socket_by_its_ipv4_address_against_an_ipv4_network() {
    let proxies = trusted(&["127.0.0.0/8", "10.0.0.0/8"]);

    assert_eq!(
        [
            // the proxy's socket, IPv4 mapped into IPv6, held by the IPv4 network that names it
            walked("::ffff:127.0.0.1", (Some("198.51.100.7"), Some(&proxies))),
            walked("::ffff:10.0.0.5", (Some("198.51.100.8"), Some(&proxies))),
            // a client's, direct, held as the IPv4 address it is, which no network holds
            walked("::ffff:192.0.2.1", (Some("198.51.100.9"), Some(&proxies))),
        ],
        ["198.51.100.7", "198.51.100.8", "192.0.2.1"],
        "held as IPv4"
    );
    assert_eq!(
        [
            walked(
                "::ffff:10.0.0.5",
                (Some("203.0.113.9"), Some(&trusted(&["10.0.0.0/8"])))
            ),
            walked(
                "::ffff:10.0.0.5",
                (Some("203.0.113.9"), Some(&trusted(&["192.168.0.0/16"])))
            ),
            walked("::ffff:10.0.0.5", (None, Some(&trusted(&["10.0.0.0/8"])))),
        ],
        ["203.0.113.9", "10.0.0.5", "10.0.0.5"],
        "against an IPv4 network"
    );
    // an IPv6 network holds no IPv4 address, nor an IPv4 network an IPv6 one
    assert_eq!(
        [
            walked(
                "::ffff:10.0.0.5",
                (Some("203.0.113.9"), Some(&trusted(&["::/1"])))
            ),
            walked(
                "2001:db8::5",
                (
                    Some("203.0.113.9"),
                    Some(&trusted(&["0.0.0.0/1", "128.0.0.0/1"]))
                )
            ),
        ],
        ["10.0.0.5", "2001:db8::5"],
        "each family its own"
    );
}
