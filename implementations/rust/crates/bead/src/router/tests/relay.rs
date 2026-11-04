//! Relay admission, destination registrations and the calls bound to them.

#[tokio::test]
async fn answers_by_itself_a_call_a_router_hands_it_unasked_as_a_resolver_does() {
    let (served, relay) = fixture(&RelayOptions {
        before_route: Some(BeforeRequest::new(
            |request| request.header.call_id != 1,
            None,
        )),
        ..RelayOptions::default()
    })
    .await;
    let target = Target::plain();
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());

    for (call_id, destination_id) in [(1, 7), (3, 8), (5, 7)] {
        let request = RequestResolverProps {
            is_admitted: false,
            ..props(&answers, header(call_id, destination_id))
        };
        (handler(&served, destination_id).await.resolve)(request)
            .await
            .expect("the handler answers its own admission");
    }

    assert_eq!(
        *locked(&answers.0),
        [
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record()
            ),
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::DESTINATION_UNKNOWN, RouterSide::Server)
                    .saying("no destination 8 behind this relay")
                    .record()
            ),
            RouterAnswer::Result(Bytes::from_static(&[9])),
        ]
    );
    assert_eq!(locked(&target.asked).len(), 1);

    (handler(&served, 7).await.resolve)(props(&answers, header(1, 7)))
        .await
        .expect("its router already admitted this request");
    assert_eq!(locked(&target.asked).len(), 2);
    assert_eq!(
        locked(&answers.0).last(),
        Some(&RouterAnswer::Result(Bytes::from_static(&[9])))
    );
    served.router.dispose().await;
}

#[test]
fn draws_a_destination_again_when_0_or_in_use() {
    let fills = Arc::new(crate::testing::scripted::DestinationFills::new(
        vec![[0, 0, 0, 0], [0, 0, 0, 5], [0, 0, 1, 7]],
        [0, 0, 0, 9],
    ));
    let mut relay = Relay::new(
        (RouterSide::Server, crate::router::types::LIMIT_DEFAULTS),
        &admitting(),
    )
    .expect("a relay");
    relay.fills = Some(Arc::clone(&fills));
    let target = Target::plain();
    register(&relay, (target.as_target(), 5));
    assert_eq!(fills.remaining(), 3, "an explicit id draws nothing");
    let drawn = relay::register(&relay, (target.as_target(), &DestinationOptions::default()))
        .expect("a drawn destination");
    assert_eq!(drawn.destination_id(), 263);
    assert_eq!(fills.remaining(), 0);
    assert_eq!(locked(&target.asked).len(), 0);

    let relay = Relay::new(
        (RouterSide::Server, crate::router::types::LIMIT_DEFAULTS),
        &admitting(),
    )
    .expect("a relay with the system's random source");
    let mut drawn = std::collections::BTreeSet::new();

    for _ in 0..100 {
        let registration =
            relay::register(&relay, (target.as_target(), &DestinationOptions::default()))
                .expect("a distinct destination");
        let destination_id = registration.destination_id();

        assert_ne!(destination_id, 0);
        assert!(drawn.insert(destination_id));
    }

    assert_eq!(drawn.len(), 100);
    assert_eq!(relay::destinations(&relay).len(), 100);
    assert!(locked(&target.asked).is_empty());
}

async fn through_own(
    served: &Served,
    (resolver, props): (Arc<Handler>, RequestResolverProps),
) -> crate::router::types::TransportMessage {
    let mut handled = (resolver.resolve)(props);
    core::future::poll_fn(|context| {
        assert!(handled.as_mut().poll(context).is_pending());
        core::task::Poll::Ready(())
    })
    .await;
    served.settle().await;
    let sent = served.transport.sent();
    let (handle, message) = sent.last().expect("a command");
    let envelope = crate::testing::scripted::envelope_of(&message.data, RouterSide::Client);
    assert!(matches!(envelope, Envelope::Request { .. }));
    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: envelope.call_id(),
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(&[8]),
        },
        handle,
    );
    crate::testing::patience(Duration::from_secs(10), handled)
        .await
        .expect("answered")
        .expect("forwarded");
    message.clone()
}

#[tokio::test]
async fn passes_nothing_on_to_a_connection_of_its_own_that_takes_no_request_of_the_relays() {
    let (served, relay) = fixture(&admitting()).await;
    served.transport.open(&second(), false);
    served.settle().await;
    register(&relay, (RelayTarget::Connection(second()), 7));
    register(&relay, (RelayTarget::Connection(first()), 8));
    let refused =
        refusal(handler(&served, 7).await.as_ref(), &admission(header(1, 7))).expect("one way");
    assert_eq!(
        refused.record(),
        Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, RouterSide::Server)
            .saying("destination 7 is unreachable: its connection carries no request")
            .record()
    );
    let answers = Arc::new(Answers::default());
    through_own(
        &served,
        (handler(&served, 8).await, props(&answers, header(3, 8))),
    )
    .await;
    assert_eq!(served.transport.sent().len(), 1);
    assert_eq!(served.transport.sent()[0].0, first());
    assert_eq!(
        *locked(&answers.0),
        [RouterAnswer::Result(Bytes::from_static(&[8]))]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn leaves_a_connection_of_its_own_unreachable_once_it_closed_until_registered_anew_on_another_connection()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    let closed = register(&relay, (RelayTarget::Connection(second()), 7));
    register(&relay, (RelayTarget::Connection(first()), 8));
    register(&relay, (target.as_target(), 9));
    let admitted = handler(&served, 7).await;
    relay::close_connection(&relay, &second());
    let unreachable =
        refusal(handler(&served, 7).await.as_ref(), &admission(header(1, 7))).expect("closed");
    assert_eq!(
        unreachable.record(),
        Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, RouterSide::Server)
            .saying("destination 7 is unreachable: its connection closed")
            .record()
    );
    let request = admission(RequestHeader {
        opens_subscription: true,
        ..header(1, 7)
    });
    assert_eq!(
        refusal(handler(&served, 7).await.as_ref(), &request)
            .expect("no subscription first")
            .code(),
        ProtocolCode::SUBSCRIPTION_UNSUPPORTED.get()
    );
    let answers = Arc::new(Answers::default());
    (admitted.resolve)(props(&answers, header(3, 7)))
        .await
        .expect("the closed destination");
    through_own(
        &served,
        (handler(&served, 8).await, props(&answers, header(5, 8))),
    )
    .await;
    (handler(&served, 9).await.resolve)(props(&answers, header(7, 9)))
        .await
        .expect("the other router");
    assert_eq!(
        *locked(&answers.0),
        [
            RouterAnswer::Failure(unreachable.record()),
            RouterAnswer::Result(Bytes::from_static(&[8])),
            RouterAnswer::Result(Bytes::from_static(&[9]))
        ]
    );
    assert!(relay::destinations(&relay).contains(&Destination {
        destination_id: 7,
        is_closed: true,
        label: None
    }));
    relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect_err("closed still holds its id");
    assert!(closed.unregister());
    let another = crate::testing::scripted::handle_of(3);
    served.transport.open(&another, true);
    served.settle().await;
    register(&relay, (RelayTarget::Connection(Arc::clone(&another)), 7));
    through_own(
        &served,
        (handler(&served, 7).await, props(&answers, header(9, 7))),
    )
    .await;
    assert_eq!(
        served
            .transport
            .sent()
            .iter()
            .map(|(handle, _)| Arc::clone(handle))
            .collect::<Vec<_>>(),
        [first(), another]
    );
    assert_eq!(locked(&target.asked).len(), 1);
    served.router.dispose().await;
}

