//! The routers' tests: a client's against bytes a test writes as a server would, a server's against
//! bytes a test writes as its clients would, the core both share, the relay, what a resolver or a
//! listener that fails changes, and what a listener hands its router back or makes of it within the
//! turn that tells it.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use bytes::Bytes;

use crate::RouterRequest;
use crate::clock::SharedClock;
use crate::constants::{FailureScope, ProcedureKind, ProtocolCode};
use crate::envelope::{
    Credential, Envelope, FailureHeader, FailureRecord, NotificationHeader, RequestHeader,
    ResultHeader,
};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::router::client::{NotificationLike, RouterClient, RouterClientOptions};
use crate::router::server::Call;
use crate::router::types::{ResolvedRequestOptions, RouterError, RouterResult};
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::testing::pair::echo;
use crate::testing::scripted::ScriptedClient;

mod announcements;
mod calls;
mod client;
mod client_clocks;
mod client_command_credentials;
mod client_commands;
mod client_credentials;
mod client_drops;
mod client_pacing;
mod client_requests;
mod client_sessions;
mod client_subscription_rebinding;
mod client_subscription_registration;
mod client_subscriptions;
mod client_trace;
mod core_link;
mod disposal;
mod limits;
mod metrics;
mod panics;
mod parts;
mod receiving_transfers;
mod relay;
mod requester;
mod requester_edges;
mod router_core;
mod router_core_accounting;
mod router_core_answering;
mod router_core_credentials;
mod router_core_crossing;
mod router_core_hooks;
mod router_core_incoming;
mod router_core_lifecycle;
mod router_core_outcomes;
mod router_core_peer_calls;
mod router_core_placement;
mod router_core_requester;
mod router_core_rest;
mod router_core_sending_edges;
mod router_core_sending_resolver;
mod router_core_session_errors;
mod router_core_session_handoff;
mod router_core_session_refusals;
mod router_core_session_sync;
mod router_core_sessions;
mod router_core_teardown;
mod router_core_token_provider;
mod router_core_transfer_disconnect;
mod router_core_transfer_edges;
mod router_core_transfer_limits;
mod router_core_transfer_malformed;
mod router_core_transfer_reentry;
mod router_core_transfer_refusals;
mod router_core_transfer_results;
mod router_core_transfer_shuffle;
mod router_core_transfer_timeouts;
mod router_core_writer;
mod server;
mod server_access_refusals;
mod server_admissions;
mod server_clocks;
mod server_command_credentials;
mod server_commands;
mod server_credential_notifications;
mod server_credentials;
mod server_drop;
mod server_edges;
mod server_elsewhere;
mod server_failures;
mod server_filter;
mod server_jwt_calls;
mod server_late_answers;
mod server_lifecycle;
mod server_notifications;
mod server_pacing;
mod server_requests;
mod server_token_provider;
mod server_unsubscribe;
mod server_waiting;
mod surface;
mod timers;
mod transfer;

// the timeout of a call that sets none of its own
const TIMEOUT: Duration = Duration::from_secs(1);

// how long a test waits on what has settled already
const PATIENCE: Duration = Duration::from_secs(10);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn january_first() -> SystemTime {
    crate::testing::instants::new_year()
}

// a session's token, as a server announces one
fn token() -> SessionToken {
    SessionToken::new([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        .expect("a token of no zero alone")
}

fn result_of(call_id: u32, credential: Option<Credential>) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential,
        },
        payload: Bytes::new(),
    }
}

fn failure_of(call_id: u32, (code, credential): (ProtocolCode, Option<Credential>)) -> Envelope {
    Envelope::Failure {
        header: FailureHeader {
            call_id,
            credential,
        },
        failure: FailureRecord {
            code: code.get(),
            scope: FailureScope::Protocol,
            detail: String::new(),
            relays: 0,
        },
    }
}

fn notification_of(call_id: u32, value: u8) -> Envelope {
    Envelope::Notification {
        header: NotificationHeader { call_id },
        payload: Bytes::from(vec![value]),
    }
}

// a request's header for echo, as either side writes it
fn request_header_of(call_id: u32) -> RequestHeader {
    RequestHeader {
        call_id,
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: None,
    }
}

// what each error says: a failure its code, by name; anything else its message
fn codes_of(errors: &[RouterError]) -> Vec<String> {
    errors
        .iter()
        .map(|error| match error {
            RouterError::Failure(failure) => failure
                .protocol_code()
                .and_then(ProtocolCode::name)
                .map_or_else(|| failure.to_string(), str::to_owned),
            RouterError::Other(error) => error.to_string(),
        })
        .collect()
}

// the outcome of a call that has its answer already
async fn answered(call: Call) -> Result<RouterResult, CallError> {
    crate::testing::patience(PATIENCE, call)
        .await
        .expect("a call answered within its patience")
}

fn options_of(timeout: Duration) -> ResolvedRequestOptions {
    let mut options = ResolvedRequestOptions::new(timeout);

    options.close_on_timeout = Some(false);
    options
}

// echo, as a procedure that notifies
fn notifying() -> Procedure {
    Procedure {
        procedure_kind: Some(ProcedureKind::Notifies),
        ..echo()
    }
}

// a call to echo, or to the procedure `subscribes` subscribes when given
fn request_of(
    (subscribes, timeout): (Option<Arc<dyn NotificationLike>>, Duration),
) -> RouterRequest {
    RouterRequest {
        procedure: subscribes
            .as_ref()
            .map_or_else(echo, |notification| notification.procedure().clone()),
        options: options_of(timeout),
        series: None,
        refusal: None,
        subscribes,
        on_call_id: None,
        on_sent: None,
    }
}

/// A client's router over a scripted transport, on a stepping clock, what it reports kept.
struct Scripted {
    clock: Arc<SteppingClock>,
    transport: Arc<ScriptedClient>,
    router: RouterClient,
    errors: Arc<Mutex<Vec<RouterError>>>,
}

impl Scripted {
    fn new() -> Self {
        Self::with(&RouterClientOptions::default())
    }

    fn with(options: &RouterClientOptions) -> Self {
        let clock = SteppingClock::new(january_first());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = ScriptedClient::new(shared);
        let carried: Arc<dyn crate::transport::RouterClientTransport> =
            Arc::<ScriptedClient>::clone(&transport);
        let router = RouterClient::new(carried, options).expect("a router built");
        let errors: Arc<Mutex<Vec<RouterError>>> = Arc::default();
        let hearing = Arc::clone(&errors);

        router.on_error(Arc::new(move |error: &RouterError| {
            locked(&hearing).push(error.clone());
        }));

        Self {
            clock,
            transport,
            router,
            errors,
        }
    }

