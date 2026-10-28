//! The server's router against bytes a test writes as its clients would: its notifications, what it
//! counts at its gates that no conversation reaches, its registry's refusals, and the relay's leg A.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{answered, locked, options_of, request_header_of};
use crate::clock::SharedClock;
use crate::constants::{ProcedureKind, ProtocolCode};
use crate::debug::DebugDirection;
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::managers::service::{
    DebugEvent, NotifyOptions, RequestDependencies, ResolverDependencies, Response, ServiceManager,
    ServiceManagerOptions, ServiceRouter, TracedError,
};
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::relay::{DestinationOptions, RelayOptions};
use crate::router::server::{CallHooks, RouterServer, RouterServerOptions, ServerRequest};
use crate::router::types::{ConnectionHandle, RouterActivity, RouterError, RouterLimitsOptions};
use crate::testing::SteppingClock;
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::testing::scripted::{ScriptedServer, Sending, handle_of};

pub(super) fn first() -> ConnectionHandle {
    handle_of(1)
}

pub(super) fn second() -> ConnectionHandle {
    handle_of(2)
}

// the notifying procedure the tests subscribe to: procedure 5 of service 2
pub(super) fn news() -> Procedure {
    Procedure {
        id: 5,
        name: "news".to_owned(),
        kind: Some(ProcedureKind::Notifies),
        ..echo()
    }
}

// a value no codec of text writes: a Rust string holds no surrogate alone, which the other sides'
// text codecs refuse, so this codec refuses every value it is given
#[derive(Debug)]
struct Unwritable;

impl PayloadCodec for Unwritable {
    type Value = String;

    fn decode(&self, bytes: &Bytes) -> Result<String, CodecRefusal> {
        TextCodec.decode(bytes)
    }

    fn encode(&self, _value: &String) -> Result<Bytes, CodecRefusal> {
        Err(CodecRefusal::new("a text value holds a surrogate alone"))
    }

    fn encoding(&self) -> &'static str {
        "text"
    }
}

pub(super) fn name_of(connection_handle: Option<&ConnectionHandle>) -> String {
    match connection_handle {
        Some(handle) if *handle == first() => "first".to_owned(),
        Some(handle) if *handle == second() => "second".to_owned(),
        Some(handle) => handle.to_string(),
        None => "no connection".to_owned(),
    }
}

pub(super) fn text_of(payload: &Bytes) -> String {
    String::from_utf8_lossy(payload).into_owned()
}

// what a server's router reported, each with its connection
type Reports = Arc<Mutex<Vec<(RouterError, Option<ConnectionHandle>)>>>;

// a request's header for `procedure`
pub(super) fn header_of((call_id, procedure): (u32, &Procedure)) -> RequestHeader {
    RequestHeader {
        service_id: procedure.service_id,
        procedure_id: procedure.id,
        ..request_header_of(call_id)
    }
}

pub(super) fn request_of((call_id, procedure, payload): (u32, &Procedure, &str)) -> Envelope {
    Envelope::Request {
        header: header_of((call_id, procedure)),
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

pub(super) fn subscribing_of(call_id: u32) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            opens_subscription: true,
            ..header_of((call_id, &news()))
        },
        payload: Bytes::new(),
    }
}

/// A server's router over a scripted transport, a service manager over it, on a stepping clock:
/// what it reports, with its connection, and what it did, kept.
pub(super) struct Served {
    pub(super) clock: Arc<SteppingClock>,
    pub(super) transport: Arc<ScriptedServer>,
    pub(super) router: RouterServer,
    pub(super) services: ServiceManager,
    pub(super) reports: Reports,
    pub(super) activity: Arc<Mutex<Vec<String>>>,
}

impl Served {
    pub(super) fn new(options: &RouterServerOptions) -> Self {
        let clock = SteppingClock::new(super::january_first());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);

