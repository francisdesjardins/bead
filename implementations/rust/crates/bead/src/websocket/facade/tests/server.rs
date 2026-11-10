//! The twins of `websocket-server.test.ts` and `WebSocketServerTests`: the server an application
//! starts from, against the client it starts from and raw sockets.

use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio_util::sync::CancellationToken;
use tungstenite::protocol::Message;

use super::*;
use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::errors::ResolverError;
use crate::failure::FailureOrigin;
use crate::managers::notification::PacingLimitsOptions;
use crate::managers::service::{
    CommandOptions, NotificationCallback, NotificationDependencies,
    NotificationResolverDependencies, Notifier, NotifyOptions, RegistrationOptions,
    RequestDependencies, RequestOptions, RequestResolverDependencies,
};
use crate::payloads::{RawCodec, TextCodec};
use crate::router::admissions::{
    BeforeRequest, require_credential, require_session, share_leg_b_session,
};
use crate::router::core::AdmissionRequest;
use crate::router::relay::{DestinationOptions, RelayOptions, RelayTarget};
use crate::router::types::{
    CallAddress, ConnectionHandle, RouterError, RouterLimitsOptions, SignalReason, TransportMessage,
};
use crate::testing::SteppingClock;
use crate::transport::{
    ClientListener, ReadyState, RouterClientTransport, ServerListener, ServerTransport,
};
use crate::websocket::server::WebSocketTransportServerOptions;

// envelopes of 1 024 bytes, a window of 8 KiB
fn small() -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(1_024),
        maximum_envelope_bytes: Some(1_024),
        window_bytes: Some(8_192),
        ..RouterLimitsOptions::default()
    }
}

fn text() -> RequestResolverDependencies<TextCodec, TextCodec> {
    RequestResolverDependencies::new(TextCodec, TextCodec)
}

fn bytes() -> RequestResolverDependencies<RawCodec, RawCodec> {
    RequestResolverDependencies::new(RawCodec, RawCodec)
}

fn asked() -> RequestDependencies<TextCodec, TextCodec> {
    RequestDependencies::new(TextCodec, TextCodec)
}

fn bytes_asked() -> RequestDependencies<RawCodec, RawCodec> {
    RequestDependencies::new(RawCodec, RawCodec)
}

fn notified() -> NotificationResolverDependencies<TextCodec, TextCodec, TextCodec> {
    NotificationResolverDependencies::new(text(), TextCodec)
}

fn subscribed() -> NotificationDependencies<TextCodec, TextCodec, TextCodec> {
    NotificationDependencies::new(asked(), TextCodec)
}

fn is_credit(direction: DebugDirection, traced: &TracedEnvelope) -> bool {
    direction == DebugDirection::Tx && traced.header.kind() == EnvelopeKind::Credit
}

fn code_of<T: core::fmt::Debug>(outcome: &Result<T, CallError>) -> Option<core::num::NonZeroU16> {
    match outcome {
        Err(CallError::Failure(failure)) => Some(failure.code()),
        _ => None,
    }
}

// a request of `text` to `procedure` through `client`'s services, as it is called
async fn ask(
    client: &WebSocketClient,
    (procedure, value): (&Procedure, &str),
    options: &RequestOptions,
) -> Result<String, CallError> {
    let call = client
        .services()
        .get_request(procedure, asked())
        .expect("a requester")
        .call(value.to_owned(), options)
        .expect("a call");

    outcome_of(call, PATIENCE).await
}

// answers `procedure` with what `answer` makes of its payload
fn serve(server: &WebSocketServer, (procedure, answer): (&Procedure, fn(String) -> String)) {
    server
        .services()
        .get_request_resolver(procedure, text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            response.result(answer(request.payload))
        }))
        .expect("registered");
}

// a resolver of `procedure` that opens a session for its connection, its timeouts as given, and
// answers its token
fn open_sessions(
    server: &WebSocketServer,
    (connection, session): (Option<Duration>, Option<Duration>),
) {
    let sessions = server.sessions().clone();

    server
        .services()
        .get_request_resolver(&open_session(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let mut session_made = sessions.create(request.connection_handle);

            session_made.connection_inactivity_timeout = connection;
            session_made.session_inactivity_timeout = session;

            let stored = sessions.set(session_made).expect("a session");

            Box::pin(async move {
                let stored = stored.await.map_err(ResolverError::other)?;

                response
                    .result(
                        stored
                            .session_token
                            .map(|token| token.to_string())
                            .unwrap_or_default(),
                    )
                    .await
            })
        }))
        .expect("registered");
}

// what each message an end took weighs, and each credit its router sent
#[derive(Default)]
struct Counted {
    taken_by_server: Mutex<Vec<usize>>,
    taken_by_client: Mutex<Vec<usize>>,
    credited_by_server: Mutex<Vec<u32>>,
    credited_by_client: Mutex<Vec<u32>>,
}

struct ServerTaking(Arc<Counted>);

impl ServerListener for ServerTaking {
    fn on_message(&self, message: TransportMessage, _handle: &ConnectionHandle) {
        locked(&self.0.taken_by_server).push(message.data.len());
    }
}

struct ClientTaking(Arc<Counted>);

impl ClientListener for ClientTaking {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.0.taken_by_client).push(message.data.len());
    }
}

// a server and its client, and, for a relay, the device behind it and the client that reaches it;
// taken apart as the other sides' fixtures do: the client, then the server once at rest
struct Ends {
    server: WebSocketServer,
    client: WebSocketClient,
    device: Option<WebSocketServer>,
    to_device: Option<WebSocketClient>,
    counted: Arc<Counted>,
}

impl Ends {
    async fn end(self) {
        self.client.dispose().await;
        at_rest(&self.server).await;
        self.server.dispose().await.expect("stopped");

        if let Some(to_device) = &self.to_device {
            to_device.dispose().await;
        }

        if let Some(device) = &self.device {
            device.dispose().await.expect("stopped");
        }
    }
}

// a server and a client, each with its limits, connected, which record the bytes of every message
// they take, and each credit they send
// the limits of each end, the defaults' where they say nothing
#[derive(Default)]
struct EndsLimits {
    client: RouterLimitsOptions,
    server: RouterLimitsOptions,
}

async fn connect_with(limits: &EndsLimits) -> Ends {
    let ends = Ends {
        server: server_with(&ServerOptions {
            limits: Some(limits.server.clone()),
            ..ServerOptions::default()
        }),
        client: client_with(&limits.client),
        device: None,
        to_device: None,
        counted: Arc::default(),
    };
    let port = port_of(&ends.server).await;
    let counted = Arc::clone(&ends.counted);

    ends.server
        .transport()
        .listen(Arc::new(ServerTaking(Arc::clone(&counted))));
    ends.client
        .transport()
        .listen(Arc::new(ClientTaking(Arc::clone(&counted))));

    let by_server = Arc::clone(&counted);

    ends.server
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if is_credit(direction, traced) {
                locked(&by_server.credited_by_server).push(traced.header.call_id());
            }
        }));

    let by_client = Arc::clone(&counted);

    ends.client
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if is_credit(direction, traced) {
                locked(&by_client.credited_by_client).push(traced.header.call_id());
            }
        }));
    connect(&ends.client, port).await;

    ends
}

// a relay's server — relaying as `relay` says, or lending leg B's session to a requester in a
// session, as a hub does — with a device behind it at destination 7, and a client connected to it;
// every router under `limits`. The TypeScript side's leg B is a pipe to a bare router; here, as on
// the C# side, the device is a server of its own, reached by a client's router registered as the
// destination
// how a relay's ends are built: every router's limits, and the relay's own options, a hub's when
// none
#[derive(Default)]
struct Relayed {
    limits: RouterLimitsOptions,
    relay: Option<RelayOptions>,
}