    async fn settle(&self) {
        self.clock.settle().await;
    }

    fn codes(&self) -> Vec<String> {
        codes_of(&locked(&self.errors))
    }

    // a notification registered, and the request that subscribes it gone out: what the test
    // delivers next finds its call bound; the call is awaited for its result
    async fn subscribe(
        &self,
        (notification, timeout): (&Arc<dyn NotificationLike>, Duration),
    ) -> Call {
        if !self.router.has_notification(notification) {
            self.router
                .register_notification(Arc::clone(notification))
                .expect("registered");
        }

        let call = self
            .router
            .request(
                Bytes::new(),
                request_of((Some(Arc::clone(notification)), timeout)),
            )
            .expect("subscribing");

        self.settle().await;

        call
    }

    // settles the callbacks of the notification `notification` heard `index`th, failing none
    async fn done(&self, (notification, index): (&Arc<client::Notified>, usize)) {
        notification.settle((index, Vec::new()));
        self.settle().await;
    }
}

// ── What a resolver or a listener that fails changes ──────────────────────────────────────────

// a server resolving echo at its router by `resolve`, over the scripted transport, the first
// connection open: a resolver's errors as its router takes them, beneath a service manager, which
// answers whatever its callback fails with PROCEDURE_FAILED, as the other sides' managers do
fn resolving(resolve: crate::router::core::ResolveFn) -> server::Served {
    serving(crate::router::core::Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    })
}

// a server answering echo at its router by `handler`, as `resolving` does
fn serving(handler: crate::router::core::Handler) -> server::Served {
    let served = server::Served::new(&crate::router::server::RouterServerOptions::default());

    served.transport.open(&server::first(), true);
    served
        .router
        .register_resolver((&echo(), handler))
        .expect("echo registered");

    served
}

// the code and the detail of each failure the server answered on the first connection
fn failures_of(served: &server::Served) -> Vec<(u16, String)> {
    served
        .transport
        .envelopes(&server::first())
        .iter()
        .filter_map(|envelope| match envelope {
            Envelope::Failure { failure, .. } => Some((failure.code.get(), failure.detail.clone())),
            Envelope::Request { .. }
            | Envelope::Result { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        })
        .collect()
}

#[tokio::test]
async fn answers_a_resolver_s_own_failure_as_it_is_and_any_other_error_procedure_failed_with_no_detail_and_reported()
 {
    let served = resolving(Arc::new(
        |props: crate::router::core::RequestResolverProps| {
            Box::pin(async move {
                if props.payload.as_ref() == b"own" {
                    let code = core::num::NonZeroU16::new(21).expect("21 is no zero");

                    return Err(crate::errors::ResolverError::Failure(
                        crate::failure::Failure::application(code, "nothing to echo"),
                    ));
                }

                Err(crate::errors::ResolverError::other(std::io::Error::other(
                    "internal: 10.0.0.5:8443",
                )))
            })
        },
    ));

    served
        .transport
        .deliver(&server::request_of((1, &echo(), "own")), &server::first());
    served
        .transport
        .deliver(&server::request_of((3, &echo(), "other")), &server::first());
    served.settle().await;

    assert_eq!(
        failures_of(&served),
        [
            (21, "nothing to echo".to_owned()),
            (ProtocolCode::PROCEDURE_FAILED.get().get(), String::new())
        ],
        "its own as it is, any other PROCEDURE_FAILED with no detail"
    );
    assert_eq!(
        served.reported(),
        ["internal: 10.0.0.5:8443 first"],
        "the other error reported, with its connection"
    );
}

#[tokio::test]
async fn answers_a_resolver_that_panics_procedure_failed_with_no_detail_and_reported() {
    let served = resolving(Arc::new(
        |_props: crate::router::core::RequestResolverProps| {
            Box::pin(async move {
                panic!("this resolver breaks, on purpose");
            })
        },
    ));

    served
        .transport
        .deliver(&server::request_of((1, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        failures_of(&served),
        [(ProtocolCode::PROCEDURE_FAILED.get().get(), String::new())],
        "PROCEDURE_FAILED with no detail"
    );

    let reported = served.reported();

    assert!(
        matches!(reported.as_slice(), [only] if only.contains("panicked") && only.ends_with(" first")),
        "its panic reported, with its connection: {reported:?}"
    );
}

// what a resolver was handed, each request in turn
type Handed = Arc<Mutex<Vec<crate::router::core::RequestResolverProps>>>;

// a resolver that keeps what it is handed and answers nothing itself, failing the first request
// with `failure` when given one
fn keeping((handed, failure): (&Handed, Option<&'static str>)) -> crate::router::core::ResolveFn {
    let handed = Arc::clone(handed);

    Arc::new(move |props: crate::router::core::RequestResolverProps| {
        let handed = Arc::clone(&handed);

        Box::pin(async move {
            let count = {
                let mut handed = locked(&handed);

                handed.push(props);
                handed.len()
            };

            match failure {
                Some(failure) if count == 1 => Err(crate::errors::ResolverError::other(
                    std::io::Error::other(failure),
                )),
                Some(_) | None => Ok(()),
            }
        })
    })
}

// a cancel of `call_id`, as a client writes it
fn cancel_of(call_id: u32) -> Envelope {
    Envelope::Cancel {
        header: crate::envelope::CancelHeader { call_id },
    }
}

// the calls the server answers right now
async fn answering_of(served: &server::Served) -> Option<u64> {
    served
        .router
        .gauges()
        .await
        .expect("distinct counts")
        .counts
        .get("answeringCalls")
        .copied()
}

// answers the request `handed` was handed `index`th with `payload`, as its resolver would
async fn answer(handed: &Handed, (index, payload): (usize, &'static [u8])) {
    let answerer = locked(handed)
        .get(index)
        .map(|props| Arc::clone(&props.answerer))
        .expect("a request handed");

    answerer
        .respond(crate::router::types::RouterAnswer::Result(
            Bytes::from_static(payload),
        ))
        .await
        .expect("an answer taken");
}

// as its report listener hears `failure`, a cancel of call 5 and a request on it again handed to
// its router, from within that listener
fn handing_back(served: &server::Served, failure: &'static str) {
    let transport = Arc::clone(&served.transport);

    served.router.on_error(Arc::new(
        move |error: &RouterError, _handle: Option<&crate::router::types::ConnectionHandle>| {
            if error.to_string() == failure {
                transport.deliver(&cancel_of(5), &server::first());
                transport.deliver(&server::request_of((5, &echo(), "again")), &server::first());
            }
        },
    ));
}

// spec 9.0
#[tokio::test]
async fn answers_a_failed_resolver_s_call_procedure_failed_before_what_its_report_listener_hands_its_router_whose_cancel_crosses_that_answer_and_whose_replacement_opens_the_call_id_again()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver failed"))));
    let cancels: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&cancels);

    handing_back(&served, "the resolver failed");
    served.router.on_debug(Arc::new(
        move |direction: crate::debug::DebugDirection, traced: &crate::debug::TracedEnvelope| {
            if direction == crate::debug::DebugDirection::Rx
                && traced.header.kind() == crate::constants::EnvelopeKind::Cancel
            {
                locked(&hearing).push(format!(
                    "{} {}",
                    traced.header.call_id(),
                    server::name_of(Some(&traced.connection_handle))
                ));
            }
        },
    ));
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["the resolver failed first"],
        "the failure reported"
    );
    assert_eq!(
        served.sent_since(),
        ["first failure 5 PROCEDURE_FAILED"],
        "answered before what its listener handed back"
    );
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.signal.is_aborted())
            .collect::<Vec<_>>(),
        [false, false],
        "the cancel crossed that answer: it found no call, and aborted nothing"
    );
    assert_eq!(*locked(&cancels), ["5 first"], "the cancel taken");
    assert_eq!(
        answering_of(&served).await,
        Some(1),
        "the replacement opens the call id again"
    );

    answer(&handed, (0, b"1")).await;
    served.settle().await;

    assert!(
        served.sent_since().is_empty(),
        "the failed resolver's answer goes nowhere"
    );

    answer(&handed, (1, b"2")).await;
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first result 5 2"],
        "the replacement answered"
    );
    assert_eq!(answering_of(&served).await, Some(0), "nothing answering");
    assert_eq!(
        served.reported(),
        ["the resolver failed first"],
        "nothing more reported"
    );
}