        Self::on((shared, clock), options)
    }

    pub(super) fn on(
        (shared, clock): (SharedClock, Arc<SteppingClock>),
        options: &RouterServerOptions,
    ) -> Self {
        let transport = ScriptedServer::new(shared);
        let carried: Arc<dyn crate::transport::ServerTransport> =
            Arc::<ScriptedServer>::clone(&transport);
        let router = RouterServer::new(carried, options).expect("a router built");
        let services = ServiceManager::new(
            ServiceRouter::Server(router.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("a manager built");
        let reports: Reports = Arc::default();
        let activity: Arc<Mutex<Vec<String>>> = Arc::default();
        let (reporting, acting) = (Arc::clone(&reports), Arc::clone(&activity));

        router.on_error(Arc::new(
            move |error: &RouterError, handle: Option<&ConnectionHandle>| {
                locked(&reporting).push((error.clone(), handle.cloned()));
            },
        ));
        router.on_activity(Arc::new(
            move |what: RouterActivity, handle: &ConnectionHandle| {
                locked(&acting).push(format!("{what:?} {}", name_of(Some(handle))));
            },
        ));

        Self {
            clock,
            transport,
            router,
            services,
            reports,
            activity,
        }
    }

    pub(super) async fn settle(&self) {
        self.clock.settle().await;
    }

    // what it reported, each by its code or its message, and its connection's name
    pub(super) fn reported(&self) -> Vec<String> {
        locked(&self.reports)
            .iter()
            .map(|(error, handle)| {
                format!(
                    "{} {}",
                    super::codes_of(core::slice::from_ref(error)).join(""),
                    name_of(handle.as_ref())
                )
            })
            .collect()
    }

    // what it sent since the last time asked, each by its connection, its kind, its call id and
    // its payload or its failure's code
    pub(super) fn sent_since(&self) -> Vec<String> {
        self.transport
            .take()
            .iter()
            .map(|(handle, envelope)| {
                let name = name_of(Some(handle));
                let call_id = envelope.call_id();

                match envelope {
                    Envelope::Failure { failure, .. } => format!(
                        "{name} failure {call_id} {}",
                        ProtocolCode::new(failure.code)
                            .name()
                            .unwrap_or("application")
                    ),
                    Envelope::Result { payload, .. } => {
                        format!("{name} result {call_id} {}", text_of(payload))
                    }
                    Envelope::Notification { payload, .. } => {
                        format!("{name} notification {call_id} {}", text_of(payload))
                    }
                    Envelope::Request { payload, .. } => {
                        format!("{name} request {call_id} {}", text_of(payload))
                    }
                    Envelope::Chunk { .. } | Envelope::Credit { .. } | Envelope::Cancel { .. } => {
                        format!("{name} {:?} {call_id}", envelope.kind())
                    }
                }
            })
            .collect()
    }

    // news resolved by answering ok at once: what notifies its subscriptions
    pub(super) fn news(&self) -> crate::managers::service::Notifier<TextCodec> {
        self.services
            .get_notification_resolver(
                &news(),
                (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
            )
            .expect("news resolved")
            .on(Arc::new(|_request, response: Response<TextCodec>| {
                response.result("ok".to_owned())
            }))
            .expect("news registered")
    }
}

pub(super) fn registry() -> MetricsRegistry {
    MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry")
}

pub(super) fn counted_options(registry: &MetricsRegistry) -> RouterServerOptions {
    RouterServerOptions {
        metrics_registry: Some(registry.clone()),
        ..RouterServerOptions::default()
    }
}

// what a registry counted of a procedure of service 2, its labels but the first two left out
pub(super) fn counted_of((registry, procedure): (&MetricsRegistry, &str)) -> Vec<String> {
    let labels = format!("service=\"2\",procedure=\"{procedure}\"");

    super::metrics::counts_of(registry)
        .into_iter()
        .filter(|line| line.contains(&labels))
        .map(|line| line.replace(&format!("{labels},"), "").replace(&labels, ""))
        .collect()
}

fn notifications_of(registry: &MetricsRegistry) -> Vec<String> {
    counted_of((registry, "news"))
        .into_iter()
        .filter(|line| line.starts_with("bead_notifications_"))
        .collect()
}

// spec 11.7.3
#[tokio::test]
async fn a_connection_that_closes_is_no_longer_notified_and_one_that_cannot_take_it_keeps_none_from_the_others()
 {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);

    let news = served.news();

    served.transport.deliver(&subscribing_of(1), &first());
    served.transport.deliver(&subscribing_of(1), &second());
    served.settle().await;
    served
        .transport
        .send_as((&first(), Sending::Rejected("full".to_owned())));
    served.sent_since();
    locked(&served.activity).clear();
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;

    assert_eq!(served.reported(), ["full first"], "the full one reported");
    assert_eq!(
        served.sent_since(),
        ["first notification 1 flash", "second notification 1 flash"],
        "each handed it"
    );
    assert_eq!(
        *locked(&served.activity),
        ["Notification second"],
        "the one taken told"
    );

    served.transport.close_connection(&first());
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["second notification 1 flash"],
        "the closed one no longer"
    );
    assert_eq!(served.reported().len(), 1, "nothing more reported");
}

