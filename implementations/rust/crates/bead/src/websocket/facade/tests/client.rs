//! The twins of `websocket-client.test.ts` and `WebSocketClientTests`: the client an application
//! starts from, against a raw server that reads and writes envelopes as a server does, and against
//! the server an application starts from.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tungstenite::protocol::Message;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;

use super::*;
use crate::clock::SharedClock;
use crate::constants::{FailureScope, ProcedureKind, RouterSide};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{
    CancelHeader, Credential, Envelope, FailureHeader, FailureRecord, NotificationHeader,
    ReadEnvelopeOptions, RequestHeader, ResultHeader, read_envelope, write_envelope,
};
use crate::errors::{ResolverError, TransportError};
use crate::failure::{FailureOrigin, ProcedureAddress};
use crate::managers::service::{
    NotificationDependencies, RegistrationOptions, RequestDependencies, RequestOptions,
    RequestResolverDependencies,
};
use crate::payloads::TextCodec;
use crate::router::types::{RouterError, RouterLimitsOptions, TransportMessage};
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::transport::{
    ClientListener, ReadyState, RouterClientTransport, ServerTransport,
    TransportClientDisconnectOptions, TransportClientReconnectDelay,
    TransportClientReconnectOptions,
};
use crate::websocket::client::WebSocketTransportClientOptions;

fn asked() -> RequestDependencies<TextCodec, TextCodec> {
    RequestDependencies::new(TextCodec, TextCodec)
}

fn text() -> RequestResolverDependencies<TextCodec, TextCodec> {
    RequestResolverDependencies::new(TextCodec, TextCodec)
}

fn token() -> SessionToken {
    SessionToken::new([9; 16]).expect("a token")
}

// a request of `text` to `procedure` through `client`'s services, as it is called
fn call_of(
    client: &WebSocketClient,
    (procedure, value): (&Procedure, &str),
    options: &RequestOptions,
) -> ServiceCall<String> {
    client
        .services()
        .get_request(procedure, asked())
        .expect("a requester")
        .call(value.to_owned(), options)
        .expect("a call")
}

fn disconnected_of(outcome: Result<String, CallError>) -> String {
    match outcome {
        Err(CallError::Disconnected(why)) => why,
        other => panic!("disconnected, not {other:?}"),
    }
}

// ── A raw server ───────────────────────────────────────────────────────────────────────────────

// a server's end of one WebSocket, which reads envelopes as a server does
struct Raw {
    socket: WebSocketStream<TcpStream>,
}

impl Raw {
    // the next envelope its client sent
    async fn next_envelope(&mut self) -> Envelope {
        patience(PATIENCE, async {
            loop {
                let Some(Ok(message)) = self.socket.next().await else {
                    panic!("an envelope before the socket's end");
                };

                if let Message::Binary(bytes) = message {
                    return read_envelope(
                        &bytes,
                        RouterSide::Server,
                        &ReadEnvelopeOptions::default(),
                    )
                    .expect("an envelope")
                    .expect("whole");
                }
            }
        })
        .await
        .expect("an envelope in time")
    }

    async fn send(&mut self, envelope: &Envelope) {
        self.socket
            .send(Message::Binary(
                write_envelope(envelope, 1_024).expect("written"),
            ))
            .await
            .expect("sent");
    }
}

// a raw server on the IPv4 loopback, and its port: the socket it takes once a client came
async fn raw_server() -> (u16, tokio::task::JoinHandle<Raw>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bound");
    let port = listener.local_addr().expect("its address").port();
    let accepting = crate::testing::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accepted");
        let socket = tokio_tungstenite::accept_async(socket)
            .await
            .expect("upgraded");

        Raw { socket }
    });

    (port, accepting)
}

// a client connected to a raw server, and that server's end
async fn raw_pair() -> (WebSocketClient, Raw) {
    let client = client_with(&RouterLimitsOptions::default());
    let (port, accepting) = raw_server().await;

    connect(&client, port).await;

    let raw = patience(PATIENCE, accepting)
        .await
        .expect("in time")
        .expect("accepted");

    (client, raw)
}

fn result_to(call_id: u32, (payload, credential): (&str, Option<Credential>)) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential,
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