// spec 9.0
#[tokio::test]
async fn answers_a_failed_admission_s_call_procedure_failed_before_what_its_report_listener_hands_its_router_and_the_replacement_opens_the_call_id_again()
 {
    let handed: Handed = Arc::default();
    let admitted = Arc::new(AtomicUsize::new(0));
    let admitting = Arc::clone(&admitted);
    let served = serving(crate::router::core::Handler {
        resolve: keeping((&handed, None)),
        admit: Some(Arc::new(
            move |_request: &crate::router::core::AdmissionRequest| {
                if admitting.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(crate::errors::ResolverError::other(std::io::Error::other(
                        "the admission failed",
                    )));
                }

                Ok(None)
            },
        )),
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    });

    handing_back(&served, "the admission failed");
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["the admission failed first"],
        "the failure reported"
    );
    assert_eq!(
        served.sent_since(),
        ["first failure 5 PROCEDURE_FAILED"],
        "answered before what its listener handed back"
    );
    assert_eq!(admitted.load(Ordering::SeqCst), 2, "both admissions asked");
    assert_eq!(locked(&handed).len(), 1, "the replacement handed on");
    assert_eq!(
        answering_of(&served).await,
        Some(1),
        "the replacement opens the call id again"
    );

    answer(&handed, (0, b"2")).await;
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first result 5 2"],
        "the replacement answered"
    );
    assert_eq!(answering_of(&served).await, Some(0), "nothing answering");
    assert_eq!(
        served.reported(),
        ["the admission failed first"],
        "nothing more reported"
    );
}

// spec 9.0; decision 0045: disposed at once, a call made after it fails unsent, and what it holds
// is let go in a later turn, behind the answer of the turn its report listener disposes it in
#[tokio::test]
async fn lets_its_connections_go_after_the_turn_its_report_listener_disposes_it_in_behind_the_failed_resolver_s_answer()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver failed"))));
    let router = served.router.clone();
    let made: Arc<Mutex<Vec<Call>>> = Arc::default();
    let making = Arc::clone(&made);

    served.router.on_error(Arc::new(
        move |error: &RouterError, handle: Option<&crate::router::types::ConnectionHandle>| {
            if error.to_string() == "the resolver failed"
                && let Some(handle) = handle
            {
                // disposed at once, its mark read within the listener by a call made after it
                drop(router.dispose());
                locked(&making).push(asking(&router, (handle, "after")));
            }
        },
    ));
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first failure 5 PROCEDURE_FAILED"],
        "the turn's answer sent, and nothing after it"
    );
    assert_eq!(
        served.reported(),
        ["the resolver failed first"],
        "the failure reported, and no answer refused as disposed"
    );
    assert_eq!(answering_of(&served).await, Some(0), "nothing answering");
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.signal.is_aborted())
            .collect::<Vec<_>>(),
        [false],
        "its call closed as its answer went, before what the dispose lets go: nothing aborted"
    );

    let after = locked(&made).pop().expect("a call made after the dispose");

    assert_eq!(
        answered(after).await.err().map(|error| error.to_string()),
        Some("the router was disposed".to_owned()),
        "the call made after the dispose failed unsent"
    );
}

// a call of the server's own to echo on `handle`, as its application makes one
fn asking(
    router: &crate::router::server::RouterServer,
    (handle, payload): (&crate::router::types::ConnectionHandle, &'static str),
) -> Call {
    let mut options = options_of(TIMEOUT);

    options.connection_handle = Some(Arc::clone(handle));

    router
        .request(
            Bytes::from_static(payload.as_bytes()),
            RouterRequest {
                procedure: echo(),
                options,
                series: None,
                refusal: None,
                subscribes: None,
                on_call_id: None,
                on_sent: None,
            },
        )
        .expect("a call")
}

// spec 9.0; decision 0045: the report listener's call of the conversations, at the router
#[tokio::test]
async fn a_call_its_report_listener_makes_goes_behind_what_that_turn_answers() {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver failed"))));
    let router = served.router.clone();
    let made: Arc<Mutex<Vec<Call>>> = Arc::default();
    let making = Arc::clone(&made);

    served.router.on_error(Arc::new(
        move |error: &RouterError, handle: Option<&crate::router::types::ConnectionHandle>| {
            if error.to_string() == "the resolver failed"
                && let Some(handle) = handle
            {
                // within the reporting turn, a call on the connection it reports
                locked(&making).push(asking(&router, (handle, "what time?")));
            }
        },
    ));
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        [
            "first failure 5 PROCEDURE_FAILED",
            "first request 2 what time?"
        ],
        "the call behind what the reporting turn answered"
    );
    assert_eq!(
        served.reported(),
        ["the resolver failed first"],
        "the failure reported"
    );
    assert_eq!(locked(&made).len(), 1, "one call made");
}

