//! The judgement of a request at a WebSocket's address before its 101 (spec 15.2): the twins of
//! `websocket-handshake.test.ts` and `WebSocketHandshakeTests`, by their rows.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use super::{
    AnswerField, HandshakeRequest, HandshakeTaken, HandshakeTold, WEBSOCKET_REFUSALS,
    WebSocketRefusals, refusal_of_handshake, told_of_handshake,
};

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

// RFC 6455 §1.3's handshake, from a host and an origin the server takes
const HANDSHAKE: &[(&str, &str)] = &[
    ("Host", "bead.test"),
    ("Upgrade", "websocket"),
    ("Connection", "Upgrade"),
    ("Sec-WebSocket-Key", KEY),
    ("Sec-WebSocket-Version", "13"),
];

// what the judgement answers a request: taken, or refused by its status and its mark
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Answer {
    Taken,
    Refused(u16, Option<&'static str>),
}

const TAKEN: Answer = Answer::Taken;
const HOST: Answer = Answer::Refused(400, None);
const HOST_REFUSED: Answer = Answer::Refused(403, Some("host-refused"));
const METHOD: Answer = Answer::Refused(405, Some("method-refused"));
const UPGRADE: Answer = Answer::Refused(426, Some("upgrade-required"));
const VERSION: Answer = Answer::Refused(426, Some("version-refused"));
const MALFORMED: Answer = Answer::Refused(400, Some("malformed"));
const ORIGIN: Answer = Answer::Refused(403, Some("origin-refused"));

// a request as a row asks it, owned
#[derive(Debug, Clone)]
struct Asked {
    http_version: String,
    method: String,
    fields: Vec<String>,
    target: Option<String>,
}

// how a row's request differs from the handshake: its version, its method, its target, and the
// handshake's fields it leaves out, by their names in lower case
#[derive(Debug, Clone, Copy, Default)]
struct Shape<'a> {
    http_version: Option<&'a str>,
    method: Option<&'a str>,
    target: Option<&'a str>,
    without: &'a [&'a str],
}

// the handshake's fields but those `shape` leaves out, then `fields`
fn request_of(fields: &[(&str, &str)], shape: Shape<'_>) -> Asked {
    let kept = HANDSHAKE
        .iter()
        .filter(|(name, _)| !shape.without.contains(&name.to_ascii_lowercase().as_str()));

    Asked {
        http_version: shape.http_version.unwrap_or("1.1").to_owned(),
        method: shape.method.unwrap_or("GET").to_owned(),
        fields: kept
            .chain(fields.iter())
            .flat_map(|(name, value)| [(*name).to_owned(), (*value).to_owned()])
            .collect(),
        target: shape.target.map(str::to_owned),
    }
}

fn plain(fields: &[(&str, &str)]) -> Asked {
    request_of(fields, Shape::default())
}

fn without(fields: &[(&str, &str)], left: &'static [&'static str]) -> Asked {
    request_of(
        fields,
        Shape {
            without: left,
            ..Shape::default()
        },
    )
}

fn judged<T, J: FnOnce(&HandshakeRequest<'_>) -> T>(asked: &Asked, judge: J) -> T {
    let fields: Vec<&str> = asked.fields.iter().map(String::as_str).collect();
    let mut request = HandshakeRequest::new(&asked.http_version, &fields);

    request.method = Some(&asked.method);
    request.target = asked.target.as_deref();

    judge(&request)
}

fn answer_given(hosts: &[&str], asked: &Asked) -> Answer {
    let hosts: Vec<String> = hosts.iter().map(|host| (*host).to_owned()).collect();

    judged(asked, |request| {
        refusal_of_handshake(request, &HandshakeTaken::new(&hosts, &[]))
            .map_or(Answer::Taken, |refusal| {
                Answer::Refused(refusal.status, refusal.refusal)
            })
    })
}

fn answer_of(asked: &Asked) -> Answer {
    let hosts = ["bead.test".to_owned()];
    let origins = ["https://bead.example".to_owned()];

    judged(asked, |request| {
        refusal_of_handshake(request, &HandshakeTaken::new(&hosts, &origins))
            .map_or(Answer::Taken, |refusal| {
                Answer::Refused(refusal.status, refusal.refusal)
            })
    })
}

fn answers_of(asked: &[Asked]) -> Vec<Answer> {
    asked.iter().map(answer_of).collect()
}

