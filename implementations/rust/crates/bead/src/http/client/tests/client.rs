//! What it carries, and the client: its connect, its exchanges, its close and its reconnection.

use std::net::Ipv6Addr;

use super::*;
use crate::http::server::HttpTransportServer;
use crate::router::types::ConnectionHandle;
use crate::transport::ServerTransport;

// whether this machine has the IPv6 loopback
async fn has_ipv6_loopback() -> bool {
    TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await.is_ok()
}

// a port nothing listens on
async fn closed_port() -> u16 {
    let listener = TcpListener::bind((HOST, 0)).await.unwrap();

    listener.local_addr().unwrap().port()
}

// a server listener that takes each credential and answers each message with a result carrying
// one, as a router would
struct Answering {
    server: HttpTransportServer,
    taken: Mutex<Vec<Option<String>>>,
}

impl crate::transport::ServerListener for Answering {
    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        locked(&self.taken).push(message.credential);

        let answer = TransportMessage {
            credential: Some(BEARER.to_owned()),
            ..envelope(envelope_of(crate::http::fields::RESULT, (1, 0)))
        };

        if let Ok(Sent::Later(later)) = self.server.send(answer, connection_handle) {
            drop(spawn(later));
        }
    }
}

// a relay in front of a port, what each client wrote kept, every connection's in the order it came
struct Tap {
    port: u16,
    written: Arc<Mutex<Vec<u8>>>,
    stop: CancellationToken,
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Tap {
    fn written(&self) -> String {
        locked(&self.written)
            .iter()
            .map(|byte| char::from(*byte))
            .collect()
    }
}

async fn tap_of(upstream: u16) -> Tap {
    let listener = TcpListener::bind((HOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let written: Arc<Mutex<Vec<u8>>> = Arc::default();
    let stop = CancellationToken::new();
    let (keeping, ending) = (Arc::clone(&written), stop.clone());

    drop(spawn(async move {
        while let Some(Ok((client, _))) = unless_ended(&ending, listener.accept()).await {
            let Ok(server) = TcpStream::connect((HOST, upstream)).await else {
                continue;
            };
            let (mut from_client, mut to_server) = (client.into_split(), server.into_split());
            let keeping = Arc::clone(&keeping);
            let ending = ending.clone();

            drop(spawn(async move {
                let mut chunk = [0_u8; 4_096];

                while let Some(Ok(count)) =
                    unless_ended(&ending, from_client.0.read(&mut chunk)).await
                {
                    if count == 0 || to_server.1.write_all(&chunk[..count]).await.is_err() {
                        break;
                    }

                    locked(&keeping).extend_from_slice(&chunk[..count]);
                }

                to_server.1.shutdown().await.ok();
            }));
            drop(spawn(async move {
                let mut chunk = [0_u8; 4_096];

                while let Ok(count) = to_server.0.read(&mut chunk).await {
                    if count == 0 || from_client.1.write_all(&chunk[..count]).await.is_err() {
                        break;
                    }
                }

                from_client.1.shutdown().await.ok();
            }));
        }
    }));

    Tap {
        port,
        written,
        stop,
    }
}

fn handle_of(server: &HttpTransportServer) -> ConnectionHandle {
    Arc::clone(
        &server
            .clients()
            .last()
            .expect("a connection drawn")
            .connection_handle,
    )
}

fn is_refused_with(outcome: &Result<(), RouterError>, message: &str) -> bool {
    matches!(outcome, Err(error) if error.to_string() == message)
}

// ── What it carries ──────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn carries_a_credential_beside_an_envelope_in_its_post_s_authorization_and_is_secure_under_https_or_to_a_loopback_host_judged_by_the_url_it_was_given()
 {
    let port = closed_port().await;
    let never = client_of(&HttpTransportClientOptions::default());

    // judged from what it connects with, before its first connect from nothing
    assert_eq!(
        (never.carries(BEARER), never.is_secure()),
        (true, false),
        "before any connect"
    );

    let mut judged = Vec::new();

    for (host, secured) in [
        ("bead.example", true),
        ("localhost", false),
        ("127.0.0.1", false),
        ("::1", false),
        ("bead.example", false),
        ("192.0.2.1", false),
    ] {
        let client = client_of(&not_listening());

        // the judgement made from the URL it was given, whatever the network says after
        drop(client.connect(&HttpTransportClientConnectOptions {
            secured: Some(secured),
            ..HttpTransportClientConnectOptions::new(host, port)
        }));
        judged.push((client.carries(BEARER), client.is_secure()));
        client.dispose();
    }

    assert_eq!(
        judged,
        vec![
            (true, true),
            (true, true),
            (true, true),
            (true, true),
            (true, false),
            (true, false),
        ],
        "judged"
    );
}

// ── The client ───────────────────────────────────────────────────────────────────────────────

// spec 15.15
#[tokio::test]
async fn draws_its_connection_sends_an_envelope_settled_on_the_head_of_its_answer_and_hears_the_answer_as_a_message()
 {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&HttpTransportClientOptions::default());
    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open, "open");

    let handle = handle_of(&server.server);
    let request = envelope_of(REQUEST, (1, 0));

    // settled once the server has it, before any answer
    sent(&client, envelope(request.clone())).await.unwrap();
    assert!(told.messages().is_empty(), "nothing heard yet");

    let heard = server.recorder.messages(1).await;

    assert_eq!(heard[0].0.data, Bytes::from(request), "handed on");
    server
        .send(&envelope_of(crate::http::fields::RESULT, (1, 2)), &handle)
        .await
        .unwrap();
    until(|| told.messages().len() == 1).await;
    assert_eq!(
        (
            told.messages()[0].data.clone(),
            told.messages()[0].may_overtake
        ),
        (
            Bytes::from(envelope_of(crate::http::fields::RESULT, (1, 2))),
            false
        ),
        "the answer heard"
    );

    // what the server sends of its own comes by a listen, marked as what may overtake
    server
        .send(&envelope_of(0x13, (0, 0)), &handle)
        .await
        .unwrap();
    until(|| told.messages().len() == 2).await;
    assert!(told.messages()[1].may_overtake, "a listen's");

    // a cancel ends empty: nothing is heard
    sent(&client, cancel(1)).await.unwrap();
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    assert_eq!(told.messages().len(), 2, "nothing of the cancel heard");
    assert_eq!(told.closes(), vec![(true, false)], "closed clean");
    assert_eq!(
        server.recorder.closes(1).await,
        vec![(true, handle)],
        "the server closed it first"
    );
    assert!(told.errors().is_empty(), "nothing reported");
    server.stop().await;
}

#[tokio::test]
async fn rejects_an_exchange_the_server_refused_nothing_tried_and_stays_open() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    settled(client.connect(&to(server.port))).await.unwrap();