// spec 9.0, 15.1; decision 0045: the client's side of the conversation of a call made as a request
// is read, its turn deferring the refusal of an ELSEWHERE its transport carried nothing beside
#[tokio::test]
async fn a_call_a_listener_makes_goes_among_what_its_turn_defers_in_the_order_deferred() {
    let verify: crate::credentials::ElsewhereVerifier =
        Arc::new(|_carried: String, _signal| Box::pin(async { Ok(None) }));
    let scripted = Scripted::with(&RouterClientOptions {
        credentials: Some(crate::credentials::Credentials {
            verify: Some(verify),
            ..crate::credentials::Credentials::default()
        }),
        ..RouterClientOptions::default()
    });
    let clock = Procedure {
        procedure_id: 9,
        procedure_name: "clock".to_owned(),
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    };

    scripted
        .router
        .register_resolver((
            &clock,
            crate::router::core::Handler {
                resolve: Arc::new(|_props: crate::router::core::RequestResolverProps| {
                    Box::pin(async { Ok(()) })
                }),
                admit: None,
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("clock registered");

    let within = scripted.router.clone();
    let made: Arc<Mutex<Vec<Call>>> = Arc::default();
    let making = Arc::clone(&made);

    scripted.router.on_debug(Arc::new(
        move |direction: crate::debug::DebugDirection, traced: &crate::debug::TracedEnvelope| {
            if direction != crate::debug::DebugDirection::Rx
                || traced.header.kind() != crate::constants::EnvelopeKind::Request
            {
                return;
            }

            // within the turn that reads its server's command, before the refusal it defers
            let call = within
                .request(Bytes::from_static(b"made"), request_of((None, TIMEOUT)))
                .expect("a call");

            locked(&making).push(call);
        },
    ));

    // its server's command, an ELSEWHERE its transport carried nothing beside
    scripted.transport.deliver(&Envelope::Request {
        header: RequestHeader {
            service_id: clock.service_id,
            procedure_id: clock.procedure_id,
            credential: Some(Credential::Elsewhere),
            ..request_header_of(2)
        },
        payload: Bytes::new(),
    });
    scripted.settle().await;

    let sent: Vec<String> = scripted
        .transport
        .envelopes()
        .iter()
        .map(|envelope| match envelope {
            Envelope::Request { payload, .. } => format!(
                "request {} {}",
                envelope.call_id(),
                String::from_utf8_lossy(payload)
            ),
            Envelope::Failure { failure, .. } => format!(
                "failure {} {} {}",
                envelope.call_id(),
                ProtocolCode::new(failure.code)
                    .name()
                    .unwrap_or("application"),
                failure.detail
            ),
            Envelope::Result { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => format!("{:?} {}", envelope.kind(), envelope.call_id()),
        })
        .collect();

    assert_eq!(
        sent,
        [
            "request 1 made",
            "failure 2 SESSION_REQUIRED no credential came"
        ],
        "the call ahead of the refusal its turn deferred after it"
    );
    assert_eq!(locked(&made).len(), 1, "one call made");
}

// spec 9.0, 9.1; decision 0045: a call, then a dispose, made within one telling: the call goes
// behind the turn's answer, and the dispose's job lets go of it behind them both
#[tokio::test]
async fn a_call_then_a_dispose_its_report_listener_makes_go_behind_that_turn_s_answer_the_call_before_the_dispose()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver failed"))));
    let router = served.router.clone();
    let made: Arc<Mutex<Vec<Call>>> = Arc::default();
    let making = Arc::clone(&made);

    served.router.on_error(Arc::new(
        move |error: &RouterError, handle: Option<&crate::router::types::ConnectionHandle>| {
            if error.to_string() == "the resolver failed"
                && let Some(handle) = handle
            {
                locked(&making).push(asking(&router, (handle, "before")));
                drop(router.dispose());
            }
        },
    ));
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first failure 5 PROCEDURE_FAILED", "first request 2 before"],
        "the turn's answer, then the call made before the dispose"
    );
    assert_eq!(
        served.reported(),
        ["the resolver failed first"],
        "the failure reported, and nothing refused as disposed"
    );

    let before = locked(&made).pop().expect("a call made before the dispose");

    assert_eq!(
        answered(before).await.err().map(|error| error.to_string()),
        Some("the router was disposed before the answer".to_owned()),
        "the call went, and the dispose's job rejected it as it waited"
    );
}

// decision 0045: the skip of an answer to a call no longer answering and the send gate read one
// mark, the state's, so an answer queued ahead of a dispose's job, on a call its requester
// cancelled, goes nowhere, though the handle's mark is set
#[tokio::test]
async fn an_answer_its_resolver_gives_after_a_dispose_queued_behind_it_sends_nothing_on_a_cancelled_call()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, None)));

    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;
    served.transport.deliver(&cancel_of(5), &server::first());
    served.settle().await;

    // * the answer queued, then the dispose behind it, its handle's mark set at once
    let answerer = locked(&handed)
        .first()
        .map(|props| Arc::clone(&props.answerer))
        .expect("a request handed");
    let answering = answerer.respond(crate::router::types::RouterAnswer::Result(
        Bytes::from_static(b"late"),
    ));
    let disposed = served.router.dispose();

    served.settle().await;
    disposed.await;

    assert!(
        served.sent_since().is_empty(),
        "nothing sent on the cancelled call"
    );
    assert_eq!(
        crate::testing::patience(PATIENCE, answering)
            .await
            .expect("taken within its patience")
            .map_err(|error| error.to_string()),
        Ok(()),
        "its answer skipped, as a cancelled call's is, never refused as disposed"
    );
    assert!(served.reported().is_empty(), "nothing reported");
}

