//! The server facade over a scripted transport: sessions, inactivity, listens and disposal.

use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, ProcedureKind, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::identity::Procedure;
use crate::managers::service::{
    Request, RequestDependencies, RequestOptions, ResolverDependencies,
};
use crate::router::admissions::require_session;
use crate::router::core::AdmissionRequest;
use crate::router::types::{CallSession, ConnectionHandle, RouterError, TransportMessage};
use crate::server::{HealthStatus, Server, ServerOptions};
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::testing::scripted::{ClosingOptions, ScriptedServer, handle_of};
use crate::transport::{ServerListener, ServerTransport, TransportServerRefusal};

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn procedure(id: u16) -> Procedure {
    Procedure {
        service_id: 1,
        id,
        name: match id {
            1 => "openSession",
            2 => "echo",
            3 => "closeSession",
            4 => "whoami",
            5 => "news",
            _ => "unknown",
        }
        .to_owned(),
        service_revision: 1,
        kind: Some(ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

struct Fixture {
    clock: Arc<SteppingClock>,
    transport: Arc<ScriptedServer>,
    server: Server,
    first: ConnectionHandle,
}

impl Fixture {
    fn new(options: &ServerOptions) -> Self {
        let clock = SteppingClock::new(crate::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = ScriptedServer::new(shared);
        let wire: Arc<dyn ServerTransport> = Arc::<ScriptedServer>::clone(&transport);
        let server = Server::new(wire, options).expect("a server");
        Self {
            clock,
            transport,
            server,
            first: handle_of(1),
        }
    }

    fn idle(timeout: u64) -> Self {
        Self::new(&ServerOptions {
            connection_inactivity_timeout: Some(Duration::from_millis(timeout)),
            ..ServerOptions::default()
        })
    }

    fn sessions(&self, timeouts: (Option<Duration>, Option<Duration>)) {
        let sessions = self.server.sessions().clone();
        self.server
            .services()
            .get_request_resolver(
                &procedure(1),
                ResolverDependencies::of(crate::payloads::TextCodec, crate::payloads::TextCodec),
            )
            .expect("openSession")
            .register(
                (
                    Arc::new(move |request, response| {
                        let mut session = sessions.create(request.connection_handle);
                        session.connection_inactivity_timeout = timeouts.0;
                        session.session_inactivity_timeout = timeouts.1;
                        let stored = sessions.set(session).expect("a session");
                        Box::pin(async move {
                            let stored = stored.await.map_err(ResolverError::other)?;
                            response
                                .result(stored.session_token.expect("drawn").to_string())
                                .await
                        })
                    }),
                    None,
                ),
                false,
            )
            .expect("registered");
        self.server
            .services()
            .get_request_resolver(
                &procedure(2),
                ResolverDependencies {
                    before_request: Some(require_session()),
                    ..ResolverDependencies::of(
                        crate::payloads::TextCodec,
                        crate::payloads::TextCodec,
                    )
                },
            )
            .expect("echo")
            .register(
                (
                    Arc::new(|request, response| response.result(request.payload)),
                    None,
                ),
                false,
            )
            .expect("registered");
    }

    async fn ask(&self, call_id: u32, (id, credential): (u16, Option<Credential>)) {
        self.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    call_id,
                    service_id: 1,
                    procedure_id: id,
                    credential,
                    destination_id: None,
                    opens_subscription: false,
                    paced: false,
                    total: None,
                },
                payload: Bytes::from_static(b"hi"),
            },
            &self.first,
        );
        self.clock.settle().await;
    }

    async fn open(&self) {
        self.transport.open(&self.first, true);
        self.clock.settle().await;
    }

    async fn listen(&self, held: bool) {
        self.transport.hold_listen(held, &self.first);
        self.clock.settle().await;
    }

    async fn advance(&self, ms: u64) {
        self.clock.advance(Duration::from_millis(ms)).await;
    }

    fn command(&self) -> Request<crate::payloads::TextCodec, crate::payloads::TextCodec> {
        self.server
            .services()
            .get_command(
                &Procedure {
                    kind: Some(ProcedureKind::Command),
                    ..procedure(3)
                },
                RequestDependencies::of(crate::payloads::TextCodec, crate::payloads::TextCodec),
            )
            .expect("a command")
    }

    fn options(&self) -> RequestOptions {
        RequestOptions {
            connection_handle: Some(Arc::clone(&self.first)),
            timeout: Some(Duration::from_millis(10)),
            ..RequestOptions::default()
        }
    }
    fn news(&self) -> crate::managers::service::Notifier<crate::payloads::TextCodec> {
        self.server
            .services()
            .get_notification_resolver(
                &Procedure {
                    kind: Some(ProcedureKind::Notifies),
                    ..procedure(5)
                },
                (
                    ResolverDependencies {
                        before_request: Some(require_session()),
                        ..ResolverDependencies::of(
                            crate::payloads::TextCodec,
                            crate::payloads::TextCodec,
                        )
                    },
                    crate::payloads::TextCodec,
                ),
            )
            .expect("news")
            .on(Arc::new(|_, response| response.result(String::new())))
            .expect("registered")
    }

    async fn subscribe(&self, call_id: u32, credential: Option<Credential>) {
        self.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    call_id,
                    service_id: 1,
                    procedure_id: 5,
                    credential,
                    opens_subscription: true,
                    destination_id: None,
                    paced: false,
                    total: None,
                },
                payload: Bytes::from_static(b"hi"),
            },
            &self.first,
        );
        self.clock.settle().await;
    }
}