    // a request on the server's own parity
    let refused = sent(&client, request(2)).await;

    assert!(
        is_refused_with(&refused, "the server refused the exchange: 400 malformed"),
        "{refused:?}"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    server.stop().await;
}

#[tokio::test]
async fn carries_its_credential_in_the_authorization_of_its_post_which_the_server_hands_on_with_the_request_and_hears_the_answer_with_none()
 {
    let server = started(&HttpTransportServerOptions::default()).await;
    let answering = Arc::new(Answering {
        server: server.server.clone(),
        taken: Mutex::default(),
    });

    server.server.listen(Arc::<Answering>::clone(&answering));

    let client = client_of(&not_listening());
    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    sent(
        &client,
        TransportMessage {
            credential: Some(BEARER.to_owned()),
            ..request(1)
        },
    )
    .await
    .unwrap();
    until(|| told.messages().len() == 1).await;
    assert_eq!(
        (
            locked(&answering.taken).clone(),
            told.messages()[0].credential.clone()
        ),
        (vec![Some(BEARER.to_owned())], None),
        "taken, and none heard"
    );
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    server.stop().await;
}

// spec 15.5
#[tokio::test]
async fn writes_no_origin_on_a_connect_a_post_a_listen_or_a_delete() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let tap = tap_of(server.port).await;
    let client = client_of(&HttpTransportClientOptions::default());

    settled(client.connect(&to(tap.port))).await.unwrap();
    sent(&client, request(1)).await.unwrap();

    // the listen it holds, once the connect said it listens
    until(|| tap.written().contains("GET /")).await;
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    until(|| tap.written().contains("DELETE /")).await;

    let written = tap.written();
    let lines: Vec<&str> = written.split("\r\n").collect();
    let methods: std::collections::BTreeSet<String> = lines
        .iter()
        .filter(|line| line.ends_with(" HTTP/1.1"))
        .filter_map(|line| line.split(' ').next())
        // a request line, behind the body of the request before it on its connection
        .map(|method| {
            method
                .chars()
                .rev()
                .take_while(char::is_ascii_uppercase)
                .collect::<Vec<char>>()
                .into_iter()
                .rev()
                .collect()
        })
        .collect();