// a listener of a transport's that panics on each message it hears
struct Panicking;

// what a transport reports, each as its words
struct Reporting(Arc<Mutex<Vec<String>>>);

impl crate::transport::ServerListener for Reporting {
    fn on_error(
        &self,
        error: &RouterError,
        _connection_handle: Option<&crate::router::types::ConnectionHandle>,
    ) {
        locked(&self.0).push(error.to_string());
    }
}

impl crate::transport::ServerListener for Panicking {
    fn on_message(
        &self,
        _message: crate::router::types::TransportMessage,
        _connection_handle: &crate::router::types::ConnectionHandle,
    ) {
        panic!("this listener breaks, on purpose");
    }
}

#[tokio::test]
async fn a_listener_s_panic_is_reported_and_the_transport_goes_on() {
    let pair = crate::testing::pair::Pair::connected(
        january_first(),
        &crate::testing::pair::PairOptions::default(),
    )
    .await
    .expect("a pair connected");

    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            crate::managers::service::RequestResolverDependencies::new(
                crate::payloads::TextCodec,
                crate::payloads::TextCodec,
            ),
        )
        .expect("echo resolved")
        .on(Arc::new(
            |request, response: crate::managers::service::Response<crate::payloads::TextCodec>| {
                response.result(request.payload)
            },
        ))
        .expect("echo registered");
    let reports: Arc<Mutex<Vec<String>>> = Arc::default();

    crate::transport::ServerTransport::listen(&pair.memory, Arc::new(Panicking));
    crate::transport::ServerTransport::listen(
        &pair.memory,
        Arc::new(Reporting(Arc::clone(&reports))),
    );

    let call = pair
        .client
        .services()
        .get_request(
            &echo(),
            crate::managers::service::RequestDependencies::new(
                crate::payloads::TextCodec,
                crate::payloads::TextCodec,
            ),
        )
        .expect("echo asked")
        .call(
            "hi".to_owned(),
            &crate::managers::service::RequestOptions::default(),
        )
        .expect("echo called");

    pair.settle().await;

    assert_eq!(
        crate::testing::patience(PATIENCE, call)
            .await
            .expect("answered within its patience")
            .expect("echo answered"),
        "hi",
        "the transport goes on"
    );

    // * reported by its transport, with the connection it was told of; its router reports none
    // of it, as on the other sides (spec 15.1)
    let reported = locked(&reports).clone();

    assert!(
        reported
            .iter()
            .any(|error| error == "a listener panicked: this listener breaks, on purpose"),
        "its panic reported: {reported:?}"
    );
    assert!(
        locked(&pair.server_reports).is_empty(),
        "its router reports none of it: {:?}",
        locked(&pair.server_reports)
    );
}

// ── What a router has not taken yet: its intake (spec 15.12, decision 0046) ──────────────────

// the twins of what a router counts of what its transport hands it, its pauses and its resumes,
// over the scripted transports and the in-memory one
mod intake {
    use core::sync::atomic::{AtomicBool, Ordering};
    use core::time::Duration;
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;

    use super::{
        PATIENCE, Scripted, answered, cancel_of, january_first, locked, options_of, panics,
        router_core_rest, server,
    };
    use crate::client::ClientOptions;
    use crate::clock::SharedClock;
    use crate::constants::EnvelopeKind;
    use crate::debug::{DebugDirection, TracedEnvelope};
    use crate::errors::CallError;
    use crate::managers::service::{
        RequestDependencies, RequestOptions, RequestResolverDependencies, Response,
    };
    use crate::memory::{
        MemoryTransportClient, MemoryTransportClientConnectOptions, MemoryTransportClientOptions,
        MemoryTransportServer, MemoryTransportServerOptions,
    };
    use crate::payloads::RawCodec;
    use crate::router::client::RouterClientOptions;
    use crate::router::server::{RouterServer, RouterServerOptions};
    use crate::router::types::{
        IntakeLimitsOptions, RouterLimitsOptions, RouterRequest, TransportMessage,
    };
    use crate::server::ServerOptions;
    use crate::testing::SteppingClock;
    use crate::testing::pair::{Pair, PairOptions, echo};
    use crate::testing::scripted::bytes_of;
    use crate::transport::{RouterClientTransport, ServerTransport};

    // a server's router options of the intake bounds given, its envelopes then its bytes
    fn intake_of((envelopes, bytes): (u64, u64)) -> RouterServerOptions {
        RouterServerOptions {
            intake: Some(IntakeLimitsOptions {
                maximum_untaken_envelopes: Some(envelopes),
                maximum_untaken_bytes: Some(bytes),
            }),
            ..RouterServerOptions::default()
        }
    }

    // what a server's router takes, as it takes each: its connection's name and its call id, and
    // `paused` when its transport holds that connection paused at that moment
    fn taking(served: &server::Served) -> Arc<Mutex<Vec<String>>> {
        let taken: Arc<Mutex<Vec<String>>> = Arc::default();
        let (seeing, transport) = (Arc::clone(&taken), Arc::clone(&served.transport));

        served.router.on_debug(Arc::new(
            move |direction: DebugDirection, traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx {
                    let handle = &traced.connection_handle;
                    let paused = if transport.is_paused(handle) {
                        " paused"
                    } else {
                        ""
                    };

                    locked(&seeing).push(format!(
                        "{} {}{paused}",
                        server::name_of(Some(handle)),
                        traced.header.call_id()
                    ));
                }
            },
        ));