#[tokio::test]
async fn a_session_is_made_by_a_request_and_its_connection_learns_the_token_once() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    fixture.ask(1, (2, None)).await;
    fixture.ask(3, (1, None)).await;
    fixture.ask(5, (2, None)).await;
    let token = fixture
        .server
        .sessions()
        .session_token_of(Arc::clone(&fixture.first))
        .await
        .expect("stored");
    let envelopes = fixture.transport.envelopes(&fixture.first);
    assert_eq!(envelopes.len(), 3);
    assert!(
        matches!(&envelopes[0], Envelope::Failure { header, failure } if header.call_id == 1 && header.credential.is_none() && failure.code == ProtocolCode::SESSION_REQUIRED.get())
    );
    assert!(
        matches!(&envelopes[1], Envelope::Result { header, payload } if header.call_id == 3 && header.credential == Some(Credential::Opaque(token)) && payload == token.to_string().as_bytes())
    );
    assert!(
        matches!(&envelopes[2], Envelope::Result { header, payload } if header.call_id == 5 && header.credential.is_none() && payload == b"hi".as_slice())
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn the_end_of_a_session_is_announced_on_the_next_answer_and_a_session_replaced_is_announced()
{
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    let sessions = fixture.server.sessions().clone();
    fixture
        .server
        .services()
        .get_request_resolver(
            &procedure(3),
            ResolverDependencies::of(crate::payloads::TextCodec, crate::payloads::TextCodec),
        )
        .expect("logout")
        .register(
            (
                Arc::new(move |request, response| {
                    let deleted = sessions.delete(request.connection_handle);
                    Box::pin(async move {
                        assert!(deleted.await);
                        response.result("bye".to_owned()).await
                    })
                }),
                None,
            ),
            false,
        )
        .expect("registered");
    fixture.ask(1, (1, None)).await;
    let opened = fixture
        .server
        .sessions()
        .session_token_of(Arc::clone(&fixture.first))
        .await
        .expect("opened");
    fixture.ask(3, (1, None)).await;
    let replaced = fixture
        .server
        .sessions()
        .session_token_of(Arc::clone(&fixture.first))
        .await
        .expect("replaced");
    assert_ne!(opened, replaced);
    fixture.ask(5, (3, None)).await;
    fixture.ask(7, (2, None)).await;
    assert_eq!(
        fixture
            .transport
            .envelopes(&fixture.first)
            .iter()
            .map(|envelope| envelope.header().credential().cloned())
            .collect::<Vec<_>>(),
        [
            Some(Credential::Opaque(opened)),
            Some(Credential::Opaque(replaced)),
            Some(Credential::None),
            None
        ]
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn require_session_refuses_a_call_in_none_with_session_required_testing_the_call_s_session_never_its_connection_s()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.open().await;
    fixture
        .server
        .sessions()
        .get_or_else_set(Arc::clone(&fixture.first))
        .await
        .expect("stored");
    let admission = require_session();
    let mut request = AdmissionRequest {
        connection_handle: Arc::clone(&fixture.first),
        header: RequestHeader {
            call_id: 1,
            service_id: 1,
            procedure_id: 2,
            credential: None,
            destination_id: None,
            opens_subscription: false,
            paced: false,
            total: None,
        },
        session: None,
        carried: None,
    };
    assert!(
        admission.admission(RouterSide::Server)(&request)
            .expect("judged")
            .is_some()
    );
    assert_eq!(
        admission.refusal().expect("its refusal").protocol_code(),
        Some(ProtocolCode::SESSION_REQUIRED)
    );
    request.session = Some(CallSession::default());
    assert!(
        admission.admission(RouterSide::Server)(&request)
            .expect("judged")
            .is_none()
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn each_message_is_activity_a_connection_that_speaks_keeps_going_a_silent_one_is_closed() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((Some(Duration::from_millis(80)), None));
    fixture.ask(1, (1, None)).await;
    for (call_id, malformed) in [(3, false), (5, true), (7, false)] {
        fixture.advance(40).await;
        if malformed {
            fixture.transport.deliver_message(
                &TransportMessage {
                    data: Bytes::from_static(&[0x0a, 0x02]),
                    ..TransportMessage::default()
                },
                &fixture.first,
            );
            fixture.clock.settle().await;
        } else {
            fixture.ask(call_id, (99, None)).await;
        }
        assert_eq!(fixture.clock.dues(), [Duration::from_millis(80)]);
    }
    assert_eq!(fixture.transport.closed().len(), 0);
    assert!(
        fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.advance(79).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn closes_a_connection_silent_for_a_millisecond_or_the_longest_timer_at_its_due() {
    for timeout in [1, 2_147_483_647] {
        let fixture = Fixture::idle(timeout);
        fixture.open().await;
        fixture.advance(timeout - 1).await;
        assert_eq!(fixture.transport.closed().len(), 0);
        fixture.advance(1).await;
        assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
        assert_eq!(fixture.server.sessions().all().await.len(), 0);
        fixture.server.dispose().await.expect("disposed");
    }
}

#[tokio::test]
async fn ignores_listens_outside_a_connection_and_unmatched_endings_without_changing_its_inactivity_deadline()
 {
    let fixture = Fixture::idle(60);
    fixture.listen(true).await;
    fixture.listen(false).await;
    fixture.advance(100).await;
    let counts = fixture.server.gauges().await.server.counts;
    assert_eq!((counts["connections"], counts["listening"]), (0, 0));
    assert_eq!(fixture.transport.closed().len(), 0);
    assert_eq!(fixture.clock.dues().len(), 0);
    fixture.open().await;
    fixture.advance(40).await;
    fixture.listen(false).await;
    let counts = fixture.server.gauges().await.server.counts;
    assert_eq!(
        (counts["connections"], counts["idle"], counts["listening"]),
        (1, 1, 0)
    );
    fixture.advance(19).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.transport.close_connection(&fixture.first);
    fixture.listen(true).await;
    fixture.listen(false).await;
    let counts = fixture.server.gauges().await.server.counts;
    assert_eq!((counts["connections"], counts["listening"]), (0, 0));
    assert_eq!(fixture.clock.dues().len(), 0);
    let second = handle_of(2);
    fixture.transport.open(&second, true);
    fixture.transport.hold_listen(true, &second);
    fixture.advance(1_000).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    let counts = fixture.server.gauges().await.server.counts;
    assert_eq!((counts["connections"], counts["listening"]), (1, 1));
    fixture.transport.hold_listen(false, &second);
    fixture.advance(59).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.advance(1).await;
    assert_eq!(
        fixture.transport.closed(),
        [Arc::clone(&fixture.first), second]
    );
    assert_eq!(fixture.server.gauges().await.server.counts["listening"], 0);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_listen_held_is_no_silence_a_connection_with_no_session_is_not_closed_while_one_is_and_is_closed_the_server_s_own_timeout_after_the_last_ends()
 {
    let fixture = Fixture::idle(60);
    fixture.open().await;
    fixture.advance(40).await;
    fixture.listen(true).await;
    assert_eq!(fixture.clock.dues().len(), 0);
    fixture.ask(1, (99, None)).await;
    fixture.advance(1_000).await;
    fixture.listen(true).await;
    fixture.listen(false).await;
    fixture.advance(1_000).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    assert_eq!(fixture.clock.dues().len(), 0);
    assert_eq!(fixture.server.gauges().await.server.counts["listening"], 1);
    fixture.listen(false).await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(60)]);
    fixture.advance(59).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    assert_eq!(fixture.server.gauges().await.server.counts["listening"], 0);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_listen_held_is_no_silence_for_a_session_s_connection_timeout_either_a_message_meanwhile_restarts_its_session_timer_alone_and_the_listen_s_end_counts_anew()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.transport.close_as(&ClosingOptions {
        result: Some(true),
        ..ClosingOptions::default()
    });
    fixture.sessions((
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(1_000)),
    ));
    fixture.open().await;
    fixture.listen(true).await;
    fixture.ask(1, (1, None)).await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(1_000)]);
    fixture.advance(200).await;
    fixture.ask(3, (99, None)).await;
    fixture.ask(5, (1, None)).await;
    let last_activity = fixture
        .server
        .sessions()
        .get(Arc::clone(&fixture.first))
        .await
        .expect("stored")
        .last_activity;
    fixture.advance(400).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(600)]);
    fixture.listen(false).await;
    let mut dues = fixture.clock.dues();
    dues.sort();
    assert_eq!(
        dues,
        [Duration::from_millis(100), Duration::from_millis(600)]
    );
    assert_eq!(
        fixture
            .server
            .sessions()
            .get(Arc::clone(&fixture.first))
            .await
            .expect("stored")
            .last_activity,
        last_activity
    );
    fixture.advance(99).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.advance(499).await;
    assert!(
        fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.advance(1).await;
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_close_that_finds_the_connection_gone_already_takes_its_session_all_the_same() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((Some(Duration::from_millis(20)), None));
    fixture.ask(1, (1, None)).await;
    assert!(
        fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.advance(20).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_connection_is_asked_to_close_once_however_many_times_it_earns_it() {
    let fixture = Fixture::new(&ServerOptions {
        close_on_command_timeout: Some(true),
        ..ServerOptions::default()
    });
    let released = CancellationToken::new();
    fixture.transport.close_as(&ClosingOptions {
        released: Some(released.clone()),
        ..ClosingOptions::default()
    });
    fixture.open().await;
    let command = fixture.command();
    let first = command
        .call("ping".to_owned(), fixture.options())
        .expect("a call");
    let second = command
        .call("ping".to_owned(), fixture.options())
        .expect("a call");
    fixture.advance(10).await;
    assert!(matches!(first.await, Err(CallError::TimedOut(_))));
    assert!(matches!(second.await, Err(CallError::TimedOut(_))));
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    released.cancel();
    fixture.clock.settle().await;
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_command_unanswered_in_time_closes_its_connection_as_the_server_s_default_or_the_command_says()
 {
    for (default, override_value, closes) in [
        (Some(true), None, true),
        (Some(true), Some(false), false),
        (None, None, false),
        (None, Some(true), true),
    ] {
        let fixture = Fixture::new(&ServerOptions {
            close_on_command_timeout: default,
            ..ServerOptions::default()
        });
        fixture.open().await;
        let call = fixture
            .command()
            .call(
                "ping".to_owned(),
                RequestOptions {
                    close_on_timeout: override_value,
                    ..fixture.options()
                },
            )
            .expect("a call");
        fixture.advance(10).await;
        assert!(matches!(call.await, Err(CallError::TimedOut(_))));
        assert_eq!(
            fixture.transport.closed(),
            if closes {
                vec![Arc::clone(&fixture.first)]
            } else {
                vec![]
            }
        );
        fixture.server.dispose().await.expect("disposed");
    }
}

#[tokio::test]
async fn limits_that_do_not_hold_together_refuse_the_server_which_leaves_nothing_on_its_transport()
{
    let clock: SharedClock = SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedServer::new(clock);
    let wire: Arc<dyn ServerTransport> = Arc::<ScriptedServer>::clone(&transport);
    Server::new(
        wire,
        &ServerOptions {
            limits: Some(crate::router::types::RouterLimitsOptions {
                chunk_bytes: Some(63),
                ..crate::router::types::RouterLimitsOptions::default()
            }),
            ..ServerOptions::default()
        },
    )
    .expect_err("limits that do not hold together");
    assert_eq!(transport.listener_count(), 0);
}

#[tokio::test]
async fn dispose_stops_the_timer_of_a_connection_with_no_session_nothing_is_closed_after_it() {
    let fixture = Fixture::idle(20);
    fixture.open().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(20)]);
    fixture.server.dispose().await.expect("disposed");
    fixture.advance(80).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    assert_eq!(fixture.clock.dues().len(), 0);
}

#[tokio::test]
async fn counts_no_close_under_way_once_disposed() {
    let fixture = Fixture::idle(20);
    let release = CancellationToken::new();
    fixture.transport.close_as(&ClosingOptions {
        released: Some(release.clone()),
        ..ClosingOptions::default()
    });
    fixture.open().await;
    fixture.advance(20).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    assert_eq!(fixture.server.gauges().await.server.counts["closing"], 1);
    fixture.server.dispose().await.expect("disposed");
    assert_eq!(
        fixture
            .server
            .gauges()
            .await
            .server
            .counts
            .get("closing")
            .copied()
            .unwrap_or(0),
        0
    );
    release.cancel();
    fixture.clock.settle().await;
}

#[tokio::test]
async fn dispose_lets_go_of_the_transport_rejects_what_waits_forgets_the_sessions_and_stops() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    fixture.ask(1, (1, None)).await;
    assert!(
        fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    let waiting = fixture
        .command()
        .call("ping".to_owned(), fixture.options())
        .expect("a call");
    fixture.clock.settle().await;
    fixture.server.dispose().await.expect("disposed");
    assert!(matches!(waiting.await, Err(CallError::Disconnected(_))));
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(fixture.transport.stops(), 1);
    assert_eq!(fixture.transport.listener_count(), 0);
}

#[tokio::test]
async fn count_each_layer_set_against_the_connections_it_holds_when_its_transport_counts_none_back_to_nothing_as_each_closes()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    fixture.open().await;
    assert_eq!(
        fixture.server.gauges().await.server.counts,
        [
            ("closing", 0),
            ("connections", 1),
            ("idle", 1),
            ("listening", 0)
        ]
        .into()
    );
    fixture.ask(1, (1, None)).await;
    let gauges = fixture.server.gauges().await;
    assert_eq!(
        gauges.server.counts,
        [
            ("closing", 0),
            ("connections", 1),
            ("idle", 0),
            ("listening", 0)
        ]
        .into()
    );
    assert_eq!(
        gauges.sessions.counts,
        [("sessions", 1), ("timedConnections", 1)].into()
    );
    for layer in [&gauges.server, &gauges.sessions, &gauges.transport] {
        assert_eq!(layer.anomalies.len(), 0);
        assert_eq!(layer.ceilings.len(), 0);
        assert_eq!(layer.orphans, 0);
    }
    assert_eq!(gauges.transport.counts.len(), 0);
    assert_eq!(gauges.router.counts["connections"], 1);
    assert_eq!(gauges.router.counts["pendingCalls"], 0);
    assert_eq!(fixture.server.health().await.status, HealthStatus::Pass);
    fixture.transport.close_connection(&fixture.first);
    fixture.clock.settle().await;
    let gauges = fixture.server.gauges().await;
    assert_eq!(
        gauges.server.counts,
        [
            ("closing", 0),
            ("connections", 0),
            ("idle", 0),
            ("listening", 0)
        ]
        .into()
    );
    assert_eq!(
        gauges.sessions.counts,
        [("sessions", 0), ("timedConnections", 0)].into()
    );
    assert_eq!(fixture.server.health().await.status, HealthStatus::Pass);
    fixture.server.dispose().await.expect("disposed");
}