fn each(answer: Answer, count: usize) -> Vec<Answer> {
    vec![answer; count]
}

#[test]
fn names_each_refusal_of_its_own_as_spec_15_6_marks_it() {
    assert_eq!(
        WEBSOCKET_REFUSALS,
        WebSocketRefusals {
            busy: "busy",
            host: "host-refused",
            malformed: "malformed",
            method: "method-refused",
            origin: "origin-refused",
            upgrade: "upgrade-required",
            version: "version-refused",
        },
        "each mark"
    );
}

// an answer's fields, as a row writes them
fn fields_of(fields: &[(&'static str, &'static str)]) -> Vec<AnswerField> {
    fields
        .iter()
        .map(|(name, value)| AnswerField { name, value })
        .collect()
}

// a refusal's fields, marked, never stored nor sniffed, empty, its connection closed
fn marked(refusal: &'static str, fields: &[(&'static str, &'static str)]) -> Vec<AnswerField> {
    let upgrades = fields.iter().any(|(name, _)| *name == "upgrade");
    let mut written = vec![
        ("bead-refusal", refusal),
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
    ];

    written.extend_from_slice(fields);
    written.push(("content-length", "0"));
    written.push((
        "connection",
        if upgrades { "upgrade, close" } else { "close" },
    ));

    fields_of(&written)
}

#[test]
fn writes_each_answer_whole_marked_never_stored_nor_sniffed_empty_its_connection_closed_and_https_own_unmarked()
 {
    let whole = |asked: &Asked| {
        let hosts = ["bead.test".to_owned()];
        let origins = ["https://bead.example".to_owned()];

        judged(asked, |request| {
            refusal_of_handshake(request, &HandshakeTaken::new(&hosts, &origins))
                .map(|refusal| (refusal.fields, refusal.refusal, refusal.status))
        })
    };

    assert_eq!(
        [
            without(&[], &["host"]),
            without(&[("Host", "elsewhere.test")], &["host"]),
            request_of(
                &[],
                Shape {
                    method: Some("POST"),
                    ..Shape::default()
                }
            ),
            without(&[], &["upgrade"]),
            without(
                &[("Sec-WebSocket-Version", "8")],
                &["sec-websocket-version"]
            ),
            without(&[], &["sec-websocket-key"]),
            plain(&[("Origin", "https://elsewhere.test")]),
        ]
        .iter()
        .map(whole)
        .collect::<Vec<_>>(),
        [
            Some((
                fields_of(&[("content-length", "0"), ("connection", "close")]),
                None,
                400
            )),
            Some((marked("host-refused", &[]), Some("host-refused"), 403)),
            Some((
                marked("method-refused", &[("allow", "GET, HEAD")]),
                Some("method-refused"),
                405
            )),
            Some((
                marked("upgrade-required", &[("upgrade", "websocket")]),
                Some("upgrade-required"),
                426
            )),
            Some((
                marked(
                    "version-refused",
                    &[("upgrade", "websocket"), ("sec-websocket-version", "13")]
                ),
                Some("version-refused"),
                426
            )),
            Some((marked("malformed", &[]), Some("malformed"), 400)),
            Some((marked("origin-refused", &[]), Some("origin-refused"), 403)),
        ],
        "each answer whole"
    );
}

#[test]
fn takes_a_handshake_well_formed_its_fields_read_as_lists_in_any_ascii_case_without_the_whitespace_around_them()
 {
    assert_eq!(
        answers_of(&[
            plain(&[]),
            without(&[("Upgrade", "WebSocket")], &["upgrade"]),
            without(&[("Upgrade", "h2c, websocket")], &["upgrade"]),
            without(
                &[("Upgrade", "h2c"), ("Upgrade", "websocket")],
                &["upgrade"]
            ),
            without(&[("Connection", "keep-alive, UPGRADE")], &["connection"]),
            without(
                &[("Connection", "keep-alive"), ("Connection", "upgrade")],
                &["connection"]
            ),
            plain(&[("Content-Length", "0")]),
            plain(&[("Content-Length", "00")]),
            without(
                &[("Sec-WebSocket-Key", "AAAAAAAAAAAAAAAAAAAAAA==")],
                &["sec-websocket-key"]
            ),
            without(&[("Upgrade", "h2c ,\twebsocket")], &["upgrade"]),
            without(
                &[("Sec-WebSocket-Key", "abcdefghijklmnopqrstuw==")],
                &["sec-websocket-key"]
            ),
            without(&[("Connection", "keep-alive\t, upgrade")], &["connection"]),
            plain(&[("Sec-WebSocket-Protocol", "bead, chat")]),
            plain(&[
                ("Sec-WebSocket-Protocol", "bead"),
                ("Sec-WebSocket-Protocol", "chat")
            ]),
            plain(&[("Sec-WebSocket-Extensions", ";;;")]),
            plain(&[("Origin", "http://bead.test")]),
            plain(&[("Origin", "https://bead.example")]),
            without(&[("host", "BEAD.test")], &["host"]),
        ]),
        each(TAKEN, 18),
        "each taken"
    );
}