    // a page's browser writes its own, which the server judges; the client, none
    assert_eq!(
        methods,
        ["DELETE", "GET", "POST"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        "its methods"
    );
    assert!(
        !lines
            .iter()
            .any(|line| line.to_ascii_lowercase().starts_with("origin:")),
        "no Origin"
    );
    server.stop().await;
}

#[tokio::test]
async fn writes_authorization_only_with_a_credential_and_refuses_one_no_field_carries_before_it_goes_its_connection_kept()
 {
    let faked = connected(fake().await, &not_listening()).await;
    let carrying = sending(
        &faked.client,
        TransportMessage {
            credential: Some(BEARER.to_owned()),
            ..request(1)
        },
    );

    faked.fake.call_of(1).await.answer(&Answer::of(204));
    within(carrying).await.unwrap();

    let bare = sending(&faked.client, cancel(1));

    faked.fake.call_of(2).await.answer(&Answer::of(204));
    within(bare).await.unwrap();

    let calls = faked.fake.calls();

    assert_eq!(
        (
            calls[1].field("authorization"),
            calls[2].field("authorization")
        ),
        (Some(BEARER), None),
        "its Authorization"
    );

    for credential in ["Bearer a\r\nb", "Bearer \u{e9}", "Bearer \u{0}"] {
        let refused = faked.client.send(TransportMessage {
            credential: Some(credential.to_owned()),
            ..request(3)
        });

        assert!(
            matches!(&refused, Err(error) if error.to_string() == NO_FIELD_VALUE),
            "{credential:?}"
        );
    }

    assert_eq!(
        (faked.fake.count(), faked.client.ready_state()),
        (3, ReadyState::Open),
        "nothing sent, its connection kept"
    );
}

// spec 15.5
#[tokio::test]
async fn refuses_a_credential_with_a_space_or_a_tab_first_or_last_before_its_send_goes() {
    let faked = connected(fake().await, &not_listening()).await;

    for credential in [
        format!(" {BEARER}"),
        format!("{BEARER} "),
        format!("\t{BEARER}"),
        format!("{BEARER}\t"),
        " ".to_owned(),
    ] {
        let refused = faked.client.send(TransportMessage {
            credential: Some(credential.clone()),
            ..request(1)
        });

        assert!(
            matches!(&refused, Err(error) if error.to_string() == NO_FIELD_VALUE),
            "{credential:?}"
        );
        // nor does it say it carries one, which a call presenting ELSEWHERE then fails before it
        // goes
        assert!(!faked.client.carries(&credential), "{credential:?}");
    }

    // a space or a tab within it is a field's
    assert_eq!(
        (
            faked.client.carries(BEARER),
            faked.client.carries("Bearer\ta b")
        ),
        (true, true),
        "within"
    );
    assert_eq!(
        (faked.fake.count(), faked.client.ready_state()),
        (1, ReadyState::Open),
        "nothing sent"
    );
}

#[tokio::test]
async fn disconnects_by_a_delete_the_server_closing_first_and_closes_clean() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());
    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let handle = handle_of(&server.server);

    disconnected(
        &client,
        &TransportClientDisconnectOptions {
            is_clean: Some(true),
            ..TransportClientDisconnectOptions::default()
        },
    )
    .await;

    assert_eq!(told.closes(), vec![(true, false)], "closed clean");
    // closed at the server before the DELETE was answered
    assert_eq!(
        server.recorder.told().closes,
        vec![(true, handle)],
        "closed at the server first"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert!(
        matches!(
            client.disconnect(&TransportClientDisconnectOptions::default()),
            Err(TransportError::ReadyState(_))
        ),
        "a disconnect refused"
    );

    let refused = client.send(envelope(vec![0; 8]));

    // debugging 9.7
    assert!(
        matches!(&refused, Err(RouterError::Disconnected(reason)) if reason == "the transport client is closed, not open"),
        "a send refused as a disconnection: {:?}",
        refused.err()
    );
    server.stop().await;
}

// what a send in a state gives: sent, its ready state's refusal or a disconnection
fn sent_in(sent: Result<Sent, RouterError>) -> String {
    match sent {
        Ok(_) => "sent".to_owned(),
        Err(RouterError::ReadyState(refusal)) => format!("ready state {}", refusal.got().name()),
        Err(RouterError::Disconnected(reason)) => format!("disconnected: {reason}"),
        Err(other) => format!("other: {other}"),
    }
}

// the first call its server took whose method is `method`, once taken
async fn call_by(fake: &Fake, method: &str) -> Arc<Call> {
    within(async {
        loop {
            if let Some(call) = fake.calls().into_iter().find(|call| call.method == method) {
                return call;
            }

            rest(Duration::from_millis(5)).await;
        }
    })
    .await
}