// The C# twin observes the built layers directly; Rust has no layer factories either.
#[tokio::test]
async fn builds_each_layer_on_the_one_under_it_the_router_with_the_sessions_tokens() {
    let fixture = Fixture::new(&ServerOptions {
        limits: Some(crate::router::types::RouterLimitsOptions {
            maximum_payload_bytes: Some(8),
            ..crate::router::types::RouterLimitsOptions::default()
        }),
        ..ServerOptions::default()
    });
    let wire: Arc<dyn ServerTransport> = Arc::<ScriptedServer>::clone(&fixture.transport);
    assert!(Arc::ptr_eq(&fixture.server.transport(), &wire));
    assert!(Arc::ptr_eq(&fixture.server.router().transport(), &wire));
    assert_eq!(fixture.server.router().limits().maximum_payload_bytes, 8);
    assert!(Arc::ptr_eq(
        &fixture.server.router().clock(),
        &wire.clock().expect("a clock")
    ));
    fixture.sessions((None, None));
    fixture.open().await;
    let token = SessionToken::new([4; 16]).expect("a token");
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.first));
    session.session_token = Some(token);
    sessions
        .set(session)
        .expect("a session")
        .await
        .expect("stored");
    fixture.ask(1, (2, None)).await;
    assert!(
        matches!(&fixture.transport.envelopes(&fixture.first)[0], Envelope::Result { header, .. } if header.credential == Some(Credential::Opaque(token)))
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "both twins keep the session snapshots and replaced-token refusals in one scenario"
)]
async fn a_request_runs_in_its_connection_s_session_presenting_none_or_its_token_as_opaque_the_session_s_data_a_copy_the_call_keeps_another_token_is_refused_session_required_whatever_its_procedure_requires()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    let held = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&held);
    let release = CancellationToken::new();
    let released = release.clone();
    fixture
        .server
        .services()
        .get_request_resolver(
            &procedure(4),
            ResolverDependencies::of(crate::payloads::TextCodec, crate::payloads::TextCodec),
        )
        .expect("whoami")
        .register(
            (
                Arc::new(move |request, response| {
                    locked(&hearing).push(request.session.clone());
                    let released = released.clone();
                    Box::pin(async move {
                        if request.header.call_id == 13 {
                            released.cancelled().await;
                        }
                        response
                            .result(
                                request
                                    .session
                                    .and_then(|session| session.data)
                                    .map_or_else(|| "none".to_owned(), |data| data.to_string()),
                            )
                            .await
                    })
                }),
                None,
            ),
            false,
        )
        .expect("registered");
    fixture.ask(1, (4, None)).await;
    fixture.ask(3, (1, None)).await;
    let sessions = fixture.server.sessions();
    let token = sessions
        .session_token_of(Arc::clone(&fixture.first))
        .await
        .expect("opened");
    sessions
        .update_data((
            Arc::clone(&fixture.first),
            Some(serde_json::json!({ "name": "ada" })),
        ))
        .await
        .expect("updated");
    fixture.ask(5, (4, None)).await;
    fixture.ask(7, (4, Some(Credential::Opaque(token)))).await;
    fixture
        .ask(
            9,
            (
                4,
                Some(Credential::Opaque(
                    SessionToken::new([9; 16]).expect("another token"),
                )),
            ),
        )
        .await;
    let mut replacement = sessions.create(Arc::clone(&fixture.first));
    replacement.data = Some(serde_json::json!({ "name": "bob" }));
    let replacement = sessions
        .set(replacement)
        .expect("a session")
        .await
        .expect("replaced");
    assert_ne!(replacement.session_token, Some(token));
    fixture.ask(11, (4, Some(Credential::Opaque(token)))).await;
    fixture.ask(13, (4, None)).await;
    sessions
        .update_data((
            Arc::clone(&fixture.first),
            Some(serde_json::json!({ "name": "eve" })),
        ))
        .await
        .expect("changed while held");
    release.cancel();
    fixture.clock.settle().await;
    let data_of = |name| {
        Some(CallSession {
            data: Some(serde_json::json!({ "name": name })),
            ..CallSession::default()
        })
    };
    assert_eq!(
        *locked(&held),
        [None, data_of("ada"), data_of("ada"), data_of("bob")]
    );
    let sent = fixture.transport.envelopes(&fixture.first);
    assert_eq!(
        sent.iter()
            .filter_map(|envelope| match envelope {
                Envelope::Failure { header, failure } => Some((header.call_id, failure.code)),
                Envelope::Request { .. }
                | Envelope::Result { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. } => None,
            })
            .collect::<Vec<_>>(),
        [
            (9, ProtocolCode::SESSION_REQUIRED.get()),
            (11, ProtocolCode::SESSION_REQUIRED.get())
        ]
    );
    assert!(
        matches!(sent.last(), Some(Envelope::Result { header, payload }) if header.call_id == 13 && payload == br#"{"name":"bob"}"#.as_slice())
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_call_presenting_its_connection_s_opaque_and_one_presenting_none_hold_one_subscription_to_a_procedure_the_connection_s_session_s()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((None, None));
    let news = fixture.news();
    fixture.ask(1, (1, None)).await;
    let token = fixture
        .server
        .sessions()
        .session_token_of(Arc::clone(&fixture.first))
        .await
        .expect("opened");
    fixture.subscribe(3, None).await;
    fixture.subscribe(5, Some(Credential::Opaque(token))).await;
    assert_eq!(
        fixture.transport.calls(&fixture.first),
        [
            (EnvelopeKind::Result, 1),
            (EnvelopeKind::Result, 3),
            (EnvelopeKind::Result, 5)
        ]
    );
    let subscriptions = fixture
        .server
        .router()
        .owner()
        .run(|state| state.notifications.subscriptions(None))
        .await
        .expect("observed");
    assert_eq!(subscriptions.len(), 1);
    assert_eq!(subscriptions[0].call_id, 3);
    assert_eq!(subscriptions[0].connection_handle, fixture.first);
    assert_eq!(subscriptions[0].procedure, procedure(5).address());
    news.notify(
        "tick".to_owned(),
        &crate::managers::service::NotifyOptions::default(),
    )
    .await;
    fixture.clock.settle().await;
    assert_eq!(
        fixture.transport.calls(&fixture.first),
        [
            (EnvelopeKind::Result, 1),
            (EnvelopeKind::Result, 3),
            (EnvelopeKind::Result, 5),
            (EnvelopeKind::Notification, 3)
        ]
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_session_s_session_timeout_ends_its_session_while_a_listen_is_held_its_subscription_s_failure_goes_out_and_the_connection_stays_held()
 {
    let fixture = Fixture::idle(60);
    fixture.sessions((
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(30)),
    ));
    let _news = fixture.news();
    fixture.ask(1, (1, None)).await;
    fixture.subscribe(3, None).await;
    fixture.listen(true).await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(30)]);
    fixture.advance(30).await;
    let sent = fixture.transport.envelopes(&fixture.first);
    assert!(
        matches!(sent.last(), Some(Envelope::Failure { header, failure }) if header.call_id == 3 && header.credential == Some(Credential::None) && failure.code == ProtocolCode::SESSION_REQUIRED.get())
    );
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(fixture.clock.dues().len(), 0);
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1_000).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.listen(false).await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(60)]);
    fixture.advance(59).await;
    assert_eq!(fixture.transport.closed().len(), 0);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.server.dispose().await.expect("disposed");
}