        taken
    }

    // each pause and resume a server's router asked of its transport, with its connection's name
    fn paces_of(served: &server::Served) -> Vec<String> {
        served
            .transport
            .pauses()
            .iter()
            .map(|(is_paused, handle)| {
                format!(
                    "{} {}",
                    if *is_paused { "pause" } else { "resume" },
                    server::name_of(Some(handle))
                )
            })
            .collect()
    }

    // spec 15.12.17, 15.12.18: the twin of "pauses a connection once its untaken envelopes reach a
    // bound, and resumes it once they are at half"
    #[tokio::test]
    async fn pauses_a_connection_once_its_untaken_envelopes_reach_a_bound_and_resumes_it_once_they_are_at_half()
     {
        let served = server::Served::new(&intake_of((4, 1_048_576)));
        let taken = taking(&served);
        let first = server::first();

        served.transport.open(&first, true);

        for call_id in 1..=3 {
            served.transport.deliver(&cancel_of(call_id), &first);
        }

        assert!(
            !served.transport.is_paused(&first),
            "three untaken, under its bound of 4"
        );

        served.transport.deliver(&cancel_of(4), &first);

        assert!(served.transport.is_paused(&first), "paused at the fourth");

        for call_id in [5, 6] {
            served.transport.deliver(&cancel_of(call_id), &first);
        }

        assert_eq!(
            served.transport.held(&first),
            2,
            "what came after it held by its transport"
        );
        assert!(locked(&taken).is_empty(), "nothing taken yet");

        served.settle().await;

        // * resumed once the second was taken, 2 untaken, half of 4; what it held handed on after
        assert_eq!(
            *locked(&taken),
            [
                "first 1 paused",
                "first 2 paused",
                "first 3",
                "first 4",
                "first 5",
                "first 6"
            ],
            "each taken in order, resumed at half"
        );
        assert_eq!(
            paces_of(&served),
            ["pause first", "resume first"],
            "paused once, resumed once"
        );
        assert_eq!(served.transport.held(&first), 0, "nothing held");
    }

    // spec 15.12.17, 15.12.18: the twin of "takes the envelope that reaches a bound": by its count,
    // and by its bytes, an envelope past the byte bound taken whole, never held for good
    #[tokio::test]
    async fn takes_the_envelope_that_reaches_a_bound() {
        let served = server::Served::new(&intake_of((2, 1_048_576)));
        let taken = taking(&served);
        let first = server::first();

        served.transport.open(&first, true);

        for call_id in 1..=3 {
            served.transport.deliver(&cancel_of(call_id), &first);
        }

        assert_eq!(
            served.transport.held(&first),
            1,
            "the second, which reached the bound, handed; the third alone held"
        );

        served.settle().await;

        assert_eq!(
            *locked(&taken),
            ["first 1 paused", "first 2", "first 3"],
            "the one that reached the bound taken, and the rest once resumed"
        );

        // * an envelope larger than the byte bound is handed, taken and released
        let served = server::Served::new(&intake_of((64, 100)));
        let taken = taking(&served);

        served.transport.open(&first, true);
        served.transport.deliver(
            &server::request_of((1, &echo(), &"a".repeat(1_000))),
            &first,
        );

        assert!(
            served.transport.is_paused(&first),
            "paused by the bytes of the one that reached it"
        );

        served.transport.deliver(&cancel_of(9), &first);

        assert_eq!(served.transport.held(&first), 1, "what came after it held");

        served.settle().await;

        assert_eq!(
            *locked(&taken),
            ["first 1 paused", "first 9"],
            "taken whole, then the rest"
        );
        assert_eq!(
            paces_of(&served),
            ["pause first", "resume first"],
            "resumed once it was taken"
        );
    }

    // a client of `memory` connected from `address`, on `clock`
    async fn connected_from(
        (memory, clock): (&MemoryTransportServer, &Arc<SteppingClock>),
        address: &str,
    ) -> MemoryTransportClient {
        let shared: SharedClock = Arc::<SteppingClock>::clone(clock);
        let client = MemoryTransportClient::new(&MemoryTransportClientOptions {
            clock: Some(shared),
        })
        .expect("a client");
        let connecting = client.connect(&MemoryTransportClientConnectOptions {
            address: Some(address.to_owned()),
            ..MemoryTransportClientConnectOptions::new(memory.clone())
        });

        clock.settle().await;
        connecting.await.expect("connected");

        client
    }

    // spec 15.12.17: the twin of "an envelope of one connection waits behind no more than the bound
    // of another that floods", over the in-memory transport
    #[tokio::test]
    async fn an_envelope_of_one_connection_waits_behind_no_more_than_the_bound_of_another_that_floods()
     {
        let clock = SteppingClock::new(january_first());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let memory = MemoryTransportServer::new(&MemoryTransportServerOptions {
            clock: Some(shared),
            runtime: None,
        })
        .expect("a server");
        let router = RouterServer::new(Arc::new(memory.clone()), &intake_of((4, 1_048_576)))
            .expect("a router");
        let taken: Arc<Mutex<Vec<String>>> = Arc::default();
        let seeing = Arc::clone(&taken);

        router.on_debug(Arc::new(
            move |direction: DebugDirection, traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx {
                    let from = if traced.connection_handle.contains("ip=flooding;") {
                        "flooding"
                    } else {
                        "other"
                    };

                    locked(&seeing).push(format!("{from} {}", traced.header.call_id()));
                }
            },
        ));
        memory.start().await.expect("started");

        let flooding = connected_from((&memory, &clock), "flooding").await;
        let other = connected_from((&memory, &clock), "other").await;
        let message_of = |call_id: u32| TransportMessage {
            data: bytes_of(&cancel_of(call_id)),
            ..TransportMessage::default()
        };

        // * 40 of one connection, then one of the other, sent before any is taken
        for call_id in 1..=40 {
            flooding.send(message_of(call_id)).expect("sent");
        }

        other.send(message_of(1_001)).expect("sent");
        clock.settle().await;

        let taken = locked(&taken).clone();
        let ahead = taken
            .iter()
            .position(|seen| seen.starts_with("other"))
            .expect("the other's taken");

        assert!(
            ahead <= 4,
            "the other's waited behind {ahead} of the flood's, its bound 4: {taken:?}"
        );
        assert_eq!(
            taken
                .iter()
                .filter(|seen| seen.starts_with("flooding"))
                .cloned()
                .collect::<Vec<_>>(),
            (1..=40)
                .map(|call_id| format!("flooding {call_id}"))
                .collect::<Vec<_>>(),
            "the flood taken whole, in order"
        );

        router.dispose().await;
    }

    // spec 15.12.17, 15.12.18: the twin of "counts nothing the router does of its own: a timer, a
    // resolution, a dispose, a deferred call": of a bound of 1, the one envelope its transport
    // handed alone pauses its connection
    #[tokio::test]
    async fn counts_nothing_the_router_does_of_its_own_a_timer_a_resolution_a_dispose_a_deferred_call()
     {
        let served = server::Served::new(&intake_of((1, 1_048_576)));
        let first = server::first();

        served.transport.open(&first, true);
        // a resolution: echo resolved off the owner, its outcome posted back
        served
            .services
            .get_request_resolver(
                &echo(),
                RequestResolverDependencies::new(RawCodec, RawCodec),
            )
            .expect("echo resolved")
            .on(Arc::new(|request, response: Response<RawCodec>| {
                response.result(request.payload)
            }))
            .expect("echo registered");

        // a deferred call: one of its own, made from within the telling of the request it takes
        let (deferring, is_made) = (served.router.clone(), Arc::new(AtomicBool::new(false)));
        let made = Arc::clone(&is_made);

        served.router.on_debug(Arc::new(
            move |direction: DebugDirection, _traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx && !made.swap(true, Ordering::SeqCst) {
                    let mut options = options_of(Duration::from_millis(50));

                    options.connection_handle = Some(server::first());
                    drop(
                        deferring
                            .request(
                                Bytes::new(),
                                RouterRequest {
                                    procedure: echo(),
                                    options,
                                    series: None,
                                    refusal: None,
                                    subscribes: None,
                                    on_call_id: None,
                                    on_sent: None,
                                },
                            )
                            .expect("a call made"),
                    );
                }
            },
        ));

        // a timer: a call of its own, ended by its timeout on the clock
        let timed = router_core_rest::asking(&served, Duration::from_millis(50));

        served
            .transport
            .deliver(&server::request_of((1, &echo(), "hi")), &first);
        served.settle().await;
        served.clock.advance(Duration::from_millis(50)).await;

        assert!(
            matches!(answered(timed).await, Err(CallError::TimedOut(_))),
            "its own call timed out"
        );
        assert!(is_made.load(Ordering::SeqCst), "its deferred call made");
        assert!(
            served
                .transport
                .calls(&first)
                .contains(&(EnvelopeKind::Result, 1)),
            "echo answered"
        );

        // a dispose
        served.router.dispose().await;
        served.settle().await;

        assert_eq!(
            paces_of(&served),
            ["pause first", "resume first"],
            "the envelope its transport handed alone counted"
        );
    }

    // spec 15.12.17; decision 0045: the twin of "counts an envelope handed within a telling, and
    // releases it by its deferred turn"
    #[tokio::test]
    async fn counts_an_envelope_handed_within_a_telling_and_releases_it_by_its_deferred_turn() {
        let served = server::Served::new(&intake_of((1, 1_048_576)));
        let (first, second) = (server::first(), server::second());
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let (seeing, transport) = (Arc::clone(&seen), Arc::clone(&served.transport));

        served.transport.open(&first, true);
        served.transport.open(&second, true);
        served.router.on_debug(Arc::new(
            move |direction: DebugDirection, traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx && traced.header.call_id() == 1 {
                    // * handed within the turn that tells this listener: counted as it is handed
                    transport.deliver(&cancel_of(2), &server::second());
                    locked(&seeing).push(format!(
                        "the second paused within the telling: {}",
                        transport.is_paused(&server::second())
                    ));
                }
            },
        ));
        served.transport.deliver(&cancel_of(1), &first);
        served.settle().await;

        assert_eq!(
            *locked(&seen),
            ["the second paused within the telling: true"],
            "counted as it was handed, within the telling"
        );
        assert_eq!(
            paces_of(&served),
            [
                "pause first",
                "pause second",
                "resume first",
                "resume second"
            ],
            "released by its deferred turn, after the telling's"
        );
        assert!(!served.transport.is_paused(&second), "resumed");
    }

    // spec 15.12.17: the twin of "reports what its transport throws as it pauses or resumes a
    // connection, and takes the envelope all the same": what it panics with is its transport's
    // error, and what the count decided holds
    #[tokio::test]
    async fn reports_what_its_transport_throws_as_it_pauses_or_resumes_a_connection_and_takes_the_envelope_all_the_same()
     {
        let served = server::Served::new(&intake_of((1, 1_048_576)));
        let first = server::first();
        let taken = taking(&served);

        served.transport.open(&first, true);
        served.transport.set_pacing_broken(true);
        served.transport.deliver(&cancel_of(1), &first);
        served.settle().await;

        assert_eq!(*locked(&taken), ["first 1 paused"], "taken all the same");
        assert_eq!(
            paces_of(&served),
            ["pause first", "resume first"],
            "paused and resumed"
        );

        let reported = served.reported();

        assert!(
            reported.len() == 2
                && reported[0].contains("no pause")
                && reported[1].contains("no resume")
                && reported.iter().all(|line| line.ends_with(" first")),
            "each panic reported with its connection: {reported:?}"
        );
    }

    // spec 15.12.17; decision 0044: the twin of "resumes a connection whose envelope a throwing
    // listener heard": a listener's panic is caught and its turn goes on, releasing what it took; a
    // panic past the guards ends the owner, whose end resumes each connection it paused
    #[tokio::test]
    async fn resumes_a_connection_whose_envelope_a_throwing_listener_heard() {
        let served = server::Served::new(&intake_of((1, 1_048_576)));
        let first = server::first();

        served.transport.open(&first, true);
        served.router.on_debug(Arc::new(
            |direction: DebugDirection, _traced: &TracedEnvelope| {
                assert!(
                    direction != DebugDirection::Rx,
                    "this listener breaks, on purpose"
                );
            },
        ));
        served.transport.deliver(&cancel_of(1), &first);

        assert!(served.transport.is_paused(&first), "paused");

        served.settle().await;

        assert_eq!(
            paces_of(&served),
            ["pause first", "resume first"],
            "resumed as its turn went on past the listener"
        );
        assert!(
            served
                .reported()
                .iter()
                .any(|reported| reported.contains("this listener breaks, on purpose")),
            "the listener's panic reported: {:?}",
            served.reported()
        );

        // * a turn that panics past the guards ends its owner, which resumes what it paused
        let clock = Arc::new(panics::Breaking {
            clock: SteppingClock::new(january_first()),
            breaks: AtomicBool::new(false),
        });
        let shared: SharedClock = Arc::<panics::Breaking>::clone(&clock);
        let broken = server::Served::on(
            (shared, Arc::clone(&clock.clock)),
            &intake_of((1, 1_048_576)),
        );

        broken.transport.open(&first, true);
        broken.settle().await;
        clock.breaks.store(true, Ordering::SeqCst);

        // its turn arms its timeout on a clock that breaks, ahead of the envelope's turn
        let breaking = router_core_rest::asking(&broken, Duration::from_secs(1));

        broken.transport.deliver(&cancel_of(1), &first);

        assert!(broken.transport.is_paused(&first), "paused");

        broken.settle().await;

        assert!(answered(breaking).await.is_err(), "its owner ended");
        assert_eq!(
            paces_of(&broken),
            ["pause first", "resume first"],
            "resumed as its owner ended, its envelope's turn never run"
        );
    }

    // spec 15.12.17: the twin of "resumes every connection it paused as it is disposed": what a
    // turn took before the dispose's is released as ever; an envelope counted as the dispose's job
    // was queued ahead of its own, a reader's thread racing the dispose, is resumed by the dispose;
    // and nothing is paused after
    #[tokio::test]
    async fn resumes_every_connection_it_paused_as_it_is_disposed() {
        let served = server::Served::new(&intake_of((1, 1_048_576)));
        let (first, second) = (server::first(), server::second());

        served.transport.open(&first, true);
        served.transport.open(&second, true);
        served.settle().await;

        // * the race, in order: the dispose's job queued as the reader's thread counts what it
        // hands, the handle's mark not seen yet
        served
            .router
            .owner()
            .offer(Box::new(crate::router::server::dispose));
        served.transport.deliver(&cancel_of(1), &first);
        served.transport.deliver(&cancel_of(2), &second);

        assert!(
            served.transport.is_paused(&first) && served.transport.is_paused(&second),
            "both paused"
        );

        served.settle().await;

        assert_eq!(
            paces_of(&served),
            [
                "pause first",
                "pause second",
                "resume first",
                "resume second"
            ],
            "each connection it paused resumed as it was disposed"
        );

        // nothing paused after: what its transport hands from then on is counted no more
        for call_id in 3..=5 {
            served.transport.deliver(&cancel_of(call_id), &first);
        }

        served.router.dispose().await;
        served.settle().await;

        assert_eq!(paces_of(&served).len(), 4, "no pause after its dispose");
        assert_eq!(served.transport.held(&first), 0, "nothing held");
    }

    // spec 15.12.17: the twin of "a client pauses its transport while what its server sent is
    // untaken past a bound"
    #[tokio::test]
    async fn a_client_pauses_its_transport_while_what_its_server_sent_is_untaken_past_a_bound() {
        let scripted = Scripted::with(&RouterClientOptions {
            intake: Some(IntakeLimitsOptions {
                maximum_untaken_envelopes: Some(2),
                maximum_untaken_bytes: Some(1_048_576),
            }),
            ..RouterClientOptions::default()
        });
        let taken: Arc<Mutex<Vec<String>>> = Arc::default();
        let (seeing, transport) = (Arc::clone(&taken), Arc::clone(&scripted.transport));

        scripted.router.on_debug(Arc::new(
            move |direction: DebugDirection, traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx {
                    let paused = if transport.is_paused() { " paused" } else { "" };

                    locked(&seeing).push(format!("{}{paused}", traced.header.call_id()));
                }
            },
        ));

        for call_id in 1..=3 {
            scripted.transport.deliver(&cancel_of(call_id));
        }

        assert!(scripted.transport.is_paused(), "paused at the second");
        assert_eq!(scripted.transport.held(), 1, "the third held");

        scripted.settle().await;

        assert_eq!(
            *locked(&taken),
            ["1 paused", "2", "3"],
            "each taken in order, resumed at half"
        );
        assert_eq!(
            scripted.transport.pauses(),
            [true, false],
            "paused once, resumed once"
        );
        assert!(!scripted.transport.is_paused(), "resumed");
    }

    // spec 15.12.17; decision 0046: the twin of "a result sent as a transfer completes while its
    // credits come on a paused connection": each envelope pauses its connection at a bound of 1,
    // and the release never waits on the peer
    #[tokio::test]
    async fn a_result_sent_as_a_transfer_completes_while_its_credits_come_on_a_paused_connection() {
        // an envelope of 64 bytes at most: 300 bytes cross as a transfer each way
        let limits = RouterLimitsOptions {
            chunk_bytes: Some(64),
            maximum_envelope_bytes: Some(64),
            window_bytes: Some(128),
            ..RouterLimitsOptions::default()
        };
        let intake = IntakeLimitsOptions {
            maximum_untaken_envelopes: Some(1),
            maximum_untaken_bytes: Some(1_048_576),
        };
        let mut server = ServerOptions::default();
        let mut client = ClientOptions::default();

        server.limits = Some(limits.clone());
        server.intake = Some(intake.clone());
        client.limits = Some(limits);
        client.intake = Some(intake);

        let pair = Pair::connected(
            january_first(),
            &PairOptions {
                server: Some(server),
                client: Some(client),
            },
        )
        .await
        .expect("a pair connected");
        let credits: Arc<Mutex<Vec<bool>>> = Arc::default();
        let (seeing, memory) = (Arc::clone(&credits), pair.memory.clone());

        pair.server
            .services()
            .get_request_resolver(
                &echo(),
                RequestResolverDependencies::new(RawCodec, RawCodec),
            )
            .expect("echo resolved")
            .on(Arc::new(|request, response: Response<RawCodec>| {
                response.result(request.payload)
            }))
            .expect("echo registered");
        pair.server.router().on_debug(Arc::new(
            move |direction: DebugDirection, traced: &TracedEnvelope| {
                if direction == DebugDirection::Rx && traced.header.kind() == EnvelopeKind::Credit {
                    locked(&seeing).push(memory.is_paused(&traced.connection_handle));
                }
            },
        ));

        let payload = Bytes::from(
            (0..300_u16)
                .map(|index| u8::try_from(index % 251).unwrap_or(0))
                .collect::<Vec<u8>>(),
        );
        let call = pair
            .client
            .services()
            .get_request(&echo(), RequestDependencies::new(RawCodec, RawCodec))
            .expect("echo asked")
            .call(payload.clone(), &RequestOptions::default())
            .expect("echo called");

        pair.settle().await;

        let echoed = crate::testing::patience(PATIENCE, call)
            .await
            .expect("answered within its patience")
            .expect("echo answered");

        assert_eq!(echoed, payload, "its payload, whole, both ways");

        let credits = locked(&credits).clone();

        assert!(
            !credits.is_empty() && credits.iter().all(|is_paused| *is_paused),
            "each credit taken on a connection paused: {credits:?}"
        );
    }
}