// debugging 9.7
#[tokio::test]
async fn refuses_a_send_by_its_ready_state_before_the_open_and_as_a_disconnection_after_it_in_each_state_it_holds()
 {
    let fake = fake_of(&ScriptOptions {
        is_delete_held: true,
        ..ScriptOptions::default()
    })
    .await;
    let client = client_of(&not_listening());
    let mut told = Vec::new();

    // never connected
    told.push(("UNINITIALIZED", sent_in(client.send(request(1)))));

    // its POST held
    let refusing = client.connect(&to(fake.port));
    let post = fake.call_of(0).await;

    assert_eq!(client.ready_state(), ReadyState::Connecting, "connecting");
    told.push(("CONNECTING", sent_in(client.send(request(1)))));

    // a connect its server refused: closed
    post.answer(&refusal(503, "busy"));
    settled(refusing).await.expect_err("refused by its server");
    told.push(("CLOSED, failed", sent_in(client.send(request(1)))));

    // a reconnection's attempt, its POST held
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions::default())
        .unwrap();
    let post = fake.call_of(1).await;

    assert_eq!(
        client.ready_state(),
        ReadyState::Reconnecting,
        "reconnecting"
    );
    told.push(("RECONNECTING", sent_in(client.send(request(1)))));
    post.answer(&drawn(false));
    within(reconnecting).await.expect("reconnected");
    told.push(("OPEN", sent_in(client.send(request(1)))));

    // its DELETE held
    let disconnecting = client
        .disconnect(&TransportClientDisconnectOptions::default())
        .unwrap();
    let delete = call_by(&fake, "DELETE").await;

    assert_eq!(client.ready_state(), ReadyState::Closing, "closing");
    told.push(("CLOSING", sent_in(client.send(request(1)))));

    // closed by its own disconnect
    delete.answer(&Answer::of(204));
    within(disconnecting).await;
    told.push(("CLOSED", sent_in(client.send(request(1)))));

    assert_eq!(
        told,
        [
            ("UNINITIALIZED", "ready state UNINITIALIZED".to_owned()),
            ("CONNECTING", "ready state CONNECTING".to_owned()),
            (
                "CLOSED, failed",
                "disconnected: the transport client is closed, not open".to_owned()
            ),
            (
                "RECONNECTING",
                "disconnected: the transport client is reconnecting, not open".to_owned()
            ),
            ("OPEN", "sent".to_owned()),
            (
                "CLOSING",
                "disconnected: the transport client is closing, not open".to_owned()
            ),
            (
                "CLOSED",
                "disconnected: the transport client is closed, not open".to_owned()
            ),
        ],
        "each state's"
    );
    client.dispose();
}

#[tokio::test]
async fn closes_once_the_server_says_the_connection_is_gone_after_rejecting_the_exchange_that_learned_it()
 {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());
    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();
    within(server.server.close(&handle_of(&server.server))).await;

    let refused = sent(&client, request(1)).await;
    // what was told by the time the rejection was heard
    let told_then = told.closes();

    assert!(
        is_refused_with(
            &refused,
            "the server refused the exchange: 404 connection-unknown"
        ),
        "{refused:?}"
    );
    assert_eq!(told_then, Vec::new(), "rejected before its close");
    assert_eq!(told.closed(1).await, vec![(false, false)], "then closed");
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    server.stop().await;
}

#[tokio::test]
async fn closes_and_tells_the_server_when_the_server_is_lost_under_an_exchange_which_counts_as_handed_over()
 {
    let faked = connected(fake().await, &not_listening()).await;
    let lost = sending(&faked.client, request(1));

    faked.fake.call_of(1).await.fail();

    assert!(within(lost).await.is_ok(), "handed over");
    assert_eq!(faked.told.closed(1).await, vec![(false, false)], "closed");
    faked.fake.call_of(2).await;
    assert_eq!(
        faked
            .fake
            .calls()
            .iter()
            .map(|call| (call.method.clone(), call.field(CONNECTION_TOKEN_HEADER)))
            .collect::<Vec<(String, Option<&str>)>>(),
        vec![
            ("POST".to_owned(), None),
            ("POST".to_owned(), Some(TOKEN)),
            ("DELETE".to_owned(), Some(TOKEN)),
        ],
        "its calls"
    );
}

#[tokio::test]
async fn counts_a_status_nothing_marked_a_gateway_s_a_proxy_s_as_an_exchange_lost_which_may_have_run()
 {
    for status in [404, 502, 504] {
        let faked = connected(fake().await, &not_listening()).await;
        let lost = sending(&faked.client, request(1));

        faked.fake.call_of(1).await.answer(&Answer::of(status));

        assert!(within(lost).await.is_ok(), "{status}");
        assert_eq!(faked.told.closed(1).await, vec![(false, false)], "{status}");
        // the server is told, when it can be
        assert_eq!(faked.fake.call_of(2).await.method, "DELETE", "{status}");
    }
}

#[tokio::test]
async fn rejects_a_refusal_the_server_marked_and_keeps_its_connection() {
    let faked = connected(fake().await, &not_listening()).await;
    let refused = sending(&faked.client, request(1));

    faked
        .fake
        .call_of(1)
        .await
        .answer(&refusal(429, HTTP_REFUSALS.busy));

    let refused = within(refused).await;

    assert!(
        is_refused_with(&refused, "the server refused the exchange: 429 busy"),
        "{refused:?}"
    );
    assert_eq!(faked.client.ready_state(), ReadyState::Open, "open");
}

#[tokio::test]
async fn closes_on_an_answer_that_is_no_envelope_or_larger_than_an_envelope_and_hears_nothing_of_it()
 {
    for answer in [
        Answer::of(200)
            .with("content-type", "text/html")
            .carrying(b"<html>"),
        bead(&[0; 9]).with("content-length", "9"),
        bead(&[0; 9]).ending(Ending::Undeclared),
    ] {
        let faked = connected(
            fake().await,
            &HttpTransportClientOptions {
                maximum_body_bytes: Some(8),
                ..not_listening()
            },
        )
        .await;
        let sending = sending(&faked.client, request(1));

        faked.fake.call_of(1).await.answer(&answer);
        within(sending).await.unwrap();

        assert_eq!(
            faked.told.closed(1).await,
            vec![(false, false)],
            "{:?}",
            answer.fields
        );
        assert!(faked.told.messages().is_empty(), "{:?}", answer.fields);
    }
}