// debugging 9.2
#[tokio::test]
async fn counts_a_notification_it_cannot_hand_to_its_transport_as_failed_and_one_its_transport_refuses_once_it_has_it_as_sent()
 {
    let registry = registry();
    let served = Served::new(&RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            maximum_payload_bytes: Some(64),
            ..RouterLimitsOptions::default()
        }),
        ..counted_options(&registry)
    });

    served.transport.open(&first(), true);

    let news = served.news();

    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;

    // whole; past the payload a router's envelope carries; refused by its transport once handed
    news.notify("small".to_owned(), &NotifyOptions::default())
        .await;
    news.notify("x".repeat(100), &NotifyOptions::default())
        .await;
    served
        .transport
        .send_as((&first(), Sending::Rejected("refused".to_owned())));
    news.notify("late".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["PAYLOAD_TOO_LARGE first", "refused first"],
        "each reported with its connection"
    );
    assert_eq!(
        notifications_of(&registry),
        [
            "bead_notifications_sent_total{outcome=\"sent\"} 2",
            "bead_notifications_sent_total{outcome=\"failed\"} 1",
        ],
        "two sent, one failed"
    );
}

// a platform's shape: a codec that refuses every value stands for a text that holds a surrogate
// alone, which no Rust string holds
// spec 17.2.6
#[tokio::test]
async fn counts_a_notification_whose_value_does_not_write_as_failed_for_each_subscription_it_was_for_sends_it_to_none_reports_why_once_and_fails_no_caller()
 {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let told: Arc<Mutex<Vec<(bool, DebugDirection)>>> = Arc::default();
    let hearing = Arc::clone(&told);

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);

    let news = served
        .services
        .get_notification_resolver(
            &news(),
            (ResolverDependencies::of(TextCodec, TextCodec), Unwritable),
        )
        .expect("news resolved")
        .on(Arc::new(|_request, response: Response<TextCodec>| {
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(crate::errors::ResolverError::other)?;
                response.result("ok".to_owned()).await
            })
        }))
        .expect("news registered");

    served.transport.deliver(&subscribing_of(1), &first());
    served.transport.deliver(&subscribing_of(1), &second());
    served.settle().await;
    served.sent_since();
    served.services.on_debug(Arc::new(
        move |error: Option<&TracedError>, event: &DebugEvent| {
            locked(&hearing).push((error.is_some(), event.direction));
        },
    ));

    // sent to none, settled all the same
    news.notify("a\u{fffd}b".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;

    assert_eq!(served.sent_since(), Vec::<String>::new(), "sent to none");
    assert_eq!(
        served.reported(),
        ["a text value holds a surrogate alone no connection"],
        "reported once, with no connection"
    );
    assert_eq!(
        notifications_of(&registry),
        ["bead_notifications_sent_total{outcome=\"failed\"} 2"],
        "failed for each subscription"
    );

    // told as a notification sent, then as its failure to go at that start (spec/debugging.md 4.2)
    assert_eq!(
        *locked(&told),
        [(false, DebugDirection::Tx), (true, DebugDirection::Tx)],
        "its steps"
    );
}