// The C# twin supplies a transport counting fewer connections, since its sessions expose no timer
// mutation either. The same missing connection is observed independently in both layers here.
#[tokio::test]
async fn fail_what_a_layer_keeps_for_a_connection_the_transport_does_not_hold_and_say_why() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture
        .transport
        .count_as(Some(crate::router::types::Gauges {
            counts: [("connections", 0)].into(),
            ..crate::router::types::Gauges::default()
        }));
    fixture.open().await;
    let health = fixture.server.health().await;
    assert_eq!(health.status, HealthStatus::Fail);
    for layer in ["server", "router"] {
        let checks = &health.checks[&format!("{layer}:orphans")];
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].observed_value, 1);
        assert_eq!(checks[0].status, HealthStatus::Fail);
        assert_eq!(
            checks[0].output.as_deref(),
            Some("1 connections kept that the transport no longer holds")
        );
    }
    assert_eq!(
        fixture.server.gauges().await.transport.counts,
        [("connections", 0)].into()
    );
    fixture
        .transport
        .count_as(Some(crate::router::types::Gauges {
            counts: [("connections", 1)].into(),
            connection_handles: [Arc::clone(&fixture.first)].into(),
            ..crate::router::types::Gauges::default()
        }));
    assert_eq!(fixture.server.health().await.status, HealthStatus::Pass);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_command_whose_timeout_passes_is_cancelled_before_its_connection_is_closed() {
    let fixture = Fixture::new(&ServerOptions {
        close_on_command_timeout: Some(true),
        ..ServerOptions::default()
    });
    fixture.open().await;
    let waiting = fixture
        .command()
        .call("ping".to_owned(), fixture.options())
        .expect("a call");
    fixture.advance(10).await;
    assert!(matches!(waiting.await, Err(CallError::TimedOut(_))));
    assert_eq!(
        fixture.transport.calls(&fixture.first),
        [(EnvelopeKind::Request, 2), (EnvelopeKind::Cancel, 2)]
    );
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    assert_eq!(
        fixture.transport.closed_after(),
        [2],
        "the CANCEL is handed over before the close"
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn relays_as_its_options_say_its_own_admission_and_timeout_kept_require_credential_where_it_gives_none()
 {
    use crate::router::relay::{DestinationOptions, RelayOptions, RelayTarget};

    for admits in [true, false] {
        let fixture = Fixture::new(&ServerOptions {
            relay: Some(RelayOptions {
                before_route: admits
                    .then(|| crate::router::admissions::BeforeRequest::new(|_| true, None)),
                timeout: Duration::from_millis(250),
                ..RelayOptions::default()
            }),
            ..ServerOptions::default()
        });
        fixture.open().await;
        let device = handle_of(2);
        fixture.transport.open(&device, true);
        fixture.clock.settle().await;
        assert_eq!(fixture.server.router().destinations().len(), 0);
        let _registered = fixture
            .server
            .router()
            .register_destination((
                RelayTarget::Connection(Arc::clone(&device)),
                DestinationOptions {
                    destination_id: Some(7),
                    ..DestinationOptions::default()
                },
            ))
            .expect("registered");
        let request = |call_id, credential| Envelope::Request {
            header: RequestHeader {
                call_id,
                service_id: 1,
                procedure_id: 2,
                credential,
                destination_id: Some(7),
                opens_subscription: false,
                paced: false,
                total: None,
            },
            payload: Bytes::from_static(b"hi"),
        };
        fixture.transport.deliver(&request(1, None), &fixture.first);
        fixture.clock.settle().await;
        if admits {
            assert!(matches!(
                &fixture.transport.envelopes(&device)[0],
                Envelope::Request { .. }
            ));
            fixture.advance(249).await;
            assert_eq!(fixture.transport.envelopes(&fixture.first).len(), 0);
            fixture.advance(1).await;
            assert!(
                matches!(fixture.transport.envelopes(&fixture.first).last(), Some(Envelope::Failure { header, failure }) if header.call_id == 1 && failure.code == ProtocolCode::DESTINATION_LOST.get())
            );
        } else {
            fixture
                .server
                .sessions()
                .get_or_else_set(Arc::clone(&fixture.first))
                .await
                .expect("stored");
            fixture.transport.deliver(&request(3, None), &fixture.first);
            fixture.transport.deliver(
                &request(5, Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))),
                &fixture.first,
            );
            fixture.clock.settle().await;
            let failures = fixture.transport.envelopes(&fixture.first);
            assert_eq!(failures.len(), 3);
            for (index, code) in [
                (0, ProtocolCode::ACCESS_DENIED),
                (1, ProtocolCode::ACCESS_DENIED),
                (2, ProtocolCode::DESTINATION_UNREACHABLE),
            ] {
                let Envelope::Failure { failure, .. } = &failures[index] else {
                    panic!("refused");
                };
                assert_eq!(failure.code, code.get());
                if index < 2 {
                    assert_eq!(
                        failure.detail,
                        "a relay admits by default only a credential it forwards"
                    );
                }
            }
        }
        fixture.server.dispose().await.expect("disposed");
    }
}