async fn connect_relayed(relayed: &Relayed) -> Ends {
    let limits = &relayed.limits;
    let device = server_with(&ServerOptions {
        limits: Some(limits.clone()),
        ..ServerOptions::default()
    });
    let to_device = client_with(limits);
    let server = server_with(&ServerOptions {
        limits: Some(limits.clone()),
        relay: Some(relayed.relay.clone().unwrap_or_else(|| RelayOptions {
            before_route: Some(share_leg_b_session()),
            ..RelayOptions::default()
        })),
        ..ServerOptions::default()
    });

    connect(&to_device, port_of(&device).await).await;
    server
        .router()
        .register_destination(
            to_device.router().as_relay_target(),
            &DestinationOptions {
                destination_id: Some(7),
                label: Some("the device".to_owned()),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");
    open_sessions(&server, (Some(crate::NEVER), Some(crate::NEVER)));

    let client = client_with(limits);

    connect(&client, port_of(&server).await).await;

    Ends {
        server,
        client,
        device: Some(device),
        to_device: Some(to_device),
        counted: Arc::default(),
    }
}

fn seven() -> RequestOptions {
    RequestOptions {
        destination_id: Some(7),
        ..RequestOptions::default()
    }
}

// a raw client's socket, upgraded
type Raw = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

async fn raw_client(port: u16) -> Raw {
    let socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connected");
    let (client, _) = patience(
        PATIENCE,
        tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/"), socket),
    )
    .await
    .expect("upgraded in time")
    .expect("upgraded");

    client
}

// reads what comes until its server's close, and gives its code
async fn close_of(socket: &mut Raw) -> Option<u16> {
    patience(PATIENCE, async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Close(frame) = message {
                return frame.map(|frame| u16::from(frame.code));
            }
        }

        None
    })
    .await
    .expect("closed in time")
}

fn options_of(
    maximum_message_bytes: Option<u64>,
    limits: &RouterLimitsOptions,
) -> WebSocketServerOptions {
    WebSocketServerOptions {
        server: Some(ServerOptions {
            limits: Some(limits.clone()),
            ..ServerOptions::default()
        }),
        transport: Some(WebSocketTransportServerOptions {
            maximum_message_bytes,
            ..WebSocketTransportServerOptions::default()
        }),
    }
}

struct Delivered(tokio::sync::mpsc::UnboundedSender<usize>);

impl ServerListener for Delivered {
    fn on_message(&self, message: TransportMessage, _handle: &ConnectionHandle) {
        self.0.send(message.data.len()).ok();
    }
}

// a message of `bytes` is delivered whole, and one byte more closes its connection with 1009
async fn assert_takes(bytes: usize, options: &WebSocketServerOptions) {
    let server = WebSocketServer::new(options).expect("a server");
    let (delivering, mut delivered) = tokio::sync::mpsc::unbounded_channel();

    server.transport().listen(Arc::new(Delivered(delivering)));

    let mut socket = raw_client(port_of(&server).await).await;

    socket
        .send(Message::Binary(Bytes::from(vec![0_u8; bytes])))
        .await
        .expect("sent");
    assert_eq!(
        patience(PATIENCE, delivered.recv()).await.expect("in time"),
        Some(bytes),
        "a message of {bytes} bytes delivered"
    );
    socket
        .send(Message::Binary(Bytes::from(vec![
            0_u8;
            bytes.saturating_add(1)
        ])))
        .await
        .expect("sent");
    assert_eq!(close_of(&mut socket).await, Some(1_009), "one byte more");
    server.dispose().await.expect("stopped");
}

// ── What it builds ─────────────────────────────────────────────────────────────────────────────

// the TypeScript side takes a factory for each layer; this side builds its own
#[tokio::test]
async fn builds_on_a_websocket_transport_server_not_yet_started_with_the_layers_given() {
    let server = server_with(&ServerOptions {
        limits: Some(RouterLimitsOptions {
            maximum_payload_bytes: Some(8),
            ..RouterLimitsOptions::default()
        }),
        ..ServerOptions::default()
    });

    assert_eq!(
        server.transport().ready_state(),
        ReadyState::Uninitialized,
        "not yet started"
    );
    assert_eq!(
        server.router().transport().transport_type(),
        Some(crate::websocket::server::TRANSPORT_WEBSOCKET),
        "its router on its transport"
    );
    assert!(server.sessions().all().await.is_empty(), "no session");
    // the router is built with the server's limits
    assert_eq!(
        server.router().limits().maximum_payload_bytes,
        8,
        "its limits"
    );
    server.dispose().await.expect("disposed");
}

