//! The HTTP transport server under TLS, HTTP/2 and HTTP/1.1 on one port: the twins of
//! `http-transport-server.test.ts` (`createHTTPTransportServer, over HTTP/2`, `over TLS`) and of
//! `HttpTransportServerTests`' over HTTP/2.

use core::fmt::Write as _;
use std::collections::BTreeMap;

use super::tls_wire::*;
use super::*;
use crate::testing::Instant;

// the options of a server under the fixture's TLS
fn under_tls(options: &HttpTransportServerOptions) -> HttpTransportServerOptions {
    HttpTransportServerOptions {
        tls: Some(crate::testing::tls::server_config().unwrap()),
        ..options.clone()
    }
}

// a server under TLS, started on the loopback
async fn started_secure(options: &HttpTransportServerOptions) -> Started {
    started(&under_tls(options)).await
}

// a `POST` of Bead's media type over HTTP/1.1, its head as `fields` say
fn post_head_over_tls(port: u16, (fields, body): (&[(&str, &str)], &[u8])) -> Vec<u8> {
    let mut head = format!(
        "POST /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: {}\r\n",
        body.len()
    );

    for (name, value) in fields {
        write!(head, "{name}: {value}\r\n").unwrap();
    }

    head.push_str("\r\n");

    let mut request = head.into_bytes();

    request.extend_from_slice(body);
    request
}

#[tokio::test]
async fn draws_a_connection_pairs_an_answer_takes_a_same_origin_browser_s_exchange_by_its_authority_and_closes_on_a_stream_reset()
 {
    // HTTP/2 over TLS alone, as on the C# side: in clear it serves HTTP/1.1 alone
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let session = session_of(port).await;
    let own = format!("https://{HOST}:{port}");
    let (status, fields, _) = exchanged(
        &session,
        (
            request_of(
                ("POST", port),
                &[("content-type", BEAD_MEDIA_TYPE), ("origin", own.as_str())],
            ),
            None,
        ),
    )
    .await;
    let token = fields[CONNECTION_TOKEN_HEADER].clone();
    let handle = Arc::clone(&started.server.clients()[0].connection_handle);

    assert_eq!(status, 201, "a connection drawn");

    let ask = || {
        request_of(
            ("POST", port),
            &[
                ("content-type", BEAD_MEDIA_TYPE),
                (CONNECTION_TOKEN_HEADER, token.as_str()),
                ("content-length", "8"),
            ],
        )
    };
    let (asking, mut sending) = sent(&session, (ask(), false)).await;

    sending
        .send_data(Bytes::from(envelope_of(REQUEST, (1, 0))), true)
        .unwrap();

    let asked = patience(PATIENCE, asking).await.unwrap().unwrap();

    assert_eq!(asked.status().as_u16(), 200, "its head, as it is handed on");
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();
    assert_eq!(
        body_of(asked.into_body()).await,
        envelope_of(RESULT, (1, 0)),
        "its answer"
    );

    // a request waiting, its stream reset by its client: lost, and its connection with it
    let (waiting, mut sending) = sent(&session, (ask(), false)).await;

    sending
        .send_data(Bytes::from(envelope_of(REQUEST, (3, 0))), true)
        .unwrap();
    assert_eq!(
        patience(PATIENCE, waiting)
            .await
            .unwrap()
            .unwrap()
            .status()
            .as_u16(),
        200,
        "waiting"
    );
    sending.send_reset(h2::Reason::CANCEL);

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "lost, its connection closed"
    );
    // an answer after it goes nowhere, and never hangs
    assert!(
        started
            .send(&envelope_of(RESULT, (3, 0)), &handle)
            .await
            .is_ok(),
        "an answer that goes nowhere"
    );
    started.stop().await;
}

