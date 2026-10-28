//! The routers' tests: a client's against bytes a test writes as a server would, a server's against
//! bytes a test writes as its clients would, the core both share, the relay, what a resolver or a
//! listener that fails changes, and what a report listener hands its router back.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use bytes::Bytes;

use crate::clock::SharedClock;
use crate::constants::{FailureScope, ProcedureKind, ProtocolCode};
use crate::envelope::{
    Credential, Envelope, FailureHeader, FailureRecord, NotificationHeader, RequestHeader,
    ResultHeader,
};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::router::client::{ClientRequest, NotificationLike, RouterClient, RouterClientOptions};
use crate::router::server::{Call, CallHooks};
use crate::router::types::{ResolvedRequestOptions, RouterError, RouterResult};
use crate::session_token::SessionToken;
use crate::testing::SteppingClock;
use crate::testing::pair::echo;
use crate::testing::scripted::ScriptedClient;

mod calls;
mod client;
mod metrics;
mod parts;
mod router_core;
mod server;
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
    tokio::time::timeout(PATIENCE, call)
        .await
        .expect("a call answered within its patience")
}

fn options_of(timeout: Duration) -> ResolvedRequestOptions {
    ResolvedRequestOptions {
        timeout,
        destination_id: None,
        connection_handle: None,
        credential: None,
        signal: None,
        close_on_timeout: false,
    }
}

// echo, as a procedure that notifies
fn notifying() -> Procedure {
    Procedure {
        kind: Some(ProcedureKind::Notifies),
        ..echo()
    }
}

// a call to echo, or to the procedure `subscribes` subscribes when given
fn request_of(
    (subscribes, timeout): (Option<Arc<dyn NotificationLike>>, Duration),
) -> ClientRequest {
    ClientRequest {
        procedure: subscribes
            .as_ref()
            .map_or_else(echo, |notification| notification.procedure().clone()),
        options: options_of(timeout),
        series: None,
        refusal: None,
        subscribes,
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
        let carried: Arc<dyn crate::transport::ClientTransport> =
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
                (
                    request_of((Some(Arc::clone(notification)), timeout)),
                    CallHooks::default(),
                ),
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
    let served = resolving(Arc::new(|props: crate::router::core::ResolverProps| {
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
    }));

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
    let served = resolving(Arc::new(|_props: crate::router::core::ResolverProps| {
        Box::pin(async move {
            panic!("this resolver breaks, on purpose");
        })
    }));

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
type Handed = Arc<Mutex<Vec<crate::router::core::ResolverProps>>>;

// a resolver that keeps what it is handed and answers nothing itself, failing the first request
// with `failure` when given one
fn keeping((handed, failure): (&Handed, Option<&'static str>)) -> crate::router::core::ResolveFn {
    let handed = Arc::clone(handed);

    Arc::new(move |props: crate::router::core::ResolverProps| {
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

// spec 9.0
#[tokio::test]
async fn lets_its_connections_go_after_the_turn_its_report_listener_disposes_it_in_the_failed_resolver_s_answer_refused_as_disposed_and_reported()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver failed"))));
    let router = served.router.clone();

    served.router.on_error(Arc::new(
        move |error: &RouterError, _handle: Option<&crate::router::types::ConnectionHandle>| {
            if error.to_string() == "the resolver failed" {
                // disposed at once, what it holds let go in a later turn
                drop(router.dispose());
            }
        },
    ));
    served
        .transport
        .deliver(&server::request_of((5, &echo(), "hi")), &server::first());
    served.settle().await;

    assert!(served.sent_since().is_empty(), "nothing sent once disposed");
    assert_eq!(
        served.reported(),
        ["the resolver failed first", "the router was disposed first"],
        "the failure reported, then its answer refused as disposed"
    );
    assert_eq!(answering_of(&served).await, Some(0), "nothing answering");
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.signal.is_aborted())
            .collect::<Vec<_>>(),
        [false],
        "its call closed as its answer failed, before what the dispose lets go: nothing aborted"
    );
}

// a listener of a transport's that panics on each message it hears
struct Panicking;

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
    let pair = crate::testing::pair::Pair::connected((
        january_first(),
        crate::testing::pair::PairOptions::default(),
    ))
    .await
    .expect("a pair connected");

    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            crate::managers::service::ResolverDependencies::of(
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
    crate::transport::ServerTransport::listen(&pair.memory, Arc::new(Panicking));

    let call = pair
        .client
        .services()
        .get_request(
            &echo(),
            crate::managers::service::RequestDependencies::of(
                crate::payloads::TextCodec,
                crate::payloads::TextCodec,
            ),
        )
        .expect("echo asked")
        .call(
            "hi".to_owned(),
            crate::managers::service::RequestOptions::default(),
        )
        .expect("echo called");

    pair.settle().await;

    assert_eq!(
        tokio::time::timeout(PATIENCE, call)
            .await
            .expect("answered within its patience")
            .expect("echo answered"),
        "hi",
        "the transport goes on"
    );

    let reported: Vec<String> = locked(&pair.server_reports)
        .iter()
        .map(|(error, _handle)| error.to_string())
        .collect();

    assert!(
        reported
            .iter()
            .any(|error| error == "a listener panicked: this listener breaks, on purpose"),
        "its panic reported: {reported:?}"
    );
}