// the C# side's own: no layer is given a clock of its own but its transport's
#[tokio::test]
async fn runs_every_layer_on_its_transport_s_clock_and_refuses_another() {
    let clock: SharedClock = SteppingClock::new(crate::testing::instants::new_year());
    let server = WebSocketServer::new(&WebSocketServerOptions {
        transport: Some(WebSocketTransportServerOptions {
            clock: Some(Arc::clone(&clock)),
            ..WebSocketTransportServerOptions::default()
        }),
        ..WebSocketServerOptions::default()
    })
    .expect("a server");

    assert!(
        Arc::ptr_eq(&server.router().clock(), &clock),
        "its router on its transport's clock"
    );
    assert!(
        WebSocketServer::new(&WebSocketServerOptions {
            server: Some(ServerOptions {
                clock: Some(clock),
                ..ServerOptions::default()
            }),
            ..WebSocketServerOptions::default()
        })
        .is_err(),
        "a clock its transport does not run on, refused"
    );
    server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn takes_a_message_of_an_envelope_at_most_more_when_the_transport_says_so_and_never_less() {
    // envelopes of 256 bytes; the transport's options are its own, so a raw socket finds its limit
    let small = RouterLimitsOptions {
        chunk_bytes: Some(128),
        maximum_envelope_bytes: Some(256),
        window_bytes: Some(256),
        ..RouterLimitsOptions::default()
    };

    let none = RouterLimitsOptions::default();

    for (limits, maximum_message_bytes, expected) in [
        (&none, None, 16_778_240),
        (&small, None, 256),
        (&small, Some(1_024), 1_024),
    ] {
        assert_takes(expected, &options_of(maximum_message_bytes, limits)).await;
    }

    // a socket that cuts off what the router would take
    for (limits, maximum_message_bytes) in [(&none, 256), (&small, 255)] {
        let refused = WebSocketServer::new(&options_of(Some(maximum_message_bytes), limits))
            .expect_err("refused");

        assert!(
            refused
                .to_string()
                .contains("maximumMessageBytes is an envelope's limit at least"),
            "{refused}"
        );
    }
}

#[tokio::test]
async fn builds_its_router_with_the_pacing_its_options_give() {
    let server = server_with(&ServerOptions {
        pacing: Some(PacingLimitsOptions {
            maximum_queued_notification_bytes: Some(2_048),
            maximum_queued_notifications: Some(3),
            ..PacingLimitsOptions::default()
        }),
        ..ServerOptions::default()
    });
    let ceilings = server.gauges().await.expect("its gauges").router.ceilings;

    assert_eq!(
        (
            ceilings.get("largestQueuedNotificationBytes"),
            ceilings.get("largestQueuedNotifications")
        ),
        (Some(&2_048), Some(&3)),
        "its pacing"
    );
    server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn closes_with_1009_a_connection_that_sends_more_than_maximum_message_bytes() {
    let server = WebSocketServer::new(&options_of(
        Some(256),
        &RouterLimitsOptions {
            chunk_bytes: Some(128),
            maximum_envelope_bytes: Some(256),
            window_bytes: Some(256),
            ..RouterLimitsOptions::default()
        },
    ))
    .expect("a server");
    let mut socket = raw_client(port_of(&server).await).await;

    socket
        .send(Message::Binary(Bytes::from(vec![0_u8; 257])))
        .await
        .expect("sent");
    assert_eq!(close_of(&mut socket).await, Some(1_009), "closed with 1009");
    server.dispose().await.expect("stopped");
}

#[tokio::test]
async fn closes_a_client_that_lets_a_command_go_unanswered_when_told_to() {
    let ends = Ends {
        server: server_with(&ServerOptions {
            close_on_command_timeout: Some(true),
            ..ServerOptions::default()
        }),
        client: client_with(&RouterLimitsOptions::default()),
        device: None,
        to_device: None,
        counted: Arc::default(),
    };
    let port = port_of(&ends.server).await;
    let (opening, opened) = tokio::sync::oneshot::channel::<ConnectionHandle>();
    let opening = Mutex::new(Some(opening));

    ends.server
        .services()
        .get_request_resolver(&open_session(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let opening = locked(&opening).take();

            if let Some(opening) = opening {
                opening.send(request.connection_handle).ok();
            }

            response.result(String::new())
        }))
        .expect("registered");
    // a client that takes the command and never answers it
    ends.client
        .services()
        .get_command_resolver(&ping(), text())
        .expect("a resolver")
        .on(Arc::new(|_, _| Box::pin(core::future::pending())))
        .expect("registered");
    connect(&ends.client, port).await;
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let handle = opened.await.expect("opened");
    let commanded = ends
        .server
        .services()
        .get_command(&ping(), asked())
        .expect("a command")
        .call(
            "ping".to_owned(),
            &CommandOptions {
                timeout: Some(Duration::from_millis(50)),
                ..CommandOptions::new(handle)
            },
        )
        .expect("a call");

    assert!(
        matches!(
            outcome_of(commanded, PATIENCE).await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    assert!(
        eventually(|| ends.client.transport().ready_state() == ReadyState::Closed).await,
        "its client closed"
    );
    ends.end().await;
}

// ── Transfers ──────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn carry_20_mib_both_ways_a_request_its_result_a_command_and_its_answer_in_messages_of_a_chunk_at_most()
 {
    let limits = RouterLimitsOptions {
        maximum_payload_bytes: Some(32 * 1_048_576),
        ..RouterLimitsOptions::default()
    };
    let ends = connect_with(&EndsLimits {
        client: limits.clone(),
        server: limits,
    })
    .await;
    let [request, result, command, answer] =
        [1, 2, 3, 4].map(|index| pattern_of(20 * MEBIBYTE + index));
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let (opening, opened) = tokio::sync::oneshot::channel::<ConnectionHandle>();
    let opening = Mutex::new(Some(opening));
    let (by_server, answered_with) = (Arc::clone(&heard), result.clone());

    ends.server
        .services()
        .get_request_resolver(&echo(), bytes())
        .expect("a resolver")
        .on(Arc::new(move |asked, response| {
            let opening = locked(&opening).take();

            if let Some(opening) = opening {
                opening.send(asked.connection_handle).ok();
            }

            locked(&by_server).push(digest_of(&asked.payload));
            response.result(answered_with.clone())
        }))
        .expect("registered");

    let (by_client, answering_with) = (Arc::clone(&heard), answer.clone());

    ends.client
        .services()
        .get_command_resolver(&ping(), bytes())
        .expect("a resolver")
        .on(Arc::new(move |asked, response| {
            locked(&by_client).push(digest_of(&asked.payload));
            response.result(answering_with.clone())
        }))
        .expect("registered");

    // the clock is no part of it: a generous timeout
    let resulted = ends
        .client
        .services()
        .get_request(&echo(), bytes_asked())
        .expect("a requester")
        .call(
            request.clone(),
            &RequestOptions {
                timeout: Some(GENEROUS),
                ..RequestOptions::default()
            },
        )
        .expect("a call");
    let resulted = outcome_of(resulted, GENEROUS).await.expect("its result");
    let commanded = ends
        .server
        .services()
        .get_command(&ping(), bytes_asked())
        .expect("a command")
        .call(
            command.clone(),
            &CommandOptions {
                timeout: Some(GENEROUS),
                ..CommandOptions::new(opened.await.expect("opened"))
            },
        )
        .expect("a call");
    let answered = outcome_of(commanded, GENEROUS).await.expect("its answer");

    assert_eq!(
        [digest_of(&resulted), digest_of(&answered)],
        [digest_of(&result), digest_of(&answer)],
        "both answers whole"
    );
    assert_eq!(
        *locked(&heard),
        [digest_of(&request), digest_of(&command)],
        "both asks whole"
    );

    let largest = locked(&ends.counted.taken_by_server)
        .iter()
        .chain(locked(&ends.counted.taken_by_client).iter())
        .copied()
        .max();

    assert!(
        largest.is_some_and(|largest| largest <= MEBIBYTE),
        "messages of a chunk at most, {largest:?}"
    );
    ends.end().await;
}

#[tokio::test]
async fn refuse_20_mib_with_the_limits_by_default_here_sending_nothing() {
    let ends = connect_with(&EndsLimits::default()).await;
    let call = ends
        .client
        .services()
        .get_request(&echo(), bytes_asked())
        .expect("a requester")
        .call(pattern_of(20 * MEBIBYTE), &RequestOptions::default())
        .expect("a call");
    let refused = outcome_of(call, PATIENCE).await;
    let Err(CallError::Failure(failure)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (failure.code(), failure.detail()),
        (
            ProtocolCode::PAYLOAD_TOO_LARGE.get(),
            "a payload is 16777216 bytes at most, not 20971520"
        ),
        "its failure"
    );
    assert!(
        locked(&ends.counted.taken_by_server).is_empty(),
        "nothing sent"
    );
    ends.end().await;
}

#[tokio::test]
async fn carry_100_kib_over_envelopes_of_1_024_bytes_both_ways_credited_many_times() {
    let ends = connect_with(&EndsLimits {
        client: small(),
        server: small(),
    })
    .await;
    let (request, result) = (pattern_of(102_400), pattern_of(102_401));
    let answered_with = result.clone();

    ends.server
        .services()
        .get_request_resolver(&echo(), bytes())
        .expect("a resolver")
        .on(Arc::new(move |_, response| {
            response.result(answered_with.clone())
        }))
        .expect("registered");

    let call = ends
        .client
        .services()
        .get_request(&echo(), bytes_asked())
        .expect("a requester")
        .call(request, &RequestOptions::default())
        .expect("a call");
    let resulted = outcome_of(call, PATIENCE).await.expect("its result");

    assert_eq!(digest_of(&resulted), digest_of(&result), "its result whole");

    let largest = locked(&ends.counted.taken_by_server)
        .iter()
        .chain(locked(&ends.counted.taken_by_client).iter())
        .copied()
        .max();

    assert!(
        largest.is_some_and(|largest| largest <= 1_024),
        "messages of an envelope at most, {largest:?}"
    );
    assert!(
        locked(&ends.counted.credited_by_server).len() > 1,
        "the server credited many times"
    );
    assert!(
        locked(&ends.counted.credited_by_client).len() > 1,
        "the client credited many times"
    );
    ends.end().await;
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "each refusal's resolver registered, as the other sides' twins register them"
)]
async fn refuse_a_transfer_at_its_opening_its_route_its_admission_its_size_its_connection_s_capacity_before_any_credit()
 {
    let ends = connect_with(&EndsLimits {
        client: small(),
        server: RouterLimitsOptions {
            maximum_transfers: Some(1),
            ..small()
        },
    })
    .await;
    let named = |id, name: &str| Procedure {
        procedure_id: id,
        procedure_name: name.to_owned(),
        ..echo()
    };
    let (held, refusing, limited, unknown) = (
        named(10, "held"),
        named(11, "refusing"),
        named(12, "limited"),
        named(13, "unknown"),
    );
    let (holding, mut held_now) = tokio::sync::mpsc::unbounded_channel::<()>();
    let taken: Arc<Mutex<BTreeMap<u32, Vec<EnvelopeKind>>>> = Arc::default();
    let credited: Arc<Mutex<BTreeSet<u32>>> = Arc::default();
    let (taking, crediting) = (Arc::clone(&taken), Arc::clone(&credited));

    ends.server
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if direction == DebugDirection::Rx {
                locked(&taking)
                    .entry(traced.header.call_id())
                    .or_default()
                    .push(traced.header.kind());
            } else if traced.header.kind() == EnvelopeKind::Credit {
                locked(&crediting).insert(traced.header.call_id());
            }
        }));
    // taken whole, then held: its place on the connection stays until its call ends
    ends.server
        .services()
        .get_request_resolver(&held, bytes())
        .expect("a resolver")
        .on(Arc::new(move |_, _| {
            holding.send(()).ok();

            Box::pin(core::future::pending())
        }))
        .expect("registered");
    ends.server
        .services()
        .get_request_resolver(
            &refusing,
            RequestResolverDependencies {
                before_request: Some(BeforeRequest::new(|_| false, None)),
                ..bytes()
            },
        )
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result(Bytes::new())))
        .expect("registered");
    // the server's own limit: the client's copy of the procedure has none
    ends.server
        .services()
        .get_request_resolver(
            &Procedure {
                maximum_payload_bytes: Some(1_024),
                ..limited.clone()
            },
            bytes(),
        )
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result(Bytes::new())))
        .expect("registered");
    ends.server
        .services()
        .get_request_resolver(&echo(), bytes())
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result(Bytes::new())))
        .expect("registered");

    let ask_of = |procedure: &Procedure| {
        ends.client
            .services()
            .get_request(procedure, bytes_asked())
            .expect("a requester")
            .call(pattern_of(102_400), &RequestOptions::default())
            .expect("a call")
    };
    let first = ask_of(&held);

    patience(PATIENCE, held_now.recv())
        .await
        .expect("held in time");

    // asked in order, so their call ids are 3, 5, 7 and 9
    let calls: Vec<_> = [unknown, refusing, limited, echo()]
        .iter()
        .map(ask_of)
        .collect();
    let mut refused = Vec::new();

    for call in calls {
        refused.push(code_of(&outcome_of(call, PATIENCE).await));
    }

    assert_eq!(
        refused,
        [
            ProtocolCode::PROCEDURE_UNKNOWN,
            ProtocolCode::ACCESS_DENIED,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            ProtocolCode::CAPACITY_EXCEEDED,
        ]
        .map(|code| Some(code.get())),
        "each refused at its opening"
    );

    // the server took each opening alone, and credited none
    for call_id in [3, 5, 7, 9] {
        assert_eq!(
            locked(&taken).get(&call_id),
            Some(&vec![EnvelopeKind::Request]),
            "{call_id} taken alone"
        );
        assert!(
            !locked(&credited).contains(&call_id),
            "{call_id} credited none"
        );
    }

    drop(first);
    ends.end().await;
}

