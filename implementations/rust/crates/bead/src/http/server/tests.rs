//! The HTTP transport server, the twin of `http-transport-server.test.ts` and
//! `HttpTransportServerTests`: its connections, its exchanges and their ends, its refusals, its
//! bounds and its options.

use core::time::Duration;

use super::*;
use crate::constants::{EnvelopeKind, RESERVATION};
use crate::http::peer::Told as Heard;
use crate::http::peer::*;
use crate::router::types::LIMIT_DEFAULTS;
use crate::testing::{patience, rest};

mod life;
mod listens;
mod over_tls;
mod tls_wire;

// a refusal's status and mark, and what it tells of its request: its authority and its origin
type Mark<'a> = (u16, &'a str);
type Told<'a> = (Option<&'a str>, Option<&'a str>);

// a token of the form the server draws, which no connection holds
const UNKNOWN_TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAA";

// a listener that does what `on_message` says with each message, the server at hand
struct Hearing<F: Fn(&HttpTransportServer, &TransportMessage, &ConnectionHandle) + Send + Sync> {
    server: HttpTransportServer,
    heard: F,
}

impl<F: Fn(&HttpTransportServer, &TransportMessage, &ConnectionHandle) + Send + Sync> ServerListener
    for Hearing<F>
{
    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        (self.heard)(&self.server, &message, connection_handle);
    }
}

// a listener of each event that panics, as one that throws
#[derive(Default)]
struct Throwing {
    on_connection: bool,
    on_message: bool,
    on_refusal: bool,
}

impl ServerListener for Throwing {
    fn on_connection(&self, _connection_handle: &ConnectionHandle) {
        assert!(!self.on_connection, "a connection listener that throws");
    }

    fn on_message(&self, _message: TransportMessage, _connection_handle: &ConnectionHandle) {
        assert!(!self.on_message, "a message listener that throws");
    }

    fn on_refusal(&self, _refusal: &TransportServerRefusal) {
        assert!(!self.on_refusal, "a refusal listener that throws");
    }
}

// a server whose listeners are `first`, then a recorder
async fn started_behind(
    first: Arc<dyn ServerListener>,
    options: &HttpTransportServerOptions,
) -> Started {
    let server = HttpTransportServer::new(options).unwrap();
    let recorder = Arc::new(Recorder::default());

    server.listen(first);
    server.listen(Arc::<Recorder>::clone(&recorder));

    let bound = server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    Started {
        server,
        recorder,
        port: bound.port,
    }
}

// a request on `token`, its body `envelope`, its exchange to read
async fn asking(
    started: &Started,
    (token, envelope): (&str, Vec<u8>),
) -> crate::testing::wire::Exchange {
    posting(
        started.port,
        &Post {
            token: Some(token),
            body: envelope,
            ..Post::default()
        },
    )
    .await
}

// what a `POST` on `token` of `envelope` is answered, whole
async fn posted_on(
    started: &Started,
    (token, envelope): (&str, Vec<u8>),
) -> crate::testing::wire::Response {
    posted(
        started.port,
        &Post {
            token: Some(token),
            body: envelope,
            ..Post::default()
        },
    )
    .await
}

// the kinds of what was handed on
fn kinds_of(told: &Heard) -> Vec<u8> {
    told.messages
        .iter()
        .map(|(message, _)| message.data[1])
        .collect()
}

// spec 15.12.4
#[test]
fn keeps_its_constants_in_step_with_the_router_s() {
    assert_eq!(
        [REQUEST, RESULT, FAILURE, CANCEL],
        [
            EnvelopeKind::Request.byte(),
            EnvelopeKind::Result.byte(),
            EnvelopeKind::Failure.byte(),
            EnvelopeKind::Cancel.byte()
        ],
        "the kinds it tells apart"
    );
    assert_eq!(
        [REQUEST, RESULT, FAILURE, CANCEL],
        [0x10, 0x11, 0x12, 0x16],
        "their bytes"
    );
    assert_eq!(BURIAL, RESERVATION, "a burial lasts a reservation");
    assert_eq!(
        MAXIMUM_BODY_BYTES, LIMIT_DEFAULTS.maximum_envelope_bytes,
        "a body is a router's largest envelope"
    );
    assert_eq!(BODY_BYTES_BUDGET, 268_435_456, "its budget");
    assert_eq!(
        [
            MAXIMUM_CONNECTIONS,
            MAXIMUM_CONNECTIONS_PER_ADDRESS,
            MAXIMUM_WAITING_EXCHANGES
        ],
        [10_000, 64, 64],
        "its bounds"
    );
    assert_eq!(PATHNAME, "/bead", "its path");
    assert_eq!(
        MAXIMUM_OUTBOX_BYTES,
        2 * LIMIT_DEFAULTS.maximum_envelope_bytes,
        "two of a router's largest envelopes"
    );
    assert_eq!(
        [EXCHANGE_TIMEOUT, INACTIVITY_TIMEOUT, MAXIMUM_WAIT],
        [
            Duration::from_secs(300),
            Duration::from_secs(300),
            Duration::from_secs(30)
        ],
        "its timers"
    );
}

// spec 9.11
#[tokio::test]
async fn draws_a_connection_on_a_connect_a_token_of_16_bytes_a_201_and_connection_first_showing_neither()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let response = posted(started.port, &Post::default()).await;
    let token = response.head.fields[CONNECTION_TOKEN_HEADER].clone();
    let told = started.recorder.told();
    let handle = Arc::clone(&told.connections[0]);

    assert_eq!(
        (
            response.head.status,
            response.head.fields.get("cache-control").cloned(),
            response.head.fields.get("x-content-type-options").cloned()
        ),
        (201, Some("no-store".to_owned()), Some("nosniff".to_owned())),
        "its 201"
    );
    assert!(is_token(&token), "a token of 22 characters: {token}");
    assert_eq!(
        base64url::decode(token.as_bytes()).map(|bytes| bytes.len()),
        Some(16),
        "of 16 bytes"
    );
    assert_eq!(
        &*handle, "type=HTTP;ip=127.0.0.1;ordinal=1",
        "its handle, showing no token"
    );
    assert_eq!(
        told.order,
        vec!["connection"],
        "told before its 201 was read"
    );
    assert!(
        !started.server.is_two_way(&handle),
        "its client does not listen"
    );

    let clients = started.server.clients();

    assert_eq!(
        clients
            .iter()
            .map(|client| (
                client.address.clone(),
                Arc::clone(&client.connection_handle),
                client.transport_type
            ))
            .collect::<Vec<_>>(),
        vec![(HOST.to_owned(), Arc::clone(&handle), TRANSPORT_HTTP)],
        "the connection it holds"
    );
    assert_eq!(
        started
            .server
            .gauges()
            .unwrap()
            .connection_handles
            .into_iter()
            .collect::<Vec<_>>(),
        vec![Arc::clone(&handle)],
        "its gauges"
    );
    // the token reaches no event, and no client listed
    assert!(
        !format!("{told:?}{clients:?}").contains(&token),
        "the token shown nowhere"
    );

    let (second, second_token) = connect(&started).await;

    assert_eq!(
        &*second, "type=HTTP;ip=127.0.0.1;ordinal=2",
        "the second's handle"
    );
    assert_ne!(second_token, token, "the second's token");
    started.stop().await;
}