// debugging 9.4.6
#[tokio::test]
async fn counts_a_call_whose_admission_fails_procedure_failed_and_one_whose_subscription_its_connection_cannot_carry_back_subscription_unsupported()
 {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));

    served.transport.open(&first(), true);
    served.transport.open(&second(), false);
    served.news();
    served
        .services
        .get_request_resolver(
            &echo(),
            ResolverDependencies {
                before_request: Some(BeforeRequest::new(
                    |_request| panic!("this admission fails, on purpose"),
                    None,
                )),
                ..ResolverDependencies::of(TextCodec, TextCodec)
            },
        )
        .expect("echo resolved")
        .on(Arc::new(|_request, response: Response<TextCodec>| {
            response.result("never".to_owned())
        }))
        .expect("echo registered");

    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served.transport.deliver(&subscribing_of(1), &second());
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        [
            "first failure 1 PROCEDURE_FAILED",
            "second failure 1 SUBSCRIPTION_UNSUPPORTED"
        ],
        "each refused"
    );
    assert_eq!(
        served.reported(),
        ["an admission panicked: this admission fails, on purpose first"],
        "the admission's panic reported"
    );
    assert!(
        counted_of((&registry, "echo")).contains(
            &"bead_server_call_handled_total{type=\"request\",outcome=\"failure\",code=\"PROCEDURE_FAILED\"} 1"
                .to_owned()
        ),
        "echo counted: {:?}",
        counted_of((&registry, "echo"))
    );
    assert!(
        counted_of((&registry, "news")).contains(
            &"bead_server_call_handled_total{type=\"request\",outcome=\"failure\",code=\"SUBSCRIPTION_UNSUPPORTED\"} 1"
                .to_owned()
        ),
        "news counted: {:?}",
        counted_of((&registry, "news"))
    );

    // a subscription refused in its own answer is its call's failure: none dropped
    assert!(
        !counted_of((&registry, "news"))
            .iter()
            .any(|line| line.starts_with("bead_subscriptions_dropped_total")),
        "none dropped"
    );
}

// debugging 9.7
#[tokio::test]
async fn counts_a_command_to_a_connection_not_open_as_started_and_closed_in_the_turn_it_started() {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let command = Procedure {
        kind: Some(ProcedureKind::Command),
        ..echo()
    };
    let series = served
        .router
        .declare_requester(&command)
        .expect("echo declared");
    let mut options = options_of(Duration::from_secs(1));

    options.connection_handle = Some(second());

    let call = served
        .router
        .request(
            Bytes::from_static(b"x"),
            (
                ServerRequest {
                    procedure: command.address(),
                    maximum_payload_bytes: None,
                    options,
                    series,
                    refusal: None,
                },
                CallHooks::default(),
            ),
        )
        .expect("a command");

    assert!(
        matches!(answered(call).await, Err(CallError::Disconnected(_))),
        "its connection not open"
    );
    assert_eq!(
        counted_of((&registry, "echo")),
        [
            "bead_client_call_duration_seconds_bucket{type=\"command\",le=\"0.0\"} 1",
            "bead_client_call_duration_seconds_count{type=\"command\"} 1",
            "bead_client_call_handled_total{type=\"command\",outcome=\"closed\"} 1",
            "bead_client_call_started_total{type=\"command\"} 1",
        ],
        "started and closed at once"
    );
}

// spec 16.7
#[tokio::test]
async fn a_router_refuses_a_resolver_its_registry_refuses_registering_nothing_and_a_manager_a_requester_as_it_is_made_its_names_folded()
 {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let resolve = |procedure: &Procedure, answer: &'static str| {
        served
            .services
            .get_request_resolver(procedure, ResolverDependencies::of(TextCodec, TextCodec))
            .and_then(|resolver| {
                resolver.on(Arc::new(move |_request, response: Response<TextCodec>| {
                    response.result(answer.to_owned())
                }))
            })
    };

    resolve(&echo(), "echo").expect("echo registered");

    // the same procedure under its name, at another address, its case another: one name (spec 16.6)
    let renamed = resolve(
        &Procedure {
            id: 2,
            name: "eCHO".to_owned(),
            ..echo()
        },
        "again",
    )
    .expect_err("its name at another address refused");

    assert!(
        renamed.message().contains("its name at another address"),
        "refused for its name: {}",
        renamed.message()
    );

    // registered nothing: its address is free, for its own name
    resolve(
        &Procedure {
            id: 2,
            name: "twice".to_owned(),
            ..echo()
        },
        "twice",
    )
    .expect("its address free");

    let commanding = served
        .services
        .get_command(
            &Procedure {
                name: "clock".to_owned(),
                kind: Some(ProcedureKind::Command),
                ..echo()
            },
            RequestDependencies::of(TextCodec, TextCodec),
        )
        .expect_err("another name at its address refused");

    assert!(
        commanding.message().contains("another name at its address"),
        "refused for its address: {}",
        commanding.message()
    );
}