// ── A relay ────────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn relay_a_call_to_the_device_once_a_session_admits_it_and_bring_back_the_device_s_own_failure_one_relay_more()
 {
    let ends = connect_relayed(&Relayed::default()).await;
    let device = ends.device.as_ref().expect("a device");
    // the scheme of the credential each envelope the device took presented, none for none
    let presented: Arc<Mutex<Vec<Option<crate::constants::CredentialScheme>>>> = Arc::default();
    let presenting = Arc::clone(&presented);

    device
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if direction == DebugDirection::Rx {
                locked(&presenting).push(traced.credential_scheme);
            }
        }));
    serve(device, (&echo(), |payload| payload.to_uppercase()));

    // a relay is a door: without a session, nothing goes through it, and the device sees nothing
    let shut = ask(&ends.client, (&echo(), "hi"), &seven()).await;
    let Err(CallError::Failure(shut)) = shut else {
        panic!("refused, not {shut:?}");
    };

    assert_eq!(
        (shut.code(), shut.relays(), shut.origin()),
        (ProtocolCode::SESSION_REQUIRED.get(), 0, FailureOrigin::Peer),
        "no session, no relay"
    );
    assert!(locked(&presented).is_empty(), "the device saw nothing");
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");
    assert_eq!(
        ask(&ends.client, (&echo(), "hi"), &seven()).await.ok(),
        Some("HI".to_owned()),
        "relayed"
    );

    let refused = ask(
        &ends.client,
        (
            &Procedure {
                procedure_id: 99,
                procedure_name: "unknown".to_owned(),
                ..echo()
            },
            "hi",
        ),
        &seven(),
    )
    .await;
    let Err(CallError::Failure(refused)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (
            refused.code(),
            refused.destination_id(),
            refused.relays(),
            refused.origin(),
            refused.side()
        ),
        (
            ProtocolCode::PROCEDURE_UNKNOWN.get(),
            Some(7),
            1,
            FailureOrigin::Relayed,
            None
        ),
        "the device's own failure, one relay more"
    );
    // the protocol's code, from behind the relay, whose side no one knows
    assert_eq!(refused.scope(), FailureScope::Protocol, "the protocol's");
    assert!(
        refused.is_protocol_code(&[ProtocolCode::PROCEDURE_UNKNOWN])
            && !refused
                .is_protocol_code_from(&[ProtocolCode::PROCEDURE_UNKNOWN], RouterSide::Server),
        "no side"
    );
    // the client's session stays on leg A: none crosses to the device
    assert_eq!(*locked(&presented), [None, None], "no credential crossed");
    ends.end().await;
}

#[tokio::test]
async fn relay_as_the_server_s_options_say_an_admission_of_the_application_s_own_no_session_asked()
{
    let ends = connect_relayed(&Relayed {
        relay: Some(RelayOptions {
            before_route: Some(BeforeRequest::new(
                |request: &AdmissionRequest| request.header.destination_id == Some(7),
                None,
            )),
            ..RelayOptions::default()
        }),
        ..Relayed::default()
    })
    .await;

    serve(
        ends.device.as_ref().expect("a device"),
        (&echo(), |payload| payload.to_uppercase()),
    );
    assert_eq!(
        ask(&ends.client, (&echo(), "hi"), &seven()).await.ok(),
        Some("HI".to_owned()),
        "admitted"
    );
    assert_eq!(
        code_of(
            &ask(
                &ends.client,
                (&echo(), "hi"),
                &RequestOptions {
                    destination_id: Some(8),
                    ..RequestOptions::default()
                }
            )
            .await
        ),
        Some(ProtocolCode::ACCESS_DENIED.get()),
        "refused"
    );
    ends.end().await;
}

