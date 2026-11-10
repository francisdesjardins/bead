//! The twins of `http-server.test.ts` and `HttpServerTests`: the server an application starts
//! from, against the client it starts from, a server of the tests' own and raw sockets.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use sha2::{Digest, Sha256};

use super::*;
use crate::constants::{ProtocolCode, RouterSide};
use crate::errors::ResolverError;
use crate::failure::FailureOrigin;
use crate::http::fields::{BEAD_MEDIA_TYPE, CONNECTION_TOKEN_HEADER, REFUSAL_HEADER};
use crate::managers::notification::PacingLimitsOptions;
use crate::managers::service::{
    CommandOptions, NotificationDependencies, NotificationResolverDependencies, Notifier,
    NotifyOptions, RegistrationOptions,
};
use crate::payloads::RawCodec;
use crate::router::admissions::{require_session, share_leg_b_session};
use crate::router::relay::{DestinationOptions, RelayOptions, RelayTarget};
use crate::router::types::{
    AccessRefusal, AccessRefusalStage, ConnectionHandle, RouterLimitsOptions, SignalReason,
};
use crate::server::ServerOptions;
use crate::testing::SteppingClock;
use crate::testing::wire::{Exchange, ExchangeOptions};
use crate::transport::{ClientListener, RouterClientTransport, ServerTransport};

fn notified() -> NotificationResolverDependencies<TextCodec, TextCodec, TextCodec> {
    NotificationResolverDependencies::new(text(), TextCodec)
}

fn subscribed() -> NotificationDependencies<TextCodec, TextCodec, TextCodec> {
    NotificationDependencies::new(asked(), TextCodec)
}

fn digest_of(bytes: &[u8]) -> String {
    crate::testing::hexadecimal::text_of(&Sha256::digest(bytes))
        .replace(' ', "")
        .to_ascii_lowercase()
}

fn code_of<T: core::fmt::Debug>(outcome: &Result<T, CallError>) -> Option<core::num::NonZeroU16> {
    match outcome {
        Err(CallError::Failure(failure)) => Some(failure.code()),
        _ => None,
    }
}

// a subscription its client dropped: its procedure's name, and the failure's code that ended it
type Dropped = (String, Option<core::num::NonZeroU16>);

// what `connect_http` builds beside its defaults
#[derive(Default)]
struct Given {
    is_listening: Option<bool>,
    server: Option<HttpServerOptions>,
    session_inactivity_timeout: Option<Duration>,
}

// an HTTP server on a free port — a session opened by `openSession`, of the session inactivity
// timeout given, `read` behind it, `upload` answering its payload's digest, `slow` waiting on its
// signal, `news` a subscription, its relay lending leg B's session to a requester in a session, as
// a hub's — and an HTTP client connected to it
struct Connected {
    server: HttpServer,
    client: HttpClient,
    port: u16,
    // the reasons of the calls to slow whose signal was cancelled
    aborted: Arc<Mutex<Vec<Option<SignalReason>>>>,
    news: Notifier<TextCodec>,
}

impl Connected {
    // taken apart once each layer keeps nothing of the client gone
    async fn end(self) {
        self.client.dispose().await;
        at_rest(&self.server).await;
        self.server.dispose().await.expect("stopped");
    }

    fn first_handle(&self) -> ConnectionHandle {
        Arc::clone(
            &self
                .server
                .transport()
                .clients()
                .first()
                .expect("a connection")
                .connection_handle,
        )
    }
}

async fn connect_http(given: Given) -> Connected {
    let mut options = given.server.unwrap_or_default();
    let mut server_options = options.server.clone().unwrap_or_default();

    if server_options.relay.is_none() {
        server_options.relay = Some(RelayOptions {
            before_route: Some(share_leg_b_session()),
            ..RelayOptions::default()
        });
    }

    options.server = Some(server_options);

    let server = HttpServer::new(&options).expect("a server");
    let sessions = server.sessions().clone();
    let session_inactivity_timeout = given.session_inactivity_timeout;
    let aborted: Arc<Mutex<Vec<Option<SignalReason>>>> = Arc::default();
    let aborting = Arc::clone(&aborted);

    server
        .services()
        .get_request_resolver(&open_session(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let mut session_made = sessions.create(request.connection_handle);

            session_made.session_inactivity_timeout = session_inactivity_timeout;

            let stored = sessions.set(session_made).expect("a session");

            Box::pin(async move {
                stored.await.map_err(ResolverError::other)?;

                response.result("opened".to_owned()).await
            })
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(
            &read(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..text()
            },
        )
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            Box::pin(async move {
                // the later a call comes, the sooner it answers: the answers come out of order
                rest(Duration::from_millis(request.payload.parse().unwrap_or(0))).await;

                response.result(request.payload).await
            })
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(
            &upload(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..RequestResolverDependencies::new(RawCodec, RawCodec)
            },
        )
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(Bytes::from(digest_of(&request.payload)))
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(&slow(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, _| {
            let aborting = Arc::clone(&aborting);

            Box::pin(async move {
                request.signal.token().cancelled().await;
                locked(&aborting).push(request.signal.reason());

                Err(ResolverError::other("stopped"))
            })
        }))
        .expect("registered");

    let news = server
        .services()
        .get_notification_resolver(&news(), notified())
        .expect("a resolver")
        .on(Arc::new(|_, response| {
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;

                response.result("subscribed".to_owned()).await
            })
        }))
        .expect("registered");
    let port = port_of(&server).await;
    let client = client_of((given.is_listening.unwrap_or(true), None));

    connect(&client, port).await;

    Connected {
        server,
        client,
        port,
        aborted,
        news,
    }
}