fn notification_on(call_id: u32, payload: &str) -> Envelope {
    Envelope::Notification {
        header: NotificationHeader { call_id },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

struct Taking(tokio::sync::mpsc::UnboundedSender<usize>);

impl ClientListener for Taking {
    fn on_message(&self, message: TransportMessage) {
        self.0.send(message.data.len()).ok();
    }
}

// a message of `bytes` is taken whole, and one byte more closes its connection with 1009
async fn assert_takes(bytes: usize, options: &WebSocketClientOptions) {
    let client = WebSocketClient::new(options).expect("a client");
    let (taking, mut taken) = tokio::sync::mpsc::unbounded_channel();
    let (port, accepting) = raw_server().await;

    client.transport().listen(Arc::new(Taking(taking)));
    connect(&client, port).await;

    let mut raw = accepting.await.expect("accepted");

    raw.socket
        .send(Message::Binary(Bytes::from(vec![0_u8; bytes])))
        .await
        .expect("sent");
    assert_eq!(
        patience(PATIENCE, taken.recv()).await.expect("in time"),
        Some(bytes),
        "a message of {bytes} bytes taken"
    );
    raw.socket
        .send(Message::Binary(Bytes::from(vec![
            0_u8;
            bytes.saturating_add(1)
        ])))
        .await
        .expect("sent");

    let closed = patience(PATIENCE, async {
        while let Some(Ok(message)) = raw.socket.next().await {
            if let Message::Close(frame) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }

        None
    })
    .await
    .expect("closed in time");

    assert_eq!(closed, Some(1_009), "one byte more");
    client.dispose().await;
}

// ── What it builds ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn builds_its_router_with_the_limits_given() {
    let client = client_with(&RouterLimitsOptions {
        maximum_payload_bytes: Some(8),
        ..RouterLimitsOptions::default()
    });
    let refused = outcome_of(
        call_of(
            &client,
            (&echo(), "much too long"),
            &RequestOptions::default(),
        ),
        PATIENCE,
    )
    .await;

    assert!(
        matches!(&refused, Err(CallError::Failure(failure)) if failure.detail() == "a payload is 8 bytes at most, not 13"),
        "refused, {refused:?}"
    );
    client.dispose().await;
}

#[tokio::test]
async fn takes_a_message_of_an_envelope_at_most_more_when_the_transport_says_so_and_never_less() {
    // envelopes of 256 bytes
    let small = RouterLimitsOptions {
        chunk_bytes: Some(128),
        maximum_envelope_bytes: Some(256),
        window_bytes: Some(256),
        ..RouterLimitsOptions::default()
    };
    let options_of =
        |limits: Option<RouterLimitsOptions>, maximum_message_bytes| WebSocketClientOptions {
            client: Some(crate::client::ClientOptions {
                limits,
                ..crate::client::ClientOptions::default()
            }),
            transport: Some(WebSocketTransportClientOptions {
                maximum_message_bytes,
                ..WebSocketTransportClientOptions::default()
            }),
        };

    for (limits, maximum_message_bytes, expected) in [
        (None, None, 16_778_240),
        (Some(small.clone()), None, 256),
        (Some(small.clone()), Some(1_024), 1_024),
    ] {
        assert_takes(expected, &options_of(limits, maximum_message_bytes)).await;
    }

    // a socket that cuts off what the router would take
    for (limits, maximum_message_bytes) in [(None, 256), (Some(small), 255)] {
        let refused = WebSocketClient::new(&options_of(limits, Some(maximum_message_bytes)))
            .expect_err("refused");

        assert!(
            refused
                .to_string()
                .contains("maximumMessageBytes is an envelope's limit at least"),
            "{refused}"
        );
    }
}

// ── Against a raw server ───────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn sends_a_request_as_an_envelope_resolves_with_its_result_and_learns_the_session() {
    let (client, mut raw) = raw_pair().await;
    let answering = call_of(&client, (&echo(), "hello"), &RequestOptions::default());
    let request = raw.next_envelope().await;

    assert_eq!(
        request,
        Envelope::Request {
            header: RequestHeader {
                call_id: 1,
                service_id: 1,
                procedure_id: 2,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"hello"),
        },
        "its request"
    );
    raw.send(&result_to(1, ("HELLO", Some(Credential::Opaque(token())))))
        .await;
    assert_eq!(
        outcome_of(answering, PATIENCE).await.ok(),
        Some("HELLO".to_owned()),
        "its result"
    );
    assert_eq!(
        client.router().session_token(),
        Some(token()),
        "its session"
    );
    client.dispose().await;
}