// spec 15.12
#[tokio::test]
async fn answers_a_preflight_over_http_2_as_over_http_1_1() {
    let started = started_secure(&HttpTransportServerOptions {
        origins: Some(vec![PAGE.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let session = session_of(port).await;
    let cors = |fields: &BTreeMap<String, String>| {
        [
            "access-control-allow-credentials",
            "access-control-allow-headers",
            "access-control-allow-methods",
            "access-control-allow-origin",
            "access-control-expose-headers",
            "access-control-max-age",
            "cache-control",
            "vary",
            "x-content-type-options",
            REFUSAL_HEADER,
        ]
        .map(|name| fields.get(name).cloned())
    };

    for requested in [
        "authorization,content-type",
        "bead-listen,content-type,traceparent",
    ] {
        let preflight_fields = [
            ("origin", PAGE),
            ("access-control-request-method", "POST"),
            ("access-control-request-headers", requested),
        ];
        let connect_fields = [("content-type", BEAD_MEDIA_TYPE), ("origin", PAGE)];
        let (h2_preflight, h2_preflight_fields, h2_preflight_body) = exchanged(
            &session,
            (request_of(("OPTIONS", port), &preflight_fields), None),
        )
        .await;
        let (h2_connect, h2_connect_fields, h2_connect_body) = exchanged(
            &session,
            (request_of(("POST", port), &connect_fields), None),
        )
        .await;
        let preflight = https_of(
            port,
            format!(
                "OPTIONS /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\nOrigin: {PAGE}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: {requested}\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        let connect = https_of(port, &post_head_over_tls(port, (&[("Origin", PAGE)], &[]))).await;
        let allowed = format!("authorization, {requested}, *");

        assert_eq!(
            (
                h2_preflight,
                h2_preflight_body.len(),
                cors(&h2_preflight_fields)
            ),
            (
                preflight.head.status,
                preflight.body.len(),
                cors(&preflight.head.fields)
            ),
            "a preflight over HTTP/2 as over HTTP/1.1"
        );
        assert_eq!(
            (h2_preflight, cors(&h2_preflight_fields)[1].as_deref()),
            (204, Some(allowed.as_str())),
            "a preflight answered"
        );
        assert_eq!(
            (h2_connect, h2_connect_body.len(), cors(&h2_connect_fields)),
            (
                connect.head.status,
                connect.body.len(),
                cors(&connect.head.fields)
            ),
            "a connect over HTTP/2 as over HTTP/1.1"
        );
        assert_eq!(
            (h2_connect, cors(&h2_connect_fields)[3].as_deref()),
            (201, Some(PAGE)),
            "a connect drawn, naming its origin"
        );
    }

    let told = started.recorder.told();

    assert_eq!(
        (told.connections.len(), started.server.clients().len()),
        (4, 4),
        "four connections drawn"
    );
    assert!(told.refusals.is_empty(), "no refusal");
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each request judged in turn, as the other sides' twins judge them"
)]
#[tokio::test]
async fn names_its_host_over_http_2_by_its_authority_a_host_beside_it_ignored_for_the_host_and_the_own_origin()
 {
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let own_text = format!("{HOST}:{port}");
    let own = own_text.as_str();
    let own_origin_text = format!("https://{own}");
    let own_origin = own_origin_text.as_str();
    let bead = ("content-type", BEAD_MEDIA_TYPE);
    let created = TlsAnswer::of(201, None);
    let host_refused = TlsAnswer::of(403, Some(HTTP_REFUSALS.host));
    let origin_refused = TlsAnswer::of(403, Some(HTTP_REFUSALS.origin));

    // :authority names the host and the own origin, a host beside it ignored; a host alone names
    // it where :authority is absent
    assert_eq!(
        [
            http2_of(port, &[(":authority", own), bead]).await,
            http2_of(
                port,
                &[(":authority", own), ("host", "rebind.example:8080"), bead]
            )
            .await,
            http2_of(
                port,
                &[(":authority", "rebind.example:8080"), ("host", own), bead]
            )
            .await,
            http2_of(
                port,
                &[
                    (":authority", own),
                    ("host", "rebind.example:8080"),
                    bead,
                    ("origin", own_origin)
                ]
            )
            .await,
            http2_of(
                port,
                &[
                    (":authority", own),
                    ("host", "rebind.example:8080"),
                    bead,
                    ("origin", "https://rebind.example:8080")
                ]
            )
            .await,
            http2_of(
                port,
                &[
                    (":authority", "Bead.LocalHost:443"),
                    bead,
                    ("origin", "https://bead.localhost:443")
                ]
            )
            .await,
            http2_of(port, &[("host", own), bead, ("origin", own_origin)]).await,
            http2_of(port, &[("host", "rebind.example:8080"), bead]).await,
        ],
        [
            created.clone(),
            created.clone(),
            host_refused.clone(),
            created.clone(),
            origin_refused.clone(),
            created.clone(),
            created.clone(),
            host_refused.clone(),
        ],
        "each request's host and origin, judged by its :authority"
    );

    // without either, the request is malformed over HTTP/2: its stream reset (RFC 9113 §8.1.1,
    // §8.3.1), nothing drawn
    let before = started.recorder.told().connections.len();

    assert_eq!(
        http2_of(port, &[bead]).await,
        TlsAnswer::reset(PROTOCOL_ERROR),
        "a request that names no authority"
    );
    assert_eq!(
        started.recorder.told().connections.len(),
        before,
        "nothing drawn"
    );
    started.stop().await;

    let named = started_secure(&HttpTransportServerOptions {
        hosts: Some(vec!["bead.test".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;

    assert_eq!(
        [
            http2_of(
                named.port,
                &[
                    (":authority", "bead.test:8443"),
                    ("host", "rebind.example"),
                    bead
                ]
            )
            .await,
            http2_of(
                named.port,
                &[
                    (":authority", "rebind.example:8443"),
                    ("host", "bead.test"),
                    bead
                ]
            )
            .await,
            http2_of(
                named.port,
                &[
                    (":authority", "bead.test:8443"),
                    ("host", "rebind.example:8443"),
                    bead,
                    ("origin", "https://bead.test:8443")
                ]
            )
            .await,
            http2_of(
                named.port,
                &[
                    (":authority", "bead.test:8443"),
                    ("host", "rebind.example:8443"),
                    bead,
                    ("origin", "https://rebind.example:8443")
                ]
            )
            .await,
        ],
        [created.clone(), host_refused, created, origin_refused],
        "a host it names, by :authority"
    );
    named.stop().await;
}

#[tokio::test]
async fn resets_over_http_2_the_stream_of_a_request_whose_authority_is_no_host_protocol_error_nothing_written()
 {
    let started = started_secure(&HttpTransportServerOptions {
        hosts: Some(vec!["*".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let bead = ("content-type", BEAD_MEDIA_TYPE);
    let mut session = TlsWire::open(started.port).await;

    // a percent-encoded octet, `*`, `;` and `=`, `+` in a name, an IPvFuture literal, a colon with
    // no port, after a name and after a literal, a space; on one session
    for authority in [
        "a%41.test",
        "a*b.test",
        "a;b=c",
        "a+b.test",
        "[v1.bead]",
        "localhost:",
        "[::1]:",
        "bad host",
    ] {
        assert_eq!(
            session.ask(&[(":authority", authority), bead]).await,
            TlsAnswer::reset(PROTOCOL_ERROR),
            "{authority}"
        );
    }

    // a host alone, where :authority is absent, judged as it would be; then neither
    assert_eq!(
        session.ask(&[("host", "a*b.test"), bead]).await,
        TlsAnswer::reset(PROTOCOL_ERROR),
        "a host alone"
    );
    assert_eq!(
        session.ask(&[bead]).await,
        TlsAnswer::reset(PROTOCOL_ERROR),
        "no authority or host"
    );
    assert!(
        started.recorder.told().connections.is_empty(),
        "nothing drawn"
    );
    // then one it takes, on the same session
    assert_eq!(
        session.ask(&[(":authority", "localhost"), bead]).await,
        TlsAnswer::of(201, None),
        "an authority it takes"
    );
    assert_eq!(started.recorder.told().connections.len(), 1, "one drawn");
    started.stop().await;
}

#[tokio::test]
async fn resets_over_http_2_the_stream_of_a_request_with_a_field_holding_an_octet_past_ascii_protocol_error_and_tells_nothing()
 {
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let own = format!("{HOST}:{port}");
    let own = (":authority", own.as_str());
    let bead = ("content-type", BEAD_MEDIA_TYPE);
    // é as its one octet of Latin-1, and in UTF-8, each of its two octets one character
    let utf8 = "caf\u{C3}\u{A9}";

    assert_eq!(utf8.chars().count(), 5, "é's two octets of UTF-8");

    for value in ["café", utf8] {
        assert_eq!(
            [
                http2_of(port, &[own, bead, ("x-other", value)]).await,
                http2_of(
                    port,
                    &[
                        own,
                        bead,
                        ("origin", format!("http://{value}.example").as_str())
                    ]
                )
                .await,
            ],
            [
                TlsAnswer::reset(PROTOCOL_ERROR),
                TlsAnswer::reset(PROTOCOL_ERROR)
            ],
            "{value:?}"
        );
    }

    assert!(started.recorder.told().refusals.is_empty(), "nothing told");
    // a tab is taken
    assert_eq!(
        http2_of(port, &[own, bead, ("x-other", "a\tb")]).await,
        TlsAnswer::of(201, None),
        "a tab"
    );
    started.stop().await;
}

#[tokio::test]
async fn resets_over_http_2_the_stream_of_a_request_whose_target_holds_a_control_character_a_space_del_or_an_octet_past_ascii_protocol_error_and_tells_nothing()
 {
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let own = format!("{HOST}:{port}");
    let own = (":authority", own.as_str());
    let bead = ("content-type", BEAD_MEDIA_TYPE);

    // a control character, a space, DEL, é in UTF-8, each of its two octets one character, a NUL,
    // and a NUL percent-encoded in its path: h2 resets the stream of what no target holds, and the
    // transport of the rest, PROTOCOL_ERROR (RFC 9113 §8.1.1), nothing written
    for path in [
        "/be\u{1}ad",
        "/bead?a\u{1}b",
        "/bead?a\tb",
        "/bead?a b",
        "/bead?a\u{7F}b",
        "/bead?\u{C3}\u{A9}",
        "/be%00ad",
        "/be\u{0}ad",
    ] {
        assert_eq!(
            http2_of(port, &[(":path", path), own, bead]).await,
            TlsAnswer::reset(PROTOCOL_ERROR),
            "{path:?}"
        );
    }

    // ! a lone 0xE9, no UTF-8, h2 refuses of its own, ending the session, PROTOCOL_ERROR, as
    // Kestrel does
    assert_eq!(
        http2_of(port, &[(":path", "/bead?é"), own, bead]).await,
        TlsAnswer {
            ended: Some(PROTOCOL_ERROR),
            ..TlsAnswer::default()
        },
        "a :path that is no UTF-8"
    );

    let told = started.recorder.told();

    assert!(
        told.refusals.is_empty() && told.connections.is_empty(),
        "nothing told"
    );
    // what its target percent-encodes is no octet of it, NUL in a query among them
    assert_eq!(
        http2_of(port, &[(":path", "/bead?a%01b%7F%00"), own, bead]).await,
        TlsAnswer::of(201, None),
        "what a target percent-encodes"
    );
    started.stop().await;
}

#[tokio::test]
async fn resets_over_http_2_the_stream_of_a_request_with_a_field_whose_value_starts_or_ends_with_a_space_or_a_tab_or_holds_an_octet_that_is_no_utf_8_and_h2_ends_the_session_of_a_control_character_but_a_tab()
 {
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let own = format!("{HOST}:{port}");
    let own = (":authority", own.as_str());
    let bead = ("content-type", BEAD_MEDIA_TYPE);

    // a value with a space or a tab at either end (RFC 9113 §8.2.1), which Node's parser drops
    // under its default; and a lone 0xE9, no UTF-8, where Kestrel ends the session: the transport
    // resets the stream of each, PROTOCOL_ERROR
    for (name, value) in [("x-other", " a"), ("x-other", "a\t"), ("x-other", "café")] {
        assert_eq!(
            http2_of(port, &[own, bead, (name, value)]).await,
            TlsAnswer::reset(PROTOCOL_ERROR),
            "{name}: {value:?}"
        );
    }

    // ! a control character, DEL among them, h2 refuses of its own as it decodes the head, ending
    // the session, PROTOCOL_ERROR, where the C# side's transport resets the stream and Node's
    // parser drops the field
    for (name, value) in [
        ("origin", "http://a.example\u{1B}[2J"),
        ("x-other", "a\u{7}b"),
        ("x-other", "a\u{7F}b"),
    ] {
        assert_eq!(
            http2_of(port, &[own, bead, (name, value)]).await,
            TlsAnswer {
                ended: Some(PROTOCOL_ERROR),
                ..TlsAnswer::default()
            },
            "{name}: {value:?}"
        );
    }

    let told = started.recorder.told();

    assert!(
        told.refusals.is_empty() && told.connections.is_empty(),
        "nothing told"
    );
    started.stop().await;
}

#[tokio::test]
async fn resets_over_http_2_the_stream_of_a_request_with_a_field_whose_value_starts_or_ends_with_a_space_or_a_tab_protocol_error_and_tells_nothing()
 {
    let started = started_secure(&HttpTransportServerOptions {
        origins: Some(vec![PAGE.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let own = format!("{HOST}:{port}");
    let own = (":authority", own.as_str());
    let bead = ("content-type", BEAD_MEDIA_TYPE);
    let padded_bead = format!("{BEAD_MEDIA_TYPE} ");
    let leading = format!(" {BEARER}");
    let trailing = format!("{BEARER}\t");
    let spaced_page = format!(" {PAGE}");
    let tabbed_page = format!("\t{PAGE}");

    // each field the transport reads, padded: h2 hands it on as it came, and the transport resets
    // its stream before it reads any, PROTOCOL_ERROR (RFC 9113 §8.1.1), nothing written — a
    // credential never presented, a body never taken, an origin never judged, a count never read
    for (name, value) in [
        ("authorization", "  Bearer x "),
        ("authorization", leading.as_str()),
        ("authorization", trailing.as_str()),
        ("content-type", padded_bead.as_str()),
        ("origin", spaced_page.as_str()),
        ("origin", tabbed_page.as_str()),
        (AFTER_HEADER, "\t0"),
        (AFTER_HEADER, " 0"),
        (AFTER_HEADER, "0 "),
    ] {
        let fields: Vec<(&str, &str)> = if name == "content-type" {
            vec![own, (name, value)]
        } else {
            vec![own, bead, (name, value)]
        };

        assert_eq!(
            http2_of(port, &fields).await,
            TlsAnswer::reset(PROTOCOL_ERROR),
            "{name}: {value:?}"
        );
    }

    let told = started.recorder.told();

    assert!(
        told.refusals.is_empty() && told.connections.is_empty(),
        "nothing told"
    );
    // a space within a value is taken
    assert_eq!(
        http2_of(port, &[own, bead, ("x-other", "a b")]).await,
        TlsAnswer::of(201, None),
        "a space within"
    );
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each request judged in turn, as the other sides' twins judge them"
)]
#[tokio::test]
async fn serves_http_2_and_http_1_1_on_one_port_a_call_over_each_and_closes_its_sessions_as_it_stops()
 {
    let server =
        HttpTransportServer::new(&under_tls(&HttpTransportServerOptions::default())).unwrap();
    let recorder = Arc::new(Recorder::default());

    // each request answered by its result, as a router would
    server.listen(Arc::new(Hearing {
        server: server.clone(),
        heard: |server: &HttpTransportServer,
                message: &TransportMessage,
                handle: &ConnectionHandle| {
            let call_id = u32::from_be_bytes(message.data[4..8].try_into().unwrap());

            drop(server.send(
                TransportMessage {
                    data: Bytes::from(envelope_of(RESULT, (call_id, 0))),
                    credential: None,
                    address: None,
                    port: None,
                    may_overtake: false,
                },
                handle,
            ));
        },
    }));
    server.listen(Arc::<Recorder>::clone(&recorder));

    let port = server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap()
        .port;
    let session = session_of(port).await;
    let (drew, fields, _) = exchanged(
        &session,
        (
            request_of(("POST", port), &[("content-type", BEAD_MEDIA_TYPE)]),
            None,
        ),
    )
    .await;
    let (asked, _, answer) = exchanged(
        &session,
        (
            request_of(
                ("POST", port),
                &[
                    ("content-type", BEAD_MEDIA_TYPE),
                    (
                        CONNECTION_TOKEN_HEADER,
                        fields[CONNECTION_TOKEN_HEADER].as_str(),
                    ),
                ],
            ),
            Some(envelope_of(REQUEST, (1, 0))),
        ),
    )
    .await;

    assert_eq!(
        (drew, asked, answer),
        (201, 200, envelope_of(RESULT, (1, 0))),
        "a call over HTTP/2"
    );
    assert_eq!(gauge(&server, "http2Sessions"), 1, "its HTTP/2 session");

    let drawn = https_of(port, &post_head_over_tls(port, (&[], &[]))).await;
    let called = https_of(
        port,
        &post_head_over_tls(
            port,
            (
                &[(
                    CONNECTION_TOKEN_HEADER,
                    drawn.head.fields[CONNECTION_TOKEN_HEADER].as_str(),
                )],
                &envelope_of(REQUEST, (3, 0)),
            ),
        ),
    )
    .await;

    assert_eq!(
        (drawn.head.status, called.head.status, called.body),
        (201, 200, envelope_of(RESULT, (3, 0))),
        "a call over HTTP/1.1"
    );
    assert_eq!(
        server
            .clients()
            .iter()
            .map(|client| client.connection_handle.to_string())
            .collect::<Vec<_>>(),
        [
            "type=HTTP;ip=127.0.0.1;ordinal=1",
            "type=HTTP;ip=127.0.0.1;ordinal=2"
        ],
        "a connection over each"
    );

    // an authority that is no host, a colon with no port: its stream reset over HTTP/2, 400 over
    // HTTP/1.1
    assert_eq!(
        http2_of(
            port,
            &[
                (":authority", "localhost:"),
                ("content-type", BEAD_MEDIA_TYPE)
            ]
        )
        .await,
        TlsAnswer::reset(PROTOCOL_ERROR),
        "over HTTP/2"
    );
    assert_eq!(
        https_of(
            port,
            format!("POST /bead HTTP/1.1\r\nHost: localhost:\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n").as_bytes(),
        )
        .await
        .head
        .status,
        400,
        "over HTTP/1.1"
    );

    // the HTTP/2 session the client keeps open holds no stop back, and is closed with it
    let before = Instant::now();

    patience(PATIENCE, server.stop()).await.unwrap().unwrap();
    assert!(
        before.elapsed() < Duration::from_secs(5),
        "a stop within 5 seconds"
    );
    until(|| gauge(&server, "http2Sessions") == 0).await;

    let is_closed = match patience(PATIENCE, session.clone().ready()).await.unwrap() {
        Err(_) => true,
        Ok(mut ready) => match ready.send_request(
            request_of(("POST", port), &[("content-type", BEAD_MEDIA_TYPE)]),
            true,
        ) {
            Err(_) => true,
            Ok((response, _)) => patience(PATIENCE, response).await.unwrap().is_err(),
        },
    };

    assert!(is_closed, "its session closed");
}

#[tokio::test]
async fn draws_a_connection_over_http_2_before_its_empty_body_ends() {
    let started = started_secure(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let session = session_of(port).await;

    // its head says its body is empty, and its stream ends later: whether a connect has a body is
    // read from its head, never from an end of stream still to come
    let (drawing, mut sending) = sent(
        &session,
        (
            request_of(
                ("POST", port),
                &[("content-type", BEAD_MEDIA_TYPE), ("content-length", "0")],
            ),
            false,
        ),
    )
    .await;
    let drew = patience(PATIENCE, drawing).await.unwrap().unwrap();

    assert_eq!(drew.status().as_u16(), 201, "drawn before its stream ends");
    sending.send_data(Bytes::new(), true).ok();
    started.stop().await;
}

#[tokio::test]
async fn is_secure_under_tls_whatever_it_listens_on_or_on_a_loopback_host_alone_and_carries_no_credential_toward_a_connection()
 {
    // whether a connection drawn on a server listening on `address`, under TLS or not, carries a
    // credential, and whether it is secure
    async fn secured_by((address, is_tls): (&str, bool)) -> (bool, bool) {
        let options = HttpTransportServerOptions::default();
        let server =
            HttpTransportServer::new(&if is_tls { under_tls(&options) } else { options }).unwrap();
        let port = server
            .start(&TransportServerStartOptions {
                address: Some(address.to_owned()),
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap()
            .port;

        if is_tls {
            let session = session_of(port).await;

            exchanged(
                &session,
                (
                    request_of(("POST", port), &[("content-type", BEAD_MEDIA_TYPE)]),
                    None,
                ),
            )
            .await;
        } else {
            posted(port, &Post::default()).await;
        }

        let handle = Arc::clone(&server.clients()[0].connection_handle);
        let secured = (
            server.carries_credential(&handle),
            server.is_secure(&handle),
        );

        server.stop().await.unwrap();

        secured
    }

    assert_eq!(
        [
            secured_by(("0.0.0.0", true)).await,
            secured_by(("0.0.0.0", false)).await,
            secured_by((HOST, true)).await,
            secured_by((HOST, false)).await,
        ],
        [(false, true), (false, false), (false, true), (false, true)],
        "under TLS wherever it listens, or on the loopback"
    );

    // its application's word over TLS: TLS terminated on a server of its own that serves the
    // network in the clear
    let started = started_secure(&HttpTransportServerOptions {
        secure: Some(false),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let session = session_of(started.port).await;

    exchanged(
        &session,
        (
            request_of(("POST", started.port), &[("content-type", BEAD_MEDIA_TYPE)]),
            None,
        ),
    )
    .await;

    let handle = Arc::clone(&started.server.clients()[0].connection_handle);

    assert!(!started.server.is_secure(&handle), "told it is not");
    started.stop().await;
}