struct Hearing {
    errors: Mutex<Vec<(RouterError, Option<ConnectionHandle>)>>,
    refusals: Mutex<Vec<TransportServerRefusal>>,
}

impl ServerListener for Hearing {
    fn on_error(&self, error: &RouterError, handle: Option<&ConnectionHandle>) {
        locked(&self.errors).push((error.clone(), handle.cloned()));
    }

    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        locked(&self.refusals).push(refusal.clone());
    }
}

// As the C# twin, the transport gives its own refusals and errors without a socket's concrete type.
#[tokio::test]
async fn hears_its_transport_s_error_and_refusal_through_the_server_s_transport() {
    let fixture = Fixture::new(&ServerOptions::default());
    let hearing = Arc::new(Hearing {
        errors: Mutex::default(),
        refusals: Mutex::default(),
    });
    let listener: Arc<dyn ServerListener> = Arc::<Hearing>::clone(&hearing);
    fixture.server.transport().listen(Arc::clone(&listener));
    let cause: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(std::io::Error::other("a listener that throws"));
    let error = RouterError::Other(Arc::clone(&cause));
    let mut refusal =
        TransportServerRefusal::of((403, "host-refused"), Some("127.0.0.1".to_owned()));
    refusal.authority = Some("rebind.example:8080".to_owned());
    refusal.port = Some(50_000);
    fixture.transport.report(&error, Some(&fixture.first));
    fixture.transport.refuse(&refusal);
    fixture.transport.report(&error, None);
    let errors = locked(&hearing.errors).clone();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0].1.as_ref(), Some(&fixture.first));
    assert!(errors[1].1.is_none());
    for (error, _) in errors {
        assert!(matches!(error, RouterError::Other(held) if Arc::ptr_eq(&held, &cause)));
    }
    assert_eq!(*locked(&hearing.refusals), [refusal.clone()]);
    fixture.server.transport().unlisten(&listener);
    fixture.transport.refuse(&refusal);
    fixture.transport.report(&error, None);
    assert_eq!(locked(&hearing.refusals).len(), 1);
    assert_eq!(locked(&hearing.errors).len(), 2);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
#[ignore = "divergence: a failed transport close is not reported and stays counted under way"]
async fn a_connection_that_closes_takes_its_session_and_a_close_that_fails_is_reported() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((Some(Duration::from_millis(30)), None));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&errors);
    fixture
        .server
        .router()
        .on_error(Arc::new(move |error, handle| {
            locked(&hearing).push((error.to_string(), handle.cloned()));
        }));
    fixture.ask(1, (1, None)).await;
    fixture.transport.close_connection(&fixture.first);
    fixture.clock.settle().await;
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.ask(3, (1, None)).await;
    fixture.transport.close_as(&ClosingOptions {
        panicked: Some("refused".to_owned()),
        ..ClosingOptions::default()
    });
    fixture.advance(30).await;
    assert_eq!(
        *locked(&errors),
        [(
            "a transport's close panicked: refused".to_owned(),
            Some(Arc::clone(&fixture.first))
        )]
    );
    assert_eq!(fixture.server.gauges().await.server.counts["closing"], 0);
    fixture.server.dispose().await.expect("disposed");
}