#[tokio::test]
async fn pairs_each_answer_with_the_exchange_of_its_request_whatever_the_order_the_head_going_as_the_request_is_handed_on()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let first = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;
    let second = asking(&started, (&token, envelope_of(REQUEST, (3, 2)))).await;

    // both heads arrive before any answer: the router has both
    let (first_head, second_head) = (
        first.head(PATIENCE).await.unwrap(),
        second.head(PATIENCE).await.unwrap(),
    );

    assert_eq!(
        (first_head.status, second_head.status),
        (200, 200),
        "both heads"
    );
    assert_eq!(
        first_head.fields.get("content-type").map(String::as_str),
        Some(BEAD_MEDIA_TYPE),
        "of Bead's type"
    );
    assert_eq!(
        started.recorder.messages(2).await.len(),
        2,
        "both handed on"
    );

    started
        .send(&envelope_of(RESULT, (3, 1)), &handle)
        .await
        .unwrap();
    started
        .send(&envelope_of(FAILURE, (1, 0)), &handle)
        .await
        .unwrap();

    assert_eq!(
        second.response(PATIENCE).await.unwrap().body,
        envelope_of(RESULT, (3, 1)),
        "the second's answer"
    );
    assert_eq!(
        first.response(PATIENCE).await.unwrap().body,
        envelope_of(FAILURE, (1, 0)),
        "the first's"
    );
    // an answer whose exchange ended is dropped, as one to a connection gone
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .expect("dropped");
    started.stop().await;
}

#[tokio::test]
async fn answers_an_answer_sent_as_its_request_is_handed_on_in_one_go() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;

    started.server.listen(Arc::new(Hearing {
        server: started.server.clone(),
        heard: |server: &HttpTransportServer, _: &TransportMessage, handle: &ConnectionHandle| {
            let message = TransportMessage {
                data: Bytes::from(envelope_of(FAILURE, (5, 0))),
                credential: None,
                address: None,
                port: None,
                may_overtake: false,
            };

            drop(server.send(message, handle));
        },
    }));

    let response = posted_on(&started, (&token, envelope_of(REQUEST, (5, 0)))).await;

    assert_eq!(
        (
            response.head.fields.get("content-length").cloned(),
            response.body
        ),
        (Some("8".to_owned()), envelope_of(FAILURE, (5, 0))),
        "answered in one go"
    );
    started.stop().await;
}

#[tokio::test]
async fn hands_on_any_other_envelope_and_ends_its_exchange_204_at_once() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;

    for kind in [RESULT, 0x80] {
        assert_eq!(
            posted_on(&started, (&token, envelope_of(kind, (2, 0))))
                .await
                .head
                .status,
            204,
            "{kind}"
        );
    }

    assert_eq!(
        started
            .recorder
            .messages(2)
            .await
            .into_iter()
            .map(|(message, connection)| (message.data.to_vec(), connection))
            .collect::<Vec<_>>(),
        vec![
            (envelope_of(RESULT, (2, 0)), Arc::clone(&handle)),
            (envelope_of(0x80, (2, 0)), handle)
        ],
        "each handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn hands_a_request_on_with_its_authorization_whole_and_any_other_envelope_with_none() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;

    started.server.listen(Arc::new(Hearing {
        server: started.server.clone(),
        heard: |server: &HttpTransportServer,
                message: &TransportMessage,
                handle: &ConnectionHandle| {
            if message.data[1] == REQUEST {
                let answer = TransportMessage {
                    data: Bytes::from(envelope_of(RESULT, (1, 0))),
                    credential: Some(BEARER.to_owned()),
                    address: None,
                    port: None,
                    may_overtake: false,
                };

                drop(server.send(answer, handle));
            }
        },
    }));

    let with = |envelope: Vec<u8>| Post {
        token: Some(&token),
        fields: vec![format!("Authorization: {BEARER}")],
        body: envelope,
        ..Post::default()
    };
    let answered = posted(started.port, &with(envelope_of(REQUEST, (1, 0)))).await;
    let cancelled = posted(started.port, &with(envelope_of(CANCEL, (1, 0)))).await;

    // an answer carries none
    assert_eq!(
        (
            answered.head.status,
            answered.head.fields.get("authorization").cloned(),
            cancelled.head.status
        ),
        (200, None, 204),
        "answered, and cancelled"
    );
    assert_eq!(
        started
            .recorder
            .told()
            .messages
            .iter()
            .map(|(message, _)| (message.data[1], message.credential.clone()))
            .collect::<Vec<_>>(),
        vec![(REQUEST, Some(BEARER.to_owned())), (CANCEL, None)],
        "the request's credential alone"
    );
    started.stop().await;
}

#[tokio::test]
async fn takes_an_authorization_as_it_came_an_empty_one_carrying_none() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;

    let mut waiting = Vec::new();

    for (call_id, authorization) in [
        (1, Some("Bearer  mF_9.B5f-4.1JqM")),
        (3, Some("basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")),
        (5, Some("")),
        (7, None),
    ] {
        waiting.push(
            posting(
                started.port,
                &Post {
                    token: Some(&token),
                    fields: authorization
                        .map(|authorization| format!("Authorization: {authorization}"))
                        .into_iter()
                        .collect(),
                    body: envelope_of(REQUEST, (call_id, 0)),
                    ..Post::default()
                },
            )
            .await,
        );
        started
            .recorder
            .messages(usize::try_from(call_id / 2 + 1).unwrap())
            .await;
    }

    assert_eq!(
        started
            .recorder
            .told()
            .messages
            .iter()
            .map(|(message, _)| message.credential.clone())
            .collect::<Vec<_>>(),
        vec![
            Some("Bearer  mF_9.B5f-4.1JqM".to_owned()),
            Some("basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==".to_owned()),
            None,
            None
        ],
        "each as it came"
    );
    drop(waiting);
    started.stop().await;
}

