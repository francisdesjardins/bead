//! Where an HTTP transport server listens, its stop, its pause, and the timers of its connections,
//! the twin of the rest of `http-transport-server.test.ts` and `HttpTransportServerTests`.

use core::time::Duration;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;

use super::super::{Answered, HttpTransportServer, HttpTransportServerOptions, judged};
use crate::NEVER;
use crate::failure::ProcedureAddress;
use crate::http::fields::{BEAD_MEDIA_TYPE, CONNECTION_TOKEN_HEADER, HTTP_REFUSALS};
use crate::http::peer::*;
use crate::router::types::{ConnectionHandle, RouterError};
use crate::testing::{SteppingClock, rest};
use crate::transport::{ReadyState, ServerListener, ServerTransport, TransportServerStartOptions};

// a server listening at `address`, on a port the system drew
async fn started_at(
    address: Option<&str>,
    options: &HttpTransportServerOptions,
) -> Result<Started, RouterError> {
    let server = HttpTransportServer::new(options).unwrap();
    let recorder = Arc::new(Recorder::default());

    server.listen(Arc::<Recorder>::clone(&recorder));

    let bound = server
        .start(&TransportServerStartOptions {
            address: address.map(str::to_owned),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await?;

    Ok(Started {
        server,
        recorder,
        port: bound.port,
    })
}

// a server on a stepping clock, its options besides
async fn stepped(clock: &Arc<SteppingClock>, options: &HttpTransportServerOptions) -> Started {
    started(&HttpTransportServerOptions {
        clock: Some(Arc::<SteppingClock>::clone(clock)),
        ..options.clone()
    })
    .await
}

// what a request built as `build` says is judged, from the loopback, as one that came would be
fn judging(server: &HttpTransportServer, build: ::http::request::Builder) -> Answered {
    let (parts, ()) = build.body(()).unwrap().into_parts();

    judged(server, (&parts, SocketAddr::from(([127, 0, 0, 1], 40_000))))
}

// the status and the mark of what was judged
async fn status_of(answered: Answered) -> (u16, Option<String>) {
    let response = answered.await.unwrap();

    (
        response.status().as_u16(),
        response
            .headers()
            .get(REFUSAL_HEADER)
            .map(|value| value.to_str().unwrap().to_owned()),
    )
}

// a listener that does `heard` with each close, the server at hand
struct Closing<F: Fn(&HttpTransportServer, &ConnectionHandle) + Send + Sync> {
    server: HttpTransportServer,
    heard: F,
}

impl<F: Fn(&HttpTransportServer, &ConnectionHandle) + Send + Sync> ServerListener for Closing<F> {
    fn on_close(&self, _was_clean: bool, connection_handle: &ConnectionHandle) {
        (self.heard)(&self.server, connection_handle);
    }
}

// a listener of closes that throws
struct ThrowingOnClose;

impl ServerListener for ThrowingOnClose {
    fn on_close(&self, _was_clean: bool, _connection_handle: &ConnectionHandle) {
        panic!("a close listener that throws");
    }
}

// spec 9.11
#[tokio::test]
async fn an_http_server_transport_takes_the_procedures_it_is_given() {
    let started = started(&HttpTransportServerOptions {
        procedures: Some(vec![ProcedureAddress {
            service_id: 2,
            procedure_id: 1,
        }]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (handle, _) = connect(&started).await;

    assert_eq!(
        [
            started.server.takes_procedure(
                &handle,
                ProcedureAddress {
                    service_id: 2,
                    procedure_id: 1
                }
            ),
            started.server.takes_procedure(
                &handle,
                ProcedureAddress {
                    service_id: 2,
                    procedure_id: 2
                }
            ),
            started.server.takes_procedure(
                &handle,
                ProcedureAddress {
                    service_id: 3,
                    procedure_id: 1
                }
            ),
        ],
        [true, false, false],
        "the one given"
    );
    assert!(started.server.names_procedures(), "it names them");
    // given none, it names none: its router never asks
    assert!(
        !HttpTransportServer::new(&HttpTransportServerOptions::default())
            .unwrap()
            .names_procedures(),
        "none named"
    );
    started.stop().await;
}

// spec 15.5.2, 15.6.13, 15.12.17
#[tokio::test]
async fn hands_on_no_envelope_of_a_paused_connection_its_204_going_once_handed_on_and_429_busy_with_retry_after_past_the_exchanges_under_way()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_waiting_exchanges: Some(2),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let post_of = |envelope: Vec<u8>| Post {
        token: Some(&token),
        body: envelope,
        ..Post::default()
    };

    started.server.pause(&handle);

    // * four under way, twice the requests that may wait: each read whole, and held at its gate
    let request = posting(port, &post_of(envelope_of(REQUEST, (1, 0)))).await;

    until(|| gauge(&started.server, "bodyBytes") == 8).await;

    let mut cancels = Vec::new();

    for call_id in [9, 11, 13] {
        cancels.push(posting(port, &post_of(envelope_of(CANCEL, (call_id, 0)))).await);
        until(|| gauge(&started.server, "bodyBytes") >= 8 * (u64::from(call_id) - 5) / 2).await;
    }

    until(|| gauge(&started.server, "bodyBytes") == 32).await;
    rest(Duration::from_millis(50)).await;

    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
    assert!(
        request.head(Duration::from_millis(10)).await.is_err(),
        "nothing answered"
    );

    // past the exchanges under way: busy, told when to come back
    let crowded = posted(port, &post_of(envelope_of(CANCEL, (15, 0)))).await;

    assert_eq!(
        (
            refusal_of(&crowded.head),
            crowded.head.fields.get("retry-after").cloned()
        ),
        (
            (429, Some(HTTP_REFUSALS.busy.to_owned())),
            Some("1".to_owned())
        ),
        "crowded"
    );

    started.server.resume(&handle);

    // handed on in order, each non-request's 204 once it was, the request's head once it was
    for cancel in &cancels {
        assert_eq!(cancel.head(PATIENCE).await.unwrap().status, 204, "a cancel");
    }

    assert_eq!(
        request.head(PATIENCE).await.unwrap().status,
        200,
        "the request"
    );
    assert_eq!(
        started
            .recorder
            .messages(4)
            .await
            .iter()
            .map(|(message, _)| u32::from_be_bytes(message.data[4..8].try_into().unwrap()))
            .collect::<Vec<_>>(),
        vec![1, 9, 11, 13],
        "in order"
    );
    assert_eq!(gauge(&started.server, "bodyBytes"), 0, "nothing held");
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();
    request.response(PATIENCE).await.unwrap();
    started.stop().await;
}

// spec 15.12.17
#[tokio::test]
async fn tells_an_exchange_held_at_the_gate_of_a_paused_connection_that_its_connection_is_gone_as_it_closes()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;

    started.server.pause(&handle);

    let held = posting(
        started.port,
        &Post {
            token: Some(&token),
            body: envelope_of(CANCEL, (9, 0)),
            ..Post::default()
        },
    )
    .await;

    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    started.server.close(&handle).await;

    // * what waited at its gate goes with it, its charge released, and nothing of it handed on
    assert_eq!(
        refusal_of(&held.head(PATIENCE).await.unwrap()),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "gone"
    );
    assert_eq!(
        (
            started.recorder.told().messages.len(),
            gauge(&started.server, "bodyBytes")
        ),
        (0, 0),
        "nothing handed on or held"
    );
    started.stop().await;
}

#[tokio::test]
async fn stops_with_a_client_keeping_its_socket_alive_each_waiting_exchange_cut() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let waiting = posting(
        port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    waiting.head(PATIENCE).await.unwrap();

    let mut coming = RawSocket::on(port).await;

    coming
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    coming.write(&[0xA1, 0x10]).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 2).await;

    let began = crate::testing::Instant::now();

    started.stop().await;

    assert!(began.elapsed() < Duration::from_secs(5), "stopped at once");
    assert!(coming.ended(PATIENCE).await, "its socket closed");
    assert_eq!(
        started.recorder.told().closes,
        vec![(false, handle)],
        "its close"
    );
    assert!(
        waiting.response(PATIENCE).await.is_err(),
        "its exchange cut"
    );
    assert_eq!(started.server.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(
        started
            .server
            .start(&TransportServerStartOptions {
                address: Some(HOST.to_owned()),
                port: Some(port),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap()
            .port,
        port,
        "its port free again"
    );
    started.stop().await;
}

#[tokio::test]
async fn stops_though_a_close_listener_throws_each_connection_still_ends_its_close_told_the_throw_reported()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (first, _) = connect(&started).await;
    let (second, _) = connect(&started).await;
    let recorder = Arc::new(Recorder::default());

    started.server.listen(Arc::new(ThrowingOnClose));
    started.server.listen(Arc::<Recorder>::clone(&recorder));
    started.stop().await;

    let told = recorder.told();
    let mut closes = told.closes;
    let mut errors = told.errors;

    closes.sort();
    errors.sort();

    let mut expected = vec![(false, Arc::clone(&first)), (false, Arc::clone(&second))];

    expected.sort();

    assert_eq!(closes, expected, "each told");
    assert_eq!(
        errors,
        expected
            .iter()
            .map(|(_, handle)| (
                "a listener panicked: a close listener that throws".to_owned(),
                Some(Arc::clone(handle))
            ))
            .collect::<Vec<_>>(),
        "each throw reported"
    );
    assert_eq!(started.server.ready_state(), ReadyState::Closed, "closed");
    assert!(
        started
            .server
            .gauges()
            .unwrap()
            .connection_handles
            .is_empty(),
        "none kept"
    );
}

#[tokio::test]
async fn closes_a_connection_idle_past_its_timeout_though_a_close_listener_throws_the_throw_reported()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let (handle, _) = connect(&started).await;
    let recorder = Arc::new(Recorder::default());

    started.server.listen(Arc::new(ThrowingOnClose));
    started.server.listen(Arc::<Recorder>::clone(&recorder));
    clock.advance(Duration::from_secs(2)).await;

    let told = recorder.told();

    assert!(started.server.clients().is_empty(), "closed");
    assert_eq!(
        (told.closes, told.errors),
        (
            vec![(false, Arc::clone(&handle))],
            vec![(
                "a listener panicked: a close listener that throws".to_owned(),
                Some(handle)
            )]
        ),
        "its close, and the throw"
    );
    assert_eq!(
        (
            gauge(&started.server, "connections"),
            gauge(&started.server, "addresses")
        ),
        (0, 0),
        "none kept"
    );
    started.stop().await;
}

#[tokio::test]
async fn refuses_a_connect_that_comes_as_it_stops_busy_told_when_to_come_back_drawing_nothing() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, _) = connect(&started).await;
    let judged_as_it_stops: Arc<Mutex<Vec<(Answered, u64)>>> = Arc::default();
    let kept = Arc::clone(&judged_as_it_stops);

    started.server.listen(Arc::new(Closing {
        server: started.server.clone(),
        heard: move |server: &HttpTransportServer, _: &ConnectionHandle| {
            let connections = gauge(server, "connections");
            let mut kept = kept.lock().unwrap();

            for (content_type, length) in [
                (BEAD_MEDIA_TYPE, "0"),
                ("text/plain", "0"),
                (BEAD_MEDIA_TYPE, "5"),
            ] {
                kept.push((
                    judging(
                        server,
                        ::http::Request::post("/bead")
                            .header("host", HOST)
                            .header("content-type", content_type)
                            .header("content-length", length),
                    ),
                    connections,
                ));
            }
        },
    }));
    started.stop().await;

    let judged: Vec<(Answered, u64)> = core::mem::take(&mut *judged_as_it_stops.lock().unwrap());
    let mut answers = Vec::new();

    for (answered, connections) in judged {
        answers.push((status_of(answered).await, connections));
    }

    assert_eq!(
        answers,
        vec![
            ((503, Some(HTTP_REFUSALS.busy.to_owned())), 0),
            ((415, Some(HTTP_REFUSALS.type_refused.to_owned())), 0),
            ((400, Some(HTTP_REFUSALS.malformed.to_owned())), 0),
        ],
        "busy, and its other refusals as they were"
    );

    let told = started.recorder.told();

    assert_eq!(
        (told.connections, told.closes),
        (vec![Arc::clone(&handle)], vec![(false, handle)]),
        "nothing more drawn"
    );
    assert_eq!(started.server.ready_state(), ReadyState::Closed, "closed");
}

#[expect(
    clippy::too_many_lines,
    reason = "each exchange judged as it stops, as the other sides' twins judge them"
)]
#[tokio::test]
async fn answers_the_404_marked_connection_unknown_an_exchange_that_comes_as_it_stops_its_connection_not_yet_closed_nothing_handed_on()
 {
    let started = started(&HttpTransportServerOptions {
        origins: Some(vec!["https://app.example".to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (first, _) = connect(&started).await;
    let (second, second_token) = connect(&started).await;
    let judged_as_it_stops: Arc<Mutex<Vec<Answered>>> = Arc::default();
    let held: Arc<Mutex<Option<bool>>> = Arc::default();
    let (kept, seen) = (Arc::clone(&judged_as_it_stops), Arc::clone(&held));
    let (closing, token) = (Arc::clone(&first), second_token.clone());

    started.server.listen(Arc::new(Closing {
        server: started.server.clone(),
        heard: move |server: &HttpTransportServer, handle: &ConnectionHandle| {
            if *handle != closing {
                return;
            }

            let mut kept = kept.lock().unwrap();
            let on = |fields: &[(&str, &str)]| {
                let mut request = ::http::Request::post("/bead")
                    .header("host", HOST)
                    .header("content-type", BEAD_MEDIA_TYPE);

                for (name, value) in fields {
                    request = request.header(*name, *value);
                }

                request
            };

            *seen.lock().unwrap() = Some(
                server
                    .clients()
                    .iter()
                    .any(|client| client.connection_handle == second),
            );
            kept.push(judging(
                server,
                on(&[(CONNECTION_TOKEN_HEADER, &token), ("content-length", "8")]),
            ));
            kept.push(judging(
                server,
                on(&[(CONNECTION_TOKEN_HEADER, "not-a-token")]),
            ));
            kept.push(judging(
                server,
                on(&[
                    (CONNECTION_TOKEN_HEADER, &token),
                    ("origin", "https://elsewhere.example"),
                ]),
            ));
            kept.push(judging(
                server,
                ::http::Request::post("/bead")
                    .header("host", HOST)
                    .header("content-type", "text/plain")
                    .header(CONNECTION_TOKEN_HEADER, &*token),
            ));
            kept.push(judging(
                server,
                on(&[
                    (CONNECTION_TOKEN_HEADER, &token),
                    ("authorization", "Bearer a"),
                    ("authorization", "Bearer b"),
                ]),
            ));
            kept.push(judging(
                server,
                on(&[
                    (CONNECTION_TOKEN_HEADER, &token),
                    ("content-length", "2147483648"),
                ]),
            ));
            kept.push(judging(
                server,
                ::http::Request::get("/bead")
                    .header("host", HOST)
                    .header(CONNECTION_TOKEN_HEADER, &*token)
                    .header("bead-after", "x"),
            ));
        },
    }));
    started.stop().await;

    let judged: Vec<Answered> = core::mem::take(&mut *judged_as_it_stops.lock().unwrap());
    let mut answers = Vec::new();

    for answered in judged {
        answers.push(status_of(answered).await);
    }

    let unknown = (404, Some(HTTP_REFUSALS.connection_unknown.to_owned()));

    assert_eq!(
        *held.lock().unwrap(),
        Some(true),
        "its connection not yet closed"
    );
    assert_eq!(
        answers,
        vec![
            unknown.clone(),
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
            (403, Some(HTTP_REFUSALS.origin.to_owned())),
            unknown.clone(),
            unknown.clone(),
            unknown.clone(),
            unknown,
        ],
        "each as its connection is gone"
    );
    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
}

#[tokio::test]
async fn answers_each_listen_it_holds_the_marked_404_as_it_stops_however_many() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let mut held = Vec::new();

    for _ in 0..32 {
        let (_, token) = connect_listening(&started).await;

        held.push(listen_of(started.port, (&token, (Some("0"), Some("20000")))).await);
    }

    until(|| gauge(&started.server, "listens") == 32).await;
    started.stop().await;

    for listen in &held {
        assert_eq!(
            refusal_of(&listen.head(PATIENCE).await.unwrap()),
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            "each listen"
        );
    }
}

#[tokio::test]
async fn is_secure_as_its_application_says_what_stands_in_front_of_it_whatever_it_listens_on_and_by_what_it_listens_on_when_it_says_nothing()
 {
    for (secure, is_secure) in [(Some(false), false), (Some(true), true), (None, true)] {
        let started = started(&HttpTransportServerOptions {
            secure,
            ..HttpTransportServerOptions::default()
        })
        .await;
        let (handle, _) = connect(&started).await;
        let nobody: ConnectionHandle = Arc::from("type=HTTP;ip=127.0.0.1;ordinal=99");

        assert_eq!(
            started.server.is_secure(&handle),
            is_secure,
            "told {secure:?}"
        );
        assert!(
            !started.server.is_secure(&nobody),
            "a handle it does not hold"
        );
        assert!(
            !started.server.carries_credential(&handle),
            "no credential toward a connection"
        );
        started.stop().await;
    }
}

#[tokio::test]
async fn listens_on_the_port_it_was_asked_for() {
    let port = std::net::TcpListener::bind((HOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
    let bound = server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            port: Some(port),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    assert_eq!(
        (bound.address.as_str(), bound.port),
        (HOST, port),
        "where it listens"
    );
    assert_eq!(server.ready_state(), ReadyState::Open, "open");
    server.stop().await.unwrap();
}

#[tokio::test]
async fn an_error_before_listening_or_an_abort_rejects_the_start_and_closes_what_was_opened() {
    let holder = std::net::TcpListener::bind((HOST, 0)).unwrap();
    let port = holder.local_addr().unwrap().port();
    let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
    let refused = server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            port: Some(port),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap_err();
    let RouterError::Other(error) = refused else {
        panic!("an io error");
    };

    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::AddrInUse),
        "its port held"
    );
    assert_eq!(server.ready_state(), ReadyState::Closed, "closed");

    let signal = CancellationToken::new();

    signal.cancel();

    let aborted = server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            signal: Some(signal),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap_err();

    assert_eq!(aborted.to_string(), "the start was cancelled", "aborted");
    assert_eq!(server.ready_state(), ReadyState::Closed, "closed again");
    drop(holder);
    server
        .start(&TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            port: Some(port),
            ..TransportServerStartOptions::default()
        })
        .await
        .expect("started again");
    server.stop().await.unwrap();
}

#[tokio::test]
async fn takes_a_client_s_address_from_x_forwarded_for_only_from_a_proxy_it_names_and_bounds_the_connections_of_each_address()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_connections_per_address: Some(1),
        trusted_proxies: Some(vec![HOST.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let draw_of = async |forwarded: &str| {
        let response = posted(
            started.port,
            &Post {
                fields: vec![format!("X-Forwarded-For: {forwarded}")],
                ..Post::default()
            },
        )
        .await;
        let handle = started
            .server
            .clients()
            .last()
            .map(|client| client.connection_handle.to_string());

        (response.head.status, handle)
    };

    assert_eq!(
        draw_of("203.0.113.9, 198.51.100.7").await,
        (201, Some("type=HTTP;ip=198.51.100.7;ordinal=1".to_owned())),
        "the entry the walk reaches"
    );
    // one address, one connection
    assert_eq!(draw_of("198.51.100.7").await.0, 503, "its second");
    // what is no address is not taken
    assert_eq!(
        draw_of("evil;ordinal=1").await,
        (201, Some("type=HTTP;ip=127.0.0.1;ordinal=2".to_owned())),
        "no address"
    );
    assert_eq!(draw_of("1").await.0, 503, "the proxy's own, its second");
    started.stop().await;

    // nor what a peer it does not name forwards
    let untrusted = started_at(
        Some(HOST),
        &HttpTransportServerOptions {
            trusted_proxies: Some(vec!["10.0.0.3".to_owned()]),
            ..HttpTransportServerOptions::default()
        },
    )
    .await
    .unwrap();

    posted(
        untrusted.port,
        &Post {
            fields: vec!["X-Forwarded-For: 192.0.2.1".to_owned()],
            ..Post::default()
        },
    )
    .await;

    assert_eq!(untrusted.server.clients()[0].address, HOST, "its socket's");
    untrusted.stop().await;
}

#[tokio::test]
async fn names_a_client_that_comes_over_ipv4_to_a_dual_stack_listener_by_its_ipv4_address() {
    let Ok(started) = started_at(Some("::"), &HttpTransportServerOptions::default()).await else {
        // no IPv6 here
        return;
    };
    let (handle, _) = connect(&started).await;

    assert!(
        handle.starts_with("type=HTTP;ip=127.0.0.1;ordinal="),
        "its IPv4 address: {handle}"
    );
    assert_eq!(started.server.clients()[0].address, HOST, "its address");
    started.stop().await;
}

#[tokio::test]
async fn lets_a_burial_lapse_buries_only_the_client_s_call_ids_and_so_many_of_them_and_answers_a_body_still_coming_as_its_connection_closes()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            body_grace_period: Some(Duration::from_secs(6)),
            inactivity_timeout: Some(NEVER),
            maximum_waiting_exchanges: Some(2),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let post_of = |envelope: Vec<u8>| Post {
        token: Some(&token),
        body: envelope,
        ..Post::default()
    };

    assert_eq!(
        posted(port, &post_of(envelope_of(CANCEL, (5, 0))))
            .await
            .head
            .status,
        204,
        "the first cancel"
    );
    assert_eq!(gauge(&started.server, "buriedCallIds"), 1, "buried");
    assert_eq!(clock.dues(), vec![Duration::from_secs(5)], "for 5 seconds");

    clock.advance(Duration::from_secs(5)).await;

    assert_eq!(gauge(&started.server, "buriedCallIds"), 0, "lapsed");

    for call_id in [2, 7, 9, 11] {
        assert_eq!(
            posted(port, &post_of(envelope_of(CANCEL, (call_id, 0))))
                .await
                .head
                .status,
            204,
            "a cancel of {call_id}"
        );
    }

    assert_eq!(
        gauge(&started.server, "buriedCallIds"),
        2,
        "so many as may wait"
    );

    let late = posting(port, &post_of(envelope_of(REQUEST, (5, 0)))).await;

    // its head, once it waited 40 ms for its answer (spec 15.7)
    head_delayed(&clock).await;

    assert_eq!(
        late.head(PATIENCE).await.unwrap().status,
        200,
        "its burial lapsed"
    );

    let mut coming = RawSocket::on(port).await;

    coming
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    coming.write(&envelope_of(CANCEL, (13, 0))).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    started.server.close(&handle).await;
    coming.write(&[0; 8]).await.unwrap();

    assert!(
        late.response(PATIENCE).await.is_err(),
        "the late request cut"
    );
    assert_eq!(
        refusal_of(&coming.head(PATIENCE).await.unwrap()),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "the body still coming"
    );
    assert_eq!(
        started.recorder.told().closes,
        vec![(true, handle)],
        "closed"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_as_lost_a_connection_whose_request_waited_past_its_timeout_and_one_idle_past_its_own_never_while_an_exchange_is_under_way()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            exchange_timeout: Some(Duration::from_secs(1)),
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let (unanswered, token) = connect(&started).await;
    let (idle, _) = connect(&started).await;
    let asking = posting(
        started.port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;
    let head_delay = Duration::from_millis(40);

    // its exchange timer counts from its hand-off, its head's 40 ms first (spec 15.7)
    until(|| clock.dues().contains(&head_delay)).await;

    let mut dues = clock.dues();

    dues.sort();

    assert_eq!(
        dues,
        vec![head_delay, Duration::from_secs(2)],
        "its head's delay, and the idle one's rest"
    );

    // its head goes, and the rest of its timeout is armed
    clock.advance(head_delay).await;
    asking.head(PATIENCE).await.unwrap();

    let mut dues = clock.dues();

    dues.sort();

    assert_eq!(
        dues,
        vec![Duration::from_millis(960), Duration::from_millis(1_960)],
        "what is left of its exchange's timeout, and of the idle one's rest"
    );

    clock.advance(Duration::from_millis(959)).await;

    assert!(
        started.recorder.told().closes.is_empty(),
        "nothing closed yet"
    );

    clock.advance(Duration::from_millis(1_001)).await;

    assert!(asking.response(PATIENCE).await.is_err(), "its exchange cut");

    let mut closes = started.recorder.closes(2).await;
    let mut expected = vec![(false, unanswered), (false, idle)];

    closes.sort();
    expected.sort();

    assert_eq!(closes, expected, "each closed, as lost");
    started.stop().await;
}

#[tokio::test]
async fn buries_the_client_s_call_ids_alone_a_cancel_of_the_server_s_takes_no_place() {
    let started = started(&HttpTransportServerOptions {
        maximum_waiting_exchanges: Some(1),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (_, token) = connect(&started).await;
    let mut statuses = Vec::new();

    for envelope in [
        envelope_of(CANCEL, (2, 0)),
        envelope_of(CANCEL, (3, 0)),
        // its cancel came first: dropped
        envelope_of(REQUEST, (3, 0)),
    ] {
        statuses.push(
            posted(
                started.port,
                &Post {
                    token: Some(&token),
                    body: envelope,
                    ..Post::default()
                },
            )
            .await
            .head
            .status,
        );
    }

    assert_eq!(statuses, vec![204, 204, 204], "each ended");
    // the two cancels, handed on; the request, never
    assert_eq!(
        started.recorder.told().messages.len(),
        2,
        "the cancels alone"
    );
    started.stop().await;
}

#[tokio::test]
async fn rests_a_connection_once_none_of_its_exchanges_is_under_way_and_arms_no_timer_that_is_infinity()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            exchange_timeout: Some(NEVER),
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let (handle, token) = connect(&started).await;
    let ask = async |call_id: u32| {
        let exchange = posting(
            started.port,
            &Post {
                token: Some(&token),
                body: envelope_of(REQUEST, (call_id, 0)),
                ..Post::default()
            },
        )
        .await;

        // its head, once it waited 40 ms for its answer (spec 15.7)
        head_delayed(&clock).await;
        exchange.head(PATIENCE).await.unwrap();
        exchange
    };
    let first = ask(1).await;
    let second = ask(3).await;

    assert!(clock.dues().is_empty(), "no rest, no timer for ever");

    // one answered, the other still waiting: no rest yet
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();
    first.response(PATIENCE).await.unwrap();
    rest(Duration::from_millis(50)).await;

    assert!(clock.dues().is_empty(), "no rest yet");

    started
        .send(&envelope_of(RESULT, (3, 0)), &handle)
        .await
        .unwrap();
    second.response(PATIENCE).await.unwrap();
    until(|| clock.dues() == [Duration::from_secs(2)]).await;
    started.stop().await;

    // a request waits for its answer for ever, and a connection rests for ever: no timer but its
    // head's delay (spec 15.7)
    let forever = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &forever,
        &HttpTransportServerOptions {
            exchange_timeout: Some(NEVER),
            inactivity_timeout: Some(NEVER),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let (_, token) = connect(&started).await;
    let asking = posting(
        started.port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    // its body's pace, which went once its body was whole, and its head's delay
    let head_delay = Duration::from_millis(40);

    until(|| forever.dues() == [head_delay]).await;

    // its head goes, and nothing is armed for the rest of an exchange timeout of never
    forever.advance(head_delay).await;

    assert_eq!(asking.head(PATIENCE).await.unwrap().status, 200, "its head");
    assert!(forever.dues().is_empty(), "no timer: {:?}", forever.dues());
    started.stop().await;
}

// spec 15.12
#[tokio::test]
async fn tells_no_refusal_of_the_404_that_ends_an_exchange_or_a_listen_as_its_connection_closes_by_a_delete_a_timeout_an_outbox_past_its_bound_a_close_and_a_stop()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            exchange_timeout: Some(Duration::from_secs(1)),
            inactivity_timeout: Some(NEVER),
            maximum_outbox_bytes: Some(20),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let holding = async || {
        let (handle, token) = connect_listening(&started).await;
        let held = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

        until(|| {
            started
                .server
                .gauges()
                .is_some_and(|gauges| gauges.counts["listens"] >= 1)
        })
        .await;

        (handle, token, held)
    };
    let gone = (404, Some(HTTP_REFUSALS.connection_unknown.to_owned()));
    let mut ends = Vec::new();

    // a DELETE
    let (_, deleted, held) = holding().await;
    let deleting = raw_answer_of(
        port,
        head_of(
            ("DELETE", "/bead"),
            (port, &[&format!("{CONNECTION_TOKEN_HEADER}: {deleted}")]),
        )
        .as_bytes(),
    )
    .await;

    assert_eq!(deleting.status, 204, "its DELETE");
    ends.push(refusal_of(&held.head(PATIENCE).await.unwrap()));

    // a timeout
    let (_, timed, held) = holding().await;
    let asking = posting(
        port,
        &Post {
            token: Some(&timed),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    // its head, once it waited 40 ms for its answer (spec 15.7)
    head_delayed(&clock).await;
    asking.head(PATIENCE).await.unwrap();
    clock.advance(Duration::from_secs(1)).await;
    ends.push(refusal_of(&held.head(PATIENCE).await.unwrap()));

    // an outbox past its bound
    let (overflowing, _, held) = holding().await;

    started
        .send(
            &envelope_of(crate::constants::EnvelopeKind::Notification.byte(), (1, 20)),
            &overflowing,
        )
        .await
        .unwrap();
    ends.push(refusal_of(&held.head(PATIENCE).await.unwrap()));

    // a close
    let (closed, _, held) = holding().await;

    started.server.close(&closed).await;
    ends.push(refusal_of(&held.head(PATIENCE).await.unwrap()));

    // a stop
    let (_, _, held) = holding().await;

    started.stop().await;
    ends.push(refusal_of(&held.head(PATIENCE).await.unwrap()));

    assert_eq!(ends, vec![gone; 5], "each a 404");
    assert!(started.recorder.told().refusals.is_empty(), "none told");
}

// ── Where it listens ───────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn listens_on_localhost_when_given_no_address_both_loopbacks_on_one_port_reached_by_127_0_0_1_by_the_ipv6_loopback_and_by_localhost_reports_localhost_and_is_secure_there()
 {
    let started = started_at(None, &HttpTransportServerOptions::default())
        .await
        .unwrap();
    let address = started
        .server
        .clients()
        .first()
        .map(|client| client.address.clone());

    assert!(address.is_none(), "none drawn yet");

    let (handle, _) = connect(&started).await;

    assert!(started.server.is_secure(&handle), "secure on the loopback");

    // a host without the IPv6 loopback listens on 127.0.0.1 alone
    if let Ok(mut socket) = tokio::net::TcpStream::connect(("::1", started.port)).await {
        use tokio::io::AsyncWriteExt;

        socket
            .write_all(
                format!(
                    "POST /bead HTTP/1.1\r\nHost: [::1]:{}\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n",
                    started.port
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let handles = started
            .recorder
            .until(|told| (told.connections.len() >= 2).then(|| told.connections.clone()))
            .await;

        assert!(
            handles[1].starts_with("type=HTTP;ip=::1;"),
            "the IPv6 loopback"
        );
    }

    started.stop().await;
}

#[tokio::test]
async fn serves_every_address_it_binds_by_one_configuration() {
    let started = started_at(
        None,
        &HttpTransportServerOptions {
            pathname: Some("/elsewhere".to_owned()),
            ..HttpTransportServerOptions::default()
        },
    )
    .await
    .unwrap();

    for host in ["127.0.0.1", "::1"] {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let Ok(mut socket) = tokio::net::TcpStream::connect((host, started.port)).await else {
            // no IPv6 loopback here
            continue;
        };

        socket
            .write_all(b"POST /bead HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();

        let mut read = vec![0_u8; 1_024];
        let count = socket.read(&mut read).await.unwrap();
        let text = String::from_utf8_lossy(&read[..count]).to_string();

        assert!(text.starts_with("HTTP/1.1 404"), "{host}: {text}");
        assert!(
            text.contains("bead-refusal: path-unknown"),
            "{host}: its path"
        );
    }

    started.stop().await;
}

#[tokio::test]
async fn refuses_to_start_on_localhost_when_another_socket_holds_the_other_loopback_s_port_ending_closed()
 {
    let Ok(holder) = std::net::TcpListener::bind(("::1", 0)) else {
        // no IPv6 loopback here: nothing holds its port
        return;
    };
    let port = holder.local_addr().unwrap().port();
    let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
    let refused = server
        .start(&TransportServerStartOptions {
            port: Some(port),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap_err();
    let RouterError::Other(error) = refused else {
        panic!("an io error");
    };

    assert_eq!(
        error.downcast_ref::<io::Error>().map(io::Error::kind),
        Some(io::ErrorKind::AddrInUse),
        "the IPv6 loopback's port held"
    );
    assert_eq!(server.ready_state(), ReadyState::Closed, "closed");
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
        "the IPv4 loopback let go"
    );
}

#[tokio::test]
async fn refuses_to_start_on_an_address_that_is_no_bare_ip_address_ending_closed() {
    let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();

    for (address, refusal) in [
        (
            "example.test",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"example.test\"",
        ),
        (
            "[::1]",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"[::1]\": write ::1, not [::1]",
        ),
        (
            "LOCALHOST",
            "a server listens on an IP address, or on localhost, both loopbacks, not \"LOCALHOST\"",
        ),
    ] {
        let refused = server
            .start(&TransportServerStartOptions {
                address: Some(address.to_owned()),
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap_err();

        assert_eq!(refused.to_string(), refusal, "{address} refused");
        assert_eq!(server.ready_state(), ReadyState::Closed, "closed");
    }
}

#[tokio::test]
async fn is_secure_on_the_ipv6_loopback_or_an_address_in_127_0_0_0_8_and_not_on_a_wildcard() {
    for (address, reached, is_secure) in [
        ("127.0.0.1", "127.0.0.1", true),
        ("::1", "::1", true),
        ("0.0.0.0", "127.0.0.1", false),
    ] {
        let Ok(started) = started_at(Some(address), &HttpTransportServerOptions::default()).await
        else {
            // no IPv6 loopback here
            continue;
        };
        let mut socket = tokio::net::TcpStream::connect((reached, started.port))
            .await
            .unwrap();

        {
            use tokio::io::AsyncWriteExt;

            socket
                .write_all(
                    format!(
                        "POST /bead HTTP/1.1\r\nHost: localhost\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\nContent-Length: 0\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }

        let handle = started
            .recorder
            .until(|told| told.connections.first().cloned())
            .await;

        assert_eq!(started.server.is_secure(&handle), is_secure, "on {address}");
        started.stop().await;
    }
}

#[tokio::test]
async fn refuses_a_start_once_disposed_its_state_kept_and_disposes_once_stopping_it_first() {
    let started = started(&HttpTransportServerOptions::default()).await;

    started.server.dispose().await.unwrap();

    assert_eq!(
        started.server.ready_state(),
        ReadyState::Closed,
        "stopped first"
    );
    assert_eq!(
        started
            .server
            .start(&TransportServerStartOptions::default())
            .await
            .unwrap_err()
            .to_string(),
        "the transport server is disposed",
        "refused"
    );
    assert!(
        tokio::net::TcpStream::connect((HOST, started.port))
            .await
            .is_err(),
        "it listens no more"
    );
    // a later dispose settles with the first
    started.server.dispose().await.unwrap();
}

#[tokio::test]
async fn resolves_false_closing_a_handle_nobody_holds() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let nobody: ConnectionHandle = Arc::from("type=HTTP;ip=127.0.0.1;ordinal=9");

    assert!(!started.server.close(&nobody).await, "none held");
    started.stop().await;
}

#[tokio::test]
async fn draws_a_port_on_localhost_again_when_the_ipv6_loopback_holds_the_one_drawn_on_ipv4() {
    use crate::net::loopbacks::{LoopbackBinding, draw_port, listener_on};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let Ok(holder) = listener_on("::1".parse().unwrap(), 0) else {
        return;
    };
    let occupied = holder.local_addr().unwrap().port();
    let draws = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&draws);
    let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();

    *super::super::locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
        port: 0,
        find_open_port: true,
        draw_port: Box::new(move || {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(occupied)
            } else {
                loop {
                    let port = draw_port()?;
                    if port != occupied {
                        break Ok(port);
                    }
                }
            }
        }),
        ipv6_refusal: None,
    });
    let bound = server
        .start(&TransportServerStartOptions {
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        })
        .await
        .unwrap();

    assert_eq!(draws.load(Ordering::SeqCst), 2, "a second draw");
    assert_eq!(bound.address, "localhost");
    assert_ne!(bound.port, occupied);
    assert_eq!(server.ready_state(), ReadyState::Open);
    assert!(
        listener_on("127.0.0.1".parse().unwrap(), occupied).is_ok(),
        "the first IPv4 listener let go"
    );
    for address in ["127.0.0.1", "::1"] {
        let _socket = tokio::net::TcpStream::connect((address, bound.port))
            .await
            .unwrap();
    }
    let response = posted(bound.port, &Post::default()).await;
    assert_eq!(response.head.status, 201);
    assert!(server.is_secure(&server.clients()[0].connection_handle));
    server.stop().await.unwrap();
    for address in ["127.0.0.1", "::1"] {
        assert!(
            listener_on(address.parse().unwrap(), bound.port).is_ok(),
            "{address} let go"
        );
    }

    // eight draws at most, then the last error; a given port is tried once
    for find_open_port in [true, false] {
        let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
        let refusals = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&refusals);
        *super::super::locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
            port: occupied,
            find_open_port,
            draw_port: Box::new(move || Ok(occupied)),
            ipv6_refusal: Some(Box::new(move |_port| {
                count.fetch_add(1, Ordering::SeqCst);
                Some(io::Error::from(io::ErrorKind::AddrInUse))
            })),
        });
        let refused = server
            .start(&TransportServerStartOptions {
                port: Some(occupied),
                find_open_port: Some(find_open_port),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap_err();
        let RouterError::Other(error) = refused else {
            panic!("an io error")
        };
        assert_eq!(
            error.downcast_ref::<io::Error>().map(io::Error::kind),
            Some(io::ErrorKind::AddrInUse)
        );
        assert_eq!(
            refusals.load(Ordering::SeqCst),
            if find_open_port { 8 } else { 1 }
        );
        assert_eq!(server.ready_state(), ReadyState::Closed);
        assert!(
            listener_on("127.0.0.1".parse().unwrap(), occupied).is_ok(),
            "no listener left"
        );
    }
}

#[tokio::test]
async fn listens_on_127_0_0_1_alone_where_the_ipv6_loopback_is_absent_and_reports_127_0_0_1() {
    use crate::net::loopbacks::{FAMILY_NOT_SUPPORTED, LoopbackBinding, draw_port, listener_on};
    use std::sync::atomic::{AtomicUsize, Ordering};

    for error in [
        io::Error::from(io::ErrorKind::AddrNotAvailable),
        io::Error::from_raw_os_error(FAMILY_NOT_SUPPORTED),
    ] {
        let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
        let draws = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&draws);
        let kind = error.kind();
        let raw = error.raw_os_error();
        *super::super::locked(&server.inner.loopback_binding) = Some(LoopbackBinding {
            port: 0,
            find_open_port: true,
            draw_port: Box::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                draw_port()
            }),
            ipv6_refusal: Some(Box::new(move |_port| {
                Some(raw.map_or_else(|| io::Error::from(kind), io::Error::from_raw_os_error))
            })),
        });
        let bound = server
            .start(&TransportServerStartOptions {
                find_open_port: Some(true),
                ..TransportServerStartOptions::default()
            })
            .await
            .unwrap();
        assert_eq!(bound.address, "127.0.0.1");
        assert_eq!(draws.load(Ordering::SeqCst), 1);
        assert_eq!(server.ready_state(), ReadyState::Open);
        let response = posted(bound.port, &Post::default()).await;
        assert_eq!(response.head.status, 201);
        assert!(server.is_secure(&server.clients()[0].connection_handle));
        if listener_on("::1".parse().unwrap(), 0).is_ok() {
            assert!(
                listener_on("::1".parse().unwrap(), bound.port).is_ok(),
                "IPv6 left alone"
            );
        }
        server.stop().await.unwrap();
        assert!(
            listener_on("127.0.0.1".parse().unwrap(), bound.port).is_ok(),
            "IPv4 let go"
        );
    }
}