// ── The relay's leg A ────────────────────────────────────────────────────────────────────────

/// A relay on a scripted transport, its leg A the first connection, the device behind it at
/// destination 7: a server that answers echo in upper case, reached through a client's router, on
/// the relay's clock.
struct Relayed {
    served: Served,
    _device: Pair,
}

async fn relayed(limits: Option<RouterLimitsOptions>) -> Relayed {
    let device = Pair::connected((super::january_first(), PairOptions::default()))
        .await
        .expect("a device connected");

    device
        .server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(TextCodec, TextCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(request.payload.to_uppercase())
        }))
        .expect("echo registered");

    let shared: SharedClock = Arc::<SteppingClock>::clone(&device.clock);
    let served = Served::on(
        (shared, Arc::clone(&device.clock)),
        &RouterServerOptions {
            limits,
            relay: Some(RelayOptions {
                before_route: Some(BeforeRequest::new(|_request| true, None)),
                ..RelayOptions::default()
            }),
            ..RouterServerOptions::default()
        },
    );

    served.transport.open(&first(), true);
    served
        .router
        .register_destination((
            device.client.router().as_relay_target(),
            DestinationOptions {
                destination_id: Some(7),
                label: Some("the device".to_owned()),
                ..DestinationOptions::default()
            },
        ))
        .expect("the device registered");

    Relayed {
        served,
        _device: device,
    }
}

// a request of echo to destination 7
fn to_device((call_id, payload): (u32, &str)) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            destination_id: Some(7),
            ..header_of((call_id, &echo()))
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

// spec 14.5
#[tokio::test]
async fn hands_leg_a_s_transport_the_relayed_result_once_answers_nothing_after_it_refuses_it_and_reports_why_with_leg_a_s_connection()
 {
    let relayed = relayed(None).await;
    let served = &relayed.served;

    served
        .transport
        .send_as((&first(), Sending::Thrown("the socket is closed".to_owned())));
    served.transport.deliver(&to_device((1, "hi")), &first());
    served.settle().await;

    // its call was answered once the transport had the result: a second answer goes nowhere
    assert_eq!(served.sent_since(), ["first result 1 HI"], "handed it once");
    assert_eq!(
        served.reported(),
        ["the socket is closed first"],
        "reported with leg A's connection"
    );
}

// spec 14.5
#[tokio::test]
async fn answers_a_relayed_result_past_leg_a_s_limit_procedure_failed_with_no_detail_and_reports_payload_too_large_with_leg_a_s_connection()
 {
    // 8 bytes of prefix, 20 of an announcement and 36 of payload fill leg A's chunk of 64; one more
    // would need a transfer, which this relay sends none of
    let relayed = relayed(Some(RouterLimitsOptions {
        chunk_bytes: Some(64),
        window_bytes: Some(128),
        maximum_transfers: Some(0),
        ..RouterLimitsOptions::default()
    }))
    .await;
    let served = &relayed.served;

    served
        .transport
        .deliver(&to_device((1, &"x".repeat(36))), &first());
    served.settle().await;
    served
        .transport
        .deliver(&to_device((3, &"y".repeat(37))), &first());
    served.settle().await;

    let sent = served.transport.envelopes(&first());

    assert!(
        matches!(sent.last(), Some(Envelope::Failure { failure, .. }) if failure.code == ProtocolCode::PROCEDURE_FAILED.get() && failure.detail.is_empty()),
        "PROCEDURE_FAILED with no detail: {:?}",
        sent.last()
    );
    assert_eq!(
        served.sent_since(),
        [
            format!("first result 1 {}", "X".repeat(36)),
            "first failure 3 PROCEDURE_FAILED".to_owned()
        ],
        "the first whole, the second failed"
    );
    assert_eq!(
        served.reported(),
        ["PAYLOAD_TOO_LARGE first"],
        "reported with leg A's connection"
    );
}