#[tokio::test]
async fn ends_the_exchange_a_cancel_names_empty_and_drops_a_request_its_cancel_came_before() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let head = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    assert_eq!(head.head(PATIENCE).await.unwrap().status, 200, "its head");

    let cancel = posted_on(&started, (&token, envelope_of(CANCEL, (1, 0)))).await;

    // its head gone already: a 200 that ends with no body
    assert_eq!(
        (
            cancel.head.status,
            head.response(PATIENCE).await.unwrap().body
        ),
        (204, Vec::new()),
        "ended empty"
    );

    // its cancel first, then the request: buried, never handed on
    let early = posted_on(&started, (&token, envelope_of(CANCEL, (3, 0)))).await;
    let late = posted_on(&started, (&token, envelope_of(REQUEST, (3, 0)))).await;

    assert_eq!((early.head.status, late.head.status), (204, 204), "buried");
    assert_eq!(
        kinds_of(&started.recorder.told()),
        vec![REQUEST, CANCEL, CANCEL],
        "the late request never handed on"
    );

    // the burial is spent: the call id may come again
    let again = asking(&started, (&token, envelope_of(REQUEST, (3, 0)))).await;

    assert_eq!(again.head(PATIENCE).await.unwrap().status, 200, "again");
    started
        .send(&envelope_of(RESULT, (3, 0)), &handle)
        .await
        .unwrap();
    again.response(PATIENCE).await.unwrap();
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each of its fourteen refusals written whole, as the other sides' twins write them"
)]
#[tokio::test]
async fn refuses_what_is_not_a_bead_exchange_with_a_status_of_its_own_marked_and_hands_the_router_nothing()
 {
    let started = started(&HttpTransportServerOptions {
        origins: Some(vec!["https://app.example".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (_, token) = connect(&started).await;
    let raw = |method: &str, (target, fields): (&str, &[&str])| {
        let mut lines: Vec<&str> = fields.to_vec();

        lines.push("Content-Length: 0");
        head_of((method, target), (port, &lines)).into_bytes()
    };
    let token_field = format!("{CONNECTION_TOKEN_HEADER}: {token}");
    let bead = format!("Content-Type: {BEAD_MEDIA_TYPE}");
    let with = |fields: Vec<String>, body: Vec<u8>| {
        Post {
            token: None,
            fields,
            body,
            untyped: true,
        }
        .request(port)
    };
    let cases: Vec<(Vec<u8>, (u16, &str))> = vec![
        (raw("POST", ("/bead/else", &[])), (404, HTTP_REFUSALS.path)),
        (raw("PUT", ("/bead", &[])), (405, HTTP_REFUSALS.method)),
        (
            with(
                vec![
                    bead.clone(),
                    token_field.clone(),
                    "Origin: https://elsewhere.example".to_owned(),
                ],
                vec![],
            ),
            (403, HTTP_REFUSALS.origin),
        ),
        (
            with(
                vec![
                    "Content-Type: application/octet-stream".to_owned(),
                    token_field.clone(),
                ],
                vec![],
            ),
            (415, HTTP_REFUSALS.type_refused),
        ),
        (
            with(vec!["Content-Type: text/plain".to_owned()], vec![]),
            (415, HTTP_REFUSALS.type_refused),
        ),
        (
            with(
                vec![
                    bead.clone(),
                    token_field.clone(),
                    "Content-Encoding: gzip".to_owned(),
                ],
                vec![],
            ),
            (415, HTTP_REFUSALS.type_refused),
        ),
        (
            with(vec![bead.clone()], envelope_of(REQUEST, (1, 0))),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(
                vec![
                    bead.clone(),
                    format!("{CONNECTION_TOKEN_HEADER}: not-a-token"),
                ],
                vec![],
            ),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(
                vec![
                    bead.clone(),
                    format!("{CONNECTION_TOKEN_HEADER}: {UNKNOWN_TOKEN}"),
                ],
                vec![],
            ),
            (404, HTTP_REFUSALS.connection_unknown),
        ),
        (
            raw("DELETE", ("/bead", &[])),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(vec![bead.clone(), token_field.clone()], vec![0xA1, 0x10]),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(
                vec![bead.clone(), token_field.clone()],
                layout_of((0x20, REQUEST), (1, 0)),
            ),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(
                vec![bead.clone(), token_field.clone()],
                envelope_of(REQUEST, (2, 0)),
            ),
            (400, HTTP_REFUSALS.malformed),
        ),
        (
            with(
                vec![bead.clone(), token_field.clone()],
                envelope_of(REQUEST, (0, 0)),
            ),
            (400, HTTP_REFUSALS.malformed),
        ),
    ];

    for (request, (status, reason)) in cases {
        let response = exchange_of(port, &request)
            .await
            .response(PATIENCE)
            .await
            .unwrap();

        assert_eq!(
            refusal_of(&response.head),
            (status, Some(reason.to_owned())),
            "{}",
            String::from_utf8_lossy(&request)
        );
    }

    let method = raw_answer_of(port, &raw("PUT", ("/bead", &[]))).await;

    assert_eq!(
        method.fields.get("allow").map(String::as_str),
        Some("GET, POST, DELETE"),
        "what it takes"
    );

    // its own origin, and one it was told of, pass
    for origin in [
        format!("http://{HOST}:{port}"),
        "https://app.example".to_owned(),
    ] {
        let response = posted(
            port,
            &Post {
                token: Some(&token),
                fields: vec![format!("Origin: {origin}")],
                body: envelope_of(CANCEL, (1, 0)),
                ..Post::default()
            },
        )
        .await;

        assert_eq!(response.head.status, 204, "{origin}");
    }

    let told = started.recorder.told();

    assert_eq!(told.messages.len(), 2, "the two cancels alone");
    // the connection stays: a refusal ends its exchange alone
    assert!(told.closes.is_empty(), "no close");
    started.stop().await;
}

#[tokio::test]
async fn reads_the_host_as_it_came_an_idn_page_s_own_in_punycode_and_one_of_invalid_punycode_taken_or_refused_host_refused_never_a_500()
 {
    // the status and the mark of a connect from each `[Host, Origin]`, on a server given `hosts`
    let answers_of = async |hosts: &[&str], connects: &[(&str, Option<&str>)]| {
        let started = started(&HttpTransportServerOptions {
            hosts: Some(hosts.iter().map(|host| (*host).to_owned()).collect()),
            ..HttpTransportServerOptions::default()
        })
        .await;
        let mut answers = Vec::new();

        for (authority, origin) in connects {
            let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
            let answer = raw_answer_of(
                started.port,
                format!(
                    "POST /bead HTTP/1.1\r\nHost: {authority}\r\n{origin}Content-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;

            answers.push((answer.status, answer.refusal));
        }

        started.stop().await;
        answers
    };
    let page = (
        "xn--bad-bma.test:8080",
        Some("http://xn--bad-bma.test:8080"),
    );
    let refused = |status: u16, reason: &str| (status, Some(reason.to_owned()));

    // a page on an IDN host, its Host and its Origin in punycode as a browser writes them both,
    // and a Host of punycode that decodes to none, taken where every host is; under *, no page is
    // the server's own by a host * alone takes (spec 15.12)
    assert_eq!(
        answers_of(
            &["*"],
            &[
                page,
                ("xn--a", Some("http://xn--a")),
                ("xn--a", None),
                ("xn--a.test", None),
                ("xn---bad-cpa.test", None)
            ]
        )
        .await,
        vec![
            refused(403, HTTP_REFUSALS.origin),
            refused(403, HTTP_REFUSALS.origin),
            (201, None),
            (201, None),
            (201, None)
        ],
        "under *"
    );
    // hosts name an IDN host as the field carries it, in punycode, and none past them is taken
    assert_eq!(
        answers_of(
            &["xn--bad-bma.test"],
            &[
                page,
                ("XN--BAD-BMA.test:8080", None),
                ("xn--a.test", None),
                ("xn---bad-cpa.test", None),
                ("xn--a", None)
            ]
        )
        .await,
        vec![
            (201, None),
            (201, None),
            refused(403, HTTP_REFUSALS.host),
            refused(403, HTTP_REFUSALS.host),
            refused(403, HTTP_REFUSALS.host)
        ],
        "named"
    );
}

#[tokio::test]
async fn refuses_a_request_on_a_call_id_already_waiting_409() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let first = asking(&started, (&token, envelope_of(REQUEST, (7, 0)))).await;

    assert_eq!(first.head(PATIENCE).await.unwrap().status, 200, "the first");

    let again = posted_on(&started, (&token, envelope_of(REQUEST, (7, 0)))).await;

    assert_eq!(
        refusal_of(&again.head),
        (409, Some(HTTP_REFUSALS.call_waiting.to_owned())),
        "again"
    );
    started
        .send(&envelope_of(RESULT, (7, 0)), &handle)
        .await
        .unwrap();
    assert_eq!(
        first.response(PATIENCE).await.unwrap().body,
        envelope_of(RESULT, (7, 0)),
        "the first answered"
    );
    started.stop().await;
}

// spec 15.12.4
#[tokio::test]
async fn bounds_its_connections_and_those_of_one_address_the_requests_one_waits_on_and_the_bytes_of_body_under_way()
 {
    let started = started(&HttpTransportServerOptions {
        body_bytes_budget: Some(32),
        maximum_connections: Some(2),
        maximum_connections_per_address: Some(1),
        maximum_waiting_exchanges: Some(1),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (handle, token) = connect(&started).await;
    let response = posted(started.port, &Post::default()).await;

    // one address, one connection: busy, and told when to come back
    assert_eq!(
        (
            refusal_of(&response.head),
            response.head.fields.get("retry-after").cloned()
        ),
        (
            (503, Some(HTTP_REFUSALS.busy.to_owned())),
            Some("1".to_owned())
        ),
        "a second connection of its address"
    );

    let waiting = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    assert_eq!(waiting.head(PATIENCE).await.unwrap().status, 200, "waiting");

    let crowded = posted_on(&started, (&token, envelope_of(REQUEST, (3, 0)))).await;
    // a cancel takes no place: it is never refused for the requests waiting
    let cancel = posted_on(&started, (&token, envelope_of(CANCEL, (9, 0)))).await;

    assert_eq!(
        (refusal_of(&crowded.head), cancel.head.status),
        ((429, Some(HTTP_REFUSALS.busy.to_owned())), 204),
        "crowded, and a cancel"
    );
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();
    waiting.response(PATIENCE).await.unwrap();

    let heavy = posted_on(&started, (&token, envelope_of(REQUEST, (5, 32)))).await;

    assert_eq!(
        refusal_of(&heavy.head),
        (503, Some(HTTP_REFUSALS.busy.to_owned())),
        "past the bytes under way"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_a_connection_on_its_delete_a_request_handed_on_learns_it_by_its_exchange_cut() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let waiting = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    assert_eq!(
        waiting.head(PATIENCE).await.unwrap().status,
        200,
        "its head"
    );

    let deleted = raw_answer_of(
        started.port,
        head_of(
            ("DELETE", "/bead"),
            (
                started.port,
                &[&format!("{CONNECTION_TOKEN_HEADER}: {token}")],
            ),
        )
        .as_bytes(),
    )
    .await;

    assert_eq!(deleted.status, 204, "its DELETE");
    // its head was out: nothing of a 404 can follow, so its body is cut, as a lost one's is
    assert!(
        waiting.response(PATIENCE).await.is_err(),
        "its exchange cut"
    );

    let told = started.recorder.told();

    assert_eq!(
        told.closes,
        vec![(true, Arc::clone(&handle))],
        "its close, clean"
    );
    assert!(started.server.clients().is_empty(), "no client left");
    assert!(
        started
            .server
            .gauges()
            .unwrap()
            .connection_handles
            .is_empty(),
        "none gauged"
    );
    assert!(
        !format!("{told:?}").contains(&token),
        "the token shown nowhere"
    );

    let after = posted_on(&started, (&token, envelope_of(REQUEST, (3, 0)))).await;

    assert_eq!(
        refusal_of(&after.head),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "after it"
    );
    // an answer for it goes nowhere
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .expect("nowhere");
    started.stop().await;
}

#[tokio::test]
async fn closes_a_connection_the_server_closes_cutting_the_exchange_of_a_request_it_handed_on() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let waiting = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    assert_eq!(
        waiting.head(PATIENCE).await.unwrap().status,
        200,
        "its head"
    );
    assert!(started.server.close(&handle).await, "it held it");
    assert!(
        waiting.response(PATIENCE).await.is_err(),
        "its exchange cut"
    );

    let told = started.recorder.told();

    assert_eq!(
        (told.messages.len(), told.closes),
        (1, vec![(true, handle)]),
        "its close, clean"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_a_connection_the_server_closes_as_the_request_is_handed_on_cutting_its_exchange_after_its_head()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;

    started.server.listen(Arc::new(Hearing {
        server: started.server.clone(),
        heard: |server: &HttpTransportServer, _: &TransportMessage, handle: &ConnectionHandle| {
            drop(server.close(handle));
        },
    }));

    let waiting = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    // the router had it, so never a refusal, which says nothing was tried: a 200 whose body is
    // cut, or, the cut overtaking its head, an exchange lost before any status
    if let Ok(head) = waiting.head(PATIENCE).await {
        assert_eq!(
            (
                head.status,
                head.fields.get("content-type").map(String::as_str),
                head.fields.get("cache-control").map(String::as_str),
                head.fields.get(REFUSAL_HEADER)
            ),
            (200, Some(BEAD_MEDIA_TYPE), Some("no-store"), None),
            "its head"
        );
        assert!(waiting.response(PATIENCE).await.is_err(), "its body cut");
    }

    let told = started.recorder.told();

    assert_eq!(
        (told.messages.len(), told.closes),
        (1, vec![(true, handle)]),
        "its close, clean"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_a_connection_whose_exchange_was_lost_before_its_answer() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let head = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    assert_eq!(head.head(PATIENCE).await.unwrap().status, 200, "its head");

    head.destroy();

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, handle)],
        "its close, unclean"
    );
    // nor does a connection's end show its token: no event, message, close or error
    assert!(
        !format!(
            "{:?}{:?}",
            started.recorder.told(),
            started.server.clients()
        )
        .contains(&token),
        "the token shown nowhere"
    );
    started.stop().await;
}

#[tokio::test]
async fn sends_a_connection_that_does_not_listen_its_answers_alone_anything_else_of_the_server_s_own_rejects()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, _) = connect(&started).await;

    for kind in [
        EnvelopeKind::Notification,
        EnvelopeKind::Request,
        EnvelopeKind::Credit,
    ] {
        let sent = started
            .send(&envelope_of(kind.byte(), (2, 0)), &handle)
            .await;

        assert!(
            sent.is_err_and(|error| error
                .to_string()
                .contains("this connection does not listen")),
            "{kind:?}"
        );
    }

    let short = started.send(&[0; 4], &handle).await;

    assert!(
        short.is_err_and(
            |error| error.to_string() == "an HTTP exchange carries one envelope, as bytes"
        ),
        "four bytes"
    );
    started.stop().await;
}

#[tokio::test]
async fn resolves_a_send_for_a_handle_nobody_holds() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let nobody: ConnectionHandle = Arc::from("type=HTTP;ip=127.0.0.1;ordinal=9");

    started
        .send(&envelope_of(RESULT, (1, 0)), &nobody)
        .await
        .expect("settled");
    started.stop().await;
}

#[tokio::test]
async fn draws_a_connection_whose_connection_listener_throws_the_next_listener_told_the_throw_reported_with_it()
 {
    let started = started_behind(
        Arc::new(Throwing {
            on_connection: true,
            ..Throwing::default()
        }),
        &HttpTransportServerOptions::default(),
    )
    .await;
    let response = posted(started.port, &Post::default()).await;
    let handle = Arc::clone(&started.server.clients().last().unwrap().connection_handle);
    let told = started.recorder.told();

    // drawn and given out: its 201 and its token, the connection among those it holds
    assert_eq!(response.head.status, 201, "its 201");
    assert!(
        is_token(&response.head.fields[CONNECTION_TOKEN_HEADER]),
        "its token"
    );
    assert_eq!(told.connections, vec![Arc::clone(&handle)], "the next told");
    assert_eq!(
        told.errors,
        vec![(
            "a listener panicked: a connection listener that throws".to_owned(),
            Some(Arc::clone(&handle))
        )],
        "the throw reported with it"
    );

    let gauges = started.server.gauges().unwrap();

    assert_eq!(
        (gauges.counts["connections"], gauges.counts["addresses"]),
        (1, 1),
        "counted"
    );
    assert!(told.closes.is_empty(), "no close");
    started.stop().await;
}

#[tokio::test]
async fn hands_on_a_request_whose_message_listener_throws_its_answer_still_written_the_throw_reported_with_its_connection()
 {
    let started = started_behind(
        Arc::new(Throwing {
            on_message: true,
            ..Throwing::default()
        }),
        &HttpTransportServerOptions::default(),
    )
    .await;
    let (handle, token) = connect(&started).await;

    for (round, call_id) in [(1, 1), (2, 3)] {
        let asked = asking(&started, (&token, envelope_of(REQUEST, (call_id, 0)))).await;

        // the listener after it heard it, and its exchange still waits for its answer
        started.recorder.messages(round).await;
        until(|| gauge(&started.server, "waitingExchanges") == 1).await;
        started
            .send(&envelope_of(RESULT, (call_id, 3)), &handle)
            .await
            .unwrap();

        let response = asked.response(PATIENCE).await.unwrap();

        assert_eq!(
            (response.head.status, response.body),
            (200, envelope_of(RESULT, (call_id, 3))),
            "its answer, round {round}"
        );
        assert_eq!(
            started.recorder.errors(round).await,
            vec![
                (
                    "a listener panicked: a message listener that throws".to_owned(),
                    Some(Arc::clone(&handle))
                );
                round
            ],
            "each throw reported"
        );
        assert_eq!(
            gauge(&started.server, "waitingExchanges"),
            0,
            "none waiting"
        );
    }

    assert_eq!(started.server.clients().len(), 1, "its connection kept");
    assert!(started.recorder.told().closes.is_empty(), "no close");
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each option refused written whole, as the other sides' twins write them"
)]
#[test]
fn refuses_options_it_cannot_hold() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();

    for (name, options) in [
        (
            "bodyBytesBudget",
            HttpTransportServerOptions {
                body_bytes_budget: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumBodyBytes",
            HttpTransportServerOptions {
                maximum_body_bytes: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumConnectionsPerAddress",
            HttpTransportServerOptions {
                maximum_connections_per_address: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumConnections",
            HttpTransportServerOptions {
                maximum_connections: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumWaitingExchanges",
            HttpTransportServerOptions {
                maximum_waiting_exchanges: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "exchangeTimeout",
            HttpTransportServerOptions {
                exchange_timeout: Some(Duration::from_millis(2_147_483_648)),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "exchangeTimeout",
            HttpTransportServerOptions {
                exchange_timeout: Some(Duration::from_micros(500)),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "inactivityTimeout",
            HttpTransportServerOptions {
                inactivity_timeout: Some(Duration::ZERO),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumWait",
            HttpTransportServerOptions {
                maximum_wait: Some(Duration::from_micros(500)),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumWait",
            HttpTransportServerOptions {
                maximum_wait: Some(NEVER),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "maximumOutboxBytes",
            HttpTransportServerOptions {
                maximum_outbox_bytes: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
    ] {
        let refused = HttpTransportServer::new(&options).expect_err(name);

        assert!(refused.to_string().starts_with(name), "{refused}");
    }

    for (exchange_timeout, inactivity_timeout, maximum_wait) in [
        (NEVER, NEVER, None),
        (
            Duration::from_millis(1),
            Duration::from_millis(1),
            Some(Duration::from_millis(1)),
        ),
    ] {
        HttpTransportServer::new(&HttpTransportServerOptions {
            exchange_timeout: Some(exchange_timeout),
            inactivity_timeout: Some(inactivity_timeout),
            maximum_wait,
            ..HttpTransportServerOptions::default()
        })
        .expect("taken");
    }
}

// spec 15.12
#[test]
fn refuses_as_it_is_built_a_hosts_entry_with_a_port_and_an_origins_entry_that_is_a_star_or_null() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let built = |hosts: &[&str], origins: &[&str]| {
        HttpTransportServer::new(&HttpTransportServerOptions {
            hosts: Some(hosts.iter().map(|host| (*host).to_owned()).collect()),
            origins: Some(origins.iter().map(|origin| (*origin).to_owned()).collect()),
            ..HttpTransportServerOptions::default()
        })
        .is_ok()
    };

    assert!(!built(&["bead.test:8080"], &[]), "a host with a port");
    assert!(!built(&["bead.test", "bead.test:8080"], &[]), "a second");
    assert!(!built(&["bead.test", "*"], &[]), "* beside a name");
    assert!(!built(&[], &["*"]), "an origin *");
    assert!(
        !built(&[], &["https://bead.test/"]),
        "an origin with a path"
    );
    assert!(
        !built(&["*"], &["https://bead.test", "null"]),
        "an origin null"
    );
    assert!(built(&["*"], &["https://bead.test"]), "taken");
}

#[tokio::test]
async fn keeps_a_connection_whose_refused_exchange_lost_its_socket_and_closes_one_whose_answer_could_not_be_written()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    // a refusal whose socket went before it was read
    let mut refused = RawSocket::on(port).await;

    refused
        .write(
            &Post {
                token: Some(&token),
                body: envelope_of(REQUEST, (2, 0)),
                ..Post::default()
            }
            .request(port),
        )
        .await
        .unwrap();
    refused.reset();
    rest(Duration::from_millis(100)).await;

    assert!(started.recorder.told().closes.is_empty(), "kept");

    // an answer its client does not take, then its socket gone
    let mut asked = RawSocket::on(port).await;

    asked
        .write(
            &Post {
                token: Some(&token),
                body: envelope_of(REQUEST, (1, 0)),
                ..Post::default()
            }
            .request(port),
        )
        .await
        .unwrap();
    asked.head(PATIENCE).await.expect("its head");

    let message = TransportMessage {
        data: Bytes::from(envelope_of(RESULT, (1, 33_554_432))),
        credential: None,
        address: None,
        port: None,
        may_overtake: false,
    };
    let Sent::Later(sending) = started.server.send(message, &handle).unwrap() else {
        panic!("an answer settles later");
    };

    asked.reset();

    let sent = patience(PATIENCE, sending).await.unwrap();

    assert!(
        sent.is_err_and(
            |error| error.to_string() == "the exchange closed before its answer went out"
        ),
        "its answer could not be written"
    );

    // a request that failed as it came lets go of what it held, and its connection is lost
    let mut broken = RawSocket::on(port).await;

    broken
        .write(chunked_head_of(port, &token).as_bytes())
        .await
        .unwrap();
    broken
        .write(&chunk_of(&envelope_of(REQUEST, (3, 0))))
        .await
        .unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    broken.reset();

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, handle)],
        "its connection lost"
    );
    until(|| gauge(&started.server, "bodyBytes") == 0).await;
    started.stop().await;
}

#[tokio::test]
async fn bounds_the_exchanges_under_way_on_one_connection_bodies_still_coming_included_and_closes_it_once_however_many_it_loses_after()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_waiting_exchanges: Some(1),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    // two bodies still coming, their prefix unread: under way, waiting for nothing yet
    let mut coming = Vec::new();

    for _ in 0..2 {
        let mut socket = RawSocket::on(port).await;

        socket
            .write(post_head_of(port, (&token, 16)).as_bytes())
            .await
            .unwrap();
        coming.push(socket);
    }

    rest(Duration::from_millis(50)).await;

    let third = raw_answer_of(port, post_head_of(port, (&token, 16)).as_bytes()).await;

    assert_eq!(
        (third.status, third.refusal),
        (429, Some(HTTP_REFUSALS.busy.to_owned())),
        "the third"
    );

    // closed, then each body's socket gone: the connection closes once
    started.server.close(&handle).await;

    for socket in coming {
        drop(socket);
    }

    rest(Duration::from_millis(100)).await;

    assert_eq!(
        started.recorder.told().closes,
        vec![(true, handle)],
        "closed once"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_the_socket_behind_a_refusal_of_a_body_it_will_not_read_over_http_1_alone() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let connection_of = async |fields: &[&str], body: &[u8]| {
        let mut request = head_of(("POST", "/bead"), (port, fields)).into_bytes();

        request.extend_from_slice(body);

        let answer = raw_answer_of(port, &request).await;

        (answer.refusal, answer.fields.get("connection").cloned())
    };

    // a 400 is a refusal too; and a body of no declared length, chunked, is a body all the same
    assert_eq!(
        vec![
            connection_of(&["Content-Type: text/plain", "Content-Length: 8"], &[7; 8]).await,
            connection_of(
                &["Content-Type: text/plain", "Transfer-Encoding: chunked"],
                b"8\r\n77777777\r\n0\r\n\r\n"
            )
            .await,
            connection_of(
                &[
                    &format!("Content-Type: {BEAD_MEDIA_TYPE}"),
                    &format!("{CONNECTION_TOKEN_HEADER}: not-a-token"),
                    "Content-Length: 8"
                ],
                &[7; 8]
            )
            .await,
        ],
        vec![
            (
                Some(HTTP_REFUSALS.type_refused.to_owned()),
                Some("close".to_owned())
            ),
            (
                Some(HTTP_REFUSALS.type_refused.to_owned()),
                Some("close".to_owned())
            ),
            (
                Some(HTTP_REFUSALS.malformed.to_owned()),
                Some("close".to_owned())
            ),
        ],
        "each closed"
    );
    started.stop().await;
}

#[tokio::test]
async fn bounds_its_connections_all_together_whichever_address_each_comes_from() {
    let started = started(&HttpTransportServerOptions {
        maximum_connections: Some(1),
        trusted_proxies: Some(vec![HOST.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let from = |address: &str| Post {
        fields: vec![format!("X-Forwarded-For: {address}")],
        ..Post::default()
    };

    assert_eq!(
        posted(started.port, &from("10.0.0.1")).await.head.status,
        201,
        "the first"
    );
    assert_eq!(
        refusal_of(&posted(started.port, &from("10.0.0.2")).await.head),
        (503, Some(HTTP_REFUSALS.busy.to_owned())),
        "another address's"
    );
    started.stop().await;
}

#[tokio::test]
async fn ends_a_request_whose_connection_closes_as_its_body_comes_with_the_marked_404_its_head_not_out_yet()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let envelope = envelope_of(REQUEST, (1, 8));
    let mut socket = RawSocket::on(started.port).await;

    socket
        .write(post_head_of(started.port, (&token, envelope.len())).as_bytes())
        .await
        .unwrap();
    socket.write(&envelope[..12]).await.unwrap();
    until(|| gauge(&started.server, "waitingExchanges") == 1).await;

    assert!(
        socket.head(Duration::from_millis(50)).await.is_none(),
        "nothing written yet"
    );

    started.server.close(&handle).await;

    let head = socket.head(PATIENCE).await.expect("its 404");

    assert_eq!(
        refusal_of(&head),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "its connection gone"
    );

    socket.write(&envelope[12..]).await.ok();

    assert!(socket.ended(PATIENCE).await, "its socket closed");
    assert_eq!(
        socket
            .reader
            .response()
            .map(|response| response.body.clone()),
        Some(Vec::new()),
        "its body empty"
    );
    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
    started.stop().await;
}

// ! an envelope read whole and its connection's DELETE: the envelope told before the close, or
// never, so the router never holds a connection closed
#[tokio::test]
async fn answers_the_marked_404_an_envelope_whose_connection_a_delete_closes_as_it_is_handed_on_and_tells_nothing_of_it_after_its_close()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let mut handles = Vec::new();

    for kind in [CANCEL, REQUEST] {
        let (handle, token) = connect(&started).await;

        // its connection paused, so its body read whole waits before it is handed on
        started.server.pause(&handle);

        let coming = asking(&started, (&token, envelope_of(kind, (1, 0)))).await;

        until(|| gauge(&started.server, "bodyBytes") == 8).await;

        let deleted = raw_answer_of(
            port,
            head_of(
                ("DELETE", "/bead"),
                (port, &[&format!("{CONNECTION_TOKEN_HEADER}: {token}")]),
            )
            .as_bytes(),
        )
        .await;

        assert_eq!(deleted.status, 204, "its DELETE");
        assert_eq!(
            refusal_of(&coming.head(PATIENCE).await.unwrap()),
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            "its envelope's exchange"
        );
        handles.push(handle);
    }

    let told = started.recorder.told();

    assert!(told.messages.is_empty(), "nothing handed on");
    assert_eq!(
        told.closes,
        handles
            .iter()
            .map(|handle| (true, Arc::clone(handle)))
            .collect::<Vec<_>>(),
        "each closed"
    );
    // the 404 that ends an exchange as its connection closes is no refusal its server judged
    assert!(told.refusals.is_empty(), "no refusal");
    assert_eq!(
        (
            gauge(&started.server, "connections"),
            gauge(&started.server, "waitingExchanges")
        ),
        (0, 0),
        "nothing kept"
    );
    started.stop().await;
}

#[tokio::test]
async fn answers_a_request_an_answer_comes_for_between_its_body_s_end_and_its_hand_on_never_handing_it_on()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;

    // its body read whole, held at its connection's gate
    started.server.pause(&handle);

    let coming = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    until(|| gauge(&started.server, "waitingExchanges") == 1).await;
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();

    let response = coming.response(PATIENCE).await.unwrap();

    assert_eq!(
        (response.head.status, response.body),
        (200, envelope_of(RESULT, (1, 0))),
        "answered as it waited"
    );

    started.server.resume(&handle);
    rest(Duration::from_millis(50)).await;

    assert!(
        started.recorder.told().messages.is_empty(),
        "never handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn keeps_the_socket_of_an_exchange_whose_connection_closed_as_its_body_came_read_whole_and_closes_the_one_of_a_refusal_whose_body_goes_unread()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let mut coming = RawSocket::on(port).await;
    let mut after = RawSocket::on(port).await;

    coming
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    coming.write(&envelope_of(CANCEL, (3, 0))).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    started.server.close(&handle).await;
    coming.write(&[0; 8]).await.unwrap();

    let head = coming.response(PATIENCE).await.expect("its 404").head;

    assert_eq!(
        (refusal_of(&head), head.fields.get("connection").cloned()),
        (
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            None
        ),
        "read whole, its socket kept"
    );

    after
        .write(post_head_of(port, (&token, 8)).as_bytes())
        .await
        .unwrap();
    after.write(&envelope_of(REQUEST, (1, 0))).await.ok();

    let head = after.head(PATIENCE).await.expect("its 404");

    assert_eq!(
        (refusal_of(&head), head.fields.get("connection").cloned()),
        (
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            Some("close".to_owned())
        ),
        "its body unread, its socket closed"
    );
    assert!(after.ended(PATIENCE).await, "closed");

    coming.next();
    coming
        .write(format!("GET /else HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes())
        .await
        .unwrap();

    assert_eq!(
        coming.head(PATIENCE).await.map(|head| head.status),
        Some(404),
        "a second exchange on its socket"
    );
    assert!(!coming.is_closed, "its socket kept");
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each refusal written whole, and the one told it awaits, as the other sides' twins hold them"
)]
#[tokio::test]
async fn tells_each_refusal_it_judges_of_its_own_its_status_its_reason_the_request_s_authority_and_origin_and_the_client_s_address_and_port_and_nothing_of_http_s_own()
 {
    let started = started(&HttpTransportServerOptions {
        hosts: Some(vec!["bead.test".to_owned()]),
        maximum_body_bytes: Some(16),
        trusted_proxies: Some(vec![HOST.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let own = format!("{HOST}:{port}");
    let cases: Vec<(String, Mark<'_>, Told<'_>)> = vec![
        (
            "POST /bead HTTP/1.1\r\nHost: rebind.example:8080\r\nOrigin: http://a.example\r\nOrigin: http://b.example\r\nContent-Length: 0\r\n\r\n".to_owned(),
            (403, HTTP_REFUSALS.host),
            (Some("rebind.example:8080"), Some("http://a.example, http://b.example")),
        ),
        (
            format!("POST http://rebind.example/bead HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            (403, HTTP_REFUSALS.host),
            (Some("rebind.example"), None),
        ),
        (
            "POST /bead HTTP/1.1\r\nHost: \r\nContent-Length: 0\r\n\r\n".to_owned(),
            (403, HTTP_REFUSALS.host),
            (Some(""), None),
        ),
        (
            "POST /bead HTTP/1.0\r\nContent-Length: 0\r\n\r\n".to_owned(),
            (403, HTTP_REFUSALS.host),
            (None, None),
        ),
        (
            format!("POST /other HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            (404, HTTP_REFUSALS.path),
            (Some(&own), None),
        ),
        (
            format!("POST /bead HTTP/1.1\r\nHost: {own}\r\nOrigin: http://elsewhere.example\r\nContent-Length: 0\r\n\r\n"),
            (403, HTTP_REFUSALS.origin),
            (Some(&own), Some("http://elsewhere.example")),
        ),
        (
            format!("PUT /bead HTTP/1.1\r\nHost: {own}\r\nContent-Length: 0\r\n\r\n"),
            (405, HTTP_REFUSALS.method),
            (Some(&own), None),
        ),
        (
            format!("POST /bead HTTP/1.1\r\nHost: {own}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n"),
            (415, HTTP_REFUSALS.type_refused),
            (Some(&own), None),
        ),
        (
            format!(
                "POST /bead HTTP/1.1\r\nHost: {own}\r\n{CONNECTION_TOKEN_HEADER}: {UNKNOWN_TOKEN}\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
            ),
            (404, HTTP_REFUSALS.connection_unknown),
            (Some(&own), None),
        ),
    ];
    let mut expected = Vec::new();

    for (head, (status, reason), (authority, origin)) in &cases {
        let answer = raw_answer_of(port, head.as_bytes()).await;

        assert_eq!(
            (answer.status, answer.refusal.as_deref()),
            (*status, Some(*reason)),
            "{head}"
        );

        let mut refusal = TransportServerRefusal::new(*status, *reason);

        refusal.address = Some(HOST.to_owned());
        refusal.authority = authority.map(str::to_owned);
        refusal.origin = origin.map(str::to_owned);
        refusal.port = Some(answer.local_port);
        expected.push(refusal);
    }

    // a body refused as it comes, past its bound, from behind a proxy it trusts
    let (handle, token) = connect(&started).await;
    let mut large = RawSocket::on(port).await;

    large
        .write(chunked_head_of(port, &token).as_bytes())
        .await
        .unwrap();
    large.write(&chunk_of(&[0; 17])).await.unwrap();

    let local_port = large.socket.local_addr().unwrap().port();

    assert_eq!(
        large.head(PATIENCE).await.map(|head| head.status),
        Some(413),
        "past its bound"
    );

    let mut refusal = TransportServerRefusal::new(413, HTTP_REFUSALS.too_large);

    refusal.address = Some(HOST.to_owned());
    refusal.authority = Some(own.clone());
    refusal.port = Some(local_port);
    expected.push(refusal);

    // what HTTP refuses of its own, told by none: a colon with no port, two hosts, an octet past
    // ASCII
    for head in [
        "POST /bead HTTP/1.1\r\nHost: localhost:\r\nContent-Length: 0\r\n\r\n",
        "POST /bead HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\nContent-Length: 0\r\n\r\n",
        "POST /bead HTTP/1.1\r\nHost: bead.test\r\nX-Other: caf\u{e9}\r\nContent-Length: 0\r\n\r\n",
    ] {
        let answer = raw_answer_of(port, &crate::testing::wire::latin1_of(head).unwrap()).await;

        assert_eq!((answer.status, answer.refusal), (400, None), "{head}");
    }

    // nor what is no refusal: a DELETE
    raw_answer_of(
        port,
        head_of(
            ("DELETE", "/bead"),
            (port, &[&format!("{CONNECTION_TOKEN_HEADER}: {token}")]),
        )
        .as_bytes(),
    )
    .await;

    // behind a proxy it trusts, the client's address the walk reaches
    let behind = raw_answer_of(
        port,
        format!(
            "POST /bead HTTP/1.1\r\nHost: rebind.example\r\nX-Forwarded-For: 203.0.113.9\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;
    let mut refusal = TransportServerRefusal::new(403, HTTP_REFUSALS.host);

    refusal.address = Some("203.0.113.9".to_owned());
    refusal.authority = Some("rebind.example".to_owned());
    refusal.port = Some(behind.local_port);
    expected.push(refusal);

    assert_eq!(
        started.recorder.refusals(expected.len()).await,
        expected,
        "each refusal told"
    );
    assert_eq!(
        started.recorder.told().closes,
        vec![(true, handle)],
        "its DELETE alone closed"
    );
    started.stop().await;
}

#[tokio::test]
async fn refuses_as_it_would_though_a_refusal_listener_throws_the_throw_reported_with_no_connection()
 {
    let started = started_behind(
        Arc::new(Throwing {
            on_refusal: true,
            ..Throwing::default()
        }),
        &HttpTransportServerOptions::default(),
    )
    .await;
    let port = started.port;
    let origin = posted(
        port,
        &Post {
            fields: vec!["Origin: http://elsewhere.example".to_owned()],
            ..Post::default()
        },
    )
    .await;
    let path = raw_answer_of(
        port,
        head_of(("POST", "/bead/other"), (port, &["Content-Length: 0"])).as_bytes(),
    )
    .await;
    let unknown = posted(
        port,
        &Post {
            token: Some(UNKNOWN_TOKEN),
            ..Post::default()
        },
    )
    .await;

    assert_eq!(
        vec![
            refusal_of(&origin.head),
            (path.status, path.refusal),
            refusal_of(&unknown.head)
        ],
        vec![
            (403, Some(HTTP_REFUSALS.origin.to_owned())),
            (404, Some(HTTP_REFUSALS.path.to_owned())),
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        ],
        "each refused"
    );
    assert_eq!(
        started
            .recorder
            .refusals(3)
            .await
            .iter()
            .map(|refusal| refusal.reason.clone())
            .collect::<Vec<_>>(),
        [
            HTTP_REFUSALS.origin,
            HTTP_REFUSALS.path,
            HTTP_REFUSALS.connection_unknown
        ]
        .map(str::to_owned),
        "a listener after it told all the same"
    );
    assert_eq!(
        started.recorder.errors(3).await,
        vec![
            (
                "a listener panicked: a refusal listener that throws".to_owned(),
                None
            );
            3
        ],
        "each throw reported with no connection"
    );
    // and it draws a connection as before
    assert_eq!(
        posted(port, &Post::default()).await.head.status,
        201,
        "a connect"
    );
    started.stop().await;
}

#[tokio::test]
async fn loses_an_answer_whose_client_reads_slower_than_minimum_send_bytes_per_second_its_connection_closed_at_both_ends_and_reports_it()
 {
    let started = started(&HttpTransportServerOptions {
        minimum_send_bytes_per_second: Some(1_000_000_000),
        send_grace_period: Some(Duration::from_millis(200)),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let mut asked = RawSocket::reading_little(port).await;

    asked
        .write(
            &Post {
                token: Some(&token),
                body: envelope_of(REQUEST, (1, 0)),
                ..Post::default()
            }
            .request(port),
        )
        .await
        .unwrap();
    started.recorder.messages(1).await;

    // * its client takes nothing of an answer larger than what a loopback's buffers hold
    let message = TransportMessage {
        data: Bytes::from(envelope_of(RESULT, (1, 67_108_864))),
        credential: None,
        address: None,
        port: None,
        may_overtake: false,
    };
    let Sent::Later(sending) = started.server.send(message, &handle).unwrap() else {
        panic!("an answer settles later");
    };

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "its connection dropped"
    );
    assert_eq!(
        started.recorder.told().errors,
        vec![(
            format!(
                "{handle} is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 1000000000 past sendGracePeriod 200 ms"
            ),
            Some(Arc::clone(&handle))
        )],
        "reported"
    );
    // its exchange lost at its client's end, its connection gone at the server's
    assert!(
        patience(PATIENCE, sending).await.unwrap().is_err(),
        "its answer lost"
    );

    let after = posted_on(&started, (&token, envelope_of(REQUEST, (3, 0)))).await;

    assert_eq!(
        refusal_of(&after.head),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "its connection gone"
    );
    drop(asked);
    started.stop().await;
}

#[tokio::test]
async fn keeps_an_answer_whose_client_takes_it_within_its_deadline_and_times_nothing_once_it_is_taken()
 {
    let started = started(&HttpTransportServerOptions {
        minimum_send_bytes_per_second: Some(240),
        send_grace_period: Some(Duration::from_millis(200)),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (handle, token) = connect(&started).await;
    let answered = asking(&started, (&token, envelope_of(REQUEST, (1, 0)))).await;

    started.recorder.messages(1).await;
    started
        .send(&envelope_of(RESULT, (1, 1_048_576)), &handle)
        .await
        .unwrap();

    assert_eq!(
        answered.response(PATIENCE).await.unwrap().body.len(),
        1_048_584,
        "taken whole"
    );

    // past what its grace and its rate would have judged, nothing was dropped
    rest(Duration::from_millis(1_200)).await;

    let told = started.recorder.told();

    assert!(
        told.errors.is_empty() && told.closes.is_empty(),
        "nothing dropped"
    );
    started.stop().await;
}

#[tokio::test]
async fn answers_408_a_head_that_does_not_come_whole_within_headers_timeout_at_its_address_and_its_web_socket_s_past_it_and_within_2_seconds_of_it()
 {
    let started = started(&HttpTransportServerOptions {
        headers_timeout: Some(Duration::from_millis(500)),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let web_socket = crate::websocket::server::WebSocketTransportServer::new(
        &crate::WebSocketTransportServerOptions {
            headers_timeout: Some(Duration::from_millis(500)),
            ..crate::WebSocketTransportServerOptions::default()
        },
    )
    .unwrap();
    let web_socket_port = web_socket
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap()
        .port;

    for (port, head) in [
        (
            started.port,
            format!("POST /bead HTTP/1.1\r\nHost: {HOST}\r\n"),
        ),
        (
            web_socket_port,
            format!("GET / HTTP/1.1\r\nHost: {HOST}\r\n"),
        ),
    ] {
        let mut socket = RawSocket::on(port).await;
        let sent_at = crate::testing::Instant::now();

        socket.write(head.as_bytes()).await.unwrap();

        let answered = socket.head(Duration::from_secs(5)).await.expect("its 408");
        let took = sent_at.elapsed();

        assert_eq!(refusal_of(&answered), (408, None), "{head}");
        assert!(
            took >= Duration::from_millis(450) && took < Duration::from_millis(2_000),
            "{head}: {took:?}"
        );
    }

    web_socket.stop().await.unwrap();
    started.stop().await;
}

#[test]
fn refuses_a_headers_timeout_a_send_grace_period_a_body_grace_period_a_minimum_send_bytes_per_second_or_a_minimum_body_bytes_per_second_it_cannot_hold_as_it_is_built()
 {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();

    // a rate of 1.5, which the other sides refuse, is none here: a rate is a whole number by its
    // type
    for (name, options) in [
        (
            "headersTimeout",
            HttpTransportServerOptions {
                headers_timeout: Some(Duration::ZERO),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "sendGracePeriod",
            HttpTransportServerOptions {
                send_grace_period: Some(NEVER),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "bodyGracePeriod",
            HttpTransportServerOptions {
                body_grace_period: Some(Duration::ZERO),
                ..HttpTransportServerOptions::default()
            },
        ),
        (
            "minimumBodyBytesPerSecond",
            HttpTransportServerOptions {
                minimum_body_bytes_per_second: Some(0),
                ..HttpTransportServerOptions::default()
            },
        ),
    ] {
        let refused = HttpTransportServer::new(&options).expect_err(name);

        assert!(refused.to_string().starts_with(name), "{refused}");
    }

    assert_eq!(
        HttpTransportServer::new(&HttpTransportServerOptions {
            minimum_body_bytes_per_second: Some(0),
            ..HttpTransportServerOptions::default()
        })
        .unwrap_err()
        .to_string(),
        "minimumBodyBytesPerSecond is a whole number above 0, not 0",
        "its words"
    );
}