#[tokio::test]
async fn rejects_with_the_failure_the_server_answers_its_procedure_s_own_included() {
    let (client, mut raw) = raw_pair().await;
    let answering = call_of(&client, (&echo(), "hello"), &RequestOptions::default());
    let call_id = raw.next_envelope().await.call_id();

    raw.send(&Envelope::Failure {
        header: FailureHeader {
            call_id,
            credential: None,
        },
        failure: FailureRecord {
            code: core::num::NonZeroU16::new(21).expect("a code"),
            scope: FailureScope::Application,
            detail: "not ready".to_owned(),
            relays: 0,
        },
    })
    .await;

    let refused = outcome_of(answering, PATIENCE).await;
    let Err(CallError::Failure(failure)) = refused else {
        panic!("a failure, not {refused:?}");
    };

    assert_eq!(
        (
            failure.code().get(),
            failure.detail(),
            failure.origin(),
            failure.procedure(),
            failure.side()
        ),
        (
            21,
            "not ready",
            FailureOrigin::Peer,
            Some(ProcedureAddress {
                service_id: 1,
                procedure_id: 2
            }),
            Some(RouterSide::Server)
        ),
        "its failure"
    );
    assert!(failure.is_application_code(&[21]), "its procedure's own");
    client.dispose().await;
}

#[tokio::test]
async fn hears_the_notifications_of_its_subscription_under_the_call_id_that_opened_it_one_ahead_of_its_result_included()
 {
    let (client, mut raw) = raw_pair().await;
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&heard);
    let subscribing = client
        .services()
        .get_notification(&news(), NotificationDependencies::new(asked(), TextCodec))
        .expect("a notification")
        .register(
            "subscribe".to_owned(),
            Arc::new(move |payload| {
                locked(&hearing).push(payload);

                Box::pin(async { Ok(()) })
            }),
            &RegistrationOptions::default(),
        );
    let subscribing = crate::testing::spawn(subscribing);
    let call_id = raw.next_envelope().await.call_id();

    // sent right before the result: the subscription is bound before the request went out
    raw.send(&notification_on(call_id, "first")).await;
    raw.send(&result_to(call_id, ("", None))).await;

    let held = patience(PATIENCE, subscribing)
        .await
        .expect("in time")
        .expect("its task")
        .expect("subscribed");

    raw.send(&notification_on(call_id, "news")).await;
    assert!(
        eventually(|| *locked(&heard) == ["first", "news"]).await,
        "heard, {:?}",
        locked(&heard)
    );
    drop(held);
    client.dispose().await;
}