#[tokio::test]
async fn reads_an_answer_of_its_type_whatever_its_case_or_parameters_up_to_its_limit_exactly_and_closes_on_one_declared_past_it_unread()
 {
    let mut outcomes = Vec::new();

    for answer in [
        Answer::of(200)
            .with("content-length", "16")
            .with("content-type", "Application/PRS.Bead; charset=binary")
            .carrying(&[1; 16]),
        // its length said wrong: past the limit, whatever comes; its body held, never ended, so
        // that a client that read it would wait on it
        bead(&[2; 16]).with("content-length", "17").later(),
    ] {
        let faked = connected(
            fake().await,
            &HttpTransportClientOptions {
                maximum_body_bytes: Some(16),
                ..not_listening()
            },
        )
        .await;
        let sending = sending(&faked.client, request(1));
        let call = faked.fake.call_of(1).await;

        call.answer(&answer);

        if answer.is_later {
            call.write(&[2; 16]);
        }

        within(sending).await.unwrap();
        until(|| !faked.told.messages().is_empty() || !faked.told.closes().is_empty()).await;
        outcomes.push((
            faked
                .told
                .heard()
                .iter()
                .map(|heard| heard[0])
                .collect::<Vec<u8>>(),
            !faked.told.closes().is_empty(),
        ));
    }

    assert_eq!(
        outcomes,
        vec![(vec![1], false), (vec![], true)],
        "read up to its limit, and closed unread past it"
    );
}

#[tokio::test]
async fn hears_nothing_of_an_answer_ended_empty_nor_of_one_whose_connection_went_while_it_came() {
    let faked = connected(fake().await, &not_listening()).await;

    // cancelled: its exchange ends with no body
    let cancelled = sending(&faked.client, request(1));

    faked.fake.call_of(1).await.answer(&bead(&[]));
    within(cancelled).await.unwrap();

    let coming = sending(&faked.client, request(3));
    let later = faked.fake.call_of(2).await;
    let result = envelope_of(crate::http::fields::RESULT, (3, 0));

    later.answer(&bead(&result).later());
    within(coming).await.unwrap();

    // another exchange lost: the connection goes, and the answer still coming with it
    let lost = sending(&faked.client, request(5));

    faked.fake.call_of(3).await.fail();
    within(lost).await.unwrap();
    faked.told.closed(1).await;
    later.write(&result);
    later.end();
    rest(Duration::from_millis(20)).await;

    assert!(faked.told.messages().is_empty(), "nothing heard");
}