#[tokio::test]
async fn answers_leg_a_payload_too_large_the_relays_own_and_not_reported_for_a_jwt_that_came_whole_and_leaves_leg_bs_opening_no_room()
 {
    let (served, relay) = fixture(&admitting()).await;
    let leg_b = super::Scripted::with(&crate::router::client::RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            chunk_bytes: Some(1_024),
            maximum_envelope_bytes: Some(1_024),
            ..RouterLimitsOptions::default()
        }),
        ..crate::router::client::RouterClientOptions::default()
    });
    leg_b.transport.secure(true);
    relay::register(
        &relay,
        (
            leg_b.router.as_relay_target(),
            &DestinationOptions {
                audience: Some("bead-interop".to_owned()),
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("registered");
    let Credential::Jwt(jwt) = jwt(&serde_json::json!("bead-interop")) else {
        panic!("a JWT")
    };
    let mut jwt = jwt.to_vec();
    jwt.resize(1_000, b'A');
    let answers = Arc::new(Answers::default());
    let mut request = props(
        &answers,
        RequestHeader {
            credential: Some(Credential::Jwt(Bytes::from(jwt))),
            ..header(1, 7)
        },
    );
    request.payload = Bytes::from(vec![0; 100]);
    let outcome = (handler(&served, 7).await.resolve)(request);
    crate::testing::patience(Duration::from_secs(10), outcome)
        .await
        .expect("answered")
        .expect("the relay answers its own limit");
    assert_eq!(*locked(&answers.0), [RouterAnswer::Failure(Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Server).saying("a payload of 100 bytes goes as a transfer, whose opening's header of 1024 bytes passes 1020").record())]);
    assert_eq!(leg_b.transport.sent(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
    leg_b.router.dispose().await;
    served.router.dispose().await;
}

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::locked;
use super::server::{Served, first, second};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::duration::NEVER;
use crate::envelope::{Credential, Envelope, FailureRecord, RequestHeader, ResultHeader};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::router::admissions::BeforeRequest;
use crate::router::core::{AdmissionRequest, Answerer, Handler, RequestResolverProps};
use crate::router::relay::{
    self, Destination, DestinationOptions, DestinationRegistration, Relay, RelayLeg, RelayOptions,
    RelayRouter, RelayTarget,
};
use crate::router::server::{Call, RouterServerOptions};
use crate::router::types::{
    BoxFuture, RouterAnswer, RouterLimits, RouterLimitsOptions, RouterResult, Signal, limits_of,
};

#[derive(Debug)]
struct Target {
    limits: RouterLimits,
    asked: Mutex<Vec<(Bytes, RelayLeg)>>,
    outcome: Mutex<Option<CallError>>,
    handed: Mutex<Option<bool>>,
    abort: Mutex<Option<Signal>>,
    carriage: Mutex<(bool, bool)>,
}

impl Target {
    fn new(limits: &RouterLimitsOptions) -> Arc<Self> {
        Arc::new(Self {
            limits: limits_of(limits).expect("limits"),
            asked: Mutex::new(Vec::new()),
            outcome: Mutex::new(None),
            handed: Mutex::new(Some(true)),
            abort: Mutex::new(None),
            carriage: Mutex::new((false, false)),
        })
    }

    fn plain() -> Arc<Self> {
        Self::new(&RouterLimitsOptions::default())
    }

    fn as_target(self: &Arc<Self>) -> RelayTarget {
        RelayTarget::Router(Arc::<Self>::clone(self))
    }
}

impl RelayRouter for Target {
    fn is_secure(&self) -> bool {
        locked(&self.carriage).0
    }

    fn carries(&self, _credential: &str) -> bool {
        locked(&self.carriage).1
    }

    fn limits(&self) -> RouterLimits {
        self.limits
    }

    fn request(&self, payload: Bytes, mut leg: RelayLeg) -> Result<Call, ProgrammerError> {
        let handed = *locked(&self.handed);
        if let Some(handed) = handed {
            (leg.on_sent)(handed);
        }
        locked(&self.asked).push((payload, leg));
        if let Some(signal) = locked(&self.abort).as_ref() {
            signal.abort(crate::router::types::SignalReason::Cancelled);
        }
        let outcome = locked(&self.outcome).clone();
        if let Some(error) = outcome {
            return Ok(Call::refused(error));
        }
        let (reply, answer) = oneshot::channel();
        reply
            .send(Ok(RouterResult {
                header: ResultHeader {
                    call_id: 2,
                    total: None,
                    credential: None,
                },
                payload: Bytes::from_static(&[9]),
            }))
            .expect("the receiver waits");
        Ok(Call::of(answer))
    }
}

#[derive(Debug, Default)]
struct Answers(Mutex<Vec<RouterAnswer>>);

impl crate::router::core::sealed::Answerer for Answers {}

impl Answerer for Answers {
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>> {
        locked(&self.0).push(answer);
        Box::pin(async { Ok(()) })
    }

    fn answered(&self) -> BoxFuture<Option<FailureRecord>> {
        Box::pin(async { None })
    }

    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>> {
        panic!("a relay carries no subscription")
    }
}

fn header(call_id: u32, destination_id: u32) -> RequestHeader {
    RequestHeader {
        destination_id: Some(destination_id),
        ..super::request_header_of(call_id)
    }
}

fn props(answers: &Arc<Answers>, header: RequestHeader) -> RequestResolverProps {
    RequestResolverProps {
        is_admitted: true,
        connection_handle: first(),
        header,
        payload: Bytes::from_static(&[4, 5]),
        session: None,
        signal: Signal::new(),
        answerer: Arc::<Answers>::clone(answers),
        carried: None,
    }
}

fn admission(header: RequestHeader) -> AdmissionRequest {
    AdmissionRequest {
        connection_handle: first(),
        header,
        session: None,
        carried: None,
    }
}

async fn fixture(options: &RelayOptions) -> (Served, Relay) {
    let served = Served::new(&RouterServerOptions {
        relay: Some(options.clone()),
        ..RouterServerOptions::default()
    });
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served.settle().await;
    let relay = served
        .router
        .owner()
        .run(|state| state.relay.clone())
        .await
        .expect("the relay");
    (served, relay)
}

fn admitting() -> RelayOptions {
    RelayOptions {
        before_route: Some(BeforeRequest::new(|_| true, None)),
        ..RelayOptions::default()
    }
}

async fn handler(served: &Served, id: u32) -> Arc<Handler> {
    served
        .router
        .owner()
        .run(move |state| relay::handler_of(state, id).expect("a relay handler"))
        .await
        .expect("the owner lives")
}

fn register(relay: &Relay, (target, id): (RelayTarget, u32)) -> DestinationRegistration {
    relay::register(
        relay,
        (
            target,
            &DestinationOptions {
                destination_id: Some(id),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("registered")
}

fn refusal(handler: &Handler, request: &AdmissionRequest) -> Option<Failure> {
    handler.admit.as_ref().expect("admission")(request)
        .expect("no admission error")
        .map(|refused| refused.failure)
}

#[tokio::test]
async fn relays_nothing_while_no_destination_is_registered_and_every_destination_once_one_is() {
    let (served, relay) = fixture(&admitting()).await;
    served
        .router
        .owner()
        .run(|state| assert!(relay::handler_of(state, 7).is_none()))
        .await
        .expect("no relay");
    let registration = register(&relay, (Target::plain().as_target(), 7));
    handler(&served, 7).await;
    handler(&served, 8).await;
    assert!(registration.unregister());
    served
        .router
        .owner()
        .run(|state| assert!(relay::handler_of(state, 7).is_none()))
        .await
        .expect("no relay");
    served.router.dispose().await;
}

#[tokio::test]
async fn asks_before_route_first_then_whether_the_destination_is_known_then_refuses_a_subscription()
{
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = Arc::clone(&asked);
    let (served, relay) = fixture(&RelayOptions {
        before_route: Some(BeforeRequest::new(
            move |request| {
                locked(&asking).push((
                    Arc::clone(&request.connection_handle),
                    request.header.destination_id,
                ));
                request.connection_handle == first()
            },
            Some(Failure::protocol(
                ProtocolCode::SESSION_REQUIRED,
                RouterSide::Server,
            )),
        )),
        ..RelayOptions::default()
    })
    .await;
    register(&relay, (Target::plain().as_target(), 7));
    for destination in [7, 8] {
        let request = AdmissionRequest {
            connection_handle: second(),
            ..admission(header(1, destination))
        };
        assert_eq!(
            refusal(handler(&served, destination).await.as_ref(), &request)
                .expect("refused")
                .code(),
            ProtocolCode::SESSION_REQUIRED.get()
        );
    }
    let unknown =
        refusal(handler(&served, 8).await.as_ref(), &admission(header(3, 8))).expect("unknown");
    assert_eq!(unknown.code(), ProtocolCode::DESTINATION_UNKNOWN.get());
    assert_eq!(unknown.detail(), "no destination 8 behind this relay");
    let subscription = RequestHeader {
        opens_subscription: true,
        ..header(5, 7)
    };
    let refused = refusal(handler(&served, 7).await.as_ref(), &admission(subscription))
        .expect("no subscription");
    assert_eq!(refused.code(), ProtocolCode::SUBSCRIPTION_UNSUPPORTED.get());
    assert_eq!(refused.detail(), "this relay carries no subscription");
    assert!(refusal(handler(&served, 7).await.as_ref(), &admission(header(7, 7))).is_none());
    assert_eq!(
        *locked(&asked),
        [
            (second(), Some(7)),
            (second(), Some(8)),
            (first(), Some(8)),
            (first(), Some(7)),
            (first(), Some(7))
        ]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn admits_nobody_without_before_route_throws_what_before_route_throws_and_takes_an_admissions_refusal_alone()
 {
    let (served, relay) = fixture(&RelayOptions::default()).await;
    register(&relay, (Target::plain().as_target(), 7));
    let denied =
        refusal(handler(&served, 7).await.as_ref(), &admission(header(1, 7))).expect("nobody");
    assert_eq!(denied.code(), ProtocolCode::ACCESS_DENIED.get());
    assert_eq!(
        denied.detail(),
        "this relay admits nobody: it has no beforeRoute"
    );
    served.router.dispose().await;
    let (served, relay) = fixture(&RelayOptions {
        before_route: Some(BeforeRequest::new(|_| panic!("no routing today"), None)),
        ..RelayOptions::default()
    })
    .await;
    register(&relay, (Target::plain().as_target(), 7));
    let handler = handler(&served, 7).await;
    let error = handler.admit.as_ref().expect("admission")(&admission(header(1, 7)))
        .expect_err("the error goes on");
    assert!(error.to_string().contains("no routing today"));
    served.router.dispose().await;
    for failure in [
        Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Server),
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Client),
    ] {
        Relay::new(
            (
                RouterSide::Server,
                limits_of(&RouterLimitsOptions::default()).expect("limits"),
            ),
            &RelayOptions {
                before_route: Some(BeforeRequest::new(|_| false, Some(failure))),
                ..RelayOptions::default()
            },
        )
        .expect_err("only an admission refusal of its side");
    }
}

#[tokio::test]
async fn holds_a_payload_to_the_smaller_of_the_two_legs_limits_and_to_one_envelope_of_a_target_that_takes_no_transfer()
 {
    let (served, relay) = fixture(&admitting()).await;
    for (id, limits, expected) in [
        (
            7,
            RouterLimitsOptions {
                maximum_payload_bytes: Some(1_000),
                ..RouterLimitsOptions::default()
            },
            1_000,
        ),
        (
            8,
            RouterLimitsOptions {
                maximum_payload_bytes: Some(500),
                maximum_transfers: Some(0),
                ..RouterLimitsOptions::default()
            },
            500,
        ),
        (
            9,
            RouterLimitsOptions {
                maximum_payload_bytes: Some(1 << 30),
                buffered_bytes_budget: Some(1 << 30),
                ..RouterLimitsOptions::default()
            },
            crate::router::types::LIMIT_DEFAULTS.maximum_payload_bytes,
        ),
        (
            10,
            RouterLimitsOptions {
                chunk_bytes: Some(1_024),
                maximum_envelope_bytes: Some(4_096),
                maximum_transfers: Some(0),
                ..RouterLimitsOptions::default()
            },
            1_012,
        ),
    ] {
        register(&relay, (Target::new(&limits).as_target(), id));
        assert_eq!(
            handler(&served, id).await.maximum_payload_bytes,
            Some(expected)
        );
    }
    register(&relay, (RelayTarget::Connection(second()), 11));
    assert_eq!(
        handler(&served, 11).await.maximum_payload_bytes,
        Some(served.router.limits().maximum_payload_bytes)
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn asks_leg_b_the_same_service_and_procedure_with_the_payloads_bytes_leg_as_signal_and_no_destination()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::new(&RouterLimitsOptions {
        maximum_payload_bytes: Some(1_000),
        ..RouterLimitsOptions::default()
    });
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());
    let props = props(&answers, header(1, 7));
    let signal = props.signal.clone();
    (handler(&served, 7).await.resolve)(props)
        .await
        .expect("forwarded");
    {
        let asked = locked(&target.asked);
        assert_eq!(asked.len(), 1);
        let (payload, leg) = &asked[0];
        assert_eq!(payload.as_ref(), [4, 5]);
        assert_eq!(
            (
                leg.procedure.service_id,
                leg.procedure.procedure_id,
                leg.procedure.service_revision,
                leg.procedure.maximum_payload_bytes
            ),
            (2, 1, 0, Some(1_000))
        );
        assert_eq!(leg.procedure.procedure_name, "2/1 to 7");
        assert_eq!(
            (
                leg.options.destination_id,
                leg.options.connection_handle.clone(),
                leg.options.timeout
            ),
            (None, None, NEVER)
        );
        assert_eq!(
            leg.options.credential,
            Some(crate::router::types::RequestCredential::None)
        );
        let token = leg.options.signal.as_ref().expect("leg A's signal");
        assert!(!token.is_cancelled());
        signal.abort(crate::router::types::SignalReason::Cancelled);
        assert!(token.is_cancelled());
        assert_eq!(
            *locked(&answers.0),
            [RouterAnswer::Result(Bytes::from_static(&[9]))]
        );
        drop(asked);
    }
    served.router.dispose().await;
}

#[tokio::test]
async fn registers_a_destination_given_or_drawn_never_0_nor_one_taken_lists_them_and_takes_out_its_own_alone()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    let seven = relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                destination_id: Some(7),
                label: Some("north".to_owned()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("seven");
    let drawn = relay::register(&relay, (target.as_target(), &DestinationOptions::default()))
        .expect("drawn")
        .destination_id();
    assert_ne!(drawn, 0);
    assert_ne!(drawn, 7);
    assert_eq!(seven.label(), Some("north"));
    for id in [7, 0] {
        relay::register(
            &relay,
            (
                target.as_target(),
                &DestinationOptions {
                    destination_id: Some(id),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect_err("taken or zero");
    }
    assert_eq!(
        relay::destinations(&relay),
        [
            Destination {
                destination_id: 7,
                label: Some("north".to_owned()),
                is_closed: false
            },
            Destination {
                destination_id: drawn,
                label: None,
                is_closed: false
            }
        ]
    );
    assert!(seven.unregister());
    let again = register(&relay, (target.as_target(), 7));
    assert!(!seven.unregister());
    assert_eq!(
        relay::destinations(&relay)
            .iter()
            .map(|destination| destination.destination_id)
            .collect::<Vec<_>>(),
        [drawn, 7]
    );
    assert!(again.unregister());
    served.router.dispose().await;
}

#[tokio::test]
async fn binds_a_call_to_its_destination_as_it_opens_one_registered_in_its_place_later_takes_nothing_of_it()
 {
    let (served, relay) = fixture(&admitting()).await;
    let (before, after) = (Target::plain(), Target::plain());
    let registration = register(&relay, (before.as_target(), 7));
    let bound = handler(&served, 7).await;
    assert!(registration.unregister());
    register(&relay, (after.as_target(), 7));
    let answers = Arc::new(Answers::default());
    (bound.resolve)(props(&answers, header(1, 7)))
        .await
        .expect("the bound target");
    assert_eq!(
        (locked(&before.asked).len(), locked(&after.asked).len()),
        (1, 0)
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn waits_on_leg_b_as_long_as_the_destination_says_the_relays_timeout_at_most_or_on() {
    let target = Target::plain();
    let answers = Arc::new(Answers::default());
    for timeout in [Duration::from_secs(5), NEVER] {
        let (served, relay) = fixture(&RelayOptions {
            timeout: Some(timeout),
            ..admitting()
        })
        .await;
        for (id, own) in [
            (7, None),
            (8, Some(Duration::from_millis(250))),
            (9, Some(Duration::from_secs(60))),
        ] {
            relay::register(
                &relay,
                (
                    target.as_target(),
                    &DestinationOptions {
                        destination_id: Some(id),
                        timeout: own,
                        ..DestinationOptions::default()
                    },
                ),
            )
            .expect("registered");
        }
        for (call, id) in [(1, 7), (3, 8)] {
            (handler(&served, id).await.resolve)(props(&answers, header(call, id)))
                .await
                .expect("forwarded");
        }
        if timeout != NEVER {
            (handler(&served, 9).await.resolve)(props(&answers, header(5, 9)))
                .await
                .expect("bounded");
        }
        served.router.dispose().await;
    }
    assert_eq!(
        locked(&target.asked)
            .iter()
            .map(|(_, leg)| leg.options.timeout)
            .collect::<Vec<_>>(),
        [
            Duration::from_secs(5),
            Duration::from_millis(250),
            Duration::from_secs(5),
            NEVER,
            Duration::from_millis(250)
        ]
    );
}

#[tokio::test]
async fn lists_whether_each_destinations_connection_closed_as_its_registration_says_it_now() {
    let (served, relay) = fixture(&admitting()).await;
    let on_second = register(&relay, (RelayTarget::Connection(second()), 3));
    let on_first = register(&relay, (RelayTarget::Connection(first()), 5));
    let behind = relay::register(
        &relay,
        (
            Target::plain().as_target(),
            &DestinationOptions {
                destination_id: Some(7),
                label: Some("behind".to_owned()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("behind");
    assert_eq!(
        [
            on_second.is_closed(),
            on_first.is_closed(),
            behind.is_closed()
        ],
        [false, false, false]
    );
    relay::close_connection(&relay, &second());
    assert_eq!(
        [
            on_second.is_closed(),
            on_first.is_closed(),
            behind.is_closed()
        ],
        [true, false, false]
    );
    assert_eq!(
        relay::destinations(&relay),
        [
            Destination {
                destination_id: 3,
                is_closed: true,
                label: None
            },
            Destination {
                destination_id: 5,
                is_closed: false,
                label: None
            },
            Destination {
                destination_id: 7,
                is_closed: false,
                label: Some("behind".to_owned())
            },
        ]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn registers_a_connection_its_router_no_longer_holds_closed_and_forwards_nothing_to_it() {
    let (served, relay) = fixture(&admitting()).await;
    relay::close_connection(&relay, &second());
    let registration = register(&relay, (RelayTarget::Connection(second()), 7));
    assert!(registration.is_closed());
    let handler = handler(&served, 7).await;
    let refused = refusal(&handler, &admission(header(1, 7))).expect("closed");
    assert_eq!(refused.code(), ProtocolCode::DESTINATION_UNREACHABLE.get());
    assert_eq!(
        refused.detail(),
        "destination 7 is unreachable: its connection closed"
    );
    let answers = Arc::new(Answers::default());
    (handler.resolve)(props(&answers, header(1, 7)))
        .await
        .expect("answered");
    assert_eq!(
        *locked(&answers.0),
        [RouterAnswer::Failure(refused.record())]
    );
    assert_eq!(served.transport.take(), Vec::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn refuses_an_id_taken_while_the_close_of_its_connection_is_not_heard_yet_and_closes_with_it_a_registration_that_replaced_it_then()
 {
    let (served, relay) = fixture(&admitting()).await;
    let first = register(&relay, (RelayTarget::Connection(second()), 7));
    relay::register(
        &relay,
        (
            RelayTarget::Connection(second()),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect_err("still taken");
    let replacement = relay::register(
        &relay,
        (
            RelayTarget::Connection(second()),
            &DestinationOptions {
                replaces: Some(first.clone()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("replaced before the close");
    assert!(!replacement.is_closed());
    relay::close_connection(&relay, &second());
    assert!(replacement.is_closed());
    assert!(!first.unregister());
    assert_eq!(
        relay::destinations(&relay),
        [Destination {
            destination_id: 7,
            is_closed: true,
            label: None
        }]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn forwards_a_credential_unresolved_unless_it_verifies_as_each_of_its_handlers_says_to_a_destination_registered_or_not()
 {
    for verifies in [false, true] {
        let (served, relay) = fixture(&RelayOptions {
            verifies: Some(verifies),
            ..admitting()
        })
        .await;
        register(&relay, (Target::plain().as_target(), 7));
        for destination in [7, 8] {
            assert_eq!(
                handler(&served, destination).await.forwards_credentials,
                !verifies
            );
        }
        served.router.dispose().await;
    }
}

#[tokio::test]
async fn counts_its_destinations_those_whose_connection_closed_among_them_and_keeps_none_for_a_connection()
 {
    let (served, relay) = fixture(&admitting()).await;
    register(&relay, (RelayTarget::Connection(first()), 7));
    register(&relay, (RelayTarget::Connection(second()), 8));
    register(&relay, (Target::plain().as_target(), 9));
    relay::close_connection(&relay, &second());
    let gauges = relay::gauges(&relay);
    assert_eq!(gauges.counts["destinations"], 3);
    assert_eq!(gauges.counts["closedDestinations"], 1);
    assert_eq!(gauges.connection_handles, std::collections::BTreeSet::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn passes_on_a_failure_of_the_targets_one_relay_more_saturated_at_255_as_it_came() {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());
    let mut expected = Vec::new();
    for (relays, scope) in [
        (0, FailureScope::Application),
        (0, FailureScope::Protocol),
        (3, FailureScope::Protocol),
        (254, FailureScope::Protocol),
        (255, FailureScope::Protocol),
    ] {
        let record = FailureRecord {
            code: core::num::NonZeroU16::new(19).expect("a code"),
            scope,
            relays,
            detail: "its own detail".to_owned(),
        };
        *locked(&target.outcome) = Some(CallError::Failure(Failure::received(
            &record,
            RouterSide::Client,
        )));
        (handler(&served, 7).await.resolve)(props(&answers, header(1, 7)))
            .await
            .expect("answered");
        expected.push(RouterAnswer::Failure(FailureRecord {
            relays: relays.saturating_add(1),
            ..record
        }));
    }
    assert_eq!(*locked(&answers.0), expected);
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn answers_nothing_once_leg_a_ended_leg_b_cancelled_by_the_same_signal_rejects() {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());
    let props = props(&answers, header(1, 7));
    *locked(&target.abort) = Some(props.signal.clone());
    *locked(&target.outcome) = Some(CallError::Cancelled(Some(1)));
    (handler(&served, 7).await.resolve)(props)
        .await
        .expect("cancelled in silence");
    assert_eq!(*locked(&answers.0), Vec::new());
    assert_eq!(locked(&target.asked).len(), 1);
    assert!(
        locked(&target.asked)[0]
            .1
            .options
            .signal
            .as_ref()
            .expect("leg A's signal")
            .is_cancelled()
    );
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn presents_on_leg_b_what_leg_a_does_a_jwts_same_bytes_an_elsewhere_with_what_leg_as_transport_carried_none_for_none_or_opaque()
 {
    use crate::router::core::Carried;
    use crate::router::types::RequestCredential;

    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());
    let jwt = Bytes::from_static(b"header.claims.signature");
    for credential in [
        None,
        Some(Credential::Opaque(super::token())),
        Some(Credential::Jwt(jwt.clone())),
        Some(Credential::Elsewhere),
    ] {
        let header = RequestHeader {
            credential,
            ..header(1, 7)
        };
        let mut props = props(&answers, header.clone());
        props.carried = Some(Carried {
            header,
            transport_credential: Some(" \tInterop sub=ada".to_owned()),
        });
        (handler(&served, 7).await.resolve)(props)
            .await
            .expect("forwarded");
    }
    assert_eq!(
        locked(&target.asked)
            .iter()
            .map(|(_, leg)| leg.options.credential.clone())
            .collect::<Vec<_>>(),
        [
            Some(RequestCredential::None),
            Some(RequestCredential::None),
            Some(RequestCredential::Jwt("header.claims.signature".to_owned())),
            Some(RequestCredential::Elsewhere(
                " \tInterop sub=ada".to_owned()
            )),
        ]
    );
    assert_eq!(
        *locked(&answers.0),
        vec![RouterAnswer::Result(Bytes::from_static(&[9])); 4]
    );
    served.transport.secure(&second(), true);
    served.transport.carry(&second(), true);
    register(&relay, (RelayTarget::Connection(second()), 8));
    for (credential, expected, carried) in [
        (None, None, None),
        (Some(Credential::Opaque(super::token())), None, None),
        (
            Some(Credential::Jwt(jwt.clone())),
            Some(Credential::Jwt(jwt)),
            None,
        ),
        (
            Some(Credential::Elsewhere),
            Some(Credential::Elsewhere),
            Some(" \tInterop sub=ada"),
        ),
    ] {
        let header = RequestHeader {
            credential,
            ..header(1, 8)
        };
        let mut request = props(&answers, header.clone());
        request.carried = Some(Carried {
            header,
            transport_credential: Some(" \tInterop sub=ada".to_owned()),
        });
        let message = through_own(&served, (handler(&served, 8).await, request)).await;
        assert_eq!(message.credential.as_deref(), carried);
        let Envelope::Request { header, payload } =
            crate::testing::scripted::envelope_of(&message.data, RouterSide::Client)
        else {
            panic!("a command")
        };
        assert_eq!(header.credential, expected);
        assert!(header.destination_id.is_none());
        assert_eq!(payload.as_ref(), [4, 5]);
    }
    assert_eq!(
        locked(&answers.0)[4..],
        vec![RouterAnswer::Result(Bytes::from_static(&[8])); 4]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn takes_the_place_of_the_registration_it_replaces_at_once_which_takes_nothing_out_after_and_refuses_one_that_does_not_hold_its_destination()
 {
    let (served, relay) = fixture(&admitting()).await;
    let replaced = relay::register(
        &relay,
        (
            RelayTarget::Connection(second()),
            &DestinationOptions {
                destination_id: Some(7),
                label: Some("a".to_owned()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("registered");
    relay::close_connection(&relay, &second());
    let bound = handler(&served, 7).await;
    let target = Target::plain();
    let replacing = relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                label: Some("b".to_owned()),
                replaces: Some(replaced.clone()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("replaced");
    let answers = Arc::new(Answers::default());
    (bound.resolve)(props(&answers, header(1, 7)))
        .await
        .expect("the bound call stays closed");
    (handler(&served, 7).await.resolve)(props(&answers, header(3, 7)))
        .await
        .expect("the next call goes through");
    assert_eq!(replacing.destination_id(), 7);
    assert_eq!(
        *locked(&answers.0),
        [
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, RouterSide::Server)
                    .saying("destination 7 is unreachable: its connection closed")
                    .record()
            ),
            RouterAnswer::Result(Bytes::from_static(&[9])),
        ]
    );
    assert_eq!(
        relay::destinations(&relay),
        [Destination {
            destination_id: 7,
            is_closed: false,
            label: Some("b".to_owned())
        }]
    );
    assert!(!replaced.unregister());
    let again = relay::register(
        &relay,
        (
            RelayTarget::Connection(first()),
            &DestinationOptions {
                replaces: Some(replacing.clone()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("replace an open registration");
    for (id, replaces) in [
        (None, replaced),
        (None, replacing),
        (Some(9), again.clone()),
    ] {
        relay::register(
            &relay,
            (
                target.as_target(),
                &DestinationOptions {
                    destination_id: id,
                    replaces: Some(replaces),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect_err("a stale or different registration");
    }
    assert!(again.unregister());
    relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                replaces: Some(again),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect_err("a registration taken out");
    assert_eq!(relay::destinations(&relay), Vec::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn asks_a_connection_of_its_own_by_its_own_routers_request_naming_that_connection() {
    let (served, relay) = fixture(&admitting()).await;
    register(&relay, (RelayTarget::Connection(second()), 7));
    let answers = Arc::new(Answers::default());
    let handled = (handler(&served, 7).await.resolve)(props(&answers, header(1, 7)));
    let mut handled = core::pin::pin!(handled);
    core::future::poll_fn(|context| {
        assert!(handled.as_mut().poll(context).is_pending());
        core::task::Poll::Ready(())
    })
    .await;
    served.settle().await;
    let sent = served.transport.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, second());
    assert!(
        matches!(&sent[0].1, Envelope::Request { header, payload } if header.call_id == 2 && header.destination_id.is_none() && header.service_id == 2 && header.procedure_id == 1 && header.credential.is_none() && payload.as_ref() == [4, 5])
    );
    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(&[8]),
        },
        &second(),
    );
    crate::testing::patience(Duration::from_secs(10), handled)
        .await
        .expect("answered")
        .expect("forwarded");
    assert_eq!(
        *locked(&answers.0),
        [RouterAnswer::Result(Bytes::from_static(&[8]))]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}

#[derive(Debug, Default)]
struct Fallback {
    attempts: Mutex<Vec<RouterAnswer>>,
    outcome: Mutex<Option<oneshot::Receiver<Result<(), CallError>>>>,
}

impl crate::router::core::sealed::Answerer for Fallback {}

impl Answerer for Fallback {
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>> {
        let first = {
            let mut attempts = locked(&self.attempts);
            attempts.push(answer);
            let first = attempts.len() == 1;
            drop(attempts);
            first
        };
        if first {
            return Box::pin(async {
                Err(CallError::Other(Arc::new(std::io::Error::other(
                    "private response failure",
                ))))
            });
        }
        let outcome = locked(&self.outcome).take().expect("one fallback");
        Box::pin(async move { outcome.await.expect("the test settles the fallback") })
    }

    fn answered(&self) -> BoxFuture<Option<FailureRecord>> {
        Box::pin(async { None })
    }

    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>> {
        panic!("no subscription")
    }
}

#[tokio::test]
async fn keeps_the_first_response_error_when_its_detail_free_fallback_succeeds_or_fails() {
    for fails in [false, true] {
        let (served, relay) = fixture(&admitting()).await;
        let target = Target::plain();
        register(&relay, (target.as_target(), 7));
        let (reply, outcome) = oneshot::channel();
        let answerer = Arc::new(Fallback {
            outcome: Mutex::new(Some(outcome)),
            ..Fallback::default()
        });
        let request = RequestResolverProps {
            answerer: Arc::<Fallback>::clone(&answerer),
            ..props(&Arc::new(Answers::default()), header(1, 7))
        };
        let mut handled = (handler(&served, 7).await.resolve)(request);
        core::future::poll_fn(|context| {
            assert!(handled.as_mut().poll(context).is_pending());
            core::task::Poll::Ready(())
        })
        .await;
        assert_eq!(
            *locked(&answerer.attempts),
            [
                RouterAnswer::Result(Bytes::from_static(&[9])),
                RouterAnswer::Failure(
                    Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record()
                ),
            ]
        );
        reply
            .send(if fails {
                Err(CallError::Other(Arc::new(std::io::Error::other(
                    "private fallback failure",
                ))))
            } else {
                Ok(())
            })
            .expect("still waiting");
        let reason = handled.await.expect_err("the first response error");
        assert_eq!(reason.to_string(), "private response failure");
        assert_eq!(locked(&target.asked).len(), 1);
        assert_eq!(served.reported(), Vec::<String>::new());
        served.router.dispose().await;
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared matrix keeps every error beside its hand-off and outcome"
)]
async fn passes_on_a_limit_of_leg_bs_before_the_hand_off_as_its_own_and_tells_a_request_never_tried_from_one_lost_after()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    register(&relay, (target.as_target(), 7));
    let answers = Arc::new(Answers::default());
    let large = CallError::Failure(
        Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Client)
            .saying("a payload is 8 bytes at most, not 9"),
    );
    let capacity = CallError::Failure(
        Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, RouterSide::Client)
            .saying("every call id is in use"),
    );
    let stalled = CallError::Failure(
        Failure::protocol(ProtocolCode::TRANSFER_STALLED, RouterSide::Client)
            .saying("nothing came"),
    );
    let cases = [
        (
            large.clone(),
            None,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a payload is 8 bytes at most, not 9",
            false,
        ),
        (
            large,
            Some(true),
            ProtocolCode::DESTINATION_LOST,
            "destination 7 was lost once handed the request: the procedure may have run",
            true,
        ),
        (
            capacity,
            None,
            ProtocolCode::CAPACITY_EXCEEDED,
            "destination 7 takes no more calls at once",
            false,
        ),
        (
            CallError::Other(Arc::new(std::io::Error::other("the socket is closed"))),
            None,
            ProtocolCode::DESTINATION_UNREACHABLE,
            "destination 7 is unreachable: nothing was tried",
            true,
        ),
        (
            CallError::Other(Arc::new(std::io::Error::other("the socket refused it"))),
            Some(false),
            ProtocolCode::DESTINATION_UNREACHABLE,
            "destination 7 is unreachable: nothing was tried",
            true,
        ),
        (
            CallError::Disconnected("the relay's router was disposed".to_owned()),
            None,
            ProtocolCode::DESTINATION_UNREACHABLE,
            "destination 7 is unreachable: nothing was tried",
            true,
        ),
        (
            CallError::Disconnected("the connection closed before the answer".to_owned()),
            Some(true),
            ProtocolCode::DESTINATION_LOST,
            "destination 7 was lost once handed the request: the procedure may have run",
            true,
        ),
        (
            CallError::TimedOut(Duration::from_millis(250)),
            Some(true),
            ProtocolCode::DESTINATION_LOST,
            "destination 7 was lost once handed the request: the procedure may have run",
            true,
        ),
        (
            stalled.clone(),
            Some(true),
            ProtocolCode::DESTINATION_LOST,
            "destination 7 was lost once handed the request: the procedure may have run",
            true,
        ),
        (
            stalled,
            None,
            ProtocolCode::DESTINATION_UNREACHABLE,
            "destination 7 is unreachable: nothing was tried",
            true,
        ),
    ];
    for (error, handed, code, detail, reports) in cases {
        let reason = error.to_string();
        *locked(&target.outcome) = Some(error);
        *locked(&target.handed) = handed;
        locked(&served.reports).clear();
        locked(&answers.0).clear();
        (handler(&served, 7).await.resolve)(props(&answers, header(1, 7)))
            .await
            .expect("answered");
        served.settle().await;
        assert_eq!(
            *locked(&answers.0),
            [RouterAnswer::Failure(
                Failure::protocol(code, RouterSide::Server)
                    .saying(detail)
                    .record()
            )]
        );
        let reported: Vec<String> = locked(&served.reports)
            .iter()
            .map(|(error, connection)| {
                assert_eq!(*connection, Some(first()));
                error.to_string()
            })
            .collect();
        assert_eq!(reported, if reports { vec![reason] } else { Vec::new() });
    }
    served.router.dispose().await;
}

#[tokio::test]
async fn takes_the_audience_each_destination_verifies_gives_the_set_of_them_and_refuses_one_not_of_well_formed_unicode()
 {
    let (served, relay) = fixture(&admitting()).await;
    for (id, target, audience) in [
        (3, RelayTarget::Connection(second()), Some("bead-interop")),
        (5, RelayTarget::Connection(first()), Some("bead-interop")),
        (7, Target::plain().as_target(), Some("bead-other")),
        (9, Target::plain().as_target(), None),
    ] {
        relay::register(
            &relay,
            (
                target,
                &DestinationOptions {
                    destination_id: Some(id),
                    audience: audience.map(str::to_owned),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect("registered");
    }
    assert_eq!(relay::audiences(&relay), ["bead-interop", "bead-other"]);
    // String contains Unicode scalar values only; a surrogate cannot reach registration.
    String::from_utf16(&[0xd800]).expect_err("a surrogate cannot make an audience");
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts("pub fn audience() -> bead::DestinationOptions { let mut options = bead::DestinationOptions::default(); options.audience = Some(String::from(\"bead-other\")); options }");
    consumer.refuses("pub fn audience() -> bead::DestinationOptions { let mut options = bead::DestinationOptions::default(); options.audience = Some(vec![0xd800_u16]); options }", ("E0308", "mismatched types"));
    assert_eq!(relay::destinations(&relay).len(), 4);
    served.router.dispose().await;
}

fn jwt(audience: &serde_json::Value) -> Credential {
    Credential::Jwt(Bytes::from(format!(
        "{}.{}.{}",
        crate::base64url::encode(br#"{"alg":"HS256"}"#),
        crate::base64url::encode(
            serde_json::json!({ "aud": audience })
                .to_string()
                .as_bytes()
        ),
        crate::base64url::encode(b"signature")
    )))
}

fn presenting(credential: Credential, (id, carried): (u32, Option<&str>)) -> AdmissionRequest {
    let header = RequestHeader {
        credential: Some(credential),
        ..header(1, id)
    };
    AdmissionRequest {
        carried: Some(crate::router::core::Carried {
            header: header.clone(),
            transport_credential: carried.map(str::to_owned),
        }),
        ..admission(header)
    }
}

#[tokio::test]
async fn refuses_bearer_credentials_when_a_destination_supplies_no_carriage_metadata_and_still_forwards_none_or_opaque()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    for (id, target) in [
        (7, RelayTarget::Connection(second())),
        (8, target.as_target()),
    ] {
        relay::register(
            &relay,
            (
                target,
                &DestinationOptions {
                    audience: Some("bead-interop".to_owned()),
                    destination_id: Some(id),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect("registered");
    }
    for id in [7, 8] {
        for (credential, why) in [
            (
                jwt(&serde_json::json!("bead-interop")),
                "its transport leaves the machine in the clear, which a bearer credential never crosses",
            ),
            (
                Credential::Elsewhere,
                "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another",
            ),
        ] {
            let request = presenting(credential, (id, Some("Interop sub=ada")));
            let failure =
                refusal(handler(&served, id).await.as_ref(), &request).expect("no carriage");
            assert_eq!(
                failure.record(),
                Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, RouterSide::Server)
                    .saying(format!("destination {id} is unreachable: {why}"))
                    .record()
            );
        }
    }
    assert_eq!(served.transport.sent(), Vec::new());
    assert_eq!(locked(&target.asked).len(), 0);
    let answers = Arc::new(Answers::default());
    for id in [7, 8] {
        for credential in [None, Some(Credential::Opaque(super::token()))] {
            let header = RequestHeader {
                credential,
                ..header(5, id)
            };
            assert!(
                refusal(
                    handler(&served, id).await.as_ref(),
                    &admission(header.clone())
                )
                .is_none()
            );
            let request = props(&answers, header);
            if id == 7 {
                let message = through_own(&served, (handler(&served, id).await, request)).await;
                assert!(message.credential.is_none());
                assert!(
                    matches!(crate::testing::scripted::envelope_of(&message.data, RouterSide::Client), Envelope::Request { header, payload } if header.credential.is_none() && payload.as_ref() == [4, 5])
                );
            } else {
                (handler(&served, id).await.resolve)(request)
                    .await
                    .expect("plain forwarded");
            }
        }
    }
    assert_eq!(served.transport.sent().len(), 2);
    assert_eq!(locked(&target.asked).len(), 2);
    for (payload, leg) in locked(&target.asked).iter() {
        assert_eq!(payload.as_ref(), [4, 5]);
        assert_eq!(
            leg.options.credential,
            Some(crate::router::types::RequestCredential::None)
        );
    }
    assert_eq!(locked(&answers.0).len(), 4);
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn answers_a_call_leg_b_cannot_carry_destination_unreachable_nothing_tried_a_jwt_whose_aud_names_not_its_destinations_audience_or_to_one_of_none_an_elsewhere_to_one_of_none_or_over_a_leg_b_that_carries_none_either_in_the_clear()
 {
    let (served, relay) = fixture(&admitting()).await;
    let plain = crate::testing::scripted::handle_of(3);
    served.transport.open(&plain, true);
    served.transport.carry(&plain, true);
    served.transport.secure(&first(), true);
    served.transport.carry(&first(), true);
    served.transport.secure(&second(), true);
    served.settle().await;
    for (id, handle, audience) in [
        (3, first(), Some("bead-interop")),
        (5, first(), None),
        (7, second(), Some("bead-interop")),
        (9, plain, Some("bead-interop")),
    ] {
        relay::register(
            &relay,
            (
                RelayTarget::Connection(handle),
                &DestinationOptions {
                    destination_id: Some(id),
                    audience: audience.map(str::to_owned),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect("registered");
    }
    let audience = "it verifies another audience than the one the token names, or none";
    let clear =
        "its transport leaves the machine in the clear, which a bearer credential never crosses";
    let not_carried = "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another";
    let rows = [
        (None, [None, None, None, None]),
        (
            Some(Credential::Opaque(super::token())),
            [None, None, None, None],
        ),
        (
            Some(jwt(&serde_json::json!("bead-interop"))),
            [None, Some(audience), None, Some(clear)],
        ),
        (
            Some(jwt(&serde_json::json!(["bead-other", "bead-interop"]))),
            [None, Some(audience), None, Some(clear)],
        ),
        (
            Some(jwt(&serde_json::json!("bead-other"))),
            [Some(audience); 4],
        ),
        (
            Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
            [Some(audience); 4],
        ),
        (
            Some(Credential::Elsewhere),
            [
                None,
                Some("it was registered with no audience"),
                Some(not_carried),
                Some(clear),
            ],
        ),
    ];
    for (credential, expected) in rows {
        for (id, why) in [3, 5, 7, 9].into_iter().zip(expected) {
            let request = credential.clone().map_or_else(
                || admission(header(1, id)),
                |credential| presenting(credential, (id, Some("Interop sub=ada"))),
            );
            let refused = refusal(handler(&served, id).await.as_ref(), &request);
            if let Some(why) = why {
                let refused = refused.expect("unreachable");
                assert_eq!(
                    refused.record(),
                    Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, RouterSide::Server)
                        .saying(format!("destination {id} is unreachable: {why}"))
                        .record()
                );
            } else {
                assert!(refused.is_none(), "{refused:?}");
            }
        }
    }
    assert_eq!(served.transport.take(), Vec::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn answers_an_elsewhere_whose_transport_carried_nothing_destination_unreachable_to_a_leg_b_that_carries_a_credential_as_to_any_other()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::plain();
    *locked(&target.carriage) = (true, true);
    served.transport.secure(&second(), true);
    served.transport.carry(&second(), true);
    for (id, target) in [
        (9, target.as_target()),
        (10, RelayTarget::Connection(second())),
    ] {
        relay::register(
            &relay,
            (
                target,
                &DestinationOptions {
                    destination_id: Some(id),
                    audience: Some("bead-interop".to_owned()),
                    ..DestinationOptions::default()
                },
            ),
        )
        .expect("registered");
        for carried in [None, Some("Interop sub=ada")] {
            let refused = refusal(
                handler(&served, id).await.as_ref(),
                &presenting(Credential::Elsewhere, (id, carried)),
            );
            assert_eq!(
                refused.map(|failure| failure.code()),
                carried
                    .is_none()
                    .then(|| ProtocolCode::DESTINATION_UNREACHABLE.get())
            );
        }
    }
    served.router.dispose().await;
}

#[tokio::test]
async fn counts_elsewhere_in_leg_bs_payload_bound_and_forwards_its_carried_credential_at_the_boundary()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::new(&RouterLimitsOptions {
        chunk_bytes: Some(1_024),
        maximum_envelope_bytes: Some(1_024),
        maximum_transfers: Some(0),
        window_bytes: Some(2_048),
        ..RouterLimitsOptions::default()
    });
    *locked(&target.carriage) = (true, true);
    relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                destination_id: Some(7),
                audience: Some("bead-interop".to_owned()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("registered");
    let answers = Arc::new(Answers::default());
    for length in [1_009, 1_008] {
        let request = presenting(Credential::Elsewhere, (7, Some(" \tInterop sub=ada")));
        assert!(refusal(handler(&served, 7).await.as_ref(), &request).is_none());
        let mut props = props(&answers, request.header);
        props.payload = Bytes::from(vec![42; length]);
        props.carried = request.carried;
        (handler(&served, 7).await.resolve)(props)
            .await
            .expect("answered");
    }
    assert_eq!(
        *locked(&answers.0),
        [
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Server)
                    .saying("a payload is 1008 bytes at most, not 1009")
                    .record()
            ),
            RouterAnswer::Result(Bytes::from_static(&[9])),
        ]
    );
    assert_eq!(locked(&target.asked).len(), 1);
    assert_eq!(locked(&target.asked)[0].0, Bytes::from(vec![42; 1_008]));
    assert_eq!(
        locked(&target.asked)[0].1.options.credential,
        Some(crate::router::types::RequestCredential::Elsewhere(
            " \tInterop sub=ada".to_owned()
        ))
    );
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}

#[tokio::test]
async fn holds_a_payload_to_what_one_envelope_holds_behind_leg_bs_header_with_its_credential_call_by_call_for_a_target_that_takes_no_transfer()
 {
    let (served, relay) = fixture(&admitting()).await;
    let target = Target::new(&RouterLimitsOptions {
        chunk_bytes: Some(1_024),
        maximum_transfers: Some(0),
        ..RouterLimitsOptions::default()
    });
    *locked(&target.carriage) = (true, true);
    relay::register(
        &relay,
        (
            target.as_target(),
            &DestinationOptions {
                destination_id: Some(7),
                audience: Some("bead-interop".to_owned()),
                ..DestinationOptions::default()
            },
        ),
    )
    .expect("registered");
    let jwt = jwt(&serde_json::json!("bead-interop"));
    let Credential::Jwt(bytes) = &jwt else {
        panic!("a JWT")
    };
    let bound = 1_024_usize
        .saturating_sub(16_usize.saturating_add(bytes.len().div_ceil(4).saturating_mul(4)));
    let handler = handler(&served, 7).await;
    assert_eq!(handler.maximum_payload_bytes, Some(1_012));
    let answers = Arc::new(Answers::default());
    for (credential, length) in [
        (Some(jwt.clone()), bound),
        (Some(jwt.clone()), bound.saturating_add(1)),
        (None, bound.saturating_add(1)),
    ] {
        let mut props = props(
            &answers,
            RequestHeader {
                credential,
                ..header(1, 7)
            },
        );
        props.payload = Bytes::from(vec![0; length]);
        (handler.resolve)(props).await.expect("answered");
    }
    let mut request = presenting(jwt, (7, None));
    request.header.total = Some(
        u64::try_from(bound)
            .expect("a small bound")
            .saturating_add(1),
    );
    assert_eq!(
        refusal(&handler, &request)
            .expect("before any credit")
            .code(),
        ProtocolCode::PAYLOAD_TOO_LARGE.get()
    );
    assert_eq!(
        *locked(&answers.0),
        [
            RouterAnswer::Result(Bytes::from_static(&[9])),
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, RouterSide::Server)
                    .saying(format!(
                        "a payload is {bound} bytes at most, not {}",
                        bound.saturating_add(1)
                    ))
                    .record()
            ),
            RouterAnswer::Result(Bytes::from_static(&[9])),
        ]
    );
    assert_eq!(locked(&target.asked).len(), 2);
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}