// spec 14.7; the TypeScript side's own
#[tokio::test]
async fn a_before_route_that_reads_the_destination_admits_a_requester_in_a_session_only_to_the_destinations_its_session_names()
 {
    let sign_in = procedure(20, ("signIn", Some(ProcedureKind::Request)));
    // a requester reaches a destination its session names, or forwards a credential its
    // destination verifies
    let forwards = require_credential().admission(RouterSide::Server);
    let is_admitted = move |request: &AdmissionRequest| {
        matches!(forwards(request), Ok(None))
            || request
                .session
                .as_ref()
                .and_then(|session| session.data.as_ref())
                .and_then(serde_json::Value::as_array)
                .zip(request.header.destination_id)
                .is_some_and(|(devices, destination)| {
                    devices.contains(&serde_json::json!(destination))
                })
    };
    let ends = connect_relayed(&Relayed {
        relay: Some(RelayOptions {
            before_route: Some(BeforeRequest::new(is_admitted, None)),
            ..RelayOptions::default()
        }),
        ..Relayed::default()
    })
    .await;
    let sessions = ends.server.sessions().clone();

    ends.server
        .services()
        .get_request_resolver(&sign_in, text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let mut session = sessions.create(request.connection_handle);

            session.connection_inactivity_timeout = Some(crate::NEVER);
            session.session_inactivity_timeout = Some(crate::NEVER);
            session.data = Some(serde_json::json!([7]));

            let stored = sessions.set(session).expect("a session");

            Box::pin(async move {
                stored.await.map_err(ResolverError::other)?;
                response.result(String::new()).await
            })
        }))
        .expect("registered");

    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&heard);

    ends.device
        .as_ref()
        .expect("a device")
        .services()
        .get_request_resolver(&echo(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            locked(&hearing).push(request.payload.clone());
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");

    // a composition answers ACCESS_DENIED without the default's detail
    let denied = |outcome: &Result<String, CallError>| match outcome {
        Err(CallError::Failure(failure)) => Some((
            failure.code(),
            failure.detail().to_owned(),
            failure.relays(),
        )),
        _ => None,
    };
    let denial = Some((ProtocolCode::ACCESS_DENIED.get(), String::new(), 0));

    // in no session, nothing goes through
    assert_eq!(
        denied(&ask(&ends.client, (&echo(), "before"), &seven()).await),
        denial,
        "no session"
    );
    ask(&ends.client, (&sign_in, "ada"), &RequestOptions::default())
        .await
        .expect("signed in");
    // the destination its session names, and no other, registered or not
    assert_eq!(
        ask(&ends.client, (&echo(), "named"), &seven()).await.ok(),
        Some("NAMED".to_owned()),
        "the destination it names"
    );
    assert_eq!(
        denied(
            &ask(
                &ends.client,
                (&echo(), "other"),
                &RequestOptions {
                    destination_id: Some(8),
                    ..RequestOptions::default()
                }
            )
            .await
        ),
        denial,
        "no other"
    );
    assert_eq!(*locked(&heard), ["named"], "what the device heard");
    ends.end().await;
}

#[tokio::test]
async fn relay_100_kib_each_way_as_transfers_on_each_leg_put_together_at_the_relay() {
    let ends = connect_relayed(&Relayed {
        limits: small(),
        ..Relayed::default()
    })
    .await;
    let (request, result) = (pattern_of(102_400), pattern_of(102_401));
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let leg_a: Arc<Mutex<u32>> = Arc::default();
    let leg_b: Arc<Mutex<u32>> = Arc::default();
    let (counting_a, counting_b, hearing, answered_with) = (
        Arc::clone(&leg_a),
        Arc::clone(&leg_b),
        Arc::clone(&heard),
        result.clone(),
    );

    ends.server
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if is_credit(direction, traced) {
                add_one(&counting_a);
            }
        }));
    ends.to_device
        .as_ref()
        .expect("a client to the device")
        .router()
        .on_debug(Arc::new(move |direction, traced: &TracedEnvelope| {
            if is_credit(direction, traced) {
                add_one(&counting_b);
            }
        }));
    ends.device
        .as_ref()
        .expect("a device")
        .services()
        .get_request_resolver(&echo(), bytes())
        .expect("a resolver")
        .on(Arc::new(move |asked, response| {
            locked(&hearing).push(digest_of(&asked.payload));
            response.result(answered_with.clone())
        }))
        .expect("registered");
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let call = ends
        .client
        .services()
        .get_request(&echo(), bytes_asked())
        .expect("a requester")
        .call(
            request.clone(),
            &RequestOptions {
                timeout: Some(GENEROUS),
                ..seven()
            },
        )
        .expect("a call");
    let resulted = outcome_of(call, GENEROUS).await.expect("its result");

    assert_eq!(digest_of(&resulted), digest_of(&result), "its result whole");
    assert_eq!(*locked(&heard), [digest_of(&request)], "its request whole");
    // the relay credited the client's request on leg A, and the device's result on leg B
    assert!(*locked(&leg_a) > 1, "credited on leg A");
    assert!(*locked(&leg_b) > 1, "credited on leg B");
    ends.end().await;
}

#[tokio::test]
async fn cancel_the_device_s_call_when_the_client_cancels_its_own() {
    let ends = connect_relayed(&Relayed::default()).await;
    let held = procedure(12, ("held", Some(ProcedureKind::Request)));
    let started: Arc<Mutex<Vec<String>>> = Arc::default();
    let reasons: Arc<Mutex<Vec<Option<SignalReason>>>> = Arc::default();
    let (starting, hearing) = (Arc::clone(&started), Arc::clone(&reasons));

    ends.device
        .as_ref()
        .expect("a device")
        .services()
        .get_request_resolver(&held, text())
        .expect("a resolver")
        .on(Arc::new(move |request, _| {
            let hearing = Arc::clone(&hearing);

            locked(&starting).push(request.payload.clone());

            Box::pin(async move {
                request.signal.token().cancelled().await;
                locked(&hearing).push(request.signal.reason());

                Ok(())
            })
        }))
        .expect("registered");
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let cancelling = CancellationToken::new();
    let asking = ends
        .client
        .services()
        .get_request(&held, asked())
        .expect("a requester")
        .call(
            "wait".to_owned(),
            &RequestOptions {
                signal: Some(cancelling.clone()),
                ..seven()
            },
        )
        .expect("a call");

    assert!(
        eventually(|| *locked(&started) == ["wait"]).await,
        "the device's call started"
    );
    cancelling.cancel();
    assert!(
        matches!(
            outcome_of(asking, PATIENCE).await,
            Err(CallError::Cancelled(_))
        ),
        "cancelled"
    );
    assert!(
        eventually(|| *locked(&reasons) == [Some(SignalReason::Cancelled)]).await,
        "the device heard the cancel, {:?}",
        locked(&reasons)
    );
    ends.end().await;
}

// ── Sessions, commands and subscriptions ───────────────────────────────────────────────────────

// a server and a client not yet connected, the server started: the port it listens on
async fn started_ends() -> (Ends, u16) {
    let ends = Ends {
        server: server_with(&ServerOptions::default()),
        client: client_with(&RouterLimitsOptions::default()),
        device: None,
        to_device: None,
        counted: Arc::default(),
    };
    let port = port_of(&ends.server).await;

    (ends, port)
}

// the subscriptions the server's router notifies: the TypeScript side lists them, this side counts
// them, as the C# side does
async fn subscriptions_of(server: &WebSocketServer) -> u64 {
    server
        .router()
        .gauges()
        .await
        .expect("its gauges")
        .counts
        .get("notifiedSubscriptions")
        .copied()
        .unwrap_or_default()
}