#[test]
fn refuses_what_http_refuses_of_its_own_first_a_host_missing_repeated_or_no_host_unmarked() {
    let shaped = |fields: &[(&str, &str)], shape: Shape<'_>| request_of(fields, shape);

    assert_eq!(
        answers_of(&[
            without(&[], &["host"]),
            plain(&[("Host", "bead.test")]),
            shaped(
                &[("Host", "bead.test")],
                Shape {
                    method: Some("POST"),
                    ..Shape::default()
                }
            ),
            shaped(
                &[("Host", "bad host")],
                Shape {
                    method: Some("POST"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            without(&[("Host", "bead.test:80x")], &["host"]),
            without(&[("Host", "[::1%25eth0]")], &["host"]),
            shaped(
                &[("Host", "bead.test")],
                Shape {
                    http_version: Some("1.0"),
                    ..Shape::default()
                }
            ),
        ]),
        each(HOST, 7),
        "each refused unmarked"
    );

    // an HTTP/1.0 request may name none, which names no host taken, and asks no WebSocket
    let unnamed = shaped(
        &[],
        Shape {
            http_version: Some("1.0"),
            without: &["host"],
            ..Shape::default()
        },
    );

    assert_eq!(answer_of(&unnamed), HOST_REFUSED, "no host taken");
    assert_eq!(
        answer_given(&["*"], &unnamed),
        UPGRADE,
        "every host under *"
    );
}

#[test]
fn refuses_first_unmarked_a_field_holding_a_control_character_but_a_tab_or_an_octet_past_ascii_or_whose_value_starts_or_ends_with_a_space_or_a_tab_whatever_else_the_request_holds()
 {
    let padded = format!("  {KEY}\t");

    // in Origin, in a field it never reads, in its Host; from a host it does not take, under
    // another method, with no upgrade
    assert_eq!(
        answers_of(&[
            plain(&[("Origin", "http://caf\u{e9}.example")]),
            plain(&[("X-Other", "caf\u{e9}")]),
            plain(&[("X-Other", "a\u{7}b")]),
            plain(&[("X-Other", "a\u{7f}b")]),
            without(
                &[
                    ("Host", "b\u{e9}ad.test"),
                    ("Origin", "https://elsewhere.test")
                ],
                &["host"]
            ),
            request_of(
                &[("X-Other", "caf\u{e9}")],
                Shape {
                    method: Some("POST"),
                    without: &["upgrade"],
                    ..Shape::default()
                }
            ),
            // padded, which HTTP/1.1's parser strips before any request reaches the transport
            without(&[("Sec-WebSocket-Key", &padded)], &["sec-websocket-key"]),
            without(
                &[("Sec-WebSocket-Version", " 13 ")],
                &["sec-websocket-version"]
            ),
        ]),
        each(HOST, 8),
        "each refused unmarked"
    );
    // a tab is taken, and the origin judged as any other
    assert_eq!(
        answer_of(&plain(&[("Origin", "http://a.example\tb")])),
        ORIGIN,
        "a tab taken"
    );
}

#[test]
fn refuses_first_unmarked_a_target_holding_an_octet_other_than_visible_ascii_or_a_path_whose_percent_decoding_holds_nul_whatever_else_the_request_holds_over_http_2_among_it_and_takes_one_percent_encoded()
 {
    let at = |target: &str| {
        request_of(
            &[],
            Shape {
                target: Some(target),
                ..Shape::default()
            },
        )
    };

    // in its path or its query, in absolute-form; from a host it does not take, under another
    // method, with no upgrade, over HTTP/2
    assert_eq!(
        answers_of(&[
            at("/?a\u{1}b"),
            at("/\u{7f}"),
            at("/a\tb"),
            at("/\u{e9}"),
            at("/%00"),
            at("http://bead.test/a\u{1}b"),
            request_of(
                &[("Host", "elsewhere.test")],
                Shape {
                    target: Some("/\u{1}"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            request_of(
                &[],
                Shape {
                    method: Some("POST"),
                    target: Some("/\u{1}"),
                    without: &["upgrade"],
                    ..Shape::default()
                }
            ),
            request_of(
                &[],
                Shape {
                    http_version: Some("2.0"),
                    target: Some("/\u{1}"),
                    ..Shape::default()
                }
            ),
        ]),
        each(HOST, 9),
        "each refused unmarked"
    );
    // what a target percent-encodes is no octet of it, NUL in a query among them
    assert_eq!(answer_of(&at("/?a%01%00")), TAKEN, "percent-encoded");
}

#[test]
fn refuses_a_host_it_does_not_take_before_anything_else_of_the_request_is_read() {
    let elsewhere = ("Host", "elsewhere.test");
    let shaped = |fields: &[(&str, &str)], shape: Shape<'_>| request_of(fields, shape);

    assert_eq!(
        answers_of(&[
            without(&[elsewhere], &["host"]),
            shaped(
                &[elsewhere],
                Shape {
                    method: Some("POST"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            shaped(
                &[elsewhere],
                Shape {
                    method: Some("CONNECT"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            shaped(
                &[elsewhere],
                Shape {
                    method: Some("HEAD"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            without(&[elsewhere], &["host", "upgrade", "connection"]),
            shaped(
                &[elsewhere],
                Shape {
                    http_version: Some("1.0"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            without(
                &[elsewhere, ("Sec-WebSocket-Version", "8")],
                &["host", "sec-websocket-version"]
            ),
            without(
                &[elsewhere, ("Sec-WebSocket-Key", "dGVzdA==")],
                &["host", "sec-websocket-key"]
            ),
            without(
                &[elsewhere, ("Origin", "https://elsewhere.test")],
                &["host"]
            ),
            without(&[("Host", "")], &["host"]),
            without(&[("Host", "bead.test.")], &["host"]),
        ]),
        each(HOST_REFUSED, 11),
        "each refused for its host"
    );
}

#[test]
fn refuses_a_method_but_get_or_head_405_before_its_upgrade_is_read() {
    let by = |method: &'static str, fields: &[(&str, &str)], left: &'static [&'static str]| {
        request_of(
            fields,
            Shape {
                method: Some(method),
                without: left,
                ..Shape::default()
            },
        )
    };

    assert_eq!(
        answers_of(&[
            by("POST", &[], &[]),
            by("PUT", &[], &[]),
            by("OPTIONS", &[], &[]),
            by("CONNECT", &[], &[]),
            by("DELETE", &[], &["upgrade", "connection"]),
            by(
                "POST",
                &[("Sec-WebSocket-Version", "8")],
                &["sec-websocket-version"]
            ),
            request_of(
                &[],
                Shape {
                    http_version: Some("1.0"),
                    method: Some("POST"),
                    ..Shape::default()
                }
            ),
            by("get", &[], &[]),
            by("TRACE", &[], &[]),
        ]),
        each(METHOD, 9),
        "each refused for its method"
    );
}

#[test]
fn answers_a_request_that_asks_no_web_socket_426_whatever_its_version_or_its_form() {
    let head = |fields: &[(&str, &str)], left: &'static [&'static str]| {
        request_of(
            fields,
            Shape {
                method: Some("HEAD"),
                without: left,
                ..Shape::default()
            },
        )
    };
    let old = |fields: &[(&str, &str)], left: &'static [&'static str]| {
        request_of(
            fields,
            Shape {
                http_version: Some("1.0"),
                without: left,
                ..Shape::default()
            },
        )
    };

    assert_eq!(
        answers_of(&[
            without(&[], &["upgrade", "connection"]),
            without(&[], &["upgrade"]),
            without(&[("Upgrade", "h2c")], &["upgrade"]),
            without(&[("Upgrade", "websocket/13")], &["upgrade"]),
            without(&[("Upgrade", "web socket")], &["upgrade"]),
            without(&[], &["connection"]),
            without(&[("Connection", "keep-alive")], &["connection"]),
            without(&[("Connection", "upgraded")], &["connection"]),
            without(
                &[("Upgrade", "h2c"), ("Sec-WebSocket-Version", "8")],
                &["upgrade", "sec-websocket-version"]
            ),
            head(&[], &[]),
            head(
                &[("Sec-WebSocket-Version", "8")],
                &["sec-websocket-version"]
            ),
            head(&[], &["upgrade", "connection"]),
            old(&[], &[]),
            old(&[("Upgrade", "websocket, h2c")], &["upgrade"]),
            old(&[], &["upgrade", "connection"]),
            without(
                &[("Sec-WebSocket-Key", "dGVzdA==")],
                &["upgrade", "sec-websocket-key"]
            ),
        ]),
        each(UPGRADE, 16),
        "each answered 426"
    );
}

#[test]
fn refuses_a_version_in_two_field_lines_as_malformed_and_answers_any_other_but_13_or_none_426_before_its_key_and_its_origin()
 {
    let versioned = |version: &'static str, fields: &[(&'static str, &'static str)]| {
        let mut given = vec![("Sec-WebSocket-Version", version)];

        given.extend_from_slice(fields);
        without(&given, &["sec-websocket-version", "sec-websocket-key"])
    };

    assert_eq!(
        answers_of(&[
            plain(&[("Sec-WebSocket-Version", "13")]),
            plain(&[("Sec-WebSocket-Version", "8")]),
        ]),
        [MALFORMED, MALFORMED],
        "two lines"
    );
    assert_eq!(
        answers_of(&[
            versioned("8", &[("Sec-WebSocket-Key", KEY)]),
            versioned("7", &[("Sec-WebSocket-Key", KEY)]),
            versioned("14", &[("Sec-WebSocket-Key", KEY)]),
            versioned("013", &[("Sec-WebSocket-Key", KEY)]),
            versioned("13, 8", &[("Sec-WebSocket-Key", KEY)]),
            versioned("8, 13", &[("Sec-WebSocket-Key", KEY)]),
            versioned("", &[]),
            versioned("8", &[("Sec-WebSocket-Key", "dGVzdA==")]),
            versioned(
                "8",
                &[
                    ("Sec-WebSocket-Key", KEY),
                    ("Origin", "https://elsewhere.test")
                ]
            ),
            versioned("8", &[("Sec-WebSocket-Key", KEY), ("Content-Length", "5")]),
            without(&[], &["sec-websocket-version"]),
        ]),
        each(VERSION, 11),
        "each answered 426, naming 13"
    );
}

#[test]
fn refuses_an_upgrade_of_version_13_malformed_400_by_its_key_its_subprotocols_or_its_content_before_its_origin()
 {
    let keyed = |keys: &[&'static str]| {
        let given: Vec<(&str, &str)> = keys.iter().map(|key| ("Sec-WebSocket-Key", *key)).collect();

        without(&given, &["sec-websocket-key"])
    };

    assert_eq!(
        answers_of(&[
            keyed(&[]),
            keyed(&["not a key at all!!!!!=="]),
            keyed(&["dGVzdA=="]),
            keyed(&["dGhlIHNhbXBsZSBub25jZQ"]),
            keyed(&["dGhlIHNhbXBsZSBub25jZSE="]),
            keyed(&["AAAAAAAAAAAAAAAAAAAAAAA="]),
            keyed(&[KEY, KEY]),
            keyed(&[""]),
            keyed(&["dGhlIHNhbXBs ZSBub25jZQ=="]),
            plain(&[("Sec-WebSocket-Protocol", "a b")]),
            plain(&[("Sec-WebSocket-Protocol", "bead, bead")]),
            plain(&[
                ("Sec-WebSocket-Protocol", "bead"),
                ("Sec-WebSocket-Protocol", "bead")
            ]),
            plain(&[("Sec-WebSocket-Protocol", "bead,,chat")]),
            plain(&[("Sec-WebSocket-Protocol", "bead,")]),
            plain(&[("Sec-WebSocket-Protocol", "")]),
            plain(&[("Sec-WebSocket-Protocol", "bead/1")]),
            plain(&[("Content-Length", "5")]),
            plain(&[("Content-Length", "abc")]),
            plain(&[("Content-Length", "0"), ("Content-Length", "5")]),
            plain(&[("Transfer-Encoding", "chunked")]),
            without(
                &[
                    ("Sec-WebSocket-Key", "dGVzdA=="),
                    ("Origin", "https://elsewhere.test")
                ],
                &["sec-websocket-key"]
            ),
        ]),
        each(MALFORMED, 21),
        "each refused malformed"
    );
}

#[test]
fn refuses_an_origin_neither_its_own_nor_among_those_it_takes_last_403() {
    assert_eq!(
        answers_of(&[
            plain(&[("Origin", "https://elsewhere.test")]),
            plain(&[("Origin", "http://bead.test:80")]),
            plain(&[("Origin", "null")]),
            plain(&[
                ("Origin", "http://bead.test"),
                ("Origin", "http://bead.test")
            ]),
        ]),
        [ORIGIN, ORIGIN, ORIGIN, ORIGIN],
        "each refused for its origin"
    );
}

// a request naming `host`, with `fields` besides
fn naming(host: &'static str, fields: &[(&'static str, &'static str)]) -> Asked {
    let mut given = vec![("Host", host)];

    given.extend_from_slice(fields);
    without(&given, &["host"])
}

// a request naming `host`, of `shape`
fn named_as(host: &'static str, shape: Shape<'_>) -> Asked {
    let mut left = vec!["host"];

    left.extend_from_slice(shape.without);
    request_of(
        &[("Host", host)],
        Shape {
            without: &left,
            ..shape
        },
    )
}

fn at(target: &'static str) -> Shape<'static> {
    Shape {
        target: Some(target),
        ..Shape::default()
    }
}

// spec 15.12
#[test]
fn takes_whatever_its_hosts_the_hosts_every_server_takes_and_any_page_of_its_own_by_a_host_it_takes_by_name_and_refuses_403_any_other_host_an_empty_one_and_none_before_its_method_and_its_upgrade()
 {
    let posted = Shape {
        method: Some("POST"),
        ..Shape::default()
    };
    let unhosted = Shape {
        http_version: Some("1.0"),
        without: &["host"],
        ..Shape::default()
    };

    for hosts in [&[][..], &["bead.test"][..]] {
        let given = |asked: &[Asked]| -> Vec<Answer> {
            asked
                .iter()
                .map(|asked| answer_given(hosts, asked))
                .collect()
        };
        let mut expected = each(TAKEN, 8);

        expected.extend(each(HOST_REFUSED, 7));
        expected.extend(each(HOST, 12));
        assert_eq!(
            given(&[
                naming("localhost", &[]),
                naming("a.localhost:8080", &[("Origin", "http://a.localhost:8080")]),
                naming("127.0.0.1:8080", &[("Origin", "https://127.0.0.1:8080")]),
                naming("[::1]", &[]),
                // a target in absolute-form names the authority, its Host ignored but for being
                // one
                request_of(
                    &[("Origin", "http://127.0.0.1:8080")],
                    at("http://127.0.0.1:8080/")
                ),
                named_as("bad host", at("http://localhost/")),
                // its scheme read in any case
                request_of(&[], at("HTTP://127.0.0.1/")),
                // and %23, a character of its query
                named_as("localhost", at("/?a%23b")),
                naming(
                    "rebind.example:8080",
                    &[("Origin", "http://rebind.example:8080")]
                ),
                named_as("rebind.example", posted),
                named_as(
                    "rebind.example",
                    Shape {
                        without: &["upgrade"],
                        ..Shape::default()
                    }
                ),
                naming("localhost.", &[]),
                naming("", &[]),
                request_of(&[], unhosted),
                named_as("127.0.0.1", at("http://rebind.example/")),
                // what HTTP refuses of its own, first
                naming("a*b.test", &[]),
                request_of(&[], at("http://a%41.test/")),
                request_of(&[], at("http:///")),
                request_of(&[], at("ftp://127.0.0.1/")),
                request_of(&[], at("http://localhost:/")),
                request_of(&[], at("http://user@localhost/")),
                // and a target holding what a page's browser always percent-encodes where it
                // stands, a # anywhere among it
                request_of(&[], at("/be<ad")),
                request_of(&[], at("/?a\"b")),
                request_of(&[], at("hTtPs://127.0.0.1/#{}")),
                request_of(&[], at("/#x")),
                request_of(&[], at("/#<\"")),
                named_as("elsewhere.test", at("/?a#b")),
            ]),
            expected,
            "{hosts:?}"
        );
        assert_eq!(
            given(&[
                naming("localhost:8080", &[]),
                naming("A.LocalHost", &[]),
                naming("localhost:8080", &[("Origin", "http://localhost:8080")]),
                naming("localhost:8080", &[("Origin", "https://bead.example")]),
                naming("elsewhere.test", &[("Origin", "http://elsewhere.test")]),
                named_as(
                    "elsewhere.test",
                    Shape {
                        method: Some("POST"),
                        without: &["upgrade", "connection"],
                        ..Shape::default()
                    }
                ),
                naming(":8080", &[]),
                request_of(
                    &[],
                    Shape {
                        http_version: Some("2.0"),
                        method: Some("POST"),
                        without: &["host"],
                        ..Shape::default()
                    }
                ),
                without(&[], &["host"]),
                naming("[::1", &[]),
            ]),
            [
                TAKEN,
                TAKEN,
                TAKEN,
                ORIGIN,
                HOST_REFUSED,
                HOST_REFUSED,
                HOST_REFUSED,
                HOST_REFUSED,
                HOST,
                HOST,
            ],
            "{hosts:?}"
        );
    }

    // no Host beside a target in absolute-form, as an HTTP/1.0 request may send it, its target
    // naming the host, and its version asking no WebSocket
    let old_at = |target: &'static str| {
        request_of(
            &[],
            Shape {
                http_version: Some("1.0"),
                target: Some(target),
                without: &["host"],
                ..Shape::default()
            },
        )
    };

    assert_eq!(
        [
            answer_given(&[], &old_at("http://127.0.0.1/")),
            answer_given(&[], &old_at("http://rebind.example/")),
        ],
        [UPGRADE, HOST_REFUSED],
        "its target naming the host"
    );

    // every host under *, an empty one and none, which asks no WebSocket; a page of its own by a
    // host every server takes, and none by a host * alone takes: the page that rebinds its name
    let every = |asked: &[Asked]| -> Vec<Answer> {
        asked
            .iter()
            .map(|asked| answer_given(&["*"], asked))
            .collect()
    };

    assert_eq!(
        every(&[
            naming("rebind.example:8080", &[]),
            naming("a.localhost:8080", &[("Origin", "http://a.localhost:8080")]),
            naming(
                "rebind.example:8080",
                &[("Origin", "http://rebind.example:8080")]
            ),
            naming("", &[]),
            request_of(&[], unhosted),
            named_as("[::1", posted),
        ]),
        [TAKEN, TAKEN, ORIGIN, TAKEN, UPGRADE, HOST],
        "under *"
    );
    assert_eq!(
        every(&[
            naming(
                "xn---bad-cpa.test",
                &[("Origin", "http://xn---bad-cpa.test")]
            ),
            naming(":8080", &[]),
            naming("elsewhere.test", &[("Origin", "https://bead.example")]),
            request_of(
                &[],
                Shape {
                    http_version: Some("2.0"),
                    method: Some("POST"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            without(&[], &["host"]),
        ]),
        [ORIGIN, TAKEN, ORIGIN, METHOD, HOST],
        "under *"
    );
}

#[test]
fn tells_a_requests_authority_its_port_included_and_its_origin_its_lines_joined_by_a_comma_and_a_space_as_the_judgement_reads_them_or_none()
 {
    let told = |authority: Option<&str>, origin: Option<&str>| HandshakeTold {
        authority: authority.map(str::to_owned),
        origin: origin.map(str::to_owned),
    };

    assert_eq!(
        [
            plain(&[("Origin", "http://rebind.example:8080"), ("Origin", "null")]),
            without(&[("Host", "rebind.example:8080")], &["host"]),
            request_of(&[], at("http://elsewhere.test:81/")),
            without(&[("Host", "")], &["host"]),
            request_of(
                &[],
                Shape {
                    http_version: Some("1.0"),
                    without: &["host"],
                    ..Shape::default()
                }
            ),
            without(&[], &["host"]),
        ]
        .iter()
        .map(|asked| judged(asked, told_of_handshake))
        .collect::<Vec<_>>(),
        [
            told(Some("bead.test"), Some("http://rebind.example:8080, null")),
            told(Some("rebind.example:8080"), None),
            told(Some("elsewhere.test:81"), None),
            told(Some(""), None),
            told(None, None),
            // what HTTP refuses of its own, which nothing tells
            told(None, None),
        ],
        "each told"
    );
}