#[tokio::test]
async fn answers_the_server_s_commands_on_even_call_ids_with_the_resolver_registered() {
    let (client, mut raw) = raw_pair().await;

    client
        .services()
        .get_command_resolver(&ping(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");
    raw.send(&Envelope::Request {
        header: RequestHeader {
            call_id: 78,
            service_id: 1,
            procedure_id: 3,
            destination_id: None,
            opens_subscription: false,
            paced: false,
            total: None,
            credential: None,
        },
        payload: Bytes::from_static(b"quiet"),
    })
    .await;
    assert_eq!(
        raw.next_envelope().await,
        result_to(78, ("QUIET", None)),
        "its answer"
    );
    client.dispose().await;
}

#[tokio::test]
async fn cancels_a_request_whose_timeout_passes_and_hears_nothing_of_an_answer_too_late() {
    let (client, mut raw) = raw_pair().await;
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let erring = Arc::clone(&errors);

    client
        .router()
        .on_error(Arc::new(move |error: &RouterError| {
            locked(&erring).push(error.to_string());
        }));

    // a call id stays reserved as long as its call's timeout: long enough here for the late answer
    // to come back within it, and be known for late
    let answering = call_of(
        &client,
        (&echo(), "hello"),
        &RequestOptions {
            timeout: Some(Duration::from_millis(500)),
            ..RequestOptions::default()
        },
    );
    let call_id = raw.next_envelope().await.call_id();

    assert!(
        matches!(
            outcome_of(answering, PATIENCE).await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    assert_eq!(
        raw.next_envelope().await,
        Envelope::Cancel {
            header: CancelHeader { call_id: 1 },
        },
        "its cancel"
    );
    raw.send(&result_to(call_id, ("late", None))).await;

    // a call after it, answered on the same socket: its result read, the late answer was too
    let following = call_of(&client, (&echo(), "after"), &RequestOptions::default());
    let next = raw.next_envelope().await.call_id();

    raw.send(&result_to(next, ("AFTER", None))).await;
    assert_eq!(
        outcome_of(following, PATIENCE).await.ok(),
        Some("AFTER".to_owned()),
        "the one after"
    );
    assert!(locked(&errors).is_empty(), "{:?}", locked(&errors));
    client.dispose().await;
}

#[tokio::test]
async fn rejects_a_request_still_waiting_when_the_server_closes_the_connection() {
    let (client, mut raw) = raw_pair().await;
    let answering = call_of(&client, (&echo(), "hello"), &RequestOptions::default());

    raw.next_envelope().await;
    raw.socket
        .close(Some(CloseFrame {
            code: CloseCode::Away,
            reason: "".into(),
        }))
        .await
        .expect("closed");

    // its close answered, the server ends the socket, as ws ends it
    let ending = crate::testing::spawn(async move { while raw.socket.next().await.is_some() {} });

    disconnected_of(outcome_of(answering, PATIENCE).await);
    patience(PATIENCE, ending)
        .await
        .expect("ended in time")
        .expect("its task");
    client.dispose().await;
}

// ── Against the server an application starts from ──────────────────────────────────────────────

fn slow() -> Procedure {
    procedure(7, ("slow", Some(ProcedureKind::Request)))
}

// a server whose echo answers what it is asked, and whose slow call answers nothing until it is
// cancelled, counting each cancel its resolver hears; the C# side's run on the interop service
struct Served {
    server: WebSocketServer,
    port: u16,
    cancels: Arc<Mutex<u32>>,
    requested: Arc<tokio::sync::Notify>,
}

async fn served() -> Served {
    let server = server_with(&ServerOptions::default());
    let cancels: Arc<Mutex<u32>> = Arc::default();
    let requested = Arc::new(tokio::sync::Notify::new());
    let counting = Arc::clone(&cancels);
    let hearing = Arc::clone(&requested);

    server
        .services()
        .get_request_resolver(&echo(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(&slow(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, _| {
            let counting = Arc::clone(&counting);

            Box::pin(async move {
                request.signal.token().cancelled().await;
                add_one(&counting);

                Err(ResolverError::other("stopped"))
            })
        }))
        .expect("registered");
    // the next request the client's router sends, read by the server's router: what a test
    // cancels, stops or replaces after, never a delay that a loaded runner outlasts
    server
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if direction == DebugDirection::Rx
                && matches!(traced.header, crate::envelope::EnvelopeHeader::Request(_))
            {
                hearing.notify_one();
            }
        }));

    let port = port_of(&server).await;

    Served {
        server,
        port,
        cancels,
        requested,
    }
}

impl Served {
    async fn request_sent(&self) {
        patience(PATIENCE, self.requested.notified())
            .await
            .expect("a request in time");
    }

    async fn connected(&self) -> WebSocketClient {
        let client = client_with(&RouterLimitsOptions::default());

        connect(&client, self.port).await;

        client
    }
}

#[derive(Default)]
struct Closes(Mutex<Vec<(bool, bool)>>);

impl ClientListener for Closes {
    fn on_close(&self, was_clean: bool, is_quick: bool) {
        locked(&self.0).push((was_clean, is_quick));
    }
}

// the C# side's own: its router runs on its transport's clock
#[tokio::test]
async fn runs_its_router_on_its_transport_s_clock_which_times_a_request_out() {
    let served = served().await;
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let client = WebSocketClient::new(&WebSocketClientOptions {
        transport: Some(WebSocketTransportClientOptions {
            clock: Some(Arc::clone(&shared)),
            ..WebSocketTransportClientOptions::default()
        }),
        ..WebSocketClientOptions::default()
    })
    .expect("a client");

    assert!(
        Arc::ptr_eq(&client.router().clock(), &shared),
        "its router on its transport's clock"
    );
    connect(&client, served.port).await;

    // its timer is armed before its request goes out
    let slow_call = call_of(
        &client,
        (&slow(), "wait"),
        &RequestOptions {
            timeout: Some(Duration::from_secs(1)),
            ..RequestOptions::default()
        },
    );

    served.request_sent().await;
    clock.advance(Duration::from_secs(1)).await;
    assert!(
        matches!(
            outcome_of(slow_call, PATIENCE).await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn cancels_a_call_at_the_server_when_its_token_is_cancelled() {
    let served = served().await;
    let client = served.connected().await;
    let cancelling = CancellationToken::new();
    let slow_call = call_of(
        &client,
        (&slow(), "wait"),
        &RequestOptions {
            signal: Some(cancelling.clone()),
            ..RequestOptions::default()
        },
    );

    // ! cancelled once the request went out: a signal cancelled before cancels nothing at the
    // server
    served.request_sent().await;
    cancelling.cancel();
    assert!(
        matches!(
            outcome_of(slow_call, PATIENCE).await,
            Err(CallError::Cancelled(_))
        ),
        "cancelled"
    );
    // the server counts it once its resolver heard the cancel, which comes after the cancel itself
    assert!(
        eventually(|| *locked(&served.cancels) == 1).await,
        "heard at the server"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn takes_its_layers_apart_in_reverse_rejecting_what_waits_as_disposed_then_closing() {
    let served = served().await;
    let client = served.connected().await;
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let erring = Arc::clone(&errors);
    let closes = Arc::new(Closes::default());
    let slow_call = call_of(&client, (&slow(), "wait"), &RequestOptions::default());

    client
        .router()
        .on_error(Arc::new(move |error: &RouterError| {
            locked(&erring).push(error.to_string());
        }));
    client.transport().listen(Arc::<Closes>::clone(&closes));
    served.request_sent().await;
    patience(PATIENCE, client.dispose())
        .await
        .expect("disposed in time");
    assert_eq!(
        disconnected_of(outcome_of(slow_call, PATIENCE).await),
        "the router was disposed before the answer",
        "rejected as disposed"
    );
    assert_eq!(*locked(&closes.0), [(true, false)], "then closed, cleanly");
    assert!(locked(&errors).is_empty(), "{:?}", locked(&errors));
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn rejects_what_waits_once_the_server_stops() {
    let served = served().await;
    let client = served.connected().await;
    let closes = Arc::new(Closes::default());
    let slow_call = call_of(&client, (&slow(), "wait"), &RequestOptions::default());

    client.transport().listen(Arc::<Closes>::clone(&closes));
    served.request_sent().await;
    served.server.transport().stop().await.expect("stopped");
    disconnected_of(outcome_of(slow_call, PATIENCE).await);
    assert!(
        eventually(|| !locked(&closes.0).is_empty()).await,
        "its close told"
    );
    assert!(
        locked(&closes.0).iter().all(|(was_clean, _)| !was_clean),
        "unclean, {:?}",
        locked(&closes.0)
    );
    client.dispose().await;
    served.server.dispose().await.expect("disposed");
}

// the C# side's own
#[tokio::test]
async fn refuses_a_connect_while_open_and_a_message_limit_below_its_envelope_s() {
    let served = served().await;
    let client = served.connected().await;

    assert!(
        matches!(
            client
                .connect(&WebSocketTransportClientConnectOptions::new(
                    "127.0.0.1",
                    served.port
                ))
                .await,
            Err(TransportError::Refused(_))
        ),
        "a connect while open"
    );
    assert!(
        WebSocketClient::new(&WebSocketClientOptions {
            transport: Some(WebSocketTransportClientOptions {
                maximum_message_bytes: Some(64),
                ..WebSocketTransportClientOptions::default()
            }),
            ..WebSocketClientOptions::default()
        })
        .is_err(),
        "a message limit below its envelope's"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn connects_disconnects_and_reconnects_through_its_transport_with_the_options_given() {
    let served = served().await;
    let client = served.connected().await;
    let closes = Arc::new(Closes::default());

    client.transport().listen(Arc::<Closes>::clone(&closes));
    patience(
        PATIENCE,
        client
            .disconnect(&TransportClientDisconnectOptions {
                is_clean: Some(false),
                ..TransportClientDisconnectOptions::default()
            })
            .expect("open"),
    )
    .await
    .expect("closed in time");
    assert_eq!(*locked(&closes.0), [(false, false)], "its close told");
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "closed"
    );

    // the signal given reaches the transport, which refuses to start
    let cancelled = CancellationToken::new();

    cancelled.cancel();
    assert!(
        client
            .reconnect(&TransportClientReconnectOptions {
                signal: Some(cancelled),
                ..TransportClientReconnectOptions::default()
            })
            .is_err(),
        "refused"
    );
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "still closed"
    );
    patience(
        PATIENCE,
        client
            .reconnect(&TransportClientReconnectOptions {
                maximum_attempts: Some(1),
                ..TransportClientReconnectOptions::default()
            })
            .expect("reconnecting"),
    )
    .await
    .expect("in time")
    .expect("reconnected");
    assert_eq!(client.transport().ready_state(), ReadyState::Open, "open");
    assert_eq!(
        outcome_of(
            call_of(&client, (&echo(), "a"), &RequestOptions::default()),
            PATIENCE
        )
        .await
        .ok(),
        Some("a".to_owned()),
        "answered"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn a_dispose_cancels_a_reconnection_under_way_and_a_token_given_still_cancels_it_too() {
    let served = served().await;
    let client = served.connected().await;
    let other = served.connected().await;
    let signal = CancellationToken::new();
    let reconnecting = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
            60,
        ))),
        ..TransportClientReconnectOptions::default()
    };

    // nothing listens any more: each attempt fails, then waits a minute
    patience(PATIENCE, served.server.transport().stop())
        .await
        .expect("in time")
        .expect("stopped");

    let by_dispose = client.reconnect(&reconnecting).expect("reconnecting");
    let by_signal = other
        .reconnect(&TransportClientReconnectOptions {
            signal: Some(signal.clone()),
            ..reconnecting.clone()
        })
        .expect("reconnecting");

    client.dispose().await;
    signal.cancel();
    assert!(
        matches!(
            patience(PATIENCE, by_dispose).await.expect("in time"),
            Err(TransportError::Cancelled { .. })
        ),
        "cancelled by its dispose"
    );
    assert!(
        matches!(
            patience(PATIENCE, by_signal).await.expect("in time"),
            Err(TransportError::Cancelled { .. })
        ),
        "cancelled by its signal"
    );
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "closed"
    );
    assert_eq!(
        other.transport().ready_state(),
        ReadyState::Closed,
        "the other closed"
    );
    other.dispose().await;
    served.server.dispose().await.expect("disposed");
}

// the C# side's own
#[tokio::test]
async fn rejects_what_waits_as_replaced_once_its_transport_reconnects() {
    let served = served().await;
    let client = served.connected().await;
    let slow_call = call_of(&client, (&slow(), "wait"), &RequestOptions::default());

    served.request_sent().await;
    patience(
        PATIENCE,
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .expect("reconnecting"),
    )
    .await
    .expect("in time")
    .expect("reconnected");
    assert_eq!(
        disconnected_of(outcome_of(slow_call, PATIENCE).await),
        "the connection was replaced before the answer",
        "rejected as replaced"
    );
    assert_eq!(client.transport().ready_state(), ReadyState::Open, "open");
    assert_eq!(
        outcome_of(
            call_of(&client, (&echo(), "a"), &RequestOptions::default()),
            PATIENCE
        )
        .await
        .ok(),
        Some("a".to_owned()),
        "answered"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own: a call its transport refuses to send fails with the transport's refusal, as
// on this side's other transports
#[tokio::test]
async fn fails_a_send_before_it_connects() {
    let unconnected = client_with(&RouterLimitsOptions::default());
    let failed = outcome_of(
        call_of(&unconnected, (&echo(), "a"), &RequestOptions::default()),
        PATIENCE,
    )
    .await;

    assert!(
        matches!(&failed, Err(CallError::Other(refusal)) if refusal.downcast_ref::<crate::errors::ReadyStateError>().is_some()),
        "failed unsent, {failed:?}"
    );
    unconnected.dispose().await;
}

// this side's own: the client's runtime is its transport's, every layer on it
#[test]
fn hands_its_runtime_to_its_transport_every_layer_on_it() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime");
    let client = WebSocketClient::new(&WebSocketClientOptions {
        client: Some(crate::client::ClientOptions {
            runtime: Some(runtime.handle().clone()),
            ..crate::client::ClientOptions::default()
        }),
        ..WebSocketClientOptions::default()
    })
    .expect("built outside any runtime, on the one given");
    let served = runtime.block_on(served());

    runtime.block_on(connect(&client, served.port));
    assert_eq!(
        runtime
            .block_on(outcome_of(
                call_of(&client, (&echo(), "a"), &RequestOptions::default()),
                PATIENCE,
            ))
            .ok(),
        Some("a".to_owned()),
        "answered"
    );
    runtime.block_on(client.dispose());
    runtime.block_on(served.server.dispose()).expect("stopped");
}
