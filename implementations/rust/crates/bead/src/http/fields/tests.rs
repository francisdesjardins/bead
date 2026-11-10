//! The fields an HTTP transport server reads and writes, the twin of `http-server-fields.test.ts`
//! and `HttpTransportServerTests.ServerFields`.

use core::fmt::Write as _;
use core::time::Duration;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::SystemTime;

use crate::NEVER;
use crate::constants::EnvelopeKind;
use crate::http::fields::{HTTP_REFUSALS, LISTEN_HEADER, SEQUENCE_HEADER};
use crate::http::peer::*;
use crate::http::server::{HttpTransportServerOptions, judged};
use crate::testing::SteppingClock;
use crate::testing::wire::ResponseHead;

/// The fields every response on the path carries but HTTP's own 400, and the one CORS names.
const PATH_FIELDS: [&str; 4] = [
    "access-control-allow-origin",
    "cache-control",
    "vary",
    "x-content-type-options",
];

// a request's `Host` lines and its fields besides, and the status and mark it is answered
type Lines<'a> = (&'a [&'a str], String);
type Answered = (u16, Option<String>);
type Judged<'a> = (u16, Option<&'a str>);

// a connect written raw, naming `authority`, with the field lines `fields` before its own
fn raw_connect_of(authority: &str, fields: &str) -> Vec<u8> {
    format!(
        "POST /bead HTTP/1.1\r\nHost: {authority}\r\n{fields}Content-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
    )
    .into_bytes()
}

// `text`'s characters as octets, each its code point, as a case writes a head
fn latin1(text: &str) -> Vec<u8> {
    crate::testing::wire::latin1_of(text).expect("a head of Latin-1 alone")
}

// the fields of `PATH_FIELDS` an answer carries
fn path_fields_of(answer: &RawAnswer) -> Vec<&'static str> {
    PATH_FIELDS
        .into_iter()
        .filter(|field| answer.fields.contains_key(*field))
        .collect()
}

// the status and the mark of a request judged as one that came would be, built as `build` says
async fn judged_of(started: &Started, build: ::http::request::Builder) -> (u16, Option<String>) {
    let (parts, ()) = build.body(()).unwrap().into_parts();
    let peer = SocketAddr::from(([127, 0, 0, 1], 50_000));
    let response = judged(&started.server, (&parts, peer)).await.unwrap();

    (
        response.status().as_u16(),
        response
            .headers()
            .get(REFUSAL_HEADER)
            .map(|value| value.to_str().unwrap().to_owned()),
    )
}

#[tokio::test]
async fn answers_a_request_without_a_host_with_two_or_with_one_that_is_no_host_400_as_http_does_unmarked()
 {
    // its head is the HTTP server's own, whether the server takes every host or names some
    for hosts in [None, Some(vec!["bead.test".to_owned()])] {
        let started = started(&HttpTransportServerOptions {
            hosts,
            ..HttpTransportServerOptions::default()
        })
        .await;

        for host_lines in [
            vec![],
            vec!["bead.test", "elsewhere.test"],
            vec!["elsewhere.test", "bead.test"],
            vec!["bead.test", "bead.test"],
            vec!["bad host"],
        ] {
            let mut request = "POST /bead HTTP/1.1\r\n".to_owned();

            for line in &host_lines {
                write!(request, "Host: {line}\r\n").unwrap();
            }

            write!(
                request,
                "Content-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
            )
            .unwrap();

            let mut socket = RawSocket::on(started.port).await;

            socket.write(request.as_bytes()).await.unwrap();

            let response = socket.response(PATIENCE).await.expect("its answer");

            assert_eq!(
                (refusal_of(&response.head), response.body),
                ((400, None), Vec::new()),
                "{host_lines:?}"
            );
            assert!(socket.ended(PATIENCE).await, "its socket closed");
        }

        let told = started.recorder.told();

        assert!(
            told.connections.is_empty() && told.refusals.is_empty(),
            "nothing drawn, nothing told"
        );
        started.stop().await;
    }
}