// the head of a `POST` from a client behind a proxy that names `forwarded`, the fields given
fn post_head_of((port, forwarded): (u16, Option<&str>), (fields, length): (&str, usize)) -> String {
    let forwarded = forwarded.map_or_else(String::new, |by| format!("X-Forwarded-For: {by}\r\n"));

    format!(
        "POST /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\nContent-Type: {BEAD_MEDIA_TYPE}\r\n{forwarded}{fields}Content-Length: {length}\r\n\r\n"
    )
}

async fn exchange_of(port: u16, request: &[u8]) -> Exchange {
    Exchange::open(
        request,
        &ExchangeOptions::new(std::net::SocketAddr::from(([127, 0, 0, 1], port))),
    )
    .await
    .expect("sent")
}

// a connection drawn by hand: its token
async fn drawn_by_hand(port: u16) -> String {
    let drawn = exchange_of(port, post_head_of((port, None), ("", 0)).as_bytes()).await;
    let head = drawn.head(PATIENCE).await.expect("drawn");

    head.fields[CONNECTION_TOKEN_HEADER].clone()
}

// the connection drawn by hand, ended by hand
async fn deleted_by_hand(port: u16, token: &str) {
    let deleted = exchange_of(
        port,
        format!(
            "DELETE /bead HTTP/1.1\r\nHost: {HOST}:{port}\r\n{CONNECTION_TOKEN_HEADER}: {token}\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;

    deleted.head(PATIENCE).await.expect("deleted");
}

fn request_bytes(call_id: u32, (procedure, payload): (&Procedure, &[u8])) -> Vec<u8> {
    crate::envelope::write_envelope(
        &crate::envelope::Envelope::Request {
            header: crate::envelope::RequestHeader {
                call_id,
                service_id: procedure.service_id,
                procedure_id: procedure.procedure_id,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
                credential: None,
            },
            payload: Bytes::copy_from_slice(payload),
        },
        1_024,
    )
    .expect("written")
    .to_vec()
}

// ── An HTTP server and client ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn open_a_session_by_a_request_and_answer_within_it_refusing_before_it() {
    let connected = connect_http(Given::default()).await;
    let client = &connected.client;

    assert_eq!(
        code_of(&ask(client, (&read(), "0"), &RequestOptions::default()).await),
        Some(ProtocolCode::SESSION_REQUIRED.get()),
        "refused before its session"
    );
    assert_eq!(
        ask(client, (&open_session(), "me"), &RequestOptions::default())
            .await
            .ok(),
        Some("opened".to_owned()),
        "opened"
    );
    // the session announced on that answer, and kept by the connection drawn
    assert!(client.router().session_token().is_some(), "its token");
    assert_eq!(
        ask(client, (&read(), "0"), &RequestOptions::default())
            .await
            .ok(),
        Some("0".to_owned()),
        "answered within it"
    );

    // each layer counts the one connection, the transport's own counts among them, and holds up
    let gauges = connected.server.gauges().await.expect("its gauges");

    assert_eq!(
        [
            gauges.transport.counts.get("connections"),
            gauges.server.counts.get("connections"),
            gauges.sessions.counts.get("sessions"),
        ],
        [Some(&1); 3],
        "one connection, one session"
    );
    assert_eq!(
        connected.server.health().await.expect("its health").status,
        HealthStatus::Pass,
        "its health"
    );
    connected.end().await;
}

#[tokio::test]
async fn answer_calls_in_flight_together_each_by_its_own_call_id_whatever_the_order_they_end_in() {
    let connected = connect_http(Given::default()).await;
    let client = &connected.client;

    ask(client, (&open_session(), "me"), &RequestOptions::default())
        .await
        .expect("a session");

    let reading = read();
    let options = RequestOptions::default();
    let answered = futures_util::future::join_all(
        ["60", "30", "0"].map(|wait| ask(client, (&reading, wait), &options)),
    )
    .await;

    assert_eq!(
        answered.into_iter().map(Result::ok).collect::<Vec<_>>(),
        ["60", "30", "0"].map(|wait| Some(wait.to_owned())),
        "each by its own call id"
    );
    connected.end().await;
}

#[tokio::test]
async fn upload_8_mib_in_one_exchange_and_refuse_on_the_client_what_one_envelope_cannot_hold() {
    let connected = connect_http(Given::default()).await;
    let client = &connected.client;
    let payload: Bytes = (0..8 * 1_048_576_usize)
        .map(|index| u8::try_from(index % 251).unwrap_or_default())
        .collect();

    ask(client, (&open_session(), "me"), &RequestOptions::default())
        .await
        .expect("a session");

    let uploading = client
        .services()
        .get_request(&upload(), RequestDependencies::new(RawCodec, RawCodec))
        .expect("a requester");
    let uploaded = uploading
        .call(
            payload.clone(),
            &RequestOptions {
                timeout: Some(Duration::from_secs(30)),
                ..RequestOptions::default()
            },
        )
        .expect("a call");

    assert_eq!(
        outcome_of(uploaded, Duration::from_secs(60)).await.ok(),
        Some(Bytes::from(digest_of(&payload))),
        "its digest"
    );
    assert_eq!(
        (
            client.router().limits().maximum_transfers,
            connected.server.router().limits().maximum_transfers
        ),
        (0, 0),
        "no transfer either way"
    );

    // no transfer over HTTP: past what one envelope holds, refused before anything goes
    let small = client_of((
        true,
        Some(RouterLimitsOptions {
            maximum_envelope_bytes: Some(1_024),
            ..RouterLimitsOptions::default()
        }),
    ));

    connect(&small, connected.port).await;
    ask(&small, (&open_session(), "me"), &RequestOptions::default())
        .await
        .expect("a session");

    let refused = outcome_of(
        small
            .services()
            .get_request(&upload(), RequestDependencies::new(RawCodec, RawCodec))
            .expect("a requester")
            .call(Bytes::from(vec![0; 2_000]), &RequestOptions::default())
            .expect("a call"),
        PATIENCE,
    )
    .await;
    let Err(CallError::Failure(refused)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (refused.code(), refused.detail(), refused.origin()),
        (
            ProtocolCode::PAYLOAD_TOO_LARGE.get(),
            "a payload of 2000 bytes goes as a transfer, which this side sends none of",
            FailureOrigin::Local
        ),
        "refused before it goes"
    );
    small.dispose().await;
    connected.end().await;
}

#[tokio::test]
async fn cancel_a_call_on_its_server_when_it_times_out_on_the_client() {
    let connected = connect_http(Given::default()).await;

    // long enough for the call to reach the server before its cancel, which goes on a request of
    // its own
    assert!(
        matches!(
            ask(
                &connected.client,
                (&slow(), "wait"),
                &RequestOptions {
                    timeout: Some(Duration::from_millis(500)),
                    ..RequestOptions::default()
                }
            )
            .await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    assert!(
        eventually(|| *locked(&connected.aborted) == [Some(SignalReason::Cancelled)]).await,
        "cancelled on its server"
    );
    connected.end().await;
}

#[tokio::test]
async fn refuse_a_subscription_to_a_client_that_does_not_listen_which_nothing_brings_back_and_a_command_which_nothing_carries()
 {
    let connected = connect_http(Given {
        is_listening: Some(false),
        ..Given::default()
    })
    .await;
    let refused = patience(
        PATIENCE,
        connected
            .client
            .services()
            .get_notification(&news(), subscribed())
            .expect("a notification")
            .register(
                "subscribe".to_owned(),
                Arc::new(|_| Box::pin(async { Ok(()) })),
                &RegistrationOptions::default(),
            ),
    )
    .await
    .expect("in time");
    let Err(CallError::Failure(refused)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (refused.code(), refused.side()),
        (
            ProtocolCode::SUBSCRIPTION_UNSUPPORTED.get(),
            Some(RouterSide::Server)
        ),
        "its subscription"
    );

    let commanded = connected
        .server
        .services()
        .get_command(&ping(), asked())
        .expect("a command")
        .call(
            "ping".to_owned(),
            &CommandOptions {
                timeout: Some(Duration::from_secs(1)),
                ..CommandOptions::new(connected.first_handle())
            },
        );
    let outcome = match commanded {
        Ok(call) => outcome_of(call, PATIENCE)
            .await
            .map(drop)
            .map_err(|error| error.to_string()),
        Err(refused) => Err(refused.to_string()),
    };

    assert!(
        outcome
            .as_ref()
            .is_err_and(|error| error.contains("this connection does not listen")),
        "its command, {outcome:?}"
    );
    connected.end().await;
}

#[derive(Default)]
struct Closes(Mutex<Vec<(bool, bool)>>);

impl ClientListener for Closes {
    fn on_close(&self, was_clean: bool, is_quick: bool) {
        locked(&self.0).push((was_clean, is_quick));
    }
}

#[tokio::test]
async fn close_a_connection_that_opened_no_session_within_its_timeout_30_s_by_default() {
    // a client that does not listen: one that does holds a listen, which is no silence
    let connected = connect_http(Given {
        is_listening: Some(false),
        server: Some(HttpServerOptions {
            server: Some(ServerOptions {
                connection_inactivity_timeout: Some(Duration::from_millis(50)),
                ..ServerOptions::default()
            }),
            ..HttpServerOptions::default()
        }),
        ..Given::default()
    })
    .await;
    let closes = Arc::new(Closes::default());

    connected
        .client
        .transport()
        .listen(Arc::<Closes>::clone(&closes));

    // the connection is gone: the next exchange learns it, and the client closes
    assert!(
        eventually(|| connected.server.transport().clients().is_empty()).await,
        "its connection gone"
    );
    ask(
        &connected.client,
        (&read(), "0"),
        &RequestOptions::default(),
    )
    .await
    .ok();
    assert!(
        eventually(|| !locked(&closes.0).is_empty()).await,
        "its close told"
    );
    assert_eq!(*locked(&closes.0), [(false, false)], "unclean");
    connected.end().await;

    // by default, the timer a connection arms on a server built with no timeout, on the clock its
    // transport is given
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let server = HttpServer::new(&HttpServerOptions {
        transport: Some(crate::http::server::HttpTransportServerOptions {
            clock: Some(Arc::<SteppingClock>::clone(&clock)),
            ..crate::http::server::HttpTransportServerOptions::default()
        }),
        ..HttpServerOptions::default()
    })
    .expect("a server");
    let port = port_of(&server).await;
    let token = drawn_by_hand(port).await;

    assert!(
        eventually(|| clock
            .dues()
            .contains(&super::super::CONNECTION_INACTIVITY_TIMEOUT))
        .await,
        "its timer armed, among {:?}",
        clock.dues()
    );
    assert_eq!(
        super::super::CONNECTION_INACTIVITY_TIMEOUT,
        Duration::from_secs(30),
        "30 s"
    );
    deleted_by_hand(port, &token).await;
    server.dispose().await.expect("stopped");
}

#[tokio::test]
async fn end_a_session_past_its_session_timeout_while_its_client_holds_a_listen_which_brings_back_the_failure_of_its_subscription_the_connection_staying()
 {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let connected = connect_http(Given {
        server: Some(HttpServerOptions {
            transport: Some(crate::http::server::HttpTransportServerOptions {
                clock: Some(Arc::<SteppingClock>::clone(&clock)),
                ..crate::http::server::HttpTransportServerOptions::default()
            }),
            ..HttpServerOptions::default()
        }),
        session_inactivity_timeout: Some(Duration::from_secs(1)),
        ..Given::default()
    })
    .await;
    let dropped: Arc<Mutex<Vec<Dropped>>> = Arc::default();
    let dropping = Arc::clone(&dropped);

    connected
        .client
        .services()
        .on_dropped(Arc::new(move |procedure: &Procedure, failure| {
            locked(&dropping).push((
                procedure.procedure_name.clone(),
                failure.map(crate::failure::Failure::code),
            ));
        }));
    ask(
        &connected.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");
    patience(
        PATIENCE,
        connected
            .client
            .services()
            .get_notification(&news(), subscribed())
            .expect("a notification")
            .register(
                "subscribe".to_owned(),
                Arc::new(|_| Box::pin(async { Ok(()) })),
                &RegistrationOptions::default(),
            ),
    )
    .await
    .expect("in time")
    .expect("subscribed");

    // the client holds a listen, which the server's clock, the test's, never ends by itself
    let listens = || {
        connected
            .server
            .transport()
            .gauges()
            .and_then(|gauges| gauges.counts.get("listens").copied())
    };

    assert!(eventually(|| listens() == Some(1)).await, "a listen held");
    clock.advance(Duration::from_secs(1)).await;
    assert!(
        eventually(|| !locked(&dropped).is_empty()).await,
        "its subscription dropped"
    );
    assert_eq!(
        *locked(&dropped),
        [(
            "news".to_owned(),
            Some(ProtocolCode::SESSION_REQUIRED.get())
        )],
        "by the session's end"
    );
    assert!(
        connected.server.sessions().all().await.is_empty(),
        "no session"
    );
    assert_eq!(
        connected.server.transport().clients().len(),
        1,
        "the connection staying"
    );
    connected.end().await;
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "its subscription, its command and its relay, as the other sides' twins hold them"
)]
async fn bring_a_client_that_listens_what_the_server_sends_of_its_own_a_subscription_s_notifications_a_command_a_call_relayed_to_it()
 {
    let connected = connect_http(Given::default()).await;
    let handle = connected.first_handle();
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&heard);
    let subscription = patience(
        PATIENCE,
        connected
            .client
            .services()
            .get_notification(&news(), subscribed())
            .expect("a notification")
            .register(
                "subscribe".to_owned(),
                Arc::new(move |notification: String| {
                    locked(&hearing).push(notification);

                    Box::pin(async { Ok(()) })
                }),
                &RegistrationOptions::default(),
            ),
    )
    .await
    .expect("in time")
    .expect("subscribed");

    connected
        .news
        .notify("first".to_owned(), &NotifyOptions::default())
        .await;
    connected
        .news
        .notify("second".to_owned(), &NotifyOptions::default())
        .await;
    assert!(
        eventually(|| *locked(&heard) == ["first", "second"]).await,
        "its notifications, {:?}",
        locked(&heard)
    );

    // the server asks, and the client answers
    connected
        .client
        .services()
        .get_command_resolver(&ping(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(format!("{} pong", request.payload))
        }))
        .expect("registered");

    let commanded = connected
        .server
        .services()
        .get_command(&ping(), asked())
        .expect("a command")
        .call(
            "ping".to_owned(),
            &CommandOptions {
                timeout: Some(Duration::from_secs(5)),
                ..CommandOptions::new(Arc::clone(&handle))
            },
        )
        .expect("a call");

    assert_eq!(
        outcome_of(commanded, PATIENCE).await.ok(),
        Some("ping pong".to_owned()),
        "commanded"
    );

    // a call another client makes, relayed to this one
    connected
        .client
        .services()
        .get_command_resolver(&echo(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");
    connected
        .server
        .router()
        .register_destination(
            RelayTarget::Connection(handle),
            &DestinationOptions {
                destination_id: Some(5),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");

    let requester = client_of((true, None));

    connect(&requester, connected.port).await;
    ask(
        &requester,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");
    assert_eq!(
        ask(
            &requester,
            (&echo(), "hi"),
            &RequestOptions {
                destination_id: Some(5),
                ..RequestOptions::default()
            }
        )
        .await
        .ok(),
        Some("HI".to_owned()),
        "relayed"
    );
    requester.dispose().await;
    drop(subscription);
    connected.end().await;
}

#[cfg(feature = "websocket")]
#[tokio::test]
async fn relay_a_call_from_an_http_requester_to_a_target_behind_a_websocket_once_a_session_admits_it()
 {
    use crate::websocket::client::WebSocketTransportClientConnectOptions;
    use crate::websocket::facade::{
        WebSocketClient, WebSocketClientOptions, WebSocketServer, WebSocketServerOptions,
    };

    let target = WebSocketServer::new(&WebSocketServerOptions::default()).expect("a target");
    let target_port = patience(PATIENCE, target.transport().start(&loopback()))
        .await
        .expect("in time")
        .expect("started")
        .port;
    let to_target = WebSocketClient::new(&WebSocketClientOptions::default()).expect("a client");

    target
        .services()
        .get_request_resolver(&echo(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");
    patience(
        PATIENCE,
        to_target.connect(&WebSocketTransportClientConnectOptions::new(
            HOST,
            target_port,
        )),
    )
    .await
    .expect("in time")
    .expect("connected");

    let connected = connect_http(Given::default()).await;
    let seven = RequestOptions {
        destination_id: Some(7),
        ..RequestOptions::default()
    };

    connected
        .server
        .router()
        .register_destination(
            to_target.router().as_relay_target(),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");
    assert_eq!(
        code_of(&ask(&connected.client, (&echo(), "hi"), &seven).await),
        Some(ProtocolCode::SESSION_REQUIRED.get()),
        "refused before its session"
    );
    ask(
        &connected.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");
    assert_eq!(
        ask(&connected.client, (&echo(), "hi"), &seven).await.ok(),
        Some("HI".to_owned()),
        "relayed"
    );
    connected.end().await;
    to_target.dispose().await;
    target.dispose().await.expect("stopped");
}

#[tokio::test]
async fn pass_nothing_on_to_a_connection_drawn_over_http_whose_client_does_not_listen_which_takes_no_request_of_the_server_s()
 {
    let connected = connect_http(Given {
        is_listening: Some(false),
        ..Given::default()
    })
    .await;

    connected
        .server
        .router()
        .register_destination(
            RelayTarget::Connection(connected.first_handle()),
            &DestinationOptions {
                destination_id: Some(9),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");
    ask(
        &connected.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let refused = ask(
        &connected.client,
        (&echo(), "hi"),
        &RequestOptions {
            destination_id: Some(9),
            ..RequestOptions::default()
        },
    )
    .await;
    let Err(CallError::Failure(refused)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (refused.code(), refused.detail()),
        (
            ProtocolCode::DESTINATION_UNREACHABLE.get(),
            "destination 9 is unreachable: its connection carries no request"
        ),
        "unreachable"
    );
    connected.end().await;
}

#[tokio::test]
async fn relay_a_call_whose_leg_b_goes_over_http_refused_there_nothing_tried_lost_there_it_may_have_run()
 {
    let connected = connect_http(Given::default()).await;
    // leg B's server: the connect drawn, its first request refused busy, its second lost
    let script = scripted(Arc::new(|_: &Heard, rank| match rank {
        0 => drawn(),
        1 => answer_of(429, (&[(REFUSAL_HEADER, "busy")], &[])),
        _ => Scripted::Lose,
    }))
    .await;
    let leg_b = client_of((false, None));

    connect(&leg_b, script.port).await;
    connected
        .server
        .router()
        .register_destination(
            leg_b.router().as_relay_target(),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");
    ask(
        &connected.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let seven = RequestOptions {
        destination_id: Some(7),
        ..RequestOptions::default()
    };
    let failure_of = |outcome: Result<String, CallError>| match outcome {
        Err(CallError::Failure(failure)) => (failure.code(), failure.relays()),
        other => panic!("a failure, not {other:?}"),
    };

    assert_eq!(
        failure_of(ask(&connected.client, (&echo(), "hi"), &seven).await),
        (ProtocolCode::DESTINATION_UNREACHABLE.get(), 0),
        "refused there, nothing tried"
    );
    assert_eq!(
        failure_of(ask(&connected.client, (&echo(), "hi"), &seven).await),
        (ProtocolCode::DESTINATION_LOST.get(), 0),
        "lost there, it may have run"
    );
    assert_eq!(script.heard().len(), 3, "a connect and two requests");
    leg_b.dispose().await;
    connected.end().await;
}

#[tokio::test]
async fn refuse_a_body_past_the_envelope_its_router_takes_413_before_the_router_reads_any_of_it() {
    let connected = connect_http(Given {
        server: Some(HttpServerOptions {
            server: Some(ServerOptions {
                limits: Some(RouterLimitsOptions {
                    maximum_envelope_bytes: Some(1_024),
                    ..RouterLimitsOptions::default()
                }),
                ..ServerOptions::default()
            }),
            ..HttpServerOptions::default()
        }),
        ..Given::default()
    })
    .await;
    let port = connected.port;
    let token = drawn_by_hand(port).await;
    let mut request = post_head_of(
        (port, None),
        (&format!("{CONNECTION_TOKEN_HEADER}: {token}\r\n"), 1_025),
    )
    .into_bytes();

    request.extend_from_slice(&[0; 1_025]);

    let refused = exchange_of(port, &request).await;
    let outcome = match refused.head(PATIENCE).await {
        Ok(head) => format!(
            "{} {}",
            head.status,
            head.fields
                .get(REFUSAL_HEADER)
                .map_or("null", String::as_str)
        ),
        Err(_) if refused.is_lost() => "reset".to_owned(),
        Err(error) => error,
    };

    // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
    assert!(
        ["413 too-large", "reset"].contains(&outcome.as_str()),
        "refused, {outcome}"
    );
    deleted_by_hand(port, &token).await;
    connected.end().await;
}

#[tokio::test]
async fn give_its_transport_maximum_waiting_exchanges_from_its_router_s_maximum_answering_calls_unless_given()
 {
    // its transport's default, given, is given
    for (given, taken) in [(None, 1), (Some(2), 2), (Some(64), 64)] {
        let connected = connect_http(Given {
            server: Some(HttpServerOptions {
                server: Some(ServerOptions {
                    limits: Some(RouterLimitsOptions {
                        maximum_answering_calls: Some(1),
                        ..RouterLimitsOptions::default()
                    }),
                    ..ServerOptions::default()
                }),
                transport: Some(crate::http::server::HttpTransportServerOptions {
                    maximum_waiting_exchanges: given,
                    ..crate::http::server::HttpTransportServerOptions::default()
                }),
            }),
            ..Given::default()
        })
        .await;
        let port = connected.port;
        let token = drawn_by_hand(port).await;
        let mut statuses = Vec::new();
        let mut held = Vec::new();

        for call_id in [1, 3] {
            let body = request_bytes(call_id, (&slow(), &[]));
            let mut request = post_head_of(
                (port, None),
                (
                    &format!("{CONNECTION_TOKEN_HEADER}: {token}\r\n"),
                    body.len(),
                ),
            )
            .into_bytes();

            request.extend_from_slice(&body);

            let exchange = exchange_of(port, &request).await;
            let answered = exchange.head(PATIENCE).await.expect("its head");

            statuses.push(format!(
                "{} {}",
                answered.status,
                answered
                    .fields
                    .get(REFUSAL_HEADER)
                    .map_or("null", String::as_str)
            ));
            held.push(exchange);
        }

        // past the calls its router answers at once, its transport refuses 429 first
        assert_eq!(
            statuses,
            if taken == 1 {
                ["200 null", "429 busy"]
            } else {
                ["200 null", "200 null"]
            },
            "{given:?}"
        );

        // the connection drawn by hand, ended by hand, which ends its calls
        deleted_by_hand(port, &token).await;

        for exchange in held {
            exchange.destroy();
        }

        connected.end().await;
    }
}

#[tokio::test]
async fn build_its_router_with_the_pacing_its_options_give() {
    let server = HttpServer::new(&HttpServerOptions {
        server: Some(ServerOptions {
            pacing: Some(PacingLimitsOptions {
                maximum_queued_notifications: Some(3),
                ..PacingLimitsOptions::default()
            }),
            ..ServerOptions::default()
        }),
        ..HttpServerOptions::default()
    })
    .expect("a server");

    assert_eq!(
        server
            .gauges()
            .await
            .expect("its gauges")
            .router
            .ceilings
            .get("largestQueuedNotifications"),
        Some(&3),
        "its pacing"
    );
    server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn refuse_limits_that_ask_for_a_transfer() {
    let transfers = Some(RouterLimitsOptions {
        maximum_transfers: Some(2),
        ..RouterLimitsOptions::default()
    });

    assert!(
        HttpServer::new(&HttpServerOptions {
            server: Some(ServerOptions {
                limits: transfers.clone(),
                ..ServerOptions::default()
            }),
            ..HttpServerOptions::default()
        })
        .is_err(),
        "the server"
    );
    assert!(
        HttpClient::new(&HttpClientOptions {
            client: Some(crate::client::ClientOptions {
                limits: transfers,
                ..crate::client::ClientOptions::default()
            }),
            ..HttpClientOptions::default()
        })
        .is_err(),
        "the client"
    );
}

#[tokio::test]
async fn refuse_an_inactivity_timeout_of_0_which_its_default_does_not_stand_in_for() {
    let refused = HttpServer::new(&HttpServerOptions {
        server: Some(ServerOptions {
            connection_inactivity_timeout: Some(Duration::ZERO),
            ..ServerOptions::default()
        }),
        ..HttpServerOptions::default()
    })
    .expect_err("refused");

    assert_eq!(
        refused.to_string(),
        "a connection's inactivity timeout is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not 0 milliseconds",
        "refused as spec 1.4 holds it"
    );
}

#[tokio::test]
async fn tells_over_http_the_address_and_port_of_the_exchange_refused_not_its_connect_s() {
    let server = HttpServer::new(&HttpServerOptions {
        transport: Some(crate::http::server::HttpTransportServerOptions {
            trusted_proxies: Some(vec![HOST.to_owned()]),
            ..crate::http::server::HttpTransportServerOptions::default()
        }),
        ..HttpServerOptions::default()
    })
    .expect("a server");
    let told: Arc<Mutex<Vec<AccessRefusal>>> = Arc::default();
    let telling = Arc::clone(&told);

    server
        .services()
        .get_request_resolver(
            &read(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..text()
            },
        )
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered");
    server
        .router()
        .on_access_refused(Arc::new(move |refusal: &AccessRefusal| {
            locked(&telling).push(refusal.clone());
        }));

    let port = port_of(&server).await;
    // a request written raw on a socket of its own, from behind a proxy that names `forwarded`
    let drawn = exchange_of(
        port,
        post_head_of((port, Some("192.0.2.1")), ("", 0)).as_bytes(),
    )
    .await;
    let token = drawn.head(PATIENCE).await.expect("drawn").fields[CONNECTION_TOKEN_HEADER].clone();
    let body = request_bytes(1, (&read(), &[]));
    let mut request = post_head_of(
        (port, Some("198.51.100.7")),
        (
            &format!("{CONNECTION_TOKEN_HEADER}: {token}\r\n"),
            body.len(),
        ),
    )
    .into_bytes();

    request.extend_from_slice(&body);

    let refused = exchange_of(port, &request).await;

    refused.head(PATIENCE).await.expect("answered");
    assert!(eventually(|| locked(&told).len() == 1).await, "told once");

    let refusal = locked(&told).remove(0);

    assert_eq!(
        (
            refusal.address.as_deref(),
            refusal.code,
            refusal.port,
            refusal.reason.as_deref(),
            refusal.stage
        ),
        (
            Some("198.51.100.7"),
            ProtocolCode::SESSION_REQUIRED.get().get(),
            Some(refused.local_port()),
            Some("requireSession"),
            AccessRefusalStage::Admission
        ),
        "the exchange refused"
    );
    assert_ne!(refusal.port, Some(drawn.local_port()), "not its connect's");
    drawn.destroy();
    refused.destroy();
    server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "its leg B's server and its two credentials, as the C# side's test holds them"
)]
async fn writes_the_authorization_of_a_relayed_request_to_leg_b_as_it_came_over_http() {
    const TOKEN: &str =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJhdWQiOiJiZWFkLWludGVyb3AifQ.c2ln";

    let connected = connect_http(Given::default()).await;
    // leg B's server: the connect drawn, then each request answered with its own payload
    let script = scripted(Arc::new(|heard: &Heard, rank| {
        if rank == 0 {
            return drawn();
        }

        request_in(&heard.body).map_or(Scripted::Lose, |(call_id, payload)| {
            answer_of(
                200,
                (
                    &[("content-type", BEAD_MEDIA_TYPE)],
                    &result_of(call_id, &payload),
                ),
            )
        })
    }))
    .await;
    // leg B, an HTTP client on the loopback — secure, and carrying a credential — to a destination
    // that verifies an audience
    let leg_b = client_of((false, None));

    connect(&leg_b, script.port).await;
    connected
        .server
        .router()
        .register_destination(
            leg_b.router().as_relay_target(),
            &DestinationOptions {
                destination_id: Some(7),
                audience: Some("bead-interop".to_owned()),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");

    // what leg B's server read of the request of rank `rank`: its Authorization, the credential
    // its block holds, and its destination
    let posted = |rank: usize| {
        let heard = script.heard().get(rank).cloned().expect("posted");
        let header = match crate::envelope::read_envelope(
            &Bytes::from(heard.body.clone()),
            RouterSide::Server,
            &crate::envelope::ReadEnvelopeOptions::default(),
        ) {
            Ok(Some(crate::envelope::Envelope::Request { header, .. })) => header,
            other => panic!("a request, not {other:?}"),
        };

        (
            heard.field("authorization").map(str::to_owned),
            header.credential,
            header.destination_id,
        )
    };
    let relayed = |credential: crate::router::types::RequestCredential| RequestOptions {
        destination_id: Some(7),
        credential: Some(credential),
        ..RequestOptions::default()
    };

    // an ELSEWHERE: leg A's Authorization written to leg B's as it came, the block holding nothing
    assert_eq!(
        ask(
            &connected.client,
            (&echo(), "hi"),
            &relayed(crate::router::types::RequestCredential::Elsewhere(
                "Interop  sub=ada".to_owned()
            ))
        )
        .await
        .ok(),
        Some("hi".to_owned()),
        "answered"
    );
    assert_eq!(
        posted(1),
        (
            Some("Interop  sub=ada".to_owned()),
            Some(crate::envelope::Credential::Elsewhere),
            None
        ),
        "an ELSEWHERE"
    );

    // a JWT: its same bytes in the block, and no Authorization, which leg A's never had
    assert_eq!(
        ask(
            &connected.client,
            (&echo(), "ho"),
            &relayed(crate::router::types::RequestCredential::Jwt(
                TOKEN.to_owned()
            ))
        )
        .await
        .ok(),
        Some("ho".to_owned()),
        "answered"
    );
    assert_eq!(
        posted(2),
        (
            None,
            Some(crate::envelope::Credential::Jwt(Bytes::from_static(
                TOKEN.as_bytes()
            ))),
            None
        ),
        "a JWT"
    );
    assert_eq!(script.heard().len(), 3, "nothing more posted");
    leg_b.dispose().await;
    connected.end().await;
}