// a request's or a command's resolver that waits for its call's cancel, says why it heard it,
// then fails
fn stopped_on_cancel(
    reasons: &Arc<Mutex<Vec<Option<SignalReason>>>>,
) -> crate::managers::service::ResolverCallback<TextCodec, TextCodec> {
    let reasons = Arc::clone(reasons);

    Arc::new(move |request, _| {
        let reasons = Arc::clone(&reasons);

        Box::pin(async move {
            request.signal.token().cancelled().await;
            locked(&reasons).push(request.signal.reason());

            Err(ResolverError::other("stopped"))
        })
    })
}

// the connection the server holds first
fn first_handle(server: &WebSocketServer) -> ConnectionHandle {
    server
        .transport()
        .clients()
        .first()
        .map(|client| Arc::clone(&client.connection_handle))
        .expect("its connection")
}

// a notification's callback that keeps what it hears, each with `label` before it
fn kept_by(heard: &Arc<Mutex<Vec<String>>>, label: &'static str) -> NotificationCallback<String> {
    let heard = Arc::clone(heard);

    Arc::new(move |payload: String| {
        let said = if label.is_empty() {
            payload
        } else {
            format!("{label} {payload}")
        };

        locked(&heard).push(said);

        Box::pin(async { Ok(()) })
    })
}

#[tokio::test]
async fn open_a_session_by_a_request_answer_within_it_command_the_client_and_close_a_silent_connection()
 {
    let (ends, port) = started_ends().await;

    open_sessions(
        &ends.server,
        (Some(Duration::from_millis(300)), Some(crate::NEVER)),
    );
    ends.server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..text()
            },
        )
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");
    ends.client
        .services()
        .get_command_resolver(&ping(), text())
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result("pong".to_owned())))
        .expect("registered");
    connect(&ends.client, port).await;

    // nothing but the procedure that opens a session answers without one: the server refuses
    let refused = ask(&ends.client, (&echo(), "hi"), &RequestOptions::default()).await;
    let Err(CallError::Failure(refused)) = refused else {
        panic!("refused, not {refused:?}");
    };

    assert_eq!(
        (refused.code(), refused.origin(), refused.side()),
        (
            ProtocolCode::SESSION_REQUIRED.get(),
            FailureOrigin::Peer,
            Some(RouterSide::Server)
        ),
        "no session"
    );

    let token = ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");
    let handle = first_handle(&ends.server);

    // the same token at both ends
    assert_eq!(
        ends.server
            .sessions()
            .session_token_of(Arc::clone(&handle))
            .await
            .map(|token| token.to_string()),
        Some(token.clone()),
        "the server's"
    );
    assert_eq!(
        ends.client
            .router()
            .session_token()
            .map(|token| token.to_string()),
        Some(token),
        "the client's"
    );
    assert_eq!(
        ask(&ends.client, (&echo(), "hi"), &RequestOptions::default())
            .await
            .ok(),
        Some("HI".to_owned()),
        "within its session"
    );

    // the server commands the client it names
    let commanded = ends
        .server
        .services()
        .get_command(&ping(), asked())
        .expect("a command")
        .call("ping".to_owned(), &CommandOptions::new(handle))
        .expect("a call");

    assert_eq!(
        outcome_of(commanded, PATIENCE).await.ok(),
        Some("pong".to_owned()),
        "commanded"
    );

    // silent past its connection timeout, the client is closed, and its session goes with it
    assert!(
        eventually(|| ends.client.transport().ready_state() == ReadyState::Closed).await,
        "closed once silent"
    );

    let started = crate::testing::Instant::now();

    while !ends.server.sessions().all().await.is_empty() && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(10)).await;
    }

    assert!(
        ends.server.sessions().all().await.is_empty(),
        "its session gone"
    );
    assert!(
        ends.client.router().session_token().is_none(),
        "the client's token gone"
    );
    ends.end().await;
}

#[tokio::test]
async fn subscribe_get_the_notification_that_doubles_its_result_and_unsubscribe_by_call_id() {
    let (ends, port) = started_ends().await;
    let notifying: Arc<Mutex<Option<Notifier<TextCodec>>>> = Arc::default();
    let slot = Arc::clone(&notifying);
    let notifier = ends
        .server
        .services()
        .get_notification_resolver(&news(), notified())
        .expect("a resolver")
        .on(Arc::new(move |_, response| {
            let slot = Arc::clone(&slot);

            Box::pin(async move {
                let call_id = response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                let notifier = locked(&slot).clone();

                // sent before the answer, under the call id the answer is for
                if let Some(notifier) = notifier {
                    notifier
                        .notify("ahead".to_owned(), &NotifyOptions::default())
                        .await;
                }

                response.result(call_id.to_string()).await
            })
        }))
        .expect("registered");

    *locked(&notifying) = Some(notifier);

    let router = ends.server.router().clone();

    ends.server
        .services()
        .get_request_resolver(&unsubscribe(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let unsubscribing = router.unsubscribe(CallAddress {
                connection_handle: request.connection_handle,
                call_id: request.payload.parse().unwrap_or_default(),
            });

            Box::pin(async move { response.result(unsubscribing.await.to_string()).await })
        }))
        .expect("registered");
    connect(&ends.client, port).await;

    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let unsubscribing = ends
        .client
        .services()
        .get_request(&unsubscribe(), asked())
        .expect("a requester");
    let registering = ends
        .client
        .services()
        .get_notification(
            &news(),
            NotificationDependencies {
                unsubscribe: Some(Arc::new(move |call_id, _| {
                    let call = unsubscribing.call(call_id.to_string(), &RequestOptions::default());

                    Box::pin(async move { call?.await.map(drop) })
                })),
                ..subscribed()
            },
        )
        .expect("a notification")
        .register(
            "subscribe".to_owned(),
            kept_by(&heard, ""),
            &RegistrationOptions::default(),
        );
    let registration = patience(PATIENCE, registering)
        .await
        .expect("in time")
        .expect("registered");

    assert!(
        eventually(|| *locked(&heard) == ["ahead"]).await,
        "heard, {:?}",
        locked(&heard)
    );
    assert_eq!(subscriptions_of(&ends.server).await, 1, "one subscription");
    registration.unregister().await.expect("unregistered");
    assert_eq!(subscriptions_of(&ends.server).await, 0, "none left");
    ends.end().await;
}

#[tokio::test]
async fn a_subscription_let_go_of_without_an_unsubscribe_is_cancelled_so_subscribing_again_is_heard()
 {
    let (ends, port) = started_ends().await;
    let notifier = ends
        .server
        .services()
        .get_notification_resolver(&news(), notified())
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result("ok".to_owned())))
        .expect("registered");

    connect(&ends.client, port).await;

    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let notification = ends
        .client
        .services()
        .get_notification(&news(), subscribed())
        .expect("a notification");
    let first = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            kept_by(&heard, "first"),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("in time")
    .expect("registered");

    first.unregister().await.expect("unregistered");

    let started = crate::testing::Instant::now();

    while subscriptions_of(&ends.server).await != 0 && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(10)).await;
    }

    assert_eq!(subscriptions_of(&ends.server).await, 0, "cancelled");

    let again = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            kept_by(&heard, "again"),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("in time")
    .expect("registered");

    notifier
        .notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    assert!(
        eventually(|| *locked(&heard) == ["again flash"]).await,
        "heard, {:?}",
        locked(&heard)
    );
    drop(again);
    ends.end().await;
}