#[tokio::test]
async fn reports_a_listener_that_throws_on_an_answer_and_stays_open() {
    let fake = fake().await;
    let client = client_of(&not_listening());

    client.listen(Throwing::times(1));

    // a listener after it is told all the same
    let told = recorded(&client);
    let connecting = client.connect(&to(fake.port));

    fake.call_of(0).await.answer(&drawn(false));
    settled(connecting).await.unwrap();

    let sent = sending(&client, request(1));

    fake.call_of(1)
        .await
        .answer(&bead(&envelope_of(crate::http::fields::RESULT, (1, 0))));
    within(sent).await.unwrap();

    // heard once its body came whole, after the send settled on its head
    until(|| told.messages().len() == 1).await;
    assert_eq!(told.errors().len(), 1, "the throw reported");
    assert!(
        told.errors()[0].contains("a listener that throws"),
        "{:?}",
        told.errors()
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    disconnected(&client, &quick()).await;
}

#[tokio::test]
async fn closes_once_telling_the_server_once_however_many_exchanges_learn_it_is_lost_tells_a_server_that_said_it_is_gone_nothing()
 {
    let faked = connected(fake().await, &not_listening()).await;
    let first = sending(&faked.client, request(1));
    let second = sending(&faked.client, request(3));

    faked.fake.call_of(1).await.fail();
    faked.fake.call_of(2).await.fail();
    within(first).await.unwrap();
    within(second).await.unwrap();
    faked.fake.call_of(3).await;
    rest(WHILE).await;

    let deletes = faked
        .fake
        .methods()
        .iter()
        .filter(|method| *method == "DELETE")
        .count();

    assert_eq!(
        (faked.told.closes(), deletes),
        (vec![(false, false)], 1),
        "closed once, told once"
    );

    let told = connected(fake().await, &not_listening()).await;
    let refused = sending(&told.client, request(1));

    told.fake
        .call_of(1)
        .await
        .answer(&refusal(404, HTTP_REFUSALS.connection_unknown));

    assert!(within(refused).await.is_err(), "refused");
    told.told.closed(1).await;
    rest(WHILE).await;
    assert_eq!(told.fake.methods(), ["POST", "POST"], "nothing told");
}

#[tokio::test]
async fn closes_on_an_answer_with_no_type_or_whose_body_is_lost_on_its_way() {
    for answer in [Answer::of(200), bead(&[]).ending(Ending::Cut)] {
        let faked = connected(fake().await, &not_listening()).await;
        let sending = sending(&faked.client, request(1));

        faked.fake.call_of(1).await.answer(&answer);
        within(sending).await.unwrap();

        assert_eq!(
            faked.told.closed(1).await,
            vec![(false, false)],
            "{:?}",
            answer.fields
        );
    }
}

// spec 15.15
#[tokio::test]
async fn lets_go_of_a_connection_drawn_as_its_connect_gave_up_and_closes_even_when_the_server_cannot_hear_its_delete()
 {
    assert_eq!(DISCONNECT_TIMEOUT, Duration::from_secs(5), "its bound");

    // drawn, then dropped before the connect heard it: its answer comes back all the same
    let drawing = fake().await;
    let client = client_of(&not_listening());
    let connecting = client.connect(&to(drawing.port));
    let connect = drawing.call_of(0).await;

    client.dispose();
    connect.answer(&drawn(false));

    let disposed = settled(connecting).await;

    assert!(
        matches!(&disposed, Err(TransportError::Connect(error)) if error.to_string() == DISPOSED),
        "{disposed:?}"
    );

    let deleted = drawing.call_of(1).await;

    assert_eq!(
        (
            deleted.method.as_str(),
            deleted.field(CONNECTION_TOKEN_HEADER)
        ),
        ("DELETE", Some(TOKEN)),
        "let go of"
    );

    // a DELETE the network failed, its bound the platform's 5 s
    let platform = stepping();
    let runtime = platform::socket_runtime_of(None, "a test's client").unwrap();
    let held = fake_of(&ScriptOptions {
        is_delete_held: true,
        ..ScriptOptions::default()
    })
    .await;
    let on_platform: SharedClock = Arc::<SteppingClock>::clone(&platform);
    let connected =
        HttpTransportClient::on_platform((runtime, on_platform), &not_listening()).unwrap();
    let connecting = connected.connect(&to(held.port));

    held.call_of(0).await.answer(&drawn(false));
    settled(connecting).await.unwrap();

    let disconnecting = connected
        .disconnect(&TransportClientDisconnectOptions::default())
        .unwrap();
    let delete = held.call_of(1).await;

    assert!(
        platform.dues().contains(&DISCONNECT_TIMEOUT),
        "waited on {DISCONNECT_TIMEOUT:?} at most: {:?}",
        platform.dues()
    );
    delete.fail();
    within(disconnecting).await;
    assert_eq!(connected.ready_state(), ReadyState::Closed, "closed");
}

// a DELETE never answered is waited on 5 s at most, on the real clock: it bounds the platform's
// exchange against a server that does not answer. Played in real time, as a platform's own bound
// is: no clock given moves it
#[tokio::test]
async fn bounds_its_disconnect_on_the_real_clock_whatever_its_own_a_server_that_never_answers_the_delete_is_let_go_once_disconnect_timeout_has_passed()
 {
    let clock = stepping();
    let faked = connected(
        fake_of(&ScriptOptions {
            is_delete_held: true,
            ..ScriptOptions::default()
        })
        .await,
        &HttpTransportClientOptions {
            clock: Some(on_clock(&clock)),
            ..not_listening()
        },
    )
    .await;
    let began = crate::testing::Instant::now();
    let disconnecting = faked
        .client
        .disconnect(&TransportClientDisconnectOptions::default())
        .unwrap();
    let delete = faked.fake.call_of(1).await;

    // nothing armed on its own clock
    let armed = clock.dues();

    within(disconnecting).await;

    assert_eq!(delete.method, "DELETE", "its DELETE");
    assert!(delete.is_aborted().await, "let go of");
    assert!(
        began.elapsed() >= DISCONNECT_TIMEOUT.saturating_sub(Duration::from_millis(50)),
        "{:?}",
        began.elapsed()
    );
    assert_eq!(
        (faked.client.ready_state(), armed),
        (ReadyState::Closed, Vec::new()),
        "closed, nothing armed on its clock"
    );
}

// a DELETE never answered is waited on 5 s at most, on the real clock, whatever the clock it is
// given says. Played in real time, and bounded generously
#[tokio::test]
async fn bounds_the_delete_of_its_disconnect_on_the_real_clock_never_on_the_one_it_is_given() {
    let clock = stepping();
    let waiting = connected(
        fake_of(&ScriptOptions {
            is_delete_held: true,
            ..ScriptOptions::default()
        })
        .await,
        &HttpTransportClientOptions {
            clock: Some(on_clock(&clock)),
            ..not_listening()
        },
    )
    .await;
    // ! taken before the DELETE goes, whose bound starts with it: a resumption late after its call
    // would otherwise shorten what is measured
    let began = crate::testing::Instant::now();
    let unanswered = spawn(
        waiting
            .client
            .disconnect(&TransportClientDisconnectOptions::default())
            .unwrap(),
    );

    waiting.fake.call_of(1).await;
    clock.advance(Duration::from_hours(24)).await;
    rest(Duration::from_millis(100)).await;

    assert!(!unanswered.is_finished(), "not on the clock it is given");

    within(unanswered).await.unwrap();

    assert!(
        began.elapsed() >= Duration::from_millis(4_500) && began.elapsed() <= PATIENCE,
        "{:?}",
        began.elapsed()
    );
    assert_eq!(waiting.client.ready_state(), ReadyState::Closed, "closed");
}

#[tokio::test]
async fn settles_its_send_on_the_head_of_the_answer_before_its_body_is_in_and_hears_the_answer_once_it_is()
 {
    let answer = envelope_of(crate::http::fields::RESULT, (1, 0));
    let faked = connected(fake().await, &not_listening()).await;
    let settling = sending(&faked.client, request(1));
    let call = faked.fake.call_of(1).await;

    call.answer(&bead(&answer).later());
    within(settling).await.unwrap();

    assert!(faked.told.messages().is_empty(), "settled, nothing heard");

    call.write(&answer);
    call.end();
    until(|| faked.told.messages().len() == 1).await;
    assert_eq!(faked.told.heard(), vec![answer], "heard once it came");
}

// spec 15.15
#[tokio::test]
async fn refuses_to_connect_where_no_connection_is_drawn_and_lets_go_of_one_drawn_as_it_gave_up() {
    // a gateway's unmarked refusal is named by its status alone; over https, to the IPv6
    // loopback where this machine has it, at the path it names
    let (address, host) = if has_ipv6_loopback().await {
        ("::1", "::1")
    } else {
        (HOST, HOST)
    };
    let refused = fake_of(&ScriptOptions {
        address: Some(address),
        tls: Some(crate::testing::tls::server_config().unwrap()),
        ..ScriptOptions::default()
    })
    .await;
    let client = client_of(&HttpTransportClientOptions {
        client_config: Some(crate::testing::tls::client_config().unwrap()),
        ..not_listening()
    });
    let connecting = client.connect(&HttpTransportClientConnectOptions {
        pathname: Some("api".to_owned()),
        secured: Some(true),
        ..HttpTransportClientConnectOptions::new(host, refused.port)
    });

    refused.call_of(0).await.answer(&Answer::of(503));

    let outcome = settled(connecting).await;

    assert!(
        matches!(&outcome, Err(TransportError::Connect(error)) if error.to_string() == "the server drew no connection: 503"),
        "{outcome:?}"
    );

    // a refusal the server marked is named by its status and its reason; a gateway's, unmarked,
    // by its status alone
    for (answer, message) in [
        (
            refusal(503, HTTP_REFUSALS.busy),
            "the server drew no connection: 503 busy",
        ),
        (
            refusal(403, HTTP_REFUSALS.host),
            "the server drew no connection: 403 host-refused",
        ),
        (Answer::of(502), "the server drew no connection: 502"),
        // a token without its 201, or a 201 without its token, draws nothing
        (
            Answer::of(200).with(CONNECTION_TOKEN_HEADER, TOKEN),
            "the server drew no connection: 200",
        ),
        (Answer::of(201), "the server drew no connection: 201"),
    ] {
        let named = fake().await;
        let naming = client_of(&not_listening());
        let connecting = naming.connect(&to(named.port));

        named.call_of(0).await.answer(&answer);

        let outcome = settled(connecting).await;

        assert!(
            matches!(&outcome, Err(TransportError::Connect(error)) if error.to_string() == message),
            "{message}: {outcome:?}"
        );
    }

    let call = refused.call_of(0).await;
    let authority = if host == HOST {
        format!("{HOST}:{}", refused.port)
    } else {
        format!("[::1]:{}", refused.port)
    };

    assert_eq!(
        (call.target.as_str(), call.field("host")),
        ("/api", Some(authority.as_str())),
        "https://{authority}/api"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");

    let unreachable = client_of(&not_listening());
    let failed = settled(unreachable.connect(&to(closed_port().await))).await;

    assert!(
        matches!(&failed, Err(TransportError::Connect(_))),
        "{failed:?}"
    );

    // timed out: its exchange aborted
    let clock = stepping();
    let slow = fake().await;
    let late = client_of(&HttpTransportClientOptions {
        clock: Some(on_clock(&clock)),
        ..not_listening()
    });
    let late_connecting = late.connect(&HttpTransportClientConnectOptions {
        timeout: Some(Duration::from_millis(20)),
        ..to(slow.port)
    });
    let slowly = slow.call_of(0).await;

    clock.advance(Duration::from_millis(20)).await;

    let timed_out = settled(late_connecting).await;

    assert!(
        matches!(&timed_out, Err(TransportError::TimedOut(after)) if *after == Duration::from_millis(20))
            && timed_out.as_ref().err().map(ToString::to_string).as_deref()
                == Some("timed out after 20ms"),
        "{timed_out:?}"
    );
    assert!(slowly.is_aborted().await, "its exchange aborted");
    assert_eq!(
        (PATHNAME, CONNECT_TIMEOUT, to(80).secured),
        ("/bead", Duration::from_secs(30), None),
        "its defaults"
    );
}

#[tokio::test]
async fn a_drop_aborts_what_is_in_flight_tells_the_server_and_a_dispose_while_connecting_rejects_the_connect()
 {
    let faked = connected(fake().await, &not_listening()).await;
    let in_flight = sending(&faked.client, request(1));
    let call = faked.fake.call_of(1).await;

    faked.client.dispose();

    assert!(within(in_flight).await.is_ok(), "settled");
    assert!(call.is_aborted().await, "aborted");

    let deleted = faked.fake.call_of(2).await;

    assert_eq!(
        (
            deleted.method.as_str(),
            deleted.field(CONNECTION_TOKEN_HEADER)
        ),
        ("DELETE", Some(TOKEN)),
        "the server told"
    );
    assert_eq!(faked.client.ready_state(), ReadyState::Closed, "closed");

    let connecting = fake().await;
    let disposed = client_of(&not_listening());
    let attempt = disposed.connect(&to(connecting.port));

    connecting.call_of(0).await;
    disposed.dispose();

    let outcome = settled(attempt).await;

    assert!(
        matches!(&outcome, Err(TransportError::Connect(error)) if error.to_string() == DISPOSED),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn disconnects_quickly_without_waiting_on_the_server_which_is_told_all_the_same() {
    let faked = connected(
        fake_of(&ScriptOptions {
            is_delete_held: true,
            ..ScriptOptions::default()
        })
        .await,
        &not_listening(),
    )
    .await;

    disconnected(
        &faked.client,
        &TransportClientDisconnectOptions {
            is_clean: Some(false),
            is_quick: Some(true),
        },
    )
    .await;

    assert_eq!(faked.told.closes(), vec![(false, true)], "closed quick");

    let deleted = faked.fake.call_of(1).await;

    assert_eq!(
        (
            deleted.method.as_str(),
            deleted.field(CONNECTION_TOKEN_HEADER)
        ),
        ("DELETE", Some(TOKEN)),
        "the server told, its answer never waited on"
    );
}

#[tokio::test]
async fn reconnects_to_a_connection_drawn_anew() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());
    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let first = handle_of(&server.server);

    within(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .unwrap(),
    )
    .await
    .unwrap();

    let opened = handle_of(&server.server);

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    assert!(!Arc::ptr_eq(&first, &opened), "drawn anew");
    // its DELETE nobody waits on may come after the connect that replaced it
    assert_eq!(
        server.recorder.closes(1).await,
        vec![(true, Arc::clone(&first))],
        "the one replaced let go of"
    );
    assert_eq!(
        server
            .server
            .clients()
            .iter()
            .map(|client| Arc::clone(&client.connection_handle))
            .collect::<Vec<ConnectionHandle>>(),
        vec![opened],
        "the one drawn alone"
    );
    assert!(told.closes().is_empty(), "no close");
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    server.stop().await;
}

#[tokio::test]
async fn rejects_with_a_reconnect_error_caused_by_a_connect_error_when_the_server_is_gone() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    settled(client.connect(&to(server.port))).await.unwrap();
    server.stop().await;

    // one attempt, for a port nothing listens on takes some systems two seconds to refuse
    let failed = within(
        client
            .reconnect(&TransportClientReconnectOptions {
                maximum_attempts: Some(1),
                ..TransportClientReconnectOptions::default()
            })
            .unwrap(),
    )
    .await;
    let Err(TransportError::Reconnect(error)) = &failed else {
        panic!("a reconnect error: {failed:?}");
    };

    assert!(
        matches!(
            core::error::Error::source(error)
                .and_then(|cause| cause.downcast_ref::<TransportError>()),
            Some(TransportError::Connect(_))
        ),
        "caused by a connect error"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
}

#[tokio::test]
async fn reconnects_though_a_reconnect_listener_throws_the_throw_reported_the_next_listener_told() {
    struct Throwing;

    impl ClientListener for Throwing {
        fn on_reconnect(&self) {
            panic!("a reconnect listener that throws");
        }
    }

    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    client.listen(Arc::new(Throwing));

    let told = recorded(&client);

    settled(client.connect(&to(server.port))).await.unwrap();

    let first = handle_of(&server.server);

    within(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .unwrap(),
    )
    .await
    .unwrap();

    // the reconnection went on to its attempt, which opened
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    assert!(
        !Arc::ptr_eq(&first, &handle_of(&server.server)),
        "drawn anew"
    );
    assert_eq!(told.reconnects(), 1, "the next listener told");
    assert_eq!(told.errors().len(), 1, "the throw reported");
    assert!(
        told.errors()[0].contains("a reconnect listener that throws"),
        "{:?}",
        told.errors()
    );
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    server.stop().await;
}

#[test]
fn marks_its_refusals_as_the_server_does() {
    assert_eq!(
        (REFUSAL_HEADER, HTTP_REFUSALS.connection_unknown),
        ("bead-refusal", "connection-unknown"),
        "its marks"
    );
}
