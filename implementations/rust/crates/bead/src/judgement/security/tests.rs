use super::*;

// the rows every side judges alike (spec 13.4): under TLS, or on the loopback by the host given
const SECURE: &[&str] = &[
    "wss://bead.example",
    "https://bead.example",
    "ws://localhost:8080",
    "ws://LOCALHOST",
    "http://a.localhost",
    "ws://127.0.0.1",
    "ws://127.255.255.254",
    "ws://[::1]:8080",
    "ws://[0:0:0:0:0:0:0:1]",
];
const IN_THE_CLEAR: &[&str] = &[
    "ws://bead.example",
    "http://192.0.2.1",
    "ws://128.0.0.1",
    "ws://localhost.example",
    "ws://127.0.0.1.example",
    "ws://[::2]",
    "ws://[::ffff:127.0.0.1]",
];

// a host, and whether it is on the loopback as the URL Standard's host parser reads it
const PARSED_HOSTS: &[(&str, bool)] = &[
    ("127.0.0.1.", true),
    ("127.1", true),
    ("[::1]", true),
    ("localhost", true),
    ("localhost.", false),
    ("127.0.0.1 ", false),
    ("localhost ", false),
    ("[::1] ", false),
];

// a URL as a client of the TypeScript side is given it, read as this side's clients are given
// theirs: its scheme under TLS or not, and its host, the port aside; none secure that is no URL
fn is_secure_url(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .and_then(|close| authority.get(..=close))
            .unwrap_or(authority)
    } else {
        authority.split(':').next().unwrap_or_default()
    };

    is_secure(scheme == "wss" || scheme == "https", Some(host))
}

#[test]
fn judges_a_url_secure_under_tls_or_on_the_loopback_by_the_host_it_is_given_and_any_other_in_the_clear()
 {
    assert_eq!(
        SECURE
            .iter()
            .copied()
            .filter(|url| is_secure_url(url))
            .collect::<Vec<_>>(),
        SECURE,
        "each secure"
    );
    assert_eq!(
        IN_THE_CLEAR
            .iter()
            .copied()
            .filter(|url| is_secure_url(url))
            .collect::<Vec<&str>>(),
        Vec::<&str>::new(),
        "none secure"
    );
    assert!(!is_secure_url("not a URL"), "no URL");
}

#[test]
fn judges_the_host_a_server_listens_on_as_a_url_s_an_ipv6_one_bare_or_bracketed() {
    assert_eq!(
        [
            "127.0.0.1",
            "localhost",
            "a.LOCALHOST",
            "::1",
            "[::1]",
            "0:0:0:0:0:0:0:1"
        ]
        .map(is_loopback_host),
        [true; 6],
        "on the loopback"
    );
    assert_eq!(
        [
            "0.0.0.0",
            "::",
            "192.0.2.1",
            "bead.example",
            "::ffff:127.0.0.1"
        ]
        .map(is_loopback_host),
        [false; 5],
        "off it"
    );
}

#[test]
fn judges_a_host_as_the_url_standard_s_host_parser_reads_it_127_0_0_1_127_1_the_ipv6_loopback_and_localhost_on_the_loopback_a_host_followed_by_a_space_and_localhost_not_alike_for_a_server_and_its_client()
 {
    // a server's by the host it listens on, a client's by the host its connect is given, which
    // this side's clients take in place of a URL
    assert_eq!(
        PARSED_HOSTS
            .iter()
            .map(|(host, _)| (*host, is_loopback_host(host)))
            .collect::<Vec<_>>(),
        PARSED_HOSTS,
        "a server's"
    );
    assert_eq!(
        PARSED_HOSTS
            .iter()
            .map(|(host, _)| (*host, is_secure(false, Some(host))))
            .collect::<Vec<_>>(),
        PARSED_HOSTS,
        "a client's"
    );
}