#[tokio::test]
async fn a_command_whose_timeout_passes_is_cancelled_and_the_client_s_resolver_hears_it() {
    let (ends, port) = started_ends().await;
    let reasons: Arc<Mutex<Vec<Option<SignalReason>>>> = Arc::default();

    open_sessions(&ends.server, (None, None));
    ends.client
        .services()
        .get_command_resolver(&ping(), text())
        .expect("a resolver")
        .on(stopped_on_cancel(&reasons))
        .expect("registered");
    connect(&ends.client, port).await;
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let commanded = ends
        .server
        .services()
        .get_command(&ping(), asked())
        .expect("a command")
        .call(
            "ping".to_owned(),
            &CommandOptions {
                timeout: Some(Duration::from_millis(50)),
                ..CommandOptions::new(first_handle(&ends.server))
            },
        )
        .expect("a call");

    assert!(
        matches!(
            outcome_of(commanded, PATIENCE).await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    assert!(
        eventually(|| *locked(&reasons) == [Some(SignalReason::Cancelled)]).await,
        "the client's resolver heard it, {:?}",
        locked(&reasons)
    );
    // cancelled, not closed: close_on_command_timeout is not set
    assert_eq!(
        ends.client.transport().ready_state(),
        ReadyState::Open,
        "still open"
    );
    ends.end().await;
}

#[tokio::test]
async fn a_request_whose_timeout_passes_is_cancelled_and_the_server_s_resolver_hears_it() {
    let (ends, port) = started_ends().await;
    let reasons: Arc<Mutex<Vec<Option<SignalReason>>>> = Arc::default();
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let erring = Arc::clone(&errors);

    ends.server.router().on_error(Arc::new(
        move |error: &RouterError, _: Option<&ConnectionHandle>| {
            locked(&erring).push(error.to_string());
        },
    ));
    ends.server
        .services()
        .get_request_resolver(&echo(), text())
        .expect("a resolver")
        .on(stopped_on_cancel(&reasons))
        .expect("registered");
    connect(&ends.client, port).await;

    let timed = ask(
        &ends.client,
        (&echo(), "hi"),
        &RequestOptions {
            timeout: Some(Duration::from_millis(50)),
            ..RequestOptions::default()
        },
    )
    .await;

    assert!(matches!(timed, Err(CallError::TimedOut(_))), "timed out");
    assert!(
        eventually(|| *locked(&reasons) == [Some(SignalReason::Cancelled)]).await,
        "the server's resolver heard it, {:?}",
        locked(&reasons)
    );
    // what stopped because its call was cancelled is no one's to hear of
    assert!(locked(&errors).is_empty(), "{:?}", locked(&errors));
    ends.end().await;
}

#[tokio::test]
async fn a_session_that_ends_ends_the_subscriptions_it_let_the_client_have_the_client_drops_them_and_asks_anew()
 {
    let (ends, port) = started_ends().await;

    // wide enough that the subscription below comes inside it on a loaded machine
    open_sessions(
        &ends.server,
        (Some(crate::NEVER), Some(Duration::from_millis(400))),
    );
    ends.server
        .services()
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(
                RequestResolverDependencies {
                    before_request: Some(require_session()),
                    ..text()
                },
                TextCodec,
            ),
        )
        .expect("a resolver")
        .on(Arc::new(|_, response| response.result("ok".to_owned())))
        .expect("registered");
    connect(&ends.client, port).await;
    ask(
        &ends.client,
        (&open_session(), "me"),
        &RequestOptions::default(),
    )
    .await
    .expect("a session");

    let dropped: Arc<Mutex<Vec<String>>> = Arc::default();
    let dropping = Arc::clone(&dropped);

    ends.client
        .services()
        .on_dropped(Arc::new(move |procedure: &Procedure, _| {
            locked(&dropping).push(procedure.procedure_name.clone());
        }));

    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let notification = ends
        .client
        .services()
        .get_notification(&news(), subscribed())
        .expect("a notification");
    let held = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            kept_by(&heard, ""),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("in time")
    .expect("registered");

    assert!(
        ends.client.router().session_token().is_some(),
        "in a session"
    );
    assert!(
        eventually(|| *locked(&dropped) == ["news"]).await,
        "dropped, {:?}",
        locked(&dropped)
    );
    assert!(
        ends.client.router().session_token().is_none(),
        "its session gone"
    );
    assert_eq!(subscriptions_of(&ends.server).await, 0, "none left");

    // without a session, the next registration asks anew, and is refused
    let refused = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            kept_by(&heard, ""),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("in time");

    assert_eq!(
        code_of(&refused),
        Some(ProtocolCode::SESSION_REQUIRED.get()),
        "refused"
    );
    drop(held);
    ends.end().await;
}

#[tokio::test]
async fn an_ordinary_request_to_the_procedure_of_a_subscription_held_moves_nothing_notify_still_reaches_it()
 {
    let (ends, port) = started_ends().await;
    let notifier = ends
        .server
        .services()
        .get_notification_resolver(&news(), notified())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            Box::pin(async move {
                // an ordinary request subscribes nothing: its callback cannot, and fails if it
                // tries
                if request.payload == "fail" {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                }

                response.result("ok".to_owned()).await
            })
        }))
        .expect("registered");

    connect(&ends.client, port).await;

    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let held = patience(
        PATIENCE,
        ends.client
            .services()
            .get_notification(&news(), subscribed())
            .expect("a notification")
            .register(
                "subscribe".to_owned(),
                kept_by(&heard, ""),
                &RegistrationOptions::default(),
            ),
    )
    .await
    .expect("in time")
    .expect("registered");

    assert_eq!(
        ask(&ends.client, (&news(), "again"), &RequestOptions::default())
            .await
            .ok(),
        Some("ok".to_owned()),
        "an ordinary request"
    );
    assert_eq!(
        code_of(&ask(&ends.client, (&news(), "fail"), &RequestOptions::default()).await),
        Some(ProtocolCode::PROCEDURE_FAILED.get()),
        "one that tries to subscribe"
    );
    notifier
        .notify("still".to_owned(), &NotifyOptions::default())
        .await;
    assert!(
        eventually(|| *locked(&heard) == ["still"]).await,
        "heard, {:?}",
        locked(&heard)
    );
    assert_eq!(subscriptions_of(&ends.server).await, 1, "one subscription");
    drop(held);
    ends.end().await;
}

// ── Its sockets ────────────────────────────────────────────────────────────────────────────────

// a raw request of `procedure_id` on `call_id`, its payload `text`
fn request_bytes(call_id: u32, (procedure_id, text): (u16, &str)) -> Bytes {
    crate::envelope::write_envelope(
        &crate::envelope::Envelope::Request {
            header: crate::envelope::RequestHeader {
                call_id,
                service_id: 1,
                procedure_id,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
                credential: None,
            },
            payload: Bytes::copy_from_slice(text.as_bytes()),
        },
        1_024,
    )
    .expect("written")
}

// what a raw socket's request is answered: its result's payload, or its failure's code
async fn answer_of(socket: &mut Raw, request: Bytes) -> Result<String, u16> {
    socket.send(Message::Binary(request)).await.expect("sent");

    patience(PATIENCE, async {
        while let Some(Ok(message)) = socket.next().await {
            let Message::Binary(bytes) = message else {
                continue;
            };
            let read = crate::envelope::read_envelope(
                &bytes,
                RouterSide::Client,
                &crate::envelope::ReadEnvelopeOptions::default(),
            );

            match read {
                Ok(Some(crate::envelope::Envelope::Result { payload, .. })) => {
                    return Ok(String::from_utf8_lossy(&payload).into_owned());
                }
                Ok(Some(crate::envelope::Envelope::Failure { failure, .. })) => {
                    return Err(failure.code.get());
                }
                _ => {}
            }
        }

        Err(0)
    })
    .await
    .expect("answered in time")
}