// * a value no socket carries past hyper's parser, a space at its edge, is judged as the
// application's code would hand it, as the C# side's middleware does
#[tokio::test]
async fn checks_every_request_field_for_visible_bytes_and_edge_whitespace_before_admission() {
    let started = started(&HttpTransportServerOptions {
        hosts: Some(vec!["bead.test".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let mut cases: Vec<(&str, &[u8], u16, Option<&str>)> = vec![
        (
            "origin",
            b"http://a.example\tb",
            403,
            Some(HTTP_REFUSALS.origin),
        ),
        ("x-other", b"x \ty", 201, None),
        ("x-other", b"", 201, None),
    ];

    for name in ["host", "origin", "x-other", "bead-after"] {
        for value in ["café".as_bytes(), b"x "] {
            cases.push((name, value, 400, None));
        }
    }

    for (name, value, status, reason) in cases {
        let before = started.recorder.told().connections.len();
        let mut request = ::http::Request::post("/bead")
            .header("content-type", BEAD_MEDIA_TYPE)
            .header("content-length", "0");

        if name != "host" {
            request = request.header("host", "bead.test");
        }

        let request = request.header(name, ::http::HeaderValue::from_bytes(value).unwrap());

        assert_eq!(
            judged_of(&started, request).await,
            (status, reason.map(str::to_owned)),
            "{name}: {value:?}"
        );
        assert_eq!(
            started.recorder.told().connections.len(),
            before + usize::from(status == 201),
            "drawn as it is taken, {name}: {value:?}"
        );
    }

    // a control character no socket carries past hyper's parser, which answers it itself
    for name in ["host", "origin", "x-other", "bead-after"] {
        let answer = raw_answer_of(
            started.port,
            &raw_connect_of("bead.test", &format!("{name}: a\u{7}b\r\n")),
        )
        .await;

        assert_eq!((answer.status, answer.refusal), (400, None), "{name}: BEL");
    }

    assert_eq!(started.server.clients().len(), 2, "two drawn");
    assert_eq!(
        started
            .recorder
            .told()
            .refusals
            .iter()
            .map(|refusal| refusal.reason.clone())
            .collect::<Vec<_>>(),
        vec![HTTP_REFUSALS.origin.to_owned()],
        "the origin's refusal alone told"
    );
    started.stop().await;
}

// * HTTP/2's cases are 22's, with its TLS
#[expect(
    clippy::too_many_lines,
    reason = "each of its targets written whole, as the other sides' twins write them"
)]
#[tokio::test]
async fn reads_any_target_without_throwing_a_header_given_twice_by_its_first_and_http_2_s_authority_as_the_host()
 {
    let started = started(&HttpTransportServerOptions {
        hosts: Some(vec!["bead.example".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    // a connect on `target`, its `Host` lines `hosts`, its fields besides `fields`
    let answer_of = async |target: &str, (hosts, fields): (&[&str], &str)| {
        let mut request = format!("POST {target} HTTP/1.1\r\n");

        for host in hosts {
            write!(request, "Host: {host}\r\n").unwrap();
        }

        request.push_str(fields);
        request.push_str("Content-Length: 0\r\n\r\n");

        let answer = raw_answer_of(port, request.as_bytes()).await;

        (answer.status, answer.refusal)
    };
    let bead = &format!("Content-Type: {BEAD_MEDIA_TYPE}\r\n");
    let refused = |status: u16, reason: &str| (status, Some(reason.to_owned()));
    let cases: Vec<(&str, Lines<'_>, Answered)> = vec![
        (
            "/bead",
            (
                &["bead.example"],
                format!("Content-Type: {BEAD_MEDIA_TYPE}\r\nContent-Type: text/plain\r\n"),
            ),
            (201, None),
        ),
        (
            "//:99999/bead",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        (
            "/bead?after=1",
            (&["bead.example"], bead.clone()),
            (201, None),
        ),
        (
            "/bead",
            (
                &["bead.example"],
                format!("{bead}Origin: not an origin\r\n"),
            ),
            refused(403, HTTP_REFUSALS.origin),
        ),
        (
            "/bead",
            (&["rebound.example"], bead.clone()),
            refused(403, HTTP_REFUSALS.host),
        ),
        // an HTTP/1.1 request with no host, which HTTP refuses of its own, unmarked
        ("/bead", (&[], bead.clone()), (400, None)),
        (
            "/bead",
            (&["bead.example"], String::new()),
            refused(415, HTTP_REFUSALS.type_refused),
        ),
        // a target in absolute-form names the authority, its Host ignored but for being one, its
        // path read after it, and its query by no exchange
        (
            "http://bead.example:8443/bead",
            (&["bead.example"], bead.clone()),
            (201, None),
        ),
        (
            "https://bead.example/bead",
            (&["rebound.example"], bead.clone()),
            (201, None),
        ),
        (
            "http://localhost/bead?after=1",
            (&["bad host"], bead.clone()),
            (201, None),
        ),
        // its scheme read in any case; and a target that holds a #, which spec 15.12 refuses, served
        // cut at it, as hyper hands it on: the row "A # in a target" of docs/support.md
        (
            "HTTP://bead.example/bead",
            (&["bead.example"], bead.clone()),
            (201, None),
        ),
        (
            "hTtPs://bead.example/bead#after",
            (&["bead.example"], bead.clone()),
            (201, None),
        ),
        (
            "/bead#/elsewhere",
            (&["bead.example"], bead.clone()),
            (201, None),
        ),
        (
            "http://rebound.example/bead",
            (&["bead.example"], bead.clone()),
            refused(403, HTTP_REFUSALS.host),
        ),
        (
            "http://bead.example",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        (
            "http://bead.example?after=1",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        // and HTTP refuses one that names no host, a colon with no port and a userinfo among
        // them, another scheme's, or one beside two Host lines
        (
            "http:///bead",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "http://a%41.test/bead",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "http://127.0.0.1:/bead",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "http://user@bead.example/bead",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "ftp://bead.example/bead",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "http://bead.example/bead",
            (&["bead.example", "bead.example"], bead.clone()),
            (400, None),
        ),
        (
            "/bead",
            (&[""], bead.clone()),
            refused(403, HTTP_REFUSALS.host),
        ),
        (
            "/",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        (
            "http://bead.example/bead",
            (&["rebound.example"], bead.clone()),
            (201, None),
        ),
        // its path matched as it came, an octet percent-encoded not the letter it encodes
        (
            "/b%65ad",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        // a target with no authority, or holding what a page's browser always percent-encodes
        ("http:///", (&["bead.example"], bead.clone()), (400, None)),
        ("/be\"ad", (&["bead.example"], bead.clone()), (400, None)),
        (
            "hTtP://127.0.0.1/be{}ad",
            (&["bead.example"], bead.clone()),
            (400, None),
        ),
        // its scheme in any case, and a target cut at its # by hyper, what followed it gone
        (
            "HTTP://127.0.0.1/elsewhere",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
        (
            "/elsewhere#/bead",
            (&["bead.example"], bead.clone()),
            refused(404, HTTP_REFUSALS.path),
        ),
    ];

    for (target, (hosts, fields), expected) in cases {
        assert_eq!(
            answer_of(target, (hosts, &fields)).await,
            expected,
            "{target} with {hosts:?}"
        );
    }

    // no host at all, which an HTTP/1.0 request may name, where hosts are listed; and none beside
    // a target in absolute-form, which names it
    for (target, expected) in [
        ("/bead", refused(403, HTTP_REFUSALS.host)),
        ("http://bead.example/bead", (201, None)),
    ] {
        let answer = raw_answer_of(
            port,
            format!("POST {target} HTTP/1.0\r\n{bead}Content-Length: 0\r\n\r\n").as_bytes(),
        )
        .await;

        assert_eq!(
            (answer.status, answer.refusal),
            expected,
            "HTTP/1.0 to {target}"
        );
    }

    started.stop().await;
}

#[tokio::test]
async fn tells_a_header_given_empty_from_one_absent_an_empty_token_is_malformed_an_empty_origin_or_encoding_refused_an_empty_listen_none()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;
    let status_of = async |fields: Vec<String>| {
        refusal_of(
            &posted(
                started.port,
                &Post {
                    fields,
                    ..Post::default()
                },
            )
            .await
            .head,
        )
    };

    assert_eq!(
        vec![
            status_of(vec![format!("{CONNECTION_TOKEN_HEADER}:")]).await,
            status_of(vec!["Origin:".to_owned()]).await,
            status_of(vec![
                format!("{CONNECTION_TOKEN_HEADER}: {token}"),
                "Content-Encoding:".to_owned()
            ])
            .await,
            status_of(vec!["bead-listen:".to_owned()]).await,
        ],
        vec![
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
            (403, Some(HTTP_REFUSALS.origin.to_owned())),
            (415, Some(HTTP_REFUSALS.type_refused.to_owned())),
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
        ],
        "each given empty"
    );
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each preflight and every field its answer carries, as the other sides' twins hold them"
)]
#[tokio::test]
async fn answers_a_preflight_from_an_origin_it_names_204_naming_it_the_methods_authorization_the_fields_it_asks_for_in_its_lines_joined_and_any_other_field_for_7200_seconds_and_tells_no_refusal()
 {
    let started = started(&HttpTransportServerOptions {
        origins: Some(vec![PAGE.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    // what a page asks before a connect, before a listen at the connection's one URL, and of a
    // method the server does not take, which its browser refuses against the answer; in two field
    // lines, joined as one value (RFC 9110 §5.3); and nothing asked when the field is empty
    let asked: [(&str, &str, Option<&str>); 6] = [
        (
            "POST",
            "Access-Control-Request-Headers: bead-listen,content-type,traceparent\r\n",
            Some("bead-listen,content-type,traceparent"),
        ),
        (
            "POST",
            "Access-Control-Request-Headers: bead-listen,content-type,traceparent,sentry-trace,baggage\r\n",
            Some("bead-listen,content-type,traceparent,sentry-trace,baggage"),
        ),
        (
            "GET",
            "Access-Control-Request-Headers: bead-after,bead-connection-token,bead-wait\r\n",
            Some("bead-after,bead-connection-token,bead-wait"),
        ),
        ("PUT", "", None),
        (
            "GET",
            "Access-Control-Request-Headers: bead-after\r\nAccess-Control-Request-Headers: bead-wait\r\n",
            Some("bead-after, bead-wait"),
        ),
        ("GET", "Access-Control-Request-Headers:\r\n", None),
    ];

    for (method, lines, allowed) in asked {
        let answer = raw_answer_of(
            port,
            format!(
                "OPTIONS /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\nOrigin: {PAGE}\r\nAccess-Control-Request-Method: {method}\r\n{lines}\r\n"
            )
            .as_bytes(),
        )
        .await;
        let field = |name: &str| answer.fields.get(name).cloned();
        let allowed = core::iter::once("authorization")
            .chain(allowed)
            .chain(["*"])
            .collect::<Vec<_>>()
            .join(", ");

        assert_eq!(
            (
                answer.status,
                field("access-control-allow-credentials"),
                field("access-control-allow-headers"),
                field("access-control-allow-methods"),
                field("access-control-allow-origin"),
                field("access-control-expose-headers"),
                field("access-control-max-age"),
                field(REFUSAL_HEADER),
                field("cache-control"),
                field("vary"),
                field("x-content-type-options"),
            ),
            (
                204,
                None,
                Some(allowed),
                Some("GET, POST, DELETE".to_owned()),
                Some(PAGE.to_owned()),
                Some("*".to_owned()),
                Some("7200".to_owned()),
                None,
                Some("no-store".to_owned()),
                Some("Origin".to_owned()),
                Some("nosniff".to_owned()),
            ),
            "a preflight of {method}, asking {lines:?}"
        );
    }

    // no refusal, and no connection drawn
    let told = started.recorder.told();

    assert!(
        told.refusals.is_empty() && told.connections.is_empty(),
        "nothing told"
    );

    // an OPTIONS that asks no method is no preflight: a method it does not take
    let bare = raw_answer_of(
        port,
        format!("OPTIONS /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\nOrigin: {PAGE}\r\n\r\n")
            .as_bytes(),
    )
    .await;

    assert_eq!(
        (bare.status, bare.refusal),
        (405, Some(HTTP_REFUSALS.method.to_owned())),
        "a bare OPTIONS"
    );
    assert_eq!(
        started
            .recorder
            .refusals(1)
            .await
            .iter()
            .map(|refusal| refusal.reason.clone())
            .collect::<Vec<_>>(),
        vec![HTTP_REFUSALS.method.to_owned()],
        "its refusal told"
    );
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each request written whole, and the fields of each answer, as the other sides' twins hold them"
)]
#[tokio::test]
async fn names_no_origin_to_its_own_to_a_request_with_none_to_one_it_does_not_take_nor_before_the_origin_is_judged_and_varies_every_answer_by_origin_but_http_s_own_400()
 {
    let started = started(&HttpTransportServerOptions {
        origins: Some(vec![PAGE.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let authority = format!("{HOST}:{port}");
    let preflight = |host: &str, (path, origin): (&str, Option<&str>)| {
        let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));

        format!(
            "OPTIONS {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Access-Control-Request-Method: POST\r\n\r\n"
        )
        .into_bytes()
    };
    let own = format!("http://{authority}");
    let cases: Vec<(Vec<u8>, Judged<'_>)> = vec![
        // its own origin, and none
        (
            raw_connect_of(&authority, &format!("Origin: {own}\r\n")),
            (201, None),
        ),
        (raw_connect_of(&authority, ""), (201, None)),
        // a preflight from its own origin, and from none: no CORS request, so a method it does not
        // take
        (
            preflight(&authority, ("/bead", Some(&own))),
            (405, Some(HTTP_REFUSALS.method)),
        ),
        (
            preflight(&authority, ("/bead", None)),
            (405, Some(HTTP_REFUSALS.method)),
        ),
        // an origin it does not take
        (
            raw_connect_of(&authority, "Origin: https://elsewhere.test\r\n"),
            (403, Some(HTTP_REFUSALS.origin)),
        ),
        (
            preflight(&authority, ("/bead", Some("https://elsewhere.test"))),
            (403, Some(HTTP_REFUSALS.origin)),
        ),
        // a page it names, before its origin is judged: by a host it does not take, at another
        // path
        (
            preflight("rebind.example", ("/bead", Some(PAGE))),
            (403, Some(HTTP_REFUSALS.host)),
        ),
        (
            preflight(&authority, ("/elsewhere", Some(PAGE))),
            (404, Some(HTTP_REFUSALS.path)),
        ),
        (
            raw_connect_of(&authority, &format!("{CONNECTION_TOKEN_HEADER}: short\r\n")),
            (400, Some(HTTP_REFUSALS.malformed)),
        ),
    ];

    for (request, (status, reason)) in cases {
        let answer = raw_answer_of(port, &request).await;

        assert_eq!(
            (
                answer.status,
                answer.refusal.clone(),
                path_fields_of(&answer),
                answer.fields.get("vary").cloned(),
                answer.fields.get("access-control-expose-headers").cloned(),
            ),
            (
                status,
                reason.map(str::to_owned),
                vec!["cache-control", "vary", "x-content-type-options"],
                Some("Origin".to_owned()),
                None,
            ),
            "{}",
            String::from_utf8_lossy(&request)
        );
    }

    assert_eq!(
        started
            .recorder
            .refusals(7)
            .await
            .iter()
            .map(|refusal| refusal.reason.clone())
            .collect::<Vec<_>>(),
        [
            HTTP_REFUSALS.method,
            HTTP_REFUSALS.method,
            HTTP_REFUSALS.origin,
            HTTP_REFUSALS.origin,
            HTTP_REFUSALS.host,
            HTTP_REFUSALS.path,
            HTTP_REFUSALS.malformed,
        ]
        .map(str::to_owned),
        "each refusal told"
    );

    // HTTP's own 400, from a page it names: two hosts, a field of an octet past ASCII, and a
    // target that names no host
    for fields in [
        format!("Host: {authority}\r\n"),
        "X-Other: café\r\n".to_owned(),
        "X-Other: a\u{7}b\r\n".to_owned(),
    ] {
        let answer = raw_answer_of(
            port,
            &latin1(
                &String::from_utf8(raw_connect_of(
                    &authority,
                    &format!("Origin: {PAGE}\r\n{fields}"),
                ))
                .unwrap(),
            ),
        )
        .await;

        assert_eq!(
            (
                answer.status,
                answer.refusal.clone(),
                path_fields_of(&answer)
            ),
            (400, None, vec![]),
            "{fields:?}"
        );
    }

    let malformed = raw_answer_of(
        port,
        format!(
            "POST http://localhost:/bead HTTP/1.1\r\nHost: {authority}\r\nOrigin: {PAGE}\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;

    assert_eq!(
        (
            malformed.status,
            malformed.refusal.clone(),
            path_fields_of(&malformed)
        ),
        (400, None, vec![]),
        "a target that names no host"
    );
    assert_eq!(
        started.recorder.told().refusals.len(),
        7,
        "nothing more told"
    );
    started.stop().await;
}

#[tokio::test]
async fn answers_400_unmarked_with_none_of_the_path_s_fields_a_field_holding_a_control_character_other_than_htab_or_an_octet_past_ascii_and_tells_nothing()
 {
    for origins in [None, Some(vec!["http://a.example".to_owned()])] {
        let started = started(&HttpTransportServerOptions {
            origins,
            ..HttpTransportServerOptions::default()
        })
        .await;
        let port = started.port;
        let authority = format!("{HOST}:{port}");
        // in Origin and in a field the transport never reads: an escape sequence, BEL, DEL, and
        // an octet past ASCII, written as the one octet 0xE9, and as UTF-8's two
        let fields: [Vec<u8>; 6] = [
            b"Origin: http://a.example\x1B[2J\r\n".to_vec(),
            b"X-Other: a\x07b\r\n".to_vec(),
            b"Origin: http://a.example\x7F\r\n".to_vec(),
            latin1("Origin: http://café.example\r\n"),
            latin1("X-Other: café\r\n"),
            "X-Other: café\r\n".as_bytes().to_vec(),
        ];

        // each from a page the server names besides, which none of them names
        for field in &fields {
            for origin in ["", "Origin: http://a.example\r\n"] {
                let mut request =
                    format!("POST /bead HTTP/1.1\r\nHost: {authority}\r\n{origin}").into_bytes();

                request.extend_from_slice(field);
                request.extend_from_slice(
                    format!("Content-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n")
                        .as_bytes(),
                );

                let answer = raw_answer_of(port, &request).await;

                assert_eq!(
                    (
                        answer.status,
                        answer.refusal.clone(),
                        path_fields_of(&answer)
                    ),
                    (400, None, vec![]),
                    "{:?}",
                    String::from_utf8_lossy(field)
                );
            }
        }

        let told = started.recorder.told();

        assert!(
            told.refusals.is_empty() && told.connections.is_empty(),
            "nothing told"
        );

        // a tab is taken, and the origin judged as any other
        let tabbed = raw_answer_of(
            port,
            &raw_connect_of(&authority, "Origin: http://a.example\tb\r\n"),
        )
        .await;

        assert_eq!(
            (
                tabbed.status,
                tabbed.refusal.clone(),
                path_fields_of(&tabbed)
            ),
            (
                403,
                Some(HTTP_REFUSALS.origin.to_owned()),
                vec!["cache-control", "vary", "x-content-type-options"]
            ),
            "a tab"
        );

        let refusals = started.recorder.refusals(1).await;

        assert_eq!(
            refusals
                .iter()
                .map(|refusal| (
                    refusal.address.clone(),
                    refusal.authority.clone(),
                    refusal.origin.clone(),
                    refusal.port,
                    refusal.reason.clone(),
                    refusal.status
                ))
                .collect::<Vec<_>>(),
            vec![(
                Some(HOST.to_owned()),
                Some(authority.clone()),
                Some("http://a.example\tb".to_owned()),
                Some(tabbed.local_port),
                HTTP_REFUSALS.origin.to_owned(),
                403
            )],
            "the tab's refusal told"
        );
        started.stop().await;
    }
}

// a request of `fields`, each a line, as hyper hands one on
fn request_of(fields: &[(&str, &str)]) -> ::http::request::Parts {
    let mut request = ::http::Request::post("/bead");

    for (name, value) in fields {
        request = request.header(*name, *value);
    }

    request.body(()).unwrap().into_parts().0
}

// the fields `parts` carries, as the transport reads them
const fn read_of(parts: &::http::request::Parts) -> super::Request<'_> {
    super::Request {
        is_http1: true,
        is_http11: true,
        method: &parts.method,
        uri: &parts.uri,
        headers: &parts.headers,
    }
}

#[test]
fn reads_a_field_by_its_first_line_or_all_of_them_a_count_and_a_listen_as_rfc_9651_items_and_a_body_as_its_length_or_its_coding_says()
 {
    let counted = |values: &[&str]| {
        let lines: Vec<(&str, &str)> = values.iter().map(|value| ("bead-after", *value)).collect();

        read_of(&request_of(&lines)).count_of(("bead-after", false))
    };
    let listening = |values: &[&str]| {
        let lines: Vec<(&str, &str)> = values.iter().map(|value| (LISTEN_HEADER, *value)).collect();

        read_of(&request_of(&lines)).listening()
    };
    let twice = request_of(&[("Authorization", BEARER), ("authorization", "Basic")]);

    assert_eq!(
        read_of(&twice).header_of("authorization"),
        Some(BEARER),
        "its first"
    );
    assert_eq!(
        read_of(&twice).lines_of("authorization"),
        vec![BEARER, "Basic"],
        "all of them"
    );
    assert_eq!(
        [
            counted(&["3"]),
            counted(&["0;p=1"]),
            counted(&[]),
            counted(&["-1"]),
            counted(&["1", "2"])
        ],
        [Some(3), Some(0), Some(0), None, None],
        "counts"
    );
    assert_eq!(
        read_of(&request_of(&[])).count_of(("bead-after", true)),
        None,
        "one required"
    );
    assert_eq!(
        [
            listening(&["?1"]),
            listening(&["?0"]),
            listening(&[]),
            listening(&["1"])
        ],
        [Some(true), Some(false), Some(false), None],
        "listens"
    );
    assert_eq!(
        [
            vec![("Content-Length", "0")],
            vec![("Content-Length", "8")],
            vec![("Transfer-Encoding", "chunked")],
            vec![],
        ]
        .map(|fields| read_of(&request_of(&fields)).has_body()),
        [false, true, true, false],
        "bodies"
    );
}

// spec 15.6, 15.9
#[tokio::test]
async fn reads_a_listen_s_counts_from_bead_after_and_bead_wait_a_field_given_as_several_lines_joined_and_refuses_400_a_listen_without_bead_after_whatever_its_target_holds()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = started(&HttpTransportServerOptions {
        clock: Some(Arc::<SteppingClock>::clone(&clock)),
        inactivity_timeout: Some(NEVER),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let notification = envelope_of(EnvelopeKind::Notification.byte(), (1, 0));
    let token_field = format!("{CONNECTION_TOKEN_HEADER}: {token}");
    // a listen at `target`, its fields besides its token
    let at = async |target: &str, fields: &[&str]| {
        let mut lines = vec![token_field.as_str()];

        lines.extend_from_slice(fields);
        exchange_of(port, head_of(("GET", target), (port, &lines)).as_bytes()).await
    };

    started.send(&notification, &handle).await.unwrap();

    // Items of RFC 9651 whose bare item is an Integer of 0 or more, each field's lines joined
    // before they are read: two lines are a list, which no Item is
    let mut refused = Vec::new();

    for fields in [
        &["bead-after: 0", "bead-after: 0", "bead-wait: 0"][..],
        &["bead-after: 0", "bead-wait: 0", "bead-wait: 1"],
        &["bead-after: 0, 0"],
        &["bead-after:"],
        &["bead-after: 1.0"],
        &["bead-after: \"1\""],
        &["bead-after: -1"],
        &["bead-after: 0", "bead-wait: ?1"],
        &["bead-after: 0;X=1"],
        // without bead-after, its counts in the query or not
        &["bead-wait: 0"],
    ] {
        refused.push(refusal_of(
            &at("/bead", fields).await.head(PATIENCE).await.unwrap(),
        ));
    }

    refused.push(refusal_of(
        &at("/bead?after=0&wait=0", &[])
            .await
            .head(PATIENCE)
            .await
            .unwrap(),
    ));

    assert_eq!(
        refused,
        vec![(400, Some(HTTP_REFUSALS.malformed.to_owned())); 11],
        "each refused"
    );

    // with it, whatever its query: its parameters ignored, -0 read as 0
    let batch = batch_of(&[&notification]);

    for (target, fields) in [
        (
            "/bead?after=5&x=1",
            &["bead-after: -0;x=1", "bead-wait: 0;y=\"a;b\""][..],
        ),
        ("/bead?after=5&x=1", &["bead-after: 0", "bead-wait: 0"]),
        ("/bead?", &["bead-after: 0", "bead-wait: 0"]),
        ("/bead", &["bead-after: 0"]),
    ] {
        let response = at(target, fields).await.response(PATIENCE).await.unwrap();

        assert_eq!(
            (
                response.head.status,
                response.head.fields.get(SEQUENCE_HEADER).cloned(),
                response.body
            ),
            (200, Some("1".to_owned()), batch.clone()),
            "{target} with {fields:?}"
        );
    }

    assert_eq!(
        refusal_of(
            &at("/bead", &["bead-after: 1;x=1", "bead-wait: 0;y=\"a;b\""])
                .await
                .head(PATIENCE)
                .await
                .unwrap()
        ),
        (204, None),
        "acknowledged"
    );

    // a bead-wait left out is 0, answered at once; one given, held as long
    assert_eq!(
        refusal_of(
            &at("/bead?", &["bead-after: 1"])
                .await
                .head(PATIENCE)
                .await
                .unwrap()
        ),
        (204, None),
        "at once"
    );
    assert!(clock.dues().is_empty(), "no timer armed");

    let waiting = at("/bead", &["bead-after: 1", "bead-wait: 500"]).await;

    until(|| clock.dues() == [Duration::from_millis(500)]).await;
    clock.advance(Duration::from_millis(500)).await;

    assert_eq!(
        refusal_of(&waiting.head(PATIENCE).await.unwrap()),
        (204, None),
        "held as long"
    );
    assert!(started.recorder.told().closes.is_empty(), "nothing closed");
    started.stop().await;
}

// spec 15.4, 15.9, 15.12
#[expect(
    clippy::too_many_lines,
    reason = "every answer it writes to a page, each read, as the other sides' twins read them"
)]
#[tokio::test]
async fn names_an_origin_it_names_on_every_answer_it_writes_to_it_once_that_origin_is_judged_a_batch_and_a_refusal_among_them_and_exposes_every_field()
 {
    let started = started(&HttpTransportServerOptions {
        origins: Some(vec![PAGE.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let origin = format!("Origin: {PAGE}");
    let named = |head: &ResponseHead| {
        let field = |name: &str| head.fields.get(name).cloned();

        (
            field("access-control-allow-origin"),
            field("access-control-expose-headers"),
            field("access-control-allow-credentials"),
            field("access-control-allow-methods"),
            field("cache-control"),
            field("vary"),
        )
    };
    let expected = (
        Some(PAGE.to_owned()),
        Some("*".to_owned()),
        None,
        None,
        Some("no-store".to_owned()),
        Some("Origin".to_owned()),
    );
    let mut answers = Vec::new();

    // a connect that listens, its token read
    let drawn = posted(
        port,
        &Post {
            fields: vec![origin.clone(), format!("{LISTEN_HEADER}: ?1")],
            ..Post::default()
        },
    )
    .await;
    let token = drawn.head.fields[CONNECTION_TOKEN_HEADER].clone();
    let handle = Arc::clone(&started.server.clients()[0].connection_handle);

    answers.push((drawn.head.status, named(&drawn.head)));

    // a request with its Authorization, its head going as it is handed on, then answered
    let request = posting(
        port,
        &Post {
            token: Some(&token),
            fields: vec![origin.clone(), format!("Authorization: {BEARER}")],
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;
    let head = request.head(PATIENCE).await.unwrap();

    answers.push((head.status, named(&head)));
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();

    assert_eq!(
        request.response(PATIENCE).await.unwrap().body,
        envelope_of(RESULT, (1, 0)),
        "its answer"
    );

    // a result handed on, 204
    let other = posted(
        port,
        &Post {
            token: Some(&token),
            fields: vec![origin.clone()],
            body: envelope_of(RESULT, (5, 0)),
            ..Post::default()
        },
    )
    .await;

    answers.push((other.head.status, named(&other.head)));

    // a batch, and an empty listen
    started
        .send(
            &envelope_of(EnvelopeKind::Notification.byte(), (1, 0)),
            &handle,
        )
        .await
        .unwrap();

    let token_field = format!("{CONNECTION_TOKEN_HEADER}: {token}");

    for after in ["bead-after: 0", "bead-after: 1"] {
        let listen = exchange_of(
            port,
            head_of(
                ("GET", "/bead"),
                (port, &[&origin, &token_field, after, "bead-wait: 0"]),
            )
            .as_bytes(),
        )
        .await
        .response(PATIENCE)
        .await
        .unwrap();

        answers.push((listen.head.status, named(&listen.head)));
    }

    // refusals once the origin is judged: an OPTIONS that is no preflight, a body of another type,
    // a method it does not take, a token that is none
    let typed = format!("Content-Type: {BEAD_MEDIA_TYPE}");
    let unknown = format!("{CONNECTION_TOKEN_HEADER}: not-a-token");

    for request in [
        head_of(("OPTIONS", "/bead"), (port, &[&origin])),
        head_of(
            ("POST", "/bead"),
            (
                port,
                &[
                    &origin,
                    &token_field,
                    "Content-Type: text/plain",
                    "Content-Length: 0",
                ],
            ),
        ),
        head_of(("PUT", "/bead"), (port, &[&origin, "Content-Length: 0"])),
        head_of(
            ("POST", "/bead"),
            (port, &[&origin, &typed, &unknown, "Content-Length: 0"]),
        ),
    ] {
        let answer = exchange_of(port, request.as_bytes())
            .await
            .response(PATIENCE)
            .await
            .unwrap();

        answers.push((answer.head.status, named(&answer.head)));
    }

    assert_eq!(
        answers,
        [201, 200, 204, 200, 204, 405, 415, 405, 400]
            .map(|status| (status, expected.clone()))
            .to_vec(),
        "each named"
    );
    started.stop().await;
}