// a raw client's socket from `local` to `remote` on `port`, upgraded
async fn bound_client(local: std::net::SocketAddr, (remote, port): (&str, u16)) -> Raw {
    let socket = tokio::net::TcpSocket::new_v4().expect("a socket");

    socket.set_reuseaddr(true).expect("reused");
    socket.bind(local).expect("bound");

    let stream = socket
        .connect(format!("{remote}:{port}").parse().expect("an address"))
        .await
        .expect("connected");
    let (client, _) = patience(
        PATIENCE,
        tokio_tungstenite::client_async(format!("ws://{remote}:{port}/"), stream),
    )
    .await
    .expect("upgraded in time")
    .expect("upgraded");

    client
}

// Linux and Windows open two sockets from one address and port to two addresses of the loopback;
// macOS routes no other address of 127.0.0.0/8 to it, so the test is played where it holds, as
// the C# side plays it
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "its three resolvers and its two raw sockets, as the other sides' twins hold them"
)]
async fn keeps_two_sockets_from_one_address_and_port_to_two_of_its_addresses_as_two_connections_each_in_its_own_session_and_closes_both_going_away_as_it_stops()
 {
    if cfg!(target_os = "macos") {
        return;
    }

    // a server on every address, each socket bound to one address and port of the loopback
    let server = server_with(&ServerOptions::default());
    let port = patience(
        PATIENCE,
        server.transport().start(&TransportServerStartOptions {
            address: Some("0.0.0.0".to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        }),
    )
    .await
    .expect("started in time")
    .expect("started")
    .port;
    // a port the system gave a listener and took back, so no socket of another test holds it
    let local = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|free| free.local_addr())
        .expect("a free port");
    // who opened a session on each connection, as its handle names it
    let names: Arc<Mutex<BTreeMap<String, String>>> = Arc::default();
    let (sessions, naming) = (server.sessions().clone(), Arc::clone(&names));

    server
        .services()
        .get_request_resolver(&open_session(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let stored = sessions
                .set(sessions.create(Arc::clone(&request.connection_handle)))
                .expect("a session");

            locked(&naming).insert(request.connection_handle.to_string(), request.payload);

            Box::pin(async move {
                stored.await.map_err(ResolverError::other)?;
                response.result(String::new()).await
            })
        }))
        .expect("registered");

    let knowing = Arc::clone(&names);

    server
        .services()
        .get_request_resolver(
            &whoami(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..text()
            },
        )
        .expect("a resolver")
        .on(Arc::new(move |request, response| {
            let name = locked(&knowing)
                .get(&request.connection_handle.to_string())
                .cloned()
                .unwrap_or_else(|| "nobody".to_owned());

            response.result(name)
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies {
                before_request: Some(require_session()),
                ..text()
            },
        )
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");

    let mut alice = bound_client(local, ("127.0.0.1", port)).await;

    answer_of(&mut alice, request_bytes(1, (1, "alice")))
        .await
        .expect("a session");

    let mut other = bound_client(local, ("127.0.0.2", port)).await;

    // ! a connect settles on the 101, which the server writes before it keeps the connection
    assert!(
        eventually(|| server.transport().clients().len() == 2).await,
        "both held"
    );

    // one address and one port, two connections: the second is in no session of the first's
    let clients = server.transport().clients();

    assert_eq!(
        (clients[0].port, clients[1].port),
        (Some(local.port()), Some(local.port())),
        "one port"
    );
    assert_ne!(
        clients[0].connection_handle, clients[1].connection_handle,
        "two connections"
    );
    assert_eq!(
        answer_of(&mut other, request_bytes(1, (6, ""))).await,
        Err(ProtocolCode::SESSION_REQUIRED.get().get()),
        "the other in no session"
    );
    assert_eq!(
        answer_of(&mut alice, request_bytes(3, (6, ""))).await,
        Ok("alice".to_owned()),
        "alice in hers"
    );
    assert_eq!(
        answer_of(&mut alice, request_bytes(5, (2, "hi"))).await,
        Ok("HI".to_owned()),
        "answered within it"
    );

    // the stop reaches each, going away, and resolves: it starts as it is called
    let stopping = server.dispose();

    assert_eq!(
        (close_of(&mut alice).await, close_of(&mut other).await),
        (Some(1_001), Some(1_001)),
        "both closed going away"
    );
    patience(PATIENCE, stopping)
        .await
        .expect("stopped in time")
        .expect("stopped");
}

// what a transport reported, each with its connection
type Reports = Arc<Mutex<Vec<(String, Option<ConnectionHandle>)>>>;

struct Reported(Reports);

impl ServerListener for Reported {
    fn on_error(&self, error: &RouterError, handle: Option<&ConnectionHandle>) {
        locked(&self.0).push((error.to_string(), handle.cloned()));
    }
}

struct Opened(Mutex<Option<tokio::sync::oneshot::Sender<ConnectionHandle>>>);

impl ServerListener for Opened {
    fn on_connection(&self, handle: &ConnectionHandle) {
        let opening = locked(&self.0).take();

        if let Some(opening) = opening {
            opening.send(Arc::clone(handle)).ok();
        }
    }
}

#[tokio::test]
async fn answers_leg_a_destination_lost_when_its_leg_b_over_websocket_is_dropped_behind_its_socket()
{
    // a relay whose sockets hold 256 bytes waiting at most, admitting every call
    let hub = WebSocketServer::new(&WebSocketServerOptions {
        server: Some(ServerOptions {
            relay: Some(RelayOptions {
                before_route: Some(BeforeRequest::new(|_| true, None)),
                ..RelayOptions::default()
            }),
            ..ServerOptions::default()
        }),
        transport: Some(WebSocketTransportServerOptions {
            maximum_unsent_bytes: Some(256),
            ..WebSocketTransportServerOptions::default()
        }),
    })
    .expect("a hub");
    let reported: Reports = Arc::default();
    let (opening, opened) = tokio::sync::oneshot::channel();

    hub.transport()
        .listen(Arc::new(Reported(Arc::clone(&reported))));
    hub.transport()
        .listen(Arc::new(Opened(Mutex::new(Some(opening)))));

    let port = port_of(&hub).await;
    // the device behind it, at destination 7, on the hub's own connection to it: leg B
    let device = client_with(&RouterLimitsOptions::default());

    // the request leg A makes is the command leg B answers: a procedure of either kind
    let echo = Procedure {
        procedure_kind: None,
        ..echo()
    };

    device
        .services()
        .get_command_resolver(&echo, text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered");
    connect(&device, port).await;

    let leg_b = patience(PATIENCE, opened)
        .await
        .expect("in time")
        .expect("opened");

    hub.router()
        .register_destination(
            RelayTarget::Connection(Arc::clone(&leg_b)),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        )
        .expect("registered");

    let requester = client_with(&RouterLimitsOptions::default());

    connect(&requester, port).await;

    // a request leg B cannot hold waiting for its socket: leg B is dropped, and leg A answered
    let lost = ask(
        &requester,
        (&echo, &String::from_utf8(vec![b'x'; 400]).expect("text")),
        &seven(),
    )
    .await;

    assert_eq!(
        code_of(&lost),
        Some(ProtocolCode::DESTINATION_LOST.get()),
        "leg A answered"
    );

    let reported = locked(&reported).clone();

    assert_eq!(reported.len(), 1, "one report, {reported:?}");
    assert_eq!(reported[0].1.as_ref(), Some(&leg_b), "of leg B");
    assert!(
        reported[0].0.contains("maximumUnsentBytes"),
        "naming its bound, {:?}",
        reported[0].0
    );
    requester.dispose().await;
    device.dispose().await;
    hub.dispose().await.expect("stopped");
}
